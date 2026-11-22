import type Database from 'better-sqlite3'
import { archiveNode } from '@server/db/nodes.js'
import { deleteLink } from '@server/db/links.js'
import { excludeFromCloudSync } from '@server/db/cloud-sync-exclusions.js'
import { isDerivedNode, PROFILE_SOURCE_TOOL } from '@server/metabolism/derived-sources.js'
import { createLogger } from '@server/utils/logger.js'
import { withApplyGuard } from './local-apply.js'
import { syncRoleOutcome } from './primary-device.js'
import { DEVICE_NOT_REGISTERED, deferUpload } from './upload-deferral.js'

const log = createLogger('upload-rejections')

export const NOT_PRIMARY_DEVICE = 'not_primary_device'

const REPEATED_REJECTION_WARN = 5

export interface RejectionOutcome {
  /** 已识别并处理完的拒收（不再算作“被跳过”）。 */
  handled: string[]
  /** 放回待上传集合、稍后重试的记录。 */
  requeued: string[]
}

interface NodeRow {
  source_tool: string | null
  is_crystal: number
  is_tag: number
  is_meta: number
  is_superseded: number
}

/**
 * 处理云端的 not_primary_device 拒收（设计 primary-device-selection §10.4）。
 *
 * 先向云端复核：把关时读到的主设备可能是旧值（本机刚被设为主设备）。只有确认本机
 * 不是主设备，才做不可逆处理（归档被拒的整理结果、软删除相连链接、加入不上传名单）。
 * 复核后仍是主设备，或取不到（断网、注册接口失败）：放回待上传集合并推迟重试，不动数据。
 * 云端明确答复本机因设备数超限没有注册：暂存（不上传、不归档），注册成功后放行。
 */
export async function handleUploadRejections(
  db: Database.Database,
  table: 'nodes' | 'links',
  skipped: Array<{ id: string; reason: string }>,
): Promise<RejectionOutcome> {
  const rejected = skipped.filter(s => s.reason === NOT_PRIMARY_DEVICE).map(s => s.id)
  if (rejected.length === 0) return { handled: [], requeued: [] }

  const outcome = await syncRoleOutcome(db, { force: true })
  if (!db.open) return { handled: [], requeued: [] }
  if (outcome.status === 'device_limit') return parkUntilRegistered(db, table, rejected)
  const registration = outcome.status === 'registered' ? outcome.registration : null
  if (!registration || registration.cloudNotUpgraded || registration.isPrimary) {
    db.transaction(() => {
      const requeue = db.prepare('INSERT OR IGNORE INTO cloud_dirty (tbl, id) VALUES (?, ?)')
      for (const id of rejected) requeue.run(table, id)
    })()
    // 放回的记录必须推迟:上行循环以“待上传集合为空”为出口,立刻重试会没有尽头。
    const attempts = deferUpload(table, rejected)
    const why = registration?.isPrimary ? '本机是主设备' : '无法复核主设备'
    if (registration?.isPrimary && attempts >= REPEATED_REJECTION_WARN) {
      log.warn(`本机是主设备，但云端已连续 ${attempts} 次拒收 ${rejected.length} 条整理结果，继续按间隔重试`)
    } else {
      log.info(`${rejected.length} 条被拒记录已放回待上传并推迟重试（${why}）`)
    }
    return { handled: [], requeued: rejected }
  }
  if (table !== 'nodes') {
    // 云端目前不会对链接返回这个原因；若出现，只停止上传，不改本机数据。
    db.transaction(() => { for (const id of rejected) excludeFromCloudSync(db, 'links', id, NOT_PRIMARY_DEVICE) })()
    return { handled: rejected, requeued: [] }
  }

  const handled: string[] = []
  let archived = 0
  withApplyGuard(db, () => db.transaction(() => {
    const forget = db.prepare('DELETE FROM cloud_dirty WHERE tbl = ? AND id = ?')
    for (const id of rejected) {
      const row = db.prepare(
        'SELECT source_tool, is_crystal, is_tag, is_meta, is_superseded FROM nodes WHERE id = ?',
      ).get(id) as NodeRow | undefined
      if (!row) { handled.push(id); continue }
      if (row.source_tool === PROFILE_SOURCE_TOOL && row.is_superseded === 1) {
        // 云端拒绝了“旧画像被取代”：云端的旧画像保持有效。本机数据不动，只是不再上传这一行。
        excludeFromCloudSync(db, 'nodes', id, NOT_PRIMARY_DEVICE)
        forget.run('nodes', id)
        handled.push(id)
        continue
      }
      if (!isDerivedNode(row)) {
        // 不认识的拒收：绝不归档或排除用户数据，保持为“被跳过”，由对账重试。
        log.warn(`云端以 not_primary_device 拒收了非整理结果节点 ${id}，未做处理`)
        continue
      }
      // 非主设备新建的整理结果：主设备会自己生成。归档，并连同相连的链接一起不再上传。
      const links = db.prepare(
        'SELECT id FROM links WHERE (from_id = ? OR to_id = ?) AND deleted = 0',
      ).all(id, id) as Array<{ id: string }>
      for (const link of links) deleteLink(db, link.id)
      const allLinks = db.prepare('SELECT id FROM links WHERE from_id = ? OR to_id = ?').all(id, id) as Array<{ id: string }>
      for (const link of allLinks) {
        excludeFromCloudSync(db, 'links', link.id, NOT_PRIMARY_DEVICE)
        forget.run('links', link.id)
      }
      archiveNode(db, id)
      excludeFromCloudSync(db, 'nodes', id, NOT_PRIMARY_DEVICE)
      forget.run('nodes', id)
      handled.push(id)
      archived++
    }
  })())
  if (handled.length > 0) {
    log.info(`本机不是主设备：${archived} 条整理结果已在本机归档，不再上传（共处理 ${handled.length} 条拒收）`)
  }
  return { handled, requeued: [] }
}

