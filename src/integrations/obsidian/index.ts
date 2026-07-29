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
import { archiveNodeWithVectors } from '../../db/node-lifecycle.js';
import { expandTilde } from '../../utils/path.js';

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
import { DatalessSkipCounter } from '../../utils/safe-fs.js';
import {
  buildKnownRelPathSet,
  collectChangedProcessableFiles,
  createSourceFileScan,
  getAllKnownFiles,
} from '../shared/source-file-state.js';
import { SourceSyncLock } from '../shared/source-sync-lock.js';
import { decideWatcherChange } from '../shared/source-watch.js';
import { trackBackgroundWork } from '../../utils/background-work.js';

// --- 多实例状态 ---
// Linux 的 fs.watch 不支持 recursive:true，会 fallback 到监听多个子目录
const watchers = new Map<string, fs.FSWatcher[]>();
const debounceTimerMaps = new Map<string, Map<string, NodeJS.Timeout>>();
const stoppedSources = new Set<string>();
/** 已启动（含正在首次同步）的源 ID。startObsidianSource 入口即注册——早于
 * watchers.set（后者在首扫 await 完成后才发生）。stopObsidianIntegration 必须遍历
 * 它而非 watchers.keys()：大 vault 首扫可达数十分钟，期间该源不在 watchers 里，
 * 若按 watchers.keys() 停止则 SIGTERM 下 stop 直接 no-op，isStopped() 恒 false、
 * 首扫继续跑，shutdown 超时 closeDb 后每个 digest 命中已关闭连接（孤儿+重复节点）。 */
const activeSources = new Set<string>();
/** 周期性 runSync 定时器（按 poll_interval）。watcher 只感知文件内容变更，
 * 不处理删除（decideWatcherChange 对不存在的文件返回 'skip'），删除检测
 * （removeStaleFiles + archiveOrphanNodes）只在 runSync 里发生。没有这个定时器时，
 * 用户删笔记后对应节点会无限期保留在活跃 recall 里直到下次重启/手动 rescan，
 * 且 note_sources.poll_interval 配置完全无效。runSync 的增量路径靠 mtime+hash
 * 快速跳过未变文件，定时全扫成本可控；syncLock 保证不与 watcher/首扫并发。 */
const pollTimers = new Map<string, NodeJS.Timeout>();
/** 文件型源的删除检测扫描默认间隔（秒）。比 Apple Notes 的 60s 长，因为这里每次要
 * 全目录 walk，而内容变更已由 watcher 实时覆盖，定时扫描只为兜底删除/漏检。 */
const DEFAULT_FILE_POLL_INTERVAL = 300;
const syncLock = new SourceSyncLock();
const WATCHER_DEBOUNCE_MS = 1000;
const WATCHER_LOCK_RETRY_MS = 1000;

/**
 * 启动单个 Obsidian 笔记源实例
 */
export async function startObsidianSource(
  db: Database.Database,
  sourceId: string,
  sourcePath: string,
  pollInterval?: number,
): Promise<void> {
  const vaultRoot = expandTilde(sourcePath);
  if (!fs.existsSync(vaultRoot)) {
    log.error(`Obsidian vault 目录不存在: ${vaultRoot} (source=${sourceId})`);
    return;
  }

  stoppedSources.delete(sourceId);
  // 入口即登记，确保首扫期间也能被 stopObsidianIntegration 停掉（见 activeSources 注释）
  activeSources.add(sourceId);
  log.info(`初始化 Obsidian 集成: ${vaultRoot} (source=${sourceId})`);

  // 1. 确保同步表存在
  ensureSyncSchema(db);

  // 2. 执行首次同步，完成后再启动 watcher
  // 首次全量导入与 watcher 并发会造成同一文件被全量流程与增量流程同时处理，
  // 产生重复 digest / supersede 链混乱。await 完成后再挂 watcher，参考 Apple Notes 的做法。
  try {
    await runSync(db, vaultRoot, sourceId);
  } catch (err) {
    log.error(`Obsidian 首次同步失败 (source=${sourceId}):`, (err as Error).message);
    // 不 rethrow：即便首次同步失败也启动 watcher，用户改动后还能触发增量
  }

  // 3. 启动文件监听
  if (!stoppedSources.has(sourceId)) {
    const vaultConfig = readVaultConfig(vaultRoot);
    const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);
    startFilteredWatcher(db, vaultRoot, sourceId, excludedDirs);
  }

  // 4. 启动周期性同步（删除检测兜底）。首扫完成后再注册，避免与首扫并发。
  if (!stoppedSources.has(sourceId)) {
    const intervalMs = Math.max(30, pollInterval ?? DEFAULT_FILE_POLL_INTERVAL) * 1000;
    const timer = setInterval(() => {
      if (stoppedSources.has(sourceId)) return;
      const work = runSync(db, vaultRoot, sourceId).catch(err =>
        log.error(`Obsidian 周期同步失败 (source=${sourceId}):`, (err as Error).message),
      );
      void trackBackgroundWork(work);
    }, intervalMs);
    pollTimers.set(sourceId, timer);
    log.info(`Obsidian 周期同步已启动: 每 ${intervalMs / 1000}s 兜底扫描删除 (source=${sourceId})`);
  }
}

