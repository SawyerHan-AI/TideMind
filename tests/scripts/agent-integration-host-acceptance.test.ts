import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'

// @ts-expect-error local plain-ESM release contract parser has no declaration file
import { portableArtifactFingerprint } from '../../scripts/agent-integration-release-contract.mjs'

// @ts-expect-error local plain-ESM release verifier has no declaration file
import {
  copyVerifiedAgentIntegrationHostAcceptance,
  distributionArtifactReceiptSha256,
  hostAcceptanceTargetIdentityDigest,
  hostAcceptanceStepOutcomeDigest,
  hostAcceptanceTargetMetadataExportHash,
  hostAcceptanceUpgradeOutcomeDigest,
  hostActivityLedgerEvidenceHash,
  hostActivityLedgerExportHash,
  loadAgentHostAcceptanceRequirements,
  requiredHostAcceptanceSteps,
  verifyAgentIntegrationHostAcceptance,
} from '../../scripts/verify-agent-integration-host-acceptance.mjs'

const roots: string[] = []
const SOURCE_COMMIT = 'a'.repeat(40)
const GENERATED_AT = '2026-09-03T00:00:00.000Z'
const OBSERVED_AT = '2026-09-02T23:00:00.000Z'
const CAPTURE_CREATED_AT = '2026-09-02T22:00:00.000Z'
const contracts = new Map<string, { requirementsPath: string; releaseManifestPath: string }>()
const releaseTargetKey = (catalogId: string, architecture: string, distributionId = 'official:test-agent') => (
  `${catalogId}:${architecture}:${encodeURIComponent(distributionId)}`
)

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function testReleaseManifest(): string {
  const artifactReceipt = (architecture: string, distributionId = 'official:test-agent') => {
    const proofNodes = [
      { role: 'npm_package_executable', relativePath: 'bin/test-agent.js', sha256: sha256(`executable:${architecture}`), sizeBytes: 101, executable: true, normalization: 'raw' },
      { role: 'package_manifest', relativePath: 'package.json', sha256: sha256(`manifest:${architecture}`), sizeBytes: 99, executable: false, normalization: 'raw' },
    ]
    const receipt = {
    distributionId,
    packageProvenance: 'npm_metadata:test-agent',
    version: '1.2.3',
    architecture,
    artifactSha256: sha256(`artifact:${architecture}`),
    artifactSizeBytes: 301,
    executableSha256: sha256(`executable:${architecture}`),
    executableSizeBytes: 101,
    distributionSha256: sha256(`distribution:${architecture}`),
    distributionSizeBytes: 201,
    portableFingerprintSchema: 'npm-owned-package-surface-v1',
    portableArtifactFingerprint: '',
    signedCode: null,
    npmPackage: {
      integrity: `sha512-${Buffer.from(`integrity:${architecture}`).toString('base64')}`,
      ownedPackageSha256: sha256(`owned-package:${architecture}:${distributionId}`),
      ownedEntryCount: proofNodes.length,
      ownedTotalBytes: proofNodes.reduce((sum, node) => sum + node.sizeBytes, 0),
      proofNodes,
    },
    }
    receipt.portableArtifactFingerprint = portableArtifactFingerprint(receipt)
    return receipt
  }
  const details = (components: string[], distributionIds = ['official:test-agent']) => JSON.stringify({
    components: components.map(componentKey => ({
      componentKey,
      disposition: 'managed',
      artifactTypes: componentKey === 'memory_tools' ? ['mcp'] : ['skill'],
      reload: 'new_session',
    })),
    officialDistributions: distributionIds.map(distributionId => ({
      channel: 'npm',
      distributionId,
      packageProvenance: 'npm_metadata:test-agent',
      supportedMacArchitectures: ['arm64', 'x64'],
    })),
    acceptedDistributionArtifacts: distributionIds.flatMap(distributionId => (
      ['arm64', 'x64'].map(architecture => artifactReceipt(architecture, distributionId))
    )),
    observedExactVersions: ['1.2.3'],
    releaseAcceptedExactVersions: ['1.2.3'],
    activation: { mode: 'managed', requiresUserConfirmation: false },
    requiredLifecycle: components.includes('lifecycle')
      ? { signals: ['session_start', 'pre_compact'], require: 'all' }
      : null,
    releaseMode: 'production',
  })
  return `
export const AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION = '0.2.92'
export const AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION = 3
const CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS = Object.freeze(['cursor-desktop'])
const ALL_COMPONENTS = ['instruction', 'memory_tools', 'lifecycle']
const CORE_COMPONENTS = ['instruction', 'memory_tools']
function release(catalogId, disposition, targetCapability, requiredComponents, details) {
  return Object.freeze({ catalogId, disposition, targetCapability, requiredComponents, ...details, customConfigRoot: { supported: CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS.includes(catalogId as never) }, enabledByDefault: details.releaseMode === 'production' })
}
function observeOnly(catalogId, notes, details) {
  return Object.freeze({ catalogId, disposition: 'observe_only', targetCapability: 0, requiredComponents: [], ...details, customConfigRoot: { supported: false }, enabledByDefault: false, notes })
}
const AGENT_INTEGRATION_RELEASE_ENTRIES = Object.freeze([
  release('claude-desktop-legacy', 'migration', 2, ['memory_tools'], ${details(['memory_tools'])}),
  release('opencode-v2-beta-cli', 'guided', 3, CORE_COMPONENTS, ${details(['instruction', 'memory_tools'])}),
  release('cursor-desktop', 'managed', 4, ALL_COMPONENTS, ${details(['instruction', 'memory_tools', 'lifecycle'])}),
  release('openclaw-local', 'managed', 4, ALL_COMPONENTS, ${details(
    ['instruction', 'memory_tools', 'lifecycle'],
    ['cli:openclaw-local:portable-wrapper', 'cli:openclaw-local:npm-global'],
  )}),
])
export const AGENT_INTEGRATION_RELEASE_MANIFEST = Object.freeze({
  schemaVersion: AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION,
  appVersion: AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION,
  features: Object.freeze({
    customLocalAgent: Object.freeze({
      enabledByDefault: true,
      modes: Object.freeze(['nonstandard_config_root', 'manual_mcp_client']),
    }),
  }),
  entries: AGENT_INTEGRATION_RELEASE_ENTRIES,
})
`
}

