import type Database from 'better-sqlite3';
import { isIdentityUnobserved } from '../../db/model-discovery.js';
import { CliLLMError, isIdentityUnobservedError } from './errors.js';
import type { CliEnvironmentCheck } from './readiness.js';

/**
 * Upper bound for re-reading the account identity after a model already answered.
 * The half-open health probe lease is extended by the same amount.
 */
export const POST_RESPONSE_IDENTITY_RETRY_BUDGET_MS = 45_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAYS_MS = [1_000, 3_000];

export type IdentityRecheckResult =
  | { status: 'observed'; environment: CliEnvironmentCheck }
  | { status: 'unobserved' };

export interface IdentityRecheckOptions {
  /** One full environment check; must honour the signal it is given. */
  check: (signal: AbortSignal) => Promise<CliEnvironmentCheck>;
  /** Caller cancellation. Ends the recheck as `aborted`, never as unobserved. */
  signal?: AbortSignal;
  attempts?: number;
  budgetMs?: number;
  /** Wait between attempts; must return early when the signal aborts. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function signalAwareDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Read the account identity until it is actually observed, for callers that hold a
 * result worth keeping (a completed model response, a finished connection test).
 *
 * Three different things can stop it and they are kept apart:
 * - the internal budget elapses            → `unobserved`
 * - the caller's signal aborts             → throws `aborted`
 * - the check itself fails for any reason  → that error (a stopping runtime
 *   surfaces here as `aborted` and therefore ends the recheck as cancelled)
 */
export async function recheckIdentityWithRetry(
  db: Database.Database,
  connectionId: string,
  options: IdentityRecheckOptions,
): Promise<IdentityRecheckResult> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delay = options.delay ?? signalAwareDelay;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.budgetMs ?? POST_RESPONSE_IDENTITY_RETRY_BUDGET_MS);
  const combined = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const cancelled = (): CliLLMError => new CliLLMError('aborted', '账号复查已取消', {
    cause: options.signal?.reason,
  });
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options.signal?.aborted) throw cancelled();
      if (deadline.signal.aborted) return { status: 'unobserved' };
      if (attempt > 0) {
        await delay(DEFAULT_DELAYS_MS[Math.min(attempt - 1, DEFAULT_DELAYS_MS.length - 1)], combined);
        if (options.signal?.aborted) throw cancelled();
        if (deadline.signal.aborted) return { status: 'unobserved' };
      }
      let environment: CliEnvironmentCheck;
      try {
        environment = await options.check(combined);
      } catch (error) {
        if (options.signal?.aborted) throw cancelled();
        // Interrupted by our own budget: the read simply did not finish in time.
        if (deadline.signal.aborted) return { status: 'unobserved' };
        if (isIdentityUnobservedError(error)) continue;
        throw error;
      }
      if (isIdentityUnobserved(db, connectionId, {
        identityProbe: environment.identityProbe,
        authMethod: environment.auth.method,
        cliGeneration: environment.cliGeneration,
      })) continue;
      return { status: 'observed', environment };
    }
    return { status: 'unobserved' };
  } finally {
    clearTimeout(timer);
  }
}
