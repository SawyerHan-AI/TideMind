import type Database from 'better-sqlite3';
import type { BrainNode } from '../types.js';
import { getNode, updateNode } from '../db/nodes.js';
import { createLink, linkExists, getLinksForNode } from '../db/links.js';
import { isVecLoaded } from '../db/connection.js';
import { daysAgo, now } from '../utils/time.js';
import { getParam, renderUserPrompt } from '../strategy/loader.js';
import { inferLinkType } from '../llm/link-judge.js';
import { callLLM } from '../llm/client.js';
import { updateConnectivity, refreshMaturityScore } from '../graph/maturity.js';
import { RECONSOLIDATE_SYSTEM, reconsolidatePrompt } from '../llm/prompts.js';
import { isLlmConfigured } from '../config.js';
import { detectConflictSignals } from './conflict-heuristics.js';
import { getPrompt, getLLMOptions } from '../strategy/loader.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';
import { runRecallFollowup, type RecallFollowupItem, type RecallFollowupPlan } from './recall-followup-runner.js';
import type { RecallFollowupRow } from '../db/recall-followups.js';

const log = createLogger('reconsolidate');

/**
 * 读即写再巩固
 *
 * - 静默读：只加热（在 recall 中处理）
 * - 感知读：在无直接链接的相关结果间创建 pending 链接（recall 同步路径，无模型调用）
 * - 深度读：需要模型调用。recall 只把“这批节点 + 上下文”写入 recall_followups 队列，
 *   由调度器任务 reconsolidate 在长驻进程里消费；短命的 MCP 进程不再直接调模型。
 *
 * 深度读触发条件：
 * 1. 时间条件：version == 1 且超过阈值天数未再巩固
 * 2. 预测误差：上下文与节点内容存在冲突信号
 * 3. 节点间矛盾：返回的节点之间可能互相矛盾
 */

/** 感知读：同次 recall 的结果之间建 pending 链接。纯同步、无模型调用。 */
export function perceptualReadOnRecall(
  db: Database.Database,
  nodes: BrainNode[],
  avgSearchScore?: number,
): void {
  const minNodes = getParam('metabolism-params', 'reconsolidate_min_nodes', 3);
  // 质量门槛：如果有搜索分数且平均分太低，跳过感知读（避免低质量召回创建噪音链接）
  const PERCEPTUAL_READ_MIN_SCORE = 0.3;
  const passQualityGate = avgSearchScore === undefined || avgSearchScore >= PERCEPTUAL_READ_MIN_SCORE;
  if (!passQualityGate || nodes.length < minNodes || !isVecLoaded()) return;

  // 计算结果节点间的链接密度
  const nodeIds = new Set(nodes.map(n => n.id));
  let existingLinkCount = 0;
  for (const node of nodes) {
    // rejected_by_user 链接天然被过滤（getLinksForNode 默认排除），
    // 这里只统计 confirmed/pending 的真实邻接
    const links = getLinksForNode(db, node.id).filter(l => l.status === 'confirmed');
    for (const link of links) {
      const otherId = link.from_id === node.id ? link.to_id : link.from_id;
      if (nodeIds.has(otherId)) existingLinkCount++;
    }
  }
  existingLinkCount /= 2; // 每条链接被计数了两次
  const maxLinks = (nodes.length * (nodes.length - 1)) / 2;
  const density = maxLinks > 0 ? existingLinkCount / maxLinks : 1;
  if (density >= 0.3) return;

  log.debug(`感知读: density=${density.toFixed(2)} nodes=${nodes.length}`);
  const MAX_PENDING_LINKS_PER_RECALL = 5;
  let pendingCount = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    if (pendingCount >= MAX_PENDING_LINKS_PER_RECALL) break;
    for (let j = i + 1; j < nodes.length; j++) {
      if (pendingCount >= MAX_PENDING_LINKS_PER_RECALL) break;

      const a = nodes[i];
      const b = nodes[j];

      // 跳过两个都是 meta 类型的节点对
      if (a.is_meta && b.is_meta) continue;

      if (linkExists(db, a.id, b.id)) continue;

      const judgment = inferLinkType(a, b);
      const link = createLink(db, {
        from_id: a.id,
        to_id: b.id,
        relation: [judgment],
        strength: getParam('metabolism-params', 'perceptual_read_link_strength', 0.5),
        note: '感知读：同次 recall 结果',
        auto: true,
        status: 'pending',
      });
      if (!link) continue;
      // 链接精化统一由 refineRecentLinks 定期批量处理，不在 recall 路径上调 LLM
      updateConnectivity(db, a.id);
      updateConnectivity(db, b.id);
      pendingCount++;
    }
  }
}

