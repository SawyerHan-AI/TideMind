/**
 * Cloud Sync Reconciler — 基于 manifest diff 的双向收敛同步。
 *
 * 触发时机:
 *   1. 首次开启云同步(metadata['cloud.last_reconcile_at_nodes'] 为空)
 *   2. sync-client.start() 检测距离上次 reconcile > 7 天
 *   3. 用户手动点"强制对齐"按钮
 *
 * 算法:
 *   1. 拉服务端 manifest(分页)
 *   2. 扫本地 nodes/links 建本地 manifest
 *   3. diff 出 onlyLocal / onlyServer / conflict
 *   4. 分批 bulk-upsert(onlyLocal + 本地新的 conflict)
 *   5. 分批 bulk-fetch 下载(onlyServer + 服务端新的 conflict)
 *   6. 写 metadata['cloud.last_reconcile_at_{table}']
 *
 * 失败处理: 任一步骤失败 → abort 当前 table 的 reconcile + 写错误状态;
 * 不污染下次重试(last_reconcile_at 不写表示未完成,下次启动会重试)。
 */

import type Database from 'better-sqlite3';
import { BrowserWindow, Notification } from 'electron';
import { createLogger } from '../../../src/utils/logger.js';
import { getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js';

const log = createLogger('reconciler');

const BATCH_SIZE = 100;
const MANIFEST_PAGE_LIMIT = 5000;
// 时间戳相等容差(毫秒)。SQLite datetime('now') 无毫秒、PG now() 带毫秒,
// 同一次写入双方时间戳可能有 1s 以内抖动。超过该容差才认为是真正不同的版本。
const TS_EQUAL_TOLERANCE_MS = 1000;

/**
 * 把 SQLite / PG / JS 三种格式的时间戳字符串规范化为毫秒数。
 *  - SQLite `datetime('now')`: '2026-04-20 10:30:00'(无 T、无时区,UTC)
 *  - PG JSONB ISO:            '2026-04-20T10:30:00.123+00:00' 或 '...Z'
 *  - JS Date.toISOString():   '2026-04-20T10:30:00.123Z'
 * 无效输入返回 0。
 */
export function normalizeTs(ts: string | null | undefined): number {
  if (!ts) return 0;
  let s = String(ts).trim();
  if (!s) return 0;
  // SQLite 'YYYY-MM-DD HH:MM:SS[.fff]' → ISO 'YYYY-MM-DDTHH:MM:SS[.fff]'
  if (!s.includes('T') && s.length >= 10 && s[10] === ' ') {
    s = s.slice(0, 10) + 'T' + s.slice(11);
  }
  // SQLite 默认 UTC 但不带时区后缀;若只有 T 没有 Z/+/- 时区,补 Z
  const hasTz = /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes('T') && !hasTz) {
    s += 'Z';
  }
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** 两个时间戳是否"实质相等"(容忍 1s 抖动)。 */
export function timestampsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = normalizeTs(a);
  const db = normalizeTs(b);
  if (da === 0 && db === 0) return true;
  return Math.abs(da - db) < TS_EQUAL_TOLERANCE_MS;
}

export type Table = 'nodes' | 'links';
export type ReconcilePhase = 'idle' | 'manifest' | 'diff' | 'upload' | 'download' | 'done' | 'failed';

export interface ReconcileProgress {
  table: Table;
  phase: ReconcilePhase;
  total: number;
  processed: number;
  errorMessage?: string;
}

export interface ReconcileResult {
  table: Table;
  uploaded: number;
  downloaded: number;
  conflicts: number;
  skipped: number;
  errors: string[];
}

interface ManifestEntry {
  id: string;
  sync_version: number;
  updated: string;
  archived: boolean;
}

export class Reconciler {
  private progress: ReconcileProgress = { table: 'nodes', phase: 'idle', total: 0, processed: 0 };
  private aborted = false;

  constructor(private db: Database.Database) {}

  getProgress(): ReconcileProgress {
    return { ...this.progress };
  }

  abort(): void {
    this.aborted = true;
  }

