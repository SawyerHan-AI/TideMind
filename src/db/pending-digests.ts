import type Database from 'better-sqlite3';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pending-digests');

const MAX_RETRIES = 3;
// Exponential backoff: 1min, 5min, 15min
const BACKOFF_MINUTES = [1, 5, 15];

function computeNextRetry(retryCount: number): string {
  const minutes = BACKOFF_MINUTES[Math.min(retryCount, BACKOFF_MINUTES.length - 1)];
  const next = new Date(Date.now() + minutes * 60_000);
  return next.toISOString();
}

export function enqueuePendingDigest(
  db: Database.Database,
  traceId: string,
  inputJson: string,
  errorMessage: string,
): void {
  const id = generateId();
  db.prepare(`
    INSERT INTO pending_digests (id, trace_id, input_json, status, error_message, retry_count, created, next_retry_at)
    VALUES (?, ?, ?, 'pending', ?, 0, ?, ?)
  `).run(id, traceId, inputJson, errorMessage, now(), computeNextRetry(0));
  log.info(`Digest enqueued for retry: trace=${traceId}`);
}

export function claimNextPendingDigest(
  db: Database.Database,
): { id: string; trace_id: string; input_json: string; retry_count: number } | null {
  // 回收卡在 processing 状态超过 10 分钟的条目（进程崩溃等场景）。
  // 用 processing_started_at 判定：进入 processing 时写入，stale recovery 比对它；
  // 兼容 v19 之前的老数据（processing_started_at IS NULL）——把它们一并回收，
  // 免得被无限卡住。
  //
  // 修复 F5(2026-05-21): processing_started_at 列是 JS ISO
  // 'YYYY-MM-DDTHH:MM:SS.sssZ',原先用 `datetime('now', '-10 minutes')` 返回
  // 'YYYY-MM-DD HH:MM:SS'(空格分隔无 Z)。二者按字典序比较时 position 10 是
  // 'T' (0x54) vs ' ' (0x20),'T' > ' ',导致所有 ISO 字符串永远 ">" SQLite datetime
  // → stale 条件永远不触发,进程崩溃留下的 processing 行被无限卡住。
  // 改为 JS 侧算 cutoff 的 ISO 字符串再丢给 SQL,ISO 之间字典序 = 时间序。
  const staleCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const staleReset = db.prepare(`
    UPDATE pending_digests
    SET status = 'pending', retry_count = retry_count + 1, processing_started_at = NULL
    WHERE status = 'processing'
      AND (processing_started_at IS NULL OR processing_started_at < ?)
  `).run(staleCutoff);
  if (staleReset.changes > 0) {
    log.warn(`Recovered ${staleReset.changes} stale processing digest(s)`);
  }

  // SELECT + UPDATE 放到同一事务 + 乐观锁 + RETURNING，避免多 worker 并发
  // 同时 claim 同一行。better-sqlite3 的 transaction() 会自动处理
  // BEGIN/COMMIT/ROLLBACK，并发安全依赖 sqlite 自身的写锁串行化。
  const currentTime = now();
  const claim = db.transaction(() => {
    const candidate = db.prepare(`
      SELECT id FROM pending_digests
      WHERE status = 'pending' AND next_retry_at <= ?
      ORDER BY next_retry_at ASC
      LIMIT 1
    `).get(currentTime) as { id: string } | undefined;

    if (!candidate) return null;

    // 乐观锁：WHERE 带 status = 'pending'；用 RETURNING 一步拿回 claim 后的行。
    const row = db.prepare(`
      UPDATE pending_digests
      SET status = 'processing', processing_started_at = ?
      WHERE id = ? AND status = 'pending'
      RETURNING id, trace_id, input_json, retry_count
    `).get(currentTime, candidate.id) as
      | { id: string; trace_id: string; input_json: string; retry_count: number }
      | undefined;

    // 理论上同事务 + 写锁不会走到这里，但兼顾 sqlite 的 BUSY retry 语义。
    return row ?? null;
  })();

  return claim;
}

export function completePendingDigest(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM pending_digests WHERE id = ?").run(id);
}

export function failPendingDigest(
  db: Database.Database,
  id: string,
  errorMessage: string,
): void {
  // 历史 bug(2026-05-09):SELECT retry_count → 计算 newRetryCount → UPDATE WHERE id=?
  // 三步之间无事务,两个 worker 误并发处理同一行时 retry_count 会少加 1,
  // 极端情况下永远到不了 MAX_RETRIES 永远不 fail。
  // 修复:改为单条原子 UPDATE,SET 子句里 retry_count = retry_count + 1 配合
  // CASE 判断状态切换,DB 内部行锁兜住并发。next_retry_at 用预先计算的所有
  // 可能值数组(MAX_RETRIES 个),不再依赖业务侧 newRetryCount 实参。
  // 如果未来 MAX_RETRIES 改大,这里只需要扩展 CASE,不动调用方。
  const nowStr = now();
  // 预先计算所有可能的 next_retry_at:retry_count=0 → 第 1 次重试间隔,...
  // SQL CASE 按 retry_count + 1 选取
  const retrySchedule: string[] = [];
  for (let i = 1; i <= MAX_RETRIES; i++) retrySchedule.push(computeNextRetry(i));

  const result = db.prepare(`
    UPDATE pending_digests
    SET
      retry_count = retry_count + 1,
      error_message = @errorMessage,
      processing_started_at = NULL,
      status = CASE
        WHEN retry_count + 1 >= @maxRetries THEN 'failed'
        ELSE 'pending'
      END,
      completed_at = CASE
        WHEN retry_count + 1 >= @maxRetries THEN @nowStr
        ELSE completed_at
      END,
      next_retry_at = CASE retry_count + 1
        ${retrySchedule.map((_v, i) => `WHEN ${i + 1} THEN @r${i + 1}`).join('\n        ')}
        ELSE next_retry_at
      END
    WHERE id = @id
    RETURNING retry_count, status
  `).get({
    id,
    errorMessage,
    maxRetries: MAX_RETRIES,
    nowStr,
    ...Object.fromEntries(retrySchedule.map((v, i) => [`r${i + 1}`, v])),
  }) as { retry_count: number; status: string } | undefined;

  if (!result) return;
  if (result.status === 'failed') {
    log.warn(`Digest permanently failed after ${MAX_RETRIES} retries: ${id}`);
  } else {
    log.info(`Digest retry scheduled (attempt ${result.retry_count + 1}/${MAX_RETRIES}): ${id}`);
  }
}

export function getFailedDigests(db: Database.Database): Array<{ id: string; trace_id: string; error_message: string; created: string }> {
  return db.prepare(`
    SELECT id, trace_id, error_message, created FROM pending_digests
    WHERE status = 'failed'
    ORDER BY created DESC
    LIMIT 10
  `).all() as Array<{ id: string; trace_id: string; error_message: string; created: string }>;
}

export function getPendingDigestCount(db: Database.Database): { pending: number; failed: number } {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM pending_digests
  `).get() as { pending: number; failed: number } | undefined;
  return { pending: row?.pending ?? 0, failed: row?.failed ?? 0 };
}
