// ============================================================
// 属性值提升为 tag 节点（Logseq / Obsidian 共用）
//
// 纯文本属性值（非数字/日期/URL/布尔）创建 tag 节点，
// 并建立 tagged 链接（confidence 0.6，note 存属性名）。
// ============================================================

import type Database from 'better-sqlite3';
import { SqliteRepository } from '../../db/sqlite-repository.js';
import { createLogger } from '../../utils/logger.js';
import { digest } from '../../tools/digest.js';
import { updateNode } from '../../db/nodes.js';
import { createLink, linkExists } from '../../db/links.js';

const log = createLogger('property-promote');

// --- Tag 节点缓存（进程内去重，每次同步周期前重置） ---

const tagNodeCache = new Map<string, string>();

/**
 * 清除 tag 节点缓存
 *
 * 每次同步周期开始前调用，防止缓存指向已被删除/superseded 的 tag 节点。
 */
export function clearTagNodeCache(): void {
  tagNodeCache.clear();
}

/**
 * 获取或创建 tag 节点
 */
export async function getOrCreateTagNode(
  db: Database.Database,
  tagName: string,
  source: string = 'brain',
  created?: string,
): Promise<string> {
  const normalized = tagName.trim().toLowerCase();
  if (tagNodeCache.has(normalized)) {
    return tagNodeCache.get(normalized)!;
  }

  // 查找已存在的 tag 节点（is_tag=1，精确匹配 content 或 title）
  const existing = db.prepare(
    "SELECT id FROM nodes WHERE is_tag = 1 AND (content = ? OR title = ?) AND archived = 0 AND is_superseded = 0 LIMIT 1",
  ).get(tagName, tagName) as { id: string } | undefined;

  if (existing) {
    tagNodeCache.set(normalized, existing.id);
    return existing.id;
  }

  // 创建普通节点（不直接标记 is_tag，由 promoteFrequentTags 按阈值判断）
  const repo = new SqliteRepository(db);
  const result = await digest(repo, {
    content: tagName,
    source: { tool: source },
    context: `属性值节点: ${tagName}`,
    tags: [tagName],
    async: false,
    created,
  });

  const nodeId = result.created_nodes?.[0]?.id;
  if (nodeId) {
    updateNode(db, nodeId, { is_tag: 1 });
    tagNodeCache.set(normalized, nodeId);
    return nodeId;
  }

  throw new Error(`创建 tag 节点失败: ${tagName}`);
}

/**
 * 判断属性值是否适合提升为 tag 节点
 */
export function shouldPromotePropertyValue(
  key: string,
  value: string,
  systemProperties: string[],
): boolean {
  if (!value || value.trim().length === 0) return false;

  // 系统属性的值不提升
  if (systemProperties.includes(key)) return false;

  const trimmed = value.trim();

  // 纯数字
  if (/^\d+(\.\d+)?$/.test(trimmed)) return false;

  // 布尔值
  if (/^(true|false)$/i.test(trimmed)) return false;

  // URL
  if (/^https?:\/\//.test(trimmed)) return false;

  // 日期格式
  if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(trimmed)) return false;

  // 超长字符串（大概率是描述文本）
  if (trimmed.length > 50) return false;

  // Templater / 模板值
  if (trimmed.includes('<%') || trimmed.includes('{{')) return false;

  // 已经是 [[wikilink]] 引用（走 pageRef 路径，不重复处理）
  if (/^\[\[.*\]\]$/.test(trimmed)) return false;

  return true;
}

/**
 * 将属性值提升为 tag 节点并建立链接
 */
export async function promotePropertyValues(
  db: Database.Database,
  properties: Record<string, string>,
  nodeIds: string[],
  source: string,
  systemProperties: string[],
  created?: string,
): Promise<void> {
  if (nodeIds.length === 0) return;

  const firstNodeId = nodeIds[0];

  for (const [key, value] of Object.entries(properties)) {
    if (!shouldPromotePropertyValue(key, value, systemProperties)) continue;

    try {
      const tagNodeId = await getOrCreateTagNode(db, value, source, created);
      if (tagNodeId === firstNodeId) continue;
      if (linkExists(db, firstNodeId, tagNodeId)) continue;

      createLink(db, {
        from_id: firstNodeId,
        to_id: tagNodeId,
        relation: [{ type: 'tagged', confidence: 0.6 }],
        strength: 0.7,
        note: `${source} frontmatter: ${key}`,
        auto: true,
        status: 'pending',
      });
    } catch (err) {
      log.debug(`属性值提升失败 ${key}=${value}: ${(err as Error).message}`);
    }
  }
}
