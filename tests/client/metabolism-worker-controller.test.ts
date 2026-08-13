import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MetabolismWorkerController, type WorkerLike } from '../../client/electron/workers/metabolism-worker-controller.js'
import type { MetabolismWorkerBootstrapV1 } from '../../client/electron/workers/metabolism-worker-protocol.js'

const hash = (digit: string) => digit.repeat(64)

function bootstrap(generation = 1): MetabolismWorkerBootstrapV1 {
  return {
    protocolVersion: 1,
    lifecycleGeneration: generation,
    startupAuthority: { controllerReceiptId: 'r1', dataScopeFingerprint: hash('a'), controllerGeneration: 1 },
    databaseIdentity: { canonicalRealPath: '/tmp/db', deviceId: '1', inodeId: '2', identityCommitment: hash('b') },
    expectedSchemaVersion: 33,
    runtimeRevision: 1,
    runtimeConfigSnapshot: {},
    runtimeConnectionSnapshot: {},
    strategySnapshot: {},
    strategySourceFingerprint: hash('c'), externalRuntimeSourceFingerprint: 'e'.repeat(64),
    credentialSnapshot: {},
    authorizedRoots: { dataDir: '/tmp' },
    vecCapability: 'unavailable',
  }
}

class FakeWorker extends EventEmitter implements WorkerLike {
  readonly sent: unknown[] = []
  terminate = vi.fn(async () => 1)

  postMessage(value: unknown): void {
    this.sent.push(value)
  }
}

afterEach(() => vi.useRealTimers())

