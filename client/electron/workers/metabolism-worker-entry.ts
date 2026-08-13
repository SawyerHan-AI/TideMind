import { parentPort, threadId, workerData } from 'node:worker_threads'
import {
  sanitizeMetabolismWorkerError,
  snapshotMainToMetabolismWorkerMessage,
  snapshotMetabolismWorkerBootstrap,
  type MainToMetabolismWorkerMessage,
  type MetabolismWorkerBootstrapV1,
} from './metabolism-worker-protocol.js'

let bootstrap: MetabolismWorkerBootstrapV1
try {
  bootstrap = snapshotMetabolismWorkerBootstrap(workerData)
} catch (error) {
  parentPort?.postMessage({
    protocolVersion: 1,
    lifecycleGeneration: Number.isSafeInteger((workerData as { lifecycleGeneration?: unknown } | null)?.lifecycleGeneration)
      ? (workerData as { lifecycleGeneration: number }).lifecycleGeneration
      : 1,
    kind: 'fatal',
    error: sanitizeMetabolismWorkerError(error, 'bootstrap_contract'),
  })
  parentPort?.close()
  throw error
}

if (!parentPort) throw new Error('metabolism worker requires parentPort')

let scheduleContext: Extract<MainToMetabolismWorkerMessage, { kind: 'set_schedule_context' }> | null = null
let opened: Awaited<ReturnType<typeof import('../../../src/db/worker-initialized-database.js')['openInitializedDatabase']>> | null = null
let runtimeCleanup: (() => Promise<void>) | null = null
let runtimeAbort: (() => Promise<void>) | null = null
let ready = false
let stopping = false
let stopReason: 'restart' | 'shutdown' | null = null
let stopPromise: Promise<void> | null = null
let runtimeAbortPromise: Promise<void> | null = null
let pendingTrigger = false
let activeLlmTaskId: string | null = null
let tickPromise: Promise<void> | null = null
let scheduleTimer: ReturnType<typeof setInterval> | null = null
let runScheduler: (() => Promise<void>) | null = null
let runtimeSnapshotInvalidated = false
let bootPromise: Promise<void> | null = null
let structureRpcSequence = 0
const structureRpc = new Map<string, { resolve: (holes: unknown[]) => void; reject: (error: Error) => void }>()

const ACTIVE_TICK_MS = 60_000
const IDLE_TICK_MS = 10 * 60_000

function post(message: Record<string, unknown>): void {
  parentPort!.postMessage({ protocolVersion: 1, lifecycleGeneration: bootstrap.lifecycleGeneration, ...message })
}

async function abortRuntimeOnce(): Promise<void> {
  if (!runtimeAbort) return
  if (!runtimeAbortPromise) runtimeAbortPromise = runtimeAbort()
  await runtimeAbortPromise
}

function kickRuntimeAbort(): void {
  if (!runtimeAbort || runtimeAbortPromise) return
  runtimeAbortPromise = runtimeAbort()
  // The stop runner below awaits this same promise and owns the fatal envelope.
  // Attach an immediate rejection observer so the early kick is never detached.
  void runtimeAbortPromise.catch(() => undefined)
}

function stop(reason: 'restart' | 'shutdown'): Promise<void> {
  if (reason === 'shutdown') stopReason = 'shutdown'
  else if (!stopReason) stopReason = 'restart'
  if (reason === 'shutdown') kickRuntimeAbort()
  if (stopPromise) return stopPromise
  stopping = true
  pendingTrigger = false
  if (scheduleTimer) clearInterval(scheduleTimer)
  scheduleTimer = null
  stopPromise = (async () => {
    if (bootPromise) await bootPromise
    if (stopReason === 'shutdown') await abortRuntimeOnce()
    if (tickPromise) await tickPromise
    if (runtimeCleanup) await runtimeCleanup()
    runtimeAbort = null
    runtimeCleanup = null
    opened?.close()
    opened = null
    post({ kind: 'stopped', reason: stopReason ?? reason })
    setImmediate(() => parentPort!.close())
  })().catch(async error => {
    process.exitCode = 1
    // Abort failure means provider teardown is not proven complete. Preserve
    // the normal shutdown ordering: never clear hooks/context or close SQLite
    // while the active scheduler task may still run. If it cannot settle, the
    // controller deadline owns forced thread termination.
    try { if (tickPromise) await tickPromise } catch { /* preserve shutdown failure */ }
    try { if (runtimeCleanup) await runtimeCleanup() } catch { /* preserve shutdown failure */ }
    runtimeAbort = null
    runtimeCleanup = null
    try { opened?.close() } catch { /* preserve shutdown failure */ }
    opened = null
    post({ kind: 'fatal', error: sanitizeMetabolismWorkerError(error, 'shutdown') })
    setImmediate(() => parentPort!.close())
  })
  return stopPromise
}

