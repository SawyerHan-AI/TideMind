/**
 * 任务调度注册表
 *
 * 每个代谢任务独立调度，不再按 daily/weekly 桶分组。
 * 每个任务从自己的策略文件读取 interval_minutes 和门控阈值，
 * 支持独立配置和热更新。
 */

import type Database from 'better-sqlite3';
import { getParam } from '../strategy/loader.js';
import { getNodeCount } from '../db/nodes.js';
import { getLinkCount } from '../db/links.js';
import { getRecallCount } from '../db/log.js';
import { logTimelineEvent } from '../db/log.js';
import { LLMServiceError } from '../llm/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scheduler');

// ============================================================
// 类型定义
// ============================================================

export interface TaskDefinition {
  /** 任务唯一标识，也用于 metadata 表中的 last_task_{id} */
  id: string;
  /** 执行函数 */
  execute: (db: Database.Database) => Promise<void>;
  /** 从哪个策略文件读取 interval_minutes */
  intervalStrategy: string;
  /** 策略文件中的参数名（默认 'interval_minutes'） */
  intervalKey?: string;
  /** 默认间隔（分钟） */
  defaultIntervalMinutes: number;
  /** 可选的门控检查，返回 false 则跳过 */
  gateCheck?: (db: Database.Database) => boolean;
  /** 是否需要 LLM 调用。LLM 不可用时跳过此任务。默认 false */
  requiresLLM?: boolean;
  /**
   * 是否需要 embedding 调用 (B-3, 2026-05-21)。
   * Embedding 熔断器 open 状态下跳过此任务,避免持续浪费 quota / 在已知失败的
   * provider 上累积错误。Embedding 跟 LLM 是独立熔断器(可能 LLM 还能用、
   * embedding 挂了,反之亦然),独立判定。
   * 默认 false。digest-retry / link-discover 等真正在调用路径里触发 getEmbedding
   * 的任务标 true。
   */
  requiresEmbedding?: boolean;
}

export interface TaskStatus {
  id: string;
  lastRun: number | null;
  intervalMinutes: number;
  nextRunAfter: number | null;
  gatesMet: boolean;
}

// ============================================================
// 原子声明任务执行权（Compare-And-Swap）+ 失败回滚
// ============================================================

export interface ClaimResult {
  claimed: boolean;
  /** claim 前的旧时间戳值，用于失败回滚。null 表示首次运行。 */
  priorValue: string | null;
}

/**
 * 毫秒时间戳下界：2020-01-01 00:00:00 UTC。
 *
 * 用于校验 metadata.value 是否为合法的毫秒时间戳字符串。
 * 若 value 被其他路径（旧迁移、云端同步、手工写入）写成 ISO 字符串如
 * '2025-01-01T00:00:00Z'，SQLite `CAST(value AS REAL)` 会截断前导数字得到
 * 2025，恒小于 `Date.now() - interval`（约 1.7e12），导致每次 tick 都被
 * "立即"认领而重复执行。
 */
const MIN_VALID_TIMESTAMP_MS = 1577836800000;

/**
 * 严格校验 value 是否为合法的毫秒时间戳字符串。
 * 要求：非空、纯数字（避免被 CAST 截断的 ISO 字符串）、数值 >= 下界。
 */
function isValidTimestampString(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= MIN_VALID_TIMESTAMP_MS;
}

/**
 * 原子声明某个任务的执行权。
 *
 * 用 SQLite 的 `INSERT ... ON CONFLICT DO UPDATE` 单语句完成 compare-and-swap:
 *   - 行不存在 → INSERT 新行(首次运行)
 *   - 行存在且 value 是合法毫秒时间戳、且早于 threshold → UPDATE 为 now
 *   - 行存在但 value 格式不合法(ISO 字符串等)或未到 interval → WHERE 不匹配,
 *     不改写原值
 * 然后用 RETURNING 拿到"声明前的旧值",用于失败回滚;用 `changes()` 判断是否
 * 真的改写了 metadata。
 *
 * 相比旧实现(先 SELECT、再 UPDATE、UPDATE changes=0 且行不存在时 INSERT,
 * 用 try/catch 吞 UNIQUE 冲突):
 *   - 消除 TOCTOU 竞态: 多进程并发 claim 同一任务时不再有"输家 DELETE
 *     掉赢家刚插入记录"的风险(旧代码 rollbackClaim 对 priorValue=null 会
 *     DELETE FROM metadata WHERE key = ?,会连带把赢家的 claim 抹掉)。
 *   - 原子性由单条 SQL 语句保证。
 *
 * 格式校验仍然保留: 若 value 已存在但不是合法毫秒时间戳字符串,
 * ON CONFLICT 的 WHERE 子句不匹配 → UPDATE 失败,此时 RETURNING 返回 0 行,
 * `changes() === 0`,claim 失败;原值不变,由调用方在下一 tick 重新评估
 * (写入方负责把格式修正回来)。
 */
