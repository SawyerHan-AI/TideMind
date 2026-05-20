/**
 * Electron 内嵌守护进程
 *
 * 将代谢任务的定时调度集成到 Electron main process 中，
 * 应用启动时自动运行，退出时自动停止。
 *
 * 使用 server 侧的 getDb() 单例（与 client 的 getClientDb() 独立，
 * 两者通过 WAL 模式安全共存）。
 */

import path from 'node:path'
import { loadConfig, ensureDataDirs, getDataDir } from '@server/config.js'
import { getDb, closeDb, initVec } from '@server/db/connection.js'
import { createLogger, enableFileLogging } from '@server/utils/logger.js'
import { logTimelineEvent } from '@server/db/log.js'
import { runSchedulerTick } from '@server/metabolism/scheduler.js'
import { ALL_TASKS } from '@server/metabolism/tasks.js'
import { stopLogseqIntegration } from '@server/integrations/logseq/index.js'
import { startAllNoteSources, stopAllNoteSources } from '@server/integrations/shared/note-sources.js'
import { getActivityState } from './activity-state.js'

const log = createLogger('daemon')

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let tickRunning = false
let unsubscribeActivity: (() => void) | null = null

const ACTIVE_TICK_MS = 60 * 1000   // 每分钟检查一次(用户在用)
const IDLE_TICK_MS = 10 * 60 * 1000 // 每 10 分钟(用户走了,scheduler 不需要那么积极)

export async function startDaemon(): Promise<void> {
  if (running) return
  running = true

  // 初始化 server 侧的 config 和 DB（与 client 的 getClientDb 独立）
  loadConfig()
  ensureDataDirs()

  // 启用文件日志
  enableFileLogging(path.join(getDataDir(), 'logs'))
  getDb()
  await initVec()

  // 启动所有已配置的笔记源
  startAllNoteSources(getDb()).catch(err =>
    log.error('笔记源启动失败:', (err as Error).message))

  // 启动时立刻执行一轮
  runSchedulerTick(getDb(), ALL_TASKS).catch(err =>
    log.error('初始调度失败:', (err as Error).message))

  // 跟随 activity-state 切 tick 频率:active 60s, idle 10min。
  // idle 时仍保留 tick(远程调度需要 progress),只是不需要那么积极。
  // active 时立即跑一次,把 idle 期间积累的逾期任务推进。
  startTick(getActivityState().getState())
  unsubscribeActivity = getActivityState().onChange((state) => {
    if (state === 'active') {
      runSchedulerTick(getDb(), ALL_TASKS)
        .catch(err => log.error('resume 调度失败:', (err as Error).message))
    }
    startTick(state)
  })

  logTimelineEvent(getDb(), {
    type: 'memory',
    subtype: 'daemon_start',
    title: JSON.stringify({ key: 'daemon_start' }),
    detail: { task_count: ALL_TASKS.length, tick_interval_s: ACTIVE_TICK_MS / 1000 },
    actor: 'brain',
  })

  log.info(`守护进程已启动。active=${ACTIVE_TICK_MS / 1000}s / idle=${IDLE_TICK_MS / 1000}s tick，共 ${ALL_TASKS.length} 个任务独立调度。`)
}

function startTick(state: 'active' | 'idle'): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  const interval = state === 'active' ? ACTIVE_TICK_MS : IDLE_TICK_MS
  timer = setInterval(() => {
    if (tickRunning) return
    tickRunning = true
    runSchedulerTick(getDb(), ALL_TASKS)
      .catch(err => log.error('调度 tick 失败:', (err as Error).message))
      .finally(() => { tickRunning = false })
  }, interval)
}

export function stopDaemon(): void {
  if (!running) return
  if (unsubscribeActivity) {
    unsubscribeActivity()
    unsubscribeActivity = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  try {
    logTimelineEvent(getDb(), {
      type: 'memory',
      subtype: 'daemon_stop',
      title: JSON.stringify({ key: 'daemon_stop' }),
      actor: 'brain',
    })
  } catch (err) {
    log.warn(`could not log daemon_stop event (DB may not be initialized): ${(err as Error).message}`)
  }

  stopAllNoteSources()
  closeDb()
  running = false
  log.info('守护进程已停止')
}
