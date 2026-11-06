import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { updateCliConnectionEnvironment } from '../../db/connections.js';
import { getAuthBinding, type AuthBinding } from '../../db/model-discovery.js';
import type { CliEnvironmentCheck } from './readiness.js';
import { CLI_PROCESS_EXIT_UNCONFIRMED } from './errors.js';
import type { CliProviderType } from './types.js';
import type { CliCapacityLease } from './capacity-lease.js';

export type PersistedCliInvocationOutcome =
  | 'running'
  | 'success'
  | 'definite_failure'
  | 'ambiguous'
  | 'aborted';

export interface CliInvocationRecord {
  id: string;
  connectionId: string;
  providerType: CliProviderType;
  accountScope: string;
  taskId: string | null;
  operationName: string | null;
  modelAlias: string;
  promptCommitted: boolean;
  outcome: PersistedCliInvocationOutcome;
}

export function startCliInvocation(
  db: Database.Database,
  params: {
    connectionId: string;
    providerType: CliProviderType;
    accountScope: string;
    taskId?: string | null;
    operationName?: string | null;
    modelAlias: string;
    id?: string;
  },
): CliInvocationRecord {
  const id = params.id ?? `cli_${randomUUID()}`;
  db.prepare(`
    INSERT INTO cli_invocations (
      id, connection_id, provider_type, account_scope, task_id,
      operation_name, model_alias, actual_model, prompt_committed,
      outcome, resolution, started_at, finished_at, error_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 'running', NULL, ?, NULL, NULL)
  `).run(
    id,
    params.connectionId,
    params.providerType,
    params.accountScope,
    params.taskId ?? null,
    params.operationName ?? null,
    params.modelAlias,
    new Date().toISOString(),
  );
  return {
    id,
    connectionId: params.connectionId,
    providerType: params.providerType,
    accountScope: params.accountScope,
    taskId: params.taskId ?? null,
    operationName: params.operationName ?? null,
    modelAlias: params.modelAlias,
    promptCommitted: false,
    outcome: 'running',
  };
}

export function markCliPromptCommitted(
  db: Database.Database,
  invocationId: string,
  lease: CliCapacityLease,
): void {
  const result = db.prepare(`
    UPDATE cli_invocations
    SET prompt_committed = 1
    WHERE id = ?
      AND connection_id = ?
      AND account_scope = ?
      AND outcome = 'running'
      AND EXISTS (
        SELECT 1 FROM cli_capacity_leases
        WHERE account_scope = ?
          AND owner_id = ?
          AND owner_pid = ?
          AND fencing_token = ?
          AND invocation_id = ?
          AND lease_expires_at > ?
      )
  `).run(
    invocationId,
    lease.connectionId,
    lease.accountScope,
    lease.accountScope,
    lease.ownerId,
    lease.ownerPid,
    lease.fencingToken,
    invocationId,
    Date.now(),
  );
  if (result.changes !== 1) {
    throw new Error('CLI invocation fencing check failed before prompt commit');
  }
}

export function finishCliInvocationFenced(
  db: Database.Database,
  params: {
    invocationId: string;
    outcome: 'success';
    actualModel?: string | null;
  },
  lease: CliCapacityLease,
  nowMs = Date.now(),
): boolean {
  const result = db.prepare(`
    UPDATE cli_invocations
    SET outcome = 'success',
        actual_model = ?,
        error_kind = NULL,
        finished_at = ?
    WHERE id = ?
      AND outcome = 'running'
      AND EXISTS (
        SELECT 1 FROM cli_capacity_leases
        WHERE account_scope = ?
          AND owner_id = ?
          AND owner_pid = ?
          AND fencing_token = ?
          AND invocation_id = ?
          AND lease_expires_at > ?
      )
  `).run(
    params.actualModel ?? null,
    new Date(nowMs).toISOString(),
    params.invocationId,
    lease.accountScope,
    lease.ownerId,
    lease.ownerPid,
    lease.fencingToken,
    lease.invocationId,
    nowMs,
  );
  return result.changes === 1;
}

