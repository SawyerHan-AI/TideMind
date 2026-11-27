import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import Database from 'better-sqlite3';
import { ensureSchema } from '../../../src/db/schema.js';
import { reconcileAuthBinding } from '../../../src/db/model-discovery.js';
import { CliLLMError, identityUnobservedError } from '../../../src/llm/cli/errors.js';
import {
  POST_RESPONSE_IDENTITY_RETRY_BUDGET_MS,
  recheckIdentityWithRetry,
} from '../../../src/llm/cli/identity-recheck.js';
import type { CliEnvironmentCheck } from '../../../src/llm/cli/readiness.js';
import type { CliIdentityProbe } from '../../../src/llm/cli/types.js';

const CONNECTION = 'mc_5eed0002';

function environment(probe: CliIdentityProbe, scope: string | null = 'xinghai'): CliEnvironmentCheck {
  return {
    auth: {
      providerType: 'codex-cli', method: 'chatgpt', accountIdentifier: null,
      accountScope: scope ? `codex-cli:${scope}` : 'codex-cli:local-login',
      scopeState: scope ? 'known' : 'unknown',
      scopeKey: scope ? `codex-cli:${scope}` : 'codex-cli:unknown',
      scopeLabel: null,
    },
    identityProbe: probe,
    cliGeneration: 'gen-1',
    authStoreSignal: null,
  } as unknown as CliEnvironmentCheck;
}

const OBSERVED = environment({ status: 'observed' });
const FAILED = environment({ status: 'failed', kind: 'timeout', elapsedMs: 10_000 }, null);

function boundDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  reconcileAuthBinding(db, {
    connectionId: CONNECTION, auth: OBSERVED.auth, cliGeneration: 'gen-1', authStoreSignal: null,
    identityProbe: { status: 'observed' },
  });
  return db;
}

const noDelay = async (): Promise<void> => {};

describe('recheckIdentityWithRetry', () => {
  it('keeps the budget in step with the health probe lease', () => {
    expect(POST_RESPONSE_IDENTITY_RETRY_BUDGET_MS).toBe(45_000);
  });

  it('returns the first real observation, counting both kinds of unobserved attempts', async () => {
    const db = boundDb();
    const check = vi.fn<() => Promise<CliEnvironmentCheck>>()
      .mockResolvedValueOnce(FAILED)
      .mockRejectedValueOnce(identityUnobservedError())
      .mockResolvedValueOnce(OBSERVED);
    await expect(recheckIdentityWithRetry(db, CONNECTION, { check, delay: noDelay }))
      .resolves.toEqual({ status: 'observed', environment: OBSERVED });
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('gives up as unobserved after three attempts', async () => {
    const db = boundDb();
    const check = vi.fn(async () => FAILED);
    await expect(recheckIdentityWithRetry(db, CONNECTION, { check, delay: noDelay }))
      .resolves.toEqual({ status: 'unobserved' });
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('an observed different account is a result, not something to retry', async () => {
    const db = boundDb();
    const switched = environment({ status: 'observed' }, 'datapilot');
    const check = vi.fn(async () => switched);
    await expect(recheckIdentityWithRetry(db, CONNECTION, { check, delay: noDelay }))
      .resolves.toEqual({ status: 'observed', environment: switched });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a failed read on a connection without a known scope is the structural unknown, not retried', async () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    const check = vi.fn(async () => FAILED);
    await expect(recheckIdentityWithRetry(db, CONNECTION, { check, delay: noDelay }))
      .resolves.toEqual({ status: 'observed', environment: FAILED });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('the internal budget ends the recheck as unobserved and aborts the running check', async () => {
    const db = boundDb();
    let seen: AbortSignal | undefined;
    const check = (signal: AbortSignal): Promise<CliEnvironmentCheck> => new Promise((_resolve, reject) => {
      seen = signal;
      signal.addEventListener('abort', () => reject(new CliLLMError('aborted', 'CLI 环境检查已取消')), { once: true });
    });
    await expect(recheckIdentityWithRetry(db, CONNECTION, { check, budgetMs: 30 }))
      .resolves.toEqual({ status: 'unobserved' });
    expect(seen?.aborted).toBe(true);
  }, 30_000);

  it('caller cancellation ends it as aborted, during a check and during the wait', async () => {
    const db = boundDb();
    const duringCheck = new AbortController();
    await expect(recheckIdentityWithRetry(db, CONNECTION, {
      signal: duringCheck.signal,
      check: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new CliLLMError('aborted', 'cancelled')), { once: true });
        duringCheck.abort();
      }),
    })).rejects.toMatchObject({ kind: 'aborted' });

    const duringWait = new AbortController();
    const check = vi.fn(async () => FAILED);
    await expect(recheckIdentityWithRetry(db, CONNECTION, {
      signal: duringWait.signal,
      check,
      delay: async () => { duringWait.abort(); },
    })).rejects.toMatchObject({ kind: 'aborted' });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a stopping runtime (aborted from the check itself) and other failures propagate unchanged', async () => {
    const db = boundDb();
    await expect(recheckIdentityWithRetry(db, CONNECTION, {
      check: async () => { throw new CliLLMError('aborted', 'CLI runtime is stopping'); }, delay: noDelay,
    })).rejects.toMatchObject({ kind: 'aborted', message: 'CLI runtime is stopping' });
    await expect(recheckIdentityWithRetry(db, CONNECTION, {
      check: async () => { throw new CliLLMError('not_authenticated', 'Codex CLI is not logged in'); }, delay: noDelay,
    })).rejects.toMatchObject({ kind: 'not_authenticated' });
  });

  it('the default wait returns as soon as the caller cancels', async () => {
    const db = boundDb();
    const controller = new AbortController();
    const check = vi.fn(async () => { setTimeout(() => controller.abort(), 20); return FAILED; });
    const started = Date.now();
    await expect(recheckIdentityWithRetry(db, CONNECTION, { signal: controller.signal, check }))
      .rejects.toMatchObject({ kind: 'aborted' });
    expect(Date.now() - started).toBeLessThan(900);
  }, 30_000);
});
