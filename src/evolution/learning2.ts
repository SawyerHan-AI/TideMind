import type Database from 'better-sqlite3';
import { callLLM } from '../llm/client.js';
import { LEARNING2_SYSTEM } from '../llm/prompts.js';
import { getGateStatus } from '../db/stats.js';
import { getParamFeedback, getParamFeedbackByRange, logTimelineEvent } from '../db/log.js';
import { getConfig } from '../config.js';
import { getParam, getPrompt, getLLMOptions, getStrategy, renderUserPrompt } from '../strategy/loader.js';
import { now } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';
import { collectAllSignals, SIGNAL_PARAM_MAP } from './feedback-signals.js';
import fs from 'node:fs';
import path from 'node:path';

const log = createLogger('learning2');

/** 进化系统自身不参与自动优化 */
const EVOLUTION_BLACKLIST = new Set(['evolution-learning2', 'evolution-learning3']);

/** 触发、LLM 相关参数不参与自动优化（只优化业务参数） */
const PARAM_BLACKLIST = new Set([
  'interval_minutes', 'lookback_hours', 'llm_tier', 'thinking', 'thinking_budget',
  'max_tokens', 'content_budget', 'max_content_per_node', 'model',
]);

// ── 进化日志 ──────────────────────────────────────────────────

interface EvolutionLogEntry {
  timestamp: string;
  strategy: string;
  action: 'param_adjusted' | 'param_rolled_back' | 'param_confirmed' | 'signals_collected';
  param_name?: string;
  old_value?: number;
  new_value?: number;
  reason: string;
  metrics?: Record<string, number>;
}

