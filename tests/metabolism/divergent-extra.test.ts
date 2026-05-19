/**
 * divergent.ts 补充测试 — runKeystoneIdentification 额外场景
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../src/llm/extract.js', () => ({
  evaluateDivergentConnection: vi.fn().mockResolvedValue(null),
  generateCrystal: vi.fn().mockResolvedValue(null),
  enrichCrystalContent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/llm/link-judge.js', () => ({
  inferLinkType: vi.fn().mockReturnValue({ type: 'supports', confidence: 0.7 }),
  refineLinkTypeAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/graph/maturity.js', () => ({
  updateConnectivity: vi.fn(),
  computeMaturityScore: vi.fn().mockReturnValue(0.5),
  refreshMaturityScore: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: 'test-key' },
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
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => true,
}));

vi.mock('../../src/db/stats.js', () => ({
  getGateStatus: vi.fn().mockReturnValue({
    node_count: 600,
    link_count: 100,
    recall_count: 50,
    features: {
      basic_digest: true,
      bm25_search: true,
      vector_search: true,
      graph_expansion: true,
      crystal_generation: true,
      divergent_scan: true,
    },
  }),
  invalidateGateCache: vi.fn(),
  getGraphVocabulary: vi.fn().mockReturnValue({ crystalSummaries: [] }),
}));

vi.mock('../../src/db/log.js', () => ({
  logStrategyFeedback: vi.fn(),
  logTimelineEvent: vi.fn(),
  getRecallCount: vi.fn().mockReturnValue(50),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { runKeystoneIdentification } from '../../src/metabolism/divergent.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

describe('runKeystoneIdentification - 额外场景', () => {
  it('空数据库时不崩溃，返回 0', () => {
    const result = runKeystoneIdentification(db);
    expect(result).toBe(0);
  });

  it('只有一个节点时不标记 keystone', () => {
    seedNode(db, { content: 'only node' });

    const result = runKeystoneIdentification(db);
    expect(result).toBe(0);

    const keystones = db.prepare('SELECT id FROM nodes WHERE is_keystone = 1').all();
    expect(keystones).toHaveLength(0);
  });

  it('19 个节点时不标记 keystone（阈值 < 20）', () => {
    for (let i = 0; i < 19; i++) {
      seedNode(db, { content: `node ${i}` });
    }

    const result = runKeystoneIdentification(db);
    expect(result).toBe(0);
  });

  it('恰好 20 个节点时标记 top 5%（至少 1 个）', () => {
    const nodes = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(seedNode(db, { content: `node ${i}` }));
    }
    // 设置递增的 connectivity
    for (let i = 0; i < 20; i++) {
      db.prepare('UPDATE nodes SET connectivity = ? WHERE id = ?').run(i * 0.05, nodes[i].id);
    }

    const result = runKeystoneIdentification(db);
    // top 5% of 20 = ceil(1) = 1
    expect(result).toBe(1);

    const keystones = db.prepare('SELECT id FROM nodes WHERE is_keystone = 1').all() as Array<{ id: string }>;
    expect(keystones).toHaveLength(1);
    // 应该是 connectivity 最高的节点
    expect(keystones[0].id).toBe(nodes[19].id);
  });

  it('superseded 和 is_meta 节点不参与 keystone 计算', () => {
    // 创建 20 个正常节点
    const nodes = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(seedNode(db, { content: `node ${i}` }));
    }

    // 把最高 connectivity 的节点标记为 superseded
    db.prepare('UPDATE nodes SET connectivity = 10.0, is_superseded = 1 WHERE id = ?').run(nodes[19].id);
    for (let i = 0; i < 19; i++) {
      db.prepare('UPDATE nodes SET connectivity = ? WHERE id = ?').run(i * 0.05, nodes[i].id);
    }

    const result = runKeystoneIdentification(db);
    // 只有 19 个活跃节点（< 20），所以返回 0
    expect(result).toBe(0);
  });
});

import { scoreCandidatePair } from '../../src/metabolism/divergent';

describe('scoreCandidatePair (纯函数)', () => {
  it('shared=2, deg=2/2 → 1.0 (完美匹配)', () => {
    expect(scoreCandidatePair(2, 2, 2)).toBeCloseTo(1.0, 6);
  });

  it('hub 节点对子被压低', () => {
    // hub: degA=100, degB=100, shared=10 → 10/100 = 0.1
    const hubScore = scoreCandidatePair(10, 100, 100);
    // rare pair: degA=3, degB=3, shared=2 → 2/3 ≈ 0.667
    const rareScore = scoreCandidatePair(2, 3, 3);
    expect(rareScore).toBeGreaterThan(hubScore);
  });

  it('排序结果:rare pair > hub pair', () => {
    const candidates = [
      { id: 'hub', score: scoreCandidatePair(10, 100, 100) },
      { id: 'rare', score: scoreCandidatePair(2, 3, 3) },
      { id: 'mid', score: scoreCandidatePair(5, 20, 20) },
    ];
    candidates.sort((x, y) => y.score - x.score);
    expect(candidates.map(c => c.id)).toEqual(['rare', 'mid', 'hub']);
  });

  it('degA=0 或 degB=0 时 fallback 1 防除零', () => {
    expect(scoreCandidatePair(0, 0, 0)).toBe(0);
    expect(scoreCandidatePair(3, 0, 5)).toBe(3);  // denom=0 → fallback 1
  });

  it('shared=0 → score 0', () => {
    expect(scoreCandidatePair(0, 5, 5)).toBe(0);
  });
});
