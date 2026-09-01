import type {
  AgentIntegrationApplyTaskDto,
  AgentIntegrationInstallationDto,
} from '../../../lib/api-contract'

export function partitionManageableInstallationIds(
  installationIds: readonly string[],
  installations: readonly AgentIntegrationInstallationDto[],
): { retryable: string[]; unavailable: string[] } {
  const manageable = new Set(installations.filter(item => item.manageable).map(item => item.id))
  return installationIds.reduce<{ retryable: string[]; unavailable: string[] }>((result, id) => {
    result[manageable.has(id) ? 'retryable' : 'unavailable'].push(id)
    return result
  }, { retryable: [], unavailable: [] })
}

export function applyTaskPresentationPriority(task: AgentIntegrationApplyTaskDto): number {
  if (task.state === 'running') return 0
  if (task.results.some(result => (
    result.status !== 'committed' && result.status !== 'awaiting_verification'
  )) || task.results.length === 0) return 1
  if (task.results.some(result => result.status === 'awaiting_verification')) return 2
  return 3
}

export function prioritizeApplyTasks(
  tasks: readonly AgentIntegrationApplyTaskDto[],
): AgentIntegrationApplyTaskDto[] {
  return [...tasks].sort((left, right) => (
    applyTaskPresentationPriority(left) - applyTaskPresentationPriority(right)
    || right.startedAt.localeCompare(left.startedAt)
    || right.id.localeCompare(left.id)
  ))
}

export function applyTaskProgressRefreshDelay(
  tasks: readonly AgentIntegrationApplyTaskDto[],
  pinnedTask?: AgentIntegrationApplyTaskDto | null,
): number | null {
  const pinnedKey = pinnedTask?.feedKey ?? (pinnedTask ? `task:${pinnedTask.id}` : null)
  const pollingTasks = pinnedTask && !tasks.some(task => (
    (task.feedKey ?? `task:${task.id}`) === pinnedKey
  )) ? [...tasks, pinnedTask] : tasks
  if (pollingTasks.some(task => task.state === 'running')) return 1_500
  // Host recognition and recovery can advance an applied_unverified run after
  // the batch itself completed. Poll only while such an automatic transition
  // remains possible; stable success and actionable terminal failures stop it.
  return pollingTasks.some(task => task.results.some(result => result.status === 'awaiting_verification'))
    ? 5_000
    : null
}

export function mergeApplyTaskProgress(
  current: AgentIntegrationApplyTaskDto | null,
  incoming: AgentIntegrationApplyTaskDto,
): AgentIntegrationApplyTaskDto {
  if (!current || current.id === incoming.id) return incoming
  const priority = applyTaskPresentationPriority(incoming) - applyTaskPresentationPriority(current)
  if (priority < 0) return incoming
  if (priority === 0 && incoming.startedAt > current.startedAt) return incoming
  return current
}

export function recoverVisibleApplyTask(
  current: AgentIntegrationApplyTaskDto | null,
  tasks: readonly AgentIntegrationApplyTaskDto[],
): AgentIntegrationApplyTaskDto | null {
  const prioritized = prioritizeApplyTasks(tasks)
  const best = prioritized[0]
  if (current) {
    const refreshed = tasks.find(task => task.id === current.id)
    if (refreshed && (!best
      || applyTaskPresentationPriority(refreshed) <= applyTaskPresentationPriority(best))) return refreshed
  }
  return best ?? current
}

export function isStaleTaskFeedCursorError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('stale_task_feed_cursor')
}

export function isUnknownApplyTaskError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('unknown Agent integration task')
}
