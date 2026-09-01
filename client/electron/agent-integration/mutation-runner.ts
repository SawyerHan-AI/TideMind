export type MutationJournalState =
  | 'prepared'
  | 'effect_started'
  | 'effect_observed'
  | 'receipt_persisted'
  | 'verified'
  | 'committed'
  | 'compensating'
  | 'compensated'
  | 'needs_recovery'

export interface MutationJournalRecord {
  id: string
  state: MutationJournalState
  journalVersion: number
  attemptCount: number
  idempotent: boolean
  beforeFingerprint: string | null
  desiredFingerprint: string | null
  postEffectFingerprint: string | null
  compensationPrecondition: string | null
  receiptJson: string | null
  failureCode: string | null
  failureStage: string | null
  updatedAt: string
}

export interface MutationJournalPort {
  save(record: MutationJournalRecord): MutationJournalRecord | void | Promise<MutationJournalRecord | void>
}

export interface WriterFencePort {
  assertOwned(): void | Promise<void>
}

export interface MutationEffectPort {
  apply(): void | Promise<void>
  readBack(): string | null | Promise<string | null>
  receipt(observedFingerprint: string | null): unknown
  compensate?(): void | Promise<void>
}

export interface MutationRunDependencies {
  journal: MutationJournalPort
  fence: WriterFencePort
  effect: MutationEffectPort
  /**
   * Recovery always read-backs first. This guard is consulted only when that
   * read-back proves the old before state and an external effect would need to
   * be replayed.
   */
  replayGuard?: () =>
    | { allowed: true }
    | { allowed: false; reason: string }
    | Promise<{ allowed: true } | { allowed: false; reason: string }>
  now?: () => string
}

export class MutationNeedsRecoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MutationNeedsRecoveryError'
  }
}

export async function executeMutation(
  record: MutationJournalRecord,
  dependencies: MutationRunDependencies,
): Promise<MutationJournalRecord> {
  if (record.state !== 'prepared') {
    throw new Error(`Only prepared mutations can execute; got ${record.state}`)
  }
  return applyAndCommit(record, dependencies)
}

export async function recoverMutation(
  record: MutationJournalRecord,
  dependencies: MutationRunDependencies,
): Promise<MutationJournalRecord> {
  if (record.state === 'committed' || record.state === 'compensated') return record

  // Recovery may inspect while consent is revoked or management is paused, but
  // it still needs the physical-domain lock so the read-back and its decision
  // describe one stable live state.
  try {
    await dependencies.fence.assertOwned()
  } catch (error) {
    return persistFailure(record, dependencies, 'writer_fence_lost', 'recovery_read_back', error)
  }

  let observed: string | null
  try {
    observed = await dependencies.effect.readBack()
  } catch (error) {
    return persistFailure(record, dependencies, 'read_back_failed', 'recovery_read_back', error)
  }

  try {
    await dependencies.fence.assertOwned()
  } catch (error) {
    return persistFailure(record, dependencies, 'writer_fence_lost', 'recovery_read_back', error)
  }

  if (observed === record.desiredFingerprint) {
    return persistObservedAndCommit(record, observed, dependencies)
  }

  if (observed === record.beforeFingerprint && record.idempotent) {
    // Once an effect has been durably observed (or a later phase persisted),
    // seeing the old before state again is an external reversal, not an
    // interrupted apply. Replaying from here would move the journal backwards
    // and could overwrite a user's exact restoration of the previous content.
    if (hasDurableEffectEvidence(record)) {
      return persistFailure(
        record,
        dependencies,
        'durable_effect_reverted',
        'recovery_compare',
        new MutationNeedsRecoveryError('A durably observed effect reverted to the before fingerprint'),
      )
    }
    const replay = await dependencies.replayGuard?.() ?? { allowed: true as const }
    if (!replay.allowed) {
      return persistFailure(
        record,
        dependencies,
        replay.reason,
        'recovery_replay_guard',
        new MutationNeedsRecoveryError(`Recovery replay blocked: ${replay.reason}`),
      )
    }
    return applyAndCommit(record, dependencies)
  }

  return persistFailure(
    record,
    dependencies,
    'ambiguous_live_state',
    'recovery_compare',
    new MutationNeedsRecoveryError('Live state matches neither the planned before nor desired fingerprint'),
  )
}

