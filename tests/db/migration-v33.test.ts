import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema.js';
import { ensurePendingDigestsV33 } from '../../src/db/migration-helpers.js';
import {
  acquireCliCapacityLease,
  renewCliCapacityLease,
  releaseCliCapacityLease,
} from '../../src/llm/cli/capacity-lease.js';
import {
  finishCliInvocation,
  startCliInvocation,
} from '../../src/llm/cli/invocation-state.js';
import {
  createConnection,
  getConnection,
  updateCliConnectionEnvironment,
  updateConnection,
} from '../../src/db/connections.js';

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map(row => row.name);
}

function makeV32Database(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  db.exec(`
    DROP INDEX IF EXISTS idx_llm_usage_connection;
    DROP INDEX IF EXISTS idx_llm_usage_source;
    DROP TABLE llm_usage_log;
    CREATE TABLE llm_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      operation TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      thinking_tokens INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      created TEXT NOT NULL
    );
    INSERT INTO llm_usage_log (
      model, operation, input_tokens, output_tokens, thinking_tokens, estimated_cost, created
    ) VALUES ('claude-sonnet-4-6', 'digest', 10, 5, 0, 0.000105, '2026-07-01T00:00:00.000Z');

    DROP TABLE model_connections;
    CREATE TABLE model_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      credentials TEXT NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'unconfigured',
      available_models TEXT,
      last_checked TEXT,
      archived INTEGER DEFAULT 0,
      created TEXT NOT NULL
    );

    DROP INDEX IF EXISTS idx_pending_digests_status;
    DROP TABLE pending_digests;
    CREATE TABLE pending_digests (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','failed')),
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      created TEXT NOT NULL,
      next_retry_at TEXT NOT NULL,
      completed_at TEXT,
      processing_started_at TEXT
    );
    CREATE INDEX idx_pending_digests_status
      ON pending_digests(status, next_retry_at);
    INSERT INTO pending_digests (
      id, trace_id, input_json, status, created, next_retry_at
    ) VALUES ('pd_1', 'trace_1', '{}', 'failed', '2026-07-01', '2026-07-02');

    DROP TABLE IF EXISTS llm_connection_health;
    DROP TABLE IF EXISTS cli_capacity_leases;
    DROP TABLE IF EXISTS cli_invocations;
    UPDATE metadata SET value = '32' WHERE key = 'schema_version';
  `);
  return db;
}

