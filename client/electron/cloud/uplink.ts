import type Database from 'better-sqlite3'
import { getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js'
import { createLogger } from '../../../src/utils/logger.js'
import { INSTALLATION_ID_HEADER, getInstallationId } from './device.js'
import { handleUploadRejections } from './upload-rejections.js'
import { isDerivedNode } from '@server/metabolism/derived-sources.js'
import { shouldSendInitialFlagForUplink } from './initial-sync-state.js'
import { clearUploadRelease, isUploadDeferred, readUploadRelease } from './upload-deferral.js'
import { noteUnauthorized } from './unauthorized.js'

const log = createLogger('cloud-uplink')

const UPLINK_BATCH = 50

let running = false
let activeBatch: { db: Database.Database; table: 'nodes' | 'links'; ids: string[]; cancelled: boolean } | null = null

/** stop/退出在关闭 DB 前同步归还已 claim 的批次；迟到网络回调不得再访问 DB。 */
export function cancelActiveUplink(db: Database.Database): void {
  if (!activeBatch || activeBatch.db !== db || activeBatch.cancelled) return
  requeueDirty(db, activeBatch.table, activeBatch.ids)
  activeBatch.cancelled = true
}

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

/** 上传携带本机安装标识:云端据此判断是不是主设备(非主设备新建的整理结果会被按条拒收)。 */
function installationHeaders(db: Database.Database): Record<string, string> {
  try { return { [INSTALLATION_ID_HEADER]: getInstallationId(db) } } catch { return {} }
}

async function postBulkUpsert(
  db: Database.Database,
  token: string,
  table: 'nodes' | 'links',
  items: Record<string, unknown>[],
  isInitial = false,
): Promise<BulkUpsertResponse> {
  const res = await fetch(`${getCloudBaseUrl()}/api/v1/sync/bulk-upsert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...installationHeaders(db) },
    body: JSON.stringify({ table, is_initial_reconcile: isInitial, items }),
  })
  if (!res.ok) {
    noteUnauthorized(res.status)
    throw new Error(`bulk-upsert ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return (await res.json().catch(() => ({}))) as BulkUpsertResponse
}

/**
 * 原子"取 + 删"一批脏集 id。
 *
 * 取删必须原子:上行期间用户若再改同一 id,nodes/links 触发器会**重新**把它 INSERT 进脏集
 * (脏集此刻已被删空该 id),于是下次 pump 会再上行最新版本 —— 不丢更新。若取了不删,
 * 上行后再删会把"期间的新改动"一起删掉(TOCTOU 丢更新)。
 */
export function claimDirty(
  db: Database.Database,
  table: 'nodes' | 'links',
  limit: number,
  skip?: (id: string) => boolean,
): string[] {
  const claim = db.transaction(() => {
    // 不上传名单内的记录(被云端拒收的非主设备整理结果)永不取出。
    // 先取全部 id 再过滤、最后限量:若先 LIMIT 再过滤,被跳过的记录达到一页时会一直
    // 占满这一页,排在后面的正常记录永远取不到。
    // 按 id 顺序分页扫描,凑够 limit 条即停:脏集很大时不必每次把全部 id 读出来。
    const page = db.prepare(`
      SELECT id FROM cloud_dirty WHERE tbl = ? AND id > ?
        AND id NOT IN (SELECT id FROM cloud_sync_excluded WHERE tbl = ?)
      ORDER BY id LIMIT ?
    `)
    const pageSize = Math.max(limit * 4, 200)
    const ids: string[] = []
    let cursor = ''
    for (;;) {
      const rows = page.all(table, cursor, table, pageSize) as Array<{ id: string }>
      for (const { id } of rows) {
        if (ids.length >= limit) break
        if (!skip?.(id)) ids.push(id)
      }
      if (ids.length >= limit || rows.length < pageSize) break
      cursor = rows[rows.length - 1].id
    }
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
export async function pumpUplink(db: Database.Database, shouldStop: () => boolean = () => false): Promise<number> {
  if (shouldStop()) return 0
  if (running) return 0
  running = true
  let uploaded = 0
  let quotaExhausted = 0
  try {
    const token = await refreshTokenIfNeeded()
    if (shouldStop() || !token) return 0
    // 本轮开始时已存在的放行标记:只有它对应的记录保证能赶上本轮的节点阶段。
    const releaseAtStart = readUploadRelease(db)

    for (const table of ['nodes', 'links'] as const) {
      // 一次运行内同一条记录只取一次:拒收处理可能把记录放回待上传集合,不加这一条
      // 循环就没有出口。未到期的推迟记录同样不取。
      const seen = new Set<string>()
      for (;;) {
        if (shouldStop()) return uploaded
        const ids = claimDirty(db, table, UPLINK_BATCH, (id) => seen.has(id) || isUploadDeferred(table, id))
        if (ids.length === 0) break
        for (const id of ids) seen.add(id)
        const placeholders = ids.map(() => '?').join(',')
        const rows = (db.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[])
          .map(normalizeRow)
        // rows 缺的 id = 本地已 hard-delete:脏集已在 claim 时删除,无需上行(删除传播靠 reconcile)。
        if (rows.length === 0) continue
        const batch = { db, table, ids, cancelled: false }
        activeBatch = batch
        try {
          // 整理结果单独成批:只有它们需要首次同步标志(见 initial-sync-state),
          // 普通记忆的上传语义保持不变。
          const derived = table === 'nodes' && shouldSendInitialFlagForUplink(db)
            ? rows.filter((row) => isDerivedNode(row as Parameters<typeof isDerivedNode>[0]))
            : []
          const resp: BulkUpsertResponse = { skipped: [] }
          if (derived.length > 0) {
            const first = await postBulkUpsert(db, token, table, derived, true)
            resp.skipped!.push(...(first.skipped ?? []))
            if (batch.cancelled) return uploaded
          }
          const plain = derived.length > 0 ? rows.filter((row) => !derived.includes(row)) : rows
          if (plain.length > 0 && !shouldStop()) {
            const second = await postBulkUpsert(db, token, table, plain)
            resp.skipped!.push(...(second.skipped ?? []))
          }
          if (batch.cancelled) return uploaded
          if (shouldStop()) {
            // claim 已取删；停止期间结果不再消费，收尾归还当前批以保留待确认更新。
            // INSERT OR IGNORE 不覆盖请求期间触发器重新记录的同 id 本地编辑。
            requeueDirty(db, table, ids)
            return uploaded
          }
          uploaded += rows.length
          // M7:服务端 net-growth 配额耗尽时把净增项标 quota_exhausted skip(返回 200,非整批失败)。
          // 这些项已在 claimDirty 时移出脏集,**不 requeue**(否则 3s pump 死循环空打被拒请求);
          // 靠 ≤7 天 reconcile 兜底重新上行(reconciler 不删本地、server manifest 始终显示缺失,
          // 升级 Pro 后下次 reconcile 自动补齐)。仅记时间戳供 UI 提示,不丢数据。
          const qe = (resp.skipped ?? []).filter((s) => s.reason === 'quota_exhausted')
          quotaExhausted += qe.length
          // 主设备把关的拒收在取下一批(尤其是链接批次)之前处理完:被拒节点的链接
          // 会被软删除并排除,不再上传。
          await handleUploadRejections(db, table, resp.skipped ?? [])
          if (batch.cancelled || shouldStop()) return uploaded
        } catch (err) {
          if (batch.cancelled) return uploaded
          requeueDirty(db, table, ids) // 上行失败(网络/5xx)→ 重新入脏集,本轮中止
          if (shouldStop()) return uploaded
          throw err
        } finally {
          if (activeBatch === batch) activeBatch = null
        }
      }
    }
    // 暂存记录放行后的这一轮已经把待上传的节点取完,之后恢复普通语义。
    // 本轮中途才发生的放行不清:它的记录可能已错过节点阶段,留给下一轮带标志上传。
    if (releaseAtStart !== null) clearUploadRelease(db, releaseAtStart)
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
