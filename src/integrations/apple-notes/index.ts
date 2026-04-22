// ============================================================
// Apple Notes 适配器入口
//
// 轮询 NoteStore.sqlite 的 mtime，增量同步变更笔记。
// 与 Logseq/Obsidian 的关键差异：
// - 数据源是 SQLite 数据库而非文件系统目录
// - 不用 fs.watch，用 setInterval 轮询
// - 路径格式：/path/to/NoteStore.sqlite?accounts=1,3
// ============================================================

import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { clearTagNodeCache } from '../shared/property-promote.js';
import { logTimelineEvent } from '../../db/log.js';
import { updateLastSynced } from '../shared/note-sources.js';
import { archiveNode } from '../../db/nodes.js';
import {
  openNoteStoreDb,
  detectSchemaVersion,
  listFolders,
  buildFolderPathMap,
  listNotes,
  listNotesModifiedSince,
  listAllNoteUuids,
  parseAccountsFromPath,
  preloadNoteTags,
  preloadNoteAttachmentTexts,
} from './database.js';
import { initProto } from './protobuf.js';
import { ensureSyncSchema, getAllNoteStates, removeStaleNotes, hasCompletedFullScan, markFullScanCompleted, resetFullScanState } from './sync-state.js';
import { processNoteQueue, getImportProgress as getQueueProgress, resetProgress } from './queue.js';
import { DEFAULT_POLL_INTERVAL, type AppleTag } from './types.js';

const log = createLogger('apple-notes');

// ======== 多实例状态 ========

const pollingTimers = new Map<string, NodeJS.Timeout>();
const lastDbMtimes = new Map<string, number>();
const lastSyncTimestamps = new Map<string, number>(); // Core Data epoch
/** 已被显式停止的源 ID，避免首次同步后仍启动轮询 */
const stoppedSources = new Set<string>();
/** 正在执行 runSync 的源 ID，用于防止 pollForChanges 与其并发 */
const syncingSources = new Set<string>();

// ======== 入口函数 ========

/**
 * 启动一个 Apple Notes 同步源。
 *
 * @param db - Tide Mind 主数据库
 * @param sourceId - note_sources 表中的 ID
 * @param sourcePath - 格式：/path/to/NoteStore.sqlite?accounts=1,3
 * @param pollInterval - 轮询间隔（秒），默认 60
 */
export async function startAppleNotesSource(
  db: Database.Database,
  sourceId: string,
  sourcePath: string,
  pollInterval?: number,
): Promise<void> {
  const { dbPath, accountZpks } = parseAccountsFromPath(sourcePath);

  if (!fs.existsSync(dbPath)) {
    log.error(`NoteStore.sqlite 不存在: ${dbPath} (source=${sourceId})`);
    return;
  }

  // 清除历史 stopped 标记（例如 unarchive 后重新启动）
  stoppedSources.delete(sourceId);

  log.info(`初始化 Apple Notes 集成: ${dbPath} (source=${sourceId}, accounts=${accountZpks?.join(',') ?? 'all'})`);

  // 1. 确保同步表存在
  ensureSyncSchema(db);

  // 2. 预加载 protobuf 定义
  await initProto();

  // 3. 首次同步 + 启动轮询（顺序执行，避免竞态）
  //    runSync 完成后才启动 setInterval，防止首次扫描尚未结束时
  //    轮询并发调用 processNoteQueue 造成进度混乱和重复处理
  //    注意：必须 await runSync 完成后再注册 timer，否则外层 await 会在首次同步尚未开始时就 resolve，
  //    造成调用方误以为启动已就绪。
  try {
    await runSync(db, dbPath, accountZpks, sourceId);
  } catch (err) {
    log.error(`Apple Notes 首次同步失败 (source=${sourceId}):`, (err as Error).message);
    // 不 rethrow：即使首次同步失败也启动轮询，用户修正问题后下次 tick 会重试
  }

  // 启动轮询前检查源是否已被停止（避免 stopAppleNotesSource 后仍然启动）
  if (!stoppedSources.has(sourceId)) {
    const interval = (pollInterval ?? DEFAULT_POLL_INTERVAL) * 1000;
    const timer = setInterval(() => {
      pollForChanges(db, dbPath, accountZpks, sourceId).catch(err =>
        log.error(`Apple Notes 轮询失败 (source=${sourceId}):`, (err as Error).message),
      );
    }, interval);
    pollingTimers.set(sourceId, timer);
    log.info(`Apple Notes 轮询已启动: 每 ${pollInterval ?? DEFAULT_POLL_INTERVAL} 秒 (source=${sourceId})`);
  }
}