function appendEvolutionLog(logPath: string, entry: EvolutionLogEntry): void {
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ── 门控 ──────────────────────────────────────────────────────

export function canRunLearning2(db: Database.Database): boolean {
  const gates = getGateStatus(db);
  const config = getConfig();
  const minNodes = config.gates.learning_2_min_nodes ?? 500;
  const minRecallOps = config.gates.learning_2_min_recall_ops ?? 200;
  return gates.node_count >= minNodes && gates.recall_count >= minRecallOps;
}

// ── 主流程 ────────────────────────────────────────────────────

/**
 * Learning II — 参数趋势调优
 *
 * 机制：采集行为指标 → 分析趋势 → 单参数调整 → 监控回滚
 * 门控：500+ 节点 AND 200+ recall 记录
 */
export async function runLearning2(db: Database.Database): Promise<{
  signals_collected: boolean;
  adjustments: string[];
  rollbacks: string[];
  confirmations: string[];
}> {
  const result = { signals_collected: false, adjustments: [] as string[], rollbacks: [] as string[], confirmations: [] as string[] };

  if (!canRunLearning2(db)) {
    return result;
  }

  const config = getConfig();
  const dataDir = config.general.data_dir;
  const strategiesDir = path.join(dataDir, 'strategies');
  const evolutionLogPath = path.join(strategiesDir, 'evolution-log.jsonl');

  // 首次运行时清理旧 A/B 测试残留
  cleanupLegacyABTest(db, strategiesDir);

  // Step 1: 采集回溯式信号
  collectAllSignals(db);
  result.signals_collected = true;

  appendEvolutionLog(evolutionLogPath, {
    timestamp: now(),
    strategy: '*',
    action: 'signals_collected',
    reason: '回溯式信号采集完成',
  });

  // Step 2: 检查监控窗口到期的调整
  const { rollbacks, confirmations } = checkMonitoringWindows(db, strategiesDir, evolutionLogPath);
  result.rollbacks = rollbacks;
  result.confirmations = confirmations;

  // Step 3: 分析趋势并调整参数
  const cooldownDays = getParam('evolution-learning2', 'cooldown_days', 14);
  const minSamples = getParam('evolution-learning2', 'min_feedback_samples', 20);
  const trendThreshold = getParam('evolution-learning2', 'trend_decline_threshold', -0.1);
  const maxAdjustmentPct = getParam('evolution-learning2', 'max_adjustment_pct', 0.10);
  const monitoringDays = getParam('evolution-learning2', 'monitoring_days', 7);

  // 按信号类型分组分析
  for (const [signalType, mappings] of Object.entries(SIGNAL_PARAM_MAP)) {
    for (const { strategy, params } of mappings) {
      if (EVOLUTION_BLACKLIST.has(strategy)) continue;

      // 冷却期检查：该策略最近是否有调整
      const recentAdjustment = db.prepare(`
        SELECT created FROM param_adjustments
        WHERE strategy_name = ? AND status IN ('active', 'confirmed')
        ORDER BY created DESC LIMIT 1
      `).get(strategy) as { created: string } | undefined;

      if (recentAdjustment) {
        const daysSince = (Date.now() - new Date(recentAdjustment.created).getTime()) / (24 * 60 * 60 * 1000);
        if (daysSince < cooldownDays) continue;
      }

      // 获取 30 天反馈
      const feedback = getParamFeedback(db, strategy, signalType, 30);
      if (feedback.length < minSamples) continue;

      // 计算趋势：前 15 天 vs 后 15 天
      const midpoint = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      const earlyHalf = feedback.filter(f => f.created < midpoint);
      const lateHalf = feedback.filter(f => f.created >= midpoint);

      if (earlyHalf.length < 5 || lateHalf.length < 5) continue;

      const earlyAvg = earlyHalf.reduce((s, f) => s + f.signal_value, 0) / earlyHalf.length;
      const lateAvg = lateHalf.reduce((s, f) => s + f.signal_value, 0) / lateHalf.length;
      const trend = lateAvg - earlyAvg;

      // 只在明显下降时干预
      if (trend >= trendThreshold) continue;

      // 从可调参数中选一个（取第一个存在于策略文件中的）
      const strategyData = getStrategy(strategy);
      if (!strategyData) continue;

      const adjustableParam = params.find(p =>
        !PARAM_BLACKLIST.has(p) && typeof strategyData.params[p] === 'number'
      );
      if (!adjustableParam) continue;

      const currentValue = strategyData.params[adjustableParam] as number;

      // 调用 LLM 决定调整方向
      try {
        const fallbackL2Prompt = [
            `参数: ${adjustableParam}`,
            `当前值: ${currentValue}`,
            `所属策略: ${strategy}`,
            `信号类型: ${signalType}`,
            `趋势: 前15天平均=${earlyAvg.toFixed(3)}, 后15天平均=${lateAvg.toFixed(3)}, 变化=${trend.toFixed(3)}`,
            `样本量: ${feedback.length}（前半${earlyHalf.length}，后半${lateHalf.length}）`,
          ].join('\n');
        const llmResponse = await callLLM({
          system: getPrompt('evolution-learning2', LEARNING2_SYSTEM),
          prompt: renderUserPrompt('evolution-learning2', {
            param: adjustableParam,
            current_value: String(currentValue),
            strategy,
            signal_type: signalType,
            early_avg: earlyAvg.toFixed(3),
            late_avg: lateAvg.toFixed(3),
            trend: trend.toFixed(3),
            sample_count: String(feedback.length),
            early_half: String(earlyHalf.length),
            late_half: String(lateHalf.length),
          }, fallbackL2Prompt),
          ...getLLMOptions('evolution-learning2'),
          maxTokens: 256,
          operationName: 'learning2',
        });

        const parsed = parseLLMJson<{ direction: string; reason?: string }>(llmResponse);
        if (!parsed || parsed.direction === 'hold') continue;

        // 计算新值（±maxAdjustmentPct）
        const direction = parsed.direction === 'increase' ? 1 : -1;
        // 乘法调整；currentValue=0 时回退到绝对偏移 0.01
        const newValue = currentValue !== 0
          ? currentValue * (1 + direction * maxAdjustmentPct)
          : direction * 0.01;

        // 更新策略文件
        const updated = updateStrategyParam(strategiesDir, strategy, adjustableParam, newValue);
        if (!updated) continue;

        // 记录调整前的平均反馈作为 pre_avg
        const preAvg = feedback.reduce((s, f) => s + f.signal_value, 0) / feedback.length;

        // 原子写入：参数调整记录 + 策略版本
        db.transaction(() => {
          db.prepare(`
            INSERT INTO param_adjustments (strategy_name, param_name, signal_type, old_value, new_value, reason, status, pre_avg, monitoring_start, monitoring_end, created)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
          `).run(
            strategy, adjustableParam, signalType, currentValue, newValue,
            parsed.reason ?? `trend=${trend.toFixed(3)}`,
            preAvg,
            now(),
            new Date(Date.now() + monitoringDays * 24 * 60 * 60 * 1000).toISOString(),
            now(),
          );

          recordStrategyVersion(db, strategy, strategiesDir,
            `Learning II 参数调整: ${adjustableParam} ${currentValue} → ${newValue.toFixed(4)} (${parsed.reason})`
          );
        })();

        appendEvolutionLog(evolutionLogPath, {
          timestamp: now(),
          strategy,
          action: 'param_adjusted',
          param_name: adjustableParam,
          old_value: currentValue,
          new_value: newValue,
          reason: parsed.reason ?? '',
          metrics: { trend, earlyAvg, lateAvg, samples: feedback.length },
        });

        logTimelineEvent(db, {
          type: 'evolution',
          subtype: 'learning2',
          title: JSON.stringify({ key: 'param_adjusted', params: { strategy, param: adjustableParam } }),
          detail: {
            action: 'param_adjusted',
            strategy, param: adjustableParam,
            old_value: currentValue, new_value: newValue,
            trend, reason: parsed.reason,
          },
          important: 1,
        });

        result.adjustments.push(`${strategy}.${adjustableParam}: ${currentValue} → ${newValue.toFixed(4)}`);
        log.info(`参数调整: ${strategy}.${adjustableParam} ${currentValue} → ${newValue.toFixed(4)}`);

        // 每个信号类型每个策略最多调一个参数
        break;
      } catch (err) {
        log.error(`参数调整失败 (${strategy}.${adjustableParam}):`, (err as Error).message);
      }
    }
  }

  // 记录维护时间
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_learning2_run', ?)"
  ).run(now());

  return result;
}

