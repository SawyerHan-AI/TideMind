/**
 * 灰度发布客户端判定:基于持久化 client-id 哈希到 [0,99) 区间,
 * percentage 内为"在本批次"。同一客户端结果稳定,不会反复横跳。
 *
 * P0:端点暂不返回 stagingPercentage,该函数恒返回 true。P1 端点改造后生效。
 */

import crypto from 'node:crypto'
import { getOrCreateStableClientId } from '../utils/machine-id.js'

export function isInStagingBatch(percentage: number | null | undefined, dataDir: string): boolean {
  if (percentage == null) return true
  if (percentage >= 100) return true
  if (percentage <= 0) return false

  const id = getOrCreateStableClientId(dataDir)
  const hash = crypto.createHash('sha256').update(id).digest()
  const bucket = hash.readUInt32BE(0) % 100
  return bucket < percentage
}
