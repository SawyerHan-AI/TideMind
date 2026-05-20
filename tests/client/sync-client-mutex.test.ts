/**
 * sync-client.ts syncOnce in-flight mutex 测试。
 *
 * 三条触发线(30s 兜底轮询 / WS changes_available / activity-state resume 错峰)
 * 在窗口 idle 几小时回前台时会同时调 syncOnce。如果不互斥,并发的 pushOutbox
 * + pullChanges 会在主线程同步 SQL 串行排队,鼠标转圈数十秒(2026-05-21 排查)。
 *
 * 这里锁三个不变量:
 *   1. in-flight 期间所有 syncOnce() 返回**同一个** Promise
 *   2. in-flight 结束(无论成功还是失败)后,mutex 被清,下一次 syncOnce 重新发起
 *   3. _doSyncOnce 抛同步错误也会让 mutex finally 跑到,不会永久卡死
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { CloudSyncClient } from '../../client/electron/cloud/sync-client.js';
import { refreshTokenIfNeeded } from '../../client/electron/cloud/auth-client.js';
import { getActivityState } from '../../client/electron/activity-state.js';

describe('CloudSyncClient syncOnce mutex', () => {
  beforeEach(() => {
    getActivityState().__resetForTests();
    vi.mocked(refreshTokenIfNeeded).mockReset();
  });

  afterEach(() => {
    getActivityState().__resetForTests();
  });

  it('并发 syncOnce 复用同一 in-flight Promise', async () => {
    // 让 refreshTokenIfNeeded 卡住,使 _doSyncOnce 第一个 await 不立即 resolve
    let resolveRefresh!: (v: string | null) => void;
    vi.mocked(refreshTokenIfNeeded).mockImplementationOnce(
      () => new Promise(r => { resolveRefresh = r }),
    );

    const db = setupTestDb();
    const client = new CloudSyncClient(db);

    const p1 = client.syncOnce();
    const p2 = client.syncOnce();
    const p3 = client.syncOnce();

    // 三个 caller 拿到的必须是同一个 Promise 引用
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    // 解开 refresh,让 _doSyncOnce 跑完(token=null → 走 offline 分支)
    resolveRefresh(null);
    await Promise.all([p1, p2, p3]);
  });

  it('in-flight 结束后,下一次 syncOnce 重新发起(不复用旧 Promise)', async () => {
    vi.mocked(refreshTokenIfNeeded).mockResolvedValue(null); // 全部走 offline 快速 return

    const db = setupTestDb();
    const client = new CloudSyncClient(db);

    const p1 = client.syncOnce();
    await p1;
    // 第一次完全 settle 之后,mutex 应该已被清
    const p2 = client.syncOnce();
    expect(p2).not.toBe(p1);
    await p2;
  });

  it('_doSyncOnce 内部抛错也会清 mutex,允许后续重试', async () => {
    // refreshTokenIfNeeded 抛 reject(模拟 token 网络抖动)
    vi.mocked(refreshTokenIfNeeded).mockRejectedValueOnce(new Error('boom'));

    const db = setupTestDb();
    const client = new CloudSyncClient(db);

    // _doSyncOnce 内部 try/catch 只覆盖 status 分支,refresh 抛错会冒到 mutex
    // 包装层的 Promise reject。但是 mutex 的 .finally 必须跑到,清掉 inFlight。
    // syncOnce 调用者会收到 reject — 用 expect().rejects 确认。
    await expect(client.syncOnce()).rejects.toThrow('boom');

    // 关键不变量:第二次 syncOnce 能正常发起,不被 stale Promise 卡死
    vi.mocked(refreshTokenIfNeeded).mockResolvedValueOnce(null);
    const p2 = client.syncOnce();
    await p2; // 不抛 = mutex 已被清
  });
});
