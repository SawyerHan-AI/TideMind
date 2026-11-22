import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../../src/db/schema.js';
import { ensureRecallFollowupSchema } from '../../src/db/recall-followup-schema.js';

function shape(db: Database.Database) {
  return {
    columns: db.prepare('PRAGMA table_info(recall_followups)').all(),
    indexes: db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'recall_followups' AND type = 'index' ORDER BY name").all(),
  };
}
const version = (db: Database.Database) =>
  (db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;

describe('schema v50: recall follow-up queue', () => {
  it('creates the queue on a fresh database', () => {
    const db = new Database(':memory:');
    try {
      ensureSchema(db);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(50);
      expect(version(db)).toBe(String(CURRENT_SCHEMA_VERSION));
      expect(shape(db).columns.map((c: any) => c.name)).toEqual([
        'id', 'kind', 'dedupe_key', 'node_ids_json', 'query', 'context', 'handled_json',
        'status', 'attempts', 'not_before', 'created', 'updated', 'claimed_at',
      ]);
    } finally { db.close(); }
  });

  it('upgrades a v49 database to the same shape and is idempotent', () => {
    const fresh = new Database(':memory:');
    const upgraded = new Database(':memory:');
    try {
      ensureSchema(fresh);
      ensureSchema(upgraded);
      upgraded.exec("DROP TABLE recall_followups; UPDATE metadata SET value='49' WHERE key='schema_version'");
      ensureSchema(upgraded);
      expect(version(upgraded)).toBe(String(CURRENT_SCHEMA_VERSION));
      expect(shape(upgraded)).toEqual(shape(fresh));
      ensureRecallFollowupSchema(upgraded);
      ensureSchema(upgraded);
      expect(shape(upgraded)).toEqual(shape(fresh));
    } finally { fresh.close(); upgraded.close(); }
  });

  it('enforces kind/status and one row per (kind, dedupe_key); has no cloud-dirty trigger', () => {
    const db = new Database(':memory:');
    try {
      ensureSchema(db);
      const insert = db.prepare("INSERT INTO recall_followups (id, kind, dedupe_key, node_ids_json, created, updated) VALUES (?, ?, ?, '[]', 't', 't')");
      insert.run('a', 'link_revalidate', 'k');
      insert.run('b', 'reconsolidate', 'k');
      expect(() => insert.run('c', 'link_revalidate', 'k')).toThrow();
      expect(() => insert.run('d', 'other', 'k2')).toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='recall_followups'").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
