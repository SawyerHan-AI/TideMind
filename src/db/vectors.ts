import { getVectorReadiness } from './vector-readiness.js';
import { activeVectorRuntime, ELIGIBLE_VECTOR_SEGMENTS_SQL, validUnitVector, vectorQueryCurrent, vectorSpaceCurrent } from './vector-query.js';
import { stampVector, type VectorSpaceStamp } from '../embedding/vector-space.js';
import { getConfig } from '../config.js';
import { readVectorRuntime } from './vector-cache-store.js';
import { generateNodeVectorBundle, type NodeVectorGenerationOptions } from '../embedding/generate-node.js';
import type Database from 'better-sqlite3';
import { nodeEmbeddingInput, nodeEmbeddingInputHash, segmentForEmbedding } from '../embedding/input-contract.js';
export { nodeEmbeddingInput, nodeEmbeddingInputHash, segmentForEmbedding } from '../embedding/input-contract.js';
import { getEmbedding } from '../llm/embedding.js';
import { clearReembedFlag } from './connection.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('vectors');

export interface VectorSearchResult {
  id: string;       // node_id (已去重)
  distance: number;  // 最佳 segment 的距离
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
  _content: string,
  options: NodeVectorGenerationOptions = {},
): Promise<number> {
  if (readVectorRuntime(db)) return generateNodeVectorBundle(db,nodeId,getConfig(),options);
  if (db.prepare("SELECT 1 FROM metadata WHERE key IN ('vector.legacy_archive_version','vector.runtime_error') LIMIT 1").get()) return 0;
  const readSnapshot = () => db.prepare('SELECT content, title, archived, is_superseded FROM nodes WHERE id = ?')
    .get(nodeId) as { content: string; title: string | null; archived: number; is_superseded: number } | undefined;
  const before = readSnapshot();
  if (!before || before.archived || before.is_superseded) return 0;
  const snapshot = JSON.stringify(before);
  const input = nodeEmbeddingInput(before.content,before.title);
  const segments = segmentForEmbedding(input);
  if (!segments.length) {
    db.transaction(() => {
      deleteVector(db,nodeId);
      db.prepare('DELETE FROM metadata WHERE key=?').run(`vector.input:${nodeId}`);
    })();
    return 0;
  }

  const previousInput = db.prepare('SELECT value FROM metadata WHERE key=?').get(`vector.input:${nodeId}`) as { value:string } | undefined;
  if (previousInput && previousInput.value !== nodeEmbeddingInputHash(before.content,before.title)) {
    db.transaction(() => {
      deleteVector(db,nodeId);
      db.prepare('DELETE FROM metadata WHERE key=?').run(`vector.input:${nodeId}`);
    })();
  }

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
  if (embeddings.length !== segments.length) {
    log.warn(`node=${nodeId} 所有 segment embedding 均失败,保留旧 vector`);
    return 0;
  }

  // 原子写入：删除旧数据 + 插入所有新 segments
  const inserted = db.transaction(() => {
    if (JSON.stringify(readSnapshot()) !== snapshot) return 0;
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
    db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(`vector.input:${nodeId}`,nodeEmbeddingInputHash(before.content,before.title));
    return embeddings.length;
  })();

  log.debug(`node=${nodeId} 插入 ${inserted} segments`);
  return inserted;
}

/**
 * 插入单个预计算的 embedding（兼容旧接口）
 */
export function insertVector(db: Database.Database, nodeId: string, embedding: Float32Array): void {
  db.transaction(() => {
    // Legacy raw writes cannot reuse a proof from a previously verified bundle.
    try { db.prepare('DELETE FROM metadata WHERE key=?').run(`vector.projection_checksum:${nodeId}`); }
    catch (error) { if(!/no such table: metadata/i.test(String(error)))throw error; }
    const segmentId = `${nodeId}#0`;
    db.prepare('DELETE FROM nodes_vec WHERE id=?').run(segmentId);
    db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)')
      .run(segmentId,Buffer.from(embedding.buffer,embedding.byteOffset,embedding.byteLength));
    db.prepare('INSERT OR REPLACE INTO node_segments (segment_id,node_id,segment_index) VALUES (?,?,0)').run(segmentId,nodeId);
  })();
}

/**
 * 删除节点的所有 embedding segments
 */
export function deleteVector(db: Database.Database, nodeId: string): void {
  db.transaction(() => {
    // Invalidate before removing physical rows; no partial projection is eligible.
    try { db.prepare('DELETE FROM metadata WHERE key=?').run(`vector.projection_checksum:${nodeId}`); }
    catch (error) { if(!/no such table: metadata/i.test(String(error)))throw error; }
    const segments=db.prepare('SELECT segment_id FROM node_segments WHERE node_id=?').all(nodeId) as Array<{segment_id:string}>;
    for(const segment of segments)db.prepare('DELETE FROM nodes_vec WHERE id=?').run(segment.segment_id);
    db.prepare('DELETE FROM node_segments WHERE node_id=?').run(nodeId);
  })();
}

/**
 * 获取节点第一个 segment 的 embedding（用于 rerank 等场景）
 */
