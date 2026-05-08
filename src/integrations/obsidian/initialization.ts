// ============================================================
// Obsidian 初始化管线
//
// Phase 0-2: Obsidian 特有（扫描、分类、预处理、入库）
// Phase 3-8: 复用 Logseq 初始化管线的通用逻辑
// ============================================================

import fs from 'node:fs';
import { safeReadTextFileSync } from '../../utils/safe-fs.js';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getConfig, reloadConfig, isLlmConfigured } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { logTimelineEvent } from '../../db/log.js';
import { now } from '../../utils/time.js';

import { SqliteRepository } from '../../db/sqlite-repository.js';
import { walkMdFiles, preprocessFile, buildFileIndex } from './preprocessor.js';
import { segmentContent } from './segmenter.js';
import { classifyFiles, buildInDegreeMap } from './classifier.js';
import type { ClassifiedFile as ObsClassifiedFile } from './types.js';
import { inferPageDates, type InferredDateInfo } from './time-inference.js';
import { readVaultConfig, getExcludedDirs } from './vault-config.js';
import { ensureSyncSchema, setFileState, getFileState, computeFileHash, computeContentHash, markFullScanCompleted } from './sync-state.js';
import { parseCanvas } from './canvas-parser.js';
import { digest } from '../../tools/digest.js';
import { createLink, linkExists } from '../../db/links.js';
import { updateNode } from '../../db/nodes.js';
import { estimateCost } from '../../llm/pricing.js';

// 复用 Logseq 初始化的通用 Phase 4-8 函数
import { runAnnotation } from '../../metabolism/annotate.js';
import { runLinkEvaluate } from '../../metabolism/link-evaluate.js';
import { runKeystoneIdentification, runCrystalEmergence } from '../../metabolism/divergent.js';
import { runTemporalCrystal } from '../../metabolism/temporal-crystal.js';
import { promoteFrequentTags } from '../../metabolism/tag-promote.js';
import { findLandingConnections } from '../../graph/landing.js';
import { getVectorForNode } from '../../db/vectors.js';

