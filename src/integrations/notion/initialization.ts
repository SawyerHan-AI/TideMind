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

const log = createLogger('notion:init');
const DEFAULT_SOURCE = '__default__';

// ── 进度追踪 ──────────────────────────────────────────────────

export interface InitProgress {
  phase: number;
  phaseName: string;
  current: number;
  total: number;
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  error?: string;
}

export interface InitReport {
  totalPages: number;
  nodesCreated: number;
  linksCreated: number;
  durationMs: number;
}

const progressMap = new Map<string, InitProgress>();
const abortedSet = new Set<string>();
// 并发防护:防止同一 sourceId 同时跑两次 runInitialization,以及与
// index.ts 的 runSync/runIncrementalSync 并发写同一 DB 造成重复节点。
const initializingSet = new Set<string>();

export function isNotionInitializing(sourceId: string): boolean {
  return initializingSet.has(sourceId);
}

function getProgress(sourceId?: string): InitProgress {
  const key = sourceId ?? DEFAULT_SOURCE;
  if (!progressMap.has(key)) {
    progressMap.set(key, {
      phase: 0,
      phaseName: '',
      current: 0,
      total: 0,
      status: 'idle',
      startedAt: null,
    });
  }
  return progressMap.get(key)!;
}

export function getInitProgress(sourceId?: string): InitProgress {
  return { ...getProgress(sourceId) };
}

export function abortInit(sourceId?: string): void {
  abortedSet.add(sourceId ?? DEFAULT_SOURCE);
}

function isAborted(sourceId?: string): boolean {
  return abortedSet.has(sourceId ?? DEFAULT_SOURCE);
}

function setPhase(phase: number, name: string, total: number, sourceId?: string): void {
  const progress = getProgress(sourceId);
  Object.assign(progress, { phase, phaseName: name, current: 0, total, status: 'running' as const });
}

