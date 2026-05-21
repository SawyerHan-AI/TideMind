/**
 * LOW 12 (audit-10, 2026-05-21): makeInflight helper 单元测试。
 * 覆盖并发去重 / finally 清空 / 异常路径 / factory 同步抛错。
 */
import { describe, it, expect, vi } from 'vitest';
import { makeInflight } from '../../src/utils/inflight.js';

describe('makeInflight — concurrent dedup', () => {
  it('3 个并发 run() 返回同一个 promise,factory 只跑一次', async () => {
    const inflight = makeInflight<string>();
    const factory = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'result';
    });

    const [a, b, c] = await Promise.all([
      inflight.run(factory),
      inflight.run(factory),
      inflight.run(factory),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe('result');
    expect(b).toBe('result');
    expect(c).toBe('result');
  });

  it('inflight 完成后,下一次 run 触发新 factory', async () => {
    const inflight = makeInflight<number>();
    const factory = vi.fn(async () => 42);

    await inflight.run(factory);
    expect(factory).toHaveBeenCalledTimes(1);

    await inflight.run(factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('isRunning:在 factory pending 期间 true,完成后 false', async () => {
    const inflight = makeInflight<void>();
    let resolveFactory: () => void = () => {};
    const pending = new Promise<void>(r => { resolveFactory = r; });

    expect(inflight.isRunning).toBe(false);
    const p = inflight.run(() => pending);
    expect(inflight.isRunning).toBe(true);

    resolveFactory();
    await p;
    expect(inflight.isRunning).toBe(false);
  });
});

describe('makeInflight — error paths', () => {
  it('factory reject → 所有并发 caller 都拿到同一 reject', async () => {
    const inflight = makeInflight<string>();
    const factory = vi.fn(async () => {
      throw new Error('boom');
    });

    const [a, b, c] = await Promise.allSettled([
      inflight.run(factory),
      inflight.run(factory),
      inflight.run(factory),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    for (const r of [a, b, c]) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect((r as PromiseRejectedResult).reason.message).toBe('boom');
    }
  });

  it('factory reject 后 isRunning=false,下一次 run 重新触发', async () => {
    const inflight = makeInflight<string>();
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce('ok');

    await expect(inflight.run(factory as any)).rejects.toThrow('first fail');
    expect(inflight.isRunning).toBe(false);
    await expect(inflight.run(factory as any)).resolves.toBe('ok');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('factory 同步抛错也被 catch,reject promise + 清 inflight', async () => {
    const inflight = makeInflight<string>();
    const factory = (() => {
      throw new Error('sync boom');
    }) as () => Promise<string>;

    await expect(inflight.run(factory)).rejects.toThrow('sync boom');
    expect(inflight.isRunning).toBe(false);
  });
});

describe('makeInflight — independent instances', () => {
  it('两个不同 inflight 实例互不干扰', async () => {
    const a = makeInflight<number>();
    const b = makeInflight<number>();
    const factoryA = vi.fn(async () => 1);
    const factoryB = vi.fn(async () => 2);

    const [ra, rb] = await Promise.all([a.run(factoryA), b.run(factoryB)]);
    expect(ra).toBe(1);
    expect(rb).toBe(2);
    expect(factoryA).toHaveBeenCalledTimes(1);
    expect(factoryB).toHaveBeenCalledTimes(1);
  });
});
