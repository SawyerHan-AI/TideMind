import type Database from 'better-sqlite3';
import type { BrainLink, LinkRelation, LinkStatus, RelationType } from '../types.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('links');

/**
 * 解析 relation JSON 字段为 LinkRelation[]
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
    // 旧格式纯字符串（未迁移的情况）
    if (typeof raw === 'string' && raw.length > 0 && !raw.startsWith('[')) {
      return [{ type: raw as RelationType, confidence: 0.7 }];
    }
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

  db.prepare(`
    INSERT INTO links (id, from_id, to_id, relation, strength, note, auto, status, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.from_id, params.to_id,
    JSON.stringify(params.relation),
    params.strength ?? 0.5,
    params.note ?? null, params.auto !== false ? 1 : 0,
    params.status ?? 'confirmed', created,
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
  const extra = options?.includeRejected ? '' : " AND status != 'rejected_by_user'";
  return (db.prepare(`SELECT * FROM links WHERE from_id = ?${extra}`).all(nodeId) as RawLinkRow[]).map(hydrateLink);
}

export function getLinksTo(
  db: Database.Database,
  nodeId: string,
  options?: { includeRejected?: boolean },
): BrainLink[] {
  const extra = options?.includeRejected ? '' : " AND status != 'rejected_by_user'";
  return (db.prepare(`SELECT * FROM links WHERE to_id = ?${extra}`).all(nodeId) as RawLinkRow[]).map(hydrateLink);
}

export function getLinksForNode(
  db: Database.Database,
  nodeId: string,
  options?: { includeRejected?: boolean },
): BrainLink[] {
  const extra = options?.includeRejected ? '' : " AND status != 'rejected_by_user'";
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
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM links
    WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
      AND strength >= ? AND status = ?
  `).all(...nodeIds, ...nodeIds, minStrength, status) as RawLinkRow[];
  return rows.map(hydrateLink);
}

export function updateLinkStatus(db: Database.Database, id: string, status: LinkStatus): void {
  db.prepare('UPDATE links SET status = ? WHERE id = ?').run(status, id);
}

export function updateLinkStrength(db: Database.Database, id: string, strength: number): void {
  db.prepare('UPDATE links SET strength = ? WHERE id = ?').run(strength, id);
}

export function updateLinkRelation(db: Database.Database, id: string, relation: LinkRelation[]): void {
  db.prepare('UPDATE links SET relation = ? WHERE id = ?').run(JSON.stringify(relation), id);
}

export function deleteLink(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM links WHERE id = ?').run(id);
  log.debug(`链接删除 ${id}`);
}

export function getPendingLinks(db: Database.Database, limit: number = 50): BrainLink[] {
  return (db.prepare(
    "SELECT * FROM links WHERE status = 'pending' ORDER BY created ASC LIMIT ?",
  ).all(limit) as RawLinkRow[]).map(hydrateLink);
}

export function getLinkCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status = 'confirmed'").get() as { cnt: number }).cnt;
}

export function linkExists(db: Database.Database, fromId: string, toId: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) LIMIT 1',
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
    ORDER BY COALESCE(l.updated, l.created) DESC
    LIMIT ?
  `).all(limit) as Array<{ tag_id: string; tag_name: string; node_id: string; node_content: string; node_title: string | null }>;
}
