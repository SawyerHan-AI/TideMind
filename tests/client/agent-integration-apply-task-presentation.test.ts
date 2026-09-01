import { describe, expect, it } from 'vitest'
import type {
  AgentIntegrationApplyTaskDto,
  AgentIntegrationInstallationDto,
} from '../../client/src/lib/api-contract'
import {
  applyTaskProgressRefreshDelay,
  applyTaskPresentationPriority,
  prioritizeApplyTasks,
  mergeApplyTaskProgress,
  isStaleTaskFeedCursorError,
  isUnknownApplyTaskError,
  partitionManageableInstallationIds,
  recoverVisibleApplyTask,
} from '../../client/src/components/settings/agent-integration-managed/apply-task-presentation'
import { executionInstallationIds } from '../../client/src/components/settings/agent-integration-managed/presentation'

function task(overrides: Partial<AgentIntegrationApplyTaskDto> = {}): AgentIntegrationApplyTaskDto {
  return {
    id: 'agent_apply_1',
    planHash: 'a'.repeat(64),
    installationIds: ['installation-1'],
    pendingInstallationIds: ['installation-1'],
    results: [],
    state: 'running',
    startedAt: '2026-08-26T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

describe('Agent Integration apply task presentation recovery', () => {
  it('adopts a live event after the page was unmounted and remounted without local task state', () => {
    expect(mergeApplyTaskProgress(null, task())).toEqual(task())
  })

  it('reclaims the enumerated task and refreshes the exact task after remount', () => {
    const running = task()
    expect(recoverVisibleApplyTask(null, [running])).toEqual(running)
    const completed = task({
      state: 'completed', pendingInstallationIds: [], completedAt: '2026-08-26T00:01:00.000Z',
      results: [{ installationId: 'installation-1', status: 'committed', runId: 'run-1' }],
    })
    expect(recoverVisibleApplyTask(running, [completed])).toEqual(completed)
  })

  it('selects only exact needs-recovery Installations for a fresh preview', () => {
    const results: AgentIntegrationApplyTaskDto['results'] = [
      { installationId: 'failed', status: 'failed' },
      { installationId: 'recovery-a', status: 'needs_recovery', runId: 'run-a' },
      { installationId: 'committed', status: 'committed' },
      { installationId: 'recovery-b', status: 'needs_recovery', runId: 'run-b' },
      { installationId: 'interrupted', status: 'interrupted' },
    ]
    expect(executionInstallationIds(results, 'needs_recovery'))
      .toEqual(['recovery-a', 'recovery-b'])
    expect(executionInstallationIds(results, 'interrupted')).toEqual(['interrupted'])
  })

  it('retries interrupted items only when the exact current Installation remains manageable', () => {
    const installations = [
      { id: 'manageable', manageable: true },
      { id: 'trust-lost', manageable: false },
      { id: 'eligibility-lost', manageable: false },
    ] as AgentIntegrationInstallationDto[]
    expect(partitionManageableInstallationIds(
      ['manageable', 'uninstalled', 'trust-lost', 'eligibility-lost'],
      installations,
    )).toEqual({
      retryable: ['manageable'],
      unavailable: ['uninstalled', 'trust-lost', 'eligibility-lost'],
    })
  })

  it('orders running, actionable attention, awaiting verification, then success', () => {
    const success = task({
      id: 'success', state: 'completed', pendingInstallationIds: [], completedAt: '2026-08-26T00:04:00.000Z',
      startedAt: '2026-08-26T00:04:00.000Z',
      results: [{ installationId: 'installation-1', status: 'committed' }],
    })
    const awaiting = task({
      id: 'awaiting', state: 'completed', pendingInstallationIds: [], completedAt: '2026-08-26T00:03:00.000Z',
      startedAt: '2026-08-26T00:03:00.000Z',
      results: [{ installationId: 'installation-1', status: 'awaiting_verification' }],
    })
    const attention = task({
      id: 'attention', state: 'completed', pendingInstallationIds: [], completedAt: '2026-08-26T00:02:00.000Z',
      startedAt: '2026-08-26T00:02:00.000Z',
      results: [{ installationId: 'installation-1', status: 'interrupted' }],
    })
    const running = task({ id: 'running', startedAt: '2026-08-26T00:01:00.000Z' })

    expect(prioritizeApplyTasks([success, awaiting, attention, running]).map(item => item.id))
      .toEqual(['running', 'attention', 'awaiting', 'success'])
    expect(recoverVisibleApplyTask(success, [success, attention])).toEqual(attention)
    expect(mergeApplyTaskProgress(success, attention)).toEqual(attention)
  })

  it('refreshes a completed progressable task without remount and stops at an actionable terminal state', () => {
    const awaiting = task({
      state: 'completed', pendingInstallationIds: [], completedAt: '2026-08-26T00:01:00.000Z',
      results: [{ installationId: 'installation-1', status: 'awaiting_verification', runId: 'run-1' }],
    })
    expect(applyTaskProgressRefreshDelay([awaiting])).toBe(5_000)

    const needsRecovery = task({
      state: 'completed', pendingInstallationIds: [], completedAt: '2026-08-26T00:02:00.000Z',
      results: [{ installationId: 'installation-1', status: 'needs_recovery', runId: 'run-1' }],
    })
    expect(recoverVisibleApplyTask(awaiting, [needsRecovery])).toEqual(needsRecovery)
    expect(applyTaskProgressRefreshDelay([needsRecovery])).toBeNull()
    expect(applyTaskProgressRefreshDelay([task()])).toBe(1_500)
  })

  it('keeps polling one exact awaiting task pinned outside the bounded current page', () => {
    const page = Array.from({ length: 20 }, (_, index) => task({
      id: `page-${index}`,
      feedKey: `task:page-${index}`,
      state: 'completed',
      pendingInstallationIds: [],
      completedAt: '2026-08-26T00:01:00.000Z',
      results: [{ installationId: 'installation-1', status: 'committed' }],
    }))
    const pinned = task({
      id: 'page-two-awaiting',
      feedKey: 'task:page-two-awaiting',
      state: 'completed',
      pendingInstallationIds: [],
      completedAt: '2026-08-26T00:02:00.000Z',
      results: [{
        installationId: 'installation-1', status: 'awaiting_verification', runId: 'run-page-two',
      }],
    })
    expect(applyTaskProgressRefreshDelay(page, pinned)).toBe(5_000)
    expect(applyTaskProgressRefreshDelay([...page, pinned], pinned)).toBe(5_000)
  })

  it('does not poll a fail-closed task whose stored run semantics were not exact', () => {
    const operationMismatch = task({
      id: 'operation-mismatch', state: 'completed', pendingInstallationIds: [],
      completedAt: '2026-08-26T00:01:00.000Z',
      results: [{
        installationId: 'installation-1',
        status: 'interrupted',
        reason: 'Stored task result is not bound to its exact connect run; inspect and preview again',
      }],
    })
    expect(applyTaskProgressRefreshDelay([operationMismatch])).toBeNull()
    expect(applyTaskPresentationPriority(operationMismatch)).toBe(1)
  })

  it('resets pagination only for the explicit stale-cursor failure code', () => {
    expect(isStaleTaskFeedCursorError(new Error('stale_task_feed_cursor'))).toBe(true)
    expect(isStaleTaskFeedCursorError(new Error(
      'Error invoking remote method: Error: stale_task_feed_cursor',
    ))).toBe(true)
    expect(isStaleTaskFeedCursorError(new Error('database is locked'))).toBe(false)
    expect(isStaleTaskFeedCursorError({ message: 'stale_task_feed_cursor' })).toBe(false)
    expect(isUnknownApplyTaskError(new Error('unknown Agent integration task'))).toBe(true)
    expect(isUnknownApplyTaskError(new Error('database is locked'))).toBe(false)
  })
})
