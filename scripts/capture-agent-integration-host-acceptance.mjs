#!/usr/bin/env node
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  AGENT_HOST_ACCEPTANCE_SCHEMA_VERSION,
  candidateAppsIdentityHash,
  distributionArtifactReceiptSha256,
  hostAcceptanceTargetIdentityDigest,
  hostAcceptanceTargetMetadataExportHash,
  hostAcceptanceStepOutcomeDigest,
  hostAcceptanceUpgradeOutcomeDigest,
  hostActivityLedgerEvidenceHash,
  hostActivityLedgerExportHash,
  loadAgentHostAcceptanceRequirements,
  requiredHostAcceptanceSteps,
  validateAgentHostAcceptanceEnvironment,
  verifyAgentIntegrationHostAcceptance,
  validateUserOwnedCustomActivityBinding,
} from './verify-agent-integration-host-acceptance.mjs'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'

const CAPTURE_SCHEMA_VERSION = 2
const STATE_FILE = '.capture-state.json'
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_TEXT_SCAN_BYTES = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const SOURCE_COMMIT = /^[a-f0-9]{40,64}$/u
const SAFE_EVIDENCE_EXTENSIONS = new Set(['.json', '.txt', '.log', '.png', '.jpg', '.jpeg'])
const FORBIDDEN_EVIDENCE_NAMES = /(?:^|[._-])(?:\.env|credentials?|secrets?|cookies?|id_rsa|id_ed25519|private[_-]?key)(?:[._-]|$)/iu
const FORBIDDEN_CONFIG_NAMES = /^(?:\..+|config|settings|preferences|mcp|state|database)(?:\.[^.]+)?$/iu
const FORBIDDEN_SOURCE_DIRECTORIES = new Set([
  '.agents', '.claude', '.codex', '.config', '.ssh', 'application support',
])
const TEXT_EVIDENCE_EXTENSIONS = new Set(['.json', '.txt', '.log'])
const REDACTION_STATEMENT = 'I verified that the evidence files contain no credentials, secrets, tokens, cookies, private keys, or authentication material.'
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:sk|gh[pousr]|github_pat|npm)_[A-Za-z0-9_-]{16,}\b/u,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/iu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"',]{8,}/iu,
]

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function canonicalIso(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !value) {
    throw new Error(`${label} must be a non-empty normalized string`)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`)
  }
  return value
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !value) {
    throw new Error(`${label} must be a non-empty normalized string`)
  }
  return value
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly: ${wanted.join(', ')}`)
  }
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty array`)
  values.forEach((value, index) => nonEmpty(value, `${label} ${index}`))
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`)
  return values
}

function readRegularFile(file, maxBytes = MAX_INPUT_BYTES) {
  const absolute = path.resolve(file)
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`capture input must be a regular file: ${absolute}`)
  if (stat.size <= 0 || stat.size > maxBytes) throw new Error(`capture input size is invalid: ${absolute}`)
  return { absolute, stat, bytes: fs.readFileSync(absolute) }
}

function readJson(file, label) {
  const input = readRegularFile(file)
  try {
    return { ...input, value: JSON.parse(input.bytes.toString('utf8')) }
  } catch {
    throw new Error(`${label} is not valid JSON: ${input.absolute}`)
  }
}

function writeJsonExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`)
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeState(workspace, state) {
  const target = path.join(workspace, STATE_FILE)
  const temporary = path.join(workspace, `.${STATE_FILE}.${crypto.randomUUID()}.tmp`)
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, target)
}

function absoluteWorkspace(value, mustExist = true) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('capture workspace must be an absolute path')
  const normalized = path.resolve(value)
  if (normalized === path.parse(normalized).root) throw new Error('capture workspace must not be a filesystem root')
  if (!mustExist) {
    const parent = path.dirname(normalized)
    const parentStat = fs.lstatSync(parent)
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || fs.realpathSync(parent) !== parent) {
      throw new Error('capture workspace parent must be an existing real directory')
    }
  }
  if (mustExist) {
    const stat = fs.lstatSync(normalized)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('capture workspace must be a regular directory')
    if (fs.realpathSync(normalized) !== normalized) throw new Error('capture workspace must not traverse symlinks')
  }
  return normalized
}

function loadState(workspaceInput) {
  const workspace = absoluteWorkspace(workspaceInput)
  const { value } = readJson(path.join(workspace, STATE_FILE), 'capture state')
  const state = object(value, 'capture state')
  if (state.captureSchemaVersion !== CAPTURE_SCHEMA_VERSION) throw new Error('unsupported capture state schema')
  if (state.status !== 'collecting') throw new Error('capture state is not collecting')
  const requirements = loadAgentHostAcceptanceRequirements()
  if (state.acceptanceSchemaVersion !== AGENT_HOST_ACCEPTANCE_SCHEMA_VERSION
    || state.appVersion !== requirements.appVersion
    || state.requirementsSha256 !== requirements.sha256
    || state.releaseContractSha256 !== requirements.releaseContractSha256
    || JSON.stringify(state.upgradeFromAppVersions) !== JSON.stringify(requirements.upgradeFromAppVersions)) {
    throw new Error('capture state no longer matches the current frozen acceptance contract')
  }
  return { workspace, state, requirements }
}

function validateCandidateMetadata(raw, appVersion, sourceCommit) {
  const value = object(raw, 'candidate metadata')
  exactKeys(value, ['version', 'sourceCommit', 'bundleSha256', 'executableSha256', 'teamId', 'signingIdentity', 'cdhash'], 'candidate metadata')
  if (value.version !== appVersion) throw new Error('candidate metadata version differs from acceptance app version')
  if (value.sourceCommit !== sourceCommit) throw new Error('candidate metadata source commit differs from acceptance source')
  for (const key of ['bundleSha256', 'executableSha256']) {
    if (!SHA256.test(value[key] ?? '')) throw new Error(`candidate metadata ${key} is invalid`)
  }
  nonEmpty(value.teamId, 'candidate metadata teamId')
  nonEmpty(value.signingIdentity, 'candidate metadata signingIdentity')
  nonEmpty(value.cdhash, 'candidate metadata cdhash')
  return value
}

function customTarget(definition) {
  const { targetId: mode, ...binding } = typeof definition === 'string'
    ? { targetId: definition, targetKey: definition } : definition
  return mode === 'manual_mcp_client'
    ? {
        ...binding,
        targetId: mode,
        sourceCatalogId: null,
        disposition: 'custom',
        policyDisposition: 'guided',
        targetCapability: 2,
        requiredComponents: ['memory_tools'],
        requiredLifecycle: null,
      }
    : {
        ...binding,
        targetId: mode,
        sourceCatalogId: null,
        disposition: 'custom',
        policyDisposition: 'managed',
        targetCapability: null,
        requiredComponents: [],
        requiredLifecycle: null,
      }
}

function captureTarget(requirements, definition) {
  return {
    targetKey: definition.targetKey ?? definition.targetId,
    targetId: definition.catalogId ?? definition.targetId,
    configurationOwnership: definition.configurationOwnership ?? null,
    architecture: definition.architecture ?? null,
    sourceCatalogId: definition.sourceCatalogId ?? null,
    disposition: definition.disposition,
    targetCapability: definition.targetCapability,
    requiredSteps: definition.targetCapability === null
      ? []
      : [...requiredHostAcceptanceSteps(requirements, definition)],
    releaseAcceptedExactVersions: Array.isArray(definition.releaseAcceptedExactVersions)
      ? [...definition.releaseAcceptedExactVersions]
      : [],
    officialDistributions: Array.isArray(definition.officialDistributions)
      ? definition.officialDistributions.map(distribution => ({ ...distribution }))
      : [],
    acceptedDistributionArtifacts: Array.isArray(definition.acceptedDistributionArtifacts)
      ? definition.acceptedDistributionArtifacts.map(receipt => structuredClone(receipt))
      : [],
    hostVersion: null,
    distribution: null,
    environment: null,
    installationId: null,
    agentId: null,
    customBinding: null,
    metadataExport: null,
    steps: [],
  }
}

export function initializeAgentHostAcceptanceCapture({
  workspace: workspaceInput,
  acceptanceId,
  sourceCommit,
  candidateAppPathsByArchitecture,
  candidateMetadataPathsByArchitecture,
  now = () => new Date(),
  testOnlyAllowUnacceptedRelease = false,
}) {
  const workspace = absoluteWorkspace(workspaceInput, false)
  if (fs.existsSync(workspace)) throw new Error('capture init refuses an existing workspace')
  nonEmpty(acceptanceId, 'acceptanceId')
  if (!SOURCE_COMMIT.test(sourceCommit ?? '')) throw new Error('source commit must be a full hexadecimal commit SHA')
  const requirements = loadAgentHostAcceptanceRequirements()
  const unaccepted = requirements.entries.filter(entry => (
    !Array.isArray(entry.releaseAcceptedExactVersions)
    || entry.releaseAcceptedExactVersions.length === 0
  )).map(entry => entry.catalogId)
  if (unaccepted.length > 0 && !testOnlyAllowUnacceptedRelease) {
    throw new Error(`capture requires a frozen candidate release contract with accepted exact versions: ${unaccepted.join(', ')}`)
  }
  for (const architecture of requirements.releaseMacArchitectures) {
    const input = testOnlyAllowUnacceptedRelease
      ? candidateMetadataPathsByArchitecture?.[architecture]
      : candidateAppPathsByArchitecture?.[architecture]
    if (typeof input !== 'string' || !path.isAbsolute(input)) {
      throw new Error(`capture init requires an absolute ${architecture} candidate ${testOnlyAllowUnacceptedRelease ? 'metadata' : 'app'} path`)
    }
  }
  const candidateAppsByArchitecture = Object.fromEntries(requirements.releaseMacArchitectures.map(architecture => {
    const metadataPath = candidateMetadataPathsByArchitecture?.[architecture]
    const appPath = candidateAppPathsByArchitecture?.[architecture]
    const candidate = testOnlyAllowUnacceptedRelease && metadataPath
      ? validateCandidateMetadata(readJson(metadataPath, `${architecture} candidate metadata`).value, requirements.appVersion, sourceCommit)
      : inspectPhysicalTideMindCandidateApp(appPath, requirements.appVersion, sourceCommit, architecture)
    return [architecture, candidate]
  }))
  fs.mkdirSync(workspace, { recursive: false, mode: 0o700 })
  const state = {
    captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
    acceptanceSchemaVersion: AGENT_HOST_ACCEPTANCE_SCHEMA_VERSION,
    status: 'collecting',
    acceptanceId,
    evidenceClass: 'real_host',
    appVersion: requirements.appVersion,
    upgradeFromAppVersions: [...requirements.upgradeFromAppVersions],
    sourceCommit,
    createdAt: now().toISOString(),
    captureNonce: crypto.randomBytes(32).toString('hex'),
    requirementsSha256: requirements.sha256,
    releaseContractSha256: requirements.releaseContractSha256,
    candidateAppsByArchitecture,
    candidateAppPathsByArchitecture: testOnlyAllowUnacceptedRelease
      ? null
      : Object.fromEntries(requirements.releaseMacArchitectures.map(architecture => [architecture, path.resolve(candidateAppPathsByArchitecture[architecture])])),
    releaseContractReady: unaccepted.length === 0,
    entries: requirements.targets.map(entry => captureTarget(requirements, entry)),
    customPaths: requirements.customTargets.map(definition => captureTarget(requirements, customTarget(definition))),
    upgradePaths: [],
    activityExports: [],
    preparedEvidenceManifestSha256: null,
  }
  writeJsonExclusive(path.join(workspace, STATE_FILE), state)
  return captureStatus(state)
}

export function exportAgentHostActivityReceipt({
  workspace: workspaceInput,
  targetId,
  eventId,
  outputPath,
}) {
  const { workspace, state } = loadState(workspaceInput)
  if (!/^aha_[a-f0-9]{24}$/u.test(eventId ?? '')) throw new Error('activity export event ID is invalid')
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw new Error('activity receipt output must be absolute')
  const target = findTarget(state, targetId)
  if (!target.environment) throw new Error('target metadata must be recorded before activity export')
  if (!state.candidateAppPathsByArchitecture) throw new Error('activity export requires the exact physical candidate app')
  const candidateAppPath = state.candidateAppPathsByArchitecture[target.environment.architecture]
  const candidateApp = state.candidateAppsByArchitecture[target.environment.architecture]
  const exporter = path.join(
    candidateAppPath,
    'Contents', 'Resources', 'app.asar.unpacked', 'out', 'bin', 'agent-host-activity-export.cjs',
  )
  const output = executeFrozenCandidateExporter(state, target.environment.architecture, [
    exporter,
    '--event-id', eventId,
    '--capture-nonce', state.captureNonce,
    '--target-key', target.targetKey,
    '--candidate-bundle-sha256', candidateApp.bundleSha256,
    '--source-commit', state.sourceCommit,
    '--release-contract-sha256', state.releaseContractSha256,
  ])
  const receipt = JSON.parse(output)
  validateExportedActivityReceipt(receipt, { ...state, targetKey: target.targetKey, candidateBundleSha256: candidateApp.bundleSha256 })
  if (state.activityExports.some(entry => entry.eventId === receipt.id)) {
    throw new Error(`activity event was already exported for this capture: ${receipt.id}`)
  }
  writeJsonExclusive(path.resolve(outputPath), receipt)
  state.activityExports.push({
    eventId: receipt.id,
    targetKey: target.targetKey,
    exportHash: receipt.exportHash,
    outputPath: path.resolve(outputPath),
    consumed: false,
  })
  writeState(workspace, state)
  return receipt
}

function validateExportedActivityReceipt(value, state) {
  const candidateBundleSha256 = state.candidateBundleSha256
  if (value.exporterVersion !== 1
    || value.captureNonce !== state.captureNonce
    || value.targetKey !== state.targetKey
    || value.candidateBundleSha256 !== candidateBundleSha256
    || value.sourceCommit !== state.sourceCommit
    || value.releaseContractSha256 !== state.releaseContractSha256
    || value.ledgerSource !== (state.allowFixtureActivity ? 'fixture' : 'real_profile')
    || value.databaseSchemaVersion !== 34
    || value.exportHash !== hostActivityLedgerExportHash(value)) {
    throw new Error('activity receipt was not exported for this frozen candidate capture')
  }
  return value
}

function validateTargetMetadata(raw, expectedTarget, allowMissingArtifactReceipt = false) {
  const value = object(raw, 'target metadata')
  const expectedKeys = [
    'targetKey', 'targetId', 'hostVersion', 'distribution', 'environment', 'installationId', 'agentId',
    ...(expectedTarget.targetId === 'nonstandard_config_root' ? ['sourceCatalogId'] : []),
    ...(expectedTarget.disposition === 'custom' ? ['customBinding'] : []),
  ]
  exactKeys(value, expectedKeys, 'target metadata')
  if (value.targetKey !== expectedTarget.targetKey) throw new Error('target metadata targetKey mismatch')
  if (value.targetId !== expectedTarget.targetId) throw new Error('target metadata targetId mismatch')
  if (expectedTarget.targetId === 'nonstandard_config_root') {
    nonEmpty(value.sourceCatalogId, 'target metadata sourceCatalogId')
  }
  nonEmpty(value.hostVersion, 'target metadata hostVersion')
  const distribution = object(value.distribution, 'target distribution')
  exactKeys(distribution, [
    'distributionId', 'packageProvenance', 'artifactReceiptSha256', 'portableArtifactFingerprint',
    'executableSha256', 'executableSizeBytes', 'distributionSha256', 'distributionSizeBytes',
    'rawExecutableSha256', 'rawExecutableSizeBytes',
  ], 'target distribution')
  nonEmpty(distribution.distributionId, 'target distribution distributionId')
  nonEmpty(distribution.packageProvenance, 'target distribution packageProvenance')
  if ((!allowMissingArtifactReceipt && !SHA256.test(distribution.artifactReceiptSha256 ?? ''))
    || (allowMissingArtifactReceipt && distribution.artifactReceiptSha256 !== null
      && !SHA256.test(distribution.artifactReceiptSha256 ?? ''))
    || !SHA256.test(distribution.executableSha256 ?? '') || !SHA256.test(distribution.distributionSha256 ?? '')
    || !SHA256.test(distribution.rawExecutableSha256 ?? '')
    || !Number.isSafeInteger(distribution.rawExecutableSizeBytes) || distribution.rawExecutableSizeBytes <= 0
    || (!allowMissingArtifactReceipt
      && (typeof distribution.portableArtifactFingerprint !== 'string' || distribution.portableArtifactFingerprint.length === 0))
    || (allowMissingArtifactReceipt && distribution.portableArtifactFingerprint !== null
      && (typeof distribution.portableArtifactFingerprint !== 'string' || distribution.portableArtifactFingerprint.length === 0))
    || !Number.isSafeInteger(distribution.executableSizeBytes) || distribution.executableSizeBytes <= 0
    || !Number.isSafeInteger(distribution.distributionSizeBytes) || distribution.distributionSizeBytes <= 0) {
    throw new Error('target distribution hashes are invalid')
  }
  const environment = object(value.environment, 'target environment')
  validateAgentHostAcceptanceEnvironment(environment, 'target')
  if (expectedTarget.architecture && environment.architecture !== expectedTarget.architecture) {
    throw new Error('target metadata architecture mismatch')
  }
  nonEmpty(value.installationId, 'target metadata installationId')
  nonEmpty(value.agentId, 'target metadata agentId')
  if (expectedTarget.disposition === 'custom') {
    if ((value.customBinding?.configurationOwnership === 'user') !== (expectedTarget.configurationOwnership === 'user')) {
      throw new Error('Custom target configuration ownership mismatch')
    }
    const customBinding = validateCustomTargetBinding(value.customBinding, expectedTarget.targetId, value)
    if (expectedTarget.targetId === 'nonstandard_config_root'
      && customBinding.sourceCatalogId !== value.sourceCatalogId) {
      throw new Error('Custom target source catalog binding mismatch')
    }
  }
  return value
}

function validateCustomTargetBinding(raw, expectedMode, expected) {
  const value = object(raw, 'Custom target binding')
  exactKeys(value, [
    'kind', 'sourceInstallationId', 'sourceCatalogId', 'configRootIdentitySha256',
    'configFileIdentitySha256', 'selectorIdentitySha256', 'executableFingerprint',
    'sourceLiveTrustProofSha256', 'liveTrustProofSha256', 'readBackProofSha256',
    ...(value.configurationOwnership === 'user' ? ['configurationOwnership', 'activityBinding'] : []),
  ], 'Custom target binding')
  if (value.kind !== expectedMode) throw new Error('Custom target binding mode mismatch')
  for (const key of ['configRootIdentitySha256', 'selectorIdentitySha256', 'liveTrustProofSha256']) {
    if (!SHA256.test(value[key] ?? '')) throw new Error(`Custom target binding ${key} is invalid`)
  }
  if (value.configurationOwnership === 'user') {
    if (expectedMode !== 'manual_mcp_client' || value.configFileIdentitySha256 !== null || value.readBackProofSha256 !== null
      || value.sourceInstallationId !== null || value.sourceCatalogId !== null || value.sourceLiveTrustProofSha256 !== null
      || !SHA256.test(value.executableFingerprint ?? '')) throw new Error('user-owned Custom target binding is invalid')
    validateUserOwnedCustomActivityBinding(value.activityBinding, expected)
    return value
  }
  if (!SHA256.test(value.readBackProofSha256 ?? '')) throw new Error('Custom target read-back proof is invalid')
  if (expectedMode === 'nonstandard_config_root') {
    nonEmpty(value.sourceInstallationId, 'Custom source Installation')
    nonEmpty(value.sourceCatalogId, 'Custom source catalog')
    if (!SHA256.test(value.sourceLiveTrustProofSha256 ?? '')
      || value.configFileIdentitySha256 !== null
      || value.executableFingerprint !== null) {
      throw new Error('nonstandard Custom target binding is invalid')
    }
  } else if (value.sourceInstallationId !== null
    || value.sourceCatalogId !== null
    || value.sourceLiveTrustProofSha256 !== null
    || !SHA256.test(value.configFileIdentitySha256 ?? '')
    || !SHA256.test(value.executableFingerprint ?? '')) {
    throw new Error('manual Custom target binding is invalid')
  }
  return value
}

function findTarget(state, targetKey) {
  const target = [...state.entries, ...state.customPaths].find(candidate => candidate.targetKey === targetKey)
  if (!target) throw new Error(`unknown acceptance target: ${targetKey}`)
  return target
}

function invalidatePreparation(state) {
  state.preparedEvidenceManifestSha256 = null
  delete state.preparedAt
}

function candidateForTarget(state, target) {
  const architecture = target.environment?.architecture
  const candidate = architecture && state.candidateAppsByArchitecture?.[architecture]
  if (!candidate) throw new Error(`no frozen Tide Mind candidate for target architecture: ${String(architecture)}`)
  return candidate
}

function recordAgentHostAcceptanceTargetValue({ workspace: workspaceInput, targetId: targetKey, metadata, metadataExport = null }) {
  const { workspace, state, requirements } = loadState(workspaceInput)
  const target = findTarget(state, targetKey)
  if (target.steps.length > 0) throw new Error('target metadata cannot change after step evidence is recorded')
  const validatedMetadata = validateTargetMetadata(
    metadata,
    target,
    !state.releaseContractReady || target.targetId === 'manual_mcp_client',
  )
  if (target.targetId === 'nonstandard_config_root') {
    const source = requirements.entries.find(entry => entry.catalogId === validatedMetadata.sourceCatalogId)
    if (!source) throw new Error(`Custom nonstandard source is not a released host: ${validatedMetadata.sourceCatalogId}`)
    if (source.customConfigRoot?.supported !== true) {
      throw new Error(`Custom nonstandard source has no released relocatable-root contract: ${validatedMetadata.sourceCatalogId}`)
    }
    target.sourceCatalogId = source.catalogId
    target.targetCapability = source.targetCapability
    target.requiredComponents = [...source.requiredComponents]
    target.requiredLifecycle = source.requiredLifecycle
      ? { signals: [...source.requiredLifecycle.signals], require: 'all' }
      : null
    target.requiredSteps = [...requiredHostAcceptanceSteps(requirements, {
      ...source,
      targetId: target.targetId,
      disposition: 'custom',
      policyDisposition: source.disposition,
    })]
    target.releaseAcceptedExactVersions = [...source.releaseAcceptedExactVersions]
    target.officialDistributions = source.officialDistributions.map(distribution => ({ ...distribution }))
    target.acceptedDistributionArtifacts = source.acceptedDistributionArtifacts.map(receipt => structuredClone(receipt))
  }
  if (target.releaseAcceptedExactVersions.length > 0
    && !target.releaseAcceptedExactVersions.includes(validatedMetadata.hostVersion)) {
    throw new Error(`target host version is not accepted by the frozen release contract: ${validatedMetadata.hostVersion}`)
  }
  if (target.officialDistributions.length > 0 && !target.officialDistributions.some(candidate => (
    candidate.distributionId === validatedMetadata.distribution.distributionId
    && candidate.packageProvenance === validatedMetadata.distribution.packageProvenance
    && candidate.supportedMacArchitectures.includes(validatedMetadata.environment.architecture)
  ))) {
    throw new Error('target distribution is not accepted by the frozen release contract')
  }
  const artifactReceipt = target.acceptedDistributionArtifacts.find(receipt => (
    receipt.distributionId === validatedMetadata.distribution.distributionId
    && receipt.packageProvenance === validatedMetadata.distribution.packageProvenance
    && receipt.version === validatedMetadata.hostVersion
    && receipt.architecture === validatedMetadata.environment.architecture
  ))
  const customManualPath = target.targetId === 'manual_mcp_client'
  if (!['qwen-standalone-surface-v1', 'openclaw-official-wrapper-v1'].includes(artifactReceipt?.portableFingerprintSchema)
    && (validatedMetadata.distribution.rawExecutableSha256 !== validatedMetadata.distribution.executableSha256
      || validatedMetadata.distribution.rawExecutableSizeBytes !== validatedMetadata.distribution.executableSizeBytes)) {
    throw new Error('non-portable target raw executable differs from its distribution executable')
  }
  if (!artifactReceipt && state.releaseContractReady && !customManualPath) {
    throw new Error('target has no immutable artifact receipt in the frozen release contract')
  }
  if (artifactReceipt && (
    validatedMetadata.distribution.artifactReceiptSha256 !== distributionArtifactReceiptSha256(artifactReceipt)
    || validatedMetadata.distribution.portableArtifactFingerprint !== artifactReceipt.portableArtifactFingerprint
    || validatedMetadata.distribution.executableSha256 !== artifactReceipt.executableSha256
    || validatedMetadata.distribution.executableSizeBytes !== artifactReceipt.executableSizeBytes
    || validatedMetadata.distribution.distributionSha256 !== artifactReceipt.distributionSha256
    || validatedMetadata.distribution.distributionSizeBytes !== artifactReceipt.distributionSizeBytes
  )) throw new Error('target physical installation proof does not match its immutable artifact receipt')
  target.hostVersion = validatedMetadata.hostVersion
  target.distribution = validatedMetadata.distribution
  target.environment = validatedMetadata.environment
  target.installationId = validatedMetadata.installationId
  target.agentId = validatedMetadata.agentId
  target.customBinding = validatedMetadata.customBinding ?? null
  if (target.targetId === 'manual_mcp_client') {
    target.requiredSteps = [...requiredHostAcceptanceSteps(requirements, {
      ...customTarget({ targetId: target.targetId, targetKey: target.targetKey, configurationOwnership: target.configurationOwnership }),
    })]
  }
  target.metadataExport = metadataExport
  invalidatePreparation(state)
  writeState(workspace, state)
  return { targetKey, targetId: target.targetId, requiredSteps: target.requiredSteps, recordedSteps: [] }
}

/** Explicit fixture seam. Formal CLI never exposes arbitrary target metadata. */
export function recordAgentHostAcceptanceTarget({
  workspace,
  targetId,
  metadataPath,
  testOnlyAllowFixtureMetadata = false,
}) {
  if (!testOnlyAllowFixtureMetadata) {
    throw new Error('direct target metadata input is fixture-only; use the signed candidate exporter')
  }
  return recordAgentHostAcceptanceTargetValue({
    workspace,
    targetId,
    metadata: readJson(metadataPath, 'fixture target metadata').value,
  })
}

function validateTargetMetadataExport(raw, state, target, candidate) {
  const value = object(raw, 'target metadata export')
  exactKeys(value, [
    'exporterVersion', 'evidenceClass', 'candidateBundleSha256', 'sourceCommit',
    'releaseContractSha256', 'targetMetadata', 'exportedAt', 'exportHash',
  ], 'target metadata export')
  if (value.exporterVersion !== 1 || value.evidenceClass !== 'real_host') {
    throw new Error('formal capture requires a real-host target metadata export')
  }
  if (value.candidateBundleSha256 !== candidate.bundleSha256
    || value.sourceCommit !== state.sourceCommit
    || value.releaseContractSha256 !== state.releaseContractSha256
    || value.exportHash !== hostAcceptanceTargetMetadataExportHash(value)) {
    throw new Error('target metadata export does not bind this frozen candidate capture')
  }
  const exportedAt = canonicalIso(value.exportedAt, 'target metadata exportedAt')
  if (Date.parse(exportedAt) < Date.parse(state.createdAt) || Date.parse(exportedAt) > Date.now() + 60_000) {
    throw new Error('target metadata export timestamp is outside this capture')
  }
  const metadata = validateTargetMetadata(
    value.targetMetadata,
    target,
    target.targetId === 'manual_mcp_client',
  )
  if (metadata.customBinding?.configurationOwnership === 'user') {
    validateUserOwnedCustomActivityBinding(metadata.customBinding.activityBinding, {
      ...metadata, tideMindVersion: state.appVersion, exportedAt,
    })
  }
  if (metadata.targetKey !== target.targetKey) throw new Error('target metadata export targetKey mismatch')
  return metadata
}

export function exportAndRecordAgentHostAcceptanceTarget({
  workspace: workspaceInput,
  targetId: targetKey,
  outputPath,
}) {
  const { state } = loadState(workspaceInput)
  const target = findTarget(state, targetKey)
  if (!state.releaseContractReady || !state.candidateAppPathsByArchitecture) {
    throw new Error('formal target metadata export requires a frozen release contract and physical candidate')
  }
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) {
    throw new Error('target metadata export output must be absolute')
  }
  const output = path.resolve(outputPath)
  const architecture = target.architecture ?? (process.arch === 'x64' ? 'x64' : 'arm64')
  const candidateAppPath = state.candidateAppPathsByArchitecture[architecture]
  const candidate = state.candidateAppsByArchitecture[architecture]
  const exporter = path.join(
    candidateAppPath,
    'Contents', 'Resources', 'app.asar.unpacked', 'out', 'bin', 'agent-host-target-metadata-export.cjs',
  )
  executeFrozenCandidateExporter(state, architecture, [
    exporter,
    '--target-key', target.targetKey,
    '--candidate-bundle-sha256', candidate.bundleSha256,
    '--source-commit', state.sourceCommit,
    '--release-contract-sha256', state.releaseContractSha256,
    '--output', output,
  ])
  const metadataExport = readJson(output, 'target metadata export').value
  const metadata = validateTargetMetadataExport(
    metadataExport,
    state,
    target,
    candidate,
  )
  return recordAgentHostAcceptanceTargetValue({
    workspace: workspaceInput,
    targetId: targetKey,
    metadata,
    metadataExport,
  })
}

/** Execute only while the frozen, signed candidate matches at both boundaries. */
export function executeFrozenCandidateExporter(state, architecture, args) {
  const appPath = state.candidateAppPathsByArchitecture?.[architecture]
  const expected = state.candidateAppsByArchitecture?.[architecture]
  if (!expected || typeof appPath !== 'string' || !path.isAbsolute(appPath)) {
    throw new Error('export requires the exact physical candidate app')
  }
  const verify = () => {
    const actual = inspectPhysicalTideMindCandidateApp(appPath, state.appVersion, state.sourceCommit, architecture)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('export candidate differs from the frozen physical signed candidate')
    }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/^(?:NODE_|ELECTRON_|DYLD_|LD_|VSCODE_|BUN_)/iu.test(key)
  )))
  env.ELECTRON_RUN_AS_NODE = '1'
  verify()
  try {
    return execFileSync(path.join(appPath, 'Contents', 'MacOS', 'Tide Mind'), args, {
      encoding: 'utf8', env, timeout: 120_000, maxBuffer: MAX_INPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } finally {
    verify()
  }
}

function validateNoCredentialText(bytes, label) {
  if (bytes.length > MAX_TEXT_SCAN_BYTES) throw new Error(`${label} exceeds the safe text scan limit`)
  const text = bytes.toString('utf8')
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${label} appears to contain credential material`)
  }
}

