/**
 * Audit-3 F2 回归覆盖:
 * startSlowRetry / stop 主动调 disconnectWebSocket 时,ws.close() 不能再走 close handler
 * 触发 scheduleReconnect。否则慢重试模式下 ws 会被反复重连,每次被服务端拒绝,刷日志 + 占资源。
 *
 * 测法:走 mutex 测试同款 mock 让 syncOnce 不真连服务端,直接用 EventEmitter 假冒 ws
 * 注入 client.ws,然后调用私有 disconnectWebSocket,断言 removeAllListeners 在 close 之前。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
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

describe('F2 — disconnectWebSocket removes listeners before close', () => {
  beforeEach(() => {
    // 不需要 fake timers
  });

  afterEach(() => {});

  it('disconnectWebSocket 在 ws.close() 之前先 removeAllListeners,避免触发 scheduleReconnect', () => {
    const db = setupTestDb();
    const client = new CloudSyncClient(db);

    // 自造 ws mock(EventEmitter 让 removeAllListeners 真起作用)
    const closeOrder: string[] = [];
    const ws = new EventEmitter() as EventEmitter & {
      close: (...args: unknown[]) => void;
      readyState: number;
    };
    // 用 spy 覆盖 EventEmitter.removeAllListeners,记录调用顺序
    const origRemove = ws.removeAllListeners.bind(ws);
    ws.removeAllListeners = ((event?: string | symbol) => {
      closeOrder.push('removeAllListeners');
      // 不传 event = 移除所有
      return event !== undefined ? origRemove(event as never) : origRemove();
    }) as typeof ws.removeAllListeners;

    ws.close = vi.fn(() => {
      closeOrder.push('close');
      // 模拟 ws 真实行为:close 后 emit 'close' 事件
      ws.emit('close', 1000, Buffer.from('test'));
    });
    ws.readyState = 1;

    // 给 ws 装一个 close handler;真正的 sync-client.ts 在 connectWebSocket 里注册了
    // 这个 handler,handler 会调 scheduleReconnect。这里我们模拟那个行为。
    const reconnectSpy = vi.fn();
    ws.on('close', () => {
      reconnectSpy();
    });

    // 注入 ws
    (client as unknown as { ws: typeof ws }).ws = ws;

    // 调用私有 disconnectWebSocket
    (client as unknown as { disconnectWebSocket(): void }).disconnectWebSocket();

    // 顺序断言:removeAllListeners 必须早于 close
    expect(closeOrder).toEqual(['removeAllListeners', 'close']);
    // 关键:即便 close 事件被 emit,reconnect handler 已被移走,不会被调用
    expect(reconnectSpy).not.toHaveBeenCalled();
    // ws 引用被清
    expect((client as unknown as { ws: unknown }).ws).toBeNull();
  });
});
