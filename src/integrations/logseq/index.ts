// ============================================================
// Logseq 集成入口
//
// 编排：初始导入 + 增量同步 + 文件监听
// 支持多实例（多个 Logseq graph）
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getConfig } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { logTimelineEvent } from '../../db/log.js';
import { archiveNodeWithVectors } from '../../db/node-lifecycle.js';
import { expandTilde } from '../../utils/path.js';

const log = createLogger('logseq');
import { buildBlockIndex, walkMdFiles, shouldProcessFile } from './preprocessor.js';
import {
  ensureSyncSchema, getAllFileStates, hasCompletedFullScan,
  markFullScanCompleted, resetFullScanState, removeStaleFiles,
  isFileChanged,
} from './sync-state.js';
import {
  processFileQueue, processFileChange, getImportProgress, resetProgress,
} from './queue.js';
import { clearTagNodeCache } from '../shared/property-promote.js';
import { DatalessSkipCounter } from '../../utils/safe-fs.js';
import {
  buildKnownRelPathSet,
  collectChangedProcessableFiles,
  createSourceFileScan,
  getAllKnownFiles,
} from '../shared/source-file-state.js';
import { SourceSyncLock } from '../shared/source-sync-lock.js';
import { decideWatcherChange } from '../shared/source-watch.js';

// --- 多实例状态 ---
// Linux 平台 fs.watch 不支持 recursive:true（会抛错），改为监听多个顶级目录
// 其他平台每个 sourceId 仍只有一个 watcher
const watchers = new Map<string, fs.FSWatcher[]>();
const debounceTimerMaps = new Map<string, Map<string, NodeJS.Timeout>>();
const stoppedSources = new Set<string>();
/** 已启动（含正在首次同步）的源 ID。startLogseqSource 入口即注册，早于 watchers.set
 * （首扫 await 完成后才发生）。stopLogseqIntegration 必须遍历它而非 watchers.keys()，
 * 否则大 graph 首扫期间该源不在 watchers 里，SIGTERM 下停不掉，shutdown 超时 closeDb
 * 后 digest 命中已关闭连接。 */
const activeSources = new Set<string>();
/** 周期性 runSync 定时器（按 poll_interval）。watcher 只感知内容变更，不处理删除
 * （decideWatcherChange 对不存在的文件返回 'skip'），删除检测只在 runSync 里发生。
 * 没有这个定时器时，用户删笔记后节点会无限期留在活跃 recall 里直到重启/手动 rescan，
 * 且 poll_interval 配置无效。增量路径靠 mtime+hash 快速跳过，syncLock 防并发。 */
const pollTimers = new Map<string, NodeJS.Timeout>();
/** 文件型源删除检测扫描默认间隔（秒）。内容变更已由 watcher 实时覆盖，定时扫描兜底删除。 */
const DEFAULT_FILE_POLL_INTERVAL = 300;
/** 正在执行 runSync 的源 ID，用于防止 watcher 事件与首次全量同步并发 */
const syncLock = new SourceSyncLock();
const WATCHER_DEBOUNCE_MS = 1000;
const WATCHER_LOCK_RETRY_MS = 1000;

/**
 * 启动单个 Logseq 笔记源实例
 */
export async function startLogseqSource(
  db: Database.Database,
  sourceId: string,
  sourcePath: string,
  pollInterval?: number,
): Promise<void> {
  const graphRoot = expandTilde(sourcePath);
  if (!fs.existsSync(graphRoot)) {
    log.error(`Logseq 目录不存在: ${graphRoot} (source=${sourceId})`);
    return;
  }

  stoppedSources.delete(sourceId);
  // 入口即登记，确保首扫期间也能被 stopLogseqIntegration 停掉（见 activeSources 注释）
  activeSources.add(sourceId);
  log.info(`初始化 Logseq 集成: ${graphRoot} (source=${sourceId})`);

  // 1. 确保同步表存在
  ensureSyncSchema(db);

  // 2. 执行首次同步，完成后再启动 watcher
  // 首次全量导入与 watcher 并发会造成同一文件被全量流程与增量流程同时处理，
  // 产生重复 digest / supersede 链混乱。await 完成后再挂 watcher。
  try {
    await runSync(db, graphRoot, sourceId);
  } catch (err) {
    log.error(`Logseq 首次同步失败 (source=${sourceId}):`, (err as Error).message);
    // 不 rethrow：即便首次同步失败也启动 watcher，用户改动后还能触发增量
  }

  // 3. 启动文件监听
  if (!stoppedSources.has(sourceId)) {
    startFilteredWatcher(db, graphRoot, sourceId);
  }

  // 4. 启动周期性同步（删除检测兜底）。首扫完成后再注册，避免与首扫并发。
  if (!stoppedSources.has(sourceId)) {
    const intervalMs = Math.max(30, pollInterval ?? DEFAULT_FILE_POLL_INTERVAL) * 1000;
    const timer = setInterval(() => {
      if (stoppedSources.has(sourceId)) return;
      runSync(db, graphRoot, sourceId).catch(err =>
        log.error(`Logseq 周期同步失败 (source=${sourceId}):`, (err as Error).message),
      );
    }, intervalMs);
    pollTimers.set(sourceId, timer);
    log.info(`Logseq 周期同步已启动: 每 ${intervalMs / 1000}s 兜底扫描删除 (source=${sourceId})`);
  }
}

