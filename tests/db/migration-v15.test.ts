/**
 * Migration v15 单测：清理外部笔记来源节点被错误向量归并的历史数据
 *
 * 策略：先用 ensureSchema 建最新表（v15），然后手动把 schema_version 降到
 * v14 并种入测试数据，再次调 ensureSchema 触发 v15 migration，验证效果。
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

/**
 * 把 schema_version 降到 14，让下次 ensureSchema 触发 v15 migration
 */
function downgradeToV14(db: Database.Database): void {
  db.prepare("UPDATE metadata SET value = '14' WHERE key = 'schema_version'").run();
}

/**
 * 直接插入测试节点（不走 createNode，规避业务逻辑）
 */
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

describe('Migration v15 — 清理外部笔记错误归并节点', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('归档 logseq 来源 + 有"去重合并"版本历史的活跃节点', () => {
    insertNode(db, 'victim-logseq', { source_tool: 'logseq', heat: 2.7 });
    insertDedupVersion(db, 'victim-logseq');

    downgradeToV14(db);
    ensureSchema(db);

    const state = getNodeState(db, 'victim-logseq');
    expect(state?.archived).toBe(1);
    expect(state?.heat).toBeCloseTo(0.02, 5);
  });

  it('同样处理 obsidian / notion / apple-notes 来源', () => {
    insertNode(db, 'victim-obsidian', { source_tool: 'obsidian' });
    insertNode(db, 'victim-notion', { source_tool: 'notion' });
    insertNode(db, 'victim-apple', { source_tool: 'apple-notes' });
    insertDedupVersion(db, 'victim-obsidian');
    insertDedupVersion(db, 'victim-notion');
    insertDedupVersion(db, 'victim-apple');

    downgradeToV14(db);
    ensureSchema(db);

    expect(getNodeState(db, 'victim-obsidian')?.archived).toBe(1);
    expect(getNodeState(db, 'victim-notion')?.archived).toBe(1);
    expect(getNodeState(db, 'victim-apple')?.archived).toBe(1);
  });

  it('不影响没有"去重合并"版本的外部笔记节点（只是被正常 supersede/编辑的）', () => {
    insertNode(db, 'normal-logseq', { source_tool: 'logseq', heat: 1.0 });
    // 没有任何 node_versions 记录

    downgradeToV14(db);
    ensureSchema(db);

    const state = getNodeState(db, 'normal-logseq');
    expect(state?.archived).toBe(0);
    expect(state?.heat).toBeCloseTo(1.0, 5);
  });

  it('不影响有"去重合并"但 source_tool 不是外部笔记来源的节点（brain_digest 的合并是设计行为）', () => {
    insertNode(db, 'claude-merged', { source_tool: 'claude-code', heat: 1.3 });
    insertDedupVersion(db, 'claude-merged');

    downgradeToV14(db);
    ensureSchema(db);

    const state = getNodeState(db, 'claude-merged');
    expect(state?.archived).toBe(0);
  });

  it('已 archived 的节点不重复处理（archived=0 守卫）', () => {
    insertNode(db, 'already-archived', { source_tool: 'logseq', archived: 1, heat: 0.02 });
    insertDedupVersion(db, 'already-archived');

    downgradeToV14(db);
    ensureSchema(db);

    expect(getNodeState(db, 'already-archived')?.archived).toBe(1);
  });

  // 注：is_superseded=1 的节点由 v16 migration 处理（v15 当初漏了），详见
  // migration-v16.test.ts

  it('幂等：对同一个数据库再跑一次 migration 不改变状态', () => {
    insertNode(db, 'victim-2', { source_tool: 'logseq', heat: 2.0 });
    insertDedupVersion(db, 'victim-2');

    downgradeToV14(db);
    ensureSchema(db); // 第一次触发 v15
    const firstState = getNodeState(db, 'victim-2');

    // 再跑一次也不会把 archived 节点怎么样
    downgradeToV14(db);
    ensureSchema(db);
    const secondState = getNodeState(db, 'victim-2');

    expect(secondState).toEqual(firstState);
    expect(secondState?.archived).toBe(1);
  });

  it('同时清理 node_segments（避免残留分段污染搜索）', () => {
    insertNode(db, 'victim-seg', { source_tool: 'logseq' });
    insertDedupVersion(db, 'victim-seg');
    db.prepare(`
      INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES ('seg-1', 'victim-seg', 0)
    `).run();

    downgradeToV14(db);
    ensureSchema(db);

    const remaining = db.prepare(
      'SELECT COUNT(*) as cnt FROM node_segments WHERE node_id = ?',
    ).get('victim-seg') as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  it('无脏数据时也不会报错（早退）', () => {
    insertNode(db, 'clean', { source_tool: 'logseq' });
    // 没有 dedup version

    downgradeToV14(db);
    expect(() => ensureSchema(db)).not.toThrow();
    expect(getNodeState(db, 'clean')?.archived).toBe(0);
  });

  it('保留 node_versions 历史记录以便审计', () => {
    insertNode(db, 'victim-audit', { source_tool: 'logseq' });
    insertDedupVersion(db, 'victim-audit');

    downgradeToV14(db);
    ensureSchema(db);

    const versions = db.prepare(
      "SELECT COUNT(*) as cnt FROM node_versions WHERE node_id = 'victim-audit'",
    ).get() as { cnt: number };
    expect(versions.cnt).toBe(1); // 版本历史保留
  });
});
