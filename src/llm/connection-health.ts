import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { LLMProviderType } from './provider-types.js';

const FAILURE_THRESHOLD = 3;
const INITIAL_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 2 * 60 * 60_000;

export type ConnectionCircuitState = 'closed' | 'open' | 'half-open';

export type LLMInvocationOutcome =
  | 'success'
  | 'definite_failure'
  | 'ambiguous'
  | 'aborted'
  | 'capacity_deferred';

export type LLMConnectionErrorKind =
  | 'not_installed'
  | 'unsupported_version'
  | 'not_authenticated'
  | 'wrong_auth_method'
  | 'quota'
  | 'rate_limit'
  | 'model_unavailable'
  | 'permission_policy'
  | 'timeout'
  | 'aborted'
  | 'ambiguous_outcome'
  | 'process_crash'
  | 'protocol'
  | 'capability'
  | 'capacity'
  | 'transient'
  | 'unknown';

export interface LLMCallEvent {
  scopeId: string;
  connectionId: string | null;
  providerType: LLMProviderType;
  modelAlias: string;
  actualModel?: string | null;
  outcome: LLMInvocationOutcome;
  probeToken?: string | null;
  error?: {
    kind: LLMConnectionErrorKind;
    message: string;
    needsUserAction?: boolean;
    retryAt?: number | null;
  };
}

export interface ConnectionHealthState {
  scopeId: string;
  connectionId: string | null;
  providerType: string;
  circuitState: ConnectionCircuitState;
  failureCount: number;
  openedAt: number | null;
  cooldownMs: number;
  lastSuccessAt: number | null;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: number | null;
  needsUserAction: boolean;
  retryAt: number | null;
}

type HealthRow = {
  scope_id: string;
  connection_id: string | null;
  provider_type: string;
  circuit_state: string;
  failure_count: number;
  opened_at: number | null;
  cooldown_ms: number;
  last_success_at: number | null;
  last_error_kind: string | null;
  last_error_message: string | null;
  last_error_at: number | null;
  needs_user_action: number;
  retry_at: number | null;
};

type HealthChangeListener = (event: LLMCallEvent | null) => void;
let healthChangeListener: HealthChangeListener | null = null;

export function setConnectionHealthChangeListener(
  listener: HealthChangeListener | null,
): void {
  healthChangeListener = listener;
}

function emitChange(event: LLMCallEvent | null): void {
  try {
    healthChangeListener?.(event);
  } catch {
    // Health UI notification cannot change invocation semantics.
  }
}

function rowToState(row: HealthRow): ConnectionHealthState {
  let state = row.circuit_state as ConnectionCircuitState;
  if (
    state === 'open'
    && !row.needs_user_action
    && row.retry_at !== null
    && row.retry_at <= Date.now()
  ) {
    state = 'half-open';
  } else if (
    state === 'open'
    && !row.needs_user_action
    && row.opened_at !== null
    && Date.now() - row.opened_at >= row.cooldown_ms
  ) {
    state = 'half-open';
  }
  return {
    scopeId: row.scope_id,
    connectionId: row.connection_id,
    providerType: row.provider_type,
    circuitState: state,
    failureCount: row.failure_count,
    openedAt: row.opened_at,
    cooldownMs: row.cooldown_ms,
    lastSuccessAt: row.last_success_at,
    lastErrorKind: row.last_error_kind,
    lastErrorMessage: row.last_error_message,
    lastErrorAt: row.last_error_at,
    needsUserAction: !!row.needs_user_action,
    retryAt: row.retry_at,
  };
}

export function getConnectionHealth(
  db: Database.Database,
  scopeId: string,
): ConnectionHealthState | null {
  const row = db.prepare(
    'SELECT * FROM llm_connection_health WHERE scope_id = ?',
  ).get(scopeId) as HealthRow | undefined;
  return row ? rowToState(row) : null;
}

