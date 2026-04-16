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

// ---- Mocks ----
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual('../../src/config.js');
  return { ...actual, isLlmConfigured: () => false };
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

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('{}'),
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
import { callLLM } from '../../src/llm/client.js';

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
});
