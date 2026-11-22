import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';

/**
 * recall 后续工作队列的存取（设计 §5）。全部为同步 SQLite 操作。
 *
 * 语义要点：
 * - 行不过期、不淘汰；只有全部条目处理完才删除。
 * - handled_json 记录已尝试过的条目键。条目在模型调用之前标记，
 *   因此进程在任何时刻消失，该条目都不会被第二次执行（条目级至多一次）。
 * - processing 行的恢复只能在持有调度器 owner 锁时进行。
 */
export type RecallFollowupKind = 'link_revalidate' | 'reconsolidate';

export interface RecallFollowupRow {
  id: string;
  kind: RecallFollowupKind;
  nodeIds: string[];
  query: string | null;
  context: string | null;
  handled: string[];
  attempts: number;
  updated: string;
}

const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** 5 分钟起、翻倍、上限 24 小时。attempts 为放回后的累计次数（>= 1）。 */
export function recallFollowupBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

function dedupeKey(nodeIds: string[], discriminator: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([[...nodeIds].sort(), discriminator ?? '']))
    .digest('hex')
    .slice(0, 16);
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function enqueueRecallFollowup(
  db: Database.Database,
  input: { kind: RecallFollowupKind; nodeIds: string[]; query?: string | null; context?: string | null },
): void {
  const nodeIds = [...new Set(input.nodeIds)];
  if (nodeIds.length === 0) return;
  // link_revalidate 以 query 区分语境；reconsolidate 以 recall 的 context 区分。
  const query = input.kind === 'link_revalidate' ? input.query ?? null : null;
  const context = input.kind === 'reconsolidate' ? input.context ?? null : null;
  const ts = now();
  // 冲突时只刷新 updated：已处理条目、退避与状态都保持，避免重做与抵消退避。
  db.prepare(`
    INSERT INTO recall_followups (id, kind, dedupe_key, node_ids_json, query, context, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, dedupe_key) DO UPDATE SET updated = excluded.updated
  `).run(
    generateId(), input.kind, dedupeKey(nodeIds, input.kind === 'link_revalidate' ? query : context),
    JSON.stringify(nodeIds), query, context, ts, ts,
  );
}

export function hasDueRecallFollowup(db: Database.Database, kind: RecallFollowupKind, nowIso = now()): boolean {
  return db.prepare(`
    SELECT 1 FROM recall_followups
    WHERE kind = ? AND (status = 'processing'
      OR (status = 'pending' AND (not_before IS NULL OR not_before <= ?)))
    LIMIT 1
  `).get(kind, nowIso) !== undefined;
}

/**
 * 把遗留的 processing 行放回 pending。调用方必须持有调度器 owner 锁：
 * 锁保证同一数据库同一时刻只有一个消费者，此时看到的 processing 行必然来自已消失的进程。
 */
export function recoverProcessingRecallFollowups(db: Database.Database, kind: RecallFollowupKind): number {
  return db.prepare(`
    UPDATE recall_followups SET status = 'pending', claimed_at = NULL
    WHERE kind = ? AND status = 'processing'
  `).run(kind).changes;
}

export function claimNextRecallFollowup(
  db: Database.Database,
  kind: RecallFollowupKind,
  nowIso = now(),
): RecallFollowupRow | null {
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT id, kind, node_ids_json, query, context, handled_json, attempts, updated
      FROM recall_followups
      WHERE kind = ? AND status = 'pending' AND (not_before IS NULL OR not_before <= ?)
      ORDER BY updated DESC, id ASC LIMIT 1
    `).get(kind, nowIso) as {
      id: string; kind: RecallFollowupKind; node_ids_json: string; query: string | null;
      context: string | null; handled_json: string; attempts: number; updated: string;
    } | undefined;
    if (!row) return null;
    const claimed = db.prepare(`
      UPDATE recall_followups SET status = 'processing', claimed_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(nowIso, row.id);
    if (claimed.changes !== 1) return null;
    return {
      id: row.id, kind: row.kind, nodeIds: parseList(row.node_ids_json), query: row.query,
      context: row.context, handled: parseList(row.handled_json), attempts: row.attempts, updated: row.updated,
    };
  }).immediate();
}

function updateHandled(db: Database.Database, id: string, mutate: (handled: string[]) => string[]): void {
  db.transaction(() => {
    const row = db.prepare('SELECT handled_json FROM recall_followups WHERE id = ?')
      .get(id) as { handled_json: string } | undefined;
    if (!row) return;
    db.prepare('UPDATE recall_followups SET handled_json = ? WHERE id = ?')
      .run(JSON.stringify(mutate(parseList(row.handled_json))), id);
  }).immediate();
}

export function markRecallFollowupItemHandled(db: Database.Database, id: string, itemKey: string): void {
  updateHandled(db, id, handled => handled.includes(itemKey) ? handled : [...handled, itemKey]);
}

export function unmarkRecallFollowupItemHandled(db: Database.Database, id: string, itemKey: string): void {
  updateHandled(db, id, handled => handled.filter(key => key !== itemKey));
}

export function completeRecallFollowup(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM recall_followups WHERE id = ?').run(id);
}

/**
 * 放回 pending。backoff=true（确定失败或暂不可做）时 attempts+1 并设置退避（delayMs 可指定固定间隔）；
 * backoff=false（结果不明等）时不改 attempts 与 not_before。
 */
export function releaseRecallFollowup(
  db: Database.Database,
  id: string,
  options: { backoff: boolean; nowMs?: number; delayMs?: number },
): void {
  if (!options.backoff) {
    db.prepare("UPDATE recall_followups SET status = 'pending', claimed_at = NULL WHERE id = ?").run(id);
    return;
  }
  db.transaction(() => {
    const row = db.prepare('SELECT attempts FROM recall_followups WHERE id = ?')
      .get(id) as { attempts: number } | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    const notBefore = new Date((options.nowMs ?? Date.now()) + (options.delayMs ?? recallFollowupBackoffMs(attempts))).toISOString();
    db.prepare(`
      UPDATE recall_followups SET status = 'pending', claimed_at = NULL, attempts = ?, not_before = ?
      WHERE id = ?
    `).run(attempts, notBefore, id);
  }).immediate();
}

export function countPendingRecallFollowups(db: Database.Database, kind: RecallFollowupKind): number {
  return (db.prepare('SELECT count(*) AS n FROM recall_followups WHERE kind = ?').get(kind) as { n: number }).n;
}
