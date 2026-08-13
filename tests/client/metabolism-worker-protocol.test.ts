import { describe, expect, it } from 'vitest'
import {
  sanitizeMetabolismWorkerError,
  snapshotMainToMetabolismWorkerMessage,
  snapshotMetabolismWorkerBootstrap,
  snapshotMetabolismWorkerToMainMessage,
} from '../../client/electron/workers/metabolism-worker-protocol.js'

const hash = (digit: string) => digit.repeat(64)

function bootstrap() {
  return {
    protocolVersion: 1,
    lifecycleGeneration: 2,
    startupAuthority: {
      controllerReceiptId: 'receipt-1',
      dataScopeFingerprint: hash('a'),
      controllerGeneration: 3,
    },
    databaseIdentity: {
      canonicalRealPath: '/tmp/tidemind.db',
      deviceId: '1',
      inodeId: '2',
      identityCommitment: hash('b'),
    },
    expectedSchemaVersion: 44,
    runtimeRevision: 7,
    runtimeConfigSnapshot: { cloud: { enabled: true } },
    runtimeConnectionSnapshot: { provider: 'openai' },
    strategySnapshot: { tiers: ['fast'] },
    strategySourceFingerprint: hash('c'), externalRuntimeSourceFingerprint: 'e'.repeat(64),
    credentialSnapshot: { token: 'secret-that-must-not-be-logged' },
    authorizedRoots: { dataDir: '/tmp' },
    vecCapability: 'ready',
  }
}

describe('metabolism worker protocol', () => {
  it('takes an exact deeply frozen bootstrap snapshot', () => {
    const input = bootstrap()
    const result = snapshotMetabolismWorkerBootstrap(input)
    expect(result).not.toBe(input)
    expect(result.runtimeConfigSnapshot).not.toBe(input.runtimeConfigSnapshot)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.runtimeConfigSnapshot.cloud)).toBe(true)
    input.runtimeConfigSnapshot.cloud.enabled = false
    expect(result.runtimeConfigSnapshot).toEqual({ cloud: { enabled: true } })
  })

  it('rejects extra keys, accessors, cycles, non-plain objects and Proxy without evaluating traps', () => {
    expect(() => snapshotMetabolismWorkerBootstrap({ ...bootstrap(), extra: true })).toThrow()

    const accessor = bootstrap()
    Object.defineProperty(accessor.runtimeConfigSnapshot, 'secret', { enumerable: true, get: () => 'x' })
    expect(() => snapshotMetabolismWorkerBootstrap(accessor)).toThrow()

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => snapshotMetabolismWorkerBootstrap({ ...bootstrap(), strategySnapshot: cyclic })).toThrow()
    expect(() => snapshotMetabolismWorkerBootstrap({ ...bootstrap(), credentialSnapshot: new Date() })).toThrow()

    let trapCount = 0
    const proxy = new Proxy({}, {
      ownKeys() { trapCount += 1; return [] },
      getPrototypeOf() { trapCount += 1; return Object.prototype },
    })
    expect(() => snapshotMetabolismWorkerBootstrap({ ...bootstrap(), runtimeConfigSnapshot: proxy })).toThrow()
    expect(trapCount).toBe(0)
  })

  it('validates the closed main-to-worker union', () => {
    expect(snapshotMainToMetabolismWorkerMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'set_schedule_context',
      mode: 'foreground',
      cadence: 'active',
      revision: 4,
    })).toMatchObject({ kind: 'set_schedule_context', revision: 4 })
    expect(() => snapshotMainToMetabolismWorkerMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'shutdown',
      extra: true,
    })).toThrow()
  })

  it('validates lifecycle, active-task and structure RPC messages', () => {
    expect(snapshotMetabolismWorkerToMainMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'scheduler_pass_started',
      executionThreadId: 7,
    })).toMatchObject({ kind: 'scheduler_pass_started', executionThreadId: 7 })
    expect(() => snapshotMetabolismWorkerToMainMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'scheduler_pass_started',
      executionThreadId: -1,
    })).toThrow()
    expect(snapshotMetabolismWorkerToMainMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'scheduler_sqlite_contention',
      reason: 'busy_task_failure',
    })).toMatchObject({ kind: 'scheduler_sqlite_contention', reason: 'busy_task_failure' })
    expect(() => snapshotMetabolismWorkerToMainMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'scheduler_sqlite_contention',
      reason: 'sqlite_locked',
    })).toThrow()
    expect(snapshotMetabolismWorkerToMainMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'active_llm_task_started',
      taskId: 'task-1',
      origin: 'scheduler-worker',
      purpose: 'llm',
      tier: 'standard',
      connectionId: 'mc_12345678',
    })).toMatchObject({ kind: 'active_llm_task_started', purpose: 'llm', tier: 'standard', connectionId: 'mc_12345678' })
    expect(snapshotMetabolismWorkerToMainMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'structure_holes_request',
      requestId: 'rpc-1',
      limit: 100,
    })).toMatchObject({ requestId: 'rpc-1', limit: 100 })
    expect(() => snapshotMetabolismWorkerToMainMessage({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      kind: 'active_llm_task_started',
      taskId: 'task-1',
      origin: 'main',
      purpose: 'llm',
      tier: 'standard',
      connectionId: null,
    })).toThrow()
  })

  it('sanitizes errors without copying messages, stacks or sensitive fields', () => {
    const error = Object.assign(new Error('prompt secret-token'), { code: 'SQLITE_BUSY', credential: 'secret' })
    const sanitized = sanitizeMetabolismWorkerError(error, 'scheduler')
    expect(sanitized).toEqual({ code: 'SQLITE_BUSY', phase: 'scheduler', retryable: false })
    expect(JSON.stringify(sanitized)).not.toContain('secret')
    expect(Object.isFrozen(sanitized)).toBe(true)
  })
})
