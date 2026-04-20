/**
 * Migration v16 单测：补漏 v15 漏掉的 is_superseded=1 节点
 *
 * 策略同 v15 的测试：先用 ensureSchema 建最新表（v16），然后手动把
 * schema_version 降到 v15 并种入测试数据，再次调 ensureSchema 触发 v16
 * migration，验证效果。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import Database from 'better-sqlite3';
import { ensureSchema } from '../../src/db/schema.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

function downgradeToV15(db: Database.Database): void {
  db.prepare("UPDATE metadata SET value = '15' WHERE key = 'schema_version'").run();
}

function insertNode(
  db: Database.Database,
  id: string,
  opts: {
    source_tool?: string | null;
    archived?: number;
    is_superseded?: number;
    heat?: number;
    content?: string;
  } = {},
): void {
  db.prepare(`
    INSERT INTO nodes (
      id, type, content, created, heat, source_tool, archived, is_superseded
    ) VALUES (?, 'fact', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.content ?? `content ${id}`,
    new Date().toISOString(),
    opts.heat ?? 1.0,
    opts.source_tool ?? null,
    opts.archived ?? 0,
    opts.is_superseded ?? 0,
  );
}

function insertDedupVersion(db: Database.Database, nodeId: string): void {
  db.prepare(`
    INSERT INTO node_versions (node_id, version, content, change_reason, changed_at)
    VALUES (?, 1, '旧内容', '去重合并', ?)
  `).run(nodeId, new Date().toISOString());
}

function getNodeState(db: Database.Database, id: string): { archived: number; heat: number } | undefined {
  return db.prepare('SELECT archived, heat FROM nodes WHERE id = ?').get(id) as
    | { archived: number; heat: number }
    | undefined;
}

describe('Migration v16 — 清理 v15 漏掉的 is_superseded=1 错误归并节点', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('归档 is_superseded=1 + 有"去重合并"版本的 logseq 节点（v15 漏的）', () => {
    insertNode(db, 'supersed-dirty', {
      source_tool: 'logseq',
      is_superseded: 1,
      heat: 2.71,
    });
    insertDedupVersion(db, 'supersed-dirty');

    downgradeToV15(db);
    ensureSchema(db);

    const state = getNodeState(db, 'supersed-dirty');
    expect(state?.archived).toBe(1);
    expect(state?.heat).toBeCloseTo(0.02, 5);
  });

  it('同样处理 obsidian / notion / apple-notes 来源（is_superseded=1）', () => {
    insertNode(db, 'obs-s', { source_tool: 'obsidian', is_superseded: 1 });
    insertNode(db, 'notion-s', { source_tool: 'notion', is_superseded: 1 });
    insertNode(db, 'apple-s', { source_tool: 'apple-notes', is_superseded: 1 });
    insertDedupVersion(db, 'obs-s');
    insertDedupVersion(db, 'notion-s');
    insertDedupVersion(db, 'apple-s');

    downgradeToV15(db);
    ensureSchema(db);

    expect(getNodeState(db, 'obs-s')?.archived).toBe(1);
    expect(getNodeState(db, 'notion-s')?.archived).toBe(1);
    expect(getNodeState(db, 'apple-s')?.archived).toBe(1);
  });

  it('不影响 is_superseded=0 的节点（那是 v15 的职责）', () => {
    insertNode(db, 'active-dirty', {
      source_tool: 'logseq',
      is_superseded: 0,
      heat: 2.0,
    });
    insertDedupVersion(db, 'active-dirty');

    downgradeToV15(db);
    ensureSchema(db);

    // v16 不动 is_superseded=0 的节点（v15 在它之前跑过，或调用方在 v15 就已处理）
    const state = getNodeState(db, 'active-dirty');
    expect(state?.archived).toBe(0);
  });

  it('不影响没有"去重合并"版本的正常 superseded 节点', () => {
    insertNode(db, 'clean-supersed', { source_tool: 'logseq', is_superseded: 1 });
    // 没有 dedup version：这是正常的 logseq 编辑 supersede 链

    downgradeToV15(db);
    ensureSchema(db);

    const state = getNodeState(db, 'clean-supersed');
    expect(state?.archived).toBe(0);
  });

  it('不影响 claude-code 等非外部笔记来源', () => {
    insertNode(db, 'claude-supersed', {
      source_tool: 'claude-code',
      is_superseded: 1,
    });
    insertDedupVersion(db, 'claude-supersed');

    downgradeToV15(db);
    ensureSchema(db);

    expect(getNodeState(db, 'claude-supersed')?.archived).toBe(0);
  });

  it('已 archived 的不重复处理（archived=0 守卫）', () => {
    insertNode(db, 'already-archived', {
      source_tool: 'logseq',
      is_superseded: 1,
      archived: 1,
      heat: 0.02,
    });
    insertDedupVersion(db, 'already-archived');

    downgradeToV15(db);
    ensureSchema(db);

    expect(getNodeState(db, 'already-archived')?.archived).toBe(1);
  });

  it('幂等：二次降级触发的 v16 不改变状态', () => {
    insertNode(db, 'victim', {
      source_tool: 'logseq',
      is_superseded: 1,
      heat: 2.0,
    });
    insertDedupVersion(db, 'victim');

    downgradeToV15(db);
    ensureSchema(db);
    const firstState = getNodeState(db, 'victim');

    downgradeToV15(db);
    ensureSchema(db);
    const secondState = getNodeState(db, 'victim');

    expect(secondState).toEqual(firstState);
    expect(secondState?.archived).toBe(1);
  });

  it('从 v14 直接升到 v16 会依次跑 v15 和 v16，清理所有脏节点', () => {
    // 种两类脏节点：v15 能处理的 + v15 漏的
    insertNode(db, 'v15-target', {
      source_tool: 'logseq',
      is_superseded: 0,
      heat: 2.0,
    });
    insertDedupVersion(db, 'v15-target');

    insertNode(db, 'v16-target', {
      source_tool: 'logseq',
      is_superseded: 1,
      heat: 2.71,
    });
    insertDedupVersion(db, 'v16-target');

    // 降到 v14 → 会依次跑 v15 (清 is_superseded=0) 和 v16 (清 is_superseded=1)
    db.prepare("UPDATE metadata SET value = '14' WHERE key = 'schema_version'").run();
    ensureSchema(db);

    expect(getNodeState(db, 'v15-target')?.archived).toBe(1);
    expect(getNodeState(db, 'v16-target')?.archived).toBe(1);
  });
});