function writeTestContract(outer: string, releaseMacArchitectures = ['arm64', 'x64']) {
  const contractRoot = path.join(outer, 'contract')
  fs.mkdirSync(contractRoot)
  const releaseManifestPath = path.join(contractRoot, 'release-manifest.ts')
  fs.writeFileSync(releaseManifestPath, testReleaseManifest())
  const requirementsPath = path.join(contractRoot, 'requirements.json')
  fs.writeFileSync(requirementsPath, `${JSON.stringify({
    schemaVersion: 3,
    appVersion: '0.2.92',
    releaseMacArchitectures,
    upgradeFromAppVersions: ['0.2.89', '0.2.91'],
    stepPolicy: {
      base: ['connect'],
      byComponent: {
        instruction: ['instruction_loaded'],
        memory_tools: ['brain_prepare'],
        lifecycle: [],
      },
      byDisposition: {
        managed: ['recovery', 'conflict', 'pause_resume'],
        guided: [],
        migration: ['official_host_version', 'distribution_identity', 'legacy_selector_identity', 'read_back', 'restart_persistence', 'history_callable'],
      },
      byCatalog: {
        'openclaw-local': ['official_plugins_list', 'official_plugin_inspect', 'plugin_runtime'],
      },
    },
    customPaths: ['nonstandard_config_root', 'manual_mcp_client'],
    customGuidedTargets: [
      { schemaKind: 'standard_mcp_servers', selectorKey: 'tidemind' },
      { schemaKind: 'nested_mcp_servers', selectorKey: 'tidemind_nested' },
      { schemaKind: 'opencode_mcp', selectorKey: 'tidemind_opencode' },
    ],
  }, null, 2)}\n`)
  return { requirementsPath, releaseManifestPath }
}

