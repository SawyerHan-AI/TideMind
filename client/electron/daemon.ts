/**
 * Electron 内嵌守护进程
 *
 * Electron main只负责代谢Worker的启动排序、状态桥接和退出；
 * scheduler timer与业务task全部运行在Worker Thread中。
 *
 * 使用 server 侧的 getDb() 单例（与 client 的 getClientDb() 独立，
 * 两者通过 WAL 模式安全共存）。
 */

import path from 'node:path'
import { loadConfig, ensureDataDirs, getConfig, getDataDir } from '@server/config.js'
import { getDb, closeDb, initVec } from '@server/db/connection.js'
import { CURRENT_SCHEMA_VERSION } from '@server/db/schema.js'
import { createLogger, enableFileLogging } from '@server/utils/logger.js'
import { logTimelineEvent } from '@server/db/log.js'
import {
  noteSuccessfulLLMCall,
  setLLMFailureHook,
  recordLLMFailureForHook,
  recordEmbeddingSuccess,
  recordEmbeddingFailure,
} from '@server/metabolism/scheduler.js'
import { MetabolismWorkerRuntimeRevisionAllocator } from '@server/metabolism/worker-runtime-snapshot.js'
import { setLLMSuccessHook } from '@server/llm/client.js'
import { setEmbeddingSuccessHook, setEmbeddingFailureHook } from '@server/llm/embedding.js'
import { setStructureHolesRunner } from '@server/graph/structure-holes.js'
import { reconcileCliRuntimeState } from '@server/llm/cli/invocation-state.js'
import { cleanupStaleCliRuntimeDirectories } from '@server/llm/cli/runtime-dir.js'
import { startAllNoteSources, stopAllNoteSourcesAsync } from '@server/integrations/shared/note-sources.js'
import { getActivityState } from './activity-state.js'
import {
  getSchedulerExecutionMode,
  type SchedulerExecutionMode,
} from './scheduler-execution-mode.js'
import { runStructureHolesInWorker, terminateStructureHolesWorker } from './workers/structure-holes-runner.js'
import { getMetabolismWorkerPath } from './runtime/runtime-paths.js'
import { MetabolismWorkerController } from './workers/metabolism-worker-controller.js'
import { MetabolismWorkerGenerationManager } from './workers/metabolism-worker-generation-manager.js'
import { createMetabolismWorkerStartupHandoffIssuer, type MetabolismWorkerStartupHandoffIssuer } from './workers/metabolism-worker-startup-handoff.js'
import {
  bindMetabolismWorkerRuntimeMutationRestart,
  watchMetabolismWorkerExternalRuntimeSources,
  type MetabolismWorkerExternalRuntimeSourceWatcher,
} from './workers/metabolism-worker-runtime-mutations.js'
import { waitForBackgroundWork } from '@server/utils/background-work.js'

const log = createLogger('daemon')

let running = false
let stopping = false
let unsubscribeActivity: (() => void) | null = null
let unsubscribeSchedulerMode: (() => void) | null = null
let lastSchedulerMode: SchedulerExecutionMode = 'background'
let lifecycleGeneration = 0
let startupPromise: Promise<void> | null = null
let workerManager: MetabolismWorkerGenerationManager | null = null
let workerHandoffIssuer: MetabolismWorkerStartupHandoffIssuer | null = null
let unbindRuntimeMutation: (() => void) | null = null
let runtimeSourceWatcher: MetabolismWorkerExternalRuntimeSourceWatcher | null = null
let workerDegradedReason: string | null = null
let noteSourcesOwned = false
let structureWorkerOwned = false
let activeSchedulerPasses = 0
let maxConcurrentSchedulerPasses = 0
let mainThreadSchedulerTaskExecutions = 0
let sqliteContentionEvents = 0

const ACTIVE_TICK_MS = 60 * 1000
const IDLE_TICK_MS = 10 * 60 * 1000

export function getMetabolismWorkerDegradedReason(): string | null {
  return workerDegradedReason
}

/** Read-only execution diagnostics used by packaged performance/activation gates. */
export function getMetabolismWorkerExecutionDiagnostics(): Readonly<{
  concurrentSchedulerPasses: number
  mainThreadSchedulerTaskExecutions: number
  sqliteContentionEvents: number
}> {
  return Object.freeze({
    concurrentSchedulerPasses: maxConcurrentSchedulerPasses,
    mainThreadSchedulerTaskExecutions,
    sqliteContentionEvents,
  })
}

function publishWorkerDegraded(db: ReturnType<typeof getDb>, reason: unknown, prefix: string): void {
  workerDegradedReason = reason instanceof Error ? reason.message : String(reason)
  log.error(`${prefix}: ${workerDegradedReason}`)
  void import('./ipc/llm-health.js')
    .then(module => module.broadcastLLMHealth(db))
    .catch(error => log.warn(`Worker降级状态广播失败: ${(error as Error).message}`))
}

