import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
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
  inspectStableDesktopBundleSurface,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  type AppCodeSignatureResult,
  type DiscoveryDependencies,
  type PackageMetadataProofNode,
  type StableFileFingerprint,
} from './discovery.js'
import {
  readStableFileMetadata,
  inspectPassiveCliVersion,
  readStableFileFingerprint,
  readStableFileSnapshot,
} from './passive-cli-version.js'
import { sha256Json } from './fingerprint.js'
import { adoptProvableLegacyConnections } from './legacy-adoption.js'
import type { NotificationPort, UserNotification } from './events.js'
import { createP0HostAdapters } from './hosts/p0-adapter-registry.js'
import { SqliteHostActivityEvidenceReader } from './host-activity-evidence.js'
import { ManagedAgentReconciler, type ManagedArtifactObservation } from './reconciler.js'
import {
  AgentIntegrationService,
  type AgentIntegrationExecutionPort,
  type AgentIntegrationScannerPort,
} from './service.js'
import {
  AgentIntegrationRepository,
  frozenProjectionSurfaceFingerprint,
  persistedDistribution,
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
} from './types.js'
import {
  getHookScriptPath,
  getMcpServerScriptPath,
  getPostCompactHookScriptPath,
  getPreCompactHookScriptPath,
  getShimPath,
} from '../runtime/runtime-paths.js'

const DEFAULT_MAINTENANCE_INTERVAL_MS = 4 * 60 * 60 * 1_000
const WRITE_GATE_ENV = 'TIDEMIND_AGENT_INTEGRATION_WRITES'
const ADAPTER_GATE_ENV = 'TIDEMIND_AGENT_INTEGRATION_ENABLED_ADAPTERS'
const AUTO_RESTORE_GATE_ENV = 'TIDEMIND_AGENT_INTEGRATION_AUTO_RESTORE'

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
 * Production composition root. The default is deliberately observe-only:
 * writes require both the global rollout gate and an explicit per-adapter allowlist.
 */
export function createProductionAgentIntegrationComposition(
  db: Database.Database,
  options: ProductionAgentIntegrationOptions = {},
): ProductionAgentIntegrationComposition {
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const applicationDataDir = path.resolve(options.applicationDataDir ?? app.getPath('userData'))
  const allAdapters = options.adapters ?? createP0HostAdapters()
  const implementedComponents = new Map(
    [...allAdapters].map(([catalogId, adapter]) => [catalogId, adapter.componentKeys] as const),
  )
  const implementedArtifactTypes = new Map(
    [...allAdapters].map(([catalogId, adapter]) => [catalogId, adapter.implementationTypes] as const),
  )
  const enabledAdapterIds = enabledAdapters(allAdapters, options.enabledAdapterIds)
  const observeOnly = options.observeOnly ?? !productionWriteGateEnabled()
  const activeAdapterIds = observeOnly ? [] : enabledAdapterIds
  const activeAdapterSet = new Set(activeAdapterIds)
  const managedAdapters: AdapterResolverPort = {
    get: id => activeAdapterSet.has(id) ? allAdapters.get(id) : undefined,
  }
  // A rollout/kill switch blocks new work, but persisted non-terminal runs must
  // still be recoverable through their reviewed Adapter implementation.
  const recoveryAdapters: AdapterResolverPort = { get: id => allAdapters.get(id) }
  const clock = options.clock ?? { now: () => new Date() }
  const ids = options.ids ?? { next: prefix => `${prefix}_${randomUUID()}` }
  const notificationLocale = options.notificationLocale ?? 'en'
  const notifications = options.notifications ?? productionNotifications({
    onOpenInstallation: options.onOpenInstallation,
    onInAppNotification: options.onInAppNotification,
    isAppActive: options.isAppActive,
  })
  const repository = new AgentIntegrationRepository(db)
  const discoveryDependencies = options.discoveryDependencies ?? productionDiscoveryDependencies()
  const canManageInstallation = options.canManageInstallation
    ?? (row => isProductionInstallationTrusted(row))
  const liveTrustAttestor = options.liveTrustAttestor
    ?? (options.canManageInstallation
      ? async (row: AgentInstallationRow) => sha256Json({
          fixtureTrust: persistedProjectionSurfaceFingerprint(row),
        })
      : createProductionLiveTrustAttestor(discoveryDependencies))
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
      && canManageInstallation(current),
    )
  }
  const attestCurrentRow = async (
    observed: AgentInstallationRow,
    expectedProofFingerprint?: string,
  ): Promise<string | null> => {
    const before = repository.getInstallation(observed.id)
    if (!before || persistedProjectionSurfaceFingerprint(before)
      !== persistedProjectionSurfaceFingerprint(observed) || !canManageInstallation(before)) return null
    const proof = await liveTrustAttestor(before)
    if (!proof || (expectedProofFingerprint && proof !== expectedProofFingerprint)) return null
    const after = repository.getInstallation(observed.id)
    return after
      && persistedProjectionSurfaceFingerprint(after) === persistedProjectionSurfaceFingerprint(before)
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
  const runtimeContext = options.runtimeContext ?? defaultRuntimeContext(homeDir, applicationDataDir)
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
    autoRestore: options.autoRestore ?? process.env[AUTO_RESTORE_GATE_ENV] !== '0',
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
  const scanner = options.scanner ?? createProductionScanner(
    homeDir,
    discoveryDependencies,
  )
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
    refreshVerificationFreshness,
    notifications,
    notificationLocale,
    homeDir,
    fixtureMode: options.fixtureMode,
    enabledCatalogIds: activeAdapterIds,
    implementedComponents,
    implementedArtifactTypes,
    canManageInstallation,
    cliManagementProofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    attestInstallation: async (row, expectedProof) => Boolean(
      await attestCurrentRow(row, expectedProof),
    ),
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
  }
}

