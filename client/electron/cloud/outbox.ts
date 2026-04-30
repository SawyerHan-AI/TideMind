import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';
import { generateId } from '../../../src/utils/id.js';

const log = createLogger('cloud-outbox');

/** 同一条 outbox 重试多少次后放到 dead-letter,阻止其永远卡住后续 push。 */
export const OUTBOX_MAX_RETRIES = 5;

export interface OutboxItem {
  id: string;
  operation: string;
  payload: string; // JSON
  source: string | null;
  created: string;
  retry_count: number;
  last_error: string | null;
}

export interface OutboxDiagnostics {
  pendingCount: number;
  deadLetterCount: number;
  oldestPendingAt: string | null;
  newestPendingAt: string | null;
  maxRetryCount: number;
  lastPendingError: string | null;
  lastDeadLetterError: string | null;
  lastDeadLetterAt: string | null;
  pendingByOperation: Array<{ operation: string; count: number }>;
  deadLetterByOperation: Array<{ operation: string; count: number }>;
}

export function createOutboxTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS local_outbox (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    source TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER DEFAULT 0,
    last_error TEXT
  )`);
  // 轻量 migration:老库可能没有 last_error 列
  const cols = db.prepare(`PRAGMA table_info(local_outbox)`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'last_error')) {
    try { db.exec(`ALTER TABLE local_outbox ADD COLUMN last_error TEXT`); } catch { /* ignore race */ }
  }

  // Dead-letter 表:多次失败的 outbox 进这里,等人工检查
  db.exec(`CREATE TABLE IF NOT EXISTS local_outbox_dead (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    source TEXT,
    created TEXT NOT NULL,
    failed_at TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER NOT NULL,
    last_error TEXT
  )`);
}

export function enqueueOutbox(db: Database.Database, operation: string, payload: object, source?: string): string {
  const id = generateId();
  db.prepare('INSERT INTO local_outbox (id, operation, payload, source) VALUES (?, ?, ?, ?)').run(id, operation, JSON.stringify(payload), source ?? null);
  log.info(`enqueued ${operation} id=${id}`);
  return id;
}

export function getOutboxItems(db: Database.Database, limit: number = 50): OutboxItem[] {
  return db.prepare('SELECT * FROM local_outbox ORDER BY created ASC LIMIT ?').all(limit) as OutboxItem[];
}

export function removeOutboxItem(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM local_outbox WHERE id = ?').run(id);
}

/**
 * 标记 outbox item 失败。递增 retry_count,超过阈值后搬到 dead-letter 表,
 * 让后续 outbox 能继续推进(否则一条 422 脏数据会永远卡死队列)。
 */
export function markOutboxFailed(db: Database.Database, id: string, error: string): { deadLettered: boolean } {
  const row = db.prepare('SELECT * FROM local_outbox WHERE id = ?').get(id) as OutboxItem | undefined;
  if (!row) return { deadLettered: false };
  const nextRetry = (row.retry_count ?? 0) + 1;
  const trimmedErr = error.slice(0, 500);
  if (nextRetry >= OUTBOX_MAX_RETRIES) {
    const tx = db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO local_outbox_dead
        (id, operation, payload, source, created, retry_count, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, row.operation, row.payload, row.source, row.created, nextRetry, trimmedErr,
      );
      db.prepare('DELETE FROM local_outbox WHERE id = ?').run(row.id);
    });
    tx();
    log.error(`outbox item ${id} dead-lettered after ${nextRetry} retries: ${trimmedErr}`);
    return { deadLettered: true };
  }
  db.prepare('UPDATE local_outbox SET retry_count = ?, last_error = ? WHERE id = ?').run(nextRetry, trimmedErr, id);
  return { deadLettered: false };
}

export function getOutboxCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as cnt FROM local_outbox').get() as { cnt: number }).cnt;
}

export function getDeadLetterCount(db: Database.Database): number {
  try {
    return (db.prepare('SELECT COUNT(*) as cnt FROM local_outbox_dead').get() as { cnt: number }).cnt;
  } catch {
    return 0;
  }
}

export function getOutboxDiagnostics(db: Database.Database): OutboxDiagnostics {
  createOutboxTable(db);
  const pending = db.prepare(`
    SELECT
      COUNT(*) AS pendingCount,
      MIN(created) AS oldestPendingAt,
      MAX(created) AS newestPendingAt,
      MAX(COALESCE(retry_count, 0)) AS maxRetryCount
    FROM local_outbox
  `).get() as {
    pendingCount: number;
    oldestPendingAt: string | null;
    newestPendingAt: string | null;
    maxRetryCount: number | null;
  };
  const dead = db.prepare(`
    SELECT
      COUNT(*) AS deadLetterCount,
      MAX(failed_at) AS lastDeadLetterAt
    FROM local_outbox_dead
  `).get() as { deadLetterCount: number; lastDeadLetterAt: string | null };
  const lastPending = db.prepare(`
    SELECT last_error AS error
    FROM local_outbox
    WHERE last_error IS NOT NULL AND last_error <> ''
    ORDER BY created DESC
    LIMIT 1
  `).get() as { error: string } | undefined;
  const lastDead = db.prepare(`
    SELECT last_error AS error
    FROM local_outbox_dead
    WHERE last_error IS NOT NULL AND last_error <> ''
    ORDER BY failed_at DESC
    LIMIT 1
  `).get() as { error: string } | undefined;

  const groupByOperation = (table: 'local_outbox' | 'local_outbox_dead') => (
    db.prepare(`
      SELECT operation, COUNT(*) AS count
      FROM ${table}
      GROUP BY operation
      ORDER BY count DESC, operation ASC
      LIMIT 8
    `).all() as Array<{ operation: string; count: number }>
  ).map(row => ({ operation: row.operation, count: Number(row.count) }));

  return {
    pendingCount: Number(pending.pendingCount ?? 0),
    deadLetterCount: Number(dead.deadLetterCount ?? 0),
    oldestPendingAt: pending.oldestPendingAt ?? null,
    newestPendingAt: pending.newestPendingAt ?? null,
    maxRetryCount: Number(pending.maxRetryCount ?? 0),
    lastPendingError: lastPending?.error ?? null,
    lastDeadLetterError: lastDead?.error ?? null,
    lastDeadLetterAt: dead.lastDeadLetterAt ?? null,
    pendingByOperation: groupByOperation('local_outbox'),
    deadLetterByOperation: groupByOperation('local_outbox_dead'),
  };
}
