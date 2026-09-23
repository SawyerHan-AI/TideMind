import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error local plain-ESM release helper has no declaration file
import {
  AGENT_RUNTIME_BUNDLES,
  assertAgentIntegrationReleaseAcceptance,
  inspectPackagedAgentIntegrationReleaseManifest,
} from '../../scripts/verify-mac-release-assets.mjs'
// @ts-expect-error local plain-ESM release helper has no declaration file
import { codeMarkerCount, parseSourceAgentIntegrationReleaseContract, portableArtifactFingerprint } from '../../scripts/agent-integration-release-contract.mjs'

const sourceManifest = fs.readFileSync(path.resolve(
  'client/electron/agent-integration/release-manifest.ts',
), 'utf8')
const sourceContract = parseSourceAgentIntegrationReleaseContract(sourceManifest)

function frozenEntriesSource(entries = sourceContract.entries): string {
  const expressions = new Map([
    ['instruction,memory_tools,lifecycle', 'ALL_COMPONENTS'],
    ['instruction,memory_tools', 'CORE_COMPONENTS'],
  ])
  return entries.map(entry => {
    const details = JSON.stringify({
      components: entry.components,
      officialDistributions: entry.officialDistributions,
      acceptedDistributionArtifacts: entry.acceptedDistributionArtifacts,
      observedExactVersions: entry.observedExactVersions,
      releaseAcceptedExactVersions: entry.releaseAcceptedExactVersions,
      activation: entry.activation,
      requiredLifecycle: entry.requiredLifecycle,
      releaseMode: entry.releaseMode,
    })
    if (!entry.enabledByDefault) {
      return `observeOnly(${JSON.stringify(entry.catalogId)}, ${JSON.stringify(entry.notes)}, ${details}),`
    }
    const components = expressions.get(entry.requiredComponents.join(','))
      ?? JSON.stringify(entry.requiredComponents)
    return `release("${entry.catalogId}", "${entry.disposition}", ${entry.targetCapability}, ${components}, ${details}),`
  }).join('\n  ')
}

function bundle(overrides: {
  version?: string
  schemaVersion?: number
  defaultEntries?: string
  customEnabled?: boolean
  customModes?: string[]
  bindProductionPolicy?: boolean
} = {}): string {
  const version = overrides.version ?? '0.2.92'
  const schemaVersion = overrides.schemaVersion ?? 4
  const defaultEntries = overrides.defaultEntries ?? frozenEntriesSource()
  const customEnabled = overrides.customEnabled ?? true
  const customModes = overrides.customModes ?? [...sourceContract.customModes]
  const bindProductionPolicy = overrides.bindProductionPolicy ?? true
  return `
const AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION = "${version}";
const AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION = ${schemaVersion};
const CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS = Object.freeze(["cursor-desktop"]);
const AGENT_INTEGRATION_RELEASE_ENTRIES = Object.freeze([
  ${defaultEntries}
]);
const AGENT_INTEGRATION_RELEASE_MANIFEST = Object.freeze({
  schemaVersion: AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION,
  appVersion: AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION,
  features: Object.freeze({
    customLocalAgent: Object.freeze({
      enabledByDefault: ${String(customEnabled)},
      modes: Object.freeze(${JSON.stringify(customModes)})
    })
  }),
  entries: AGENT_INTEGRATION_RELEASE_ENTRIES
});
function release(catalogId, disposition, targetCapability, requiredComponents, details) {
  return Object.freeze({ catalogId, disposition, targetCapability, requiredComponents, ...details, customConfigRoot: { supported: CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS.includes(catalogId as never) }, enabledByDefault: details.releaseMode === "production" });
}
function observeOnly(catalogId, notes, details) {
  return Object.freeze({ catalogId, disposition: "observe_only", targetCapability: 0, requiredComponents: [], ...details, customConfigRoot: { supported: false }, enabledByDefault: false, notes });
}
function createProductionAgentIntegrationComposition() {
  ${bindProductionPolicy ? 'const releasePolicy = resolveAgentIntegrationReleasePolicy({' : 'const releasePolicy = legacyEnvironmentGate({'}
  });
  const observeOnly = releasePolicy.mode !== "active";
  const customAdapterActive = !observeOnly && releasePolicy.customLocalAgentEnabled;
  const activeAdapterIds = [...releasePolicy.enabledAdapterIds,];
  const runtime = { autoRestore: releasePolicy.autoRestore, };
  return {
    customAdapterActive,
    activeAdapterIds,
    runtime,
    releasePolicyMode: releasePolicy.mode,
    releasePolicyDiagnostics: releasePolicy.diagnostics,
  };
}
`
}

