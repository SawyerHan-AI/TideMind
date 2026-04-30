import { describe, expect, it } from 'vitest'
import { planReconcileActions, type ReconcileManifestEntry } from '../../client/electron/cloud/reconciler-utils.js'

function entry(
  id: string,
  updated: string | undefined,
  archived = false,
): ReconcileManifestEntry {
  return { id, updated: updated ?? '', archived }
}

describe('planReconcileActions', () => {
  it('covers the node reconcile contract matrix', () => {
    const local = [
      entry('local-active', '2026-04-30T00:00:00Z'),
      entry('local-archived', '2026-04-30T00:00:00Z', true),
      entry('active-local-newer', '2026-04-30T00:00:02Z'),
      entry('active-server-newer', '2026-04-30T00:00:00Z'),
      entry('local-archive-wins', '2026-04-01T00:00:00Z', true),
      entry('server-archive-wins', '2026-04-30T00:00:02Z'),
      entry('missing-updated-local', undefined),
      entry('missing-updated-same', undefined),
    ]
    const server = [
      entry('server-active', '2026-04-30T00:00:00Z'),
      entry('server-archived', '2026-04-30T00:00:00Z', true),
      entry('active-local-newer', '2026-04-30T00:00:00Z'),
      entry('active-server-newer', '2026-04-30T00:00:02Z'),
      entry('local-archive-wins', '2026-04-30T00:00:02Z'),
      entry('server-archive-wins', '2026-04-01T00:00:00Z', true),
      entry('missing-updated-local', '2026-04-30T00:00:00Z'),
      entry('missing-updated-same', undefined),
    ]

    const plan = planReconcileActions(local, server)

    expect(plan.onlyLocal.sort()).toEqual(['local-active', 'local-archived'])
    expect(plan.onlyServer.sort()).toEqual(['server-active', 'server-archived'])
    expect(plan.toUpload.sort()).toEqual([
      'active-local-newer',
      'local-active',
      'local-archive-wins',
      'local-archived',
    ])
    expect(plan.toDownload.sort()).toEqual([
      'active-server-newer',
      'missing-updated-local',
      'server-active',
      'server-archive-wins',
      'server-archived',
    ])
    expect(plan.conflicts.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'active-local-newer', winner: 'local' },
      { id: 'active-server-newer', winner: 'server' },
      { id: 'local-archive-wins', winner: 'local' },
      { id: 'missing-updated-local', winner: 'server' },
      { id: 'server-archive-wins', winner: 'server' },
    ])
  })

  it('does not create fake conflicts for timestamp format differences inside tolerance', () => {
    const plan = planReconcileActions(
      [entry('same', '2026-04-30 10:00:00')],
      [entry('same', '2026-04-30T10:00:00.500Z')],
    )

    expect(plan.toUpload).toEqual([])
    expect(plan.toDownload).toEqual([])
    expect(plan.conflicts).toEqual([])
  })
})
