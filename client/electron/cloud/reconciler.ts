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

// 修复(2026-05-20 决策 #5):BATCH_SIZE 100 → 25。
// applyChanges 用 db.transaction() 整批跑,100 行 × ~1ms = 100ms+ 主线程阻塞,
// pull 频率高时(WS 推送 + 30s 轮询)累积影响 IPC 响应。降到 25 一批,峰值阻塞
// ~25ms;同步带宽相应降到 1/4,但 reconcile / pull 都是分批循环,总吞吐只看
// 网络往返延迟,本地处理换 4 次小循环不是瓶颈。
const BATCH_SIZE = 25;
const MANIFEST_PAGE_LIMIT = 5000;
/**
 * 单次 reconcile 跑 fetchServerManifest 的最大页数。
 * 5000 × 1000 = 500 万 manifest entry,远超任何真实用户。命中说明服务端有 bug
 * 在 cursor 推进上(参考 audit F-2),立即报错避免主进程内存无限增长。
 */
const MAX_MANIFEST_PAGES = 1000;

// 时间戳工具抽到独立文件(reconciler-utils.ts),以便测试在根目录 vitest
// 环境下导入不会触发本文件顶部的 'electron' import 链(CI runner 干净环境
// 没装 client/ 的 electron 依赖)。re-export 供本文件内部和外部调用者使用。
export { chooseManifestWinner, normalizeTs, planReconcileActions, timestampsEqual, TS_EQUAL_TOLERANCE_MS } from './reconciler-utils.js';
import { planReconcileActions } from './reconciler-utils.js';
import { applyCloudRows } from './local-apply.js';

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
        // 修复(2026-05-20 Audit F-7):失败时也要 emit,否则 renderer 进度条
        // 卡在最后一次 'upload'/'download' 帧不动,只能靠 Notification 通知用户。
        this.emitProgress();
        results.push({ table, uploaded: 0, downloaded: 0, conflicts: 0, skipped: 0, errors: [msg] });
      }
    }

    // 整体状态 + 失败通知
    const anyFailed = results.some(r => r.errors.length > 0);
    const anySucceeded = results.some(r => r.errors.length === 0);
    const status = this.aborted ? 'partial' : (anyFailed ? (anySucceeded ? 'partial' : 'failed') : 'ok');
    this.setMetadata('cloud.last_reconcile_status', status);

    if (anyFailed) {
      this.setMetadata('cloud.last_reconcile_error', results.flatMap(r => r.errors).join('; '));
      this.showFailureNotification(results);
    } else {
      this.setMetadata('cloud.last_reconcile_error', '');
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
    const actionPlan = planReconcileActions(localManifest, serverManifest);

    log.info(`reconcile ${table}: onlyLocal=${actionPlan.onlyLocal.length} onlyServer=${actionPlan.onlyServer.length} conflict=${actionPlan.conflicts.length}`);

    // Step 4: upload(onlyLocal + local-newer-conflict)
    const toUpload = actionPlan.toUpload;
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
    const toDownload = actionPlan.toDownload;
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
      conflicts: actionPlan.conflicts.length,
      skipped: uploadSkipped,
      errors: [],
    };
  }

  // ── Manifest 拉取 ────────────────────────────────────────

  private async fetchServerManifest(table: Table): Promise<ManifestEntry[]> {
    // Audit-3 F7 软上限:防御服务端 has_more 不收口、cursor 一直推进但每次都返回新条目
    // 的故障模式。MAX_MANIFEST_PAGES 已挡极端情况,这里再加一个 entry 总量上限,
    // 比 MAX_MANIFEST_PAGES × MANIFEST_PAGE_LIMIT(500 万)更激进,真实用户数据
    // 量两年都到不了 100 万,命中就是异常。
    const SOFT_LIMIT = 1_000_000;
    const all: ManifestEntry[] = [];
    let cursor = '';
    let pages = 0;
    while (pages < MAX_MANIFEST_PAGES) {
      // Audit-3 F7:循环顶部检查 abort,让用户点"取消"时长 manifest 拉取能及时退出
      // (避免数百页拉完才看到 aborted 检查)
      if (this.aborted) throw new Error('aborted');
      pages++;
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
      // Audit-3 F7 软上限检查 + 伪进度上报(让 UI 在长 manifest 拉取时有反馈)
      if (all.length > SOFT_LIMIT) {
        throw new Error(`manifest too large (${all.length} > ${SOFT_LIMIT}); aborting to prevent OOM`);
      }
      this.progress.processed = pages * MANIFEST_PAGE_LIMIT;
      this.emitProgress();
      if (!data.has_more || !data.next_cursor) break;
      // 修复(2026-05-20 Audit F-2):防御服务端 cursor 退化 bug —
      // 如果新 cursor 等于上次 cursor,说明分页逻辑卡住了,立即报错避免内存无限增长。
      if (data.next_cursor === cursor) {
        throw new Error(`manifest pagination stuck at cursor=${cursor}`);
      }
      cursor = data.next_cursor;
    }
    if (pages >= MAX_MANIFEST_PAGES) {
      throw new Error(`manifest exceeded MAX_MANIFEST_PAGES=${MAX_MANIFEST_PAGES}`);
    }
    return all;
  }

  // ── 本地 manifest ────────────────────────────────────────

  /**
   * Perf-critical:8w+ links / 1w+ nodes 全表扫描必须在主线程上跑(better-sqlite3
   * 是 sync API)。两个不显眼但累积起来 1-2 分钟主线程 hang 的坑:
   *   1. SQL 内的 COALESCE 表达式 + nullable updated/created 让 query planner
   *      可能选择走 idx_nodes_active_updated(archived,is_superseded,updated DESC)
   *      做表达式 eval,触发 vdbeSorter(实测 sample stack trace 直接命中
   *      vdbeSorterSort/vdbeSorterCompareText)。改成 SELECT 原列让 planner 走
   *      纯主键扫描,JS 端再做 null-coalesce(`.map` 本来就在做)。
   *   2. `.all()` 一次性 materialize 9w 行进 V8 array,峰值内存 200MB+ 撑爆
   *      V8 nursery 触发 GC。改 `.iterate()` 单遍流式,峰值线性。
   * 配套修复:sync-client.ts 把 maybeTriggerReconcile 延迟 10s 触发(给 renderer
   * 拉首屏数据一个干净窗口),即便这里的扫表仍是同步的也不会阻塞冷启动首屏。
   */
  private buildLocalManifest(table: Table): ManifestEntry[] {
    const stmt = table === 'nodes'
      ? this.db.prepare(`SELECT id, created, updated, archived FROM nodes`)
      : this.db.prepare(`SELECT id, created, updated FROM links`);

    const entries: ManifestEntry[] = [];
    const iter = stmt.iterate() as IterableIterator<{
      id: string;
      created: string | null;
      updated: string | null;
      archived?: number;
    }>;
    for (const r of iter) {
      entries.push({
        id: r.id,
        sync_version: 0, // 本地没存 sync_version,不参与比较
        updated: r.updated || r.created || new Date(0).toISOString(),
        archived: typeof r.archived === 'number' ? Boolean(r.archived) : false,
      });
    }
    return entries;
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
    applyCloudRows(this.db, table, rows);
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
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
      if (!win.isDestroyed()) {
        win.webContents.send('reconcile-progress', this.getProgress());
      }
    }
  }
}