export function startDaemon(): Promise<void> {
  if (startupPromise) return startupPromise
  if (running || stopping) return Promise.resolve()
  const generation = ++lifecycleGeneration
  activeSchedulerPasses = 0
  maxConcurrentSchedulerPasses = 0
  mainThreadSchedulerTaskExecutions = 0
  sqliteContentionEvents = 0
  running = true
  stopping = false
  const current = startDaemonInternal(generation)
    .catch(err => {
      if (lifecycleGeneration === generation) running = false
      throw err
    })
    .finally(() => {
      if (startupPromise === current) startupPromise = null
    })
  startupPromise = current
  return current
}

async function startDaemonInternal(generation: number): Promise<void> {
  try {
  // 初始化 server 侧的 config 和 DB（与 client 的 getClientDb 独立）
  loadConfig()
  ensureDataDirs()
  cleanupStaleCliRuntimeDirectories(getDataDir(), { olderThanMs: 24 * 60 * 60 * 1000 })

  // 启用文件日志
  enableFileLogging(path.join(getDataDir(), 'logs'))
  const db = getDb()
  // Never run synchronous checkpoint I/O from an Electron main timer. The
  // Worker owns frequent PASSIVE maintenance while healthy; this high fallback
  // keeps WAL bounded when it is degraded without adding another main task.
  db.pragma('wal_autocheckpoint = 10000')
  const vecCapability = await initVec()
  if (stopping || lifecycleGeneration !== generation) return

  // 注入健康度 hook(2026-05-21 v0.2.74,修 backlog C.H2)。
  // 关键:CLI daemon(src/daemon.ts)早已注入这套 hook,但 Electron daemon 一直漏了 →
  // 桌面端(主要用户群)callLLM 的 notifyLLMSuccess() 是空 hook,llm_last_success_at
  // 永不写,pending-link-gc 健康度 gate 永远拒绝放行,熔断器 half-open→closed 自愈
  // transition 在桌面端也不跑。必须在首次Worker scheduler pass之前设上。
  // hook 内部都有 try/catch 兜底,失败不影响 LLM/embedding 调用主流程。
  const dbForHook = getDb()
  const reconciliation = reconcileCliRuntimeState(dbForHook)
  if (reconciliation.definiteFailures.length > 0 || reconciliation.ambiguousInvocations.length > 0) {
    log.warn(
      `CLI runtime 冷启动恢复: definite_failures=${reconciliation.definiteFailures.length}, ` +
      `ambiguous_invocations=${reconciliation.ambiguousInvocations.length}`,
    )
  }
  setLLMSuccessHook(() => noteSuccessfulLLMCall(dbForHook))
  setLLMFailureHook(err => recordLLMFailureForHook(dbForHook, err.message))
  setEmbeddingSuccessHook(() => recordEmbeddingSuccess(dbForHook))
  setEmbeddingFailureHook(err => recordEmbeddingFailure(dbForHook, err.message))

  // 注入 structure-holes 计算 runner(2026-05-21 v0.2.74 CRITICAL #1)。
  // 把 O(E²/V) 同步 SQL(实测 107s)搬到 worker thread,避免冻死主线程/UI。
  // CLI daemon 不注入(无 UI),保持内联同步。
  setStructureHolesRunner(db => runStructureHolesInWorker(db))
  structureWorkerOwned = true

  // 启动所有已配置的笔记源
  try {
    noteSourcesOwned = true
    await startAllNoteSources(getDb())
  } catch (error) {
    log.error('笔记源启动失败:', (error as Error).message)
  }
  if (stopping || lifecycleGeneration !== generation) {
    await stopAllNoteSourcesAsync()
    return
  }

  const schedulerMode = getSchedulerExecutionMode()
  lastSchedulerMode = schedulerMode.getMode()
  const runtimeRevisions = new MetabolismWorkerRuntimeRevisionAllocator()
  const handoffIssuer = createMetabolismWorkerStartupHandoffIssuer({
    db,
    dataDir: getDataDir(),
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    controllerGeneration: generation,
    vecCapability,
  })
  workerHandoffIssuer = handoffIssuer
  const manager = new MetabolismWorkerGenerationManager({
    buildBootstrap: async workerGeneration => handoffIssuer.build(
      getConfig(),
      workerGeneration,
      runtimeRevisions.allocate(),
    ),
    createController: () => new MetabolismWorkerController({
      workerPath: getMetabolismWorkerPath(),
      structureHolesHandler: async () => runStructureHolesInWorker(db),
    }),
    initialMode: lastSchedulerMode,
    initialCadence: getActivityState().getState(),
  })
  workerManager = manager
  workerDegradedReason = null
  manager.on('message', message => {
    if (message.kind === 'scheduler_pass_started') {
      activeSchedulerPasses += 1
      maxConcurrentSchedulerPasses = Math.max(maxConcurrentSchedulerPasses, activeSchedulerPasses)
      if (message.executionThreadId === 0) mainThreadSchedulerTaskExecutions += 1
    } else if (message.kind === 'scheduler_pass_finished') {
      activeSchedulerPasses = Math.max(0, activeSchedulerPasses - 1)
    } else if (message.kind === 'scheduler_sqlite_contention') {
      sqliteContentionEvents += 1
    }
    if (message.kind === 'runtime_snapshot_invalidated') {
      try {
        runtimeSourceWatcher?.acknowledgeCurrent()
      } catch (error) {
        publishWorkerDegraded(db, error, '代谢Worker runtime source确认失败')
      }
    }
    void import('./ipc/llm-health.js')
      .then(module => module.applyMetabolismWorkerStatusMessage(db, message))
      .catch(error => log.warn(`Worker状态桥接失败: ${(error as Error).message}`))
  })
  manager.on('clear-generation-tasks', workerGeneration => {
    void import('./ipc/llm-health.js')
      .then(module => module.clearMetabolismWorkerGenerationStatus(db, workerGeneration as number))
      .catch(error => log.warn(`Worker任务镜像清理失败: ${(error as Error).message}`))
  })
  manager.on('degraded', reason => {
    publishWorkerDegraded(db, reason, '代谢Worker不可用，已停止后台调度且不会回退main')
  })
  unbindRuntimeMutation = bindMetabolismWorkerRuntimeMutationRestart(
    async () => {
      runtimeSourceWatcher?.acknowledgeCurrent()
      await manager.requestRestart()
    },
    error => {
      publishWorkerDegraded(db, error, '代谢Worker runtime重建失败')
    },
  )
  runtimeSourceWatcher = watchMetabolismWorkerExternalRuntimeSources(getDataDir(), () => {
    void manager.requestRestart().catch(error => {
      publishWorkerDegraded(db, error, '代谢Worker外部runtime source换代失败')
    })
  })
  await manager.start()
  if (stopping || lifecycleGeneration !== generation) {
    await manager.shutdown()
    handoffIssuer.invalidate()
    return
  }

  unsubscribeActivity = getActivityState().onChange((state) => {
    if (state === 'active' && schedulerMode.getMode() !== 'paused') {
      manager.trigger('resume')
    }
    manager.setScheduleContext(schedulerMode.getMode(), state)
  })
  unsubscribeSchedulerMode = schedulerMode.onChange((mode) => {
    const previous = lastSchedulerMode
    lastSchedulerMode = mode
    manager.setScheduleContext(mode, getActivityState().getState())
    if (previous === 'paused' && mode !== 'paused' && running && !stopping) manager.trigger('resume')
  })

  logTimelineEvent(getDb(), {
    type: 'memory',
    subtype: 'daemon_start',
    title: JSON.stringify({ key: 'daemon_start' }),
    detail: { runtime: 'worker_thread', tick_interval_s: ACTIVE_TICK_MS / 1000 },
    actor: 'brain',
  })

  log.info(`守护进程已启动。scheduler=Worker Thread，active=${ACTIVE_TICK_MS / 1000}s / idle=${IDLE_TICK_MS / 1000}s tick。`)
  } catch (error) {
    unbindRuntimeMutation?.()
    unbindRuntimeMutation = null
    runtimeSourceWatcher?.close()
    runtimeSourceWatcher = null
    unsubscribeActivity?.()
    unsubscribeActivity = null
    unsubscribeSchedulerMode?.()
    unsubscribeSchedulerMode = null
    const manager = workerManager
    let workerExitConfirmed = manager === null
    if (manager) {
      try {
        await manager.shutdown()
        workerExitConfirmed = true
        if (workerManager === manager) workerManager = null
      } catch (cleanupError) {
        log.error(`代谢Worker启动回滚未能确认线程退出: ${(cleanupError as Error).message}`)
      }
    }
    workerHandoffIssuer?.invalidate()
    workerHandoffIssuer = null
    setLLMSuccessHook(null)
    setLLMFailureHook(null)
    setEmbeddingSuccessHook(null)
    setEmbeddingFailureHook(null)
    setStructureHolesRunner(null)
    let structureExitConfirmed = !structureWorkerOwned
    try {
      await terminateStructureHolesWorker()
      structureWorkerOwned = false
      structureExitConfirmed = true
    } catch (cleanupError) {
      log.error(`structure Worker启动回滚失败: ${(cleanupError as Error).message}`)
    }
    let noteDrainConfirmed = !noteSourcesOwned
    try {
      await stopAllNoteSourcesAsync()
      noteSourcesOwned = false
      noteDrainConfirmed = true
    } catch (cleanupError) {
      log.error(`笔记源启动回滚失败: ${(cleanupError as Error).message}`)
    }
    if (workerExitConfirmed && structureExitConfirmed && noteDrainConfirmed) closeDb()
    throw error
  }
}

