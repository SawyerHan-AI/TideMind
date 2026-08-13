import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import {
  createMetabolismWorkerControllerState,
  reduceMetabolismWorkerControllerState,
  type MetabolismWorkerControllerState,
} from './metabolism-worker-controller-state.js'
import {
  snapshotMetabolismWorkerBootstrap,
  snapshotMainToMetabolismWorkerMessage,
  snapshotMetabolismWorkerToMainMessage,
  type MetabolismWorkerBootstrapV1,
  type MetabolismWorkerToMainMessage,
  type SchedulerWorkerCadence,
  type SchedulerWorkerMode,
  type SchedulerWorkerTriggerReason,
} from './metabolism-worker-protocol.js'

export interface WorkerLike extends EventEmitter {
  postMessage(value: unknown): void
  terminate(): Promise<number>
}

export interface MetabolismWorkerControllerOptions {
  readonly workerPath: string
  readonly workerFactory?: (path: string, bootstrap: MetabolismWorkerBootstrapV1) => WorkerLike
  readonly readyTimeoutMs?: number
  readonly stoppedTimeoutMs?: number
  readonly exitTimeoutMs?: number
  readonly structureHolesHandler?: (requestId: string, limit?: number) => Promise<readonly unknown[]>
}

export class MetabolismWorkerController extends EventEmitter {
  private worker: WorkerLike | null = null
  private state: MetabolismWorkerControllerState | null = null
  private scheduleRevision = 0
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private stoppedTimer: ReturnType<typeof setTimeout> | null = null
  private exitTimer: ReturnType<typeof setTimeout> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private expectedReady: Pick<MetabolismWorkerBootstrapV1, 'runtimeRevision' | 'vecCapability'> & {
    readonly databaseIdentityCommitment: string
  } | null = null
  private exitHandled = false

  constructor(private readonly options: MetabolismWorkerControllerOptions) {
    super()
  }

  getState(): MetabolismWorkerControllerState | null {
    return this.state
  }

  async start(bootstrapValue: unknown, mode: SchedulerWorkerMode, cadence: SchedulerWorkerCadence): Promise<void> {
    if (this.worker) throw new Error('metabolism worker generation already exists')
    const bootstrap = snapshotMetabolismWorkerBootstrap(bootstrapValue)
    this.exitHandled = false
    this.expectedReady = Object.freeze({
      runtimeRevision: bootstrap.runtimeRevision,
      databaseIdentityCommitment: bootstrap.databaseIdentity.identityCommitment,
      vecCapability: bootstrap.vecCapability,
    })
    this.state = createMetabolismWorkerControllerState(bootstrap.lifecycleGeneration)
    const worker: WorkerLike = this.options.workerFactory
      ? this.options.workerFactory(this.options.workerPath, bootstrap)
      : new Worker(this.options.workerPath, { workerData: bootstrap }) as WorkerLike
    this.worker = worker
    this.apply({ kind: 'worker_spawned', lifecycleGeneration: bootstrap.lifecycleGeneration })
    worker.on('message', (value: unknown) => this.handleMessage(value))
    worker.on('error', (error: Error) => this.degrade('worker_error', error))
    worker.on('exit', (code: number) => this.handleExit(code))
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyTimer = setTimeout(() => this.expire('ready_timeout'), this.options.readyTimeoutMs ?? 15_000)
    this.readyTimer.unref?.()
    this.setScheduleContext(mode, cadence)
    return ready
  }

  setScheduleContext(mode: SchedulerWorkerMode, cadence: SchedulerWorkerCadence): void {
    if (!this.worker || !this.state) return
    const revision = ++this.scheduleRevision
    this.apply({ kind: 'schedule_context', lifecycleGeneration: this.state.lifecycleGeneration, revision, mode, cadence })
    this.worker.postMessage({ protocolVersion: 1, lifecycleGeneration: this.state.lifecycleGeneration, kind: 'set_schedule_context', mode, cadence, revision })
  }

  trigger(reason: SchedulerWorkerTriggerReason): void {
    if (!this.worker || !this.state || this.state.lifecycle !== 'ready') return
    this.worker.postMessage({ protocolVersion: 1, lifecycleGeneration: this.state.lifecycleGeneration, kind: 'trigger', reason })
  }

  drainForRestart(): void {
    if (!this.worker || !this.state) return
    const result = this.apply({ kind: 'begin_drain', lifecycleGeneration: this.state.lifecycleGeneration })
    if (!result) return
    this.worker.postMessage({ protocolVersion: 1, lifecycleGeneration: this.state.lifecycleGeneration, kind: 'drain_for_restart' })
    this.armStoppedDeadline()
  }

  async shutdown(): Promise<void> {
    if (!this.worker || !this.state) return
    if (this.state.lifecycle === 'degraded') {
      await this.forceTerminate()
      return
    }
    const result = this.apply({ kind: 'begin_shutdown', lifecycleGeneration: this.state.lifecycleGeneration })
    if (!result) return
    this.worker.postMessage({ protocolVersion: 1, lifecycleGeneration: this.state.lifecycleGeneration, kind: 'shutdown' })
    this.armStoppedDeadline()
  }

