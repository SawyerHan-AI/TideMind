/**
 * dimensions.ts 单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  deriveCategory,
  dimensionsToLegacyType,
  legacyTypeToDimensions,
  inferDimensions,
  type ContentDimensions,
} from '../../src/utils/dimensions.js';

// ===== deriveCategory =====

describe('deriveCategory', () => {
  it('低 actuality + 高 subjectivity → intention', () => {
    expect(deriveCategory({ specificity: 0.5, subjectivity: 0.7, actuality: 0.2 })).toBe('intention');
  });

  it('低 actuality + 低 subjectivity → hypothesis', () => {
    expect(deriveCategory({ specificity: 0.5, subjectivity: 0.3, actuality: 0.2 })).toBe('hypothesis');
  });

  it('高 actuality + 高 subjectivity → belief', () => {
    expect(deriveCategory({ specificity: 0.5, subjectivity: 0.7, actuality: 0.8 })).toBe('belief');
  });

  it('高 actuality + 低 subjectivity + 高 specificity → record', () => {
    expect(deriveCategory({ specificity: 0.8, subjectivity: 0.3, actuality: 0.8 })).toBe('record');
  });

  it('高 actuality + 低 subjectivity + 低 specificity → knowledge', () => {
    expect(deriveCategory({ specificity: 0.2, subjectivity: 0.3, actuality: 0.8 })).toBe('knowledge');
  });

  it('边界值 actuality = 0.4 走 >= 0.4 分支', () => {
    // actuality = 0.4 不满足 < 0.4，进入 subjectivity 判断
    expect(deriveCategory({ specificity: 0.5, subjectivity: 0.7, actuality: 0.4 })).toBe('belief');
  });

  it('边界值 subjectivity = 0.5 走 <= 0.5 分支', () => {
    // subjectivity = 0.5 不满足 > 0.5
    expect(deriveCategory({ specificity: 0.8, subjectivity: 0.5, actuality: 0.8 })).toBe('record');
  });

  it('边界值 specificity = 0.5 走 <= 0.5 分支', () => {
    // specificity = 0.5 不满足 > 0.5
    expect(deriveCategory({ specificity: 0.5, subjectivity: 0.3, actuality: 0.8 })).toBe('knowledge');
  });
});

// ===== dimensionsToLegacyType =====

describe('dimensionsToLegacyType', () => {
  it('record → fact', () => {
    expect(dimensionsToLegacyType({ specificity: 0.8, subjectivity: 0.3, actuality: 0.8 })).toBe('fact');
  });

  it('knowledge → fact', () => {
    expect(dimensionsToLegacyType({ specificity: 0.2, subjectivity: 0.3, actuality: 0.8 })).toBe('fact');
  });

  it('belief → preference', () => {
    expect(dimensionsToLegacyType({ specificity: 0.5, subjectivity: 0.7, actuality: 0.8 })).toBe('preference');
  });

  it('hypothesis → idea', () => {
    expect(dimensionsToLegacyType({ specificity: 0.5, subjectivity: 0.3, actuality: 0.2 })).toBe('idea');
  });

  it('intention → idea', () => {
    expect(dimensionsToLegacyType({ specificity: 0.5, subjectivity: 0.7, actuality: 0.2 })).toBe('idea');
  });
});

// ===== legacyTypeToDimensions =====

describe('legacyTypeToDimensions', () => {
  it('fact → 高 actuality 低 subjectivity', () => {
    const d = legacyTypeToDimensions('fact');
    expect(d.actuality).toBeGreaterThan(0.5);
    expect(d.subjectivity).toBeLessThan(0.5);
  });

  it('preference → 高 subjectivity', () => {
    const d = legacyTypeToDimensions('preference');
    expect(d.subjectivity).toBeGreaterThan(0.5);
  });

  it('idea → 低 actuality', () => {
    const d = legacyTypeToDimensions('idea');
    expect(d.actuality).toBeLessThan(0.5);
  });

  it('crystal → 有合理默认值', () => {
    const d = legacyTypeToDimensions('crystal');
    expect(d.specificity).toBeDefined();
    expect(d.subjectivity).toBeDefined();
    expect(d.actuality).toBeDefined();
  });

  it('未知类型 → 中间值', () => {
    const d = legacyTypeToDimensions('unknown_type');
    expect(d.specificity).toBe(0.5);
    expect(d.subjectivity).toBe(0.5);
    expect(d.actuality).toBe(0.5);
  });

  it('所有已知类型的往返转换合理', () => {
    const knownTypes = ['fact', 'context', 'preference', 'idea', 'crystal', 'meta', 'tag'];
    for (const type of knownTypes) {
      const d = legacyTypeToDimensions(type);
      // 所有维度在 [0, 1] 区间
      expect(d.specificity).toBeGreaterThanOrEqual(0);
      expect(d.specificity).toBeLessThanOrEqual(1);
      expect(d.subjectivity).toBeGreaterThanOrEqual(0);
      expect(d.subjectivity).toBeLessThanOrEqual(1);
      expect(d.actuality).toBeGreaterThanOrEqual(0);
      expect(d.actuality).toBeLessThanOrEqual(1);
    }
  });
});

// ===== inferDimensions =====

describe('inferDimensions', () => {
  it('默认值: 无信号时返回中间偏低值', () => {
    const d = inferDimensions('一段普通的文本内容');
    expect(d.specificity).toBe(0.5);
    expect(d.subjectivity).toBe(0.3);
    expect(d.actuality).toBe(0.7);
  });

  // --- 具体性 ---

  it('包含日期 → 高 specificity', () => {
    expect(inferDimensions('2024-03-15 参加了会议').specificity).toBe(0.8);
    expect(inferDimensions('2024年3月的报告').specificity).toBe(0.8);
    expect(inferDimensions('2024/03/15 发布').specificity).toBe(0.8);
  });

  it('包含时间词 → 高 specificity', () => {
    expect(inferDimensions('今天开了个会').specificity).toBe(0.8);
    expect(inferDimensions('昨天修了个 bug').specificity).toBe(0.8);
    expect(inferDimensions('上周的讨论').specificity).toBe(0.8);
    expect(inferDimensions('I met him today').specificity).toBe(0.8);
    expect(inferDimensions('yesterday was great').specificity).toBe(0.8);
  });

  it('包含一般性词 → 低 specificity', () => {
    expect(inferDimensions('一般来说这样做比较好').specificity).toBe(0.2);
    expect(inferDimensions('通常这是最佳实践').specificity).toBe(0.2);
    expect(inferDimensions('This is always true').specificity).toBe(0.2);
    expect(inferDimensions('usually this works').specificity).toBe(0.2);
  });

  // --- 主观性 ---

  it('包含偏好词 → 高 subjectivity', () => {
    expect(inferDimensions('我觉得这个方案不好').subjectivity).toBe(0.8);
    expect(inferDimensions('我喜欢用 TypeScript').subjectivity).toBe(0.8);
    expect(inferDimensions('I prefer dark mode').subjectivity).toBe(0.8);
    expect(inferDimensions('I feel this is wrong').subjectivity).toBe(0.8);
    expect(inferDimensions('讨厌写文档').subjectivity).toBe(0.8);
  });

  it('包含决定词 → 中 subjectivity', () => {
    expect(inferDimensions('决定使用 React').subjectivity).toBe(0.5);
    expect(inferDimensions('选择了方案 A').subjectivity).toBe(0.5);
  });

  // --- 确定性 ---

  it('包含不确定词 → 低 actuality', () => {
    expect(inferDimensions('也许可以试试这个方法').actuality).toBe(0.2);
    expect(inferDimensions('可能是因为缓存问题').actuality).toBe(0.2);
    expect(inferDimensions('maybe we should refactor').actuality).toBe(0.2);
    expect(inferDimensions('it might work').actuality).toBe(0.2);
  });

  it('包含确定词 → 高 actuality', () => {
    expect(inferDimensions('确定这是 root cause').actuality).toBe(0.9);
    expect(inferDimensions('已经完成了部署').actuality).toBe(0.9);
    expect(inferDimensions('This is confirmed working').actuality).toBe(0.9);
    expect(inferDimensions('Task is done').actuality).toBe(0.9);
  });

  // --- 多信号组合 ---

  it('多维度同时触发', () => {
    const d = inferDimensions('我觉得也许可以试试这个方案');
    expect(d.subjectivity).toBe(0.8); // 我觉得
    expect(d.actuality).toBe(0.2);    // 也许
  });

  // --- 大小写不敏感 ---

  it('英文关键词大小写不敏感', () => {
    expect(inferDimensions('MAYBE we should wait').actuality).toBe(0.2);
    expect(inferDimensions('I PREFER this').subjectivity).toBe(0.8);
  });
});
