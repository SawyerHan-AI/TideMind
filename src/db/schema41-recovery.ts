import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import contract from './schema41-contract.js';

export const RECOVERY_LINEAGE = 'stable-0.2.94';

function reject(reason: string): never {
  throw Object.assign(new Error(`schema41 自动恢复已停止：${reason}。原数据库保持不变。`), { code: 'DATABASE_RECOVERY_REQUIRED' });
}

function fingerprint(sql: string): string {
  return createHash('sha256').update(sql.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim()).digest('hex');
}

// This recovery handles the observed dormant branch, not arbitrary historical
// runtime state. Nonempty legacy work/history requires a separate reviewed map;
// do not guess terminal semantics or delete rows to satisfy the predicate.
const DORMANT_TABLES = [
  'workflow_runs', 'workflow_inputs', 'run_attempts', 'task_runs', 'work_items',
  'foreground_commands', 'foreground_pending_projection', 'mutation_journal',
  'initialization_overlays', 'graph_projection_head', 'overlay_compaction_checkpoints',
  'maintenance_intents', 'source_retry_items', 'llm_invocation_attempts',
  'recovery_barriers', 'recovery_actions', 'recovery_episodes', 'recovery_reports',
  'recovery_control_commands', 'timeline_outbox', 'artifact_contributions',
  'change_feed', 'runtime_instances', 'runtime_shutdowns', 'runtime_status',
  'source_status_projection', 'source_workflow_status', 'task_scope_generations',
  'graph_scope_generations', 'ai_service_status', 'foreground_queue_status',
] as const;

/** No writes; call again while holding the migration lock before changing DDL. */
export function assertRecoverableSchema41(db: Database.Database): void {
  const version = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (version?.value !== '41') reject('来源版本不是41');
  const actual = db.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{ type: string; name: string; tableName: string; sql: string }>;
  const expected = contract as Record<string, { type: string; table: string; sha256: string; optional: boolean }>;
  const byName = new Map(actual.map(o => [o.name, o]));
  for (const [name, requirement] of Object.entries(expected)) {
    const found = byName.get(name);
    if (!found && requirement.optional) continue;
    if (!found || found.type !== requirement.type || found.tableName !== requirement.table || fingerprint(found.sql) !== requirement.sha256) reject(`结构不匹配：${name}`);
  }
  for (const found of actual) {
    if (found.name.startsWith('sqlite_')) continue;
    if (!expected[found.name]) reject(`未识别结构：${found.name}`);
  }
  for (const table of DORMANT_TABLES) {
    if (db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) reject(`历史后台表非空：${table}`);
  }
  const capabilities = db.prepare('SELECT * FROM background_schema_capabilities').all() as Array<Record<string, unknown>>;
  const cap = capabilities[0];
  if (capabilities.length !== 1 || cap.singleton_id !== 1 || cap.protocol_version !== 1 || cap.scheduler_worker_enabled !== 0 || cap.graph_write_guard_enabled !== 0 || cap.recovery_barrier !== 0 || cap.recovery_reason !== null) reject('历史后台协议未休眠');
  const lanes = db.prepare('SELECT * FROM mutation_lane').all() as Array<Record<string, unknown>>;
  const lane = lanes[0];
  if (lanes.length !== 1 || lane.singleton_id !== 1 || ['leader_instance_id','leader_epoch','current_owner_instance','workflow_run_id','attempt_id','fencing_token','lease_expires_at','heartbeat_at','user_cancel_requested_at','shutdown_requested_at'].some(k => lane[k] !== null)) reject('历史写入所有权未释放');
  const leaders = db.prepare('SELECT * FROM runtime_leader').all() as Array<Record<string, unknown>>;
  if (leaders.length !== 1 || leaders[0].singleton_id !== 1 || leaders[0].protocol_version !== 1 || leaders[0].leader_instance_id !== null) reject('历史leader未释放');
}

/** Additive conversion only; caller owns backup, exclusion and version commit. */
export function addRecoveryAuthColumns(db: Database.Database): void {
  for (const [name, type] of [
    ['last_known_scope_key', 'TEXT'], ['last_known_epoch', 'INTEGER'],
    ['last_known_cli_generation', 'TEXT'], ['last_known_auth_method', 'TEXT'],
  ]) {
    const columns = db.prepare('PRAGMA table_info(llm_connection_auth_bindings)').all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE llm_connection_auth_bindings ADD COLUMN ${name} ${type}`);
  }
}
