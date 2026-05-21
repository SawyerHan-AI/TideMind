// ============================================================
// Notion 同步状态管理
// ============================================================

import type Database from 'better-sqlite3';
import type { NotionSyncState, NotionPendingRelation } from './types.js';

// ── Page Sync State ──────────────────────────────────────────

export function getPageState(
  db: Database.Database,
  pageId: string,
  sourceId: string,
): NotionSyncState | null {
  const row = db.prepare(
    'SELECT * FROM notion_sync WHERE page_id = ? AND source_id = ?'
  ).get(pageId, sourceId) as (Record<string, unknown>) | undefined;

  if (!row) return null;

  return {
    page_id: row.page_id as string,
    content_hash: row.content_hash as string,
    last_edited_time: row.last_edited_time as string,
    page_type: row.page_type as 'page' | 'database_page',
    last_synced: row.last_synced as string,
    node_ids: JSON.parse((row.node_ids as string) || '[]'),
    source_id: row.source_id as string,
  };
}

export function updatePageState(
  db: Database.Database,
  pageId: string,
  contentHash: string,
  lastEditedTime: string,
  pageType: 'page' | 'database_page',
  nodeIds: string[],
  sourceId: string,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO notion_sync
      (page_id, content_hash, last_edited_time, page_type, last_synced, node_ids, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    pageId,
    contentHash,
    lastEditedTime,
    pageType,
    new Date().toISOString(),
    JSON.stringify(nodeIds),
    sourceId,
  );
}

export function getAllPageStates(
  db: Database.Database,
  sourceId: string,
): Map<string, NotionSyncState> {
  const rows = db.prepare(
    'SELECT * FROM notion_sync WHERE source_id = ?'
  ).all(sourceId) as Array<Record<string, unknown>>;

  const map = new Map<string, NotionSyncState>();
  for (const row of rows) {
    const state: NotionSyncState = {
      page_id: row.page_id as string,
      content_hash: row.content_hash as string,
      last_edited_time: row.last_edited_time as string,
      page_type: row.page_type as 'page' | 'database_page',
      last_synced: row.last_synced as string,
      node_ids: JSON.parse((row.node_ids as string) || '[]'),
      source_id: row.source_id as string,
    };
    map.set(state.page_id, state);
  }
  return map;
}

export function removePageState(
  db: Database.Database,
  pageId: string,
  sourceId: string,
): void {
  db.prepare(
    'DELETE FROM notion_sync WHERE page_id = ? AND source_id = ?'
  ).run(pageId, sourceId);
}

export function getPageCount(db: Database.Database, sourceId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM notion_sync WHERE source_id = ?'
  ).get(sourceId) as { cnt: number };
  return row.cnt;
}

// ── Pending Relations ────────────────────────────────────────

export function addPendingRelation(
  db: Database.Database,
  rel: Omit<NotionPendingRelation, 'created'>,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO notion_pending_relations
      (source_page_id, target_page_id, source_node_id, property_name, source_id, created)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    rel.source_page_id,
    rel.target_page_id,
    rel.source_node_id,
    rel.property_name,
    rel.source_id,
    new Date().toISOString(),
  );
}

export function getPendingRelationsForTarget(
  db: Database.Database,
  targetPageId: string,
  sourceId: string,
): NotionPendingRelation[] {
  return db.prepare(
    'SELECT * FROM notion_pending_relations WHERE target_page_id = ? AND source_id = ?'
  ).all(targetPageId, sourceId) as NotionPendingRelation[];
}

export function removePendingRelation(
  db: Database.Database,
  sourcePageId: string,
  targetPageId: string,
  sourceId: string,
): void {
  db.prepare(
    'DELETE FROM notion_pending_relations WHERE source_page_id = ? AND target_page_id = ? AND source_id = ?'
  ).run(sourcePageId, targetPageId, sourceId);
}

export function removePendingRelationsForSource(
  db: Database.Database,
  sourcePageId: string,
  sourceId: string,
): void {
  db.prepare(
    'DELETE FROM notion_pending_relations WHERE source_page_id = ? AND source_id = ?'
  ).run(sourcePageId, sourceId);
}

