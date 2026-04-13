/**
 * tag-promote — title/content 分离 + LLM 定义生成测试
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
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: 'test-key' },
    vertex: { project_id: '', region: '' },
    ollama: { url: '' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: '', dimensions: 3072 },
    search: {},
    gates: {},
    metabolism: {},
  }),
  isLlmConfigured: () => true,
}));

vi.mock('../../src/llm/client.js', () => ({
  callLLM: vi.fn().mockResolvedValue('一种用于构建用户界面的 JavaScript 库'),
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { promoteFrequentTags } from '../../src/metabolism/tag-promote.js';
import { getNode } from '../../src/db/nodes.js';
import { callLLM } from '../../src/llm/client.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  vi.clearAllMocks();
});

describe('tag-promote title/content 分离', () => {
  it('新 tag 节点 title=标签名, content=LLM定义', async () => {
    seedNode(db, { tags: ['react'], content: 'react component design' });
    seedNode(db, { tags: ['react'], content: 'react hooks pattern' });
    seedNode(db, { tags: ['react'], content: 'react performance tuning' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);

    // 找到创建的 tag 节点
    const tagNodes = db.prepare(
      "SELECT id, title, content FROM nodes WHERE is_tag = 1",
    ).all() as Array<{ id: string; title: string | null; content: string }>;

    expect(tagNodes.length).toBe(1);
    expect(tagNodes[0].title).toBe('react');
    expect(tagNodes[0].content).toBe('一种用于构建用户界面的 JavaScript 库');
  });

  it('LLM 被调用时传入标签名和关联节点上下文', async () => {
    seedNode(db, { tags: ['typescript'], content: 'typescript type system' });
    seedNode(db, { tags: ['typescript'], content: 'typescript generics' });
    seedNode(db, { tags: ['typescript'], content: 'typescript decorators' });

    await promoteFrequentTags(db);

    expect(callLLM).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(callLLM).mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain('标签: typescript');
    expect(callArgs.prompt).toContain('typescript type system');
  });

  it('LLM 失败时 content 保持空字符串，不阻塞流程', async () => {
    vi.mocked(callLLM).mockRejectedValueOnce(new Error('LLM timeout'));

    seedNode(db, { tags: ['go'], content: 'go concurrency model' });
    seedNode(db, { tags: ['go'], content: 'go channels and goroutines' });
    seedNode(db, { tags: ['go'], content: 'go interface design' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(1);
    expect(result.linksCreated).toBe(3); // 链接正常创建

    const tagNode = db.prepare(
      "SELECT title, content FROM nodes WHERE is_tag = 1",
    ).get() as { title: string; content: string };

    expect(tagNode.title).toBe('go');
    expect(tagNode.content).toBe(''); // 失败时保持空
  });

  it('LLM 返回空字符串时 content 保持为空', async () => {
    vi.mocked(callLLM).mockResolvedValueOnce('');

    seedNode(db, { tags: ['rust'], content: 'rust ownership model' });
    seedNode(db, { tags: ['rust'], content: 'rust borrow checker' });
    seedNode(db, { tags: ['rust'], content: 'rust lifetime annotations' });

    await promoteFrequentTags(db);

    const tagNode = db.prepare(
      "SELECT title, content FROM nodes WHERE is_tag = 1",
    ).get() as { title: string; content: string };
    expect(tagNode.title).toBe('rust');
    expect(tagNode.content).toBe(''); // 空字符串不写入
  });

  it('已有 tag 节点（旧格式 content=标签名）通过 title??content 正确匹配', async () => {
    // 模拟旧格式的 tag 节点：title=null, content='react'
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES ('old-tag', 'fact', 'react', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    seedNode(db, { tags: ['react'], content: 'react stuff 1' });
    seedNode(db, { tags: ['react'], content: 'react stuff 2' });
    seedNode(db, { tags: ['react'], content: 'react stuff 3' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(0); // 不重复创建
    expect(result.linksCreated).toBe(3); // 但链接正常建立
  });

  it('已有 tag 节点（新格式 title=标签名）正确匹配', async () => {
    // 模拟新格式的 tag 节点：title='vue', content=定义
    db.prepare(`
      INSERT INTO nodes (id, type, title, content, heat, refinement, connectivity, independence, maturity_score, is_tag, created)
      VALUES ('new-tag', 'fact', 'vue', '渐进式 JavaScript 框架', 1.0, 0, 0, 0, 0.2, 1, datetime('now'))
    `).run();

    seedNode(db, { tags: ['vue'], content: 'vue reactive system' });
    seedNode(db, { tags: ['vue'], content: 'vue composition api' });
    seedNode(db, { tags: ['vue'], content: 'vue template syntax' });

    const result = await promoteFrequentTags(db);
    expect(result.promoted).toBe(0); // 不重复创建
    expect(result.linksCreated).toBe(3);
  });
});
