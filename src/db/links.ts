import type Database from 'better-sqlite3';
import type { BrainLink, LinkRelation, LinkStatus, RelationType } from '../types.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('links');

/**
 * 解析 relation JSON 字段为 LinkRelation[]
 *
 * 修复(2026-05-09):catch 块原本兼容"旧格式纯字符串",但条件 `typeof raw === 'string'`
 * 永远成立(函数签名 `raw: string`),且能进 catch 说明 raw 不是合法 JSON,大概率
 * 也不是合法 RelationType。把任意垃圾字符串当 type 写入下游会让消费方的 switch
 * 静默走默认分支。迁移已完成 N 个版本,这条兼容分支应去掉,catch 一律 return []。
 */
export function parseRelations(raw: string): LinkRelation[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((p: unknown) =>
        p !== null && typeof p === 'object' &&
        typeof (p as Record<string, unknown>).type === 'string' &&
        typeof (p as Record<string, unknown>).confidence === 'number'
      ) as LinkRelation[];
    }
    // 兼容旧格式（单 string）—— 理论上迁移后不会出现
    if (typeof parsed === 'string') return [{ type: parsed as RelationType, confidence: 0.7 }];
    return [];
  } catch {
    // 损坏行 / 非 JSON。不做任何字符串兜底(原兼容分支会把垃圾值当 type),
    // 让上游清楚看到该行无可识别的 relation。
    return [];
  }
}

/** DB 原始行类型（relation 为 JSON string） */
interface RawLinkRow {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  strength: number;
  note: string | null;
  auto: number;
  status: LinkStatus;
  created: string;
}

/**
 * 将 DB 原始行转换为 BrainLink（解析 relation JSON）
 */
function hydrateLink(row: RawLinkRow): BrainLink {
  return {
    id: row.id,
    from_id: row.from_id,
    to_id: row.to_id,
    relation: parseRelations(row.relation),
    strength: row.strength,
    note: row.note,
    auto: row.auto,
    status: row.status,
    created: row.created,
  };
}

export function createLink(
  db: Database.Database,
  params: {
    from_id: string;
    to_id: string;
    relation: LinkRelation[];
    strength?: number;
    note?: string;
    auto?: boolean;
    status?: LinkStatus;
  },
): BrainLink | null {
  // 防止自环链接
  if (params.from_id === params.to_id) {
    return null;
  }

  const id = generateId();
  const created = now();

  // INSERT 显式写 updated = created。否则新链接 updated=NULL，reconcile-policy 的
  // parseSyncDate(null) 回落到 epoch 1970 → 永远输给云端任何时间戳 →
  // 跨设备同步丢失新建链接，直到下次启动 v17 backfill 兜底。
  db.prepare(`
    INSERT INTO links (id, from_id, to_id, relation, strength, note, auto, status, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.from_id, params.to_id,
    JSON.stringify(params.relation),
    params.strength ?? 0.5,
    params.note ?? null, params.auto !== false ? 1 : 0,
    params.status ?? 'confirmed', created, created,
  );

  const row = db.prepare('SELECT * FROM links WHERE id = ?').get(id) as RawLinkRow | undefined;
  if (row) {
    log.debug(`链接创建 ${id} ${params.from_id.slice(0, 8)}→${params.to_id.slice(0, 8)}`);
  }
  return row ? hydrateLink(row) : null;
}

/**
 * 默认排除 status='rejected_by_user' 的链接（用户纠错的反馈痕迹，对大多数读取路径应不可见）。
 * 调用方若确实需要看到 rejected（如 tag-promote 的守卫、undo 恢复、管理后台导出），显式传 includeRejected: true。
 */
export function getLinksFrom(
  db: Database.Database,
  nodeId: string,
  options?: { includeRejected?: boolean },
): BrainLink[] {
  const extra = (options?.includeRejected ? '' : " AND status != 'rejected_by_user'") + ' AND deleted = 0';
  return (db.prepare(`SELECT * FROM links WHERE from_id = ?${extra}`).all(nodeId) as RawLinkRow[]).map(hydrateLink);
}

export function getLinksTo(
  db: Database.Database,
  nodeId: string,
  options?: { includeRejected?: boolean },
): BrainLink[] {
  const extra = (options?.includeRejected ? '' : " AND status != 'rejected_by_user'") + ' AND deleted = 0';
  return (db.prepare(`SELECT * FROM links WHERE to_id = ?${extra}`).all(nodeId) as RawLinkRow[]).map(hydrateLink);
}

export function getLinksForNode(
  db: Database.Database,
  nodeId: string,
  options?: { includeRejected?: boolean },
): BrainLink[] {
  const extra = (options?.includeRejected ? '' : " AND status != 'rejected_by_user'") + ' AND deleted = 0';
  return (db.prepare(
    `SELECT * FROM links WHERE (from_id = ? OR to_id = ?)${extra}`,
  ).all(nodeId, nodeId) as RawLinkRow[]).map(hydrateLink);
}

export function getLinksForNodes(
  db: Database.Database,
  nodeIds: string[],
  options?: { minStrength?: number; statusFilter?: string },
): BrainLink[] {
  if (nodeIds.length === 0) return [];
  const minStrength = options?.minStrength ?? 0;
  const status = options?.statusFilter ?? 'confirmed';
  // SQLite 变量上限 999；每条 SQL 展开两份 nodeIds + 2 个固定参数（minStrength + status），
  // 498 是精确上限：2×498 + 2 = 998 ≤ 999。
  const BATCH = 498;
  if (nodeIds.length > BATCH) {
    const results: BrainLink[] = [];
    for (let i = 0; i < nodeIds.length; i += BATCH) {
      results.push(...getLinksForNodes(db, nodeIds.slice(i, i + BATCH), options));
    }
    // 去重（节点可能跨批次共享链接）
    const seen = new Set<string>();
    return results.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
  }
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM links
    WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
      AND strength >= ? AND status = ? AND deleted = 0
  `).all(...nodeIds, ...nodeIds, minStrength, status) as RawLinkRow[];
  return rows.map(hydrateLink);
}

