import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { getConfig, reloadConfig } from '../../../src/config.js'
import { createLogger } from '../../../src/utils/logger.js'
import { parseRequiredBoolean } from './_schemas.js'
import { getOutboxDiagnostics } from '../cloud/outbox.js'
import { notifyMetabolismWorkerRuntimeMutation } from '../workers/metabolism-worker-runtime-mutations.js'

const log = createLogger('ipc-cloud')

/**
 * 取两个 ISO 时间戳中较早的那个(null 视为"未跑过",最早)。
 * 用于计算 "最近对齐" 展示 — 两张表都跑完才算真的对齐。
 */
function oldestReconcile(a: string | null, b: string | null): string | null {
  if (!a || !b) return null; // 任一为空 → 没真的对齐过
  return new Date(a).getTime() < new Date(b).getTime() ? a : b;
}

function emitCloudChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('data-changed', { scopes: ['cloud'] })
    }
  }
}

export function registerCloudHandlers(db?: Database.Database): void {
  // Login
  ipcMain.handle('cloud:login', async (_event, email: string, password: string) => {
    // F6 (audit-9): IPC 层长度上限,与服务器端 /login 对齐(email ≤ 254 / password ≤ 256)。
    // IPC 是受信通道,但加这层挡 UI/extension bug 早失败而不是绕一圈到 server 再 400。
    //
    // MEDIUM 8 (audit-10, 2026-05-21):cap 校验失败由 throw 改成 return
    // `{ success: false, error }` 结构化失败 — 跟 renderer 其他通道(connections /
    // pick-vertex-file 等)对齐,renderer 不用为这个 IPC 单独写 try/catch。
    // login 本身仍可能因网络/认证 throw,renderer 已有兜底,不影响。
    if (typeof email !== 'string' || typeof password !== 'string') {
      return { success: false, error: 'email and password must be strings' };
    }
    if (email.length > 254 || password.length > 256) {
      return { success: false, error: 'email or password too long' };
    }
    // 契约裁剪:login() 返回完整 CloudAuth(含 accessToken / 长生命周期 refreshToken)。
    // 绝不把 token 跨 IPC 送进 renderer JS 上下文——token 只存主进程 + keychain,
    // renderer 只见 email/plan(cloud:status 即如此)。同时与 api-contract 声明对齐:
    // 该接口契约是 { success, error? },原实现直接 return CloudAuth 没有 success 字段,
    // 任何按契约写的 renderer 会把登录成功判成失败。成功只回 { success: true },
    // 网络/认证失败 throw 转 { success: false, error }(与校验失败分支同形)。
    try {
      const { login } = await import('../cloud/auth-client.js');
      await login(email, password);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Logout — 联动停止 sync client
  ipcMain.handle('cloud:logout', async () => {
    const { logout } = await import('../cloud/auth-client.js');
    const { destroySyncClient } = await import('../cloud/sync-client.js');
    destroySyncClient();
    await logout();
    emitCloudChanged();
  });

  // Get cloud status — 读取 sync client 真实状态
  ipcMain.handle('cloud:status', async () => {
    const fallback = {
      loggedIn: false, email: null, plan: null,
      syncEnabled: false, online: false, syncing: false,
      outboxCount: 0, lastSyncedAt: null,
      cloudNotAvailable: false, syncNotReady: false,
      lastErrorCode: null, lastErrorMessage: null,
      outboxDiagnostics: null,
    };
    try {
      const { isLoggedIn, getCloudAuth } = await import('../cloud/auth-client.js');
      if (!isLoggedIn()) return fallback;
      const auth = getCloudAuth();
      if (!auth) return fallback;

      const config = getConfig();
      const syncEnabled = config.cloud?.sync_enabled ?? false;
      const metabolismEnabled = config.cloud?.metabolism_enabled ?? false;

      // 从 metadata 读 reconcile 状态(给 UI 展示"最近对齐"/"失败")
      let lastReconcileAtNodes: string | null = null;
      let lastReconcileAtLinks: string | null = null;
      let lastReconcileStatus: string | null = null;
      let lastReconcileError: string | null = null;
      let outboxDiagnostics: ReturnType<typeof getOutboxDiagnostics> | null = null;
      if (db) {
        try {
          const readMeta = (key: string): string | null => {
            const row = db!.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
            return row?.value ?? null;
          };
          lastReconcileAtNodes = readMeta('cloud.last_reconcile_at_nodes');
          lastReconcileAtLinks = readMeta('cloud.last_reconcile_at_links');
          lastReconcileStatus = readMeta('cloud.last_reconcile_status');
          lastReconcileError = readMeta('cloud.last_reconcile_error');
        } catch { /* metadata 表或列缺失,忽略 */ }
        try {
          outboxDiagnostics = getOutboxDiagnostics(db);
        } catch (err) {
          log.warn(`failed to read outbox diagnostics: ${(err as Error).message}`);
        }
      }

      const { getCloudSyncClient, getOutboxCount } = await import('../cloud/sync-client.js');
      const syncClient = getCloudSyncClient();

      // 根据 syncClient 的状态字段派生一个错误码,持久化到 UI。
      // 这样 DataSyncSection 的红色错误条在页面切换后重新挂载时仍能读到
      // 当前持续存在的错误,而不是只依赖瞬时的 lastError state。
      let lastErrorCode: string | null = null;
      if (syncClient) {
        if (syncClient.cloudNotAvailable) lastErrorCode = 'cloud_not_available';
        else if (syncClient.syncNotReady) lastErrorCode = 'sync_not_ready';
        else if (syncClient.getStatus() === 'offline') lastErrorCode = 'offline';
        else if (syncClient.getStatus() === 'error') lastErrorCode = 'sync_error';
      }

      return {
        loggedIn: true,
        email: auth.email ?? null,
        plan: auth.plan ?? null,
        syncEnabled,
        // 已登录默认视为在线；仅当 syncClient 明确汇报 'offline'（token 失效 / 网络不可达 / 403 白名单拒绝）时才置为 false
        // 旧逻辑把"无 syncClient"也当 offline,导致未开启同步的用户被错误地显示为"离线"
        online: syncClient ? syncClient.getStatus() !== 'offline' : true,
        syncing: syncClient ? syncClient.getStatus() === 'syncing' : false,
        // Audit-3 F14:-1 表示查询失败 → null,让前端显示 "—" 而非 "0 pending"。
        outboxCount: outboxDiagnostics?.pendingCount ?? (() => {
          if (!syncClient) return 0;
          const c = getOutboxCount();
          return c < 0 ? null : c;
        })(),
        lastSyncedAt: auth.lastSyncedAt ?? null,
        cloudNotAvailable: syncClient?.cloudNotAvailable ?? false,
        syncNotReady: syncClient?.syncNotReady ?? false,
        lastErrorCode,
        lastErrorMessage: syncClient?.lastErrorMessage ?? null,
        metabolismEnabled,
        // reconcile 状态(取 nodes / links 中更早的那个作为"最近对齐"展示)
        lastReconcileAt: oldestReconcile(lastReconcileAtNodes, lastReconcileAtLinks),
        lastReconcileStatus,
        lastReconcileError,
        outboxDiagnostics,
      };
    } catch {
      return fallback;
    }
  });

  // 开关数据云同步
  ipcMain.handle('cloud:set-sync-enabled', async (_event, enabled: unknown) => {
    const parsed = parseRequiredBoolean(enabled, 'enabled')
    if (!parsed.ok) return parsed.error

    const fs = await import('node:fs');
    const path = await import('node:path');
    const { parse: parseToml } = await import('smol-toml');
    const { stringify: stringifyToml } = await import('smol-toml');
    const { getDataDir } = await import('../../../src/config.js');

    const configPath = path.join(getDataDir(), 'config.toml');

    // 读取现有 config
    let current: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        current = parseToml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch { /* ignore */ }
    }

    // 深度合并 cloud section
    const cloud = (current.cloud ?? {}) as Record<string, unknown>;
    cloud.sync_enabled = parsed.data;
    cloud.enabled = parsed.data; // 联动 MCP 路由开关
    current.cloud = cloud;

    // 原子写:写 tmp 再 rename,防止写入中崩溃 / 断电留下半截 TOML 让下次
     // parseToml 失败 fallback 到 {},用户云同步状态消失。
    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, stringifyToml(current as any));
    fs.renameSync(tmpPath, configPath);
    reloadConfig();
    notifyMetabolismWorkerRuntimeMutation('config');
    log.info(`cloud sync ${parsed.data ? 'enabled' : 'disabled'}`);

    let startError: string | undefined;
    let startErrorDetail: string | undefined;
    if (parsed.data && db) {
      const { isLoggedIn } = await import('../cloud/auth-client.js');
      if (!isLoggedIn()) {
        startError = 'not_logged_in';
      } else {
        const { createCloudSyncClient } = await import('../cloud/sync-client.js');
        const client = createCloudSyncClient(db);
        // 等待首次 syncOnce 完成后检查客户端状态,把失败反馈给前端。
        // 历史上这里是 fire-and-forget,导致 token 失效 / 白名单未过 / 404 等失败
        // 只写到日志,UI 看到"开启成功"假象,之后"立即同步"按钮又因 online=false 灰掉,
        // 用户体验是"打开了但不同步也点不动"。
        //
        // start() 内部对首次 syncOnce 做了 try/catch(失败时仍建 WS/轮询/activity,
        // 并调度延迟重试),正常不向外抛;但防御性包 try——start() 内非 syncOnce 的
        // 意外异常不能把 set-sync-enabled 的 {success,error} 契约打破成裸 reject。
        try {
          await client.start();
        } catch (err) {
          startError = 'sync_error';
          startErrorDetail = (err as Error).message;
          log.warn(`sync start threw: ${startErrorDetail}`);
        }
        if (startError) {
          // start() 抛了异常(startErrorDetail 已记其 message),下面的状态字段判断跳过。
        } else if (client.cloudNotAvailable) {
          startError = 'cloud_not_available';
        } else if (client.syncNotReady) {
          startError = 'sync_not_ready';
        } else if (client.getStatus() === 'offline') {
          startError = 'offline'; // 多半是 token 刷新失败
        } else if (client.getStatus() === 'error') {
          startError = 'sync_error';
        }
        // 仅当 detail 尚未由 throw 路径填充时,从 client 状态字段读 detail。
        if (startError && startErrorDetail === undefined) {
          startErrorDetail = client.lastErrorMessage ?? undefined;
        }
        if (startError) {
          log.warn(`sync start reported: ${startError}${startErrorDetail ? ' — ' + startErrorDetail : ''}`);
        }
      }
    } else if (!parsed.data) {
      const { destroySyncClient } = await import('../cloud/sync-client.js');
      destroySyncClient();
    }

    emitCloudChanged();
    if (startError) return { success: false, error: startError, errorDetail: startErrorDetail };
    return { success: true };
  });

  // Trigger manual sync
  ipcMain.handle('cloud:trigger-sync', async () => {
    try {
      const { triggerSync, getCloudSyncClient, createCloudSyncClient } = await import('../cloud/sync-client.js');

      // 自救路径:如果 syncClient 不存在但条件都满足(sync 开启 + 已登录 + db 就绪),
      // 现场创建一个再触发同步。这样即使 main.ts 启动时序有问题没把 client 建起来,
      // 用户点"立即同步"也能一键自救,不用去折腾关开 toggle。
      if (!getCloudSyncClient() && db) {
        const { isLoggedIn } = await import('../cloud/auth-client.js');
        const config = getConfig();
        if (config.cloud?.sync_enabled && isLoggedIn()) {
          log.info('trigger-sync: syncClient missing, creating on demand');
          const client = createCloudSyncClient(db);
          await client.start();
          emitCloudChanged();
          // start() 已经跑过一次 syncOnce,不用再 triggerSync——直接根据 client 状态回报
          if (client.cloudNotAvailable) return { success: false, error: 'cloud_not_available', errorDetail: client.lastErrorMessage ?? undefined };
          if (client.syncNotReady) return { success: false, error: 'sync_not_ready', errorDetail: client.lastErrorMessage ?? undefined };
          if (client.getStatus() === 'offline') return { success: false, error: 'offline', errorDetail: client.lastErrorMessage ?? undefined };
          if (client.getStatus() === 'error') return { success: false, error: 'sync_error', errorDetail: client.lastErrorMessage ?? undefined };
          return { success: true };
        }
      }

      return triggerSync();
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 开关云代谢(本地/云互斥开关)
  ipcMain.handle('cloud:set-metabolism-enabled', async (_event, enabled: unknown) => {
    const parsed = parseRequiredBoolean(enabled, 'enabled')
    if (!parsed.ok) return parsed.error

    const fs = await import('node:fs');
    const path = await import('node:path');
    const { parse: parseToml, stringify: stringifyToml } = await import('smol-toml');
    const { getDataDir } = await import('../../../src/config.js');

    const configPath = path.join(getDataDir(), 'config.toml');
    let current: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        current = parseToml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch { /* ignore */ }
    }
    const cloud = (current.cloud ?? {}) as Record<string, unknown>;
    cloud.metabolism_enabled = parsed.data;
    current.cloud = cloud;
    // 原子写,见 set-sync-enabled 同处理。
    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, stringifyToml(current as any));
    fs.renameSync(tmpPath, configPath);
    reloadConfig();
    notifyMetabolismWorkerRuntimeMutation('config');
    log.info(`cloud metabolism ${parsed.data ? 'enabled' : 'disabled'}`);
    emitCloudChanged();
    return { success: true };
  });

  // 用户主动触发 reconcile(设置页"强制对齐"按钮)。
  //
  // 全局互斥 + abort 走 reconcile-lock(进程级单一入口),手动 force-reconcile 与
  // 自动 reconcile(sync-client.maybeTriggerReconcile)共享同一把锁:
  //  - 任一已在跑 → 返 already_running,不并发跑两个 reconciler 互相覆盖 metadata
  //  - cloud:abort-reconcile 能命中**任意来源**的实例(原实现只能 abort 手动那个,
  //    自动 reconcile 对用户的"取消"返 not_running 无法停)
  //  - reconciler.abort() 只在当前 batch 结束后退出,非立即生效
  ipcMain.handle('cloud:force-reconcile', async () => {
    if (!db) return { success: false, error: 'db_not_ready' };
    const dbForReconcile = db;
    try {
      const { isLoggedIn } = await import('../cloud/auth-client.js');
      if (!isLoggedIn()) return { success: false, error: 'not_logged_in' };
      const { runExclusive } = await import('../cloud/reconcile-lock.js');
      const { Reconciler } = await import('../cloud/reconciler.js');
      const outcome = await runExclusive(async (register) => {
        const reconciler = new Reconciler(dbForReconcile);
        register(reconciler);
        return reconciler.runAll(false);
      });
      if (!outcome.ok) return { success: false, error: 'already_running' };
      return { success: true, results: outcome.value };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('cloud:abort-reconcile', async () => {
    const { abortActiveReconcile } = await import('../cloud/reconcile-lock.js');
    if (!abortActiveReconcile()) return { success: false, error: 'not_running' };
    return { success: true };
  });

  // Get outbox count
  // Audit-3 F14:getOutboxCount 返 -1 表示查询失败(DB 关 / 异常),IPC 翻译成 null,
  // 让 UI 显示 "—" 而不是 "0 pending"(后者会让用户误以为没有未同步)。
  ipcMain.handle('cloud:outbox-count', async () => {
    try {
      const { getOutboxCount } = await import('../cloud/sync-client.js');
      const count = getOutboxCount();
      return count < 0 ? null : count;
    } catch {
      return null;
    }
  });

  // 产品决策 #7(2026-05-20):用量查询(本地 active 节点数 vs 当前 plan 上限)。
  // 仅当用户开了 cloud sync 才有意义,但 free plan 即便没开 sync 也会用 500 上限
  // 作为参考显示。
  ipcMain.handle('cloud:memory-usage', async () => {
    const FREE_LIMIT = 500;
    const PRO_LIMIT = 50000; // Pro 默认上限,纯展示用,不会真触发拒收
    try {
      if (!db) return { used: 0, limit: FREE_LIMIT, plan: 'free' as const };
      // 与服务端 quota 口径对齐:server checkQuota 用 `COUNT(*) WHERE archived = false`
      // (quota.ts:136/219),并不排除 is_superseded。客户端原来多排了 is_superseded=0,
      // 显示用量低于服务端实际计费口径 → 用户在 UI 还显示"没满"时就被服务端拒收。
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM nodes WHERE archived = 0')
        .get() as { n: number } | undefined;
      const used = row?.n ?? 0;
      const { getCloudAuth, refreshPlanNow } = await import('../cloud/auth-client.js');
      // 升级/降级发生在服务端;读 plan 前先收敛一次,避免 Creem 升级后这里长期显示旧 plan。
      // 未登录时 refreshPlanNow 是廉价 no-op。
      await refreshPlanNow();
      const plan = (getCloudAuth()?.plan ?? 'free') as 'free' | 'pro' | 'pro_plus';
      const limit = plan === 'free' ? FREE_LIMIT : PRO_LIMIT;
      return { used, limit, plan };
    } catch (err) {
      log.warn(`cloud:memory-usage failed: ${(err as Error).message}`);
      return { used: 0, limit: FREE_LIMIT, plan: 'free' as const };
    }
  });

  // Get login URL (for opening in system browser)
  ipcMain.handle('cloud:login-url', async () => {
    const { getLoginUrl } = await import('../cloud/auth-client.js');
    return getLoginUrl();
  });

  // Get register URL (for opening in system browser)
  ipcMain.handle('cloud:register-url', async () => {
    const { getRegisterUrl } = await import('../cloud/auth-client.js');
    return getRegisterUrl();
  });

  // B3 fallback:任何失败/未登录都退回公开定价页(匿名仍可购买,服务端 email 兜底)。
  const FALLBACK_PRICING = 'https://tidemind.ai/pricing';

  // 升级 checkout:主进程带 token 请求 /checkout,拿回**已绑 user_id** 的 Creem URL
  // (tier-1 强绑定,买家在 Creem 页改不改邮箱都授予对)。失败/未登录 → 公开定价页。
  ipcMain.handle('cloud:billing-checkout-url', async (_event, plan: unknown, interval: unknown) => {
    const { authedRedirectLocation } = await import('../cloud/auth-client.js');
    const p = encodeURIComponent(typeof plan === 'string' ? plan : 'pro');
    const i = encodeURIComponent(typeof interval === 'string' ? interval : 'yearly');
    const url = await authedRedirectLocation(`/api/v1/billing/checkout?plan=${p}&interval=${i}`);
    return url ?? FALLBACK_PRICING;
  });

  // 管理订阅:同样带 token 拿 Creem portal URL(修好以前"返回裸 cloud URL 靠浏览器
  // session、多半打不开"的老问题)。失败 → 公开定价页。
  ipcMain.handle('cloud:billing-portal-url', async () => {
    const { authedRedirectLocation } = await import('../cloud/auth-client.js');
    const url = await authedRedirectLocation('/api/v1/billing/portal');
    return url ?? FALLBACK_PRICING;
  });
}
