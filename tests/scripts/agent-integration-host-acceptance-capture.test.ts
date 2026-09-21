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
  runAgentHostAcceptanceCaptureCli,
} from '../../scripts/capture-agent-integration-host-acceptance.mjs'
// @ts-expect-error local plain-ESM verifier has no declaration file
import {
  distributionArtifactReceiptSha256,
  hostAcceptanceTargetIdentityDigest,
  hostActivityLedgerEvidenceHash,
  hostActivityLedgerExportHash,
  loadAgentHostAcceptanceRequirements,
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
    : state.entries[0]
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
      appVersion: '0.2.92',
      recordedStepCount: 0,
      requiredUpgradePaths: expect.arrayContaining([
        'opencode-v2-beta-cli:arm64:cli%3Aopencode-v2-beta-cli%3Adarwin-arm64/0.2.89',
        'opencode-v2-beta-cli:arm64:cli%3Aopencode-v2-beta-cli%3Adarwin-arm64/0.2.91',
      ]),
    })
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const restartBoundTargets = [
      ...state.entries,
      ...state.customPaths.filter((target: { targetId: string }) => target.targetId === 'manual_mcp_client'),
    ]
    expect(restartBoundTargets.every((target: { requiredSteps: string[] }) => (
      target.requiredSteps.includes('restart_persistence')
    ))).toBe(true)
    expect(result.requiredUpgradePaths).toHaveLength(
      state.entries.length * requirements.upgradeFromAppVersions.length,
    )
    expect(result.requiredUpgradePaths.some((upgrade: string) => (
      upgrade.startsWith('nonstandard_config_root/') || upgrade.startsWith('manual_mcp_client/')
    ))).toBe(false)
    expect(fs.readFileSync(fakeAgentConfig)).toEqual(before)
    expect(fs.statSync(path.join(workspace, '.capture-state.json')).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['standard_mcp_servers','tidemind'], ['nested_mcp_servers','tidemind_nested'], ['opencode_mcp','tidemind_opencode'],
  ])('records user-owned %s activity without file read-back and rejects incomplete activity', (schemaKind, selectorKey) => {
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
          runtimeBindingSha256: sha256('runtime'), tideMindVersion: '0.2.92', adapterVersion: '1', projectionVersion: '1', hostVersion: 'custom-123',
          schemaKind, selectorKey,
          evidence: ['brain_recall','brain_digest'].map(signalName => ({
            id: `aha_${sha256(signalName).slice(0,24)}`, signalName, evidenceHash: sha256(signalName), observedAt: '2026-09-05T00:00:00.000Z',
          })),
        },
      },
    }
    const metadataPath = writeJson(path.join(root,'custom-user-owned.json'), metadata)
    const result = recordAgentHostAcceptanceTarget({ workspace, targetId: targetKey, metadataPath, testOnlyAllowFixtureMetadata: true })
    expect(result.requiredSteps).toEqual(expect.arrayContaining(['brain_recall','brain_digest','scan_persistence','restart_persistence','pause_resume']))
    expect(result.requiredSteps).not.toContain('read_back')
    expect(result.requiredSteps).not.toContain('recovery')
    metadata.customBinding.activityBinding.evidence.pop()
    const incomplete = writeJson(path.join(root,'custom-user-owned-incomplete.json'), metadata)
    expect(() => recordAgentHostAcceptanceTarget({ workspace, targetId: targetKey, metadataPath: incomplete, testOnlyAllowFixtureMetadata: true }))
      .toThrow('requires recall and digest')
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
    if (catalogId === 'codex-cli') expect(record).toThrow(/no released relocatable-root contract/)
    else {
      expect(record()).toMatchObject({ targetKey: 'nonstandard_config_root', targetId: 'nonstandard_config_root' })
      const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
      expect(saved.customPaths.find((target: { targetId: string }) => target.targetId === 'nonstandard_config_root'))
        .toMatchObject({ sourceCatalogId: catalogId, installationId: 'installation-custom', metadataExport: null })
    }
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
    const step = state.entries[0].steps[0]
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

  it('requires a hash-valid activity-ledger event for every lifecycle signal', () => {
    const { root, workspace } = initialized()
    recordTargetMetadata(workspace, root, 'cursor-desktop')
    const state = JSON.parse(fs.readFileSync(path.join(workspace, '.capture-state.json'), 'utf8'))
    const target = state.entries.find((entry: { targetId: string }) => entry.targetId === 'cursor-desktop')
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
    const evidencePath = path.join(root, 'upgrade-observation.txt')
    fs.writeFileSync(evidencePath, 'Migration UI and database read-back, redacted.\n')
    const attestationPath = writeJson(path.join(root, 'upgrade-attestation.json'), {
      schemaVersion: 1,
      attestedBy: 'redaction-operator',
      attestedAt: OBSERVED_AT,
      statement: AGENT_HOST_ACCEPTANCE_REDACTION_STATEMENT,
      files: [{ name: path.basename(evidencePath), sha256: sha256(fs.readFileSync(evidencePath)) }],
    })
    const assertion = (fromAppVersion: string, migratedAgentId = 'eb_preserved') => writeJson(
      path.join(root, `upgrade-${fromAppVersion}.json`),
      {
        schemaVersion: 2,
        targetKey: target.targetKey,
        targetId: target.targetId,
        fromAppVersion,
        toAppVersion: '0.2.92',
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
      },
    )
    expect(() => recordAgentHostAcceptanceUpgrade({
      workspace,
      targetId,
      fromAppVersion: '0.2.89',
      assertionPath: assertion('0.2.89', 'eb_changed'),
      attestationPath,
      evidencePaths: [evidencePath],
    })).toThrow(/did not preserve Agent ID/)
    recordAgentHostAcceptanceUpgrade({
      workspace,
      targetId,
      fromAppVersion: '0.2.89',
      assertionPath: assertion('0.2.89'),
      attestationPath,
      evidencePaths: [evidencePath],
    })
    expect(agentHostAcceptanceCaptureStatus(workspace)).toMatchObject({
      requiredUpgradePaths: expect.arrayContaining([`${targetId}/0.2.89`, `${targetId}/0.2.91`]),
      recordedUpgradePaths: [`${targetId}/0.2.89`],
    })
    expect(() => recordAgentHostAcceptanceUpgrade({
      workspace,
      targetId,
      fromAppVersion: '0.2.90',
      assertionPath: assertion('0.2.90'),
      attestationPath,
      evidencePaths: [evidencePath],
    })).toThrow(/not required/)
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
