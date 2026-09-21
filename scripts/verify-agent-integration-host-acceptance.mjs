#!/usr/bin/env node
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSourceAgentIntegrationReleaseContract } from './agent-integration-release-contract.mjs'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'

export const AGENT_HOST_ACCEPTANCE_SCHEMA_VERSION = 3
export const DEFAULT_AGENT_HOST_ACCEPTANCE_REQUIREMENTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'agent-integration-host-acceptance-requirements.json',
)
export const DEFAULT_AGENT_INTEGRATION_RELEASE_MANIFEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../client/electron/agent-integration/release-manifest.ts',
)

const SHA256 = /^[a-f0-9]{64}$/u
const SOURCE_COMMIT = /^[a-f0-9]{40,64}$/u
const MAX_INDEX_BYTES = 2 * 1024 * 1024
const MAX_EVIDENCE_FILES = 2048
const MAX_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_EVIDENCE_BYTES = 100 * 1024 * 1024

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export function hostActivityLedgerEvidenceHash(receipt) {
  return sha256Bytes(Buffer.from(JSON.stringify([
    receipt.installationId,
    receipt.agentId,
    receipt.hostVariant,
    receipt.componentKey,
    receipt.signalName,
    receipt.tideMindVersion,
    receipt.adapterVersion,
    receipt.projectionVersion,
    receipt.hostVersion,
    receipt.observedAt,
  ])))
}

export function hostActivityLedgerExportHash(receipt) {
  return sha256Bytes(Buffer.from(JSON.stringify({
    exporterVersion: receipt.exporterVersion,
    ledgerSource: receipt.ledgerSource,
    captureNonce: receipt.captureNonce,
    targetKey: receipt.targetKey,
    candidateBundleSha256: receipt.candidateBundleSha256,
    sourceCommit: receipt.sourceCommit,
    releaseContractSha256: receipt.releaseContractSha256,
    databaseSchemaVersion: receipt.databaseSchemaVersion,
    databaseSchemaSha256: receipt.databaseSchemaSha256,
    id: receipt.id,
    installationId: receipt.installationId,
    agentId: receipt.agentId,
    hostVariant: receipt.hostVariant,
    componentKey: receipt.componentKey,
    signalName: receipt.signalName,
    tideMindVersion: receipt.tideMindVersion,
    adapterVersion: receipt.adapterVersion,
    projectionVersion: receipt.projectionVersion,
    hostVersion: receipt.hostVersion,
    evidenceHash: receipt.evidenceHash,
    observedAt: receipt.observedAt,
  })))
}

export function hostAcceptanceTargetIdentityDigest(target) {
  return sha256Bytes(Buffer.from(JSON.stringify([
    target.targetKey,
    target.targetId,
    target.hostVersion,
    target.distribution.distributionId,
    target.distribution.packageProvenance,
    target.distribution.executableSha256,
    target.distribution.rawExecutableSha256,
    target.distribution.rawExecutableSizeBytes,
    target.distribution.distributionSha256,
    target.environment.platform,
    target.environment.architecture,
    target.environment.processArchitecture,
    target.environment.hardwareArchitecture,
    target.environment.translationMode,
    target.environment.osVersion,
    target.environment.hostIdentitySha256,
  ])))
}

export function hostAcceptanceTargetMetadataExportHash(receipt) {
  return sha256Bytes(Buffer.from(JSON.stringify({
    exporterVersion: receipt.exporterVersion,
    evidenceClass: receipt.evidenceClass,
    candidateBundleSha256: receipt.candidateBundleSha256,
    sourceCommit: receipt.sourceCommit,
    releaseContractSha256: receipt.releaseContractSha256,
    targetMetadata: receipt.targetMetadata,
    exportedAt: receipt.exportedAt,
  })))
}

export function hostAcceptanceStepOutcomeDigest({
  targetKey,
  targetId,
  stepId,
  status,
  observedAt,
  assertionSource,
  assertedBy,
  assertions,
  installationId,
  agentId,
  sourceCommit,
  releaseContractSha256,
  candidateBundleSha256,
  activityEvidenceHash,
  evidenceIds,
}) {
  return sha256Bytes(Buffer.from(JSON.stringify({
    targetKey,
    targetId,
    stepId,
    status,
    observedAt,
    assertionSource,
    assertedBy,
    assertions,
    installationId,
    agentId,
    sourceCommit,
    releaseContractSha256,
    candidateBundleSha256,
    activityEvidenceHash,
    evidenceIds,
  })))
}

export function hostAcceptanceUpgradeOutcomeDigest({
  targetKey,
  targetId,
  fromAppVersion,
  toAppVersion,
  status,
  observedAt,
  assertionSource,
  assertedBy,
  assertions,
  installationId,
  originalAgentId,
  migratedAgentId,
  historyPreserved,
  statisticsPreserved,
  sourceCommit,
  releaseContractSha256,
  candidateBundleSha256,
  targetIdentitySha256,
  evidenceIds,
}) {
  return sha256Bytes(Buffer.from(JSON.stringify({
    targetKey,
    targetId,
    fromAppVersion,
    toAppVersion,
    status,
    observedAt,
    assertionSource,
    assertedBy,
    assertions,
    installationId,
    originalAgentId,
    migratedAgentId,
    historyPreserved,
    statisticsPreserved,
    sourceCommit,
    releaseContractSha256,
    candidateBundleSha256,
    targetIdentitySha256,
    evidenceIds,
  })))
}

function readJsonFile(file, maxBytes = MAX_INDEX_BYTES) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`acceptance requires a regular file: ${file}`)
  if (stat.size <= 0 || stat.size > maxBytes) throw new Error(`acceptance file size is invalid: ${file}`)
  const bytes = fs.readFileSync(file)
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes }
  } catch {
    throw new Error(`acceptance JSON is invalid: ${file}`)
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0) throw new Error(`${label} has unknown fields: ${extras.join(',')}`)
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty normalized string`)
  }
  return value
}

function isoTimestamp(value, label) {
  nonEmptyString(value, label)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`)
  }
  return timestamp
}

