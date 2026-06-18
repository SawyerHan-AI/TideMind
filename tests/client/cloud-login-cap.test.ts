/**
 * MEDIUM 8 (audit-10, 2026-05-21):
 *   cloud:login IPC handler 在 email/password 超 cap 时必须 return
 *   `{ success: false, error: ... }`,而不是 throw。renderer 端无需 try/catch
 *   就能拿到结构化失败。
 *
 *   F5 契约裁剪追加(2026-06):成功只返回 { success: true }(绝不外泄 token);
 *   login 真失败(网络/认证)也走 { success: false, error },不再 throw——
 *   与校验失败分支统一结构化返回,且与 api-contract 声明对齐。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Handler = (e: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

const { handlers, loginMock, electronMock } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    loginMock: vi.fn(),
    electronMock: {
      ipcMain: {
        handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
      },
      BrowserWindow: { getAllWindows: () => [] },
    },
  };
});

vi.mock('electron', () => electronMock);
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

// auth-client 是 dynamic import,这里 mock 它,避免触发真 secure-store
vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  login: loginMock,
}));

// reload / outbox-diagnostics 模块也要 mock 掉,避免 module-init 副作用
vi.mock('../../src/config.js', () => ({
  getConfig: () => ({}),
  reloadConfig: vi.fn(),
}));
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../client/electron/cloud/outbox.js', () => ({
  getOutboxDiagnostics: vi.fn(),
}));

import { registerCloudHandlers } from '../../client/electron/ipc/cloud.js';

describe('MEDIUM 8 — cloud:login cap returns { success: false, error } (not throw)', () => {
  beforeEach(() => {
    handlers.clear();
    loginMock.mockReset();
    registerCloudHandlers();
  });

  it('email > 254 字符 → 返回 { success: false, error }(不抛)', async () => {
    const loginHandler = handlers.get('cloud:login');
    expect(loginHandler).toBeDefined();

    const result = await loginHandler!(null, 'x'.repeat(255), 'pw');
    expect(result).toEqual({ success: false, error: 'email or password too long' });
    expect(loginMock, 'cap 阻止 login 被调').not.toHaveBeenCalled();
  });

  it('password > 256 字符 → 返回 { success: false, error }(不抛)', async () => {
    const loginHandler = handlers.get('cloud:login');
    const result = await loginHandler!(null, 'a@b.com', 'p'.repeat(257));
    expect(result).toEqual({ success: false, error: 'email or password too long' });
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('email 不是 string → 返回 { success: false, error }', async () => {
    const loginHandler = handlers.get('cloud:login');
    const result = await loginHandler!(null, 12345, 'pw');
    expect(result).toEqual({ success: false, error: 'email and password must be strings' });
    expect(loginMock).not.toHaveBeenCalled();
  });

  // 契约裁剪(F5):成功时只返回 { success: true },**绝不**把 CloudAuth 里的
  // accessToken / refreshToken 跨 IPC 送进 renderer。
  it('合法长度 → 调用 login(),只返回 { success: true }(不含 token)', async () => {
    const loginHandler = handlers.get('cloud:login');
    loginMock.mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r', email: 'x@y' });
    const result = await loginHandler!(null, 'x@y', 'pw');
    expect(loginMock).toHaveBeenCalledWith('x@y', 'pw');
    expect(result).toEqual({ success: true });
    // 显式断言 token 不外泄
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
  });

  // 契约裁剪(F5):login 真失败时也走 { success: false, error },与校验失败分支同形,
  // renderer 不用为这个 IPC 单独写 try/catch。
  it('login() 真抛(认证错)→ handler 返回 { success: false, error }(不再 throw)', async () => {
    const loginHandler = handlers.get('cloud:login');
    loginMock.mockRejectedValueOnce(new Error('Invalid credentials'));
    const result = await loginHandler!(null, 'x@y', 'pw');
    expect(result).toEqual({ success: false, error: 'Invalid credentials' });
  });
});
