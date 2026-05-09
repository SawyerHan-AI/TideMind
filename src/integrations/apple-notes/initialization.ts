// ============================================================
// Apple Notes 初始化管线
//
// 简化的多阶段初始化流程，供前端向导调用：
// - previewInit：扫描 + 预估
// - runInitialization：Phase 0-6
//   Phase 0：扫描 + 收集
//   Phase 1：批量入库（调用 processNoteQueue）
//   Phase 2-6：复用现有 metabolism（标注/landing/链接评估/keystone/涌现）
// ============================================================

import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { reloadConfig, isLlmConfigured } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { logTimelineEvent } from '../../db/log.js';
import { now } from '../../utils/time.js';
import { estimateCost } from '../../llm/pricing.js';
import { getConfig } from '../../config.js';
import { runAnnotation } from '../../metabolism/annotate.js';
import { runLinkEvaluate } from '../../metabolism/link-evaluate.js';
import { runKeystoneIdentification, runCrystalEmergence } from '../../metabolism/divergent.js';
import { runTemporalCrystal } from '../../metabolism/temporal-crystal.js';
import { clearTagNodeCache } from '../shared/property-promote.js';
import {
  openNoteStoreDb,
  detectSchemaVersion,
  listFolders,
  buildFolderPathMap,
  listNotes,
  countNotes,
  parseAccountsFromPath,
  preloadNoteTags,
  preloadNoteAttachmentTexts,
} from './database.js';
import { initProto } from './protobuf.js';
import { ensureSyncSchema, markFullScanCompleted } from './sync-state.js';
import { processNoteQueue } from './queue.js';
import type { AppleNote, AppleTag, AttachmentText } from './types.js';
import type { InitSessionContext } from '../shared/init-session.js';

const log = createLogger('apple-notes-init');

// ======== 预览 ========

