/**
 * divergent.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const overrides: Record<string, number> = {
      min_heat_threshold: 0.1,
      max_active_nodes: 100,
      max_candidate_pairs: 10,
      min_shared_neighbors: 2,
      hub_min_links: 5,
      hub_min_diversity: 3,
      hub_min_indegree: 3,
    };
    return overrides[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../src/llm/extract.js', () => ({
  evaluateDivergentConnection: vi.fn().mockResolvedValue({
    has_connection: true,
    insight: 'test insight',
    confidence: 0.7,
    relation_type: 'analogous',
  }),
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
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import {
  runDivergentScan,
  runKeystoneIdentification,
} from '../../src/metabolism/divergent.js';
import { getGateStatus } from '../../src/db/stats.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== runKeystoneIdentification =====

describe('runKeystoneIdentification', () => {
  it('should return 0 when fewer than 20 active nodes', () => {
    for (let i = 0; i < 10; i++) {
      seedNode(db, { content: `node ${i}` });
    }
    const result = runKeystoneIdentification(db);
    expect(result).toBe(0);
  });

  it('should mark top 5% of nodes as keystone when >= 20 nodes', () => {
    const nodes = [];
    for (let i = 0; i < 25; i++) {
      nodes.push(seedNode(db, { content: `node ${i}` }));
    }
    // Set varying connectivity
    for (let i = 0; i < 25; i++) {
      db.prepare('UPDATE nodes SET connectivity = ? WHERE id = ?').run(i * 0.04, nodes[i].id);
    }

    const result = runKeystoneIdentification(db);
    // top 5% of 25 = ceil(1.25) = 2
    expect(result).toBe(2);

    // Verify the highest connectivity nodes are marked
    const keystones = db.prepare('SELECT id FROM nodes WHERE is_keystone = 1').all() as Array<{ id: string }>;
    expect(keystones).toHaveLength(2);
  });

  it('should clear old keystone marks before re-marking', () => {
    const nodes = [];
    for (let i = 0; i < 25; i++) {
      nodes.push(seedNode(db, { content: `node ${i}` }));
    }

    // Manually mark a node as keystone
    db.prepare('UPDATE nodes SET is_keystone = 1 WHERE id = ?').run(nodes[0].id);

    // Set lowest connectivity for node 0
    db.prepare('UPDATE nodes SET connectivity = 0 WHERE id = ?').run(nodes[0].id);
    for (let i = 1; i < 25; i++) {
      db.prepare('UPDATE nodes SET connectivity = ? WHERE id = ?').run(i * 0.04, nodes[i].id);
    }

    runKeystoneIdentification(db);

    // Node 0 should no longer be keystone (lowest connectivity)
    const node0 = db.prepare('SELECT is_keystone FROM nodes WHERE id = ?').get(nodes[0].id) as { is_keystone: number };
    expect(node0.is_keystone).toBe(0);
  });

  // 守护：keystone 标记变更会影响 UI（"关键种"标签）+ recall 排序，
  // 必须 bump updated 让 cloud reconcile 同步、UI watcher 感知。
  it('should bump updated on nodes whose is_keystone state changes', async () => {
    const nodes = [];
    for (let i = 0; i < 25; i++) {
      nodes.push(seedNode(db, { content: `node ${i}` }));
    }
    // 让 nodes[0] 已经是 keystone（会被 step1 清掉），nodes[24] 即将成为 keystone
    db.prepare('UPDATE nodes SET is_keystone = 1, updated = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', nodes[0].id);
    db.prepare('UPDATE nodes SET updated = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', nodes[24].id);
    for (let i = 0; i < 25; i++) {
      db.prepare('UPDATE nodes SET connectivity = ? WHERE id = ?').run(i * 0.04, nodes[i].id);
    }

    runKeystoneIdentification(db);

    const cleared = db.prepare('SELECT updated FROM nodes WHERE id = ?').get(nodes[0].id) as { updated: string };
    const promoted = db.prepare('SELECT updated FROM nodes WHERE id = ?').get(nodes[24].id) as { updated: string };
    expect(cleared.updated > '2020-01-01T00:00:00.000Z').toBe(true);
    expect(promoted.updated > '2020-01-01T00:00:00.000Z').toBe(true);
  });
});


// ===== runDivergentScan =====

describe('runDivergentScan', () => {
  it('should return empty when divergent_scan gate is disabled', async () => {
    vi.mocked(getGateStatus).mockReturnValueOnce({
      node_count: 10,
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
    });

    const result = await runDivergentScan(db);
    expect(result).toEqual([]);
  });

  it('should return empty when fewer than 10 active nodes', async () => {
    for (let i = 0; i < 5; i++) {
      seedNode(db, { content: `node ${i}` });
    }

    const result = await runDivergentScan(db);
    expect(result).toEqual([]);
  });
});

// needsWeeklyMaintenance 已于 2026-04-21 删除 (见 src/metabolism/divergent.ts 注释),
// 调度统一由 scheduler.ts::tryClaimTask 接管,按任务级 last_task_{id} 粒度判定。
