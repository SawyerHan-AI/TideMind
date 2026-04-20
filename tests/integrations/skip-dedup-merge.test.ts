/**
 * skipDedupMerge 端到端集成测试
 *
 * 目标：验证"外部身份来源 + 向量相似度极高"场景下，digest 不会走
 * landing merge 分支，节点保持独立；同时 reconsolidateNode 不被调用。
 *
 * 这个测试**不 mock** findLandingConnections 或 digest 内部——只 mock
 * 底层向量层和 LLM，让真实的 digest → landing 链路跑通。这样可以捕获
 * "调用方漏传 skipDedupMerge: true"这种回归。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks（必须在 import 之前）----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: '' },
    ollama: { url: '' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: 'test', heavy_model: 'test' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.4, beta: 0.3, gamma: 0.2, delta: 0.1 },
    metabolism: { daily_check_hours: [3], weekly_check_days: [0] },
    gates: {
      vector_search: 50,
      graph_expansion: 20,
      graph_expansion_links: 10,
      crystal_generation: 100,
      divergent_scan: 200,
      learning_2_min_nodes: 30,
      learning_2_min_recall_ops: 10,
    },
    sources: {},
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => false,
}));

const mockGetDb = vi.fn();
vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return {
    ...actual,
    // 关键：isVecLoaded=true 才会走 generateAndStoreEmbedding → findLandingConnections
    isVecLoaded: () => true,
    getDb: () => mockGetDb(),
  };
});

vi.mock('../../src/stream/writer.js', () => ({
  appendToStream: vi.fn().mockReturnValue('stream:test:1'),
}));

// 向量层全 mock：insertSegmentVectors 返回 1（视为成功），getVectorForNode
// 返回 non-null，searchVectors 由每个测试自己设置。
// 用 vi.hoisted 以便 mock factory 能访问 spy 函数。
const { mockSearchVectors, mockReconsolidateNode } = vi.hoisted(() => ({
  mockSearchVectors: vi.fn(),
  mockReconsolidateNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/vectors.js', () => ({
  insertSegmentVectors: vi.fn().mockResolvedValue(1),
  getVectorForNode: vi.fn().mockReturnValue(new Float32Array(3072)),
  searchVectors: mockSearchVectors,
  insertVector: vi.fn(),
  deleteVector: vi.fn(),
}));

// link-judge mock 成 stub，避免 LLM 调用
vi.mock('../../src/llm/link-judge.js', () => ({
  inferLinkType: vi.fn().mockReturnValue({ type: 'supports', confidence: 0.7 }),
  refineLinkTypeAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/graph/maturity.js', () => ({
  updateConnectivity: vi.fn(),
  computeMaturityScore: vi.fn().mockReturnValue(0.5),
  refreshMaturityScore: vi.fn(),
}));

// reconsolidateNode 保留真实模块结构，但 spy 调用
vi.mock('../../src/graph/dedup.js', () => ({
  reconsolidateNode: mockReconsolidateNode,
}));

// ---- Imports（mock 之后）----
import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { digest } from '../../src/tools/digest.js';
import { SqliteRepository } from '../../src/db/sqlite-repository.js';
import { getNode } from '../../src/db/nodes.js';

let db: Database.Database;
let repo: InstanceType<typeof SqliteRepository>;

beforeEach(() => {
  vi.clearAllMocks();
  db = setupTestDb();
  repo = new SqliteRepository(db);
  mockGetDb.mockReturnValue(db);
});

/**
 * 构造一个"新节点向量与某个已存在节点相似度 = sim"的场景
 * similarity = 1 - d^2 / 2  ⇒  d = sqrt(2 * (1 - sim))
 */
function makeNeighbor(existingId: string, similarity: number) {
  const distance = Math.sqrt(2 * (1 - similarity));
  return [{ id: existingId, distance }];
}

// ============================================================
// 外部笔记同步路径：skipDedupMerge: true 必须生效
// ============================================================

