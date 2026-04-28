import type Database from 'better-sqlite3';
import { callLLM } from '../llm/client.js';
import { LEARNING3_SYSTEM } from '../llm/prompts.js';
import { getConfig, isLlmConfigured } from '../config.js';
import { getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { now } from '../utils/time.js';
import fs from 'node:fs';
import path from 'node:path';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';

const log = createLogger('learning3');

/**
 * Learning III — 框架重构
 *
 * 触发条件: 四个信号同时达到临界值
 * 1. 策略调整的边际收益递减
 * 2. 用户纠正的模式性
 * 3. recall 和实际使用的系统性偏差
 * 4. 新信息难以被图结构容纳
 *
 * 门控: Learning II 运行 3+ 月
 */

interface Signal {
  name: string;
  value: number;       // 0-1, higher = more critical
  description: string;
  evidence: string[];
}

interface DiagnosticReport {
  id: string;
  timestamp: string;
  signals: Signal[];
  overall_criticality: number;
  diagnosis: string;
  recommendations: Array<{
    type: 'low_risk' | 'high_risk';
    description: string;
    affected_strategies: string[];
  }>;
  status: 'pending' | 'applied' | 'dismissed';
}

interface EvolutionLogEntry {
  timestamp?: string;
  action?: string;
}

/**
 * Check if Learning III can be activated
 * Requires Learning II to have been running for 3+ months
 */
export function canRunLearning3(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT value FROM metadata WHERE key = 'last_learning2_run'"
  ).get() as { value: string } | undefined;

  if (!row) return false;

  // Check if Learning II has been running for 3+ months
  const firstL2Run = db.prepare(
    "SELECT value FROM metadata WHERE key = 'first_learning2_run'"
  ).get() as { value: string } | undefined;

  if (!firstL2Run) {
    // Record first run
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('first_learning2_run', ?)"
    ).run(row.value);
    return false;
  }

  const monthsSinceFirst = (Date.now() - new Date(firstL2Run.value).getTime()) / (30 * 24 * 60 * 60 * 1000);
  return monthsSinceFirst >= 3;
}

/**
 * Compute the four trigger signals
 */
export function computeSignals(db: Database.Database): Signal[] {
  const signals: Signal[] = [];

  const safePush = (fn: () => Signal) => {
    try { signals.push(fn()); } catch (e) {
      log.warn(`Signal computation failed: ${(e as Error).message}`);
    }
  };

  // Signal 1: Diminishing returns of strategy adjustments
  safePush(() => computeDiminishingReturns(db));

  // Signal 2: Systematic user corrections
  safePush(() => computeCorrectionPatterns(db));

  // Signal 3: Recall-usage mismatch
  safePush(() => computeRecallUsageMismatch(db));

  // Signal 4: New info doesn't fit graph structure
  safePush(() => computeGraphAccommodation(db));

  return signals;
}

