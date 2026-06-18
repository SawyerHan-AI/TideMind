import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import WebSocket from 'ws';
import { createLogger } from '../../../src/utils/logger.js';
import { CacheManager } from './cache-manager.js';
import { getOutboxItems, removeOutboxItem, markOutboxFailed, deadLetterOutboxItem, getOutboxCount as _getOutboxCount } from './outbox.js';
import { getCloudAuth, getCloudBaseUrl, refreshTokenIfNeeded, updateCloudAuth } from './auth-client.js';
import { getActivityState } from '../activity-state.js';
import { pumpReembedMissing } from './reembed-pump.js';
import { pumpUplink } from './uplink.js';
import { withApplyGuard } from './local-apply.js';
import { recomputeToGeneration } from '../../../src/metabolism/generation-decay.js';

const log = createLogger('cloud-sync');

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

/**
 * 轮询兜底间隔(WebSocket 断开时使用)。
 * 注意:activity-state idle 时该 setInterval 会被 stop(start/stopPolling),
 * idle → active 切换时延迟 ACTIVE_RESUME_DELAY_MS 重启,避免回前台瞬间撞 SQL。
 */
const POLL_INTERVAL_MS = 30_000;

/** 实时上行 pump 间隔(M6):脏集空时 pump 快速返回,开销小。本地写后最多此间隔即上行。 */
const UPLINK_INTERVAL_MS = 3_000;

/** WebSocket 重连退避参数 */
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;

/**
 * sync HTTP fetch 超时。undici 默认 headersTimeout ~300s,established-but-silent
 * 连接(VPN 半断 / sleep-wake 后 NAT 失效 / 防火墙 DROP)会让单个请求挂 5 分钟,
 * 经 syncInFlight 复用塌缩后 trigger-sync / set-sync-enabled IPC 一起卡死。
 * pull/push 是小请求,15s 足够;命中超时归为 transient(下一轮轮询重试)。
 */
const SYNC_FETCH_TIMEOUT_MS = 15_000;

/**
 * start() 首次 syncOnce 瞬态失败后的重试延迟。首次 syncOnce 在 try 之外 throw
 * (refreshTokenIfNeeded 对网络错误/5xx 是 throw),若放任 reject 整条 start()
 * 中止,本会话云同步永久死亡。改为捕获 + 调度一次延迟重试,并照常建 WS/轮询/activity。
 */
const FIRST_SYNC_RETRY_MS = 30_000;

/**
 * 启动 → 首次 reconcile 触发的延迟。
 * reconcile.buildLocalManifest 即便优化后仍是 SQL 全表扫(better-sqlite3 sync API),
 * 8w+ 链接表秒级扫描会和首屏 IPC 抢主线程,给 renderer 一个干净的拉数窗口。
 * reconcile 本身是兜底对齐(>7 天才会跑),delay 10s 不影响正确性。
 */
const RECONCILE_TRIGGER_DELAY_MS = 10_000;

/**
 * idle → active 时,等多久再 fire 第一次 syncOnce。
 * renderer 端 visibilitychange handler(OnboardingContext.checkAll 等)会在
 * 窗口可见时立刻打 3 个 IPC,2s 让它们先跑完,sync 再上来,避免 better-sqlite3
 * 同步 API 串行排队让鼠标转圈(2026-05-21 排查)。
 */
const ACTIVE_RESUME_DELAY_MS = 2_000;

export class CloudSyncClient {
  private cacheManager: CacheManager;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private uplinkTimer: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = 'idle';

  // WebSocket 相关
  private ws: WebSocket | null = null;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /**
   * connectWebSocket in-flight 互斥(镜像 syncInFlight 模式)。connectWebSocket 里
   * `await refreshTokenIfNeeded()` 是个挂起点:close-old-socket 守卫跑在 await 之前,
   * 两条线(start / slowRetry / on('close')→scheduleReconnect)在 token 过期需真刷新时
   * 可能同时越过守卫、各自 `this.ws = new WebSocket(url)`,旧 socket 既不 close 也不
   * 解绑 listener,泄漏 + 占用 per-token 连接配额(MAX_CONNECTIONS_PER_TOKEN=3 → 4002)。
   */
  private wsConnecting = false;