describe('migration v33 — connection-aware LLM persistence', () => {
  it('recovers a leftover backup without losing queued rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pending_digests_v32_backup (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','processing','failed')),
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        created TEXT NOT NULL,
        next_retry_at TEXT NOT NULL,
        completed_at TEXT,
        processing_started_at TEXT
      );
      INSERT INTO pending_digests_v32_backup (
        id, trace_id, input_json, status, created, next_retry_at
      ) VALUES ('pd_backup', 'trace', '{}', 'pending', '2026-07-29', '2026-07-29');
    `);
    ensurePendingDigestsV33(db);
    expect(db.prepare('SELECT id, status FROM pending_digests').all())
      .toEqual([{ id: 'pd_backup', status: 'pending' }]);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'pending_digests_v32_backup'
    `).get()).toBeUndefined();
  });

  it('rolls back the complete pending queue rebuild when a migration step fails', () => {
    const db = makeV32Database();
    const originalExec = db.exec.bind(db);
    const execSpy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql.includes('DROP TABLE pending_digests_v32_backup')) {
        throw new Error('simulated disk failure');
      }
      return originalExec(sql);
    });
    expect(() => ensurePendingDigestsV33(db)).toThrow(/simulated disk failure/);
    expect(db.prepare("SELECT status FROM pending_digests WHERE id = 'pd_1'").get())
      .toEqual({ status: 'failed' });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'pending_digests_v32_backup'
    `).get()).toBeUndefined();
    expect(columns(db, 'pending_digests')).not.toContain('ambiguous_invocation_id');

    execSpy.mockRestore();
    ensurePendingDigestsV33(db);
    expect(columns(db, 'pending_digests')).toContain('ambiguous_invocation_id');
    expect(db.prepare("SELECT status FROM pending_digests WHERE id = 'pd_1'").get())
      .toEqual({ status: 'failed' });
  });

  it('fresh schema 包含全部新表、连接字段和 nullable 费用', () => {
    const db = new Database(':memory:');
    ensureSchema(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(33);
    expect(columns(db, 'model_connections')).toEqual(expect.arrayContaining([
      'status_reason',
      'cli_path',
      'cli_version',
      'auth_fingerprint',
      'candidate_models',
      'validation_fingerprint',
      'model_validation_json',
      'last_test_summary',
    ]));
    expect(columns(db, 'llm_usage_log')).toEqual(expect.arrayContaining([
      'provider_type',
      'connection_id',
      'source_type',
      'billing_mode',
      'estimated_cost_kind',
      'pricing_table_version',
      'provider_reported_cost',
      'cached_input_tokens',
      'reasoning_tokens',
      'invocation_outcome',
    ]));
    expect(() => db.prepare(`
      INSERT INTO llm_usage_log (model, estimated_cost, created)
      VALUES ('unknown-model', NULL, '2026-07-29')
    `).run()).not.toThrow();
    expect(columns(db, 'llm_connection_health').length).toBeGreaterThan(0);
    expect(columns(db, 'cli_capacity_leases').length).toBeGreaterThan(0);
    expect(columns(db, 'cli_invocations').length).toBeGreaterThan(0);
  });

  it('v32 upgrade 保留队列与用量，扩展 ambiguous，并只回填可推断来源', () => {
    const db = makeV32Database();
    ensureSchema(db);

    expect((db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value: string }).value)
      .toBe('33');
    expect(db.prepare("SELECT status FROM pending_digests WHERE id='pd_1'").get())
      .toEqual({ status: 'failed' });
    expect(() => db.prepare(`
      INSERT INTO pending_digests (
        id, trace_id, input_json, status, created, next_retry_at, ambiguous_invocation_id
      ) VALUES ('pd_2', 'trace_2', '{}', 'ambiguous', '2026-07-01', '2026-07-02', 'inv_2')
    `).run()).not.toThrow();

    const usage = db.prepare(`
      SELECT provider_type, connection_id, source_type, billing_mode,
             estimated_cost_kind, pricing_table_version, invocation_outcome
      FROM llm_usage_log
    `).get();
    expect(usage).toEqual({
      provider_type: 'unknown',
      connection_id: null,
      source_type: 'cloud_service',
      billing_mode: 'api',
      estimated_cost_kind: 'api_estimate',
      pricing_table_version: '2026-07-29',
      invocation_outcome: 'success',
    });
  });

  it('lease fencing 与 invocation ledger helper 保持原子 ownership', () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    const first = acquireCliCapacityLease(db, {
      accountScope: 'codex:account-a',
      ownerId: 'daemon-a',
      ownerPid: 1,
      nowMs: 1000,
      leaseMs: 5000,
      connectionId: 'mc_1',
      invocationId: 'inv_1',
    });
    expect(first.fencingToken).toBe(1);
    expect(() => acquireCliCapacityLease(db, {
      accountScope: 'codex:account-a',
      ownerId: 'daemon-b',
      ownerPid: 2,
      nowMs: 2000,
      leaseMs: 5000,
      connectionId: 'mc_2',
      invocationId: 'inv_2',
    })).toThrowError(expect.objectContaining({ kind: 'capacity' }));
    const renewed = renewCliCapacityLease(db, first, 5000, 3000);
    expect(renewed.expiresAt).toBe(8000);
    expect(releaseCliCapacityLease(db, { ...renewed, ownerId: 'daemon-b' })).toBe(false);
    expect(releaseCliCapacityLease(db, renewed)).toBe(true);

    startCliInvocation(db, {
      id: 'inv_1',
      connectionId: 'mc_1',
      providerType: 'codex-cli',
      accountScope: 'codex:account-a',
      taskId: 'task_1',
      operationName: 'digest',
      modelAlias: 'gpt-5',
    });
    expect(finishCliInvocation(db, {
      invocationId: 'inv_1',
      outcome: 'success',
      actualModel: 'gpt-5.2-codex',
    })).toBe(true);
    expect(db.prepare('SELECT outcome, actual_model FROM cli_invocations WHERE id = ?').get('inv_1')).toMatchObject({
      outcome: 'success',
      actual_model: 'gpt-5.2-codex',
    });
  });

  it('CLI credentials 固定为空，环境指纹变化会原子失效旧模型验证', () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    const connection = createConnection(db, {
      name: '我的 Codex',
      provider_type: 'codex-cli',
      credentials: { api_key: 'must-not-persist' },
    });
    expect(connection.credentials).toBe('{}');
    updateConnection(db, connection.id, { credentials: { api_key: 'still-not-persisted' } });
    db.prepare(`
      UPDATE model_connections
      SET available_models = '["gpt-5"]',
          validation_fingerprint = 'old',
          model_validation_json = '{}',
          last_tested_at = 'old',
          last_test_summary = '{}'
      WHERE id = ?
    `).run(connection.id);

    const result = updateCliConnectionEnvironment(db, connection.id, {
      status: 'untested',
      statusReason: null,
      cliPath: '/opt/homebrew/bin/codex',
      cliVersion: '0.145.0',
      authMethod: 'chatgpt',
      authFingerprint: 'account-a',
      candidateModels: ['gpt-5'],
      environmentCheckedAt: '2026-07-29T00:00:00.000Z',
    });
    expect(result.validationInvalidated).toBe(true);
    expect(getConnection(db, connection.id)).toMatchObject({
      credentials: '{}',
      status: 'untested',
      available_models: null,
      validation_fingerprint: null,
      model_validation_json: null,
      last_tested_at: null,
      last_test_summary: null,
    });
  });
});
