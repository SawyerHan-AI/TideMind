/**
 * tests/client/daemon.test.ts
 *
 * 覆盖 client/electron/daemon.ts 的 startDaemon/stopDaemon:
 *  - running flag 幂等(重复 start 不重复初始化)
 *  - timer interval 跟随 activity state 切换(60s active / 10min idle)
 *  - activity state 'active' 触发立即 runSchedulerTick(catch up overdue)
 *  - tickRunning 守卫防止 tick overlap
 *  - stopDaemon 清理 timer + unsubscribe + stopAllNoteSources + closeDb
 *  - 异常隔离:笔记源启动失败 / scheduler tick 失败 / log event 失败 都不冒泡
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadConfigMock, ensureDataDirsMock, getDataDirMock,
  getDbMock, closeDbMock, initVecMock,
  enableFileLoggingMock,
  logTimelineEventMock,
  runSchedulerTickMock,
  ALL_TASKS_VAL,
  startAllNoteSourcesMock, stopAllNoteSourcesMock,
  activityState,
  // v0.2.74 健康度 hook + structure-holes worker runner（L3 + CRITICAL #1）
  noteSuccessfulLLMCallMock, setLLMFailureHookMock, recordLLMFailureForHookMock,
  recordEmbeddingSuccessMock, recordEmbeddingFailureMock,
  setLLMSuccessHookMock, setEmbeddingSuccessHookMock, setEmbeddingFailureHookMock,
  setStructureHolesRunnerMock, runStructureHolesInWorkerMock, terminateStructureHolesWorkerMock,
} = vi.hoisted(() => {
  const tasks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  return {
    loadConfigMock: vi.fn(),
    ensureDataDirsMock: vi.fn(),
    getDataDirMock: vi.fn(() => '/tmp/test-daemon-dir'),
    getDbMock: vi.fn(() => ({ name: 'mock-db' })),
    closeDbMock: vi.fn(),
    initVecMock: vi.fn(async () => undefined),
    enableFileLoggingMock: vi.fn(),
    logTimelineEventMock: vi.fn(),
    runSchedulerTickMock: vi.fn(async () => undefined),
    ALL_TASKS_VAL: tasks,
    startAllNoteSourcesMock: vi.fn(async () => undefined),
    stopAllNoteSourcesMock: vi.fn(),
    activityState: {
      state: 'active' as 'active' | 'idle',
      listeners: new Set<(s: 'active' | 'idle') => void>(),
    },
    noteSuccessfulLLMCallMock: vi.fn(),
    setLLMFailureHookMock: vi.fn(),
    recordLLMFailureForHookMock: vi.fn(),
    recordEmbeddingSuccessMock: vi.fn(),
    recordEmbeddingFailureMock: vi.fn(),
    setLLMSuccessHookMock: vi.fn(),
    setEmbeddingSuccessHookMock: vi.fn(),
    setEmbeddingFailureHookMock: vi.fn(),
    setStructureHolesRunnerMock: vi.fn(),
    runStructureHolesInWorkerMock: vi.fn(async () => []),
    terminateStructureHolesWorkerMock: vi.fn(),
  };
});

vi.mock('@server/config.js', () => ({
  loadConfig: loadConfigMock,
  ensureDataDirs: ensureDataDirsMock,
  getDataDir: getDataDirMock,
}));

vi.mock('@server/db/connection.js', () => ({
  getDb: getDbMock,
  closeDb: closeDbMock,
  initVec: initVecMock,
}));

vi.mock('@server/utils/logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  enableFileLogging: enableFileLoggingMock,
}));

vi.mock('@server/db/log.js', () => ({
  logTimelineEvent: logTimelineEventMock,
}));

vi.mock('@server/metabolism/scheduler.js', () => ({
  runSchedulerTick: runSchedulerTickMock,
  noteSuccessfulLLMCall: noteSuccessfulLLMCallMock,
  setLLMFailureHook: setLLMFailureHookMock,
  recordLLMFailureForHook: recordLLMFailureForHookMock,
  recordEmbeddingSuccess: recordEmbeddingSuccessMock,
  recordEmbeddingFailure: recordEmbeddingFailureMock,
}));

vi.mock('@server/llm/client.js', () => ({
  setLLMSuccessHook: setLLMSuccessHookMock,
}));

vi.mock('@server/llm/embedding.js', () => ({
  setEmbeddingSuccessHook: setEmbeddingSuccessHookMock,
  setEmbeddingFailureHook: setEmbeddingFailureHookMock,
}));

vi.mock('@server/graph/structure-holes.js', () => ({
  setStructureHolesRunner: setStructureHolesRunnerMock,
}));

vi.mock('../../client/electron/workers/structure-holes-runner.js', () => ({
  runStructureHolesInWorker: runStructureHolesInWorkerMock,
  terminateStructureHolesWorker: terminateStructureHolesWorkerMock,
}));

vi.mock('@server/metabolism/tasks.js', () => ({
  ALL_TASKS: ALL_TASKS_VAL,
}));

vi.mock('@server/integrations/logseq/index.js', () => ({
  stopLogseqIntegration: vi.fn(),
}));

vi.mock('@server/integrations/shared/note-sources.js', () => ({
  startAllNoteSources: startAllNoteSourcesMock,
  stopAllNoteSources: stopAllNoteSourcesMock,
}));

vi.mock('../../client/electron/activity-state.js', () => ({
  getActivityState: () => ({
    getState: () => activityState.state,
    onChange: (cb: (s: 'active' | 'idle') => void) => {
      activityState.listeners.add(cb);
      return () => activityState.listeners.delete(cb);
    },
  }),
}));

const { startDaemon, stopDaemon } = await import('../../client/electron/daemon.js');

beforeEach(() => {
  loadConfigMock.mockClear();
  ensureDataDirsMock.mockClear();
  getDbMock.mockClear();
  closeDbMock.mockClear();
  initVecMock.mockClear();
  enableFileLoggingMock.mockClear();
  logTimelineEventMock.mockClear();
  runSchedulerTickMock.mockClear();
  startAllNoteSourcesMock.mockClear();
  stopAllNoteSourcesMock.mockClear();
  noteSuccessfulLLMCallMock.mockClear();
  setLLMFailureHookMock.mockClear();
  recordLLMFailureForHookMock.mockClear();
  recordEmbeddingSuccessMock.mockClear();
  recordEmbeddingFailureMock.mockClear();
  setLLMSuccessHookMock.mockClear();
  setEmbeddingSuccessHookMock.mockClear();
  setEmbeddingFailureHookMock.mockClear();
  setStructureHolesRunnerMock.mockClear();
  runStructureHolesInWorkerMock.mockClear();
  terminateStructureHolesWorkerMock.mockClear();
  activityState.state = 'active';
  activityState.listeners.clear();
  vi.useFakeTimers();
});

afterEach(async () => {
  // 确保 daemon 停下,跨 case 不残留 timer
  vi.useRealTimers();
  await stopDaemon();
});

describe('startDaemon', () => {
  it('启动:loadConfig / ensureDataDirs / initVec / startAllNoteSources / runSchedulerTick(初次)全部调用', async () => {
    await startDaemon();
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(ensureDataDirsMock).toHaveBeenCalledTimes(1);
    expect(enableFileLoggingMock).toHaveBeenCalledTimes(1);
    expect(initVecMock).toHaveBeenCalledTimes(1);
    expect(startAllNoteSourcesMock).toHaveBeenCalledTimes(1);
    expect(runSchedulerTickMock).toHaveBeenCalledTimes(1); // 启动立即跑一次
  });

  it('记录 daemon_start timeline 事件,带 task_count', async () => {
    await startDaemon();
    expect(logTimelineEventMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: 'memory',
        subtype: 'daemon_start',
        detail: expect.objectContaining({ task_count: 3 }),
      }),
    );
  });

  it('幂等:重复 startDaemon 不重复初始化', async () => {
    await startDaemon();
    await startDaemon();
    await startDaemon();
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(initVecMock).toHaveBeenCalledTimes(1);
    expect(startAllNoteSourcesMock).toHaveBeenCalledTimes(1);
  });

  it('startAllNoteSources 抛错 → log.error 不冒泡', async () => {
    startAllNoteSourcesMock.mockRejectedValueOnce(new Error('source init failed'));
    await expect(startDaemon()).resolves.toBeUndefined();
  });

  it('初始 runSchedulerTick 抛错 → log.error 不冒泡', async () => {
    runSchedulerTickMock.mockRejectedValueOnce(new Error('scheduler boom'));
    await expect(startDaemon()).resolves.toBeUndefined();
  });

  // ── v0.2.74 L3: Electron daemon 必须 wire 健康度 hook(此前完全漏了,backlog C.H2)──
  it('L3: 注入 4 个健康度 hook + structure-holes worker runner', async () => {
    await startDaemon();
    expect(setLLMSuccessHookMock).toHaveBeenCalledTimes(1);
    expect(setLLMFailureHookMock).toHaveBeenCalledTimes(1);
    expect(setEmbeddingSuccessHookMock).toHaveBeenCalledTimes(1);
    expect(setEmbeddingFailureHookMock).toHaveBeenCalledTimes(1);
    expect(setStructureHolesRunnerMock).toHaveBeenCalledTimes(1);
  });

  it('L3: hook 必须在首次 runSchedulerTick 之前设上(否则首轮 LLM 成功信号丢失)', async () => {
    const order: string[] = [];
    setLLMSuccessHookMock.mockImplementationOnce(() => order.push('hook'));
    runSchedulerTickMock.mockImplementationOnce(async () => { order.push('tick'); });
    await startDaemon();
    expect(order).toEqual(['hook', 'tick']);
  });

  it('L3: LLM success hook 真正调 noteSuccessfulLLMCall(db)', async () => {
    await startDaemon();
    // 取出注入的 success hook 并触发,验证它转发到 noteSuccessfulLLMCall
    const hook = setLLMSuccessHookMock.mock.calls[0][0] as () => void;
    hook();
    expect(noteSuccessfulLLMCallMock).toHaveBeenCalledTimes(1);
    expect(noteSuccessfulLLMCallMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'mock-db' }));
  });

  it('L3: structure-holes runner 转发到 runStructureHolesInWorker', async () => {
    await startDaemon();
    const runner = setStructureHolesRunnerMock.mock.calls[0][0] as (db: unknown) => unknown;
    const fakeDb = { name: 'mock-db' };
    runner(fakeDb);
    expect(runStructureHolesInWorkerMock).toHaveBeenCalledWith(fakeDb);
  });
});

describe('timer interval (activity state)', () => {
  it("active state 时 60s 间隔触发 runSchedulerTick", async () => {
    activityState.state = 'active';
    await startDaemon();
    runSchedulerTickMock.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSchedulerTickMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSchedulerTickMock).toHaveBeenCalledTimes(2);
  });

  it("idle state 时 10min 间隔触发", async () => {
    activityState.state = 'idle';
    await startDaemon();
    runSchedulerTickMock.mockClear();

    // 60s 不应触发(idle 是 10min)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSchedulerTickMock).not.toHaveBeenCalled();

    // 10min 触发
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(runSchedulerTickMock).toHaveBeenCalledTimes(1);
  });

  it("activity active→idle 切换:timer 重置为 10min 间隔", async () => {
    activityState.state = 'active';
    await startDaemon();
    runSchedulerTickMock.mockClear();

    // 触发 active→idle 事件
    for (const cb of activityState.listeners) cb('idle');
    activityState.state = 'idle';

    // 现在是 idle,60s 不触发
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSchedulerTickMock).not.toHaveBeenCalled();

    // 推进到 10min(从切换那一刻起)
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(runSchedulerTickMock).toHaveBeenCalledTimes(1);
  });

  it("activity idle→active 切换:立刻 runSchedulerTick 一次(catch up)", async () => {
    activityState.state = 'idle';
    await startDaemon();
    runSchedulerTickMock.mockClear();

    // idle → active 切换:模块内监听器收到 active 会立即跑 runSchedulerTick
    activityState.state = 'active';
    for (const cb of activityState.listeners) cb('active');

    // 让 microtask 解决
    await Promise.resolve();
    await Promise.resolve();
    expect(runSchedulerTickMock).toHaveBeenCalledTimes(1);
  });
});

describe('stopDaemon', () => {
  it('未启动时 stopDaemon → no-op,不抛', async () => {
    await expect(stopDaemon()).resolves.toBeUndefined();
  });

  it('启动后 stopDaemon:清 timer + 取消 activity 订阅 + stopAllNoteSources + closeDb', async () => {
    await startDaemon();
    expect(activityState.listeners.size).toBeGreaterThanOrEqual(1);

    await stopDaemon();
    expect(activityState.listeners.size).toBe(0);
    expect(stopAllNoteSourcesMock).toHaveBeenCalledTimes(1);
    expect(closeDbMock).toHaveBeenCalledTimes(1);
  });

  // ── v0.2.74: stopDaemon 摘 hook + 强杀 worker(防 shutdown race / 线程泄漏)──
  it('L3/#1: stopDaemon 把 4 个 hook 置 null + 摘 structure-holes runner + terminate worker', async () => {
    await startDaemon();
    setLLMSuccessHookMock.mockClear();
    setLLMFailureHookMock.mockClear();
    setEmbeddingSuccessHookMock.mockClear();
    setEmbeddingFailureHookMock.mockClear();
    setStructureHolesRunnerMock.mockClear();

    await stopDaemon();

    expect(setLLMSuccessHookMock).toHaveBeenCalledWith(null);
    expect(setLLMFailureHookMock).toHaveBeenCalledWith(null);
    expect(setEmbeddingSuccessHookMock).toHaveBeenCalledWith(null);
    expect(setEmbeddingFailureHookMock).toHaveBeenCalledWith(null);
    expect(setStructureHolesRunnerMock).toHaveBeenCalledWith(null);
    expect(terminateStructureHolesWorkerMock).toHaveBeenCalledTimes(1);
  });

  it('stop 后再 stop → 不重复清理', async () => {
    await startDaemon();
    await stopDaemon();
    await stopDaemon();
    await stopDaemon();
    expect(stopAllNoteSourcesMock).toHaveBeenCalledTimes(1);
    expect(closeDbMock).toHaveBeenCalledTimes(1);
  });

  it('记录 daemon_stop timeline 事件', async () => {
    await startDaemon();
    logTimelineEventMock.mockClear();
    await stopDaemon();
    expect(logTimelineEventMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ type: 'memory', subtype: 'daemon_stop' }),
    );
  });

  it('logTimelineEvent 抛错时 stopDaemon 仍完成清理(DB 已关情况)', async () => {
    await startDaemon();
    logTimelineEventMock.mockImplementationOnce(() => {
      throw new Error('DB closed already');
    });

    await expect(stopDaemon()).resolves.toBeUndefined();
    expect(closeDbMock).toHaveBeenCalled();
  });

  it('stop 后 timer 不再触发 runSchedulerTick', async () => {
    await startDaemon();
    await stopDaemon();
    runSchedulerTickMock.mockClear();

    await vi.advanceTimersByTimeAsync(10 * 60_000); // idle 间隔
    expect(runSchedulerTickMock).not.toHaveBeenCalled();
  });

  it('F1: stopDaemon 等已 fire 的 in-flight tick 跑完后再 closeDb', async () => {
    // mock runSchedulerTick 第二次调用(60s timer fired)返个 pending promise
    let resolveTick: (() => void) | undefined;
    const pendingTick = new Promise<void>((resolve) => { resolveTick = resolve });
    runSchedulerTickMock.mockImplementationOnce(async () => undefined); // initial(立即 resolve)
    runSchedulerTickMock.mockImplementationOnce(() => pendingTick);     // timer-fired(挂起)

    await startDaemon();
    // 跑到 timer 触发的那个 tick(注意:vi.useFakeTimers 下 advance 会同步触发 setInterval cb)
    await vi.advanceTimersByTimeAsync(60_000);

    // 此时 tick 还没 resolve → stopDaemon 应当等
    // 用 real timers 验证"等待"(避免 fake timer 把 5s timeout 也提前)
    vi.useRealTimers();

    const stopP = stopDaemon();
    let stopped = false;
    stopP.then(() => { stopped = true });

    // 给 stopDaemon 一些时间检查 tickPromise
    await new Promise(r => setTimeout(r, 50));
    expect(stopped).toBe(false);
    // closeDb 还没被调
    expect(closeDbMock).not.toHaveBeenCalled();

    // 让 tick 完成
    resolveTick?.();
    await stopP;
    expect(stopped).toBe(true);
    expect(closeDbMock).toHaveBeenCalledTimes(1);
  });
});
