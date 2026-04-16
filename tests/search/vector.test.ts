/**
 * search/vector.ts 单元测试
 *
 * mock embedding + vectors，测试过滤和转换逻辑。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock logger
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// mock embedding
vi.mock('../../src/llm/embedding.js', () => ({
  getEmbedding: vi.fn(),
}));

// Note: vector search and node retrieval are now accessed via repo methods,
// so we mock them on the repo object directly instead of module-level mocks.

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import { searchVector } from '../../src/search/vector.js';
import { getEmbedding } from '../../src/llm/embedding.js';
import { makeNode } from '../helpers/fixtures.js';
import type { IRepository } from '../../src/db/repository.js';

const mockSearchVectors = vi.fn();
const mockGetNodesByIds = vi.fn();

const repo = {
  vectors: { searchVectors: mockSearchVectors },
  nodes: { getNodesByIds: mockGetNodesByIds },
} as any as IRepository;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchVector', () => {
  it('embedding 获取失败返回空数组', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(null);
    const results = await searchVector(repo, 'test query');
    expect(results).toEqual([]);
  });

  it('无向量结果返回空数组', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([]);
    const results = await searchVector(repo, 'test');
    expect(results).toEqual([]);
  });

  it('正常返回结果并转换 L2 距离为相似度', async () => {
    const embedding = new Float32Array(10);
    vi.mocked(getEmbedding).mockResolvedValue(embedding);

    const node1 = makeNode({ id: 'n1', heat: 0.8 });
    mockSearchVectors.mockReturnValue([
      { id: 'n1', distance: 0.5 },
    ]);
    mockGetNodesByIds.mockReturnValue(new Map([['n1', node1]]));

    const results = await searchVector(repo, 'test');
    expect(results).toHaveLength(1);
    expect(results[0].node.id).toBe('n1');
    expect(results[0].source).toBe('vector');
    // L2 距离 0.5 → similarity = 1 - 0.25/2 = 0.875
    expect(results[0].score).toBeCloseTo(0.875);
  });

  it('过滤掉极低 heat 的节点', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([{ id: 'n1', distance: 0.5 }]);
    mockGetNodesByIds.mockReturnValue(new Map([
      ['n1', makeNode({ id: 'n1', heat: 0.005 })],
    ]));

    const results = await searchVector(repo, 'test');
    expect(results).toHaveLength(0);
  });

  it('按 type 过滤', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([
      { id: 'n1', distance: 0.5 },
      { id: 'n2', distance: 0.6 },
    ]);
    mockGetNodesByIds.mockReturnValue(new Map([
      ['n1', makeNode({ id: 'n1', type: 'fact', heat: 1 })],
      ['n2', makeNode({ id: 'n2', type: 'preference', heat: 1 })],
    ]));

    const results = await searchVector(repo, 'test', { type: 'fact' });
    expect(results).toHaveLength(1);
    expect(results[0].node.type).toBe('fact');
  });

  it('excludeMeta 过滤 meta 节点', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([{ id: 'n1', distance: 0.5 }]);
    mockGetNodesByIds.mockReturnValue(new Map([
      ['n1', makeNode({ id: 'n1', is_meta: 1, heat: 1 })],
    ]));

    const results = await searchVector(repo, 'test', { excludeMeta: true });
    expect(results).toHaveLength(0);
  });

  it('createdAfter 过滤', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([{ id: 'n1', distance: 0.5 }]);
    mockGetNodesByIds.mockReturnValue(new Map([
      ['n1', makeNode({ id: 'n1', created: '2025-01-01T00:00:00Z', heat: 1 })],
    ]));

    const results = await searchVector(repo, 'test', { createdAfter: '2026-01-01' });
    expect(results).toHaveLength(0);
  });

  it('createdBefore 过滤', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([{ id: 'n1', distance: 0.5 }]);
    mockGetNodesByIds.mockReturnValue(new Map([
      ['n1', makeNode({ id: 'n1', created: '2026-06-01T00:00:00Z', heat: 1 })],
    ]));

    const results = await searchVector(repo, 'test', { createdBefore: '2026-01-01' });
    expect(results).toHaveLength(0);
  });

  it('有 context 时拼接到 embedding 文本', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([]);

    await searchVector(repo, 'query', { context: '背景信息' });
    expect(getEmbedding).toHaveBeenCalledWith('query\n背景: 背景信息');
  });

  it('limit 参数生效', async () => {
    vi.mocked(getEmbedding).mockResolvedValue(new Float32Array(10));
    mockSearchVectors.mockReturnValue([
      { id: 'n1', distance: 0.3 },
      { id: 'n2', distance: 0.4 },
      { id: 'n3', distance: 0.5 },
    ]);
    mockGetNodesByIds.mockReturnValue(new Map([
      ['n1', makeNode({ id: 'n1', heat: 1 })],
      ['n2', makeNode({ id: 'n2', heat: 1 })],
      ['n3', makeNode({ id: 'n3', heat: 1 })],
    ]));

    const results = await searchVector(repo, 'test', { limit: 2 });
    expect(results).toHaveLength(2);
  });
});
