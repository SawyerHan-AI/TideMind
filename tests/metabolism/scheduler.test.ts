/**
 * scheduler.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  loadStrategies: () => {},
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: '' },
    ollama: { url: '' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: '', dimensions: 3072 },
    search: {},
    gates: {},
    metabolism: {},
  }),
  isLlmConfigured: () => false,
}));

vi.mock('../../src/llm/client.js', () => {
  class LLMServiceError extends Error {
    constructor(msg: string, public readonly statusCode?: number) {
      super(msg);
      this.name = 'LLMServiceError';
    }
  }
  return { callLLM: vi.fn(), LLMServiceError };
});

import type Database from 'better-sqlite3';
import { setupTestDb, seedNode } from '../helpers/test-db.js';
import {
  tryClaimTask,
  rollbackClaim,
  runSchedulerTick,
  getTaskStatuses,
  setHealthChangeListener,
  noteSuccessfulLLMCall,
  type TaskDefinition,
} from '../../src/metabolism/scheduler.js';
import { LLMServiceError } from '../../src/llm/client.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

// ===== tryClaimTask =====

describe('tryClaimTask', () => {
  it('首次声明成功', () => {
    const result = tryClaimTask(db, 'test-task', 60);
    expect(result.claimed).toBe(true);
    expect(result.priorValue).toBeNull();
  });

  it('间隔未到时声明失败', () => {
    const first = tryClaimTask(db, 'test-task', 60);
    expect(first.claimed).toBe(true);

    const second = tryClaimTask(db, 'test-task', 60);
    expect(second.claimed).toBe(false);
  });

  it('间隔到期后可再次声明', () => {
    // 手动设置一个过去的时间戳
    const pastTime = Date.now() - 120 * 60 * 1000; // 2 小时前
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
      'last_task_test-task',
      pastTime.toString(),
    );

    const result = tryClaimTask(db, 'test-task', 60);
    expect(result.claimed).toBe(true);
    expect(result.priorValue).toBe(pastTime.toString());
  });

  it('不同任务互不影响', () => {
    const a = tryClaimTask(db, 'task-a', 60);
    const b = tryClaimTask(db, 'task-b', 60);
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
  });
});

// ===== rollbackClaim =====

describe('rollbackClaim', () => {
  it('首次运行失败时删除记录', () => {
    tryClaimTask(db, 'test-task', 60);
    rollbackClaim(db, 'test-task', null);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_test-task'").get();
    expect(row).toBeUndefined();
  });

  it('非首次运行失败时恢复原时间戳', () => {
    const oldTime = (Date.now() - 7200000).toString();
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('last_task_test-task', oldTime);
    tryClaimTask(db, 'test-task', 60);

    rollbackClaim(db, 'test-task', oldTime);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_test-task'").get() as { value: string };
    expect(row.value).toBe(oldTime);
  });

  it('回滚后可重新声明', () => {
    const claim = tryClaimTask(db, 'test-task', 60);
    rollbackClaim(db, 'test-task', claim.priorValue);

    const reClaim = tryClaimTask(db, 'test-task', 60);
    expect(reClaim.claimed).toBe(true);
  });
});

// ===== runSchedulerTick =====

describe('runSchedulerTick', () => {
  function makeTask(overrides: Partial<TaskDefinition> & { id: string }): TaskDefinition {
    return {
      execute: vi.fn().mockResolvedValue(undefined),
      intervalStrategy: 'test',
      defaultIntervalMinutes: 1,
      ...overrides,
    };
  }

  it('执行到期的任务', async () => {
    const task = makeTask({ id: 'run-me' });
    const executed = await runSchedulerTick(db, [task]);
    expect(executed).toContain('run-me');
    expect(task.execute).toHaveBeenCalledOnce();
  });

  it('未到期的任务不执行', async () => {
    const task = makeTask({ id: 'skip-me', defaultIntervalMinutes: 9999 });
    // 先标记为刚运行过
    tryClaimTask(db, 'skip-me', 9999);

    const executed = await runSchedulerTick(db, [task]);
    expect(executed).not.toContain('skip-me');
  });

  it('门控检查失败时跳过', async () => {
    const task = makeTask({
      id: 'gated',
      gateCheck: () => false,
    });

    const executed = await runSchedulerTick(db, [task]);
    expect(executed).not.toContain('gated');
    expect(task.execute).not.toHaveBeenCalled();
  });

  it('任务执行失败时回滚 claim', async () => {
    const task = makeTask({
      id: 'fail-task',
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const executed = await runSchedulerTick(db, [task]);
    expect(executed).not.toContain('fail-task');

    // 回滚后可重新声明
    const reClaim = tryClaimTask(db, 'fail-task', 1);
    expect(reClaim.claimed).toBe(true);
  });

  it('多个任务串行执行', async () => {
    const order: string[] = [];
    const taskA = makeTask({
      id: 'a',
      execute: vi.fn().mockImplementation(async () => { order.push('a'); }),
    });
    const taskB = makeTask({
      id: 'b',
      execute: vi.fn().mockImplementation(async () => { order.push('b'); }),
    });

    await runSchedulerTick(db, [taskA, taskB]);
    expect(order).toEqual(['a', 'b']);
  });

  it('LLM 熔断器打开时跳过 requiresLLM 任务', async () => {
    // 模拟熔断器已开启
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '5');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_opened_at', Date.now().toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_cooldown_ms', '3600000');

    const llmTask = makeTask({ id: 'llm-task', requiresLLM: true });
    const normalTask = makeTask({ id: 'normal-task' });

    const executed = await runSchedulerTick(db, [llmTask, normalTask]);
    expect(executed).not.toContain('llm-task');
    expect(executed).toContain('normal-task');
  });

  it('非 LLM 任务不受熔断器影响', async () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '5');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_opened_at', Date.now().toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_cooldown_ms', '3600000');

    const task = makeTask({ id: 'safe-task', requiresLLM: false });
    const executed = await runSchedulerTick(db, [task]);
    expect(executed).toContain('safe-task');
  });

  // ===== 重构(2026-05-20 Audit A-1/A-2 修复):
  // task.execute() 正常 return 不再被 scheduler 当作 "LLM 真的成功"。
  // 健康度信号(llm_last_success_at + 熔断器复位 + circuit_breaker_off 事件)
  // 只在 src/llm/client.ts callLLM 拿到 2xx response 时,通过 setLLMSuccessHook
  // 注入的回调触发 — 单元层等价于直接调 noteSuccessfulLLMCall(db)。
  // 原本测 "runSchedulerTick 触发健康信号写入" 的 4 个用例需要改成 "noteSuccessfulLLMCall
  // 行为正确" 的覆盖,因为后者才是当前的正确写入入口。
  // failure 路径(recordLLMFailure)仍在 scheduler.catch 里,沿用原 runSchedulerTick 覆盖。

  it('runSchedulerTick: task.execute 正常 return 但 LLM 未真实调用 → llm_last_success_at 不应写入(Audit A-1/A-2 回归)', async () => {
    // 模拟一个 requiresLLM=true 任务,内部吞掉 LLMServiceError 后正常 return。
    // 真实场景:digest-retry 在 LLM 全挂期间走 failPendingDigest 后无报错 return。
    const swallowingTask: TaskDefinition = {
      id: 'swallow',
      execute: vi.fn().mockResolvedValue(undefined), // 不抛
      intervalStrategy: 'test',
      defaultIntervalMinutes: 0,
      requiresLLM: true,
    };
    await runSchedulerTick(db, [swallowingTask]);

    // 关键回归断言:llm_last_success_at 必须不存在(因为 callLLM 没真的被调过)
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'llm_last_success_at'").get();
    expect(row).toBeUndefined();

    // 熔断器状态也不应被重置:failures 字段保留(本测试初始为 0,所以也是 undefined)
    const failuresRow = db.prepare("SELECT value FROM metadata WHERE key = 'circuit_breaker_failures'").get();
    expect(failuresRow).toBeUndefined();
  });

  // ===== noteSuccessfulLLMCall = 真实 LLM 成功的入口 =====

  it('noteSuccessfulLLMCall: half-open 状态下成功调用发送 circuit_breaker_off 事件', () => {
    // 模拟：3 次失败已开启熔断器，冷却也已过期 → getCircuitState 会返回 half-open
    const expiredOpenTime = Date.now() - 10 * 60 * 1000;
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_opened_at', expiredOpenTime.toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_cooldown_ms', (5 * 60 * 1000).toString());

    noteSuccessfulLLMCall(db);

    // 状态已重置
    const failuresRow = db.prepare("SELECT value FROM metadata WHERE key = 'circuit_breaker_failures'").get() as { value: string };
    expect(failuresRow.value).toBe('0');

    // 时间线发了 circuit_breaker_off 事件
    const offEvents = db.prepare(
      "SELECT title FROM timeline_events WHERE title LIKE '%circuit_breaker_off%'",
    ).all() as Array<{ title: string }>;
    expect(offEvents).toHaveLength(1);
  });

  it('noteSuccessfulLLMCall: closed 状态下有未到阈值的失败计数 → 静默重置,不发事件', () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '1');

    noteSuccessfulLLMCall(db);

    const failuresRow = db.prepare("SELECT value FROM metadata WHERE key = 'circuit_breaker_failures'").get() as { value: string };
    expect(failuresRow.value).toBe('0');

    const offEvents = db.prepare(
      "SELECT title FROM timeline_events WHERE title LIKE '%circuit_breaker_off%'",
    ).all();
    expect(offEvents).toHaveLength(0);
  });

  it('noteSuccessfulLLMCall: 写入 llm_last_success_at', () => {
    const before = Date.now();
    noteSuccessfulLLMCall(db);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'llm_last_success_at'").get() as { value: string } | undefined;
    expect(row).toBeDefined();
    const ts = Number(row!.value);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('LLM 服务错误后写入 llm_last_error（截断到 500 字符）+ llm_last_error_at', async () => {
    const longMessage = 'X'.repeat(800);
    const llmTask: TaskDefinition = {
      id: 'fail-task',
      execute: vi.fn().mockRejectedValue(new LLMServiceError(longMessage, 500)),
      intervalStrategy: 'test',
      defaultIntervalMinutes: 0,
      requiresLLM: true,
    };
    const before = Date.now();
    await runSchedulerTick(db, [llmTask]);

    const errRow = db.prepare("SELECT value FROM metadata WHERE key = 'llm_last_error'").get() as { value: string };
    expect(errRow.value.length).toBe(500);

    const tsRow = db.prepare("SELECT value FROM metadata WHERE key = 'llm_last_error_at'").get() as { value: string };
    expect(Number(tsRow.value)).toBeGreaterThanOrEqual(before);
  });

  it('setHealthChangeListener: 成功(via noteSuccessfulLLMCall) 与失败(via runSchedulerTick) 都触发回调', async () => {
    const cb = vi.fn();
    setHealthChangeListener(cb);
    try {
      // 成功 — 通过实际的成功入口
      noteSuccessfulLLMCall(db);
      // 失败 — 通过 scheduler 的 catch 路径
      await runSchedulerTick(db, [{
        id: 'f',
        execute: vi.fn().mockRejectedValue(new LLMServiceError('boom', 500)),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 0,
        requiresLLM: true,
      }]);
      expect(cb).toHaveBeenCalledTimes(2);
    } finally {
      setHealthChangeListener(null);
    }
  });
});

// ===== getTaskStatuses =====

describe('getTaskStatuses', () => {
  it('返回所有任务状态', () => {
    const tasks: TaskDefinition[] = [
      {
        id: 'task-1',
        execute: vi.fn().mockResolvedValue(undefined),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 30,
      },
      {
        id: 'task-2',
        execute: vi.fn().mockResolvedValue(undefined),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 60,
      },
    ];

    const statuses = getTaskStatuses(db, tasks);
    expect(statuses).toHaveLength(2);
    expect(statuses[0].id).toBe('task-1');
    expect(statuses[0].intervalMinutes).toBe(30);
    expect(statuses[0].lastRun).toBeNull();
    expect(statuses[0].nextRunAfter).toBeNull();
    expect(statuses[0].gatesMet).toBe(true);
  });

  it('有运行记录时计算 nextRunAfter', () => {
    const now = Date.now();
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('last_task_task-1', now.toString());

    const tasks: TaskDefinition[] = [{
      id: 'task-1',
      execute: vi.fn().mockResolvedValue(undefined),
      intervalStrategy: 'test',
      defaultIntervalMinutes: 30,
    }];

    const statuses = getTaskStatuses(db, tasks);
    expect(statuses[0].lastRun).toBe(now);
    expect(statuses[0].nextRunAfter).toBe(now + 30 * 60 * 1000);
  });

  it('有门控函数时反映门控状态', () => {
    const tasks: TaskDefinition[] = [{
      id: 'gated-task',
      execute: vi.fn().mockResolvedValue(undefined),
      intervalStrategy: 'test',
      defaultIntervalMinutes: 30,
      gateCheck: () => false,
    }];

    const statuses = getTaskStatuses(db, tasks);
    expect(statuses[0].gatesMet).toBe(false);
  });
});

import { shouldResetWatchdog } from '../../src/metabolism/scheduler';

describe('shouldResetWatchdog (watchdog 纯函数)', () => {
  const THRESHOLD = 30 * 60 * 1000;  // 30 分钟,跟 MAINTENANCE_WATCHDOG_MS 一致

  it('tickStartedAt=0 时不复位(未运行)', () => {
    expect(shouldResetWatchdog(Date.now(), 0, THRESHOLD)).toBe(false);
  });

  it('刚启动 5 分钟不复位', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - 5 * 60 * 1000;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(false);
  });

  it('刚到 30 分钟边界不复位(用严格 >)', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - THRESHOLD;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(false);
  });

  it('超过 30 分钟 1ms 即复位', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - THRESHOLD - 1;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(true);
  });

  it('卡死 1 小时必复位', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - 60 * 60 * 1000;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(true);
  });

  it('用 fake timers 演示完整轮回', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 19, 12, 0, 0));
    const t0 = Date.now();
    // 还没启动
    expect(shouldResetWatchdog(Date.now(), 0, THRESHOLD)).toBe(false);
    // 启动
    const tickStart = Date.now();
    expect(shouldResetWatchdog(Date.now(), tickStart, THRESHOLD)).toBe(false);
    // 前进 29 分钟
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(shouldResetWatchdog(Date.now(), tickStart, THRESHOLD)).toBe(false);
    // 前进到 31 分钟
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(shouldResetWatchdog(Date.now(), tickStart, THRESHOLD)).toBe(true);
    vi.useRealTimers();
  });
});
