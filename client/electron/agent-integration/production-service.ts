import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { constants as fsConstants, type BigIntStats, type Dir, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { app } from 'electron'
import type Database from 'better-sqlite3'
import { CATALOG_SCHEMA_VERSION, CATALOG_VERSION } from './catalog.js'
import { AgentConfigRootWatcher } from './config-root-watcher.js'
import {
  AgentIntegrationCoordinator,
  type AdapterResolverPort,
  type CoordinatorClock,
  type CoordinatorIdFactory,
  type CoordinatorInstallation,
  type RecoverableExecution,
  frozenPlanInstallationSurfaceFingerprint,
  frozenPlanLiveTrustProofFingerprint,
} from './coordinator.js'
import {
  SqliteCoordinatorRepository,
  type ManagedReconcileCandidate,
} from './coordinator-repository.js'
import {
  DESKTOP_BUNDLE_SURFACE_SCHEMA,
  discoverLocalP0Agents,
  discoverClaudeCoworkGuidedCandidate,
  inspectStableDesktopBundleSurface,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  signedCodePortableArtifactFingerprint,
  signedKimiPortableArtifactFingerprint,
  type DiscoveryDependencies,
  type PackageMetadataProofNode,
  type StableFileFingerprint,
} from './discovery.js'
import {
  readStableFileMetadata,
  inspectPassiveCliVersion,
  kimiNativeExecutablePortableArtifactFingerprint,
  MAX_PACKAGE_TREE_DEPTH,
  MAX_PACKAGE_TREE_DIRECTORIES,
  MAX_STANDALONE_PACKAGE_TREE_DIRECTORIES,
  MAX_PACKAGE_TREE_ENTRIES_PER_DIRECTORY,
  MAX_PACKAGE_TREE_FILES,
  readStableFileFingerprint,
  readStableFileSnapshot,
  readStablePackageTree,
  verifyStablePackageTree,
} from './passive-cli-version.js'
import { sha256Json } from './fingerprint.js'
import {
  desktopSignatureReceiptFingerprint,
  inspectMacAppSignature,
  inspectMacAppSignatureSync,
} from './mac-code-signature.js'
export { inspectMacAppSignature, inspectMacAppSignatureSync } from './mac-code-signature.js'
import { parseJsoncObject } from './jsonc-document.js'
import { adoptProvableLegacyConnections } from './legacy-adoption.js'
import type { NotificationPort, UserNotification } from './events.js'
import { createP0HostAdapters } from './hosts/p0-adapter-registry.js'
import { verifyCodexHookTrustAction } from './hosts/codex-lifecycle-adapter.js'
import { SqliteHostActivityEvidenceReader } from './host-activity-evidence.js'
import { ManagedAgentReconciler, type ManagedArtifactObservation } from './reconciler.js'
import {
  AGENT_INTEGRATION_RELEASE_ENTRY_MAP,
  AGENT_INTEGRATION_RELEASE_MANIFEST,
  applyAgentReleaseGateToReport,
  agentReleaseEligibilityReason,
  agentReleaseSurfaceEligibilityReason,
  isAgentReleaseGateReason,
  resolveAcceptedKimiNativeReceipt,
  resolveAgentIntegrationReleasePolicy,
  type AgentIntegrationReleasePolicyMode,
} from './release-manifest.js'
import { kimiNativeReceiptLookupFingerprint } from './distribution-artifact.js'
import {
  AgentIntegrationService,
  isCustomInstallationManagementContractValid,
  type AgentIntegrationExecutionPort,
  type AgentIntegrationServiceDependencies,
  type AgentIntegrationScannerPort,
} from './service.js'
import {
  AgentIntegrationRepository,
  frozenProjectionSurfaceFingerprint,
  persistedComponentConfigRoots,
  persistedComponentConfigFiles,
  persistedDistribution,
  persistedHostOwnedIdentity,
  persistedManagementEligibility,
  persistedProjectionSurfaceFingerprint,
  type AgentInstallationRow,
} from './repository.js'
import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterRuntimeContext,
  AgentHostAdapter,
  CatalogId,
  ComponentKey,
} from './types.js'
import {
  getHookScriptPath,
  getMcpServerScriptPath,
  getPostCompactHookScriptPath,
  getPreCompactHookScriptPath,
  getShimPath,
} from '../runtime/runtime-paths.js'

const DEFAULT_MAINTENANCE_INTERVAL_MS = 4 * 60 * 60 * 1_000
let executionPort: AgentIntegrationExecutionPort | null = null
let productionRuntime: ProductionAgentIntegrationRuntime | null = null
let productionRuntimeStarter: (() => Promise<void>) | null = null

/** Bound only to the reviewed, gated runtime; the IPC service never writes host state directly. */
export function bindAgentIntegrationExecutionPort(port: AgentIntegrationExecutionPort): () => void {
  executionPort = port
  return () => {
    if (executionPort === port) executionPort = null
  }
}

const lazyExecutionPort: AgentIntegrationExecutionPort = {
  preview(request) {
    if (!executionPort) throw new Error('Agent integration execution runtime is not ready')
    return executionPort.preview(request)
  },
  applyPrepared(request) {
    if (!executionPort) throw new Error('Agent integration execution runtime is not ready')
    return executionPort.applyPrepared(request)
  },
}

export interface ProductionAgentIntegrationOptions {
  homeDir?: string
  applicationDataDir?: string
  runtimeContext?: AdapterRuntimeContext
  adapters?: ReadonlyMap<CatalogId, AgentHostAdapter>
  /** Explicit embedding/test seam; production callers should use distribution trust. */
  canManageInstallation?: (installation: AgentInstallationRow) => boolean
  /** Hermetic test seam; production re-attests package metadata or code signature. */
  liveTrustAttestor?: (installation: AgentInstallationRow) => Promise<string | null>
  enabledAdapterIds?: readonly CatalogId[]
  observeOnly?: boolean
  autoRestore?: boolean
  notifications?: NotificationPort
  notificationLocale?: string | (() => string)
  onOpenInstallation?: (installationId: string) => void | Promise<void>
  onInAppNotification?: (notification: UserNotification) => void | Promise<void>
  isAppActive?: () => boolean
  clock?: CoordinatorClock
  ids?: CoordinatorIdFactory
  discoveryDependencies?: DiscoveryDependencies
  /** Hermetic embedding seam; production callers use passive local discovery. */
  scanner?: AgentIntegrationScannerPort
  /** Isolated-fixture seam; production uses the official Codex persisted-state verifier. */
  codexHookTrustVerifier?: AgentIntegrationServiceDependencies['verifyCodexHookTrust']
  maintenanceIntervalMs?: number
  startRuntime?: boolean
  fixtureMode?: 'isolated_ui_audit'
}

export interface ProductionAgentIntegrationComposition {
  service: AgentIntegrationService
  coordinator: AgentIntegrationCoordinator
  repository: AgentIntegrationRepository
  coordinatorRepository: SqliteCoordinatorRepository
  runtime: ProductionAgentIntegrationRuntime
  observeOnly: boolean
  enabledAdapterIds: readonly CatalogId[]
  releasePolicyMode: AgentIntegrationReleasePolicyMode
  releasePolicyDiagnostics: readonly string[]
}

/**
 * The OS lock must outlive Electron channel/data-dir boundaries. Stable,
 * Beta, Dev and embedded ledgers owned by the same OS user therefore share a
 * single physical-domain lock root. The synthetic UI audit keeps its explicit
 * temporary HOME so it never touches the real user domain.
 */
export function productionAgentIntegrationWriterLockDirectory(input: {
  fixtureMode?: 'isolated_ui_audit'
  homeDir?: string
  /** Deliberately ignored: channel-specific data roots must not split the lock. */
  applicationDataDir?: string
} = {}): string {
  const userRoot = path.resolve(input.homeDir ?? os.homedir())
  return path.join(userRoot, '.tidemind', 'agent-integration', 'writer-locks')
}

/**
 * Production composition root. The signed-build release manifest is the
 * default allowlist; runtime options and environment variables can only narrow
 * it or force the entire integration surface read-only.
 */
