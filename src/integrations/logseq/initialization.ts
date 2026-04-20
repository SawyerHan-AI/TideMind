// ============================================================
// Logseq 初始化管线
//
// Phase 0-8 批量导入流程，专为首次大量笔记导入设计。
// 与增量同步（index.ts）互补：初始化完成后走增量。
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getConfig, reloadConfig, isLlmConfigured } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { logTimelineEvent } from '../../db/log.js';
import { now } from '../../utils/time.js';
import { generateId } from '../../utils/id.js';

import { SqliteRepository } from '../../db/sqlite-repository.js';
import { walkMdFiles, buildBlockIndex, preprocessFile } from './preprocessor.js';
import { SYSTEM_PROPERTIES } from './types.js';
import { segmentContent } from './segmenter.js';
import { classifyFiles, buildInDegreeMap, type ClassifiedFile, type ClassificationResult } from './classifier.js';
import { inferPageDates, sortByTime, type InferredDates } from './time-inference.js';
import { computeInitialHeat } from './initial-heat.js';
import { importVersionHistory, scanVersionFiles, deduplicateVersions } from './version-files.js';
import { ensureSyncSchema, setFileState, getFileState, computeFileHash, getFileStat } from './sync-state.js';
import { digest } from '../../tools/digest.js';
import { createLink, linkExists } from '../../db/links.js';
import { getNode } from '../../db/nodes.js';
import { promotePropertyValues, getOrCreateTagNode } from '../shared/property-promote.js';
import { runAnnotation } from '../../metabolism/annotate.js';
import { runLinkEvaluate } from '../../metabolism/link-evaluate.js';
import { runKeystoneIdentification } from '../../metabolism/divergent.js';
import { runCrystalEmergence } from '../../metabolism/divergent.js';
import { runTemporalCrystal } from '../../metabolism/temporal-crystal.js';
import { promoteFrequentTags } from '../../metabolism/tag-promote.js';
import { markFullScanCompleted } from './sync-state.js';
import { findLandingConnections } from '../../graph/landing.js';
import { getEmbedding } from '../../llm/embedding.js';
import { searchVectors } from '../../db/vectors.js';
import { estimateCost } from '../../llm/pricing.js';

const log = createLogger('logseq-init');

// --- 进度跟踪 ---

export interface InitProgress {
  phase: number;
  phaseName: string;
  current: number;
  total: number;
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  error?: string;
}

// --- 多实例状态 ---
const DEFAULT_PROGRESS: InitProgress = {
  phase: -1,
  phaseName: 'idle',
  current: 0,
  total: 0,
  status: 'idle',
  startedAt: null,
};
const DEFAULT_SOURCE = '__default__';

const progressMap = new Map<string, InitProgress>();
const abortedSet = new Set<string>();
const initializingSet = new Set<string>();

function getProgress(sourceId?: string): InitProgress {
  const key = sourceId ?? DEFAULT_SOURCE;
  if (!progressMap.has(key)) {
    progressMap.set(key, { ...DEFAULT_PROGRESS });
  }
  return progressMap.get(key)!;
}

export function getInitProgress(sourceId?: string): InitProgress {
  return { ...getProgress(sourceId) };
}

export function abortInit(sourceId?: string): void {
  abortedSet.add(sourceId ?? DEFAULT_SOURCE);
}

export function isAnyInitializing(): boolean {
  return initializingSet.size > 0;
}

function isAborted(sourceId?: string): boolean {
  return abortedSet.has(sourceId ?? DEFAULT_SOURCE);
}

function setPhase(phase: number, name: string, total: number, sourceId?: string): void {
  const key = sourceId ?? DEFAULT_SOURCE;
  progressMap.set(key, { phase, phaseName: name, current: 0, total, status: 'running', startedAt: now() });
}

function advanceProgress(delta: number = 1, sourceId?: string): void {
  getProgress(sourceId).current += delta;
}

// --- 预览（不执行导入） ---

