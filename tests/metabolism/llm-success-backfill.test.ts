/**
 * backfillLlmLastSuccessAt 单元测试
 *
 * 核心约束:冷启 backfill 必须按 subtype 白名单过滤,绝不能把 daemon_start /
 * 笔记同步 / circuit_breaker_on(LLM 失败)等非 LLM 事件误当作"LLM 曾成功"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import { backfillLlmLastSuccessAt, LLM_SUCCESS_SUBTYPES } from '../../src/metabolism/llm-success-backfill.js';

let db: Database.Database;

function insertEvent(type: string, subtype: string, created: string): void {
  db.prepare(`
    INSERT INTO timeline_events (type, subtype, title, created, actor)
    VALUES (?, ?, ?, ?, 'brain')
  `).run(type, subtype, JSON.stringify({ key: subtype }), created);
}

function getBackfilled(): string | undefined {
  const row = db.prepare("SELECT value FROM metadata WHERE key = 'llm_last_success_at'")
    .get() as { value: string } | undefined;
  return row?.value;
}

beforeEach(() => {
  db = setupTestDb();
});

describe('backfillLlmLastSuccessAt', () => {
  it('只认白名单 subtype(annotate 等)的最近时间', () => {
    insertEvent('memory', 'annotate', '2026-01-01T00:00:00.000Z');
    backfillLlmLastSuccessAt(db);
    expect(getBackfilled()).toBe(String(Date.parse('2026-01-01T00:00:00.000Z')));
  });

  it('忽略 daemon_start 等非 LLM 事件——只有 daemon_start 时不 backfill', () => {
    insertEvent('memory', 'daemon_start', '2026-02-01T00:00:00.000Z');
    insertEvent('memory', 'logseq_sync', '2026-02-02T00:00:00.000Z');
    insertEvent('config', 'circuit_breaker_on', '2026-02-03T00:00:00.000Z'); // LLM 失败事件
    insertEvent('memory', 'synaptic_scaling', '2026-02-04T00:00:00.000Z');
    insertEvent('think_associate', 'pending_link_gc', '2026-02-05T00:00:00.000Z');

    backfillLlmLastSuccessAt(db);

    // 没有任何白名单事件 → 不写,留 null 走保守分支
    expect(getBackfilled()).toBeUndefined();
  });

  it('白名单事件早于非 LLM 事件时,仍只取白名单的时间(不被更晚的 daemon_start 污染)', () => {
    insertEvent('memory', 'annotate', '2026-03-01T00:00:00.000Z');       // 白名单,较早
    insertEvent('memory', 'daemon_start', '2026-03-10T00:00:00.000Z');   // 非 LLM,较晚
    insertEvent('memory', 'logseq_sync', '2026-03-11T00:00:00.000Z');    // 非 LLM,最晚

    backfillLlmLastSuccessAt(db);

    // 必须是 annotate 的时间,而非更晚的 daemon_start/sync
    expect(getBackfilled()).toBe(String(Date.parse('2026-03-01T00:00:00.000Z')));
  });

  it('取白名单事件里最近的一条', () => {
    insertEvent('memory', 'annotate', '2026-04-01T00:00:00.000Z');
    insertEvent('think_associate', 'link_classify', '2026-04-05T00:00:00.000Z');
    insertEvent('memory', 'crystal_update', '2026-04-03T00:00:00.000Z');

    backfillLlmLastSuccessAt(db);

    expect(getBackfilled()).toBe(String(Date.parse('2026-04-05T00:00:00.000Z')));
  });

  it('已有 llm_last_success_at 时不覆盖(只兜底一次)', () => {
    db.prepare("INSERT INTO metadata (key, value) VALUES ('llm_last_success_at', '12345')").run();
    insertEvent('memory', 'annotate', '2026-05-01T00:00:00.000Z');

    backfillLlmLastSuccessAt(db);

    expect(getBackfilled()).toBe('12345');
  });

  it('白名单覆盖四类 LLM 驱动任务的 subtype', () => {
    expect([...LLM_SUCCESS_SUBTYPES].sort()).toEqual(
      ['annotate', 'crystal_update', 'link_classify', 'refine_links'],
    );
  });
});
