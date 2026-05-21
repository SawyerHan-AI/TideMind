/**
 * refreshTokenIfNeeded inflight Promise mutex 测试。
 *
 * 背景(CRITICAL):
 *   6+ 处 fire-and-forget caller(sync-client / mcp-router / strategy-push /
 *   reconciler 各路)在 access_token 接近过期时会近乎同时调用 refreshTokenIfNeeded。
 *   OAuth 2.1 rotating refresh-token:服务端只接受第一个 refresh_token,
 *   之后并发请求拿的是已被作废的老 refresh_token,服务端 400 → 老逻辑判作 permanent
 *   → cachedAuth 清空 → 用户被**无声登出**。
 *
 * 修复:加 inflight Promise mutex,3 路并发只发 1 次网络请求,
 * 大家拿同一个新 access_token。本测试锁三个不变量:
 *   1. 3 路并发 → fetch 调用**只 1 次**
 *   2. 3 个 caller 拿到同一个 access_token
 *   3. cachedAuth 未被清空(isLoggedIn 仍然为 true)
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

/**
 * 把"已经登录、access_token 5 分钟内过期"的状态种到 secureStore,然后用 initAuth
 * 让 auth-client.ts 把 cachedAuth 加载回内存。这是触发 refreshTokenIfNeeded 真正
 * 走刷新分支(而不是直接返回旧 token)的最简办法。
 */
function seedExpiringAuth(refreshToken: string): void {
  // expiresAt 1 秒后过期 → < now + 5min 缓冲区 → 必定走刷新分支
  const cachedAuth = {
    accessToken: 'old-access-token',
    refreshToken,
    userId: 'u-1',
    email: 'test@example.com',
    plan: 'free',
    expiresAt: Date.now() + 1_000,
    lastSyncedAt: null,
  };
  state.storage.set('TideMind::cloud-auth', Buffer.from(JSON.stringify(cachedAuth), 'utf-8'));
}

/** vi.resetModules 后加载 auth-client(每个测试干净状态,清掉 module-scope cachedAuth) */
async function loadAuthClient(): Promise<typeof import('../../client/electron/cloud/auth-client.js')> {
  vi.resetModules();
  return await import('../../client/electron/cloud/auth-client.js');
}

describe('refreshTokenIfNeeded inflight mutex (CRITICAL: rotating refresh-token)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    state.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-mutex-test-'));
    state.storage = new Map();
    state.fetchCalls = 0;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try { fs.rmSync(state.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('3 路并发 refreshTokenIfNeeded → fetch 只 1 次,3 个 caller 同一个 token,cachedAuth 不丢', async () => {
    seedExpiringAuth('refresh-token-v1');

    // Mock fetch:第一个调用返回 new tokens;之后任何调用模拟 OAuth 2.1
    // "refresh_token already used" 400 失败。
    // 关键:如果 mutex 失效,第二路 caller 会拿已作废的 refresh-token-v1 真打过去,
    // 拿到 400 → cachedAuth 被清空 → isLoggedIn=false。
    let resolveFirst!: (v: Response) => void;
    const firstResponse = new Promise<Response>(r => { resolveFirst = r; });

    globalThis.fetch = vi.fn(async () => {
      state.fetchCalls += 1;
      if (state.fetchCalls === 1) {
        return firstResponse;
      }
      // 任何"第 2 次或以后"的调用都说明 mutex 失效(老 refresh_token 又被打过)
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh_token already used' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const authClient = await loadAuthClient();
    authClient.initAuth();
    expect(authClient.isLoggedIn()).toBe(true);

    // 3 路并发触发 refresh
    const p1 = authClient.refreshTokenIfNeeded();
    const p2 = authClient.refreshTokenIfNeeded();
    const p3 = authClient.refreshTokenIfNeeded();

    // 此时 fetch 已经被调一次(发出请求后等回应),但还没 resolve。
    // 关键不变量:3 个 caller 应当都在等同一个 Promise,不会因为"老 token 还没过期但
    // 在 5min 缓冲区内"重复打第二个 fetch。
    // 给微任务一个 tick 让 mutex 设上、await 真正挂起。
    await Promise.resolve();
    await Promise.resolve();
    expect(state.fetchCalls).toBe(1);

    // 解开 first response:服务端给我们新 access + 新 refresh
    resolveFirst(new Response(JSON.stringify({
      access_token: 'new-access-token',
      refresh_token: 'refresh-token-v2',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // 不变量 1:fetch 始终只 1 次(微任务再排空一次保险)
    await Promise.resolve();
    expect(state.fetchCalls, 'fetch must be called exactly once for 3 concurrent callers').toBe(1);

    // 不变量 2:3 个 caller 拿到的 access_token 一致(都是新 token)
    expect(r1).toBe('new-access-token');
    expect(r2).toBe('new-access-token');
    expect(r3).toBe('new-access-token');

    // 不变量 3:cachedAuth 仍在(没被清空),refresh_token 已被 rotated
    expect(authClient.isLoggedIn()).toBe(true);
    const auth = authClient.getCloudAuth();
    expect(auth?.refreshToken).toBe('refresh-token-v2');
    expect(auth?.accessToken).toBe('new-access-token');
  });

  it('inflight 结束后,下一次 refreshTokenIfNeeded 必须重新发请求', async () => {
    seedExpiringAuth('refresh-token-A');

    globalThis.fetch = vi.fn(async () => {
      state.fetchCalls += 1;
      return new Response(JSON.stringify({
        access_token: `access-${state.fetchCalls}`,
        refresh_token: `refresh-${state.fetchCalls}`,
        expires_in: 1, // 1 秒过期 → 下次 refresh 必然继续走刷新分支
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;

    const authClient = await loadAuthClient();
    authClient.initAuth();

    const r1 = await authClient.refreshTokenIfNeeded();
    expect(r1).toBe('access-1');
    expect(state.fetchCalls).toBe(1);

    // 再次调用:旧 inflight 已 settle → mutex 应已清掉 → 第二次必须真发请求
    const r2 = await authClient.refreshTokenIfNeeded();
    expect(r2).toBe('access-2');
    expect(state.fetchCalls).toBe(2);
  });

  it('inflight 抛错(transient 5xx)后,mutex 仍会被清,下次仍能重试', async () => {
    seedExpiringAuth('refresh-token-X');

    globalThis.fetch = vi.fn(async () => {
      state.fetchCalls += 1;
      // 重试逻辑会再打一次同样 503:第 1 次 attempt + 退避后第 2 次 attempt 都 503
      // 最终 transient throw。
      return new Response('temporary outage', { status: 503 });
    }) as typeof globalThis.fetch;

    const authClient = await loadAuthClient();
    authClient.initAuth();

    // 第一次:期望抛 transient
    await expect(authClient.refreshTokenIfNeeded()).rejects.toThrow(/refresh_token transient/);
    // 503 内部会重试 1 次,所以 fetch 是 2(不是 1),但 mutex 仍只允许 1 个真实 caller 入场
    expect(state.fetchCalls).toBe(2);
    // 关键:登录态保留(不能被无声登出)
    expect(authClient.isLoggedIn()).toBe(true);

    // 第二次:换成 200 成功路径 — mutex 必须已经清掉,不然永远卡死
    globalThis.fetch = vi.fn(async () => {
      state.fetchCalls += 1;
      return new Response(JSON.stringify({
        access_token: 'recovered-access',
        refresh_token: 'recovered-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;

    const r2 = await authClient.refreshTokenIfNeeded();
    expect(r2).toBe('recovered-access');
  });
});