export interface InitPreview {
  classification: ClassificationResult;
  /** version-files 统计（去重后） */
  versionFiles: { totalRaw: number; afterDedup: number; groups: number };
  /** 所有扫描到的文件总数（普通文件 + 原始版本文件，与扫描阶段口径一致） */
  totalFiles: number;
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

/**
 * 预览初始化结果（Phase 1 前的扫描）
 */
export function previewInit(db: Database.Database, sourceId?: string, sourcePath?: string): InitPreview | null {
  reloadConfig(); // 确保读到客户端最新保存的 config
  const config = getConfig();

  let graphRoot: string;
  if (sourcePath) {
    graphRoot = sourcePath.replace('~', os.homedir());
  } else {
    const logseqPath = config.sources?.logseq?.path;
    if (!logseqPath) return null;
    graphRoot = logseqPath.replace('~', os.homedir());
  }
  if (!fs.existsSync(graphRoot)) return null;

  const allFiles = walkMdFiles(graphRoot);
  const classification = classifyFiles(allFiles, graphRoot);

  // 统计 version-files（去重后的数量才是实际会入库的）
  const versionGroups = scanVersionFiles(graphRoot);
  let versionTotalRaw = 0;
  let versionAfterDedup = 0;
  for (const [, versions] of versionGroups) {
    versionTotalRaw += versions.length;
    versionAfterDedup += deduplicateVersions(versions).length;
  }

  // 粗估节点数
  const c = classification.summary.byCategory;
  const estimatedNodes =
    c.journal * 2.7 +  // 日记平均每篇 2.7 个一级块
    c.normal +
    c.short_definition +
    c.pdf_annotation * 5 +
    c.empty_tag +
    c.index_page +
    versionAfterDedup;  // 版本文件每个产生 1 个 superseded 节点

  // 粗估费用（基于 token 数估算）
  const avgTokensPerNode = 200;
  const totalInputTokens = estimatedNodes * avgTokensPerNode;

  // 从配置读取当前模型定价
  const annotationCost = estimateCost(
    config.llm.light_model, totalInputTokens * 4, totalInputTokens * 0.3, 0,
  );
  const linkEvalCost = estimateCost(
    config.llm.standard_model, totalInputTokens * 8, totalInputTokens * 0.5, 0,
  );
  const emergenceCost = estimateCost(
    config.llm.heavy_model, totalInputTokens * 0.1, totalInputTokens * 0.02, totalInputTokens * 0.05,
  );

  // breakdown: 有效笔记按分类 + 历史版本
  const breakdown: { label: string; count: number }[] = [];
  // 有效笔记（按类型展开）
  if (c.journal) breakdown.push({ label: 'journal', count: c.journal });
  if (c.normal) breakdown.push({ label: 'normal', count: c.normal });
  if (c.pdf_annotation) breakdown.push({ label: 'pdf_annotation', count: c.pdf_annotation });
  if (c.short_definition) breakdown.push({ label: 'short_definition', count: c.short_definition });
  if (c.index_page) breakdown.push({ label: 'index_page', count: c.index_page });
  if (c.empty_tag) breakdown.push({ label: 'empty_tag', count: c.empty_tag });
  // 历史版本
  if (versionTotalRaw > 0) breakdown.push({ label: 'version_files', count: versionTotalRaw });

  return {
    classification,
    versionFiles: {
      totalRaw: versionTotalRaw,
      afterDedup: versionAfterDedup,
      groups: versionGroups.size,
    },
    // 与扫描阶段口径一致：普通文件 + 原始版本文件数
    totalFiles: classification.summary.total + versionTotalRaw,
    breakdown,
    estimatedNodes: Math.round(estimatedNodes),
    estimatedCost: {
      annotation: Math.round(annotationCost * 100) / 100,
      linkEval: Math.round(linkEvalCost * 100) / 100,
      emergence: Math.round(emergenceCost * 100) / 100,
      total: Math.round((annotationCost + linkEvalCost + emergenceCost) * 100) / 100,
    },
  };
}

// --- 主初始化流程 ---

export interface InitReport {
  totalFiles: number;
  nodesCreated: number;
  linksCreated: number;
  danglingRefs: number;
  timeCoverage: number;  // 有时间信息的节点比例
  crystalsCreated: number;
  totalCost: number;
  durationMs: number;
}

/**
 * 执行完整初始化管线（Phase 0-8）
 */
export async function runInitialization(db: Database.Database, sourceId?: string, sourcePath?: string): Promise<InitReport> {
  const key = sourceId ?? DEFAULT_SOURCE;
  if (initializingSet.has(key)) throw new Error('初始化已在进行中，不能重复启动');
  // 全局锁：同一时刻只允许一个初始化
  if (initializingSet.size > 0) throw new Error('有其他笔记源正在初始化，请等待完成后再试');
  initializingSet.add(key);
  abortedSet.delete(key);
  const startTime = Date.now();

  reloadConfig(); // 确保读到客户端最新保存的 config
  const config = getConfig();

  let graphRoot: string;
  if (sourcePath) {
    graphRoot = sourcePath.replace('~', os.homedir());
  } else {
    const logseqPath = config.sources?.logseq?.path;
    if (!logseqPath) throw new Error('Logseq path not configured');
    graphRoot = logseqPath.replace('~', os.homedir());
  }
  if (!fs.existsSync(graphRoot)) throw new Error(`Logseq path not found: ${graphRoot}`);

  ensureSyncSchema(db);

  let nodesCreated = 0;
  let linksCreated = 0;
  let danglingRefs = 0;

  try {
    // === Phase 0: 扫描分类 ===
    setPhase(0, '扫描分类', 0, sourceId);
    log.info('Phase 0: 扫描分类');

    const allFiles = walkMdFiles(graphRoot);
    const classification = classifyFiles(allFiles, graphRoot);
    getProgress(sourceId).total = classification.summary.total;
    getProgress(sourceId).current = classification.summary.total;

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 1: 全量预处理 + 时间推断 ===
    setPhase(1, '预处理', classification.summary.total, sourceId);
    log.info('Phase 1: 全量预处理');

    buildBlockIndex(graphRoot);

    // 共享文件内容缓存（时间推断 + 入度统计复用）
    const contentCache = new Map<string, string>();
    const readCached = (fp: string): string | null => {
      if (!contentCache.has(fp)) {
        try { contentCache.set(fp, fs.readFileSync(fp, 'utf-8')); }
        catch { return null; }
      }
      return contentCache.get(fp) ?? null;
    };

    // 时间推断（六层策略链）
    const inferredDates = inferPageDates(classification.files, readCached);

    // 入度统计
    const inDegreeMap = buildInDegreeMap(classification.files, readCached);

    // 导入日期基准
    const importDate = new Date().toISOString().slice(0, 10);

    // 按时间排序（contentCache 保留到 Phase 3 后再释放）
    const sortedFiles = sortByTime(classification.files, inferredDates);
    getProgress(sourceId).current = sortedFiles.length;

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 2: 按时间排序入库 ===
    setPhase(2, '入库', sortedFiles.length, sourceId);
    log.info(`Phase 2: 按时间排序入库 (${sortedFiles.length} 个文件)`);

    // 文件 → 节点ID 映射（用于 Phase 3 显式链接）
    const fileToNodeIds = new Map<string, string[]>();

    for (const file of sortedFiles) {
      if (isAborted(sourceId)) throw new Error('初始化已中断');

      // 断点恢复：跳过已入库的文件
      const existingState = getFileState(db, file.relPath, sourceId);
      if (existingState && existingState.node_ids.length > 0) {
        fileToNodeIds.set(file.title, existingState.node_ids);
        nodesCreated += existingState.node_ids.length;
        advanceProgress(1, sourceId);
        continue;
      }

      try {
        const nodeIds = await processFileForInit(db, file, graphRoot, inferredDates, inDegreeMap, importDate, sourceId);
        if (nodeIds.length > 0) {
          fileToNodeIds.set(file.title, nodeIds);
          nodesCreated += nodeIds.length;
        }
      } catch (err) {
        log.warn(`文件入库失败 ${file.relPath}: ${(err as Error).message}`);
      }

      advanceProgress(1, sourceId);
    }

    log.info(`Phase 2 完成: ${nodesCreated} 个节点`);
    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 2.5: 版本文件导入 ===
    log.info('Phase 2.5: 版本文件导入');
    try {
      const versionCount = await importVersionHistory(db, graphRoot, fileToNodeIds);
      if (versionCount > 0) {
        log.info(`Phase 2.5 完成: ${versionCount} 个历史版本`);
      }
    } catch (err) {
      log.warn(`版本文件导入失败: ${(err as Error).message}`);
    }

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 3: Logseq 显式链接 ===
    setPhase(3, '显式链接', nodesCreated, sourceId);
    log.info('Phase 3: Logseq 显式链接转化');

    const explicitResult = await createExplicitLinks(db, sortedFiles, fileToNodeIds, contentCache);
    linksCreated += explicitResult.created;
    danglingRefs = explicitResult.dangling;
    getProgress(sourceId).current = nodesCreated;

    // Phase 3 之后释放内容缓存
    contentCache.clear();

    log.info(`Phase 3 完成: ${explicitResult.created} 条显式链接, ${danglingRefs} 个悬空引用`);
    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 3.5: 标签提升 ===
    // 所有节点和基本链接已建立，标签引用计数准确
    // 此时提升标签，使其参与后续的标注、Landing Connections 等流程
    log.info('Phase 3.5: 标签提升');
    try {
      const tagResult = await promoteFrequentTags(db);
      if (tagResult.promoted > 0) {
        nodesCreated += tagResult.promoted;
        linksCreated += tagResult.linksCreated;
        log.info(`Phase 3.5 完成: ${tagResult.promoted} 个标签晋升, ${tagResult.linksCreated} 条链接`);
      }
    } catch (err) {
      log.warn(`标签提升失败（不影响初始化）: ${(err as Error).message}`);
    }
    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 4: 节点标注 ===
    const pendingAnnotateCount = (db.prepare(
      'SELECT COUNT(*) as cnt FROM nodes WHERE refinement = 0 AND heat > 0.01 AND is_crystal = 0 AND is_meta = 0 AND is_superseded = 0',
    ).get() as { cnt: number }).cnt;
    setPhase(4, '节点标注', pendingAnnotateCount, sourceId);
    log.info(`Phase 4: 节点标注 (${pendingAnnotateCount} 个待标注节点)`);

    if (isLlmConfigured()) {
      // 多轮标注直到没有未标注节点
      // 安全上限：直接用待标注数量，确保即使每轮只处理 1 个也不会提前截断
      const maxAnnotateRounds = Math.max(200, pendingAnnotateCount);
      let annotateRound = 0;
      while (annotateRound < maxAnnotateRounds) {
        const result = await runAnnotation(db);
        if (!result || (result as any).annotated === 0) break;
        annotateRound++;
        if (annotateRound % 10 === 0) log.info(`Phase 4 进度: 第 ${annotateRound} 轮标注`);
        advanceProgress(1, sourceId);
        if (isAborted(sourceId)) throw new Error('初始化已中断');
      }
      log.info(`Phase 4 完成: ${annotateRound} 轮标注`);
    }

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 5: Landing Connections ===
    const embeddedNodeCount = (db.prepare(
      'SELECT COUNT(DISTINCT n.id) as cnt FROM nodes n JOIN nodes_vec v ON n.id = v.id WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0',
    ).get() as { cnt: number }).cnt;
    setPhase(5, 'Landing 连接', embeddedNodeCount, sourceId);
    log.info(`Phase 5: Landing Connections (${embeddedNodeCount} 个节点)`);

    const landingResult = await createLandingConnections(db, () => isAborted(sourceId), (n: number) => advanceProgress(n, sourceId));
    linksCreated += landingResult;

    log.info(`Phase 5 完成: ${landingResult} 条 landing 连接`);
    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 6: 链接评估 ===
    const pendingLinkCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM links WHERE status = 'pending'",
    ).get() as { cnt: number }).cnt;
    setPhase(6, '链接评估', pendingLinkCount, sourceId);
    log.info(`Phase 6: 链接评估 (${pendingLinkCount} 条待评估链接)`);

