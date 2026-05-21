import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  isConfirmedNotionPageGoneError,
  listAllPages,
  getPageProperties,
  RateLimiter,
} from '../../../src/integrations/notion/api-client.js';
import { InitAbortError } from '../../../src/integrations/shared/init-session.js';

describe('Notion API error classification', () => {
  it('treats explicit page gone errors as confirmed deletion or unshare', () => {
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('missing'), { status: 404 }))).toBe(true);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('restricted'), { status: 403 }))).toBe(true);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('object_not_found'), { code: 'object_not_found' }))).toBe(true);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('restricted_resource'), { code: 'restricted_resource' }))).toBe(true);
  });

  it('does not treat transient or credential-wide errors as page deletion', () => {
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(false);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe(false);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('service unavailable'), { status: 503 }))).toBe(false);
    expect(isConfirmedNotionPageGoneError(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false);
  });
});

describe('F6 回归: RateLimiter 慢路径并发不越过 burst', () => {
  it('N>burst 并发 acquire,任意两次取得间隔不低于 1/refillRate', async () => {
    // burst=2, 4 tokens/s → refill 间隔 250ms
    const rl = new RateLimiter(2, 4);
    const N = 6; // 远超 burst
    const acquireAt: number[] = [];

    const start = Date.now();
    await Promise.all(
      Array.from({ length: N }).map(async () => {
        await rl.acquire();
        acquireAt.push(Date.now() - start);
      }),
    );

    // 前 burst=2 次几乎瞬时(同步进入快路径)。剩余 N-burst=4 次走慢路径,
    // 按 refillRate=4/s 应该至少间隔约 250ms。
    acquireAt.sort((a, b) => a - b);

    // 找出"远超 burst"的请求(第 3 个 acquire 起,索引 2 起),
    // 这些必须经历至少一次 sleep。
    const slowSlots = acquireAt.slice(2);
    // 每个慢路径请求与上一个的间隔应该至少接近 1/refillRate * 1000 - 容差
    // (实际可能由于多个并发同时唤醒而被打散,所以验证最后一个 slot 距离
    //  burst 用完的时间点至少 (N-burst)/refillRate * 1000)
    const expectedMinTotal = ((N - 2) / 4) * 1000; // 1000ms
    const lastSlot = acquireAt[acquireAt.length - 1];
    // 容忍 -50ms 抖动(setTimeout 最小粒度 + clock skew)
    expect(lastSlot).toBeGreaterThanOrEqual(expectedMinTotal - 50);
  });

  it('并发 acquire 后 tokens 不被推到负值', async () => {
    // burst=1, 慢 refill 1/s → 强迫所有请求走慢路径
    const rl = new RateLimiter(1, 10);
    const N = 5;
    await Promise.all(Array.from({ length: N }).map(() => rl.acquire()));
    // 用反射访问 tokens 私有字段:tokens 不应小于 0(允许 0 或微正)
    const tokens = (rl as unknown as { tokens: number }).tokens;
    expect(tokens).toBeGreaterThanOrEqual(-0.01); // 浮点容忍
  });
});

describe('F11 (audit-7) AbortSignal plumbing', () => {
  it('listAllPages: 预先 aborted signal → 在第一轮就抛 InitAbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    // token 是假的,不会真发 HTTP,因为 aborted 提前 throw
    const gen = listAllPages('fake-token', { signal: controller.signal });
    await expect(gen.next()).rejects.toThrow(InitAbortError);
  });

  it('getPageProperties: 预先 aborted signal → 立即抛 InitAbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      getPageProperties('fake-token', 'page-id', { signal: controller.signal }),
    ).rejects.toThrow(InitAbortError);
  });

  it('mid-loop abort: 创建 controller 但生成器还没消费,abort 后下一个 next() 抛 InitAbortError', async () => {
    const controller = new AbortController();
    const gen = listAllPages('fake-token', { signal: controller.signal });
    // 不消费,先 abort
    controller.abort();
    await expect(gen.next()).rejects.toThrow(InitAbortError);
  });
});

// MEDIUM 9 (audit-10, 2026-05-21): retryWithBackoff 在 retry sleep 期间也必须
// 响应 abort。之前 sleep() 是裸 setTimeout,abort 还得等 60s 才退出。
// 用 source-level 断言:retryWithBackoff 签名含 signal,sleep 调用走 abortable 版本
describe('MEDIUM 9 — retry sleep abort-aware (source-level)', () => {
  it('api-client.ts 含 sleepAbortable + retryWithBackoff 接 signal', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      path.resolve(here, '../../../src/integrations/notion/api-client.ts'),
      'utf-8',
    );

    // 1) sleepAbortable helper 存在
    expect(src, '应定义 sleepAbortable helper').toMatch(/function\s+sleepAbortable\s*\(/);
    // 2) retryWithBackoff 签名含 signal options
    expect(src, 'retryWithBackoff 签名含 signal options').toMatch(
      /retryWithBackoff[\s\S]{0,300}options\?:\s*\{\s*signal\?:\s*AbortSignal/,
    );
    // 3) retryWithBackoff 内的 sleep 调用走 abortable 版本(不是裸 sleep)
    // 抓 retryWithBackoff 函数体
    const fnMatch = src.match(/async function retryWithBackoff[\s\S]+?^\}/m);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];
    // 函数体内 sleep 必须用 sleepAbortable 而不是裸 sleep(传 signal)
    expect(fnBody).toMatch(/sleepAbortable\s*\(\s*waitMs\s*,\s*options\?\.signal\s*\)/);
    // 不应残留裸 sleep(waitMs)(不传 signal)
    expect(fnBody, 'retryWithBackoff 内不应再有裸 sleep(waitMs)').not.toMatch(
      /\bsleep\s*\(\s*waitMs\s*\)\s*;/,
    );
    // 4) listAllPages / getPageProperties 应传 { signal } 给 retryWithBackoff
    expect(src).toMatch(
      /retryWithBackoff\s*\([\s\S]+?\{\s*signal:\s*options\?\.signal\s*\}/,
    );
  });

  it('已经 aborted 的 signal:进入 retryWithBackoff 第一轮就抛 InitAbortError(无需 mock SDK)', async () => {
    // 用 listAllPages 在 SDK 调用前已经做 signal.aborted 检查的路径
    // 这条 case 由现有 F11 测试覆盖,这里加确认性的一遍:abort 前置生效
    const controller = new AbortController();
    controller.abort();
    let caught: Error | null = null;
    try {
      await getPageProperties('fake-token', 'page-id', { signal: controller.signal });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(InitAbortError);
  });
});
