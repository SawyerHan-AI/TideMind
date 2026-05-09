// ============================================================
// Notion 初始化流程（9 阶段）
//
// Phase 0-2: Notion 专属（扫描 → 预处理 → 入库）
// Phase 3-8: 复用共享逻辑（显式链接 → 标注 → 连接 → 评估 → Keystone → 涌现）
// ============================================================

import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { listAllPages } from './api-client.js';
import { processNotionPages } from './queue.js';
import { markFullScanCompleted } from './sync-state.js';
import type { NotionPageSummary } from './types.js';

// 共享管线
import { runAnnotation } from '../../metabolism/annotate.js';
import { runLinkEvaluate } from '../../metabolism/link-evaluate.js';
import { runKeystoneIdentification, runCrystalEmergence } from '../../metabolism/divergent.js';
import { runTemporalCrystal } from '../../metabolism/temporal-crystal.js';
import { promoteFrequentTags } from '../../metabolism/tag-promote.js';
import { clearTagNodeCache } from '../shared/property-promote.js';
import { isLlmConfigured } from '../../config.js';
import { initSessionManager, type InitSessionContext } from '../shared/init-session.js';

const log = createLogger('notion:init');

// ── 类型 ──────────────────────────────────────────────────────

export interface InitReport {
  totalPages: number;
  nodesCreated: number;
  linksCreated: number;
  durationMs: number;
}

/**
 * 兼容 index.ts 的 runSync/runIncrementalSync 互斥逻辑：
 * 这些路径不走 IPC，不直接持有 InitSessionContext，需要一个静态查询。
 */
export function isNotionInitializing(sourceId: string): boolean {
  const snap = initSessionManager.snapshot(sourceId);
  return !!snap && (snap.status === 'running' || snap.status === 'aborting');
}

// ── 预览 ──────────────────────────────────────────────────────

export async function previewInit(
  token: string,
): Promise<{ totalPages: number } | null> {
  try {
    let count = 0;
    for await (const page of listAllPages(token)) {
      if (!page.inTrash) count++;
    }
    return { totalPages: count };
  } catch (e) {
    log.error(`预览失败: ${(e as Error).message}`);
    return null;
  }
}

// ── 主初始化流程 ──────────────────────────────────────────────

