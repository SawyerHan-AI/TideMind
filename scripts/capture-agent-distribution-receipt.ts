#!/usr/bin/env node
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createInflateRaw } from 'node:zlib'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  inspectPassiveCliVersion,
  inspectPassiveCliVersionForArchitecture,
  kimiNativeExecutablePortableArtifactFingerprint,
  normalizedOpenClawWrapperBytes,
  normalizedQwenLauncherBytes,
  readStableFileFingerprint,
  readStableFileMetadata,
  readStableFileSnapshot,
  readStablePackageTree,
  verifyStablePackageTree,
} from '../client/electron/agent-integration/passive-cli-version.js'
import {
  inspectStableDesktopBundleSurface,
  signedCodePortableArtifactFingerprint,
  signedKimiPortableArtifactFingerprint,
  type AppCodeSignatureResult,
  type DiscoveryDependencies,
  type PackageMetadataProofNode,
} from '../client/electron/agent-integration/discovery.js'
import { inspectMacAppSignature } from '../client/electron/agent-integration/mac-code-signature.js'
import { readStableDistributionTree } from '../client/electron/agent-integration/distribution-artifact.js'
import {
  npmComposedDistributionSpec,
  type NpmComposedComponentSpec,
  type NpmComposedDistributionSpec,
} from '../client/electron/agent-integration/npm-distribution-topology.js'
// The release parser deliberately remains executable JavaScript so the release
// gate does not depend on a TypeScript runtime.
// @ts-expect-error no declaration file is emitted for this release-only module
import {
  parseSourceAgentIntegrationReleaseContract,
  portableArtifactFingerprint,
} from './agent-integration-release-contract.mjs'
// @ts-expect-error no declaration file is emitted for this release-only module
import { distributionArtifactReceiptSha256 } from './verify-agent-integration-host-acceptance.mjs'

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_LISTING_BYTES = 16 * 1024 * 1024
const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024
const MAX_ZIP_EOCD_BYTES = 22 + 0xffff
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MAX_ZIP_COMPRESSION_RATIO = 200
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP_UTF8_FLAG = 0x0800
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008
const ZIP_ENCRYPTED_FLAG = 0x0001
const ZIP_DEFLATE_OPTION_FLAGS = 0x0006
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
const SHA256 = /^[a-f0-9]{64}$/u
const INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/u
const ARCHITECTURES = new Set(['arm64', 'x64'])
export const ANTHROPIC_RELEASE_SIGNING_FINGERPRINT = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE'
const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = 103
const GPG_AGENT_SOCKET_NAMES = [
  'S.gpg-agent',
  'S.gpg-agent.extra',
  'S.gpg-agent.browser',
  'S.gpg-agent.ssh',
] as const

type Architecture = 'arm64' | 'x64'
type ReceiptKind = 'npm-tarball' | 'signed-app' | 'signed-cli' | 'qwen-standalone' | 'openclaw-portable'

interface ReleaseDistribution {
  channel: 'npm' | 'signed_app' | 'signed_cli'
  distributionId: string
  packageProvenance: string
  supportedMacArchitectures: readonly Architecture[]
}

interface ReleaseTarget {
  catalogId: string
  observedExactVersions: readonly string[]
  officialDistributions: readonly ReleaseDistribution[]
}

interface ReceiptProofNode {
  role: string
  relativePath: string
  sha256: string
  sizeBytes: number
  executable: boolean
  normalization: 'raw' | 'openclaw_prefix_template_v1' | 'qwen_relative_root_v1'
}

interface Receipt {
  distributionId: string
  packageProvenance: string
  version: string
  architecture: Architecture
  artifactSha256: string
  artifactSizeBytes: number
  executableSha256: string
  executableSizeBytes: number
  distributionSha256: string
  distributionSizeBytes: number
  portableFingerprintSchema: string
  portableArtifactFingerprint: string
  signedCode: {
    identifier: string
    teamIdentifier: string
    cdhash: string
    designatedRequirement: string
  } | null
  npmPackage: {
    integrity: string | null
    ownedPackageSha256: string
    ownedEntryCount: number
    ownedTotalBytes: number
    proofNodes: readonly ReceiptProofNode[]
    composition?: {
      entryRule: string
      components: readonly {
        role: string
        installName: string
        manifestName: string
        version: string
        integrity: string
        artifactSha256: string
        artifactSizeBytes: number
        ownedPackageSha256: string
        ownedEntryCount: number
        ownedTotalBytes: number
        nativeExecutableRelativePath: string | null
        nativeExecutableSha256: string | null
        nativeExecutableSizeBytes: number | null
      }[]
    }
  } | null
}

export interface NpmComponentInput {
  installName: string
  registryMetadataPath: string
  tarballPath: string
}

export interface GenerateReceiptOptions {
  kind: ReceiptKind
  catalogId: string
  distributionId: string
  version: string
  architecture: Architecture
  artifactPath: string
  sourceUrl: string
  releaseManifestPath?: string
  registryMetadataPath?: string
  npmTarballPath?: string
  memberPath?: string
  archiveFormat?: 'auto' | 'tgz' | 'zip' | 'dmg' | 'raw'
  binName?: string
  npmComponents?: readonly NpmComponentInput[]
  kimiArtifactChecksumPath?: string
  kimiReleaseManifestPath?: string
  kimiGitHubReleaseMetadataPath?: string
  signedCliManifestPath?: string
  signedCliManifestSignaturePath?: string
  signedCliSigningKeyPath?: string
  openclawTagRefMetadataPath?: string
  openclawTagObjectMetadataPath?: string
  openclawNodeArtifactPath?: string
  openclawNodeSourceUrl?: string
  openclawNodeShasumsPath?: string
  openclawNodeShasumsSourceUrl?: string
  outputPath?: string
}

export interface GeneratorDependencies {
  inspectSignature(codeObjectPath: string): Promise<AppCodeSignatureResult>
  assertArchitecture(executablePath: string, architecture: Architecture): void
  verifyClaudeManifestSignature(
    manifestPath: string,
    signaturePath: string,
    signingKeyPath: string,
    tempRoot: string,
  ): Promise<string>
  kimiReleaseAuthority(version: string, architecture: Architecture): KimiReleaseAuthority | null
  openclawReleaseAuthority(version: string, architecture: Architecture): OpenClawReleaseAuthority | null
}

interface KimiReleaseAssetAuthority {
  id: number
  name: string
  url: string
  sizeBytes: number
  sha256: string
}

interface KimiReleaseAuthority {
  releaseId: number
  manifest: KimiReleaseAssetAuthority
  archive: KimiReleaseAssetAuthority
  checksum: KimiReleaseAssetAuthority
}

interface OpenClawReleaseAuthority {
  tag: string
  tagObjectSha: string
  commitSha: string
  installerUrl: string
  installerSha256: string
  installerSizeBytes: number
  nodeVersion: string
  nodeArchiveName: string
  nodeArchiveUrl: string
  nodeArchiveSha256: string
  nodeShasumsUrl: string
  npmTarballUrl: string
  npmIntegrity: string
  npmArtifactSha256: string
  npmArtifactSizeBytes: number
  lifecycleMarkerSha256: string
  lifecycleContractSha256: string
  postinstallScriptSha256: string
  postinstallInventorySha256: string
}

interface OpenClawLifecycleEvidence {
  schema: 'openclaw-static-postinstall-v1'
  markerRemoved: '.openclaw-lifecycle-pending'
  inventoryEntryCount: number
  rawOwnedPackageSha256: string
  postinstallOwnedPackageSha256: string
  postinstallOwnedEntryCount: number
  postinstallOwnedTotalBytes: number
}

const KIMI_0_41_0_ASSET_ROOT = 'https://github.com/MoonshotAI/kimi-code/releases/download/%40moonshot-ai/kimi-code%400.41.0'
const KIMI_0_41_0_MANIFEST: KimiReleaseAssetAuthority = {
  id: 544227135,
  name: 'manifest.json',
  url: `${KIMI_0_41_0_ASSET_ROOT}/manifest.json`,
  sizeBytes: 2_023,
  sha256: 'd1e61a4f99ee657f44f279b713dc289daadeb28f8eda6be1b3a691f7f4eb621d',
}

function productionKimiReleaseAuthority(
  version: string,
  architecture: Architecture,
): KimiReleaseAuthority | null {
  if (version !== '0.41.0') return null
  const architectureAssets = architecture === 'arm64'
    ? {
        archive: {
          id: 544226946, name: 'kimi-code-darwin-arm64.zip',
          url: `${KIMI_0_41_0_ASSET_ROOT}/kimi-code-darwin-arm64.zip`, sizeBytes: 61_572_356,
          sha256: 'e7d32a5e261f40e3034c34026116f458e486d8f13d7d72ca6edcf29290c51d1a',
        },
        checksum: {
          id: 544226949, name: 'kimi-code-darwin-arm64.zip.sha256',
          url: `${KIMI_0_41_0_ASSET_ROOT}/kimi-code-darwin-arm64.zip.sha256`, sizeBytes: 93,
          sha256: '901953f200f65aea622ae911ea1000006248f2ff2b879a10f613a29e6945b80b',
        },
      }
    : {
        archive: {
          id: 544226964, name: 'kimi-code-darwin-x64.zip',
          url: `${KIMI_0_41_0_ASSET_ROOT}/kimi-code-darwin-x64.zip`, sizeBytes: 62_615_094,
          sha256: '399c60613ed939ccd0d7f8f24f77209a5e6cc1fba5a8d0fe4f5dabeae51710c9',
        },
        checksum: {
          id: 544226973, name: 'kimi-code-darwin-x64.zip.sha256',
          url: `${KIMI_0_41_0_ASSET_ROOT}/kimi-code-darwin-x64.zip.sha256`, sizeBytes: 91,
          sha256: '8735818cbece52a9122e16e2efb81242cc3caebdb7576ff617fa8e53ceeb0537',
        },
      }
  return {
    releaseId: 382659724,
    manifest: KIMI_0_41_0_MANIFEST,
    ...architectureAssets,
  }
}

const OPENCLAW_2026_9_1_COMMIT = 'ad6fe23aecb9b833d68139b0ddc9f239b894d2f1'
const OPENCLAW_2026_9_1_NODE_VERSION = '24.19.0'

function productionOpenClawReleaseAuthority(
  version: string,
  architecture: Architecture,
): OpenClawReleaseAuthority | null {
  if (version !== '2026.9.1') return null
  const nodeArchitecture = architecture === 'arm64' ? 'arm64' : 'x64'
  const nodeArchiveName = `node-v${OPENCLAW_2026_9_1_NODE_VERSION}-darwin-${nodeArchitecture}.tar.gz`
  return {
    tag: 'v2026.9.1',
    tagObjectSha: '74be8c0d44623711fde78c70bc40f5a633dc4f56',
    commitSha: OPENCLAW_2026_9_1_COMMIT,
    installerUrl: `https://raw.githubusercontent.com/openclaw/openclaw/${OPENCLAW_2026_9_1_COMMIT}/scripts/install-cli.sh`,
    installerSha256: '1a0f57d05eff9e9aa2eaec8016ae87b5c9a74dcbff651a323baa29feaf1dfdbb',
    installerSizeBytes: 60_526,
    nodeVersion: OPENCLAW_2026_9_1_NODE_VERSION,
    nodeArchiveName,
    nodeArchiveUrl: `https://nodejs.org/dist/v${OPENCLAW_2026_9_1_NODE_VERSION}/${nodeArchiveName}`,
    nodeArchiveSha256: architecture === 'arm64'
      ? '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d'
      : 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
    nodeShasumsUrl: `https://nodejs.org/dist/v${OPENCLAW_2026_9_1_NODE_VERSION}/SHASUMS256.txt`,
    npmTarballUrl: 'https://registry.npmjs.org/openclaw/-/openclaw-2026.9.1.tgz',
    npmIntegrity: 'sha512-0Ve0631CdgkJDwd4NNG1BawIdF5yCL2sO+Tts8amStw+H6vKURTj0K4rOa4+hFpJk1Dnw5LyKl5twzwX1VtA2w==',
    npmArtifactSha256: '1bfcac877d53f1e41b69d15c24e081895b2f07d6ff2ffdfe0bf8a7336ab00e59',
    npmArtifactSizeBytes: 55_564_082,
    lifecycleMarkerSha256: '52d26753462488ad21852bc6718e21b84835f53765304d0a1e1b89d05a2a71b1',
    lifecycleContractSha256: '32c50197ecc6f10b78f9f8ef588b868e7cdf428233e00fb912044dee5da46e1a',
    postinstallScriptSha256: '91b18605d3c3e7493099172fe8658c363235c2b68bc10642dd85b1f470c4e0fe',
    postinstallInventorySha256: '397d094e147ea2c39b05e02209cca8864504d123a3c580e807122b4d6c471f07',
  }
}

const productionDependencies: GeneratorDependencies = {
  inspectSignature: codeObjectPath => inspectMacAppSignature(codeObjectPath, { timeoutMs: 30_000 }),
  assertArchitecture: assertMachOArchitecture,
  verifyClaudeManifestSignature: verifyAnthropicManifestSignature,
  kimiReleaseAuthority: productionKimiReleaseAuthority,
  openclawReleaseAuthority: productionOpenClawReleaseAuthority,
}

