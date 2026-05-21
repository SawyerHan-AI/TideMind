/**
 * tests/client/updater-scheduler.test.ts
 *
 * 覆盖 client/electron/updater/scheduler.ts。该模块只 export 一个函数
 * `scheduleUpdateChecks(checkFn)`，职责是:
 *  - 启动 5s 后触发首次 checkFn (reason='startup')
 *  - 之后每 4h 触发 checkFn (reason='periodic')
 *  - 返回 { stop } 用于取消未触发的 timer + 拒绝触发已 stopped 后的回调
 *  - checkFn 抛错被 catch 不冒泡(避免单次失败拖垮整个调度)
 *
 * 风险点(backlog / Round 4 audit):
 *  - 5s 启动延迟改造后(从 30s),不能在 stop() 之后才触发 startup
 *  - 4h 周期不能因为 checkFn await 阻塞而漂移
 *  - 多次 stop() 必须幂等
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// scheduler.ts 在 import 时只引入 logger,不需要 mock electron——独立于客户端运行时
const { scheduleUpdateChecks } = await import('../../client/electron/updater/scheduler.js');

const INITIAL_DELAY_MS = 5_000;
const INTERVAL_MS = 4 * 60 * 60 * 1000;

describe('updater scheduler — scheduleUpdateChecks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('5 秒后触发首次 startup 检查', async () => {
    const checkFn = vi.fn(async () => undefined);
    const handle = scheduleUpdateChecks(checkFn);

    expect(checkFn).not.toHaveBeenCalled();
    // 4_999ms 还不能触发
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(checkFn).not.toHaveBeenCalled();
    // 跨 5s 触发
    await vi.advanceTimersByTimeAsync(1);
    expect(checkFn).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('启动后每 4 小时触发一次 periodic 检查', async () => {
    const checkFn = vi.fn(async () => undefined);
    const handle = scheduleUpdateChecks(checkFn);

    // 跨过初始 + 第一次周期 = 5s + 4h
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(checkFn).toHaveBeenCalledTimes(1); // startup

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(checkFn).toHaveBeenCalledTimes(2); // periodic#1

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(checkFn).toHaveBeenCalledTimes(3); // periodic#2

    handle.stop();
  });

  it('stop() 后 startup 不再触发', async () => {
    const checkFn = vi.fn(async () => undefined);
    const handle = scheduleUpdateChecks(checkFn);

    // 4s 内 stop
    await vi.advanceTimersByTimeAsync(4_000);
    handle.stop();

    // 推进到原本 5s 触发点之后
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(checkFn).not.toHaveBeenCalled();
  });

  it('stop() 后 periodic 不再触发', async () => {
    const checkFn = vi.fn(async () => undefined);
    const handle = scheduleUpdateChecks(checkFn);

    // 跨第一次 startup + 第一次 periodic
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS);
    expect(checkFn).toHaveBeenCalledTimes(2);

    handle.stop();

    // 再推 2 个周期都不应触发
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  it('多次 stop() 幂等不抛错', () => {
    const checkFn = vi.fn(async () => undefined);
    const handle = scheduleUpdateChecks(checkFn);

    expect(() => {
      handle.stop();
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it('checkFn 抛错时不冒泡到调度器(下一次周期仍会触发)', async () => {
    const error = new Error('network down');
    let callCount = 0;
    const checkFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw error;
    });

    const handle = scheduleUpdateChecks(checkFn);

    // 触发 startup（会抛错）
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(checkFn).toHaveBeenCalledTimes(1);
    // 抛错被 safeCheck 内部 catch,不会让 setInterval 链断裂
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(checkFn).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('checkFn 同步抛错也不冒泡', async () => {
    const checkFn = vi.fn(() => {
      throw new Error('synchronous throw');
    }) as unknown as () => Promise<void>;

    const handle = scheduleUpdateChecks(checkFn);

    // 该模块用 await checkFn(),同步抛错会被 Promise 化后 catch
    await expect(
      vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS),
    ).resolves.not.toThrow();
    expect(checkFn).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('checkFn 返回 long-running Promise 不阻塞下一次周期 timer', async () => {
    let resolveFirst: () => void = () => {};
    const checkFn = vi.fn(async () => {
      // 第一次 await 永不 resolve,模拟 hang 的 update check
      if (checkFn.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    const handle = scheduleUpdateChecks(checkFn);

    // startup 触发,但 await 卡住
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(checkFn).toHaveBeenCalledTimes(1);

    // setInterval 是基于 wall-clock 的,即便上一个 await 没 resolve 也会按时触发下一个
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(checkFn).toHaveBeenCalledTimes(2);

    resolveFirst();
    handle.stop();
  });
});
