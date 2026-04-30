import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { setupTestDb } from '../helpers/test-db.js'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: {
    isSupported: () => false,
  },
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
})