export function finishCliInvocation(
  db: Database.Database,
  params: {
    invocationId: string;
    outcome: Exclude<PersistedCliInvocationOutcome, 'running'>;
    actualModel?: string | null;
    errorKind?: string | null;
  },
): boolean {
  const result = db.prepare(`
    UPDATE cli_invocations
    SET outcome = ?,
        actual_model = ?,
        error_kind = ?,
        finished_at = ?
    WHERE id = ? AND outcome = 'running'
  `).run(
    params.outcome,
    params.actualModel ?? null,
    params.errorKind ?? null,
    new Date().toISOString(),
    params.invocationId,
  );
  return result.changes === 1;
}

export interface CliStartupReconciliation {
  definiteFailures: string[];
  ambiguousInvocations: string[];
  stabilizedConnections: string[];
}

export function reconcileCliRuntimeState(
  db: Database.Database,
  nowMs = Date.now(),
): CliStartupReconciliation {
  const result: CliStartupReconciliation = {
    definiteFailures: [],
    ambiguousInvocations: [],
    stabilizedConnections: [],
  };
  db.transaction(() => {
    const graceMs = 60_000;
    const staleCandidates = db.prepare(`
      SELECT i.id, i.connection_id, i.prompt_committed, i.task_id, i.started_at,
             l.owner_pid, l.lease_expires_at
      FROM cli_invocations i
      LEFT JOIN cli_capacity_leases l
        ON l.account_scope = i.account_scope
       AND l.invocation_id = i.id
      WHERE i.outcome = 'running'
    `).all() as Array<{
      id: string;
      connection_id: string;
      prompt_committed: number;
      task_id: string | null;
      started_at: string;
      owner_pid: number | null;
      lease_expires_at: number | null;
    }>;
    const stale = staleCandidates.filter(invocation => {
      if (invocation.lease_expires_at === null) {
        const startedAt = Date.parse(invocation.started_at);
        return !Number.isFinite(startedAt) || nowMs - startedAt > graceMs;
      }
      if (invocation.lease_expires_at > nowMs) return false;
      const expiredFor = nowMs - invocation.lease_expires_at;
      if (expiredFor <= graceMs) return false;
      const ownerAlive = invocation.owner_pid !== null && isProcessAlive(invocation.owner_pid);
      // A stopped or stalled live process can resume after an arbitrary delay.
      // Heartbeat age alone is never authority to let a second process submit.
      return !ownerAlive;
    });

    for (const invocation of stale) {
      if (invocation.prompt_committed) {
        db.prepare(`
          UPDATE cli_invocations
          SET outcome = 'ambiguous',
              error_kind = ?,
              finished_at = ?
          WHERE id = ? AND outcome = 'running'
        `).run(CLI_PROCESS_EXIT_UNCONFIRMED, new Date(nowMs).toISOString(), invocation.id);
        db.prepare(`
          UPDATE model_connections
          SET status = 'ambiguous',
              status_reason = '上次调用结果不明，后台调用已暂停'
          WHERE id = ? AND archived = 0
        `).run(invocation.connection_id);
        if (invocation.task_id) {
          db.prepare(`
            UPDATE pending_digests
            SET status = 'ambiguous',
                ambiguous_invocation_id = ?,
                error_message = 'CLI result is unknown after prompt submission',
                processing_started_at = NULL
            WHERE id = ? AND status IN ('pending', 'processing')
          `).run(invocation.id, invocation.task_id);
        }
        result.ambiguousInvocations.push(invocation.id);
      } else {
        db.prepare(`
          UPDATE cli_invocations
          SET outcome = 'definite_failure',
              error_kind = 'process_crash',
              finished_at = ?
          WHERE id = ? AND outcome = 'running'
        `).run(new Date(nowMs).toISOString(), invocation.id);
        result.definiteFailures.push(invocation.id);
      }
    }

    // Repair the crash window from older builds where the invocation reached
    // ambiguous but the associated digest row was not updated.
    db.prepare(`
      UPDATE pending_digests
      SET status = 'ambiguous',
          ambiguous_invocation_id = (
            SELECT i.id FROM cli_invocations i
            WHERE i.task_id = pending_digests.id
              AND i.outcome = 'ambiguous'
            ORDER BY i.finished_at DESC
            LIMIT 1
          ),
          error_message = 'CLI result is unknown after prompt submission',
          processing_started_at = NULL
      WHERE status IN ('pending', 'processing')
        AND EXISTS (
          SELECT 1 FROM cli_invocations i
          WHERE i.task_id = pending_digests.id
            AND i.outcome = 'ambiguous'
        )
    `).run();

    const expiredLeases = db.prepare(`
      SELECT l.account_scope, l.owner_pid, i.outcome
      FROM cli_capacity_leases l
      LEFT JOIN cli_invocations i ON i.id = l.invocation_id
      WHERE l.lease_expires_at <= ?
    `).all(nowMs - graceMs) as Array<{
      account_scope: string;
      owner_pid: number;
      outcome: PersistedCliInvocationOutcome | null;
    }>;
    for (const lease of expiredLeases) {
      // Preserve an expired lease while its running owner PID is alive. A
      // paused process may resume after any TTL and submit a prompt; deleting
      // here would bypass acquireCliCapacityLease's live-owner guard.
      if (lease.outcome === 'running' && isProcessAlive(lease.owner_pid)) continue;
      db.prepare('DELETE FROM cli_capacity_leases WHERE account_scope = ?')
        .run(lease.account_scope);
    }

    // A crash during check/test must restore any old ambiguous pause before
    // considering environment facts. A transient UI status is not a resolution.
    const unstable = db.prepare(`
      SELECT connection.id, connection.environment_checked_at,
        EXISTS (SELECT 1 FROM cli_invocations invocation
          WHERE invocation.connection_id = connection.id
            AND invocation.outcome = 'ambiguous' AND invocation.resolution IS NULL) AS unresolved
      FROM model_connections connection
      WHERE connection.archived = 0
        AND (connection.status IN ('checking', 'testing')
          OR (connection.provider_type IN ('codex-cli', 'claude-cli')
            AND connection.status IN ('online', 'untested', 'degraded') AND unresolved))
    `).all() as Array<{ id: string; environment_checked_at: string | null; unresolved: number }>;
    for (const connection of unstable) {
      const status = connection.unresolved ? 'ambiguous'
        : connection.environment_checked_at ? 'untested' : 'unconfigured';
      db.prepare(`
        UPDATE model_connections
        SET status = ?, status_reason = ?
        WHERE id = ?
      `).run(status, connection.unresolved ? '上次调用结果不明，后台调用已暂停' : null, connection.id);
      result.stabilizedConnections.push(connection.id);
    }
  }).immediate();
  return result;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type CliResumeFutureCallsBlockReason = 'confirmation_required' | 'not_ambiguous'
  | 'operation_in_progress' | 'previous_work_active' | 'environment_check_failed'
  | 'binding_unconfirmed' | 'binding_changed' | 'state_changed' | 'cancelled' | 'recovery_failed'
  | 'process_exit_unconfirmed';

type CliResumeFutureCallsBlocked = { status: 'blocked'; reason: CliResumeFutureCallsBlockReason };

export type CliResumeFutureCallsResult =
  | CliResumeFutureCallsBlocked
  | { status: 'untested'; resolvedInvocationCount: number };

type FutureCallResumeSnapshot = {
  status: 'ready';
  connectionId: string;
  providerType: CliProviderType;
  binding: AuthBinding;
  invocationIds: string[];
  startedAt: number;
};

function readUnresolvedInvocations(db: Database.Database, connectionId: string): string[] {
  const rows = db.prepare(`
    SELECT id FROM cli_invocations
    WHERE connection_id = ? AND outcome = 'ambiguous' AND resolution IS NULL
    ORDER BY id
  `).all(connectionId) as Array<{ id: string }>;
  return rows.map(row => row.id);
}

export function hasUnresolvedCliInvocation(db: Database.Database, connectionId: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM cli_invocations
    WHERE connection_id = ? AND outcome = 'ambiguous' AND resolution IS NULL LIMIT 1
  `).get(connectionId));
}

function cliResumeWorkPending(
  db: Database.Database,
  connectionId: string,
  accountScope: string,
  nowMs: number,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1 WHERE EXISTS (
      SELECT 1 FROM cli_invocations WHERE connection_id = @connectionId AND outcome = 'running'
    ) OR EXISTS (
      SELECT 1 FROM cli_capacity_leases lease
      WHERE lease.connection_id = @connectionId OR lease.account_scope = @accountScope
        OR EXISTS (SELECT 1 FROM cli_invocations invocation
          WHERE invocation.connection_id = @connectionId AND invocation.outcome = 'ambiguous'
            AND invocation.resolution IS NULL AND invocation.account_scope = lease.account_scope)
    ) OR EXISTS (
      SELECT 1 FROM llm_connection_probe_leases lease
      JOIN llm_connection_health health ON health.scope_id = lease.scope_id
      WHERE health.connection_id = @connectionId AND lease.expires_at > @nowMs
    ) OR EXISTS (
      SELECT 1 FROM pending_digests digest
      JOIN cli_invocations invocation ON invocation.task_id = digest.id
        OR invocation.id = digest.ambiguous_invocation_id
      WHERE invocation.connection_id = @connectionId AND invocation.outcome = 'ambiguous'
        AND invocation.resolution IS NULL AND digest.status IN ('pending', 'processing')
    )
  `).get({ connectionId, accountScope, nowMs }));
}

