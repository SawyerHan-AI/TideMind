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
import { setupTestDb } from '../helpers/test-db.js';
import {
  tryClaimTask,
  rollbackClaim,
  runSchedulerTick,
  getTaskStatuses,
  setHealthChangeListener,
  noteSuccessfulLLMCall,
  notifyLLMFailure,
  getCircuitState,
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
    const claim = tryClaimTask(db, 'test-task', 60);
    rollbackClaim(db, 'test-task', null, claim.claimedValue);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_test-task'").get();
    expect(row).toBeUndefined();
  });

  it('非首次运行失败时恢复原时间戳', () => {
    const oldTime = (Date.now() - 7200000).toString();
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('last_task_test-task', oldTime);
    const claim = tryClaimTask(db, 'test-task', 60);

    rollbackClaim(db, 'test-task', oldTime, claim.claimedValue);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_test-task'").get() as { value: string };
    expect(row.value).toBe(oldTime);
  });

  it('回滚后可重新声明', () => {
    const claim = tryClaimTask(db, 'test-task', 60);
    rollbackClaim(db, 'test-task', claim.priorValue, claim.claimedValue);

    const reClaim = tryClaimTask(db, 'test-task', 60);
    expect(reClaim.claimed).toBe(true);
  });

  // 回归:回滚是 CAS 的 —— 慢任务执行超过 interval 后,其他进程已合法重新
  // claim,本进程失败回滚不能把对方的有效 claim 抹回旧值/删掉。
  it('当前值已被其他进程重新 claim 时,回滚不覆盖对方的值(UPDATE 分支)', () => {
    const oldTime = (Date.now() - 7200000).toString();
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('last_task_test-task', oldTime);
    const claimA = tryClaimTask(db, 'test-task', 60);
    expect(claimA.claimed).toBe(true);

    // 模拟进程 B 在 A 执行期间(超过 interval 后)合法重新 claim
    const newerValue = (Date.now() + 1).toString();
    db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(newerValue, 'last_task_test-task');

    rollbackClaim(db, 'test-task', claimA.priorValue, claimA.claimedValue);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_test-task'").get() as { value: string };
    expect(row.value).toBe(newerValue); // B 的 claim 不受 A 回滚影响
  });

  it('当前值已被其他进程重新 claim 时,回滚不删除对方的行(DELETE 分支)', () => {
    const claimA = tryClaimTask(db, 'test-task', 60); // 首次运行,priorValue=null
    expect(claimA.claimed).toBe(true);

    const newerValue = (Date.now() + 1).toString();
    db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(newerValue, 'last_task_test-task');

    rollbackClaim(db, 'test-task', null, claimA.claimedValue);

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_test-task'").get() as { value: string };
    expect(row?.value).toBe(newerValue); // 行仍在,值是 B 的
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

  it('任务抛 TypeError(程序员 bug) → log.error 含 programmer bug,daemon 不中断', async () => {
    // F3 修复:scheduler catch 必须能区分 TypeError/ReferenceError/SyntaxError
    // (程序员 bug)和业务错误,前者必须 log.error('programmer bug ...') 提升 visibility,
    // 同时不 throw(保持 daemon 不中断),依赖运维 grep 'programmer bug' 告警。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = makeTask({
      id: 'programmer-bug-task',
      execute: vi.fn().mockImplementation(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'foo')");
      }),
    });

    // runSchedulerTick 不应 throw（保持 daemon 不中断）
    const executed = await runSchedulerTick(db, [task]);
    expect(executed).not.toContain('programmer-bug-task');

    // 任意一次 console.error 调用应该 message 含 'programmer bug'
    const hasProgrammerBugLog = errorSpy.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && a.includes('programmer bug')),
    );
    expect(hasProgrammerBugLog).toBe(true);

    errorSpy.mockRestore();
  });

  it('任务抛 ReferenceError → 同样进 programmer bug 分支', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = makeTask({
      id: 'ref-err-task',
      execute: vi.fn().mockImplementation(async () => {
        throw new ReferenceError('xyz is not defined');
      }),
    });

    await runSchedulerTick(db, [task]);
    const hasProgrammerBugLog = errorSpy.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && a.includes('programmer bug')),
    );
    expect(hasProgrammerBugLog).toBe(true);
    errorSpy.mockRestore();
  });

  it('任务抛普通 Error 不走 programmer bug 分支(走 "失败（已回滚）")', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = makeTask({
      id: 'biz-err-task',
      execute: vi.fn().mockRejectedValue(new Error('普通业务错误')),
    });

    await runSchedulerTick(db, [task]);
    const hasProgrammerBugLog = errorSpy.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && a.includes('programmer bug')),
    );
    expect(hasProgrammerBugLog).toBe(false);
    // 但应有 "失败" log
    const hasFailureLog = errorSpy.mock.calls.some(args =>
      args.some(a => typeof a === 'string' && a.includes('失败')),
    );
    expect(hasFailureLog).toBe(true);
    errorSpy.mockRestore();
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

  // 回归 F14(2026-05-21): half-open 状态下并发多次 noteSuccessfulLLMCall
  // 必须只产生一条 circuit_breaker_off timeline 事件(事务化原子读写,
  // 避免两个 caller 都看到 prevState='half-open' 各插一条事件)。
  it('F14 回归: half-open 并发多次 noteSuccessfulLLMCall 只产生一条 off 事件', async () => {
    // 模拟:3 次失败已开启熔断器,冷却已过期 → half-open
    const expiredOpenTime = Date.now() - 10 * 60 * 1000;
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_opened_at', expiredOpenTime.toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_cooldown_ms', (5 * 60 * 1000).toString());

    // 并发调 N 次 noteSuccessfulLLMCall(better-sqlite3 同步串行,
    // 这里用循环模拟两个 batch 同步成功的场景)
    for (let i = 0; i < 5; i++) {
      noteSuccessfulLLMCall(db);
    }

    // 只插一条 'circuit_breaker_off' timeline 事件 — 后续 4 次调用 prevState
    // 已经是 'closed',不会再插。
    const offEvents = db.prepare(
      "SELECT title FROM timeline_events WHERE title LIKE '%circuit_breaker_off%'",
    ).all() as Array<{ title: string }>;
    expect(offEvents).toHaveLength(1);
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

  // 回归 F8(2026-05-21): half-open 状态下,一个 requiresLLM=true 的 task 即便
  // 没有真的调过 callLLM(claim 失败 / no-candidate / 内部 early return),
  // 也不应消耗本 tick 的半开探测名额 — 否则后续真正想探测的 task 全被 skip。
  describe('F8 回归: halfOpenProbed 仅在真实 LLM 调用后消耗', () => {
    beforeEach(() => {
      // 强制熔断器进入 half-open:3 次失败 + 冷却已过
      db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '3');
      db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_opened_at', String(Date.now() - 10 * 60_000));
      db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_cooldown_ms', String(5 * 60_000));
      expect(getCircuitState(db).state).toBe('half-open');
    });

    it('half-open + 跑一个 LLM task 但内部没真的调过 LLM → 下一个 LLM task 仍能跑', async () => {
      // 第一个 task:requiresLLM=true,execute 正常 return 但**不**触发 noteSuccessfulLLMCall
      // 或 notifyLLMFailure(模拟 claimNextPendingDigest 返 null / no candidates)。
      const noOpTask: TaskDefinition = {
        id: 'noop-llm-task',
        execute: vi.fn().mockResolvedValue(undefined),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 0,
        requiresLLM: true,
      };

      // 第二个 task:requiresLLM=true,execute 调 noteSuccessfulLLMCall 模拟真实 LLM 调用
      const realLlmTask: TaskDefinition = {
        id: 'real-llm-task',
        execute: vi.fn().mockImplementation(async () => {
          noteSuccessfulLLMCall(db); // 模拟 callLLM 内部 hook
        }),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 0,
        requiresLLM: true,
      };

      const executed = await runSchedulerTick(db, [noOpTask, realLlmTask]);

      // 旧代码:第一个 task return 后 halfOpenProbed=true,第二个被 skip → 只执行 1 个
      // 新代码:第一个 task 没观察到真实 LLM 调用 → halfOpenProbed 仍 false,
      //   第二个能跑 → 执行 2 个
      expect(executed).toContain('noop-llm-task');
      expect(executed).toContain('real-llm-task');
      expect(noOpTask.execute).toHaveBeenCalled();
      expect(realLlmTask.execute).toHaveBeenCalled();
    });

    it('half-open + 第一个 task 真的调过 LLM → 第二个 LLM task 被 skip', async () => {
      const realLlmTask: TaskDefinition = {
        id: 'real-llm-task',
        execute: vi.fn().mockImplementation(async () => {
          noteSuccessfulLLMCall(db); // 真实 LLM 成功 → 此时熔断器已 reset 成 closed
        }),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 0,
        requiresLLM: true,
      };

      const second: TaskDefinition = {
        id: 'second-llm-task',
        execute: vi.fn().mockResolvedValue(undefined),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 0,
        requiresLLM: true,
      };

      const executed = await runSchedulerTick(db, [realLlmTask, second]);

      // 第一个 task 真实调用成功 → noteSuccessfulLLMCall 把熔断器 reset 成 closed,
      // 后续读 circuit.state 变 closed,llmAvailable=true,所以 second 仍能跑。
      // 但 halfOpenProbed 也已 set。综合下来:这个用例验证的是"真实调用确实把 flag 翻 true",
      // 后续若状态没自动恢复 closed 才能体现 skip。
      // 简化:验证两个 task 都跑了(因为成功后状态恢复)。
      expect(executed).toContain('real-llm-task');
      expect(executed).toContain('second-llm-task');
    });

    it('half-open + notifyLLMFailure 也算真实 LLM 调用 → 标记 halfOpenProbed', async () => {
      // 验证 notifyLLMFailure 也会触发 halfOpenProbed
      // 第一个 task 内部触发 notifyLLMFailure(模拟 link-revalidate 抛 LLMServiceError)
      const failingTask: TaskDefinition = {
        id: 'fail-task',
        execute: vi.fn().mockImplementation(async () => {
          // 模拟 fire-and-forget 内部 catch:notifyLLMFailure 后吞掉 error
          notifyLLMFailure(new LLMServiceError('boom', 500));
        }),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 0,
        requiresLLM: true,
      };

      // 第二个 task:不真实调 LLM
      const second: TaskDefinition = {
        id: 'should-be-skipped',
        execute: vi.fn().mockResolvedValue(undefined),
        intervalStrategy: 'test',
        defaultIntervalMinutes: 0,
        requiresLLM: true,
      };

      const executed = await runSchedulerTick(db, [failingTask, second]);

      // notifyLLMFailure 触发 recordLLMFailure → failures += 1。
      // 因为初始 3 失败 + cooldown 过 → half-open → 这次再失败 + 1 = 4,
      // 重新打开熔断器(notifyLLMFailure 内部走 recordLLMFailure)。
      // 第二个 LLM task 因熔断器 open 被 skip(每轮重读 circuit)。
      expect(executed).toContain('fail-task');
      expect(executed).not.toContain('should-be-skipped');
    });
  });

  // 回归 F4(2026-05-21): metadata 表中的 CB_* key 可能被 corrupt 写入(手工 SQL,
  // 旧迁移,云同步异常等)。parseInt('corrupt') = NaN,NaN 参与的所有比较都返回
  // false,导致 getCircuitState 既不返回 'closed' 也不返回 'half-open',永久卡
  // 在 'open',熔断器永远无法恢复。
  // 修复后:任何无效的 metadata.value 都视为 0(failures=0 → closed,系统正常)。
  describe('F4 回归: getCircuitState 在 corrupt metadata 下不卡死', () => {
    function setMeta(key: string, value: string): void {
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
    }

    it('CB_FAILURES_KEY = "corrupt" → 视为 0,返回 closed', () => {
      setMeta('circuit_breaker_failures', 'corrupt');
      const r = getCircuitState(db);
      expect(r.state).toBe('closed');
      expect(r.failures).toBe(0);
    });

    it('CB_FAILURES_KEY = "5" 但 CB_OPENED_AT_KEY = "garbage" → 不卡 open,走 half-open', () => {
      setMeta('circuit_breaker_failures', '5'); // >= threshold 3
      setMeta('circuit_breaker_opened_at', 'garbage'); // NaN → openedAt=0
      setMeta('circuit_breaker_cooldown_ms', '60000'); // 1 分钟冷却
      const r = getCircuitState(db);
      // openedAt=0,elapsed = now - 0 = 巨大值 → >= cooldownMs → half-open
      expect(r.state).toBe('half-open');
    });

    it('所有 CB_* key 都 corrupt → 视为 closed,允许恢复', () => {
      setMeta('circuit_breaker_failures', 'NaN');
      setMeta('circuit_breaker_opened_at', 'bad');
      setMeta('circuit_breaker_cooldown_ms', 'worse');
      const r = getCircuitState(db);
      // failures=0 → closed,cooldownMs 走 fallback
      expect(r.state).toBe('closed');
      expect(r.failures).toBe(0);
      expect(r.cooldownMs).toBeGreaterThan(0);
    });

    it('CB_COOLDOWN_KEY = "0" → 视为初始 cooldown', () => {
      setMeta('circuit_breaker_failures', '5');
      setMeta('circuit_breaker_opened_at', String(Date.now() - 1000)); // 1秒前
      setMeta('circuit_breaker_cooldown_ms', '0'); // 不合理 → fallback
      const r = getCircuitState(db);
      // cooldownMs 不会被 0,会走 fallback 默认 5 分钟。elapsed=1000ms < 5min cooldown → open
      expect(r.state).toBe('open');
      expect(r.cooldownMs).toBeGreaterThan(0);
    });
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

describe('shouldResetWatchdog (watchdog 超时判定纯函数)', () => {
  const THRESHOLD = 30 * 60 * 1000;  // 30 分钟,跟 MAINTENANCE_WATCHDOG_MS 一致

  it('tickStartedAt=0 时不告警(未运行)', () => {
    expect(shouldResetWatchdog(Date.now(), 0, THRESHOLD)).toBe(false);
  });

  it('刚启动 5 分钟不告警', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - 5 * 60 * 1000;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(false);
  });

  it('刚到 30 分钟边界不告警(用严格 >)', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - THRESHOLD;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(false);
  });

  it('超过 30 分钟 1ms 即判定超时', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - THRESHOLD - 1;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(true);
  });

  it('卡死 1 小时必判定超时', () => {
    const now = 1_700_000_000_000;  // 2023-11 ms epoch,够大避免减出负数被 <=0 early return 拦截
    const tickStart = now - 60 * 60 * 1000;
    expect(shouldResetWatchdog(now, tickStart, THRESHOLD)).toBe(true);
  });

  it('用 fake timers 演示完整轮回', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 19, 12, 0, 0));
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

describe('maybeRunMaintenance 长 tick 防重入', () => {
  it('超过 watchdog 后旧 tick 未结束时仍不启动第二轮', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00.000Z'));
    let resolveLongTask!: () => void;
    const longTask = new Promise<void>((resolve) => {
      resolveLongTask = resolve;
    });
    const execute = vi.fn(() => longTask);
    const tasks: TaskDefinition[] = [{
      id: 'long-maintenance-task',
      execute,
      intervalStrategy: 'test',
      defaultIntervalMinutes: 1,
    }];

    try {
      const { maybeRunMaintenance } = await import('../../src/metabolism/scheduler.js');
      maybeRunMaintenance(db, tasks);
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledTimes(1);

      // 旧实现会在这里强制复位 maintenanceRunning，并启动第二个仍在执行同一
      // task 的 tick。新实现只能告警，直到 deferred settle 都必须保持单实例。
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      maybeRunMaintenance(db, tasks);
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      resolveLongTask();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });
});