    if (isLlmConfigured()) {
      const maxEvalRounds = Math.max(200, pendingLinkCount);
      let evalRound = 0;
      while (evalRound < maxEvalRounds) {
        const result = await runLinkEvaluate(db);
        if (result.evaluated === 0) break;
        evalRound++;
        if (evalRound % 10 === 0) log.info(`Phase 6 进度: 第 ${evalRound} 轮评估 (确认=${result.confirmed} 删除=${result.deleted})`);
        advanceProgress(1, sourceId);
        if (isAborted(sourceId)) throw new Error('初始化已中断');
      }
      log.info(`Phase 6 完成: ${evalRound} 轮评估`);
    }

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 7: Keystone 标记 ===
    setPhase(7, 'Keystone 标记', 0, sourceId);
    log.info('Phase 7: Keystone 标记');
    runKeystoneIdentification(db);
    getProgress(sourceId).current = 1;

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 8: 涌现 ===
    setPhase(8, '涌现', 0, sourceId);
    log.info('Phase 8: 涌现');

    let crystalsCreated = 0;
    if (isLlmConfigured()) {
      try {
        const crystalNodeIds = await runCrystalEmergence(db);
        crystalsCreated += crystalNodeIds.length; // 返回类型是 string[]（新结晶节点 ID）
      } catch (err) {
        log.warn(`拓扑结晶失败: ${(err as Error).message}`);
      }

      try {
        const temporalResult = await runTemporalCrystal(db);
        crystalsCreated += temporalResult.crystals_created;
      } catch (err) {
        log.warn(`时间结晶失败: ${(err as Error).message}`);
      }
    }