export async function compensateMutation(
  record: MutationJournalRecord,
  dependencies: MutationRunDependencies,
): Promise<MutationJournalRecord> {
  if (dependencies.effect.compensate === undefined) {
    return persistFailure(record, dependencies, 'compensation_unsupported', 'compensation_prepare')
  }

  let observed: string | null
  try {
    observed = await dependencies.effect.readBack()
  } catch (error) {
    return persistFailure(record, dependencies, 'read_back_failed', 'compensation_read_back', error)
  }
  if (observed !== record.compensationPrecondition) {
    return persistFailure(record, dependencies, 'compensation_precondition_changed', 'compensation_prepare')
  }

  let current = await transition(record, dependencies, 'compensating')
  try {
    await dependencies.fence.assertOwned()
    await dependencies.effect.compensate()
    const after = await dependencies.effect.readBack()
    await dependencies.fence.assertOwned()
    if (after !== record.beforeFingerprint) {
      return persistFailure(current, dependencies, 'compensation_read_back_mismatch', 'compensation_verify')
    }
    current = { ...current, postEffectFingerprint: after }
    return transition(current, dependencies, 'compensated')
  } catch (error) {
    return persistFailure(current, dependencies, 'compensation_failed', 'compensation_effect', error)
  }
}

async function applyAndCommit(
  record: MutationJournalRecord,
  dependencies: MutationRunDependencies,
): Promise<MutationJournalRecord> {
  let current: MutationJournalRecord = {
    ...record,
    attemptCount: record.attemptCount + 1,
    failureCode: null,
    failureStage: null,
  }
  current = await transition(current, dependencies, 'effect_started')

  try {
    await dependencies.fence.assertOwned()
    await dependencies.effect.apply()
  } catch (error) {
    // The effect may already have happened. Never replay here; recovery must
    // inspect the live target first.
    return persistFailure(current, dependencies, 'effect_failed_or_unknown', 'effect', error)
  }

  let observed: string | null
  try {
    observed = await dependencies.effect.readBack()
  } catch (error) {
    return persistFailure(current, dependencies, 'read_back_failed', 'read_back', error)
  }
  try {
    await dependencies.fence.assertOwned()
  } catch (error) {
    return persistFailure(current, dependencies, 'writer_fence_lost', 'read_back', error)
  }
  if (observed !== record.desiredFingerprint) {
    return persistFailure(current, dependencies, 'effect_read_back_mismatch', 'read_back')
  }
  return persistObservedAndCommit(current, observed, dependencies)
}

async function persistObservedAndCommit(
  record: MutationJournalRecord,
  observed: string | null,
  dependencies: MutationRunDependencies,
): Promise<MutationJournalRecord> {
  if ((record.state === 'receipt_persisted' || record.state === 'verified')
    && record.receiptJson === null) {
    return persistFailure(record, dependencies, 'durable_receipt_missing', 'recovery_commit')
  }
  let current: MutationJournalRecord = {
    ...record,
    postEffectFingerprint: observed,
    compensationPrecondition: observed,
    failureCode: null,
    failureStage: null,
  }
  if (current.state === 'prepared'
    || current.state === 'effect_started'
    || (current.state === 'needs_recovery' && current.receiptJson === null)) {
    current = await transition(current, dependencies, 'effect_observed')
  }
  if (current.state === 'effect_observed') {
    current = {
      ...current,
      receiptJson: current.receiptJson ?? JSON.stringify(dependencies.effect.receipt(observed)),
    }
    current = await transition(current, dependencies, 'receipt_persisted')
  }
  if (current.state === 'receipt_persisted'
    || (current.state === 'needs_recovery' && current.receiptJson !== null)) {
    current = await transition(current, dependencies, 'verified')
  }
  if (current.state === 'verified') return transition(current, dependencies, 'committed')
  throw new MutationNeedsRecoveryError(`Cannot resume mutation commit from ${current.state}`)
}

function hasDurableEffectEvidence(record: MutationJournalRecord): boolean {
  return record.state === 'effect_observed'
    || record.state === 'receipt_persisted'
    || record.state === 'verified'
    || record.postEffectFingerprint !== null
    || record.compensationPrecondition !== null
    || record.receiptJson !== null
}

async function persistFailure(
  record: MutationJournalRecord,
  dependencies: MutationRunDependencies,
  code: string,
  stage: string,
  error?: unknown,
): Promise<MutationJournalRecord> {
  void error
  return transition({ ...record, failureCode: code, failureStage: stage }, dependencies, 'needs_recovery')
}

async function transition(
  record: MutationJournalRecord,
  dependencies: MutationRunDependencies,
  state: MutationJournalState,
): Promise<MutationJournalRecord> {
  const next = {
    ...record,
    state,
    updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
  }
  const persisted = await dependencies.journal.save(next)
  return persisted ?? { ...next, journalVersion: record.journalVersion + 1 }
}
