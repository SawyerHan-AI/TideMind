#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadAgentHostAcceptanceRequirements, requiredHostAcceptanceSteps, validateAgentHostAcceptanceEnvironment, hostAcceptanceTargetIdentityDigest, hostAcceptanceTargetMetadataExportHash, validateUserOwnedCustomActivityBinding } from './verify-agent-integration-host-acceptance.mjs'
import * as fullHostVerifier from './verify-agent-integration-host-acceptance.mjs'
import { validateCandidateArchiveEntries } from './agent-host-candidate-transfer.mjs'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'

export const PARTIAL_AUTH_RELEASE_VERSION = '0.2.93'
export const PARTIAL_AUTH_RELEASE_DISCLOSURE = '0.2.93 仅延期需要登录及真实调用的验收；不代表完整宿主验收通过，其他发布门禁仍必须通过。'
const VERSION = PARTIAL_AUTH_RELEASE_VERSION
const REPOSITORY = 'SawyerHan-AI/TideMind'
const SHA = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_FILE = 10 * 1024 * 1024
const MAX_TOTAL = 100 * 1024 * 1024
const MAX_FILES = 2048
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const own = (value, key) => Object.hasOwn(value, key)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function equal(actual, expected, label) { if (canonical(actual) !== canonical(expected)) throw new Error(`${label} mismatch`) }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  equal(Object.keys(value).sort(), [...keys].sort(), `${label} keys`)
}
function text(value, label) { if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`${label} invalid`) }
function actor(value) { text(value, 'actor identity'); return value.trim().normalize('NFKC').toLowerCase() }
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(`${label} invalid`)
  return Date.parse(value)
}
function digest(value, label) { if (!SHA.test(value ?? '')) throw new Error(`${label} invalid`) }
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unsafe evidence path')
  return value
}
function deepFreeze(value) { Object.values(value).forEach(item => { if (item && typeof item === 'object') deepFreeze(item) }); return Object.freeze(value) }
const rule = (noAuth, runtime = []) => ({ noAuth, runtime })

/** Source-owned, exact-version policy; report authors cannot redefine what may be deferred. */
export const PARTIAL_AUTH_RELEASE_POLICY = deepFreeze({
  version: VERSION, kind: 'login_and_real_invocation_only', targetCount: 26, upgradeCount: 63,
  steps: {
    official_host_version: rule(['official_version_metadata']),
    distribution_identity: rule(['trusted_source_and_canonical_launch_chain']),
    connect: rule(['configuration_contract_and_write_boundaries'], ['authenticated_host_activation']),
    read_back: rule(['configuration_bytes_permissions_and_unrelated_content']),
    restart_persistence: rule(['persisted_identity_configuration_and_history'], ['authenticated_host_reload']),
    disconnect: rule(['ownership_cas_shared_retention_and_cleanup'], ['authenticated_host_unload_confirmation']),
    instruction_loaded: rule(['instruction_artifact_scope_and_precedence'], ['host_instruction_loading']),
    brain_prepare: rule(['mcp_registration_schema_and_scope_boundaries'], ['host_brain_prepare']),
    brain_recall: rule(['mcp_registration_schema_and_scope_boundaries'], ['host_brain_recall']),
    brain_digest: rule(['mcp_registration_schema_and_scope_boundaries'], ['host_brain_digest']),
    recovery: rule(['owned_restore_cas_and_no_automatic_replay'], ['authenticated_recovery_call']),
    conflict: rule(['conflict_detection_and_no_overwrite']),
    pause_resume: rule(['maintenance_inhibition_and_reenable_boundary'], ['authenticated_resume_call']),
    legacy_selector_identity: rule(['legacy_selector_identity_and_ownership']),
    history_callable: rule(['history_statistics_and_identity_preserved'], ['authenticated_history_call']),
    official_plugins_list: rule(['official_plugin_inventory']),
    official_plugin_inspect: rule(['official_plugin_inspection']),
    plugin_runtime: rule(['plugin_registration_and_runtime_contract'], ['authenticated_plugin_runtime']),
    scan_persistence: rule(['scan_preserves_user_owned_configuration_and_state']),
    lifecycle_session_start: rule(['lifecycle_artifact_event_contract'], ['host_session_start']),
    lifecycle_pre_compact: rule(['lifecycle_artifact_event_contract'], ['host_pre_compact']),
    lifecycle_post_compact: rule(['lifecycle_artifact_event_contract'], ['host_post_compact']),
    lifecycle_session_end: rule(['lifecycle_artifact_event_contract'], ['host_session_end']),
  },
  upgrades: ['old_database_and_configuration_restore_point', 'migration_identity_history_and_statistics',
    'route_auth_epoch_and_ownership_not_reauthorized', 'restore_integrity_and_conflict_boundaries'],
  global: {
    source_health: 'source_check', agent_release_manifest: 'source_check', mac_packaging: 'source_check', update_signature_preflight: 'source_check',
    default_gui_startup: 'signed_candidate_no_auth', packaged_worker_smoke: 'signed_candidate_no_auth',
    packaged_performance: 'signed_candidate_no_auth', migration_backup_restore: 'signed_candidate_no_auth',
    no_auth_ui_and_permission_boundaries: 'signed_candidate_no_auth',
  },
  models: {
    providers: ['codex-cli', 'claude-cli', 'api-connections'],
    noAuth: ['catalog_or_fallback_and_selection_contract', 'credential_isolation_and_admission', 'route_worker_errors_and_cancellation'],
    runtime: ['authenticated_catalog_or_subscription_fallback', 'real_inference_and_background_routes'],
  },
})
export const PARTIAL_AUTH_RELEASE_POLICY_SHA256 = hash(canonical(PARTIAL_AUTH_RELEASE_POLICY))

export function buildPartialAuthReleasePlan(requirements = loadAgentHostAcceptanceRequirements(), nonstandardSourceCatalogId) {
  equal(requirements.appVersion, VERSION, 'partial policy version')
  equal(requirements.releaseMacArchitectures, ['arm64'], 'partial architectures')
  equal(requirements.upgradeFromAppVersions, ['0.2.89', '0.2.91', '0.2.92'], 'upgrade origins')
  const eligible = requirements.entries.filter(entry => entry.customConfigRoot?.supported === true)
  const sourceId = nonstandardSourceCatalogId ?? (eligible.length === 1 ? eligible[0].catalogId : null)
  const source = eligible.find(entry => entry.catalogId === sourceId)
  if (!source) throw new Error('nonstandard Custom source must have a released relocatable-root contract')
  const targets = requirements.targets.map(entry => ({ ...entry, targetId: entry.catalogId, sourceCatalogId: null }))
  for (const custom of requirements.customTargets) {
    targets.push(custom.targetId === 'manual_mcp_client'
      ? { ...custom, sourceCatalogId: null, disposition: 'custom', policyDisposition: 'guided', requiredComponents: ['memory_tools'], requiredLifecycle: null }
      : { ...source, ...custom, sourceCatalogId: source.catalogId, disposition: 'custom', policyDisposition: source.disposition })
  }
  const planned = targets.map(target => ({ targetKey: target.targetKey, targetId: target.targetId,
    sourceCatalogId: target.sourceCatalogId, officialDistributions: target.officialDistributions ?? [],
    acceptedDistributionArtifacts: target.acceptedDistributionArtifacts ?? [], releaseAcceptedExactVersions: target.releaseAcceptedExactVersions,
    userOwned: target.configurationOwnership === 'user', steps: requiredHostAcceptanceSteps(requirements, target).map(id => {
      const policy = PARTIAL_AUTH_RELEASE_POLICY.steps[id]
      if (!policy) throw new Error(`no reviewed partial policy for step ${id}`)
      return { id, ...policy }
    }) }))
  const upgrades = requirements.targets.flatMap(target => requirements.upgradeFromAppVersions.map(fromAppVersion => ({ targetKey: target.targetKey, fromAppVersion })))
  equal(planned.length, 26, 'target count')
  equal(new Set(planned.map(target => target.targetKey)).size, 26, 'unique target count')
  equal(upgrades.length, 63, 'upgrade count')
  return { nonstandardSourceCatalogId: source.catalogId, targets: planned, upgrades, requiredStepCount: planned.reduce((sum, target) => sum + target.steps.length, 0) }
}

