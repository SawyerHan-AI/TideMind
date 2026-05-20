/**
 * 自动更新检查调度:启动 5 秒后首次 + 每 4 小时一次。
 *
 * 三条检查路径(启动/定时/手动)共享同一个 electron-updater 状态机 — scheduler
 * 只负责定时调用 checkFn,checkFn 内部会处理"已在下载中则跳过重复触发"。
 *
 * INITIAL_DELAY_MS 2026-05-20 从 30s 调到 5s:状态栏 UpdaterBadge 改造后,用户
 * 打开 APP 几秒就能用余光看到 "Checking…" chip(此前 30s 等待+无 UI 反馈,用户
 * 反馈"打开 APP 没看到自动检测")。main 进程其它初始化通常在 300ms 内完成,5s
 * 不会和启动期工作竞争资源。
 */

import { createLogger } from '@server/utils/logger.js'

const log = createLogger('updater-scheduler')

const INITIAL_DELAY_MS = 5_000
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
