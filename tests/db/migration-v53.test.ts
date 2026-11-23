import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../../src/db/schema.js';
import { AGENT_INTEGRATION_TABLES, ensureAgentIntegrationSchema } from '../../src/db/agent-integration-schema.js';
import { CODEX_MCP_SEMANTIC_PROOF_SCHEMA_SQL } from '../../src/db/codex-mcp-semantic-proof-schema.js';
import { assertSupportedDatabaseSchema } from '../../src/db/schema-compatibility.js';
import { seedLifecycle } from '../fixtures/seed-managed-lifecycle.js';

const table = 'codex_mcp_semantic_member_proofs';
const shape = (db: Database.Database) => ({
  columns: db.prepare(`PRAGMA table_info(${table})`).all(),
  foreignKeys: db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
  indexes: db.prepare(`PRAGMA index_list(${table})`).all(),
});

describe('schema v53: separate non-authorizing Codex readback evidence', () => {
  it('upgrades v52 without backfilling grants or changing existing managed state', () => {
    const fresh = new Database(':memory:');
    const old = new Database(':memory:');
    try {
      ensureSchema(fresh);
      ensureSchema(old);
      seedLifecycle(old, 'synthetic', 'codex', 'codex-cli');
      old.exec(`DROP TABLE ${table}; UPDATE metadata SET value='52' WHERE key='schema_version';
        UPDATE managed_artifacts SET state='drifted'; UPDATE agent_installations SET status_reason='conflict';`);
      const before = old.prepare('SELECT * FROM managed_artifacts').all();
      ensureSchema(old);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
      expect(old.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: String(CURRENT_SCHEMA_VERSION) });
      expect(old.prepare('SELECT * FROM managed_artifacts').all()).toEqual(before);
      expect(old.prepare('SELECT status_reason FROM agent_installations').all()).toEqual([{ status_reason: 'conflict' }]);
      expect(old.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(shape(old)).toEqual(shape(fresh));
      expect(() => assertSupportedDatabaseSchema(old, 52)).toThrow(/高于/);
      expect(AGENT_INTEGRATION_TABLES).toContain(table);
    } finally { fresh.close(); old.close(); }
  });

  it('uses the same idempotent DDL for fresh and repair and never syncs proof rows', () => {
    const db = new Database(':memory:');
    try {
      ensureSchema(db);
      const expected = shape(db);
      db.exec(`DROP TABLE ${table}`);
      ensureAgentIntegrationSchema(db);
      db.exec(CODEX_MCP_SEMANTIC_PROOF_SCHEMA_SQL);
      ensureSchema(db);
      expect(shape(db)).toEqual(expected);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table)).toEqual([]);
      const columns = expected.columns as Array<{ name: string; notnull: number }>;
      expect(columns.every(column => column.notnull === 1)).toBe(true);
    } finally { db.close(); }
  });
});