/** Freeze the exact old block before checking the environment. Never repair or replay it here. */
export function prepareCliFutureCallResume(
  db: Database.Database,
  connectionId: string,
  startedAt = Date.now(),
): FutureCallResumeSnapshot | CliResumeFutureCallsBlocked {
  return db.transaction((): FutureCallResumeSnapshot | CliResumeFutureCallsBlocked => {
    const connection = db.prepare(`
      SELECT provider_type FROM model_connections WHERE id = ? AND status = 'ambiguous'
        AND archived = 0 AND provider_type IN ('codex-cli', 'claude-cli')
    `).get(connectionId) as { provider_type: CliProviderType } | undefined;
    if (!connection) return { status: 'blocked', reason: 'not_ambiguous' };
    const invocationIds = readUnresolvedInvocations(db, connectionId);
    if (invocationIds.length === 0) return { status: 'blocked', reason: 'not_ambiguous' };
    const binding = getAuthBinding(db, connectionId);
    if (binding?.scopeState !== 'known' || !binding.cliGeneration) {
      return { status: 'blocked', reason: 'binding_unconfirmed' };
    }
    if (db.prepare(`
      SELECT 1 FROM cli_invocations WHERE error_kind = ? AND (connection_id = ? OR account_scope = ?)
      LIMIT 1
    `).get(CLI_PROCESS_EXIT_UNCONFIRMED, connectionId, binding.scopeKey)) {
      return { status: 'blocked', reason: 'process_exit_unconfirmed' };
    }
    if (cliResumeWorkPending(db, connectionId, binding.scopeKey, startedAt)) {
      return { status: 'blocked', reason: 'previous_work_active' };
    }
    return { status: 'ready', connectionId, providerType: connection.provider_type, binding, invocationIds, startedAt };
  })();
}

