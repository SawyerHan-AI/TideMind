/**
 * synaptic.ts 单元测试 — 突触衰减、归档、待确认链接处理
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

// ---- Mock LLM client ----
vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('no'),
}));

// ---- Mock maturity (used by nodes.ts createNode) ----
vi.mock('../../src/graph/maturity.js', () => ({
  refreshMaturityScore: vi.fn(),
  computeMaturityScore: (heat: number, refinement: number, connectivity: number, independence: number) => {
    return 0.2 * Math.min(heat, 1) + 0.3 * refinement + 0.3 * connectivity + 0.2 * independence;
  },
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { runSynapticScaling } from '../../src/metabolism/synaptic.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

// ===== runSynapticScaling — decay formula =====

describe('runSynapticScaling', () => {
  it('should decay heat with connectivity=0 by multiplying ~0.95', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 0, refinement = 0 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(node.id) as { heat: number };
    // decayRate = 1 - 0.05 * (1 - 0.8 * 0) = 1 - 0.05 = 0.95
    expect(after.heat).toBeCloseTo(0.95, 5);
  });

  it('should decay heat with connectivity=0.5 (slower but still decaying)', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 0.5, refinement = 0 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(node.id) as { heat: number };
    // decayRate = 1 - 0.05 * (1 - 0.8 * 0.5) = 1 - 0.05 * 0.6 = 0.97
    expect(after.heat).toBeCloseTo(0.97, 5);
    expect(after.heat).toBeLessThan(1.0); // 严格衰减
  });

  it('should decay heat with connectivity=1.0 (slowest but still decaying)', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 1.0, refinement = 0 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat FROM nodes WHERE id = ?').get(node.id) as { heat: number };
    // decayRate = 1 - 0.05 * (1 - 0.8 * 1.0) = 1 - 0.05 * 0.2 = 0.99
    expect(after.heat).toBeCloseTo(0.99, 5);
    expect(after.heat).toBeLessThan(1.0); // 严格衰减
  });

  it('should always decay (decay_rate < 1.0) for any connectivity value', () => {
    // 测试多个 connectivity 值，全部必须严格衰减
    for (const conn of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0]) {
      const node = seedNode(db, { heat: 1.0 });
      db.prepare('UPDATE nodes SET connectivity = ?, refinement = 0 WHERE id = ?').run(conn, node.id);
    }

    runSynapticScaling(db);

    const allNodes = db.prepare('SELECT heat FROM nodes WHERE heat > 0.01').all() as Array<{ heat: number }>;
    for (const n of allNodes) {
      expect(n.heat).toBeLessThan(1.0);
    }
  });

  it('should return correct decayed count', () => {
    seedNode(db, { heat: 1.0 });
    seedNode(db, { heat: 0.5 });

    const result = runSynapticScaling(db);
    expect(result.decayed).toBe(2);
  });

  it('should not process nodes with heat <= 0.01', () => {
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET heat = 0.005 WHERE id = ?').run(node.id);

    const result = runSynapticScaling(db);
    expect(result.decayed).toBe(0);
  });

  // ===== maturity_score atomicity =====

  it('should update maturity_score atomically with heat', () => {
    // 2026-05-19:heat 语义统一 [0,1] 后 fixture 不能用 2.0,用 1.0 起点。
    const node = seedNode(db, { heat: 1.0 });
    db.prepare('UPDATE nodes SET connectivity = 0.0, refinement = 0.4, independence = 0.3 WHERE id = ?').run(node.id);

    runSynapticScaling(db);

    const after = db.prepare('SELECT heat, maturity_score, refinement, connectivity, independence FROM nodes WHERE id = ?').get(node.id) as {
      heat: number;
      maturity_score: number;
      refinement: number;
      connectivity: number;
      independence: number;
    };

    // decayRate = 1 - 0.05 * (1 - 0) = 0.95, newHeat = 1.0 * 0.95 = 0.95
    // maturity = 0.2 * 0.95 + 0.3 * 0.4 + 0.3 * 0.0 + 0.2 * 0.3 = 0.19 + 0.12 + 0 + 0.06 = 0.37
    expect(after.heat).toBeCloseTo(0.95, 5);
    expect(after.maturity_score).toBeCloseTo(0.37, 5);
  });

  // ===== metadata timestamp =====

  it('should NOT write maintenance timestamp (delegated to scheduler.tryClaimTask)', () => {
    seedNode(db);
    runSynapticScaling(db);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").get() as { value: string } | undefined;
    // runSynapticScaling 不写 metadata,由 scheduler.ts::tryClaimTask 负责
    expect(row).toBeUndefined();
  });

  // 守护：heat 衰减是高频路径，updated 必须 bump。否则 cloud reconcile 永远
  // 看不到本地 heat 变化（client.updated == server.updated → 'same' → no-op），
  // server 永远存着初始 heat=1.0，多设备 recall 排序失真。
  it('should bump updated for every decayed node', async () => {
    const node = seedNode(db, { heat: 1.0 });
    const before = (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(node.id) as { updated: string }).updated;
    await new Promise(r => setTimeout(r, 5));
    runSynapticScaling(db);
    const after = (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(node.id) as { updated: string }).updated;
    expect(after > before).toBe(true);
  });
});

// claimMaintenance 已于 2026-04-21 删除 (见 synaptic.ts 注释)，
// 相关并发声明测试在 tests/metabolism/scheduler.test.ts 的 tryClaimTask 覆盖。