  /**
   * 跑一轮 reconcile(nodes + links)。
   * 整体幂等,中断后下次可以重跑。
   */
  async runAll(isInitial: boolean): Promise<ReconcileResult[]> {
    this.aborted = false;
    const results: ReconcileResult[] = [];
    for (const table of ['nodes', 'links'] as const) {
      if (this.aborted) break;
      try {
        const r = await this.runTable(table, isInitial);
        results.push(r);
        this.setMetadata(`cloud.last_reconcile_at_${table}`, new Date().toISOString());
      } catch (err) {
        const msg = (err as Error).message;
        log.error(`reconcile ${table} failed: ${msg}`);
        this.progress.phase = 'failed';
        this.progress.errorMessage = msg;
        results.push({ table, uploaded: 0, downloaded: 0, conflicts: 0, skipped: 0, errors: [msg] });
      }
    }

    // 整体状态 + 失败通知
    const anyFailed = results.some(r => r.errors.length > 0);
    const status = this.aborted ? 'partial' : (anyFailed ? 'failed' : 'ok');
    this.setMetadata('cloud.last_reconcile_status', status);

    if (anyFailed) {
      this.setMetadata('cloud.last_reconcile_error', results.flatMap(r => r.errors).join('; '));
      this.showFailureNotification(results);
    }

    this.emitProgress();
    return results;
  }

  private showFailureNotification(results: ReconcileResult[]): void {
    try {
      if (!Notification.isSupported()) return;
      const failedTables = results.filter(r => r.errors.length > 0).map(r => r.table).join(', ');
      const firstError = results.flatMap(r => r.errors)[0] ?? 'unknown error';
      new Notification({
        title: 'TideMind — 云端对齐失败',
        body: `${failedTables}: ${firstError.slice(0, 120)}`,
        silent: false,
      }).show();
    } catch (err) {
      log.debug(`notification failed: ${(err as Error).message}`);
    }
  }

  private async runTable(table: Table, isInitial: boolean): Promise<ReconcileResult> {
    this.progress = { table, phase: 'manifest', total: 0, processed: 0 };
    this.emitProgress();

    // Step 1: 拉服务端 manifest
    const serverManifest = await this.fetchServerManifest(table);
    if (this.aborted) throw new Error('aborted');

    // Step 2: 扫本地
    this.progress.phase = 'diff';
    this.emitProgress();
    const localManifest = this.buildLocalManifest(table);

    // Step 3: diff
    const serverMap = new Map(serverManifest.map(e => [e.id, e]));
    const localMap = new Map(localManifest.map(e => [e.id, e]));

    const onlyLocal: string[] = [];
    const onlyServer: string[] = [];
    const bothConflict: Array<{ id: string; localNewer: boolean }> = [];

    for (const [id, local] of localMap.entries()) {
      const server = serverMap.get(id);
      if (!server) {
        onlyLocal.push(id);
      } else if (!timestampsEqual(local.updated, server.updated)) {
        // 时间戳不等才算 conflict。字符串比较无法处理 SQLite(无毫秒无时区)
        // vs PG ISO(带毫秒带 +00:00)格式差,一律相等比较会把所有行判为冲突
        // 触发双向全量传输 → 用户一点"强制对齐"就可能把服务端干超时。
        bothConflict.push({ id, localNewer: normalizeTs(local.updated) > normalizeTs(server.updated) });
      }
    }
    for (const id of serverMap.keys()) {
      if (!localMap.has(id)) onlyServer.push(id);
    }

    log.info(`reconcile ${table}: onlyLocal=${onlyLocal.length} onlyServer=${onlyServer.length} conflict=${bothConflict.length}`);

    // Step 4: upload(onlyLocal + local-newer-conflict)
    const toUpload = [...onlyLocal, ...bothConflict.filter(c => c.localNewer).map(c => c.id)];
    this.progress = { table, phase: 'upload', total: toUpload.length, processed: 0 };
    this.emitProgress();
    let uploaded = 0;
    let uploadSkipped = 0;
    for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
      if (this.aborted) throw new Error('aborted');
      const batch = toUpload.slice(i, i + BATCH_SIZE);
      const items = this.loadFullRows(table, batch);
      const { processed, skipped } = await this.bulkUpsert(table, items, isInitial);
      uploaded += processed;
      uploadSkipped += skipped.length;
      this.progress.processed = Math.min(toUpload.length, i + BATCH_SIZE);
      this.emitProgress();
    }

