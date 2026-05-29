import type Database from 'better-sqlite3';
import { logParamFeedback } from '../db/log.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('feedback-signals');

/**
 * 信号类型 → 策略参数映射
 *
 * 每种信号影响哪些策略的哪些参数。Learning II 根据这个映射
 * 决定当某种信号趋势下降时，应该调整哪个参数。
 */
export const SIGNAL_PARAM_MAP: Record<string, Array<{ strategy: string; params: string[] }>> = {
  link_survival: [
    { strategy: 'digest-extract', params: ['landing_link_threshold', 'landing_link_top_k'] },
    { strategy: 'link-evaluate', params: ['lookback_hours', 'max_links_per_run', 'pending_expire_days'] },
    { strategy: 'link-discover', params: ['vector_similarity_threshold', 'min_shared_neighbors'] },
    { strategy: 'metabolism-params', params: ['link_decay_base', 'link_delete_threshold'] },
  ],
  recall_hit: [
    { strategy: 'recall-rank', params: ['alpha', 'beta', 'gamma', 'delta'] },
    { strategy: 'recall-rank', params: ['heat_weight', 'refinement_weight', 'connectivity_weight', 'independence_weight'] },
  ],
  correction: [
    { strategy: 'annotate', params: ['batch_size', 'neighbor_count', 'frequent_tags_limit'] },
  ],
  node_awakening: [
    { strategy: 'metabolism-params', params: ['decay_base', 'decay_damping'] },
  ],
  session_continuity: [
    { strategy: 'recall-rank', params: ['alpha', 'beta', 'gamma', 'delta'] },
    { strategy: 'prepare-assemble', params: ['max_index_standard', 'profile_max_tokens'] },
  ],
};

// ── 回溯式信号采集（在 Learning II 周期任务中调用）──────────────

/**
 * 链接健康度：7-14 天前创建的 auto 链接，当前平均强度如何？
 *
 * 已删除的链接不在表中，无法直接统计存活率。改用剩余链接的
 * 平均强度作为代理指标：
 * - 初始强度 0.5，衰减后存活说明两端都活跃（赫布学习）
 * - 平均强度高 → 链接质量好；低 → 很多链接快被删了
 *
 * 同时通过对比相邻时间窗口的链接数量估算淘汰率：
 * - 14-21 天前创建的 auto 链接数 vs 7-14 天前创建的
 * - 如果旧窗口数量显著少于新窗口，说明衰减删掉了很多
 */
export function collectLinkSurvival(db: Database.Database): void {
  // 当前窗口：7-14 天前创建的 auto 链接
  const current = db.prepare(`
    SELECT COUNT(*) as cnt, AVG(strength) as avg_strength
    FROM links
    WHERE auto = 1
      AND created BETWEEN datetime('now', '-14 days') AND datetime('now', '-7 days')
  `).get() as { cnt: number; avg_strength: number | null };

  if (current.cnt < 5) return;

  // 旧窗口：14-21 天前创建的 auto 链接（用于估算淘汰率）
  const older = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM links
    WHERE auto = 1
      AND created BETWEEN datetime('now', '-21 days') AND datetime('now', '-14 days')
  `).get() as { cnt: number };

  const avgStrength = current.avg_strength ?? 0.5;
  // 强度信号：初始 0.5，衰减到 0.05 删除。以 0.3 为基准
  const strengthSignal = (avgStrength - 0.3) * (1 / 0.2); // 0.3→0, 0.5→1.0, 0.1→-1.0

  // 淘汰率信号：如果旧窗口链接数量远少于新窗口，说明删了很多
  let attritionSignal = 0;
  if (current.cnt > 0 && older.cnt > 0) {
    const survivalRatio = older.cnt / current.cnt; // <1 说明旧的被删了
    attritionSignal = (survivalRatio - 0.5) * 2; // 0.5→0, 1.0→1.0, 0→-1.0
  }

  // 综合信号：强度权重 0.6 + 淘汰率权重 0.4
  const signal = Math.max(-1, Math.min(1, strengthSignal * 0.6 + attritionSignal * 0.4));

  for (const mapping of SIGNAL_PARAM_MAP.link_survival) {
    logParamFeedback(db, {
      strategy_name: mapping.strategy,
      signal_type: 'link_survival',
      signal_value: signal,
      context: JSON.stringify({
        current_count: current.cnt, avg_strength: avgStrength,
        older_count: older.cnt, strength_signal: strengthSignal, attrition_signal: attritionSignal,
      }),
    });
  }

  log.info(`链接健康度: ${current.cnt}条, 平均强度=${avgStrength.toFixed(3)}, 旧窗口=${older.cnt}条`);
}

/**
 * Recall 命中率：30-60 天前创建的节点，有多少被 recall 命中过？
 *
 * 不能用 heat > 1.0 判断——30 天衰减后 heat 远低于 1.0，即使被 bump 过也会降回。
 * 改为直接查 operation_log：recall 操作的 output_node_ids 是否包含该节点 ID。
 */
export function collectRecallHitRate(db: Database.Database): void {
  // 获取 30-60 天前创建的非 meta 节点
  const targetNodes = db.prepare(`
    SELECT id FROM nodes
    WHERE is_meta = 0 AND is_superseded = 0 AND archived = 0
      AND created BETWEEN datetime('now', '-60 days') AND datetime('now', '-30 days')
  `).all() as Array<{ id: string }>;

  if (targetNodes.length < 10) return;

  // 统计被 recall 命中过的节点数（output_node_ids 是 JSON 数组字符串）
  // 使用 JSON 精确引用匹配 "nodeId" 避免子串误匹配（如 "abc" 匹配到 "xabcy"）
  let hitCount = 0;
  for (const node of targetNodes) {
    const hit = db.prepare(`
      SELECT 1 FROM operation_log
      WHERE operation = 'recall'
        AND output_node_ids LIKE ?
      LIMIT 1
    `).get(`%"${node.id}"%`) as unknown;
    if (hit) hitCount++;
  }

  const hitRate = hitCount / targetNodes.length;
  // 命中率 0.3 为基准
  const signal = Math.max(-1, Math.min(1, (hitRate - 0.3) * (1 / 0.7)));

  for (const mapping of SIGNAL_PARAM_MAP.recall_hit) {
    logParamFeedback(db, {
      strategy_name: mapping.strategy,
      signal_type: 'recall_hit',
      signal_value: signal,
      context: JSON.stringify({ total: targetNodes.length, hit: hitCount, rate: hitRate }),
    });
  }

  log.info(`Recall 命中率: ${hitCount}/${targetNodes.length} = ${(hitRate * 100).toFixed(1)}%`);
}

/**
 * Correction 率：最近 30 天内，correction 操作占总 digest 的比例
 * correction 越多 → 标注质量越差 → 负向信号
 */
export function collectCorrectionRate(db: Database.Database): void {
  const result = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN input_summary LIKE 'correction%' THEN 1 ELSE 0 END) as corrections
    FROM operation_log
    WHERE operation = 'digest'
      AND created > datetime('now', '-30 days')
  `).get() as { total: number; corrections: number };

  if (result.total < 10) return;

  const correctionRate = result.corrections / result.total;
  // correction 率越低越好，0.05 为基准
  // 0% → +1.0, 5% → 0, 15%+ → -1.0
  const signal = Math.max(-1, Math.min(1, (0.05 - correctionRate) * 20));

  for (const mapping of SIGNAL_PARAM_MAP.correction) {
    logParamFeedback(db, {
      strategy_name: mapping.strategy,
      signal_type: 'correction',
      signal_value: signal,
      context: JSON.stringify({ total: result.total, corrections: result.corrections, rate: correctionRate }),
    });
  }

  log.info(`Correction 率: ${result.corrections}/${result.total} = ${(correctionRate * 100).toFixed(1)}%`);
}

