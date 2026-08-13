import { EventEmitter } from 'node:events'
import type {
  MetabolismWorkerBootstrapV1,
  MetabolismWorkerToMainMessage,
  SchedulerWorkerCadence,
  SchedulerWorkerMode,
  SchedulerWorkerTriggerReason,
} from './metabolism-worker-protocol.js'

export interface ManagedMetabolismWorkerController extends EventEmitter {
  start(bootstrap: unknown, mode: SchedulerWorkerMode, cadence: SchedulerWorkerCadence): Promise<void>
  setScheduleContext(mode: SchedulerWorkerMode, cadence: SchedulerWorkerCadence): void
  trigger(reason: SchedulerWorkerTriggerReason): void
  drainForRestart(): void
  shutdown(): void | Promise<void>
  forceTerminate(): Promise<void>
}

export interface MetabolismWorkerGenerationManagerOptions {
  readonly buildBootstrap: (lifecycleGeneration: number) => Promise<MetabolismWorkerBootstrapV1>
  readonly createController: (lifecycleGeneration: number) => ManagedMetabolismWorkerController
  readonly initialMode: SchedulerWorkerMode
  readonly initialCadence: SchedulerWorkerCadence
}

export class MetabolismWorkerGenerationManager extends EventEmitter {
  private generation = 0
  private controller: ManagedMetabolismWorkerController | null = null
  private restartPromise: Promise<void> | null = null
  private startPromise: Promise<void> | null = null
  private restartRevision = 0
  private stopped = false
  private degraded = false
  private mode: SchedulerWorkerMode
  private cadence: SchedulerWorkerCadence

  constructor(private readonly options: MetabolismWorkerGenerationManagerOptions) {
    super()
    this.mode = options.initialMode
    this.cadence = options.initialCadence
  }

  currentGeneration(): number {
    return this.generation
  }

  setScheduleContext(mode: SchedulerWorkerMode, cadence: SchedulerWorkerCadence): void {
    this.mode = mode
    this.cadence = cadence
    this.controller?.setScheduleContext(mode, cadence)
  }

  trigger(reason: SchedulerWorkerTriggerReason): void {
    this.controller?.trigger(reason)
  }

  async start(): Promise<void> {
    if (this.controller || this.stopped) throw new Error('metabolism Worker generation manager cannot start')
    const current = this.startNextGeneration().catch(error => {
      this.markDegraded(error)
      throw error
    }).finally(() => {
      if (this.startPromise === current) this.startPromise = null
    })
    this.startPromise = current
    await current
  }

  requestRestart(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('metabolism Worker generation manager stopped'))
    if (this.degraded) return Promise.reject(new Error('metabolism Worker generation manager degraded'))
    this.restartRevision += 1
    if (this.restartPromise) return this.restartPromise
    const current = this.restartUntilCurrent().catch(error => {
      this.markDegraded(error)
      throw error
    }).finally(() => {
      if (this.restartPromise === current) this.restartPromise = null
    })
    this.restartPromise = current
    return current
  }

  private async restartUntilCurrent(): Promise<void> {
    while (!this.stopped && !this.degraded) {
      const targetRevision = this.restartRevision
      await this.restartCurrentGeneration()
      if (targetRevision === this.restartRevision) return
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const restart = this.restartPromise
    const starting = this.startPromise
    const controller = this.controller
    if (controller) {
      const ended = this.waitForEnd(controller)
      await controller.shutdown()
      try {
        await ended
      } catch {
        // Application shutdown owns a hard release boundary. A missing stopped
        // or exit ACK is not treated as task rollback, but the thread and its
        // SQLite resources must still be terminated before main closes the DB.
        await controller.forceTerminate()
      }
      if (this.controller === controller) this.controller = null
    }
    // A restart can be between generations while buildBootstrap is awaiting
    // filesystem/config evidence.  Do not let shutdown return while that work
    // is still capable of reaching startNextGeneration.
    if (restart) {
      try {
        await restart
      } catch {
        // A failed restart is already surfaced through its caller/degraded
        // path.  Shutdown only needs to prove that it has settled.
      }
    }
    if (starting) {
      try {
        await starting
      } catch {
        // shutdown只等待启动工作settle；启动失败已由start caller/degraded事件承接。
      }
    }
  }

  private async restartCurrentGeneration(): Promise<void> {
    const starting = this.startPromise
    if (starting) await starting
    if (this.stopped || this.degraded) return
    const current = this.controller
    if (current) {
      const ended = this.waitForEnd(current)
      current.drainForRestart()
      try {
        await ended
      } catch (error) {
        // 普通runtime换代不能把未结算的同步SQL/CLI effect猜成已回滚。
        // 仅session degraded并保留旧线程；应用shutdown的硬deadline才可terminate。
        throw error
      }
      if (this.controller === current) this.controller = null
    }
    if (this.stopped) return
    await this.startNextGeneration()
  }

  private async startNextGeneration(): Promise<void> {
    if (this.stopped) return
    const nextGeneration = this.generation + 1
    const bootstrap = await this.options.buildBootstrap(nextGeneration)
    if (this.stopped) return
    if (bootstrap.lifecycleGeneration !== nextGeneration) throw new Error('runtime snapshot generation mismatch')
    const controller = this.options.createController(nextGeneration)
    this.controller = controller
    controller.on('message', (message: MetabolismWorkerToMainMessage) => {
      if (this.controller !== controller) return
      if (message.kind === 'runtime_snapshot_invalidated') void this.requestRestart().catch(error => this.markDegraded(error))
      this.emit('message', message)
    })
    controller.on('clear-generation-tasks', (generation: number) => {
      if (this.controller === controller) this.emit('clear-generation-tasks', generation)
    })
    controller.on('degraded', reason => {
      if (this.controller === controller) this.markDegraded(reason)
    })
    controller.on('generation-ended', () => {
      if (this.controller === controller) this.controller = null
    })
    try {
      await controller.start(bootstrap, this.mode, this.cadence)
    } catch (error) {
      this.markDegraded(error)
      await controller.forceTerminate()
      if (this.controller === controller) this.controller = null
      throw error
    }
    this.generation = nextGeneration
    this.emit('generation-ready', nextGeneration)
  }

  private waitForEnd(controller: ManagedMetabolismWorkerController): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ended = () => { cleanup(); resolve() }
      const degraded = (reason: unknown) => { cleanup(); reject(reason instanceof Error ? reason : new Error(String(reason))) }
      const cleanup = () => {
        controller.off('generation-ended', ended)
        controller.off('degraded', degraded)
      }
      controller.once('generation-ended', ended)
      controller.once('degraded', degraded)
    })
  }

  private markDegraded(reason: unknown): void {
    if (this.degraded) return
    this.degraded = true
    this.emit('degraded', reason)
  }
}
