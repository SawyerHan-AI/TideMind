/**
 * 登录状态变化后的清理与重建（设计 primary-device-acceptance-fixes §4.4 a、b）。
 *
 * 被动登出原先不销毁同步客户端，重新登录时“已有实例”让启动被跳过，设备注册不再执行，
 * 本机停在不承担整理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'

const env = vi.hoisted(() => ({
  loggedIn: true,
  events: [] as string[],
  client: null as null | { start: () => Promise<void>; stop: () => void },
}))
const electronMock = vi.hoisted(() => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('electron', () => ({ ...electronMock, default: electronMock }))
vi.mock('../../client/node_modules/electron/index.js', () => ({ ...electronMock, default: electronMock }))
vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  isLoggedIn: () => env.loggedIn,
  refreshTokenIfNeeded: async () => (env.loggedIn ? 'tk' : null),
  getCloudBaseUrl: () => 'https://cloud.test',
}))
vi.mock('@server/config.js', () => ({
  getConfig: () => ({ cloud: { sync_enabled: true }, metabolism: { background_enabled: true } }),
}))
vi.mock('../../client/electron/cloud/vector-runtime.js', () => ({
  refreshDesktopVectorRuntime: vi.fn(async () => { env.events.push('vector-refresh') }),
}))
// 同步客户端替身：start() 里做真实客户端会做的那一步——向云端注册并同步角色。
vi.mock('../../client/electron/cloud/sync-client.js', () => ({
  getCloudSyncClient: () => env.client,
  createCloudSyncClient: (db: Database.Database) => {
    env.client?.stop()
    env.client = {
      start: async () => {
        env.events.push('start')
        const role = await import('../../client/electron/cloud/primary-device.js')
        role.evaluateLocalRole(db)
        await role.syncRoleWithServer(db, { force: true })
      },
      stop: () => { env.events.push('stop') },
    }
    return env.client
  },
  destroySyncClient: () => {
    if (!env.client) return
    env.client.stop()
    env.client = null
    env.events.push('destroy')
  },
}))

import { createTestDb } from '../../src/db/connection.js'
import { readLocalRoleRecord } from '../../src/metabolism/local-role.js'
import { handleSignedOut, restartCloudSyncAfterSignIn } from '../../client/electron/cloud/session.js'
import { startCloudSyncIfConfigured } from '../../client/electron/cloud/startup.js'
import { getFirstRegisteredAt, getLastRegistration } from '../../client/electron/cloud/device.js'
import { deferUpload, isUploadDeferred } from '../../client/electron/cloud/upload-deferral.js'

let db: Database.Database
let fetchSpy: ReturnType<typeof vi.spyOn>
const registered = (isPrimary: boolean) => new Response(JSON.stringify({
  id: 'dev-1', is_primary: isPrimary, primary_device_id: isPrimary ? 'dev-1' : null, primary_device_revision: 5,
}), { status: 200 })
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

beforeEach(() => {
  db = createTestDb()
  Object.assign(env, { loggedIn: true, events: [], client: null })
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => registered(true))
})
afterEach(() => { fetchSpy.mockRestore(); db.close() })

describe('signing out', () => {
  it('a passive sign-out tears the sync client down and this device organizes locally again', async () => {
    await startCloudSyncIfConfigured(db); await settle()
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: 5, source: 'server' })
    expect(getFirstRegisteredAt(db)).not.toBeNull()
    deferUpload('nodes', ['n1'])

    env.loggedIn = false          // 凭据被云端拒绝
    handleSignedOut(db)
    expect(env.client).toBeNull()
    expect(getLastRegistration()).toBeNull()
    expect(getFirstRegisteredAt(db)).toBeNull()
    expect(isUploadDeferred('nodes', 'n1')).toBe(false)
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: null, source: 'local' })
  })

  it('can be called twice, and with no sync client running', () => {
    env.loggedIn = false
    handleSignedOut(db)
    handleSignedOut(db)
    expect(env.events.filter(e => e === 'destroy')).toEqual([])
    expect(readLocalRoleRecord(db)?.organizer).toBe(true)
  })
})

describe('signing in again', () => {
  it('after a passive sign-out: registers with the cloud and takes the role it is given', async () => {
    await startCloudSyncIfConfigured(db); await settle()
    env.loggedIn = false
    handleSignedOut(db)
    fetchSpy.mockClear()

    env.loggedIn = true
    await restartCloudSyncAfterSignIn(db); await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/sync/devices')
    expect(readLocalRoleRecord(db)).toEqual({ organizer: true, revision: 5, source: 'server' })
  })

  it('while a sync client is still running: the old one is stopped and exactly one new one starts', async () => {
    await startCloudSyncIfConfigured(db); await settle()
    env.events.length = 0
    fetchSpy.mockClear()
    fetchSpy.mockImplementation(async () => registered(false))
    await restartCloudSyncAfterSignIn(db); await settle()
    expect(env.events.filter(e => e === 'start')).toEqual(['start'])
    expect(env.events.indexOf('destroy')).toBeLessThan(env.events.indexOf('start'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(readLocalRoleRecord(db)).toEqual({ organizer: false, revision: 5, source: 'server' })
  })

  it('startup and turning sync on still do not start a second client', async () => {
    await startCloudSyncIfConfigured(db); await settle()
    env.events.length = 0
    await startCloudSyncIfConfigured(db); await settle()
    expect(env.events).not.toContain('start')
  })

  it('signing in as someone else forgets the previous account\'s first registration time and backoff', async () => {
    await startCloudSyncIfConfigured(db); await settle()
    db.prepare("UPDATE metadata SET value = '2026-01-01T00:00:00.000Z' WHERE key = 'cloud.first_registered_at'").run()
    deferUpload('nodes', ['n1'])
    await restartCloudSyncAfterSignIn(db); await settle()
    expect(isUploadDeferred('nodes', 'n1')).toBe(false)
    expect(Date.now() - (getFirstRegisteredAt(db) ?? 0)).toBeLessThan(60_000)
  }, 30_000)
})
