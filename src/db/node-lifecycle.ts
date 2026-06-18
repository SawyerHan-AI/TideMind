import type Database from 'better-sqlite3';
import { createLink, linkExists } from './links.js';
import { deleteVector } from './vectors.js';
import { createLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { getLocalGeneration } from '../metabolism/generation-decay.js';

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
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (table|module):/i.test(msg)) {
      // Old local databases may not have every auxiliary table yet (rollback path).
      log.warn(`runMaybeMissingTable ignored missing auxiliary table: ${msg}`);
      return;
    }
    throw err;
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
  // 历史 bug:跨 links / node_versions / strategy_feedback / nodes_vec /
  // node_segments / nodes 多表 DELETE 全无事务包裹,中途崩溃(磁盘满、WAL
  // 写失败)留下脏数据 —— 与 v15/v16/v18 修补的孤儿向量同源。
  // better-sqlite3 嵌套调用自动转 SAVEPOINT,调用方已在事务里也安全。
  db.transaction(() => {
    deleteNodeDependents(db, nodeId, opts);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
  })();
}

export function archiveNodeWithVectors(db: Database.Database, nodeId: string): void {
  // UPDATE 与 deleteVector 必须原子:中间崩溃会留下 archived=1 但向量仍活
  // 的状态,vector search 路径靠 isNodeVisibleToVectorSearch 兜底过滤,但
  // 任何绕过它直接读 nodes_vec 的代码(包括历史 v15/v16 清理 SQL)都会再次
  // 受影响。
  db.transaction(() => {
    db.prepare('UPDATE nodes SET archived = 1, heat = 0.02, edit_seq = edit_seq + 1, updated = ? WHERE id = ?').run(now(), nodeId);
    deleteVector(db, nodeId);
  })();
}

export function reArchiveNodeWithVectors(db: Database.Database, nodeId: string): boolean {
  return db.transaction(() => {
    const result = db.prepare(
      'UPDATE nodes SET archived = 1, heat = 0.01, edit_seq = edit_seq + 1, updated = ? WHERE id = ? AND archived = 0',
    ).run(now(), nodeId);
    if (result.changes > 0) {
      deleteVector(db, nodeId);
    }
    return result.changes > 0;
  })();
}

export function unarchiveNodeRecordOnly(db: Database.Database, nodeId: string): boolean {
  // HIGH 修复(审计二轮):unarchive 重锚 decay_gen 到当前 generation。archived 节点 decay_gen
  // 被 recompute/synaptic 冻结(都过滤 archived),不重锚则恢复后(archived=0)重入衰减集,下次
  // generation 重算 gen=G−旧decay_gen 巨大 → heat=0.5 被砸到 0.01,M5 恢复在 heat 维度失效。
  const result = db.prepare(
    'UPDATE nodes SET archived = 0, heat = 0.5, edit_seq = edit_seq + 1, decay_gen = ?, updated = ? WHERE id = ? AND archived = 1',
  ).run(getLocalGeneration(db), now(), nodeId);
  return result.changes > 0;
}

export function deleteNodeVectors(db: Database.Database, nodeId: string): void {
  deleteVector(db, nodeId);
}

export function retireNodeWithoutReplacement(db: Database.Database, nodeId: string): void {
  // UPDATE + 软删原子化:中间崩溃会留下 is_superseded=1 但 links 仍指向老节点的孤儿状态。
  // M10:节点**保留**(is_superseded=1,行不删)→ 边必须**软删**而非硬删,否则边在 server 仍
  // alive、本地硬删 → reconcile 判 onlyServer 复活,指向 superseded 节点污染 connectivity/计数。
  // (对比 deleteNodeDependentsBatch:节点行随后被 DELETE,FK 要求边先物理删,那里保持硬删。)
  const ts = now();
  db.transaction(() => {
    db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01, updated = ? WHERE id = ?').run(ts, nodeId);
    db.prepare('UPDATE links SET deleted = 1, updated = ?, edit_seq = edit_seq + 1 WHERE (from_id = ? OR to_id = ?) AND deleted = 0').run(ts, nodeId, nodeId);
  })();
}

