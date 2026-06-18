import type Database from 'better-sqlite3'
import { getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js'
import { createLogger } from '../../../src/utils/logger.js'

const log = createLogger('cloud-uplink')

const UPLINK_BATCH = 50

let running = false

/** 规范化本地行给 bulk-upsert:tags JSON 字符串→array、INTEGER bool→boolean(server 期望)。 */
function normalizeRow(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r }
  if (typeof out.tags === 'string') {
    try { out.tags = JSON.parse(out.tags as string) } catch { /* 保留字符串,server 兼容 */ }
  }
  for (const k of ['archived', 'is_crystal', 'is_tag', 'is_meta', 'is_keystone', 'is_superseded', 'auto']) {
    if (typeof out[k] === 'number') out[k] = Boolean(out[k])
  }
  return out
}

interface BulkUpsertResponse {
  processed?: number
  skipped?: Array<{ id: string; reason: string }>
}

async function postBulkUpsert(
  token: string,
  table: 'nodes' | 'links',
  items: Record<string, unknown>[],
): Promise<BulkUpsertResponse> {
  const res = await fetch(`${getCloudBaseUrl()}/api/v1/sync/bulk-upsert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table, is_initial_reconcile: false, items }),
  })
  if (!res.ok) throw new Error(`bulk-upsert ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json().catch(() => ({}))) as BulkUpsertResponse
}

/**
 * 原子"取 + 删"一批脏集 id。
 *
 * 取删必须原子:上行期间用户若再改同一 id,nodes/links 触发器会**重新**把它 INSERT 进脏集
 * (脏集此刻已被删空该 id),于是下次 pump 会再上行最新版本 —— 不丢更新。若取了不删,
 * 上行后再删会把"期间的新改动"一起删掉(TOCTOU 丢更新)。
 */
export function claimDirty(db: Database.Database, table: 'nodes' | 'links', limit: number): string[] {
  const claim = db.transaction(() => {
    const dirty = db.prepare(`SELECT id FROM cloud_dirty WHERE tbl = ? LIMIT ?`).all(table, limit) as Array<{ id: string }>
    const ids = dirty.map((d) => d.id)
    if (ids.length > 0) {
      const del = db.prepare(`DELETE FROM cloud_dirty WHERE tbl = ? AND id = ?`)
      for (const id of ids) del.run(table, id)
    }
    return ids
  })
  return claim()
}

/** 上行失败 → 重新入脏集(下次 pump 重试)。 */
function requeueDirty(db: Database.Database, table: 'nodes' | 'links', ids: string[]): void {
  const requeue = db.transaction(() => {
    const ins = db.prepare(`INSERT OR IGNORE INTO cloud_dirty (tbl, id) VALUES (?, ?)`)
    for (const id of ids) ins.run(table, id)
  })
  requeue()
}

/**
 * M7:记录"有净增节点被云端配额拒绝(quota_exhausted)"的时间戳,供 UI 提示用户升级。
 * 这些项不 requeue(避免 3s pump 死循环空打被拒请求),靠 ≤7 天 reconcile 兜底重推,不丢数据。
 */
function markQuotaExhausted(db: Database.Database): void {
  try {
    db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud.quota_exhausted_at', ?)`)
      .run(new Date().toISOString())
  } catch { /* metadata 写失败不阻塞上行主流程 */ }
}

/**
 * 实时上行 pump(M6,把本地写从 ≤7 天 reconcile 慢通道升级到秒级)。
 *
 * 本地任何 nodes/links 写(用户编辑 / digest)→ 触发器记入 cloud_dirty。pump 取脏集 → 整行
 * bulk-upsert 上行 → 删脏集。复用服务端 /bulk-upsert(通用 upsert + (edit_seq,updated) 因果裁决 +
 * non-initial 不回写派生字段),**server 零改动**。冲突由服务端裁决,本地不重试坏行。
 *
 * 不丢更新:claimDirty 取删原子 + 失败重新入脏集。inflight 去重。reconcile(≤7天)仍是兜底。
 */
export async function pumpUplink(db: Database.Database): Promise<number> {
  if (running) return 0
  running = true
  let uploaded = 0
  let quotaExhausted = 0
  try {
    const token = await refreshTokenIfNeeded()
    if (!token) return 0

    for (const table of ['nodes', 'links'] as const) {
      for (;;) {
        const ids = claimDirty(db, table, UPLINK_BATCH)
        if (ids.length === 0) break
        const placeholders = ids.map(() => '?').join(',')
        const rows = (db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[])
          .map(normalizeRow)
        // rows 缺的 id = 本地已 hard-delete:脏集已在 claim 时删除,无需上行(删除传播靠 reconcile)。
        if (rows.length === 0) continue
        try {
          const resp = await postBulkUpsert(token, table, rows)
          uploaded += rows.length
          // M7:服务端 net-growth 配额耗尽时把净增项标 quota_exhausted skip(返回 200,非整批失败)。
          // 这些项已在 claimDirty 时移出脏集,**不 requeue**(否则 3s pump 死循环空打被拒请求);
          // 靠 ≤7 天 reconcile 兜底重新上行(reconciler 不删本地、server manifest 始终显示缺失,
          // 升级 Pro 后下次 reconcile 自动补齐)。仅记时间戳供 UI 提示,不丢数据。
          const qe = (resp.skipped ?? []).filter((s) => s.reason === 'quota_exhausted')
          quotaExhausted += qe.length
        } catch (err) {
          requeueDirty(db, table, ids) // 上行失败(网络/5xx)→ 重新入脏集,本轮中止
          throw err
        }
      }
    }
    if (uploaded > 0) log.info(`实时上行 ${uploaded} 行`)
    if (quotaExhausted > 0) {
      markQuotaExhausted(db)
      log.warn(`实时上行有 ${quotaExhausted} 个净增节点被云端配额拒绝,靠 reconcile 兜底待升级重推`)
    }
  } catch (err) {
    log.warn(`uplink pump 中止(脏集保留下次重试): ${(err as Error).message}`)
  } finally {
    running = false
  }
  return uploaded
}
