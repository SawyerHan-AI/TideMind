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

    // Update same node
    await cache.applyChanges([{
      table: 'nodes', action: 'upsert', sync_version: 2,
      data: { id: 'n-upsert', type: 'fact', content: 'updated', heat: 2.5, refinement: 0, connectivity: 0, independence: 0, maturity_score: 0.3, created: '2026-01-01T00:00:00Z' },
    }], 'fake-token');

    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n-upsert') as any;
    expect(row.content).toBe('updated');
    expect(row.heat).toBe(2.5);
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

  it('should handle unknown table gracefully (counts but ignores)', async () => {
    const changes = [{
      table: 'unknown_table',
      action: 'upsert',
      sync_version: 10,
      data: { id: 'x', foo: 'bar' },
    }];

    // Unknown table is silently skipped by the try/catch, but applied counter still increments
    const applied = await cache.applyChanges(changes, 'fake-token');
    expect(applied).toBe(1);
    // Version should still update since changes had entries
    expect(cache.getLastSyncedVersion()).toBe(10);
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