const TRUSTED_APP_BUNDLE_IDS: Readonly<Partial<Record<CatalogId, readonly string[]>>> = Object.freeze({
  'claude-desktop-legacy': ['com.anthropic.claudefordesktop'],
  'codex-desktop': ['com.openai.codex'],
  'cursor-desktop': ['com.todesktop.230313mzl4w4u92'],
  'windsurf-desktop': ['com.codeium.windsurf'],
  'qwenwork-desktop': ['com.alibaba.qwenwork'],
  'zcode-desktop': ['dev.zcode.app'],
})

const TRUSTED_SIGNED_APP_PROVENANCE: Readonly<Partial<Record<CatalogId, readonly string[]>>> = Object.freeze({
  'claude-desktop-legacy': ['signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW'],
  'cursor-desktop': ['signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9'],
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
  'pi-official-cli': [
    'npm_metadata:@mariozechner/pi-coding-agent',
    'npm_metadata:@earendil-works/pi-coding-agent',
  ],
  'omp-cli': ['npm_metadata:@oh-my-pi/pi-coding-agent'],
})

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
export function isProductionInstallationTrusted(row: AgentInstallationRow): boolean {
  // A persisted distribution receipt is not current host-presence evidence.
  // Every writable channel must wait for one authoritative fresh scan.
  if (row.health_state !== 'discovered') return false
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

  const eligibility = persistedManagementEligibility(row)
  if (eligibility?.eligible !== true) return false
  const explicitExecutableRealpath = persistedExplicitExecutableRealpath(row)
  if (!explicitExecutableRealpath || !row.executable_path
    || !path.isAbsolute(explicitExecutableRealpath)
    || !path.isAbsolute(row.executable_path)
    || path.resolve(explicitExecutableRealpath) !== path.resolve(row.executable_path)) return false
  const provenance = distribution.packageProvenance
  const allowedProvenance = TRUSTED_CLI_PROVENANCE[row.host_variant as CatalogId] ?? []
  return Boolean(provenance && allowedProvenance.includes(provenance))
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
): (row: AgentInstallationRow) => Promise<string | null> {
  return async row => {
    if (!isProductionInstallationTrusted(row)) return null
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
        const physicalSurfaceBefore = stableDesktopSurfaceIdentityProofSync(appPath, executablePath)
        const signature = await dependencies.inspectAppSignature(appPath, {
          timeoutMs: 2_000,
          beforeFinalVerification: async () => {
            const surfaceAfter = await inspectStableDesktopBundleSurface(dependencies, appPath, 2_000)
            const appAfter = await stableCanonicalNodeProof(appPath, 'directory')
            const executableAfter = await stableDesktopExecutableProof(executablePath)
            if (surfaceAfter.fingerprint !== surfaceBefore.fingerprint
              || surfaceAfter.executableRealpath !== executablePath
              || appAfter !== appBefore || executableAfter !== executableBefore) {
              throw new Error('desktop_trust_physical_identity_changed_during_signature')
            }
          },
        })
        const surfaceFinal = await inspectStableDesktopBundleSurface(dependencies, appPath, 2_000)
        const appFinal = await stableCanonicalNodeProof(appPath, 'directory')
        const executableFinal = await stableDesktopExecutableProof(executablePath)
        if (surfaceFinal.fingerprint !== surfaceBefore.fingerprint
          || surfaceFinal.executableRealpath !== executablePath
          || appFinal !== appBefore || executableFinal !== executableBefore) return null
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
        if (!signatureReceiptFingerprint
          || finalSignatureReceiptFingerprint !== signatureReceiptFingerprint) return null
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

    if (!executable || !provenance?.startsWith('npm_metadata:')
      || !dependencies.fs.readStableFileFingerprint) return null
    const executablePath = path.resolve(executable)
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
      const metadataAfter = await dependencies.execVersion(executablePath, [], { timeoutMs: 2_000 })
      if (metadataAfter.exitCode !== 0
        || metadataAfter.stdout !== metadataBefore.stdout
        || metadataAfter.verifiedPackageProvenance !== metadataBefore.verifiedPackageProvenance
        || metadataAfter.packageMetadataFingerprint !== metadataBefore.packageMetadataFingerprint
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
): boolean {
  const nodes: Array<{ path: string; proof: StableFileFingerprint }> = [
    { path: executablePath, proof: executable },
    ...packageNodes.map(node => ({ path: node.path, proof: node })),
  ]
  if (nodes.some(node => !path.isAbsolute(node.path) || path.resolve(node.path) !== node.path)) return false
  const opened: Array<{ path: string; proof: StableFileFingerprint; fd: number }> = []
  try {
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
    return true
  } catch {
    return false
  } finally {
    for (const node of opened.reverse()) {
      try { fsSync.closeSync(node.fd) } catch { /* fail-closed result already chosen */ }
    }
  }
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
    if (this.maintenance) return this.maintenance
    this.maintenance = this.performMaintenance().finally(() => { this.maintenance = null })
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

function enabledAdapters(
  adapters: ReadonlyMap<CatalogId, AgentHostAdapter>,
  override?: readonly CatalogId[],
): CatalogId[] {
  const requested = override ?? String(process.env[ADAPTER_GATE_ENV] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter((value): value is CatalogId => value.length > 0)
  return [...new Set(requested)].filter(id => adapters.has(id))
}

function productionWriteGateEnabled(): boolean {
  return process.env[WRITE_GATE_ENV] === '1'
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
  const inaccessible = !inspection.detected || inspection.diagnostics.some(diagnostic =>
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
    }, dependencies),
  }
}

function productionDiscoveryDependencies(): DiscoveryDependencies {
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
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      },
      realpath: targetPath => fs.realpath(targetPath),
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
    },
    which: findExecutable,
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
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      },
      realpath: targetPath => fs.realpath(targetPath),
      readStableFileSnapshot,
    }),
    inspectAppSignature: inspectMacAppSignature,
    finalVerifyAppSignatureSync: inspectMacAppSignatureSync,
  }
}

type CodesignRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>

type CodesignSyncRunner = (
  args: readonly string[],
  timeoutMs: number,
) => { stdout: string; stderr: string }

export async function inspectMacAppSignature(
  appBundleRealpath: string,
  options: { timeoutMs: number; beforeFinalVerification?: () => Promise<void> },
  codesign: CodesignRunner = runCodesign,
): Promise<AppCodeSignatureResult> {
  const before = await readMacAppSignatureReceipt(appBundleRealpath, options.timeoutMs, codesign)
  // `--strict` tightens validation but does not recursively verify nested
  // frameworks, plug-ins, helpers, or their full sealed contents. Production
  // trust promises an exact bundle proof, so every verification boundary must
  // include `--deep` (deprecated for signing, still required for verification).
  await codesign(['--verify', '--deep', '--strict', appBundleRealpath], options.timeoutMs)
  const after = await readMacAppSignatureReceipt(appBundleRealpath, options.timeoutMs, codesign)
  if (desktopSignatureReceiptFingerprint(before) !== desktopSignatureReceiptFingerprint(after)) {
    throw new Error('desktop_signature_receipt_changed_during_verification')
  }
  await options.beforeFinalVerification?.()
  // This must remain the last codesign operation. Any nested-code/resource
  // mutation after the receipt was read is rejected before trust is returned.
  await codesign(['--verify', '--deep', '--strict', appBundleRealpath], options.timeoutMs)
  return { valid: true, ...after, verificationBoundary: 'strict_final' }
}

