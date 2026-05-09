import type Database from 'better-sqlite3';
import { getEmbedding } from '../llm/embedding.js';
import { clearReembedFlag } from './connection.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('vectors');

export interface VectorSearchResult {
  id: string;       // node_id (已去重)
  distance: number;  // 最佳 segment 的距离
}

const SEGMENT_THRESHOLD = 500;    // 超过此长度才分段
const SEGMENT_TARGET = 400;       // 每段目标长度
const SEGMENT_OVERLAP = 50;       // 段间重叠字符数

// ---- 分段策略 ----

/**
 * 将内容拆分为 embedding 分段
 *
 * 短内容（< 500 字符）不分段。
 * 长内容按段落/句子边界拆分，每段约 300-500 字符，
 * 相邻段有 50 字符重叠保持语义连续。
 */
export function segmentForEmbedding(content: string): string[] {
  if (content.length < SEGMENT_THRESHOLD) return [content];

  const segments: string[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + SEGMENT_TARGET + 100, content.length);

    if (end < content.length) {
      // 在 target 附近找段落或句子边界
      let breakAt = content.lastIndexOf('\n\n', end);
      if (breakAt <= start) breakAt = content.lastIndexOf('\n', end);
      if (breakAt <= start) breakAt = content.lastIndexOf('。', end);
      if (breakAt <= start) breakAt = content.lastIndexOf('. ', end);
      if (breakAt <= start) breakAt = end; // 找不到边界就硬切
      else breakAt += 1; // 包含边界字符

      segments.push(content.slice(start, breakAt).trim());
      // 历史 bug(2026-05-09):兜底用 `start + 1` 在极端情形下让 start 每轮只
      // 前进 1 字符 —— 用户笔记里贴大段无标点串(base64、minified 代码、
      // 长 token 列表)且某次 breakAt - SEGMENT_OVERLAP <= start + 1 时,
      // 会产生数千个 1 字符递增的 segment,getEmbedding 调用爆量、nodes_vec 写爆。
      // 改为保证最小前进 SEGMENT_TARGET,与正常切分步长一致,牺牲一些 overlap
      // 但避免 quadratic 爆炸。
      start = Math.max(breakAt - SEGMENT_OVERLAP, start + SEGMENT_TARGET);
    } else {
      segments.push(content.slice(start).trim());
      break;
    }
  }

  return segments.filter(s => s.length > 0);
}

// ---- 存储 ----

/**
 * 为节点插入多段 embedding
 *
 * 先删除旧的 segments，再按新内容分段插入。
 * 短内容只产生 1 个 segment。
 */
export async function insertSegmentVectors(
  db: Database.Database,
  nodeId: string,
  content: string,
): Promise<number> {
  const segments = segmentForEmbedding(content);

  // 先异步收集所有 embedding（不能在 better-sqlite3 同步事务内 await）
  const embeddings: Array<{ index: number; embedding: Float32Array }> = [];
  for (let i = 0; i < segments.length; i++) {
    const embedding = await getEmbedding(segments[i]);
    if (!embedding) {
      log.warn(`Embedding failed for segment ${i} of node ${nodeId}`);
      continue;
    }
    embeddings.push({ index: i, embedding });
  }

  // 全部 embedding 都失败时,不能走 transaction 的 deleteVector——否则把旧的
  // 有效向量也抹掉,搜索直接丢失该节点。此时保留旧 vector,让下次重试有机会
  // 覆盖。调用方看到 0 即 "embedding 不可用,未改动"。
  if (embeddings.length === 0) {
    log.warn(`node=${nodeId} 所有 segment embedding 均失败,保留旧 vector`);
    return 0;
  }

  // 原子写入：删除旧数据 + 插入所有新 segments
  const inserted = db.transaction(() => {
    deleteVector(db, nodeId);
    for (const { index, embedding } of embeddings) {
      const segmentId = `${nodeId}#${index}`;
      db.prepare(
        'INSERT OR REPLACE INTO nodes_vec (id, embedding) VALUES (?, ?)',
      ).run(segmentId, Buffer.from(embedding.buffer));
      db.prepare(
        'INSERT OR REPLACE INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)',
      ).run(segmentId, nodeId, index);
    }
    return embeddings.length;
  })();

  log.debug(`node=${nodeId} 插入 ${inserted} segments`);
  return inserted;
}

/**
 * 插入单个预计算的 embedding（兼容旧接口）
 */
export function insertVector(db: Database.Database, nodeId: string, embedding: Float32Array): void {
  const segmentId = `${nodeId}#0`;

  db.prepare(
    'INSERT OR REPLACE INTO nodes_vec (id, embedding) VALUES (?, ?)',
  ).run(segmentId, Buffer.from(embedding.buffer));

  db.prepare(
    'INSERT OR REPLACE INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)',
  ).run(segmentId, nodeId, 0);
}

/**
 * 删除节点的所有 embedding segments
 */
export function deleteVector(db: Database.Database, nodeId: string): void {
  // 找到所有 segment_id
  const segments = db.prepare(
    'SELECT segment_id FROM node_segments WHERE node_id = ?',
  ).all(nodeId) as Array<{ segment_id: string }>;

  for (const seg of segments) {
    db.prepare('DELETE FROM nodes_vec WHERE id = ?').run(seg.segment_id);
  }
  db.prepare('DELETE FROM node_segments WHERE node_id = ?').run(nodeId);
}