const pending = id => ({ id, status: 'pending', receipt: null, evidenceFiles: [] })
const deferred = id => ({ id, status: 'deferred', reason: 'user_authorized_login_or_real_invocation_only', explanation: '待补充此项需要登录或真实调用的具体边界', receipt: null, evidenceFiles: [] })
export function buildPartialAuthReleaseTemplate({ expectedSourceCommit, requirementsPath, releaseManifestPath, nonstandardSourceCatalogId } = {}) {
  if (!COMMIT.test(expectedSourceCommit ?? '')) throw new Error('template source commit invalid')
  const requirements = loadAgentHostAcceptanceRequirements(requirementsPath, releaseManifestPath)
  const plan = buildPartialAuthReleasePlan(requirements, nonstandardSourceCatalogId)
  return {
    schemaVersion: 1, kind: 'partial_auth_runtime_acceptance', appVersion: VERSION, sourceCommit: expectedSourceCommit,
    requirementsSha256: requirements.sha256, releaseContractSha256: requirements.releaseContractSha256,
    policySha256: PARTIAL_AUTH_RELEASE_POLICY_SHA256, nonstandardSourceCatalogId: plan.nonstandardSourceCatalogId,
    captureNonce: crypto.randomBytes(32).toString('hex'), captureCreatedAt: new Date().toISOString(), generatedAt: null, collectedBy: null,
    authorization: { kind: 'user_directed_0.2.93_exception', authorizedBy: 'owner', decisionText: '接受缺项并披露后发版', scope: ['login', 'real_invocation'], decision: 'accept_missing_items_and_disclose_then_release', authorizedAt: null },
    disclosure: PARTIAL_AUTH_RELEASE_DISCLOSURE, releaseNotesFile: 'release-notes.md',
    candidate: { architecture: 'arm64', repository: REPOSITORY, publicCommit: null, runId: null, runAttempt: null,
      artifactId: null, artifactDigest: null, uploadReceiptArtifactId: null, uploadReceiptArtifactDigest: null,
      app: { version: VERSION, sourceCommit: expectedSourceCommit, bundleSha256: null, executableSha256: null, teamId: 'Z4U232GXH5', signingIdentity: null, cdhash: null },
      dmgSha256: null, zipSha256: null, performance: { artifactId: null, artifactDigest: null, receiptPath: 'packaged-performance.json', receiptSha256: null, workerSha256: null } },
    targets: plan.targets.map(target => ({ targetKey: target.targetKey, targetId: target.targetId, sourceCatalogId: target.sourceCatalogId,
      hostVersion: null, hostIdentitySha256: null, metadataExportFile: null, steps: target.steps.map(step => ({ id: step.id, noAuth: step.noAuth.map(pending), runtime: step.runtime.map(deferred) })) })),
    upgradePaths: plan.upgrades.map(upgrade => ({ ...upgrade, toAppVersion: VERSION, installationId: null, originalAgentId: null, migratedAgentId: null,
      historyPreserved: null, statisticsPreserved: null, noAuth: PARTIAL_AUTH_RELEASE_POLICY.upgrades.map(pending), runtime: [] })),
    modelPaths: PARTIAL_AUTH_RELEASE_POLICY.models.providers.map(provider => ({ provider, noAuth: PARTIAL_AUTH_RELEASE_POLICY.models.noAuth.map(pending), runtime: PARTIAL_AUTH_RELEASE_POLICY.models.runtime.map(deferred) })),
    globalChecks: Object.keys(PARTIAL_AUTH_RELEASE_POLICY.global).map(pending), files: [],
    review: { path: 'independent-review.json', bytes: null, sha256: null },
  }
}
export function hashPartialAuthReleaseBody(report) { const { review: _review, ...body } = report; return hash(canonical(body)) }
export function hashPartialAuthEvidenceManifest(report) { return hash(canonical([...report.files].sort((a, b) => a.path.localeCompare(b.path)))) }

function validateCandidate(candidate, sourceCommit) {
  exact(candidate, ['architecture', 'repository', 'publicCommit', 'runId', 'runAttempt', 'artifactId', 'artifactDigest', 'uploadReceiptArtifactId', 'uploadReceiptArtifactDigest', 'app', 'dmgSha256', 'zipSha256', 'performance'], 'candidate')
  equal(candidate.architecture, 'arm64', 'candidate architecture'); equal(candidate.repository, REPOSITORY, 'candidate repository')
  if (!COMMIT.test(candidate.publicCommit ?? '')) throw new Error('candidate public commit invalid')
  for (const key of ['runId', 'runAttempt', 'artifactId', 'uploadReceiptArtifactId']) if (!/^[1-9][0-9]*$/u.test(candidate[key] ?? '')) throw new Error(`candidate ${key} invalid`)
  for (const key of ['artifactDigest', 'uploadReceiptArtifactDigest', 'dmgSha256', 'zipSha256']) digest(candidate[key], key)
  exact(candidate.performance, ['artifactId', 'artifactDigest', 'receiptPath', 'receiptSha256', 'workerSha256'], 'performance binding')
  if (!/^[1-9][0-9]*$/u.test(candidate.performance.artifactId ?? '')) throw new Error('performance artifact ID invalid')
  for (const key of ['artifactDigest', 'receiptSha256', 'workerSha256']) digest(candidate.performance[key], `performance ${key}`)
  relative(candidate.performance.receiptPath)
  if (new Set([candidate.artifactId, candidate.uploadReceiptArtifactId, candidate.performance.artifactId]).size !== 3) throw new Error('candidate artifact roles must be distinct')
  exact(candidate.app, ['version', 'sourceCommit', 'bundleSha256', 'executableSha256', 'teamId', 'signingIdentity', 'cdhash'], 'candidate app')
  equal(candidate.app.version, VERSION, 'candidate version'); equal(candidate.app.sourceCommit, sourceCommit, 'candidate source')
  digest(candidate.app.bundleSha256, 'bundle hash'); digest(candidate.app.executableSha256, 'executable hash')
  equal(candidate.app.teamId, 'Z4U232GXH5', 'candidate team')
  if (!/^[a-f0-9]{40}$/u.test(candidate.app.cdhash ?? '') || !candidate.app.signingIdentity?.startsWith('Developer ID Application:')
    || !candidate.app.signingIdentity.includes('(Z4U232GXH5)')) throw new Error('candidate signing identity invalid')
}

