import type Database from 'better-sqlite3'
import { SqliteRepository } from '../../../src/db/sqlite-repository.js'
import { createLogger } from '../../../src/utils/logger.js'

const log = createLogger('cloud-reembed')

const REEMBED_BATCH = 10

let running = false

/**
 * 扫描"active 且有 content 但缺本地向量"的节点(LEFT JOIN node_segments 取无 segment 的)。
 *
 * 这恰好 = 跨设备 pull 来的节点(向量纯本地不同步)+ 本地 embed 失败的节点。本地 digest
 * 新建会立即 insertSegmentVectors,所以正常本地节点不会进这个集合。
 */
export function findMissingVectorNodes(
  db: Database.Database,
  limit: number,
): Array<{ id: string; content: string }> {
  return db.prepare(`
    SELECT n.id AS id, n.content AS content
    FROM nodes n
    LEFT JOIN node_segments s ON s.node_id = n.id
    WHERE n.archived = 0
      AND n.is_superseded = 0
      AND n.content IS NOT NULL AND n.content != ''
      AND s.node_id IS NULL
    LIMIT ?
  `).all(limit) as Array<{ id: string; content: string }>
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
        await repo.vectors.insertSegmentVectors(row.id, row.content)
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