/**
 * The production write boundary cannot end with an awaited codesign process:
 * a queued filesystem mutation would run before the caller resumes. Keep the
 * final receipt/recursive verification sequence synchronous, then let the
 * caller perform its no-await App/Info.plist/executable CAS immediately.
 */
export function inspectMacAppSignatureSync(
  appBundleRealpath: string,
  timeoutMs: number,
  codesign: CodesignSyncRunner = runCodesignSync,
): AppCodeSignatureResult {
  const before = readMacAppSignatureReceiptSync(appBundleRealpath, timeoutMs, codesign)
  codesign(['--verify', '--deep', '--strict', appBundleRealpath], timeoutMs)
  const after = readMacAppSignatureReceiptSync(appBundleRealpath, timeoutMs, codesign)
  if (desktopSignatureReceiptFingerprint(before) !== desktopSignatureReceiptFingerprint(after)) {
    throw new Error('desktop_signature_receipt_changed_during_final_verification')
  }
  // This is deliberately the final platform operation on the successful
  // path. No Promise is created between it and the caller's synchronous CAS.
  codesign(['--verify', '--deep', '--strict', appBundleRealpath], timeoutMs)
  return { valid: true, ...after, verificationBoundary: 'strict_final' }
}

async function readMacAppSignatureReceipt(
  appBundleRealpath: string,
  timeoutMs: number,
  codesign: CodesignRunner,
): Promise<{
  identifier?: string
  teamIdentifier?: string
  cdHash?: string
  designatedRequirement?: string
}> {
  const details = await codesign(['-dv', '--verbose=4', appBundleRealpath], timeoutMs)
  const output = `${details.stdout}\n${details.stderr}`
  const requirements = await codesign(['-d', '-r-', appBundleRealpath], timeoutMs)
  const requirementOutput = `${requirements.stdout}\n${requirements.stderr}`
  return {
    identifier: output.match(/^Identifier=(.+)$/mu)?.[1]?.trim(),
    teamIdentifier: output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim(),
    cdHash: output.match(/^CDHash=([A-Fa-f0-9]+)$/mu)?.[1]?.toLowerCase(),
    designatedRequirement: requirementOutput.match(/^designated => (.+)$/mu)?.[1]?.trim(),
  }
}

function readMacAppSignatureReceiptSync(
  appBundleRealpath: string,
  timeoutMs: number,
  codesign: CodesignSyncRunner,
): {
  identifier?: string
  teamIdentifier?: string
  cdHash?: string
  designatedRequirement?: string
} {
  const details = codesign(['-dv', '--verbose=4', appBundleRealpath], timeoutMs)
  const output = `${details.stdout}\n${details.stderr}`
  const requirements = codesign(['-d', '-r-', appBundleRealpath], timeoutMs)
  const requirementOutput = `${requirements.stdout}\n${requirements.stderr}`
  return {
    identifier: output.match(/^Identifier=(.+)$/mu)?.[1]?.trim(),
    teamIdentifier: output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim(),
    cdHash: output.match(/^CDHash=([A-Fa-f0-9]+)$/mu)?.[1]?.toLowerCase(),
    designatedRequirement: requirementOutput.match(/^designated => (.+)$/mu)?.[1]?.trim(),
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

function desktopSignatureReceiptFingerprint(signature: {
  cdHash?: string
  designatedRequirement?: string
}): string | null {
  const cdHash = signature.cdHash?.trim().toLowerCase()
  const designatedRequirement = signature.designatedRequirement?.trim()
  if (!cdHash || !/^[a-f0-9]{20,128}$/u.test(cdHash)
    || !designatedRequirement || designatedRequirement.length > 8 * 1024) return null
  return sha256Json({ cdHash, designatedRequirement })
}

function runCodesign(
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/codesign', [...args], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}

function runCodesignSync(
  args: readonly string[],
  timeoutMs: number,
): { stdout: string; stderr: string } {
  const result = spawnSync('/usr/bin/codesign', [...args], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`codesign failed with status ${result.status ?? 'unknown'}: ${result.stderr}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

async function findExecutable(command: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._+-]{1,128}$/u.test(command)) return undefined
  const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory))
  for (const directory of candidates) {
    const candidate = path.join(directory, command)
    try {
      await fs.access(candidate, 1)
      return await fs.realpath(candidate)
    } catch {
      continue
    }
  }
  return undefined
}

function discoveryEnvironment(): Readonly<Record<string, string | undefined>> {
  const names = [
    'KIMI_CODE_HOME', 'QWEN_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG',
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
