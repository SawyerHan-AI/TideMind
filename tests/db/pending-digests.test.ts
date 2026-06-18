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

  it('F5 修复: processing_started_at 是 ISO 时,15 分钟前的 stale 行必须被 reset 回 pending', () => {
    // 历史 bug:`processing_started_at < datetime('now', '-10 minutes')`,
    // SQLite datetime 返回空格分隔无 Z 格式,跟 ISO 字典序比较时 ISO 永远 ">"
    // → stale 条件永远不触发,卡住的 processing 行无限存在。
    // 改成 JS 算 ISO cutoff 后,这条 15 分钟前的 stale 行应该被 reset。
    //
    // 注:next_retry_at 设在未来,避免 stale recovery reset 回 pending 后被同次
    // claim 当场捡走又变回 processing(测试无法观测到中间 pending 状态)。
    const fifteenMinAgoIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const nowIso = new Date().toISOString();
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at, processing_started_at)
      VALUES ('pd-stale', 'trace-stale', '{}', 'processing', 'err', 0, ?, ?, ?)
    `).run(nowIso, futureIso, fifteenMinAgoIso);

    // claimNextPendingDigest 内部第一步就是 stale recovery
    claimNextPendingDigest(db);

    const row = db.prepare(
      'SELECT status, processing_started_at, retry_count FROM pending_digests WHERE id = ?',
    ).get('pd-stale') as { status: string; processing_started_at: string | null; retry_count: number };

    expect(row.status).toBe('pending');
    expect(row.processing_started_at).toBeNull();
    expect(row.retry_count).toBe(1);
  });

  it('F5 修复: 5 分钟前的 processing 行(尚未到 10 分钟 stale 阈值)不应被 reset', () => {
    const fiveMinAgoIso = new Date(Date.now() - 5 * 60_000).toISOString();
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at, processing_started_at)
      VALUES ('pd-fresh', 'trace-fresh', '{}', 'processing', 'err', 0, ?, ?, ?)
    `).run(nowIso, nowIso, fiveMinAgoIso);

    claimNextPendingDigest(db);

    const row = db.prepare(
      'SELECT status, processing_started_at, retry_count FROM pending_digests WHERE id = ?',
    ).get('pd-fresh') as { status: string; processing_started_at: string | null; retry_count: number };

    // 仍是 processing,not reset
    expect(row.status).toBe('processing');
    expect(row.processing_started_at).toBe(fiveMinAgoIso);
    expect(row.retry_count).toBe(0);
  });

  it('stale recovery 达到 MAX_RETRIES 上限 → 转 failed,不再被重认领(毒丸防护)', () => {
    // 进程崩溃路径走不到 failPendingDigest,stale recovery 必须自带上限,
    // 否则崩溃型 digest 会跨重启被无限重认领。
    const fifteenMinAgoIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at, processing_started_at)
      VALUES ('pd-poison', 'trace-poison', '{}', 'processing', 'err', 2, ?, ?, ?)
    `).run(nowIso, fifteenMinAgoIso, fifteenMinAgoIso);

    // stale recovery: retry_count 2+1 >= 3 → failed,且同次调用不会再 claim 到它
    expect(claimNextPendingDigest(db)).toBeNull();

    const row = db.prepare(
      'SELECT status, retry_count, completed_at, error_message FROM pending_digests WHERE id = ?',
    ).get('pd-poison') as { status: string; retry_count: number; completed_at: string | null; error_message: string };

    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(3);
    expect(row.completed_at).toBeTruthy();
    expect(row.error_message).toContain('stale recovery exhausted');
    expect(getFailedDigests(db).map(d => d.id)).toContain('pd-poison');
  });

  it('stale recovery 未达上限 → 仍回 pending(原有恢复语义不变)', () => {
    const fifteenMinAgoIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const nowIso = new Date().toISOString();
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(`
      INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at, processing_started_at)
      VALUES ('pd-stale-2', 'trace-stale-2', '{}', 'processing', 'first err', 1, ?, ?, ?)
    `).run(nowIso, futureIso, fifteenMinAgoIso);

    claimNextPendingDigest(db);

    const row = db.prepare(
      'SELECT status, retry_count, error_message FROM pending_digests WHERE id = ?',
    ).get('pd-stale-2') as { status: string; retry_count: number; error_message: string };

    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(2);
    // 未达上限时不覆盖原 error_message
    expect(row.error_message).toBe('first err');
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

// 2026-05-21 回归:digest.ts 异步 catch 路径里 SELECT 找 pending 行的语句
// 必须过滤 status,否则会把已经 terminal 的 'failed' 行复活回 'pending'。
// 这里直接演练这条 SELECT 语句的语义。
describe('digest catch-path race: SELECT must filter status', () => {
  it('同 traceId 有 failed 终态行时,带 status 过滤的 SELECT 应该跳过它', () => {
    const t = '2026-04-01';
    db.prepare(`INSERT INTO pending_digests
      (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pd-failed', 'trace-race', '{}', 'failed', 'gave up', 3, t, t, t);

    // 修复后的 SELECT(过滤 status)— 找不到这行
    const filtered = db.prepare(
      "SELECT id FROM pending_digests WHERE trace_id = ? AND status IN ('pending', 'processing')"
    ).get('trace-race') as { id: string } | undefined;
    expect(filtered).toBeUndefined();

    // 旧 SELECT(不过滤)— 会捞到这条 terminal 行
    const unfiltered = db.prepare(
      "SELECT id FROM pending_digests WHERE trace_id = ?"
    ).get('trace-race') as { id: string } | undefined;
    expect(unfiltered?.id).toBe('pd-failed');
  });

  it('failPendingDigest 误调用在 failed 行上会把它复活为 pending — 这就是 bug', () => {
    // 直接调用 failPendingDigest 模拟"旧 SELECT 捞到 failed 行 → 调 fail" 的场景
    const t = '2026-04-01';
    db.prepare(`INSERT INTO pending_digests
      (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      // retry_count = 0,这样 fail 后 retry_count+1=1 < 3(MAX_RETRIES),状态会被 SET 成 'pending'
      // 但我们手动写了 status='failed' 模拟它已经在终态(也许通过其他路径,比如 schema 重置)
      .run('pd-revived', 'trace-revive', '{}', 'failed', 'gave up', 0, t, t, t);

    failPendingDigest(db, 'pd-revived', 'spurious retry');
    const row = db.prepare("SELECT status, retry_count FROM pending_digests WHERE id = 'pd-revived'")
      .get() as { status: string; retry_count: number };
    // 这正是要避免的:failed 被无意义地复活为 pending → 卡住 retry 队列
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  it('同 traceId 同时存在 failed + processing 时,filter 后只挑活跃那条', () => {
    const t = '2026-04-01';
    db.prepare(`INSERT INTO pending_digests
      (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pd-old-failed', 'trace-mix', '{}', 'failed', 'gave up', 3, t, t);
    db.prepare(`INSERT INTO pending_digests
      (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pd-active', 'trace-mix', '{}', 'processing', '', 0, t, t);

    const picked = db.prepare(
      "SELECT id FROM pending_digests WHERE trace_id = ? AND status IN ('pending', 'processing')"
    ).get('trace-mix') as { id: string } | undefined;
    expect(picked?.id).toBe('pd-active');
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