export async function generateAgentDistributionReceipt(
  options: GenerateReceiptOptions,
  dependencies: GeneratorDependencies = productionDependencies,
): Promise<Record<string, unknown>> {
  validateOptions(options)
  const releaseManifestPath = path.resolve(options.releaseManifestPath
    ?? path.join(import.meta.dirname, '..', 'client', 'electron', 'agent-integration', 'release-manifest.ts'))
  const releaseSource = await fs.readFile(releaseManifestPath, 'utf8')
  const releaseContract = parseSourceAgentIntegrationReleaseContract(releaseSource) as { entries: ReleaseTarget[] }
  const { target, distribution } = exactReleaseDistribution(releaseContract.entries, options)
  const sourceUrl = exactHttpsUrl(options.sourceUrl)
  const artifact = await inspectArtifact(options.artifactPath)
  const requestedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tidemind-agent-receipt-'))
  const tempRoot = path.resolve(await fs.realpath(requestedTempRoot))
  await fs.chmod(tempRoot, 0o700)
  let mounted: (() => void) | undefined
  try {
    let generated: { receipt: Receipt; extraSourceEvidence?: Record<string, unknown> }
    if (options.kind === 'npm-tarball') {
      generated = await generateNpmTarballReceipt(options, distribution, artifact, tempRoot, dependencies)
    } else if (options.kind === 'qwen-standalone') {
      generated = await generateQwenStandaloneReceipt(options, distribution, artifact, tempRoot, dependencies)
    } else if (options.kind === 'openclaw-portable') {
      generated = await generateOpenClawPortableReceipt(options, distribution, artifact, tempRoot, dependencies)
    } else {
      const prepared = await prepareSignedArtifact(options, artifact, tempRoot)
      mounted = prepared.cleanup
      generated = await generateSignedReceipt(options, target, distribution, artifact, prepared.root, dependencies)
    }
    const after = await inspectArtifact(options.artifactPath)
    assertReceiptArtifactUnchanged(artifact, after)
    const receiptSha256 = distributionArtifactReceiptSha256(generated.receipt) as string
    if (!SHA256.test(receiptSha256)) throw new Error('receipt_digest_invalid')
    const envelope = {
      schemaVersion: 1,
      receipt: generated.receipt,
      receiptSha256,
      sourceEvidence: {
        schema: 'agent-distribution-source-v1',
        catalogId: options.catalogId,
        distributionId: options.distributionId,
        version: options.version,
        architecture: options.architecture,
        sourceUrl,
        artifact: {
          name: path.basename(artifact.path),
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        },
        releaseManifestSha256: createHash('sha256').update(releaseSource).digest('hex'),
        ...generated.extraSourceEvidence,
      },
    }
    if (options.outputPath) await writeExclusiveJson(options.outputPath, envelope)
    return envelope
  } finally {
    try {
      mounted?.()
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  }
}

async function generateNpmTarballReceipt(
  options: GenerateReceiptOptions,
  distribution: ReleaseDistribution,
  artifact: Awaited<ReturnType<typeof inspectArtifact>>,
  tempRoot: string,
  dependencies: GeneratorDependencies,
): Promise<{ receipt: Receipt; extraSourceEvidence: Record<string, unknown> }> {
  if (distribution.channel !== 'npm') throw new Error('receipt_kind_does_not_match_release_channel')
  if (!options.registryMetadataPath || !options.binName) {
    throw new Error('npm_receipt_requires_registry_metadata_and_bin_name')
  }
  const registry = await verifiedRegistryMetadata(
    options.registryMetadataPath,
    expectedNpmPackage(distribution),
    options.version,
    options.sourceUrl,
    artifact.path,
  )
  let openclawAuthority: OpenClawReleaseAuthority | null = null
  if (options.catalogId === 'openclaw-local' && options.distributionId === 'cli:openclaw-local:npm-global') {
    openclawAuthority = dependencies.openclawReleaseAuthority(options.version, options.architecture)
    if (!openclawAuthority) throw new Error('openclaw_release_authority_not_frozen')
    if (registry.tarballUrl !== openclawAuthority.npmTarballUrl
      || registry.integrity !== openclawAuthority.npmIntegrity
      || artifact.sha256 !== openclawAuthority.npmArtifactSha256
      || artifact.sizeBytes !== openclawAuthority.npmArtifactSizeBytes) {
      throw new Error('openclaw_npm_release_artifact_mismatch')
    }
  }
  const staging = await stageNpmTarball(artifact.path, tempRoot, expectedNpmPackage(distribution), registry.integrity)
  // The official entrypoint completes this lifecycle before even --version.
  // Freeze the validated postinstall tree, matching the portable channel;
  // do not execute upstream scripts or let registry metadata self-authorize it.
  const openclawLifecycle = openclawAuthority
    ? await staticallyCompleteOpenClawPackageLifecycle(staging.packageRoot, openclawAuthority)
    : undefined
  const compositionSpec = npmComposedDistributionSpec(
    expectedNpmPackage(distribution), options.version, options.architecture,
    options.distributionId.endsWith(':darwin-x64-baseline') ? 'baseline' : 'modern',
  )
  const componentArtifacts: Array<{
    spec: NpmComposedComponentSpec
    packageRoot: string
    installName: string
    artifact: Awaited<ReturnType<typeof inspectArtifact>>
    registry: Awaited<ReturnType<typeof verifiedRegistryMetadata>>
  }> = []
  if (compositionSpec) {
    const inputs = options.npmComponents ?? []
    if (inputs.length !== compositionSpec.components.length
      || new Set(inputs.map(input => input.installName)).size !== inputs.length) {
      throw new Error('npm_composed_receipt_requires_exact_component_inputs')
    }
    for (const component of compositionSpec.components) {
      const input = inputs.find(candidate => candidate.installName === component.installName)
      if (!input) throw new Error('npm_composed_receipt_missing_component')
      const componentArtifact = await inspectArtifact(input.tarballPath)
      const componentRegistry = await verifiedRegistryMetadata(
        input.registryMetadataPath,
        component.manifestName,
        component.version,
        undefined,
        componentArtifact.path,
      )
      const componentStage = await stageNpmTarball(
        componentArtifact.path,
        tempRoot,
        component.manifestName,
        componentRegistry.integrity,
        component.installName,
      )
      if (component.role === 'platform_leaf' && component.nativeExecutableRelativePath) {
        dependencies.assertArchitecture(
          path.join(componentStage.packageRoot, ...component.nativeExecutableRelativePath.split('/')),
          options.architecture,
        )
      }
      componentArtifacts.push({
        spec: component,
        packageRoot: componentStage.packageRoot,
        installName: component.installName,
        artifact: componentArtifact,
        registry: componentRegistry,
      })
    }
  } else if ((options.npmComponents?.length ?? 0) > 0) {
    throw new Error('npm_pure_js_receipt_rejects_component_inputs')
  }
  const executablePath = staging.executableForBin(options.binName)
  if (compositionSpec?.entryRule === 'copy_platform_binary_v1') {
    await materializeCopiedPlatformBinary(
      staging.packageRoot, executablePath, compositionSpec, componentArtifacts,
    )
  }
  const result = await inspectPassiveCliVersionForArchitecture(
    executablePath, passiveFileSystem(), options.architecture,
  )
  if (result.exitCode !== 0 || result.stdout !== options.version
    || result.verifiedPackageProvenance !== distribution.packageProvenance
    || !result.portableArtifactFingerprint || !result.packageTreeSha256 || !result.packageProofNodes
    || Boolean(compositionSpec) !== Boolean(result.npmComposition)) {
    throw new Error('npm_tarball_does_not_produce_release_runtime_identity')
  }
  const treeNodes = packageTreeNodes(result.packageProofNodes, staging.packageRoot)
  const rootTree = await readStablePackageTree(staging.packageRoot)
  if (openclawLifecycle && (rootTree.packageTreeSha256 !== openclawLifecycle.postinstallOwnedPackageSha256
    || result.packageTreeSha256 !== openclawLifecycle.postinstallOwnedPackageSha256)) {
    throw new Error('openclaw_static_postinstall_tree_mismatch')
  }
  const critical = treeNodes
    .filter(node => node.role === 'package_manifest' || node.role === 'npm_package_executable')
    .map(node => receiptProofNode(node, staging.packageRoot, 'raw'))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  if (critical.filter(node => node.role === 'package_manifest').length !== 1
    || critical.filter(node => node.role === 'npm_package_executable').length !== 1) {
    throw new Error('npm_tarball_has_ambiguous_manifest_or_executable')
  }
  const executable = critical.find(node => node.role === 'npm_package_executable')!
  const composition = result.npmComposition && {
    entryRule: result.npmComposition.entryRule,
    components: result.npmComposition.components.map(component => {
      const source = componentArtifacts.find(candidate => candidate.installName === component.installName)
      if (!source) throw new Error('npm_composed_component_source_evidence_missing')
      return {
        ...component,
        artifactSha256: source.artifact.sha256,
        artifactSizeBytes: source.artifact.sizeBytes,
      }
    }),
  }
  const receipt = finalizeReceipt({
    distribution,
    options,
    artifact,
    executable,
    distributionSha256: result.packageTreeSha256,
    distributionSizeBytes: treeNodes.reduce((sum, node) => sum + node.size, 0)
      + (result.npmComposition?.components.reduce((sum, component) => sum + component.ownedTotalBytes, 0) ?? 0),
    portableFingerprintSchema: composition ? 'npm-composed-platform-surface-v1' : 'npm-owned-package-surface-v1',
    signedCode: null,
    npmPackage: {
      integrity: registry.integrity,
      ownedPackageSha256: rootTree.packageTreeSha256,
      ownedEntryCount: rootTree.ownedEntryCount,
      ownedTotalBytes: rootTree.ownedTotalBytes,
      proofNodes: critical,
      ...(composition ? { composition } : {}),
    },
  }, result.portableArtifactFingerprint)
  for (const component of componentArtifacts) {
    const after = await inspectArtifact(component.artifact.path)
    if (after.physicalFingerprint !== component.artifact.physicalFingerprint) {
      throw new Error('npm_component_tarball_changed_during_receipt_generation')
    }
  }
  return {
    receipt,
    extraSourceEvidence: {
      npmRegistry: {
        packageName: registry.packageName,
        tarballUrl: registry.tarballUrl,
        integrity: registry.integrity,
        metadataSha256: registry.metadataSha256,
      },
      ...(openclawLifecycle ? {
        openclawPackageLifecycle: {
          authority: 'openclaw-2026.9.1-code-frozen',
          ...openclawLifecycle,
        },
      } : {}),
      ...(composition ? {
        npmComposition: componentArtifacts.map(component => ({
          packageName: component.registry.packageName,
          installName: component.installName,
          version: composition.components.find(candidate => candidate.installName === component.installName)?.version,
          tarballUrl: component.registry.tarballUrl,
          integrity: component.registry.integrity,
          metadataSha256: component.registry.metadataSha256,
          artifactSha256: component.artifact.sha256,
          artifactSizeBytes: component.artifact.sizeBytes,
        })),
      } : {}),
    },
  }
}

async function generateQwenStandaloneReceipt(
  options: GenerateReceiptOptions,
  distribution: ReleaseDistribution,
  artifact: Awaited<ReturnType<typeof inspectArtifact>>,
  tempRoot: string,
  dependencies: GeneratorDependencies,
): Promise<{ receipt: Receipt }> {
  if (distribution.channel !== 'npm' || distribution.distributionId !== 'cli:qwen-code-cli:standalone') {
    throw new Error('receipt_kind_does_not_match_release_channel')
  }
  const root = await extractArchive(artifact.path, options.archiveFormat ?? 'auto', path.join(tempRoot, 'qwen'))
  const prefix = exactMember(root, options.memberPath ?? '.')
  await readStableDistributionTree(prefix)
  const executablePath = path.join(prefix, 'bin', 'qwen')
  const result = await inspectPassiveCliVersionForArchitecture(
    executablePath,
    passiveFileSystem(),
    options.architecture,
  )
  if (result.exitCode !== 0 || result.stdout !== options.version
    || result.verifiedPackageProvenance !== distribution.packageProvenance
    || !result.portableArtifactFingerprint || !result.packageTreeSha256 || !result.packageProofNodes) {
    throw new Error('qwen_standalone_does_not_produce_release_runtime_identity')
  }
  const launcher = result.packageProofNodes.find(node => node.role === 'qwen_launcher')
  const packageNodes = result.packageProofNodes.filter(node => node.entryType !== undefined)
  const roles = ['package_manifest', 'qwen_standalone_manifest', 'qwen_cli_entry', 'qwen_node_runtime']
  const selected = roles.map(role => packageNodes.find(node => node.role === role))
  if (!launcher || selected.some(node => !node)) throw new Error('qwen_standalone_proof_incomplete')
  dependencies.assertArchitecture(selected.find(node => node?.role === 'qwen_node_runtime')!.path, options.architecture)
  const normalized = normalizedQwenLauncherBytes()
  const proofNodes = [
    {
      role: 'qwen_launcher', relativePath: 'bin/qwen',
      sha256: createHash('sha256').update(normalized).digest('hex'),
      sizeBytes: normalized.length, executable: true, normalization: 'qwen_relative_root_v1' as const,
    },
    ...selected.map(node => receiptProofNode(node!, prefix, 'raw')),
  ]
  const treeNodes = packageTreeNodes(packageNodes, prefix)
  const receipt = finalizeReceipt({
    distribution,
    options,
    artifact,
    executable: proofNodes[0]!,
    distributionSha256: result.packageTreeSha256,
    distributionSizeBytes: treeNodes.reduce((sum, node) => sum + node.size, 0),
    portableFingerprintSchema: 'qwen-standalone-surface-v1',
    signedCode: null,
    npmPackage: {
      integrity: null,
      ownedPackageSha256: result.packageTreeSha256,
      ownedEntryCount: treeNodes.length,
      ownedTotalBytes: treeNodes.reduce((sum, node) => sum + node.size, 0),
      proofNodes,
    },
  }, result.portableArtifactFingerprint)
  return { receipt }
}

async function generateOpenClawPortableReceipt(
  options: GenerateReceiptOptions,
  distribution: ReleaseDistribution,
  artifact: Awaited<ReturnType<typeof inspectArtifact>>,
  tempRoot: string,
  dependencies: GeneratorDependencies,
): Promise<{ receipt: Receipt; extraSourceEvidence: Record<string, unknown> }> {
  if (distribution.channel !== 'npm' || distribution.distributionId !== 'cli:openclaw-local:portable-wrapper') {
    throw new Error('receipt_kind_does_not_match_release_channel')
  }
  if (options.memberPath || options.archiveFormat) {
    throw new Error('openclaw_portable_rejects_complete_prefix_archive')
  }
  if (!options.registryMetadataPath || !options.npmTarballPath
    || !options.openclawTagRefMetadataPath || !options.openclawTagObjectMetadataPath
    || !options.openclawNodeArtifactPath || !options.openclawNodeSourceUrl
    || !options.openclawNodeShasumsPath || !options.openclawNodeShasumsSourceUrl) {
    throw new Error('openclaw_portable_requires_exact_composition_inputs')
  }
  const authority = dependencies.openclawReleaseAuthority(options.version, options.architecture)
  if (!authority) throw new Error('openclaw_release_authority_not_frozen')
  const releaseEvidence = await verifiedOpenClawReleaseEvidence(options, artifact, authority)

  const nodeArtifact = await inspectArtifact(options.openclawNodeArtifactPath)
  if (path.basename(nodeArtifact.path) !== authority.nodeArchiveName
    || exactHttpsUrl(options.openclawNodeSourceUrl) !== authority.nodeArchiveUrl
    || nodeArtifact.sha256 !== authority.nodeArchiveSha256) {
    throw new Error('openclaw_node_release_artifact_mismatch')
  }
  const nodeShasums = await inspectMetadataInput(options.openclawNodeShasumsPath, MAX_LISTING_BYTES)
  if (exactHttpsUrl(options.openclawNodeShasumsSourceUrl) !== authority.nodeShasumsUrl
    || !Buffer.from(nodeShasums.content).toString('utf8').split(/\r?\n/u)
      .some(line => line === `${authority.nodeArchiveSha256}  ${authority.nodeArchiveName}`)) {
    throw new Error('openclaw_node_shasums_mismatch')
  }

  const packageArtifact = await inspectArtifact(options.npmTarballPath)
  const registry = await verifiedRegistryMetadata(
    options.registryMetadataPath,
    'openclaw',
    options.version,
    undefined,
    packageArtifact.path,
  )
  if (registry.tarballUrl !== authority.npmTarballUrl
    || registry.integrity !== authority.npmIntegrity
    || packageArtifact.sha256 !== authority.npmArtifactSha256
    || packageArtifact.sizeBytes !== authority.npmArtifactSizeBytes) {
    throw new Error('openclaw_npm_release_artifact_mismatch')
  }
  const npmStage = await stageNpmTarball(packageArtifact.path, path.join(tempRoot, 'npm-proof'), 'openclaw', registry.integrity)
  const lifecycleEvidence = await staticallyCompleteOpenClawPackageLifecycle(npmStage.packageRoot, authority)
  const npmResult = await inspectPassiveCliVersion(npmStage.executableForBin('openclaw'), passiveFileSystem())
  if (!npmResult.packageTreeSha256 || !npmResult.packageProofNodes) throw new Error('openclaw_npm_tarball_unproven')
  if (npmResult.packageTreeSha256 !== lifecycleEvidence.postinstallOwnedPackageSha256) {
    throw new Error('openclaw_static_postinstall_tree_mismatch')
  }

  const prefix = path.join(tempRoot, 'openclaw-prefix')
  const toolchain = `node-v${authority.nodeVersion}`
  const toolchainRoot = path.join(prefix, 'tools', toolchain)
  const nodeArchiveRoot = await extractArchive(nodeArtifact.path, 'tgz', path.join(tempRoot, 'node-release'))
  const nodeReleaseRoot = exactMember(nodeArchiveRoot, authority.nodeArchiveName.replace(/\.tar\.gz$/u, ''))
  const sourceNode = path.join(nodeReleaseRoot, 'bin', 'node')
  const sourceNodeBefore = await readStableFileFingerprint(sourceNode, MAX_ARTIFACT_BYTES)
  if (!sourceNodeBefore.executable) throw new Error('openclaw_node_release_executable_invalid')
  dependencies.assertArchitecture(sourceNode, options.architecture)
  const installedNode = path.join(toolchainRoot, 'bin', 'node')
  await fs.mkdir(path.dirname(installedNode), { recursive: true, mode: 0o700 })
  await fs.copyFile(sourceNode, installedNode, fsSync.constants.COPYFILE_EXCL)
  await fs.chmod(installedNode, sourceNodeBefore.mode & 0o777)
  const sourceNodeAfter = await readStableFileFingerprint(sourceNode, MAX_ARTIFACT_BYTES)
  const installedNodeAfter = await readStableFileFingerprint(installedNode, MAX_ARTIFACT_BYTES)
  if (sourceNodeAfter.fingerprint !== sourceNodeBefore.fingerprint
    || installedNodeAfter.sha256 !== sourceNodeBefore.sha256
    || installedNodeAfter.size !== sourceNodeBefore.size
    || !installedNodeAfter.executable) throw new Error('openclaw_node_static_materialization_mismatch')

  const installedNodeModules = path.join(toolchainRoot, 'lib', 'node_modules')
  await fs.mkdir(installedNodeModules, { recursive: true, mode: 0o700 })
  const installedPackage = path.join(installedNodeModules, 'openclaw')
  await fs.rename(npmStage.packageRoot, installedPackage)
  await copyStableInputFile(
    await inspectArtifact(path.join(path.dirname(npmStage.packageRoot), '.package-lock.json')),
    path.join(installedNodeModules, '.package-lock.json'),
  )
  await fs.symlink(toolchain, path.join(prefix, 'tools', 'node'))
  const wrapperPath = path.join(prefix, 'bin', 'openclaw')
  await fs.mkdir(path.dirname(wrapperPath), { recursive: true, mode: 0o700 })
  const wrapperContent = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `exec "${path.join(prefix, 'tools', 'node', 'bin', 'node')}" "${path.join(installedPackage, 'dist', 'entry.js')}" "$@"`,
    '',
  ].join('\n')
  await fs.writeFile(wrapperPath, wrapperContent, { mode: 0o755, flag: 'wx' })

  const result = await inspectPassiveCliVersion(path.join(prefix, 'bin', 'openclaw'), passiveFileSystem())
  if (result.exitCode !== 0 || result.stdout !== options.version
    || result.verifiedPackageProvenance !== distribution.packageProvenance
    || !result.portableArtifactFingerprint || !result.packageTreeSha256 || !result.packageProofNodes) {
    throw new Error('openclaw_portable_does_not_produce_release_runtime_identity')
  }
  if (result.packageTreeSha256 !== npmResult.packageTreeSha256) {
    throw new Error('openclaw_portable_owned_package_differs_from_official_npm_tarball')
  }
  const wrapper = result.packageProofNodes.find(node => node.role === 'openclaw_wrapper')
  const node = result.packageProofNodes.find(candidate => candidate.role === 'openclaw_node_runtime')
  const entry = result.packageProofNodes.find(candidate => candidate.role === 'openclaw_entry')
  const manifest = result.packageProofNodes.find(candidate => candidate.role === 'package_manifest')
  if (!wrapper || !node || !entry || !manifest) throw new Error('openclaw_portable_proof_incomplete')
  dependencies.assertArchitecture(node.path, options.architecture)
  const nodeRelative = path.relative(prefix, node.path).split(path.sep).join('/')
  if (nodeRelative !== `tools/${toolchain}/bin/node`) throw new Error('openclaw_portable_toolchain_path_invalid')
  const normalized = normalizedOpenClawWrapperBytes(toolchain)
  const proofNodes: ReceiptProofNode[] = [
    {
      role: 'openclaw_wrapper', relativePath: 'bin/openclaw',
      sha256: createHash('sha256').update(normalized).digest('hex'),
      sizeBytes: normalized.length, executable: true, normalization: 'openclaw_prefix_template_v1',
    },
    receiptProofNode(node, prefix, 'raw'),
    ...[entry, manifest]
      .map(candidate => receiptProofNode(candidate, prefix, 'raw'))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  ]
  const packageRoot = path.dirname(manifest.path)
  const packageNodes = packageTreeNodes(result.packageProofNodes, packageRoot)
  const ownedTotalBytes = packageNodes.reduce((sum, candidate) => sum + candidate.size, 0)
  const receipt = finalizeReceipt({
    distribution,
    options,
    artifact,
    executable: proofNodes[0]!,
    distributionSha256: result.packageTreeSha256,
    distributionSizeBytes: ownedTotalBytes,
    portableFingerprintSchema: 'openclaw-official-wrapper-v1',
    signedCode: null,
    npmPackage: {
      integrity: registry.integrity,
      ownedPackageSha256: result.packageTreeSha256,
      ownedEntryCount: packageNodes.length,
      ownedTotalBytes,
      proofNodes,
    },
  }, result.portableArtifactFingerprint)
  const packageAfter = await inspectArtifact(options.npmTarballPath)
  if (packageAfter.physicalFingerprint !== packageArtifact.physicalFingerprint) {
    throw new Error('npm_tarball_changed_during_receipt_generation')
  }
  const nodeAfter = await inspectArtifact(options.openclawNodeArtifactPath)
  if (nodeAfter.physicalFingerprint !== nodeArtifact.physicalFingerprint) {
    throw new Error('openclaw_node_tarball_changed_during_receipt_generation')
  }
  return {
    receipt,
    extraSourceEvidence: {
      npmRegistry: {
        packageName: registry.packageName,
        tarballUrl: registry.tarballUrl,
        integrity: registry.integrity,
        metadataSha256: registry.metadataSha256,
        artifactSha256: packageArtifact.sha256,
        artifactSizeBytes: packageArtifact.sizeBytes,
        authority: 'openclaw-2026.9.1-code-frozen',
      },
      openclawPortableComposition: {
        ...releaseEvidence,
        materializationSchema: 'openclaw-portable-composition-v1',
        toolchain,
        wrapperNormalization: 'openclaw_prefix_template_v1',
        lifecycle: lifecycleEvidence,
        node: {
          version: authority.nodeVersion,
          archiveName: authority.nodeArchiveName,
          archiveUrl: authority.nodeArchiveUrl,
          archiveSha256: nodeArtifact.sha256,
          archiveSizeBytes: nodeArtifact.sizeBytes,
          shasumsUrl: authority.nodeShasumsUrl,
          shasumsSha256: nodeShasums.sha256,
        },
      },
    },
  }
}