/**
 * 停止指定源的轮询
 */
export function stopAppleNotesSource(sourceId: string): void {
  stoppedSources.add(sourceId);
  const timer = pollingTimers.get(sourceId);
  if (timer) {
    clearInterval(timer);
    pollingTimers.delete(sourceId);
  }
  lastDbMtimes.delete(sourceId);
  lastSyncTimestamps.delete(sourceId);
}

/**
 * 停止所有 Apple Notes 实例
 */
export function stopAppleNotesIntegration(): void {
  for (const [sourceId, timer] of pollingTimers.entries()) {
    stoppedSources.add(sourceId);
    clearInterval(timer);
    pollingTimers.delete(sourceId);
  }
  lastDbMtimes.clear();
  lastSyncTimestamps.clear();
}

/**
 * 触发全量重新扫描
 */
export async function triggerFullRescan(
  db: Database.Database,
  sourceId?: string,
  sourcePath?: string,
): Promise<void> {
  if (!sourcePath) {
    log.error('triggerFullRescan 需要 sourcePath');
    return;
  }

  const { dbPath, accountZpks } = parseAccountsFromPath(sourcePath);

  if (sourceId) {
    resetFullScanState(db, sourceId);
    resetProgress(sourceId);
  }

  await runSync(db, dbPath, accountZpks, sourceId);
}

/**
 * 获取导入进度
 */
export function getImportProgress(sourceId?: string) {
  return getQueueProgress(sourceId);
}

// ======== 同步逻辑 ========

/**
 * 执行一次完整同步
 */
/** 归档孤立节点（外部笔记被删除时调用）
 *
 * 走 archiveNode() 统一清理 nodes_vec / node_segments——防止已删除笔记
 * 残留在向量召回里（向量搜索只看 nodes_vec 表，不过滤 archived）。
 */
function archiveOrphanNodes(db: Database.Database, nodeIds: string[]): void {
  for (const id of nodeIds) {
    archiveNode(db, id);
  }
}

async function runSync(
  db: Database.Database,
  dbPath: string,
  accountZpks: number[] | undefined,
  sourceId?: string,
): Promise<void> {
  const syncKey = sourceId ?? '__default__';
  if (syncingSources.has(syncKey)) {
    log.warn(`Apple Notes 同步已在进行中，跳过重复调用 (source=${sourceId})`);
    return;
  }
  syncingSources.add(syncKey);

  try {
    await runSyncInner(db, dbPath, accountZpks, sourceId);
  } finally {
    syncingSources.delete(syncKey);
  }
}

