import type Database from 'better-sqlite3';

/**
 * 模型连接的动态目录、认证绑定与调用观察（schema v35）。
 *
 * 设计依据：docs/design/adaptive-agent-compatibility-and-model-discovery-2026-09-23.md §5、§6.1、§8。
 *
 * - 这些表独立于 model_connections 的旧 candidate/available 列。旧列只作历史展示与
 *   迁移输入，新版本的调用准入不再读取它们；旧版本（0.2.92 等）不认识这些表，
 *   降级后重写旧列也不会变成新版本的授权证据。
 * - 所有行都绑定 connection_id + scope_key + auth_epoch；跨 epoch 的记录只作历史。
 * - 本机数据，不加入 cloud_dirty trigger，不进入云同步。
 *
 * SQL 只有这一份权威定义：daemon fresh schema、v35 migration、Electron fresh schema
 * 与 Electron repair schema 都必须调用 ensureModelDiscoverySchema。
 */
export const MODEL_DISCOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS llm_connection_auth_bindings (
    connection_id TEXT PRIMARY KEY,
    scope_state TEXT NOT NULL CHECK (scope_state IN ('known', 'unknown')),
    scope_key TEXT NOT NULL,
    auth_epoch INTEGER NOT NULL CHECK (auth_epoch >= 1),
    auth_method TEXT,
    binding_mode TEXT NOT NULL DEFAULT 'snapshot_checked',
    cli_generation TEXT,
    auth_store_signal TEXT,
    observed_at TEXT NOT NULL,
    epoch_started_at TEXT NOT NULL,
    epoch_reason TEXT,
    -- Last *known* scope for this connection, so a transient fall-back to an unknown
    -- scope (metadata session timeout) returning to the same account and CLI
    -- generation restores that epoch instead of discarding its evidence.
    last_known_scope_key TEXT,
    last_known_epoch INTEGER,
    last_known_cli_generation TEXT,
    last_known_auth_method TEXT
);

CREATE TABLE IF NOT EXISTS llm_model_catalog_snapshots (
    connection_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    auth_epoch INTEGER NOT NULL,
    cli_generation TEXT,
    source TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    items_json TEXT NOT NULL,
    default_model_id TEXT,
    fetched_at TEXT NOT NULL,
    last_attempt_at TEXT,
    last_attempt_error_kind TEXT,
    last_attempt_error TEXT
);

CREATE TABLE IF NOT EXISTS llm_model_observations (
    connection_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    auth_epoch INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    selection_mode TEXT NOT NULL CHECK (selection_mode IN ('follow_default', 'alias', 'pinned_id')),
    last_outcome TEXT NOT NULL CHECK (last_outcome IN (
      'success', 'mismatch', 'model_rejected', 'temporary_failure',
      'connection_failure', 'unclassified_failure', 'ambiguous'
    )),
    error_kind TEXT,
    error_message TEXT,
    actual_model TEXT,
    last_source TEXT NOT NULL CHECK (last_source IN ('business', 'test')),
    last_success_at TEXT,
    last_failure_at TEXT,
    backoff_until TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, scope_key, auth_epoch, model_id)
);

CREATE INDEX IF NOT EXISTS idx_llm_model_observations_connection
  ON llm_model_observations(connection_id, auth_epoch);
`;

export function ensureModelDiscoverySchema(db: Database.Database): void {
  db.exec(MODEL_DISCOVERY_SCHEMA_SQL);
}
