import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import type { Reconciler as ReconcilerType } from '../cloud/reconciler.js'
import { getConfig, reloadConfig } from '../../../src/config.js'
import { createLogger } from '../../../src/utils/logger.js'
import { parseRequiredBoolean } from './_schemas.js'
import { getOutboxDiagnostics } from '../cloud/outbox.js'

const log = createLogger('ipc-cloud')

/**
 * 当前正在运行的 Reconciler 实例,全局唯一。
 *
 * - force-reconcile 检查它防重复触发
 * - abort-reconcile 通过它中止
 * 必须在 reconcile 结束(成功或失败)时清空。
 */
let activeReconciler: ReconcilerType | null = null;

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
    const { login } = await import('../cloud/auth-client.js');
    return login(email, password);
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
        outboxCount: outboxDiagnostics?.pendingCount ?? (syncClient ? getOutboxCount() : 0),
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
        // 注意:CloudSyncClient.start() 内部已对 syncOnce 做 try/catch(用 status 和
        // cloudNotAvailable/syncNotReady 标志表达错误),不会向外抛。因此这里不用包 try,
        // 而是 await 后读 client 的状态字段来判断首次同步结果。
        await client.start();
        if (client.cloudNotAvailable) {
          startError = 'cloud_not_available';
        } else if (client.syncNotReady) {
          startError = 'sync_not_ready';
        } else if (client.getStatus() === 'offline') {
          startError = 'offline'; // 多半是 token 刷新失败
        } else if (client.getStatus() === 'error') {
          startError = 'sync_error';
        }
        if (startError) {
          startErrorDetail = client.lastErrorMessage ?? undefined;
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
    log.info(`cloud metabolism ${parsed.data ? 'enabled' : 'disabled'}`);
    emitCloudChanged();
    return { success: true };
  });

  // 用户主动触发 reconcile(设置页"强制对齐"按钮)。
  //
  // 互斥锁 + abort IPC:
  //  - activeReconciler 全局唯一,重复点击直接返 already_running 而不是
  //    并发跑两个 reconciler 互相覆盖 metadata
  //  - cloud:abort-reconcile 手动中止正在跑的 reconcile
  //    (reconciler.abort() 只会在当前 batch 结束后退出,非立即生效)
  ipcMain.handle('cloud:force-reconcile', async () => {
    if (!db) return { success: false, error: 'db_not_ready' };
    if (activeReconciler) return { success: false, error: 'already_running' };
    try {
      const { isLoggedIn } = await import('../cloud/auth-client.js');
      if (!isLoggedIn()) return { success: false, error: 'not_logged_in' };
      const { Reconciler } = await import('../cloud/reconciler.js');
      activeReconciler = new Reconciler(db);
      try {
        const results = await activeReconciler.runAll(false);
        return { success: true, results };
      } finally {
        activeReconciler = null;
      }
    } catch (err) {
      activeReconciler = null;
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('cloud:abort-reconcile', async () => {
    if (!activeReconciler) return { success: false, error: 'not_running' };
    activeReconciler.abort();
    return { success: true };
  });

  // Get outbox count
  ipcMain.handle('cloud:outbox-count', async () => {
    try {
      const { getOutboxCount } = await import('../cloud/sync-client.js');
      return getOutboxCount();
    } catch {
      return 0;
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
}
