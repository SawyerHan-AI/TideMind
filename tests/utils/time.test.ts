/**
 * time 工具函数单元测试
 */
import { describe, it, expect } from 'vitest';
import { now, today, hoursAgo, daysAgo } from '../../src/utils/time.js';

describe('now', () => {
  it('返回 ISO 格式字符串 (包含 T)', () => {
    const result = now();
    expect(result).toContain('T');
    // ISO 格式包含 Z 或时区偏移
    expect(result).toMatch(/Z|[+-]\d{2}:\d{2}/);
  });
});

describe('today', () => {
  it('返回 YYYY-MM-DD 格式', () => {
    const result = today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('hoursAgo', () => {
  it('正确计算过去时间的小时数', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = hoursAgo(twoHoursAgo);
    expect(result).toBeCloseTo(2, 0);
  });
});

describe('daysAgo', () => {
  it('正确计算过去时间的天数', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = daysAgo(threeDaysAgo);
    expect(result).toBeCloseTo(3, 0);
  });

  it('近期日期返回较小数值', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = daysAgo(oneHourAgo);
    expect(result).toBeLessThan(1);
    expect(result).toBeGreaterThan(0);
  });
});
