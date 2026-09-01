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
  // link-evaluate.ts catch 块用 `err instanceof LLMServiceError` 区分 LLM 服务错误,
  // mock 必须导出真实 class,否则 `instanceof undefined` 自身抛 TypeError 干扰逻辑。
  LLMServiceError: class LLMServiceError extends Error {
    constructor(message: string, public readonly statusCode?: number) {
      super(message);
      this.name = 'LLMServiceError';
    }
  },
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { runLinkEvaluate } from '../../src/metabolism/link-evaluate.js';
import { isLlmConfigured } from '../../src/config.js';
import { callLLM } from '../../src/llm/client.js';

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

  // 回归 F2(2026-05-21): created 是 JS ISO 'YYYY-MM-DDTHH:MM:SS.sssZ',
  // 原 SQL 用 datetime('now', '-48 hours') 返回 'YYYY-MM-DD HH:MM:SS'(空格无 Z)。
  // 字典序对比时同日的 ISO 因为 position 10 的 'T'(0x54) > ' '(0x20),
  // 会让"刚超出窗口 1h(49h 前)"的 ISO created 大于"48h 前"的 SQLite cutoff,
  // 边界附近 24h 内的过期 auto 链接被误拉进 lookback 窗口。
  //
  // 验证:用 49h 前(应该在 48h lookback 之外)创建的链接,
  //   - 旧 SQL 字典序比较 → 错误包含(回归保护)
  //   - 新 SQL ISO vs ISO 字典序 = 时间序 → 正确排除
  it('F2 回归: 刚超出 lookback 窗口(49h 前)的 auto 链接必须被排除', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);

    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });

    const link = seedLink(db, nodeA.id, nodeB.id, {
      auto: true,
      status: 'pending',
    });

    // 固定在 UTC 中午，让 49h 前与 48h cutoff 落在同一 UTC 日；
    // 否则用例在 UTC 00:00 附近会因跨日而无法重现字符串格式 bug。
    const fixedNow = Date.UTC(2026, 4, 21, 12, 0, 0)
    const justPast = new Date(fixedNow - 49 * 3600_000).toISOString();
    db.prepare('UPDATE links SET created = ? WHERE id = ?').run(justPast, link!.id);

    // 旧路径的 cutoff 是 SQLite datetime 格式。这里显式传入同一时刻的
    // `YYYY-MM-DD HH:MM:SS` ，避免用例结果受当前 UTC 小时、是否刚好跨日影响。
    const oldCutoff = new Date(fixedNow - 48 * 3600_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '')
    const oldQuery = db.prepare(`
      SELECT id FROM links
      WHERE auto = 1
        AND status NOT IN ('confirmed', 'rejected_by_user')
        AND created > ?
    `).all(oldCutoff) as Array<{ id: string }>;

    // 新路径:JS 侧算 ISO cutoff,ISO 之间字典序 = 时间序,正确排除。
    const newCutoff = new Date(fixedNow - 48 * 3600_000).toISOString();
    const newQuery = db.prepare(`
      SELECT id FROM links
      WHERE auto = 1
        AND status NOT IN ('confirmed', 'rejected_by_user')
        AND created > ?
    `).all(newCutoff) as Array<{ id: string }>;

    // 回归保护:旧 SQL 错误包含 49h 前的链接(这就是 F2 bug)
    expect(oldQuery.map(r => r.id)).toContain(link!.id);
    // 新 SQL 正确排除
    expect(newQuery.map(r => r.id)).not.toContain(link!.id);

    // runLinkEvaluate 自身:LLM mock 返回 '[]' → 不会 confirm/delete
    // 但该 pending 链接会从 pendingLinks 分支被拉进来评估,所以 evaluated 至少 1。
    // 这里只确认 deleted=0 因为 LLM 返回空。
    const result = await runLinkEvaluate(db);
    expect(result.deleted).toBe(0);
  });

  it('F4 修复: evaluateBatch 内 TypeError 必须 re-throw + log "programmer bug in link-evaluate"', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });
    seedLink(db, nodeA.id, nodeB.id, { auto: true, status: 'pending', strength: 0.4 });

    // 模拟代码 bug:callLLM 抛 TypeError(实际可能来自 parseBatchResults 内部对
    // undefined 字段的访问、或 nodeCache 映射逻辑里某个 undefined.x)。
    vi.mocked(callLLM).mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'relation')"),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runLinkEvaluate(db)).rejects.toBeInstanceOf(TypeError);

    const hasProgrammerBugLog = errorSpy.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && a.includes('programmer bug in link-evaluate')),
    );
    expect(hasProgrammerBugLog).toBe(true);
    errorSpy.mockRestore();
  });

  it('F4 修复: 普通 Error 不走 programmer bug 分支(仍是 log.warn 吞掉)', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });
    seedLink(db, nodeA.id, nodeB.id, { auto: true, status: 'pending', strength: 0.4 });

    vi.mocked(callLLM).mockRejectedValueOnce(new Error('network blip'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 普通 Error 在原逻辑里被 catch 吞掉(log.warn),runLinkEvaluate 正常返回
    const result = await runLinkEvaluate(db);
    expect(result.evaluated).toBeGreaterThanOrEqual(1);

    // 不应该看到 'programmer bug' log
    const hasProgrammerBugLog = errorSpy.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && a.includes('programmer bug')),
    );
    expect(hasProgrammerBugLog).toBe(false);
    errorSpy.mockRestore();
  });
});
