// ============================================================
// Logseq 初始化管线
//
// Phase 0-8 批量导入流程，专为首次大量笔记导入设计。
// 与增量同步（index.ts）互补：初始化完成后走增量。
// ============================================================

import fs from 'node:fs';
import { safeReadTextFileSync } from '../../utils/safe-fs.js';
import { expandTilde } from '../../utils/path.js';
import type Database from 'better-sqlite3';
import { getConfig, reloadConfig, isLlmConfigured } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { logTimelineEvent } from '../../db/log.js';
import { now } from '../../utils/time.js';

import { SqliteRepository } from '../../db/sqlite-repository.js';
import { walkMdFiles, buildBlockIndex, preprocessFile, stripCodeForScan } from './preprocessor.js';
import { SYSTEM_PROPERTIES } from './types.js';
import { segmentContent } from './segmenter.js';
import { classifyFiles, buildInDegreeMap, type ClassifiedFile, type ClassificationResult } from './classifier.js';
import { inferPageDates, sortByTime, type InferredDates } from './time-inference.js';
import { computeInitialHeat } from './initial-heat.js';
import { importVersionHistory, scanVersionFiles, deduplicateVersions } from './version-files.js';
import { ensureSyncSchema, setFileState, getFileState, computeFileHash, computeContentHash, computeSegmentHash, getFileStat } from './sync-state.js';
import { digest } from '../../tools/digest.js';
import { createLink, linkExists } from '../../db/links.js';
import { promotePropertyValues, getOrCreateTagNode } from '../shared/property-promote.js';
import { runAnnotation } from '../../metabolism/annotate.js';
import { runLinkEvaluate } from '../../metabolism/link-evaluate.js';
import { runKeystoneIdentification } from '../../metabolism/divergent.js';
import { runCrystalEmergence } from '../../metabolism/divergent.js';
import { runTemporalCrystal } from '../../metabolism/temporal-crystal.js';
import { promoteFrequentTags } from '../../metabolism/tag-promote.js';
import { markFullScanCompleted } from './sync-state.js';
import { findLandingConnections } from '../../graph/landing.js';
import { getVectorForNode } from '../../db/vectors.js';
import { estimateCost } from '../../llm/pricing.js';
import type { InitSessionContext } from '../shared/init-session.js';

