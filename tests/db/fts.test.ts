/**
 * fts.ts 全文搜索单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader（在所有 import 之前） ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const defaults: Record<string, number> = {
      heat_weight: 0.2,
      refinement_weight: 0.3,
      connectivity_weight: 0.3,
      independence_weight: 0.2,
    };
    return defaults[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { searchFTS, rebuildFTS } from '../../src/db/fts.js';
import { archiveNode, updateNode } from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

describe('searchFTS', () => {
  it('should find a node by content keyword', () => {
    seedNode(db, { content: 'quantum computing is fascinating' });
    const results = searchFTS(db, 'quantum');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('quantum');
  });

  it('should return empty for non-matching query', () => {
    seedNode(db, { content: 'hello world' });
    const results = searchFTS(db, 'xyzzyx');
    expect(results).toHaveLength(0);
  });

  it('should exclude low-heat nodes', () => {
    const node = seedNode(db, { content: 'archivable content about neutrons' });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(node.id);

    const results = searchFTS(db, 'neutrons');
    expect(results).toHaveLength(0);
  });

  it('should not crash on FTS special characters', () => {
    seedNode(db, { content: 'safe content here' });

    // These should not throw
    expect(() => searchFTS(db, 'AND OR NOT')).not.toThrow();
    expect(() => searchFTS(db, '() [] {}')).not.toThrow();
    expect(() => searchFTS(db, '"quoted" * ^ ~')).not.toThrow();
    expect(() => searchFTS(db, 'NEAR(a, b)')).not.toThrow();
  });

  it('should return multiple results ordered by rank', () => {
    // Seed nodes with varying relevance
    seedNode(db, { content: 'machine learning basics introduction' });
    seedNode(db, { content: 'machine learning deep learning neural networks machine learning' });
    seedNode(db, { content: 'unrelated cooking recipe' });

    const results = searchFTS(db, 'machine learning');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // rank is negative in BM25; lower (more negative) = better match
    // Results should be ordered by rank ascending (best first)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].rank).toBeGreaterThanOrEqual(results[i - 1].rank);
    }
  });

  it('should return empty for empty query', () => {
    seedNode(db, { content: 'some content' });
    const results = searchFTS(db, '');
    expect(results).toHaveLength(0);
  });

  it('should return empty for query that becomes empty after sanitization', () => {
    seedNode(db, { content: 'some content' });
    const results = searchFTS(db, 'AND OR NOT');
    expect(results).toHaveLength(0);
  });
});

// ===== FTS triggers =====

describe('FTS triggers', () => {
  it('insert trigger: new node is immediately searchable', () => {
    seedNode(db, { content: 'synapse plasticity research' });
    const results = searchFTS(db, 'synapse');
    expect(results).toHaveLength(1);
  });

  it('update trigger: updated content is reflected in search', () => {
    const node = seedNode(db, { content: 'old searchable term xylophone' });
    expect(searchFTS(db, 'xylophone')).toHaveLength(1);

    updateNode(db, node.id, { content: 'new searchable term accordion' });

    expect(searchFTS(db, 'xylophone')).toHaveLength(0);
    expect(searchFTS(db, 'accordion')).toHaveLength(1);
  });

  it('delete trigger: deleted node is removed from search', () => {
    const node = seedNode(db, { content: 'ephemeral data dinosaur' });
    expect(searchFTS(db, 'dinosaur')).toHaveLength(1);

    db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    expect(searchFTS(db, 'dinosaur')).toHaveLength(0);
  });
});

// ===== rebuildFTS =====

describe('rebuildFTS', () => {
  it('should rebuild without error', () => {
    seedNode(db, { content: 'rebuild test content' });
    expect(() => rebuildFTS(db)).not.toThrow();

    // Search should still work after rebuild
    const results = searchFTS(db, 'rebuild');
    expect(results).toHaveLength(1);
  });
});
