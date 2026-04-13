// ============================================================
// 初始热度计算
//
// 根据时间因子和结构因子计算 Logseq 笔记导入时的初始 heat。
// 纯函数模块，无副作用。
// ============================================================

import type { InferredDateInfo } from './time-inference.js';

/**
 * 计算时间因子
 *
 * T_effective = max(创建时间, 最后被引用时间)
 * age_days = 导入日 - T_effective
 * 时间因子 = 0.15 + 0.85 × e^(-age_days / 365)
 *
 * 范围：[0.15, 1.0]
 */
export function computeTimeFactor(
  dateInfo: InferredDateInfo | undefined,
  importDate: string,
): number {
  if (!dateInfo) return 0.15;

  // T_effective = max(date, lastRef)
  const tEffective = (dateInfo.lastRef && dateInfo.lastRef > dateInfo.date)
    ? dateInfo.lastRef
    : dateInfo.date;

  const importMs = new Date(importDate).getTime();
  const effectiveMs = new Date(tEffective).getTime();
  const ageDays = Math.max(0, (importMs - effectiveMs) / (1000 * 60 * 60 * 24));

  return 0.15 + 0.85 * Math.exp(-ageDays / 365);
}

/**
 * 计算结构因子
 *
 * 结构因子 = min(1.0 + log2(1 + in_degree) × 0.1, 1.5)
 *
 * 范围：[1.0, 1.5]
 */
export function computeStructureFactor(inDegree: number): number {
  return Math.min(1.0 + Math.log2(1 + inDegree) * 0.1, 1.5);
}

/**
 * 计算初始 heat
 *
 * 初始 heat = 时间因子 × 结构因子
 */
export function computeInitialHeat(
  dateInfo: InferredDateInfo | undefined,
  inDegree: number,
  importDate: string,
): number {
  const timeFactor = computeTimeFactor(dateInfo, importDate);
  const structureFactor = computeStructureFactor(inDegree);
  return Math.round(timeFactor * structureFactor * 1000) / 1000;
}