async function runSyncInner(
  db: Database.Database,
  dbPath: string,
  accountZpks: number[] | undefined,
  sourceId?: string,
): Promise<void> {
  // 判定当前源是否已被停止（source 为 undefined 时视为默认源，不会被 stop）
  const isStopped = (): boolean => sourceId !== undefined && stoppedSources.has(sourceId);

  const isFirstRun = !hasCompletedFullScan(db, sourceId);
  log.info(`Apple Notes 同步开始 (firstRun=${isFirstRun}, source=${sourceId})`);

  clearTagNodeCache();

  if (isStopped()) {
    log.info(`Apple Notes 同步被中止 (source=${sourceId})`);
    return;
  }

  let noteStoreDb: ReturnType<typeof openNoteStoreDb>;
  try {
    noteStoreDb = openNoteStoreDb(dbPath);
  } catch (err) {
    log.error('无法打开 NoteStore.sqlite:', (err as Error).message);
    return;
  }

  try {
    const schema = detectSchemaVersion(noteStoreDb);
    log.info(`NoteStore.sqlite schema 版本: macOS ${schema.version}`);

    if (isStopped()) {
      log.info(`Apple Notes 同步被中止 (source=${sourceId})`);
      return;
    }

    // 获取文件夹路径映射
    const folders = listFolders(noteStoreDb, schema);
    const folderPathMap = buildFolderPathMap(folders);

    // 获取所有笔记
    const allNotes = listNotes(noteStoreDb, schema, accountZpks);
    log.info(`发现 ${allNotes.length} 条笔记`);

    if (isStopped()) {
      log.info(`Apple Notes 同步被中止 (source=${sourceId})`);
      return;
    }

    // 清理已不存在的笔记
    const currentUuids = new Set(allNotes.map(n => n.uuid));
    const { removed, orphanNodeIds } = removeStaleNotes(db, currentUuids, sourceId);
    if (removed > 0) {
      log.info(`清理 ${removed} 条已删除笔记, ${orphanNodeIds.length} 个孤立节点`);
      archiveOrphanNodes(db, orphanNodeIds);
    }

    if (isStopped()) {
      log.info(`Apple Notes 同步被中止 (source=${sourceId})`);
      return;
    }

    // 批量预加载标签和附件文本（一次查询，取代 N+1）
    const noteZpks = allNotes.map(n => n.zpk);
    const tagsByNote = schema.hasHashtags
      ? preloadNoteTags(noteStoreDb, noteZpks)
      : new Map<number, AppleTag[]>();
    const attachTextsByNote = preloadNoteAttachmentTexts(noteStoreDb, noteZpks);

    // 处理笔记（传入 shouldStop 回调，让 queue 在 batch 之间检查中断）
    await processNoteQueue(
      db, allNotes, folderPathMap, tagsByNote, attachTextsByNote, sourceId ?? '',
      undefined, isStopped,
    );

    if (isStopped()) {
      log.info(`Apple Notes 同步被中止，跳过后置操作 (source=${sourceId})`);
      return;
    }

    // 更新同步时间
    if (sourceId) {
      updateLastSynced(db, sourceId);
    }

    // 记录最后同步时间戳（Core Data epoch）
    const maxModDate = allNotes.reduce((max, n) => Math.max(max, n.modificationDate), 0);
    if (sourceId) {
      lastSyncTimestamps.set(sourceId, maxModDate);
    }

    const progress = getImportProgress(sourceId);
    log.info(
      `Apple Notes 同步完成: ${progress.processedNotes} 处理, ${progress.skippedNotes} 跳过, ${progress.failedNotes} 失败`,
    );

    // 记录 timeline 事件
    if (progress.processedNotes > 0) {
      logTimelineEvent(db, {
        type: 'memory',
        subtype: 'apple_notes_sync',
        title: JSON.stringify({
          key: isFirstRun ? 'apple_notes_first_import' : 'apple_notes_incremental_sync',
          params: { total: allNotes.length, processed: progress.processedNotes, skipped: progress.skippedNotes, failed: progress.failedNotes },
        }),
        detail: {
          is_first_run: isFirstRun,
          total: allNotes.length,
          processed: progress.processedNotes,
          skipped: progress.skippedNotes,
          failed: progress.failedNotes,
          source_id: sourceId,
        },
        important: isFirstRun ? 1 : 0,
      });
    }

    if (isFirstRun) {
      markFullScanCompleted(db, sourceId);
    }
  } finally {
    noteStoreDb.close();
  }
}

/**
 * 轮询变更检测
 *
 * 两层检测：
 * 1. 外层：NoteStore.sqlite 文件 mtime
 * 2. 内层：ZMODIFICATIONDATE1 增量查询
 */
