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

// CJK 范围(中日韩统一表意):基本区 + 扩展 A,覆盖绝大多数现代汉字。
const CJK_CHAR_RE = /[一-鿿㐀-䶿]/;

/**
 * 提取文本关键词(简易分词,中文走 bigram + 英文混排)
 *
 * 历史 bug(2026-05-09):原实现只按 `[\s,;.!?…]` 切分 + `length >= 2` 过滤,
 * 对中文笔记几乎完全失效:
 *   - 单字汉字 length=1 被过滤
 *   - 连续汉字段(标点之间整段)成为单个 token,如 "我换成了" 这种长串
 *     只在两条相同句式下才会重叠 → 实际中文笔记之间的 keywordOverlap
 *     永远 ≈ 0,hasNegatedOverlap 永不命中。
 * 后果:中文用户的"启发式冲突检测"完全不工作 ——
 * 用户改主意("不再用 Vue,改用 React")没法被检测,reconsolidate 不会被预测
 * 误差驱动,旧观点持续累积。
 *
 * 修复:对每个 segment 按字符类型分支:
 *   - 含 CJK 字符的 segment 走 bigram(连续 2 字),保留段内英文/数字单词
 *   - 纯非 CJK segment 保留原 length>=2 过滤
 * Bigram 保证 "用 Vue" vs "不用 Vue" 仍能共享 token "Vue"(英文不被切),
 * "改成 React" 与 "用 React" 共享 "React",同时 "我换成了" 内部 bigram
 * "我换"/"换成"/"成了" 大概率与 "我现在用" 内部 "我现"/"现在"/"在用" 部分
 * 重叠,避免完全 0 overlap 的极端情形。
 */
function extractKeywords(text: string): Set<string> {
  const tokens = new Set<string>();
  const segments = text
    .toLowerCase()
    .split(/[\s,;.!?，。！？、；：""''（）[\]{}()…]+/)
    .filter(s => s.length > 0);

  for (const seg of segments) {
    if (CJK_CHAR_RE.test(seg)) {
      // 中文/日文段:bigram(2 字符滑窗)。只保留至少含一个 CJK 字符的 bigram,
      // 避免 "ab" 这类纯 ASCII 子串被切到 bigram 后污染。
      for (let i = 0; i < seg.length - 1; i++) {
        const bg = seg.slice(i, i + 2);
        if (CJK_CHAR_RE.test(bg)) tokens.add(bg);
      }
      // 同时保留段内的英文/数字单词(中英混排笔记里 "React"、"Vue" 这类必须留)
      const enMatches = seg.match(/[a-z][a-z0-9_-]+/g);
      if (enMatches) {
        for (const w of enMatches) {
          if (w.length >= 2) tokens.add(w);
        }
      }
    } else {
      // 纯 ASCII / 标点段:原长度阈值
      if (seg.length >= 2) tokens.add(seg);
    }
  }
  return tokens;
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
