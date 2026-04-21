import type Database from 'better-sqlite3';
import type { BrainNode } from '../types.js';
import { bumpHeat, updateNode } from '../db/nodes.js';
import { createLink, linkExists, getLinksForNode } from '../db/links.js';
import { searchVectors } from '../db/vectors.js';
import { isVecLoaded } from '../db/connection.js';
import { daysAgo } from '../utils/time.js';
import { getParam, renderUserPrompt } from '../strategy/loader.js';
import { inferLinkType } from '../llm/link-judge.js';
import { callLLM } from '../llm/client.js';
import { updateConnectivity, refreshMaturityScore } from '../graph/maturity.js';
import { RECONSOLIDATE_SYSTEM, reconsolidatePrompt } from '../llm/prompts.js';
import { getConfig, isLlmConfigured } from '../config.js';
import { detectConflictSignals } from './conflict-heuristics.js';
import { getPrompt, getLLMOptions } from '../strategy/loader.js';
import { getCircuitState } from './scheduler.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';

const log = createLogger('reconsolidate');

let reconsolidateInFlight = false;

/**
 * 读即写再巩固
 *
 * 三个级别：
 * - 静默读：只加热（已在 recall 中处理）
 * - 感知读：在无直接链接的相关结果间创建 pending 链接
 * - 深度读：标记需要内容更新检查的节点（异步）
 *
 * 深度读触发条件：
 * 1. 时间条件（原有）：version == 1 且超过阈值天数未再巩固
 * 2. 预测误差（新增）：上下文与节点内容存在冲突信号
 * 3. 节点间矛盾（新增）：返回的节点之间可能互相矛盾
 */
