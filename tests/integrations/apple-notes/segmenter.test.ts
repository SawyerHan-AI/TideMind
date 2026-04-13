/**
 * apple-notes/segmenter.ts 单元测试
 */
import { describe, it, expect } from 'vitest';
import { segmentNote } from '../../../src/integrations/apple-notes/segmenter.js';

describe('segmentNote', () => {
  // ---------- 空内容 ----------

  it('空内容返回空数组', () => {
    expect(segmentNote('', 'Title')).toEqual([]);
    expect(segmentNote('   ', 'Title')).toEqual([]);
    expect(segmentNote('abc', 'Title')).toEqual([]); // 少于 10 字符
  });

  // ---------- 短笔记：整条一段 ----------

  it('短笔记作为单个 segment', () => {
    const text = '这是一条短笔记的正文内容，包含一些中文字符。';
    const result = segmentNote(text, '测试笔记');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(text);
    expect(result[0].context).toBe('测试笔记');
  });

  it('中等长度笔记（< 3000 字符）作为单段', () => {
    const text = '这是第一段内容。\n\n这是第二段内容。\n\n这是第三段内容。'.repeat(10);
    const result = segmentNote(text, 'Page');
    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBeLessThan(3000);
  });

  // ---------- 长笔记：按段落/句子拆分 ----------

  it('超过 3000 字符的笔记会被拆分', () => {
    // 构造一个超过 3000 字符的文本，用段落分隔
    const paragraph = '这是一段内容，包含若干文字。'.repeat(20); // ~280 字符
    const text = Array(15).fill(paragraph).join('\n\n'); // 总长度 ~4200+
    expect(text.length).toBeGreaterThan(3000);

    const result = segmentNote(text, 'Long Page');
    expect(result.length).toBeGreaterThan(1);
    // 所有段加起来应覆盖原始内容
    const total = result.reduce((sum, s) => sum + s.content.length, 0);
    expect(total).toBeGreaterThan(3000);
  });

  it('长笔记按 \\n\\n 段落边界拆分', () => {
    const shortLine = 'A'.repeat(1500);
    const text = `${shortLine}\n\n${shortLine}\n\n${shortLine}`;
    const result = segmentNote(text, 'Test');
    expect(result.length).toBeGreaterThanOrEqual(1);
    // 每段应 ≤ 3000 字符
    for (const seg of result) {
      expect(seg.content.length).toBeLessThanOrEqual(3000);
    }
  });

  it('所有 segment 的 context 都是 title', () => {
    const text = 'A'.repeat(3500);
    const result = segmentNote(text, 'My Title');
    for (const seg of result) {
      expect(seg.context).toBe('My Title');
    }
  });

  // ---------- 标题拆分 ----------

  it('按标题位置拆分（extractHeadingPositions 返回多个位置）', () => {
    const section1 = 'Section 1 content. '.repeat(50); // ~950 字符
    const section2 = 'Section 2 content. '.repeat(50);
    const section3 = 'Section 3 content. '.repeat(50);
    const section4 = 'Section 4 content. '.repeat(50);

    const text = `${section1}\n${section2}\n${section3}\n${section4}`;
    expect(text.length).toBeGreaterThan(3000);

    // 模拟 4 个标题位置
    const headings = [
      { offset: 0, styleType: 1 },
      { offset: section1.length + 1, styleType: 1 },
      { offset: section1.length + section2.length + 2, styleType: 1 },
      { offset: section1.length + section2.length + section3.length + 3, styleType: 1 },
    ];

    const result = segmentNote(text, 'Long', headings);
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const seg of result) {
      expect(seg.content.length).toBeLessThanOrEqual(3000);
    }
  });
});
