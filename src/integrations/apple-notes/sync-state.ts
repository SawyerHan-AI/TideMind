// ============================================================
// Apple Notes 同步状态持久化
//
// 使用 apple_notes_sync 表追踪每条笔记的 modification_date + hash，
// 避免重启后重复 digest。
// ============================================================

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NoteSyncState } from './types.js';
import { execIgnoringDuplicateColumn } from '../../db/migration-helpers.js';

/**
 * 确保同步表存在
 *
 * 历史 bug(2026-05-09):原 schema 主键只有 `note_uuid`,但代码层面以
 * `(note_uuid, source_id)` 维度读写。`setNoteState` 的 INSERT OR REPLACE 按
 * 主键覆盖整行 → 用户配置两个 Apple Notes 源(不同账户)读同一台 Mac 的
 * NoteStore.sqlite 时,任意一方写入会清空另一方该 UUID 的 node_ids,下次同步
 * 把另一方对应节点判为"已删除"归档,再当"新增"重新 digest。Logseq /
 * Obsidian / Notion 都已是复合主键 `(file_path/page_id, source_id)`,唯独
 * apple-notes 漏迁移。
 *
 * 修复:迁移到复合主键 `(note_uuid, source_id)`。本函数在每次模块加载时
 * 调用,启动时检测旧 schema 直接走幂等迁移路径。
 */
export function ensureSyncSchema(db: Database.Database): void {
  // 先确保表存在(老表语义,可能已是 PRIMARY KEY (note_uuid))
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
  // MEDIUM 6 (audit-10, 2026-05-21):统一走 helper,避免裸 try/catch{} 吞 SQLITE_FULL/BUSY
  execIgnoringDuplicateColumn(db, "ALTER TABLE apple_notes_sync ADD COLUMN source_id TEXT DEFAULT ''");

  // 检测并迁移到复合主键(幂等)。SQLite PRAGMA table_info 暴露每列的 pk 编号,
  // 复合主键时多列 pk > 0,单主键只有一列 pk = 1。
  const pkCols = (db.prepare("PRAGMA table_info('apple_notes_sync')").all() as Array<{ name: string; pk: number }>)
    .filter(c => c.pk > 0)
    .map(c => c.name)
    .sort()
    .join(',');
  if (pkCols !== 'note_uuid,source_id') {
    // 走"创建新表 → 拷贝 → 丢弃旧表 → 重命名"。包在事务内保证原子。
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS apple_notes_sync_v2');
      db.exec(`
        CREATE TABLE apple_notes_sync_v2 (
          note_uuid TEXT NOT NULL,
          source_id TEXT NOT NULL DEFAULT '',
          modification_date REAL NOT NULL,
          content_hash TEXT NOT NULL,
          last_synced TEXT NOT NULL,
          node_ids TEXT,
          PRIMARY KEY (note_uuid, source_id)
        )
      `);
      // 拷贝旧数据(单源场景下 source_id='' 是默认值,迁移后行为不变;多源
      // 用户的旧数据在原 PK 下已被覆盖丢失,无可挽救——这正是本次修复的根因)
      db.exec(`
        INSERT INTO apple_notes_sync_v2
          (note_uuid, source_id, modification_date, content_hash, last_synced, node_ids)
        SELECT note_uuid, COALESCE(source_id, ''), modification_date, content_hash, last_synced, node_ids
        FROM apple_notes_sync
      `);
      db.exec('DROP TABLE apple_notes_sync');
      db.exec('ALTER TABLE apple_notes_sync_v2 RENAME TO apple_notes_sync');
    })();
  }
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
 *
 * 注意(2026-05-09):必须按 (noteUuid, sourceId) 删除,否则跨源会误删别人的
 * 记录。sourceId 可选只是兼容老调用方;新代码应总是传。
 */
export function removeNoteState(
  db: Database.Database,
  noteUuid: string,
  sourceId?: string,
): void {
  if (typeof sourceId === 'string') {
    db.prepare('DELETE FROM apple_notes_sync WHERE note_uuid = ? AND source_id = ?').run(noteUuid, sourceId);
  } else {
    // 老路径:删除所有源下该 UUID 的记录(可能误删多源,但保持向后兼容)
    db.prepare('DELETE FROM apple_notes_sync WHERE note_uuid = ?').run(noteUuid);
  }
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
      // 传入精确的 sourceId,只删本源下的记录
      removeNoteState(db, uuid, state.source_id);
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
