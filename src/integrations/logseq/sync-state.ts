// ============================================================
// Logseq 同步状态持久化
//
// 使用专用 SQLite 表追踪每个文件的 hash/mtime，
// 避免重启后重复 digest。
// ============================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { FileSyncState } from './types.js';

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
  try { db.exec("ALTER TABLE logseq_sync ADD COLUMN source_id TEXT DEFAULT ''"); } catch { /* already exists */ }
  // 兼容：为已有表添加 segment_hashes 列（段级去重）
  try { db.exec("ALTER TABLE logseq_sync ADD COLUMN segment_hashes TEXT DEFAULT '[]'"); } catch { /* already exists */ }
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
    sourceId ?? '',
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
  let removed = 0;
  const orphanNodeIds: string[] = [];

  for (const [filePath, state] of allStates.entries()) {
    if (!currentFiles.has(filePath)) {
      if (state.node_ids.length > 0) {
        orphanNodeIds.push(...state.node_ids);
      }
      removeFileState(db, filePath, sourceId);
      removed++;
    }
  }

  return { removed, orphanNodeIds };
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
  if (!syncState) return true; // 新文件

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false; // 文件不存在，不需要处理（由 removeStaleFiles 清理）
  }

  // Step 1: mtime 比较
  const mtime = Math.floor(stat.mtimeMs);
  if (mtime === syncState.mtime && stat.size === syncState.size) {
    return false;
  }

  // Step 2: hash 比较（处理 mtime 漂移但内容未变的情况）
  const hash = computeFileHash(filePath);
  return hash !== syncState.content_hash;
}

/**
 * 计算单个 segment 的 content hash（段级去重）
 */
export function computeSegmentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 计算文件内容 hash
 */
export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 获取文件 stat 信息
 */
export function getFileStat(filePath: string): { mtime: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtime: Math.floor(stat.mtimeMs), size: stat.size };
  } catch {
    return null;
  }
}
