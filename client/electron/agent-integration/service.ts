import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentIntegrationApplyItemDto,
  AgentIntegrationApplyResultDto,
  AgentIntegrationApplyTaskDto,
  AgentIntegrationApplyTaskPageDto,
  AgentIntegrationApplyTaskPageRequestDto,
  AgentIntegrationCircuitResetPreviewDto,
  AgentIntegrationComponentDto,
  AgentIntegrationDetailDto,
  AgentIntegrationEventDto,
  AgentIntegrationInboxDto,
  AgentIntegrationInstallationDto,
  AgentIntegrationPlanInstallationDto,
  AgentIntegrationPlanPreviewDto,
  AgentIntegrationPlanTargetDto,
  AgentIntegrationScanResultDto,
  AgentIntegrationSnapshotDto,
  AgentIntegrationSupportProductDto,
  AgentIntegrationClaudeCoworkPreflightDto,
  AgentIntegrationClaudeCoworkPreparedDto,
  AgentIntegrationRequiredUserActionDto,
  AgentIntegrationConnectOptionsDto,
  AgentIntegrationCustomPreflightDto,
  AgentIntegrationCustomRequestDto,
  AgentIntegrationCodexTrustReviewDto,
  AgentIntegrationCodexTrustResultDto,
  AgentIntegrationGuidedRemovalReviewDto,
  AgentIntegrationGuidedRemovalResultDto,
} from '../../src/lib/api-contract.js'
import { AGENT_CATALOG, getCatalogProduct, getCatalogVariant } from './catalog.js'
import {
  agentReleaseSurfaceEligibilityReason,
  isAgentReleaseGateReason,
  type AgentReleaseEntry,
} from './release-manifest.js'
import {
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  P0_DISCOVERY_CATALOG_IDS,
  toDiscoverInstallationInput,
  type DiscoveredInstallation,
  type LocalDiscoveryReport,
} from './discovery.js'
import { sha256Json } from './fingerprint.js'
import { customMcpConfiguration } from './hosts/custom-mcp-configuration.js'
import { CURRENT_CONSENT_POLICY_VERSION } from './consent.js'
import { canonicalizeInstallationIdentity, matchInstallationIdentity } from './identity.js'
import {
  newInstallationNotification,
  publishIntegrationEvent,
  type NotificationPort,
} from './events.js'
import type { PreparedCoordinatorPlan } from './planner.js'
import {
  frozenPlanInstallationSurfaceFingerprint,
  frozenPlanLiveTrustProofFingerprint,
  type AgentIntegrationCoordinator,
  type ApplyPreparedRequest,
  type CoordinatorInstallation,
  type CoordinatorOutcome,
  type PreviewRequest,
} from './coordinator.js'
import {
  AgentIntegrationRepository,
  persistedComponentConfigFiles,
  persistedComponentConfigRoots,
  persistedDistribution,
  persistedHostOwnedIdentity,
  persistedManagementEligibility,
  persistedProjectionSurfaceFingerprint,
  type ApplyTaskRunRow,
  type DurableApplyTaskRow,
  type AgentInstallationRow,
  type DiscoverInstallationInput,
  type DisconnectArtifactScope,
} from './repository.js'
import { readStableFileFingerprint, readStableFileSnapshot } from './passive-cli-version.js'
import { parseJsoncObject } from './jsonc-document.js'
import {
  COMPONENT_KEYS,
  deriveInstallationStatus,
  type CapabilityLevel,
  type CatalogId,
  type ComponentKey,
  type ArtifactComponentType,
  type CodexHookTrustRequiredUserAction,
  type ClaudeCoworkPluginRequiredUserAction,
  type CommandCategory,
  type MutationRisk,
  type JsonValue,
  type QwenWorkMcpRequiredUserAction,
  type ManualFileRemovalRequiredUserAction,
  type StatusReason,
} from './types.js'

const PLAN_TTL_MS = 15 * 60 * 1_000
const STATUS_REASONS = new Set<StatusReason>([
  'verified', 'legacy_callable_unmanaged', 'instruction_only', 'capability_ceiling', 'awaiting_consent', 'incompatible',
  'unverified', 'verification_stale', 'connecting', 'verifying', 'repairing', 'disconnecting',
  'new_session', 'host_confirmation', 'conflict', 'permission', 'verification_failed',
  'legacy_confirmation_required',
  'disconnect_incomplete', 'shared_visibility_remaining', 'user_disabled', 'circuit_breaker',
  'disconnect_verified', 'host_uninstalled',
  'executable_proof_too_large', 'executable_metadata_unavailable',
  'release_entry_missing', 'release_mode_detect_only', 'release_distribution_not_accepted',
  'release_version_unverified', 'release_version_not_accepted', 'release_artifact_not_accepted',
])

export interface AgentIntegrationScannerPort {
  scan(): Promise<LocalDiscoveryReport>
  /** Explicit user-started probe; passive scan must never infer Cowork from Claude.app. */
  previewGuidedInstallation?(catalogId: 'claude-cowork-local'): Promise<DiscoveredInstallation | null>
}

export type AgentIntegrationExecutionPort = Pick<AgentIntegrationCoordinator, 'preview' | 'applyPrepared'>

export interface AgentIntegrationServiceDependencies {
  repository: AgentIntegrationRepository
  scanner: AgentIntegrationScannerPort
  execution: AgentIntegrationExecutionPort
  now?(): Date
  installationId?(): string
  agentId?(): string
  consentId?(): string
  homeDir?: string
  /** Makes synthetic fixture evidence explicit in renderer-facing audit snapshots. */
  fixtureMode?: 'isolated_ui_audit'
  /** Production rollout gate. Omit in tests to expose every implemented adapter. */
  enabledCatalogIds?: readonly CatalogId[]
  /** Shipped projector/read-back components, distinct from Catalog roadmap ceilings. */
  implementedComponents?: ReadonlyMap<CatalogId, readonly ComponentKey[]>
  implementedArtifactTypes?: ReadonlyMap<
    CatalogId,
    Readonly<Partial<Record<ComponentKey, readonly ArtifactComponentType[]>>>
  >
  /** Components the concrete Adapter can omit while keeping the rest of a connect projection valid. */
  connectOptionalComponents?: ReadonlyMap<CatalogId, readonly ComponentKey[]>
  /** Signed-build delivery disposition and capability ceiling. */
  releaseEntries?: ReadonlyMap<CatalogId, AgentReleaseEntry>
  /** Production-only current-manifest check; hermetic service tests omit it. */
  enforceReleaseAcceptance?: boolean
  releasePolicy?: {
    manifestVersion: string
    mode: 'active' | 'emergency_read_only' | 'invalid_manifest'
    customLocalAgentEnabled: boolean
    diagnostics: readonly string[]
  }
  /** Runs only after discovery rows have been durably upserted. */
  afterScan?(): Promise<void>
  /** Closes the startup/recovery latch before any discovery attempt begins. */
  beforeScan?(): void
  /** Re-enters reconciliation after the user explicitly resets a repair circuit. */
  afterCircuitReset?(): Promise<void>
  /** Reconciles shared physical state immediately after an absent no-op detach. */
  afterDisconnect?(): Promise<void>
  /** Performs a fresh host read-back before a resumed Installation can regain green status. */
  afterResume?(): Promise<void>
  /** Revalidates persisted evidence generations/expiry before renderer state is derived. */
  refreshVerificationFreshness?(): void
  /** Distribution-level write trust. Detection may remain visible when this is false. */
  canManageInstallation?(installation: AgentInstallationRow): boolean
  /** Production CLI policy. Omit only for isolated tests with an injected trust seam. */
  cliManagementProofLimitBytes?: number
  /** Re-attests the physical package/signature proof immediately before consent. */
  attestInstallation?(installation: AgentInstallationRow, expectedProofFingerprint: string): Promise<boolean>
  /** Keeps an explicitly user-authorized Custom MCP target visible without broad filesystem discovery. */
  probeCustomInstallation?(installation: AgentInstallationRow): Promise<boolean>
  /** User notification delivery; persistence remains mandatory when delivery is unavailable. */
  notifications?: NotificationPort
  notificationLocale?: string | (() => string)
  /** Runtime paths used only to build a user-requested Custom MCP projection. */
  customMcpRuntime?: { shimPath: string; mcpServerPath: string }
  /** Tide Mind-owned export root for explicit Cowork plugin packaging. */
  coworkGuidedRuntime?: { applicationDataDir: string }
  /** Read-only official persisted-state verifier for one exact frozen Codex action. */
  verifyCodexHookTrust?(input: {
    installation: CoordinatorInstallation
    hostVersion: string
    action: CodexHookTrustRequiredUserAction
    liveTrustProofFingerprint: string
  }): Promise<{
    trusted: true
    sourcePath: string
    hookKey: string
    hostCurrentHash: string
    hooksFileFingerprint: string
    trustConfigFingerprint: string
  } | null>
  /** Re-enters verification after a durable host-trust receipt is recorded. */
  afterCodexHookTrust?(): Promise<void>
  /** Re-enters coordinator verification after a durable guided-removal receipt. */
  afterGuidedRemoval?(): Promise<void>
}

interface CachedPlanItem {
  installation: CoordinatorInstallation
  desiredCapability: CapabilityLevel
  prepared: PreparedCoordinatorPlan
  maintenanceScopes: NoopMaintenanceScope[]
  disconnectScopes: DisconnectArtifactScope[]
}

interface NoopMaintenanceScope {
  componentKey: ComponentKey
  artifactKey: string
  targetPath: string
  ownershipSelector: string
  selectorSchemaVersion: number
  commandCategory: 'file_write'
  risk: 'low'
}

interface ConsentAuthorizationTarget {
  componentKey: ComponentKey
  artifactKey: string
  targetPath: string | null
  ownershipSelector: string
  selectorSchemaVersion: number
  commandCategory: CommandCategory
  risk: MutationRisk
  executablePath?: string
}

interface CachedPlanBundle {
  hash: string
  operation: 'connect' | 'disconnect'
  installationIds: string[]
  items: CachedPlanItem[]
  expiresAtMs: number
  consentIds: Map<string, string>
}

interface CachedCircuitResetPlan {
  hash: string
  installationId: string
  artifactIds: string[]
  scope: ReturnType<AgentIntegrationRepository['listResettableArtifactCircuitScope']>
  scopeFingerprint: string
  preview: AgentIntegrationCircuitResetPreviewDto
  expiresAtMs: number
}

interface CachedCustomPreflight {
  hash: string
  expiresAtMs: number
  request: AgentIntegrationCustomRequestDto
  draft: DiscoverInstallationInput
  preview: AgentIntegrationCustomPreflightDto
  mcpConfiguration: string | null
  sourceSurfaceFingerprint: string | null
  configFingerprint: string
  executableFingerprint: string | null
  legacyIdentityBinding: {
    installationId: string
    agentId: string
    installKey: string
    metadataJson: string
  } | null
  installationPrepared: boolean
}

interface CachedCoworkPreflight {
  hash: string
  expiresAtMs: number
  draft: DiscoverInstallationInput
  sourceSurfaceFingerprint: string
  preview: AgentIntegrationClaudeCoworkPreflightDto
}

interface CachedCodexTrustAction {
  hash: string
  expiresAtMs: number
  installation: CoordinatorInstallation
  installationSurfaceFingerprint: string
  liveTrustProofFingerprint: string
  hostVersion: string
  artifactId: string
  action: CodexHookTrustRequiredUserAction
}

interface CachedGuidedRemovalAction {
  hash: string
  expiresAtMs: number
  installationId: string
  installationSurfaceFingerprint: string
  runId: string
  activityGenerationToken: string
  connectorAction: QwenWorkMcpRequiredUserAction | import('./types.js').CustomMcpImportRequiredUserAction
  fileAction: ManualFileRemovalRequiredUserAction | null
}

/**
 * Renderer-facing orchestration boundary. The service owns full prepared plans;
 * IPC only ever sees redacted summaries plus an opaque hash.
 */
export class AgentIntegrationService {
  private readonly plans = new Map<string, CachedPlanBundle>()
  private readonly circuitResetPlans = new Map<string, CachedCircuitResetPlan>()
  private readonly customPreflights = new Map<string, CachedCustomPreflight>()
  private readonly coworkPreflights = new Map<string, CachedCoworkPreflight>()
  private readonly codexTrustActions = new Map<string, CachedCodexTrustAction>()
  private readonly codexTrustConfirmations = new Map<string, Promise<AgentIntegrationCodexTrustResultDto>>()
  private readonly guidedRemovalActions = new Map<string, CachedGuidedRemovalAction>()
  private readonly guidedRemovalConfirmations = new Map<string, Promise<AgentIntegrationGuidedRemovalResultDto>>()
  private readonly applyTasks = new Map<string, AgentIntegrationApplyTaskDto>()
  private readonly applyTaskListeners = new Set<(task: AgentIntegrationApplyTaskDto) => void>()
  private scanInFlight: Promise<AgentIntegrationScanResultDto> | null = null
  private readonly now: () => Date
  private readonly installationId: () => string
  private readonly agentId: () => string
  private readonly consentId: () => string
  private readonly homeDir: string
  private readonly enabledCatalogIds: ReadonlySet<CatalogId> | null
  private readonly implementedComponents: ReadonlyMap<CatalogId, ReadonlySet<ComponentKey>> | null
  private readonly implementedArtifactTypes: ReadonlyMap<
    CatalogId,
    Readonly<Partial<Record<ComponentKey, readonly ArtifactComponentType[]>>>
  > | null
  private readonly connectOptionalComponents: ReadonlyMap<CatalogId, ReadonlySet<ComponentKey>> | null
  private readonly releaseEntries: ReadonlyMap<CatalogId, AgentReleaseEntry> | null

  constructor(private readonly dependencies: AgentIntegrationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.installationId = dependencies.installationId ?? (() => `installation_${randomUUID()}`)
    this.agentId = dependencies.agentId ?? (() => `eb_${randomUUID().replaceAll('-', '').slice(0, 16)}`)
    this.consentId = dependencies.consentId ?? (() => `consent_${randomUUID()}`)
    const resolvedHome = path.resolve(dependencies.homeDir ?? os.homedir())
    this.homeDir = fs.existsSync(resolvedHome) ? fs.realpathSync(resolvedHome) : resolvedHome
    this.enabledCatalogIds = dependencies.enabledCatalogIds
      ? new Set(dependencies.enabledCatalogIds)
      : null
    this.implementedComponents = dependencies.implementedComponents
      ? new Map([...dependencies.implementedComponents].map(([catalogId, keys]) => [catalogId, new Set(keys)]))
      : null
    this.implementedArtifactTypes = dependencies.implementedArtifactTypes ?? null
    this.connectOptionalComponents = dependencies.connectOptionalComponents
      ? new Map([...dependencies.connectOptionalComponents].map(([catalogId, keys]) => [catalogId, new Set(keys)]))
      : null
    this.releaseEntries = dependencies.releaseEntries ?? null
    this.dependencies.repository.interruptAbandonedApplyTasks(this.now().toISOString())
  }

  snapshot(): AgentIntegrationSnapshotDto {
    this.dependencies.refreshVerificationFreshness?.()
    const allRows = this.dependencies.repository.listInstallations({ includeRemoved: true })
    // Confirmed host removals are retained in the local ledger for audit and
    // recovery, but they are history rather than currently installed Agents.
    const historyRows = allRows.filter(isHistoricalInstallationRow)
    const rows = allRows.filter(row => !isHistoricalInstallationRow(row))
    const installations = rows.map(row => this.toInstallationDto(row))
    const historyInstallations = historyRows
      .map(row => this.toInstallationDto(row))
      .sort(compareInstallations)
    const byFamily = new Map<string, AgentIntegrationInstallationDto[]>()
    for (const installation of installations) {
      const family = byFamily.get(installation.familyId) ?? []
      family.push(installation)
      byFamily.set(installation.familyId, family)
    }
    const families = [...byFamily.entries()].map(([familyId, members]) => {
      const sorted = [...members].sort(compareInstallations)
      const accessLevels = [...new Set(sorted.map(item => item.accessLevel))]
      const highestPriorityStatus = [...sorted]
        .sort((left, right) => statusRank(left.statusGroup) - statusRank(right.statusGroup))[0].statusGroup
      return {
        id: familyId,
        displayName: safeProductName(familyId, sorted[0]?.displayName ?? familyId),
        installationIds: sorted.map(item => item.id),
        statusGroup: highestPriorityStatus,
        accessLevels,
        needsAttentionCount: members.filter(item => item.statusGroup === 'needs_attention').length,
        unreadEventCount: members.reduce((total, item) => total + item.unreadEventCount, 0),
      }
    }).sort((left, right) => left.displayName.localeCompare(right.displayName))
    const lastScanAt = this.dependencies.repository.getLastSuccessfulScanAt()
    return {
      ...(this.dependencies.fixtureMode ? { fixtureMode: this.dependencies.fixtureMode } : {}),
      ...(this.dependencies.releasePolicy ? {
        releasePolicy: {
          ...this.dependencies.releasePolicy,
          diagnostics: [...this.dependencies.releasePolicy.diagnostics],
        },
      } : {}),
      historyInstallations,
      families,
      installations: installations.sort(compareInstallations),
      summary: {
        familyCount: families.length,
        installationCount: installations.length,
        availableCount: installations.filter(item => item.statusGroup === 'available').length,
        needsAttentionCount: installations.filter(item => item.statusGroup === 'needs_attention').length,
        awaitingConnectionCount: installations.filter(item =>
          item.manageable && item.statusGroup === 'awaiting_connection',
        ).length,
      },
      lastScanAt,
    }
  }

