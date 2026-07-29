// ============================================================
// 思考（关联）— 链接重新验证
//
// recall 触发：当 recall 返回节点时，异步评估这些节点的现有链接
// 是否在新的上下文下仍然成立。
// 不在 scheduler 中注册，由 recall 工具 fire-and-forget 调用。
// ============================================================

import type Database from 'better-sqlite3';
import type { RelationType, LinkRelation } from '../types.js';
import { getNode } from '../db/nodes.js';
import { getLinksForNode, updateLinkRelation, updateLinkStrength, deleteLink } from '../db/links.js';
import { isLlmConfigured } from '../config.js';
import { callLLM, LLMServiceError } from '../llm/client.js';
import { getPrompt, getLLMOptions, getParam, renderUserPrompt } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';
import { notifyLLMFailure } from './scheduler.js';
import { trackBackgroundWork } from '../utils/background-work.js';

const log = createLogger('link-revalidate');

// 全局并发上限(2026-05-09 修 M14):此函数被 recall 路径 fire-and-forget 调起,
// 高频 recall(前端 typing-trigger / 多窗口)会让多个并发跑各自串行 N 次 LLM
// 调用,LLM tokens / 限流被打爆。与 reconsolidateOnRecall 的并发控制一致。
const MAX_CONCURRENT_REVALIDATIONS = 2;
const inflightRevalidations = new Set<string>();

const VALID_RELATIONS = new Set<string>([
  'caused_by', 'continues', 'updates', 'supports', 'contradicts',
  'summarizes', 'part_of', 'analogous', 'tagged',
]);

const FALLBACK_SYSTEM = `你是记忆链接的重新评估器。在新的上下文信息出现后，重新判断两条记忆之间的关系。

当前情境信息会告诉你用户正在关注什么。结合这个情境，重新评估链接：
1. 这条链接在当前语境下是否仍然成立？
2. 关系类型是否需要调整？
3. 是否有之前没注意到的更深层关系？

关系类型:
- caused_by / continues / updates / supports / contradicts / summarizes / part_of / analogous / tagged

输出 JSON:
{ "still_valid": true/false, "relation": "...", "confidence": 0.0-1.0, "reason": "..." }

只输出 JSON。`;

export interface RevalidateContext {
  query: string;
  recalledNodeIds: string[];
  recentInteractions?: string[];
}

/**
 * 对 recall 返回的节点的链接进行重新验证
 *
 * fire-and-forget 调用：不阻塞 recall 响应
 */
export async function revalidateLinks(
  db: Database.Database,
  nodeIds: string[],
  context: RevalidateContext,
): Promise<void> {
  if (!isLlmConfigured()) {
    log.debug('链接重新验证跳过: LLM 未配置');
    return;
  }

  // 并发护栏:超过上限直接退出,不阻塞 recall。用 query 串作为 in-flight 键
  // 配对(同一查询的并发只跑一次)。简单 size 阈值兜住高频 recall 场景。
  if (inflightRevalidations.size >= MAX_CONCURRENT_REVALIDATIONS) {
    log.debug(`链接重新验证跳过: in-flight=${inflightRevalidations.size} 已满 ${MAX_CONCURRENT_REVALIDATIONS}`);
    return;
  }
  // 修复 F7(2026-05-21): inflightKey 必须排序,否则 nodeIds 顺序不同但内容相同的
  // 并发调用会绕过 dedup(['a','b'] 和 ['b','a'] 生成不同 key)。
  const inflightKey = `${context.query}:${nodeIds.slice(0, 5).slice().sort().join(',')}`;
  if (inflightRevalidations.has(inflightKey)) return;
  inflightRevalidations.add(inflightKey);
  const work = revalidateLinksInner(db, nodeIds, context)
    .finally(() => {
      inflightRevalidations.delete(inflightKey);
    });
  return trackBackgroundWork(work);
}