export function tryClaimTask(
  db: Database.Database,
  taskId: string,
  intervalMinutes: number,
): ClaimResult {
  const key = `last_task_${taskId}`;
  const nowMs = Date.now();
  const intervalMs = intervalMinutes * 60 * 1000;
  const threshold = nowMs - intervalMs;
  const nowStr = nowMs.toString();
  const thresholdStr = threshold.toString();

  // 先查旧值,用于: (a) 回滚时恢复; (b) 失败时返回给调用方记录/告警。
  // 注意: 这里读到的 priorValue 仅用于"失败回滚/日志",不参与 claim 决策;
  // 决策完全由下面的 ON CONFLICT DO UPDATE WHERE 子句做,无 TOCTOU 风险。
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  const priorValue = row?.value ?? null;

  // 行存在但格式不合法 → 记一次 warn,然后让 SQL 自己处理(WHERE 会拒绝更新)。
  // 单独打 log 保留向后观察性;不走任何 JS 侧分支决策。
  if (row && !isValidTimestampString(row.value)) {
    log.warn(
      `tryClaimTask: metadata[${key}] 的 value 不是合法毫秒时间戳 ("${row.value}"),跳过本次 claim 以避免重复执行`,
    );
    return { claimed: false, priorValue };
  }

  // 原子 CAS:
  //   - 首次运行(无冲突) → INSERT
  //   - 已有行且 value 是纯数字(glob '[0-9]*' 且 NOT glob '*[^0-9]*')且早于
  //     threshold → UPDATE
  //   - 其他情况 → WHERE 不匹配,不改写
  // 用 typeof(value)='text' + GLOB 两层校验排除 ISO 字符串: CAST('2025-...'
  // AS REAL) 会截断得到 2025,若只靠数值比较会恒满足 `< threshold`。GLOB
  // 过滤掉任何含非数字字符的 value。
  const result = db
    .prepare(
      `INSERT INTO metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE metadata.value GLOB '[0-9]*'
         AND metadata.value NOT GLOB '*[^0-9]*'
         AND CAST(metadata.value AS INTEGER) < ?`,
    )
    .run(key, nowStr, thresholdStr);

  // changes() = 1 表示 INSERT 了新行 或 UPDATE 命中了 WHERE → claim 成功。
  // changes() = 0 表示冲突时 WHERE 不匹配(未到 interval / 格式不合法 / 并发
  // 落败) → claim 失败,不改写原值。
  if (result.changes === 1) {
    return { claimed: true, priorValue };
  }

  return { claimed: false, priorValue };
}

/**
 * 任务执行失败时回滚 claim，恢复到执行前的时间戳。
 * 这样下一次 tick 就能重新尝试执行。
 */
export function rollbackClaim(
  db: Database.Database,
  taskId: string,
  priorValue: string | null,
): void {
  const key = `last_task_${taskId}`;
  if (priorValue === null) {
    // 首次运行失败，删掉刚插入的行
    db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
  } else {
    db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(priorValue, key);
  }
}

// ============================================================
// LLM 熔断器（Circuit Breaker）
// ============================================================

type CircuitState = 'closed' | 'open' | 'half-open';

const CIRCUIT_FAILURE_THRESHOLD = 3;       // 连续失败 N 次触发熔断
const CIRCUIT_COOLDOWN_INITIAL = 5 * 60_000;  // 初始冷却 5 分钟
const CIRCUIT_COOLDOWN_MAX = 2 * 60 * 60_000; // 最大冷却 2 小时

// metadata keys
const CB_FAILURES_KEY = 'circuit_breaker_failures';
const CB_OPENED_AT_KEY = 'circuit_breaker_opened_at';
const CB_COOLDOWN_KEY = 'circuit_breaker_cooldown_ms';

