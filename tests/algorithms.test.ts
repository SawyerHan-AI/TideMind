/**
 * 核心算法单元测试
 *
 * 测试纯计算逻辑，不依赖数据库或 LLM。
 * 用 vi.mock 替换 strategy loader 以提供确定性参数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock strategy loader（在所有 import 之前） ----
vi.mock('../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const defaults: Record<string, number> = {
      heat_weight: 0.2,
      refinement_weight: 0.3,
      connectivity_weight: 0.3,
      independence_weight: 0.2,
      alpha: 0.3,
      beta: 0.5,
      gamma: 0.1,
      delta: 0.1,
      decay_base_rate: 0.95,
      decay_connectivity_bonus: 0.02,
      decay_connectivity_cap: 5,
      archive_heat_threshold: 0.05,
      archive_refinement_threshold: 0.3,
      archive_connectivity_threshold: 0.2,
    };
    return defaults[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

// ---- 测试 maturity_score 计算 ----

describe('computeMaturityScore', () => {
  // Import after mock setup
  let computeMaturityScore: (h: number, r: number, c: number, i: number) => number;

  beforeEach(async () => {
    const mod = await import('../src/graph/maturity.js');
    computeMaturityScore = mod.computeMaturityScore;
  });

  it('应该对全零维度返回 0', () => {
    expect(computeMaturityScore(0, 0, 0, 0)).toBe(0);
  });

  it('应该对全满维度返回接近 1', () => {
    // heat capped at 1, all dims = 1
    const score = computeMaturityScore(1, 1, 1, 1);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('heat > 1 时应该被 cap 在 1', () => {
    const scoreHigh = computeMaturityScore(10, 0, 0, 0);
    const scoreCap = computeMaturityScore(1, 0, 0, 0);
    expect(scoreHigh).toBeCloseTo(scoreCap, 5);
  });

  it('应该返回 0-1 之间的值', () => {
    const cases = [
      [0.5, 0.3, 0.7, 0.1],
      [2.0, 0.8, 0.2, 0.9],
      [0.01, 0.01, 0.01, 0.01],
    ];
    for (const [h, r, c, i] of cases) {
      const score = computeMaturityScore(h, r, c, i);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('权重正确：默认 0.2h + 0.3r + 0.3c + 0.2i', () => {
    const score = computeMaturityScore(1, 0.5, 0.5, 1);
    const expected = 0.2 * 1 + 0.3 * 0.5 + 0.3 * 0.5 + 0.2 * 1;
    expect(score).toBeCloseTo(expected, 5);
  });
});

// ---- 测试突触缩放衰减公式 ----

describe('synaptic scaling decay formula', () => {
  // 直接测试公式逻辑，不依赖模块
  function computeDecay(heat: number, connectivity: number): number {
    const decayBase = 0.95;
    const decayBonus = 0.02;
    const decayCap = 5;
    const decayRate = decayBase + decayBonus * Math.min(connectivity * 10, decayCap);
    return heat * decayRate;
  }

  function shouldArchive(heat: number, refinement: number, connectivity: number, isKeystone: boolean): boolean {
    return heat < 0.05 && refinement < 0.3 && connectivity < 0.2 && !isKeystone;
  }

  it('connectivity=0 时衰减 5%', () => {
    const newHeat = computeDecay(1.0, 0);
    expect(newHeat).toBeCloseTo(0.95, 5);
  });

  it('connectivity=0.3 时几乎不衰减', () => {
    // 0.95 + 0.02 * min(3, 5) = 0.95 + 0.06 = 1.01
    const newHeat = computeDecay(1.0, 0.3);
    expect(newHeat).toBeCloseTo(1.01, 5);
  });

  it('connectivity=0.5+ 时实际增长', () => {
    // 0.95 + 0.02 * min(5, 5) = 0.95 + 0.10 = 1.05
    const newHeat = computeDecay(1.0, 0.5);
    expect(newHeat).toBeCloseTo(1.05, 5);
  });

  it('connectivity > 0.5 不会超过 cap', () => {
    // 0.95 + 0.02 * min(10, 5) = 0.95 + 0.10 = 1.05
    const newHeat = computeDecay(1.0, 1.0);
    expect(newHeat).toBeCloseTo(1.05, 5);
  });

  it('归档条件：低热度 + 低精炼 + 低连通 + 非关键种', () => {
    expect(shouldArchive(0.04, 0.2, 0.1, false)).toBe(true);
  });

  it('归档条件：关键种保护', () => {
    expect(shouldArchive(0.04, 0.2, 0.1, true)).toBe(false);
  });

  it('归档条件：任一维度足够高就不归档', () => {
    expect(shouldArchive(0.04, 0.5, 0.1, false)).toBe(false); // refinement 够高
    expect(shouldArchive(0.04, 0.2, 0.3, false)).toBe(false); // connectivity 够高
    expect(shouldArchive(0.06, 0.2, 0.1, false)).toBe(false); // heat 够高
  });

  it('多次衰减后孤立节点应该被归档', () => {
    let heat = 1.0;
    let steps = 0;
    while (heat >= 0.05 && steps < 200) {
      heat = computeDecay(heat, 0);
      steps++;
    }
    expect(heat).toBeLessThan(0.05);
    expect(steps).toBeLessThan(100); // 应该在合理步数内衰减到归档阈值
  });

  it('高连通度节点在多次衰减后不会衰减到归档阈值', () => {
    let heat = 1.0;
    for (let i = 0; i < 100; i++) {
      heat = computeDecay(heat, 0.5);
    }
    // connectivity=0.5 → decay rate = 1.05，所以 heat 应该增长
    expect(heat).toBeGreaterThan(1.0);
  });
});

// ---- 测试 BM25 归一化 ----

describe('BM25 normalization', () => {
  function normalizeScores(scores: number[]): number[] {
    if (scores.length <= 1) return scores.map(() => 1.0);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    if (max === min) return scores.map(() => 1.0);
    return scores.map(s => (s - min) / (max - min));
  }

  it('单个结果应该是 1.0', () => {
    expect(normalizeScores([5.0])).toEqual([1.0]);
  });

  it('两个结果应该是 0 和 1', () => {
    const result = normalizeScores([3.0, 7.0]);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(1, 5);
  });

  it('相同分数应该全是 1.0', () => {
    expect(normalizeScores([5.0, 5.0, 5.0])).toEqual([1.0, 1.0, 1.0]);
  });

  it('归一化后所有值应在 [0, 1]', () => {
    const scores = [1.5, 3.2, 0.8, 7.1, 15.0];
    const normalized = normalizeScores(scores);
    for (const s of normalized) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('归一化应保持相对顺序', () => {
    const scores = [2.0, 5.0, 3.0, 8.0];
    const normalized = normalizeScores(scores);
    expect(normalized[1]).toBeGreaterThan(normalized[0]);
    expect(normalized[2]).toBeGreaterThan(normalized[0]);
    expect(normalized[3]).toBeGreaterThan(normalized[1]);
  });
});

// ---- 测试向量距离→相似度转换 ----

describe('vector distance to similarity', () => {
  // 正确公式：对归一化向量，cos_sim = 1 - dist²/2
  function distanceToSimilarity(distance: number): number {
    return Math.max(0, Math.min(1, 1 - (distance * distance) / 2));
  }

  it('距离 0 → 相似度 1', () => {
    expect(distanceToSimilarity(0)).toBe(1);
  });

  it('距离 sqrt(2) → 相似度 0（正交向量）', () => {
    expect(distanceToSimilarity(Math.sqrt(2))).toBeCloseTo(0, 5);
  });

  it('距离 2 → 相似度 0（clamp 到 0，不变负数）', () => {
    expect(distanceToSimilarity(2)).toBe(0);
  });

  it('中间距离的合理性', () => {
    // dist=1 → sim = 1 - 0.5 = 0.5
    expect(distanceToSimilarity(1)).toBeCloseTo(0.5, 5);
  });

  it('结果始终在 [0, 1]', () => {
    for (const d of [0, 0.1, 0.5, 1.0, 1.414, 2.0, 3.0]) {
      const sim = distanceToSimilarity(d);
      expect(sim).toBeGreaterThanOrEqual(0);
      expect(sim).toBeLessThanOrEqual(1);
    }
  });

  it('距离越大相似度越小（单调递减）', () => {
    const distances = [0, 0.3, 0.6, 1.0, 1.414];
    const similarities = distances.map(distanceToSimilarity);
    for (let i = 1; i < similarities.length; i++) {
      expect(similarities[i]).toBeLessThan(similarities[i - 1]);
    }
  });
});

// ---- 测试混合搜索权重公式 ----

describe('hybrid search scoring', () => {
  function computeHybridScore(
    bm25: number,
    vector: number,
    heat: number,
    maturity: number,
    alpha = 0.3,
    beta = 0.5,
    gamma = 0.1,
    delta = 0.1,
  ): number {
    const maxHeat = 10.0;
    const heatBonus = Math.log(1 + heat) / Math.log(1 + maxHeat);
    return alpha * bm25 + beta * vector + gamma * heatBonus + delta * maturity;
  }

  it('所有信号为 0 时分数为 0', () => {
    expect(computeHybridScore(0, 0, 0, 0)).toBeCloseTo(0, 5);
  });

  it('BM25 满分 + 其他为 0 → 分数为 alpha', () => {
    expect(computeHybridScore(1, 0, 0, 0)).toBeCloseTo(0.3, 5);
  });

  it('向量满分 + 其他为 0 → 分数为 beta', () => {
    expect(computeHybridScore(0, 1, 0, 0)).toBeCloseTo(0.5, 5);
  });

  it('creative intent 更偏向向量', () => {
    // 当向量分 > BM25 分时，creative 模式分数更高
    const normal = computeHybridScore(0.3, 0.9, 0, 0, 0.3, 0.5);   // 0.3*0.3 + 0.5*0.9 = 0.54
    const creative = computeHybridScore(0.3, 0.9, 0, 0, 0.2, 0.6); // 0.2*0.3 + 0.6*0.9 = 0.60
    expect(creative).toBeGreaterThan(normal);
  });

  it('heat bonus 使用对数缩放', () => {
    // heat=1 vs heat=10，差距不应太大
    const low = computeHybridScore(0, 0, 1, 0);
    const high = computeHybridScore(0, 0, 10, 0);
    expect(high).toBeGreaterThan(low);
    expect(high / low).toBeLessThan(5); // 对数缩放应压缩差距
  });
});

// ---- 测试 connectivity 计算 ----

describe('connectivity computation', () => {
  function computeConnectivity(
    linkCount: number,
    avgStrength: number,
    relationTypeCount: number,
  ): number {
    if (linkCount === 0) return 0;
    const baseConnectivity = Math.min(1, (linkCount * avgStrength) / 5);
    const diversityBonus = Math.min(0.25, (relationTypeCount - 1) * 0.05);
    return Math.min(1, baseConnectivity * (1 + diversityBonus));
  }

  it('无链接 → 0', () => {
    expect(computeConnectivity(0, 0, 0)).toBe(0);
  });

  it('5 条 strength=1 链接 → base = 1', () => {
    expect(computeConnectivity(5, 1.0, 1)).toBeCloseTo(1.0, 5);
  });

  it('2 条 strength=0.8 → base = 0.32', () => {
    const result = computeConnectivity(2, 0.8, 1);
    expect(result).toBeCloseTo(0.32, 5);
  });

  it('多样性加成', () => {
    const singleType = computeConnectivity(3, 0.8, 1);
    const multiType = computeConnectivity(3, 0.8, 4);
    expect(multiType).toBeGreaterThan(singleType);
  });

  it('多样性加成上限 25%', () => {
    const bonus5 = computeConnectivity(3, 0.8, 6);
    const bonus10 = computeConnectivity(3, 0.8, 11);
    expect(bonus5).toBeCloseTo(bonus10, 5); // 都达到 25% 上限
  });

  it('结果始终在 [0, 1]', () => {
    const cases = [
      [10, 1.0, 6],
      [1, 0.1, 1],
      [20, 1.0, 10],
    ];
    for (const [links, strength, types] of cases) {
      const result = computeConnectivity(links, strength, types);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});
