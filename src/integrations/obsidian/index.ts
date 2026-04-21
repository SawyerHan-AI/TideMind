// ============================================================
// Obsidian 集成入口
//
// 编排：初始导入 + 增量同步 + 文件监听
// 支持多实例（多个 Obsidian vault）
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getConfig } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { logTimelineEvent } from '../../db/log.js';
import { updateNode } from '../../db/nodes.js';

const log = createLogger('obsidian');
import { walkMdFiles, shouldProcessFile, buildFileIndex } from './preprocessor.js';
import { readVaultConfig, getExcludedDirs } from './vault-config.js';
import {
  ensureSyncSchema, getAllFileStates, hasCompletedFullScan,
  markFullScanCompleted, resetFullScanState, removeStaleFiles,
  isFileChanged,
} from './sync-state.js';
import {
  processFileQueue, processFileChange, getImportProgress, resetProgress,
} from './queue.js';
import { clearTagNodeCache } from '../shared/property-promote.js';
import { clearDanglingTagCache } from './initialization.js';

// --- 多实例状态 ---
const watchers = new Map<string, fs.FSWatcher>();
const debounceTimerMaps = new Map<string, Map<string, NodeJS.Timeout>>();

/**
 * 启动单个 Obsidian 笔记源实例
 */
export async function startObsidianSource(
  db: Database.Database,
  sourceId: string,
  sourcePath: string,
  _pollInterval?: number,
): Promise<void> {
  const vaultRoot = sourcePath.replace('~', os.homedir());
  if (!fs.existsSync(vaultRoot)) {
    log.error(`Obsidian vault 目录不存在: ${vaultRoot} (source=${sourceId})`);
    return;
  }

  log.info(`初始化 Obsidian 集成: ${vaultRoot} (source=${sourceId})`);

  // 1. 确保同步表存在
  ensureSyncSchema(db);

  // 2. 执行同步（后台，不阻塞 daemon 启动）
  runSync(db, vaultRoot, sourceId).catch(err =>
    log.error(`Obsidian 同步失败 (source=${sourceId}):`, (err as Error).message),
  );

  // 3. 启动文件监听
  const vaultConfig = readVaultConfig(vaultRoot);
  const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);
  startFilteredWatcher(db, vaultRoot, sourceId, excludedDirs);
}

/**
 * 停止单个 Obsidian 笔记源实例
 */
export function stopObsidianSource(sourceId: string): void {
  const w = watchers.get(sourceId);
  if (w) {
    w.close();
    watchers.delete(sourceId);
  }
  const timers = debounceTimerMaps.get(sourceId);
  if (timers) {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    debounceTimerMaps.delete(sourceId);
  }
}

/**
 * 兼容旧接口：从 config.toml 启动 Obsidian 集成（单实例）
 */
export async function startObsidianIntegration(db: Database.Database): Promise<void> {
  const config = getConfig();
  const obsidianConfig = config.sources?.obsidian;

  if (!obsidianConfig?.path) return;

  // 使用固定 sourceId 兼容旧的单实例模式
  await startObsidianSource(db, '__legacy_obsidian__', obsidianConfig.path);
}

/**
 * 执行同步：首次全量导入或增量同步
 */
async function runSync(
  db: Database.Database,
  vaultRoot: string,
  sourceId?: string,
): Promise<void> {
  const isFirstRun = !hasCompletedFullScan(db, sourceId);
  const vaultConfig = readVaultConfig(vaultRoot);
  const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);

  // 重置 tag 节点缓存，防止跨周期缓存失效
  clearTagNodeCache();

  // 扫描所有 .md / .canvas 文件
  const allFiles = walkMdFiles(vaultRoot, excludedDirs);
  log.info(`扫描到 ${allFiles.length} 个文件 (source=${sourceId ?? 'default'})`);

  if (allFiles.length === 0) {
    log.warn('未扫描到任何文件，请检查路径是否正确');
    return;
  }

  // 构建文件索引（用于 wikilink 解析）
  log.info('构建文件索引...');
  buildFileIndex(vaultRoot, excludedDirs);

  // 加载同步状态，找出需要处理的文件
  const syncStates = getAllFileStates(db, sourceId);
  const filesToProcess: string[] = [];

  for (const filePath of allFiles) {
    const relPath = path.relative(vaultRoot, filePath).replace(/\\/g, '/');
    const syncState = syncStates.get(relPath) ?? null;

    if (isFileChanged(filePath, syncState)) {
      filesToProcess.push(filePath);
    }
  }

  // 清理已删除文件的同步记录，归档关联 nodes
  const currentRelPaths = new Set(
    allFiles.map(f => path.relative(vaultRoot, f).replace(/\\/g, '/')),
  );
  const { removed: staleRemoved, orphanNodeIds } = removeStaleFiles(db, currentRelPaths, sourceId);
  if (staleRemoved > 0) {
    log.info(`清理 ${staleRemoved} 条过期同步记录`);
  }
  if (orphanNodeIds.length > 0) {
    archiveOrphanNodes(db, orphanNodeIds);
    log.info(`归档 ${orphanNodeIds.length} 个因源文件删除而孤立的节点`);
  }

  if (filesToProcess.length === 0) {
    log.info('无需处理的文件变更');
    // 首次运行但所有文件均为最新（例如重启后再次触发），标记完成
    if (isFirstRun && allFiles.length > 0) markFullScanCompleted(db, sourceId);
    return;
  }

  log.info(
    `${isFirstRun ? '首次导入' : '增量同步'}: ${filesToProcess.length} 个文件待处理`,
  );

  // 处理文件队列
  const config = getConfig();
  await processFileQueue(db, filesToProcess, vaultRoot, {
    concurrency: config.sources?.obsidian?.import_concurrency,
    batchSize: config.sources?.obsidian?.import_batch_size,
  }, sourceId);

  // 记录同步事件到时间线
  const prog = getImportProgress(sourceId);

  logTimelineEvent(db, {
    type: 'memory',
    subtype: 'obsidian_sync',
    title: JSON.stringify({ key: isFirstRun ? 'obsidian_first_import' : 'obsidian_incremental_sync', params: { total: filesToProcess.length, processed: prog.processedFiles, skipped: prog.skippedFiles, failed: prog.failedFiles } }),
    detail: {
      is_first_run: isFirstRun,
      total: filesToProcess.length,
      processed: prog.processedFiles,
      skipped: prog.skippedFiles,
      failed: prog.failedFiles,
      source_id: sourceId,
    },
    important: isFirstRun ? 1 : 0,
    actor: 'brain',
  });

  // 标记全量扫描完成
  if (isFirstRun) {
    markFullScanCompleted(db, sourceId);
  }
}

