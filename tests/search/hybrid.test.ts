/**
 * 混合搜索单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks（在所有 import 之前） ----

// 向量 embedding 模拟（不会被实际调用，因为 vec gate 关闭）
vi.mock('../../src/llm/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(3072)),
}));

// 策略加载器：所有参数返回 fallback 值
vi.mock('../../src/strategy/loader.js', () => ({
  getStrategyParam: (key: string, fallback: number) => fallback,
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

// 模拟 stats 模块，确保 vector_search gate 关闭
vi.mock('../../src/db/stats.js', () => ({
  getGateStatus: () => ({
    node_count: 0,
    link_count: 0,
    recall_count: 0,
    features: {
      basic_digest: true,
      bm25_search: true,
      vector_search: false,
      graph_expansion: false,
      crystal_generation: false,
      divergent_scan: false,
    },
  }),
  invalidateGateCache: () => {},
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { searchHybrid } from '../../src/search/hybrid.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  db = setupTestDb();
  repo = new SqliteRepository(db);
});

// ===== BM25-only 模式（vec 未加载） =====

describe('searchHybrid - BM25-only fallback', () => {
  it('should return results using BM25 when vector search is disabled', async () => {
    seedNode(db, { content: 'photosynthesis chloroplast mechanism' });
    seedNode(db, { content: 'unrelated database indexing' });

    const results = await searchHybrid(repo, 'photosynthesis');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.content).toContain('photosynthesis');
    expect(results[0].source).toBe('hybrid');
  });

  it('should return empty array when nothing matches', async () => {
    seedNode(db, { content: 'simple content here' });

    const results = await searchHybrid(repo, 'xylophone');
    expect(results).toEqual([]);
  });

  it('should sort results by score descending', async () => {
    // Create multiple nodes with the keyword for ranking
    seedNode(db, { content: 'fibonacci sequence mathematical algorithm' });
    seedNode(db, { content: 'fibonacci number golden ratio fibonacci' });
    seedNode(db, { content: 'unrelated cooking recipe' });

    const results = await searchHybrid(repo, 'fibonacci');
    expect(results.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 8; i++) {
      seedNode(db, { content: `distributed computing worker node ${i}` });
    }

    const results = await searchHybrid(repo, 'distributed', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should filter by type', async () => {
    seedNode(db, { content: 'encryption algorithm standard', type: 'fact' });
    seedNode(db, { content: 'encryption protocol design', type: 'idea' });

    const results = await searchHybrid(repo, 'encryption', { type: 'fact' });
    expect(results).toHaveLength(1);
    expect(results[0].node.type).toBe('fact');
  });

  it('should filter by type', async () => {
    seedNode(db, { content: 'compiler optimization technique', type: 'fact' });
    seedNode(db, { content: 'compiler improvement idea', type: 'idea' });

    const results = await searchHybrid(repo, 'compiler', { type: 'fact' });
    expect(results).toHaveLength(1);
    expect(results[0].node.type).toBe('fact');
  });
});

// ===== Intent 权重 =====

describe('searchHybrid - intent weights', () => {
  it('should return results with creative intent', async () => {
    seedNode(db, { content: 'paradigm divergent thinking brainstorm' });

    const results = await searchHybrid(repo, 'paradigm', { intent: 'creative' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('should return results with factual intent', async () => {
    seedNode(db, { content: 'thermodynamics entropy calculation' });

    const results = await searchHybrid(repo, 'thermodynamics', { intent: 'factual' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('should return results with exploratory intent', async () => {
    seedNode(db, { content: 'topology manifold differential geometry' });

    const results = await searchHybrid(repo, 'topology', { intent: 'exploratory' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('should produce different scores for different intents on same data', async () => {
    // Create nodes with varying maturity attributes
    seedNode(db, {
      content: 'metamorphosis biological transformation',
      heat: 0.9,
      refinement: 0.8,
      independence: 0.9,
    });

    const factual = await searchHybrid(repo, 'metamorphosis', { intent: 'factual' });
    const creative = await searchHybrid(repo, 'metamorphosis', { intent: 'creative' });

    expect(factual.length).toBeGreaterThanOrEqual(1);
    expect(creative.length).toBeGreaterThanOrEqual(1);

    // Creative uses alpha=0.2 vs default alpha=0.3, beta=0.6 vs 0.5
    // In BM25-only mode (vectorScore=0), this means creative gives less weight to BM25
    // So the scores should differ
    expect(factual[0].score).not.toBeCloseTo(creative[0].score, 5);
  });
});

// ===== 邻居扩展 =====

describe('searchHybrid - neighbor expansion', () => {
  it('should expand to neighbors via confirmed strong links', async () => {
    const nodeA = seedNode(db, { content: 'blockchain consensus protocol' });
    const nodeB = seedNode(db, { content: 'unrelated neighbor pottery ceramics' });

    // Create a confirmed link with high strength
    seedLink(db, nodeA.id, nodeB.id, {
      relation: 'supports',
      strength: 0.8,
      status: 'confirmed',
    });

    const results = await searchHybrid(repo, 'blockchain', { limit: 20 });

    // nodeA should be found via BM25, nodeB should be expanded as neighbor
    const ids = results.map(r => r.node.id);
    expect(ids).toContain(nodeA.id);
    expect(ids).toContain(nodeB.id);
  });

  it('should apply 0.7 decay to neighbor scores', async () => {
    const nodeA = seedNode(db, {
      content: 'heuristic optimization search',
      heat: 0.7,
    });
    const nodeB = seedNode(db, {
      content: 'unrelated neighbor gardening tulips',
      heat: 0.7,
    });

    seedLink(db, nodeA.id, nodeB.id, {
      relation: 'supports',
      strength: 0.9,
      status: 'confirmed',
    });

    const results = await searchHybrid(repo, 'heuristic', { limit: 20 });

    const mainResult = results.find(r => r.node.id === nodeA.id);
    const neighborResult = results.find(r => r.node.id === nodeB.id);

    expect(mainResult).toBeDefined();
    expect(neighborResult).toBeDefined();

    // Neighbor score should be lower than main result (due to 0.7 decay and no BM25 score)
    expect(neighborResult!.score).toBeLessThan(mainResult!.score);
  });

  it('should not expand through pending or weak links', async () => {
    const nodeA = seedNode(db, { content: 'cryptography elliptic curve' });
    const nodeB = seedNode(db, { content: 'unrelated neighbor swimming pool' });
    const nodeC = seedNode(db, { content: 'unrelated neighbor mountain hiking' });

    // Pending link - should not expand
    seedLink(db, nodeA.id, nodeB.id, {
      relation: 'supports',
      strength: 0.8,
      status: 'pending',
    });

    // Weak confirmed link (strength <= 0.5) - should not expand
    seedLink(db, nodeA.id, nodeC.id, {
      relation: 'supports',
      strength: 0.3,
      status: 'confirmed',
    });

    const results = await searchHybrid(repo, 'cryptography', { limit: 20 });

    const ids = results.map(r => r.node.id);
    expect(ids).toContain(nodeA.id);
    expect(ids).not.toContain(nodeB.id);
    expect(ids).not.toContain(nodeC.id);
  });

  it('should not include archived neighbors in expansion', async () => {
    const nodeA = seedNode(db, { content: 'polynomial regression analysis' });
    const nodeB = seedNode(db, { content: 'unrelated neighbor archived content' });

    seedLink(db, nodeA.id, nodeB.id, {
      relation: 'supports',
      strength: 0.9,
      status: 'confirmed',
    });

    // Archive the neighbor
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(nodeB.id);

    const results = await searchHybrid(repo, 'polynomial', { limit: 20 });

    const ids = results.map(r => r.node.id);
    expect(ids).toContain(nodeA.id);
    expect(ids).not.toContain(nodeB.id);
  });
});

// ===== getLinkRelationBoost with non-array relation data =====

describe('searchHybrid - link relation boost edge cases', () => {
  it('should handle links with non-array relation data gracefully in neighbor expansion', async () => {
    const nodeA = seedNode(db, { content: 'quantum mechanics particles' });
    const nodeB = seedNode(db, { content: 'unrelated neighbor music theory' });

    // Create a confirmed link, then manually corrupt the relation to non-array
    const link = seedLink(db, nodeA.id, nodeB.id, {
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.8,
      status: 'confirmed',
    });

    // Corrupt the relation field to a non-array value
    if (link) {
      db.prepare('UPDATE links SET relation = ? WHERE id = ?').run('"not-an-array"', link.id);
    }

    // Should not throw, and nodeB should still appear (with boost = 1.0 fallback)
    const results = await searchHybrid(repo, 'quantum', { limit: 20 });
    const ids = results.map(r => r.node.id);
    expect(ids).toContain(nodeA.id);
    // nodeB may or may not appear depending on score, but no crash
  });

  it('should boost analogous links with creative intent', async () => {
    const nodeA = seedNode(db, { content: 'neural network architecture deep learning' });
    const nodeB = seedNode(db, { content: 'unrelated neighbor analogous biology', heat: 0.7 });

    seedLink(db, nodeA.id, nodeB.id, {
      relation: [{ type: 'analogous', confidence: 0.8 }],
      strength: 0.6,
      status: 'confirmed',
    });

    const results = await searchHybrid(repo, 'neural network', { intent: 'creative', limit: 20 });
    const ids = results.map(r => r.node.id);
    expect(ids).toContain(nodeA.id);
    // With creative intent, analogous links get 1.5x boost AND minStrength is 0.3
    // so nodeB should appear
    expect(ids).toContain(nodeB.id);
  });

  it('should exclude meta nodes from expansion when excludeMeta is true', async () => {
    const nodeA = seedNode(db, { content: 'statistics regression correlation' });
    const metaNode = seedNode(db, { type: 'meta', content: 'meta neighbor about system' });

    seedLink(db, nodeA.id, metaNode.id, {
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.8,
      status: 'confirmed',
    });

    const results = await searchHybrid(repo, 'statistics', { limit: 20, excludeMeta: true });
    const ids = results.map(r => r.node.id);
    expect(ids).toContain(nodeA.id);
    expect(ids).not.toContain(metaNode.id);
  });

  it('should exclude off-type neighbor nodes when type filter is set (2026-05-29 round-5 回归)', async () => {
    // 邻居扩展是 bm25/vector 之外的第三个结果源；修复前它只过滤 excludeMeta，不过滤 type，
    // 导致 type:'fact' 查询会漏返与命中 fact 强关联的 idea/context 邻居。
    const factNode = seedNode(db, { type: 'fact', content: 'statistics regression correlation analysis' });
    const ideaNeighbor = seedNode(db, { type: 'idea', content: 'idea neighbor strongly linked to the fact' });

    seedLink(db, factNode.id, ideaNeighbor.id, {
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.8,
      status: 'confirmed',
    });

    const results = await searchHybrid(repo, 'statistics', { limit: 20, type: 'fact' });
    const ids = results.map(r => r.node.id);
    expect(ids).toContain(factNode.id);
    // idea 邻居即便强关联,也不应出现在 type:'fact' 查询结果里
    expect(ids).not.toContain(ideaNeighbor.id);
  });
});
