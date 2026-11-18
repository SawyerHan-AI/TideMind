// ============================================================
// Obsidian 初始化管线
//
// Phase 0-2: Obsidian 特有（扫描、分类、预处理、入库）
// Phase 3: 本来源显式链接；新旧记忆关联由 digest landing 完成
// ============================================================

import fs from 'node:fs';
import { safeReadVaultTextFileSync } from '../../utils/safe-fs.js';
import { expandTilde } from '../../utils/path.js';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getConfig, reloadConfig } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { retireNodeWithoutReplacement } from '../../db/node-lifecycle.js';
import { logTimelineEvent } from '../../db/log.js';

import { SqliteRepository } from '../../db/sqlite-repository.js';
import { walkMdFiles } from './preprocessor.js';
import { classifyFiles, buildInDegreeMap } from './classifier.js';
import { inferPageDates } from './time-inference.js';
import { readVaultConfig, getExcludedDirs } from './vault-config.js';
import { ensureSyncSchema, setFileState, getFileState, computeFileHash, markFullScanCompleted, resetFullScanState } from './sync-state.js';
import { digest } from '../../tools/digest.js';
import { refreshObsidianLinks, clearDanglingTagCache } from './explicit-links.js';
export { clearDanglingTagCache } from './explicit-links.js';
import { processFileQueue, getImportProgress } from './queue.js';

// 复用 Logseq 的 initial-heat 计算（纯函数，无 Logseq 依赖）
import { computeInitialHeat } from '../logseq/initial-heat.js';
import { clearTagNodeCache } from '../shared/property-promote.js';
import type { InitSessionContext } from '../shared/init-session.js';

const log = createLogger('obsidian-init');

// --- 预览 ---

export interface InitPreview {
  totalFiles: number;
  byCategory: Record<string, number>;
  /** 文件明细分解 */
  breakdown: { label: string; count: number }[];
  estimatedNodes: number;
  estimatedCost: {
    annotation: number;
    linkEval: number;
    emergence: number;
    total: number;
  };
}

export function previewInit(db: Database.Database, sourceId?: string, sourcePath?: string): InitPreview | null {
  reloadConfig();
  const config = getConfig();

  let vaultRoot: string;
  if (sourcePath) {
    vaultRoot = expandTilde(sourcePath);
  } else {
    const obsidianPath = config.sources?.obsidian?.path;
    if (!obsidianPath) return null;
    vaultRoot = expandTilde(obsidianPath);
  }
  if (!fs.existsSync(vaultRoot)) return null;

  const vaultConfig = readVaultConfig(vaultRoot);
  const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);
  const allFiles = walkMdFiles(vaultRoot, excludedDirs);

  const readContent = (fp: string): string | null => {
    const r = safeReadVaultTextFileSync(fp, vaultRoot);
    return r.ok ? r.content : null;
  };

  const classified = classifyFiles(allFiles, vaultRoot, vaultConfig, readContent);

  const byCategory: Record<string, number> = {};
  for (const file of classified) {
    byCategory[file.category] = (byCategory[file.category] ?? 0) + 1;
  }

  const estimatedNodes = classified.filter(f =>
    !['template', 'attachment', 'canvas'].includes(f.category),
  ).length * 1.5;

  // breakdown: 按分类展开
  const breakdown: { label: string; count: number }[] = [];
  for (const [cat, cnt] of Object.entries(byCategory)) {
    if (cnt > 0) breakdown.push({ label: cat, count: cnt });
  }

  return {
    totalFiles: allFiles.length,
    byCategory,
    breakdown,
    estimatedNodes: Math.round(estimatedNodes),
    // 导入不再主动运行这些全图库 LLM 阶段；费用明细由统一使用量日志记录。
    estimatedCost: { annotation: 0, linkEval: 0, emergence: 0, total: 0 },
  };
}

// --- 主初始化流程 ---

export interface InitReport {
  totalFiles: number;
  offlineFiles: number;
  nodesCreated: number;
  linksCreated: number;
  danglingRefs: number;
  crystalsCreated: number;
  totalCost: number;
  durationMs: number;
}

