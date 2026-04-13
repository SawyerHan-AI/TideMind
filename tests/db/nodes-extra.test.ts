/**
 * nodes.ts 补充测试 —— 覆盖 parseTags / updateNode 边界条件 / getNodesByIds
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader（在所有 import 之前） ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const defaults: Record<string, number> = {
      heat_weight: 0.2,
      refinement_weight: 0.3,
      connectivity_weight: 0.3,
      independence_weight: 0.2,
    };
    return defaults[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import {
  parseTags,
  getNode,
  updateNode,
  getNodesByIds,
} from '../../src/db/nodes.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== parseTags =====

describe('parseTags', () => {
  it('null 输入返回空数组', () => {
    expect(parseTags(null)).toEqual([]);
  });

  it('空字符串返回空数组', () => {
    expect(parseTags('')).toEqual([]);
  });

  it('非法 JSON 返回空数组', () => {
    expect(parseTags('{not valid json')).toEqual([]);
  });

  it('合法 JSON 数组正常返回', () => {
    expect(parseTags('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('JSON 对象（非数组）返回空数组', () => {
    expect(parseTags('{"key":"value"}')).toEqual([]);
  });

  it('合法但包含非字符串元素仍原样返回', () => {
    // parseTags 不过滤非字符串元素，只校验是否为数组
    const result = parseTags('[1, "hello", null, true]');
    expect(result).toEqual([1, 'hello', null, true]);
  });
});

// ===== updateNode 边界条件 =====

describe('updateNode 边界条件', () => {
  it('更新不存在的节点返回 false', () => {
    const result = updateNode(db, 'nonexistent-id-12345', { content: 'ghost' });
    expect(result).toBe(false);
  });

  it('空 patch 不修改节点，返回 true', () => {
    const node = seedNode(db, { content: 'original' });
    const result = updateNode(db, node.id, {});
    expect(result).toBe(true);
    const after = getNode(db, node.id)!;
    expect(after.content).toBe('original');
    expect(after.version).toBe(1);
  });

  it('更新 content 时创建版本历史', () => {
    const node = seedNode(db, { content: 'v1 content' });
    updateNode(db, node.id, { content: 'v2 content' }, 'reason for change');

    const versions = db
      .prepare('SELECT * FROM node_versions WHERE node_id = ?')
      .all(node.id) as Array<{ node_id: string; version: number; content: string; change_reason: string | null }>;

    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('v1 content');
    expect(versions[0].version).toBe(1);
    expect(versions[0].change_reason).toBe('reason for change');
  });

  it('version 在内容变更后递增', () => {
    const node = seedNode(db, { content: 'initial' });
    expect(node.version).toBe(1);

    updateNode(db, node.id, { content: 'second' });
    expect(getNode(db, node.id)!.version).toBe(2);

    updateNode(db, node.id, { content: 'third' });
    expect(getNode(db, node.id)!.version).toBe(3);
  });

  it('不允许的列被忽略', () => {
    const node = seedNode(db, { content: 'safe' });
    // 传入一个不在 ALLOWED_COLUMNS 里的字段
    const result = updateNode(db, node.id, { id: 'hacked' } as any);
    // 因为没有合法字段，视为空 patch，返回 true
    expect(result).toBe(true);
    const after = getNode(db, node.id)!;
    expect(after.id).toBe(node.id); // id 未被篡改
  });

  it('content 相同时不创建版本历史', () => {
    const node = seedNode(db, { content: 'same content' });
    updateNode(db, node.id, { content: 'same content' });

    const versions = db
      .prepare('SELECT * FROM node_versions WHERE node_id = ?')
      .all(node.id);
    expect(versions).toHaveLength(0);
    expect(getNode(db, node.id)!.version).toBe(1);
  });
});

// ===== getNodesByIds =====

describe('getNodesByIds', () => {
  it('空数组返回空 Map', () => {
    const result = getNodesByIds(db, []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('部分 ID 存在部分不存在', () => {
    const a = seedNode(db, { content: 'exists' });
    const result = getNodesByIds(db, [a.id, 'no-such-id']);
    expect(result.size).toBe(1);
    expect(result.has(a.id)).toBe(true);
    expect(result.has('no-such-id')).toBe(false);
  });

  it('全部 ID 都存在时返回完整 Map', () => {
    const a = seedNode(db, { content: 'node a' });
    const b = seedNode(db, { content: 'node b' });
    const result = getNodesByIds(db, [a.id, b.id]);
    expect(result.size).toBe(2);
    expect(result.get(a.id)!.content).toBe('node a');
    expect(result.get(b.id)!.content).toBe('node b');
  });
});
