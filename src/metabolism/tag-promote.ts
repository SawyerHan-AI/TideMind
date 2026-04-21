// ============================================================
// 标签涌现：高频标签自动提升为图节点
//
// 当一个标签被 N 个以上节点引用时，自动创建 tag 类型节点
// 并与所有引用它的节点建立 'tagged' 链接。
// 由 daemon 每日任务触发。
// ============================================================

import type Database from 'better-sqlite3';
import { createNode, updateNode, parseTags, getNode } from '../db/nodes.js';
import { createLink, linkExists, updateLinkStrength, getLinksForNode, deleteLink } from '../db/links.js';
import { getParam, getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { callLLM } from '../llm/client.js';
import { isLlmConfigured } from '../config.js';
import { TAG_DEFINE_SYSTEM } from '../llm/prompts.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tag-promote');

const DEFAULT_PROMOTE_THRESHOLD = 25;

/**
 * 计算 tagged 链接的启发式强度
 *
 * 两个信号：
 * - 内容提及度：节点 content 是否显式包含标签文本 → 命中 0.7，未命中 0.4
 * - 标签集中度：该标签是节点的唯一标签则 +0.1
 * 最终范围 0.4-0.8
 */
function computeTagLinkStrength(nodeContent: string, tagText: string, nodeTags: string[]): number {
  const contentMention = nodeContent.toLowerCase().includes(tagText.toLowerCase()) ? 0.7 : 0.4;
  const concentrationBonus = nodeTags.length === 1 ? 0.1 : 0;
  return Math.min(0.8, contentMention + concentrationBonus);
}

/**
 * 扫描高频标签，将达到阈值的标签提升为 tag 节点
 *
 * 链接创建采用启发式分级：根据内容提及度和标签集中度计算 strength，
 * 低于 tag_link_min_strength 的不创建。存量链接会被重新评估 strength。
 */
