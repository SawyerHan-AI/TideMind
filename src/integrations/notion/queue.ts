// ============================================================
// Notion 页面处理队列
// ============================================================

import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { digest } from '../../tools/digest.js';
import { supersedeNode } from '../shared/version.js';
import { promotePropertyValues, getOrCreateTagNode } from '../shared/property-promote.js';
import { createLink } from '../../db/links.js';
import { getPageProperties, getParentTitle } from './api-client.js';
import { preprocessNotionPage } from './preprocessor.js';
import { segmentContent } from './segmenter.js';
import {
  getPageState,
  updatePageState,
  addPendingRelation,
  getPendingRelationsForTarget,
  removePendingRelation,
  removePendingRelationsForSource,
} from './sync-state.js';
import { NOTION_SYSTEM_PROPERTIES } from './types.js';
import type { ImportProgress, NotionPageSummary } from './types.js';

const log = createLogger('notion:queue');

// ── 进度追踪 ──────────────────────────────────────────────────

const progressMap = new Map<string, ImportProgress>();

function getProgress(sourceId: string): ImportProgress {
  if (!progressMap.has(sourceId)) {
    progressMap.set(sourceId, {
      phase: 'idle',
      totalFiles: 0,
      processedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      currentFile: null,
      startedAt: null,
    });
  }
  return progressMap.get(sourceId)!;
}

export function getImportProgress(sourceId: string): ImportProgress {
  return { ...getProgress(sourceId) };  // 返回浅拷贝，不暴露内部可变状态
}

export function resetProgress(sourceId: string): void {
  progressMap.delete(sourceId);
}

// ── 主处理函数 ────────────────────────────────────────────────

/**
 * 处理一批 Notion 页面
 */
export async function processNotionPages(
  db: Database.Database,
  token: string,
  pages: NotionPageSummary[],
  sourceId: string,
): Promise<void> {
  const progress = getProgress(sourceId);
  Object.assign(progress, {
    phase: 'processing' as const,
    totalFiles: pages.length,
    processedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    startedAt: new Date().toISOString(),
  });

  for (const pageSummary of pages) {
    progress.currentFile = pageSummary.title;

    try {
      await processOnePage(db, token, pageSummary, sourceId);
      progress.processedFiles++;
    } catch (e) {
      log.error(`处理页面失败 (${pageSummary.id}): ${(e as Error).message}`);
      progress.failedFiles++;
    }
  }

  progress.phase = 'done';
  progress.currentFile = null;
}

// ── 单页面处理 ────────────────────────────────────────────────

async function processOnePage(
  db: Database.Database,
  token: string,
  pageSummary: NotionPageSummary,
  sourceId: string,
): Promise<void> {
  const pageId = pageSummary.id;
  const pageType = pageSummary.parentType === 'database_id' ? 'database_page' as const : 'page' as const;

  // 1. 获取完整页面属性
  const fullPage = await getPageProperties(token, pageId);

  // 2. 预处理（一次性获取 blocks + 计算 hash + 渲染内容）
  const { page: preprocessed, contentHash } = await preprocessNotionPage(token, fullPage);

  // 3. 检查是否变更
  const prevState = getPageState(db, pageId, sourceId);
  if (prevState && prevState.content_hash === contentHash) {
    log.debug(`页面未变更，跳过: ${pageSummary.title}`);
    return;
  }

  // 4. 预处理返回空（block 获取失败或空页面）
  if (!preprocessed) {
    log.debug(`页面预处理返回空，跳过: ${pageSummary.title}`);
    return;
  }

  // 5. 分段
  const segments = segmentContent(preprocessed.cleanContent, preprocessed.title);
  if (segments.length === 0) {
    // 无实质内容但有属性 → 创建标题节点
    const result = await digest(db, {
      content: preprocessed.title,
      title: preprocessed.title,
      source: { tool: 'notion', files: [pageId] },
      tags: preprocessed.metadata.tags.length > 0 ? preprocessed.metadata.tags : undefined,
      async: false,
    });
    const nodeIds = result.created_nodes?.map(n => n.id) ?? [];
    updatePageState(db, pageId, contentHash, pageSummary.lastEditedTime, pageType, nodeIds, sourceId);
    return;
  }

  // 6. Digest 每个 segment
  const allNodeIds: string[] = [];
  const combinedTags = preprocessed.metadata.tags;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const contextParts = segment.context !== preprocessed.title
      ? `${preprocessed.title} > ${segment.context}`
      : preprocessed.title;

    const result = await digest(db, {
      content: segment.content,
      title: preprocessed.title,
      source: { tool: 'notion', files: [pageId] },
      context: contextParts,
      tags: i === 0 && combinedTags.length > 0 ? combinedTags : undefined,
      async: false,
    });

    if (result.created_nodes) {
      allNodeIds.push(...result.created_nodes.map(n => n.id));
    }
  }

  if (allNodeIds.length === 0) {
    log.debug(`页面未产生节点: ${pageSummary.title}`);
    return;
  }

  // 7. 多 segment 间创建 part_of link
  for (let i = 1; i < allNodeIds.length; i++) {
    createLink(db, {
      from_id: allNodeIds[i],
      to_id: allNodeIds[i - 1],
      relation: [{ type: 'part_of', confidence: 0.95 }],
      strength: 0.9,
      note: 'Notion page segment chain',
      auto: true,
      status: 'confirmed',
    });
  }

  // 8. Version management: supersede old nodes
  const oldNodeIds = prevState?.node_ids ?? [];
  for (let i = 0; i < Math.min(oldNodeIds.length, allNodeIds.length); i++) {
    supersedeNode(db, oldNodeIds[i], allNodeIds[i]);
  }
  // 多余的旧节点标记为 superseded
  if (oldNodeIds.length > allNodeIds.length) {
    for (let i = allNodeIds.length; i < oldNodeIds.length; i++) {
      db.prepare('UPDATE nodes SET is_superseded = 1, heat = 0.01 WHERE id = ?').run(oldNodeIds[i]);
    }
  }

  // 9. Property promotion
  await promotePropertyValues(
    db,
    preprocessed.metadata.properties,
    allNodeIds,
    'notion',
    NOTION_SYSTEM_PROPERTIES,
  );

  // 10. 清除旧的 pending relations（在添加新的之前清除，避免先加后删）
  removePendingRelationsForSource(db, pageId, sourceId);

  // 11. Relation 属性 → pending links
  await processRelations(db, pageId, preprocessed.metadata.pageRefs, allNodeIds[0], sourceId);

  // 12. 父页面标题 → tag
  await processParentTag(db, token, pageSummary, allNodeIds);

  // 13. 回填 pending relations（当前页面可能是其他页面的 target）
  await fulfillPendingRelations(db, pageId, allNodeIds[0], sourceId);

  // 14. 更新同步状态
  updatePageState(db, pageId, contentHash, pageSummary.lastEditedTime, pageType, allNodeIds, sourceId);

  log.info(`已处理: ${preprocessed.title} → ${allNodeIds.length} 个节点`);
}