function safeRelativeFile(value, label) {
  nonEmptyString(value, label)
  if (value.includes('\\') || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === '.' || value.startsWith('../') || value.includes('/../')) {
    throw new Error(`${label} must be a normalized relative path`)
  }
  return value
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`)
}

export function loadAgentHostAcceptanceRequirements(
  requirementsPath = DEFAULT_AGENT_HOST_ACCEPTANCE_REQUIREMENTS,
  releaseManifestPath = DEFAULT_AGENT_INTEGRATION_RELEASE_MANIFEST,
) {
  const absolute = path.resolve(requirementsPath)
  const { value, bytes } = readJsonFile(absolute)
  const requirements = record(value, 'acceptance requirements')
  exactKeys(requirements, [
    'schemaVersion', 'appVersion', 'releaseMacArchitectures', 'upgradeFromAppVersions', 'stepPolicy', 'customPaths', 'customGuidedTargets',
  ], 'acceptance requirements')
  if (requirements.schemaVersion !== AGENT_HOST_ACCEPTANCE_SCHEMA_VERSION) {
    throw new Error(`unsupported acceptance requirements schema: ${String(requirements.schemaVersion)}`)
  }
  nonEmptyString(requirements.appVersion, 'requirements appVersion')
  if (!Array.isArray(requirements.releaseMacArchitectures)
    || requirements.releaseMacArchitectures.length === 0
    || requirements.releaseMacArchitectures.some(architecture => !['arm64', 'x64'].includes(architecture))) {
    throw new Error('requirements releaseMacArchitectures must contain supported Mac architectures')
  }
  unique(requirements.releaseMacArchitectures, 'requirements releaseMacArchitectures')
  const releaseMacArchitectures = Object.freeze([...requirements.releaseMacArchitectures].sort())
  if (!Array.isArray(requirements.upgradeFromAppVersions)
    || requirements.upgradeFromAppVersions.length < 1) {
    throw new Error('requirements upgradeFromAppVersions must be a non-empty array')
  }
  requirements.upgradeFromAppVersions.forEach((version, index) => (
    nonEmptyString(version, `requirements upgrade source version ${index}`)
  ))
  unique(requirements.upgradeFromAppVersions, 'requirements upgrade source versions')
  const rawStepPolicy = record(requirements.stepPolicy, 'requirements stepPolicy')
  exactKeys(rawStepPolicy, ['base', 'byComponent', 'byDisposition', 'byCatalog'], 'requirements stepPolicy')
  const validateSteps = (raw, label, allowEmpty = false) => {
    if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0)) throw new Error(`${label} must be an array`)
    raw.forEach((step, index) => nonEmptyString(step, `${label} step ${index}`))
    unique(raw, label)
    return Object.freeze([...raw])
  }
  const rawByComponent = record(rawStepPolicy.byComponent, 'requirements byComponent')
  exactKeys(rawByComponent, ['instruction', 'memory_tools', 'lifecycle'], 'requirements byComponent')
  const rawByDisposition = record(rawStepPolicy.byDisposition, 'requirements byDisposition')
  exactKeys(rawByDisposition, ['managed', 'guided', 'migration'], 'requirements byDisposition')
  const rawByCatalog = record(rawStepPolicy.byCatalog, 'requirements byCatalog')
  const stepPolicy = Object.freeze({
    base: validateSteps(rawStepPolicy.base, 'requirements base steps'),
    byComponent: Object.freeze({
      instruction: validateSteps(rawByComponent.instruction, 'requirements instruction steps'),
      memory_tools: validateSteps(rawByComponent.memory_tools, 'requirements memory steps'),
      // Lifecycle acceptance is derived from each release entry's exact
      // requiredLifecycle.signals contract below. A generic lifecycle step
      // must never stand in for one or more promised host events.
      lifecycle: validateSteps(rawByComponent.lifecycle, 'requirements lifecycle steps', true),
    }),
    byDisposition: Object.freeze({
      managed: validateSteps(rawByDisposition.managed, 'requirements managed steps', true),
      guided: validateSteps(rawByDisposition.guided, 'requirements guided steps', true),
      migration: validateSteps(rawByDisposition.migration, 'requirements migration steps', true),
    }),
    byCatalog: Object.freeze(Object.fromEntries(Object.entries(rawByCatalog).map(([catalogId, steps]) => {
      nonEmptyString(catalogId, 'requirements catalog ID')
      return [catalogId, validateSteps(steps, `requirements ${catalogId} steps`, true)]
    }))),
  })
  const releaseManifestAbsolute = path.resolve(releaseManifestPath)
  const releaseSource = fs.readFileSync(releaseManifestAbsolute, 'utf8')
  const releaseContract = parseSourceAgentIntegrationReleaseContract(releaseSource)
  if (releaseContract.version !== requirements.appVersion) {
    throw new Error('acceptance requirements app version differs from release manifest')
  }
  const entries = Object.freeze(releaseContract.entries
    .filter(entry => entry.enabledByDefault && entry.disposition !== 'observe_only')
    .map(entry => Object.freeze({ ...entry, requiredComponents: Object.freeze([...entry.requiredComponents]) })))
  const enabledCatalogIds = new Set(entries.map(entry => entry.catalogId))
  for (const catalogId of Object.keys(stepPolicy.byCatalog)) {
    if (!enabledCatalogIds.has(catalogId)) throw new Error(`requirements catalog steps target is not enabled: ${catalogId}`)
  }
  const targets = Object.freeze(entries.flatMap(entry => (
    entry.officialDistributions.flatMap(distribution => (
      distribution.supportedMacArchitectures.filter(architecture => releaseMacArchitectures.includes(architecture)).map(architecture => Object.freeze({
        ...entry,
        // A catalog may expose more than one independently installed topology
        // (for example OpenClaw portable and global npm). Each one needs its
        // own lifecycle, restart and upgrade evidence; catalog+arch alone
        // would silently allow the second distribution to borrow the first.
        targetKey: `${entry.catalogId}:${architecture}:${encodeURIComponent(distribution.distributionId)}`,
        architecture,
        officialDistributions: Object.freeze([distribution]),
        acceptedDistributionArtifacts: Object.freeze(entry.acceptedDistributionArtifacts
          .filter(receipt => receipt.architecture === architecture
            && receipt.distributionId === distribution.distributionId
            && receipt.packageProvenance === distribution.packageProvenance)),
      }))
    ))
  )))
  const releaseContractSha256 = sha256Bytes(Buffer.from(JSON.stringify(releaseContract)))
  if (!Array.isArray(requirements.customPaths) || requirements.customPaths.length !== 2) {
    throw new Error('requirements must declare exactly two Custom paths')
  }
  requirements.customPaths.forEach((mode, index) => nonEmptyString(mode, `requirements Custom path ${index}`))
  unique(requirements.customPaths, 'requirements Custom paths')
  const schemas = ['standard_mcp_servers', 'nested_mcp_servers', 'opencode_mcp']
  if (!Array.isArray(requirements.customGuidedTargets) || requirements.customGuidedTargets.length !== schemas.length) {
    throw new Error('requirements must declare all three user-owned Custom schemas')
  }
  const guidedTargets = requirements.customGuidedTargets.map(raw => {
    const target = record(raw, 'requirements user-owned Custom target')
    exactKeys(target, ['schemaKind', 'selectorKey'], 'requirements user-owned Custom target')
    if (!schemas.includes(target.schemaKind) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(target.selectorKey ?? '')
      || ['__proto__','prototype','constructor'].includes(target.selectorKey)) throw new Error('requirements Custom schema/selector invalid')
    return Object.freeze({ targetKey: `manual_mcp_client:${target.schemaKind}:${target.selectorKey}`,
      targetId: 'manual_mcp_client', configurationOwnership: 'user', schemaKind: target.schemaKind, selectorKey: target.selectorKey })
  })
  unique(guidedTargets.map(target => target.schemaKind), 'requirements Custom schemas')
  const customTargets = [...requirements.customPaths.map(mode => ({ targetKey: mode, targetId: mode })), ...guidedTargets]
  return Object.freeze({
    schemaVersion: requirements.schemaVersion,
    appVersion: requirements.appVersion,
    releaseMacArchitectures,
    upgradeFromAppVersions: Object.freeze([...requirements.upgradeFromAppVersions]),
    stepPolicy,
    entries: Object.freeze(entries),
    targets,
    customPaths: Object.freeze([...requirements.customPaths]),
    customTargets: Object.freeze(customTargets),
    sha256: sha256Bytes(bytes),
    path: absolute,
    releaseManifestPath: releaseManifestAbsolute,
    releaseContractSha256,
  })
}

export function requiredHostAcceptanceSteps(requirements, target) {
  if (target.targetId === 'manual_mcp_client' && target.configurationOwnership === 'user') {
    return Object.freeze(['official_host_version', 'distribution_identity', 'connect', 'brain_recall', 'brain_digest',
      'scan_persistence', 'restart_persistence', 'pause_resume', 'disconnect'])
  }
  const requiresLifecycle = target.requiredComponents.includes('lifecycle')
  const lifecycle = target.requiredLifecycle
  if (requiresLifecycle && (!lifecycle || lifecycle.require !== 'all'
    || !Array.isArray(lifecycle.signals) || lifecycle.signals.length === 0)) {
    throw new Error(`required lifecycle contract is missing for ${target.targetId ?? target.catalogId}`)
  }
  if (!requiresLifecycle && lifecycle !== null && lifecycle !== undefined) {
    throw new Error(`unexpected lifecycle contract for ${target.targetId ?? target.catalogId}`)
  }
  const lifecycleSteps = requiresLifecycle
    ? lifecycle.signals.map(signal => {
        nonEmptyString(signal, `required lifecycle signal for ${target.targetId ?? target.catalogId}`)
        return `lifecycle_${signal}`
      })
    : []
  unique(lifecycleSteps, `required lifecycle signals for ${target.targetId ?? target.catalogId}`)
  const steps = [
    ...(target.disposition === 'migration' ? [] : requirements.stepPolicy.base.filter(step => (
      !(target.targetId === 'manual_mcp_client' && target.configurationOwnership === 'user' && step === 'read_back')
    ))),
    ...target.requiredComponents.flatMap(component => requirements.stepPolicy.byComponent[component] ?? []),
    ...(requirements.stepPolicy.byCatalog[target.catalogId] ?? []),
    ...lifecycleSteps,
    ...requirements.stepPolicy.byDisposition[target.policyDisposition ?? target.disposition],
  ]
  unique(steps, `required steps for ${target.targetId ?? target.catalogId}`)
  return Object.freeze(steps)
}

export function distributionArtifactReceiptSha256(receipt) {
  return sha256Bytes(Buffer.from(JSON.stringify(receipt)))
}

function validateDistribution(raw, label, acceptedDistributions, acceptedArtifacts, hostVersion, architecture, allowMissingReceipt = false) {
  const distribution = record(raw, `${label} distribution`)
  exactKeys(distribution, [
    'distributionId', 'packageProvenance', 'artifactReceiptSha256', 'portableArtifactFingerprint',
    'executableSha256', 'executableSizeBytes', 'distributionSha256', 'distributionSizeBytes',
    'rawExecutableSha256', 'rawExecutableSizeBytes',
  ], `${label} distribution`)
  nonEmptyString(distribution.distributionId, `${label} distributionId`)
  nonEmptyString(distribution.packageProvenance, `${label} packageProvenance`)
  if (!SHA256.test(distribution.executableSha256 ?? '')) throw new Error(`${label} executable SHA-256 is invalid`)
  if (!SHA256.test(distribution.rawExecutableSha256 ?? '')
    || !Number.isSafeInteger(distribution.rawExecutableSizeBytes) || distribution.rawExecutableSizeBytes <= 0) {
    throw new Error(`${label} raw executable identity is invalid`)
  }
  if (!SHA256.test(distribution.distributionSha256 ?? '')) throw new Error(`${label} distribution SHA-256 is invalid`)
  if (!allowMissingReceipt && !SHA256.test(distribution.artifactReceiptSha256 ?? '')) {
    throw new Error(`${label} artifact receipt SHA-256 is invalid`)
  }
  if (!allowMissingReceipt) nonEmptyString(distribution.portableArtifactFingerprint, `${label} portable artifact fingerprint`)
  if (allowMissingReceipt
    && distribution.artifactReceiptSha256 !== null && !SHA256.test(distribution.artifactReceiptSha256 ?? '')) {
    throw new Error(`${label} artifact receipt SHA-256 is invalid`)
  }
  if (allowMissingReceipt
    && distribution.portableArtifactFingerprint !== null
    && (typeof distribution.portableArtifactFingerprint !== 'string' || distribution.portableArtifactFingerprint.length === 0)) {
    throw new Error(`${label} portable artifact fingerprint is invalid`)
  }
  if (!Number.isSafeInteger(distribution.executableSizeBytes) || distribution.executableSizeBytes <= 0
    || !Number.isSafeInteger(distribution.distributionSizeBytes) || distribution.distributionSizeBytes <= 0) {
    throw new Error(`${label} distribution sizes are invalid`)
  }
  if (acceptedDistributions.length > 0 && !acceptedDistributions.some(candidate => (
    candidate.distributionId === distribution.distributionId
    && candidate.packageProvenance === distribution.packageProvenance
  ))) {
    throw new Error(`${label} distribution is not accepted by the frozen release contract`)
  }
  const receipt = acceptedArtifacts.find(candidate => (
    candidate.distributionId === distribution.distributionId
    && candidate.packageProvenance === distribution.packageProvenance
    && candidate.version === hostVersion
    && candidate.architecture === architecture
  ))
  if (!receipt) {
    if (allowMissingReceipt) {
      if (distribution.rawExecutableSha256 !== distribution.executableSha256
        || distribution.rawExecutableSizeBytes !== distribution.executableSizeBytes) {
        throw new Error(`${label} raw executable differs from its distribution executable`)
      }
      return
    }
    throw new Error(`${label} has no immutable artifact receipt in the frozen release contract`)
  }
  if (!['qwen-standalone-surface-v1', 'openclaw-official-wrapper-v1'].includes(receipt.portableFingerprintSchema)
    && (distribution.rawExecutableSha256 !== distribution.executableSha256
      || distribution.rawExecutableSizeBytes !== distribution.executableSizeBytes)) {
    throw new Error(`${label} raw executable differs from its distribution executable`)
  }
  if (distribution.artifactReceiptSha256 !== distributionArtifactReceiptSha256(receipt)
    || distribution.portableArtifactFingerprint !== receipt.portableArtifactFingerprint
    || distribution.executableSha256 !== receipt.executableSha256
    || distribution.executableSizeBytes !== receipt.executableSizeBytes
    || distribution.distributionSha256 !== receipt.distributionSha256
    || distribution.distributionSizeBytes !== receipt.distributionSizeBytes) {
    throw new Error(`${label} physical installation proof does not match its immutable artifact receipt`)
  }
}

export function validateAgentHostAcceptanceEnvironment(raw, label) {
  const environment = record(raw, `${label} environment`)
  exactKeys(environment, [
    'platform', 'architecture', 'processArchitecture', 'hardwareArchitecture', 'translationMode',
    'osVersion', 'hostIdentitySha256',
  ], `${label} environment`)
  if (environment.platform !== 'darwin') throw new Error(`${label} was not captured on macOS`)
  if (!['arm64', 'x64'].includes(environment.architecture)) throw new Error(`${label} architecture is invalid`)
  if (!['arm64', 'x64'].includes(environment.processArchitecture)) {
    throw new Error(`${label} process architecture is invalid`)
  }
  if (!['arm64', 'x86_64'].includes(environment.hardwareArchitecture)) {
    throw new Error(`${label} hardware architecture is invalid`)
  }
  if (!['not_translated', 'rosetta'].includes(environment.translationMode)) {
    throw new Error(`${label} translation mode is invalid`)
  }
  if (environment.architecture !== environment.processArchitecture) {
    throw new Error(`${label} target and process architectures differ`)
  }
  const nativeArm64 = environment.processArchitecture === 'arm64'
    && environment.hardwareArchitecture === 'arm64'
    && environment.translationMode === 'not_translated'
  const nativeX64 = environment.processArchitecture === 'x64'
    && environment.hardwareArchitecture === 'x86_64'
    && environment.translationMode === 'not_translated'
  if (!nativeArm64 && !nativeX64) {
    throw new Error(`${label} requires native hardware; Rosetta is compatibility preflight only`)
  }
  nonEmptyString(environment.osVersion, `${label} OS version`)
  if (!SHA256.test(environment.hostIdentitySha256 ?? '')) throw new Error(`${label} host identity SHA-256 is invalid`)
}

export function validateUserOwnedCustomActivityBinding(raw, expected, label = 'user-owned Custom activity') {
  const value = record(raw, label)
  exactKeys(value, ['installationId', 'agentId', 'activationRunId', 'generationSha256',
    'connectorConfigurationSha256', 'runtimeBindingSha256', 'tideMindVersion', 'adapterVersion',
    'projectionVersion', 'hostVersion', 'schemaKind', 'selectorKey', 'evidence'], label)
  for (const key of ['installationId', 'agentId', 'activationRunId', 'tideMindVersion', 'adapterVersion', 'projectionVersion', 'hostVersion']) {
    nonEmptyString(value[key], `${label} ${key}`)
    if (expected[key] !== undefined && value[key] !== expected[key]) throw new Error(`${label} ${key} mismatch`)
  }
  for (const key of ['generationSha256', 'connectorConfigurationSha256', 'runtimeBindingSha256']) {
    if (!SHA256.test(value[key] ?? '')) throw new Error(`${label} ${key} is invalid`)
  }
  if (!['standard_mcp_servers','nested_mcp_servers','opencode_mcp'].includes(value.schemaKind)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value.selectorKey ?? '')
    || ['__proto__','prototype','constructor'].includes(value.selectorKey)) throw new Error(`${label} schema/selector invalid`)
  const targetKey = `manual_mcp_client:${value.schemaKind}:${value.selectorKey}`
  if (expected.targetKey !== undefined && expected.targetKey !== targetKey) throw new Error(`${label} schema/selector targetKey mismatch`)
  if (!Array.isArray(value.evidence) || value.evidence.length !== 2) throw new Error(`${label} requires recall and digest`)
  const signals = new Set(), ids = new Set()
  for (const event of value.evidence) {
    exactKeys(record(event, label), ['id', 'signalName', 'evidenceHash', 'observedAt'], label)
    if (!/^aha_[a-f0-9]{24}$/u.test(event.id ?? '') || !SHA256.test(event.evidenceHash ?? '')
      || !['brain_recall', 'brain_digest'].includes(event.signalName)) throw new Error(`${label} event is invalid`)
    const observed = isoTimestamp(event.observedAt, `${label} observedAt`)
    if (expected.exportedAt !== undefined && observed > expected.exportedAt) throw new Error(`${label} event occurs after export`)
    signals.add(event.signalName); ids.add(event.id)
  }
  if (signals.size !== 2 || ids.size !== 2) throw new Error(`${label} requires distinct recall and digest`)
  return value
}

function validateCustomBinding(raw, mode, sourceCatalogId, label, expected = {}) {
  if (mode !== 'nonstandard_config_root' && mode !== 'manual_mcp_client') {
    if (raw !== null) throw new Error(`${label} non-Custom target has a Custom binding`)
    return
  }
  const value = record(raw, `${label} Custom binding`)
  exactKeys(value, [
    'kind', 'sourceInstallationId', 'sourceCatalogId', 'configRootIdentitySha256',
    'configFileIdentitySha256', 'selectorIdentitySha256', 'executableFingerprint',
    'sourceLiveTrustProofSha256', 'liveTrustProofSha256', 'readBackProofSha256',
    ...(value.configurationOwnership === 'user' ? ['configurationOwnership', 'activityBinding'] : []),
  ], `${label} Custom binding`)
  if (value.kind !== mode) throw new Error(`${label} Custom binding mode mismatch`)
  for (const key of ['configRootIdentitySha256', 'selectorIdentitySha256', 'liveTrustProofSha256']) {
    if (!SHA256.test(value[key] ?? '')) throw new Error(`${label} Custom binding ${key} is invalid`)
  }
  if (value.configurationOwnership === 'user') {
    if (mode !== 'manual_mcp_client' || value.configFileIdentitySha256 !== null || value.readBackProofSha256 !== null
      || value.sourceInstallationId !== null || value.sourceCatalogId !== null || value.sourceLiveTrustProofSha256 !== null
      || !SHA256.test(value.executableFingerprint ?? '')) throw new Error(`${label} user-owned Custom binding is invalid`)
    validateUserOwnedCustomActivityBinding(value.activityBinding, expected, label)
    return
  }
  if (!SHA256.test(value.readBackProofSha256 ?? '')) throw new Error(`${label} Custom read-back proof is invalid`)
  if (mode === 'nonstandard_config_root') {
    nonEmptyString(value.sourceInstallationId, `${label} Custom source Installation`)
    nonEmptyString(value.sourceCatalogId, `${label} Custom source catalog`)
    if (!SHA256.test(value.sourceLiveTrustProofSha256 ?? '')
      || value.sourceCatalogId !== sourceCatalogId
      || value.configFileIdentitySha256 !== null || value.executableFingerprint !== null) {
      throw new Error(`${label} nonstandard Custom binding is invalid`)
    }
  } else if (value.sourceInstallationId !== null || value.sourceCatalogId !== null
    || value.sourceLiveTrustProofSha256 !== null
    || !SHA256.test(value.configFileIdentitySha256 ?? '')
    || !SHA256.test(value.executableFingerprint ?? '')) {
    throw new Error(`${label} manual Custom binding is invalid`)
  }
}

function validateCandidateApp(raw, expectedAppVersion) {
  const candidate = record(raw, 'acceptance candidateApp')
  exactKeys(candidate, [
    'version', 'sourceCommit', 'bundleSha256', 'executableSha256', 'teamId', 'signingIdentity', 'cdhash',
  ], 'acceptance candidateApp')
  if (candidate.version !== expectedAppVersion) throw new Error('acceptance candidate app version mismatch')
  if (!SOURCE_COMMIT.test(candidate.sourceCommit ?? '')) throw new Error('acceptance candidate source commit is invalid')
  if (!SHA256.test(candidate.bundleSha256 ?? '')) throw new Error('acceptance candidate bundle SHA-256 is invalid')
  if (!SHA256.test(candidate.executableSha256 ?? '')) throw new Error('acceptance candidate executable SHA-256 is invalid')
  nonEmptyString(candidate.teamId, 'acceptance candidate Team ID')
  nonEmptyString(candidate.signingIdentity, 'acceptance candidate signing identity')
  nonEmptyString(candidate.cdhash, 'acceptance candidate CDHash')
  return candidate
}

export function candidateAppsIdentityHash(candidateAppsByArchitecture) {
  return sha256Bytes(Buffer.from(JSON.stringify(candidateAppsByArchitecture)))
}

function validateCandidateApps(raw, expectedAppVersion, releaseMacArchitectures) {
  const candidates = record(raw, 'acceptance candidateAppsByArchitecture')
  const architectures = Object.keys(candidates).sort()
  if (JSON.stringify(architectures) !== JSON.stringify(releaseMacArchitectures)) {
    throw new Error(`acceptance must bind exact release candidate apps: ${releaseMacArchitectures.join(', ')}`)
  }
  return Object.freeze(Object.fromEntries(architectures.map(architecture => [architecture, validateCandidateApp(candidates[architecture], expectedAppVersion)])))
}

function validateReview(
  raw,
  generatedAt,
  evidenceManifestSha256,
  candidateAppsSha256,
  releaseContractSha256,
  assertors,
) {
  const review = record(raw, 'acceptance review')
  exactKeys(review, [
    'reviewer', 'reviewedAt', 'decision', 'evidenceManifestSha256', 'candidateAppsSha256',
    'releaseContractSha256',
  ], 'acceptance review')
  nonEmptyString(review.reviewer, 'acceptance reviewer')
  const reviewedAt = isoTimestamp(review.reviewedAt, 'acceptance reviewedAt')
  if (reviewedAt > generatedAt) throw new Error('acceptance review occurs after index generation')
  if (review.decision !== 'approved') throw new Error('acceptance evidence was not independently approved')
  if (review.evidenceManifestSha256 !== evidenceManifestSha256) {
    throw new Error('acceptance review evidence manifest mismatch')
  }
  if (review.candidateAppsSha256 !== candidateAppsSha256) {
    throw new Error('acceptance review candidate mismatch')
  }
  if (review.releaseContractSha256 !== releaseContractSha256) {
    throw new Error('acceptance review release contract mismatch')
  }
  if (assertors.has(review.reviewer)) {
    throw new Error('acceptance reviewer must be independent from step assertors')
  }
}

function validateStepReceipt(raw, expected, label) {
  const receipt = record(raw, `${label} receipt`)
  exactKeys(receipt, [
    'targetKey', 'targetId', 'stepId', 'appVersion', 'sourceCommit', 'candidateBundleSha256',
    'releaseContractSha256', 'hostVersion', 'installationId', 'agentId', 'evidenceIds', 'outcomeDigest',
  ], `${label} receipt`)
  for (const [key, value] of Object.entries({
    targetKey: expected.targetKey,
    targetId: expected.targetId,
    stepId: expected.stepId,
    appVersion: expected.appVersion,
    sourceCommit: expected.sourceCommit,
    candidateBundleSha256: expected.candidateBundleSha256,
    releaseContractSha256: expected.releaseContractSha256,
    hostVersion: expected.hostVersion,
  })) {
    if (receipt[key] !== value) throw new Error(`${label} receipt ${key} mismatch`)
  }
  nonEmptyString(receipt.installationId, `${label} receipt installationId`)
  nonEmptyString(receipt.agentId, `${label} receipt agentId`)
  if (!Array.isArray(receipt.evidenceIds) || receipt.evidenceIds.length === 0) {
    throw new Error(`${label} receipt evidenceIds must be non-empty`)
  }
  receipt.evidenceIds.forEach((value, index) => {
    if (!SHA256.test(value ?? '')) throw new Error(`${label} receipt evidenceId ${index} is invalid`)
  })
  unique(receipt.evidenceIds, `${label} receipt evidenceIds`)
  if (!SHA256.test(receipt.outcomeDigest ?? '')) throw new Error(`${label} receipt outcome digest is invalid`)
  return receipt
}

function validateFrozenLifecycleActivityReceipt(raw, expected, assertionObservedAt, label) {
  const lifecycleSignal = expected.stepId.startsWith('lifecycle_')
    ? expected.stepId.slice('lifecycle_'.length)
    : null
  if (lifecycleSignal === null) {
    if (raw !== null) throw new Error(`${label} non-lifecycle assertion contains an activity receipt`)
    return null
  }
  const activity = record(raw, `${label} activity receipt`)
  exactKeys(activity, [
    'exporterVersion', 'ledgerSource', 'captureNonce', 'targetKey', 'candidateBundleSha256', 'sourceCommit',
    'releaseContractSha256', 'databaseSchemaVersion', 'databaseSchemaSha256',
    'id', 'installationId', 'agentId', 'hostVariant', 'componentKey', 'signalName',
    'tideMindVersion', 'adapterVersion', 'projectionVersion', 'hostVersion', 'evidenceHash', 'observedAt',
    'exportHash',
  ], `${label} activity receipt`)
  for (const [key, value] of Object.entries({
    exporterVersion: 1,
    ledgerSource: expected.allowFixtureActivity ? 'fixture' : 'real_profile',
    captureNonce: expected.captureNonce,
    targetKey: expected.targetKey,
    candidateBundleSha256: expected.candidateBundleSha256,
    sourceCommit: expected.sourceCommit,
    releaseContractSha256: expected.releaseContractSha256,
  })) {
    if (activity[key] !== value) throw new Error(`${label} activity exporter ${key} mismatch`)
  }
  if (!/^aha_[a-f0-9]{24}$/u.test(activity.id ?? '')) throw new Error(`${label} activity event ID is invalid`)
  for (const [key, value] of Object.entries({
    installationId: expected.installationId,
    agentId: expected.agentId,
    hostVariant: expected.hostVariant,
    componentKey: 'lifecycle',
    signalName: lifecycleSignal,
    tideMindVersion: expected.appVersion,
    hostVersion: expected.hostVersion,
  })) {
    if (activity[key] !== value) throw new Error(`${label} activity ${key} mismatch`)
  }
  nonEmptyString(activity.adapterVersion, `${label} activity adapterVersion`)
  nonEmptyString(activity.projectionVersion, `${label} activity projectionVersion`)
  const activityTime = isoTimestamp(activity.observedAt, `${label} activity observedAt`)
  if (activityTime < expected.captureCreatedAt || activityTime > assertionObservedAt) {
    throw new Error(`${label} activity time is outside the capture/assertion window`)
  }
  if (activity.evidenceHash !== hostActivityLedgerEvidenceHash(activity)) {
    throw new Error(`${label} activity evidence hash mismatch`)
  }
  if (activity.exportHash !== hostActivityLedgerExportHash(activity)) {
    throw new Error(`${label} activity export hash mismatch`)
  }
  if (activity.databaseSchemaVersion !== 34) throw new Error(`${label} activity database schema is not v34`)
  return activity
}

function validateFrozenStepAssertion(raw, expected, label) {
  const assertion = record(raw, `${label} assertion`)
  exactKeys(assertion, [
    'schemaVersion', 'targetKey', 'targetId', 'stepId', 'sourceCommit', 'releaseContractSha256',
    'candidateBundleSha256', 'installationId', 'agentId', 'outcome', 'assertionSource',
    'assertedBy', 'observedAt', 'assertions', 'activityReceipt',
  ], `${label} assertion`)
  if (assertion.schemaVersion !== 2 || assertion.outcome !== 'passed') {
    throw new Error(`${label} assertion schema or outcome is invalid`)
  }
  for (const key of [
    'targetKey', 'targetId', 'stepId', 'sourceCommit', 'releaseContractSha256', 'candidateBundleSha256',
    'installationId', 'agentId',
  ]) {
    if (assertion[key] !== expected[key]) throw new Error(`${label} assertion ${key} mismatch`)
  }
  if (assertion.assertionSource !== expected.assertionSource
    || assertion.assertedBy !== expected.assertedBy
    || assertion.observedAt !== expected.observedAt
    || JSON.stringify(assertion.assertions) !== JSON.stringify(expected.assertions)) {
    throw new Error(`${label} assertion does not match the frozen step`)
  }
  const assertionTime = isoTimestamp(assertion.observedAt, `${label} assertion observedAt`)
  if (assertionTime < expected.captureCreatedAt) throw new Error(`${label} assertion predates capture creation`)
  const activity = validateFrozenLifecycleActivityReceipt(
    assertion.activityReceipt,
    expected,
    assertionTime,
    label,
  )
  return { assertion, activity }
}

function validateTarget(
  raw,
  expected,
  requiredSteps,
  filePaths,
  fileHashes,
  root,
  captureCreatedAt,
  generatedAt,
  sourceCommit,
  appVersion,
  candidateBundleSha256,
  releaseContractSha256,
  captureNonce,
  allowFixtureActivity,
  label,
) {
  const target = record(raw, label)
  exactKeys(target, [
    'targetKey', 'targetId', 'sourceCatalogId', 'disposition', 'targetCapability', 'hostVersion', 'distribution', 'environment',
    'installationId', 'agentId', 'customBinding', 'metadataExport', 'steps',
  ], label)
  if (target.targetKey !== expected.targetKey) throw new Error(`${label} targetKey mismatch`)
  if (target.targetId !== expected.targetId) throw new Error(`${label} targetId mismatch`)
  if (target.sourceCatalogId !== (expected.sourceCatalogId ?? null)) {
    throw new Error(`${label} sourceCatalogId mismatch`)
  }
  if (target.disposition !== expected.disposition) throw new Error(`${label} disposition mismatch`)
  if (target.targetCapability !== expected.targetCapability) throw new Error(`${label} targetCapability mismatch`)
  nonEmptyString(target.hostVersion, `${label} official host version`)
  if (Array.isArray(expected.releaseAcceptedExactVersions)
    && !expected.releaseAcceptedExactVersions.includes(target.hostVersion)) {
    throw new Error(`${label} host version is not accepted by the frozen release contract`)
  }
  validateAgentHostAcceptanceEnvironment(target.environment, label)
  if (expected.architecture && target.environment.architecture !== expected.architecture) {
    throw new Error(`${label} architecture mismatch`)
  }
  validateDistribution(
    target.distribution,
    label,
    expected.officialDistributions ?? [],
    expected.acceptedDistributionArtifacts ?? [],
    target.hostVersion,
    target.environment.architecture,
    expected.requireArtifactReceipt === false
      || (allowFixtureActivity && (expected.acceptedDistributionArtifacts?.length ?? 0) === 0),
  )
  nonEmptyString(target.installationId, `${label} installationId`)
  nonEmptyString(target.agentId, `${label} agentId`)
  validateCustomBinding(
    target.customBinding,
    target.disposition === 'custom' ? target.targetId : null,
    target.sourceCatalogId,
    label,
    { targetKey: target.targetKey, installationId: target.installationId, agentId: target.agentId, hostVersion: target.hostVersion,
      tideMindVersion: appVersion, exportedAt: target.metadataExport?.exportedAt },
  )
  if (allowFixtureActivity && target.metadataExport === null) {
    // Explicit fixture acceptance keeps its direct metadata seam. Formal
    // evidence must carry the signed candidate export receipt below.
  } else {
    const metadataExport = record(target.metadataExport, `${label} metadataExport`)
    exactKeys(metadataExport, [
      'exporterVersion', 'evidenceClass', 'candidateBundleSha256', 'sourceCommit',
      'releaseContractSha256', 'targetMetadata', 'exportedAt', 'exportHash',
    ], `${label} metadataExport`)
    if (metadataExport.exporterVersion !== 1 || metadataExport.evidenceClass !== 'real_host'
      || metadataExport.candidateBundleSha256 !== candidateBundleSha256
      || metadataExport.sourceCommit !== sourceCommit
      || metadataExport.releaseContractSha256 !== releaseContractSha256
      || metadataExport.exportHash !== hostAcceptanceTargetMetadataExportHash(metadataExport)) {
      throw new Error(`${label} metadataExport does not bind the frozen candidate`)
    }
    isoTimestamp(metadataExport.exportedAt, `${label} metadataExport exportedAt`)
    const exported = record(metadataExport.targetMetadata, `${label} exported target metadata`)
    if (JSON.stringify(exported) !== JSON.stringify({
      targetKey: target.targetKey,
      targetId: target.targetId,
      ...(target.sourceCatalogId ? { sourceCatalogId: target.sourceCatalogId } : {}),
      hostVersion: target.hostVersion,
      distribution: target.distribution,
      environment: target.environment,
      installationId: target.installationId,
      agentId: target.agentId,
      ...(target.customBinding ? { customBinding: target.customBinding } : {}),
    })) throw new Error(`${label} differs from its signed candidate metadata export`)
  }
  if (!Array.isArray(target.steps)) throw new Error(`${label} steps must be an array`)
  const stepIds = target.steps.map(step => record(step, `${label} step`).id)
  unique(stepIds, `${label} steps`)
  if (JSON.stringify([...stepIds].sort()) !== JSON.stringify([...requiredSteps].sort())) {
    throw new Error(`${label} does not contain the exact required step set`)
  }
  const referenced = []
  const receiptFiles = new Set()
  for (const rawStep of target.steps) {
    const step = record(rawStep, `${label} step`)
    exactKeys(step, [
      'id', 'status', 'observedAt', 'assertionSource', 'assertedBy', 'assertions',
      'receipt', 'evidenceFiles',
    ], `${label} step ${String(step.id)}`)
    if (!requiredSteps.includes(step.id)) throw new Error(`${label} has an unknown step: ${String(step.id)}`)
    if (step.status !== 'passed') throw new Error(`${label} step ${step.id} did not pass`)
    if (!['human', 'external'].includes(step.assertionSource)) {
      throw new Error(`${label} step ${step.id} assertionSource is invalid`)
    }
    nonEmptyString(step.assertedBy, `${label} step ${step.id} assertedBy`)
    const stepObservedAt = isoTimestamp(step.observedAt, `${label} step ${step.id} observedAt`)
    if (stepObservedAt < captureCreatedAt) throw new Error(`${label} step ${step.id} predates capture creation`)
    if (stepObservedAt > generatedAt) {
      throw new Error(`${label} step ${step.id} occurs after index generation`)
    }
    if (!Array.isArray(step.assertions) || step.assertions.length === 0) {
      throw new Error(`${label} step ${step.id} requires assertions`)
    }
    step.assertions.forEach((assertion, index) => nonEmptyString(assertion, `${label} step ${step.id} assertion ${index}`))
    unique(step.assertions, `${label} step ${step.id} assertions`)
    const receipt = validateStepReceipt(step.receipt, {
      targetKey: target.targetKey,
      targetId: target.targetId,
      stepId: step.id,
      appVersion,
      sourceCommit,
      candidateBundleSha256,
      releaseContractSha256,
      hostVersion: target.hostVersion,
    }, `${label} step ${step.id}`)
    if (receipt.installationId !== target.installationId || receipt.agentId !== target.agentId) {
      throw new Error(`${label} step ${step.id} belongs to a different Installation or Agent`)
    }
    if (!Array.isArray(step.evidenceFiles) || step.evidenceFiles.length < 2) {
      throw new Error(`${label} step ${step.id} requires a receipt and assertion evidence`)
    }
    step.evidenceFiles.forEach((file, index) => {
      const relative = safeRelativeFile(file, `${label} step ${step.id} evidence ${index}`)
      if (!filePaths.has(relative)) throw new Error(`${label} step ${step.id} references an unindexed evidence file`)
      referenced.push(relative)
    })
    unique(step.evidenceFiles, `${label} step ${step.id} evidence files`)
    const receiptFile = step.evidenceFiles[0]
    if (receiptFiles.has(receiptFile)) throw new Error(`${label} reuses a receipt file across steps`)
    receiptFiles.add(receiptFile)
    const parsedReceipt = readJsonFile(path.join(root, ...receiptFile.split('/')), MAX_EVIDENCE_FILE_BYTES).value
    if (JSON.stringify(parsedReceipt) !== JSON.stringify(receipt)) {
      throw new Error(`${label} step ${step.id} receipt file does not match its structured receipt`)
    }
    const frozenAssertion = validateFrozenStepAssertion(
      readJsonFile(path.join(root, ...step.evidenceFiles[1].split('/')), MAX_EVIDENCE_FILE_BYTES).value,
      {
        targetKey: target.targetKey,
        targetId: target.targetId,
        stepId: step.id,
        sourceCommit,
        releaseContractSha256,
        candidateBundleSha256,
        installationId: target.installationId,
        agentId: target.agentId,
        hostVariant: target.sourceCatalogId ?? target.targetId,
        hostVersion: target.hostVersion,
        appVersion,
        captureCreatedAt,
        captureNonce,
        allowFixtureActivity,
        assertionSource: step.assertionSource,
        assertedBy: step.assertedBy,
        observedAt: step.observedAt,
        assertions: step.assertions,
      },
      `${label} step ${step.id}`,
    )
    const evidenceIds = step.evidenceFiles.slice(1).map(file => fileHashes.get(file))
    if (evidenceIds.some(value => !value)
      || JSON.stringify(receipt.evidenceIds) !== JSON.stringify(evidenceIds)) {
      throw new Error(`${label} step ${step.id} receipt evidence IDs do not match evidence files`)
    }
    const expectedOutcomeDigest = hostAcceptanceStepOutcomeDigest({
      targetKey: target.targetKey,
      targetId: target.targetId,
      stepId: step.id,
      status: step.status,
      observedAt: step.observedAt,
      assertionSource: step.assertionSource,
      assertedBy: step.assertedBy,
      assertions: step.assertions,
      installationId: receipt.installationId,
      agentId: receipt.agentId,
      sourceCommit,
      releaseContractSha256,
      candidateBundleSha256,
      activityEvidenceHash: frozenAssertion.activity?.evidenceHash ?? null,
      evidenceIds: receipt.evidenceIds,
    })
    if (receipt.outcomeDigest !== expectedOutcomeDigest) {
      throw new Error(`${label} step ${step.id} outcome digest mismatch`)
    }
  }
  return { referenced, assertors: target.steps.map(step => step.assertedBy) }
}

function validateUpgradePath(
  raw,
  targetKey,
  targetId,
  targetIdentitySha256,
  fromAppVersion,
  filePaths,
  fileHashes,
  root,
  captureCreatedAt,
  generatedAt,
  sourceCommit,
  appVersion,
  candidateBundleSha256,
  releaseContractSha256,
) {
  const label = `acceptance upgrade path ${fromAppVersion}`
  const upgrade = record(raw, label)
  exactKeys(upgrade, [
    'targetKey', 'targetId', 'fromAppVersion', 'toAppVersion', 'status', 'observedAt', 'assertionSource', 'assertedBy',
    'assertions', 'installationId', 'originalAgentId', 'migratedAgentId', 'historyPreserved',
    'statisticsPreserved', 'targetIdentitySha256', 'receipt', 'evidenceFiles',
  ], label)
  if (upgrade.targetKey !== targetKey) throw new Error(`${label} targetKey mismatch`)
  if (upgrade.targetId !== targetId) throw new Error(`${label} target mismatch`)
  if (upgrade.targetIdentitySha256 !== targetIdentitySha256) throw new Error(`${label} target identity mismatch`)
  if (upgrade.fromAppVersion !== fromAppVersion) throw new Error(`${label} source version mismatch`)
  if (upgrade.toAppVersion !== appVersion) throw new Error(`${label} destination version mismatch`)
  if (upgrade.status !== 'passed') throw new Error(`${label} did not pass`)
  const upgradeObservedAt = isoTimestamp(upgrade.observedAt, `${label} observedAt`)
  if (upgradeObservedAt < captureCreatedAt) throw new Error(`${label} predates capture creation`)
  if (upgradeObservedAt > generatedAt) {
    throw new Error(`${label} occurs after index generation`)
  }
  if (!['human', 'external'].includes(upgrade.assertionSource)) {
    throw new Error(`${label} assertionSource is invalid`)
  }
  nonEmptyString(upgrade.assertedBy, `${label} assertedBy`)
  if (!Array.isArray(upgrade.assertions) || upgrade.assertions.length === 0) {
    throw new Error(`${label} requires assertions`)
  }
  upgrade.assertions.forEach((assertion, index) => nonEmptyString(assertion, `${label} assertion ${index}`))
  unique(upgrade.assertions, `${label} assertions`)
  nonEmptyString(upgrade.installationId, `${label} installationId`)
  nonEmptyString(upgrade.originalAgentId, `${label} originalAgentId`)
  nonEmptyString(upgrade.migratedAgentId, `${label} migratedAgentId`)
  if (upgrade.originalAgentId !== upgrade.migratedAgentId) {
    throw new Error(`${label} did not preserve Agent ID`)
  }
  if (upgrade.historyPreserved !== true || upgrade.statisticsPreserved !== true) {
    throw new Error(`${label} did not preserve history and statistics`)
  }
  const receipt = record(upgrade.receipt, `${label} receipt`)
  exactKeys(receipt, [
    'targetKey', 'targetId', 'fromAppVersion', 'toAppVersion', 'sourceCommit', 'candidateBundleSha256',
    'releaseContractSha256', 'targetIdentitySha256', 'installationId', 'originalAgentId', 'migratedAgentId',
    'evidenceIds', 'outcomeDigest',
  ], `${label} receipt`)
  for (const [key, value] of Object.entries({
    targetKey,
    targetId,
    fromAppVersion,
    toAppVersion: appVersion,
    sourceCommit,
    candidateBundleSha256,
    releaseContractSha256,
    targetIdentitySha256,
    installationId: upgrade.installationId,
    originalAgentId: upgrade.originalAgentId,
    migratedAgentId: upgrade.migratedAgentId,
  })) {
    if (receipt[key] !== value) throw new Error(`${label} receipt ${key} mismatch`)
  }
  if (!Array.isArray(receipt.evidenceIds) || receipt.evidenceIds.length === 0) {
    throw new Error(`${label} receipt evidenceIds must be non-empty`)
  }
  receipt.evidenceIds.forEach((value, index) => {
    if (!SHA256.test(value ?? '')) throw new Error(`${label} receipt evidenceId ${index} is invalid`)
  })
  unique(receipt.evidenceIds, `${label} receipt evidenceIds`)
  if (!SHA256.test(receipt.outcomeDigest ?? '')) throw new Error(`${label} receipt outcome digest is invalid`)
  if (!Array.isArray(upgrade.evidenceFiles) || upgrade.evidenceFiles.length < 2) {
    throw new Error(`${label} requires a receipt and assertion evidence`)
  }
  upgrade.evidenceFiles.forEach((file, index) => {
    const relative = safeRelativeFile(file, `${label} evidence ${index}`)
    if (!filePaths.has(relative)) throw new Error(`${label} references an unindexed evidence file`)
  })
  unique(upgrade.evidenceFiles, `${label} evidence files`)
  const parsedReceipt = readJsonFile(
    path.join(root, ...upgrade.evidenceFiles[0].split('/')),
    MAX_EVIDENCE_FILE_BYTES,
  ).value
  if (JSON.stringify(parsedReceipt) !== JSON.stringify(receipt)) {
    throw new Error(`${label} receipt file does not match its structured receipt`)
  }
  const assertion = record(readJsonFile(
    path.join(root, ...upgrade.evidenceFiles[1].split('/')),
    MAX_EVIDENCE_FILE_BYTES,
  ).value, `${label} assertion`)
  exactKeys(assertion, [
    'schemaVersion', 'targetKey', 'targetId', 'fromAppVersion', 'toAppVersion', 'sourceCommit',
    'releaseContractSha256', 'candidateBundleSha256', 'targetIdentitySha256', 'outcome',
    'assertionSource', 'assertedBy', 'observedAt', 'assertions', 'installationId',
    'originalAgentId', 'migratedAgentId', 'historyPreserved', 'statisticsPreserved',
  ], `${label} assertion`)
  if (assertion.schemaVersion !== 2 || assertion.outcome !== 'passed') {
    throw new Error(`${label} assertion schema or outcome is invalid`)
  }
  for (const [key, value] of Object.entries({
    targetKey,
    targetId,
    fromAppVersion,
    toAppVersion: appVersion,
    sourceCommit,
    releaseContractSha256,
    candidateBundleSha256,
    targetIdentitySha256,
    assertionSource: upgrade.assertionSource,
    assertedBy: upgrade.assertedBy,
    observedAt: upgrade.observedAt,
    installationId: upgrade.installationId,
    originalAgentId: upgrade.originalAgentId,
    migratedAgentId: upgrade.migratedAgentId,
    historyPreserved: true,
    statisticsPreserved: true,
  })) {
    if (assertion[key] !== value) throw new Error(`${label} assertion ${key} mismatch`)
  }
  if (JSON.stringify(assertion.assertions) !== JSON.stringify(upgrade.assertions)) {
    throw new Error(`${label} assertion text does not match the frozen upgrade`)
  }
  const evidenceIds = upgrade.evidenceFiles.slice(1).map(file => fileHashes.get(file))
  if (evidenceIds.some(value => !value)
    || JSON.stringify(receipt.evidenceIds) !== JSON.stringify(evidenceIds)) {
    throw new Error(`${label} receipt evidence IDs do not match evidence files`)
  }
  const expectedOutcomeDigest = hostAcceptanceUpgradeOutcomeDigest({
    targetKey,
    targetId,
    fromAppVersion: upgrade.fromAppVersion,
    toAppVersion: upgrade.toAppVersion,
    status: upgrade.status,
    observedAt: upgrade.observedAt,
    assertionSource: upgrade.assertionSource,
    assertedBy: upgrade.assertedBy,
    assertions: upgrade.assertions,
    installationId: upgrade.installationId,
    originalAgentId: upgrade.originalAgentId,
    migratedAgentId: upgrade.migratedAgentId,
    historyPreserved: upgrade.historyPreserved,
    statisticsPreserved: upgrade.statisticsPreserved,
    sourceCommit,
    releaseContractSha256,
    candidateBundleSha256,
    targetIdentitySha256,
    evidenceIds: receipt.evidenceIds,
  })
  if (receipt.outcomeDigest !== expectedOutcomeDigest) {
    throw new Error(`${label} outcome digest mismatch`)
  }
  return {
    referenced: [...upgrade.evidenceFiles],
    assertedBy: upgrade.assertedBy,
  }
}

function collectBundleFiles(root, indexRelative, current = root) {
  const files = []
  for (const name of fs.readdirSync(current).sort()) {
    const absolute = path.join(current, name)
    const stat = fs.lstatSync(absolute)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    if (stat.isSymbolicLink()) throw new Error(`acceptance bundle refuses symlink: ${relative}`)
    if (stat.isDirectory()) files.push(...collectBundleFiles(root, indexRelative, absolute))
    else if (stat.isFile() && relative !== indexRelative) files.push(relative)
    else if (!stat.isFile()) throw new Error(`acceptance bundle refuses non-file entry: ${relative}`)
  }
  return files.sort()
}

export function verifyAgentIntegrationHostAcceptance({
  indexPath,
  expectedAppVersion,
  expectedSourceCommit,
  requirementsPath = DEFAULT_AGENT_HOST_ACCEPTANCE_REQUIREMENTS,
  releaseManifestPath = DEFAULT_AGENT_INTEGRATION_RELEASE_MANIFEST,
  allowFixture = false,
  candidateAppPathsByArchitecture,
}) {
  if (typeof indexPath !== 'string' || !path.isAbsolute(indexPath)) {
    throw new Error('acceptance index path must be absolute')
  }
  const absoluteIndex = fs.realpathSync(indexPath)
  const root = fs.realpathSync(path.dirname(absoluteIndex))
  if (path.dirname(absoluteIndex) !== root) throw new Error('acceptance index parent must not be a symlink')
  const indexRelative = path.relative(root, absoluteIndex).split(path.sep).join('/')
  const { value } = readJsonFile(absoluteIndex)
  const index = record(value, 'acceptance index')
  exactKeys(index, [
    'schemaVersion', 'acceptanceId', 'evidenceClass', 'appVersion', 'upgradeFromAppVersions',
    'sourceCommit', 'captureCreatedAt', 'captureNonce',
    'generatedAt', 'requirementsSha256', 'candidateAppsByArchitecture', 'review',
    'releaseContractSha256',
    'entries', 'customPaths', 'upgradePaths', 'files',
  ], 'acceptance index')
  const requirements = loadAgentHostAcceptanceRequirements(requirementsPath, releaseManifestPath)
  if (index.schemaVersion !== AGENT_HOST_ACCEPTANCE_SCHEMA_VERSION) throw new Error('acceptance schema version mismatch')
  nonEmptyString(index.acceptanceId, 'acceptanceId')
  if (index.evidenceClass !== 'real_host' && !(allowFixture && index.evidenceClass === 'fixture')) {
    throw new Error('formal acceptance requires real_host evidence')
  }
  if (index.appVersion !== expectedAppVersion || index.appVersion !== requirements.appVersion) {
    throw new Error('acceptance app version mismatch')
  }
  if (!Array.isArray(index.upgradeFromAppVersions)
    || JSON.stringify(index.upgradeFromAppVersions) !== JSON.stringify(requirements.upgradeFromAppVersions)) {
    throw new Error('acceptance upgrade source versions mismatch')
  }
  if (!SOURCE_COMMIT.test(expectedSourceCommit ?? '') || index.sourceCommit !== expectedSourceCommit) {
    throw new Error('acceptance source commit mismatch')
  }
  const captureCreatedAt = isoTimestamp(index.captureCreatedAt, 'acceptance captureCreatedAt')
  if (!SHA256.test(index.captureNonce ?? '')) throw new Error('acceptance capture nonce is invalid')
  const generatedAt = isoTimestamp(index.generatedAt, 'acceptance generatedAt')
  if (captureCreatedAt > generatedAt) throw new Error('acceptance capture was created after index generation')
  const candidateApps = validateCandidateApps(index.candidateAppsByArchitecture, index.appVersion, requirements.releaseMacArchitectures)
  for (const [architecture, candidateApp] of Object.entries(candidateApps)) {
    if (candidateApp.sourceCommit !== index.sourceCommit) {
      throw new Error(`acceptance ${architecture} candidate source commit mismatch`)
    }
  }
  if (!allowFixture) {
    for (const architecture of requirements.releaseMacArchitectures) {
      const candidateAppPath = candidateAppPathsByArchitecture?.[architecture]
      if (typeof candidateAppPath !== 'string' || !path.isAbsolute(candidateAppPath)) {
        throw new Error(`formal real-host acceptance requires an absolute --candidate-app-${architecture} path`)
      }
      const physicalCandidate = inspectPhysicalTideMindCandidateApp(candidateAppPath, index.appVersion, index.sourceCommit, architecture)
      if (JSON.stringify(physicalCandidate) !== JSON.stringify(candidateApps[architecture])) {
        throw new Error(`acceptance ${architecture} candidate metadata differs from the physical signed candidate app`)
      }
    }
  }
  if (index.requirementsSha256 !== requirements.sha256) throw new Error('acceptance requirements SHA-256 mismatch')
  if (index.releaseContractSha256 !== requirements.releaseContractSha256) {
    throw new Error('acceptance release contract SHA-256 mismatch')
  }
  if (!Array.isArray(index.files) || index.files.length === 0 || index.files.length > MAX_EVIDENCE_FILES) {
    throw new Error('acceptance evidence file count is invalid')
  }
  const filePaths = new Set()
  const fileHashes = new Map()
  let totalBytes = 0
  for (const [position, rawFile] of index.files.entries()) {
    const file = record(rawFile, `acceptance file ${position}`)
    exactKeys(file, ['path', 'bytes', 'sha256'], `acceptance file ${position}`)
    const relative = safeRelativeFile(file.path, `acceptance file ${position} path`)
    if (relative === indexRelative) throw new Error('acceptance index cannot list itself as evidence')
    if (filePaths.has(relative)) throw new Error(`duplicate acceptance evidence file: ${relative}`)
    filePaths.add(relative)
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error(`acceptance evidence size is invalid: ${relative}`)
    }
    totalBytes += file.bytes
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) throw new Error('acceptance evidence bundle is too large')
    if (!SHA256.test(file.sha256 ?? '')) throw new Error(`acceptance evidence SHA-256 is invalid: ${relative}`)
    fileHashes.set(relative, file.sha256)
    const absolute = path.join(root, ...relative.split('/'))
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`acceptance evidence is not a regular file: ${relative}`)
    if (stat.size !== file.bytes) throw new Error(`acceptance evidence size changed: ${relative}`)
    if (sha256Bytes(fs.readFileSync(absolute)) !== file.sha256) {
      throw new Error(`acceptance evidence content changed: ${relative}`)
    }
  }
  const actualFiles = collectBundleFiles(root, indexRelative)
  if (JSON.stringify(actualFiles) !== JSON.stringify([...filePaths].sort())) {
    throw new Error('acceptance bundle file set differs from its index')
  }
  const evidenceManifestSha256 = sha256Bytes(Buffer.from(JSON.stringify(
    [...index.files].sort((left, right) => left.path.localeCompare(right.path)),
  )))
  if (!Array.isArray(index.entries) || index.entries.length !== requirements.targets.length) {
    throw new Error('acceptance release entry count mismatch')
  }
  const indexedEntries = new Map(index.entries.map(entry => [record(entry, 'acceptance entry').targetKey, entry]))
  if (indexedEntries.size !== index.entries.length) throw new Error('acceptance release entries contain duplicates')
  const referenced = []
  const assertors = new Set()
  for (const entry of requirements.targets) {
    const raw = indexedEntries.get(entry.targetKey)
    if (!raw) throw new Error(`acceptance is missing release entry: ${entry.targetKey}`)
    const validated = validateTarget(raw, {
      targetKey: entry.targetKey,
      targetId: entry.catalogId,
      architecture: entry.architecture,
      sourceCatalogId: null,
      disposition: entry.disposition,
      targetCapability: entry.targetCapability,
      officialDistributions: entry.officialDistributions,
      acceptedDistributionArtifacts: entry.acceptedDistributionArtifacts,
      releaseAcceptedExactVersions: entry.releaseAcceptedExactVersions,
    }, requiredHostAcceptanceSteps(requirements, entry), filePaths, fileHashes, root, captureCreatedAt, generatedAt,
    index.sourceCommit, index.appVersion, candidateApps[entry.architecture].bundleSha256, requirements.releaseContractSha256,
    index.captureNonce, index.evidenceClass === 'fixture',
    `acceptance entry ${entry.targetKey}`)
    referenced.push(...validated.referenced)
    validated.assertors.forEach(assertor => assertors.add(assertor))
  }

  if (!Array.isArray(index.customPaths) || index.customPaths.length !== requirements.customTargets.length) {
    throw new Error('acceptance Custom path count mismatch')
  }
  const indexedCustom = new Map(index.customPaths.map(entry => [record(entry, 'acceptance Custom path').targetKey, entry]))
  if (indexedCustom.size !== index.customPaths.length) throw new Error('acceptance Custom paths contain duplicates')
  for (const definition of requirements.customTargets) {
    const mode = definition.targetId
    const raw = indexedCustom.get(definition.targetKey)
    if (!raw) throw new Error(`acceptance is missing Custom path: ${definition.targetKey}`)
    if ((raw.customBinding?.configurationOwnership === 'user') !== (definition.configurationOwnership === 'user')) {
      throw new Error(`acceptance Custom configuration ownership mismatch: ${definition.targetKey}`)
    }
    const expected = mode === 'manual_mcp_client'
      ? {
          targetKey: definition.targetKey,
          targetId: mode,
          sourceCatalogId: null,
          disposition: 'custom',
          policyDisposition: 'guided',
          configurationOwnership: definition.configurationOwnership,
          targetCapability: 2,
          requiredComponents: ['memory_tools'],
          requiredLifecycle: null,
          requireArtifactReceipt: false,
        }
      : (() => {
          const custom = record(raw, 'acceptance Custom nonstandard target')
          nonEmptyString(custom.sourceCatalogId, 'acceptance Custom nonstandard sourceCatalogId')
          const source = requirements.entries.find(entry => entry.catalogId === custom.sourceCatalogId)
          if (!source) throw new Error(`acceptance Custom nonstandard source is not a released host: ${custom.sourceCatalogId}`)
          if (source.customConfigRoot?.supported !== true) {
            throw new Error(`acceptance Custom nonstandard source has no released relocatable-root contract: ${custom.sourceCatalogId}`)
          }
          return {
            targetKey: mode,
            targetId: mode,
            sourceCatalogId: source.catalogId,
            disposition: 'custom',
            policyDisposition: source.disposition,
            targetCapability: source.targetCapability,
            requiredComponents: source.requiredComponents,
            requiredLifecycle: source.requiredLifecycle,
            officialDistributions: source.officialDistributions,
            acceptedDistributionArtifacts: source.acceptedDistributionArtifacts,
            releaseAcceptedExactVersions: source.releaseAcceptedExactVersions,
          }
        })()
    const validated = validateTarget(raw, {
      targetKey: expected.targetKey,
      targetId: expected.targetId,
      sourceCatalogId: expected.sourceCatalogId,
      disposition: expected.disposition,
      targetCapability: expected.targetCapability,
      officialDistributions: expected.officialDistributions,
      acceptedDistributionArtifacts: expected.acceptedDistributionArtifacts,
      releaseAcceptedExactVersions: expected.releaseAcceptedExactVersions,
      requireArtifactReceipt: expected.requireArtifactReceipt,
    }, requiredHostAcceptanceSteps(requirements, expected), filePaths, fileHashes, root, captureCreatedAt, generatedAt,
    index.sourceCommit, index.appVersion, candidateApps[raw.environment.architecture].bundleSha256, requirements.releaseContractSha256,
    index.captureNonce, index.evidenceClass === 'fixture',
    `acceptance Custom path ${mode}`)
    referenced.push(...validated.referenced)
    validated.assertors.forEach(assertor => assertors.add(assertor))
  }
  const upgradeTargets = requirements.targets.map(entry => ({
    targetKey: entry.targetKey,
    targetId: entry.catalogId,
    architecture: entry.architecture,
  }))
  const expectedUpgradeCount = requirements.upgradeFromAppVersions.length * upgradeTargets.length
  if (!Array.isArray(index.upgradePaths) || index.upgradePaths.length !== expectedUpgradeCount) {
    throw new Error('acceptance upgrade path count mismatch')
  }
  const indexedUpgrades = new Map(index.upgradePaths.map(upgrade => [
    `${record(upgrade, 'acceptance upgrade path').targetKey}:${upgrade.fromAppVersion}`,
    upgrade,
  ]))
  if (indexedUpgrades.size !== index.upgradePaths.length) {
    throw new Error('acceptance upgrade paths contain duplicates')
  }
  for (const target of upgradeTargets) {
    for (const fromAppVersion of requirements.upgradeFromAppVersions) {
      const raw = indexedUpgrades.get(`${target.targetKey}:${fromAppVersion}`)
      if (!raw) throw new Error(`acceptance is missing upgrade path: ${target.targetKey}/${fromAppVersion}`)
      const validated = validateUpgradePath(
        raw,
        target.targetKey,
        target.targetId,
        hostAcceptanceTargetIdentityDigest(indexedEntries.get(target.targetKey)),
        fromAppVersion,
        filePaths,
        fileHashes,
        root,
        captureCreatedAt,
        generatedAt,
        index.sourceCommit,
        index.appVersion,
        candidateApps[target.architecture].bundleSha256,
        requirements.releaseContractSha256,
      )
      referenced.push(...validated.referenced)
      assertors.add(validated.assertedBy)
    }
  }
  const referencedSet = new Set(referenced)
  const unreferenced = [...filePaths].filter(file => !referencedSet.has(file))
  if (unreferenced.length > 0) throw new Error(`acceptance contains unreferenced evidence: ${unreferenced.join(',')}`)
  validateReview(
    index.review,
    generatedAt,
    evidenceManifestSha256,
    candidateAppsIdentityHash(candidateApps),
    requirements.releaseContractSha256,
    assertors,
  )

  return Object.freeze({
    status: 'passed',
    schemaVersion: index.schemaVersion,
    acceptanceId: index.acceptanceId,
    appVersion: index.appVersion,
    sourceCommit: index.sourceCommit,
    entryCount: index.entries.length,
    customPathCount: index.customPaths.length,
    upgradePathCount: index.upgradePaths.length,
    evidenceFileCount: index.files.length,
    candidateAppsSha256: candidateAppsIdentityHash(candidateApps),
    evidenceManifestSha256,
  })
}

export function copyVerifiedAgentIntegrationHostAcceptance({
  sourceIndexPath,
  destinationDirectory,
  expectedAppVersion,
  expectedSourceCommit,
  requirementsPath = DEFAULT_AGENT_HOST_ACCEPTANCE_REQUIREMENTS,
  releaseManifestPath = DEFAULT_AGENT_INTEGRATION_RELEASE_MANIFEST,
  candidateAppPathsByArchitecture,
  allowFixture = false,
}) {
  const summary = verifyAgentIntegrationHostAcceptance({
    indexPath: sourceIndexPath,
    expectedAppVersion,
    expectedSourceCommit,
    requirementsPath,
    releaseManifestPath,
    candidateAppPathsByArchitecture,
    allowFixture,
  })
  if (!path.isAbsolute(destinationDirectory)) throw new Error('acceptance copy destination must be absolute')
  if (fs.existsSync(destinationDirectory)) throw new Error(`acceptance copy destination already exists: ${destinationDirectory}`)
  const sourceRoot = path.dirname(path.resolve(sourceIndexPath))
  const index = readJsonFile(path.resolve(sourceIndexPath)).value
  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 })
  try {
    fs.copyFileSync(path.resolve(sourceIndexPath), path.join(destinationDirectory, 'index.json'), fs.constants.COPYFILE_EXCL)
    for (const file of index.files) {
      const destination = path.join(destinationDirectory, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(path.join(sourceRoot, ...file.path.split('/')), destination, fs.constants.COPYFILE_EXCL)
    }
    const copied = verifyAgentIntegrationHostAcceptance({
      indexPath: path.join(destinationDirectory, 'index.json'),
      expectedAppVersion,
      expectedSourceCommit,
      requirementsPath,
      releaseManifestPath,
      candidateAppPathsByArchitecture,
      allowFixture,
    })
    if (copied.evidenceManifestSha256 !== summary.evidenceManifestSha256) {
      throw new Error('copied acceptance evidence manifest changed')
    }
    return copied
  } catch (error) {
    fs.rmSync(destinationDirectory, { recursive: true, force: true })
    throw error
  }
}

function parseArgs(argv) {
  const values = {
    indexPath: null,
    appVersion: null,
    sourceCommit: null,
    requirementsPath: undefined,
    copyTo: null,
    candidateAppPathsByArchitecture: { arm64: null, x64: null },
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[++index]
    if (!value) throw new Error(`missing value for ${flag}`)
    if (flag === '--index') values.indexPath = path.resolve(value)
    else if (flag === '--app-version') values.appVersion = value
    else if (flag === '--source-commit') values.sourceCommit = value
    else if (flag === '--requirements') values.requirementsPath = path.resolve(value)
    else if (flag === '--copy-to') values.copyTo = path.resolve(value)
    else if (flag === '--candidate-app-arm64') values.candidateAppPathsByArchitecture.arm64 = path.resolve(value)
    else if (flag === '--candidate-app-x64') values.candidateAppPathsByArchitecture.x64 = path.resolve(value)
    else throw new Error(`unknown acceptance verifier argument: ${flag}`)
  }
  if (!values.indexPath || !values.appVersion || !values.sourceCommit) {
    throw new Error('Usage: verify-agent-integration-host-acceptance.mjs --index index.json --app-version X.Y.Z --source-commit SHA --candidate-app-arm64 APP [--candidate-app-x64 APP] [--copy-to DIR]')
  }
  return values
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const summary = args.copyTo
      ? copyVerifiedAgentIntegrationHostAcceptance({
          sourceIndexPath: args.indexPath,
          destinationDirectory: args.copyTo,
          expectedAppVersion: args.appVersion,
          expectedSourceCommit: args.sourceCommit,
          requirementsPath: args.requirementsPath,
          candidateAppPathsByArchitecture: args.candidateAppPathsByArchitecture,
        })
      : verifyAgentIntegrationHostAcceptance({
          indexPath: args.indexPath,
          expectedAppVersion: args.appVersion,
          expectedSourceCommit: args.sourceCommit,
          requirementsPath: args.requirementsPath,
          candidateAppPathsByArchitecture: args.candidateAppPathsByArchitecture,
        })
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