export function createProductionAgentIntegrationComposition(
  db: Database.Database,
  options: ProductionAgentIntegrationOptions = {},
): ProductionAgentIntegrationComposition {
  const injectedTrustSeams = [
    options.canManageInstallation && 'canManageInstallation',
    options.liveTrustAttestor && 'liveTrustAttestor',
    options.codexHookTrustVerifier && 'codexHookTrustVerifier',
  ].filter((value): value is string => Boolean(value))
  if (injectedTrustSeams.length > 0 && options.fixtureMode !== 'isolated_ui_audit') {
    throw new Error(`production_trust_seam_injection_forbidden:${injectedTrustSeams.join(',')}`)
  }
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const applicationDataDir = path.resolve(options.applicationDataDir ?? app.getPath('userData'))
  const allAdapters = options.adapters ?? createP0HostAdapters()
  const implementedComponents = new Map(
    [...allAdapters].map(([catalogId, adapter]) => {
      const released = new Set(AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(catalogId)?.requiredComponents
        ?? (catalogId === 'custom-local-mcp' ? adapter.componentKeys : []))
      return [catalogId, adapter.componentKeys.filter(componentKey => released.has(componentKey))] as const
    }),
  )
  const implementedArtifactTypes = new Map(
    [...allAdapters].map(([catalogId, adapter]) => {
      const released = new Set(AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(catalogId)?.requiredComponents
        ?? (catalogId === 'custom-local-mcp' ? adapter.componentKeys : []))
      return [catalogId, Object.fromEntries(Object.entries(adapter.implementationTypes)
        .filter(([componentKey]) => released.has(componentKey as ComponentKey)))] as const
    }),
  )
  const connectOptionalComponents = new Map(
    [...allAdapters].map(([catalogId, adapter]) => {
      const released = new Set(AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(catalogId)?.requiredComponents
        ?? (catalogId === 'custom-local-mcp' ? adapter.componentKeys : []))
      return [catalogId, (adapter.connectOptionalComponentKeys ?? [])
        .filter(componentKey => released.has(componentKey))] as const
    }),
  )
  const releasePolicy = resolveAgentIntegrationReleasePolicy({
    adapters: allAdapters,
    restrictToAdapterIds: options.enabledAdapterIds,
    forceObserveOnly: options.observeOnly === true,
    autoRestore: options.autoRestore,
    // An injected Adapter registry is an explicit hermetic test seam. The
    // production registry must cover every released entry exactly.
    strictAdapterCoverage: options.adapters === undefined,
  })
  if (options.discoveryDependencies
    && releasePolicy.mode === 'active'
    && options.fixtureMode !== 'isolated_ui_audit') {
    throw new Error('production_trust_seam_injection_forbidden:discoveryDependencies')
  }
  // Injected discovery/Adapter ports are the existing explicit hermetic test
  // seam. The app composition supplies none of them and therefore always
  // re-evaluates even pre-manifest persisted rows against this signed build.
  const enforceReleaseAcceptance = options.adapters === undefined
    && options.scanner === undefined
    && options.discoveryDependencies === undefined
  const observeOnly = releasePolicy.mode !== 'active'
  const customAdapterActive = !observeOnly
    && releasePolicy.customLocalAgentEnabled
    && allAdapters.has('custom-local-mcp')
  const activeAdapterIds = [...new Set<CatalogId>([
    ...releasePolicy.enabledAdapterIds,
    ...(customAdapterActive ? ['custom-local-mcp' as const] : []),
  ])]
  const activeAdapterSet = new Set(activeAdapterIds)
  const managedAdapters: AdapterResolverPort = {
    get: id => activeAdapterSet.has(id) ? allAdapters.get(id) : undefined,
  }
  // A rollout/kill switch blocks new work, but persisted non-terminal runs must
  // still be recoverable through their reviewed Adapter implementation.
  const recoveryAdapters: AdapterResolverPort = {
    get: id => id === 'custom-local-mcp' && !customAdapterActive ? undefined : allAdapters.get(id),
  }
  const clock = options.clock ?? { now: () => new Date() }
  const ids = options.ids ?? { next: prefix => `${prefix}_${randomUUID()}` }
  const notificationLocale = options.notificationLocale ?? 'en'
  const notifications = options.notifications ?? productionNotifications({
    onOpenInstallation: options.onOpenInstallation,
    onInAppNotification: options.onInAppNotification,
    isAppActive: options.isAppActive,
  })
  const repository = new AgentIntegrationRepository(db)
  const discoveryDependencies = options.discoveryDependencies ?? productionDiscoveryDependencies(homeDir)
  const runtimeContext = options.runtimeContext ?? defaultRuntimeContext(homeDir, applicationDataDir)
  const distributionCanManageInstallation = options.canManageInstallation
    ?? (row => isProductionInstallationTrusted(row, homeDir))
  const currentReleaseReason = (row: AgentInstallationRow) => {
    const persistedReason = persistedManagementEligibility(row)?.reason
    if (isAgentReleaseGateReason(persistedReason)) return persistedReason
    if (!enforceReleaseAcceptance || row.host_variant === 'custom-local-mcp') return null
    const distribution = persistedDistribution(row)
    return agentReleaseSurfaceEligibilityReason({
      catalogId: row.host_variant as CatalogId,
      detectedVersion: row.detected_version,
      distributionId: distribution.distributionId ?? row.distribution_id,
      packageProvenance: distribution.packageProvenance,
      architecture: process.arch === 'x64' ? 'x64' : 'arm64',
      portableArtifactFingerprint: distribution.portableArtifactFingerprint,
    })
  }
  const canManageInstallation = (row: AgentInstallationRow): boolean => (
    isCustomInstallationManagementContractValid(row, repository, AGENT_INTEGRATION_RELEASE_ENTRY_MAP)
    && currentReleaseReason(row) === null
    && distributionCanManageInstallation(row)
  )
  const liveTrustAttestor = options.liveTrustAttestor
    ?? (options.canManageInstallation
      ? async (row: AgentInstallationRow) => sha256Json({
          fixtureTrust: persistedProjectionSurfaceFingerprint(row),
        })
      : createProductionLiveTrustAttestor(discoveryDependencies, {
          homeDir,
          repository,
          runtime: runtimeContext,
        }))
  const canManageCurrentInstallation = (installation: CoordinatorInstallation): boolean => {
    const current = repository.getInstallation(installation.id)
    const frozenSurface = frozenProjectionSurfaceFingerprint(installation.identity.distribution)
    return Boolean(
      current
      && frozenSurface !== null
      && frozenSurface === persistedProjectionSurfaceFingerprint(current)
      && current.install_key === installation.identity.installKey
      && current.agent_id === installation.agentId
      && current.host_variant === installation.identity.hostVariant
      && current.runtime_realm === installation.identity.runtimeRealm
      && currentReleaseReason(current) === null
      && canManageInstallation(current),
    )
  }
  const attestCurrentRow = async (
    observed: AgentInstallationRow,
    expectedProofFingerprint?: string,
  ): Promise<string | null> => {
    const before = repository.getInstallation(observed.id)
    if (!before || persistedProjectionSurfaceFingerprint(before)
      !== persistedProjectionSurfaceFingerprint(observed)
      || currentReleaseReason(before) !== null
      || !canManageInstallation(before)) return null
    const proof = await liveTrustAttestor(before)
    if (!proof || (expectedProofFingerprint && proof !== expectedProofFingerprint)) return null
    const after = repository.getInstallation(observed.id)
    return after
      && persistedProjectionSurfaceFingerprint(after) === persistedProjectionSurfaceFingerprint(before)
      && currentReleaseReason(after) === null
      && canManageInstallation(after)
      ? proof
      : null
  }
  const attestCurrentInstallation = async (
    installation: CoordinatorInstallation,
    expectedProofFingerprint?: string,
  ): Promise<string | null> => {
    if (!canManageCurrentInstallation(installation)) return null
    const current = repository.getInstallation(installation.id)
    return current ? attestCurrentRow(current, expectedProofFingerprint) : null
  }
  const coordinatorRepository = new SqliteCoordinatorRepository(db, repository, {
    now: () => clock.now(),
    lockDirectory: productionAgentIntegrationWriterLockDirectory({
      fixtureMode: options.fixtureMode,
      homeDir,
      applicationDataDir,
    }),
    lockDirectoryTrustRoot: homeDir,
  })
  const coordinator = new AgentIntegrationCoordinator({
    runtime: runtimeContext,
    adapters: recoveryAdapters,
    repository: coordinatorRepository,
    notifications,
    clock,
    ids,
    catalogGeneration: CATALOG_SCHEMA_VERSION,
    adapterGeneration: adapter => numericGeneration(adapter.adapterVersion),
    projectionGeneration: () => numericGeneration(runtimeContext.projectionVersion),
    installationSurfaceFingerprint: installation => (
      frozenProjectionSurfaceFingerprint(installation.identity.distribution)
    ),
    liveTrustProof: installation => attestCurrentInstallation(installation),
    authorizeEffect: async (installation, binding) => Boolean(
      binding.installationSurfaceFingerprint
      && binding.liveTrustProofFingerprint
      && canManageCurrentInstallation(installation)
      && await attestCurrentInstallation(installation, binding.liveTrustProofFingerprint),
    ),
    hostActivityEvidence: new SqliteHostActivityEvidenceReader(db),
    codexHookTrustEvidence: repository,
    guidedRemovalEvidence: repository,
  })
  const reconciler = new ManagedAgentReconciler({
    coordinator,
    repository: coordinatorRepository,
    notifications,
    clock,
    ids: { next: prefix => `${prefix}_${randomUUID()}` },
    locale: notificationLocale,
  })
  const runtime = new ProductionAgentIntegrationRuntime({
    coordinator,
    coordinatorRepository,
    reconciler,
    adapters: managedAdapters,
    runtimeContext,
    observeOnly,
    autoRestore: releasePolicy.autoRestore,
    canManageInstallation: installation => attestCurrentInstallation(installation).then(Boolean),
    canContinueRecovery: async execution => {
      if (execution.runState === 'verified') {
        const current = repository.getInstallation(execution.installationId)
        return Boolean(
          execution.installationSurfaceFingerprint
          && execution.liveTrustProofFingerprint
          && current
          && execution.installationSurfaceFingerprint === persistedProjectionSurfaceFingerprint(current)
          && await attestCurrentRow(current, execution.liveTrustProofFingerprint),
        )
      }
      const expectedSurface = frozenPlanInstallationSurfaceFingerprint(execution.preparedPlan)
      const expectedProof = frozenPlanLiveTrustProofFingerprint(execution.preparedPlan)
      const current = repository.getInstallation(execution.installation.id)
      return Boolean(
        expectedSurface
        && expectedProof
        && current
        && expectedSurface === persistedProjectionSurfaceFingerprint(current)
        && canManageCurrentInstallation(execution.installation)
        && await attestCurrentInstallation(execution.installation, expectedProof),
      )
    },
  })
  const scanner = options.scanner ?? (options.discoveryDependencies
    ? createProductionScanner(homeDir, discoveryDependencies)
    : releaseGatedScanner(createProductionScanner(homeDir, discoveryDependencies)))
  const configRootWatcher = new AgentConfigRootWatcher({
    allowedRoots: [homeDir, applicationDataDir],
    onChange: () => service.scan().then(() => undefined),
    onDiagnostic: diagnostic => repository.recordEvent({
      kind: 'config_root_watch_diagnostic',
      severity: 'warning',
      dedupeKey: diagnostic,
      payload: { diagnostic },
      createdAt: clock.now().toISOString(),
    }),
  })
  runtime.onStop(() => configRootWatcher.close())
  const refreshConfigRootWatches = () => {
    const roots = repository.listInstallations()
      .filter(row => row.desired_state !== 'removed' && canManageInstallation(row))
      .map(row => row.config_root)
      .filter((root): root is string => typeof root === 'string' && root.length > 0)
    configRootWatcher.update(roots)
  }
  const refreshVerificationFreshness = () => {
    repository.refreshVerificationFreshness({
      now: clock.now().toISOString(),
      osVersion: os.release(),
      catalogVersion: runtimeContext.catalogVersion,
      projectionVersion: runtimeContext.projectionVersion,
      tideMindVersion: runtimeContext.tideMindVersion,
      adapterVersion: hostVariant => allAdapters.get(hostVariant as CatalogId)?.adapterVersion,
    })
  }
  const service = new AgentIntegrationService({
    repository,
    scanner,
    execution: lazyExecutionPort,
    beforeScan: () => runtime.markScanStarted(),
    afterScan: async () => {
      try {
        await adoptProvableLegacyConnections({
          repository,
          adapters: allAdapters,
          runtime: runtimeContext,
          now: clock.now().toISOString(),
        })
      } catch (error) {
        repository.recordEvent({
          kind: 'legacy_adoption_scan_failed',
          severity: 'error',
          dedupeKey: 'legacy_adoption_scan_failed',
          payload: { message: error instanceof Error ? error.message : String(error) },
          createdAt: clock.now().toISOString(),
        })
      } finally {
        // Recovery may finalize a previously verified run. Invalidate any
        // version/generation drift from this fresh scan before allowing that
        // finalizer to promote the ledger.
        refreshVerificationFreshness()
        await runtime.markScanCompleted()
        refreshConfigRootWatches()
      }
    },
    afterCircuitReset: () => runtime.runMaintenance(),
    afterDisconnect: () => runtime.runMaintenance(),
    afterResume: () => runtime.triggerScan(),
    refreshVerificationFreshness,
    notifications,
    notificationLocale,
    now: () => clock.now(),
    homeDir,
    customMcpRuntime: {
      shimPath: runtimeContext.shimPath,
      mcpServerPath: runtimeContext.mcpServerPath,
    },
    coworkGuidedRuntime: { applicationDataDir },
    fixtureMode: options.fixtureMode,
    enabledCatalogIds: activeAdapterIds,
    implementedComponents,
    implementedArtifactTypes,
    connectOptionalComponents,
    releaseEntries: AGENT_INTEGRATION_RELEASE_ENTRY_MAP,
    enforceReleaseAcceptance,
    releasePolicy: {
      manifestVersion: releasePolicy.manifestVersion,
      mode: releasePolicy.mode,
      customLocalAgentEnabled: releasePolicy.customLocalAgentEnabled,
      diagnostics: releasePolicy.diagnostics,
    },
    canManageInstallation,
    cliManagementProofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    attestInstallation: async (row, expectedProof) => Boolean(
      await attestCurrentRow(row, expectedProof),
    ),
    verifyCodexHookTrust: options.codexHookTrustVerifier ?? (async ({ installation, hostVersion, action }) => (
      verifyCodexHookTrustAction({
        runtime: runtimeContext,
        installation: installation.identity,
        installationId: installation.id,
        hostVersion,
        agentId: installation.agentId,
        operationId: ids.next('operation'),
        codexHookTrustEvidence: repository,
      }, action)
    )),
    afterCodexHookTrust: () => runtime.runMaintenance(),
    afterGuidedRemoval: () => runtime.runMaintenance(),
    probeCustomInstallation: customAdapterActive
      ? async row => row.host_variant === 'custom-local-mcp'
        ? Boolean(await attestCurrentRow(row))
        : probeNonstandardCustomInstallation(row, homeDir, repository, attestCurrentRow)
      : undefined,
  })
  runtime.configureScheduler(
    () => service.scan().then(() => undefined),
    options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
    true,
  )
  return {
    service,
    coordinator,
    repository,
    coordinatorRepository,
    runtime,
    observeOnly,
    enabledAdapterIds: activeAdapterIds,
    releasePolicyMode: releasePolicy.mode,
    releasePolicyDiagnostics: releasePolicy.diagnostics,
  }
}

const TRUSTED_APP_BUNDLE_IDS: Readonly<Partial<Record<CatalogId, readonly string[]>>> = Object.freeze({
  'claude-cowork-local': ['com.anthropic.claudefordesktop'],
  'claude-desktop-legacy': ['com.anthropic.claudefordesktop'],
  'codex-desktop': ['com.openai.codex'],
  'cursor-desktop': ['com.todesktop.230313mzl4w4u92'],
  'windsurf-desktop': ['com.exafunction.windsurf'],
  'qwenwork-desktop': ['cn.qwenwork.desktop.mac'],
  'zcode-desktop': ['dev.zcode.app'],
})

const TRUSTED_SIGNED_APP_PROVENANCE: Readonly<Partial<Record<CatalogId, readonly string[]>>> = Object.freeze({
  'claude-cowork-local': ['signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW'],
  'claude-desktop-legacy': ['signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW'],
  'codex-desktop': ['signed_app:com.openai.codex:2DC432GLL2'],
  'cursor-desktop': ['signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9'],
  'windsurf-desktop': ['signed_app:com.exafunction.windsurf:83Z2LHX6XW'],
  'qwenwork-desktop': ['signed_app:cn.qwenwork.desktop.mac:XN6U3EV979'],
  'zcode-desktop': ['signed_app:dev.zcode.app:8A5X4JJ39T'],
})

const TRUSTED_CLI_PROVENANCE: Readonly<Partial<Record<CatalogId, readonly string[]>>> = Object.freeze({
  'claude-code-cli': ['npm_metadata:@anthropic-ai/claude-code'],
  'codex-cli': ['npm_metadata:@openai/codex'],
  'gemini-cli': ['npm_metadata:@google/gemini-cli'],
  'kimi-code-cli': ['npm_metadata:@moonshot-ai/kimi-code'],
  'openclaw-local': ['npm_metadata:openclaw'],
  'qwen-code-cli': ['npm_metadata:@qwen-code/qwen-code'],
  'opencode-v1-cli': ['npm_metadata:opencode-ai'],
  'opencode-v2-beta-cli': ['npm_metadata:@opencode-ai/cli'],
  // The historical Mario distribution remains discoverable for migration
  // visibility, but only the maintained Earendil API has a writable Adapter.
  'pi-official-cli': ['npm_metadata:@earendil-works/pi-coding-agent'],
  'omp-cli': ['npm_metadata:@oh-my-pi/pi-coding-agent'],
})

const TRUSTED_SIGNED_CLI_PROVENANCE: Readonly<Partial<Record<CatalogId, readonly string[]>>> = Object.freeze({
  'claude-code-native': ['signed_cli:com.anthropic.claude-code:Q6L2SF6YDW'],
  'kimi-code-native': ['signed_cli:kimi:2J9472RW75'],
})
const SIGNED_CLI_SURFACE_SCHEMA = 'signed-cli-surface-v1'
const KIMI_SIGNED_CLI_SURFACE_SCHEMA = 'signed-cli-kimi-receipt-lookup-v1'