/**
 * 时间条件 + version == 1（设计文档 §5.5：仅首版节点触发时间驱动的深度读）。
 */
export function selectDeepTargets(nodes: BrainNode[]): BrainNode[] {
  const daysThreshold = getParam('metabolism-params', 'reconsolidate_days_threshold', 7);
  return nodes.filter((node) => {
    // version > 1 的节点已被修订过，跳过时间驱动的深度再巩固
    if (node.version > 1) return false;
    return daysAgo(node.last_reconsolidated || node.created) > daysThreshold;
  });
}

/**
 * 把一条排队的再巩固工作展开为待处理条目：
 * - deep:<节点>      时间驱动的深度读，累计不超过 deep_reconsolidate_max_per_recall
 * - conflict:<节点>  冲突信号触发的深度读，累计不超过 max_conflict_checks_per_recall
 * 节点按当前状态重新读取；已归档或被取代的不再处理。
 */
export function planReconsolidateItems(db: Database.Database, row: RecallFollowupRow): RecallFollowupPlan {
  const nodes = row.nodeIds
    .map(id => getNode(db, id))
    .filter((node): node is BrainNode => !!node && !node.archived && !node.is_superseded);
  if (nodes.length === 0) return { items: [] };
  const context = row.context ?? undefined;
  // 未标注的节点（annotate 尚未给出维度）现在做不了深度读；LLM 可用时保留该行，等标注后补做。
  const awaitingAnnotation = (node: BrainNode) => isLlmConfigured() && (node.refinement ?? 0) <= 0;
  let retryLater = false;
  const handled = new Set(row.handled);
  const handledCount = (prefix: string) => row.handled.filter(key => key.startsWith(prefix)).length;
  const items: RecallFollowupItem[] = [];
  const planned = new Set<string>();
  const add = (key: string, run: () => Promise<void>): boolean => {
    if (handled.has(key) || planned.has(key)) return false;
    planned.add(key);
    items.push({ key, run });
    return true;
  };

  const maxDeep = getParam('metabolism-params', 'deep_reconsolidate_max_per_recall', 3);
  let deepBudget = maxDeep - handledCount('deep:');
  for (const node of selectDeepTargets(nodes)) {
    if (deepBudget <= 0) break;
    if (awaitingAnnotation(node)) { retryLater = true; continue; }
    if (add(`deep:${node.id}`, async () => {
      log.info(`深度再巩固触发 node=${node.id} reason=时间`);
      await deepReconsolidate(db, node, nodes, context);
    })) deepBudget--;
  }

  // 预测误差驱动的冲突检测：启发式快速扫描（零 LLM 成本）决定哪些节点值得深度读
  if (nodes.length >= 2 || context) {
    const maxChecks = getParam('metabolism-params', 'max_conflict_checks_per_recall', 2);
    let conflictBudget = maxChecks - handledCount('conflict:');
    const signals = conflictBudget > 0 ? detectConflictSignals(nodes, context) : [];
    if (signals.length > 0) log.info(`冲突检测: ${signals.length} signals`);
    for (const signal of signals) {
      if (conflictBudget <= 0) break;
      const nodeA = nodes.find(n => n.id === signal.nodeA);
      if (!nodeA) continue;
      if (signal.confidence >= 0.7 || (signal.confidence >= 0.3 && signal.type === 'context_mismatch' && context)) {
        // 高置信度，或中置信度的上下文不匹配：交给深度再巩固的 LLM 判断
        if (awaitingAnnotation(nodeA)) { retryLater = true; continue; }
        if (add(`conflict:${nodeA.id}`, () => deepReconsolidate(db, nodeA, nodes, context))) conflictBudget--;
      } else if (signal.confidence >= 0.3 && signal.type === 'cross_node' && signal.nodeB) {
        // 节点间疑似矛盾：创建 pending 链接交给 link-evaluate 判断，再深度读较旧的一方
        const nodeB = nodes.find(n => n.id === signal.nodeB);
        if (!nodeB || linkExists(db, nodeA.id, nodeB.id)) continue;
        const target = nodeA.version <= nodeB.version ? nodeA : nodeB;
        if (awaitingAnnotation(target)) { retryLater = true; continue; }
        if (add(`conflict:${target.id}`, async () => {
          if (!linkExists(db, nodeA.id, nodeB.id)) {
            createLink(db, {
              from_id: nodeA.id,
              to_id: nodeB.id,
              relation: [{ type: 'contradicts', confidence: signal.confidence }],
              strength: signal.confidence,
              auto: true,
              status: 'pending',
              note: '再巩固：启发式检测到疑似矛盾',
            });
          }
          await deepReconsolidate(db, target, nodes, context);
        })) conflictBudget--;
      }
    }
  }
  return { items, retryLater };
}

