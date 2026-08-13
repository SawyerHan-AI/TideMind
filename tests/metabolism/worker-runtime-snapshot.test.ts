import { describe, expect, it } from 'vitest'
import {
  createMetabolismWorkerRuntimeSnapshot,
  MetabolismWorkerRuntimeRevisionAllocator,
  verifyMetabolismWorkerRuntimeSnapshot,
} from '../../src/metabolism/worker-runtime-snapshot.js'

function source() {
  return {
    runtimeConfig: { metabolism: { enabled: true }, embedding: { dimensions: 768 } },
    connections: [{ id: 'mc_1', providerType: 'openai', selected: true, model: 'gpt-test' }],
    strategy: { name: 'digest', systemPrompt: 'prompt', params: { temperature: 0.2 } },
    credentials: { mc_1: { apiKey: 'secret' } },
    authorizedRoots: { dataDir: '/tmp/tidemind' },
  }
}

describe('metabolism worker runtime snapshot', () => {
  it('is deterministic, detached and deeply frozen', () => {
    const input = source()
    const first = createMetabolismWorkerRuntimeSnapshot(input, 1)
    const second = createMetabolismWorkerRuntimeSnapshot(source(), 1)
    expect(first.commitment).toBe(second.commitment)
    expect(first.strategySourceFingerprint).toBe(second.strategySourceFingerprint)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.connections[0])).toBe(true)
    input.runtimeConfig.metabolism.enabled = false
    expect(first.runtimeConfig.metabolism).toEqual({ enabled: true })
    expect(() => verifyMetabolismWorkerRuntimeSnapshot(first)).not.toThrow()
  })

  it('changes commitment for fixed runtime input but not for object key order', () => {
    const base = createMetabolismWorkerRuntimeSnapshot(source(), 2)
    const changed = source()
    changed.connections[0].model = 'other'
    expect(createMetabolismWorkerRuntimeSnapshot(changed, 2).commitment).not.toBe(base.commitment)

    const reordered = source()
    reordered.runtimeConfig = { embedding: { dimensions: 768 }, metabolism: { enabled: true } }
    expect(createMetabolismWorkerRuntimeSnapshot(reordered, 2).commitment).toBe(base.commitment)
  })

  it('rejects accessors, proxy, cycles and tampered commitments', () => {
    const withAccessor = source()
    Object.defineProperty(withAccessor.strategy, 'dynamic', { enumerable: true, get: () => 'secret' })
    expect(() => createMetabolismWorkerRuntimeSnapshot(withAccessor, 1)).toThrow()

    let traps = 0
    const withProxy = source()
    withProxy.credentials = new Proxy({}, { ownKeys() { traps += 1; return [] } }) as typeof withProxy.credentials
    expect(() => createMetabolismWorkerRuntimeSnapshot(withProxy, 1)).toThrow()
    expect(traps).toBe(0)

    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => createMetabolismWorkerRuntimeSnapshot({ ...source(), strategy: cycle }, 1)).toThrow()

    const valid = createMetabolismWorkerRuntimeSnapshot(source(), 1)
    expect(() => verifyMetabolismWorkerRuntimeSnapshot({ ...valid, commitment: '0'.repeat(64) })).toThrow()
  })

  it('allocates monotonically without deriving revision from time', () => {
    const allocator = new MetabolismWorkerRuntimeRevisionAllocator(7)
    expect(allocator.allocate()).toBe(8)
    expect(allocator.allocate()).toBe(9)
    expect(allocator.peek()).toBe(9)
  })
})
