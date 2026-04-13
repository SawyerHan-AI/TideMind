import type { LinkRelation } from '../types.js';

export interface NodeInfo {
  type?: string;
  content: string;
  // 三维内容性质
  specificity?: number;
  subjectivity?: number;
  actuality?: number;
  // 结构角色
  is_crystal?: number;
}

/**
 * 同步启发式推断链接类型
 *
 * 基于三维内容性质维度推断，返回 LinkRelation。
 */
export function inferLinkType(nodeA: NodeInfo, nodeB: NodeInfo): LinkRelation {
  // 1. 一方是结晶 → summarizes
  if (nodeA.is_crystal || nodeB.is_crystal) {
    return { type: 'summarizes', confidence: 0.8 };
  }

  const aAct = nodeA.actuality ?? 0.5;
  const bAct = nodeB.actuality ?? 0.5;
  const aSub = nodeA.subjectivity ?? 0.3;
  const bSub = nodeB.subjectivity ?? 0.3;
  const aSpec = nodeA.specificity ?? 0.5;
  const bSpec = nodeB.specificity ?? 0.5;

  // 2. actuality 差距大（一个确立一个推测）→ part_of
  if (Math.abs(aAct - bAct) > 0.5) {
    return { type: 'part_of', confidence: 0.5 };
  }

  // 3. 都是高 actuality + 低 subjectivity（客观事实互证）→ supports
  if (aAct > 0.6 && bAct > 0.6 && aSub < 0.4 && bSub < 0.4) {
    return { type: 'supports', confidence: 0.6 };
  }

  // 4. 都是高 subjectivity（主观认知关联）→ analogous
  if (aSub > 0.6 && bSub > 0.6) {
    return { type: 'analogous', confidence: 0.5 };
  }

  // 5. 有一方高 specificity（具体情景关联）→ continues
  if (aSpec > 0.7 || bSpec > 0.7) {
    return { type: 'continues', confidence: 0.5 };
  }

  // 默认
  return { type: 'analogous', confidence: 0.4 };
}