// ── Full Scan State ──────────────────────────────────────────

export function hasCompletedFullScan(db: Database.Database, sourceId: string): boolean {
  const key = `notion_full_scan_completed_${sourceId}`;
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value === 'true';
}

export function markFullScanCompleted(db: Database.Database, sourceId: string): void {
  const key = `notion_full_scan_completed_${sourceId}`;
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, 'true');
}

// ── Pending Retry (B-2) ───────────────────────────────────────

/**
 * 失败页连续重试上限。到达后 status → 'dead_letter',下次 sync 不再合并。
 * 5 次足够覆盖瞬时网络抖动 / API rate limit 自愈;再多就是 page 数据 / 集成本身有问题,
 * 让 sync 持续浪费 LLM/embedding quota 不合理。
 */
export const NOTION_RETRY_MAX_ATTEMPTS = 5;

export interface NotionPendingRetry {
  page_id: string;
  source_id: string;
  attempts: number;
  last_attempt: string;
  last_error: string | null;
  status: 'pending' | 'dead_letter';
}

/**
 * 记录一次失败:已存在则 attempts+1,否则新建 attempts=1。
 * attempts 达到 NOTION_RETRY_MAX_ATTEMPTS 时 status 自动切到 'dead_letter'。
 */
export function recordPageFailure(
  db: Database.Database,
  pageId: string,
  sourceId: string,
  error: string,
): void {
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT attempts FROM notion_pending_retry WHERE page_id = ? AND source_id = ?'
  ).get(pageId, sourceId) as { attempts: number } | undefined;

  const nextAttempts = (existing?.attempts ?? 0) + 1;
  const nextStatus = nextAttempts >= NOTION_RETRY_MAX_ATTEMPTS ? 'dead_letter' : 'pending';

  // 错误消息 cap 到 1000 字符,避免大 stack trace 把表撑大
  const trimmedError = error.length > 1000 ? error.slice(0, 1000) + '...' : error;

  db.prepare(`
    INSERT INTO notion_pending_retry (page_id, source_id, attempts, last_attempt, last_error, status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(page_id, source_id) DO UPDATE SET
      attempts = excluded.attempts,
      last_attempt = excluded.last_attempt,
      last_error = excluded.last_error,
      status = excluded.status
  `).run(pageId, sourceId, nextAttempts, now, trimmedError, nextStatus);
}

/**
 * 标记一次成功:清掉重试记录(成功 = 不再需要追踪)。
 * 即便 status 已经是 dead_letter 也清,允许通过下一次外部触发 full rescan 自愈。
 */
export function clearPageFailure(
  db: Database.Database,
  pageId: string,
  sourceId: string,
): void {
  db.prepare(
    'DELETE FROM notion_pending_retry WHERE page_id = ? AND source_id = ?'
  ).run(pageId, sourceId);
}

/**
 * 获取还允许重试的 pageId 列表(status='pending' 即 attempts < MAX)。
 * 由 runIncrementalSync 合并进 changedPages,确保即便 last_edited_time 没动
 * 也会被重试。
 */
export function getPagesPendingRetry(
  db: Database.Database,
  sourceId: string,
): string[] {
  const rows = db.prepare(
    "SELECT page_id FROM notion_pending_retry WHERE source_id = ? AND status = 'pending'"
  ).all(sourceId) as Array<{ page_id: string }>;
  return rows.map(r => r.page_id);
}

/** 测试 / 诊断用:列出所有重试条目(含 dead_letter)。 */
export function listAllPendingRetry(
  db: Database.Database,
  sourceId: string,
): NotionPendingRetry[] {
  const rows = db.prepare(
    'SELECT * FROM notion_pending_retry WHERE source_id = ? ORDER BY last_attempt DESC'
  ).all(sourceId) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    page_id: r.page_id as string,
    source_id: r.source_id as string,
    attempts: r.attempts as number,
    last_attempt: r.last_attempt as string,
    last_error: (r.last_error as string | null) ?? null,
    status: r.status as 'pending' | 'dead_letter',
  }));
}
