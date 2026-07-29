import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
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
              error_kind = 'ambiguous_outcome',
              finished_at = ?
          WHERE id = ? AND outcome = 'running'
        `).run(new Date(nowMs).toISOString(), invocation.id);
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

    const unstable = db.prepare(`
      SELECT id, candidate_models, available_models, model_validation_json,
             validation_fingerprint, environment_checked_at
      FROM model_connections
      WHERE status IN ('checking', 'testing') AND archived = 0
    `).all() as Array<{
      id: string;
      candidate_models: string | null;
      available_models: string | null;
      model_validation_json: string | null;
      validation_fingerprint: string | null;
      environment_checked_at: string | null;
    }>;
    for (const connection of unstable) {
      let available: string[] = [];
      let candidates: string[] = [];
      let validations: Record<string, { success?: boolean }> = {};
      try { available = JSON.parse(connection.available_models ?? '[]'); } catch { /* invalid legacy JSON */ }
      try { candidates = JSON.parse(connection.candidate_models ?? '[]'); } catch { /* invalid legacy JSON */ }
      try { validations = JSON.parse(connection.model_validation_json ?? '{}'); } catch { /* invalid legacy JSON */ }
      let status = 'unconfigured';
      if (connection.validation_fingerprint && available.length > 0) {
        const covered = candidates.length > 0
          && candidates.every(model => validations[model] !== undefined);
        status = covered && available.length === candidates.length ? 'online' : 'degraded';
      } else if (connection.environment_checked_at && candidates.length > 0) {
        status = 'untested';
      }
      db.prepare(`
        UPDATE model_connections
        SET status = ?, status_reason = NULL
        WHERE id = ? AND status IN ('checking', 'testing')
      `).run(status, connection.id);
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
