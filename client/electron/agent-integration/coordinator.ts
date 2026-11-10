import { DesktopSourceVerificationUnavailable } from './mac-code-signature'
import { freshCodexIdentityFingerprint, type CodexFreshIdentityPlan } from './codex-fresh-identity'
import { codexSelectionFingerprint, selectedCodexBaselines, prospectiveCodexIdentity, type CodexLegacySelection } from './codex-legacy-selection'
import {
  nativePermissionsForPlan,
  executionPlanHash,
  checkPlanAgainstConsent,
  type ConsentEnvelope,
  type PlanOperation,
  type SupplementalConsentClaim,
} from './consent'
import { publishIntegrationEvent, type IntegrationEventRepositoryPort, type NotificationPort } from './events'
import { sha256Json } from './fingerprint'
import { buildLegacyMutationDomain } from './legacy-writer'
import { executeMutation, recoverMutation, WriterFenceUnavailableError, type MutationJournalRecord, type WriterFencePort } from './mutation-runner'
import { assertPersistedPreparedPlanShape, buildExecutionPlan, type PreparedCoordinatorPlan } from './planner'
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
import { isMutationDomainKind } from './types'
import { variantDeclarationFor } from './variant-declarations'

export interface CoordinatorInstallation {
  id: string
  displayName: string
  desiredState: DesiredState
  identity: InstallationIdentity
  /** Stable, persisted EB_AGENT_ID. Never derive this from discovery metadata. */
  agentId: string
  installationAgentId?: string
  sharedIdentityBinding?: string
}

export interface InstallationControlState {
  desiredState: DesiredState
  tombstoned: boolean
  healthState: 'discovered' | 'unknown' | 'missing_suspected' | 'host_uninstalled'
  statusReason: string | null
  installKey: string
  agentId: string
  installationAgentId?: string
  sharedIdentityBinding?: string
  hostVariant: CatalogId
  consentId: string | null
}

export interface PreparedMutationExecution {
  journal: MutationJournalRecord
  operationId: string
  mutationDomain: string
  /** Extra physical domains held for one aggregate host-owned effect. */
  additionalMutationDomains?: readonly string[]
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

export interface FileRepairWait {
  runId: string
  installation: CoordinatorInstallation
  preparedPlan: PreparedCoordinatorPlan
  desiredCapability: CapabilityLevel
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
    approvedExecutionPlanHash?: string
  }
  fileRepairPeerProofs?: readonly { runId: string; planHash: string }[]
  createdAt: string
}

export interface VerifiedRecoverableExecution {
  codexLegacySelectionReadBack?: {installation:CoordinatorInstallation;preparedPlan:PreparedCoordinatorPlan}

  runId: string
  runState: 'verified'
  installationId: string
  installationSurfaceFingerprint: string | null
  liveTrustProofFingerprint: string | null
  /** Set only for an ownership-only disconnect finalizer (no live source proof). */
  ownershipOnlyDisconnectBinding?: string | null
}

export interface MutableRecoverableExecution {
  runId: string
  runState: 'applying' | 'applied_unverified' | 'compensating' | 'needs_recovery'
  /** Durable lower bound for activity belonging to this activation epoch. */
  activationEpoch?: string
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
  completedFileRepairWait?(installationId: string, componentKeys: readonly ComponentKey[]): FileRepairWait | null
  fileRepairPeers?(installationId: string, plan: PreparedCoordinatorPlan): readonly FileRepairWait[]
  reusableMemoryVerification?(runId: string, at: string, tideMindVersion: string, catalogVersion: string): { verificationId: string; result: ComponentVerificationResult } | null
  isRunConnectionIntentCurrent?(runId: string): boolean
  refreshRecoveryConnectionIntent?(runId: string, at: string): boolean
  pendingAppliedRemovalCandidates?(runId: string): readonly {mutationId:string;snapshot:string}[] | Promise<readonly {mutationId:string;snapshot:string}[]>
  reconcileAppliedRemovalCandidates?(runId: string, expected: readonly {mutationId:string;snapshot:string}[], at: string): boolean | Promise<boolean>
  recipeUpgradePredecessorTrust?(runId: string, installationId: string, planHash: string): {
    installation: CoordinatorInstallation; preparedPlan: PreparedCoordinatorPlan
  } | null | Promise<{ installation: CoordinatorInstallation; preparedPlan: PreparedCoordinatorPlan } | null>
  retainedZeroEffectPeerTrust?(installationId:string,plan:PreparedCoordinatorPlan): {
    installation:CoordinatorInstallation;preparedPlan:PreparedCoordinatorPlan
  }|null|Promise<{installation:CoordinatorInstallation;preparedPlan:PreparedCoordinatorPlan}|null>
  isCompletedGenerationTakeoverCurrent?(installationId: string, plan: PreparedCoordinatorPlan): boolean | Promise<boolean>
  getInstallationControl(installationId: string): InstallationControlState | null | Promise<InstallationControlState | null>
  listOwnedArtifactBaselines(installationId: string): readonly OwnedArtifactBaseline[] | Promise<readonly OwnedArtifactBaseline[]>
  getInstallationHostVersion(installationId: string): string | null | Promise<string | null>
  getCurrentActivityGenerationToken?(
    installationId: string,
    componentKeys: readonly ComponentKey[],
    forDisconnect?: boolean,
    forRepair?: boolean,
  ): string | null | Promise<string | null>
  getConsent(consentId: string, planHash?: string): ConsentEnvelope | null | Promise<ConsentEnvelope | null>
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
  acquireExecutionFence(runId: string): { assertOwned(): void; release(): void } | null
  listRecoverableRunIds(): readonly string[] | Promise<readonly string[]>
  getRecoverableExecution(runId: string): RecoverableExecution | null | Promise<RecoverableExecution | null>
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
    reusedVerificationId?: string
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
    reusedVerificationId?: string
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
  authorizeAutomaticMaintenancePlan?(request: ApplyPreparedRequest): void | Promise<void>
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
    binding: EffectTrustBinding,
    scope?: EffectAuthorizationScope,
  ): boolean | Promise<boolean>
  /**
   * Other registered consumers (active or removal_pending, paused included) of the
   * physical artifact/container a mutation writes (design §3.3.1). Absent means the
   * composition has no shared-domain ledger and no shared-write gate applies.
   */
  sharedDomainConsumers?(
    installation: CoordinatorInstallation,
    mutation: PlannedMutation,
  ): readonly SharedDomainConsumer[] | Promise<readonly SharedDomainConsumer[]>
  hostActivityEvidence?: HostActivityEvidenceReader
  codexHookTrustEvidence?: AdapterOperationContext['codexHookTrustEvidence']
  guidedRemovalEvidence?: AdapterOperationContext['guidedRemovalEvidence']
}

export interface SharedDomainConsumer {
  installationId: string
  /** Opaque per-consumer generation bound into the write CAS. */
  generation: string
  /** Non-null when a shared write could affect an incompatible/untrusted consumer. */
  blockingReason: string | null
}

export const SHARED_DOMAIN_SET_CHANGED = 'shared_consumer_set_changed'

/** Frozen trust material of a plan, rechecked at every effect/evidence boundary. */
export interface EffectTrustBinding {
  installationSurfaceFingerprint: string | null
  liveTrustProofFingerprint: string | null
  /** Ownership-only disconnect (design §3.5); never a claim that the source is trusted. */
  ownershipOnlyDisconnectBinding?: string | null
}

/** What is about to happen, so an ownership-only disconnect can be scoped narrowly. */
export interface EffectAuthorizationScope {
  operation: PlanOperation
  /** The physical mutation domain, or null for read-only verification/finalization. */
  mutationDomain: PlannedMutation['domainKind'] | null
}

/**
 * `ownership_only`: a disconnect of Tide Mind-owned file fragments while the host
 * source is not (or no longer) trusted. No host program is inspected or run; the
 * plan binds ownership selectors, targets and current bytes instead of a live
 * source proof, and every effect still needs Ledger ownership plus live CAS.
 */
export type PreviewTrustMode = 'source_trusted' | 'ownership_only'

export const OWNERSHIP_ONLY_REQUIRES_HOST_COMMAND = 'ownership_only_disconnect_requires_host_command'

