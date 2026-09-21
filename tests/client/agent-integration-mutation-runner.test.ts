import { describe, expect, it, vi } from 'vitest'
import {
  compensateMutation,
  executeMutation,
  recoverMutation,
  WriterFenceUnavailableError,
  type MutationJournalRecord,
  type MutationRunDependencies,
} from '../../client/electron/agent-integration/mutation-runner'

function prepared(overrides: Partial<MutationJournalRecord> = {}): MutationJournalRecord {
  return {
    id: 'mutation-1',
    state: 'prepared',
    journalVersion: 0,
    attemptCount: 0,
    idempotent: true,
    beforeFingerprint: 'before',
    desiredFingerprint: 'desired',
    postEffectFingerprint: null,
    compensationPrecondition: null,
    receiptJson: null,
    failureCode: null,
    failureStage: null,
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

function harness(initialLive = 'before') {
  let live: string | null = initialLive
  const states: string[] = []
  const apply = vi.fn(() => { live = 'desired' })
  const compensate = vi.fn(() => { live = 'before' })
  const dependencies: MutationRunDependencies = {
    journal: { save: record => { states.push(record.state) } },
    fence: { assertOwned: vi.fn() },
    effect: {
      apply,
      readBack: vi.fn(() => live),
      receipt: fingerprint => ({ fingerprint }),
      compensate,
    },
    now: () => '2026-08-25T00:01:00.000Z',
  }
  return { dependencies, states, apply, compensate, setLive: (value: string | null) => { live = value } }
}

it('defers an unacquired recovery fence but persists loss of a previously held fence', async () => {
  const busy = harness()
  busy.dependencies.fence.assertOwned = () => { throw new WriterFenceUnavailableError('busy') }
  const record = prepared({ state: 'effect_started' })
  expect(await recoverMutation(record, busy.dependencies)).toBe(record)
  expect(busy.states).toEqual([])
  expect(busy.dependencies.effect.readBack).not.toHaveBeenCalled()

  const lost = harness()
  lost.dependencies.fence.assertOwned = () => { throw new Error('held lease lost') }
  expect(await recoverMutation(record, lost.dependencies)).toMatchObject({
    state: 'needs_recovery', failureCode: 'writer_fence_lost',
  })
  expect(lost.states).toEqual(['needs_recovery'])
})

describe('mutation runner', () => {
  it('persists effect intent before applying and commits only after read-back and receipt', async () => {
    const test = harness()
    const result = await executeMutation(prepared(), test.dependencies)

    expect(result.state).toBe('committed')
    expect(result.postEffectFingerprint).toBe('desired')
    expect(result.receiptJson).toBe('{"fingerprint":"desired"}')
    expect(test.states).toEqual([
      'effect_started',
      'effect_observed',
      'receipt_persisted',
      'verified',
      'committed',
    ])
    expect(test.dependencies.fence.assertOwned).toHaveBeenCalledBefore(test.apply)
  })

  it('does not blindly retry when apply throws after the side effect', async () => {
    const test = harness()
    test.dependencies.effect.apply = vi.fn(() => {
      test.setLive('desired')
      throw new Error('process died before receipt')
    })

    const result = await executeMutation(prepared(), test.dependencies)
    expect(result.state).toBe('needs_recovery')
    expect(result.failureCode).toBe('effect_failed_or_unknown')
    expect(test.dependencies.effect.apply).toHaveBeenCalledTimes(1)
  })

  it('recovers an observed desired effect without invoking it again', async () => {
    const test = harness('desired')
    const order: string[] = []
    test.dependencies.fence.assertOwned = vi.fn(() => { order.push('fence') })
    test.dependencies.effect.readBack = vi.fn(() => { order.push('read-back'); return 'desired' })
    const result = await recoverMutation(prepared({ state: 'needs_recovery', attemptCount: 1 }), test.dependencies)

    expect(result.state).toBe('committed')
    expect(test.apply).not.toHaveBeenCalled()
    expect(order.slice(0, 3)).toEqual(['fence', 'read-back', 'fence'])
    expect(test.states).toEqual(['effect_observed', 'receipt_persisted', 'verified', 'committed'])
  })

  it.each([
    ['receipt_persisted', ['verified', 'committed']],
    ['verified', ['committed']],
  ] as const)('resumes monotonically from the durable %s phase', async (state, expectedStates) => {
    const test = harness('desired')
    const result = await recoverMutation(prepared({
      state,
      attemptCount: 1,
      postEffectFingerprint: 'desired',
      compensationPrecondition: 'desired',
      receiptJson: '{"fingerprint":"desired"}',
    }), test.dependencies)

    expect(result.state).toBe('committed')
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.states).toEqual(expectedStates)
  })

  it('fails closed instead of replaying after durable effect evidence reverts to before', async () => {
    const test = harness('before')
    const result = await recoverMutation(prepared({
      state: 'receipt_persisted',
      attemptCount: 1,
      postEffectFingerprint: 'desired',
      compensationPrecondition: 'desired',
      receiptJson: '{"fingerprint":"desired"}',
    }), test.dependencies)

    expect(result.state).toBe('needs_recovery')
    expect(result.failureCode).toBe('durable_effect_reverted')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('replays an idempotent effect only after recovery proves the before state', async () => {
    const test = harness('before')
    const result = await recoverMutation(prepared({ state: 'needs_recovery', attemptCount: 1 }), test.dependencies)

    expect(result.state).toBe('committed')
    expect(result.attemptCount).toBe(2)
    expect(test.apply).toHaveBeenCalledTimes(1)
  })

  it('replays a frozen safe intermediate only while no durable effect receipt exists', async () => {
    const test = harness('partial-1')
    test.dependencies.effect.readBack = vi.fn()
      .mockReturnValueOnce({ fingerprint: 'partial-1', safeToResumeFrom: 'partial-1' })
      .mockImplementation(() => 'desired')
    test.dependencies.safeResumeFingerprints = ['partial-1', 'partial-2']
    test.dependencies.replayGuard = vi.fn(() => ({ allowed: true }))

    const result = await recoverMutation(prepared({ state: 'needs_recovery', attemptCount: 1 }), test.dependencies)

    expect(result.state).toBe('committed')
    expect(test.apply).toHaveBeenCalledTimes(1)
    expect(test.dependencies.replayGuard).toHaveBeenCalledTimes(1)
  })

  it('fails closed for an adapter-claimed intermediate not frozen into the plan', async () => {
    const test = harness('tampered-partial')
    test.dependencies.effect.readBack = vi.fn(() => ({
      fingerprint: 'tampered-partial',
      safeToResumeFrom: 'tampered-partial',
    }))
    test.dependencies.safeResumeFingerprints = ['partial-1']

    const result = await recoverMutation(prepared({ state: 'needs_recovery' }), test.dependencies)

    expect(result.failureCode).toBe('unsafe_intermediate_state')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('fails closed when consent or trust replay guard rejects a safe intermediate', async () => {
    const test = harness('partial-1')
    test.dependencies.effect.readBack = vi.fn(() => ({ fingerprint: 'partial-1', safeToResumeFrom: 'partial-1' }))
    test.dependencies.safeResumeFingerprints = ['partial-1']
    test.dependencies.replayGuard = vi.fn(() => ({ allowed: false, reason: 'consent_no_longer_covers_plan' }))

    const result = await recoverMutation(prepared({ state: 'needs_recovery' }), test.dependencies)

    expect(result.failureCode).toBe('consent_no_longer_covers_plan')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('never replays a partial state after durable effect evidence exists', async () => {
    const test = harness('partial-1')
    test.dependencies.effect.readBack = vi.fn(() => ({ fingerprint: 'partial-1', safeToResumeFrom: 'partial-1' }))
    test.dependencies.safeResumeFingerprints = ['partial-1']

    const result = await recoverMutation(prepared({
      state: 'needs_recovery',
      postEffectFingerprint: 'partial-1',
    }), test.dependencies)

    expect(result.failureCode).toBe('unsafe_intermediate_state')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('fails closed when recovery sees an unknown external edit', async () => {
    const test = harness('user-edit')
    const result = await recoverMutation(prepared({ state: 'needs_recovery' }), test.dependencies)

    expect(result.state).toBe('needs_recovery')
    expect(result.failureCode).toBe('ambiguous_live_state')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('does not run an effect without the writer fence', async () => {
    const test = harness()
    test.dependencies.fence.assertOwned = vi.fn(() => { throw new Error('lost lease') })

    const result = await executeMutation(prepared(), test.dependencies)
    expect(result.state).toBe('needs_recovery')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('does not commit when fence ownership is lost after the side effect', async () => {
    const test = harness()
    test.dependencies.fence.assertOwned = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('lease expired after effect') })

    const result = await executeMutation(prepared(), test.dependencies)
    expect(test.apply).toHaveBeenCalledTimes(1)
    expect(result.state).toBe('needs_recovery')
    expect(result.failureCode).toBe('writer_fence_lost')
    expect(test.states).not.toContain('committed')
  })

  it('compensates only while the exact post-effect fingerprint remains live', async () => {
    const changed = harness('user-edit')
    const refused = await compensateMutation(
      prepared({ state: 'committed', compensationPrecondition: 'desired' }),
      changed.dependencies,
    )
    expect(refused.failureCode).toBe('compensation_precondition_changed')
    expect(changed.compensate).not.toHaveBeenCalled()

    const exact = harness('desired')
    const compensated = await compensateMutation(
      prepared({ state: 'committed', compensationPrecondition: 'desired' }),
      exact.dependencies,
    )
    expect(compensated.state).toBe('compensated')
    expect(exact.compensate).toHaveBeenCalledTimes(1)
  })
})
