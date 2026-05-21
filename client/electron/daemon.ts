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
import {
  runSchedulerTick,
  noteSuccessfulLLMCall,
  setLLMFailureHook,
  recordLLMFailureForHook,
  recordEmbeddingSuccess,
  recordEmbeddingFailure,
} from '@server/metabolism/scheduler.js'
import { ALL_TASKS } from '@server/metabolism/tasks.js'
import { setLLMSuccessHook } from '@server/llm/client.js'
import { setEmbeddingSuccessHook, setEmbeddingFailureHook } from '@server/llm/embedding.js'
import { setStructureHolesRunner } from '@server/graph/structure-holes.js'
import { stopLogseqIntegration } from '@server/integrations/logseq/index.js'
import { startAllNoteSources, stopAllNoteSources } from '@server/integrations/shared/note-sources.js'
import { getActivityState } from './activity-state.js'
import { runStructureHolesInWorker, terminateStructureHolesWorker } from './workers/structure-holes-runner.js'

const log = createLogger('daemon')

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let tickPromise: Promise<unknown> | null = null
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

  // 注入健康度 hook(2026-05-21 v0.2.74,修 backlog C.H2)。
  // 关键:CLI daemon(src/daemon.ts)早已注入这套 hook,但 Electron daemon 一直漏了 →
  // 桌面端(主要用户群)callLLM 的 notifyLLMSuccess() 是空 hook,llm_last_success_at
  // 永不写,pending-link-gc 健康度 gate 永远拒绝放行,熔断器 half-open→closed 自愈
  // transition 在桌面端也不跑。必须在首次 runSchedulerTick 之前设上。
  // hook 内部都有 try/catch 兜底,失败不影响 LLM/embedding 调用主流程。
  const dbForHook = getDb()
  setLLMSuccessHook(() => noteSuccessfulLLMCall(dbForHook))
  setLLMFailureHook(err => recordLLMFailureForHook(dbForHook, err.message))
  setEmbeddingSuccessHook(() => recordEmbeddingSuccess(dbForHook))
  setEmbeddingFailureHook(err => recordEmbeddingFailure(dbForHook, err.message))

  // 注入 structure-holes 计算 runner(2026-05-21 v0.2.74 CRITICAL #1)。
  // 把 O(E²/V) 同步 SQL(实测 107s)搬到 worker thread,避免冻死主线程/UI。
  // CLI daemon 不注入(无 UI),保持内联同步。
  setStructureHolesRunner(db => runStructureHolesInWorker(db))

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
    if (tickPromise) return
    tickPromise = runSchedulerTick(getDb(), ALL_TASKS)
      .catch(err => log.error('调度 tick 失败:', (err as Error).message))
      .finally(() => { tickPromise = null })
  }, interval)
}

/**
 * 立即触发一次 scheduler tick (绕过 60s/600s 周期等待)。
 *
 * 用户在 UI 上点「立即重试」时调用。如果 tick 正在跑则跳过(避免并发),否则
 * fire-and-forget 跑一次 tick——熔断器已被 resetCircuitBreaker 清掉,LLM 任务
 * 会立即重试。
 *
 * 注意:复用 setInterval 里的 tickPromise 模式(同样的 await Promise.race + finally),
 * 让 stopDaemon 能 await in-flight tick 完成,避免 race。
 */
export async function triggerImmediateSchedulerTick(): Promise<void> {
  if (!running) {
    log.warn('triggerImmediateSchedulerTick 调用但 daemon 未启动,忽略')
    return
  }
  if (tickPromise) {
    log.info('triggerImmediateSchedulerTick 调用但已有 tick 在跑,跳过')
    return
  }
  tickPromise = runSchedulerTick(getDb(), ALL_TASKS)
    .catch(err => log.error('立即 tick 失败:', (err as Error).message))
    .finally(() => { tickPromise = null })
  await tickPromise
}

export async function stopDaemon(): Promise<void> {
  if (!running) return
  if (unsubscribeActivity) {
    unsubscribeActivity()
    unsubscribeActivity = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  // 摘掉健康度 hook + structure-holes runner,并强杀在跑的 worker(v0.2.74)。
  // 防 shutdown race:closeDb() 之后若 hook 仍被 in-flight 的 LLM/embedding 回调触发,
  // 会访问已关闭的 DB。worker 强杀避免线程泄漏(worker 自己开的连接由它自己 close)。
  setLLMSuccessHook(null)
  setLLMFailureHook(null)
  setEmbeddingSuccessHook(null)
  setEmbeddingFailureHook(null)
  setStructureHolesRunner(null)
  terminateStructureHolesWorker()

  // 等已 fire 的 in-flight tick 跑完(最多 5s),避免 close DB 后 tick 还在访问。
  if (tickPromise) {
    await Promise.race([
      tickPromise,
      new Promise(resolve => setTimeout(resolve, 5000)),
    ])
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
