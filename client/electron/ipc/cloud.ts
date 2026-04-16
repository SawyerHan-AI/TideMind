import { ipcMain } from 'electron'

export function registerCloudHandlers(): void {
  // Login
  ipcMain.handle('cloud:login', async (_event, email: string, password: string) => {
    const { login } = await import('../cloud/auth-client.js');
    return login(email, password);
  });

  // Logout
  ipcMain.handle('cloud:logout', async () => {
    const { logout } = await import('../cloud/auth-client.js');
    return logout();
  });

  // Get cloud status
  ipcMain.handle('cloud:status', async () => {
    const fallback = { loggedIn: false, email: null, plan: null, online: false, syncing: false, outboxCount: 0, lastSyncedAt: null, cloudNotAvailable: false };
    try {
      const { isLoggedIn, getCloudAuth } = await import('../cloud/auth-client.js');
      if (!isLoggedIn()) return fallback;
      const auth = getCloudAuth();
      if (!auth) return fallback;

      let cloudNotAvailable = false;
      try {
        const { getCloudSyncClient } = await import('../cloud/sync-client.js');
        const syncClient = getCloudSyncClient();
        if (syncClient) {
          cloudNotAvailable = syncClient.cloudNotAvailable === true;
        }
      } catch { /* ignore */ }

      return {
        loggedIn: true,
        email: auth.email ?? null,
        plan: auth.plan ?? null,
        online: true,
        syncing: false,
        outboxCount: 0,
        lastSyncedAt: auth.lastSyncedAt ?? null,
        cloudNotAvailable,
      };
    } catch {
      return fallback;
    }
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
