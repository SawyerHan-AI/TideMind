import type Database from 'better-sqlite3';
import type { CliAuthIdentity, CliCatalogModel, CliCatalogSource } from '../llm/cli/types.js';
import type { ModelSelectionMode } from '../llm/cli/catalogs.js';

/**
 * Repository for llm_connection_auth_bindings / llm_model_catalog_snapshots /
 * llm_model_observations (schema v35). See model-discovery-schema.ts.
 */

export interface AuthBinding {
  connectionId: string;
  scopeState: 'known' | 'unknown';
  scopeKey: string;
  authEpoch: number;
  authMethod: string | null;
  bindingMode: 'snapshot_checked';
  cliGeneration: string | null;
  authStoreSignal: string | null;
  observedAt: string;
  epochStartedAt: string;
  epochReason: string | null;
}

type BindingRow = {
  connection_id: string;
  scope_state: 'known' | 'unknown';
  scope_key: string;
  auth_epoch: number;
  auth_method: string | null;
  binding_mode: string;
  cli_generation: string | null;
  auth_store_signal: string | null;
  observed_at: string;
  epoch_started_at: string;
  epoch_reason: string | null;
};

function bindingFromRow(row: BindingRow): AuthBinding {
  return {
    connectionId: row.connection_id,
    scopeState: row.scope_state,
    scopeKey: row.scope_key,
    authEpoch: row.auth_epoch,
    authMethod: row.auth_method,
    bindingMode: 'snapshot_checked',
    cliGeneration: row.cli_generation,
    authStoreSignal: row.auth_store_signal,
    observedAt: row.observed_at,
    epochStartedAt: row.epoch_started_at,
    epochReason: row.epoch_reason,
  };
}

export function getAuthBinding(db: Database.Database, connectionId: string): AuthBinding | null {
  const row = db.prepare(
    'SELECT * FROM llm_connection_auth_bindings WHERE connection_id = ?',
  ).get(connectionId) as BindingRow | undefined;
  return row ? bindingFromRow(row) : null;
}

export type EpochReason =
  | 'initial'
  | 'scope_changed'
  | 'method_changed'
  | 'cli_generation_changed'
  | 'unknown_scope_signal_changed'
  | 'known_scope_restored';

type LastKnownRow = {
  last_known_scope_key: string | null;
  last_known_epoch: number | null;
  last_known_cli_generation: string | null;
  last_known_auth_method: string | null;
};

/**
 * Record the current non-secret auth observation for a connection. The epoch only
 * increments when the observation can no longer be proven to be the same scope:
 * scope/method change, CLI generation change (old observations become history), or an
 * auth-store signal change while the scope is unknown. A re-probe that confirms the
 * same known scope keeps the epoch (design §6.1).
 *
 * A transient fall-back to `unknown` (e.g. the account/read session timed out) that
 * returns to exactly the last known scope, auth method and CLI generation restores
 * that known epoch: the account did not demonstrably change, so its mismatch /
 * rejection evidence must not be laundered by the blip. The unknown epoch's own
 * observations stay history (they were never account-attributed).
 */
