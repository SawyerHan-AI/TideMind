import type { SchedulerWorkerCadence, SchedulerWorkerMode } from './metabolism-worker-protocol.js'

export type MetabolismWorkerLifecycleState =
  | 'spawning'
  | 'bootstrapping'
  | 'ready'
  | 'draining'
  | 'stopping'
  | 'exited'
  | 'degraded'

export interface MetabolismWorkerControllerState {
  readonly lifecycleGeneration: number
  readonly lifecycle: MetabolismWorkerLifecycleState
  readonly scheduleRevision: number
  readonly mode: SchedulerWorkerMode | null
  readonly cadence: SchedulerWorkerCadence | null
  readonly pendingTrigger: boolean
  readonly readySettled: boolean
  readonly stoppedSettled: boolean
  readonly exitSettled: boolean
  readonly degradationReason: string | null
}

export type ControllerTransition =
  | { kind: 'worker_spawned'; lifecycleGeneration: number }
  | { kind: 'schedule_context'; lifecycleGeneration: number; revision: number; mode: SchedulerWorkerMode; cadence: SchedulerWorkerCadence }
  | { kind: 'trigger'; lifecycleGeneration: number }
  | { kind: 'ready'; lifecycleGeneration: number }
  | { kind: 'begin_drain'; lifecycleGeneration: number }
  | { kind: 'begin_shutdown'; lifecycleGeneration: number }
  | { kind: 'stopped'; lifecycleGeneration: number }
  | { kind: 'exit'; lifecycleGeneration: number }
  | { kind: 'fatal'; lifecycleGeneration: number; reason: string }
  | { kind: 'forced_termination'; lifecycleGeneration: number; reason: string }
  | { kind: 'deadline_expired'; lifecycleGeneration: number; reason: string }

export interface ControllerTransitionResult {
  readonly state: MetabolismWorkerControllerState
  readonly accepted: boolean
  readonly queueTrigger: boolean
  readonly clearGenerationTasks: boolean
}

export function createMetabolismWorkerControllerState(lifecycleGeneration: number): MetabolismWorkerControllerState {
  if (!Number.isSafeInteger(lifecycleGeneration) || lifecycleGeneration < 1) {
    throw new TypeError('invalid metabolism worker lifecycle generation')
  }
  return Object.freeze({
    lifecycleGeneration,
    lifecycle: 'spawning',
    scheduleRevision: 0,
    mode: null,
    cadence: null,
    pendingTrigger: false,
    readySettled: false,
    stoppedSettled: false,
    exitSettled: false,
    degradationReason: null,
  })
}

function freeze(state: MetabolismWorkerControllerState): MetabolismWorkerControllerState {
  return Object.freeze(state)
}

function ignored(state: MetabolismWorkerControllerState): ControllerTransitionResult {
  return Object.freeze({ state, accepted: false, queueTrigger: false, clearGenerationTasks: false })
}

export function reduceMetabolismWorkerControllerState(
  state: MetabolismWorkerControllerState,
  transition: ControllerTransition,
): ControllerTransitionResult {
  if (transition.lifecycleGeneration !== state.lifecycleGeneration) return ignored(state)
  let next = state
  let queueTrigger = false
  let clearGenerationTasks = false

  switch (transition.kind) {
    case 'worker_spawned':
      if (state.lifecycle !== 'spawning') return ignored(state)
      next = freeze({ ...state, lifecycle: 'bootstrapping' })
      break
    case 'schedule_context': {
      if (!Number.isSafeInteger(transition.revision) || transition.revision < 1) throw new TypeError('invalid schedule revision')
      if (transition.revision <= state.scheduleRevision || state.lifecycle === 'exited' || state.lifecycle === 'degraded') return ignored(state)
      const resumed = state.mode === 'paused' && transition.mode !== 'paused'
      queueTrigger = resumed
      next = freeze({
        ...state,
        scheduleRevision: transition.revision,
        mode: transition.mode,
        cadence: transition.cadence,
        pendingTrigger: transition.mode === 'paused' ? false : state.pendingTrigger && !queueTrigger,
      })
      break
    }
    case 'trigger':
      if (state.lifecycle !== 'ready' || state.mode === 'paused') {
        if (state.lifecycle === 'exited' || state.lifecycle === 'degraded') return ignored(state)
        next = freeze({ ...state, pendingTrigger: state.mode === 'paused' ? false : true })
      } else {
        queueTrigger = !state.pendingTrigger
        next = freeze({ ...state, pendingTrigger: true })
      }
      break
    case 'ready':
      if (state.readySettled || state.lifecycle !== 'bootstrapping' || state.scheduleRevision < 1) return ignored(state)
      next = freeze({ ...state, lifecycle: 'ready', readySettled: true })
      queueTrigger = state.pendingTrigger && state.mode !== 'paused'
      break
    case 'begin_drain':
      if (state.lifecycle !== 'ready') return ignored(state)
      next = freeze({ ...state, lifecycle: 'draining', pendingTrigger: false })
      break
    case 'begin_shutdown':
      if (!['bootstrapping', 'ready', 'draining'].includes(state.lifecycle)) return ignored(state)
      next = freeze({ ...state, lifecycle: 'stopping', pendingTrigger: false })
      break
    case 'stopped':
      if (state.stoppedSettled || !['draining', 'stopping'].includes(state.lifecycle)) return ignored(state)
      next = freeze({ ...state, stoppedSettled: true })
      break
    case 'exit':
      if (state.exitSettled) return ignored(state)
      next = freeze({ ...state, lifecycle: 'exited', exitSettled: true, pendingTrigger: false })
      clearGenerationTasks = state.lifecycle !== 'degraded'
      break
    case 'fatal':
    case 'forced_termination':
    case 'deadline_expired':
      if (state.lifecycle === 'exited' || state.lifecycle === 'degraded') return ignored(state)
      next = freeze({ ...state, lifecycle: 'degraded', degradationReason: transition.reason, pendingTrigger: false })
      clearGenerationTasks = true
      break
  }

  return Object.freeze({ state: next, accepted: true, queueTrigger, clearGenerationTasks })
}