  scan(): Promise<AgentIntegrationScanResultDto> {
    if (this.scanInFlight) return this.scanInFlight
    this.scanInFlight = this.performScan().finally(() => { this.scanInFlight = null })
    return this.scanInFlight
  }

  /**
   * Validates and freezes a user-selected local target without creating an
   * Installation. The caller must explicitly continue to
   * prepareCustomConnect before the draft identity is persisted and handed to
   * the normal coordinator preview/consent/apply chain.
   */
  async previewCustomInstallation(
    input: AgentIntegrationCustomRequestDto,
  ): Promise<AgentIntegrationCustomPreflightDto> {
    this.requireCustomFlowEnabled()
    const displayName = normalizeCustomDisplayName(input.displayName)
    let request: AgentIntegrationCustomRequestDto
    let draft: DiscoverInstallationInput
    let hostLabel: string
    let targetLabel: string
    let componentKeys: ComponentKey[]
    let mcpConfiguration: string | null = null
    let sourceSurfaceFingerprint: string | null = null
    let configFingerprint: string
    let executableFingerprint: string | null = null
    let legacyIdentityBinding: CachedCustomPreflight['legacyIdentityBinding'] = null

    if (input.mode === 'nonstandard_config_root') {
      const source = this.requireInstallation(input.sourceInstallationId)
      if (source.family === 'custom-local-agent' || source.host_variant === 'custom-local-mcp') {
        throw new Error('a Custom Installation cannot be used as the source host')
      }
      if (!this.isManageableInstallation(source)
        || source.health_state !== 'discovered'
        || source.status_reason === 'conflict') {
        throw new Error('the selected source host is not currently trusted and manageable')
      }
      const canonicalRoot = canonicalCustomDirectory(input.configRoot, this.homeDir)
      const sourceVariant = source.host_variant as CatalogId
      // This is a release contract, not an inferred Adapter capability. An
      // Adapter may look relocatable in code while still lacking per-variant
      // real-host acceptance, so absence of the signed manifest entry must
      // fail closed.
      if (!this.releaseEntries?.get(sourceVariant)?.customConfigRoot.supported) {
        throw new Error(`${safeProductName(source.family, source.display_name)} does not support an isolated custom configuration root in this Tide Mind version`)
      }
      if (source.config_root && path.resolve(source.config_root) === canonicalRoot) {
        throw new Error('the selected folder is already the standard configuration root')
      }
      const directoryStat = fs.statSync(canonicalRoot, { bigint: true })
      configFingerprint = sha256Json({
        realpath: canonicalRoot,
        device: String(directoryStat.dev),
        inode: String(directoryStat.ino),
        mode: String(directoryStat.mode),
      })
      sourceSurfaceFingerprint = persistedProjectionSurfaceFingerprint(source)
      request = {
        mode: input.mode,
        displayName,
        sourceInstallationId: source.id,
        configRoot: canonicalRoot,
      }
      const installKey = customInstallKey({
        mode: input.mode,
        sourceInstallKey: source.install_key,
        configRoot: canonicalRoot,
      })
      const existing = this.dependencies.repository.getInstallationByInstallKey('local_macos', installKey)
      const sourceMetadata = parseStoredMetadata(source.metadata_json)
      if (!source.config_root) throw new Error('the selected source host has no canonical configuration root')
      const relocatedMetadata = relocateCustomRootMetadata(sourceMetadata, source.config_root, canonicalRoot)
      const profileId = `custom-${createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12)}`
      draft = {
        id: existing?.id ?? this.installationId(),
        family: 'custom-local-agent',
        hostVariant: source.host_variant,
        runtimeRealm: 'local_macos',
        profileId,
        installKey,
        distributionId: source.distribution_id,
        provenance: source.provenance,
        osUserIdentity: source.os_user_identity,
        displayName,
        configRoot: canonicalRoot,
        executablePath: source.executable_path,
        appPath: source.app_path,
        detectedVersion: source.detected_version,
        versionDetectionMethod: source.version_detection_method,
        agentId: existing?.agent_id ?? this.agentId(),
        supportedCapability: source.supported_capability,
        lastDetectedAt: this.now().toISOString(),
        metadata: {
          discoverySchemaVersion: 1,
          explicitProfile: profileId,
          hostOwnedIdentity: typeof sourceMetadata.hostOwnedIdentity === 'string'
            ? sourceMetadata.hostOwnedIdentity
            : null,
          distribution: sourceMetadata.distribution ?? {},
          managementEligibility: sourceMetadata.managementEligibility ?? null,
          componentConfigFiles: relocatedMetadata.componentConfigFiles,
          componentConfigRoots: relocatedMetadata.componentConfigRoots,
          resourceRoots: relocatedMetadata.resourceRoots,
          customInstallation: {
            kind: 'nonstandard_config_root',
            sourceInstallationId: source.id,
            sourceHostVariant: source.host_variant,
            sourceInstallKey: source.install_key,
            sourceSurfaceFingerprint,
            configFingerprint,
          },
        },
      }
      hostLabel = safeProductName(source.family, source.display_name)
      targetLabel = redactPath(canonicalRoot, this.homeDir) ?? path.basename(canonicalRoot)
      componentKeys = this.connectableComponentKeys(source.host_variant as CatalogId)
    } else {
      if (!this.dependencies.customMcpRuntime) {
        throw new Error('Custom MCP runtime is not available in this build')
      }
      const executablePath = canonicalCustomFile(input.clientExecutablePath, undefined)
      const userOwned = input.configurationOwnership === 'user'
      const configFilePath = userOwned ? '' : canonicalCustomFile(input.configFilePath, this.homeDir)
      const configExtension = path.extname(configFilePath).toLowerCase()
      if (!userOwned && configExtension !== '.json' && configExtension !== '.jsonc') {
        throw new Error('only an explicit JSON or JSONC configuration file is supported')
      }
      const configSnapshot = userOwned ? null : await readStableFileSnapshot(configFilePath, 1024 * 1024)
      const configSource = configSnapshot ? Buffer.from(configSnapshot.content).toString('utf8') : '{}'
      try {
        if (configExtension === '.jsonc') parseJsoncObject(configSource)
        else JSON.parse(configSource)
      } catch {
        throw new Error('the selected configuration file is not valid JSON or JSONC')
      }
      const executableSnapshot = await readStableFileFingerprint(
        executablePath,
        this.dependencies.cliManagementProofLimitBytes ?? MAX_CLI_EXECUTABLE_PROOF_BYTES,
      )
      if (!executableSnapshot.executable) throw new Error('the selected client file is not executable')
      configFingerprint = configSnapshot?.fingerprint ?? sha256Json('user_owned_no_file')
      executableFingerprint = executableSnapshot.fingerprint
      const selectorKey = normalizeSelectorKey(input.selectorKey)
      request = {
        mode: input.mode,
        displayName,
        ...(userOwned ? { configurationOwnership: 'user' as const } : {}),
        clientExecutablePath: executablePath,
        configFilePath,
        schemaKind: input.schemaKind,
        selectorKey,
      }
      const installKey = customInstallKey({
        mode: input.mode,
        executablePath,
        configFilePath,
        schemaKind: input.schemaKind,
        selectorKey,
      })
      const existing = this.dependencies.repository.getInstallationByInstallKey('local_macos', installKey)
      const legacyIdentity = input.legacyInstallationId
        ? this.requireLegacyCustomIdentity(input.legacyInstallationId)
        : null
      if (legacyIdentity && existing && existing.id !== legacyIdentity.id) {
        throw new Error('the selected Custom MCP surface is already bound to another Installation')
      }
      const agentId = legacyIdentity?.agent_id ?? existing?.agent_id ?? this.agentId()
      if (!agentId) throw new Error('the selected legacy Custom identity has no Agent identity')
      legacyIdentityBinding = legacyIdentity ? {
        installationId: legacyIdentity.id,
        agentId,
        installKey: legacyIdentity.install_key,
        metadataJson: legacyIdentity.metadata_json,
      } : null
      const surfaceFingerprint = sha256Json({
        executableFingerprint,
        configFingerprint,
        schemaKind: input.schemaKind,
        selectorKey,
      })
      draft = {
        id: legacyIdentity?.id ?? existing?.id ?? this.installationId(),
        family: 'custom-local-agent',
        hostVariant: 'custom-local-mcp',
        runtimeRealm: 'local_macos',
        // Bounded, reversible identity consumed by the restricted Custom
        // Adapter. Both enum and selectorKey are validated before this point;
        // no arbitrary command or path is encoded here.
        profileId: `${userOwned ? 'custom-guided' : 'custom-mcp'}:${input.schemaKind}:${selectorKey}`,
        installKey,
        distributionId: `custom-local-executable:${executableSnapshot.sha256.slice(0, 16)}`,
        provenance: 'user_selected_local_executable',
        osUserIdentity: 'local-user',
        displayName,
        configRoot: userOwned ? this.homeDir : path.dirname(configFilePath),
        executablePath,
        // Custom clients are never executed for `--version`. Bind runtime
        // evidence to the user-approved executable bytes instead.
        detectedVersion: `custom-${executableSnapshot.sha256.slice(0, 16)}`,
        versionDetectionMethod: 'user_selected_executable_fingerprint',
        agentId,
        supportedCapability: 2,
        lastDetectedAt: this.now().toISOString(),
        metadata: {
          discoverySchemaVersion: 1,
          explicitProfile: `${userOwned ? 'custom-guided' : 'custom-mcp'}:${input.schemaKind}:${selectorKey}`,
          hostOwnedIdentity: `custom-local:${executableSnapshot.fingerprint}`,
          distribution: {
            distributionId: `custom-local-executable:${executableSnapshot.sha256.slice(0, 16)}`,
            executableRealpath: executablePath,
            packageProvenance: 'user_selected_local_executable',
            capabilityFingerprint: `custom-local-surface:${surfaceFingerprint}`,
          },
          managementEligibility: {
            schemaVersion: 1,
            eligible: true,
            executableSizeBytes: executableSnapshot.size,
            proofLimitBytes: this.dependencies.cliManagementProofLimitBytes
              ?? MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
          componentConfigFiles: userOwned ? {} : { memory_tools: configFilePath },
          componentConfigRoots: {},
          resourceRoots: {},
          customInstallation: {
            kind: 'manual_mcp_client',
            ...(userOwned ? { configurationOwnership: 'user' } : {}),
            schemaKind: input.schemaKind,
            selectorKey,
            configFingerprint,
            executableFingerprint,
          },
        },
      }
      mcpConfiguration = customMcpConfiguration(
        input.schemaKind,
        selectorKey,
        agentId,
        this.dependencies.customMcpRuntime,
      )
      hostLabel = path.basename(executablePath)
      targetLabel = userOwned ? 'User-owned MCP import' : redactPath(configFilePath, this.homeDir) ?? path.basename(configFilePath)
      componentKeys = ['memory_tools']
    }

    const expiresAtMs = this.now().getTime() + PLAN_TTL_MS
    const hash = sha256Json({
      request,
      installationId: draft.id,
      agentId: draft.agentId,
      sourceSurfaceFingerprint,
      configFingerprint,
      executableFingerprint,
    })
    const preview: AgentIntegrationCustomPreflightDto = {
      preflightHash: hash,
      mode: request.mode,
      displayName,
      targetLabel,
      hostLabel,
      schemaKind: request.mode === 'manual_mcp_client' ? request.schemaKind : null,
      selectorKey: request.mode === 'manual_mcp_client' ? request.selectorKey : null,
      agentId: draft.agentId!,
      reusedLegacyInstallationId: legacyIdentityBinding?.installationId ?? null,
      componentKeys,
      warnings: request.mode === 'manual_mcp_client'
        ? ['custom_client_identity_user_selected', 'new_session_and_real_tool_call_required']
        : ['nonstandard_root_uses_selected_host_adapter'],
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    this.pruneCustomPreflights()
    this.customPreflights.set(hash, {
      hash,
      expiresAtMs,
      request,
      draft,
      preview,
      mcpConfiguration,
      sourceSurfaceFingerprint,
      configFingerprint,
      executableFingerprint,
      legacyIdentityBinding,
      installationPrepared: false,
    })
    return { ...preview, componentKeys: [...preview.componentKeys], warnings: [...preview.warnings] }
  }

  async prepareCustomConnect(
    preflightHash: string,
    includeTechnicalDetails = false,
  ): Promise<AgentIntegrationPlanPreviewDto> {
    const preflight = await this.requireFreshCustomPreflight(preflightHash)
    const discoveredDraft = { ...preflight.draft, lastDetectedAt: this.now().toISOString() }
    if (preflight.legacyIdentityBinding) {
      this.dependencies.repository.bindLegacyCustomInstallationSurface({
        expected: preflight.legacyIdentityBinding,
        draft: discoveredDraft,
        boundAt: this.now().toISOString(),
      })
    } else {
      this.dependencies.repository.upsertDiscoveredInstallation(discoveredDraft)
    }
    preflight.installationPrepared = true
    // A failed authorization preview deliberately leaves the row unmanaged,
    // making the attempted Custom identity auditable without granting consent
    // or writing the selected host configuration.
    const preview = await this.previewConnect([preflight.draft.id], includeTechnicalDetails)
    const guided = preview.installations.flatMap(item => item.requiredUserActionDetails ?? [])
      .find(action => action.kind === 'custom_mcp_import')
    if (guided?.kind === 'custom_mcp_import') preflight.mcpConfiguration = guided.configurationJson
    return preview
  }

  customMcpConfiguration(preflightHash: string): string {
    const preflight = this.requireCustomPreflight(preflightHash)
    if (!preflight.mcpConfiguration) {
      throw new Error('this Custom target does not have a generated MCP configuration')
    }
    if (!preflight.installationPrepared) {
      throw new Error('continue to authorization before copying the generated MCP configuration')
    }
    return preflight.mcpConfiguration
  }

  /**
   * Reconstructs the Codex lifecycle trust action from a fresh, read-only
   * coordinator preview. This never treats ordinary connect consent as host
   * trust and never records evidence merely because the user opened the UI.
   */
  async reviewCodexHookTrust(installationId: string): Promise<AgentIntegrationCodexTrustReviewDto> {
    this.requireInteractiveManagementEnabled()
    const row = this.requireCodexManagedInstallation(installationId)
    const installation = toCoordinatorInstallation(row)
    const prepared = await this.dependencies.execution.preview({
      installation,
      operation: 'connect',
      componentKeys: ['lifecycle'],
      desiredCapability: 4,
    })
    if (prepared.componentKeys.length !== 1 || prepared.componentKeys[0] !== 'lifecycle') {
      throw new Error('Codex lifecycle trust verification is unavailable for this Installation')
    }
    if (prepared.executionPlan.mutations.length > 0) {
      throw new Error('Codex lifecycle configuration changed; repair it before checking host trust')
    }
    const actions = (prepared.adapterPlan.requiredUserActionDetails ?? [])
      .filter((action): action is CodexHookTrustRequiredUserAction => action.kind === 'codex_hook_trust')
    if (actions.length === 0) {
      if (prepared.adapterPlan.requiredUserActions.some(action => action.includes('codex_hook_trust_'))) {
        throw new Error('Codex could not provide an exact /hooks trust state; check the host and try again')
      }
      return {
        installationId,
        status: 'already_recorded',
        actionHash: null,
        instruction: null,
        sourceLabel: null,
        hookKeyHash: null,
        ownedFragmentHash: null,
        hostCurrentHash: null,
        expiresAt: null,
      }
    }
    if (actions.length !== 1) throw new Error('Codex returned multiple lifecycle trust actions')
    const action = actions[0]
    this.assertCodexTrustActionBinding(row, action)
    const artifactId = this.requireCodexTrustArtifact(row, action)
    const installationSurfaceFingerprint = persistedProjectionSurfaceFingerprint(row)
    const liveTrustProofFingerprint = frozenPlanLiveTrustProofFingerprint(prepared)
    if (!liveTrustProofFingerprint) {
      throw new Error('Codex live distribution trust could not be frozen')
    }
    const expiresAtMs = this.now().getTime() + PLAN_TTL_MS
    const hash = sha256Json({
      installationSurfaceFingerprint,
      liveTrustProofFingerprint,
      artifactId,
      action,
    })
    this.pruneCodexTrustActions()
    this.codexTrustActions.set(hash, {
      hash,
      expiresAtMs,
      installation,
      installationSurfaceFingerprint,
      liveTrustProofFingerprint,
      hostVersion: row.detected_version!,
      artifactId,
      action,
    })
    return {
      installationId,
      status: 'action_required',
      actionHash: hash,
      instruction: action.instruction,
      sourceLabel: redactPath(action.sourcePath, this.homeDir),
      hookKeyHash: action.hookKeyHash,
      ownedFragmentHash: action.ownedFragmentHash,
      hostCurrentHash: action.hostCurrentHash,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  /**
   * Records host trust only after Codex's official persisted hook/trust state proves
   * the exact frozen action is now trusted. The repository independently
   * re-binds the receipt to the current healthy lifecycle Artifact.
   */
  async confirmCodexHookTrust(actionHash: string): Promise<AgentIntegrationCodexTrustResultDto> {
    const inFlight = this.codexTrustConfirmations.get(actionHash)
    if (inFlight) return inFlight
    const confirmation = this.confirmCodexHookTrustOnce(actionHash)
    this.codexTrustConfirmations.set(actionHash, confirmation)
    try {
      return await confirmation
    } finally {
      if (this.codexTrustConfirmations.get(actionHash) === confirmation) {
        this.codexTrustConfirmations.delete(actionHash)
      }
    }
  }

  private async confirmCodexHookTrustOnce(actionHash: string): Promise<AgentIntegrationCodexTrustResultDto> {
    this.requireInteractiveManagementEnabled()
    const cached = this.requireCodexTrustAction(actionHash)
    const row = this.requireCodexManagedInstallation(cached.installation.id)
    if (persistedProjectionSurfaceFingerprint(row) !== cached.installationSurfaceFingerprint
      || sha256Json(toCoordinatorInstallation(row)) !== sha256Json(cached.installation)) {
      throw new Error('Codex Installation identity changed; check trust again')
    }
    if (this.dependencies.attestInstallation
      && !await this.dependencies.attestInstallation(row, cached.liveTrustProofFingerprint)) {
      throw new Error('Codex distribution trust changed; check trust again')
    }
    this.assertCodexTrustActionBinding(row, cached.action)
    if (this.requireCodexTrustArtifact(row, cached.action) !== cached.artifactId) {
      throw new Error('Codex lifecycle ownership changed; check trust again')
    }
    const verified = await this.dependencies.verifyCodexHookTrust?.({
      installation: cached.installation,
      hostVersion: cached.hostVersion,
      action: cached.action,
      liveTrustProofFingerprint: cached.liveTrustProofFingerprint,
    })
    if (!verified) {
      return {
        installationId: row.id,
        status: 'not_trusted',
        receiptId: null,
        hostCurrentHash: cached.action.hostCurrentHash,
      }
    }
    if (verified.sourcePath !== cached.action.sourcePath
      || verified.hookKey !== cached.action.hookKey
      || verified.hostCurrentHash !== cached.action.hostCurrentHash) {
      throw new Error('Codex /hooks state changed after review; check trust again')
    }
    if (this.dependencies.attestInstallation
      && !await this.dependencies.attestInstallation(row, cached.liveTrustProofFingerprint)) {
      throw new Error('Codex distribution trust changed before receipt; check trust again')
    }
    const receiptVerification = await this.dependencies.verifyCodexHookTrust?.({
      installation: cached.installation,
      hostVersion: cached.hostVersion,
      action: cached.action,
      liveTrustProofFingerprint: cached.liveTrustProofFingerprint,
    })
    if (!receiptVerification
      || receiptVerification.sourcePath !== cached.action.sourcePath
      || receiptVerification.hookKey !== cached.action.hookKey
      || receiptVerification.hostCurrentHash !== cached.action.hostCurrentHash) {
      throw new Error('Codex hook trust state changed before receipt; check trust again')
    }
    if (this.codexTrustActions.get(actionHash) !== cached
      || cached.expiresAtMs <= this.now().getTime()) {
      throw new Error('Codex trust review changed or expired before receipt; check again')
    }
    const receiptId = this.dependencies.repository.recordCodexHookTrustEvidence({
      installationId: row.id,
      artifactId: cached.artifactId,
      agentId: cached.action.agentId,
      hostVariant: cached.action.hostVariant,
      sourcePath: receiptVerification.sourcePath,
      hookKey: receiptVerification.hookKey,
      ownedFragmentHash: cached.action.ownedFragmentHash,
      hostCurrentHash: receiptVerification.hostCurrentHash,
      hooksFileFingerprint: receiptVerification.hooksFileFingerprint,
      trustConfigFingerprint: receiptVerification.trustConfigFingerprint,
      tideMindVersion: cached.action.tideMindVersion,
      adapterVersion: cached.action.adapterVersion,
      projectionVersion: cached.action.projectionVersion,
      hostVersion: cached.action.hostVersion,
      verifiedAt: this.now().toISOString(),
    })
    this.codexTrustActions.delete(actionHash)
    try {
      await this.dependencies.afterCodexHookTrust?.()
    } catch (error) {
      try {
        this.dependencies.repository.recordEvent({
          installationId: row.id,
          componentKey: 'lifecycle',
          artifactId: cached.artifactId,
          kind: 'post_codex_trust_maintenance_failed',
          severity: 'error',
          dedupeKey: `post_codex_trust_maintenance_failed:${receiptId}`,
          payload: { message: safeErrorMessage(error), receiptId },
          createdAt: this.now().toISOString(),
        })
      } catch (auditError) {
        // The receipt is already durable. A secondary audit write must never
        // turn that true result into a false confirmation failure.
        console.error('[agent-integration] failed to persist post-Codex-trust maintenance diagnostic', {
          receiptId,
          error: safeErrorMessage(auditError),
        })
      }
    }
    return {
      installationId: row.id,
      status: 'trust_recorded',
      receiptId,
      hostCurrentHash: receiptVerification.hostCurrentHash,
    }
  }

  reviewGuidedRemoval(installationId: string): AgentIntegrationGuidedRemovalReviewDto {
    this.requireInteractiveManagementEnabled()
    const row = this.dependencies.repository.getInstallation(installationId)
    if (!row || (row.host_variant !== 'qwenwork-desktop'
      && !(row.host_variant === 'custom-local-mcp' && row.profile_id.startsWith('custom-guided:')))
      || row.desired_state !== 'removed') {
      throw new Error('QwenWork guided removal is not pending')
    }
    if (!row.config_root) throw new Error('QwenWork guided removal config root is unavailable')
    const pending = this.dependencies.repository.getPendingGuidedRemovalAction(installationId)
    if (!pending) throw new Error('QwenWork guided removal action is unavailable')
    const installationSurfaceFingerprint = persistedProjectionSurfaceFingerprint(row)
    const expiresAtMs = this.now().getTime() + PLAN_TTL_MS
    const hash = sha256Json({
      installationId,
      installationSurfaceFingerprint,
      runId: pending.runId,
      activityGenerationToken: pending.activityGenerationToken,
      connectorName: pending.connectorAction.connectorName,
      configRoot: row.config_root,
      physicalTarget: pending.fileAction?.physicalTarget ?? null,
      ownedFragmentHash: pending.fileAction?.ownedFragmentHash ?? null,
    })
    this.guidedRemovalActions.clear()
    this.guidedRemovalActions.set(hash, {
      hash,
      expiresAtMs,
      installationId,
      installationSurfaceFingerprint,
      ...pending,
    })
    return {
      installationId,
      status: 'action_required',
      actionHash: hash,
      runId: pending.runId,
      connectorName: pending.connectorAction.connectorName,
      instruction: pending.connectorAction.instruction,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  async confirmGuidedRemoval(actionHash: string): Promise<AgentIntegrationGuidedRemovalResultDto> {
    const inFlight = this.guidedRemovalConfirmations.get(actionHash)
    if (inFlight) return inFlight
    const confirmation = this.confirmGuidedRemovalOnce(actionHash)
    this.guidedRemovalConfirmations.set(actionHash, confirmation)
    try {
      return await confirmation
    } finally {
      if (this.guidedRemovalConfirmations.get(actionHash) === confirmation) {
        this.guidedRemovalConfirmations.delete(actionHash)
      }
    }
  }

  private async confirmGuidedRemovalOnce(actionHash: string): Promise<AgentIntegrationGuidedRemovalResultDto> {
    this.requireInteractiveManagementEnabled()
    const cached = this.guidedRemovalActions.get(actionHash)
    if (!cached || cached.expiresAtMs <= this.now().getTime()) {
      this.guidedRemovalActions.delete(actionHash)
      throw new Error('guided removal review is unknown or has expired')
    }
    const row = this.dependencies.repository.getInstallation(cached.installationId)
    const pending = this.dependencies.repository.getPendingGuidedRemovalAction(cached.installationId)
    if (!row || row.desired_state !== 'removed'
      || !row.config_root
      || persistedProjectionSurfaceFingerprint(row) !== cached.installationSurfaceFingerprint
      || !pending
      || pending.runId !== cached.runId
      || pending.activityGenerationToken !== cached.activityGenerationToken
      || sha256Json(pending.connectorAction) !== sha256Json(cached.connectorAction)
      || sha256Json(pending.fileAction) !== sha256Json(cached.fileAction)) {
      throw new Error('guided removal action changed; review again')
    }
    if (cached.fileAction) {
      const root = fs.realpathSync(row.config_root)
      const target = path.resolve(cached.fileAction.physicalTarget)
      const relative = path.relative(root, target)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('guided removal target is outside the frozen config root')
      }
      try {
        fs.lstatSync(target)
        return { installationId: row.id, runId: cached.runId, status: 'not_ready', receiptId: null }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const receiptId = this.dependencies.repository.recordGuidedRemovalEvidence({
      installationId: row.id,
      agentId: cached.connectorAction.agentId,
      hostVariant: cached.connectorAction.hostVariant,
      componentKey: 'memory_tools',
      activationRunId: cached.runId,
      activityGenerationToken: cached.activityGenerationToken,
      connectorName: cached.connectorAction.connectorName,
      confirmedAt: this.now().toISOString(),
    })
    this.guidedRemovalActions.delete(actionHash)
    await this.dependencies.afterGuidedRemoval?.()
    return { installationId: row.id, runId: cached.runId, status: 'removal_confirmed', receiptId }
  }

  async previewConnect(
    installationIds: readonly string[],
    includeTechnicalDetails = false,
    frozenPlanHash?: string,
    options: AgentIntegrationConnectOptionsDto = {},
  ): Promise<AgentIntegrationPlanPreviewDto> {
    if (frozenPlanHash !== undefined) {
      if (!includeTechnicalDetails) throw new Error('a frozen plan may only be reopened for technical details')
      const bundle = this.requirePlan(frozenPlanHash, 'connect', installationIds)
      return this.planBundleDto(bundle, true)
    }
    const disabledLifecycle = uniqueIds(options.withoutLifecycleInstallationIds ?? [])
    if (disabledLifecycle.some(id => !installationIds.includes(id))) {
      throw new Error('lifecycle exclusions must be a subset of the selected Installations')
    }
    return this.preview('connect', installationIds, includeTechnicalDetails, new Set(disabledLifecycle))
  }

  async applyConnect(planHash: string, installationIds: readonly string[]): Promise<AgentIntegrationApplyResultDto> {
    const bundle = this.requirePlan(planHash, 'connect', installationIds)
    return this.apply(bundle)
  }

  startApplyConnect(planHash: string, installationIds: readonly string[]): AgentIntegrationApplyTaskDto {
    const bundle = this.requirePlan(planHash, 'connect', installationIds)
    const startedAt = this.now().toISOString()
    const task: AgentIntegrationApplyTaskDto = {
      id: `agent_apply_${randomUUID()}`,
      planHash,
      installationIds: [...bundle.installationIds],
      pendingInstallationIds: [...bundle.installationIds],
      results: [],
      state: 'running',
      startedAt,
      completedAt: null,
    }
    const executionHashes = new Map(bundle.items.map(item => [
      item.installation.id,
      item.prepared.executionPlanHash,
    ]))
    this.dependencies.repository.createApplyTask({
      id: task.id,
      planHash,
      startedAt,
      items: task.installationIds.map(installationId => ({
        installationId,
        executionPlanHash: executionHashes.get(installationId)!,
      })),
    })
    this.applyTasks.set(task.id, task)
    this.emitApplyTask(task)
    void this.apply(bundle, result => {
      this.dependencies.repository.completeApplyTaskItem(
        task.id,
        result.installationId,
        result,
        this.now().toISOString(),
      )
      task.results = [...task.results, result]
      task.pendingInstallationIds = task.pendingInstallationIds.filter(id => id !== result.installationId)
      this.emitApplyTask(task)
    }, installationId => {
      this.dependencies.repository.markApplyTaskItemRunning(
        task.id,
        installationId,
        this.now().toISOString(),
      )
    }, task.id).catch(error => {
      for (const installationId of task.pendingInstallationIds) {
        const result = { installationId, status: 'failed' as const, reason: safeErrorMessage(error) }
        try {
          this.dependencies.repository.completeApplyTaskItem(
            task.id,
            installationId,
            result,
            this.now().toISOString(),
          )
        } catch { /* a replaced main process owns the durable task now */ }
        task.results.push(result)
      }
      task.pendingInstallationIds = []
    }).finally(() => {
      task.state = 'completed'
      task.completedAt = this.now().toISOString()
      try { this.dependencies.repository.completeApplyTask(task.id, task.completedAt) } catch {
        // Startup recovery will mark any item whose terminal write was lost as
        // interrupted; never manufacture a completed durable task here.
      }
      this.emitApplyTask(task)
      this.pruneApplyTasks()
    })
    return cloneApplyTask(task)
  }

  getApplyTask(taskId: string): AgentIntegrationApplyTaskDto {
    if (taskId.startsWith('run:')) {
      const runId = taskId.slice('run:'.length)
      const run = this.dependencies.repository.getApplyTaskFeedRun(runId, this.now().getTime())
      if (run) return { ...recoveredApplyTask(run, this.homeDir), feedKey: `run:${runId}` }
      throw new Error('unknown Agent integration task')
    }
    const durableId = taskId.startsWith('task:') ? taskId.slice('task:'.length) : taskId
    const durable = this.dependencies.repository.getApplyTaskFeedTask(durableId)
    if (durable) {
      let task = durableApplyTask(durable.task, this.homeDir)
      for (const run of durable.overlayRuns) task = overlayRecoveredRun(task, run, this.homeDir)
      return { ...task, feedKey: `task:${durableId}` }
    }
    const live = this.applyTasks.get(durableId)
    if (live) return { ...cloneApplyTask(live), feedKey: `task:${durableId}` }
    // Compatibility for process-recovered run IDs persisted by older renderer
    // sessions. New callers use the discriminated `run:` feed key, but the
    // exact lookup still revalidates global authority before returning it.
    const recovered = this.dependencies.repository.getApplyTaskFeedRun(durableId, this.now().getTime())
    if (recovered) return { ...recoveredApplyTask(recovered, this.homeDir), feedKey: `run:${durableId}` }
    throw new Error('unknown Agent integration task')
  }

  /**
   * Enumerates live service tasks and reconstructs recent process-lost tasks
   * from the durable coordinator ledger. A run that was already created by an
   * interrupted batch is folded back into that exact durable item; only truly
   * unbound historical runs are presented as one-Installation summaries.
   */
  listApplyTasks(request: AgentIntegrationApplyTaskPageRequestDto = {}): AgentIntegrationApplyTaskPageDto {
    const page = this.dependencies.repository.listApplyTaskFeedPage({
      limit: request.limit ?? 20,
      cursor: request.cursor,
      nowMs: this.now().getTime(),
    })
    const tasks = page.entries.map(entry => {
      if ('run' in entry) return { ...recoveredApplyTask(entry.run, this.homeDir), feedKey: entry.key }
      let task = durableApplyTask(entry.task, this.homeDir)
      for (const run of entry.overlayRuns) task = overlayRecoveredRun(task, run, this.homeDir)
      return { ...task, feedKey: entry.key }
    })
    return {
      tasks,
      attentionCount: page.attentionCount,
      activeCount: page.activeCount,
      totalCount: page.totalCount,
      startIndex: page.startIndex,
      hasMore: page.hasMore,
      hasPrevious: page.hasPrevious,
      nextCursor: page.nextCursor,
      previousCursor: page.previousCursor,
    }
  }

  onApplyTaskProgress(listener: (task: AgentIntegrationApplyTaskDto) => void): () => void {
    this.applyTaskListeners.add(listener)
    return () => this.applyTaskListeners.delete(listener)
  }

  inbox(limit = 20): AgentIntegrationInboxDto {
    const unread = this.dependencies.repository.listEvents({ state: 'unread', limit: Math.max(limit, 1_000) })
    const startup = unread.filter(isStartupSurfaceEvent)
    return {
      unreadCount: unread.length,
      actionableUnreadCount: unread.filter(isActionableInboxEvent).length,
      startupUnreadCount: startup.length,
      events: unread.slice(0, limit).map(toEventDto),
      startupEvents: startup.slice(0, limit).map(toEventDto),
    }
  }

  componentTargetPath(installationId: string, componentKey: ComponentKey): string {
    this.requireInstallation(installationId)
    const component = this.dependencies.repository.listInstallationComponentDetails(installationId)
      .find(item => item.component_key === componentKey)
    const raw = typeof component?.target_path === 'string' ? path.resolve(component.target_path) : null
    if (!raw || !fs.existsSync(raw)) throw new Error('managed component path is not currently available')
    const canonical = fs.realpathSync(raw)
    const relative = path.relative(this.homeDir, canonical)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('managed component path is outside the current user domain')
    }
    return canonical
  }

  async previewDisconnect(
    installationId: string,
    includeTechnicalDetails = false,
  ): Promise<AgentIntegrationPlanPreviewDto> {
    return this.preview('disconnect', [installationId], includeTechnicalDetails)
  }

  async disconnect(planHash: string, installationId: string): Promise<AgentIntegrationApplyResultDto> {
    const bundle = this.requirePlan(planHash, 'disconnect', [installationId])
    const result = await this.apply(bundle)
    if (result.results.some(item => item.status !== 'failed')) {
      try {
        await this.dependencies.afterDisconnect?.()
      } catch (error) {
        // The disconnect is already durable. Preserve its truthful result and
        // leave a durable retry diagnostic instead of reporting a false
        // operation failure after the physical/ledger commit.
        this.dependencies.repository.recordEvent({
          installationId,
          kind: 'post_disconnect_maintenance_failed',
          severity: 'error',
          dedupeKey: `post_disconnect_maintenance_failed:${installationId}`,
          payload: { message: safeErrorMessage(error) },
          createdAt: this.now().toISOString(),
        })
      }
    }
    return result
  }

  pause(installationId: string): AgentIntegrationInstallationDto {
    const row = this.requireInstallation(installationId)
    if (row.desired_state !== 'managed') throw new Error('only a managed Installation can be paused')
    this.dependencies.repository.setInstallationIntent(installationId, 'disabled', this.now().toISOString())
    return this.toInstallationDto(this.requireInstallation(installationId))
  }

  async resume(installationId: string): Promise<AgentIntegrationInstallationDto> {
    const row = this.requireInstallation(installationId)
    if (row.desired_state !== 'disabled') throw new Error('only a paused Installation can resume management')
    this.dependencies.repository.setInstallationIntent(installationId, 'managed', this.now().toISOString())
    try {
      await this.dependencies.afterResume?.()
    } catch (error) {
      this.dependencies.repository.recordEvent({
        installationId,
        kind: 'post_resume_scan_failed',
        severity: 'error',
        dedupeKey: `post_resume_scan_failed:${installationId}`,
        payload: { message: safeErrorMessage(error) },
        createdAt: this.now().toISOString(),
      })
    }
    return this.toInstallationDto(this.requireInstallation(installationId))
  }

  detail(installationId: string, includeTechnicalDetails = false): AgentIntegrationDetailDto {
    const row = this.requireInstallation(installationId)
    const latestActionRun = this.dependencies.repository.getLatestRunUserActions(installationId)
    const latestRun = includeTechnicalDetails
      ? this.dependencies.repository.getLatestRunTechnical(installationId)
      : undefined
    const componentDetails = includeTechnicalDetails
      ? this.dependencies.repository.listInstallationComponentDetails(installationId)
      : []
    return {
      installation: this.toInstallationDto(row),
      configRootLabel: redactPath(row.config_root, this.homeDir),
      events: this.listEvents(installationId, undefined, 20),
      requiredUserActionDetails: (latestActionRun?.operation_type === 'connect'
        || latestActionRun?.operation_type === 'disconnect')
        && latestActionRun.state === 'applied_unverified'
        ? requiredUserActionsFromPreparedPlanJson(latestActionRun.prepared_plan_json, this.homeDir)
        : [],
      ...(includeTechnicalDetails ? {
        technical: {
          agentId: row.agent_id,
          // install_key embeds the canonical config root. Renderer diagnostics
          // get an opaque, stable fingerprint instead of a user path.
          installKey: `installation:${createHash('sha256').update(row.install_key).digest('hex').slice(0, 16)}`,
          distributionId: row.distribution_id,
          reconcileState: row.reconcile_state,
          latestRun: latestRun ? {
            planHash: String(latestRun.execution_plan_hash),
            state: String(latestRun.state),
            adapterVersion: String(latestRun.adapter_version),
            catalogVersion: String(latestRun.catalog_version),
            projectionVersion: String(latestRun.projection_version),
            selectorSchemaVersion: String(latestRun.selector_schema_version),
          } : null,
          components: componentDetails.map(component => ({
            componentKey: component.component_key as ComponentKey,
            targetLabel: redactPath(typeof component.target_path === 'string' ? component.target_path : null, this.homeDir),
            ownershipSelector: typeof component.ownership_key === 'string' ? component.ownership_key : null,
            projectionVersion: typeof component.projection_version === 'string' ? component.projection_version : null,
            selectorSchemaVersion: component.selector_schema_version === null || component.selector_schema_version === undefined
              ? null : String(component.selector_schema_version),
            artifactState: typeof component.artifact_state === 'string' ? component.artifact_state : null,
            ownedHash: typeof component.owned_fragment_hash === 'string' ? component.owned_fragment_hash : null,
            observedHash: typeof component.observed_fragment_hash === 'string' ? component.observed_fragment_hash : null,
            lastAppliedAt: typeof component.last_applied_at === 'string' ? component.last_applied_at : null,
            lastReadAt: typeof component.artifact_last_verified_at === 'string'
              ? component.artifact_last_verified_at : null,
          })),
        },
      } : {}),
    }
  }

  listEvents(
    installationId: string,
    state?: 'unread' | 'read' | 'archived',
    limit = 100,
  ): AgentIntegrationEventDto[] {
    this.requireInstallation(installationId)
    return this.dependencies.repository.listInstallationEvents(installationId, { state, limit }).map(toEventDto)
  }

  markEventRead(eventId: string): boolean {
    return this.dependencies.repository.markEventRead(eventId, this.now().toISOString())
  }

  markInstallationEventsRead(installationId: string): number {
    this.requireInstallation(installationId)
    return this.dependencies.repository.markInstallationEventsRead(
      installationId,
      this.now().toISOString(),
    )
  }

  previewResetAutoRestore(installationId: string): AgentIntegrationCircuitResetPreviewDto {
    const row = this.requireInstallation(installationId)
    if (row.desired_state !== 'managed' || row.status_reason !== 'circuit_breaker') {
      throw new Error(`Installation has no resettable auto-repair circuit: ${installationId}`)
    }
    const scope = this.dependencies.repository.listResettableArtifactCircuitScope(installationId)
    if (scope.length === 0) throw new Error(`Installation has no resettable auto-repair artifact: ${installationId}`)
    const artifactIds = [...new Set(scope.map(item => item.artifactId))].sort()
    const affected = new Map<string, {
      displayName: string
      variantLabel: string
      profileLabel: string | null
      componentKeys: Set<ComponentKey>
    }>()
    for (const item of scope) {
      const current = affected.get(item.installationId) ?? {
        displayName: item.displayName,
        variantLabel: getCatalogVariant(item.hostVariant).displayName,
        profileLabel: item.profileId || null,
        componentKeys: new Set<ComponentKey>(),
      }
      if (COMPONENT_KEYS.includes(item.componentKey as ComponentKey)) {
        current.componentKeys.add(item.componentKey as ComponentKey)
      }
      affected.set(item.installationId, current)
    }
    const affectedInstallations = [...affected]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([affectedInstallationId, item]) => ({
        installationId: affectedInstallationId,
        displayName: item.displayName,
        variantLabel: item.variantLabel,
        profileLabel: item.profileLabel,
        componentKeys: [...item.componentKeys].sort(),
      }))
    const scopeFingerprint = sha256Json({ installationId, artifactIds, affectedInstallations })
    const planHash = sha256Json({ operation: 'reset_auto_restore', scopeFingerprint })
    const expiresAtMs = this.now().getTime() + PLAN_TTL_MS
    const preview: AgentIntegrationCircuitResetPreviewDto = {
      planHash,
      initiatingInstallationId: installationId,
      artifactCount: artifactIds.length,
      hasSharedArtifacts: artifactIds.some(artifactId => (
        scope.filter(item => item.artifactId === artifactId).length > 1
      )),
      affectedInstallations,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    this.circuitResetPlans.set(planHash, {
      hash: planHash,
      installationId,
      artifactIds,
      scope,
      scopeFingerprint,
      preview,
      expiresAtMs,
    })
    return preview
  }

  async resetAutoRestore(planHash: string, installationId: string): Promise<AgentIntegrationInstallationDto> {
    const row = this.requireInstallation(installationId)
    if (row.desired_state !== 'managed' || row.status_reason !== 'circuit_breaker') {
      throw new Error(`Installation has no resettable auto-repair circuit: ${installationId}`)
    }
    const plan = this.circuitResetPlans.get(planHash)
    if (!plan || plan.installationId !== installationId || plan.expiresAtMs < this.now().getTime()) {
      throw new Error('auto-repair reset confirmation is missing or expired')
    }
    const currentScope = this.dependencies.repository.listResettableArtifactCircuitScope(installationId)
    const currentArtifactIds = [...new Set(currentScope.map(item => item.artifactId))].sort()
    const currentAffected = new Map<string, {
      displayName: string
      variantLabel: string
      profileLabel: string | null
      componentKeys: Set<ComponentKey>
    }>()
    for (const item of currentScope) {
      const current = currentAffected.get(item.installationId) ?? {
        displayName: item.displayName,
        variantLabel: getCatalogVariant(item.hostVariant).displayName,
        profileLabel: item.profileId || null,
        componentKeys: new Set<ComponentKey>(),
      }
      if (COMPONENT_KEYS.includes(item.componentKey as ComponentKey)) {
        current.componentKeys.add(item.componentKey as ComponentKey)
      }
      currentAffected.set(item.installationId, current)
    }
    const currentAffectedInstallations = [...currentAffected]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([affectedInstallationId, item]) => ({
        installationId: affectedInstallationId,
        displayName: item.displayName,
        variantLabel: item.variantLabel,
        profileLabel: item.profileLabel,
        componentKeys: [...item.componentKeys].sort(),
      }))
    const currentFingerprint = sha256Json({
      installationId,
      artifactIds: currentArtifactIds,
      affectedInstallations: currentAffectedInstallations,
    })
    if (currentFingerprint !== plan.scopeFingerprint) {
      throw new Error('auto-repair reset scope changed after confirmation')
    }
    const resetCount = this.dependencies.repository.resetInstallationArtifactCircuits(
      installationId,
      this.now().toISOString(),
      plan.scope,
    )
    if (resetCount === 0) throw new Error(`Installation has no resettable auto-repair artifact: ${installationId}`)
    this.circuitResetPlans.delete(planHash)
    await this.dependencies.afterCircuitReset?.()
    return this.toInstallationDto(this.requireInstallation(installationId))
  }

  supportCatalog(): AgentIntegrationSupportProductDto[] {
    const supportedIds = new Set<CatalogId>(P0_DISCOVERY_CATALOG_IDS)
    return AGENT_CATALOG.products.map(product => {
      const variants = product.variantIds.filter(id => supportedIds.has(id)).map(id => {
        const variant = getCatalogVariant(id)
        const implemented = this.implementedComponents?.get(id)
        const adapterEnabled = this.enabledCatalogIds?.has(id) ?? true
        const releaseEntry = this.releaseEntries?.get(id)
        // The support catalog describes what this exact build may deliver, not
        // merely what projector code happens to be bundled. A production entry
        // without an accepted exact version remains detect-only until the
        // release contract is frozen.
        const releaseAccepted = this.releaseEntries === null || Boolean(
          releaseEntry
          && releaseEntry.releaseMode === 'production'
          && releaseEntry.disposition !== 'observe_only'
          && releaseEntry.disposition !== 'migration'
          && releaseEntry.releaseAcceptedExactVersions.length > 0,
        )
        const deliverable = adapterEnabled && implemented && implemented.size > 0 && releaseAccepted
        const maturity = deliverable
          ? releaseEntry?.disposition === 'guided'
            ? 'guided' as const
            : 'managed' as const
          : 'detectable' as const
        const implementedCapability = implemented
          ? capabilityForComponents([...implemented])
          : 0
        const releasedCapability = releaseEntry?.targetCapability ?? implementedCapability
        return {
          id,
          displayName: variant.displayName,
          hostKind: variant.hostKind,
          maturity,
          // A Catalog ceiling is not a shipped capability. Detect-only hosts
          // must not advertise a connection level until their Adapter gate is open.
          maximumAccessLevel: deliverable
            ? accessLevelFor(Math.min(implementedCapability, releasedCapability) as CapabilityLevel)
            : 'unconnected',
        }
      })
      return { id: product.id, displayName: product.displayName, variants }
    }).filter(product => product.variants.length > 0)
  }

  async previewClaudeCoworkSetup(): Promise<AgentIntegrationClaudeCoworkPreflightDto> {
    this.requireInteractiveManagementEnabled()
    if (!this.enabledCatalogIds?.has('claude-cowork-local') && this.enabledCatalogIds !== null) {
      throw new Error('Claude Cowork guided setup is not enabled in this release')
    }
    if (!this.dependencies.scanner.previewGuidedInstallation) {
      throw new Error('Claude Cowork guided discovery is unavailable')
    }
    const runtime = this.dependencies.coworkGuidedRuntime
    if (!runtime || !path.isAbsolute(runtime.applicationDataDir)) {
      throw new Error('Claude Cowork plugin export runtime is unavailable')
    }
    const candidate = await this.dependencies.scanner.previewGuidedInstallation('claude-cowork-local')
    if (!candidate || candidate.catalogId !== 'claude-cowork-local') {
      throw new Error('A signed Claude app with Cowork support was not found')
    }
    const surface = candidate.identity.distribution.capabilityFingerprint
    if (!surface?.startsWith('desktop-bundle-surface-v1:')
      || candidate.identity.distribution.packageProvenance
        !== 'signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW'
      || !candidate.detectedVersion) {
      throw new Error('The Claude app identity or version could not be verified')
    }
    const existing = this.dependencies.repository.listInstallations({ includeRemoved: true })
      .filter(row => row.host_variant === 'claude-cowork-local'
        && row.runtime_realm === 'local_macos'
        && row.app_path === candidate.appPath
        && row.tombstoned_at === null)
    if (existing.length > 1) throw new Error('Multiple Claude Cowork guided Installations require review')
    const installationId = existing[0]?.id ?? this.installationId()
    const agentId = existing[0]?.agent_id ?? this.agentId()
    if (!agentId) throw new Error('Claude Cowork Agent identity is unavailable')
    const exportRoot = path.join(
      path.resolve(runtime.applicationDataDir),
      'agent-integration',
      'claude-cowork',
      installationId,
    )
    const pluginTarget = path.join(exportRoot, 'tidemind-cowork.plugin')
    const identity = canonicalizeInstallationIdentity({
      runtimeRealm: candidate.identity.runtimeRealm,
      osUserIdentity: candidate.identity.osUserIdentity,
      productFamilyId: candidate.identity.productFamilyId,
      hostVariant: candidate.identity.hostVariant,
      configRoot: candidate.identity.canonicalConfigRoot,
      distribution: candidate.identity.distribution,
      explicitProfile: 'cowork-user-guided',
      componentConfigRoots: { instruction: exportRoot, memory_tools: exportRoot },
      componentConfigFiles: { instruction: pluginTarget, memory_tools: pluginTarget },
    })
    const guided: DiscoveredInstallation = {
      ...candidate,
      identity,
      configRoot: identity.canonicalConfigRoot,
      componentConfigRoots: identity.componentConfigRoots,
      componentConfigFiles: identity.componentConfigFiles,
    }
    const draftBase = toDiscoverInstallationInput(guided, {
      id: installationId,
      lastDetectedAt: this.now().toISOString(),
    })
    const metadata = draftBase.metadata as Record<string, JsonValue>
    const draft: DiscoverInstallationInput = {
      ...draftBase,
      agentId,
      provenance: `${draftBase.provenance}\nuser_guided_cowork_preflight`,
      supportedCapability: 3,
      metadata: {
        ...metadata,
        guidedInstallation: {
          kind: 'claude_cowork_plugin_upload',
          state: 'user_started_unverified',
          hostLoaded: false,
        },
      },
    }
    const expiresAtMs = this.now().getTime() + PLAN_TTL_MS
    const hash = sha256Json({
      catalogId: 'claude-cowork-local',
      installationId,
      agentId,
      installKey: identity.installKey,
      surface,
      pluginTarget,
      expiresAtMs,
    })
    const preview: AgentIntegrationClaudeCoworkPreflightDto = {
      preflightHash: hash,
      displayName: 'Claude Cowork',
      appLabel: redactPath(candidate.appPath ?? null, this.homeDir) ?? 'Claude.app',
      hostVersion: candidate.detectedVersion,
      componentKeys: ['instruction', 'memory_tools'],
      warnings: [
        'This creates a user-guided setup record; it does not prove that Cowork has loaded the plugin.',
        'Tide Mind will export a .plugin file in its own data directory and will not modify Claude Desktop configuration.',
        'Only a fresh brain_* call from the exact Agent identity can complete basic integration verification.',
      ],
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    this.pruneCoworkPreflights()
    this.coworkPreflights.set(hash, { hash, expiresAtMs, draft, sourceSurfaceFingerprint: surface, preview })
    return { ...preview, componentKeys: [...preview.componentKeys], warnings: [...preview.warnings] }
  }

  async prepareClaudeCoworkSetup(preflightHash: string): Promise<AgentIntegrationClaudeCoworkPreparedDto> {
    const preflight = this.coworkPreflights.get(preflightHash)
    if (!preflight || preflight.expiresAtMs <= this.now().getTime()) {
      this.coworkPreflights.delete(preflightHash)
      throw new Error('Claude Cowork setup preview is missing or expired')
    }
    const current = await this.dependencies.scanner.previewGuidedInstallation?.('claude-cowork-local')
    if (!current
      || current.identity.distribution.capabilityFingerprint !== preflight.sourceSurfaceFingerprint
      || current.appPath !== preflight.draft.appPath
      || current.detectedVersion !== preflight.draft.detectedVersion) {
      this.coworkPreflights.delete(preflightHash)
      throw new Error('Claude changed after preview; review the Cowork setup again')
    }
    const persisted = this.dependencies.repository.upsertDiscoveredInstallation({
      ...preflight.draft,
      lastDetectedAt: this.now().toISOString(),
    })
    this.coworkPreflights.delete(preflightHash)
    return { installationId: persisted.id }
  }

  private pruneCoworkPreflights(): void {
    const now = this.now().getTime()
    for (const [hash, preflight] of this.coworkPreflights) {
      if (preflight.expiresAtMs <= now) this.coworkPreflights.delete(hash)
    }
    const overflow = this.coworkPreflights.size - 20
    if (overflow <= 0) return
    for (const hash of [...this.coworkPreflights.keys()].slice(0, overflow)) {
      this.coworkPreflights.delete(hash)
    }
  }

  private async performScan(): Promise<AgentIntegrationScanResultDto> {
    this.dependencies.beforeScan?.()
    const scanStartedAt = this.now().toISOString()
    // Older builds could persist a manual MCP client as C3. This correction is
    // repository-only: it neither creates consent nor writes to the host.
    this.dependencies.repository.normalizeCustomMcpCapabilityCeiling(scanStartedAt)
    // A user disconnects Tide Mind management, not host presence tracking.
    // Keep scanning disconnected-but-still-present Installations so a later
    // authoritative uninstall can move them into connection history.
    const before = this.dependencies.repository.listInstallations({ includeRemoved: true })
      .filter(row => !isHistoricalInstallationRow(row))
    const report = await this.dependencies.scanner.scan()
    const detectedAt = this.now().toISOString()
    const seenInstallationIds = new Set<string>()
    let newlyDiscoveredCount = 0
    for (const installation of report.installations) {
      const identityMatch = matchInstallationIdentity(
        installation.identity,
        this.dependencies.repository.listInstallationIdentityRecords(),
      )
      if (identityMatch.kind === 'ambiguous' || identityMatch.kind === 'distribution_conflict') {
        for (const candidate of identityMatch.candidates) {
          seenInstallationIds.add(candidate.installationId)
          this.dependencies.repository.markInstallationIdentityConflict(
            candidate.installationId,
            detectedAt,
            identityMatch.reason,
          )
        }
        this.dependencies.repository.recordEvent({
          kind: 'discovery_identity_conflict',
          severity: 'warning',
          dedupeKey: `${installation.identity.installKey}:${identityMatch.kind}`,
          payload: {
            reason: identityMatch.reason,
            candidateInstallationIds: identityMatch.candidates.map(candidate => candidate.installationId),
          },
          createdAt: detectedAt,
        })
        continue
      }
      const input = toDiscoverInstallationInput(installation, {
        id: identityMatch.kind === 'matched' ? identityMatch.record.installationId : this.installationId(),
        lastDetectedAt: detectedAt,
      })
      const persisted = this.dependencies.repository.upsertDiscoveredInstallation({
        ...input,
        agentId: identityMatch.kind === 'new' ? this.agentId() : null,
        supportedCapability: isAgentReleaseGateReason(installation.managementEligibility?.reason)
          ? 0
          : this.releaseEntries?.get(installation.catalogId)?.targetCapability
            ?? getCatalogVariant(installation.catalogId).maxCapability,
      })
      seenInstallationIds.add(persisted.id)
      const actuallyCreated = identityMatch.kind === 'new' && persisted.id === input.id
      if (actuallyCreated) newlyDiscoveredCount += 1
      if (actuallyCreated && this.isManageableInstallation(persisted)) {
        const eventId = `aie_${randomUUID()}`
        const event = {
          id: eventId,
          installationId: persisted.id,
          componentKey: null,
          artifactId: null,
          kind: 'installation_discovered_awaiting_consent',
          severity: 'info' as const,
          episodeId: null,
          dedupeKey: `${persisted.id}:first-discovery`,
          payload: {},
          createdAt: detectedAt,
        }
        const notifications = this.dependencies.notifications
        if (notifications) {
          const configuredLocale = this.dependencies.notificationLocale
          const locale = typeof configuredLocale === 'function' ? configuredLocale() : configuredLocale
          await publishIntegrationEvent(event, newInstallationNotification({
            eventId,
            installationId: persisted.id,
            agentName: persisted.display_alias ?? persisted.display_name,
            locale,
          }), {
            repository: { recordEvent: input => { this.dependencies.repository.recordEvent(input) } },
            notifications,
          })
        } else {
          this.dependencies.repository.recordEvent(event)
        }
      }
    }
    const uncertaintyByCatalog = new Map<CatalogId, string[]>()
    for (const item of report.unresolved) {
      for (const catalogId of item.catalogIds) {
        const reasons = uncertaintyByCatalog.get(catalogId) ?? []
        reasons.push(item.reason)
        uncertaintyByCatalog.set(catalogId, reasons)
      }
    }
    for (const existing of before) {
      if (seenInstallationIds.has(existing.id)) continue
      if (existing.family === 'custom-local-agent'
        && isCustomInstallationManagementContractValid(existing, this.dependencies.repository, this.releaseEntries)
        && await this.dependencies.probeCustomInstallation?.(existing)) {
        // A Custom target is never rediscovered by walking arbitrary local
        // configuration files. Re-attest only the exact identity frozen by
        // its user-completed preflight and keep that Installation alive.
        seenInstallationIds.add(existing.id)
        continue
      }
      if (existing.host_variant === 'claude-cowork-local'
        && isUserGuidedCoworkRow(existing)
        && await this.probeUserGuidedCowork(existing)) {
        // The original row exists only because the user explicitly started
        // setup. Subsequent scans may retain it by re-attesting that exact
        // signed Claude.app; they still do not claim the Cowork plugin loaded.
        seenInstallationIds.add(existing.id)
        continue
      }
      const uncertainty = uncertaintyByCatalog.get(existing.host_variant as CatalogId)
      if (uncertainty) {
        this.dependencies.repository.markInstallationProbeUncertain(existing.id, detectedAt, uncertainty)
      } else {
        this.dependencies.repository.markInstallationNotDetected(existing.id, detectedAt)
      }
    }
    await this.dependencies.afterScan?.()
    this.dependencies.repository.setLastSuccessfulScanAt(detectedAt)
    return {
      snapshot: this.snapshot(),
      detectedCount: report.installations.length,
      newlyDiscoveredCount,
      unresolved: report.unresolved.map(item => ({
        hostVariants: [...item.catalogIds],
        reason: item.reason,
        summary: item.summary,
      })),
    }
  }

  private async probeUserGuidedCowork(existing: AgentInstallationRow): Promise<boolean> {
    const candidate = await this.dependencies.scanner.previewGuidedInstallation?.('claude-cowork-local')
    if (!candidate || candidate.appPath !== existing.app_path || candidate.detectedVersion !== existing.detected_version) {
      return false
    }
    return candidate.identity.distribution.capabilityFingerprint
      === persistedDistribution(existing).capabilityFingerprint
  }

  private async preview(
    operation: 'connect' | 'disconnect',
    installationIds: readonly string[],
    includeTechnicalDetails: boolean,
    withoutLifecycle = new Set<string>(),
  ): Promise<AgentIntegrationPlanPreviewDto> {
    const ids = uniqueIds(installationIds)
    if (ids.length === 0) throw new Error('at least one Installation is required')
    const items: CachedPlanItem[] = []
    for (const id of ids) {
      const row = this.requireInstallation(id)
      if (operation === 'connect' && row.desired_state === 'disabled') {
        throw new Error(`paused Installation must resume management instead of reconnecting: ${id}`)
      }
      if (operation === 'connect' && row.status_reason === 'legacy_confirmation_required') {
        throw new Error(`legacy connection ambiguity must be resolved before connecting: ${id}`)
      }
      if (operation === 'disconnect' && row.desired_state === 'removed') {
        throw new Error(`Installation is already disconnected: ${id}`)
      }
      if (operation === 'disconnect' && row.desired_state === 'unmanaged') {
        throw new Error(`an unconnected Installation cannot be disconnected: ${id}`)
      }
      const installation = toCoordinatorInstallation(row)
      if (!this.isManageableInstallation(row)) {
        const eligibilityReason = this.managementEligibilityReason(row)
        if (eligibilityReason) {
          throw new Error(`managed integration is unavailable: ${eligibilityReason}`)
        }
        throw new Error(`managed integration is not enabled for ${installation.identity.hostVariant}`)
      }
      const variant = getCatalogVariant(installation.identity.hostVariant)
      const implemented = this.implementedComponents?.get(installation.identity.hostVariant)
      const mayExcludeLifecycle = this.connectOptionalComponents
        ?.get(installation.identity.hostVariant)?.has('lifecycle') ?? true
      if (withoutLifecycle.has(id) && !mayExcludeLifecycle) {
        throw new Error(`lifecycle cannot be excluded from the ${installation.identity.hostVariant} aggregate projection`)
      }
      const componentKeys = variant.components
        .filter(component => component.applicability === 'supported')
        .filter(component => component.actions.includes(operation === 'disconnect' ? 'disconnect' : 'connect'))
        .filter(component => implemented ? implemented.has(component.componentKey) : true)
        .filter(component => !(component.componentKey === 'lifecycle' && withoutLifecycle.has(id)))
        .map(component => component.componentKey)
      const requestedCapability = operation === 'disconnect'
        ? 0
        : capabilityForComponents(componentKeys)
      const request: PreviewRequest = {
        installation,
        operation,
        componentKeys,
        desiredCapability: requestedCapability,
      }
      const prepared = await this.dependencies.execution.preview(request)
      const desiredCapability = operation === 'disconnect'
        ? 0
        : capabilityForComponents(prepared.componentKeys)
      const maintenanceScopes = this.noopMaintenanceScopes(installation, prepared)
      const disconnectScopes = operation === 'disconnect'
        ? this.disconnectScopes(installation, prepared, maintenanceScopes)
        : []
      items.push({ installation, desiredCapability, prepared, maintenanceScopes, disconnectScopes })
    }
    const hash = sha256Json({
      operation,
      plans: items.map(item => ({
        installationId: item.installation.id,
        executionPlanHash: item.prepared.executionPlanHash,
        adapterPlanHash: item.prepared.adapterPlanHash,
        maintenanceScopes: item.maintenanceScopes,
        disconnectScopes: item.disconnectScopes.map(disconnectScopeHashInput),
      })),
    })
    const expiresAtMs = this.now().getTime() + PLAN_TTL_MS
    const bundle: CachedPlanBundle = {
      hash,
      operation,
      installationIds: ids,
      items,
      expiresAtMs,
      consentIds: new Map(),
    }
    this.prunePlans()
    this.plans.set(hash, bundle)
    return this.planBundleDto(bundle, includeTechnicalDetails)
  }

  private planBundleDto(
    bundle: CachedPlanBundle,
    includeTechnicalDetails: boolean,
  ): AgentIntegrationPlanPreviewDto {
    return {
      planHash: bundle.hash,
      operation: bundle.operation,
      installations: bundle.items.map(item => this.toPlanInstallationDto(item, includeTechnicalDetails)),
      expiresAt: new Date(bundle.expiresAtMs).toISOString(),
    }
  }

  private async apply(
    bundle: CachedPlanBundle,
    onResult?: (result: AgentIntegrationApplyItemDto) => void,
    onItemStarted?: (installationId: string) => void,
    applyTaskId?: string,
  ): Promise<AgentIntegrationApplyResultDto> {
    // A frozen approval is single-use. Partial failures require a fresh inspect
    // and preview so stale preconditions cannot be replayed from the renderer.
    this.plans.delete(bundle.hash)
    const results: AgentIntegrationApplyItemDto[] = []
    for (const item of bundle.items) {
      try {
        onItemStarted?.(item.installation.id)
        const liveRow = this.requireInstallation(item.installation.id)
        if (liveRow.health_state !== 'discovered' || liveRow.status_reason === 'conflict') {
          throw new Error('Installation is not authoritatively present; scan and preview again')
        }
        if ((this.enabledCatalogIds && !this.enabledCatalogIds.has(item.installation.identity.hostVariant))
          || this.dependencies.canManageInstallation?.(liveRow) === false) {
          throw new Error(`managed integration is no longer enabled for ${item.installation.identity.hostVariant}`)
        }
        const liveInstallation = toCoordinatorInstallation(liveRow)
        if (sha256Json(liveInstallation) !== sha256Json(item.installation)) {
          throw new Error('Installation identity changed after preview; scan and preview again')
        }
        const fresh = await this.dependencies.execution.preview({
          installation: liveInstallation,
          operation: item.prepared.operation,
          componentKeys: item.prepared.componentKeys,
          desiredCapability: item.desiredCapability,
          frozenActivityGenerationToken: item.prepared.activityGenerationToken,
        })
        if (preparedLiveEvidence(fresh) !== preparedLiveEvidence(item.prepared)) {
          throw new Error('Installation configuration changed after preview; preview again')
        }
        const expectedProof = frozenPlanLiveTrustProofFingerprint(item.prepared)
        if (this.dependencies.attestInstallation) {
          if (!expectedProof || !await this.dependencies.attestInstallation(liveRow, expectedProof)) {
            throw new Error('Installation source trust changed before consent; scan and preview again')
          }
        }
        const consentId = this.ensureConsent(bundle, item)
        const request: ApplyPreparedRequest = {
          installation: item.installation,
          preparedPlan: item.prepared,
          consentId,
          desiredCapability: item.desiredCapability,
          disconnectScopeExpectations: item.disconnectScopes.map(scope => ({
            componentKey: scope.componentKey,
            physicalTarget: scope.targetPath,
            ownershipKey: scope.ownershipKey,
            consumerKeys: scope.consumers.map(consumerKey).sort(),
          })),
          applyTaskBinding: applyTaskId
            ? {
                taskId: applyTaskId,
                installationId: item.installation.id,
                executionPlanHash: item.prepared.executionPlanHash,
              }
            : undefined,
        }
        const result = toApplyItem(
          item.installation.id,
          await this.dependencies.execution.applyPrepared(request),
          bundle.operation === 'disconnect' ? item.disconnectScopes.some(scope => (
            scope.consumers.length > 1
            && scope.consumers.some(consumer => (
              consumer.installationId === item.installation.id
              && consumer.componentKey === scope.componentKey
              && consumer.discoverReachability !== 'per_host_ignorable'
            ))
          )) : undefined,
          item.prepared.adapterPlan.requiredUserActionDetails?.flatMap(action => userActionDto(action, this.homeDir)),
        )
        results.push(result)
        onResult?.(result)
      } catch (error) {
        const result: AgentIntegrationApplyItemDto = {
          installationId: item.installation.id,
          status: 'failed',
          reason: safeErrorMessage(error),
        }
        results.push(result)
        onResult?.(result)
      }
    }
    return { planHash: bundle.hash, results }
  }

  private emitApplyTask(task: AgentIntegrationApplyTaskDto): void {
    const snapshot = cloneApplyTask(task)
    for (const listener of this.applyTaskListeners) {
      try { listener(snapshot) } catch { /* a renderer subscriber cannot fail the durable task */ }
    }
  }

  private pruneApplyTasks(): void {
    const completed = [...this.applyTasks.values()].filter(task => task.state === 'completed')
    for (const task of completed.slice(0, Math.max(0, completed.length - 20))) {
      this.applyTasks.delete(task.id)
    }
  }

  private ensureConsent(bundle: CachedPlanBundle, item: CachedPlanItem): string {
    const existing = bundle.consentIds.get(item.installation.id)
    if (existing) return existing
    const mutations = item.prepared.executionPlan.mutations
    const authorizationTargets: ConsentAuthorizationTarget[] = [
      ...mutations.flatMap((mutation): ConsentAuthorizationTarget[] => {
        const commands = mutation.commands ?? (mutation.command ? [mutation.command] : [])
        const base: Omit<ConsentAuthorizationTarget, 'commandCategory' | 'executablePath'> = {
          componentKey: mutation.componentKey,
          artifactKey: mutation.artifactKey,
          targetPath: mutation.targetPath,
          ownershipSelector: mutation.ownershipSelector,
          selectorSchemaVersion: mutation.selectorSchemaVersion,
          risk: mutation.risk,
        }
        return commands.length === 0
          ? [{ ...base, commandCategory: mutation.commandCategory, executablePath: undefined }]
          : commands.map(command => ({
              ...base,
              commandCategory: command.category,
              executablePath: command.executablePath,
            }))
      }),
      ...item.maintenanceScopes.map(scope => ({ ...scope, executablePath: undefined })),
    ]
    const selectorVersions = [...new Set(authorizationTargets.map(target => target.selectorSchemaVersion))]
    if (selectorVersions.length > 1) throw new Error('plan spans multiple selector schema versions')
    const confirmedAt = this.now().toISOString()
    const id = this.consentId()
    const normalizedTargets = [...new Set([
      ...authorizationTargets.flatMap(target => (
        target.targetPath === null ? [] : [path.resolve(target.targetPath)]
      )),
      ...mutations.flatMap(mutation => (
        mutation.additionalFenceTargets?.map(target => path.resolve(target.targetPath)) ?? []
      )),
    ])]
    const targetScopes = normalizedTargets.map(target => `file:${target}`)
    this.dependencies.repository.createConsent({
      id,
      installationId: item.installation.id,
      policyVersion: String(CURRENT_CONSENT_POLICY_VERSION),
      allowedComponents: [...item.prepared.componentKeys],
      allowedScopes: targetScopes,
      normalizedTargets,
      selectorSchemaVersion: String(selectorVersions[0] ?? 1),
      selectorResolution: Object.fromEntries(authorizationTargets.map(target => [target.artifactKey, target.ownershipSelector])),
      executableRealpaths: [...new Set(authorizationTargets.flatMap(target => target.executablePath ? [target.executablePath] : []))],
      commandCategories: [...new Set(authorizationTargets.map(target => target.commandCategory))],
      maximumRisk: maximumRisk(authorizationTargets.map(target => target.risk)),
      confirmedAt,
      expectedInstallationSurfaceFingerprint:
        frozenPlanInstallationSurfaceFingerprint(item.prepared) ?? undefined,
    })
    bundle.consentIds.set(item.installation.id, id)
    return id
  }

  private connectableComponentKeys(hostVariant: CatalogId): ComponentKey[] {
    const variant = getCatalogVariant(hostVariant)
    const implemented = this.implementedComponents?.get(hostVariant)
    const componentKeys = variant.components
      .filter(component => component.applicability === 'supported' && component.actions.includes('connect'))
      .map(component => component.componentKey)
      .filter(componentKey => implemented ? implemented.has(componentKey) : true)
    if (componentKeys.length === 0) throw new Error('the selected host has no enabled component projection')
    return componentKeys
  }

  private requireCustomFlowEnabled(): void {
    if (this.dependencies.releasePolicy
      && (this.dependencies.releasePolicy.mode !== 'active'
        || !this.dependencies.releasePolicy.customLocalAgentEnabled)) {
      throw new Error('Custom local Agent integration is not enabled in this build')
    }
  }

  private requireInteractiveManagementEnabled(): void {
    if (this.dependencies.releasePolicy?.mode && this.dependencies.releasePolicy.mode !== 'active') {
      throw new Error('Agent integration is read-only in this build')
    }
  }

  private requireCodexManagedInstallation(id: string): AgentInstallationRow {
    const row = this.requireInstallation(id)
    if (row.host_variant !== 'codex-cli' && row.host_variant !== 'codex-desktop') {
      throw new Error('Codex hook trust is available only for Codex Installations')
    }
    if (row.desired_state !== 'managed' || row.health_state !== 'discovered'
      || row.status_reason === 'conflict' || !row.agent_id || !row.detected_version) {
      throw new Error('Codex Installation is not in a trust-verifiable managed state')
    }
    if (!this.isManageableInstallation(row)) {
      throw new Error('managed integration is not enabled for this Codex Installation')
    }
    return row
  }

  private assertCodexTrustActionBinding(
    row: AgentInstallationRow,
    action: CodexHookTrustRequiredUserAction,
  ): void {
    if (action.installationId !== row.id
      || action.agentId !== row.agent_id
      || action.hostVariant !== row.host_variant
      || action.hostVersion !== row.detected_version
      || action.sourcePathHash !== sha256String(path.resolve(action.sourcePath))
      || action.hookKeyHash !== sha256String(action.hookKey)
      || !action.hookKey.startsWith(`${action.sourcePath}:`)) {
      throw new Error('Codex hook trust action does not match the current Installation')
    }
  }

  private requireCodexTrustArtifact(
    row: AgentInstallationRow,
    action: CodexHookTrustRequiredUserAction,
  ): string {
    const matches = this.dependencies.repository.listInstallationComponentDetails(row.id)
      .filter(component => component.component_key === 'lifecycle'
        && component.desired_state === 'managed'
        && component.artifact_state === 'healthy'
        && typeof component.artifact_id === 'string'
        && typeof component.target_path === 'string'
        && path.resolve(component.target_path) === path.resolve(action.sourcePath)
        && component.owned_fragment_hash === action.ownedFragmentHash
        && String(component.projection_version) === action.projectionVersion)
    if (matches.length !== 1) {
      throw new Error('Codex lifecycle Artifact is not uniquely healthy and owned')
    }
    return String(matches[0].artifact_id)
  }

  private requireCodexTrustAction(hash: string): CachedCodexTrustAction {
    const action = this.codexTrustActions.get(hash)
    if (!action) throw new Error('Codex trust review is unknown or has expired; check again')
    if (action.expiresAtMs <= this.now().getTime()) {
      this.codexTrustActions.delete(hash)
      throw new Error('Codex trust review has expired; check again')
    }
    return action
  }

  private pruneCodexTrustActions(): void {
    const now = this.now().getTime()
    for (const [hash, action] of this.codexTrustActions) {
      if (action.expiresAtMs <= now) this.codexTrustActions.delete(hash)
    }
    const overflow = this.codexTrustActions.size - 20
    if (overflow <= 0) return
    for (const hash of [...this.codexTrustActions.keys()].slice(0, overflow)) {
      this.codexTrustActions.delete(hash)
    }
  }

  private requireCustomPreflight(hash: string): CachedCustomPreflight {
    this.requireCustomFlowEnabled()
    const preflight = this.customPreflights.get(hash)
    if (!preflight) throw new Error('Custom Agent preview is unknown or has expired; preview again')
    if (preflight.expiresAtMs <= this.now().getTime()) {
      this.customPreflights.delete(hash)
      throw new Error('Custom Agent preview has expired; preview again')
    }
    return preflight
  }

  private requireLegacyCustomIdentity(id: string): AgentInstallationRow {
    const row = this.requireInstallation(id)
    const metadata = parseStoredMetadata(row.metadata_json)
    const custom = metadata.customInstallation
    if (row.family !== 'custom-local-agent'
      || row.host_variant !== 'custom-local-mcp'
      || row.runtime_realm !== 'local_macos'
      || row.profile_id !== 'legacy-unconfigured'
      || row.provenance !== 'legacy_identity_only'
      || row.health_state !== 'identity_only'
      || row.desired_state !== 'unmanaged'
      || row.tombstoned_at !== null
      || !row.agent_id
      || !custom || typeof custom !== 'object' || Array.isArray(custom)
      || (custom as Record<string, unknown>).kind !== 'legacy_identity_only'
      || (custom as Record<string, unknown>).sourceAgentId !== row.agent_id) {
      throw new Error('the selected Installation is not an unconfigured legacy Custom identity')
    }
    return row
  }

  private async requireFreshCustomPreflight(hash: string): Promise<CachedCustomPreflight> {
    const preflight = this.requireCustomPreflight(hash)
    if (preflight.request.mode === 'nonstandard_config_root') {
      const source = this.requireInstallation(preflight.request.sourceInstallationId)
      if (!this.isManageableInstallation(source)
        || source.health_state !== 'discovered'
        || persistedProjectionSurfaceFingerprint(source) !== preflight.sourceSurfaceFingerprint) {
        throw new Error('the selected source host changed after preview; preview again')
      }
      const canonicalRoot = canonicalCustomDirectory(preflight.request.configRoot, this.homeDir)
      const stat = fs.statSync(canonicalRoot, { bigint: true })
      const currentFingerprint = sha256Json({
        realpath: canonicalRoot,
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: String(stat.mode),
      })
      if (currentFingerprint !== preflight.configFingerprint) {
        throw new Error('the selected configuration root changed after preview; preview again')
      }
      return preflight
    }
    const config = preflight.request.configurationOwnership === 'user'
      ? null : await readStableFileSnapshot(preflight.request.configFilePath, 1024 * 1024)
    const executable = await readStableFileFingerprint(
      preflight.request.clientExecutablePath,
      this.dependencies.cliManagementProofLimitBytes ?? MAX_CLI_EXECUTABLE_PROOF_BYTES,
    )
    if ((config && config.fingerprint !== preflight.configFingerprint)
      || executable.fingerprint !== preflight.executableFingerprint) {
      throw new Error('the selected Custom MCP surface changed after preview; preview again')
    }
    if (preflight.legacyIdentityBinding) {
      const current = this.requireLegacyCustomIdentity(preflight.legacyIdentityBinding.installationId)
      if (current.agent_id !== preflight.legacyIdentityBinding.agentId
        || current.install_key !== preflight.legacyIdentityBinding.installKey
        || current.metadata_json !== preflight.legacyIdentityBinding.metadataJson) {
        throw new Error('the selected legacy Custom identity changed after preview; preview again')
      }
    }
    return preflight
  }

  private pruneCustomPreflights(): void {
    const now = this.now().getTime()
    for (const [hash, preflight] of this.customPreflights) {
      if (preflight.expiresAtMs <= now) this.customPreflights.delete(hash)
    }
    const overflow = this.customPreflights.size - 20
    if (overflow <= 0) return
    for (const hash of [...this.customPreflights.keys()].slice(0, overflow)) {
      this.customPreflights.delete(hash)
    }
  }

  private requirePlan(
    planHash: string,
    operation: CachedPlanBundle['operation'],
    installationIds: readonly string[],
  ): CachedPlanBundle {
    const bundle = this.plans.get(planHash)
    if (!bundle) throw new Error('plan is unknown or has expired; preview again')
    if (bundle.expiresAtMs <= this.now().getTime()) {
      this.plans.delete(planHash)
      throw new Error('plan has expired; preview again')
    }
    if (bundle.operation !== operation) throw new Error('plan operation does not match requested action')
    if (JSON.stringify(bundle.installationIds) !== JSON.stringify(uniqueIds(installationIds))) {
      throw new Error('approved Installation set differs from preview')
    }
    return bundle
  }

  private prunePlans(): void {
    const now = this.now().getTime()
    for (const [hash, bundle] of this.plans) {
      if (bundle.expiresAtMs <= now) this.plans.delete(hash)
    }
  }

  private requireInstallation(id: string): AgentInstallationRow {
    const row = this.dependencies.repository.getInstallation(id)
    if (!row) throw new Error(`unknown Installation: ${id}`)
    return row
  }

  private isManageableInstallation(row: AgentInstallationRow): boolean {
    return row.host_variant !== 'claude-desktop-legacy'
      && isCustomInstallationManagementContractValid(row, this.dependencies.repository, this.releaseEntries)
      && this.managementEligibilityReason(row) === null
      && (this.enabledCatalogIds?.has(row.host_variant as CatalogId) ?? true)
      && (this.dependencies.canManageInstallation?.(row) ?? true)
  }

  private managementEligibilityReason(row: AgentInstallationRow): StatusReason | null {
    if (this.dependencies.enforceReleaseAcceptance && row.host_variant !== 'custom-local-mcp') {
      const distribution = persistedDistribution(row)
      const releaseReason = agentReleaseSurfaceEligibilityReason({
        catalogId: row.host_variant as CatalogId,
        detectedVersion: row.detected_version,
        distributionId: distribution.distributionId ?? row.distribution_id,
        packageProvenance: distribution.packageProvenance,
        architecture: process.arch === 'x64' ? 'x64' : 'arm64',
        portableArtifactFingerprint: distribution.portableArtifactFingerprint,
      }, this.dependencies.releaseEntries?.get(row.host_variant as CatalogId))
      if (releaseReason) return releaseReason
    }
    if (this.dependencies.cliManagementProofLimitBytes === undefined) return null
    const eligibility = persistedManagementEligibility(row)
    const distribution = persistedDistribution(row)
    const hasCliDistributionProbe = getCatalogVariant(row.host_variant as CatalogId).hostKind === 'cli'
      || distribution.distributionId?.startsWith('cli:') === true
      || distribution.capabilityFingerprint?.startsWith('cli-surface:') === true
    // The discovery channel, rather than the Catalog presentation kind, owns
    // executable-proof eligibility. OpenClaw is presented as a local server,
    // but its production Installation is discovered and attested through its
    // CLI distribution. A persisted eligibility record must therefore remain
    // authoritative for every host kind.
    if (!eligibility && !hasCliDistributionProbe) return null
    if (isAgentReleaseGateReason(eligibility?.reason)) return eligibility.reason
    if (!hasExactPersistedExecutableSurface(row)
      || !eligibility
      || eligibility.proofLimitBytes !== this.dependencies.cliManagementProofLimitBytes) {
      return 'executable_metadata_unavailable'
    }
    if (eligibility.eligible) return null
    return eligibility.reason === 'distribution_not_managed'
      ? 'incompatible'
      : eligibility.reason ?? 'executable_metadata_unavailable'
  }

  private toInstallationDto(row: AgentInstallationRow): AgentIntegrationInstallationDto {
    const rawComponents = this.dependencies.repository.listInstallationComponentDetails(row.id)
    const historicalRecord = isHistoricalInstallationRow(row)
    const manageable = !historicalRecord && this.isManageableInstallation(row)
    const managementEligibilityReason = this.managementEligibilityReason(row)
    // Fail closed in presentation before the first post-upgrade scan has had a
    // chance to normalize rows persisted by the earlier C3 contract.
    const verifiedCapability = row.host_variant === 'custom-local-mcp'
      ? capability(Math.min(row.verified_capability, 2))
      : capability(row.verified_capability)
    const status = deriveInstallationStatus({
      desiredState: row.desired_state,
      reconcileState: row.reconcile_state,
      hasConsent: row.consent_envelope_id !== null,
      compatible: row.supported_capability > 0,
      hostPresent: row.health_state === 'discovered' && row.status_reason !== 'host_uninstalled',
      verifiedCapability,
      verificationSummary: row.verification_summary,
      disconnectVerified: row.status_reason === 'disconnect_verified',
      circuitBreakerOpen: row.status_reason === 'circuit_breaker',
      legacyCallableWithoutConsent: row.desired_state === 'unmanaged'
        && row.consent_envelope_id === null
        && row.status_reason === 'legacy_callable_unmanaged',
      blockingReasons: row.status_reason && STATUS_REASONS.has(row.status_reason as StatusReason)
        ? [row.status_reason as StatusReason]
        : [],
    })
    const variant = getCatalogVariant(row.host_variant as CatalogId)
    return {
      id: row.id,
      familyId: row.family,
      hostVariant: row.host_variant,
      variantLabel: variant.displayName,
      displayName: row.display_alias ?? row.display_name,
      profileLabel: row.profile_id || null,
      version: row.detected_version,
      manageable,
      desiredState: row.desired_state,
      // A detectable Catalog entry is not waiting for consent when the
      // production Adapter is unavailable or its distribution is untrusted.
      // Keep that truth in the DTO, not only in renderer-side CTA filtering.
      statusGroup: historicalRecord ? 'disconnected' : manageable ? status.statusGroup : 'disconnected',
      statusReason: historicalRecord
        ? 'host_uninstalled'
        : manageable
          ? status.statusReason
        : managementEligibilityReason
          ? managementEligibilityReason
            : 'detect_only',
      accessLevel: status.accessLevel,
      accessIsHistorical: historicalRecord || status.accessIsHistorical,
      components: COMPONENT_KEYS.map(key => componentDto(
        key,
        variant,
        rawComponents,
        row,
        this.homeDir,
        this.implementedComponents?.get(row.host_variant as CatalogId),
        this.implementedArtifactTypes?.get(row.host_variant as CatalogId),
      )),
      unreadEventCount: this.dependencies.repository.listInstallationEvents(row.id, {
        state: 'unread',
        limit: 1_000,
      }).length,
      lastDetectedAt: row.last_detected_at,
      lastVerifiedAt: row.last_verified_at,
      lastRepairedAt: row.last_repaired_at,
      lastRealUseAt: historicalRecord
        ? null
        : this.dependencies.repository.latestVerifiedHostActivityAt(row.id, this.now().toISOString()),
    }
  }

  private toPlanInstallationDto(
    item: CachedPlanItem,
    includeTechnicalDetails: boolean,
  ): AgentIntegrationPlanInstallationDto {
    return {
      installationId: item.installation.id,
      displayName: item.installation.displayName,
      desiredCapability: item.desiredCapability,
      componentKeys: [...item.prepared.componentKeys],
      targets: [
        ...item.prepared.executionPlan.mutations.map(mutation => planTargetDto(
          mutation,
          this.homeDir,
          includeTechnicalDetails,
          item.disconnectScopes.find(scope => disconnectScopeMatches(scope, mutation.componentKey, mutation.targetPath, mutation.ownershipSelector)),
        )),
        ...item.maintenanceScopes.map(scope => maintenanceTargetDto(
          scope,
          this.homeDir,
          includeTechnicalDetails,
          item.disconnectScopes.find(disconnect => disconnectScopeMatches(
            disconnect,
            scope.componentKey,
            scope.targetPath,
            scope.ownershipSelector,
          )),
        )),
      ],
      requiredUserActions: item.prepared.adapterPlan.requiredUserActions.map(sanitizeDiagnostic),
      requiredUserActionDetails: item.prepared.adapterPlan.requiredUserActionDetails?.flatMap(action => (
        userActionDto(action, this.homeDir)
      )),
      diagnostics: item.prepared.adapterPlan.diagnostics.map(sanitizeDiagnostic),
      optionalComponentKeys: this.connectOptionalComponents === null
        ? (item.prepared.componentKeys.includes('lifecycle') ? ['lifecycle'] : [])
        : [...(this.connectOptionalComponents.get(item.installation.identity.hostVariant) ?? [])]
          .filter(component => item.prepared.componentKeys.includes(component)),
    }
  }

  private disconnectScopes(
    installation: CoordinatorInstallation,
    prepared: PreparedCoordinatorPlan,
    maintenanceScopes: readonly NoopMaintenanceScope[],
  ): DisconnectArtifactScope[] {
    const targets = [
      ...prepared.adapterPlan.mutations.map(mutation => ({
        componentKey: mutation.componentKey,
        targetPath: mutation.physicalTarget,
        ownershipKey: mutation.ownershipKey,
      })),
      ...maintenanceScopes.map(scope => ({
        componentKey: scope.componentKey,
        targetPath: scope.targetPath,
        ownershipKey: scope.ownershipSelector,
      })),
    ]
    return targets.map(target => {
      const scope = this.dependencies.repository.getDisconnectArtifactScope(
        installation.id,
        target.componentKey,
        target.targetPath,
        target.ownershipKey,
      )
      if (!scope) throw new Error(`disconnect ownership scope missing: ${target.componentKey}`)
      return scope
    })
  }

  private noopMaintenanceScopes(
    installation: CoordinatorInstallation,
    prepared: PreparedCoordinatorPlan,
  ): NoopMaintenanceScope[] {
    const mutated = new Set(prepared.executionPlan.mutations.map(mutation => mutation.componentKey))
    const noMutationComponents = prepared.componentKeys.filter(componentKey => !mutated.has(componentKey))
    const ownedScopes = this.dependencies.repository.listOwnedArtifactConsentScopes(
      installation.id,
      noMutationComponents,
    )
    const scopes: NoopMaintenanceScope[] = ownedScopes.map(artifact => {
      const observation = prepared.inspection.components.find(component => (
        component.componentKey === artifact.componentKey
      ))
      const relocatedExactCopy = observation?.observedTarget
        && observation.observedFragmentHash
        && observation.observedFragmentHash === artifact.ownedFragmentHash
        && path.resolve(observation.observedTarget) !== path.resolve(artifact.targetPath)
      return {
        componentKey: artifact.componentKey,
        artifactKey: `${installation.identity.hostVariant}:${artifact.componentKey}:${artifact.ownershipKey}`,
        targetPath: relocatedExactCopy ? observation.observedTarget! : artifact.targetPath,
        ownershipSelector: artifact.ownershipKey,
        selectorSchemaVersion: artifact.selectorSchemaVersion,
        commandCategory: 'file_write' as const,
        risk: 'low' as const,
      }
    })
    const seen = new Set(scopes.map(scope => `${scope.componentKey}\0${scope.targetPath}\0${scope.ownershipSelector}`))
    for (const componentKey of noMutationComponents) {
      const observation = prepared.inspection.components.find(component => component.componentKey === componentKey)
      if (!observation?.observedTarget || !observation.observedFragmentHash) continue
      const artifacts = this.dependencies.repository.findExactManagedArtifacts(
        installation.identity.runtimeRealm,
        observation.observedTarget,
        observation.observedFragmentHash,
      )
      if (artifacts.length !== 1) continue
      const artifact = artifacts[0]
      const key = `${componentKey}\0${String(artifact.target_path)}\0${String(artifact.ownership_key)}`
      if (seen.has(key)) continue
      scopes.push({
        componentKey,
        artifactKey: `${installation.identity.hostVariant}:${componentKey}:${String(artifact.ownership_key)}`,
        targetPath: String(artifact.target_path),
        ownershipSelector: String(artifact.ownership_key),
        selectorSchemaVersion: Number(artifact.selector_schema_version),
        commandCategory: 'file_write',
        risk: 'low',
      })
      seen.add(key)
    }
    return scopes
  }
}

export function isCustomInstallationManagementContractValid(
  row: AgentInstallationRow,
  repository: AgentIntegrationRepository,
  releaseEntries: ReadonlyMap<CatalogId, AgentReleaseEntry> | null | undefined,
): boolean {
  if (row.family !== 'custom-local-agent') return true
  if (row.host_variant === 'custom-local-mcp') return true
  const custom = parseStoredMetadata(row.metadata_json).customInstallation
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return false
  const values = custom as Record<string, unknown>
  if (values.kind !== 'nonstandard_config_root'
    || typeof values.sourceInstallationId !== 'string'
    || typeof values.sourceHostVariant !== 'string'
    || typeof values.sourceInstallKey !== 'string'
    || typeof values.sourceSurfaceFingerprint !== 'string'
    || !row.config_root
    || !releaseEntries?.get(row.host_variant as CatalogId)?.customConfigRoot.supported) return false
  const source = repository.getInstallation(values.sourceInstallationId)
  return Boolean(
    source
    && source.family !== 'custom-local-agent'
    && source.desired_state !== 'removed'
    && source.health_state === 'discovered'
    && row.host_variant === values.sourceHostVariant
    && source.host_variant === values.sourceHostVariant
    && source.install_key === values.sourceInstallKey
    && row.install_key === customInstallKey({
      mode: 'nonstandard_config_root',
      sourceInstallKey: values.sourceInstallKey,
      configRoot: row.config_root,
    })
    && row.os_user_identity === source.os_user_identity
    && row.distribution_id === source.distribution_id
    && persistedProjectionSurfaceFingerprint(source) === values.sourceSurfaceFingerprint,
  )
}

function toCoordinatorInstallation(row: AgentInstallationRow): CoordinatorInstallation {
  if (!row.agent_id) throw new Error(`Installation has no persisted Agent identity: ${row.id}`)
  if (!row.config_root) throw new Error(`Installation has no canonical config root: ${row.id}`)
  if (row.runtime_realm !== 'local_macos' && row.runtime_realm !== 'wsl' && row.runtime_realm !== 'ssh' && row.runtime_realm !== 'dev_container') {
    throw new Error(`unsupported runtime realm: ${row.runtime_realm}`)
  }
  return {
    id: row.id,
    displayName: row.display_alias ?? row.display_name,
    desiredState: row.desired_state,
    agentId: row.agent_id,
    identity: {
      runtimeRealm: row.runtime_realm,
      osUserIdentity: row.os_user_identity ?? 'local-user',
      productFamilyId: row.family,
      hostVariant: row.host_variant as CatalogId,
      canonicalConfigRoot: row.config_root,
      componentConfigRoots: persistedComponentConfigRoots(row),
      componentConfigFiles: persistedComponentConfigFiles(row),
      explicitProfile: row.profile_id || 'default',
      hostOwnedIdentity: persistedHostOwnedIdentity(row),
      distribution: persistedDistribution(row),
      installKey: row.install_key,
    },
  }
}

function componentDto(
  key: ComponentKey,
  variant: ReturnType<typeof getCatalogVariant>,
  rows: Array<Record<string, unknown>>,
  installation: AgentInstallationRow,
  homeDir: string,
  implementedComponents?: ReadonlySet<ComponentKey>,
  implementedArtifactTypes?: Readonly<Partial<Record<ComponentKey, readonly ArtifactComponentType[]>>>,
): AgentIntegrationComponentDto {
  const declaration = variant.components.find(component => component.componentKey === key)
  const row = rows.find(candidate => candidate.component_key === key)
  if (!declaration || declaration.applicability === 'not_applicable' || (implementedComponents && !implementedComponents.has(key))) {
    return { key, state: 'unsupported', implementationTypes: [], targetLabel: null, lastVerifiedAt: null }
  }
  let state: AgentIntegrationComponentDto['state'] = 'unconnected'
  if (row) {
    const verification = String(row.verification_status ?? 'unverified')
    const artifactState = String(row.artifact_state ?? '')
    if (artifactState === 'conflict' || artifactState === 'drifted') state = 'conflict'
    else if (artifactState === 'missing' || artifactState === 'paused') state = 'missing'
    else if (verification === 'verified') state = 'verified'
    else if (verification === 'stale') state = 'verification_stale'
    else if (row.visibility_state !== 'absent') state = 'configured'
    else if (installation.desired_state === 'managed') state = 'missing'
  }
  return {
    key,
    state,
    implementationTypes: (implementedArtifactTypes?.[key] ?? declaration.artifactTypes).map(value => String(value)),
    targetLabel: redactPath(typeof row?.target_path === 'string' ? row.target_path : null, homeDir),
    lastVerifiedAt: typeof row?.artifact_last_verified_at === 'string'
      ? row.artifact_last_verified_at
      : null,
  }
}

function planTargetDto(
  mutation: PreparedCoordinatorPlan['executionPlan']['mutations'][number],
  homeDir: string,
  includeTechnicalDetails: boolean,
  disconnectScope?: DisconnectArtifactScope,
): AgentIntegrationPlanTargetDto {
  const sharedImpact = disconnectScope && disconnectScope.consumers.length > 1
    ? sharedImpactDto(disconnectScope)
    : undefined
  const dto: AgentIntegrationPlanTargetDto = {
    componentKey: mutation.componentKey,
    action: sharedImpact ? 'detach' : mutation.action,
    scope: scopeFor(mutation.targetPath, homeDir),
    targetLabel: redactPath(mutation.targetPath, homeDir),
    risk: mutation.risk,
    commandCategory: mutation.commandCategory,
    reversible: mutation.reversible,
    ...(sharedImpact ? { sharedImpact } : {}),
  }
  if (includeTechnicalDetails) {
    dto.selector = sanitizeDiagnostic(mutation.ownershipSelector)
    if (mutation.command) {
      dto.executableLabel = redactPath(mutation.command.executablePath, homeDir) ?? undefined
      dto.args = sanitizeArgs(mutation.command.args, homeDir)
    }
    if (mutation.commands) {
      dto.commands = mutation.commands.map(command => ({
        commandCategory: command.category,
        executableLabel: redactPath(command.executablePath, homeDir) ?? command.executablePath,
        args: sanitizeArgs(command.args, homeDir),
      }))
    }
  }
  return dto
}

function maintenanceTargetDto(
  scope: NoopMaintenanceScope,
  homeDir: string,
  includeTechnicalDetails: boolean,
  disconnectScope?: DisconnectArtifactScope,
): AgentIntegrationPlanTargetDto {
  const sharedImpact = disconnectScope && disconnectScope.consumers.length > 1
    ? sharedImpactDto(disconnectScope)
    : undefined
  return {
    componentKey: scope.componentKey,
    action: sharedImpact ? 'detach' : 'invoke',
    scope: scopeFor(scope.targetPath, homeDir),
    targetLabel: redactPath(scope.targetPath, homeDir),
    risk: scope.risk,
    commandCategory: scope.commandCategory,
    reversible: true,
    ...(sharedImpact ? { sharedImpact } : {}),
    ...(includeTechnicalDetails ? { selector: sanitizeDiagnostic(scope.ownershipSelector) } : {}),
  }
}

function disconnectScopeMatches(
  scope: DisconnectArtifactScope,
  componentKey: ComponentKey,
  targetPath: string | null,
  ownershipKey: string,
): boolean {
  return targetPath !== null
    && scope.componentKey === componentKey
    && scope.targetPath === targetPath
    && scope.ownershipKey === ownershipKey
}

function consumerKey(consumer: DisconnectArtifactScope['consumers'][number]): string {
  return `${consumer.installationId}\0${consumer.componentKey}`
}

function disconnectScopeHashInput(scope: DisconnectArtifactScope) {
  return {
    artifactId: scope.artifactId,
    initiatingInstallationId: scope.initiatingInstallationId,
    componentKey: scope.componentKey,
    targetPath: scope.targetPath,
    ownershipKey: scope.ownershipKey,
    consumers: scope.consumers.map(consumer => ({
      installationId: consumer.installationId,
      displayName: consumer.displayName,
      hostVariant: consumer.hostVariant,
      profileId: consumer.profileId,
      componentKey: consumer.componentKey,
      discoverReachability: consumer.discoverReachability,
    })),
  }
}

function sharedImpactDto(scope: DisconnectArtifactScope): NonNullable<AgentIntegrationPlanTargetDto['sharedImpact']> {
  const current = scope.consumers.find(consumer => (
    consumer.installationId === scope.initiatingInstallationId
    && consumer.componentKey === scope.componentKey
  ))
  return {
    outcome: 'consumer_detach_only',
    remainsVisibleForCurrentInstallation: current?.discoverReachability !== 'per_host_ignorable',
    consumers: scope.consumers.map(consumer => ({
      installationId: consumer.installationId,
      displayName: consumer.displayName,
      variantLabel: getCatalogVariant(consumer.hostVariant).displayName,
      profileLabel: consumer.profileId || null,
      componentKey: consumer.componentKey,
    })),
  }
}

function preparedLiveEvidence(plan: PreparedCoordinatorPlan): string {
  return sha256Json({
    operation: plan.operation,
    componentKeys: plan.componentKeys,
    inspection: plan.inspection,
    adapter: {
      catalogId: plan.adapterPlan.catalogId,
      installationKey: plan.adapterPlan.installationKey,
      adapterVersion: plan.adapterPlan.adapterVersion,
      projectionVersion: plan.adapterPlan.projectionVersion,
      mutations: plan.adapterPlan.mutations.map(({ operationId, ...mutation }) => {
        void operationId
        return mutation
      }),
      requiredUserActions: plan.adapterPlan.requiredUserActions,
      requiredUserActionDetails: plan.adapterPlan.requiredUserActionDetails,
      diagnostics: plan.adapterPlan.diagnostics,
    },
    executionBinding: {
      catalogVersion: plan.executionPlan.catalogVersion,
      adapterVersion: plan.executionPlan.adapterVersion,
      projectionVersion: plan.executionPlan.projectionVersion,
      installationSurfaceFingerprint: frozenPlanInstallationSurfaceFingerprint(plan),
      liveTrustProofFingerprint: frozenPlanLiveTrustProofFingerprint(plan),
    },
  })
}

function toApplyItem(
  installationId: string,
  outcome: CoordinatorOutcome,
  detachedSharedVisible?: boolean,
  requiredUserActionDetails?: AgentIntegrationRequiredUserActionDto[],
): AgentIntegrationApplyItemDto {
  if (outcome.status === 'committed') {
    return {
      installationId,
      status: 'committed',
      ...(detachedSharedVisible === undefined ? {} : {
        completion: detachedSharedVisible ? 'detached_shared_visible' as const : 'disconnected' as const,
      }),
      runId: outcome.runId,
    }
  }
  if (outcome.status === 'awaiting_verification') {
    return {
      installationId,
      status: 'awaiting_verification',
      runId: outcome.runId,
      ...(requiredUserActionDetails?.length ? { requiredUserActionDetails } : {}),
    }
  }
  if (outcome.status === 'needs_recovery') {
    return { installationId, status: 'needs_recovery', runId: outcome.runId, reason: outcome.reason }
  }
  if (outcome.status === 'paused') return { installationId, status: 'paused', reason: outcome.reason }
  return { installationId, status: 'awaiting_consent', reason: outcome.reasons.join(',') }
}

function capabilityForComponents(
  components: readonly ComponentKey[],
): CapabilityLevel {
  const enabled = new Set(components)
  if (enabled.has('instruction') && enabled.has('memory_tools') && enabled.has('lifecycle')) return 4
  if (enabled.has('instruction') && enabled.has('memory_tools')) return 3
  if (enabled.has('memory_tools')) return 2
  if (enabled.has('instruction')) return 1
  return 0
}

function isHistoricalInstallationRow(row: AgentInstallationRow): boolean {
  return row.health_state === 'absent' || row.status_reason === 'host_uninstalled'
}

const ACTIONABLE_INFO_EVENT_KINDS = new Set([
  'installation_discovered_awaiting_consent',
])

const STARTUP_SURFACE_INFO_EVENT_KINDS = new Set([
  ...ACTIONABLE_INFO_EVENT_KINDS,
  'artifact_auto_restored',
])

function isActionableInboxEvent(row: Record<string, unknown>): boolean {
  return row.severity === 'warning'
    || row.severity === 'error'
    || ACTIONABLE_INFO_EVENT_KINDS.has(String(row.kind))
}

function isStartupSurfaceEvent(row: Record<string, unknown>): boolean {
  return row.severity === 'warning'
    || row.severity === 'error'
    || STARTUP_SURFACE_INFO_EVENT_KINDS.has(String(row.kind))
}

function toEventDto(row: Record<string, unknown>): AgentIntegrationEventDto {
  return {
    id: String(row.id),
    installationId: typeof row.installation_id === 'string' ? row.installation_id : null,
    componentKey: COMPONENT_KEYS.includes(row.component_key as ComponentKey) ? row.component_key as ComponentKey : null,
    kind: String(row.kind),
    severity: row.severity === 'warning' || row.severity === 'error' ? row.severity : 'info',
    state: row.state === 'read' || row.state === 'archived' ? row.state : 'unread',
    createdAt: String(row.created_at),
    readAt: typeof row.read_at === 'string' ? row.read_at : null,
  }
}

function cloneApplyTask(task: AgentIntegrationApplyTaskDto): AgentIntegrationApplyTaskDto {
  return {
    ...task,
    installationIds: [...task.installationIds],
    pendingInstallationIds: [...task.pendingInstallationIds],
    results: task.results.map(result => ({
      ...result,
      ...(result.requiredUserActionDetails
        ? { requiredUserActionDetails: result.requiredUserActionDetails.map(action => ({ ...action })) }
        : {}),
    })),
  }
}

const APPLY_ITEM_STATUSES = new Set<AgentIntegrationApplyItemDto['status']>([
  'awaiting_consent', 'awaiting_verification', 'paused', 'committed',
  'needs_recovery', 'failed', 'interrupted',
])

function durableApplyTask(task: DurableApplyTaskRow, homeDir: string): AgentIntegrationApplyTaskDto {
  const results = task.items.flatMap(item => {
    const exactRun = exactDurableItemRun(item)
    if (exactRun) {
      const authoritative = recoveredApplyResult(exactRun, homeDir)
      return authoritative ? [authoritative] : []
    }
    if (item.state !== 'terminal' && item.state !== 'interrupted') return []
    const parsed = storedApplyItemPayload(item.result_json)
    if (!parsed) {
      return [{
        installationId: item.installation_id,
        status: 'interrupted' as const,
        reason: 'Stored task result is unreadable; inspect and preview again',
      }]
    }
    const status = APPLY_ITEM_STATUSES.has(parsed.status as AgentIntegrationApplyItemDto['status'])
      ? parsed.status as AgentIntegrationApplyItemDto['status']
      : 'interrupted'
    const payloadInstallationMismatch = typeof parsed.installationId === 'string'
      && parsed.installationId !== item.installation_id
    const hasRunSemantics = item.run_id !== null
      || typeof parsed.runId === 'string'
      || status === 'committed'
      || status === 'awaiting_verification'
      || status === 'needs_recovery'
    if (payloadInstallationMismatch || hasRunSemantics) {
      return [{
        installationId: item.installation_id,
        status: 'interrupted' as const,
        reason: 'Stored task result is not bound to its exact connect run; inspect and preview again',
      }]
    }
    return [{
      installationId: item.installation_id,
      status,
      ...(parsed.completion === 'disconnected' || parsed.completion === 'detached_shared_visible'
        ? { completion: parsed.completion } : {}),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    }]
  })
  const exactRunningInstallationIds = task.items.flatMap(item => {
    const run = exactDurableItemRun(item)
    return run && RUNNING_APPLY_STATES.has(run.state) ? [item.installation_id] : []
  })
  const pendingInstallationIds = [...new Set([
    ...task.items
      .filter(item => item.state === 'pending' || item.state === 'running')
      .filter(item => !exactDurableItemRun(item))
      .map(item => item.installation_id),
    ...exactRunningInstallationIds,
  ])]
  const state = pendingInstallationIds.length > 0 ? 'running' : task.state
  return {
    id: task.id,
    planHash: task.plan_hash,
    installationIds: task.items.map(item => item.installation_id),
    pendingInstallationIds,
    results,
    state,
    startedAt: task.started_at,
    completedAt: state === 'running' ? null : task.completed_at,
  }
}

function exactDurableItemRun(
  item: DurableApplyTaskRow['items'][number],
): ApplyTaskRunRow | null {
  if (item.exact_run_correlation !== 1
    || !item.run_id
    || !item.exact_run_state
    || !item.exact_run_created_at
    || !item.exact_run_updated_at
    || !storedPayloadMatchesExactRun(item)) return null
  return {
    id: item.run_id,
    installation_id: item.installation_id,
    execution_plan_hash: item.execution_plan_hash,
    state: item.exact_run_state,
    failure_code: item.exact_run_failure_code,
    prepared_plan_json: item.exact_run_prepared_plan_json ?? undefined,
    created_at: item.exact_run_created_at,
    started_at: item.exact_run_started_at,
    completed_at: item.exact_run_completed_at,
    updated_at: item.exact_run_updated_at,
  }
}

function storedPayloadMatchesExactRun(
  item: DurableApplyTaskRow['items'][number],
): boolean {
  if (item.state !== 'terminal' && item.state !== 'interrupted') return true
  const parsed = storedApplyItemPayload(item.result_json)
  if (!parsed) return true
  if (typeof parsed.installationId === 'string' && parsed.installationId !== item.installation_id) return false
  if (typeof parsed.runId === 'string' && parsed.runId !== item.run_id) return false
  if (parsed.status === 'committed'
    || parsed.status === 'awaiting_verification'
    || parsed.status === 'superseded'
    || parsed.status === 'needs_recovery') {
    return parsed.installationId === item.installation_id && parsed.runId === item.run_id
  }
  return true
}

function hasExactPersistedExecutableSurface(row: AgentInstallationRow): boolean {
  if (!row.executable_path || !path.isAbsolute(row.executable_path)) return false
  try {
    const metadata = JSON.parse(row.metadata_json) as unknown
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
    const distribution = (metadata as Record<string, unknown>).distribution
    if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) return false
    const executableRealpath = (distribution as Record<string, unknown>).executableRealpath
    return typeof executableRealpath === 'string'
      && path.isAbsolute(executableRealpath)
      && executableRealpath === row.executable_path
  } catch {
    return false
  }
}

function storedApplyItemPayload(resultJson: string | null): Partial<AgentIntegrationApplyItemDto> | null {
  try {
    const parsed = JSON.parse(resultJson ?? '')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<AgentIntegrationApplyItemDto>
      : null
  } catch {
    return null
  }
}

function overlayRecoveredRun(
  task: AgentIntegrationApplyTaskDto,
  run: ApplyTaskRunRow,
  homeDir: string,
): AgentIntegrationApplyTaskDto {
  const running = RUNNING_APPLY_STATES.has(run.state)
  const result = recoveredApplyResult(run, homeDir)
  const results = task.results.filter(item => item.installationId !== run.installation_id)
  if (result) results.push(result)
  const order = new Map(task.installationIds.map((installationId, index) => [installationId, index]))
  results.sort((left, right) => (
    (order.get(left.installationId) ?? Number.MAX_SAFE_INTEGER)
    - (order.get(right.installationId) ?? Number.MAX_SAFE_INTEGER)
  ))
  const pendingInstallationIds = task.pendingInstallationIds.filter(id => id !== run.installation_id)
  if (running) pendingInstallationIds.push(run.installation_id)
  pendingInstallationIds.sort((left, right) => (
    (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
  ))
  return {
    ...task,
    results,
    pendingInstallationIds,
    state: pendingInstallationIds.length > 0 ? 'running' : 'completed',
    completedAt: pendingInstallationIds.length > 0
      ? null
      : latestTimestamp(task.completedAt, run.completed_at, run.updated_at),
  }
}

function latestTimestamp(...timestamps: Array<string | null>): string | null {
  return timestamps
    .filter((timestamp): timestamp is string => timestamp !== null)
    .sort((left, right) => right.localeCompare(left))[0] ?? null
}

const RUNNING_APPLY_STATES = new Set([
  'planned',
  'preconditions_checked',
  'applying',
  'verified',
  'compensating',
])

function recoveredApplyTask(run: ApplyTaskRunRow, homeDir: string): AgentIntegrationApplyTaskDto {
  const running = RUNNING_APPLY_STATES.has(run.state)
  const result = recoveredApplyResult(run, homeDir)
  return {
    id: `agent_recovered_${createHash('sha256').update(run.id).digest('hex').slice(0, 24)}`,
    planHash: run.execution_plan_hash,
    installationIds: [run.installation_id],
    pendingInstallationIds: running ? [run.installation_id] : [],
    results: result ? [result] : [],
    state: running ? 'running' : 'completed',
    startedAt: run.started_at ?? run.created_at,
    completedAt: running ? null : (run.completed_at ?? run.updated_at),
  }
}

function recoveredApplyResult(run: ApplyTaskRunRow, homeDir: string): AgentIntegrationApplyItemDto | null {
  if (RUNNING_APPLY_STATES.has(run.state)) return null
  if (run.state === 'committed') {
    return { installationId: run.installation_id, status: 'committed', runId: run.id }
  }
  if (run.state === 'applied_unverified') {
    const requiredUserActionDetails = requiredUserActionsFromPreparedPlanJson(run.prepared_plan_json, homeDir)
    return {
      installationId: run.installation_id,
      status: 'awaiting_verification',
      runId: run.id,
      ...(requiredUserActionDetails.length ? { requiredUserActionDetails } : {}),
    }
  }
  if (run.state === 'needs_recovery') {
    return {
      installationId: run.installation_id,
      status: 'needs_recovery',
      runId: run.id,
      ...(run.failure_code ? { reason: run.failure_code } : {}),
    }
  }
  if (run.state === 'cancelled' && run.failure_code === 'superseded_by_disconnect') {
    return {
      installationId: run.installation_id,
      status: 'superseded',
      runId: run.id,
    }
  }
  return {
    installationId: run.installation_id,
    status: 'failed',
    runId: run.id,
    ...(run.failure_code ? { reason: run.failure_code } : {}),
  }
}

function normalizeCustomDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (normalized.length < 1 || normalized.length > 80 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new Error('Custom Agent name must contain 1 to 80 visible characters')
  }
  return normalized
}

function sha256String(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeSelectorKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)) {
    throw new Error('Custom MCP selector key contains unsupported characters')
  }
  if (value === '__proto__' || value === 'prototype' || value === 'constructor') {
    throw new Error('Custom MCP selector key is reserved')
  }
  return value
}

function canonicalCustomDirectory(value: string, homeDir: string): string {
  if (!path.isAbsolute(value) || value.length > 4096 || value.includes('\0')) {
    throw new Error('Custom configuration root must be an absolute local path')
  }
  const canonical = fs.realpathSync(path.resolve(value))
  const stat = fs.lstatSync(canonical)
  if (!stat.isDirectory()) throw new Error('Custom configuration root must be a directory')
  assertWithinCustomConfigDomain(canonical, homeDir)
  return canonical
}

function canonicalCustomFile(value: string, configHomeDir: string | undefined): string {
  if (!path.isAbsolute(value) || value.length > 4096 || value.includes('\0')) {
    throw new Error('Custom target must be an absolute local path')
  }
  const canonical = fs.realpathSync(path.resolve(value))
  if (!fs.lstatSync(canonical).isFile()) throw new Error('Custom target must be a regular file')
  if (configHomeDir) assertWithinCustomConfigDomain(canonical, configHomeDir)
  return canonical
}

function assertWithinCustomConfigDomain(target: string, homeDir: string): void {
  const relative = path.relative(homeDir, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Custom Agent configuration must stay inside the current user home')
  }
}

function customInstallKey(value: Record<string, unknown>): string {
  return `custom-local:${createHash('sha256').update(sha256Json(value)).digest('hex')}`
}

function parseStoredMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function relocateCustomRootMetadata(
  metadata: Record<string, unknown>,
  sourceRoot: string,
  customRoot: string,
): {
  componentConfigFiles: Readonly<Record<string, string>>
  componentConfigRoots: Readonly<Record<string, string>>
  resourceRoots: Readonly<Record<string, string>>
} {
  const relocate = (value: unknown, label: string, allowRoot: boolean): Readonly<Record<string, string>> => {
    if (value === undefined || value === null) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`the selected source host has invalid ${label} metadata`)
    }
    const result: Record<string, string> = {}
    for (const [key, rawPath] of Object.entries(value as Record<string, unknown>)) {
      if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) {
        throw new Error(`the selected source host has an invalid ${label} path`)
      }
      const relative = path.relative(path.resolve(sourceRoot), path.resolve(rawPath))
      if (relative.startsWith('..') || path.isAbsolute(relative) || (!allowRoot && relative === '')) {
        throw new Error(`the selected source host's ${label} cannot be safely relocated to an isolated custom root`)
      }
      result[key] = relative === '' ? path.resolve(customRoot) : path.join(path.resolve(customRoot), relative)
    }
    return result
  }
  return {
    componentConfigFiles: relocate(metadata.componentConfigFiles, 'component config file', false),
    componentConfigRoots: relocate(metadata.componentConfigRoots, 'component config root', true),
    resourceRoots: relocate(metadata.resourceRoots, 'resource root', true),
  }
}

