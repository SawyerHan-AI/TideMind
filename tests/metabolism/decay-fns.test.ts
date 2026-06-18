/**
 * M8 A 类代谢纯函数 golden-vector 测试。确定性 + 公式正确性,两端重算一致性的基石。
 */

import { describe, it, expect } from 'vitest';
import {
  heatDecayRate, decayHeat, computeConnectivity, computeMaturityScore, isTaggedRelation,
} from '../../src/metabolism/decay-fns.js';

describe('M8 decay-fns heatDecayRate(connectivity 加权)', () => {
  it('conn=0 → 0.95', () => expect(heatDecayRate(0)).toBeCloseTo(0.95, 10));
  it('conn=0.5 → 0.97', () => expect(heatDecayRate(0.5)).toBeCloseTo(0.97, 10));
  it('conn=1 → 0.99', () => expect(heatDecayRate(1)).toBeCloseTo(0.99, 10));
  it('conn>1 钳到 1 → 0.99', () => expect(heatDecayRate(5)).toBeCloseTo(0.99, 10));
  it('自定义 params', () => expect(heatDecayRate(0, { base: 0.1, damping: 0.5 })).toBeCloseTo(0.9, 10));
});

describe('M8 decayHeat(generation-anchored)', () => {
  it('generations=0 原样返回', () => expect(decayHeat(0.8, 0.5, 0)).toBe(0.8));
  it('generations<0 原样返回', () => expect(decayHeat(0.8, 0.5, -3)).toBe(0.8));
  it('1 代 = heat × rate(conn=0)', () => expect(decayHeat(1, 0, 1)).toBeCloseTo(0.95, 10));
  it('N 代 = heat × rate^N(确定性)', () => {
    expect(decayHeat(1, 0.5, 10)).toBeCloseTo(Math.pow(heatDecayRate(0.5), 10), 12);
  });
  it('可分解:decayHeat(h,c,a+b) == decayHeat(decayHeat(h,c,a),c,b)', () => {
    const step = decayHeat(decayHeat(0.9, 0.3, 7), 0.3, 5);
    expect(decayHeat(0.9, 0.3, 12)).toBeCloseTo(step, 12);
  });
  it('golden vector:heat=1 conn=0 衰减 30 代 ≈ 0.95^30', () => {
    expect(decayHeat(1, 0, 30)).toBeCloseTo(Math.pow(0.95, 30), 12);
  });
});

describe('M8 computeConnectivity(strength × diversity,排除 tagged)', () => {
  const link = (strength: number, types: string[], isTagged = false) => ({ strength, relationTypes: types, isTagged });
  it('无链接 → 0', () => expect(computeConnectivity([])).toBe(0));
  it('全 tagged → 0', () => expect(computeConnectivity([link(0.8, ['tagged'], true)])).toBe(0));
  it('5 条 strength=1 单一 type → base 封顶 1', () => {
    expect(computeConnectivity(Array.from({ length: 5 }, () => link(1, ['supports'])))).toBeCloseTo(1, 10);
  });
  it('1 条 strength=0.5 → base 0.1 无 diversity', () => {
    expect(computeConnectivity([link(0.5, ['supports'])])).toBeCloseTo(0.1, 10);
  });
  it('3 条不同 type strength=0.5 → base 0.3 × (1+0.1) = 0.33', () => {
    expect(computeConnectivity([link(0.5, ['a']), link(0.5, ['b']), link(0.5, ['c'])])).toBeCloseTo(0.33, 10);
  });
  it('排除 tagged 后只算语义链接', () => {
    expect(computeConnectivity([link(0.5, ['supports']), link(0.9, ['tagged'], true)])).toBeCloseTo(0.1, 10);
  });
});

describe('M8 computeMaturityScore(加权汇总)', () => {
  it('默认权重 0.2/0.3/0.3/0.2', () => {
    // 0.2*1 + 0.3*0.5 + 0.3*0.4 + 0.2*0.6 = 0.59
    expect(computeMaturityScore(1, 0.5, 0.4, 0.6)).toBeCloseTo(0.59, 10);
  });
  it('heat 钳到 1', () => expect(computeMaturityScore(5, 0, 0, 0)).toBeCloseTo(0.2, 10));
  it('自定义权重', () => {
    expect(computeMaturityScore(1, 0, 0, 0, { heat: 1, refinement: 0, connectivity: 0, independence: 0 })).toBeCloseTo(1, 10);
  });
});

describe('M8.3 isTaggedRelation(主 confidence 的 type==tagged)', () => {
  it('空/非数组 → false', () => {
    expect(isTaggedRelation([])).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isTaggedRelation(undefined as any)).toBe(false);
  });
  it('主关系(最高 confidence)type=tagged → true', () => {
    expect(isTaggedRelation([{ type: 'tagged', confidence: 0.9 }])).toBe(true);
    expect(isTaggedRelation([{ type: 'supports', confidence: 0.3 }, { type: 'tagged', confidence: 0.8 }])).toBe(true);
  });
  it('主关系非 tagged(含 tagged 但非最高)→ false', () => {
    expect(isTaggedRelation([{ type: 'supports', confidence: 0.9 }, { type: 'tagged', confidence: 0.3 }])).toBe(false);
  });
});
