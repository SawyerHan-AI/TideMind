import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), closeDb: vi.fn() }))
vi.mock('../src/config.js', () => ({ loadConfig: vi.fn(), ensureDataDirs: vi.fn() }))
vi.mock('../src/db/connection.js', () => mocks)
import { hookBridgeRejection } from '../src/hook-bridge-guard.js'

afterEach(() => vi.restoreAllMocks())

describe('bound hook bridge admission', () => {
  it('refuses memory injection when opening the admission database fails', () => {
    mocks.getDb.mockImplementation(() => { throw new Error('SQLITE_BUSY') })
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(hookBridgeRejection({ scope: 'test', agentId: 'eb_bound', activityGenerationToken: 'generation' }))
      .toBe('guard_unavailable')
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('bridge guard unavailable'))
    expect(mocks.closeDb).toHaveBeenCalled()
  })

  it('preserves the unbound legacy path without querying the database', () => {
    mocks.getDb.mockClear()
    expect(hookBridgeRejection({ scope: 'test', agentId: 'eb_legacy', activityGenerationToken: null })).toBeNull()
    expect(mocks.getDb).not.toHaveBeenCalled()
  })
})