function validatePartialCustomBinding(value, expected, metadata, allowMissingActivity) {
  exact(value, ['kind', 'sourceInstallationId', 'sourceCatalogId', 'configRootIdentitySha256', 'configFileIdentitySha256',
    'selectorIdentitySha256', 'executableFingerprint', 'sourceLiveTrustProofSha256', 'liveTrustProofSha256', 'readBackProofSha256',
    ...(expected.userOwned ? ['configurationOwnership', 'activityBinding'] : [])], 'Custom local binding')
  equal(value.kind, expected.targetId, 'Custom binding kind')
  for (const key of ['configRootIdentitySha256', 'selectorIdentitySha256', 'liveTrustProofSha256']) digest(value[key], `Custom ${key}`)
  if (expected.userOwned) {
    equal(value.configurationOwnership, 'user', 'Custom user ownership')
    for (const key of ['configFileIdentitySha256', 'readBackProofSha256', 'sourceInstallationId', 'sourceCatalogId', 'sourceLiveTrustProofSha256']) equal(value[key], null, `Custom preserved ${key}`)
    digest(value.executableFingerprint, 'Custom executable')
    // Only the authenticated activity portion may be absent under this exception.
    if (value.activityBinding === null && !allowMissingActivity) throw new Error('missing activity requires explicit 0.2.93 user-owned Custom no-auth export')
    if (value.activityBinding !== null) validateUserOwnedCustomActivityBinding(value.activityBinding, { targetKey: metadata.targetKey,
      installationId: metadata.installationId, agentId: metadata.agentId, hostVersion: metadata.hostVersion, tideMindVersion: VERSION })
  } else {
    digest(value.readBackProofSha256, 'Custom readback')
    if (expected.targetId === 'nonstandard_config_root') {
      text(value.sourceInstallationId, 'Custom source installation'); equal(value.sourceCatalogId, expected.sourceCatalogId, 'Custom source')
      digest(value.sourceLiveTrustProofSha256, 'Custom source trust'); equal(value.configFileIdentitySha256, null, 'relocated Custom config file'); equal(value.executableFingerprint, null, 'relocated Custom executable')
    } else {
      for (const key of ['sourceInstallationId', 'sourceCatalogId', 'sourceLiveTrustProofSha256']) equal(value[key], null, `manual Custom ${key}`)
      digest(value.configFileIdentitySha256, 'manual Custom config'); digest(value.executableFingerprint, 'manual Custom executable')
    }
  }
}