    // 标记全量扫描完成
    markFullScanCompleted(db, sourceId);

    // 计算时间覆盖率（文件级别：有推断日期的文件 / 总文件数）
    const totalFiles = classification.files.length;
    const filesWithTime = classification.files.filter(
      f => f.journalDate || (inferredDates.has(f.title) && inferredDates.get(f.title)!.source !== 'fallback'),
    ).length;
    const timeCoverage = totalFiles > 0 ? filesWithTime / totalFiles : 0;

    // 计算总费用
    const totalCost = (db.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) as total
      FROM llm_usage_log
      WHERE created >= ?
    `).get(getProgress(sourceId).startedAt ?? now()) as { total: number }).total;

    const durationMs = Date.now() - startTime;
    const report: InitReport = {
      totalFiles: classification.summary.total,
      nodesCreated,
      linksCreated,
      danglingRefs,
      timeCoverage: Math.round(timeCoverage * 100) / 100,
      crystalsCreated,
      totalCost: Math.round(totalCost * 100) / 100,
      durationMs,
    };

    // 将报告作为节点存入图谱
    await saveReportAsNode(db, report);

    // 记录时间线事件
    logTimelineEvent(db, {
      type: 'memory',
      subtype: 'logseq_sync',
      title: JSON.stringify({ key: 'logseq_init_complete', params: { nodes: nodesCreated, links: linksCreated, crystals: crystalsCreated } }),
      detail: report as unknown as Record<string, unknown>,
      important: 1,
    });

    getProgress(sourceId).status = 'done';
    log.info(`初始化完成! 耗时 ${Math.round(durationMs / 1000)}s, ${nodesCreated} 节点, ${linksCreated} 链接`);

    return report;
  } catch (err) {
    getProgress(sourceId).status = 'error';
    getProgress(sourceId).error = (err as Error).message;
    log.error(`初始化失败: ${(err as Error).message}`);
    throw err;
  } finally {
    initializingSet.delete(key);
  }
}

// --- 内部函数 ---

/**
 * 将单个文件处理为节点（不创建 landing connections）
 */
async function processFileForInit(
  db: Database.Database,
  file: ClassifiedFile,
  graphRoot: string,
  inferredDates: InferredDates,
  inDegreeMap: Map<string, number>,
  importDate: string,
  sourceId?: string,
): Promise<string[]> {
  const repo = new SqliteRepository(db);
  // 计算初始 heat 和原始创建时间
  const dateInfo = inferredDates.get(file.title);
  const inDegree = inDegreeMap.get(file.title) ?? 0;
  const initialHeat = computeInitialHeat(dateInfo, inDegree, importDate);
  const originalCreated = dateInfo?.date
    ? `${dateInfo.date}T00:00:00.000Z`
    : undefined;

  // 空白页 → 创建普通节点（不直接标记 is_tag，由 promoteFrequentTags 按阈值判断）
  if (file.category === 'empty_tag') {
    const result = await digest(repo, {
      content: file.title,
      source: { tool: 'logseq', files: [file.relPath] },
      context: `Logseq 标签页: ${file.title}`,
      tags: [file.title],
      async: false,
      initialHeat,
      created: originalCreated,
      // 身份由 file.relPath 负责
      skipDedupMerge: true,
    });
    const nodeIds = result.created_nodes?.map(n => n.id) ?? [];
    // 更新同步状态
    updateSyncState(db, file, nodeIds, sourceId);
    return nodeIds;
  }

  // 其他文件 → 预处理 + 分段 + digest
  const preprocessed = preprocessFile(file.filePath, graphRoot);
  if (!preprocessed) return [];

  const segments = segmentContent(
    preprocessed.cleanContent,
    preprocessed.title,
    file.category === 'journal',
  );

  if (segments.length === 0) return [];

  // #5 Logseq 属性提取：将自定义属性拼入上下文
  const propEntries = Object.entries(preprocessed.metadata.properties);
  const propsStr = propEntries.length > 0
    ? `属性: ${propEntries.slice(0, 10).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : '';

  const nodeIds: string[] = [];

  for (const segment of segments) {
    const contextParts = [
      `Logseq: ${preprocessed.title}`,
      segment.context !== preprocessed.title ? segment.context : '',
      propsStr,
      preprocessed.metadata.tags.length > 0
        ? `标签: ${preprocessed.metadata.tags.join(', ')}`
        : '',
      preprocessed.metadata.pageRefs.length > 0
        ? `关联页面: ${preprocessed.metadata.pageRefs.slice(0, 5).join(', ')}`
        : '',
    ].filter(Boolean).join(' | ');

    const combinedTags = [
      ...new Set([
        ...preprocessed.metadata.tags,
        ...preprocessed.metadata.pageRefs,
      ]),
    ];

    const result = await digest(repo, {
      content: segment.content,
      // 日记页子节点不设 title——日期标题对多个 segment 都一样，不如让 annotate 生成有意义的标题
      title: file.category === 'journal' ? undefined : preprocessed.title,
      source: { tool: 'logseq', files: [file.relPath] },
      context: contextParts,
      tags: combinedTags.length > 0 ? combinedTags : undefined,
      async: false,
      initialHeat,
      created: originalCreated,
      // 身份由 file.relPath + segment 顺序负责
      skipDedupMerge: true,
    });

    if (result.created_nodes) {
      nodeIds.push(...result.created_nodes.map(n => n.id));
    }
  }

  // #3 多段 part_of 关系串联：按顺序创建 part_of 链接
  if (nodeIds.length > 1) {
    for (let i = 1; i < nodeIds.length; i++) {
      createLink(db, {
        from_id: nodeIds[i],
        to_id: nodeIds[i - 1],
        relation: [{ type: 'part_of', confidence: 0.95 }],
        strength: 0.9,
        note: `页面分段 ${i + 1}/${nodeIds.length}: ${preprocessed.title}`,
        auto: true,
        status: 'confirmed',
      });
    }
  }

  // 属性值提升为 tag 节点
  if (propEntries.length > 0) {
    await promotePropertyValues(
      db, preprocessed.metadata.properties, nodeIds,
      'logseq', SYSTEM_PROPERTIES, originalCreated,
    );
  }

  // 更新同步状态（即使只处理了部分段也写入，支持断点恢复）
  updateSyncState(db, file, nodeIds, sourceId);

  return nodeIds;
}

function updateSyncState(db: Database.Database, file: ClassifiedFile, nodeIds: string[] = [], sourceId?: string): void {
  const fileStat = getFileStat(file.filePath);
  setFileState(db, {
    file_path: file.relPath,
    content_hash: computeFileHash(file.filePath),
    mtime: fileStat?.mtime ?? 0,
    size: fileStat?.size ?? 0,
    last_synced: now(),
    node_ids: nodeIds,
  }, sourceId);
}

/**
 * Phase 3: 创建 Logseq 显式链接
 */
async function createExplicitLinks(
  db: Database.Database,
  files: ClassifiedFile[],
  fileToNodeIds: Map<string, string[]>,
  fileContentCache: Map<string, string>,
): Promise<{ created: number; dangling: number }> {
  let created = 0;
  let dangling = 0;

  for (const file of files) {
    // 索引页不创建链接（避免超级 hub）
    if (file.category === 'index_page') continue;

    const sourceNodeIds = fileToNodeIds.get(file.title);
    if (!sourceNodeIds || sourceNodeIds.length === 0) continue;

    // 优先从缓存读取，否则读文件
    let content = fileContentCache.get(file.filePath);
    if (!content) {
      try {
        content = fs.readFileSync(file.filePath, 'utf-8');
      } catch {
        continue;
      }
    }

    const refs = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
    const uniqueRefs = [...new Set(refs)];

    for (const ref of uniqueRefs) {
      const sourceId = sourceNodeIds[0];
      const targetNodeIds = fileToNodeIds.get(ref);

      if (targetNodeIds && targetNodeIds.length > 0) {
        // 目标页面存在 → 直接链接
        const targetId = targetNodeIds[0];
        if (sourceId === targetId) continue;
        if (linkExists(db, sourceId, targetId)) continue;

        createLink(db, {
          from_id: sourceId,
          to_id: targetId,
          relation: [{ type: 'tagged', confidence: 0.5 }],
          strength: 0.9,
          note: `Logseq 显式引用: [[${ref}]]`,
          auto: true,
          status: 'pending',
        });
        created++;
      } else {
        // 悬空引用 → 创建 tag 节点
        try {
          const tagNodeId = await getOrCreateTagNode(db, ref, 'logseq');
          if (tagNodeId !== sourceId && !linkExists(db, sourceId, tagNodeId)) {
            createLink(db, {
              from_id: sourceId,
              to_id: tagNodeId,
              relation: [{ type: 'tagged', confidence: 0.5 }],
              strength: 0.7,
              note: `Logseq 悬空引用: [[${ref}]]`,
              auto: true,
              status: 'pending',
            });
            created++;
          }
        } catch {
          dangling++;
        }
      }
    }
  }

  return { created, dangling };
}

/**
 * Phase 5: 为所有节点创建 landing connections（批处理 + 动态并发 + 重试）
 */
async function createLandingConnections(
  db: Database.Database,
  isAborted: () => boolean,
  onProgress: (count: number) => void,
): Promise<number> {
  const nodes = db.prepare(`
    SELECT n.id FROM nodes n
    JOIN nodes_vec v ON n.id = v.id
    WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0
  `).all() as Array<{ id: string }>;

  let totalLinks = 0;
  const failed: string[] = [];

  // 动态批大小（SQLite 同步驱动，实际顺序执行，此参数控制 abort 检查和进度汇报频率）
  let batchSize = 5;
  const MIN_BATCH_SIZE = 2;
  const MAX_BATCH_SIZE = 15;

  const processNode = (id: string): number => {
    const vecRow = db.prepare('SELECT embedding FROM nodes_vec WHERE id = ?').get(id) as { embedding: Buffer } | undefined;
    if (!vecRow) return 0;
    const embedding = new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4);
    // 初始化的批量 landing 只建连接，不归并——节点已经入库且各自有外部身份
    const result = findLandingConnections(db, id, embedding, { skipDedupMerge: true });
    return result.confirmedLinks.length + result.pendingLinks.length;
  };