describe('packaged Agent Integration release manifest gate', () => {
  it('accepts OMP x64 only with the independently frozen baseline native path', () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
    const executable = { role: 'npm_package_executable', relativePath: 'dist/cli.js', sha256: '1'.repeat(64), sizeBytes: 10, executable: true, normalization: 'raw' }
    const manifest = { role: 'package_manifest', relativePath: 'package.json', sha256: '2'.repeat(64), sizeBytes: 20, executable: false, normalization: 'raw' }
    const components = [
      {
        role: 'platform_selector', installName: '@oh-my-pi/pi-natives', manifestName: '@oh-my-pi/pi-natives', version: '18.1.11',
        integrity: 'sha512-YQ==', artifactSha256: '3'.repeat(64), artifactSizeBytes: 30,
        ownedPackageSha256: '4'.repeat(64), ownedEntryCount: 2, ownedTotalBytes: 40,
        nativeExecutableRelativePath: null, nativeExecutableSha256: null, nativeExecutableSizeBytes: null,
      },
      {
        role: 'platform_leaf', installName: '@oh-my-pi/pi-natives-darwin-x64', manifestName: '@oh-my-pi/pi-natives-darwin-x64', version: '18.1.11',
        integrity: 'sha512-Yg==', artifactSha256: '5'.repeat(64), artifactSizeBytes: 50,
        ownedPackageSha256: '6'.repeat(64), ownedEntryCount: 2, ownedTotalBytes: 60,
        nativeExecutableRelativePath: 'pi_natives.darwin-x64-baseline.node',
        nativeExecutableSha256: '7'.repeat(64), nativeExecutableSizeBytes: 70,
      },
    ]
    const runtimeComponents = components.map(component => {
      const runtime = { ...component } as Record<string, unknown>
      delete runtime.artifactSha256
      delete runtime.artifactSizeBytes
      return runtime
    })
    const receipt: any = {
      distributionId: 'omp:oh-my-pi', packageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
      version: '18.1.11', architecture: 'x64', artifactSha256: '8'.repeat(64), artifactSizeBytes: 80,
      executableSha256: executable.sha256, executableSizeBytes: executable.sizeBytes,
      distributionSizeBytes: 200, portableFingerprintSchema: 'npm-composed-platform-surface-v1',
      signedCode: null,
      npmPackage: {
        integrity: 'sha512-Yw==', ownedPackageSha256: '9'.repeat(64), ownedEntryCount: 3,
        ownedTotalBytes: 100, proofNodes: [executable, manifest],
        composition: { entryRule: 'js_entry_loads_platform_native_v1', components },
      },
    }
    receipt.distributionSha256 = digest(JSON.stringify({
      schema: 'npm-composed-owned-packages-v1',
      root: { packageName: '@oh-my-pi/pi-coding-agent', integrity: receipt.npmPackage.integrity, ownedPackageSha256: receipt.npmPackage.ownedPackageSha256, ownedEntryCount: 3, ownedTotalBytes: 100 },
      entryRule: 'js_entry_loads_platform_native_v1', components: runtimeComponents,
    }))
    receipt.portableArtifactFingerprint = portableArtifactFingerprint(receipt)
    const entries = sourceContract.entries.map(entry => entry.catalogId === 'omp-cli' ? {
      ...entry,
      officialDistributions: entry.officialDistributions.map(distribution => ({
        ...distribution, supportedMacArchitectures: ['x64'],
      })),
      releaseAcceptedExactVersions: ['18.1.11'],
      acceptedDistributionArtifacts: [receipt],
    } : entry)
    expect(() => parseSourceAgentIntegrationReleaseContract(bundle({ defaultEntries: frozenEntriesSource(entries) }))).not.toThrow()
    const wrongPath = structuredClone(receipt)
    wrongPath.npmPackage.composition.components[1].nativeExecutableRelativePath = 'pi_natives.darwin-x64.node'
    const invalidEntries = entries.map(entry => entry.catalogId === 'omp-cli'
      ? { ...entry, acceptedDistributionArtifacts: [wrongPath] }
      : entry)
    expect(() => parseSourceAgentIntegrationReleaseContract(bundle({ defaultEntries: frozenEntriesSource(invalidEntries) })))
      .toThrow(/wrong .* npm composition/u)
  })

  it('recomputes composed npm receipts and rejects a substituted leaf', () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
    const executable = { role: 'npm_package_executable', relativePath: 'bin/claude.exe', sha256: '1'.repeat(64), sizeBytes: 10, executable: true, normalization: 'raw' }
    const component = {
      role: 'platform_leaf', installName: '@anthropic-ai/claude-code-darwin-arm64',
      manifestName: '@anthropic-ai/claude-code-darwin-arm64', version: '2.1.261',
      integrity: 'sha512-YQ==', artifactSha256: '2'.repeat(64), artifactSizeBytes: 20,
      ownedPackageSha256: '3'.repeat(64), ownedEntryCount: 2, ownedTotalBytes: 30,
      nativeExecutableRelativePath: 'claude', nativeExecutableSha256: executable.sha256,
      nativeExecutableSizeBytes: executable.sizeBytes,
    }
    const receipt: any = {
      packageProvenance: 'npm_metadata:@anthropic-ai/claude-code', version: '2.1.261',
      portableFingerprintSchema: 'npm-composed-platform-surface-v1',
      executableSha256: executable.sha256, executableSizeBytes: executable.sizeBytes,
      npmPackage: {
        integrity: 'sha512-Yg==', ownedPackageSha256: '4'.repeat(64), ownedEntryCount: 3,
        ownedTotalBytes: 40, proofNodes: [executable],
        composition: { entryRule: 'copy_platform_binary_v1', components: [component] },
      },
    }
    const runtimeComponents = [{ ...component }]
    delete runtimeComponents[0].artifactSha256
    delete runtimeComponents[0].artifactSizeBytes
    receipt.distributionSha256 = digest(JSON.stringify({
      schema: 'npm-composed-owned-packages-v1',
      root: { packageName: '@anthropic-ai/claude-code', integrity: receipt.npmPackage.integrity, ownedPackageSha256: receipt.npmPackage.ownedPackageSha256, ownedEntryCount: 3, ownedTotalBytes: 40 },
      entryRule: 'copy_platform_binary_v1', components: runtimeComponents,
    }))
    expect(portableArtifactFingerprint(receipt)).toMatch(/^[a-f0-9]{64}$/u)
    const tampered = structuredClone(receipt)
    tampered.npmPackage.composition.components[0].ownedPackageSha256 = '5'.repeat(64)
    expect(() => portableArtifactFingerprint(tampered)).toThrow(/distribution digest/)
  })

  it('recomputes the OpenClaw portable receipt from its normalized prefix template', () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
    const wrapper = '#!/usr/bin/env bash\nset -euo pipefail\nexec "<OPENCLAW_PREFIX>/tools/node/bin/node" "<OPENCLAW_PREFIX>/tools/node-v22.14.0/lib/node_modules/openclaw/dist/entry.js" "$@"\n'
    const files = [
      { role: 'openclaw_wrapper', relativePath: 'bin/openclaw', sha256: digest(wrapper), sizeBytes: Buffer.byteLength(wrapper), executable: true, normalization: 'openclaw_prefix_template_v1' },
      { role: 'openclaw_node_runtime', relativePath: 'tools/node-v22.14.0/bin/node', sha256: '1'.repeat(64), sizeBytes: 2, executable: true, normalization: 'raw' },
      { role: 'openclaw_entry', relativePath: 'tools/node-v22.14.0/lib/node_modules/openclaw/dist/entry.js', sha256: '2'.repeat(64), sizeBytes: 3, executable: false, normalization: 'raw' },
      { role: 'package_manifest', relativePath: 'tools/node-v22.14.0/lib/node_modules/openclaw/package.json', sha256: '3'.repeat(64), sizeBytes: 4, executable: false, normalization: 'raw' },
    ]
    const ownedPackageSha256 = '7'.repeat(64)
    const receipt = {
      version: '2026.8.1', portableFingerprintSchema: 'openclaw-official-wrapper-v1',
      executableSha256: files[0].sha256, executableSizeBytes: files[0].sizeBytes,
      npmPackage: { proofNodes: files, ownedPackageSha256, ownedEntryCount: 11_103, ownedTotalBytes: 204_830_251 },
    }
    const expected = digest(JSON.stringify({
      schema: 'openclaw-official-wrapper-v1', version: '2026.8.1',
      wrapper: { relativePath: files[0].relativePath, sha256: files[0].sha256, sizeBytes: files[0].sizeBytes, executable: true },
      node: { relativePath: files[1].relativePath, sha256: files[1].sha256, sizeBytes: files[1].sizeBytes, executable: true },
      ownedPackageSha256,
      ownedEntryCount: 11_103,
      ownedTotalBytes: 204_830_251,
    }))
    expect(portableArtifactFingerprint(receipt)).toBe(expected)
  })

  it('recomputes the Qwen standalone receipt from its normalized prefix and owned package summary', () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
    const launcherText = [
      '#!/usr/bin/env sh',
      'set -e',
      'ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
      'QWEN_CODE_LAUNCHER_PATH="$ROOT/bin/qwen" exec "$ROOT/node/bin/node" "$ROOT/lib/cli-entry.js" "$@"',
      '',
    ].join('\n')
    const files = [
      { role: 'qwen_launcher', relativePath: 'bin/qwen', sha256: digest(launcherText), sizeBytes: Buffer.byteLength(launcherText), executable: true, normalization: 'qwen_relative_root_v1' },
      { role: 'package_manifest', relativePath: 'package.json', sha256: '2'.repeat(64), sizeBytes: 12, executable: false, normalization: 'raw' },
      { role: 'qwen_standalone_manifest', relativePath: 'manifest.json', sha256: '3'.repeat(64), sizeBytes: 13, executable: false, normalization: 'raw' },
      { role: 'qwen_cli_entry', relativePath: 'lib/cli-entry.js', sha256: '4'.repeat(64), sizeBytes: 14, executable: false, normalization: 'raw' },
      { role: 'qwen_node_runtime', relativePath: 'node/bin/node', sha256: '5'.repeat(64), sizeBytes: 15, executable: true, normalization: 'raw' },
    ]
    const receipt = {
      distributionId: 'cli:qwen-code-cli:standalone',
      version: '0.23.0',
      portableFingerprintSchema: 'qwen-standalone-surface-v1',
      executableSha256: files[0].sha256,
      executableSizeBytes: files[0].sizeBytes,
      npmPackage: {
        integrity: null,
        ownedPackageSha256: '6'.repeat(64),
        ownedEntryCount: 3_690,
        ownedTotalBytes: 100_000,
        proofNodes: files,
      },
    }
    const portableFile = (node: typeof files[number], relativePath = node.relativePath) => ({
      relativePath, sha256: node.sha256, sizeBytes: node.sizeBytes, executable: node.executable,
    })
    expect(portableArtifactFingerprint(receipt)).toBe(digest(JSON.stringify({
      schema: 'qwen-standalone-surface-v1',
      version: receipt.version,
      launcher: portableFile(files[0]),
      standaloneManifest: portableFile(files[2]),
      cliEntry: portableFile(files[3]),
      node: portableFile(files[4]),
      ownedPackageSha256: receipt.npmPackage.ownedPackageSha256,
      ownedEntryCount: receipt.npmPackage.ownedEntryCount,
      ownedTotalBytes: receipt.npmPackage.ownedTotalBytes,
    })))

    const wrongIntegrity = structuredClone(receipt)
    wrongIntegrity.npmPackage.integrity = 'sha512-YQ=='
    expect(() => portableArtifactFingerprint(wrongIntegrity)).toThrow(/distribution identity/)

    const pollutedLauncher = structuredClone(receipt)
    const pollutedText = `${launcherText}PATH=/tmp\n`
    pollutedLauncher.npmPackage.proofNodes[0].sha256 = digest(pollutedText)
    pollutedLauncher.npmPackage.proofNodes[0].sizeBytes = Buffer.byteLength(pollutedText)
    pollutedLauncher.executableSha256 = digest(pollutedText)
    pollutedLauncher.executableSizeBytes = Buffer.byteLength(pollutedText)
    expect(() => portableArtifactFingerprint(pollutedLauncher)).toThrow(/normalized launcher/)

    const splicedTopology = structuredClone(receipt)
    splicedTopology.npmPackage.proofNodes[3].relativePath = 'lib/other.js'
    expect(() => portableArtifactFingerprint(splicedTopology)).toThrow(/proof topology/)
  })

  it('recomputes the signed Kimi receipt with the runtime sizeBytes payload', () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
    const receipt = {
      version: '1.2.3',
      portableFingerprintSchema: 'signed-cli-kimi-release-v2',
      executableSha256: '4'.repeat(64),
      executableSizeBytes: 42,
      signedCode: {
        identifier: 'com.moonshot.kimi',
        teamIdentifier: 'TEAM123456',
        cdhash: 'A'.repeat(40),
        designatedRequirement: 'identifier "com.moonshot.kimi" and anchor apple generic',
      },
    }
    const executableArtifactFingerprint = digest(JSON.stringify({
      schema: 'kimi-native-executable-v1',
      executable: {
        relativePath: 'bin/kimi',
        sha256: receipt.executableSha256,
        sizeBytes: receipt.executableSizeBytes,
        executable: true,
      },
    }))
    const expected = digest(JSON.stringify({
      schema: 'signed-cli-kimi-release-v2',
      version: receipt.version,
      executableArtifactFingerprint,
      identifier: receipt.signedCode.identifier,
      teamIdentifier: receipt.signedCode.teamIdentifier,
      cdHash: receipt.signedCode.cdhash.toLowerCase(),
      designatedRequirement: receipt.signedCode.designatedRequirement,
    }))
    expect(portableArtifactFingerprint(receipt)).toBe(expected)
  })

  it('accepts only the v2 Kimi signed identity in the independent release parser', () => {
    const receipt = (architecture: 'arm64' | 'x64') => {
      const candidate = {
        distributionId: 'cli:kimi-code-native',
        packageProvenance: 'signed_cli:kimi:2J9472RW75',
        version: '0.41.0',
        architecture,
        artifactSha256: (architecture === 'arm64' ? '1' : '2').repeat(64),
        artifactSizeBytes: 100,
        executableSha256: (architecture === 'arm64' ? '3' : '4').repeat(64),
        executableSizeBytes: 80,
        distributionSha256: (architecture === 'arm64' ? '3' : '4').repeat(64),
        distributionSizeBytes: 80,
        portableFingerprintSchema: 'signed-cli-kimi-release-v2',
        portableArtifactFingerprint: '',
        signedCode: {
          identifier: 'kimi', teamIdentifier: '2J9472RW75', cdhash: 'a'.repeat(40),
          designatedRequirement: 'identifier kimi and anchor apple generic',
        },
        npmPackage: null,
      }
      candidate.portableArtifactFingerprint = portableArtifactFingerprint(candidate)
      return candidate
    }
    const receipts = [receipt('arm64'), receipt('x64')]
    const entries = sourceContract.entries.map(entry => entry.catalogId === 'kimi-code-native'
      ? { ...entry, releaseAcceptedExactVersions: ['0.41.0'], acceptedDistributionArtifacts: receipts }
      : entry)
    expect(() => parseSourceAgentIntegrationReleaseContract(bundle({
      defaultEntries: frozenEntriesSource(entries),
    }))).not.toThrow()

    const legacy = structuredClone(receipts)
    legacy[0].portableFingerprintSchema = 'signed-cli-kimi-updater-v1'
    const legacyEntries = entries.map(entry => entry.catalogId === 'kimi-code-native'
      ? { ...entry, acceptedDistributionArtifacts: legacy }
      : entry)
    expect(() => parseSourceAgentIntegrationReleaseContract(bundle({
      defaultEntries: frozenEntriesSource(legacyEntries),
    }))).toThrow(/invalid kimi-code-native signed artifact receipt/u)

    const substituted = structuredClone(receipts)
    substituted[0].signedCode.teamIdentifier = 'ATTACKER00'
    const substitutedEntries = entries.map(entry => entry.catalogId === 'kimi-code-native'
      ? { ...entry, acceptedDistributionArtifacts: substituted }
      : entry)
    expect(() => parseSourceAgentIntegrationReleaseContract(bundle({
      defaultEntries: frozenEntriesSource(substitutedEntries),
    }))).toThrow(/invalid kimi-code-native signed artifact receipt/u)
  })

  it('recomputes the shared signed App/CLI receipt with the runtime canonical payload', () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
    const receipt = {
      version: '3.10.2',
      portableFingerprintSchema: 'signed-code-v1',
      executableSha256: '9'.repeat(64),
      executableSizeBytes: 4_096,
      signedCode: {
        identifier: 'dev.zcode.app',
        teamIdentifier: '8A5X4JJ39T',
        cdhash: 'A'.repeat(40),
        designatedRequirement: 'identifier "dev.zcode.app" and anchor apple generic',
      },
    }
    expect(portableArtifactFingerprint(receipt)).toBe(digest(JSON.stringify({
      schema: 'signed-code-v1',
      version: receipt.version,
      executable: {
        sha256: receipt.executableSha256,
        sizeBytes: receipt.executableSizeBytes,
        executable: true,
      },
      identifier: receipt.signedCode.identifier,
      teamIdentifier: receipt.signedCode.teamIdentifier,
      cdHash: receipt.signedCode.cdhash.toLowerCase(),
      designatedRequirement: receipt.signedCode.designatedRequirement,
    })))
  })

  it('recomputes a full npm surface and binds its exact executable', () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
    const files = [
      { role: 'npm_package_executable', relativePath: 'bin/kimi.js', sha256: '5'.repeat(64), sizeBytes: 5, executable: true, normalization: 'raw' },
      { role: 'npm_package_file', relativePath: 'empty.txt', sha256: digest(''), sizeBytes: 0, executable: false, normalization: 'raw' },
      { role: 'package_manifest', relativePath: 'package.json', sha256: '6'.repeat(64), sizeBytes: 6, executable: false, normalization: 'raw' },
    ]
    const ownedPackageSha256 = '8'.repeat(64)
    const receipt = {
      version: '0.41.0',
      packageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
      portableFingerprintSchema: 'npm-owned-package-surface-v1',
      executableSha256: files[0].sha256,
      executableSizeBytes: files[0].sizeBytes,
      npmPackage: {
        integrity: `sha512-${Buffer.from('registry-integrity').toString('base64')}`,
        ownedPackageSha256,
        ownedEntryCount: 3,
        ownedTotalBytes: 11,
        proofNodes: files,
      },
    }
    const expected = digest(JSON.stringify({
      schema: 'npm-owned-package-surface-v1',
      version: receipt.version,
      packageName: '@moonshot-ai/kimi-code',
      integrity: receipt.npmPackage.integrity,
      executable: {
        relativePath: files[0].relativePath,
        sha256: files[0].sha256,
        sizeBytes: files[0].sizeBytes,
        executable: true,
      },
      ownedPackageSha256,
      ownedEntryCount: 3,
      ownedTotalBytes: 11,
    }))
    expect(portableArtifactFingerprint(receipt)).toBe(expected)

    const wrongExecutable = structuredClone(receipt)
    wrongExecutable.executableSha256 = '7'.repeat(64)
    expect(() => portableArtifactFingerprint(wrongExecutable)).toThrow(/npm executable/)
  })

  it('rejects an accepted exact version without the complete immutable distribution artifact matrix', () => {
    const incompleteEntries = sourceContract.entries.map(entry => entry.catalogId === 'claude-code-cli'
      ? { ...entry, acceptedDistributionArtifacts: entry.acceptedDistributionArtifacts.slice(1) }
      : entry)
    expect(() => parseSourceAgentIntegrationReleaseContract(bundle({
      defaultEntries: frozenEntriesSource(incompleteEntries),
    })))
      .toThrow(/lack an exact distribution artifact receipt matrix/)
  })

  it('derives the package contract from the single source release manifest', () => {
    expect(sourceContract).toMatchObject({
      version: '0.2.92',
      schemaVersion: 4,
      customEnabled: true,
      customModes: ['nonstandard_config_root', 'manual_mcp_client'],
    })
    expect(sourceContract.entries).toHaveLength(20)
  })

  it('requires the Pi native lifecycle runtime in every packaged app', () => {
    expect(AGENT_RUNTIME_BUNDLES).toContain('hook-pi-lifecycle.cjs')
  })

  it('requires the privacy-preserving Windsurf lifecycle runtime in every packaged app', () => {
    expect(AGENT_RUNTIME_BUNDLES).toContain('hook-windsurf-lifecycle.cjs')
  })

  it('requires the OpenClaw native Plugin lifecycle runtime in every packaged app', () => {
    expect(AGENT_RUNTIME_BUNDLES).toContain('hook-openclaw-lifecycle.cjs')
  })

  it('requires the QwenWork lifecycle runtime in every packaged app', () => {
    expect(AGENT_RUNTIME_BUNDLES).toContain('hook-qwenwork-lifecycle.cjs')
  })

  it('requires the complete Gemini Extension runtime in every packaged app', () => {
    expect(AGENT_RUNTIME_BUNDLES).toContain('hook-session-start.cjs')
    expect(AGENT_RUNTIME_BUNDLES).toContain('mcp-server.cjs')
  })

  it('requires the silent Kimi SessionStart activity runtime in every packaged app', () => {
    expect(AGENT_RUNTIME_BUNDLES).toContain('hook-kimi-session-start-activity.cjs')
  })

  it('pins packaged macOS releases to the Tide Mind Developer ID Team', () => {
    const verifier = fs.readFileSync(path.resolve('scripts/verify-mac-release-assets.mjs'), 'utf8')
    expect(verifier).toContain('TIDEMIND_RELEASE_TEAM_ID')
    expect(verifier).toContain("startsWith('Developer ID Application:')")
  })

  it('blocks a formal package when a synthetic production contract lacks a frozen exact candidate', () => {
    const incomplete = {
      ...sourceContract,
      entries: sourceContract.entries.map((entry, index) => index === 0
        ? { ...entry, releaseAcceptedExactVersions: [], acceptedDistributionArtifacts: [] }
        : entry),
    }
    expect(() => assertAgentIntegrationReleaseAcceptance(incomplete))
      .toThrow(/acceptance is incomplete.*claude-code-cli/u)
    expect(() => assertAgentIntegrationReleaseAcceptance(sourceContract)).not.toThrow()
    expect(() => assertAgentIntegrationReleaseAcceptance({
      ...sourceContract,
      entries: sourceContract.entries.map((entry, index) => index === 0
        ? { ...entry, releaseAcceptedExactVersions: ['not-observed'] }
        : entry),
    })).toThrow(/acceptance is incomplete.*claude-code-cli/u)
  })

  it('accepts a versioned, non-empty manifest bound to production', () => {
    expect(inspectPackagedAgentIntegrationReleaseManifest(bundle(), sourceContract)).toEqual({
      version: '0.2.92',
      schemaVersion: 4,
      entryCount: 20,
      defaultEntryCount: 19,
    })
  })

  it('keeps nested template text masked before a real bundled manifest', () => {
    const marker = 'AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION ='
    const prefix = 'const earlier = `outer ${(() => `inner "quote ${"x"}`)()}`;\n'
    expect(codeMarkerCount(prefix, marker)).toBe(0)
    expect(codeMarkerCount(prefix + bundle(), marker)).toBe(1)
    expect(inspectPackagedAgentIntegrationReleaseManifest(prefix + bundle(), sourceContract).entryCount).toBe(20)
  })

  it('accepts data-only JavaScript literals after bundling without executing expressions', () => {
    const emitted = bundle().replace('catalogId as never', 'catalogId')
      .replace('"releaseMode":"production"', '"releaseMode":\'production\'')
    expect(inspectPackagedAgentIntegrationReleaseManifest(emitted, sourceContract).entryCount).toBe(20)
    const executable = bundle().replace('"releaseMode":"production"', '"releaseMode":invokeReleaseMode()')
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(executable, sourceContract))
      .toThrow(/invalid claude-code-cli details/u)
    const duplicate = bundle().replace('"releaseMode":"production"', '"releaseMode":\'production\',"releaseMode":"production"')
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(duplicate, sourceContract))
      .toThrow(/invalid claude-code-cli details/u)
  })

  it('rejects version/schema drift and an empty default surface', () => {
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ version: '0.2.91' }),
      sourceContract,
    )).toThrow(/version 0\.2\.91 does not match app 0\.2\.92/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ schemaVersion: 1 }),
      sourceContract,
    )).toThrow(/schema 1 does not match source schema 4/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ defaultEntries: 'observeOnly("zcode-cli", "diagnostic", {"components":[],"officialDistributions":[],"acceptedDistributionArtifacts":[],"observedExactVersions":[],"releaseAcceptedExactVersions":[],"activation":{"mode":"none","requiresUserConfirmation":false},"requiredLifecycle":null,"releaseMode":"detect_only"})' }),
      sourceContract,
    )).toThrow(/zero default-enabled entries/)
  })

  it('rejects a non-empty packaged manifest when any frozen entry or capability is missing or changed', () => {
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ defaultEntries: frozenEntriesSource().split('\n')[0] }),
      sourceContract,
    )).toThrow(/differs from the source release contract/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ defaultEntries: frozenEntriesSource().replace(
        'release("cursor-desktop", "managed", 4, ALL_COMPONENTS,',
        'release("cursor-desktop", "managed", 3, CORE_COMPONENTS,',
      ) }),
      sourceContract,
    )).toThrow(/differs from the source release contract/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ defaultEntries: frozenEntriesSource().replace(
        'Non-official same-named CLI; discovery diagnostics only.',
        'changed packaged note',
      ) }),
      sourceContract,
    )).toThrow(/differs from the source release contract/)
  })

  it('rejects a disabled Custom entry or a manifest not used by production', () => {
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ customEnabled: false }),
      sourceContract,
    )).toThrow(/manifest object has invalid fields or bindings/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ customModes: [...sourceContract.customModes, 'unexpected_mode'] }),
      sourceContract,
    )).toThrow(/differs from the source release contract/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle({ bindProductionPolicy: false }),
      sourceContract,
    )).toThrow(/production release-policy binding/)
  })

  it('validates the actual manifest object and production call instead of accepting decoy strings', () => {
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle().replace('customConfigRoot: { supported: false }, enabledByDefault: false, notes', 'customConfigRoot: { supported: false }, enabledByDefault: true, notes'),
      sourceContract,
    )).toThrow(/invalid observe-only helper binding/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle().replace('  entries: AGENT_INTEGRATION_RELEASE_ENTRIES\n', ''),
      sourceContract,
    )).toThrow(/manifest object has invalid fields or bindings/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle().replace(
        '  entries: AGENT_INTEGRATION_RELEASE_ENTRIES\n',
        '  unknownRootField: true,\n  entries: AGENT_INTEGRATION_RELEASE_ENTRIES\n',
      ),
      sourceContract,
    )).toThrow(/manifest object has invalid fields or bindings/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      `${bundle({ customEnabled: false })}\nconst customDecoy = "customLocalAgent: Object.freeze({ enabledByDefault: true,";`,
      sourceContract,
    )).toThrow(/manifest object has invalid fields or bindings/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      `${bundle({ bindProductionPolicy: false })}\nconst policyDecoy = "const releasePolicy = resolveAgentIntegrationReleasePolicy({";`,
      sourceContract,
    )).toThrow(/production release-policy binding/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      `${bundle({ bindProductionPolicy: false })}\nfunction unusedPolicyDecoy() { const releasePolicy = resolveAgentIntegrationReleasePolicy({}); return releasePolicy; }`,
      sourceContract,
    )).toThrow(/production release-policy binding/)
    expect(() => inspectPackagedAgentIntegrationReleaseManifest(
      bundle().replace(
        '  const observeOnly = releasePolicy.mode !== "active";',
        '  return legacyEnvironmentGate({});\n  const observeOnly = releasePolicy.mode !== "active";',
      ),
      sourceContract,
    )).toThrow(/legacy policy bypass/)
  })
})