/**
 * 启动文件监听（带目录过滤）
 */
function startFilteredWatcher(
  db: Database.Database,
  vaultRoot: string,
  sourceId: string,
  excludedDirs: string[] = [],
): void {
  log.info(`开始监听: ${vaultRoot} (source=${sourceId})`);

  // 初始化 debounce timer map
  if (!debounceTimerMaps.has(sourceId)) {
    debounceTimerMaps.set(sourceId, new Map());
  }
  const debounceTimers = debounceTimerMaps.get(sourceId)!;

  const w = fs.watch(vaultRoot, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    // 过滤：只处理 .md / .canvas 文件，排除系统目录
    if (!shouldProcessFile(filename, excludedDirs)) return;

    // 防抖 1 秒
    const key = filename;
    if (debounceTimers.has(key)) {
      clearTimeout(debounceTimers.get(key)!);
    }

    debounceTimers.set(key, setTimeout(() => {
      debounceTimers.delete(key);
      const filePath = path.join(vaultRoot, filename);

      if (!fs.existsSync(filePath)) return; // 文件被删除

      processFileChange(db, filePath, vaultRoot, sourceId)
        .then(() => {
          logTimelineEvent(db, {
            type: 'memory',
            subtype: 'obsidian_file_change',
            title: JSON.stringify({ key: 'obsidian_file_changed', params: { filename } }),
            detail: { file: filename, source_id: sourceId },
            actor: 'brain',
          });
        })
        .catch(err =>
          log.error('文件变更处理失败:', (err as Error).message),
        );
    }, 1000));
  });

  watchers.set(sourceId, w);
}

/**
 * 手动触发全量重新导入
 */
export async function triggerFullRescan(
  db: Database.Database,
  sourceId?: string,
  sourcePath?: string,
): Promise<void> {
  let vaultRoot: string;

  if (sourcePath) {
    vaultRoot = sourcePath.replace('~', os.homedir());
  } else {
    // 兼容旧调用方式
    const config = getConfig();
    const obsidianConfig = config.sources?.obsidian;
    if (!obsidianConfig?.path) return;
    vaultRoot = obsidianConfig.path.replace('~', os.homedir());
  }

  if (!fs.existsSync(vaultRoot)) return;

  // 重置全量扫描标志，触发重新扫描
  resetFullScanState(db, sourceId);
  resetProgress(sourceId);
  // 清空模块级悬空 tag 缓存，防止跨 vault / 跨轮次指向错误节点
  clearDanglingTagCache();
  await runSync(db, vaultRoot, sourceId);
}

/**
 * 归档因源文件被删除而孤立的节点
 *
 * archived = 1 仅用于此场景：外部笔记源删除导致的归档。
 * 同时降 heat 到 0.01，利用现有查询条件 (heat > 0.01) 立即隔离。
 */
function archiveOrphanNodes(db: Database.Database, nodeIds: string[]): void {
  const stmt = db.prepare(
    'UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ? AND archived = 0',
  );
  for (const id of nodeIds) {
    stmt.run(id);
  }
}

/**
 * 停止所有 Obsidian 集成
 */
export function stopObsidianIntegration(): void {
  for (const sourceId of watchers.keys()) {
    stopObsidianSource(sourceId);
  }
}

// 导出进度查询
export { getImportProgress } from './queue.js';