async function verifiedOpenClawReleaseEvidence(
  options: GenerateReceiptOptions,
  installer: Awaited<ReturnType<typeof inspectArtifact>>,
  authority: OpenClawReleaseAuthority,
): Promise<Record<string, unknown>> {
  if (exactHttpsUrl(options.sourceUrl) !== authority.installerUrl
    || installer.sha256 !== authority.installerSha256
    || installer.sizeBytes !== authority.installerSizeBytes) {
    throw new Error('openclaw_installer_release_artifact_mismatch')
  }
  const installerSnapshot = await readStableFileSnapshot(installer.path, MAX_LISTING_BYTES)
  const installerSource = Buffer.from(installerSnapshot.content).toString('utf8')
  const expectedWrapperFragment = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'exec "${PREFIX}/tools/node/bin/node" "$(node_dir)/lib/node_modules/openclaw/dist/entry.js" "\\$@"',
  ].join('\n')
  if (!installerSource.includes(`DEFAULT_NODE_VERSION="${authority.nodeVersion}"`)
    || !installerSource.includes(expectedWrapperFragment)) {
    throw new Error('openclaw_installer_composition_contract_mismatch')
  }

  const tagRefInput = await inspectMetadataInput(options.openclawTagRefMetadataPath!, 256 * 1024)
  const tagObjectInput = await inspectMetadataInput(options.openclawTagObjectMetadataPath!, 256 * 1024)
  const tagRef = JSON.parse(Buffer.from(tagRefInput.content).toString('utf8')) as {
    ref?: unknown
    object?: { sha?: unknown; type?: unknown; url?: unknown }
  }
  const tagObject = JSON.parse(Buffer.from(tagObjectInput.content).toString('utf8')) as {
    sha?: unknown
    tag?: unknown
    object?: { sha?: unknown; type?: unknown; url?: unknown }
    verification?: { verified?: unknown; reason?: unknown; signature?: unknown; payload?: unknown; verified_at?: unknown }
  }
  const tagApiUrl = `https://api.github.com/repos/openclaw/openclaw/git/tags/${authority.tagObjectSha}`
  const commitApiUrl = `https://api.github.com/repos/openclaw/openclaw/git/commits/${authority.commitSha}`
  const expectedPayloadPrefix = `object ${authority.commitSha}\ntype commit\ntag ${authority.tag}\n`
  if (tagRef.ref !== `refs/tags/${authority.tag}`
    || tagRef.object?.sha !== authority.tagObjectSha || tagRef.object.type !== 'tag'
    || exactHttpsUrl(String(tagRef.object.url)) !== tagApiUrl
    || tagObject.sha !== authority.tagObjectSha || tagObject.tag !== authority.tag
    || tagObject.object?.sha !== authority.commitSha || tagObject.object.type !== 'commit'
    || exactHttpsUrl(String(tagObject.object.url)) !== commitApiUrl
    || tagObject.verification?.verified !== true || tagObject.verification.reason !== 'valid'
    || typeof tagObject.verification.signature !== 'string' || tagObject.verification.signature.length === 0
    || typeof tagObject.verification.payload !== 'string'
    || !tagObject.verification.payload.startsWith(expectedPayloadPrefix)
    || typeof tagObject.verification.verified_at !== 'string'
    || !Number.isFinite(Date.parse(tagObject.verification.verified_at))) {
    throw new Error('openclaw_tag_release_metadata_mismatch')
  }
  return {
    schema: 'openclaw-tagged-installer-composition-v1',
    repository: 'openclaw/openclaw',
    tag: authority.tag,
    tagObjectSha: authority.tagObjectSha,
    commitSha: authority.commitSha,
    tagRefMetadataSha256: tagRefInput.sha256,
    tagObjectMetadataSha256: tagObjectInput.sha256,
    installerUrl: authority.installerUrl,
    installerSha256: installer.sha256,
    installerSizeBytes: installer.sizeBytes,
  }
}