export function markNodeSupersededRecordOnly(db: Database.Database, nodeId: string): void {
  db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01, updated = ? WHERE id = ?').run(now(), nodeId);
}

/**
 * Mark oldNodeId as superseded by newNodeId and migrate its graph edges.
 *
 * 整体包事务:十几条 UPDATE/INSERT/DELETE 跨 links + nodes 多表写入,中途崩溃
 * 会留下"is_superseded=1 但 links 仍指向老节点"的孤儿状态(与 v15/v16 修补的
 * 孤儿向量同源)。better-sqlite3 嵌套自动转 SAVEPOINT,与上层 transaction 兼容。
 */
export function supersedeNodeWithLinks(
  db: Database.Database,
  oldNodeId: string,
  newNodeId: string,
): void {
  db.transaction(() => {
    // 事务内一致时间戳：所有 link 重定向使用同一 updated 值，避免微秒级漂移。
    // 必须 bump updated，否则 reconcile 看不到 supersede 的 link reroute（manifest LWW）。
    const ts = now();

    const outLinks = db.prepare(
      'SELECT * FROM links WHERE from_id = ? AND to_id != ? AND deleted = 0',
    ).all(oldNodeId, newNodeId) as LinkRow[];

    const inLinks = db.prepare(
      'SELECT * FROM links WHERE to_id = ? AND from_id != ? AND deleted = 0',
    ).all(oldNodeId, newNodeId) as LinkRow[];

    for (const link of outLinks) {
      const existingLinkOnNew = db.prepare(
        'SELECT id, strength FROM links WHERE from_id = ? AND to_id = ? AND deleted = 0',
      ).get(newNodeId, link.to_id) as Pick<LinkRow, 'id' | 'strength'> | undefined;

      if (!existingLinkOnNew) {
        db.prepare('UPDATE links SET from_id = ?, updated = ? WHERE id = ?').run(newNodeId, ts, link.id);
      } else if (link.strength > existingLinkOnNew.strength) {
        db.prepare('UPDATE links SET strength = ?, updated = ? WHERE id = ?').run(link.strength, ts, existingLinkOnNew.id);
      }
    }

    for (const link of inLinks) {
      const existingLinkOnNew = db.prepare(
        'SELECT id, strength FROM links WHERE from_id = ? AND to_id = ? AND deleted = 0',
      ).get(link.from_id, newNodeId) as Pick<LinkRow, 'id' | 'strength'> | undefined;

      if (!existingLinkOnNew) {
        db.prepare('UPDATE links SET to_id = ?, updated = ? WHERE id = ?').run(newNodeId, ts, link.id);
      } else if (link.strength > existingLinkOnNew.strength) {
        db.prepare('UPDATE links SET strength = ?, updated = ? WHERE id = ?').run(link.strength, ts, existingLinkOnNew.id);
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

    // M10:老节点**保留**(is_superseded=1)→ 未被重定向的残留边必须**软删**(deleted=1 + bump
    // edit_seq/updated)而非硬删,否则边在 server 仍 alive、本地硬删 → reconcile 判 onlyServer
    // 复活,指向 superseded 老节点污染 connectivity/计数。已重定向(from/to 改指 newNode)的边不在
    // 此 WHERE 范围,不受影响;新建的 oldNode→newNode "updates" 边被 NOT(...) 排除保留。
    db.prepare(
      'UPDATE links SET deleted = 1, updated = ?, edit_seq = edit_seq + 1 WHERE (from_id = ? OR to_id = ?) AND NOT (from_id = ? AND to_id = ?) AND deleted = 0',
    ).run(ts, oldNodeId, oldNodeId, oldNodeId, newNodeId);

    db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01, updated = ? WHERE id = ?').run(ts, oldNodeId);
  })();

  log.info(`节点版本替代: ${oldNodeId} -> ${newNodeId}`);
}
