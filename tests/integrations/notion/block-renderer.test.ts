import { describe, it, expect, vi } from 'vitest';
import { renderBlocks, extractRichText } from '../../../src/integrations/notion/block-renderer.js';
import type { BlockObjectResponse, RichTextItemResponse } from '@notionhq/client/build/src/api-endpoints.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// ── 辅助函数：构造 mock block ──────────────────────────────────

function makeBlock(
  type: string,
  data: Record<string, unknown>,
  opts: { id?: string; parentBlockId?: string; hasChildren?: boolean } = {},
): BlockObjectResponse {
  return {
    object: 'block',
    id: opts.id ?? `block-${Math.random().toString(36).slice(2, 8)}`,
    type,
    [type]: data,
    parent: opts.parentBlockId
      ? { type: 'block_id', block_id: opts.parentBlockId }
      : { type: 'page_id', page_id: 'page-1' },
    has_children: opts.hasChildren ?? false,
    created_time: '2024-01-01T00:00:00.000Z',
    last_edited_time: '2024-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-1' },
    last_edited_by: { object: 'user', id: 'user-1' },
    in_trash: false,
    archived: false,
  } as unknown as BlockObjectResponse;
}

function makeRichText(text: string): RichTextItemResponse[] {
  return [{
    type: 'text',
    text: { content: text, link: null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
    plain_text: text,
    href: null,
  }] as RichTextItemResponse[];
}

// ── extractRichText 测试 ──────────────────────────────────────

describe('extractRichText', () => {
  it('提取纯文本', () => {
    const refs: string[] = [];
    const result = extractRichText(makeRichText('Hello World'), refs);
    expect(result).toBe('Hello World');
    expect(refs).toHaveLength(0);
  });

  it('空 rich_text 数组返回空字符串', () => {
    const refs: string[] = [];
    expect(extractRichText([], refs)).toBe('');
    expect(extractRichText(undefined as unknown as RichTextItemResponse[], refs)).toBe('');
  });

  it('多段文本拼接', () => {
    const refs: string[] = [];
    const items = [
      ...makeRichText('Hello '),
      ...makeRichText('World'),
    ];
    expect(extractRichText(items, refs)).toBe('Hello World');
  });

  it('page mention 转换为 [[标题]] 并收集 pageRef', () => {
    const refs: string[] = [];
    const items: RichTextItemResponse[] = [{
      type: 'mention',
      mention: { type: 'page', page: { id: 'page-abc-123' } },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
      plain_text: '我的笔记',
      href: 'https://notion.so/page-abc-123',
    }] as unknown as RichTextItemResponse[];

    const result = extractRichText(items, refs);
    expect(result).toBe('[[我的笔记]]');
    expect(refs).toContain('page-abc-123');
  });

  it('database mention 转换为 [[标题]] 并收集 pageRef', () => {
    const refs: string[] = [];
    const items: RichTextItemResponse[] = [{
      type: 'mention',
      mention: { type: 'database', database: { id: 'db-xyz-456' } },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
      plain_text: '读书笔记数据库',
      href: null,
    }] as unknown as RichTextItemResponse[];

    const result = extractRichText(items, refs);
    expect(result).toBe('[[读书笔记数据库]]');
    expect(refs).toContain('db-xyz-456');
  });

  it('user mention 输出 @用户名', () => {
    const refs: string[] = [];
    const items: RichTextItemResponse[] = [{
      type: 'mention',
      mention: { type: 'user', user: { object: 'user', id: 'user-1' } },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
      plain_text: 'Alice',
      href: null,
    }] as unknown as RichTextItemResponse[];

    expect(extractRichText(items, refs)).toBe('@Alice');
    expect(refs).toHaveLength(0);
  });

  it('inline equation 输出 $expression$', () => {
    const refs: string[] = [];
    const items: RichTextItemResponse[] = [{
      type: 'equation',
      equation: { expression: 'E = mc^2' },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
      plain_text: 'E = mc^2',
      href: null,
    }] as unknown as RichTextItemResponse[];

    expect(extractRichText(items, refs)).toBe('$E = mc^2$');
  });

  it('混合文本 + mention + equation', () => {
    const refs: string[] = [];
    const items: RichTextItemResponse[] = [
      ...makeRichText('参见 '),
      {
        type: 'mention',
        mention: { type: 'page', page: { id: 'ref-page' } },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
        plain_text: '量子力学',
        href: null,
      } as unknown as RichTextItemResponse,
      ...makeRichText('，其中 '),
      {
        type: 'equation',
        equation: { expression: 'E = mc^2' },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
        plain_text: 'E = mc^2',
        href: null,
      } as unknown as RichTextItemResponse,
    ];

    const result = extractRichText(items, refs);
    expect(result).toBe('参见 [[量子力学]]，其中 $E = mc^2$');
    expect(refs).toEqual(['ref-page']);
  });
});

// ── renderBlocks 测试 ─────────────────────────────────────────

describe('renderBlocks', () => {
  it('渲染 paragraph', () => {
    const blocks = [makeBlock('paragraph', { rich_text: makeRichText('这是一段文字'), color: 'default' })];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('这是一段文字');
  });

  it('渲染 heading 1-3', () => {
    const blocks = [
      makeBlock('heading_1', { rich_text: makeRichText('一级标题'), color: 'default', is_toggleable: false }),
      makeBlock('heading_2', { rich_text: makeRichText('二级标题'), color: 'default', is_toggleable: false }),
      makeBlock('heading_3', { rich_text: makeRichText('三级标题'), color: 'default', is_toggleable: false }),
    ];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('# 一级标题');
    expect(result.text).toContain('## 二级标题');
    expect(result.text).toContain('### 三级标题');
  });

  it('渲染 bulleted_list_item', () => {
    const blocks = [makeBlock('bulleted_list_item', { rich_text: makeRichText('列表项'), color: 'default' })];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('- 列表项');
  });

  it('渲染嵌套 bulleted_list_item', () => {
    const parentId = 'parent-list';
    const blocks = [
      makeBlock('bulleted_list_item', { rich_text: makeRichText('父项'), color: 'default' }, { id: parentId, hasChildren: true }),
      makeBlock('bulleted_list_item', { rich_text: makeRichText('子项'), color: 'default' }, { parentBlockId: parentId }),
    ];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('- 父项');
    expect(result.text).toContain('  - 子项');
  });

  it('渲染 to_do（已选中 + 未选中）', () => {
    const blocks = [
      makeBlock('to_do', { rich_text: makeRichText('已完成'), checked: true, color: 'default' }),
      makeBlock('to_do', { rich_text: makeRichText('未完成'), checked: false, color: 'default' }),
    ];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('- [x] 已完成');
    expect(result.text).toContain('- [ ] 未完成');
  });

  it('渲染 code block', () => {
    const blocks = [makeBlock('code', {
      rich_text: makeRichText('const x = 1;'),
      language: 'javascript',
      caption: [],
    })];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('```javascript');
    expect(result.text).toContain('const x = 1;');
    expect(result.text).toContain('```');
  });

  it('渲染 quote', () => {
    const blocks = [makeBlock('quote', { rich_text: makeRichText('引用文本'), color: 'default' })];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('> 引用文本');
  });

  it('渲染 callout 带 emoji', () => {
    const blocks = [makeBlock('callout', {
      rich_text: makeRichText('重要提示'),
      icon: { type: 'emoji', emoji: '⚠️' },
      color: 'default',
    })];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('> ⚠️ 重要提示');
  });

  it('渲染 equation', () => {
    const blocks = [makeBlock('equation', { expression: 'x^2 + y^2 = r^2' })];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('$$');
    expect(result.text).toContain('x^2 + y^2 = r^2');
  });

  it('跳过 divider/image/bookmark 等无内容块', () => {
    const blocks = [
      makeBlock('divider', {}),
      makeBlock('image', { type: 'external', external: { url: 'https://example.com/img.png' } }),
      makeBlock('bookmark', { url: 'https://example.com', caption: [] }),
      makeBlock('paragraph', { rich_text: makeRichText('可见文本'), color: 'default' }),
    ];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('可见文本');
    expect(result.text).not.toContain('example.com');
  });

  it('child_page 输出 [[标题]] 并收集 pageRef', () => {
    const blocks = [makeBlock('child_page', { title: '子页面标题' }, { id: 'child-page-id' })];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('[[子页面标题]]');
    expect(result.pageRefs).toContain('child-page-id');
  });

  it('synced_block duplicate 被跳过', () => {
    const blocks = [
      makeBlock('synced_block', { synced_from: { block_id: 'original-block-id' } }),
      makeBlock('paragraph', { rich_text: makeRichText('正常文本'), color: 'default' }),
    ];
    const result = renderBlocks(blocks);
    expect(result.text).toBe('正常文本');
  });

  it('渲染 table', () => {
    const tableId = 'table-1';
    const blocks = [
      makeBlock('table', { table_width: 2, has_column_header: true, has_row_header: false }, { id: tableId, hasChildren: true }),
      makeBlock('table_row', { cells: [makeRichText('姓名'), makeRichText('年龄')] }, { parentBlockId: tableId }),
      makeBlock('table_row', { cells: [makeRichText('Alice'), makeRichText('30')] }, { parentBlockId: tableId }),
    ];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('姓名');
    expect(result.text).toContain('Alice');
    expect(result.text).toContain('|');
  });

  it('column_list 顺序拼接子块内容', () => {
    const colListId = 'col-list';
    const col1Id = 'col-1';
    const col2Id = 'col-2';
    const blocks = [
      makeBlock('column_list', {}, { id: colListId, hasChildren: true }),
      makeBlock('column', {}, { id: col1Id, parentBlockId: colListId, hasChildren: true }),
      makeBlock('column', {}, { id: col2Id, parentBlockId: colListId, hasChildren: true }),
      makeBlock('paragraph', { rich_text: makeRichText('左列内容'), color: 'default' }, { parentBlockId: col1Id }),
      makeBlock('paragraph', { rich_text: makeRichText('右列内容'), color: 'default' }, { parentBlockId: col2Id }),
    ];
    const result = renderBlocks(blocks);
    expect(result.text).toContain('左列内容');
    expect(result.text).toContain('右列内容');
  });

  it('空块列表返回空字符串', () => {
    const result = renderBlocks([]);
    expect(result.text).toBe('');
    expect(result.pageRefs).toHaveLength(0);
  });
});
