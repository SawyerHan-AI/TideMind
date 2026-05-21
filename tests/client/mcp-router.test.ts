/**
 * tests/client/mcp-router.test.ts
 *
 * 覆盖 client/electron/cloud/mcp-router.ts 的 CloudMcpRouter:
 *  - isActive(): config.cloud.enabled + isLoggedIn 组合
 *  - isOnline(): 10s cache + fetch /health
 *  - handle(): online → forwardToCloud / offline → handleOffline
 *  - forwardToCloud(): token / 状态码 / JSON-RPC error 各种 fallback
 *  - handleOffline(): brain_digest → outbox / 其他 → 'offline' error
 *
 * 风险点:
 *  - 10s cache 不能因为重构悄悄变短(高频 fetch 可能让 cloud /health 被打爆)
 *  - 失败时必须 fallback 到 offline,不能让用户 brain_digest 丢数据
 *  - brain_digest 必须无 token / 网络中断时入 outbox
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isLoggedInMock = vi.fn();
const getCloudBaseUrlMock = vi.fn();
const refreshTokenIfNeededMock = vi.fn();
const enqueueOutboxMock = vi.fn();
const getConfigMock = vi.fn();

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  isLoggedIn: isLoggedInMock,
  getCloudBaseUrl: getCloudBaseUrlMock,
  refreshTokenIfNeeded: refreshTokenIfNeededMock,
}));

vi.mock('../../client/electron/cloud/outbox.js', () => ({
  enqueueOutbox: enqueueOutboxMock,
}));

vi.mock('@server/config.js', () => ({
  getConfig: getConfigMock,
}));

const { CloudMcpRouter } = await import('../../client/electron/cloud/mcp-router.js');

// Stub repo + db (不会被调用)
const stubRepo = {} as Parameters<typeof CloudMcpRouter['prototype']['constructor']>[0];
const stubDb = { name: 'stub-db' } as Parameters<typeof CloudMcpRouter['prototype']['constructor']>[1];

// 模块级 onlineCache 跨 case 串扰。每个 case 用单调递增的 baseTime
// 加 11s 推进让 cache 必然失效。
let caseClock = Date.parse('2026-05-21T00:00:00Z');

describe('CloudMcpRouter', () => {
  let router: InstanceType<typeof CloudMcpRouter>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    router = new CloudMcpRouter(stubRepo, stubDb);
    isLoggedInMock.mockReset();
    getCloudBaseUrlMock.mockReset().mockReturnValue('https://cloud.test');
    refreshTokenIfNeededMock.mockReset();
    enqueueOutboxMock.mockReset();
    getConfigMock.mockReset();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // 跨 case 给 caseClock + 60s,确保上一次 case 设的 onlineCache.checkedAt
    // 在新 case 已 > 10s 前,cache 必失效
    caseClock += 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(caseClock);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('isActive', () => {
    it('cloud.enabled=true + isLoggedIn=true → true', () => {
      getConfigMock.mockReturnValue({ cloud: { enabled: true } });
      isLoggedInMock.mockReturnValue(true);
      expect(router.isActive()).toBe(true);
    });

    it('cloud.enabled=false → false', () => {
      getConfigMock.mockReturnValue({ cloud: { enabled: false } });
      isLoggedInMock.mockReturnValue(true);
      expect(router.isActive()).toBe(false);
    });

    it('cloud 字段缺失(?.enabled 走 ??=false) → false', () => {
      getConfigMock.mockReturnValue({});
      isLoggedInMock.mockReturnValue(true);
      expect(router.isActive()).toBe(false);
    });

    it('isLoggedIn=false → false', () => {
      getConfigMock.mockReturnValue({ cloud: { enabled: true } });
      isLoggedInMock.mockReturnValue(false);
      expect(router.isActive()).toBe(false);
    });
  });

  describe('isOnline', () => {
    it('fetch /health 返回 ok → true', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));
      // 让 onlineCache 过期(advance > 10s)
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)
      const r = await router.isOnline();
      expect(r).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://cloud.test/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('fetch /health 返回 5xx → false', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)
      const r = await router.isOnline();
      expect(r).toBe(false);
    });

    it('fetch 抛错(网络断) → false', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)
      const r = await router.isOnline();
      expect(r).toBe(false);
    });

    it('10s 内重复调用走 cache 不再 fetch', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)
      const r1 = await router.isOnline();
      // cache valid for 10s
      vi.advanceTimersByTime(9_000);
      const r2 = await router.isOnline();
      // 第二次不应有新 fetch 调用
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });

    it('超过 10s 缓存过期,重新 fetch', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)
      await router.isOnline();
      // 把 systemTime 直接跳到 +11s,绕开 fake timer queue
      vi.setSystemTime(caseClock + 11_000);
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
      const r2 = await router.isOnline();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(r2).toBe(false);
    });

    it('F7(audit-7): 并发 isOnline 共享 inflight,只发 1 次 fetch', async () => {
      // 让 fetch 慢一点(不立即 resolve),3 个并发调用都得共享同一个 inflight。
      let resolveFetch: (r: Response) => void = () => {};
      const pending = new Promise<Response>(res => { resolveFetch = res; });
      fetchSpy.mockReturnValueOnce(pending);

      const p1 = router.isOnline();
      const p2 = router.isOnline();
      const p3 = router.isOnline();

      // 3 个并发调用还在等同一个 fetch,只该有 1 个 fetch 已发出
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      resolveFetch(new Response('', { status: 200 }));
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(true);
      // 整个过程总 fetch 数依然是 1
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('handle', () => {
    it('online=true → forwardToCloud', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response('', { status: 200 })) // /health
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ); // /mcp
      refreshTokenIfNeededMock.mockResolvedValueOnce('tk_abc');
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)

      const result = await router.handle('brain_recall', { query: 'x' });
      expect(result).toEqual({ ok: true });
    });

    it('online=false + brain_digest → enqueueOutbox', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
      enqueueOutboxMock.mockReturnValueOnce('ob-123');
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)

      const result = await router.handle('brain_digest', { content: 'data' });
      expect(enqueueOutboxMock).toHaveBeenCalledWith(stubDb, 'digest', { content: 'data' });
      expect(result).toMatchObject({
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('queued'),
          }),
        ],
      });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.status).toBe('queued');
      expect(parsed.outbox_id).toBe('ob-123');
    });

    it('online=false + brain_recall → 返回 offline error 不抛', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)

      const result = await router.handle('brain_recall', { query: 'x' });
      expect(result).toMatchObject({
        error: 'offline',
        message: expect.stringContaining('offline'),
      });
      expect(enqueueOutboxMock).not.toHaveBeenCalled();
    });

    it('online=false + brain_prepare → 返回 offline error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)

      const result = await router.handle('brain_prepare', {});
      expect(result).toMatchObject({ error: 'offline' });
    });
  });

  describe('forwardToCloud fallback', () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 })); // /health
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)
    });

    it('refreshTokenIfNeeded 返回 null → 降级 handleOffline', async () => {
      refreshTokenIfNeededMock.mockResolvedValueOnce(null);
      enqueueOutboxMock.mockReturnValueOnce('ob-x');

      const result = await router.handle('brain_digest', { x: 1 });
      expect(enqueueOutboxMock).toHaveBeenCalled();
      // 第二个 fetch 调用(forwardToCloud /mcp)不应发生
      expect(fetchSpy).toHaveBeenCalledTimes(1); // 只有 /health
      expect(result).toMatchObject({ content: expect.any(Array) });
    });

    it('cloud /mcp 返回 5xx → 降级 handleOffline', async () => {
      refreshTokenIfNeededMock.mockResolvedValueOnce('tk');
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 })); // /mcp 503

      const result = await router.handle('brain_recall', { query: 'q' });
      expect(result).toMatchObject({ error: 'offline' });
    });

    it('cloud /mcp 返回 4xx → 降级 handleOffline', async () => {
      refreshTokenIfNeededMock.mockResolvedValueOnce('tk');
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));

      const result = await router.handle('brain_recall', { query: 'q' });
      expect(result).toMatchObject({ error: 'offline' });
    });

    it('cloud /mcp 返回 200 但 body 含 error → 降级 handleOffline', async () => {
      refreshTokenIfNeededMock.mockResolvedValueOnce('tk');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'internal', code: -32000 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const result = await router.handle('brain_recall', { query: 'q' });
      expect(result).toMatchObject({ error: 'offline' });
    });

    it('cloud /mcp 返回 200 + result → 透传 result', async () => {
      refreshTokenIfNeededMock.mockResolvedValueOnce('tk_real');
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { content: [{ type: 'text', text: 'hi' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const result = await router.handle('brain_recall', { query: 'q' });
      expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    });

    it('forwardToCloud 发请求带 Authorization Bearer + JSON-RPC 包装', async () => {
      refreshTokenIfNeededMock.mockResolvedValueOnce('tk_z');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await router.handle('brain_recall', { query: 'q', limit: 5 });
      // 第二次 fetch(/mcp)
      const mcpCall = fetchSpy.mock.calls[1];
      expect(mcpCall[0]).toBe('https://cloud.test/mcp');
      const opts = mcpCall[1] as RequestInit;
      expect(opts.method).toBe('POST');
      expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer tk_z');
      expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      const body = JSON.parse(opts.body as string);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('tools/call');
      expect(body.params.name).toBe('brain_recall');
      expect(body.params.arguments).toEqual({ query: 'q', limit: 5 });
    });
  });

  describe('handleOffline edge', () => {
    it('未知 toolName + offline → 返回 offline error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)

      const result = await router.handle('unknown_tool', {});
      expect(result).toMatchObject({ error: 'offline' });
      expect(enqueueOutboxMock).not.toHaveBeenCalled();
    });

    it('brain_digest with empty args → 仍 enqueueOutbox', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
      enqueueOutboxMock.mockReturnValueOnce('ob-empty');
      // 已在 beforeEach 推进 60s,这里 no-op(保留兼容性)

      const result = await router.handle('brain_digest', {});
      expect(enqueueOutboxMock).toHaveBeenCalledWith(stubDb, 'digest', {});
      expect(result).toMatchObject({ content: expect.any(Array) });
    });
  });
});