async function staticallyCompleteOpenClawPackageLifecycle(
  packageRoot: string,
  authority: OpenClawReleaseAuthority,
): Promise<OpenClawLifecycleEvidence> {
  const manifestPath = path.join(packageRoot, 'package.json')
  const markerPath = path.join(packageRoot, '.openclaw-lifecycle-pending')
  const contractPath = path.join(packageRoot, 'scripts', 'lib', 'package-lifecycle-marker.mjs')
  const postinstallPath = path.join(packageRoot, 'scripts', 'postinstall-bundled-plugins.mjs')
  const inventoryPath = path.join(packageRoot, 'dist', 'postinstall-inventory.json')
  const [manifest, marker, contract, postinstall, inventory] = await Promise.all([
    readStableFileSnapshot(manifestPath, 512 * 1024),
    readStableFileSnapshot(markerPath, 64),
    readStableFileSnapshot(contractPath, 64 * 1024),
    readStableFileSnapshot(postinstallPath, 512 * 1024),
    readStableFileSnapshot(inventoryPath, MAX_LISTING_BYTES),
  ])
  const parsedManifest = JSON.parse(Buffer.from(manifest.content).toString('utf8')) as {
    name?: unknown
    version?: unknown
    scripts?: { preinstall?: unknown; postinstall?: unknown }
  }
  if (parsedManifest.name !== 'openclaw' || parsedManifest.version !== '2026.9.1'
    || parsedManifest.scripts?.preinstall !== 'node scripts/preinstall-package-manager-warning.mjs'
    || parsedManifest.scripts.postinstall !== 'node scripts/postinstall-bundled-plugins.mjs'
    || marker.sha256 !== authority.lifecycleMarkerSha256
    || contract.sha256 !== authority.lifecycleContractSha256
    || postinstall.sha256 !== authority.postinstallScriptSha256
    || inventory.sha256 !== authority.postinstallInventorySha256) {
    throw new Error('openclaw_package_lifecycle_contract_mismatch')
  }

  const expectedDistFiles = JSON.parse(Buffer.from(inventory.content).toString('utf8')) as unknown
  if (!Array.isArray(expectedDistFiles)
    || expectedDistFiles.some(entry => typeof entry !== 'string'
      || !entry.startsWith('dist/') || entry === 'dist/postinstall-inventory.json'
      || !safeRelativePath(entry))
    || new Set(expectedDistFiles).size !== expectedDistFiles.length) {
    throw new Error('openclaw_postinstall_inventory_invalid')
  }
  const distTree = await readStablePackageTree(path.join(packageRoot, 'dist'), { includeNodeModules: true })
  if (distTree.proofNodes.some(node => node.entryType !== 'file')) {
    throw new Error('openclaw_postinstall_dist_symlink_invalid')
  }
  const actualDistFiles = distTree.proofNodes
    .map(node => path.relative(packageRoot, node.path).split(path.sep).join('/'))
    .filter(relativePath => relativePath !== 'dist/postinstall-inventory.json')
    .sort((left, right) => left.localeCompare(right))
  if (actualDistFiles.some(relativePath => relativePath === 'dist/openclaw-install-guard'
    || /^dist\/extensions\/[^/]+\/(?:node_modules|\.openclaw-install-stage(?:-[^/]+)?)(?:\/|$)/iu.test(relativePath))) {
    throw new Error('openclaw_postinstall_requires_non_marker_mutation')
  }
  const expectedSorted = (expectedDistFiles as string[]).toSorted((left, right) => left.localeCompare(right))
  if (JSON.stringify(actualDistFiles) !== JSON.stringify(expectedSorted)) {
    throw new Error('openclaw_postinstall_inventory_does_not_match_dist')
  }

  const rawTree = await readStablePackageTree(packageRoot)
  await fs.unlink(markerPath)
  if (await fs.lstat(markerPath).then(() => true).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })) throw new Error('openclaw_lifecycle_marker_removal_failed')
  const postinstallTree = await readStablePackageTree(packageRoot)
  if (postinstallTree.ownedEntryCount !== rawTree.ownedEntryCount - 1
    || postinstallTree.ownedTotalBytes !== rawTree.ownedTotalBytes - marker.size) {
    throw new Error('openclaw_static_postinstall_changed_unexpected_nodes')
  }
  return {
    schema: 'openclaw-static-postinstall-v1',
    markerRemoved: '.openclaw-lifecycle-pending',
    inventoryEntryCount: expectedSorted.length,
    rawOwnedPackageSha256: rawTree.packageTreeSha256,
    postinstallOwnedPackageSha256: postinstallTree.packageTreeSha256,
    postinstallOwnedEntryCount: postinstallTree.ownedEntryCount,
    postinstallOwnedTotalBytes: postinstallTree.ownedTotalBytes,
  }
}

async function generateSignedReceipt(
  options: GenerateReceiptOptions,
  target: ReleaseTarget,
  distribution: ReleaseDistribution,
  artifact: Awaited<ReturnType<typeof inspectArtifact>>,
  extractedRoot: string,
  dependencies: GeneratorDependencies,
): Promise<{ receipt: Receipt; extraSourceEvidence?: Record<string, unknown> }> {
  const expectedChannel = options.kind === 'signed-app' ? 'signed_app' : 'signed_cli'
  if (distribution.channel !== expectedChannel) throw new Error('receipt_kind_does_not_match_release_channel')
  const member = exactMember(
    extractedRoot,
    target.catalogId === 'kimi-code-native'
      ? 'bin/kimi'
      : options.memberPath ?? defaultSignedMemberPath(options, artifact.path),
  )
  let version = options.version
  let executablePath: string
  let codeObjectPath: string
  if (options.kind === 'signed-app') {
    const surface = await inspectStableDesktopBundleSurface(desktopDependencies(), member, 10_000)
    if (surface.bundleId !== expectedSignedIdentity(distribution).identifier) {
      throw new Error('signed_app_bundle_identifier_mismatch')
    }
    if (surface.version !== options.version) throw new Error('signed_app_version_mismatch')
    version = surface.version
    executablePath = surface.executableRealpath
    codeObjectPath = member
  } else {
    const stat = await fs.lstat(member)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('signed_cli_member_not_regular')
    executablePath = member
    codeObjectPath = member
  }
  dependencies.assertArchitecture(executablePath, options.architecture)
  const executable = await readStableFileFingerprint(executablePath, MAX_ARTIFACT_BYTES)
  if (!executable.executable) throw new Error('signed_executable_not_executable')
  let signedCliSourceEvidence: Record<string, unknown> | undefined
  if (target.catalogId === 'kimi-code-native') {
    if (!options.kimiReleaseManifestPath || !options.kimiGitHubReleaseMetadataPath
      || !options.kimiArtifactChecksumPath) {
      throw new Error('kimi_signed_cli_requires_github_release_evidence')
    }
    if (resolvedArchiveFormat(artifact.path, options.archiveFormat ?? 'auto') !== 'zip'
      || options.memberPath !== 'kimi') {
      throw new Error('kimi_signed_cli_requires_official_zip_layout')
    }
    const [releaseMetadata, releaseManifest, checksum] = await Promise.all([
      inspectMetadataInput(options.kimiGitHubReleaseMetadataPath, 2 * 1024 * 1024),
      inspectMetadataInput(options.kimiReleaseManifestPath, 128 * 1024),
      inspectMetadataInput(options.kimiArtifactChecksumPath, 4 * 1024),
    ])
    const checksumText = Buffer.from(checksum.content).toString('utf8')
    const checksumMatch = checksumText.match(/^([a-f0-9]{64}) {2}([^\s/]+)\r?\n?$/u)
    if (!checksumMatch || checksumMatch[1] !== artifact.sha256 || checksumMatch[2] !== path.basename(artifact.path)) {
      throw new Error('kimi_release_checksum_mismatch')
    }
    const expectedAsset = `kimi-code-darwin-${options.architecture}.zip`
    if (path.basename(artifact.path) !== expectedAsset) throw new Error('kimi_release_asset_name_mismatch')
    const expectedSourceUrl = `https://github.com/MoonshotAI/kimi-code/releases/download/%40moonshot-ai/kimi-code%40${encodeURIComponent(options.version)}/${expectedAsset}`
    if (exactHttpsUrl(options.sourceUrl) !== expectedSourceUrl) throw new Error('kimi_release_artifact_url_mismatch')
    const authority = dependencies.kimiReleaseAuthority(options.version, options.architecture)
    if (!authority) throw new Error('kimi_release_authority_not_frozen')
    const github = verifiedKimiGitHubReleaseEvidence({
      metadata: releaseMetadata,
      manifest: releaseManifest,
      checksum,
      artifact,
      executable,
      version: options.version,
      architecture: options.architecture,
      expectedAsset,
      expectedSourceUrl,
      authority,
    })
    signedCliSourceEvidence = {
      kimiGitHubRelease: github,
    }
  } else if (target.catalogId === 'claude-code-native') {
    const paths = [
      options.signedCliManifestPath,
      options.signedCliManifestSignaturePath,
      options.signedCliSigningKeyPath,
    ]
    if (paths.some(candidate => !candidate)) throw new Error('claude_signed_cli_requires_signed_release_manifest')
    const [manifest, detachedSignature, signingKey] = await Promise.all([
      inspectMetadataInput(paths[0]!, 2 * 1024 * 1024),
      inspectMetadataInput(paths[1]!, 1024 * 1024),
      inspectMetadataInput(paths[2]!, 1024 * 1024),
    ])
    const evidenceRoot = path.join(path.dirname(extractedRoot), 'claude-release-evidence')
    await fs.mkdir(evidenceRoot, { mode: 0o700 })
    const stagedManifest = path.join(evidenceRoot, 'manifest.json')
    const stagedSignature = path.join(evidenceRoot, 'manifest.json.sig')
    const stagedKey = path.join(evidenceRoot, 'claude-code.asc')
    await Promise.all([
      fs.writeFile(stagedManifest, manifest.content, { mode: 0o600 }),
      fs.writeFile(stagedSignature, detachedSignature.content, { mode: 0o600 }),
      fs.writeFile(stagedKey, signingKey.content, { mode: 0o600 }),
    ])
    const verifiedFingerprint = await dependencies.verifyClaudeManifestSignature(
      stagedManifest, stagedSignature, stagedKey, path.join(evidenceRoot, 'gnupg'),
    )
    if (verifiedFingerprint !== ANTHROPIC_RELEASE_SIGNING_FINGERPRINT) {
      throw new Error('claude_release_manifest_signer_mismatch')
    }
    const manifestValue = JSON.parse(Buffer.from(manifest.content).toString('utf8')) as {
      version?: unknown
      platforms?: Record<string, { binary?: unknown; checksum?: unknown; size?: unknown }>
    }
    const platform = `darwin-${options.architecture}`
    const platformArtifact = manifestValue.platforms?.[platform]
    if (manifestValue.version !== options.version
      || platformArtifact?.binary !== 'claude'
      || platformArtifact.checksum !== executable.sha256
      || platformArtifact.size !== executable.size) {
      throw new Error('claude_release_manifest_artifact_mismatch')
    }
    const expectedSourceUrl = `https://downloads.claude.ai/claude-code-releases/${encodeURIComponent(options.version)}/${platform}/claude`
    if (exactHttpsUrl(options.sourceUrl) !== expectedSourceUrl) throw new Error('claude_release_artifact_url_mismatch')
    signedCliSourceEvidence = {
      claudeReleaseManifest: {
        manifest: { name: path.basename(manifest.path), sha256: manifest.sha256, sizeBytes: manifest.sizeBytes },
        detachedSignature: {
          name: path.basename(detachedSignature.path), sha256: detachedSignature.sha256,
          sizeBytes: detachedSignature.sizeBytes,
        },
        signingKey: { name: path.basename(signingKey.path), sha256: signingKey.sha256, sizeBytes: signingKey.sizeBytes },
        signerFingerprint: verifiedFingerprint,
        platform,
      },
    }
  } else if (options.kind === 'signed-cli') {
    throw new Error('signed_cli_machine_readable_version_evidence_unavailable')
  }
  const signature = await dependencies.inspectSignature(codeObjectPath)
  const expected = expectedSignedIdentity(distribution)
  if (!signature.valid || signature.verificationBoundary !== 'strict_final'
    || signature.identifier !== expected.identifier || signature.teamIdentifier !== expected.teamIdentifier
    || !signature.cdHash || !signature.designatedRequirement) {
    throw new Error('signed_distribution_identity_mismatch')
  }
  const executableAfter = await readStableFileFingerprint(executablePath, MAX_ARTIFACT_BYTES)
  if (executableAfter.fingerprint !== executable.fingerprint) throw new Error('signed_executable_changed_during_signature')
  const distributionTree = options.kind === 'signed-app'
    ? await readStableDistributionTree(member)
    : { sha256: executable.sha256, sizeBytes: executable.size }
  let schema = 'signed-code-v1'
  let portable = signedCodePortableArtifactFingerprint({ version, executable, signature })
  if (target.catalogId === 'kimi-code-native') {
    schema = 'signed-cli-kimi-release-v2'
    const executableArtifactFingerprint = kimiNativeExecutablePortableArtifactFingerprint(executable)
    portable = signedKimiPortableArtifactFingerprint({ version, executableArtifactFingerprint, signature })
  }
  if (!portable) throw new Error('signed_portable_fingerprint_unavailable')
  const receipt = finalizeReceipt({
    distribution,
    options,
    artifact,
    executable: {
      role: 'signed_executable', relativePath: path.basename(executablePath),
      sha256: executable.sha256, sizeBytes: executable.size, executable: true, normalization: 'raw',
    },
    distributionSha256: distributionTree.sha256,
    distributionSizeBytes: distributionTree.sizeBytes,
    portableFingerprintSchema: schema,
    signedCode: {
      identifier: signature.identifier,
      teamIdentifier: signature.teamIdentifier,
      cdhash: signature.cdHash.toLowerCase(),
      designatedRequirement: signature.designatedRequirement.trim(),
    },
    npmPackage: null,
  }, portable)
  return { receipt, extraSourceEvidence: signedCliSourceEvidence }
}

