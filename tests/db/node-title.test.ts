/**
 * 节点 title 字段单元测试
 *
 * 覆盖 title 字段在 createNode、updateNode、seedNode 中的行为。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import { createNode, getNode, updateNode } from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

describe('createNode with title', () => {
  it('不传 title 时默认为 null', () => {
    const node = createNode(db, { content: 'no title node' });
    expect(node.title).toBeNull();
  });

  it('传入 title 时正确存储', () => {
    const node = createNode(db, { content: 'some content', title: '测试标题' });
    expect(node.title).toBe('测试标题');
    expect(node.content).toBe('some content');
  });

  it('tag 节点可以 title 有值而 content 为空', () => {
    const node = createNode(db, {
      title: 'TideMind',
      content: '',
      is_tag: 1,
    });
    expect(node.title).toBe('TideMind');
    expect(node.content).toBe('');
    expect(node.is_tag).toBe(1);
  });

  it('title 通过 getNode 能正确读取', () => {
    const created = createNode(db, { content: 'hello', title: '标题' });
    const fetched = getNode(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('标题');
  });
});

describe('updateNode with title', () => {
  it('可以为无 title 的节点添加 title', () => {
    const node = seedNode(db, { content: 'test content' });
    expect(node.title).toBeNull();

    updateNode(db, node.id, { title: '新标题' });
    const updated = getNode(db, node.id)!;
    expect(updated.title).toBe('新标题');
  });

  it('可以更新已有的 title', () => {
    const node = createNode(db, { content: 'test', title: '旧标题' });
    updateNode(db, node.id, { title: '新标题' });
    const updated = getNode(db, node.id)!;
    expect(updated.title).toBe('新标题');
  });

  it('更新 title 不影响 content 和其他字段', () => {
    const node = seedNode(db, { content: 'original content', tags: ['tag1'] });
    updateNode(db, node.id, { title: '添加标题' });
    const updated = getNode(db, node.id)!;
    expect(updated.content).toBe('original content');
    expect(updated.title).toBe('添加标题');
  });

  it('更新 title 不触发版本历史记录（仅 content 变更触发）', () => {
    const node = seedNode(db, { content: 'test' });
    updateNode(db, node.id, { title: '标题' });
    const updated = getNode(db, node.id)!;
    expect(updated.version).toBe(1); // 版本未递增
  });
});

describe('seedNode with title', () => {
  it('seedNode 支持 title override', () => {
    const node = seedNode(db, { title: '测试', content: '内容' });
    expect(node.title).toBe('测试');
  });

  it('seedNode 不传 title 时为 null', () => {
    const node = seedNode(db, { content: '内容' });
    expect(node.title).toBeNull();
  });
});
