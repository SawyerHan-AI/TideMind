// ============================================================
// Apple Notes 同步状态持久化
//
// 使用 apple_notes_sync 表追踪每条笔记的 modification_date + hash，
// 避免重启后重复 digest。
// ============================================================

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NoteSyncState } from './types.js';

/**
 * 确保同步表存在
 */
export function ensureSyncSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apple_notes_sync (
      note_uuid TEXT PRIMARY KEY,
      modification_date REAL NOT NULL,
      content_hash TEXT NOT NULL,
      last_synced TEXT NOT NULL,
      node_ids TEXT,
      source_id TEXT DEFAULT ''
    )
  `);
  // 兼容：为已有表添加 source_id 列
  try { db.exec("ALTER TABLE apple_notes_sync ADD COLUMN source_id TEXT DEFAULT ''"); } catch { /* already exists */ }
}

/**
 * 获取单条笔记的同步状态
 */
export function getNoteState(
  db: Database.Database,
  noteUuid: string,
  sourceId?: string,
): NoteSyncState | null {
  const row = sourceId
    ? db.prepare('SELECT * FROM apple_notes_sync WHERE note_uuid = ? AND source_id = ?').get(noteUuid, sourceId) as Record<string, unknown> | undefined
    : db.prepare('SELECT * FROM apple_notes_sync WHERE note_uuid = ?').get(noteUuid) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    note_uuid: row.note_uuid as string,
    modification_date: row.modification_date as number,
    content_hash: row.content_hash as string,
    last_synced: row.last_synced as string,
    node_ids: row.node_ids ? JSON.parse(row.node_ids as string) : [],
    source_id: row.source_id as string,
  };
}

/**
 * 批量加载所有同步状态（启动时使用）
 */
export function getAllNoteStates(
  db: Database.Database,
  sourceId?: string,
): Map<string, NoteSyncState> {
  const rows = sourceId
    ? db.prepare('SELECT * FROM apple_notes_sync WHERE source_id = ?').all(sourceId) as Array<Record<string, unknown>>
    : db.prepare('SELECT * FROM apple_notes_sync').all() as Array<Record<string, unknown>>;

  const map = new Map<string, NoteSyncState>();
  for (const row of rows) {
    map.set(row.note_uuid as string, {
      note_uuid: row.note_uuid as string,
      modification_date: row.modification_date as number,
      content_hash: row.content_hash as string,
      last_synced: row.last_synced as string,
      node_ids: row.node_ids ? JSON.parse(row.node_ids as string) : [],
      source_id: row.source_id as string,
    });
  }
  return map;
}

/**
 * 更新笔记同步状态
 */
export function setNoteState(
  db: Database.Database,
  state: NoteSyncState,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO apple_notes_sync
    (note_uuid, modification_date, content_hash, last_synced, node_ids, source_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    state.note_uuid,
    state.modification_date,
    state.content_hash,
    state.last_synced,
    JSON.stringify(state.node_ids),
    state.source_id,
  );
}

/**
 * 删除笔记同步记录
 */
export function removeNoteState(
  db: Database.Database,
  noteUuid: string,
): void {
  db.prepare('DELETE FROM apple_notes_sync WHERE note_uuid = ?').run(noteUuid);
}

/**
 * 清理已不存在的笔记记录（笔记被删除或归档后）
 *
 * @param currentUuids - 当前数据库中存在的笔记 UUID 集合
 * @returns 被清理的笔记及其关联 node_ids
 */
export function removeStaleNotes(
  db: Database.Database,
  currentUuids: Set<string>,
  sourceId?: string,
): { removed: number; orphanNodeIds: string[] } {
  const allStates = getAllNoteStates(db, sourceId);
  let removed = 0;
  const orphanNodeIds: string[] = [];

  for (const [uuid, state] of allStates.entries()) {
    if (!currentUuids.has(uuid)) {
      if (state.node_ids.length > 0) {
        orphanNodeIds.push(...state.node_ids);
      }
      removeNoteState(db, uuid);
      removed++;
    }
  }

  return { removed, orphanNodeIds };
}

/**
 * 检查是否已完成过全量扫描
 */
export function hasCompletedFullScan(db: Database.Database, sourceId?: string): boolean {
  const key = sourceId ? `apple-notes_full_scan_completed_${sourceId}` : 'apple-notes_full_scan_completed';
  const row = db.prepare(
    'SELECT value FROM metadata WHERE key = ?',
  ).get(key) as { value: string } | undefined;
  return !!row;
}

/**
 * 标记全量扫描完成
 */
export function markFullScanCompleted(db: Database.Database, sourceId?: string): void {
  const key = sourceId ? `apple-notes_full_scan_completed_${sourceId}` : 'apple-notes_full_scan_completed';
  db.prepare(
    'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
  ).run(key, new Date().toISOString());
}

/**
 * 重置全量扫描状态
 */
export function resetFullScanState(db: Database.Database, sourceId?: string): void {
  const key = sourceId ? `apple-notes_full_scan_completed_${sourceId}` : 'apple-notes_full_scan_completed';
  db.prepare(
    'DELETE FROM metadata WHERE key = ?',
  ).run(key);
}

// --- 变更检测 ---

/**
 * 检查笔记是否需要重新处理。
 *
 * 两步检测：
 * 1. 比较 modification_date（来自 Apple Notes 数据库）
 * 2. modification_date 不同时计算文本 hash 确认
 */
export function isNoteChanged(
  modificationDate: number,
  contentHash: string,
  syncState: NoteSyncState | null,
): boolean {
  if (!syncState) return true; // 新笔记

  // Step 1: modification_date 比较
  if (modificationDate === syncState.modification_date) {
    return false;
  }

  // Step 2: hash 比较（处理 modification_date 漂移但内容未变的情况）
  return contentHash !== syncState.content_hash;
}

/**
 * 计算文本内容 hash
 */
export function computeContentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