function verifiedKimiGitHubReleaseEvidence(input: {
  metadata: Awaited<ReturnType<typeof inspectMetadataInput>>
  manifest: Awaited<ReturnType<typeof inspectMetadataInput>>
  checksum: Awaited<ReturnType<typeof inspectMetadataInput>>
  artifact: Awaited<ReturnType<typeof inspectArtifact>>
  executable: Awaited<ReturnType<typeof readStableFileFingerprint>>
  version: string
  architecture: Architecture
  expectedAsset: string
  expectedSourceUrl: string
  authority: KimiReleaseAuthority
}): Record<string, unknown> {
  const release = JSON.parse(Buffer.from(input.metadata.content).toString('utf8')) as {
    id?: unknown
    tag_name?: unknown
    html_url?: unknown
    published_at?: unknown
    immutable?: unknown
    assets?: unknown
  }
  const tagName = `@moonshot-ai/kimi-code@${input.version}`
  const releaseUrl = `https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%40${encodeURIComponent(input.version)}`
  if (!Number.isSafeInteger(release.id) || (release.id as number) <= 0
    || release.id !== input.authority.releaseId
    || release.tag_name !== tagName
    || exactHttpsUrl(String(release.html_url)) !== releaseUrl
    || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))
    || typeof release.immutable !== 'boolean'
    || !Array.isArray(release.assets)) throw new Error('kimi_github_release_metadata_mismatch')

  type Asset = {
    id?: unknown
    name?: unknown
    browser_download_url?: unknown
    size?: unknown
    digest?: unknown
    updated_at?: unknown
  }
  const assets = release.assets as Asset[]
  const exactAsset = (
    name: string,
    expectedUrl: string,
    local: { sha256: string; sizeBytes: number },
    authority: KimiReleaseAssetAuthority,
  ): Asset => {
    const matches = assets.filter(asset => asset?.name === name)
    if (matches.length !== 1) throw new Error('kimi_github_release_asset_not_unique')
    const asset = matches[0]!
    if (!Number.isSafeInteger(asset.id) || (asset.id as number) <= 0
      || asset.id !== authority.id || name !== authority.name || expectedUrl !== authority.url
      || exactHttpsUrl(String(asset.browser_download_url)) !== expectedUrl
      || asset.size !== local.sizeBytes
      || asset.digest !== `sha256:${local.sha256}`
      || local.sizeBytes !== authority.sizeBytes || local.sha256 !== authority.sha256
      || typeof asset.updated_at !== 'string' || !Number.isFinite(Date.parse(asset.updated_at))) {
      throw new Error('kimi_github_release_asset_mismatch')
    }
    return asset
  }
  const manifestName = 'manifest.json'
  const checksumName = `${input.expectedAsset}.sha256`
  const releaseAssetRoot = `https://github.com/MoonshotAI/kimi-code/releases/download/%40moonshot-ai/kimi-code%40${encodeURIComponent(input.version)}`
  const manifestAsset = exactAsset(
    manifestName,
    `${releaseAssetRoot}/${manifestName}`,
    input.manifest,
    input.authority.manifest,
  )
  const archiveAsset = exactAsset(
    input.expectedAsset, input.expectedSourceUrl, input.artifact, input.authority.archive,
  )
  const checksumAsset = exactAsset(
    checksumName,
    `${releaseAssetRoot}/${checksumName}`,
    input.checksum,
    input.authority.checksum,
  )

  const manifest = JSON.parse(Buffer.from(input.manifest.content).toString('utf8')) as {
    version?: unknown
    tag?: unknown
    platforms?: Record<string, { filename?: unknown; checksum?: unknown }>
  }
  const platformKey = `darwin-${input.architecture}`
  const platform = manifest.platforms?.[platformKey]
  const binaryName = `kimi-code-${platformKey}`
  if (manifest.version !== input.version || manifest.tag !== tagName
    || platform?.filename !== binaryName
    || platform.checksum !== input.executable.sha256) {
    throw new Error('kimi_release_manifest_binary_mismatch')
  }

  return {
    schema: 'kimi-github-release-assets-v1',
    repository: 'MoonshotAI/kimi-code',
    apiUrl: `https://api.github.com/repos/MoonshotAI/kimi-code/releases/tags/%40moonshot-ai%2Fkimi-code%40${encodeURIComponent(input.version)}`,
    releaseId: release.id,
    tagName,
    publishedAt: release.published_at,
    immutable: release.immutable,
    releaseMetadataSha256: input.metadata.sha256,
    manifest: sourceAssetEvidence(manifestAsset, input.manifest),
    archive: sourceAssetEvidence(archiveAsset, input.artifact),
    checksum: {
      ...sourceAssetEvidence(checksumAsset, input.checksum),
      claimedArchiveSha256: input.artifact.sha256,
    },
    platform: { key: platformKey, binaryName, binarySha256: input.executable.sha256 },
  }
}

function sourceAssetEvidence(
  asset: { id?: unknown; name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown; updated_at?: unknown },
  local: { sha256: string; sizeBytes: number },
): Record<string, unknown> {
  return {
    assetId: asset.id,
    name: asset.name,
    url: asset.browser_download_url,
    apiDigest: asset.digest,
    sizeBytes: asset.size,
    contentSha256: local.sha256,
    updatedAt: asset.updated_at,
  }
}

function defaultSignedMemberPath(options: GenerateReceiptOptions, artifactPath: string): string {
  if (options.kind === 'signed-app') throw new Error('signed_app_requires_member_path')
  return options.catalogId === 'kimi-code-native' ? 'bin/kimi' : path.basename(artifactPath)
}

function finalizeReceipt(
  input: {
    distribution: ReleaseDistribution
    options: GenerateReceiptOptions
    artifact: Awaited<ReturnType<typeof inspectArtifact>>
    executable: ReceiptProofNode
    distributionSha256: string
    distributionSizeBytes: number
    portableFingerprintSchema: string
    signedCode: Receipt['signedCode']
    npmPackage: Receipt['npmPackage']
  },
  runtimePortableFingerprint: string,
): Receipt {
  const receipt: Receipt = {
    distributionId: input.distribution.distributionId,
    packageProvenance: input.distribution.packageProvenance,
    version: input.options.version,
    architecture: input.options.architecture,
    artifactSha256: input.artifact.sha256,
    artifactSizeBytes: input.artifact.sizeBytes,
    executableSha256: input.executable.sha256,
    executableSizeBytes: input.executable.sizeBytes,
    distributionSha256: input.distributionSha256,
    distributionSizeBytes: input.distributionSizeBytes,
    portableFingerprintSchema: input.portableFingerprintSchema,
    portableArtifactFingerprint: runtimePortableFingerprint,
    signedCode: input.signedCode,
    npmPackage: input.npmPackage,
  }
  const releasePortableFingerprint = portableArtifactFingerprint(receipt) as string
  if (releasePortableFingerprint !== runtimePortableFingerprint) {
    throw new Error('runtime_and_release_portable_fingerprint_mismatch')
  }
  return receipt
}

async function stageNpmTarball(
  tarball: string,
  tempRoot: string,
  packageName: string,
  integrity: string,
  installName = packageName,
): Promise<{ packageRoot: string; executableForBin(name: string): string }> {
  const artifact = await inspectArtifact(tarball)
  if (await sha512Integrity(tarball) !== integrity) throw new Error('npm_tarball_integrity_mismatch')
  const extractRoot = await extractArchive(tarball, 'tgz', path.join(tempRoot, 'tarball'))
  const sourcePackage = exactMember(extractRoot, 'package')
  const nodeModulesRoot = path.join(tempRoot, 'node_modules')
  const packageRoot = path.join(nodeModulesRoot, ...installName.split('/'))
  await fs.mkdir(path.dirname(packageRoot), { recursive: true, mode: 0o700 })
  await fs.rename(sourcePackage, packageRoot)
  const lockPath = path.join(nodeModulesRoot, '.package-lock.json')
  const existingLock = await fs.readFile(lockPath, 'utf8').then(value => JSON.parse(value)).catch(() => ({ lockfileVersion: 3, packages: {} }))
  existingLock.packages[`node_modules/${installName}`] = {
    version: JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version,
    integrity,
  }
  await fs.writeFile(lockPath, JSON.stringify(existingLock), { mode: 0o600 })
  await readStablePackageTree(packageRoot)
  const after = await inspectArtifact(tarball)
  if (after.physicalFingerprint !== artifact.physicalFingerprint) throw new Error('npm_tarball_changed_during_extract')
  return {
    packageRoot,
    executableForBin(name: string): string {
      const manifest = JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; bin?: unknown }
      if (manifest.name !== packageName) throw new Error('npm_package_name_mismatch')
      const relative = typeof manifest.bin === 'string'
        ? (name === packageName.split('/').at(-1) ? manifest.bin : undefined)
        : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
          ? (manifest.bin as Record<string, unknown>)[name]
          : undefined
      const normalized = typeof relative === 'string' ? normalizedNpmBinRelativePath(relative) : undefined
      if (!normalized) throw new Error('npm_package_bin_mismatch')
      const executable = path.resolve(packageRoot, normalized)
      if (!isWithinOrEqual(packageRoot, executable)) throw new Error('npm_package_bin_escape')
      return executable
    },
  }
}

async function materializeCopiedPlatformBinary(
  rootPackage: string,
  executablePath: string,
  composition: NpmComposedDistributionSpec,
  components: readonly { spec: NpmComposedComponentSpec; packageRoot: string }[],
): Promise<void> {
  const executableRelative = path.relative(rootPackage, executablePath).split(path.sep).join('/')
  const copySources = components.filter(component => (
    component.spec.role === 'platform_leaf'
      && component.spec.installName === composition.copySourceInstallName
  ))
  if (composition.entryRule !== 'copy_platform_binary_v1'
    || executableRelative !== composition.rootExecutableRelativePath
    || !composition.copySourceInstallName
    || copySources.length !== 1 || !copySources[0]?.spec.nativeExecutableRelativePath) {
    throw new Error('npm_copy_platform_binary_topology_invalid')
  }
  const destinationNode = await fs.lstat(executablePath)
  if (!destinationNode.isFile() || destinationNode.isSymbolicLink()
    || path.resolve(await fs.realpath(executablePath)) !== executablePath) {
    throw new Error('npm_copy_platform_binary_destination_invalid')
  }
  const leaf = copySources[0]
  const sourcePath = path.join(
    leaf.packageRoot, ...leaf.spec.nativeExecutableRelativePath.split('/'),
  )
  const sourceBefore = await readStableFileFingerprint(sourcePath, MAX_ARTIFACT_BYTES)
  if (!sourceBefore.executable) throw new Error('npm_copy_platform_binary_source_not_executable')
  await fs.copyFile(sourcePath, executablePath)
  await fs.chmod(executablePath, sourceBefore.mode & 0o777)
  const sourceAfter = await readStableFileFingerprint(sourcePath, MAX_ARTIFACT_BYTES)
  const destinationAfter = await readStableFileFingerprint(executablePath, MAX_ARTIFACT_BYTES)
  if (sourceAfter.fingerprint !== sourceBefore.fingerprint
    || destinationAfter.sha256 !== sourceBefore.sha256
    || destinationAfter.size !== sourceBefore.size
    || destinationAfter.mode !== (sourceBefore.mode & 0o777)
    || !destinationAfter.executable
    || path.resolve(await fs.realpath(executablePath)) !== executablePath) {
    throw new Error('npm_copy_platform_binary_readback_mismatch')
  }
}

async function verifiedRegistryMetadata(
  metadataPath: string,
  packageName: string,
  version: string,
  expectedTarballUrl: string | undefined,
  tarballPath: string,
): Promise<{ packageName: string; integrity: string; tarballUrl: string; metadataSha256: string }> {
  const metadata = await readStableFileSnapshot(path.resolve(metadataPath), MAX_PACKUMENT_BYTES)
  const value = JSON.parse(Buffer.from(metadata.content).toString('utf8')) as {
    name?: unknown
    versions?: Record<string, { name?: unknown; version?: unknown; dist?: { integrity?: unknown; tarball?: unknown } }>
  }
  const selected = value.versions?.[version]
  if (value.name !== packageName || selected?.name !== packageName || selected.version !== version
    || typeof selected.dist?.integrity !== 'string' || !INTEGRITY.test(selected.dist.integrity)
    || typeof selected.dist.tarball !== 'string') throw new Error('npm_registry_metadata_mismatch')
  const tarballUrl = exactHttpsUrl(selected.dist.tarball)
  if (expectedTarballUrl && exactHttpsUrl(expectedTarballUrl) !== tarballUrl) {
    throw new Error('npm_source_url_differs_from_registry_metadata')
  }
  if (await sha512Integrity(tarballPath) !== selected.dist.integrity) throw new Error('npm_tarball_integrity_mismatch')
  return {
    packageName,
    integrity: selected.dist.integrity,
    tarballUrl,
    metadataSha256: metadata.sha256,
  }
}

async function prepareSignedArtifact(
  options: GenerateReceiptOptions,
  artifact: Awaited<ReturnType<typeof inspectArtifact>>,
  tempRoot: string,
): Promise<{ root: string; cleanup?: () => void }> {
  const format = resolvedArchiveFormat(artifact.path, options.archiveFormat ?? 'auto')
  if (options.catalogId === 'kimi-code-native') {
    if (format !== 'zip' || options.memberPath !== 'kimi') {
      throw new Error('kimi_signed_cli_requires_official_archive_and_member_path')
    }
    const extracted = await extractArchive(artifact.path, format, path.join(tempRoot, 'kimi-release'))
    const source = exactMember(extracted, options.memberPath)
    const sourceStat = await fs.lstat(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('signed_cli_member_not_regular')
    const root = path.join(tempRoot, '.kimi-code')
    const destination = path.join(root, 'bin', 'kimi')
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL)
    await fs.chmod(destination, sourceStat.mode & 0o777)
    return { root }
  }
  if (format === 'raw') {
    if (options.kind !== 'signed-cli') throw new Error('signed_app_requires_archive')
    const member = options.memberPath ?? defaultSignedMemberPath(options, artifact.path)
    if (!safeRelativePath(member)) throw new Error('archive_member_path_invalid')
    const root = path.join(tempRoot, options.catalogId === 'kimi-code-native' ? '.kimi-code' : 'signed')
    const destination = path.join(root, member)
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await copyStableInputFile(artifact, destination)
    const sourceStat = await fs.stat(artifact.path)
    await fs.chmod(destination, sourceStat.mode & 0o777)
    return { root }
  }
  if (format !== 'dmg') return {
    root: await extractArchive(artifact.path, format, path.join(tempRoot, 'signed'), options.kind === 'signed-app'),
  }
  if (process.platform !== 'darwin') throw new Error('dmg_receipts_require_macos')
  const privateDmg = await copyDmgToPrivateMountInput(artifact, tempRoot)
  const mountpoint = path.join(tempRoot, 'dmg')
  await fs.mkdir(mountpoint, { mode: 0o700 })
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, privateDmg])
  return { root: mountpoint, cleanup: () => run('/usr/bin/hdiutil', ['detach', mountpoint]) }
}