function isUserGuidedCoworkRow(row: AgentInstallationRow): boolean {
  const metadata = parseStoredMetadata(row.metadata_json)
  const guided = metadata.guidedInstallation
  return Boolean(
    guided
    && typeof guided === 'object'
    && !Array.isArray(guided)
    && (guided as Record<string, unknown>).kind === 'claude_cowork_plugin_upload'
    && (guided as Record<string, unknown>).hostLoaded === false,
  )
}

function redactPath(value: string | null, homeDir: string): string | null {
  if (!value) return null
  const resolved = path.resolve(value)
  const relativeHome = path.relative(homeDir, resolved)
  if (relativeHome === '') return '~'
  if (!relativeHome.startsWith(`..${path.sep}`) && relativeHome !== '..' && !path.isAbsolute(relativeHome)) {
    return `~/${relativeHome}`
  }
  return path.isAbsolute(value) ? `<absolute>/${path.basename(resolved)}` : path.basename(value)
}

function coworkActionDto(
  action: ClaudeCoworkPluginRequiredUserAction,
  homeDir: string,
): AgentIntegrationRequiredUserActionDto {
  return {
    kind: action.kind,
    componentKey: action.componentKey,
    operation: action.operation,
    instruction: action.instruction,
    packageLabel: redactPath(action.packagePath, homeDir) ?? action.packageName,
    packageName: action.packageName,
    packageHash: action.packageHash,
    steps: [...action.steps],
  }
}

