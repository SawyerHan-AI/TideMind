import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema.js';
import { createConnection } from '../../src/db/connections.js';
import { MODEL_DISCOVERY_SCHEMA_SQL } from '../../src/db/model-discovery-schema.js';

const MODEL_DISCOVERY_TABLES = [
  'llm_connection_auth_bindings',
  'llm_model_catalog_snapshots',
  'llm_model_observations',
] as const;

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all() as Array<{ name: string }>).map(row => row.name);
}

function schemaVersion(db: Database.Database): string {
  return (db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as {
    value: string;
  }).value;
}

describe('migration v35 — model discovery / auth binding / observations', () => {
  it('fresh schema is v35 and creates the three local-only tables', () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    expect(CURRENT_SCHEMA_VERSION).toBe(35);
    expect(schemaVersion(db)).toBe('35');
    expect(tableNames(db)).toEqual(expect.arrayContaining([...MODEL_DISCOVERY_TABLES]));
    // 本机数据：不进入云同步脏集 trigger。
    const triggers = (db.prepare(`
      SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'
    `).all() as Array<{ name: string; tbl_name: string }>)
      .filter(row => (MODEL_DISCOVERY_TABLES as readonly string[]).includes(row.tbl_name));
    expect(triggers).toEqual([]);
    db.close();
  });

  it('upgrades a v34 database without promoting legacy available_models to current evidence', () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    const connection = createConnection(db, { name: '星海科技 Codex', provider_type: 'codex-cli' });
    db.prepare(`
      UPDATE model_connections
      SET status = 'online',
          candidate_models = '["default","gpt-5"]',
          available_models = '["default","gpt-5"]',
          validation_fingerprint = 'legacy-fingerprint',
          model_validation_json = '{"gpt-5":{"success":true}}'
      WHERE id = ?
    `).run(connection.id);
    for (const table of MODEL_DISCOVERY_TABLES) db.exec(`DROP TABLE ${table}`);
    db.exec('DROP INDEX IF EXISTS idx_llm_model_observations_connection');
    db.prepare("UPDATE metadata SET value = '34' WHERE key = 'schema_version'").run();

    ensureSchema(db);

    expect(schemaVersion(db)).toBe('35');
    expect(tableNames(db)).toEqual(expect.arrayContaining([...MODEL_DISCOVERY_TABLES]));
    for (const table of MODEL_DISCOVERY_TABLES) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    // Legacy columns stay as history/display input only.
    expect(db.prepare(`
      SELECT status, available_models, validation_fingerprint, model_validation_json
      FROM model_connections WHERE id = ?
    `).get(connection.id)).toEqual({
      status: 'online',
      available_models: '["default","gpt-5"]',
      validation_fingerprint: 'legacy-fingerprint',
      model_validation_json: '{"gpt-5":{"success":true}}',
    });

    // Idempotent re-open.
    expect(() => ensureSchema(db)).not.toThrow();
    expect(() => db.exec(MODEL_DISCOVERY_SCHEMA_SQL)).not.toThrow();
    expect(schemaVersion(db)).toBe('35');
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    db.close();
  });

  it('enforces observation outcome / selection mode / epoch constraints', () => {
    const db = new Database(':memory:');
    ensureSchema(db);
    const insertObservation = (outcome: string, mode: string) => db.prepare(`
      INSERT INTO llm_model_observations (
        connection_id, scope_key, auth_epoch, model_id, selection_mode, last_outcome,
        last_source, updated_at
      ) VALUES ('mc_fixture', 'codex-cli:scope', 1, ?, ?, ?, 'business', '2026-09-25T00:00:00.000Z')
    `).run(`${outcome}-${mode}`, mode, outcome);
    expect(() => insertObservation('success', 'pinned_id')).not.toThrow();
    expect(() => insertObservation('retired', 'pinned_id')).toThrow(/CHECK/);
    expect(() => insertObservation('success', 'latest')).toThrow(/CHECK/);
    expect(() => db.prepare(`
      INSERT INTO llm_connection_auth_bindings (
        connection_id, scope_state, scope_key, auth_epoch, observed_at, epoch_started_at
      ) VALUES ('mc_fixture', 'known', 'k', 0, 'now', 'now')
    `).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`
      INSERT INTO llm_connection_auth_bindings (
        connection_id, scope_state, scope_key, auth_epoch, observed_at, epoch_started_at
      ) VALUES ('mc_fixture', 'maybe', 'k', 1, 'now', 'now')
    `).run()).toThrow(/CHECK/);
    db.close();
  });
});

describe('model discovery schema has one authoritative definition', () => {
  const read = (relative: string) => readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    'utf8',
  );

  it('is wired into daemon fresh schema, v35 migration and both Electron entrypoints', () => {
    const core = read('../../src/db/schema.ts');
    const client = read('../../client/electron/db.ts');
    expect(core).toContain('version: 35');
    expect(core.match(/ensureModelDiscoverySchema\(db\)/g)).toHaveLength(2);
    expect(client.match(/ensureModelDiscoverySchema\(newDb\)/g)).toHaveLength(1);
    expect(client.match(/ensureModelDiscoverySchema\(tmpDb\)/g)).toHaveLength(1);
    for (const table of MODEL_DISCOVERY_TABLES) {
      expect(core, table).not.toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(client, table).not.toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});
