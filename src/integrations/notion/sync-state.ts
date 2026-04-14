// ============================================================
// Notion 同步状态管理
// ============================================================

import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import type { NotionSyncState, NotionPendingRelation } from './types.js';

const log = createLogger('notion:sync-state');

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
