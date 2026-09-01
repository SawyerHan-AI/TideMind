import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import Database from 'better-sqlite3'
import {
  AGENT_INTEGRATION_TABLES as AGENT_TABLES,
  AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY,
  AGENT_INTEGRATION_WRITER_PROTOCOL,
  ensureAgentIntegrationSchema,
} from '../../src/db/agent-integration-schema.js'
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema.js'

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all() as Array<{ name: string }>).map(row => row.name)
}

interface V33FixtureManifest {
  schemaVersion: number
  schemaSource: { gitCommit: string; path: string; builder: string }
  generation: { seedFile: string; seedSha256: string }
  artifact: {
    encodedFile: string
    compressedBytes: number
    compressedSha256: string
    sqliteBytes: number
    sqliteSha256: string
  }
}

interface PhysicalV33Fixture {
  db: Database.Database
  databasePath: string
  cleanup: () => void
}

interface LegacyV33Rows {
  agents: unknown[]
  modelConnections: unknown[]
  pendingDigests: unknown[]
  cliInvocations: unknown[]
}

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/db/', import.meta.url))
const V33_MANIFEST_PATH = path.join(FIXTURE_DIR, 'v33-authoritative.manifest.json')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function openAuthoritativeV33Fixture(): PhysicalV33Fixture {
  const manifest = JSON.parse(fs.readFileSync(V33_MANIFEST_PATH, 'utf8')) as V33FixtureManifest
  expect(manifest).toMatchObject({
    schemaVersion: 33,
    schemaSource: {
      gitCommit: '6a2792932e36e4d34fb915a546a76cb3f42928f3',
      path: 'src/db/schema.ts',
      builder: 'ensureSchema',
    },
  })
  const seedSql = fs.readFileSync(path.join(FIXTURE_DIR, manifest.generation.seedFile))
  expect(sha256(seedSql)).toBe(manifest.generation.seedSha256)
  const encoded = fs.readFileSync(path.join(FIXTURE_DIR, manifest.artifact.encodedFile), 'utf8')
  const compressed = Buffer.from(encoded.replace(/\s/gu, ''), 'base64')
  expect(compressed.byteLength).toBe(manifest.artifact.compressedBytes)
  expect(sha256(compressed)).toBe(manifest.artifact.compressedSha256)
  const sqlite = gunzipSync(compressed)
  expect(sqlite.byteLength).toBe(manifest.artifact.sqliteBytes)
  expect(sha256(sqlite)).toBe(manifest.artifact.sqliteSha256)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-v33-migration-'))
  const databasePath = path.join(root, 'brain-v33.sqlite')
  fs.writeFileSync(databasePath, sqlite, { flag: 'wx' })
  return {
    db: new Database(databasePath),
    databasePath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function legacyV33Rows(db: Database.Database): LegacyV33Rows {
  return {
    agents: db.prepare('SELECT * FROM agents ORDER BY id').all(),
    modelConnections: db.prepare('SELECT * FROM model_connections ORDER BY id').all(),
    pendingDigests: db.prepare('SELECT * FROM pending_digests ORDER BY id').all(),
    cliInvocations: db.prepare('SELECT * FROM cli_invocations ORDER BY id').all(),
  }
}

describe('migration v34 — local Agent managed persistence', () => {
  it('fresh schema creates every local-only table and protocol marker', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    expect(CURRENT_SCHEMA_VERSION).toBe(34)
    expect(tableNames(db)).toEqual(expect.arrayContaining([...AGENT_TABLES]))
    expect(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
      .toEqual({ value: '34' })
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY))
      .toEqual({ value: String(AGENT_INTEGRATION_WRITER_PROTOCOL) })
  })

  it('repairs pre-correlation apply-task items with an exact run foreign key and unique binding', () => {
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      db.exec(`
        DROP TABLE agent_integration_apply_task_items;
        CREATE TABLE agent_integration_apply_task_items (
          task_id TEXT NOT NULL REFERENCES agent_integration_apply_tasks(id) ON DELETE CASCADE,
          installation_id TEXT NOT NULL REFERENCES agent_installations(id),
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
      `)
      db.prepare(`
        INSERT INTO agent_installations (
          id, family, host_variant, install_key, display_name, created_at, updated_at
        ) VALUES ('old-v34-installation', 'zcode', 'zcode-desktop', 'old-v34', 'Old ZCode', ?, ?)
      `).run('2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z')
      db.prepare(`
        INSERT INTO agent_integration_apply_tasks (
          id, plan_hash, operation_type, state, started_at, updated_at
        ) VALUES ('old-v34-task', 'old-batch', 'connect', 'running', ?, ?)
      `).run('2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z')
      db.prepare(`
        INSERT INTO agent_integration_apply_task_items (
          task_id, installation_id, ordinal, execution_plan_hash, state, started_at, updated_at
        ) VALUES ('old-v34-task', 'old-v34-installation', 0, 'old-execution', 'running', ?, ?)
      `).run('2026-08-25T00:00:01.000Z', '2026-08-25T00:00:01.000Z')

      ensureAgentIntegrationSchema(db)

      expect(db.prepare(`PRAGMA table_info(agent_integration_apply_task_items)`).all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'run_id' })]))
      expect(db.prepare(`PRAGMA foreign_key_list(agent_integration_apply_task_items)`).all())
        .toEqual(expect.arrayContaining([expect.objectContaining({
          table: 'reconcile_runs', from: 'run_id', to: 'id', on_delete: 'SET NULL',
        })]))
      expect(db.prepare(`PRAGMA index_list(agent_integration_apply_task_items)`).all())
        .toEqual(expect.arrayContaining([expect.objectContaining({
          name: 'idx_agent_integration_apply_task_items_run', unique: 1, partial: 1,
        }), expect.objectContaining({
          name: 'idx_agent_integration_apply_task_items_legacy_null', unique: 0, partial: 1,
        })]))
      expect(db.prepare(`PRAGMA index_list(reconcile_runs)`).all())
        .toEqual(expect.arrayContaining([expect.objectContaining({
          name: 'idx_reconcile_runs_legacy_correlation', unique: 0, partial: 0,
        })]))
      expect(db.prepare(`
        SELECT installation_id, execution_plan_hash, state, run_id
        FROM agent_integration_apply_task_items WHERE task_id = 'old-v34-task'
      `).get()).toEqual({
        installation_id: 'old-v34-installation',
        execution_plan_hash: 'old-execution',
        state: 'running',
        run_id: null,
      })
    } finally {
      db.close()
    }
  })

  it('upgrades the authoritative physical v33 fixture, preserves legacy data, and reopens idempotently', () => {
    const fixture = openAuthoritativeV33Fixture()
    let db = fixture.db
    try {
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
        .toEqual({ value: '33' })
      expect(tableNames(db).filter(table => (AGENT_TABLES as readonly string[]).includes(table)))
        .toEqual([])
      const legacyRowsBeforeMigration = legacyV33Rows(db)
      expect(db.prepare(`SELECT * FROM agents WHERE id = 'legacy-agent-cursor'`).get()).toEqual({
        id: 'legacy-agent-cursor',
        name: 'Legacy Cursor Work',
        tool_type: 'cursor',
        archived: 0,
        last_active: '2026-07-29T09:30:00.000Z',
        created: '2026-07-01T00:00:00.000Z',
      })

      ensureSchema(db)

      expect(legacyV33Rows(db)).toEqual(legacyRowsBeforeMigration)
      expect(db.prepare("SELECT id, name, tool_type FROM agents WHERE id = 'legacy-agent-cursor'").get())
        .toEqual({ id: 'legacy-agent-cursor', name: 'Legacy Cursor Work', tool_type: 'cursor' })
      expect(db.prepare(`
        SELECT id, provider_type, status, cli_version, auth_method, candidate_models
        FROM model_connections WHERE id = 'legacy-model-codex'
      `).get()).toEqual({
        id: 'legacy-model-codex',
        provider_type: 'codex-cli',
        status: 'ready',
        cli_version: '0.145.0',
        auth_method: 'chatgpt',
        candidate_models: '["gpt-5"]',
      })
      expect(db.prepare(`
        SELECT id, trace_id, status, retry_count, ambiguous_invocation_id
        FROM pending_digests WHERE id = 'legacy-queue-digest'
      `).get()).toEqual({
        id: 'legacy-queue-digest',
        trace_id: 'trace-v33',
        status: 'ambiguous',
        retry_count: 2,
        ambiguous_invocation_id: 'legacy-invocation-1',
      })
      expect(db.prepare(`
        SELECT id, connection_id, prompt_committed, outcome, resolution
        FROM cli_invocations WHERE id = 'legacy-invocation-1'
      `).get()).toEqual({
        id: 'legacy-invocation-1',
        connection_id: 'legacy-model-codex',
        prompt_committed: 1,
        outcome: 'ambiguous',
        resolution: 'process_exit_after_prompt',
      })
      for (const table of AGENT_TABLES) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get(), table)
          .toEqual({ count: table === 'agent_integration_apply_task_feed_state' ? 1 : 0 })
      }
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
        .toEqual({ value: '34' })
      expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
        .get(AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY))
        .toEqual({ value: String(AGENT_INTEGRATION_WRITER_PROTOCOL) })
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])

      db.close()
      db = new Database(fixture.databasePath)
      expect(() => ensureSchema(db)).not.toThrow()
      expect(() => ensureSchema(db)).not.toThrow()
      expect(legacyV33Rows(db)).toEqual(legacyRowsBeforeMigration)
      expect(db.prepare("SELECT name FROM agents WHERE id = 'legacy-agent-cursor'").get())
        .toEqual({ name: 'Legacy Cursor Work' })
      expect(db.prepare("SELECT status FROM pending_digests WHERE id = 'legacy-queue-digest'").get())
        .toEqual({ status: 'ambiguous' })
      for (const table of AGENT_TABLES) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get(), table)
          .toEqual({ count: table === 'agent_integration_apply_task_feed_state' ? 1 : 0 })
      }
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally {
      if (db.open) db.close()
      fixture.cleanup()
    }
  })

  it('schema DDL rolls back as one transaction and can be retried', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const failingMigration = db.transaction(() => {
      ensureAgentIntegrationSchema(db)
      throw new Error('simulated migration failure')
    })

    expect(() => failingMigration()).toThrow(/simulated migration failure/)
    expect(tableNames(db)).not.toContain('agent_installations')
    expect(db.prepare('SELECT COUNT(*) AS count FROM metadata').get()).toEqual({ count: 0 })

    expect(() => db.transaction(() => ensureAgentIntegrationSchema(db))()).not.toThrow()
    expect(tableNames(db)).toEqual(expect.arrayContaining([...AGENT_TABLES]))
  })

  it('increments the task-feed revision atomically and preserves exact 64-bit text reads', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const revision = () => (db.prepare(`
      SELECT CAST(revision AS TEXT) AS revision
      FROM agent_integration_apply_task_feed_state WHERE singleton = 1
    `).get() as { revision: string }).revision
    expect(revision()).toBe('0')

    const rolledBack = db.transaction(() => {
      db.prepare(`
        INSERT INTO agent_integration_apply_tasks (
          id, plan_hash, operation_type, state, started_at, updated_at
        ) VALUES ('rolled-back-task', 'plan', 'connect', 'running', ?, ?)
      `).run('2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')
      throw new Error('rollback feed write')
    })
    expect(() => rolledBack()).toThrow('rollback feed write')
    expect(revision()).toBe('0')

    db.prepare(`UPDATE agent_integration_apply_task_feed_state SET revision = ? WHERE singleton = 1`)
      .run(9_007_199_254_740_993n)
    expect(revision()).toBe('9007199254740993')
    db.prepare(`
      INSERT INTO agent_integration_apply_tasks (
        id, plan_hash, operation_type, state, started_at, updated_at
      ) VALUES ('durable-task', 'plan', 'connect', 'running', ?, ?)
    `).run('2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')
    expect(revision()).toBe('9007199254740994')
  })

  it('repairs an empty partial task-feed token and rejects populated ambiguous state', () => {
    const repaired = new Database(':memory:')
    repaired.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agent_integration_apply_task_feed_state (singleton INTEGER);
    `)
    expect(() => ensureAgentIntegrationSchema(repaired)).not.toThrow()
    expect(repaired.prepare(`PRAGMA table_info(agent_integration_apply_task_feed_state)`).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'singleton', pk: 1 }),
        expect.objectContaining({ name: 'revision', notnull: 1 }),
      ]))
    expect(repaired.prepare(`SELECT singleton, CAST(revision AS TEXT) AS revision
      FROM agent_integration_apply_task_feed_state`).all()).toEqual([{ singleton: 1, revision: '0' }])

    const unsafe = new Database(':memory:')
    unsafe.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agent_integration_apply_task_feed_state (singleton INTEGER);
      INSERT INTO agent_integration_apply_task_feed_state(singleton) VALUES (1);
    `)
    expect(() => ensureAgentIntegrationSchema(unsafe))
      .toThrow('unsafe partial task feed revision table contains rows')
    expect(unsafe.prepare(`SELECT singleton FROM agent_integration_apply_task_feed_state`).all())
      .toEqual([{ singleton: 1 }])
  })

  it('authoritatively repairs missing, wrong-body, and wrong-WHEN task-feed triggers across restart', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.exec(`
      DROP TRIGGER trg_agent_apply_tasks_feed_insert;
      DROP TRIGGER trg_agent_apply_tasks_feed_update;
      CREATE TRIGGER trg_agent_apply_tasks_feed_update
        AFTER UPDATE ON agent_integration_apply_tasks BEGIN SELECT 1; END;
      DROP TRIGGER trg_agent_connect_runs_feed_insert;
      CREATE TRIGGER trg_agent_connect_runs_feed_insert
        AFTER INSERT ON reconcile_runs WHEN NEW.operation_type = 'disconnect' BEGIN
          UPDATE agent_integration_apply_task_feed_state SET revision = revision + 1 WHERE singleton = 1;
        END;
    `)

    ensureAgentIntegrationSchema(db)
    ensureAgentIntegrationSchema(db)
    const triggers = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_agent_%_feed_%'
      ORDER BY name
    `).all() as Array<{ name: string; sql: string }>
    expect(triggers).toHaveLength(9)
    expect(triggers.find(trigger => trigger.name === 'trg_agent_apply_tasks_feed_update')?.sql)
      .toContain('SET revision = revision + 1')
    expect(triggers.find(trigger => trigger.name === 'trg_agent_connect_runs_feed_insert')?.sql)
      .toContain("WHEN NEW.operation_type = 'connect'")

    const revision = () => Number((db.prepare(`
      SELECT revision FROM agent_integration_apply_task_feed_state WHERE singleton = 1
    `).get() as { revision: number }).revision)
    const before = revision()
    db.prepare(`
      INSERT INTO agent_integration_apply_tasks (
        id, plan_hash, operation_type, state, started_at, updated_at
      ) VALUES ('trigger-repair-task', 'plan', 'connect', 'running', ?, ?)
    `).run('2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')
    db.prepare(`UPDATE agent_integration_apply_tasks SET updated_at = ? WHERE id = ?`)
      .run('2026-08-26T00:00:01.000Z', 'trigger-repair-task')
    db.prepare(`
      INSERT INTO reconcile_runs (
        id, operation_type, execution_plan_hash, recovery_strategy, created_at, updated_at
      ) VALUES ('trigger-repair-run', 'connect', 'plan', 'resume', ?, ?)
    `).run('2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')
    expect(revision()).toBe(before + 3)
  })

  it('rolls authoritative feed-trigger repair back atomically and can retry it', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.exec(`
      DROP TRIGGER trg_agent_apply_tasks_feed_update;
      CREATE TRIGGER trg_agent_apply_tasks_feed_update
        AFTER UPDATE ON agent_integration_apply_tasks BEGIN SELECT 1; END;
    `)
    const repairThenFail = db.transaction(() => {
      ensureAgentIntegrationSchema(db)
      throw new Error('rollback trigger repair')
    })
    expect(() => repairThenFail()).toThrow('rollback trigger repair')
    expect((db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'trg_agent_apply_tasks_feed_update'`)
      .get() as { sql: string }).sql).toContain('SELECT 1')

    expect(() => ensureAgentIntegrationSchema(db)).not.toThrow()
    expect((db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'trg_agent_apply_tasks_feed_update'`)
      .get() as { sql: string }).sql).toContain('SET revision = revision + 1')
  })

  it('repairs a missing/invalid minimum protocol without downgrading a newer protocol', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value)
      VALUES ('agent_integration_minimum_writer_protocol', 'invalid');
    `)
    ensureAgentIntegrationSchema(db)
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY)).toEqual({ value: '1' })

    db.prepare('UPDATE metadata SET value = ? WHERE key = ?')
      .run('3', AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY)
    ensureAgentIntegrationSchema(db)
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY)).toEqual({ value: '3' })
  })

  it('repairs a pre-release writer fence table with the durable scope cutover column', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE writer_fences (
        mutation_domain TEXT PRIMARY KEY,
        minimum_writer_protocol INTEGER NOT NULL DEFAULT 1,
        writer_generation INTEGER NOT NULL DEFAULT 0,
        owner_instance_id TEXT,
        epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        state TEXT NOT NULL DEFAULT 'released',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    ensureAgentIntegrationSchema(db)
    const columns = db.prepare(`PRAGMA table_info(writer_fences)`).all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toContain('scope_mode')
    expect(db.prepare(`
      SELECT dflt_value FROM pragma_table_info('writer_fences') WHERE name = 'scope_mode'
    `).get()).toEqual({ dflt_value: "'legacy'" })
  })

  it('repairs a pre-CAS mutation journal with a zero version baseline', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.exec('ALTER TABLE projection_mutations DROP COLUMN journal_version')

    ensureAgentIntegrationSchema(db)

    expect(db.prepare(`
      SELECT dflt_value, "notnull" AS required FROM pragma_table_info('projection_mutations')
      WHERE name = 'journal_version'
    `).get()).toEqual({ dflt_value: '0', required: 1 })
  })

  it('repairs a partial verification table before creating the run/component index', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE verification_results (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        component_key TEXT NOT NULL,
        artifact_hash TEXT,
        verified_at TEXT
      );
    `)

    expect(() => ensureAgentIntegrationSchema(db)).not.toThrow()
    const columns = db.prepare(`PRAGMA table_info(verification_results)`).all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toContain('run_id')
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_verification_results_run_component'))
      .toEqual({ name: 'idx_verification_results_run_component' })
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(verification_results)`).all() as Array<{
      table: string; from: string; to: string; on_delete: string
    }>
    expect(foreignKeys.map(key => `${key.table}:${key.from}:${key.to}:${key.on_delete}`).sort())
      .toEqual([
        'installation_components:component_key:component_key:CASCADE',
        'installation_components:installation_id:installation_id:CASCADE',
        'reconcile_runs:run_id:id:CASCADE',
      ])
    expect(() => db.prepare(`
      INSERT INTO verification_results (id, run_id, installation_id, component_key)
      VALUES ('orphan', 'missing-run', 'i1', 'memory_tools')
    `).run()).toThrow(/verification run does not exist/)
  })

  it('fails closed for a populated partial verification table without authoritative foreign keys', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE verification_results (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        component_key TEXT NOT NULL,
        verified_at TEXT
      );
      INSERT INTO verification_results (id, installation_id, component_key, verified_at)
      VALUES ('untrusted', 'missing-installation', 'memory_tools', '2026-08-25T00:00:00.000Z');
    `)

    expect(() => ensureAgentIntegrationSchema(db))
      .toThrow(/unsafe partial verification_results schema contains rows/)
    expect(db.prepare(`SELECT id FROM verification_results`).all()).toEqual([{ id: 'untrusted' }])
  })

  it('fails closed on ambiguous populated pre-release evidence without authoritative foreign keys', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE verification_results (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        installation_id TEXT NOT NULL,
        component_key TEXT NOT NULL,
        verified_at TEXT,
        invalidated_at TEXT,
        invalidation_reason TEXT,
        expires_at TEXT
      );
      INSERT INTO verification_results (
        id, run_id, installation_id, component_key, verified_at
      ) VALUES
        ('e1', 'run-1', 'i1', 'memory_tools', '2026-08-25T00:00:00.000Z'),
        ('e2', 'run-1', 'i1', 'memory_tools', '2026-08-25T00:01:00.000Z');
    `)

    expect(() => ensureAgentIntegrationSchema(db))
      .toThrow(/unsafe partial verification_results schema contains rows/)
    expect(db.prepare(`
      SELECT run_id, invalidation_reason FROM verification_results ORDER BY id
    `).all()).toEqual([
      { run_id: 'run-1', invalidation_reason: null },
      { run_id: 'run-1', invalidation_reason: null },
    ])
  })

  it('fails closed on an orphaned populated pre-release reference without authoritative foreign keys', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE verification_results (
        id TEXT PRIMARY KEY, run_id TEXT, installation_id TEXT NOT NULL,
        component_key TEXT NOT NULL, verified_at TEXT, invalidated_at TEXT,
        invalidation_reason TEXT, expires_at TEXT
      );
      INSERT INTO verification_results (
        id, run_id, installation_id, component_key, verified_at
      ) VALUES ('orphan', 'missing-run', 'i1', 'memory_tools', '2026-08-25T00:00:00.000Z');
    `)

    expect(() => ensureAgentIntegrationSchema(db))
      .toThrow(/unsafe partial verification_results schema contains rows/)
    expect(db.prepare(`
      SELECT run_id, invalidation_reason FROM verification_results WHERE id = 'orphan'
    `).get()).toEqual({ run_id: 'missing-run', invalidation_reason: null })
  })

  it('quarantines incomplete repaired evidence and cancels a verified run without replay', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const now = '2026-08-25T00:00:00.000Z'
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, display_name, desired_state,
        reconcile_state, created_at, updated_at
      ) VALUES ('i1', 'cursor', 'cursor-desktop', 'cursor:i1', 'Cursor', 'managed',
        'verifying', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, verification_status,
        created_at, updated_at
      ) VALUES ('i1', 'memory_tools', 'managed', 'verified', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, state,
        recovery_strategy, created_at, updated_at
      ) VALUES ('run-verified', 'i1', 'connect', 'plan', 'verified',
        'read_back_then_resume', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO verification_results (
        id, run_id, installation_id, component_key, family, host_variant,
        runtime_realm, adapter_version, catalog_version,
        verification_manifest_version, method, result, evidence_hash,
        verified_at, created_at
      ) VALUES ('partial', 'run-verified', 'i1', 'memory_tools', '', '',
        'local_macos', '', '', '', '', 'failed', '', '', '')
    `).run()
    db.prepare(`UPDATE installation_components SET verification_result_id = 'partial' WHERE installation_id = 'i1'`).run()
    db.prepare(`UPDATE agent_installations SET verification_result_id = 'partial' WHERE id = 'i1'`).run()

    ensureAgentIntegrationSchema(db)

    expect(db.prepare(`
      SELECT run_id, invalidation_reason FROM verification_results WHERE id = 'partial'
    `).get()).toEqual({
      run_id: null,
      invalidation_reason: 'incomplete_verification_evidence_quarantined',
    })
    expect(db.prepare(`
      SELECT state, failure_code, failure_stage FROM reconcile_runs WHERE id = 'run-verified'
    `).get()).toEqual({
      state: 'cancelled',
      failure_code: 'incomplete_verification_evidence',
      failure_stage: 'verification_migration',
    })
    expect(db.prepare(`
      SELECT verified_capability, verification_summary, reconcile_state, verification_result_id
      FROM agent_installations WHERE id = 'i1'
    `).get()).toEqual({
      verified_capability: 0,
      verification_summary: 'stale',
      reconcile_state: 'needs_recovery',
      verification_result_id: null,
    })
  })

  it('quarantines existing evidence when a critical column was repaired with a plausible default', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const now = '2026-08-25T00:00:00.000Z'
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, display_name, desired_state,
        reconcile_state, created_at, updated_at
      ) VALUES ('i1', 'cursor', 'cursor-desktop', 'cursor:i1', 'Cursor', 'managed',
        'verifying', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, verification_status,
        created_at, updated_at
      ) VALUES ('i1', 'memory_tools', 'managed', 'verified', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, state,
        recovery_strategy, created_at, updated_at
      ) VALUES ('run-verified', 'i1', 'connect', 'plan', 'verified',
        'read_back_then_resume', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO verification_results (
        id, run_id, installation_id, component_key, family, host_variant,
        runtime_realm, adapter_version, catalog_version,
        verification_manifest_version, method, result, evidence_hash,
        invalidation_keys_json, verified_at, created_at
      ) VALUES ('legacy', 'run-verified', 'i1', 'memory_tools', 'cursor', 'cursor-desktop',
        'remote_worker', '1', '1', '1', 'adapter_verification', 'verified',
        'evidence', '[]', ?, ?)
    `).run(now, now)
    db.exec(`DROP INDEX IF EXISTS idx_verification_results_run_component`)
    db.exec(`ALTER TABLE verification_results DROP COLUMN runtime_realm`)

    ensureAgentIntegrationSchema(db)

    expect(db.prepare(`
      SELECT runtime_realm, run_id, invalidation_reason
      FROM verification_results WHERE id = 'legacy'
    `).get()).toEqual({
      runtime_realm: 'local_macos',
      run_id: null,
      invalidation_reason: 'incomplete_verification_evidence_quarantined',
    })
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-verified'`).get())
      .toEqual({ state: 'cancelled' })
  })

  it('cancels an interrupted-repair verified token with no run-bound evidence', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const now = '2026-08-25T00:00:00.000Z'
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, display_name, desired_state,
        reconcile_state, created_at, updated_at
      ) VALUES ('i1', 'cursor', 'cursor-desktop', 'cursor:i1', 'Cursor', 'managed',
        'verifying', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, verification_status,
        created_at, updated_at
      ) VALUES ('i1', 'memory_tools', 'managed', 'verified', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, state,
        recovery_strategy, created_at, updated_at
      ) VALUES ('run-unbound', 'i1', 'connect', 'plan', 'verified',
        'read_back_then_resume', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO verification_results (
        id, installation_id, component_key, family, host_variant, runtime_realm,
        adapter_version, catalog_version, verification_manifest_version, method,
        identity_assertion, result, evidence_hash, verified_at, created_at
      ) VALUES ('old-unbound', 'i1', 'memory_tools', 'cursor', 'cursor-desktop',
        'local_macos', '1', '1', '1', 'adapter_verification', 'agent-i1',
        'verified', 'evidence', ?, ?)
    `).run(now, now)
    db.prepare(`
      UPDATE installation_components
      SET verification_result_id = 'old-unbound' WHERE installation_id = 'i1'
    `).run()
    db.prepare(`
      UPDATE agent_installations
      SET verification_result_id = 'old-unbound', verified_capability = 2,
          verification_summary = 'verified' WHERE id = 'i1'
    `).run()

    ensureAgentIntegrationSchema(db)

    expect(db.prepare(`
      SELECT state, failure_code FROM reconcile_runs WHERE id = 'run-unbound'
    `).get()).toEqual({ state: 'cancelled', failure_code: 'verification_evidence_missing' })
    expect(db.prepare(`
      SELECT run_id, invalidation_reason FROM verification_results WHERE id = 'old-unbound'
    `).get()).toEqual({
      run_id: null,
      invalidation_reason: 'unbound_verified_run_quarantined',
    })
    expect(db.prepare(`
      SELECT verified_capability, verification_summary, reconcile_state, verification_result_id
      FROM agent_installations WHERE id = 'i1'
    `).get()).toEqual({
      verified_capability: 0,
      verification_summary: 'stale',
      reconcile_state: 'needs_recovery',
      verification_result_id: null,
    })
  })

  it('preserves only an exactly-bound committed detach-only verified finalizer without evidence', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const now = '2026-08-25T00:00:00.000Z'
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, display_name, agent_id, desired_state,
        tombstoned_at, reconcile_state, created_at, updated_at
      ) VALUES ('i-detach', 'cursor', 'cursor-desktop', 'cursor:detach', 'Cursor',
        'agent-detach', 'removed', ?, 'verifying', ?, ?)
    `).run(now, now, now)
    db.prepare(`
      INSERT INTO agent_consents (
        id, installation_id, policy_version, selector_schema_version,
        maximum_risk, confirmed_at, created_at
      ) VALUES ('consent-detach', 'i-detach', '1', '1', 'low', ?, ?)
    `).run(now, now)
    db.prepare(`
      UPDATE agent_installations SET consent_envelope_id = 'consent-detach'
      WHERE id = 'i-detach'
    `).run()
    db.prepare(`
      INSERT INTO managed_artifacts (
        id, runtime_realm, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, state, created_at, updated_at
      ) VALUES ('artifact-detach', 'local_macos', 'mcp', '/tmp/shared', 'document',
        'local_macos:file:/tmp/shared:document', '1', '1', 'healthy', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, verification_status, artifact_id,
        tombstoned_at, consent_envelope_id, created_at, updated_at
      ) VALUES ('i-detach', 'memory_tools', 'removed', 'unverified', 'artifact-detach',
        ?, 'consent-detach', ?, ?)
    `).run(now, now, now)
    db.prepare(`
      INSERT INTO artifact_consumers (
        artifact_id, installation_id, component_key, desired_state,
        tombstoned_at, consent_envelope_id, state, added_at, updated_at
      ) VALUES ('artifact-detach', 'i-detach', 'memory_tools', 'removal_pending',
        ?, 'consent-detach', 'removal_pending', ?, ?)
    `).run(now, now, now)
    db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, consent_envelope_id, state,
        recovery_strategy, prepared_plan_json, created_at, updated_at
      ) VALUES ('run-detach', 'i-detach', 'disconnect', 'plan', 'consent-detach', 'verified',
        'read_back_then_resume', '{"componentKeys":["memory_tools"]}', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO projection_mutations (
        id, run_id, operation_id, installation_id, component_key, artifact_id,
        mutation_domain, target, idempotency_strategy, readback_strategy,
        state, created_at, updated_at
      ) VALUES ('mutation-detach', 'run-detach', 'detach-memory', 'i-detach',
        'memory_tools', 'artifact-detach', 'local_macos:file:/tmp/shared:document', '/tmp/shared',
        'consumer_detach_only', 'consumer_scope', 'committed', ?, ?)
    `).run(now, now)

    ensureAgentIntegrationSchema(db)

    expect(db.prepare(`SELECT state, failure_code FROM reconcile_runs WHERE id = 'run-detach'`).get())
      .toEqual({ state: 'verified', failure_code: null })

    db.prepare(`
      INSERT INTO agent_consents (
        id, installation_id, policy_version, selector_schema_version, maximum_risk,
        status, confirmed_at, revoked_at, created_at
      ) VALUES ('consent-detach-old', 'i-detach', '1', '1', 'low',
        'revoked', ?, ?, ?)
    `).run(now, now, now)
    db.prepare(`
      INSERT INTO managed_artifacts (
        id, runtime_realm, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, state, created_at, updated_at
      ) VALUES ('artifact-detach-old', 'local_macos', 'mcp', '/tmp/shared-old', 'document',
        'local_macos:file:/tmp/shared-old:document', '1', '1', 'healthy', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO artifact_consumers (
        artifact_id, installation_id, component_key, desired_state,
        tombstoned_at, consent_envelope_id, state, added_at, updated_at
      ) VALUES ('artifact-detach-old', 'i-detach', 'memory_tools', 'removal_pending',
        ?, 'consent-detach-old', 'removal_pending', ?, ?)
    `).run(now, now, now)
    ensureAgentIntegrationSchema(db)
    expect(db.prepare(`SELECT state, failure_code FROM reconcile_runs WHERE id = 'run-detach'`).get())
      .toEqual({ state: 'cancelled', failure_code: 'verification_evidence_missing' })

    db.prepare(`DELETE FROM artifact_consumers WHERE artifact_id = 'artifact-detach-old'`).run()
    db.prepare(`DELETE FROM managed_artifacts WHERE id = 'artifact-detach-old'`).run()
    db.prepare(`DELETE FROM agent_consents WHERE id = 'consent-detach-old'`).run()
    db.prepare(`
      UPDATE reconcile_runs SET state = 'verified', failure_code = NULL WHERE id = 'run-detach'
    `).run()
    db.prepare(`UPDATE projection_mutations SET installation_id = NULL WHERE id = 'mutation-detach'`).run()
    ensureAgentIntegrationSchema(db)
    expect(db.prepare(`SELECT state, failure_code FROM reconcile_runs WHERE id = 'run-detach'`).get())
      .toEqual({ state: 'cancelled', failure_code: 'verification_evidence_missing' })

    db.prepare(`
      UPDATE reconcile_runs SET state = 'verified', failure_code = NULL WHERE id = 'run-detach'
    `).run()
    db.prepare(`
      UPDATE projection_mutations
      SET installation_id = 'i-detach', artifact_id = NULL WHERE id = 'mutation-detach'
    `).run()
    ensureAgentIntegrationSchema(db)
    expect(db.prepare(`SELECT state, failure_code FROM reconcile_runs WHERE id = 'run-detach'`).get())
      .toEqual({ state: 'cancelled', failure_code: 'verification_evidence_missing' })
  })

  it('does not downgrade a legitimate mixed installation during an idempotent ensure', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const now = '2026-08-25T00:00:00.000Z'
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, display_name, desired_state,
        verified_capability, verification_summary, created_at, updated_at
      ) VALUES ('mixed', 'cursor', 'cursor-desktop', 'cursor:mixed', 'Cursor',
        'managed', 1, 'mixed', ?, ?)
    `).run(now, now)
    const insertComponent = db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, verification_status,
        created_at, updated_at
      ) VALUES ('mixed', ?, 'managed', ?, ?, ?)
    `)
    insertComponent.run('instruction', 'verified', now, now)
    insertComponent.run('memory_tools', 'stale', now, now)

    ensureAgentIntegrationSchema(db)

    expect(db.prepare(`
      SELECT verified_capability, verification_summary FROM agent_installations WHERE id = 'mixed'
    `).get()).toEqual({ verified_capability: 1, verification_summary: 'mixed' })
  })

  it('is idempotent and keeps canonical identity, state and foreign-key constraints active', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    expect(() => ensureSchema(db)).not.toThrow()
    const now = '2026-08-25T00:00:00.000Z'
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, runtime_realm, install_key, provenance,
        display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('i1', 'cursor', 'cursor-desktop', 'local_macos', 'cursor:default', 'bundle', 'Cursor', now, now)

    expect(() => db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, runtime_realm, install_key, provenance,
        display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('i2', 'cursor', 'cursor-desktop', 'local_macos', 'cursor:default', 'bundle', 'Cursor 2', now, now))
      .toThrow(/UNIQUE constraint failed/)
    expect(() => db.prepare(`
      UPDATE agent_installations SET desired_state = 'invalid' WHERE id = 'i1'
    `).run()).toThrow(/CHECK constraint failed/)
    expect(() => db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, created_at, updated_at
      ) VALUES ('missing', 'memory_tools', ?, ?)
    `).run(now, now)).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('does not enroll local Agent tables into cloud dirty triggers', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const triggers = db.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
    `).all() as Array<{ name: string; sql: string }>
    const cloudTriggers = triggers.filter(trigger => trigger.sql.includes('cloud_dirty'))
    for (const table of AGENT_TABLES) {
      expect(cloudTriggers.some(trigger => trigger.sql.includes(table)), table).toBe(false)
    }
    const now = '2026-08-25T00:00:00.000Z'
    db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, install_key, provenance, display_name, created_at, updated_at
      ) VALUES ('i1', 'cursor', 'cursor-desktop', 'cursor', 'bundle', 'Cursor', ?, ?)
    `).run(now, now)
    expect(db.prepare('SELECT COUNT(*) AS count FROM cloud_dirty').get()).toEqual({ count: 0 })
  })
})
