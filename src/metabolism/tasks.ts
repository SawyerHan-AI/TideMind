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
import { runPendingLinkGc, pendingLinkGcGate } from './pending-link-gc.js';
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
    // B-3: digest 内部走 insertSegmentVectors → getEmbedding。embedding 熔断器
    // open 时跳过,避免持续把失败的 digest 进 retry 表填满。
    requiresEmbedding: true,
    // gate: 仅当 pending_digests 真的有到期的待处理行才 claim,避免空跑浪费
    // scheduler slot 和 LLM 任务探测名额。注意这里用 status IN ('pending','processing')
    // + next_retry_at 条件,processing 的 stale recovery 由 claimNextPendingDigest
    // 自己负责;这里主要是"是否值得进入 execute"。
    //
    // 修复 F5(2026-05-21): next_retry_at 列是 JS ISO 字符串。原先用
    // `datetime('now')` 返回 'YYYY-MM-DD HH:MM:SS'(空格无 Z),按字典序比较时
    // ISO 的 'T' (0x54) > 空格 (0x20),`next_retry_at <= datetime('now')` 永远 false,
    // pending 行的到期条件永远不触发(只能靠 status='processing' 分支兜底)。
    // 改为 JS 侧 ISO,字典序 = 时间序。
    gateCheck: (db) => {
      const nowIso = new Date().toISOString();
      const row = db.prepare(
        `SELECT 1 FROM pending_digests
         WHERE (status = 'pending' AND next_retry_at <= ?)
            OR status = 'processing'
         LIMIT 1`,
      ).get(nowIso);
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
  // 过期 pending 链接的物理 GC。独立于 LLM 任务：
  // requiresLLM=false（不受熔断探测影响），gateCheck 用 llm_last_success_at
  // 拦下 LLM 长期失败时的次生删除（2026-05-19 事故防御）。
  {
    id: 'pending-link-gc',
    execute: async (db) => { runPendingLinkGc(db); },
    intervalStrategy: 'link-evaluate',
    intervalKey: 'gc_interval_minutes',
    defaultIntervalMinutes: 24 * 60,
    requiresLLM: false,
    gateCheck: pendingLinkGcGate,
  },
  {
    id: 'link-discover',
    execute: async (db) => { await runLinkDiscover(db); },
    intervalStrategy: 'link-discover',
    defaultIntervalMinutes: 24 * 60,
    // B-3: link-discover 走 searchVectors,在 embedding 长期不可用时无法产生有效
    // 候选邻居(新节点没向量),空跑浪费 scheduler slot。这里取保守策略 — 熔断
    // 期内整体跳过。
    requiresEmbedding: true,
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
    // B-3: divergent 内部依赖向量结构,embedding 长期不可用时拿不到有意义的
    // bridge candidate,空跑浪费 LLM/scheduler slot。
    requiresEmbedding: true,
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