async function pollForChanges(
  db: Database.Database,
  dbPath: string,
  accountZpks: number[] | undefined,
  sourceId: string,
): Promise<void> {
  // 守卫：如果正在执行 runSync 或已被停止，跳过此次轮询
  if (syncingSources.has(sourceId) || stoppedSources.has(sourceId)) {
    return;
  }
  syncingSources.add(sourceId);

  try {
    await pollForChangesInner(db, dbPath, accountZpks, sourceId);
  } finally {
    syncingSources.delete(sourceId);
  }
}

async function pollForChangesInner(
  db: Database.Database,
  dbPath: string,
  accountZpks: number[] | undefined,
  sourceId: string,
): Promise<void> {
  const isStopped = (): boolean => stoppedSources.has(sourceId);

  // 外层：检查数据库文件 mtime
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    return; // 文件不可访问
  }

  const currentMtime = Math.floor(stat.mtimeMs);
  const lastMtime = lastDbMtimes.get(sourceId) ?? 0;

  if (currentMtime === lastMtime) {
    return; // 数据库文件未变化
  }
  lastDbMtimes.set(sourceId, currentMtime);

  if (isStopped()) return;

  // 内层：查询变更的笔记
  let noteStoreDb: ReturnType<typeof openNoteStoreDb>;
  try {
    noteStoreDb = openNoteStoreDb(dbPath);
  } catch {
    return;
  }

  try {
    const schema = detectSchemaVersion(noteStoreDb);
    const since = lastSyncTimestamps.get(sourceId) ?? 0;

    if (isStopped()) return;

    // 清理已删除的笔记（检查当前数据库 UUID 列表）
    const currentUuids = listAllNoteUuids(noteStoreDb, schema, accountZpks);
    const { removed, orphanNodeIds } = removeStaleNotes(db, currentUuids, sourceId);
    if (removed > 0) {
      log.info(`增量同步清理 ${removed} 条已删除笔记, ${orphanNodeIds.length} 个孤立节点 (source=${sourceId})`);
      archiveOrphanNodes(db, orphanNodeIds);
    }

    const changedNotes = listNotesModifiedSince(noteStoreDb, schema, since, accountZpks);

    if (changedNotes.length === 0 && removed === 0) return;
    if (changedNotes.length === 0) {
      // 只有删除，没有变更，仍然要更新 last_synced
      updateLastSynced(db, sourceId);
      return;
    }

    if (isStopped()) return;

    log.info(`检测到 ${changedNotes.length} 条变更笔记 (source=${sourceId})`);

    // 获取文件夹路径映射
    const folders = listFolders(noteStoreDb, schema);
    const folderPathMap = buildFolderPathMap(folders);

    // 批量预加载标签和附件文本
    const noteZpks = changedNotes.map(n => n.zpk);
    const tagsByNote = schema.hasHashtags
      ? preloadNoteTags(noteStoreDb, noteZpks)
      : new Map<number, AppleTag[]>();
    const attachTextsByNote = preloadNoteAttachmentTexts(noteStoreDb, noteZpks);

    // 处理变更的笔记（传入 shouldStop 回调）
    await processNoteQueue(
      db, changedNotes, folderPathMap, tagsByNote, attachTextsByNote, sourceId,
      undefined, isStopped,
    );

    if (isStopped()) return;

    // 更新时间戳
    const maxModDate = changedNotes.reduce((max, n) => Math.max(max, n.modificationDate), since);
    lastSyncTimestamps.set(sourceId, maxModDate);

    updateLastSynced(db, sourceId);

    const progress = getImportProgress(sourceId);
    if (progress.processedNotes > 0) {
      logTimelineEvent(db, {
        type: 'memory',
        subtype: 'apple_notes_sync',
        title: JSON.stringify({
          key: 'apple_notes_incremental_sync',
          params: { processed: progress.processedNotes },
        }),
        detail: {
          processed: progress.processedNotes,
          incremental: true,
          source_id: sourceId,
        },
        actor: 'brain',
      });
    }
  } finally {
    noteStoreDb.close();
  }
}
