import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../../src/db/schema.js';
import { ensureCloudSyncExclusionSchema } from '../../src/db/cloud-sync-exclusion-schema.js';
import {
  excludeFromCloudSync, isExcludedFromCloudSync, listExcludedFromCloudSync,
} from '../../src/db/cloud-sync-exclusions.js';

const shape = (db: Database.Database) => db.prepare('PRAGMA table_info(cloud_sync_excluded)').all();
const version = (db: Database.Database) =>
  (db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;

describe('schema v52: cloud sync exclusion list', () => {
  it('exists on a fresh database and after upgrading from v51; idempotent', () => {
    const fresh = new Database(':memory:');
    const upgraded = new Database(':memory:');
    try {
      ensureSchema(fresh);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
      expect(version(fresh)).toBe(String(CURRENT_SCHEMA_VERSION));
      ensureSchema(upgraded);
      upgraded.exec("DROP TABLE cloud_sync_excluded; UPDATE metadata SET value='51' WHERE key='schema_version'");
      ensureSchema(upgraded);
      expect(version(upgraded)).toBe(String(CURRENT_SCHEMA_VERSION));
      ensureCloudSyncExclusionSchema(upgraded);
      ensureSchema(upgraded);
      expect(shape(upgraded)).toEqual(shape(fresh));
      expect(fresh.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='cloud_sync_excluded'").get()).toEqual({ n: 0 });
    } finally { fresh.close(); upgraded.close(); }
  });

  it('records exclusions per table, idempotently', () => {
    const db = new Database(':memory:');
    try {
      ensureSchema(db);
      excludeFromCloudSync(db, 'nodes', 'n1', 'not_primary_device');
      excludeFromCloudSync(db, 'nodes', 'n1', 'again');
      excludeFromCloudSync(db, 'links', 'l1', 'not_primary_device');
      expect(isExcludedFromCloudSync(db, 'nodes', 'n1')).toBe(true);
      expect(isExcludedFromCloudSync(db, 'links', 'n1')).toBe(false);
      expect([...listExcludedFromCloudSync(db, 'nodes')]).toEqual(['n1']);
      expect(db.prepare("SELECT reason FROM cloud_sync_excluded WHERE id='n1'").get()).toEqual({ reason: 'not_primary_device' });
    } finally { db.close(); }
  });
});
