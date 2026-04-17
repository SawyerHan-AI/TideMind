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
        online: syncClient ? syncClient.getStatus() !== 'offline' : false,
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

    if (enabled && db) {
      const { isLoggedIn } = await import('../cloud/auth-client.js');
      if (isLoggedIn()) {
        const { createCloudSyncClient } = await import('../cloud/sync-client.js');
        const client = createCloudSyncClient(db);
        client.start().catch(e => log.error('sync start failed:', (e as Error).message));
      }
    } else {
      const { destroySyncClient } = await import('../cloud/sync-client.js');
      destroySyncClient();
    }

    emitCloudChanged();
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
