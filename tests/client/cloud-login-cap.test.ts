/**
 * MEDIUM 8 (audit-10, 2026-05-21):
 *   cloud:login IPC handler 在 email/password 超 cap 时必须 return
 *   `{ success: false, error: ... }`,而不是 throw。renderer 端无需 try/catch
 *   就能拿到结构化失败。
 *
 *   real login(网络/认证失败)仍然 throw —— 已有的 renderer 异常处理覆盖。
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

  it('合法长度 → 透传给 login(),返回 CloudAuth', async () => {
    const loginHandler = handlers.get('cloud:login');
    loginMock.mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r', email: 'x@y' });
    const result = await loginHandler!(null, 'x@y', 'pw');
    expect(loginMock).toHaveBeenCalledWith('x@y', 'pw');
    expect(result).toMatchObject({ accessToken: 'a', email: 'x@y' });
  });

  // 反向断言:login 真失败时仍然 throw(renderer 已有兜底)
  it('login() 真抛(认证错)→ handler 仍 throw,不假装 return', async () => {
    const loginHandler = handlers.get('cloud:login');
    loginMock.mockRejectedValueOnce(new Error('Invalid credentials'));
    await expect(loginHandler!(null, 'x@y', 'pw')).rejects.toThrow(/Invalid credentials/);
  });
});
