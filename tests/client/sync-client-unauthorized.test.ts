/**
 * 同步请求收到 401 时上报给凭据模块（设计 primary-device-acceptance-fixes §4.4 c）。
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
  Reconciler: vi.fn().mockImplementation(function () { return ({
    runAll: vi.fn(async () => []),
  }) }),
}));

vi.mock('../../client/electron/cloud/outbox.js', () => ({
  getOutboxItems: () => [],
  removeOutboxItem: vi.fn(),
  markOutboxFailed: vi.fn(),
  getOutboxCount: () => 0,
}));

vi.mock('../../client/electron/cloud/cache-manager.js', () => ({
  CacheManager: vi.fn().mockImplementation(function () { return ({
    applyChanges: vi.fn(),
    getLastSyncedVersion: () => 0,
  }) }),
}));

vi.mock('../../client/electron/cloud/device.js', () => ({
  registerDevice: vi.fn(async () => {}),
}));
vi.mock('../../client/electron/cloud/uplink.js', () => ({
  pumpUplink: vi.fn(async () => 0),
  cancelActiveUplink: vi.fn(),
}));
const { noteUnauthorized, reportAndWait, sockets } = vi.hoisted(() => ({
  noteUnauthorized: vi.fn(),
  reportAndWait: vi.fn(async () => 'unchanged' as string),
  sockets: [] as Array<{ emit: (event: string, ...args: unknown[]) => void }>,
}));
vi.mock('../../client/electron/cloud/unauthorized.js', () => ({
  noteUnauthorized,
  reportUnauthorizedAndWait: reportAndWait,
}));
const fakeWs = vi.hoisted(() => async () => {
  const { EventEmitter } = await import('node:events');
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); sockets.push(this); }
    send(): void {}
    close(): void {}
  }
  return { default: FakeSocket, WebSocket: FakeSocket };
});
// 与 electron 相同：客户端源码里的 `ws` 解析到 client/node_modules，两条路径都要替身。
vi.mock('ws', fakeWs);
vi.mock('../../client/node_modules/ws/wrapper.mjs', fakeWs);

import { CloudSyncClient } from '../../client/electron/cloud/sync-client.js';

describe('sync requests report a 401 from the cloud', () => {
  beforeEach(() => { noteUnauthorized.mockReset(); });

  it.each([
    [401, true],
    [403, false],
    [500, false],
  ])('pull answered with %i', async (status, reported) => {
    const db = setupTestDb();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'x' }), { status }));
    const client = new CloudSyncClient(db);
    await client.syncOnce();
    expect(fetchSpy).toHaveBeenCalled();
    expect(noteUnauthorized.mock.calls.some(([s]) => s === 401)).toBe(reported);
    client.stop();
    fetchSpy.mockRestore();
  });
});

describe('sync channel closed for an auth failure', () => {
  type Internals = { connectWebSocket: () => Promise<void>; wsReconnectTimer: unknown; wsReconnectAttempts: number };
  async function closedWith(result: string) {
    sockets.length = 0;
    reportAndWait.mockReset().mockResolvedValue(result);
    const client = new CloudSyncClient(setupTestDb());
    const internals = client as unknown as Internals;
    await internals.connectWebSocket();
    internals.wsReconnectAttempts = 3;
    sockets[0].emit('close', 4401, Buffer.from('auth_fail'));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return { client, internals };
  }

  it('asks the cloud for a real refresh instead of trusting the cached token', async () => {
    const { client } = await closedWith('unchanged');
    expect(reportAndWait).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('credentials are gone: does not reconnect', async () => {
    const { client, internals } = await closedWith('signed_out');
    expect(internals.wsReconnectTimer).toBeNull();
    client.stop();
  });

  it('nothing changed: reconnects with backoff (the retry count is not reset)', async () => {
    const { client, internals } = await closedWith('unchanged');
    expect(internals.wsReconnectTimer).not.toBeNull();
    expect(internals.wsReconnectAttempts).toBeGreaterThanOrEqual(3);
    client.stop();
  });

  it('new tokens: reconnects right away', async () => {
    const { client, internals } = await closedWith('refreshed');
    expect(internals.wsReconnectTimer).not.toBeNull();
    expect(internals.wsReconnectAttempts).toBeLessThanOrEqual(1);
    client.stop();
  });
});

describe('a reconcile that stays unfinished does not make the UI reload every round', () => {
  type Internals = {
    pullChanges: () => Promise<number>; retryDeadLetters: () => Promise<void>;
    refreshGenerationAnchor: () => Promise<{ version: number }>; maybeTriggerReconcile: () => Promise<boolean>;
    emitDataChanged: (changed?: boolean) => void; pullDrained: boolean; reconcileChangedData: boolean;
  };
  async function round(changed: boolean) {
    const client = new CloudSyncClient(setupTestDb());
    const internals = client as unknown as Internals;
    const emitted: boolean[] = [];
    internals.pullChanges = async () => { internals.pullDrained = true; return 0; };
    internals.retryDeadLetters = async () => {};
    internals.refreshGenerationAnchor = async () => ({ version: 0 });
    internals.maybeTriggerReconcile = async () => { internals.reconcileChangedData = changed; return false; };
    internals.emitDataChanged = (c = true) => { emitted.push(c); };
    await client.syncOnce();
    client.stop();
    return emitted;
  }
  it('nothing moved: only the status is refreshed', async () => { expect(await round(false)).toEqual([false]); });
  it('records were uploaded or downloaded: data is reloaded', async () => { expect(await round(true)).toEqual([true]); });
});