/** 调度器任务入口：处理一条排队的深度再巩固工作。 */
export async function runReconsolidateFollowup(db: Database.Database): Promise<void> {
  await runRecallFollowup(db, 'reconsolidate', {
    strategy: 'reconsolidate',
    // LLM 未配置时 deepReconsolidate 走非模型降级（精炼度 +0.1），不需要可调用的路由。
    skipRoutePrecheck: () => !isLlmConfigured(),
    planItems: row => planReconsolidateItems(db, row),
  });
}

/**
 * 深度再巩固 — LLM 驱动的内容分析
 */
async function deepReconsolidate(
  db: Database.Database,
  node: BrainNode,
  contextNodes: BrainNode[],
  callerContext?: string,
): Promise<void> {
  // 未标注的节点不做深度再巩固:annotate 尚未给出维度标注,
  // 贸然让 LLM 判断"冲突/过时"会在缺失上下文的情况下做出错判断,
  // 并且这类节点本该先走 annotate 再进入成熟流程。
  if ((node.refinement ?? 0) <= 0) {
    log.debug(`深度再巩固跳过 node=${node.id}: 未经标注 (refinement=${node.refinement})`);
    return;
  }
  // legacy 熔断由调度器在 claim 之前判断，连接级熔断由队列 runner 预检；这里不再重复检查，
  // 否则会把“暂时调不了”固化成“已处理”。
  if (!isLlmConfigured()) {
    const ts = now();
    db.prepare(`
      UPDATE nodes SET refinement = MIN(refinement + 0.1, 1.0),
                       last_reconsolidated = ?,
                       updated = ?
      WHERE id = ?
    `).run(ts, ts, node.id);
    refreshMaturityScore(db, node.id);
    return;
  }

  const contextContents = contextNodes
    .filter(n => n.id !== node.id)
    .slice(0, 5)
    .map(n => n.content);

  // 包含调用方上下文作为额外信号
  if (callerContext) {
    contextContents.unshift(`[当前对话上下文] ${callerContext}`);
  }

  // 构建上下文节点列表（用于序号匹配）
  const contextNodesList = contextNodes.filter(n => n.id !== node.id).slice(0, 5);

  const fallbackReconPrompt = reconsolidatePrompt(node.content, contextContents, {
    created: node.created,
    version: node.version,
  });
  const response = await callLLM({
    system: getPrompt('reconsolidate', RECONSOLIDATE_SYSTEM),
    prompt: renderUserPrompt('reconsolidate', {
      node_content: node.content,
      created: node.created ?? '',
      version: String(node.version ?? 1),
      context_list: contextContents.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    }, fallbackReconPrompt),
    ...getLLMOptions('reconsolidate'),
    maxTokens: 500,
    operationName: 'reconsolidate',
  });

  const result = parseLLMJson<{
    needs_update?: boolean;
    updated_content?: string | null;
    conflict_detected?: boolean;
    conflict_with_index?: number;
    conflict_with_node?: string | null;
    new_independence?: number;
    reason?: string;
  }>(response);
  log.debug(`深度读结果 node=${node.id} needs_update=${result?.needs_update} conflict=${result?.conflict_detected}`);
  if (!result) {
    const ts = now();
    db.prepare(`
      UPDATE nodes SET refinement = MIN(refinement + 0.1, 1.0),
                       last_reconsolidated = ?,
                       updated = ?
      WHERE id = ?
    `).run(ts, ts, node.id);
    refreshMaturityScore(db, node.id);
    return;
  }

  const contentWasUpdated = !!(result.needs_update && result.updated_content);
  if (contentWasUpdated) {
    updateNode(db, node.id, { content: result.updated_content!, refinement: 0 }, 'deep reconsolidation', { skipEditSeqBump: true });
  }

  if (result.conflict_detected) {
    // 按序号匹配冲突节点（如有 callerContext 占了序号 1，需要偏移）
    const indexOffset = callerContext ? 1 : 0;
    // 如果 callerContext 存在而 LLM 返回 index=1，说明把上下文本身当成冲突目标，丢弃
    if (result.conflict_with_index === 1 && callerContext) {
      log.warn(`node=${node.id} LLM 把 callerContext 当冲突目标（index=1），丢弃`);
    }
    // LLM 约定从 1 开始计数；返回 0 说明模型用了零索引误用，告警但不当冲突处理
    if (result.conflict_with_index === 0) {
      log.warn(`node=${node.id} LLM 返回 conflict_with_index=0（零索引误用），丢弃`);
    }
    const conflictIdx = typeof result.conflict_with_index === 'number' && result.conflict_with_index > 0
      ? result.conflict_with_index - 1 - indexOffset
      : -1;
    const conflictNode = conflictIdx >= 0 && conflictIdx < contextNodesList.length
      ? contextNodesList[conflictIdx]
      : undefined;
    if (conflictNode && !linkExists(db, node.id, conflictNode.id)) {
      // reconsolidate LLM 已判断 conflict_detected=true，创建 pending 链接交给 link-evaluate 最终确认
      createLink(db, {
        from_id: node.id,
        to_id: conflictNode.id,
        relation: [{ type: 'contradicts', confidence: 0.7 }],
        strength: 0.7,
        auto: true,
        status: 'pending',
        note: result.reason || '再巩固：检测到矛盾',
      });
    }
  }

  const newIndependence = typeof result.new_independence === 'number'
    ? Math.max(0, Math.min(1, result.new_independence))
    : node.independence;

  // 读 params:优先新名 refinement_boost,向后兼容老 independence_boost 名字
  // (老 params 文件里写的 independence_boost 但代码一直是 hardcode 0.15 + 加到
  // refinement 列,v0.2.23 归一。getParam 读不到新名时自然回落 default)
  const refinementBoost = getParam<number>('reconsolidate', 'refinement_boost',
    getParam<number>('reconsolidate', 'independence_boost', 0.15));

  if (!contentWasUpdated) {
    const ts = now();
    db.prepare(`
      UPDATE nodes SET
        refinement = MIN(refinement + ?, 1.0),
        independence = ?,
        last_reconsolidated = ?,
        updated = ?
      WHERE id = ?
    `).run(refinementBoost, newIndependence, ts, ts, node.id);
  } else {
    const ts = now();
    db.prepare(`
      UPDATE nodes SET
        independence = ?,
        last_reconsolidated = ?,
        updated = ?
      WHERE id = ?
    `).run(newIndependence, ts, ts, node.id);
  }
  refreshMaturityScore(db, node.id);
}
