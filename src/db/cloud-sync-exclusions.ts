import type Database from 'better-sqlite3';
import { now } from '../utils/time.js';

export type CloudSyncTable = 'nodes' | 'links';

/**
 * 暂时性的排除原因：本机尚未在云端注册（设备数超限），注册成功后放行。
 * 其余原因都是永久排除。
 */
export const TEMPORARY_EXCLUSION_REASON = 'device_not_registered';

/**
 * 把一条记录加入“不上传”名单（幂等）。
 * 已在名单内的记录保持原因不变，唯一的例外是暂时性排除可以被永久原因取代：
 * 否则先被暂存、之后被确认拒收的记录会在下一次放行时被错误地重新上传。
 */
export function excludeFromCloudSync(
  db: Database.Database,
  table: CloudSyncTable,
  id: string,
  reason: string,
): void {
  db.prepare(`
    INSERT INTO cloud_sync_excluded (tbl, id, reason, created) VALUES (?, ?, ?, ?)
    ON CONFLICT(tbl, id) DO UPDATE SET reason = excluded.reason, created = excluded.created
      WHERE cloud_sync_excluded.reason = ? AND excluded.reason <> ?
  `).run(table, id, reason, now(), TEMPORARY_EXCLUSION_REASON, TEMPORARY_EXCLUSION_REASON);
}

export function isExcludedFromCloudSync(db: Database.Database, table: CloudSyncTable, id: string): boolean {
  return db.prepare('SELECT 1 FROM cloud_sync_excluded WHERE tbl = ? AND id = ?').get(table, id) !== undefined;
}

/** 名单内的 id 集合（供对账过滤上传集合）。 */
export function listExcludedFromCloudSync(db: Database.Database, table: CloudSyncTable): Set<string> {
  const rows = db.prepare('SELECT id FROM cloud_sync_excluded WHERE tbl = ?').all(table) as Array<{ id: string }>;
  return new Set(rows.map(row => row.id));
}
/**
 * 把某个原因下的记录移出名单并重新记入待上传集合，返回放行的条数。
 * 用于暂时性的排除（例如设备尚未在云端注册）；永久排除的原因不应调用。
 */
export function releaseExcludedByReason(db: Database.Database, reason: string): number {
  return db.transaction(() => {
    const rows = db.prepare('SELECT tbl, id FROM cloud_sync_excluded WHERE reason = ?').all(reason) as Array<{ tbl: CloudSyncTable; id: string }>;
    const requeue = db.prepare('INSERT OR IGNORE INTO cloud_dirty (tbl, id) VALUES (?, ?)');
    for (const row of rows) requeue.run(row.tbl, row.id);
    db.prepare('DELETE FROM cloud_sync_excluded WHERE reason = ?').run(reason);
    return rows.length;
  })();
}