describe('metabolism Worker controller', () => {
  it('spawns one generation, requires ready and performs stopped-before-exit shutdown', async () => {
    const worker = new FakeWorker()
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => worker })
    const starting = controller.start(bootstrap(4), 'background', 'active')
    expect(worker.sent[0]).toMatchObject({ kind: 'set_schedule_context', lifecycleGeneration: 4, revision: 1 })
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 4, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await starting
    expect(controller.getState()?.lifecycle).toBe('ready')

    controller.shutdown()
    expect(worker.sent.at(-1)).toMatchObject({ kind: 'shutdown' })
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 4, kind: 'stopped', reason: 'shutdown' })
    expect(controller.getState()?.stoppedSettled).toBe(true)
    worker.emit('exit', 0)
    expect(controller.getState()?.lifecycle).toBe('exited')
  })

  it('ignores stale generation messages and clears only the failed generation task mirror', async () => {
    const worker = new FakeWorker()
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => worker })
    const clear = vi.fn()
    controller.on('clear-generation-tasks', clear)
    const starting = controller.start(bootstrap(9), 'foreground', 'active')
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 8, kind: 'fatal', error: { code: 'OLD', phase: 'x', retryable: false } })
    expect(controller.getState()?.lifecycle).toBe('bootstrapping')
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 9, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await starting
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 9, kind: 'fatal', error: { code: 'BROKEN', phase: 'runtime', retryable: false } })
    expect(controller.getState()?.lifecycle).toBe('degraded')
    expect(clear).toHaveBeenCalledWith(9)
  })

  it('rejects ready evidence that does not match the generation bootstrap', async () => {
    const worker = new FakeWorker()
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => worker })
    const starting = controller.start(bootstrap(10), 'background', 'active')
    worker.emit('message', {
      protocolVersion: 1,
      lifecycleGeneration: 10,
      kind: 'ready',
      runtimeRevision: 2,
      databaseIdentityCommitment: hash('b'),
      vecCapability: 'unavailable',
    })
    await expect(starting).rejects.toThrow('worker_ready_evidence_mismatch')
    expect(controller.getState()?.lifecycle).toBe('degraded')
  })

  it('does not auto-restart and only force terminates when explicitly requested', async () => {
    const worker = new FakeWorker()
    const factory = vi.fn(() => worker)
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: factory })
    const starting = controller.start(bootstrap(2), 'background', 'idle')
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 2, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await starting
    worker.emit('error', new Error('boom'))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(worker.terminate).not.toHaveBeenCalled()
    await controller.forceTerminate()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('degrades an exit that did not first prove stopped and exit zero', async () => {
    const worker = new FakeWorker()
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => worker })
    const degraded = vi.fn()
    controller.on('degraded', degraded)
    const starting = controller.start(bootstrap(21), 'background', 'active')
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 21, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await starting
    worker.emit('exit', 0)
    expect(degraded).toHaveBeenCalledWith('worker_exit_without_stopped')
    expect(controller.getState()).toMatchObject({ lifecycle: 'exited', degradationReason: 'worker_exit_without_stopped' })
  })

  it('records an explicit force termination without synthesizing stopped', async () => {
    const worker = new FakeWorker()
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => worker })
    const clear = vi.fn()
    controller.on('clear-generation-tasks', clear)
    const starting = controller.start(bootstrap(3), 'paused', 'active')
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 3, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await starting

    await controller.forceTerminate()
    expect(controller.getState()).toMatchObject({
      lifecycle: 'exited',
      stoppedSettled: false,
      degradationReason: 'forced_termination',
    })
    expect(clear).toHaveBeenCalledTimes(1)

    worker.emit('exit', 1)
    expect(controller.getState()).toMatchObject({
      lifecycle: 'exited',
      stoppedSettled: false,
      exitSettled: true,
      degradationReason: 'forced_termination',
    })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('settles a pending ready promise when shutdown exits during bootstrap and ignores duplicate exit', async () => {
    const worker = new FakeWorker()
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => worker })
    const ended = vi.fn()
    controller.on('generation-ended', ended)
    const starting = controller.start(bootstrap(31), 'paused', 'active')
    controller.shutdown()
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 31, kind: 'stopped', reason: 'shutdown' })
    worker.emit('exit', 0)
    await expect(starting).rejects.toThrow('worker exited before ready')
    worker.emit('exit', 0)
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('bridges structure-holes requests without forwarding error content', async () => {
    const worker = new FakeWorker()
    const structureHolesHandler = vi.fn(async () => [{ nodeId: 'n1', score: 0.5 }])
    const controller = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => worker, structureHolesHandler })
    const starting = controller.start(bootstrap(6), 'background', 'active')
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 6, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await starting
    worker.emit('message', { protocolVersion: 1, lifecycleGeneration: 6, kind: 'structure_holes_request', requestId: 'rpc-1', limit: 10 })
    await vi.waitFor(() => expect(worker.sent.at(-1)).toMatchObject({ kind: 'structure_holes_result', requestId: 'rpc-1' }))
    expect(structureHolesHandler).toHaveBeenCalledWith('rpc-1', 10)
  })

  it('degrades deterministically at ready, stopped and exit deadlines', async () => {
    vi.useFakeTimers()
    const readyWorker = new FakeWorker()
    const readyController = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => readyWorker, readyTimeoutMs: 10 })
    const ready = readyController.start(bootstrap(11), 'paused', 'active')
    const readyRejected = expect(ready).rejects.toThrow('ready_timeout')
    await vi.advanceTimersByTimeAsync(11)
    await readyRejected
    expect(readyController.getState()?.lifecycle).toBe('degraded')

    const stoppedWorker = new FakeWorker()
    const stoppedController = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => stoppedWorker, stoppedTimeoutMs: 10 })
    const starting = stoppedController.start(bootstrap(12), 'paused', 'active')
    stoppedWorker.emit('message', { protocolVersion: 1, lifecycleGeneration: 12, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await starting
    stoppedController.shutdown()
    await vi.advanceTimersByTimeAsync(11)
    expect(stoppedController.getState()?.lifecycle).toBe('degraded')

    const exitWorker = new FakeWorker()
    const exitController = new MetabolismWorkerController({ workerPath: '/worker.cjs', workerFactory: () => exitWorker, exitTimeoutMs: 10 })
    const exitStarting = exitController.start(bootstrap(13), 'paused', 'active')
    exitWorker.emit('message', { protocolVersion: 1, lifecycleGeneration: 13, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: hash('b'), vecCapability: 'unavailable' })
    await exitStarting
    exitController.shutdown()
    exitWorker.emit('message', { protocolVersion: 1, lifecycleGeneration: 13, kind: 'stopped', reason: 'shutdown' })
    await vi.advanceTimersByTimeAsync(11)
    expect(exitController.getState()?.lifecycle).toBe('degraded')
  })
})
