// ============================================================
// Obsidian 初始化管线
//
// Phase 0-2: Obsidian 特有（扫描、分类、预处理、入库）
// Phase 3-8: 复用 Logseq 初始化管线的通用逻辑
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getConfig, reloadConfig, isLlmConfigured } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { logTimelineEvent } from '../../db/log.js';
import { now } from '../../utils/time.js';

import { walkMdFiles, preprocessFile, buildFileIndex } from './preprocessor.js';
import { segmentContent } from './segmenter.js';
import { classifyFiles, buildInDegreeMap } from './classifier.js';
import type { ClassifiedFile as ObsClassifiedFile } from './types.js';
import { inferPageDates, type InferredDateInfo } from './time-inference.js';
import { readVaultConfig, getExcludedDirs } from './vault-config.js';
import { ensureSyncSchema, setFileState, getFileState, computeFileHash, markFullScanCompleted } from './sync-state.js';
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
import { findLandingConnections } from '../../graph/landing.js';

// 复用 Logseq 的 initial-heat 计算（纯函数，无 Logseq 依赖）
import { computeInitialHeat } from '../logseq/initial-heat.js';

const log = createLogger('obsidian-init');

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
    try { return fs.readFileSync(fp, 'utf-8'); }
    catch { return null; }
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

export async function runInitialization(db: Database.Database, sourceId?: string, sourcePath?: string): Promise<InitReport> {
  const key = sourceId ?? DEFAULT_SOURCE;
  if (initializingSet.has(key)) throw new Error('初始化已在进行中，不能重复启动');
  // 全局锁：同一时刻只允许一个初始化
  if (initializingSet.size > 0) throw new Error('有其他笔记源正在初始化，请等待完成后再试');
  initializingSet.add(key);
  abortedSet.delete(key);
  const startTime = Date.now();

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
  let danglingRefs = 0;

  try {
    // === Phase 0: 扫描分类 ===
    setPhase(0, '扫描分类', 0, sourceId);
    log.info('Phase 0: 扫描分类');

    const allFiles = walkMdFiles(vaultRoot, excludedDirs);
    const contentCache = new Map<string, string>();
    const readCached = (fp: string): string | null => {
      if (!contentCache.has(fp)) {
        try { contentCache.set(fp, fs.readFileSync(fp, 'utf-8')); }
        catch { return null; }
      }
      return contentCache.get(fp) ?? null;
    };

    const classified = classifyFiles(allFiles, vaultRoot, vaultConfig, readCached);
    getProgress(sourceId).total = classified.length;
    getProgress(sourceId).current = classified.length;

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 1: 预处理 + 时间推断 ===
    setPhase(1, '预处理', classified.length, sourceId);
    log.info('Phase 1: 预处理 + 时间推断');

    buildFileIndex(vaultRoot, excludedDirs);

    const inferredDates = inferPageDates(classified, readCached, vaultConfig);
    const inDegreeMap = buildInDegreeMap(classified, readCached);
    const importDate = new Date().toISOString().slice(0, 10);

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 2: 入库 ===
    setPhase(2, '入库', classified.length, sourceId);
    log.info(`Phase 2: 入库 (${classified.length} 个文件)`);

    const fileToNodeIds = new Map<string, string[]>();
    // 段级链接映射：pageTitle#heading → nodeId
    const headingToNodeId = new Map<string, string>();

    for (const file of classified) {
      if (isAborted(sourceId)) throw new Error('初始化已中断');

      // 跳过不需要入库的类型
      if (['template', 'attachment'].includes(file.category)) {
        advanceProgress(1, sourceId);
        continue;
      }

      // 断点恢复
      const existingState = getFileState(db, file.relPath, sourceId);
      if (existingState && existingState.node_ids.length > 0) {
        const title = path.basename(file.relPath, path.extname(file.relPath));
        fileToNodeIds.set(title, existingState.node_ids);
        nodesCreated += existingState.node_ids.length;
        advanceProgress(1, sourceId);
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

      advanceProgress(1, sourceId);
    }

    log.info(`Phase 2 完成: ${nodesCreated} 个节点`);
    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 3: 显式链接 ===
    setPhase(3, '显式链接', nodesCreated, sourceId);
    log.info('Phase 3: 显式链接');

    const explicitResult = await createExplicitLinks(
      db, classified, fileToNodeIds, contentCache, headingToNodeId,
    );
    linksCreated += explicitResult.created;
    danglingRefs = explicitResult.dangling;
    contentCache.clear();

    log.info(`Phase 3 完成: ${explicitResult.created} 条链接, ${danglingRefs} 个悬空引用`);
    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // === Phase 4-8: 通用管线（与 Logseq 相同） ===

    // Phase 4: 批量标注
    const pendingAnnotateCount = (db.prepare(
      'SELECT COUNT(*) as cnt FROM nodes WHERE refinement = 0 AND heat > 0.01 AND is_crystal = 0 AND is_meta = 0 AND is_superseded = 0',
    ).get() as { cnt: number }).cnt;
    setPhase(4, '批量标注', pendingAnnotateCount, sourceId);
    log.info(`Phase 4: 批量标注 (${pendingAnnotateCount} 个)`);

    if (isLlmConfigured()) {
      let annotateRound = 0;
      while (annotateRound < 200) {
        const result = await runAnnotation(db);
        if (!result || (result as any).annotated === 0) break;
        annotateRound++;
        if (annotateRound % 10 === 0) log.info(`Phase 4: 第 ${annotateRound} 轮`);
        advanceProgress(1, sourceId);
        if (isAborted(sourceId)) throw new Error('初始化已中断');
      }
    }

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // Phase 5: Landing Connections
    const embeddedCount = (db.prepare(
      'SELECT COUNT(DISTINCT n.id) as cnt FROM nodes n JOIN nodes_vec v ON n.id = v.id WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0',
    ).get() as { cnt: number }).cnt;
    setPhase(5, 'Landing 连接', embeddedCount, sourceId);
    log.info(`Phase 5: Landing Connections (${embeddedCount} 个节点)`);

    const landingResult = await createLandingConnections(db, () => isAborted(sourceId), (n: number) => advanceProgress(n, sourceId));
    linksCreated += landingResult;

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // Phase 6: 链接评估
    const pendingLinkCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM links WHERE status = 'pending'",
    ).get() as { cnt: number }).cnt;
    setPhase(6, '链接评估', pendingLinkCount, sourceId);
    log.info(`Phase 6: 链接评估 (${pendingLinkCount} 条)`);

    if (isLlmConfigured()) {
      let evalRound = 0;
      while (evalRound < 500) {
        const result = await runLinkEvaluate(db);
        if (result.evaluated === 0) break;
        evalRound++;
        if (evalRound % 10 === 0) log.info(`Phase 6: 第 ${evalRound} 轮`);
        advanceProgress(1, sourceId);
        if (isAborted(sourceId)) throw new Error('初始化已中断');
      }
    }

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // Phase 7: Keystone 标记
    setPhase(7, 'Keystone 标记', 0, sourceId);
    log.info('Phase 7: Keystone 标记');
    runKeystoneIdentification(db);

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // Phase 8: 涌现
    setPhase(8, '涌现', 0, sourceId);
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
    `).get(getProgress(sourceId).startedAt ?? now()) as { total: number }).total;

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

    getProgress(sourceId).status = 'done';
    log.info(`初始化完成! 耗时 ${Math.round(durationMs / 1000)}s`);
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
  const title = path.basename(file.relPath, path.extname(file.relPath));
  const dateInfo = inferredDates.get(file.relPath) ?? inferredDates.get(title);
  const inDegree = inDegreeMap.get(title) ?? 0;
  const initialHeat = computeInitialHeat(dateInfo as any, inDegree, importDate);
  const originalCreated = dateInfo?.date ? `${dateInfo.date}T00:00:00.000Z` : undefined;

  // Canvas 文件
  if (file.category === 'canvas') {
    const parsed = parseCanvas(file.absPath);
    if (!parsed) return [];
    const nodeIds: string[] = [];
    for (const textNode of parsed.textNodes) {
      if (!textNode.text.trim()) continue;
      const result = await digest(db, {
        content: textNode.text,
        source: { tool: 'obsidian', files: [file.relPath] },
        context: `Obsidian Canvas: ${title}`,
        tags: textNode.groupLabels.length > 0 ? textNode.groupLabels : undefined,
        async: false, initialHeat, created: originalCreated,
      });
      if (result.created_nodes) nodeIds.push(...result.created_nodes.map(n => n.id));
    }
    updateSyncState(db, file, nodeIds, sourceId);
    return nodeIds;
  }

  // 空白 / 元数据 → tag 节点
  if (file.category === 'empty_tag' || file.category === 'metadata_only') {
    const result = await digest(db, {
      content: title,
      source: { tool: 'obsidian', files: [file.relPath] },
      context: `Obsidian 标签页: ${title}`,
      tags: [title],
      async: false, initialHeat, created: originalCreated,
    });
    const nodeIds = result.created_nodes?.map(n => n.id) ?? [];
    for (const id of nodeIds) updateNode(db, id, { is_tag: 1 });
    updateSyncState(db, file, nodeIds, sourceId);
    return nodeIds;
  }

  // 常规文件
  const preprocessed = preprocessFile(file.absPath, vaultRoot);
  if (!preprocessed) return [];

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

    const result = await digest(db, {
      content: segment.content,
      source: { tool: 'obsidian', files: [file.relPath] },
      context: contextParts,
      tags: combinedTags.length > 0 ? combinedTags : undefined,
      async: false, initialHeat, created: originalCreated,
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

  updateSyncState(db, file, nodeIds, sourceId);
  return nodeIds;
}

function updateSyncState(db: Database.Database, file: ObsClassifiedFile, nodeIds: string[] = [], sourceId?: string): void {
  let mtime = 0, size = 0;
  try {
    const stat = fs.statSync(file.absPath);
    mtime = Math.floor(stat.mtimeMs);
    size = stat.size;
  } catch {}
  setFileState(db, {
    file_path: file.relPath,
    content_hash: computeFileHash(file.absPath),
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
      try { content = fs.readFileSync(file.absPath, 'utf-8'); }
      catch { continue; }
    }

    // 提取 [[refs]]
    const refs = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
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
      if (hashIdx > 0) {
        heading = pageName.slice(hashIdx + 1).replace(/^\^/, '');
        pageName = pageName.slice(0, hashIdx);
      }

      // 处理路径
      if (pageName.includes('/')) {
        pageName = pageName.split('/').pop() ?? pageName;
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
const danglingTagCache = new Map<string, string>();

async function createDanglingTagNode(db: Database.Database, name: string): Promise<string | null> {
  const normalized = name.trim().toLowerCase();
  if (danglingTagCache.has(normalized)) return danglingTagCache.get(normalized)!;

  const existing = db.prepare(
    "SELECT id FROM nodes WHERE is_tag = 1 AND content = ? AND archived = 0 AND is_superseded = 0",
  ).get(name) as { id: string } | undefined;

  if (existing) {
    danglingTagCache.set(normalized, existing.id);
    return existing.id;
  }

  const result = await digest(db, {
    content: name,
    source: { tool: 'obsidian' },
    context: `Obsidian 悬空引用 tag: ${name}`,
    tags: [name],
    async: false,
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
  const nodes = db.prepare(`
    SELECT n.id FROM nodes n
    JOIN nodes_vec v ON n.id = v.id
    WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0
  `).all() as Array<{ id: string }>;

  let totalLinks = 0;
  const failed: string[] = [];
  let batchSize = 5;

  const processNode = (id: string): number => {
    const vecRow = db.prepare('SELECT embedding FROM nodes_vec WHERE id = ?').get(id) as { embedding: Buffer } | undefined;
    if (!vecRow) return 0;
    const embedding = new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4);
    const result = findLandingConnections(db, id, embedding);
    return result.confirmedLinks.length + result.pendingLinks.length;
  };

  for (let i = 0; i < nodes.length; i += batchSize) {
    if (isAborted()) break;
    const batch = nodes.slice(i, i + batchSize);
    const batchStart = Date.now();
    for (const { id } of batch) {
      try { totalLinks += processNode(id); }
      catch (err) { failed.push(id); }
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
  await digest(db, {
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
  });
}
