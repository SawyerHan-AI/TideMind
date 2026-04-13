/**
 * similarity.ts 单元测试
 */
import { describe, it, expect } from 'vitest';
import { l2DistanceToSimilarity } from '../../src/utils/similarity.js';

describe('l2DistanceToSimilarity', () => {
  it('距离为 0 → 相似度为 1', () => {
    expect(l2DistanceToSimilarity(0)).toBe(1);
  });

  it('距离为 √2 → 相似度为 0（正交向量）', () => {
    expect(l2DistanceToSimilarity(Math.sqrt(2))).toBe(0);
  });

  it('距离为 1 → 相似度为 0.5', () => {
    expect(l2DistanceToSimilarity(1)).toBe(0.5);
  });

  it('超过 √2 的距离被 clamp 到 0', () => {
    expect(l2DistanceToSimilarity(2)).toBe(0);
    expect(l2DistanceToSimilarity(10)).toBe(0);
  });

  it('负距离被 clamp 到 1（公式结果 > 1）', () => {
    // 负距离在数学上无意义，但公式 1 - d²/2 对负数也成立
    // d = -0.5 → 1 - 0.25/2 = 0.875，仍在 [0,1] 内
    expect(l2DistanceToSimilarity(-0.5)).toBeCloseTo(0.875);
  });

  it('中间值的连续性', () => {
    const d1 = l2DistanceToSimilarity(0.3);
    const d2 = l2DistanceToSimilarity(0.5);
    const d3 = l2DistanceToSimilarity(0.8);

    // 距离越大，相似度越低
    expect(d1).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(d3);
  });

  it('返回值始终在 [0, 1] 区间', () => {
    const testValues = [0, 0.1, 0.5, 1, 1.41, 1.5, 2, 5, -1];
    for (const d of testValues) {
      const result = l2DistanceToSimilarity(d);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});