export async function copyDmgToPrivateMountInput(
  artifact: Awaited<ReturnType<typeof inspectArtifact>>,
  tempRoot: string,
): Promise<string> {
  const privateRoot = path.join(tempRoot, 'dmg-input')
  await fs.mkdir(privateRoot, { mode: 0o700 })
  await fs.chmod(privateRoot, 0o700)
  const privateDmg = path.join(privateRoot, 'artifact.dmg')
  await copyStableInputFile(artifact, privateDmg)
  const afterCopy = await inspectArtifact(artifact.path)
  assertReceiptArtifactUnchanged(artifact, afterCopy)
  return privateDmg
}

async function inspectMetadataInput(inputPath: string, maxBytes: number): Promise<{
  path: string
  content: Uint8Array
  sha256: string
  sizeBytes: number
}> {
  if (!path.isAbsolute(inputPath)) throw new Error('metadata_path_must_be_absolute')
  const requested = path.resolve(inputPath)
  const stat = await fs.lstat(requested)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('metadata_must_be_regular_file')
  const canonical = path.resolve(await fs.realpath(requested))
  const snapshot = await readStableFileSnapshot(canonical, maxBytes)
  if (snapshot.size <= 0) throw new Error('metadata_empty')
  return { path: canonical, content: snapshot.content, sha256: snapshot.sha256, sizeBytes: snapshot.size }
}

export async function verifyAnthropicManifestSignature(
  manifestPath: string,
  signaturePath: string,
  signingKeyPath: string,
  tempHome: string,
): Promise<string> {
  const isolatedHome = await createIsolatedGpgHome(tempHome)
  try {
    const gpg = exactGpgBinary()
    const keyListing = run(gpg, [
      '--batch', '--homedir', isolatedHome.path, '--with-colons', '--show-keys', signingKeyPath,
    ], 1024 * 1024)
    const fingerprints = keyListing.split(/\r?\n/u)
      .filter(line => line.startsWith('fpr:'))
      .map(line => line.split(':')[9]?.toUpperCase())
      .filter((value): value is string => Boolean(value))
    if (!fingerprints.includes(ANTHROPIC_RELEASE_SIGNING_FINGERPRINT)) {
      throw new Error('claude_release_signing_key_fingerprint_mismatch')
    }
    run(gpg, ['--batch', '--homedir', isolatedHome.path, '--import', signingKeyPath], 1024 * 1024)
    const status = run(gpg, [
      '--batch', '--homedir', isolatedHome.path, '--status-fd=1', '--verify', signaturePath, manifestPath,
    ], 1024 * 1024)
    const validSigners = status.split(/\r?\n/u)
      .map(line => {
        const fields = line.split(' ')
        if (fields[0] !== '[GNUPG:]' || fields[1] !== 'VALIDSIG'
          || !/^[A-Fa-f0-9]{40}$/u.test(fields[2] ?? '')) return undefined
        const primary = fields.at(-1)
        return (/^[A-Fa-f0-9]{40}$/u.test(primary ?? '') ? primary : fields[2])!.toUpperCase()
      })
      .filter((value): value is string => Boolean(value))
    if (validSigners.length !== 1 || validSigners[0] !== ANTHROPIC_RELEASE_SIGNING_FINGERPRINT) {
      throw new Error('claude_release_manifest_signature_invalid')
    }
    return validSigners[0]
  } finally {
    await isolatedHome.cleanup()
  }
}

export async function createIsolatedGpgHome(requestedHome: string): Promise<{
  path: string
  usedShortPath: boolean
  cleanup(): Promise<void>
}> {
  const requested = path.resolve(requestedHome)
  const requiresShortPath = process.platform === 'darwin' && !gpgAgentSocketPathsFit(requested)
  let created: string | undefined
  try {
    created = requiresShortPath
      ? await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'tm-gpg-'))
      : await fs.mkdir(requested, { recursive: false, mode: 0o700 }).then(() => requested)
    const canonical = path.resolve(await fs.realpath(created))
    await fs.chmod(canonical, 0o700)
    if (process.platform === 'darwin' && !gpgAgentSocketPathsFit(canonical)) {
      throw new Error('gpg_home_socket_path_too_long')
    }
    return {
      path: canonical,
      usedShortPath: requiresShortPath,
      cleanup: () => fs.rm(canonical, { recursive: true, force: true }),
    }
  } catch (error) {
    if (created) await fs.rm(created, { recursive: true, force: true })
    throw error
  }
}

function gpgAgentSocketPathsFit(home: string): boolean {
  return GPG_AGENT_SOCKET_NAMES.every(name => (
    Buffer.byteLength(path.join(home, name), 'utf8') <= DARWIN_UNIX_SOCKET_PATH_MAX_BYTES
  ))
}

function exactGpgBinary(): string {
  const candidate = ['/opt/homebrew/bin/gpg', '/usr/local/bin/gpg']
    .find(target => fsSync.existsSync(target))
  if (!candidate) throw new Error('gpg_not_available_for_claude_release_verification')
  return candidate
}

async function extractArchive(
  artifactPath: string,
  requestedFormat: NonNullable<GenerateReceiptOptions['archiveFormat']>,
  destination: string,
  signedApp = false,
): Promise<string> {
  const format = resolvedArchiveFormat(artifactPath, requestedFormat)
  if (!['tgz', 'zip'].includes(format)) throw new Error(`unsupported_extract_format:${format}`)
  const source = await inspectArtifact(artifactPath)
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const stableArchive = path.join(path.dirname(destination), `.receipt-input-${source.sha256.slice(0, 16)}`)
  await copyStableInputFile(source, stableArchive)
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  try {
    if (format === 'tgz') {
      const listing = run('/usr/bin/tar', ['-tzf', stableArchive], MAX_LISTING_BYTES)
      validateArchiveEntryNames(listing.split(/\r?\n/u).filter(Boolean))
      run('/usr/bin/tar', ['-xzf', stableArchive, '-C', destination, '--no-same-owner'])
    } else {
      await extractZipArchive(stableArchive, destination, { signedApp })
    }
  } finally {
    await fs.rm(stableArchive, { force: true })
  }
  const after = await inspectArtifact(artifactPath)
  if (after.physicalFingerprint !== source.physicalFingerprint) throw new Error('archive_changed_during_extract')
  await readStableDistributionTree(destination)
  return destination
}

interface SafeZipEntry {
  name: string
  rawName: Buffer
  directory: boolean
  symlink: boolean
  flags: number
  method: 0 | 8
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  unixMode: number | null
  dataOffset?: number
}

/**
 * Minimal ZIP reader for immutable release inputs. It intentionally supports
 * ordinary stored/deflated files and directories. Signed apps may opt into
 * delayed, internal relative symlinks; other links and all special nodes,
 * encryption, ZIP64, unsigned/mismatched descriptors and unbounded expansion
 * fail closed.
 */
export async function extractZipArchive(
  archivePath: string,
  destination: string,
  options: { signedApp?: boolean } = {},
): Promise<void> {
  const canonicalDestination = await canonicalEmptyZipDestination(destination)
  const archive = await fs.open(archivePath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW)
  try {
    const stat = await archive.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error('zip_archive_size_invalid')
    }
    const { entries, centralOffset } = await readSafeZipCentralDirectory(archive, stat.size, options.signedApp === true)
    validateArchiveEntryNames(entries.map(entry => entry.name))
    await bindSafeZipLocalEntries(archive, centralOffset, entries)
    // Never extract an entry through a link, regardless of archive order or
    // the destination filesystem's case/Unicode normalization behavior.
    const linkNames = new Set(entries.filter(entry => entry.symlink)
      .map(entry => entry.name.normalize('NFC').toLocaleLowerCase('en-US')))
    for (const entry of entries) {
      let parent = path.posix.dirname(entry.name.replace(/\/$/u, ''))
      while (parent !== '.') {
        if (linkNames.has(parent.normalize('NFC').toLocaleLowerCase('en-US'))) {
          throw new Error('zip_symlink_parent_forbidden')
        }
        parent = path.posix.dirname(parent)
      }
    }

    for (const entry of entries) {
      const target = path.resolve(canonicalDestination, entry.name)
      if (!isWithinOrEqual(canonicalDestination, target)) throw new Error('zip_entry_path_escape')
      if (entry.directory) {
        await ensureCanonicalZipDirectory(canonicalDestination, entry.name.replace(/\/$/u, ''))
        continue
      }
      const parentRelative = path.posix.dirname(entry.name)
      const parent = await ensureCanonicalZipDirectory(
        canonicalDestination, parentRelative === '.' ? '' : parentRelative,
      )
      if (parent !== path.dirname(target)) throw new Error('zip_entry_parent_not_canonical')
      await extractSafeZipFile(archive, target, entry)
    }
    if (linkNames.size > 0) await materializeSafeZipSymlinks(canonicalDestination, entries)
  } finally {
    await archive.close()
  }
}

async function materializeSafeZipSymlinks(root: string, entries: SafeZipEntry[]): Promise<void> {
  // CRC and size checks already ran through the ordinary O_EXCL/O_NOFOLLOW
  // writer. Validate every payload before replacing any placeholder.
  const links: Array<{ target: string; relativeTarget: string; snapshot: Awaited<ReturnType<typeof readStableFileSnapshot>> }> = []
  for (const entry of entries.filter(entry => entry.symlink)) {
    const target = path.resolve(root, entry.name)
    const snapshot = await readStableFileSnapshot(target, 4096)
    const relativeTarget = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.content)
    if (!relativeTarget || relativeTarget.includes('\0') || relativeTarget.includes('\\')
      || path.posix.isAbsolute(relativeTarget) || path.win32.isAbsolute(relativeTarget)
      || /^[a-z]:/iu.test(relativeTarget)
      || !isWithinOrEqual(root, path.resolve(path.dirname(target), relativeTarget))) {
      throw new Error('zip_symlink_target_forbidden')
    }
    links.push({ target, relativeTarget, snapshot })
  }
  for (const link of links) {
    const parent = path.dirname(link.target)
    const parentIdentity = await canonicalZipDirectoryIdentity(parent)
    const current = await readStableFileSnapshot(link.target, 4096)
    if (current.fingerprint !== link.snapshot.fingerprint) throw new Error('zip_symlink_placeholder_changed')
    await fs.unlink(link.target)
    if (await canonicalZipDirectoryIdentity(parent) !== parentIdentity) throw new Error('zip_entry_parent_changed')
    await fs.symlink(link.relativeTarget, link.target)
    if (await canonicalZipDirectoryIdentity(parent) !== parentIdentity) throw new Error('zip_entry_parent_changed')
  }
  // realpath follows full chains (including directory links), rejecting cycles
  // and dangling targets; lexical containment alone is insufficient here.
  for (const link of links) {
    let resolved: string
    try { resolved = await fs.realpath(link.target) } catch {
      throw new Error('zip_symlink_unresolvable')
    }
    if (!isWithinOrEqual(root, resolved)) throw new Error('zip_symlink_target_forbidden')
  }
}

