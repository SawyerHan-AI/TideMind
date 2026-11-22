import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { setupTestDb } from '../helpers/test-db.js'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: {
    isSupported: () => false,
  },
  app: { getVersion: () => '0.0.0-test' },
}))

const roleEnv = vi.hoisted(() => ({ registration: { id: 'dev-2', isPrimary: false, primaryDeviceId: 'dev-1', revision: 3, cloudNotUpgraded: false } as Record<string, unknown> | null }))
vi.mock('../../client/electron/cloud/primary-device.js', () => ({
  syncRoleOutcome: vi.fn(async () => roleEnv.registration
    ? { status: 'registered', registration: roleEnv.registration }
    : { status: 'transient', detail: 'offline' }),
}))

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudBaseUrl: () => 'https://cloud.test.example',
  refreshTokenIfNeeded: vi.fn(async () => 'token'),
}))

import { Reconciler } from '../../client/electron/cloud/reconciler.js'

function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function manifestResponse(): Response {
  return new Response(JSON.stringify({ items: [], has_more: false, next_cursor: null }), { status: 200 })
}

describe('Reconciler metadata semantics', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks table-level failure after a successful table as partial and retries the failed table later', async () => {
    const db = setupTestDb()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/manifest') && url.includes('table=nodes')) return manifestResponse()
      if (url.includes('/manifest') && url.includes('table=links')) {
        return new Response('links unavailable', { status: 500 })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const results = await new Reconciler(db).runAll(false)

    expect(results.map(result => ({ table: result.table, errors: result.errors.length }))).toEqual([
      { table: 'nodes', errors: 0 },
      { table: 'links', errors: 1 },
    ])
    expect(readMeta(db, 'cloud.last_reconcile_status')).toBe('partial')
    expect(readMeta(db, 'cloud.last_reconcile_at_nodes')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(readMeta(db, 'cloud.last_reconcile_at_links')).toBeNull()
    expect(readMeta(db, 'cloud.last_reconcile_error')).toContain('manifest 500')
  })

  it('clears stale reconcile errors after a clean run', async () => {
    const db = setupTestDb()
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('cloud.last_reconcile_error', 'old failure')
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/manifest')) return manifestResponse()
      throw new Error(`unexpected fetch ${url}`)
    })

    const results = await new Reconciler(db).runAll(false)

    expect(results.every(result => result.errors.length === 0)).toBe(true)
    expect(readMeta(db, 'cloud.last_reconcile_status')).toBe('ok')
    expect(readMeta(db, 'cloud.last_reconcile_error')).toBe('')
  })

  it('primary-device rejections are handled, excluded from later uploads, and do not leave the reconcile unfinished', async () => {
    const { seedNode } = await import('../helpers/test-db.js')
    const db = setupTestDb()
    const memory = seedNode(db, { content: '用户记忆' })
    const crystal = seedNode(db, { content: '周结晶' })
    db.prepare("UPDATE nodes SET is_crystal = 1, source_tool = 'temporal-crystal' WHERE id = ?").run(crystal.id)
    const uploads: Array<{ ids: string[]; header?: string; initial: boolean }> = []
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/manifest')) return manifestResponse()
      if (url.includes('/bulk-upsert')) {
        const body = JSON.parse(init!.body as string)
        const ids = body.items.map((i: { id: string }) => i.id) as string[]
        uploads.push({ ids, header: (init!.headers as Record<string, string>)['X-TideMind-Installation-Id'], initial: body.is_initial_reconcile })
        const skipped = ids.includes(crystal.id) ? [{ id: crystal.id, reason: 'not_primary_device' }] : []
        return new Response(JSON.stringify({ processed: ids.length - skipped.length, skipped }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const first = await new Reconciler(db).runAll(false)
    expect(first.map(r => r.skipped)).toEqual([0, 0])
    expect(uploads[0].ids.sort()).toEqual([crystal.id, memory.id].sort())
    expect(uploads[0].header).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(readMeta(db, 'cloud.last_reconcile_status')).toBe('ok')
    expect(readMeta(db, 'cloud.last_reconcile_at_nodes')).toMatch(/^\d{4}-/)
    expect(db.prepare('SELECT archived FROM nodes WHERE id = ?').get(crystal.id)).toEqual({ archived: 1 })

    uploads.length = 0
    await new Reconciler(db).runAll(false)
    expect(uploads.flatMap(u => u.ids)).not.toContain(crystal.id)
  })

  it('other skip reasons still leave the reconcile unfinished', async () => {
    const { seedNode } = await import('../helpers/test-db.js')
    const db = setupTestDb()
    const memory = seedNode(db, { content: '用户记忆' })
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/manifest')) return manifestResponse()
      if (url.includes('/bulk-upsert')) return new Response(JSON.stringify({ processed: 0, skipped: [{ id: memory.id, reason: 'quota_exhausted' }] }), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })
    await new Reconciler(db).runAll(false)
    expect(readMeta(db, 'cloud.last_reconcile_at_nodes')).toBeNull()
    expect(readMeta(db, 'cloud.last_reconcile_status')).toBe('partial')
  })
})