function validateEvidenceInput(file) {
  const input = readRegularFile(file)
  const basename = path.basename(input.absolute)
  const extension = path.extname(basename).toLowerCase()
  if (!SAFE_EVIDENCE_EXTENSIONS.has(extension)) throw new Error(`unsafe evidence file type: ${basename}`)
  if (FORBIDDEN_EVIDENCE_NAMES.test(basename)) throw new Error(`credential-like evidence filename is forbidden: ${basename}`)
  if (FORBIDDEN_CONFIG_NAMES.test(basename)) throw new Error(`configuration-like evidence filename is forbidden: ${basename}`)
  const sourceSegments = input.absolute.split(path.sep).map(segment => segment.toLowerCase())
  if (sourceSegments.some(segment => FORBIDDEN_SOURCE_DIRECTORIES.has(segment))) {
    throw new Error(`evidence must not be read from an Agent or credential configuration directory: ${basename}`)
  }
  if (TEXT_EVIDENCE_EXTENSIONS.has(extension)) validateNoCredentialText(input.bytes, `evidence ${basename}`)
  return { ...input, basename, extension, sha256: sha256(input.bytes) }
}

function validateAssertion(raw, expected) {
  const value = object(raw, 'step assertion')
  exactKeys(value, [
    'schemaVersion', 'targetKey', 'targetId', 'stepId', 'sourceCommit', 'releaseContractSha256',
    'candidateBundleSha256', 'installationId', 'agentId', 'outcome', 'assertionSource',
    'assertedBy', 'observedAt', 'assertions', 'activityReceipt',
  ], 'step assertion')
  if (value.schemaVersion !== 2) throw new Error('unsupported step assertion schema')
  if (value.targetKey !== expected.targetKey || value.targetId !== expected.targetId || value.stepId !== expected.stepId) {
    throw new Error('step assertion target or step binding mismatch')
  }
  for (const key of ['sourceCommit', 'releaseContractSha256', 'candidateBundleSha256', 'installationId', 'agentId']) {
    if (value[key] !== expected[key]) throw new Error(`step assertion ${key} binding mismatch`)
  }
  if (value.outcome !== 'passed') throw new Error('step assertion must explicitly state business outcome passed')
  if (!['human', 'external'].includes(value.assertionSource)) throw new Error('step assertion source must be human or external')
  nonEmpty(value.assertedBy, 'step assertion assertedBy')
  const observedAt = canonicalIso(value.observedAt, 'step assertion observedAt')
  if (Date.parse(observedAt) < Date.parse(expected.captureCreatedAt)) {
    throw new Error('step assertion predates capture creation')
  }
  validateLifecycleActivityReceipt(value.activityReceipt, expected, observedAt)
  uniqueStrings(value.assertions, 'step assertions')
  validateNoCredentialText(Buffer.from(JSON.stringify(value)), 'step assertion')
  return value
}

