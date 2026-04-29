// ============================================================
// Notion API Client — 速率控制 + 分页 + 重试
// ============================================================

import { Client } from '@notionhq/client';
import type {
  BlockObjectResponse,
  PageObjectResponse,
  PartialBlockObjectResponse,
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
    // retryWithBackoff 处理 429 / 502 等瞬时故障 — 老代码单次调用,偶发
    // 网络抖动会让用户看到 "token 无效",用户会去撤销/重建 token 然后
    // 发现没用。走 retry 路径和其他调用点一致。
    await rateLimiter.acquire();
    const response = await retryWithBackoff(() => client.search({ page_size: 1 }));
    return {
      valid: true,
      pageCount: response.results.length > 0 ? -1 : 0, // -1 表示有页面但数量未知
    };
  } catch (e) {
    // 区分真正 401 和网络错误:401 才说 token 无效。
    //
    // v0.2.22 修正:老代码所有错误都 return valid:false → 调用方看不出是
    // token 真的过期还是网络抖动,用户会去重建 token 发现没用。
    // 现在:
    //   - 401 / Unauthorized → valid:false (token 真坏)
    //   - 其他 (502, timeout, DNS 等) → throw,让上游决定"先启动再重试"
    //     而不是直接给用户"token 无效"的错误提示
    const msg = (e as Error).message || '';
    const isAuth = /401|unauthor|invalid.*token/i.test(msg);
    if (isAuth) {
      log.warn('Notion token invalid (401)');
      return { valid: false, pageCount: 0 };
    }
    log.warn(`Notion token validation transient failure: ${msg.slice(0, 200)}`);
    throw new Error(`Notion validation transient: ${msg}`, { cause: e });
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
 * Notion 删除检测只应把明确的单页不可访问当作"已删除/取消共享"。
 * 5xx / 429 / timeout / DNS 等临时错误必须保留旧 sync state,否则周期性
 * 删除检测会把 API 抖动误判成页面删除并归档节点。
 */
export function isConfirmedNotionPageGoneError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 403 || status === 404) return true;

  const code = String((err as { code?: string })?.code ?? '');
  if (code === 'object_not_found' || code === 'restricted_resource') return true;

  const message = String((err as Error)?.message ?? '');
  return /\b(403|404)\b|object_not_found|restricted_resource/i.test(message);
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
    const syncData = (block as { synced_block?: { synced_from?: { type?: string; block_id?: string } | null } }).synced_block;
    // 只有 synced_from.type === 'block_id' 才是 duplicate；未来 SDK 若扩展其他
    // type（如 workspace 等），保守按 original 处理,避免误判漏取内容。
    if (syncData?.synced_from?.type === 'block_id') return false;
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
        // 最后一次迭代不再 sleep:再 sleep 也不会重试,直接 throw 更快。
        if (i === maxRetries) throw e;
        // 防御性读取 Retry-After:
        //  - Notion SDK 可能把 headers 暴露为普通对象或 Headers 实例,
        //    两种形式都要支持。
        //  - header 缺失 / 格式非法时 parseInt 返回 NaN,
        //    `NaN * 1000` 仍是 NaN;`sleep(NaN)` 的 setTimeout 会立即触发,
        //    于是 429 重试会变成 hot loop,几毫秒内打爆配额。
        //    必须在选择 waitMs 前过滤掉 NaN/非正数。
        //  - RFC 7231 允许 Retry-After 是 HTTP-date(如 "Wed, 21 Oct ..."),
        //    这种情况 parseInt 会失败,改走 Date.parse 的分支。
        //  - 最后再加 60s 上限,避免上游给个离谱的大值挂住我们。
        const rawHeaders = (e as { headers?: unknown }).headers;
        // Headers 实例的 `['retry-after']` 会返回 undefined（非 index signature），
        // 必须先走 `.get('retry-after')`；再 fallback 到普通对象的 bracket access。
        const raw =
          (rawHeaders as { get?: (k: string) => string | null } | undefined)?.get?.('retry-after') ??
          (rawHeaders as Record<string, string> | undefined)?.['retry-after'] ??
          undefined;
        const parsed = raw ? parseInt(raw, 10) : NaN;
        let waitMs: number;
        if (Number.isFinite(parsed) && parsed > 0) {
          waitMs = Math.min(parsed * 1000, 60_000);
        } else if (typeof raw === 'string' && Number.isNaN(parsed)) {
          // 尝试解析为 HTTP-date
          const parsedDate = Date.parse(raw);
          if (Number.isFinite(parsedDate)) {
            waitMs = Math.min(Math.max(0, parsedDate - Date.now()), 60_000);
          } else {
            waitMs = (2 ** i) * 1000;
          }
        } else {
          waitMs = (2 ** i) * 1000;
        }
        log.warn(`速率限制，等待 ${waitMs}ms 后重试 (${i}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }

      if (status === 502 || status === 503 || status === 504) {
        // 同上,最后一次迭代不再 sleep。
        if (i === maxRetries) throw e;
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
