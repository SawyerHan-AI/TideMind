/**
 * dedup.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  getLLMOptions: () => ({}),
  renderUserPrompt: (_name: string, _vars: Record<string, string>, fallback: string) => fallback,
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/db/vectors.js', () => ({
  searchVectors: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('merged content'),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.3, beta: 0.5, gamma: 0.1, delta: 0.1 },
    gates: {},
    metabolism: {},
  }),
  // 用 vi.fn 便于在 beforeEach / 单测里动态切换返回值
  isLlmConfigured: vi.fn(() => false),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { reconsolidateNode } from '../../src/graph/dedup.js';
import { searchVectors } from '../../src/db/vectors.js';
import { getNode } from '../../src/db/nodes.js';
import { callLLM } from '../../src/llm/client.js';
import { isLlmConfigured } from '../../src/config.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.mocked(searchVectors).mockReturnValue([]);
  vi.mocked(callLLM).mockReset();
  vi.mocked(callLLM).mockResolvedValue('merged content');
  // 默认未配置 LLM（走 fallback 保留旧内容的路径）
  vi.mocked(isLlmConfigured).mockReset();
  vi.mocked(isLlmConfigured).mockReturnValue(false);
});

// ===== reconsolidateNode =====

describe('reconsolidateNode', () => {
  it('should be no-op if node does not exist', async () => {
    await reconsolidateNode(db, 'nonexistent', 'new content');
    // No error thrown
  });

  it('should preserve existing content when no LLM api_key (fallback)', async () => {
    const node = seedNode(db, { content: 'short' });

    await reconsolidateNode(db, node.id, 'a much longer new content');
    const after = getNode(db, node.id)!;
    // 新契约：LLM 未配置时宁可保留旧内容也不用 newContent 碎片覆盖
    expect(after.content).toBe('short');
    // 热度/last_reconsolidated 仍应更新
    expect(after.heat).toBeGreaterThan(node.heat);
    expect(after.last_reconsolidated).not.toBeNull();
  });

  it('should preserve existing content in fallback even if newContent is shorter', async () => {
    const node = seedNode(db, { content: 'the original much longer content here' });

    await reconsolidateNode(db, node.id, 'short');
    const after = getNode(db, node.id)!;
    // 新契约：失败路径一律保留旧内容
    expect(after.content).toBe('the original much longer content here');
    expect(after.last_reconsolidated).not.toBeNull();
  });

  it('should bump heat by 0.3 capped at 10.0', async () => {
    const node = seedNode(db, { content: 'content', heat: 9.9 });

    await reconsolidateNode(db, node.id, 'new content that is quite long');
    const after = getNode(db, node.id)!;
    expect(after.heat).toBe(10.0);
  });

  it('should bump heat by 0.3 when not near cap', async () => {
    const node = seedNode(db, { content: 'original', heat: 1.0 });

    await reconsolidateNode(db, node.id, 'new content');
    const after = getNode(db, node.id)!;
    expect(after.heat).toBeCloseTo(1.3, 1);
  });

  it('should update last_reconsolidated timestamp', async () => {
    const node = seedNode(db, { content: 'content' });
    expect(node.last_reconsolidated).toBeNull();

    await reconsolidateNode(db, node.id, 'new content');
    const after = getNode(db, node.id)!;
    expect(after.last_reconsolidated).not.toBeNull();
  });

  it('should merge tags without duplicates', async () => {
    const node = seedNode(db, { content: 'content', tags: ['tag-a', 'tag-b'] });

    await reconsolidateNode(db, node.id, 'new content', '合并', {
      newTags: ['tag-b', 'tag-c'],
    });

    const after = getNode(db, node.id)!;
    const tags = JSON.parse(after.tags as string);
    expect(tags).toContain('tag-a');
    expect(tags).toContain('tag-b');
    expect(tags).toContain('tag-c');
    // tag-b 不重复
    expect(tags.filter((t: string) => t === 'tag-b')).toHaveLength(1);
  });

  it('should not update content when content is identical', async () => {
    const node = seedNode(db, { content: 'same content' });
    const beforeVersion = node.version;

    await reconsolidateNode(db, node.id, 'same content');
    const after = getNode(db, node.id)!;
    // content 没变，version 不应增加（只有 heat 和 last_reconsolidated 更新）
    expect(after.content).toBe('same content');
  });

  it('should handle empty newTags gracefully', async () => {
    const node = seedNode(db, { content: 'short', tags: ['existing'] });

    await reconsolidateNode(db, node.id, 'a longer new content here', '合并', {
      newTags: [],
    });

    const after = getNode(db, node.id)!;
    // 空 newTags 不应修改标签
    const tags = JSON.parse(after.tags as string);
    expect(tags).toEqual(['existing']);
  });

  it('should accept custom reason parameter without overwriting content in fallback', async () => {
    const node = seedNode(db, { content: 'short' });

    // 自定义 reason 不抛异常；LLM 未配置时 content 保持不变
    await reconsolidateNode(db, node.id, 'longer replacement content', '用户纠正');
    const after = getNode(db, node.id)!;
    expect(after.content).toBe('short');
    // 热度仍然会 bump
    expect(after.heat).toBeGreaterThan(node.heat);
  });

  it('should handle node with no existing tags when merging new tags', async () => {
    const node = seedNode(db, { content: 'no tags node' });

    await reconsolidateNode(db, node.id, 'new content', '合并', {
      newTags: ['new-tag'],
    });

    const after = getNode(db, node.id)!;
    const tags = JSON.parse(after.tags as string);
    expect(tags).toContain('new-tag');
  });

  it('should preserve existing content when LLM returns suspiciously short result', async () => {
    // 模拟 LLM 可用，但返回远短于原文（<50% 原长度，且 < newContent 长度）
    // 这是防御 LLM 幻觉丢字的代码路径
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    const originalContent = 'this is the original much longer persisted memory content that should not be lost';
    const newContentInput = 'incoming fragment that is moderately long text here';
    // LLM 返回一个可疑结果：远短于原文且短于新输入
    vi.mocked(callLLM).mockResolvedValue('tiny');

    const node = seedNode(db, { content: originalContent });
    await reconsolidateNode(db, node.id, newContentInput);

    const after = getNode(db, node.id)!;
    // 新契约：疑似丢字的 LLM 输出被拒绝，保留旧内容
    expect(after.content).toBe(originalContent);
    expect(after.last_reconsolidated).not.toBeNull();
  });

  it('should preserve existing content when LLM throws', async () => {
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(callLLM).mockRejectedValue(new Error('LLM network error'));

    const originalContent = 'the original persisted content';
    const node = seedNode(db, { content: originalContent });
    await reconsolidateNode(db, node.id, 'different new fragment content');

    const after = getNode(db, node.id)!;
    // LLM 抛错 → 保留旧内容
    expect(after.content).toBe(originalContent);
    expect(after.last_reconsolidated).not.toBeNull();
  });

  it('reconsolidateNode 即使内容不变也要 bump updated（heat / last_reconsolidated 写入路径）', async () => {
    const node = seedNode(db, { content: 'unchanged content' });
    const before = (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(node.id) as { updated: string }).updated;
    await new Promise(r => setTimeout(r, 5));
    // LLM 未配置路径：只 bump heat + last_reconsolidated，content 不变
    await reconsolidateNode(db, node.id, 'unchanged content');
    const after = (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(node.id) as { updated: string }).updated;
    expect(after > before).toBe(true);
  });
});
