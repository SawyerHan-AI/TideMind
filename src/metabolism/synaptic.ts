import type Database from 'better-sqlite3';
import { getParam } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';

const log = createLogger('synaptic');

/**
 * Cooperative decay commits node batches independently. Once any batch has
 * committed, retrying the whole task would apply the decay twice to that
 * prefix. The scheduler therefore retains the daily claim for this explicit
 * outcome and lets the next normal cadence reconcile the remaining rows.
 */
export class SynapticPartialEffectError extends Error {
  readonly code = 'partial_task_effect';

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`synaptic decay stopped after a committed batch: ${detail}`, { cause });
    this.name = 'SynapticPartialEffectError';
  }
}

/** M8.5:云同步活跃(cloud_last_synced_version 存在)→ A 类衰减由 generation 重算负责,daily 跳过。 */
function isCloudSyncActive(db: Database.Database): boolean {
  try {
    const row = db.prepare(`SELECT value FROM metadata WHERE key = 'cloud_last_synced_version'`).get() as { value?: string } | undefined;
    return row?.value != null;
  } catch {
    return false;
  }
}

/**
 * 每日突触衰减 + 归档判定
 *
 * 衰减公式: decay_rate = 1 - base × (1 - damping × min(connectivity, 1))
 * 其中 base=0.05, damping=0.8
 * 效果: connectivity=0 → ×0.950（衰减5%）, connectivity=0.5 → ×0.970, connectivity=1.0 → ×0.990
 * 所有节点严格衰减（decay_rate 恒 < 1.0），连通度高的节点衰减更慢但不会增长。
 */
