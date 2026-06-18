/**
 * conflict-heuristics 冲突检测单元测试
 *
 * 测试 detectConflictSignals 纯函数逻辑，不依赖数据库或 LLM。
 */
import { describe, it, expect, vi } from 'vitest';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, param: string, fallback: number) => {
    const defaults: Record<string, number> = {
      conflict_min_overlap: 0.15,
      conflict_high_confidence: 0.85,
      conflict_cross_min_overlap: 0.25,
    };
    return defaults[param] ?? fallback;
  },
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import { detectConflictSignals } from '../../src/metabolism/conflict-heuristics.js';
import { makeNode } from '../helpers/fixtures.js';

describe('detectConflictSignals', () => {
  it('空节点数组 -> 空信号', () => {
    const signals = detectConflictSignals([]);
    expect(signals).toEqual([]);
  });

  it('上下文与节点矛盾：中文否定', () => {
    const node = makeNode({ content: '使用 React 构建前端应用' });
    const context = '我们决定不再使用 React 来构建前端';
    const signals = detectConflictSignals([node], context);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('context_mismatch');
    expect(signals[0].nodeA).toBe(node.id);
  });

  it('跨节点矛盾：中文否定', () => {
    const nodeA = makeNode({ content: '使用 TypeScript 进行开发是最佳实践' });
    const nodeB = makeNode({ content: '不用 TypeScript 改用 JavaScript 来开发' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('cross_node');
    expect(signals[0].nodeA).toBe(nodeA.id);
    expect(signals[0].nodeB).toBe(nodeB.id);
  });

  it('英文否定检测', () => {
    const nodeA = makeNode({ content: 'using Redis for caching layer in production' });
    const nodeB = makeNode({ content: 'no longer using Redis for caching, switched to Memcached' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('cross_node');
  });

  it('共享关键词但无否定 -> 无冲突信号', () => {
    const nodeA = makeNode({ content: 'React 是一个很好的前端框架' });
    const nodeB = makeNode({ content: 'React 的组件化设计很优秀' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(signals).toEqual([]);
  });

  it('置信度随重叠度增加', () => {
    // 高重叠（更多共享关键词）
    const nodeHigh = makeNode({
      content: '使用 React 和 TypeScript 构建前端应用和组件',
    });
    const contextHigh = '不再使用 React 和 TypeScript 构建前端应用和组件';

    // 低重叠
    const nodeLow = makeNode({
      content: '使用 React 构建前端，后端用 Go 和 Python 处理数据',
    });
    const contextLow = '不再使用 React 构建前端，改用 Vue';

    const signalsHigh = detectConflictSignals([nodeHigh], contextHigh);
    const signalsLow = detectConflictSignals([nodeLow], contextLow);

    expect(signalsHigh.length).toBeGreaterThanOrEqual(1);
    expect(signalsLow.length).toBeGreaterThanOrEqual(1);
    expect(signalsHigh[0].confidence).toBeGreaterThanOrEqual(signalsLow[0].confidence);
  });

  it('重叠度低于最低阈值 -> 无信号', () => {
    const node = makeNode({ content: 'React 前端开发框架' });
    const context = '不再使用 Python 进行数据分析和机器学习任务';
    const signals = detectConflictSignals([node], context);
    expect(signals).toEqual([]);
  });

  it('信号按置信度降序排列', () => {
    const nodeA = makeNode({ content: '使用 React 构建前端应用' });
    const nodeB = makeNode({ content: '不再使用 React 构建前端应用' });
    const nodeC = makeNode({ content: '使用 Vue 构建前端' });
    const nodeD = makeNode({ content: '不再使用 Vue 构建前端' });
    const signals = detectConflictSignals([nodeA, nodeB, nodeC, nodeD]);

    for (let i = 1; i < signals.length; i++) {
      expect(signals[i].confidence).toBeLessThanOrEqual(signals[i - 1].confidence);
    }
  });

  it('多个冲突全部返回', () => {
    const nodes = [
      makeNode({ content: '使用 React 构建前端应用和组件' }),
      makeNode({ content: '不再使用 React 构建前端应用和组件' }),
      makeNode({ content: '使用 Redis 进行缓存和数据存储' }),
      makeNode({ content: '不再使用 Redis 进行缓存和数据存储' }),
    ];
    const signals = detectConflictSignals(nodes);
    expect(signals.length).toBeGreaterThanOrEqual(2);
  });

  it('短上下文 (<10字符) 被跳过', () => {
    const node = makeNode({ content: '使用 React 构建前端' });
    const signals = detectConflictSignals([node], '不用React');
    // 上下文长度 < 10，不应产生 context_mismatch
    const contextMatches = signals.filter(s => s.type === 'context_mismatch');
    expect(contextMatches).toEqual([]);
  });

  it('不同话题 (无共享关键词) -> 无信号', () => {
    const nodeA = makeNode({ content: 'Python 机器学习数据分析' });
    const nodeB = makeNode({ content: '不再使用 React 构建前端应用' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(signals).toEqual([]);
  });

  it('无上下文时只检测跨节点冲突', () => {
    const nodeA = makeNode({ content: '使用 Docker 部署服务到生产环境' });
    const nodeB = makeNode({ content: '不再使用 Docker 部署服务到生产环境' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(signals.every(s => s.type === 'cross_node')).toBe(true);
  });

  // ===== regex 特殊字符 =====

  it('内容包含正则特殊字符 (.*+?) 不崩溃', () => {
    const nodeA = makeNode({ content: '使用 regex pattern .* 和 [a-z]+ 匹配文本' });
    const nodeB = makeNode({ content: '不再使用 regex pattern .* 和 [a-z]+ 匹配文本' });
    // 不应抛出异常
    const signals = detectConflictSignals([nodeA, nodeB]);
    // 即使内容有 regex 特殊字符，也应该能正常检测
    expect(Array.isArray(signals)).toBe(true);
  });

  it('内容包含括号 () 和方括号 [] 不崩溃', () => {
    const node = makeNode({ content: 'function(a, b) { return a[0] + b[1]; }' });
    const context = '不再使用 function(a, b) 这个函数来处理数据';
    const signals = detectConflictSignals([node], context);
    expect(Array.isArray(signals)).toBe(true);
  });

  it('内容包含反斜杠不崩溃', () => {
    const nodeA = makeNode({ content: '路径 C:\\Users\\test\\file 存在问题' });
    const nodeB = makeNode({ content: '不再使用路径 C:\\Users\\test\\file 这个目录' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(Array.isArray(signals)).toBe(true);
  });

  it('内容包含 $ ^ | 等 regex 元字符不崩溃', () => {
    const nodeA = makeNode({ content: '使用 $HOME 和 ^prefix$ 以及 A|B 模式' });
    const nodeB = makeNode({ content: '不再使用 $HOME 和 ^prefix$ 以及 A|B 模式' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(Array.isArray(signals)).toBe(true);
  });

  it('内容包含花括号和问号不崩溃', () => {
    const nodeA = makeNode({ content: '使用 template{key} 和 value? 语法来编写代码' });
    const nodeB = makeNode({ content: '不再使用 template{key} 和 value? 语法来编写代码' });
    const signals = detectConflictSignals([nodeA, nodeB]);
    expect(Array.isArray(signals)).toBe(true);
  });

  // ===== 性能回归 =====

  // 回归:hasNegatedOverlap 曾把 extractKeywords(textB) 写在 filter 回调内,
  // CJK bigram 下 O(len²)。30 个 1500 字高重叠中文节点(index 模式默认 limit)
  // 两两配对,修复前实测 ~18s(同步阻塞 daemon event loop),修复后应远低于
  // 5s 上限(发版机器峰值负载下也不应超)。所有文本都含否定词 '不再',
  // 两边同时命中 → 不会提前 return,跑满 keyword × negation 扫描的最坏路径。
  it('30 个长中文高重叠节点两两配对不阻塞秒级', { timeout: 60_000 }, () => {
    const base = '我们不再依赖旧的知识管理流程,而是把智能代理框架引入复杂的知识图谱代谢任务,持续观察召回质量和链接演化的长期趋势。'.repeat(28); // ~1500 字
    const nodes = Array.from({ length: 30 }, (_, i) =>
      makeNode({ content: `${base}补充记录第${i}号实验的结论。` }));
    const context = base.slice(0, 300);

    const t0 = performance.now();
    detectConflictSignals(nodes, context);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5000);
  });
});
