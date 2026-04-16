/**
 * utils/freshness.ts 单元测试
 *
 * 纯函数：基于 heat + 时间的新鲜度标注。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// mock logger
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { computeFreshness } from '../../src/utils/freshness.js';
import { makeNode } from '../helpers/fixtures.js';
import type { RecallNodeLink } from '../../src/types.js';

// 固定 Date.now 以便精确测试天数
const NOW = new Date('2026-04-08T12:00:00Z').getTime();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeFreshness', () => {
  // ===== 高热度：无需标注 =====

  it('高热度 (>=0.5) 节点不标注', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({ heat: 0.8, created: '2025-01-01T00:00:00Z' });
    expect(computeFreshness(node)).toBeUndefined();
  });

  it('热度恰好 0.5 不标注', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({ heat: 0.5, created: '2025-01-01T00:00:00Z' });
    expect(computeFreshness(node)).toBeUndefined();
  });

  // ===== 中等热度 + 近期：无需标注 =====

  it('中等热度 (>=0.2) + 7天内更新不标注', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0.3,
      created: '2026-04-05T00:00:00Z', // 3 天前
    });
    expect(computeFreshness(node)).toBeUndefined();
  });

  // ===== 低热度但不太旧 =====

  it('低热度 (>=0.1) + 30天内 → "较早记忆"', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0.15,
      created: '2026-03-20T00:00:00Z', // 19 天前
    });
    const result = computeFreshness(node);
    expect(result).toContain('较早记忆');
    expect(result).toContain('验证');
  });

  // ===== 很冷或很旧 =====

  it('极低热度 + 很旧 → "较旧记忆" + 天数', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0.05,
      created: '2025-06-01T00:00:00Z', // ~310 天前
    });
    const result = computeFreshness(node);
    expect(result).toContain('较旧记忆');
    expect(result).toMatch(/\d+天前更新/);
  });

  it('热度 0 + 30天以上 → 标注旧记忆', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0,
      created: '2026-01-01T00:00:00Z', // ~97 天前
    });
    const result = computeFreshness(node);
    expect(result).toContain('较旧记忆');
  });

  // ===== last_reconsolidated 优先于 created =====

  it('优先使用 last_reconsolidated 计算天数', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0.15, // >= 0.1 才走 "较早记忆" 分支
      created: '2020-01-01T00:00:00Z', // 很久之前
      last_reconsolidated: '2026-04-07T00:00:00Z', // 1 天前
    });
    // heat >= 0.1 且天数 1 <= 30 → "较早记忆"
    const result = computeFreshness(node);
    expect(result).toContain('较早记忆');
  });

  // ===== 矛盾信号 =====

  it('检测 contradicts 链接 → 标注矛盾', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({ heat: 0.3, created: '2026-04-05T00:00:00Z' });
    const links: RecallNodeLink[] = [
      {
        node: makeNode(),
        relation: [{ type: 'contradicts', confidence: 0.8 }],
        strength: 0.6,
      },
    ];
    const result = computeFreshness(node, links);
    expect(result).toContain('矛盾信号');
  });

  it('supports 链接不触发矛盾标注', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({ heat: 0.3, created: '2026-04-05T00:00:00Z' });
    const links: RecallNodeLink[] = [
      {
        node: makeNode(),
        relation: [{ type: 'supports', confidence: 0.8 }],
        strength: 0.6,
      },
    ];
    expect(computeFreshness(node, links)).toBeUndefined();
  });

  it('低热度 + 矛盾 → 两条标注合并', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0.05,
      created: '2025-06-01T00:00:00Z',
    });
    const links: RecallNodeLink[] = [
      {
        node: makeNode(),
        relation: [{ type: 'contradicts', confidence: 0.9 }],
        strength: 0.5,
      },
    ];
    const result = computeFreshness(node, links);
    expect(result).toContain('较旧记忆');
    expect(result).toContain('矛盾信号');
    expect(result).toContain('；'); // 用分号连接
  });

  // ===== 无效日期 =====

  it('无效日期视为极旧记忆', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0.05,
      created: 'not-a-date',
      last_reconsolidated: null,
    });
    const result = computeFreshness(node);
    expect(result).toContain('较旧记忆');
    expect(result).toContain('999天前');
  });

  // ===== heat=0 daysSinceUpdate=0 边界 =====

  it('heat=0 daysSinceUpdate=0 (当天创建) → 无需标注', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0,
      created: new Date(NOW - 1000).toISOString(), // 1 秒前
    });
    // daysSinceUpdate < 1, so "新节点" branch → undefined
    expect(computeFreshness(node)).toBeUndefined();
  });

  it('heat=0 daysSinceUpdate=1 → "较旧记忆"', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0,
      created: new Date(NOW - 2 * 86_400_000).toISOString(), // 2 天前
    });
    // heat=0 < 0.1 and daysSinceUpdate=2 > 1 → 走 "很冷或很旧" 分支
    const result = computeFreshness(node);
    expect(result).toContain('较旧记忆');
  });

  it('heat=0.09 daysSinceUpdate=0 (当天创建) → 无需标注', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const node = makeNode({
      heat: 0.09,
      created: new Date(NOW - 3600_000).toISOString(), // 1 小时前
    });
    expect(computeFreshness(node)).toBeUndefined();
  });
});