function* runSynapticScalingBatches(db: Database.Database, testHooks?: {
  beforeFirstLinkBatch?: () => void;
  beforeTimelineEvent?: () => void;
  nodeBatchDurationMs?: () => number;
  linkBatchDurationMs?: () => number;
}): Generator<'node' | 'node_slow' | 'link' | 'link_slow', {
  decayed: number;
}, void> {
  // M8.5:云同步用户的 heat/link 衰减改由云端 generation 锚点 + 本地 recomputeToGeneration
  // 负责(各端重算),本地 daily wall-clock 会与之双重衰减,故跳过。纯本地用户(无
  // cloud_last_synced_version)仍跑 wall-clock 衰减。
  if (isCloudSyncActive(db)) return { decayed: 0 };

  let decayed = 0;

  // 只处理 heat > 0.01 的节点（极低 heat 的自然沉底，不浪费计算）
  // archived/superseded 节点不参与 heat decay,它们已被冰冻在 0.02
  const nodes = db.prepare(`
    SELECT n.id
    FROM nodes n WHERE n.heat > 0.01 AND n.archived = 0 AND n.is_superseded = 0
  `).all() as Array<{ id: string }>;

  // maturity_score 权重，与 graph/maturity.ts 一致（动态加载策略参数）
  const wH = getParam('recall-rank', 'heat_weight', 0.2);
  const wR = getParam('recall-rank', 'refinement_weight', 0.3);
  const wC = getParam('recall-rank', 'connectivity_weight', 0.3);
  const wI = getParam('recall-rank', 'independence_weight', 0.2);
  // 衰减因子传入 SQL并作用于当前heat，
  // 避免跨进程读-改-写覆盖:A 读 heat=0.3 → 期间 B bumpHeat 到 0.9 → A 写回
  // 0.285 这种"衰减覆盖提热"场景。
  //
  // ⚠️ SET 子句顺序坑：SQLite 把 SET 表达式右侧统一按"行的旧值"求值，
  // 所以 `maturity_score = ... MIN(heat * decayRate, 1.0) ...` 里的 heat 仍是
  // 衰减前的值，等价于 maturity 永远晚 heat 一个周期。修法是把 heat 衰减
  // 后的乘积直接当 WHERE 子句外的常量传进来，不要在 SET 里再去乘一次。
  // maturity显式使用同一rate，让它与赋值后的heat基于同一旧行快照。
  const decayBase = getParam('metabolism-params', 'decay_base', 0.05);
  const decayDamping = getParam('metabolism-params', 'decay_damping', 0.8);

  // 每批只执行一条基于当前行快照的 UPDATE。旧实现为了 cooperative yield 后的
  // 并发安全，对每个节点 point-read + UPDATE；10k 节点因此产生约 20k 次 SQL
  // 往返。这里仍在每个短事务内读取当前 connectivity/active 状态，但由 SQLite
  // 对整批集合完成，避免旧快照覆盖的同时把往返降到约 100 次。显式使用主键
  // index；否则planner会为每个200-node批次扫描整个active-heat index。
  const updateBatch = db.prepare(`
    UPDATE nodes INDEXED BY sqlite_autoindex_nodes_1 SET
      heat = heat * (
        1 - @base * (1 - @damping * MIN(COALESCE(connectivity, 0), 1.0))
      ),
      maturity_score = @wH * MIN(
          heat * (1 - @base * (1 - @damping * MIN(COALESCE(connectivity, 0), 1.0))),
          1.0
        )
        + @wR * refinement + @wC * connectivity + @wI * independence,
      updated = @ts
    WHERE id IN (SELECT value FROM json_each(@ids))
      AND heat > 0.01 AND archived = 0 AND is_superseded = 0
  `);

  // 分批事务：每 BATCH_SIZE 个节点一个事务，减少写锁持有时间
  const BATCH_SIZE = 200;
  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    const batchStartedAt = Date.now();
    db.transaction(() => {
      decayed += updateBatch.run({
        ids: JSON.stringify(batch.map(node => node.id)),
        base: decayBase,
        damping: decayDamping,
        wH,
        wR,
        wC,
        wI,
        ts: now(),
      }).changes;
      // 不再归档 — heat 自然衰减到极低值即可，recall 按 heat 排序自然沉底
    }).immediate();
    const batchDurationMs = testHooks?.nodeBatchDurationMs?.() ?? (Date.now() - batchStartedAt);
    if (batchDurationMs > 50) log.warn(`node decay batch transaction took ${batchDurationMs}ms`);
    yield batchDurationMs > 10 ? 'node_slow' : 'node';
  }

  // --- 链接衰减（赫布学习）---
  // 连接强度取决于两端的共同激活频率
  const linkDecayBase = getParam('metabolism-params', 'link_decay_base', 0.03);
  const linkDeleteThreshold = getParam('metabolism-params', 'link_delete_threshold', 0.05);
  let linkDecayed = 0;
  let linkDeleted = 0;

  // 链接按清册分批，但每批必须按事务内current row重算。不能在yield前读取
  // strength/relation/status后再写回，否则会覆盖前台编辑。清册只决定“本轮最多
  // 看哪些id”；每批WHERE与computed都重新检查当前状态，新建链接留到下个周期。
  // 这把20k links的百毫秒级单writer事务拆成短事务，同时保持并发安全。
  if (testHooks?.beforeFirstLinkBatch) testHooks.beforeFirstLinkBatch();
  const LINK_BATCH_SIZE = 200;
  const linkIds = db.prepare(
    "SELECT id FROM links WHERE status = 'confirmed' AND deleted = 0 ORDER BY id",
  ).all() as Array<{ id: string }>;
  const updateLinkBatch = db.prepare(`
      WITH computed AS MATERIALIZED (
        SELECT l.id,
          l.strength <= @threshold AS should_purge,
          CASE
            WHEN l.strength > @threshold
              AND NOT (
                json_valid(l.relation) = 1
                AND json_type(l.relation) = 'array'
                AND EXISTS (
                  SELECT 1 FROM json_each(l.relation) AS relation_item
                  WHERE CASE
                    WHEN relation_item.type = 'object'
                    THEN json_extract(relation_item.value, '$.type') = 'tagged'
                    ELSE 0
                  END
                )
              )
            THEN MIN(1.0, l.strength * (1 - @base * (1 - SQRT(
              COALESCE(a.heat, 0) * COALESCE(b.heat, 0)
            ))))
            ELSE NULL
          END AS next_strength
        FROM links l
        LEFT JOIN nodes a ON a.id = l.from_id
        LEFT JOIN nodes b ON b.id = l.to_id
        WHERE l.id IN (SELECT value FROM json_each(@ids))
          AND l.status = 'confirmed' AND l.deleted = 0
      )
      UPDATE links
      SET strength = CASE
            WHEN computed.should_purge OR computed.next_strength <= @threshold THEN links.strength
            ELSE computed.next_strength
          END,
          deleted = CASE
            WHEN computed.should_purge OR computed.next_strength <= @threshold THEN 1
            ELSE 0
          END,
          edit_seq = edit_seq + CASE
            WHEN computed.should_purge OR computed.next_strength <= @threshold THEN 1
            ELSE 0
          END,
          updated = @ts
      FROM computed
      WHERE links.id = computed.id
        AND (computed.should_purge OR computed.next_strength IS NOT NULL)
      RETURNING deleted
  `);
  for (let index = 0; index < linkIds.length; index += LINK_BATCH_SIZE) {
    const inventoryIds = JSON.stringify(linkIds.slice(index, index + LINK_BATCH_SIZE).map(row => row.id));
    const batchStartedAt = Date.now();
    db.transaction(() => {
      // purge与decay必须在同一current-row批次里完成。否则尚未处理的
      // link在前一批yield后被前台降到threshold时，会同时错过旧purge清册
      // 和decay的strength>threshold谓词，残留到下一个cadence。
      // 单条UPDATE在同一SQLite snapshot中按current strength分流，既保留低强度
      // tagged link也应被purge的旧语义，又避免每批两次UPDATE的锁内往返。
      const changed = updateLinkBatch.all({
        ids: inventoryIds,
        base: linkDecayBase,
        threshold: linkDeleteThreshold,
        ts: now(),
      }) as Array<{ deleted: number }>;
      for (const row of changed) {
        if (row.deleted === 1) linkDeleted++;
        else linkDecayed++;
      }
    }).immediate();
    const batchDurationMs = testHooks?.linkBatchDurationMs?.() ?? (Date.now() - batchStartedAt);
    if (batchDurationMs > 50) log.warn(`link decay batch transaction took ${batchDurationMs}ms`);
    yield batchDurationMs > 10 ? 'link_slow' : 'link';
  }

  if (decayed > 0 || linkDecayed > 0) {
    db.transaction(() => {
      testHooks?.beforeTimelineEvent?.();
      logTimelineEvent(db, {
        type: 'memory',
        subtype: 'synaptic_scaling',
        title: JSON.stringify({ key: 'synaptic_decayed', params: { nodes: decayed, links: linkDecayed } }),
        detail: { decayed, linkDecayed, linkDeleted },
        important: 0,
      });
    })();
  }

  log.info(`衰减 ${decayed} 节点, 链接衰减 ${linkDecayed} 条, 删除 ${linkDeleted} 条`);

  return { decayed };
}

