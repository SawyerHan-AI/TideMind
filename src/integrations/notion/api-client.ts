// ============================================================
// Notion API Client — 速率控制 + 分页 + 重试
// ============================================================

import { Client } from '@notionhq/client';
import type {
  BlockObjectResponse,
  PageObjectResponse,
  PartialBlockObjectResponse,
  PartialPageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints.js';
import { createLogger } from '../../utils/logger.js';
import type { NotionPageSummary } from './types.js';

const log = createLogger('notion-api');

// ── 速率控制 ──────────────────────────────────────────────────

class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number = 3,
    private refillRate: number = 3, // tokens per second
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // 等待直到有 token
    const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
    await sleep(Math.ceil(waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 公开 API ──────────────────────────────────────────────────

const rateLimiter = new RateLimiter(5, 3); // burst 5, 3/s refill

/**
 * 创建 Notion Client（内部使用，不直接暴露 Client 实例）
 */
function createClient(token: string): Client {
  return new Client({
    auth: token,
    notionVersion: '2022-06-28', // 使用稳定版本，SDK 会自动处理
  });
}

/**
 * 验证 Token 有效性 + 返回可访问页面数
 */
export async function validateToken(token: string): Promise<{
  valid: boolean;
  pageCount: number;
  workspaceName?: string;
}> {
  try {
    const client = createClient(token);
    await rateLimiter.acquire();
    const response = await client.search({
      page_size: 1,
    });
    return {
      valid: true,
      pageCount: response.results.length > 0 ? -1 : 0, // -1 表示有页面但数量未知
    };
  } catch (e) {
    log.error('Token 验证失败');
    return { valid: false, pageCount: 0 };
  }
}

/**
 * 全量扫描所有可访问的页面（Search API 分页）
 */
export async function* listAllPages(token: string): AsyncGenerator<NotionPageSummary> {
  const client = createClient(token);
  let cursor: string | undefined;

  do {
    await rateLimiter.acquire();
    const response = await retryWithBackoff(() =>
      client.search({
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 100,
        start_cursor: cursor,
      }),
    );

    for (const result of response.results) {
      if (result.object !== 'page') continue;
      const page = result as PageObjectResponse;
      yield extractPageSummary(page);
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
}

/**
 * 获取页面属性（含 relation 分页）
 */
export async function getPageProperties(
  token: string,
  pageId: string,
): Promise<PageObjectResponse> {
  const client = createClient(token);
  await rateLimiter.acquire();
  const page = await retryWithBackoff(() => client.pages.retrieve({ page_id: pageId }));
  return page as PageObjectResponse;
}

/**
 * 获取页面 relation 属性的完整值（处理 >25 条截断）
 */
export async function getFullRelationProperty(
  token: string,
  pageId: string,
  propertyId: string,
): Promise<string[]> {
  const client = createClient(token);
  const pageIds: string[] = [];
  let cursor: string | undefined;

  do {
    await rateLimiter.acquire();
    const response = await retryWithBackoff(() =>
      client.pages.properties.retrieve({
        page_id: pageId,
        property_id: propertyId,
        start_cursor: cursor,
      }),
    );

    if (response.object === 'list') {
      for (const item of response.results) {
        if (item.type === 'relation') {
          pageIds.push(item.relation.id);
        }
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } else {
      // 单值响应（不需要分页）
      break;
    }
  } while (cursor);

  return pageIds;
}

/**
 * 递归获取页面所有 blocks（BFS + 分页）
 */
export async function getPageBlocks(
  token: string,
  pageId: string,
): Promise<BlockObjectResponse[]> {
  const client = createClient(token);
  const allBlocks: BlockObjectResponse[] = [];
  const queue: string[] = [pageId];

  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const children = await fetchBlockChildren(client, parentId);

    for (const block of children) {
      allBlocks.push(block);

      // 决定是否递归获取子块
      if (block.has_children && shouldRecurse(block)) {
        queue.push(block.id);
      }
    }
  }

  return allBlocks;
}

/**
 * 获取父级标题（页面或数据库）
 */
export async function getParentTitle(
  token: string,
  parentType: string,
  parentId: string,
): Promise<string | null> {
  const client = createClient(token);
  try {
    await rateLimiter.acquire();
    if (parentType === 'page_id') {
      const page = await retryWithBackoff(() =>
        client.pages.retrieve({ page_id: parentId }),
      ) as PageObjectResponse;
      return extractTitleFromProperties(page.properties);
    } else if (parentType === 'database_id') {
      const db = await retryWithBackoff(() =>
        client.databases.retrieve({ database_id: parentId }),
      );
      if ('title' in db && Array.isArray(db.title)) {
        return db.title.map((t: { plain_text: string }) => t.plain_text).join('') || null;
      }
    }
  } catch (e) {
    log.warn(`获取父级标题失败 (${parentType}:${parentId}): ${(e as Error).message}`);
  }
  return null;
}

// ── 内部辅助 ──────────────────────────────────────────────────

async function fetchBlockChildren(
  client: Client,
  blockId: string,
): Promise<BlockObjectResponse[]> {
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    await rateLimiter.acquire();
    const response = await retryWithBackoff(() =>
      client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: cursor,
      }),
    );

    for (const block of response.results) {
      if (isFullBlock(block)) {
        blocks.push(block);
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return blocks;
}

function shouldRecurse(block: BlockObjectResponse): boolean {
  const type = block.type;

  // child_page / child_database 是独立页面，在主循环中单独处理
  if (type === 'child_page' || type === 'child_database') return false;

  // synced_block duplicate 跳过（内容在 original 中）
  if (type === 'synced_block') {
    const syncData = block.synced_block as { synced_from: { block_id: string } | null };
    if (syncData.synced_from !== null) return false;
  }

  // 其余有 children 的块都递归：toggle, callout, quote, list items,
  // column_list, column, table, toggle heading, tab 等
  return true;
}

function isFullBlock(
  block: BlockObjectResponse | PartialBlockObjectResponse,
): block is BlockObjectResponse {
  return 'type' in block && block.type !== undefined;
}

function extractPageSummary(page: PageObjectResponse): NotionPageSummary {
  const title = extractTitleFromProperties(page.properties) || 'Untitled';

  let parentType: NotionPageSummary['parentType'] = 'workspace';
  let parentId: string | null = null;
  if (page.parent.type === 'page_id') {
    parentType = 'page_id';
    parentId = page.parent.page_id;
  } else if (page.parent.type === 'database_id') {
    parentType = 'database_id';
    parentId = page.parent.database_id;
  }

  let icon: NotionPageSummary['icon'] = null;
  if (page.icon && page.icon.type === 'emoji') {
    icon = { type: 'emoji', emoji: page.icon.emoji };
  }

  return {
    id: page.id,
    title,
    lastEditedTime: page.last_edited_time,
    parentType,
    parentId,
    inTrash: (page as unknown as { in_trash?: boolean }).in_trash ?? false,
    icon,
    url: page.url,
  };
}

function extractTitleFromProperties(
  properties: PageObjectResponse['properties'],
): string | null {
  for (const prop of Object.values(properties)) {
    if (prop.type === 'title' && 'title' in prop) {
      const titleArr = prop.title as Array<{ plain_text: string }>;
      const text = titleArr.map(t => t.plain_text).join('');
      if (text) return text;
    }
  }
  return null;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      const status = (e as { status?: number }).status;

      if (status === 429) {
        // 速率限制 — 读取 Retry-After 或默认退避
        const retryAfter = (e as { headers?: Record<string, string> }).headers?.['retry-after'];
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (2 ** i) * 1000;
        log.warn(`速率限制，等待 ${waitMs}ms 后重试 (${i}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }

      if (status === 502 || status === 503 || status === 504) {
        const waitMs = (2 ** i) * 1000;
        log.warn(`服务端错误 ${status}，等待 ${waitMs}ms 后重试 (${i}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }

      // 其他错误不重试
      throw e;
    }
  }
  throw lastError!;
}
