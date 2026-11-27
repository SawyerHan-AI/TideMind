import type Database from 'better-sqlite3'
import {
  CLI_ENVIRONMENT_RECOVERABLE_KINDS,
  recoverCliEnvironmentFailures,
} from '@server/llm/connection-health.js'
import {
  CliLLMError,
  saveEnvironment,
  type CheckCliEnvironmentOptions,
  type CliEnvironmentCheck,
  type CliProviderType,
} from '@server/llm/cli/index.js'
import { hasUnresolvedCliInvocation } from '@server/llm/cli/invocation-state.js'
import {
  getAuthBinding,
  getLastKnownScope,
  hasSuccessUnderBinding,
  isIdentityUnobserved,
  reconcileAuthBinding,
} from '../../../src/db/model-discovery.js'
import { createLogger } from '../../../src/utils/logger.js'

const log = createLogger('cli-recovery')

/**
 * Unattended, read-only recovery of local-subscription connections.
 *
 * A connection whose circuit was opened by an environment failure, or whose account
 * binding was left unknown, used to stay that way until the user opened the settings
 * page. This re-reads the environment (no model request, no quota) and clears only
 * what the read actually disproves:
 *
 * - `not_installed` / `unsupported_version`: the check passing is the disproof.
 * - `not_authenticated` / `wrong_auth_method` / `scope_unknown`: only when the
 *   account was freshly observed, equals the connection's binding, and that exact
 *   scope + epoch already has a successful call. A scope, login-method or CLI
 *   generation change found mid-call starts a new epoch with no success under it,
 *   so an account the user never ran here is never adopted by this path.
 *
 * It never touches ambiguous outcomes, permission, quota or protocol failures, and
 * it writes nothing when the account could not be read.
 */

export interface CliOperationHandle {
  signal: AbortSignal
  finish: () => void
}

export interface CliEnvironmentRecoveryDeps {
  checkEnvironment: (options: CheckCliEnvironmentOptions) => Promise<CliEnvironmentCheck>
  /** Returns null when the user is already checking or testing this connection. */
  beginOperation: (connectionId: string) => CliOperationHandle | null
  now?: () => number
}

export interface CliEnvironmentRecoveryResult {
  /** Connections whose circuit was closed or whose binding was restored. */
  recovered: string[]
  /** Connections that still need recovery after this round. */
  pending: number
}

type Candidate = {
  id: string
  provider_type: CliProviderType
  archived: number
  status: string
  cli_path: string | null
  validation_fingerprint: string | null
}

function selectCandidates(db: Database.Database): Candidate[] {
  // Selected from the health table and the binding, not from the connection status:
  // an open circuit leaves the status at `online`.
  return db.prepare(`
    SELECT c.id, c.provider_type, c.archived, c.status, c.cli_path, c.validation_fingerprint
    FROM model_connections c
    WHERE c.archived = 0
      AND c.provider_type IN ('claude-cli', 'codex-cli')
      AND c.status NOT IN ('ambiguous', 'checking', 'testing')
      AND (
        EXISTS (
          SELECT 1 FROM llm_connection_health h
          WHERE h.connection_id = c.id AND h.circuit_state = 'open'
            AND h.last_error_kind IN (${CLI_ENVIRONMENT_RECOVERABLE_KINDS.map(() => '?').join(',')})
        )
        OR EXISTS (
          SELECT 1 FROM llm_connection_auth_bindings b
          WHERE b.connection_id = c.id AND b.scope_state = 'unknown'
            AND b.last_known_scope_key IS NOT NULL
        )
      )
    ORDER BY c.id
  `).all(...CLI_ENVIRONMENT_RECOVERABLE_KINDS) as Candidate[]
}

function sameIdentity(
  binding: { scopeKey: string; authMethod: string | null; cliGeneration: string | null },
  environment: CliEnvironmentCheck,
): boolean {
  return binding.scopeKey === environment.auth.scopeKey
    && binding.authMethod === environment.auth.method
    && binding.cliGeneration === environment.cliGeneration
}