/**
 * 停止单个 Obsidian 笔记源实例
 */
export function stopObsidianSource(sourceId: string): void {
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
 *
 * 使用 syncingSources 做 per-source 互斥：防止 watcher 事件在首次同步期间
 * 触发 processFileChange，同时又被全量 runSync 处理，造成重复节点 / supersede 链混乱。
 */
async function runSync(
  db: Database.Database,
  vaultRoot: string,
  sourceId?: string,
): Promise<void> {
  if (!syncLock.tryAcquire(sourceId)) {
    log.warn(`Obsidian 同步已在进行中，跳过重复调用 (source=${sourceId})`);
    return;
  }
  try {
    await runSyncInner(db, vaultRoot, sourceId);
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
  vaultRoot: string,
  sourceId?: string,
): Promise<void> {
  const isStopped = (): boolean => sourceId !== undefined && stoppedSources.has(sourceId);
  const isFirstRun = !hasCompletedFullScan(db, sourceId);
  const vaultConfig = readVaultConfig(vaultRoot);
  const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);

  // 重置 tag 节点缓存，防止跨周期缓存失效
  clearTagNodeCache();
  if (isStopped()) {
    log.info(`Obsidian 同步被中止 (source=${sourceId})`);
    return;
  }

  // 扫描所有 .md / .canvas 文件
  // 关键修复（2026-04-23 iCloud 回归事故对称修复）：iCloud dataless 文件要纳入 currentRelPaths，
  // 否则 removeStaleFiles 会把它们误判为"被删除"，归档节点 + 清 sync 记录；等文件回流时
  // watcher 把它们当"新文件"重新 digest 产生重复。与 Logseq 集成对称修复。
  const datalessSkip = new DatalessSkipCounter();
  const datalessPaths: string[] = [];
  const processableFiles = walkMdFiles(vaultRoot, excludedDirs, (fp) => {
    datalessSkip.record(fp);
    datalessPaths.push(fp);
  });
  const scan = createSourceFileScan(processableFiles, datalessPaths);
  const allKnownFiles = getAllKnownFiles(scan);
  log.info(
    `扫描到 ${allKnownFiles.length} 个文件（可处理 ${processableFiles.length}，dataless ${datalessPaths.length}，source=${sourceId ?? 'default'}）`,
  );
  if (datalessSkip.total > 0) {
    log.warn(
      `Obsidian 源 ${sourceId ?? 'default'} 有 ${datalessSkip.total} 个文件处于 iCloud 离线状态已跳过处理 ` +
      `（示例: ${datalessSkip.sample}）。在 Finder 里下载或关闭"优化 Mac 存储"可恢复。` +
      `这些文件的 sync state 会被保留，不会触发误归档。`,
    );
  }

  if (allKnownFiles.length === 0) {
    log.warn('未扫描到任何文件，请检查路径是否正确');
    return;
  }

  if (isStopped()) {
    log.info(`Obsidian 同步被中止 (source=${sourceId})`);
    return;
  }

  // 构建文件索引（用于 wikilink 解析）
  log.info('构建文件索引...');
  buildFileIndex(vaultRoot, excludedDirs);

  // 加载同步状态，找出需要处理的文件（只对 processable 做 isFileChanged）
  const syncStates = getAllFileStates(db, sourceId);
  const filesToProcess = collectChangedProcessableFiles(
    vaultRoot,
    scan.processableFiles,
    syncStates,
    isFileChanged,
  );

  // 清理已删除文件的同步记录，归档关联 nodes
  // 用 allKnownFiles（含 dataless）构造集合 → 只有真正物理不存在的文件才会被判"已删除"
  const currentRelPaths = buildKnownRelPathSet(vaultRoot, scan);
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
  await processFileQueue(db, filesToProcess, vaultRoot, {
    concurrency: config.sources?.obsidian?.import_concurrency,
    batchSize: config.sources?.obsidian?.import_batch_size,
  }, sourceId, isStopped);

  if (isStopped()) {
    log.info(`Obsidian 同步被中止，跳过后置操作 (source=${sourceId})`);
    return;
  }

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
 *
 * Linux 的 fs.watch 不支持 recursive:true（会抛 ERR_FEATURE_UNAVAILABLE_ON_PLATFORM）。
 * 为避免引入 chokidar 依赖，Linux 下递归扫描 vault 目录，为每个子目录各建一个
 * 非递归 watcher。这会产生较多 watcher，但对中型 vault（< 几千个目录）可用。
 * macOS / Windows 仍走单个 recursive 监听。
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

  const handleChange = (relFromRoot: string): void => {
    // 过滤：只处理 .md / .canvas 文件，排除系统目录
    if (!shouldProcessFile(relFromRoot, excludedDirs)) return;

    scheduleChange(relFromRoot, WATCHER_DEBOUNCE_MS, 0);
  };

  const scheduleChange = (relFromRoot: string, delayMs: number, attempts: number): void => {
    const key = relFromRoot;
    if (debounceTimers.has(key)) {
      clearTimeout(debounceTimers.get(key)!);
    }

    debounceTimers.set(key, setTimeout(() => {
      debounceTimers.delete(key);
      const filePath = path.join(vaultRoot, relFromRoot);
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

      const work = processFileChange(db, filePath, vaultRoot, sourceId, () => stoppedSources.has(sourceId))
        .then(changed => {
          if (stoppedSources.has(sourceId)) return;
          // 仅当文件实际产生处理时写时间线,对齐 Logseq S10 修复。
          // mtime 漂移 / 格式化保存 / git pull / Dropbox 同步等"无内容变化"事件不产生噪声。
          if (!changed) return;
          logTimelineEvent(db, {
            type: 'memory',
            subtype: 'obsidian_file_change',
            title: JSON.stringify({ key: 'obsidian_file_changed', params: { filename: relFromRoot } }),
            detail: { file: relFromRoot, source_id: sourceId },
            actor: 'brain',
          });
        })
        .catch(err =>
          log.error('文件变更处理失败:', (err as Error).message),
        );
      void trackBackgroundWork(work);
    }, delayMs));
  };

  const createdWatchers: fs.FSWatcher[] = [];
  const isLinux = os.platform() === 'linux';

  if (isLinux) {
    // Linux: 递归扫描，为每个子目录各建一个非递归 watcher
    const excludeSet = new Set(excludedDirs);
    const dirsToWatch: string[] = [];
    const walkDirs = (abs: string): void => {
      dirsToWatch.push(abs);
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (excludeSet.has(e.name)) continue;
        if (e.name.startsWith('.')) continue; // 跳过 .obsidian / .trash 等
        walkDirs(path.join(abs, e.name));
      }
    };
    walkDirs(vaultRoot);

    for (const dirAbs of dirsToWatch) {
      try {
        const w = fs.watch(dirAbs, (_eventType, filename) => {
          if (!filename) return;
          const relFromDir = path.relative(vaultRoot, path.join(dirAbs, filename)).replace(/\\/g, '/');
          handleChange(relFromDir);
        });
        createdWatchers.push(w);
      } catch (err) {
        log.debug(`监听 ${dirAbs} 失败: ${(err as Error).message}`);
      }
    }
    if (createdWatchers.length === 0) {
      log.warn(`Linux 下未能建立任何监听器: ${vaultRoot}`);
    } else {
      log.info(`Linux fallback: ${createdWatchers.length} 个非递归 watcher`);
    }
  } else {
    try {
      const w = fs.watch(vaultRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        handleChange(filename);
      });
      createdWatchers.push(w);
    } catch (err) {
      log.error(`启动 recursive watcher 失败: ${(err as Error).message}`);
    }
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
  let vaultRoot: string;

  if (sourcePath) {
    vaultRoot = expandTilde(sourcePath);
  } else {
    // 兼容旧调用方式
    const config = getConfig();
    const obsidianConfig = config.sources?.obsidian;
    if (!obsidianConfig?.path) return;
    vaultRoot = expandTilde(obsidianConfig.path);
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
 * 走 archiveNode() 统一清理 nodes_vec / node_segments——防止已删除内容残留在
 * 向量召回里（向量搜索只看 nodes_vec 表，不过滤 archived 字段）。
 */
function archiveOrphanNodes(db: Database.Database, nodeIds: string[]): void {
  for (const id of nodeIds) {
    archiveNodeWithVectors(db, id);
  }
}

/**
 * 停止所有 Obsidian 集成
 */
export function stopObsidianIntegration(): void {
  // 遍历 activeSources（含正在首扫、尚未挂 watcher 的源）而非 watchers.keys()，
  // 否则首扫中的源在 shutdown 时停不掉。复制成数组避免遍历中 delete 改动集合。
  for (const sourceId of [...activeSources]) {
    stopObsidianSource(sourceId);
  }
}

// 导出进度查询
export { getImportProgress } from './queue.js';