export function getCircuitState(db: Database.Database): {
  state: CircuitState;
  failures: number;
  cooldownMs: number;
  openedAt: number; // epoch ms,0 表示未开启过;UI 用 openedAt + cooldownMs 算剩余
} {
  // 三个 CB_* key 一次性读出:原先三次独立 SELECT 之间 recordLLMFailure
  // 可能并发写入,导致 failures / openedAt / cooldownMs 看到"半更新"的
  // 不一致状态(例如 failures 已经翻到阈值之上,但 openedAt 还是 0,
  // 判成 elapsed=now,然后 half-open 被误触发 —— 每次 SQL 调度都多放
  // 一个 LLM 探测)。better-sqlite3 单语句 SELECT 天然原子,
  // 改成一次 IN 查询 + 内存组装,消除读窗口。
  const rows = db
    .prepare(
      `SELECT key, value FROM metadata WHERE key IN (?, ?, ?)`,
    )
    .all(CB_FAILURES_KEY, CB_OPENED_AT_KEY, CB_COOLDOWN_KEY) as Array<{
      key: string;
      value: string;
    }>;

  const values = new Map<string, string>();
  for (const r of rows) values.set(r.key, r.value);

  // 修复 F4(2026-05-21): parseInt 解析 corrupt metadata.value(如手工写入 / 旧迁移残留)
  // 会返回 NaN。NaN 参与的所有比较都返回 false:
  //   - failures < CIRCUIT_FAILURE_THRESHOLD → false → 不走 'closed' 分支
  //   - elapsed >= cooldownMs(elapsed = now - NaN = NaN) → false → 不走 'half-open'
  // 结果熔断器永久卡在 'open',无法恢复。
  // 用 Number.isFinite 兜底:任何无效值视为 0(熔断器关闭、最近无失败)。
  let failures = values.has(CB_FAILURES_KEY) ? parseInt(values.get(CB_FAILURES_KEY)!, 10) : 0;
  if (!Number.isFinite(failures)) failures = 0;
  let openedAt = values.has(CB_OPENED_AT_KEY) ? parseInt(values.get(CB_OPENED_AT_KEY)!, 10) : 0;
  if (!Number.isFinite(openedAt)) openedAt = 0;
  let cooldownMs = values.has(CB_COOLDOWN_KEY)
    ? parseInt(values.get(CB_COOLDOWN_KEY)!, 10)
    : CIRCUIT_COOLDOWN_INITIAL;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) cooldownMs = CIRCUIT_COOLDOWN_INITIAL;

  if (failures < CIRCUIT_FAILURE_THRESHOLD) {
    return { state: 'closed', failures, cooldownMs, openedAt };
  }

  // 熔断中 — 检查冷却是否到期
  const elapsed = Date.now() - openedAt;
  if (elapsed >= cooldownMs) {
    return { state: 'half-open', failures, cooldownMs, openedAt };
  }

  return { state: 'open', failures, cooldownMs, openedAt };
}

/**
 * 强制重置熔断器状态(用户在 UI 上"立即重试"或修改 connection 凭据后调用)。
 *
 * 跟 noteSuccessfulLLMCall 的差别:
 *   - noteSuccessfulLLMCall = LLM 调用真的成功,清熔断 + 写 llm_last_success_at
 *   - resetCircuitBreaker = 用户主动重置(还没真的成功一次),只清熔断 + 触发
 *     health change event,不动 llm_last_success_at(因为上次成功时间没变)
 *
 * 注意:这只清 daemon 端的熔断状态。客户端 fetch 的 socket pool / SDK cache 不在
 * 这里清——如果是凭据变更场景,调用方应同时调 clearClientCache()(`src/llm/client.ts`)。
 */
export function resetCircuitBreaker(db: Database.Database): void {
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '0')").run(CB_FAILURES_KEY);
  db.prepare('DELETE FROM metadata WHERE key IN (?, ?)').run(CB_OPENED_AT_KEY, CB_COOLDOWN_KEY);
  log.info('LLM 熔断器已手动重置');
  logTimelineEvent(db, {
    type: 'config',
    subtype: 'settings_change',
    title: JSON.stringify({ key: 'circuit_breaker_manual_reset' }),
    important: 0,
  });
  emitHealthChange();
}

// 健康度信号 metadata key —— 供 UI 展示和 pending-link-gc 健康度门控使用
const LLM_LAST_SUCCESS_KEY = 'llm_last_success_at';
const LLM_LAST_ERROR_KEY = 'llm_last_error';
const LLM_LAST_ERROR_AT_KEY = 'llm_last_error_at';

// 健康状态变化时的回调（由 electron 主进程在启动时注册，core 层不直接依赖 electron）
type HealthChangeListener = () => void;
let healthChangeListener: HealthChangeListener | null = null;
export function setHealthChangeListener(listener: HealthChangeListener | null): void {
  healthChangeListener = listener;
}
function emitHealthChange(): void {
  if (!healthChangeListener) return;
  try { healthChangeListener(); } catch (err) {
    log.warn(`health-change listener threw: ${(err as Error).message}`);
  }
}

function recordLLMSuccess(db: Database.Database): void {
  // 成功 → 重置所有熔断状态 + 刷新成功时间戳
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '0')").run(CB_FAILURES_KEY);
  db.prepare('DELETE FROM metadata WHERE key IN (?, ?)').run(CB_OPENED_AT_KEY, CB_COOLDOWN_KEY);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    .run(LLM_LAST_SUCCESS_KEY, String(Date.now()));
  emitHealthChange();
}

/**
 * 修复 F8(2026-05-21): 跟踪本 tick 是否"真的"进过 callLLM(成功或失败)。
 *
 * 旧代码在 task.execute 正常 return 后无条件设 halfOpenProbed=true。但很多
 * requiresLLM=true 的 task 在 no candidate / claim 失败 / 内部 early-return
 * 时根本没进 callLLM,这种"零开销 return"也消耗了半开探测名额,
 * 接下来同 tick 真正需要探测的 task 反而被 skip。
 *
 * 新做法:noteSuccessfulLLMCall / notifyLLMFailure 触发时,scheduler 通过这个
 * 模块级 flag 知道"本 tick 真的有 LLM 调用发生过"。runSchedulerTick 启动时清零,
 * 任务结束后按这个 flag 而不是无条件 set halfOpenProbed。
 *
 * 跨 tick / 跨进程安全:整个 daemon 同步串行 runSchedulerTick,不存在并发 tick;
 * 即便有,最坏情况是相邻 tick 共享 flag,影响仅是"少放一次探测",安全。
 */