// UPDATE links 必须显式 bump updated，否则 cloud reconcile manifest 看不到本地
// link 变化（manifest LWW 比 updated）；客户端 SQLite 无触发器自动维护 updated。
export function updateLinkStatus(db: Database.Database, id: string, status: LinkStatus): void {
  db.prepare('UPDATE links SET status = ?, updated = ? WHERE id = ?').run(status, now(), id);
}

export function updateLinkStrength(db: Database.Database, id: string, strength: number): void {
  db.prepare('UPDATE links SET strength = ?, updated = ? WHERE id = ?').run(strength, now(), id);
}

export function updateLinkRelation(db: Database.Database, id: string, relation: LinkRelation[]): void {
  db.prepare('UPDATE links SET relation = ?, updated = ? WHERE id = ?').run(JSON.stringify(relation), now(), id);
}

export function deleteLink(db: Database.Database, id: string): void {
  // M10:软删(不 hard-delete)。deleted=1 + bump updated/edit_seq,靠 reconcile/uplink 的 LWW
  // 跨设备传播删除,杜绝 manifest diff 把已删 link 当 onlyLocal/onlyServer 复活。查询排除 deleted=1。
  db.prepare('UPDATE links SET deleted = 1, updated = ?, edit_seq = edit_seq + 1 WHERE id = ?').run(now(), id);
  log.debug(`链接软删 ${id}`);
}

export function getPendingLinks(db: Database.Database, limit: number = 50): BrainLink[] {
  return (db.prepare(
    "SELECT * FROM links WHERE status = 'pending' AND deleted = 0 ORDER BY created ASC LIMIT ?",
  ).all(limit) as RawLinkRow[]).map(hydrateLink);
}

export function getLinkCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status = 'confirmed' AND deleted = 0").get() as { cnt: number }).cnt;
}

/**
 * 检查两节点间是否存在链接。
 *
 * direction='either'（默认，向后兼容）：任一方向存在即返回 true。
 *   用于 reconsolidate / link-discover / landing 等"是否相邻"的判断。
 *
 * direction='from_to'：仅检查 from→to 这一方向。
 *   用于 tagged 链接等方向敏感的去重（annotate / tag-promote 的标签反向链接
 *   不应阻止正向 `node→tag` 的创建）。
 */
export function linkExists(
  db: Database.Database,
  fromId: string,
  toId: string,
  direction: 'either' | 'from_to' = 'either',
): boolean {
  if (direction === 'from_to') {
    const row = db.prepare(
      'SELECT 1 FROM links WHERE from_id = ? AND to_id = ? AND deleted = 0 LIMIT 1',
    ).get(fromId, toId);
    return !!row;
  }
  const row = db.prepare(
    'SELECT 1 FROM links WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND deleted = 0 LIMIT 1',
  ).get(fromId, toId, toId, fromId);
  return !!row;
}

/**
 * 查询某节点所有被用户拒绝的 tagged 链接对端（= 被拒标签的 node id）
 * 用于 annotate 阶段过滤掉这些标签，防止 LLM 重复打上。
 */
export function getRejectedTagIdsForNode(db: Database.Database, nodeId: string): string[] {
  const rows = db.prepare(`
    SELECT to_id FROM links
    WHERE from_id = ?
      AND status = 'rejected_by_user'
      AND relation LIKE '%"tagged"%'
      AND deleted = 0
  `).all(nodeId) as Array<{ to_id: string }>;
  return rows.map(r => r.to_id);
}

/**
 * 查询某节点所有被用户拒绝的 tag 节点的显示名（title 优先、fallback content）。
 * LLM 返回的是标签名字符串，用这个列表过滤 ann.tags 防止被拒标签被重新打上。
 */
export function getRejectedTagNamesForNode(db: Database.Database, nodeId: string): string[] {
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(tag.title, ''), tag.content) as tag_name
    FROM links l
    JOIN nodes tag ON tag.id = l.to_id
    WHERE l.from_id = ?
      AND l.status = 'rejected_by_user'
      AND l.relation LIKE '%"tagged"%'
      AND l.deleted = 0
  `).all(nodeId) as Array<{ tag_name: string | null }>;
  return rows.map(r => (r.tag_name ?? '').trim()).filter(n => n.length > 0);
}

/**
 * 跨标签查最近 N 条被用户拒绝的 tagged 链接样本，作为 annotate prompt 的全局反例。
 * 返回结构包含标签名和被拒节点的 content preview，用于构造"错误打标案例"提示块。
 */
export function getRecentRejectedNodesAcrossTags(
  db: Database.Database,
  limit: number = 5,
): Array<{ tag_id: string; tag_name: string; node_id: string; node_content: string; node_title: string | null }> {
  return db.prepare(`
    SELECT
      l.to_id as tag_id,
      COALESCE(NULLIF(tag.title, ''), tag.content) as tag_name,
      l.from_id as node_id,
      n.content as node_content,
      n.title as node_title
    FROM links l
    JOIN nodes tag ON tag.id = l.to_id
    JOIN nodes n ON n.id = l.from_id
    WHERE l.status = 'rejected_by_user'
      AND l.relation LIKE '%"tagged"%'
      AND l.deleted = 0
    ORDER BY COALESCE(l.updated, l.created) DESC
    LIMIT ?
  `).all(limit) as Array<{ tag_id: string; tag_name: string; node_id: string; node_content: string; node_title: string | null }>;
}
