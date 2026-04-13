import type Database from 'better-sqlite3';
import type { BrainNode, NodeType } from '../types.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';
import { computeMaturityScore } from '../graph/maturity.js';
import { getParam } from '../strategy/loader.js';
import { dimensionsToLegacyType } from '../utils/dimensions.js';

/**
 * 安全解析节点的 tags JSON 字段。
 * 数据库中 tags 以 JSON array string 存储，此函数统一处理解析和错误。
 */
export function parseTags(tagsRaw: string | null): string[] {
  if (!tagsRaw) return [];
  try {
    const parsed = JSON.parse(tagsRaw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createNode(
  db: Database.Database,
  params: {
    type?: NodeType;
    content: string;
    title?: string;
    source_tool?: string;
    source_session?: string;
    source_stream?: string;
    source_timestamp?: string;
    tags?: string[];
    heat?: number;
    refinement?: number;
    independence?: number;
    // 三维内容性质
    specificity?: number;
    subjectivity?: number;
    actuality?: number;
    // 结构角色
    is_crystal?: number;
    is_tag?: number;
    is_meta?: number;
    /** 自定义创建时间（ISO 8601）。导入历史笔记时保留原始时间。不传则使用 now() */
    created?: string;
  },
): BrainNode {
  const id = generateId();
  const created = params.created ?? now();
  const tagsJson = params.tags ? JSON.stringify(params.tags) : null;

  const heat = params.heat ?? 1.0;
  const refinement = params.refinement ?? 0.0;
  const independence = params.independence ?? 0.0;
  const connectivity = 0.0;
  const maturityScore = computeMaturityScore(heat, refinement, connectivity, independence);

  const specificity = params.specificity ?? 0.5;
  const subjectivity = params.subjectivity ?? 0.5;
  const actuality = params.actuality ?? 0.5;

  // 双写：如果没传 type，从维度派生
  const type = params.type ?? dimensionsToLegacyType({ specificity, subjectivity, actuality });

  db.prepare(`
    INSERT INTO nodes (id, type, content, title, heat, refinement, independence,
      maturity_score,
      specificity, subjectivity, actuality,
      is_crystal, is_tag, is_meta,
      source_tool, source_session, source_stream, source_timestamp,
      tags, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, type, params.content, params.title ?? null,
    heat, refinement, independence, maturityScore,
    specificity, subjectivity, actuality,
    params.is_crystal ?? 0, params.is_tag ?? 0, params.is_meta ?? 0,
    params.source_tool ?? null, params.source_session ?? null,
    params.source_stream ?? null, params.source_timestamp ?? null,
    tagsJson, created,
  );

  return getNode(db, id)!;
}

export function getNode(db: Database.Database, id: string): BrainNode | null {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as BrainNode | null;
}

export function getNodesByIds(db: Database.Database, ids: string[]): Map<string, BrainNode> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM nodes WHERE id IN (${placeholders})`,
  ).all(...ids) as BrainNode[];
  return new Map(rows.map(r => [r.id, r]));
}

export function updateNode(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<BrainNode, 'content' | 'title' | 'type' | 'heat' | 'refinement' | 'connectivity' | 'independence' | 'specificity' | 'subjectivity' | 'actuality' | 'tags' | 'archived' | 'is_keystone' | 'is_crystal' | 'is_tag' | 'is_meta' | 'maturity_score' | 'last_reconsolidated'>>,
  changeReason?: string,
): boolean {
  return db.transaction(() => {
    const node = getNode(db, id);
    if (!node) return false;

    const ALLOWED_COLUMNS = new Set([
      'content', 'title', 'type', 'heat', 'refinement', 'connectivity', 'independence',
      'specificity', 'subjectivity', 'actuality',
      'tags', 'archived', 'is_keystone', 'is_crystal', 'is_tag', 'is_meta',
      'maturity_score', 'last_reconsolidated',
    ]);
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, val] of Object.entries(patch)) {
      if (val !== undefined && ALLOWED_COLUMNS.has(key)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }

    if (fields.length === 0) return true;

    // 如果内容变更，保存版本历史并递增 version
    if (patch.content && patch.content !== node.content) {
      db.prepare(`
        INSERT INTO node_versions (node_id, version, content, change_reason, changed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, node.version, node.content, changeReason ?? null, now());

      fields.push('version = version + 1');
    }

    values.push(id);
    db.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return true;
  })();
}

/**
 * 冷却节点：将 heat 降至极低值，替代旧的二元归档。
 * 节点不会从查询中彻底消失，但 heat 极低意味着自然沉底。
 */
export function archiveNode(db: Database.Database, id: string): void {
  updateNode(db, id, { heat: 0.02 }, 'cooldown');
}

/**
 * 恢复归档节点：将 archived 设回 0，heat 恢复到合理中间值。
 * 用于用户手动恢复因外部笔记源文件删除而归档的节点。
 */
export function unarchiveNode(db: Database.Database, id: string): boolean {
  const result = db.prepare(
    'UPDATE nodes SET archived = 0, heat = 0.5 WHERE id = ? AND archived = 1',
  ).run(id);
  return result.changes > 0;
}

/**
 * 重新归档节点：将 archived 设回 1，heat 降到 0.01。
 * 用于用户手动将已恢复的节点重新归档。
 */
export function reArchiveNode(db: Database.Database, id: string): boolean {
  const result = db.prepare(
    'UPDATE nodes SET archived = 1, heat = 0.01 WHERE id = ? AND archived = 0',
  ).run(id);
  return result.changes > 0;
}

/**
 * 列出所有因外部笔记源文件删除而归档的节点。
 */
export function listArchivedNodes(
  db: Database.Database,
  opts: { limit?: number; offset?: number } = {},
): { nodes: BrainNode[]; total: number } {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE archived = 1').get() as { cnt: number }).cnt;
  const nodes = db.prepare(
    'SELECT * FROM nodes WHERE archived = 1 ORDER BY created DESC LIMIT ? OFFSET ?',
  ).all(limit, offset) as BrainNode[];
  return { nodes, total };
}

export function listNodes(
  db: Database.Database,
  filter: {
    type?: NodeType;
    archived?: boolean;
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
  } = {},
): BrainNode[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    conditions.push('type = ?');
    params.push(filter.type);
  }
  if (filter.archived === false) {
    conditions.push('archived = 0');
    conditions.push('is_superseded = 0');
  }
  if (filter.createdAfter) {
    conditions.push('created >= ?');
    params.push(filter.createdAfter);
  }
  if (filter.createdBefore) {
    conditions.push('created <= ?');
    params.push(filter.createdBefore);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // 白名单防止 SQL 注入
  const ALLOWED_ORDER = new Set([
    'created DESC', 'created ASC', 'heat DESC', 'heat ASC',
    'maturity_score DESC', 'maturity_score ASC',
    'connectivity DESC', 'refinement DESC', 'independence DESC',
  ]);
  const order = ALLOWED_ORDER.has(filter.orderBy ?? '') ? filter.orderBy! : 'created DESC';
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  return db.prepare(
    `SELECT * FROM nodes ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as BrainNode[];
}

export function getNodeCount(db: Database.Database, archived?: boolean): number {
  if (archived === false) {
    return (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE archived = 0 AND is_superseded = 0').get() as { cnt: number }).cnt;
  }
  return (db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number }).cnt;
}

export function bumpHeat(db: Database.Database, id: string, delta: number = 0.1): void {
  // 更新 heat 的同时内联刷新 maturity_score，避免额外查询
  // maturity_score = wH * min(heat,1) + wR * refinement + wC * connectivity + wI * independence
  const wH = getParam('recall-rank', 'heat_weight', 0.2);
  const wR = getParam('recall-rank', 'refinement_weight', 0.3);
  const wC = getParam('recall-rank', 'connectivity_weight', 0.3);
  const wI = getParam('recall-rank', 'independence_weight', 0.2);
  db.prepare(`
    UPDATE nodes SET
      heat = MIN(heat + ?, 10.0),
      maturity_score = ? * MIN(MIN(heat + ?, 10.0), 1.0)
                     + ? * refinement
                     + ? * connectivity
                     + ? * independence
    WHERE id = ?
  `).run(delta, wH, delta, wR, wC, wI, id);
}