/**
 * 停止单个 Logseq 笔记源实例
 */
export function stopLogseqSource(sourceId: string): void {
  stoppedSources.add(sourceId);
  activeSources.delete(sourceId);
  const ws = watchers.get(sourceId);
  if (ws) {
    for (const w of ws) {
      try { w.close(); } catch { /* ignore */ }
    }
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
  // 停止周期性同步定时器
  const pollTimer = pollTimers.get(sourceId);
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimers.delete(sourceId);
  }
}

/**
 * 兼容旧接口：从 config.toml 启动 Logseq 集成（单实例）
 */
export async function startLogseqIntegration(db: Database.Database): Promise<void> {
  const config = getConfig();
  const logseqConfig = config.sources?.logseq;

  if (!logseqConfig?.path) return;

  // 使用固定 sourceId 兼容旧的单实例模式
  await startLogseqSource(db, '__legacy_logseq__', logseqConfig.path);
}

/**
 * 执行同步：首次全量导入或增量同步
 *
 * 使用 syncingSources 做 per-source 互斥：防止 watcher 事件在首次同步期间
 * 触发 processFileChange，同时又被全量 runSync 处理，造成重复节点 / supersede 链混乱。
 */
async function runSync(
  db: Database.Database,
  graphRoot: string,
  sourceId?: string,
): Promise<void> {
  if (!syncLock.tryAcquire(sourceId)) {
    log.warn(`Logseq 同步已在进行中，跳过重复调用 (source=${sourceId})`);
    return;
  }
  try {
    await runSyncInner(db, graphRoot, sourceId);
  } finally {
    syncLock.release(sourceId);
  }
}

/** 判断 source 当前是否正在全量/增量同步（供 watcher 事件检查） */
function isSyncing(sourceId?: string): boolean {
  return syncLock.isActive(sourceId);
}

