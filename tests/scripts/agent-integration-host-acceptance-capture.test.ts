import { databaseMigrationFixture } from '../fixtures/agent-integration/database-migration-fixture.js'
import { memoryClosureFixture } from '../fixtures/agent-integration/memory-closure-fixture.js'
import { codexContextRestoreFixture } from '../fixtures/agent-integration/codex-context-restore-fixture.js'
// @ts-expect-error acceptance-only ESM helper
import { codexNativeLifecycleEvidenceHash } from '../../scripts/codex-context-restore-evidence.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error local plain-ESM capture CLI has no declaration file
import {
  AGENT_HOST_ACCEPTANCE_REDACTION_STATEMENT,
  agentHostAcceptanceCaptureStatus,
  initializeAgentHostAcceptanceCapture,
  prepareAgentHostAcceptanceReview,
  recordAgentHostAcceptanceStep,
  recordAgentHostAcceptanceTarget,
  recordAgentHostAcceptanceUpgrade,
  recordAgentDatabaseRecovery,
  runAgentHostAcceptanceCaptureCli,
} from '../../scripts/capture-agent-integration-host-acceptance.mjs'
// @ts-expect-error local plain-ESM verifier has no declaration file
import {
  distributionArtifactReceiptSha256,
  hostAcceptanceTargetIdentityDigest,
  hostActivityLedgerEvidenceHash,
  hostActivityLedgerExportHash,
  loadAgentHostAcceptanceRequirements,
  upgradeTargetIdentityDigest,
  validateUserOwnedCustomActivityBinding,
} from '../../scripts/verify-agent-integration-host-acceptance.mjs'

const roots: string[] = []
const SOURCE_COMMIT = 'a'.repeat(40)
const OBSERVED_AT = '2026-09-04T10:00:00.000Z'

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-capture-test-')))
  roots.push(root)
  return root
}

