import type Database from 'better-sqlite3'
import { getFirstRegisteredAt } from './device.js'
import { hasPendingUploadRelease } from './upload-deferral.js'

const INITIAL_EXEMPT_WINDOW_MS = 24 * 60 * 60 * 1000

function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

/**
 * 本机是否处于首次同步状态：节点与链接两张表都从未完成过对账。
 * 自动对账、手动强制对齐、实时上行共用这一个判断。读取失败按“不是”处理，不扩大豁免。
 */
export function isInitialSyncState(db: Database.Database): boolean {
  try {
    return !readMeta(db, 'cloud.last_reconcile_at_nodes') && !readMeta(db, 'cloud.last_reconcile_at_links')
  } catch {
    return false
  }
}

/**
 * 实时上行上传整理结果（派生节点）时是否带首次同步标志。
 *
 * 云端只在“带标志且设备注册不超过 24 小时”时接受非主设备新建的整理结果，照顾先单机
 * 使用、后登录的设备。超过 24 小时后带标志没有任何作用，只会让云端按首次对账的方式
 * 写入派生字段，所以这里同样以 24 小时为限。
 */
export function shouldSendInitialFlagForUplink(db: Database.Database, now = Date.now()): boolean {
  const registeredAt = getFirstRegisteredAt(db)
  if (registeredAt === null || now - registeredAt > INITIAL_EXEMPT_WINDOW_MS) return false
  return isInitialSyncState(db) || hasPendingUploadRelease(db)
}