/** Resume new calls only. Preserve the old outcome, model observations and queued work. */
export function resumeCliFutureCalls(
  db: Database.Database,
  prepared: FutureCallResumeSnapshot,
  environment: CliEnvironmentCheck,
): CliResumeFutureCallsResult {
  const { connectionId, providerType, binding, invocationIds, startedAt } = prepared;
  if (environment.auth.scopeState !== 'known') return { status: 'blocked', reason: 'binding_unconfirmed' };
  if (environment.providerType !== providerType || environment.auth.providerType !== providerType
    || environment.auth.scopeKey !== binding.scopeKey || environment.auth.method !== binding.authMethod
    || environment.auth.accountScope !== binding.scopeKey
    || environment.cliGeneration !== binding.cliGeneration) {
    return { status: 'blocked', reason: 'binding_changed' };
  }
  return db.transaction((): CliResumeFutureCallsResult => {
    const current = prepareCliFutureCallResume(db, connectionId);
    if (current.status === 'blocked') {
      return current.reason === 'not_ambiguous' ? { status: 'blocked', reason: 'state_changed' } : current;
    }
    if (current.providerType !== providerType || current.binding.authEpoch !== binding.authEpoch
      || current.binding.scopeKey !== binding.scopeKey || current.binding.authMethod !== binding.authMethod
      || current.binding.cliGeneration !== binding.cliGeneration) {
      return { status: 'blocked', reason: 'binding_changed' };
    }
    if (current.invocationIds.length !== invocationIds.length
      || current.invocationIds.some((id, index) => id !== invocationIds[index])
      || db.prepare(`
        SELECT 1 FROM llm_connection_health WHERE connection_id = ?
          AND last_error_kind = 'ambiguous_outcome' AND last_error_at > ?
      `).get(connectionId, startedAt)) {
      return { status: 'blocked', reason: 'state_changed' };
    }
    const resolved = db.prepare(`
      UPDATE cli_invocations SET resolution = 'user_resumed_future_calls'
      WHERE connection_id = ? AND outcome = 'ambiguous' AND resolution IS NULL
    `).run(connectionId);
    updateCliConnectionEnvironment(db, connectionId, {
      status: 'untested',
      statusReason: null,
      cliPath: environment.resolved.path,
      cliVersion: environment.resolved.version,
      authMethod: environment.auth.method,
      authFingerprint: environment.authFingerprint,
      cliGeneration: environment.cliGeneration,
      environmentCheckedAt: environment.checkedAt,
    });
    db.prepare(`
      UPDATE llm_connection_health
      SET circuit_state = 'closed', failure_count = 0, opened_at = NULL,
          last_error_kind = NULL, last_error_message = NULL, last_error_at = NULL,
          needs_user_action = 0, retry_at = NULL, updated_at = ?
      WHERE connection_id = ? AND provider_type = ? AND last_error_kind = 'ambiguous_outcome'
    `).run(environment.checkedAt, connectionId, providerType);
    return { status: 'untested', resolvedInvocationCount: resolved.changes };
  }).immediate();
}

