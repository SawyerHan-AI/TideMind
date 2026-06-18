/**
 * Audit-3 F13 回归覆盖:
 * syncNotReady 标志在 catch 入口必须先清,然后 404 分支再 set true。
 * 否则 404 → 网络错误(其他分支)的序列里 syncNotReady 永久 true。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../helpers/test-db.js';

const { electronMock } = vi.hoisted(() => ({
  electronMock: {
    BrowserWindow: { getAllWindows: () => [] },
    Notification: { isSupported: () => false },
  },
}));
vi.mock('electron', () => electronMock);
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  initAuth: vi.fn(),
  getCloudAuth: vi.fn(() => null),
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: vi.fn(async () => 'token'),
  isLoggedIn: vi.fn(() => true),
  updateCloudAuth: vi.fn(),
}));

vi.mock('../../client/electron/cloud/reconciler.js', () => ({
  Reconciler: vi.fn().mockImplementation(() => ({
    runAll: vi.fn(async () => []),
  })),
}));

const pushOutboxMock = vi.fn();
const pullChangesMock = vi.fn();
vi.mock('../../client/electron/cloud/outbox.js', () => ({
  getOutboxItems: () => [],
  removeOutboxItem: vi.fn(),
  markOutboxFailed: vi.fn(),
  getOutboxCount: () => 0,
}));

vi.mock('../../client/electron/cloud/cache-manager.js', () => ({
  CacheManager: vi.fn().mockImplementation(() => ({
    applyChanges: vi.fn(),
    getLastSyncedVersion: () => 0,
  })),
}));

vi.mock('../../client/electron/cloud/device.js', () => ({
  registerDevice: vi.fn(async () => {}),
}));

import { CloudSyncClient } from '../../client/electron/cloud/sync-client.js';

describe('F13 — syncNotReady not sticky', () => {
  beforeEach(() => {
    pushOutboxMock.mockReset();
    pullChangesMock.mockReset();
  });

  it('404 → 网络错(非 404):syncNotReady 应从 true 复位回 false', async () => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);

    // M9:pushOutbox 上行死链已断,改 stub pullChanges 当"抛 404 的网络调用"载体 → syncNotReady=true 分支
    (client as unknown as { pullChanges: () => Promise<unknown> }).pullChanges = vi.fn(async () => {
      throw new Error('manifest 404: not ready');
    });
    await client.syncOnce();
    expect(client.syncNotReady).toBe(true);

    // 第二次 syncOnce:换成其他网络错(不带 404),走 else 分支
    (client as unknown as { pullChanges: () => Promise<unknown> }).pullChanges = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await client.syncOnce();
    expect(client.syncNotReady).toBe(false);
  });
});