/** Structural + sealed evidence validation only. A caller must use verifyPartialAuthRelease for release eligibility. */
export function validatePartialAuthReleaseReport(report, { expectedSourceCommit, requirementsPath, releaseManifestPath, documents = new Map(), reviewDocument } = {}) {
  exact(report, ['schemaVersion', 'kind', 'appVersion', 'sourceCommit', 'requirementsSha256', 'releaseContractSha256', 'policySha256', 'nonstandardSourceCatalogId',
    'captureNonce', 'captureCreatedAt', 'generatedAt', 'collectedBy', 'authorization', 'disclosure', 'releaseNotesFile', 'candidate', 'targets', 'upgradePaths', 'modelPaths', 'globalChecks', 'files', 'review'], 'partial report')
  equal(report.schemaVersion, 1, 'report schema'); equal(report.kind, 'partial_auth_runtime_acceptance', 'report kind'); equal(report.appVersion, VERSION, 'report version')
  if (!COMMIT.test(expectedSourceCommit ?? '')) throw new Error('expected source commit invalid')
  equal(report.sourceCommit, expectedSourceCommit, 'report source')
  const requirements = loadAgentHostAcceptanceRequirements(requirementsPath, releaseManifestPath)
  const plan = buildPartialAuthReleasePlan(requirements, report.nonstandardSourceCatalogId)
  equal(report.requirementsSha256, requirements.sha256, 'requirements hash'); equal(report.releaseContractSha256, requirements.releaseContractSha256, 'contract hash')
  equal(report.policySha256, PARTIAL_AUTH_RELEASE_POLICY_SHA256, 'policy hash')
  digest(report.captureNonce, 'capture nonce')
  const captured = timestamp(report.captureCreatedAt, 'capture time'), generated = timestamp(report.generatedAt, 'report time')
  if (captured > generated) throw new Error('capture follows report generation')
  text(report.collectedBy, 'collector'); equal(report.disclosure, PARTIAL_AUTH_RELEASE_DISCLOSURE, 'required disclosure')
  exact(report.authorization, ['kind', 'authorizedBy', 'decisionText', 'scope', 'decision', 'authorizedAt'], 'authorization')
  equal(report.authorization.kind, 'user_directed_0.2.93_exception', 'authorization kind')
  equal(report.authorization.authorizedBy, 'owner', 'authorization actor'); equal(report.authorization.decisionText, '接受缺项并披露后发版', 'user decision record')
  equal(report.authorization.scope, ['login', 'real_invocation'], 'authorization scope')
  equal(report.authorization.decision, 'accept_missing_items_and_disclose_then_release', 'authorization decision')
  if (timestamp(report.authorization.authorizedAt, 'authorization time') > generated) throw new Error('authorization follows report')
  validateCandidate(report.candidate, report.sourceCommit)
  if (!Array.isArray(report.files) || !report.files.length || report.files.length > MAX_FILES) throw new Error('evidence count invalid')
  const files = new Map(), referenced = new Set(), assertors = new Set([actor(report.collectedBy)]); let total = 0, noAuthPassed = 0, deferredRuntime = 0, runtimePassed = 0
  for (const file of report.files) {
    exact(file, ['path', 'bytes', 'sha256'], 'evidence file'); relative(file.path); digest(file.sha256, 'evidence hash')
    if (files.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE) throw new Error('evidence duplicate or size invalid')
    total += file.bytes; if (total > MAX_TOTAL) throw new Error('evidence total exceeds limit')
    const bytes = documents.get(file.path)
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`evidence content mismatch: ${file.path}`)
    files.set(file.path, file)
  }
  const notes = relative(report.releaseNotesFile)
  if (!files.has(notes) || !documents.get(notes).toString('utf8').includes(PARTIAL_AUTH_RELEASE_DISCLOSURE)) throw new Error('release notes must contain exact partial disclosure')
  referenced.add(notes)
  const perf = report.candidate.performance
  if (files.get(perf.receiptPath)?.sha256 !== perf.receiptSha256) throw new Error('performance receipt hash mismatch')
  const performance = JSON.parse(documents.get(perf.receiptPath).toString('utf8'))
  equal(performance.thresholdEvaluation?.status, 'passed', 'performance threshold status')
  equal(performance.thresholdEvaluation?.failures, [], 'performance failures')
  equal(performance.provenance?.gitHead, report.candidate.publicCommit, 'performance candidate commit')
  equal(performance.provenance?.sourceWorkerSha256, perf.workerSha256, 'performance Worker hash')
  equal(performance.provenance?.thresholdSha256, hash(fs.readFileSync(path.join(ROOT, 'scripts/metabolism-worker-candidate-thresholds.json'))), 'performance frozen thresholds')
  referenced.add(perf.receiptPath)
  const bind = { captureNonce: report.captureNonce, appVersion: VERSION, sourceCommit: report.sourceCommit, requirementsSha256: report.requirementsSha256,
    releaseContractSha256: report.releaseContractSha256, policySha256: report.policySha256, candidateBundleSha256: report.candidate.app.bundleSha256 }
  function passed(check, subject, expectedClass) {
    exact(check, ['id', 'status', 'receipt', 'evidenceFiles'], 'passed check')
    equal(check.status, 'passed', `required no-auth/observed check ${check.id}`)
    const receiptPath = relative(check.receipt)
    if (!files.has(receiptPath) || !Array.isArray(check.evidenceFiles) || check.evidenceFiles.length < 1) throw new Error('check lacks sealed receipt/raw evidence')
    referenced.add(receiptPath)
    if (new Set(check.evidenceFiles).size !== check.evidenceFiles.length) throw new Error('duplicate raw evidence reference')
    for (const evidence of check.evidenceFiles) { relative(evidence); if (evidence === receiptPath || !files.has(evidence)) throw new Error('unindexed raw evidence'); referenced.add(evidence) }
    const receipt = JSON.parse(documents.get(receiptPath).toString('utf8'))
    exact(receipt, ['schemaVersion', 'kind', 'evidenceClass', ...Object.keys(bind), 'subject', 'checkId', 'outcome', 'observedAt', 'assertionSource', 'assertedBy', 'findings', 'evidenceFiles'], 'check receipt')
    equal(receipt.schemaVersion, 1, 'receipt schema'); equal(receipt.kind, 'partial_release_check', 'receipt kind')
    equal(receipt.evidenceClass, expectedClass, 'receipt evidence class'); equal(receipt.outcome, 'passed', 'receipt outcome')
    for (const [key, value] of Object.entries(bind)) equal(receipt[key], value, `receipt ${key}`)
    equal(receipt.subject, subject, 'receipt subject'); equal(receipt.checkId, check.id, 'receipt check ID')
    equal(receipt.findings, [], 'receipt unresolved findings'); equal(receipt.evidenceFiles, check.evidenceFiles, 'receipt raw evidence references')
    const observed = timestamp(receipt.observedAt, 'receipt time')
    if (observed > generated || (expectedClass !== 'source_check' && observed < captured)) throw new Error('receipt outside capture window')
    if (!['human', 'external'].includes(receipt.assertionSource)) throw new Error('fixture or self-generated assertion class refused')
    text(receipt.assertedBy, 'receipt assertor'); assertors.add(actor(receipt.assertedBy))
  }
  function checks(values, ids, subject, klass, runtime = false) {
    if (!Array.isArray(values)) throw new Error('missing check list')
    equal(values.map(value => value.id).sort(), [...ids].sort(), 'required check coverage')
    for (const check of values) {
      if (runtime && check.status === 'deferred') {
        exact(check, ['id', 'status', 'reason', 'explanation', 'receipt', 'evidenceFiles'], 'deferred runtime check')
        equal(check.reason, 'user_authorized_login_or_real_invocation_only', 'deferred reason'); text(check.explanation, 'deferred explanation'); if (check.explanation.includes('待补充')) throw new Error('deferred boundary is still a template placeholder')
        equal(check.receipt, null, 'deferred receipt'); equal(check.evidenceFiles, [], 'deferred evidence must not claim execution'); deferredRuntime++
      } else {
        passed(check, subject, runtime ? 'real_host' : klass)
        if (runtime) runtimePassed++; else noAuthPassed++
      }
    }
  }
  if (!Array.isArray(report.targets)) throw new Error('targets missing')
  equal(report.targets.map(target => target.targetKey).sort(), plan.targets.map(target => target.targetKey).sort(), '26-target coverage')
  const identities = new Map()
  for (const expected of plan.targets) {
    const target = report.targets.find(value => value.targetKey === expected.targetKey)
    exact(target, ['targetKey', 'targetId', 'sourceCatalogId', 'hostVersion', 'hostIdentitySha256', 'metadataExportFile', 'steps'], 'target')
    for (const key of ['targetKey', 'targetId', 'sourceCatalogId']) equal(target[key], expected[key], `target ${key}`)
    text(target.hostVersion, 'host version'); digest(target.hostIdentitySha256, 'host identity'); identities.set(target.targetKey, target.hostIdentitySha256)
    if (Array.isArray(expected.releaseAcceptedExactVersions) && !expected.releaseAcceptedExactVersions.includes(target.hostVersion)) throw new Error('host version not accepted by frozen release contract')
    const exportPath = relative(target.metadataExportFile)
    if (!files.has(exportPath)) throw new Error('signed candidate target metadata export missing')
    referenced.add(exportPath)
    const exported = JSON.parse(documents.get(exportPath).toString('utf8'))
    exact(exported, ['exporterVersion', 'evidenceClass', 'candidateBundleSha256', 'sourceCommit', 'releaseContractSha256', 'targetMetadata', 'exportedAt', 'exportHash'], 'target metadata export')
    equal(exported.exporterVersion, 1, 'target exporter'); if (exported.evidenceClass !== 'real_host' && !(expected.userOwned && exported.evidenceClass === 'real_host_no_auth_0.2.93')) throw new Error('target metadata class is not authorized for this target')
    equal(exported.sourceCommit, report.sourceCommit, 'target export source'); equal(exported.releaseContractSha256, report.releaseContractSha256, 'target export contract')
    equal(exported.candidateBundleSha256, report.candidate.app.bundleSha256, 'target export candidate')
    equal(exported.exportHash, hostAcceptanceTargetMetadataExportHash(exported), 'target export seal')
    const exportTime = timestamp(exported.exportedAt, 'target export time')
    if (exportTime < captured || exportTime > generated) throw new Error('target export outside capture')
    const metadata = exported.targetMetadata
    const custom = expected.targetId === 'nonstandard_config_root' || expected.targetId === 'manual_mcp_client'
    exact(metadata, ['targetKey', 'targetId', ...(expected.sourceCatalogId ? ['sourceCatalogId'] : []), 'hostVersion', 'distribution', 'environment', 'installationId', 'agentId', ...(custom ? ['customBinding'] : [])], 'exported target metadata')
    equal(metadata.targetKey, target.targetKey, 'export target key'); equal(metadata.targetId, target.targetId, 'export target ID'); equal(metadata.hostVersion, target.hostVersion, 'export host version')
    if (expected.sourceCatalogId) equal(metadata.sourceCatalogId, expected.sourceCatalogId, 'Custom source catalog')
    text(metadata.installationId, 'export installation ID'); text(metadata.agentId, 'export Agent ID')
    validateAgentHostAcceptanceEnvironment(metadata.environment, target.targetKey); equal(metadata.environment.architecture, 'arm64', 'target native architecture')
    if (typeof fullHostVerifier.validateDistribution !== 'function') throw new Error('full distribution validator export is required')
    fullHostVerifier.validateDistribution(metadata.distribution, target.targetKey, expected.officialDistributions,
      expected.acceptedDistributionArtifacts, target.hostVersion, 'arm64', target.targetId === 'manual_mcp_client')
    equal(target.hostIdentitySha256, hostAcceptanceTargetIdentityDigest(metadata), 'target identity digest')
    if (custom) validatePartialCustomBinding(metadata.customBinding, expected, metadata, expected.userOwned && exported.evidenceClass === 'real_host_no_auth_0.2.93')

    if (!Array.isArray(target.steps)) throw new Error('target steps missing')
    equal(target.steps.map(step => step.id).sort(), expected.steps.map(step => step.id).sort(), 'original step coverage')
    for (const required of expected.steps) {
      const step = target.steps.find(value => value.id === required.id)
      exact(step, ['id', 'noAuth', 'runtime'], 'target step')
      const subject = { kind: 'target_step', targetKey: target.targetKey, targetId: target.targetId, hostVersion: target.hostVersion, hostIdentitySha256: target.hostIdentitySha256, stepId: step.id }
      checks(step.noAuth, required.noAuth, subject, 'signed_candidate_no_auth')
      checks(step.runtime, required.runtime, subject, 'real_host', true)
    }
  }
  if (!Array.isArray(report.upgradePaths)) throw new Error('upgrade paths missing')
  const upgradeKey = value => `${value.targetKey}/${value.fromAppVersion}`
  equal(report.upgradePaths.map(upgradeKey).sort(), plan.upgrades.map(upgradeKey).sort(), '63-upgrade coverage')
  for (const upgrade of report.upgradePaths) {
    exact(upgrade, ['targetKey', 'fromAppVersion', 'toAppVersion', 'installationId', 'originalAgentId', 'migratedAgentId', 'historyPreserved', 'statisticsPreserved', 'noAuth', 'runtime'], 'upgrade')
    equal(upgrade.toAppVersion, VERSION, 'upgrade destination'); text(upgrade.installationId, 'upgrade installation'); text(upgrade.originalAgentId, 'original Agent')
    equal(upgrade.migratedAgentId, upgrade.originalAgentId, 'preserved Agent ID'); equal(upgrade.historyPreserved, true, 'history preserved'); equal(upgrade.statisticsPreserved, true, 'statistics preserved')
    const { noAuth, runtime, ...identity } = upgrade
    checks(noAuth, PARTIAL_AUTH_RELEASE_POLICY.upgrades, { kind: 'upgrade', ...identity, hostIdentitySha256: identities.get(upgrade.targetKey) }, 'signed_candidate_no_auth')
    equal(runtime, [], 'upgrade preservation cannot be deferred')
  }
  if (!Array.isArray(report.modelPaths)) throw new Error('model paths missing')
  equal(report.modelPaths.map(model => model.provider).sort(), [...PARTIAL_AUTH_RELEASE_POLICY.models.providers].sort(), 'model provider scope')
  for (const model of report.modelPaths) {
    exact(model, ['provider', 'noAuth', 'runtime'], 'model path')
    const subject = { kind: 'model', provider: model.provider }
    checks(model.noAuth, PARTIAL_AUTH_RELEASE_POLICY.models.noAuth, subject, 'signed_candidate_no_auth')
    checks(model.runtime, PARTIAL_AUTH_RELEASE_POLICY.models.runtime, subject, 'real_host', true)
  }
  if (!Array.isArray(report.globalChecks)) throw new Error('global checks missing')
  equal(report.globalChecks.map(check => check.id).sort(), Object.keys(PARTIAL_AUTH_RELEASE_POLICY.global).sort(), 'global non-waivable gates')
  for (const check of report.globalChecks) {
    if (check.id === 'update_signature_preflight' && (!files.has('evidence/update-signatures.json') || !check.evidenceFiles?.includes('evidence/update-signatures.json'))) throw new Error('update signature evidence must be indexed and referenced at evidence/update-signatures.json')
    passed(check, { kind: 'global', id: check.id }, PARTIAL_AUTH_RELEASE_POLICY.global[check.id]); noAuthPassed++ }
  if (!deferredRuntime) throw new Error('no deferred runtime items; use the full acceptance path')
  equal([...referenced].sort(), [...files.keys()].sort(), 'all evidence must be referenced')
  exact(report.review, ['path', 'bytes', 'sha256'], 'review file'); relative(report.review.path); digest(report.review.sha256, 'review hash')
  if (files.has(report.review.path) || !Buffer.isBuffer(reviewDocument) || reviewDocument.length !== report.review.bytes || hash(reviewDocument) !== report.review.sha256 || reviewDocument.length > MAX_FILE) throw new Error('independent review file mismatch')
  const review = JSON.parse(reviewDocument.toString('utf8'))
  exact(review, ['schemaVersion', 'kind', ...Object.keys(bind), 'reportBodySha256', 'evidenceManifestSha256', 'reviewer', 'reviewedAt', 'outcome', 'unresolvedNoAuthFindings', 'disclosureVerified', 'completedRuntimeEvidencePreserved'], 'review')
  equal(review.schemaVersion, 1, 'review schema'); equal(review.kind, 'independent_partial_auth_release_review', 'review kind')
  for (const [key, value] of Object.entries(bind)) equal(review[key], value, `review ${key}`)
  equal(review.reportBodySha256, hashPartialAuthReleaseBody(report), 'review report body'); equal(review.evidenceManifestSha256, hashPartialAuthEvidenceManifest(report), 'review evidence manifest')
  equal(review.outcome, 'approved_with_auth_runtime_deferred', 'review outcome'); equal(review.unresolvedNoAuthFindings, [], 'review unresolved no-auth findings')
  equal(review.disclosureVerified, true, 'review disclosure'); equal(review.completedRuntimeEvidencePreserved, true, 'review retained prior completed evidence')
  text(review.reviewer, 'reviewer'); if (assertors.has(actor(review.reviewer))) throw new Error('reviewer must be independent of every collector/assertor')
  if (timestamp(review.reviewedAt, 'review time') < generated) throw new Error('review predates report')
  return Object.freeze({ status: 'validated_partial_report_only', physicalVerified: false, fullHostAcceptance: false,
    appVersion: VERSION, sourceCommit: report.sourceCommit, candidateBundleSha256: report.candidate.app.bundleSha256,
    targetCount: plan.targets.length, requiredStepCount: plan.requiredStepCount, upgradeCount: plan.upgrades.length,
    noAuthPassed, deferredRuntime, runtimePassed, reportBodySha256: hashPartialAuthReleaseBody(report), evidenceManifestSha256: hashPartialAuthEvidenceManifest(report), releaseNotesSha256: files.get(notes).sha256, disclosure: PARTIAL_AUTH_RELEASE_DISCLOSURE })
}

