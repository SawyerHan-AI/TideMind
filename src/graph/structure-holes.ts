/**
 * 结构洞计算与缓存(perf-optimization-2026-05-17 P2-1)
 *
 * 结构洞 = "共享 2+ 邻居但无直接链接的节点对",在万节点 vault 下原本
 * IPC handler 同步跑 2-5s,严重阻塞主进程。
 *
 * 改造:
 * - daemon 后台 5 分钟跑一次,结果存 structure_holes_cache 单行表
 * - IPC handler 直接读缓存(毫秒级);冷启首次访问回源现算一次,之后都靠缓存
 * - 缓存超过 STALE_AFTER_MS 后仍可读(显示 "computed N min ago"),
 *   但下次 daemon tick 会重算
 */
import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';

const log = createLogger('structure-holes');

/** 预计算的目标上限(覆盖各 IPC 调用方的最大 limit) */
const PRECOMPUTE_LIMIT = 50;

/** 缓存读取的"陈旧"阈值:超过此时间触发后台重算(IPC 仍能读缓存) */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export interface StructureHole {
  nodeA: string;
  nodeB: string;
  sharedCount: number;
  nodeAPreview: string;
  nodeBPreview: string;
}

export interface StructureHolesCache {
  holes: StructureHole[];
  computedAt: string; // ISO 8601
}

/**
 * 现算结构洞(同步 SQL,慢)。
 *
 * 慢点:
 * 1. CTE 双向 neighbors + 自连接找共享邻居,O(E^2/V) 级别
 * 2. 对每个候选对查两次单节点拿 preview(N+1)
 */
export function computeStructureHoles(db: Database.Database, limit: number = PRECOMPUTE_LIMIT): StructureHole[] {
  const holes = db.prepare(`
    WITH active_links AS (
      -- 归档不删 links(archive 路径只置 archived=1/heat=0.02),必须 join nodes
      -- 过滤两端,否则已归档节点会作为候选对/共享邻居进入推荐结果
      -- M10: deleted=0 排除软删链接
      SELECT l.from_id, l.to_id
      FROM links l
      JOIN nodes nf ON nf.id = l.from_id AND nf.archived = 0 AND nf.is_superseded = 0
      JOIN nodes nt ON nt.id = l.to_id AND nt.archived = 0 AND nt.is_superseded = 0
      WHERE l.status != 'rejected_by_user' AND l.deleted = 0
    ),
    neighbors AS (
      SELECT from_id AS node, to_id AS neighbor FROM active_links
      UNION ALL
      SELECT to_id AS node, from_id AS neighbor FROM active_links
    ),
    shared AS (
      SELECT a.node AS node_a, b.node AS node_b, COUNT(*) AS shared
      FROM neighbors a
      JOIN neighbors b ON a.neighbor = b.neighbor AND a.node < b.node
      GROUP BY a.node, b.node
      HAVING shared >= 2
    )
    SELECT s.node_a, s.node_b, s.shared
    FROM shared s
    LEFT JOIN links d1 ON d1.from_id = s.node_a AND d1.to_id = s.node_b AND d1.status != 'rejected_by_user' AND d1.deleted = 0
    LEFT JOIN links d2 ON d2.from_id = s.node_b AND d2.to_id = s.node_a AND d2.status != 'rejected_by_user' AND d2.deleted = 0
    WHERE d1.id IS NULL AND d2.id IS NULL
    ORDER BY s.shared DESC
    LIMIT ?
  `).all(limit) as Array<{ node_a: string; node_b: string; shared: number }>;

  // 批量取所有候选对涉及的节点 preview,避免 N+1
  const idSet = new Set<string>();
  for (const h of holes) { idSet.add(h.node_a); idSet.add(h.node_b); }
  const ids = Array.from(idSet);

  const previewMap = new Map<string, string>();
  if (ids.length > 0) {
    // 注意 SQLITE_MAX_VARIABLE_NUMBER 默认 999,这里 limit 50 → 最多 100 个 id,安全
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, content FROM nodes WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string; content: string | null }>;
    for (const r of rows) previewMap.set(r.id, (r.content ?? '').slice(0, 80));
  }

  return holes.map(h => ({
    nodeA: h.node_a,
    nodeB: h.node_b,
    sharedCount: h.shared,
    nodeAPreview: previewMap.get(h.node_a) ?? '',
    nodeBPreview: previewMap.get(h.node_b) ?? '',
  }));
}

/**
 * 读 cache。返回 null 表示首次启动从未计算过。
 */
export function readStructureHolesCache(db: Database.Database): StructureHolesCache | null {
  const row = db.prepare('SELECT payload, computed_at FROM structure_holes_cache WHERE id = 1').get() as { payload: string; computed_at: string } | undefined;
  if (!row) return null;
  try {
    const holes = JSON.parse(row.payload) as StructureHole[];
    return { holes, computedAt: row.computed_at };
  } catch {
    return null;
  }
}

/**
 * 写 cache(UPSERT 单行 id=1)。
 */
export function writeStructureHolesCache(db: Database.Database, holes: StructureHole[]): void {
  db.prepare(`
    INSERT INTO structure_holes_cache (id, payload, computed_at)
    VALUES (1, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at
  `).run(JSON.stringify(holes));
}

/**
 * 可注入的"计算 runner"(2026-05-21 v0.2.74 CRITICAL #1)。
 *
 * computeStructureHoles 的 O(E²/V) CTE 自连接在万节点 vault 跑 50-200s。better-sqlite3
 * 是同步 API,在 Electron 主线程跑会把 UI 完全冻死(实测 107s)。Electron daemon 启动时
 * 注入一个把计算搬到 worker_threads 的 runner(见 client/electron/workers/),主线程只做
 * 轻量的单行 UPSERT 写缓存。CLI daemon 不注入(无 UI,内联同步可接受),保持零行为变化。
 */
export type StructureHolesRunner = (db: Database.Database) => Promise<StructureHole[]>;

let structureHolesRunner: StructureHolesRunner | null = null;

export function setStructureHolesRunner(fn: StructureHolesRunner | null): void {
  structureHolesRunner = fn;
}

/**
 * 后台任务入口:计算 + 写入缓存。失败不抛(daemon 会 swallow,日志记录)。
 *
 * 计算走注入的 runner(Electron=worker thread)或内联同步(CLI)。写缓存(单行 UPSERT)
 * 永远在调用线程做——很轻,不会阻塞。
 */
export async function runStructureHolesPrecompute(db: Database.Database): Promise<void> {
  const started = Date.now();
  try {
    const holes = structureHolesRunner
      ? await structureHolesRunner(db)
      : computeStructureHoles(db, PRECOMPUTE_LIMIT);
    writeStructureHolesCache(db, holes);
    log.info(`structure_holes precompute done: ${holes.length} pairs in ${Date.now() - started}ms`);
  } catch (err) {
    log.error('structure_holes precompute failed:', err instanceof Error ? err.stack : String(err));
  }
}
