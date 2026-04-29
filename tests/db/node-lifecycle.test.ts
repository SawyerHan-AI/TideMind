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
