/**
 * db/pending-digests.ts 单元测试
 *
 * 重试队列的状态机：enqueue → claim → complete/fail
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import type Database from 'better-sqlite3';
import { setupTestDb } from '../helpers/test-db.js';
import {
  enqueuePendingDigest,
  claimNextPendingDigest,
  completePendingDigest,
  failPendingDigest,
  getFailedDigests,
  getPendingDigestCount,
} from '../../src/db/pending-digests.js';

let db: Database.Database;

beforeEach(() => {
  db = setupTestDb();
  // 确保 pending_digests 表存在（schema 应该自动创建）
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enqueuePendingDigest', () => {
  it('入队一条 pending digest', () => {
    enqueuePendingDigest(db, 'trace-1', '{"content":"test"}', 'LLM timeout');

    const count = getPendingDigestCount(db);
    expect(count.pending).toBe(1);
    expect(count.failed).toBe(0);
  });

  it('多次入队创建独立记录', () => {
    enqueuePendingDigest(db, 'trace-1', '{}', 'err1');
    enqueuePendingDigest(db, 'trace-2', '{}', 'err2');

    const count = getPendingDigestCount(db);
    expect(count.pending).toBe(2);
  });
});

describe('claimNextPendingDigest', () => {
  it('空队列返回 null', () => {
    expect(claimNextPendingDigest(db)).toBeNull();
  });

  it('claim 后记录变为 processing', () => {
    // 要让 next_retry_at 早于当前时间才能 claim
    // 直接插入一条 next_retry_at 在过去的记录
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES ('pd-1', 'trace-1', '{}', 'pending', 'err', 0, ?, ?)
    `).run(pastTime, pastTime);

    const claimed = claimNextPendingDigest(db);
    expect(claimed).not.toBeNull();
    expect(claimed!.trace_id).toBe('trace-1');

    // 再 claim 应该为空（已变为 processing）
    expect(claimNextPendingDigest(db)).toBeNull();
  });

  it('未到重试时间的不会被 claim', () => {
    const futureTime = new Date(Date.now() + 600_000).toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES ('pd-2', 'trace-2', '{}', 'pending', 'err', 0, ?, ?)
    `).run(new Date().toISOString(), futureTime);

    expect(claimNextPendingDigest(db)).toBeNull();
  });
});

describe('completePendingDigest', () => {
  it('完成后记录被删除', () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES ('pd-c', 'trace-c', '{}', 'processing', 'err', 0, ?, ?)
    `).run(pastTime, pastTime);

    completePendingDigest(db, 'pd-c');
    expect(getPendingDigestCount(db)).toEqual({ pending: 0, failed: 0 });
  });
});

describe('failPendingDigest', () => {
  it('第一次失败 → 重回 pending，retry_count +1', () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES ('pd-f1', 'trace-f', '{}', 'processing', 'err', 0, ?, ?)
    `).run(pastTime, pastTime);

    failPendingDigest(db, 'pd-f1', 'retry error');

    const row = db.prepare('SELECT * FROM pending_digests WHERE id = ?').get('pd-f1') as any;
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
    expect(row.error_message).toBe('retry error');
  });

  it('达到最大重试次数 → 标记为 failed', () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES ('pd-f2', 'trace-f2', '{}', 'processing', 'err', 2, ?, ?)
    `).run(pastTime, pastTime);

    failPendingDigest(db, 'pd-f2', 'final error');

    const row = db.prepare('SELECT * FROM pending_digests WHERE id = ?').get('pd-f2') as any;
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(3);
    expect(row.completed_at).toBeTruthy();
  });
});

describe('getFailedDigests', () => {
  it('返回 failed 状态的记录', () => {
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES ('pd-g1', 'trace-g1', '{}', 'failed', 'permanent error', 3, '2026-04-01', '2026-04-01')
    `).run();

    const failed = getFailedDigests(db);
    expect(failed).toHaveLength(1);
    expect(failed[0].trace_id).toBe('trace-g1');
    expect(failed[0].error_message).toBe('permanent error');
  });

  it('不返回 pending 状态的记录', () => {
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES ('pd-g2', 'trace-g2', '{}', 'pending', 'err', 0, '2026-04-01', '2026-04-01')
    `).run();

    expect(getFailedDigests(db)).toHaveLength(0);
  });
});

describe('getPendingDigestCount', () => {
  it('空表返回全 0', () => {
    expect(getPendingDigestCount(db)).toEqual({ pending: 0, failed: 0 });
  });

  it('正确统计各状态', () => {
    const t = '2026-04-01';
    db.prepare(`INSERT INTO pending_digests (id,trace_id,input_json,status,error_message,retry_count,created,next_retry_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run('a', 'ta', '{}', 'pending', '', 0, t, t);
    db.prepare(`INSERT INTO pending_digests (id,trace_id,input_json,status,error_message,retry_count,created,next_retry_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run('b', 'tb', '{}', 'processing', '', 0, t, t);
    db.prepare(`INSERT INTO pending_digests (id,trace_id,input_json,status,error_message,retry_count,created,next_retry_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run('c', 'tc', '{}', 'failed', '', 3, t, t);

    const count = getPendingDigestCount(db);
    expect(count.pending).toBe(2); // pending + processing
    expect(count.failed).toBe(1);
  });
});