function fixture(
  evidenceClass: 'fixture' | 'real_host' = 'fixture',
  activityLedgerSource?: 'fixture' | 'real_profile',
  releaseMacArchitectures = ['arm64', 'x64'],
) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-acceptance-'))
  roots.push(outer)
  const root = path.join(outer, 'bundle')
  fs.mkdirSync(root)
  const contract = writeTestContract(outer, releaseMacArchitectures)
  const requirements = loadAgentHostAcceptanceRequirements(contract.requirementsPath, contract.releaseManifestPath)
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  const captureNonce = '9'.repeat(64)
  const candidateAppsByArchitecture = Object.fromEntries(requirements.releaseMacArchitectures.map((architecture: string) => [architecture, ({
    version: requirements.appVersion,
    sourceCommit: SOURCE_COMMIT,
    bundleSha256: sha256(`candidate-app-bundle:${architecture}`),
    executableSha256: sha256(`candidate-app-executable:${architecture}`),
    teamId: 'TIDEMINDTEAM',
    signingIdentity: 'Developer ID Application: Tide Mind',
    cdhash: `candidate-cdhash-${architecture}`,
  })])) as Record<'arm64' | 'x64', Record<string, string>>
  const target = (
    targetKey: string,
    targetId: string,
    architecture: 'arm64' | 'x64',
    disposition: 'managed' | 'guided' | 'migration' | 'custom',
    targetCapability: number,
    requiredComponents: string[],
    requiredLifecycle: { signals: string[]; require: 'all' } | null,
    policyDisposition: 'managed' | 'guided' | 'migration' = disposition === 'custom' ? 'guided' : disposition,
    sourceCatalogId: string | null = null,
    guidedDefinition?: { schemaKind: string; selectorKey: string },
  ) => {
    const userOwnedCustom = Boolean(guidedDefinition)
    const candidateApp = candidateAppsByArchitecture[architecture]
    const hostVersion = '1.2.3'
    const releaseTarget = requirements.targets.find((entry: { targetKey: string }) => entry.targetKey === targetKey)
    const artifactReceipt = releaseTarget?.acceptedDistributionArtifacts[0]
      ?? requirements.entries.find((entry: { catalogId: string }) => entry.catalogId === sourceCatalogId)
        ?.acceptedDistributionArtifacts.find((receipt: { architecture: string }) => receipt.architecture === architecture)
    const stepIds = requiredHostAcceptanceSteps(requirements, {
      targetId,
      catalogId: sourceCatalogId ?? targetId,
      disposition,
      policyDisposition,
      requiredComponents,
      requiredLifecycle,
      configurationOwnership: userOwnedCustom && targetId === 'manual_mcp_client' ? 'user' : undefined,
    })
    const distribution = {
      distributionId: artifactReceipt?.distributionId ?? 'official:test-agent',
      packageProvenance: artifactReceipt?.packageProvenance ?? 'npm_metadata:test-agent',
      artifactReceiptSha256: artifactReceipt ? distributionArtifactReceiptSha256(artifactReceipt) : null,
      portableArtifactFingerprint: artifactReceipt?.portableArtifactFingerprint ?? null,
      executableSha256: artifactReceipt?.executableSha256 ?? sha256('custom-manual-executable'),
      executableSizeBytes: artifactReceipt?.executableSizeBytes ?? 101,
      rawExecutableSha256: artifactReceipt?.executableSha256 ?? sha256('custom-manual-executable'),
      rawExecutableSizeBytes: artifactReceipt?.executableSizeBytes ?? 101,
      distributionSha256: artifactReceipt?.distributionSha256 ?? sha256('custom-manual-distribution'),
      distributionSizeBytes: artifactReceipt?.distributionSizeBytes ?? 201,
    }
    const environment = {
      platform: 'darwin',
      architecture,
      processArchitecture: architecture,
      hardwareArchitecture: architecture === 'x64' ? 'x86_64' : 'arm64',
      translationMode: 'not_translated',
      osVersion: '15.6.1',
      hostIdentitySha256: sha256(`host:${targetId}`),
    }
    const installationId = `installation-${targetId}`
    const agentId = `agent-${targetId}`
    const customBinding = disposition === 'custom' ? {
      kind: targetId,
      sourceInstallationId: targetId === 'nonstandard_config_root' ? 'installation-cursor-source' : null,
      sourceCatalogId: targetId === 'nonstandard_config_root' ? sourceCatalogId : null,
      configRootIdentitySha256: sha256(`custom-root:${targetId}`),
      configFileIdentitySha256: targetId === 'manual_mcp_client' ? sha256('custom-config-file') : null,
      selectorIdentitySha256: sha256(`custom-selector:${targetId}`),
      executableFingerprint: targetId === 'manual_mcp_client' ? sha256('custom-executable-fingerprint') : null,
      sourceLiveTrustProofSha256: targetId === 'nonstandard_config_root' ? sha256('custom-source-trust') : null,
      liveTrustProofSha256: sha256(`custom-live-trust:${targetId}`),
      readBackProofSha256: sha256(`custom-read-back:${targetId}`),
      ...(userOwnedCustom && targetId === 'manual_mcp_client' ? {
        configurationOwnership: 'user', configFileIdentitySha256: null, readBackProofSha256: null,
        activityBinding: {
          installationId, agentId, activationRunId: 'run-custom', generationSha256: sha256('generation'),
          connectorConfigurationSha256: sha256('configuration'), runtimeBindingSha256: sha256('runtime'),
          tideMindVersion: requirements.appVersion, adapterVersion: '1', projectionVersion: '1', hostVersion,
          schemaKind: guidedDefinition!.schemaKind, selectorKey: guidedDefinition!.selectorKey,
          evidence: ['brain_recall', 'brain_digest'].map(signalName => ({
            id: `aha_${sha256(signalName).slice(0,24)}`, signalName, evidenceHash: sha256(signalName), observedAt: OBSERVED_AT,
          })),
        },
      } : {}),
    } : null
    const targetMetadata = {
      targetKey,
      targetId,
      sourceCatalogId,
      disposition,
      targetCapability,
      hostVersion,
      distribution,
      environment,
      installationId,
      agentId,
      customBinding,
    }
    const metadataBinding = {
      exporterVersion: 1,
      evidenceClass: 'real_host',
      candidateBundleSha256: candidateApp.bundleSha256,
      sourceCommit: SOURCE_COMMIT,
      releaseContractSha256: requirements.releaseContractSha256,
      targetMetadata: {
        targetKey,
        targetId,
        ...(sourceCatalogId ? { sourceCatalogId } : {}),
        hostVersion,
        distribution,
        environment,
        installationId,
        agentId,
        ...(customBinding ? { customBinding } : {}),
      },
      exportedAt: OBSERVED_AT,
    }
    return {
      ...targetMetadata,
      metadataExport: evidenceClass === 'real_host'
        ? { ...metadataBinding, exportHash: hostAcceptanceTargetMetadataExportHash(metadataBinding) }
        : null,
      steps: stepIds.map((id: string) => {
        const assertionRelative = `targets/${targetKey}/${id}.assertion.txt`
        const activityReceipt = id.startsWith('lifecycle_')
          ? {
              exporterVersion: 1,
              ledgerSource: activityLedgerSource ?? (evidenceClass === 'fixture' ? 'fixture' : 'real_profile'),
              captureNonce,
              targetKey,
              candidateBundleSha256: candidateApp.bundleSha256,
              sourceCommit: SOURCE_COMMIT,
              releaseContractSha256: requirements.releaseContractSha256,
              databaseSchemaVersion: 34,
              databaseSchemaSha256: sha256('activity ledger schema'),
              id: `aha_${sha256(`${targetKey}:${id}`).slice(0, 24)}`,
              installationId: `installation-${targetId}`,
              agentId: `agent-${targetId}`,
              hostVariant: sourceCatalogId ?? targetId,
              componentKey: 'lifecycle',
              signalName: id.slice('lifecycle_'.length),
              tideMindVersion: requirements.appVersion,
              adapterVersion: 'adapter-1',
              projectionVersion: 'projection-1',
              hostVersion,
              evidenceHash: '',
              observedAt: OBSERVED_AT,
              exportHash: '',
            }
          : null
        if (activityReceipt) {
          activityReceipt.evidenceHash = hostActivityLedgerEvidenceHash(activityReceipt)
          activityReceipt.exportHash = hostActivityLedgerExportHash(activityReceipt)
        }
        const assertionContent = `${JSON.stringify({
          schemaVersion: 2,
          targetKey,
          targetId,
          stepId: id,
          sourceCommit: SOURCE_COMMIT,
          releaseContractSha256: requirements.releaseContractSha256,
          candidateBundleSha256: candidateApp.bundleSha256,
          installationId: `installation-${targetId}`,
          agentId: `agent-${targetId}`,
          outcome: 'passed',
          assertionSource: 'human',
          assertedBy: `operator-${targetId}`,
          observedAt: OBSERVED_AT,
          assertions: [`${id} completed on the real host`],
          activityReceipt,
        })}\n`
        const assertionAbsolute = path.join(root, ...assertionRelative.split('/'))
        fs.mkdirSync(path.dirname(assertionAbsolute), { recursive: true })
        fs.writeFileSync(assertionAbsolute, assertionContent)
        files.push({
          path: assertionRelative,
          bytes: Buffer.byteLength(assertionContent),
          sha256: sha256(assertionContent),
        })
        const evidenceIds = [sha256(assertionContent)]
        const assertions = [`${id} completed on the real host`]
        const receipt = {
          targetKey,
          targetId,
          stepId: id,
          appVersion: requirements.appVersion,
          sourceCommit: SOURCE_COMMIT,
          candidateBundleSha256: candidateApp.bundleSha256,
          releaseContractSha256: requirements.releaseContractSha256,
          hostVersion,
          installationId: `installation-${targetId}`,
          agentId: `agent-${targetId}`,
          evidenceIds,
          outcomeDigest: hostAcceptanceStepOutcomeDigest({
            targetKey,
            targetId,
            stepId: id,
            status: 'passed',
            observedAt: OBSERVED_AT,
            assertionSource: 'human',
            assertedBy: `operator-${targetId}`,
            assertions,
            installationId: `installation-${targetId}`,
            agentId: `agent-${targetId}`,
            sourceCommit: SOURCE_COMMIT,
            releaseContractSha256: requirements.releaseContractSha256,
            candidateBundleSha256: candidateApp.bundleSha256,
            activityEvidenceHash: activityReceipt?.evidenceHash ?? null,
            evidenceIds,
          }),
        }
        const relative = `targets/${targetKey}/${id}.receipt.json`
        const content = `${JSON.stringify(receipt)}\n`
        const absolute = path.join(root, ...relative.split('/'))
        fs.mkdirSync(path.dirname(absolute), { recursive: true })
        fs.writeFileSync(absolute, content)
        files.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha256(content) })
        return {
          id,
          status: 'passed',
          observedAt: OBSERVED_AT,
          assertionSource: 'human',
          assertedBy: `operator-${targetId}`,
          assertions,
          receipt,
          evidenceFiles: [relative, assertionRelative],
        }
      }),
    }
  }
  const index = {
    schemaVersion: 3,
    acceptanceId: 'acceptance-fixture-1',
    evidenceClass,
    appVersion: requirements.appVersion,
    upgradeFromAppVersions: requirements.upgradeFromAppVersions,
    sourceCommit: SOURCE_COMMIT,
    captureCreatedAt: CAPTURE_CREATED_AT,
    captureNonce,
    generatedAt: GENERATED_AT,
    requirementsSha256: requirements.sha256,
    releaseContractSha256: requirements.releaseContractSha256,
    candidateAppsByArchitecture,
    entries: requirements.targets.map((entry: {
      targetKey: string
      architecture: 'arm64' | 'x64'
      catalogId: string
      disposition: 'managed' | 'guided' | 'migration'
      targetCapability: number
      requiredComponents: string[]
      requiredLifecycle: { signals: string[]; require: 'all' } | null
    }) => target(
      entry.targetKey,
      entry.catalogId,
      entry.architecture,
      entry.disposition,
      entry.targetCapability,
      [...entry.requiredComponents],
      entry.requiredLifecycle,
    )),
    customPaths: requirements.customTargets.map((definition: { targetId: string; targetKey: string; configurationOwnership?: string; schemaKind: string; selectorKey: string }) => {
      const mode = definition.targetId
      if (mode === 'manual_mcp_client') {
        return target(definition.targetKey, mode, 'arm64', 'custom', 2, ['memory_tools'], null, 'guided', null,
          definition.configurationOwnership === 'user' ? definition : undefined)
      }
      const source = requirements.entries.find((entry: { catalogId: string }) => entry.catalogId === 'cursor-desktop')
      if (!source) throw new Error('test contract is missing cursor-desktop')
      return target(
        mode,
        mode,
        'arm64',
        'custom',
        source.targetCapability,
        [...source.requiredComponents],
        source.requiredLifecycle,
        source.disposition,
        source.catalogId,
      )
    }),
    upgradePaths: requirements.targets
      .flatMap((entry: { targetKey: string; catalogId: string; architecture: 'arm64' | 'x64' }) => requirements.upgradeFromAppVersions.map((fromAppVersion: string) => {
      const targetKey = entry.targetKey
      const targetId = entry.catalogId
      const candidateApp = candidateAppsByArchitecture[entry.architecture]
      const artifactReceipt = requirements.targets.find((candidate: { targetKey: string }) => candidate.targetKey === targetKey)
        .acceptedDistributionArtifacts[0]
      const targetIdentitySha256 = hostAcceptanceTargetIdentityDigest({
        targetKey,
        targetId,
        hostVersion: '1.2.3',
        distribution: {
          distributionId: artifactReceipt.distributionId,
          packageProvenance: artifactReceipt.packageProvenance,
          artifactReceiptSha256: distributionArtifactReceiptSha256(artifactReceipt),
          portableArtifactFingerprint: artifactReceipt.portableArtifactFingerprint,
          executableSha256: artifactReceipt.executableSha256,
          executableSizeBytes: artifactReceipt.executableSizeBytes,
          rawExecutableSha256: artifactReceipt.executableSha256,
          rawExecutableSizeBytes: artifactReceipt.executableSizeBytes,
          distributionSha256: artifactReceipt.distributionSha256,
          distributionSizeBytes: artifactReceipt.distributionSizeBytes,
        },
        environment: {
          platform: 'darwin',
          architecture: entry.architecture,
          processArchitecture: entry.architecture,
          hardwareArchitecture: entry.architecture === 'x64' ? 'x86_64' : 'arm64',
          translationMode: 'not_translated',
          osVersion: '15.6.1',
          hostIdentitySha256: sha256(`host:${targetId}`),
        },
      })
      const assertionRelative = `upgrades/${targetKey}/${fromAppVersion}.assertion.txt`
      const assertions = [`Upgrade from ${fromAppVersion} retained Agent identity, history, and statistics`]
      const installationId = `upgrade-installation-${targetId}-${fromAppVersion}`
      const originalAgentId = `eb_upgrade_${targetId}_${fromAppVersion.replaceAll('.', '_')}`
      const assertionContent = `${JSON.stringify({
        schemaVersion: 2,
        targetKey,
        targetId,
        fromAppVersion,
        toAppVersion: requirements.appVersion,
        sourceCommit: SOURCE_COMMIT,
        releaseContractSha256: requirements.releaseContractSha256,
        candidateBundleSha256: candidateApp.bundleSha256,
        targetIdentitySha256,
        outcome: 'passed',
        assertionSource: 'human',
        assertedBy: `upgrade-operator-${targetId}-${fromAppVersion}`,
        observedAt: OBSERVED_AT,
        assertions,
        installationId,
        originalAgentId,
        migratedAgentId: originalAgentId,
        historyPreserved: true,
        statisticsPreserved: true,
      })}\n`
      const assertionAbsolute = path.join(root, ...assertionRelative.split('/'))
      fs.mkdirSync(path.dirname(assertionAbsolute), { recursive: true })
      fs.writeFileSync(assertionAbsolute, assertionContent)
      files.push({
        path: assertionRelative,
        bytes: Buffer.byteLength(assertionContent),
        sha256: sha256(assertionContent),
      })
      const evidenceIds = [sha256(assertionContent)]
      const digestInput = {
        targetKey,
        targetId,
        fromAppVersion,
        toAppVersion: requirements.appVersion,
        status: 'passed',
        observedAt: OBSERVED_AT,
        assertionSource: 'human',
        assertedBy: `upgrade-operator-${targetId}-${fromAppVersion}`,
        assertions,
        installationId,
        originalAgentId,
        migratedAgentId: originalAgentId,
        historyPreserved: true,
        statisticsPreserved: true,
        targetIdentitySha256,
        evidenceIds,
      }
      const receipt = {
        targetKey,
        targetId,
        fromAppVersion,
        toAppVersion: requirements.appVersion,
        sourceCommit: SOURCE_COMMIT,
        candidateBundleSha256: candidateApp.bundleSha256,
        releaseContractSha256: requirements.releaseContractSha256,
        targetIdentitySha256,
        installationId: digestInput.installationId,
        originalAgentId: digestInput.originalAgentId,
        migratedAgentId: digestInput.migratedAgentId,
        evidenceIds,
        outcomeDigest: hostAcceptanceUpgradeOutcomeDigest({
          ...digestInput,
          sourceCommit: SOURCE_COMMIT,
          releaseContractSha256: requirements.releaseContractSha256,
          candidateBundleSha256: candidateApp.bundleSha256,
        }),
      }
      const receiptRelative = `upgrades/${targetKey}/${fromAppVersion}.receipt.json`
      const receiptContent = `${JSON.stringify(receipt)}\n`
      fs.writeFileSync(path.join(root, ...receiptRelative.split('/')), receiptContent)
      files.push({
        path: receiptRelative,
        bytes: Buffer.byteLength(receiptContent),
        sha256: sha256(receiptContent),
      })
      const { evidenceIds: _evidenceIds, ...upgrade } = digestInput
      return { ...upgrade, receipt, evidenceFiles: [receiptRelative, assertionRelative] }
    })),
    files,
    review: null as null | {
      reviewer: string
      reviewedAt: string
      decision: string
      evidenceManifestSha256: string
      candidateAppsSha256: string
      releaseContractSha256: string
    },
  }
  index.review = {
    reviewer: 'independent-release-auditor',
    reviewedAt: OBSERVED_AT,
    decision: 'approved',
    evidenceManifestSha256: sha256(JSON.stringify(
      [...files].sort((left, right) => left.path.localeCompare(right.path)),
    )),
    candidateAppsSha256: sha256(JSON.stringify(candidateAppsByArchitecture)),
    releaseContractSha256: requirements.releaseContractSha256,
  }
  const indexPath = path.join(root, 'index.json')
  contracts.set(indexPath, contract)
  const write = () => fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  write()
  return { root, indexPath, index, write, requirements }
}

