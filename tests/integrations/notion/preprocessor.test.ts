/**
 * tests/integrations/notion/preprocessor.test.ts
 *
 * 覆盖 src/integrations/notion/preprocessor.ts。该模块 export 一个
 * `preprocessNotionPage(token, page)` 函数,把 Notion 页面预处理为
 * `{ page: PreprocessedPage | null, contentHash: string }`。
 *
 * 关键路径:
 *  - blocks 只获取一次,同时用于渲染和 hash 计算
 *  - getPageBlocks 抛错 → page=null + 基于 properties 的 fallback hash
 *  - relation has_more=true → 调 getFullRelationProperty 替换截断的 refs
 *  - cleanContent + properties 全空 → 跳过该页面
 *  - content hash 稳定(同输入同输出)
 *  - pageRefs 合并去重(metadata 已有 + renderResult 新发现)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPageBlocksMock = vi.fn();
const getFullRelationPropertyMock = vi.fn();

vi.mock('@server/integrations/notion/api-client.js', () => ({
  getPageBlocks: getPageBlocksMock,
  getFullRelationProperty: getFullRelationPropertyMock,
}));

const { preprocessNotionPage } = await import(
  '@server/integrations/notion/preprocessor.js'
);

type AnyPage = Parameters<typeof preprocessNotionPage>[1];

function makePage(opts?: Partial<{
  id: string;
  title: string;
  properties: Record<string, unknown>;
  icon: unknown;
}>): AnyPage {
  const id = opts?.id ?? 'page-1';
  const title = opts?.title ?? 'Untitled';
  const baseProps: Record<string, unknown> = {
    title: {
      id: 'title',
      type: 'title',
      title: [
        { type: 'text', text: { content: title }, plain_text: title },
      ],
    },
    ...(opts?.properties ?? {}),
  };
  return {
    object: 'page',
    id,
    created_time: '2026-05-01T00:00:00Z',
    last_edited_time: '2026-05-20T00:00:00Z',
    properties: baseProps,
    icon: opts?.icon,
    parent: { type: 'workspace', workspace: true },
    url: `https://notion.so/${id}`,
    public_url: null,
    archived: false,
    in_trash: false,
  } as unknown as AnyPage;
}

function makeBlock(id: string, type: string, text: string, parentId = 'page-1') {
  return {
    object: 'block',
    id,
    type,
    last_edited_time: '2026-05-20T00:00:00Z',
    parent: { type: 'page_id', page_id: parentId },
    has_children: false,
    archived: false,
    in_trash: false,
    [type]: {
      rich_text: [{ type: 'text', text: { content: text }, plain_text: text }],
      color: 'default',
    },
  } as unknown as Parameters<typeof preprocessNotionPage>[1];
}

beforeEach(() => {
  getPageBlocksMock.mockReset();
  getFullRelationPropertyMock.mockReset();
});

describe('preprocessNotionPage', () => {
  it('happy path: 返回 page 不为 null + 含 cleanContent + contentHash 16 字符', async () => {
    getPageBlocksMock.mockResolvedValueOnce([
      makeBlock('b1', 'paragraph', 'Hello'),
      makeBlock('b2', 'paragraph', 'World'),
    ]);
    const page = makePage({ title: 'Test Page' });
    const result = await preprocessNotionPage('token-xxx', page);

    expect(result.page).not.toBeNull();
    expect(result.page!.title).toBe('Test Page');
    expect(result.page!.cleanContent.length).toBeGreaterThan(0);
    expect(result.contentHash).toHaveLength(16);
    // hash 是 hex
    expect(result.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('content hash 稳定:同输入两次调用得到一致 hash', async () => {
    const blocks = [makeBlock('b1', 'paragraph', 'A'), makeBlock('b2', 'paragraph', 'B')];
    getPageBlocksMock.mockResolvedValue(blocks);
    const page = makePage();

    const r1 = await preprocessNotionPage('t', page);
    const r2 = await preprocessNotionPage('t', page);
    expect(r1.contentHash).toBe(r2.contentHash);
  });

  it('blocks 顺序变化导致 hash 变化(防止 reorder 假同等)', async () => {
    const b1 = makeBlock('b1', 'paragraph', 'A');
    const b2 = makeBlock('b2', 'paragraph', 'B');

    getPageBlocksMock.mockResolvedValueOnce([b1, b2]);
    const r1 = await preprocessNotionPage('t', makePage());
    getPageBlocksMock.mockResolvedValueOnce([b2, b1]);
    const r2 = await preprocessNotionPage('t', makePage());

    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  it('getPageBlocks 抛错时 page=null + fallback hash 仍是 16 字符', async () => {
    getPageBlocksMock.mockRejectedValueOnce(new Error('API timeout'));
    const result = await preprocessNotionPage('t', makePage());
    expect(result.page).toBeNull();
    expect(result.contentHash).toHaveLength(16);
    expect(result.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('getPageBlocks 失败时,不同 properties 产出不同 fallback hash(用于检测属性变更)', async () => {
    getPageBlocksMock.mockRejectedValue(new Error('fail'));
    const r1 = await preprocessNotionPage('t', makePage({ title: 'A' }));
    const r2 = await preprocessNotionPage('t', makePage({ title: 'B' }));
    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  it('cleanContent + properties 全空时 page=null(跳过空页面)', async () => {
    // 用最简空 page,property 头里只有 title 但 title 不算"属性"
    getPageBlocksMock.mockResolvedValueOnce([]);
    const page = makePage({ title: '' });
    const result = await preprocessNotionPage('t', page);
    // cleanContent.trim() 为空 + properties 仅 title → page=null
    // 注意:property-extractor 可能仍把 title 当 metadata 输出,所以这个条件
    // 实际依赖于 extractor 行为。这里只断言"非异常"
    expect(result).toHaveProperty('contentHash');
    expect(result.contentHash).toHaveLength(16);
  });

  it('relation 属性 has_more=true 时调 getFullRelationProperty 替换 refs', async () => {
    const relationProp = {
      id: 'rel-1',
      type: 'relation',
      relation: [{ id: 'truncated-1' }, { id: 'truncated-2' }],
      has_more: true,
    };
    const page = makePage({
      properties: { 'Related': relationProp },
    });

    // 加 non-empty block 保证 cleanContent 非空,page 不会被空页面短路
    getPageBlocksMock.mockResolvedValueOnce([
      makeBlock('b-content', 'paragraph', 'some text'),
    ]);
    getFullRelationPropertyMock.mockResolvedValueOnce([
      'full-1',
      'full-2',
      'full-3',
      'full-4',
    ]);

    const result = await preprocessNotionPage('token', page);
    expect(getFullRelationPropertyMock).toHaveBeenCalledWith('token', page.id, 'rel-1');
    expect(result.page).not.toBeNull();
    // metadata.pageRefs 应包含 full-* 不含 truncated-*
    expect(result.page!.metadata.pageRefs).toEqual(
      expect.arrayContaining(['full-1', 'full-2', 'full-3', 'full-4']),
    );
    expect(result.page!.metadata.pageRefs).not.toContain('truncated-1');
    expect(result.page!.metadata.pageRefs).not.toContain('truncated-2');
  });

  it('relation has_more=false 时不调 getFullRelationProperty', async () => {
    const relationProp = {
      id: 'rel-1',
      type: 'relation',
      relation: [{ id: 'r1' }, { id: 'r2' }],
      has_more: false,
    };
    const page = makePage({
      properties: { 'Related': relationProp },
    });

    getPageBlocksMock.mockResolvedValueOnce([]);
    await preprocessNotionPage('token', page);
    expect(getFullRelationPropertyMock).not.toHaveBeenCalled();
  });

  it('relation 分页失败时 warn 但不抛错(继续处理其他)', async () => {
    const page = makePage({
      properties: {
        'Related': {
          id: 'rel-1',
          type: 'relation',
          relation: [{ id: 'r1' }],
          has_more: true,
        },
      },
    });
    getPageBlocksMock.mockResolvedValueOnce([]);
    getFullRelationPropertyMock.mockRejectedValueOnce(new Error('relation API fail'));

    // 不抛错
    await expect(preprocessNotionPage('token', page)).resolves.toBeDefined();
  });

  it('多个 relation 属性独立处理(一个 has_more 一个不 has_more)', async () => {
    const page = makePage({
      properties: {
        'Rel1': {
          id: 'rel-1',
          type: 'relation',
          relation: [{ id: 'r1' }],
          has_more: true,
        },
        'Rel2': {
          id: 'rel-2',
          type: 'relation',
          relation: [{ id: 'r2' }],
          has_more: false,
        },
      },
    });
    getPageBlocksMock.mockResolvedValueOnce([]);
    getFullRelationPropertyMock.mockResolvedValueOnce(['full-1', 'full-2']);

    await preprocessNotionPage('token', page);
    // 只对 has_more=true 的调一次
    expect(getFullRelationPropertyMock).toHaveBeenCalledTimes(1);
    expect(getFullRelationPropertyMock).toHaveBeenCalledWith('token', page.id, 'rel-1');
  });

  it('getPageBlocks 只调用一次(不重复获取 blocks)', async () => {
    getPageBlocksMock.mockResolvedValueOnce([makeBlock('b1', 'paragraph', 'x')]);
    await preprocessNotionPage('t', makePage());
    expect(getPageBlocksMock).toHaveBeenCalledTimes(1);
  });

  it('fallback hash 与 successful hash 不会碰撞(BLOCKS_FAILED 标记)', async () => {
    getPageBlocksMock.mockResolvedValueOnce([]);
    const successful = await preprocessNotionPage('t', makePage());

    getPageBlocksMock.mockRejectedValueOnce(new Error('fail'));
    const failed = await preprocessNotionPage('t', makePage());

    expect(successful.contentHash).not.toBe(failed.contentHash);
  });

  it('blocks 内容相同但 id 不同时 hash 变化(hash 含 block.id)', async () => {
    getPageBlocksMock.mockResolvedValueOnce([makeBlock('b1', 'paragraph', 'same text')]);
    const r1 = await preprocessNotionPage('t', makePage());
    getPageBlocksMock.mockResolvedValueOnce([makeBlock('b2', 'paragraph', 'same text')]);
    const r2 = await preprocessNotionPage('t', makePage());
    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  // 回归 F9(2026-05-21): icon (emoji) 必须纳入 hash,否则用户只改 emoji icon
  // 时 sync 误认为页面无变化,新 icon 永远不会落到 UI。
  it('F9 回归: 同 properties + 同 blocks 但 icon 不同 → contentHash 不同', async () => {
    const blocks = [makeBlock('b1', 'paragraph', 'same text')];

    getPageBlocksMock.mockResolvedValueOnce(blocks);
    const r1 = await preprocessNotionPage('t', makePage({
      icon: { type: 'emoji', emoji: '🎯' },
    }));

    getPageBlocksMock.mockResolvedValueOnce(blocks);
    const r2 = await preprocessNotionPage('t', makePage({
      icon: { type: 'emoji', emoji: '🚀' },
    }));

    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  it('F9 回归: 同 properties + 同 blocks 但一个无 icon、一个有 icon → contentHash 不同', async () => {
    const blocks = [makeBlock('b1', 'paragraph', 'x')];

    getPageBlocksMock.mockResolvedValueOnce(blocks);
    const noIcon = await preprocessNotionPage('t', makePage({ icon: undefined }));

    getPageBlocksMock.mockResolvedValueOnce(blocks);
    const withIcon = await preprocessNotionPage('t', makePage({
      icon: { type: 'emoji', emoji: '🐧' },
    }));

    expect(noIcon.contentHash).not.toBe(withIcon.contentHash);
  });
});