/**
 * 立即触发一次 scheduler tick (绕过 60s/600s 周期等待)。
 *
 * 用户在 UI 上点「立即重试」时调用。如果 tick 正在跑则跳过(避免并发),否则
 * fire-and-forget 跑一次 tick——熔断器已被 resetCircuitBreaker 清掉,LLM 任务
 * 会立即重试。
 *
 * Worker controller会合并在途trigger，避免并发scheduler pass。
 */
export async function triggerImmediateSchedulerTick(): Promise<void> {
  if (!running) {
    log.warn('triggerImmediateSchedulerTick 调用但 daemon 未启动,忽略')
    return
  }
  if (!workerManager) {
    log.warn('triggerImmediateSchedulerTick 调用但Worker尚未ready,忽略')
    return
  }
  workerManager.trigger('immediate')
}

/** Rebuild Worker-local SDK/CLI caches before an operator-requested retry. */
export async function restartMetabolismWorkerAndTriggerImmediate(): Promise<void> {
  if (!running || !workerManager) throw new Error('metabolism Worker is not ready')
  await workerManager.requestRestart()
  workerManager.trigger('immediate')
}

export async function stopDaemon(): Promise<void> {
  if (
    !running
    && !startupPromise
    && !workerManager
    && !workerHandoffIssuer
    && !runtimeSourceWatcher
    && !unbindRuntimeMutation
    && !noteSourcesOwned
    && !structureWorkerOwned
  ) return
  stopping = true
  lifecycleGeneration++
  if (unbindRuntimeMutation) {
    unbindRuntimeMutation()
    unbindRuntimeMutation = null
  }
  runtimeSourceWatcher?.close()
  runtimeSourceWatcher = null
  if (unsubscribeActivity) {
    unsubscribeActivity()
    unsubscribeActivity = null
  }
  if (unsubscribeSchedulerMode) {
    unsubscribeSchedulerMode()
    unsubscribeSchedulerMode = null
  }

  // 摘掉main isolate健康度hook；Worker isolate由generation manager在自己的shutdown中清理。
  // 防 shutdown race:closeDb() 之后若 hook 仍被 in-flight 的 LLM/embedding 回调触发,
  // 会访问已关闭的 DB。worker 强杀避免线程泄漏(worker 自己开的连接由它自己 close)。
  setLLMSuccessHook(null)
  setLLMFailureHook(null)
  setEmbeddingSuccessHook(null)
  setEmbeddingFailureHook(null)

  // 等待已进入 initVec/startAllNoteSources 的在途启动观察 generation 失效并退出。
  // 它未完成前绝不能 closeDb，否则旧启动会在关库后继续安装hook/watcher/Worker。
  const pendingStartup = startupPromise
  if (pendingStartup) {
    try {
      await pendingStartup
    } catch (err) {
      log.warn(`daemon startup failed while shutdown was waiting: ${(err as Error).message}`)
    }
  }

  const manager = workerManager
  if (manager) {
    await manager.shutdown()
    workerManager = null
  }
  workerHandoffIssuer?.invalidate()
  workerHandoffIssuer = null
  setStructureHolesRunner(null)
  await terminateStructureHolesWorker()
  structureWorkerOwned = false
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

  // H-shutdown 修复(第三轮审计):await logseq watcher 在途串行链 drain(processOneFile 跑完 setFileState/
  // finally 退休 createdThisRun)再 closeDb,否则在途节点撞已关闭的 db、退休失败 → 残留活跃孤儿。
  // 原 `stopAllNoteSources()`(同步 fire-and-forget)+ 立即 closeDb 让 drain 在微任务里撞已关 db,
  // 修复 2B 的 async drain 在桌面端这条路径上完全失效。超时/拒绝必须使本次
  // 退出失败并保留 DB；否则 watcher 仍可能在 closeDb 后写入。
  let drainTimeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      stopAllNoteSourcesAsync(),
      new Promise<never>((_, reject) => {
        drainTimeout = setTimeout(
          () => reject(new Error('note source shutdown timed out after 10s')),
          10_000,
        )
      }),
    ])
    noteSourcesOwned = false
  } catch (error) {
    stopping = false
    throw error
  } finally {
    if (drainTimeout) clearTimeout(drainTimeout)
  }
  await waitForBackgroundWork()
  closeDb()
  running = false
  stopping = false
  workerDegradedReason = null
  log.info('守护进程已停止')
}
