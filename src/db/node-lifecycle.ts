import type Database from 'better-sqlite3';
import { createLink, linkExists } from './links.js';
import { deleteVector } from './vectors.js';
import { createLogger } from '../utils/logger.js';

interface LinkRow { id: string; from_id: string; to_id: string; strength: number; }

const log = createLogger('node-lifecycle');

function runMaybeMissingTable(statement: () => void, ignoreMissingTables: boolean): void {
  if (!ignoreMissingTables) {
    statement();
    return;
  }
  try {
    statement();
  } catch (err) {
    // Old local databases may not have every auxiliary table yet (rollback path).
    // 但同步真正的 SQL 错误（约束冲突/磁盘错误）会被同样吞掉，至少留一行 warn
    // 让事故复盘时能定位。
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`runMaybeMissingTable swallowed: ${msg}`);
  }
}

/**
 * Delete rows that directly depend on the given nodes, without deleting the
 * nodes themselves. Vector cleanup must remove nodes_vec before node_segments
 * because nodes_vec.id stores segment_id, not node.id.
 */
export function deleteNodeDependentsBatch(
  db: Database.Database,
  nodeIds: string[],
  opts: { ignoreMissingTables?: boolean } = {},
): void {
  if (nodeIds.length === 0) return;

  const ignoreMissingTables = opts.ignoreMissingTables ?? false;
  const placeholders = nodeIds.map(() => '?').join(',');

  runMaybeMissingTable(
    () => db.prepare(`DELETE FROM links WHERE from_id IN (${placeholders})`).run(...nodeIds),
    ignoreMissingTables,
  );
  runMaybeMissingTable(
    () => db.prepare(`DELETE FROM links WHERE to_id IN (${placeholders})`).run(...nodeIds),
    ignoreMissingTables,
  );
  runMaybeMissingTable(
    () => db.prepare(`DELETE FROM node_versions WHERE node_id IN (${placeholders})`).run(...nodeIds),
    ignoreMissingTables,
  );
  runMaybeMissingTable(
    () => db.prepare(`DELETE FROM strategy_feedback WHERE node_id IN (${placeholders})`).run(...nodeIds),
    ignoreMissingTables,
  );

  runMaybeMissingTable(() => {
    const segmentRows = db.prepare(
      `SELECT segment_id FROM node_segments WHERE node_id IN (${placeholders})`,
    ).all(...nodeIds) as Array<{ segment_id: string }>;
    const deleteVec = db.prepare('DELETE FROM nodes_vec WHERE id = ?');
    for (const row of segmentRows) deleteVec.run(row.segment_id);
  }, ignoreMissingTables);

  runMaybeMissingTable(
    () => db.prepare(`DELETE FROM node_segments WHERE node_id IN (${placeholders})`).run(...nodeIds),
    ignoreMissingTables,
  );
}

export function deleteNodeDependents(
  db: Database.Database,
  nodeId: string,
  opts: { ignoreMissingTables?: boolean } = {},
): void {
  deleteNodeDependentsBatch(db, [nodeId], opts);
}

export function deleteNodeCompletely(
  db: Database.Database,
  nodeId: string,
  opts: { ignoreMissingTables?: boolean } = {},
): void {
  deleteNodeDependents(db, nodeId, opts);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
}

export function archiveNodeWithVectors(db: Database.Database, nodeId: string): void {
  db.prepare(
    'UPDATE nodes SET archived = 1, heat = 0.02 WHERE id = ?',
  ).run(nodeId);
  deleteVector(db, nodeId);
}

export function reArchiveNodeWithVectors(db: Database.Database, nodeId: string): boolean {
  const result = db.prepare(
    'UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ? AND archived = 0',
  ).run(nodeId);
  if (result.changes > 0) {
    deleteVector(db, nodeId);
  }
  return result.changes > 0;
}

export function unarchiveNodeRecordOnly(db: Database.Database, nodeId: string): boolean {
  const result = db.prepare(
    'UPDATE nodes SET archived = 0, heat = 0.5 WHERE id = ? AND archived = 1',
  ).run(nodeId);
  return result.changes > 0;
}

export function deleteNodeVectors(db: Database.Database, nodeId: string): void {
  deleteVector(db, nodeId);
}

export function retireNodeWithoutReplacement(db: Database.Database, nodeId: string): void {
  db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(nodeId);
  db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(nodeId, nodeId);
}

export function markNodeSupersededRecordOnly(db: Database.Database, nodeId: string): void {
  db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(nodeId);
}

/**
 * Mark oldNodeId as superseded by newNodeId and migrate its graph edges.
 */
export function supersedeNodeWithLinks(
  db: Database.Database,
  oldNodeId: string,
  newNodeId: string,
): void {
  const outLinks = db.prepare(
    'SELECT * FROM links WHERE from_id = ? AND to_id != ?',
  ).all(oldNodeId, newNodeId) as LinkRow[];

  const inLinks = db.prepare(
    'SELECT * FROM links WHERE to_id = ? AND from_id != ?',
  ).all(oldNodeId, newNodeId) as LinkRow[];

  for (const link of outLinks) {
    const existingLinkOnNew = db.prepare(
      'SELECT id, strength FROM links WHERE from_id = ? AND to_id = ?',
    ).get(newNodeId, link.to_id) as Pick<LinkRow, 'id' | 'strength'> | undefined;

    if (!existingLinkOnNew) {
      db.prepare('UPDATE links SET from_id = ? WHERE id = ?').run(newNodeId, link.id);
    } else if (link.strength > existingLinkOnNew.strength) {
      db.prepare('UPDATE links SET strength = ? WHERE id = ?').run(link.strength, existingLinkOnNew.id);
    }
  }

  for (const link of inLinks) {
    const existingLinkOnNew = db.prepare(
      'SELECT id, strength FROM links WHERE from_id = ? AND to_id = ?',
    ).get(link.from_id, newNodeId) as Pick<LinkRow, 'id' | 'strength'> | undefined;

    if (!existingLinkOnNew) {
      db.prepare('UPDATE links SET to_id = ? WHERE id = ?').run(newNodeId, link.id);
    } else if (link.strength > existingLinkOnNew.strength) {
      db.prepare('UPDATE links SET strength = ? WHERE id = ?').run(link.strength, existingLinkOnNew.id);
    }
  }

  if (!linkExists(db, oldNodeId, newNodeId)) {
    createLink(db, {
      from_id: oldNodeId,
      to_id: newNodeId,
      relation: [{ type: 'updates', confidence: 0.9 }],
      strength: 0.9,
      note: '节点版本更新',
      auto: true,
      status: 'confirmed',
    });
  }

  db.prepare(
    'DELETE FROM links WHERE (from_id = ? OR to_id = ?) AND NOT (from_id = ? AND to_id = ?)',
  ).run(oldNodeId, oldNodeId, oldNodeId, newNodeId);

  db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(oldNodeId);

  log.info(`节点版本替代: ${oldNodeId} -> ${newNodeId}`);
}