function userActionDto(
  action: import('./types.js').RequiredUserActionDetail,
  homeDir: string,
): AgentIntegrationRequiredUserActionDto[] {
  if (action.kind === 'codex_hook_trust') {
    return [{
      kind: action.kind,
      componentKey: action.componentKey,
      instruction: action.instruction,
      sourceLabel: redactPath(action.sourcePath, homeDir) ?? path.basename(action.sourcePath),
      hookKeyHash: action.hookKeyHash,
      ownedFragmentHash: action.ownedFragmentHash,
      hostCurrentHash: action.hostCurrentHash,
    }]
  }
  if (action.kind === 'claude_cowork_plugin_upload') return [coworkActionDto(action, homeDir)]
  if (action.kind === 'qwenwork_mcp_gui' || action.kind === 'custom_mcp_import') {
    return [{
      ...(action.kind === 'custom_mcp_import'
        ? { kind: action.kind, usageGuide: action.usageGuide } : { kind: action.kind }),
      componentKey: action.componentKey,
      operation: action.operation,
      instruction: action.instruction,
      connectorName: action.connectorName,
      serverType: action.serverType,
      command: action.command,
      args: [...action.args],
      environment: { ...action.environment },
      configurationJson: action.configurationJson,
      connectorConfigurationHash: action.connectorConfigurationHash,
      steps: [...action.steps],
    }]
  }
  if (action.kind === 'mcp_activation') {
    const configLabel = redactPath(action.configPath, homeDir) ?? path.basename(action.configPath)
    return [{
      kind: action.kind,
      componentKey: action.componentKey,
      operation: action.operation,
      instruction: sanitizeUserActionInstruction(action.instruction, action.configPath, configLabel),
      hostVariant: action.hostVariant,
      serverName: action.serverName,
      configLabel,
      reason: action.reason,
    }]
  }
  if (action.kind === 'manual_file_removal') {
    const physicalTargetLabel = redactPath(action.physicalTarget, homeDir) ?? path.basename(action.physicalTarget)
    return [{
      kind: action.kind,
      componentKey: action.componentKey,
      operation: action.operation,
      instruction: sanitizeUserActionInstruction(
        action.instruction,
        action.physicalTarget,
        physicalTargetLabel,
      ),
      physicalTargetLabel,
      ownedFragmentHash: action.ownedFragmentHash,
    }]
  }
  if (action.kind === 'kimi_instruction_conflict') {
    const sourceLabel = redactPath(action.sourcePath, homeDir) ?? path.basename(action.sourcePath)
    const targetLabel = redactPath(action.targetPath, homeDir) ?? path.basename(action.targetPath)
    return [{
      kind: action.kind,
      componentKey: action.componentKey,
      operation: action.operation,
      reason: action.reason,
      instruction: sanitizeUserActionPaths(action.instruction, [
        [action.sourcePath, sourceLabel], [action.targetPath, targetLabel],
      ]),
      sourceLabel,
      targetLabel,
      steps: action.steps.map(step => sanitizeUserActionPaths(step, [
        [action.sourcePath, sourceLabel], [action.targetPath, targetLabel],
      ])),
    }]
  }
  return []
}

