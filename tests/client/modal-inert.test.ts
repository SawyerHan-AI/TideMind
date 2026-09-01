import { describe, expect, it } from 'vitest'
import { acquireModalInert } from '../../client/src/lib/modal-inert'

describe('portal modal inert leases', () => {
  it('keeps the root inert until the final modal closes and restores its original state', () => {
    const root = { inert: false }
    const releaseFirst = acquireModalInert(root)
    const releaseSecond = acquireModalInert(root)
    expect(root.inert).toBe(true)

    releaseFirst()
    releaseFirst()
    expect(root.inert).toBe(true)

    releaseSecond()
    expect(root.inert).toBe(false)
  })

  it('does not clear an application root that was already inert', () => {
    const root = { inert: true }
    const release = acquireModalInert(root)
    release()
    expect(root.inert).toBe(true)
  })
})
