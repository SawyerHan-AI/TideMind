/**
 * feedback-signals.ts 测试 — 行为指标采集
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
      vector_search: 50, graph_expansion: 100, graph_expansion_links: 50,
      crystal_generation: 200, divergent_scan: 500,
      learning_2_min_nodes: 500, learning_2_min_recall_ops: 200,
    },
    metabolism: { daily_check_hours: 24, weekly_check_days: 7 },
  }),
  isLlmConfigured: () => false,
}));

vi.mock('../../src/graph/maturity.js', () => ({
  refreshMaturityScore: vi.fn(),
  computeMaturityScore: (h: number, r: number, c: number, i: number) =>
    0.2 * Math.min(h, 1) + 0.3 * r + 0.3 * c + 0.2 * i,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { logOperation } from '../../src/db/log.js';
import {
  collectLinkSurvival,
  collectRecallHitRate,
  collectCorrectionRate,
  collectSessionContinuity,
  collectAllSignals,
  SIGNAL_PARAM_MAP,
} from '../../src/evolution/feedback-signals.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

// ── 辅助函数 ──────────────────────────────────────────────────

function getParamFeedbackRows(db: Database.Database) {
  return db.prepare('SELECT * FROM param_feedback ORDER BY id').all() as Array<{
    id: number; strategy_name: string; signal_type: string;
    signal_value: number; context: string;
  }>;
}

function insertAutoLink(db: Database.Database, fromId: string, toId: string, daysAgo: number, strength: number = 0.5) {
  const created = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO links (id, from_id, to_id, relation, strength, auto, status, created)
    VALUES (?, ?, ?, ?, ?, 1, 'confirmed', ?)
  `).run(`link-${Math.random().toString(36).slice(2, 8)}`, fromId, toId, '[{"type":"supports","confidence":0.7}]', strength, created);
}

function insertOldNode(db: Database.Database, daysAgo: number): string {
  const node = seedNode(db, { content: `old node ${daysAgo}d ago` });
  const created = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE nodes SET created = ? WHERE id = ?').run(created, node.id);
  return node.id;
}

function insertOperation(db: Database.Database, operation: string, opts: {
  input_summary?: string;
  output_node_ids?: string[];
  session?: string;
  daysAgo?: number;
}) {
  const created = opts.daysAgo
    ? new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000).toISOString()
    : new Date().toISOString();
  db.prepare(`
    INSERT INTO operation_log (operation, input_summary, output_node_ids, session, created)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    operation,
    opts.input_summary ?? null,
    opts.output_node_ids ? JSON.stringify(opts.output_node_ids) : null,
    opts.session ?? null,
    created,
  );
}

// ── collectLinkSurvival ──────────────────────────────────────

describe('collectLinkSurvival', () => {
  it('样本不足时不写入反馈', () => {
    // 只创建 2 条链接（< 5）
    const nodes = [seedNode(db), seedNode(db), seedNode(db)];
    insertAutoLink(db, nodes[0].id, nodes[1].id, 10);
    insertAutoLink(db, nodes[1].id, nodes[2].id, 10);

    collectLinkSurvival(db);
    expect(getParamFeedbackRows(db)).toHaveLength(0);
  });

  it('高强度链接产生正向信号', () => {
    const nodes: string[] = [];
    for (let i = 0; i < 12; i++) nodes.push(seedNode(db).id);

    // 创建 6 条 7-14 天前的高强度链接
    for (let i = 0; i < 6; i++) {
      insertAutoLink(db, nodes[i], nodes[i + 1], 10, 0.45);
    }
    // 创建 6 条 14-21 天前的链接（旧窗口，用于淘汰率估算）
    for (let i = 6; i < 11; i++) {
      insertAutoLink(db, nodes[i], nodes[i + 1], 18, 0.4);
    }

    collectLinkSurvival(db);
    const rows = getParamFeedbackRows(db);

    // 应该写入了 link_survival 类型的反馈（每个映射策略一条）
    expect(rows.length).toBe(SIGNAL_PARAM_MAP.link_survival.length);
    expect(rows[0].signal_type).toBe('link_survival');
    // 平均强度 0.45 > 基准 0.3 → 正向信号
    expect(rows[0].signal_value).toBeGreaterThan(0);
  });

  it('低强度链接产生负向信号', () => {
    const nodes: string[] = [];
    for (let i = 0; i < 7; i++) nodes.push(seedNode(db).id);

    // 创建 6 条 7-14 天前的低强度链接
    for (let i = 0; i < 6; i++) {
      insertAutoLink(db, nodes[i], nodes[i + 1], 10, 0.1);
    }

    collectLinkSurvival(db);
    const rows = getParamFeedbackRows(db);
    expect(rows.length).toBeGreaterThan(0);
    // 平均强度 0.1 < 基准 0.3 → 负向信号
    expect(rows[0].signal_value).toBeLessThan(0);
  });
});

// ── collectRecallHitRate ─────────────────────────────────────

describe('collectRecallHitRate', () => {
  it('样本不足时不写入反馈', () => {
    // 创建 5 个旧节点（< 10）
    for (let i = 0; i < 5; i++) insertOldNode(db, 45);

    collectRecallHitRate(db);
    expect(getParamFeedbackRows(db)).toHaveLength(0);
  });

  it('有 recall 命中的节点产生正向信号', () => {
    const nodeIds: string[] = [];
    for (let i = 0; i < 12; i++) nodeIds.push(insertOldNode(db, 45));

    // 让其中 8 个被 recall 命中
    for (let i = 0; i < 8; i++) {
      insertOperation(db, 'recall', { output_node_ids: [nodeIds[i]], daysAgo: 20 });
    }

    collectRecallHitRate(db);
    const rows = getParamFeedbackRows(db);
    expect(rows.length).toBe(SIGNAL_PARAM_MAP.recall_hit.length);
    // 命中率 8/12 ≈ 0.67 > 基准 0.3 → 正向
    expect(rows[0].signal_value).toBeGreaterThan(0);
  });

  it('零命中产生负向信号', () => {
    for (let i = 0; i < 12; i++) insertOldNode(db, 45);
    // 没有 recall 操作

    collectRecallHitRate(db);
    const rows = getParamFeedbackRows(db);
    expect(rows.length).toBe(SIGNAL_PARAM_MAP.recall_hit.length);
    // 命中率 0 < 基准 0.3 → 负向
    expect(rows[0].signal_value).toBeLessThan(0);
  });
});

// ── collectCorrectionRate ────────────────────────────────────

describe('collectCorrectionRate', () => {
  it('样本不足时不写入反馈', () => {
    for (let i = 0; i < 5; i++) {
      insertOperation(db, 'digest', { input_summary: 'new content' });
    }
    collectCorrectionRate(db);
    expect(getParamFeedbackRows(db)).toHaveLength(0);
  });

  it('零 correction 产生正向信号', () => {
    for (let i = 0; i < 20; i++) {
      insertOperation(db, 'digest', { input_summary: 'new content' });
    }
    collectCorrectionRate(db);
    const rows = getParamFeedbackRows(db);
    expect(rows.length).toBe(SIGNAL_PARAM_MAP.correction.length);
    // 0% correction → signal = (0.05 - 0) * 20 = 1.0
    expect(rows[0].signal_value).toBe(1);
  });

  it('高 correction 率产生负向信号', () => {
    for (let i = 0; i < 10; i++) {
      insertOperation(db, 'digest', { input_summary: 'new content' });
    }
    for (let i = 0; i < 10; i++) {
      insertOperation(db, 'digest', { input_summary: 'correction: node-xyz' });
    }
    collectCorrectionRate(db);
    const rows = getParamFeedbackRows(db);
    // correction 率 50% → signal = (0.05 - 0.5) * 20 = -9.0 → clamped to -1
    expect(rows[0].signal_value).toBe(-1);
  });
});

// ── collectSessionContinuity ─────────────────────────────────

describe('collectSessionContinuity', () => {
  it('样本不足时不写入反馈', () => {
    for (let i = 0; i < 5; i++) {
      insertOperation(db, 'recall', { session: 'sess-1' });
    }
    collectSessionContinuity(db);
    expect(getParamFeedbackRows(db)).toHaveLength(0);
  });

  it('recall 后有 digest 产生正向信号', () => {
    // 10 次 recall，每次后面都跟着 digest（同 session）
    for (let i = 0; i < 10; i++) {
      const session = `sess-${i}`;
      const baseTime = new Date(Date.now() - (10 - i) * 60 * 60 * 1000); // 依次间隔1小时
      db.prepare(`
        INSERT INTO operation_log (operation, session, created)
        VALUES ('recall', ?, ?)
      `).run(session, baseTime.toISOString());
      // 5 分钟后 digest
      db.prepare(`
        INSERT INTO operation_log (operation, session, created)
        VALUES ('digest', ?, ?)
      `).run(session, new Date(baseTime.getTime() + 5 * 60 * 1000).toISOString());
    }

    collectSessionContinuity(db);
    const rows = getParamFeedbackRows(db);
    expect(rows.length).toBe(SIGNAL_PARAM_MAP.session_continuity.length);
    // 100% 连续性 > 基准 0.4 → 正向
    expect(rows[0].signal_value).toBeGreaterThan(0);
  });
});

// ── collectAllSignals ────────────────────────────────────────

describe('collectAllSignals', () => {
  it('空数据库不抛错', () => {
    expect(() => collectAllSignals(db)).not.toThrow();
    // 样本不够，不应写入任何反馈
    expect(getParamFeedbackRows(db)).toHaveLength(0);
  });
});

// ── SIGNAL_PARAM_MAP ─────────────────────────────────────────

describe('SIGNAL_PARAM_MAP', () => {
  it('包含全部 5 种信号类型', () => {
    expect(Object.keys(SIGNAL_PARAM_MAP)).toEqual(
      expect.arrayContaining(['link_survival', 'recall_hit', 'correction', 'node_awakening', 'session_continuity'])
    );
  });

  it('每种信号至少映射一个策略', () => {
    for (const [type, mappings] of Object.entries(SIGNAL_PARAM_MAP)) {
      expect(mappings.length).toBeGreaterThan(0);
      for (const m of mappings) {
        expect(m.strategy).toBeTruthy();
        expect(m.params.length).toBeGreaterThan(0);
      }
    }
  });
});