function validateLifecycleActivityReceipt(raw, expected, assertionObservedAt) {
  const lifecycleSignal = expected.stepId.startsWith('lifecycle_')
    ? expected.stepId.slice('lifecycle_'.length)
    : null
  if (lifecycleSignal === null) {
    if (raw !== null) throw new Error('non-lifecycle step must not claim a lifecycle activity receipt')
    return null
  }
  const value = object(raw, 'lifecycle activity receipt')
  exactKeys(value, [
    'exporterVersion', 'ledgerSource', 'captureNonce', 'targetKey', 'candidateBundleSha256', 'sourceCommit',
    'releaseContractSha256', 'databaseSchemaVersion', 'databaseSchemaSha256',
    'id', 'installationId', 'agentId', 'hostVariant', 'componentKey', 'signalName',
    'tideMindVersion', 'adapterVersion', 'projectionVersion', 'hostVersion', 'evidenceHash', 'observedAt',
    'exportHash',
  ], 'lifecycle activity receipt')
  validateExportedActivityReceipt(value, expected)
  if (!/^aha_[a-f0-9]{24}$/u.test(value.id ?? '')) throw new Error('lifecycle activity receipt event ID is invalid')
  for (const [key, expectedValue] of Object.entries({
    installationId: expected.installationId,
    agentId: expected.agentId,
    hostVariant: expected.hostVariant,
    componentKey: 'lifecycle',
    signalName: lifecycleSignal,
    tideMindVersion: expected.appVersion,
    hostVersion: expected.hostVersion,
  })) {
    if (value[key] !== expectedValue) throw new Error(`lifecycle activity receipt ${key} binding mismatch`)
  }
  nonEmpty(value.adapterVersion, 'lifecycle activity receipt adapterVersion')
  nonEmpty(value.projectionVersion, 'lifecycle activity receipt projectionVersion')
  const observedAt = canonicalIso(value.observedAt, 'lifecycle activity receipt observedAt')
  if (Date.parse(observedAt) < Date.parse(expected.captureCreatedAt)
    || Date.parse(observedAt) > Date.parse(assertionObservedAt)) {
    throw new Error('lifecycle activity receipt time is outside the capture/assertion window')
  }
  if (value.evidenceHash !== hostActivityLedgerEvidenceHash(value)) {
    throw new Error('lifecycle activity receipt evidence hash mismatch')
  }
  return value
}