// ── Relation 处理 ────────────────────────────────────────────

async function processRelations(
  db: Database.Database,
  sourcePageId: string,
  pageRefs: string[],
  sourceNodeId: string,
  sourceId: string,
): Promise<void> {
  for (const targetPageId of pageRefs) {
    const targetState = getPageState(db, targetPageId, sourceId);

    if (targetState && targetState.node_ids.length > 0) {
      // 目标已同步 → 创建 pending link（Phase 6 LLM 评估时重判关系类型）
      createLink(db, {
        from_id: sourceNodeId,
        to_id: targetState.node_ids[0],
        relation: [{ type: 'supports', confidence: 0.7 }],
        strength: 0.5,
        note: `Notion relation/mention`,
        auto: true,
        status: 'pending',
      });
    } else {
      // 目标未同步 → 记录 pending relation
      addPendingRelation(db, {
        source_page_id: sourcePageId,
        target_page_id: targetPageId,
        source_node_id: sourceNodeId,
        property_name: 'relation',
        source_id: sourceId,
      });
    }
  }
}

// ── Parent tag 处理 ──────────────────────────────────────────

async function processParentTag(
  db: Database.Database,
  token: string,
  pageSummary: NotionPageSummary,
  nodeIds: string[],
): Promise<void> {
  if (!pageSummary.parentId || pageSummary.parentType === 'workspace') return;

  const parentTitle = await getParentTitle(token, pageSummary.parentType, pageSummary.parentId);
  if (!parentTitle) return;

  const tagNodeId = await getOrCreateTagNode(db, parentTitle, 'notion');

  createLink(db, {
    from_id: nodeIds[0],
    to_id: tagNodeId,
    relation: [{ type: 'tagged', confidence: 0.7 }],
    strength: 0.7,
    note: `Notion parent: ${pageSummary.parentType}`,
    auto: true,
    status: 'confirmed',
  });
}

// ── Pending relation 回填 ────────────────────────────────────

async function fulfillPendingRelations(
  db: Database.Database,
  targetPageId: string,
  targetNodeId: string,
  sourceId: string,
): Promise<void> {
  const pending = getPendingRelationsForTarget(db, targetPageId, sourceId);

  for (const rel of pending) {
    createLink(db, {
      from_id: rel.source_node_id,
      to_id: targetNodeId,
      relation: [{ type: 'supports', confidence: 0.7 }],
      strength: 0.5,
      note: `Notion relation: ${rel.property_name}`,
      auto: true,
      status: 'pending',
    });
    removePendingRelation(db, rel.source_page_id, targetPageId, sourceId);
  }
}