const log = createLogger('logseq-init');

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
    graphRoot = expandTilde(sourcePath);
  } else {
    const logseqPath = config.sources?.logseq?.path;
    if (!logseqPath) return null;
    graphRoot = expandTilde(logseqPath);
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
 *
 * 由 InitSessionManager 调用，状态、进度、中断信号都通过 ctx 完成。
 * 函数本身不再持有任何全局状态——所有 sourceId 维度的并发互斥由 SessionManager 负责。
 */
export async function runInitialization(
  db: Database.Database,
  ctx: InitSessionContext,
  sourcePath?: string,
): Promise<InitReport> {
  const sourceId = ctx.sourceId;
  const signal = ctx.signal;
  const startTime = Date.now();
  const startedAtIso = now();

  const checkAborted = () => {
    if (signal.aborted) {
      throw signal.reason ?? new Error('初始化已中断');
    }
  };

  reloadConfig(); // 确保读到客户端最新保存的 config
  const config = getConfig();

  let graphRoot: string;
  if (sourcePath) {
    graphRoot = expandTilde(sourcePath);
  } else {
    const logseqPath = config.sources?.logseq?.path;
    if (!logseqPath) throw new Error('Logseq path not configured');
    graphRoot = expandTilde(logseqPath);
  }
  if (!fs.existsSync(graphRoot)) throw new Error(`Logseq path not found: ${graphRoot}`);

  ensureSyncSchema(db);

  let nodesCreated = 0;
  let linksCreated = 0;

  // === Phase 0: 扫描分类 ===
  ctx.reportPhase(0, '扫描分类', 0);
  log.info('Phase 0: 扫描分类');

  const allFiles = walkMdFiles(graphRoot);
  const classification = classifyFiles(allFiles, graphRoot);
  ctx.setProgress({ total: classification.summary.total, current: classification.summary.total });

  checkAborted();

  // === Phase 1: 全量预处理 + 时间推断 ===
  ctx.reportPhase(1, '预处理', classification.summary.total);
  log.info('Phase 1: 全量预处理');

  buildBlockIndex(graphRoot);

  // 共享文件内容缓存（时间推断 + 入度统计复用）
  const contentCache = new Map<string, string>();
  const readCached = (fp: string): string | null => {
    if (!contentCache.has(fp)) {
      const r = safeReadTextFileSync(fp);
      if (!r.ok) return null;
      contentCache.set(fp, r.content);
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
  ctx.setProgress({ current: sortedFiles.length });

  checkAborted();

  // === Phase 2: 按时间排序入库 ===
  ctx.reportPhase(2, '入库', sortedFiles.length);
  log.info(`Phase 2: 按时间排序入库 (${sortedFiles.length} 个文件)`);

  // 文件 → 节点ID 映射（用于 Phase 3 显式链接）
  const fileToNodeIds = new Map<string, string[]>();

  for (const file of sortedFiles) {
    checkAborted();

    // 断点恢复：跳过已入库的文件
    const existingState = getFileState(db, file.relPath, sourceId);
    if (existingState && existingState.node_ids.length > 0) {
      fileToNodeIds.set(file.title, existingState.node_ids);
      nodesCreated += existingState.node_ids.length;
      ctx.advance();
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

    ctx.advance();
    ctx.heartbeat();
  }

  log.info(`Phase 2 完成: ${nodesCreated} 个节点`);
  checkAborted();

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

  checkAborted();

  // === Phase 3: Logseq 显式链接 ===
  ctx.reportPhase(3, '显式链接', nodesCreated);
  log.info('Phase 3: Logseq 显式链接转化');

  const explicitResult = await createExplicitLinks(db, sortedFiles, fileToNodeIds, contentCache);
  linksCreated += explicitResult.created;
  const danglingRefs = explicitResult.dangling;
  ctx.setProgress({ current: nodesCreated });

  // Phase 3 之后释放内容缓存
  contentCache.clear();

  log.info(`Phase 3 完成: ${explicitResult.created} 条显式链接, ${danglingRefs} 个悬空引用`);
  checkAborted();

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
  checkAborted();

  // === Phase 4: 节点标注 ===
  const pendingAnnotateCount = (db.prepare(
    'SELECT COUNT(*) as cnt FROM nodes WHERE refinement = 0 AND heat > 0.01 AND is_crystal = 0 AND is_meta = 0 AND is_superseded = 0 AND archived = 0',
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(4, '节点标注', pendingAnnotateCount);
  log.info(`Phase 4: 节点标注 (${pendingAnnotateCount} 个待标注节点)`);

  if (isLlmConfigured()) {
    // 多轮标注直到没有未标注节点
    // 安全上限：直接用待标注数量，确保即使每轮只处理 1 个也不会提前截断
    const maxAnnotateRounds = Math.max(200, pendingAnnotateCount);
    let annotateRound = 0;
    while (annotateRound < maxAnnotateRounds) {
      const result = await runAnnotation(db, { signal });
      if (!result || result.annotated === 0) break;
      annotateRound++;
      if (annotateRound % 10 === 0) log.info(`Phase 4 进度: 第 ${annotateRound} 轮标注`);
      ctx.advance();
      ctx.heartbeat();
      checkAborted();
    }
    log.info(`Phase 4 完成: ${annotateRound} 轮标注`);
  }

  checkAborted();

  // === Phase 5: Landing Connections ===
  // nodes_vec.id 存的是 segment_id（`${nodeId}#${index}`），不是 node.id。
  // 必须通过 node_segments 桥接才能统计"已 embed 的节点数"。
  const embeddedNodeCount = (db.prepare(
    'SELECT COUNT(DISTINCT n.id) as cnt FROM nodes n JOIN node_segments s ON s.node_id = n.id JOIN nodes_vec v ON v.id = s.segment_id WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0 AND n.archived = 0',
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(5, 'Landing 连接', embeddedNodeCount);
  log.info(`Phase 5: Landing Connections (${embeddedNodeCount} 个节点)`);

  const landingResult = await createLandingConnections(
    db,
    () => signal.aborted,
    (n: number) => { ctx.advance(n); ctx.heartbeat(); },
  );
  linksCreated += landingResult;

  log.info(`Phase 5 完成: ${landingResult} 条 landing 连接`);
  checkAborted();

  // === Phase 6: 链接评估 ===
  const pendingLinkCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM links WHERE status = 'pending' AND deleted = 0",
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(6, '链接评估', pendingLinkCount);
  log.info(`Phase 6: 链接评估 (${pendingLinkCount} 条待评估链接)`);

  if (isLlmConfigured()) {
    const maxEvalRounds = Math.max(200, pendingLinkCount);
    let evalRound = 0;
    while (evalRound < maxEvalRounds) {
      const result = await runLinkEvaluate(db, { signal });
      if (result.evaluated === 0) break;
      evalRound++;
      if (evalRound % 10 === 0) log.info(`Phase 6 进度: 第 ${evalRound} 轮评估 (确认=${result.confirmed} 删除=${result.deleted})`);
      ctx.advance();
      ctx.heartbeat();
      checkAborted();
    }
    log.info(`Phase 6 完成: ${evalRound} 轮评估`);
  }

  checkAborted();

  // === Phase 7: Keystone 标记 ===
  ctx.reportPhase(7, 'Keystone 标记', 0);
  log.info('Phase 7: Keystone 标记');
  runKeystoneIdentification(db);
  ctx.setProgress({ current: 1 });

  checkAborted();

  // === Phase 8: 涌现 ===
  ctx.reportPhase(8, '涌现', 0);
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
  `).get(startedAtIso) as { total: number }).total;

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

  log.info(`初始化完成! 耗时 ${Math.round(durationMs / 1000)}s, ${nodesCreated} 节点, ${linksCreated} 链接`);

  return report;
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

  // 避免 TOCTOU：在 digest（分钟级）开始前抓 stat snapshot,写回 sync state 的 mtime/size
  // 用它,而不是 digest 后重读盘。否则 digest 期间用户编辑文件 → 下一轮增量 isFileChanged
  // 的 mtime+size 快速路径短路判未变更,这次编辑永久丢失。与增量路径(queue.ts)一致。
  const snapshotStat = getFileStat(file.filePath);

  // 空白页 → 创建普通节点（不直接标记 is_tag，由 promoteFrequentTags 按阈值判断）
  if (file.category === 'empty_tag') {
    // 空白页分支不走 preprocessFile（拿不到 rawContent),在 digest 前读一份 content
    // snapshot 算 hash,保证 hash 与 mtime/size 来自同一时刻;走 safe-fs,dataless 时为 undefined。
    const snapshotRead = safeReadTextFileSync(file.filePath);
    const snapshotContentHash = snapshotRead.ok ? computeContentHash(snapshotRead.content) : undefined;
    // read-time snapshot:入口 stat 为 null 但此处读成功 ⇒ 文件可读,在 digest 前补抓
    // stat,与 snapshotContentHash 同源;若内容也没读到则保持 null(updateSyncState 会跳过)。
    const tagSnapshot = (snapshotStat === null && snapshotRead.ok) ? getFileStat(file.filePath) : snapshotStat;
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
    // 更新同步状态(F3: empty_tag 单 title 段,每节点对齐一个段 hash)
    updateSyncState(db, file, nodeIds, sourceId, snapshotContentHash, tagSnapshot, nodeIds.map(() => computeSegmentHash(file.title)));
    return nodeIds;
  }

  // 其他文件 → 预处理 + 分段 + digest
  const preprocessed = preprocessFile(file.filePath, graphRoot);
  if (!preprocessed) return [];

  // read-time snapshot:入口 stat 为 null 但 preprocessFile 随后成功 ⇒ 文件此刻可读,
  // 在 digest 前补抓 stat,与下面的 contentHash 同源。
  const regularSnapshot = snapshotStat ?? getFileStat(file.filePath);

  // 避免 TOCTOU：用预处理时读到的 rawContent 算 hash,而不是 digest 后重读盘。
  // preprocessFile 要么返回 null(上方已 return),要么 rawContent 恒为字符串
  // (preprocessor.ts 所有返回路径都填),与 Obsidian 写法对齐,无需 undefined 守卫。
  const contentHash = computeContentHash(preprocessed.rawContent);

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
  const segmentHashes: string[] = []; // F3(2026-06-24): 与 nodeIds 严格等长,首次编辑时增量路径段级复用可命中,不再全量重 digest

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

    if (result.created_nodes && result.created_nodes.length > 0) {
      const segHash = computeSegmentHash(segment.content); // F3:与增量路径 queue.ts 同算法
      for (const n of result.created_nodes) {
        nodeIds.push(n.id);
        segmentHashes.push(segHash); // 同段多节点共享 hash,保持与 nodeIds 等长
      }
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
  updateSyncState(db, file, nodeIds, sourceId, contentHash, regularSnapshot, segmentHashes);

  return nodeIds;
}

function updateSyncState(
  db: Database.Database,
  file: ClassifiedFile,
  nodeIds: string[] = [],
  sourceId?: string,
  contentHash?: string,
  snapshotStat?: { mtime: number; size: number } | null,
  segmentHashes: string[] = [], // F3(2026-06-24): 与 nodeIds 等长的段 hash,写入 sync state 供首次编辑段级复用
): void {
  // snapshotStat 三态语义(与 4 条路径一致):调用方已在「内容读取成功那一刻、digest 前」
  // 把有效 snapshot 捕获/补抓好传进来,这里不再重抓(digest 后重抓会拿到编辑后的 mtime/size
  // 配 digest 前的 hash,下轮 isFileChanged 快速路径短路丢编辑)。
  // 不给初始值:下面四个分支(含 return)恰好覆盖全部可达路径并各自赋值,
  // 给 `= 0` 初始值反而成 no-useless-assignment(lint 阻塞项)。
  let mtime: number, size: number;
  if (snapshotStat) {
    // 有 read-time snapshot:mtime/size 与 contentHash 同源(都反映被 digest 那份内容)。
    mtime = snapshotStat.mtime;
    size = snapshotStat.size;
  } else if (snapshotStat === null && contentHash === undefined) {
    // null 且无 contentHash = 内容根本没读到(dataless / 消失,本就没 digest)。整条跳过。
    return;
  } else if (snapshotStat === null) {
    // null 但有 contentHash = 极罕见:内容读成功却连 read-time 补抓 stat 都失败。用 mtime=0/
    // size=0 + 已算出的 hash；下一轮仍以内容 hash 作最终判断(既不丢编辑也无孤儿)。
    mtime = 0;
    size = 0;
  } else {
    // 未传(undefined) → 退回重读盘(保持旧行为)。
    const fileStat = getFileStat(file.filePath);
    mtime = fileStat?.mtime ?? 0;
    size = fileStat?.size ?? 0;
  }
  // 优先用调用方已持有的 content hash（来自预处理 snapshot）,否则退回重读盘。
  const hash = contentHash ?? computeFileHash(file.filePath);
  if (hash === null) return; // dataless / missing — 不写入空 hash
  setFileState(db, {
    file_path: file.relPath,
    content_hash: hash,
    mtime,
    size,
    last_synced: now(),
    node_ids: nodeIds,
    segment_hashes: segmentHashes, // F3: 与 node_ids 等长,杜绝首次编辑 oldHashes=[] 全量重 digest
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
      const r = safeReadTextFileSync(file.filePath);
      if (!r.ok) continue;
      content = r.content;
    }

    // 修复(2026-05-09):先 stripCodeForScan 把代码块/行内 backtick 替换成
    // 空格再跑 regex,否则用户笔记里的代码示例(围栏内含 `[[name]]`)会被
    // 误算成引用,污染图谱 + 错误悬空 tag。保持字符偏移不变,后续 ref 解析
    // (alias / path)行为不变。
    const scanContent = stripCodeForScan(content);
    const refs = [...scanContent.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
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
  // nodes_vec.id 是 segment_id，不是 node.id。通过 node_segments 桥接取
  // "有 embedding 的节点"；DISTINCT 防止多段节点被重复返回。
  const nodes = db.prepare(`
    SELECT DISTINCT n.id FROM nodes n
    JOIN node_segments s ON s.node_id = n.id
    JOIN nodes_vec v ON v.id = s.segment_id
    WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0 AND n.archived = 0
  `).all() as Array<{ id: string }>;

  let totalLinks = 0;
  const failed: string[] = [];

  // 动态批大小（SQLite 同步驱动，实际顺序执行，此参数控制 abort 检查和进度汇报频率）
  let batchSize = 5;
  const MIN_BATCH_SIZE = 2;
  const MAX_BATCH_SIZE = 15;

  const processNode = (id: string): number => {
    // 通过 node_segments 查 segment 0 的 embedding；getVectorForNode 已封装此逻辑
    const embedding = getVectorForNode(db, id);
    if (!embedding) return 0;
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
