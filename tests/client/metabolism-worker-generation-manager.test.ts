import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { MetabolismWorkerGenerationManager, type ManagedMetabolismWorkerController } from '../../client/electron/workers/metabolism-worker-generation-manager.js'
import type { MetabolismWorkerBootstrapV1 } from '../../client/electron/workers/metabolism-worker-protocol.js'

const hash = 'a'.repeat(64)
const bootstrap = (lifecycleGeneration: number): MetabolismWorkerBootstrapV1 => ({
  protocolVersion: 1, lifecycleGeneration,
  startupAuthority: { controllerReceiptId: 'r', dataScopeFingerprint: hash, controllerGeneration: 1 },
  databaseIdentity: { canonicalRealPath: '/db', deviceId: '1', inodeId: '2', identityCommitment: hash },
  expectedSchemaVersion: 33, runtimeRevision: lifecycleGeneration,
  runtimeConfigSnapshot: {}, runtimeConnectionSnapshot: {}, strategySnapshot: {}, strategySourceFingerprint: hash, externalRuntimeSourceFingerprint: 'e'.repeat(64),
  credentialSnapshot: {}, authorizedRoots: { dataDir: '/' }, vecCapability: 'unavailable',
})

class FakeController extends EventEmitter implements ManagedMetabolismWorkerController {
  start = vi.fn(async () => {})
  setScheduleContext = vi.fn()
  trigger = vi.fn()
  drainForRestart = vi.fn(() => queueMicrotask(() => this.emit('generation-ended')))
  shutdown = vi.fn(() => queueMicrotask(() => this.emit('generation-ended')))
  forceTerminate = vi.fn(async () => {})
}