export function reconcileAuthBinding(
  db: Database.Database,
  params: {
    connectionId: string;
    auth: CliAuthIdentity;
    cliGeneration: string;
    authStoreSignal: string | null;
    now?: string;
  },
): { binding: AuthBinding; epochChanged: boolean; reason: EpochReason | null } {
  const now = params.now ?? new Date().toISOString();
  return db.transaction(() => {
    const current = getAuthBinding(db, params.connectionId);
    const lastKnown = db.prepare(`
      SELECT last_known_scope_key, last_known_epoch, last_known_cli_generation, last_known_auth_method
      FROM llm_connection_auth_bindings WHERE connection_id = ?
    `).get(params.connectionId) as LastKnownRow | undefined;
    let reason: EpochReason | null = null;
    let epoch: number;
    const restorable = current !== null
      && current.scopeState === 'unknown'
      && params.auth.scopeState === 'known'
      && lastKnown?.last_known_scope_key === params.auth.scopeKey
      && lastKnown.last_known_epoch !== null
      && lastKnown.last_known_cli_generation === params.cliGeneration
      && lastKnown.last_known_auth_method === params.auth.method;
    if (!current) {
      reason = 'initial';
      epoch = 1;
    } else if (restorable) {
      reason = 'known_scope_restored';
      epoch = lastKnown!.last_known_epoch!;
    } else {
      if (current.scopeKey !== params.auth.scopeKey || current.scopeState !== params.auth.scopeState) {
        reason = 'scope_changed';
      } else if (current.authMethod !== params.auth.method) {
        reason = 'method_changed';
      } else if (current.cliGeneration !== params.cliGeneration) {
        reason = 'cli_generation_changed';
      } else if (
        params.auth.scopeState === 'unknown'
        && current.authStoreSignal !== params.authStoreSignal
      ) {
        reason = 'unknown_scope_signal_changed';
      }
      // New epochs are allocated above every epoch ever used for this connection so a
      // restored (lower) known epoch never collides with a later allocation.
      const maxUsed = Math.max(current.authEpoch, lastKnown?.last_known_epoch ?? 0);
      epoch = reason ? maxUsed + 1 : current.authEpoch;
    }
    const known = params.auth.scopeState === 'known';
    db.prepare(`
      INSERT INTO llm_connection_auth_bindings (
        connection_id, scope_state, scope_key, auth_epoch, auth_method, binding_mode,
        cli_generation, auth_store_signal, observed_at, epoch_started_at, epoch_reason,
        last_known_scope_key, last_known_epoch, last_known_cli_generation, last_known_auth_method
      ) VALUES (?, ?, ?, ?, ?, 'snapshot_checked', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        scope_state = excluded.scope_state,
        scope_key = excluded.scope_key,
        auth_epoch = excluded.auth_epoch,
        auth_method = excluded.auth_method,
        cli_generation = excluded.cli_generation,
        auth_store_signal = excluded.auth_store_signal,
        observed_at = excluded.observed_at,
        epoch_started_at = CASE WHEN ? THEN excluded.epoch_started_at
                                ELSE llm_connection_auth_bindings.epoch_started_at END,
        epoch_reason = CASE WHEN ? THEN excluded.epoch_reason
                            ELSE llm_connection_auth_bindings.epoch_reason END,
        last_known_scope_key = CASE WHEN ? THEN excluded.last_known_scope_key
                                    ELSE llm_connection_auth_bindings.last_known_scope_key END,
        last_known_epoch = CASE WHEN ? THEN excluded.last_known_epoch
                                ELSE llm_connection_auth_bindings.last_known_epoch END,
        last_known_cli_generation = CASE WHEN ? THEN excluded.last_known_cli_generation
                                         ELSE llm_connection_auth_bindings.last_known_cli_generation END,
        last_known_auth_method = CASE WHEN ? THEN excluded.last_known_auth_method
                                      ELSE llm_connection_auth_bindings.last_known_auth_method END
    `).run(
      params.connectionId,
      params.auth.scopeState,
      params.auth.scopeKey,
      epoch,
      params.auth.method,
      params.cliGeneration,
      params.authStoreSignal,
      now,
      now,
      reason,
      known ? params.auth.scopeKey : null,
      known ? epoch : null,
      known ? params.cliGeneration : null,
      known ? params.auth.method : null,
      reason ? 1 : 0,
      reason ? 1 : 0,
      known ? 1 : 0,
      known ? 1 : 0,
      known ? 1 : 0,
      known ? 1 : 0,
    );
    return {
      binding: getAuthBinding(db, params.connectionId)!,
      epochChanged: reason !== null && current !== null,
      reason,
    };
  }).immediate();
}

/** Remove all model-discovery rows of a deleted connection (local data only). */
export function deleteModelDiscoveryRows(db: Database.Database, connectionId: string): void {
  db.prepare('DELETE FROM llm_model_observations WHERE connection_id = ?').run(connectionId);
  db.prepare('DELETE FROM llm_model_catalog_snapshots WHERE connection_id = ?').run(connectionId);
  db.prepare('DELETE FROM llm_connection_auth_bindings WHERE connection_id = ?').run(connectionId);
}