async function canonicalEmptyZipDestination(destination: string): Promise<string> {
  const requested = path.resolve(destination)
  const before = await fs.lstat(requested, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('zip_destination_not_canonical')
  const canonical = path.resolve(await fs.realpath(requested))
  const beforeIdentity = [before.dev, before.ino, before.mode, before.uid, before.gid].join(':')
  const canonicalIdentity = await canonicalZipDirectoryIdentity(canonical)
  if (canonicalIdentity !== beforeIdentity) throw new Error('zip_destination_changed')
  if ((await fs.readdir(canonical)).length !== 0) {
    throw new Error('zip_destination_must_be_new_and_empty')
  }
  if (await canonicalZipDirectoryIdentity(canonical) !== canonicalIdentity) {
    throw new Error('zip_destination_changed')
  }
  return canonical
}

async function ensureCanonicalZipDirectory(root: string, relativeDirectory: string): Promise<string> {
  let current = root
  for (const segment of relativeDirectory ? relativeDirectory.split('/') : []) {
    const parentIdentity = await canonicalZipDirectoryIdentity(current)
    const next = path.join(current, segment)
    try {
      await fs.mkdir(next, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (await canonicalZipDirectoryIdentity(current) !== parentIdentity) {
      throw new Error('zip_entry_parent_changed')
    }
    await canonicalZipDirectoryIdentity(next)
    current = next
  }
  return current
}

async function canonicalZipDirectoryIdentity(directory: string): Promise<string> {
  const node = await fs.lstat(directory, { bigint: true })
  if (!node.isDirectory() || node.isSymbolicLink()
    || path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) {
    throw new Error('zip_entry_parent_not_canonical')
  }
  return [node.dev, node.ino, node.mode, node.uid, node.gid].join(':')
}

async function readSafeZipCentralDirectory(
  archive: fs.FileHandle,
  archiveSize: number,
  signedApp: boolean,
): Promise<{ entries: SafeZipEntry[]; centralOffset: number }> {
  // Signed app bundles can exceed the CLI budget (the frozen Codex app is
  // ~1.4 GiB unpacked), but stay within the existing 2 GiB artifact bound.
  const maxUncompressedBytes = signedApp ? MAX_ARTIFACT_BYTES : MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES
  const tailSize = Math.min(archiveSize, MAX_ZIP_EOCD_BYTES)
  const tailOffset = archiveSize - tailSize
  const tail = await readExactArchiveBytes(archive, tailOffset, tailSize, 'zip_eocd_truncated')
  let eocdInTail = -1
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue
    const commentLength = tail.readUInt16LE(offset + 20)
    if (tailOffset + offset + 22 + commentLength === archiveSize) {
      eocdInTail = offset
      break
    }
  }
  if (eocdInTail < 0) throw new Error('zip_eocd_missing_or_invalid')
  const disk = tail.readUInt16LE(eocdInTail + 4)
  const centralDisk = tail.readUInt16LE(eocdInTail + 6)
  const diskEntries = tail.readUInt16LE(eocdInTail + 8)
  const entryCount = tail.readUInt16LE(eocdInTail + 10)
  const centralSize = tail.readUInt32LE(eocdInTail + 12)
  const centralOffset = tail.readUInt32LE(eocdInTail + 16)
  const eocdOffset = tailOffset + eocdInTail
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error('zip_multidisk_forbidden')
  }
  if (entryCount === 0 || entryCount === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('zip_empty_or_zip64_forbidden')
  }
  if (entryCount > 120_000 || centralSize > MAX_LISTING_BYTES
    || centralOffset + centralSize !== eocdOffset) {
    throw new Error('zip_central_directory_bounds_invalid')
  }
  const central = await readExactArchiveBytes(
    archive, centralOffset, centralSize, 'zip_central_directory_truncated',
  )
  const entries: SafeZipEntry[] = []
  const portableNames = new Set<string>()
  let totalUncompressed = 0
  let cursor = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('zip_central_entry_invalid')
    }
    const versionMadeBy = central.readUInt16LE(cursor + 4)
    const flags = central.readUInt16LE(cursor + 8)
    const method = central.readUInt16LE(cursor + 10)
    const crc = central.readUInt32LE(cursor + 16)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const entryDisk = central.readUInt16LE(cursor + 34)
    const externalAttributes = central.readUInt32LE(cursor + 38)
    const localOffset = central.readUInt32LE(cursor + 42)
    const entryLength = 46 + nameLength + extraLength + commentLength
    if (nameLength === 0 || cursor + entryLength > central.length
      || entryDisk !== 0 || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip_central_entry_bounds_invalid')
    }
    if ((flags & ZIP_ENCRYPTED_FLAG) !== 0
      || (flags & ~(ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG | ZIP_DEFLATE_OPTION_FLAGS)) !== 0
      || (method !== 0 && method !== 8)
      || (method === 0 && (flags & ZIP_DEFLATE_OPTION_FLAGS) !== 0)) {
      throw new Error('zip_entry_features_unsupported')
    }
    if (compressedSize > MAX_ARTIFACT_BYTES || uncompressedSize > maxUncompressedBytes
      || (method === 0 && compressedSize !== uncompressedSize)
      || (compressedSize === 0 ? uncompressedSize !== 0
        : uncompressedSize > compressedSize * MAX_ZIP_COMPRESSION_RATIO)) {
      throw new Error('zip_entry_expansion_limit_exceeded')
    }
    totalUncompressed += uncompressedSize
    if (!Number.isSafeInteger(totalUncompressed)
      || totalUncompressed > maxUncompressedBytes) {
      throw new Error('zip_total_expansion_limit_exceeded')
    }
    const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = decodeZipName(rawName, flags)
    const directory = name.endsWith('/')
    const portableName = name.normalize('NFC').toLocaleLowerCase('en-US').replace(/\/$/u, '')
    if (portableNames.has(portableName)) throw new Error('zip_portable_path_collision')
    portableNames.add(portableName)
    const unixMode = (versionMadeBy >>> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : null
    const symlink = unixMode !== null && (unixMode & 0o170000) === 0o120000
    if (symlink && (uncompressedSize === 0 || uncompressedSize > 4096)) {
      throw new Error('zip_symlink_target_size_invalid')
    }
    if (unixMode !== null) {
      const nodeType = unixMode & 0o170000
      if ((directory && nodeType !== 0o040000)
        || (!directory && nodeType !== 0o100000 && !(signedApp && symlink))) {
        throw new Error('zip_symlink_or_special_node_forbidden')
      }
    } else if (directory !== Boolean(externalAttributes & 0x10)) {
      throw new Error('zip_entry_type_mismatch')
    }
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0 || crc !== 0)) {
      throw new Error('zip_directory_payload_forbidden')
    }
    entries.push({
      name, rawName: Buffer.from(rawName), directory, symlink, flags, method: method as 0 | 8,
      crc32: crc, compressedSize, uncompressedSize, localOffset, unixMode,
    })
    cursor += entryLength
  }
  if (cursor !== central.length) throw new Error('zip_central_directory_shape_invalid')
  return { entries, centralOffset }
}

async function bindSafeZipLocalEntries(
  archive: fs.FileHandle,
  centralOffset: number,
  entries: SafeZipEntry[],
): Promise<void> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const entry of entries) {
    const header = await readExactArchiveBytes(archive, entry.localOffset, 30, 'zip_local_header_truncated')
    if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) throw new Error('zip_local_header_invalid')
    const flags = header.readUInt16LE(6)
    const method = header.readUInt16LE(8)
    const crc = header.readUInt32LE(14)
    const compressedSize = header.readUInt32LE(18)
    const uncompressedSize = header.readUInt32LE(22)
    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const variable = await readExactArchiveBytes(
      archive, entry.localOffset + 30, nameLength + extraLength, 'zip_local_header_truncated',
    )
    if (flags !== entry.flags || method !== entry.method || nameLength !== entry.rawName.length
      || !variable.subarray(0, nameLength).equals(entry.rawName)) {
      throw new Error('zip_local_and_central_metadata_mismatch')
    }
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength
    const usesDescriptor = (entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0
    if (usesDescriptor) {
      if (crc !== 0 || compressedSize !== 0 || uncompressedSize !== 0) {
        throw new Error('zip_local_descriptor_placeholders_invalid')
      }
    } else if (crc !== entry.crc32 || compressedSize !== entry.compressedSize
      || uncompressedSize !== entry.uncompressedSize) {
      throw new Error('zip_local_and_central_metadata_mismatch')
    }
    let end = dataOffset + entry.compressedSize
    if (usesDescriptor) {
      const descriptor = await readExactArchiveBytes(
        archive, end, 16, 'zip_data_descriptor_truncated',
      )
      if (descriptor.readUInt32LE(0) !== ZIP_DATA_DESCRIPTOR_SIGNATURE
        || descriptor.readUInt32LE(4) !== entry.crc32
        || descriptor.readUInt32LE(8) !== entry.compressedSize
        || descriptor.readUInt32LE(12) !== entry.uncompressedSize) {
        throw new Error('zip_data_descriptor_mismatch')
      }
      end += 16
    }
    if (!Number.isSafeInteger(end) || end > centralOffset) throw new Error('zip_entry_data_bounds_invalid')
    entry.dataOffset = dataOffset
    ranges.push({ start: entry.localOffset, end })
  }
  ranges.sort((left, right) => left.start - right.start)
  if (ranges[0]?.start !== 0) throw new Error('zip_local_entry_prefix_forbidden')
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) throw new Error('zip_local_entries_overlap')
    if (ranges[index]!.start !== ranges[index - 1]!.end) throw new Error('zip_local_entry_gap_forbidden')
  }
  if (ranges.at(-1)?.end !== centralOffset) throw new Error('zip_central_prefix_gap_forbidden')
}

async function extractSafeZipFile(
  archive: fs.FileHandle,
  target: string,
  entry: SafeZipEntry,
): Promise<void> {
  if (entry.dataOffset === undefined) throw new Error('zip_entry_data_unbound')
  const parent = path.dirname(target)
  const parentIdentity = await canonicalZipDirectoryIdentity(parent)
  const handle = await fs.open(
    target,
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW,
    entry.unixMode !== null && (entry.unixMode & 0o111) !== 0 ? 0o700 : 0o600,
  )
  if (await canonicalZipDirectoryIdentity(parent) !== parentIdentity) {
    await handle.close()
    throw new Error('zip_entry_parent_changed')
  }
  let bytesWritten = 0
  let crc = 0xffffffff
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesWritten += bytes.length
      if (bytesWritten > entry.uncompressedSize) {
        callback(new Error('zip_entry_uncompressed_size_mismatch'))
        return
      }
      crc = updateCrc32(crc, bytes)
      writeCompleteZipChunk(handle, bytes).then(() => callback(), callback)
    },
  })
  try {
    if (entry.compressedSize > 0) {
      const source = archive.createReadStream({
        start: entry.dataOffset,
        end: entry.dataOffset + entry.compressedSize - 1,
        autoClose: false,
      })
      try {
        if (entry.method === 8) {
          const inflater = createInflateRaw()
          await pipeline(source, inflater, sink)
          if (inflater.bytesWritten !== entry.compressedSize) {
            throw new Error('zip_deflate_stream_has_trailing_or_unread_bytes')
          }
        } else await pipeline(source, sink)
      } catch (error) {
        throw new Error('zip_entry_decompression_or_write_failed', { cause: error })
      }
    }
    if (bytesWritten !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw new Error('zip_entry_size_or_crc_mismatch')
    }
    if (await canonicalZipDirectoryIdentity(parent) !== parentIdentity
      || path.resolve(await fs.realpath(target)) !== target) {
      throw new Error('zip_entry_parent_changed')
    }
  } catch (error) {
    await fs.unlink(target).catch(() => undefined)
    throw error
  } finally {
    await handle.close()
  }
}

async function writeCompleteZipChunk(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null)
    if (result.bytesWritten <= 0) throw new Error('zip_entry_short_write')
    offset += result.bytesWritten
  }
}

export async function readExactArchiveBytes(
  archive: Pick<fs.FileHandle, 'read'>,
  position: number,
  length: number,
  errorCode: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length)
    || position < 0 || length < 0 || length > MAX_LISTING_BYTES) throw new Error(errorCode)
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await archive.read(buffer, offset, length - offset, position + offset)
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length - offset) {
      throw new Error(errorCode)
    }
    offset += bytesRead
  }
  return buffer
}

function decodeZipName(rawName: Buffer, flags: number): string {
  if ((flags & ZIP_UTF8_FLAG) === 0 && rawName.some(byte => byte > 0x7f)) {
    throw new Error('zip_non_utf8_name_unsupported')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(rawName)
  } catch {
    throw new Error('zip_entry_name_invalid_utf8')
  }
}

function updateCrc32(current: number, input: Buffer): number {
  let crc = current
  for (const byte of input) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!
  return crc >>> 0
}

type StableCopyWrite = (
  output: fs.FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesWritten: number }>

export async function copyStableInputFile(
  source: Awaited<ReturnType<typeof inspectArtifact>>,
  destination: string,
  writeChunk: StableCopyWrite = (output, buffer, offset, length, position) => (
    output.write(buffer, offset, length, position)
  ),
): Promise<void> {
  const input = await fs.open(source.path, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW)
  let output: fs.FileHandle | undefined
  try {
    const before = await input.stat({ bigint: true })
    if (!before.isFile()
      || before.size !== BigInt(source.sizeBytes)
      || before.dev.toString() !== source.device
      || before.ino.toString() !== source.inode
      || Number(before.mode & 0o7777n) !== source.mode
      || before.nlink.toString() !== source.linkCount
      || before.mtimeNs.toString() !== source.mtimeNs
      || before.ctimeNs.toString() !== source.ctimeNs
      || (source.ownerUid !== undefined && before.uid.toString() !== source.ownerUid)
      || (source.groupGid !== undefined && before.gid.toString() !== source.groupGid)) {
      throw new Error('artifact_changed_before_copy')
    }
    output = await fs.open(destination, 'wx', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0n
    while (offset < before.size) {
      const length = Number((before.size - offset) > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset)
      const { bytesRead } = await input.read(buffer, 0, length, Number(offset))
      if (bytesRead === 0) throw new Error('artifact_short_read')
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      let written = 0
      while (written < bytesRead) {
        const requested = bytesRead - written
        const result = await writeChunk(output, chunk, written, requested, Number(offset) + written)
        if (!Number.isSafeInteger(result.bytesWritten)
          || result.bytesWritten <= 0 || result.bytesWritten > requested) {
          throw new Error('artifact_copy_write_no_progress')
        }
        written += result.bytesWritten
      }
      offset += BigInt(bytesRead)
    }
    await output.sync()
    const after = await input.stat({ bigint: true })
    if ([before.dev, before.ino, before.mode, before.size, before.nlink, before.mtimeNs, before.ctimeNs].join(':')
      !== [after.dev, after.ino, after.mode, after.size, after.nlink, after.mtimeNs, after.ctimeNs].join(':')
      || hash.digest('hex') !== source.sha256) {
      throw new Error('artifact_changed_during_copy')
    }
    await output.close()
    output = undefined
    const copied = await readStableFileFingerprint(destination, MAX_ARTIFACT_BYTES)
    if (copied.size !== source.sizeBytes || copied.sha256 !== source.sha256) {
      throw new Error('artifact_copy_readback_mismatch')
    }
  } finally {
    await output?.close()
    await input.close()
  }
}

export function validateArchiveEntryNames(names: readonly string[]): void {
  if (names.length === 0 || names.length > 120_000) throw new Error('archive_entry_count_invalid')
  const seen = new Set<string>()
  for (const raw of names) {
    if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || raw.length > 4_096) {
      throw new Error('archive_entry_path_invalid')
    }
    const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (!safeRelativePath(trimmed) || seen.has(trimmed)) throw new Error('archive_entry_path_invalid')
    seen.add(trimmed)
  }
}

function resolvedArchiveFormat(
  artifactPath: string,
  requested: NonNullable<GenerateReceiptOptions['archiveFormat']>,
): Exclude<NonNullable<GenerateReceiptOptions['archiveFormat']>, 'auto'> {
  if (requested !== 'auto') return requested
  const lower = artifactPath.toLowerCase()
  if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) return 'tgz'
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.dmg')) return 'dmg'
  return 'raw'
}

