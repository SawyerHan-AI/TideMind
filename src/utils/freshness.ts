/**
 * 记忆新鲜度标注
 *
 * 为 recall 返回的节点生成人类/LLM 可读的新鲜度提示。
 * 灵感来自 Claude Code 的 memoryAge / memoryFreshnessNote 机制，
 * 但结合 Tide Mind 的四维成熟度模型。
 */

import type { BrainNode, RecallNodeLink } from '../types.js';
import { createLogger } from './logger.js';

const log = createLogger('freshness');

/**
 * 计算节点的新鲜度标注。
 * 返回 undefined 表示节点足够新鲜，无需标注。
 */
export function computeFreshness(
  node: BrainNode,
  links?: RecallNodeLink[],
): string | undefined {
  const parts: string[] = [];

  // 主标注：基于 heat + 最后更新时间
  const label = computeAgeLabel(node);
  if (label) parts.push(label);

  // 矛盾标注：如果有 contradicts 类型的链接
  if (links?.some(l => Array.isArray(l.relation) && l.relation.some(r => r.type === 'contradicts'))) {
    parts.push('存在矛盾信号');
  }

  return parts.length > 0 ? parts.join('；') : undefined;
}

function computeAgeLabel(node: BrainNode): string | undefined {
  // 高热度节点：最近活跃，无需标注
  if (node.heat >= 0.5) return undefined;

  const daysSinceUpdate = getDaysSinceUpdate(node);

  // 新节点（当天创建）：无论热度如何，都无需旧记忆标注
  if (daysSinceUpdate < 1) return undefined;

  // 中等热度 + 近期更新：无需标注
  if (node.heat >= 0.2 && daysSinceUpdate <= 7) return undefined;

  // 低热度但不太旧
  if (node.heat >= 0.1 && daysSinceUpdate <= 30) {
    return '较早记忆，可能需要验证';
  }

  // 很冷或很旧
  return `较旧记忆（${daysSinceUpdate}天前更新），建议验证后使用`;
}

/** 计算距上次更新（再巩固或创建）的天数 */
function getDaysSinceUpdate(node: BrainNode): number {
  const ref = node.last_reconsolidated ?? node.created;
  const refMs = new Date(ref).getTime();
  if (isNaN(refMs)) {
    log.warn(`Invalid date in node ${node.id}: "${ref}"`);
    return 999;
  }
  const days = Math.floor((Date.now() - refMs) / 86_400_000);
  return Math.max(0, days);
}
