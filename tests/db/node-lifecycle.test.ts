import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { setupTestDb, seedLink, seedNode } from '../helpers/test-db.js';
import { getLinksForNode, getLinksFrom } from '../../src/db/links.js';
import { getNode } from '../../src/db/nodes.js';
import {
  archiveNodeWithVectors,
  deleteNodeDependentsBatch,
  deleteNodeCompletely,
  reArchiveNodeWithVectors,
  retireNodeWithoutReplacement,
  supersedeNodeWithLinks,
} from '../../src/db/node-lifecycle.js';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

function createPlainVectorTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes_vec (
      id TEXT PRIMARY KEY,
      embedding BLOB
    );
  `);
}

function insertSegmentVectors(nodeId: string): void {
  db.prepare('INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)').run(`${nodeId}#0`, nodeId, 0);
  db.prepare('INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)').run(`${nodeId}#1`, nodeId, 1);
  db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)').run(`${nodeId}#0`, Buffer.from([1, 2]));
  db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)').run(`${nodeId}#1`, Buffer.from([3, 4]));
}

describe('node lifecycle service', () => {
  it('archives a node and removes all segment vectors', () => {
    createPlainVectorTables();
    const node = seedNode(db, { heat: 1 });
    insertSegmentVectors(node.id);

    archiveNodeWithVectors(db, node.id);

    const archived = getNode(db, node.id)!;
    expect(archived.archived).toBe(1);
    expect(archived.heat).toBeCloseTo(0.02);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM node_segments WHERE node_id = ?').get(node.id) as { cnt: number }).cnt).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM nodes_vec WHERE id LIKE ?').get(`${node.id}#%`) as { cnt: number }).cnt).toBe(0);
  });

  it('re-archives a restored node and removes all segment vectors', () => {
    createPlainVectorTables();
    const node = seedNode(db, { heat: 1 });
    insertSegmentVectors(node.id);

    const ok = reArchiveNodeWithVectors(db, node.id);

    const archived = getNode(db, node.id)!;
    expect(ok).toBe(true);
    expect(archived.archived).toBe(1);
    expect(archived.heat).toBeCloseTo(0.01);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM node_segments WHERE node_id = ?').get(node.id) as { cnt: number }).cnt).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM nodes_vec WHERE id LIKE ?').get(`${node.id}#%`) as { cnt: number }).cnt).toBe(0);
  });

  it('supersedes a node through the centralized graph migration path', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const target = seedNode(db, { content: 'target' });
    seedLink(db, oldNode.id, target.id);

    supersedeNodeWithLinks(db, oldNode.id, newNode.id);

    const migratedLinks = getLinksFrom(db, newNode.id);
    expect(migratedLinks.some(l => l.to_id === target.id)).toBe(true);

    const oldLinks = getLinksForNode(db, oldNode.id);
    expect(oldLinks).toHaveLength(1);
    expect(oldLinks[0].to_id).toBe(newNode.id);
    expect(oldLinks[0].relation[0].type).toBe('updates');

    const oldAfter = getNode(db, oldNode.id)!;
    expect(oldAfter.is_superseded).toBe(1);
    expect(oldAfter.heat).toBeCloseTo(0.01);
  });

  it('M10: supersede 残留边软删(非硬删),防 reconcile 把它当 onlyServer 复活', () => {
    const oldNode = seedNode(db, { content: 'old' });
    const newNode = seedNode(db, { content: 'new' });
    const target = seedNode(db, { content: 'target' });
    // newNode 已有到 target 的边 → oldNode→target 重定向时撞重复、不 reroute → 成为残留待删边
    seedLink(db, oldNode.id, target.id);
    seedLink(db, newNode.id, target.id);

    supersedeNodeWithLinks(db, oldNode.id, newNode.id);

    // 老节点保留(is_superseded=1),残留 oldNode→target 边必须软删:物理行仍在 + deleted=1 + bump
    // edit_seq,靠 LWW 跨设备传播删除;若硬删,边在 server 仍 alive → reconcile 判 onlyServer 复活。
    const stale = db.prepare('SELECT deleted, edit_seq FROM links WHERE from_id = ? AND to_id = ?')
      .get(oldNode.id, target.id) as { deleted: number; edit_seq: number } | undefined;
    expect(stale).toBeDefined();                       // 行仍在(软删,非硬删)
    expect(stale!.deleted).toBe(1);
    expect(stale!.edit_seq).toBeGreaterThanOrEqual(1); // bump → 经因果序仲裁传播删除
    // 存活集不可见
    expect(getLinksForNode(db, oldNode.id).some(l => l.to_id === target.id)).toBe(false);
  });

  it('retires a node without replacement by clearing its graph edges', () => {
    const node = seedNode(db, { heat: 1 });
    const peer = seedNode(db);
    seedLink(db, node.id, peer.id);
    seedLink(db, peer.id, node.id);

    retireNodeWithoutReplacement(db, node.id);

    const retired = getNode(db, node.id)!;
    expect(retired.is_superseded).toBe(1);
    expect(retired.heat).toBeCloseTo(0.01);
    expect(getLinksForNode(db, node.id)).toEqual([]);
    // M10:节点保留(is_superseded=1)→ 边软删而非硬删:物理行仍在(deleted=1 + bump edit_seq),
    // 靠 LWW 跨设备传播删除,防止边在 server 仍 alive 被 reconcile 当 onlyServer 复活。
    const rawLinks = db.prepare('SELECT deleted, edit_seq FROM links WHERE from_id = ? OR to_id = ?')
      .all(node.id, node.id) as Array<{ deleted: number; edit_seq: number }>;
    expect(rawLinks).toHaveLength(2);
    expect(rawLinks.every(l => l.deleted === 1 && l.edit_seq >= 1)).toBe(true);
  });

  it('deletes node dependents before deleting the node, including segment vectors', () => {
    createPlainVectorTables();
    const node = seedNode(db);
    const peer = seedNode(db);
    seedLink(db, node.id, peer.id);

    db.prepare(
      'INSERT INTO node_versions (node_id, version, content, changed_at) VALUES (?, 1, ?, ?)',
    ).run(node.id, 'snapshot', '2024-01-01T00:00:00Z');
    db.prepare(
      'INSERT INTO strategy_feedback (strategy_name, node_id, created) VALUES (?, ?, ?)',
    ).run('test-strategy', node.id, '2024-01-01T00:00:00Z');
    insertSegmentVectors(node.id);

    deleteNodeCompletely(db, node.id);

    expect(getNode(db, node.id) ?? null).toBeNull();
    expect(getNode(db, peer.id)).not.toBeNull();
    expect(getLinksForNode(db, node.id)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM node_versions WHERE node_id = ?').get(node.id) as { cnt: number }).cnt).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM strategy_feedback WHERE node_id = ?').get(node.id) as { cnt: number }).cnt).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM node_segments WHERE node_id = ?').get(node.id) as { cnt: number }).cnt).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM nodes_vec WHERE id LIKE ?').get(`${node.id}#%`) as { cnt: number }).cnt).toBe(0);
  });

  // 守护：所有 lifecycle 操作必须 bump updated，否则 cloud reconcile 看不到 archive/
  // supersede 状态变化（client.updated 永远 = created，永远输给 server.updated）。
  // 见 docs/work-logs/2026-05-10.md。
  describe('updated field bumping', () => {
    function rawUpdated(id: string): string | null {
      return (db.prepare('SELECT updated FROM nodes WHERE id = ?').get(id) as { updated: string | null } | undefined)?.updated ?? null;
    }

    it('archiveNodeWithVectors should advance updated', async () => {
      const node = seedNode(db);
      const before = rawUpdated(node.id)!;
      await new Promise(r => setTimeout(r, 5));
      archiveNodeWithVectors(db, node.id);
      expect(rawUpdated(node.id)! > before).toBe(true);
    });

    it('reArchiveNodeWithVectors should advance updated', async () => {
      const node = seedNode(db);
      const before = rawUpdated(node.id)!;
      await new Promise(r => setTimeout(r, 5));
      reArchiveNodeWithVectors(db, node.id);
      expect(rawUpdated(node.id)! > before).toBe(true);
    });

    it('retireNodeWithoutReplacement should advance updated', async () => {
      const node = seedNode(db);
      const before = rawUpdated(node.id)!;
      await new Promise(r => setTimeout(r, 5));
      retireNodeWithoutReplacement(db, node.id);
      expect(rawUpdated(node.id)! > before).toBe(true);
    });

    it('supersedeNodeWithLinks should advance updated on the old node', async () => {
      const oldNode = seedNode(db, { content: 'old' });
      const newNode = seedNode(db, { content: 'new' });
      const before = rawUpdated(oldNode.id)!;
      await new Promise(r => setTimeout(r, 5));
      supersedeNodeWithLinks(db, oldNode.id, newNode.id);
      expect(rawUpdated(oldNode.id)! > before).toBe(true);
    });
  });

  it('only ignores missing auxiliary tables in legacy rollback mode', () => {
    const node = seedNode(db);
    const peer = seedNode(db);
    seedLink(db, node.id, peer.id);

    db.exec(`
      CREATE TRIGGER block_link_delete
      BEFORE DELETE ON links
      BEGIN
        SELECT RAISE(ABORT, 'blocked link delete');
      END;
    `);

    expect(() => deleteNodeDependentsBatch(
      db,
      [node.id],
      { ignoreMissingTables: true },
    )).toThrow(/blocked link delete/);

    db.exec('DROP TRIGGER block_link_delete');
    db.exec('DROP TABLE strategy_feedback');

    expect(() => deleteNodeDependentsBatch(
      db,
      [node.id],
      { ignoreMissingTables: true },
    )).not.toThrow();
  });
});
