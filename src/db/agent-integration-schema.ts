import type Database from 'better-sqlite3';
import { scrubPersistedAgentIntegrationEvents } from './agent-integration-event-sanitizer.js';

/** Canonical v34 table inventory shared by migration and schema-parity tests. */
export const AGENT_INTEGRATION_TABLES = [
  'agent_installations',
  'installation_components',
  'managed_artifacts',
  'artifact_consumers',
  'agent_consents',
  'reconcile_runs',
  'agent_integration_apply_tasks',
  'agent_integration_apply_task_items',
  'agent_integration_apply_task_feed_state',
  'projection_mutations',
  'verification_results',
  'agent_host_activity_evidence',
  'agent_aliases',
  'writer_fences',
  'agent_integration_events',
] as const;

const VERIFICATION_RESULTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS verification_results (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES reconcile_runs(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL,
    component_key TEXT NOT NULL,
    family TEXT NOT NULL,
    host_variant TEXT NOT NULL,
    distribution_id TEXT,
    runtime_realm TEXT NOT NULL,
    host_version TEXT,
    os_version TEXT,
    tide_mind_version TEXT,
    adapter_version TEXT NOT NULL,
    catalog_version TEXT NOT NULL,
    projection_version TEXT,
    selector_schema_version TEXT,
    verification_manifest_version TEXT NOT NULL,
    method TEXT NOT NULL,
    identity_assertion TEXT,
    artifact_hash TEXT,
    reload_generation TEXT,
    invalidation_keys_json TEXT NOT NULL DEFAULT '[]',
    result TEXT NOT NULL CHECK(result IN ('verified','failed')),
    evidence_ref TEXT,
    evidence_hash TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    expires_at TEXT,
    invalidated_at TEXT,
    invalidation_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(installation_id, component_key)
      REFERENCES installation_components(installation_id, component_key) ON DELETE CASCADE
);`;

const AGENT_INTEGRATION_APPLY_TASK_FEED_TRIGGERS = [
  {
    name: 'trg_agent_apply_tasks_feed_insert',
    sql: `CREATE TRIGGER trg_agent_apply_tasks_feed_insert
AFTER INSERT ON agent_integration_apply_tasks BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_apply_tasks_feed_update',
    sql: `CREATE TRIGGER trg_agent_apply_tasks_feed_update
AFTER UPDATE ON agent_integration_apply_tasks BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_apply_tasks_feed_delete',
    sql: `CREATE TRIGGER trg_agent_apply_tasks_feed_delete
AFTER DELETE ON agent_integration_apply_tasks BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_apply_items_feed_insert',
    sql: `CREATE TRIGGER trg_agent_apply_items_feed_insert
AFTER INSERT ON agent_integration_apply_task_items BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_apply_items_feed_update',
    sql: `CREATE TRIGGER trg_agent_apply_items_feed_update
AFTER UPDATE ON agent_integration_apply_task_items BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_apply_items_feed_delete',
    sql: `CREATE TRIGGER trg_agent_apply_items_feed_delete
AFTER DELETE ON agent_integration_apply_task_items BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_connect_runs_feed_insert',
    sql: `CREATE TRIGGER trg_agent_connect_runs_feed_insert
AFTER INSERT ON reconcile_runs WHEN NEW.operation_type = 'connect' BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_connect_runs_feed_update',
    sql: `CREATE TRIGGER trg_agent_connect_runs_feed_update
AFTER UPDATE ON reconcile_runs WHEN OLD.operation_type = 'connect' OR NEW.operation_type = 'connect' BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
  {
    name: 'trg_agent_connect_runs_feed_delete',
    sql: `CREATE TRIGGER trg_agent_connect_runs_feed_delete
AFTER DELETE ON reconcile_runs WHEN OLD.operation_type = 'connect' BEGIN
  UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
END;`,
  },
] as const;

const AGENT_INTEGRATION_APPLY_TASK_FEED_TRIGGER_SQL =
  AGENT_INTEGRATION_APPLY_TASK_FEED_TRIGGERS.map(trigger => trigger.sql).join('\n');
const AGENT_INTEGRATION_APPLY_TASK_FEED_SCHEMA_TRIGGER_SQL =
  AGENT_INTEGRATION_APPLY_TASK_FEED_TRIGGERS
    .map(trigger => trigger.sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '))
    .join('\n');

/**
 * Tide Mind 本机外部 Agent 托管数据底座。
 *
 * 这组表只描述当前设备上的 Installation、受管投影、授权、协调日志和验证证据。
 * 它们没有加入 cloud_dirty trigger，也不得进入云同步/记忆业务数据通道。
 *
 * SQL 只有这一份权威定义。daemon fresh schema、v34 migration、Electron fresh schema
 * 与 Electron repair schema 都必须调用 ensureAgentIntegrationSchema，避免入口漂移。
 */
export const AGENT_INTEGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_installations (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    host_variant TEXT NOT NULL,
    runtime_realm TEXT NOT NULL DEFAULT 'local_macos',
    profile_id TEXT NOT NULL DEFAULT '',
    install_key TEXT NOT NULL,
    distribution_id TEXT,
    provenance TEXT NOT NULL DEFAULT 'unknown',
    os_user_identity TEXT,
    display_name TEXT NOT NULL,
    display_alias TEXT,
    config_root TEXT,
    executable_path TEXT,
    app_path TEXT,
    detected_version TEXT,
    version_detection_method TEXT,
    agent_id TEXT UNIQUE,
    desired_state TEXT NOT NULL DEFAULT 'unmanaged'
      CHECK(desired_state IN ('unmanaged','managed','disabled','removed')),
    tombstoned_at TEXT,
    tombstone_reason TEXT,
    consent_envelope_id TEXT REFERENCES agent_consents(id),
    consented_at TEXT,
    supported_capability INTEGER NOT NULL DEFAULT 0
      CHECK(supported_capability BETWEEN 0 AND 4),
    desired_capability INTEGER NOT NULL DEFAULT 0
      CHECK(desired_capability BETWEEN 0 AND 4),
    verified_capability INTEGER NOT NULL DEFAULT 0
      CHECK(verified_capability BETWEEN 0 AND 4),
    delivery_summary TEXT NOT NULL DEFAULT 'cataloged'
      CHECK(delivery_summary IN ('cataloged','detectable','guided','hybrid','fully_managed')),
    verification_summary TEXT NOT NULL DEFAULT 'unverified'
      CHECK(verification_summary IN ('unverified','verifying','verified','stale','failed','mixed')),
    health_state TEXT NOT NULL DEFAULT 'discovered',
    status_reason TEXT,
    reconcile_state TEXT NOT NULL DEFAULT 'idle'
      CHECK(reconcile_state IN (
        'idle','planning','awaiting_consent','applying','verifying','compensating',
        'needs_recovery','backoff','paused'
      )),
    last_detected_at TEXT,
    last_verified_at TEXT,
    verification_result_id TEXT REFERENCES verification_results(id),
    last_repaired_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(runtime_realm, install_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_installations_family
  ON agent_installations(family, host_variant);
CREATE INDEX IF NOT EXISTS idx_agent_installations_state
  ON agent_installations(desired_state, reconcile_state);
CREATE INDEX IF NOT EXISTS idx_agent_installations_detected
  ON agent_installations(last_detected_at);

CREATE TABLE IF NOT EXISTS managed_artifacts (
    id TEXT PRIMARY KEY,
    runtime_realm TEXT NOT NULL DEFAULT 'local_macos',
    component_type TEXT NOT NULL
      CHECK(component_type IN ('skill','mcp','hook','plugin','rule')),
    target_path TEXT NOT NULL,
    ownership_key TEXT NOT NULL DEFAULT '',
    mutation_domain TEXT NOT NULL,
    projection_version TEXT NOT NULL,
    selector_schema_version TEXT NOT NULL,
    container_precondition_hash TEXT,
    owned_fragment_hash TEXT,
    desired_fragment_hash TEXT,
    observed_fragment_hash TEXT,
    previous_snapshot_ref TEXT,
    state TEXT NOT NULL DEFAULT 'healthy'
      CHECK(state IN (
        'healthy','missing','drifted','conflict','paused','removal_pending','removed','needs_recovery'
      )),
    missing_episode_id TEXT,
    missing_window_started_at TEXT,
    missing_event_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_event_count >= 0),
    paused_reason TEXT,
    user_reset_at TEXT,
    last_applied_at TEXT,
    last_verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(runtime_realm, target_path, ownership_key)
);
CREATE INDEX IF NOT EXISTS idx_managed_artifacts_state
  ON managed_artifacts(state);
CREATE INDEX IF NOT EXISTS idx_managed_artifacts_target
  ON managed_artifacts(runtime_realm, target_path);
CREATE INDEX IF NOT EXISTS idx_managed_artifacts_domain
  ON managed_artifacts(mutation_domain);

CREATE TABLE IF NOT EXISTS agent_consents (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
    policy_version TEXT NOT NULL,
    allowed_components_json TEXT NOT NULL DEFAULT '[]',
    allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
    normalized_targets_json TEXT NOT NULL DEFAULT '[]',
    selector_schema_version TEXT NOT NULL,
    selector_resolution_json TEXT NOT NULL DEFAULT '{}',
    executable_realpaths_json TEXT NOT NULL DEFAULT '[]',
    command_categories_json TEXT NOT NULL DEFAULT '[]',
    maximum_risk TEXT NOT NULL
      CHECK(maximum_risk IN ('read_only','low','elevated','high')),
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active','superseded','revoked')),
    exception_scope TEXT NOT NULL DEFAULT 'installation'
      CHECK(exception_scope IN ('global','installation')),
    exceptions_json TEXT NOT NULL DEFAULT '{}',
    confirmed_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_consents_installation
  ON agent_consents(installation_id, status);

CREATE TABLE IF NOT EXISTS installation_components (
    installation_id TEXT NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
    component_key TEXT NOT NULL,
    desired_state TEXT NOT NULL DEFAULT 'unmanaged'
      CHECK(desired_state IN ('unmanaged','managed','disabled','removed')),
    desired_capability INTEGER NOT NULL DEFAULT 0
      CHECK(desired_capability BETWEEN 0 AND 4),
    delivery_mode TEXT NOT NULL DEFAULT 'cataloged'
      CHECK(delivery_mode IN ('cataloged','detectable','guided','managed')),
    verification_status TEXT NOT NULL DEFAULT 'unverified'
      CHECK(verification_status IN ('unverified','verifying','verified','stale','failed')),
    verification_result_id TEXT REFERENCES verification_results(id),
    artifact_id TEXT REFERENCES managed_artifacts(id),
    visibility_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK(visibility_state IN ('absent','dedicated','shared_visible','hidden','unknown')),
    tombstoned_at TEXT,
    tombstone_reason TEXT,
    consent_envelope_id TEXT REFERENCES agent_consents(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(installation_id, component_key)
);
CREATE INDEX IF NOT EXISTS idx_installation_components_artifact
  ON installation_components(artifact_id);
CREATE INDEX IF NOT EXISTS idx_installation_components_status
  ON installation_components(desired_state, verification_status);

CREATE TABLE IF NOT EXISTS artifact_consumers (
    artifact_id TEXT NOT NULL REFERENCES managed_artifacts(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL,
    component_key TEXT NOT NULL,
    required_capability INTEGER NOT NULL DEFAULT 0
      CHECK(required_capability BETWEEN 0 AND 4),
    desired_state TEXT NOT NULL DEFAULT 'managed'
      CHECK(desired_state IN ('managed','disabled','removal_pending','removed')),
    discover_reachability TEXT NOT NULL DEFAULT 'dedicated'
      CHECK(discover_reachability IN ('dedicated','shared_visible','per_host_ignorable')),
    component_exception TEXT,
    tombstoned_at TEXT,
    tombstone_reason TEXT,
    consent_envelope_id TEXT REFERENCES agent_consents(id),
    state TEXT NOT NULL DEFAULT 'active'
      CHECK(state IN ('active','removal_pending','removed')),
    added_at TEXT NOT NULL,
    removed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(artifact_id, installation_id, component_key),
    FOREIGN KEY(installation_id, component_key)
      REFERENCES installation_components(installation_id, component_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifact_consumers_installation
  ON artifact_consumers(installation_id, component_key);
CREATE INDEX IF NOT EXISTS idx_artifact_consumers_state
  ON artifact_consumers(artifact_id, state, desired_state);

CREATE TABLE IF NOT EXISTS reconcile_runs (
    id TEXT PRIMARY KEY,
    installation_id TEXT REFERENCES agent_installations(id),
    operation_type TEXT NOT NULL,
    execution_plan_hash TEXT NOT NULL,
    consent_envelope_id TEXT REFERENCES agent_consents(id),
    state TEXT NOT NULL DEFAULT 'planned'
      CHECK(state IN (
        'planned','preconditions_checked','applying','applied_unverified','verified','committed',
        'compensating','needs_recovery','failed','cancelled'
      )),
    recovery_strategy TEXT NOT NULL,
    writer_fence_snapshot_json TEXT NOT NULL DEFAULT '{}',
    adapter_version TEXT,
    catalog_version TEXT,
    projection_version TEXT,
    selector_schema_version TEXT,
    prepared_plan_json TEXT NOT NULL DEFAULT '{}',
    desired_capability INTEGER NOT NULL DEFAULT 0
      CHECK(desired_capability BETWEEN 0 AND 4),
    failure_code TEXT,
    failure_stage TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconcile_runs_recovery
  ON reconcile_runs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_reconcile_runs_installation
  ON reconcile_runs(installation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reconcile_runs_legacy_correlation
  ON reconcile_runs(operation_type, installation_id, execution_plan_hash, id);

-- Renderer-visible batch execution is durable independently from reconcile_runs:
-- every selected Installation is recorded before the first coordinator run.
CREATE TABLE IF NOT EXISTS agent_integration_apply_tasks (
    id TEXT PRIMARY KEY,
    plan_hash TEXT NOT NULL,
    operation_type TEXT NOT NULL DEFAULT 'connect'
      CHECK(operation_type IN ('connect')),
    state TEXT NOT NULL DEFAULT 'running'
      CHECK(state IN ('running','completed')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_integration_apply_tasks_recent
  ON agent_integration_apply_tasks(updated_at, started_at);

CREATE TABLE IF NOT EXISTS agent_integration_apply_task_items (
    task_id TEXT NOT NULL REFERENCES agent_integration_apply_tasks(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL REFERENCES agent_installations(id),
    run_id TEXT REFERENCES reconcile_runs(id) ON DELETE SET NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    execution_plan_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','running','terminal','interrupted')),
    result_json TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(task_id, installation_id),
    UNIQUE(task_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_agent_integration_apply_task_items_state
  ON agent_integration_apply_task_items(task_id, state, ordinal);

-- Monotonic snapshot token for renderer task-feed keyset cursors. Triggers
-- make every feed-relevant write invalidate outstanding cursors atomically.
CREATE TABLE IF NOT EXISTS agent_integration_apply_task_feed_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
INSERT OR IGNORE INTO agent_integration_apply_task_feed_state(singleton, revision) VALUES (1, 0);

${AGENT_INTEGRATION_APPLY_TASK_FEED_SCHEMA_TRIGGER_SQL}

CREATE TABLE IF NOT EXISTS projection_mutations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES reconcile_runs(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    installation_id TEXT REFERENCES agent_installations(id),
    component_key TEXT,
    artifact_id TEXT REFERENCES managed_artifacts(id),
    mutation_domain TEXT NOT NULL,
    target TEXT NOT NULL,
    before_hash TEXT,
    after_hash TEXT,
    precondition_json TEXT NOT NULL DEFAULT '{}',
    adapter_version TEXT,
    catalog_version TEXT,
    projection_version TEXT,
    selector_schema_version TEXT,
    planned_mutation_json TEXT NOT NULL DEFAULT '{}',
    writer_fence_epoch INTEGER,
    writer_generation INTEGER,
    idempotency_strategy TEXT NOT NULL,
    readback_strategy TEXT NOT NULL,
    post_effect_fingerprint TEXT,
    compensation_precondition TEXT,
    apply_receipt_json TEXT,
    verification_result_json TEXT,
    compensation_result_json TEXT,
    state TEXT NOT NULL DEFAULT 'prepared'
      CHECK(state IN (
        'prepared','effect_started','effect_observed','receipt_persisted','verified','committed',
        'compensating','compensated','needs_recovery','failed'
      )),
    failure_code TEXT,
    failure_stage TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    journal_version INTEGER NOT NULL DEFAULT 0 CHECK(journal_version >= 0),
    next_recovery_at TEXT,
    effect_started_at TEXT,
    effect_observed_at TEXT,
    receipt_persisted_at TEXT,
    verified_at TEXT,
    committed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(installation_id, component_key)
      REFERENCES installation_components(installation_id, component_key),
    UNIQUE(run_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_projection_mutations_recovery
  ON projection_mutations(state, next_recovery_at);
CREATE INDEX IF NOT EXISTS idx_projection_mutations_run
  ON projection_mutations(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_projection_mutations_domain
  ON projection_mutations(mutation_domain, state);

${VERIFICATION_RESULTS_TABLE_SQL}

-- Runtime host activity is local verification evidence, not a memory/business
-- event. Keep only the latest invocation for an exact version binding so tool
-- use cannot grow the database without bound.
CREATE TABLE IF NOT EXISTS agent_host_activity_evidence (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    host_variant TEXT NOT NULL,
    component_key TEXT NOT NULL
      CHECK(component_key IN ('memory_tools','lifecycle')),
    signal_name TEXT NOT NULL
      CHECK(signal_name IN (
        'brain_prepare','brain_recall','brain_digest',
        'session_start','pre_compact','post_compact'
      )),
    tide_mind_version TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    projection_version TEXT NOT NULL,
    host_version TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    CHECK(
      (component_key = 'memory_tools' AND signal_name IN (
        'brain_prepare','brain_recall','brain_digest'
      )) OR
      (component_key = 'lifecycle' AND signal_name IN (
        'session_start','pre_compact','post_compact'
      ))
    ),
    UNIQUE(
      installation_id, component_key, signal_name, tide_mind_version,
      adapter_version, projection_version, host_version
    )
);
CREATE INDEX IF NOT EXISTS idx_agent_host_activity_lookup
  ON agent_host_activity_evidence(
    installation_id, component_key, host_variant, observed_at
  );
CREATE INDEX IF NOT EXISTS idx_agent_host_activity_agent
  ON agent_host_activity_evidence(agent_id, observed_at);
CREATE TABLE IF NOT EXISTS agent_aliases (
    id TEXT PRIMARY KEY,
    alias_type TEXT NOT NULL
      CHECK(alias_type IN ('legacy_agent_id','agent_id','config_root','profile','install_path','executable_path')),
    alias_value TEXT NOT NULL,
    runtime_realm TEXT NOT NULL DEFAULT 'local_macos',
    canonical_agent_id TEXT,
    installation_id TEXT NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(alias_type, alias_value, runtime_realm)
);
CREATE INDEX IF NOT EXISTS idx_agent_aliases_installation
  ON agent_aliases(installation_id);

CREATE TABLE IF NOT EXISTS writer_fences (
    mutation_domain TEXT PRIMARY KEY,
    scope_mode TEXT NOT NULL DEFAULT 'legacy'
      CHECK(scope_mode IN ('legacy','managed')),
    minimum_writer_protocol INTEGER NOT NULL DEFAULT 1 CHECK(minimum_writer_protocol >= 1),
    writer_generation INTEGER NOT NULL DEFAULT 0 CHECK(writer_generation >= 0),
    owner_instance_id TEXT,
    epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
    lease_expires_at INTEGER,
    state TEXT NOT NULL DEFAULT 'released' CHECK(state IN ('active','released')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_writer_fences_lease
  ON writer_fences(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS agent_integration_events (
    id TEXT PRIMARY KEY,
    installation_id TEXT REFERENCES agent_installations(id) ON DELETE CASCADE,
    component_key TEXT,
    artifact_id TEXT REFERENCES managed_artifacts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info'
      CHECK(severity IN ('info','warning','error')),
    episode_id TEXT,
    dedupe_key TEXT,
    state TEXT NOT NULL DEFAULT 'unread'
      CHECK(state IN ('unread','read','archived')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    read_at TEXT,
    FOREIGN KEY(installation_id, component_key)
      REFERENCES installation_components(installation_id, component_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_integration_events_missing_episode
  ON agent_integration_events(artifact_id, episode_id)
  WHERE artifact_id IS NOT NULL AND episode_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_integration_events_dedupe
  ON agent_integration_events(kind, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_integration_events_inbox
  ON agent_integration_events(state, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_integration_events_installation
  ON agent_integration_events(installation_id, created_at);
`;

export const AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY =
  'agent_integration_minimum_writer_protocol';
export const AGENT_INTEGRATION_WRITER_PROTOCOL = 1;

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(candidate => candidate.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function verificationResultsHasCanonicalConstraints(db: Database.Database): boolean {
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(verification_results)').all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const keys = new Set(foreignKeys.map(key => (
    `${key.table}:${key.from}:${key.to}:${key.on_delete.toUpperCase()}`
  )));
  const columns = db.prepare('PRAGMA table_info(verification_results)').all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const required = new Set([
    'installation_id', 'component_key', 'family', 'host_variant', 'runtime_realm',
    'adapter_version', 'catalog_version', 'verification_manifest_version', 'method',
    'invalidation_keys_json', 'result', 'evidence_hash', 'verified_at', 'created_at',
  ]);
  const tableSql = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'verification_results'
  `).get() as { sql?: string } | undefined)?.sql?.replace(/\s/gu, '').toLowerCase() ?? '';
  return foreignKeys.length === 3
    && keys.has('reconcile_runs:run_id:id:CASCADE')
    && keys.has('installation_components:installation_id:installation_id:CASCADE')
    && keys.has('installation_components:component_key:component_key:CASCADE')
    && columns.some(column => column.name === 'id' && column.pk === 1)
    && columns.filter(column => required.has(column.name)).every(column => column.notnull === 1)
    && [...required].every(name => columns.some(column => column.name === name))
    && tableSql.includes("check(resultin('verified','failed'))");
}

function restoreVerificationResultsConstraints(db: Database.Database): void {
  if (verificationResultsHasCanonicalConstraints(db)) return;
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM verification_results')
    .get() as { count: number }).count);
  if (count !== 0) {
    // Reconstructing a populated evidence table without an authoritative FK
    // history could accidentally bless orphaned or ambiguous verification.
    // Refuse startup instead of manufacturing trusted evidence.
    throw new Error('unsafe partial verification_results schema contains rows; authoritative repair required');
  }
  db.exec('DROP TABLE verification_results');
  db.exec(VERIFICATION_RESULTS_TABLE_SQL);
}

function isEvidenceFreeDetachFinalizer(db: Database.Database, run: {
  id: string
  installation_id: string | null
  operation_type: string
  consent_envelope_id: string | null
  prepared_plan_json: string
}): boolean {
  if (run.operation_type !== 'disconnect' || !run.installation_id || !run.consent_envelope_id) return false
  let componentKeys: string[]
  try {
    const plan = JSON.parse(run.prepared_plan_json) as { componentKeys?: unknown }
    if (!Array.isArray(plan.componentKeys)
      || plan.componentKeys.length === 0
      || !plan.componentKeys.every(key => (
        key === 'instruction' || key === 'memory_tools' || key === 'lifecycle'
      ))) return false
    componentKeys = plan.componentKeys
  } catch {
    return false
  }
  if (new Set(componentKeys).size !== componentKeys.length) return false
  const currentControl = db.prepare(`
    SELECT 1
    FROM agent_installations installation
    JOIN agent_consents consent ON consent.id = installation.consent_envelope_id
    WHERE installation.id = ? AND installation.consent_envelope_id = ?
      AND consent.installation_id = installation.id AND consent.status = 'active'
      AND installation.agent_id IS NOT NULL
      AND installation.desired_state = 'removed' AND installation.tombstoned_at IS NOT NULL
      AND installation.health_state = 'discovered'
      AND COALESCE(installation.status_reason, '') != 'conflict'
  `).get(run.installation_id, run.consent_envelope_id)
  if (!currentControl) return false
  const mutations = db.prepare(`
    SELECT mutation.component_key, mutation.installation_id, mutation.artifact_id,
           mutation.idempotency_strategy, mutation.state,
           EXISTS (
             SELECT 1
             FROM artifact_consumers consumer
             JOIN installation_components component
               ON component.installation_id = consumer.installation_id
              AND component.component_key = consumer.component_key
              AND component.artifact_id = consumer.artifact_id
             JOIN managed_artifacts artifact ON artifact.id = consumer.artifact_id
             WHERE consumer.artifact_id = mutation.artifact_id
               AND consumer.installation_id = mutation.installation_id
               AND consumer.component_key = mutation.component_key
               AND consumer.state = 'removal_pending'
               AND consumer.desired_state = 'removal_pending'
               AND consumer.tombstoned_at IS NOT NULL
               AND consumer.consent_envelope_id = ?
               AND component.desired_state = 'removed'
               AND component.tombstoned_at IS NOT NULL
               AND component.consent_envelope_id = ?
               AND artifact.state IN ('healthy','removal_pending')
           ) AS exact_consumer
    FROM projection_mutations mutation WHERE mutation.run_id = ?
  `).all(run.consent_envelope_id, run.consent_envelope_id, run.id) as Array<{
    component_key: string | null
    installation_id: string | null
    artifact_id: string | null
    idempotency_strategy: string
    state: string
    exact_consumer: number
  }>
  if (mutations.length === 0 || mutations.some(mutation => (
    mutation.component_key === null
    || !componentKeys.includes(mutation.component_key)
    || mutation.installation_id !== run.installation_id
    || mutation.artifact_id === null
    || mutation.idempotency_strategy !== 'consumer_detach_only'
    || mutation.state !== 'committed'
    || mutation.exact_consumer !== 1
  ))) return false
  const componentPlaceholders = componentKeys.map(() => '?').join(',')
  const unboundPendingConsumer = db.prepare(`
    SELECT 1
    FROM artifact_consumers consumer
    WHERE consumer.installation_id = ?
      AND consumer.component_key IN (${componentPlaceholders})
      AND consumer.state = 'removal_pending'
      AND (
        consumer.desired_state != 'removal_pending'
        OR consumer.tombstoned_at IS NULL
        OR consumer.consent_envelope_id IS NOT ?
        OR NOT EXISTS (
          SELECT 1 FROM installation_components component
          WHERE component.installation_id = consumer.installation_id
            AND component.component_key = consumer.component_key
            AND component.artifact_id = consumer.artifact_id
            AND component.desired_state = 'removed'
            AND component.tombstoned_at IS NOT NULL
            AND component.consent_envelope_id = ?
        )
        OR NOT EXISTS (
          SELECT 1 FROM projection_mutations mutation
          WHERE mutation.run_id = ?
            AND mutation.installation_id = consumer.installation_id
            AND mutation.component_key = consumer.component_key
            AND mutation.artifact_id = consumer.artifact_id
            AND mutation.idempotency_strategy = 'consumer_detach_only'
            AND mutation.state = 'committed'
        )
      )
    LIMIT 1
  `).get(
    run.installation_id,
    ...componentKeys,
    run.consent_envelope_id,
    run.consent_envelope_id,
    run.id,
  )
  if (unboundPendingConsumer) return false
  const detachedComponents = new Set(mutations.map(mutation => mutation.component_key))
  return componentKeys.every(componentKey => detachedComponents.has(componentKey))
}

export function ensureAgentIntegrationSchema(db: Database.Database): void {
  // Electron repair 入口可能面对只创建了空文件的 DB；先补 metadata，随后才写协议键。
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Pre-release v34 builds may have stopped between creating the feed token
  // table and its authoritative shape. An empty partial table is safe to
  // recreate; populated malformed state cannot be interpreted as a monotonic
  // revision and therefore fails closed instead of silently resetting cursors.
  const feedStateExists = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'agent_integration_apply_task_feed_state'
  `).get();
  if (feedStateExists) {
    const columns = db.prepare(`
      PRAGMA table_info(agent_integration_apply_task_feed_state)
    `).all() as Array<{ name: string; notnull: number; pk: number }>;
    const singleton = columns.find(column => column.name === 'singleton');
    const revision = columns.find(column => column.name === 'revision');
    const validShape = singleton?.pk === 1 && revision?.notnull === 1;
    if (!validShape) {
      const count = (db.prepare(`
        SELECT COUNT(*) AS count FROM agent_integration_apply_task_feed_state
      `).get() as { count: number }).count;
      if (count !== 0) throw new Error('unsafe partial task feed revision table contains rows');
      db.exec('DROP TABLE agent_integration_apply_task_feed_state;');
    }
  }
  db.exec(AGENT_INTEGRATION_SCHEMA_SQL);
  // Trigger names are part of the feed cursor protocol, not merely optional
  // indexes. A same-name pre-release or tampered trigger must never survive
  // `IF NOT EXISTS`, otherwise writes can leave an old renderer cursor valid.
  // Rebuild all nine definitions atomically from this single authoritative set.
  db.transaction(() => {
    for (const trigger of AGENT_INTEGRATION_APPLY_TASK_FEED_TRIGGERS) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger.name};`);
    }
    db.exec(AGENT_INTEGRATION_APPLY_TASK_FEED_TRIGGER_SQL);
  }).immediate();
  const verificationColumnsBeforeRepair = new Set((db.prepare(`
    PRAGMA table_info(verification_results)
  `).all() as Array<{ name: string }>).map(column => column.name));
  const repairedCriticalVerificationShape = [
    'run_id',
    'family',
    'host_variant',
    'runtime_realm',
    'adapter_version',
    'catalog_version',
    'verification_manifest_version',
    'method',
    'identity_assertion',
    'result',
    'evidence_hash',
    'verified_at',
    'created_at',
    'invalidation_keys_json',
  ].some(column => !verificationColumnsBeforeRepair.has(column));
  // Repair pre-release/partially-created v34 databases as well as fresh schema.
  db.transaction(() => {
  ensureColumn(db, 'writer_fences', 'scope_mode', "TEXT NOT NULL DEFAULT 'legacy' CHECK(scope_mode IN ('legacy','managed'))");
  ensureColumn(db, 'reconcile_runs', 'prepared_plan_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'reconcile_runs', 'desired_capability', 'INTEGER NOT NULL DEFAULT 0 CHECK(desired_capability BETWEEN 0 AND 4)');
  ensureColumn(db, 'agent_integration_apply_task_items', 'run_id', 'TEXT REFERENCES reconcile_runs(id) ON DELETE SET NULL');
  ensureColumn(db, 'projection_mutations', 'planned_mutation_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'projection_mutations', 'journal_version', 'INTEGER NOT NULL DEFAULT 0 CHECK(journal_version >= 0)');
  ensureColumn(db, 'verification_results', 'artifact_hash', 'TEXT');
  ensureColumn(db, 'verification_results', 'run_id', 'TEXT');
  ensureColumn(db, 'verification_results', 'family', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'host_variant', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'distribution_id', 'TEXT');
  ensureColumn(db, 'verification_results', 'runtime_realm', "TEXT NOT NULL DEFAULT 'local_macos'");
  ensureColumn(db, 'verification_results', 'host_version', 'TEXT');
  ensureColumn(db, 'verification_results', 'os_version', 'TEXT');
  ensureColumn(db, 'verification_results', 'tide_mind_version', 'TEXT');
  ensureColumn(db, 'verification_results', 'adapter_version', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'catalog_version', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'projection_version', 'TEXT');
  ensureColumn(db, 'verification_results', 'selector_schema_version', 'TEXT');
  ensureColumn(db, 'verification_results', 'verification_manifest_version', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'method', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'identity_assertion', 'TEXT');
  ensureColumn(db, 'verification_results', 'evidence_ref', 'TEXT');
  ensureColumn(db, 'verification_results', 'evidence_hash', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'result', "TEXT NOT NULL DEFAULT 'failed' CHECK(result IN ('verified','failed'))");
  ensureColumn(db, 'verification_results', 'verified_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'expires_at', 'TEXT');
  ensureColumn(db, 'verification_results', 'created_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'verification_results', 'reload_generation', 'TEXT');
  ensureColumn(db, 'verification_results', 'invalidation_keys_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'verification_results', 'invalidated_at', 'TEXT');
  ensureColumn(db, 'verification_results', 'invalidation_reason', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_integration_apply_task_items_run
      ON agent_integration_apply_task_items(run_id)
      WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_integration_apply_task_items_legacy_null
      ON agent_integration_apply_task_items(task_id, installation_id, execution_plan_hash)
      WHERE run_id IS NULL;
  `);
  restoreVerificationResultsConstraints(db);
  // Pre-release builds could retry verification without a run/component key.
  // Freeze the exact evidence found during this invocation. Never sweep every
  // historically-invalidated row: doing so would downgrade legitimate mixed
  // component state every time the application starts.
  if (!verificationColumnsBeforeRepair.has('run_id')) {
    const unsafeVerifiedRuns = db.prepare(`
      SELECT id, installation_id, operation_type, consent_envelope_id, prepared_plan_json
      FROM reconcile_runs WHERE state = 'verified'
    `).all() as Array<{
      id: string
      installation_id: string | null
      operation_type: string
      consent_envelope_id: string | null
      prepared_plan_json: string
    }>;
    const cancelUnboundVerifiedRun = db.prepare(`
      UPDATE reconcile_runs
      SET state = 'cancelled', failure_code = 'unbound_verification_evidence',
          failure_stage = 'verification_migration',
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND state = 'verified'
    `);
    const markUnboundInstallationRecovery = db.prepare(`
      UPDATE agent_installations
      SET reconcile_state = 'needs_recovery', status_reason = 'verification_stale',
          verified_capability = 0, verification_summary = 'stale',
          verification_result_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND desired_state = 'managed'
    `);
    for (const run of unsafeVerifiedRuns) {
      if (isEvidenceFreeDetachFinalizer(db, run)) continue;
      cancelUnboundVerifiedRun.run(run.id);
      markUnboundInstallationRecovery.run(run.installation_id);
    }
  }
  const quarantineRows = db.prepare(`
    SELECT evidence.id, evidence.installation_id, evidence.run_id,
      CASE WHEN EXISTS (
        SELECT 1 FROM verification_results duplicate
        WHERE duplicate.run_id = evidence.run_id
          AND duplicate.component_key = evidence.component_key
          AND duplicate.id != evidence.id
      ) THEN 'duplicate_run_component_quarantined'
      WHEN NOT EXISTS (SELECT 1 FROM reconcile_runs WHERE id = evidence.run_id)
        THEN 'orphan_run_quarantined'
      ELSE 'incomplete_verification_evidence_quarantined' END AS reason
    FROM verification_results evidence
    WHERE evidence.run_id IS NOT NULL AND (
      @repairedCriticalVerificationShape = 1
      OR
      EXISTS (
        SELECT 1 FROM verification_results duplicate
        WHERE duplicate.run_id = evidence.run_id
          AND duplicate.component_key = evidence.component_key
          AND duplicate.id != evidence.id
      )
      OR NOT EXISTS (SELECT 1 FROM reconcile_runs WHERE id = evidence.run_id)
      OR evidence.family = ''
      OR evidence.host_variant = ''
      OR evidence.adapter_version = ''
      OR evidence.catalog_version = ''
      OR evidence.verification_manifest_version = ''
      OR evidence.method = ''
      OR evidence.evidence_hash = ''
      OR evidence.verified_at = ''
      OR evidence.created_at = ''
      OR (evidence.result = 'verified' AND COALESCE(evidence.identity_assertion, '') = '')
      OR (evidence.result != 'verified' AND EXISTS (
        SELECT 1 FROM reconcile_runs bound_run
        WHERE bound_run.id = evidence.run_id AND bound_run.state = 'verified'
      ))
    )
  `).all({ repairedCriticalVerificationShape: repairedCriticalVerificationShape ? 1 : 0 }) as Array<{
    id: string; installation_id: string; run_id: string; reason: string
  }>;
  const affectedInstallations = new Set<string>();
  const quarantineEvidence = db.prepare(`
    UPDATE verification_results
    SET run_id = NULL, invalidated_at = COALESCE(invalidated_at, CURRENT_TIMESTAMP),
        invalidation_reason = COALESCE(invalidation_reason, ?)
    WHERE id = ?
  `);
  const staleLinkedComponents = db.prepare(`
    UPDATE installation_components
    SET verification_status = 'stale', verification_result_id = NULL
    WHERE verification_result_id = ?
    RETURNING installation_id
  `);
  const detachInstallationEvidence = db.prepare(`
    UPDATE agent_installations SET verification_result_id = NULL
    WHERE verification_result_id = ?
    RETURNING id
  `);
  const cancelUnsafeVerifiedRun = db.prepare(`
    UPDATE reconcile_runs
    SET state = 'cancelled', failure_code = 'incomplete_verification_evidence',
        failure_stage = 'verification_migration', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND state = 'verified'
  `);
  const markInstallationRecovery = db.prepare(`
    UPDATE agent_installations
    SET reconcile_state = 'needs_recovery', status_reason = 'verification_stale',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND desired_state = 'managed'
  `);
  for (const row of quarantineRows) {
    // Any ambiguous evidence invalidates a verified token. A verified run is
    // finalizer-only during startup recovery, so leaving it verified could
    // promote Artifacts without trustworthy evidence.
    if (cancelUnsafeVerifiedRun.run(row.run_id).changes > 0) {
      markInstallationRecovery.run(row.installation_id);
    }
    quarantineEvidence.run(row.reason, row.id);
    affectedInstallations.add(row.installation_id);
    for (const component of staleLinkedComponents.all(row.id) as Array<{ installation_id: string }>) {
      affectedInstallations.add(component.installation_id);
    }
    for (const installation of detachInstallationEvidence.all(row.id) as Array<{ id: string }>) {
      affectedInstallations.add(installation.id);
    }
  }
  // Also close an interrupted older repair where run_id had already been
  // added with NULL defaults before the process exited. Such a verified token
  // has no run-bound evidence and must never survive to startup finalization.
  const evidenceLessVerifiedRuns = db.prepare(`
    SELECT run.id, run.installation_id, run.operation_type,
           run.consent_envelope_id, run.prepared_plan_json
    FROM reconcile_runs run
    WHERE run.state = 'verified'
      AND NOT EXISTS (
        SELECT 1 FROM verification_results evidence
        WHERE evidence.run_id = run.id AND evidence.result = 'verified'
          AND evidence.invalidated_at IS NULL
      )
  `).all() as Array<{
    id: string
    installation_id: string | null
    operation_type: string
    consent_envelope_id: string | null
    prepared_plan_json: string
  }>;
  const cancelEvidenceLessRun = db.prepare(`
    UPDATE reconcile_runs
    SET state = 'cancelled', failure_code = 'verification_evidence_missing',
        failure_stage = 'verification_migration',
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND state = 'verified'
  `);
  const quarantineLinkedUnboundEvidence = db.prepare(`
    UPDATE verification_results
    SET invalidated_at = COALESCE(invalidated_at, CURRENT_TIMESTAMP),
        invalidation_reason = COALESCE(invalidation_reason, 'unbound_verified_run_quarantined')
    WHERE installation_id = ? AND run_id IS NULL AND invalidated_at IS NULL
      AND id IN (
        SELECT verification_result_id FROM installation_components
        WHERE installation_id = ? AND verification_result_id IS NOT NULL
        UNION
        SELECT verification_result_id FROM agent_installations
        WHERE id = ? AND verification_result_id IS NOT NULL
      )
  `);
  const staleUnboundComponents = db.prepare(`
    UPDATE installation_components
    SET verification_status = 'stale', verification_result_id = NULL
    WHERE installation_id = ? AND verification_result_id IN (
      SELECT id FROM verification_results
      WHERE installation_id = ? AND invalidation_reason = 'unbound_verified_run_quarantined'
    )
  `);
  const detachUnboundInstallationEvidence = db.prepare(`
    UPDATE agent_installations SET verification_result_id = NULL
    WHERE id = ? AND verification_result_id IN (
      SELECT id FROM verification_results
      WHERE installation_id = ? AND invalidation_reason = 'unbound_verified_run_quarantined'
    )
  `);
  for (const run of evidenceLessVerifiedRuns) {
    const safeDetachFinalizer = isEvidenceFreeDetachFinalizer(db, run);
    if (!safeDetachFinalizer) cancelEvidenceLessRun.run(run.id);
    if (!run.installation_id) continue;
    quarantineLinkedUnboundEvidence.run(
      run.installation_id, run.installation_id, run.installation_id,
    );
    staleUnboundComponents.run(run.installation_id, run.installation_id);
    detachUnboundInstallationEvidence.run(run.installation_id, run.installation_id);
    if (!safeDetachFinalizer) markInstallationRecovery.run(run.installation_id);
    affectedInstallations.add(run.installation_id);
  }
  const componentStatuses = db.prepare(`
    SELECT component_key, verification_status FROM installation_components
    WHERE installation_id = ? AND desired_state = 'managed'
  `);
  const updateInstallationSummary = db.prepare(`
    UPDATE agent_installations
    SET verified_capability = ?, verification_summary = ?
    WHERE id = ?
  `);
  for (const installationId of affectedInstallations) {
    const components = componentStatuses.all(installationId) as Array<{
      component_key: string; verification_status: string
    }>;
    const statuses = new Set(components.map(component => component.verification_status));
    const verified = new Set(components
      .filter(component => component.verification_status === 'verified')
      .map(component => component.component_key));
    const capability = verified.has('instruction') && verified.has('memory_tools') && verified.has('lifecycle')
      ? 4
      : verified.has('instruction') && verified.has('memory_tools')
        ? 3
        : verified.has('memory_tools') ? 2 : verified.has('instruction') ? 1 : 0;
    const summary = components.length === 0
      ? 'unverified'
      : statuses.size === 1 ? [...statuses][0] : 'mixed';
    updateInstallationSummary.run(capability, summary, installationId);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_verification_results_component
      ON verification_results(installation_id, component_key, verified_at);
    CREATE INDEX IF NOT EXISTS idx_verification_results_freshness
      ON verification_results(invalidated_at, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_results_run_component
      ON verification_results(run_id, component_key) WHERE run_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS trg_verification_results_run_insert
    BEFORE INSERT ON verification_results
    WHEN NEW.run_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM reconcile_runs WHERE id = NEW.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'verification run does not exist');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_verification_results_run_update
    BEFORE UPDATE OF run_id ON verification_results
    WHEN NEW.run_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM reconcile_runs WHERE id = NEW.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'verification run does not exist');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_reconcile_runs_verification_delete
    AFTER DELETE ON reconcile_runs
    BEGIN
      DELETE FROM verification_results WHERE run_id = OLD.id;
    END;
  `);
  }).immediate();
  db.prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(metadata.value AS INTEGER) < CAST(excluded.value AS INTEGER)
  `).run(
    AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY,
    String(AGENT_INTEGRATION_WRITER_PROTOCOL),
  );
  scrubPersistedAgentIntegrationEvents(db);
}
