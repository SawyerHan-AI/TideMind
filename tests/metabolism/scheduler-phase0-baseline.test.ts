/**
 * 最小性能方案 Phase 0 基线。
 *
 * 这些测试记录 Phase 0 基线并锁定最小 owner 修复：
 * - 单次 runSchedulerTick 内任务严格串行；
 * - 两个独立 scheduler 入口不能穿越正在运行的上游；
 * - 同步任务会占住调用线程，证明 Electron main 直调会阻塞事件循环；
 * - observer 不改变默认业务语义。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    constructor(message: string) {
      super(message);
      this.name = 'LLMServiceError';
    }
  }
  return { callLLM: vi.fn(), LLMServiceError };
});

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import {
  runSchedulerTick,
  SchedulerClaimRollbackUnconfirmedError,
  type SchedulerObservation,
  type TaskDefinition,
} from '../../src/metabolism/scheduler.js';

const openDbs: Database.Database[] = [];

function makeDb(): Database.Database {
  const db = setupTestDb();
  openDbs.push(db);
  return db;
}

function task(id: string, execute: TaskDefinition['execute']): TaskDefinition {
  return {
    id,
    execute,
    intervalStrategy: 'phase0-baseline',
    defaultIntervalMinutes: 60,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe('scheduler Phase 0 baseline', () => {
  it('单个入口内严格等待上游 settle 后才启动下游', async () => {
    const db = makeDb();
    const upstreamMayFinish = deferred();
    const upstreamStarted = deferred();
    const order: string[] = [];

    const run = runSchedulerTick(db, [
      task('upstream', async () => {
        order.push('upstream:start');
        upstreamStarted.resolve();
        await upstreamMayFinish.promise;
        order.push('upstream:finish');
      }),
      task('downstream', async () => {
        order.push('downstream:start');
      }),
    ]);

    await upstreamStarted.promise;
    expect(order).toEqual(['upstream:start']);
    upstreamMayFinish.resolve();
    await run;
    expect(order).toEqual(['upstream:start', 'upstream:finish', 'downstream:start']);
  });

  it('owner锁让独立入口在上游运行时整轮退出，不能启动下游', async () => {
    const db = makeDb();
    const upstreamMayFinish = deferred();
    const upstreamStarted = deferred();
    const order: string[] = [];

    const tasks = [
      task('shared-upstream', async () => {
        order.push('entry-a:upstream:start');
        upstreamStarted.resolve();
        await upstreamMayFinish.promise;
        order.push('entry-a:upstream:finish');
      }),
      task('shared-downstream', async () => {
        order.push('downstream:start');
      }),
    ];

    const entryA = runSchedulerTick(db, tasks);
    await upstreamStarted.promise;
    const entryBEvents: SchedulerObservation[] = [];
    const entryB = runSchedulerTick(db, tasks, {
      observer: (event) => entryBEvents.push(event),
    });
    expect(await entryB).toEqual([]);

    expect(order).toEqual(['entry-a:upstream:start']);
    expect(entryBEvents).toEqual([
      expect.objectContaining({ type: 'tick_skipped', reason: 'owner_busy' }),
    ]);
    upstreamMayFinish.resolve();
    await entryA;

    expect(order).toEqual([
      'entry-a:upstream:start',
      'entry-a:upstream:finish',
      'downstream:start',
    ]);
  });

  it('同步任务运行期间调用线程不能处理setImmediate', async () => {
    const db = makeDb();
    let eventLoopAdvanced = false;
    const turn = new Promise<void>((resolve) => {
      setImmediate(() => {
        eventLoopAdvanced = true;
        resolve();
      });
    });

    await runSchedulerTick(db, [
      task('synchronous-work', async () => {
        const until = Date.now() + 20;
        while (Date.now() < until) {
          // 模拟better-sqlite3/同步JS占用调用线程。
        }
      }),
    ]);

    expect(eventLoopAdvanced).toBe(false);
    await turn;
    expect(eventLoopAdvanced).toBe(true);
  });

  it('task扫描阶段抛错仍释放owner，下一轮可以运行', async () => {
    const db = makeDb();
    await expect(runSchedulerTick(db, [
      {
        ...task('broken-gate', async () => {}),
        gateCheck: () => {
          throw new Error('gate failed');
        },
      },
    ])).rejects.toThrow('gate failed');

    await expect(runSchedulerTick(db, [task('recovered', async () => {})])).resolves.toEqual([
      'recovered',
    ]);
  });

  it('foreground预算在一个成功claim的attempt后停止，失败也消耗预算', async () => {
    const db = makeDb();
    const order: string[] = [];
    const executed = await runSchedulerTick(
      db,
      [
        task('first-fails', async () => {
          order.push('first');
          throw new Error('expected failure');
        }),
        task('second', async () => {
          order.push('second');
        }),
      ],
      { maxAttempts: 1 },
    );

    expect(executed).toEqual([]);
    expect(order).toEqual(['first']);
  });

  it('claim后的失败若rollback遇到BUSY必须显式降级，不能伪装成安全延后', async () => {
    const db = makeDb();
    const prepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('DELETE FROM metadata WHERE key = ? AND value = ?')) {
        throw Object.assign(new Error('database is busy during rollback'), { code: 'SQLITE_BUSY' });
      }
      return prepare(sql);
    });

    await expect(runSchedulerTick(db, [
      task('rollback-busy', async () => {
        throw new Error('definite task failure');
      }),
    ])).rejects.toBeInstanceOf(SchedulerClaimRollbackUnconfirmedError);

    prepareSpy.mockRestore();
    const retained = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_rollback-busy'").get();
    expect(retained).toBeTruthy();
  });

  it('background运行中切到foreground或paused会在当前task boundary停止新admission', async () => {
    const db = makeDb();
    let mayContinue = true;
    const order: string[] = [];
    const executed = await runSchedulerTick(
      db,
      [
        task('first', async () => {
          order.push('first');
        }),
        task('second', async () => {
          order.push('second');
        }),
      ],
      {
        yieldAfterAttempt: async () => {
          order.push('yield');
          mayContinue = false;
        },
        continueAfterAttempt: () => mayContinue,
      },
    );

    expect(executed).toEqual(['first']);
    expect(order).toEqual(['first', 'yield']);
  });

  it('observer记录顺序与耗时且自身异常不改变任务结果', async () => {
    const db = makeDb();
    const events: SchedulerObservation[] = [];
    const nowValues = [100, 110, 145, 160];

    const executed = await runSchedulerTick(
      db,
      [task('observed', async () => {})],
      {
        now: () => nowValues.shift() ?? 160,
        observer: (event) => {
          events.push(event);
          if (event.type === 'task_started') throw new Error('observer failure');
        },
      },
    );

    expect(executed).toEqual(['observed']);
    expect(events.map((event) => event.type)).toEqual([
      'tick_started',
      'task_started',
      'task_finished',
      'tick_finished',
    ]);
    expect(events[2]).toMatchObject({
      type: 'task_finished',
      taskId: 'observed',
      durationMs: 35,
    });
    expect(events[3]).toMatchObject({
      type: 'tick_finished',
      durationMs: 60,
      executedTaskIds: ['observed'],
    });
  });
});
