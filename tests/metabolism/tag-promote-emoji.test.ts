/**
 * tag-promote — C-5 emoji normalize match
 *
 * 现象：用户从 Logseq/Obsidian 导入的概念节点常带首 emoji（"🎯 项目规划"），
 * tag 文本通常不带 emoji（"项目规划"）。原先精确等值会判定为不同概念,把同义概念
 * 拆成两个节点。本测试守护"复用已有内容节点"逻辑在 emoji 前缀差异下的稳定性。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    if (param === 'tag_promote_threshold') return 3;
    if (param === 'tag_link_min_strength') return 0.3;
    return fallback;
  },
  getPrompt: (_name: string, fallback: string) => fallback,
  getLLMOptions: () => ({}),
  loadStrategies: () => {},
  renderUserPrompt: (_name: string, vars: Record<string, string>, fallback: string) => fallback,
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb-emoji' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: '' },
    ollama: { url: '' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: '', dimensions: 3072 },
    search: {},
    gates: {},
    metabolism: {},
  }),
  isLlmConfigured: () => false, // 关掉 LLM 定义生成，专心测复用逻辑
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn(),
  LLMServiceError: class LLMServiceError extends Error {
    constructor(message: string, public readonly statusCode?: number) {
      super(message);
      this.name = 'LLMServiceError';
    }
  },
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { promoteFrequentTags, normalizeTagForMatch } from '../../src/metabolism/tag-promote.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

describe('normalizeTagForMatch — 单元行为', () => {
  it('剥首 emoji + 空格', () => {
    expect(normalizeTagForMatch('🎯 项目规划')).toBe('项目规划');
    expect(normalizeTagForMatch('🚀 产品规划')).toBe('产品规划');
  });

  it('无 emoji 时按原值 trim', () => {
    expect(normalizeTagForMatch('项目规划')).toBe('项目规划');
    expect(normalizeTagForMatch('  项目规划  ')).toBe('项目规划');
  });

  it('emoji 后无空格也能剥掉', () => {
    expect(normalizeTagForMatch('🎯项目规划')).toBe('项目规划');
  });

  it('多 emoji 前缀只剥第一个(避免误并双 emoji 语义)', () => {
    expect(normalizeTagForMatch('🎯🚀 双标')).toBe('🚀 双标');
  });

  it('空 / null / undefined 都返回空串', () => {
    expect(normalizeTagForMatch('')).toBe('');
    expect(normalizeTagForMatch(null)).toBe('');
    expect(normalizeTagForMatch(undefined)).toBe('');
  });

  it('末尾 emoji 不被剥掉(只规一前缀)', () => {
    expect(normalizeTagForMatch('项目规划 🎯')).toBe('项目规划 🎯');
  });
});

describe('tag-promote — emoji normalize 复用', () => {
  it('内容节点 title="🎯 项目规划" + tag="项目规划" → 复用现有节点', async () => {
    // 先建一个已有的"项目规划"内容节点(带 emoji 前缀,有充分 heat)
    const existing = seedNode(db, {
      title: '🎯 项目规划',
      content: '项目规划文档',
      heat: 0.8,
    });

    // 再制造 3 个引用 "项目规划" tag 的节点 → 触发 promote
    seedNode(db, { tags: ['项目规划'], content: 'plan a' });
    seedNode(db, { tags: ['项目规划'], content: 'plan b' });
    seedNode(db, { tags: ['项目规划'], content: 'plan c' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);

    // existing 节点被升级为 tag,而不是新建第 4 个 "项目规划" 节点
    const tagNodes = db.prepare(
      "SELECT id, title, content, is_tag FROM nodes WHERE is_tag = 1",
    ).all() as Array<{ id: string; title: string; content: string; is_tag: number }>;

    expect(tagNodes.length).toBe(1);
    expect(tagNodes[0].id).toBe(existing.id);
    // C-5 实现把 title 更新为 tag(即不带 emoji 的规范名),保证后续查找用同一 key
    expect(tagNodes[0].title).toBe('项目规划');
  });

  it('内容节点 title="项目规划" + tag="🎯 项目规划" → 复用现有节点', async () => {
    const existing = seedNode(db, {
      title: '项目规划',
      content: '项目规划文档',
      heat: 0.8,
    });

    seedNode(db, { tags: ['🎯 项目规划'], content: 'plan a' });
    seedNode(db, { tags: ['🎯 项目规划'], content: 'plan b' });
    seedNode(db, { tags: ['🎯 项目规划'], content: 'plan c' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);

    const tagNodes = db.prepare(
      "SELECT id, title FROM nodes WHERE is_tag = 1",
    ).all() as Array<{ id: string; title: string }>;

    expect(tagNodes.length).toBe(1);
    expect(tagNodes[0].id).toBe(existing.id);
  });

  it('内容节点 title="🎯 项目规划" + tag="🚀 产品规划" → normalize 后不同,不复用', async () => {
    seedNode(db, { title: '🎯 项目规划', content: '项目规划文档', heat: 0.8 });

    seedNode(db, { tags: ['🚀 产品规划'], content: 'product a' });
    seedNode(db, { tags: ['🚀 产品规划'], content: 'product b' });
    seedNode(db, { tags: ['🚀 产品规划'], content: 'product c' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);

    // 必须新建一个 tag 节点,而不是把不相关的 "项目规划" 节点升级成 "产品规划" tag
    const tagNodes = db.prepare(
      "SELECT id, title, content FROM nodes WHERE is_tag = 1",
    ).all() as Array<{ id: string; title: string; content: string }>;

    expect(tagNodes.length).toBe(1);
    // tag 的 title 应该是源 tag 字符串(带 emoji)
    expect(tagNodes[0].title).toBe('🚀 产品规划');
  });

  it('多个候选时复用第一个(确定性、不随 SQLite 顺序漂)', async () => {
    // 同名两个 content 节点都能匹配 → 走 LIMIT 200 + find 第一个
    seedNode(db, { title: '🎯 项目规划', content: '版本 A', heat: 0.8 });
    seedNode(db, { title: '🚀 项目规划', content: '版本 B', heat: 0.8 });

    seedNode(db, { tags: ['项目规划'], content: 'plan a' });
    seedNode(db, { tags: ['项目规划'], content: 'plan b' });
    seedNode(db, { tags: ['项目规划'], content: 'plan c' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);

    // 不论选了哪一个,都不应产生第 3 个节点(没有同义概念的 N 重复制)
    const tagNodes = db.prepare(
      "SELECT id, title FROM nodes WHERE is_tag = 1",
    ).all() as Array<{ id: string; title: string }>;
    expect(tagNodes.length).toBe(1);
  });

  it('原有精确匹配仍然命中(无 emoji 场景不回归)', async () => {
    const existing = seedNode(db, { title: 'react', content: 'react ecosystem', heat: 0.8 });

    seedNode(db, { tags: ['react'], content: 'react a' });
    seedNode(db, { tags: ['react'], content: 'react b' });
    seedNode(db, { tags: ['react'], content: 'react c' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);

    const tagNodes = db.prepare(
      "SELECT id, title FROM nodes WHERE is_tag = 1",
    ).all() as Array<{ id: string; title: string }>;
    expect(tagNodes.length).toBe(1);
    expect(tagNodes[0].id).toBe(existing.id);
    expect(tagNodes[0].title).toBe('react');
  });
});
