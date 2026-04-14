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