// ── 监控窗口检查 ──────────────────────────────────────────────

/**
 * 检查到期的参数调整：确认或回滚
 */
export function checkMonitoringWindows(
  db: Database.Database,
  strategiesDir: string,
  evolutionLogPath: string,
): { rollbacks: string[]; confirmations: string[] } {
  const rollbacks: string[] = [];
  const confirmations: string[] = [];

  const expiredAdjustments = db.prepare(`
    SELECT * FROM param_adjustments
    WHERE status = 'active' AND monitoring_end < ?
  `).all(now()) as Array<{
    id: number; strategy_name: string; param_name: string; signal_type: string | null;
    old_value: number; new_value: number; reason: string;
    pre_avg: number; monitoring_start: string; monitoring_end: string;
  }>;

  for (const adj of expiredAdjustments) {
    // 历史数据里可能存在 signal_type 为 NULL 的调整记录。传 undefined 会让
    // getParamFeedbackByRange 退化成"不按 signal_type 过滤",post_avg 变成跨信号
    // 类型的平均,和基于单一信号算出来的 pre_avg 做阈值比较会导致跨类误判回滚/确认。
    // 保守处理:跳过并记录告警,让人工/后续重构决定怎么清理。
    if (!adj.signal_type) {
      log.warn(`跳过监控窗口检查: adj.id=${adj.id} ${adj.strategy_name}.${adj.param_name} signal_type 为 NULL`);
      continue;
    }

    // 获取监控窗口期间的同类型反馈（用精确时间范围，不用"最近 N 天"）
    const postFeedback = getParamFeedbackByRange(
      db, adj.strategy_name, adj.signal_type,
      adj.monitoring_start, adj.monitoring_end,
    );

    // 监控窗口数据不足时延长观察，不做判断
    if (postFeedback.length < 5) {
      // 延长监控窗口 7 天
      const extendedEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE param_adjustments SET monitoring_end = ? WHERE id = ?").run(extendedEnd, adj.id);
      log.info(`监控窗口数据不足 (${postFeedback.length}条)，延长 ${adj.strategy_name}.${adj.param_name}`);
      continue;
    }

    const postAvg = postFeedback.reduce((s, f) => s + f.signal_value, 0) / postFeedback.length;
    const preAvg = adj.pre_avg ?? postAvg; // pre_avg 缺失时以 postAvg 为基准（不触发回滚）

    if (postAvg < preAvg - 0.05) {
      // 调整后更差 → 回滚
      const rolled = updateStrategyParam(strategiesDir, adj.strategy_name, adj.param_name, adj.old_value);
      if (rolled) {
        db.transaction(() => {
          db.prepare(
            "UPDATE param_adjustments SET status = 'rolled_back', post_avg = ? WHERE id = ?"
          ).run(postAvg, adj.id);

          recordStrategyVersion(db, adj.strategy_name, strategiesDir,
            `Learning II 回滚: ${adj.param_name} ${adj.new_value} → ${adj.old_value} (post_avg=${postAvg.toFixed(3)} < pre_avg=${preAvg.toFixed(3)})`
          );
        })();

        appendEvolutionLog(evolutionLogPath, {
          timestamp: now(),
          strategy: adj.strategy_name,
          action: 'param_rolled_back',
          param_name: adj.param_name,
          old_value: adj.new_value,
          new_value: adj.old_value,
          reason: `post_avg=${postAvg.toFixed(3)} < pre_avg=${preAvg.toFixed(3)}`,
        });

        logTimelineEvent(db, {
          type: 'evolution',
          subtype: 'learning2',
          title: JSON.stringify({ key: 'param_rolled_back', params: { strategy: adj.strategy_name, param: adj.param_name } }),
          detail: { action: 'rolled_back', strategy: adj.strategy_name, param: adj.param_name, old_value: adj.new_value, new_value: adj.old_value },
          important: 1,
        });

        rollbacks.push(`${adj.strategy_name}.${adj.param_name}`);
        log.info(`参数回滚: ${adj.strategy_name}.${adj.param_name} ${adj.new_value} → ${adj.old_value}`);
      }
    } else {
      // 持平或更好 → 确认
      db.prepare(
        "UPDATE param_adjustments SET status = 'confirmed', post_avg = ? WHERE id = ?"
      ).run(postAvg, adj.id);

      appendEvolutionLog(evolutionLogPath, {
        timestamp: now(),
        strategy: adj.strategy_name,
        action: 'param_confirmed',
        param_name: adj.param_name,
        reason: `post_avg=${postAvg.toFixed(3)} >= pre_avg=${preAvg.toFixed(3)}`,
      });

      confirmations.push(`${adj.strategy_name}.${adj.param_name}`);
      log.info(`参数确认: ${adj.strategy_name}.${adj.param_name}`);
    }
  }

  return { rollbacks, confirmations };
}

