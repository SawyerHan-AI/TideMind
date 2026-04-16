import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { createLink, linkExists } from '../../db/links.js';

interface LinkRow { id: string; from_id: string; to_id: string; strength: number; }

const log = createLogger('version');

/**
 * 将旧节点标记为被取代，迁移链接到新节点
 *
 * 1. 迁移旧节点的所有链接到新节点（from/to 两个方向）
 * 2. 如果迁移后产生重复链接，删除重复的
 * 3. 创建 oldNodeId -> newNodeId 的 updates 链接
 * 4. 删除旧节点上除 updates 链接外的所有链接
 * 5. 标记旧节点 is_superseded=1, heat=0.01
 */
export function supersedeNode(
  db: Database.Database,
  oldNodeId: string,
  newNodeId: string,
): void {
  // Step 1: Find all links connected to oldNode (both directions), excluding links to newNode
  const outLinks = db.prepare(
    'SELECT * FROM links WHERE from_id = ? AND to_id != ?',
  ).all(oldNodeId, newNodeId) as LinkRow[];

  const inLinks = db.prepare(
    'SELECT * FROM links WHERE to_id = ? AND from_id != ?',
  ).all(oldNodeId, newNodeId) as LinkRow[];

  // Step 2: Migrate outgoing links (from=old -> from=new)
  for (const link of outLinks) {
    const existingLinkOnNew = db.prepare(
      'SELECT id, strength FROM links WHERE from_id = ? AND to_id = ?',
    ).get(newNodeId, link.to_id) as Pick<LinkRow, 'id' | 'strength'> | undefined;

    if (!existingLinkOnNew) {
      db.prepare('UPDATE links SET from_id = ? WHERE id = ?').run(newNodeId, link.id);
    } else {
      // Duplicate exists: merge strength (keep the max) before the old link is removed in step 5
      if (link.strength > existingLinkOnNew.strength) {
        db.prepare('UPDATE links SET strength = ? WHERE id = ?').run(link.strength, existingLinkOnNew.id);
      }
    }
  }

  // Step 3: Migrate incoming links (to=old -> to=new)
  for (const link of inLinks) {
    const existingLinkOnNew = db.prepare(
      'SELECT id, strength FROM links WHERE from_id = ? AND to_id = ?',
    ).get(link.from_id, newNodeId) as Pick<LinkRow, 'id' | 'strength'> | undefined;

    if (!existingLinkOnNew) {
      db.prepare('UPDATE links SET to_id = ? WHERE id = ?').run(newNodeId, link.id);
    } else {
      // Duplicate exists: merge strength (keep the max) before the old link is removed in step 5
      if (link.strength > existingLinkOnNew.strength) {
        db.prepare('UPDATE links SET strength = ? WHERE id = ?').run(link.strength, existingLinkOnNew.id);
      }
    }
  }

  // Step 4: Create updates link old -> new
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

  // Step 5: Delete all links on old node EXCEPT the updates link to new node
  db.prepare(
    'DELETE FROM links WHERE (from_id = ? OR to_id = ?) AND NOT (from_id = ? AND to_id = ?)',
  ).run(oldNodeId, oldNodeId, oldNodeId, newNodeId);

  // Step 6: Mark old node as superseded
  // updateNode doesn't include is_superseded in ALLOWED_COLUMNS, use raw SQL
  db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(oldNodeId);

  log.info(`节点版本替代: ${oldNodeId} -> ${newNodeId}`);
}