export function reconsolidateOnRecall(
  db: Database.Database,
  nodes: BrainNode[],
  context?: string,
  avgSearchScore?: number,
): void {
  if (reconsolidateInFlight) return;
  reconsolidateInFlight = true;

  // 整个函数体包 try/catch/finally — 感知读/深度判定阶段任一异常(createLink
  // 抛错、SQL 错、策略配置坏等)会让模块级 flag 永远卡 true,此后本进程的
  // recall 永远跳过深度/感知读,直到重启。async IIFE 的 .finally 有自己的
  // 复位路径,但前面同步代码挂掉就漏了。
  let spawnedAsync = false;
  try {

  const minNodes = getParam('metabolism-params', 'reconsolidate_min_nodes', 3);

  // --- 感知读 ---
  // 质量门槛：如果有搜索分数且平均分太低，跳过感知读（避免低质量召回创建噪音链接）
  const PERCEPTUAL_READ_MIN_SCORE = 0.3;
  const passQualityGate = avgSearchScore === undefined || avgSearchScore >= PERCEPTUAL_READ_MIN_SCORE;
  if (passQualityGate && nodes.length >= minNodes && isVecLoaded()) {
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

    if (density < 0.3) {
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
  }

  // --- 深度读判定 ---
  const daysThreshold = getParam('metabolism-params', 'reconsolidate_days_threshold', 7);
  const maxDeep = getParam('metabolism-params', 'deep_reconsolidate_max_per_recall', 3);
  let deepCount = 0;

  // 条件 1: 时间条件 + version == 1（设计文档 §5.5：仅首版节点触发时间驱动的深度读）
  // 收集待触发的节点，串行执行避免并发 LLM 调用
  const deepTargets: BrainNode[] = [];
  for (const node of nodes) {
    if (deepCount >= maxDeep) break;

    // version > 1 的节点已被修订过，跳过时间驱动的深度再巩固
    if (node.version > 1) continue;

    let shouldTrigger = false;

    if (!node.last_reconsolidated) {
      // 从未再巩固：检查创建时间
      shouldTrigger = daysAgo(node.created) > daysThreshold;
    } else {
      // 已再巩固过：检查距上次是否超过阈值
      shouldTrigger = daysAgo(node.last_reconsolidated) > daysThreshold;
    }

    if (shouldTrigger) {
      deepTargets.push(node);
      deepCount++;
    }
  }

  // 异步串行执行深度再巩固 + 冲突检测，避免不可控的并发 LLM 调用
  if (deepTargets.length > 0 || nodes.length >= 2 || context) {
    spawnedAsync = true;
    (async () => {
      for (const node of deepTargets) {
        log.info(`深度再巩固触发 node=${node.id} reason=时间`);
        try { await deepReconsolidate(db, node, nodes, context); } catch (err) { log.error('深度再巩固失败:', (err as Error).message); }
      }
      // 条件 2+3: 预测误差驱动的冲突检测
      if (nodes.length >= 2 || context) {
        try { await detectAndReconsolidateAsync(db, nodes, context); } catch (err) { log.error('冲突检测失败:', (err as Error).message); }
      }
    })().catch(err => log.warn('再巩固 IIFE 未捕获异常:', (err as Error).message)).finally(() => { reconsolidateInFlight = false; });
  }

  } catch (err) {
    // 同步路径任何异常都立刻复位 flag
    log.error(`reconsolidateOnRecall 同步异常: ${(err as Error).message}`);
    reconsolidateInFlight = false;
    throw err;
  } finally {
    // 如果没进入 async IIFE,同步路径跑完也要复位
    if (!spawnedAsync) reconsolidateInFlight = false;
  }
}

/**
 * 异步冲突检测 + 再巩固
 *
 * 1. 启发式快速扫描（零 LLM 成本）
 * 2. 高置信度 → 直接触发深度再巩固
 * 3. 中置信度 → LLM 矛盾检测确认
 * 4. 确认的冲突 → 创建 contradicts 链接 + 深度再巩固
 */
async function detectAndReconsolidateAsync(
  db: Database.Database,
  nodes: BrainNode[],
  context?: string,
): Promise<void> {
  const signals = detectConflictSignals(nodes, context);
  if (signals.length === 0) return;
  log.info(`冲突检测: ${signals.length} signals`);

  const maxChecks = getParam('metabolism-params', 'max_conflict_checks_per_recall', 2);
  let checkCount = 0;

  for (const signal of signals) {
    if (checkCount >= maxChecks) break;

    if (signal.confidence >= 0.7) {
      // 高置信度：直接触发深度再巩固
      const node = nodes.find(n => n.id === signal.nodeA);
      if (node) {
        await deepReconsolidate(db, node, nodes, context);
        checkCount++;
      }
    } else if (signal.confidence >= 0.3) {
      checkCount++;

      if (signal.type === 'context_mismatch' && context) {
        // 中置信度上下文不匹配：直接交给深度再巩固的 LLM 判断
        const node = nodes.find(n => n.id === signal.nodeA);
        if (node) {
          await deepReconsolidate(db, node, nodes, context);
        }
      } else if (signal.type === 'cross_node' && signal.nodeB) {
        // 节点间疑似矛盾：创建 pending 链接，交给 link-evaluate 判断
        const nodeA = nodes.find(n => n.id === signal.nodeA);
        const nodeB = nodes.find(n => n.id === signal.nodeB);
        if (nodeA && nodeB && !linkExists(db, nodeA.id, nodeB.id)) {
          createLink(db, {
            from_id: nodeA.id,
            to_id: nodeB.id,
            relation: [{ type: 'contradicts', confidence: signal.confidence }],
            strength: signal.confidence,
            auto: true,
            status: 'pending',
            note: '再巩固：启发式检测到疑似矛盾',
          });
          const target = nodeA.version <= nodeB.version ? nodeA : nodeB;
          await deepReconsolidate(db, target, nodes, context);
        }
      }
    }
  }
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
  const config = getConfig();
  // 熔断器保护:recall 路径上的深度再巩固由 reconsolidateOnRecall fire-and-forget
  // 触发,不走 scheduler 的 LLM 熔断保护。这里显式读熔断器状态,open 时走非 LLM
  // 降级路径,避免 LLM 挂了时每次 recall 都要等超时失败。
  if (getCircuitState(db).state === 'open') {
    log.debug(`深度再巩固跳过 node=${node.id}: LLM 熔断器开启`);
    db.prepare(`
      UPDATE nodes SET refinement = MIN(refinement + 0.1, 1.0),
                       last_reconsolidated = datetime('now')
      WHERE id = ?
    `).run(node.id);
    refreshMaturityScore(db, node.id);
    return;
  }
  if (!isLlmConfigured()) {
    db.prepare(`
      UPDATE nodes SET refinement = MIN(refinement + 0.1, 1.0),
                       last_reconsolidated = datetime('now')
      WHERE id = ?
    `).run(node.id);
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
    db.prepare(`
      UPDATE nodes SET refinement = MIN(refinement + 0.1, 1.0),
                       last_reconsolidated = datetime('now')
      WHERE id = ?
    `).run(node.id);
    refreshMaturityScore(db, node.id);
    return;
  }

  const contentWasUpdated = !!(result.needs_update && result.updated_content);
  if (contentWasUpdated) {
    updateNode(db, node.id, { content: result.updated_content!, refinement: 0 }, 'deep reconsolidation');
  }

  if (result.conflict_detected) {
    // 按序号匹配冲突节点（如有 callerContext 占了序号 1，需要偏移）
    const indexOffset = callerContext ? 1 : 0;
    // 如果 callerContext 存在而 LLM 返回 index=1，说明把上下文本身当成冲突目标，丢弃
    if (result.conflict_with_index === 1 && callerContext) {
      log.warn(`node=${node.id} LLM 把 callerContext 当冲突目标（index=1），丢弃`);
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
    db.prepare(`
      UPDATE nodes SET
        refinement = MIN(refinement + ?, 1.0),
        independence = ?,
        last_reconsolidated = datetime('now')
      WHERE id = ?
    `).run(refinementBoost, newIndependence, node.id);
  } else {
    db.prepare(`
      UPDATE nodes SET
        independence = ?,
        last_reconsolidated = datetime('now')
      WHERE id = ?
    `).run(newIndependence, node.id);
  }
  refreshMaturityScore(db, node.id);
}