/**
 * 本机因设备数超限没有在云端注册：被拒的整理结果暂存到不上传名单，连同相连的链接
 * （否则链接会因端点在云端不存在而被反复跳过，对账永远无法完成）。不归档、不软删除：
 * 用户升级计划或移除其他设备后本机可以注册，届时放行（releaseParkedUploads）。
 */
function parkUntilRegistered(
  db: Database.Database,
  table: 'nodes' | 'links',
  rejected: string[],
): RejectionOutcome {
  const handled: string[] = []
  db.transaction(() => {
    const forget = db.prepare('DELETE FROM cloud_dirty WHERE tbl = ? AND id = ?')
    for (const id of rejected) {
      if (table === 'links') {
        excludeFromCloudSync(db, 'links', id, DEVICE_NOT_REGISTERED)
        forget.run('links', id)
        handled.push(id)
        continue
      }
      const row = db.prepare(
        'SELECT source_tool, is_crystal, is_tag, is_meta, is_superseded FROM nodes WHERE id = ?',
      ).get(id) as NodeRow | undefined
      if (!row) { handled.push(id); continue }
      if (!isDerivedNode(row) && !(row.source_tool === PROFILE_SOURCE_TOOL && row.is_superseded === 1)) {
        log.warn(`云端以 not_primary_device 拒收了非整理结果节点 ${id}，未做处理`)
        continue
      }
      const links = db.prepare('SELECT id FROM links WHERE from_id = ? OR to_id = ?').all(id, id) as Array<{ id: string }>
      for (const link of links) {
        excludeFromCloudSync(db, 'links', link.id, DEVICE_NOT_REGISTERED)
        forget.run('links', link.id)
      }
      excludeFromCloudSync(db, 'nodes', id, DEVICE_NOT_REGISTERED)
      forget.run('nodes', id)
      handled.push(id)
    }
  })()
  if (handled.length > 0) log.info(`本机尚未在云端注册（设备数已达上限）：${handled.length} 条整理结果暂不上传，注册成功后自动补传`)
  return { handled, requeued: [] }
}
