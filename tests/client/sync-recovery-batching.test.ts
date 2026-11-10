import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTestDb, seedNode } from '../helpers/test-db.js'
import { CacheManager } from '../../client/electron/cloud/cache-manager.js'

vi.mock('../../client/node_modules/electron/index.js', () => ({
  BrowserWindow: { getAllWindows: () => [] }, Notification: { isSupported: () => false },
}))
vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudBaseUrl: () => 'https://cloud.test.example', refreshTokenIfNeeded: async () => 'fixture-token',
  updateCloudAuth: vi.fn(),
}))
import { CloudSyncClient } from '../../client/electron/cloud/sync-client.js'
import { Reconciler } from '../../client/electron/cloud/reconciler.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const nodeRow = (id: string, version: number | string = 10) => ({ id, content: 'synthetic sync fixture', type: 'fact', sync_version: version, created: '2026-01-01T00:00:00Z' })
const addPending = (db: ReturnType<typeof setupTestDb>, table: string, id: string, version: number) => db.prepare(
  "INSERT INTO cloud_sync_dead_letters(resource_table,resource_id,sync_version,payload,error_message) VALUES (?,?,?,'{}','fixture')",
).run(table, id, version)
const cursor = (db: ReturnType<typeof setupTestDb>) => db.prepare("SELECT value FROM metadata WHERE key='cloud_last_synced_version'").get()

describe('bounded recovery and page cursor commits', () => {
  it('re-fetches already-applied rows to clear historical failures, without advancing the pull cursor', async () => {
    const db = setupTestDb(); const client = new CloudSyncClient(db)
    const a = seedNode(db, { content: 'fixture A' }); const b = seedNode(db, { content: 'fixture B' })
    const row = { id: 'already-applied', from_id: a.id, to_id: b.id, sync_version: 10 }
    const cache = new CacheManager(db, 'https://cloud.test.example')
    await cache.applyChanges([{ table: 'links', action: 'upsert', data: row, sync_version: 10 }], '', false)
    addPending(db, 'links', row.id, 9)
    cache.setLastSyncedVersion(7)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [row] }))))
    await (client as unknown as { retryDeadLetters(token: string): Promise<void> }).retryDeadLetters('fixture-token')
    expect(db.prepare('SELECT count(*) AS n FROM cloud_sync_dead_letters').get()).toEqual({ n: 0 })
    expect(cursor(db)).toEqual({ value: '7' })
    client.stop(); db.close()
  })

  it('limits a recovery snapshot to 2000 and each HTTP request to 200 while prioritizing nodes', async () => {
    const db = setupTestDb(); const client = new CloudSyncClient(db)
    db.transaction(() => { for (let i = 0; i < 2001; i++) addPending(db, 'nodes', `fixture-${String(i).padStart(4, '0')}`, 10) })()
    addPending(db, 'links', 'unready-link', 10)
    const sizes: number[] = []; const tables: string[] = []
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(String(input)); const ids = url.searchParams.get('ids')!.split(',')
      sizes.push(ids.length); tables.push(url.searchParams.get('table')!)
      return new Response(JSON.stringify({ items: ids.map(id => nodeRow(id)) }))
    }))
    await (client as unknown as { retryDeadLetters(token: string): Promise<void> }).retryDeadLetters('fixture-token')
    expect(sizes).toHaveLength(10); expect(Math.max(...sizes)).toBe(200)
    expect(tables.every(table => table === 'nodes')).toBe(true)
    expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 2000 })
    expect(db.prepare('SELECT count(*) AS n FROM cloud_sync_dead_letters').get()).toEqual({ n: 2 })
    expect(cursor(db)).toBeUndefined()
    client.stop(); db.close()
  }, 30000)

  it('stops recovery after a failed apply and does not downgrade a newer pending version', async () => {
    const db = setupTestDb(); const client = new CloudSyncClient(db)
    addPending(db, 'links', 'missing-parents', 20)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'missing-parents', from_id: 'absent-a', to_id: 'absent-b', sync_version: 10 }] }))))
    await (client as unknown as { retryDeadLetters(token: string): Promise<void> }).retryDeadLetters('fixture-token')
    expect(db.prepare('SELECT sync_version FROM cloud_sync_dead_letters').get()).toEqual({ sync_version: 20 })
    expect(fetch).toHaveBeenCalledTimes(1)
    client.stop(); db.close()
  })

  it('keeps the page cursor unchanged when stopped between equal-version chunks, then replays safely', async () => {
    const db = setupTestDb(); const client = new CloudSyncClient(db)
    const cache = new CacheManager(db, 'https://cloud.test.example'); cache.setLastSyncedVersion(7)
    const changes = Array.from({ length: 200 }, (_, i) => ({ table: 'nodes', action: 'upsert', sync_version: '10', data: nodeRow(`page-${i}`) }))
    const fetchMock = vi.fn(async (_input: unknown) => new Response(JSON.stringify({ changes, has_more: false })))
    vi.stubGlobal('fetch', fetchMock)
    const original = CacheManager.prototype.applyChanges; let first = true
    vi.spyOn(CacheManager.prototype, 'applyChanges').mockImplementation(async function (changes, token, advance) {
      const result = await original.call(this, changes, token, advance)
      if (first) { first = false; setImmediate(() => client.stop()) }
      return result
    })
    expect(await client.pullChanges('fixture-token')).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 25 })
    expect(cursor(db)).toEqual({ value: '7' })
    const resumed = new CloudSyncClient(db)
    expect(await resumed.pullChanges('fixture-token')).toBe(200)
    expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 200 })
    expect(cursor(db)).toEqual({ value: '10' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=200')
    resumed.stop(); db.close()
  }, 30000)

  it.each([null, '', false, 1.5, '9007199254740992'])('rejects an invalid tail version %s before applying any page rows', async version => {
    const db = setupTestDb(); const client = new CloudSyncClient(db)
    const changes = Array.from({ length: 26 }, (_, i) => ({ table: 'nodes', action: 'upsert', sync_version: i === 25 ? version : 10, data: nodeRow(`bad-page-${i}`) }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ changes, has_more: false }))))
    await expect(client.pullChanges('fixture-token')).rejects.toThrow('Invalid sync row version')
    expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 0 })
    expect(cursor(db)).toBeUndefined()
    client.stop(); db.close()
  })
})

