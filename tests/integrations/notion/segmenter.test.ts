import { describe, it, expect } from 'vitest';
import { segmentContent } from '../../../src/integrations/notion/segmenter.js';

// 生成超过 200 字符阈值的填充文本
const pad = (text: string) => text + '。这是填充文字用来确保段落超过短段合并阈值。'.repeat(15);

describe('segmentContent', () => {
  it('空内容返回空数组', () => {
    expect(segmentContent('', '页面')).toHaveLength(0);
    expect(segmentContent('   ', '页面')).toHaveLength(0);
  });

  it('无 heading 的内容：整页作为一段', () => {
    const content = pad('这是一段没有标题的内容');
    const result = segmentContent(content, '我的页面');
    expect(result).toHaveLength(1);
    expect(result[0].context).toBe('我的页面');
  });

  it('按 H1-H3 heading 分段', () => {
    const content = `# 第一节\n${pad('这是第一节的内容')}\n\n## 第二节\n${pad('这是第二节的内容')}\n\n### 第三节\n${pad('这是第三节的内容')}`;

    const result = segmentContent(content, '测试页面');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].context).toBe('第一节');
    expect(result[0].content).toContain('第一节的内容');
  });

  it('heading 前的引言段保留', () => {
    const content = `${pad('这是引言部分，在第一个标题之前')}\n\n# 正文标题\n${pad('这是正文内容，跟在标题后面')}`;

    const result = segmentContent(content, '页面');
    expect(result.length).toBeGreaterThanOrEqual(2);
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('引言部分');
    expect(allContent).toContain('正文内容');
  });

  it('短段合并（< 200 字符）', () => {
    const content = `# A\n短\n\n# B\n${pad('这是一段较长的内容')}`;

    const result = segmentContent(content, '页面');
    // "短" 应该被合并
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('短');
    expect(allContent).toContain('较长的内容');
  });

  it('长段拆分（> 3000 字符）', () => {
    const longParagraph = '这是一个很长的段落。'.repeat(400);
    const content = `# 长段测试\n${longParagraph}`;

    const result = segmentContent(content, '页面');
    expect(result.length).toBeGreaterThan(1);
    for (const seg of result) {
      expect(seg.content.length).toBeLessThanOrEqual(3100);
    }
  });

  it('H4 heading 也能分段', () => {
    const content = `#### 四级标题\n${pad('这是四级标题下的内容')}\n\n#### 另一个四级标题\n${pad('另一段内容')}`;

    const result = segmentContent(content, '页面');
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('context 使用 heading 文本', () => {
    const content = `# 项目概述\n${pad('这是概述内容')}\n\n## 技术方案\n${pad('这是方案内容')}`;

    const result = segmentContent(content, '文档');
    const contexts = result.map(s => s.context);
    expect(contexts).toContain('项目概述');
    expect(contexts).toContain('技术方案');
  });
});

// F12 回归: mergeShortSegments 不能 mutate 入参数组或入参对象。
// 旧实现有两个 mutation 点:
//   a) result 中保存的是入参对象引用,把 short 段合并到 prev 时 prev.content 被改 → 入参对象被偷偷改了
//   b) `segments[i + 1] = {...}` 直接写入参数组,污染调用方
describe('mergeShortSegments — F12 回归: 不 mutate 入参', () => {
  it('短段在中间:入参数组与对象都不变', async () => {
    const { mergeShortSegments } = await import(
      '../../../src/integrations/notion/segmenter.js'
    );
    const segments = [
      { content: 'a'.repeat(300), context: 'A' }, // long
      { content: 'b'.repeat(50), context: 'B' },  // short
      { content: 'c'.repeat(300), context: 'C' }, // long
    ];
    const clone = JSON.parse(JSON.stringify(segments));

    const result = mergeShortSegments(segments);

    // 入参完全不变
    expect(segments).toEqual(clone);
    // 入参的每个对象身份保留 — 验证 result 中的对象都是新对象(因为旧实现 push(seg) 后改 prev.content)
    expect(segments[0].content).toBe('a'.repeat(300));
    expect(segments[1].content).toBe('b'.repeat(50));
    expect(segments[2].content).toBe('c'.repeat(300));

    // result 行为正确:短段被合并到上一长段
    expect(result.length).toBe(2);
    expect(result[0].content).toContain('a'.repeat(300));
    expect(result[0].content).toContain('b'.repeat(50));
    expect(result[1].content).toBe('c'.repeat(300));
  });

  it('短段在最前面:segments[i+1] 不被写穿', async () => {
    const { mergeShortSegments } = await import(
      '../../../src/integrations/notion/segmenter.js'
    );
    const segments = [
      { content: 'short1', context: 'S1' }, // short(<200)
      { content: 'd'.repeat(300), context: 'D' }, // long
    ];
    const clone = JSON.parse(JSON.stringify(segments));

    mergeShortSegments(segments);

    // 入参 segments[1] 不应被改写
    expect(segments).toEqual(clone);
    expect(segments[1].content).toBe('d'.repeat(300));
  });

  it('连续两个短段在最前面:仍不污染入参', async () => {
    const { mergeShortSegments } = await import(
      '../../../src/integrations/notion/segmenter.js'
    );
    const segments = [
      { content: 's1', context: 'A' },
      { content: 's2', context: 'B' },
      { content: 'long'.repeat(100), context: 'C' },
    ];
    const clone = JSON.parse(JSON.stringify(segments));

    const result = mergeShortSegments(segments);
    expect(segments).toEqual(clone);
    // 行为:s1 + s2 都被并入第三个长段
    expect(result.length).toBe(1);
    expect(result[0].content).toContain('s1');
    expect(result[0].content).toContain('s2');
  });
});
