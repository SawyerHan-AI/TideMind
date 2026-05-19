import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';
import { applyCloudLinkRow, applyCloudNodeRow } from './local-apply.js';

const log = createLogger('cloud-cache');

interface CloudChange {
  table: string;
  action: string;
  data: Record<string, unknown>;
  sync_version: number;
}

export class CacheManager {
  constructor(private db: Database.Database, private baseUrl: string) {}

  getLastSyncedVersion(): number {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = 'cloud_last_synced_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  setLastSyncedVersion(version: number): void {
    this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud_last_synced_version', ?)").run(String(version));
  }

  /**
   * 写入 cloud_sync_dead_letters 表。同 (table, id) 已在表里 → 更新 error/version。
   *
   * Why: applyChanges 单条失败原本让整组 sync_version 阻塞,导致 cursor 永不推进,
   * 下次 pull 仍拉到同一条坏数据 → 无限循环。改为坏数据入此表 + cursor 照常推进,
   * 故障数据被隔离,正常数据不受影响。
   */
  private recordDeadLetter(change: CloudChange, error: Error): void {
    const resourceId = String(change.data?.id ?? '<unknown>');
    try {
      this.db.prepare(`
        INSERT INTO cloud_sync_dead_letters (resource_table, resource_id, sync_version, payload, error_message)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(resource_table, resource_id) DO UPDATE SET
          sync_version = excluded.sync_version,
          payload = excluded.payload,
          error_message = excluded.error_message,
          created = datetime('now')
      `).run(
        change.table,
        resourceId,
        change.sync_version,
        JSON.stringify(change.data),
        error.message,
      );
      log.warn(`dead-letter: ${change.table}#${resourceId} sync_version=${change.sync_version}: ${error.message}`);
    } catch (e) {
      // 入 dead-letter 都失败(极不应该) → 仅 log,不抛,因为 caller 已经在
      // 处理失败 case。否则会"修复 cursor 卡死"的 bug 反过来让 cursor 卡死。
      log.error(`failed to record dead-letter for ${change.table}#${resourceId}: ${(e as Error).message}`);
    }
  }

  async applyChanges(changes: CloudChange[], _token: string): Promise<number> {
    let applied = 0;
    let deadLettered = 0;
    let safeSyncedVersion: number | null = null;
    const orderedChanges = [...changes].sort((a, b) => Number(a.sync_version) - Number(b.sync_version));
    let currentVersion: number | null = null;

    const txn = this.db.transaction(() => {
      for (const change of orderedChanges) {
        const version = Number(change.sync_version);
        if (currentVersion !== null && version !== currentVersion) {
          // 组关闭:推进 safeSyncedVersion 到 currentVersion(无条件,因为失败项已入 dead-letter)
          safeSyncedVersion = currentVersion;
        }
        currentVersion = version;

        try {
          if (change.table === 'nodes') {
            applyCloudNodeRow(this.db, change.data);
            applied++;
          } else if (change.table === 'links') {
            applyCloudLinkRow(this.db, change.data);
            applied++;
          } else {
            log.warn(`unsupported cloud sync table: ${change.table}`);
            this.recordDeadLetter(change, new Error(`unsupported table: ${change.table}`));
            deadLettered++;
          }
        } catch (e) {
          // 失败 → 入 dead-letter,继续推进 cursor
          this.recordDeadLetter(change, e as Error);
          deadLettered++;
        }
      }
      // 最后一组也要推进 cursor
      if (currentVersion !== null) {
        safeSyncedVersion = currentVersion;
      }
    });
    txn();
    if (safeSyncedVersion !== null) {
      this.setLastSyncedVersion(safeSyncedVersion);
    }
    if (deadLettered > 0) {
      log.warn(`applied ${applied}/${changes.length} changes (${deadLettered} dead-lettered)`);
    } else {
      log.info(`applied ${applied}/${changes.length} changes`);
    }
    return applied;
  }

  async fullSync(token: string): Promise<void> {
    log.info('starting full sync...');
    for (const table of ['nodes', 'links']) {
      let cursor: string | undefined;
      let hasMore = true;
      let total = 0;
      while (hasMore) {
        const url = new URL(`${this.baseUrl}/api/v1/sync/full`);
        url.searchParams.set('table', table);
        if (cursor) url.searchParams.set('cursor', cursor);
        url.searchParams.set('limit', '500');

        const res = await fetch(url.toString(), {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Full sync failed for ${table}: ${res.status}`);
        const data = await res.json();

        // Apply rows
        const txn = this.db.transaction(() => {
          for (const row of data.rows) {
            if (table === 'nodes') applyCloudNodeRow(this.db, row);
            else if (table === 'links') applyCloudLinkRow(this.db, row);
          }
        });
        txn();

        total += data.rows.length;
        cursor = data.next_cursor;
        hasMore = data.has_more;
      }
      log.info(`full sync ${table}: ${total} rows`);
    }

    // Get current version
    const verRes = await fetch(`${this.baseUrl}/api/v1/sync/version`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (verRes.ok) {
      const { version } = await verRes.json();
      this.setLastSyncedVersion(version);
    }
    log.info('full sync complete');
  }
}
