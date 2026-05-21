/**
 * B-3 (audit-10, 2026-05-21): Embedding 失败熔断器(独立于 LLM)。
 *
 * 背景: LLM 和 embedding provider 可以是不同账户 / quota / API key。
 * Embedding API 全挂时,仍把 requiresEmbedding 的任务调度过去 → 持续浪费
 * scheduler slot + quota; 反过来同理。两个熔断器必须独立。
 *
 * 这里只测 scheduler 层的判定逻辑 + 状态机,不测 getEmbedding 本身
 * (provider 调用走 e2e fixture 更合适)。
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
  runSchedulerTick,
  getEmbeddingCircuitState,
  recordEmbeddingSuccess,
  recordEmbeddingFailure,
  type TaskDefinition,
} from '../../src/metabolism/scheduler.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
});

function makeTask(overrides: Partial<TaskDefinition> & { id: string }): TaskDefinition {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    intervalStrategy: 'test',
    defaultIntervalMinutes: 1,
    ...overrides,
  };
}

// ── getEmbeddingCircuitState 状态机 ──────────────────────────

describe('getEmbeddingCircuitState 状态机', () => {
  it('初始状态 = closed, failures=0', () => {
    const state = getEmbeddingCircuitState(db);
    expect(state.state).toBe('closed');
    expect(state.failures).toBe(0);
  });

  it('1 次失败 → 仍 closed', () => {
    recordEmbeddingFailure(db, 'err 1');
    const state = getEmbeddingCircuitState(db);
    expect(state.state).toBe('closed');
    expect(state.failures).toBe(1);
  });

  it('累积 3 次失败 → open', () => {
    recordEmbeddingFailure(db, 'err 1');
    recordEmbeddingFailure(db, 'err 2');
    recordEmbeddingFailure(db, 'err 3');
    const state = getEmbeddingCircuitState(db);
    expect(state.state).toBe('open');
    expect(state.failures).toBe(3);
  });

  it('冷却到期后 → half-open', () => {
    // 模拟 3 次失败,但 opened_at 在 cooldown 之外
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_opened_at', (Date.now() - 10 * 60_000).toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_cooldown_ms', (5 * 60_000).toString());
    const state = getEmbeddingCircuitState(db);
    expect(state.state).toBe('half-open');
  });

  it('recordEmbeddingSuccess 把 open/half-open 重置为 closed', () => {
    // 先打开
    for (let i = 0; i < 3; i++) recordEmbeddingFailure(db, 'err');
    expect(getEmbeddingCircuitState(db).state).toBe('open');

    recordEmbeddingSuccess(db);
    const state = getEmbeddingCircuitState(db);
    expect(state.state).toBe('closed');
    expect(state.failures).toBe(0);
  });

  it('half-open 后第一次成功 → close + 发 embedding_circuit_breaker_off 事件', () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_opened_at', (Date.now() - 10 * 60_000).toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_cooldown_ms', (5 * 60_000).toString());

    expect(getEmbeddingCircuitState(db).state).toBe('half-open');

    recordEmbeddingSuccess(db);

    // 事件已发
    const offEvents = db.prepare(
      "SELECT title FROM timeline_events WHERE title LIKE '%embedding_circuit_breaker_off%'",
    ).all() as Array<{ title: string }>;
    expect(offEvents).toHaveLength(1);

    // 计数已清
    expect(getEmbeddingCircuitState(db).state).toBe('closed');
  });

  it('达到阈值时发 embedding_circuit_breaker_on 事件', () => {
    recordEmbeddingFailure(db, 'err 1');
    recordEmbeddingFailure(db, 'err 2');
    recordEmbeddingFailure(db, 'err 3');

    const onEvents = db.prepare(
      "SELECT title FROM timeline_events WHERE title LIKE '%embedding_circuit_breaker_on%'",
    ).all() as Array<{ title: string }>;
    expect(onEvents).toHaveLength(1);
  });

  it('错误消息截断到 500 字符', () => {
    const long = 'x'.repeat(2000);
    recordEmbeddingFailure(db, long);
    const row = db.prepare(
      "SELECT value FROM metadata WHERE key = 'embedding_last_error'",
    ).get() as { value: string };
    expect(row.value.length).toBeLessThanOrEqual(500);
  });

  it('容错 NaN value(corrupt metadata)→ 回退为初始 closed', () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES ('embedding_circuit_failures', 'not-a-number')").run();
    const state = getEmbeddingCircuitState(db);
    expect(state.state).toBe('closed');
    expect(state.failures).toBe(0);
  });
});

// ── runSchedulerTick 集成判定 ────────────────────────────────

describe('runSchedulerTick: requiresEmbedding gating', () => {
  it('embedding 熔断器 open → requiresEmbedding 任务被 skip', async () => {
    // 直接置 open
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_opened_at', Date.now().toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_cooldown_ms', (60 * 60_000).toString());

    const embTask = makeTask({ id: 'emb-needy', requiresEmbedding: true });
    const normalTask = makeTask({ id: 'normal' });

    const executed = await runSchedulerTick(db, [embTask, normalTask]);
    expect(executed).not.toContain('emb-needy');
    expect(executed).toContain('normal');
  });

  it('embedding 熔断器 closed → requiresEmbedding 任务正常跑', async () => {
    const embTask = makeTask({ id: 'emb-needy', requiresEmbedding: true });
    const executed = await runSchedulerTick(db, [embTask]);
    expect(executed).toContain('emb-needy');
  });

  it('embedding 熔断器 half-open → requiresEmbedding 任务允许探测', async () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_opened_at', (Date.now() - 10 * 60_000).toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_cooldown_ms', (5 * 60_000).toString());

    const embTask = makeTask({ id: 'emb-needy', requiresEmbedding: true });
    const executed = await runSchedulerTick(db, [embTask]);
    expect(executed).toContain('emb-needy');
  });

  it('LLM 熔断器 open + embedding 健康 → requiresLLM 任务 skip, requiresEmbedding 任务跑', async () => {
    // LLM open
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '5');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_opened_at', Date.now().toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_cooldown_ms', (60 * 60_000).toString());

    const llmTask = makeTask({ id: 'llm-only', requiresLLM: true });
    const embTask = makeTask({ id: 'emb-only', requiresEmbedding: true });

    const executed = await runSchedulerTick(db, [llmTask, embTask]);
    expect(executed).not.toContain('llm-only');
    expect(executed).toContain('emb-only');
  });

  it('embedding 熔断器 open + LLM 健康 → requiresEmbedding 任务 skip, requiresLLM 任务跑', async () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_opened_at', Date.now().toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_cooldown_ms', (60 * 60_000).toString());

    const llmTask = makeTask({ id: 'llm-only', requiresLLM: true });
    const embTask = makeTask({ id: 'emb-only', requiresEmbedding: true });

    const executed = await runSchedulerTick(db, [llmTask, embTask]);
    expect(executed).toContain('llm-only');
    expect(executed).not.toContain('emb-only');
  });

  it('两个熔断器同时 open → 两类 task 都 skip,普通 task 仍跑', async () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_failures', '5');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_opened_at', Date.now().toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('circuit_breaker_cooldown_ms', (60 * 60_000).toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_failures', '3');
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_opened_at', Date.now().toString());
    db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run('embedding_circuit_cooldown_ms', (60 * 60_000).toString());

    const llmTask = makeTask({ id: 'llm', requiresLLM: true });
    const embTask = makeTask({ id: 'emb', requiresEmbedding: true });
    const bothTask = makeTask({ id: 'both', requiresLLM: true, requiresEmbedding: true });
    const normal = makeTask({ id: 'normal' });

    const executed = await runSchedulerTick(db, [llmTask, embTask, bothTask, normal]);
    expect(executed).not.toContain('llm');
    expect(executed).not.toContain('emb');
    expect(executed).not.toContain('both');
    expect(executed).toContain('normal');
  });
});
