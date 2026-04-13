/**
 * 初始热度计算单元测试
 */
import { describe, it, expect } from 'vitest';
import { computeTimeFactor, computeStructureFactor, computeInitialHeat } from '../../../src/integrations/logseq/initial-heat.js';
import type { InferredDateInfo } from '../../../src/integrations/logseq/time-inference.js';

describe('computeTimeFactor', () => {
  const importDate = '2026-04-07';

  it('今天的笔记 → ~1.0', () => {
    const info: InferredDateInfo = { date: '2026-04-07', source: 'journal_ref' };
    const factor = computeTimeFactor(info, importDate);
    expect(factor).toBeCloseTo(1.0, 1);
  });

  it('半年前 → ~0.65', () => {
    const info: InferredDateInfo = { date: '2025-10-07', source: 'journal_ref' };
    const factor = computeTimeFactor(info, importDate);
    expect(factor).toBeGreaterThan(0.55);
    expect(factor).toBeLessThan(0.75);
  });

  it('1 年前 → ~0.47', () => {
    const info: InferredDateInfo = { date: '2025-04-07', source: 'journal_ref' };
    const factor = computeTimeFactor(info, importDate);
    expect(factor).toBeGreaterThan(0.40);
    expect(factor).toBeLessThan(0.55);
  });

  it('4 年前 → ~0.18', () => {
    const info: InferredDateInfo = { date: '2022-04-07', source: 'journal_ref' };
    const factor = computeTimeFactor(info, importDate);
    expect(factor).toBeGreaterThan(0.15);
    expect(factor).toBeLessThan(0.22);
  });

  it('无时间信息 → 0.15（下限）', () => {
    const factor = computeTimeFactor(undefined, importDate);
    expect(factor).toBe(0.15);
  });

  it('lastRef 比 date 更晚时使用 lastRef', () => {
    const info: InferredDateInfo = {
      date: '2022-01-01',
      source: 'journal_ref',
      firstRef: '2022-01-01',
      lastRef: '2026-04-01', // 很近
    };
    const factor = computeTimeFactor(info, importDate);
    // 应该用 lastRef（6 天前），而不是 date（4年前）
    expect(factor).toBeGreaterThan(0.95);
  });

  it('下限不低于 0.15', () => {
    const info: InferredDateInfo = { date: '2010-01-01', source: 'fallback' };
    const factor = computeTimeFactor(info, importDate);
    expect(factor).toBeGreaterThanOrEqual(0.15);
  });
});

describe('computeStructureFactor', () => {
  it('in_degree=0 → 1.0', () => {
    expect(computeStructureFactor(0)).toBe(1.0);
  });

  it('in_degree=3 → ~1.2', () => {
    const factor = computeStructureFactor(3);
    expect(factor).toBeGreaterThan(1.15);
    expect(factor).toBeLessThan(1.25);
  });

  it('in_degree=7 → ~1.3', () => {
    const factor = computeStructureFactor(7);
    expect(factor).toBeGreaterThan(1.25);
    expect(factor).toBeLessThan(1.35);
  });

  it('in_degree=31 → 接近 1.5', () => {
    const factor = computeStructureFactor(31);
    expect(factor).toBeGreaterThan(1.45);
    expect(factor).toBeLessThanOrEqual(1.5);
  });

  it('in_degree=500 → 封顶 1.5', () => {
    expect(computeStructureFactor(500)).toBe(1.5);
  });
});

describe('computeInitialHeat', () => {
  const importDate = '2026-04-07';

  it('今天 + 孤岛 → ~1.0', () => {
    const info: InferredDateInfo = { date: '2026-04-07', source: 'journal_ref' };
    const heat = computeInitialHeat(info, 0, importDate);
    expect(heat).toBeCloseTo(1.0, 1);
  });

  it('今天 + 高引用 → > 1.0', () => {
    const info: InferredDateInfo = { date: '2026-04-07', source: 'journal_ref' };
    const heat = computeInitialHeat(info, 10, importDate);
    expect(heat).toBeGreaterThan(1.2);
  });

  it('4 年前 + 孤岛 → ~0.17', () => {
    const info: InferredDateInfo = { date: '2022-04-07', source: 'fallback' };
    const heat = computeInitialHeat(info, 0, importDate);
    expect(heat).toBeGreaterThan(0.15);
    expect(heat).toBeLessThan(0.22);
  });

  it('4 年前 + 高引用 → 结构加成拉回一些', () => {
    const info: InferredDateInfo = { date: '2022-04-07', source: 'journal_ref' };
    const heat = computeInitialHeat(info, 15, importDate);
    expect(heat).toBeGreaterThan(0.22);
    expect(heat).toBeLessThan(0.35);
  });

  it('无时间 + 无引用 → 0.15', () => {
    const heat = computeInitialHeat(undefined, 0, importDate);
    expect(heat).toBe(0.15);
  });

  it('返回值精度为 3 位小数', () => {
    const info: InferredDateInfo = { date: '2024-06-15', source: 'journal_ref' };
    const heat = computeInitialHeat(info, 3, importDate);
    const decimalPlaces = heat.toString().split('.')[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(3);
  });
});
