// ============================================================
// 思考（关联）— 链接重新验证
//
// recall 只把“这批节点 + 查询”写入 recall_followups 队列；调度器任务
// link-revalidate 在长驻进程里消费，评估这些节点的现有链接在新的上下文下
// 是否仍然成立。短命的 MCP 进程不再直接调模型。
// ============================================================

import type Database from 'better-sqlite3';
import type { RelationType, LinkRelation } from '../types.js';
import { getNode } from '../db/nodes.js';
import { getLinksForNode, updateLinkRelation, updateLinkStrength, deleteLink } from '../db/links.js';
import { isLlmConfigured } from '../config.js';
import { callLLM } from '../llm/client.js';
import { getPrompt, getLLMOptions, getParam, renderUserPrompt } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';
import { runRecallFollowup } from './recall-followup-runner.js';

const log = createLogger('link-revalidate');

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

export interface RevalidationCandidate {
  linkId: string;
  fromId: string;
  toId: string;
  relation: LinkRelation[];
  strength: number;
}

/**
 * 收集这些节点上待重新验证的 confirmed 链接：去重、跳过过新的链接、
 * 按 strength 从低到高（低 strength 更需要重新验证），排除已处理的并截断。
 */
export function selectLinksToRevalidate(
  db: Database.Database,
  nodeIds: string[],
  excludeLinkIds: ReadonlySet<string>,
  limit: number,
  /** Set to true when a confirmed link was skipped only because it is still too young. */
  observed?: { tooYoung: boolean },
): RevalidationCandidate[] {
  if (limit <= 0) return [];
  const minLinkAge = getParam('link-revalidate', 'min_link_age_hours', 24);
  const candidates: RevalidationCandidate[] = [];
  const seenLinkIds = new Set<string>();
  for (const nodeId of nodeIds) {
    for (const link of getLinksForNode(db, nodeId)) {
      if (link.status !== 'confirmed') continue;
      if (seenLinkIds.has(link.id)) continue;
      seenLinkIds.add(link.id);
      if (excludeLinkIds.has(link.id)) continue;
      // 只检查存在一段时间的链接（刚创建的不需要重新验证）
      const ageHours = (Date.now() - new Date(link.created).getTime()) / (1000 * 60 * 60);
      if (ageHours < minLinkAge) { if (observed) observed.tooYoung = true; continue; }
      candidates.push({
        linkId: link.id, fromId: link.from_id, toId: link.to_id,
        relation: link.relation, strength: link.strength,
      });
    }
  }
  candidates.sort((a, b) => a.strength - b.strength);
  return candidates.slice(0, limit);
}

export type RevalidationResult = 'updated' | 'downgraded' | 'kept' | 'skipped';

/**
 * 重新验证一条链接。模型调用的错误（服务错误、CLI 错误、路由错误）原样上抛，
 * 由队列 runner 决定放回还是不再重放；这里不吞。
 */
export async function revalidateOneLink(
  db: Database.Database,
  item: RevalidationCandidate,
  context: RevalidateContext,
): Promise<RevalidationResult> {
  const fromNode = getNode(db, item.fromId);
  const toNode = getNode(db, item.toId);
  if (!fromNode || !toNode) return 'skipped';

  const contextStr = [
    `当前 recall 查询: ${context.query}`,
    context.recentInteractions && context.recentInteractions.length > 0
      ? `最近交互:\n${context.recentInteractions.map(i => `  - ${i}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
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
  if (!parsed) return 'skipped';

  if (!parsed.still_valid) {
    // 链接不再成立:若原 strength 已经极低(< 0.05),再做 max(0.05, x*0.3)
    // 等于把本该衰减至近乎 0 的链接反弹回 0.05 地板,永远无法被
    // synaptic 清掉。此时直接删除,跳过不必要的"降级→再衰减"循环。
    if (item.strength < 0.05) {
      deleteLink(db, item.linkId);
      log.debug(`链接删除 ${item.linkId}: strength ${item.strength.toFixed(3)} 已极低且不再成立`);
    } else {
      const newStrength = Math.max(0.05, item.strength * 0.3);
      updateLinkStrength(db, item.linkId, newStrength);
      log.debug(`链接降级 ${item.linkId}: strength ${item.strength.toFixed(2)} → ${newStrength.toFixed(2)}`);
    }
    return 'downgraded';
  }
  if (parsed.relation && VALID_RELATIONS.has(parsed.relation) && parsed.relation !== primaryRelation) {
    // 关系类型需要调整
    const confidence = parsed.confidence ?? 0.7;
    updateLinkRelation(db, item.linkId, [{ type: parsed.relation as RelationType, confidence }]);
    // 同时提升 strength（因为被重新验证过了）
    updateLinkStrength(db, item.linkId, Math.min(1.0, item.strength * 1.1));
    log.debug(`链接更新 ${item.linkId}: ${primaryRelation} → ${parsed.relation}`);
    return 'updated';
  }
  // 链接仍然成立且类型没变 → 小幅提升 strength
  updateLinkStrength(db, item.linkId, Math.min(1.0, item.strength * 1.05));
  return 'kept';
}

/**
 * 调度器任务入口：处理一条排队的链接重新验证（最多 max_links_per_run 条链接，
 * 跨多次运行累计）。
 */
export async function runLinkRevalidateFollowup(db: Database.Database): Promise<void> {
  let updated = 0;
  let removed = 0;
  await runRecallFollowup(db, 'link_revalidate', {
    strategy: 'link-revalidate',
    canRun: () => isLlmConfigured(),
    planItems: (row) => {
      const maxLinksPerRun = getParam('link-revalidate', 'max_links_per_run', 10);
      const handled = new Set(row.handled);
      const context: RevalidateContext = { query: row.query ?? '', recalledNodeIds: row.nodeIds };
      const observed = { tooYoung: false };
      const items = selectLinksToRevalidate(db, row.nodeIds, handled, maxLinksPerRun - handled.size, observed)
        .map(candidate => ({
          key: candidate.linkId,
          run: async () => {
            const result = await revalidateOneLink(db, candidate, context);
            if (result === 'updated') updated++;
            if (result === 'downgraded') removed++;
          },
        }));
      // Links that are merely too young become eligible later: keep the row for them.
      return { items, retryLater: observed.tooYoung && handled.size + items.length < maxLinksPerRun };
    },
    onRowSettled: (row, processed) => {
      if (updated === 0 && removed === 0) return;
      log.info(`链接重新验证: 检查=${processed} 更新=${updated} 降级=${removed}`);
      logTimelineEvent(db, {
        type: 'think_associate',
        subtype: 'refine_links',
        title: JSON.stringify({ key: 'links_revalidated', params: { count: processed } }),
        detail: { checked: processed, updated, removed, query: (row.query ?? '').slice(0, 50) },
      });
    },
  });
}