// ── 策略文件参数更新 ──────────────────────────────────────────

/**
 * 原子写入文本文件:tmp 文件 fsync 落盘 → rename → 目录 fsync,
 * 保证 power-loss 后要么还是旧内容,要么是完整的新内容,不会半截。
 *
 * 为什么要显式 fsync:writeFileSync 只是走到 OS page cache,crash 时可能
 * 丢尾部。rename 也只是更新目录项,目录本身未 fsync 时崩溃后重启可能
 * 看不到新文件名。fsync 目录才能保证 rename 真的持久化。
 */
function atomicWriteFileSync(targetPath: string, content: string): void {
  const tmpPath = targetPath + '.tmp.' + Date.now();
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content, 0, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, targetPath);
  // 目录 fsync:确保 rename 元数据落盘。darwin/linux 支持对目录 fd fsync;
  // 某些平台会 EISDIR,这里静默忽略——最差情况下退化到"数据安全、目录项
  // 可能需要等自然刷盘",不至于因兼容性打断调用者。
  try {
    const dirFd = fs.openSync(path.dirname(targetPath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // ignore — fsync on dir not supported on this platform
  }
}


/**
 * 更新策略参数文件中的参数值
 * 优先写入 .params.md，回退写入 .md
 * 匹配 | paramName | oldValue | description | 格式
 */
function updateStrategyParam(
  strategiesDir: string,
  strategyName: string,
  paramName: string,
  newValue: number,
): boolean {
  // 格式化数值：整数保留整数，小数保留合理精度。
  // 注意 toFixed(4) 对极小值(如 0.00001234)会得到 "0.0000" → 去零后变 "0.0",
  // 相当于把参数静默截断为 0。这里检测这种情况,退回到 toPrecision 保留有效位。
  let formatted: string;
  if (Number.isInteger(newValue)) {
    formatted = String(newValue);
  } else {
    formatted = newValue.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
    if (formatted === '0.0' && newValue !== 0) {
      // toFixed(4) 精度不够，用 toPrecision(4) 保 4 位有效数字
      // 结果可能是 "1.234e-5" 这种科学计数法，param 表格格式兼容数字字面量
      formatted = newValue.toPrecision(4);
    }
  }

  // 匹配参数表行: | paramName | value | description |
  const escapedName = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(\\|\\s*${escapedName}\\s*\\|\\s*)[^|\\n]+(\\s*\\|)`,
  );

  // 优先写入 .params.md
  const paramsPath = path.join(strategiesDir, `${strategyName}.params.md`);
  if (fs.existsSync(paramsPath)) {
    let content = fs.readFileSync(paramsPath, 'utf-8');
    if (pattern.test(content)) {
      content = content.replace(pattern, `$1${formatted} $2`);
      atomicWriteFileSync(paramsPath, content);
      return true;
    }
  }

  // 回退到 .md（兼容未拆分的策略文件）
  const filePath = path.join(strategiesDir, `${strategyName}.md`);
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf-8');
  if (!pattern.test(content)) {
    log.warn(`参数 ${paramName} 在策略 ${strategyName} 中未找到`);
    return false;
  }

  content = content.replace(pattern, `$1${formatted} $2`);
  atomicWriteFileSync(filePath, content);
  return true;
}

// ── 版本记录 ──────────────────────────────────────────────────

function recordStrategyVersion(
  db: Database.Database,
  strategyName: string,
  strategiesDir: string,
  reason: string,
): void {
  try {
    // 优先记录 .params.md 的内容（参数变更通常在这里）
    const paramsPath = path.join(strategiesDir, `${strategyName}.params.md`);
    const mainPath = path.join(strategiesDir, `${strategyName}.md`);
    const filePath = fs.existsSync(paramsPath) ? paramsPath : mainPath;
    const content = fs.readFileSync(filePath, 'utf-8');

    const lastVersion = db.prepare(
      'SELECT MAX(version) as v FROM strategy_versions WHERE strategy_name = ?'
    ).get(strategyName) as { v: number | null } | undefined;
    const newVersion = (lastVersion?.v ?? 0) + 1;

    db.prepare(
      "INSERT INTO strategy_versions (strategy_name, version, content, change_reason, changed_by, created) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(strategyName, newVersion, content, reason, 'learning2');
  } catch (err) {
    log.error('策略版本记录失败:', (err as Error).message);
  }
}

// ── 旧 A/B 测试清理 ──────────────────────────────────────────

function cleanupLegacyABTest(db: Database.Database, strategiesDir: string): void {
  const cleaned = db.prepare(
    "SELECT value FROM metadata WHERE key = 'learning2_legacy_cleaned'"
  ).get() as { value: string } | undefined;

  if (cleaned) return;

  // 删除 learning2:variant:* metadata 键
  db.prepare("DELETE FROM metadata WHERE key LIKE 'learning2:variant:%'").run();

  // 删除 .variant-*.md 和 .backup-*.md 文件
  if (fs.existsSync(strategiesDir)) {
    for (const file of fs.readdirSync(strategiesDir)) {
      if (file.includes('.variant-') || file.includes('.backup-')) {
        try {
          fs.unlinkSync(path.join(strategiesDir, file));
          log.info(`清理旧文件: ${file}`);
        } catch { /* ignore */ }
      }
    }
  }

  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('learning2_legacy_cleaned', ?)"
  ).run(now());

  log.info('旧 A/B 测试残留清理完成');
}