function verify(indexPath: string, allowFixture = true) {
  const contract = contracts.get(indexPath)
  if (!contract) throw new Error(`missing test contract for ${indexPath}`)
  return verifyAgentIntegrationHostAcceptance({
    indexPath,
    expectedAppVersion: '0.2.92',
    expectedSourceCommit: SOURCE_COMMIT,
    requirementsPath: contract.requirementsPath,
    releaseManifestPath: contract.releaseManifestPath,
    allowFixture,
  })
}

describe('real-host Agent Integration acceptance verifier', () => {
  it('verifies the Apple Silicon release with only its arm64 candidate and complete arm64 evidence', () => {
    const built = fixture('fixture', undefined, ['arm64'])
    expect(Object.keys(built.index.candidateAppsByArchitecture)).toEqual(['arm64'])
    expect(built.requirements.targets.every((target: { architecture: string }) => target.architecture === 'arm64')).toBe(true)
    expect(verify(built.indexPath).status).toBe('passed')
    delete built.index.candidateAppsByArchitecture.arm64
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/exact release candidate apps: arm64/)
  })

  it('freezes the current release to Apple Silicon without deleting host distribution architecture metadata', () => {
    const requirements = loadAgentHostAcceptanceRequirements()
    expect(requirements.releaseMacArchitectures).toEqual(['arm64'])
    expect(requirements.targets.length).toBeGreaterThan(0)
    expect(requirements.targets.every((target: { architecture: string }) => target.architecture === 'arm64')).toBe(true)
    expect(requirements.entries.some((entry: { officialDistributions: Array<{ supportedMacArchitectures: string[] }> }) =>
      entry.officialDistributions.some(distribution => distribution.supportedMacArchitectures.includes('x64')))).toBe(true)
  })
  it('accepts a complete version/source-bound fixture only in unit-test mode', () => {
    const built = fixture()
    expect(verify(built.indexPath)).toMatchObject({
      status: 'passed',
      appVersion: '0.2.92',
      sourceCommit: SOURCE_COMMIT,
      entryCount: built.requirements.targets.length,
      customPathCount: 5,
      upgradePathCount: built.requirements.targets.length * built.requirements.upgradeFromAppVersions.length,
      evidenceFileCount: built.index.files.length,
    })
    expect(() => verify(built.indexPath, false)).toThrow(/requires real_host evidence/)
  })

  it('rejects label-only real-host evidence without the physical signed candidate app', () => {
    const built = fixture('real_host')
    expect(() => verify(built.indexPath, false)).toThrow(/requires an absolute --candidate-app-arm64 path/)
  })

  it('rejects a missing release variant', () => {
    const missingEntry = fixture()
    missingEntry.index.entries.pop()
    missingEntry.write()
    expect(() => verify(missingEntry.indexPath)).toThrow(/entry count mismatch/)
  })

  it('fails closed when an architecture target is missing, duplicated, or mislabeled', () => {
    const missing = fixture()
    missing.index.entries = missing.index.entries.filter((entry: { targetKey: string }) => (
      entry.targetKey !== releaseTargetKey('cursor-desktop', 'x64')
    ))
    missing.write()
    expect(() => verify(missing.indexPath)).toThrow(/entry count mismatch/)

    const duplicate = fixture()
    duplicate.index.entries[1].targetKey = duplicate.index.entries[0].targetKey
    duplicate.write()
    expect(() => verify(duplicate.indexPath)).toThrow(/contain duplicates/)

    const swapped = fixture()
    const x64 = swapped.index.entries.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('cursor-desktop', 'x64')
    ))
    x64.environment.architecture = 'arm64'
    swapped.write()
    expect(() => verify(swapped.indexPath)).toThrow(/architectures differ|architecture mismatch/)
  })

  it('rejects Rosetta evidence even when the candidate process and target both report x64', () => {
    const translated = fixture()
    const x64 = translated.index.entries.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('cursor-desktop', 'x64')
    ))
    x64.environment.hardwareArchitecture = 'arm64'
    x64.environment.translationMode = 'rosetta'
    translated.write()
    expect(() => verify(translated.indexPath)).toThrow(/Rosetta is compatibility preflight only/)
  })

  it('binds physical hardware and translation mode into the upgrade target identity', () => {
    const built = fixture()
    const x64 = built.index.entries.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('cursor-desktop', 'x64')
    ))
    const nativeIdentity = hostAcceptanceTargetIdentityDigest(x64)
    const translated = structuredClone(x64)
    translated.environment.hardwareArchitecture = 'arm64'
    translated.environment.translationMode = 'rosetta'
    expect(hostAcceptanceTargetIdentityDigest(translated)).not.toBe(nativeIdentity)
  })

  it('requires independent evidence for every OpenClaw architecture and distribution topology', () => {
    const built = fixture()
    const targets = built.index.entries.filter((entry: { targetId: string }) => entry.targetId === 'openclaw-local')
    expect(targets.map((entry: { targetKey: string }) => entry.targetKey).sort()).toEqual([
      releaseTargetKey('openclaw-local', 'arm64', 'cli:openclaw-local:npm-global'),
      releaseTargetKey('openclaw-local', 'arm64', 'cli:openclaw-local:portable-wrapper'),
      releaseTargetKey('openclaw-local', 'x64', 'cli:openclaw-local:npm-global'),
      releaseTargetKey('openclaw-local', 'x64', 'cli:openclaw-local:portable-wrapper'),
    ].sort())
    for (const target of targets) {
      expect(target.steps.map((step: { id: string }) => step.id)).toEqual(expect.arrayContaining([
        'official_plugins_list', 'official_plugin_inspect', 'plugin_runtime',
      ]))
    }

    const missing = fixture()
    const missingKey = releaseTargetKey('openclaw-local', 'x64', 'cli:openclaw-local:npm-global')
    missing.index.entries = missing.index.entries.filter((entry: { targetKey: string }) => entry.targetKey !== missingKey)
    missing.write()
    expect(() => verify(missing.indexPath)).toThrow(/release entry count mismatch/)
  })

  it('requires the real OpenClaw matrix to prove plugin discovery, inspection, runtime, restart, and lifecycle', () => {
    const requirements = loadAgentHostAcceptanceRequirements()
    const targets = requirements.targets.filter((target: { catalogId: string }) => target.catalogId === 'openclaw-local')
    expect(targets).toHaveLength(2)
    expect(targets.every((target: { architecture: string }) => target.architecture === 'arm64')).toBe(true)
    for (const target of targets) {
      expect(requiredHostAcceptanceSteps(requirements, target)).toEqual(expect.arrayContaining([
        'official_host_version', 'official_plugins_list', 'official_plugin_inspect', 'plugin_runtime',
        'read_back', 'restart_persistence',
        'lifecycle_session_start', 'lifecycle_pre_compact', 'lifecycle_post_compact', 'lifecycle_session_end',
      ]))
    }
  })

  it('rejects OpenClaw evidence spliced across distribution topologies', () => {
    const built = fixture()
    const portable = built.index.entries.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('openclaw-local', 'arm64', 'cli:openclaw-local:portable-wrapper')
    ))
    const npmGlobal = built.index.entries.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('openclaw-local', 'arm64', 'cli:openclaw-local:npm-global')
    ))
    portable.distribution = structuredClone(npmGlobal.distribution)
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/distribution is not accepted|immutable artifact receipt/)
  })

  it('binds every architecture target and upgrade to its corresponding candidate bundle', () => {
    const built = fixture()
    const x64 = built.index.entries.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('cursor-desktop', 'x64')
    ))
    x64.steps[0].receipt.candidateBundleSha256 = built.index.candidateAppsByArchitecture.arm64.bundleSha256
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/candidateBundleSha256 mismatch/)

    const upgrade = fixture()
    const x64Upgrade = upgrade.index.upgradePaths.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('cursor-desktop', 'x64')
    ))
    x64Upgrade.receipt.candidateBundleSha256 = upgrade.index.candidateAppsByArchitecture.arm64.bundleSha256
    upgrade.write()
    expect(() => verify(upgrade.indexPath)).toThrow(/candidateBundleSha256 mismatch/)
  })

  it('rejects a missing required target step', () => {
    const missingStep = fixture()
    missingStep.index.entries[0].steps.pop()
    missingStep.write()
    expect(() => verify(missingStep.indexPath)).toThrow(/exact required step set/)
  })

  it('rejects a missing Custom path', () => {
    const missingCustom = fixture()
    missingCustom.index.customPaths.pop()
    missingCustom.write()
    expect(() => verify(missingCustom.indexPath)).toThrow(/Custom path count mismatch/)
  })

  it('rejects a missing required upgrade baseline', () => {
    const missingUpgrade = fixture()
    missingUpgrade.index.upgradePaths.pop()
    missingUpgrade.write()
    expect(() => verify(missingUpgrade.indexPath)).toThrow(/upgrade path count mismatch/)
  })

  it('requires only the steps promised by each capability and management mode', () => {
    const built = fixture()
    const migration = built.index.entries.find((entry: { targetId: string }) => (
      entry.targetId === 'claude-desktop-legacy'
    ))
    expect(migration.steps.map((step: { id: string }) => step.id)).toEqual([
      'brain_prepare',
      'official_host_version',
      'distribution_identity',
      'legacy_selector_identity',
      'read_back',
      'restart_persistence',
      'history_callable',
    ])
    expect(migration.steps.map((step: { id: string }) => step.id)).not.toEqual(expect.arrayContaining(['connect', 'disconnect']))
    expect(built.index.upgradePaths.filter((upgrade: { targetKey: string }) => (
      upgrade.targetKey === migration.targetKey
    )).map((upgrade: { fromAppVersion: string }) => upgrade.fromAppVersion).sort()).toEqual(['0.2.89', '0.2.91'])
    const guided = built.index.entries.find((entry: { targetId: string }) => (
      entry.targetId === 'opencode-v2-beta-cli'
    ))
    expect(guided.steps.map((step: { id: string }) => step.id)).not.toContain('lifecycle')
    expect(guided.steps.map((step: { id: string }) => step.id)).not.toContain('recovery')
    const managed = built.index.entries.find((entry: { targetId: string }) => (
      entry.targetId === 'cursor-desktop'
    ))
    expect(managed.steps.map((step: { id: string }) => step.id)).toEqual(expect.arrayContaining([
      'instruction_loaded', 'lifecycle_session_start', 'lifecycle_pre_compact',
      'recovery', 'conflict', 'pause_resume',
    ]))
    expect(managed.steps.map((step: { id: string }) => step.id)).not.toContain('lifecycle')
  })

  it('rejects a generic lifecycle result in place of every required signal', () => {
    const built = fixture()
    const managed = built.index.entries.find((entry: { targetId: string }) => entry.targetId === 'cursor-desktop')
    managed.steps = managed.steps
      .filter((step: { id: string }) => !step.id.startsWith('lifecycle_'))
      .concat({ ...managed.steps[0], id: 'lifecycle' })
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/exact required step set/)
  })

  it('binds Custom paths to their real capability and released source variant', () => {
    const built = fixture()
    const manual = built.index.customPaths.find((entry: { targetId: string }) => entry.targetId === 'manual_mcp_client')
    expect(manual).toMatchObject({ sourceCatalogId: null, targetCapability: 2 })
    expect(manual.steps.map((step: { id: string }) => step.id)).not.toContain('instruction_loaded')

    const nonstandard = built.index.customPaths.find((entry: { targetId: string }) => (
      entry.targetId === 'nonstandard_config_root'
    ))
    expect(nonstandard).toMatchObject({ sourceCatalogId: 'cursor-desktop', targetCapability: 4 })
    expect(nonstandard.steps.map((step: { id: string }) => step.id)).toEqual(expect.arrayContaining([
      'lifecycle_session_start', 'lifecycle_pre_compact',
    ]))

    manual.targetCapability = 3
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/targetCapability mismatch/)
  })

  it('rejects a Custom nonstandard path not bound to a released source variant', () => {
    const built = fixture()
    const nonstandard = built.index.customPaths.find((entry: { targetId: string }) => (
      entry.targetId === 'nonstandard_config_root'
    ))
    nonstandard.sourceCatalogId = 'unreleased-agent'
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/not a released host/)
  })

  it('binds formal Custom evidence to its physical selector and current Adapter read-back', () => {
    const built = fixture('real_host')
    expect(() => verify(built.indexPath)).not.toThrow()
    const manual = built.index.customPaths.find((entry: { targetId: string }) => (
      entry.targetId === 'manual_mcp_client'
    ))
    manual.customBinding.readBackProofSha256 = sha256('spliced-read-back')
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/does not bind the frozen candidate|differs from its signed candidate metadata export/)
  })

  it('accepts user-owned formal Custom activity without claiming file read-back or recovery', () => {
    const built = fixture('real_host', 'real_profile')
    expect(() => verify(built.indexPath)).not.toThrow()
    const manual = built.index.customPaths.find((entry: { targetKey: string }) => entry.targetKey === 'manual_mcp_client:standard_mcp_servers:tidemind')
    expect(manual.customBinding).toMatchObject({ configurationOwnership: 'user', configFileIdentitySha256: null, readBackProofSha256: null })
    expect(manual.steps.map((step: { id: string }) => step.id)).not.toEqual(expect.arrayContaining(['read_back']))
    expect(manual.steps.map((step: { id: string }) => step.id)).not.toContain('recovery')
    expect(manual.steps.map((step: { id: string }) => step.id)).toEqual(expect.arrayContaining(['scan_persistence','restart_persistence','pause_resume']))
    manual.customBinding.activityBinding.agentId = 'another-agent'
    manual.metadataExport.targetMetadata.customBinding = manual.customBinding
    manual.metadataExport.exportHash = hostAcceptanceTargetMetadataExportHash(manual.metadataExport)
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/agentId mismatch/)
  })

  it('publishes a v3 schema that requires all five Custom matrix receipts', () => {
    const built = fixture('real_host')
    const schema = JSON.parse(fs.readFileSync(new URL('../../scripts/agent-integration-host-acceptance-v3.schema.json', import.meta.url), 'utf8'))
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema)
    expect(validate(built.index), JSON.stringify(validate.errors)).toBe(true)
    const translated = structuredClone(built.index)
    const x64 = translated.entries.find((entry: { targetKey: string }) => (
      entry.targetKey === releaseTargetKey('cursor-desktop', 'x64')
    ))
    x64.environment.hardwareArchitecture = 'arm64'
    x64.environment.translationMode = 'rosetta'
    expect(validate(translated)).toBe(false)
    built.index.customPaths.pop()
    expect(validate(built.index)).toBe(false)
  })

  it.each(['schema','selector','pause_resume','scan_persistence'])('rejects a folded or incomplete guided Custom matrix: %s', defect => {
    const built = fixture('real_host')
    const manual = built.index.customPaths.find((entry: { targetKey: string }) => entry.targetKey === 'manual_mcp_client:nested_mcp_servers:tidemind_nested')
    if (defect === 'schema') manual.customBinding.activityBinding.schemaKind = 'standard_mcp_servers'
    else if (defect === 'selector') manual.customBinding.activityBinding.selectorKey = 'tidemind'
    else manual.steps = manual.steps.filter((step: { id: string }) => step.id !== defect)
    manual.metadataExport.targetMetadata.customBinding = manual.customBinding
    manual.metadataExport.exportHash = hostAcceptanceTargetMetadataExportHash(manual.metadataExport)
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/schema\/selector targetKey mismatch|exact required step set/)
  })

  it.each(['readback','incomplete'])('rejects user-owned Custom %s claims', kind => {
    const built = fixture('real_host', 'real_profile')
    const manual = built.index.customPaths.find((entry: { targetKey: string }) => entry.targetKey === 'manual_mcp_client:standard_mcp_servers:tidemind')
    if (kind === 'readback') manual.customBinding.readBackProofSha256 = sha256('invented-read-back')
    else manual.customBinding.activityBinding.evidence.pop()
    manual.metadataExport.targetMetadata.customBinding = manual.customBinding
    manual.metadataExport.exportHash = hostAcceptanceTargetMetadataExportHash(manual.metadataExport)
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/user-owned Custom binding|requires recall and digest/)
  })

  it('rejects a formal Custom binding with the wrong physical proof shape', () => {
    const built = fixture('real_host')
    const nonstandard = built.index.customPaths.find((entry: { targetId: string }) => (
      entry.targetId === 'nonstandard_config_root'
    ))
    nonstandard.customBinding.sourceLiveTrustProofSha256 = null
    nonstandard.metadataExport.targetMetadata.customBinding.sourceLiveTrustProofSha256 = null
    nonstandard.metadataExport.exportHash = hostAcceptanceTargetMetadataExportHash(nonstandard.metadataExport)
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/nonstandard Custom binding is invalid/)
  })

  it('rejects source commit drift', () => {
    const source = fixture()
    const sourceContract = contracts.get(source.indexPath)!
    expect(() => verifyAgentIntegrationHostAcceptance({
      indexPath: source.indexPath,
      expectedAppVersion: '0.2.92',
      expectedSourceCommit: 'b'.repeat(40),
      requirementsPath: sourceContract.requirementsPath,
      releaseManifestPath: sourceContract.releaseManifestPath,
      allowFixture: true,
    })).toThrow(/source commit mismatch/)
  })

  it('rejects app version drift', () => {
    const version = fixture()
    version.index.appVersion = '0.2.91'
    version.write()
    expect(() => verify(version.indexPath)).toThrow(/app version mismatch/)
  })

  it('rejects missing official host metadata', () => {
    const host = fixture()
    host.index.entries[0].hostVersion = ''
    host.write()
    expect(() => verify(host.indexPath)).toThrow(/official host version/)
  })

  it('rejects a host version absent from releaseAcceptedExactVersions', () => {
    const unaccepted = fixture('real_host')
    unaccepted.index.entries[0].hostVersion = '9.9.9'
    unaccepted.write()
    expect(() => verify(unaccepted.indexPath))
      .toThrow(/host version is not accepted by the frozen release contract/)
  })

  it('rejects host bytes or portable proof spliced away from the immutable version-and-architecture receipt', () => {
    const bytes = fixture()
    bytes.index.entries[0].distribution.executableSha256 = sha256('different executable')
    bytes.index.entries[0].distribution.rawExecutableSha256 = sha256('different executable')
    bytes.write()
    expect(() => verify(bytes.indexPath)).toThrow(/does not match its immutable artifact receipt/)

    const proof = fixture()
    proof.index.entries[0].distribution.portableArtifactFingerprint = sha256('different proof')
    proof.write()
    expect(() => verify(proof.indexPath)).toThrow(/does not match its immutable artifact receipt/)
  })

  it('rejects the old single-upgrade v1 shape instead of silently accepting incomplete migration evidence', () => {
    const built = fixture()
    const legacy = built.index as unknown as Record<string, unknown>
    legacy.schemaVersion = 1
    legacy.upgradeFromAppVersion = '0.2.91'
    delete legacy.upgradeFromAppVersions
    delete legacy.upgradePaths
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/fields|schema version|upgrade/i)
  })

  it('requires an upgrade to preserve the original Agent ID', () => {
    const identity = fixture()
    identity.index.upgradePaths[0].migratedAgentId = 'eb_changed'
    identity.write()
    expect(() => verify(identity.indexPath)).toThrow(/preserve Agent ID/)
  })

  it('requires an upgrade to preserve history and statistics', () => {
    const history = fixture()
    history.index.upgradePaths[0].historyPreserved = false
    history.write()
    expect(() => verify(history.indexPath)).toThrow(/history and statistics/)
  })

  it('requires both frozen upgrade source versions', () => {
    const wrongBaseline = fixture()
    wrongBaseline.index.upgradeFromAppVersions = ['0.2.91']
    wrongBaseline.write()
    expect(() => verify(wrongBaseline.indexPath)).toThrow(/upgrade source versions mismatch/)
  })

  it('rejects evidence content drift', () => {
    const drift = fixture()
    fs.appendFileSync(path.join(drift.root, drift.index.files[0].path), 'tampered\n')
    expect(() => verify(drift.indexPath)).toThrow(/size changed|content changed/)
  })

  it('rejects an unindexed file in the bundle', () => {
    const extra = fixture()
    fs.writeFileSync(path.join(extra.root, 'extra.txt'), 'not indexed\n')
    expect(() => verify(extra.indexPath)).toThrow(/file set differs/)
  })

  it('keeps the workflow candidate-transfer receipt outside the frozen acceptance bundle', () => {
    const built = fixture('real_host')
    const misplaced = path.join(built.root, 'candidate-transfer.json')
    fs.writeFileSync(misplaced, '{"schemaVersion":1}\n')
    expect(() => verify(built.indexPath)).toThrow(/file set differs/)
    fs.unlinkSync(misplaced)
    const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-integration-host-candidate-transfer-'))
    roots.push(externalDirectory)
    fs.writeFileSync(path.join(externalDirectory, '0.2.92.json'), '{"schemaVersion":1}\n')
    expect(verify(built.indexPath).status).toBe('passed')
  })

  it('rejects an indexed but unreferenced evidence file', () => {
    const unreferenced = fixture()
    const orphan = 'targets/orphan.json'
    const content = 'orphan\n'
    fs.writeFileSync(path.join(unreferenced.root, orphan), content)
    unreferenced.index.files.push({ path: orphan, bytes: Buffer.byteLength(content), sha256: sha256(content) })
    unreferenced.index.review!.evidenceManifestSha256 = sha256(JSON.stringify(
      [...unreferenced.index.files].sort((left, right) => left.path.localeCompare(right.path)),
    ))
    unreferenced.write()
    expect(() => verify(unreferenced.indexPath)).toThrow(/unreferenced evidence/)
  })

  it('rejects a forged structured receipt', () => {
    const forged = fixture('real_host')
    forged.index.entries[0].steps[0].receipt.targetId = 'another-agent'
    forged.write()
    expect(() => verify(forged.indexPath)).toThrow(/receipt targetId mismatch/)
  })

  it('rejects fixture ledger exports in a formal real-host bundle', () => {
    const built = fixture('real_host', 'fixture')
    expect(() => verify(built.indexPath)).toThrow(/ledgerSource mismatch/)
  })

  it('rejects a lifecycle export replayed under another capture nonce', () => {
    const built = fixture('real_host')
    built.index.captureNonce = '8'.repeat(64)
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/captureNonce mismatch/)
  })

  it('detects lifecycle event-id replacement through the full export hash', () => {
    const built = fixture('real_host')
    const target = built.index.entries.find(entry => entry.steps.some(step => step.id.startsWith('lifecycle_')))!
    const step = target.steps.find(entry => entry.id.startsWith('lifecycle_'))!
    const assertionFile = step.evidenceFiles.find(relative => relative.endsWith('.assertion.txt'))!
    const assertionPath = path.join(built.root, assertionFile)
    const assertion = JSON.parse(fs.readFileSync(assertionPath, 'utf8'))
    assertion.activityReceipt.id = `aha_${'f'.repeat(24)}`
    const content = `${JSON.stringify(assertion)}\n`
    fs.writeFileSync(assertionPath, content)
    const descriptor = built.index.files.find(file => file.path === assertionFile)!
    descriptor.bytes = Buffer.byteLength(content)
    descriptor.sha256 = sha256(content)
    built.index.review!.evidenceManifestSha256 = sha256(JSON.stringify(
      [...built.index.files].sort((left, right) => left.path.localeCompare(right.path)),
    ))
    built.write()
    expect(() => verify(built.indexPath)).toThrow(/export hash mismatch/)
  })

  it('rejects receipt reuse across steps', () => {
    const reused = fixture('real_host')
    reused.index.entries[0].steps[1].evidenceFiles = [
      reused.index.entries[0].steps[0].evidenceFiles[0],
      reused.index.entries[0].steps[0].evidenceFiles[1],
    ]
    reused.write()
    expect(() => verify(reused.indexPath)).toThrow(/reuses a receipt file across steps/)
  })

  it('rejects steps spliced from a different Installation or Agent', () => {
    const spliced = fixture('real_host')
    spliced.index.entries[0].steps[0].receipt.installationId = 'another-installation'
    spliced.index.entries[0].steps[0].receipt.agentId = 'another-agent'
    spliced.write()
    expect(() => verify(spliced.indexPath)).toThrow(/different Installation or Agent/)
  })

  it('rejects an unreviewed evidence manifest', () => {
    const unreviewed = fixture('real_host')
    unreviewed.index.review!.decision = 'pending'
    unreviewed.write()
    expect(() => verify(unreviewed.indexPath)).toThrow(/not independently approved/)
  })

  it('rejects a synthetic outcome digest derived from command success', () => {
    const synthetic = fixture('real_host')
    synthetic.index.entries[0].steps[0].receipt.outcomeDigest = sha256('exit-code-zero')
    const receiptFile = synthetic.index.entries[0].steps[0].evidenceFiles[0]
    const receiptContent = `${JSON.stringify(synthetic.index.entries[0].steps[0].receipt)}\n`
    fs.writeFileSync(path.join(synthetic.root, receiptFile), receiptContent)
    const receiptDescriptor = synthetic.index.files.find(file => file.path === receiptFile)!
    receiptDescriptor.bytes = Buffer.byteLength(receiptContent)
    receiptDescriptor.sha256 = sha256(receiptContent)
    synthetic.index.review!.evidenceManifestSha256 = sha256(JSON.stringify(
      [...synthetic.index.files].sort((left, right) => left.path.localeCompare(right.path)),
    ))
    synthetic.write()
    expect(() => verify(synthetic.indexPath)).toThrow(/outcome digest mismatch/)
  })

  it('rejects evidence hash substitution', () => {
    const substituted = fixture('real_host')
    substituted.index.entries[0].steps[0].receipt.evidenceIds = [sha256('different evidence')]
    substituted.write()
    expect(() => verify(substituted.indexPath)).toThrow(/receipt file|evidence IDs do not match/)
  })

  it('rejects a reviewer who also asserted a step', () => {
    const sameReviewer = fixture('real_host')
    sameReviewer.index.review!.reviewer = sameReviewer.index.entries[0].steps[0].assertedBy
    sameReviewer.write()
    expect(() => verify(sameReviewer.indexPath)).toThrow(/reviewer must be independent/)
  })

  it('copies only a verified real-host bundle and verifies the copied bytes', () => {
    const source = fixture('real_host')
    const sourceContract = contracts.get(source.indexPath)!
    const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-copy-parent-')), '0.2.92')
    roots.push(path.dirname(destination))
    expect(copyVerifiedAgentIntegrationHostAcceptance({
      sourceIndexPath: source.indexPath,
      destinationDirectory: destination,
      expectedAppVersion: '0.2.92',
      expectedSourceCommit: SOURCE_COMMIT,
      requirementsPath: sourceContract.requirementsPath,
      releaseManifestPath: sourceContract.releaseManifestPath,
      allowFixture: true,
    })).toMatchObject({ status: 'passed', sourceCommit: SOURCE_COMMIT })
    contracts.set(path.join(destination, 'index.json'), sourceContract)
    expect(verify(path.join(destination, 'index.json')).status).toBe('passed')
  })
})
