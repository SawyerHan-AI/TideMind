import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { getConfig, reloadConfig } from '../../../src/config.js'
import { createLogger } from '../../../src/utils/logger.js'

const log = createLogger('ipc-cloud')

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
    };
    try {
      const { isLoggedIn, getCloudAuth } = await import('../cloud/auth-client.js');
      if (!isLoggedIn()) return fallback;
      const auth = getCloudAuth();
      if (!auth) return fallback;

      const config = getConfig();
      const syncEnabled = config.cloud?.sync_enabled ?? false;

      const { getCloudSyncClient, getOutboxCount } = await import('../cloud/sync-client.js');
      const syncClient = getCloudSyncClient();

      return {
        loggedIn: true,
        email: auth.email ?? null,
        plan: auth.plan ?? null,
        syncEnabled,
        // 已登录默认视为在线；仅当 syncClient 明确汇报 'offline'（token 失效 / 网络不可达 / 403 白名单拒绝）时才置为 false
        // 旧逻辑把"无 syncClient"也当 offline,导致未开启同步的用户被错误地显示为"离线"
        online: syncClient ? syncClient.getStatus() !== 'offline' : true,
        syncing: syncClient ? syncClient.getStatus() === 'syncing' : false,
        outboxCount: syncClient ? getOutboxCount() : 0,
        lastSyncedAt: auth.lastSyncedAt ?? null,
        cloudNotAvailable: syncClient?.cloudNotAvailable ?? false,
        syncNotReady: syncClient?.syncNotReady ?? false,
      };
    } catch {
      return fallback;
    }
  });

  // 开关数据云同步
  ipcMain.handle('cloud:set-sync-enabled', async (_event, enabled: boolean) => {
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
    cloud.sync_enabled = enabled;
    cloud.enabled = enabled; // 联动 MCP 路由开关
    current.cloud = cloud;

    fs.writeFileSync(configPath, stringifyToml(current as any));
    reloadConfig();
    log.info(`cloud sync ${enabled ? 'enabled' : 'disabled'}`);

    let startError: string | undefined;
    if (enabled && db) {
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
        if (startError) log.warn(`sync start reported: ${startError}`);
      }
    } else if (!enabled) {
      const { destroySyncClient } = await import('../cloud/sync-client.js');
      destroySyncClient();
    }

    emitCloudChanged();
    if (startError) return { success: false, error: startError };
    return { success: true };
  });

  // Trigger manual sync
  ipcMain.handle('cloud:trigger-sync', async () => {
    try {
      const { triggerSync } = await import('../cloud/sync-client.js');
      return triggerSync();
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
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