function computeDiminishingReturns(_db: Database.Database): Signal {
  // Check evolution-log.jsonl for recent strategy changes and their impact
  const config = getConfig();
  const logPath = path.join(config.general.data_dir, 'strategies', 'evolution-log.jsonl');

  const evidence: string[] = [];
  let value = 0;

  if (fs.existsSync(logPath)) {
    try {
      // 只读取文件最后 2000 行，避免长期运行后 OOM
      const rawLines = fs.readFileSync(logPath, 'utf-8').split('\n');
      const tailLines = rawLines.length > 2000 ? rawLines.slice(-2000) : rawLines;
      const entries = tailLines
        .filter(Boolean)
        .map((line): EvolutionLogEntry | null => {
          try {
            const parsed = JSON.parse(line) as unknown;
            return parsed && typeof parsed === 'object' ? parsed as EvolutionLogEntry : null;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is EvolutionLogEntry => entry !== null);

      // Learning II 使用参数级调整 (param_adjusted / param_rolled_back / param_confirmed),
      // 不再使用旧的 variant_accepted/variant_rejected。这里以 rolled_back 为"失败"、
      // confirmed 为"成功"来估算策略调整的边际收益。
      const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const recent = entries.filter(e => typeof e.timestamp === 'string' && e.timestamp > threeMonthsAgo);
      const accepted = recent.filter(e => e.action === 'param_confirmed').length;
      const rejected = recent.filter(e => e.action === 'param_rolled_back').length;
      const total = accepted + rejected;

      if (total > 0) {
        const rejectionRate = rejected / total;
        value = Math.min(1, rejectionRate); // High rejection = diminishing returns
        evidence.push(`最近3个月: ${accepted}个参数调整被确认, ${rejected}个被回滚`);
        if (rejectionRate > 0.7) {
          evidence.push('大部分策略调整没有带来改善——可能需要框架层面的变化');
        }
      }
    } catch (err) {
      log.error('进化日志解析失败:', (err as Error).message);
    }
  }

  return {
    name: '策略调整边际收益递减',
    value,
    description: 'Learning II 的微调越来越难带来改善',
    evidence,
  };
}

function computeCorrectionPatterns(db: Database.Database): Signal {
  // Check if corrections cluster on specific types or topics
  const corrections = db.prepare(`
    SELECT n.type, COUNT(*) as cnt
    FROM operation_log o
    JOIN nodes n ON n.id IN (
      SELECT value FROM json_each(o.output_node_ids)
    )
    WHERE o.operation = 'digest' AND o.input_summary LIKE 'correction%'
      AND o.output_node_ids IS NOT NULL
    GROUP BY n.type
    ORDER BY cnt DESC
    LIMIT 10
  `).all() as Array<{ type: string; cnt: number }>;

  let value = 0;
  const evidence: string[] = [];

  const totalCorrections = corrections.reduce((s, c) => s + c.cnt, 0);
  if (totalCorrections > 0 && corrections.length > 0) {
    // Check concentration: if top type/project has >50% of corrections
    const topConcentration = corrections[0].cnt / totalCorrections;
    value = Math.min(1, topConcentration);

    if (topConcentration > 0.5) {
      evidence.push(`${corrections[0].cnt}/${totalCorrections} 次纠正集中在 ${corrections[0].type} 类型`);
      evidence.push('纠正的模式性说明系统的分类框架可能有问题');
    }
  }

  return {
    name: '用户纠正的模式性',
    value,
    description: '纠正操作不是随机的，而是集中在某类节点上',
    evidence,
  };
}

function computeRecallUsageMismatch(db: Database.Database): Signal {
  // Check if recalled nodes are actually being used (followed by digest)
  const totalRecalls = db.prepare(
    "SELECT COUNT(*) as cnt FROM operation_log WHERE operation = 'recall'"
  ).get() as { cnt: number };

  const recallsThenDigest = db.prepare(`
    SELECT COUNT(*) as cnt FROM operation_log o1
    WHERE o1.operation = 'recall'
    AND EXISTS (
      SELECT 1 FROM operation_log o2
      WHERE o2.operation = 'digest'
      AND o2.session = o1.session
      AND o2.created > o1.created
    )
  `).get() as { cnt: number };

  let value = 0;
  const evidence: string[] = [];

  if (totalRecalls.cnt > 20) {
    const usageRate = recallsThenDigest.cnt / totalRecalls.cnt;
    // Low usage rate could indicate recall isn't returning useful results
    if (usageRate < 0.3) {
      value = Math.min(1, (0.3 - usageRate) / 0.3);
      evidence.push(`只有 ${(usageRate * 100).toFixed(0)}% 的 recall 后有对应的 digest`);
      evidence.push('可能说明检索返回的记忆与用户实际需求不匹配');
    }
  }

  return {
    name: 'recall 与使用的系统性偏差',
    value,
    description: '检索返回的信息经常不被使用',
    evidence,
  };
}

function computeGraphAccommodation(db: Database.Database): Signal {
  // Check if recent nodes have low connectivity (can't find their place in the graph)
  const recentNodes = db.prepare(`
    SELECT AVG(connectivity) as avg_conn, COUNT(*) as cnt
    FROM nodes
    WHERE heat > 0.01 AND is_meta = 0 AND is_superseded = 0
    AND created > datetime('now', '-30 days')
  `).get() as { avg_conn: number | null; cnt: number };

  const olderNodes = db.prepare(`
    SELECT AVG(connectivity) as avg_conn
    FROM nodes
    WHERE heat > 0.01 AND is_meta = 0 AND is_superseded = 0
    AND created <= datetime('now', '-30 days')
  `).get() as { avg_conn: number | null };

  let value = 0;
  const evidence: string[] = [];

  if (recentNodes.cnt > 10 && olderNodes.avg_conn !== null && recentNodes.avg_conn !== null) {
    // If recent nodes have much lower connectivity than older ones
    const ratio = olderNodes.avg_conn > 0
      ? recentNodes.avg_conn / olderNodes.avg_conn
      : 0;

    if (ratio < 0.5) {
      value = Math.min(1, (0.5 - ratio) / 0.5);
      evidence.push(`最近30天新节点平均连通度 ${recentNodes.avg_conn.toFixed(2)} vs 历史 ${olderNodes.avg_conn.toFixed(2)}`);
      evidence.push('新信息难以与现有知识网络建立联系——可能意味着用户关注点已重大转移');
    }
  }

  return {
    name: '新信息图结构容纳度',
    value,
    description: '新节点落在图的边缘，难以建立有意义的链接',
    evidence,
  };
}

/**
 * Run Learning III: generate diagnostic report
 * Only runs when multiple signals reach critical level
 */
export async function runLearning3(db: Database.Database): Promise<DiagnosticReport | null> {
  if (!canRunLearning3(db)) return null;

  const signals = computeSignals(db);

  // Multi-signal convergence: at least 2 signals above 0.5
  const criticalSignals = signals.filter(s => s.value > 0.5);
  if (criticalSignals.length < 2) return null;

  const overallCriticality = signals.reduce((s, sig) => s + sig.value, 0) / signals.length;

  // Generate diagnostic report using heavy LLM
  const config = getConfig();
  if (!isLlmConfigured()) return null;

  // Gather context for diagnosis
  const strategies = gatherStrategies(config.general.data_dir);
  const graphStats = gatherGraphStats(db);

  try {
    const signalsStr = signals.map(s => `- ${s.name}: ${s.value.toFixed(2)}\n  ${s.evidence.join('\n  ')}`).join('\n\n');
    const fallbackL3Prompt = `触发信号:\n${signalsStr}\n\n当前策略文件:\n${strategies}\n\n图统计:\n${graphStats}`;
    const diagnosis = await callLLM({
      system: getPrompt('evolution-learning3', LEARNING3_SYSTEM),
      prompt: renderUserPrompt('evolution-learning3', {
        signals: signalsStr,
        strategies,
        graph_stats: graphStats,
      }, fallbackL3Prompt),
      ...getLLMOptions('evolution-learning3'),
      maxTokens: 4096,
      operationName: 'learning3',
    });

    const parsed = parseLLMJson<{ diagnosis?: string; recommendations?: Array<{ type: 'low_risk' | 'high_risk'; description: string; affected_strategies: string[] }> }>(diagnosis);
    if (!parsed) return null;

    const report: DiagnosticReport = {
      id: `l3_${Date.now()}`,
      timestamp: now(),
      signals,
      overall_criticality: overallCriticality,
      diagnosis: parsed.diagnosis ?? '',
      recommendations: parsed.recommendations ?? [],
      status: 'pending',
    };

    // Save report
    try {
      const reportsDir = path.join(config.general.data_dir, 'strategies');
      fs.writeFileSync(
        path.join(reportsDir, `learning3-report-${report.id}.json`),
        JSON.stringify(report, null, 2),
      );

      // Record in metadata only if file write succeeded
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_learning3_run', ?)"
      ).run(now());

      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_learning3_report', ?)"
      ).run(report.id);
    } catch (writeErr) {
      log.error('Learning III 报告写入失败:', (writeErr as Error).message);
      return null;
    }

    logTimelineEvent(db, {
      type: 'evolution',
      subtype: 'learning3',
      title: JSON.stringify({ key: 'framework_diagnosed' }),
      detail: {
        signals: Object.fromEntries(signals.map(s => [s.name, s.value])),
        triggered: true,
        report_id: report.id,
        recommendations_count: report.recommendations.length,
      },
      important: 1,
    });

    return report;
  } catch (err) {
    log.error('Learning III 诊断失败:', (err as Error).message);
    return null;
  }
}

// --- Helper functions ---

function gatherStrategies(dataDir: string): string {
  const dir = path.join(dataDir, 'strategies');
  if (!fs.existsSync(dir)) return '(无策略文件)';

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      return `### ${f}\n${content.slice(0, 500)}...`;
    })
    .join('\n\n');
}

function gatherGraphStats(db: Database.Database): string {
  const stats: string[] = [];

  const nodesByType = db.prepare(
    "SELECT type, COUNT(*) as cnt FROM nodes WHERE heat > 0.01 AND is_superseded = 0 GROUP BY type"
  ).all() as Array<{ type: string; cnt: number }>;
  stats.push(`节点分布: ${nodesByType.map(t => `${t.type}=${t.cnt}`).join(', ')}`);

  const avgConnectivity = db.prepare(
    "SELECT AVG(connectivity) as avg FROM nodes WHERE heat > 0.01 AND is_superseded = 0"
  ).get() as { avg: number | null };
  stats.push(`平均连通度: ${(avgConnectivity.avg ?? 0).toFixed(3)}`);

  const dormantCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE heat <= 0.01"
  ).get() as { cnt: number };
  stats.push(`休眠节点（heat≤0.01）: ${dormantCount.cnt}`);

  return stats.join('\n');
}
