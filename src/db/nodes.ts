import type Database from 'better-sqlite3';
import type { BrainNode, NodeType } from '../types.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';
import { computeMaturityScore } from '../graph/maturity.js';
import { getParam } from '../strategy/loader.js';
import { dimensionsToLegacyType } from '../utils/dimensions.js';
import {
  archiveNodeWithVectors,
  reArchiveNodeWithVectors,
  unarchiveNodeRecordOnly,
} from './node-lifecycle.js';

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

  // updated 与 created 一致：新建即"上次修改"。后续任何 UPDATE 都会 bump
  // updated（见 updateNode 等），保证 cloud LWW + UI watcher 都能感知。
  // 不显式写会让新节点的 updated=NULL，直到下次启动 v17 backfill 才填上。
  db.prepare(`
    INSERT INTO nodes (id, type, content, title, heat, refinement, independence,
      maturity_score,
      specificity, subjectivity, actuality,
      is_crystal, is_tag, is_meta,
      source_tool, source_session, source_stream, source_timestamp,
      tags, created, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, type, params.content, params.title ?? null,
    heat, refinement, independence, maturityScore,
    specificity, subjectivity, actuality,
    params.is_crystal ?? 0, params.is_tag ?? 0, params.is_meta ?? 0,
    params.source_tool ?? null, params.source_session ?? null,
    params.source_stream ?? null, params.source_timestamp ?? null,
    tagsJson, created, created,
  );

  return getNode(db, id)!;
}

export function getNode(db: Database.Database, id: string): BrainNode | null {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as BrainNode | null;
}

export function getNodesByIds(db: Database.Database, ids: string[]): Map<string, BrainNode> {
  if (ids.length === 0) return new Map();
  // 长 ids 数组分批避免 SQLite SQLITE_MAX_VARIABLE_NUMBER 上限(默认 999):
  // links.ts 已用同模式做 498 批处理,这里对齐避免 1000+ ids 时崩。
  const BATCH = 498;
  const out = new Map<string, BrainNode>();
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM nodes WHERE id IN (${placeholders})`,
    ).all(...batch) as BrainNode[];
    for (const r of rows) out.set(r.id, r);
  }
  return out;
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

    // 推 updated 时间戳：cloud reconcile 用 LWW 比较 updated 决定上传/下载，
    // UI 端 data-watcher 也轮询 MAX(updated) 触发刷新。本地任何 nodes 修改
    // 都必须 bump，否则 server 看不到变化（reconcile manifest 'same'），
    // UI 也感知不到（watcher 漏触发）。详见 docs/work-logs/2026-05-10.md。
    fields.push('updated = ?');
    values.push(now());

    values.push(id);
    db.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return true;
  })();
}

/**
 * 归档节点：archived=1 + heat=0.02，并清理向量（nodes_vec / node_segments）。
 *
 * archived=1 使节点在默认 UI 查询和搜索里消失，但仍可从"已归档节点"入口
 * 看到、通过 unarchiveNode 恢复；heat=0.02 是额外的自然沉底兜底。
 *
 * 之前的实现只 set heat=0.02 不 set archived，名字和行为不符——很多查询
 * 过滤 archived=1 但不看 heat（或过滤 heat > 0.01 却保留 0.02）——导致
 * "archive 了但节点还出现在 UI 里"。见 docs/backlog.md 已记的语义不一致
 * 条目。
 *
 * 同时清理向量：向量搜索只看 nodes_vec 表，不 join archived 字段——
 * 不清会污染 recall / landing 结果（P0-10 migration v18 只清理了历史脏向量，
 * 此函数负责防止未来再产生脏向量）。deleteVector 对无 embedding 的节点也安全
 * （空 DELETE）。
 */
export function archiveNode(db: Database.Database, id: string): void {
  archiveNodeWithVectors(db, id);
}

/**
 * 恢复归档节点：将 archived 设回 0，heat 恢复到合理中间值。
 * 用于用户手动恢复因外部笔记源文件删除而归档的节点。
 *
 * 注意：archiveNode 已清理了节点的 embedding，此函数不会重新生成——
 * 节点恢复后不会从 recall/landing 召回，需要用户手动触发 reembed
 * （未来可自动 enqueue，见 docs/backlog.md）。
 */
export function unarchiveNode(db: Database.Database, id: string): boolean {
  return unarchiveNodeRecordOnly(db, id);
}

/**
 * 重新归档节点：将 archived 设回 1，heat 降到 0.01，并清理向量。
 * 用于用户手动将已恢复的节点重新归档。
 *
 * 同 archiveNode：清理向量防止污染 recall。
 */
export function reArchiveNode(db: Database.Database, id: string): boolean {
  return reArchiveNodeWithVectors(db, id);
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
    tags?: string[];
    fromAgents?: string[];
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
  } else if (filter.archived === true) {
    // 显式请求"只归档"——与 archived=false 对称。之前漏掉这支,
    // 导致传 true 时不加条件返回全部节点(见 P1-N)。
    conditions.push('archived = 1');
  }
  if (filter.createdAfter) {
    conditions.push('created >= ?');
    params.push(filter.createdAfter);
  }
  if (filter.createdBefore) {
    conditions.push('created <= ?');
    params.push(filter.createdBefore);
  }
  if (filter.tags && filter.tags.length > 0) {
    // 多值 AND：tags 以 JSON array string 存储，逐 tag 做 LIKE '%"tag"%'，全部命中才返回。
    // 转义 %/_ 防止 tag 内含通配符误扩，与 recall.ts index_ref 分支同一套写法。
    for (const tag of filter.tags) {
      const escaped = tag.replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push(`tags LIKE ? ESCAPE '\\'`);
      params.push(`%"${escaped}"%`);
    }
  }
  if (filter.fromAgents && filter.fromAgents.length > 0) {
    // 多值 OR：source_tool 命中其一（brain_recall from_agents 维度）。
    conditions.push(`source_tool IN (${filter.fromAgents.map(() => '?').join(', ')})`);
    params.push(...filter.fromAgents);
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
  if (archived === true) {
    // 与 archived=false 对称:显式请求"只归档"。之前漏掉这支,传 true
    // 等价于不传(返回全表计数),语义错(见 P1-N)。
    return (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE archived = 1').get() as { cnt: number }).cnt;
  }
  return (db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number }).cnt;
}

export function bumpHeat(db: Database.Database, id: string, delta: number = 0.1): void {
  // 更新 heat 的同时内联刷新 maturity_score，避免额外查询
  // maturity_score = wH * heat + wR * refinement + wC * connectivity + wI * independence
  // 修复(2026-05-19):heat 字段语义统一钳到 1.0。原版钳到 10 但 synaptic decay
  // 公式、recall sortScore、maturity_score 都按 [0,1] 假设写,所有下游被污染。
  // 文档明确语义是 [0,1],止血改回 1.0。
  const wH = getParam('recall-rank', 'heat_weight', 0.2);
  const wR = getParam('recall-rank', 'refinement_weight', 0.3);
  const wC = getParam('recall-rank', 'connectivity_weight', 0.3);
  const wI = getParam('recall-rank', 'independence_weight', 0.2);
  db.prepare(`
    UPDATE nodes SET
      heat = MIN(heat + ?, 1.0),
      maturity_score = ? * MIN(heat + ?, 1.0)
                     + ? * refinement
                     + ? * connectivity
                     + ? * independence,
      updated = ?
    WHERE id = ?
  `).run(delta, wH, delta, wR, wC, wI, now(), id);
}
