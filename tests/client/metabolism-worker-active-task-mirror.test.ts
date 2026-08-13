import { describe, expect, it } from 'vitest'
import { MetabolismWorkerActiveTaskMirror } from '../../client/electron/workers/metabolism-worker-active-task-mirror.js'

describe('metabolism Worker active task mirror', () => {
  it('projects deterministically and clears only the exited generation', () => {
    const mirror = new MetabolismWorkerActiveTaskMirror()
    mirror.applyWorkerMessage({ protocolVersion: 1, lifecycleGeneration: 1, kind: 'active_llm_task_started', taskId: 'b', origin: 'scheduler-worker', purpose: 'llm', tier: 'light', connectionId: null })
    mirror.applyWorkerMessage({ protocolVersion: 1, lifecycleGeneration: 2, kind: 'active_llm_task_started', taskId: 'a', origin: 'scheduler-worker', purpose: 'llm', tier: 'heavy', connectionId: 'mc_12345678' })
    expect(mirror.project()).toMatchObject({ taskId: 'a', lifecycleGeneration: 2 })
    mirror.updateMain({ taskId: 'main-task', tier: 'standard', connectionId: null })
    expect(mirror.project()).toMatchObject({ origin: 'main', taskId: 'main-task' })
    mirror.clearWorkerGeneration(1)
    mirror.updateMain(null)
    expect(mirror.project()).toMatchObject({ taskId: 'a', lifecycleGeneration: 2 })
    expect(mirror.projectActiveLLMTask()).toEqual({ taskId: 'a', tier: 'heavy', connectionId: 'mc_12345678' })
  })
})
