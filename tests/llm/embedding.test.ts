/**
 * llm/embedding.ts 单元测试
 *
 * 测试 getEmbedding / isEmbeddingAvailable 的路由逻辑和 null 处理。
 * 所有外部调用 (fetch, google-auth-library) 被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    general: { data_dir: '/tmp/test-eb' },
    embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 3072 },
    ollama: { url: 'http://localhost:11434' },
    vertex: { project_id: '', region: 'us-central1' },
    gemini: { api_key: '' },
  }),
  getDataDir: () => '/tmp/test-eb',
}));

import { getConfig } from '../../src/config.js';

// We need to test the module in isolation, so mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('embedding - provider routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ollama provider returns null when embeddings array is empty', async () => {
    vi.mocked(getConfig).mockReturnValue({
      general: { data_dir: '/tmp/test-eb' },
      embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 3072 },
      ollama: { url: 'http://localhost:11434' },
      vertex: { project_id: '', region: 'us-central1' },
      gemini: { api_key: '' },
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [] }),
    });

    // Re-import to pick up fresh mock
    const { getEmbedding } = await import('../../src/llm/embedding.js');
    const result = await getEmbedding('test text');
    expect(result).toBeNull();
  });

  it('ollama provider returns null on HTTP error', async () => {
    vi.mocked(getConfig).mockReturnValue({
      general: { data_dir: '/tmp/test-eb' },
      embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 3072 },
      ollama: { url: 'http://localhost:11434' },
      vertex: { project_id: '', region: 'us-central1' },
      gemini: { api_key: '' },
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const { getEmbedding } = await import('../../src/llm/embedding.js');
    const result = await getEmbedding('test text');
    expect(result).toBeNull();
  });

  it('ollama provider returns null on connection failure', async () => {
    vi.mocked(getConfig).mockReturnValue({
      general: { data_dir: '/tmp/test-eb' },
      embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 3072 },
      ollama: { url: 'http://localhost:11434' },
      vertex: { project_id: '', region: 'us-central1' },
      gemini: { api_key: '' },
    } as any);

    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { getEmbedding } = await import('../../src/llm/embedding.js');
    const result = await getEmbedding('test text');
    expect(result).toBeNull();
  });

  it('ollama provider returns Float32Array on success', async () => {
    // 用 dim=3 配置 + 单位向量,匹配 getEmbedding 出口的 dim 校验 + L2 归一化
    // (S7+S19 修复 2026-05-09 引入)。原 mock 用 dim=3072 + 3 维数据是历史
    // 测试遗漏的不一致,本应被新校验拒(行为正确,改测试数据匹配)。
    vi.mocked(getConfig).mockReturnValue({
      general: { data_dir: '/tmp/test-eb' },
      embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 3 },
      ollama: { url: 'http://localhost:11434' },
      vertex: { project_id: '', region: 'us-central1' },
      gemini: { api_key: '' },
    } as any);

    // [0.6, 0.8, 0] 已是单位向量(0.36+0.64+0=1),归一化是 no-op,
    // 测试断言可保留对原始数值的精确比较。
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[0.6, 0.8, 0]] }),
    });

    const { getEmbedding } = await import('../../src/llm/embedding.js');
    const result = await getEmbedding('test text');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result!.length).toBe(3);
    expect(result![0]).toBeCloseTo(0.6);
  });

  it('gemini provider returns null when API key is missing', async () => {
    vi.mocked(getConfig).mockReturnValue({
      general: { data_dir: '/tmp/test-eb' },
      embedding: { provider: 'gemini', model: 'gemini-embedding-001', dimensions: 3072 },
      ollama: { url: 'http://localhost:11434' },
      vertex: { project_id: '', region: 'us-central1' },
      gemini: { api_key: '' },
    } as any);

    const { getEmbedding } = await import('../../src/llm/embedding.js');
    const result = await getEmbedding('test text');
    expect(result).toBeNull();
  });

  it('gemini provider returns null when response has no values', async () => {
    vi.mocked(getConfig).mockReturnValue({
      general: { data_dir: '/tmp/test-eb' },
      embedding: { provider: 'gemini', model: 'gemini-embedding-001', dimensions: 3072 },
      ollama: { url: 'http://localhost:11434' },
      vertex: { project_id: '', region: 'us-central1' },
      gemini: { api_key: 'test-key' },
    } as any);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: {} }),
    });

    const { getEmbedding } = await import('../../src/llm/embedding.js');
    const result = await getEmbedding('test text');
    // values is undefined → null
    expect(result).toBeNull();
  });
});

describe('getEmbeddings - batch', () => {
  it('returns array of results matching input length', async () => {
    vi.mocked(getConfig).mockReturnValue({
      general: { data_dir: '/tmp/test-eb' },
      embedding: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 3072 },
      ollama: { url: 'http://localhost:11434' },
      vertex: { project_id: '', region: 'us-central1' },
      gemini: { api_key: '' },
    } as any);

    // Mock two calls
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[0.1, 0.2]] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[0.3, 0.4]] }),
      });

    const { getEmbeddings } = await import('../../src/llm/embedding.js');
    const results = await getEmbeddings(['text1', 'text2']);
    expect(results).toHaveLength(2);
  });
});