  /** 启动后延迟触发 reconcile 的 timer。stop() 必须清，避免 stop 后 callback 触底跑 reconcile。 */
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * cloud_not_available 时的慢速探测 timer。周期 1 小时,用于用户被加入
   * 白名单后能自动恢复,无需重启 app。
   */
  private slowRetryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * syncOnce in-flight mutex。三条线都会调 syncOnce:30s 轮询 / WebSocket
   * changes_available 通知 / activity-state 'became-active' 错峰恢复。idle 几
   * 小时后回到前台它们会同时触发,并发 pushOutbox + pullChanges 在主线程上串
   * 行排队,鼠标转圈(2026-05-21)。in-flight 时返回同一个 promise,新调用复用。
   */
  private syncInFlight: Promise<void> | null = null;

  /** activity-state 订阅句柄。stop() 时必须解绑。 */
  private unsubscribeActivity: (() => void) | null = null;

  /** idle → active 错峰恢复的 timer。stop() 时必须清。 */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  /** start() 首次 syncOnce 失败后的延迟重试 timer。stop() 时必须清。 */
  private firstSyncRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
  /** Audit-3 F14:public getter,避免 getOutboxCount 用 `as any` 强转。 */
  getDb(): Database.Database { return this.db; }

  async start(): Promise<void> {
    log.info('starting sync client');
    this.stopped = false;

    // 注册/刷新设备(fire-and-forget)。历史遗留 bug:之前从未调用,devices 表永远空。
    // 服务端已改为幂等(按 user_id + name 去重),重复调用安全。
    import('./device.js')
      .then(m => m.registerDevice())
      .catch(e => log.warn('device register failed:', (e as Error).message));

    // 首次同步 / 距上次 > 7 天 → 触发 reconcile。
    // 即使 buildLocalManifest 已优化(2026-05-20 PERF fix),其 SQL 仍是 better-sqlite3
    // 同步 API,8w+ 行表扫秒级仍可能拖慢首屏 IPC 响应。给 10s 启动窗口让 renderer
    // 拉到首屏数据后再跑 reconcile;reconcile 是兜底对齐机制,延迟 10s 完全可接受。
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (this.stopped) return;
      this.maybeTriggerReconcile().catch(e => log.warn('reconcile trigger failed:', (e as Error).message));
    }, RECONCILE_TRIGGER_DELAY_MS);

    // 首次 syncOnce 的 refreshTokenIfNeeded 在 _doSyncOnce 的 try 之外:网络错误 /
    // 5xx 是 throw 而非返回 null(auth-client),典型场景是断网/captive portal 下开机
    // 自启动且 access token 已过期(TTL 1h,隔夜唤醒必过期)。若任 reject 穿透 start(),
    // 后面的 WS / 轮询 / activity 订阅全部建不起来,本会话云同步永久死亡,直到用户
    // 重启或关开 toggle。这里捕获后:照常建 WS/轮询/activity(它们各自有重试),并
    // 调度一次延迟重试首次 syncOnce,网络恢复后自动收敛。
    try {
      await this.syncOnce();
    } catch (e) {
      log.warn(`initial syncOnce failed (will retry, ws/polling still established): ${(e as Error).message}`);
      this.scheduleFirstSyncRetry();
    }

    // 启动 WebSocket 实时通知
    // P2-NEW-G: connectWebSocket 是 async，裸调用丢 Promise 会在上游触发
    // unhandledRejection。加 .catch 兜底：记日志，并若未 stop 则进入退避重连。
    this.connectWebSocket().catch(e => {
      log.warn(`initial ws connect failed: ${(e as Error).message}`);
      if (!this.stopped) this.scheduleReconnect();
    });

    // 保留轮询作为兜底（WebSocket 断开时仍能同步）。idle 状态下先不起,
    // activity-state 切到 active 时再起;避免 idle 期间被 Chromium throttle 后,
    // 切回前台时 timer queue 一次性 fire 多个 syncOnce()。
    const activity = getActivityState();
    if (activity.getState() === 'active') {
      this.startPolling();
    }

    // 订阅活动状态。idle → 停 30s 轮询、清 resume timer; active → 错峰恢复:
    // 等 ACTIVE_RESUME_DELAY_MS 让 renderer 把 visibilitychange handler(3 个 IPC)
    // 先跑完,再 syncOnce + restart 轮询,IPC 通道不被 SQL 卡。
    this.unsubscribeActivity = activity.onChange((state) => {
      if (state === 'idle') {
        this.stopPolling();
        this.clearResumeTimer();
      } else {
        this.clearResumeTimer();
        this.resumeTimer = setTimeout(() => {
          this.resumeTimer = null;
          if (this.stopped) return;
          this.syncOnce().catch(e => log.error('resume sync error:', (e as Error).message));
          this.startPolling();
        }, ACTIVE_RESUME_DELAY_MS);
      }
    });
  }

  /**
   * 首次 syncOnce 瞬态失败后,延迟重试一次。重试本身仍可能失败(再 throw),
   * 但 _doSyncOnce 健康路径已被它内部 try/catch 兜住——这里只兜首次那次
   * refreshTokenIfNeeded 在 try 之外的 throw。重试成功即正常,失败再排一次。
   */
  private scheduleFirstSyncRetry(): void {
    if (this.stopped || this.firstSyncRetryTimer) return;
    this.firstSyncRetryTimer = setTimeout(() => {
      this.firstSyncRetryTimer = null;
      if (this.stopped) return;
      this.syncOnce().catch(e => {
        log.warn(`first-sync retry failed: ${(e as Error).message}`);
        this.scheduleFirstSyncRetry();
      });
    }, FIRST_SYNC_RETRY_MS);
  }

  private startPolling(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(
      () => this.syncOnce().catch(e => log.error('sync error:', (e as Error).message)),
      POLL_INTERVAL_MS,
    );
    // M6 实时上行:短 interval pump 本地脏集(空时快速返回)。跟随 polling 生命周期 + activity-state,
    // idle 时随 stopPolling 一起停,避免后台空转。
    this.uplinkTimer = setInterval(
      () => { void pumpUplink(this.db); },
      UPLINK_INTERVAL_MS,
    );
  }

  private stopPolling(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.uplinkTimer) {
      clearInterval(this.uplinkTimer);
      this.uplinkTimer = null;
    }
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
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
    // 走全局互斥:与手动 force-reconcile 共享同一把锁,避免两个 reconciler 并发
    // 交错写同一组 metadata / 同一进度 channel;abort 也能命中本自动实例。
    const { runExclusive } = await import('./reconcile-lock.js');
    const { Reconciler } = await import('./reconciler.js');
    const outcome = await runExclusive(async (register) => {
      const reconciler = new Reconciler(this.db);
      register(reconciler);
      return reconciler.runAll(isInitial);
    });
    if (!outcome.ok) {
      log.info('auto reconcile skipped: another reconcile already running');
      return;
    }
    for (const r of outcome.value) {
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
    this.stopPolling();
    if (this.slowRetryTimer) {
      clearInterval(this.slowRetryTimer);
      this.slowRetryTimer = null;
    }
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.firstSyncRetryTimer) {
      clearTimeout(this.firstSyncRetryTimer);
      this.firstSyncRetryTimer = null;
    }
    this.clearResumeTimer();
    if (this.unsubscribeActivity) {
      this.unsubscribeActivity();
      this.unsubscribeActivity = null;
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
    // 互斥:并发调用(start / slowRetry / 手动 trigger)可能同时进入,会让 this.ws
    // 被覆盖,旧 socket 既不 close 也不解绑 listener,泄漏 + 占用 per-token 连接配额
    // (MAX_CONNECTIONS_PER_TOKEN=3),导致用户在快速重试场景下被服务端拒绝(4002)。
    // wsConnecting 守卫确保只有一条线能跨过下面 `await refreshTokenIfNeeded()` 的挂起点
    // 进入 new WebSocket;第二个并发进入直接早退,不会覆盖 this.ws。
    if (this.wsConnecting) {
      log.debug('ws connect already in flight, skipping concurrent entry');
      return;
    }
    this.wsConnecting = true;
    try {
      // 先彻底解绑/关闭旧连接,再开新的。
      // 竞态修复:旧实现只处理 OPEN/CONNECTING、且不清 wsAuthTimer——CLOSING 态的
      // 旧 socket 保留全部 listener,其迟到的 close 事件会执行 `this.ws = null` +
      // scheduleReconnect,把刚建好的新 socket 引用清掉、触发多余重连,产生孤儿
      // socket(占用 MAX_CONNECTIONS_PER_TOKEN=3 配额 → 4002)。统一处理:无论旧
      // socket 处于何种 readyState,一律先 removeAllListeners(切断它对 this 的影响)、
      // 再 close、清 this.ws,并清掉它可能 armed 的 wsAuthTimer。
      if (this.ws) {
        log.debug('ws present before reconnect, detaching old socket');
        const old = this.ws;
        old.removeAllListeners();
        try { old.close(1000, 'reconnect'); } catch { /* ignore */ }
        this.ws = null;
      }
      if (this.wsAuthTimer) {
        clearTimeout(this.wsAuthTimer);
        this.wsAuthTimer = null;
      }

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
        // 捕获本次创建的 socket 实例引用。所有 handler 开头都比对
        // `if (this.ws !== socket) return`:慢网络下旧 socket 的迟到事件
        // (open/message/close)不再误操作刚建好的新 socket(误清引用、误杀连接、
        // 误触发重连),消除"timer/listener 不校验事件源"的整类竞态。
        const socket = new WebSocket(url);
        this.ws = socket;

        socket.on('open', () => {
          if (this.ws !== socket) return; // 旧 socket 的迟到 open,忽略
          log.info('ws opened, sending auth handshake');
          // 立即发 auth message;服务端收到后应在 3 秒内回 auth_ok/auth_fail。
          try {
            socket.send(JSON.stringify({ type: 'auth', token }));
          } catch (e) {
            log.warn(`ws send auth failed: ${(e as Error).message}`);
          }
          // 3 秒内没收到 auth_ok 就认为对端不支持新协议或卡死,close 重连。
          // 服务端 handshake timeout 也是 3s,客户端给稍微长一点的容忍(3500ms)
          // 避免两边同时 timeout 抢着 close。timer 闭包再次比对 socket 身份,
          // 避免旧 socket armed 的 timer 在新 socket 尚未 auth 的窗口里 close 掉新连接。
          this.wsAuthTimer = setTimeout(() => {
            if (this.ws === socket && !this.wsAuthed) {
              log.warn('ws auth ack timeout, closing');
              socket.close(4003, 'Auth ack timeout');
            }
          }, 3_500);
        });

        socket.on('message', (data) => {
          if (this.ws !== socket) return; // 旧 socket 的迟到 message,忽略
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
              // rate_limited(同 token 连接超限 MAX_CONNECTIONS_PER_TOKEN)不是凭据问题,
              // 用 1013(try again later)区分,close handler 走退避而不清零 attempts,
              // 避免"刷新成功 → attempts=0 → 1s 后重连 → 又被拒"的每秒互打循环。
              const closeCode = msg.reason === 'expired' ? 4401 : msg.reason === 'rate_limited' ? 1013 : 1008;
              socket.close(closeCode, 'auth_fail');
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

        socket.on('close', async (code, reason) => {
          if (this.ws !== socket) return; // 旧 socket 的迟到 close,不动新连接
          log.info(`ws closed: code=${code} reason=${reason.toString()} authed=${this.wsAuthed}`);
          if (this.wsAuthTimer) {
            clearTimeout(this.wsAuthTimer);
            this.wsAuthTimer = null;
          }
          this.ws = null;
          this.wsAuthed = false;
          if (this.stopped) return;
          // 修复(2026-05-20 Audit F-6):任何 auth-related close 都尝试 refresh 一次。
          // - code 4401(服务端自定义)= token 过期,显式刷新后立即重连。
          // - code 1008 + auth_fail(reason !== 'expired') = 服务端 key rotation 或
          //   签名校验失败,刷新拿新签名 token 一次。如果刷新也失败,fall through
          //   到普通 scheduleReconnect 的指数退避(不会立刻死亡)。
          //   原实现只挡 4401,服务端 key rotation 期间所有 ws 客户端会进入
          //   无限退避空转直到 app 重启。
          // - code 1013(rate_limited)**不**清零 attempts:服务端会持续拒绝,
          //   必须走指数退避(直到旧连接自然释放配额),否则每秒互打。
          if (code === 4401 || code === 1008) {
            try {
              await refreshTokenIfNeeded();
              this.wsReconnectAttempts = 0; // 刷新成功 → 立即重连不走退避
            } catch (err) {
              log.warn(`ws close ${code} but refresh failed: ${(err as Error).message}`);
            }
          }
          this.scheduleReconnect();
        });

        socket.on('error', (err) => {
          if (this.ws !== socket) return;
          log.warn(`ws error: ${err.message}`);
          // error 事件后会触发 close，由 close 处理重连
        });
      } catch (e) {
        log.warn(`ws connect failed: ${(e as Error).message}`);
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      }
    } finally {
      // 同步部分跑完(socket 已建立 + listener 绑好,或早退/抛错),释放守卫。
      // socket 后续生命周期由异步 event handler 驱动,不需要继续占着 wsConnecting。
      this.wsConnecting = false;
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
      // 裸调 connectWebSocket() 会丢 Promise:connectWebSocket 内 `await
      // refreshTokenIfNeeded()`(L342)在内层 try/catch 之前,瞬态失败(笔记本唤醒后
      // Wi-Fi 未恢复且 token 已过期)会穿透 reject → 主进程 unhandledRejection,且重连
      // 链彻底死亡(只剩 30s 轮询,idle 时连轮询也停)。.catch 续上退避链,与 start()
      // 路径(L139)一致。
      this.connectWebSocket().catch(e => {
        log.warn(`ws reconnect attempt failed: ${(e as Error).message}`);
        if (!this.stopped) this.scheduleReconnect();
      });
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
      // F2 修复:必须先 removeAllListeners 再 close。
      // close 会触发 'close' 事件 → 默认 close handler 调 scheduleReconnect,
      // 让"我们主动断"被当成"非预期断"重连。startSlowRetry 路径下这会导致慢重试
      // 和 ws 重连并行,持续拒绝刷日志(同上方 startSlowRetry 注释中描述的 M29 场景)。
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.wsAuthed = false;
  }

  /**
   * Sync 入口。in-flight 时直接复用同一个 Promise(不排队、不新发):
   * 三条触发线(30s 轮询 / WS changes_available / activity-state resume)在 idle 几小时
   * 后回前台会同时触发,并发 pushOutbox + pullChanges 在主线程上串行 SQL 排队会让
   * 主线程卡几十秒(2026-05-21 排查)。复用 in-flight 让"瞬间多触发"塌成一次。
   *
   * 实现注意:**这里必须是非 async 函数**。async 包装会让 `return this.syncInFlight`
   * 返回一个新的 Promise(包了原 Promise 一层),caller 拿到的引用不同;mutex 语义上
   * 还是正确的(都 await 同一个底层),但引用比较失败,而且每个 caller 都多一个 microtask
   * tick。直接 return 原 Promise 引用更省、更可断言。
   */
  syncOnce(): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    // F16 (audit-7) 防御式写法:先拿到 chained promise → 立刻赋给 syncInFlight,
    // 再 return。原写法 `const p = ...finally(); this.syncInFlight = p` 看似等价
    // (顺序在同步段内),但读起来"finally 闭包能不能拿到刚赋好的 syncInFlight"
    // 取决于读者脑补 microtask 顺序。这里改成"先创建 chained promise,赋给 field,
    // 同一个 chained promise 返回",finally 闭包通过引用 promise 自己比对 (而不是
    // 闭包外的 p) 让代码读起来意图更明确。
    const promise: Promise<void> = this._doSyncOnce().finally(() => {
      if (this.syncInFlight === promise) this.syncInFlight = null;
    });
    this.syncInFlight = promise;
    return promise;
  }

  private async _doSyncOnce(): Promise<void> {
    // stop check 三处:入口 / token refresh 后 / pushOutbox 之后。
    // before-quit 流程是同步的,但 in-flight await 的 promise 还在 event loop
    // 队列里;进程退出前会 drain 一次,如果不挡 stopped 就会继续往 closeClientDb
    // 之后的 db 写,日志爆"database is closed"。
    if (this.stopped) return;
    const token = await refreshTokenIfNeeded();
    if (this.stopped) return;
    if (!token) { this.status = 'offline'; return; }

    this.status = 'syncing';
    try {
      // M9:outbox 上行死链已断 —— enqueueOutbox 自 M0 删 mcp-router 后无任何调用,
      // local_outbox 永空、pushOutbox 永远空跑。实时上行走 M6 uplink(脏集)。
      // outbox.ts/pushOutbox/server /outbox 物理删除 + UI 切 cloud_dirty 见 backlog。
      // M6:pull 前先把本地脏集实时上行,确保 pull 拿到的是上行后状态(也兜底 uplinkTimer)。
      const uplinked = await pumpUplink(this.db);
      if (this.stopped) return;
      const pulled = await this.pullChanges(token);
      if (this.stopped) return;
      // M8.5:pull 后拉云端 generation 锚点,本地 lazy 重算 A 类代谢(heat/maturity)到 G。
      await this.recomputeMetabolismGeneration(token);
      if (this.stopped) return;
      this.status = 'idle';
      // 同步成功 → 重置错误标志（可能是之前的瞬时故障）
      this.syncNotReady = false;
      this.cloudNotAvailable = false;
      this.lastErrorMessage = null;

      // Audit-3 F8 修复:不再直接修改 getCloudAuth() 返回的对象(现在是 clone,改了也不持久化)。
      // 走 updateCloudAuth → 内部走 saveAuthToDisk,保证内存与 keychain 一致。
      updateCloudAuth({ lastSyncedAt: new Date().toISOString() });

      // 只在真有 uplink/pull 变更时才追加 'nodes'/'links' scope。0 变更的 30s 轮询
      // (active 云用户每 30s 必发)只刷 'cloud' 状态条,不触发 renderer 全量重拉
      // (nodes:list / nodes:graph)——后者在 8w+ links 库上是周期性主线程 SQL 压力 +
      // 图谱力导向每 30s 抖动一次的来源。
      this.emitDataChanged(uplinked > 0 || pulled > 0);

      // M4(解 #2 召回缺口):pull 下来的跨设备节点向量不同步,fire-and-forget 补 embed。
      // pump 扫全部"active 有 content 缺向量"节点,失败已在内部 swallow(无凭证/熔断时静默)。
      void pumpReembedMissing(this.db);
    } catch (e) {
      const msg = (e as Error).message;
      this.lastErrorMessage = msg;
      // Audit-3 F13 修复:catch 入口先清 syncNotReady。之前只在 404 分支 set true,
      // 不在其他分支 set false → 一旦命中 404,后续即便服务端恢复 + 网络抖了一下进了
      // else 分支,syncNotReady 仍为 true,UI 永远显示"服务未就绪"直到 app 重启或下次成功。
      this.syncNotReady = false;
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
      // 失败路径也需要通知 UI(状态条),否则 renderer 只能看到 syncClient 被创建时的
      // 'idle' 初始值,误以为 sync 已成功开启(尤其是 start() fire-and-forget 之后)。
      // 但失败时没有数据变更,只刷 'cloud' scope,不触发全量重拉。
      this.emitDataChanged(false);
    }
  }

  /**
   * cloud_not_available 时进入慢重试模式:每 1 小时试一次 syncOnce。
   * 一旦成功就恢复正常轮询。
   */
  private startSlowRetry(): void {
    // 停当前的高频轮询,但不彻底 stop(保留 slow retry timer)
    this.stopPolling();
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
          // 仅在 active 时恢复轮询;idle 时由 activity-state 'became-active' 路径接管。
          if (getActivityState().getState() === 'active') {
            this.startPolling();
          }
          // 修复 M29(2026-05-09):startSlowRetry 进入时调用了 disconnectWebSocket,
          // 历史上恢复后**不重连 ws**,UI 显示 offline 长达 1 小时(到下次 slow
          // retry 前)。这里探测成功后立刻重连 ws,与 syncOnce 的健康路径一致。
          // 失败时续上退避重连链(不能只记日志):否则恢复瞬间 token 又抖一下就让 ws
          // 永久死亡,只剩轮询。
          this.connectWebSocket().catch(e => {
            log.warn(`ws reconnect after slow-retry recovery failed: ${(e as Error).message}`);
            if (!this.stopped) this.scheduleReconnect();
          });
          log.info('cloud_not_available recovered, resumed normal sync + ws');
        }
      }).catch((e) => log.warn(`slow-retry probe failed: ${(e as Error).message}`));
    }, ONE_HOUR);
  }

  async pullChanges(token: string): Promise<number> {
    // 修复 (2026-05-19): 必须 loop 直到 has_more=false。
    // 原实现单次 fetch limit=100 后直接 return 丢弃 has_more,服务端一次截 100 条剩余
    // 永远拉不回 — cacheManager 推进 cursor 后，下次只从最大版本号开始拉,中间
    // skipped 的 sync_version 永久丢失。代谢/dedup/link-discover 一晚上几百条很常见。
    //
    // 安全上限 MAX_PAGES 防止云端 bug 导致 has_more 永真死循环。
    // 修复(2026-05-20 决策 #5):limit 100 → 25 + MAX_PAGES 50 → 200 保持单次 sync 上限。
    // applyChanges 用 db.transaction() 整批跑,100 行 × 1ms = 100ms+ 主线程阻塞,
    // 降到 25 让单批阻塞 ≤ 25ms,IPC 响应顺畅;往返次数 ×4 但单次 sync 总数不变。
    const base = getCloudBaseUrl();
    const PULL_LIMIT = 25;
    const MAX_PAGES = 200; // 25 × 200 = 5000 条,跟旧 100 × 50 一致。
    let totalPulled = 0;
    let pages = 0;
    while (pages < MAX_PAGES) {
      if (this.stopped) break; // stop 后立即断开多页拉取,避免写已关闭 db
      pages++;
      const sinceVersion = this.cacheManager.getLastSyncedVersion();
      // AbortSignal.timeout:undici 默认 ~300s,黑洞网络下单页 fetch 会挂死整条
      // syncInFlight(trigger-sync / set-sync-enabled IPC 一起卡)。15s 超时后归
      // transient,下一轮轮询重试。
      const res = await fetch(`${base}/api/v1/sync/pull?since_version=${sinceVersion}&limit=${PULL_LIMIT}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
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
        totalPulled += data.changes.length;
        // idle 几小时后回前台时,服务端积累的几百条变更会拉成多页,
        // 每页 applyChanges 是同步 db.transaction。每页之间让出一个事件循环,
        // 给 IPC handler / renderer 一个插队窗口,避免整段串行卡主线程。
        await new Promise(resolve => setImmediate(resolve));
      }
      // 修复(2026-05-20 Audit F-1):
      // 原条件 `!data.has_more || data.changes.length === 0` 在服务端意外返回
      // `{changes:[], has_more:true}` 时会让客户端永远卡住(cursor 不推进 + 不再轮询)。
      // 实际服务端走 slice(0,limit) 保证 has_more=true 时 changes 非空,但靠不变量
      // 不如靠 has_more 单一信号。
      // 单独退出条件:`!data.has_more` — has_more=true && 0 changes 的边界状态
      // 让 MAX_PAGES 兜底(下一轮 fetch 会再发,sinceVersion 不变,服务端继续返回相同
      // 空页 → MAX_PAGES 退出,避免死循环)。
      if (!data.has_more) break;
      // 若 has_more=true 但 cursor 未推进(应用层没改 sinceVersion),也及时退出
      // 防御无限循环;下次 syncOnce 重试。
      if (data.changes.length === 0) {
        log.warn(`pullChanges: server returned has_more=true with 0 changes (sinceVersion=${sinceVersion}); breaking to avoid stall`);
        break;
      }
    }
    if (totalPulled > 0) log.info(`pulled ${totalPulled} changes across ${pages} page(s)`);
    return totalPulled;
  }

  async pushOutbox(token: string): Promise<number> {
    const items = getOutboxItems(this.db, 50);
    if (items.length === 0) return 0;

    // Per-item JSON.parse 防御。原版用 `items.map(i => ({..., payload: JSON.parse(i.payload) }))`,
    // 一条坏 payload 抛 SyntaxError 直接中断整批 fetch → 整个 outbox 永久卡死(HIGH bug)。
    // 修复:坏的立即搬到 dead-letter(corrupted payload 是确定性失败,retry 5 次也修不好),
    // 好的继续走。如果全部都是坏的 → 直接返回,不发空请求。
    const validItems: Array<{ operation: string; payload: unknown; id: string }> = [];
    const corruptedIds: string[] = [];
    for (const item of items) {
      try {
        validItems.push({ operation: item.operation, payload: JSON.parse(item.payload), id: item.id });
      } catch (err) {
        log.warn(`outbox item ${item.id} payload corrupted: ${(err as Error).message}`);
        corruptedIds.push(item.id);
      }
    }
    if (corruptedIds.length > 0) {
      for (const id of corruptedIds) {
        deadLetterOutboxItem(this.db, id, 'corrupted_payload');
      }
      log.error(`outbox: dead-lettered ${corruptedIds.length} item(s) with corrupted JSON payload`);
    }
    if (validItems.length === 0) {
      // 全部坏掉:这一轮没东西可推,直接返回。下一轮 push 队列里就只剩好的(或空)。
      return 0;
    }

    const base = getCloudBaseUrl();
    const res = await fetch(`${base}/api/v1/sync/outbox`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: validItems.map(i => ({ operation: i.operation, payload: i.payload })) }),
      signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 与 pullChanges 对齐:解析 403 结构化错误,不再对所有非 2xx 一律泛化 throw。
      // 原实现把 quota_exceeded / cloud_not_available 当普通失败 throw,导致 push 先于
      // pull,push 一抛错 pull 永远跑不到——超配额用户连其他设备的下行变更都拉不下来。
      if (res.status === 403) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        if (body.error === 'cloud_not_available') {
          throw new Error('cloud_not_available'); // 走 slow-retry,与 pull 一致
        }
        if (body.error === 'quota_exceeded') {
          // 配额耗尽不是故障:保留 outbox(不删、不计 retry),**不抛错**,让本轮
          // 继续走 pullChanges 拉下行变更。用户升级 Pro 后下次 push 自动重试。
          log.warn(`outbox push rejected: quota_exceeded (${validItems.length} item(s) retained)`);
          return 0;
        }
      }
      throw new Error(`Outbox push failed: ${res.status}`);
    }

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
        // 服务端 r.index 是相对 **发出去的 batch**(即 validItems),不是原始 items。
        // 修复 corrupted-JSON 之后两者长度可能不同。
        const item = validItems[r.index];
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
      // 老服务端:假设全部成功,保持原行为(只对发出去的 validItems 删除)
      for (const item of validItems) {
        removeOutboxItem(this.db, item.id);
        removed++;
      }
    }

    log.info(`pushed ${validItems.length} outbox items: removed=${removed} failed=${failed} deadLettered=${deadLettered + corruptedIds.length} quotaExhausted=${quotaExhausted}`);
    return removed;
  }

  /**
   * M8.5:拉云端 generation 锚点(/sync/version 的 decay_generation),本地把 active 节点
   * heat/maturity lazy 重算到 G。withApplyGuard 抑制上行(派生衰减非用户写,不进 cloud_dirty)。
   * 失败静默,下次 sync 重试。
   */
  private async recomputeMetabolismGeneration(token: string): Promise<void> {
    try {
      const res = await fetch(`${getCloudBaseUrl()}/api/v1/sync/version`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json() as { decay_generation?: number; decay_base?: number; decay_damping?: number };
      const G = Number(data.decay_generation ?? 0);
      if (G > 0) {
        // M8 参数随锚点下发(审计 HIGH):存云端 decay 参数,recomputeToGeneration 据此衰减,与云端
        // synaptic 逐位一致(不受本地 learning2 调参分叉影响)。
        if (typeof data.decay_base === 'number') {
          this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud.decay_base', ?)").run(String(data.decay_base));
        }
        if (typeof data.decay_damping === 'number') {
          this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud.decay_damping', ?)").run(String(data.decay_damping));
        }
        const n = withApplyGuard(this.db, () => recomputeToGeneration(this.db, G));
        if (n > 0) this.emitDataChanged();
      }
    } catch (err) {
      log.warn(`generation 重算失败(下次重试): ${(err as Error).message}`);
    }
  }

  /**
   * 广播 data-changed。dataChanged=true 时附 'nodes'/'links' scope 触发 renderer
   * 重拉笔记/图谱;false 时只发 'cloud'(刷状态条,不重拉)。
   * 默认 true 以保守兼容直接调用方。
   */
  private emitDataChanged(dataChanged = true): void {
    const scopes = dataChanged ? ['cloud', 'nodes', 'links'] : ['cloud'];
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('data-changed', { scopes });
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
  // Audit-3 F4 修复:capture instance ref,await 期间可能被 destroySyncClient 设 null。
  // 必须保留本地 inst 引用避免 NPE;同时 await 结束后再次检查 instance,如果已被 destroy
  // 则返 destroyed_during_sync 让 caller 知道是中途取消而非真失败。
  const inst = instance;
  if (!inst) return { success: false, error: 'not_initialized' };
  await inst.syncOnce();

  if (!instance) {
    return { success: false, error: 'destroyed_during_sync' };
  }
  if (inst.cloudNotAvailable) {
    return { success: false, error: 'cloud_not_available', errorDetail: inst.lastErrorMessage ?? undefined };
  }
  if (inst.syncNotReady) {
    return { success: false, error: 'sync_not_ready', errorDetail: inst.lastErrorMessage ?? undefined };
  }
  const status = inst.getStatus();
  if (status === 'offline') {
    return { success: false, error: 'offline', errorDetail: inst.lastErrorMessage ?? undefined };
  }
  if (status === 'error') {
    return { success: false, error: 'sync_error', errorDetail: inst.lastErrorMessage ?? undefined };
  }
  return { success: true };
}

/**
 * Get the number of pending outbox items. Called by IPC handler cloud:outbox-count.
 *
 * Audit-3 F14 修复:用 client 的 public getter 而不是 `as any`,并区分"无 instance"
 * (返 0)和"查询失败"(返 -1 sentinel)。IPC 层把 -1 翻译成 UI 显示 "—",让用户
 * 能看到是真没有 outbox 还是查询出错。之前 catch 全部吞掉返 0,DB 关了 / 查询失败
 * 与"真没有 pending"完全无法区分。
 */
export function getOutboxCount(): number {
  if (!instance) return 0;
  try {
    return _getOutboxCount(instance.getDb());
  } catch {
    return -1;
  }
}
