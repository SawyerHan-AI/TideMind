import { describe, it, expect } from 'vitest';
import { extractMetadata, renderPropertiesHeader, extractTitle } from '../../../src/integrations/notion/property-extractor.js';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';

// ── 辅助函数：构造 mock page ──────────────────────────────────

function makePage(
  properties: Record<string, unknown>,
  icon?: { type: 'emoji'; emoji: string } | null,
): PageObjectResponse {
  return {
    object: 'page',
    id: 'page-test-123',
    parent: { type: 'workspace', workspace: true },
    properties,
    icon: icon ?? null,
    cover: null,
    created_time: '2024-01-01T00:00:00.000Z',
    last_edited_time: '2024-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-1' },
    last_edited_by: { object: 'user', id: 'user-1' },
    url: 'https://notion.so/page-test-123',
    public_url: null,
    in_trash: false,
    archived: false,
  } as unknown as PageObjectResponse;
}

// ── extractTitle 测试 ─────────────────────────────────────────

describe('extractTitle', () => {
  it('提取标题', () => {
    const page = makePage({
      Name: { type: 'title', title: [{ plain_text: '我的笔记' }] },
    });
    expect(extractTitle(page)).toBe('我的笔记');
  });

  it('无标题返回 Untitled', () => {
    const page = makePage({});
    expect(extractTitle(page)).toBe('Untitled');
  });

  it('空标题返回 Untitled', () => {
    const page = makePage({
      Name: { type: 'title', title: [] },
    });
    expect(extractTitle(page)).toBe('Untitled');
  });

  it('emoji icon 拼到标题前面', () => {
    const page = makePage(
      { Name: { type: 'title', title: [{ plain_text: '三体' }] } },
      { type: 'emoji', emoji: '📚' },
    );
    expect(extractTitle(page)).toBe('📚 三体');
  });

  it('无 emoji icon 不影响标题', () => {
    const page = makePage(
      { Name: { type: 'title', title: [{ plain_text: '普通标题' }] } },
      null,
    );
    expect(extractTitle(page)).toBe('普通标题');
  });
});

// ── extractMetadata 测试 ──────────────────────────────────────

describe('extractMetadata', () => {
  it('multi_select → tags + properties', () => {
    const page = makePage({
      标签: {
        type: 'multi_select',
        multi_select: [{ name: '科幻' }, { name: '中国文学' }],
      },
    });
    const meta = extractMetadata(page);
    expect(meta.tags).toContain('科幻');
    expect(meta.tags).toContain('中国文学');
    expect(meta.properties['标签']).toBe('科幻, 中国文学');
  });

  it('select → tags + properties', () => {
    const page = makePage({
      类型: { type: 'select', select: { name: '小说', color: 'blue' } },
    });
    const meta = extractMetadata(page);
    expect(meta.tags).toContain('小说');
    expect(meta.properties['类型']).toBe('小说');
  });

  it('select 为 null 时跳过', () => {
    const page = makePage({
      类型: { type: 'select', select: null },
    });
    const meta = extractMetadata(page);
    expect(meta.tags).toHaveLength(0);
    expect(meta.properties).not.toHaveProperty('类型');
  });

  it('status → tags + properties', () => {
    const page = makePage({
      状态: { type: 'status', status: { name: '已完成', color: 'green' } },
    });
    const meta = extractMetadata(page);
    expect(meta.tags).toContain('已完成');
    expect(meta.properties['状态']).toBe('已完成');
  });

  it('relation → pageRefs', () => {
    const page = makePage({
      相关文档: {
        type: 'relation',
        relation: [{ id: 'page-a' }, { id: 'page-b' }],
      },
    });
    const meta = extractMetadata(page);
    expect(meta.pageRefs).toEqual(['page-a', 'page-b']);
    expect(meta.tags).toHaveLength(0); // relation 不进 tags
  });

  it('date 属性渲染', () => {
    const page = makePage({
      截止日期: { type: 'date', date: { start: '2024-03-15', end: null } },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['截止日期']).toBe('2024-03-15');
  });

  it('date 范围渲染', () => {
    const page = makePage({
      时间段: { type: 'date', date: { start: '2024-01-01', end: '2024-12-31' } },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['时间段']).toBe('2024-01-01 → 2024-12-31');
  });

  it('number 属性', () => {
    const page = makePage({
      评分: { type: 'number', number: 4.5 },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['评分']).toBe('4.5');
  });

  it('number 为 null 时跳过', () => {
    const page = makePage({
      评分: { type: 'number', number: null },
    });
    const meta = extractMetadata(page);
    expect(meta.properties).not.toHaveProperty('评分');
  });

  it('checkbox 属性', () => {
    const page = makePage({
      已读: { type: 'checkbox', checkbox: true },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['已读']).toBe('true');
  });

  it('url 属性', () => {
    const page = makePage({
      链接: { type: 'url', url: 'https://example.com' },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['链接']).toBe('https://example.com');
  });

  it('rich_text 属性', () => {
    const page = makePage({
      备注: { type: 'rich_text', rich_text: [{ plain_text: '这是备注' }] },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['备注']).toBe('这是备注');
  });

  it('people 属性', () => {
    const page = makePage({
      负责人: { type: 'people', people: [{ name: 'Alice', id: 'u1' }, { name: 'Bob', id: 'u2' }] },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['负责人']).toBe('Alice, Bob');
  });

  it('unique_id 属性', () => {
    const page = makePage({
      ID: { type: 'unique_id', unique_id: { prefix: 'TASK', number: 42 } },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['ID']).toBe('TASK-42');
  });

  it('跳过系统属性（created_time, last_edited_time 等）', () => {
    const page = makePage({
      'Created time': { type: 'created_time', created_time: '2024-01-01T00:00:00.000Z' },
      'Last edited time': { type: 'last_edited_time', last_edited_time: '2024-01-01T00:00:00.000Z' },
    });
    const meta = extractMetadata(page);
    expect(Object.keys(meta.properties)).toHaveLength(0);
  });

  it('title 属性不进 properties', () => {
    const page = makePage({
      Name: { type: 'title', title: [{ plain_text: '标题' }] },
    });
    const meta = extractMetadata(page);
    expect(meta.properties).not.toHaveProperty('Name');
  });

  it('files 属性提取文件名', () => {
    const page = makePage({
      附件: { type: 'files', files: [{ name: 'doc.pdf' }, { name: 'photo.jpg' }] },
    });
    const meta = extractMetadata(page);
    expect(meta.properties['附件']).toBe('doc.pdf, photo.jpg');
  });

  it('filePath 为 page id', () => {
    const page = makePage({});
    const meta = extractMetadata(page);
    expect(meta.filePath).toBe('page-test-123');
  });
});

// ── renderPropertiesHeader 测试 ───────────────────────────────

describe('renderPropertiesHeader', () => {
  it('渲染属性头部', () => {
    const header = renderPropertiesHeader({
      '书名': '三体',
      '评分': '5',
      '标签': '科幻, 中国文学',
    });
    expect(header).toContain('书名: 三体');
    expect(header).toContain('评分: 5');
    expect(header).toContain('标签: 科幻, 中国文学');
    expect(header).toContain('---');
  });

  it('空属性返回空字符串', () => {
    expect(renderPropertiesHeader({})).toBe('');
  });
});
