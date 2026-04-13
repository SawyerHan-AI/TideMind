/**
 * 将 L2 距离转换为余弦相似度
 *
 * 对于归一化向量（nomic-embed-text 等现代模型默认输出归一化向量）：
 *   cos_sim = 1 - dist² / 2
 *
 * 结果被 clamp 到 [0, 1] 区间。
 */
export function l2DistanceToSimilarity(distance: number): number {
  return Math.max(0, Math.min(1, 1 - (distance * distance) / 2));
}
