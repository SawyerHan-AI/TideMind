// ============================================================
// Logseq 同步状态持久化
//
// 使用专用 SQLite 表追踪每个文件的 hash/mtime，
// 避免重启后重复 digest。
// ============================================================

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FileSyncState } from './types.js';
import { safeReadTextFileSync, safeStatSync, isDataless } from '../../utils/safe-fs.js';
import { planStaleSyncStateCleanup } from '../shared/source-file-state.js';
import { execIgnoringDuplicateColumn } from '../../db/migration-helpers.js';

/**
 * 确保同步表存在
 */
export function ensureSyncSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS logseq_sync (
      file_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      last_synced TEXT NOT NULL,
      node_ids TEXT,
      source_id TEXT DEFAULT ''
    )
  `);
  // 兼容：为已有表添加 source_id 列
  // MEDIUM 6 (audit-10, 2026-05-21):统一走 helper,避免裸 try/catch{} 吞 SQLITE_FULL/BUSY
  execIgnoringDuplicateColumn(db, "ALTER TABLE logseq_sync ADD COLUMN source_id TEXT DEFAULT ''");
  // 兼容：为已有表添加 segment_hashes 列（段级去重）
  execIgnoringDuplicateColumn(db, "ALTER TABLE logseq_sync ADD COLUMN segment_hashes TEXT DEFAULT '[]'");

  // 迁移到复合主键 (file_path, source_id)，支持多实例
  try {
    const tableInfo = db.prepare("PRAGMA table_info(logseq_sync)").all() as Array<{ name: string; pk: number }>;
    const pkColumns = tableInfo.filter(c => c.pk > 0).map(c => c.name);
    // 仅当主键只有 file_path 时才迁移
    if (pkColumns.length === 1 && pkColumns[0] === 'file_path') {
      db.exec(`
        CREATE TABLE IF NOT EXISTS logseq_sync_v2 (
          file_path TEXT NOT NULL,
          source_id TEXT NOT NULL DEFAULT '__default__',
          content_hash TEXT,
          mtime INTEGER,
          size INTEGER,
          last_synced TEXT,
          node_ids TEXT DEFAULT '[]',
          segment_hashes TEXT DEFAULT '[]',
          PRIMARY KEY (file_path, source_id)
        )
      `);
      db.exec(`
        INSERT OR IGNORE INTO logseq_sync_v2 (file_path, source_id, content_hash, mtime, size, last_synced, node_ids, segment_hashes)
        SELECT file_path, COALESCE(NULLIF(source_id, ''), '__default__'), content_hash, mtime, size, last_synced, node_ids, COALESCE(segment_hashes, '[]')
        FROM logseq_sync
      `);
      db.exec('DROP TABLE logseq_sync');
      db.exec('ALTER TABLE logseq_sync_v2 RENAME TO logseq_sync');
    }
  } catch { /* migration already done or not needed */ }
}

/**
 * 获取单个文件的同步状态
 */
export function getFileState(
  db: Database.Database,
  filePath: string,
  sourceId?: string,
): FileSyncState | null {
  const row = sourceId
    ? db.prepare('SELECT * FROM logseq_sync WHERE file_path = ? AND source_id = ?').get(filePath, sourceId) as Record<string, unknown> | undefined
    : db.prepare('SELECT * FROM logseq_sync WHERE file_path = ?').get(filePath) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    file_path: row.file_path as string,
    content_hash: row.content_hash as string,
    mtime: row.mtime as number,
    size: row.size as number,
    last_synced: row.last_synced as string,
    node_ids: row.node_ids ? JSON.parse(row.node_ids as string) : [],
    segment_hashes: row.segment_hashes ? JSON.parse(row.segment_hashes as string) : [],
  };
}

/**
 * 批量加载所有同步状态（启动时使用）
 */
export function getAllFileStates(
  db: Database.Database,
  sourceId?: string,
): Map<string, FileSyncState> {
  const rows = sourceId
    ? db.prepare('SELECT * FROM logseq_sync WHERE source_id = ?').all(sourceId) as Array<Record<string, unknown>>
    : db.prepare('SELECT * FROM logseq_sync').all() as Array<Record<string, unknown>>;
  const map = new Map<string, FileSyncState>();

  for (const row of rows) {
    map.set(row.file_path as string, {
      file_path: row.file_path as string,
      content_hash: row.content_hash as string,
      mtime: row.mtime as number,
      size: row.size as number,
      last_synced: row.last_synced as string,
      node_ids: row.node_ids ? JSON.parse(row.node_ids as string) : [],
      segment_hashes: row.segment_hashes ? JSON.parse(row.segment_hashes as string) : [],
    });
  }

  return map;
}

/**
 * 更新文件同步状态
 */
export function setFileState(
  db: Database.Database,
  state: FileSyncState,
  sourceId?: string,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO logseq_sync
    (file_path, content_hash, mtime, size, last_synced, node_ids, source_id, segment_hashes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.file_path,
    state.content_hash,
    state.mtime,
    state.size,
    state.last_synced,
    JSON.stringify(state.node_ids),
    sourceId ?? '__default__',
    JSON.stringify(state.segment_hashes),
  );
}

/**
 * 删除文件同步记录
 */
export function removeFileState(
  db: Database.Database,
  filePath: string,
  sourceId?: string,
): void {
  if (sourceId) {
    db.prepare('DELETE FROM logseq_sync WHERE file_path = ? AND source_id = ?').run(filePath, sourceId);
  } else {
    db.prepare('DELETE FROM logseq_sync WHERE file_path = ?').run(filePath);
  }
}

/**
 * 清理已不存在的文件记录
 *
 * @param currentFiles - 当前 graph 中存在的文件路径集合
 * @returns 被清理的文件及其关联 node_ids（用于归档）
 */
export function removeStaleFiles(
  db: Database.Database,
  currentFiles: Set<string>,
  sourceId?: string,
): { removed: number; orphanNodeIds: string[] } {
  const allStates = getAllFileStates(db, sourceId);
  const plan = planStaleSyncStateCleanup(allStates, currentFiles);

  for (const filePath of plan.staleFilePaths) {
    removeFileState(db, filePath, sourceId);
  }

  return { removed: plan.staleFilePaths.length, orphanNodeIds: plan.orphanNodeIds };
}

/**
 * 检查是否已完成过全量扫描
 */
export function hasCompletedFullScan(db: Database.Database, sourceId?: string): boolean {
  const key = sourceId ? `logseq_full_scan_completed_${sourceId}` : 'logseq_full_scan_completed';
  const row = db.prepare(
    'SELECT value FROM metadata WHERE key = ?',
  ).get(key) as { value: string } | undefined;
  return !!row;
}

/**
 * 标记全量扫描完成
 */
export function markFullScanCompleted(db: Database.Database, sourceId?: string): void {
  const key = sourceId ? `logseq_full_scan_completed_${sourceId}` : 'logseq_full_scan_completed';
  db.prepare(
    'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
  ).run(key, new Date().toISOString());
}

/**
 * 重置全量扫描状态（手动触发重新导入时使用）
 */
export function resetFullScanState(db: Database.Database, sourceId?: string): void {
  const key = sourceId ? `logseq_full_scan_completed_${sourceId}` : 'logseq_full_scan_completed';
  db.prepare(
    'DELETE FROM metadata WHERE key = ?',
  ).run(key);
}

// --- 变更检测 ---

/**
 * 检查文件是否需要重新处理
 *
 * 两步快速检测：
 * 1. 比较 mtime（零 I/O）
 * 2. mtime 不同时才读取文件计算 hash
 */
export function isFileChanged(
  filePath: string,
  syncState: FileSyncState | null,
): boolean {
  const stat = safeStatSync(filePath);
  if (!stat) return false; // 文件不存在，不需要处理（由 removeStaleFiles 清理）

  // iCloud dataless：跳过处理，既不触发下载也不误报"未变更"覆盖同步状态
  if (isDataless(stat)) return false;

  if (!syncState) return true; // 新文件

  // Step 1: mtime 比较
  const mtime = Math.floor(stat.mtimeMs);
  if (mtime === syncState.mtime && stat.size === syncState.size) {
    return false;
  }

  // Step 2: hash 比较（处理 mtime 漂移但内容未变的情况）
  const hash = computeFileHash(filePath);
  if (hash === null) return false; // dataless 或读失败，不视作变更
  return hash !== syncState.content_hash;
}

/**
 * 计算单个 segment 的 content hash（段级去重）
 */
export function computeSegmentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 计算文件内容 hash。
 *
 * iCloud dataless / stub / missing 时返回 null，调用方应据此跳过本轮同步状态写入，
 * 不要用空字符串或哨兵值充当 hash（会被当成"和上次不同"反复触发 digest）。
 *
 * 与 preprocessor 保持一致做 CRLF → LF 归一化:外部工具(git pull / Windows
 * 编辑器换行符切换)只改 EOL 不改语义内容时,hash 不变,不会触发整 graph 重 digest。
 * 对齐 Obsidian sync-state.ts:269 同名修复。
 */
export function computeFileHash(filePath: string): string | null {
  const res = safeReadTextFileSync(filePath);
  if (!res.ok) return null;
  const normalized = res.content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 获取文件 stat 信息
 */
export function getFileStat(filePath: string): { mtime: number; size: number } | null {
  const stat = safeStatSync(filePath);
  if (!stat) return null;
  if (isDataless(stat)) return null; // dataless：当作没有可用 stat（调用方应跳过写 state）
  return { mtime: Math.floor(stat.mtimeMs), size: stat.size };
}
