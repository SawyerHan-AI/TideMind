import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CODEX_CAPABILITY_MANIFESTS } from '../../src/llm/cli/catalogs'
import { AGENT_CATALOG } from '../../client/electron/agent-integration/catalog'
import { P0_DISCOVERY_PROBES } from '../../client/electron/agent-integration/discovery'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { CLAUDE_CODE_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/claude-code-plugin-adapter'
import { CODEX_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/codex-lifecycle-adapter'
import { GEMINI_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/gemini-extension-adapter'
import { KIMI_CODE_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/kimi-code-lifecycle-adapter'
import { OPENCLAW_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/openclaw-plugin-adapter'
import { OMP_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/omp-lifecycle-adapter'
import { PI_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/pi-package-adapter'
import {
  QWEN_CODE_REQUIRED_LIFECYCLE_SIGNALS,
  ZCODE_REQUIRED_LIFECYCLE_SIGNALS,
} from '../../client/electron/agent-integration/hosts/json-lifecycle-hook-adapter'
import { QWENWORK_REQUIRED_LIFECYCLE_SIGNALS } from '../../client/electron/agent-integration/hosts/qwenwork-hybrid-adapter'
import {
  AGENT_INTEGRATION_RELEASE_ENTRIES,
  AGENT_INTEGRATION_RELEASE_ENV,
  AGENT_INTEGRATION_RELEASE_MANIFEST,
  AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION,
  applyAgentReleaseGateToReport,
  agentReleaseSurfaceEligibilityReason,
  defaultReleasedAdapterIds,
  resolveAcceptedKimiNativeReceipt,
  resolveAgentIntegrationReleasePolicy,
  validArtifactReceipt,
  type AgentReleaseDistributionArtifactReceipt,
} from '../../client/electron/agent-integration/release-manifest'
import { kimiNativeReceiptLookupFingerprint } from '../../client/electron/agent-integration/distribution-artifact'
import type { AgentHostAdapter, CatalogId } from '../../client/electron/agent-integration/types'
import type { DiscoveredInstallation } from '../../client/electron/agent-integration/discovery'

function releasedAdapterSurface(): ReadonlyMap<CatalogId, AgentHostAdapter> {
  return new Map(AGENT_INTEGRATION_RELEASE_ENTRIES
    .filter(entry => entry.enabledByDefault)
    .map(entry => [entry.catalogId, {
      catalogId: entry.catalogId,
      componentKeys: entry.requiredComponents,
      implementationTypes: Object.fromEntries(entry.components.map(component => [
        component.componentKey,
        component.artifactTypes,
      ])),
      componentContracts: Object.fromEntries(entry.components.map(component => [
        component.componentKey,
        {
          deliveryMode: component.deliveryMode,
          artifactTypes: component.artifactTypes,
          mutationDomain: component.mutationDomain,
          reload: component.reload,
        },
      ])),
    } as AgentHostAdapter]))
}

describe('0.2.92 Agent release manifest', () => {
  it.each([
    ['opencode-v1-cli', false],
    ['opencode-v2-beta-cli', true],
  ] as const)('models the audited x64 distribution identity for %s', (catalogId, distinctBaseline) => {
    const entry = AGENT_INTEGRATION_RELEASE_ENTRIES.find(candidate => candidate.catalogId === catalogId)!
    expect(entry.officialDistributions.map(distribution => ({
      id: distribution.distributionId,
      architectures: distribution.supportedMacArchitectures,
    }))).toEqual([
      { id: `cli:${catalogId}:darwin-arm64`, architectures: ['arm64'] },
      { id: `cli:${catalogId}:darwin-x64`, architectures: ['x64'] },
      ...(distinctBaseline
        ? [{ id: `cli:${catalogId}:darwin-x64-baseline`, architectures: ['x64'] }]
        : []),
    ])
  })
  it('covers every frozen P0 discovery surface exactly once', () => {
    const manifestIds = AGENT_INTEGRATION_RELEASE_ENTRIES.map(entry => entry.catalogId)
    const discoveryIds = P0_DISCOVERY_PROBES.flatMap(probe => [
      probe.catalogId,
      ...('detectOnlyFallbackCatalogId' in probe && probe.detectOnlyFallbackCatalogId
        ? [probe.detectOnlyFallbackCatalogId]
        : []),
    ])
    expect(AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION).toBe('0.2.92')
    expect(AGENT_INTEGRATION_RELEASE_MANIFEST).toMatchObject({
      schemaVersion: 4,
      appVersion: '0.2.92',
      features: {
        customLocalAgent: {
          enabledByDefault: true,
          modes: ['nonstandard_config_root', 'manual_mcp_client'],
        },
      },
    })
    expect(new Set(manifestIds).size).toBe(manifestIds.length)
    expect([...manifestIds].sort()).toEqual([...new Set(discoveryIds)].sort())
  })

  it('permits a non-standard Custom config root only for the real-host accepted Cursor contract', () => {
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES
      .filter(entry => entry.customConfigRoot.supported)
      .map(entry => entry.catalogId))
      .toEqual(['cursor-desktop'])
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES
      .find(entry => entry.catalogId === 'claude-desktop-legacy')?.customConfigRoot.supported)
      .toBe(false)
  })

  it('keeps only the non-official zcode CLI observe-only', () => {
    const observeOnly = AGENT_INTEGRATION_RELEASE_ENTRIES.filter(entry => entry.disposition === 'observe_only')
    expect(observeOnly).toEqual([
      expect.objectContaining({ catalogId: 'zcode-cli', enabledByDefault: false, targetCapability: 0 }),
    ])
  })

  it('keeps candidate allowlists internally complete before and after the exact-SHA RC freeze', () => {
    for (const entry of AGENT_INTEGRATION_RELEASE_ENTRIES) {
      expect(entry.components.map(component => component.componentKey)).toEqual(entry.requiredComponents)
      expect(new Set(entry.releaseAcceptedExactVersions).size)
        .toBe(entry.releaseAcceptedExactVersions.length)
      expect(entry.releaseAcceptedExactVersions.every(version => (
        entry.observedExactVersions.includes(version)
      ))).toBe(true)
      const expectedArtifactKeys = entry.releaseAcceptedExactVersions.flatMap(version => (
        entry.officialDistributions.flatMap(distribution => (
          distribution.supportedMacArchitectures.map(architecture => (
            `${distribution.distributionId}\u0000${distribution.packageProvenance}\u0000${version}\u0000${architecture}`
          ))
        ))
      )).sort()
      const actualArtifactKeys = entry.acceptedDistributionArtifacts.map(receipt => (
        `${receipt.distributionId}\u0000${receipt.packageProvenance}\u0000${receipt.version}\u0000${receipt.architecture}`
      )).sort()
      expect(actualArtifactKeys).toEqual(expectedArtifactKeys)
      if (entry.requiredLifecycle) {
        expect(entry.requiredLifecycle.require).toBe('all')
        expect(entry.requiredLifecycle.signals.length).toBeGreaterThan(0)
      } else {
        expect(entry.requiredComponents).not.toContain('lifecycle')
      }
      if (entry.releaseMode === 'production') expect(entry.officialDistributions.length).toBeGreaterThan(0)
    }
  })

  it('freezes every investigated production version as the exact release candidate', () => {
    const expectedVersions = new Map<CatalogId, readonly string[]>([
      ['claude-code-cli', ['2.1.261']],
      ['claude-code-native', ['2.1.261']],
      ['claude-desktop-legacy', ['1.46388.3']],
      ['codex-cli', ['0.153.4']],
      ['codex-desktop', ['26.901.41600']],
      ['cursor-desktop', ['3.19.7']],
      ['windsurf-desktop', ['3.8.20']],
      ['gemini-cli', ['0.58.0']],
      ['kimi-code-cli', ['0.41.0']],
      ['kimi-code-native', ['0.41.0']],
      ['openclaw-local', ['2026.9.1']],
      ['qwen-code-cli', ['0.23.0']],
      ['zcode-desktop', ['3.11.2']],
      ['opencode-v1-cli', ['1.18.29']],
      ['opencode-v2-beta-cli', ['0.0.0-beta-19157']],
      ['pi-official-cli', ['0.85.1']],
      ['omp-cli', ['18.1.11']],
      ['qwenwork-desktop', ['1.2.0']],
      ['claude-cowork-local', ['1.46388.3']],
    ])
    for (const [catalogId, observedExactVersions] of expectedVersions) {
      expect(AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === catalogId))
        .toMatchObject({ observedExactVersions, releaseAcceptedExactVersions: observedExactVersions })
    }
  })

  it('keeps every observed or release-accepted Codex CLI version inside the runtime capability gate', () => {
    const codex = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'codex-cli')
    const runtimeVersions = new Set(CODEX_CAPABILITY_MANIFESTS.map(manifest => manifest.version))

    expect(codex).toBeDefined()
    expect(codex?.observedExactVersions).toEqual(['0.153.4'])
    for (const version of [
      ...(codex?.observedExactVersions ?? []),
      ...(codex?.releaseAcceptedExactVersions ?? []),
    ]) {
      expect(runtimeVersions).toContain(version)
    }
  })

  it('matches the lifecycle require-all signal matrix exported by the production Adapters', () => {
    const expected = new Map<CatalogId, readonly string[]>([
      ['claude-code-cli', CLAUDE_CODE_REQUIRED_LIFECYCLE_SIGNALS],
      ['claude-code-native', CLAUDE_CODE_REQUIRED_LIFECYCLE_SIGNALS],
      ['codex-cli', CODEX_REQUIRED_LIFECYCLE_SIGNALS],
      ['codex-desktop', CODEX_REQUIRED_LIFECYCLE_SIGNALS],
      ['kimi-code-cli', KIMI_CODE_REQUIRED_LIFECYCLE_SIGNALS],
      ['kimi-code-native', KIMI_CODE_REQUIRED_LIFECYCLE_SIGNALS],
      ['gemini-cli', GEMINI_REQUIRED_LIFECYCLE_SIGNALS],
      ['qwen-code-cli', QWEN_CODE_REQUIRED_LIFECYCLE_SIGNALS],
      ['zcode-desktop', ZCODE_REQUIRED_LIFECYCLE_SIGNALS],
      ['openclaw-local', OPENCLAW_REQUIRED_LIFECYCLE_SIGNALS],
      ['qwenwork-desktop', QWENWORK_REQUIRED_LIFECYCLE_SIGNALS],
      ['omp-cli', OMP_REQUIRED_LIFECYCLE_SIGNALS],
      ['pi-official-cli', PI_REQUIRED_LIFECYCLE_SIGNALS],
    ])
    for (const [catalogId, signals] of expected) {
      expect(AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === catalogId)?.requiredLifecycle)
        .toEqual({ signals, require: 'all' })
    }
  })

  it('freezes Pi on the maintained Earendil distribution after the official scope migration', () => {
    const pi = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'pi-official-cli')
    expect(pi).toMatchObject({
      releaseMode: 'production',
      officialDistributions: [{
        distributionId: 'pi-official:@earendil-works/pi-coding-agent',
        packageProvenance: 'npm_metadata:@earendil-works/pi-coding-agent',
      }],
    })
    expect(pi?.officialDistributions).not.toContainEqual(expect.objectContaining({
      packageProvenance: 'npm_metadata:@mariozechner/pi-coding-agent',
    }))
  })

  it('keeps portable and global npm OpenClaw receipts independently addressable at one version', () => {
    const openClaw = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'openclaw-local')!
    const version = '2026.8.1'
    const architecture = 'arm64' as const
    const channels = [
      { distributionId: 'cli:openclaw-local:portable-wrapper', fingerprint: 'a'.repeat(64) },
      { distributionId: 'cli:openclaw-local:npm-global', fingerprint: 'b'.repeat(64) },
    ]
    expect(openClaw.officialDistributions.map(item => item.distributionId)).toEqual(
      channels.map(item => item.distributionId),
    )
    const entry = {
      ...openClaw,
      releaseAcceptedExactVersions: [version],
      acceptedDistributionArtifacts: channels.map(({ distributionId, fingerprint }) => ({
        distributionId,
        packageProvenance: 'npm_metadata:openclaw',
        version,
        architecture,
        artifactSha256: 'c'.repeat(64), artifactSizeBytes: 1,
        executableSha256: 'd'.repeat(64), executableSizeBytes: 1,
        distributionSha256: 'e'.repeat(64), distributionSizeBytes: 1,
        portableFingerprintSchema: distributionId.endsWith('portable-wrapper')
          ? 'openclaw-official-wrapper-v1'
          : 'npm-owned-package-surface-v1',
        portableArtifactFingerprint: fingerprint,
        signedCode: null,
        npmPackage: {
          integrity: 'sha512-YQ==',
          ownedPackageSha256: 'f'.repeat(64),
          ownedEntryCount: 1,
          ownedTotalBytes: 1,
          proofNodes: [],
        },
      })),
    }
    for (const channel of channels) {
      expect(agentReleaseSurfaceEligibilityReason({
        catalogId: 'openclaw-local', detectedVersion: version,
        distributionId: channel.distributionId, packageProvenance: 'npm_metadata:openclaw',
        architecture, portableArtifactFingerprint: channel.fingerprint,
      }, entry)).toBeNull()
    }
  })

  it('keeps standalone and global npm Qwen receipts independently addressable', () => {
    const qwen = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'qwen-code-cli')!
    expect(qwen.officialDistributions).toEqual([
      expect.objectContaining({
        channel: 'npm',
        distributionId: 'cli:qwen-code-cli:standalone',
        packageProvenance: 'npm_metadata:@qwen-code/qwen-code',
        supportedMacArchitectures: ['arm64', 'x64'],
      }),
      expect.objectContaining({
        channel: 'npm',
        distributionId: 'cli:qwen-code-cli:npm-global',
        packageProvenance: 'npm_metadata:@qwen-code/qwen-code',
        supportedMacArchitectures: ['arm64', 'x64'],
      }),
    ])
    expect(qwen.releaseAcceptedExactVersions.every(version => (
      qwen.observedExactVersions.includes(version)
    ))).toBe(true)
  })

  it.each([
    ['pi-official-cli', 'pi-official:@earendil-works/pi-coding-agent', 'npm_metadata:@earendil-works/pi-coding-agent'],
    ['omp-cli', 'omp:oh-my-pi', 'npm_metadata:@oh-my-pi/pi-coding-agent'],
  ] as const)('requires the exact owned npm artifact for %s after strong identity resolution', (
    catalogId,
    distributionId,
    packageProvenance,
  ) => {
    const base = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === catalogId)!
    const version = catalogId === 'omp-cli' ? '18.1.10' : '0.52.12'
    const fingerprint = catalogId === 'omp-cli' ? 'a'.repeat(64) : 'b'.repeat(64)
    const entry = {
      ...base,
      releaseAcceptedExactVersions: [version],
      acceptedDistributionArtifacts: [{
        distributionId,
        packageProvenance,
        version,
        architecture: 'arm64' as const,
        artifactSha256: 'c'.repeat(64), artifactSizeBytes: 1,
        executableSha256: 'd'.repeat(64), executableSizeBytes: 1,
        distributionSha256: 'e'.repeat(64), distributionSizeBytes: 1,
        portableFingerprintSchema: 'npm-owned-package-surface-v1',
        portableArtifactFingerprint: fingerprint,
        signedCode: null,
        npmPackage: {
          integrity: 'sha512-YQ==',
          ownedPackageSha256: 'f'.repeat(64),
          ownedEntryCount: 1,
          ownedTotalBytes: 1,
          proofNodes: [],
        },
      }],
    }
    const surface = {
      catalogId,
      detectedVersion: version,
      distributionId,
      packageProvenance,
      architecture: 'arm64' as const,
      portableArtifactFingerprint: fingerprint,
    }
    expect(agentReleaseSurfaceEligibilityReason(surface, entry)).toBeNull()
    expect(agentReleaseSurfaceEligibilityReason({
      ...surface,
      portableArtifactFingerprint: '0'.repeat(64),
    }, entry)).toBe('release_artifact_not_accepted')
  })

  it('keeps official identity, missing version, unaccepted version, and detect-only mode distinct', () => {
    const codex = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'codex-cli')!
    const official = codex.officialDistributions[0]
    expect(agentReleaseSurfaceEligibilityReason({
      catalogId: 'codex-cli',
      detectedVersion: '0.145.0-alpha.18',
      distributionId: 'cli:codex-cli',
      packageProvenance: 'npm_metadata:not-codex',
    })).toBe('release_distribution_not_accepted')
    expect(agentReleaseSurfaceEligibilityReason({
      catalogId: 'codex-cli',
      distributionId: official.distributionId,
      packageProvenance: official.packageProvenance,
    })).toBe('release_version_unverified')
    expect(agentReleaseSurfaceEligibilityReason({
      catalogId: 'codex-cli',
      detectedVersion: '0.145.0-alpha.18',
      distributionId: official.distributionId,
      packageProvenance: official.packageProvenance,
    })).toBe('release_version_not_accepted')
    expect(agentReleaseSurfaceEligibilityReason({
      catalogId: 'zcode-cli',
      detectedVersion: '1.0.0',
      distributionId: 'cli:zcode-cli',
      packageProvenance: 'npm_metadata:zcode',
    })).toBe('release_mode_detect_only')
    expect(agentReleaseSurfaceEligibilityReason({
      catalogId: 'codex-cli',
      detectedVersion: '0.145.0-alpha.18',
      distributionId: official.distributionId,
      packageProvenance: official.packageProvenance,
      architecture: 'arm64',
      portableArtifactFingerprint: 'a'.repeat(64),
    }, { ...codex, releaseAcceptedExactVersions: ['0.145.0-alpha.18'] }))
      .toBe('release_artifact_not_accepted')
    expect(agentReleaseSurfaceEligibilityReason({
      catalogId: 'codex-cli',
      detectedVersion: '0.145.0-alpha.18',
      distributionId: official.distributionId,
      packageProvenance: official.packageProvenance,
      architecture: 'arm64',
      portableArtifactFingerprint: 'a'.repeat(64),
    }, {
      ...codex,
      releaseAcceptedExactVersions: ['0.145.0-alpha.18'],
      acceptedDistributionArtifacts: [{
        distributionId: official.distributionId,
        packageProvenance: official.packageProvenance,
        version: '0.145.0-alpha.18',
        architecture: 'arm64',
        artifactSha256: 'b'.repeat(64), artifactSizeBytes: 1,
        executableSha256: 'c'.repeat(64), executableSizeBytes: 1,
        distributionSha256: 'd'.repeat(64), distributionSizeBytes: 1,
        portableFingerprintSchema: 'npm-owned-package-surface-v1',
        portableArtifactFingerprint: 'a'.repeat(64),
        signedCode: null,
        npmPackage: { integrity: 'sha512-YQ==', ownedPackageSha256: 'e'.repeat(64), ownedEntryCount: 1, ownedTotalBytes: 1, proofNodes: [] },
      }],
    })).toBeNull()
  })

  it('resolves Kimi version only from one internally consistent frozen signed receipt', () => {
    const base = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'kimi-code-native')!
    const signedCode = {
      identifier: 'kimi', teamIdentifier: '2J9472RW75',
      cdhash: 'a'.repeat(40),
      designatedRequirement: 'identifier "kimi" and anchor apple generic',
    }
    const executableSha256 = 'b'.repeat(64)
    const executableSizeBytes = 123
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const portableArtifactFingerprint = digest({
      schema: 'signed-cli-kimi-release-v2', version: '0.41.0',
      executableArtifactFingerprint: digest({
        schema: 'kimi-native-executable-v1',
        executable: { relativePath: 'bin/kimi', sha256: executableSha256, sizeBytes: executableSizeBytes, executable: true },
      }),
      identifier: signedCode.identifier, teamIdentifier: signedCode.teamIdentifier,
      cdHash: signedCode.cdhash, designatedRequirement: signedCode.designatedRequirement,
    })
    const receipt: AgentReleaseDistributionArtifactReceipt = {
      distributionId: 'cli:kimi-code-native', packageProvenance: 'signed_cli:kimi:2J9472RW75',
      version: '0.41.0', architecture: 'arm64',
      artifactSha256: 'c'.repeat(64), artifactSizeBytes: 456,
      executableSha256, executableSizeBytes,
      distributionSha256: executableSha256, distributionSizeBytes: executableSizeBytes,
      portableFingerprintSchema: 'signed-cli-kimi-release-v2', portableArtifactFingerprint,
      signedCode, npmPackage: null,
    }
    const entry = {
      ...base,
      releaseAcceptedExactVersions: ['0.41.0'],
      acceptedDistributionArtifacts: [receipt],
    }
    const lookupFingerprint = kimiNativeReceiptLookupFingerprint({
      architecture: 'arm64', executableSha256, executableSizeBytes,
      identifier: signedCode.identifier, teamIdentifier: signedCode.teamIdentifier,
      cdHash: signedCode.cdhash, designatedRequirement: signedCode.designatedRequirement,
    })
    expect(validArtifactReceipt(receipt, entry)).toBe(true)
    expect(resolveAcceptedKimiNativeReceipt({ architecture: 'arm64', lookupFingerprint }, entry))
      .toEqual(receipt)
    expect(resolveAcceptedKimiNativeReceipt({ architecture: 'x64', lookupFingerprint }, entry)).toBeNull()
    expect(resolveAcceptedKimiNativeReceipt({ architecture: 'arm64', lookupFingerprint }, {
      ...entry, acceptedDistributionArtifacts: [receipt, { ...receipt }],
    })).toBeNull()
    expect(validArtifactReceipt({
      ...receipt, portableFingerprintSchema: 'signed-cli-kimi-updater-v1',
    }, entry)).toBe(false)
    expect(validArtifactReceipt({
      ...receipt, signedCode: { ...signedCode, teamIdentifier: 'ATTACKER00' },
    }, entry)).toBe(false)
  })

  it('preserves an unaccepted exact installation as detect-only with an explicit runtime reason', () => {
    const installation: DiscoveredInstallation = {
      catalogId: 'codex-cli',
      displayName: 'Codex CLI',
      identity: {
        runtimeRealm: 'local_macos',
        osUserIdentity: 'uid:501',
        productFamilyId: 'codex',
        hostVariant: 'codex-cli',
        canonicalConfigRoot: '/Users/test/.codex',
        explicitProfile: 'default',
        distribution: {
          distributionId: 'cli:codex-cli',
          executableRealpath: '/opt/homebrew/bin/codex',
          packageProvenance: 'npm_metadata:@openai/codex',
          capabilityFingerprint: 'cli-surface:codex-cli',
        },
        installKey: 'install:codex',
      },
      configRoot: '/Users/test/.codex',
      executablePath: '/opt/homebrew/bin/codex',
      detectedVersion: '0.145.0-alpha.18',
      versionDetectionMethod: 'cli_version',
      managementEligibility: {
        schemaVersion: 1,
        eligible: true,
        executableSizeBytes: 1024,
        proofLimitBytes: 512 * 1024 * 1024,
      },
      provenance: ['npm_metadata:@openai/codex'],
      evidence: [],
    }
    const report = applyAgentReleaseGateToReport({
      installations: [installation],
      unresolved: [],
      diagnostics: [],
    })
    expect(report.installations).toHaveLength(1)
    expect(report.installations[0]).toMatchObject({
      detectedVersion: '0.145.0-alpha.18',
      managementEligibility: {
        eligible: false,
        reason: 'release_version_not_accepted',
        executableSizeBytes: 1024,
      },
    })
  })

  it('keeps every released entry in exact Catalog -> manifest -> concrete Adapter parity', () => {
    const adapters = createP0HostAdapters()
    for (const entry of AGENT_INTEGRATION_RELEASE_ENTRIES.filter(candidate => candidate.enabledByDefault)) {
      const variant = AGENT_CATALOG.variants.find(candidate => candidate.catalogId === entry.catalogId)
      const adapter = adapters.get(entry.catalogId)
      expect(variant, `${entry.catalogId} has no Catalog variant`).toBeDefined()
      expect(adapter, `${entry.catalogId} has no released Adapter`).toBeDefined()
      expect(variant?.components.filter(component => component.applicability === 'supported')
        .map(component => component.componentKey).sort(), `${entry.catalogId} Catalog component scope`)
        .toEqual([...entry.requiredComponents].sort())
      expect(new Set(adapter?.componentKeys), `${entry.catalogId} component coverage`)
        .toEqual(new Set(entry.requiredComponents))
      for (const component of entry.components) {
        const catalogComponent = variant?.components.find(candidate => candidate.componentKey === component.componentKey)
        expect(catalogComponent, `${entry.catalogId}:${component.componentKey} Catalog declaration`).toMatchObject({
          applicability: component.applicability,
          deliveryMode: component.deliveryMode,
          artifactTypes: component.artifactTypes,
          mutationDomain: component.mutationDomain,
          reload: component.reload,
        })
        expect(adapter?.implementationTypes[component.componentKey], `${entry.catalogId}:${component.componentKey} implementation carriers`)
          .toEqual(component.artifactTypes)
        expect(adapter?.componentContracts?.[component.componentKey], `${entry.catalogId}:${component.componentKey} concrete contract`)
          .toEqual({
            deliveryMode: component.deliveryMode,
            artifactTypes: component.artifactTypes,
            mutationDomain: component.mutationDomain,
            reload: component.reload,
          })
      }
    }
  })

  it('ships Pi as a complete managed native-package integration', () => {
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES).toContainEqual(expect.objectContaining({
      catalogId: 'pi-official-cli',
      disposition: 'managed',
      targetCapability: 4,
      requiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      enabledByDefault: true,
    }))
    expect(createP0HostAdapters().get('pi-official-cli')?.implementationTypes).toEqual({
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin'],
      lifecycle: ['plugin'],
    })
  })

  it('ships ZCode Desktop as a complete C4 aggregate with managed lifecycle', () => {
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES).toContainEqual(expect.objectContaining({
      catalogId: 'zcode-desktop',
      disposition: 'managed',
      targetCapability: 4,
      requiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      requiredLifecycle: { signals: ['session_start'], require: 'all' },
    }))
    expect(createP0HostAdapters().get('zcode-desktop')?.componentKeys).toEqual([
      'instruction',
      'memory_tools',
      'lifecycle',
    ])
    expect(createP0HostAdapters().get('zcode-desktop')?.implementationTypes).toEqual({
      instruction: ['skill'],
      memory_tools: ['mcp'],
      lifecycle: ['hook'],
    })
  })

  it('ships Gemini through one complete managed official Extension', () => {
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES).toContainEqual(expect.objectContaining({
      catalogId: 'gemini-cli',
      disposition: 'managed',
      targetCapability: 4,
      requiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      enabledByDefault: true,
    }))
    expect(createP0HostAdapters().get('gemini-cli')?.implementationTypes).toEqual({
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin', 'mcp'],
      lifecycle: ['plugin', 'hook'],
    })
  })

  it('ships Windsurf with Skill, MCP, and managed user lifecycle Hooks', () => {
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES).toContainEqual(expect.objectContaining({
      catalogId: 'windsurf-desktop',
      disposition: 'managed',
      targetCapability: 4,
      requiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      enabledByDefault: true,
    }))
    expect(createP0HostAdapters().get('windsurf-desktop')?.implementationTypes).toEqual({
      instruction: ['skill'],
      memory_tools: ['mcp'],
      lifecycle: ['hook'],
    })
  })

  it('ships OpenClaw through one complete managed native Plugin', () => {
    expect(AGENT_INTEGRATION_RELEASE_ENTRIES).toContainEqual(expect.objectContaining({
      catalogId: 'openclaw-local',
      disposition: 'managed',
      targetCapability: 4,
      requiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      enabledByDefault: true,
    }))
    expect(createP0HostAdapters().get('openclaw-local')?.implementationTypes).toEqual({
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin'],
      lifecycle: ['plugin', 'hook'],
    })
  })

  it('does not advertise unpublished carriers or lifecycle surfaces for the audited drift set', () => {
    const contracts = Object.fromEntries(AGENT_INTEGRATION_RELEASE_ENTRIES
      .filter(entry => [
        'qwen-code-cli', 'opencode-v1-cli', 'opencode-v2-beta-cli',
        'openclaw-local', 'claude-cowork-local',
      ].includes(entry.catalogId))
      .map(entry => [entry.catalogId, {
        targetCapability: entry.targetCapability,
        components: entry.components.map(component => ({
          key: component.componentKey,
          deliveryMode: component.deliveryMode,
          artifacts: component.artifactTypes,
          domain: component.mutationDomain,
          reload: component.reload,
        })),
      }]))
    expect(contracts).toEqual({
      'qwen-code-cli': { targetCapability: 4, components: [
        { key: 'instruction', deliveryMode: 'managed', artifacts: ['skill'], domain: 'file_fragment', reload: 'new_session' },
        { key: 'memory_tools', deliveryMode: 'managed', artifacts: ['mcp'], domain: 'file_fragment', reload: 'new_session' },
        { key: 'lifecycle', deliveryMode: 'managed', artifacts: ['hook'], domain: 'file_fragment', reload: 'new_session' },
      ] },
      'opencode-v1-cli': { targetCapability: 4, components: [
        { key: 'instruction', deliveryMode: 'managed', artifacts: ['skill'], domain: 'file_fragment', reload: 'new_session' },
        { key: 'memory_tools', deliveryMode: 'managed', artifacts: ['mcp'], domain: 'file_fragment', reload: 'new_session' },
        { key: 'lifecycle', deliveryMode: 'managed', artifacts: ['plugin'], domain: 'file_fragment', reload: 'restart_host' },
      ] },
      'opencode-v2-beta-cli': { targetCapability: 3, components: [
        { key: 'instruction', deliveryMode: 'managed', artifacts: ['skill'], domain: 'file_fragment', reload: 'new_session' },
        { key: 'memory_tools', deliveryMode: 'managed', artifacts: ['mcp'], domain: 'file_fragment', reload: 'new_session' },
      ] },
      'openclaw-local': { targetCapability: 4, components: [
        { key: 'instruction', deliveryMode: 'managed', artifacts: ['plugin', 'skill'], domain: 'plugin_manager', reload: 'restart_host' },
        { key: 'memory_tools', deliveryMode: 'managed', artifacts: ['plugin'], domain: 'plugin_manager', reload: 'restart_host' },
        { key: 'lifecycle', deliveryMode: 'managed', artifacts: ['plugin', 'hook'], domain: 'plugin_manager', reload: 'restart_host' },
      ] },
      'claude-cowork-local': { targetCapability: 3, components: [
        { key: 'instruction', deliveryMode: 'guided', artifacts: ['plugin', 'skill'], domain: 'file_fragment', reload: 'user_confirmation' },
        { key: 'memory_tools', deliveryMode: 'guided', artifacts: ['plugin', 'mcp'], domain: 'file_fragment', reload: 'user_confirmation' },
      ] },
    })
  })

  it('never broadens beyond Catalog component declarations or capability ceilings', () => {
    for (const entry of AGENT_INTEGRATION_RELEASE_ENTRIES) {
      const variant = AGENT_CATALOG.variants.find(candidate => candidate.catalogId === entry.catalogId)
      expect(variant).toBeDefined()
      expect(entry.targetCapability).toBeLessThanOrEqual(variant!.maxCapability)
      const supported = variant!.components
        .filter(component => component.applicability === 'supported')
        .map(component => component.componentKey)
      for (const component of entry.requiredComponents) expect(supported).toContain(component)
    }
  })

  it('defaults every released P0/migration surface on without an environment allowlist', () => {
    expect(defaultReleasedAdapterIds()).toEqual(
      AGENT_INTEGRATION_RELEASE_ENTRIES
        .filter(entry => entry.catalogId !== 'zcode-cli')
        .map(entry => entry.catalogId),
    )
  })

  it('uses runtime switches only as intersections or emergency kill switches', () => {
    const adapters = releasedAdapterSurface()
    const active = resolveAgentIntegrationReleasePolicy({ adapters, environment: {} })
    expect(active.mode).toBe('active')
    expect(active.enabledAdapterIds).toEqual(defaultReleasedAdapterIds())
    expect(active.autoRestore).toBe(true)

    const restricted = resolveAgentIntegrationReleasePolicy({
      adapters,
      environment: {
        [AGENT_INTEGRATION_RELEASE_ENV.adapters]: 'cursor-desktop,zcode-cli,not-released',
      },
      restrictToAdapterIds: ['cursor-desktop', 'codex-cli'],
    })
    expect(restricted.enabledAdapterIds).toEqual(['cursor-desktop'])
    expect(restricted.diagnostics).toContain('release_adapter_restriction_unknown:not-released')

    const emergency = resolveAgentIntegrationReleasePolicy({
      adapters,
      environment: {
        [AGENT_INTEGRATION_RELEASE_ENV.writes]: '0',
        [AGENT_INTEGRATION_RELEASE_ENV.autoRestore]: '0',
      },
      forceObserveOnly: false,
      autoRestore: true,
    })
    expect(emergency).toMatchObject({
      mode: 'emergency_read_only',
      enabledAdapterIds: [],
      autoRestore: false,
    })
  })

  it('fails the whole production policy closed when released Adapter coverage is incomplete', () => {
    const missing = new Map(releasedAdapterSurface())
    missing.delete('codex-cli')
    expect(resolveAgentIntegrationReleasePolicy({ adapters: missing, environment: {} })).toMatchObject({
      mode: 'invalid_manifest',
      enabledAdapterIds: [],
      autoRestore: false,
      customLocalAgentEnabled: false,
      diagnostics: expect.arrayContaining(['release_adapter_missing:codex-cli']),
    })

    const mismatched = new Map(releasedAdapterSurface())
    mismatched.set('codex-cli', {
      catalogId: 'codex-cli',
      componentKeys: ['instruction'],
    } as AgentHostAdapter)
    expect(resolveAgentIntegrationReleasePolicy({ adapters: mismatched, environment: {} })).toMatchObject({
      mode: 'invalid_manifest',
      enabledAdapterIds: [],
      autoRestore: false,
      customLocalAgentEnabled: false,
      diagnostics: expect.arrayContaining(['release_component_mismatch:codex-cli']),
    })

    const contractDrift = new Map(createP0HostAdapters())
    const codex = contractDrift.get('codex-cli')!
    contractDrift.set('codex-cli', {
      ...codex,
      componentContracts: {
        ...codex.componentContracts,
        memory_tools: {
          ...codex.componentContracts!.memory_tools!,
          reload: 'restart_host',
        },
      },
    })
    expect(resolveAgentIntegrationReleasePolicy({ adapters: contractDrift, environment: {} })).toMatchObject({
      mode: 'invalid_manifest',
      enabledAdapterIds: [],
      autoRestore: false,
      diagnostics: expect.arrayContaining(['release_contract_mismatch:codex-cli:memory_tools']),
    })
  })
})