describe('skipDedupMerge: 外部笔记来源必须跳过向量归并', () => {
  it('logseq: 即使 sim=0.95 也不会触发 reconsolidateNode', async () => {
    const existing = seedNode(db, {
      content: '已存在的节点',
      source_tool: 'logseq',
    });
    mockSearchVectors.mockReturnValue(makeNeighbor(existing.id, 0.95));

    const result = await digest(repo, {
      content: '日记里一条新写下来的内容（长度足够通过质量门控）',
      source: { tool: 'logseq', files: ['journals/2026_04_20.md'] },
      async: false,
      skipDedupMerge: true,
    });

    // 关键断言：新节点独立创建，未被归并
    expect(result.status).toBe('processed');
    expect(result.created_nodes).toBeDefined();
    expect(result.created_nodes!.length).toBe(1);

    // reconsolidateNode 绝不能被调用
    expect(mockReconsolidateNode).not.toHaveBeenCalled();

    // 新旧节点都应该存在且活跃
    const newNodeId = result.created_nodes![0].id;
    expect(getNode(db, newNodeId)).toBeTruthy();
    expect(getNode(db, existing.id)?.archived).toBe(0);
  });

  it('skipDedupMerge=true 时仍然建立 landing 链接（link 分支不受影响）', async () => {
    const existing = seedNode(db, { content: '相关的已有节点' });
    // sim=0.88 在 landing threshold (0.80) 和 dedup threshold (0.92) 之间
    // → 走 confirmed link 分支
    mockSearchVectors.mockReturnValue(makeNeighbor(existing.id, 0.88));

    const result = await digest(repo, {
      content: '一段新内容，与已有节点相关但不相同（长度足够通过质量门控）',
      source: { tool: 'logseq', files: ['test.md'] },
      async: false,
      skipDedupMerge: true,
    });

    expect(result.status).toBe('processed');
    const newNodeId = result.created_nodes![0].id;

    // 应建立一条 confirmed 链接
    const link = db.prepare(
      'SELECT * FROM links WHERE from_id = ? AND to_id = ?',
    ).get(newNodeId, existing.id) as { status: string } | undefined;
    expect(link?.status).toBe('confirmed');
  });

  it('skipDedupMerge=true 时连续多次 digest 相同内容都产生独立节点', async () => {
    // 模拟 logseq 用户对同一段日记反复编辑几个字，每次 hash 变化触发新 digest
    const existing = seedNode(db, { content: '看《良医》' });
    mockSearchVectors.mockReturnValue(makeNeighbor(existing.id, 0.96));

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await digest(repo, {
        content: `看《良医》——修改版本 ${i}，内容长度足够通过质量门控检查`,
        source: { tool: 'logseq', files: ['test.md'] },
        async: false,
        skipDedupMerge: true,
      });
      expect(result.status).toBe('processed');
      ids.push(result.created_nodes![0].id);
    }

    // 每次都创建独立新节点，3 次 3 个不同 id
    expect(new Set(ids).size).toBe(3);
    // existing 节点热度不会被累加（没被合并）
    const existingState = getNode(db, existing.id);
    expect(existingState?.heat).toBeLessThan(1.5);
    // 核心：完全没有 merge 发生
    expect(mockReconsolidateNode).not.toHaveBeenCalled();
  });
});

// ============================================================
// 默认路径：没传 skipDedupMerge 的场景必须保持原有归并行为
// ============================================================

describe('skipDedupMerge: 无身份源场景保持默认归并行为', () => {
  it('brain_digest 入口（无 skipDedupMerge）在 sim>=0.92 时仍触发 merge', async () => {
    const existing = seedNode(db, {
      content: '用户以前记过的一条笔记',
    });
    mockSearchVectors.mockReturnValue(makeNeighbor(existing.id, 0.95));

    const result = await digest(repo, {
      content: '用户在 Claude 对话里提到的、其实和已有笔记高度重复的一条内容',
      source: { tool: 'claude-code' },
      async: false,
      // 不传 skipDedupMerge → 默认 false → 走 merge
    });

    expect(result.status).toBe('processed');

    // reconsolidateNode 被调用，target 就是 existing
    expect(mockReconsolidateNode).toHaveBeenCalledTimes(1);
    const firstCall = mockReconsolidateNode.mock.calls[0];
    // 参数序列：(db, mergeTarget, content, reason, opts)
    expect(firstCall[1]).toBe(existing.id);

    // merge 之后源节点被 archiveNode 冷却到 heat=0.02（这是现有实现，archived
    // 字段不变，只通过低热度让节点自然失活）。existing 保持活跃。
    const newNodeId = result.created_nodes?.[0]?.id;
    expect(newNodeId).toBeTruthy();
    const dbState = getNode(db, newNodeId!);
    expect(dbState?.heat).toBeCloseTo(0.02, 5);
  });

  it('显式传 skipDedupMerge=false 与不传保持一致（归并生效）', async () => {
    const existing = seedNode(db, { content: '某个已有节点' });
    mockSearchVectors.mockReturnValue(makeNeighbor(existing.id, 0.95));

    await digest(repo, {
      content: '一段与 existing 高度相似的新内容（长度足够通过质量门控检查）',
      source: { tool: 'claude-code' },
      async: false,
      skipDedupMerge: false,
    });

    expect(mockReconsolidateNode).toHaveBeenCalledTimes(1);
  });
});
