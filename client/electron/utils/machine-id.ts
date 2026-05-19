/**
 * 持久化客户端 ID,用于 stagingPercentage 哈希判定。
 *
 * 存在 ${dataDir}/.client-id,首次调用时生成 UUID4,后续读文件返回。
 * 绝不上传到服务端 — 只在本地做 staging 分桶。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '@server/utils/logger.js'

const log = createLogger('machine-id')

const CLIENT_ID_FILE = '.client-id'

export function getOrCreateStableClientId(dataDir: string): string {
  const filePath = path.join(dataDir, CLIENT_ID_FILE)

  try {
    if (fs.existsSync(filePath)) {
      const id = fs.readFileSync(filePath, 'utf-8').trim()
      if (id.length > 0) return id
    }
  } catch (err) {
    log.warn(`read client-id failed, regenerating: ${(err as Error).message}`)
  }

  const id = crypto.randomUUID()
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(filePath, id, { encoding: 'utf-8', mode: 0o600 })
  } catch (err) {
    log.error(`persist client-id failed: ${(err as Error).message}`)
  }
  return id
}