export function resolveAmbiguousConnection(
  db: Database.Database,
  connectionId: string,
  options: { nowMs?: number; digestDelayMs?: number } = {},
): number {
  const nowMs = options.nowMs ?? Date.now();
  const nextRetryAt = new Date(nowMs + (options.digestDelayMs ?? 60_000)).toISOString();
  return db.transaction(() => {
    const invocations = db.prepare(`
      SELECT id FROM cli_invocations
      WHERE connection_id = ?
        AND outcome = 'ambiguous'
        AND resolution IS NULL
    `).all(connectionId) as Array<{ id: string }>;
    if (invocations.length === 0) return 0;
    const ids = invocations.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`
      UPDATE cli_invocations
      SET resolution = 'user_revalidated'
      WHERE id IN (${placeholders})
    `).run(...ids);
    db.prepare(`
      UPDATE pending_digests
      SET status = 'pending',
          ambiguous_invocation_id = NULL,
          next_retry_at = ?,
          processing_started_at = NULL
      WHERE status = 'ambiguous'
        AND ambiguous_invocation_id IN (${placeholders})
    `).run(nextRetryAt, ...ids);
    db.prepare(`
      UPDATE model_connections
      SET status_reason = NULL
      WHERE id = ? AND status = 'ambiguous'
    `).run(connectionId);
    db.prepare(`
      DELETE FROM llm_connection_probe_leases
      WHERE scope_id IN (
        SELECT scope_id FROM llm_connection_health WHERE connection_id = ?
      )
    `).run(connectionId);
    db.prepare(`
      UPDATE llm_connection_health
      SET circuit_state = 'closed',
          failure_count = 0,
          opened_at = NULL,
          last_error_kind = NULL,
          last_error_message = NULL,
          last_error_at = NULL,
          needs_user_action = 0,
          retry_at = NULL,
          updated_at = ?
      WHERE connection_id = ?
        AND last_error_kind = 'ambiguous_outcome'
    `).run(new Date(nowMs).toISOString(), connectionId);
    return ids.length;
  }).immediate();
}
