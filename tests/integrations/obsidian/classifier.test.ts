/**
 * integrations/obsidian/classifier.ts 单元测试
 *
 * 分类逻辑 + 入度统计（mock readContent 回调）。
 */
import { describe, it, expect, vi } from 'vitest';

// mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { classifyFiles, buildInDegreeMap } from '../../../src/integrations/obsidian/classifier.js';
import type { ObsidianVaultConfig, ClassifiedFile } from '../../../src/integrations/obsidian/types.js';

const VAULT = '/mock/vault';

/** 构造一个带有合理默认值的 vault 配置 */
function makeConfig(overrides: Partial<ObsidianVaultConfig> = {}): ObsidianVaultConfig {
  return {
    dailyNotes: { folder: 'Daily', format: 'YYYY-MM-DD', template: '' },
    attachmentFolder: 'Attachments',
    templateFolder: 'Templates',
    useMarkdownLinks: false,
    ...overrides,
  };
}

/** 用 Map 模拟 readContent 回调 */
function makeReader(store: Map<string, string>): (path: string) => string | null {
  return (p: string) => store.get(p) ?? null;
}

// ===== classifyFiles =====

describe('classifyFiles', () => {
  // --- daily_note ---

  it('daily_note: 匹配配置目录 + 日期格式', () => {
    const abs = `${VAULT}/Daily/2024-03-15.md`;
    const store = new Map([[abs, '- Morning task\n- Afternoon meeting']]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('daily_note');
  });

  it('daily_note: 不在配置目录中不算日记', () => {
    const abs = `${VAULT}/Notes/2024-03-15.md`;
    const store = new Map([[abs, '- Some note content']]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).not.toBe('daily_note');
  });

  it('daily_note: 自定义日期格式 YYYYMMDD', () => {
    const config = makeConfig({ dailyNotes: { folder: 'Journal', format: 'YYYYMMDD', template: '' } });
    const abs = `${VAULT}/Journal/20240315.md`;
    const store = new Map([[abs, '- Entry content']]);
    const result = classifyFiles([abs], VAULT, config, makeReader(store));
    expect(result[0].category).toBe('daily_note');
  });

  // --- regular ---

  it('regular: 普通 .md 文件', () => {
    const abs = `${VAULT}/Notes/my-note.md`;
    const content = '# My Note\nSome content here with enough text.\n' + 'x'.repeat(100);
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('regular');
  });

  // --- readwise ---

  it('readwise: frontmatter category 含 #articles', () => {
    const abs = `${VAULT}/Readwise/article.md`;
    const content = '---\ncategory: \"[[#articles]]\"\nauthor: Someone\n---\n## Highlights\nSome highlight text here.\n---\nAnother highlight.';
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('readwise');
  });

  it('readwise: 正文含 ## Highlights + ---', () => {
    const abs = `${VAULT}/Readwise/highlights.md`;
    const content = '# Some Article Title\n\n## Highlights\n\nFirst highlight text.\n\n---\n\nSecond highlight text.';
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('readwise');
  });

  // --- chatgpt_export ---

  it('chatgpt_export: 正文匹配 #### You: / #### ChatGPT: 对话模式', () => {
    const abs = `${VAULT}/Chats/gpt-conversation.md`;
    const content = '#### You:\nWhat is Python?\n#### ChatGPT:\nPython is a programming language.';
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('chatgpt_export');
  });

  it('chatgpt_export: frontmatter source 含 chat.openai.com', () => {
    const abs = `${VAULT}/Chats/chat.md`;
    const content = '---\nsource: https://chat.openai.com/share/abc\n---\nSome conversation content here.';
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('chatgpt_export');
  });

  // --- excalidraw ---

  it('excalidraw: .excalidraw.md 后缀', () => {
    const abs = `${VAULT}/Drawings/diagram.excalidraw.md`;
    const store = new Map([[abs, '# Text Elements\nHello']]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('excalidraw');
  });

  it('excalidraw: frontmatter 含 excalidraw-plugin', () => {
    const abs = `${VAULT}/Drawings/drawing.md`;
    const content = '---\nexcalidraw-plugin: parsed\n---\n# Text Elements\nSome text';
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('excalidraw');
  });

  // --- index_page ---

  it('index_page: 70%+ 非空行是 [[link]]', () => {
    const abs = `${VAULT}/Notes/index.md`;
    const links = Array.from({ length: 10 }, (_, i) => `- [[Page ${i}]]`);
    const content = links.join('\n') + '\nOne normal line\nAnother line\nThird line';
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('index_page');
  });

  it('index_page: 链接占比不足 70% 时归为 regular', () => {
    const abs = `${VAULT}/Notes/mixed.md`;
    const content = '- [[Link1]]\n- [[Link2]]\nNormal text 1\nNormal text 2\nNormal text 3\nNormal text 4\nMore text\nEven more text\n' + 'x'.repeat(100);
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('regular');
  });

  // --- metadata_only ---

  it('metadata_only: 有 frontmatter 但正文 < 20 字符', () => {
    const abs = `${VAULT}/Notes/meta.md`;
    const content = '---\ntitle: Test\ntags: [a, b]\n---\nShort.';
    const store = new Map([[abs, content]]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('metadata_only');
  });

  // --- canvas ---

  it('canvas: .canvas 扩展名', () => {
    const abs = `${VAULT}/Notes/board.canvas`;
    const store = new Map([[abs, '{"nodes":[],"edges":[]}']]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('canvas');
  });

  // --- template ---

  it('template: 在模板目录内', () => {
    const abs = `${VAULT}/Templates/note-template.md`;
    const store = new Map([[abs, '# {{title}}\n{{date}}']]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('template');
  });

  // --- attachment ---

  it('attachment: 在附件目录内', () => {
    const abs = `${VAULT}/Attachments/image.png`;
    const store = new Map<string, string>();
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('attachment');
  });

  it('attachment: 非 .md/.canvas 扩展名', () => {
    const abs = `${VAULT}/Notes/data.json`;
    const store = new Map<string, string>();
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('attachment');
  });

  // --- empty_tag ---

  it('empty_tag: 文件内容为空', () => {
    const abs = `${VAULT}/Notes/empty.md`;
    const store = new Map([[abs, '']]);
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('empty_tag');
  });

  it('empty_tag: readContent 返回 null', () => {
    const abs = `${VAULT}/Notes/missing.md`;
    const store = new Map<string, string>();
    const result = classifyFiles([abs], VAULT, makeConfig(), makeReader(store));
    expect(result[0].category).toBe('empty_tag');
  });

  // --- 多文件混合 ---

  it('多个文件混合分类', () => {
    const files = [
      `${VAULT}/Daily/2024-01-01.md`,
      `${VAULT}/Notes/regular.md`,
      `${VAULT}/Attachments/photo.jpg`,
      `${VAULT}/Templates/tmpl.md`,
      `${VAULT}/Notes/board.canvas`,
    ];
    const store = new Map<string, string>([
      [files[0], '- New Year task'],
      [files[1], '# Note\nContent here.\n' + 'x'.repeat(100)],
      [files[3], '# Template\n{{date}}'],
    ]);
    const result = classifyFiles(files, VAULT, makeConfig(), makeReader(store));
    expect(result).toHaveLength(5);

    const categories = result.map(f => f.category);
    expect(categories).toContain('daily_note');
    expect(categories).toContain('regular');
    expect(categories).toContain('attachment');
    expect(categories).toContain('template');
    expect(categories).toContain('canvas');
  });
});

// ===== buildInDegreeMap =====

describe('buildInDegreeMap', () => {
  it('计算被引用次数', () => {
    const files: ClassifiedFile[] = [
      { relPath: 'Notes/A.md', absPath: '/v/Notes/A.md', category: 'regular', inDegree: 0 },
      { relPath: 'Notes/B.md', absPath: '/v/Notes/B.md', category: 'regular', inDegree: 0 },
      { relPath: 'Notes/C.md', absPath: '/v/Notes/C.md', category: 'regular', inDegree: 0 },
    ];

    const readContent = (p: string) => {
      if (p === '/v/Notes/A.md') return '引用 [[B]] 和 [[C]]';
      if (p === '/v/Notes/B.md') return '引用 [[C]]';
      return '无引用';
    };

    const map = buildInDegreeMap(files, readContent);
    expect(map.get('B')).toBe(1);
    expect(map.get('C')).toBe(2);
    expect(map.has('A')).toBe(false);
  });

  it('自引用不计入', () => {
    const files: ClassifiedFile[] = [
      { relPath: 'Notes/Self.md', absPath: '/v/Notes/Self.md', category: 'regular', inDegree: 0 },
    ];
    const readContent = () => '引用 [[Self]] 自己';
    const map = buildInDegreeMap(files, readContent);
    expect(map.has('Self')).toBe(false);
  });

  it('同文件内多次引用同一页只计 1 次', () => {
    const files: ClassifiedFile[] = [
      { relPath: 'Notes/A.md', absPath: '/v/Notes/A.md', category: 'regular', inDegree: 0 },
      { relPath: 'Notes/B.md', absPath: '/v/Notes/B.md', category: 'regular', inDegree: 0 },
    ];
    const readContent = (p: string) => {
      if (p === '/v/Notes/A.md') return '[[B]] again [[B]] and [[B]]';
      return '';
    };
    const map = buildInDegreeMap(files, readContent);
    expect(map.get('B')).toBe(1);
  });

  it('canvas/template/attachment 类型被跳过', () => {
    const files: ClassifiedFile[] = [
      { relPath: 'Notes/A.md', absPath: '/v/Notes/A.md', category: 'regular', inDegree: 0 },
      { relPath: 'board.canvas', absPath: '/v/board.canvas', category: 'canvas', inDegree: 0 },
      { relPath: 'Templates/t.md', absPath: '/v/Templates/t.md', category: 'template', inDegree: 0 },
    ];
    const readContent = (p: string) => {
      if (p === '/v/Notes/A.md') return '[[board]] [[t]]';
      return '';
    };
    const map = buildInDegreeMap(files, readContent);
    // board 和 t 不在 nameSet（canvas/template 被跳过），所以不计入
    expect(map.size).toBe(0);
  });

  it('readContent 返回 null 的文件跳过', () => {
    const files: ClassifiedFile[] = [
      { relPath: 'Notes/A.md', absPath: '/v/Notes/A.md', category: 'regular', inDegree: 0 },
    ];
    const readContent = () => null;
    const map = buildInDegreeMap(files, readContent);
    expect(map.size).toBe(0);
  });

  it('[[link|alias]] 格式正确提取 link 部分', () => {
    const files: ClassifiedFile[] = [
      { relPath: 'Notes/A.md', absPath: '/v/Notes/A.md', category: 'regular', inDegree: 0 },
      { relPath: 'Notes/Target.md', absPath: '/v/Notes/Target.md', category: 'regular', inDegree: 0 },
    ];
    const readContent = (p: string) => {
      if (p === '/v/Notes/A.md') return 'See [[Target|my alias]]';
      return '';
    };
    const map = buildInDegreeMap(files, readContent);
    expect(map.get('Target')).toBe(1);
  });
});
