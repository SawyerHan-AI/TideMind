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

  const failures = values.has(CB_FAILURES_KEY) ? parseInt(values.get(CB_FAILURES_KEY)!, 10) : 0;
  const openedAt = values.has(CB_OPENED_AT_KEY) ? parseInt(values.get(CB_OPENED_AT_KEY)!, 10) : 0;
  const cooldownMs = values.has(CB_COOLDOWN_KEY)
    ? parseInt(values.get(CB_COOLDOWN_KEY)!, 10)
    : CIRCUIT_COOLDOWN_INITIAL;

  if (failures < CIRCUIT_FAILURE_THRESHOLD) {
    return { state: 'closed', failures, cooldownMs };
  }

  // 熔断中 — 检查冷却是否到期
  const elapsed = Date.now() - openedAt;
  if (elapsed >= cooldownMs) {
    return { state: 'half-open', failures, cooldownMs };
  }

  return { state: 'open', failures, cooldownMs };
}

function recordLLMSuccess(db: Database.Database): void {
  // 成功 → 重置所有熔断状态
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '0')").run(CB_FAILURES_KEY);
  db.prepare('DELETE FROM metadata WHERE key IN (?, ?)').run(CB_OPENED_AT_KEY, CB_COOLDOWN_KEY);
}

function recordLLMFailure(db: Database.Database): void {
  const { failures, cooldownMs } = getCircuitState(db);
  const newFailures = failures + 1;
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(CB_FAILURES_KEY, String(newFailures));

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

  if (circuit.state === 'open') {
    const remaining = Math.round(
      (parseInt(
        (db.prepare('SELECT value FROM metadata WHERE key = ?').get(CB_OPENED_AT_KEY) as any)?.value ?? '0', 10,
      ) + circuit.cooldownMs - Date.now()) / 60_000,
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

      // LLM 任务成功 → 重置熔断器
      //
      // 注意两种需要区分的情况：
      //   a) half-open：之前真的 open 过，冷却到期后放一个探测任务，此次成功 → 真正从"开启"转回"关闭"
      //      应该发 circuit_breaker_off 时间线事件 + info 日志。
      //   b) closed but failures > 0：累计了 1-2 次失败但没达到阈值（即从未 open 过），
      //      之后一次成功就清零计数即可。静默重置，不发事件——否则时间线会出现孤立的
      //      "熔断器关闭" 事件而没有对应的"开启"事件，造成噪音。
      if (task.requiresLLM) {
        if (circuit.state === 'half-open') {
          recordLLMSuccess(db);
          log.info('LLM 熔断器已关闭（服务恢复）');
          logTimelineEvent(db, {
            type: 'config',
            subtype: 'settings_change',
            title: JSON.stringify({ key: 'circuit_breaker_off' }),
          });
        } else if (circuit.failures > 0) {
          recordLLMSuccess(db); // 静默重置累计失败计数
        }
        halfOpenProbed = true;
      }
    } catch (err) {
      // 失败回滚：恢复时间戳，下次 tick 可重试
      rollbackClaim(db, task.id, claim.priorValue);
      log.error(`任务 ${task.id} 失败（已回滚）:`, (err as Error).message);

      // LLM 服务错误 → 标记不可用 + 熔断计数
      if (task.requiresLLM && err instanceof LLMServiceError) {
        llmAvailable = false;
        recordLLMFailure(db);
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

/** 看门狗：tick 持续超过此时长视为卡死，强制复位 flag */
const MAINTENANCE_WATCHDOG_MS = 30 * 60 * 1000; // 30 分钟

/**
 * 在 prepare 调用时触发一轮调度。
 * 非阻塞：fire-and-forget。
 *
 * 健壮性约束：
 * 1. runSchedulerTick 同步抛错（如 getCircuitState 的 SQL 失败）也必须复位
 *    flag，否则 .catch().finally() 永不执行，整个进程后续 tick 全部空转。
 * 2. 异步链卡死时（>30 分钟）由看门狗强制复位，避免任何路径漏复位。
 */
export function maybeRunMaintenance(
  db: Database.Database,
  tasks: TaskDefinition[],
): void {
  // 看门狗：如果上一次 tick 已经"运行"超过阈值，强制视为卡死并复位
  if (maintenanceRunning && tickStartedAt > 0) {
    const elapsed = Date.now() - tickStartedAt;
    if (elapsed > MAINTENANCE_WATCHDOG_MS) {
      log.error(
        `maintenance tick 卡死 ${Math.round(elapsed / 60000)} 分钟，强制复位 flag`,
      );
      maintenanceRunning = false;
      tickStartedAt = 0;
    }
  }

  if (maintenanceRunning) return;

  maintenanceRunning = true;
  tickStartedAt = Date.now();

  try {
    const p = runSchedulerTick(db, tasks);
    if (p && typeof (p as Promise<unknown>).then === 'function') {
      (p as Promise<unknown>)
        .catch(err => log.error('maintenance tick failed:', (err as Error).message))
        .finally(() => {
          maintenanceRunning = false;
          tickStartedAt = 0;
        });
    } else {
      // 同步返回（理论上不会发生，但兜底）
      maintenanceRunning = false;
      tickStartedAt = 0;
    }
  } catch (err) {
    // 同步抛错（如 SQL prepare 失败）→ Promise 没有产生，必须立刻复位
    log.error('maintenance tick sync throw:', (err as Error).message);
    maintenanceRunning = false;
    tickStartedAt = 0;
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
