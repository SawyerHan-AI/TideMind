// ============================================================
// Notion 预处理器
//
// 组合 api-client + block-renderer + property-extractor，
// 将 Notion 页面转换为 PreprocessedPage。
// ============================================================

import type { PageObjectResponse, BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';
import { createLogger } from '../../utils/logger.js';
import { getPageBlocks, getFullRelationProperty } from './api-client.js';
import { renderBlocks } from './block-renderer.js';
import { extractMetadata, renderPropertiesHeader, extractTitle } from './property-extractor.js';
import type { PreprocessedPage, PageMetadata } from './types.js';
import { createHash } from 'crypto';

const log = createLogger('notion:preprocess');

/** 预处理结果，包含 content hash（避免双重 block 获取） */
export interface PreprocessResult {
  page: PreprocessedPage | null;
  contentHash: string;
}

/**
 * 将 Notion 页面预处理为 PreprocessedPage + contentHash。
 *
 * blocks 只获取一次，同时用于渲染和 hash 计算。
 */
export async function preprocessNotionPage(
  token: string,
  page: PageObjectResponse,
): Promise<PreprocessResult> {
  const title = extractTitle(page);

  // 1. 提取属性
  const metadata = extractMetadata(page);

  // 2. 处理 relation 分页（>25 条截断）
  await resolveRelationPagination(token, page, metadata);

  // 3. 获取 blocks（只获取一次）
  let blocks: BlockObjectResponse[];
  try {
    blocks = await getPageBlocks(token, page.id);
  } catch (e) {
    log.error(`获取页面 blocks 失败 (${page.id}): ${(e as Error).message}`);
    // block 获取失败时无法计算稳定 hash，返回基于属性的 hash + null page
    const propsHash = createHash('sha256')
      .update(JSON.stringify(page.properties) + '__BLOCKS_FAILED__')
      .digest('hex').slice(0, 16);
    return { page: null, contentHash: propsHash };
  }

  // 4. 计算 content hash（properties + blocks，共享同一次 block 获取）
  const propsJson = JSON.stringify(page.properties);
  const blocksJson = JSON.stringify(blocks.map(b => ({ id: b.id, type: b.type, last_edited_time: b.last_edited_time })));
  const contentHash = createHash('sha256').update(propsJson + blocksJson).digest('hex').slice(0, 16);

  // 5. 渲染 blocks → Markdown
  const renderResult = renderBlocks(blocks);

  // 合并 pageRefs（来自属性 relation + 正文 mention）
  for (const ref of renderResult.pageRefs) {
    if (!metadata.pageRefs.includes(ref)) {
      metadata.pageRefs.push(ref);
    }
  }

  // 6. 组装 cleanContent：属性头部 + 正文
  const propsHeader = renderPropertiesHeader(metadata.properties);
  const cleanContent = propsHeader + renderResult.text;

  // 空内容检查
  if (cleanContent.trim().length === 0 && Object.keys(metadata.properties).length === 0) {
    log.debug(`跳过空页面: ${title} (${page.id})`);
    return { page: null, contentHash };
  }

  return { page: { title, cleanContent, metadata }, contentHash };
}

// ── 内部辅助 ──────────────────────────────────────────────────

/**
 * 处理 relation 属性的 >25 条截断
 */
async function resolveRelationPagination(
  token: string,
  page: PageObjectResponse,
  metadata: PageMetadata,
): Promise<void> {
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type !== 'relation') continue;
    const relProp = prop as { type: 'relation'; id: string; relation: Array<{ id: string }>; has_more?: boolean };
    if (!relProp.has_more) continue;

    log.debug(`Relation 属性 ${relProp.id} 超过 25 条，分页获取`);
    try {
      const fullIds = await getFullRelationProperty(token, page.id, relProp.id);
      const truncatedIds = new Set(relProp.relation.map(r => r.id));
      metadata.pageRefs = metadata.pageRefs.filter(ref => !truncatedIds.has(ref));
      metadata.pageRefs.push(...fullIds);
    } catch (e) {
      log.warn(`分页获取 relation 失败: ${(e as Error).message}`);
    }
  }
}