async function runSyncInner(
  db: Database.Database,
  graphRoot: string,
  sourceId?: string,
): Promise<void> {
  const isStopped = (): boolean => sourceId !== undefined && stoppedSources.has(sourceId);
  const isFirstRun = !hasCompletedFullScan(db, sourceId);

  // 重置 tag 节点缓存，防止跨周期缓存失效
  clearTagNodeCache();
  if (isStopped()) {
    log.info(`Logseq 同步被中止 (source=${sourceId})`);
    return;
  }

  // 扫描所有 .md 文件
  // iCloud dataless 文件通过 walkMdFiles 内部 onDatalessSkip 回调暴露给我们。
  // 关键修复（2026-04-23 iCloud 回归事故）：把 dataless 路径也纳入 currentRelPaths，
  // 否则 removeStaleFiles 会把 dataless 误判为"文件被删除"，批量归档节点 + 清 sync 记录，
  // 等文件从 iCloud 回流后再被 watcher 当"全新文件"重新 digest，产生大量重复节点。
  // 详见 docs/design/incident-recovery-2026-04-23-icloud-dataless.md
  const datalessSkip = new DatalessSkipCounter();
  const datalessPaths: string[] = [];
  const processableFiles = walkMdFiles(graphRoot, (fp) => {
    datalessSkip.record(fp);
    datalessPaths.push(fp);
  });
  const scan = createSourceFileScan(processableFiles, datalessPaths);
  // allKnown = 物理存在的所有笔记文件（含 dataless），用于"是否真的被删除"的判定
  const allKnownFiles = getAllKnownFiles(scan);
  log.info(
    `扫描到 ${allKnownFiles.length} 个 .md 文件（可处理 ${processableFiles.length}，dataless ${datalessPaths.length}，source=${sourceId ?? 'default'}）`,
  );
  if (datalessSkip.total > 0) {
    log.warn(
      `Logseq 源 ${sourceId ?? 'default'} 有 ${datalessSkip.total} 个文件处于 iCloud 离线状态已跳过处理 ` +
      `（示例: ${datalessSkip.sample}）。在 Finder 里下载或关闭"优化 Mac 存储"可恢复。` +
      `这些文件的 sync state 会被保留，不会触发误归档。`,
    );
  }

  if (allKnownFiles.length === 0) {
    log.warn('未扫描到任何 .md 文件，请检查路径是否正确');
    return;
  }

  if (isStopped()) {
    log.info(`Logseq 同步被中止 (source=${sourceId})`);
    return;
  }

  // 构建 block UUID 索引
  log.info('构建 block UUID 索引...');
  buildBlockIndex(graphRoot);

  // 加载同步状态，找出需要处理的文件
  // 注意：只对 processable 文件做 isFileChanged 检查，dataless 文件跳过处理（isFileChanged 会返回 false）
  const syncStates = getAllFileStates(db, sourceId);
  const filesToProcess = collectChangedProcessableFiles(
    graphRoot,
    scan.processableFiles,
    syncStates,
    isFileChanged,
  );

  // 清理已删除文件的同步记录，归档关联 nodes
  // 用 allKnownFiles（含 dataless）构造集合 → 只有真正物理不存在的文件才会被判"已删除"
  const currentRelPaths = buildKnownRelPathSet(graphRoot, scan);
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
    if (isFirstRun && allKnownFiles.length > 0) markFullScanCompleted(db, sourceId);
    return;
  }

  log.info(
    `${isFirstRun ? '首次导入' : '增量同步'}: ${filesToProcess.length} 个文件待处理`,
  );

  // 处理文件队列
  const config = getConfig();
  await processFileQueue(db, filesToProcess, graphRoot, {
    concurrency: config.sources?.logseq?.import_concurrency,
    batchSize: config.sources?.logseq?.import_batch_size,
  }, sourceId, isStopped);

  if (isStopped()) {
    log.info(`Logseq 同步被中止，跳过后置操作 (source=${sourceId})`);
    return;
  }

  // 记录同步事件到时间线（仅当有实际处理或失败时）
  const prog = getImportProgress(sourceId);

  if (prog.processedFiles > 0 || prog.failedFiles > 0) {
    logTimelineEvent(db, {
      type: 'memory',
      subtype: 'logseq_sync',
      title: JSON.stringify({ key: isFirstRun ? 'logseq_first_import' : 'logseq_incremental_sync', params: { total: filesToProcess.length, processed: prog.processedFiles, skipped: prog.skippedFiles, failed: prog.failedFiles } }),
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
  }

  // 标记全量扫描完成
  if (isFirstRun) {
    markFullScanCompleted(db, sourceId);
  }
}

/**
 * 启动文件监听（带目录过滤）
 *
 * Linux 的 fs.watch 不支持 recursive:true（会抛 ERR_FEATURE_UNAVAILABLE_ON_PLATFORM）。
 * 为避免引入 chokidar 依赖，Linux 下只监听顶级 `pages/` 和 `journals/` 两个目录（Logseq 典型结构）。
 * 子目录（如用户自建分类）不会被监听；macOS / Windows 仍走 recursive 监听。
 */
function startFilteredWatcher(
  db: Database.Database,
  graphRoot: string,
  sourceId: string,
): void {
  log.info(`开始监听: ${graphRoot} (source=${sourceId})`);

  // 初始化 debounce timer map
  if (!debounceTimerMaps.has(sourceId)) {
    debounceTimerMaps.set(sourceId, new Map());
  }
  const debounceTimers = debounceTimerMaps.get(sourceId)!;

  const handleChange = (relFromRoot: string): void => {
    // 过滤：只处理 .md 文件，排除系统目录
    if (!shouldProcessFile(relFromRoot)) return;

    scheduleChange(relFromRoot, WATCHER_DEBOUNCE_MS, 0);
  };

  const scheduleChange = (relFromRoot: string, delayMs: number, attempts: number): void => {
    const key = relFromRoot;
    if (debounceTimers.has(key)) {
      clearTimeout(debounceTimers.get(key)!);
    }

    debounceTimers.set(key, setTimeout(() => {
      debounceTimers.delete(key);
      const filePath = path.join(graphRoot, relFromRoot);
      const decision = decideWatcherChange({
        sourceActive: watchers.has(sourceId),
        fileExists: fs.existsSync(filePath),
        sourceLocked: isSyncing(sourceId),
        attempts,
      });

      if (decision === 'skip') return;
      if (decision === 'drop') {
        log.warn(`watcher 事件丢弃: source=${sourceId} file=${relFromRoot} (lock 持续 ${attempts} 次重试未释放)`);
        return;
      }
      if (decision === 'retry') {
        scheduleChange(relFromRoot, WATCHER_LOCK_RETRY_MS, attempts + 1);
        return;
      }

      processFileChange(db, filePath, graphRoot, sourceId, () => stoppedSources.has(sourceId))
        .then(changed => {
          if (!changed) return; // 内容未变（hash 相同），不写时间线
          if (stoppedSources.has(sourceId)) return;
          logTimelineEvent(db, {
            type: 'memory',
            subtype: 'logseq_file_change',
            title: JSON.stringify({ key: 'logseq_file_changed', params: { filename: relFromRoot } }),
            detail: { file: relFromRoot, source_id: sourceId },
            actor: 'brain',
          });
        })
        .catch(err =>
          log.error('文件变更处理失败:', (err as Error).message),
        );
    }, delayMs));
  };

  const isLinux = os.platform() === 'linux';
  const createdWatchers: fs.FSWatcher[] = [];

  if (isLinux) {
    // Logseq 典型结构：pages/ 和 journals/ 两个目录。不递归监听子目录。
    for (const subdir of ['pages', 'journals']) {
      const dirAbs = path.join(graphRoot, subdir);
      if (!fs.existsSync(dirAbs)) continue;
      try {
        const w = fs.watch(dirAbs, (_eventType, filename) => {
          if (!filename) return;
          // filename 是相对 dirAbs 的路径，补回 subdir/ 前缀
          handleChange(path.join(subdir, filename));
        });
        createdWatchers.push(w);
      } catch (err) {
        log.error(`监听 ${dirAbs} 失败:`, (err as Error).message);
      }
    }
    if (createdWatchers.length === 0) {
      log.warn(`Linux 下未能建立任何监听器（pages/ 和 journals/ 目录均不存在）: ${graphRoot}`);
    }
  } else {
    const w = fs.watch(graphRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      handleChange(filename);
    });
    createdWatchers.push(w);
  }

  watchers.set(sourceId, createdWatchers);
}