function validateUpgradeAssertion(raw, expected) {
  const value = object(raw, 'upgrade assertion')
  exactKeys(value, [
    'schemaVersion', 'targetKey', 'targetId', 'fromAppVersion', 'toAppVersion', 'sourceCommit',
    'releaseContractSha256', 'candidateBundleSha256', 'targetIdentitySha256', 'outcome', 'assertionSource',
    'assertedBy', 'observedAt', 'assertions', 'installationId', 'originalAgentId',
    'migratedAgentId', 'historyPreserved', 'statisticsPreserved',
  ], 'upgrade assertion')
  if (value.schemaVersion !== 2) throw new Error('unsupported upgrade assertion schema')
  if (value.targetKey !== expected.targetKey || value.targetId !== expected.targetId
    || value.fromAppVersion !== expected.fromAppVersion || value.toAppVersion !== expected.toAppVersion) {
    throw new Error('upgrade assertion target or version binding mismatch')
  }
  for (const key of ['sourceCommit', 'releaseContractSha256', 'candidateBundleSha256', 'targetIdentitySha256']) {
    if (value[key] !== expected[key]) throw new Error(`upgrade assertion ${key} binding mismatch`)
  }
  if (value.outcome !== 'passed') throw new Error('upgrade assertion must explicitly state business outcome passed')
  if (!['human', 'external'].includes(value.assertionSource)) throw new Error('upgrade assertion source must be human or external')
  nonEmpty(value.assertedBy, 'upgrade assertion assertedBy')
  const observedAt = canonicalIso(value.observedAt, 'upgrade assertion observedAt')
  if (Date.parse(observedAt) < Date.parse(expected.captureCreatedAt)) {
    throw new Error('upgrade assertion predates capture creation')
  }
  uniqueStrings(value.assertions, 'upgrade assertions')
  nonEmpty(value.installationId, 'upgrade assertion installationId')
  nonEmpty(value.originalAgentId, 'upgrade assertion originalAgentId')
  nonEmpty(value.migratedAgentId, 'upgrade assertion migratedAgentId')
  if (value.originalAgentId !== value.migratedAgentId) throw new Error('upgrade assertion did not preserve Agent ID')
  if (value.historyPreserved !== true || value.statisticsPreserved !== true) {
    throw new Error('upgrade assertion must explicitly confirm history and statistics preservation')
  }
  validateNoCredentialText(Buffer.from(JSON.stringify(value)), 'upgrade assertion')
  return value
}

function validateAttestation(raw, evidenceInputs) {
  const value = object(raw, 'redaction attestation')
  exactKeys(value, ['schemaVersion', 'attestedBy', 'attestedAt', 'statement', 'files'], 'redaction attestation')
  if (value.schemaVersion !== 1) throw new Error('unsupported redaction attestation schema')
  nonEmpty(value.attestedBy, 'redaction attestation attestedBy')
  canonicalIso(value.attestedAt, 'redaction attestation attestedAt')
  if (value.statement !== REDACTION_STATEMENT) throw new Error('redaction attestation statement is not exact')
  if (!Array.isArray(value.files) || value.files.length !== evidenceInputs.length) {
    throw new Error('redaction attestation file count mismatch')
  }
  const expected = evidenceInputs.map(input => ({ name: input.basename, sha256: input.sha256 }))
  if (JSON.stringify(value.files) !== JSON.stringify(expected)) {
    throw new Error('redaction attestation does not bind the exact evidence bytes in order')
  }
  validateNoCredentialText(Buffer.from(JSON.stringify(value)), 'redaction attestation')
  return value
}

function safeSegment(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]/gu, '_').slice(0, 100)
}

function copyEvidenceSet(workspace, namespace, assertionInput, attestationInput, evidenceInputs) {
  const directory = path.join(workspace, 'files', ...namespace.map(safeSegment))
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const sources = [assertionInput, attestationInput, ...evidenceInputs]
  const relativePaths = []
  for (const [index, source] of sources.entries()) {
    const name = `${String(index + 1).padStart(2, '0')}-${sha256(source.bytes).slice(0, 16)}-${safeSegment(source.basename)}`
    const destination = path.join(directory, name)
    const descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try {
      fs.writeFileSync(descriptor, source.bytes)
    } finally {
      fs.closeSync(descriptor)
    }
    relativePaths.push(path.relative(workspace, destination).split(path.sep).join('/'))
  }
  return relativePaths
}

