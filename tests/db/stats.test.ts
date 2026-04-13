/**
 * stats.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

// ---- Mock config ----
vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test', user_name: 'test' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.3, beta: 0.5, gamma: 0.1, delta: 0.1 },
    gates: {
      vector_search: 50,
      graph_expansion: 100,
      graph_expansion_links: 50,
      crystal_generation: 200,
      divergent_scan: 500,
      learning_2_min_nodes: 500,
      learning_2_min_recall_ops: 200,
    },
    metabolism: { daily_check_hours: 24, weekly_check_days: 7 },
  }),
  isLlmConfigured: () => false,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { logOperation } from '../../src/db/log.js';
import { getGateStatus, invalidateGateCache } from '../../src/db/stats.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  // 每个测试前清除缓存，避免跨测试污染
  invalidateGateCache();
});

// ===== getGateStatus =====

describe('getGateStatus', () => {
  it('should return correct counts for empty database', () => {
    const status = getGateStatus(db);
    expect(status.node_count).toBe(0);
    expect(status.link_count).toBe(0);
    expect(status.recall_count).toBe(0);
  });

  it('should count nodes correctly (excluding archived)', () => {
    const n1 = seedNode(db, { content: 'node-1' });
    seedNode(db, { content: 'node-2' });
    seedNode(db, { content: 'node-3' });
    // archive one
    db.prepare('UPDATE nodes SET archived = 1 WHERE id = ?').run(n1.id);

    invalidateGateCache();
    const status = getGateStatus(db);
    expect(status.node_count).toBe(2);
  });

  it('should count confirmed links only', () => {
    const n1 = seedNode(db);
    const n2 = seedNode(db);
    const n3 = seedNode(db);
    seedLink(db, n1.id, n2.id, { status: 'confirmed' });
    seedLink(db, n2.id, n3.id, { status: 'pending' });

    invalidateGateCache();
    const status = getGateStatus(db);
    expect(status.link_count).toBe(1);
  });

  it('should count recall operations', () => {
    logOperation(db, { operation: 'recall' });
    logOperation(db, { operation: 'recall' });
    logOperation(db, { operation: 'digest' });

    invalidateGateCache();
    const status = getGateStatus(db);
    expect(status.recall_count).toBe(2);
  });

  it('should always enable basic_digest and bm25_search', () => {
    const status = getGateStatus(db);
    expect(status.features.basic_digest).toBe(true);
    expect(status.features.bm25_search).toBe(true);
  });

  it('should disable vector_search when node count < threshold (50)', () => {
    // 0 nodes < 50
    const status = getGateStatus(db);
    expect(status.features.vector_search).toBe(false);
  });

  it('should enable vector_search when node count >= threshold (50)', () => {
    for (let i = 0; i < 50; i++) {
      seedNode(db, { content: `node-${i}` });
    }

    invalidateGateCache();
    const status = getGateStatus(db);
    expect(status.features.vector_search).toBe(true);
  });

  it('should require both node count and link count for graph_expansion', () => {
    // 100 nodes but 0 links → disabled
    for (let i = 0; i < 100; i++) {
      seedNode(db, { content: `node-${i}` });
    }

    invalidateGateCache();
    const status = getGateStatus(db);
    expect(status.features.graph_expansion).toBe(false);
  });

  it('should disable crystal_generation below threshold (200)', () => {
    const status = getGateStatus(db);
    expect(status.features.crystal_generation).toBe(false);
  });

  it('should disable divergent_scan below threshold (500)', () => {
    const status = getGateStatus(db);
    expect(status.features.divergent_scan).toBe(false);
  });
});

// ===== Cache behavior =====

describe('gate cache', () => {
  it('should return same object reference on second call (cache hit)', () => {
    seedNode(db);
    const first = getGateStatus(db);
    const second = getGateStatus(db);
    // Same cached reference
    expect(first).toBe(second);
  });

  it('should return fresh data after invalidateGateCache', () => {
    const first = getGateStatus(db);
    expect(first.node_count).toBe(0);

    seedNode(db);
    // Without invalidation, cache still returns old count
    const cached = getGateStatus(db);
    expect(cached.node_count).toBe(0);

    // After invalidation, returns fresh data
    invalidateGateCache();
    const fresh = getGateStatus(db);
    expect(fresh.node_count).toBe(1);
  });
});
