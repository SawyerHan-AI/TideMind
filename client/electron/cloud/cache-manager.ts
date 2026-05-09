import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';
import { applyCloudLinkRow, applyCloudNodeRow } from './local-apply.js';

const log = createLogger('cloud-cache');

export class CacheManager {
  constructor(private db: Database.Database, private baseUrl: string) {}

  getLastSyncedVersion(): number {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = 'cloud_last_synced_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  setLastSyncedVersion(version: number): void {
    this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud_last_synced_version', ?)").run(String(version));
  }

  async applyChanges(changes: Array<{ table: string; action: string; data: Record<string, unknown>; sync_version: number }>, token: string): Promise<number> {
    let applied = 0;
    let blocked = false;
    let safeSyncedVersion: number | null = null;
    const orderedChanges = [...changes].sort((a, b) => Number(a.sync_version) - Number(b.sync_version));
    let currentVersion: number | null = null;
    let currentVersionApplied = true;

    const closeVersionGroup = () => {
      if (currentVersion === null) return;
      if (currentVersionApplied && !blocked) safeSyncedVersion = currentVersion;
      else blocked = true;
    };

    const txn = this.db.transaction(() => {
      for (const change of orderedChanges) {
        const version = Number(change.sync_version);
        if (currentVersion !== null && version !== currentVersion) {
          closeVersionGroup();
          currentVersionApplied = true;
        }
        currentVersion = version;

        let appliedThisChange = false;
        try {
          if (change.table === 'nodes') {
            applyCloudNodeRow(this.db, change.data);
            appliedThisChange = true;
          } else if (change.table === 'links') {
            applyCloudLinkRow(this.db, change.data);
            appliedThisChange = true;
          } else {
            log.warn(`unsupported cloud sync table: ${change.table}`);
          }
        } catch (e) {
          log.warn(`failed to apply change: ${(e as Error).message}`);
        }

        if (appliedThisChange) {
          applied++;
        } else {
          currentVersionApplied = false;
        }
      }
      closeVersionGroup();
    });
    txn();
    if (safeSyncedVersion !== null) {
      this.setLastSyncedVersion(safeSyncedVersion);
    }
    log.info(`applied ${applied}/${changes.length} changes`);
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
