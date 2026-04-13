/**
 * BM25 搜索单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader（在所有 import 之前） ----
vi.mock('../../src/strategy/loader.js', () => ({
  getStrategyParam: (key: string, fallback: number) => fallback,
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { searchBM25 } from '../../src/search/bm25.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== 基本搜索 =====

describe('searchBM25', () => {
  it('should return results matching the query', () => {
    seedNode(db, { content: 'quantum physics breakthrough discovery' });
    seedNode(db, { content: 'classical music composition theory' });

    const results = searchBM25(db, 'quantum');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.content).toContain('quantum');
    expect(results[0].source).toBe('bm25');
  });

  it('should return normalized scores in [0,1] with best=1.0', () => {
    seedNode(db, { content: 'algorithm optimization benchmark performance' });
    seedNode(db, { content: 'algorithm design patterns' });
    seedNode(db, { content: 'unrelated gardening tips' });

    const results = searchBM25(db, 'algorithm');
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Best result should have score 1.0
    expect(results[0].score).toBe(1.0);

    // All scores should be in [0, 1]
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('should return score 1.0 when only one result exists', () => {
    seedNode(db, { content: 'zygomorphic flower symmetry' });

    const results = searchBM25(db, 'zygomorphic');
    expect(results).toHaveLength(1);
    // range === 0 => score = 1.0
    expect(results[0].score).toBe(1.0);
  });

  it('should filter by type', () => {
    seedNode(db, { content: 'serverless deployment strategy', type: 'fact' });
    seedNode(db, { content: 'serverless architecture overview', type: 'idea' });

    const results = searchBM25(db, 'serverless', { type: 'fact' });
    expect(results).toHaveLength(1);
    expect(results[0].node.type).toBe('fact');
  });

  it('should filter by type', () => {
    seedNode(db, { content: 'refactoring methodology guide', type: 'fact' });
    seedNode(db, { content: 'refactoring improvement idea', type: 'idea' });

    const results = searchBM25(db, 'refactoring', { type: 'idea' });
    expect(results).toHaveLength(1);
    expect(results[0].node.type).toBe('idea');
  });

  it('should exclude archived nodes', () => {
    const node = seedNode(db, { content: 'ephemeral temporary data' });
    seedNode(db, { content: 'ephemeral cloud computing' });

    // Archive the first node directly
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(node.id);

    const results = searchBM25(db, 'ephemeral');
    expect(results).toHaveLength(1);
    expect(results[0].node.id).not.toBe(node.id);
  });

  it('should respect limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      seedNode(db, { content: `concurrent processing worker ${i}` });
    }

    const results = searchBM25(db, 'concurrent', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should return empty array when no results match', () => {
    seedNode(db, { content: 'hello world programming' });

    const results = searchBM25(db, 'xylophone');
    expect(results).toEqual([]);
  });

  it('should not crash on special characters', () => {
    seedNode(db, { content: 'normal content here' });

    // FTS5 special characters should be safely escaped
    expect(() => searchBM25(db, '(foo) AND "bar" [baz]')).not.toThrow();
    expect(() => searchBM25(db, '***')).not.toThrow();
    expect(() => searchBM25(db, 'hello:world^2~3')).not.toThrow();
    expect(() => searchBM25(db, '')).not.toThrow();

    const empty = searchBM25(db, '');
    expect(empty).toEqual([]);
  });

  it('should combine type and excludeMeta filters', () => {
    seedNode(db, { content: 'kubernetes orchestration cluster', type: 'fact' });
    seedNode(db, { content: 'kubernetes deployment idea', type: 'idea' });
    seedNode(db, { content: 'kubernetes meta info', type: 'meta' });

    const results = searchBM25(db, 'kubernetes', { type: 'fact', excludeMeta: true });
    expect(results).toHaveLength(1);
    expect(results[0].node.type).toBe('fact');
  });
});
