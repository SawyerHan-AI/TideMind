import type { BrainNode } from '../types.js';
import { getParam } from '../strategy/loader.js';

export interface ConflictSignal {
  type: 'context_mismatch' | 'cross_node' | 'temporal';
  nodeA: string;
  nodeB?: string;
  confidence: number;
  reason: string;
}

/** 中文否定标记 */
const NEGATION_ZH = ['不再', '取消', '废弃', '放弃', '停用', '替换', '改为', '改用', '迁移到', '从\\S+换成', '不用'];
/** 英文否定标记 */
const NEGATION_EN = ['no longer', 'deprecated', 'removed', 'replaced', 'stopped', 'abandoned', 'switched from', 'migrated to', 'instead of'];

/**
 * 提取文本关键词（简易分词）
 */
function extractKeywords(text: string): Set<string> {
  // 按空格、标点、换行分词，过滤短 token
  const tokens = text
    .toLowerCase()
    .split(/[\s,;.!?，。！？、；：""''（）[\]{}()]+/)
    .filter(t => t.length >= 2);
  return new Set(tokens);
}

/**
 * 两组关键词的重叠度
 */
function keywordOverlap(textA: string, textB: string): number {
  const kwA = extractKeywords(textA);
  const kwB = extractKeywords(textB);
  if (kwA.size === 0 || kwB.size === 0) return 0;

  let intersection = 0;
  for (const k of kwA) {
    if (kwB.has(k)) intersection++;
  }
  const smaller = Math.min(kwA.size, kwB.size);
  return intersection / smaller;
}

/**
 * 检测文本是否包含对共享关键词的否定
 */
function hasNegatedOverlap(textA: string, textB: string): boolean {
  const sharedKeywords = [...extractKeywords(textA)].filter(k => extractKeywords(textB).has(k));
  if (sharedKeywords.length === 0) return false;

  const allNegations = [...NEGATION_ZH, ...NEGATION_EN];

  for (const keyword of sharedKeywords) {
    for (const neg of allNegations) {
      // 转义用户数据，防止关键词含正则特殊字符
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedNeg = neg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 检查否定标记是否在共享关键词附近（前后 30 字符内）
      const patterns = [
        new RegExp(`${escapedNeg}[^。.!？\\n]{0,20}${escapedKeyword}`, 'i'),
        new RegExp(`${escapedKeyword}[^。.!？\\n]{0,20}${escapedNeg}`, 'i'),
      ];
      // 只需一边有否定即可
      const textAMatch = patterns.some(p => p.test(textA));
      const textBMatch = patterns.some(p => p.test(textB));
      // A 和 B 对同一关键词一个肯定一个否定
      if ((textAMatch && !textBMatch) || (!textAMatch && textBMatch)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 检测 recall 上下文和返回节点之间的冲突信号
 *
 * 三种检测：
 * 1. context_mismatch：上下文与节点内容可能矛盾
 * 2. cross_node：返回的节点之间可能互相矛盾
 * 3. temporal：基于时间的过期检测（保留原有逻辑作为补充）
 */
export function detectConflictSignals(
  nodes: BrainNode[],
  context?: string,
): ConflictSignal[] {
  const signals: ConflictSignal[] = [];

  // 1. 上下文 vs 节点 冲突
  if (context && context.length >= 10) {
    for (const node of nodes) {
      const overlap = keywordOverlap(node.content, context);
      const minOverlap = getParam('metabolism-params', 'conflict_min_overlap', 0.15);
      if (overlap < minOverlap) continue;

      if (hasNegatedOverlap(node.content, context)) {
        signals.push({
          type: 'context_mismatch',
          nodeA: node.id,
          confidence: Math.min(0.4 + overlap, getParam('metabolism-params', 'conflict_high_confidence', 0.85)),
          reason: `上下文可能否定了节点内容中的关键信息`,
        });
      }
    }
  }

  // 2. 节点间矛盾
  for (let i = 0; i < nodes.length - 1; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const overlap = keywordOverlap(nodes[i].content, nodes[j].content);
      const minCrossOverlap = getParam('metabolism-params', 'conflict_cross_min_overlap', 0.25);
      if (overlap < minCrossOverlap) continue;

      if (hasNegatedOverlap(nodes[i].content, nodes[j].content)) {
        signals.push({
          type: 'cross_node',
          nodeA: nodes[i].id,
          nodeB: nodes[j].id,
          confidence: Math.min(0.35 + overlap * 0.5, 0.8),
          reason: `两个节点在共同话题上持相反立场`,
        });
      }
    }
  }

  // 按置信度降序排列
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals;
}