/**
 * Session 连续性：recall 后同 session 30 分钟内是否有 digest
 * 有 → 说明 recall 返回了有用信息，用户基于它继续对话
 */
export function collectSessionContinuity(db: Database.Database): void {
  const totalRecalls = db.prepare(`
    SELECT COUNT(*) as cnt FROM operation_log
    WHERE operation = 'recall' AND session IS NOT NULL
      AND created > datetime('now', '-30 days')
  `).get() as { cnt: number };

  if (totalRecalls.cnt < 10) return;

  // 注意：datetime() 输出格式 'YYYY-MM-DD HH:MM:SS' 与存储的 ISO 格式
  // 'YYYY-MM-DDTHH:MM:SS.sssZ' 不兼容，用 julianday 做时间差比较
  const followedByDigest = db.prepare(`
    SELECT COUNT(DISTINCT r.id) as cnt
    FROM operation_log r
    WHERE r.operation = 'recall' AND r.session IS NOT NULL
      AND r.created > datetime('now', '-30 days')
      AND EXISTS (
        SELECT 1 FROM operation_log d
        WHERE d.operation = 'digest'
          AND d.session = r.session
          AND julianday(d.created) > julianday(r.created)
          AND julianday(d.created) - julianday(r.created) <= 30.0 / (24.0 * 60.0)
      )
  `).get() as { cnt: number };

  const continuityRate = followedByDigest.cnt / totalRecalls.cnt;
  // 0.4 为基准
  const signal = Math.max(-1, Math.min(1, (continuityRate - 0.4) * (1 / 0.6)));

  for (const mapping of SIGNAL_PARAM_MAP.session_continuity) {
    logParamFeedback(db, {
      strategy_name: mapping.strategy,
      signal_type: 'session_continuity',
      signal_value: signal,
      context: JSON.stringify({ total: totalRecalls.cnt, followed: followedByDigest.cnt, rate: continuityRate }),
    });
  }

  log.info(`Session 连续性: ${followedByDigest.cnt}/${totalRecalls.cnt} = ${(continuityRate * 100).toFixed(1)}%`);
}

/**
 * 运行全部回溯式信号采集
 */
export function collectAllSignals(db: Database.Database): void {
  try { collectLinkSurvival(db); } catch (e) { log.error('链接存活率采集失败:', (e as Error).message); }
  try { collectRecallHitRate(db); } catch (e) { log.error('Recall 命中率采集失败:', (e as Error).message); }
  try { collectCorrectionRate(db); } catch (e) { log.error('Correction 率采集失败:', (e as Error).message); }
  try { collectSessionContinuity(db); } catch (e) { log.error('Session 连续性采集失败:', (e as Error).message); }
}
