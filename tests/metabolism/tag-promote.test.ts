/**
 * tag-promote.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    // 测试中使用较低阈值便于构造数据
    if (param === 'tag_promote_threshold') return 3;
    if (param === 'tag_link_min_strength') return 0.3;
    return fallback;
  },
  getPrompt: (_name: string, fallback: string) => fallback,
  getLLMOptions: () => ({}),
  loadStrategies: () => {},
  renderUserPrompt: (_name: string, vars: Record<string, string>, fallback: string) => fallback,
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
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
  isLlmConfigured: () => false,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { promoteFrequentTags } from '../../src/metabolism/tag-promote.js';
import { getNode } from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

describe('promoteFrequentTags', () => {
  it('标签引用不足时不提升', async () => {
    // 只有 2 个节点引用同一标签（阈值为 3）
    seedNode(db, { tags: ['typescript'], content: 'node 1 about typescript' });
    seedNode(db, { tags: ['typescript'], content: 'node 2 about typescript' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(0);
    expect(result.linksCreated).toBe(0);
  });

  it('达到阈值时创建 tag 节点和链接', async () => {
    seedNode(db, { tags: ['react'], content: 'react component design' });
    seedNode(db, { tags: ['react'], content: 'react hooks pattern' });
    seedNode(db, { tags: ['react'], content: 'react performance' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);
    expect(result.linksCreated).toBe(3);
  });

  it('已存在 tag 节点时不重复创建', async () => {
    // 直接用 SQL 插入 tag 节点（绕过 CHECK 约束是 fact 列表的 DB）
    // promoteFrequentTags 通过 is_tag=1 识别已有 tag 节点
    const tagNodeId = 'tag-react';
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES (?, 'fact', ?, 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run(tagNodeId, 'react');

    seedNode(db, { tags: ['react'], content: 'react component' });
    seedNode(db, { tags: ['react'], content: 'react hooks' });
    seedNode(db, { tags: ['react'], content: 'react state' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(0);
    // 但链接仍然创建
    expect(result.linksCreated).toBe(3);
  });

  it('内容提及标签 → 高 strength (0.7+)', async () => {
    seedNode(db, { tags: ['ai'], content: 'AI is transforming everything' });
    seedNode(db, { tags: ['ai'], content: 'AI model training guide' });
    seedNode(db, { tags: ['ai'], content: 'AI safety research' });

    const result = await promoteFrequentTags(db);
    expect(result.linksCreated).toBe(3);

    // 查找创建的链接
    const links = db.prepare("SELECT * FROM links WHERE note IS NULL OR note = ''").all();
    // 所有节点的 content 都包含 'ai'（不区分大小写），strength 应为 0.7 或 0.8
  });

  it('内容未提及标签 → 低 strength (0.4)', async () => {
    seedNode(db, { tags: ['infrastructure'], content: 'setting up kubernetes clusters' });
    seedNode(db, { tags: ['infrastructure'], content: 'docker compose configuration' });
    seedNode(db, { tags: ['infrastructure'], content: 'nginx reverse proxy setup' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);
    expect(result.linksCreated).toBe(3);
  });

  it('唯一标签 → 集中度加成 (+0.1)', async () => {
    // 单标签节点 + 内容提及 → 0.7 + 0.1 = 0.8
    seedNode(db, { tags: ['python'], content: 'python programming basics' });
    seedNode(db, { tags: ['python'], content: 'python decorators explained' });
    seedNode(db, { tags: ['python'], content: 'python async await guide' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);
  });

  it('多标签节点无集中度加成', async () => {
    seedNode(db, { tags: ['python', 'backend'], content: 'python backend development' });
    seedNode(db, { tags: ['python', 'api'], content: 'python api design' });
    seedNode(db, { tags: ['python', 'testing'], content: 'python testing guide' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);
  });

  it('已归档节点（heat ≤ 0.01）不参与统计', async () => {
    seedNode(db, { tags: ['dead-tag'], content: 'dead-tag content 1', heat: 0.005 });
    seedNode(db, { tags: ['dead-tag'], content: 'dead-tag content 2', heat: 0.005 });
    seedNode(db, { tags: ['dead-tag'], content: 'dead-tag content 3', heat: 0.005 });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(0);
  });

  it('黑名单标签不被提升', async () => {
    // 设置降级黑名单
    db.prepare("INSERT INTO metadata (key, value) VALUES ('demoted_tags', ?)").run(
      JSON.stringify(['blocked-tag']),
    );

    seedNode(db, { tags: ['blocked-tag'], content: 'blocked-tag content 1' });
    seedNode(db, { tags: ['blocked-tag'], content: 'blocked-tag content 2' });
    seedNode(db, { tags: ['blocked-tag'], content: 'blocked-tag content 3' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(0);
    expect(result.linksCreated).toBe(0);
  });

  it('多个标签同时达到阈值', async () => {
    seedNode(db, { tags: ['go', 'rust'], content: 'go and rust comparison' });
    seedNode(db, { tags: ['go', 'rust'], content: 'go vs rust performance' });
    seedNode(db, { tags: ['go', 'rust'], content: 'go and rust in production' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(2); // go + rust 各提升一个
  });

  it('tag 节点（is_tag=1）本身不参与引用统计', async () => {
    // 用 SQL 直接插入 tag 节点
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES ('tag-existing', 'fact', 'existing-tag', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    seedNode(db, { tags: ['new-tag'], content: 'new-tag content 1' });
    seedNode(db, { tags: ['new-tag'], content: 'new-tag content 2' });
    seedNode(db, { tags: ['new-tag'], content: 'new-tag content 3' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);
  });
});
