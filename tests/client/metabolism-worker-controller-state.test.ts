import { describe, expect, it } from 'vitest'
import {
  createMetabolismWorkerControllerState,
  reduceMetabolismWorkerControllerState,
} from '../../client/electron/workers/metabolism-worker-controller-state.js'

describe('metabolism worker controller state', () => {
  it('requires schedule context before ready and settles lifecycle events once', () => {
    let state = createMetabolismWorkerControllerState(3)
    state = reduceMetabolismWorkerControllerState(state, { kind: 'worker_spawned', lifecycleGeneration: 3 }).state

    expect(reduceMetabolismWorkerControllerState(state, { kind: 'ready', lifecycleGeneration: 3 }).accepted).toBe(false)
    state = reduceMetabolismWorkerControllerState(state, {
      kind: 'schedule_context', lifecycleGeneration: 3, revision: 1, mode: 'background', cadence: 'active',
    }).state
    const ready = reduceMetabolismWorkerControllerState(state, { kind: 'ready', lifecycleGeneration: 3 })
    expect(ready.state.lifecycle).toBe('ready')
    expect(reduceMetabolismWorkerControllerState(ready.state, { kind: 'ready', lifecycleGeneration: 3 }).accepted).toBe(false)

    const stopping = reduceMetabolismWorkerControllerState(ready.state, { kind: 'begin_shutdown', lifecycleGeneration: 3 }).state
    const stopped = reduceMetabolismWorkerControllerState(stopping, { kind: 'stopped', lifecycleGeneration: 3 })
    expect(stopped.accepted).toBe(true)
    expect(reduceMetabolismWorkerControllerState(stopped.state, { kind: 'stopped', lifecycleGeneration: 3 }).accepted).toBe(false)
    const exited = reduceMetabolismWorkerControllerState(stopped.state, { kind: 'exit', lifecycleGeneration: 3 })
    expect(exited.state.lifecycle).toBe('exited')
    expect(exited.clearGenerationTasks).toBe(true)
  })

  it('ignores old generation and stale schedule revisions', () => {
    let state = createMetabolismWorkerControllerState(8)
    expect(reduceMetabolismWorkerControllerState(state, { kind: 'fatal', lifecycleGeneration: 7, reason: 'old' }).accepted).toBe(false)
    state = reduceMetabolismWorkerControllerState(state, { kind: 'worker_spawned', lifecycleGeneration: 8 }).state
    state = reduceMetabolismWorkerControllerState(state, {
      kind: 'schedule_context', lifecycleGeneration: 8, revision: 2, mode: 'paused', cadence: 'idle',
    }).state
    const stale = reduceMetabolismWorkerControllerState(state, {
      kind: 'schedule_context', lifecycleGeneration: 8, revision: 1, mode: 'background', cadence: 'active',
    })
    expect(stale.accepted).toBe(false)
    expect(stale.state.mode).toBe('paused')
  })

  it('paused clears admission and resume queues exactly one trigger', () => {
    let state = createMetabolismWorkerControllerState(4)
    state = reduceMetabolismWorkerControllerState(state, { kind: 'worker_spawned', lifecycleGeneration: 4 }).state
    state = reduceMetabolismWorkerControllerState(state, {
      kind: 'schedule_context', lifecycleGeneration: 4, revision: 1, mode: 'paused', cadence: 'idle',
    }).state
    expect(reduceMetabolismWorkerControllerState(state, { kind: 'trigger', lifecycleGeneration: 4 }).state.pendingTrigger).toBe(false)

    const resumed = reduceMetabolismWorkerControllerState(state, {
      kind: 'schedule_context', lifecycleGeneration: 4, revision: 2, mode: 'foreground', cadence: 'active',
    })
    expect(resumed.queueTrigger).toBe(true)
    const repeated = reduceMetabolismWorkerControllerState(resumed.state, {
      kind: 'schedule_context', lifecycleGeneration: 4, revision: 2, mode: 'foreground', cadence: 'active',
    })
    expect(repeated.accepted).toBe(false)
    expect(repeated.queueTrigger).toBe(false)
  })

  it('fatal and deadline transitions degrade once and clear only the current generation tasks', () => {
    let state = createMetabolismWorkerControllerState(5)
    state = reduceMetabolismWorkerControllerState(state, { kind: 'worker_spawned', lifecycleGeneration: 5 }).state
    const fatal = reduceMetabolismWorkerControllerState(state, { kind: 'fatal', lifecycleGeneration: 5, reason: 'bootstrap_failed' })
    expect(fatal.state.lifecycle).toBe('degraded')
    expect(fatal.clearGenerationTasks).toBe(true)
    expect(reduceMetabolismWorkerControllerState(fatal.state, { kind: 'deadline_expired', lifecycleGeneration: 5, reason: 'late' }).accepted).toBe(false)
  })
})