let llmCallObservedInTick = false;
export function __resetLLMCallObservedFlag(): void { llmCallObservedInTick = false; }
export function __getLLMCallObservedFlag(): boolean { return llmCallObservedInTick; }
function markLLMCallObserved(): void { llmCallObservedInTick = true; }

/**
 * 真实 LLM 调用成功时由 callLLM hook 触发(2026-05-20 Audit A-1/A-2 修复)。
 *
 * 之前 scheduler 在 task.execute() 正常 return 后无条件调 recordLLMSuccess,
 * 但 digest-retry / annotate / link-evaluate 等任务在 LLM 没配 / 没工作 / 内部
 * 吞 LLMServiceError 时也会正常 return → scheduler 写"健康"信号 → 整个 LLM
 * resilience 防御被绕过。
 *
 * 新流程:
 *   1. daemon.ts 在启动时把 () => noteSuccessfulLLMCall(db) 注入到 callLLM 的
 *      success hook
 *   2. 只有真的拿到 2xx response 才写 llm_last_success_at + 重置熔断器
 *   3. half-open → closed 的 transition 也在这里处理,避免和 scheduler 的探测
 *      逻辑两边都写但语义不一致
 *
 * 副作用:同一个 scheduler tick 中,若 task 内部多次 callLLM(annotate 按节点
 * 循环),每次成功都会触发 hook → 每次都 reset 熔断器。幂等,不是 bug。
 */
export function noteSuccessfulLLMCall(db: Database.Database): void {
  markLLMCallObserved(); // F8: 真实 LLM 调用发生 → 标记本 tick 已观察到

  // 修复 F14(2026-05-21): 把 getCircuitState + recordLLMSuccess + logTimelineEvent
  // 包到一个事务里,序列化并发竞争。
  //
  // 背景:LLM 内部 success hook 在每次 2xx 后被调一次。同一 tick 内 annotate 按
  // 节点串行 callLLM,但跨 tick + recall 路径的 fire-and-forget(reconsolidate /
  // link-revalidate)也会触发 hook。若两个调用几乎同时观察到 prevState='half-open',
  // 都会插一条 'circuit_breaker_off' timeline event,UI 看到两条相同事件。
  // 用 db.transaction 把"读状态 + 写状态 + 写事件"原子化,确保只有一个 caller 看到
  // half-open 然后插事件,其他 caller 看到 closed → 不重复插。
  db.transaction(() => {
    const prevState = getCircuitState(db).state;
    recordLLMSuccess(db);
    if (prevState === 'half-open') {
      log.info('LLM 熔断器已关闭（服务恢复）');
      logTimelineEvent(db, {
        type: 'config',
        subtype: 'settings_change',
        title: JSON.stringify({ key: 'circuit_breaker_off' }),
        // 修复(2026-05-20 Audit A-10):跟 circuit_breaker_on 对称设 important=1,
        // 避免用户看到"AI 暂停"红色重要事件后看不到"AI 恢复"的对应轻量事件。
        important: 1,
      });
    }
  })();
}

/**
 * 修复 F3(2026-05-21): 让 recall 路径上 fire-and-forget 的 LLM 失败也能累积熔断计数。
 *
 * 背景:link-revalidate / reconsolidate 在 recall 路径上 fire-and-forget 调用,
 * 内部 catch LLMServiceError 后 log.warn 就算了 — 它们抛出的错误在 recall.ts
 * 那层只是 log.warn,不会走 scheduler 的 recordLLMFailure。结果:LLM 长期挂掉
 * 时熔断器只能靠 scheduler 低频 task 累积失败,recall 路径完全绕过。
 *
 * 解法:暴露一个失败 hook,daemon 启动时绑到 recordLLMFailure。
 * link-revalidate / reconsolidate / 其他 fire-and-forget 路径在 catch
 * LLMServiceError 时调 notifyLLMFailure(err),熔断器照样累积。
 */
let llmFailureHook: ((err: LLMServiceError) => void) | null = null;
export function setLLMFailureHook(hook: typeof llmFailureHook): void {
  llmFailureHook = hook;
}
export function notifyLLMFailure(err: LLMServiceError): void {
  markLLMCallObserved(); // F8: 真实 LLM 调用发生(并失败)→ 标记本 tick 已观察到
  if (llmFailureHook) {
    try { llmFailureHook(err); } catch (hookErr) {
      log.warn(`llmFailureHook threw: ${(hookErr as Error).message}`);
    }
  }
}

/**
 * 把 recordLLMFailure 导出给 hook 注入使用。
 * 仅供 daemon 启动时 setLLMFailureHook 注入。
 */
export function recordLLMFailureForHook(db: Database.Database, errMessage?: string): void {
  recordLLMFailure(db, errMessage);
}

