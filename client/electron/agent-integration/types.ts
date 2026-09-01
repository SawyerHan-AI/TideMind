/**
 * Pure domain contracts for local Agent integration.
 *
 * This module deliberately contains no filesystem, database, Electron, or IPC
 * access. Host adapters describe and perform host-specific work, while the
 * coordinator remains responsible for consent, journaling, fencing, retries,
 * and persistence.
 */

export const CATALOG_IDS = [
  'claude-code-cli',
  'claude-code-native',
  'claude-cowork-local',
  'codex-cli',
  'codex-desktop',
  'cursor-desktop',
  'windsurf-desktop',
  'gemini-cli',
  'openclaw-local',
  'pi-official-cli',
  'omp-cli',
  'openhands-cli',
  'openhands-gui',
  'openhands-acp',
  'raycast-ai-desktop',
  'jan-desktop',
  'jan-cli',
  'anythingllm-desktop',
  'anythingllm-local-server',
  'librechat-local',
  'goose-cli',
  'goose-desktop',
  'letta-local-server',
  'agent-zero-local',
  'open-webui-local',
  'pi-agent-desktop',
  'pi-agent-rust-cli',
  'github-copilot-cli',
  'github-copilot-vscode',
  'github-copilot-jetbrains',
  'cline-cli',
  'cline-ide',
  'opencode-v1-cli',
  'opencode-v2-beta-cli',
  'kiro-cli',
  'kiro-ide',
  'junie-cli',
  'junie-ide',
  'amp-cli',
  'roo-code-vscode',
  'continue-ide',
  'zed-agent',
  'amazon-q-cli',
  'amazon-q-ide',
  'warp-desktop',
  'oz-runtime',
  'aider-cli',
  'qwenwork-desktop',
  'astrbot-local',
  'langbot-local',
  'lobehub-desktop',
  'lobehub-local',
  'kimi-code-cli',
  'kimi-code-native',
  'zcode-desktop',
  'zcode-cli',
  'qwen-code-cli',
  'qoder-cli',
  'qoder-ide',
  'qoder-jetbrains',
  'trae-ide',
  'codebuddy-cli',
  'codebuddy-ide',
  'codebuddy-vscode',
  'codebuddy-jetbrains',
  'baidu-comate-ide',
  'codearts-agent-cli',
  'codearts-agent-ide',
  'codearts-agent-vscode',
  'codearts-agent-jetbrains',
  'dify-local',
  'fastgpt-local',
  'ragflow-local',
  'cherry-studio-desktop',
  'chatbox-desktop',
  'maxkb-local',
  'nami-desktop',
  'catpaw-desktop',
  'codegeex-ide',
  'claude-desktop-legacy',
] as const

export type CatalogId = (typeof CATALOG_IDS)[number]
export type ProductFamilyId = string

export type DeliveryPriority = 'P0.1' | 'P0.2' | 'P1' | 'P2' | 'P3' | 'observe'
export type RuntimeRealm = 'local_macos' | 'wsl' | 'ssh' | 'dev_container'
export type HostKind = 'cli' | 'desktop' | 'ide_extension' | 'local_server' | 'runtime'
export type ReleaseChannel = 'stable' | 'beta' | 'legacy'
export type CapabilityLevel = 0 | 1 | 2 | 3 | 4

export const COMPONENT_KEYS = ['instruction', 'memory_tools', 'lifecycle'] as const
export type ComponentKey = (typeof COMPONENT_KEYS)[number]

export type ArtifactComponentType = 'skill' | 'mcp' | 'hook' | 'plugin' | 'rule'
export type DeliveryMode = 'cataloged' | 'detectable' | 'guided' | 'managed'
export type VerificationStatus = 'unverified' | 'verifying' | 'verified' | 'stale' | 'failed'
export type VerificationSummary = VerificationStatus | 'mixed'
export type DeliverySummary = 'cataloged' | 'detectable' | 'guided' | 'hybrid' | 'fully_managed'
export type AccessLevel = 'complete' | 'basic' | 'partial' | 'unconnected'
export type DesiredState = 'unmanaged' | 'managed' | 'disabled' | 'removed'
export type ObservedState =
  | 'absent'
  | 'discovered'
  | 'partial'
  | 'healthy'
  | 'drifted'
  | 'conflicted'
  | 'incompatible'
  | 'inaccessible'