/**
 * 手动触发全量重新导入
 */
export async function triggerFullRescan(
  db: Database.Database,
  sourceId?: string,
  sourcePath?: string,
): Promise<void> {
  let graphRoot: string;

  if (sourcePath) {
    graphRoot = expandTilde(sourcePath);
  } else {
    // 兼容旧调用方式
    const config = getConfig();
    const logseqConfig = config.sources?.logseq;
    if (!logseqConfig?.path) return;
    graphRoot = expandTilde(logseqConfig.path);
  }

  if (!fs.existsSync(graphRoot)) return;

  // 重置全量扫描标志，触发重新扫描
  resetFullScanState(db, sourceId);
  resetProgress(sourceId);
  await runSync(db, graphRoot, sourceId);
}

/**
 * 归档因源文件被删除而孤立的节点
 *
 * archived = 1 仅用于此场景：外部笔记源删除导致的归档。
 * 走 archiveNode() 统一清理 nodes_vec / node_segments——防止已删除内容残留在
 * 向量召回里（向量搜索只看 nodes_vec 表，不过滤 archived 字段）。
 */
function archiveOrphanNodes(db: Database.Database, nodeIds: string[]): void {
  for (const id of nodeIds) {
    archiveNodeWithVectors(db, id);
  }
}

/**
 * 停止所有 Logseq 集成
 */
export function stopLogseqIntegration(): void {
  // 遍历 activeSources（含正在首扫、尚未挂 watcher 的源）而非 watchers.keys()，
  // 否则首扫中的源在 shutdown 时停不掉。复制成数组避免遍历中 delete 改动集合。
  for (const sourceId of [...activeSources]) {
    stopLogseqSource(sourceId);
  }
}

// 导出进度查询
export { getImportProgress } from './queue.js';