  async forceTerminate(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    if (this.state) {
      const accepted = this.apply({
        kind: 'forced_termination',
        lifecycleGeneration: this.state.lifecycleGeneration,
        reason: 'forced_termination',
      })
      if (accepted) {
        this.clearTimers()
        this.readyReject?.(new Error('forced_termination'))
        this.readyResolve = null
        this.readyReject = null
        this.emit('degraded', 'forced_termination')
      }
    }
    const exitCode = await worker.terminate()
    // Node resolves terminate() only after the thread has exited. Test doubles
    // and unusual hosts may not deliver a separate exit event; settle exactly
    // once from the authoritative terminate result.
    if (this.worker === worker) this.handleExit(exitCode)
  }

  private handleMessage(value: unknown): void {
    let message: MetabolismWorkerToMainMessage
    try { message = snapshotMetabolismWorkerToMainMessage(value) } catch { return }
    if (
      !this.state
      || message.lifecycleGeneration !== this.state.lifecycleGeneration
      || this.state.lifecycle === 'exited'
      || this.state.lifecycle === 'degraded'
    ) return
    if (message.kind === 'ready') {
      if (
        !this.expectedReady
        || message.runtimeRevision !== this.expectedReady.runtimeRevision
        || message.databaseIdentityCommitment !== this.expectedReady.databaseIdentityCommitment
        || message.vecCapability !== this.expectedReady.vecCapability
      ) {
        this.degrade('worker_ready_evidence_mismatch')
        return
      }
      const accepted = this.apply({ kind: 'ready', lifecycleGeneration: message.lifecycleGeneration })
      if (!accepted) return
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = null
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      this.trigger('initial')
    } else if (message.kind === 'stopped') {
      if (!this.apply({ kind: 'stopped', lifecycleGeneration: message.lifecycleGeneration })) return
      if (this.stoppedTimer) clearTimeout(this.stoppedTimer)
      this.stoppedTimer = null
      this.armExitDeadline()
    } else if (message.kind === 'fatal') {
      this.degrade(`worker_fatal:${message.error.code}`)
    } else if (message.kind === 'structure_holes_request') {
      void this.handleStructureHolesRequest(message)
    }
    this.emit('message', message)
  }

  private async handleStructureHolesRequest(
    message: Extract<MetabolismWorkerToMainMessage, { kind: 'structure_holes_request' }>,
  ): Promise<void> {
    const worker = this.worker
    const handler = this.options.structureHolesHandler
    if (!worker || !handler || !this.state) return
    const generation = this.state.lifecycleGeneration
    try {
      const holes = await handler(message.requestId, message.limit)
      if (this.worker !== worker || this.state?.lifecycleGeneration !== generation) return
      worker.postMessage(snapshotMainToMetabolismWorkerMessage({
        protocolVersion: 1,
        lifecycleGeneration: generation,
        kind: 'structure_holes_result',
        requestId: message.requestId,
        holes,
      }))
    } catch {
      if (this.worker !== worker || this.state?.lifecycleGeneration !== generation) return
      worker.postMessage({ protocolVersion: 1, lifecycleGeneration: generation, kind: 'structure_holes_failed', requestId: message.requestId, errorKind: 'failed' })
    }
  }

  private handleExit(code: number): void {
    if (!this.state || this.exitHandled) return
    this.exitHandled = true
    if (this.readyReject) {
      this.readyReject(new Error(code === 0 ? 'worker exited before ready' : `worker_exit_${code}`))
      this.readyResolve = null
      this.readyReject = null
    }
    if (code !== 0 || !this.state.stoppedSettled) {
      this.degrade(code === 0 ? 'worker_exit_without_stopped' : `worker_exit_${code}`)
    }
    this.apply({ kind: 'exit', lifecycleGeneration: this.state.lifecycleGeneration })
    this.clearTimers()
    this.worker = null
    this.expectedReady = null
    this.emit('generation-ended', this.state.lifecycleGeneration)
  }

  private apply(transition: Parameters<typeof reduceMetabolismWorkerControllerState>[1]): boolean {
    if (!this.state) return false
    const result = reduceMetabolismWorkerControllerState(this.state, transition)
    this.state = result.state
    if (result.clearGenerationTasks) this.emit('clear-generation-tasks', this.state.lifecycleGeneration)
    return result.accepted
  }

  private degrade(reason: string, error?: Error): void {
    if (!this.state) return
    const accepted = this.apply({ kind: 'fatal', lifecycleGeneration: this.state.lifecycleGeneration, reason })
    if (!accepted) return
    this.clearTimers()
    this.readyReject?.(new Error(reason, { cause: error }))
    this.readyResolve = null
    this.readyReject = null
    this.emit('degraded', reason)
  }

  private expire(reason: string): void {
    if (!this.state) return
    const accepted = this.apply({ kind: 'deadline_expired', lifecycleGeneration: this.state.lifecycleGeneration, reason })
    if (!accepted) return
    this.readyReject?.(new Error(reason))
    this.readyResolve = null
    this.readyReject = null
    this.emit('degraded', reason)
  }

  private armStoppedDeadline(): void {
    this.stoppedTimer = setTimeout(() => this.expire('stopped_timeout'), this.options.stoppedTimeoutMs ?? 15_000)
    this.stoppedTimer.unref?.()
  }

  private armExitDeadline(): void {
    this.exitTimer = setTimeout(() => this.expire('exit_timeout'), this.options.exitTimeoutMs ?? 5_000)
    this.exitTimer.unref?.()
  }

  private clearTimers(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (this.stoppedTimer) clearTimeout(this.stoppedTimer)
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.readyTimer = this.stoppedTimer = this.exitTimer = null
  }
}