export type VisibilityState = 'absent' | 'dedicated' | 'shared_visible' | 'hidden' | 'unknown'
export type ReconcileState =
  | 'idle'
  | 'planning'
  | 'awaiting_consent'
  | 'applying'
  | 'verifying'
  | 'compensating'
  | 'needs_recovery'
  | 'backoff'
  | 'paused'

export type StatusGroup =
  | 'available'
  | 'limited'
  | 'awaiting_connection'
  | 'awaiting_verification'
  | 'processing'
  | 'needs_attention'
  | 'paused'
  | 'disconnected'

export type StatusReason =
  | 'verified'
  | 'instruction_only'
  | 'capability_ceiling'
  | 'awaiting_consent'
  | 'incompatible'
  | 'unverified'
  | 'verification_stale'
  | 'connecting'
  | 'verifying'
  | 'repairing'
  | 'disconnecting'
  | 'new_session'
  | 'host_confirmation'
  | 'legacy_confirmation_required'
  | 'conflict'
  | 'permission'
  | 'verification_failed'
  | 'disconnect_incomplete'
  | 'shared_visibility_remaining'
  | 'user_disabled'
  | 'circuit_breaker'
  | 'disconnect_verified'
  | 'host_uninstalled'
  | 'executable_proof_too_large'
  | 'executable_metadata_unavailable'

export type MutationDomainKind =
  | 'file_fragment'
  | 'directory'
  | 'host_registry'
  | 'plugin_manager'
  | 'none'
export type MutationRisk = 'read_only' | 'low' | 'elevated' | 'high'
export type CommandCategory = 'none' | 'file_write' | 'host_cli' | 'plugin_install' | 'host_trust' | 'admin'
export type ReloadRequirement =
  | 'none'
  | 'reload'
  | 'new_session'
  | 'restart_host'
  | 'user_confirmation'
  | 'version_dependent'
export type ManagementAction = 'inspect' | 'connect' | 'repair' | 'disconnect' | 'verify'

export interface SupportedComponentDeclaration {
  componentKey: ComponentKey
  applicability: 'supported'
  deliveryMode: DeliveryMode
  artifactTypes: readonly ArtifactComponentType[]
  mutationDomain: MutationDomainKind
  risk: MutationRisk
  reload: ReloadRequirement
  actions: readonly ManagementAction[]
}

export interface NotApplicableComponentDeclaration {
  componentKey: ComponentKey
  applicability: 'not_applicable'
  reason: string
  deliveryMode: 'cataloged'
  artifactTypes: readonly []
  mutationDomain: 'none'
  risk: 'read_only'
  reload: 'none'
  actions: readonly ['inspect']
}

export type ComponentDeclaration = SupportedComponentDeclaration | NotApplicableComponentDeclaration

export interface AgentProduct {
  id: ProductFamilyId
  displayName: string
  variantIds: readonly CatalogId[]
}

export interface AgentHostVariant {
  catalogId: CatalogId
  productFamilyId: ProductFamilyId
  displayName: string
  hostKind: HostKind
  releaseChannel: ReleaseChannel
  deliveryPriority: DeliveryPriority
  maxCapability: CapabilityLevel
  runtimeRealms: readonly RuntimeRealm[]
  components: readonly ComponentDeclaration[]
  requiresStrongDistributionIdentity?: boolean
}

export type CatalogAliasResolution = 'direct' | 'requires_discovery' | 'legacy_audit'

