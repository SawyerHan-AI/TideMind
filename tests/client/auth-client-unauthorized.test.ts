/**
 * 云端返回 401 时强制刷新（设计 primary-device-acceptance-fixes §4.4 c、§10.6）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- 共享 mock 状态 --------------------------------------------------------

interface MockState {
  tmpDir: string;
  storage: Map<string, Buffer>;
  // fetch 调用计数,测 mutex 关键不变量
  fetchCalls: number;
}

const state: MockState = {
  tmpDir: '',
  storage: new Map(),
  fetchCalls: 0,
};

// electron mock — auth-client.ts 顶层 import 'electron'(safeStorage 只在 legacy
// 路径用,本测试走 mocked secure-store,所以 safeStorage 给最低限度 stub 就够了)。
// 注意双路径 mock,理由参见 secure-store.test.ts:vitest 不会自动把 bare 'electron'
// mock 应用到 client/node_modules/electron/index.js 的解析结果。
const electronMock = {
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(() => Buffer.alloc(0)),
    decryptString: vi.fn(() => ''),
  },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  app: { getPath: () => state.tmpDir },
};
vi.mock('electron', () => electronMock);
vi.mock('../../client/node_modules/electron/index.js', () => electronMock);

// secure-store mock:每个 (service, account) 用 Map 模拟 keychain。
// isUsingNative=false 让 migrateLegacyAuthIfNeeded 直接 short-circuit。
vi.mock('../../client/electron/cloud/secure-store.js', () => ({
  secureStore: {
    isUsingNative: () => false,
    isAvailable: () => true,
    set: (s: string, a: string, v: Buffer) => { state.storage.set(`${s}::${a}`, Buffer.from(v)); },
    get: (s: string, a: string) => state.storage.get(`${s}::${a}`) ?? null,
    delete: (s: string, a: string) => { state.storage.delete(`${s}::${a}`); },
  },
}));

vi.mock('../../src/config.js', () => ({
  getDataDir: () => state.tmpDir,
  getConfig: () => ({ general: { data_dir: state.tmpDir }, cloud: { server_url: 'https://cloud.test.example' } }),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// --- 测试主体 --------------------------------------------------------------

/** 已登录，访问令牌在本机看来还有 50 分钟才到期（不会走到期刷新）。 */
function seedValidAuth(refreshToken = 'rt-1'): void {
  state.storage.set('TideMind::cloud-auth', Buffer.from(JSON.stringify({
    accessToken: 'access-1', refreshToken, userId: 'u-1', email: 'starsea@example.test', plan: 'free',
    expiresAt: Date.now() + 50 * 60_000, lastSyncedAt: null,
  }), 'utf-8'));
}
async function loadAuthClient(): Promise<typeof import('../../client/electron/cloud/auth-client.js')> {
  vi.resetModules();
  const mod = await import('../../client/electron/cloud/auth-client.js');
  mod.initAuth();
  return mod;
}
const tokens = (n: number) => new Response(JSON.stringify({ access_token: `access-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 }), { status: 200 });

describe('reportUnauthorized: a 401 from the cloud forces one real refresh', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    state.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-unauthorized-test-'));
    state.storage = new Map();
    state.fetchCalls = 0;
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    fs.rmSync(state.tmpDir, { recursive: true, force: true });
  });
  const respond = (make: () => Response | Promise<Response>) => {
    globalThis.fetch = vi.fn(async () => { state.fetchCalls++; return make(); }) as unknown as typeof fetch;
  };

  it('the cloud rejects the refresh: the session is cleared and the listener runs once', async () => {
    seedValidAuth();
    const auth = await loadAuthClient();
    const cleared = vi.fn();
    auth.setAuthClearedListener(cleared);
    respond(() => new Response(JSON.stringify({ error: 'Refresh token revoked' }), { status: 401 }));
    expect(await auth.refreshTokenIfNeeded()).toBe('access-1');       // 本机认为未到期：不发请求
    expect(state.fetchCalls).toBe(0);
    expect(await auth.reportUnauthorized()).toBe('signed_out');
    expect(state.fetchCalls).toBe(1);
    expect(auth.isLoggedIn()).toBe(false);
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(await auth.reportUnauthorized()).toBe('unchanged');        // 已登出：不再请求
    expect(state.fetchCalls).toBe(1);
  });

  it('the refresh succeeds: stays signed in with the new tokens', async () => {
    seedValidAuth();
    const auth = await loadAuthClient();
    respond(() => tokens(2));
    expect(await auth.reportUnauthorized()).toBe('refreshed');
    expect(auth.isLoggedIn()).toBe(true);
    expect(await auth.refreshTokenIfNeeded()).toBe('access-2');
  });

  it.each([
    ['a network error', () => { throw new Error('offline'); }],
    ['a server error', () => new Response('boom', { status: 503 })],
  ])('%s keeps the session', async (_name, make) => {
    seedValidAuth();
    const auth = await loadAuthClient();
    respond(make as () => Response);
    expect(await auth.reportUnauthorized()).toBe('unchanged');
    expect(auth.isLoggedIn()).toBe(true);
  }, 30_000);

  it('is throttled to one refresh per minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    seedValidAuth();
    const auth = await loadAuthClient();
    let n = 1;
    respond(() => tokens(++n));
    expect(await auth.reportUnauthorized()).toBe('refreshed');
    expect(await auth.reportUnauthorized()).toBe('unchanged');
    expect(state.fetchCalls).toBe(1);
    vi.setSystemTime(new Date('2026-11-20T00:01:01Z'));
    expect(await auth.reportUnauthorized()).toBe('refreshed');
    expect(state.fetchCalls).toBe(2);
  });

  it('concurrent reports and an expiry refresh share one request (a second submission would trip reuse detection)', async () => {
    seedValidAuth();
    const auth = await loadAuthClient();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    respond(async () => { await gate; return tokens(2); });
    const a = auth.reportUnauthorized();
    const b = auth.reportUnauthorized();
    auth.updateCloudAuth({ expiresAt: Date.now() + 1000 });            // 让到期刷新也想发请求
    const c = auth.refreshTokenIfNeeded();
    release();
    expect(await a).toBe('refreshed');
    expect(await b).toBe('refreshed');
    expect(await c).toBe('access-2');
    expect(state.fetchCalls).toBe(1);
  });

  it('noteUnauthorized only reacts to 401', async () => {
    seedValidAuth();
    await loadAuthClient();
    const { noteUnauthorized } = await import('../../client/electron/cloud/unauthorized.js');
    respond(() => tokens(2));
    noteUnauthorized(403); noteUnauthorized(500); noteUnauthorized(200);
    await new Promise(r => setTimeout(r, 10));
    expect(state.fetchCalls).toBe(0);
    noteUnauthorized(401);
    await new Promise(r => setTimeout(r, 10));
    expect(state.fetchCalls).toBe(1);
  });

  it('signing out asks the cloud with a fresh token when the cached one has expired', async () => {
    seedValidAuth();
    const auth = await loadAuthClient();
    auth.updateCloudAuth({ expiresAt: Date.now() - 1000 });
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(`${String(url).replace('https://cloud.test.example', '')} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ''}`.trim());
      return String(url).endsWith('/auth/token') ? tokens(2) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await auth.logout();
    expect(seen).toEqual(['/auth/token', '/auth/logout Bearer access-2']);
    expect(auth.isLoggedIn()).toBe(false);
  });

  it('a refresh answered after the user signed in again does not overwrite the new sign-in', async () => {
    seedValidAuth('rt-old');
    const auth = await loadAuthClient();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/auth/token')) { await gate; return tokens(9); }
      if (u.endsWith('/auth/login')) return new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'rt-new', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ user: { id: 'u-2', email: 'datapilot@example.test', plan: 'pro' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const pending = auth.reportUnauthorized();
    await auth.login('datapilot@example.test', 'DataPilot-pass-1');
    release();
    await pending;
    expect(auth.getCloudAuth()).toMatchObject({ accessToken: 'access-new', refreshToken: 'rt-new', email: 'datapilot@example.test' });
  });

  it('a rejected refresh of the previous sign-in does not sign the new one out', async () => {
    seedValidAuth('rt-old');
    const auth = await loadAuthClient();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/auth/token')) { await gate; return new Response('{}', { status: 401 }); }
      if (u.endsWith('/auth/login')) return new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'rt-new', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ user: { id: 'u-2', email: 'datapilot@example.test' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const pending = auth.reportUnauthorized();
    await auth.login('datapilot@example.test', 'DataPilot-pass-1');
    release();
    await pending;
    expect(auth.isLoggedIn()).toBe(true);
    expect(auth.getCloudAuth()?.accessToken).toBe('access-new');
  });
});
