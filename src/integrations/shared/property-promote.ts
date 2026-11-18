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
import { markNodeSupersededRecordOnly } from '../../db/node-lifecycle.js';
import { createLink, linkExists, getLinksForNode, deleteLink } from '../../db/links.js';

const log = createLogger('property-promote');

// --- Tag 节点缓存（进程内去重，每次同步周期前重置） ---

const tagNodeCache = new Map<string, string>();

// 进程内 in-flight 单飞：按 normalized tag 名去重并发创建。
// 文件队列(logseq/obsidian)默认 concurrency=3，同一批 3 个文件含相同属性值/文件夹名
// 时会并发进入 getOrCreateTagNode；其 cache 检查 → DB 检查 → `await digest()`
// (含 embedding 网络调用,事件循环切走)→ 写 cache 之间存在竞态窗口:第二个调用
// 在第一个的 digest 完成前 cache+DB 都查不到 → 各自创建一个同名重复 tag 节点,
// tagged 链接被分裂到两个节点上。用按 key 共享 Promise 串行化同名创建,消除竞态。
const tagNodeInflight = new Map<string, Promise<string>>();

// 仅显式选择 scope 的导入方参与补偿；其他源采用新 tag 后永久保留该共享身份。
interface ScopedTagRecord { scopes: Set<TagNodeScope>; adopted: boolean }
const scopedTags = new WeakMap<Database.Database, Map<string, ScopedTagRecord>>();

export interface TagNodeScope {
  isStopped(): boolean;
  track(id: string): void;
  finish(): void;
}

/** 一次文件导入的 tag 租约；只有无其他使用者、无活跃外部关系的新 tag 可被退役。 */
export function createTagNodeScope(db: Database.Database, shouldStop?: () => boolean): TagNodeScope {
  const touched = new Set<string>();
  let finished = false;
  const scope: TagNodeScope = {
    isStopped: () => shouldStop?.() ?? false,
    track(id) {
      const record = scopedTags.get(db)?.get(id);
      if (record) { record.scopes.add(scope); touched.add(id); }
    },
    finish() {
      if (finished) return;
      finished = true;
      const records = scopedTags.get(db);
      if (!records) return;
      for (const id of touched) {
        const record = records.get(id);
        if (!record) continue;
        record.scopes.delete(scope);
        if (record.adopted && record.scopes.size === 0) records.delete(id);
      }
      const candidates = new Set([...records].filter(([, r]) => !r.adopted && r.scopes.size === 0).map(([id]) => id));
      // 先找外部活跃节点采用的 tag，再沿候选 tag 间的公共关系传播保护。
      const protectedIds = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of candidates) {
          if (protectedIds.has(id)) continue;
          const adopted = getLinksForNode(db, id).some(link => {
            const other = link.from_id === id ? link.to_id : link.from_id;
            if (candidates.has(other)) return protectedIds.has(other);
            return !!db.prepare('SELECT id FROM nodes WHERE id = ? AND archived = 0 AND is_superseded = 0').get(other);
          });
          if (adopted) { protectedIds.add(id); changed = true; }
        }
      }
      db.transaction(() => {
        for (const id of candidates) {
          if (!protectedIds.has(id)) {
            for (const link of getLinksForNode(db, id)) deleteLink(db, link.id);
            markNodeSupersededRecordOnly(db, id);
            for (const [key, cachedId] of tagNodeCache) if (cachedId === id) tagNodeCache.delete(key);
          }
          records.delete(id);
        }
      })();
    },
  };
  return scope;
}

function adoptScopedTag(db: Database.Database, id: string, scope?: TagNodeScope): string {
  const record = scopedTags.get(db)?.get(id);
  if (record) {
    if (scope) scope.track(id);
    else record.adopted = true;
  }
  return id;
}

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
  scope?: TagNodeScope,
): Promise<string> {
  // 入口规范化：外部调用方（apple-notes/obsidian/notion/logseq 的 folderName /
  // parent title / frontmatter value）可能传入多行或超长值。必须 trim、合并换行、
  // 截断到 100 字符，保证 cache key 与 DB 查询一致。
  const normalized = tagName
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 100);
  // cache key 与 DB 查询保持一致的大小写语义：DB 侧 content/title 为大小写敏感精确匹配，
  // 因此 cache key 也必须用原始 case（仅 trim）。
  // 之前用 toLowerCase 归一会导致 "Foo" 和 "foo" 共享同一缓存条目 —— 与 DB 语义不符。
  const cacheKey = normalized;
  if (tagNodeCache.has(cacheKey)) {
    return adoptScopedTag(db, tagNodeCache.get(cacheKey)!, scope);
  }

  // 同名创建已在飞行中 → 复用同一 Promise,不再各自查 DB / 各自 digest。
  const pending = tagNodeInflight.get(cacheKey);
  if (pending) return adoptScopedTag(db, await pending, scope);

  const task = createTagNode(db, normalized, cacheKey, source, created, scope)
    .finally(() => { tagNodeInflight.delete(cacheKey); });
  tagNodeInflight.set(cacheKey, task);
  return adoptScopedTag(db, await task, scope);
}

async function createTagNode(
  db: Database.Database,
  normalized: string,
  cacheKey: string,
  source: string,
  created?: string,
  scope?: TagNodeScope,
): Promise<string> {
  // 查找已存在的 tag 节点（is_tag=1，精确匹配 content 或 title）
  const existing = db.prepare(
    "SELECT id FROM nodes WHERE is_tag = 1 AND (content = ? OR title = ?) AND archived = 0 AND is_superseded = 0 LIMIT 1",
  ).get(normalized, normalized) as { id: string } | undefined;

  if (existing) {
    tagNodeCache.set(cacheKey, existing.id);
    return adoptScopedTag(db, existing.id, scope);
  }

  // 创建普通节点（不直接标记 is_tag，由 promoteFrequentTags 按阈值判断）
  const repo = new SqliteRepository(db);
  const result = await digest(repo, {
    content: normalized,
    source: { tool: source },
    context: `属性值节点: ${normalized}`,
    tags: [normalized],
    async: false,
    created,
    // 身份由 tag 名称精确匹配 + 缓存 + in-flight 单飞负责（上方已查过 existing）
    skipDedupMerge: true,
  });

  const nodeId = result.created_nodes?.[0]?.id;
  if (nodeId) {
    if (scope) {
      if (!scopedTags.has(db)) scopedTags.set(db, new Map());
      scopedTags.get(db)!.set(nodeId, { scopes: new Set(), adopted: false });
      scope.track(nodeId);
    }
    updateNode(db, nodeId, { is_tag: 1 });
    tagNodeCache.set(cacheKey, nodeId);
    return nodeId;
  }

  throw new Error(`创建 tag 节点失败: ${normalized}`);
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
  scope?: TagNodeScope,
): Promise<void> {
  if (nodeIds.length === 0) return;

  const firstNodeId = nodeIds[0];

  for (const [key, value] of Object.entries(properties)) {
    if (scope?.isStopped()) return;
    if (!shouldPromotePropertyValue(key, value, systemProperties)) continue;

    try {
      const tagNodeId = await getOrCreateTagNode(db, value, source, created, scope);
      if (scope?.isStopped()) return;
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
