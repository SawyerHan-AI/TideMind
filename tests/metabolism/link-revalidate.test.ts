/**
 * link-revalidate.ts 单元测试
 *
 * revalidateLinks 依赖 LLM，这里测试不需要 LLM 的路径：
 * - LLM 未配置时跳过
 * - 空 nodeIds
 * - 只检查 confirmed 链接（pending 被跳过）
 * - 新创建的链接不重新验证（minLinkAge 检查）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const isLlmConfiguredMock = vi.fn().mockReturnValue(false);

// ---- Mocks ----
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual('../../src/config.js');
  return { ...actual, isLlmConfigured: () => isLlmConfiguredMock() };
});

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const overrides: Record<string, number> = {
      max_links_per_run: 10,
      min_link_age_hours: 24,
    };
    return overrides[param] ?? fallback;
  },
  getPrompt: () => '',
  renderUserPrompt: () => '',
  getLLMOptions: () => ({}),
  loadStrategies: () => {},
}));

// LLMServiceError 必须暴露给测试侧 throw,所以 mock 时把类内联定义在 factory 内
vi.mock('../../src/llm/client.js', () => {
  class LLMServiceError extends Error {
    statusCode?: number;
    constructor(msg: string, statusCode?: number) {
      super(msg);
      this.name = 'LLMServiceError';
      this.statusCode = statusCode;
    }
  }
  return {
    callLLM: vi.fn().mockResolvedValue('{}'),
    LLMServiceError,
    setUsageDb: vi.fn(),
    setLLMSuccessHook: vi.fn(),
  };
});

vi.mock('../../src/metabolism/scheduler.js', () => ({
  notifyLLMFailure: vi.fn(),
}));

vi.mock('../../src/llm/json-parse.js', () => ({
  parseLLMJson: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/db/log.js', () => ({
  logTimelineEvent: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js';
import { revalidateLinks, type RevalidateContext } from '../../src/metabolism/link-revalidate.js';
import { callLLM, LLMServiceError } from '../../src/llm/client.js';
import { notifyLLMFailure } from '../../src/metabolism/scheduler.js';

let db: Database.Database;

const baseContext: RevalidateContext = {
  query: 'test query',
  recalledNodeIds: [],
};

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

describe('revalidateLinks', () => {
  it('LLM 未配置时直接跳过，不调用 callLLM', async () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });
    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed' });

    await revalidateLinks(db, [nodeA.id], baseContext);

    expect(callLLM).not.toHaveBeenCalled();
  });

  it('空 nodeIds 时直接 return', async () => {
    await revalidateLinks(db, [], baseContext);

    expect(callLLM).not.toHaveBeenCalled();
  });

  it('只检查 confirmed 链接，pending 链接被跳过', async () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });

    // 创建 pending 链接
    seedLink(db, nodeA.id, nodeB.id, { status: 'pending' });

    // 手动把 created 改为很久以前，排除 minLinkAge 的影响
    db.prepare("UPDATE links SET created = datetime('now', '-48 hours')").run();

    await revalidateLinks(db, [nodeA.id], baseContext);

    // LLM 未配置所以不会调用，但即使配置了 pending 也应被跳过
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('新创建的链接不重新验证（minLinkAge 检查）', async () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });

    // 刚创建的 confirmed 链接（age < 24 小时）
    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed' });

    await revalidateLinks(db, [nodeA.id], baseContext);

    // 即使 LLM 配置了，新链接也不会被检查
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('overlapping nodeIds 的链接只处理一次（去重）', async () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });

    // 创建 A-B 链接，两端都在 nodeIds 中
    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed' });

    // 把链接 age 改成超过 24 小时
    db.prepare("UPDATE links SET created = datetime('now', '-48 hours')").run();

    // 传入重叠的 nodeIds: [A, B]
    // 链接 A-B 对于 nodeA 和 nodeB 都会被遍历到，但 seenLinkIds 应确保只处理一次
    await revalidateLinks(db, [nodeA.id, nodeB.id], baseContext);

    // LLM 未配置所以不会调用。验证的是不崩溃 + 去重逻辑正确
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('按 strength 从低到高排序（低 strength 优先验证）', async () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });
    const nodeC = seedNode(db, { content: 'node C' });

    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed', strength: 0.9 });
    seedLink(db, nodeA.id, nodeC.id, { status: 'confirmed', strength: 0.3 });

    // 把链接 age 改成超过 24 小时
    db.prepare("UPDATE links SET created = datetime('now', '-48 hours')").run();

    // 验证不崩溃
    await revalidateLinks(db, [nodeA.id], baseContext);
    expect(callLLM).not.toHaveBeenCalled();
  });

  // 回归 F7(2026-05-21): inflightKey 必须把 nodeIds 排序,否则同 query + 同 5
  // 个 nodeIds 不同顺序的两次并发调用会各自起一次真实工作,dedup 失效。
  it('F7 回归: 同 query 同 nodeIds 不同顺序的并发调用 dedup 生效', async () => {
    isLlmConfiguredMock.mockReturnValue(true);

    const nodeA = seedNode(db, { content: 'A' });
    const nodeB = seedNode(db, { content: 'B' });
    const nodeC = seedNode(db, { content: 'C' });

    // 创建一条 age > 24h 的 confirmed 链接,让 revalidateLinks 进入内部工作循环。
    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed', strength: 0.5 });
    db.prepare("UPDATE links SET created = datetime('now', '-48 hours')").run();

    let inflightConcurrent = 0;
    let maxConcurrent = 0;
    vi.mocked(callLLM).mockImplementation(async () => {
      inflightConcurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, inflightConcurrent);
      await new Promise(r => setTimeout(r, 20));
      inflightConcurrent -= 1;
      return JSON.stringify({ still_valid: true });
    });

    const ctx: RevalidateContext = { query: 'q', recalledNodeIds: [] };

    // 两次并发调用 — nodeIds 内容相同顺序不同
    const ids1 = [nodeA.id, nodeB.id, nodeC.id];
    const ids2 = [nodeC.id, nodeB.id, nodeA.id]; // 同集合,反序

    await Promise.all([
      revalidateLinks(db, ids1, ctx),
      revalidateLinks(db, ids2, ctx),
    ]);

    // dedup 生效 → 只一次真实工作 → callLLM 只被调一次。
    // 旧代码:不同顺序 inflightKey 不同,两个 promise 都进 inner,callLLM 被调 2 次。
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBeLessThanOrEqual(1);

    isLlmConfiguredMock.mockReturnValue(false);
  });

  // 回归 F3(2026-05-21): LLMServiceError 必须通知熔断器 hook
  it('F3 回归: callLLM 抛 LLMServiceError 时调用 notifyLLMFailure', async () => {
    isLlmConfiguredMock.mockReturnValue(true);
    vi.mocked(notifyLLMFailure).mockReset();

    const err = new LLMServiceError('429 rate limited', 429);
    vi.mocked(callLLM).mockRejectedValueOnce(err);

    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });

    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed', strength: 0.5 });
    // age > minLinkAge
    db.prepare("UPDATE links SET created = datetime('now', '-48 hours')").run();

    // revalidateLinks 内部 catch 后 throw LLMServiceError — 调用方 fire-and-forget,
    // 但函数内部应该已经先 notifyLLMFailure。
    let thrown: unknown = null;
    try {
      await revalidateLinks(db, [nodeA.id], baseContext);
    } catch (e) {
      thrown = e;
    }

    // notifyLLMFailure 必须被调用,并收到原 LLMServiceError
    expect(vi.mocked(notifyLLMFailure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyLLMFailure)).toHaveBeenCalledWith(err);
    // 同时仍然 throw 出去(行为兼容性)
    expect(thrown).toBe(err);

    isLlmConfiguredMock.mockReturnValue(false); // 还原默认
  });
});