function advanceProgress(delta: number = 1, sourceId?: string): void {
  const progress = getProgress(sourceId);
  progress.current += delta;
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
  token: string,
  sourceId: string,
): Promise<InitReport> {
  const key = sourceId;
  // 并发防护:同一 sourceId 已在初始化,直接返回空 report,避免重复写入。
  // 与 obsidian/logseq 抛错不同,这里选择静默返回 — Notion 初始化可能被
  // startNotionSource 的首轮 runSync 在背景触发,对外静默是更温和的行为。
  if (initializingSet.has(key)) {
    log.warn(`Notion 初始化已在进行中,跳过重复调用: ${key}`);
    return { totalPages: 0, nodesCreated: 0, linksCreated: 0, durationMs: 0 };
  }
  // 与 runSync/runIncrementalSync 互斥:sync 正在写同一 DB 时不要叠加 init。
  const { isNotionSyncing } = await import('./index.js');
  if (isNotionSyncing(key)) {
    log.warn(`Notion sync 正在运行,跳过初始化: ${key}`);
    return { totalPages: 0, nodesCreated: 0, linksCreated: 0, durationMs: 0 };
  }
  initializingSet.add(key);
  const startTime = Date.now();
  abortedSet.delete(key);
  clearTagNodeCache();

  const progress = getProgress(sourceId);
  progress.status = 'running';
  progress.startedAt = new Date().toISOString();

  let nodesCreated: number;
  let linksCreated: number;

  try {
    // ── Phase 0: 扫描 ──
    setPhase(0, '扫描页面', 0, sourceId);
    log.info('Phase 0: 扫描所有可访问页面...');

    const allPages: NotionPageSummary[] = [];
    for await (const page of listAllPages(token)) {
      if (isAborted(sourceId)) throw new Error('初始化已中断');
      if (page.inTrash) continue;
      allPages.push(page);
      advanceProgress(1, sourceId);
    }
    progress.total = allPages.length;

    log.info(`Phase 0 完成: 发现 ${allPages.length} 个页面`);

    // ── Phase 1 + 2: 预处理 + 入库（合并为一步，因为 Notion 每页都需要 API 调用） ──
    setPhase(2, '预处理与入库', allPages.length, sourceId);
    log.info(`Phase 1-2: 预处理并入库 ${allPages.length} 个页面...`);

    await processNotionPages(db, token, allPages, sourceId, () => {
      advanceProgress(1, sourceId);
    }, () => isAborted(sourceId));

    if (isAborted(sourceId)) throw new Error('初始化已中断');

    // 统计
    const nodeCountRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM nodes WHERE source_tool = 'notion' AND archived = 0"
    ).get() as { cnt: number };
    nodesCreated = nodeCountRow.cnt;

    log.info(`Phase 2 完成: 创建 ${nodesCreated} 个节点`);

    // ── Phase 3: 显式链接（已在 queue 中处理 relation 和 mention） ──
    setPhase(3, '显式链接', 0, sourceId);
    log.info('Phase 3: 显式链接已在入库阶段完成');

    // ── Phase 3.5: Tag 调整 ──
    if (isAborted(sourceId)) throw new Error('初始化已中断');
    log.info('Phase 3.5: Tag 频率调整...');
    await promoteFrequentTags(db);

    // ── Phase 4: 批量标注 ──
    if (isAborted(sourceId)) throw new Error('初始化已中断');
    const pendingAnnotateCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM nodes WHERE refinement = 0 AND archived = 0 AND is_superseded = 0"
    ).get() as { cnt: number }).cnt;
    setPhase(4, '批量标注', pendingAnnotateCount, sourceId);
    log.info(`Phase 4: 标注 ${pendingAnnotateCount} 个节点...`);

    if (isLlmConfigured()) {
      // 安全上限：直接用待标注数量，确保即使每轮只处理 1 个也不会提前截断
      const maxAnnotateRounds = Math.max(200, pendingAnnotateCount);
      let annotateRound = 0;
      while (annotateRound < maxAnnotateRounds) {
        if (isAborted(sourceId)) throw new Error('初始化已中断');
        const result = await runAnnotation(db);
        if (result.annotated === 0) break;
        advanceProgress(result.annotated, sourceId);
        annotateRound++;
        if (annotateRound % 10 === 0) log.info(`Phase 4: 第 ${annotateRound} 轮`);
      }
    }

    // ── Phase 5: Landing 连接 ──
    if (isAborted(sourceId)) throw new Error('初始化已中断');
    setPhase(5, 'Landing 连接', nodesCreated, sourceId);
    log.info('Phase 5: Landing 连接...');

    const { findLandingConnections } = await import('../../graph/landing.js');
    const { getVectorForNode } = await import('../../db/vectors.js');
    {
      // nodes_vec.id 是 segment_id，不是 node.id。必须通过 node_segments 桥接。
      const nodes = db.prepare(`
        SELECT DISTINCT n.id FROM nodes n
        JOIN node_segments s ON s.node_id = n.id
        JOIN nodes_vec v ON v.id = s.segment_id
        WHERE n.heat > 0.01 AND n.is_meta = 0 AND n.is_superseded = 0
      `).all() as Array<{ id: string }>;

      for (const { id } of nodes) {
        if (isAborted(sourceId)) throw new Error('初始化已中断');
        try {
          const embedding = getVectorForNode(db, id);
          if (!embedding) continue;
          // 初始化的批量 landing 只建连接——节点已经入库且各自有外部身份
          findLandingConnections(db, id, embedding, { skipDedupMerge: true });
        } catch { /* skip individual node errors */ }
        advanceProgress(1, sourceId);
      }
    }

    // ── Phase 6: 链接评估 ──
    if (isAborted(sourceId)) throw new Error('初始化已中断');
    const pendingLinkCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM links WHERE status = 'pending'"
    ).get() as { cnt: number }).cnt;
    setPhase(6, '链接评估', pendingLinkCount, sourceId);
    log.info(`Phase 6: 评估 ${pendingLinkCount} 条链接...`);

    if (isLlmConfigured()) {
      const maxEvalRounds = Math.max(200, pendingLinkCount);
      let evalRound = 0;
      while (evalRound < maxEvalRounds) {
        if (isAborted(sourceId)) throw new Error('初始化已中断');
        const result = await runLinkEvaluate(db);
        if (result.evaluated === 0) break;
        advanceProgress(result.evaluated, sourceId);
        evalRound++;
        if (evalRound % 10 === 0) log.info(`Phase 6: 第 ${evalRound} 轮`);
      }
    }

    // ── Phase 7: Keystone 标记 ──
    if (isAborted(sourceId)) throw new Error('初始化已中断');
    setPhase(7, 'Keystone 标记', 0, sourceId);
    log.info('Phase 7: Keystone 标记...');
    runKeystoneIdentification(db);

    // ── Phase 8: 涌现 ──
    if (isAborted(sourceId)) throw new Error('初始化已中断');
    setPhase(8, '涌现', 0, sourceId);
    log.info('Phase 8: 晶体涌现...');
    await runCrystalEmergence(db);
    await runTemporalCrystal(db);

    // ── 完成 ──
    markFullScanCompleted(db, sourceId);

    const linkCountRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM links WHERE auto = 1"
    ).get() as { cnt: number };
    linksCreated = linkCountRow.cnt;

    progress.status = 'done';
    log.info(`初始化完成: ${nodesCreated} 节点, ${linksCreated} 链接, 耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    return {
      totalPages: allPages.length,
      nodesCreated,
      linksCreated,
      durationMs: Date.now() - startTime,
    };
  } catch (e) {
    const msg = (e as Error).message;
    progress.status = 'error';
    progress.error = msg;
    log.error(`初始化失败: ${msg}`);
    throw e;
  } finally {
    initializingSet.delete(key);
  }
}