function regularBytes(file, max = MAX_FILE) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || fs.realpathSync(file) !== path.resolve(file)) throw new Error('not a canonical bounded regular file')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.size !== stat.size || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('evidence changed before read')
    const bytes = Buffer.alloc(before.size); let offset = 0
    while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!read) throw new Error('evidence truncated'); offset += read }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error('evidence grew beyond bound')
    const after = fs.fstatSync(fd), current = fs.lstatSync(file)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error('evidence changed during read')
    return bytes
  } finally { fs.closeSync(fd) }
}

function fileHash(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('artifact must be a regular file')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK), digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('artifact changed before hashing')
    let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size))
    const after = fs.fstatSync(fd), current = fs.lstatSync(file)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error('artifact changed while hashing')
    return digest.digest('hex')
  } finally { fs.closeSync(fd) }
}
function bundleFiles(root, current = root, budget = { directories: 0 }, depth = 0) {
  if (++budget.directories > MAX_FILES || depth > 64) throw new Error('evidence directory budget exceeded')
  const result = []
  for (const name of fs.readdirSync(current).sort()) {
    const file = path.join(current, name), stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('evidence bundle symlinks forbidden')
    if (stat.isDirectory()) result.push(...bundleFiles(root, file, budget, depth + 1))
    else if (stat.isFile()) result.push(path.relative(root, file).split(path.sep).join('/'))
    else throw new Error('invalid evidence filesystem entry')
    if (result.length > MAX_FILES + 2) throw new Error('too many evidence files')
  }
  return result.sort()
}
export function loadPartialAuthReleaseReport(reportPath, options) {
  const absolute = path.resolve(reportPath), root = path.dirname(absolute)
  const reportBytes = regularBytes(absolute, 5 * MAX_FILE)
  const report = JSON.parse(reportBytes.toString('utf8'))
  if (!Array.isArray(report.files) || report.files.length > MAX_FILES || !report.review) throw new Error('invalid evidence index')
  const documents = new Map(); let total = 0
  for (const file of report.files) {
    exact(file, ['path', 'bytes', 'sha256'], 'evidence file'); relative(file.path); digest(file.sha256, 'evidence hash')
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE || documents.has(file.path)) throw new Error('evidence size or duplicate invalid')
    total += file.bytes; if (total > MAX_TOTAL) throw new Error('evidence total exceeds limit')
    const bytes = regularBytes(path.join(root, file.path), file.bytes)
    if (bytes.length !== file.bytes) throw new Error('evidence declared size mismatch')
    documents.set(file.path, bytes)
  }
  const reviewDocument = regularBytes(path.join(root, relative(report.review.path)))
  equal(bundleFiles(root), [...report.files.map(file => file.path), report.review.path, path.basename(absolute)].sort(), 'sealed bundle file set')
  return { report, reportBytes, root, reportName: path.basename(absolute), documents, reviewDocument,
    summary: validatePartialAuthReleaseReport(report, { ...options, documents, reviewDocument }) }
}

