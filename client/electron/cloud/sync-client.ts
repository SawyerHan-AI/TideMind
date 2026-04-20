import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import WebSocket from 'ws';
import { createLogger } from '../../../src/utils/logger.js';
import { CacheManager } from './cache-manager.js';
import { getOutboxItems, removeOutboxItem, markOutboxFailed, getOutboxCount as _getOutboxCount } from './outbox.js';
import { getCloudAuth, getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js';

const log = createLogger('cloud-sync');

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

/** 轮询兜底间隔（WebSocket 断开时使用） */
const POLL_INTERVAL_MS = 30_000;

/** WebSocket 重连退避参数 */
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;

export class CloudSyncClient {
  private cacheManager: CacheManager;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = 'idle';

  // WebSocket 相关
  private ws: WebSocket | null = null;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** 用户未在白名单中，云端返回 403 cloud_not_available */
  cloudNotAvailable = false;
  /** 服务端同步接口尚未就绪（404） */
  syncNotReady = false;
  /**
   * 上一次 syncOnce 的原始错误 message。成功时清空,失败时保留。
   * UI 通过 cloud.status IPC 读取这个字段,配合错误码展示更具体的原因
   * (如 `HTTP 500`、`fetch failed` 等),方便用户定位真实故障点。
   */
  lastErrorMessage: string | null = null;

  constructor(private db: Database.Database) {
    const baseUrl = getCloudBaseUrl();
    this.cacheManager = new CacheManager(db, baseUrl);
  }

  getStatus(): SyncStatus { return this.status; }
  isCloudNotAvailable(): boolean { return this.cloudNotAvailable; }

  async start(): Promise<void> {
    log.info('starting sync client');
    this.stopped = false;

    // 注册/刷新设备(fire-and-forget)。历史遗留 bug:之前从未调用,devices 表永远空。
    // 服务端已改为幂等(按 user_id + name 去重),重复调用安全。
    import('./device.js')
      .then(m => m.registerDevice())
      .catch(e => log.warn('device register failed:', (e as Error).message));

    // 首次同步 / 距上次 > 7 天 → 触发 reconcile(fire-and-forget,不阻塞增量同步)
    this.maybeTriggerReconcile().catch(e => log.warn('reconcile trigger failed:', (e as Error).message));

    await this.syncOnce();

    // 启动 WebSocket 实时通知
    this.connectWebSocket();

    // 保留轮询作为兜底（WebSocket 断开时仍能同步）
    this.intervalId = setInterval(
      () => this.syncOnce().catch(e => log.error('sync error:', (e as Error).message)),
      POLL_INTERVAL_MS,
    );
  }

  /**
   * 判断是否需要跑 reconcile。条件(任一成立触发):
   *   - nodes 或 links 的 last_reconcile_at_{table} 为空
   *   - 其中任一距上次 > 7 天
   * 只检查 nodes 是个老 bug — 如果 nodes 跑完但 links 失败,下次不会重试 links,
   * 用户数据永远对不齐。
   */
  private async maybeTriggerReconcile(): Promise<void> {
    const lastNodes = this.readMetadata('cloud.last_reconcile_at_nodes');
    const lastLinks = this.readMetadata('cloud.last_reconcile_at_links');

    const stale = (ts: string | null): boolean => {
      if (!ts) return true;
      const t = new Date(ts).getTime();
      if (isNaN(t)) return true;
      return Date.now() - t > 7 * 24 * 60 * 60 * 1000;
    };

    if (!stale(lastNodes) && !stale(lastLinks)) return; // 两张表都新,跳过

    const isInitial = !lastNodes && !lastLinks; // 只有"两个都从未跑过"才算首次

    log.info(`triggering reconcile (isInitial=${isInitial}, nodes_stale=${stale(lastNodes)}, links_stale=${stale(lastLinks)})`);
    const { Reconciler } = await import('./reconciler.js');
    const reconciler = new Reconciler(this.db);
    const results = await reconciler.runAll(isInitial);
    for (const r of results) {
      log.info(`reconcile ${r.table}: uploaded=${r.uploaded} downloaded=${r.downloaded} conflicts=${r.conflicts} errors=${r.errors.length}`);
    }
  }

  private readMetadata(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.disconnectWebSocket();
    log.info('sync client stopped');
  }

  // ── WebSocket ────────────────────────────────────────

  private async connectWebSocket(): Promise<void> {
    const token = await refreshTokenIfNeeded();
    if (!token) {
      log.info('no token available, skipping ws connect');
      return;
    }

    // 将 HTTP base URL 转为 WebSocket URL
    const baseUrl = getCloudBaseUrl();
    const wsUrl = baseUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    const url = `${wsUrl}/ws/sync?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        log.info('ws connected');
        this.wsReconnectAttempts = 0; // 重置退避
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'changes_available') {
            log.info(`ws: changes_available since_version=${msg.since_version}`);
            // 收到通知，立即拉取
            this.syncOnce().catch(e => log.error('ws-triggered sync error:', (e as Error).message));
          }
        } catch (e) {
          log.warn('ws: failed to parse message', (e as Error).message);
        }
      });

      this.ws.on('close', (code, reason) => {
        log.info(`ws closed: code=${code} reason=${reason.toString()}`);
        this.ws = null;
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        log.warn(`ws error: ${err.message}`);
        // error 事件后会触发 close，由 close 处理重连
      });
    } catch (e) {
      log.warn(`ws connect failed: ${(e as Error).message}`);
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.wsReconnectTimer) return;

    const delay = Math.min(
      WS_RECONNECT_BASE_MS * Math.pow(2, this.wsReconnectAttempts),
      WS_RECONNECT_MAX_MS,
    );
    this.wsReconnectAttempts++;
    log.info(`ws reconnect in ${delay}ms (attempt ${this.wsReconnectAttempts})`);

    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  private disconnectWebSocket(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async syncOnce(): Promise<void> {
    const token = await refreshTokenIfNeeded();
    if (!token) { this.status = 'offline'; return; }

    this.status = 'syncing';
    try {
      await this.pushOutbox(token);
      await this.pullChanges(token);
      this.status = 'idle';
      // 同步成功 → 重置错误标志（可能是之前的瞬时故障）
      this.syncNotReady = false;
      this.cloudNotAvailable = false;
      this.lastErrorMessage = null;

      // Update lastSyncedAt on auth
      const auth = getCloudAuth();
      if (auth) auth.lastSyncedAt = new Date().toISOString();

      this.emitDataChanged();
    } catch (e) {
      const msg = (e as Error).message;
      this.lastErrorMessage = msg;
      if (msg === 'cloud_not_available') {
        this.cloudNotAvailable = true;
        this.status = 'offline';
        // 非白名单用户：停止轮询和 WebSocket，避免持续 403
        this.stop();
      } else if (msg.includes('404')) {
        this.syncNotReady = true;
        this.status = 'error';
      } else {
        this.status = 'error';
      }
      log.error('sync failed:', msg);
      // 失败路径也需要通知 UI,否则 renderer 只能看到 syncClient 被创建时的 'idle' 初始值,
      // 误以为 sync 已成功开启(尤其是 start() fire-and-forget 之后)
      this.emitDataChanged();
    }
  }

  async pullChanges(token: string): Promise<number> {
    const sinceVersion = this.cacheManager.getLastSyncedVersion();
    const base = getCloudBaseUrl();
    const res = await fetch(`${base}/api/v1/sync/pull?since_version=${sinceVersion}&limit=100`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        if (body.error === 'cloud_not_available') {
          throw new Error('cloud_not_available');
        }
      }
      throw new Error(`Pull failed: ${res.status}`);
    }
    const data = await res.json();
    if (data.changes.length > 0) {
      await this.cacheManager.applyChanges(data.changes, token);
      log.info(`pulled ${data.changes.length} changes`);
    }
    return data.changes.length;
  }

  async pushOutbox(token: string): Promise<number> {
    const items = getOutboxItems(this.db, 50);
    if (items.length === 0) return 0;

    const base = getCloudBaseUrl();
    const res = await fetch(`${base}/api/v1/sync/outbox`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.map(i => ({ operation: i.operation, payload: JSON.parse(i.payload) })) }),
    });
    if (!res.ok) throw new Error(`Outbox push failed: ${res.status}`);

    // 解析服务端 per-item 结果。旧版服务端只返 { processed },新版还返 results。
    // 没有 results 字段时回退为"全部删除"(旧行为) —— 服务端升级后自动启用精确删除。
    type ItemResult = { index: number; status: 'ok' | 'skipped' | 'failed'; error?: string };
    const data = await res.json().catch(() => ({ processed: 0 })) as { processed: number; results?: ItemResult[] };

    let removed = 0;
    let failed = 0;
    let deadLettered = 0;

    if (Array.isArray(data.results)) {
      for (const r of data.results) {
        const item = items[r.index];
        if (!item) continue;
        if (r.status === 'ok' || r.status === 'skipped') {
          removeOutboxItem(this.db, item.id);
          removed++;
        } else {
          const { deadLettered: dl } = markOutboxFailed(this.db, item.id, r.error ?? 'server failed');
          if (dl) deadLettered++;
          else failed++;
        }
      }
    } else {
      // 老服务端:假设全部成功,保持原行为
      for (const item of items) {
        removeOutboxItem(this.db, item.id);
        removed++;
      }
    }

    log.info(`pushed ${items.length} outbox items: removed=${removed} failed=${failed} deadLettered=${deadLettered}`);
    return removed;
  }

  private emitDataChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('data-changed', { scopes: ['cloud', 'nodes', 'links'] });
      }
    }
  }
}

// Singleton
let instance: CloudSyncClient | null = null;

export function getCloudSyncClient(): CloudSyncClient | null { return instance; }

export function isSyncClientRunning(): boolean {
  return instance !== null && instance.getStatus() !== 'offline';
}

export function createCloudSyncClient(db: Database.Database): CloudSyncClient {
  if (instance) instance.stop();
  instance = new CloudSyncClient(db);
  return instance;
}

export function destroySyncClient(): void {
  if (instance) {
    instance.stop();
    instance = null;
    log.info('sync client destroyed');
  }
}

/**
 * Trigger a manual sync cycle. Called by IPC handler cloud:trigger-sync.
 *
 * 重要：syncOnce 内部用 try/catch 自己吞掉了错误(只写状态字段,不向外抛),
 * 所以这里 await 之后必须读 instance 的状态字段来判断成败,不能依赖
 * try/catch 接到异常——这正是 v0.2.6 之前"点立即同步毫无反应"的
 * 根因:triggerSync silent-success 了。
 */
export async function triggerSync(): Promise<{ success: boolean; error?: string; errorDetail?: string }> {
  if (!instance) return { success: false, error: 'not_initialized' };
  await instance.syncOnce();

  if (instance.cloudNotAvailable) {
    return { success: false, error: 'cloud_not_available', errorDetail: instance.lastErrorMessage ?? undefined };
  }
  if (instance.syncNotReady) {
    return { success: false, error: 'sync_not_ready', errorDetail: instance.lastErrorMessage ?? undefined };
  }
  const status = instance.getStatus();
  if (status === 'offline') {
    return { success: false, error: 'offline', errorDetail: instance.lastErrorMessage ?? undefined };
  }
  if (status === 'error') {
    return { success: false, error: 'sync_error', errorDetail: instance.lastErrorMessage ?? undefined };
  }
  return { success: true };
}

/**
 * Get the number of pending outbox items. Called by IPC handler cloud:outbox-count.
 * Returns 0 if no DB is available.
 */
export function getOutboxCount(): number {
  if (!instance) return 0;
  try {
    return _getOutboxCount((instance as any).db);
  } catch {
    return 0;
  }
}