export async function runInitialization(
  db: Database.Database,
  ctx: InitSessionContext,
  sourcePath?: string,
): Promise<InitReport> {
  const sourceId = ctx.sourceId;
  const signal = ctx.signal;
  const startTime = Date.now();

  const checkAborted = () => {
    if (signal.aborted) {
      throw signal.reason ?? new Error('初始化已中断');
    }
  };

  // 清空模块级悬空 tag 缓存，防止跨 vault / 跨轮次指向错误节点
  clearDanglingTagCache();
  clearTagNodeCache();

  reloadConfig();
  const config = getConfig();

  let vaultRoot: string;
  if (sourcePath) {
    vaultRoot = expandTilde(sourcePath);
  } else {
    const obsidianPath = config.sources?.obsidian?.path;
    if (!obsidianPath) throw new Error('Obsidian path not configured');
    vaultRoot = expandTilde(obsidianPath);
  }
  if (!fs.existsSync(vaultRoot) || !fs.statSync(vaultRoot).isDirectory()) throw new Error(`Obsidian vault directory not found: ${vaultRoot}`);
  if (fs.lstatSync(vaultRoot).isSymbolicLink()) throw new Error('Obsidian vault root is a symbolic link');

  const vaultConfig = readVaultConfig(vaultRoot);
  const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);
  ensureSyncSchema(db);
  resetFullScanState(db, sourceId);

  let nodesCreated = 0;
  let linksCreated = 0;

  // === Phase 0: 扫描分类 ===
  ctx.reportPhase(0, '扫描分类', 0);
  log.info('Phase 0: 扫描分类');

  const unavailableFiles: string[] = [];
  const offlinePaths: string[] = [];
  const allFiles = walkMdFiles(vaultRoot, excludedDirs, fp => offlinePaths.push(fp), fp => unavailableFiles.push(fp));
  if (unavailableFiles.length > 0) throw new Error(`Obsidian 扫描不完整，文件或目录暂不可读 (${unavailableFiles.length})`);
  const contentCache = new Map<string, string>();
  const readCached = (fp: string): string | null => {
    if (!contentCache.has(fp)) {
      const r = safeReadVaultTextFileSync(fp, vaultRoot);
      if (!r.ok) return null;
      contentCache.set(fp, r.content);
    }
    return contentCache.get(fp) ?? null;
  };

  const classified = classifyFiles(allFiles, vaultRoot, vaultConfig, readCached);
  ctx.setProgress({ total: classified.length, current: classified.length });

  checkAborted();

  // === Phase 1: 预处理 + 时间推断 ===
  ctx.reportPhase(1, '预处理', classified.length);
  log.info('Phase 1: 预处理 + 时间推断');

  // 预处理不依赖全局文件索引，避免首次导入额外扫描/读取整个 vault。

  const inferredDates = inferPageDates(classified, readCached, vaultConfig);
  const inDegreeMap = buildInDegreeMap(classified, readCached);
  const importDate = new Date().toISOString().slice(0, 10);

  checkAborted();

  // === Phase 2: 入库 ===
  ctx.reportPhase(2, '入库', classified.length);
  log.info(`Phase 2: 入库 (${classified.length} 个文件)`);

  contentCache.clear();

  const failedFiles: string[] = [];
  for (const file of classified) {
    checkAborted();

    // 跳过不需要入库的类型
    if (['template', 'attachment'].includes(file.category)) {
      ctx.advance();
      continue;
    }

    // 断点恢复必须验证内容与节点存活；已改变的文件走增量替换，避免重复活跃节点。
    try {
      let existingState = getFileState(db, file.relPath, sourceId);
      if (existingState) {
        const initialHash = existingState.content_hash;
        const hash = computeFileHash(file.absPath, vaultRoot);
        if (hash === null) throw new Error('文件暂不可读');
        const live = existingState.node_ids.every(id => !!db.prepare(
          'SELECT id FROM nodes WHERE id = ? AND is_superseded = 0 AND archived = 0',
        ).get(id));
        if (!live) throw new Error('断点记录关联节点已失效，需要重新扫描恢复');
        if (hash !== existingState.content_hash) {
          // 即使编辑器保留 mtime/size，也不能由增量快路径跳过已确认变化。
          setFileState(db, { ...existingState, mtime: -1, size: -1 }, sourceId);
          await processFileQueue(db, [file.absPath], vaultRoot, { concurrency: 1, refreshLinks: false }, sourceId, () => signal.aborted);
          checkAborted();
          if (getImportProgress(sourceId).failedFiles > 0) throw new Error('断点文件更新失败');
          existingState = getFileState(db, file.relPath, sourceId);
          if (!existingState || existingState.content_hash !== hash) throw new Error('断点文件更新未完成');
        }
        if (hash !== initialHash) nodesCreated += existingState.node_ids.length;

      } else {
        const title = path.basename(file.relPath, path.extname(file.relPath));
        const dateInfo = inferredDates.get(file.relPath);
        const initialHeat = computeInitialHeat(dateInfo ? { date: dateInfo.date, source: 'fallback' } : undefined, inDegreeMap.get(title) ?? 0, importDate);
        await processFileQueue(db, [file.absPath], vaultRoot, {
          concurrency: 1, refreshLinks: false, initialHeat,
          created: dateInfo?.date ? `${dateInfo.date}T00:00:00.000Z` : undefined,
          category: file.category,
        }, sourceId, () => signal.aborted);
        checkAborted();
        const state = getFileState(db, file.relPath, sourceId);
        if (getImportProgress(sourceId).failedFiles > 0 || !state) throw new Error('文件导入失败');
        nodesCreated += state.node_ids.length;
      }
    } catch (err) {
      checkAborted();
      failedFiles.push(file.relPath);
      log.warn(`文件入库失败 ${file.relPath}: ${(err as Error).message}`);
    }

    ctx.advance();
    ctx.heartbeat();
  }

  if (failedFiles.length > 0) throw new Error(`Obsidian 文件入库失败 (${failedFiles.length}): ${failedFiles.join(', ')}`);

  log.info(`Phase 2 完成: ${nodesCreated} 个节点`);
  checkAborted();

  // === Phase 3: 显式链接 ===
  ctx.reportPhase(3, '显式链接', nodesCreated);
  log.info('Phase 3: 显式链接');

  const explicitResult = await refreshObsidianLinks(db, vaultRoot, sourceId, () => signal.aborted, offlinePaths);
  linksCreated += explicitResult.created;
  const danglingRefs = explicitResult.dangling;
  ctx.setProgress({ current: nodesCreated });

  log.info(`Phase 3 完成: ${explicitResult.created} 条链接, ${danglingRefs} 个悬空引用`);
  checkAborted();

  // 首次导入只处理本来源。digest 已建立新节点与既有图谱的 landing 关联，
  // 不在这里主动运行全图标注、标签提升、链接评估或结晶；后台策略继续照常执行。
  const crystalsCreated = 0;

  checkAborted();

  // 不把同期其他来源/后台的费用归入本次导入；保留旧字段供客户端兼容。
  const totalCost = 0;

  const durationMs = Date.now() - startTime;
  const report: InitReport = {
    totalFiles: classified.length,
    offlineFiles: offlinePaths.length,
    nodesCreated,
    linksCreated,
    danglingRefs,
    crystalsCreated,
    totalCost,
    durationMs,
  };

  const reportIds = await saveReportAsNode(db, report);
  try {
    checkAborted();
    db.transaction(() => {
      for (const id of reportIds) {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(`obsidian_init_report:${sourceId}:${id}`, id);
      }
      if (!offlinePaths.length) markFullScanCompleted(db, sourceId);
      logTimelineEvent(db, {
        type: 'memory',
        subtype: 'obsidian_sync',
        title: JSON.stringify({ key: 'obsidian_init_complete', params: { nodes: nodesCreated, links: linksCreated } }),
        detail: report as unknown as Record<string, unknown>,
        important: 1,
      });
    })();
  } catch (error) {
    db.transaction(() => { for (const id of reportIds) retireNodeWithoutReplacement(db, id); })();
    throw error;
  }

  log.info(`初始化完成! 耗时 ${Math.round(durationMs / 1000)}s`);
  return report;
}

// --- 内部函数 ---

async function saveReportAsNode(db: Database.Database, report: InitReport): Promise<string[]> {
  const repo = new SqliteRepository(db);
  const result = await digest(repo, {
    content: [
      `Obsidian 初始化报告`,
      ``,
      `- 处理文件: ${report.totalFiles}`,
      `- 创建节点: ${report.nodesCreated}`,
      `- 创建链接: ${report.linksCreated}`,
      `- 悬空引用: ${report.danglingRefs}`,
      `- 导入范围: 当前 Obsidian 来源（全图库代谢由后台策略执行）`,
      `- 耗时: ${Math.round(report.durationMs / 1000)}s`,
    ].join('\n'),
    source: { tool: 'obsidian' },
    tags: ['初始化'],
    async: false,
    skipDedupMerge: true,
  });
  return result.created_nodes?.map(node => node.id) ?? [];
}
