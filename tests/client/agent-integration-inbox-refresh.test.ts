import { describe, expect, it, vi } from 'vitest'
import { subscribeAgentIntegrationInboxRefresh } from '../../client/src/lib/agent-integration-inbox-refresh'

class VisibilityTarget extends EventTarget {
  visibilityState: DocumentVisibilityState = 'hidden'
}

describe('Agent Integration inbox visibility refresh', () => {
  it('refreshes on focus, visible transition and explicit inbox changes, then detaches', () => {
    const windowTarget = new EventTarget()
    const documentTarget = new VisibilityTarget()
    const refresh = vi.fn()
    const unsubscribe = subscribeAgentIntegrationInboxRefresh(windowTarget, documentTarget, refresh)

    windowTarget.dispatchEvent(new Event('focus'))
    documentTarget.dispatchEvent(new Event('visibilitychange'))
    expect(refresh).toHaveBeenCalledTimes(1)

    documentTarget.visibilityState = 'visible'
    documentTarget.dispatchEvent(new Event('visibilitychange'))
    windowTarget.dispatchEvent(new Event('agent-integration-inbox-changed'))
    expect(refresh).toHaveBeenCalledTimes(3)

    unsubscribe()
    windowTarget.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(3)
  })
})
