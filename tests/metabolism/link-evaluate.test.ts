/**
 * 链接评估测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  getLLMOptions: () => ({}),
  loadStrategies: () => {},
  getStrategy: () => null,
  renderUserPrompt: (_strategy: string, _vars: any, fallback: string) => fallback,
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: 'test', heavy_model: 'test' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.4, beta: 0.3, gamma: 0.2, delta: 0.1 },
    metabolism: { daily_check_hours: [3], weekly_check_days: [0] },
    gates: {
      vector_search: 50, graph_expansion: 20, graph_expansion_links: 10,
      crystal_generation: 100, divergent_scan: 200,
      learning_2_min_nodes: 30, learning_2_min_recall_ops: 10,
    },
    sources: {},
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('[]'),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { runLinkEvaluate } from '../../src/metabolism/link-evaluate.js';
import { isLlmConfigured } from '../../src/config.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
  // 默认 LLM 未配置
  vi.mocked(isLlmConfigured).mockReturnValue(false);
});

// ===== runLinkEvaluate =====

describe('runLinkEvaluate', () => {
  it('LLM 未配置时返回空结果', async () => {
    const result = await runLinkEvaluate(db);
    expect(result).toEqual({ evaluated: 0, confirmed: 0, deleted: 0 });
  });

  it('无链接时直接返回', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    const result = await runLinkEvaluate(db);
    expect(result).toEqual({ evaluated: 0, confirmed: 0, deleted: 0 });
  });

  it('过期的 pending 链接不再被 runLinkEvaluate 触碰（GC 已拆到 pending-link-gc）', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });

    // 创建超期 pending 链接
    const link = seedLink(db, nodeA.id, nodeB.id, {
      status: 'pending',
      strength: 0.3,
      auto: true,
    });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE links SET created = ? WHERE id = ?').run(tenDaysAgo, link!.id);

    const result = await runLinkEvaluate(db);
    // GC 已剥离，runLinkEvaluate 自己不再产生删除
    // （LLM mock 返回 []，所以 evaluateBatch 也不会 deleteLink）
    expect(result.deleted).toBe(0);

    // 链接仍存在（等 pending-link-gc 任务清理）
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM links WHERE id = ?').get(link!.id) as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it('节点已被删除的链接被跳过', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });

    // 创建 auto 链接
    const link = seedLink(db, nodeA.id, nodeB.id, { auto: true });

    // 先删除链接依赖，再删除节点
    db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(nodeB.id, nodeB.id);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeB.id);

    // 重新创建一个 auto 链接引用已删除节点（绕过外键约束）
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`INSERT INTO links (id, from_id, to_id, relation, strength, auto, status, created)
      VALUES ('test-orphan', ?, ?, '[]', 0.5, 1, 'confirmed', datetime('now'))`)
      .run(nodeA.id, nodeB.id);
    db.exec('PRAGMA foreign_keys = ON');

    const result = await runLinkEvaluate(db);
    // 链接因节点不存在被过滤，validLinks 为空 => evaluated=0
    expect(result.evaluated).toBe(0);
  });
});
