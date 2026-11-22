import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'

// registration=null 表示“问不到”（暂时失败）；outcome 可直接指定其他注册结果。
const env = vi.hoisted(() => ({
  registration: null as null | Record<string, unknown>,
  outcome: null as null | Record<string, unknown>,
  roleChecks: 0,
}))
vi.mock('../../client/electron/cloud/primary-device.js', () => ({
  syncRoleOutcome: vi.fn(async () => {
    env.roleChecks++
    if (env.outcome) return env.outcome
    return env.registration ? { status: 'registered', registration: env.registration } : { status: 'transient', detail: 'offline' }
  }),
}))
vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudBaseUrl: () => 'https://cloud.test',
  refreshTokenIfNeeded: vi.fn(async () => 'token'),
}))
const mockApp = vi.hoisted(() => ({ getVersion: () => '0.0.0-test' }))
vi.mock('electron', () => ({ app: mockApp, default: { app: mockApp } }))
vi.mock('../../client/node_modules/electron/index.js', () => ({ app: mockApp, default: { app: mockApp } }))

import { setupTestDb, seedNode, seedLink } from '../helpers/test-db.js'
import { handleUploadRejections } from '../../client/electron/cloud/upload-rejections.js'
import { claimDirty, pumpUplink } from '../../client/electron/cloud/uplink.js'
import { isExcludedFromCloudSync, releaseExcludedByReason } from '../../src/db/cloud-sync-exclusions.js'
import { clearDeferredUploads, isUploadDeferred } from '../../client/electron/cloud/upload-deferral.js'

let db: Database.Database
const notPrimary = { id: 'dev-2', isPrimary: false, primaryDeviceId: 'dev-1', revision: 3, cloudNotUpgraded: false }
const dirty = (table: string) => (db.prepare('SELECT id FROM cloud_dirty WHERE tbl = ? ORDER BY id').all(table) as Array<{ id: string }>).map(r => r.id)
const node = (id: string) => db.prepare('SELECT archived, is_superseded FROM nodes WHERE id = ?').get(id) as { archived: number; is_superseded: number }
function crystalWithLink() {
  const memory = seedNode(db, { content: '星海科技 DataPilot 上线' })
  const crystal = seedNode(db, { content: '周结晶' })
  db.prepare("UPDATE nodes SET is_crystal = 1, source_tool = 'temporal-crystal' WHERE id = ?").run(crystal.id)
  const link = seedLink(db, crystal.id, memory.id, { status: 'confirmed' })!
  db.prepare('DELETE FROM cloud_dirty').run()
  return { memory, crystal, link }
}

beforeEach(() => { db = setupTestDb(); env.registration = notPrimary; env.outcome = null; env.roleChecks = 0; clearDeferredUploads() })
afterEach(() => { vi.restoreAllMocks(); db.close() })