function handleMessage(value: unknown): void {
  let message: MainToMetabolismWorkerMessage
  try {
    message = snapshotMainToMetabolismWorkerMessage(value)
  } catch {
    return
  }
  if (message.lifecycleGeneration !== bootstrap.lifecycleGeneration) return
  if (stopping) {
    if (message.kind === 'shutdown') void stop('shutdown')
    if (message.kind !== 'structure_holes_result' && message.kind !== 'structure_holes_failed') return
  }
  switch (message.kind) {
    case 'set_schedule_context':
      if (!scheduleContext || message.revision > scheduleContext.revision) {
        const previous = scheduleContext
        scheduleContext = message
        if (ready) updateScheduleTimer(previous)
      }
      break
    case 'trigger':
      pendingTrigger = scheduleContext?.mode !== 'paused'
      if (ready && pendingTrigger) void requestRun()
      break
    case 'drain_for_restart':
      void stop('restart')
      break
    case 'shutdown':
      void stop('shutdown')
      break
    case 'structure_holes_result': {
      const pending = structureRpc.get(message.requestId)
      if (!pending) break
      structureRpc.delete(message.requestId)
      pending.resolve([...message.holes])
      break
    }
    case 'structure_holes_failed': {
      const pending = structureRpc.get(message.requestId)
      if (!pending) break
      structureRpc.delete(message.requestId)
      pending.reject(new Error(`structure holes ${message.errorKind}`))
      break
    }
  }
}

function updateScheduleTimer(previous: typeof scheduleContext): void {
  if (!scheduleContext) return
  if (scheduleContext.mode === 'paused') {
    if (scheduleTimer) clearInterval(scheduleTimer)
    scheduleTimer = null
    pendingTrigger = false
    return
  }
  const shouldRestart = !scheduleTimer || previous?.mode === 'paused' || previous?.cadence !== scheduleContext.cadence
  if (!shouldRestart) return
  if (scheduleTimer) clearInterval(scheduleTimer)
  const interval = scheduleContext.cadence === 'active' ? ACTIVE_TICK_MS : IDLE_TICK_MS
  scheduleTimer = setInterval(() => {
    pendingTrigger = true
    void requestRun()
  }, interval)
}

async function requestRun(): Promise<void> {
  if (!ready || stopping || scheduleContext?.mode === 'paused' || !runScheduler) return
  if (tickPromise) {
    pendingTrigger = true
    return tickPromise
  }
  pendingTrigger = false
  const current = runScheduler().catch(async error => {
    post({ kind: 'fatal', error: sanitizeMetabolismWorkerError(error, 'scheduler') })
    process.exitCode = 1
    stopping = true
    if (scheduleTimer) clearInterval(scheduleTimer)
    scheduleTimer = null
    try { if (runtimeCleanup) await runtimeCleanup() } catch { /* fatal path */ }
    runtimeCleanup = null
    try { opened?.close() } catch { /* fatal path */ }
    opened = null
    setImmediate(() => parentPort!.close())
  }).finally(() => {
    if (tickPromise === current) tickPromise = null
    if (pendingTrigger && !stopping && scheduleContext?.mode !== 'paused') void requestRun()
    else if (!stopping) post({ kind: 'idle' })
  })
  tickPromise = current
  return current
}

parentPort.on('message', handleMessage)