export interface InitPreview {
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
 * 预览初始化结果：扫描所选账户下的笔记数，估算节点数和费用
 */
export function previewInit(
  db: Database.Database,
  sourceId?: string,
  sourcePath?: string,
): InitPreview | null {
  if (!sourcePath) return null;

  const { dbPath, accountZpks } = parseAccountsFromPath(sourcePath);
  if (!fs.existsSync(dbPath)) return null;

  reloadConfig();
  const config = getConfig();

  let totalNotes: number;
  try {
    const noteStoreDb = openNoteStoreDb(dbPath);
    try {
      const schema = detectSchemaVersion(noteStoreDb);
      totalNotes = countNotes(noteStoreDb, schema, accountZpks);
    } finally {
      noteStoreDb.close();
    }
  } catch (err) {
    log.error('预览失败:', (err as Error).message);
    return null;
  }

  // Apple Notes 单条笔记通常是一个节点（极少数长笔记才分段）
  // 估算：平均 1.2 个节点 / 笔记
  const estimatedNodes = Math.round(totalNotes * 1.2);

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

  return {
    totalFiles: totalNotes,
    breakdown: [{ label: 'notes', count: totalNotes }],
    estimatedNodes,
    estimatedCost: {
      annotation: Math.round(annotationCost * 100) / 100,
      linkEval: Math.round(linkEvalCost * 100) / 100,
      emergence: Math.round(emergenceCost * 100) / 100,
      total: Math.round((annotationCost + linkEvalCost + emergenceCost) * 100) / 100,
    },
  };
}

// ======== 主初始化流程 ========

export interface InitReport {
  totalFiles: number;
  nodesCreated: number;
  linksCreated: number;
  crystalsCreated: number;
  totalCost: number;
  durationMs: number;
}

/**
 * 执行完整初始化管线
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

  reloadConfig();

  if (!sourcePath) throw new Error('Apple Notes path not provided');
  const { dbPath, accountZpks } = parseAccountsFromPath(sourcePath);
  if (!fs.existsSync(dbPath)) throw new Error(`NoteStore.sqlite not found: ${dbPath}`);

  ensureSyncSchema(db);
  await initProto();
  clearTagNodeCache();

  let linksCreated = 0;
  let crystalsCreated = 0;

  // Phase 0: 扫描（从 NoteStore.sqlite 读取数据）
  ctx.reportPhase(0, '扫描', 0);
  log.info('Phase 0: 扫描 Apple Notes');

  // 所有 NoteStore.sqlite 读取操作都在一个 try-finally 中，确保 close
  const noteStoreDb = openNoteStoreDb(dbPath);
  let notes: AppleNote[];
  let folderPathMap: Map<number, string>;
  const tagsByNote = new Map<number, AppleTag[]>();
  const attachTextsByNote = new Map<number, AttachmentText[]>();

  try {
    const schema = detectSchemaVersion(noteStoreDb);
    const folders = listFolders(noteStoreDb, schema);
    folderPathMap = buildFolderPathMap(folders);
    notes = listNotes(noteStoreDb, schema, accountZpks);

    // 批量预加载 tags 和附件文本（在 finally close 之前完成所有 noteStoreDb 读取）
    const noteZpks = notes.map(n => n.zpk);
    if (schema.hasHashtags) {
      const loaded = preloadNoteTags(noteStoreDb, noteZpks);
      for (const [k, v] of loaded) tagsByNote.set(k, v);
    }
    const loadedAttach = preloadNoteAttachmentTexts(noteStoreDb, noteZpks);
    for (const [k, v] of loadedAttach) attachTextsByNote.set(k, v);
  } finally {
    noteStoreDb.close();
  }

  const totalNotes = notes.length;
  ctx.setProgress({ total: totalNotes, current: totalNotes });

  checkAborted();

  // Phase 1: 入库（使用 queue 返回的精确计数，而非全表 COUNT）
  ctx.reportPhase(1, '入库', totalNotes);
  log.info(`Phase 1: 入库 (${totalNotes} 条笔记)`);

  const queueResult = await processNoteQueue(
    db, notes, folderPathMap, tagsByNote, attachTextsByNote, sourceId ?? '',
    undefined,
    () => signal.aborted,
  );
  const nodesCreated = queueResult.nodeIdsCreated.length;
  linksCreated += queueResult.linksCreated;

  checkAborted();

  // Phase 2: 节点标注
  const pendingAnnotateCount = (db.prepare(
    'SELECT COUNT(*) as cnt FROM nodes WHERE refinement = 0 AND heat > 0.01 AND is_crystal = 0 AND is_meta = 0 AND is_superseded = 0 AND archived = 0',
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(2, '节点标注', pendingAnnotateCount);
  log.info(`Phase 2: 节点标注 (${pendingAnnotateCount} 个待标注)`);

  if (isLlmConfigured()) {
    const maxAnnotateRounds = Math.max(200, Math.ceil(pendingAnnotateCount / 10));
    let annotateRound = 0;
    while (annotateRound < maxAnnotateRounds) {
      const result = await runAnnotation(db, { signal });
      if (!result || result.annotated === 0) break;
      annotateRound++;
      ctx.advance();
      ctx.heartbeat();
      checkAborted();
    }
    log.info(`Phase 2 完成: ${annotateRound} 轮标注`);
  }

  // Phase 3: 链接评估
  const pendingLinkCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM links WHERE status = 'pending'",
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(3, '链接评估', pendingLinkCount);
  log.info(`Phase 3: 链接评估 (${pendingLinkCount} 条待评估)`);

  if (isLlmConfigured()) {
    let evalRound = 0;
    while (evalRound < 500) {
      const result = await runLinkEvaluate(db, { signal });
      if (result.evaluated === 0) break;
      evalRound++;
      ctx.advance();
      ctx.heartbeat();
      checkAborted();
    }
    log.info(`Phase 3 完成: ${evalRound} 轮评估`);
  }

  // Phase 4: Keystone 标记
  ctx.reportPhase(4, 'Keystone 标记', 0);
  log.info('Phase 4: Keystone 标记');
  runKeystoneIdentification(db);
  ctx.setProgress({ current: 1 });

  checkAborted();

  // Phase 5: 涌现
  ctx.reportPhase(5, '涌现', 0);
  log.info('Phase 5: 涌现');

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

  // 标记完成
  markFullScanCompleted(db, sourceId);

  // 汇总费用（基于 startedAt 过滤本次初始化期间的 LLM 调用）
  const totalCost = (db.prepare(`
    SELECT COALESCE(SUM(estimated_cost), 0) as total
    FROM llm_usage_log
    WHERE created >= ?
  `).get(startedAtIso) as { total: number }).total;

  const durationMs = Date.now() - startTime;
  const report: InitReport = {
    totalFiles: totalNotes,
    nodesCreated,
    linksCreated,
    crystalsCreated,
    totalCost: Math.round(totalCost * 100) / 100,
    durationMs,
  };

  logTimelineEvent(db, {
    type: 'memory',
    subtype: 'apple_notes_sync',
    title: JSON.stringify({
      key: 'apple_notes_init_complete',
      params: { nodes: nodesCreated, links: linksCreated, crystals: crystalsCreated },
    }),
    detail: report as unknown as Record<string, unknown>,
    important: 1,
  });

  log.info(`Apple Notes 初始化完成! 耗时 ${Math.round(durationMs / 1000)}s, ${nodesCreated} 节点, ${crystalsCreated} 结晶`);

  return report;
}
