/**
 * 自动更新检查调度:启动 30 秒后首次 + 每 4 小时一次。
 *
 * 三条检查路径(启动/定时/手动)共享同一个 electron-updater 状态机 — scheduler
 * 只负责定时调用 checkFn,checkFn 内部会处理"已在下载中则跳过重复触发"。
 */

import { createLogger } from '@server/utils/logger.js'

const log = createLogger('updater-scheduler')

const INITIAL_DELAY_MS = 30_000
const INTERVAL_MS = 4 * 60 * 60 * 1000

export function scheduleUpdateChecks(checkFn: () => Promise<void>): { stop: () => void } {
  let stopped = false

  const safeCheck = async (reason: string) => {
    if (stopped) return
    log.info(`triggering update check (${reason})`)
    try {
      await checkFn()
    } catch (err) {
      log.warn(`update check failed: ${(err as Error).message}`)
    }
  }

  const initialTimer = setTimeout(() => void safeCheck('startup'), INITIAL_DELAY_MS)
  const intervalTimer = setInterval(() => void safeCheck('periodic'), INTERVAL_MS)

  return {
    stop: () => {
      stopped = true
      clearTimeout(initialTimer)
      clearInterval(intervalTimer)
    },
  }
}