export async function runInitialization(
  db: Database.Database,
  ctx: InitSessionContext,
  token: string,
): Promise<InitReport> {
  const sourceId = ctx.sourceId;
  const signal = ctx.signal;
  const startTime = Date.now();

  const checkAborted = () => {
    if (signal.aborted) {
      throw signal.reason ?? new Error('初始化已中断');
    }
  };

  // 与 runSync/runIncrementalSync 互斥:sync 正在写同一 DB 时不要叠加 init。
  const { isNotionSyncing } = await import('./index.js');
  if (isNotionSyncing(sourceId)) {
    log.warn(`Notion sync 正在运行,跳过初始化: ${sourceId}`);
    return { totalPages: 0, nodesCreated: 0, linksCreated: 0, durationMs: 0 };
  }

  clearTagNodeCache();

  // ── Phase 0: 扫描 ──
  ctx.reportPhase(0, '扫描页面', 0);
  log.info('Phase 0: 扫描所有可访问页面...');

  const allPages: NotionPageSummary[] = [];
  for await (const page of listAllPages(token)) {
    checkAborted();
    if (page.inTrash) continue;
    allPages.push(page);
    ctx.advance();
    ctx.heartbeat();
  }
  ctx.setProgress({ total: allPages.length });

  log.info(`Phase 0 完成: 发现 ${allPages.length} 个页面`);

  // ── Phase 1 + 2: 预处理 + 入库（合并为一步，因为 Notion 每页都需要 API 调用） ──
  ctx.reportPhase(2, '预处理与入库', allPages.length);
  log.info(`Phase 1-2: 预处理并入库 ${allPages.length} 个页面...`);

  await processNotionPages(db, token, allPages, sourceId, () => {
    ctx.advance();
    ctx.heartbeat();
  }, () => signal.aborted);

  checkAborted();

  // 统计
  const nodeCountRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE source_tool = 'notion' AND archived = 0"
  ).get() as { cnt: number };
  const nodesCreated = nodeCountRow.cnt;

  log.info(`Phase 2 完成: 创建 ${nodesCreated} 个节点`);

  // ── Phase 3: 显式链接（已在 queue 中处理 relation 和 mention） ──
  ctx.reportPhase(3, '显式链接', 0);
  log.info('Phase 3: 显式链接已在入库阶段完成');

  // ── Phase 3.5: Tag 调整 ──
  checkAborted();
  log.info('Phase 3.5: Tag 频率调整...');
  await promoteFrequentTags(db);

  // ── Phase 4: 批量标注 ──
  checkAborted();
  const pendingAnnotateCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE refinement = 0 AND archived = 0 AND is_superseded = 0"
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(4, '批量标注', pendingAnnotateCount);
  log.info(`Phase 4: 标注 ${pendingAnnotateCount} 个节点...`);

  if (isLlmConfigured()) {
    const maxAnnotateRounds = Math.max(200, pendingAnnotateCount);
    let annotateRound = 0;
    while (annotateRound < maxAnnotateRounds) {
      checkAborted();
      const result = await runAnnotation(db, { signal });
      if (result.annotated === 0) break;
      ctx.advance(result.annotated);
      ctx.heartbeat();
      annotateRound++;
      if (annotateRound % 10 === 0) log.info(`Phase 4: 第 ${annotateRound} 轮`);
    }
  }

  // ── Phase 5: Landing 连接 ──
  checkAborted();
  ctx.reportPhase(5, 'Landing 连接', nodesCreated);
  log.info('Phase 5: Landing 连接...');

  const { findLandingConnections } = await import('../../graph/landing.js');
  const { getVectorForNode } = await import('../../db/vectors.js');
  {
    // nodes_vec.id 是 segment_id，不是 node.id。必须通过 node_segments 桥接。
    const nodes = db.prepare(`
      SELECT DISTINCT n.id FROM nodes n
      JOIN node_segments s ON s.node_id = n.id
      JOIN nodes_vec v ON v.id = s.segment_id
      WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0 AND n.archived = 0
    `).all() as Array<{ id: string }>;

    for (const { id } of nodes) {
      checkAborted();
      try {
        const embedding = getVectorForNode(db, id);
        if (!embedding) continue;
        findLandingConnections(db, id, embedding, { skipDedupMerge: true });
      } catch { /* skip individual node errors */ }
      ctx.advance();
      ctx.heartbeat();
    }
  }

  // ── Phase 6: 链接评估 ──
  checkAborted();
  const pendingLinkCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM links WHERE status = 'pending'"
  ).get() as { cnt: number }).cnt;
  ctx.reportPhase(6, '链接评估', pendingLinkCount);
  log.info(`Phase 6: 评估 ${pendingLinkCount} 条链接...`);

  if (isLlmConfigured()) {
    const maxEvalRounds = Math.max(200, pendingLinkCount);
    let evalRound = 0;
    while (evalRound < maxEvalRounds) {
      checkAborted();
      const result = await runLinkEvaluate(db, { signal });
      if (result.evaluated === 0) break;
      ctx.advance(result.evaluated);
      ctx.heartbeat();
      evalRound++;
      if (evalRound % 10 === 0) log.info(`Phase 6: 第 ${evalRound} 轮`);
    }
  }

  // ── Phase 7: Keystone 标记 ──
  checkAborted();
  ctx.reportPhase(7, 'Keystone 标记', 0);
  log.info('Phase 7: Keystone 标记...');
  runKeystoneIdentification(db);

  // ── Phase 8: 涌现 ──
  checkAborted();
  ctx.reportPhase(8, '涌现', 0);
  log.info('Phase 8: 晶体涌现...');
  await runCrystalEmergence(db);
  await runTemporalCrystal(db);

  // ── 完成 ──
  markFullScanCompleted(db, sourceId);

  const linkCountRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM links WHERE auto = 1"
  ).get() as { cnt: number };
  const linksCreated = linkCountRow.cnt;

  log.info(`初始化完成: ${nodesCreated} 节点, ${linksCreated} 链接, 耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return {
    totalPages: allPages.length,
    nodesCreated,
    linksCreated,
    durationMs: Date.now() - startTime,
  };
}