export function listConnectionHealth(
  db: Database.Database,
): ConnectionHealthState[] {
  const rows = db.prepare(
    'SELECT * FROM llm_connection_health ORDER BY last_error_at DESC, updated_at DESC',
  ).all() as HealthRow[];
  return rows.map(rowToState);
}

export function assertConnectionHealthCallable(
  db: Database.Database,
  scopeId: string,
  nowMs = Date.now(),
  probeLeaseMs = 60_000,
): string | null {
  const probeToken = randomUUID();
  return db.transaction(() => {
    const state = getConnectionHealth(db, scopeId);
    if (!state || state.circuitState === 'closed') return null;
    if (state.circuitState === 'half-open') {
      const result = db.prepare(`
        INSERT INTO llm_connection_probe_leases (scope_id, owner_id, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scope_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          expires_at = excluded.expires_at
        WHERE llm_connection_probe_leases.expires_at <= ?
      `).run(scopeId, probeToken, nowMs + probeLeaseMs, nowMs);
      if (result.changes === 1) return probeToken;
    }
    throwCircuitOpen(state, scopeId);
  }).immediate();
}

function throwCircuitOpen(state: ConnectionHealthState, scopeId: string): never {
  const message = state.lastErrorMessage ?? '模型连接已暂停';
  const error = new Error(message) as Error & {
    code?: string;
    connectionScopeId?: string;
    needsUserAction?: boolean;
    retryAt?: number | null;
  };
  error.name = 'LLMConnectionCircuitOpenError';
  error.code = state.lastErrorKind ?? 'connection_unavailable';
  error.connectionScopeId = scopeId;
  error.needsUserAction = state.needsUserAction;
  error.retryAt = state.retryAt;
  throw error;
}

function releaseProbe(db: Database.Database, event: LLMCallEvent): void {
  if (!event.probeToken) return;
  db.prepare(`
    DELETE FROM llm_connection_probe_leases
    WHERE scope_id = ? AND owner_id = ?
  `).run(event.scopeId, event.probeToken);
}

export function releaseConnectionHealthProbe(
  db: Database.Database,
  scopeId: string,
  probeToken: string,
): void {
  db.prepare(`
    DELETE FROM llm_connection_probe_leases
    WHERE scope_id = ? AND owner_id = ?
  `).run(scopeId, probeToken);
}

function ownsProbe(db: Database.Database, event: LLMCallEvent, nowMs: number): boolean {
  if (!event.probeToken) return true;
  const row = db.prepare(`
    SELECT 1
    FROM llm_connection_probe_leases
    WHERE scope_id = ? AND owner_id = ? AND expires_at > ?
  `).get(event.scopeId, event.probeToken, nowMs);
  return row !== undefined;
}

function upsertBase(db: Database.Database, event: LLMCallEvent): void {
  db.prepare(`
    INSERT INTO llm_connection_health (
      scope_id, connection_id, provider_type, circuit_state, failure_count,
      cooldown_ms, needs_user_action, updated_at
    ) VALUES (?, ?, ?, 'closed', 0, ?, 0, ?)
    ON CONFLICT(scope_id) DO UPDATE SET
      connection_id = excluded.connection_id,
      provider_type = excluded.provider_type,
      updated_at = excluded.updated_at
  `).run(
    event.scopeId,
    event.connectionId,
    event.providerType,
    INITIAL_COOLDOWN_MS,
    new Date().toISOString(),
  );
}

export function recordConnectionSuccess(
  db: Database.Database,
  event: LLMCallEvent,
): void {
  const at = Date.now();
  const updated = db.transaction(() => {
    if (!ownsProbe(db, event, at)) return false;
    upsertBase(db, event);
    db.prepare(`
      UPDATE llm_connection_health
      SET circuit_state = 'closed',
          failure_count = 0,
          opened_at = NULL,
          cooldown_ms = ?,
          last_success_at = ?,
          last_error_kind = NULL,
          last_error_message = NULL,
          last_error_at = NULL,
          needs_user_action = 0,
          retry_at = NULL,
          updated_at = ?
      WHERE scope_id = ?
    `).run(INITIAL_COOLDOWN_MS, at, new Date(at).toISOString(), event.scopeId);
    releaseProbe(db, event);
    return true;
  })();
  if (updated) emitChange(event);
}

