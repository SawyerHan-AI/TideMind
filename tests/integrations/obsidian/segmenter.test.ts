/**
 * integrations/obsidian/segmenter.ts 单元测试
 */
import { describe, it, expect, vi } from 'vitest';

// mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { segmentContent } from '../../../src/integrations/obsidian/segmenter.js';

// ===== 空内容 / 特殊分类 =====

describe('segmentContent — 空内容与特殊分类', () => {
  it('空字符串返回空数组', () => {
    expect(segmentContent('', 'regular', 'Page')).toEqual([]);
  });

  it('纯空白内容返回空数组', () => {
    expect(segmentContent('  \n\n  ', 'regular', 'Page')).toEqual([]);
  });

  it('empty_tag 分类返回空数组', () => {
    expect(segmentContent('some content', 'empty_tag', 'Page')).toEqual([]);
  });

  it('metadata_only 分类返回空数组', () => {
    expect(segmentContent('some content', 'metadata_only', 'Page')).toEqual([]);
  });

  it('index_page 不拆分，整体作为单段', () => {
    const content = '- [[PageA]]\n- [[PageB]]\n- [[PageC]]';
    const result = segmentContent(content, 'index_page', 'My Index');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(content);
    expect(result[0].context).toBe('My Index');
  });
});

// ===== Regular 文件 — Heading 分段 =====