function recordLLMFailure(db: Database.Database, errMessage?: string): void {
  const { failures, cooldownMs } = getCircuitState(db);
  const newFailures = failures + 1;
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(CB_FAILURES_KEY, String(newFailures));

  if (errMessage) {
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
      .run(LLM_LAST_ERROR_KEY, errMessage.slice(0, 500));
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
      .run(LLM_LAST_ERROR_AT_KEY, String(Date.now()));
  }

  if (newFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    // 打开熔断器
    const newCooldown = failures >= CIRCUIT_FAILURE_THRESHOLD
      ? Math.min(cooldownMs * 2, CIRCUIT_COOLDOWN_MAX) // 已经开过，翻倍
      : CIRCUIT_COOLDOWN_INITIAL;                       // 首次开启
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(CB_OPENED_AT_KEY, String(Date.now()));
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(CB_COOLDOWN_KEY, String(newCooldown));

    const cooldownMin = Math.round(newCooldown / 60_000);
    log.warn(`LLM 熔断器开启: 连续 ${newFailures} 次失败，冷却 ${cooldownMin} 分钟`);

    logTimelineEvent(db, {
      type: 'config',
      subtype: 'settings_change',
      title: JSON.stringify({ key: 'circuit_breaker_on', params: { minutes: cooldownMin } }),
      detail: { failures: newFailures, cooldownMinutes: cooldownMin },
      important: 1,
    });
  }
  emitHealthChange();
}

// ============================================================
// Embedding 熔断器（独立于 LLM, B-3 2026-05-21）
// ============================================================
//
// 为何独立于 LLM 熔断器:embedding provider 和 LLM provider 可以是不同账户 / 不
// 同 API key / 不同 quota,LLM 全挂时 embedding 可能还能工作(反之亦然)。
// 共享一个熔断器会把两条路径的失败混在一起,quota 一边耗光时另一边也被一刀
// 切,误伤。
//
// 阈值 / 冷却跟 LLM 一致(3 失败开,5 分钟初始 / 翻倍到 2 小时上限),保持
// 用户能预测的"什么时候会重试"。
const EB_FAILURES_KEY = 'embedding_circuit_failures';
const EB_OPENED_AT_KEY = 'embedding_circuit_opened_at';
const EB_COOLDOWN_KEY = 'embedding_circuit_cooldown_ms';
const EMBEDDING_LAST_SUCCESS_KEY = 'embedding_last_success_at';
const EMBEDDING_LAST_ERROR_KEY = 'embedding_last_error';
const EMBEDDING_LAST_ERROR_AT_KEY = 'embedding_last_error_at';

export function getEmbeddingCircuitState(db: Database.Database): {
  state: CircuitState;
  failures: number;
  cooldownMs: number;
} {
  // 单次 IN 查询,跟 getCircuitState 同样原因(避免半更新窗口)。
  const rows = db
    .prepare(
      `SELECT key, value FROM metadata WHERE key IN (?, ?, ?)`,
    )
    .all(EB_FAILURES_KEY, EB_OPENED_AT_KEY, EB_COOLDOWN_KEY) as Array<{
      key: string;
      value: string;
    }>;

  const values = new Map<string, string>();
  for (const r of rows) values.set(r.key, r.value);

  // 容错 corrupt metadata.value(parseInt 返回 NaN 会导致比较恒 false,
  // 卡死在 'open' 不恢复)— 跟 LLM 熔断器对齐处理。
  let failures = values.has(EB_FAILURES_KEY) ? parseInt(values.get(EB_FAILURES_KEY)!, 10) : 0;
  if (!Number.isFinite(failures)) failures = 0;
  let openedAt = values.has(EB_OPENED_AT_KEY) ? parseInt(values.get(EB_OPENED_AT_KEY)!, 10) : 0;
  if (!Number.isFinite(openedAt)) openedAt = 0;
  let cooldownMs = values.has(EB_COOLDOWN_KEY)
    ? parseInt(values.get(EB_COOLDOWN_KEY)!, 10)
    : CIRCUIT_COOLDOWN_INITIAL;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) cooldownMs = CIRCUIT_COOLDOWN_INITIAL;

  if (failures < CIRCUIT_FAILURE_THRESHOLD) {
    return { state: 'closed', failures, cooldownMs };
  }

  const elapsed = Date.now() - openedAt;
  if (elapsed >= cooldownMs) {
    return { state: 'half-open', failures, cooldownMs };
  }

  return { state: 'open', failures, cooldownMs };
}

/**
 * Embedding 调用成功 → 重置失败计数器 + 关闭熔断器(若开)。
 * 由 daemon.ts setEmbeddingSuccessHook 注入 db,在 getEmbedding 拿到 valid vector
 * 时被调到。
 */