const CUSTOM_MCP_SCHEMAS = new Set([
  'standard_mcp_servers',
  'nested_mcp_servers',
  'opencode_mcp',
])
const CUSTOM_CONFIG_PROOF_LIMIT_BYTES = 1024 * 1024

interface CustomMcpTrustBinding {
  userOwned: boolean
  executablePath: string
  executableFingerprint: string
  executableSize: number
  configPath: string
  configFingerprint: string
  schemaKind: 'standard_mcp_servers' | 'nested_mcp_servers' | 'opencode_mcp'
  selectorKey: string
  selector: readonly string[]
  ownershipKey: string
}

async function probeNonstandardCustomInstallation(
  row: AgentInstallationRow,
  homeDir: string,
  repository: AgentIntegrationRepository,
  attestCurrentRow: (row: AgentInstallationRow) => Promise<string | null>,
): Promise<boolean> {
  if (!isCustomInstallationManagementContractValid(row, repository, AGENT_INTEGRATION_RELEASE_ENTRY_MAP)
    || row.family !== 'custom-local-agent'
    || row.host_variant === 'custom-local-mcp'
    || row.runtime_realm !== 'local_macos'
    || !row.config_root) return false
  let metadata: Record<string, unknown>
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    metadata = parsed as Record<string, unknown>
  } catch {
    return false
  }
  const custom = metadata.customInstallation
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return false
  const values = custom as Record<string, unknown>
  if (values.kind !== 'nonstandard_config_root'
    || typeof values.sourceInstallationId !== 'string'
    || typeof values.sourceHostVariant !== 'string'
    || typeof values.sourceInstallKey !== 'string'
    || typeof values.sourceSurfaceFingerprint !== 'string'
    || typeof values.configFingerprint !== 'string') return false

  const root = path.resolve(row.config_root)
  const relativeHome = path.relative(path.resolve(homeDir), root)
  if (relativeHome === '..' || relativeHome.startsWith(`..${path.sep}`) || path.isAbsolute(relativeHome)) return false
  try {
    const lstat = fsSync.lstatSync(root, { bigint: true })
    if (lstat.isSymbolicLink() || !lstat.isDirectory() || fsSync.realpathSync(root) !== root) return false
    const fingerprint = sha256Json({
      realpath: root,
      device: String(lstat.dev),
      inode: String(lstat.ino),
      mode: String(lstat.mode),
    })
    if (fingerprint !== values.configFingerprint) return false
  } catch {
    return false
  }

  const source = repository.getInstallation(values.sourceInstallationId)
  return Boolean(
    source
    && source.desired_state !== 'removed'
    && source.health_state === 'discovered'
    && persistedProjectionSurfaceFingerprint(source) === values.sourceSurfaceFingerprint
    && await attestCurrentRow(source),
  )
}

function customMcpTrustBinding(
  row: AgentInstallationRow,
  homeDir: string,
): CustomMcpTrustBinding | null {
  if (row.family !== 'custom-local-agent'
    || row.host_variant !== 'custom-local-mcp'
    || row.runtime_realm !== 'local_macos'
    || row.health_state !== 'discovered'
    || row.provenance !== 'user_selected_local_executable'
    || !row.agent_id
    || !row.config_root
    || !row.executable_path) return null
  let metadata: Record<string, unknown>
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    metadata = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const custom = metadata.customInstallation
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return null
  const values = custom as Record<string, unknown>
  const schemaKind = values.schemaKind
  const userOwned = values.configurationOwnership === 'user'
  const selectorKey = values.selectorKey
  const configFingerprint = values.configFingerprint
  const executableFingerprint = values.executableFingerprint
  if (values.kind !== 'manual_mcp_client'
    || typeof schemaKind !== 'string'
    || !CUSTOM_MCP_SCHEMAS.has(schemaKind)
    || typeof selectorKey !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(selectorKey)
    || ['__proto__', 'constructor', 'prototype'].includes(selectorKey)
    || typeof configFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(configFingerprint)
    || typeof executableFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(executableFingerprint)) return null

  const distribution = persistedDistribution(row)
  const eligibility = persistedManagementEligibility(row)
  let configFiles: ReturnType<typeof persistedComponentConfigFiles>
  try {
    configFiles = persistedComponentConfigFiles(row)
  } catch {
    return null
  }
  const executablePath = path.resolve(row.executable_path)
  const configPath = userOwned ? '' : configFiles?.memory_tools
  const configRoot = path.resolve(row.config_root)
  const canonicalHome = path.resolve(homeDir)
  const relativeHome = path.relative(canonicalHome, configRoot)
  if (!path.isAbsolute(row.executable_path)
    || !path.isAbsolute(row.config_root)
    || (!userOwned && (!configPath || !path.isAbsolute(configPath)
      || path.dirname(path.resolve(configPath)) !== configRoot))
    || relativeHome === '..'
    || relativeHome.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeHome)
    || (!userOwned && !['.json', '.jsonc'].includes(path.extname(configPath!).toLowerCase()))
    || distribution.executableRealpath !== executablePath
    || distribution.packageProvenance !== 'user_selected_local_executable'
    || eligibility?.eligible !== true
    || !Number.isSafeInteger(eligibility.executableSizeBytes)
    || (eligibility.executableSizeBytes ?? -1) < 0) return null

  const typedSchema = schemaKind as CustomMcpTrustBinding['schemaKind']
  const expectedCapability = `custom-local-surface:${sha256Json({
    executableFingerprint,
    configFingerprint,
    schemaKind: typedSchema,
    selectorKey,
  })}`
  const executableDigest = row.distribution_id?.match(/^custom-local-executable:([a-f0-9]{16})$/u)?.[1]
  if (!executableDigest
    || row.detected_version !== `custom-${executableDigest}`
    || row.version_detection_method !== 'user_selected_executable_fingerprint'
    || distribution.capabilityFingerprint !== expectedCapability
    || row.profile_id !== `${userOwned ? 'custom-guided' : 'custom-mcp'}:${typedSchema}:${selectorKey}`
    || row.install_key !== customMcpInstallKey({
      mode: 'manual_mcp_client',
      executablePath,
      configFilePath: userOwned ? '' : path.resolve(configPath!),
      schemaKind: typedSchema,
      selectorKey,
    })) return null

  const selector = typedSchema === 'standard_mcp_servers'
    ? ['mcpServers', selectorKey]
    : typedSchema === 'nested_mcp_servers'
      ? ['mcp', 'servers', selectorKey]
      : ['mcp', selectorKey]
  return {
    userOwned,
    executablePath,
    executableFingerprint,
    executableSize: eligibility.executableSizeBytes!,
    configPath: userOwned ? '' : path.resolve(configPath!),
    configFingerprint,
    schemaKind: typedSchema,
    selector,
    selectorKey,
    ownershipKey: selector.join('.'),
  }
}

function customMcpInstallKey(value: Record<string, unknown>): string {
  return `custom-local:${createHash('sha256').update(sha256Json(value)).digest('hex')}`
}

function isExactDesktopMainExecutable(appPath: string, executablePath: string): boolean {
  const executableRoot = path.resolve(appPath, 'Contents', 'MacOS')
  const relative = path.relative(executableRoot, path.resolve(executablePath))
  return Boolean(
    relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && path.dirname(relative) === '.',
  )
}

/**
 * A same-named PATH binary is discovery evidence, not write authority. This
 * predicate is deliberately narrower than detection and is consulted again at
 * preview time so a renderer cannot promote an unproven distribution.
 */
export function isProductionInstallationTrusted(
  row: AgentInstallationRow,
  homeDir = os.homedir(),
): boolean {
  // A persisted distribution receipt is not current host-presence evidence.
  // Every writable channel must wait for one authoritative fresh scan.
  if (row.health_state !== 'discovered') return false
  const eligibility = persistedManagementEligibility(row)
  if (isAgentReleaseGateReason(eligibility?.reason)) return false
  if (row.host_variant === 'custom-local-mcp') {
    return customMcpTrustBinding(row, homeDir) !== null
  }
  const distribution = persistedDistribution(row)
  const bundleIds = TRUSTED_APP_BUNDLE_IDS[row.host_variant as CatalogId]
  if (bundleIds) {
    if (!row.app_path || !distribution.executableRealpath || !row.executable_path
      || !isExactDesktopMainExecutable(row.app_path, distribution.executableRealpath)
      || path.resolve(distribution.executableRealpath) !== path.resolve(row.executable_path)) return false
    if (!distribution.capabilityFingerprint?.startsWith(`${DESKTOP_BUNDLE_SURFACE_SCHEMA}:`)) return false
    if (!distribution.distributionId || !bundleIds.includes(distribution.distributionId)) return false
    const approvedProvenance = TRUSTED_SIGNED_APP_PROVENANCE[row.host_variant as CatalogId] ?? []
    return Boolean(
      distribution.packageProvenance
      && approvedProvenance.includes(distribution.packageProvenance),
    )
  }

  if (eligibility?.eligible !== true) return false
  const explicitExecutableRealpath = persistedExplicitExecutableRealpath(row)
  if (!explicitExecutableRealpath || !row.executable_path
    || !path.isAbsolute(explicitExecutableRealpath)
    || !path.isAbsolute(row.executable_path)
    || path.resolve(explicitExecutableRealpath) !== path.resolve(row.executable_path)) return false
  const provenance = distribution.packageProvenance
  const allowedPackageProvenance = TRUSTED_CLI_PROVENANCE[row.host_variant as CatalogId] ?? []
  const allowedSignedProvenance = TRUSTED_SIGNED_CLI_PROVENANCE[row.host_variant as CatalogId] ?? []
  if (!provenance) return false
  if (allowedSignedProvenance.includes(provenance)) {
    const schema = row.host_variant === 'kimi-code-native'
      ? KIMI_SIGNED_CLI_SURFACE_SCHEMA
      : SIGNED_CLI_SURFACE_SCHEMA
    return Boolean(distribution.capabilityFingerprint?.startsWith(`${schema}:`))
  }
  return allowedPackageProvenance.includes(provenance)
}

function persistedExplicitExecutableRealpath(row: AgentInstallationRow): string | null {
  try {
    const metadata = JSON.parse(row.metadata_json) as unknown
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
    const distribution = (metadata as Record<string, unknown>).distribution
    if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) return null
    const executableRealpath = (distribution as Record<string, unknown>).executableRealpath
    return typeof executableRealpath === 'string' && executableRealpath.length > 0
      ? executableRealpath
      : null
  } catch {
    return null
  }
}

/**
 * Re-proves the physical distribution without starting an Agent executable.
 * CLI trust comes only from the exact adjacent npm manifest; Desktop trust
 * comes only from the platform code-signing verifier on the canonical bundle.
 */