function writeJson(file: string, value: unknown): string {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

function fixtureDistributionProof(
  distributionId: string,
  packageProvenance: string,
  receipt?: {
    portableArtifactFingerprint: string
    executableSha256: string
    executableSizeBytes: number
    distributionSha256: string
    distributionSizeBytes: number
  },
) {
  return {
    distributionId,
    packageProvenance,
    artifactReceiptSha256: receipt
      ? distributionArtifactReceiptSha256(receipt)
      : sha256(`receipt:${distributionId}`),
    portableArtifactFingerprint: receipt?.portableArtifactFingerprint ?? sha256(`portable:${distributionId}`),
    executableSha256: receipt?.executableSha256 ?? sha256('host executable'),
    executableSizeBytes: receipt?.executableSizeBytes ?? 101,
    rawExecutableSha256: receipt?.executableSha256 ?? sha256('host executable'),
    rawExecutableSizeBytes: receipt?.executableSizeBytes ?? 101,
    distributionSha256: receipt?.distributionSha256 ?? sha256('host distribution'),
    distributionSizeBytes: receipt?.distributionSizeBytes ?? 201,
  }
}

function initialized() {
  const root = makeRoot()
  const workspace = path.join(root, 'capture')
  const requirements = loadAgentHostAcceptanceRequirements()
  const candidateMetadataPathsByArchitecture = Object.fromEntries(requirements.releaseMacArchitectures.map((architecture: string) => [architecture, writeJson(path.join(root, `candidate-${architecture}.json`), {
    version: requirements.appVersion,
    sourceCommit: SOURCE_COMMIT,
    bundleSha256: sha256(`candidate bundle:${architecture}`),
    executableSha256: sha256(`candidate executable:${architecture}`),
    teamId: 'TIDEMINDTEAM',
    signingIdentity: 'Developer ID Application: Tide Mind',
    cdhash: `signed-candidate-cdhash-${architecture}`,
  })]))
  initializeAgentHostAcceptanceCapture({
    workspace,
    acceptanceId: 'real-host-candidate-1',
    sourceCommit: SOURCE_COMMIT,
    candidateMetadataPathsByArchitecture,
    now: () => new Date('2026-09-04T09:00:00.000Z'),
    testOnlyAllowUnacceptedRelease: true,
  })
  return { root, workspace, requirements }
}

function recordTargetMetadata(workspace: string, root: string, requestedTargetId?: string) {
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
  const target = requestedTargetId
    ? state.entries.find((entry: { targetId: string; architecture: string }) => entry.targetId === requestedTargetId && entry.architecture === 'arm64')
    : state.entries.find((entry: { targetId: string }) => entry.targetId === 'codex-cli')
  const targetKey = target.targetKey as string
  const acceptedDistribution = target.officialDistributions[0]
  const acceptedReceipt = target.acceptedDistributionArtifacts.find((receipt: {
    distributionId: string
    architecture: string
  }) => receipt.distributionId === acceptedDistribution.distributionId
    && receipt.architecture === target.architecture)
  if (!acceptedReceipt) throw new Error(`test fixture lacks an accepted receipt for ${targetKey}`)
  const metadataPath = writeJson(path.join(root, 'target.json'), {
    targetKey,
    targetId: target.targetId,
    hostVersion: acceptedReceipt.version,
    distribution: fixtureDistributionProof(
      acceptedDistribution.distributionId,
      acceptedDistribution.packageProvenance,
      acceptedReceipt,
    ),
    environment: {
      platform: 'darwin',
      architecture: target.architecture,
      processArchitecture: target.architecture,
      hardwareArchitecture: target.architecture === 'x64' ? 'x86_64' : 'arm64',
      translationMode: 'not_translated',
      osVersion: '15.6.1',
      hostIdentitySha256: sha256('disposable acceptance host'),
    },
    installationId: 'installation-real-host-1',
    agentId: 'eb_real_host_1',
  })
  const result = recordAgentHostAcceptanceTarget({
    workspace, targetId: targetKey, metadataPath, testOnlyAllowFixtureMetadata: true,
  })
  return { targetId: targetKey, stepId: result.requiredSteps[0] as string, hostVersion: acceptedReceipt.version as string }
}

function recordFirstTargetMetadata(workspace: string, root: string) {
  return recordTargetMetadata(workspace, root)
}

function stepInputs(root: string, workspace: string, targetId: string, stepId: string, outcome = 'passed') {
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
  const target = [...state.entries, ...state.customPaths].find((entry: { targetKey: string }) => entry.targetKey === targetId)
  const assertionPath = writeJson(path.join(root, 'assertion.json'), {
    schemaVersion: 2,
    targetKey: target.targetKey,
    targetId: target.targetId,
    stepId,
    sourceCommit: state.sourceCommit,
    releaseContractSha256: state.releaseContractSha256,
    candidateBundleSha256: state.candidateAppsByArchitecture[target.environment.architecture].bundleSha256,
    installationId: target.installationId,
    agentId: target.agentId,
    outcome,
    assertionSource: 'human',
    assertedBy: 'acceptance-operator',
    observedAt: OBSERVED_AT,
    assertions: ['The expected business behavior was directly observed in the official host.'],
    activityReceipt: null,
  })
  const evidencePath = path.join(root, 'redacted-observation.txt')
  fs.writeFileSync(evidencePath, 'Visible official host result with sensitive UI removed.\n')
  const evidenceBytes = fs.readFileSync(evidencePath)
  const attestationPath = writeJson(path.join(root, 'attestation.json'), {
    schemaVersion: 1,
    attestedBy: 'redaction-operator',
    attestedAt: OBSERVED_AT,
    statement: AGENT_HOST_ACCEPTANCE_REDACTION_STATEMENT,
    files: [{ name: path.basename(evidencePath), sha256: sha256(evidenceBytes) }],
  })
  return { assertionPath, evidencePath, attestationPath }
}



function migrationSupportingFiles(root: string, createdAt: string, sourceSchema = 35, agentId?: string) {
  const migration = databaseMigrationFixture(createdAt, OBSERVED_AT, sourceSchema)
  if (agentId) {
    ;(migration.before.tables.agents as any).identities = [{id: agentId}]
    ;(migration.after.tables.agents as any).identities = [{id: agentId}]
    migration.files.clear()
    migration.receipt.beforeEvidenceSha256 = migration.add(migration.before)
    migration.receipt.backupEvidenceSha256 = migration.receipt.beforeEvidenceSha256
    migration.receipt.afterEvidenceSha256 = migration.add(migration.after)
  }
  const paths = [...migration.files].map(([hash, bytes]) => {
    const file = path.join(root, `migration-${hash.slice(0, 12)}.json`)
    fs.writeFileSync(file, bytes)
    return file
  })
  return { migration, paths }
}

function recordCustomUpgradeFixture(root: string, workspace: string, targetKey: string) {
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
  const target = state.customPaths.find((item: { targetKey: string }) => item.targetKey === targetKey)
  const { migration, paths } = migrationSupportingFiles(root, state.createdAt, 35, 'eb_custom')
  const evidencePath = path.join(root, 'custom-upgrade-observation.txt')
  fs.writeFileSync(evidencePath, 'Isolated fixture: Custom identity and history survive upgrade.\n')
  const attestationPath = writeJson(path.join(root, 'custom-upgrade-attestation.json'), {
    schemaVersion: 1, attestedBy: 'fixture-reviewer', attestedAt: OBSERVED_AT,
    statement: AGENT_HOST_ACCEPTANCE_REDACTION_STATEMENT,
    files: [evidencePath, ...paths].map(file => ({ name: path.basename(file), sha256: sha256(fs.readFileSync(file)) })),
  })
  for (const fromAppVersion of state.upgradeFromAppVersions) {
    const assertionPath = writeJson(path.join(root, 'custom-upgrade-assertion.json'), {
      schemaVersion: 2, targetKey, targetId: target.targetId,
      fromAppVersion, toAppVersion: state.appVersion, sourceCommit: state.sourceCommit,
      releaseContractSha256: state.releaseContractSha256,
      candidateBundleSha256: state.candidateAppsByArchitecture[target.architecture].bundleSha256,
      targetIdentitySha256: upgradeTargetIdentityDigest(target, state.releaseContractSha256),
      outcome: 'passed', assertionSource: 'external', assertedBy: 'fixture-runner', observedAt: OBSERVED_AT,
      assertions: ['Isolated fixture preserved Custom identity, history and statistics.'],
      installationId: null, originalAgentId: 'eb_custom', migratedAgentId: 'eb_custom',
      historyPreserved: true, statisticsPreserved: true, databaseMigration: { ...migration.receipt, batchId: migration.receipt.batchId + ':' + fromAppVersion },
    })
    recordAgentHostAcceptanceUpgrade({
      workspace, targetId: targetKey, fromAppVersion, assertionPath, attestationPath, evidencePaths: [evidencePath, ...paths],
    })
  }
  const status = agentHostAcceptanceCaptureStatus(workspace)
  expect(status.recordedUpgradePaths).toEqual(expect.arrayContaining(
    state.upgradeFromAppVersions.map((version: string) => `${targetKey}/${version}`),
  ))
}

describe('real-host Agent Integration acceptance capture workflow', () => {
  it('does not expose arbitrary target proof metadata through the formal API or CLI', () => {
    const { root, workspace } = initialized()
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const target = state.entries[0]
    const metadataPath = writeJson(path.join(root, 'untrusted-target.json'), {
      targetKey: target.targetKey,
    })
    expect(() => recordAgentHostAcceptanceTarget({
      workspace,
      targetId: target.targetKey,
      metadataPath,
    })).toThrow(/fixture-only/)
    expect(() => runAgentHostAcceptanceCaptureCli([
      'target', '--workspace', workspace, '--target', target.targetKey,
      '--metadata', metadataPath, '--output', path.join(root, 'export.json'),
    ])).toThrow(/unknown arguments/)
  })

  it('requires physical candidate apps after the release contract is frozen', () => {
    const root = makeRoot()
    const requirements = loadAgentHostAcceptanceRequirements()
    expect(requirements.upgradeFromAppVersions).toEqual(['0.2.89','0.2.90','0.2.91','0.2.92','0.2.93'])
    const candidatePath = writeJson(path.join(root, 'candidate.json'), {
      version: requirements.appVersion,
      sourceCommit: SOURCE_COMMIT,
      bundleSha256: sha256('candidate bundle'),
      executableSha256: sha256('candidate executable'),
      teamId: 'TEAM',
      signingIdentity: 'Developer ID Application: Test',
      cdhash: 'cdhash',
    })
    const workspace = path.join(root, 'capture')
    expect(() => initializeAgentHostAcceptanceCapture({
      workspace,
      acceptanceId: 'capture-not-ready',
      sourceCommit: SOURCE_COMMIT,
      candidateMetadataPathsByArchitecture: { arm64: candidatePath, x64: candidatePath },
    })).toThrow(/absolute arm64 candidate app path/)
    expect(fs.existsSync(workspace)).toBe(false)
  })

  it('initializes a real-host-only draft without reading or modifying Agent configuration', () => {
    const root = makeRoot()
    const fakeAgentConfig = path.join(root, 'agent-config.json')
    fs.writeFileSync(fakeAgentConfig, '{"userOwned":true}\n')
    const before = fs.readFileSync(fakeAgentConfig)
    const requirements = loadAgentHostAcceptanceRequirements()
    expect(requirements.upgradeFromAppVersions).toEqual(['0.2.89','0.2.90','0.2.91','0.2.92','0.2.93'])
    const candidatePath = writeJson(path.join(root, 'candidate.json'), {
      version: requirements.appVersion,
      sourceCommit: SOURCE_COMMIT,
      bundleSha256: sha256('candidate bundle'),
      executableSha256: sha256('candidate executable'),
      teamId: 'TEAM',
      signingIdentity: 'Developer ID Application: Test',
      cdhash: 'cdhash',
    })
    const workspace = path.join(root, 'capture')
    const result = initializeAgentHostAcceptanceCapture({
      workspace,
      acceptanceId: 'capture-1',
      sourceCommit: SOURCE_COMMIT,
      candidateMetadataPathsByArchitecture: { arm64: candidatePath, x64: candidatePath },
      testOnlyAllowUnacceptedRelease: true,
    })
    expect(result).toMatchObject({
      appVersion: '0.2.94',
      recordedStepCount: 0,
      requiredUpgradePaths: expect.arrayContaining([
        'opencode-v2-beta-cli:arm64:cli%3Aopencode-v2-beta-cli%3Adarwin-arm64/0.2.89',
        'opencode-v2-beta-cli:arm64:cli%3Aopencode-v2-beta-cli%3Adarwin-arm64/0.2.91',
      ]),
    })
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const restartBoundTargets = state.entries.filter((target: { realHostDeferral: unknown }) => !target.realHostDeferral)
    expect(restartBoundTargets.every((target: { requiredSteps: string[] }) => (
      target.requiredSteps.includes('restart_persistence')
    ))).toBe(true)
    expect(result.requiredUpgradePaths).toHaveLength(
      (state.entries.length + state.customPaths.length) * requirements.upgradeFromAppVersions.length,
    )
    expect(result.requiredUpgradePaths.some((upgrade: string) => (
      upgrade.startsWith('nonstandard_config_root/') || upgrade.startsWith('manual_mcp_client/')
    ))).toBe(true)
    expect(fs.readFileSync(fakeAgentConfig)).toEqual(before)
    expect(fs.statSync(path.join(workspace, '.capture-state.json')).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['standard_mcp_servers','tidemind'], ['nested_mcp_servers','tidemind_nested'], ['opencode_mcp','tidemind_opencode'],
  ])('keeps deferred user-owned %s upgrades without runtime metadata; activity validator remains strict', (schemaKind, selectorKey) => {
    const { root, workspace } = initialized()
    const targetKey = `manual_mcp_client:${schemaKind}:${selectorKey}`
    const metadata = {
      targetKey, targetId: 'manual_mcp_client', hostVersion: 'custom-123',
      distribution: fixtureDistributionProof('custom-local-executable:123', 'user_selected_local_executable'),
      environment: {
        platform: 'darwin', architecture: 'arm64', processArchitecture: 'arm64',
        hardwareArchitecture: 'arm64', translationMode: 'not_translated',
        osVersion: '15.6.1', hostIdentitySha256: sha256('host'),
      },
      installationId: 'installation-custom', agentId: 'eb_custom',
      customBinding: {
        kind: 'manual_mcp_client', configurationOwnership: 'user', sourceInstallationId: null, sourceCatalogId: null,
        configRootIdentitySha256: sha256('root'), configFileIdentitySha256: null,
        selectorIdentitySha256: sha256('selector'), executableFingerprint: sha256('executable'),
        sourceLiveTrustProofSha256: null, liveTrustProofSha256: sha256('live'), readBackProofSha256: null,
        activityBinding: {
          installationId: 'installation-custom', agentId: 'eb_custom', activationRunId: 'run-custom',
          generationSha256: sha256('generation'), connectorConfigurationSha256: sha256('configuration'),
          runtimeBindingSha256: sha256('runtime'), tideMindVersion: '0.2.94', adapterVersion: '1', projectionVersion: '1', hostVersion: 'custom-123',
          schemaKind, selectorKey,
          evidence: ['brain_prepare','brain_recall','brain_digest'].map(signalName => ({
            id: `aha_${sha256(signalName).slice(0,24)}`, signalName, evidenceHash: sha256(signalName), observedAt: '2026-09-05T00:00:00.000Z',
          })),
        },
      },
    }
    const metadataPath = writeJson(path.join(root,'custom-user-owned.json'), metadata)
    expect(() => recordAgentHostAcceptanceTarget({ workspace, targetId: targetKey, metadataPath, testOnlyAllowFixtureMetadata: true }))
      .toThrow('deferred target does not accept real-host metadata')
    recordCustomUpgradeFixture(root, workspace, targetKey)
    recordCustomUpgradeFixture(root, workspace, 'manual_mcp_client')
    // The original runtime activity validator remains strict when explicitly used.
    metadata.customBinding.activityBinding.evidence = metadata.customBinding.activityBinding.evidence.filter(event => event.signalName !== 'brain_prepare')
    expect(() => validateUserOwnedCustomActivityBinding(metadata.customBinding.activityBinding, {}))
      .toThrow('requires prepare, recall and digest')
  })

  it('records a complete memory closure from the witnessed transcript and SQLite products', () => {
    const { root, workspace } = initialized()
    const { targetId } = recordFirstTargetMetadata(workspace, root)
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const target = state.entries.find((item: { targetKey: string }) => item.targetKey === targetId)
    const inputs = stepInputs(root, workspace, targetId, 'memory_closure')
    const assertion = JSON.parse(fs.readFileSync(inputs.assertionPath, 'utf8'))
    const closure = memoryClosureFixture({
      targetKey: targetId, installationId: target.installationId, agentId: target.agentId,
      sourceCommit: state.sourceCommit, releaseContractSha256: state.releaseContractSha256,
      candidateBundleSha256: state.candidateAppsByArchitecture[target.environment.architecture].bundleSha256,
      hostVariant: target.targetId, hostVersion: target.hostVersion,
    }, state.createdAt, OBSERVED_AT)
    assertion.memoryClosure = closure.receipt
    writeJson(inputs.assertionPath, assertion)
    const evidencePaths = [...closure.files].map(([_hash, bytes], index) => {
      const file = path.join(root, `memory-proof-${index}.json`)
      fs.writeFileSync(file, bytes)
      return file
    })
    const attestation = JSON.parse(fs.readFileSync(inputs.attestationPath, 'utf8'))
    attestation.files = evidencePaths.map(file => ({ name: path.basename(file), sha256: sha256(fs.readFileSync(file)) }))
    writeJson(inputs.attestationPath, attestation)
    expect(recordAgentHostAcceptanceStep({
      workspace, targetId, stepId: 'memory_closure', assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath, evidencePaths,
    })).toMatchObject({ targetKey: targetId, stepId: 'memory_closure' })
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    expect(saved.entries.find((item: { targetKey: string }) => item.targetKey === targetId).steps[0].memoryClosure)
      .toEqual(closure.receipt)
  })

  it('never infers business success from a command or file and requires an explicit passed assertion', () => {
    const { root, workspace } = initialized()
    const { targetId, stepId } = recordFirstTargetMetadata(workspace, root)
    const inputs = stepInputs(root, workspace, targetId, stepId, 'failed')
    expect(() => recordAgentHostAcceptanceStep({
      workspace,
      targetId,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })).toThrow(/explicitly state business outcome passed/)
    expect(agentHostAcceptanceCaptureStatus(workspace).recordedStepCount).toBe(0)
  })

  it.each(['codex-cli', 'cursor-desktop'])('records Custom config-root only for a supported source: %s', catalogId => {
    const { root, workspace, requirements } = initialized()
    const unsupported = requirements.entries.find((entry: { catalogId: string }) => entry.catalogId === catalogId)
    expect(unsupported.customConfigRoot.supported).toBe(catalogId === 'cursor-desktop')
    const acceptedDistribution = unsupported.officialDistributions[0]
    const acceptedReceipt = unsupported.acceptedDistributionArtifacts.find((receipt: {
      distributionId: string
      architecture: string
    }) => receipt.distributionId === acceptedDistribution.distributionId && receipt.architecture === 'arm64')
    expect(acceptedReceipt).toBeDefined()
    const metadataPath = writeJson(path.join(root, 'custom-target.json'), {
      targetKey: 'nonstandard_config_root',
      targetId: 'nonstandard_config_root',
      sourceCatalogId: unsupported.catalogId,
      hostVersion: acceptedReceipt.version,
      distribution: fixtureDistributionProof(
        acceptedDistribution.distributionId,
        acceptedDistribution.packageProvenance,
        acceptedReceipt,
      ),
      environment: {
        platform: 'darwin', architecture: 'arm64', processArchitecture: 'arm64',
        hardwareArchitecture: 'arm64', translationMode: 'not_translated', osVersion: '15.6.1',
        hostIdentitySha256: sha256('host'),
      },
      installationId: 'installation-custom',
      agentId: 'eb_custom',
      customBinding: {
        kind: 'nonstandard_config_root',
        sourceInstallationId: 'installation-source',
        sourceCatalogId: unsupported.catalogId,
        configRootIdentitySha256: sha256('custom-root'),
        configFileIdentitySha256: null,
        selectorIdentitySha256: sha256('custom-selector'),
        executableFingerprint: null,
        sourceLiveTrustProofSha256: sha256('source-trust'),
        liveTrustProofSha256: sha256('custom-trust'),
        readBackProofSha256: sha256('custom-readback'),
      },
    })
    const record = () => recordAgentHostAcceptanceTarget({
      workspace, targetId: 'nonstandard_config_root', metadataPath,
      testOnlyAllowFixtureMetadata: true,
    })
    expect(record).toThrow(/deferred target does not accept real-host metadata/)
    recordCustomUpgradeFixture(root, workspace, 'nonstandard_config_root')
  })

  it('records a source-bound structured receipt only with redacted evidence and an exact attestation', () => {
    const { root, workspace } = initialized()
    const { targetId, stepId, hostVersion } = recordFirstTargetMetadata(workspace, root)
    const inputs = stepInputs(root, workspace, targetId, stepId)
    const result = recordAgentHostAcceptanceStep({
      workspace,
      targetId,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })
    expect(result).toMatchObject({ targetKey: targetId, stepId, evidenceFileCount: 4 })
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const step = state.entries.find((entry: { targetId: string }) => entry.targetId === 'codex-cli').steps[0]
    expect(step.receipt).toMatchObject({
      sourceCommit: SOURCE_COMMIT,
      candidateBundleSha256: state.candidateAppsByArchitecture.arm64.bundleSha256,
      releaseContractSha256: state.releaseContractSha256,
      hostVersion,
      installationId: 'installation-real-host-1',
      agentId: 'eb_real_host_1',
    })
    expect(step.receipt.evidenceIds).toHaveLength(3)
    expect(step.receipt.outcomeDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects a step assertion copied from a different Installation or candidate', () => {
    const { root, workspace } = initialized()
    const { targetId, stepId } = recordFirstTargetMetadata(workspace, root)
    const inputs = stepInputs(root, workspace, targetId, stepId)
    const assertion = JSON.parse(fs.readFileSync(inputs.assertionPath, 'utf8'))
    assertion.installationId = 'installation-from-another-run'
    fs.writeFileSync(inputs.assertionPath, `${JSON.stringify(assertion)}\n`)
    expect(() => recordAgentHostAcceptanceStep({
      workspace,
      targetId,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })).toThrow(/installationId binding mismatch/)
    assertion.installationId = 'installation-real-host-1'
    assertion.candidateBundleSha256 = sha256('another signed candidate')
    fs.writeFileSync(inputs.assertionPath, `${JSON.stringify(assertion)}\n`)
    expect(() => recordAgentHostAcceptanceStep({
      workspace,
      targetId,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })).toThrow(/candidateBundleSha256 binding mismatch/)
  })

  it('records CLI native lifecycle evidence without requiring a fabricated shared-identity ledger row', () => {
    const { root, workspace } = initialized()
    recordTargetMetadata(workspace, root, 'codex-cli')
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const target = state.entries.find((entry: { targetId: string }) => entry.targetId === 'codex-cli')
    const stepId = 'lifecycle_post_compact'
    const inputs = stepInputs(root, workspace, target.targetKey, stepId)
    const f = codexContextRestoreFixture()
    f.summary.captureNonce = state.captureNonce; f.sidecar.captureNonce = state.captureNonce
    Object.assign(f.metadata, { evidenceClass: 'fixture', sourceCommit: state.sourceCommit,
      candidateBundleSha256: state.candidateAppsByArchitecture.arm64.bundleSha256, releaseContractSha256: state.releaseContractSha256 })
    Object.assign(f.metadata.targetMetadata, { targetKey: target.targetKey, targetId: target.targetId,
      installationId: target.installationId, agentId: target.agentId, hostVersion: target.hostVersion,
      distribution: target.distribution, environment: target.environment })
    const files = f.build()
    const activity:any = {ledgerSource:'codex_native_hooks',restoreReceipt:f.value,runId:'post-run',turnId:'compact-turn'}
    activity.evidenceHash = codexNativeLifecycleEvidenceHash(activity)
    const assertion = JSON.parse(fs.readFileSync(inputs.assertionPath,'utf8'))
    assertion.activityReceipt = activity; assertion.observedAt = new Date(f.expected.observedAt).toISOString()
    writeJson(inputs.assertionPath,assertion)
    const evidencePaths = [...files.values()].map((bytes: any,index:number)=>{
      const file=path.join(root,`native-proof-${index}.json`);fs.writeFileSync(file,bytes);return file
    })
    const attestation=JSON.parse(fs.readFileSync(inputs.attestationPath,'utf8'))
    attestation.files=evidencePaths.map(file=>({name:path.basename(file),sha256:sha256(fs.readFileSync(file))}))
    writeJson(inputs.attestationPath,attestation)
    expect(recordAgentHostAcceptanceStep({workspace,targetId:target.targetKey,stepId,
      assertionPath:inputs.assertionPath,attestationPath:inputs.attestationPath,evidencePaths})).toMatchObject({stepId})
    const saved=JSON.parse(fs.readFileSync(path.join(workspace,'.capture-state.json'),'utf8'))
    expect(saved.activityExports).toEqual([])
    expect(saved.entries.find((entry:any)=>entry.targetId==='codex-cli').steps).toHaveLength(1)
  })

  it('requires a hash-valid activity-ledger event when no native lifecycle proof is supplied', () => {
    const { root, workspace } = initialized()
    recordTargetMetadata(workspace, root, 'codex-cli')
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const target = state.entries.find((entry: { targetId: string }) => entry.targetId === 'codex-cli')
    const stepId = target.requiredSteps.find((step: string) => step.startsWith('lifecycle_'))
    const inputs = stepInputs(root, workspace, target.targetKey, stepId)
    expect(() => recordAgentHostAcceptanceStep({
      workspace,
      targetId: target.targetKey,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })).toThrow(/lifecycle activity receipt/)

    const assertion = JSON.parse(fs.readFileSync(inputs.assertionPath, 'utf8'))
    const activityReceipt = {
      exporterVersion: 1,
      ledgerSource: 'fixture',
      captureNonce: state.captureNonce,
      targetKey: target.targetKey,
      candidateBundleSha256: state.candidateAppsByArchitecture.arm64.bundleSha256,
      sourceCommit: state.sourceCommit,
      releaseContractSha256: state.releaseContractSha256,
      databaseSchemaVersion: 34,
      databaseSchemaSha256: sha256('fixture v34 activity schema'),
      id: `aha_${'a'.repeat(24)}`,
      installationId: target.installationId,
      agentId: target.agentId,
      hostVariant: target.targetId,
      componentKey: 'lifecycle',
      signalName: stepId.slice('lifecycle_'.length),
      tideMindVersion: state.appVersion,
      adapterVersion: 'adapter-1',
      projectionVersion: 'projection-1',
      hostVersion: target.hostVersion,
      evidenceHash: '',
      observedAt: OBSERVED_AT,
      exportHash: '',
    }
    activityReceipt.evidenceHash = hostActivityLedgerEvidenceHash(activityReceipt)
    activityReceipt.exportHash = hostActivityLedgerExportHash(activityReceipt)
    assertion.activityReceipt = activityReceipt
    fs.writeFileSync(inputs.assertionPath, `${JSON.stringify(assertion)}\n`)
    expect(() => recordAgentHostAcceptanceStep({
      workspace,
      targetId: target.targetKey,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })).toThrow(/was not exported and remains unused/)

    activityReceipt.agentId = 'eb_spliced_agent'
    activityReceipt.exportHash = hostActivityLedgerExportHash(activityReceipt)
    state.activityExports.push({
      eventId: activityReceipt.id,
      targetKey: target.targetKey,
      exportHash: activityReceipt.exportHash,
      outputPath: path.join(root, 'exported-activity.json'),
      consumed: false,
    })
    fs.writeFileSync(path.join(workspace, '.capture-state.json'), `${JSON.stringify(state, null, 2)}\n`)
    assertion.activityReceipt = activityReceipt
    fs.writeFileSync(inputs.assertionPath, `${JSON.stringify(assertion)}\n`)
    expect(() => recordAgentHostAcceptanceStep({
      workspace,
      targetId: target.targetKey,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })).toThrow(/activity receipt agentId binding mismatch/)

    activityReceipt.agentId = target.agentId
    activityReceipt.exportHash = hostActivityLedgerExportHash(activityReceipt)
    const exportedPath = path.join(root, 'exported-activity.json')
    fs.writeFileSync(exportedPath, `${JSON.stringify(activityReceipt)}\n`)
    state.activityExports = [{
      eventId: activityReceipt.id,
      targetKey: target.targetKey,
      exportHash: activityReceipt.exportHash,
      outputPath: exportedPath,
      consumed: false,
    }]
    fs.writeFileSync(path.join(workspace, '.capture-state.json'), `${JSON.stringify(state, null, 2)}\n`)
    assertion.activityReceipt = activityReceipt
    fs.writeFileSync(inputs.assertionPath, `${JSON.stringify(assertion)}\n`)
    expect(recordAgentHostAcceptanceStep({
      workspace,
      targetId: target.targetKey,
      stepId,
      assertionPath: inputs.assertionPath,
      attestationPath: inputs.attestationPath,
      evidencePaths: [inputs.evidencePath],
    })).toMatchObject({ targetKey: target.targetKey, targetId: target.targetId, stepId })
    const consumedState = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    expect(consumedState.activityExports).toEqual([expect.objectContaining({
      eventId: activityReceipt.id,
      exportHash: activityReceipt.exportHash,
      consumed: true,
    })])
  })

  it('rejects likely credentials, credential files, symlinks, and an attestation for different bytes', () => {
    const { root, workspace } = initialized()
    const { targetId, stepId } = recordFirstTargetMetadata(workspace, root)

    const credential = stepInputs(root, workspace, targetId, stepId)
    fs.writeFileSync(credential.evidencePath, 'Authorization: Bearer secret-secret-secret-secret\n')
    expect(() => recordAgentHostAcceptanceStep({
      workspace, targetId, stepId,
      assertionPath: credential.assertionPath,
      attestationPath: credential.attestationPath,
      evidencePaths: [credential.evidencePath],
    })).toThrow(/credential material/)

    const namedSecret = stepInputs(root, workspace, targetId, stepId)
    const secretFile = path.join(root, 'credentials.json')
    fs.writeFileSync(secretFile, '{}\n')
    expect(() => recordAgentHostAcceptanceStep({
      workspace, targetId, stepId,
      assertionPath: namedSecret.assertionPath,
      attestationPath: namedSecret.attestationPath,
      evidencePaths: [secretFile],
    })).toThrow(/credential-like evidence filename/)

    const symlinked = stepInputs(root, workspace, targetId, stepId)
    const link = path.join(root, 'observation-link.txt')
    fs.symlinkSync(symlinked.evidencePath, link)
    expect(() => recordAgentHostAcceptanceStep({
      workspace, targetId, stepId,
      assertionPath: symlinked.assertionPath,
      attestationPath: symlinked.attestationPath,
      evidencePaths: [link],
    })).toThrow(/regular file/)

    const mismatch = stepInputs(root, workspace, targetId, stepId)
    fs.appendFileSync(mismatch.evidencePath, 'changed after attestation\n')
    expect(() => recordAgentHostAcceptanceStep({
      workspace, targetId, stepId,
      assertionPath: mismatch.assertionPath,
      attestationPath: mismatch.attestationPath,
      evidencePaths: [mismatch.evidencePath],
    })).toThrow(/does not bind the exact evidence bytes/)
  })

  it('requires separate 0.2.89 and 0.2.91 upgrade assertions and rejects identity loss', () => {
    const { root, workspace } = initialized()
    const recorded = recordFirstTargetMetadata(workspace, root)
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const targetId = recorded.targetId
    const target = state.entries.find((entry: { targetKey: string }) => entry.targetKey === targetId)
    const targetIdentitySha256 = hostAcceptanceTargetIdentityDigest(target)
    const { migration, paths } = migrationSupportingFiles(root, state.createdAt)
    const evidencePath = path.join(root, 'upgrade-observation.txt')
    fs.writeFileSync(evidencePath, 'Migration UI and database read-back, redacted.\n')
    const attestationPath = writeJson(path.join(root, 'upgrade-attestation.json'), {
      schemaVersion: 1,
      attestedBy: 'redaction-operator',
      attestedAt: OBSERVED_AT,
      statement: AGENT_HOST_ACCEPTANCE_REDACTION_STATEMENT,
      files: [evidencePath, ...paths].map(file => ({ name: path.basename(file), sha256: sha256(fs.readFileSync(file)) })),
    })
    const assertion = (fromAppVersion: string, migratedAgentId = 'eb_preserved') => writeJson(
      path.join(root, `upgrade-${fromAppVersion}.json`),
      {
        schemaVersion: 2,
        targetKey: target.targetKey,
        targetId: target.targetId,
        fromAppVersion,
        toAppVersion: '0.2.94',
        sourceCommit: state.sourceCommit,
        releaseContractSha256: state.releaseContractSha256,
        candidateBundleSha256: state.candidateAppsByArchitecture[target.environment.architecture].bundleSha256,
        targetIdentitySha256,
        outcome: 'passed',
        assertionSource: 'human',
        assertedBy: 'migration-operator',
        observedAt: OBSERVED_AT,
        assertions: ['Agent identity, history, and statistics survived the real upgrade.'],
        installationId: `upgrade-${fromAppVersion}`,
        originalAgentId: 'eb_preserved',
        migratedAgentId,
        historyPreserved: true,
        statisticsPreserved: true,
        databaseMigration: { ...migration.receipt, batchId: migration.receipt.batchId + ':' + fromAppVersion },
      },
    )
    expect(() => recordAgentHostAcceptanceUpgrade({
      workspace,
      targetId,
      fromAppVersion: '0.2.89',
      assertionPath: assertion('0.2.89', 'eb_changed'),
      attestationPath,
      evidencePaths: [evidencePath, ...paths],
    })).toThrow(/did not preserve Agent ID/)
    recordAgentHostAcceptanceUpgrade({
      workspace,
      targetId,
      fromAppVersion: '0.2.89',
      assertionPath: assertion('0.2.89'),
      attestationPath,
      evidencePaths: [evidencePath, ...paths],
    })
    expect(agentHostAcceptanceCaptureStatus(workspace)).toMatchObject({
      requiredUpgradePaths: expect.arrayContaining([`${targetId}/0.2.89`, `${targetId}/0.2.91`]),
      recordedUpgradePaths: [`${targetId}/0.2.89`],
    })
    expect(() => recordAgentHostAcceptanceUpgrade({
      workspace,
      targetId,
      fromAppVersion: '0.2.88',
      assertionPath: assertion('0.2.88'),
      attestationPath,
      evidencePaths: [evidencePath, ...paths],
    })).toThrow(/not required/)
  })

  it('records schema41 recovery once independently of per-host upgrade paths', () => {
    const { root, workspace } = initialized()
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const { migration, paths } = migrationSupportingFiles(root, state.createdAt, 41)
    const assertionPath = writeJson(path.join(root, 'recovery.json'), {
      id: 'observed_schema41', architecture: 'arm64', sourceCommit: state.sourceCommit,
      candidateBundleSha256: state.candidateAppsByArchitecture.arm64.bundleSha256,
      releaseContractSha256: state.releaseContractSha256, observedAt: OBSERVED_AT,
      assertedBy: 'fixture-operator', assertionSource: 'external', databaseMigration: migration.receipt,
    })
    const attestationPath = writeJson(path.join(root, 'recovery-attestation.json'), {
      schemaVersion: 1, attestedBy: 'fixture-reviewer', attestedAt: OBSERVED_AT,
      statement: AGENT_HOST_ACCEPTANCE_REDACTION_STATEMENT,
      files: paths.map(file => ({ name: path.basename(file), sha256: sha256(fs.readFileSync(file)) })),
    })
    const execute = () => recordAgentDatabaseRecovery({ workspace, assertionPath, attestationPath, evidencePaths: paths })
    expect(execute()).toMatchObject({ id: 'observed_schema41', evidenceOrigin: 'isolated_history_fixture' })
    expect(agentHostAcceptanceCaptureStatus(workspace).recordedDatabaseRecoveryPaths).toEqual(['observed_schema41'])
    expect(execute).toThrow(/already recorded/)
  })

  it('blocks review preparation when ordinary upgrades are complete but Custom upgrades are absent', () => {
    const { root, workspace } = initialized()
    const statePath = path.join(workspace, '.capture-state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    // Exercise the completeness boundary in isolation; these are not real evidence.
    state.releaseContractReady = true
    for (const target of [...state.entries, ...state.customPaths]) {
      target.hostVersion = 'fixture'
      target.steps = target.requiredSteps.map((id: string) => ({ id, evidenceFiles: [] }))
    }
    state.upgradePaths = state.entries.flatMap((target: { targetKey: string }) =>
      state.upgradeFromAppVersions.map((fromAppVersion: string) => ({ targetKey: target.targetKey, fromAppVersion })),
    )
    fs.writeFileSync(statePath, JSON.stringify(state))
    expect(() => prepareAgentHostAcceptanceReview({
      workspace, outputPath: path.join(root, 'review-request.json'),
    })).toThrow(/capture is incomplete: upgrade:nonstandard_config_root\/0.2.89/)
    expect(fs.existsSync(path.join(root, 'review-request.json'))).toBe(false)
  })

  it('rejects a prior v3 acceptance capture state under the v4 contract', () => {
    const { workspace } = initialized()
    const statePath = path.join(workspace, '.capture-state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    state.acceptanceSchemaVersion = 3
    fs.writeFileSync(statePath, JSON.stringify(state))
    expect(() => agentHostAcceptanceCaptureStatus(workspace)).toThrow(/no longer matches/)
    state.captureSchemaVersion = 2
    fs.writeFileSync(statePath, JSON.stringify(state))
    expect(() => agentHostAcceptanceCaptureStatus(workspace)).toThrow(/unsupported capture state schema/)
  })

  it('rejects legacy state and refuses review preparation while any target or upgrade evidence is missing', () => {
    const { root, workspace } = initialized()
    expect(() => prepareAgentHostAcceptanceReview({
      workspace,
      outputPath: path.join(root, 'review-request.json'),
    })).toThrow(/accepted exact version|capture is incomplete/)

    const statePath = path.join(workspace, '.capture-state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    state.acceptanceSchemaVersion = 1
    state.upgradeFromAppVersion = '0.2.91'
    delete state.upgradeFromAppVersions
    fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    expect(() => agentHostAcceptanceCaptureStatus(workspace)).toThrow(/no longer matches|schema/)
  })
})


describe('0.2.94 explicit deferred real-host scope', () => {
  it('does not count metadata-only deferred targets as completed and refuses their passed steps', () => {
    const { root, workspace, requirements } = initialized()
    expect(() => recordTargetMetadata(workspace, root, 'cursor-desktop')).toThrow(/deferred target does not accept real-host metadata/)
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const target = state.entries.find((entry: {targetId: string}) => entry.targetId === 'cursor-desktop')
    const targetId = target.targetKey
    expect(target.requiredSteps).toEqual([])
    expect(target.realHostDeferral).toMatchObject({status: 'deferred', policyId: '0.2.94-codex-only'})
    const status = agentHostAcceptanceCaptureStatus(workspace)
    expect(status.completedTargetCount).toBe(0)
    expect(status.requiredRealHostTargetCount).toBe(requirements.targets.filter((entry: {catalogId: string}) => entry.catalogId === 'codex-cli').length)
    expect(status.requiredUpgradePaths).toHaveLength((requirements.targets.length + requirements.customTargets.length) * 5)
    expect(() => recordAgentHostAcceptanceStep({workspace, targetId, stepId: 'brain_prepare',
      assertionPath: '/not-read', attestationPath: '/not-read', evidencePaths: []})).toThrow(/deferred target does not accept real-host steps/)
    expect(() => prepareAgentHostAcceptanceReview({workspace, outputPath: path.join(root, 'review.json')})).toThrow(/capture is incomplete/)
  })
})