function writeReceipt(workspace, namespace, receipt) {
  const directory = path.join(workspace, 'files', ...namespace.map(safeSegment))
  const destination = path.join(directory, '00-receipt.json')
  writeJsonExclusive(destination, receipt)
  return path.relative(workspace, destination).split(path.sep).join('/')
}

function loadEvidenceInputs(evidencePaths) {
  if (!Array.isArray(evidencePaths) || evidencePaths.length === 0) {
    throw new Error('at least one pre-redacted supporting evidence file is required')
  }
  const inputs = evidencePaths.map(validateEvidenceInput)
  if (new Set(inputs.map(input => input.absolute)).size !== inputs.length) {
    throw new Error('supporting evidence files must not contain duplicates')
  }
  return inputs
}

export function recordAgentHostAcceptanceStep({
  workspace: workspaceInput,
  targetId: targetKey,
  stepId,
  assertionPath,
  attestationPath,
  evidencePaths,
}) {
  const { workspace, state } = loadState(workspaceInput)
  const target = findTarget(state, targetKey)
  const candidateApp = candidateForTarget(state, target)
  if (!target.hostVersion) throw new Error('target metadata must be recorded before step evidence')
  if (!target.requiredSteps.includes(stepId)) throw new Error(`step is not required for ${targetKey}: ${stepId}`)
  if (target.steps.some(step => step.id === stepId)) throw new Error(`step evidence already exists: ${targetKey}/${stepId}`)
  const assertionInput = readJson(assertionPath, 'step assertion')
  const assertion = validateAssertion(assertionInput.value, {
    targetKey,
    targetId: target.targetId,
    stepId,
    sourceCommit: state.sourceCommit,
    releaseContractSha256: state.releaseContractSha256,
    candidateBundleSha256: candidateApp.bundleSha256,
    installationId: target.installationId,
    agentId: target.agentId,
    hostVariant: target.sourceCatalogId ?? target.targetId,
    hostVersion: target.hostVersion,
    appVersion: state.appVersion,
    captureCreatedAt: state.createdAt,
    captureNonce: state.captureNonce,
    allowFixtureActivity: state.candidateAppPathsByArchitecture === null,
  })
  const activityExport = assertion.activityReceipt
    ? state.activityExports.find(entry => entry.eventId === assertion.activityReceipt.id)
    : null
  if (assertion.activityReceipt && (!activityExport
    || activityExport.consumed
    || activityExport.targetKey !== targetKey
    || activityExport.exportHash !== assertion.activityReceipt.exportHash)) {
    throw new Error('lifecycle activity receipt was not exported and remains unused in this capture workspace')
  }
  if (activityExport) {
    const exported = readJson(activityExport.outputPath, 'registered activity export').value
    if (JSON.stringify(exported) !== JSON.stringify(assertion.activityReceipt)) {
      throw new Error('lifecycle activity assertion differs from the registered exact-candidate export')
    }
  }
  const evidenceInputs = loadEvidenceInputs(evidencePaths)
  const attestationInput = readJson(attestationPath, 'redaction attestation')
  validateAttestation(attestationInput.value, evidenceInputs)
  const namespace = ['targets', targetKey, stepId]
  const copied = copyEvidenceSet(workspace, namespace, {
    ...assertionInput,
    basename: 'assertion.json',
  }, {
    ...attestationInput,
    basename: 'redaction-attestation.json',
  }, evidenceInputs)
  const evidenceIds = copied.map(relative => sha256(fs.readFileSync(path.join(workspace, ...relative.split('/')))))
  const outcomeDigest = hostAcceptanceStepOutcomeDigest({
    targetKey,
    targetId: target.targetId,
    stepId,
    status: 'passed',
    observedAt: assertion.observedAt,
    assertionSource: assertion.assertionSource,
    assertedBy: assertion.assertedBy,
    assertions: assertion.assertions,
    installationId: target.installationId,
    agentId: target.agentId,
    sourceCommit: state.sourceCommit,
    releaseContractSha256: state.releaseContractSha256,
    candidateBundleSha256: candidateApp.bundleSha256,
    activityEvidenceHash: assertion.activityReceipt?.evidenceHash ?? null,
    evidenceIds,
  })
  const receipt = {
    targetKey,
    targetId: target.targetId,
    stepId,
    appVersion: state.appVersion,
    sourceCommit: state.sourceCommit,
    candidateBundleSha256: candidateApp.bundleSha256,
    releaseContractSha256: state.releaseContractSha256,
    hostVersion: target.hostVersion,
    installationId: target.installationId,
    agentId: target.agentId,
    evidenceIds,
    outcomeDigest,
  }
  const receiptPath = writeReceipt(workspace, namespace, receipt)
  target.steps.push({
    id: stepId,
    status: 'passed',
    observedAt: assertion.observedAt,
    assertionSource: assertion.assertionSource,
    assertedBy: assertion.assertedBy,
    assertions: assertion.assertions,
    receipt,
    evidenceFiles: [receiptPath, ...copied],
    redactionAttestedBy: attestationInput.value.attestedBy,
  })
  if (activityExport) activityExport.consumed = true
  invalidatePreparation(state)
  writeState(workspace, state)
  return { targetKey, targetId: target.targetId, stepId, outcomeDigest, evidenceFileCount: copied.length + 1 }
}

export function recordAgentHostAcceptanceUpgrade({
  workspace: workspaceInput,
  targetId: targetKey,
  fromAppVersion,
  assertionPath,
  attestationPath,
  evidencePaths,
}) {
  const { workspace, state, requirements } = loadState(workspaceInput)
  if (!requirements.upgradeFromAppVersions.includes(fromAppVersion)) {
    throw new Error(`upgrade source version is not required: ${fromAppVersion}`)
  }
  const upgradeTarget = state.entries.find(target => target.targetKey === targetKey)
  if (!upgradeTarget) throw new Error(`upgrade target is not a released P0 surface: ${targetKey}`)
  const candidateApp = candidateForTarget(state, upgradeTarget)
  if (!upgradeTarget.hostVersion || !upgradeTarget.distribution || !upgradeTarget.environment) {
    throw new Error(`upgrade target metadata must be recorded first: ${targetKey}`)
  }
  if (state.upgradePaths.some(upgrade => upgrade.targetKey === targetKey && upgrade.fromAppVersion === fromAppVersion)) {
    throw new Error(`upgrade evidence already exists: ${targetKey}/${fromAppVersion}`)
  }
  const assertionInput = readJson(assertionPath, 'upgrade assertion')
  const targetIdentitySha256 = hostAcceptanceTargetIdentityDigest(upgradeTarget)
  const assertion = validateUpgradeAssertion(assertionInput.value, {
    targetKey,
    targetId: upgradeTarget.targetId,
    fromAppVersion,
    toAppVersion: state.appVersion,
    sourceCommit: state.sourceCommit,
    releaseContractSha256: state.releaseContractSha256,
    candidateBundleSha256: candidateApp.bundleSha256,
    targetIdentitySha256,
    captureCreatedAt: state.createdAt,
  })
  const evidenceInputs = loadEvidenceInputs(evidencePaths)
  const attestationInput = readJson(attestationPath, 'redaction attestation')
  validateAttestation(attestationInput.value, evidenceInputs)
  const namespace = ['upgrades', targetKey, fromAppVersion]
  const copied = copyEvidenceSet(workspace, namespace, {
    ...assertionInput,
    basename: 'assertion.json',
  }, {
    ...attestationInput,
    basename: 'redaction-attestation.json',
  }, evidenceInputs)
  const evidenceIds = copied.map(relative => sha256(fs.readFileSync(path.join(workspace, ...relative.split('/')))))
  const digestInput = {
    targetKey,
    targetId: upgradeTarget.targetId,
    fromAppVersion,
    toAppVersion: state.appVersion,
    status: 'passed',
    observedAt: assertion.observedAt,
    assertionSource: assertion.assertionSource,
    assertedBy: assertion.assertedBy,
    assertions: assertion.assertions,
    installationId: assertion.installationId,
    originalAgentId: assertion.originalAgentId,
    migratedAgentId: assertion.migratedAgentId,
    historyPreserved: assertion.historyPreserved,
    statisticsPreserved: assertion.statisticsPreserved,
    targetIdentitySha256,
    evidenceIds,
  }
  const receipt = {
    targetKey,
    targetId: upgradeTarget.targetId,
    fromAppVersion,
    toAppVersion: state.appVersion,
    sourceCommit: state.sourceCommit,
    candidateBundleSha256: candidateApp.bundleSha256,
    releaseContractSha256: state.releaseContractSha256,
    targetIdentitySha256,
    installationId: assertion.installationId,
    originalAgentId: assertion.originalAgentId,
    migratedAgentId: assertion.migratedAgentId,
    evidenceIds,
    outcomeDigest: hostAcceptanceUpgradeOutcomeDigest({
      ...digestInput,
      sourceCommit: state.sourceCommit,
      releaseContractSha256: state.releaseContractSha256,
      candidateBundleSha256: candidateApp.bundleSha256,
    }),
  }
  const receiptPath = writeReceipt(workspace, namespace, receipt)
  state.upgradePaths.push({
    ...digestInput,
    receipt,
    evidenceFiles: [receiptPath, ...copied],
    redactionAttestedBy: attestationInput.value.attestedBy,
  })
  invalidatePreparation(state)
  writeState(workspace, state)
  return { targetKey, targetId: upgradeTarget.targetId, fromAppVersion, outcomeDigest: receipt.outcomeDigest, evidenceFileCount: copied.length + 1 }
}

