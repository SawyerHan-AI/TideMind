import { segmentForEmbedding, nodeEmbeddingInput, nodeEmbeddingInputHash, deleteVector } from '../../../src/db/vectors.js'
import type Database from 'better-sqlite3'
import { SqliteRepository } from '../../../src/db/sqlite-repository.js'
import { createLogger } from '../../../src/utils/logger.js'

const log = createLogger('cloud-reembed')

const REEMBED_BATCH = 10
// ECMAScript trim whitespace, shared by selection and vectors.ts fallback.
const EMBEDDING_WHITESPACE = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

let running = false
const scanCursors = new WeakMap<Database.Database, string>()

/**
 * 扫描"active 且有正文或标题但缺本地向量"的节点(LEFT JOIN node_segments 取无 segment 的)。
 *
 * 这恰好 = 跨设备 pull 来的节点(向量纯本地不同步)+ 本地 embed 失败的节点。本地 digest
 * 新建会立即 insertSegmentVectors,所以正常本地节点不会进这个集合。
 */
export function findMissingVectorNodes(
  db: Database.Database,
  limit: number,
): Array<{ id: string; content: string; cleanupOnly?: boolean }> {
  const missing = db.prepare(`
    SELECT n.id AS id, CASE WHEN length(trim(n.content, ?)) > 0 THEN n.content ELSE n.title END AS content
    FROM nodes n
    LEFT JOIN node_segments s ON s.node_id = n.id
    WHERE n.archived = 0
      AND n.is_superseded = 0
      AND (length(trim(coalesce(n.content, ''), ?)) > 0
        OR length(trim(coalesce(n.title, ''), ?)) > 0)
      AND s.node_id IS NULL
    LIMIT ?
  `).all(EMBEDDING_WHITESPACE, EMBEDDING_WHITESPACE, EMBEDDING_WHITESPACE, limit) as Array<{ id: string; content: string; cleanupOnly?: boolean }>
  if (missing.length >= limit) return missing
  // Bounded audit of pre-existing partial indexes, not a full content scan per tick.
  const cursor = scanCursors.get(db) ?? ''
  const rows = db.prepare(`SELECT id,content,title FROM nodes WHERE id>? AND archived=0 AND is_superseded=0 ORDER BY id LIMIT 100`).all(cursor) as Array<{id:string;content:string;title:string|null}>
  const candidates = [...missing]
  const selected = new Set(candidates.map(row=>row.id))
  for (const row of rows) {
    scanCursors.set(db,row.id)
    if (selected.has(row.id)) continue
    const expected = segmentForEmbedding(nodeEmbeddingInput(row.content,row.title)).length
    const segments = db.prepare('SELECT segment_id,segment_index FROM node_segments WHERE node_id=? ORDER BY segment_index').all(row.id) as Array<{segment_id:string;segment_index:number}>
    if (!expected) {
      if (segments.length) candidates.push({id:row.id,content:row.content,cleanupOnly:true})
      if (candidates.length>=limit) return candidates
      continue
    }
    let complete = segments.length===expected && segments.every((part,index)=>part.segment_index===index && part.segment_id===`${row.id}#${index}`)
    if (complete) {
      try { const read=db.prepare('SELECT id FROM nodes_vec WHERE id=?');complete=segments.every(part=>!!read.get(part.segment_id)) }
      catch { complete=false }
    }
    const hash=db.prepare('SELECT value FROM metadata WHERE key=?').get(`vector.input:${row.id}`) as {value:string}|undefined
    if (hash && hash.value!==nodeEmbeddingInputHash(row.content,row.title)) complete=false
    // Legacy complete indexes without a hash are structurally checked, not claimed
    // as freshly embedded. New commits always record the exact input hash.
    if (!complete) { candidates.push({id:row.id,content:row.content});selected.add(row.id) }
    if (candidates.length>=limit) return candidates
  }
  if (rows.length<100) scanCursors.delete(db)
  return candidates
}

/**
 * 补 embed pump(M4,解 current-state #2 召回缺口)。
 *
 * 跨设备 pull 下来的节点只写了 nodes 行,没有本地向量(applyCloudNodeRow 不重建 embedding),
 * 导致"看得见、recall 召不回"。本 pump 扫描缺向量的 active 节点补 embed,兼做"本地 embed
 * 失败兜底",无需改 local-apply、无需持久队列表。
 *
 * 失败不抛(无 embedding 凭证 / 熔断 / 网络故障):整批提前退出,下次 pump 再试。
 * inflight 去重防并发(pull 高频触发可能叠加)。
 */
export async function pumpReembedMissing(db: Database.Database): Promise<number> {
  if (running) return 0
  running = true
  let embedded = 0
  try {
    const rows = findMissingVectorNodes(db, REEMBED_BATCH)
    if (rows.length === 0) return 0

    const repo = new SqliteRepository(db)
    for (const row of rows) {
      try {
        // A structurally invalid index must not remain searchable on provider failure.
        try { deleteVector(db,row.id) } catch (error) {
          if (!/no such (table|module)/i.test(String(error))) throw error
        }
        if (row.cleanupOnly) { db.prepare('DELETE FROM metadata WHERE key=?').run(`vector.input:${row.id}`);continue }
        const inserted = await repo.vectors.insertSegmentVectors(row.id, row.content)
        if (inserted === 0) break
        embedded++
      } catch (err) {
        // embedding 不可用(无凭证/熔断/网络)→ 这一批后续大概率同样失败,提前退出省时;
        // 不阻塞、不抛,下次 pump 再试。
        log.warn(`reembed ${row.id} 失败,本轮中止: ${(err as Error).message}`)
        break
      }
    }
    if (embedded > 0) log.info(`补 embed ${embedded} 个跨设备同步节点`)
  } catch (err) {
    log.warn(`reembed pump 异常: ${(err as Error).message}`)
  } finally {
    running = false
  }
  return embedded
}