export function getVectorForNode(db: Database.Database, nodeId: string, expectedSpace?: VectorSpaceStamp): Float32Array | null {
  try {
    const runtime=activeVectorRuntime(db);
    if(!runtime || (expectedSpace&&!vectorSpaceCurrent(db,expectedSpace)))return null;
    const row=db.prepare(`SELECT embedding,(SELECT value FROM metadata WHERE key=?) AS input_hash FROM nodes_vec WHERE id=? AND id IN (${ELIGIBLE_VECTOR_SEGMENTS_SQL} AND n.id=?)`)
      .get(`vector.input:${nodeId}`,`${nodeId}#0`,runtime.selection.id,nodeId) as {embedding:Buffer;input_hash:string}|undefined;
    if(!row)return null;
    const vector=new Float32Array(row.embedding.buffer,row.embedding.byteOffset,row.embedding.byteLength/4);
    if(!validUnitVector(vector,runtime.selection.profile.dimensions)
      ||!vectorSpaceCurrent(db,{profileId:runtime.selection.id,epoch:runtime.epoch,nodeId,inputHash:row.input_hash}))return null;
    return stampVector(vector,runtime,{nodeId,inputHash:row.input_hash});
  }catch{return null;}
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
    const runtime=activeVectorRuntime(db);
    if(!runtime||!vectorQueryCurrent(db,queryEmbedding)||!validUnitVector(queryEmbedding,runtime.selection.profile.dimensions))return [];
    // 搜更多 segments 以确保去重后有足够节点
    const rawResults = db.prepare(`
      SELECT id, distance
      FROM nodes_vec
      WHERE embedding MATCH ? AND id IN (${ELIGIBLE_VECTOR_SEGMENTS_SQL})
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength), runtime.selection.id, Math.min(limit * 3,4096)) as Array<{ id: string; distance: number }>;

    if(!vectorQueryCurrent(db,queryEmbedding))return [];
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
    const runtime=activeVectorRuntime(db);if(!runtime)return false;
    return !!db.prepare(`SELECT 1 FROM nodes_vec WHERE id IN (${ELIGIBLE_VECTOR_SEGMENTS_SQL}) LIMIT 1`).get(runtime.selection.id);
  }catch{return false;}
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
export async function reembedAllNodes(db: Database.Database): Promise<boolean> {
  if (reembedLock) return false;
  reembedLock = true;

  try {
    const runtime=readVectorRuntime(db);
    const current=()=>db.open && (readVectorRuntime(db)?.epoch ?? null)===(runtime?.epoch ?? null);
    const totalRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01 AND archived = 0 AND is_superseded = 0",
    ).get() as { cnt: number };
    reembedProgress = { running: true, done: 0, total: totalRow.cnt };

    const PAGE_SIZE = 100;

    // 串行化(2026-05-09):历史用 Promise.all 并发跑 5 个 insertSegmentVectors,
    // 在 await getEmbedding 释放 event loop 后,多个 promise 会穿插写同一节点
    // 的 deleteVector / INSERT segment,产生孤儿向量。`reembedProgress.done++`
    // 也非原子。重 embed 期间用户编辑笔记时,旧 segment 可能在事务外被业务路径
    // 清理,这次重算结果与新 content 错位。
    // 改为单节点 await 串行:每节点 ~100ms,1000 节点 ~2 分钟,可接受。
    //
    // 翻页必须用稳定游标(id 不可变)而非 LIMIT/OFFSET:重 embed 是长任务,
    // 每个 await getEmbedding 都释放 event loop,期间 synaptic 衰减/归档/
    // supersede 会并发改 heat/archived 这些过滤列——行跌出结果集时 OFFSET
    // 会整体左移、静默跳过未处理节点,而循环结束后无条件写 normalization
    // metadata,被跳过的节点保留旧向量且永不补救。
    let cursor = '';
    while (true) {
      if(!current())return false;
      const page = db.prepare(
        "SELECT id, content, title FROM nodes WHERE heat > 0.01 AND archived = 0 AND is_superseded = 0 AND id > ? ORDER BY id LIMIT ?",
      ).all(cursor, PAGE_SIZE) as Array<{ id: string; content: string; title:string|null }>;

      if (page.length === 0) break;

      for (const node of page) {
        if(!current())return false;
        let generationFailed=false;
        try {
          await insertSegmentVectors(db, node.id, node.content, {foreground:true,expectedEpoch:runtime?.epoch,onGenerationFailure:()=>{generationFailed=true;}});
        } catch (err) {
          log.error(`重算 embedding 失败 (${node.id}):`, (err as Error).message);
        }
        if(!current())return false;
        if(generationFailed && runtime && nodeEmbeddingInput(node.content,node.title).trim()){
          const key=`vector.generate_retry:${JSON.stringify([runtime.endpointId??null,runtime.accountId,runtime.selection.id,node.id])}`;
          db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(key,JSON.stringify({inputHash:nodeEmbeddingInputHash(node.content,node.title),retryAfter:0,reason:'generation_failed'}));
        }
        reembedProgress.done++;
      }

      cursor = page[page.length - 1].id;
    }

    const coverage=getVectorReadiness(db);
    if(coverage.mode==='initializing' || (coverage.mode==='error' && !coverage.uploadFailed) || coverage.missing>0){
      log.warn(`embedding 遍历结束，但向量尚未就绪: ${coverage.ready}/${coverage.eligible}`);
      return false;
    }
    clearReembedFlag();
    // S19 reembed 完成后写入 normalization version,下次启动不再误触发"需 reembed"。
    // 当前 version=1 表示出口已统一 L2 归一化(src/llm/embedding.ts:253)。
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('embedding_normalization_version', '1')").run();
    log.info(`embedding 重算完成: ${coverage.ready}/${coverage.eligible}`);
    return true;
  } finally {
    reembedProgress.running = false;
    reembedLock = false;
  }
}