function captureStatus(state) {
  const targets = [...state.entries, ...state.customPaths]
  return {
    acceptanceId: state.acceptanceId,
    appVersion: state.appVersion,
    sourceCommit: state.sourceCommit,
    targetCount: targets.length,
    completedTargetCount: targets.filter(target => (
      target.hostVersion && target.steps.length === target.requiredSteps.length
    )).length,
    requiredStepCount: targets.reduce((sum, target) => sum + target.requiredSteps.length, 0),
    recordedStepCount: targets.reduce((sum, target) => sum + target.steps.length, 0),
    requiredUpgradePaths: state.entries
      .flatMap(target => state.upgradeFromAppVersions.map(fromAppVersion => `${target.targetKey}/${fromAppVersion}`)),
    recordedUpgradePaths: state.upgradePaths.map(upgrade => `${upgrade.targetKey}/${upgrade.fromAppVersion}`),
    preparedEvidenceManifestSha256: state.preparedEvidenceManifestSha256,
    releaseContractReady: state.releaseContractReady,
  }
}

export function agentHostAcceptanceCaptureStatus(workspaceInput) {
  return captureStatus(loadState(workspaceInput).state)
}

function finalTarget(target) {
  return {
    targetKey: target.targetKey,
    targetId: target.targetId,
    sourceCatalogId: target.sourceCatalogId ?? null,
    disposition: target.disposition,
    targetCapability: target.targetCapability,
    hostVersion: target.hostVersion,
    distribution: target.distribution,
    environment: target.environment,
    installationId: target.installationId,
    agentId: target.agentId,
    customBinding: target.customBinding ?? null,
    metadataExport: target.metadataExport ?? null,
    steps: target.steps.map(({ redactionAttestedBy: _redactionAttestedBy, ...step }) => step),
  }
}

function finalUpgrade(upgrade) {
  const {
    redactionAttestedBy: _redactionAttestedBy,
    evidenceIds: _evidenceIds,
    ...result
  } = upgrade
  return result
}

function completeCapture(state) {
  const missing = []
  for (const target of [...state.entries, ...state.customPaths]) {
    if (!target.hostVersion) missing.push(`${target.targetKey}:metadata`)
    const recorded = new Set(target.steps.map(step => step.id))
    for (const step of target.requiredSteps) if (!recorded.has(step)) missing.push(`${target.targetKey}:${step}`)
  }
  for (const target of state.entries) {
    for (const version of state.upgradeFromAppVersions) {
      if (!state.upgradePaths.some(upgrade => (
        upgrade.targetKey === target.targetKey && upgrade.fromAppVersion === version
      ))) missing.push(`upgrade:${target.targetKey}/${version}`)
    }
  }
  if (missing.length > 0) throw new Error(`capture is incomplete: ${missing.join(', ')}`)
}

function referencedFiles(state) {
  return [
    ...state.entries.flatMap(target => target.steps.flatMap(step => step.evidenceFiles)),
    ...state.customPaths.flatMap(target => target.steps.flatMap(step => step.evidenceFiles)),
    ...state.upgradePaths.flatMap(upgrade => upgrade.evidenceFiles),
  ]
}

function evidenceManifest(workspace, state) {
  if (state.releaseContractReady !== true) {
    throw new Error('capture cannot be prepared or frozen before every release target has an accepted exact version')
  }
  completeCapture(state)
  const paths = referencedFiles(state)
  if (new Set(paths).size !== paths.length) throw new Error('capture reuses an evidence file across records')
  const files = paths.map(relative => {
    if (path.posix.normalize(relative) !== relative || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      throw new Error(`capture contains an unsafe evidence path: ${relative}`)
    }
    const absolute = path.join(workspace, ...relative.split('/'))
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`capture evidence is not a regular file: ${relative}`)
    const bytes = fs.readFileSync(absolute)
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) }
  }).sort((left, right) => left.path.localeCompare(right.path))
  const manifestSha256 = sha256(Buffer.from(JSON.stringify(files)))
  return { files, manifestSha256 }
}

export function prepareAgentHostAcceptanceReview({ workspace: workspaceInput, outputPath, now = () => new Date() }) {
  const { workspace, state } = loadState(workspaceInput)
  const { files, manifestSha256 } = evidenceManifest(workspace, state)
  const request = {
    schemaVersion: 1,
    acceptanceId: state.acceptanceId,
    evidenceClass: 'real_host',
    appVersion: state.appVersion,
    upgradeFromAppVersions: [...state.upgradeFromAppVersions],
    sourceCommit: state.sourceCommit,
    preparedAt: now().toISOString(),
    requirementsSha256: state.requirementsSha256,
    releaseContractSha256: state.releaseContractSha256,
    candidateAppsByArchitecture: state.candidateAppsByArchitecture,
    candidateAppsSha256: candidateAppsIdentityHash(state.candidateAppsByArchitecture),
    evidenceManifestSha256: manifestSha256,
    evidenceFileCount: files.length,
  }
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) {
    throw new Error('review request output must be an absolute path')
  }
  writeJsonExclusive(path.resolve(outputPath), request)
  state.preparedEvidenceManifestSha256 = manifestSha256
  state.preparedAt = request.preparedAt
  writeState(workspace, state)
  return request
}

function validateReview(raw, state, evidenceManifestSha256) {
  const review = object(raw, 'independent review')
  exactKeys(review, [
    'reviewer', 'reviewedAt', 'decision', 'evidenceManifestSha256',
    'candidateAppsSha256', 'releaseContractSha256',
  ], 'independent review')
  nonEmpty(review.reviewer, 'reviewer')
  canonicalIso(review.reviewedAt, 'reviewedAt')
  if (review.decision !== 'approved') throw new Error('independent review must explicitly approve the evidence')
  if (review.evidenceManifestSha256 !== evidenceManifestSha256
    || review.candidateAppsSha256 !== candidateAppsIdentityHash(state.candidateAppsByArchitecture)
    || review.releaseContractSha256 !== state.releaseContractSha256) {
    throw new Error('independent review does not bind the prepared evidence and candidate')
  }
  const operators = new Set([
    ...state.entries.flatMap(target => target.steps.flatMap(step => [step.assertedBy, step.redactionAttestedBy])),
    ...state.customPaths.flatMap(target => target.steps.flatMap(step => [step.assertedBy, step.redactionAttestedBy])),
    ...state.upgradePaths.flatMap(upgrade => [upgrade.assertedBy, upgrade.redactionAttestedBy]),
  ])
  if (operators.has(review.reviewer)) throw new Error('reviewer must be independent from all assertors and redaction attestors')
  return review
}