export async function promoteFrequentTags(db: Database.Database): Promise<{
  promoted: number;
  linksCreated: number;
  linksUpdated: number;
  linksRemoved: number;
}> {
  const threshold = getParam('metabolism-params', 'tag_promote_threshold', DEFAULT_PROMOTE_THRESHOLD);
  const minStrength = getParam('metabolism-params', 'tag_link_min_strength', 0.3);

  // 1. 统计所有标签及其引用的节点
  const rows = db.prepare(`
    SELECT id, tags, content FROM nodes
    WHERE tags IS NOT NULL AND heat > 0.01 AND is_tag = 0 AND is_superseded = 0
  `).all() as Array<{ id: string; tags: string; content: string }>;

  // 节点信息缓存（id → {content, tags}）
  const nodeCache = new Map<string, { content: string; tags: string[] }>();
  const tagToNodes = new Map<string, string[]>();
  for (const row of rows) {
    const tags = parseTags(row.tags);
    nodeCache.set(row.id, { content: row.content, tags });
    for (const tag of tags) {
      if (!tagToNodes.has(tag)) tagToNodes.set(tag, []);
      tagToNodes.get(tag)!.push(row.id);
    }
  }

  // 2. 找到已存在的 tag 节点（优先用 title 匹配，兼容旧数据用 content 匹配）
  const existingTagNodes = new Map<string, string>();
  const tagNodes = db.prepare(
    "SELECT id, title, content FROM nodes WHERE is_tag = 1 AND heat > 0.01 AND is_superseded = 0",
  ).all() as Array<{ id: string; title: string | null; content: string }>;
  for (const tn of tagNodes) {
    const tagName = tn.title ?? tn.content;
    existingTagNodes.set(tagName, tn.id);
  }

  // 2.5 加载手动降级黑名单（被用户降级的标签不再自动晋升）
  const demotedRaw = db.prepare("SELECT value FROM metadata WHERE key = 'demoted_tags'").get() as { value: string } | undefined;
  let demotedTags = new Set<string>();
  if (demotedRaw) {
    try { demotedTags = new Set<string>(JSON.parse(demotedRaw.value)); }
    catch { log.warn('demoted_tags 元数据 JSON 解析失败，忽略黑名单'); }
  }

  let promoted = 0;
  let linksCreated = 0;
  let linksUpdated = 0;
  let linksRemoved = 0;

  for (const [tag, nodeIds] of tagToNodes) {
    if (nodeIds.length < threshold) continue;
    if (demotedTags.has(tag)) continue;

    // 检查是否已有 tag 节点
    let tagNodeId = existingTagNodes.get(tag);

    if (!tagNodeId) {
      // 检查是否有同名内容节点可以复用（如 Logseq 页面节点）
      // 优先复用而不是创建空节点，避免同一概念产生两个节点
      const existingContent = db.prepare(
        "SELECT id FROM nodes WHERE (title = ? OR (title IS NULL AND content = ?)) AND is_tag = 0 AND is_superseded = 0 AND heat > 0.01 LIMIT 1",
      ).get(tag, tag) as { id: string } | undefined;

      if (existingContent) {
        // 直接升级现有内容节点为 tag 节点
        updateNode(db, existingContent.id, { is_tag: 1, title: tag });
        tagNodeId = existingContent.id;
        promoted++;
        log.info(`复用已有内容节点 ${existingContent.id} 作为标签「${tag}」`);
      } else {
        // 标签节点的创建时间 = 引用它的最早节点的创建时间（概念首次出现的时间）
        // 分批查询避免 SQLite 参数数量限制
        let earliestCreated: string | undefined;
        const BATCH = 500;
        for (let i = 0; i < nodeIds.length; i += BATCH) {
          const batch = nodeIds.slice(i, i + BATCH);
          const row = db.prepare(
            `SELECT MIN(created) as earliest FROM nodes WHERE id IN (${batch.map(() => '?').join(',')})`,
          ).get(...batch) as { earliest: string | null } | undefined;
          if (row?.earliest && (!earliestCreated || row.earliest < earliestCreated)) {
            earliestCreated = row.earliest;
          }
        }

        // 创建新 tag 节点：标签名作为 title，content 由 LLM 补充定义
        const tagNode = createNode(db, {
          is_tag: 1,
          title: tag,
          content: '',
          heat: 1.0,
          specificity: 0.1,
          subjectivity: 0.1,
          actuality: 0.9,
          created: earliestCreated ?? undefined,
        });
        tagNodeId = tagNode.id;
        promoted++;
      }

      // LLM 生成定义性描述（仅对内容为空的新建 tag 节点，复用的节点已有内容）
      const tagContent = getNode(db, tagNodeId)?.content ?? '';
      if (isLlmConfigured() && tagContent.trim().length === 0) {
        try {
          const contextNodes = nodeIds
            .map(id => nodeCache.get(id))
            .filter(Boolean)
            .slice(0, 10)
            .map(n => n!.content.slice(0, 300));

          const fallbackPrompt = `标签: ${tag}\n\n引用该标签的记忆:\n${contextNodes.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
          const definition = await callLLM({
            prompt: renderUserPrompt('tag-define', {
              tag,
              context_nodes: contextNodes.map((c, i) => `${i + 1}. ${c}`).join('\n'),
            }, fallbackPrompt),
            system: getPrompt('tag-define', TAG_DEFINE_SYSTEM),
            ...getLLMOptions('tag-define'),
            maxTokens: 200,
            operationName: 'tag-define',
          });

          if (definition && definition.trim()) {
            updateNode(db, tagNodeId, { content: definition.trim() });
          }
        } catch (err) {
          log.warn(`标签 "${tag}" 定义生成失败: ${(err as Error).message}`);
        }
      }
    }

    // 为引用节点创建或更新 tagged 链接
    for (const nodeId of nodeIds) {
      const cached = nodeCache.get(nodeId);
      if (!cached) continue;

      const strength = computeTagLinkStrength(cached.content, tag, cached.tags);

      if (linkExists(db, nodeId, tagNodeId)) {
        // 存量链接：用启发式重新评估 strength
        const existingLinks = getLinksForNode(db, nodeId).filter(l =>
          (l.from_id === nodeId && l.to_id === tagNodeId) ||
          (l.from_id === tagNodeId && l.to_id === nodeId),
        );
        for (const link of existingLinks) {
          const primaryType = Array.isArray(link.relation) && link.relation.length > 0
            ? link.relation[0].type : null;
          if (primaryType !== 'tagged') continue;
          // 用户主动拒绝的标签链接不重新评估 strength、不删除（保留 rejected_by_user 状态作为反馈痕迹）
          if (link.status === 'rejected_by_user') continue;

          if (strength < minStrength) {
            // 低于阈值，删除
            deleteLink(db, link.id);
            linksRemoved++;
          } else if (Math.abs(link.strength - strength) > 0.05) {
            // strength 差异显著，更新
            updateLinkStrength(db, link.id, strength);
            linksUpdated++;
          }
        }
      } else if (strength >= minStrength) {
        // 新建链接
        createLink(db, {
          from_id: nodeId,
          to_id: tagNodeId,
          relation: [{ type: 'tagged', confidence: 0.9 }],
          strength,
          auto: true,
          status: 'confirmed',
        });
        linksCreated++;
      }
    }
  }

  if (promoted > 0 || linksCreated > 0 || linksUpdated > 0 || linksRemoved > 0) {
    log.info(`标签涌现: 新提升 ${promoted} 个, 新建链接 ${linksCreated}, 更新 ${linksUpdated}, 移除 ${linksRemoved}`);
  }

  if (promoted > 0) {
    logTimelineEvent(db, {
      type: 'think_emerge',
      subtype: 'tag_promote',
      title: JSON.stringify({ key: 'tags_promoted', params: { count: promoted } }),
      detail: { promoted, links_created: linksCreated, links_updated: linksUpdated, links_removed: linksRemoved },
      important: 1,
    });
  }

  return { promoted, linksCreated, linksUpdated, linksRemoved };
}
