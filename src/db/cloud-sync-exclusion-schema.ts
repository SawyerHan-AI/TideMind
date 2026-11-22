import type Database from 'better-sqlite3';

/**
 * 云同步“不上传”名单（schema v52）。
 *
 * 设计依据：docs/design/primary-device-selection-2026-11-20.md §10.4。
 *
 * 非主设备新建的整理结果被云端拒收后，记录在这里：实时上行与对账的上传集合
 * 都跳过名单内的记录，否则它们会在每次对账时被重传、重拒，并让对账永远
 * 处于未完成状态。
 *
 * 本机数据，不加入 cloud_dirty trigger，不进入云同步。
 *
 * SQL 只有这一份权威定义：ensureSchema、v52 migration、Electron fresh / repair schema
 * 都必须调用 ensureCloudSyncExclusionSchema。
 */
export const CLOUD_SYNC_EXCLUSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cloud_sync_excluded (
    tbl TEXT NOT NULL CHECK (tbl IN ('nodes', 'links')),
    id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created TEXT NOT NULL,
    PRIMARY KEY (tbl, id)
);
`;

export function ensureCloudSyncExclusionSchema(db: Database.Database): void {
  db.exec(CLOUD_SYNC_EXCLUSION_SCHEMA_SQL);
}