async function boot(): Promise<void> {
  try {
    const { openInitializedDatabase } = await import('../../../src/db/worker-initialized-database.js')
    opened = await openInitializedDatabase({
      startupAuthority: bootstrap.startupAuthority,
      expectedSchemaVersion: bootstrap.expectedSchemaVersion,
      databaseIdentity: bootstrap.databaseIdentity,
      authorizedDataDir: bootstrap.authorizedRoots.dataDir,
      vecCapability: bootstrap.vecCapability,
      busyTimeoutMs: 1_000,
    })
    const runtimeContext = await import('../../../src/metabolism/worker-runtime-context.js')
    const runtimeSources = await import('./metabolism-worker-runtime-mutations.js')
    let externalRuntimeFingerprint = runtimeSources.fingerprintMetabolismWorkerExternalRuntimeSources(bootstrap.authorizedRoots.dataDir)
    if (externalRuntimeFingerprint !== bootstrap.externalRuntimeSourceFingerprint) {
      throw new Error('external runtime sources changed after bootstrap snapshot')
    }
    const observeLearningRuntimeMutation = (): void => {
      // observer异常按scheduler通用合同会被隔离，因此先保守关闭本pass admission。
      // strict fingerprint成功且未变化时才重新放行；读取失败则请求换代，由main
      // strict snapshot builder决定进入新代还是session degraded。
      runtimeSnapshotInvalidated = true
      try {
        const currentFingerprint = runtimeSources.fingerprintMetabolismWorkerExternalRuntimeSources(bootstrap.authorizedRoots.dataDir)
        if (currentFingerprint === externalRuntimeFingerprint) {
          runtimeSnapshotInvalidated = false
          return
        }
        externalRuntimeFingerprint = currentFingerprint
        post({ kind: 'runtime_snapshot_invalidated', changeKind: 'strategy', sourceFingerprint: currentFingerprint })
      } catch {
        post({ kind: 'runtime_snapshot_invalidated', changeKind: 'strategy', sourceFingerprint: externalRuntimeFingerprint })
      }
    }
    runtimeContext.installMetabolismWorkerRuntimeContext({
      runtimeRevision: bootstrap.runtimeRevision,
      config: bootstrap.runtimeConfigSnapshot,
      connectionSnapshot: bootstrap.runtimeConnectionSnapshot,
      strategySnapshot: bootstrap.strategySnapshot,
      credentials: bootstrap.credentialSnapshot,
      dataDir: bootstrap.authorizedRoots.dataDir,
    })
    // Establish rollback immediately after the first isolate-local mutation;
    // later bootstrap imports/hook installation must not leak this context.
    runtimeCleanup = async () => runtimeContext.clearMetabolismWorkerRuntimeContext()
    const scheduler = await import('../../../src/metabolism/scheduler.js')
    const tasks = await import('../../../src/metabolism/tasks.js')
    const structureHoles = await import('../../../src/graph/structure-holes.js')
    const llmClient = await import('../../../src/llm/client.js')
    const embedding = await import('../../../src/llm/embedding.js')
    const invocation = await import('../../../src/llm/invocation-context.js')
    const connectionHealth = await import('../../../src/llm/connection-health.js')
    const db = opened.db
    llmClient.setLLMSuccessHook(() => { scheduler.noteSuccessfulLLMCall(db); post({ kind: 'health_changed', scope: 'llm' }) })
    scheduler.setLLMFailureHook(error => { scheduler.recordLLMFailureForHook(db, error.message); post({ kind: 'health_changed', scope: 'llm' }) })
    scheduler.setHealthChangeListener(() => post({ kind: 'health_changed', scope: 'llm' }))
    embedding.setEmbeddingSuccessHook(() => { scheduler.recordEmbeddingSuccess(db); post({ kind: 'health_changed', scope: 'embedding' }) })
    embedding.setEmbeddingFailureHook(error => { scheduler.recordEmbeddingFailure(db, error.message); post({ kind: 'health_changed', scope: 'embedding' }) })
    connectionHealth.setConnectionHealthChangeListener(() => post({ kind: 'health_changed', scope: 'llm' }))
    invocation.setActiveLLMTaskListener(task => {
      if (task) {
        activeLlmTaskId = task.taskId
        post({
          kind: 'active_llm_task_started',
          taskId: task.taskId,
          origin: 'scheduler-worker',
          purpose: 'llm',
          tier: task.tier,
          connectionId: task.connectionId,
        })
      } else if (activeLlmTaskId) {
        post({ kind: 'active_llm_task_cleared', taskId: activeLlmTaskId, origin: 'scheduler-worker', purpose: 'llm' })
        activeLlmTaskId = null
      }
    })
    structureHoles.setStructureHolesRunner(() => new Promise<import('../../../src/graph/structure-holes.js').StructureHole[]>((resolve, reject) => {
      const requestId = `g${bootstrap.lifecycleGeneration}-structure-${++structureRpcSequence}`
      structureRpc.set(requestId, { resolve: holes => resolve(holes as import('../../../src/graph/structure-holes.js').StructureHole[]), reject })
      post({ kind: 'structure_holes_request', requestId })
    }))
    runScheduler = async () => {
      await scheduler.runSchedulerTick(db, tasks.ALL_TASKS, {
        continueAfterAttempt: () => !stopping && !runtimeSnapshotInvalidated && scheduleContext?.mode === 'background',
        yieldAfterAttempt: () => new Promise(resolve => setImmediate(resolve)),
        observer: event => {
          if (event.type === 'tick_started') post({ kind: 'scheduler_pass_started', executionThreadId: threadId })
          if (event.type === 'tick_finished') post({ kind: 'scheduler_pass_finished', executionThreadId: threadId })
          if (event.type === 'sqlite_contention') post({ kind: 'scheduler_sqlite_contention', reason: event.reason })
          if (event.type === 'task_started') post({ kind: 'task_started', taskId: event.taskId })
          if (event.type === 'task_finished') {
            post({ kind: 'task_finished', taskId: event.taskId })
            if (event.taskId === 'learning2') observeLearningRuntimeMutation()
          }
          if (event.type === 'task_failed') {
            post({ kind: 'task_failed', taskId: event.taskId, error: { code: 'TASK_FAILED', phase: event.errorKind, retryable: false } })
            if (event.taskId === 'learning2') observeLearningRuntimeMutation()
          }
        },
      })
    }
    runtimeCleanup = async () => {
      structureHoles.setStructureHolesRunner(null)
      invocation.setActiveLLMTaskListener(null)
      connectionHealth.setConnectionHealthChangeListener(null)
      scheduler.setHealthChangeListener(null)
      llmClient.setLLMSuccessHook(null)
      scheduler.setLLMFailureHook(null)
      embedding.setEmbeddingSuccessHook(null)
      embedding.setEmbeddingFailureHook(null)
      await llmClient.shutdownLLMClient()
      runtimeContext.clearMetabolismWorkerRuntimeContext()
    }
    runtimeAbort = async () => {
      for (const pending of structureRpc.values()) pending.reject(new Error('metabolism Worker stopping'))
      structureRpc.clear()
      await llmClient.shutdownLLMClient()
    }
    while (!scheduleContext && !stopping) await new Promise(resolve => setImmediate(resolve))
    if (stopping) return
    ready = true
    updateScheduleTimer(null)
    post({
      kind: 'ready',
      runtimeRevision: bootstrap.runtimeRevision,
      databaseIdentityCommitment: bootstrap.databaseIdentity.identityCommitment,
      vecCapability: bootstrap.vecCapability,
    })
    if (pendingTrigger) void requestRun()
  } catch (error) {
    try { if (runtimeCleanup) await runtimeCleanup() } catch { /* preserve bootstrap failure */ }
    runtimeCleanup = null
    try { opened?.close() } catch { /* keep fatal envelope deterministic */ }
    opened = null
    if (stopping) return
    process.exitCode = 1
    post({ kind: 'fatal', error: sanitizeMetabolismWorkerError(error, 'bootstrap_runtime') })
    setImmediate(() => parentPort!.close())
  }
}

bootPromise = boot().finally(() => { bootPromise = null })
