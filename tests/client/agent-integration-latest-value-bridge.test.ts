import { describe, expect, it, vi } from 'vitest'
import { LatestValueBridge } from '../../client/electron/agent-integration/latest-value-bridge'

describe('LatestValueBridge', () => {
  it('buffers only the latest startup navigation and then delivers live values', () => {
    const bridge = new LatestValueBridge<string>()
    bridge.publish('installation-old')
    bridge.publish('installation-latest')
    const listener = vi.fn()

    const unsubscribe = bridge.subscribe(listener)
    bridge.publish('installation-live')
    unsubscribe()
    bridge.publish('installation-after-unsubscribe')

    expect(listener.mock.calls).toEqual([
      ['installation-latest'],
      ['installation-live'],
    ])
    const next = vi.fn()
    bridge.subscribe(next)
    expect(next).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith('installation-after-unsubscribe')
  })
})