describe('upload rejections', () => {
  it('not the primary device: archives the rejected result, soft-deletes and excludes its links, uploads nothing new', async () => {
    const { memory, crystal, link } = crystalWithLink()
    const out = await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])
    expect(out).toEqual({ handled: [crystal.id], requeued: [] })
    expect(node(crystal.id).archived).toBe(1)
    expect(node(memory.id).archived).toBe(0)
    expect(db.prepare('SELECT deleted FROM links WHERE id = ?').get(link.id)).toEqual({ deleted: 1 })
    expect(isExcludedFromCloudSync(db, 'nodes', crystal.id)).toBe(true)
    expect(isExcludedFromCloudSync(db, 'links', link.id)).toBe(true)
    expect(dirty('nodes')).toEqual([])
    expect(dirty('links')).toEqual([])
    // idempotent
    expect((await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])).handled).toEqual([crystal.id])
  })

  it('still the primary device after re-checking: requeues, archives nothing', async () => {
    const { crystal, link } = crystalWithLink()
    env.registration = { ...notPrimary, isPrimary: true }
    const out = await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])
    expect(out).toEqual({ handled: [], requeued: [crystal.id] })
    expect(node(crystal.id).archived).toBe(0)
    expect(db.prepare('SELECT deleted FROM links WHERE id = ?').get(link.id)).toEqual({ deleted: 0 })
    expect(dirty('nodes')).toEqual([crystal.id])
    expect(isExcludedFromCloudSync(db, 'nodes', crystal.id)).toBe(false)
  })

  it('cannot reach the server: requeues without any irreversible change', async () => {
    const { crystal } = crystalWithLink()
    env.registration = null
    const out = await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])
    expect(out.requeued).toEqual([crystal.id])
    expect(node(crystal.id).archived).toBe(0)
  })

  it('a rejected profile supersede is only excluded; local data is untouched', async () => {
    const profile = seedNode(db, { content: '画像 v1' })
    db.prepare("UPDATE nodes SET is_meta = 1, source_tool = 'profile-synthesize', is_superseded = 1 WHERE id = ?").run(profile.id)
    db.prepare('DELETE FROM cloud_dirty').run()
    const out = await handleUploadRejections(db, 'nodes', [{ id: profile.id, reason: 'not_primary_device' }])
    expect(out.handled).toEqual([profile.id])
    expect(node(profile.id)).toEqual({ archived: 0, is_superseded: 1 })
    expect(isExcludedFromCloudSync(db, 'nodes', profile.id)).toBe(true)
  })

  it('never archives a user memory, and ignores other skip reasons', async () => {
    const memory = seedNode(db, { content: '用户记忆' })
    const out = await handleUploadRejections(db, 'nodes', [
      { id: memory.id, reason: 'not_primary_device' }, { id: 'x', reason: 'quota_exhausted' }, { id: 'y', reason: 'endpoint_missing' },
    ])
    expect(out.handled).toEqual([])
    expect(node(memory.id).archived).toBe(0)
    expect(isExcludedFromCloudSync(db, 'nodes', memory.id)).toBe(false)
  })

  it('excluded records are never claimed for upload', () => {
    const { crystal } = crystalWithLink()
    db.prepare("INSERT INTO cloud_dirty (tbl, id) VALUES ('nodes', ?)").run(crystal.id)
    db.prepare("INSERT INTO cloud_sync_excluded (tbl, id, reason, created) VALUES ('nodes', ?, 'not_primary_device', 't')").run(crystal.id)
    expect(claimDirty(db, 'nodes', 50)).toEqual([])
  })

  it('uplink sends the installation id and does not upload the links of a rejected node', async () => {
    const memory = seedNode(db, { content: '用户记忆' })
    const crystal = seedNode(db, { content: '周结晶' })
    db.prepare("UPDATE nodes SET is_crystal = 1, source_tool = 'temporal-crystal' WHERE id = ?").run(crystal.id)
    const link = seedLink(db, crystal.id, memory.id, { status: 'confirmed' })!
    const calls: Array<{ table: string; ids: string[]; header?: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string)
      const ids = body.items.map((i: { id: string }) => i.id)
      calls.push({ table: body.table, ids, header: ((init as RequestInit).headers as Record<string, string>)['X-TideMind-Installation-Id'] })
      const skipped = body.table === 'nodes' && ids.includes(crystal.id) ? [{ id: crystal.id, reason: 'not_primary_device' }] : []
      return new Response(JSON.stringify({ processed: ids.length - skipped.length, skipped }), { status: 200 })
    })
    await pumpUplink(db)
    expect(calls[0].table).toBe('nodes')
    expect(calls[0].header).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(calls.filter(c => c.table === 'links').flatMap(c => c.ids)).not.toContain(link.id)
    expect(node(crystal.id).archived).toBe(1)
    expect(dirty('links')).toEqual([])
  })
  it('device limit reached: parks the result and its links without archiving; released once registered', async () => {
    const { crystal, link } = crystalWithLink()
    env.outcome = { status: 'device_limit', limit: 2 }
    const out = await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])
    expect(out).toEqual({ handled: [crystal.id], requeued: [] })
    expect(node(crystal.id).archived).toBe(0)
    expect(db.prepare('SELECT deleted FROM links WHERE id = ?').get(link.id)).toEqual({ deleted: 0 })
    expect(db.prepare('SELECT tbl, reason FROM cloud_sync_excluded ORDER BY tbl').all()).toEqual([
      { tbl: 'links', reason: 'device_not_registered' }, { tbl: 'nodes', reason: 'device_not_registered' },
    ])
    expect(dirty('nodes')).toEqual([])
    expect(isUploadDeferred('nodes', crystal.id)).toBe(false)

    expect(releaseExcludedByReason(db, 'device_not_registered')).toBe(2)
    expect(isExcludedFromCloudSync(db, 'nodes', crystal.id)).toBe(false)
    expect(dirty('nodes')).toEqual([crystal.id])
    expect(dirty('links')).toEqual([link.id])
  })

  it('a permanent exclusion is not released with the parked ones', async () => {
    const { crystal } = crystalWithLink()
    await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])
    expect(releaseExcludedByReason(db, 'device_not_registered')).toBe(0)
    expect(isExcludedFromCloudSync(db, 'nodes', crystal.id)).toBe(true)
  })

  it.each([
    ['the device limit is reached', { status: 'device_limit', limit: 2 }],
    ['registration keeps failing', { status: 'transient', detail: 'HTTP 500' }],
    ['this device is confirmed primary but the server still rejects', { status: 'registered', registration: { ...notPrimary, isPrimary: true } }],
  ])('one uplink run uploads a rejected record once when %s', async (_name, outcome) => {
    const { crystal } = crystalWithLink()
    db.prepare("INSERT INTO cloud_dirty (tbl, id) VALUES ('nodes', ?)").run(crystal.id)
    env.outcome = outcome
    let uploads = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string)
      if (body.table === 'nodes') uploads++
      const skipped = body.items.map((i: { id: string }) => ({ id: i.id, reason: 'not_primary_device' }))
      return new Response(JSON.stringify({ processed: 0, skipped }), { status: 200 })
    })
    await pumpUplink(db)
    expect(uploads).toBe(1)
    expect(env.roleChecks).toBe(1)
    expect(node(crystal.id).archived).toBe(0)
  }, 30_000)

  it('a requeued record waits out its backoff, then is retried; clearing the backoff retries at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-20T00:00:00Z'))
      const { crystal } = crystalWithLink()
      db.prepare("INSERT INTO cloud_dirty (tbl, id) VALUES ('nodes', ?)").run(crystal.id)
      env.outcome = { status: 'transient', detail: 'HTTP 500' }
      let uploads = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string)
        uploads++
        return new Response(JSON.stringify({ processed: 0, skipped: body.items.map((i: { id: string }) => ({ id: i.id, reason: 'not_primary_device' })) }), { status: 200 })
      })
      await pumpUplink(db); expect(uploads).toBe(1)
      await pumpUplink(db); expect(uploads).toBe(1)             // 30 秒内不重试
      vi.setSystemTime(new Date('2026-11-20T00:00:31Z'))
      await pumpUplink(db); expect(uploads).toBe(2)
      vi.setSystemTime(new Date('2026-11-20T00:01:20Z'))          // 第二次推迟 60 秒，未到期
      await pumpUplink(db); expect(uploads).toBe(2)
      clearDeferredUploads()
      await pumpUplink(db); expect(uploads).toBe(3)
      expect(dirty('nodes')).toEqual([crystal.id])               // 始终留在待上传集合里
    } finally { vi.useRealTimers() }
  }, 30_000)

  it('deferred records do not starve the ones behind them', async () => {
    const parked: string[] = []
    for (let i = 0; i < 60; i++) {
      const n = seedNode(db, { content: `周结晶 ${i}` })
      db.prepare("UPDATE nodes SET is_crystal = 1, source_tool = 'temporal-crystal' WHERE id = ?").run(n.id)
      parked.push(n.id)
    }
    env.outcome = { status: 'transient', detail: 'HTTP 500' }
    const uploaded: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string)
      const ids = body.items.map((i: { id: string }) => i.id) as string[]
      uploaded.push(...ids)
      const skipped = ids.filter(id => parked.includes(id)).map(id => ({ id, reason: 'not_primary_device' }))
      return new Response(JSON.stringify({ processed: ids.length - skipped.length, skipped }), { status: 200 })
    })
    await pumpUplink(db)
    uploaded.length = 0
    const fresh = seedNode(db, { content: '星海科技的新记忆' })
    await pumpUplink(db)
    expect(uploaded).toEqual([fresh.id])
  }, 30_000)

  it('an edit made while its upload is in flight is uploaded by the next run', async () => {
    const memory = seedNode(db, { content: 'v1' })
    const contents: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string)
      for (const item of body.items) contents.push(item.content)
      db.prepare('UPDATE nodes SET content = ? WHERE id = ?').run('v2', memory.id)   // 上传期间用户再次编辑
      return new Response(JSON.stringify({ processed: body.items.length }), { status: 200 })
    })
    await pumpUplink(db)
    expect(contents).toEqual(['v1'])
    await pumpUplink(db)
    expect(contents).toEqual(['v1', 'v2'])
  })

  it('a parked record that is later rejected for good is not released again', async () => {
    const { crystal, link } = crystalWithLink()
    env.outcome = { status: 'device_limit', limit: 2 }
    await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])
    releaseExcludedByReason(db, 'device_not_registered')
    // 放行前名单里残留一条暂存的链接，随后节点被确认为非主设备拒收
    db.prepare("INSERT INTO cloud_sync_excluded (tbl, id, reason, created) VALUES ('links', ?, 'device_not_registered', 't')").run(link.id)
    env.outcome = null
    await handleUploadRejections(db, 'nodes', [{ id: crystal.id, reason: 'not_primary_device' }])
    expect(db.prepare('SELECT tbl, reason FROM cloud_sync_excluded ORDER BY tbl').all()).toEqual([
      { tbl: 'links', reason: 'not_primary_device' }, { tbl: 'nodes', reason: 'not_primary_device' },
    ])
    expect(releaseExcludedByReason(db, 'device_not_registered')).toBe(0)
  })

  it('claims in id order across pages without reading the whole set', () => {
    for (let i = 0; i < 450; i++) seedNode(db, { content: `记忆 ${i}` })
    const all = dirty('nodes')
    const skipped = new Set(all.slice(0, 300))
    const got = claimDirty(db, 'nodes', 50, (id) => skipped.has(id))
    expect(got).toEqual(all.slice(300, 350))
    expect(dirty('nodes')).toHaveLength(400)
  })
})