export function recordEmbeddingSuccess(db: Database.Database): void {
  db.transaction(() => {
    const prevState = getEmbeddingCircuitState(db).state;
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '0')").run(EB_FAILURES_KEY);
    db.prepare('DELETE FROM metadata WHERE key IN (?, ?)').run(EB_OPENED_AT_KEY, EB_COOLDOWN_KEY);
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
      .run(EMBEDDING_LAST_SUCCESS_KEY, String(Date.now()));
    if (prevState === 'half-open') {
      log.info('Embedding 熔断器已关闭（服务恢复）');
      logTimelineEvent(db, {
        type: 'config',
        subtype: 'settings_change',
        title: JSON.stringify({ key: 'embedding_circuit_breaker_off' }),
        important: 1,
      });
    }
  })();
  emitHealthChange();
}

/**
 * Embedding 调用失败 → 累积失败,阈值后打开熔断器。
 * 由 daemon.ts setEmbeddingFailureHook 注入 db handle。
 */
export function recordEmbeddingFailure(db: Database.Database, errMessage?: string): void {
  const { failures, cooldownMs } = getEmbeddingCircuitState(db);
  const newFailures = failures + 1;
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(EB_FAILURES_KEY, String(newFailures));

  if (errMessage) {
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
      .run(EMBEDDING_LAST_ERROR_KEY, errMessage.slice(0, 500));
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
      .run(EMBEDDING_LAST_ERROR_AT_KEY, String(Date.now()));
  }

  if (newFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    const newCooldown = failures >= CIRCUIT_FAILURE_THRESHOLD
      ? Math.min(cooldownMs * 2, CIRCUIT_COOLDOWN_MAX)
      : CIRCUIT_COOLDOWN_INITIAL;
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(EB_OPENED_AT_KEY, String(Date.now()));
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(EB_COOLDOWN_KEY, String(newCooldown));

    const cooldownMin = Math.round(newCooldown / 60_000);
    log.warn(`Embedding 熔断器开启: 连续 ${newFailures} 次失败,冷却 ${cooldownMin} 分钟`);

    logTimelineEvent(db, {
      type: 'config',
      subtype: 'settings_change',
      title: JSON.stringify({ key: 'embedding_circuit_breaker_on', params: { minutes: cooldownMin } }),
      detail: { failures: newFailures, cooldownMinutes: cooldownMin },
      important: 1,
    });
  }
  emitHealthChange();
}

// ============================================================
// 调度逻辑
// ============================================================

/** 从策略文件读取任务间隔（分钟），支持热更新 */
export function getTaskInterval(task: TaskDefinition): number {
  const key = task.intervalKey ?? 'interval_minutes';
  return getParam(task.intervalStrategy, key, task.defaultIntervalMinutes);
}

/**
 * 执行一轮调度：检查所有任务，依次执行到期的。
 * 串行执行避免并发 LLM 调用过多。
 * 任务执行失败时回滚 claim，允许下次 tick 重试。
 *
 * LLM 保护机制：
 * - 熔断器打开时跳过所有 requiresLLM 任务
 * - 半开状态只放行第一个 LLM 任务作为探测
 * - 任何 LLM 服务错误立即标记本 tick 剩余 LLM 任务为跳过
 */
