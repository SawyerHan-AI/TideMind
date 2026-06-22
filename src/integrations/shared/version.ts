import type Database from 'better-sqlite3';
import { supersedeNodeWithLinks } from '../../db/node-lifecycle.js';

/**
 * 将旧节点标记为被取代，迁移链接到新节点
 *
 * 1. 迁移旧节点的所有链接到新节点（from/to 两个方向）
 * 2. 如果迁移后产生重复链接，删除重复的
 * 3. 创建 oldNodeId -> newNodeId 的 updates 链接
 * 4. 删除旧节点上除 updates 链接外的所有链接
 * 5. 标记旧节点 is_superseded=1，派生字段落地板（heat=0.01, connectivity=0,
 *    maturity_score=0）并 bump edit_seq（让退休成为因果版本事件，可靠同步到云端）
 */
export function supersedeNode(
  db: Database.Database,
  oldNodeId: string,
  newNodeId: string,
): void {
  supersedeNodeWithLinks(db, oldNodeId, newNodeId);
}