/**
 * 获取节点第一个 segment 的 embedding（用于 rerank 等场景）
 */
export function getVectorForNode(db: Database.Database, nodeId: string): Float32Array | null {
  const segmentId = `${nodeId}#0`;
  try {
    const row = db.prepare('SELECT embedding FROM nodes_vec WHERE id = ?').get(segmentId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  } catch {
    return null;
  }
}

// ---- 搜索 ----

/**
 * KNN 向量搜索（自动按 node_id 去重）
 *
 * 搜索 segment 级别的 embedding，返回结果按 node_id 去重，
 * 保留每个 node 的最佳（最近距离）segment。
 */
export function searchVectors(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit: number = 20,
): VectorSearchResult[] {
  try {
    // 搜更多 segments 以确保去重后有足够节点
    const rawResults = db.prepare(`
      SELECT id, distance
      FROM nodes_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength), limit * 3) as Array<{ id: string; distance: number }>;

    // 按 node_id 去重，保留最佳 distance
    const bestByNode = new Map<string, number>();

    for (const r of rawResults) {
      const nodeId = resolveSegmentToNode(db, r.id);
      if (!nodeId) continue;
      if (!isNodeVisibleToVectorSearch(db, nodeId)) continue;

      const existing = bestByNode.get(nodeId);
      if (existing === undefined || r.distance < existing) {
        bestByNode.set(nodeId, r.distance);
      }
    }

    // 转换为结果数组，按 distance 排序
    return [...bestByNode.entries()]
      .map(([id, distance]) => ({ id, distance }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  } catch (err) {
    log.error('向量搜索失败:', (err as Error).message);
    return [];
  }
}

/**
 * 检查是否存在向量数据
 */
export function hasVectors(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM nodes_vec').get() as { cnt: number };
    return row.cnt > 0;
  } catch {
    return false;
  }
}

// ---- 辅助 ----

/**
 * 从 segment_id 解析出 node_id
 */
function resolveSegmentToNode(db: Database.Database, segmentId: string): string | null {
  const row = db.prepare(
    'SELECT node_id FROM node_segments WHERE segment_id = ?',
  ).get(segmentId) as { node_id: string } | undefined;
  return row?.node_id ?? null;
}

export function isNodeVisibleToVectorSearch(db: Database.Database, nodeId: string): boolean {
  const row = db.prepare(
    'SELECT heat, archived, is_superseded FROM nodes WHERE id = ?',
  ).get(nodeId) as { heat: number; archived: number; is_superseded: number } | undefined;
  if (!row) return false;
  return row.heat > 0.01 && row.archived === 0 && row.is_superseded === 0;
}

// ---- 后台重算 ----

let reembedProgress = { running: false, done: 0, total: 0 };
let reembedLock = false;

export function getReembedProgress(): { running: boolean; done: number; total: number } {
  return { ...reembedProgress };
}

/**
 * 后台重算所有节点的 embedding（支持多段）
 * 使用同步锁防止并发调用互相覆盖进度。
 */
export async function reembedAllNodes(db: Database.Database): Promise<void> {
  if (reembedLock) return;
  reembedLock = true;

  try {
    const totalRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01 AND archived = 0 AND is_superseded = 0",
    ).get() as { cnt: number };
    reembedProgress = { running: true, done: 0, total: totalRow.cnt };

    const PAGE_SIZE = 100;
    let offset = 0;

    // 串行化(2026-05-09):历史用 Promise.all 并发跑 5 个 insertSegmentVectors,
    // 在 await getEmbedding 释放 event loop 后,多个 promise 会穿插写同一节点
    // 的 deleteVector / INSERT segment,产生孤儿向量。`reembedProgress.done++`
    // 也非原子。重 embed 期间用户编辑笔记时,旧 segment 可能在事务外被业务路径
    // 清理,这次重算结果与新 content 错位。
    // 改为单节点 await 串行:每节点 ~100ms,1000 节点 ~2 分钟,可接受。
    while (true) {
      const page = db.prepare(
        "SELECT id, content FROM nodes WHERE heat > 0.01 AND archived = 0 AND is_superseded = 0 LIMIT ? OFFSET ?",
      ).all(PAGE_SIZE, offset) as Array<{ id: string; content: string }>;

      if (page.length === 0) break;

      for (const node of page) {
        try {
          await insertSegmentVectors(db, node.id, node.content);
        } catch (err) {
          log.error(`重算 embedding 失败 (${node.id}):`, (err as Error).message);
        }
        reembedProgress.done++;
      }

      offset += PAGE_SIZE;
    }

    clearReembedFlag();
    // S19 reembed 完成后写入 normalization version,下次启动不再误触发"需 reembed"。
    // 当前 version=1 表示出口已统一 L2 归一化(src/llm/embedding.ts:253)。
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('embedding_normalization_version', '1')").run();
    log.info(`embedding 重算完成: ${reembedProgress.done}/${reembedProgress.total}`);
  } finally {
    reembedProgress.running = false;
    reembedLock = false;
  }
}
