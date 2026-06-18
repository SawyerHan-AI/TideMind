/**
 * learning3.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  getLLMOptions: () => ({}),
  renderUserPrompt: () => '',
  loadStrategies: () => {},
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: '' },
    ollama: { url: '' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: '', dimensions: 3072 },
    search: {},
    gates: {},
    metabolism: {},
  }),
  isLlmConfigured: () => false,
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('{}'),
  // learning3.ts catch 块用 `err instanceof LLMServiceError` 区分服务错误与业务错误
  LLMServiceError: class LLMServiceError extends Error {
    constructor(message: string, public readonly statusCode?: number) {
      super(message);
      this.name = 'LLMServiceError';
    }
  },
}));

vi.mock('../../src/llm/json-parse.js', () => ({
  parseLLMJson: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { canRunLearning3, computeSignals } from '../../src/evolution/learning3.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== canRunLearning3 =====

describe('canRunLearning3', () => {
  it('无 learning2 运行记录时返回 false', () => {
    expect(canRunLearning3(db)).toBe(false);
  });

  it('有 learning2 记录但无 first_learning2_run → 记录并返回 false', () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
      'last_learning2_run',
      new Date().toISOString(),
    );

    expect(canRunLearning3(db)).toBe(false);

    // 应已记录 first_learning2_run
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'first_learning2_run'").get() as any;
    expect(row).toBeDefined();
  });

  it('learning2 运行不足 3 个月 → 返回 false', () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('last_learning2_run', new Date().toISOString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('first_learning2_run', twoMonthsAgo);

    expect(canRunLearning3(db)).toBe(false);
  });

  it('learning2 运行超过 3 个月 → 返回 true', () => {
    const fourMonthsAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('last_learning2_run', new Date().toISOString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('first_learning2_run', fourMonthsAgo);

    expect(canRunLearning3(db)).toBe(true);
  });
});

// ===== computeSignals =====

describe('computeSignals', () => {
  it('返回至少 3 个信号（部分信号可能因 safePush 被跳过）', () => {
    seedNode(db);
    const signals = computeSignals(db);
    expect(signals.length).toBeGreaterThanOrEqual(3);
    expect(signals.length).toBeLessThanOrEqual(4);
  });

  it('所有信号值在 [0, 1] 范围', () => {
    seedNode(db);
    const signals = computeSignals(db);
    for (const sig of signals) {
      expect(sig.value).toBeGreaterThanOrEqual(0);
      expect(sig.value).toBeLessThanOrEqual(1);
    }
  });

  it('每个信号有 name/description/evidence 字段', () => {
    seedNode(db);
    const signals = computeSignals(db);
    for (const sig of signals) {
      expect(sig.name).toBeDefined();
      expect(sig.description).toBeDefined();
      expect(Array.isArray(sig.evidence)).toBe(true);
    }
  });

  it('无 recall 记录时 recall-usage mismatch 值为 0', () => {
    seedNode(db);
    const signals = computeSignals(db);
    const recallSignal = signals.find(s => s.name.includes('recall'));
    expect(recallSignal).toBeDefined();
    expect(recallSignal!.value).toBe(0);
  });

  it('图中无节点时 graphAccommodation 值为 0', () => {
    const signals = computeSignals(db);
    const graphSignal = signals.find(s => s.name.includes('容纳'));
    if (graphSignal) {
      expect(graphSignal.value).toBe(0);
    }
  });

  it('correction 数据存在时不会崩溃，信号正常计算', () => {
    // 创建节点
    const node = seedNode(db, { type: 'fact', project: 'proj-a' });

    // 模拟集中的 correction 操作
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO operation_log (operation, session, input_summary, output_node_ids, created)
        VALUES ('digest', 'sess-1', 'correction: fixed fact', ?, datetime('now'))
      `).run(JSON.stringify([node.id]));
    }

    const signals = computeSignals(db);
    // 至少有 diminishing returns + recall-usage + correction/graph 等信号
    expect(signals.length).toBeGreaterThanOrEqual(3);
    // 所有信号值合法
    for (const sig of signals) {
      expect(sig.value).toBeGreaterThanOrEqual(0);
      expect(sig.value).toBeLessThanOrEqual(1);
    }
  });
});