describe('reconcile network batches preserve short local transactions', () => {
  function plan(db: ReturnType<typeof setupTestDb>, count: number) {
    const reconciler = new Reconciler(db)
    const internals = reconciler as unknown as {
      fetchServerManifest(table: string): Promise<unknown[]>;
      bulkFetch(table: string, ids: string[]): Promise<Array<Record<string, unknown>>>;
      applyServerRows(table: string, rows: Array<Record<string, unknown>>): void;
    }
    const rows = Array.from({ length: count }, (_, i) => nodeRow(`reconcile-${i}`, i + 1))
    vi.spyOn(internals, 'fetchServerManifest').mockImplementation(async table => table === 'nodes' ? rows.map(row => ({ id: row.id, updated: row.created, sync_version: row.sync_version, archived: false })) : [])
    const network = vi.spyOn(internals, 'bulkFetch').mockImplementation(async (_table, ids) => rows.filter(row => ids.includes(row.id)))
    const apply = vi.spyOn(internals, 'applyServerRows')
    return { reconciler, internals, network, apply }
  }

  it('downloads 201 rows in two requests and applies at most 25 at a time', async () => {
    const db = setupTestDb(); const { reconciler, network, apply } = plan(db, 201)
    addPending(db, 'nodes', 'reconcile-0', 1)
    await reconciler.runAll(true)
    expect(network.mock.calls.map(call => call[1].length)).toEqual([200, 1])
    expect(Math.max(...apply.mock.calls.map(call => call[1].length))).toBe(25)
    expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 201 })
    expect(db.prepare('SELECT count(*) AS n FROM cloud_sync_dead_letters').get()).toEqual({ n: 0 })
    expect(cursor(db)).toBeUndefined()
    db.close()
  }, 30000)

  it('does not mark a table complete if cancelled between local chunks', async () => {
    const db = setupTestDb(); const { reconciler, internals, apply } = plan(db, 200)
    apply.mockRestore()
    const method = internals.applyServerRows.bind(reconciler)
    vi.spyOn(internals, 'applyServerRows').mockImplementation((table, rows) => { method(table, rows); reconciler.abort() })
    await reconciler.runAll(true)
    expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 25 })
    expect(db.prepare("SELECT value FROM metadata WHERE key='cloud.last_reconcile_at_nodes'").get()).toBeUndefined()
    db.close()
  }, 30000)
})

it('stops recovery between short local chunks without advancing the cursor', async () => {
  const db = setupTestDb(); const client = new CloudSyncClient(db)
  db.transaction(() => { for (let i = 0; i < 201; i++) addPending(db, 'nodes', `stop-${String(i).padStart(3, '0')}`, 10) })()
  vi.stubGlobal('fetch', vi.fn(async input => {
    const ids = new URL(String(input)).searchParams.get('ids')!.split(',')
    return new Response(JSON.stringify({ items: ids.map(id => nodeRow(id)) }))
  }))
  const original = CacheManager.prototype.applyChanges; let first = true
  vi.spyOn(CacheManager.prototype, 'applyChanges').mockImplementation(async function (changes, token, advance) {
    const result = await original.call(this, changes, token, advance)
    if (first) { first = false; setImmediate(() => client.stop()) }
    return result
  })
  await (client as unknown as { retryDeadLetters(token: string): Promise<void> }).retryDeadLetters('fixture-token')
  expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 25 })
  expect(db.prepare('SELECT count(*) AS n FROM cloud_sync_dead_letters').get()).toEqual({ n: 176 })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(cursor(db)).toBeUndefined()
  db.close()
}, 30000)

it('stops a recovery snapshot after an HTTP failure', async () => {
  const db = setupTestDb(); const client = new CloudSyncClient(db)
  db.transaction(() => { for (let i = 0; i < 201; i++) addPending(db, 'nodes', `network-${i}`, 10) })()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('temporarily unavailable', { status: 503 })))
  await expect((client as unknown as { retryDeadLetters(token: string): Promise<void> }).retryDeadLetters('fixture-token')).rejects.toThrow('503')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(db.prepare('SELECT count(*) AS n FROM cloud_sync_dead_letters').get()).toEqual({ n: 201 })
  expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 0 })
  client.stop(); db.close()
}, 30000)

it.each([null, false, '', 1.5])('rejects recovery version %s before writing any response rows', async sync_version => {
  const db = setupTestDb(); const client = new CloudSyncClient(db)
  addPending(db, 'nodes', 'first-good', 9)
  addPending(db, 'nodes', 'invalid-recovery-version', 0)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    nodeRow('first-good', 10), { ...nodeRow('invalid-recovery-version'), sync_version },
  ] }))))
  await expect((client as unknown as { retryDeadLetters(token: string): Promise<void> }).retryDeadLetters('fixture-token')).rejects.toThrow('Invalid sync row version')
  expect(db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM cloud_sync_dead_letters').get()).toEqual({ n: 2 })
  expect(cursor(db)).toBeUndefined()
  client.stop(); db.close()
})