/** Reads the ownership-only disconnect binding covered by executionPlanHash. */
export function frozenPlanOwnershipOnlyBinding(plan: PreparedCoordinatorPlan): string | null {
  const value = plan.executionPlan.ownershipOnlyDisconnectBinding
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

/** A disconnect planned without source trust: bound only to ownership and live bytes. */
export function isOwnershipOnlyDisconnectPlan(plan: PreparedCoordinatorPlan): boolean {
  return plan.operation === 'disconnect'
    && frozenPlanOwnershipOnlyBinding(plan) !== null
    && frozenPlanLiveTrustProofFingerprint(plan) === null
}

/** Reads the shared-domain consumer binding covered by executionPlanHash. */
export function frozenPlanSharedDomainBinding(plan: PreparedCoordinatorPlan): string | null {
  const value = plan.executionPlan.sharedDomainBinding
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

const HOST_ACTIVITY_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000

function assertHostCapabilityCeiling(
  installation: CoordinatorInstallation,
  operation: PlanOperation,
  desiredCapability: CapabilityLevel,
): void {
  if (installation.identity.hostVariant === 'custom-local-mcp'
    && operation !== 'disconnect'
    && desiredCapability > 2) {
    throw new Error('custom_mcp_capability_ceiling_exceeded')
  }
}

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
  canReplayEffect?(
    installation: CoordinatorInstallation,
    execution?: MutableRecoverableExecution,
  ): boolean | Promise<boolean>
  /**
   * Every recovery state, including read-only verification and finalization,
   * must still belong to the exact currently trusted Installation.
   */
  canContinueRecovery?(execution: RecoverableExecution): boolean | Promise<boolean>
}

export interface PreviewRequest {
  /** Internal re-preview only; never supplied by renderer input. */
  frozenOperationId?: string
  codexFreshIdentity?: CodexFreshIdentityPlan
  codexLegacySelection?: CodexLegacySelection

  installation: CoordinatorInstallation
  operation: PlanOperation
  componentKeys: readonly ComponentKey[]
  desiredCapability: CapabilityLevel
  /**
   * Internal freshness checks must reproduce the exact generation frozen in
   * the user-approved plan. This is never accepted from renderer input.
   */
  frozenActivityGenerationToken?: string
  /** Defaults to `source_trusted`; `ownership_only` is valid only for disconnect. */
  trustMode?: PreviewTrustMode
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

export class ConnectionIntentChangedError extends Error {
  constructor() { super('connection_intent_changed') }
}

export class AgentIntegrationCoordinator {
  constructor(private readonly dependencies: CoordinatorDependencies) {}

  /** Read-only inspect + pure plan. No journal, consent, or host mutation occurs here. */
  async preview(request: PreviewRequest): Promise<PreparedCoordinatorPlan> {
    assertInstallation(request.installation)
    assertHostCapabilityCeiling(request.installation, request.operation, request.desiredCapability)
    const adapter = this.requireAdapter(request.installation.identity.hostVariant)
    const ownershipOnly = request.trustMode === 'ownership_only'
    if (ownershipOnly) {
      if (request.operation !== 'disconnect') throw new Error('ownership_only_requires_disconnect')
      // Decide before inspect: a host-command/plugin-manager Adapter would have to
      // run the untrusted host program even to read its state.
      for (const componentKey of request.componentKeys) {
        const domain = adapter.componentContracts?.[componentKey]?.mutationDomain
        if (domain !== 'file_fragment' && domain !== 'none') {
          throw new Error(OWNERSHIP_ONLY_REQUIRES_HOST_COMMAND)
        }
      }
    }
    const ownedArtifacts = request.codexLegacySelection
      ? selectedCodexBaselines(request.codexLegacySelection, request.installation.id)
      : await this.dependencies.repository.listOwnedArtifactBaselines(request.codexFreshIdentity?.carrierInstallationId ?? request.installation.id)
    const repairWait = request.operation === 'repair'
      ? this.dependencies.repository.completedFileRepairWait?.(request.installation.id, request.componentKeys) ?? null : null
    const sameGenerationWait = repairWait && !this.generationFailure(repairWait.preparedPlan, adapter) ? repairWait : null
    const verificationDependencies = request.operation === 'repair'
      && request.componentKeys.length === 1 && request.componentKeys[0] === 'instruction'
      ? [...(adapter.verificationDependencies?.instruction ?? [])]
      : []
    for (const componentKey of verificationDependencies) {
      if (!ownedArtifacts.some(artifact => artifact.componentKey === componentKey)) {
        throw new Error(`repair_verification_dependency_unmanaged:${componentKey}`)
      }
    }
    const requestedComponents = [...new Set([...request.componentKeys, ...verificationDependencies])]
    const persistedHostVersion = await this.dependencies.repository.getInstallationHostVersion(request.installation.id)
    const frozenOperationId = request.frozenOperationId?.trim()
    if (request.frozenOperationId !== undefined && !frozenOperationId) throw new Error('Frozen operation ID is invalid')
    const operationId = frozenOperationId ?? this.dependencies.ids.next('operation')
    const currentActivityToken = (request.installation.desiredState === 'managed' || request.installation.sharedIdentityBinding)
      ? await this.dependencies.repository.getCurrentActivityGenerationToken?.(
          request.codexFreshIdentity?.carrierInstallationId ?? request.installation.id,
          request.installation.sharedIdentityBinding
            ? [...new Set([...request.componentKeys, ...verificationDependencies])]
            : verificationDependencies.length > 0 ? verificationDependencies : request.componentKeys,
          request.operation === 'disconnect',
          request.operation === 'repair',
        ) ?? null
      : null
    const frozenActivityGenerationToken = request.frozenActivityGenerationToken?.trim()
    if (request.frozenActivityGenerationToken !== undefined && !frozenActivityGenerationToken) {
      throw new Error('Frozen activity generation token is invalid')
    }
    let activityGenerationToken = frozenActivityGenerationToken ?? sameGenerationWait?.preparedPlan.activityGenerationToken ?? currentActivityToken ?? operationId
    let context = this.context(
      request.installation,
      operationId,
      persistedHostVersion ?? null,
      activityGenerationToken,
    )
    if (request.codexLegacySelection) context.codexLegacySelection = request.codexLegacySelection
    const observedInspection = await adapter.inspect(context)
    if (observedInspection.detectedVersion !== undefined
      && observedInspection.detectedVersion !== persistedHostVersion) {
      throw new Error('Installation host version changed during preview')
    }
    let inspection = observedInspection.detectedVersion === undefined
      ? { ...observedInspection, detectedVersion: persistedHostVersion ?? undefined }
      : observedInspection
    const implementedComponents = new Set(inspection.components.map(component => component.componentKey))
    let sameGenerationMissing: ComponentKey[] | null = null
    if (sameGenerationWait) {
      const missing = sameGenerationWait.preparedPlan.componentKeys.filter(key => {
        const observed = inspection.components.find(item => item.componentKey === key)
        return adapter.componentContracts?.[key]?.mutationDomain === 'file_fragment'
          && observed?.visibility === 'absent' && !observed.observedFragmentHash
          && ownedArtifacts.some(owned => owned.componentKey === key)
      })
      if (request.componentKeys.every(key => missing.includes(key))) sameGenerationMissing = missing
    }
    let componentKeys = (sameGenerationMissing ? sameGenerationWait!.preparedPlan.componentKeys : requestedComponents)
      .filter(component => implementedComponents.has(component))
    if (componentKeys.length === 0) {
      throw new Error(`no enabled component projection for ${request.installation.identity.hostVariant}`)
    }
    let adapterPlan = request.operation === 'disconnect'
      ? await adapter.disconnect(context, {
          componentKeys,
          observed: inspection,
          ownedArtifacts,
        })
      : await adapter.plan(context, {
          desiredCapability: sameGenerationMissing ? sameGenerationWait!.desiredCapability : request.desiredCapability,
          desiredComponents: componentKeys,
          observed: inspection,
          ownedArtifacts,
        })
    if (sameGenerationMissing) {
      if (componentKeys.length !== sameGenerationWait!.preparedPlan.componentKeys.length
        || adapterPlan.mutations.length === 0
        || adapterPlan.mutations.some(mutation => !['create','update'].includes(mutation.operation)
          || mutation.domainKind !== 'file_fragment' || mutation.commandCategory !== 'file_write'
          || mutation.ownershipTransferFrom || (mutation.frozenCommands?.length ?? 0) > 0
          || mutationComponentKeys(mutation).some(key => !sameGenerationMissing!.includes(key))
          || !ownedArtifacts.some(owned => owned.componentKey === mutation.componentKey
            && owned.physicalTarget === mutation.physicalTarget && owned.ownershipKey === mutation.ownershipKey
            && owned.ownedFragmentHash === mutation.desiredFragmentHash))) throw new Error('same_generation_file_repair_changed')
      for (const key of componentKeys.filter(key => !sameGenerationMissing!.includes(key))) {
        const observed = inspection.components.find(item => item.componentKey === key)
        if (!ownedArtifacts.some(owned => owned.componentKey === key && owned.physicalTarget === observed?.observedTarget
          && owned.ownedFragmentHash === observed?.observedFragmentHash)) throw new Error('Unrepaired predecessor component changed')
      }
    }
    if (!sameGenerationMissing && verificationDependencies.length > 0 && (!currentActivityToken
      || verificationDependencies.some(component => !componentKeys.includes(component))
      || adapterPlan.mutations.some(mutation => mutationComponentKeys(mutation)
        .some(component => verificationDependencies.includes(component))))) {
      throw new Error('repair_verification_dependency_changed')
    }
    // Instruction-only repair reuses unchanged runtime carriers, but their
    // activity must be freshly emitted into this run's frozen component scope.
    // A stable, already-loaded projection keeps its generation across ordinary
    // scans. Only a real connect/repair mutation rotates the token, then the
    // exact same observed surface is replanned with the new frozen generation.
    if (!sameGenerationMissing && request.operation !== 'disconnect'
      && currentActivityToken
      && !frozenActivityGenerationToken
      && verificationDependencies.length === 0
      && (adapterPlan.mutations.length > 0 || establishesGuidedRuntimeProjection(adapterPlan))) {
      activityGenerationToken = operationId
      context = this.context(
        request.installation,
        operationId,
        persistedHostVersion ?? null,
        activityGenerationToken,
      )
      // Inspection details may include desired generation-derived metadata
      // (Claude plugin version). Freeze the same context that re-preview uses.
      const refreshedInspection = await adapter.inspect(context)
      if (refreshedInspection.detectedVersion !== undefined
        && refreshedInspection.detectedVersion !== persistedHostVersion) {
        throw new Error('Installation host version changed during preview')
      }
      inspection = refreshedInspection.detectedVersion === undefined
        ? { ...refreshedInspection, detectedVersion: persistedHostVersion ?? undefined }
        : refreshedInspection
      adapterPlan = await adapter.plan(context, {
        desiredCapability: request.desiredCapability,
        desiredComponents: componentKeys,
        observed: inspection,
        ownedArtifacts,
      })
    }

    // Shared physical domains (design §3.3.1): a write that could affect another
    // registered consumer happens only while every such consumer is compatible.
    // Otherwise the whole atomic group is left out, the last known content stays,
    // and the diagnostic names the blocking consumer.
    let sharedDomainBinding: string | null = null
    if (!request.codexLegacySelection && request.operation !== 'disconnect' && this.dependencies.sharedDomainConsumers) {
      const snapshot = await this.sharedDomainSnapshot(request.installation, adapterPlan.mutations)
      if (snapshot.blocked.size > 0) {
        const blockedComponents = new Set(adapterPlan.mutations
          .filter(mutation => snapshot.blocked.has(mutation.operationId))
          .flatMap(mutation => mutationComponentKeys(mutation)))
        const reasons = [...new Set([...snapshot.blocked.values()].flat())].sort()
        const declaration = variantDeclarationFor(
          request.installation.identity.hostVariant,
          request.installation.identity.distribution.distributionId,
        )
        // Physical carriers are indivisible even when an Adapter emitted several
        // mutations for them. A retained subset must also be a verified bundle.
        for (const group of declaration?.atomicGroups ?? []) {
          if (group.components.some(component => blockedComponents.has(component))) {
            for (const component of group.components) blockedComponents.add(component)
          }
        }
        componentKeys = componentKeys.filter(component => !blockedComponents.has(component))
        if (request.operation !== 'repair' && (!declaration
          || !declaration.supportedBundles.some(bundle => bundle.length === componentKeys.length
            && bundle.every(component => componentKeys.includes(component))))) {
          throw new Error(reasons[0])
        }
        // A repair exists only to rewrite its requested components; dropping any of
        // them leaves nothing meaningful to approve.
        if (componentKeys.length === 0
          || (request.operation === 'repair'
            && request.componentKeys.some(component => blockedComponents.has(component)))) {
          throw new Error(reasons[0])
        }
        adapterPlan = {
          ...adapterPlan,
          mutations: adapterPlan.mutations.filter(mutation => (
            !mutationComponentKeys(mutation).some(component => blockedComponents.has(component))
          )),
          ...(adapterPlan.requiredUserActionDetails ? {
            requiredUserActionDetails: adapterPlan.requiredUserActionDetails
              .filter(detail => !blockedComponents.has(detail.componentKey)),
          } : {}),
          diagnostics: [...new Set([...adapterPlan.diagnostics, ...reasons])],
        }
      }
      sharedDomainBinding = sharedDomainBindingFor(snapshot.entries
        .filter(entry => adapterPlan.mutations.some(mutation => mutation.operationId === entry.operationId)))
    }

    if (ownershipOnly && adapterPlan.mutations.some(mutation => (
      mutation.domainKind !== 'file_fragment'
      || mutation.operation === 'host_command'
      || (mutation.frozenCommands?.length ?? 0) > 0
      || mutation.executableRealpath !== undefined
      || (mutation.additionalFenceTargets ?? []).some(target => target.domainKind !== 'file_fragment')
    ))) {
      throw new Error(OWNERSHIP_ONLY_REQUIRES_HOST_COMMAND)
    }

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
      activityGenerationToken,
    })
    const surfaceFingerprint = this.dependencies.installationSurfaceFingerprint?.(request.installation)
    if (this.dependencies.installationSurfaceFingerprint && !surfaceFingerprint) {
      throw new Error('Installation projection surface could not be frozen')
    }
    const liveTrustProofFingerprint = ownershipOnly
      ? null
      : await this.dependencies.liveTrustProof?.((request.codexLegacySelection || request.codexFreshIdentity) ? {...request.installation,agentId:request.installation.installationAgentId!,installationAgentId:undefined,sharedIdentityBinding:undefined} : request.installation)
    if (!ownershipOnly && this.dependencies.liveTrustProof && !liveTrustProofFingerprint) {
      throw new Error('Installation live distribution trust could not be proved')
    }
    // Ownership selectors, targets and current bytes — not the host executable.
    const ownershipOnlyDisconnectBinding = ownershipOnly
      ? ownershipOnlyBindingFor(request.installation, surfaceFingerprint ?? null, ownedArtifacts, inspection, adapterPlan.mutations)
      : null
    if (!surfaceFingerprint && !liveTrustProofFingerprint && !sharedDomainBinding && !ownershipOnlyDisconnectBinding && !request.installation.sharedIdentityBinding) {
      return prepared
    }
    const executionPlan = {
      ...prepared.executionPlan,
      ...(request.codexFreshIdentity ? {codexFreshIdentityHash:freshCodexIdentityFingerprint(request.codexFreshIdentity)} : {}),
      ...(request.codexLegacySelection ? {codexLegacySelectionHash:codexSelectionFingerprint(request.codexLegacySelection)} : {}),
      ...(request.installation.sharedIdentityBinding ? { sharedIdentityBinding: request.installation.sharedIdentityBinding } : {}),
      ...(surfaceFingerprint ? { installationSurfaceFingerprint: surfaceFingerprint } : {}),
      ...(liveTrustProofFingerprint ? { liveTrustProofFingerprint } : {}),
      ...(sharedDomainBinding ? { sharedDomainBinding } : {}),
      ...(ownershipOnlyDisconnectBinding ? { ownershipOnlyDisconnectBinding } : {}),
    }
    return {
      ...prepared,
      operationId,
      ...(request.codexFreshIdentity ? {codexFreshIdentity:request.codexFreshIdentity} : {}),
      ...(request.codexLegacySelection ? {codexLegacySelection:request.codexLegacySelection} : {}),
      executionPlan,
      executionPlanHash: executionPlanHash(executionPlan),
    }
  }

  async applyPrepared(request: ApplyPreparedRequest): Promise<CoordinatorOutcome> {
    assertInstallation(request.installation)
    if (request.preparedPlan.operation === 'repair') {
      const predecessor = this.dependencies.repository.completedFileRepairWait?.(request.installation.id, request.preparedPlan.componentKeys)
      // Only the replacement of a completed wait inherits its full verification
      // target. Ordinary repairs retain the requested capability, including an
      // instruction-only repair with read-only MCP verification dependencies.
      if (predecessor && predecessor.preparedPlan.activityGenerationToken === request.preparedPlan.activityGenerationToken
        && predecessor.preparedPlan.componentKeys.length === request.preparedPlan.componentKeys.length) request = {
        ...request, desiredCapability: Math.max(request.desiredCapability, predecessor.desiredCapability) as CapabilityLevel,
      }
    }
    assertHostCapabilityCeiling(
      request.installation,
      request.preparedPlan.operation,
      request.desiredCapability,
    )
    assertPreparedPlan(request.installation, request.preparedPlan)
    const control = await this.dependencies.repository.getInstallationControl(request.installation.id)
    if (!control) throw new Error(`unknown Installation: ${request.installation.id}`)
    if (request.preparedPlan.codexLegacySelection) {
      const selection=request.preparedPlan.codexLegacySelection
      if (codexSelectionFingerprint(selection) !== request.preparedPlan.executionPlan.codexLegacySelectionHash) throw new Error('Legacy selection hash changed')
      const original=selection.members.find(row=>row.id === request.installation.id)
      if (!original || control.agentId !== original.agent_id || control.sharedIdentityBinding || control.desiredState !== 'unmanaged') throw new Error('Legacy selection identity changed')
      assertControlIdentity({...request.installation,agentId:original.agent_id!,installationAgentId:undefined,sharedIdentityBinding:undefined},control)
    } else if (request.preparedPlan.codexFreshIdentity) {
      const pending = request.preparedPlan.codexFreshIdentity
      if (freshCodexIdentityFingerprint(pending) !== request.preparedPlan.executionPlan.codexFreshIdentityHash) throw new Error('Fresh Codex identity hash changed')
      assertControlIdentity({...request.installation,agentId:request.installation.installationAgentId!,installationAgentId:undefined,sharedIdentityBinding:undefined},control)
    } else assertControlIdentity(request.installation, control)
    if (!await this.currentHostVersionMatches(request.installation.id, request.preparedPlan)) {
      return this.awaitConsent(request, ['host_version_changed'], control)
    }
    const generationTakeovers = request.preparedPlan.executionPlan.completedGenerationTakeovers
    const confirmedGeneration = generationTakeovers?.length
      && await this.dependencies.repository.isCompletedGenerationTakeoverCurrent?.(request.installation.id, request.preparedPlan) === true
    if (generationTakeovers?.length && !confirmedGeneration) throw new Error('Completed generation takeover changed before apply')
    if (control.healthState !== 'discovered' || (control.statusReason === 'conflict' && !confirmedGeneration)) {
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
    if (request.preparedPlan.operation === 'repair' || request.preparedPlan.operation === 'upgrade') {
      await this.dependencies.authorizeAutomaticMaintenancePlan?.(request)
    }
    const consent = await this.dependencies.repository.getConsent(request.consentId, request.preparedPlan.executionPlanHash)
    if (!consent) return this.awaitConsent(request, ['consent_missing'], control)
    const coverage = checkPlanAgainstConsent(
      request.preparedPlan.executionPlan,
      consent,
      supplementalConsentClaims(
        request.installation,
        request.preparedPlan,
        request.preparedPlan.codexLegacySelection ? selectedCodexBaselines(request.preparedPlan.codexLegacySelection, request.installation.id)
          : await this.dependencies.repository.listOwnedArtifactBaselines(request.installation.id),
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
      additionalMutationDomains: additionalPhysicalMutationDomains(request.installation, plannedMutation),
      plannedMutation,
    }))
    const createdAt = nowIso(this.dependencies.clock)
    const executionFence = this.dependencies.repository.acquireExecutionFence(runId)
    if (!executionFence) throw new WriterFenceUnavailableError(`execution fence unavailable: ${runId}`)
    const priorExecutionFences: Array<{ assertOwned(): void; release(): void }> = []
    let generationLeases: WriterFenceLease[] | undefined
    const recipePeerTrust: Array<{ installation: CoordinatorInstallation; preparedPlan: PreparedCoordinatorPlan }> = []
    const assertRecipePeerTrust = async (): Promise<void> => {
      for (const peer of recipePeerTrust) if (!this.dependencies.authorizeEffect || !await this.dependencies.authorizeEffect(
        peer.installation,this.trustBinding(peer.preparedPlan),{operation:'connect',mutationDomain:null},
      )) throw new Error('Recipe upgrade peer source trust changed')
    }
    const fileRepairPeerProofs: Array<{ runId: string; planHash: string }> = []
    try {
      if (request.preparedPlan.operation === 'repair') {
        for (const peer of this.dependencies.repository.fileRepairPeers?.(request.installation.id, request.preparedPlan) ?? []) {
          const fence = this.dependencies.repository.acquireExecutionFence(peer.runId)
          if (!fence) throw new WriterFenceUnavailableError(`repair peer is executing: ${peer.runId}`)
          priorExecutionFences.push(fence)
          await this.assertCurrentHostVersion(peer.installation.id, peer.preparedPlan)
          if (this.generationFailure(peer.preparedPlan, this.requireAdapter(peer.installation.identity.hostVariant))) throw new Error('Repair peer generation changed')
          await this.assertCurrentInstallationAuthorized(peer.installation, peer.preparedPlan)
          fence.assertOwned()
          fileRepairPeerProofs.push({ runId: peer.runId, planHash: peer.preparedPlan.executionPlanHash })
        }
      }
      if (confirmedGeneration) {
        const retained=request.preparedPlan.executionPlan.retainedZeroEffectPeer
        if(retained){
          const fence=this.dependencies.repository.acquireExecutionFence(retained.runId)
          if(!fence)throw new WriterFenceUnavailableError(`retained peer is executing: ${retained.runId}`)
          priorExecutionFences.push(fence)
          const peer=await this.dependencies.repository.retainedZeroEffectPeerTrust?.(request.installation.id,request.preparedPlan)
          if(!peer)throw new Error('Retained peer proof changed')
          await this.assertCurrentHostVersion(peer.installation.id,peer.preparedPlan)
          await this.assertCurrentInstallationAuthorized(peer.installation,peer.preparedPlan)
          recipePeerTrust.push(peer)

        }
        for (const prior of generationTakeovers!) {
          const fence = this.dependencies.repository.acquireExecutionFence(prior.runId)
          if (!fence) throw new WriterFenceUnavailableError(`prior generation is executing: ${prior.runId}`)
          priorExecutionFences.push(fence)
          if (prior.kind === 'codex_lifecycle_4_to_5' && prior.installationId !== request.installation.id) {
            const peer = await this.dependencies.repository.recipeUpgradePredecessorTrust?.(prior.runId,prior.installationId!,prior.executionPlanHash)
            if (!peer) throw new Error('Recipe upgrade peer proof changed')
            if (!recipePeerTrust.some(existing => existing.installation.id === peer.installation.id)) recipePeerTrust.push(peer)
          }
        }
        generationLeases = await acquireWriterFences(this.dependencies.repository,
          [...new Set([...preparedMutations.flatMap(allPhysicalMutationDomains),
            ...generationTakeovers!.flatMap(prior => prior.mutationDomains), ...(retained?.mutationDomains??[])])].sort())
        if(retained){
          const peer=recipePeerTrust.find(item=>item.installation.id===retained.installationId)!
          const adapter=this.requireAdapter(peer.installation.identity.hostVariant)
          const observed=await adapter.inspect(this.context(peer.installation,peer.preparedPlan.operationId??'retained-peer-readback',frozenPlanHostVersion(peer.preparedPlan),peer.preparedPlan.activityGenerationToken))
          for(const key of peer.preparedPlan.componentKeys){
            const frozen=peer.preparedPlan.inspection.components.find(item=>item.componentKey===key)
            const live=observed.components.find(item=>item.componentKey===key)
            if(!frozen?.observedFragmentHash || !live || live.observedTarget!==frozen.observedTarget || live.observedFragmentHash!==frozen.observedFragmentHash)throw new Error('Retained peer owned scope changed')
          }
        }
        if (!this.dependencies.authorizeEffect || !await this.dependencies.authorizeEffect(
          request.installation, this.trustBinding(request.preparedPlan), { operation: request.preparedPlan.operation, mutationDomain: null },
        )) throw new Error('Installation source trust changed before generation takeover')
        const sharedFailure = await this.sharedDomainCasFailure(request.installation, request.preparedPlan)
        if (sharedFailure) throw new Error(sharedFailure)
        const adapter = this.requireAdapter(request.installation.identity.hostVariant)
        const currentInspection = await adapter.inspect(this.context(request.installation,
          request.preparedPlan.operationId ?? 'generation-readback', frozenPlanHostVersion(request.preparedPlan),
          request.preparedPlan.activityGenerationToken))
        for (const componentKey of request.preparedPlan.componentKeys) {
          const frozen = request.preparedPlan.inspection.components.find(component => component.componentKey === componentKey)
          const current = currentInspection.components.find(component => component.componentKey === componentKey)
          if (!frozen?.observedFragmentHash || !current || current.observedTarget !== frozen.observedTarget
            || current.observedFragmentHash !== frozen.observedFragmentHash) throw new Error('Owned generation scope changed before takeover')
        }
        for (const mutation of request.preparedPlan.adapterPlan.mutations) {
          await assertLivePrecondition(adapter, this.context(request.installation, mutation.operationId,
            frozenPlanHostVersion(request.preparedPlan), request.preparedPlan.activityGenerationToken), mutation)
        }
        for (const fence of priorExecutionFences) fence.assertOwned()
        await assertWriterFencesOwned(generationLeases)
        if (!await this.dependencies.authorizeEffect(request.installation, this.trustBinding(request.preparedPlan),
          { operation: request.preparedPlan.operation, mutationDomain: null })) throw new Error('Installation source trust could not be verified at generation takeover')
        await assertRecipePeerTrust()
        if (retained || generationTakeovers!.some(prior => prior.kind === 'codex_lifecycle_4_to_5' || prior.kind === 'codex_same_source_zero_effect')) {
          // Peer attestation is asynchronous; recheck held authority before the
          // prepare transaction can retire any predecessor or bind a new run.
          await assertWriterFencesOwned(generationLeases)
          for (const fence of priorExecutionFences) fence.assertOwned()
        }
      }
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
        fileRepairPeerProofs,
        createdAt,
      })

      return await this.executePreparedRun({
        runId,
        installation: request.installation,
        consentId: consent.id,
        preparedPlan: request.preparedPlan,
        mutations: prepared.mutations,
        desiredCapability: request.desiredCapability,
        recovery: false,
        ...(generationLeases ? { recoveryLeases: generationLeases } : {}),
      })
    } finally {
      try { if (generationLeases) await releaseWriterFences(generationLeases) }
      finally { releaseExecutionFences([executionFence, ...priorExecutionFences]) }
    }
  }

  /** Recover persisted non-terminal mutations before starting ordinary reconciliation. */
  async recoverNonTerminalRuns(options: RecoveryOptions = {}): Promise<CoordinatorOutcome[]> {
    const pending = await this.dependencies.repository.listRecoverableRunIds()
    const outcomes: CoordinatorOutcome[] = []
    for (const runId of pending) {
      const executionFence = this.dependencies.repository.acquireExecutionFence(runId)
      if (!executionFence) continue
      try {
        const execution = await this.dependencies.repository.getRecoverableExecution(runId)
        if (!execution) continue
        executionFence.assertOwned()
        try {
          outcomes.push(await this.recoverExecution(execution, options))
        } catch (error) {
          if (!(error instanceof WriterFenceUnavailableError)) {
            outcomes.push(await this.isolateRecoveryExecutionFailure(execution, error))
          }
        }
      } finally {
        executionFence.release()
      }
    }
    return outcomes
  }

  private async recoverExecution(
    execution: RecoverableExecution,
    options: RecoveryOptions,
  ): Promise<CoordinatorOutcome> {
    const domains = execution.runState === 'verified' ? [] : [...new Set(
      execution.mutations.flatMap(mutation => allPhysicalMutationDomains(mutation)),
    )].sort()
    const leases = await acquireWriterFences(this.dependencies.repository, domains)
    try {
      return await this.recoverExecutionWithFences(execution, options, leases)
    } finally {
      await releaseWriterFences(leases)
    }
  }

  private async recoverExecutionWithFences(
    execution: RecoverableExecution,
    options: RecoveryOptions,
    recoveryLeases: WriterFenceLease[],
  ): Promise<CoordinatorOutcome> {
    let recoveryAuthorized: boolean
    try {
      recoveryAuthorized = await options.canContinueRecovery?.(execution) !== false
    } catch (error) {
      if(error instanceof DesktopSourceVerificationUnavailable) {
        return {status:'needs_recovery',runId:execution.runId,reason:'desktop_source_verification_unavailable'}
      }
      recoveryAuthorized = false
    }
    if (!recoveryAuthorized) {
      return execution.runState === 'verified'
        ? await this.blockVerifiedRecovery(execution, 'recovery_source_trust_changed')
        : await this.failRecovery(execution, 'recovery_source_trust_changed')
    }
    if (execution.runState === 'verified') {
      this.dependencies.repository.refreshRecoveryConnectionIntent?.(execution.runId, nowIso(this.dependencies.clock))
      if(execution.codexLegacySelectionReadBack){
        try{await this.assertCodexSelectionReadBack(execution.codexLegacySelectionReadBack)}
        catch{return this.blockVerifiedRecovery(execution,'codex_legacy_selection_changed')}
      }
      return this.finalizeVerifiedExecution(execution)
    }
    try {
      assertHostCapabilityCeiling(
        execution.installation,
        execution.preparedPlan.operation,
        execution.desiredCapability,
      )
    } catch {
      return this.failRecovery(execution, 'host_capability_ceiling_exceeded')
    }
    if (execution.runState === 'compensating') {
      return this.failRecovery(execution, 'compensation_requires_recovery_plan')
    }
    try {
      assertPreparedPlan(execution.installation, execution.preparedPlan)
    } catch {
      return this.failRecovery(execution, 'persisted_plan_hash_mismatch')
    }
    const intentAuthorized = this.dependencies.repository.refreshRecoveryConnectionIntent?.(execution.runId, nowIso(this.dependencies.clock)) !== false
    if (execution.runState === 'applied_unverified') {
      if (!intentAuthorized) return { status: 'paused', reason: 'disabled' }
      return this.retryAppliedVerification(execution, options, recoveryLeases)
    }
    return this.executePreparedRun({
      runId: execution.runId,
      installation: execution.installation,
      consentId: execution.consentId,
      preparedPlan: execution.preparedPlan,
      mutations: execution.mutations,
      desiredCapability: execution.preparedPlan.operation === 'disconnect' ? 0 : execution.desiredCapability,
      recovery: true,
      recoveryLeases,
      recoveryReplayGuard: () => intentAuthorized
        ? this.checkRecoveryReplay(execution, options)
        : Promise.resolve({ allowed: false as const, reason: 'connection_intent_changed' }),
    })
  }

  private async isolateRecoveryExecutionFailure(
    execution: RecoverableExecution,
    error: unknown,
  ): Promise<CoordinatorOutcome> {
    if(error instanceof DesktopSourceVerificationUnavailable) {
      return {status:'needs_recovery',runId:execution.runId,reason:'desktop_source_verification_unavailable'}
    }
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
      return await this.commitVerifiedRun(execution.runId, nowIso(this.dependencies.clock), [])
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

  private async commitVerifiedRun(
    runId: string,
    at: string,
    verification: readonly ComponentVerificationResult[],
  ): Promise<CoordinatorOutcome> {
    try {
      await this.dependencies.repository.setRunState(runId, 'committed', at)
    } catch (error) {
      if (error instanceof ConnectionIntentChangedError) return { status: 'paused', reason: 'disabled' }
      throw error
    }
    return { status: 'committed', runId, verification }
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
    recoveryLeases: WriterFenceLease[],
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
    const consent = await this.dependencies.repository.getConsent(execution.consentId, execution.preparedPlan.executionPlanHash)
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
    if (execution.preparedPlan.operation === 'connect') {
      const candidates=await this.dependencies.repository.pendingAppliedRemovalCandidates?.(execution.runId) ?? []
      if (candidates.length>0) {
        // Healthy runs need no additional read-back. Stale observations are
        // discarded; a current physical failure retains the recovery diagnostic.
        try {
          let readBackFailed=false
          let readBackError: unknown
          for (const candidate of candidates) {
            const mutation=execution.mutations.find(item=>item.journal.id===candidate.mutationId)
            if (!mutation || mutation.journal.state!=='committed' || mutation.effectDisposition==='consumer_detach') {
              return this.failRecovery(execution,'applied_run_has_uncommitted_mutation')
            }
            await this.assertRecoveryAuthorized(execution,options)
            await this.assertCurrentHostVersion(execution.installation.id,execution.preparedPlan)
            await assertWriterFencesOwned(recoveryLeases)
            try {
              const observation=await adapter.readBack(this.context(execution.installation,mutation.operationId,
                frozenPlanHostVersion(execution.preparedPlan),execution.preparedPlan.activityGenerationToken),mutation.plannedMutation)
              assertReadBackVisibilityKnown(observation,mutation.plannedMutation)
              if (!observation.matchesDesired || observation.observedFragmentHash!==mutation.journal.desiredFingerprint) readBackFailed=true
            } catch (error) { if(error instanceof DesktopSourceVerificationUnavailable)throw error; readBackFailed=true; readBackError=error }
            const current=await this.dependencies.repository.pendingAppliedRemovalCandidates?.(execution.runId) ?? []
            if (sha256Json(current)!==sha256Json(candidates)) {
              return {status:'awaiting_verification',runId:execution.runId,verification:[]}
            }
          }
          if (readBackError instanceof FrozenGenerationChangedError || readBackError instanceof InstallationTrustChangedError) throw readBackError
          await this.assertRecoveryAuthorized(execution,options)
          await this.assertCurrentHostVersion(execution.installation.id,execution.preparedPlan)
          await assertWriterFencesOwned(recoveryLeases)
          this.assertFrozenGenerations(execution.preparedPlan,adapter)
          const current=await this.dependencies.repository.pendingAppliedRemovalCandidates?.(execution.runId) ?? []
          if (sha256Json(current)!==sha256Json(candidates)) return {status:'awaiting_verification',runId:execution.runId,verification:[]}
          if (readBackFailed) return this.needsRecovery(execution,'verification_failed','host_verification')
          if (!await this.dependencies.repository.reconcileAppliedRemovalCandidates?.(execution.runId,candidates,nowIso(this.dependencies.clock))) {
            return {status:'awaiting_verification',runId:execution.runId,verification:[]}
          }
        } catch (error) {
          if(error instanceof DesktopSourceVerificationUnavailable)throw error
          const current=await this.dependencies.repository.pendingAppliedRemovalCandidates?.(execution.runId) ?? []
          if (sha256Json(current)!==sha256Json(candidates)) return {status:'awaiting_verification',runId:execution.runId,verification:[]}
          if (error instanceof FrozenGenerationChangedError) return this.failRecovery(execution,error.reason)
          if (error instanceof InstallationTrustChangedError) return this.failRecovery(execution,'recovery_source_trust_changed')
          return this.needsRecovery(execution,'verification_failed','host_verification')
        }
      }
    }
    const detachedComponents = new Set(execution.mutations
      .filter(mutation => mutation.effectDisposition === 'consumer_detach')
      .flatMap(mutation => mutationComponentKeys(mutation.plannedMutation)))
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
            execution.activationEpoch ?? latestMutationEpoch(execution.mutations),
          )
    } catch (error) {
      if (this.dependencies.repository.isRunConnectionIntentCurrent?.(execution.runId) === false) return { status: 'paused', reason: 'disabled' }
      if(error instanceof DesktopSourceVerificationUnavailable)throw error
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
    } catch (error) {
      if(error instanceof DesktopSourceVerificationUnavailable)throw error
      return this.failRecovery(execution, 'recovery_source_trust_changed')
    }
    const preCommitGenerationFailure = this.generationFailure(execution.preparedPlan, adapter)
    if (preCommitGenerationFailure) return this.failRecovery(execution, preCommitGenerationFailure)
    const updatedAt = nowIso(this.dependencies.clock)
    await this.dependencies.repository.setRunState(execution.runId, 'verified', updatedAt)
    try {
      await this.assertRecoveryAuthorized(execution, options)
    } catch (error) {
      if(error instanceof DesktopSourceVerificationUnavailable)throw error
      return this.blockVerifiedRecovery({
        runId: execution.runId,
        runState: 'verified',
        installationId: execution.installation.id,
        installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(execution.preparedPlan),
        liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(execution.preparedPlan),
        ownershipOnlyDisconnectBinding: frozenPlanOwnershipOnlyBinding(execution.preparedPlan),
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
        ownershipOnlyDisconnectBinding: frozenPlanOwnershipOnlyBinding(execution.preparedPlan),
      }, finalGenerationFailure)
    }
    return this.commitVerifiedRun(execution.runId, updatedAt, verification)
  }

  private async executePreparedRun(input: {
    runId: string
    installation: CoordinatorInstallation
    consentId: string
    preparedPlan: PreparedCoordinatorPlan
    mutations: readonly PreparedMutationExecution[]
    desiredCapability: CapabilityLevel
    recovery: boolean
    recoveryLeases?: WriterFenceLease[]
    recoveryReplayGuard?: () => Promise<{ allowed: true } | { allowed: false; reason: string }>
  }): Promise<CoordinatorOutcome> {
    const adapter = this.requireAdapter(input.installation.identity.hostVariant)
    const hostVersion = frozenPlanHostVersion(input.preparedPlan)
    if (!await this.currentHostVersionMatches(input.installation.id, input.preparedPlan)) {
      return this.needsRecovery(input, 'host_version_changed', 'host_version')
    }
    if (!input.recovery) {
      // Shared-domain CAS: the consumer set and every consumer generation must still
      // equal what the approved plan froze. A change abandons this write (no retry
      // loop). Recovery may still commit an effect that already happened by exact
      // read-back; only a replay is re-gated (checkRecoveryReplay/effect boundary).
      const sharedFailure = await this.sharedDomainCasFailure(input.installation, input.preparedPlan)
      if (sharedFailure) return this.needsRecovery(input, sharedFailure, 'shared_domain_cas')
    }
    const operationById = new Map(input.preparedPlan.adapterPlan.mutations.map(mutation => [mutation.operationId, mutation]))
    if (!input.recovery) {
      await this.dependencies.repository.setRunState(input.runId, 'preconditions_checked', nowIso(this.dependencies.clock))
    }
    const preparedNoopRecovery=input.recovery && input.mutations.length===0 && (input.preparedPlan.executionPlan.retainedZeroEffectPeer
      || input.preparedPlan.executionPlan.completedGenerationTakeovers?.some(prior=>prior.kind==='codex_same_source_zero_effect'))
    if (!input.recovery || preparedNoopRecovery || input.mutations.some(mutation =>
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
      let leases: WriterFenceLease[] = input.recoveryLeases ?? []
      const mutationDomains = allPhysicalMutationDomains(persisted)
      if (!input.recovery && !input.recoveryLeases) {
        try {
          leases = await acquireWriterFences(this.dependencies.repository, mutationDomains)
        } catch {
          return this.needsRecovery(input, 'writer_fence_unavailable', 'fence')
        }
        if (leases.length !== mutationDomains.length) return this.needsRecovery(input, 'writer_fence_unavailable', 'fence')
      }
      let mutationFailure: { code: string; stage: string } | null = null
      try {
        let applyReceipt: unknown = null
        const context = this.context(
          input.installation,
          persisted.operationId,
          hostVersion,
          input.preparedPlan.activityGenerationToken,
        )
        const runnerDependencies = {
          journal: {
            save: (record: MutationJournalRecord) => this.dependencies.repository.saveMutation(input.runId, record),
          },
          fence: {
            assertOwned: async () => {
              if (leases.length === 0) {
                leases = await acquireWriterFences(this.dependencies.repository, mutationDomains)
                if (leases.length !== mutationDomains.length) {
                  throw new Error(`writer fence unavailable: ${mutationDomains.join(',')}`)
                }
              }
              await assertWriterFencesOwned(leases)
            },
          },
          effect: {
            apply: async () => {
              if (await this.dependencies.authorizeEffect?.(
                input.installation,
                this.trustBinding(input.preparedPlan),
                { operation: input.preparedPlan.operation, mutationDomain: plannedMutation.domainKind },
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
              await this.assertCurrentHostVersion(input.installation.id, input.preparedPlan)
              await assertLivePrecondition(adapter, context, plannedMutation, input.recovery)
              if (await this.dependencies.authorizeEffect?.(
                input.installation,
                this.trustBinding(input.preparedPlan),
                { operation: input.preparedPlan.operation, mutationDomain: plannedMutation.domainKind },
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
              if (leases.length < mutationDomains.length) {
                throw new Error(`writer fence unavailable: ${mutationDomains.join(',')}`)
              }
              await assertWriterFencesOwned(leases)
              // Repository CAS and the writer-fence assertion are both awaitable.
              // Re-attest only after those waits so physical host/config mutation
              // is the very next external operation after source trust succeeds.
              if (await this.dependencies.authorizeEffect?.(
                input.installation,
                this.trustBinding(input.preparedPlan),
                { operation: input.preparedPlan.operation, mutationDomain: plannedMutation.domainKind },
              ) === false) {
                throw new Error('Installation source trust changed at physical effect boundary')
              }
              await this.assertCurrentHostVersion(input.installation.id, input.preparedPlan)
              const sharedFailure = await this.sharedDomainCasFailure(input.installation, input.preparedPlan)
              if (sharedFailure) throw new Error(sharedFailure)
              if (this.dependencies.repository.isRunConnectionIntentCurrent?.(input.runId) === false) throw new ConnectionIntentChangedError()
              if (nativePermissionsForPlan(input.preparedPlan.executionPlan).length) {
                const permission = await this.dependencies.repository.getConsent(input.consentId, input.preparedPlan.executionPlanHash)
                // Legacy recovery continues only its existing frozen user-approved operation.
                if (!permission || (permission.origin && permission.origin !== 'legacy'
                  && (permission.origin !== 'explicit_user' || permission.nativePermissionPlanHash !== input.preparedPlan.executionPlanHash))) throw new Error('native_permission_required')
              }
              applyReceipt = await adapter.apply(context, plannedMutation)
            },
            readBack: async () => {
              await this.assertCurrentHostVersion(input.installation.id, input.preparedPlan)
              return mutationEffectReadBack(
                await adapter.readBack(context, plannedMutation),
                plannedMutation,
              )
            },
            receipt: (fingerprint: string | null) => ({ adapterReceipt: applyReceipt, fingerprint }),
          },
          replayGuard: input.recoveryReplayGuard,
          safeResumeFingerprints: plannedMutation.safeResumeStates?.map(state => state.fingerprint),
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
        try {
          if (!input.recoveryLeases) await releaseWriterFences(leases)
        } catch {
          mutationFailure ??= { code: 'writer_fence_release_failed', stage: 'fence_release' }
        }
      }
      if (mutationFailure) return this.needsRecovery(input, mutationFailure.code, mutationFailure.stage)
    }

    const activationEpoch = nowIso(this.dependencies.clock)
    await this.dependencies.repository.setRunState(input.runId, 'applied_unverified', activationEpoch)
    if (this.dependencies.repository.isRunConnectionIntentCurrent?.(input.runId) === false) return { status: 'paused', reason: 'disabled' }
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
      .flatMap(mutation => mutationComponentKeys(mutation.plannedMutation)))
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
            activationEpoch,
          )
    } catch (error) {
      if (this.dependencies.repository.isRunConnectionIntentCurrent?.(input.runId) === false) return { status: 'paused', reason: 'disabled' }
      if(error instanceof DesktopSourceVerificationUnavailable)throw error
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
    } catch (error) {
      if(error instanceof DesktopSourceVerificationUnavailable)throw error
      return this.needsRecovery(input, 'installation_source_trust_changed', 'verification')
    }
    const preCommitGenerationFailure = this.generationFailure(input.preparedPlan, adapter)
    if (preCommitGenerationFailure) return this.needsRecovery(input, preCommitGenerationFailure, 'verification')
    await this.dependencies.repository.setRunState(input.runId, 'verified', nowIso(this.dependencies.clock))
    try {
      await this.assertCurrentInstallationAuthorized(input.installation, input.preparedPlan)
    } catch (error) {
      if(error instanceof DesktopSourceVerificationUnavailable)throw error
      return this.blockVerifiedRecovery({
        runId: input.runId,
        runState: 'verified',
        installationId: input.installation.id,
        installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(input.preparedPlan),
        liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(input.preparedPlan),
        ownershipOnlyDisconnectBinding: frozenPlanOwnershipOnlyBinding(input.preparedPlan),
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
        ownershipOnlyDisconnectBinding: frozenPlanOwnershipOnlyBinding(input.preparedPlan),
      }, finalGenerationFailure)
    }
    return this.commitVerifiedRun(input.runId, nowIso(this.dependencies.clock), verification)
  }

  private async assertCodexSelectionReadBack(input:{installation:CoordinatorInstallation;preparedPlan:PreparedCoordinatorPlan}): Promise<void> {
    const mutations=input.preparedPlan.adapterPlan.mutations.filter(item=>(input.preparedPlan.codexLegacySelection && item.componentKey==='memory_tools') || item.metadata?.codexLegacyHooks!==undefined)
    if(!mutations.length)return
    const adapter=this.requireAdapter(input.installation.identity.hostVariant)
    const context=this.context(input.installation,'legacy_selection_readback',frozenPlanHostVersion(input.preparedPlan),input.preparedPlan.activityGenerationToken)
    for(const mutation of mutations)if(!(await adapter.readBack(context,mutation)).matchesDesired)throw new Error('codex_legacy_selection_changed')
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
    activationEpoch?: string,
  ): Promise<readonly ComponentVerificationResult[]> {
    await this.assertCodexSelectionReadBack(input)
    const hostVersion = frozenPlanHostVersion(input.preparedPlan)
    await this.assertCurrentHostVersion(input.installation.id, input.preparedPlan)
    const context = this.context(
      input.installation,
      `${input.runId}:verify`,
      hostVersion,
      input.preparedPlan.activityGenerationToken,
    )
    const inspection = await adapter.inspect(context)
    await this.assertCurrentHostVersion(input.installation.id, input.preparedPlan)
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    const verificationAt = nowIso(this.dependencies.clock)
    const verificationMs = Date.parse(verificationAt)
    const activationMs = Date.parse(activationEpoch ?? '')
    if (!Number.isFinite(verificationMs)
      || !Number.isFinite(activationMs)
      || activationMs > verificationMs) {
      throw new Error('activity_activation_epoch_invalid')
    }
    const observedAfter = new Date(verificationMs - HOST_ACTIVITY_FRESHNESS_MS).toISOString()
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    const rawResults = await adapter.verify(context, {
      componentKeys,
      expectedCapability: input.desiredCapability,
      inspection,
      activityBinding: {
        installationId: input.installation.id,
        tideMindVersion: this.dependencies.runtime.tideMindVersion,
        adapterVersion: adapter.adapterVersion,
        projectionVersion: input.preparedPlan.adapterPlan.projectionVersion,
        hostVersion,
        activationRunId: input.runId,
        activityGenerationToken: input.preparedPlan.activityGenerationToken,
        activationEpoch: new Date(activationMs).toISOString(),
        observedAfter,
        verifiedAt: verificationAt,
      },
    })
    let results = normalizeGuidedPendingVerification(input.preparedPlan, rawResults)
    let reusedVerificationId: string | undefined
    const memory = results.find(result => result.componentKey === 'memory_tools')
    if (input.preparedPlan.operation === 'repair' && memory?.status === 'unverified'
      && memory.diagnostics.includes('static_readback_passed')
      && memory.diagnostics.includes('fresh_host_activity_evidence_missing')) {
      const reusable = this.dependencies.repository.reusableMemoryVerification?.(input.runId, verificationAt, this.dependencies.runtime.tideMindVersion, this.dependencies.runtime.catalogVersion)
      if (reusable) {
        reusedVerificationId = reusable.verificationId
        results = results.map(result => result.componentKey === 'memory_tools' ? reusable.result : result)
      }
    }
    if (this.dependencies.repository.isRunConnectionIntentCurrent?.(input.runId) === false) throw new ConnectionIntentChangedError()
    await this.assertCurrentHostVersion(input.installation.id, input.preparedPlan)
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
      ...(result.componentKey === 'memory_tools' && reusedVerificationId ? { reusedVerificationId } : {}),
    })))
    await assertAuthorized()
    this.assertFrozenGenerations(input.preparedPlan, adapter)
    return results
  }

  private async currentHostVersionMatches(
    installationId: string,
    preparedPlan: PreparedCoordinatorPlan,
  ): Promise<boolean> {
    const current = await this.dependencies.repository.getInstallationHostVersion(installationId)
    return current === frozenPlanHostVersion(preparedPlan)
  }

  private async assertCurrentHostVersion(
    installationId: string,
    preparedPlan: PreparedCoordinatorPlan,
  ): Promise<void> {
    if (!await this.currentHostVersionMatches(installationId, preparedPlan)) {
      throw new Error('Installation host version changed after preview')
    }
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
      if (this.dependencies.repository.isRunConnectionIntentCurrent?.(execution.runId) === false) return { allowed: false, reason: 'connection_intent_changed' }
      await this.assertRecoveryAuthorized(execution, options)
      if (await options.canReplayEffect?.(execution.installation, execution) === false) {
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

      const consent = await this.dependencies.repository.getConsent(execution.consentId, execution.preparedPlan.executionPlanHash)
      const coverage = consent
        ? checkPlanAgainstConsent(execution.preparedPlan.executionPlan, consent)
        : null
      if (!coverage?.allowed || coverage.executionPlanHash !== execution.preparedPlan.executionPlanHash) {
        return { allowed: false, reason: 'consent_no_longer_covers_plan' }
      }

      const adapter = this.requireAdapter(execution.installation.identity.hostVariant)
      const generationFailure = this.generationFailure(execution.preparedPlan, adapter)
      if (generationFailure) return { allowed: false, reason: generationFailure }
      const sharedFailure = await this.sharedDomainCasFailure(execution.installation, execution.preparedPlan)
      if (sharedFailure) return { allowed: false, reason: sharedFailure }
      return { allowed: true }
    } catch {
      return { allowed: false, reason: 'recovery_replay_guard_failed' }
    }
  }

  private async sharedDomainSnapshot(
    installation: CoordinatorInstallation,
    mutations: readonly PlannedMutation[],
  ): Promise<{ blocked: Map<string, string[]>; entries: SharedDomainEntry[] }> {
    const blocked = new Map<string, string[]>()
    const entries: SharedDomainEntry[] = []
    const resolve = this.dependencies.sharedDomainConsumers
    if (!resolve) return { blocked, entries }
    for (const mutation of mutations) {
      const consumers = (await resolve(installation, mutation))
        .filter(consumer => consumer.installationId !== installation.id)
      if (consumers.length === 0) continue
      const reasons = [...new Set(consumers.flatMap(consumer => consumer.blockingReason ? [consumer.blockingReason] : []))]
      if (reasons.length > 0) blocked.set(mutation.operationId, reasons.sort())
      entries.push({
        operationId: mutation.operationId,
        physicalTarget: mutation.physicalTarget,
        ownershipKey: mutation.ownershipKey,
        consumers: consumers
          .map(consumer => ({
            installationId: consumer.installationId,
            generation: consumer.generation,
            blockingReason: consumer.blockingReason,
          }))
          .sort((left, right) => left.installationId.localeCompare(right.installationId)),
      })
    }
    return { blocked, entries }
  }

  /** Null when the frozen shared-domain binding still holds for every planned write. */
  private async sharedDomainCasFailure(
    installation: CoordinatorInstallation,
    plan: PreparedCoordinatorPlan,
  ): Promise<string | null> {
    if (plan.operation === 'disconnect' || !this.dependencies.sharedDomainConsumers) return null
    try {
      const snapshot = await this.sharedDomainSnapshot(installation, plan.adapterPlan.mutations)
      if(plan.codexLegacySelection){
        const selection=plan.codexLegacySelection
        if(codexSelectionFingerprint(selection)!==plan.executionPlan.codexLegacySelectionHash)return SHARED_DOMAIN_SET_CHANGED
        for(const entry of snapshot.entries)for(const consumer of entry.consumers){
          const member=selection.members.find(row=>row.id===consumer.installationId)
          if(!member || consumer.blockingReason)return SHARED_DOMAIN_SET_CHANGED
          const control=await this.dependencies.repository.getInstallationControl(member.id)
          if(!control || control.desiredState!=='unmanaged' || control.tombstoned || control.healthState!=='discovered')return SHARED_DOMAIN_SET_CHANGED
          const identity=prospectiveCodexIdentity(selection,member.id)
          if(control.installKey!==member.install_key || control.agentId!==identity.agentId || control.sharedIdentityBinding!==identity.sharedIdentityBinding)return SHARED_DOMAIN_SET_CHANGED
        }
        return null
      }
      const blocked = [...snapshot.blocked.values()].flat().sort()
      if (blocked.length > 0) return blocked[0]
      return sharedDomainBindingFor(snapshot.entries) === frozenPlanSharedDomainBinding(plan)
        ? null
        : SHARED_DOMAIN_SET_CHANGED
    } catch {
      return SHARED_DOMAIN_SET_CHANGED
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
    if (preparedPlan.adapterPlan.adapterVersion !== adapter.adapterVersion) {
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

  private trustBinding(preparedPlan: PreparedCoordinatorPlan): EffectTrustBinding {
    return {
      installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(preparedPlan),
      liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(preparedPlan),
      ownershipOnlyDisconnectBinding: frozenPlanOwnershipOnlyBinding(preparedPlan),
    }
  }

  private async assertCurrentInstallationAuthorized(
    installation: CoordinatorInstallation,
    preparedPlan: PreparedCoordinatorPlan,
  ): Promise<void> {
    if (await this.dependencies.authorizeEffect?.(
      installation,
      this.trustBinding(preparedPlan),
      { operation: preparedPlan.operation, mutationDomain: null },
    ) === false) {
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

  private context(
    installation: CoordinatorInstallation,
    operationId: string,
    hostVersion?: string | null,
    activityGenerationToken?: string,
  ): AdapterOperationContext {
    return {
      runtime: this.dependencies.runtime,
      installation: installation.identity,
      installationId: installation.id,
      ...(installation.sharedIdentityBinding ? { sharedIdentityBinding: installation.sharedIdentityBinding } : {}),
      ...(hostVersion ? { hostVersion } : {}),
      agentId: installation.agentId,
      operationId,
      ...(activityGenerationToken ? { activityGenerationToken } : {}),
      hostActivityEvidence: this.dependencies.hostActivityEvidence,
      codexHookTrustEvidence: this.dependencies.codexHookTrustEvidence,
      guidedRemovalEvidence: this.dependencies.guidedRemovalEvidence,
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
    preparedPlan.executionPlan.mutations.flatMap(mutation => mutation.coveredComponentKeys ?? [mutation.componentKey]),
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
    || (control.installationAgentId ?? control.agentId) !== (installation.installationAgentId ?? installation.agentId)
    || control.sharedIdentityBinding !== installation.sharedIdentityBinding
    || control.hostVariant !== installation.identity.hostVariant) {
    throw new Error(`Installation identity changed: ${installation.id}`)
  }
}

function assertPreparedPlan(installation: CoordinatorInstallation, plan: PreparedCoordinatorPlan): void {
  if (plan.executionPlan.sharedIdentityBinding !== installation.sharedIdentityBinding) throw new Error('prepared shared identity changed');
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
  assertPersistedPreparedPlanShape(plan)
  if (plan.activityGenerationToken !== undefined) {
    if (!plan.activityGenerationToken.trim()
      || plan.executionPlan.activityGenerationTokenHash !== sha256Json(plan.activityGenerationToken)) {
      throw new Error('prepared activity generation token binding is invalid')
    }
  } else if (plan.executionPlan.activityGenerationTokenHash !== undefined) {
    throw new Error('prepared activity generation token is missing')
  }
  frozenPlanHostVersion(plan)
}

function frozenPlanHostVersion(plan: PreparedCoordinatorPlan): string | null {
  if (!Object.hasOwn(plan.executionPlan, 'hostVersion')) {
    throw new Error('prepared execution plan has no frozen host version')
  }
  const value = plan.executionPlan.hostVersion
  if (!(value === null || (typeof value === 'string' && value.length > 0))) {
    throw new Error('prepared execution plan has an invalid frozen host version')
  }
  if (value !== (plan.inspection.detectedVersion ?? null)) {
    throw new Error('prepared inspection host version is not bound to the execution plan')
  }
  return value
}

/** Existing content can only be updated/removed/repaired with an exact Ledger baseline. */
function assertLedgerOwnership(
  mutations: readonly PlannedMutation[],
  baselines: readonly OwnedArtifactBaseline[],
  operation: PlanOperation,
): void {
  for (const mutation of mutations) {
    const componentKeys = mutationComponentKeys(mutation)
    const transfer = mutation.ownershipTransferFrom
    if (transfer !== undefined) {
      const aggregateTransfer = componentKeys.length > 1
      if ((aggregateTransfer
        ? mutation.operation !== 'host_command' && mutation.operation !== 'update'
        : mutation.operation !== 'create')
        || operation === 'disconnect'
        || (!aggregateTransfer
          && transfer.physicalTarget !== mutation.physicalTarget
          && !mutation.additionalFenceTargets?.some(target => (
            target.physicalTarget === transfer.physicalTarget && target.domainKind === mutation.domainKind
          )))
        || (transfer.physicalTarget === mutation.physicalTarget
          && transfer.ownershipKey === mutation.ownershipKey)) {
        throw new Error(`ownership_transfer_invalid:${mutation.operationId}`)
      }
      const source = baselines.find(candidate => candidate.componentKey === mutation.componentKey
        && candidate.physicalTarget === transfer.physicalTarget
        && candidate.ownershipKey === transfer.ownershipKey)
      if (!source) throw new Error(`ownership_transfer_source_missing:${mutation.operationId}`)
      if (source.ownedFragmentHash !== transfer.ownedFragmentHash
        || (source.selectorSchemaVersion ?? 1) !== transfer.selectorSchemaVersion) {
        throw new Error(`ownership_transfer_source_mismatch:${mutation.operationId}`)
      }
      if (!aggregateTransfer && mutation.preconditionHash !== undefined
        && mutation.preconditionHash !== transfer.ownedFragmentHash) {
        throw new Error(`ownership_transfer_precondition_mismatch:${mutation.operationId}`)
      }
      for (const componentKey of componentKeys) {
        if (componentKey === mutation.componentKey) continue
        const existing = baselines.filter(candidate => candidate.componentKey === componentKey)
        const exactAggregate = existing.length === 1
          && existing[0].physicalTarget === mutation.physicalTarget
          && existing[0].ownershipKey === mutation.ownershipKey
          && mutation.preconditionHash !== undefined
          && existing[0].ownedFragmentHash === mutation.preconditionHash
          && (existing[0].selectorSchemaVersion ?? 1) === mutation.selectorSchemaVersion
        if (existing.length > 0 && !exactAggregate) {
          throw new Error(`aggregate_ownership_transfer_target_conflict:${mutation.operationId}:${componentKey}`)
        }
      }
      continue
    }
    if ((mutation.operation === 'create' && operation !== 'repair')
      || (mutation.operation === 'host_command' && mutation.preconditionHash === undefined)) continue
    if (mutation.operation !== 'create' && mutation.preconditionHash === undefined) {
      throw new Error(`ownership_precondition_missing:${mutation.operationId}`)
    }
    for (const componentKey of componentKeys) {
      const baseline = baselines.find(candidate => candidate.componentKey === componentKey
        && candidate.physicalTarget === mutation.physicalTarget
        && candidate.ownershipKey === mutation.ownershipKey)
      if (!baseline) {
        throw new Error(`ownership_conflict:${mutation.operationId}:${componentKey}`)
      }
      if (mutation.preconditionHash !== undefined && mutation.preconditionHash !== baseline.ownedFragmentHash) {
        throw new Error(`ownership_baseline_mismatch:${mutation.operationId}:${componentKey}`)
      }
    }
  }
}

interface SharedDomainEntry {
  operationId: string
  physicalTarget: string
  ownershipKey: string
  consumers: readonly SharedDomainConsumer[]
}

/**
 * Operation IDs are regenerated by every preview, so the binding keys on the
 * physical target/selector instead; it covers the consumer set and generations.
 */
function ownershipOnlyBindingFor(
  installation: CoordinatorInstallation,
  installationSurfaceFingerprint: string | null,
  ownedArtifacts: readonly OwnedArtifactBaseline[],
  inspection: {
    components: readonly {
      componentKey: ComponentKey
      observedTarget?: string
      observedFragmentHash?: string
      visibility: string
    }[]
  },
  mutations: readonly PlannedMutation[],
): string {
  const key = (...parts: string[]) => parts.join('\u0000')
  return sha256Json({
    schemaVersion: 1,
    mode: 'ownership_only_disconnect',
    installationId: installation.id,
    installKey: installation.identity.installKey,
    agentId: installation.agentId,
    installationSurfaceFingerprint,
    ownership: [...ownedArtifacts]
      .map(artifact => ({
        componentKey: artifact.componentKey,
        physicalTarget: artifact.physicalTarget,
        ownershipKey: artifact.ownershipKey,
        ownedFragmentHash: artifact.ownedFragmentHash,
      }))
      .sort((left, right) => key(left.componentKey, left.physicalTarget, left.ownershipKey)
        .localeCompare(key(right.componentKey, right.physicalTarget, right.ownershipKey))),
    live: inspection.components
      .map(component => ({
        componentKey: component.componentKey,
        observedTarget: component.observedTarget ?? null,
        observedFragmentHash: component.observedFragmentHash ?? null,
        visibility: component.visibility,
      }))
      .sort((left, right) => left.componentKey.localeCompare(right.componentKey)),
    removals: mutations
      .map(mutation => ({
        physicalTarget: mutation.physicalTarget,
        ownershipKey: mutation.ownershipKey,
        preconditionHash: mutation.preconditionHash ?? null,
        containerPreconditionHash: mutation.containerPreconditionHash ?? null,
      }))
      .sort((left, right) => key(left.physicalTarget, left.ownershipKey)
        .localeCompare(key(right.physicalTarget, right.ownershipKey))),
  })
}

function sharedDomainBindingFor(entries: readonly SharedDomainEntry[]): string | null {
  if (entries.length === 0) return null
  return sha256Json({
    schemaVersion: 1,
    domains: entries
      .map(({ physicalTarget, ownershipKey, consumers }) => ({ physicalTarget, ownershipKey, consumers }))
      .sort((left, right) => `${left.physicalTarget}\u0000${left.ownershipKey}`
        .localeCompare(`${right.physicalTarget}\u0000${right.ownershipKey}`)),
  })
}

function mutationComponentKeys(mutation: PlannedMutation): readonly ComponentKey[] {
  return mutation.coveredComponentKeys ?? [mutation.componentKey]
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
  if (!isMutationDomainKind(mutation.domainKind)) throw new Error('invalid mutation domain kind')
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

export function additionalPhysicalMutationDomains(
  installation: CoordinatorInstallation,
  mutation: PlannedMutation,
): readonly string[] {
  return [...new Set((mutation.additionalFenceTargets ?? []).map(target => physicalDomainForTarget(
    installation.identity.runtimeRealm,
    target.domainKind,
    target.physicalTarget,
  )))].sort()
}

function physicalDomainForTarget(
  runtimeRealm: InstallationIdentity['runtimeRealm'],
  domainKind: PlannedMutation['domainKind'],
  physicalTarget: string,
): string {
  if (!isMutationDomainKind(domainKind)) throw new Error('invalid additional mutation domain kind')
  if (domainKind === 'file_fragment' && runtimeRealm === 'local_macos') {
    return buildLegacyMutationDomain({ adapterId: 'aggregate', target: physicalTarget, selector: 'document' })
  }
  return `${runtimeRealm}:${domainKind}:${physicalTarget}`
}

function allPhysicalMutationDomains(mutation: PreparedMutationExecution): readonly string[] {
  return [...new Set([mutation.mutationDomain, ...(mutation.additionalMutationDomains ?? [])])].sort()
}

function latestMutationEpoch(mutations: readonly PreparedMutationExecution[]): string | undefined {
  const epochs = mutations
    .map(mutation => mutation.journal.updatedAt)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))
  return epochs[0]
}

async function acquireWriterFences(
  repository: CoordinatorRepositoryPort,
  mutationDomains: readonly string[],
): Promise<WriterFenceLease[]> {
  const leases: WriterFenceLease[] = []
  try {
    for (const domain of mutationDomains) {
      const lease = await repository.acquireWriterFence(domain)
      if (!lease) throw new WriterFenceUnavailableError(`writer fence unavailable: ${domain}`)
      leases.push(lease)
    }
    return leases
  } catch (error) {
    await releaseWriterFences(leases).catch(() => undefined)
    throw error
  }
}

async function assertWriterFencesOwned(leases: readonly WriterFenceLease[]): Promise<void> {
  for (const lease of leases) await lease.assertOwned()
}

async function releaseWriterFences(leases: readonly WriterFenceLease[]): Promise<void> {
  let failed = false
  for (const lease of [...leases].reverse()) {
    try {
      await lease.release()
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error('writer fence release failed')
}

function releaseExecutionFences(fences: readonly { release(): void }[]): void {
  let failed = false
  for (const fence of [...fences].reverse()) {
    try { fence.release() } catch { failed = true }
  }
  if (failed) throw new Error('execution fence release failed')
}

async function assertLivePrecondition(
  adapter: AgentHostAdapter,
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  allowSafeResume = false,
): Promise<void> {
  const observation = await adapter.readBack(context, mutation)
  assertReadBackVisibilityKnown(observation, mutation)
  if (allowSafeResume && exactFrozenResumeState(mutation, observation.safeToResumeFrom)) return
  if (mutation.operation === 'create' && mutation.preconditionHash === undefined) {
    if (observation.visibility !== 'absent') {
      throw new Error(`unowned_selector_occupied:${mutation.operationId}`)
    }
    return
  }
  if (mutation.preconditionHash === undefined) return
  if (observation.observedFragmentHash !== mutation.preconditionHash) {
    throw new Error(`live_precondition_changed:${mutation.operationId}`)
  }
}

function mutationEffectReadBack(
  readBack: Awaited<ReturnType<AgentHostAdapter['readBack']>>,
  mutation: PlannedMutation,
): { fingerprint: string | null; safeToResumeFrom?: string } {
  assertReadBackVisibilityKnown(readBack, mutation)
  if (exactFrozenResumeState(mutation, readBack.safeToResumeFrom)
    && readBack.observedFragmentHash === readBack.safeToResumeFrom!.fingerprint) {
    return {
      fingerprint: readBack.safeToResumeFrom!.fingerprint,
      safeToResumeFrom: readBack.safeToResumeFrom!.fingerprint,
    }
  }
  const fingerprint = readBackFingerprint(readBack, desiredFingerprint(mutation), mutation)
  return { fingerprint }
}

function exactFrozenResumeState(
  mutation: PlannedMutation,
  claimed: Awaited<ReturnType<AgentHostAdapter['readBack']>>['safeToResumeFrom'],
): boolean {
  if (!claimed) return false
  return (mutation.safeResumeStates ?? []).some(state => (
    state.fingerprint === claimed.fingerprint
    && state.completedStepIds.length === claimed.completedStepIds.length
    && state.completedStepIds.every((stepId, index) => stepId === claimed.completedStepIds[index])
  ))
}

function readBackFingerprint(
  readBack: Awaited<ReturnType<AgentHostAdapter['readBack']>>,
  desired: string | null,
  mutation: PlannedMutation,
): string | null {
  assertReadBackVisibilityKnown(readBack)
  if (readBack.visibility === 'absent') {
    // Aggregate host-command removal has an explicit absent-state fingerprint.
    // Ordinary file removal still uses null as its desired state.
    if (mutation.operation === 'host_command' && mutation.domainKind === 'plugin_manager'
      && desired !== null && readBack.matchesDesired && readBack.observedFragmentHash === desired) return desired
    return null
  }
  if (readBack.matchesDesired) return readBack.observedFragmentHash ?? desired ?? 'observed:unknown'
  // Never infer the planned before hash from a hashless observation. Recovery
  // may replay only when read-back positively proves that exact fingerprint.
  return readBack.observedFragmentHash ?? 'observed:unknown'
}

function assertReadBackVisibilityKnown(
  readBack: Awaited<ReturnType<AgentHostAdapter['readBack']>>,
  mutation?: PlannedMutation,
): void {
  const operationId = mutation?.operationId ?? readBack.operationId
  if (readBack.visibility === undefined || readBack.visibility === 'unknown') {
    throw new Error(`adapter_read_back_visibility_unknown:${operationId}`)
  }
  if (!readBack.observed && readBack.visibility !== 'absent') {
    throw new Error(`adapter_read_back_not_observed:${operationId}`)
  }
}

function isCompleteVerification(
  expected: readonly ComponentKey[],
  results: readonly ComponentVerificationResult[],
  expectedCapability: CapabilityLevel,
): boolean {
  if (results.length !== new Set(expected).size) return false
  const expectedSet = new Set(expected)
  if (!results.every(result => expectedSet.has(result.componentKey) && result.status === 'verified')) return false
  const verifiedComponents = new Set(results.map(result => result.componentKey))
  const achievedCapability = verifiedComponents.has('lifecycle')
    ? 4
    : verifiedComponents.has('instruction') && verifiedComponents.has('memory_tools')
      ? 3
      : verifiedComponents.has('memory_tools')
        ? 2
        : verifiedComponents.has('instruction')
          ? 1
          : 0
  const declaredCapability = Math.max(0, ...results.map(result => result.verifiedCapability ?? 0))
  return Math.max(achievedCapability, declaredCapability) >= expectedCapability
}

/**
 * A frozen Kimi conflict action is an explicit user-guided, no-write delivery
 * mode. While its target remains absent, verification is still pending rather
 * than a failed managed projection. Any visible-but-wrong content (or any
 * other adapter failure) remains a hard failure.
 */
function normalizeGuidedPendingVerification(
  preparedPlan: PreparedCoordinatorPlan,
  results: readonly ComponentVerificationResult[],
): readonly ComponentVerificationResult[] {
  const kimiPending = preparedPlan.adapterPlan.requiredUserActionDetails?.some(detail => (
    detail.kind === 'kimi_instruction_conflict'
    && detail.componentKey === 'instruction'
    && detail.targetVisibility === 'absent'
  )) ?? false
  if (!kimiPending) return results
  return results.map(result => (
    result.componentKey === 'instruction'
    && result.status === 'failed'
    && result.diagnostics.length === 1
    && result.diagnostics[0] === 'managed_document_not_visible'
      ? { ...result, status: 'unverified' as const }
      : result
  ))
}

function establishesGuidedRuntimeProjection(
  plan: PreparedCoordinatorPlan['adapterPlan'],
): boolean {
  return plan.requiredUserActionDetails?.some(detail => (
    (detail.kind === 'qwenwork_mcp_gui' && detail.operation === 'connect')
    || (detail.kind === 'claude_cowork_plugin_upload' && detail.operation === 'connect')
  )) ?? false
}

function sameMutation(left: PlannedMutation, right: PlannedMutation): boolean {
  return sha256Json(left) === sha256Json(right)
}

function nowIso(clock: CoordinatorClock): string {
  return clock.now().toISOString()
}
