/**
 * 所有代谢任务的注册表
 *
 * 每个任务独立配置间隔和门控，不再按 daily/weekly 桶分组。
 */

import type { TaskDefinition } from './scheduler.js';
import { makeNodeCountGate } from './scheduler.js';
import { runSynapticScaling } from './synaptic.js';
import { runAnnotation } from './annotate.js';
import { runLinkEvaluate } from './link-evaluate.js';
import { runLinkDiscover } from './link-discover.js';
import { promoteFrequentTags } from './tag-promote.js';
import { runDivergentScan, runCrystalEmergence, runKeystoneIdentification } from './divergent.js';
import { runTemporalCrystal } from './temporal-crystal.js';
import { runStructureHolesPrecompute } from '../graph/structure-holes.js';
import { runProfileSynthesize } from '../evolution/profile-synthesize.js';
import { runLearning2, canRunLearning2 } from '../evolution/learning2.js';
import { runLearning3, canRunLearning3 } from '../evolution/learning3.js';
import { claimNextPendingDigest, completePendingDigest, failPendingDigest } from '../db/pending-digests.js';
import { SqliteRepository } from '../db/sqlite-repository.js';
import { createLogger } from '../utils/logger.js';

const _log = createLogger('tasks');

/**
 * 全部代谢任务，按执行频率从高到低排列。
 * daemon 的调度循环遍历此列表，每分钟检查一次。
 */
/**
 * 任务顺序说明（停机恢复时多个任务同时到期，按此顺序串行执行）：
 *
 * 1. annotate       — 先标注新节点（后续任务依赖完整维度/标签）
 * 2. link-evaluate   — 评估/确认/删除候选链接
 * 3. link-discover   — 发现新候选链接
 * 4. synaptic-decay  — 统一衰减节点 heat + 链接 strength（在关联层完成后）
 * 5-9. 涌现层        — 基于最新图结构做枢纽/标签/结晶
 * 10-11. 进化层      — 观察所有任务结果后优化策略
 */
export const ALL_TASKS: TaskDefinition[] = [
  // ── 记忆：Digest 重试 ─────────────────────────────
  {
    id: 'digest-retry',
    execute: async (db) => {
      const item = claimNextPendingDigest(db);
      if (!item) return;

      try {
        const input = JSON.parse(item.input_json);
        const { processDigestRetry } = await import('../tools/digest.js');
        const repo = new SqliteRepository(db);
        await processDigestRetry(repo, input, item.trace_id);
        completePendingDigest(db, item.id);
      } catch (err) {
        failPendingDigest(db, item.id, (err as Error).message);
      }
    },
    intervalStrategy: 'metabolism-params',
    defaultIntervalMinutes: 3,
    requiresLLM: true,
    // gate: 仅当 pending_digests 真的有到期的待处理行才 claim,避免空跑浪费
    // scheduler slot 和 LLM 任务探测名额。注意这里用 status IN ('pending','processing')
    // + next_retry_at 条件,processing 的 stale recovery 由 claimNextPendingDigest
    // 自己负责;这里主要是"是否值得进入 execute"。
    gateCheck: (db) => {
      const row = db.prepare(
        `SELECT 1 FROM pending_digests
         WHERE (status = 'pending' AND next_retry_at <= datetime('now'))
            OR status = 'processing'
         LIMIT 1`,
      ).get();
      return row !== undefined;
    },
  },

  // ── 记忆：标注 ─────────────────────────────────
  {
    id: 'annotate',
    execute: async (db) => { await runAnnotation(db); },
    intervalStrategy: 'annotate',
    defaultIntervalMinutes: 3,
    requiresLLM: true,
  },

  // ── 思考（关联） ──────────────────────────────
  {
    id: 'link-evaluate',
    execute: async (db) => { await runLinkEvaluate(db); },
    intervalStrategy: 'link-evaluate',
    defaultIntervalMinutes: 24 * 60,
    requiresLLM: true,
  },
  {
    id: 'link-discover',
    execute: async (db) => { await runLinkDiscover(db); },
    intervalStrategy: 'link-discover',
    defaultIntervalMinutes: 24 * 60,
  },
  // link-revalidate 不在 scheduler 中注册，由 recall 触发

  // ── 记忆：衰减（关联层完成后再衰减）───────────
  {
    id: 'synaptic-decay',
    execute: async (db) => { runSynapticScaling(db); },
    intervalStrategy: 'metabolism-params',
    intervalKey: 'decay_interval_minutes',
    defaultIntervalMinutes: 24 * 60,
  },

  // ── 思考（涌现） ──────────────────────────────
  {
    id: 'keystone-enrich',
    execute: async (db) => { runKeystoneIdentification(db); },
    intervalStrategy: 'keystone-enrich',
    defaultIntervalMinutes: 24 * 60,
  },
  {
    id: 'tag-promote',
    execute: async (db) => { await promoteFrequentTags(db); },
    requiresLLM: true,
    intervalStrategy: 'metabolism-params',
    intervalKey: 'tag_promote_interval_minutes',
    defaultIntervalMinutes: 24 * 60,
  },
  {
    id: 'divergent-scan',
    execute: async (db) => { await runDivergentScan(db); },
    intervalStrategy: 'scan-divergent',
    defaultIntervalMinutes: 7 * 24 * 60,
    gateCheck: makeNodeCountGate('scan-divergent', 500),
    requiresLLM: true,
  },
  {
    id: 'crystal-emerge',
    execute: async (db) => { await runCrystalEmergence(db); },
    intervalStrategy: 'crystal-emerge',
    defaultIntervalMinutes: 7 * 24 * 60,
    gateCheck: makeNodeCountGate('crystal-emerge', 200),
    requiresLLM: true,
  },
  {
    id: 'temporal-crystal',
    execute: async (db) => { await runTemporalCrystal(db); },
    intervalStrategy: 'temporal-crystal',
    defaultIntervalMinutes: 7 * 24 * 60,
    gateCheck: makeNodeCountGate('temporal-crystal', 200),
    requiresLLM: true,
  },
  // ── 思考（涌现）：画像凝练 ────────────────────
  {
    id: 'profile-synthesize',
    execute: async (db) => { await runProfileSynthesize(db); },
    intervalStrategy: 'profile-synthesize',
    defaultIntervalMinutes: 24 * 60,
    gateCheck: makeNodeCountGate('profile-synthesize', 50),
    requiresLLM: true,
  },
  // ── 进化 ──────────────────────────────────────
  {
    id: 'learning2',
    execute: async (db) => {
      await runLearning2(db);
    },
    intervalStrategy: 'evolution-learning2',
    defaultIntervalMinutes: 7 * 24 * 60,
    gateCheck: (db) => canRunLearning2(db),
    requiresLLM: true,
  },
  {
    id: 'learning3',
    execute: async (db) => { await runLearning3(db); },
    intervalStrategy: 'evolution-learning3',
    defaultIntervalMinutes: 7 * 24 * 60,
    gateCheck: (db) => canRunLearning3(db),
    requiresLLM: true,
  },
  // ── 缓存预计算(无 LLM,纯 SQL):perf-optimization-2026-05-17 P2-1 ──
  {
    id: 'structure-holes-precompute',
    execute: async (db) => { await runStructureHolesPrecompute(db); },
    intervalStrategy: 'structure-holes-precompute',
    defaultIntervalMinutes: 5,
    gateCheck: makeNodeCountGate('structure-holes-precompute', 50),
    requiresLLM: false,
  },
];
