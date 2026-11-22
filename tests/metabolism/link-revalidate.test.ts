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
  getLLMOptions: () => ({ model: 'standard' }),
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

vi.mock('../../src/llm/route.js', () => ({
  resolveLLMRoute: () => ({ connectionId: null, scopeId: 'legacy:anthropic' }),
  assertRouteCallable: () => {},
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
import { runLinkRevalidateFollowup, selectLinksToRevalidate, type RevalidateContext } from '../../src/metabolism/link-revalidate.js';
import { enqueueRecallFollowup } from '../../src/db/recall-followups.js';
import { callLLM, LLMServiceError } from '../../src/llm/client.js';

let db: Database.Database;

const baseContext: RevalidateContext = {
  query: 'test query',
  recalledNodeIds: [],
};

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

const age = () => db.prepare("UPDATE links SET created = datetime('now', '-48 hours')").run();
const queue = (ids: string[]) => enqueueRecallFollowup(db, { kind: 'link_revalidate', nodeIds: ids, query: baseContext.query });
const queued = () => (db.prepare('SELECT count(*) AS n FROM recall_followups').get() as { n: number }).n;

describe('selectLinksToRevalidate', () => {
  it('只检查 confirmed 链接，pending 链接被跳过', () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });
    seedLink(db, nodeA.id, nodeB.id, { status: 'pending' });
    age();
    expect(selectLinksToRevalidate(db, [nodeA.id], new Set(), 10)).toHaveLength(0);
  });

  it('新创建的链接不重新验证（minLinkAge 检查）', () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });
    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed' });
    expect(selectLinksToRevalidate(db, [nodeA.id], new Set(), 10)).toHaveLength(0);
  });

  it('overlapping nodeIds 的链接只处理一次；按 strength 升序；排除已处理并截断', () => {
    const nodeA = seedNode(db, { content: 'node A' });
    const nodeB = seedNode(db, { content: 'node B' });
    const nodeC = seedNode(db, { content: 'node C' });
    seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed', strength: 0.9 });
    seedLink(db, nodeA.id, nodeC.id, { status: 'confirmed', strength: 0.3 });
    age();
    const all = selectLinksToRevalidate(db, [nodeA.id, nodeB.id, nodeC.id], new Set(), 10);
    expect(all.map(l => l.strength)).toEqual([0.3, 0.9]);
    expect(selectLinksToRevalidate(db, [nodeA.id], new Set(), 1)).toHaveLength(1);
    expect(selectLinksToRevalidate(db, [nodeA.id], new Set([all[0].linkId]), 10).map(l => l.linkId)).toEqual([all[1].linkId]);
    expect(selectLinksToRevalidate(db, [], new Set(), 10)).toHaveLength(0);
  });
});

describe('runLinkRevalidateFollowup', () => {
  it('LLM 未配置时不动队列，不调用 callLLM', async () => {
    const nodeA = seedNode(db, { content: 'node A' });
    queue([nodeA.id]);
    await runLinkRevalidateFollowup(db);
    expect(callLLM).not.toHaveBeenCalled();
    expect(queued()).toBe(1);
  });

  it('没有可验证链接的行直接完成并删除', async () => {
    isLlmConfiguredMock.mockReturnValue(true);
    try {
      const nodeA = seedNode(db, { content: 'node A' });
      queue([nodeA.id]);
      await runLinkRevalidateFollowup(db);
      expect(callLLM).not.toHaveBeenCalled();
      expect(queued()).toBe(0);
    } finally { isLlmConfiguredMock.mockReturnValue(false); }
  });

  it('链接只是还太新时保留该行，稍后再看', async () => {
    isLlmConfiguredMock.mockReturnValue(true);
    try {
      const nodeA = seedNode(db, { content: 'node A' });
      const nodeB = seedNode(db, { content: 'node B' });
      seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed' });
      queue([nodeA.id]);
      await runLinkRevalidateFollowup(db);
      expect(callLLM).not.toHaveBeenCalled();
      const row = db.prepare('SELECT status, attempts, not_before FROM recall_followups').get() as any;
      expect(row).toMatchObject({ status: 'pending', attempts: 1 });
      expect(row.not_before > new Date().toISOString()).toBe(true);
    } finally { isLlmConfiguredMock.mockReturnValue(false); }
  });

  it('LLMServiceError 原样上抛（由调度器计入熔断，不再自行通知），该条目可重试', async () => {
    isLlmConfiguredMock.mockReturnValue(true);
    try {
      const err = new LLMServiceError('429 rate limited', 429);
      vi.mocked(callLLM).mockRejectedValueOnce(err);
      const nodeA = seedNode(db, { content: 'node A' });
      const nodeB = seedNode(db, { content: 'node B' });
      seedLink(db, nodeA.id, nodeB.id, { status: 'confirmed', strength: 0.5 });
      age();
      queue([nodeA.id]);
      await expect(runLinkRevalidateFollowup(db)).rejects.toBe(err);
      expect(db.prepare('SELECT status, attempts, handled_json FROM recall_followups').get())
        .toEqual({ status: 'pending', attempts: 1, handled_json: '[]' });
    } finally { isLlmConfiguredMock.mockReturnValue(false); }
  });
});
