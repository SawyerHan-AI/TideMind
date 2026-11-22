import type Database from 'better-sqlite3'
import { releaseExcludedByReason, TEMPORARY_EXCLUSION_REASON } from '@server/db/cloud-sync-exclusions.js'

/**
 * 被云端拒收、暂时无法定论的上传记录的退避（进程内存）。
 *
 * 这些记录留在待上传集合里，但在到期之前不会被实时上行取出：
 * 首次 30 秒，每次翻倍，上限 1 小时。注册成功或本机角色变化时清空。
 */
const FIRST_DELAY_MS = 30_000
const MAX_DELAY_MS = 60 * 60 * 1000

export const DEVICE_NOT_REGISTERED = TEMPORARY_EXCLUSION_REASON
const RELEASE_KEY = 'cloud.upload_release_at'

type Table = 'nodes' | 'links'
const deferred = new Map<string, { notBefore: number; attempts: number }>()
const key = (table: Table, id: string): string => `${table}:${id}`

/** 推迟一批记录，返回其中推迟次数最多的一条的次数。 */
export function deferUpload(table: Table, ids: string[], now = Date.now()): number {
  let most = 0
  for (const id of ids) {
    const attempts = (deferred.get(key(table, id))?.attempts ?? 0) + 1
    const delay = Math.min(FIRST_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS)
    deferred.set(key(table, id), { notBefore: now + delay, attempts })
    most = Math.max(most, attempts)
  }
  return most
}

export function isUploadDeferred(table: Table, id: string, now = Date.now()): boolean {
  const entry = deferred.get(key(table, id))
  return !!entry && entry.notBefore > now
}

export function clearDeferredUploads(): void {
  deferred.clear()
}

/**
 * 设备数超限期间暂存的记录在注册成功后放行：移出不上传名单、重新记入待上传集合，
 * 并记下放行时间（放行后的第一轮实时上行按首次同步处理这些整理结果）。
 */
export function releaseParkedUploads(db: Database.Database): number {
  const released = releaseExcludedByReason(db, DEVICE_NOT_REGISTERED)
  if (released > 0) {
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(RELEASE_KEY, new Date().toISOString())
    clearDeferredUploads()
  }
  return released
}

/** 当前的放行标记（放行时间）；没有待处理的放行时为 null。 */
export function readUploadRelease(db: Database.Database): string | null {
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(RELEASE_KEY) as { value: string } | undefined
    return row?.value ?? null
  } catch { return null }
}

/** 登出或换账号时丢弃放行标记（它属于上一个账号的放行）。 */
export function discardUploadRelease(db: Database.Database): void {
  try { db.prepare('DELETE FROM metadata WHERE key = ?').run(RELEASE_KEY) } catch { /* 不阻塞登出 */ }
}

export function hasPendingUploadRelease(db: Database.Database): boolean {
  return readUploadRelease(db) !== null
}

/**
 * 清除放行标记，但只清调用方见过的那一个：一轮上行进行到一半时发生的放行，
 * 它的记录本轮可能已经错过了节点阶段，标记必须留给下一轮。
 */
export function clearUploadRelease(db: Database.Database, seen: string): void {
  try { db.prepare('DELETE FROM metadata WHERE key = ? AND value = ?').run(RELEASE_KEY, seen) } catch { /* 下一轮再清 */ }
}
