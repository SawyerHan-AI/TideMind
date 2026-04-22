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

  /**
   * cloud_not_available 时的慢速探测 timer。周期 1 小时,用于用户被加入
   * 白名单后能自动恢复,无需重启 app。
   */
  private slowRetryTimer: ReturnType<typeof setInterval> | null = null;

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
    // P2-NEW-G: connectWebSocket 是 async，裸调用丢 Promise 会在上游触发
    // unhandledRejection。加 .catch 兜底：记日志，并若未 stop 则进入退避重连。
    this.connectWebSocket().catch(e => {
      log.warn(`initial ws connect failed: ${(e as Error).message}`);
      if (!this.stopped) this.scheduleReconnect();
    });

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
    if (this.slowRetryTimer) {
      clearInterval(this.slowRetryTimer);
      this.slowRetryTimer = null;
    }
    this.disconnectWebSocket();
    log.info('sync client stopped');
  }

  // ── WebSocket ────────────────────────────────────────

  /**
   * v0.2.38 新协议:不再把 token 写进 URL,而是连上后发 {type:'auth', token} 消息。
   * URL 进反向代理 / Cloudflare 的 access log,token 在 URL 里会被落盘。
   * 新协议下 URL 永远干净。服务端双协议并存(仍接受 ?token=),等 v0.2.39 关闭。
   *
   * 状态机:
   *   connecting → open → (send auth) → (recv auth_ok) → ready
   *                              → (recv auth_fail)      → close
   *                              → 3s no ack             → close
   */
  private wsAuthTimer: ReturnType<typeof setTimeout> | null = null;
  private wsAuthed = false;

  private async connectWebSocket(): Promise<void> {
    const token = await refreshTokenIfNeeded();
    if (!token) {
      log.info('no token available, skipping ws connect');
      return;
    }

    // 将 HTTP base URL 转为 WebSocket URL。注意 URL 不再带 token。
    const baseUrl = getCloudBaseUrl();
    const wsUrl = baseUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    const url = `${wsUrl}/ws/sync`;

    this.wsAuthed = false;

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        log.info('ws opened, sending auth handshake');
        // 立即发 auth message;服务端收到后应在 3 秒内回 auth_ok/auth_fail。
        try {
          this.ws?.send(JSON.stringify({ type: 'auth', token }));
        } catch (e) {
          log.warn(`ws send auth failed: ${(e as Error).message}`);
        }
        // 3 秒内没收到 auth_ok 就认为对端不支持新协议或卡死,close 重连。
        // 服务端 handshake timeout 也是 3s,客户端给稍微长一点的容忍(3500ms)
        // 避免两边同时 timeout 抢着 close。
        this.wsAuthTimer = setTimeout(() => {
          if (!this.wsAuthed) {
            log.warn('ws auth ack timeout, closing');
            this.ws?.close(4003, 'Auth ack timeout');
          }
        }, 3_500);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth_ok' || msg.type === 'connected') {
            // auth_ok = 新协议服务端; connected = 老协议服务端(legacy ?token=)。
            // 按当前我们不再传 query token,正常情况下应该看到 auth_ok。
            // 保留 connected 以防 roll-forward 时某些节点用旧服务端代码。
            this.wsAuthed = true;
            if (this.wsAuthTimer) {
              clearTimeout(this.wsAuthTimer);
              this.wsAuthTimer = null;
            }
            log.info(`ws authed (server msg=${msg.type})`);
            this.wsReconnectAttempts = 0; // 重置退避
          } else if (msg.type === 'auth_fail') {
            log.warn(`ws auth_fail: reason=${msg.reason}`);
            this.ws?.close(msg.reason === 'expired' ? 4401 : 1008, 'auth_fail');
          } else if (msg.type === 'changes_available') {
            if (!this.wsAuthed) {
              // 协议违规:未认证就收到通知 → 不信任
              log.warn('ws: received changes_available before auth, ignoring');
              return;
            }
            log.info(`ws: changes_available since_version=${msg.since_version}`);
            // 收到通知，立即拉取
            this.syncOnce().catch(e => log.error('ws-triggered sync error:', (e as Error).message));
          }
        } catch (e) {
          log.warn('ws: failed to parse message', (e as Error).message);
        }
      });

      this.ws.on('close', async (code, reason) => {
        log.info(`ws closed: code=${code} reason=${reason.toString()} authed=${this.wsAuthed}`);
        if (this.wsAuthTimer) {
          clearTimeout(this.wsAuthTimer);
          this.wsAuthTimer = null;
        }
        this.ws = null;
        this.wsAuthed = false;
        if (this.stopped) return;
        // code 4401(服务端自定义)= token 过期,先强制刷新再重连。
        // 不刷新直接重连会立刻再被拒,进入指数退避空转。
        if (code === 4401) {
          try {
            await refreshTokenIfNeeded();
            // 刷新后立即重连,不走指数退避(普通断开才要退避)
            this.wsReconnectAttempts = 0;
          } catch (err) {
            log.warn(`ws close 4401 but refresh failed: ${(err as Error).message}`);
          }
        }
        this.scheduleReconnect();
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
    if (this.wsAuthTimer) {
      clearTimeout(this.wsAuthTimer);
      this.wsAuthTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.wsAuthed = false;
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
        // 非白名单用户:暂停高频轮询,但保留周期性探测 — 否则用户被加入白名单
        // 后不重启 app 永不重连。改成每小时试一次(而不是 stop() 永久死亡)。
        this.startSlowRetry();
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

  /**
   * cloud_not_available 时进入慢重试模式:每 1 小时试一次 syncOnce。
   * 一旦成功就恢复正常轮询。
   */
  private startSlowRetry(): void {
    // 停当前的高频轮询,但不彻底 stop(保留 slow retry timer)
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // 必须走 disconnectWebSocket 而不是裸 ws.close() — close 会触发
    // on('close') → scheduleReconnect() 设 wsReconnectTimer,导致"慢重试"
    // 和"ws 重连"两条线并行跑 cloudNotAvailable 路径下 ws 会每几秒
    // 试一次被服务端持续拒绝,刷日志 + 占资源。
    this.disconnectWebSocket();
    if (this.slowRetryTimer) return; // 已经在慢重试
    const ONE_HOUR = 60 * 60 * 1000;
    this.slowRetryTimer = setInterval(() => {
      if (this.stopped) return;
      log.info('cloud_not_available slow-retry: probing...');
      this.syncOnce().then(() => {
        // 如果这次成功(cloudNotAvailable 被置 false),恢复正常轮询
        if (!this.cloudNotAvailable) {
          if (this.slowRetryTimer) {
            clearInterval(this.slowRetryTimer);
            this.slowRetryTimer = null;
          }
          if (!this.intervalId) {
            this.intervalId = setInterval(
              () => this.syncOnce().catch(e => log.error('resumed sync error:', (e as Error).message)),
              POLL_INTERVAL_MS,
            );
          }
          log.info('cloud_not_available recovered, resumed normal sync');
        }
      }).catch((e) => log.warn(`slow-retry probe failed: ${(e as Error).message}`));
    }, ONE_HOUR);
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
    //
    // v0.2.25 新增 'quota_exhausted':item 保留在 outbox 但**不增加 retry_count**。
    // 避免配额耗尽的合法记忆在 5 次推送后被 dead-letter。用户升级 Pro 后
    // 这些 items 仍可被重新推上去。
    type ItemResult = { index: number; status: 'ok' | 'skipped' | 'failed' | 'quota_exhausted'; error?: string };
    const data = await res.json().catch(() => ({ processed: 0 })) as { processed: number; results?: ItemResult[] };

    let removed = 0;
    let failed = 0;
    let deadLettered = 0;
    let quotaExhausted = 0;

    if (Array.isArray(data.results)) {
      for (const r of data.results) {
        const item = items[r.index];
        if (!item) continue;
        if (r.status === 'ok' || r.status === 'skipped') {
          removeOutboxItem(this.db, item.id);
          removed++;
        } else if (r.status === 'quota_exhausted') {
          // 保留,不算失败,不累计 retry。用户升额度后下次 push 自动重试。
          quotaExhausted++;
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

    log.info(`pushed ${items.length} outbox items: removed=${removed} failed=${failed} deadLettered=${deadLettered} quotaExhausted=${quotaExhausted}`);
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
