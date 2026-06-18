/**
 * CacheManager 单元测试
 *
 * 测试本地缓存管理器的版本跟踪和数据同步功能。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import { CacheManager } from '../../client/electron/cloud/cache-manager.js';

let db: Database.Database;
let cache: CacheManager;

beforeEach(() => {
  db = setupTestDb();
  cache = new CacheManager(db, 'https://cloud.test.example');
});

// ===== getLastSyncedVersion / setLastSyncedVersion =====

describe('CacheManager - version tracking', () => {
  it('should return 0 when no version has been set', () => {
    expect(cache.getLastSyncedVersion()).toBe(0);
  });

  it('should store and retrieve version', () => {
    cache.setLastSyncedVersion(42);
    expect(cache.getLastSyncedVersion()).toBe(42);
  });

  it('should update version on subsequent calls', () => {
    cache.setLastSyncedVersion(10);
    cache.setLastSyncedVersion(25);
    expect(cache.getLastSyncedVersion()).toBe(25);
  });
});

// ===== applyChanges - nodes =====

describe('CacheManager - applyChanges nodes', () => {
  it('should insert a node from change data', async () => {
    const changes = [{
      table: 'nodes',
      action: 'upsert',
      sync_version: 5,
      data: {
        id: 'cloud-n1',
        type: 'fact',
        content: 'synced from cloud',
        heat: 1.0,
        refinement: 0,
        connectivity: 0,
        independence: 0,
        maturity_score: 0.2,
        created: '2026-01-01T00:00:00Z',
      },
    }];

    const applied = await cache.applyChanges(changes, 'fake-token');
    expect(applied).toBe(1);

    // Verify node exists in DB
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('cloud-n1') as any;
    expect(row).not.toBeUndefined();
    expect(row.content).toBe('synced from cloud');
    expect(row.type).toBe('fact');
  });

  it('should update synced version to max of applied changes', async () => {
    const changes = [
      { table: 'nodes', action: 'upsert', sync_version: 3, data: { id: 'n-a', type: 'fact', content: 'a', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      { table: 'nodes', action: 'upsert', sync_version: 7, data: { id: 'n-b', type: 'idea', content: 'b', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      { table: 'nodes', action: 'upsert', sync_version: 5, data: { id: 'n-c', type: 'fact', content: 'c', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
    ];

    await cache.applyChanges(changes, 'fake-token');
    expect(cache.getLastSyncedVersion()).toBe(7);
  });

  it('should upsert (replace) existing node', async () => {
    // Insert initial node
    await cache.applyChanges([{
      table: 'nodes', action: 'upsert', sync_version: 1,
      data: { id: 'n-upsert', type: 'fact', content: 'original', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' },
    }], 'fake-token');

    // Update same node。heat 字段语义统一到 [0,1] 后,fixture 不能用 2.5;改用合法范围内的值。
    await cache.applyChanges([{
      table: 'nodes', action: 'upsert', sync_version: 2,
      data: { id: 'n-upsert', type: 'fact', content: 'updated', heat: 0.8, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.3, created: '2026-01-01T00:00:00Z', edit_seq: 2 },
    }], 'fake-token');

    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n-upsert') as any;
    expect(row.content).toBe('updated');
    expect(row.heat).toBe(0.8);
  });
});

// ===== applyChanges - links =====

describe('CacheManager - applyChanges links', () => {
  it('should insert a link from change data', async () => {
    // First create the nodes that the link references
    await cache.applyChanges([
      { table: 'nodes', action: 'upsert', sync_version: 1, data: { id: 'ln-1', type: 'fact', content: 'node 1', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      { table: 'nodes', action: 'upsert', sync_version: 1, data: { id: 'ln-2', type: 'fact', content: 'node 2', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
    ], 'fake-token');

    // Now insert the link
    const applied = await cache.applyChanges([{
      table: 'links', action: 'upsert', sync_version: 2,
      data: {
        id: 'cloud-link-1',
        from_id: 'ln-1',
        to_id: 'ln-2',
        relation: [{ type: 'supports', confidence: 0.9 }],
        strength: 0.8,
        status: 'confirmed',
        created: '2026-01-01T00:00:00Z',
      },
    }], 'fake-token');

    expect(applied).toBe(1);

    const row = db.prepare('SELECT * FROM links WHERE id = ?').get('cloud-link-1') as any;
    expect(row).not.toBeUndefined();
    expect(row.from_id).toBe('ln-1');
    expect(row.to_id).toBe('ln-2');
  });
});

// ===== applyChanges - empty & edge cases =====

describe('CacheManager - applyChanges edge cases', () => {
  it('should handle empty changes array', async () => {
    const applied = await cache.applyChanges([], 'fake-token');
    expect(applied).toBe(0);
    // Version should not change
    expect(cache.getLastSyncedVersion()).toBe(0);
  });

  it('unknown tables go to dead-letter and cursor still advances (2026-05-19 fix)', async () => {
    const changes = [{
      table: 'unknown_table',
      action: 'upsert',
      sync_version: 10,
      data: { id: 'x', foo: 'bar' },
    }];

    const applied = await cache.applyChanges(changes, 'fake-token');
    expect(applied).toBe(0);
    // Cursor MUST advance even when the only change is dead-lettered,
    // otherwise next pull replays the same poison forever.
    expect(cache.getLastSyncedVersion()).toBe(10);

    const dl = db.prepare('SELECT * FROM cloud_sync_dead_letters').all() as any[];
    expect(dl).toHaveLength(1);
    expect(dl[0].resource_table).toBe('unknown_table');
    expect(dl[0].sync_version).toBe(10);
  });

  it('failed change goes to dead-letter and cursor advances past it (2026-05-19 fix)', async () => {
    // We force a failure by passing a row that violates a NOT NULL constraint
    // (omitting `id` makes applyCloudNodeRow throw on the prepared statement).
    const changes = [
      { table: 'nodes', action: 'upsert', sync_version: 1, data: { id: 'ok-before-failure', type: 'fact', content: 'good', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      // bogus type — CHECK constraint should reject
      { table: 'nodes', action: 'upsert', sync_version: 2, data: { id: 'bad-node', type: 'invalid_type_that_violates_check', content: 'bad', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      { table: 'nodes', action: 'upsert', sync_version: 3, data: { id: 'ok-after-failure', type: 'fact', content: 'also good', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-02T00:00:00Z' } },
    ];

    const applied = await cache.applyChanges(changes, 'fake-token');
    // 2 nodes applied (sv=1 and sv=3), 1 dead-lettered (sv=2)
    expect(applied).toBe(2);
    // cursor MUST advance to 3 — the whole point of the fix
    expect(cache.getLastSyncedVersion()).toBe(3);

    const laterNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get('ok-after-failure') as any;
    expect(laterNode.content).toBe('also good');

    const dl = db.prepare('SELECT * FROM cloud_sync_dead_letters').all() as any[];
    expect(dl).toHaveLength(1);
    expect(dl[0].resource_id).toBe('bad-node');
    expect(dl[0].sync_version).toBe(2);
  });

  it('repeated pulls of same bad data update the existing dead-letter row, not duplicate', async () => {
    const badChange = { table: 'nodes', action: 'upsert', sync_version: 5, data: { id: 'bad-twice', type: 'wrong_check_value', content: 'x', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } };

    await cache.applyChanges([badChange], 'fake-token');
    await cache.applyChanges([{ ...badChange, sync_version: 8 }], 'fake-token');

    const dl = db.prepare('SELECT * FROM cloud_sync_dead_letters WHERE resource_id = ?').all('bad-twice') as any[];
    expect(dl).toHaveLength(1);  // 同 (table, id) ON CONFLICT 更新,不增行
    expect(dl[0].sync_version).toBe(8);  // 最新版本
  });

  it('should apply all valid changes even if some fail', async () => {
    const changes = [
      // Valid node
      { table: 'nodes', action: 'upsert', sync_version: 1, data: { id: 'ok-node', type: 'fact', content: 'good', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      // Node that might have issues but still runs INSERT OR REPLACE
      { table: 'nodes', action: 'upsert', sync_version: 3, data: { id: 'ok-node-2', type: 'idea', content: 'also good', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-02T00:00:00Z' } },
    ];

    const applied = await cache.applyChanges(changes, 'fake-token');
    expect(applied).toBe(2);

    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('ok-node') as any;
    expect(row.content).toBe('good');
  });

  it('should apply mixed node and link changes in one batch', async () => {
    const changes = [
      { table: 'nodes', action: 'upsert', sync_version: 1, data: { id: 'mix-n1', type: 'fact', content: 'first', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      { table: 'nodes', action: 'upsert', sync_version: 2, data: { id: 'mix-n2', type: 'fact', content: 'second', heat: 1, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.2, created: '2026-01-01T00:00:00Z' } },
      { table: 'links', action: 'upsert', sync_version: 3, data: { id: 'mix-l1', from_id: 'mix-n1', to_id: 'mix-n2', relation: [{ type: 'supports', confidence: 0.7 }], strength: 0.5, status: 'confirmed', created: '2026-01-01T00:00:00Z' } },
    ];

    const applied = await cache.applyChanges(changes, 'fake-token');
    expect(applied).toBe(3);
    expect(cache.getLastSyncedVersion()).toBe(3);

    const nodeCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE id IN (?, ?)').get('mix-n1', 'mix-n2') as any).cnt;
    expect(nodeCount).toBe(2);

    const linkRow = db.prepare('SELECT * FROM links WHERE id = ?').get('mix-l1') as any;
    expect(linkRow).not.toBeUndefined();
  });
});
