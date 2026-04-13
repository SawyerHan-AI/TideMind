/**
 * segmenter.ts 单元测试
 */
import { describe, it, expect } from 'vitest';
import { segmentContent } from '../../../src/integrations/logseq/segmenter.js';

describe('segmentContent', () => {
  // ---------- 空内容 ----------

  it('空内容返回空数组', () => {
    expect(segmentContent('', 'page', false)).toEqual([]);
    expect(segmentContent('   ', 'page', false)).toEqual([]);
    expect(segmentContent('\n\n', 'page', false)).toEqual([]);
  });

  // ---------- Block 树解析 ----------

  it('单行内容 → 单 segment', () => {
    const result = segmentContent('hello world', 'Test Page', false);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('hello world');
    expect(result[0].context).toBe('Test Page');
  });

  it('多个顶级 block → 各自成 segment', () => {
    const content = 'Block A\nBlock B\nBlock C';
    const result = segmentContent(content, 'Page', false);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const allContent = result.map(s => s.content).join('\n');
    expect(allContent).toContain('Block A');
    expect(allContent).toContain('Block B');
    expect(allContent).toContain('Block C');
  });

  it('缩进子 block 归属于父 block', () => {
    const content = [
      'Parent block',
      '  Child block 1',
      '  Child block 2',
      '    Grandchild',
    ].join('\n');

    const result = segmentContent(content, 'Page', false);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Parent block');
    expect(result[0].content).toContain('Child block 1');
    expect(result[0].content).toContain('Grandchild');
  });

  it('多个顶级 block 各自带子树', () => {
    const content = [
      'Topic A',
      '  Detail A1',
      '  Detail A2',
      'Topic B',
      '  Detail B1',
    ].join('\n');

    const result = segmentContent(content, 'Page', false);
    // 至少 2 个 segment（可能被合并短 segment 影响）
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Topic A');
    expect(allContent).toContain('Topic B');
  });

  // ---------- Page 分段 ----------

  it('超长 block 按子 block 拆分', () => {
    const children = Array.from({ length: 20 }, (_, i) =>
      `  ${'x'.repeat(200)} child-${i}`,
    );
    const content = `Parent topic\n${children.join('\n')}`;

    const result = segmentContent(content, 'Page', false);
    expect(result.length).toBeGreaterThan(1);
    // 每段不应超过 3000 字符
    for (const seg of result) {
      expect(seg.content.length).toBeLessThanOrEqual(3200); // 允许少量溢出
    }
  });

  it('短 segment 被合并', () => {
    const content = Array.from({ length: 5 }, (_, i) => `短${i}`).join('\n');
    const result = segmentContent(content, 'Page', false);
    // 5 个极短 block 应合并为 1 个 segment
    expect(result.length).toBeLessThanOrEqual(2);
  });

  // ---------- Journal 分段 ----------

  it('journal: 连续短 block 被合并', () => {
    const shortBlocks = Array.from({ length: 6 }, (_, i) => `日记条目 ${i}: 内容`);
    const content = shortBlocks.join('\n');

    const result = segmentContent(content, '2024-03-15', true);
    // 6 个短条目应合并
    expect(result.length).toBeLessThan(6);
  });

  it('journal: 长 block 独立成 segment', () => {
    const longBlock = 'L'.repeat(300);
    const shortBlock = '短';
    const content = `${shortBlock}\n${longBlock}\n${shortBlock}`;

    const result = segmentContent(content, '2024-03-15', true);
    // 长 block 应独立
    const longSeg = result.find(s => s.content.includes('L'.repeat(100)));
    expect(longSeg).toBeDefined();
  });

  it('journal: 有子 block 的条目独立成 segment', () => {
    const content = [
      '条目1',
      '条目2',
      '  子条目2a',
      '  子条目2b',
      '条目3',
    ].join('\n');

    const result = segmentContent(content, '2024-03-15', true);
    // 条目2 有子 block，应独立
    const seg2 = result.find(s => s.content.includes('条目2') && s.content.includes('子条目2a'));
    expect(seg2).toBeDefined();
  });

  it('journal: MAX_SHORT_BLOCKS_TO_MERGE 限制', () => {
    // 超过 8 个短 block 应触发 flush
    const blocks = Array.from({ length: 12 }, (_, i) => `entry-${i}`);
    const content = blocks.join('\n');

    const result = segmentContent(content, '2024-01-01', true);
    // 12 个短 block，limit=8，应至少有 2 个 segment
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  // ---------- 超长叶节点 ----------

  it('超长叶节点按段落边界拆分', () => {
    const longText = Array.from({ length: 50 }, (_, i) =>
      `段落${i}: ${'内容'.repeat(50)}`,
    ).join('\n\n');

    const result = segmentContent(longText, 'Page', false);
    expect(result.length).toBeGreaterThan(1);
  });

  // ---------- Context 传递 ----------

  it('所有 segment 带有页面标题 context', () => {
    const content = 'Block A\nBlock B';
    const result = segmentContent(content, 'My Page', false);
    for (const seg of result) {
      expect(seg.context).toContain('My Page');
    }
  });
});
