/**
 * SessionManager 单元测试
 *
 * 测试范围：状态机转换、abort 等真停、并发互斥、订阅事件。
 * 不依赖 better-sqlite3、不依赖 Electron。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InitSessionManager,
  InitAbortError,
  type InitSessionContext,
  type InitSessionSnapshot,
} from '../../src/integrations/shared/init-session.js';

// 让 runner 可控的 helper
function makeControllableRunner() {
  let resolveFn: ((report: Record<string, unknown>) => void) | null = null;
  let rejectFn: ((err: unknown) => void) | null = null;
  let received: InitSessionContext | null = null;

  const runner = (ctx: InitSessionContext) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      received = ctx;
      resolveFn = resolve;
      rejectFn = reject;
    });

  return {
    runner,
    resolve: (report: Record<string, unknown> = {}) => resolveFn?.(report),
    reject: (err: unknown) => rejectFn?.(err),
    ctx: () => received!,
  };
}

// 等业务 promise 完整 settle 的 helper
async function flushMicrotasks() {
  // 多刷几轮，确保 transition listener 同步执行完
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('InitSessionManager', () => {
  let mgr: InitSessionManager;

  beforeEach(() => {
    mgr = new InitSessionManager();
  });

  it('start 后 status === running', async () => {
    const r = makeControllableRunner();
    const result = mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.status).toBe('running');
      expect(result.snapshot.canStart).toBe(false);
      expect(result.snapshot.canAbort).toBe(true);
    }
    r.resolve();
    await flushMicrotasks();
  });

  it('已有 running 时同 sourceId start 返回 another_running', async () => {
    const r1 = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r1.runner });

    const r2 = makeControllableRunner();
    const second = mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r2.runner });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('another_running');
      expect(second.activeSourceId).toBe('s1');
    }

    r1.resolve();
    await flushMicrotasks();
  });

  it('已有 running 时另一 sourceId start 返回 another_running', async () => {
    const r1 = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r1.runner });

    const r2 = makeControllableRunner();
    const second = mgr.start({ sourceId: 's2', toolType: 'obsidian', runner: r2.runner });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.activeSourceId).toBe('s1');
    }

    r1.resolve();
    await flushMicrotasks();
  });

  it('runner 正常 return → status done + report 写入', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    r.resolve({ nodesCreated: 42, linksCreated: 10 });
    await flushMicrotasks();

    const snap = mgr.snapshot('s1')!;
    expect(snap.status).toBe('done');
    expect(snap.report).toEqual({ nodesCreated: 42, linksCreated: 10 });
    expect(snap.canDiscard).toBe(true);
  });

  it('runner throw 普通错误 → status error + error 字段写入', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    r.reject(new Error('disk full'));
    await flushMicrotasks();

    const snap = mgr.snapshot('s1')!;
    expect(snap.status).toBe('error');
    expect(snap.error).toBe('disk full');
    expect(snap.canStart).toBe(true);   // error 后允许重试
    expect(snap.canDiscard).toBe(true);
  });

  it('abort(user) → aborting → 业务 reject AbortError → aborted', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    const abortPromise = mgr.abort('s1', 'user');

    // 业务层接到 signal 后抛出
    await flushMicrotasks();
    expect(mgr.snapshot('s1')!.status).toBe('aborting');
    r.reject(new InitAbortError('user'));

    const finalSnap = await abortPromise;
    expect(finalSnap.status).toBe('aborted');
    expect(finalSnap.abortReason).toBe('user');
    expect(finalSnap.canStart).toBe(true);
  });

  it('abort 时 promise 已结束 → 立即返回 aborted（不等 10s）', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    // runner 已经 resolve（业务很快跑完），但理论上仍可 abort
    r.resolve({ nodesCreated: 0 });
    await flushMicrotasks();

    expect(mgr.snapshot('s1')!.status).toBe('done');

    const start = Date.now();
    const snap = await mgr.abort('s1', 'user');
    const elapsed = Date.now() - start;

    // done 之后 abort 是幂等的，立即返回当前 snapshot
    expect(snap.status).toBe('done');
    expect(elapsed).toBeLessThan(500);
  });

  it('abort 兜底：runner 不响应 signal → 10s 后强转 aborted（fake timer）', async () => {
    vi.useFakeTimers();
    try {
      const r = makeControllableRunner();
      mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

      const abortP = mgr.abort('s1', 'user');

      // runner 不 resolve / 不 reject——模拟"业务层卡死"
      // 推进时间到 10s 触发 setTimeout('timeout')
      await vi.advanceTimersByTimeAsync(10_001);

      const snap = await abortP;
      expect(snap.status).toBe('aborted');
      expect(snap.abortReason).toBe('user');
      expect(snap.error).toContain('未响应');

      // 收尾：让 runner 后续 reject 也不影响（避免 unhandled rejection）
      r.reject(new InitAbortError('user'));
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discard 在 running 抛错', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    expect(() => mgr.discard('s1')).toThrow(/cannot discard/);
    r.resolve();
    await flushMicrotasks();
  });

  it('discard 在终态删除 session', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });
    r.resolve({ nodesCreated: 1 });
    await flushMicrotasks();

    expect(mgr.snapshot('s1')).not.toBeNull();
    mgr.discard('s1');
    expect(mgr.snapshot('s1')).toBeNull();
  });

  it('aborted 状态 start 同 sourceId 重新进入 running', async () => {
    const r1 = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r1.runner });
    const abortP = mgr.abort('s1', 'user');
    r1.reject(new InitAbortError('user'));
    await abortP;

    expect(mgr.snapshot('s1')!.status).toBe('aborted');

    const r2 = makeControllableRunner();
    const second = mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r2.runner });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.snapshot.status).toBe('running');
    }

    r2.resolve();
    await flushMicrotasks();
  });

  it('transition listener 在每次状态变化触发', async () => {
    const events: InitSessionSnapshot[] = [];
    mgr.on('transition', (s) => events.push(s));

    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });
    r.resolve({});
    await flushMicrotasks();

    // 至少：idle→running、progress 上报（可能 0 次）、running→done
    const statuses = events.map(e => e.status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('done');
  });

  it('reportPhase / advance / setProgress / heartbeat 更新 progress', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    const ctx = r.ctx();
    ctx.reportPhase(2, '入库', 100);
    ctx.advance(5);
    ctx.advance();  // delta 默认 1
    ctx.setProgress({ phaseName: '入库（已修正）' });
    ctx.heartbeat();

    const snap = mgr.snapshot('s1')!;
    expect(snap.progress.phase).toBe(2);
    expect(snap.progress.phaseName).toBe('入库（已修正）');
    expect(snap.progress.current).toBe(6);
    expect(snap.progress.total).toBe(100);

    r.resolve();
    await flushMicrotasks();
  });

  it('hasActive / getActiveSourceId 跟随状态变化', async () => {
    expect(mgr.hasActive()).toBe(false);
    expect(mgr.getActiveSourceId()).toBeNull();

    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });
    expect(mgr.hasActive()).toBe(true);
    expect(mgr.getActiveSourceId()).toBe('s1');

    r.resolve();
    await flushMicrotasks();
    expect(mgr.hasActive()).toBe(false);
    expect(mgr.getActiveSourceId()).toBeNull();
  });

  it('ctx.signal.aborted 在 abort 后为 true', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    const ctx = r.ctx();
    expect(ctx.signal.aborted).toBe(false);

    const abortP = mgr.abort('s1', 'user');
    expect(ctx.signal.aborted).toBe(true);

    r.reject(new InitAbortError('user'));
    await abortP;
  });

  it('runner resolve 但 signal.aborted=true 也算 aborted（业务未响应中断）', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

    const abortP = mgr.abort('s1', 'user');

    // 业务层没听 signal，直接 resolve
    r.resolve({ nodesCreated: 7 });
    const snap = await abortP;

    expect(snap.status).toBe('aborted');
    expect(snap.abortReason).toBe('user');
  });

  it('终态后 ctx 上报被忽略，不污染 snapshot', async () => {
    const r = makeControllableRunner();
    mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });
    const ctx = r.ctx();

    r.resolve({ nodesCreated: 1 });
    await flushMicrotasks();

    // 业务层晚到的进度上报（如未 await 完成的回调）
    ctx.reportPhase(99, 'should be ignored', 0);

    const snap = mgr.snapshot('s1')!;
    expect(snap.status).toBe('done');
    expect(snap.progress.phase).not.toBe(99);
  });

  it('stuck 检测：长时间无 heartbeat 触发 abort(stuck)', async () => {
    vi.useFakeTimers();
    try {
      const r = makeControllableRunner();
      mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });

      // 进入 Phase 0（阈值 30s）
      r.ctx().reportPhase(0, '扫描', 100);
      await flushMicrotasks();

      // 推进 35 秒（无 heartbeat）—— 应该触发 stuck
      await vi.advanceTimersByTimeAsync(35_000);
      // 让 abort('stuck') 内部的 await 推进
      r.reject(new InitAbortError('stuck'));
      await vi.runAllTimersAsync();

      const snap = mgr.snapshot('s1')!;
      expect(snap.status).toBe('aborted');
      expect(snap.abortReason).toBe('stuck');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stuck 检测：heartbeat 之后阈值时钟重置', async () => {
    vi.useFakeTimers();
    try {
      const r = makeControllableRunner();
      mgr.start({ sourceId: 's1', toolType: 'logseq', runner: r.runner });
      const ctx = r.ctx();
      ctx.reportPhase(0, '扫描', 100);
      await flushMicrotasks();

      // 推进 20 秒，未到 stuck 阈值（30s）
      await vi.advanceTimersByTimeAsync(20_000);
      ctx.heartbeat();  // 重置

      // 再推进 20 秒，仍未到阈值（如果 heartbeat 重置成功）
      await vi.advanceTimersByTimeAsync(20_000);

      expect(mgr.snapshot('s1')!.status).toBe('running');

      r.resolve({});
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
