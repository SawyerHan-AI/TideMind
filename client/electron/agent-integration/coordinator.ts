import {
  executionPlanHash,
  checkPlanAgainstConsent,
  type ConsentEnvelope,
  type PlanOperation,
  type SupplementalConsentClaim,
} from './consent'
import { publishIntegrationEvent, type IntegrationEventRepositoryPort, type NotificationPort } from './events'
import { sha256Json } from './fingerprint'
import { buildLegacyMutationDomain } from './legacy-writer'
import { executeMutation, recoverMutation, type MutationJournalRecord, type WriterFencePort } from './mutation-runner'
import { buildExecutionPlan, type PreparedCoordinatorPlan } from './planner'
import type {
  AdapterOperationContext,
  AdapterRuntimeContext,
  AgentHostAdapter,
  CapabilityLevel,
  CatalogId,
  ComponentKey,
  ComponentVerificationResult,
  DesiredState,
  HostActivityEvidenceReader,
  InstallationIdentity,
  OwnedArtifactBaseline,
  PlannedMutation,
  ReconcileState,
} from './types'

export interface CoordinatorInstallation {
  id: string
  displayName: string
  desiredState: DesiredState
  identity: InstallationIdentity
  /** Stable, persisted EB_AGENT_ID. Never derive this from discovery metadata. */
  agentId: string
}

export interface InstallationControlState {
  desiredState: DesiredState
  tombstoned: boolean
  healthState: 'discovered' | 'unknown' | 'missing_suspected' | 'host_uninstalled'
  statusReason: string | null
  installKey: string
  agentId: string
  hostVariant: CatalogId
  consentId: string | null
}

export interface PreparedMutationExecution {
  journal: MutationJournalRecord
  operationId: string
  mutationDomain: string
  plannedMutation: PlannedMutation
  effectDisposition?: 'apply' | 'consumer_detach'
}

export interface PrepareExecutionResult {
  mutations: readonly PreparedMutationExecution[]
}

export interface DisconnectScopeExpectation {
  componentKey: ComponentKey
  physicalTarget: string
  ownershipKey: string
  consumerKeys: readonly string[]
}

export interface PrepareExecutionInput {
  runId: string
  installationId: string
  operation: PlanOperation
  planHash: string
  consentId: string
  preparedPlan: PreparedCoordinatorPlan
  desiredCapability: CapabilityLevel
  mutations: readonly PreparedMutationExecution[]
  /** Frozen user intent rechecked in the same transaction that persists the run. */
  expectedDesiredState: DesiredState
  /** Intent and journal must be persisted in one database transaction. */
  intentAfterPrepare: 'managed' | 'removed'
  /** Explicit reconnect may clear a removed tombstone only inside prepare. */
  reconnectFromRemoved?: boolean
  /** Optional at this repository seam; the renderer service always supplies it for disconnect. */
  disconnectScopeExpectations?: readonly DisconnectScopeExpectation[]
  /** Frozen durable UI task-item binding committed with the run itself. */
  applyTaskBinding?: {
    taskId: string
    installationId: string
    executionPlanHash: string
  }
  createdAt: string
}

export interface VerifiedRecoverableExecution {
  runId: string
  runState: 'verified'
  installationId: string
  installationSurfaceFingerprint: string | null
  liveTrustProofFingerprint: string | null
}

export interface MutableRecoverableExecution {
  runId: string
  runState: 'applying' | 'applied_unverified' | 'compensating' | 'needs_recovery'
  installation: CoordinatorInstallation
  consentId: string
  desiredCapability: CapabilityLevel
  preparedPlan: PreparedCoordinatorPlan
  mutations: readonly PreparedMutationExecution[]
}

export type RecoverableExecution = VerifiedRecoverableExecution | MutableRecoverableExecution