export interface CatalogAlias {
  alias: string
  targetIds: readonly string[]
  resolution: CatalogAliasResolution
  reason: string
}

export interface AgentCatalog {
  schemaVersion: number
  catalogVersion: string
  products: readonly AgentProduct[]
  variants: readonly AgentHostVariant[]
  aliases: readonly CatalogAlias[]
}

export interface DistributionIdentity {
  distributionId?: string
  executableRealpath?: string
  packageProvenance?: string
  capabilityFingerprint?: string
}

export interface InstallationIdentity {
  runtimeRealm: RuntimeRealm
  osUserIdentity: string
  productFamilyId: ProductFamilyId
  hostVariant: CatalogId
  canonicalConfigRoot: string
  /** Exact host-owned config files selected by an explicit profile/env override. */
  componentConfigFiles?: Readonly<Partial<Record<ComponentKey, string>>>
  explicitProfile: string
  hostOwnedIdentity?: string
  distribution: DistributionIdentity
  installKey: string
}

export interface InstallationIdentityRecord extends InstallationIdentity {
  installationId: string
  aliasInstallKeys: readonly string[]
}

export interface InstallationComponentFact {
  componentKey: ComponentKey
  applicability: 'supported' | 'not_applicable'
  desiredState: DesiredState
  deliveryMode: DeliveryMode
  verificationStatus: VerificationStatus
  visibilityState: VisibilityState
}

export interface InstallationStatusInput {
  desiredState: DesiredState
  reconcileState: ReconcileState
  hasConsent: boolean
  compatible: boolean
  hostPresent: boolean
  verifiedCapability: CapabilityLevel | null
  verificationSummary: VerificationSummary
  disconnectVerified: boolean
  circuitBreakerOpen: boolean
  blockingReasons?: readonly StatusReason[]
}

