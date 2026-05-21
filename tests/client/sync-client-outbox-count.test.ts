/**
 * Audit-3 F14 回归覆盖:
 * getOutboxCount 在 DB 关闭 / 异常时返 -1 sentinel,区分"真没有 pending"和"查询失败"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupTestDb } from '../helpers/test-db.js';

const { electronMock, outboxHolder } = vi.hoisted(() => ({
  electronMock: {
    BrowserWindow: { getAllWindows: () => [] },
    Notification: { isSupported: () => false },
  },
  outboxHolder: { value: 0 as number | (() => never) },
}));
vi.mock('electron', () => electronMock);
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  initAuth: vi.fn(),
  getCloudAuth: vi.fn(() => null),
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: vi.fn(async () => null),
  isLoggedIn: vi.fn(() => false),
  updateCloudAuth: vi.fn(),
}));

vi.mock('../../client/electron/cloud/reconciler.js', () => ({
  Reconciler: vi.fn().mockImplementation(() => ({ runAll: vi.fn(async () => []) })),
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

// outbox mocks(通过 outboxHolder.value 切换)
vi.mock('../../client/electron/cloud/outbox.js', () => ({
  getOutboxItems: () => [],
  removeOutboxItem: vi.fn(),
  markOutboxFailed: vi.fn(),
  getOutboxCount: vi.fn(() => {
    if (typeof outboxHolder.value === 'function') outboxHolder.value();
    return outboxHolder.value as number;
  }),
}));

import {
  createCloudSyncClient,
  destroySyncClient,
  getOutboxCount,
} from '../../client/electron/cloud/sync-client.js';

describe('F14 — getOutboxCount sentinel on DB error', () => {
  beforeEach(() => {
    destroySyncClient();
    outboxHolder.value = 0;
  });

  it('no instance → 0', () => {
    expect(getOutboxCount()).toBe(0);
  });

  it('正常查询 → 实际 count', () => {
    const db = setupTestDb();
    createCloudSyncClient(db);
    outboxHolder.value = 7;
    expect(getOutboxCount()).toBe(7);
  });

  it('查询抛错 → -1 sentinel', () => {
    const db = setupTestDb();
    createCloudSyncClient(db);
    outboxHolder.value = () => { throw new Error('db closed') };
    expect(getOutboxCount()).toBe(-1);
  });
});