export function createProductionLiveTrustAttestor(
  dependencies: DiscoveryDependencies,
  options: {
    homeDir: string
    repository: AgentIntegrationRepository
    runtime: AdapterRuntimeContext
  } | null = null,
): (row: AgentInstallationRow) => Promise<string | null> {
  return async row => {
    if (!isProductionInstallationTrusted(row, options?.homeDir)) return null
    if (row.host_variant === 'custom-local-mcp') {
      if (!options) return null
      return attestCustomMcpInstallation(row, options)
    }
    const distribution = persistedDistribution(row)
    const provenance = distribution.packageProvenance
    const executable = distribution.executableRealpath
    const bundleIds = TRUSTED_APP_BUNDLE_IDS[row.host_variant as CatalogId]
    if (bundleIds) {
      if (!row.app_path || !executable || !provenance
        || !dependencies.inspectAppSignature || !dependencies.finalVerifyAppSignatureSync) return null
      const appPath = path.resolve(row.app_path)
      try {
        const executablePath = path.resolve(executable)
        if (!isExactDesktopMainExecutable(appPath, executablePath)) return null
        const surfaceBefore = await inspectStableDesktopBundleSurface(dependencies, appPath, 2_000)
        const frozenSurfaceFingerprint = `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:${surfaceBefore.fingerprint}`
        if (surfaceBefore.appRealpath !== appPath
          || surfaceBefore.executableRealpath !== executablePath
          || distribution.capabilityFingerprint !== frozenSurfaceFingerprint) return null
        const appBefore = await stableCanonicalNodeProof(appPath, 'directory')
        const executableBefore = await stableDesktopExecutableProof(executablePath)
        const portableExecutableBefore = dependencies.fs.readStableFileFingerprint
          ? await dependencies.fs.readStableFileFingerprint(executablePath, MAX_CLI_EXECUTABLE_PROOF_BYTES)
          : undefined
        const physicalSurfaceBefore = stableDesktopSurfaceIdentityProofSync(appPath, executablePath)
        const signature = await dependencies.inspectAppSignature(appPath, {
          timeoutMs: 2_000,
          beforeFinalVerification: async () => {
            const surfaceAfter = await inspectStableDesktopBundleSurface(dependencies, appPath, 2_000)
            const appAfter = await stableCanonicalNodeProof(appPath, 'directory')
            const executableAfter = await stableDesktopExecutableProof(executablePath)
            const portableExecutableDuring = portableExecutableBefore && dependencies.fs.readStableFileFingerprint
              ? await dependencies.fs.readStableFileFingerprint(executablePath, MAX_CLI_EXECUTABLE_PROOF_BYTES)
              : undefined
            if (surfaceAfter.fingerprint !== surfaceBefore.fingerprint
              || surfaceAfter.executableRealpath !== executablePath
              || appAfter !== appBefore || executableAfter !== executableBefore
              || (portableExecutableBefore
                && portableExecutableDuring?.fingerprint !== portableExecutableBefore.fingerprint)) {
              throw new Error('desktop_trust_physical_identity_changed_during_signature')
            }
          },
        })
        const surfaceFinal = await inspectStableDesktopBundleSurface(dependencies, appPath, 2_000)
        const appFinal = await stableCanonicalNodeProof(appPath, 'directory')
        const executableFinal = await stableDesktopExecutableProof(executablePath)
        const portableExecutableFinal = portableExecutableBefore && dependencies.fs.readStableFileFingerprint
          ? await dependencies.fs.readStableFileFingerprint(executablePath, MAX_CLI_EXECUTABLE_PROOF_BYTES)
          : undefined
        if (surfaceFinal.fingerprint !== surfaceBefore.fingerprint
          || surfaceFinal.executableRealpath !== executablePath
          || appFinal !== appBefore || executableFinal !== executableBefore
          || (portableExecutableBefore
            && portableExecutableFinal?.fingerprint !== portableExecutableBefore.fingerprint)) return null
        // The earlier awaited receipt binds publisher identity. This final
        // production-owned recursive verifier is synchronous so queued work
        // cannot mutate sealed resources before the following surface CAS.
        const finalSignature = dependencies.finalVerifyAppSignatureSync(appPath, 2_000)
        // No await is permitted after the platform's final recursive
        // attestation. This CAS binds the path now present to the
        // exact App/Info.plist/CFBundleExecutable generation frozen above.
        const physicalSurfaceFinal = stableDesktopSurfaceIdentityProofSync(appPath, executablePath)
        if (physicalSurfaceFinal !== physicalSurfaceBefore) return null
        if (!signature.valid || signature.verificationBoundary !== 'strict_final'
          || !signature.identifier || !signature.teamIdentifier
          || !finalSignature.valid || finalSignature.verificationBoundary !== 'strict_final'
          || finalSignature.identifier !== signature.identifier
          || finalSignature.teamIdentifier !== signature.teamIdentifier) return null
        const liveProvenance = `signed_app:${signature.identifier}:${signature.teamIdentifier}`
        if (liveProvenance !== provenance || !bundleIds.includes(signature.identifier)) return null
        const signatureReceiptFingerprint = desktopSignatureReceiptFingerprint(signature)
        const finalSignatureReceiptFingerprint = desktopSignatureReceiptFingerprint(finalSignature)
        const livePortableArtifactFingerprint = signedCodePortableArtifactFingerprint({
          version: row.detected_version ?? undefined,
          executable: portableExecutableFinal,
          signature: finalSignature,
        })
        if (!signatureReceiptFingerprint
          || finalSignatureReceiptFingerprint !== signatureReceiptFingerprint
          || (distribution.portableArtifactFingerprint !== undefined
            && livePortableArtifactFingerprint !== distribution.portableArtifactFingerprint)) return null
        return sha256Json({
          channel: 'signed_app',
          appPath,
          appNodeFingerprint: appBefore,
          executablePath,
          executableFileFingerprint: executableBefore,
          bundleSurfaceFingerprint: surfaceBefore.fingerprint,
          identifier: signature.identifier,
          teamIdentifier: signature.teamIdentifier,
          signatureReceiptFingerprint,
        })
      } catch {
        return null
      }
    }

    if (!executable || !provenance || !dependencies.fs.readStableFileFingerprint) return null
    const readExecutableFingerprint = dependencies.fs.readStableFileFingerprint
    const executablePath = path.resolve(executable)
    const allowedSignedProvenance = TRUSTED_SIGNED_CLI_PROVENANCE[row.host_variant as CatalogId] ?? []
    if (allowedSignedProvenance.includes(provenance)) {
      if (!dependencies.inspectAppSignature || !dependencies.finalVerifyAppSignatureSync) return null
      try {
        if ((await dependencies.fs.lstat(executablePath))?.kind !== 'file') return null
        if (path.resolve(await dependencies.fs.realpath(executablePath)) !== executablePath) return null
        const executableBefore = await readExecutableFingerprint(
          executablePath,
          MAX_CLI_EXECUTABLE_PROOF_BYTES,
        )
        if (!executableBefore.executable) return null
        const kimiArchitecture = row.host_variant === 'kimi-code-native'
          ? await dependencies.inspectExecutableArchitecture?.(executablePath) ?? null
          : null
        if (row.host_variant === 'kimi-code-native' && !kimiArchitecture) return null
        const signature = await dependencies.inspectAppSignature(executablePath, {
          timeoutMs: 2_000,
          beforeFinalVerification: async () => {
            const currentRealpath = path.resolve(await dependencies.fs.realpath(executablePath))
            const executableDuring = await readExecutableFingerprint(
              executablePath,
              MAX_CLI_EXECUTABLE_PROOF_BYTES,
            )
            if (currentRealpath !== executablePath
              || executableDuring.fingerprint !== executableBefore.fingerprint) {
              throw new Error('signed_cli_surface_changed_during_signature')
            }
          },
        })
        const executableAfter = await readExecutableFingerprint(
          executablePath,
          MAX_CLI_EXECUTABLE_PROOF_BYTES,
        )
        if (executableAfter.fingerprint !== executableBefore.fingerprint) return null
        const finalSignature = dependencies.finalVerifyAppSignatureSync(executablePath, 2_000)
        // No await after the final platform verifier. Bind the path entry and
        // open descriptor to the exact executable generation frozen above.
        if (!stableCliProofSurfaceSync(
          executablePath,
          executableAfter,
          [],
          options?.homeDir,
        )) return null
        if (!signature.valid || signature.verificationBoundary !== 'strict_final'
          || !finalSignature.valid || finalSignature.verificationBoundary !== 'strict_final'
          || !signature.identifier || !signature.teamIdentifier
          || finalSignature.identifier !== signature.identifier
          || finalSignature.teamIdentifier !== signature.teamIdentifier) return null
        const liveProvenance = `signed_cli:${signature.identifier}:${signature.teamIdentifier}`
        if (liveProvenance !== provenance) return null
        const signatureReceiptFingerprint = desktopSignatureReceiptFingerprint(signature)
        const finalSignatureReceiptFingerprint = desktopSignatureReceiptFingerprint(finalSignature)
        const kimiLookupFingerprint = row.host_variant === 'kimi-code-native'
          && kimiArchitecture
          && finalSignature.identifier
          && finalSignature.teamIdentifier
          && finalSignature.cdHash
          && finalSignature.designatedRequirement
          ? kimiNativeReceiptLookupFingerprint({
              architecture: kimiArchitecture,
              executableSha256: executableAfter.sha256,
              executableSizeBytes: executableAfter.size,
              identifier: finalSignature.identifier,
              teamIdentifier: finalSignature.teamIdentifier,
              cdHash: finalSignature.cdHash,
              designatedRequirement: finalSignature.designatedRequirement,
            })
          : null
        const kimiReceipt = kimiLookupFingerprint && kimiArchitecture
          ? dependencies.resolveKimiNativeReceipt?.({
              architecture: kimiArchitecture,
              lookupFingerprint: kimiLookupFingerprint,
            }) ?? null
          : null
        const surfaceFingerprint = row.host_variant === 'kimi-code-native'
          ? kimiLookupFingerprint
          : signatureReceiptFingerprint
        const surfaceSchema = row.host_variant === 'kimi-code-native'
          ? KIMI_SIGNED_CLI_SURFACE_SCHEMA
          : SIGNED_CLI_SURFACE_SCHEMA
        const livePortableArtifactFingerprint = row.host_variant === 'kimi-code-native'
          ? kimiReceipt && signedKimiPortableArtifactFingerprint({
              version: kimiReceipt.version,
              executableArtifactFingerprint: kimiNativeExecutablePortableArtifactFingerprint(executableAfter),
              signature: finalSignature,
            })
          : signedCodePortableArtifactFingerprint({
              version: row.detected_version ?? undefined,
              executable: executableAfter,
              signature: finalSignature,
            })
        if (!signatureReceiptFingerprint
          || finalSignatureReceiptFingerprint !== signatureReceiptFingerprint
          || !surfaceFingerprint
          || (row.host_variant === 'kimi-code-native'
            && (!kimiReceipt
              || row.detected_version !== kimiReceipt.version
              || distribution.portableArtifactFingerprint !== kimiReceipt.portableArtifactFingerprint))
          || (distribution.portableArtifactFingerprint !== undefined
            && livePortableArtifactFingerprint !== distribution.portableArtifactFingerprint)
          || distribution.capabilityFingerprint
            !== `${surfaceSchema}:${surfaceFingerprint}`) return null
        return sha256Json({
          channel: 'signed_cli',
          executablePath,
          executableFileFingerprint: executableBefore.fingerprint,
          identifier: signature.identifier,
          teamIdentifier: signature.teamIdentifier,
          signatureReceiptFingerprint,
          ...(kimiReceipt ? {
            version: kimiReceipt.version,
            artifactReceiptFingerprint: kimiReceipt.portableArtifactFingerprint,
          } : {}),
        })
      } catch {
        return null
      }
    }

    if (!provenance.startsWith('npm_metadata:')) return null
    try {
      if ((await dependencies.fs.lstat(executablePath))?.kind !== 'file') return null
      if (path.resolve(await dependencies.fs.realpath(executablePath)) !== executablePath) return null
      const executableBefore = await dependencies.fs.readStableFileFingerprint(
        executablePath,
        MAX_CLI_EXECUTABLE_PROOF_BYTES,
      )
      if (!executableBefore.executable) return null
      const metadataBefore = await dependencies.execVersion(executablePath, [], { timeoutMs: 2_000 })
      if (metadataBefore.exitCode !== 0
        || metadataBefore.verifiedPackageProvenance !== provenance
        || !metadataBefore.packageMetadataFingerprint
        || !metadataBefore.packageProofNodes?.length) return null
      const portableNpmExecutable = metadataBefore.packageProofNodes.find(
        node => node.role === 'npm_package_executable' || node.role === 'qwen_launcher',
      )
      const isPortableWrapper = metadataBefore.packageProofNodes.some(
        node => node.role === 'openclaw_wrapper',
      )
      if (metadataBefore.portableArtifactFingerprint && !isPortableWrapper
        && (portableNpmExecutable?.path !== executablePath
          || portableNpmExecutable.fingerprint !== executableBefore.fingerprint)) return null
      if (distribution.portableArtifactFingerprint !== undefined
        && metadataBefore.portableArtifactFingerprint !== distribution.portableArtifactFingerprint) return null
      const hasOwnedPackageProof = metadataBefore.packageProofNodes.some(node => node.entryType !== undefined)
      const metadataAfter = hasOwnedPackageProof
        ? metadataBefore
        : await dependencies.execVersion(executablePath, [], { timeoutMs: 2_000 })
      if (metadataAfter.exitCode !== 0
        || metadataAfter.stdout !== metadataBefore.stdout
        || metadataAfter.verifiedPackageProvenance !== metadataBefore.verifiedPackageProvenance
        || metadataAfter.packageMetadataFingerprint !== metadataBefore.packageMetadataFingerprint
        || metadataAfter.portableArtifactFingerprint !== metadataBefore.portableArtifactFingerprint
        || !metadataAfter.packageProofNodes?.length
        || cliPackageProofNodesFingerprint(metadataAfter.packageProofNodes)
          !== cliPackageProofNodesFingerprint(metadataBefore.packageProofNodes)) return null
      // metadataAfter is intentionally the last awaited file-system operation.
      // Hold O_NOFOLLOW descriptors for the executable and every package proof
      // node while synchronously comparing both descriptors and current path
      // entries to the frozen physical identities.
      if (!stableCliProofSurfaceSync(
        executablePath,
        executableBefore,
        metadataAfter.packageProofNodes,
        options?.homeDir,
      )) return null
      return sha256Json({
        channel: 'npm_metadata',
        executablePath,
        executableFileFingerprint: executableBefore.fingerprint,
        provenance,
        version: metadataBefore.stdout,
        packageMetadataFingerprint: metadataBefore.packageMetadataFingerprint,
        packageProofNodesFingerprint: cliPackageProofNodesFingerprint(metadataBefore.packageProofNodes),
      })
    } catch {
      return null
    }
  }
}