async function revalidateLinksInner(
  db: Database.Database,
  nodeIds: string[],
  context: RevalidateContext,
): Promise<void> {
  const maxLinksPerRun = getParam('link-revalidate', 'max_links_per_run', 10);
  const minLinkAge = getParam('link-revalidate', 'min_link_age_hours', 24);

  // 收集这些节点的所有链接（去重：双端都在 nodeIds 中时链接只处理一次）
  const linksToCheck: Array<{ linkId: string; fromId: string; toId: string; relation: LinkRelation[]; strength: number }> = [];
  const seenLinkIds = new Set<string>();

  for (const nodeId of nodeIds) {
    const links = getLinksForNode(db, nodeId);
    for (const link of links) {
      if (link.status !== 'confirmed') continue;
      if (seenLinkIds.has(link.id)) continue;
      seenLinkIds.add(link.id);
      // 只检查存在一段时间的链接（刚创建的不需要重新验证）
      const ageHours = (Date.now() - new Date(link.created).getTime()) / (1000 * 60 * 60);
      if (ageHours < minLinkAge) continue;

      linksToCheck.push({
        linkId: link.id,
        fromId: link.from_id,
        toId: link.to_id,
        relation: link.relation,
        strength: link.strength,
      });
    }
  }

  if (linksToCheck.length === 0) return;

  // 按 strength 从低到高排序（低 strength 的链接更需要重新验证）
  linksToCheck.sort((a, b) => a.strength - b.strength);
  const toProcess = linksToCheck.slice(0, maxLinksPerRun);

  let updated = 0;
  let removed = 0;

  // 构建上下文字符串
  const contextStr = [
    `当前 recall 查询: ${context.query}`,
    context.recentInteractions && context.recentInteractions.length > 0
      ? `最近交互:\n${context.recentInteractions.map(i => `  - ${i}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');

  for (const item of toProcess) {
    try {
      const fromNode = getNode(db, item.fromId);
      const toNode = getNode(db, item.toId);
      if (!fromNode || !toNode) continue;

      const primaryRelation = item.relation.length > 0 ? item.relation[0].type : 'analogous';
      const fallbackRevalPrompt = [
        contextStr,
        '',
        `正在评估的链接:`,
        `A: ${fromNode.content.slice(0, 300)}`,
        `B: ${toNode.content.slice(0, 300)}`,
        `当前关系: ${primaryRelation} (strength: ${item.strength.toFixed(2)})`,
        '',
        `在当前语境下，这条链接还成立吗？关系类型是否需要调整？`,
      ].join('\n');

      const response = await callLLM({
        prompt: renderUserPrompt('link-revalidate', {
          query: context.query,
          recent_interactions: context.recentInteractions?.map(i => `  - ${i}`).join('\n') ?? '',
          node_a_content: fromNode.content.slice(0, 300),
          node_b_content: toNode.content.slice(0, 300),
          current_relation: primaryRelation,
          strength: item.strength.toFixed(2),
        }, fallbackRevalPrompt),
        system: getPrompt('link-revalidate', FALLBACK_SYSTEM),
        ...getLLMOptions('link-revalidate'),
        maxTokens: 200,
        operationName: 'link-revalidate',
      });

      const parsed = parseLLMJson<{
        still_valid: boolean;
        relation?: string;
        confidence?: number;
        reason?: string;
      }>(response);
      if (!parsed) continue;

      if (!parsed.still_valid) {
        // 链接不再成立:若原 strength 已经极低(< 0.05),再做 max(0.05, x*0.3)
        // 等于把本该衰减至近乎 0 的链接反弹回 0.05 地板,永远无法被
        // synaptic 清掉。此时直接删除,跳过不必要的"降级→再衰减"循环。
        if (item.strength < 0.05) {
          deleteLink(db, item.linkId);
          removed++;
          log.debug(`链接删除 ${item.linkId}: strength ${item.strength.toFixed(3)} 已极低且不再成立`);
        } else {
          const newStrength = Math.max(0.05, item.strength * 0.3);
          updateLinkStrength(db, item.linkId, newStrength);
          removed++;
          log.debug(`链接降级 ${item.linkId}: strength ${item.strength.toFixed(2)} → ${newStrength.toFixed(2)}`);
        }
      } else if (parsed.relation && VALID_RELATIONS.has(parsed.relation) && parsed.relation !== primaryRelation) {
        // 关系类型需要调整
        const confidence = parsed.confidence ?? 0.7;
        updateLinkRelation(db, item.linkId, [{ type: parsed.relation as RelationType, confidence }]);
        // 同时提升 strength（因为被重新验证过了）
        const boostedStrength = Math.min(1.0, item.strength * 1.1);
        updateLinkStrength(db, item.linkId, boostedStrength);
        updated++;
        log.debug(`链接更新 ${item.linkId}: ${primaryRelation} → ${parsed.relation}`);
      } else {
        // 链接仍然成立且类型没变 → 小幅提升 strength
        const boostedStrength = Math.min(1.0, item.strength * 1.05);
        updateLinkStrength(db, item.linkId, boostedStrength);
      }
    } catch (err) {
      // LLMServiceError 走熔断器路径,否则每条 link 都撞一次 LLM(maxLinks 通常 5-20),
      // 在 LLM 全挂期间形成隐形烧钱循环。
      // 修复 F3(2026-05-21): 在 throw 之前先通过 hook 通知熔断器累积失败 —
      // recall 路径 fire-and-forget 调用 revalidateLinks,外层只 log.warn,不会
      // 走 scheduler 的 recordLLMFailure。这里 notifyLLMFailure 让熔断器收到信号。
      if (err instanceof LLMServiceError) {
        notifyLLMFailure(err);
        throw err;
      }
      log.warn(`链接重新验证失败 ${item.linkId}: ${(err as Error).message}`);
    }
  }

  if (updated > 0 || removed > 0) {
    log.info(`链接重新验证: 检查=${toProcess.length} 更新=${updated} 降级=${removed}`);
    logTimelineEvent(db, {
      type: 'think_associate',
      subtype: 'refine_links',
      title: JSON.stringify({ key: 'links_revalidated', params: { count: toProcess.length } }),
      detail: { checked: toProcess.length, updated, removed, query: context.query.slice(0, 50) },
    });
  }
}