  // 分批处理
  for (let i = 0; i < nodes.length; i += batchSize) {
    if (isAborted()) break;

    const batch = nodes.slice(i, i + batchSize);
    const batchStart = Date.now();

    for (const { id } of batch) {
      try {
        totalLinks += processNode(id);
      } catch (err) {
        failed.push(id);
        log.debug(`Landing 失败 node=${id}: ${(err as Error).message}`);
      }
    }

    onProgress(batch.length);

    // 动态调整批大小
    const elapsed = Date.now() - batchStart;
    if (elapsed < 2000 && batchSize < MAX_BATCH_SIZE) {
      batchSize = Math.min(batchSize + 2, MAX_BATCH_SIZE);
    } else if (elapsed > 5000 && batchSize > MIN_BATCH_SIZE) {
      batchSize = Math.max(batchSize - 2, MIN_BATCH_SIZE);
    }
  }

  // 重试失败节点（最多 2 轮）
  for (let retry = 0; retry < 2 && failed.length > 0; retry++) {
    if (isAborted()) break;
    const retryList = [...failed];
    failed.length = 0;
    log.info(`Landing 重试第 ${retry + 1} 轮: ${retryList.length} 个节点`);
    for (const id of retryList) {
      try {
        totalLinks += processNode(id);
      } catch {
        failed.push(id);
      }
    }
  }

  if (failed.length > 0) {
    log.warn(`Landing 最终失败 ${failed.length} 个节点`);
  }

  return totalLinks;
}

/**
 * 将初始化报告作为节点存入图谱（走 digest 流程，获得 embedding + landing）
 */
async function saveReportAsNode(db: Database.Database, report: InitReport): Promise<void> {
  const repo = new SqliteRepository(db);
  const reportContent = [
    `Logseq 初始化报告`,
    ``,
    `- 处理文件: ${report.totalFiles}`,
    `- 创建节点: ${report.nodesCreated}`,
    `- 创建链接: ${report.linksCreated}`,
    `- 悬空引用: ${report.danglingRefs}`,
    `- 时间覆盖率: ${Math.round(report.timeCoverage * 100)}%`,
    `- 涌现结晶: ${report.crystalsCreated}`,
    `- 总费用: $${report.totalCost}`,
    `- 耗时: ${Math.round(report.durationMs / 1000)}s`,
  ].join('\n');

  await digest(repo, {
    content: reportContent,
    source: { tool: 'logseq' },
    tags: ['初始化'],
    async: false,
    // 初始化报告每次都是独立事件，不应被向量归并
    skipDedupMerge: true,
  });
}
