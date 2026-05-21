import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';
import { generateId } from '../../../src/utils/id.js';
import { execIgnoringDuplicateColumn } from '../../../src/db/migration-helpers.js';

const log = createLogger('cloud-outbox');

/** 同一条 outbox 重试多少次后放到 dead-letter,阻止其永远卡住后续 push。 */
export const OUTBOX_MAX_RETRIES = 5;

/**
 * MEDIUM 10 (audit-10, 2026-05-21): 单条 outbox payload 上限,与 server
 * sync/routes.ts 的 PAYLOAD_MAX_BYTES 对齐(server 端也按 UTF-8 byte 计)。
 *
 * 之前 client 端只在 server 拒收时才知道超大,白白占了 push 配额 + 浪费用户
 * 设备带宽。客户端落地前先拦住:超出直接抛错,renderer 上层(IPC handler)
 * 转 `{success:false,error}` 给 UI 显示"内容过大,请拆分"。
 */
export const OUTBOX_PAYLOAD_MAX_BYTES = 100_000;

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
  // 轻量 migration:老库可能没有 last_error 列。
  // MEDIUM 6 (audit-10, 2026-05-21):走统一 helper,而不是裸 try/catch{} —
  // 后者会同时吞 SQLITE_FULL / SQLITE_BUSY / SQLITE_CORRUPT 让磁盘满静默成功。
  const cols = db.prepare(`PRAGMA table_info(local_outbox)`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'last_error')) {
    execIgnoringDuplicateColumn(db, `ALTER TABLE local_outbox ADD COLUMN last_error TEXT`);
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
  const payloadStr = JSON.stringify(payload);
  // MEDIUM 10 (audit-10): byte 级 cap,与 server 对齐。超出抛错让 caller
  // (sync flush / IPC handler)拿到结构化失败,不静默写入 → 永远 server 拒。
  const payloadSize = Buffer.byteLength(payloadStr, 'utf-8');
  if (payloadSize > OUTBOX_PAYLOAD_MAX_BYTES) {
    throw new Error(`outbox payload too large (${payloadSize} > ${OUTBOX_PAYLOAD_MAX_BYTES} bytes)`);
  }
  const id = generateId();
  db.prepare('INSERT INTO local_outbox (id, operation, payload, source) VALUES (?, ?, ?, ?)').run(id, operation, payloadStr, source ?? null);
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

/**
 * 立即把 outbox item 搬到 dead-letter 表,**跳过 retry**。
 *
 * 用于"确定性失败"——重试 5 次也修不好的情况。当前已知场景:
 *   - 本地 payload 字段是坏 JSON(磁盘损坏 / 历史 schema 不兼容 / 手工编辑后写错):
 *     `JSON.parse(item.payload)` 抛 SyntaxError → 走 markOutboxFailed 会让其在
 *     队列里重试 5 次,每次都失败,期间整批 outbox 因为打包失败永远推不上去。
 *     直接 dead-letter 让队列继续往前推。
 *
 * 返回 `{ deadLettered: true }` 与 markOutboxFailed 同构(方便 caller 统一计数)。
 * row 已不存在时返回 `{ deadLettered: false }`(竞态:同一条 id 已被 remove)。
 */
export function deadLetterOutboxItem(db: Database.Database, id: string, error: string): { deadLettered: boolean } {
  const row = db.prepare('SELECT * FROM local_outbox WHERE id = ?').get(id) as OutboxItem | undefined;
  if (!row) return { deadLettered: false };
  const trimmedErr = error.slice(0, 500);
  const tx = db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO local_outbox_dead
      (id, operation, payload, source, created, retry_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.operation, row.payload, row.source, row.created, (row.retry_count ?? 0) + 1, trimmedErr,
    );
    db.prepare('DELETE FROM local_outbox WHERE id = ?').run(row.id);
  });
  tx();
  log.error(`outbox item ${id} dead-lettered immediately: ${trimmedErr}`);
  return { deadLettered: true };
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
