/**
 * Audit-3 F4 回归覆盖:
 * triggerSync 在 syncOnce await 中途被 destroySyncClient 设 null 时,必须能稳定返
 * destroyed_during_sync,不应 NPE。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../helpers/test-db.js';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}));

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  initAuth: vi.fn(),
  getCloudAuth: vi.fn(() => null),
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: vi.fn(async () => null),
  isLoggedIn: vi.fn(() => false),
}));

vi.mock('../../client/electron/cloud/reconciler.js', () => ({
  Reconciler: vi.fn().mockImplementation(() => ({
    runAll: vi.fn(async () => []),
  })),
}));

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

import {
  createCloudSyncClient,
  destroySyncClient,
  triggerSync,
} from '../../client/electron/cloud/sync-client.js';
import { refreshTokenIfNeeded } from '../../client/electron/cloud/auth-client.js';

describe('F4 — triggerSync NPE on concurrent destroy', () => {
  beforeEach(() => {
    destroySyncClient();
    vi.mocked(refreshTokenIfNeeded).mockReset();
  });

  it('triggerSync 在 syncOnce 进行中被 destroy → 返 destroyed_during_sync,不抛 NPE', async () => {
    const db = setupTestDb();
    createCloudSyncClient(db);

    // 让 syncOnce 第一个 await(refreshTokenIfNeeded)挂起;期间外部调 destroy
    let resolveRefresh!: (v: string | null) => void;
    vi.mocked(refreshTokenIfNeeded).mockImplementationOnce(
      () => new Promise(r => { resolveRefresh = r }),
    );

    const triggerP = triggerSync();
    // 给 syncOnce 跑到第一个 await 的机会
    await Promise.resolve();
    // destroy
    destroySyncClient();
    // 解锁 refresh,syncOnce 继续跑直到 stopped 检查
    resolveRefresh(null);

    const res = await triggerP;
    expect(res.success).toBe(false);
    expect(res.error).toBe('destroyed_during_sync');
  });

  it('triggerSync not_initialized:instance=null 时直接返,不抛', async () => {
    destroySyncClient();
    const res = await triggerSync();
    expect(res).toEqual({ success: false, error: 'not_initialized' });
  });
});
