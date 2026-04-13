/**
 * dedup.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
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
  isLlmConfigured: () => false,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { reconsolidateNode } from '../../src/graph/dedup.js';
import { searchVectors } from '../../src/db/vectors.js';
import { getNode } from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.mocked(searchVectors).mockReturnValue([]);
});

// ===== reconsolidateNode =====

describe('reconsolidateNode', () => {
  it('should be no-op if node does not exist', async () => {
    await reconsolidateNode(db, 'nonexistent', 'new content');
    // No error thrown
  });

  it('should pick longer content when no LLM api_key (fallback merge)', async () => {
    const node = seedNode(db, { content: 'short' });

    await reconsolidateNode(db, node.id, 'a much longer new content');
    const after = getNode(db, node.id)!;
    expect(after.content).toBe('a much longer new content');
  });

  it('should keep original content if it is longer in fallback merge', async () => {
    const node = seedNode(db, { content: 'the original much longer content here' });

    await reconsolidateNode(db, node.id, 'short');
    const after = getNode(db, node.id)!;
    expect(after.content).toBe('the original much longer content here');
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

  it('should accept custom reason parameter', async () => {
    const node = seedNode(db, { content: 'short' });

    // 不抛异常即可
    await reconsolidateNode(db, node.id, 'longer replacement content', '用户纠正');
    const after = getNode(db, node.id)!;
    expect(after.content).toBe('longer replacement content');
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
});
