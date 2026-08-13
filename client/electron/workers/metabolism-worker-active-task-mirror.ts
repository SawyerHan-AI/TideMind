import type { ActiveLLMTask } from '../../../src/llm/invocation-context.js'
import type { MetabolismWorkerToMainMessage } from './metabolism-worker-protocol.js'

export interface MirroredActiveTask {
  readonly origin: 'main' | 'scheduler-worker'
  readonly taskId: string
  readonly tier: ActiveLLMTask['tier']
  readonly connectionId: string | null
  readonly lifecycleGeneration: number | null
}

export class MetabolismWorkerActiveTaskMirror {
  private readonly tasks = new Map<string, MirroredActiveTask>()

  updateMain(task: ActiveLLMTask | null): void {
    for (const key of [...this.tasks.keys()]) if (key.startsWith('main:')) this.tasks.delete(key)
    if (task) this.tasks.set(`main:${task.taskId}`, Object.freeze({ ...task, origin: 'main', lifecycleGeneration: null }))
  }

  applyWorkerMessage(message: MetabolismWorkerToMainMessage): void {
    if (message.kind === 'active_llm_task_started') {
      const task = Object.freeze({
        origin: 'scheduler-worker' as const,
        taskId: message.taskId,
        tier: message.tier,
        connectionId: message.connectionId,
        lifecycleGeneration: message.lifecycleGeneration,
      })
      this.tasks.set(`scheduler-worker:${message.lifecycleGeneration}:${message.taskId}`, task)
    } else if (message.kind === 'active_llm_task_cleared') {
      this.tasks.delete(`scheduler-worker:${message.lifecycleGeneration}:${message.taskId}`)
    }
  }

  clearWorkerGeneration(lifecycleGeneration: number): void {
    const prefix = `scheduler-worker:${lifecycleGeneration}:`
    for (const key of [...this.tasks.keys()]) if (key.startsWith(prefix)) this.tasks.delete(key)
  }

  project(): MirroredActiveTask | null {
    return [...this.tasks.values()].sort((left, right) => {
      const origin = (left.origin === 'main' ? 0 : 1) - (right.origin === 'main' ? 0 : 1)
      if (origin !== 0) return origin
      const generation = (right.lifecycleGeneration ?? 0) - (left.lifecycleGeneration ?? 0)
      if (generation !== 0) return generation
      return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0
    })[0] ?? null
  }

  projectActiveLLMTask(): ActiveLLMTask | null {
    const projected = this.project()
    if (!projected) return null
    return Object.freeze({ taskId: projected.taskId, tier: projected.tier, connectionId: projected.connectionId })
  }
}