/** Reads the surface binding covered by executionPlanHash; old/unbound plans fail closed. */
export function frozenPlanInstallationSurfaceFingerprint(plan: PreparedCoordinatorPlan): string | null {
  const value = (plan.executionPlan as typeof plan.executionPlan & {
    installationSurfaceFingerprint?: unknown
  }).installationSurfaceFingerprint
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

/** Reads the live distribution proof covered by executionPlanHash. */
export function frozenPlanLiveTrustProofFingerprint(plan: PreparedCoordinatorPlan): string | null {
  const value = plan.executionPlan.liveTrustProofFingerprint
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

export interface WriterFenceLease extends WriterFencePort {
  epoch: number
  writerGeneration: number
  release(): void | Promise<void>
}

export interface CoordinatorRepositoryPort extends IntegrationEventRepositoryPort {
  getInstallationControl(installationId: string): InstallationControlState | null | Promise<InstallationControlState | null>
  listOwnedArtifactBaselines(installationId: string): readonly OwnedArtifactBaseline[] | Promise<readonly OwnedArtifactBaseline[]>
  getInstallationHostVersion?(installationId: string): string | null | Promise<string | null>
  getConsent(consentId: string): ConsentEnvelope | null | Promise<ConsentEnvelope | null>
  setInstallationReconcileState(
    installationId: string,
    state: ReconcileState,
    reason: string | null,
    updatedAt: string,
    options?: { expectedDesiredState?: DesiredState; expectedConsentId?: string | null },
  ): boolean | void | Promise<boolean | void>
  prepareExecution(input: PrepareExecutionInput): PrepareExecutionResult | Promise<PrepareExecutionResult>
  saveMutation(
    runId: string,
    mutation: MutationJournalRecord,
  ): MutationJournalRecord | void | Promise<MutationJournalRecord | void>
  claimMutationEffect(input: {
    runId: string
    mutationId: string
    installation: CoordinatorInstallation
    consentId: string
    expectedDesiredState: 'managed' | 'removed'
    claimedAt: string
  }): boolean | Promise<boolean>
  revalidateClaimedMutationEffect(input: {
    runId: string
    mutationId: string
    installation: CoordinatorInstallation
    consentId: string
    expectedDesiredState: 'managed' | 'removed'
  }): boolean | Promise<boolean>
  setRunState(
    runId: string,
    state: 'preconditions_checked' | 'applying' | 'applied_unverified' | 'verified' | 'committed' | 'needs_recovery' | 'cancelled',
    updatedAt: string,
    failure?: { code: string; stage: string },
  ): void | Promise<void>
  acquireWriterFence(mutationDomain: string): WriterFenceLease | null | Promise<WriterFenceLease | null>
  recordVerification(input: {
    runId: string
    installation: CoordinatorInstallation
    result: ComponentVerificationResult
    adapterVersion: string
    catalogVersion: string
    tideMindVersion: string
    projectionVersion: string
    expectedHostVersion: string | null
    verifiedAt: string
  }): void | Promise<void>
  recordVerificationBatch(inputs: readonly {
    runId: string
    installation: CoordinatorInstallation
    result: ComponentVerificationResult
    adapterVersion: string
    catalogVersion: string
    tideMindVersion: string
    projectionVersion: string
    expectedHostVersion: string | null
    verifiedAt: string
  }[]): void | Promise<void>
  blockVerifiedFinalization(input: {
    runId: string
    installationId: string
    reason: string
    blockedAt: string
  }): void | Promise<void>
  listRecoverableExecutions(): readonly RecoverableExecution[] | Promise<readonly RecoverableExecution[]>
}

export interface AdapterResolverPort {
  get(catalogId: CatalogId): AgentHostAdapter | undefined
}

export interface CoordinatorClock {
  now(): Date
}

export interface CoordinatorIdFactory {
  next(prefix: 'operation' | 'run' | 'mutation' | 'event'): string
}

export interface CoordinatorDependencies {
  runtime: AdapterRuntimeContext
  adapters: AdapterResolverPort
  repository: CoordinatorRepositoryPort
  notifications: NotificationPort
  clock: CoordinatorClock
  ids: CoordinatorIdFactory
  catalogGeneration: number
  adapterGeneration(adapter: AgentHostAdapter): number
  projectionGeneration(adapter: AgentHostAdapter): number
  /** Freezes the complete discovery-owned projection surface into the durable plan hash. */
  installationSurfaceFingerprint?(installation: CoordinatorInstallation): string | null
  /** Produces a side-effect-free proof of the currently installed package/signature. */
  liveTrustProof?(installation: CoordinatorInstallation): string | null | Promise<string | null>
  /** Production composition rechecks exact current source trust at host/evidence boundaries. */
  authorizeEffect?(
    installation: CoordinatorInstallation,
    binding: { installationSurfaceFingerprint: string | null; liveTrustProofFingerprint: string | null },
  ): boolean | Promise<boolean>
  hostActivityEvidence?: HostActivityEvidenceReader
}

const HOST_ACTIVITY_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000

class FrozenGenerationChangedError extends Error {
  constructor(readonly reason: 'catalog_generation_changed' | 'adapter_generation_changed' | 'projection_generation_changed') {
    super(reason)
  }
}

class InstallationTrustChangedError extends Error {
  constructor() {
    super('recovery_source_trust_changed')
  }
}

export interface RecoveryOptions {
  /**
   * Replaying an idempotent Adapter effect requires current production write
   * authority as well as the persisted consent/state checks below.
   */
  canReplayEffect?(installation: CoordinatorInstallation): boolean | Promise<boolean>
  /**
   * Every recovery state, including read-only verification and finalization,
   * must still belong to the exact currently trusted Installation.
   */
  canContinueRecovery?(execution: RecoverableExecution): boolean | Promise<boolean>
}

export interface PreviewRequest {
  installation: CoordinatorInstallation
  operation: PlanOperation
  componentKeys: readonly ComponentKey[]
  desiredCapability: CapabilityLevel
}

export interface ApplyPreparedRequest {
  installation: CoordinatorInstallation
  preparedPlan: PreparedCoordinatorPlan
  consentId: string | null
  desiredCapability: CapabilityLevel
  /** Frozen consumer sets approved in the disconnect confirmation UI. */
  disconnectScopeExpectations?: readonly DisconnectScopeExpectation[]
  /** Persist an exact UI task-item ↔ durable run correlation with prepare. */
  applyTaskBinding?: PrepareExecutionInput['applyTaskBinding']
}

export type CoordinatorOutcome =
  | { status: 'awaiting_consent'; planHash: string; reasons: readonly string[] }
  | { status: 'awaiting_verification'; runId: string; verification: readonly ComponentVerificationResult[] }
  | { status: 'paused'; reason: 'disabled' | 'removed' | 'host_not_authoritatively_present' | 'installation_no_longer_managed' }
  | { status: 'committed'; runId: string; verification: readonly ComponentVerificationResult[] }
  | { status: 'needs_recovery'; runId: string; reason: string }

export class AgentIntegrationCoordinator {
  constructor(private readonly dependencies: CoordinatorDependencies) {}

  /** Read-only inspect + pure plan. No journal, consent, or host mutation occurs here. */
  async preview(request: PreviewRequest): Promise<PreparedCoordinatorPlan> {
    assertInstallation(request.installation)
    const adapter = this.requireAdapter(request.installation.identity.hostVariant)
    const context = this.context(request.installation, this.dependencies.ids.next('operation'))
    const inspection = await adapter.inspect(context)
    const implementedComponents = new Set(inspection.components.map(component => component.componentKey))
    const componentKeys = request.componentKeys.filter(component => implementedComponents.has(component))
    if (componentKeys.length === 0) {
      throw new Error(`no enabled component projection for ${request.installation.identity.hostVariant}`)
    }
    const ownedArtifacts = await this.dependencies.repository.listOwnedArtifactBaselines(request.installation.id)
    const adapterPlan = request.operation === 'disconnect'
      ? await adapter.disconnect(context, {
          componentKeys,
          observed: inspection,
          ownedArtifacts,
        })
      : await adapter.plan(context, {
          desiredCapability: request.desiredCapability,
          desiredComponents: componentKeys,
          observed: inspection,
          ownedArtifacts,
        })

    assertLedgerOwnership(adapterPlan.mutations, ownedArtifacts, request.operation)
    const prepared = buildExecutionPlan({
      installationId: request.installation.id,
      installationKey: request.installation.identity.installKey,
      operation: request.operation,
      componentKeys,
      inspection,
      adapterPlan,
      catalogGeneration: this.dependencies.catalogGeneration,
      adapterGeneration: this.dependencies.adapterGeneration(adapter),
      projectionGeneration: this.dependencies.projectionGeneration(adapter),
      createdAt: nowIso(this.dependencies.clock),
    })
    const surfaceFingerprint = this.dependencies.installationSurfaceFingerprint?.(request.installation)
    if (this.dependencies.installationSurfaceFingerprint && !surfaceFingerprint) {
      throw new Error('Installation projection surface could not be frozen')
    }
    const liveTrustProofFingerprint = await this.dependencies.liveTrustProof?.(request.installation)
    if (this.dependencies.liveTrustProof && !liveTrustProofFingerprint) {
      throw new Error('Installation live distribution trust could not be proved')
    }
    if (!surfaceFingerprint && !liveTrustProofFingerprint) return prepared
    const executionPlan = {
      ...prepared.executionPlan,
      ...(surfaceFingerprint ? { installationSurfaceFingerprint: surfaceFingerprint } : {}),
      ...(liveTrustProofFingerprint ? { liveTrustProofFingerprint } : {}),
    }
    return {
      ...prepared,
      executionPlan,
      executionPlanHash: executionPlanHash(executionPlan),
    }
  }

  async applyPrepared(request: ApplyPreparedRequest): Promise<CoordinatorOutcome> {
    assertInstallation(request.installation)
    assertPreparedPlan(request.installation, request.preparedPlan)
    const control = await this.dependencies.repository.getInstallationControl(request.installation.id)
    if (!control) throw new Error(`unknown Installation: ${request.installation.id}`)
    assertControlIdentity(request.installation, control)
    if (control.healthState !== 'discovered' || control.statusReason === 'conflict') {
      return { status: 'paused', reason: 'host_not_authoritatively_present' }
    }
    if (control.desiredState === 'disabled' && request.preparedPlan.operation !== 'disconnect') {
      await this.setInstallationState(request.installation.id, 'paused', 'user_disabled')
      return { status: 'paused', reason: 'disabled' }
    }
    const reconnectFromRemoved = request.preparedPlan.operation === 'connect'
      && request.installation.desiredState === 'removed'
      && control.desiredState === 'removed'
      && control.tombstoned
    if ((control.desiredState === 'removed' || control.tombstoned) && !reconnectFromRemoved) {
      await this.setInstallationState(request.installation.id, 'paused', 'installation_removed')
      return { status: 'paused', reason: 'removed' }
    }

    if (!request.consentId) return this.awaitConsent(request, ['consent_missing'], control)
    const consent = await this.dependencies.repository.getConsent(request.consentId)
    if (!consent) return this.awaitConsent(request, ['consent_missing'], control)
    const coverage = checkPlanAgainstConsent(
      request.preparedPlan.executionPlan,
      consent,
      supplementalConsentClaims(
        request.installation,
        request.preparedPlan,
        await this.dependencies.repository.listOwnedArtifactBaselines(request.installation.id),
      ),
    )
    if (!coverage.allowed || coverage.executionPlanHash !== request.preparedPlan.executionPlanHash) {
      return this.awaitConsent(
        request,
        coverage.reasons.length > 0 ? coverage.reasons : ['plan_hash_mismatch'],
        control,
      )
    }

    const runId = this.dependencies.ids.next('run')
    const preparedMutations = request.preparedPlan.adapterPlan.mutations.map((plannedMutation) => ({
      journal: journalFor(this.dependencies.ids.next('mutation'), plannedMutation, nowIso(this.dependencies.clock)),
      operationId: plannedMutation.operationId,
      mutationDomain: physicalMutationDomain(request.installation, plannedMutation),
      plannedMutation,
    }))
    const createdAt = nowIso(this.dependencies.clock)
    const prepared = await this.dependencies.repository.prepareExecution({
      runId,
      installationId: request.installation.id,
      operation: request.preparedPlan.operation,
      planHash: request.preparedPlan.executionPlanHash,
      consentId: consent.id,
      preparedPlan: request.preparedPlan,
      desiredCapability: request.desiredCapability,
      mutations: preparedMutations,
      expectedDesiredState: request.installation.desiredState,
      intentAfterPrepare: request.preparedPlan.operation === 'disconnect' ? 'removed' : 'managed',
      reconnectFromRemoved,
      disconnectScopeExpectations: request.disconnectScopeExpectations,
      applyTaskBinding: request.applyTaskBinding,
      createdAt,
    })

    return this.executePreparedRun({
      runId,
      installation: request.installation,
      consentId: consent.id,
      preparedPlan: request.preparedPlan,
      mutations: prepared.mutations,
      desiredCapability: request.desiredCapability,
      recovery: false,
    })
  }

  /** Recover persisted non-terminal mutations before starting ordinary reconciliation. */
  async recoverNonTerminalRuns(options: RecoveryOptions = {}): Promise<CoordinatorOutcome[]> {
    const pending = await this.dependencies.repository.listRecoverableExecutions()
    const outcomes: CoordinatorOutcome[] = []
    for (const execution of pending) {
      try {
        outcomes.push(await this.recoverExecution(execution, options))
      } catch (error) {
        outcomes.push(await this.isolateRecoveryExecutionFailure(execution, error))
      }
    }
    return outcomes
  }

  private async recoverExecution(
    execution: RecoverableExecution,
    options: RecoveryOptions,
  ): Promise<CoordinatorOutcome> {
    let recoveryAuthorized: boolean
    try {
      recoveryAuthorized = await options.canContinueRecovery?.(execution) !== false
    } catch {
      recoveryAuthorized = false
    }
    if (!recoveryAuthorized) {
      return execution.runState === 'verified'
        ? await this.blockVerifiedRecovery(execution, 'recovery_source_trust_changed')
        : await this.failRecovery(execution, 'recovery_source_trust_changed')
    }
    if (execution.runState === 'verified') {
      return this.finalizeVerifiedExecution(execution)
    }
    if (execution.runState === 'compensating') {
      return this.failRecovery(execution, 'compensation_requires_recovery_plan')
    }
    try {
      assertPreparedPlan(execution.installation, execution.preparedPlan)
    } catch {
      return this.failRecovery(execution, 'persisted_plan_hash_mismatch')
    }
    if (execution.runState === 'applied_unverified') {
      return this.retryAppliedVerification(execution, options)
    }
    return this.executePreparedRun({
      runId: execution.runId,
      installation: execution.installation,
      consentId: execution.consentId,
      preparedPlan: execution.preparedPlan,
      mutations: execution.mutations,
      desiredCapability: execution.preparedPlan.operation === 'disconnect' ? 0 : execution.desiredCapability,
      recovery: true,
      recoveryReplayGuard: () => this.checkRecoveryReplay(execution, options),
    })
  }

  private async isolateRecoveryExecutionFailure(
    execution: RecoverableExecution,
    error: unknown,
  ): Promise<CoordinatorOutcome> {
    const reason = 'recovery_execution_failed'
    const failedAt = nowIso(this.dependencies.clock)
    const installationId = execution.runState === 'verified'
      ? execution.installationId
      : execution.installation.id
    // A verified run is a finalizer-only token and must never be downgraded to
    // a replay-capable state. Mutable runs are quarantined at the durable run
    // boundary; if that transition itself failed, leave the predecessor intact.
    try {
      if (execution.runState === 'verified') {
        await this.dependencies.repository.blockVerifiedFinalization({
          runId: execution.runId,
          installationId,
          reason,
          blockedAt: failedAt,
        })
      } else {
        await this.dependencies.repository.setRunState(
          execution.runId,
          'needs_recovery',
          failedAt,
          { code: reason, stage: 'startup_recovery' },
        )
        await this.setInstallationState(
          execution.installation.id,
          'needs_recovery',
          reason,
          execution.preparedPlan.operation === 'disconnect' ? 'removed' : 'managed',
          execution.consentId,
        )
      }
    } catch {
      // Preserve the current durable predecessor when quarantine cannot be
      // proven. The next maintenance pass may retry it; never stop later runs.
    }
    try {
      await this.dependencies.repository.recordEvent({
        id: this.dependencies.ids.next('event'),
        installationId,
        componentKey: null,
        artifactId: null,
        kind: 'startup_recovery_execution_failed',
        severity: 'error',
        episodeId: null,
        dedupeKey: `${execution.runId}:${reason}`,
        payload: {
          runId: execution.runId,
          runState: execution.runState,
          message: error instanceof Error ? error.message : String(error),
        },
        createdAt: failedAt,
      })
    } catch {
      // Diagnostic persistence is explicitly non-blocking for recovery batch
      // progress; the durable run state remains the source of truth.
    }
    return { status: 'needs_recovery', runId: execution.runId, reason }
  }

  /**
   * Verification evidence and every host mutation are already durable.  This
   * crash-recovery branch may only run the repository's atomic finalizer; it
   * must never inspect, verify, or replay an Adapter effect.
   */
  private async finalizeVerifiedExecution(execution: VerifiedRecoverableExecution): Promise<CoordinatorOutcome> {
    try {
      await this.dependencies.repository.setRunState(
        execution.runId,
        'committed',
        nowIso(this.dependencies.clock),
      )
      return { status: 'committed', runId: execution.runId, verification: [] }
    } catch (error) {
      const createdAt = nowIso(this.dependencies.clock)
      await this.dependencies.repository.recordEvent({
        id: this.dependencies.ids.next('event'),
        installationId: execution.installationId,
        componentKey: null,
        artifactId: null,
        kind: 'verified_finalization_blocked',
        severity: 'error',
        episodeId: null,
        dedupeKey: `${execution.runId}:verified_finalization_blocked`,
        payload: { runId: execution.runId, reason: error instanceof Error ? error.message : String(error) },
        createdAt,
      })
      // The repository atomically either commits trustworthy current evidence
      // or cancels the stale finalizer token. It never downgrades `verified`
      // into a generic replay-capable recovery state.
      return { status: 'needs_recovery', runId: execution.runId, reason: 'verified_finalization_blocked' }
    }
  }

  private async blockVerifiedRecovery(
    execution: VerifiedRecoverableExecution,
    reason: string,
  ): Promise<CoordinatorOutcome> {
    const blockedAt = nowIso(this.dependencies.clock)
    await this.dependencies.repository.blockVerifiedFinalization({
      runId: execution.runId,
      installationId: execution.installationId,
      reason,
      blockedAt,
    })
    await this.dependencies.repository.recordEvent({
      id: this.dependencies.ids.next('event'),
      installationId: execution.installationId,
      componentKey: null,
      artifactId: null,
      kind: 'verified_finalization_blocked',
      severity: 'error',
      episodeId: null,
      dedupeKey: `${execution.runId}:${reason}`,
      payload: { runId: execution.runId, reason },
      createdAt: blockedAt,
    })
    return { status: 'needs_recovery', runId: execution.runId, reason }
  }

  /**
   * Projection effects are already committed in this state. Recovery must only
   * retry host recognition; replaying Adapter.apply would turn an ordinary
   * new-session requirement into an unsafe second write.
   */
  private async retryAppliedVerification(
    execution: MutableRecoverableExecution,
    options: RecoveryOptions,
  ): Promise<CoordinatorOutcome> {
    const control = await this.dependencies.repository.getInstallationControl(execution.installation.id)
    if (!control) return this.failRecovery(execution, 'installation_missing_during_verification')
    try {
      assertControlIdentity(execution.installation, control)
    } catch {
      return this.failRecovery(execution, 'installation_identity_changed_during_verification')
    }

    if (control.healthState !== 'discovered' || control.statusReason === 'conflict') {
      return this.failRecovery(execution, 'host_not_authoritatively_present')
    }
    const consent = await this.dependencies.repository.getConsent(execution.consentId)
    const coverage = consent
      ? checkPlanAgainstConsent(execution.preparedPlan.executionPlan, consent)
      : null
    if (!coverage?.allowed || coverage.executionPlanHash !== execution.preparedPlan.executionPlanHash) {
      return this.failRecovery(execution, 'consent_no_longer_covers_plan')
    }

    if (execution.preparedPlan.operation !== 'disconnect'
      && (control.desiredState === 'removed' || control.tombstoned)) {
      await this.dependencies.repository.setRunState(
        execution.runId,
        'cancelled',
        nowIso(this.dependencies.clock),
        { code: 'superseded_by_disconnect', stage: 'host_verification' },
      )
      return { status: 'paused', reason: 'removed' }
    }
    if (execution.mutations.some(mutation =>
      mutation.journal.state !== 'committed' && mutation.journal.state !== 'compensated')) {
      return this.failRecovery(execution, 'applied_run_has_uncommitted_mutation')
    }

    const adapter = this.requireAdapter(execution.installation.identity.hostVariant)
    const generationFailure = this.generationFailure(execution.preparedPlan, adapter)
    if (generationFailure) return this.failRecovery(execution, generationFailure)
    const detachedComponents = new Set(execution.mutations
      .filter(mutation => mutation.effectDisposition === 'consumer_detach')
      .map(mutation => mutation.plannedMutation.componentKey))
    const verificationComponents = execution.preparedPlan.componentKeys
      .filter(componentKey => !detachedComponents.has(componentKey))
    let verification: readonly ComponentVerificationResult[]
    try {
      verification = verificationComponents.length === 0
        ? []
        : await this.verify(
            execution,
            adapter,
            verificationComponents,
            () => this.assertRecoveryAuthorized(execution, options),
          )
    } catch (error) {
      if (error instanceof FrozenGenerationChangedError) {
        return this.failRecovery(execution, error.reason)
      }
      if (error instanceof InstallationTrustChangedError) {
        return this.failRecovery(execution, 'recovery_source_trust_changed')
      }
      return this.needsRecovery(execution, 'verification_failed', 'host_verification')
    }
    if (verification.some(result => result.status === 'failed')) {
      return this.needsRecovery(execution, 'verification_failed', 'host_verification')
    }
    if (!isCompleteVerification(verificationComponents, verification, execution.desiredCapability)) {
      return { status: 'awaiting_verification', runId: execution.runId, verification }
    }
    try {
      await this.assertRecoveryAuthorized(execution, options)
    } catch {
      return this.failRecovery(execution, 'recovery_source_trust_changed')
    }
    const preCommitGenerationFailure = this.generationFailure(execution.preparedPlan, adapter)
    if (preCommitGenerationFailure) return this.failRecovery(execution, preCommitGenerationFailure)
    const updatedAt = nowIso(this.dependencies.clock)
    await this.dependencies.repository.setRunState(execution.runId, 'verified', updatedAt)
    try {
      await this.assertRecoveryAuthorized(execution, options)
    } catch {
      return this.blockVerifiedRecovery({
        runId: execution.runId,
        runState: 'verified',
        installationId: execution.installation.id,
        installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(execution.preparedPlan),
        liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(execution.preparedPlan),
      }, 'recovery_source_trust_changed')
    }
    const finalGenerationFailure = this.generationFailure(execution.preparedPlan, adapter)
    if (finalGenerationFailure) {
      return this.blockVerifiedRecovery({
        runId: execution.runId,
        runState: 'verified',
        installationId: execution.installation.id,
        installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(execution.preparedPlan),
        liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(execution.preparedPlan),
      }, finalGenerationFailure)
    }
    await this.dependencies.repository.setRunState(execution.runId, 'committed', updatedAt)
    return { status: 'committed', runId: execution.runId, verification }
  }

  private async executePreparedRun(input: {
    runId: string
    installation: CoordinatorInstallation
    consentId: string
    preparedPlan: PreparedCoordinatorPlan
    mutations: readonly PreparedMutationExecution[]
    desiredCapability: CapabilityLevel
    recovery: boolean
    recoveryReplayGuard?: () => Promise<{ allowed: true } | { allowed: false; reason: string }>
  }): Promise<CoordinatorOutcome> {
    const adapter = this.requireAdapter(input.installation.identity.hostVariant)
    const operationById = new Map(input.preparedPlan.adapterPlan.mutations.map(mutation => [mutation.operationId, mutation]))
    if (!input.recovery) {
      await this.dependencies.repository.setRunState(input.runId, 'preconditions_checked', nowIso(this.dependencies.clock))
    }
    if (!input.recovery || input.mutations.some(mutation =>
      mutation.journal.state !== 'committed' && mutation.journal.state !== 'compensated')) {
      await this.dependencies.repository.setRunState(input.runId, 'applying', nowIso(this.dependencies.clock))
    }
    const executionDesiredState = input.preparedPlan.operation === 'disconnect' ? 'removed' : 'managed'
    await this.setInstallationState(input.installation.id, 'applying', null, executionDesiredState, input.consentId)

    for (const persisted of input.mutations) {
      if (persisted.journal.state === 'committed' || persisted.journal.state === 'compensated') continue
      if (persisted.journal.state === 'compensating') {
        return this.needsRecovery(input, 'compensation_requires_recovery_plan', 'compensation_restore')
      }
      const plannedMutation = operationById.get(persisted.operationId)
      if (!plannedMutation || !sameMutation(plannedMutation, persisted.plannedMutation)) {
        return this.needsRecovery(input, 'persisted_plan_mismatch', 'plan_restore')
      }
      let lease: WriterFenceLease | null = null
      if (!input.recovery) {
        try {
          lease = await this.dependencies.repository.acquireWriterFence(persisted.mutationDomain)
        } catch {
          return this.needsRecovery(input, 'writer_fence_unavailable', 'fence')
        }
        if (!lease) return this.needsRecovery(input, 'writer_fence_unavailable', 'fence')
      }
      let mutationFailure: { code: string; stage: string } | null = null
      try {
        let applyReceipt: unknown = null
        const context = this.context(input.installation, persisted.operationId)
        const runnerDependencies = {
          journal: {
            save: (record: MutationJournalRecord) => this.dependencies.repository.saveMutation(input.runId, record),
          },
          fence: {
            assertOwned: async () => {
              if (!lease) {
                lease = await this.dependencies.repository.acquireWriterFence(persisted.mutationDomain)
                if (!lease) throw new Error(`writer fence unavailable: ${persisted.mutationDomain}`)
              }
              await lease.assertOwned()
            },
          },
          effect: {
            apply: async () => {
              if (await this.dependencies.authorizeEffect?.(
                input.installation,
                this.trustBinding(input.preparedPlan),
              ) === false) {
                throw new Error('Installation source trust changed before mutation claim')
              }
              const claimed = await this.dependencies.repository.claimMutationEffect({
                runId: input.runId,
                mutationId: persisted.journal.id,
                installation: input.installation,
                consentId: input.consentId,
                expectedDesiredState: executionDesiredState,
                claimedAt: nowIso(this.dependencies.clock),
              })
              if (!claimed) throw new Error('mutation effect authorization changed before apply')
              await assertLivePrecondition(adapter, context, plannedMutation)
              if (await this.dependencies.authorizeEffect?.(
                input.installation,
                this.trustBinding(input.preparedPlan),
              ) === false) {
                throw new Error('Installation source trust changed before physical effect')
              }
              const stillAuthorized = await this.dependencies.repository.revalidateClaimedMutationEffect({
                runId: input.runId,
                mutationId: persisted.journal.id,
                installation: input.installation,
                consentId: input.consentId,
                expectedDesiredState: executionDesiredState,
              })
              if (!stillAuthorized) {
                throw new Error('mutation effect authorization changed before physical effect')
              }
              // The precondition read-back may await filesystem or host I/O. Recheck
              // the exact owner/epoch immediately before crossing the physical
              // effect boundary so an expired lease cannot resume into a write.
              if (!lease) throw new Error(`writer fence unavailable: ${persisted.mutationDomain}`)
              await lease.assertOwned()
              // Repository CAS and the writer-fence assertion are both awaitable.
              // Re-attest only after those waits so physical host/config mutation
              // is the very next external operation after source trust succeeds.
              if (await this.dependencies.authorizeEffect?.(
                input.installation,
                this.trustBinding(input.preparedPlan),
              ) === false) {
                throw new Error('Installation source trust changed at physical effect boundary')
              }
              applyReceipt = await adapter.apply(context, plannedMutation)
            },
            readBack: async () => readBackFingerprint(
              await adapter.readBack(context, plannedMutation),
              desiredFingerprint(plannedMutation),
            ),
            receipt: (fingerprint: string | null) => ({ adapterReceipt: applyReceipt, fingerprint }),
          },
          replayGuard: input.recoveryReplayGuard,
          now: () => nowIso(this.dependencies.clock),
        }
        const result = input.recovery
          ? await recoverMutation(persisted.journal, runnerDependencies)
          : await executeMutation(persisted.journal, runnerDependencies)
        if (result.state !== 'committed' && result.state !== 'compensated') {
          mutationFailure = {
            code: result.failureCode ?? 'mutation_needs_recovery',
            stage: result.failureStage ?? 'mutation',
          }
        }
      } catch {
        mutationFailure = { code: 'mutation_runner_failed', stage: 'mutation_runner' }
      } finally {
        if (lease) {
          try {
            await lease.release()
          } catch {
            mutationFailure ??= { code: 'writer_fence_release_failed', stage: 'fence_release' }
          }
        }
      }
      if (mutationFailure) return this.needsRecovery(input, mutationFailure.code, mutationFailure.stage)
    }

    await this.dependencies.repository.setRunState(input.runId, 'applied_unverified', nowIso(this.dependencies.clock))
    const verificationControl = await this.dependencies.repository.getInstallationControl(input.installation.id)
    if (!verificationControl) return this.needsRecovery(input, 'installation_missing_before_verification', 'verification')
    try {
      assertControlIdentity(input.installation, verificationControl)
    } catch {
      return this.needsRecovery(input, 'installation_identity_changed_before_verification', 'verification')
    }
    if (verificationControl.healthState !== 'discovered' || verificationControl.statusReason === 'conflict') {
      return this.needsRecovery(input, 'host_not_authoritatively_present', 'verification')
    }
    if (input.preparedPlan.operation !== 'disconnect'
      && (verificationControl.desiredState !== 'managed' || verificationControl.tombstoned)) {
      return { status: 'paused', reason: 'installation_no_longer_managed' }
    }
    await this.setInstallationState(input.installation.id, 'verifying', null, executionDesiredState, input.consentId)
    const detachedComponents = new Set(input.mutations
      .filter(mutation => mutation.effectDisposition === 'consumer_detach')
      .map(mutation => mutation.plannedMutation.componentKey))
    const verificationComponents = input.preparedPlan.componentKeys
      .filter(componentKey => !detachedComponents.has(componentKey))
    let verification: readonly ComponentVerificationResult[]
    const preVerificationGenerationFailure = this.generationFailure(input.preparedPlan, adapter)
    if (preVerificationGenerationFailure) {
      return this.needsRecovery(input, preVerificationGenerationFailure, 'verification')
    }
    try {
      verification = verificationComponents.length === 0
        ? []
        : await this.verify(
            input,
            adapter,
            verificationComponents,
            () => this.assertCurrentInstallationAuthorized(input.installation, input.preparedPlan),
          )
    } catch (error) {
      if (error instanceof FrozenGenerationChangedError) {
        return this.needsRecovery(input, error.reason, 'verification')
      }
      if (error instanceof InstallationTrustChangedError) {
        return this.needsRecovery(input, 'installation_source_trust_changed', 'verification')
      }
      return this.needsRecovery(input, 'verification_failed', 'verification')
    }
    if (verification.some(result => result.status === 'failed')) {
      return this.needsRecovery(input, 'verification_failed', 'verification')
    }
    if (!isCompleteVerification(verificationComponents, verification, input.desiredCapability)) {
      await this.setInstallationState(
        input.installation.id,
        'idle',
        'awaiting_host_verification',
        executionDesiredState,
        input.consentId,
      )
      return { status: 'awaiting_verification', runId: input.runId, verification }
    }
    try {
      await this.assertCurrentInstallationAuthorized(input.installation, input.preparedPlan)
    } catch {
      return this.needsRecovery(input, 'installation_source_trust_changed', 'verification')
    }
    const preCommitGenerationFailure = this.generationFailure(input.preparedPlan, adapter)
    if (preCommitGenerationFailure) return this.needsRecovery(input, preCommitGenerationFailure, 'verification')
    await this.dependencies.repository.setRunState(input.runId, 'verified', nowIso(this.dependencies.clock))
    try {
      await this.assertCurrentInstallationAuthorized(input.installation, input.preparedPlan)
    } catch {
      return this.blockVerifiedRecovery({
        runId: input.runId,
        runState: 'verified',
        installationId: input.installation.id,
        installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(input.preparedPlan),
        liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(input.preparedPlan),
      }, 'installation_source_trust_changed')
    }
    const finalGenerationFailure = this.generationFailure(input.preparedPlan, adapter)
    if (finalGenerationFailure) {
      return this.blockVerifiedRecovery({
        runId: input.runId,
        runState: 'verified',
        installationId: input.installation.id,
        installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(input.preparedPlan),
        liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(input.preparedPlan),
      }, finalGenerationFailure)
    }
    await this.dependencies.repository.setRunState(input.runId, 'committed', nowIso(this.dependencies.clock))
    return { status: 'committed', runId: input.runId, verification }
  }

  private async verify(
    input: {
      runId: string
      installation: CoordinatorInstallation
      preparedPlan: PreparedCoordinatorPlan
      desiredCapability: CapabilityLevel
    },
    adapter: AgentHostAdapter,
    componentKeys: readonly ComponentKey[],
    assertAuthorized: () => Promise<void>,
  ): Promise<readonly ComponentVerificationResult[]> {
    const context = this.context(input.installation, `${input.runId}:verify`)
    const inspection = await adapter.inspect(context)
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    const verificationAt = nowIso(this.dependencies.clock)
    const hostVersion = await this.dependencies.repository.getInstallationHostVersion?.(input.installation.id)
      ?? inspection.detectedVersion
      ?? null
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    const results = await adapter.verify(context, {
      componentKeys,
      expectedCapability: input.desiredCapability,
      inspection,
      activityBinding: {
        installationId: input.installation.id,
        tideMindVersion: this.dependencies.runtime.tideMindVersion,
        adapterVersion: adapter.adapterVersion,
        projectionVersion: input.preparedPlan.adapterPlan.projectionVersion,
        hostVersion,
        observedAfter: new Date(Date.parse(verificationAt) - HOST_ACTIVITY_FRESHNESS_MS).toISOString(),
        verifiedAt: verificationAt,
      },
    })
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    const seen = new Set<ComponentKey>()
    for (const result of results) {
      if (!componentKeys.includes(result.componentKey)) {
        throw new Error(`verification result outside prepared component scope: ${result.componentKey}`)
      }
      if (seen.has(result.componentKey)) throw new Error(`duplicate verification result: ${result.componentKey}`)
      if (result.status === 'verified' && result.identityAssertion !== input.installation.agentId) {
        throw new Error(`verification identity assertion mismatch: ${result.componentKey}`)
      }
      if (result.status === 'verified' && result.invalidationKeys.includes('activity_freshness')) {
        if (!result.evidenceRef?.startsWith('host-activity:')
          || !result.evidenceHash
          || !result.expiresAt
          || !Number.isFinite(Date.parse(result.expiresAt))
          || Date.parse(result.expiresAt) <= Date.parse(verificationAt)) {
          throw new Error(`host activity verification binding is incomplete: ${result.componentKey}`)
        }
      }
      seen.add(result.componentKey)
    }
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    await this.dependencies.repository.recordVerificationBatch(results.map(result => ({
      runId: input.runId,
      installation: input.installation,
      result,
      adapterVersion: adapter.adapterVersion,
      catalogVersion: this.dependencies.runtime.catalogVersion,
      tideMindVersion: this.dependencies.runtime.tideMindVersion,
      projectionVersion: input.preparedPlan.adapterPlan.projectionVersion,
      expectedHostVersion: hostVersion,
      verifiedAt: verificationAt,
    })))
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    return results
  }

  /**
   * Recovery invokes this only after a side-effect-free read-back proves the
   * old before state. A paused/revoked/stale plan can therefore never replay an
   * effect, while an effect that already happened can still be journaled.
   */
  private async checkRecoveryReplay(
    execution: MutableRecoverableExecution,
    options: RecoveryOptions,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    try {
      if (await options.canReplayEffect?.(execution.installation) === false) {
        return { allowed: false, reason: 'recovery_write_gate_closed' }
      }
      const control = await this.dependencies.repository.getInstallationControl(execution.installation.id)
      if (!control) return { allowed: false, reason: 'installation_missing' }
      try {
        assertControlIdentity(execution.installation, control)
      } catch {
        return { allowed: false, reason: 'installation_identity_changed' }
      }
      if (control.desiredState === 'disabled') {
        return { allowed: false, reason: 'installation_disabled' }
      }
      if ((control.desiredState === 'removed' || control.tombstoned)
        && execution.preparedPlan.operation !== 'disconnect') {
        return { allowed: false, reason: 'installation_removed' }
      }
      if (control.healthState !== 'discovered' || control.statusReason === 'conflict') {
        return { allowed: false, reason: 'host_not_authoritatively_present' }
      }

      const consent = await this.dependencies.repository.getConsent(execution.consentId)
      const coverage = consent
        ? checkPlanAgainstConsent(execution.preparedPlan.executionPlan, consent)
        : null
      if (!coverage?.allowed || coverage.executionPlanHash !== execution.preparedPlan.executionPlanHash) {
        return { allowed: false, reason: 'consent_no_longer_covers_plan' }
      }

      const adapter = this.requireAdapter(execution.installation.identity.hostVariant)
      const generationFailure = this.generationFailure(execution.preparedPlan, adapter)
      if (generationFailure) return { allowed: false, reason: generationFailure }
      return { allowed: true }
    } catch {
      return { allowed: false, reason: 'recovery_replay_guard_failed' }
    }
  }

  private generationFailure(
    preparedPlan: PreparedCoordinatorPlan,
    adapter: AgentHostAdapter,
  ): 'catalog_generation_changed' | 'adapter_generation_changed' | 'projection_generation_changed' | null {
    if (preparedPlan.executionPlan.catalogVersion !== this.dependencies.catalogGeneration) {
      return 'catalog_generation_changed'
    }
    if (preparedPlan.executionPlan.adapterVersion !== this.dependencies.adapterGeneration(adapter)) {
      return 'adapter_generation_changed'
    }
    if (preparedPlan.executionPlan.projectionVersion !== this.dependencies.projectionGeneration(adapter)) {
      return 'projection_generation_changed'
    }
    return null
  }

  private assertFrozenGenerations(preparedPlan: PreparedCoordinatorPlan, adapter: AgentHostAdapter): void {
    const failure = this.generationFailure(preparedPlan, adapter)
    if (failure) throw new FrozenGenerationChangedError(failure)
  }

  private trustBinding(preparedPlan: PreparedCoordinatorPlan): {
    installationSurfaceFingerprint: string | null
    liveTrustProofFingerprint: string | null
  } {
    return {
      installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(preparedPlan),
      liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(preparedPlan),
    }
  }

  private async assertCurrentInstallationAuthorized(
    installation: CoordinatorInstallation,
    preparedPlan: PreparedCoordinatorPlan,
  ): Promise<void> {
    if (await this.dependencies.authorizeEffect?.(installation, this.trustBinding(preparedPlan)) === false) {
      throw new InstallationTrustChangedError()
    }
  }

  private async assertRecoveryAuthorized(
    execution: MutableRecoverableExecution,
    options: RecoveryOptions,
  ): Promise<void> {
    await this.assertCurrentInstallationAuthorized(execution.installation, execution.preparedPlan)
    if (await options.canContinueRecovery?.(execution) === false) {
      throw new InstallationTrustChangedError()
    }
  }

  private async awaitConsent(
    request: ApplyPreparedRequest,
    reasons: readonly string[],
    expectedControl: InstallationControlState,
  ): Promise<CoordinatorOutcome> {
    await this.setInstallationState(
      request.installation.id,
      'awaiting_consent',
      reasons[0] ?? 'awaiting_consent',
      expectedControl.desiredState,
      expectedControl.consentId,
    )
    return { status: 'awaiting_consent', planHash: request.preparedPlan.executionPlanHash, reasons }
  }

  private async failRecovery(execution: MutableRecoverableExecution, reason: string): Promise<CoordinatorOutcome> {
    return this.needsRecovery({
      runId: execution.runId,
      installation: execution.installation,
      consentId: execution.consentId,
      preparedPlan: execution.preparedPlan,
    }, reason, 'startup_recovery')
  }

  private async needsRecovery(
    input: {
      runId: string
      installation: CoordinatorInstallation
      consentId?: string
      preparedPlan?: Pick<PreparedCoordinatorPlan, 'operation'>
    },
    code: string,
    stage: string,
  ): Promise<CoordinatorOutcome> {
    const createdAt = nowIso(this.dependencies.clock)
    await this.dependencies.repository.setRunState(input.runId, 'needs_recovery', createdAt, { code, stage })
    await this.setInstallationState(
      input.installation.id,
      'needs_recovery',
      code,
      input.preparedPlan?.operation === 'disconnect' ? 'removed' : 'managed',
      input.consentId,
    )
    const eventId = this.dependencies.ids.next('event')
    await publishIntegrationEvent({
      id: eventId,
      installationId: input.installation.id,
      componentKey: null,
      artifactId: null,
      kind: 'reconcile_needs_recovery',
      severity: 'warning',
      episodeId: null,
      dedupeKey: `${input.runId}:${code}:${stage}`,
      payload: { runId: input.runId, code, stage },
      createdAt,
    }, null, this.dependencies)
    return { status: 'needs_recovery', runId: input.runId, reason: code }
  }

  private context(installation: CoordinatorInstallation, operationId: string): AdapterOperationContext {
    return {
      runtime: this.dependencies.runtime,
      installation: installation.identity,
      agentId: installation.agentId,
      operationId,
      hostActivityEvidence: this.dependencies.hostActivityEvidence,
    }
  }

  private requireAdapter(catalogId: CatalogId): AgentHostAdapter {
    const adapter = this.dependencies.adapters.get(catalogId)
    if (!adapter) throw new Error(`no enabled Adapter for ${catalogId}`)
    if (adapter.catalogId !== catalogId) throw new Error(`Adapter registry returned ${adapter.catalogId} for ${catalogId}`)
    return adapter
  }

  private async setInstallationState(
    installationId: string,
    state: ReconcileState,
    reason: string | null,
    expectedDesiredState?: DesiredState,
    expectedConsentId?: string | null,
  ): Promise<void> {
    const options: { expectedDesiredState?: DesiredState; expectedConsentId?: string | null } = {}
    if (expectedDesiredState !== undefined) options.expectedDesiredState = expectedDesiredState
    if (expectedConsentId !== undefined) options.expectedConsentId = expectedConsentId
    await this.dependencies.repository.setInstallationReconcileState(
      installationId,
      state,
      reason,
      nowIso(this.dependencies.clock),
      options,
    )
  }
}

export function supplementalConsentClaims(
  installation: CoordinatorInstallation,
  preparedPlan: PreparedCoordinatorPlan,
  ownedArtifacts: readonly OwnedArtifactBaseline[],
): SupplementalConsentClaim[] {
  const mutatedComponents = new Set(
    preparedPlan.executionPlan.mutations.map(mutation => mutation.componentKey),
  )
  const requested = new Set(preparedPlan.componentKeys)
  const eligible = ownedArtifacts
    .filter(artifact => requested.has(artifact.componentKey) && !mutatedComponents.has(artifact.componentKey))
  return eligible
    .map(artifact => ({
      ...(() => {
        const observation = preparedPlan.inspection.components.find(component => (
          component.componentKey === artifact.componentKey
        ))
        const relocatedMatches = eligible.filter(candidate => (
          candidate.componentKey === artifact.componentKey
          && observation?.observedFragmentHash === candidate.ownedFragmentHash
          && observation.observedTarget
          && candidate.physicalTarget !== observation.observedTarget
        ))
        return {
          targetPath: relocatedMatches.length === 1
            ? observation!.observedTarget!
            : artifact.physicalTarget,
        }
      })(),
      componentKey: artifact.componentKey,
      artifactKey: `${installation.identity.hostVariant}:${artifact.componentKey}:${artifact.ownershipKey}`,
      ownershipSelector: artifact.ownershipKey,
      selectorSchemaVersion: artifact.selectorSchemaVersion ?? 1,
      commandCategory: 'file_write' as const,
      risk: 'low' as const,
    }))
}

function assertInstallation(installation: CoordinatorInstallation): void {
  if (!installation.id || !installation.agentId) throw new Error('Installation requires persisted id and agentId')
  if (installation.identity.installKey.length === 0) throw new Error('Installation requires a stable installKey')
}

function assertControlIdentity(
  installation: CoordinatorInstallation,
  control: InstallationControlState,
): void {
  if (control.installKey !== installation.identity.installKey
    || control.agentId !== installation.agentId
    || control.hostVariant !== installation.identity.hostVariant) {
    throw new Error(`Installation identity changed: ${installation.id}`)
  }
}

function assertPreparedPlan(installation: CoordinatorInstallation, plan: PreparedCoordinatorPlan): void {
  if (plan.executionPlan.installationId !== installation.id) throw new Error('prepared plan belongs to another Installation')
  if (plan.adapterPlan.installationKey !== installation.identity.installKey) {
    throw new Error('prepared plan Installation key no longer matches')
  }
  if (executionPlanHash(plan.executionPlan) !== plan.executionPlanHash) {
    throw new Error('prepared execution plan was modified after preview')
  }
  if (sha256Json(plan.adapterPlan) !== plan.adapterPlanHash) {
    throw new Error('prepared Adapter plan was modified after preview')
  }
}

/** Existing content can only be updated/removed/repaired with an exact Ledger baseline. */
function assertLedgerOwnership(
  mutations: readonly PlannedMutation[],
  baselines: readonly OwnedArtifactBaseline[],
  operation: PlanOperation,
): void {
  for (const mutation of mutations) {
    if ((mutation.operation === 'create' && operation !== 'repair') || mutation.operation === 'host_command') continue
    const baseline = baselines.find(candidate => candidate.componentKey === mutation.componentKey
      && candidate.physicalTarget === mutation.physicalTarget
      && candidate.ownershipKey === mutation.ownershipKey)
    if (!baseline) {
      throw new Error(`ownership_conflict:${mutation.operationId}`)
    }
    if (mutation.operation !== 'create' && mutation.preconditionHash === undefined) {
      throw new Error(`ownership_precondition_missing:${mutation.operationId}`)
    }
    if (mutation.preconditionHash !== undefined && mutation.preconditionHash !== baseline.ownedFragmentHash) {
      throw new Error(`ownership_baseline_mismatch:${mutation.operationId}`)
    }
  }
}

function journalFor(id: string, mutation: PlannedMutation, createdAt: string): MutationJournalRecord {
  return {
    id,
    state: 'prepared',
    journalVersion: 0,
    attemptCount: 0,
    idempotent: mutation.idempotent,
    beforeFingerprint: mutation.preconditionHash ?? null,
    desiredFingerprint: desiredFingerprint(mutation),
    postEffectFingerprint: null,
    compensationPrecondition: null,
    receiptJson: null,
    failureCode: null,
    failureStage: null,
    updatedAt: createdAt,
  }
}

function desiredFingerprint(mutation: PlannedMutation): string | null {
  if (mutation.operation === 'remove') return null
  return mutation.desiredFragmentHash ?? `desired:${mutation.operation}:${mutation.operationId}`
}

export function physicalMutationDomain(installation: CoordinatorInstallation, mutation: PlannedMutation): string {
  // A fence protects the physical mutation surface, not an ownership selector.
  // In particular every fragment writer for the same JSON/TOML document must
  // contend with the legacy writer on one `...:file:<target>:document` domain.
  if (mutation.domainKind === 'file_fragment' && installation.identity.runtimeRealm === 'local_macos') {
    return buildLegacyMutationDomain({
      adapterId: installation.identity.hostVariant,
      target: mutation.physicalTarget,
      selector: 'document',
    })
  }
  return `${installation.identity.runtimeRealm}:${mutation.domainKind}:${mutation.physicalTarget}`
}

async function assertLivePrecondition(
  adapter: AgentHostAdapter,
  context: AdapterOperationContext,
  mutation: PlannedMutation,
): Promise<void> {
  const observation = await adapter.readBack(context, mutation)
  if (mutation.operation === 'create' && mutation.preconditionHash === undefined) {
    if (observation.observed) throw new Error(`unowned_selector_occupied:${mutation.operationId}`)
    return
  }
  if (mutation.preconditionHash === undefined) return
  if (observation.observedFragmentHash !== mutation.preconditionHash) {
    throw new Error(`live_precondition_changed:${mutation.operationId}`)
  }
}

function readBackFingerprint(
  readBack: Awaited<ReturnType<AgentHostAdapter['readBack']>>,
  desired: string | null,
): string | null {
  if (readBack.matchesDesired) return readBack.observedFragmentHash ?? desired
  if (!readBack.observed) return null
  // Never infer the planned before hash from a hashless observation. Recovery
  // may replay only when read-back positively proves that exact fingerprint.
  return readBack.observedFragmentHash ?? 'observed:unknown'
}

function isCompleteVerification(
  expected: readonly ComponentKey[],
  results: readonly ComponentVerificationResult[],
  expectedCapability: CapabilityLevel,
): boolean {
  if (results.length !== new Set(expected).size) return false
  const expectedSet = new Set(expected)
  if (!results.every(result => expectedSet.has(result.componentKey) && result.status === 'verified')) return false
  return Math.max(0, ...results.map(result => result.verifiedCapability ?? 0)) >= expectedCapability
}

function sameMutation(left: PlannedMutation, right: PlannedMutation): boolean {
  return sha256Json(left) === sha256Json(right)
}

function nowIso(clock: CoordinatorClock): string {
  return clock.now().toISOString()
}
