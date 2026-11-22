/**
 * 首次同步状态的判断，以及实时上行何时为整理结果带首次同步标志。
 * 设计：docs/design/primary-device-acceptance-fixes-2026-11-20.md §3、§10.2。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudBaseUrl: () => 'https://cloud.test',
  refreshTokenIfNeeded: vi.fn(async () => 'token'),
}))
vi.mock('../../client/electron/cloud/primary-device.js', () => ({
  syncRoleOutcome: vi.fn(async () => ({ status: 'transient', detail: 'unused' })),
}))
const mockApp = vi.hoisted(() => ({ getVersion: () => '0.0.0-test' }))
vi.mock('electron', () => ({ app: mockApp, default: { app: mockApp } }))
vi.mock('../../client/node_modules/electron/index.js', () => ({ app: mockApp, default: { app: mockApp } }))

import { setupTestDb, seedNode } from '../helpers/test-db.js'
import { isInitialSyncState, shouldSendInitialFlagForUplink } from '../../client/electron/cloud/initial-sync-state.js'
import { pumpUplink } from '../../client/electron/cloud/uplink.js'
import { clearDeferredUploads, releaseParkedUploads } from '../../client/electron/cloud/upload-deferral.js'
import { excludeFromCloudSync } from '../../src/db/cloud-sync-exclusions.js'

let db: Database.Database
const setMeta = (key: string, value: string) =>
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
function crystal(content: string) {
  const n = seedNode(db, { content })
  db.prepare("UPDATE nodes SET is_crystal = 1, source_tool = 'temporal-crystal' WHERE id = ?").run(n.id)
  return n
}
function captureUploads() {
  const calls: Array<{ initial: boolean; ids: string[] }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string)
    calls.push({ initial: body.is_initial_reconcile, ids: body.items.map((i: { id: string }) => i.id) })
    return new Response(JSON.stringify({ processed: body.items.length }), { status: 200 })
  })
  return calls
}

beforeEach(() => { db = setupTestDb(); clearDeferredUploads() })
afterEach(() => { vi.restoreAllMocks(); db.close() })

describe('isInitialSyncState', () => {
  it('is true only while neither table has ever finished a reconcile', () => {
    expect(isInitialSyncState(db)).toBe(true)
    setMeta('cloud.last_reconcile_at_links', hoursAgo(1))
    expect(isInitialSyncState(db)).toBe(false)
    db.prepare("DELETE FROM metadata WHERE key = 'cloud.last_reconcile_at_links'").run()
    setMeta('cloud.last_reconcile_at_nodes', hoursAgo(1))
    expect(isInitialSyncState(db)).toBe(false)
  })

  it('is false when the state cannot be read', () => {
    db.close()
    expect(isInitialSyncState(db)).toBe(false)
    db = setupTestDb()
  })
})

describe('shouldSendInitialFlagForUplink', () => {
  it('needs a registration no older than 24 hours', () => {
    expect(shouldSendInitialFlagForUplink(db)).toBe(false)          // 从未注册成功
    setMeta('cloud.first_registered_at', hoursAgo(1))
    expect(shouldSendInitialFlagForUplink(db)).toBe(true)
    setMeta('cloud.first_registered_at', hoursAgo(25))
    expect(shouldSendInitialFlagForUplink(db)).toBe(false)
  })

  it('is off once a reconcile has finished, and on again after parked uploads are released', () => {
    setMeta('cloud.first_registered_at', hoursAgo(1))
    setMeta('cloud.last_reconcile_at_nodes', hoursAgo(0.5))
    expect(shouldSendInitialFlagForUplink(db)).toBe(false)
    const parked = crystal('周结晶')
    excludeFromCloudSync(db, 'nodes', parked.id, 'device_not_registered')
    expect(releaseParkedUploads(db)).toBe(1)
    expect(shouldSendInitialFlagForUplink(db)).toBe(true)
  })
})

describe('uplink and the initial-sync flag', () => {
  it('a device that was used standalone uploads its results with the flag, memories without it', async () => {
    const memory = seedNode(db, { content: '星海科技单机时期的记忆' })
    const result = crystal('单机时期的结晶')
    setMeta('cloud.first_registered_at', hoursAgo(0.01))
    const calls = captureUploads()
    await pumpUplink(db)
    expect(calls).toEqual([
      { initial: true, ids: [result.id] },
      { initial: false, ids: [memory.id] },
    ])
  })

  it('never sends the flag for ordinary memories, links, or after the first reconcile', async () => {
    const memory = seedNode(db, { content: '普通记忆' })
    const result = crystal('结晶')
    setMeta('cloud.first_registered_at', hoursAgo(0.01))
    setMeta('cloud.last_reconcile_at_nodes', hoursAgo(0.005))
    const calls = captureUploads()
    await pumpUplink(db)
    expect(calls.every(c => c.initial === false)).toBe(true)
    expect(calls.flatMap(c => c.ids).sort()).toEqual([memory.id, result.id].sort())
  })

  it('does not send the flag once the registration is older than 24 hours', async () => {
    crystal('结晶')
    setMeta('cloud.first_registered_at', hoursAgo(30))
    const calls = captureUploads()
    await pumpUplink(db)
    expect(calls.map(c => c.initial)).toEqual([false])
  })

  it('released results get the flag for one run only', async () => {
    setMeta('cloud.first_registered_at', hoursAgo(1))
    setMeta('cloud.last_reconcile_at_nodes', hoursAgo(0.5))
    setMeta('cloud.last_reconcile_at_links', hoursAgo(0.5))
    const parked = crystal('设备数超限期间暂存的结晶')
    db.prepare('DELETE FROM cloud_dirty').run()
    excludeFromCloudSync(db, 'nodes', parked.id, 'device_not_registered')
    releaseParkedUploads(db)
    const calls = captureUploads()
    await pumpUplink(db)
    expect(calls).toEqual([{ initial: true, ids: [parked.id] }])
    const later = crystal('之后生成的结晶')
    await pumpUplink(db)
    expect(calls[1]).toEqual({ initial: false, ids: [later.id] })
  })

  it('a release that happens while a run is past its node phase keeps the flag for the next run', async () => {
    setMeta('cloud.first_registered_at', hoursAgo(1))
    setMeta('cloud.last_reconcile_at_nodes', hoursAgo(0.5))
    setMeta('cloud.last_reconcile_at_links', hoursAgo(0.5))
    const parked = crystal('暂存的结晶')
    db.prepare('DELETE FROM cloud_dirty').run()
    excludeFromCloudSync(db, 'nodes', parked.id, 'device_not_registered')
    const memory = seedNode(db, { content: '触发本轮上行的记忆' })
    const calls: Array<{ initial: boolean; ids: string[] }> = []
    let released = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string)
      calls.push({ initial: body.is_initial_reconcile, ids: body.items.map((i: { id: string }) => i.id) })
      if (!released) { released = true; releaseParkedUploads(db) }   // 本轮的节点请求在途时放行
      return new Response(JSON.stringify({ processed: body.items.length }), { status: 200 })
    })
    await pumpUplink(db)
    await pumpUplink(db)
    expect(calls[0]).toEqual({ initial: false, ids: [memory.id] })
    expect(calls.find(c => c.ids.includes(parked.id))).toEqual({ initial: true, ids: [parked.id] })
  })
})
