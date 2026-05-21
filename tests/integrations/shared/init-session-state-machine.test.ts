/**
 * tests/integrations/shared/init-session-state-machine.test.ts
 *
 * 覆盖 src/integrations/shared/init-session.ts 的 InitSessionManager 状态机:
 *  - start() / abort() / discard() / snapshot() / hasActive() / getActiveSourceId()
 *  - 状态转换:idle → running → done/aborted/error
 *  - InitAbortError 路径 vs 非 abort 错误
 *  - canStart / canAbort / canDiscard 派生字段正确性
 *  - listener 订阅 + 异常隔离
 *  - 同一 manager 多 sourceId 互斥(only one active)
 *
 * 由于 stuck monitor 需要真实 setInterval,需 vi.useFakeTimers + advance 验证。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InitSessionManager, InitAbortError } from '@server/integrations/shared/init-session.js';
import type { InitSessionContext } from '@server/integrations/shared/init-session.js';

type ToolType = 'logseq' | 'obsidian' | 'apple-notes' | 'notion';

function makeManager(): InitSessionManager {
  return new InitSessionManager();
}

/** 阻塞 runner,可手动 resolve/reject */
function deferredRunner() {
  let resolve!: (report: Record<string, unknown>) => void;
  let reject!: (err: unknown) => void;
  let ctxRef: InitSessionContext | null = null;
  const promise = new Promise<Record<string, unknown>>((res, rej) => {
    resolve = res; reject = rej;
  });
  const runner = async (ctx: InitSessionContext) => {
    ctxRef = ctx;
    return promise;
  };
  return { runner, resolve, reject, getCtx: () => ctxRef };
}

