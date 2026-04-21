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
  const staleReset = db.prepare(`
    UPDATE pending_digests
    SET status = 'pending', retry_count = retry_count + 1, processing_started_at = NULL
    WHERE status = 'processing'
      AND (processing_started_at IS NULL OR processing_started_at < datetime('now', '-10 minutes'))
  `).run();
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
  const row = db.prepare("SELECT retry_count FROM pending_digests WHERE id = ?").get(id) as { retry_count: number } | undefined;
  if (!row) return;

  const newRetryCount = row.retry_count + 1;
  if (newRetryCount >= MAX_RETRIES) {
    db.prepare(`
      UPDATE pending_digests
      SET status = 'failed', error_message = ?, retry_count = ?, completed_at = ?, processing_started_at = NULL
      WHERE id = ?
    `).run(errorMessage, newRetryCount, now(), id);
    log.warn(`Digest permanently failed after ${MAX_RETRIES} retries: ${id}`);
  } else {
    db.prepare(`
      UPDATE pending_digests
      SET status = 'pending', error_message = ?, retry_count = ?, next_retry_at = ?, processing_started_at = NULL
      WHERE id = ?
    `).run(errorMessage, newRetryCount, computeNextRetry(newRetryCount), id);
    log.info(`Digest retry scheduled (attempt ${newRetryCount + 1}/${MAX_RETRIES}): ${id}`);
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