describe('segmentContent — regular heading 分段', () => {
  it('按 H1 分段', () => {
    const content = '# Section A\nContent A here with enough text to be meaningful.\n\n# Section B\nContent B here with enough text to be meaningful.';
    const result = segmentContent(content, 'regular', 'Page');
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Content A');
    expect(allContent).toContain('Content B');
  });

  it('按 H2 分段', () => {
    const content = '## Part 1\nFirst part content that is long enough to stand alone.\n\n## Part 2\nSecond part content that is long enough to stand alone.';
    const result = segmentContent(content, 'regular', 'Page');
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('First part');
    expect(allContent).toContain('Second part');
  });

  it('按 H3 分段', () => {
    const content = '### Sub A\nSub A content with sufficient length to avoid merge.\n\n### Sub B\nSub B content with sufficient length to avoid merge.';
    const result = segmentContent(content, 'regular', 'Page');
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Sub A content');
    expect(allContent).toContain('Sub B content');
  });

  it('H4 不触发分段，保留在上级 section 内', () => {
    const content = [
      '## Main Section',
      'Some intro text for the main section here.',
      '#### Sub Detail',
      'Detail text under H4 heading, should not split.',
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    // H4 不拆分，所以 Sub Detail 和 intro text 在同一段
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Sub Detail');
    expect(allContent).toContain('intro text');
    // 不应该被拆成多个由 H4 划分的段
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it('混合 H1/H2/H3 分段', () => {
    const content = [
      '# Chapter 1',
      'Chapter 1 text with plenty of content to stand alone as a segment.',
      '## Section 1.1',
      'Section 1.1 text with plenty of content to stand alone as a segment.',
      '### Subsection 1.1.1',
      'Sub text with plenty of content to stand alone here in subsection.',
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    expect(result.length).toBeGreaterThanOrEqual(1);
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Chapter 1 text');
    expect(allContent).toContain('Section 1.1 text');
    expect(allContent).toContain('Sub text');
  });

  it('heading 前的引言段作为独立 segment', () => {
    const intro = 'This is an introduction paragraph with enough text to be kept as a standalone segment in the output.';
    const content = `${intro}\n\n# First Heading\nFirst heading content.`;
    const result = segmentContent(content, 'regular', 'Page');
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('introduction paragraph');
  });
});

// ===== Regular 文件 — 无 heading，按 --- 分段 =====

describe('segmentContent — regular 无 heading 回退到 --- 分段', () => {
  it('无 heading 时按 --- 分段', () => {
    const partOne = 'Part one with enough text to be meaningful. ' + 'A'.repeat(200);
    const partTwo = 'Part two with enough text to be meaningful. ' + 'B'.repeat(200);
    const content = [partOne, '---', partTwo].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    expect(result.length).toBeGreaterThanOrEqual(2);
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Part one');
    expect(allContent).toContain('Part two');
  });

  it('无 heading 也无 --- 时作为单段', () => {
    const content = 'Just a simple paragraph without any heading or horizontal rule.';
    const result = segmentContent(content, 'regular', 'Page');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(content);
    expect(result[0].context).toBe('Page');
  });
});

// ===== 短段合并 =====

describe('segmentContent — 短段合并', () => {
  it('< 200 字符的段落与前一段合并', () => {
    const content = [
      '## Long Section',
      'A'.repeat(250),
      '## Tiny',
      'Hi',
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    // 短段 "Hi" 应合并到前一段
    const tinyAlone = result.find(s => s.content === 'Hi');
    expect(tinyAlone).toBeUndefined();
  });

  it('第一段很短时与后一段合并', () => {
    const content = [
      '## Short',
      'Hi',
      '## Normal',
      'B'.repeat(250),
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    // "Hi" 是第一段且很短，应与后一段合并
    const combined = result.find(s => s.content.includes('Hi') && s.content.includes('B'.repeat(100)));
    expect(combined).toBeDefined();
  });
});

// ===== 长段拆分 =====

describe('segmentContent — 长段拆分', () => {
  it('超过 3000 字符的段落被拆分', () => {
    const longParagraphs = Array.from({ length: 40 }, (_, i) =>
      `段落${i}: ${'内容'.repeat(60)}`,
    ).join('\n\n');
    const content = `## Big Section\n${longParagraphs}`;
    const result = segmentContent(content, 'regular', 'Page');
    expect(result.length).toBeGreaterThan(1);
    for (const seg of result) {
      // 允许少量溢出
      expect(seg.content.length).toBeLessThanOrEqual(3500);
    }
  });
});

// ===== daily_note 分段 =====

describe('segmentContent — daily_note', () => {
  it('daily_note 按 --- 分段', () => {
    const morning = 'Morning task with enough text. ' + 'A'.repeat(200);
    const afternoon = 'Afternoon notes with enough text. ' + 'B'.repeat(200);
    const evening = 'Evening reflections with enough text. ' + 'C'.repeat(200);
    const content = [morning, '---', afternoon, '---', evening].join('\n');
    const result = segmentContent(content, 'daily_note', '2024-03-15');
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('daily_note 无 --- 时作为单段', () => {
    const content = 'Just one block of daily notes without any separator.';
    const result = segmentContent(content, 'daily_note', '2024-03-15');
    expect(result).toHaveLength(1);
    expect(result[0].context).toBe('2024-03-15');
  });
});

// ===== readwise 分段 =====

describe('segmentContent — readwise', () => {
  it('readwise 按 --- 分隔高亮', () => {
    const h1 = 'Highlight one with enough text. ' + 'A'.repeat(200);
    const h2 = 'Highlight two with enough text. ' + 'B'.repeat(200);
    const h3 = 'Highlight three with enough text. ' + 'C'.repeat(200);
    const content = [h1, '---', h2, '---', h3].join('\n');
    const result = segmentContent(content, 'readwise', 'Article Title');
    expect(result.length).toBeGreaterThanOrEqual(2);
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Highlight one');
  });

  it('readwise 移除 [View Highlight] 标记', () => {
    const content = 'Some highlight text [View Highlight](https://example.com/highlight)';
    const result = segmentContent(content, 'readwise', 'Article');
    expect(result).toHaveLength(1);
    expect(result[0].content).not.toContain('[View Highlight]');
    expect(result[0].content).toContain('Some highlight text');
  });
});

// ===== chatgpt_export 分段 =====

describe('segmentContent — chatgpt_export', () => {
  it('按对话轮次分段（You + ChatGPT 配对）', () => {
    const content = [
      '#### You:',
      'What is JavaScript?',
      '#### ChatGPT:',
      'JavaScript is a programming language used for web development.',
      '#### You:',
      'Tell me more about closures and how they work in practice.',
      '#### ChatGPT:',
      'A closure is a function that has access to variables from outer scope.',
    ].join('\n');
    const result = segmentContent(content, 'chatgpt_export', 'JS Chat');
    expect(result.length).toBeGreaterThanOrEqual(1);
    // 应按 You 标记分轮
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('JavaScript');
  });

  it('context 包含对话轮次编号', () => {
    const content = [
      '#### You:',
      'Hello there, this is the first question in the conversation.',
      '#### ChatGPT:',
      'Hello! How can I help you today with your questions?',
    ].join('\n');
    const result = segmentContent(content, 'chatgpt_export', 'Chat');
    expect(result[0].context).toContain('对话轮次');
  });

  it('清除 <time> 标签', () => {
    const content = [
      '#### You:',
      '<time datetime="2024-01-01">Jan 1</time>',
      'Test question in the conversation for chatgpt export.',
      '#### ChatGPT:',
      'Test answer from chatgpt for the export file.',
    ].join('\n');
    const result = segmentContent(content, 'chatgpt_export', 'Chat');
    expect(result[0].content).not.toContain('<time');
  });

  it('无 #### You: 标记时回退到普通分段', () => {
    const content = 'Just regular content without any conversation markers at all.';
    const result = segmentContent(content, 'chatgpt_export', 'Chat');
    expect(result).toHaveLength(1);
  });
});

// ===== excalidraw 分段 =====

describe('segmentContent — excalidraw', () => {
  it('只提取 # Text Elements 段落', () => {
    const content = [
      '# Some other section',
      'Random stuff here.',
      '# Text Elements',
      'Hello World ^abc123',
      'Another text element ^def456',
      '# Embedded Files',
      'embedded data here.',
    ].join('\n');
    const result = segmentContent(content, 'excalidraw', 'Drawing');
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Hello World');
    expect(result[0].content).toContain('Another text element');
    expect(result[0].content).not.toContain('Random stuff');
    expect(result[0].content).not.toContain('embedded data');
  });

  it('移除 ^blockId 后缀', () => {
    const content = [
      '# Text Elements',
      'Some text ^abc123',
    ].join('\n');
    const result = segmentContent(content, 'excalidraw', 'Drawing');
    expect(result[0].content).not.toContain('^abc123');
    expect(result[0].content).toContain('Some text');
  });

  it('context 包含 [Excalidraw] 标记', () => {
    const content = '# Text Elements\nHello ^id1';
    const result = segmentContent(content, 'excalidraw', 'Drawing');
    expect(result[0].context).toContain('[Excalidraw]');
  });

  it('无 # Text Elements 段落时返回空数组', () => {
    const content = '# Some Other Section\nJust random data.';
    const result = segmentContent(content, 'excalidraw', 'Drawing');
    expect(result).toEqual([]);
  });
});

// ===== Backlinks/References 段落跳过 =====

describe('segmentContent — Backlinks/References 跳过', () => {
  it('跳过 ## Backlinks 段落', () => {
    const content = [
      '## Content Section',
      'Actual content with enough length to be a standalone segment here.',
      '## Backlinks',
      '- [[Page A]]',
      '- [[Page B]]',
      '- [[Page C]]',
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Actual content');
    expect(allContent).not.toContain('[[Page A]]');
  });

  it('跳过 ## References 段落', () => {
    const content = [
      '## Main Content',
      'Important text with enough length to be a standalone segment here.',
      '## References',
      '- [[Ref1]]',
      '- [[Ref2]]',
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).not.toContain('[[Ref1]]');
  });

  it('跳过 ## See Also 段落', () => {
    const content = [
      '## Content',
      'Main text with enough length to be a standalone segment here please.',
      '## See Also',
      '- [[Related1]]',
      '- [[Related2]]',
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).not.toContain('[[Related1]]');
  });
});

// ===== 连续 heading 无内容 =====

describe('segmentContent — 连续 heading 无内容', () => {
  it('连续空 heading 后的内容合并处理', () => {
    const content = [
      '## Heading A',
      '',
      '## Heading B',
      '',
      '## Heading C',
      'Finally some actual content under heading C with enough text.',
    ].join('\n');
    const result = segmentContent(content, 'regular', 'Page');
    // 空 heading 段应被过滤（content.trim().length === 0），
    // 只保留有实际内容的段
    expect(result.length).toBeGreaterThanOrEqual(1);
    const allContent = result.map(s => s.content).join('|||');
    expect(allContent).toContain('Finally some actual content');
  });
});

// ===== pageTitle 默认值 =====

describe('segmentContent — pageTitle 默认值', () => {
  it('pageTitle 未传时 context 使用空字符串', () => {
    const content = 'Simple text without heading, no title provided.';
    const result = segmentContent(content, 'regular');
    expect(result).toHaveLength(1);
    expect(result[0].context).toBe('');
  });
});

// ===== 短段合并：保序 + 合并（2026-05-29 round-2 回归）=====
// 修复前 mergeShortSegments 对「开头连续短段 + 末段也短」会乱序且漏合并
// （[short,short] 退化成 [B,A]，全短文档同理）。这里锁定正确行为。

describe('segmentContent — 短段合并保序', () => {
  it('两个短 heading 段 → 合并成一段且保持原顺序', () => {
    const content = [
      '# 第一节',
      '这是第一节的简短内容。',
      '',
      '# 第二节',
      '这是第二节的简短内容。',
    ].join('\n');
    const result = segmentContent(content, 'regular', '我的笔记');
    expect(result).toHaveLength(1);
    const c = result[0].content;
    // 第一节内容必须排在第二节之前（修复前会反序）
    expect(c.indexOf('第一节的简短内容')).toBeLessThan(c.indexOf('第二节的简短内容'));
  });

  it('全是短段（三段）→ 合并成一段且全部保序', () => {
    const content = [
      '# A', '短内容甲。', '', '# B', '短内容乙。', '', '# C', '短内容丙。',
    ].join('\n');
    const result = segmentContent(content, 'regular', '笔记');
    expect(result).toHaveLength(1);
    const c = result[0].content;
    expect(c).toContain('短内容甲');
    expect(c).toContain('短内容乙');
    expect(c).toContain('短内容丙');
    expect(c.indexOf('短内容甲')).toBeLessThan(c.indexOf('短内容乙'));
    expect(c.indexOf('短内容乙')).toBeLessThan(c.indexOf('短内容丙'));
  });
});