describe('metabolism Worker generation manager', () => {
  it('drains before replacing and preserves every restart revision', async () => {
    const controllers: FakeController[] = []
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => bootstrap(generation),
      createController: () => { const controller = new FakeController(); controllers.push(controller); return controller },
      initialMode: 'background', initialCadence: 'active',
    })
    await manager.start()
    const first = manager.requestRestart()
    const second = manager.requestRestart()
    expect(second).toBe(first)
    await first
    expect(controllers).toHaveLength(3)
    expect(controllers[0].drainForRestart).toHaveBeenCalledTimes(1)
    expect(controllers[1].drainForRestart).toHaveBeenCalledTimes(1)
    expect(controllers[2].start).toHaveBeenCalledWith(expect.objectContaining({ lifecycleGeneration: 3 }), 'background', 'active')
  })

  it('queues a second restart that arrives after the replacement snapshot was captured', async () => {
    let releaseSecondBootstrap!: () => void
    const secondBootstrapBlocked = new Promise<void>(resolve => { releaseSecondBootstrap = resolve })
    let secondBootstrapStarted!: () => void
    const secondBootstrapSeen = new Promise<void>(resolve => { secondBootstrapStarted = resolve })
    const controllers: FakeController[] = []
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => {
        if (generation === 2) {
          secondBootstrapStarted()
          await secondBootstrapBlocked
        }
        return bootstrap(generation)
      },
      createController: () => { const controller = new FakeController(); controllers.push(controller); return controller },
      initialMode: 'background', initialCadence: 'active',
    })
    await manager.start()
    const first = manager.requestRestart()
    await secondBootstrapSeen
    expect(manager.requestRestart()).toBe(first)
    releaseSecondBootstrap()
    await first
    expect(controllers).toHaveLength(3)
    expect(controllers[2].start).toHaveBeenCalledWith(expect.objectContaining({ lifecycleGeneration: 3 }), 'background', 'active')
  })

  it('does not create a replacement when the old generation degrades during drain', async () => {
    const controller = new FakeController()
    controller.drainForRestart = vi.fn(() => queueMicrotask(() => controller.emit('degraded', 'drain failed')))
    const createController = vi.fn(() => controller)
    const manager = new MetabolismWorkerGenerationManager({ buildBootstrap: async generation => bootstrap(generation), createController, initialMode: 'background', initialCadence: 'idle' })
    await manager.start()
    await expect(manager.requestRestart()).rejects.toThrow('drain failed')
    expect(createController).toHaveBeenCalledTimes(1)
    expect(controller.forceTerminate).not.toHaveBeenCalled()
    controller.shutdown = vi.fn(() => queueMicrotask(() => controller.emit('degraded', 'shutdown timeout')))
    await manager.shutdown()
    expect(controller.forceTerminate).toHaveBeenCalledTimes(1)
  })

  it('ignores late messages from an ended old controller after replacement is ready', async () => {
    const controllers: FakeController[] = []
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => bootstrap(generation),
      createController: () => { const controller = new FakeController(); controllers.push(controller); return controller },
      initialMode: 'background', initialCadence: 'active',
    })
    const messages: unknown[] = []
    manager.on('message', message => messages.push(message))
    await manager.start()
    await manager.requestRestart()
    controllers[0].emit('message', { protocolVersion: 1, lifecycleGeneration: 1, kind: 'runtime_snapshot_invalidated', changeKind: 'strategy', sourceFingerprint: hash })
    controllers[0].emit('message', { protocolVersion: 1, lifecycleGeneration: 1, kind: 'health_changed', scope: 'llm' })
    await Promise.resolve()
    expect(messages).toEqual([])
    expect(controllers).toHaveLength(2)
  })

  it('waits for an in-flight bootstrap and never starts a replacement after shutdown', async () => {
    let releaseBootstrap!: () => void
    const bootstrapBlocked = new Promise<void>(resolve => { releaseBootstrap = resolve })
    let replacementBootstrapStarted!: () => void
    const replacementBootstrapSeen = new Promise<void>(resolve => { replacementBootstrapStarted = resolve })
    const controllers: FakeController[] = []
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => {
        if (generation === 2) {
          replacementBootstrapStarted()
          await bootstrapBlocked
        }
        return bootstrap(generation)
      },
      createController: () => { const controller = new FakeController(); controllers.push(controller); return controller },
      initialMode: 'background',
      initialCadence: 'active',
    })
    await manager.start()
    const restart = manager.requestRestart()
    await replacementBootstrapSeen

    let shutdownSettled = false
    const shutdown = manager.shutdown().then(() => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)

    releaseBootstrap()
    await Promise.all([restart, shutdown])
    expect(controllers).toHaveLength(1)
  })

  it('queues restart requested while the initial generation is still bootstrapping', async () => {
    let releaseStart!: () => void
    const blocked = new Promise<void>(resolve => { releaseStart = resolve })
    const controllers: FakeController[] = []
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => bootstrap(generation),
      createController: () => {
        const controller = new FakeController()
        if (controllers.length === 0) controller.start = vi.fn(async () => blocked)
        controllers.push(controller)
        return controller
      },
      initialMode: 'background', initialCadence: 'active',
    })
    const starting = manager.start()
    await vi.waitFor(() => expect(controllers).toHaveLength(1))
    const restarting = manager.requestRestart()
    releaseStart()
    await Promise.all([starting, restarting])
    expect(controllers).toHaveLength(2)
    expect(controllers[0].drainForRestart).toHaveBeenCalledTimes(1)
  })

  it('does not settle shutdown while the initial bootstrap builder is still running', async () => {
    let releaseBootstrap!: () => void
    const blocked = new Promise<void>(resolve => { releaseBootstrap = resolve })
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => { await blocked; return bootstrap(generation) },
      createController: () => new FakeController(),
      initialMode: 'background', initialCadence: 'active',
    })
    const starting = manager.start()
    let settled = false
    const stopping = manager.shutdown().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseBootstrap()
    await Promise.allSettled([starting, stopping])
    expect(settled).toBe(true)
  })

  it('latches a bootstrap rebuild failure and rejects later automatic restarts', async () => {
    const controller = new FakeController()
    let fail = false
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => {
        if (fail) throw new Error('snapshot rebuild failed')
        return bootstrap(generation)
      },
      createController: () => controller,
      initialMode: 'background', initialCadence: 'active',
    })
    await manager.start()
    fail = true
    await expect(manager.requestRestart()).rejects.toThrow('snapshot rebuild failed')
    await expect(manager.requestRestart()).rejects.toThrow('manager degraded')
  })

  it('settles shutdown after an abnormal generation exit and latches degraded state', async () => {
    const controller = new FakeController()
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => bootstrap(generation),
      createController: () => controller,
      initialMode: 'background',
      initialCadence: 'active',
    })
    await manager.start()
    controller.emit('degraded', 'worker_exit_1')
    controller.emit('generation-ended', 1)

    await expect(manager.requestRestart()).rejects.toThrow('manager degraded')
    await expect(manager.shutdown()).resolves.toBeUndefined()
    expect(controller.shutdown).not.toHaveBeenCalled()
  })

  it('force terminates the current generation when graceful shutdown degrades', async () => {
    const controller = new FakeController()
    controller.shutdown = vi.fn(() => queueMicrotask(() => controller.emit('degraded', 'stopped_timeout')))
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => bootstrap(generation), createController: () => controller,
      initialMode: 'background', initialCadence: 'active',
    })
    await manager.start()
    await manager.shutdown()
    expect(controller.forceTerminate).toHaveBeenCalledTimes(1)
  })

  it('forwards current schedule context, triggers and generation-scoped messages', async () => {
    const controller = new FakeController()
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async generation => bootstrap(generation),
      createController: () => controller,
      initialMode: 'background',
      initialCadence: 'idle',
    })
    const messages: unknown[] = []
    const cleared: number[] = []
    manager.on('message', message => messages.push(message))
    manager.on('clear-generation-tasks', generation => cleared.push(generation as number))
    await manager.start()
    manager.setScheduleContext('foreground', 'active')
    manager.trigger('immediate')
    controller.emit('message', { protocolVersion: 1, lifecycleGeneration: 1, kind: 'health_changed', scope: 'llm' })
    controller.emit('clear-generation-tasks', 1)
    expect(controller.setScheduleContext).toHaveBeenCalledWith('foreground', 'active')
    expect(controller.trigger).toHaveBeenCalledWith('immediate')
    expect(messages).toEqual([{ protocolVersion: 1, lifecycleGeneration: 1, kind: 'health_changed', scope: 'llm' }])
    expect(cleared).toEqual([1])
    await manager.shutdown()
  })
})