export function freezeAgentHostAcceptanceCapture({
  workspace: workspaceInput,
  reviewPath,
  outputDirectory,
  now = () => new Date(),
}) {
  const { workspace, state } = loadState(workspaceInput)
  const { files, manifestSha256 } = evidenceManifest(workspace, state)
  if (!state.preparedEvidenceManifestSha256
    || state.preparedEvidenceManifestSha256 !== manifestSha256) {
    throw new Error('capture must be prepared for independent review after its last change')
  }
  const review = validateReview(readJson(reviewPath, 'independent review').value, state, manifestSha256)
  const generatedAt = now().toISOString()
  if (Date.parse(review.reviewedAt) > Date.parse(generatedAt)) throw new Error('reviewedAt must not be in the future')
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
    throw new Error('frozen acceptance output must be an absolute path')
  }
  const output = path.resolve(outputDirectory)
  if (output === path.parse(output).root || fs.existsSync(output)) {
    throw new Error('frozen acceptance output must be a new non-root directory')
  }
  const parent = path.dirname(output)
  const parentStat = fs.lstatSync(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || fs.realpathSync(parent) !== parent) {
    throw new Error('frozen acceptance output parent must be an existing real directory')
  }
  const staging = fs.mkdtempSync(path.join(parent, '.agent-host-acceptance-freeze-'))
  try {
    for (const file of files) {
      const source = path.join(workspace, ...file.path.split('/'))
      const destination = path.join(staging, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, 0o600)
    }
    const index = {
      schemaVersion: AGENT_HOST_ACCEPTANCE_SCHEMA_VERSION,
      acceptanceId: state.acceptanceId,
      evidenceClass: 'real_host',
      appVersion: state.appVersion,
      upgradeFromAppVersions: [...state.upgradeFromAppVersions],
      sourceCommit: state.sourceCommit,
      captureCreatedAt: state.createdAt,
      captureNonce: state.captureNonce,
      generatedAt,
      requirementsSha256: state.requirementsSha256,
      releaseContractSha256: state.releaseContractSha256,
      candidateAppsByArchitecture: state.candidateAppsByArchitecture,
      review,
      entries: state.entries.map(finalTarget),
      customPaths: state.customPaths.map(finalTarget),
      upgradePaths: state.upgradePaths.map(finalUpgrade),
      files,
    }
    writeJsonExclusive(path.join(staging, 'index.json'), index)
    const summary = verifyAgentIntegrationHostAcceptance({
      indexPath: path.join(staging, 'index.json'),
      expectedAppVersion: state.appVersion,
      expectedSourceCommit: state.sourceCommit,
      candidateAppPathsByArchitecture: state.candidateAppPathsByArchitecture,
      allowFixture: state.candidateAppPathsByArchitecture === null,
    })
    fs.renameSync(staging, output)
    return { ...summary, outputDirectory: output }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function parseFlags(argv) {
  const values = { evidence: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flag.startsWith('--')) throw new Error(`unexpected positional argument: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`)
    index += 1
    const key = flag.slice(2).replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())
    if (key === 'evidence') values.evidence.push(path.resolve(value))
    else if (Object.hasOwn(values, key)) throw new Error(`duplicate capture argument: ${flag}`)
    else values[key] = value
  }
  return values
}

function usage() {
  return [
    'Usage:',
    '  capture-agent-integration-host-acceptance.mjs init --workspace ABS --acceptance-id ID --source-commit SHA --candidate-app-arm64 APP [--candidate-app-x64 APP]',
    '  capture-agent-integration-host-acceptance.mjs target --workspace ABS --target TARGET_KEY --output ABS_FILE',
    '  capture-agent-integration-host-acceptance.mjs export-activity --workspace ABS --target TARGET_KEY --event-id ID --output ABS_FILE',
    '  capture-agent-integration-host-acceptance.mjs step --workspace ABS --target ID --step ID --assertion FILE --attestation FILE --evidence FILE [--evidence FILE...]',
    '  capture-agent-integration-host-acceptance.mjs upgrade --workspace ABS --target ID --from-app-version VERSION --assertion FILE --attestation FILE --evidence FILE [--evidence FILE...]',
    '  capture-agent-integration-host-acceptance.mjs status --workspace ABS',
    '  capture-agent-integration-host-acceptance.mjs prepare-review --workspace ABS --output ABS_FILE',
    '  capture-agent-integration-host-acceptance.mjs freeze --workspace ABS --review FILE --output ABS_DIR',
    '',
    'This tool never launches an Agent, executes an assertion command, reads Agent config, or changes Agent state.',
  ].join('\n')
}

function assertCommandFlags(flags, allowed, required, command) {
  const supplied = Object.keys(flags).filter(key => key !== 'evidence' || flags.evidence.length > 0)
  const unknown = supplied.filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${command} has unknown arguments: ${unknown.join(', ')}`)
  const missing = required.filter(key => (
    key === 'evidence' ? flags.evidence.length === 0 : typeof flags[key] !== 'string' || !flags[key]
  ))
  if (missing.length > 0) throw new Error(`${command} is missing arguments: ${missing.join(', ')}`)
}

export function runAgentHostAcceptanceCaptureCli(argv) {
  const [command, ...rest] = argv
  if (!command) throw new Error(usage())
  const flags = parseFlags(rest)
  if (command === 'init') {
    const keys = ['workspace', 'acceptanceId', 'sourceCommit', 'candidateAppArm64', 'candidateAppX64']
    assertCommandFlags(flags, keys, ['workspace', 'acceptanceId', 'sourceCommit'], command)
    return initializeAgentHostAcceptanceCapture({
      workspace: flags.workspace,
      acceptanceId: flags.acceptanceId,
      sourceCommit: flags.sourceCommit,
      candidateAppPathsByArchitecture: {
        ...(flags.candidateAppArm64 ? { arm64: path.resolve(flags.candidateAppArm64) } : {}),
        ...(flags.candidateAppX64 ? { x64: path.resolve(flags.candidateAppX64) } : {}),
      },
    })
  }
  if (command === 'target') {
    const keys = ['workspace', 'target', 'output']
    assertCommandFlags(flags, keys, keys, command)
    return exportAndRecordAgentHostAcceptanceTarget({
      workspace: flags.workspace,
      targetId: flags.target,
      outputPath: path.resolve(flags.output),
    })
  }
  if (command === 'export-activity') {
    const keys = ['workspace', 'target', 'eventId', 'output']
    assertCommandFlags(flags, keys, keys, command)
    return exportAgentHostActivityReceipt({
      workspace: flags.workspace,
      targetId: flags.target,
      eventId: flags.eventId,
      outputPath: path.resolve(flags.output),
    })
  }
  if (command === 'step') {
    const keys = ['workspace', 'target', 'step', 'assertion', 'attestation', 'evidence']
    assertCommandFlags(flags, keys, keys, command)
    return recordAgentHostAcceptanceStep({
      workspace: flags.workspace,
      targetId: flags.target,
      stepId: flags.step,
      assertionPath: flags.assertion,
      attestationPath: flags.attestation,
      evidencePaths: flags.evidence,
    })
  }
  if (command === 'upgrade') {
    const keys = ['workspace', 'target', 'fromAppVersion', 'assertion', 'attestation', 'evidence']
    assertCommandFlags(flags, keys, keys, command)
    return recordAgentHostAcceptanceUpgrade({
      workspace: flags.workspace,
      targetId: flags.target,
      fromAppVersion: flags.fromAppVersion,
      assertionPath: flags.assertion,
      attestationPath: flags.attestation,
      evidencePaths: flags.evidence,
    })
  }
  if (command === 'status') {
    assertCommandFlags(flags, ['workspace'], ['workspace'], command)
    return agentHostAcceptanceCaptureStatus(flags.workspace)
  }
  if (command === 'prepare-review') {
    const keys = ['workspace', 'output']
    assertCommandFlags(flags, keys, keys, command)
    return prepareAgentHostAcceptanceReview({
      workspace: flags.workspace,
      outputPath: path.resolve(flags.output),
    })
  }
  if (command === 'freeze') {
    const keys = ['workspace', 'review', 'output']
    assertCommandFlags(flags, keys, keys, command)
    return freezeAgentHostAcceptanceCapture({
      workspace: flags.workspace,
      reviewPath: flags.review,
      outputDirectory: flags.output,
    })
  }
  throw new Error(`unknown capture command: ${command}\n${usage()}`)
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  try {
    const result = runAgentHostAcceptanceCaptureCli(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

export const AGENT_HOST_ACCEPTANCE_REDACTION_STATEMENT = REDACTION_STATEMENT