function requiredUserActionsFromPreparedPlanJson(
  preparedPlanJson: string | undefined,
  homeDir: string,
): AgentIntegrationRequiredUserActionDto[] {
  try {
    if (!preparedPlanJson) return []
    const prepared = JSON.parse(preparedPlanJson) as PreparedCoordinatorPlan
    const actions = prepared?.adapterPlan?.requiredUserActionDetails
    if (!Array.isArray(actions)) return []
    return actions.flatMap(action => {
      try { return userActionDto(action, homeDir) } catch { return [] }
    })
  } catch {
    return []
  }
}

function sanitizeUserActionInstruction(instruction: string, rawPath: string, pathLabel: string): string {
  return sanitizeDiagnostic(instruction.split(rawPath).join(pathLabel))
}

function sanitizeUserActionPaths(instruction: string, paths: readonly (readonly [string, string])[]): string {
  return sanitizeDiagnostic(paths.reduce(
    (value, [rawPath, pathLabel]) => value.split(rawPath).join(pathLabel),
    instruction,
  ))
}

function scopeFor(value: string | null, homeDir: string): AgentIntegrationPlanTargetDto['scope'] {
  if (!value) return 'other'
  const resolved = path.resolve(value)
  if (resolved.includes(`${path.sep}.git${path.sep}`) || resolved.includes(`${path.sep}.vscode${path.sep}`)) return 'project'
  const relativeHome = path.relative(homeDir, resolved)
  if (relativeHome === '' || (!relativeHome.startsWith(`..${path.sep}`) && relativeHome !== '..')) return 'user'
  if (resolved.startsWith('/Applications/') || resolved.startsWith('/Library/')) return 'system'
  return 'other'
}