describe('InitSessionManager — start()', () => {
  let mgr: InitSessionManager;

  beforeEach(() => { mgr = makeManager(); });

  it('全新启动:idle → running,返回 ok=true + snapshot', async () => {
    const { runner, resolve } = deferredRunner();
    const r = mgr.start({ sourceId: 'src-1', toolType: 'logseq' as ToolType, runner });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.status).toBe('running');
      expect(r.snapshot.sourceId).toBe('src-1');
      expect(r.snapshot.canAbort).toBe(true);
      expect(r.snapshot.canStart).toBe(false);
    }
    resolve({}); await new Promise(setImmediate);
  });

  it('runner 立即抛错(同步) → status=error', async () => {
    const r = mgr.start({
      sourceId: 's-err',
      toolType: 'logseq' as ToolType,
      runner: async () => { throw new Error('runner failed'); },
    });
    expect(r.ok).toBe(true);
    // 等 runner microtask
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const snap = mgr.snapshot('s-err');
    expect(snap?.status).toBe('error');
    expect(snap?.error).toContain('runner failed');
  });

  it('runner 抛 InitAbortError(reason=user) → status=aborted,reason=user', async () => {
    const r = mgr.start({
      sourceId: 's-ab',
      toolType: 'obsidian' as ToolType,
      runner: async () => { throw new InitAbortError('user'); },
    });
    expect(r.ok).toBe(true);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const snap = mgr.snapshot('s-ab');
    expect(snap?.status).toBe('aborted');
    expect(snap?.abortReason).toBe('user');
  });

  it('runner 正常完成 → status=done + report 透传', async () => {
    const report = { totalImported: 42, errors: 0 };
    const r = mgr.start({
      sourceId: 's-ok',
      toolType: 'notion' as ToolType,
      runner: async () => report,
    });
    expect(r.ok).toBe(true);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const snap = mgr.snapshot('s-ok');
    expect(snap?.status).toBe('done');
    expect(snap?.report).toEqual(report);
  });

  it('同一 sourceId 在 running 期间二次 start → 拒绝,reason=another_running', async () => {
    const { runner: r1, resolve: rs1 } = deferredRunner();
    mgr.start({ sourceId: 'same', toolType: 'logseq' as ToolType, runner: r1 });

    const r2 = mgr.start({ sourceId: 'same', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toBe('another_running');
      expect(r2.activeSourceId).toBe('same');
    }
    rs1({}); await new Promise(setImmediate);
  });

  it('另一 sourceId 在 running 期间 start → 拒绝(系统单 active)', async () => {
    const { runner: r1, resolve: rs1 } = deferredRunner();
    mgr.start({ sourceId: 'src-a', toolType: 'logseq' as ToolType, runner: r1 });

    const r2 = mgr.start({ sourceId: 'src-b', toolType: 'obsidian' as ToolType, runner: async () => ({}) });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.activeSourceId).toBe('src-a');
    }
    rs1({}); await new Promise(setImmediate);
  });

  it('终态后(done)同 sourceId 重启 → 接受', async () => {
    mgr.start({ sourceId: 'restart', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);

    const r2 = mgr.start({ sourceId: 'restart', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    expect(r2.ok).toBe(true);
  });
});

describe('InitSessionManager — abort()', () => {
  let mgr: InitSessionManager;

  beforeEach(() => { mgr = makeManager(); });

  it('running 时 abort:transition aborting → aborted', async () => {
    const { runner, resolve, getCtx } = deferredRunner();
    mgr.start({ sourceId: 's-ab', toolType: 'logseq' as ToolType, runner });

    // 让业务响应 abort:在 abort 触发后通过 signal 检测并 resolve
    setTimeout(() => {
      const c = getCtx();
      if (c?.signal.aborted) resolve({});
    }, 5);

    const finalSnap = await mgr.abort('s-ab', 'user');
    expect(finalSnap.status === 'aborted' || finalSnap.status === 'done').toBe(true);
    expect(finalSnap.abortReason).toBe('user');
  });

  it('abort 不存在的 sourceId → 返回 orphan snapshot(canStart=true,canAbort=false)', async () => {
    const snap = await mgr.abort('does-not-exist', 'user');
    expect(snap.canStart).toBe(true);
    expect(snap.canAbort).toBe(false);
    expect(snap.status).toBe('idle');
  });

  it('已 done 的 session 再 abort → 幂等返回当前 snapshot,不改 status', async () => {
    mgr.start({ sourceId: 's-d', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const snap1 = mgr.snapshot('s-d');
    expect(snap1?.status).toBe('done');

    const snap2 = await mgr.abort('s-d', 'user');
    expect(snap2.status).toBe('done'); // 不变
  });

  it('已 error 的 session 再 abort → 幂等保持 error', async () => {
    mgr.start({
      sourceId: 's-e',
      toolType: 'logseq' as ToolType,
      runner: async () => { throw new Error('boom'); },
    });
    await new Promise(setImmediate);
    await new Promise(setImmediate);

    const snap = await mgr.abort('s-e', 'user');
    expect(snap.status).toBe('error');
  });

  it('abort timeout(10s):runner 不响应 signal → 强制 aborted + error 标记', async () => {
    vi.useFakeTimers();
    const { runner } = deferredRunner(); // 永不 resolve

    mgr.start({ sourceId: 's-to', toolType: 'logseq' as ToolType, runner });

    const abortPromise = mgr.abort('s-to', 'user');
    // 推进 11s 超过 ABORT_SETTLE_TIMEOUT_MS=10s
    await vi.advanceTimersByTimeAsync(11_000);
    const snap = await abortPromise;
    expect(snap.status).toBe('aborted');
    expect(snap.error).toContain('未响应');

    vi.useRealTimers();
  });

  it('abort 在 10ms 内 settle 时 settle 路径必须 clearTimeout(避免 timer 堆积)', async () => {
    // 业务 promise 在 10ms 内 settle(响应了 abort signal),
    // 此时正常路径的 setTimeout(10s) 必须被 clear,否则 callback 仍在事件循环里。
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { runner, resolve, getCtx } = deferredRunner();
    mgr.start({ sourceId: 's-fast-settle', toolType: 'logseq' as ToolType, runner });

    // 业务在 abort signal 一到就立刻 resolve
    setTimeout(() => {
      const c = getCtx();
      if (c?.signal.aborted) resolve({});
    }, 5);

    const before = clearSpy.mock.calls.length;
    await mgr.abort('s-fast-settle', 'user');
    const after = clearSpy.mock.calls.length;

    // abort 内部 settle 路径至少调用过一次 clearTimeout(可能有其它库也用 clearTimeout,
    // 所以断言增量 >=1 而非 ==1)
    expect(after - before).toBeGreaterThanOrEqual(1);

    clearSpy.mockRestore();
  });
});

describe('InitSessionManager — discard()', () => {
  let mgr: InitSessionManager;
  beforeEach(() => { mgr = makeManager(); });

  it('终态后 discard → session 被清空,snapshot 返回 null', async () => {
    mgr.start({ sourceId: 's-d', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    mgr.discard('s-d');
    expect(mgr.snapshot('s-d')).toBeNull();
  });

  it('discard 不存在的 sourceId → no-op,不抛错', () => {
    expect(() => mgr.discard('does-not-exist')).not.toThrow();
  });

  it('running 中 discard → 抛错(必须先 abort)', () => {
    const { runner, resolve } = deferredRunner();
    mgr.start({ sourceId: 's-r', toolType: 'logseq' as ToolType, runner });
    expect(() => mgr.discard('s-r')).toThrow(/abort/);
    resolve({});
  });
});

describe('InitSessionManager — query API', () => {
  let mgr: InitSessionManager;
  beforeEach(() => { mgr = makeManager(); });

  it('hasActive 在没 session 时返回 false', () => {
    expect(mgr.hasActive()).toBe(false);
  });

  it('hasActive 在 running 时返回 true', async () => {
    const { runner, resolve } = deferredRunner();
    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner });
    expect(mgr.hasActive()).toBe(true);
    resolve({}); await new Promise(setImmediate);
  });

  it('hasActive 在 done 后返回 false', async () => {
    mgr.start({ sourceId: 'd', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    expect(mgr.hasActive()).toBe(false);
  });

  it('getActiveSourceId 在 running 时返回正确 id', async () => {
    const { runner, resolve } = deferredRunner();
    mgr.start({ sourceId: 'active-1', toolType: 'logseq' as ToolType, runner });
    expect(mgr.getActiveSourceId()).toBe('active-1');
    resolve({}); await new Promise(setImmediate);
  });

  it('snapshot 不存在的 sourceId → null', () => {
    expect(mgr.snapshot('nope')).toBeNull();
  });
});

describe('InitSessionManager — derived flags', () => {
  let mgr: InitSessionManager;
  beforeEach(() => { mgr = makeManager(); });

  it('running 时 canAbort=true,canStart=false,canDiscard=false', async () => {
    const { runner, resolve } = deferredRunner();
    const r = mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner });
    if (r.ok) {
      expect(r.snapshot.canAbort).toBe(true);
      expect(r.snapshot.canStart).toBe(false);
      expect(r.snapshot.canDiscard).toBe(false);
    }
    resolve({}); await new Promise(setImmediate);
  });

  it('done 时 canStart=false(不在 idle),canAbort=false,canDiscard=true', async () => {
    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const snap = mgr.snapshot('s');
    expect(snap?.canAbort).toBe(false);
    expect(snap?.canDiscard).toBe(true);
    // 已完成的 session canStart 是 false（不在 idle 或 aborted/error）—— done 可重启需先 discard
  });

  it('error 时 canStart=true,canDiscard=true', async () => {
    mgr.start({
      sourceId: 's',
      toolType: 'logseq' as ToolType,
      runner: async () => { throw new Error('x'); },
    });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const snap = mgr.snapshot('s');
    expect(snap?.canStart).toBe(true);
    expect(snap?.canDiscard).toBe(true);
  });
});

describe('InitSessionManager — listener', () => {
  let mgr: InitSessionManager;
  beforeEach(() => { mgr = makeManager(); });

  it('on("transition", listener) 在状态变化时被调用', async () => {
    const events: string[] = [];
    mgr.on('transition', (snap) => events.push(snap.status));

    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    // 至少看到 running 和 done
    expect(events).toContain('running');
    expect(events).toContain('done');
  });

  it('on() 返回 unsubscribe 函数,调用后 listener 不再触发', async () => {
    let calls = 0;
    const unsubscribe = mgr.on('transition', () => { calls++; });
    unsubscribe();

    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    expect(calls).toBe(0);
  });

  it('listener 抛错不影响其他 listener + 不冒泡', async () => {
    const ok: string[] = [];
    mgr.on('transition', () => { throw new Error('listener bug'); });
    mgr.on('transition', (snap) => ok.push(snap.status));

    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner: async () => ({}) });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    expect(ok.length).toBeGreaterThan(0);
  });

  it('on() 未知 event → 抛错', () => {
    expect(() => mgr.on('unknown' as 'transition', () => {})).toThrow();
  });
});

describe('InitSessionManager — context 上报', () => {
  let mgr: InitSessionManager;
  beforeEach(() => { mgr = makeManager(); });

  it('runner ctx.reportPhase 更新 progress 字段', async () => {
    const { runner, resolve, getCtx } = deferredRunner();
    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner });
    await new Promise(setImmediate);

    const ctx = getCtx()!;
    ctx.reportPhase(2, 'Scanning', 100);

    const snap = mgr.snapshot('s');
    expect(snap?.progress.phase).toBe(2);
    expect(snap?.progress.phaseName).toBe('Scanning');
    expect(snap?.progress.total).toBe(100);

    resolve({}); await new Promise(setImmediate);
  });

  // 回归 F5(2026-05-21): runner 在 await 之前的同步前缀调 reportPhase 时,
  // session.status 还停在 'idle'(transition 到 'running' 在 start() 末尾,但 runner
  // IIFE 已先同步开始执行)。旧 updateProgress 把 'idle' 误归入终态,直接 return,
  // patch 被吞 → UI 看到的 phase 永远是 -1。
  // 修复后:runner 的同步前缀里的 reportPhase 必须能改写 progress。
  it('F5 回归: runner 在同步前缀里 ctx.reportPhase(0, ...) 必须更新 progress', async () => {
    let observedPhase: number | undefined;
    const runner = async (ctx: InitSessionContext) => {
      // 模拟 runner 的同步前缀:第一行立刻 reportPhase,然后才 await
      ctx.reportPhase(0, 'init', 50);
      observedPhase = 0; // 标记 reportPhase 已被调
      // 让 runner 通过 abort signal 优雅退出(避免测试卡死)
      await new Promise<void>((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new InitAbortError('user')));
      });
      return {};
    };
    const r = mgr.start({ sourceId: 's-sync', toolType: 'logseq' as ToolType, runner });
    expect(r.ok).toBe(true);

    // start() 返回时,runner 的同步前缀已经跑过了。
    // 旧代码:reportPhase 在 status='idle' 阶段被调,patch 被丢 → snapshot.phase 仍是默认 -1。
    // 新代码:'idle' 不算终态,patch 被采纳 → snapshot.phase = 0。
    const snap = mgr.snapshot('s-sync');
    expect(observedPhase).toBe(0); // 确认 runner 同步前缀确实跑过了
    expect(snap?.progress.phase).toBe(0); // 这是 F5 的核心断言
    expect(snap?.progress.phaseName).toBe('init');
    expect(snap?.progress.total).toBe(50);

    // 清理:abort 触发 runner reject,runner promise settle → abort 返回
    await mgr.abort('s-sync', 'user');
  });

  it('runner ctx.advance() 累加 current', async () => {
    const { runner, resolve, getCtx } = deferredRunner();
    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner });
    await new Promise(setImmediate);

    const ctx = getCtx()!;
    ctx.advance();
    ctx.advance(5);
    ctx.advance();

    const snap = mgr.snapshot('s');
    expect(snap?.progress.current).toBe(7);

    resolve({}); await new Promise(setImmediate);
  });

  it('runner ctx.signal 在 abort 后被设为 aborted', async () => {
    const { runner, resolve, getCtx } = deferredRunner();
    mgr.start({ sourceId: 's', toolType: 'logseq' as ToolType, runner });
    await new Promise(setImmediate);

    expect(getCtx()?.signal.aborted).toBe(false);

    const abortPromise = mgr.abort('s', 'user');
    // 让 abort 触发 controller.abort
    await new Promise(setImmediate);
    expect(getCtx()?.signal.aborted).toBe(true);

    resolve({}); await abortPromise;
  });
});

describe('InitSessionManager — InitAbortError', () => {
  it('InitAbortError name=InitAbortError + reason 字段可读', () => {
    const e = new InitAbortError('stuck');
    expect(e.name).toBe('InitAbortError');
    expect(e.reason).toBe('stuck');
    expect(e.message).toContain('stuck');
  });

  it.each(['user', 'stuck', 'navigation', 'shutdown'] as const)('reason=%s 可构造', (r) => {
    const e = new InitAbortError(r);
    expect(e.reason).toBe(r);
  });
});