/** True only if the binding still carries exactly this scope and epoch (CAS). */
export function authBindingMatches(
  db: Database.Database,
  connectionId: string,
  scopeKey: string,
  authEpoch: number,
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM llm_connection_auth_bindings
    WHERE connection_id = ? AND scope_key = ? AND auth_epoch = ?
  `).get(connectionId, scopeKey, authEpoch);
  return row !== undefined;
}

export interface CatalogSnapshot {
  connectionId: string;
  scopeKey: string;
  authEpoch: number;
  cliGeneration: string | null;
  source: CliCatalogSource;
  revision: number;
  items: CliCatalogModel[];
  defaultModelId: string | null;
  fetchedAt: string;
  lastAttemptAt: string | null;
  lastAttemptErrorKind: string | null;
  lastAttemptError: string | null;
}

type CatalogRow = {
  connection_id: string;
  scope_key: string;
  auth_epoch: number;
  cli_generation: string | null;
  source: CliCatalogSource;
  revision: number;
  items_json: string;
  default_model_id: string | null;
  fetched_at: string;
  last_attempt_at: string | null;
  last_attempt_error_kind: string | null;
  last_attempt_error: string | null;
};

function parseItems(raw: string): CliCatalogModel[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as CliCatalogModel[] : [];
  } catch {
    return [];
  }
}

export function getCatalogSnapshot(db: Database.Database, connectionId: string): CatalogSnapshot | null {
  const row = db.prepare(
    'SELECT * FROM llm_model_catalog_snapshots WHERE connection_id = ?',
  ).get(connectionId) as CatalogRow | undefined;
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    scopeKey: row.scope_key,
    authEpoch: row.auth_epoch,
    cliGeneration: row.cli_generation,
    source: row.source,
    revision: row.revision,
    items: parseItems(row.items_json),
    defaultModelId: row.default_model_id,
    fetchedAt: row.fetched_at,
    lastAttemptAt: row.last_attempt_at,
    lastAttemptErrorKind: row.last_attempt_error_kind,
    lastAttemptError: row.last_attempt_error,
  };
}

/**
 * Atomically replace the catalog with a *complete* snapshot, but only while the auth
 * binding still carries the scope/epoch captured when the refresh started. Late
 * responses from an older account or CLI are discarded (returns false).
 */
export function saveCatalogSnapshot(
  db: Database.Database,
  params: {
    connectionId: string;
    scopeKey: string;
    authEpoch: number;
    cliGeneration: string | null;
    source: CliCatalogSource;
    items: CliCatalogModel[];
    now?: string;
  },
): boolean {
  const now = params.now ?? new Date().toISOString();
  return db.transaction(() => {
    if (!authBindingMatches(db, params.connectionId, params.scopeKey, params.authEpoch)) return false;
    const defaultModel = params.items.find((item) => item.isDefault) ?? null;
    db.prepare(`
      INSERT INTO llm_model_catalog_snapshots (
        connection_id, scope_key, auth_epoch, cli_generation, source, revision,
        items_json, default_model_id, fetched_at, last_attempt_at,
        last_attempt_error_kind, last_attempt_error
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(connection_id) DO UPDATE SET
        scope_key = excluded.scope_key,
        auth_epoch = excluded.auth_epoch,
        cli_generation = excluded.cli_generation,
        source = excluded.source,
        revision = llm_model_catalog_snapshots.revision + 1,
        items_json = excluded.items_json,
        default_model_id = excluded.default_model_id,
        fetched_at = excluded.fetched_at,
        last_attempt_at = excluded.last_attempt_at,
        last_attempt_error_kind = NULL,
        last_attempt_error = NULL
    `).run(
      params.connectionId,
      params.scopeKey,
      params.authEpoch,
      params.cliGeneration,
      params.source,
      JSON.stringify(params.items),
      defaultModel?.id ?? null,
      now,
      now,
    );
    return true;
  }).immediate();
}

/** Record a failed refresh without touching the last complete snapshot. */
export function recordCatalogRefreshFailure(
  db: Database.Database,
  connectionId: string,
  errorKind: string,
  message: string,
  now = new Date().toISOString(),
): void {
  db.prepare(`
    UPDATE llm_model_catalog_snapshots
    SET last_attempt_at = ?, last_attempt_error_kind = ?, last_attempt_error = ?
    WHERE connection_id = ?
  `).run(now, errorKind.slice(0, 64), message.slice(0, 500), connectionId);
}

export type ObservationOutcome =
  | 'success'
  | 'mismatch'
  | 'model_rejected'
  | 'temporary_failure'
  | 'connection_failure'
  | 'unclassified_failure'
  | 'ambiguous';

export interface ModelObservation {
  connectionId: string;
  scopeKey: string;
  authEpoch: number;
  modelId: string;
  selectionMode: ModelSelectionMode;
  lastOutcome: ObservationOutcome;
  errorKind: string | null;
  errorMessage: string | null;
  actualModel: string | null;
  lastSource: 'business' | 'test';
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  backoffUntil: string | null;
  updatedAt: string;
}

type ObservationRow = {
  connection_id: string;
  scope_key: string;
  auth_epoch: number;
  model_id: string;
  selection_mode: ModelSelectionMode;
  last_outcome: ObservationOutcome;
  error_kind: string | null;
  error_message: string | null;
  actual_model: string | null;
  last_source: 'business' | 'test';
  last_success_at: string | null;
  last_failure_at: string | null;
  backoff_until: string | null;
  updated_at: string;
};

function observationFromRow(row: ObservationRow): ModelObservation {
  return {
    connectionId: row.connection_id,
    scopeKey: row.scope_key,
    authEpoch: row.auth_epoch,
    modelId: row.model_id,
    selectionMode: row.selection_mode,
    lastOutcome: row.last_outcome,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    actualModel: row.actual_model,
    lastSource: row.last_source,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    backoffUntil: row.backoff_until,
    updatedAt: row.updated_at,
  };
}

export function getModelObservation(
  db: Database.Database,
  connectionId: string,
  scopeKey: string,
  authEpoch: number,
  modelId: string,
): ModelObservation | null {
  const row = db.prepare(`
    SELECT * FROM llm_model_observations
    WHERE connection_id = ? AND scope_key = ? AND auth_epoch = ? AND model_id = ?
  `).get(connectionId, scopeKey, authEpoch, modelId) as ObservationRow | undefined;
  return row ? observationFromRow(row) : null;
}

/** All observations for a connection, newest first (current and historical epochs). */
export function listModelObservations(db: Database.Database, connectionId: string): ModelObservation[] {
  return (db.prepare(`
    SELECT * FROM llm_model_observations
    WHERE connection_id = ?
    ORDER BY auth_epoch DESC, updated_at DESC
    LIMIT 500
  `).all(connectionId) as ObservationRow[]).map(observationFromRow);
}

/**
 * Upsert the latest observation for one model under one scope/epoch. A success keeps
 * nothing of a prior failure except history timestamps. Callers decide whether a
 * success may clear a mismatch (only an explicit single-model test with a matching
 * actual model may, design §5.4).
 */
export function recordModelObservation(
  db: Database.Database,
  params: {
    connectionId: string;
    scopeKey: string;
    authEpoch: number;
    modelId: string;
    selectionMode: ModelSelectionMode;
    outcome: ObservationOutcome;
    source: 'business' | 'test';
    errorKind?: string | null;
    errorMessage?: string | null;
    actualModel?: string | null;
    backoffUntil?: string | null;
    now?: string;
  },
): void {
  const now = params.now ?? new Date().toISOString();
  const success = params.outcome === 'success';
  db.prepare(`
    INSERT INTO llm_model_observations (
      connection_id, scope_key, auth_epoch, model_id, selection_mode, last_outcome,
      error_kind, error_message, actual_model, last_source, last_success_at,
      last_failure_at, backoff_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id, scope_key, auth_epoch, model_id) DO UPDATE SET
      selection_mode = excluded.selection_mode,
      last_outcome = excluded.last_outcome,
      error_kind = excluded.error_kind,
      error_message = excluded.error_message,
      actual_model = COALESCE(excluded.actual_model, llm_model_observations.actual_model),
      last_source = excluded.last_source,
      last_success_at = COALESCE(excluded.last_success_at, llm_model_observations.last_success_at),
      last_failure_at = COALESCE(excluded.last_failure_at, llm_model_observations.last_failure_at),
      backoff_until = excluded.backoff_until,
      updated_at = excluded.updated_at
  `).run(
    params.connectionId,
    params.scopeKey,
    params.authEpoch,
    params.modelId,
    params.selectionMode,
    params.outcome,
    params.errorKind ?? null,
    params.errorMessage?.slice(0, 500) ?? null,
    params.actualModel ?? null,
    params.source,
    success ? now : null,
    success ? null : now,
    params.backoffUntil ?? null,
    now,
  );
}