function sanitizeArgs(args: readonly string[], homeDir: string): string[] {
  let redactNext = false
  return args.map(arg => {
    if (redactNext) {
      redactNext = false
      return '<redacted>'
    }
    if (/^--?(?:token|secret|password|api[-_]?key)$/iu.test(arg)) {
      redactNext = true
      return arg
    }
    if (/^--?(?:token|secret|password|api[-_]?key)=/iu.test(arg)) {
      return `${arg.slice(0, arg.indexOf('='))}=<redacted>`
    }
    if (/^(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)=/iu.test(arg)) {
      return `${arg.slice(0, arg.indexOf('='))}=<redacted>`
    }
    if (/^(?:sk|key|token|secret|bearer)[-_][A-Za-z0-9._-]{12,}$/iu.test(arg)
      || (/^[A-Za-z0-9+/=_-]{32,}$/u.test(arg) && /[A-Za-z]/u.test(arg) && /[0-9]/u.test(arg))) {
      return '<redacted>'
    }
    if (path.isAbsolute(arg)) return redactPath(arg, homeDir) ?? '<path>'
    return arg.length <= 200 ? arg : `${arg.slice(0, 197)}...`
  })
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/(^|[\s(:='"[])\/[^\s,;)'"\]<>]+/gu, '$1<local-path>')
    .replace(/\b(token|secret|password|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu, '$1=<redacted>')
    .slice(0, 500)
}

function safeErrorMessage(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error))
}

function maximumRisk(risks: readonly ('read_only' | 'low' | 'elevated' | 'high')[]) {
  const order = ['read_only', 'low', 'elevated', 'high'] as const
  return order[Math.max(0, ...risks.map(risk => order.indexOf(risk)))]
}

function capability(value: number): CapabilityLevel {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value
  return 0
}

function accessLevelFor(value: CapabilityLevel) {
  if (value === 4) return 'complete' as const
  if (value === 3) return 'basic' as const
  if (value > 0) return 'partial' as const
  return 'unconnected' as const
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

function safeProductName(familyId: string, fallback: string): string {
  try { return getCatalogProduct(familyId).displayName } catch { return fallback }
}

function compareInstallations(left: AgentIntegrationInstallationDto, right: AgentIntegrationInstallationDto): number {
  return statusRank(left.statusGroup) - statusRank(right.statusGroup)
    || left.displayName.localeCompare(right.displayName)
    || left.id.localeCompare(right.id)
}

function statusRank(status: AgentIntegrationInstallationDto['statusGroup']): number {
  return ({
    needs_attention: 0,
    awaiting_connection: 1,
    awaiting_verification: 2,
    processing: 3,
    limited: 4,
    paused: 5,
    available: 6,
    disconnected: 7,
  })[status]
}
