/**
 * property-promote 单元测试
 *
 * 验证属性值提升机制：过滤规则、tag 节点创建/缓存、链接创建。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../../helpers/test-db.js';
import { getNode } from '../../../src/db/nodes.js';
import { linkExists } from '../../../src/db/links.js';
import { invalidateGateCache } from '../../../src/db/stats.js';

// ---------- mocks ----------

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: 'test-key' },
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
  isLlmConfigured: () => true,
}));

const mockGetDb = vi.fn();
vi.mock('../../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false, getDb: () => mockGetDb() };
});

vi.mock('../../../src/llm/embedding.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(3072)),
}));

vi.mock('../../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('LLM response'),
}));

vi.mock('../../../src/graph/landing.js', () => ({
  findLandingConnections: vi.fn().mockReturnValue({
    action: 'new', confirmedLinks: [], pendingLinks: [],
  }),
}));

vi.mock('../../../src/graph/dedup.js', () => ({
  reconsolidateNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/vectors.js', () => ({
  insertVector: vi.fn(),
}));

vi.mock('../../../src/stream/writer.js', () => ({
  appendToStream: vi.fn().mockReturnValue('stream:2026-03-25:abc123:1'),
}));

// ---------- 被测模块 ----------

import {
  shouldPromotePropertyValue,
  getOrCreateTagNode,
  clearTagNodeCache,
  promotePropertyValues,
} from '../../../src/integrations/shared/property-promote.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  mockGetDb.mockReturnValue(db);
  clearTagNodeCache();
  invalidateGateCache();
});

// ========================================================
// shouldPromotePropertyValue
// ========================================================

describe('shouldPromotePropertyValue', () => {
  const systemProps = ['id', 'created-at', 'updated-at'];

  it('returns false for empty value', () => {
    expect(shouldPromotePropertyValue('tag', '', systemProps)).toBe(false);
  });

  it('returns false for whitespace-only value', () => {
    expect(shouldPromotePropertyValue('tag', '   ', systemProps)).toBe(false);
  });

  it('returns false for system property', () => {
    expect(shouldPromotePropertyValue('id', 'some-id', systemProps)).toBe(false);
    expect(shouldPromotePropertyValue('created-at', '2024-01-01', systemProps)).toBe(false);
  });

  it('returns false for pure integer', () => {
    expect(shouldPromotePropertyValue('count', '42', systemProps)).toBe(false);
  });

  it('returns false for pure decimal number', () => {
    expect(shouldPromotePropertyValue('score', '3.14', systemProps)).toBe(false);
  });

  it('returns false for boolean true/false (case insensitive)', () => {
    expect(shouldPromotePropertyValue('done', 'true', systemProps)).toBe(false);
    expect(shouldPromotePropertyValue('done', 'false', systemProps)).toBe(false);
    expect(shouldPromotePropertyValue('done', 'TRUE', systemProps)).toBe(false);
    expect(shouldPromotePropertyValue('done', 'False', systemProps)).toBe(false);
  });

  it('returns false for URL', () => {
    expect(shouldPromotePropertyValue('link', 'https://example.com', systemProps)).toBe(false);
    expect(shouldPromotePropertyValue('link', 'http://localhost:3000/path', systemProps)).toBe(false);
  });

  it('returns false for date format (YYYY-MM-DD or YYYY/MM/DD)', () => {
    expect(shouldPromotePropertyValue('date', '2024-01-15', systemProps)).toBe(false);
    expect(shouldPromotePropertyValue('date', '2024/01/15', systemProps)).toBe(false);
    expect(shouldPromotePropertyValue('date', '2024-01-15T10:30:00', systemProps)).toBe(false);
  });

  it('returns false for long string (>50 chars)', () => {
    const longVal = 'a'.repeat(51);
    expect(shouldPromotePropertyValue('desc', longVal, systemProps)).toBe(false);
  });

  it('returns true for string exactly 50 chars', () => {
    const val50 = 'a'.repeat(50);
    expect(shouldPromotePropertyValue('desc', val50, systemProps)).toBe(true);
  });

  it('returns false for template syntax (<% ... %>)', () => {
    expect(shouldPromotePropertyValue('tpl', '<% date %>', systemProps)).toBe(false);
  });

  it('returns false for template syntax ({{ ... }})', () => {
    expect(shouldPromotePropertyValue('tpl', '{{title}}', systemProps)).toBe(false);
  });

  it('returns false for wikilink', () => {
    expect(shouldPromotePropertyValue('ref', '[[Some Page]]', systemProps)).toBe(false);
  });

  it('returns true for normal text value', () => {
    expect(shouldPromotePropertyValue('category', 'programming', systemProps)).toBe(true);
    expect(shouldPromotePropertyValue('status', 'in-progress', systemProps)).toBe(true);
    expect(shouldPromotePropertyValue('author', 'Alice', systemProps)).toBe(true);
  });

  it('returns true for non-system property with short text', () => {
    expect(shouldPromotePropertyValue('topic', 'TypeScript', [])).toBe(true);
  });
});

// ========================================================
// clearTagNodeCache
// ========================================================

describe('clearTagNodeCache', () => {
  it('clears the internal cache so next call re-queries DB', async () => {
    // 第一次调用创建 tag 节点，结果会被缓存
    const id1 = await getOrCreateTagNode(db, 'cacheTest', 'test');
    expect(id1).toBeTruthy();

    // 第二次调用应该命中缓存，返回相同 ID
    const id2 = await getOrCreateTagNode(db, 'cacheTest', 'test');
    expect(id2).toBe(id1);

    // 清除缓存
    clearTagNodeCache();

    // 第三次调用应该从 DB 查到已有节点，而非创建新的
    const id3 = await getOrCreateTagNode(db, 'cacheTest', 'test');
    expect(id3).toBe(id1);
  });
});

// ========================================================
// getOrCreateTagNode
// ========================================================

describe('getOrCreateTagNode', () => {
  it('creates new tag node when none exists', async () => {
    const tagId = await getOrCreateTagNode(db, 'newTag', 'test');
    expect(tagId).toBeTruthy();
    expect(typeof tagId).toBe('string');

    const node = getNode(db, tagId);
    expect(node).not.toBeNull();
    expect(node!.is_tag).toBe(1);
  });

  it('returns cached ID on second call with same tag name', async () => {
    const id1 = await getOrCreateTagNode(db, 'repeatTag', 'test');
    const id2 = await getOrCreateTagNode(db, 'repeatTag', 'test');
    expect(id2).toBe(id1);
  });

  it('cache key is case-insensitive and trims whitespace', async () => {
    const id1 = await getOrCreateTagNode(db, 'MyTag', 'test');
    const id2 = await getOrCreateTagNode(db, '  mytag  ', 'test');
    expect(id2).toBe(id1);
  });

  it('finds existing tag node in DB without creating new one', async () => {
    // 手动创建一个 is_tag=1 的节点（type 须为合法值，再手动标记 is_tag）
    const existing = seedNode(db, { content: 'existingTag' });
    db.prepare('UPDATE nodes SET is_tag = 1 WHERE id = ?').run(existing.id);

    clearTagNodeCache();
    const tagId = await getOrCreateTagNode(db, 'existingTag', 'test');
    expect(tagId).toBe(existing.id);
  });

  it('sets is_tag = 1 on created nodes', async () => {
    const tagId = await getOrCreateTagNode(db, 'brandNewTag', 'test');
    const node = getNode(db, tagId);
    expect(node).not.toBeNull();
    expect(node!.is_tag).toBe(1);
  });
});

// ========================================================
// promotePropertyValues
// ========================================================

describe('promotePropertyValues', () => {
  const systemProps = ['id', 'created-at', 'updated-at'];

  it('creates tagged link between content node and tag node', async () => {
    const contentNode = seedNode(db, { content: 'my content node' });

    await promotePropertyValues(
      db,
      { category: 'TypeScript' },
      [contentNode.id],
      'test',
      systemProps,
    );

    // 应该创建了一个 tag 节点
    const tagId = await getOrCreateTagNode(db, 'TypeScript', 'test');
    expect(linkExists(db, contentNode.id, tagId)).toBe(true);
  });

  it('skips system properties', async () => {
    const contentNode = seedNode(db, { content: 'node for system prop test' });

    await promotePropertyValues(
      db,
      { id: 'some-value', category: 'RustLang' },
      [contentNode.id],
      'test',
      systemProps,
    );

    // 'id' 是系统属性，不应创建链接
    // 'category' 应该创建链接
    const tagId = await getOrCreateTagNode(db, 'RustLang', 'test');
    expect(linkExists(db, contentNode.id, tagId)).toBe(true);

    // 验证没有为 'some-value' 创建 tag 节点链接
    // (system prop 的 value 不应该被提升)
    const rows = db.prepare(
      "SELECT id FROM nodes WHERE content = 'some-value' AND is_tag = 1",
    ).all();
    expect(rows.length).toBe(0);
  });

  it('skips when nodeIds is empty', async () => {
    // 不应抛错，也不应创建任何东西
    await promotePropertyValues(
      db,
      { category: 'Golang' },
      [],
      'test',
      systemProps,
    );

    const rows = db.prepare(
      "SELECT id FROM nodes WHERE content = 'Golang' AND is_tag = 1",
    ).all();
    expect(rows.length).toBe(0);
  });

  it('does not create duplicate links', async () => {
    const contentNode = seedNode(db, { content: 'node for dedup test' });

    // 调用两次，相同的属性值
    await promotePropertyValues(
      db,
      { lang: 'Python' },
      [contentNode.id],
      'test',
      systemProps,
    );
    await promotePropertyValues(
      db,
      { lang: 'Python' },
      [contentNode.id],
      'test',
      systemProps,
    );

    // 应该只有一条链接
    const tagId = await getOrCreateTagNode(db, 'Python', 'test');
    const links = db.prepare(
      'SELECT * FROM links WHERE from_id = ? AND to_id = ?',
    ).all(contentNode.id, tagId);
    expect(links.length).toBe(1);
  });

  it('promotes multiple properties in one call', async () => {
    const contentNode = seedNode(db, { content: 'multi prop node' });

    await promotePropertyValues(
      db,
      { lang: 'JavaLang', framework: 'Spring' },
      [contentNode.id],
      'test',
      systemProps,
    );

    const tagJava = await getOrCreateTagNode(db, 'JavaLang', 'test');
    const tagSpring = await getOrCreateTagNode(db, 'Spring', 'test');
    expect(linkExists(db, contentNode.id, tagJava)).toBe(true);
    expect(linkExists(db, contentNode.id, tagSpring)).toBe(true);
  });

  it('skips non-promotable values (URL, number, boolean, etc.)', async () => {
    const contentNode = seedNode(db, { content: 'filter test node' });

    await promotePropertyValues(
      db,
      {
        url: 'https://example.com',
        count: '42',
        done: 'true',
        date: '2024-01-01',
        name: 'ValidName',
      },
      [contentNode.id],
      'test',
      systemProps,
    );

    // 只有 ValidName 应该被提升
    const tagId = await getOrCreateTagNode(db, 'ValidName', 'test');
    expect(linkExists(db, contentNode.id, tagId)).toBe(true);

    // 确认没有为其他值创建 tag 节点
    for (const val of ['https://example.com', '42', 'true', '2024-01-01']) {
      const rows = db.prepare(
        'SELECT id FROM nodes WHERE content = ? AND is_tag = 1',
      ).all(val);
      expect(rows.length).toBe(0);
    }
  });
});