function shouldIgnoreFailure(kind: LLMConnectionErrorKind): boolean {
  return kind === 'aborted' || kind === 'capacity' || kind === 'model_unavailable';
}

function isPermanent(kind: LLMConnectionErrorKind): boolean {
  return kind === 'not_installed'
    || kind === 'unsupported_version'
    || kind === 'not_authenticated'
    || kind === 'wrong_auth_method'
    || kind === 'permission_policy'
    || kind === 'protocol'
    || kind === 'capability'
    || kind === 'ambiguous_outcome';
}

function isImmediateOpen(kind: LLMConnectionErrorKind): boolean {
  return isPermanent(kind) || kind === 'quota' || kind === 'rate_limit';
}

export function recordConnectionFailure(
  db: Database.Database,
  event: LLMCallEvent,
): void {
  const error = event.error;
  if (!error || shouldIgnoreFailure(error.kind)) {
    if (event.probeToken) {
      db.transaction(() => releaseProbe(db, event))();
    }
    emitChange(event);
    return;
  }

  const at = Date.now();
  const updated = db.transaction(() => {
    if (!ownsProbe(db, event, at)) return false;
    upsertBase(db, event);
    const current = getConnectionHealth(db, event.scopeId);
    const failureCount = (current?.failureCount ?? 0) + 1;
    const needsUserAction = error.needsUserAction ?? isPermanent(error.kind);
    const open = isImmediateOpen(error.kind) || failureCount >= FAILURE_THRESHOLD;
    const priorCooldown = current?.cooldownMs ?? INITIAL_COOLDOWN_MS;
    const cooldown = open && (current?.circuitState === 'open' || current?.circuitState === 'half-open')
      ? Math.min(priorCooldown * 2, MAX_COOLDOWN_MS)
      : priorCooldown;
    const retryAt = error.retryAt ?? (
      !needsUserAction && open ? at + cooldown : null
    );
    db.prepare(`
      UPDATE llm_connection_health
      SET circuit_state = ?,
          failure_count = ?,
          opened_at = ?,
          cooldown_ms = ?,
          last_error_kind = ?,
          last_error_message = ?,
          last_error_at = ?,
          needs_user_action = ?,
          retry_at = ?,
          updated_at = ?
      WHERE scope_id = ?
    `).run(
      open ? 'open' : 'closed',
      failureCount,
      open ? at : current?.openedAt ?? null,
      cooldown,
      error.kind,
      error.message.slice(0, 500),
      at,
      needsUserAction ? 1 : 0,
      retryAt,
      new Date(at).toISOString(),
      event.scopeId,
    );
    releaseProbe(db, event);
    return true;
  })();
  if (updated) emitChange(event);
}

export function resetConnectionHealth(
  db: Database.Database,
  connectionId: string,
): void {
  const row = db.prepare(
    'SELECT circuit_state, last_error_kind FROM llm_connection_health WHERE connection_id = ?',
  ).get(connectionId) as { circuit_state: string; last_error_kind: string | null } | undefined;
  if (row?.last_error_kind === 'ambiguous_outcome') {
    throw new Error('结果不明的连接必须完成检查环境和测试连接后才能恢复');
  }
  db.transaction(() => {
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
          cooldown_ms = ?,
          last_error_kind = NULL,
          last_error_message = NULL,
          last_error_at = NULL,
          needs_user_action = 0,
          retry_at = NULL,
          updated_at = ?
      WHERE connection_id = ?
    `).run(INITIAL_COOLDOWN_MS, new Date().toISOString(), connectionId);
  })();
  emitChange(null);
}