function exactMember(root: string, member: string): string {
  const canonicalRoot = path.resolve(fsSync.realpathSync(root))
  if (member === '.') return canonicalRoot
  if (!safeRelativePath(member)) throw new Error('archive_member_path_invalid')
  const target = path.resolve(canonicalRoot, member)
  if (!isWithinOrEqual(canonicalRoot, target)) throw new Error('archive_member_path_escape')
  if (!fsSync.existsSync(target)) throw new Error('archive_member_missing')
  const real = path.resolve(fsSync.realpathSync(target))
  if (!isWithinOrEqual(canonicalRoot, real)) throw new Error('archive_member_symlink_escape')
  return real
}

function packageTreeNodes(nodes: readonly PackageMetadataProofNode[], packageRoot: string): PackageMetadataProofNode[] {
  const root = path.resolve(packageRoot)
  return nodes.filter(node => isWithinOrEqual(root, path.resolve(node.path)))
}

function receiptProofNode(
  node: PackageMetadataProofNode,
  relativeRoot: string,
  normalization: ReceiptProofNode['normalization'],
): ReceiptProofNode {
  const relativePath = path.relative(relativeRoot, node.path).split(path.sep).join('/')
  if (!safeRelativePath(relativePath)) throw new Error('receipt_proof_path_invalid')
  return {
    role: node.role,
    relativePath,
    sha256: node.sha256,
    sizeBytes: node.size,
    executable: node.entryType === 'symlink' ? false : node.executable,
    normalization,
  }
}

function passiveFileSystem() {
  return {
    async lstat(targetPath: string) {
      try {
        const stat = await fs.lstat(targetPath)
        return {
          kind: stat.isSymbolicLink() ? 'symbolic_link' as const
            : stat.isDirectory() ? 'directory' as const
              : stat.isFile() ? 'file' as const : 'other' as const,
          mode: stat.mode & 0o7777,
          ownerUid: String(stat.uid),
          groupGid: String(stat.gid),
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    realpath: (targetPath: string) => fs.realpath(targetPath),
    readStableFileSnapshot,
    readStableFileFingerprint,
    readStablePackageTree,
    verifyStablePackageTree,
  }
}

function desktopDependencies(): DiscoveryDependencies {
  const passive = passiveFileSystem()
  return {
    fs: {
      ...passive,
      readStableFileMetadata,
      async readTextFile(targetPath, maxBytes) {
        const snapshot = await readStableFileSnapshot(targetPath, maxBytes)
        return Buffer.from(snapshot.content).toString('utf8')
      },
    },
    which: async () => undefined,
    execVersion: async () => ({ exitCode: 1, stdout: '', stderr: 'not available' }),
  }
}

export async function inspectArtifact(inputPath: string): Promise<{
  path: string
  sha256: string
  sizeBytes: number
  physicalFingerprint: string
  device: string
  inode: string
  mode: number
  linkCount: string
  mtimeNs: string
  ctimeNs: string
  ownerUid?: string
  groupGid?: string
}> {
  if (!path.isAbsolute(inputPath)) throw new Error('artifact_path_must_be_absolute')
  const requested = path.resolve(inputPath)
  const requestedStat = await fs.lstat(requested)
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) throw new Error('artifact_must_be_regular_file')
  const canonical = path.resolve(await fs.realpath(requested))
  const fingerprint = await readStableFileFingerprint(canonical, MAX_ARTIFACT_BYTES)
  if (fingerprint.size <= 0) throw new Error('artifact_empty')
  return {
    path: canonical,
    sha256: fingerprint.sha256,
    sizeBytes: fingerprint.size,
    physicalFingerprint: fingerprint.fingerprint,
    device: fingerprint.device,
    inode: fingerprint.inode,
    mode: fingerprint.mode,
    linkCount: fingerprint.linkCount,
    mtimeNs: fingerprint.mtimeNs,
    ctimeNs: fingerprint.ctimeNs,
    ownerUid: fingerprint.ownerUid,
    groupGid: fingerprint.groupGid,
  }
}

export function assertReceiptArtifactUnchanged(
  before: Awaited<ReturnType<typeof inspectArtifact>>,
  after: Awaited<ReturnType<typeof inspectArtifact>>,
): void {
  if (after.physicalFingerprint !== before.physicalFingerprint
    || after.sha256 !== before.sha256
    || after.sizeBytes !== before.sizeBytes
    || after.path !== before.path) {
    throw new Error('artifact_changed_during_receipt_generation')
  }
}

async function sha512Integrity(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new Error('artifact_size_invalid')
    }
    const hash = createHash('sha512')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0n
    while (offset < before.size) {
      const length = Number((before.size - offset) > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, Number(offset))
      if (bytesRead === 0) throw new Error('artifact_short_read')
      hash.update(buffer.subarray(0, bytesRead))
      offset += BigInt(bytesRead)
    }
    const after = await handle.stat({ bigint: true })
    if ([before.dev, before.ino, before.mode, before.size, before.nlink, before.mtimeNs, before.ctimeNs].join(':')
      !== [after.dev, after.ino, after.mode, after.size, after.nlink, after.mtimeNs, after.ctimeNs].join(':')) {
      throw new Error('artifact_changed_during_integrity_read')
    }
    return `sha512-${hash.digest('base64')}`
  } finally {
    await handle.close()
  }
}

function exactReleaseDistribution(entries: ReleaseTarget[], options: GenerateReceiptOptions): {
  target: ReleaseTarget
  distribution: ReleaseDistribution
} {
  const target = entries.find(entry => entry.catalogId === options.catalogId)
  if (!target) throw new Error('release_catalog_not_found')
  if (!target.observedExactVersions.includes(options.version)) throw new Error('version_not_in_reviewed_release_inventory')
  const matches = target.officialDistributions.filter(candidate => candidate.distributionId === options.distributionId)
  if (matches.length !== 1) throw new Error('release_distribution_not_unique')
  const distribution = matches[0]!
  if (!distribution.supportedMacArchitectures.includes(options.architecture)) {
    throw new Error('release_distribution_architecture_not_supported')
  }
  return { target, distribution }
}

function expectedNpmPackage(distribution: ReleaseDistribution): string {
  if (!distribution.packageProvenance.startsWith('npm_metadata:')) throw new Error('release_npm_provenance_invalid')
  return distribution.packageProvenance.slice('npm_metadata:'.length)
}

function expectedSignedIdentity(distribution: ReleaseDistribution): { identifier: string; teamIdentifier: string } {
  const match = distribution.packageProvenance.match(/^signed_(?:app|cli):([^:]+):([^:]+)$/u)
  if (!match) throw new Error('release_signed_provenance_invalid')
  return { identifier: match[1]!, teamIdentifier: match[2]! }
}

export function assertMachOArchitecture(executablePath: string, architecture: Architecture): void {
  if (process.platform !== 'darwin') throw new Error('signed_receipts_require_macos')
  const architectures = run('/usr/bin/lipo', ['-archs', executablePath]).trim().split(/\s+/u)
  const machArchitecture = architecture === 'x64' ? 'x86_64' : architecture
  if (!architectures.includes(machArchitecture)) throw new Error('signed_distribution_architecture_mismatch')
}

function exactHttpsUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('source_url_invalid')
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('source_url_must_be_https')
  }
  return parsed.href
}

function validateOptions(options: GenerateReceiptOptions): void {
  if (!['npm-tarball', 'signed-app', 'signed-cli', 'qwen-standalone', 'openclaw-portable'].includes(options.kind)) {
    throw new Error('receipt_kind_invalid')
  }
  if (!options.catalogId || !options.distributionId || !options.version || !ARCHITECTURES.has(options.architecture)) {
    throw new Error('receipt_identity_invalid')
  }
  if (options.outputPath && !path.isAbsolute(options.outputPath)) throw new Error('output_path_must_be_absolute')
}

function safeRelativePath(value: string): boolean {
  if (!value || value === '.' || path.posix.isAbsolute(value)) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

function normalizedNpmBinRelativePath(value: string): string | undefined {
  const normalized = value.startsWith('./') ? value.slice(2) : value
  if (!normalized || normalized.startsWith('./') || normalized.includes('\\')
    || !safeRelativePath(normalized)) return undefined
  return normalized
}

function isWithinOrEqual(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function run(command: string, args: readonly string[], maxBuffer = 64 * 1024): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) {
    throw new Error(`artifact_tool_failed:${path.basename(command)}:${result.error?.message ?? result.stderr.trim() ?? result.status}`)
  }
  return result.stdout
}

async function writeExclusiveJson(outputPath: string, value: unknown): Promise<void> {
  const requested = path.resolve(outputPath)
  const parent = path.resolve(await fs.realpath(path.dirname(requested)))
  const absolute = path.join(parent, path.basename(requested))
  const handle = await fs.open(absolute, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function parseFlags(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(usage())
    const camel = key.slice(2).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
    if (result[camel] !== undefined) throw new Error(`duplicate_flag:${key}`)
    result[camel] = value
  }
  return result
}

function usage(): string {
  return [
    'Usage:',
    '  capture-agent-distribution-receipt KIND --catalog-id ID --distribution-id ID --version VERSION --architecture arm64|x64 --artifact ABS --source-url HTTPS --output ABS [options]',
    'Kinds: npm-tarball, signed-app, signed-cli, qwen-standalone, openclaw-portable',
    'npm-tarball options: --registry-metadata ABS --bin-name NAME [--npm-components ABS_JSON]',
    'signed-app options: --member-path REL [--archive-format auto|zip|tgz|dmg]',
    'signed-cli Kimi: --member-path kimi --kimi-github-release-metadata ABS --kimi-release-manifest ABS --kimi-artifact-checksum ABS --archive-format zip',
    'signed-cli Claude: --signed-cli-manifest ABS --signed-cli-manifest-signature ABS --signed-cli-signing-key ABS [--member-path REL] [--archive-format raw]',
    'qwen-standalone options: --member-path REL [--archive-format auto|zip|tgz]',
    'openclaw-portable options: --registry-metadata ABS --npm-tarball ABS --openclaw-tag-ref-metadata ABS --openclaw-tag-object-metadata ABS --openclaw-node-artifact ABS --openclaw-node-source-url HTTPS --openclaw-node-shasums ABS --openclaw-node-shasums-source-url HTTPS',
  ].join('\n')
}

export async function runAgentDistributionReceiptCli(args: readonly string[]): Promise<Record<string, unknown>> {
  const [kind, ...rest] = args
  if (!kind) throw new Error(usage())
  const flags = parseFlags(rest)
  const required = ['catalogId', 'distributionId', 'version', 'architecture', 'artifact', 'sourceUrl', 'output']
  if (required.some(key => !flags[key])) throw new Error(usage())
  const allowed = new Set([
    ...required, 'releaseManifest', 'registryMetadata', 'npmTarball', 'npmComponents', 'memberPath', 'archiveFormat', 'binName',
    'kimiArtifactChecksum', 'kimiReleaseManifest', 'kimiGithubReleaseMetadata',
    'signedCliManifest', 'signedCliManifestSignature', 'signedCliSigningKey',
    'openclawTagRefMetadata', 'openclawTagObjectMetadata', 'openclawNodeArtifact', 'openclawNodeSourceUrl',
    'openclawNodeShasums', 'openclawNodeShasumsSourceUrl',
  ])
  const unknown = Object.keys(flags).filter(key => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`unknown_flags:${unknown.join(',')}`)
  let npmComponents: readonly NpmComponentInput[] | undefined
  if (flags.npmComponents) {
    const input = await inspectMetadataInput(flags.npmComponents, 256 * 1024)
    const value = JSON.parse(Buffer.from(input.content).toString('utf8')) as unknown
    if (!Array.isArray(value) || value.some(component => !component || typeof component !== 'object'
      || Array.isArray(component)
      || JSON.stringify(Object.keys(component).sort()) !== JSON.stringify(['installName', 'registryMetadataPath', 'tarballPath'].sort())
      || Object.values(component).some(candidate => typeof candidate !== 'string'))) {
      throw new Error('npm_components_input_invalid')
    }
    npmComponents = value as NpmComponentInput[]
  }
  return generateAgentDistributionReceipt({
    kind: kind as ReceiptKind,
    catalogId: flags.catalogId!,
    distributionId: flags.distributionId!,
    version: flags.version!,
    architecture: flags.architecture as Architecture,
    artifactPath: flags.artifact!,
    sourceUrl: flags.sourceUrl!,
    outputPath: flags.output!,
    releaseManifestPath: flags.releaseManifest,
    registryMetadataPath: flags.registryMetadata,
    npmTarballPath: flags.npmTarball,
    memberPath: flags.memberPath,
    archiveFormat: flags.archiveFormat as GenerateReceiptOptions['archiveFormat'],
    binName: flags.binName,
    npmComponents,
    kimiArtifactChecksumPath: flags.kimiArtifactChecksum,
    kimiReleaseManifestPath: flags.kimiReleaseManifest,
    kimiGitHubReleaseMetadataPath: flags.kimiGithubReleaseMetadata,
    signedCliManifestPath: flags.signedCliManifest,
    signedCliManifestSignaturePath: flags.signedCliManifestSignature,
    signedCliSigningKeyPath: flags.signedCliSigningKey,
    openclawTagRefMetadataPath: flags.openclawTagRefMetadata,
    openclawTagObjectMetadataPath: flags.openclawTagObjectMetadata,
    openclawNodeArtifactPath: flags.openclawNodeArtifact,
    openclawNodeSourceUrl: flags.openclawNodeSourceUrl,
    openclawNodeShasumsPath: flags.openclawNodeShasums,
    openclawNodeShasumsSourceUrl: flags.openclawNodeShasumsSourceUrl,
  })
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  runAgentDistributionReceiptCli(process.argv.slice(2))
    .then(result => process.stdout.write(`${JSON.stringify({ receiptSha256: result.receiptSha256 })}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
