import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const order: string[] = []
  const activity = { state: 'active' as 'active' | 'idle', listeners: new Set<(value: 'active' | 'idle') => void>() }
  const mode = { value: 'foreground' as 'foreground' | 'background' | 'paused', listeners: new Set<(value: 'foreground' | 'background' | 'paused') => void>() }
  const managers: Array<{
    options: Record<string, unknown>
    listeners: Map<string, Array<(...args: unknown[]) => void>>
    start: ReturnType<typeof vi.fn>
    setScheduleContext: ReturnType<typeof vi.fn>
    trigger: ReturnType<typeof vi.fn>
    requestRestart: ReturnType<typeof vi.fn>
    shutdown: ReturnType<typeof vi.fn>
    emit: (event: string, ...args: unknown[]) => void
  }> = []
  const createManager = vi.fn(function (this: unknown, options: Record<string, unknown>) {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const manager = {
      options,
      listeners,
      start: vi.fn(async () => { order.push('worker-start') }),
      setScheduleContext: vi.fn(),
      trigger: vi.fn(),
      requestRestart: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => { order.push('worker-shutdown') }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return manager
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
    }
    managers.push(manager)
    return manager
  })
  const issuer = {
    startupAuthority: { controllerReceiptId: 'receipt', dataScopeFingerprint: 'a'.repeat(64), controllerGeneration: 1 },
    build: vi.fn(() => ({ protocolVersion: 1, lifecycleGeneration: 1 })),
    invalidate: vi.fn(() => { order.push('handoff-invalidate') }),
  }
  return {
    order,
    activity,
    mode,
    managers,
    createManager,
    issuer,
    loadConfig: vi.fn(() => { order.push('load-config') }),
    ensureDataDirs: vi.fn(() => { order.push('ensure-data-dirs') }),
    getConfig: vi.fn(() => ({ general: { data_dir: '/tmp/test-daemon-dir' } })),
    getDataDir: vi.fn(() => '/tmp/test-daemon-dir'),
    db: { name: '/tmp/test-daemon-dir/graph/brain.sqlite', pragma: vi.fn() },
    getDb: vi.fn(() => { order.push('get-db'); return mocks.db }),
    closeDb: vi.fn(() => { order.push('close-db') }),
    initVec: vi.fn(async () => { order.push('init-vec'); return 'unavailable' as const }),
    startSources: vi.fn(async () => { order.push('start-sources') }),
    stopSources: vi.fn(async () => { order.push('stop-sources') }),
    createHandoff: vi.fn(() => { order.push('create-handoff'); return issuer }),
    bindMutation: vi.fn((restart: (kind: string) => Promise<void>) => {
      mocks.mutationRestart = restart
      return vi.fn(() => { order.push('unbind-mutation') })
    }),
    sourceWatcher: { acknowledgeCurrent: vi.fn(), poll: vi.fn(), close: vi.fn() },
    mutationRestart: null as ((kind: string) => Promise<void>) | null,
    setLLMSuccess: vi.fn(() => { order.push('llm-success-hook') }),
    setLLMFailure: vi.fn(() => { order.push('llm-failure-hook') }),
    setEmbeddingSuccess: vi.fn(() => { order.push('embedding-success-hook') }),
    setEmbeddingFailure: vi.fn(() => { order.push('embedding-failure-hook') }),
    setStructureRunner: vi.fn(() => { order.push('structure-hook') }),
    terminateStructure: vi.fn(async () => { order.push('structure-terminate') }),
    reconcile: vi.fn(() => ({ definiteFailures: [], ambiguousInvocations: [], stabilizedConnections: [] })),
    cleanupCli: vi.fn(),
    logTimeline: vi.fn(),
    waitBackground: vi.fn(async () => { order.push('wait-background') }),
    applyStatus: vi.fn(),
    clearStatus: vi.fn(),
  }
})