/** Validates the sealed report before a workflow fetches its immutable artifacts. */
export function getPartialAuthReleaseFetchBinding(reportPath, options) {
  const { report } = loadPartialAuthReleaseReport(reportPath, options)
  const c = report.candidate
  return Object.freeze({ repository: c.repository, sourceCommit: report.sourceCommit, candidatePublicCommit: c.publicCommit,
    candidateRunId: c.runId, candidateRunAttempt: c.runAttempt, artifactId: c.artifactId, artifactDigest: c.artifactDigest,
    uploadReceiptArtifactId: c.uploadReceiptArtifactId, uploadReceiptArtifactDigest: c.uploadReceiptArtifactDigest,
    performanceArtifactId: c.performance.artifactId, performanceArtifactDigest: c.performance.artifactDigest,
    performanceReceiptSha256: c.performance.receiptSha256, performanceReceiptPath: c.performance.receiptPath,
    performanceWorkerSha256: c.performance.workerSha256 })
}

const candidateNames = () => [`Tide.Mind-${VERSION}-arm64-stapled-app.zip`, `Tide.Mind-${VERSION}-arm64.dmg`, `Tide.Mind-${VERSION}-arm64.dmg.blockmap`, `Tide.Mind-${VERSION}-arm64.zip`, 'candidate-verification.json', 'files.sha256', 'latest-mac-arm64.yml'].sort()
function run(command, args) { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function extract(archive, digest, names, destination) {
  equal(fileHash(archive), digest, 'immutable artifact digest')
  equal(run('/usr/bin/unzip', ['-Z1', archive]).split(/\r?\n/u).filter(Boolean).sort(), names, 'artifact entry allowlist')
  fs.mkdirSync(destination, { mode: 0o700 })
  // Write only our fixed filenames: archive symlink metadata cannot redirect extraction.
  for (const name of names) {
    const fd = fs.openSync(path.join(destination, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try { execFileSync('/usr/bin/unzip', ['-p', archive, name], { stdio: ['ignore', fd, 'pipe'] }) } finally { fs.closeSync(fd) }
  }
  equal(fileHash(archive), digest, 'artifact changed during extraction')
}
export function verifyPartialPerformanceArtifact(report, artifactZip, destination) {
  const performance = report.candidate.performance
  extract(path.resolve(artifactZip), performance.artifactDigest, ['metabolism-performance-receipt.json'], destination)
  const actual = fileHash(path.join(destination, 'metabolism-performance-receipt.json'))
  equal(actual, performance.receiptSha256, 'actual performance artifact receipt')
  return Object.freeze({ status: 'verified_performance_archive_bytes', receiptSha256: actual })
}

export function validatePartialCandidateReceipts(report, upload, verification) {
  const c = report.candidate
  exact(upload, ['schemaVersion', 'purpose', 'sourceCommit', 'publicCommit', 'appVersion', 'architecture', 'repository', 'runId', 'runAttempt', 'artifactId', 'artifactUrl', 'artifactDigest'], 'upload receipt')
  equal(upload, { schemaVersion: 1, purpose: 'mac_rc_upload', sourceCommit: report.sourceCommit, publicCommit: c.publicCommit, appVersion: VERSION,
    architecture: 'arm64', repository: REPOSITORY, runId: c.runId, runAttempt: c.runAttempt, artifactId: c.artifactId,
    artifactUrl: `https://github.com/${REPOSITORY}/actions/runs/${c.runId}/artifacts/${c.artifactId}`, artifactDigest: c.artifactDigest }, 'source/run/upload binding')
  exact(verification, ['schemaVersion', 'verificationClass', 'sourceCommit', 'appVersion', 'architecture', 'candidateBundleSha256', 'executableSha256', 'teamId', 'signingIdentity', 'cdhash', 'dmgSha256', 'zipSha256', 'verifiedAt'], 'candidate verification')
  const { verifiedAt, ...identity } = verification
  equal(identity, { schemaVersion: 1, verificationClass: 'private_rc_candidate', sourceCommit: report.sourceCommit, appVersion: VERSION, architecture: 'arm64',
    candidateBundleSha256: c.app.bundleSha256, executableSha256: c.app.executableSha256, teamId: c.app.teamId,
    signingIdentity: c.app.signingIdentity, cdhash: c.app.cdhash, dmgSha256: c.dmgSha256, zipSha256: c.zipSha256 }, 'physical candidate receipt binding')
  timestamp(verifiedAt, 'candidate verification time')
}

/** Copy validated in-memory bytes, never re-open the live evidence paths after verification. */
export function copyPartialAuthReleaseSnapshot(loaded, copyTo, options) {
  const { report } = loaded, destination = path.resolve(copyTo)
  if (destination === loaded.root || destination.startsWith(`${loaded.root}${path.sep}`) || loaded.root.startsWith(`${destination}${path.sep}`)) throw new Error('copy destination overlaps the sealed input bundle')
  if (fs.existsSync(destination)) throw new Error('copy destination must be new')
  fs.mkdirSync(destination, { mode: 0o700 })
  for (const name of [...report.files.map(file => file.path), report.review.path, loaded.reportName]) {
    const target = path.join(destination, relative(name)); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const bytes = name === loaded.reportName ? loaded.reportBytes : name === report.review.path ? loaded.reviewDocument : loaded.documents.get(name)
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
  }
  const copiedReport = path.join(destination, loaded.reportName), copied = loadPartialAuthReleaseReport(copiedReport, options)
  equal(copied.report, report, 'copied report differs from physically verified snapshot')
  equal(hash(copied.reportBytes), hash(loaded.reportBytes), 'copied report bytes')
  equal(hash(copied.reviewDocument), hash(loaded.reviewDocument), 'copied review bytes')
  return copiedReport
}

const APP_ZIP_CHECK = String.raw`import os,sys,hashlib,zipfile,stat,posixpath,json,struct,unicodedata
root=sys.argv[2]
f=os.fdopen(3,'rb',closefd=False)
f.seek(0)
before=os.fstat(3)
h=hashlib.sha256()
for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
if h.hexdigest()!=sys.argv[1]:raise ValueError('App ZIP digest mismatch')
f.seek(0)
with zipfile.ZipFile(f) as z:
 infos=z.infolist()
 if not infos or len(infos)>50000:raise ValueError('App ZIP entry count invalid')
 entries={};links={};folded={};total=0
 def fold(name):return unicodedata.normalize('NFC',name).casefold()
 def check_extra(extra):
  while extra:
   if len(extra)<4:raise ValueError('malformed App ZIP extra field')
   tag,size=struct.unpack('<HH',extra[:4])
   if size>len(extra)-4:raise ValueError('malformed App ZIP extra length')
   if tag==0x000A:
    payload=extra[4:4+size]
    # Historical electron-builder ZIPs use exactly three NTFS FILETIME values.
    # Admit no additional NTFS subtags or metadata/path override semantics.
    if size!=32 or payload[:4]!=b'\x00'*4 or struct.unpack('<HH',payload[4:8])!=(1,24):raise ValueError('unreviewed NTFS timestamp metadata')
   elif tag not in (0x0001,0x5455,0x5855,0x7875):raise ValueError('unreviewed App ZIP metadata override')
   extra=extra[4+size:]
 for i in infos:
  raw=i.filename
  if i.orig_filename!=raw:raise ValueError('normalized App ZIP filename')
  if not i.flag_bits&0x800 and not raw.isascii():raise ValueError('ambiguous App ZIP filename encoding')
  if not raw or '\\' in raw or '\x00' in raw:raise ValueError('unsafe App ZIP name')
  name=raw.rstrip('/')
  parts=name.split('/')
  if any(p in ('','.', '..') for p in parts) or parts[0]!=root:raise ValueError('App ZIP root escape')
  if fold(name) in folded:raise ValueError('duplicate or case-colliding App ZIP entry')
  folded[fold(name)]=name
  mode=i.external_attr>>16;kind=stat.S_IFMT(mode)
  if i.create_system!=3 or kind not in (stat.S_IFREG,stat.S_IFDIR,stat.S_IFLNK):raise ValueError('unsupported App ZIP entry type')
  if mode&0o7000 or (kind!=stat.S_IFLNK and mode&0o022):raise ValueError('unsafe App ZIP permissions')
  check_extra(i.extra)
  # zipfile.open cross-checks local filename/flags against the central entry.
  with z.open(i):pass
  f.seek(i.header_offset+26);header=f.read(4)
  if len(header)!=4:raise ValueError('truncated App ZIP local header')
  namesize,extrasize=struct.unpack('<HH',header);f.seek(namesize,1);localextra=f.read(extrasize)
  if len(localextra)!=extrasize:raise ValueError('truncated App ZIP local metadata')
  check_extra(localextra)
  if i.flag_bits&1:raise ValueError('encrypted App ZIP entry')
  total+=i.file_size
  if total>8*1024*1024*1024:raise ValueError('App ZIP uncompressed size limit')
  entries[name]=kind
  if kind==stat.S_IFLNK:
   if i.file_size<1 or i.file_size>4096 or raw.endswith('/'):raise ValueError('unsafe App ZIP symlink')
   target=z.read(i).decode('utf8')
   if target.startswith('/') or '\\' in target or '\x00' in target:raise ValueError('absolute or unsafe App ZIP link')
   resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target))
   if resolved!=root and not resolved.startswith(root+'/'):raise ValueError('App ZIP link escape')
   links[name]=target
 for name in entries:
  parent=posixpath.dirname(name)
  while parent:
   actual_parent=folded.get(fold(parent),parent)
   if actual_parent in links:raise ValueError('App ZIP entry traverses symlink parent')
   if actual_parent in entries and entries[actual_parent]!=stat.S_IFDIR:raise ValueError('App ZIP parent is not directory')
   parent=posixpath.dirname(parent)
 def resolve_link(name):
  # Resolve components in filesystem order: do not normalize '..' before following links.
  pending=name.split('/');stack=[];expansions=0
  while pending:
   token=pending.pop(0)
   if token in ('','.'):continue
   if token=='..':
    if len(stack)<=1:raise ValueError('App ZIP indirect link escape')
    stack.pop();continue
   stack.append(token);key='/'.join(stack);actual=folded.get(fold(key))
   if actual is None:raise ValueError('dangling App ZIP link')
   stack=actual.split('/')
   if actual in links:
    expansions+=1
    if expansions>64:raise ValueError('cyclic App ZIP link')
    stack.pop();pending=links[actual].split('/')+pending
   elif pending and entries[actual]!=stat.S_IFDIR:raise ValueError('App ZIP link traverses file')
  return '/'.join(stack)
 for name in links:resolve_link(name)

after=os.fstat(3)
if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('App ZIP changed during validation')
f.seek(0)
print(json.dumps({'entries':len(entries),'symlinks':len(links)}))
`

/** Validate entry types and all relative link targets before invoking Apple's metadata-preserving extractor. */
export function extractPartialCandidateAppArchive(archive, expectedDigest, destination, snapshotPath, appBundleName = 'Tide Mind.app') {
  if (!['Tide Mind.app', 'ChatGPT.app', 'Claude.app'].includes(appBundleName)) throw new Error('unreviewed App ZIP root')
  digest(expectedDigest, 'App ZIP digest')
  if (fs.existsSync(destination) || fs.existsSync(snapshotPath)) throw new Error('App extraction destination/snapshot must be new')
  fs.copyFileSync(archive, snapshotPath, fs.constants.COPYFILE_EXCL); fs.chmodSync(snapshotPath, 0o400)
  equal(fileHash(snapshotPath), expectedDigest, 'private App ZIP snapshot')
  const fd = fs.openSync(snapshotPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const validate = () => JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-c', APP_ZIP_CHECK, expectedDigest, appBundleName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }))
    const result = validate()
    fs.mkdirSync(destination, { mode: 0o700 })
    execFileSync('/usr/bin/ditto', ['-x', '-k', '/dev/fd/3', destination], { stdio: ['ignore', 'pipe', 'pipe', fd] })
    validate()
    return result
  } finally { fs.closeSync(fd) }
}

export function verifyPartialAuthRelease({ reportPath, expectedSourceCommit, artifactZip, uploadReceiptZip, performanceArtifactZip, stage, copyTo, requirementsPath, releaseManifestPath }) {
  if (process.platform !== 'darwin') throw new Error('partial release requires macOS physical verification')
  if ((requirementsPath && path.resolve(requirementsPath) !== path.join(ROOT, 'scripts/agent-integration-host-acceptance-requirements.json'))
    || (releaseManifestPath && path.resolve(releaseManifestPath) !== path.join(ROOT, 'client/electron/agent-integration/release-manifest.ts'))) throw new Error('physical release verifier cannot substitute source contracts')
  const options = { expectedSourceCommit, requirementsPath, releaseManifestPath }
  const loaded = loadPartialAuthReleaseReport(reportPath, options), { report } = loaded, c = report.candidate
  if (!performanceArtifactZip) throw new Error('performanceArtifactZip is required')
  const directory = path.resolve(stage)
  if (fs.existsSync(directory)) throw new Error('stage must be a new directory')
  fs.mkdirSync(directory, { mode: 0o700 })
  const assets = path.join(directory, 'assets'), receipts = path.join(directory, 'upload-receipt'), appRoot = path.join(directory, 'app')
  extract(path.resolve(uploadReceiptZip), c.uploadReceiptArtifactDigest, ['mac-rc-upload-receipt.json'], receipts)
  extract(path.resolve(artifactZip), c.artifactDigest, candidateNames(), assets)
  const performanceRoot = path.join(directory, 'performance')
  verifyPartialPerformanceArtifact(report, performanceArtifactZip, performanceRoot)
  const lines = regularBytes(path.join(assets, 'files.sha256')).toString('utf8').trim().split(/\r?\n/u), listed = new Map()
  for (const line of lines) { const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line); if (!match || listed.has(match[2])) throw new Error('invalid inner checksum manifest'); listed.set(match[2], match[1]) }
  equal([...listed.keys()].sort(), candidateNames().filter(name => name !== 'files.sha256'), 'inner checksum coverage')
  for (const [name, value] of listed) equal(fileHash(path.join(assets, name)), value, `candidate file ${name}`)
  validatePartialCandidateReceipts(report, JSON.parse(regularBytes(path.join(receipts, 'mac-rc-upload-receipt.json'))), JSON.parse(regularBytes(path.join(assets, 'candidate-verification.json'))))
  const appArchive = path.join(assets, `Tide.Mind-${VERSION}-arm64-stapled-app.zip`)
  validateCandidateArchiveEntries(run('/usr/bin/unzip', ['-Z1', appArchive]).split(/\r?\n/u).filter(Boolean))
  extractPartialCandidateAppArchive(appArchive, listed.get(`Tide.Mind-${VERSION}-arm64-stapled-app.zip`), appRoot, path.join(directory, 'candidate-app-extraction.zip'))
  const app = path.join(appRoot, 'Tide Mind.app')
  equal(inspectPhysicalTideMindCandidateApp(app, VERSION, expectedSourceCommit, 'arm64'), c.app, 'physical signed App')
  equal(fileHash(path.join(app, 'Contents/Resources/app.asar.unpacked/out/bin/metabolism-worker.cjs')), c.performance.workerSha256, 'candidate performance Worker identity')
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]); run('/usr/bin/xcrun', ['stapler', 'validate', app])
  const finalReceipt = path.join(directory, 'container-reverification.json')
  run(process.execPath, [path.join(ROOT, 'scripts/verify-mac-release-assets.mjs'), '--private-rc-candidate', '--release-dir', assets, '--arch', 'arm64', '--app', app,
    '--source-commit', expectedSourceCommit, '--receipt', finalReceipt])
  validatePartialCandidateReceipts(report, JSON.parse(regularBytes(path.join(receipts, 'mac-rc-upload-receipt.json'))), JSON.parse(regularBytes(finalReceipt)))
  // Inputs remain sealed across the potentially long physical verification.
  const fresh = loadPartialAuthReleaseReport(reportPath, options)
  equal(hashPartialAuthReleaseBody(fresh.report), hashPartialAuthReleaseBody(report), 'report changed during verification')
  let copiedReport = null
  if (copyTo) copiedReport = copyPartialAuthReleaseSnapshot(loaded, copyTo, options)

  return Object.freeze({ ...fresh.summary, status: 'eligible_under_0.2.93_auth_runtime_exception', physicalVerified: true,
    stage: directory, assetsDirectory: assets, candidateApp: app, copiedReport })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), names = new Set(['--report', '--source-commit', '--artifact-zip', '--upload-receipt-zip', '--performance-artifact-zip', '--stage', '--copy-to', '--output', '--nonstandard-source'])
    const values = {}, switches = new Set()
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--template') { if (switches.has(args[i])) throw new Error('duplicate switch'); switches.add(args[i]); continue }
      if (!names.has(args[i]) || own(values, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('unknown/duplicate/missing CLI argument')
      values[args[i]] = args[++i]
    }
    if (switches.has('--template')) {
      if (!values['--output'] || Object.keys(values).some(key => !['--output', '--source-commit', '--nonstandard-source'].includes(key))) throw new Error('invalid template arguments')
      const value = buildPartialAuthReleaseTemplate({ expectedSourceCommit: values['--source-commit'], nonstandardSourceCatalogId: values['--nonstandard-source'] })
      fs.writeFileSync(path.resolve(values['--output']), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      process.stdout.write(`${JSON.stringify({ status: 'pending_template_not_release_evidence', targets: value.targets.length, upgrades: value.upgradePaths.length })}\n`)
    } else {
      for (const name of ['--report', '--source-commit', '--artifact-zip', '--upload-receipt-zip', '--performance-artifact-zip', '--stage']) if (!values[name]) throw new Error(`missing ${name}`)
      if (values['--output'] || values['--nonstandard-source']) throw new Error('template-only argument')
      const result = verifyPartialAuthRelease({ reportPath: path.resolve(values['--report']), expectedSourceCommit: values['--source-commit'], artifactZip: path.resolve(values['--artifact-zip']),
        uploadReceiptZip: path.resolve(values['--upload-receipt-zip']), performanceArtifactZip: path.resolve(values['--performance-artifact-zip']), stage: path.resolve(values['--stage']), copyTo: values['--copy-to'] && path.resolve(values['--copy-to']) })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