async function recoverOne(
  db: Database.Database,
  dataDir: string,
  candidate: Candidate,
  deps: CliEnvironmentRecoveryDeps,
): Promise<boolean> {
  if (hasUnresolvedCliInvocation(db, candidate.id)) return false
  const operation = deps.beginOperation(candidate.id)
  if (!operation) return false
  const startedAt = (deps.now ?? Date.now)()
  try {
    let environment: CliEnvironmentCheck
    try {
      environment = await deps.checkEnvironment({
        providerType: candidate.provider_type,
        allowLoginShell: false,
        candidatePath: candidate.cli_path,
        dataDir,
        signal: operation.signal,
        // Recovery needs to know who is logged in now; a cached identity proves nothing.
        freshAuth: true,
      })
    } catch (error) {
      const kind = error instanceof CliLLMError ? error.kind : 'unknown'
      log.warn(`recovery check did not pass for ${candidate.id}: ${kind}`)
      return false
    }
    if (operation.signal.aborted) return false
    if (isIdentityUnobserved(db, candidate.id, {
      identityProbe: environment.identityProbe,
      authMethod: environment.auth.method,
      cliGeneration: environment.cliGeneration,
    })) {
      log.warn(`recovery skipped for ${candidate.id}: account identity not observed`)
      return false
    }

    let identityConfirmed = false
    let bindingRestored = false
    // Explicitly `observed`: a missing or cached probe must not loosen this.
    const observedKnown = environment.identityProbe?.status === 'observed'
      && environment.auth.scopeState === 'known'
    const binding = getAuthBinding(db, candidate.id)
    if (observedKnown && binding) {
      const lastKnown = getLastKnownScope(db, candidate.id)
      const matchesBinding = binding.scopeState === 'known' && sameIdentity(binding, environment)
      const restorable = binding.scopeState === 'unknown'
        && lastKnown !== null && sameIdentity(lastKnown, environment)
      if (matchesBinding || restorable) {
        db.transaction(() => {
          // Throws `aborted` when the connection row moved under us; nothing is written then.
          saveEnvironment(db, candidate.id, environment, candidate)
          const reconciled = reconcileAuthBinding(db, {
            connectionId: candidate.id,
            auth: environment.auth,
            cliGeneration: environment.cliGeneration,
            authStoreSignal: environment.authStoreSignal,
            identityProbe: environment.identityProbe,
          })
          bindingRestored = restorable && reconciled.reason === 'known_scope_restored'
          identityConfirmed = !reconciled.unobserved
            && reconciled.binding.scopeState === 'known'
            && sameIdentity(reconciled.binding, environment)
            && hasSuccessUnderBinding(db, reconciled.binding)
        }).immediate()
      }
    }
    // Any other observation (a different account, no binding, an unknown scope) adopts
    // nothing: only the failures a passing check disproves by itself are cleared.
    const cleared = recoverCliEnvironmentFailures(db, candidate.id, startedAt, { identityConfirmed })
    if (cleared || bindingRestored) {
      log.info(`recovered ${candidate.id}: circuit=${cleared} binding=${bindingRestored} identityConfirmed=${identityConfirmed}`)
    }
    return cleared || bindingRestored
  } catch (error) {
    log.warn(`recovery failed for ${candidate.id}: ${(error as Error).message}`)
    return false
  } finally {
    operation.finish()
  }
}

export async function recoverCliEnvironmentsOnce(
  db: Database.Database,
  dataDir: string,
  deps: CliEnvironmentRecoveryDeps,
): Promise<CliEnvironmentRecoveryResult> {
  const recovered: string[] = []
  for (const candidate of selectCandidates(db)) {
    if (await recoverOne(db, dataDir, candidate, deps)) recovered.push(candidate.id)
  }
  return { recovered, pending: selectCandidates(db).length }
}

const RECOVERY_BACKOFF_MINUTES = [5, 10, 20, 40, 60] as const

/** Delay before the next round while something still needs recovery. */
export function recoveryRetryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RECOVERY_BACKOFF_MINUTES.length - 1)
  return RECOVERY_BACKOFF_MINUTES[index] * 60_000
}
