import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY,
  AGENT_INTEGRATION_WRITER_PROTOCOL,
} from '@server/db/agent-integration-schema.js'
import { sanitizeAgentIntegrationEventPersistence } from '@server/db/agent-integration-event-sanitizer.js'
import type {
  ArtifactComponentType,
  CatalogId,
  ComponentKey,
  DistributionIdentity,
  InstallationIdentityRecord,
  ProductFamilyId,
  RuntimeRealm,
} from './types.js'
import { sha256Json } from './fingerprint.js'
import {
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
} from './discovery.js'

const AGENT_INTEGRATION_LAST_SUCCESSFUL_SCAN_AT_KEY = 'agent_integration_last_successful_scan_at'

export interface LegacyAgentRow {
  id: string
  name: string
  tool_type: string
  archived: number
  last_active: string | null
  created: string
}

export interface LegacyAdoptionArtifactInput {
  id: string
  componentKey: ComponentKey
  artifactType: ArtifactComponentType
  targetPath: string
  ownershipKey: string
  mutationDomain: string
  projectionVersion: string
  selectorSchemaVersion: string
  containerHash?: string | null
  fragmentHash: string
  discoverReachability: 'dedicated' | 'shared_visible' | 'per_host_ignorable'
}

export type InstallationDesiredState = 'unmanaged' | 'managed' | 'disabled' | 'removed'
export type VerificationStatus = 'unverified' | 'verifying' | 'verified' | 'stale' | 'failed'
export type ArtifactState =
  | 'healthy'
  | 'missing'
  | 'drifted'
  | 'conflict'
  | 'paused'
  | 'removal_pending'
  | 'removed'
  | 'needs_recovery'

export interface AgentInstallationRow {
  id: string
  family: string
  host_variant: string
  runtime_realm: string
  profile_id: string
  install_key: string
  distribution_id: string | null
  provenance: string
  os_user_identity: string | null
  display_name: string
  display_alias: string | null
  config_root: string | null
  executable_path: string | null
  app_path: string | null
  detected_version: string | null
  version_detection_method: string | null
  agent_id: string | null
  desired_state: InstallationDesiredState
  tombstoned_at: string | null
  tombstone_reason: string | null
  consent_envelope_id: string | null
  consented_at: string | null
  supported_capability: number
  desired_capability: number
  verified_capability: number
  delivery_summary: 'cataloged' | 'detectable' | 'guided' | 'hybrid' | 'fully_managed'
  verification_summary: 'unverified' | 'verifying' | 'verified' | 'stale' | 'failed' | 'mixed'
  health_state: string
  status_reason: string | null
  reconcile_state:
    | 'idle'
    | 'planning'
    | 'awaiting_consent'
    | 'applying'
    | 'verifying'
    | 'compensating'
    | 'needs_recovery'
    | 'backoff'
    | 'paused'
  last_detected_at: string | null
  last_verified_at: string | null
  verification_result_id: string | null
  last_repaired_at: string | null
  metadata_json: string
  created_at: string
  updated_at: string
}

export interface DisconnectArtifactScope {
  artifactId: string
  initiatingInstallationId: string
  componentKey: ComponentKey
  targetPath: string
  ownershipKey: string
  consumers: Array<{
    installationId: string
    displayName: string
    hostVariant: CatalogId
    profileId: string
    componentKey: ComponentKey
    discoverReachability: 'dedicated' | 'shared_visible' | 'per_host_ignorable'
  }>
}

export interface WriterFenceRow {
  mutation_domain: string
  scope_mode: 'legacy' | 'managed'
  minimum_writer_protocol: number
  writer_generation: number
  owner_instance_id: string | null
  epoch: number
  lease_expires_at: number | null
  state: 'active' | 'released'
  metadata_json: string
  created_at: string
  updated_at: string
}

export interface DiscoverInstallationInput {
  id: string
  family: string
  hostVariant: string
  runtimeRealm?: string
  profileId?: string
  installKey: string
  distributionId?: string | null
  provenance: string
  osUserIdentity?: string | null
  displayName: string
  configRoot?: string | null
  executablePath?: string | null
  appPath?: string | null
  detectedVersion?: string | null
  versionDetectionMethod?: string | null
  agentId?: string | null
  supportedCapability?: number
  lastDetectedAt: string
  metadata?: unknown
}

export interface InstallationComponentInput {
  installationId: string
  componentKey: string
  desiredState: InstallationDesiredState
  desiredCapability: number
  deliveryMode: 'cataloged' | 'detectable' | 'guided' | 'managed'
  verificationStatus?: VerificationStatus
  verificationResultId?: string | null
  artifactId?: string | null
  visibilityState?: 'absent' | 'dedicated' | 'shared_visible' | 'hidden' | 'unknown'
  consentEnvelopeId?: string | null
}

export interface ManagedArtifactInput {
  id: string
  runtimeRealm?: string
  componentType: 'skill' | 'mcp' | 'hook' | 'plugin' | 'rule'
  targetPath: string
  ownershipKey?: string
  mutationDomain: string
  projectionVersion: string
  selectorSchemaVersion: string
  containerPreconditionHash?: string | null
  ownedFragmentHash?: string | null
  desiredFragmentHash?: string | null
  observedFragmentHash?: string | null
  previousSnapshotRef?: string | null
  state?: ArtifactState
}

export interface ConsentInput {
  id: string
  installationId: string
  policyVersion: string
  allowedComponents: unknown
  allowedScopes: unknown
  normalizedTargets: unknown
  selectorSchemaVersion: string
  selectorResolution: unknown
  executableRealpaths: unknown
  commandCategories: unknown
  maximumRisk: 'read_only' | 'low' | 'elevated' | 'high'
  exceptionScope?: 'global' | 'installation'
  exceptions?: unknown
  confirmedAt: string
  /** Production consent creation CAS; omitted only by lower-level fixtures. */
  expectedInstallationSurfaceFingerprint?: string
}

export interface ReconcileRunInput {
  id: string
  installationId?: string | null
  operationType: string
  executionPlanHash: string
  consentEnvelopeId?: string | null
  recoveryStrategy: string
  writerFenceSnapshot?: unknown
  adapterVersion?: string | null
  catalogVersion?: string | null
  projectionVersion?: string | null
  selectorSchemaVersion?: string | null
  createdAt: string
}

export interface ApplyTaskRunRow {
  id: string
  installation_id: string
  execution_plan_hash: string
  state: string
  failure_code: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

export interface LegacyNullApplyTaskRunResolution {
  bindings: Array<{
    taskId: string
    installationId: string
    run: ApplyTaskRunRow
  }>
  ambiguousRuns: ApplyTaskRunRow[]
  candidateRuns: ApplyTaskRunRow[]
}

export interface ApplyTaskFeedCursorInput {
  limit: number
  cursor?: string
  nowMs: number
}

export type ApplyTaskFeedEntryRow =
  | {
      key: `task:${string}`
      priority: number
      startedAt: string
      task: DurableApplyTaskRow
      overlayRuns: ApplyTaskRunRow[]
      ambiguousLegacy: boolean
    }
  | {
      key: `run:${string}`
      priority: number
      startedAt: string
      run: ApplyTaskRunRow
      ambiguousLegacy: boolean
    }

export interface ApplyTaskFeedPageRow {
  entries: ApplyTaskFeedEntryRow[]
  attentionCount: number
  activeCount: number
  totalCount: number
  startIndex: number
  hasMore: boolean
  hasPrevious: boolean
  nextCursor: string | null
  previousCursor: string | null
}

interface ApplyTaskFeedRef {
  key: `task:${string}` | `run:${string}`
  source: 'task' | 'run'
  stableId: string
  priority: number
  startedAt: string
  overlayRunIds: string[]
  ambiguousLegacy: boolean
}

interface ApplyTaskFeedCursorPayload {
  version: 1
  revision: string
  snapshotAtMs: number
  direction: 'next' | 'previous'
  priority: number
  startedAt: string
  source: 'task' | 'run'
  stableId: string
}

interface ApplyTaskFeedItemFact {
  task_id: string
  installation_id: string
  state: string
  run_id: string | null
  payload_status: string | null
  payload_installation_id: string | null
  payload_run_id: string | null
  exact_run_correlation: number
  run_state: string | null
}

interface ApplyTaskFeedTraversalCache {
  revision: string
  snapshotAtMs: number
  refs: ApplyTaskFeedRef[]
  runsById: Map<string, ApplyTaskRunRow>
  attentionCount: number
  activeCount: number
}

export interface DurableApplyTaskRow {
  id: string
  plan_hash: string
  operation_type: 'connect'
  state: 'running' | 'completed'
  started_at: string
  completed_at: string | null
  updated_at: string
  items: Array<{
    installation_id: string
    run_id: string | null
    execution_plan_hash: string
    state: 'pending' | 'running' | 'terminal' | 'interrupted'
    result_json: string | null
    exact_run_correlation: number
    exact_run_state: string | null
    exact_run_failure_code: string | null
    exact_run_created_at: string | null
    exact_run_started_at: string | null
    exact_run_completed_at: string | null
    exact_run_updated_at: string | null
    started_at: string | null
    ordinal: number
  }>
}

export interface ProjectionMutationInput {
  id: string
  runId: string
  operationId: string
  installationId?: string | null
  componentKey?: string | null
  artifactId?: string | null
  mutationDomain: string
  target: string
  beforeHash?: string | null
  afterHash?: string | null
  precondition?: unknown
  adapterVersion?: string | null
  catalogVersion?: string | null
  projectionVersion?: string | null
  selectorSchemaVersion?: string | null
  writerFenceEpoch?: number | null
  writerGeneration?: number | null
  idempotencyStrategy: string
  readbackStrategy: string
  compensationPrecondition?: string | null
  createdAt: string
}

export interface VerificationResultInput {
  id: string
  runId?: string | null
  installationId: string
  componentKey: string
  family: string
  hostVariant: string
  distributionId?: string | null
  runtimeRealm: string
  hostVersion?: string | null
  osVersion?: string | null
  tideMindVersion?: string | null
  adapterVersion: string
  catalogVersion: string
  projectionVersion?: string | null
  selectorSchemaVersion?: string | null
  verificationManifestVersion: string
  method: string
  identityAssertion?: string | null
  artifactHash?: string | null
  reloadGeneration?: string | null
  invalidationKeys?: readonly string[]
  result: 'verified' | 'failed'
  evidenceRef?: string | null
  evidenceHash: string
  verifiedAt: string
  expiresAt?: string | null
}

export interface VerificationFreshnessInput {
  now: string
  osVersion: string
  catalogVersion: string
  projectionVersion: string
  tideMindVersion?: string
  adapterVersion(hostVariant: string): string | undefined
  reloadGeneration?(installationId: string, componentKey: string): string | undefined
}

export interface IntegrationEventInput {
  id?: string
  installationId?: string | null
  componentKey?: string | null
  artifactId?: string | null
  kind: string
  severity?: 'info' | 'warning' | 'error'
  episodeId?: string | null
  dedupeKey?: string | null
  payload?: unknown
  createdAt: string
}

function json(value: unknown, fallback: unknown): string {
  return JSON.stringify(value === undefined ? fallback : value)
}

function assertCapability(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error(`capability must be an integer from 0 to 4, got ${value}`)
  }
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export interface PersistedManagementEligibility {
  schemaVersion: typeof CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION
  eligible: boolean
  reason?: 'executable_proof_too_large' | 'executable_metadata_unavailable'
  executableSizeBytes?: number
  proofLimitBytes: number
}

export function persistedManagementEligibility(
  row: AgentInstallationRow,
): PersistedManagementEligibility | null {
  const metadata = safeJsonObject(row.metadata_json)
  if (metadata.managementEligibility === undefined || metadata.managementEligibility === null) return null
  const invalid: PersistedManagementEligibility = {
    schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
    eligible: false,
    reason: 'executable_metadata_unavailable',
    proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
  }
  const source = safeJsonObject(metadata.managementEligibility)
  if (source.schemaVersion !== CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION
    || typeof source.eligible !== 'boolean'
    || source.proofLimitBytes !== MAX_CLI_EXECUTABLE_PROOF_BYTES
    || (source.executableSizeBytes !== undefined && source.executableSizeBytes !== null
      && (!Number.isSafeInteger(source.executableSizeBytes) || Number(source.executableSizeBytes) < 0))) return invalid
  const rawReason = stringOrUndefined(source.reason)
  if (rawReason && rawReason !== 'executable_proof_too_large' && rawReason !== 'executable_metadata_unavailable') {
    return invalid
  }
  const reason: PersistedManagementEligibility['reason'] = rawReason === 'executable_proof_too_large'
    ? rawReason
    : rawReason === 'executable_metadata_unavailable'
      ? rawReason
      : undefined
  const result: PersistedManagementEligibility = {
    schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
    eligible: source.eligible,
    reason,
    executableSizeBytes: typeof source.executableSizeBytes === 'number'
      ? source.executableSizeBytes
      : undefined,
    proofLimitBytes: source.proofLimitBytes as number,
  }
  if (result.eligible) {
    if (result.reason || result.executableSizeBytes === undefined
      || result.executableSizeBytes > result.proofLimitBytes) return invalid
  } else if (result.reason === 'executable_proof_too_large') {
    if (result.executableSizeBytes === undefined
      || result.executableSizeBytes <= result.proofLimitBytes) return invalid
  } else if (result.reason !== 'executable_metadata_unavailable') {
    return invalid
  }
  return result
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string')
      ? parsed
      : []
  } catch {
    return []
  }
}

function stableStringRecord(value: unknown): Readonly<Record<string, string>> {
  const source = safeJsonObject(value)
  return Object.fromEntries(Object.entries(source)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right)))
}

const frozenProjectionSurfaceFingerprints = new WeakMap<DistributionIdentity, string>()

/**
 * Canonical discovery-owned surface that an approved projection is allowed to
 * target. Volatile presentation/timestamp fields are deliberately excluded;
 * every identity, distribution, capability and host path fact that can change
 * Adapter target selection is included.
 */
export function persistedProjectionSurfaceFingerprint(row: AgentInstallationRow): string {
  const metadata = safeJsonObject(row.metadata_json)
  const distribution = safeJsonObject(metadata.distribution)
  return sha256Json({
    family: row.family,
    hostVariant: row.host_variant,
    runtimeRealm: row.runtime_realm,
    profileId: row.profile_id || 'default',
    installKey: row.install_key,
    osUserIdentity: row.os_user_identity,
    configRoot: row.config_root,
    executablePath: row.executable_path,
    appPath: row.app_path,
    supportedCapability: row.supported_capability,
    hostOwnedIdentity: stringOrUndefined(metadata.hostOwnedIdentity) ?? null,
    distribution: {
      distributionId: stringOrUndefined(distribution.distributionId) ?? row.distribution_id ?? null,
      executableRealpath: stringOrUndefined(distribution.executableRealpath) ?? row.executable_path ?? null,
      packageProvenance: stringOrUndefined(distribution.packageProvenance) ?? null,
      capabilityFingerprint: stringOrUndefined(distribution.capabilityFingerprint) ?? null,
    },
    componentConfigFiles: stableStringRecord(metadata.componentConfigFiles),
    componentConfigRoots: stableStringRecord(metadata.componentConfigRoots),
    resourceRoots: stableStringRecord(metadata.resourceRoots),
    managementEligibility: persistedManagementEligibility(row),
  })
}

/** Fingerprint frozen on Coordinator Installations materialized from SQLite. */
export function frozenProjectionSurfaceFingerprint(distribution: DistributionIdentity): string | null {
  return frozenProjectionSurfaceFingerprints.get(distribution) ?? null
}

export function persistedDistribution(row: AgentInstallationRow): DistributionIdentity {
  const metadata = safeJsonObject(row.metadata_json)
  const distribution = safeJsonObject(metadata.distribution)
  const result: DistributionIdentity = {
    distributionId: stringOrUndefined(distribution.distributionId) ?? row.distribution_id ?? undefined,
    executableRealpath: stringOrUndefined(distribution.executableRealpath) ?? row.executable_path ?? undefined,
    packageProvenance: stringOrUndefined(distribution.packageProvenance),
    capabilityFingerprint: stringOrUndefined(distribution.capabilityFingerprint),
  }
  frozenProjectionSurfaceFingerprints.set(result, persistedProjectionSurfaceFingerprint(row))
  return result
}

export function persistedHostOwnedIdentity(row: AgentInstallationRow): string | undefined {
  return stringOrUndefined(safeJsonObject(row.metadata_json).hostOwnedIdentity)
}

