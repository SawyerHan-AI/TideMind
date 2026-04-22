/**
 * digest elicitation 接入测试
 *
 * 覆盖 A 场景（correction + target_node 不存在时，ask 模式下通过 MCP elicit
 * 让用户选择）下的五条路径：
 *   1) silent 模式（默认）— 不 elicit，走硬拒 fallback
 *   2) ask + capability 不支持 — 走硬拒 fallback
 *   3) ask + 用户选 retarget — 用新 target_node 继续 correction
 *   4) ask + 用户选 "__new__" — 改写 intent=new 走常规消化
 *   5) ask + 用户选 "__skip__" — 返回 rejected 但 reason 是用户取消
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 配置 mock：让 digest.interactive_mode 可在 per-test 基础上切换
let mockInteractiveMode: 'silent' | 'ask' = 'silent';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/stream/writer.js', () => ({
  appendToStream: vi.fn().mockReturnValue('stream:2026-04-22:abc:1'),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: 'test-key' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: 'test', heavy_model: 'test' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.4, beta: 0.3, gamma: 0.2, delta: 0.1 },
    metabolism: { annotate_interval_minutes: 3, daily_check_hours: 24, weekly_check_days: 7 },
    gates: {
      vector_search: 50, graph_expansion: 20, graph_expansion_links: 10,
      crystal_generation: 100, divergent_scan: 200,
      learning_2_min_nodes: 30, learning_2_min_recall_ops: 10,
    },
    sources: {},
    digest: { interactive_mode: mockInteractiveMode },
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => true,
}));

const mockGetDb = vi.fn();
vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false, getDb: () => mockGetDb() };
});

vi.mock('../../src/graph/landing.js', () => ({
  findLandingConnections: vi.fn().mockReturnValue({
    action: 'new',
    confirmedLinks: [],
    pendingLinks: [],
  }),
}));

vi.mock('../../src/graph/dedup.js', () => ({
  reconsolidateNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/vectors.js', () => ({
  insertVector: vi.fn(),
  deleteVector: vi.fn(),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { digest } from '../../src/tools/digest.js';
import { resetElicitThrottle } from '../../src/tools/elicit-helper.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';
import { invalidateGateCache } from '../../src/db/stats.js';

// 构造一个只实现本测试用到的方法的 fake McpServer
type FakeServer = {
  server: {
    getClientCapabilities: () => unknown;
    elicitInput: ReturnType<typeof vi.fn>;
  };
};

function makeFakeServer(opts: {
  supportsForm: boolean;
  elicitResponse?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
}): FakeServer {
  return {
    server: {
      getClientCapabilities: () =>
        opts.supportsForm ? { elicitation: { form: {} } } : undefined,
      elicitInput: vi.fn().mockResolvedValue(opts.elicitResponse ?? { action: 'cancel' }),
    },
  };
}

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  vi.clearAllMocks();
  resetElicitThrottle();
  db = setupTestDb();
  repo = new SqliteRepository(db);
  mockGetDb.mockReturnValue(db);
  invalidateGateCache();
  mockInteractiveMode = 'silent'; // 默认，每个测试单独切
});

describe('digest - correction + target_node missing (elicit A 场景)', () => {
  it('silent 模式下不 elicit，走硬拒 fallback（即使提供 server）', async () => {
    mockInteractiveMode = 'silent';
    seedNode(db, { content: 'some memory' }); // 存在候选节点
    const fake = makeFakeServer({
      supportsForm: true,
      elicitResponse: { action: 'accept', content: { action: '__new__' } },
    });

    const result = await digest(repo, {
      content: 'correction for nonexistent',
      intent: 'correction',
      target_node: 'nonexistent-id',
    }, { server: fake as any });

    expect(result.status).toBe('rejected');
    expect(result.reject_reason).toContain('nonexistent-id');
    expect(fake.server.elicitInput).not.toHaveBeenCalled();
  });

  it('ask 模式但 client 不支持 form capability 时走 fallback', async () => {
    mockInteractiveMode = 'ask';
    seedNode(db, { content: 'some memory' });
    const fake = makeFakeServer({ supportsForm: false });

    const result = await digest(repo, {
      content: 'correction',
      intent: 'correction',
      target_node: 'nonexistent-id',
    }, { server: fake as any });

    expect(result.status).toBe('rejected');
    expect(result.reject_reason).toContain('nonexistent-id');
    expect(fake.server.elicitInput).not.toHaveBeenCalled();
  });

  it('ask 模式 + 用户选 "__skip__"，返回 rejected 但 reason 是用户取消', async () => {
    mockInteractiveMode = 'ask';
    seedNode(db, { content: 'a candidate memory' });
    const fake = makeFakeServer({
      supportsForm: true,
      elicitResponse: { action: 'accept', content: { action: '__skip__' } },
    });

    const result = await digest(repo, {
      content: 'trying to correct nothing',
      intent: 'correction',
      target_node: 'nonexistent-id',
    }, { server: fake as any });

    expect(result.status).toBe('rejected');
    expect(result.reject_reason).toContain('用户');
    expect(fake.server.elicitInput).toHaveBeenCalledOnce();
  });

  it('ask 模式 + 用户选 retarget（某候选节点 ID），改走 correction 逻辑', async () => {
    mockInteractiveMode = 'ask';
    const candidate = seedNode(db, { content: 'real target memory' });
    const fake = makeFakeServer({
      supportsForm: true,
      elicitResponse: { action: 'accept', content: { action: candidate.id } },
    });

    const result = await digest(repo, {
      content: 'corrected content',
      intent: 'correction',
      target_node: 'wrong-id-user-guessed',
    }, { server: fake as any });

    expect(result.status).toBe('processed');
    expect(result.updated_nodes).toBeDefined();
    expect(result.updated_nodes![0].id).toBe(candidate.id);
    expect(result.updated_nodes![0].content).toBe('corrected content');
  });

  it('ask 模式 + 用户选 "__new__"，改写 intent=new 走常规消化', async () => {
    mockInteractiveMode = 'ask';
    seedNode(db, { content: 'any existing node' });
    const fake = makeFakeServer({
      supportsForm: true,
      elicitResponse: { action: 'accept', content: { action: '__new__' } },
    });

    const result = await digest(repo, {
      content: 'this is actually new information worth storing',
      intent: 'correction',
      target_node: 'does-not-exist',
      async: false, // 让它同步走完，便于断言 created_nodes
    }, { server: fake as any });

    expect(result.status).toBe('processed');
    expect(result.created_nodes).toBeDefined();
    expect(result.created_nodes!.length).toBeGreaterThan(0);
  });

  it('ask 模式但无候选节点时 fallback（空数据库硬拒）', async () => {
    mockInteractiveMode = 'ask';
    // 不 seed 任何节点
    const fake = makeFakeServer({
      supportsForm: true,
      elicitResponse: { action: 'accept', content: { action: '__new__' } },
    });

    const result = await digest(repo, {
      content: 'correction',
      intent: 'correction',
      target_node: 'nonexistent-id',
    }, { server: fake as any });

    expect(result.status).toBe('rejected');
    // 无候选时直接返回 fallback，不调 elicitInput
    expect(fake.server.elicitInput).not.toHaveBeenCalled();
  });
});

describe('digest elicit helper 节流行为', () => {
  it('同 topicKey 10 分钟内第二次 elicit 被节流（silent fallback）', async () => {
    mockInteractiveMode = 'ask';
    seedNode(db, { content: 'candidate' });
    const fake = makeFakeServer({
      supportsForm: true,
      elicitResponse: { action: 'accept', content: { action: '__skip__' } },
    });

    await digest(repo, {
      content: 'first',
      intent: 'correction',
      target_node: 'same-missing-id',
    }, { server: fake as any });
    expect(fake.server.elicitInput).toHaveBeenCalledTimes(1);

    // 第二次：topicKey 相同（correction-missing:same-missing-id）触发节流
    const result2 = await digest(repo, {
      content: 'second',
      intent: 'correction',
      target_node: 'same-missing-id',
    }, { server: fake as any });

    // 第二次被节流，不再 elicit，直接 fallback 硬拒
    expect(fake.server.elicitInput).toHaveBeenCalledTimes(1);
    expect(result2.status).toBe('rejected');
    expect(result2.reject_reason).toContain('same-missing-id');
  });
});