export async function runSchedulerTick(
  db: Database.Database,
  tasks: TaskDefinition[],
): Promise<string[]> {
  const executed: string[] = [];

  // 本地/云代谢互斥: 用户开启 cloud.metabolism_enabled 后,服务端 worker 接管
  // 所有代谢任务,本地 scheduler 停跑以避免双端跑同样策略导致数据抖动。
  // 注: 即便本地停跑,WebSocket 仍会从云端推回代谢结果,本地 UI 数据始终最新。
  try {
    const { getConfig } = await import('../config.js');
    const config = getConfig();
    if (config.cloud?.metabolism_enabled) {
      log.debug('本地代谢已暂停 — cloud.metabolism_enabled=true,服务端接管');
      return executed;
    }
  } catch { /* 配置读取失败 → 保持本地代谢行为,安全兜底 */ }

  let circuit = getCircuitState(db);
  let llmAvailable = circuit.state !== 'open';
  let halfOpenProbed = false; // 半开状态是否已放行一个探测任务
  // 修复 F8(2026-05-21): tick 开始时清零"是否观察到真实 LLM 调用"flag。
  // noteSuccessfulLLMCall / notifyLLMFailure 触发时会把它置 true。
  // 只有真的发生过 LLM 调用,halfOpenProbed 才设 true。
  __resetLLMCallObservedFlag();

  if (circuit.state === 'open') {
    const openedAt = db.prepare('SELECT value FROM metadata WHERE key = ?').get(CB_OPENED_AT_KEY) as { value: string } | undefined;
    const remaining = Math.round(
      (parseInt(openedAt?.value ?? '0', 10) + circuit.cooldownMs - Date.now()) / 60_000,
    );
    log.debug(`LLM 熔断器开启中，跳过 LLM 任务（剩余 ~${Math.max(0, remaining)} 分钟）`);
  }

  for (const task of tasks) {
    // 每轮重新读取熔断状态:成功的 LLM 探测会把 half-open 转为 closed(recordLLMSuccess
    // 清零计数),之前的本地 circuit 快照还停留在 half-open,halfOpenProbed=true 会把
    // 后续所有 LLM 任务全都 skip 掉。一次 SELECT 很便宜,换正确性值得。
    if (task.requiresLLM) {
      circuit = getCircuitState(db);
      llmAvailable = circuit.state !== 'open';
    }

    // LLM 任务保护
    if (task.requiresLLM) {
      if (!llmAvailable) continue;
      if (circuit.state === 'half-open' && halfOpenProbed) continue; // 半开只放一个
    }

    // B-3 (2026-05-21): Embedding 任务保护 — 独立判定,跟 LLM 互不影响。
    // embedding 熔断器 open 时直接 skip,half-open 时第一个进来的任务作为探测
    // 走一次(没有 halfOpenProbed 标记机制,因为 getEmbedding 成功 hook 会立刻
    // 把熔断器关掉,下个 task 重读 state 已经是 closed)。
    if (task.requiresEmbedding) {
      const embCircuit = getEmbeddingCircuitState(db);
      if (embCircuit.state === 'open') {
        log.debug(`embedding 熔断器 open,跳过任务: ${task.id}`);
        continue;
      }
    }

    // 门控检查（便宜操作先做）
    if (task.gateCheck && !task.gateCheck(db)) continue;

    const interval = getTaskInterval(task);
    const claim = tryClaimTask(db, task.id, interval);
    if (!claim.claimed) continue;

    try {
      log.info(`执行任务: ${task.id}`);
      await task.execute(db);
      executed.push(task.id);
      log.info(`任务完成: ${task.id}`);

      // 修复(2026-05-20 Audit A-1/A-2):**不再**在这里调 recordLLMSuccess。
      // 原实现 unconditionally 写"健康"信号 + 重置熔断器,但 task.execute 正常
      // return 不代表 LLM 真的被调用且成功(digest-retry 吞 LLMServiceError /
      // annotate 在 no candidate 时早 return / etc.)。
      //
      // 新流程:src/llm/client.ts callLLM 拿到 2xx 时主动通过 LLMSuccessHook 调
      // noteSuccessfulLLMCall(db),只对真实成功响应记录健康度。
      // half-open → closed 的 transition 事件也搬到 noteSuccessfulLLMCall 里。
      //
      // 修复 F8(2026-05-21): halfOpenProbed 不再无条件 set。
      // 仅当 task 内部真的触发过 callLLM(noteSuccessfulLLMCall / notifyLLMFailure
      // 任一被调到)才认为已消耗本 tick 的探测名额。这样 digest-retry / claim
      // 失败 / no-candidate 等 zero-LLM 路径不再误吃名额。
      if (task.requiresLLM && __getLLMCallObservedFlag()) {
        halfOpenProbed = true;
      }
    } catch (err) {
      // 失败回滚：恢复时间戳，下次 tick 可重试
      rollbackClaim(db, task.id, claim.priorValue);

      // 区分程序员错误（TypeError / ReferenceError / SyntaxError）和业务错误：
      //  - 程序员错误 = 我们代码的 bug，下一 tick 同样会撞，需要 visibility
      //    提升供运维 grep 'programmer bug' 触发告警；
      //  - 这里只 log.error 标记，不 throw（throw 会冒到 scheduler tick 顶层，
      //    可能让 daemon 自杀；保持 daemon 不中断、靠 log 告警是更稳的妥协）。
      if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
        log.error(
          `programmer bug in task ${task.id}: ${(err as Error).stack ?? (err as Error).message}`,
        );
      } else {
        log.error(`任务 ${task.id} 失败（已回滚）:`, (err as Error).message);
      }

      // LLM 服务错误 → 标记不可用 + 熔断计数
      if (task.requiresLLM && err instanceof LLMServiceError) {
        llmAvailable = false;
        recordLLMFailure(db, (err as Error).message);
        halfOpenProbed = true;
        log.warn(`LLM 服务错误，跳过本 tick 剩余 LLM 任务`);
      }
    }
  }

  return executed;
}

// ============================================================
// 门控辅助函数
// ============================================================

/** 节点数量门控 */
export function makeNodeCountGate(strategyName: string, defaultMin: number) {
  return (db: Database.Database): boolean => {
    const minNodes = getParam(strategyName, 'gate_min_nodes', defaultMin);
    return getNodeCount(db, false) >= minNodes;
  };
}

/** 节点+链接数量门控 */
export function makeNodeAndLinkGate(
  strategyName: string,
  defaultMinNodes: number,
  defaultMinLinks: number,
) {
  return (db: Database.Database): boolean => {
    const minNodes = getParam(strategyName, 'gate_min_nodes', defaultMinNodes);
    const minLinks = getParam(strategyName, 'gate_min_links', defaultMinLinks);
    return getNodeCount(db, false) >= minNodes && getLinkCount(db) >= minLinks;
  };
}