/**
 * 保留原同步 API，供不承载 Electron UI 的调用方和既有测试使用。
 */
export function runSynapticScaling(db: Database.Database): { decayed: number } {
  const batches = runSynapticScalingBatches(db);
  let step = batches.next();
  while (!step.done) step = batches.next();
  return step.value;
}

const yieldToImmediate = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * scheduler 使用的协作式入口。节点和链接都在current-row短事务批次后
 * 让出事件循环；链接不复用yield前读取的strength/relation快照。
 */
export async function runSynapticScalingCooperatively(
  db: Database.Database,
  yieldBetweenBatches: () => Promise<void> = yieldToImmediate,
  options?: {
    beforeFirstLinkBatch?: () => void;
    beforeTimelineEvent?: () => void;
    nodeBatchDurationMs?: () => number;
    linkBatchDurationMs?: () => number;
    pauseForFairness?: (delayMs: number) => Promise<void>;
    shouldPauseForFairness?: () => boolean;
  },
): Promise<{ decayed: number }> {
  const batches = runSynapticScalingBatches(db, options);
  let committedEffectBatch = false;
  let batchesSinceFairnessPause = 0;
  const BATCHES_PER_FAIRNESS_PAUSE = 5;
  const NORMAL_FAIRNESS_PAUSE_MS = 2;
  const SLOW_FAIRNESS_PAUSE_MS = 5;
  const pauseForFairness = options?.pauseForFairness
    ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  const shouldPauseForFairness = options?.shouldPauseForFairness ?? (() => true);
  try {
    let step = batches.next();
    while (!step.done) {
      // Reaching a yield means the generator has committed one node or link batch.
      committedEffectBatch = true;
      // The transaction has ended before this cooperative yield. setImmediate
      // keeps Worker throughput high, while a bounded timer pause after a slow
      // batch or every five normal 200-row batches gives a foreground SQLite
      // waiter an OS scheduling window and prevents this Worker from repeatedly
      // reacquiring the write lock. This must cover nodes as well as links: the
      // node phase otherwise forms one uninterrupted cross-process lock convoy
      // before link fairness begins. Five normal batches keep that
      // convoy below the frozen foreground p99 budget. Doubling the old batch
      // size halves transaction/yield overhead, so covering both phases keeps
      // the normal timer budget below the old link-only cadence; a slow batch
      // still gets a 5ms recovery window.
      await yieldBetweenBatches();
      const slowBatch = step.value === 'node_slow' || step.value === 'link_slow';
      if (!shouldPauseForFairness()) {
        // A later focus transition starts a fresh bounded window; background
        // work must not carry an almost-full counter into foreground mode.
        batchesSinceFairnessPause = 0;
      } else if (slowBatch || ++batchesSinceFairnessPause === BATCHES_PER_FAIRNESS_PAUSE) {
        batchesSinceFairnessPause = 0;
        await pauseForFairness(slowBatch
          ? SLOW_FAIRNESS_PAUSE_MS
          : NORMAL_FAIRNESS_PAUSE_MS);
      }
      step = batches.next();
    }
    return step.value;
  } catch (error) {
    if (committedEffectBatch) throw new SynapticPartialEffectError(error);
    throw error;
  }
}


// claimMaintenance 已移除 — 调度职责 2026-03-31 迁移到 scheduler.ts::tryClaimTask,
// 新统一 key 是 `last_task_{id}` (毫秒数字字符串),而非 `last_{daily|weekly}_maintenance`
// (ISO 字符串)。旧函数保留半年后确认无 caller,且格式与 scheduler 冲突
// (scheduler 用 CAST(value AS INTEGER) 对比, ISO 字符串 CAST 得到前导数字,
// 导致 needsWeeklyMaintenance 等读方恒误判),故 2026-04-21 彻底删除。
// 需要新任务的并发声明请直接用 scheduler.ts::tryClaimTask。