// 复用 Logseq 的 initial-heat 计算（纯函数，无 Logseq 依赖）
import { computeInitialHeat } from '../logseq/initial-heat.js';
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
    vaultRoot = sourcePath.replace('~', os.homedir());
  } else {
    const obsidianPath = config.sources?.obsidian?.path;
    if (!obsidianPath) return null;
    vaultRoot = obsidianPath.replace('~', os.homedir());
  }
  if (!fs.existsSync(vaultRoot)) return null;

  const vaultConfig = readVaultConfig(vaultRoot);
  const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);
  const allFiles = walkMdFiles(vaultRoot, excludedDirs);

  const readContent = (fp: string): string | null => {
    const r = safeReadTextFileSync(fp);
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

  const avgTokensPerNode = 200;
  const totalInputTokens = estimatedNodes * avgTokensPerNode;

  const annotationCost = estimateCost(
    config.llm.light_model, totalInputTokens * 4, totalInputTokens * 0.3, 0,
  );
  const linkEvalCost = estimateCost(
    config.llm.standard_model, totalInputTokens * 8, totalInputTokens * 0.5, 0,
  );
  const emergenceCost = estimateCost(
    config.llm.heavy_model, totalInputTokens * 0.1, totalInputTokens * 0.02, totalInputTokens * 0.05,
  );

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
  const startedAtIso = now();

  const checkAborted = () => {
    if (signal.aborted) {
      throw signal.reason ?? new Error('初始化已中断');
    }
  };

  // 清空模块级悬空 tag 缓存，防止跨 vault / 跨轮次指向错误节点
  clearDanglingTagCache();

  reloadConfig();
  const config = getConfig();

  let vaultRoot: string;
  if (sourcePath) {
    vaultRoot = sourcePath.replace('~', os.homedir());
  } else {
    const obsidianPath = config.sources?.obsidian?.path;
    if (!obsidianPath) throw new Error('Obsidian path not configured');
    vaultRoot = obsidianPath.replace('~', os.homedir());
  }
  if (!fs.existsSync(vaultRoot)) throw new Error(`Obsidian vault not found: ${vaultRoot}`);

  const vaultConfig = readVaultConfig(vaultRoot);
  const excludedDirs = getExcludedDirs(vaultRoot, vaultConfig);
  ensureSyncSchema(db);

  let nodesCreated = 0;
  let linksCreated = 0;

  // === Phase 0: 扫描分类 ===
  ctx.reportPhase(0, '扫描分类', 0);
  log.info('Phase 0: 扫描分类');

  const allFiles = walkMdFiles(vaultRoot, excludedDirs);
  const contentCache = new Map<string, string>();
  const readCached = (fp: string): string | null => {
    if (!contentCache.has(fp)) {
      const r = safeReadTextFileSync(fp);
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

  buildFileIndex(vaultRoot, excludedDirs);

  const inferredDates = inferPageDates(classified, readCached, vaultConfig);
  const inDegreeMap = buildInDegreeMap(classified, readCached);
  const importDate = new Date().toISOString().slice(0, 10);

  checkAborted();

  // === Phase 2: 入库 ===
  ctx.reportPhase(2, '入库', classified.length);
  log.info(`Phase 2: 入库 (${classified.length} 个文件)`);

  const fileToNodeIds = new Map<string, string[]>();
  // 段级链接映射：pageTitle#heading → nodeId
  const headingToNodeId = new Map<string, string>();

  for (const file of classified) {
    checkAborted();

    // 跳过不需要入库的类型
    if (['template', 'attachment'].includes(file.category)) {
      ctx.advance();
      continue;
    }

    // 断点恢复
    const existingState = getFileState(db, file.relPath, sourceId);
    if (existingState && existingState.node_ids.length > 0) {
      const title = path.basename(file.relPath, path.extname(file.relPath));
      fileToNodeIds.set(title, existingState.node_ids);
      nodesCreated += existingState.node_ids.length;
      ctx.advance();
      continue;
    }

    try {
      const nodeIds = await processFileForInit(
        db, file, vaultRoot, inferredDates, inDegreeMap, importDate,
        headingToNodeId, sourceId,
      );
      if (nodeIds.length > 0) {
        const title = path.basename(file.relPath, path.extname(file.relPath));
        fileToNodeIds.set(title, nodeIds);
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

  // === Phase 3: 显式链接 ===
  ctx.reportPhase(3, '显式链接', nodesCreated);
  log.info('Phase 3: 显式链接');

  const explicitResult = await createExplicitLinks(
    db, classified, fileToNodeIds, contentCache, headingToNodeId,
  );
  linksCreated += explicitResult.created;
  const danglingRefs = explicitResult.dangling;
  contentCache.clear();

  log.info(`Phase 3 完成: ${explicitResult.created} 条链接, ${danglingRefs} 个悬空引用`);
  checkAborted();

  // === Phase 3.5: 标签提升 ===
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

  // === Phase 4-8: 通用管线（与 Logseq 相同） ===

  // Phase 4: 批量标注
  const pendingAnnotateCount = (db.prepare(
    'SELECT COUNT(*) as cnt FROM nodes WHERE refinement = 0 AND heat > 0.01 AND is_crystal = 0 AND is_meta = 0 AND is_superseded = 0',
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(4, '批量标注', pendingAnnotateCount);
  log.info(`Phase 4: 批量标注 (${pendingAnnotateCount} 个)`);

  if (isLlmConfigured()) {
    // 安全上限：直接用待标注数量，确保即使每轮只处理 1 个也不会提前截断
    const maxAnnotateRounds = Math.max(200, pendingAnnotateCount);
    let annotateRound = 0;
    while (annotateRound < maxAnnotateRounds) {
      const result = await runAnnotation(db, { signal });
      if (!result || result.annotated === 0) break;
      annotateRound++;
      if (annotateRound % 10 === 0) log.info(`Phase 4: 第 ${annotateRound} 轮`);
      ctx.advance();
      ctx.heartbeat();
      checkAborted();
    }
  }

  checkAborted();

  // Phase 5: Landing Connections
  // nodes_vec.id 存的是 segment_id（`${nodeId}#${index}`），不是 node.id。
  // 必须通过 node_segments 桥接才能统计"已 embed 的节点数"。
  const embeddedCount = (db.prepare(
    'SELECT COUNT(DISTINCT n.id) as cnt FROM nodes n JOIN node_segments s ON s.node_id = n.id JOIN nodes_vec v ON v.id = s.segment_id WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0',
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(5, 'Landing 连接', embeddedCount);
  log.info(`Phase 5: Landing Connections (${embeddedCount} 个节点)`);

  const landingResult = await createLandingConnections(
    db,
    () => signal.aborted,
    (n: number) => { ctx.advance(n); ctx.heartbeat(); },
  );
  linksCreated += landingResult;

  checkAborted();

  // Phase 6: 链接评估
  const pendingLinkCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM links WHERE status = 'pending'",
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(6, '链接评估', pendingLinkCount);
  log.info(`Phase 6: 链接评估 (${pendingLinkCount} 条)`);

  if (isLlmConfigured()) {
    const maxEvalRounds = Math.max(200, pendingLinkCount);
    let evalRound = 0;
    while (evalRound < maxEvalRounds) {
      const result = await runLinkEvaluate(db, { signal });
      if (result.evaluated === 0) break;
      evalRound++;
      if (evalRound % 10 === 0) log.info(`Phase 6: 第 ${evalRound} 轮`);
      ctx.advance();
      ctx.heartbeat();
      checkAborted();
    }
  }

  checkAborted();

  // Phase 7: Keystone 标记
  ctx.reportPhase(7, 'Keystone 标记', 0);
  log.info('Phase 7: Keystone 标记');
  runKeystoneIdentification(db);

  checkAborted();

  // Phase 8: 涌现
  ctx.reportPhase(8, '涌现', 0);
  log.info('Phase 8: 涌现');
  let crystalsCreated = 0;

  if (isLlmConfigured()) {
    try {
      const crystalNodeIds = await runCrystalEmergence(db);
      crystalsCreated += crystalNodeIds.length;
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

  markFullScanCompleted(db, sourceId);

  const totalCost = (db.prepare(`
    SELECT COALESCE(SUM(estimated_cost), 0) as total
    FROM llm_usage_log WHERE created >= ?
  `).get(startedAtIso) as { total: number }).total;

  const durationMs = Date.now() - startTime;
  const report: InitReport = {
    totalFiles: classified.length,
    nodesCreated,
    linksCreated,
    danglingRefs,
    crystalsCreated,
    totalCost: Math.round(totalCost * 100) / 100,
    durationMs,
  };

  // 报告节点
  await saveReportAsNode(db, report);

  logTimelineEvent(db, {
    type: 'memory',
    subtype: 'obsidian_sync',
    title: JSON.stringify({ key: 'obsidian_init_complete', params: { nodes: nodesCreated, links: linksCreated } }),
    detail: report as unknown as Record<string, unknown>,
    important: 1,
  });

  log.info(`初始化完成! 耗时 ${Math.round(durationMs / 1000)}s`);
  return report;
}

// --- 内部函数 ---

async function processFileForInit(
  db: Database.Database,
  file: ObsClassifiedFile,
  vaultRoot: string,
  inferredDates: Map<string, InferredDateInfo>,
  inDegreeMap: Map<string, number>,
  importDate: string,
  headingToNodeId: Map<string, string>,
  sourceId?: string,
): Promise<string[]> {
  const repo = new SqliteRepository(db);
  const title = path.basename(file.relPath, path.extname(file.relPath));
  const dateInfo = inferredDates.get(file.relPath) ?? inferredDates.get(title);
  const inDegree = inDegreeMap.get(title) ?? 0;
  const heatDateInfo: Parameters<typeof computeInitialHeat>[0] = dateInfo
    ? { date: dateInfo.date, source: 'fallback' }
    : undefined;
  const initialHeat = computeInitialHeat(heatDateInfo, inDegree, importDate);
  const originalCreated = dateInfo?.date ? `${dateInfo.date}T00:00:00.000Z` : undefined;

  // Canvas 文件
  if (file.category === 'canvas') {
    const parsed = parseCanvas(file.absPath);
    if (!parsed) return [];
    const nodeIds: string[] = [];
    for (const textNode of parsed.textNodes) {
      if (!textNode.text.trim()) continue;
      const result = await digest(repo, {
        content: textNode.text,
        source: { tool: 'obsidian', files: [file.relPath] },
        context: `Obsidian Canvas: ${title}`,
        tags: textNode.groupLabels.length > 0 ? textNode.groupLabels : undefined,
        async: false, initialHeat, created: originalCreated,
        skipDedupMerge: true,
      });
      if (result.created_nodes) nodeIds.push(...result.created_nodes.map(n => n.id));
    }
    updateSyncState(db, file, nodeIds, sourceId);
    return nodeIds;
  }

  // 空白 / 元数据 → tag 节点
  if (file.category === 'empty_tag' || file.category === 'metadata_only') {
    const result = await digest(repo, {
      content: title,
      source: { tool: 'obsidian', files: [file.relPath] },
      context: `Obsidian 标签页: ${title}`,
      tags: [title],
      async: false, initialHeat, created: originalCreated,
      skipDedupMerge: true,
    });
    const nodeIds = result.created_nodes?.map(n => n.id) ?? [];
    // 不直接标记 is_tag，由 promoteFrequentTags 按阈值判断
    updateSyncState(db, file, nodeIds, sourceId);
    return nodeIds;
  }

  // 常规文件
  const preprocessed = preprocessFile(file.absPath, vaultRoot);
  if (!preprocessed) return [];

  // 避免 TOCTOU：用预处理时读到的 rawContent 计算 hash，
  // 而不是最后再读文件一次（两次读之间文件可能被编辑）
  const contentHash = computeContentHash(preprocessed.rawContent);

  const segments = segmentContent(preprocessed.cleanContent, file.category);
  if (segments.length === 0) return [];

  const propEntries = Object.entries(preprocessed.metadata.properties);
  const propsStr = propEntries.length > 0
    ? `属性: ${propEntries.slice(0, 10).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : '';

  const nodeIds: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const contextParts = [
      `Obsidian: ${preprocessed.title}`,
      segment.context !== preprocessed.title ? segment.context : '',
      propsStr,
      preprocessed.metadata.tags.length > 0 ? `标签: ${preprocessed.metadata.tags.join(', ')}` : '',
      preprocessed.metadata.pageRefs.length > 0 ? `关联页面: ${preprocessed.metadata.pageRefs.slice(0, 5).join(', ')}` : '',
    ].filter(Boolean).join(' | ');

    const combinedTags = [...new Set([...preprocessed.metadata.tags, ...preprocessed.metadata.pageRefs])];

    const result = await digest(repo, {
      content: segment.content,
      title: preprocessed.title,
      source: { tool: 'obsidian', files: [file.relPath] },
      context: contextParts,
      tags: combinedTags.length > 0 ? combinedTags : undefined,
      async: false, initialHeat, created: originalCreated,
      skipDedupMerge: true,
    });

    if (result.created_nodes) {
      const newNodeIds = result.created_nodes.map(n => n.id);
      nodeIds.push(...newNodeIds);

      // 段级链接映射：记录 heading → nodeId
      if (segment.context && segment.context !== preprocessed.title && newNodeIds.length > 0) {
        headingToNodeId.set(`${title}#${segment.context}`, newNodeIds[0]);
      }
    }
  }

  // 多段 part_of
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

  updateSyncState(db, file, nodeIds, sourceId, contentHash);
  return nodeIds;
}

function updateSyncState(
  db: Database.Database,
  file: ObsClassifiedFile,
  nodeIds: string[] = [],
  sourceId?: string,
  contentHash?: string,
): void {
  let mtime = 0, size = 0;
  try {
    const stat = fs.statSync(file.absPath);
    mtime = Math.floor(stat.mtimeMs);
    size = stat.size;
  } catch {
    // File may have become dataless or disappeared between scan and state write.
  }
  // 优先使用调用方已持有的 content hash（来自预处理 snapshot），避免 TOCTOU：
  // 若不提供则退回到重新读文件计算；computeFileHash 在 dataless/missing 时返回 null。
  const hash = contentHash ?? computeFileHash(file.absPath);
  if (hash === null) return; // dataless / missing — 不写入空 hash
  setFileState(db, {
    file_path: file.relPath,
    content_hash: hash,
    mtime, size,
    last_synced: now(),
    node_ids: nodeIds,
  }, sourceId);
}

/**
 * Phase 3: 创建显式链接（含段级链接 + 悬空引用 → tag 节点）
 */
async function createExplicitLinks(
  db: Database.Database,
  files: ObsClassifiedFile[],
  fileToNodeIds: Map<string, string[]>,
  fileContentCache: Map<string, string>,
  headingToNodeId: Map<string, string>,
): Promise<{ created: number; dangling: number }> {
  let created = 0;
  let dangling = 0;

  for (const file of files) {
    if (['index_page', 'template', 'attachment'].includes(file.category)) continue;

    const title = path.basename(file.relPath, path.extname(file.relPath));
    const sourceNodeIds = fileToNodeIds.get(title);
    if (!sourceNodeIds || sourceNodeIds.length === 0) continue;

    let content = fileContentCache.get(file.absPath);
    if (!content) {
      const r = safeReadTextFileSync(file.absPath);
      if (!r.ok) continue;
      content = r.content;
    }

    // 提取 [[refs]]（排除 ![[...]] 嵌入引用 —— 那些通常是图片/PDF/音频附件，不是笔记间的引用）
    const refs = [...content.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)].map(m => m[1]);
    const uniqueRefs = [...new Set(refs)];

    for (const ref of uniqueRefs) {
      // 解析 ref：[[page|alias]] → page, [[page#heading]] → page + heading
      let pageName = ref;
      let heading: string | null = null;

      // 处理 alias
      const pipeIdx = ref.indexOf('|');
      if (pipeIdx > 0) {
        pageName = ref.slice(0, pipeIdx);
      }

      // 处理 heading/block
      const hashIdx = pageName.indexOf('#');
      if (hashIdx === 0) {
        // [[#heading]] / [[#^block-id]] —— 以 # 开头表示本页引用，
        // 没有目标 page 可解析，直接跳过；否则会把 '#heading' 作为 tag 名
        // 去走悬空分支，造成脏 tag 节点
        continue;
      }
      if (hashIdx > 0) {
        const fragment = pageName.slice(hashIdx + 1);
        pageName = pageName.slice(0, hashIdx);
        if (fragment.startsWith('^')) {
          // [[note#^block-id]] 是 block-level 引用，headingToNodeId 存的是
          // heading 文本键，用 block id 查永远命中不了，只会把 block id 误
          // 当 heading。直接不当 heading 处理，退化为 page 级链接。
          heading = null;
        } else {
          heading = fragment;
        }
      }

      // 处理路径
      if (pageName.includes('/')) {
        pageName = pageName.split('/').pop() ?? pageName;
      }

      // 过滤附件类扩展名（即便没有 ! 前缀，[[image.png]] / [[file.pdf]] 也不应进入笔记图谱）
      if (/\.(png|jpe?g|gif|webp|svg|pdf|mp3|mp4|webm|mov|wav)$/i.test(pageName)) {
        continue;
      }

      // 尝试段级链接
      if (heading) {
        const headingKey = `${pageName}#${heading}`;
        const targetNodeId = headingToNodeId.get(headingKey);
        if (targetNodeId) {
          const sourceId = sourceNodeIds[0];
          if (sourceId !== targetNodeId && !linkExists(db, sourceId, targetNodeId)) {
            createLink(db, {
              from_id: sourceId,
              to_id: targetNodeId,
              relation: [{ type: 'tagged', confidence: 0.5 }],
              strength: 0.9,
              note: `Obsidian 引用: [[${ref}]]`,
              auto: true,
              status: 'pending',
            });
            created++;
          }
          continue;
        }
      }

      // 页级链接
      const targetNodeIds = fileToNodeIds.get(pageName);
      if (targetNodeIds && targetNodeIds.length > 0) {
        const sourceId = sourceNodeIds[0];
        const targetId = targetNodeIds[0];
        if (sourceId !== targetId && !linkExists(db, sourceId, targetId)) {
          createLink(db, {
            from_id: sourceId,
            to_id: targetId,
            relation: [{ type: 'tagged', confidence: 0.5 }],
            strength: 0.9,
            note: `Obsidian 引用: [[${ref}]]`,
            auto: true,
            status: 'pending',
          });
          created++;
        }
      } else {
        // 悬空引用 → 创建 tag 节点
        try {
          const tagResult = await createDanglingTagNode(db, pageName);
          if (tagResult) {
            const sourceId = sourceNodeIds[0];
            if (sourceId !== tagResult && !linkExists(db, sourceId, tagResult)) {
              createLink(db, {
                from_id: sourceId,
                to_id: tagResult,
                relation: [{ type: 'tagged', confidence: 0.5 }],
                strength: 0.7,
                note: `Obsidian 悬空引用: [[${pageName}]]`,
                auto: true,
                status: 'pending',
              });
              created++;
            }
          }
        } catch {
          dangling++;
        }
      }
    }
  }

  return { created, dangling };
}

// 悬空引用 tag 节点缓存
// 注意：模块级 Map，必须在每次全量运行的入口清空，避免跨 vault / 跨轮次污染
const danglingTagCache = new Map<string, string>();

/** 清空悬空引用 tag 缓存（runInitialization / triggerFullRescan 入口调用） */
export function clearDanglingTagCache(): void {
  danglingTagCache.clear();
}

async function createDanglingTagNode(db: Database.Database, name: string): Promise<string | null> {
  const repo = new SqliteRepository(db);
  const normalized = name.trim().toLowerCase();
  if (danglingTagCache.has(normalized)) return danglingTagCache.get(normalized)!;

  const existing = db.prepare(
    "SELECT id FROM nodes WHERE is_tag = 1 AND (content = ? OR title = ?) AND archived = 0 AND is_superseded = 0 LIMIT 1",
  ).get(name, name) as { id: string } | undefined;

  if (existing) {
    danglingTagCache.set(normalized, existing.id);
    return existing.id;
  }

  const result = await digest(repo, {
    content: name,
    source: { tool: 'obsidian' },
    context: `Obsidian 悬空引用 tag: ${name}`,
    tags: [name],
    async: false,
    // 身份由精确匹配 + 缓存负责（上方已查过 existing）
    skipDedupMerge: true,
  });

  const nodeId = result.created_nodes?.[0]?.id;
  if (nodeId) {
    updateNode(db, nodeId, { is_tag: 1 });
    danglingTagCache.set(normalized, nodeId);
    return nodeId;
  }
  return null;
}

/**
 * Phase 5: Landing Connections（复用 Logseq 的逻辑）
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
    WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0
  `).all() as Array<{ id: string }>;

  let totalLinks = 0;
  const failed: string[] = [];
  let batchSize = 5;

  const processNode = (id: string): number => {
    const embedding = getVectorForNode(db, id);
    if (!embedding) return 0;
    // 初始化的批量 landing 只建连接——节点已经入库且各自有外部身份
    const result = findLandingConnections(db, id, embedding, { skipDedupMerge: true });
    return result.confirmedLinks.length + result.pendingLinks.length;
  };

  for (let i = 0; i < nodes.length; i += batchSize) {
    if (isAborted()) break;
    const batch = nodes.slice(i, i + batchSize);
    const batchStart = Date.now();
    for (const { id } of batch) {
      try { totalLinks += processNode(id); }
      catch (_err) { failed.push(id); }
    }
    onProgress(batch.length);
    const elapsed = Date.now() - batchStart;
    if (elapsed < 2000 && batchSize < 15) batchSize = Math.min(batchSize + 2, 15);
    else if (elapsed > 5000 && batchSize > 2) batchSize = Math.max(batchSize - 2, 2);
  }

  // 重试
  for (let retry = 0; retry < 2 && failed.length > 0; retry++) {
    if (isAborted()) break;
    const retryList = [...failed];
    failed.length = 0;
    for (const id of retryList) {
      try { totalLinks += processNode(id); }
      catch { failed.push(id); }
    }
  }

  return totalLinks;
}

async function saveReportAsNode(db: Database.Database, report: InitReport): Promise<void> {
  const repo = new SqliteRepository(db);
  await digest(repo, {
    content: [
      `Obsidian 初始化报告`,
      ``,
      `- 处理文件: ${report.totalFiles}`,
      `- 创建节点: ${report.nodesCreated}`,
      `- 创建链接: ${report.linksCreated}`,
      `- 悬空引用: ${report.danglingRefs}`,
      `- 涌现结晶: ${report.crystalsCreated}`,
      `- 总费用: $${report.totalCost}`,
      `- 耗时: ${Math.round(report.durationMs / 1000)}s`,
    ].join('\n'),
    source: { tool: 'obsidian' },
    tags: ['初始化'],
    async: false,
    skipDedupMerge: true,
  });
}
