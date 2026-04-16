import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';

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
    const txn = this.db.transaction(() => {
      for (const change of changes) {
        try {
          if (change.table === 'nodes') {
            this.upsertNode(change.data);
          } else if (change.table === 'links') {
            this.upsertLink(change.data);
          }
          // Other tables can be added later
          applied++;
        } catch (e) {
          log.warn(`failed to apply change: ${(e as Error).message}`);
        }
      }
    });
    txn();
    if (changes.length > 0) {
      const maxVersion = Math.max(...changes.map(c => c.sync_version));
      this.setLastSyncedVersion(maxVersion);
    }
    log.info(`applied ${applied}/${changes.length} changes`);
    return applied;
  }

  private upsertNode(data: Record<string, unknown>): void {
    const fields = [
      'id', 'type', 'content', 'title', 'heat', 'refinement', 'connectivity', 'independence',
      'specificity', 'subjectivity', 'actuality', 'source_tool', 'source_session', 'source_stream',
      'source_timestamp', 'tags', 'created', 'last_reconsolidated', 'version', 'archived',
      'is_keystone', 'is_crystal', 'is_tag', 'is_meta', 'is_superseded', 'maturity_score', 'source_device',
    ];
    const present = fields.filter(f => data[f] !== undefined);
    const placeholders = present.map(() => '?').join(',');
    const values = present.map(f => {
      const v = data[f];
      if (typeof v === 'object' && v !== null) return JSON.stringify(v);
      return v;
    });
    this.db.prepare(`INSERT OR REPLACE INTO nodes (${present.join(',')}) VALUES (${placeholders})`).run(...values as any[]);
  }

  private upsertLink(data: Record<string, unknown>): void {
    const fields = ['id', 'from_id', 'to_id', 'relation', 'strength', 'note', 'auto', 'status', 'created'];
    const present = fields.filter(f => data[f] !== undefined);
    const placeholders = present.map(() => '?').join(',');
    const values = present.map(f => {
      const v = data[f];
      if (typeof v === 'object' && v !== null) return JSON.stringify(v);
      return v;
    });
    this.db.prepare(`INSERT OR REPLACE INTO links (${present.join(',')}) VALUES (${placeholders})`).run(...values as any[]);
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
            if (table === 'nodes') this.upsertNode(row);
            else if (table === 'links') this.upsertLink(row);
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
