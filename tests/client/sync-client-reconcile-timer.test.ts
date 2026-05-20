/**
 * sync-client.ts 启动后 RECONCILE_TRIGGER_DELAY_MS(10s) 内若 stop() 被调,
 * reconcile timer 必须不再触发 — 防止 stop 后 callback 内调 maybeTriggerReconcile
 * 在 daemon teardown 中跑全表 SQL 阻塞或访问已关闭 DB。
 *
 * Audit F (2026-05-20) flagged this as missing coverage for my new
 * reconcileTimer + RECONCILE_TRIGGER_DELAY_MS code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupTestDb } from '../helpers/test-db.js';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}));

// 阻塞所有 fetch — syncOnce 内部会调 refreshTokenIfNeeded(已 mock 为 null) → 直接 offline,不发请求
vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  initAuth: vi.fn(),
  getCloudAuth: vi.fn(() => null),
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: vi.fn(async () => null),
  isLoggedIn: vi.fn(() => false),
}));

// reconciler 是 dynamic-import 进来的;mock 整模块让 runAll 不真跑 SQL
vi.mock('../../client/electron/cloud/reconciler.js', () => ({
  Reconciler: vi.fn().mockImplementation(() => ({
    runAll: vi.fn(async () => []),
  })),
}));

// outbox / cache-manager / device 不参与本测试,稳态 noop 即可
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
import { Reconciler } from '../../client/electron/cloud/reconciler.js';

describe('CloudSyncClient reconcile timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(Reconciler).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop() 调用在 RECONCILE_TRIGGER_DELAY_MS 窗口内 → reconciler 不被构造', async () => {
    const db = setupTestDb();
    // 强制 maybeTriggerReconcile 决策"该跑":metadata 表无 last_reconcile_at_* 字段(stale=true)
    const client = new CloudSyncClient(db);

    await client.start();

    // 立刻 stop,模拟 app 在启动 10s 内退出
    client.stop();

    // 推进 12 秒,跨过 RECONCILE_TRIGGER_DELAY_MS(10s)
    await vi.advanceTimersByTimeAsync(12_000);

    // Reconciler 构造函数永远不应被调到 — timer 已被 stop() 清掉
    expect(vi.mocked(Reconciler)).not.toHaveBeenCalled();
  });

  it('start 后等够 10s 未 stop → reconciler.runAll 被调一次', async () => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);
    await client.start();

    // 推进 12 秒
    await vi.advanceTimersByTimeAsync(12_000);

    // Reconciler 构造函数被调
    expect(vi.mocked(Reconciler)).toHaveBeenCalledTimes(1);

    // 清理(避免 timer 泄漏)
    client.stop();
  });
});