export function persistedComponentConfigFiles(
  row: AgentInstallationRow,
): Readonly<Partial<Record<ComponentKey, string>>> | undefined {
  const source = safeJsonObject(safeJsonObject(row.metadata_json).componentConfigFiles)
  const result: Partial<Record<ComponentKey, string>> = {}
  for (const componentKey of ['instruction', 'memory_tools', 'lifecycle'] as const) {
    const value = stringOrUndefined(source[componentKey])
    if (!value) continue
    if (row.runtime_realm === 'local_macos') {
      if (!row.config_root || !path.isAbsolute(value)) {
        throw new Error(`Persisted ${componentKey} config file is not an absolute Installation path`)
      }
      const relative = path.relative(path.resolve(row.config_root), path.resolve(value))
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Persisted ${componentKey} config file is outside the Installation config root`)
      }
    }
    result[componentKey] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * v34 的本机 Agent repository。这里只封装 SQLite 状态和事务边界，不执行任何
 * 文件、CLI、Plugin 或宿主写入。所有时间都由调用方传入，便于恢复测试与审计。
 */
export class AgentIntegrationRepository {
  private applyTaskFeedTraversalCache: ApplyTaskFeedTraversalCache | null = null

  constructor(private readonly db: Database.Database) {}

  listLegacyAgents(): LegacyAgentRow[] {
    return this.db.prepare(`
      SELECT id, name, tool_type, archived, last_active, created
      FROM agents ORDER BY created, id
    `).all() as LegacyAgentRow[]
  }

  upsertDiscoveredInstallation(input: DiscoverInstallationInput): AgentInstallationRow {
    assertCapability(input.supportedCapability ?? 0)
    const runtimeRealm = input.runtimeRealm ?? 'local_macos'
    const now = input.lastDetectedAt
    return this.db.transaction(() => {
      const previous = this.getInstallationByInstallKey(runtimeRealm, input.installKey)
      const previousById = this.getInstallation(input.id)
      const incomingMetadata = safeJsonObject(input.metadata)
      const priorInstallation = previous ?? previousById
      const priorMetadata = priorInstallation ? safeJsonObject(priorInstallation.metadata_json) : {}
      const priorAliases = Array.isArray(priorMetadata.installKeyAliases)
        ? priorMetadata.installKeyAliases.filter((value): value is string => typeof value === 'string')
        : []
      let metadata = {
        ...incomingMetadata,
        ...(priorAliases.length > 0 ? { installKeyAliases: [...new Set(priorAliases)] } : {}),
      }
      if (previousById && previousById.install_key !== input.installKey) {
        const previousHostIdentity = persistedHostOwnedIdentity(previousById)
        const incomingHostIdentity = stringOrUndefined(incomingMetadata.hostOwnedIdentity)
        if (previousById.runtime_realm !== runtimeRealm
          || previousById.family !== input.family
          || previousById.host_variant !== input.hostVariant
          || (previousById.profile_id || 'default') !== (input.profileId || 'default')
          || previousById.os_user_identity !== (input.osUserIdentity ?? null)
          || !previousHostIdentity
          || previousHostIdentity !== incomingHostIdentity) {
          throw new Error('Installation install key changed without the same stable host identity')
        }
        if (previous && previous.id !== previousById.id) {
          throw new Error('Installation install key is already owned by another Installation')
        }
        metadata = {
          ...metadata,
          installKeyAliases: [...new Set([...priorAliases, previousById.install_key])],
        }
        const rekeyed = this.db.prepare(`
          UPDATE agent_installations SET install_key = ?, metadata_json = ?, updated_at = ?
          WHERE id = ? AND runtime_realm = ? AND install_key = ?
        `).run(
          input.installKey,
          json(metadata, {}),
          now,
          previousById.id,
          runtimeRealm,
          previousById.install_key,
        )
        if (rekeyed.changes !== 1) throw new Error('Installation changed during stable identity rekey')
      }
      this.db.prepare(`
      INSERT INTO agent_installations (
        id, family, host_variant, runtime_realm, profile_id, install_key,
        distribution_id, provenance, os_user_identity, display_name, config_root,
        executable_path, app_path, detected_version, version_detection_method,
        agent_id, supported_capability, last_detected_at, metadata_json, created_at, updated_at
      ) VALUES (
        @id, @family, @hostVariant, @runtimeRealm, @profileId, @installKey,
        @distributionId, @provenance, @osUserIdentity, @displayName, @configRoot,
        @executablePath, @appPath, @detectedVersion, @versionDetectionMethod,
        @agentId, @supportedCapability, @lastDetectedAt, @metadataJson, @createdAt, @updatedAt
      )
      ON CONFLICT(runtime_realm, install_key) DO UPDATE SET
        family = excluded.family,
        host_variant = excluded.host_variant,
        distribution_id = excluded.distribution_id,
        provenance = excluded.provenance,
        os_user_identity = COALESCE(excluded.os_user_identity, agent_installations.os_user_identity),
        display_name = excluded.display_name,
        config_root = excluded.config_root,
        executable_path = excluded.executable_path,
        app_path = excluded.app_path,
        detected_version = excluded.detected_version,
        version_detection_method = excluded.version_detection_method,
        agent_id = COALESCE(agent_installations.agent_id, excluded.agent_id),
        supported_capability = excluded.supported_capability,
        last_detected_at = excluded.last_detected_at,
        health_state = 'discovered',
        status_reason = CASE WHEN agent_installations.status_reason = 'host_uninstalled' THEN NULL ELSE agent_installations.status_reason END,
        reconcile_state = CASE
          WHEN agent_installations.status_reason = 'host_uninstalled' AND agent_installations.desired_state = 'disabled' THEN 'paused'
          WHEN agent_installations.status_reason = 'host_uninstalled' THEN 'idle'
          ELSE agent_installations.reconcile_state
        END,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
      `).run({
        id: input.id,
        family: input.family,
        hostVariant: input.hostVariant,
        runtimeRealm,
        profileId: input.profileId ?? 'default',
        installKey: input.installKey,
        distributionId: input.distributionId ?? null,
        provenance: input.provenance,
        osUserIdentity: input.osUserIdentity ?? null,
        displayName: input.displayName,
        configRoot: input.configRoot ?? null,
        executablePath: input.executablePath ?? null,
        appPath: input.appPath ?? null,
        detectedVersion: input.detectedVersion ?? null,
        versionDetectionMethod: input.versionDetectionMethod ?? null,
        agentId: input.agentId ?? null,
        supportedCapability: input.supportedCapability ?? 0,
        lastDetectedAt: now,
        metadataJson: json(metadata, {}),
        createdAt: now,
        updatedAt: now,
      })
      const persisted = this.getInstallationByInstallKey(runtimeRealm, input.installKey)!
      const detectedVersion = input.detectedVersion ?? null
      const installKeyChanged = previousById !== undefined
        && previousById.install_key !== input.installKey
      const projectionSurfaceChanged = priorInstallation !== undefined
        && persistedProjectionSurfaceFingerprint(priorInstallation)
          !== persistedProjectionSurfaceFingerprint(persisted)
      const installationSurfaceChanged = installKeyChanged || projectionSurfaceChanged
      const versionChanged = priorInstallation !== undefined
        && priorInstallation.detected_version !== null
        && priorInstallation.detected_version !== detectedVersion
      if ((versionChanged || installationSurfaceChanged) && persisted.desired_state !== 'removed') {
        const invalidationReason = installationSurfaceChanged
          ? 'host_installation_surface_changed'
          : 'host_version_changed'
        this.db.prepare(`
          UPDATE verification_results
          SET invalidated_at = COALESCE(invalidated_at, ?),
              invalidation_reason = COALESCE(invalidation_reason, ?)
          WHERE installation_id = ?
        `).run(now, invalidationReason, persisted.id)
        this.db.prepare(`
          UPDATE installation_components
          SET verification_status = 'stale', updated_at = ?
          WHERE installation_id = ? AND verification_status != 'unverified'
        `).run(now, persisted.id)
        this.db.prepare(`
          UPDATE agent_installations
          SET verified_capability = 0,
              verification_summary = CASE
                WHEN verification_summary = 'unverified' THEN 'unverified'
                ELSE 'stale'
              END,
              status_reason = CASE
                WHEN desired_state != 'removed'
                  AND reconcile_state IN ('idle','awaiting_consent')
                  AND (status_reason IS NULL OR status_reason IN ('verified','verification_stale'))
                  THEN 'verification_stale'
                ELSE status_reason
              END,
              updated_at = ?
          WHERE id = ?
        `).run(now, persisted.id)
        if (installationSurfaceChanged) {
          this.db.prepare(`
            UPDATE agent_consents
            SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
            WHERE installation_id = ? AND status = 'active'
          `).run(now, persisted.id)
          this.db.prepare(`
            UPDATE agent_installations
            SET consent_envelope_id = NULL,
                consented_at = NULL,
                reconcile_state = CASE
                  WHEN desired_state = 'managed'
                    AND reconcile_state IN ('idle','awaiting_consent','paused')
                    THEN 'awaiting_consent'
                  ELSE reconcile_state
                END,
                status_reason = CASE
                  WHEN desired_state = 'managed'
                    AND reconcile_state IN ('idle','awaiting_consent','paused')
                    THEN 'awaiting_consent'
                  ELSE status_reason
                END,
                updated_at = ?
            WHERE id = ?
          `).run(now, persisted.id)
        }
        const surfaceChangeInvalidatedUserState = priorInstallation !== undefined
          && (priorInstallation.desired_state !== 'unmanaged'
            || priorInstallation.consent_envelope_id !== null
            || priorInstallation.verified_capability > 0
            || priorInstallation.verification_summary !== 'unverified')
        if (!installationSurfaceChanged || surfaceChangeInvalidatedUserState) {
          this.recordEvent({
            installationId: persisted.id,
            kind: installationSurfaceChanged ? 'host_installation_surface_changed' : 'host_version_changed',
            severity: 'info',
            dedupeKey: installationSurfaceChanged
              ? `${persisted.id}:installation-surface:${persistedProjectionSurfaceFingerprint(persisted)}`
              : `${persisted.id}:host-version:${input.detectedVersion}`,
            payload: {
              previousVersion: priorInstallation?.detected_version ?? null,
              detectedVersion: input.detectedVersion,
              installKeyChanged,
              projectionSurfaceChanged,
            },
            createdAt: now,
          })
        }
      }
      return this.getInstallationByInstallKey(runtimeRealm, input.installKey)!
    }).immediate()
  }

  /**
   * Re-evaluates persisted green evidence against deterministic production facts.
   * Host read-back remains the Adapter's responsibility; this closes version,
   * runtime, generation and expiry drift before renderer state is derived.
   */
  refreshVerificationFreshness(input: VerificationFreshnessInput): number {
    type FreshnessRow = {
      id: string
      installation_id: string
      component_key: string
      family: string
      host_variant: string
      distribution_id: string | null
      runtime_realm: string
      host_version: string | null
      os_version: string | null
      tide_mind_version: string | null
      adapter_version: string
      catalog_version: string
      projection_version: string | null
      selector_schema_version: string | null
      verification_manifest_version: string
      identity_assertion: string | null
      artifact_hash: string | null
      reload_generation: string | null
      invalidation_keys_json: string
      expires_at: string | null
      current_family: string
      current_host_variant: string
      current_distribution_id: string | null
      current_runtime_realm: string
      current_host_version: string | null
      current_agent_id: string | null
      current_artifact_hash: string | null
      current_artifact_state: string | null
      current_selector_schema_version: string | null
    }
    const candidateQuery = this.db.prepare(`
      SELECT v.id, v.installation_id, v.component_key, v.family, v.host_variant,
             v.distribution_id, v.runtime_realm, v.host_version, v.os_version,
             v.tide_mind_version,
             v.adapter_version, v.catalog_version, v.projection_version,
             v.selector_schema_version, v.verification_manifest_version, v.expires_at,
             v.identity_assertion, v.artifact_hash, v.reload_generation, v.invalidation_keys_json,
             i.family AS current_family,
             i.host_variant AS current_host_variant,
             i.distribution_id AS current_distribution_id,
             i.runtime_realm AS current_runtime_realm,
             i.detected_version AS current_host_version,
             i.agent_id AS current_agent_id,
             a.observed_fragment_hash AS current_artifact_hash,
             a.state AS current_artifact_state,
             a.selector_schema_version AS current_selector_schema_version
      FROM verification_results v
      JOIN agent_installations i ON i.id = v.installation_id
      JOIN installation_components c
        ON c.installation_id = v.installation_id
       AND c.component_key = v.component_key
       AND c.verification_result_id = v.id
      LEFT JOIN managed_artifacts a ON a.id = c.artifact_id
      WHERE v.result = 'verified' AND v.invalidated_at IS NULL
        AND i.desired_state IN ('managed','disabled')
        AND c.desired_state IN ('managed','disabled')
    `)

    return this.db.transaction(() => {
      const candidates = candidateQuery.all() as FreshnessRow[]
      const affected = new Set<string>()
      let invalidated = 0
      for (const row of candidates) {
        const expectedAdapterVersion = input.adapterVersion(row.current_host_variant)
        const invalidationKeys = new Set(parseStringArray(row.invalidation_keys_json))
        const currentReloadGeneration = invalidationKeys.has('reload_generation')
          ? input.reloadGeneration?.(row.installation_id, row.component_key)
          : undefined
        let reason: string | null = null
        if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.parse(input.now)) {
          reason = 'verification_expired'
        } else if (row.family !== row.current_family
          || row.host_variant !== row.current_host_variant
          || row.distribution_id !== row.current_distribution_id
          || row.runtime_realm !== row.current_runtime_realm) {
          reason = 'installation_identity_changed'
        } else if (row.host_version !== row.current_host_version) {
          reason = 'host_version_changed'
        } else if (row.identity_assertion === null || row.identity_assertion !== row.current_agent_id) {
          reason = 'agent_identity_changed'
        } else if (row.os_version !== null && row.os_version !== input.osVersion) {
          reason = 'os_version_changed'
        } else if (invalidationKeys.has('tide_mind_version')
          && (!input.tideMindVersion || row.tide_mind_version !== input.tideMindVersion)) {
          reason = 'tide_mind_version_changed'
        } else if (expectedAdapterVersion === undefined || row.adapter_version !== expectedAdapterVersion) {
          reason = 'adapter_version_changed'
        } else if (row.catalog_version !== input.catalogVersion) {
          reason = 'catalog_version_changed'
        } else if (row.projection_version !== input.projectionVersion) {
          reason = 'projection_version_changed'
        } else if (row.current_selector_schema_version !== null
          && row.selector_schema_version !== row.current_selector_schema_version) {
          reason = 'selector_schema_changed'
        } else if (invalidationKeys.has('artifact_hash')
          && (row.current_artifact_state !== 'healthy'
            || row.artifact_hash !== row.current_artifact_hash)) {
          reason = 'artifact_hash_changed'
        } else if (invalidationKeys.has('reload_generation')
          && (row.reload_generation === null
            || currentReloadGeneration === undefined
            || row.reload_generation !== currentReloadGeneration)) {
          reason = 'reload_generation_changed'
        } else if (row.verification_manifest_version !== '1') {
          reason = 'verification_manifest_changed'
        }
        if (!reason) continue
        const result = this.db.prepare(`
          UPDATE verification_results
          SET invalidated_at = ?, invalidation_reason = ?
          WHERE id = ? AND invalidated_at IS NULL
        `).run(input.now, reason, row.id)
        if (result.changes !== 1) continue
        invalidated += 1
        affected.add(row.installation_id)
        this.db.prepare(`
          UPDATE installation_components
          SET verification_status = 'stale', updated_at = ?
          WHERE installation_id = ? AND component_key = ? AND verification_result_id = ?
        `).run(input.now, row.installation_id, row.component_key, row.id)
      }
      for (const installationId of affected) {
        this.refreshInstallationVerificationSummary(installationId, input.now)
        this.recordEvent({
          installationId,
          kind: 'verification_evidence_stale',
          severity: 'info',
          dedupeKey: `${installationId}:freshness:${input.now}`,
          payload: {},
          createdAt: input.now,
        })
      }
      return invalidated
    }).immediate()
  }

  private refreshInstallationVerificationSummary(installationId: string, updatedAt: string): void {
    const rows = this.db.prepare(`
      SELECT component_key, verification_status
      FROM installation_components
      WHERE installation_id = ? AND desired_state = 'managed'
    `).all(installationId) as Array<{ component_key: string; verification_status: string }>
    const statuses = new Set(rows.map(row => row.verification_status))
    const verified = new Set(rows
      .filter(row => row.verification_status === 'verified')
      .map(row => row.component_key))
    const capability = verified.has('instruction') && verified.has('memory_tools') && verified.has('lifecycle')
      ? 4
      : verified.has('instruction') && verified.has('memory_tools')
        ? 3
        : verified.has('memory_tools')
          ? 2
          : verified.has('instruction')
            ? 1
            : 0
    const summary = rows.length === 0
      ? 'unverified'
      : statuses.size === 1
        ? [...statuses][0]
        : 'mixed'
    this.db.prepare(`
      UPDATE agent_installations
      SET verified_capability = ?, verification_summary = ?,
          status_reason = CASE
            WHEN desired_state = 'managed'
              AND reconcile_state = 'idle'
              AND (status_reason IS NULL OR status_reason IN ('verified','verification_stale'))
              THEN 'verification_stale'
            ELSE status_reason
          END,
          updated_at = ?
      WHERE id = ?
    `).run(capability, summary, updatedAt, installationId)
  }

  getInstallation(id: string): AgentInstallationRow | undefined {
    return this.db.prepare('SELECT * FROM agent_installations WHERE id = ?')
      .get(id) as AgentInstallationRow | undefined
  }

  getInstallationByInstallKey(runtimeRealm: string, installKey: string): AgentInstallationRow | undefined {
    return this.db.prepare(`
      SELECT * FROM agent_installations WHERE runtime_realm = ? AND install_key = ?
    `).get(runtimeRealm, installKey) as AgentInstallationRow | undefined
  }

  listInstallations(options: { includeRemoved?: boolean } = {}): AgentInstallationRow[] {
    return this.db.prepare(`
      SELECT * FROM agent_installations
      WHERE @includeRemoved = 1 OR desired_state != 'removed'
      ORDER BY family, host_variant, profile_id, created_at
    `).all({ includeRemoved: options.includeRemoved ? 1 : 0 }) as AgentInstallationRow[]
  }

  getLastSuccessfulScanAt(): string | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(AGENT_INTEGRATION_LAST_SUCCESSFUL_SCAN_AT_KEY) as { value: string } | undefined
    return row?.value ?? null
  }

  setLastSuccessfulScanAt(scannedAt: string): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE metadata.value < excluded.value
    `).run(AGENT_INTEGRATION_LAST_SUCCESSFUL_SCAN_AT_KEY, scannedAt)
  }

  listInstallationIdentityRecords(): InstallationIdentityRecord[] {
    return this.listInstallations({ includeRemoved: true }).flatMap(row => {
      if (!row.config_root || !row.os_user_identity) return []
      const metadata = safeJsonObject(row.metadata_json)
      return [{
        installationId: row.id,
        runtimeRealm: row.runtime_realm as RuntimeRealm,
        osUserIdentity: row.os_user_identity,
        productFamilyId: row.family as ProductFamilyId,
        hostVariant: row.host_variant as CatalogId,
        canonicalConfigRoot: row.config_root,
        componentConfigFiles: persistedComponentConfigFiles(row),
        explicitProfile: row.profile_id || 'default',
        hostOwnedIdentity: stringOrUndefined(metadata.hostOwnedIdentity),
        distribution: persistedDistribution(row),
        installKey: row.install_key,
        aliasInstallKeys: Array.isArray(metadata.installKeyAliases)
          ? metadata.installKeyAliases.filter((value): value is string => typeof value === 'string')
          : [],
      }]
    })
  }

  markInstallationIdentityConflict(installationId: string, detectedAt: string, reason: string): void {
    this.db.transaction(() => {
      const installation = this.getInstallation(installationId)
      if (!installation) return
      this.db.prepare(`
        UPDATE verification_results
        SET invalidated_at = COALESCE(invalidated_at, ?),
            invalidation_reason = COALESCE(invalidation_reason, 'distribution_identity_conflict')
        WHERE installation_id = ?
      `).run(detectedAt, installationId)
      this.db.prepare(`
        UPDATE installation_components
        SET verification_status = 'stale', updated_at = ?
        WHERE installation_id = ? AND verification_status != 'unverified'
      `).run(detectedAt, installationId)
      this.db.prepare(`
        UPDATE agent_installations
        SET verified_capability = 0, verification_summary = 'stale',
            reconcile_state = 'paused', health_state = 'inaccessible',
            status_reason = 'conflict', updated_at = ?
        WHERE id = ?
      `).run(detectedAt, installationId)
      this.recordEvent({
        installationId,
        kind: 'discovery_identity_conflict',
        severity: 'warning',
        dedupeKey: `${installationId}:distribution_identity_conflict`,
        payload: { reason },
        createdAt: detectedAt,
      })
    }).immediate()
  }

  /**
   * A probe error is neither an authoritative absence nor fresh presence.
   * Invalidate live capability and prevent startup recovery from trusting the
   * previous process' discovered bit without incrementing uninstall misses.
   */
  markInstallationProbeUncertain(
    installationId: string,
    scannedAt: string,
    reasons: readonly string[],
  ): void {
    this.db.transaction(() => {
      const installation = this.getInstallation(installationId)
      if (!installation || installation.desired_state === 'removed') return
      this.db.prepare(`
        UPDATE verification_results
        SET invalidated_at = COALESCE(invalidated_at, ?),
            invalidation_reason = COALESCE(invalidation_reason, 'host_probe_uncertain')
        WHERE installation_id = ?
      `).run(scannedAt, installationId)
      this.db.prepare(`
        UPDATE installation_components
        SET verification_status = 'stale', updated_at = ?
        WHERE installation_id = ? AND verification_status != 'unverified'
      `).run(scannedAt, installationId)
      this.db.prepare(`
        UPDATE agent_installations
        SET verified_capability = 0,
            verification_summary = CASE WHEN verification_summary = 'unverified' THEN 'unverified' ELSE 'stale' END,
            reconcile_state = CASE WHEN desired_state IN ('managed','disabled') THEN 'paused' ELSE reconcile_state END,
            health_state = 'inaccessible',
            status_reason = CASE
              WHEN status_reason IN ('conflict','circuit_breaker','user_disabled') THEN status_reason
              ELSE 'verification_stale'
            END,
            updated_at = ?
        WHERE id = ?
      `).run(scannedAt, installationId)
      this.recordEvent({
        installationId,
        kind: 'host_probe_uncertain',
        severity: 'warning',
        dedupeKey: `${installationId}:host-probe-uncertain:${[...new Set(reasons)].sort().join(',')}`,
        payload: { reasons: [...new Set(reasons)].sort() },
        createdAt: scannedAt,
      })
    }).immediate()
  }

  markInstallationNotDetected(installationId: string, scannedAt: string): void {
    this.db.transaction(() => {
      const installation = this.getInstallation(installationId)
      if (!installation) return
      const metadata = safeJsonObject(installation.metadata_json)
      const previousMisses = typeof metadata.consecutiveDetectionMisses === 'number'
        ? metadata.consecutiveDetectionMisses
        : 0
      const consecutiveDetectionMisses = previousMisses + 1
      const confirmedUninstalled = consecutiveDetectionMisses >= 2
      this.db.prepare(`
        UPDATE verification_results
        SET invalidated_at = COALESCE(invalidated_at, ?),
            invalidation_reason = COALESCE(invalidation_reason, ?)
        WHERE installation_id = ?
      `).run(scannedAt, confirmedUninstalled ? 'host_uninstalled' : 'host_detection_missing', installationId)
      this.db.prepare(`
        UPDATE installation_components SET verification_status = 'stale', updated_at = ?
        WHERE installation_id = ? AND verification_status != 'unverified'
      `).run(scannedAt, installationId)
      this.db.prepare(`
        UPDATE agent_installations
        SET verified_capability = 0,
            verification_summary = CASE WHEN verification_summary = 'unverified' THEN 'unverified' ELSE 'stale' END,
            reconcile_state = CASE WHEN desired_state IN ('managed','disabled') THEN 'paused' ELSE reconcile_state END,
            health_state = ?, status_reason = CASE
              WHEN ? = 1 THEN 'host_uninstalled'
              WHEN desired_state = 'removed' THEN status_reason
              ELSE 'verification_stale'
            END,
            metadata_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        confirmedUninstalled ? 'absent' : 'inaccessible',
        confirmedUninstalled ? 1 : 0,
        JSON.stringify({ ...metadata, consecutiveDetectionMisses }),
        scannedAt,
        installationId,
      )
      this.recordEvent({
        installationId,
        kind: confirmedUninstalled ? 'host_uninstalled' : 'host_detection_uncertain',
        severity: confirmedUninstalled ? 'warning' : 'info',
        dedupeKey: `${installationId}:detection-miss:${consecutiveDetectionMisses}`,
        payload: { consecutiveDetectionMisses },
        createdAt: scannedAt,
      })
    }).immediate()
  }

  /** Explicit user reconnect only; discovery never calls this method. */
  reopenInstallation(installationId: string, reopenedAt: string): void {
    this.db.transaction(() => {
      const installation = this.getInstallation(installationId)
      if (!installation || installation.desired_state !== 'removed' || !installation.tombstoned_at) {
        throw new Error(`only a disconnected Installation can be reopened: ${installationId}`)
      }
      this.db.prepare(`
        UPDATE agent_consents SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
        WHERE installation_id = ? AND status = 'active'
      `).run(reopenedAt, installationId)
      this.db.prepare(`
        UPDATE verification_results
        SET invalidated_at = COALESCE(invalidated_at, ?),
            invalidation_reason = COALESCE(invalidation_reason, 'explicit_reconnect')
        WHERE installation_id = ?
      `).run(reopenedAt, installationId)
      this.db.prepare(`DELETE FROM artifact_consumers WHERE installation_id = ? AND state = 'removed'`)
        .run(installationId)
      this.db.prepare(`DELETE FROM installation_components WHERE installation_id = ? AND desired_state = 'removed'`)
        .run(installationId)
      this.db.prepare(`
        UPDATE agent_installations
        SET desired_state = 'unmanaged', tombstoned_at = NULL, tombstone_reason = NULL,
            consent_envelope_id = NULL, consented_at = NULL,
            desired_capability = 0, verified_capability = 0,
            verification_summary = 'unverified', reconcile_state = 'idle',
            status_reason = NULL, verification_result_id = NULL, updated_at = ?
        WHERE id = ?
      `).run(reopenedAt, installationId)
      this.recordEvent({
        installationId,
        kind: 'installation_explicitly_reopened',
        severity: 'info',
        dedupeKey: `${installationId}:reopened:${reopenedAt}`,
        payload: {},
        createdAt: reopenedAt,
      })
    }).immediate()
  }

  getInstallationByAgentIdOrAlias(agentId: string): AgentInstallationRow | undefined {
    const direct = this.db.prepare('SELECT * FROM agent_installations WHERE agent_id = ?')
      .get(agentId) as AgentInstallationRow | undefined
    if (direct) return direct
    return this.db.prepare(`
      SELECT i.*
      FROM agent_aliases a
      JOIN agent_installations i ON i.id = a.installation_id
      WHERE a.alias_value = ? AND a.alias_type IN ('legacy_agent_id','agent_id')
      ORDER BY a.created_at DESC
      LIMIT 1
    `).get(agentId) as AgentInstallationRow | undefined
  }

  getInstallationByLegacyAgentAlias(legacyAgentId: string, runtimeRealm: string): AgentInstallationRow | undefined {
    return this.db.prepare(`
      SELECT i.*
      FROM agent_aliases a
      JOIN agent_installations i ON i.id = a.installation_id
      WHERE a.alias_value = ? AND a.alias_type = 'legacy_agent_id' AND a.runtime_realm = ?
      LIMIT 1
    `).get(legacyAgentId, runtimeRealm) as AgentInstallationRow | undefined
  }

  markLegacyConfirmationRequired(installationId: string, updatedAt: string): void {
    this.db.prepare(`
      UPDATE agent_installations
      SET reconcile_state = 'paused', status_reason = 'legacy_confirmation_required', updated_at = ?
      WHERE id = ? AND desired_state = 'unmanaged' AND tombstoned_at IS NULL
        AND health_state = 'discovered' AND (status_reason IS NULL OR status_reason != 'conflict')
    `).run(updatedAt, installationId)
  }

  isAgentIdentitySuppressed(agentId: string): boolean {
    const installation = this.getInstallationByAgentIdOrAlias(agentId)
    return installation !== undefined
      && (installation.desired_state === 'removed' || installation.tombstoned_at !== null)
  }

  setInstallationIntent(
    installationId: string,
    desiredState: InstallationDesiredState,
    updatedAt: string,
    tombstoneReason?: string,
  ): void {
    const existing = this.getInstallation(installationId)
    if (!existing) throw new Error(`unknown installation: ${installationId}`)
    if ((existing.desired_state === 'removed' || existing.tombstoned_at) && desiredState !== 'removed') {
      throw new Error(`tombstoned installation cannot be reactivated: ${installationId}`)
    }
    if (desiredState === 'removed' && !tombstoneReason) {
      throw new Error('removing an installation requires a tombstone reason')
    }
    this.db.prepare(`
      UPDATE agent_installations
      SET desired_state = ?,
          reconcile_state = CASE
            WHEN ? = 'disabled' THEN 'paused'
            WHEN ? = 'managed' THEN 'idle'
            ELSE reconcile_state
          END,
          status_reason = CASE
            WHEN ? = 'disabled' THEN 'user_disabled'
            WHEN ? = 'managed' THEN 'verification_stale'
            ELSE status_reason
          END,
          tombstoned_at = CASE WHEN ? = 'removed' THEN COALESCE(tombstoned_at, ?) ELSE tombstoned_at END,
          tombstone_reason = CASE WHEN ? = 'removed' THEN ? ELSE tombstone_reason END,
          updated_at = ?
      WHERE id = ?
    `).run(
      desiredState,
      desiredState,
      desiredState,
      desiredState,
      desiredState,
      desiredState,
      updatedAt,
      desiredState,
      tombstoneReason ?? null,
      updatedAt,
      installationId,
    )
  }

  upsertComponent(input: InstallationComponentInput, updatedAt: string): void {
    assertCapability(input.desiredCapability)
    const existing = this.db.prepare(`
      SELECT desired_state, tombstoned_at
      FROM installation_components
      WHERE installation_id = ? AND component_key = ?
    `).get(input.installationId, input.componentKey) as
      | { desired_state: InstallationDesiredState; tombstoned_at: string | null }
      | undefined
    if (existing && (existing.desired_state === 'removed' || existing.tombstoned_at)
      && input.desiredState !== 'removed') {
      throw new Error(`tombstoned component cannot be reactivated: ${input.componentKey}`)
    }
    this.db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, desired_capability, delivery_mode,
        verification_status, verification_result_id, artifact_id, visibility_state,
        consent_envelope_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id, component_key) DO UPDATE SET
        desired_state = excluded.desired_state,
        desired_capability = excluded.desired_capability,
        delivery_mode = excluded.delivery_mode,
        verification_status = excluded.verification_status,
        verification_result_id = excluded.verification_result_id,
        artifact_id = excluded.artifact_id,
        visibility_state = excluded.visibility_state,
        consent_envelope_id = excluded.consent_envelope_id,
        updated_at = excluded.updated_at
    `).run(
      input.installationId,
      input.componentKey,
      input.desiredState,
      input.desiredCapability,
      input.deliveryMode,
      input.verificationStatus ?? 'unverified',
      input.verificationResultId ?? null,
      input.artifactId ?? null,
      input.visibilityState ?? 'unknown',
      input.consentEnvelopeId ?? null,
      updatedAt,
      updatedAt,
    )
  }

  listComponents(installationId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT * FROM installation_components
      WHERE installation_id = ? ORDER BY component_key
    `).all(installationId) as Array<Record<string, unknown>>
  }

  listInstallationComponentDetails(installationId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT c.*, a.component_type, a.target_path, a.ownership_key,
             a.projection_version, a.selector_schema_version, a.state AS artifact_state,
             a.owned_fragment_hash, a.observed_fragment_hash,
             a.last_applied_at, a.last_verified_at AS artifact_last_verified_at
      FROM installation_components c
      LEFT JOIN managed_artifacts a ON a.id = c.artifact_id
      WHERE c.installation_id = ?
      ORDER BY c.component_key
    `).all(installationId) as Array<Record<string, unknown>>
  }

  /**
   * Returns runtime use only when the evidence still backs the component's
   * current, non-invalidated verification result for the exact Installation
   * identity and version generations. Legacy `agents.last_active` is
   * deliberately not consulted here.
   */
  latestVerifiedHostActivityAt(installationId: string, now: string): string | null {
    const row = this.db.prepare(`
      SELECT MAX(evidence.observed_at) AS observed_at
      FROM agent_host_activity_evidence evidence
      JOIN agent_installations installation
        ON installation.id = evidence.installation_id
       AND installation.agent_id = evidence.agent_id
       AND installation.host_variant = evidence.host_variant
       AND installation.detected_version = evidence.host_version
      JOIN installation_components component
        ON component.installation_id = installation.id
       AND component.component_key = evidence.component_key
      JOIN verification_results verification
        ON verification.id = component.verification_result_id
       AND verification.installation_id = installation.id
       AND verification.component_key = component.component_key
       AND verification.host_variant = installation.host_variant
       AND verification.host_version = installation.detected_version
       AND verification.identity_assertion = installation.agent_id
       AND verification.tide_mind_version = evidence.tide_mind_version
       AND verification.adapter_version = evidence.adapter_version
       AND verification.projection_version = evidence.projection_version
      JOIN artifact_consumers consumer
        ON consumer.installation_id = component.installation_id
       AND consumer.component_key = component.component_key
       AND consumer.artifact_id = component.artifact_id
      WHERE installation.id = ?
        AND installation.desired_state = 'managed'
        AND installation.tombstoned_at IS NULL
        AND installation.health_state = 'discovered'
        AND component.desired_state = 'managed'
        AND component.verification_status = 'verified'
        AND consumer.state = 'active'
        AND consumer.desired_state = 'managed'
        AND verification.result = 'verified'
        AND verification.invalidated_at IS NULL
        AND verification.evidence_ref LIKE 'host-activity:%'
        AND (',' || substr(verification.evidence_ref, length('host-activity:') + 1) || ',')
          LIKE ('%,' || evidence.id || ',%')
        AND verification.evidence_hash != ''
        AND evidence.evidence_hash != ''
        AND evidence.observed_at <= verification.verified_at
        AND verification.expires_at IS NOT NULL
        AND julianday(verification.expires_at) > julianday(?)
    `).get(installationId, now) as { observed_at: string | null } | undefined
    return row?.observed_at ?? null
  }

  getLatestRunTechnical(installationId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`
      SELECT execution_plan_hash, state, adapter_version, catalog_version,
             projection_version, selector_schema_version
      FROM reconcile_runs
      WHERE installation_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(installationId) as Record<string, unknown> | undefined
  }

  /**
   * Read-only renderer recovery surface for connect tasks. The coordinator run
   * remains authoritative; no UI task state is written back into the ledger.
   */
  listRecentApplyTaskRuns(limit = 100): ApplyTaskRunRow[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 500))
    const columns = `
      SELECT id, installation_id, execution_plan_hash, state, failure_code,
             created_at, started_at, completed_at, updated_at
      FROM reconcile_runs
      WHERE operation_type = 'connect' AND installation_id IS NOT NULL
    `
    const attention = this.db.prepare(`${columns}
        AND state IN (
          'planned','preconditions_checked','applying','applied_unverified',
          'verified','compensating','needs_recovery','failed','cancelled'
        )
      ORDER BY created_at DESC, id DESC
    `).all() as ApplyTaskRunRow[]
    const recent = this.db.prepare(`${columns}
        AND state = 'committed'
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(bounded) as ApplyTaskRunRow[]
    return [...attention, ...recent]
  }

  /**
   * Resolves pre-run-id v34 task ownership from the complete SQLite candidate
   * graph. This query is intentionally independent from renderer history
   * limits: pagination is presentation policy and cannot establish ownership.
   */
  resolveLegacyNullApplyTaskRuns(): LegacyNullApplyTaskRunResolution {
    const eligibleLegacyItemsSql = `
      FROM agent_integration_apply_task_items item
      JOIN agent_integration_apply_tasks task ON task.id = item.task_id
      WHERE task.operation_type = 'connect'
        AND item.run_id IS NULL
        AND json_valid(item.result_json) = 1
        AND COALESCE(json_type(item.result_json, '$'), '') = 'object'
        AND (
          (
            item.state = 'interrupted'
            AND json_extract(item.result_json, '$.status') = 'interrupted'
            AND (
              COALESCE(json_type(item.result_json, '$.installationId'), 'null') = 'null'
              OR (
                json_type(item.result_json, '$.installationId') = 'text'
                AND json_extract(item.result_json, '$.installationId') = item.installation_id
              )
            )
            AND (
              COALESCE(json_type(item.result_json, '$.runId'), 'null') = 'null'
              OR json_type(item.result_json, '$.runId') = 'text'
            )
          )
          OR (
            item.state = 'terminal'
            AND json_extract(item.result_json, '$.status') = 'committed'
            AND json_type(item.result_json, '$.installationId') = 'text'
            AND json_extract(item.result_json, '$.installationId') = item.installation_id
            AND json_type(item.result_json, '$.runId') = 'text'
          )
        )
    `
    const items = this.db.prepare(`
      SELECT item.task_id, item.installation_id, item.execution_plan_hash,
             task.operation_type,
             CASE WHEN json_type(item.result_json, '$.runId') = 'text'
               THEN json_extract(item.result_json, '$.runId') ELSE NULL END AS payload_run_id
      ${eligibleLegacyItemsSql}
      ORDER BY item.task_id, item.installation_id
    `).all() as Array<{
      task_id: string
      installation_id: string
      execution_plan_hash: string
      operation_type: string
      payload_run_id: string | null
    }>
    const runs = this.db.prepare(`
      WITH legacy_groups AS (
        SELECT DISTINCT item.installation_id, item.execution_plan_hash, task.operation_type
        ${eligibleLegacyItemsSql}
      )
      SELECT run.id, run.installation_id, run.execution_plan_hash,
             run.state, run.failure_code, run.created_at, run.started_at,
             run.completed_at, run.updated_at
      FROM reconcile_runs run
      JOIN legacy_groups legacy
        ON legacy.installation_id = run.installation_id
       AND legacy.execution_plan_hash = run.execution_plan_hash
       AND legacy.operation_type = run.operation_type
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_integration_apply_task_items exact_owner
        WHERE exact_owner.run_id = run.id
      )
      ORDER BY run.created_at DESC, run.id DESC
    `).all() as Array<{
      id: string
      installation_id: string
      execution_plan_hash: string
      state: string
      failure_code: string | null
      created_at: string
      started_at: string | null
      completed_at: string | null
      updated_at: string
    }>
    const groupKey = (installationId: string, executionPlanHash: string, operationType: string) => (
      `${installationId}\0${executionPlanHash}\0${operationType}`
    )
    const runsByGroup = new Map<string, ApplyTaskRunRow[]>()
    const runGroup = new Map<string, string>()
    const runById = new Map<string, ApplyTaskRunRow>()
    for (const run of runs) {
      const key = groupKey(run.installation_id, run.execution_plan_hash, 'connect')
      const row: ApplyTaskRunRow = run
      const groupRuns = runsByGroup.get(key)
      if (groupRuns) groupRuns.push(row)
      else runsByGroup.set(key, [row])
      runGroup.set(run.id, key)
      runById.set(run.id, row)
    }
    const wildcardItemsByGroup = new Map<string, number>()
    const explicitItemsByRun = new Map<string, number>()
    for (const item of items) {
      const key = groupKey(item.installation_id, item.execution_plan_hash, item.operation_type)
      if (item.payload_run_id === null) {
        wildcardItemsByGroup.set(key, (wildcardItemsByGroup.get(key) ?? 0) + 1)
      } else if (runGroup.get(item.payload_run_id) === key) {
        explicitItemsByRun.set(item.payload_run_id, (explicitItemsByRun.get(item.payload_run_id) ?? 0) + 1)
      }
    }
    const runDegree = (run: ApplyTaskRunRow): number => (
      (wildcardItemsByGroup.get(runGroup.get(run.id)!) ?? 0)
      + (explicitItemsByRun.get(run.id) ?? 0)
    )
    const candidateRuns = runs.filter(run => runDegree(run) > 0)
    const bindings = items.flatMap(item => {
      const key = groupKey(item.installation_id, item.execution_plan_hash, item.operation_type)
      const groupRuns = runsByGroup.get(key) ?? []
      const candidate = item.payload_run_id === null
        ? (groupRuns.length === 1 ? groupRuns[0] : undefined)
        : (runGroup.get(item.payload_run_id) === key ? runById.get(item.payload_run_id) : undefined)
      return candidate && runDegree(candidate) === 1
        ? [{
            taskId: item.task_id,
            installationId: item.installation_id,
            run: candidate,
          }]
        : []
    })
    const boundRunIds = new Set(bindings.map(binding => binding.run.id))
    return {
      bindings,
      candidateRuns,
      ambiguousRuns: candidateRuns.filter(run => !boundRunIds.has(run.id)),
    }
  }

  /**
   * Bounded renderer feed. Authority and ordering are computed from one SQLite
   * read snapshot; only the selected page is hydrated into task/run rows.
   */
  listApplyTaskFeedPage(input: ApplyTaskFeedCursorInput): ApplyTaskFeedPageRow {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit), 50))
    return this.db.transaction(() => {
      const revisionRow = this.db.prepare(`
        SELECT CAST(revision AS TEXT) AS revision
        FROM agent_integration_apply_task_feed_state WHERE singleton = 1
      `).get() as { revision: string } | undefined
      if (!revisionRow) throw new Error('agent task feed revision is unavailable')
      const revision = String(revisionRow.revision)
      const cursor = input.cursor ? decodeApplyTaskFeedCursor(input.cursor) : null
      if (cursor && cursor.revision !== revision) throw new Error('stale_task_feed_cursor')
      const snapshotAtMs = cursor?.snapshotAtMs ?? input.nowMs

      let traversal = this.applyTaskFeedTraversalCache
      if (!traversal || traversal.revision !== revision || traversal.snapshotAtMs !== snapshotAtMs) {

        const taskHeaders = this.db.prepare(`
        SELECT id, state, started_at FROM agent_integration_apply_tasks
        WHERE operation_type = 'connect'
      `).all() as Array<{ id: string; state: DurableApplyTaskRow['state']; started_at: string }>
        const itemFacts = this.db.prepare(`
        SELECT item.task_id, item.installation_id, item.state, item.run_id,
               CASE WHEN json_valid(item.result_json) = 1
                 AND COALESCE(json_type(item.result_json, '$'), '') = 'object'
                 THEN json_extract(item.result_json, '$.status') ELSE NULL END AS payload_status,
               CASE WHEN json_valid(item.result_json) = 1
                 AND json_type(item.result_json, '$.installationId') = 'text'
                 THEN json_extract(item.result_json, '$.installationId') ELSE NULL END AS payload_installation_id,
               CASE WHEN json_valid(item.result_json) = 1
                 AND json_type(item.result_json, '$.runId') = 'text'
                 THEN json_extract(item.result_json, '$.runId') ELSE NULL END AS payload_run_id,
               CASE WHEN run.id IS NOT NULL
                 AND run.installation_id = item.installation_id
                 AND run.execution_plan_hash = item.execution_plan_hash
                 AND run.operation_type = task.operation_type THEN 1 ELSE 0 END AS exact_run_correlation,
               run.state AS run_state
        FROM agent_integration_apply_task_items item
        JOIN agent_integration_apply_tasks task ON task.id = item.task_id
        LEFT JOIN reconcile_runs run ON run.id = item.run_id
        WHERE task.operation_type = 'connect'
        ORDER BY item.task_id, item.ordinal
      `).all() as ApplyTaskFeedItemFact[]
        const exactOwnerRunIds = new Set(itemFacts.flatMap(item => item.run_id ? [item.run_id] : []))
        const factsByTask = new Map<string, ApplyTaskFeedItemFact[]>()
        for (const item of itemFacts) {
          const existing = factsByTask.get(item.task_id)
          if (existing) existing.push(item)
          else factsByTask.set(item.task_id, [item])
        }

        // This resolver is O(items+runs) and executes inside the same read
        // transaction. It excludes every hidden non-null FK owner before degree
        // calculation; pagination must never weaken that global authority rule.
        // The already-parsed facts can prove that no row is even a possible
        // legacy candidate, avoiding a second full JSON scan for ordinary
        // terminal failures. The predicate is deliberately conservative: any
        // interrupted/committed null-run row still goes through the exact SQL.
        const couldContainLegacyCandidate = itemFacts.some(item => (
          item.run_id === null
          && ((item.state === 'interrupted' && item.payload_status === 'interrupted')
            || (item.state === 'terminal' && item.payload_status === 'committed'))
        ))
        const legacy: LegacyNullApplyTaskRunResolution = couldContainLegacyCandidate
          ? this.resolveLegacyNullApplyTaskRuns()
          : { bindings: [], candidateRuns: [], ambiguousRuns: [] }
        const overlayByItem = new Map(legacy.bindings.map(binding => [
          `${binding.taskId}\0${binding.installationId}`,
          binding.run,
        ]))
        const overlaysByTask = new Map<string, ApplyTaskRunRow[]>()
        for (const binding of legacy.bindings) {
          const existing = overlaysByTask.get(binding.taskId)
          if (existing) existing.push(binding.run)
          else overlaysByTask.set(binding.taskId, [binding.run])
        }
        const boundRunIds = new Set(legacy.bindings.map(binding => binding.run.id))
        const ambiguousRunIds = new Set(legacy.ambiguousRuns.map(run => run.id))
        const legacyCandidateRunIds = new Set(legacy.candidateRuns.map(run => run.id))

        const refs: ApplyTaskFeedRef[] = taskHeaders.map(task => {
          const facts = factsByTask.get(task.id) ?? []
          const priority = task.state === 'running' ? 0 : facts.length === 0 ? 1 : Math.min(...facts.map(fact => {
            const overlay = overlayByItem.get(`${task.id}\0${fact.installation_id}`)
            return applyTaskFeedItemPriority(fact, overlay ?? null)
          }))
          const overlays = overlaysByTask.get(task.id) ?? []
          return {
            key: `task:${task.id}` as const,
            source: 'task' as const,
            stableId: task.id,
            priority,
            startedAt: task.started_at,
            overlayRunIds: overlays.map(run => run.id),
            ambiguousLegacy: false,
          }
        })

        const runsById = new Map(
          this.listRecentApplyTaskRuns(500).map(run => [run.id, run]),
        )
        for (const run of legacy.candidateRuns) runsById.set(run.id, run)
        for (const run of runsById.values()) {
          if (exactOwnerRunIds.has(run.id) || boundRunIds.has(run.id)) continue
          const legacyCandidate = legacyCandidateRunIds.has(run.id)
          if (!legacyCandidate && !applyTaskFeedRunNeedsPresentation(run, snapshotAtMs)) continue
          const ambiguousLegacy = ambiguousRunIds.has(run.id)
          refs.push({
            key: `run:${run.id}`,
            source: 'run',
            stableId: run.id,
            priority: ambiguousLegacy ? 1 : applyTaskFeedRunPriority(run),
            startedAt: run.started_at ?? run.created_at,
            overlayRunIds: [],
            ambiguousLegacy,
          })
        }
        refs.sort(compareApplyTaskFeedRefs)

        traversal = {
          revision,
          snapshotAtMs,
          refs,
          runsById,
          attentionCount: refs.filter(ref => ref.priority === 1).length,
          activeCount: refs.filter(ref => ref.priority === 0 || ref.priority === 2).length,
        }
        this.applyTaskFeedTraversalCache = traversal
      }
      const { refs, runsById, attentionCount, activeCount } = traversal
      let startIndex = 0
      if (cursor?.direction === 'next') {
        startIndex = refs.findIndex(ref => compareRefToCursor(ref, cursor) > 0)
        if (startIndex < 0) startIndex = refs.length
      } else if (cursor?.direction === 'previous') {
        const boundary = refs.findIndex(ref => compareRefToCursor(ref, cursor) >= 0)
        startIndex = Math.max(0, (boundary < 0 ? refs.length : boundary) - limit)
      }
      const pageRefs = refs.slice(startIndex, startIndex + limit)
      const taskIds = pageRefs.filter(ref => ref.source === 'task').map(ref => ref.stableId)
      const tasks = this.getDurableApplyTasksByIds(taskIds)
      const taskById = new Map(tasks.map(task => [task.id, task]))
      const entries: ApplyTaskFeedEntryRow[] = []
      for (const ref of pageRefs) {
        if (ref.source === 'run') {
          const run = runsById.get(ref.stableId)
          if (run) entries.push({
            key: ref.key as `run:${string}`,
            priority: ref.priority,
            startedAt: ref.startedAt,
            run,
            ambiguousLegacy: ref.ambiguousLegacy,
          })
          continue
        }
        const task = taskById.get(ref.stableId)
        if (!task) continue
        entries.push({
          key: ref.key as `task:${string}`,
          priority: ref.priority,
          startedAt: ref.startedAt,
          task,
          overlayRuns: ref.overlayRunIds.flatMap(runId => {
            const run = runsById.get(runId)
            return run ? [run] : []
          }),
          ambiguousLegacy: false,
        })
      }
      const endIndex = startIndex + pageRefs.length
      return {
        entries,
        attentionCount,
        activeCount,
        totalCount: refs.length,
        startIndex,
        hasMore: endIndex < refs.length,
        hasPrevious: startIndex > 0,
        nextCursor: endIndex < refs.length && pageRefs.length > 0
          ? encodeApplyTaskFeedCursor(revision, snapshotAtMs, 'next', pageRefs[pageRefs.length - 1]!)
          : null,
        previousCursor: startIndex > 0 && pageRefs.length > 0
          ? encodeApplyTaskFeedCursor(revision, snapshotAtMs, 'previous', pageRefs[0]!)
          : null,
      }
    }).deferred()
  }

  /** Exact pinned recovered-run lookup with the same global authority rules as the feed. */
  getApplyTaskFeedRun(runId: string, nowMs: number): ApplyTaskRunRow | undefined {
    return this.db.transaction(() => {
      const run = this.db.prepare(`
        SELECT id, installation_id, execution_plan_hash, state, failure_code,
               created_at, started_at, completed_at, updated_at
        FROM reconcile_runs
        WHERE id = ? AND operation_type = 'connect' AND installation_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_integration_apply_task_items owner WHERE owner.run_id = reconcile_runs.id
          )
      `).get(runId) as ApplyTaskRunRow | undefined
      if (!run) return undefined
      const legacy = this.resolveLegacyNullApplyTaskRuns()
      if (legacy.bindings.some(binding => binding.run.id === runId)) return undefined
      if (legacy.candidateRuns.some(candidate => candidate.id === runId)) return run
      return applyTaskFeedRunNeedsPresentation(run, nowMs) ? run : undefined
    }).deferred()
  }

  /** Exact durable task hydration and legacy ownership are read from one SQLite snapshot. */
  getApplyTaskFeedTask(taskId: string): {
    task: DurableApplyTaskRow
    overlayRuns: ApplyTaskRunRow[]
  } | undefined {
    return this.db.transaction(() => {
      const task = this.getDurableApplyTask(taskId)
      if (!task) return undefined
      const overlayRuns = this.resolveLegacyNullApplyTaskRuns().bindings
        .filter(binding => binding.taskId === taskId)
        .map(binding => binding.run)
      return { task, overlayRuns }
    }).deferred()
  }

  createApplyTask(input: {
    id: string
    planHash: string
    startedAt: string
    items: readonly { installationId: string; executionPlanHash: string }[]
  }): void {
    if (input.items.length === 0) throw new Error('an apply task requires at least one Installation')
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_integration_apply_tasks (
          id, plan_hash, operation_type, state, started_at, completed_at, updated_at
        ) VALUES (?, ?, 'connect', 'running', ?, NULL, ?)
      `).run(input.id, input.planHash, input.startedAt, input.startedAt)
      const insertItem = this.db.prepare(`
        INSERT INTO agent_integration_apply_task_items (
          task_id, installation_id, ordinal, execution_plan_hash, state,
          result_json, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)
      `)
      input.items.forEach((item, ordinal) => {
        insertItem.run(input.id, item.installationId, ordinal, item.executionPlanHash, input.startedAt)
      })
    }).immediate()
  }

  markApplyTaskItemRunning(taskId: string, installationId: string, startedAt: string): void {
    const result = this.db.prepare(`
      UPDATE agent_integration_apply_task_items
      SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE task_id = ? AND installation_id = ? AND state = 'pending'
        AND EXISTS (
          SELECT 1 FROM agent_integration_apply_tasks task
          WHERE task.id = agent_integration_apply_task_items.task_id AND task.state = 'running'
        )
    `).run(startedAt, startedAt, taskId, installationId)
    if (result.changes !== 1) throw new Error(`apply task item is no longer pending: ${installationId}`)
  }

  completeApplyTaskItem(
    taskId: string,
    installationId: string,
    result: unknown,
    completedAt: string,
  ): void {
    const sanitized = sanitizeAgentIntegrationEventPersistence({
      kind: 'agent_apply_task_result',
      payload: result,
    }).payloadJson
    const updated = this.db.prepare(`
      UPDATE agent_integration_apply_task_items
      SET state = 'terminal', result_json = ?, completed_at = ?, updated_at = ?
      WHERE task_id = ? AND installation_id = ? AND state = 'running'
    `).run(sanitized, completedAt, completedAt, taskId, installationId)
    if (updated.changes !== 1) throw new Error(`apply task item is not running: ${installationId}`)
    this.db.prepare(`
      UPDATE agent_integration_apply_tasks SET updated_at = ?
      WHERE id = ? AND state = 'running'
    `).run(completedAt, taskId)
  }

  completeApplyTask(taskId: string, completedAt: string): void {
    const updated = this.db.prepare(`
      UPDATE agent_integration_apply_tasks
      SET state = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM agent_integration_apply_task_items item
          WHERE item.task_id = agent_integration_apply_tasks.id
            AND item.state IN ('pending','running')
        )
    `).run(completedAt, completedAt, taskId)
    if (updated.changes !== 1) throw new Error(`apply task still has non-terminal items: ${taskId}`)
  }

  interruptAbandonedApplyTasks(interruptedAt: string): number {
    return this.db.transaction(() => {
      const tasks = this.db.prepare(`
        SELECT id FROM agent_integration_apply_tasks WHERE state = 'running'
      `).all() as Array<{ id: string }>
      const updateItem = this.db.prepare(`
        UPDATE agent_integration_apply_task_items
        SET state = 'interrupted', result_json = ?, completed_at = ?, updated_at = ?
        WHERE task_id = ? AND state = ?
      `)
      const completeTask = this.db.prepare(`
        UPDATE agent_integration_apply_tasks
        SET state = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'running'
      `)
      for (const task of tasks) {
        for (const state of ['pending', 'running'] as const) {
          const payload = sanitizeAgentIntegrationEventPersistence({
            kind: 'agent_apply_task_interrupted',
            payload: {
              status: 'interrupted',
              reason: state === 'pending'
                ? 'Application exited before this item started; inspect and preview again'
                : 'Application exited before this item completed; inspect recovery state and preview again',
            },
          }).payloadJson
          updateItem.run(payload, interruptedAt, interruptedAt, task.id, state)
        }
        completeTask.run(interruptedAt, interruptedAt, task.id)
      }
      return tasks.length
    }).immediate()
  }

  listDurableApplyTasks(limit = 20): DurableApplyTaskRow[] {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100))
    const tasks = this.db.prepare(`
      SELECT id, plan_hash, operation_type, state, started_at, completed_at, updated_at
      FROM agent_integration_apply_tasks task
      WHERE task.state = 'running'
        OR NOT EXISTS (
          SELECT 1 FROM agent_integration_apply_task_items item
          WHERE item.task_id = task.id
        )
        OR EXISTS (
          SELECT 1 FROM agent_integration_apply_task_items item
          WHERE item.task_id = task.id
            AND CASE
              WHEN item.state != 'terminal' THEN 1
              WHEN json_valid(item.result_json) = 0 THEN 1
              WHEN COALESCE(json_type(item.result_json, '$'), '') != 'object' THEN 1
              WHEN COALESCE(json_extract(item.result_json, '$.status'), '') != 'committed' THEN 1
              WHEN COALESCE(json_type(item.result_json, '$.installationId'), '') != 'text' THEN 1
              WHEN json_extract(item.result_json, '$.installationId') != item.installation_id THEN 1
              WHEN COALESCE(json_type(item.result_json, '$.runId'), '') != 'text' THEN 1
              WHEN item.run_id IS NULL OR json_extract(item.result_json, '$.runId') != item.run_id THEN 1
              WHEN NOT EXISTS (
                SELECT 1 FROM reconcile_runs run
                WHERE run.id = item.run_id
                  AND run.installation_id = item.installation_id
                  AND run.execution_plan_hash = item.execution_plan_hash
                  AND run.operation_type = task.operation_type
                  AND run.state = 'committed'
              ) THEN 1
              ELSE 0
            END = 1
        )
        OR task.id IN (
          SELECT recent.id
          FROM agent_integration_apply_tasks recent
          WHERE recent.state = 'completed'
            AND EXISTS (
              SELECT 1 FROM agent_integration_apply_task_items success_item
              WHERE success_item.task_id = recent.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM agent_integration_apply_task_items success_item
              WHERE success_item.task_id = recent.id
                AND CASE
                  WHEN success_item.state != 'terminal' THEN 1
                  WHEN json_valid(success_item.result_json) = 0 THEN 1
                  WHEN COALESCE(json_type(success_item.result_json, '$'), '') != 'object' THEN 1
                  WHEN COALESCE(json_extract(success_item.result_json, '$.status'), '') != 'committed' THEN 1
                  WHEN COALESCE(json_type(success_item.result_json, '$.installationId'), '') != 'text' THEN 1
                  WHEN json_extract(success_item.result_json, '$.installationId') != success_item.installation_id THEN 1
                  WHEN COALESCE(json_type(success_item.result_json, '$.runId'), '') != 'text' THEN 1
                  WHEN success_item.run_id IS NULL
                    OR json_extract(success_item.result_json, '$.runId') != success_item.run_id THEN 1
                  WHEN NOT EXISTS (
                    SELECT 1 FROM reconcile_runs run
                    WHERE run.id = success_item.run_id
                      AND run.installation_id = success_item.installation_id
                      AND run.execution_plan_hash = success_item.execution_plan_hash
                      AND run.operation_type = recent.operation_type
                      AND run.state = 'committed'
                  ) THEN 1
                  ELSE 0
                END = 1
            )
          ORDER BY recent.started_at DESC, recent.id DESC LIMIT ?
        )
      ORDER BY started_at DESC, id DESC
    `).all(bounded) as Array<Omit<DurableApplyTaskRow, 'items'>>
    return this.hydrateDurableApplyTasks(tasks)
  }

  getDurableApplyTask(taskId: string): DurableApplyTaskRow | undefined {
    const task = this.db.prepare(`
      SELECT id, plan_hash, operation_type, state, started_at, completed_at, updated_at
      FROM agent_integration_apply_tasks
      WHERE id = ?
    `).get(taskId) as Omit<DurableApplyTaskRow, 'items'> | undefined
    return task ? this.hydrateDurableApplyTasks([task])[0] : undefined
  }

  private getDurableApplyTasksByIds(taskIds: readonly string[]): DurableApplyTaskRow[] {
    if (taskIds.length === 0) return []
    if (taskIds.length > 50) throw new Error('task feed hydration exceeds page limit')
    const placeholders = taskIds.map(() => '?').join(',')
    const tasks = this.db.prepare(`
      SELECT id, plan_hash, operation_type, state, started_at, completed_at, updated_at
      FROM agent_integration_apply_tasks WHERE id IN (${placeholders})
    `).all(...taskIds) as Array<Omit<DurableApplyTaskRow, 'items'>>
    return this.hydrateDurableApplyTasks(tasks)
  }

  private hydrateDurableApplyTasks(
    tasks: Array<Omit<DurableApplyTaskRow, 'items'>>,
  ): DurableApplyTaskRow[] {
    if (tasks.length === 0) return []
    const taskIds = tasks.map(task => task.id)
    const placeholders = taskIds.map(() => '?').join(',')
    const items = this.db.prepare(`
      SELECT item.task_id, item.installation_id, item.run_id, item.execution_plan_hash, item.state,
             item.result_json, item.started_at, item.ordinal,
             CASE
               WHEN run.id IS NULL OR run.installation_id != item.installation_id
                 OR run.execution_plan_hash != item.execution_plan_hash
                 OR run.operation_type != task.operation_type THEN 0
               ELSE 1
             END AS exact_run_correlation,
             run.state AS exact_run_state,
             run.failure_code AS exact_run_failure_code,
             run.created_at AS exact_run_created_at,
             run.started_at AS exact_run_started_at,
             run.completed_at AS exact_run_completed_at,
             run.updated_at AS exact_run_updated_at
      FROM agent_integration_apply_task_items item
      JOIN agent_integration_apply_tasks task ON task.id = item.task_id
      LEFT JOIN reconcile_runs run ON run.id = item.run_id
      WHERE item.task_id IN (${placeholders}) ORDER BY item.task_id, item.ordinal
    `).all(...taskIds) as Array<DurableApplyTaskRow['items'][number] & { task_id: string }>
    const itemsByTask = new Map<string, DurableApplyTaskRow['items']>()
    for (const item of items) {
      const list = itemsByTask.get(item.task_id)
      if (list) list.push(item)
      else itemsByTask.set(item.task_id, [item])
    }
    return tasks.map(task => ({
      ...task,
      items: itemsByTask.get(task.id) ?? [],
    }))
  }

  createManagedArtifact(input: ManagedArtifactInput, createdAt: string): void {
    this.db.prepare(`
      INSERT INTO managed_artifacts (
        id, runtime_realm, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, container_precondition_hash,
        owned_fragment_hash, desired_fragment_hash, observed_fragment_hash,
        previous_snapshot_ref, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.runtimeRealm ?? 'local_macos',
      input.componentType,
      input.targetPath,
      input.ownershipKey ?? '',
      input.mutationDomain,
      input.projectionVersion,
      input.selectorSchemaVersion,
      input.containerPreconditionHash ?? null,
      input.ownedFragmentHash ?? null,
      input.desiredFragmentHash ?? null,
      input.observedFragmentHash ?? null,
      input.previousSnapshotRef ?? null,
      input.state ?? 'healthy',
      createdAt,
      createdAt,
    )
  }

  getManagedArtifact(artifactId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM managed_artifacts WHERE id = ?')
      .get(artifactId) as Record<string, unknown> | undefined
  }

  findExactManagedArtifacts(
    runtimeRealm: string,
    targetPath: string,
    observedFragmentHash: string,
  ): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT * FROM managed_artifacts
      WHERE runtime_realm = ? AND target_path = ?
        AND owned_fragment_hash = ? AND desired_fragment_hash = ?
        AND state IN ('healthy','needs_recovery')
      ORDER BY ownership_key, id
    `).all(
      runtimeRealm,
      targetPath,
      observedFragmentHash,
      observedFragmentHash,
    ) as Array<Record<string, unknown>>
  }

  listArtifactConsumers(artifactId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT * FROM artifact_consumers WHERE artifact_id = ? ORDER BY installation_id, component_key
    `).all(artifactId) as Array<Record<string, unknown>>
  }

  /** Exact active consumer set frozen into a user-approved disconnect plan. */
  getDisconnectArtifactScope(
    installationId: string,
    componentKey: ComponentKey,
    targetPath: string,
    ownershipKey: string,
  ): DisconnectArtifactScope | null {
    const artifact = this.db.prepare(`
      SELECT a.id, a.target_path, a.ownership_key
      FROM agent_installations i
      JOIN managed_artifacts a ON a.runtime_realm = i.runtime_realm
      JOIN artifact_consumers own
        ON own.artifact_id = a.id AND own.installation_id = i.id
       AND own.component_key = ?
      WHERE i.id = ? AND a.target_path = ? AND a.ownership_key = ?
        AND a.state NOT IN ('removed','conflict')
        AND own.state = 'active' AND own.desired_state IN ('managed','disabled')
        AND own.tombstoned_at IS NULL
    `).get(componentKey, installationId, targetPath, ownershipKey) as {
      id: string
      target_path: string
      ownership_key: string
    } | undefined
    if (!artifact) return null
    const consumers = this.db.prepare(`
      SELECT c.installation_id, i.display_name, i.host_variant, i.profile_id,
             c.component_key, c.discover_reachability
      FROM artifact_consumers c
      JOIN agent_installations i ON i.id = c.installation_id
      WHERE c.artifact_id = ? AND c.state = 'active'
        AND c.desired_state IN ('managed','disabled') AND c.tombstoned_at IS NULL
      ORDER BY c.installation_id, c.component_key
    `).all(artifact.id) as Array<{
      installation_id: string
      display_name: string
      host_variant: CatalogId
      profile_id: string
      component_key: ComponentKey
      discover_reachability: 'dedicated' | 'shared_visible' | 'per_host_ignorable'
    }>
    return {
      artifactId: artifact.id,
      initiatingInstallationId: installationId,
      componentKey,
      targetPath: artifact.target_path,
      ownershipKey: artifact.ownership_key,
      consumers: consumers.map(consumer => ({
        installationId: consumer.installation_id,
        displayName: consumer.display_name,
        hostVariant: consumer.host_variant,
        profileId: consumer.profile_id,
        componentKey: consumer.component_key,
        discoverReachability: consumer.discover_reachability,
      })),
    }
  }

  addArtifactConsumer(input: {
    artifactId: string
    installationId: string
    componentKey: string
    requiredCapability: number
    discoverReachability: 'dedicated' | 'shared_visible' | 'per_host_ignorable'
    componentException?: string | null
    consentEnvelopeId?: string | null
    /** Exact side-effect-free read-back proving this Tide Mind-owned Artifact. */
    ownershipFingerprint: string
    /** Coordinator-only pending activation; consumer remains disabled until verification commits. */
    allowNeedsRecoveryPending?: boolean
    addedAt: string
  }): void {
    assertCapability(input.requiredCapability)
    this.db.transaction(() => {
      const installation = this.getInstallation(input.installationId)
      if (!installation || installation.desired_state === 'removed' || installation.tombstoned_at) {
        throw new Error(`cannot attach consumer to removed or unknown installation: ${input.installationId}`)
      }
      const component = this.db.prepare(`
        SELECT desired_state, tombstoned_at FROM installation_components
        WHERE installation_id = ? AND component_key = ?
      `).get(input.installationId, input.componentKey) as
        | { desired_state: InstallationDesiredState; tombstoned_at: string | null }
        | undefined
      if (!component || component.desired_state === 'removed' || component.tombstoned_at) {
        throw new Error(`cannot attach consumer to removed or unknown component: ${input.componentKey}`)
      }
      const artifact = this.db.prepare(`
        SELECT state, owned_fragment_hash FROM managed_artifacts WHERE id = ?
      `).get(input.artifactId) as { state: ArtifactState; owned_fragment_hash: string | null } | undefined
      const allowedArtifactState = artifact?.state === 'healthy'
        || (input.allowNeedsRecoveryPending === true && artifact?.state === 'needs_recovery')
      if (!artifact || !allowedArtifactState || !artifact.owned_fragment_hash
        || artifact.owned_fragment_hash !== input.ownershipFingerprint) {
        throw new Error(`cannot adopt Artifact without exact Tide Mind ownership evidence: ${input.artifactId}`)
      }
      this.db.prepare(`
        INSERT INTO artifact_consumers (
          artifact_id, installation_id, component_key, required_capability,
          discover_reachability, component_exception, consent_envelope_id, added_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id, installation_id, component_key) DO UPDATE SET
          required_capability = excluded.required_capability,
          desired_state = 'managed',
          discover_reachability = excluded.discover_reachability,
          component_exception = excluded.component_exception,
          consent_envelope_id = excluded.consent_envelope_id,
          updated_at = excluded.updated_at
        WHERE artifact_consumers.state = 'active' AND artifact_consumers.tombstoned_at IS NULL
      `).run(
        input.artifactId,
        input.installationId,
        input.componentKey,
        input.requiredCapability,
        input.discoverReachability,
        input.componentException ?? null,
        input.consentEnvelopeId ?? null,
        input.addedAt,
        input.addedAt,
      )
    }).immediate()
  }

  createConsent(input: ConsentInput): void {
    this.db.transaction(() => {
      if (input.expectedInstallationSurfaceFingerprint !== undefined) {
        const installation = this.getInstallation(input.installationId)
        if (!installation
          || persistedProjectionSurfaceFingerprint(installation)
            !== input.expectedInstallationSurfaceFingerprint) {
          throw new Error('Installation projection surface changed before consent')
        }
      }
      this.db.prepare(`
        INSERT INTO agent_consents (
          id, installation_id, policy_version, allowed_components_json, allowed_scopes_json,
          normalized_targets_json, selector_schema_version, selector_resolution_json,
          executable_realpaths_json, command_categories_json, maximum_risk, exception_scope,
          exceptions_json, confirmed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.installationId,
        input.policyVersion,
        json(input.allowedComponents, []),
        json(input.allowedScopes, []),
        json(input.normalizedTargets, []),
        input.selectorSchemaVersion,
        json(input.selectorResolution, {}),
        json(input.executableRealpaths, []),
        json(input.commandCategories, []),
        input.maximumRisk,
        input.exceptionScope ?? 'installation',
        json(input.exceptions, {}),
        input.confirmedAt,
        input.confirmedAt,
      )
    }).immediate()
  }

  listOwnedArtifactConsentScopes(
    installationId: string,
    componentKeys: readonly ComponentKey[],
  ): Array<{
    componentKey: ComponentKey
    targetPath: string
    ownershipKey: string
    selectorSchemaVersion: number
    ownedFragmentHash: string | null
  }> {
    if (componentKeys.length === 0) return []
    const placeholders = componentKeys.map(() => '?').join(',')
    return (this.db.prepare(`
      SELECT c.component_key, a.target_path, a.ownership_key, a.selector_schema_version,
             a.owned_fragment_hash
      FROM artifact_consumers c
      JOIN managed_artifacts a ON a.id = c.artifact_id
      WHERE c.installation_id = ?
        AND c.component_key IN (${placeholders})
        AND c.state = 'active' AND c.desired_state IN ('managed','disabled')
        AND c.tombstoned_at IS NULL
        AND a.state NOT IN ('removed','conflict')
      ORDER BY c.component_key, a.target_path, a.ownership_key
    `).all(installationId, ...componentKeys) as Array<{
      component_key: ComponentKey
      target_path: string
      ownership_key: string
      selector_schema_version: string | number
      owned_fragment_hash: string | null
    }>).map(row => {
      const selectorSchemaVersion = Number(row.selector_schema_version)
      if (!Number.isInteger(selectorSchemaVersion) || selectorSchemaVersion <= 0) {
        throw new Error(`invalid selector schema version for ${row.component_key}`)
      }
      return {
        componentKey: row.component_key,
        targetPath: row.target_path,
        ownershipKey: row.ownership_key,
        selectorSchemaVersion,
        ownedFragmentHash: row.owned_fragment_hash,
      }
    })
  }

  getConsent(consentId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM agent_consents WHERE id = ?')
      .get(consentId) as Record<string, unknown> | undefined
  }

  createReconcileRun(input: ReconcileRunInput): void {
    this.insertReconcileRun(input)
  }

  private insertReconcileRun(input: ReconcileRunInput): void {
    this.db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, consent_envelope_id,
        recovery_strategy, writer_fence_snapshot_json, adapter_version, catalog_version, projection_version,
        selector_schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.installationId ?? null,
      input.operationType,
      input.executionPlanHash,
      input.consentEnvelopeId ?? null,
      input.recoveryStrategy,
      json(input.writerFenceSnapshot, {}),
      input.adapterVersion ?? null,
      input.catalogVersion ?? null,
      input.projectionVersion ?? null,
      input.selectorSchemaVersion ?? null,
      input.createdAt,
      input.createdAt,
    )
  }

  appendProjectionMutation(input: ProjectionMutationInput): void {
    this.insertProjectionMutation(input)
  }

  private insertProjectionMutation(input: ProjectionMutationInput): void {
    this.db.prepare(`
      INSERT INTO projection_mutations (
        id, run_id, operation_id, installation_id, component_key, artifact_id,
        mutation_domain, target, before_hash, after_hash, precondition_json,
        adapter_version, catalog_version, projection_version, selector_schema_version,
        writer_fence_epoch, writer_generation, idempotency_strategy, readback_strategy,
        compensation_precondition, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.runId,
      input.operationId,
      input.installationId ?? null,
      input.componentKey ?? null,
      input.artifactId ?? null,
      input.mutationDomain,
      input.target,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      json(input.precondition, {}),
      input.adapterVersion ?? null,
      input.catalogVersion ?? null,
      input.projectionVersion ?? null,
      input.selectorSchemaVersion ?? null,
      input.writerFenceEpoch ?? null,
      input.writerGeneration ?? null,
      input.idempotencyStrategy,
      input.readbackStrategy,
      input.compensationPrecondition ?? null,
      input.createdAt,
      input.createdAt,
    )
  }

  transitionRunState(runId: string, expectedState: string, nextState: string, updatedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE reconcile_runs SET state = ?, updated_at = ? WHERE id = ? AND state = ?
    `).run(nextState, updatedAt, runId, expectedState)
    return result.changes === 1
  }

  transitionMutationState(
    mutationId: string,
    expectedState: string,
    nextState: string,
    updatedAt: string,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE projection_mutations SET state = ?, updated_at = ? WHERE id = ? AND state = ?
    `).run(nextState, updatedAt, mutationId, expectedState)
    return result.changes === 1
  }

  listRecoverableRuns(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT * FROM reconcile_runs
      WHERE state IN ('applying','applied_unverified','compensating','needs_recovery')
      ORDER BY created_at
    `).all() as Array<Record<string, unknown>>
  }

  listRunMutations(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT * FROM projection_mutations WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as Array<Record<string, unknown>>
  }

  recordVerificationResult(input: VerificationResultInput): void {
    const invalidationKeys = new Set(input.invalidationKeys ?? [])
    if (input.result === 'verified' && !input.identityAssertion) {
      throw new Error('verified evidence requires an Agent identity assertion')
    }
    if (input.result === 'verified'
      && invalidationKeys.has('reload_generation')
      && !input.reloadGeneration) {
      throw new Error('reload-generation-bound evidence requires a reload generation')
    }
    const tx = this.db.transaction(() => {
      if (input.result === 'verified') {
        const installation = this.db.prepare(`
          SELECT agent_id FROM agent_installations WHERE id = ?
        `).get(input.installationId) as { agent_id: string | null } | undefined
        if (!installation?.agent_id || input.identityAssertion !== installation.agent_id) {
          throw new Error('verified evidence identity assertion does not match the current Installation')
        }
      }
      this.db.prepare(`
        INSERT INTO verification_results (
          id, run_id, installation_id, component_key, family, host_variant, distribution_id,
          runtime_realm, host_version, os_version, adapter_version, catalog_version,
          tide_mind_version, projection_version, selector_schema_version, verification_manifest_version,
          method, identity_assertion, artifact_hash, reload_generation, invalidation_keys_json,
          result, evidence_ref, evidence_hash, verified_at,
          expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.runId ?? null,
        input.installationId,
        input.componentKey,
        input.family,
        input.hostVariant,
        input.distributionId ?? null,
        input.runtimeRealm,
        input.hostVersion ?? null,
        input.osVersion ?? null,
        input.adapterVersion,
        input.catalogVersion,
        input.tideMindVersion ?? null,
        input.projectionVersion ?? null,
        input.selectorSchemaVersion ?? null,
        input.verificationManifestVersion,
        input.method,
        input.identityAssertion ?? null,
        input.artifactHash ?? null,
        input.reloadGeneration ?? null,
        json(input.invalidationKeys, []),
        input.result,
        input.evidenceRef ?? null,
        input.evidenceHash,
        input.verifiedAt,
        input.expiresAt ?? null,
        input.verifiedAt,
      )
      this.db.prepare(`
        UPDATE installation_components
        SET verification_status = ?, verification_result_id = ?, updated_at = ?
        WHERE installation_id = ? AND component_key = ?
      `).run(
        input.result === 'verified' ? 'verified' : 'failed',
        input.id,
        input.verifiedAt,
        input.installationId,
        input.componentKey,
      )
    })
    tx()
  }

  invalidateVerificationResults(
    installationId: string,
    componentKey: string,
    invalidatedAt: string,
    reason: string,
  ): number {
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE verification_results
        SET invalidated_at = ?, invalidation_reason = ?
        WHERE installation_id = ? AND component_key = ? AND invalidated_at IS NULL
      `).run(invalidatedAt, reason, installationId, componentKey)
      this.db.prepare(`
        UPDATE installation_components
        SET verification_status = 'stale', updated_at = ?
        WHERE installation_id = ? AND component_key = ?
      `).run(invalidatedAt, installationId, componentKey)
      return result.changes
    })
    return tx()
  }

  /**
   * Imports an exact, side-effect-free legacy ownership baseline.  This never
   * grants maintenance consent and never mutates a host: it only preserves the
   * old identity plus proven Tide Mind-owned fragments in the local Ledger.
   */
  adoptLegacyInstallation(input: {
    legacyAgentId: string
    legacyToolType: string
    installationId: string
    expectedHostVariant: string
    expectedRuntimeRealm: string
    expectedConfigRoot: string
    expectedDistributionId: string | null
    expectedInstallKey: string
    expectedProfileId: string
    expectedOsUserIdentity: string | null
    expectedProvenance: string | null
    expectedExecutablePath: string | null
    expectedAppPath: string | null
    expectedDetectedVersion: string | null
    expectedVersionDetectionMethod: string | null
    expectedMetadataJson: string
    evidenceHash: string
    artifacts: readonly LegacyAdoptionArtifactInput[]
    adoptedAt: string
  }): 'adopted' | 'already_adopted' {
    if (input.artifacts.length === 0) throw new Error('legacy adoption requires owned artifacts')
    return this.db.transaction(() => {
      const legacy = this.db.prepare(`
        SELECT id, tool_type, archived FROM agents WHERE id = ?
      `).get(input.legacyAgentId) as { id: string; tool_type: string; archived: number } | undefined
      if (!legacy || legacy.tool_type !== input.legacyToolType) {
        throw new Error('legacy adoption source changed')
      }
      if (legacy.archived !== 0) throw new Error('archived legacy Agent cannot be adopted as active')

      const installation = this.getInstallation(input.installationId)
      if (!installation) throw new Error('legacy adoption target disappeared')
      const existingAlias = this.db.prepare(`
        SELECT installation_id FROM agent_aliases
        WHERE alias_type = 'legacy_agent_id' AND alias_value = ? AND runtime_realm = ?
      `).get(input.legacyAgentId, installation.runtime_realm) as { installation_id: string } | undefined
      if (existingAlias) {
        if (existingAlias.installation_id !== installation.id) {
          throw new Error('legacy Agent is already bound to another Installation')
        }
        return 'already_adopted'
      }
      if (installation.desired_state !== 'unmanaged' || installation.tombstoned_at) {
        throw new Error('legacy adoption target is not an unmanaged active Installation')
      }
      if (installation.health_state !== 'discovered' || installation.status_reason === 'conflict'
        || installation.host_variant !== input.expectedHostVariant
        || installation.runtime_realm !== input.expectedRuntimeRealm
        || installation.config_root !== input.expectedConfigRoot
        || installation.distribution_id !== input.expectedDistributionId
        || installation.install_key !== input.expectedInstallKey
        || installation.profile_id !== input.expectedProfileId
        || installation.os_user_identity !== input.expectedOsUserIdentity
        || installation.provenance !== input.expectedProvenance
        || installation.executable_path !== input.expectedExecutablePath
        || installation.app_path !== input.expectedAppPath
        || installation.detected_version !== input.expectedDetectedVersion
        || installation.version_detection_method !== input.expectedVersionDetectionMethod
        || installation.metadata_json !== input.expectedMetadataJson) {
        throw new Error('legacy adoption target identity or health changed')
      }

      const identityOwner = this.db.prepare(`
        SELECT id FROM agent_installations WHERE agent_id = ? AND id != ?
      `).get(input.legacyAgentId, installation.id) as { id: string } | undefined
      if (identityOwner) throw new Error('legacy Agent identity is already owned')

      if (installation.agent_id !== null && installation.agent_id !== input.legacyAgentId) {
        const boundState = this.db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM agent_consents WHERE installation_id = ?) AS consents,
            (SELECT COUNT(*) FROM verification_results WHERE installation_id = ?) AS evidence,
            (SELECT COUNT(*) FROM installation_components WHERE installation_id = ?) AS components
        `).get(installation.id, installation.id, installation.id) as {
          consents: number
          evidence: number
          components: number
        }
        if (boundState.consents !== 0 || boundState.evidence !== 0 || boundState.components !== 0) {
          throw new Error('generated Installation identity already has managed state')
        }
      }

      const previousAgentId = installation.agent_id
      const metadata = safeJsonObject(installation.metadata_json)
      this.db.prepare(`
        UPDATE agent_installations
        SET agent_id = ?, status_reason = 'awaiting_consent',
            metadata_json = ?, updated_at = ?
        WHERE id = ? AND desired_state = 'unmanaged' AND tombstoned_at IS NULL
      `).run(
        input.legacyAgentId,
        json({
          ...metadata,
          legacyAdoption: {
            sourceAgentId: input.legacyAgentId,
            sourceToolType: input.legacyToolType,
            evidenceHash: input.evidenceHash,
            adoptedAt: input.adoptedAt,
          },
        }, {}),
        input.adoptedAt,
        installation.id,
      )

      this.db.prepare(`
        INSERT INTO agent_aliases (
          id, alias_type, alias_value, runtime_realm, canonical_agent_id,
          installation_id, reason, created_at
        ) VALUES (?, 'legacy_agent_id', ?, ?, ?, ?, 'legacy_owned_projection', ?)
      `).run(
        `alias_${randomUUID()}`,
        input.legacyAgentId,
        installation.runtime_realm,
        input.legacyAgentId,
        installation.id,
        input.adoptedAt,
      )
      if (previousAgentId && previousAgentId !== input.legacyAgentId) {
        this.db.prepare(`
          INSERT OR IGNORE INTO agent_aliases (
            id, alias_type, alias_value, runtime_realm, canonical_agent_id,
            installation_id, reason, created_at
          ) VALUES (?, 'agent_id', ?, ?, ?, ?, 'pre_adoption_generated_identity', ?)
        `).run(
          `alias_${randomUUID()}`,
          previousAgentId,
          installation.runtime_realm,
          input.legacyAgentId,
          installation.id,
          input.adoptedAt,
        )
      }

      for (const artifact of input.artifacts) {
        const componentTombstone = this.db.prepare(`
          SELECT artifact_id, tombstoned_at FROM installation_components
          WHERE installation_id = ? AND component_key = ?
        `).get(installation.id, artifact.componentKey) as {
          artifact_id: string | null
          tombstoned_at: string | null
        } | undefined
        if (componentTombstone?.tombstoned_at) {
          throw new Error(`legacy component is tombstoned: ${artifact.componentKey}`)
        }
        const existing = this.db.prepare(`
          SELECT id, component_type, owned_fragment_hash, state
          FROM managed_artifacts
          WHERE runtime_realm = ? AND target_path = ? AND ownership_key = ?
        `).get(
          installation.runtime_realm,
          artifact.targetPath,
          artifact.ownershipKey,
        ) as {
          id: string
          component_type: string
          owned_fragment_hash: string | null
          state: ArtifactState
        } | undefined
        if (existing && (existing.component_type !== artifact.artifactType
          || existing.owned_fragment_hash !== artifact.fragmentHash
          || !['healthy', 'needs_recovery'].includes(existing.state))) {
          throw new Error(`legacy Artifact ownership conflict: ${artifact.targetPath}`)
        }
        const artifactId = existing?.id ?? artifact.id
        if (componentTombstone?.artifact_id && componentTombstone.artifact_id !== artifactId) {
          throw new Error(`legacy component already points to another Artifact: ${artifact.componentKey}`)
        }
        if (!existing) {
          this.db.prepare(`
            INSERT INTO managed_artifacts (
              id, runtime_realm, component_type, target_path, ownership_key, mutation_domain,
              projection_version, selector_schema_version, container_precondition_hash,
              owned_fragment_hash, desired_fragment_hash, observed_fragment_hash,
              state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_recovery', ?, ?)
          `).run(
            artifactId,
            installation.runtime_realm,
            artifact.artifactType,
            artifact.targetPath,
            artifact.ownershipKey,
            artifact.mutationDomain,
            artifact.projectionVersion,
            artifact.selectorSchemaVersion,
            artifact.containerHash ?? null,
            artifact.fragmentHash,
            artifact.fragmentHash,
            artifact.fragmentHash,
            input.adoptedAt,
            input.adoptedAt,
          )
        }
        const componentResult = this.db.prepare(`
          INSERT INTO installation_components (
            installation_id, component_key, desired_state, desired_capability,
            delivery_mode, verification_status, artifact_id, visibility_state,
            created_at, updated_at
          ) VALUES (?, ?, 'unmanaged', 0, 'managed', 'unverified', ?, ?, ?, ?)
          ON CONFLICT(installation_id, component_key) DO UPDATE SET
            artifact_id = excluded.artifact_id,
            delivery_mode = 'managed',
            verification_status = 'unverified',
            visibility_state = excluded.visibility_state,
            updated_at = excluded.updated_at
          WHERE installation_components.desired_state = 'unmanaged'
            AND installation_components.tombstoned_at IS NULL
        `).run(
          installation.id,
          artifact.componentKey,
          artifactId,
          artifact.discoverReachability === 'shared_visible' ? 'shared_visible' : 'dedicated',
          input.adoptedAt,
          input.adoptedAt,
        )
        if (componentResult.changes !== 1) {
          throw new Error(`legacy component could not be adopted: ${artifact.componentKey}`)
        }
        const existingConsumer = this.db.prepare(`
          SELECT tombstoned_at FROM artifact_consumers
          WHERE artifact_id = ? AND installation_id = ? AND component_key = ?
        `).get(artifactId, installation.id, artifact.componentKey) as { tombstoned_at: string | null } | undefined
        if (existingConsumer?.tombstoned_at) {
          throw new Error(`legacy Artifact consumer is tombstoned: ${artifact.componentKey}`)
        }
        const consumerResult = this.db.prepare(`
          INSERT INTO artifact_consumers (
            artifact_id, installation_id, component_key, required_capability,
            desired_state, discover_reachability, state, added_at, updated_at
          ) VALUES (?, ?, ?, 0, 'disabled', ?, 'active', ?, ?)
          ON CONFLICT(artifact_id, installation_id, component_key) DO UPDATE SET
            discover_reachability = excluded.discover_reachability,
            updated_at = excluded.updated_at
          WHERE artifact_consumers.state = 'active'
            AND artifact_consumers.tombstoned_at IS NULL
        `).run(
          artifactId,
          installation.id,
          artifact.componentKey,
          artifact.discoverReachability,
          input.adoptedAt,
          input.adoptedAt,
        )
        if (consumerResult.changes !== 1) {
          throw new Error(`legacy Artifact consumer could not be adopted: ${artifact.componentKey}`)
        }
      }

      this.recordEvent({
        installationId: installation.id,
        kind: 'legacy_connection_adopted',
        severity: 'info',
        dedupeKey: `${input.legacyAgentId}:legacy-adopted`,
        payload: {
          legacyAgentId: input.legacyAgentId,
          legacyToolType: input.legacyToolType,
          evidenceHash: input.evidenceHash,
          componentKeys: input.artifacts.map(artifact => artifact.componentKey),
        },
        createdAt: input.adoptedAt,
      })
      return 'adopted'
    }).immediate()
  }

  addAlias(input: {
    id: string
    aliasType: 'legacy_agent_id' | 'agent_id' | 'config_root' | 'profile' | 'install_path' | 'executable_path'
    aliasValue: string
    runtimeRealm?: string
    canonicalAgentId?: string | null
    installationId: string
    reason: string
    createdAt: string
  }): void {
    this.db.prepare(`
      INSERT INTO agent_aliases (
        id, alias_type, alias_value, runtime_realm, canonical_agent_id,
        installation_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.aliasType,
      input.aliasValue,
      input.runtimeRealm ?? 'local_macos',
      input.canonicalAgentId ?? null,
      input.installationId,
      input.reason,
      input.createdAt,
    )
  }

  recordEvent(input: IntegrationEventInput): string {
    const id = input.id ?? `aie_${randomUUID()}`
    const sanitized = sanitizeAgentIntegrationEventPersistence({
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
    })
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO agent_integration_events (
        id, installation_id, component_key, artifact_id, kind, severity,
        episode_id, dedupe_key, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.installationId ?? null,
      input.componentKey ?? null,
      input.artifactId ?? null,
      input.kind,
      input.severity ?? 'info',
      input.episodeId ?? null,
      sanitized.dedupeKey,
      sanitized.payloadJson,
      input.createdAt,
    )
    if (result.changes === 0) {
      const existing = input.artifactId && input.episodeId
        ? this.db.prepare(`
            SELECT id FROM agent_integration_events WHERE artifact_id = ? AND episode_id = ?
          `).get(input.artifactId, input.episodeId) as { id: string } | undefined
        : sanitized.dedupeKey
          ? this.db.prepare(`
              SELECT id FROM agent_integration_events WHERE kind = ? AND dedupe_key = ?
            `).get(input.kind, sanitized.dedupeKey) as { id: string } | undefined
          : undefined
      if (!existing) throw new Error(`integration event id already exists: ${id}`)
      return existing.id
    }
    return id
  }

  listEvents(options: { state?: 'unread' | 'read' | 'archived'; limit?: number } = {}): Array<Record<string, unknown>> {
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('event limit must be an integer from 1 to 1000')
    }
    return this.db.prepare(`
      SELECT * FROM agent_integration_events
      WHERE @state IS NULL OR state = @state
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `).all({ state: options.state ?? null, limit }) as Array<Record<string, unknown>>
  }

  listInstallationEvents(
    installationId: string,
    options: { state?: 'unread' | 'read' | 'archived'; limit?: number } = {},
  ): Array<Record<string, unknown>> {
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('event limit must be an integer from 1 to 1000')
    }
    return this.db.prepare(`
      SELECT * FROM agent_integration_events
      WHERE installation_id = @installationId
        AND (@state IS NULL OR state = @state)
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `).all({ installationId, state: options.state ?? null, limit }) as Array<Record<string, unknown>>
  }

  markEventRead(eventId: string, readAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE agent_integration_events
      SET state = 'read', read_at = COALESCE(read_at, ?)
      WHERE id = ? AND state = 'unread'
    `).run(readAt, eventId)
    return result.changes === 1
  }

  markInstallationEventsRead(installationId: string, readAt: string): number {
    const result = this.db.prepare(`
      UPDATE agent_integration_events
      SET state = 'read', read_at = COALESCE(read_at, ?)
      WHERE installation_id = ? AND state = 'unread'
    `).run(readAt, installationId)
    return result.changes
  }

  getMinimumWriterProtocol(): number {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(AGENT_INTEGRATION_MINIMUM_WRITER_PROTOCOL_KEY) as { value: string } | undefined
    const value = Number(row?.value ?? AGENT_INTEGRATION_WRITER_PROTOCOL)
    return Number.isInteger(value) && value >= 1 ? value : AGENT_INTEGRATION_WRITER_PROTOCOL
  }

  getWriterFence(mutationDomain: string): WriterFenceRow | undefined {
    return this.db.prepare('SELECT * FROM writer_fences WHERE mutation_domain = ?')
      .get(mutationDomain) as WriterFenceRow | undefined
  }

  claimWriterFence(input: {
    mutationDomain: string
    writerProtocol: number
    writerGeneration: number
    ownerInstanceId: string
    nowMs: number
    leaseDurationMs: number
    nowIso: string
    metadata?: unknown
  }): { acquired: boolean; reason?: 'protocol_too_old' | 'generation_too_old' | 'lease_held'; fence?: WriterFenceRow } {
    if (input.leaseDurationMs <= 0 || !Number.isFinite(input.leaseDurationMs)) {
      throw new Error('leaseDurationMs must be positive')
    }
    const tx = this.db.transaction(() => {
      const existing = this.getWriterFence(input.mutationDomain)
      const requiredProtocol = Math.max(
        this.getMinimumWriterProtocol(),
        existing?.minimum_writer_protocol ?? AGENT_INTEGRATION_WRITER_PROTOCOL,
      )
      if (input.writerProtocol < requiredProtocol) {
        return { acquired: false as const, reason: 'protocol_too_old' as const }
      }
      if (existing && input.writerGeneration < existing.writer_generation) {
        return { acquired: false as const, reason: 'generation_too_old' as const, fence: existing }
      }
      if (existing?.state === 'active'
        && existing.owner_instance_id !== input.ownerInstanceId
        && (existing.lease_expires_at ?? 0) > input.nowMs) {
        return { acquired: false as const, reason: 'lease_held' as const, fence: existing }
      }
      const sameLiveOwner = existing?.state === 'active'
        && existing.owner_instance_id === input.ownerInstanceId
        && (existing.lease_expires_at ?? 0) > input.nowMs
      const epoch = sameLiveOwner ? existing.epoch : (existing?.epoch ?? 0) + 1
      const leaseExpiresAt = input.nowMs + input.leaseDurationMs
      this.db.prepare(`
        INSERT INTO writer_fences (
          mutation_domain, scope_mode, minimum_writer_protocol, writer_generation, owner_instance_id,
          epoch, lease_expires_at, state, metadata_json, created_at, updated_at
        ) VALUES (?, 'managed', ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(mutation_domain) DO UPDATE SET
          minimum_writer_protocol = excluded.minimum_writer_protocol,
          writer_generation = excluded.writer_generation,
          owner_instance_id = excluded.owner_instance_id,
          epoch = excluded.epoch,
          lease_expires_at = excluded.lease_expires_at,
          state = 'active',
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run(
        input.mutationDomain,
        requiredProtocol,
        input.writerGeneration,
        input.ownerInstanceId,
        epoch,
        leaseExpiresAt,
        json(input.metadata, {}),
        input.nowIso,
        input.nowIso,
      )
      return { acquired: true as const, fence: this.getWriterFence(input.mutationDomain)! }
    })
    return tx.immediate()
  }

  renewWriterFence(input: {
    mutationDomain: string
    writerProtocol: number
    ownerInstanceId: string
    epoch: number
    nowMs: number
    leaseDurationMs: number
    nowIso: string
  }): boolean {
    if (input.writerProtocol < this.getMinimumWriterProtocol()) return false
    const result = this.db.prepare(`
      UPDATE writer_fences
      SET lease_expires_at = ?, updated_at = ?
      WHERE mutation_domain = ?
        AND state = 'active'
        AND owner_instance_id = ?
        AND epoch = ?
        AND minimum_writer_protocol <= ?
        AND lease_expires_at > ?
    `).run(
      input.nowMs + input.leaseDurationMs,
      input.nowIso,
      input.mutationDomain,
      input.ownerInstanceId,
      input.epoch,
      input.writerProtocol,
      input.nowMs,
    )
    return result.changes === 1
  }

  releaseWriterFence(input: {
    mutationDomain: string
    ownerInstanceId: string
    epoch: number
    nowIso: string
  }): boolean {
    const result = this.db.prepare(`
      UPDATE writer_fences
      SET state = 'released', owner_instance_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE mutation_domain = ? AND state = 'active' AND owner_instance_id = ? AND epoch = ?
    `).run(input.nowIso, input.mutationDomain, input.ownerInstanceId, input.epoch)
    return result.changes === 1
  }

  beginMissingEpisode(input: {
    artifactId: string
    episodeId: string
    observedAt: string
    windowMs?: number
  }): { changed: boolean; eventCount: number; shouldAutoRestore: boolean; circuitBroken: boolean } {
    const windowMs = input.windowMs ?? 24 * 60 * 60 * 1000
    const observedAtMs = Date.parse(input.observedAt)
    if (!Number.isFinite(observedAtMs)) throw new Error(`invalid observedAt: ${input.observedAt}`)
    const tx = this.db.transaction(() => {
      const artifact = this.db.prepare(`
        SELECT state, missing_window_started_at, missing_event_count
        FROM managed_artifacts WHERE id = ?
      `).get(input.artifactId) as {
        state: ArtifactState
        missing_window_started_at: string | null
        missing_event_count: number
      } | undefined
      if (!artifact) throw new Error(`unknown artifact: ${input.artifactId}`)
      // 只有 healthy -> missing 的边沿产生 episode。重复 watcher/scan/retry 不计数，
      // 但同一 durable missing episode 仍可重试尚未完成的自动恢复。
      if (artifact.state !== 'healthy') {
        return {
          changed: false,
          eventCount: artifact.missing_event_count,
          shouldAutoRestore: artifact.state === 'missing'
            && artifact.missing_event_count === 1,
          circuitBroken: artifact.state === 'paused',
        }
      }
      const windowStartMs = artifact.missing_window_started_at
        ? Date.parse(artifact.missing_window_started_at)
        : Number.NaN
      const inWindow = Number.isFinite(windowStartMs)
        && observedAtMs >= windowStartMs
        && observedAtMs - windowStartMs < windowMs
      const eventCount = inWindow ? artifact.missing_event_count + 1 : 1
      const nextState: ArtifactState = eventCount >= 2 ? 'paused' : 'missing'
      const update = this.db.prepare(`
        UPDATE managed_artifacts
        SET state = ?, missing_episode_id = ?, missing_window_started_at = ?,
            missing_event_count = ?, paused_reason = ?, updated_at = ?
        WHERE id = ? AND state = 'healthy'
      `).run(
        nextState,
        input.episodeId,
        inWindow ? artifact.missing_window_started_at : input.observedAt,
        eventCount,
        nextState === 'paused' ? 'missing_circuit_breaker' : null,
        input.observedAt,
        input.artifactId,
      )
      if (update.changes !== 1) {
        return { changed: false, eventCount, shouldAutoRestore: false, circuitBroken: false }
      }
      this.db.prepare(`
        UPDATE installation_components
        SET verification_status = 'stale', updated_at = ?
        WHERE artifact_id = ? AND desired_state = 'managed'
      `).run(input.observedAt, input.artifactId)
      this.db.prepare(`
        UPDATE agent_installations
        SET verified_capability = 0, verification_summary = 'stale',
            reconcile_state = ?, status_reason = ?, updated_at = ?
        WHERE id IN (
          SELECT installation_id FROM artifact_consumers
          WHERE artifact_id = ? AND state = 'active' AND tombstoned_at IS NULL
        ) AND desired_state = 'managed'
      `).run(
        nextState === 'paused' ? 'paused' : 'needs_recovery',
        nextState === 'paused' ? 'circuit_breaker' : 'repairing',
        input.observedAt,
        input.artifactId,
      )
      this.recordEvent({
        artifactId: input.artifactId,
        kind: nextState === 'paused' ? 'artifact_missing_circuit_broken' : 'artifact_missing',
        severity: nextState === 'paused' ? 'warning' : 'info',
        episodeId: input.episodeId,
        payload: { eventCount, windowMs },
        createdAt: input.observedAt,
      })
      return {
        changed: true,
        eventCount,
        shouldAutoRestore: eventCount === 1,
        circuitBroken: nextState === 'paused',
      }
    })
    return tx.immediate()
  }

  markArtifactHealthyAfterReadback(artifactId: string, verifiedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE managed_artifacts
      SET state = 'healthy', missing_episode_id = NULL, paused_reason = NULL,
          last_verified_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('missing','needs_recovery')
    `).run(verifiedAt, verifiedAt, artifactId)
    return result.changes === 1
  }

  resetArtifactCircuit(artifactId: string, resetAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE managed_artifacts
      SET state = 'healthy', missing_window_started_at = NULL, missing_event_count = 0,
          paused_reason = NULL, user_reset_at = ?, updated_at = ?
      WHERE id = ? AND state = 'paused' AND paused_reason = 'missing_circuit_breaker'
    `).run(resetAt, resetAt, artifactId)
    return result.changes === 1
  }

  listResettableArtifactCircuitScope(installationId: string): Array<{
    artifactId: string
    installationId: string
    displayName: string
    hostVariant: CatalogId
    profileId: string
    componentKey: string
  }> {
    return this.db.prepare(`
      SELECT a.id AS artifactId, c.installation_id AS installationId,
             i.display_name AS displayName, i.host_variant AS hostVariant,
             i.profile_id AS profileId, c.component_key AS componentKey
      FROM managed_artifacts a
      JOIN artifact_consumers c ON c.artifact_id = a.id
      JOIN agent_installations i ON i.id = c.installation_id
      WHERE a.id IN (
        SELECT owned.artifact_id
        FROM artifact_consumers owned
        JOIN managed_artifacts target ON target.id = owned.artifact_id
        WHERE owned.installation_id = ?
          AND owned.state = 'active' AND owned.tombstoned_at IS NULL
          AND target.state = 'paused'
          AND target.paused_reason = 'missing_circuit_breaker'
      )
        AND c.state = 'active' AND c.tombstoned_at IS NULL
      ORDER BY a.id, c.installation_id, c.component_key
    `).all(installationId) as Array<{
      artifactId: string
      installationId: string
      displayName: string
      hostVariant: CatalogId
      profileId: string
      componentKey: string
    }>
  }

  resetInstallationArtifactCircuits(
    installationId: string,
    resetAt: string,
    expectedScope?: readonly {
      artifactId: string
      installationId: string
      displayName: string
      hostVariant: CatalogId
      profileId: string
      componentKey: string
    }[],
  ): number {
    return this.db.transaction(() => {
      const initiatingControl = this.db.prepare(`
        SELECT 1
        FROM agent_installations i
        WHERE i.id = ? AND i.desired_state = 'managed' AND i.tombstoned_at IS NULL
          AND i.health_state = 'discovered' AND i.status_reason = 'circuit_breaker'
          AND EXISTS (
            SELECT 1
            FROM artifact_consumers owned
            JOIN managed_artifacts a ON a.id = owned.artifact_id
            JOIN agent_consents consent ON consent.id = owned.consent_envelope_id
            WHERE owned.installation_id = i.id
              AND owned.state = 'active' AND owned.desired_state = 'managed'
              AND owned.tombstoned_at IS NULL
              AND consent.status = 'active'
              AND a.state = 'paused' AND a.paused_reason = 'missing_circuit_breaker'
          )
      `).get(installationId)
      if (!initiatingControl) {
        throw new Error('auto-repair reset control state changed after confirmation')
      }
      if (expectedScope) {
        const currentScope = this.listResettableArtifactCircuitScope(installationId)
        if (JSON.stringify(currentScope) !== JSON.stringify(expectedScope)) {
          throw new Error('auto-repair reset scope changed after confirmation')
        }
      }
      const artifacts = this.db.prepare(`
        SELECT DISTINCT a.id
        FROM managed_artifacts a
        JOIN artifact_consumers c ON c.artifact_id = a.id
        WHERE c.installation_id = ? AND c.state = 'active' AND c.tombstoned_at IS NULL
          AND a.state = 'paused' AND a.paused_reason = 'missing_circuit_breaker'
      `).all(installationId) as Array<{ id: string }>
      const affectedInstallations = artifacts.length === 0
        ? []
        : this.db.prepare(`
            SELECT DISTINCT c.installation_id AS id
            FROM artifact_consumers c
            WHERE c.artifact_id IN (${artifacts.map(() => '?').join(',')})
              AND c.state = 'active' AND c.tombstoned_at IS NULL
          `).all(...artifacts.map(artifact => artifact.id)) as Array<{ id: string }>
      let resetCount = 0
      for (const artifact of artifacts) {
        if (this.resetArtifactCircuit(artifact.id, resetAt)) resetCount += 1
      }
      if (resetCount > 0) {
        for (const affected of affectedInstallations) {
          this.db.prepare(`
            UPDATE agent_installations
            SET reconcile_state = 'idle', status_reason = 'verification_stale', updated_at = ?
            WHERE id = ? AND desired_state = 'managed'
              AND health_state = 'discovered'
              AND status_reason = 'circuit_breaker'
          `).run(resetAt, affected.id)
          this.recordEvent({
            installationId: affected.id,
            kind: 'auto_repair_circuit_reset',
            severity: 'info',
            dedupeKey: `${affected.id}:circuit-reset:${resetAt}`,
            payload: { resetCount, initiatedByInstallationId: installationId },
            createdAt: resetAt,
          })
        }
      }
      return resetCount
    }).immediate()
  }

  prepareSharedArtifactRemoval(input: {
    artifactId: string
    consumers: Array<{ installationId: string; componentKey: string }>
    removePhysicalArtifact: boolean
    tombstoneReason: string
    consentEnvelopeId: string
    run: ReconcileRunInput
    mutations: ProjectionMutationInput[]
    preparedAt: string
  }): void {
    if (input.consumers.length === 0) throw new Error('at least one consumer is required')
    if (input.mutations.length === 0) {
      throw new Error('disconnect requires at least one journaled mutation')
    }
    if (input.run.consentEnvelopeId !== input.consentEnvelopeId) {
      throw new Error('disconnect run and removal intent must reference the same consent envelope')
    }
    const keys = new Set(input.consumers.map(c => `${c.installationId}\0${c.componentKey}`))
    if (keys.size !== input.consumers.length) throw new Error('duplicate consumer in removal plan')
    const tx = this.db.transaction(() => {
      const liveConsumers = this.db.prepare(`
        SELECT installation_id, component_key
        FROM artifact_consumers
        WHERE artifact_id = ? AND state != 'removed'
      `).all(input.artifactId) as Array<{ installation_id: string; component_key: string }>
      for (const consumer of input.consumers) {
        const liveConsumer = liveConsumers.find(row =>
          row.installation_id === consumer.installationId && row.component_key === consumer.componentKey)
        if (!liveConsumer) {
          throw new Error(`consumer is not active for Artifact: ${consumer.installationId}/${consumer.componentKey}`)
        }
      }
      if (!input.removePhysicalArtifact) {
        const visibility = this.db.prepare(`
          SELECT installation_id, component_key, discover_reachability, component_exception
          FROM artifact_consumers
          WHERE artifact_id = ? AND state != 'removed'
        `).all(input.artifactId) as Array<{
          installation_id: string
          component_key: string
          discover_reachability: string
          component_exception: string | null
        }>
        for (const consumer of input.consumers) {
          const row = visibility.find(candidate =>
            candidate.installation_id === consumer.installationId
              && candidate.component_key === consumer.componentKey)!
          if (row.discover_reachability !== 'per_host_ignorable' || !row.component_exception) {
            throw new Error('partial shared Artifact removal lacks selective-hide evidence')
          }
        }
      }
      if (input.removePhysicalArtifact) {
        const uncovered = liveConsumers.filter(row =>
          !keys.has(`${row.installation_id}\0${row.component_key}`))
        if (uncovered.length > 0) {
          throw new Error('physical Artifact removal plan does not include every live consumer')
        }
      }
      this.insertReconcileRun(input.run)
      for (const mutation of input.mutations) {
        if (mutation.runId !== input.run.id || mutation.artifactId !== input.artifactId) {
          throw new Error('disconnect mutation must belong to the immutable run and Artifact')
        }
        this.insertProjectionMutation(mutation)
      }
      for (const consumer of input.consumers) {
        this.db.prepare(`
          UPDATE artifact_consumers
          SET desired_state = 'removal_pending', state = 'removal_pending',
              tombstoned_at = COALESCE(tombstoned_at, ?), tombstone_reason = ?,
              consent_envelope_id = ?, updated_at = ?
          WHERE artifact_id = ? AND installation_id = ? AND component_key = ?
        `).run(
          input.preparedAt,
          input.tombstoneReason,
          input.consentEnvelopeId,
          input.preparedAt,
          input.artifactId,
          consumer.installationId,
          consumer.componentKey,
        )
        this.db.prepare(`
          UPDATE installation_components
          SET desired_state = 'removed', tombstoned_at = COALESCE(tombstoned_at, ?),
              tombstone_reason = ?, consent_envelope_id = ?, updated_at = ?
          WHERE installation_id = ? AND component_key = ?
        `).run(
          input.preparedAt,
          input.tombstoneReason,
          input.consentEnvelopeId,
          input.preparedAt,
          consumer.installationId,
          consumer.componentKey,
        )
      }
      if (input.removePhysicalArtifact) {
        this.db.prepare(`
          UPDATE managed_artifacts SET state = 'removal_pending', updated_at = ? WHERE id = ?
        `).run(input.preparedAt, input.artifactId)
      }
    })
    tx.immediate()
  }
}

const FEED_RUNNING_RUN_STATES = new Set([
  'planned', 'preconditions_checked', 'applying', 'verified', 'compensating',
])

function applyTaskFeedRunPriority(run: ApplyTaskRunRow): number {
  if (FEED_RUNNING_RUN_STATES.has(run.state)) return 0
  if (run.state === 'applied_unverified') return 2
  return run.state === 'committed' ? 3 : 1
}

function applyTaskFeedItemPriority(
  fact: ApplyTaskFeedItemFact,
  overlay: ApplyTaskRunRow | null,
): number {
  if (overlay) return applyTaskFeedRunPriority(overlay)
  if (fact.exact_run_correlation === 1 && fact.run_id && fact.run_state) {
    if ((fact.state === 'terminal' || fact.state === 'interrupted')
      && ((fact.payload_installation_id !== null
        && fact.payload_installation_id !== fact.installation_id)
        || (fact.payload_run_id !== null && fact.payload_run_id !== fact.run_id)
        || ((fact.payload_status === 'committed'
          || fact.payload_status === 'awaiting_verification'
          || fact.payload_status === 'needs_recovery')
          && (fact.payload_installation_id !== fact.installation_id
            || fact.payload_run_id !== fact.run_id)))) return 1
    return applyTaskFeedRunPriority({
      id: fact.run_id,
      installation_id: fact.installation_id,
      execution_plan_hash: '',
      state: fact.run_state,
      failure_code: null,
      created_at: '',
      started_at: null,
      completed_at: null,
      updated_at: '',
    })
  }
  if (fact.state === 'pending' || fact.state === 'running') return 0
  if (!fact.payload_status) return 1
  if (fact.payload_installation_id && fact.payload_installation_id !== fact.installation_id) return 1
  // Any run-bearing outcome without the exact FK is an interrupted authority
  // record, even if its untrusted JSON claims success.
  if (fact.payload_run_id
    || fact.payload_status === 'committed'
    || fact.payload_status === 'awaiting_verification'
    || fact.payload_status === 'needs_recovery') return 1
  return 1
}

function applyTaskFeedRunNeedsPresentation(run: ApplyTaskRunRow, nowMs: number): boolean {
  if (applyTaskFeedRunPriority(run) < 3) return true
  const activityMs = Date.parse(run.completed_at ?? run.updated_at)
  return Number.isFinite(activityMs) && nowMs - activityMs <= 24 * 60 * 60 * 1_000
}

function compareApplyTaskFeedRefs(left: ApplyTaskFeedRef, right: ApplyTaskFeedRef): number {
  return left.priority - right.priority
    || right.startedAt.localeCompare(left.startedAt)
    || left.source.localeCompare(right.source)
    || right.stableId.localeCompare(left.stableId)
}

function compareRefToCursor(ref: ApplyTaskFeedRef, cursor: ApplyTaskFeedCursorPayload): number {
  return compareApplyTaskFeedRefs(ref, {
    key: `${cursor.source}:${cursor.stableId}` as ApplyTaskFeedRef['key'],
    source: cursor.source,
    stableId: cursor.stableId,
    priority: cursor.priority,
    startedAt: cursor.startedAt,
    overlayRunIds: [],
    ambiguousLegacy: false,
  })
}

function encodeApplyTaskFeedCursor(
  revision: string,
  snapshotAtMs: number,
  direction: 'next' | 'previous',
  ref: ApplyTaskFeedRef,
): string {
  const payload: ApplyTaskFeedCursorPayload = {
    version: 1,
    revision,
    snapshotAtMs,
    direction,
    priority: ref.priority,
    startedAt: ref.startedAt,
    source: ref.source,
    stableId: ref.stableId,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeApplyTaskFeedCursor(raw: string): ApplyTaskFeedCursorPayload {
  if (raw.length === 0 || raw.length > 512) throw new Error('invalid_task_feed_cursor')
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>
    const keys = Object.keys(parsed).sort().join(',')
    if (keys !== 'direction,priority,revision,snapshotAtMs,source,stableId,startedAt,version'
      || parsed.version !== 1
      || (parsed.direction !== 'next' && parsed.direction !== 'previous')
      || typeof parsed.revision !== 'string' || !/^\d+$/u.test(parsed.revision)
      || !Number.isSafeInteger(parsed.snapshotAtMs) || (parsed.snapshotAtMs as number) < 0
      || typeof parsed.priority !== 'number' || !Number.isInteger(parsed.priority)
      || parsed.priority < 0 || parsed.priority > 3
      || typeof parsed.startedAt !== 'string' || parsed.startedAt.length === 0 || parsed.startedAt.length > 64
      || (parsed.source !== 'task' && parsed.source !== 'run')
      || typeof parsed.stableId !== 'string' || parsed.stableId.length === 0 || parsed.stableId.length > 128) {
      throw new Error('invalid')
    }
    return parsed as unknown as ApplyTaskFeedCursorPayload
  } catch {
    throw new Error('invalid_task_feed_cursor')
  }
}
