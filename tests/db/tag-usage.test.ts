/**
 * tag_usage 物化表 + trigger 维护测试(perf-optimization-2026-05-17 P1-2)
 *
 * 覆盖:
 * - INSERT trigger:active 节点带 tags 时计数 +1
 * - INSERT trigger:archived / superseded 节点不计入
 * - UPDATE trigger:tags 变化(增/删/替换)正确反映
 * - UPDATE trigger:archived 状态切换正确反映
 * - UPDATE trigger:is_superseded 状态切换正确反映
 * - DELETE trigger:计数 -1,零计数行清理
 * - backfillTagUsage:全量重算与全表聚合一致
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import { createNode, updateNode } from '../../src/db/nodes.js';
import { backfillTagUsage } from '../../src/db/schema.js';

let db: Database.Database;

interface TagUsageRow { tag: string; node_count: number }

function getTagUsage(db: Database.Database): Map<string, number> {
  const rows = db.prepare('SELECT tag, node_count FROM tag_usage').all() as TagUsageRow[];
  return new Map(rows.map(r => [r.tag, r.node_count]));
}

beforeEach(() => {
  db = setupTestDb();
});

describe('tag_usage trigger - INSERT', () => {
  it('active 节点带 tags 时计数 +1', () => {
    createNode(db, { type: 'fact', content: 'A', tags: ['x', 'y'] });
    createNode(db, { type: 'fact', content: 'B', tags: ['y', 'z'] });

    const usage = getTagUsage(db);
    expect(usage.get('x')).toBe(1);
    expect(usage.get('y')).toBe(2);
    expect(usage.get('z')).toBe(1);
  });

  it('节点无 tags 时不影响表', () => {
    createNode(db, { type: 'fact', content: 'A' });
    expect(getTagUsage(db).size).toBe(0);
  });

  it('节点空 tags 数组时不影响表', () => {
    createNode(db, { type: 'fact', content: 'A', tags: [] });
    expect(getTagUsage(db).size).toBe(0);
  });
});

describe('tag_usage trigger - UPDATE tags', () => {
  it('追加 tag 时计数 +1', () => {
    const node = createNode(db, { type: 'fact', content: 'A', tags: ['x'] });
    expect(getTagUsage(db).get('x')).toBe(1);

    updateNode(db, node.id, { tags: JSON.stringify(['x', 'y']) });
    const usage = getTagUsage(db);
    expect(usage.get('x')).toBe(1);
    expect(usage.get('y')).toBe(1);
  });

  it('删除 tag 时计数 -1 且零计数行清理', () => {
    const node = createNode(db, { type: 'fact', content: 'A', tags: ['x', 'y'] });
    updateNode(db, node.id, { tags: JSON.stringify(['x']) });

    const usage = getTagUsage(db);
    expect(usage.get('x')).toBe(1);
    expect(usage.has('y')).toBe(false); // 零计数已删除
  });

  it('整体替换 tags 时新旧差集都正确', () => {
    const node = createNode(db, { type: 'fact', content: 'A', tags: ['a', 'b', 'c'] });
    updateNode(db, node.id, { tags: JSON.stringify(['b', 'c', 'd']) });

    const usage = getTagUsage(db);
    expect(usage.has('a')).toBe(false);
    expect(usage.get('b')).toBe(1);
    expect(usage.get('c')).toBe(1);
    expect(usage.get('d')).toBe(1);
  });

  it('清空 tags 时所有计数 -1', () => {
    createNode(db, { type: 'fact', content: 'X', tags: ['shared'] });
    const node = createNode(db, { type: 'fact', content: 'A', tags: ['shared', 'mine'] });
    expect(getTagUsage(db).get('shared')).toBe(2);

    updateNode(db, node.id, { tags: JSON.stringify([]) });
    const usage = getTagUsage(db);
    expect(usage.get('shared')).toBe(1); // X 还在
    expect(usage.has('mine')).toBe(false);
  });
});

describe('tag_usage trigger - archived 状态切换', () => {
  it('归档时 active 计数 -1', () => {
    const a = createNode(db, { type: 'fact', content: 'A', tags: ['x'] });
    createNode(db, { type: 'fact', content: 'B', tags: ['x'] });
    expect(getTagUsage(db).get('x')).toBe(2);

    updateNode(db, a.id, { archived: 1 });
    expect(getTagUsage(db).get('x')).toBe(1);
  });

  it('恢复归档时 active 计数 +1', () => {
    const a = createNode(db, { type: 'fact', content: 'A', tags: ['x'] });
    updateNode(db, a.id, { archived: 1 });
    expect(getTagUsage(db).has('x')).toBe(false);

    updateNode(db, a.id, { archived: 0 });
    expect(getTagUsage(db).get('x')).toBe(1);
  });
});

describe('tag_usage trigger - is_superseded 状态切换', () => {
  it('被取代时 active 计数 -1', () => {
    const a = createNode(db, { type: 'fact', content: 'A', tags: ['x'] });
    expect(getTagUsage(db).get('x')).toBe(1);

    db.prepare('UPDATE nodes SET is_superseded = 1, updated = ? WHERE id = ?').run(new Date().toISOString(), a.id);
    expect(getTagUsage(db).has('x')).toBe(false);
  });
});

describe('tag_usage trigger - DELETE', () => {
  it('硬删除 active 节点时计数 -1', () => {
    const a = createNode(db, { type: 'fact', content: 'A', tags: ['x'] });
    createNode(db, { type: 'fact', content: 'B', tags: ['x'] });
    expect(getTagUsage(db).get('x')).toBe(2);

    db.prepare('DELETE FROM nodes WHERE id = ?').run(a.id);
    expect(getTagUsage(db).get('x')).toBe(1);
  });

  it('硬删除 archived 节点时不影响计数(archived 不计入)', () => {
    const a = createNode(db, { type: 'fact', content: 'A', tags: ['x'] });
    updateNode(db, a.id, { archived: 1 });
    expect(getTagUsage(db).has('x')).toBe(false);

    db.prepare('DELETE FROM nodes WHERE id = ?').run(a.id);
    expect(getTagUsage(db).has('x')).toBe(false);
  });
});

describe('tag_usage trigger - 重复 tag 去重(DISTINCT 加法,防计数漂移)', () => {
  it('节点 tags 含重复值时只计 +1(加减对称)', () => {
    createNode(db, { type: 'fact', content: 'A', tags: ['dup', 'dup'] });
    // 加法 DISTINCT → dup 只 +1,而非 +2
    expect(getTagUsage(db).get('dup')).toBe(1);
  });

  it('含重复 tag 的节点反复 archived 翻转不让计数向上漂移', () => {
    const a = createNode(db, { type: 'fact', content: 'A', tags: ['dup', 'dup'] });
    expect(getTagUsage(db).get('dup')).toBe(1);

    // archived 翻转多轮:每轮减 1(distinct) + 加 1(distinct),净 0
    for (let i = 0; i < 5; i++) {
      updateNode(db, a.id, { archived: 1 });
      expect(getTagUsage(db).get('dup') ?? 0).toBe(0);
      updateNode(db, a.id, { archived: 0 });
      expect(getTagUsage(db).get('dup')).toBe(1);
    }
  });

  it('硬删除含重复 tag 的节点后计数归零(减法不会减成负/残留)', () => {
    const a = createNode(db, { type: 'fact', content: 'A', tags: ['dup', 'dup'] });
    createNode(db, { type: 'fact', content: 'B', tags: ['dup'] });
    expect(getTagUsage(db).get('dup')).toBe(2);

    db.prepare('DELETE FROM nodes WHERE id = ?').run(a.id);
    expect(getTagUsage(db).get('dup')).toBe(1);
  });

  it('backfillTagUsage 按节点数计(COUNT DISTINCT node),重复 tag 不翻倍', () => {
    createNode(db, { type: 'fact', content: 'A', tags: ['dup', 'dup'] });
    createNode(db, { type: 'fact', content: 'B', tags: ['dup'] });
    backfillTagUsage(db);
    // 2 个含 dup 的 active 节点 → 2,而非 json_each 出现次数 3
    expect(getTagUsage(db).get('dup')).toBe(2);
  });
});

describe('backfillTagUsage', () => {
  it('与全表 active 节点聚合结果一致', () => {
    createNode(db, { type: 'fact', content: 'A', tags: ['p', 'q'] });
    createNode(db, { type: 'fact', content: 'B', tags: ['q', 'r'] });
    const archived = createNode(db, { type: 'fact', content: 'C', tags: ['p', 'r'] });
    updateNode(db, archived.id, { archived: 1 });

    // 模拟漂移:把 tag_usage 清空
    db.exec('DELETE FROM tag_usage');
    expect(getTagUsage(db).size).toBe(0);

    backfillTagUsage(db);
    const usage = getTagUsage(db);
    expect(usage.get('p')).toBe(1); // A active, C archived
    expect(usage.get('q')).toBe(2); // A + B
    expect(usage.get('r')).toBe(1); // B active, C archived
  });

  it('重复调用是幂等的(TRUNCATE + 重算)', () => {
    createNode(db, { type: 'fact', content: 'A', tags: ['z'] });
    backfillTagUsage(db);
    backfillTagUsage(db);
    expect(getTagUsage(db).get('z')).toBe(1);
  });

  it('历史损坏 tags(非法 JSON)不抛错(迁移 v21 场景:抛错会让 daemon 永远起不来)', () => {
    createNode(db, { type: 'fact', content: 'A', tags: ['ok'] });
    const brokenEmpty = createNode(db, { type: 'fact', content: 'B' });
    const brokenJson = createNode(db, { type: 'fact', content: 'C' });
    // 绕过业务层模拟历史损坏数据/手工 SQL(UPDATE trigger 自身有 json_valid 守卫,不会抛)
    db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run('', brokenEmpty.id);
    db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run('{broken', brokenJson.id);

    expect(() => backfillTagUsage(db)).not.toThrow();
    const usage = getTagUsage(db);
    expect(usage.get('ok')).toBe(1);
    expect(usage.size).toBe(1);
  });
});