async function attestCustomMcpInstallation(
  row: AgentInstallationRow,
  options: {
    homeDir: string
    repository: AgentIntegrationRepository
    runtime: AdapterRuntimeContext
  },
): Promise<string | null> {
  const binding = customMcpTrustBinding(row, options.homeDir)
  if (!binding || !row.agent_id) return null
  try {
    const executableBefore = await readStableFileFingerprint(
      binding.executablePath,
      MAX_CLI_EXECUTABLE_PROOF_BYTES,
    )
    if (binding.userOwned) {
      const after = await readStableFileFingerprint(binding.executablePath, MAX_CLI_EXECUTABLE_PROOF_BYTES)
      if (!executableBefore.executable || executableBefore.size !== binding.executableSize
        || executableBefore.fingerprint !== binding.executableFingerprint
        || after.fingerprint !== executableBefore.fingerprint) return null
      return sha256Json({ channel: 'custom_user_owned_import', installationId: row.id,
        agentId: row.agent_id, executableFingerprint: binding.executableFingerprint })
    }
    const configBefore = await readStableFileSnapshot(
      binding.configPath,
      CUSTOM_CONFIG_PROOF_LIMIT_BYTES,
    )
    const configAfter = await readStableFileSnapshot(
      binding.configPath,
      CUSTOM_CONFIG_PROOF_LIMIT_BYTES,
    )
    const executableAfter = await readStableFileFingerprint(
      binding.executablePath,
      MAX_CLI_EXECUTABLE_PROOF_BYTES,
    )
    if (!executableBefore.executable
      || executableBefore.size !== binding.executableSize
      || executableBefore.fingerprint !== binding.executableFingerprint
      || executableAfter.fingerprint !== executableBefore.fingerprint
      || configAfter.fingerprint !== configBefore.fingerprint
      || !customConfigGenerationTrusted(
        row,
        binding,
        configBefore,
        options.repository,
        options.runtime,
      )
      || !stableCustomProofSurfaceSync(binding, executableAfter, configAfter)) return null
    // Deliberately exclude the live config generation: the first authorized
    // projection atomically changes that file. The immutable preflight receipt
    // plus exact owned selector keeps the proof stable across that transition.
    return sha256Json({
      channel: 'custom_local_preflight',
      installationId: row.id,
      agentId: row.agent_id,
      executablePath: binding.executablePath,
      executableFingerprint: binding.executableFingerprint,
      executableSize: binding.executableSize,
      configPath: binding.configPath,
      configPreflightFingerprint: binding.configFingerprint,
      schemaKind: binding.schemaKind,
      selectorKey: binding.selectorKey,
    })
  } catch {
    return null
  }
}

function customConfigGenerationTrusted(
  row: AgentInstallationRow,
  binding: CustomMcpTrustBinding,
  snapshot: Awaited<ReturnType<typeof readStableFileSnapshot>>,
  repository: AgentIntegrationRepository,
  runtime: AdapterRuntimeContext,
): boolean {
  if (snapshot.fingerprint === binding.configFingerprint) return true
  if (!row.agent_id) return false
  let document: Record<string, unknown>
  try {
    const source = Buffer.from(snapshot.content).toString('utf8')
    const parsed = path.extname(binding.configPath).toLowerCase() === '.jsonc'
      ? parseJsoncObject(source).root
      : JSON.parse(source) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    document = parsed as Record<string, unknown>
  } catch {
    return false
  }
  // Once the first authorized projection has committed, the config file's
  // inode/content fingerprint necessarily differs from the preflight receipt.
  // At that point trust comes only from the exact active ledger ownership for
  // this Installation/path/selector. Arbitrary files with the same shape do
  // not qualify. The Adapter still treats an occupied non-owned selector as a
  // conflict, while an absent selector remains eligible for auto-repair.
  const ownedScope = repository.getDisconnectArtifactScope(
    row.id,
    'memory_tools',
    binding.configPath,
    binding.ownershipKey,
  )
  const pendingRemoval = repository.listInstallationComponentDetails(row.id).find(component => (
    component.component_key === 'memory_tools'
    && component.target_path === binding.configPath
    && component.ownership_key === binding.ownershipKey
    && component.artifact_state === 'removal_pending'
    && component.desired_state === 'removed'
    && component.consent_envelope_id === row.consent_envelope_id
  ))
  if (!ownedScope && !pendingRemoval) return false
  let fragment: unknown = document
  for (const key of binding.selector) {
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)
      || !Object.prototype.hasOwnProperty.call(fragment, key)) {
      return ownedScope !== null || pendingRemoval !== undefined
    }
    fragment = (fragment as Record<string, unknown>)[key]
  }
  const projectedEnvironment = fragment && typeof fragment === 'object' && !Array.isArray(fragment)
    ? (binding.schemaKind === 'opencode_mcp'
        ? (fragment as Record<string, unknown>).environment
        : (fragment as Record<string, unknown>).env)
    : null
  const activityGenerationToken = projectedEnvironment
    && typeof projectedEnvironment === 'object'
    && !Array.isArray(projectedEnvironment)
    && typeof (projectedEnvironment as Record<string, unknown>).EB_ACTIVITY_GENERATION_TOKEN === 'string'
    ? (projectedEnvironment as Record<string, unknown>).EB_ACTIVITY_GENERATION_TOKEN as string
    : ''
  if (!activityGenerationToken) return false
  const environment = {
    EB_AGENT_ID: row.agent_id,
    EB_HOST_VARIANT: 'custom-local-mcp',
    EB_ACTIVITY_GENERATION_TOKEN: activityGenerationToken,
  }
  const desired = binding.schemaKind === 'opencode_mcp'
    ? {
        type: 'local',
        command: [runtime.shimPath, runtime.mcpServerPath],
        enabled: true,
        environment,
      }
    : {
        command: runtime.shimPath,
        args: [runtime.mcpServerPath],
        env: environment,
      }
  const fragmentHash = sha256Json(fragment)
  if (fragmentHash !== sha256Json(desired)) return false
  if (pendingRemoval?.owned_fragment_hash === fragmentHash) return true
  const artifacts = repository.findExactManagedArtifacts(
    'local_macos',
    binding.configPath,
    fragmentHash,
  )
  if (artifacts.some(artifact => {
    if (artifact.ownership_key !== binding.ownershipKey) return false
    return repository.listArtifactConsumers(String(artifact.id)).some(consumer => (
      consumer.installation_id === row.id
      && consumer.component_key === 'memory_tools'
      && consumer.state === 'active'
      && (consumer.desired_state === 'managed' || consumer.desired_state === 'disabled')
    ))
  })) return true
  // Disconnect stages this exact owner and Artifact as removal_pending before
  // the physical selector removal. Keep source trust valid only for that
  // exact owned fragment; coordinator consent/fence/CAS still authorize the
  // effect, and a foreign fragment remains rejected above.
  return false
}