vi.mock('@server/config.js', () => ({
  loadConfig: mocks.loadConfig,
  ensureDataDirs: mocks.ensureDataDirs,
  getConfig: mocks.getConfig,
  getDataDir: mocks.getDataDir,
}))
vi.mock('@server/db/connection.js', () => ({ getDb: mocks.getDb, closeDb: mocks.closeDb, initVec: mocks.initVec }))
vi.mock('@server/db/schema.js', () => ({ CURRENT_SCHEMA_VERSION: 33 }))
vi.mock('@server/utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }), enableFileLogging: vi.fn() }))
vi.mock('@server/db/log.js', () => ({ logTimelineEvent: mocks.logTimeline }))
vi.mock('@server/metabolism/scheduler.js', () => ({
  noteSuccessfulLLMCall: vi.fn(),
  setLLMFailureHook: mocks.setLLMFailure,
  recordLLMFailureForHook: vi.fn(),
  recordEmbeddingSuccess: vi.fn(),
  recordEmbeddingFailure: vi.fn(),
}))
vi.mock('@server/metabolism/worker-runtime-snapshot.js', () => ({
  MetabolismWorkerRuntimeRevisionAllocator: class {
    private revision = 0
    allocate() { return ++this.revision }
  },
}))
vi.mock('@server/llm/client.js', () => ({ setLLMSuccessHook: mocks.setLLMSuccess }))
vi.mock('@server/llm/embedding.js', () => ({ setEmbeddingSuccessHook: mocks.setEmbeddingSuccess, setEmbeddingFailureHook: mocks.setEmbeddingFailure }))
vi.mock('@server/graph/structure-holes.js', () => ({ setStructureHolesRunner: mocks.setStructureRunner }))
vi.mock('@server/llm/cli/invocation-state.js', () => ({ reconcileCliRuntimeState: mocks.reconcile }))
vi.mock('@server/llm/cli/runtime-dir.js', () => ({ cleanupStaleCliRuntimeDirectories: mocks.cleanupCli }))
vi.mock('@server/integrations/shared/note-sources.js', () => ({ startAllNoteSources: mocks.startSources, stopAllNoteSourcesAsync: mocks.stopSources }))
vi.mock('@server/utils/background-work.js', () => ({ waitForBackgroundWork: mocks.waitBackground }))
vi.mock('../../client/electron/activity-state.js', () => ({
  getActivityState: () => ({
    getState: () => mocks.activity.state,
    onChange: (listener: (value: 'active' | 'idle') => void) => {
      mocks.activity.listeners.add(listener)
      return () => mocks.activity.listeners.delete(listener)
    },
  }),
}))
vi.mock('../../client/electron/scheduler-execution-mode.js', () => ({
  getSchedulerExecutionMode: () => ({
    getMode: () => mocks.mode.value,
    onChange: (listener: (value: 'foreground' | 'background' | 'paused') => void) => {
      mocks.mode.listeners.add(listener)
      return () => mocks.mode.listeners.delete(listener)
    },
  }),
}))
vi.mock('../../client/electron/workers/structure-holes-runner.js', () => ({ runStructureHolesInWorker: vi.fn(async () => []), terminateStructureHolesWorker: mocks.terminateStructure }))
vi.mock('../../client/electron/runtime/runtime-paths.js', () => ({ getMetabolismWorkerPath: () => '/worker.cjs' }))
vi.mock('../../client/electron/workers/metabolism-worker-controller.js', () => ({ MetabolismWorkerController: vi.fn() }))
vi.mock('../../client/electron/workers/metabolism-worker-generation-manager.js', () => ({ MetabolismWorkerGenerationManager: mocks.createManager }))
vi.mock('../../client/electron/workers/metabolism-worker-startup-handoff.js', () => ({ createMetabolismWorkerStartupHandoffIssuer: mocks.createHandoff }))
vi.mock('../../client/electron/workers/metabolism-worker-runtime-mutations.js', () => ({
  bindMetabolismWorkerRuntimeMutationRestart: mocks.bindMutation,
  watchMetabolismWorkerExternalRuntimeSources: vi.fn(() => mocks.sourceWatcher),
}))
vi.mock('../../client/electron/ipc/llm-health.js', () => ({ applyMetabolismWorkerStatusMessage: mocks.applyStatus, clearMetabolismWorkerGenerationStatus: mocks.clearStatus }))

const daemon = await import('../../client/electron/daemon.js')

beforeEach(() => {
  for (const value of Object.values(mocks)) {
    if (typeof value === 'function' && 'mockClear' in value) (value as ReturnType<typeof vi.fn>).mockClear()
  }
  mocks.order.length = 0
  mocks.managers.length = 0
  mocks.activity.state = 'active'
  mocks.activity.listeners.clear()
  mocks.mode.value = 'foreground'
  mocks.mode.listeners.clear()
  mocks.mutationRestart = null
  mocks.db.pragma.mockClear()
  mocks.issuer.build.mockClear()
  mocks.issuer.invalidate.mockClear()
  mocks.initVec.mockImplementation(async () => { mocks.order.push('init-vec'); return 'unavailable' })
  mocks.startSources.mockImplementation(async () => { mocks.order.push('start-sources') })
  mocks.stopSources.mockImplementation(async () => { mocks.order.push('stop-sources') })
  mocks.issuer.build.mockImplementation(() => ({ protocolVersion: 1, lifecycleGeneration: 1 }))
  mocks.createHandoff.mockImplementation(() => { mocks.order.push('create-handoff'); return mocks.issuer })
})

afterEach(async () => {
  await daemon.stopDaemon().catch(() => undefined)
})

describe('Electron daemon Worker production path', () => {
  it('unwinds hooks, note sources and DB when handoff creation fails', async () => {
    mocks.createHandoff.mockImplementationOnce(() => { throw new Error('handoff failed') })
    await expect(daemon.startDaemon()).rejects.toThrow('handoff failed')
    expect(mocks.stopSources).toHaveBeenCalledTimes(1)
    expect(mocks.terminateStructure).toHaveBeenCalledTimes(1)
    expect(mocks.closeDb).toHaveBeenCalledTimes(1)
    expect(mocks.setLLMSuccess).toHaveBeenLastCalledWith(null)
    expect(mocks.setStructureRunner).toHaveBeenLastCalledWith(null)
  })
  it('keeps DB ownership and lets stopDaemon retry when startup note-source drain fails', async () => {
    mocks.createHandoff.mockImplementationOnce(() => { throw new Error('handoff failed') })
    mocks.stopSources
      .mockRejectedValueOnce(new Error('note drain failed'))
      .mockImplementationOnce(async () => { mocks.order.push('stop-sources') })
    await expect(daemon.startDaemon()).rejects.toThrow('handoff failed')
    expect(mocks.closeDb).not.toHaveBeenCalled()
    await daemon.stopDaemon()
    expect(mocks.stopSources).toHaveBeenCalledTimes(2)
    expect(mocks.closeDb).toHaveBeenCalled()
  })
  it('creates the handoff and starts the Worker only after mandatory main bootstrap', async () => {
    await daemon.startDaemon()
    expect(mocks.db.pragma).toHaveBeenCalledWith('wal_autocheckpoint = 10000')
    expect(mocks.order).toEqual(expect.arrayContaining([
      'load-config', 'ensure-data-dirs', 'get-db', 'init-vec', 'start-sources', 'create-handoff', 'worker-start',
    ]))
    expect(mocks.order.indexOf('create-handoff')).toBeGreaterThan(mocks.order.indexOf('start-sources'))
    expect(mocks.order.indexOf('worker-start')).toBeGreaterThan(mocks.order.indexOf('create-handoff'))
    expect(mocks.createHandoff).toHaveBeenCalledWith(expect.objectContaining({
      db: mocks.db,
      dataDir: '/tmp/test-daemon-dir',
      expectedSchemaVersion: 33,
      vecCapability: 'unavailable',
    }))
    const manager = mocks.managers[0]
    const buildBootstrap = manager.options.buildBootstrap as (generation: number) => Promise<unknown>
    await buildBootstrap(1)
    expect(mocks.issuer.build).toHaveBeenCalledWith(mocks.getConfig(), 1, 1)
  })

  it('contains runtime source acknowledgement failures instead of throwing through main EventEmitter', async () => {
    await daemon.startDaemon()
    mocks.sourceWatcher.acknowledgeCurrent.mockImplementationOnce(() => { throw new Error('source raced') })
    expect(() => mocks.managers[0].emit('message', {
      protocolVersion: 1,
      lifecycleGeneration: 1,
      kind: 'runtime_snapshot_invalidated',
      changeKind: 'strategy',
      sourceFingerprint: 'a'.repeat(64),
    })).not.toThrow()
    expect(daemon.getMetabolismWorkerDegradedReason()).toContain('source raced')
  })

  it('does not create a Worker when stop wins while initVec is pending', async () => {
    let resolveInit: ((value: 'unavailable') => void) | null = null
    mocks.initVec.mockImplementationOnce(() => new Promise(resolve => { resolveInit = resolve }))
    const starting = daemon.startDaemon()
    await Promise.resolve()
    const stopping = daemon.stopDaemon()
    resolveInit?.('unavailable')
    await Promise.all([starting, stopping])
    expect(mocks.createHandoff).not.toHaveBeenCalled()
    expect(mocks.createManager).not.toHaveBeenCalled()
    expect(mocks.closeDb).toHaveBeenCalledTimes(1)
  })

  it('continues shutdown cleanup when the in-flight startup rejects', async () => {
    let rejectInit: ((error: Error) => void) | null = null
    mocks.initVec.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectInit = reject }))
    const starting = daemon.startDaemon()
    await Promise.resolve()
    const stopping = daemon.stopDaemon()
    rejectInit?.(new Error('init failed during shutdown'))
    await expect(starting).rejects.toThrow('init failed during shutdown')
    await expect(stopping).resolves.toBeUndefined()
    expect(mocks.createManager).not.toHaveBeenCalled()
    expect(mocks.closeDb).toHaveBeenCalled()
  })

  it('forwards activity, mode, resume and immediate triggers to the current generation', async () => {
    await daemon.startDaemon()
    const manager = mocks.managers[0]
    mocks.activity.state = 'idle'
    for (const listener of mocks.activity.listeners) listener('idle')
    expect(manager.setScheduleContext).toHaveBeenCalledWith('foreground', 'idle')
    mocks.activity.state = 'active'
    for (const listener of mocks.activity.listeners) listener('active')
    expect(manager.trigger).toHaveBeenCalledWith('resume')
    mocks.mode.value = 'paused'
    for (const listener of mocks.mode.listeners) listener('paused')
    expect(manager.setScheduleContext).toHaveBeenCalledWith('paused', 'active')
    mocks.mode.value = 'background'
    for (const listener of mocks.mode.listeners) listener('background')
    expect(manager.trigger).toHaveBeenCalledWith('resume')
    await daemon.triggerImmediateSchedulerTick()
    expect(manager.trigger).toHaveBeenCalledWith('immediate')
  })

  it('coalesces runtime mutations through generation restart and bridges Worker status', async () => {
    await daemon.startDaemon()
    const manager = mocks.managers[0]
    await mocks.mutationRestart?.('config')
    expect(manager.requestRestart).toHaveBeenCalledTimes(1)
    const message = { protocolVersion: 1, lifecycleGeneration: 1, kind: 'health_changed', scope: 'llm' }
    manager.emit('message', message)
    await vi.waitFor(() => expect(mocks.applyStatus).toHaveBeenCalledWith(mocks.db, message))
    manager.emit('clear-generation-tasks', 1)
    await vi.waitFor(() => expect(mocks.clearStatus).toHaveBeenCalledWith(mocks.db, 1))
  })

  it('counts structured scheduler contention independently of filtered logs', async () => {
    await daemon.startDaemon()
    mocks.managers[0].emit('message', {
      protocolVersion: 1,
      lifecycleGeneration: 1,
      kind: 'scheduler_sqlite_contention',
      reason: 'busy_deferred',
    })
    expect(daemon.getMetabolismWorkerExecutionDiagnostics().sqliteContentionEvents).toBe(1)
  })

  it('publishes degraded state without invoking a main scheduler fallback', async () => {
    await daemon.startDaemon()
    mocks.managers[0].emit('degraded', new Error('worker failed'))
    expect(daemon.getMetabolismWorkerDegradedReason()).toBe('worker failed')
  })

  it('rolls back daemon-owned resources when Worker startup fails', async () => {
    const original = mocks.createManager.getMockImplementation()
    mocks.createManager.mockImplementationOnce(function (this: unknown, options: Record<string, unknown>) {
      const manager = original!.call(this, options) as (typeof mocks.managers)[number]
      manager.start.mockRejectedValueOnce(new Error('ready failed'))
      return manager
    })
    await expect(daemon.startDaemon()).rejects.toThrow('ready failed')
    expect(mocks.issuer.invalidate).toHaveBeenCalledTimes(1)
    expect(mocks.stopSources).toHaveBeenCalledTimes(1)
    expect(mocks.closeDb).toHaveBeenCalledTimes(1)
  })

  it('shuts the Worker down before structure, note sources and DB', async () => {
    await daemon.startDaemon()
    await daemon.stopDaemon()
    expect(mocks.order.indexOf('worker-shutdown')).toBeLessThan(mocks.order.indexOf('structure-terminate'))
    expect(mocks.order.indexOf('structure-terminate')).toBeLessThan(mocks.order.indexOf('stop-sources'))
    expect(mocks.order.indexOf('stop-sources')).toBeLessThan(mocks.order.indexOf('close-db'))
    expect(mocks.issuer.invalidate).toHaveBeenCalledTimes(1)
    expect(mocks.activity.listeners.size).toBe(0)
    expect(mocks.mode.listeners.size).toBe(0)
  })

  it('keeps the DB open when note-source drain fails', async () => {
    await daemon.startDaemon()
    mocks.stopSources.mockRejectedValueOnce(new Error('drain failed'))
    await expect(daemon.stopDaemon()).rejects.toThrow('drain failed')
    expect(mocks.closeDb).not.toHaveBeenCalled()
    await daemon.stopDaemon()
    expect(mocks.closeDb).toHaveBeenCalledTimes(1)
  })
})
