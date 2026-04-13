/**
 * learning2.ts 测试 — Learning II 参数趋势调优引擎
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- Mock strategy loader ----
const mockGetStrategy = vi.fn();
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: any) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: (...args: any[]) => mockGetStrategy(...args),
  getLLMOptions: () => ({ model: 'standard' as const }),
  renderUserPrompt: (_strategy: string, _vars: any, fallback: string) => fallback,
}));

// ---- Mock config ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-test-'));
vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: tmpDir, user_name: 'test' },
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
      learning_2_min_nodes: 5, learning_2_min_recall_ops: 2, // 降低门槛方便测试
    },
    metabolism: { daily_check_hours: 24, weekly_check_days: 7 },
  }),
  isLlmConfigured: () => false,
}));

// ---- Mock LLM client ----
const mockCallLLM = vi.fn();
vi.mock('../../src/llm/client.js', () => ({
  callLLM: (...args: any[]) => mockCallLLM(...args),
}));

// ---- Mock maturity ----
vi.mock('../../src/graph/maturity.js', () => ({
  refreshMaturityScore: vi.fn(),
  computeMaturityScore: (h: number, r: number, c: number, i: number) =>
    0.2 * Math.min(h, 1) + 0.3 * r + 0.3 * c + 0.2 * i,
}));

// ---- Mock feedback-signals (avoid DB-heavy signal collection in unit tests) ----
vi.mock('../../src/evolution/feedback-signals.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    collectAllSignals: vi.fn(),
  };
});

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { logParamFeedback } from '../../src/db/log.js';
import { canRunLearning2, runLearning2, checkMonitoringWindows } from '../../src/evolution/learning2.js';
import { invalidateGateCache } from '../../src/db/stats.js';

let db: Database.Database;
let strategiesDir: string;

beforeEach(() => {
  db = setupTestDb();
  invalidateGateCache();
  vi.clearAllMocks();

  // 创建临时策略目录
  strategiesDir = path.join(tmpDir, 'strategies');
  fs.mkdirSync(strategiesDir, { recursive: true });

  // 清理旧文件
  for (const f of fs.readdirSync(strategiesDir)) {
    fs.unlinkSync(path.join(strategiesDir, f));
  }
});

// ── 辅助函数 ──────────────────────────────────────────────────

function seedRecallOps(db: Database.Database, count: number) {
  for (let i = 0; i < count; i++) {
    db.prepare(`INSERT INTO operation_log (operation, created) VALUES ('recall', datetime('now'))`).run();
  }
}

function writeStrategyFile(name: string, content: string) {
  fs.writeFileSync(path.join(strategiesDir, `${name}.md`), content);
}

function readStrategyFile(name: string): string {
  return fs.readFileSync(path.join(strategiesDir, `${name}.md`), 'utf-8');
}

function insertParamFeedback(db: Database.Database, strategyName: string, signalType: string, value: number, daysAgo: number) {
  const created = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO param_feedback (strategy_name, signal_type, signal_value, created)
    VALUES (?, ?, ?, ?)
  `).run(strategyName, signalType, value, created);
}

function insertParamAdjustment(db: Database.Database, opts: {
  strategy_name: string; param_name: string; signal_type: string;
  old_value: number; new_value: number;
  pre_avg: number; status?: string;
  monitoring_start?: string; monitoring_end?: string;
}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO param_adjustments (strategy_name, param_name, signal_type, old_value, new_value, reason, status, pre_avg, monitoring_start, monitoring_end, created)
    VALUES (?, ?, ?, ?, ?, 'test', ?, ?, ?, ?, ?)
  `).run(
    opts.strategy_name, opts.param_name, opts.signal_type,
    opts.old_value, opts.new_value,
    opts.status ?? 'active', opts.pre_avg,
    opts.monitoring_start ?? new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    opts.monitoring_end ?? new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    now,
  );
}

// ── canRunLearning2 ──────────────────────────────────────────

describe('canRunLearning2', () => {
  it('节点和 recall 都不够时返回 false', () => {
    expect(canRunLearning2(db)).toBe(false);
  });

  it('满足门控时返回 true', () => {
    // config mock 中 min_nodes=5, min_recall_ops=2
    for (let i = 0; i < 5; i++) seedNode(db);
    seedRecallOps(db, 2);
    expect(canRunLearning2(db)).toBe(true);
  });
});

// ── checkMonitoringWindows ───────────────────────────────────

describe('checkMonitoringWindows', () => {
  const evolutionLogPath = () => path.join(strategiesDir, 'evolution-log.jsonl');

  it('没有到期的调整时返回空', () => {
    const result = checkMonitoringWindows(db, strategiesDir, evolutionLogPath());
    expect(result.rollbacks).toHaveLength(0);
    expect(result.confirmations).toHaveLength(0);
  });

  it('监控期间反馈更差时回滚', () => {
    writeStrategyFile('test-strategy', `# Test\n\n| 参数 | 值 | 说明 |\n|------|-----|------|\n| threshold | 0.55 | test |\n`);

    // 插入一条已到期的调整：0.5 → 0.55
    const monitorStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const monitorEnd = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    insertParamAdjustment(db, {
      strategy_name: 'test-strategy', param_name: 'threshold', signal_type: 'link_survival',
      old_value: 0.5, new_value: 0.55, pre_avg: 0.6,
      monitoring_start: monitorStart, monitoring_end: monitorEnd,
    });

    // 在监控窗口内插入差反馈
    for (let i = 0; i < 5; i++) {
      const created = new Date(Date.now() - (7 - i) * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO param_feedback (strategy_name, signal_type, signal_value, created) VALUES (?, ?, ?, ?)`)
        .run('test-strategy', 'link_survival', -0.5, created);
    }

    const result = checkMonitoringWindows(db, strategiesDir, evolutionLogPath());
    expect(result.rollbacks).toContain('test-strategy.threshold');

    // 文件应该被回滚到 0.5
    const content = readStrategyFile('test-strategy');
    expect(content).toContain('0.5');

    // DB 状态应更新
    const adj = db.prepare('SELECT status FROM param_adjustments WHERE strategy_name = ?').get('test-strategy') as any;
    expect(adj.status).toBe('rolled_back');
  });

  it('监控期间反馈持平或改善时确认', () => {
    writeStrategyFile('test-strategy', `# Test\n\n| 参数 | 值 | 说明 |\n|------|-----|------|\n| threshold | 0.55 | test |\n`);

    insertParamAdjustment(db, {
      strategy_name: 'test-strategy', param_name: 'threshold', signal_type: 'link_survival',
      old_value: 0.5, new_value: 0.55, pre_avg: 0.3,
    });

    // 在监控窗口内插入好反馈
    for (let i = 0; i < 5; i++) {
      const created = new Date(Date.now() - (7 - i) * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO param_feedback (strategy_name, signal_type, signal_value, created) VALUES (?, ?, ?, ?)`)
        .run('test-strategy', 'link_survival', 0.5, created);
    }

    const result = checkMonitoringWindows(db, strategiesDir, evolutionLogPath());
    expect(result.confirmations).toContain('test-strategy.threshold');

    const adj = db.prepare('SELECT status FROM param_adjustments WHERE strategy_name = ?').get('test-strategy') as any;
    expect(adj.status).toBe('confirmed');
  });

  it('只比较同类型信号（不混合）', () => {
    writeStrategyFile('metabolism-params', `# Test\n\n| 参数 | 值 | 说明 |\n|------|-----|------|\n| decay_base | 0.055 | test |\n`);

    insertParamAdjustment(db, {
      strategy_name: 'metabolism-params', param_name: 'decay_base', signal_type: 'node_awakening',
      old_value: 0.05, new_value: 0.055, pre_avg: 0.3,
    });

    // 插入 link_survival 信号（不同类型）= 差反馈
    for (let i = 0; i < 5; i++) {
      const created = new Date(Date.now() - (7 - i) * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO param_feedback (strategy_name, signal_type, signal_value, created) VALUES (?, ?, ?, ?)`)
        .run('metabolism-params', 'link_survival', -0.8, created);
    }

    // 插入 node_awakening 信号（同类型）= 好反馈
    for (let i = 0; i < 5; i++) {
      const created = new Date(Date.now() - (7 - i) * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO param_feedback (strategy_name, signal_type, signal_value, created) VALUES (?, ?, ?, ?)`)
        .run('metabolism-params', 'node_awakening', 0.5, created);
    }

    const result = checkMonitoringWindows(db, strategiesDir, path.join(strategiesDir, 'evolution-log.jsonl'));
    // 应该用 node_awakening 信号判断（好反馈），所以确认而非回滚
    expect(result.confirmations).toContain('metabolism-params.decay_base');
    expect(result.rollbacks).toHaveLength(0);
  });
});

// ── runLearning2 ─────────────────────────────────────────────

describe('runLearning2', () => {
  it('门控不通过时直接返回', async () => {
    const result = await runLearning2(db);
    expect(result.signals_collected).toBe(false);
    expect(result.adjustments).toHaveLength(0);
  });

  it('门控通过但反馈不够时不调整', async () => {
    for (let i = 0; i < 5; i++) seedNode(db);
    seedRecallOps(db, 2);

    const result = await runLearning2(db);
    expect(result.signals_collected).toBe(true);
    expect(result.adjustments).toHaveLength(0);
  });

  it('趋势下降时调用 LLM 并调整参数', async () => {
    // 满足门控
    for (let i = 0; i < 5; i++) seedNode(db);
    seedRecallOps(db, 2);

    // 写策略文件
    writeStrategyFile('recall-search', [
      '# Recall Search',
      '',
      '| 参数 | 值 | 说明 |',
      '|------|-----|------|',
      '| alpha | 0.3 | BM25 权重 |',
      '| beta | 0.5 | 向量权重 |',
    ].join('\n'));

    // mock getStrategy 返回策略数据
    mockGetStrategy.mockImplementation((name: string) => {
      if (name === 'recall-search') {
        return { name, version: 1, status: 'active', systemPrompt: null, params: { alpha: 0.3, beta: 0.5 }, rawContent: '' };
      }
      return null;
    });

    // 插入足够反馈：前半好后半差（趋势下降）
    for (let i = 0; i < 15; i++) {
      insertParamFeedback(db, 'recall-search', 'recall_hit', 0.6, 25 - i); // 早期：好
    }
    for (let i = 0; i < 15; i++) {
      insertParamFeedback(db, 'recall-search', 'recall_hit', 0.1, 10 - i); // 近期：差
    }

    // LLM 建议 decrease
    mockCallLLM.mockResolvedValue('{"direction": "decrease", "reason": "recall 命中率下降，降低 BM25 权重试试"}');

    const result = await runLearning2(db);
    expect(result.adjustments.length).toBeGreaterThan(0);
    expect(result.adjustments[0]).toContain('alpha');

    // 文件应该被更新
    const content = readStrategyFile('recall-search');
    expect(content).not.toContain('| alpha | 0.3 '); // 值应该变了

    // DB 应有调整记录
    const adj = db.prepare('SELECT * FROM param_adjustments WHERE strategy_name = ?').get('recall-search') as any;
    expect(adj).toBeTruthy();
    expect(adj.status).toBe('active');
    expect(adj.signal_type).toBe('recall_hit');
    expect(adj.old_value).toBe(0.3);
    expect(adj.new_value).toBeCloseTo(0.27, 2); // 0.3 * 0.9 = 0.27

    // LLM 应该被调用
    expect(mockCallLLM).toHaveBeenCalled();
  });

  it('LLM 返回 hold 时不调整', async () => {
    for (let i = 0; i < 5; i++) seedNode(db);
    seedRecallOps(db, 2);

    writeStrategyFile('recall-search', '# Test\n\n| 参数 | 值 | 说明 |\n|------|-----|------|\n| alpha | 0.3 | test |\n');

    mockGetStrategy.mockImplementation((name: string) => {
      if (name === 'recall-search') return { name, version: 1, status: 'active', systemPrompt: null, params: { alpha: 0.3 }, rawContent: '' };
      return null;
    });

    for (let i = 0; i < 15; i++) insertParamFeedback(db, 'recall-search', 'recall_hit', 0.6, 25 - i);
    for (let i = 0; i < 15; i++) insertParamFeedback(db, 'recall-search', 'recall_hit', 0.1, 10 - i);

    mockCallLLM.mockResolvedValue('{"direction": "hold", "reason": "信号不够明确"}');

    const result = await runLearning2(db);
    expect(result.adjustments).toHaveLength(0);
  });

  it('冷却期内不重复调整同一策略', async () => {
    for (let i = 0; i < 5; i++) seedNode(db);
    seedRecallOps(db, 2);

    writeStrategyFile('recall-search', '# Test\n\n| 参数 | 值 | 说明 |\n|------|-----|------|\n| alpha | 0.3 | test |\n');
    mockGetStrategy.mockImplementation((name: string) => {
      if (name === 'recall-search') return { name, version: 1, status: 'active', systemPrompt: null, params: { alpha: 0.3 }, rawContent: '' };
      return null;
    });

    // 插入一条最近的调整（3天前）
    db.prepare(`
      INSERT INTO param_adjustments (strategy_name, param_name, signal_type, old_value, new_value, reason, status, pre_avg, monitoring_start, monitoring_end, created)
      VALUES ('recall-search', 'alpha', 'recall_hit', 0.3, 0.27, 'test', 'confirmed', 0.5, ?, ?, ?)
    `).run(
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    );

    for (let i = 0; i < 15; i++) insertParamFeedback(db, 'recall-search', 'recall_hit', 0.6, 25 - i);
    for (let i = 0; i < 15; i++) insertParamFeedback(db, 'recall-search', 'recall_hit', 0.1, 10 - i);

    mockCallLLM.mockResolvedValue('{"direction": "decrease", "reason": "test"}');

    const result = await runLearning2(db);
    // 冷却期 14 天内，不应调整
    expect(result.adjustments).toHaveLength(0);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('清理旧 A/B 测试残留', async () => {
    for (let i = 0; i < 5; i++) seedNode(db);
    seedRecallOps(db, 2);

    // 插入旧 metadata
    db.prepare("INSERT INTO metadata (key, value) VALUES ('learning2:variant:test', '{}')").run();

    // 创建旧 variant 文件
    writeStrategyFile('test.variant-abc', '# old variant');
    writeStrategyFile('test.backup-abc', '# old backup');

    await runLearning2(db);

    // 旧 metadata 应被清除
    const oldMeta = db.prepare("SELECT * FROM metadata WHERE key LIKE 'learning2:variant:%'").all();
    expect(oldMeta).toHaveLength(0);

    // 旧文件应被删除
    const files = fs.readdirSync(strategiesDir);
    expect(files.some(f => f.includes('.variant-'))).toBe(false);
    expect(files.some(f => f.includes('.backup-'))).toBe(false);

    // 清理标记应存在
    const cleaned = db.prepare("SELECT * FROM metadata WHERE key = 'learning2_legacy_cleaned'").get();
    expect(cleaned).toBeTruthy();
  });
});

// ── logParamFeedback / getParamFeedback ──────────────────────

describe('logParamFeedback', () => {
  it('正确写入 param_feedback 表', () => {
    logParamFeedback(db, {
      strategy_name: 'test-strategy',
      param_name: 'threshold',
      signal_type: 'link_survival',
      signal_value: 0.5,
      context: '{"test": true}',
    });

    const rows = db.prepare('SELECT * FROM param_feedback').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].strategy_name).toBe('test-strategy');
    expect(rows[0].param_name).toBe('threshold');
    expect(rows[0].signal_type).toBe('link_survival');
    expect(rows[0].signal_value).toBe(0.5);
  });
});