function stableCustomProofSurfaceSync(
  binding: CustomMcpTrustBinding,
  executable: StableFileFingerprint,
  config: StableFileFingerprint,
): boolean {
  try {
    if (fsSync.realpathSync(binding.executablePath) !== binding.executablePath
      || fsSync.realpathSync(binding.configPath) !== binding.configPath) return false
  } catch {
    return false
  }
  const nodes = [
    { path: binding.executablePath, proof: executable },
    { path: binding.configPath, proof: config },
  ]
  const opened: Array<{ path: string; proof: StableFileFingerprint; fd: number }> = []
  try {
    for (const node of nodes) {
      opened.push({
        ...node,
        fd: fsSync.openSync(node.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
      })
    }
    return opened.every(node => stableCliProofNodeMatches(node.fd, node.path, node.proof))
      && [...opened].reverse().every(node => stableCliProofNodeMatches(node.fd, node.path, node.proof))
  } catch {
    return false
  } finally {
    for (const node of opened.reverse()) {
      try { fsSync.closeSync(node.fd) } catch { /* fail closed */ }
    }
  }
}

function cliPackageProofNodesFingerprint(nodes: readonly PackageMetadataProofNode[]): string {
  return sha256Json(nodes.map(node => ({
    role: node.role,
    path: node.path,
    maxBytes: node.maxBytes,
    fingerprint: node.fingerprint,
  })))
}

function stableCliProofSurfaceSync(
  executablePath: string,
  executable: StableFileFingerprint,
  packageNodes: readonly PackageMetadataProofNode[],
  homeDir?: string,
): boolean {
  const criticalPackageNodes = packageNodes.filter(node => (
    node.role !== 'npm_package_file'
    && node.role !== 'openclaw_package_file'
    && node.role !== 'qwen_package_file'
  ))
  const nodes: Array<{ path: string; proof: StableFileFingerprint }> = [
    { path: executablePath, proof: executable },
    ...criticalPackageNodes.map(node => ({ path: node.path, proof: node })),
  ].filter((node, index, all) => all.findIndex(candidate => candidate.path === node.path) === index)
  if (nodes.some(node => !path.isAbsolute(node.path) || path.resolve(node.path) !== node.path)) return false
  const opened: Array<{ path: string; proof: StableFileFingerprint; fd: number }> = []
  try {
    if (!stableNpmPackageTreePathsSync(packageNodes)) return false
    if (!stableOpenClawWrapperAliasesSync(executablePath, packageNodes, homeDir)) return false
    for (const node of nodes) {
      opened.push({
        ...node,
        fd: fsSync.openSync(node.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
      })
    }
    for (const node of opened) {
      if (!stableCliProofNodeMatches(node.fd, node.path, node.proof)) return false
    }
    // Recheck in reverse while all descriptors remain open. This rejects a
    // path-entry replacement that races the first pass without introducing an
    // event-loop turn between the individual proof nodes.
    for (const node of [...opened].reverse()) {
      if (!stableCliProofNodeMatches(node.fd, node.path, node.proof)) return false
    }
    return stableNpmPackageTreePathsSync(packageNodes)
      && stableOpenClawWrapperAliasesSync(executablePath, packageNodes, homeDir)
  } catch {
    return false
  } finally {
    for (const node of opened.reverse()) {
      try { fsSync.closeSync(node.fd) } catch { /* fail-closed result already chosen */ }
    }
  }
}

function stableOpenClawWrapperAliasesSync(
  executablePath: string,
  packageNodes: readonly PackageMetadataProofNode[],
  homeDir?: string,
): boolean {
  const wrapper = packageNodes.find(node => node.role === 'openclaw_wrapper')
  if (!wrapper) return true
  const nodeRuntime = packageNodes.find(node => node.role === 'openclaw_node_runtime')
  if (!nodeRuntime || wrapper.path !== executablePath) return false
  const openClawRoot = path.dirname(path.dirname(executablePath))
  const effectiveHomeDir = homeDir
    ?? (path.basename(openClawRoot) === '.openclaw' ? path.dirname(openClawRoot) : undefined)
  const defaultOpenClawRoot = effectiveHomeDir ? path.join(effectiveHomeDir, '.openclaw') : null
  const requiresDefaultAlias = defaultOpenClawRoot === openClawRoot
  const outerAlias = effectiveHomeDir ? path.join(effectiveHomeDir, '.local', 'bin', 'openclaw') : null
  const nodeAliasRoot = path.join(openClawRoot, 'tools', 'node')
  const nodeAlias = path.join(nodeAliasRoot, 'bin', 'node')
  const toolchainRoot = path.dirname(path.dirname(nodeRuntime.path))
  try {
    const expectedUid = typeof process.getuid === 'function' ? String(process.getuid()) : null
    if (expectedUid === null) return false
    const directories = [
      ...(requiresDefaultAlias && effectiveHomeDir
        ? [path.join(effectiveHomeDir, '.local'), path.join(effectiveHomeDir, '.local', 'bin')]
        : []),
      openClawRoot,
      path.join(openClawRoot, 'bin'),
      path.join(openClawRoot, 'tools'),
      toolchainRoot,
      path.join(toolchainRoot, 'bin'),
      path.join(toolchainRoot, 'lib'),
      path.join(toolchainRoot, 'lib', 'node_modules'),
      path.join(toolchainRoot, 'lib', 'node_modules', 'openclaw'),
      path.join(toolchainRoot, 'lib', 'node_modules', 'openclaw', 'dist'),
    ]
    if (directories.some(directory => {
      const node = fsSync.lstatSync(directory, { bigint: true })
      return !node.isDirectory()
        || node.isSymbolicLink()
        || String(node.uid) !== expectedUid
        || (Number(node.mode & 0o7777n) & 0o022) !== 0
        || path.resolve(fsSync.realpathSync(directory)) !== directory
    })) return false
    const nodeAliasNode = fsSync.lstatSync(nodeAliasRoot, { bigint: true })
    if (!nodeAliasNode.isSymbolicLink()
      || String(nodeAliasNode.uid) !== expectedUid
      || path.resolve(fsSync.realpathSync(nodeAliasRoot)) !== toolchainRoot
      || path.resolve(fsSync.realpathSync(nodeAlias)) !== nodeRuntime.path) return false
    if (!requiresDefaultAlias) return true
    if (!outerAlias) return false
    const outerNode = fsSync.lstatSync(outerAlias, { bigint: true })
    return outerNode.isSymbolicLink()
      && String(outerNode.uid) === expectedUid
      && path.resolve(fsSync.realpathSync(outerAlias)) === executablePath
  } catch {
    return false
  }
}

/**
 * Re-list the exact package tree at the final synchronous trust boundary. The
 * per-file descriptors below bind contents and metadata; this list equality
 * additionally rejects a file added, removed or replaced by a directory after
 * the asynchronous package-tree snapshots completed.
 */
function stableNpmPackageTreePathsSync(packageNodes: readonly PackageMetadataProofNode[]): boolean {
  const hasTreeProof = packageNodes.some(node => node.entryType !== undefined)
  if (!hasTreeProof) return true
  const includeNodeModules = packageNodes.some(node => node.role === 'qwen_standalone_manifest')
  const manifest = packageNodes.find(node => node.role === 'package_manifest')
  if (!manifest) return false
  const packageRoot = path.dirname(manifest.path)
  const expectedPaths = packageNodes
    .filter(node => node.entryType !== undefined)
    .map(node => node.path)
    .sort((left, right) => left.localeCompare(right))
  if (expectedPaths.length === 0 || expectedPaths.length > MAX_PACKAGE_TREE_FILES
    || !expectedPaths.includes(manifest.path)
    || expectedPaths.some(filePath => !isPathWithin(packageRoot, filePath))) return false

  const actualPaths: string[] = []
  const expectedByPath = new Map(expectedPaths.map(filePath => [
    filePath,
    packageNodes.find(node => node.path === filePath && node.entryType !== undefined)!,
  ]))
  let directoryCount = 0
  const maxDirectories = includeNodeModules
    ? MAX_STANDALONE_PACKAGE_TREE_DIRECTORIES
    : MAX_PACKAGE_TREE_DIRECTORIES
  const visit = (directory: string, depth: number): boolean => {
    directoryCount += 1
    if (directoryCount > maxDirectories || depth > MAX_PACKAGE_TREE_DEPTH) return false
    const directoryNode = fsSync.lstatSync(directory, { bigint: true })
    if (!directoryNode.isDirectory()
      || directoryNode.isSymbolicLink()
      || !isTrustedArtifactOwner(String(directoryNode.uid))
      || (Number(directoryNode.mode & 0o7777n) & 0o022) !== 0
      || path.resolve(fsSync.realpathSync(directory)) !== directory) return false
    const entries = fsSync.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    if (entries.length > MAX_PACKAGE_TREE_ENTRIES_PER_DIRECTORY) return false
    for (const directoryEntry of entries) {
      const targetPath = path.join(directory, directoryEntry.name)
      if (directoryEntry.isDirectory()) {
        if (!includeNodeModules && directoryEntry.name === 'node_modules') continue
        if (!visit(targetPath, depth + 1)) return false
        continue
      }
      if ((!directoryEntry.isFile() && !directoryEntry.isSymbolicLink())
        || actualPaths.length >= MAX_PACKAGE_TREE_FILES) return false
      const proof = expectedByPath.get(targetPath)
      if (!proof) return false
      const pathNode = fsSync.lstatSync(targetPath, { bigint: true })
      if (directoryEntry.isSymbolicLink()) {
        if (proof.entryType !== 'symlink' || !pathNode.isSymbolicLink()) return false
        const rawTarget = fsSync.readlinkSync(targetPath)
        if (path.isAbsolute(rawTarget)) return false
        const resolvedTarget = path.resolve(path.dirname(targetPath), rawTarget)
        const normalizedTarget = path.relative(path.dirname(targetPath), resolvedTarget).split(path.sep).join('/')
        const targetProof = expectedByPath.get(resolvedTarget)
        if (!isPathWithin(packageRoot, resolvedTarget)
          || (!includeNodeModules
            && path.relative(packageRoot, resolvedTarget).split(path.sep).includes('node_modules'))
          || normalizedTarget !== proof.symlinkTarget
          || targetProof?.entryType !== 'file'
          || !stableSymlinkIdentityMatches(pathNode, proof)) return false
      } else if (proof.entryType !== 'file'
        || !pathNode.isFile()
        || pathNode.isSymbolicLink()
        || path.resolve(fsSync.realpathSync(targetPath)) !== targetPath
        || !stableFileFingerprintIdentityMatches(pathNode, proof)) return false
      actualPaths.push(targetPath)
    }
    return true
  }
  return visit(packageRoot, 0)
    && actualPaths.length === expectedPaths.length
    && actualPaths.every((filePath, index) => filePath === expectedPaths[index])
}

function stableSymlinkIdentityMatches(
  stat: BigIntStats,
  proof: StableFileFingerprint,
): boolean {
  return String(stat.dev) === proof.device
    && String(stat.ino) === proof.inode
    && String(stat.nlink) === proof.linkCount
    && String(stat.mtimeNs) === proof.mtimeNs
    && String(stat.ctimeNs) === proof.ctimeNs
    && Number(stat.mode & 0o7777n) === proof.mode
    && (proof.ownerUid === undefined || String(stat.uid) === proof.ownerUid)
    && (proof.groupGid === undefined || String(stat.gid) === proof.groupGid)
}

function isTrustedArtifactOwner(ownerUid: string): boolean {
  const currentUid = typeof process.getuid === 'function' ? String(process.getuid()) : null
  return currentUid !== null && (ownerUid === currentUid || ownerUid === '0')
}

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function stableCliProofNodeMatches(
  fd: number,
  targetPath: string,
  proof: StableFileFingerprint,
): boolean {
  const descriptor = fsSync.fstatSync(fd, { bigint: true })
  const pathNode = fsSync.lstatSync(targetPath, { bigint: true })
  return descriptor.isFile()
    && pathNode.isFile()
    && !pathNode.isSymbolicLink()
    && path.resolve(fsSync.realpathSync(targetPath)) === targetPath
    && stableFileFingerprintIdentityMatches(descriptor, proof)
    && stableFileFingerprintIdentityMatches(pathNode, proof)
}

function stableFileFingerprintIdentityMatches(
  stat: BigIntStats,
  proof: StableFileFingerprint,
): boolean {
  return String(stat.dev) === proof.device
    && String(stat.ino) === proof.inode
    && String(stat.nlink) === proof.linkCount
    && String(stat.mtimeNs) === proof.mtimeNs
    && String(stat.ctimeNs) === proof.ctimeNs
    && Number(stat.size) === proof.size
    && Number(stat.mode & 0o7777n) === proof.mode
    && (proof.ownerUid === undefined || String(stat.uid) === proof.ownerUid)
    && (proof.groupGid === undefined || String(stat.gid) === proof.groupGid)
}

export function createProductionAgentIntegrationService(
  db: Database.Database,
  options: ProductionAgentIntegrationOptions = {},
): AgentIntegrationService {
  productionRuntime?.stop()
  const composition = createProductionAgentIntegrationComposition(db, options)
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  composition.runtime.onStop(unbind)
  productionRuntime = composition.runtime
  let started = false
  productionRuntimeStarter = () => {
    if (started || productionRuntime !== composition.runtime) return Promise.resolve()
    started = true
    return composition.runtime.start().catch(error => {
      if (productionRuntime === composition.runtime) started = false
      composition.coordinatorRepository.recordEvent({
        id: `event_${randomUUID()}`,
        installationId: null,
        componentKey: null,
        artifactId: null,
        kind: 'managed_runtime_start_failed',
        severity: 'error',
        episodeId: null,
        dedupeKey: 'managed_runtime_start_failed',
        payload: { message: error instanceof Error ? error.message : String(error) },
        createdAt: new Date().toISOString(),
      })
    })
  }
  if (options.startRuntime !== false) void productionRuntimeStarter()
  return composition.service
}

/** Starts the already-composed runtime after renderer locale synchronization. */
export function startProductionAgentIntegrationRuntime(): Promise<void> {
  return productionRuntimeStarter?.() ?? Promise.resolve()
}

export function stopProductionAgentIntegrationRuntime(): void {
  productionRuntime?.stop()
  productionRuntime = null
  productionRuntimeStarter = null
}

/** Resume/unlock trigger; still passive unless the reviewed managed gates are open. */
export function triggerProductionAgentIntegrationScan(): void {
  void productionRuntime?.triggerScan()
}

interface RuntimeDependencies {
  coordinator: AgentIntegrationCoordinator
  coordinatorRepository: SqliteCoordinatorRepository
  reconciler: ManagedAgentReconciler
  adapters: AdapterResolverPort
  runtimeContext: AdapterRuntimeContext
  observeOnly: boolean
  autoRestore: boolean
  canManageInstallation(installation: CoordinatorInstallation): Promise<boolean>
  canContinueRecovery(execution: RecoverableExecution): Promise<boolean>
}

export class ProductionAgentIntegrationRuntime {
  private maintenance: Promise<void> | null = null
  private maintenanceRequested = false
  private timer: NodeJS.Timeout | null = null
  private scheduledScan: (() => Promise<void>) | null = null
  private intervalMs = DEFAULT_MAINTENANCE_INTERVAL_MS
  private scanLifecycleManagedExternally = false
  private stopped = false
  private freshScanReady = false
  private stopCallbacks: Array<() => void> = []

  constructor(private readonly dependencies: RuntimeDependencies) {}

  configureScheduler(
    scan: () => Promise<void>,
    intervalMs: number,
    lifecycleManagedExternally = false,
  ): void {
    this.scheduledScan = scan
    this.intervalMs = Math.max(60_000, intervalMs)
    this.scanLifecycleManagedExternally = lifecycleManagedExternally
  }

  onStop(callback: () => void): void {
    this.stopCallbacks.push(callback)
  }

  async start(): Promise<void> {
    if (this.stopped) return
    if (this.scheduledScan) {
      try {
        await this.runScheduledScan()
      } catch (error) {
        this.recordRuntimeFailure('managed_runtime_scan_failed', error)
      }
    } else {
      // Test/embedded runtimes without a scanner have no persisted discovery
      // boundary to refresh; production always configures a passive scanner.
      this.freshScanReady = true
      await this.runMaintenance().catch(error => this.recordRuntimeFailure('managed_runtime_recovery_failed', error))
    }
    this.scheduleNext()
  }

  runMaintenance(): Promise<void> {
    if (this.stopped || !this.freshScanReady) return Promise.resolve()
    this.maintenanceRequested = true
    if (this.maintenance) return this.maintenance
    // A concurrent confirmation may persist evidence after the current pass
    // read it. Drain that request serially before resolving the shared promise.
    this.maintenance = (async () => {
      try {
        while (this.maintenanceRequested && !this.stopped && this.freshScanReady) {
          this.maintenanceRequested = false
          await this.performMaintenance()
        }
      } finally {
        this.maintenance = null
      }
    })()
    return this.maintenance
  }

  async triggerScan(): Promise<void> {
    if (this.stopped || !this.scheduledScan) return
    try {
      await this.runScheduledScan()
    } catch (error) {
      this.recordRuntimeFailure('managed_runtime_triggered_scan_failed', error)
    }
  }

  markScanStarted(): void {
    this.freshScanReady = false
  }

  async markScanCompleted(): Promise<void> {
    if (this.stopped) return
    this.freshScanReady = true
    await this.runMaintenance()
  }

  private async runScheduledScan(): Promise<void> {
    const scan = this.scheduledScan
    if (!scan) return
    if (this.scanLifecycleManagedExternally) {
      await scan()
      return
    }
    this.markScanStarted()
    await scan()
    await this.markScanCompleted()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const callback of this.stopCallbacks.splice(0)) callback()
  }

  private async performMaintenance(): Promise<void> {
    await this.dependencies.coordinator.recoverNonTerminalRuns({
      // Read-back/finalization remains available through the recovery Adapter,
      // but replaying adapter.apply requires both current production gates.
      canReplayEffect: installation => (
        this.dependencies.adapters.get(installation.identity.hostVariant) !== undefined
          ? this.dependencies.canManageInstallation(installation)
          : false
      ),
      canContinueRecovery: execution => this.dependencies.canContinueRecovery(execution),
    })
    if (this.dependencies.observeOnly || !this.dependencies.autoRestore) return
    const attemptedArtifacts = new Set<string>()
    for (const candidate of this.dependencies.coordinatorRepository.listManagedReconcileCandidates()) {
      if (this.stopped) return
      if (attemptedArtifacts.has(candidate.artifactId)) continue
      try {
        // Shared portable Artifacts can have consumers belonging to different
        // host variants. Trust and Adapter gates are Installation-scoped, so do
        // not let an unmanageable first consumer hide a later eligible one.
        if (!this.dependencies.adapters.get(candidate.installation.identity.hostVariant)) continue
        if (!await this.dependencies.canManageInstallation(candidate.installation)) continue
        // Once a currently manageable consumer is selected, keep the physical
        // Artifact single-effect invariant even if inspection/reconcile fails.
        attemptedArtifacts.add(candidate.artifactId)
        await this.reconcile(candidate)
      } catch (error) {
        this.recordReconcileFailure(error, candidate)
      }
    }
  }

  private async reconcile(candidate: ManagedReconcileCandidate): Promise<void> {
    const adapter = this.dependencies.adapters.get(candidate.installation.identity.hostVariant)
    if (!adapter) return
    let inspection: AdapterInspection
    try {
      inspection = await adapter.inspect(operationContext(
        this.dependencies.runtimeContext,
        candidate,
        `inspect_${randomUUID()}`,
      ))
    } catch (error) {
      inspection = {
        catalogId: candidate.installation.identity.hostVariant,
        detected: false,
        distribution: candidate.installation.identity.distribution,
        components: [],
        provenance: [],
        diagnostics: [error instanceof Error ? error.message : String(error)],
      }
    }
    // `inspect` may await host/filesystem I/O while a concurrent discovery scan
    // replaces the Installation identity or removes its trusted provenance.
    // Do not let that stale observation mutate health, episodes, events or plans.
    if (!await this.dependencies.canManageInstallation(candidate.installation)) return
    await this.dependencies.reconciler.reconcileArtifact({
      artifactId: candidate.artifactId,
      installation: candidate.installation,
      installationDesiredState: candidate.installation.desiredState,
      componentKey: candidate.componentKey,
      componentKeys: candidate.componentKeys,
      componentName: candidate.componentName,
      desiredCapability: candidate.desiredCapability,
      consentId: candidate.consentId,
      observation: observationFor(candidate, inspection),
      affectedConsumers: candidate.affectedConsumers,
    })
  }

  private scheduleNext(): void {
    if (this.stopped || !this.scheduledScan) return
    this.timer = setTimeout(() => {
      const scan = this.scheduledScan
      if (!scan || this.stopped) return
      void this.runScheduledScan()
        .catch(error => this.recordRuntimeFailure('managed_runtime_scheduled_scan_failed', error))
        .finally(() => this.scheduleNext())
    }, jitteredInterval(this.intervalMs))
    this.timer.unref?.()
  }

  private recordRuntimeFailure(
    kind: string,
    error: unknown,
    candidate?: ManagedReconcileCandidate,
  ): void {
    this.dependencies.coordinatorRepository.recordEvent({
      id: `event_${randomUUID()}`,
      installationId: candidate?.installation.id ?? null,
      componentKey: candidate?.componentKey ?? null,
      artifactId: candidate?.artifactId ?? null,
      kind,
      severity: 'error',
      episodeId: null,
      dedupeKey: candidate
        ? `${kind}:${candidate.installation.id}:${candidate.artifactId}:${candidate.componentKey}`
        : kind,
      payload: { message: error instanceof Error ? error.message : String(error) },
      createdAt: new Date().toISOString(),
    })
  }

  private recordReconcileFailure(error: unknown, candidate: ManagedReconcileCandidate): void {
    try {
      this.recordRuntimeFailure('managed_runtime_reconcile_failed', error, candidate)
      return
    } catch (persistenceError) {
      // A concurrently removed Artifact can invalidate the event's relational
      // scope. Preserve the exact identifiers in the sanitized payload, and
      // never let diagnostic persistence starve later maintenance candidates.
      try {
        this.dependencies.coordinatorRepository.recordEvent({
          id: `event_${randomUUID()}`,
          installationId: null,
          componentKey: null,
          artifactId: null,
          kind: 'managed_runtime_reconcile_diagnostic_failed',
          severity: 'error',
          episodeId: null,
          dedupeKey: [
            'managed_runtime_reconcile_diagnostic_failed',
            candidate.installation.id,
            candidate.artifactId,
            candidate.componentKey,
          ].join(':'),
          payload: {
            installationId: candidate.installation.id,
            artifactId: candidate.artifactId,
            componentKey: candidate.componentKey,
            message: error instanceof Error ? error.message : String(error),
            persistenceFailure: persistenceError instanceof Error
              ? persistenceError.message
              : String(persistenceError),
          },
          createdAt: new Date().toISOString(),
        })
      } catch {
        return
      }
    }
  }
}

function jitteredInterval(intervalMs: number): number {
  return Math.max(60_000, Math.round(intervalMs * (0.9 + Math.random() * 0.2)))
}

function defaultRuntimeContext(homeDir: string, applicationDataDir: string): AdapterRuntimeContext {
  return {
    runtimeRealm: 'local_macos',
    homeDir,
    applicationDataDir,
    shimPath: getShimPath(),
    mcpServerPath: getMcpServerScriptPath(),
    hookScriptPath: getHookScriptPath(),
    preCompactScriptPath: getPreCompactHookScriptPath(),
    postCompactScriptPath: getPostCompactHookScriptPath(),
    tideMindVersion: app.getVersion(),
    catalogVersion: CATALOG_VERSION,
    projectionVersion: '1',
  }
}

function numericGeneration(version: string): number {
  const parsed = Number.parseInt(version, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

export function productionNotifications(options: {
  onOpenInstallation?: (installationId: string) => void | Promise<void>
  onInAppNotification?: (notification: UserNotification) => void | Promise<void>
  isAppActive?: () => boolean
  system?: {
    isSupported(): boolean
    create(input: { title: string; body: string }): {
      on(event: 'click', callback: () => void): unknown
      show(): void
    }
  }
}): NotificationPort {
  return {
    async deliver(notification) {
      if (options.isAppActive?.() && options.onInAppNotification) {
        await options.onInAppNotification(notification)
        return
      }
      const system = options.system ?? await defaultNotificationSystem()
      if (!system.isSupported()) {
        await options.onInAppNotification?.(notification)
        return
      }
      const systemNotification = system.create({
        title: notification.title,
        body: notification.body,
      })
      if (notification.installationId && notification.actions.includes('view_details')
        && options.onOpenInstallation) {
        systemNotification.on('click', () => {
          void options.onOpenInstallation!(notification.installationId!)
        })
      }
      systemNotification.show()
    },
  }
}

async function defaultNotificationSystem() {
  const electron = await import('electron')
  return {
    isSupported: () => electron.Notification.isSupported(),
    create: (input: { title: string; body: string }) => new electron.Notification(input),
  }
}

function operationContext(
  runtime: AdapterRuntimeContext,
  candidate: ManagedReconcileCandidate,
  operationId: string,
): AdapterOperationContext {
  return {
    runtime,
    installation: candidate.installation.identity,
    agentId: candidate.installation.agentId,
    operationId,
  }
}

function observationFor(
  candidate: ManagedReconcileCandidate,
  inspection: AdapterInspection,
): ManagedArtifactObservation {
  const component = inspection.components.find(item => item.componentKey === candidate.componentKey)
  const relevantDiagnostics = inspection.diagnostics.filter(diagnostic => (
    diagnostic !== 'qwenwork_connector_registry_not_readable_guided_only'
  ))
  const inaccessible = !inspection.detected || relevantDiagnostics.some(diagnostic =>
    /permission|denied|inaccessible|unreadable|timeout/iu.test(diagnostic),
  )
  if (inaccessible) {
    return {
      kind: 'inaccessible',
      selectorEmpty: false,
      ownershipBaselineVerified: false,
      containerResolvable: false,
      observedFingerprint: component?.observedFragmentHash ?? null,
      diagnostics: inspection.diagnostics,
    }
  }
  if (!component || component.visibility === 'absent') {
    return {
      kind: 'exact_missing',
      selectorEmpty: true,
      ownershipBaselineVerified: candidate.ownedFragmentHash.length > 0,
      containerResolvable: true,
      observedFingerprint: null,
      diagnostics: inspection.diagnostics,
    }
  }
  if (component.observedFragmentHash === candidate.ownedFragmentHash) {
    return {
      kind: 'healthy',
      selectorEmpty: false,
      ownershipBaselineVerified: true,
      containerResolvable: true,
      observedFingerprint: component.observedFragmentHash,
      diagnostics: inspection.diagnostics,
    }
  }
  return {
    kind: component.observedFragmentHash ? 'drifted' : 'conflicted',
    selectorEmpty: false,
    ownershipBaselineVerified: false,
    containerResolvable: true,
    observedFingerprint: component.observedFragmentHash ?? null,
    diagnostics: inspection.diagnostics,
  }
}

function releaseGatedScanner(scanner: AgentIntegrationScannerPort): AgentIntegrationScannerPort {
  return {
    scan: async () => applyAgentReleaseGateToReport(await scanner.scan()),
    ...(scanner.previewGuidedInstallation ? {
      previewGuidedInstallation: async catalogId => {
        const installation = await scanner.previewGuidedInstallation!(catalogId)
        return installation && agentReleaseEligibilityReason(installation) === null
          ? installation
          : null
      },
    } : {}),
  }
}

function createProductionScanner(
  homeDir: string,
  dependencies: DiscoveryDependencies,
): AgentIntegrationScannerPort {
  return {
    scan: () => discoverLocalP0Agents({
      homeDir,
      osUserIdentity: safeUserIdentity(),
      environment: discoveryEnvironment(),
      applicationRoots: ['/Applications', path.join(homeDir, 'Applications')],
      operationTimeoutMs: 2_500,
      signatureTimeoutMs: 20_000,
    }, dependencies),
    previewGuidedInstallation: async catalogId => {
      if (catalogId !== 'claude-cowork-local') return null
      const report = await discoverClaudeCoworkGuidedCandidate({
        homeDir,
        osUserIdentity: safeUserIdentity(),
        environment: discoveryEnvironment(),
        applicationRoots: ['/Applications', path.join(homeDir, 'Applications')],
        operationTimeoutMs: 2_500,
        signatureTimeoutMs: 20_000,
      }, dependencies)
      if (report.unresolved.length > 0 || report.installations.length !== 1) return null
      return report.installations[0]
    },
  }
}

/**
 * Read-only production surface used by the signed real-host acceptance
 * exporter.  Keeping this composition here ensures capture uses the exact
 * discovery and live-trust primitives that guard ordinary production writes;
 * it never exposes an Adapter, coordinator, or mutation capability.
 */
export function createProductionAgentHostMetadataEvidenceRuntime(
  homeDir = os.homedir(),
  fixture?: { runtimeContext: AdapterRuntimeContext },
): {
  scan(): Promise<ReturnType<typeof applyAgentReleaseGateToReport>>
  attest(row: AgentInstallationRow): Promise<string | null>
  inspectCliVersion(executableRealpath: string): ReturnType<DiscoveryDependencies['execVersion']>
  readExecutable(executableRealpath: string): Promise<StableFileFingerprint>
  attestCustom(row: AgentInstallationRow, db: Database.Database): Promise<string | null>
  inspect(row: AgentInstallationRow, db: Database.Database): Promise<AdapterInspection | null>
} {
  const dependencies = productionDiscoveryDependencies(homeDir)
  const scanner = createProductionScanner(homeDir, dependencies)
  const attest = createProductionLiveTrustAttestor(dependencies)
  // Standard distribution reads do not need Adapter paths. Custom inspection
  // resolves them from the executing candidate, including Electron-as-Node.
  const evidenceRuntime = () => fixture?.runtimeContext ?? metadataEvidenceRuntimeContext(homeDir)
  return Object.freeze({
    scan: async () => applyAgentReleaseGateToReport(await scanner.scan()),
    attest,
    inspectCliVersion: executableRealpath => dependencies.execVersion(
      executableRealpath,
      [],
      { timeoutMs: 2_000 },
    ),
    readExecutable: async executableRealpath => {
      if (!dependencies.fs.readStableFileFingerprint) {
        throw new Error('production executable fingerprint primitive is unavailable')
      }
      return dependencies.fs.readStableFileFingerprint(
        executableRealpath,
        MAX_CLI_EXECUTABLE_PROOF_BYTES,
      )
    },
    attestCustom: async (row, db) => {
      const repository = new AgentIntegrationRepository(db)
      const runtime = evidenceRuntime()
      if (row.family === 'custom-local-agent' && row.host_variant !== 'custom-local-mcp') {
        const trusted = await probeNonstandardCustomInstallation(
          row,
          homeDir,
          repository,
          createProductionLiveTrustAttestor(dependencies),
        )
        return trusted ? sha256Json({
          schema: 'custom-nonstandard-live-trust-v1',
          installationId: row.id,
          agentId: row.agent_id,
          projectionSurface: persistedProjectionSurfaceFingerprint(row),
        }) : null
      }
      return createProductionLiveTrustAttestor(dependencies, { homeDir, repository, runtime })(row)
    },
    inspect: async (row, db) => {
      if (!row.agent_id || !row.config_root) return null
      const adapter = createP0HostAdapters().get(row.host_variant as CatalogId)
      if (!adapter) return null
      const runtime = evidenceRuntime()
      return adapter.inspect({
        runtime,
        installation: {
          runtimeRealm: row.runtime_realm as 'local_macos',
          osUserIdentity: row.os_user_identity ?? 'local-user',
          productFamilyId: row.family as never,
          hostVariant: row.host_variant as CatalogId,
          canonicalConfigRoot: row.config_root,
          componentConfigRoots: persistedComponentConfigRoots(row),
          componentConfigFiles: persistedComponentConfigFiles(row),
          explicitProfile: row.profile_id || 'default',
          hostOwnedIdentity: persistedHostOwnedIdentity(row),
          distribution: persistedDistribution(row),
          installKey: row.install_key,
        },
        agentId: row.agent_id,
        operationId: 'host-acceptance-read-only',
        hostActivityEvidence: new SqliteHostActivityEvidenceReader(db),
      })
    },
  })
}

export function metadataEvidenceRuntimeContext(homeDir: string, candidateExecutable = process.execPath): AdapterRuntimeContext {
  const executable = path.resolve(candidateExecutable)
  const macOsDirectory = path.dirname(executable)
  const contents = path.dirname(macOsDirectory)
  if (path.basename(executable) !== 'Tide Mind' || path.basename(macOsDirectory) !== 'MacOS'
    || path.basename(contents) !== 'Contents' || !path.dirname(contents).endsWith('.app')) {
    throw new Error('metadata exporter requires the packaged candidate executable')
  }
  const bin = path.join(contents, 'Resources', 'app.asar.unpacked', 'out', 'bin')
  return {
    runtimeRealm: 'local_macos',
    homeDir,
    applicationDataDir: path.join(homeDir, 'Library', 'Application Support', 'TideMind'),
    shimPath: path.join(homeDir, '.tidemind', 'bin', 'tm-node'),
    mcpServerPath: path.join(bin, 'mcp-server.cjs'),
    hookScriptPath: path.join(bin, 'hook-session-start.cjs'),
    preCompactScriptPath: path.join(bin, 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(bin, 'hook-post-compact.cjs'),
    tideMindVersion: AGENT_INTEGRATION_RELEASE_MANIFEST.appVersion,
    catalogVersion: CATALOG_VERSION,
    projectionVersion: '1',
  }
}

function productionDiscoveryDependencies(homeDir: string): DiscoveryDependencies {
  const executableDirectories = productionAgentDiscoveryExecutableDirectories(homeDir)
  return {
    fs: {
      async lstat(targetPath) {
        try {
          const stat = await fs.lstat(targetPath)
          return {
            kind: stat.isSymbolicLink()
              ? 'symbolic_link'
              : stat.isDirectory()
                ? 'directory'
                : stat.isFile()
                  ? 'file'
                  : 'other',
            mode: stat.mode & 0o7777,
            ownerUid: String(stat.uid),
            groupGid: String(stat.gid),
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      },
      realpath: targetPath => fs.realpath(targetPath),
      async readDirectoryNames(targetPath, maxEntries) {
        try {
          const directory = await fs.opendir(targetPath)
          const names: string[] = []
          for await (const entry of directory) {
            if (names.length === maxEntries) return { names, truncated: true }
            names.push(entry.name)
          }
          return { names, truncated: false }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      },
      async readTextFile(targetPath, maxBytes) {
        const handle = await fs.open(targetPath, 'r')
        try {
          const buffer = Buffer.alloc(maxBytes)
          const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
          return buffer.subarray(0, bytesRead).toString('utf8')
        } finally {
          await handle.close()
        }
      },
      readStableFileSnapshot,
      readStableFileFingerprint,
      readStableFileMetadata,
      readStablePackageTree,
      verifyStablePackageTree,
    },
    which: command => findExecutableForAgentDiscovery(command, executableDirectories),
    whichAll: command => findExecutablesForAgentDiscovery(command, executableDirectories),
    // Read only bounded package/release metadata adjacent to the already
    // canonical executable. Discovery never starts an arbitrary PATH binary.
    execVersion: executableRealpath => inspectPassiveCliVersion(executableRealpath, {
      async lstat(targetPath) {
        try {
          const stat = await fs.lstat(targetPath)
          return {
            kind: stat.isSymbolicLink()
              ? 'symbolic_link'
              : stat.isDirectory()
                ? 'directory'
                : stat.isFile()
                  ? 'file'
                  : 'other',
            mode: stat.mode & 0o7777,
            ownerUid: String(stat.uid),
            groupGid: String(stat.gid),
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      },
      realpath: targetPath => fs.realpath(targetPath),
      readStableFileSnapshot,
      readStableFileFingerprint,
      readStablePackageTree,
      verifyStablePackageTree,
    }),
    inspectAppSignature: inspectMacAppSignature,
    finalVerifyAppSignatureSync: inspectMacAppSignatureSync,
    inspectExecutableArchitecture: async executableRealpath => {
      const result = spawnSync('/usr/bin/lipo', ['-archs', executableRealpath], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 4 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result.error || result.status !== 0) return null
      const architectures = result.stdout.trim().split(/\s+/u).filter(Boolean)
      if (architectures.length !== 1) return null
      return architectures[0] === 'arm64'
        ? 'arm64'
        : architectures[0] === 'x86_64'
          ? 'x64'
          : null
    },
    resolveKimiNativeReceipt: surface => {
      const receipt = resolveAcceptedKimiNativeReceipt(surface)
      return receipt ? {
        version: receipt.version,
        portableArtifactFingerprint: receipt.portableArtifactFingerprint,
      } : null
    },
  }
}

async function stableCanonicalNodeProof(
  targetPath: string,
  expectedKind: 'directory' | 'file',
): Promise<string> {
  const canonicalPath = path.resolve(targetPath)
  const before = await fs.lstat(canonicalPath, { bigint: true })
  if (before.isSymbolicLink()
    || (expectedKind === 'directory' ? !before.isDirectory() : !before.isFile())) {
    throw new Error('desktop_trust_node_type_changed')
  }
  if (path.resolve(await fs.realpath(canonicalPath)) !== canonicalPath) {
    throw new Error('desktop_trust_node_not_canonical')
  }
  const after = await fs.lstat(canonicalPath, { bigint: true })
  const beforeIdentity = desktopNodeIdentity(before)
  if (beforeIdentity !== desktopNodeIdentity(after)) {
    throw new Error('desktop_trust_node_changed_during_snapshot')
  }
  return sha256Json({ canonicalPath, expectedKind, identity: beforeIdentity })
}

async function stableDesktopExecutableProof(executablePath: string): Promise<string> {
  const nodeBefore = await stableCanonicalNodeProof(executablePath, 'file')
  const handle = await fs.open(executablePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  let descriptorFingerprint: string
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('desktop_trust_executable_type_invalid')
    if ((Number(before.mode & 0o7777n) & 0o111) === 0) {
      throw new Error('desktop_trust_executable_mode_invalid')
    }
    const after = await handle.stat({ bigint: true })
    const identity = desktopNodeIdentity(before)
    if (identity !== desktopNodeIdentity(after)) {
      throw new Error('desktop_trust_executable_changed_during_snapshot')
    }
    descriptorFingerprint = sha256Json({ canonicalPath: executablePath, identity })
  } finally {
    await handle.close()
  }
  const nodeAfter = await stableCanonicalNodeProof(executablePath, 'file')
  if (nodeAfter !== nodeBefore) throw new Error('desktop_trust_executable_changed_during_snapshot')
  return sha256Json({ nodeFingerprint: nodeBefore, descriptorFingerprint })
}

/**
 * Final no-await binding used immediately after the platform attestor returns.
 * It prevents a valid, same-Team replacement at the stable path from borrowing
 * the receipt and surface frozen for the prior App generation.
 */
function stableDesktopSurfaceIdentityProofSync(appPath: string, executablePath: string): string {
  const canonicalApp = path.resolve(appPath)
  const canonicalExecutable = path.resolve(executablePath)
  const infoPlist = path.join(canonicalApp, 'Contents', 'Info.plist')
  const appBefore = fsSync.lstatSync(canonicalApp, { bigint: true })
  const infoBefore = fsSync.lstatSync(infoPlist, { bigint: true })
  const executableBefore = fsSync.lstatSync(canonicalExecutable, { bigint: true })
  if (appBefore.isSymbolicLink() || !appBefore.isDirectory()
    || infoBefore.isSymbolicLink() || !infoBefore.isFile()
    || executableBefore.isSymbolicLink() || !executableBefore.isFile()
    || (Number(executableBefore.mode & 0o7777n) & 0o111) === 0
    || path.resolve(fsSync.realpathSync(canonicalApp)) !== canonicalApp
    || path.resolve(fsSync.realpathSync(infoPlist)) !== infoPlist
    || path.resolve(fsSync.realpathSync(canonicalExecutable)) !== canonicalExecutable) {
    throw new Error('desktop_trust_final_surface_invalid')
  }
  if (infoBefore.size > 256n * 1024n) throw new Error('desktop_trust_final_info_plist_too_large')
  const infoContent = fsSync.readFileSync(infoPlist)
  const appAfter = fsSync.lstatSync(canonicalApp, { bigint: true })
  const infoAfter = fsSync.lstatSync(infoPlist, { bigint: true })
  const executableAfter = fsSync.lstatSync(canonicalExecutable, { bigint: true })
  if (desktopNodeIdentity(appBefore) !== desktopNodeIdentity(appAfter)
    || desktopNodeIdentity(infoBefore) !== desktopNodeIdentity(infoAfter)
    || desktopNodeIdentity(executableBefore) !== desktopNodeIdentity(executableAfter)) {
    throw new Error('desktop_trust_final_surface_changed')
  }
  return sha256Json({
    app: desktopNodeIdentity(appBefore),
    infoPlist: desktopNodeIdentity(infoBefore),
    infoPlistSha256: createHash('sha256').update(infoContent).digest('hex'),
    executable: desktopNodeIdentity(executableBefore),
  })
}

function desktopNodeIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

export function productionAgentDiscoveryExecutableDirectories(
  homeDir: string,
  inheritedPath = process.env.PATH ?? '',
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const rawOpenClawPrefix = environment.OPENCLAW_PREFIX?.trim()
  const openClawPrefix = rawOpenClawPrefix === '~'
    ? homeDir
    : rawOpenClawPrefix?.startsWith('~/')
      ? path.join(homeDir, rawOpenClawPrefix.slice(2))
      : rawOpenClawPrefix
  const boundedVersionBins = (
    versionsRoot: string,
    binSuffix: readonly string[],
    maxEntries = 64,
  ): string[] => {
    if (!path.isAbsolute(versionsRoot)) return []
    let directory: Dir | undefined
    try {
      directory = fsSync.opendirSync(versionsRoot)
      const entries: Dirent[] = []
      for (;;) {
        const entry = directory.readSync()
        if (!entry) break
        // Fail closed after a bounded number of direct children instead of
        // allocating or walking an unexpectedly large version registry.
        if (entries.length === maxEntries) return []
        entries.push(entry)
      }
      return entries
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => path.join(versionsRoot, entry.name, ...binSuffix))
    } catch {
      return []
    } finally {
      directory?.closeSync()
    }
  }
  const absoluteEnvironmentRoot = (name: string, fallback: string): string => {
    const raw = environment[name]?.trim()
    if (!raw) return fallback
    if (raw === '~') return homeDir
    if (raw.startsWith('~/')) return path.join(homeDir, raw.slice(2))
    return path.isAbsolute(raw) ? path.normalize(raw) : fallback
  }
  const nvmRoot = absoluteEnvironmentRoot('NVM_DIR', path.join(homeDir, '.nvm'))
  const fnmRoots = [...new Set([
    absoluteEnvironmentRoot('FNM_DIR', path.join(homeDir, '.local', 'share', 'fnm')),
    path.join(homeDir, '.fnm'),
    path.join(homeDir, 'Library', 'Application Support', 'fnm'),
  ])]
  const asdfRoot = absoluteEnvironmentRoot('ASDF_DATA_DIR', path.join(homeDir, '.asdf'))
  const miseRoot = absoluteEnvironmentRoot('MISE_DATA_DIR', path.join(homeDir, '.local', 'share', 'mise'))
  const yarnGlobalRoot = absoluteEnvironmentRoot(
    'YARN_GLOBAL_FOLDER',
    path.join(homeDir, '.config', 'yarn', 'global'),
  )
  const inheritedDirectories = inheritedPath
    .split(path.delimiter)
    .filter(directory => path.isAbsolute(directory))
    .slice(0, 128)
  const candidates = [
    ...inheritedDirectories,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.openclaw', 'bin'),
    ...(openClawPrefix && path.isAbsolute(openClawPrefix)
      ? [path.join(path.normalize(openClawPrefix), 'bin')]
      : []),
    path.join(homeDir, '.kimi-code', 'bin'),
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, 'Library', 'pnpm'),
    path.join(homeDir, '.npm-global', 'bin'),
    ...boundedVersionBins(path.join(nvmRoot, 'versions', 'node'), ['bin']),
    ...fnmRoots.flatMap(root => [
      path.join(root, 'aliases', 'default', 'bin'),
      ...boundedVersionBins(path.join(root, 'node-versions'), ['installation', 'bin']),
    ]),
    ...boundedVersionBins(path.join(asdfRoot, 'installs', 'nodejs'), ['bin']),
    ...boundedVersionBins(path.join(miseRoot, 'installs', 'node'), ['bin']),
    path.join(yarnGlobalRoot, 'node_modules', '.bin'),
    path.join(homeDir, '.yarn', 'bin'),
  ]
  return [...new Set(candidates.filter(directory => path.isAbsolute(directory)))].slice(0, 256)
}

export async function findExecutablesForAgentDiscovery(
  command: string,
  executableDirectories: readonly string[],
): Promise<readonly string[]> {
  if (!/^[A-Za-z0-9._+-]{1,128}$/u.test(command)) return []
  const matches: string[] = []
  for (const directory of executableDirectories.slice(0, 256)) {
    const candidate = path.join(directory, command)
    if (matches.includes(candidate)) continue
    try {
      await fs.access(candidate, 1)
      // Preserve each PATH entry itself. Discovery resolves and proves every
      // candidate separately, including launcher symlinks such as OpenClaw.
      matches.push(candidate)
    } catch {
      continue
    }
  }
  return matches
}

export async function findExecutableForAgentDiscovery(
  command: string,
  executableDirectories: readonly string[],
): Promise<string | undefined> {
  return (await findExecutablesForAgentDiscovery(command, executableDirectories))[0]
}

export function discoveryEnvironment(): Readonly<Record<string, string | undefined>> {
  const names = [
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH',
    'KIMI_CODE_HOME', 'OPENCLAW_HOME', 'OPENCLAW_PREFIX',
    'QWEN_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG',
    'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE',
  ] as const
  return Object.fromEntries(names.map(name => [name, process.env[name]]))
}

function safeUserIdentity(): string {
  let source: string
  try {
    source = `uid:${process.getuid?.() ?? 'unknown'}`
  } catch {
    source = 'uid:unavailable'
  }
  return `usr_${createHash('sha256').update(source).digest('hex').slice(0, 20)}`
}