    // Step 5: download(onlyServer + server-newer-conflict)
    const toDownload = [...onlyServer, ...bothConflict.filter(c => !c.localNewer).map(c => c.id)];
    this.progress = { table, phase: 'download', total: toDownload.length, processed: 0 };
    this.emitProgress();
    let downloaded = 0;
    for (let i = 0; i < toDownload.length; i += BATCH_SIZE) {
      if (this.aborted) throw new Error('aborted');
      const batch = toDownload.slice(i, i + BATCH_SIZE);
      const fetched = await this.bulkFetch(table, batch);
      this.applyServerRows(table, fetched);
      downloaded += fetched.length;
      this.progress.processed = Math.min(toDownload.length, i + BATCH_SIZE);
      this.emitProgress();
    }

    this.progress = { table, phase: 'done', total: toUpload.length + toDownload.length, processed: toUpload.length + toDownload.length };
    this.emitProgress();

    return {
      table,
      uploaded,
      downloaded,
      conflicts: bothConflict.length,
      skipped: uploadSkipped,
      errors: [],
    };
  }

  // ── Manifest 拉取 ────────────────────────────────────────

  private async fetchServerManifest(table: Table): Promise<ManifestEntry[]> {
    const all: ManifestEntry[] = [];
    let cursor = '';
    while (true) {
      const token = await refreshTokenIfNeeded();
      if (!token) throw new Error('not_logged_in');
      const url = new URL(`${getCloudBaseUrl()}/api/v1/sync/manifest`);
      url.searchParams.set('table', table);
      url.searchParams.set('limit', String(MANIFEST_PAGE_LIMIT));
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        throw new Error(`manifest ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = await res.json() as { items: ManifestEntry[]; has_more: boolean; next_cursor: string | null };
      all.push(...data.items);
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return all;
  }

  // ── 本地 manifest ────────────────────────────────────────

  private buildLocalManifest(table: Table): ManifestEntry[] {
    const rows = table === 'nodes'
      ? this.db.prepare(`SELECT id, COALESCE(created, '') as created, COALESCE(updated, created) as updated, archived FROM nodes`).all() as Array<{ id: string; created: string; updated: string; archived: number }>
      : this.db.prepare(`SELECT id, COALESCE(created, '') as created, COALESCE(updated, created) as updated FROM links`).all() as Array<{ id: string; created: string; updated: string }>;

    return rows.map(r => ({
      id: r.id,
      sync_version: 0, // 本地没存 sync_version,不参与比较
      updated: r.updated || r.created || new Date(0).toISOString(),
      archived: 'archived' in r ? Boolean((r as { archived: number }).archived) : false,
    }));
  }

  // ── Bulk upsert / fetch ─────────────────────────────────

  private async bulkUpsert(table: Table, items: Record<string, unknown>[], isInitial: boolean): Promise<{ processed: number; skipped: Array<{ id: string; reason: string }> }> {
    const token = await refreshTokenIfNeeded();
    if (!token) throw new Error('not_logged_in');
    const res = await fetch(`${getCloudBaseUrl()}/api/v1/sync/bulk-upsert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, is_initial_reconcile: isInitial, items }),
    });
    if (!res.ok) {
      throw new Error(`bulk-upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json() as { processed: number; skipped: Array<{ id: string; reason: string }> };
  }

  private async bulkFetch(table: Table, ids: string[]): Promise<Array<Record<string, unknown>>> {
    if (ids.length === 0) return [];
    const token = await refreshTokenIfNeeded();
    if (!token) throw new Error('not_logged_in');
    const url = `${getCloudBaseUrl()}/api/v1/sync/bulk-fetch?table=${table}&ids=${ids.map(encodeURIComponent).join(',')}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`bulk-fetch ${res.status}`);
    const data = await res.json() as { items: Array<Record<string, unknown>> };
    return data.items;
  }

  // ── 本地应用服务端行 ─────────────────────────────────────

  private loadFullRows(table: Table, ids: string[]): Record<string, unknown>[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    // 规范化:tags 是 JSON 字符串,转成 array(服务端期望 JSONB);
    // archived (INTEGER) 转 boolean 方便 server parse。
    return rows.map(r => {
      const out: Record<string, unknown> = { ...r };
      if (typeof out.tags === 'string') {
        try { out.tags = JSON.parse(out.tags as string); } catch { /* 保留字符串,server 兼容 */ }
      }
      if (typeof out.archived === 'number') out.archived = Boolean(out.archived);
      if (typeof out.is_crystal === 'number') out.is_crystal = Boolean(out.is_crystal);
      if (typeof out.is_tag === 'number') out.is_tag = Boolean(out.is_tag);
      if (typeof out.is_meta === 'number') out.is_meta = Boolean(out.is_meta);
      if (typeof out.is_keystone === 'number') out.is_keystone = Boolean(out.is_keystone);
      if (typeof out.is_superseded === 'number') out.is_superseded = Boolean(out.is_superseded);
      if (typeof out.auto === 'number') out.auto = Boolean(out.auto);
      return out;
    });
  }

  private applyServerRows(table: Table, rows: Array<Record<string, unknown>>): void {
    // 直接 INSERT OR REPLACE 写本地表。
    // 字段顺序和 schema 对齐;boolean 转 INTEGER;tags JSONB 转 JSON 字符串。
    if (rows.length === 0) return;
    const insert = this.db.transaction((items: Array<Record<string, unknown>>) => {
      for (const r of items) {
        if (table === 'nodes') {
          this.db.prepare(`
            INSERT OR REPLACE INTO nodes (
              id, type, content, title,
              heat, refinement, connectivity, independence,
              specificity, subjectivity, actuality,
              is_crystal, is_tag, is_meta,
              source_tool, source_session, source_stream, source_timestamp,
              tags, created, last_reconsolidated, version, archived,
              is_keystone, is_superseded, source_device, maturity_score, updated
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            r.id,
            r.type ?? 'fact',
            r.content ?? '',
            r.title ?? null,
            Number(r.heat ?? 1.0),
            Number(r.refinement ?? 0.0),
            Number(r.connectivity ?? 0.0),
            Number(r.independence ?? 0.0),
            Number(r.specificity ?? 0.5),
            Number(r.subjectivity ?? 0.5),
            Number(r.actuality ?? 0.5),
            r.is_crystal ? 1 : 0,
            r.is_tag ? 1 : 0,
            r.is_meta ? 1 : 0,
            r.source_tool ?? null,
            r.source_session ?? null,
            r.source_stream ?? null,
            r.source_timestamp ?? null,
            typeof r.tags === 'string' ? r.tags : JSON.stringify(r.tags ?? []),
            r.created ?? new Date().toISOString(),
            r.last_reconsolidated ?? null,
            Number(r.version ?? 1),
            r.archived ? 1 : 0,
            r.is_keystone ? 1 : 0,
            r.is_superseded ? 1 : 0,
            r.source_device ?? 'cloud',
            Number(r.maturity_score ?? 0.0),
            r.updated ?? r.created ?? new Date().toISOString(),
          );
        } else {
          this.db.prepare(`
            INSERT OR REPLACE INTO links (
              id, from_id, to_id, relation, strength, note, auto, status, created, updated
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(
            r.id,
            r.from_id,
            r.to_id,
            typeof r.relation === 'string' ? r.relation : JSON.stringify(r.relation),
            Number(r.strength ?? 0.5),
            r.note ?? null,
            r.auto ? 1 : 0,
            r.status ?? 'confirmed',
            r.created ?? new Date().toISOString(),
            r.updated ?? r.created ?? new Date().toISOString(),
          );
        }
      }
    });
    insert(rows);
  }

  // ── Metadata + Progress emit ─────────────────────────────

  private setMetadata(key: string, value: string): void {
    try {
      this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
    } catch (err) {
      log.warn(`setMetadata(${key}) failed: ${(err as Error).message}`);
    }
  }

  private emitProgress(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('reconcile-progress', this.getProgress());
      }
    }
  }
}