export interface DerivedInstallationStatus {
  statusGroup: StatusGroup
  statusReason: StatusReason
  accessLevel: AccessLevel
  accessIsHistorical: boolean
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface AdapterRuntimeContext {
  runtimeRealm: RuntimeRealm
  homeDir: string
  applicationDataDir: string
  shimPath: string
  mcpServerPath: string
  hookScriptPath: string
  preCompactScriptPath: string
  postCompactScriptPath: string
  tideMindVersion: string
  catalogVersion: string
  projectionVersion: string
}

export type HostActivitySignal =
  | 'brain_prepare'
  | 'brain_recall'
  | 'brain_digest'
  | 'session_start'
  | 'pre_compact'
  | 'post_compact'

export interface HostActivityEvidenceRecord {
  id: string
  installationId: string
  agentId: string
  hostVariant: CatalogId
  componentKey: 'memory_tools' | 'lifecycle'
  signalName: HostActivitySignal
  tideMindVersion: string
  adapterVersion: string
  projectionVersion: string
  hostVersion: string
  evidenceHash: string
  observedAt: string
}

export interface HostActivityEvidenceQuery {
  installationId: string
  agentId: string
  hostVariant: CatalogId
  componentKey: 'memory_tools' | 'lifecycle'
  signalNames: readonly HostActivitySignal[]
  tideMindVersion: string
  adapterVersion: string
  projectionVersion: string
  hostVersion: string
  observedAfter: string
}

export interface HostActivityEvidenceReader {
  find(query: HostActivityEvidenceQuery): readonly HostActivityEvidenceRecord[] | Promise<readonly HostActivityEvidenceRecord[]>
}

export interface AdapterOperationContext {
  runtime: AdapterRuntimeContext
  installation: InstallationIdentity
  /** Stable EB_AGENT_ID assigned after discovery and persisted with the Installation. */
  agentId: string
  operationId: string
  /** Read-only local runtime evidence; absent means verification must stay unverified. */
  hostActivityEvidence?: HostActivityEvidenceReader
}

export interface AdapterComponentObservation {
  componentKey: ComponentKey
  visibility: VisibilityState
  verificationStatus: VerificationStatus
  observedTarget?: string
  observedFragmentHash?: string
  details?: Readonly<Record<string, JsonValue>>
}

export interface AdapterInspection {
  catalogId: CatalogId
  detected: boolean
  detectedVersion?: string
  distribution: DistributionIdentity
  components: readonly AdapterComponentObservation[]
  provenance: readonly string[]
  diagnostics: readonly string[]
}

export type MutationOperation = 'create' | 'update' | 'remove' | 'host_command'

export interface PlannedMutation {
  operationId: string
  componentKey: ComponentKey
  operation: MutationOperation
  domainKind: MutationDomainKind
  physicalTarget: string
  ownershipKey: string
  selectorSchemaVersion: number
  risk: MutationRisk
  reload: ReloadRequirement
  commandCategory?: CommandCategory
  executableRealpath?: string
  args?: readonly string[]
  /** Exact live hash of the Tide Mind-owned selector/directory entry. */
  preconditionHash?: string
  /** Exact hash of the containing file before a selector-level mutation. */
  containerPreconditionHash?: string
  desiredFragmentHash?: string
  idempotent: boolean
  metadata?: Readonly<Record<string, JsonValue>>
}

export interface AdapterPlanRequest {
  desiredCapability: CapabilityLevel
  desiredComponents: readonly ComponentKey[]
  observed: AdapterInspection
  ownedArtifacts: readonly OwnedArtifactBaseline[]
}

export interface OwnedArtifactBaseline {
  componentKey: ComponentKey
  physicalTarget: string
  ownershipKey: string
  ownedFragmentHash: string
  selectorSchemaVersion?: number
}

export interface AdapterDisconnectRequest {
  componentKeys: readonly ComponentKey[]
  observed: AdapterInspection
  ownedArtifacts: readonly OwnedArtifactBaseline[]
}

export interface AdapterPlan {
  catalogId: CatalogId
  installationKey: string
  adapterVersion: string
  projectionVersion: string
  mutations: readonly PlannedMutation[]
  requiredUserActions: readonly string[]
  diagnostics: readonly string[]
}

export interface MutationApplyReceipt {
  operationId: string
  effectObserved: boolean
  postEffectFingerprint?: string
  hostReceipt?: Readonly<Record<string, JsonValue>>
}

export interface MutationReadBack {
  operationId: string
  observed: boolean
  matchesDesired: boolean
  observedFragmentHash?: string
  visibility?: VisibilityState
  diagnostics: readonly string[]
}

export interface AdapterVerificationRequest {
  componentKeys: readonly ComponentKey[]
  expectedCapability: CapabilityLevel
  inspection: AdapterInspection
  /** Exact versions frozen by the coordinator for this verification attempt. */
  activityBinding?: {
    installationId: string
    tideMindVersion: string
    adapterVersion: string
    projectionVersion: string
    hostVersion: string | null
    observedAfter: string
    verifiedAt: string
  }
}

export interface ComponentVerificationResult {
  componentKey: ComponentKey
  status: VerificationStatus
  verifiedCapability: CapabilityLevel | null
  evidenceHash?: string
  evidenceRef?: string
  expiresAt?: string
  identityAssertion?: string
  reloadGeneration?: string
  invalidationKeys: readonly string[]
  diagnostics: readonly string[]
}

/**
 * Side-effect-free proof that a live Artifact exactly matches a Tide Mind
 * projection for the supplied Agent identity.  Legacy migration may import
 * this as an ownership baseline, but only identity-bearing evidence may bind a
 * legacy `agent_id` to an Installation.
 */
export interface AdoptableArtifactObservation {
  componentKey: ComponentKey
  artifactType: ArtifactComponentType
  domainKind: MutationDomainKind
  physicalTarget: string
  ownershipKey: string
  selectorSchemaVersion: number
  projectionVersion: string
  containerHash?: string
  fragmentHash: string
  identityAssertion?: string
  discoverReachability: 'dedicated' | 'shared_visible' | 'per_host_ignorable'
}

/**
 * Host adapters never grant consent, persist journals, acquire writer fences,
 * retry operations, or aggregate health. Those responsibilities belong to the
 * coordinator. `disconnect` only plans removals; `apply` is the single effect
 * entry point for both connection and disconnection mutations.
 */
export interface AgentHostAdapter {
  readonly catalogId: CatalogId
  readonly adapterVersion: string
  /** Components for which this Adapter has an actual projector/read-back path. */
  readonly componentKeys: readonly ComponentKey[]
  /** Concrete Artifact carriers emitted by this implementation, not Catalog aspirations. */
  readonly implementationTypes: Readonly<Partial<Record<ComponentKey, readonly ArtifactComponentType[]>>>
  inspect(context: AdapterOperationContext): Promise<AdapterInspection>
  /** Exact, read-only legacy ownership probes; absence means "not adoptable". */
  inspectAdoptableArtifacts?(
    context: AdapterOperationContext,
  ): Promise<readonly AdoptableArtifactObservation[]>
  plan(context: AdapterOperationContext, request: AdapterPlanRequest): Promise<AdapterPlan>
  apply(context: AdapterOperationContext, mutation: PlannedMutation): Promise<MutationApplyReceipt>
  readBack(context: AdapterOperationContext, mutation: PlannedMutation): Promise<MutationReadBack>
  disconnect(context: AdapterOperationContext, request: AdapterDisconnectRequest): Promise<AdapterPlan>
  verify(
    context: AdapterOperationContext,
    request: AdapterVerificationRequest,
  ): Promise<readonly ComponentVerificationResult[]>
}

export function deriveAccessLevel(capability: CapabilityLevel | null): AccessLevel {
  if (capability === 4) return 'complete'
  if (capability === 3) return 'basic'
  if (capability === 2 || capability === 1) return 'partial'
  return 'unconnected'
}

export function deriveDeliverySummary(components: readonly InstallationComponentFact[]): DeliverySummary {
  const relevant = components.filter(component =>
    component.applicability === 'supported' && component.desiredState !== 'removed',
  )
  if (relevant.length === 0) return 'cataloged'

  const modes = new Set(relevant.map(component => component.deliveryMode))
  if (modes.size > 1) return 'hybrid'
  const [mode] = modes
  if (mode === 'managed') return 'fully_managed'
  return mode ?? 'cataloged'
}

export function deriveVerificationSummary(
  components: readonly InstallationComponentFact[],
): VerificationSummary {
  const relevant = components.filter(component =>
    component.applicability === 'supported'
    && component.desiredState !== 'removed'
    && component.desiredState !== 'unmanaged',
  )
  if (relevant.length === 0) return 'unverified'

  const statuses = new Set(relevant.map(component => component.verificationStatus))
  if (statuses.size === 1) return statuses.values().next().value ?? 'unverified'
  return 'mixed'
}

const NEEDS_ATTENTION_REASONS: readonly StatusReason[] = [
  'new_session',
  'host_confirmation',
  'legacy_confirmation_required',
  'conflict',
  'permission',
  'verification_failed',
  'disconnect_incomplete',
  'shared_visibility_remaining',
]

function firstReason(
  candidates: readonly StatusReason[] | undefined,
  allowed: readonly StatusReason[],
): StatusReason | undefined {
  return candidates?.find(candidate => allowed.includes(candidate))
}

export function deriveInstallationStatus(input: InstallationStatusInput): DerivedInstallationStatus {
  const accessLevel = deriveAccessLevel(input.verifiedCapability)
  const accessIsHistorical = input.verificationSummary === 'stale'

  if (!input.hostPresent) {
    return { statusGroup: 'needs_attention', statusReason: 'host_uninstalled', accessLevel, accessIsHistorical }
  }

  if (input.desiredState === 'removed') {
    if (['planning', 'applying', 'verifying', 'compensating'].includes(input.reconcileState)) {
      return { statusGroup: 'processing', statusReason: 'disconnecting', accessLevel, accessIsHistorical }
    }
    if (input.disconnectVerified) {
      return { statusGroup: 'disconnected', statusReason: 'disconnect_verified', accessLevel, accessIsHistorical }
    }
    const residual = firstReason(input.blockingReasons, ['shared_visibility_remaining'])
    return {
      statusGroup: 'needs_attention',
      statusReason: residual ?? 'disconnect_incomplete',
      accessLevel,
      accessIsHistorical,
    }
  }

  if (input.desiredState === 'disabled') {
    return { statusGroup: 'paused', statusReason: 'user_disabled', accessLevel, accessIsHistorical }
  }
  if (input.circuitBreakerOpen || input.reconcileState === 'backoff') {
    return { statusGroup: 'paused', statusReason: 'circuit_breaker', accessLevel, accessIsHistorical }
  }

  if (input.reconcileState === 'paused') {
    const pausedReason = firstReason(input.blockingReasons, NEEDS_ATTENTION_REASONS)
    if (pausedReason) {
      return { statusGroup: 'needs_attention', statusReason: pausedReason, accessLevel, accessIsHistorical }
    }
    if (input.blockingReasons?.includes('verification_stale')) {
      return {
        statusGroup: 'awaiting_verification',
        statusReason: 'verification_stale',
        accessLevel,
        accessIsHistorical: true,
      }
    }
    return { statusGroup: 'paused', statusReason: 'circuit_breaker', accessLevel, accessIsHistorical }
  }

  if (input.reconcileState === 'needs_recovery') {
    const recoveryReason = firstReason(input.blockingReasons, NEEDS_ATTENTION_REASONS)
    return {
      statusGroup: 'needs_attention',
      statusReason: recoveryReason ?? 'verification_failed',
      accessLevel,
      accessIsHistorical,
    }
  }

  if (input.reconcileState !== 'idle' && input.reconcileState !== 'awaiting_consent') {
    const statusReason: StatusReason = input.reconcileState === 'verifying'
      ? 'verifying'
      : input.reconcileState === 'compensating'
        ? 'repairing'
        : 'connecting'
    return { statusGroup: 'processing', statusReason, accessLevel, accessIsHistorical }
  }

  const blockingReason = firstReason(input.blockingReasons, NEEDS_ATTENTION_REASONS)
  if (blockingReason) {
    return { statusGroup: 'needs_attention', statusReason: blockingReason, accessLevel, accessIsHistorical }
  }

  if (!input.compatible) {
    return { statusGroup: 'awaiting_connection', statusReason: 'incompatible', accessLevel, accessIsHistorical }
  }
  if (!input.hasConsent || input.reconcileState === 'awaiting_consent') {
    return { statusGroup: 'awaiting_connection', statusReason: 'awaiting_consent', accessLevel, accessIsHistorical }
  }
  if (input.verificationSummary === 'failed') {
    return {
      statusGroup: 'needs_attention',
      statusReason: 'verification_failed',
      accessLevel,
      accessIsHistorical,
    }
  }
  if (input.verificationSummary === 'stale') {
    return {
      statusGroup: 'awaiting_verification',
      statusReason: 'verification_stale',
      accessLevel,
      accessIsHistorical: true,
    }
  }
  if (input.verificationSummary !== 'verified') {
    return { statusGroup: 'awaiting_verification', statusReason: 'unverified', accessLevel, accessIsHistorical }
  }
  if ((input.verifiedCapability ?? 0) >= 2) {
    return { statusGroup: 'available', statusReason: 'verified', accessLevel, accessIsHistorical }
  }
  return {
    statusGroup: 'limited',
    statusReason: input.verifiedCapability === 1 ? 'instruction_only' : 'capability_ceiling',
    accessLevel,
    accessIsHistorical,
  }
}
