import { describe, expect, it } from 'vitest'
import { shouldRegisterProtocolHandler } from '../../client/electron/protocol-registration.js'

describe('shouldRegisterProtocolHandler', () => {
  const skip = { TIDEMIND_SKIP_PROTOCOL_REGISTRATION: '1' }
  it('registers by default, packaged or not', () => {
    expect(shouldRegisterProtocolHandler({ uiAudit: false, packaged: true, env: {} })).toBe(true)
    expect(shouldRegisterProtocolHandler({ uiAudit: false, packaged: false, env: {} })).toBe(true)
  })
  it('never registers in UI audit mode', () => {
    expect(shouldRegisterProtocolHandler({ uiAudit: true, packaged: false, env: {} })).toBe(false)
  })
  it('an unpackaged build skips registration only when asked to', () => {
    expect(shouldRegisterProtocolHandler({ uiAudit: false, packaged: false, env: skip })).toBe(false)
    expect(shouldRegisterProtocolHandler({ uiAudit: false, packaged: false, env: { TIDEMIND_SKIP_PROTOCOL_REGISTRATION: 'true' } })).toBe(true)
  })
  it('a packaged app ignores the variable', () => {
    expect(shouldRegisterProtocolHandler({ uiAudit: false, packaged: true, env: skip })).toBe(true)
  })
})