/** 节点+recall 数量门控 */
export function makeNodeAndRecallGate(
  strategyName: string,
  defaultMinNodes: number,
  defaultMinRecalls: number,
) {
  return (db: Database.Database): boolean => {
    const minNodes = getParam(strategyName, 'gate_min_nodes', defaultMinNodes);
    const minRecalls = getParam(strategyName, 'gate_min_recall_ops', defaultMinRecalls);
    return getNodeCount(db, false) >= minNodes && getRecallCount(db) >= minRecalls;
  };
}

// ============================================================
// 搭便车调度（从 prepare 调用触发）
// ============================================================

let maintenanceRunning = false;
let tickStartedAt: number = 0;
// tickId 单调递增,与每次启动的 tick 关联;watchdog 强制复位时 currentTickId
// 自增,旧 promise 的 .finally 通过自带 myTickId 比对发现已不是当前 tick → 不
// 再覆盖新 tick 的状态。修复 M11(2026-05-09):历史 watchdog 直接置
// `maintenanceRunning=false`,旧 promise 仍在跑,新 tick 立即起跑;旧
// promise.finally 又把 maintenanceRunning 抹回 false,等于把第二个 tick 的
// watchdog 抹掉,第三个 tick 与第二个并发执行。
let currentTickId = 0;

/** 看门狗：tick 持续超过此时长视为卡死，强制复位 flag */
const MAINTENANCE_WATCHDOG_MS = 30 * 60 * 1000; // 30 分钟

/**
 * 判断当前 tick 是否应被看门狗强制复位。
 *
 * Why: maintenanceRunning + tickStartedAt 是模块级状态,直接测难。把判定提取为
 * 纯函数后可单测:任意时刻已运行超过阈值 → true。
 * How to apply: maybeRunMaintenance 调用时用 (Date.now(), tickStartedAt, threshold)。
 */
export function shouldResetWatchdog(now: number, tickStartedAt: number, thresholdMs: number = MAINTENANCE_WATCHDOG_MS): boolean {
  if (tickStartedAt <= 0) return false;
  return (now - tickStartedAt) > thresholdMs;
}

/**
 * 在 prepare 调用时触发一轮调度。
 * 非阻塞：fire-and-forget。
 *
 * 健壮性约束：
 * 1. runSchedulerTick 同步抛错（如 getCircuitState 的 SQL 失败）也必须复位
 *    flag，否则 .catch().finally() 永不执行，整个进程后续 tick 全部空转。
 * 2. 异步链卡死时（>30 分钟）由看门狗强制复位，避免任何路径漏复位。
 * 3. 旧/新 tick 通过 tickId 比对配对,旧 promise.finally 不会误清新 tick 状态。
 */
export function maybeRunMaintenance(
  db: Database.Database,
  tasks: TaskDefinition[],
): void {
  // 看门狗：如果上一次 tick 已经"运行"超过阈值，强制视为卡死并复位
  if (maintenanceRunning && shouldResetWatchdog(Date.now(), tickStartedAt)) {
    const elapsed = Date.now() - tickStartedAt;
    log.error(
      `maintenance tick 卡死 ${Math.round(elapsed / 60000)} 分钟，强制复位 flag`,
    );
    maintenanceRunning = false;
    tickStartedAt = 0;
    currentTickId++; // 让卡死那轮 tick 的 finally 失去状态写权
  }

  if (maintenanceRunning) return;

  maintenanceRunning = true;
  tickStartedAt = Date.now();
  const myTickId = ++currentTickId;

  try {
    runSchedulerTick(db, tasks)
      .catch(err => log.error('maintenance tick failed:', (err as Error).message))
      .finally(() => {
        // 只在自己仍是当前 tick 时清理状态。watchdog 复位 + 自增 currentTickId
        // 后,卡死那轮的 finally 进入此分支时 myTickId !== currentTickId 直接 noop。
        if (myTickId === currentTickId) {
          maintenanceRunning = false;
          tickStartedAt = 0;
        }
      });
  } catch (err) {
    // 同步抛错（如 SQL prepare 失败）→ Promise 没有产生，必须立刻复位
    log.error('maintenance tick sync throw:', (err as Error).message);
    if (myTickId === currentTickId) {
      maintenanceRunning = false;
      tickStartedAt = 0;
    }
  }
}

// ============================================================
// 查询任务状态（供前端展示）
// ============================================================

export function getTaskStatuses(
  db: Database.Database,
  tasks: TaskDefinition[],
): TaskStatus[] {
  return tasks.map(task => {
    const key = `last_task_${task.id}`;
    const row = db.prepare(
      'SELECT value FROM metadata WHERE key = ?',
    ).get(key) as { value: string } | undefined;

    const lastRun = row ? Number(row.value) : null;
    const interval = getTaskInterval(task);
    const nextRunAfter = lastRun ? lastRun + interval * 60 * 1000 : null;
    const gatesMet = task.gateCheck ? task.gateCheck(db) : true;

    return { id: task.id, lastRun, intervalMinutes: interval, nextRunAfter, gatesMet };
  });
}
