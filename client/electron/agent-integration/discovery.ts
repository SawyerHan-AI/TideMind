import path from 'node:path'
import { createHash } from 'node:crypto'
import { getCatalogVariant } from './catalog'
import { sha256Json } from './fingerprint'
import { canonicalizeInstallationIdentity } from './identity'
import { kimiNativeReceiptLookupFingerprint } from './distribution-artifact'
import type { DiscoverInstallationInput } from './repository'
import type {
  CatalogId,
  ComponentKey,
  DistributionIdentity,
  InstallationIdentity,
  JsonValue,
} from './types'

/**
 * Phase 4 local discovery is intentionally dependency-injected. This module
 * never imports node:fs or node:child_process, never starts a host, and never
 * walks a directory tree. Production callers must provide read-only, bounded
 * implementations of these three capabilities.
 */
export interface DiscoveryPathStat {
  kind: 'file' | 'directory' | 'symbolic_link' | 'other'
  mode?: number
  ownerUid?: string
  groupGid?: string
}

export interface StableFileSnapshot {
  /** Bounded bytes read from the same open file descriptor as both fstat calls. */
  content: Uint8Array
  size: number
  mode: number
  device: string
  inode: string
  linkCount: string
  mtimeNs: string
  ctimeNs: string
  sha256: string
  /** Hash of content plus the physical file identity and executable mode. */
  fingerprint: string
  executable: boolean
  ownerUid?: string
  groupGid?: string
}

export type StableFileFingerprint = Omit<StableFileSnapshot, 'content'>

export interface PackageMetadataProofNode extends StableFileFingerprint {
  role:
    | 'package_manifest'
    | 'qwen_launcher'
    | 'qwen_inner_launcher'
    | 'qwen_standalone_manifest'
    | 'qwen_cli_entry'
    | 'qwen_node_runtime'
    | 'qwen_package_file'
    | 'kimi_install_metadata'
    | 'kimi_latest_metadata'
    | 'openclaw_wrapper'
    | 'openclaw_node_runtime'
    | 'openclaw_entry'
    | 'openclaw_package_file'
    | 'npm_install_lock'
    | 'npm_package_executable'
    | 'npm_package_file'
    | 'npm_component_manifest'
    | 'npm_component_native_executable'
    | 'npm_component_file'
  /** Canonical absolute path whose current directory entry is bound by the proof. */
  path: string
  /** Bound used by the passive inspector when it read and hashed this node. */
  maxBytes: number
  /** Portable package-owned entry semantics; omitted for non-package proof nodes. */
  entryType?: 'file' | 'symlink'
  /** Normalized relative target for a package-owned symlink, otherwise null/omitted. */
  symlinkTarget?: string | null
}

export interface StablePackageTree {
  packageTreeSha256: string
  ownedEntryCount: number
  ownedTotalBytes: number
  physicalTreeFingerprint: string
  proofNodes: readonly PackageMetadataProofNode[]
}

export interface StableFileMetadata {
  size: number
  mode: number
  device: string
  inode: string
  executable: boolean
  ownerUid?: string
  groupGid?: string
}

export const MAX_CLI_EXECUTABLE_PROOF_BYTES = 512 * 1024 * 1024
export const CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION = 1

export type ManagementEligibilityReason =
  | 'executable_proof_too_large'
  | 'executable_metadata_unavailable'
  | 'distribution_not_managed'
  | 'release_entry_missing'
  | 'release_mode_detect_only'
  | 'release_distribution_not_accepted'
  | 'release_version_unverified'
  | 'release_version_not_accepted'
  | 'release_artifact_not_accepted'

export interface ManagementEligibility {
  schemaVersion: typeof CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION
  eligible: boolean
  reason?: ManagementEligibilityReason
  executableSizeBytes?: number
  proofLimitBytes: number
}

function managementEligibilityForMetadata(metadata: StableFileMetadata): ManagementEligibility {
  if (!metadata.executable) {
    return {
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: false,
      reason: 'executable_metadata_unavailable',
      executableSizeBytes: metadata.size,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    }
  }
  if (metadata.size > MAX_CLI_EXECUTABLE_PROOF_BYTES) {
    return {
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: false,
      reason: 'executable_proof_too_large',
      executableSizeBytes: metadata.size,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    }
  }
  return {
    schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
    eligible: true,
    executableSizeBytes: metadata.size,
    proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
  }
}

function sameStableFileMetadata(left: StableFileMetadata, right: StableFileMetadata): boolean {
  return left.size === right.size
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode
    && left.executable === right.executable
    && left.ownerUid === right.ownerUid
    && left.groupGid === right.groupGid
}

export interface DiscoveryFileSystem {
  lstat(targetPath: string): Promise<DiscoveryPathStat | undefined>
  realpath(targetPath: string): Promise<string>
  /**
   * Returns a bounded snapshot of direct child names. OMP uses this only for
   * its host-owned `profiles/` registry; discovery never walks recursively.
   */
  readDirectoryNames?(targetPath: string, maxEntries: number): Promise<{
    names: readonly string[]
    truncated: boolean
  } | undefined>
  /** Reads at most maxBytes. It is only used for an app bundle's Info.plist. */
  readTextFile(targetPath: string, maxBytes: number): Promise<string>
  /**
   * Opens without following the leaf symlink, fstats before and after a bounded
   * read, and returns a proof bound to the opened inode. Production CLI trust
   * fails closed when this stronger primitive is unavailable.
   */
  readStableFileSnapshot?(targetPath: string, maxBytes: number): Promise<StableFileSnapshot>
  /** Streams large executables without allocating fileSize bytes. */
  readStableFileFingerprint?(targetPath: string, maxBytes: number): Promise<StableFileFingerprint>
  /** Bounded, no-symlink whole-package snapshot for immutable npm receipts. */
  readStablePackageTree?(targetPath: string): Promise<StablePackageTree>
  /** Metadata-only exact recheck of a previously content-hashed owned package. */
  verifyStablePackageTree?(targetPath: string, snapshot: StablePackageTree): Promise<boolean>
  /** Opens without following the leaf and returns two-fstat-stable metadata without reading content. */
  readStableFileMetadata?(targetPath: string): Promise<StableFileMetadata>
}

export interface VersionCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  /**
   * Present only when bounded package metadata or a package-manager receipt
   * proved the distribution. A node_modules/Cellar-shaped path is not proof.
   */
  verifiedPackageProvenance?: string
  /** Physical snapshot fingerprint of the bounded package metadata proof. */
  packageMetadataFingerprint?: string
  /** Exact physical files that produced packageMetadataFingerprint. */
  packageProofNodes?: readonly PackageMetadataProofNode[]
  /**
   * Machine-portable digest of immutable artifact facts. Unlike
   * packageMetadataFingerprint this must never include inode, timestamps, uid,
   * or absolute installation paths.
   */
  portableArtifactFingerprint?: string
  /** Portable content tree for package receipts that require whole-package binding. */
  packageTreeSha256?: string
  /** Exact non-root packages that make a composed npm CLI runnable. */
  npmComposition?: Readonly<{
    entryRule: string
    components: readonly Readonly<{
      role: string
      installName: string
      manifestName: string
      version: string
      integrity: string
      ownedPackageSha256: string
      ownedEntryCount: number
      ownedTotalBytes: number
      nativeExecutableRelativePath: string | null
      nativeExecutableSha256: string | null
      nativeExecutableSizeBytes: number | null
    }>[]
  }>
}

export interface AppCodeSignatureResult {
  valid: boolean
  identifier?: string
  teamIdentifier?: string
  /** Stable code-directory receipt emitted by the platform verifier. */
  cdHash?: string
  /** Exact designated requirement emitted by the platform verifier. */
  designatedRequirement?: string
  /** Proof that strict verification was the final platform operation. */
  verificationBoundary?: 'strict_final'
}

export interface AppCodeSignatureOptions {
  timeoutMs: number
  /** Live trust may bind outer App/executable identity immediately before the final verify. */
  beforeFinalVerification?: () => Promise<void>
}

function codeSignatureReceiptFingerprint(signature: AppCodeSignatureResult): string | null {
  const cdHash = signature.cdHash?.trim().toLowerCase()
  const designatedRequirement = signature.designatedRequirement?.trim()
  if (!cdHash || !/^[a-f0-9]{20,128}$/u.test(cdHash)
    || !designatedRequirement || designatedRequirement.length > 8 * 1024) return null
  return sha256Json({ cdHash, designatedRequirement })
}

export function signedKimiPortableArtifactFingerprint(input: {
  version: string | undefined
  executableArtifactFingerprint: string | undefined
  signature: AppCodeSignatureResult
}): string | undefined {
  const cdHash = input.signature.cdHash?.trim().toLowerCase()
  const designatedRequirement = input.signature.designatedRequirement?.trim()
  if (!input.version || !input.executableArtifactFingerprint
    || !input.signature.valid || input.signature.verificationBoundary !== 'strict_final'
    || !input.signature.identifier || !input.signature.teamIdentifier
    || !cdHash || !/^[a-f0-9]{20,128}$/u.test(cdHash)
    || !designatedRequirement || designatedRequirement.length > 8 * 1024) return undefined
  return createHash('sha256').update(JSON.stringify({
    schema: 'signed-cli-kimi-release-v2',
    version: input.version,
    executableArtifactFingerprint: input.executableArtifactFingerprint,
    identifier: input.signature.identifier,
    teamIdentifier: input.signature.teamIdentifier,
    cdHash,
    designatedRequirement,
  })).digest('hex')
}

const SIGNED_ARTIFACT_VERSION = /^(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/u

/**
 * Cross-machine identity for one exact signed code object. Physical paths,
 * inode/time metadata and user ownership remain local CAS inputs and are
 * intentionally excluded from the release-frozen digest.
 */
export function signedCodePortableArtifactFingerprint(input: {
  version: string | undefined
  executable: StableFileFingerprint | undefined
  signature: AppCodeSignatureResult
}): string | undefined {
  const cdHash = input.signature.cdHash?.trim().toLowerCase()
  const designatedRequirement = input.signature.designatedRequirement?.trim()
  if (!input.version || !SIGNED_ARTIFACT_VERSION.test(input.version)
    || !input.executable?.executable
    || !input.signature.valid
    || input.signature.verificationBoundary !== 'strict_final'
    || !input.signature.identifier || !input.signature.teamIdentifier
    || !cdHash || !/^[a-f0-9]{20,128}$/u.test(cdHash)
    || !designatedRequirement || designatedRequirement.length > 8 * 1024) return undefined
  return createHash('sha256').update(JSON.stringify({
    schema: 'signed-code-v1',
    version: input.version,
    executable: {
      sha256: input.executable.sha256,
      sizeBytes: input.executable.size,
      executable: true,
    },
    identifier: input.signature.identifier,
    teamIdentifier: input.signature.teamIdentifier,
    cdHash,
    designatedRequirement,
  })).digest('hex')
}

export interface DiscoveryDependencies {
  fs: DiscoveryFileSystem
  /**
   * Legacy single-candidate lookup retained for dependency-injected callers.
   * Production supplies `whichAll` so an unrelated earlier PATH executable
   * cannot shadow a later, provenance-proved official installation.
   */
  which(command: string): Promise<string | undefined>
  /** Bounded, PATH-ordered executable candidates for one exact command name. */
  whichAll?(command: string): Promise<readonly string[]>
  execVersion(
    executableRealpath: string,
    args: readonly string[],
    options: { timeoutMs: number },
  ): Promise<VersionCommandResult>
  /** Verifies a canonical app bundle with the platform code-signing service. */
  inspectAppSignature?(
    appBundleRealpath: string,
    options: AppCodeSignatureOptions,
  ): Promise<AppCodeSignatureResult>
  /**
   * Performs the final recursive platform attestation and returns the exact
   * receipt for the code object it verified. Live write trust compares this
   * receipt with the frozen Team/identifier/CDHash/Designated Requirement and
   * performs no later asynchronous file-system operation.
   */
  finalVerifyAppSignatureSync?(
    appBundleRealpath: string,
    timeoutMs: number,
  ): AppCodeSignatureResult
  /** Reads the exact thin Mach-O architecture without starting the executable. */
  inspectExecutableArchitecture?(executableRealpath: string): Promise<'arm64' | 'x64' | null>
  /** Resolves a live Kimi surface only from the frozen release receipt matrix. */
  resolveKimiNativeReceipt?(surface: {
    architecture: 'arm64' | 'x64'
    lookupFingerprint: string
  }): Readonly<{
    version: string
    portableArtifactFingerprint: string
  }> | null
}

export interface LocalDiscoveryContext {
  homeDir: string
  osUserIdentity: string
  /** Only probe-specific, non-secret overrides are read from this object. */
  environment?: Readonly<Record<string, string | undefined>>
  applicationRoots?: readonly string[]
  operationTimeoutMs?: number
  /** Platform signature verification is bounded separately from ordinary path probes. */
  signatureTimeoutMs?: number
}

export type DiscoveryEvidenceKind =
  | 'app_bundle'
  | 'bundle_id'
  | 'command'
  | 'config_root'
  | 'resource_root'
  | 'code_signature'
  | 'distribution'
  | 'realpath'
  | 'version'

export interface DiscoveryEvidence {
  kind: DiscoveryEvidenceKind
  source: string
  value: string
}

export interface DiscoveredInstallation {
  catalogId: CatalogId
  displayName: string
  identity: InstallationIdentity
  configRoot: string
  /**
   * Hosts such as QwenWork intentionally keep different components in
   * different user roots. These paths are discovery facts, not additional
   * Installations, and are persisted for a future component-specific Adapter.
   */
  componentConfigRoots?: Readonly<Partial<Record<ComponentKey, string>>>
  /** Exact config files selected by host-supported environment overrides. */
  componentConfigFiles?: Readonly<Partial<Record<ComponentKey, string>>>
  /** Host resource roots which do not select the MCP config file. */
  resourceRoots?: Readonly<Record<string, string>>
  executablePath?: string
  appPath?: string
  detectedVersion?: string
  versionDetectionMethod?: 'cli_version' | 'bundle_plist' | 'updater_metadata' | 'release_receipt'
  managementEligibility?: ManagementEligibility
  provenance: readonly string[]
  evidence: readonly DiscoveryEvidence[]
}

export type UnresolvedDiscoveryReason =
  | 'distribution_identity_unproven'
  | 'surface_identity_unproven'
  | 'multiple_installations_ambiguous'
  | 'invalid_environment_override'
  | 'probe_inaccessible'

export interface UnresolvedDiscovery {
  catalogIds: readonly CatalogId[]
  reason: UnresolvedDiscoveryReason
  summary: string
  evidence: readonly DiscoveryEvidence[]
}

export interface LocalDiscoveryReport {
  installations: readonly DiscoveredInstallation[]
  unresolved: readonly UnresolvedDiscovery[]
  diagnostics: readonly string[]
}

type ConfigRootResolver = (context: LocalDiscoveryContext) => ConfigRootResolution

interface ConfigRootResolution {
  roots: readonly string[]
  /** Stable identity root when component roots are intentionally split. */
  canonicalRoot?: string
  componentRoots?: Readonly<Partial<Record<ComponentKey, string>>>
  componentFiles?: Readonly<Partial<Record<ComponentKey, string>>>
  resourceRoots?: Readonly<Record<string, string>>
  allowDistinctComponentRoots?: boolean
  explicitProfile?: string
  invalidOverride?: string
}

interface CliProbeDefinition {
  kind: 'cli'
  catalogId: CatalogId
  commands: readonly string[]
  configRoot: ConfigRootResolver
  strongDistribution?: 'pi_official' | 'omp'
  /**
   * Some products ship both an independently provable npm channel and a
   * native/updater channel whose publisher receipt is not frozen yet. Keep
   * the latter visible under a distinct, permanently detect-only variant.
   */
  detectOnlyFallbackCatalogId?: CatalogId
  managedPackageProvenances?: readonly string[]
  /** Exact package identities for which this Catalog Adapter has write support. */
  writablePackageProvenances?: readonly string[]
  /**
   * A native single-file executable is a different trust surface from the npm
   * package. It is promoted only when the platform verifies the exact code
   * object and its publisher identity; path shape alone remains detect-only.
   */
  signedNativeFallback?: {
    identifiers: readonly string[]
    teamIdentifiers: readonly string[]
  }
}

interface AppProbeDefinition {
  kind: 'app'
  catalogId: CatalogId
  bundleNames: readonly string[]
  bundleIds: readonly string[]
  configRoot: ConfigRootResolver
  /**
   * The app bundle is only a candidate. No Installation may be created until
   * an official, read-only host registry exposes loaded Plugin/Connector
   * evidence. This is currently true for real Cowork.
   */
  requiresHostLoadedEvidence?: boolean
  /** A bundle ID alone is user-forgeable; these variants require valid signing. */
  requiredSigningTeamIds?: readonly string[]
}

export type P0DiscoveryProbe = CliProbeDefinition | AppProbeDefinition

const P0_1_DISCOVERY_IDS = [
  'claude-code-cli',
  'claude-code-native',
  'claude-desktop-legacy',
  'codex-cli',
  'codex-desktop',
  'cursor-desktop',
  'windsurf-desktop',
  'gemini-cli',
  'kimi-code-cli',
  'kimi-code-native',
  'openclaw-local',
] as const satisfies readonly CatalogId[]

const P0_2_DISCOVERY_IDS = [
  'qwen-code-cli',
  'zcode-desktop',
  'zcode-cli',
  'opencode-v1-cli',
  'opencode-v2-beta-cli',
  'pi-official-cli',
  'omp-cli',
  'qwenwork-desktop',
  'claude-cowork-local',
] as const satisfies readonly CatalogId[]

export const P0_DISCOVERY_CATALOG_IDS = Object.freeze([
  ...P0_1_DISCOVERY_IDS,
  ...P0_2_DISCOVERY_IDS,
])

function homeRoot(...segments: string[]): ConfigRootResolver {
  return context => ({ roots: [path.posix.join(context.homeDir, ...segments)] })
}

function environmentRoot(
  environmentKey: string,
  fallbackSegments: readonly string[],
  options: { valueIsFile?: boolean; profileKey?: string } = {},
): ConfigRootResolver {
  return context => {
    const override = context.environment?.[environmentKey]?.trim()
    const explicitProfile = options.profileKey
      ? context.environment?.[options.profileKey]?.trim() || undefined
      : undefined
    if (!override) {
      return { roots: [path.posix.join(context.homeDir, ...fallbackSegments)], explicitProfile }
    }
    const expanded = override === '~'
      ? context.homeDir
      : override.startsWith('~/')
        ? path.posix.join(context.homeDir, override.slice(2))
        : override
    const normalized = path.posix.normalize(expanded)
    if (!isSafeAbsolutePath(normalized)) {
      return { roots: [], explicitProfile, invalidOverride: environmentKey }
    }
    return {
      roots: [options.valueIsFile ? path.posix.dirname(normalized) : normalized],
      explicitProfile,
    }
  }
}

function openClawRoot(context: LocalDiscoveryContext): ConfigRootResolution {
  const rawHome = context.environment?.OPENCLAW_HOME?.trim()
  const rawPrefix = context.environment?.OPENCLAW_PREFIX?.trim()
  const effectiveHome = rawHome ? expandEnvironmentPath(rawHome, context.homeDir) : context.homeDir
  const prefix = rawPrefix
    ? expandEnvironmentPath(rawPrefix, context.homeDir)
    : path.posix.join(context.homeDir, '.openclaw')
  if (!isSafeAbsolutePath(effectiveHome)) return { roots: [], invalidOverride: 'OPENCLAW_HOME' }
  if (!isSafeAbsolutePath(prefix)) return { roots: [], invalidOverride: 'OPENCLAW_PREFIX' }
  const rawState = context.environment?.OPENCLAW_STATE_DIR?.trim()
  const stateRoot = path.posix.normalize(rawState
    ? expandEnvironmentPath(rawState, context.homeDir)
    : path.posix.join(effectiveHome, '.openclaw'))
  if (!isSafeAbsolutePath(stateRoot) || stateRoot === '/') return { roots: [], invalidOverride: 'OPENCLAW_STATE_DIR' }
  const rawConfig = context.environment?.OPENCLAW_CONFIG_PATH?.trim()
  const configFile = path.posix.normalize(rawConfig
    ? expandEnvironmentPath(rawConfig, context.homeDir)
    : path.posix.join(stateRoot, 'openclaw.json'))
  // The plugin command also mutates state under this root. A config outside
  // that physical domain needs a separately reviewed multi-root contract.
  if (!isSafeAbsolutePath(configFile) || path.posix.dirname(configFile) !== stateRoot
    || !['.json', '.json5'].includes(path.posix.extname(configFile))) {
    return { roots: [], invalidOverride: 'OPENCLAW_CONFIG_PATH' }
  }
  return {
    roots: [stateRoot],
    componentFiles: { memory_tools: configFile },
    resourceRoots: { openclaw_prefix: path.posix.normalize(prefix) },
  }
}

function geminiRoot(context: LocalDiscoveryContext): ConfigRootResolution {
  const home = environmentRoot('GEMINI_CLI_HOME', [])(context)
  return home.invalidOverride ? home : { roots: home.roots.map(root => path.posix.join(root, '.gemini')) }
}

function openCodeRoot(pluginFileName: 'tidemind-v1.ts' | 'tidemind-v2.ts'): ConfigRootResolver {
  return context => {
    const xdgConfigHome = context.environment?.XDG_CONFIG_HOME?.trim()
    const directoryOverride = context.environment?.OPENCODE_CONFIG_DIR?.trim()
    const fileOverride = context.environment?.OPENCODE_CONFIG?.trim()
    const expandedXdgConfigHome = xdgConfigHome
      ? expandEnvironmentPath(xdgConfigHome, context.homeDir)
      : undefined
    const expandedDirectory = directoryOverride
      ? expandEnvironmentPath(directoryOverride, context.homeDir)
      : undefined
    const expandedFile = fileOverride
      ? expandEnvironmentPath(fileOverride, context.homeDir)
      : undefined
    if (expandedXdgConfigHome !== undefined && !isSafeAbsolutePath(expandedXdgConfigHome)) {
      return { roots: [], invalidOverride: 'XDG_CONFIG_HOME' }
    }
    if (expandedDirectory !== undefined && !isSafeAbsolutePath(expandedDirectory)) {
      return { roots: [], invalidOverride: 'OPENCODE_CONFIG_DIR' }
    }
    if (expandedFile !== undefined && !isSafeAbsolutePath(expandedFile)) {
      return { roots: [], invalidOverride: 'OPENCODE_CONFIG' }
    }
    const normalizedFile = expandedFile ? path.posix.normalize(expandedFile) : undefined
    const defaultRoot = path.posix.join(
      expandedXdgConfigHome ?? path.posix.join(context.homeDir, '.config'),
      'opencode',
    )
    const resourceRoot = path.posix.normalize(expandedDirectory ?? defaultRoot)
    const configRoot = normalizedFile ? path.posix.dirname(normalizedFile) : resourceRoot
    const instructionRoot = path.posix.join(context.homeDir, '.agents', 'skills')
    return {
      // OPENCODE_CONFIG selects one exact MCP-bearing file. Otherwise OpenCode
      // reads both configuration and resources from its overridden/XDG root.
      roots: [configRoot],
      componentRoots: { instruction: instructionRoot, lifecycle: resourceRoot },
      componentFiles: {
        instruction: path.posix.join(instructionRoot, 'tidemind', 'SKILL.md'),
        ...(normalizedFile ? { memory_tools: normalizedFile } : {}),
        lifecycle: path.posix.join(resourceRoot, 'plugins', pluginFileName),
      },
      resourceRoots: { opencode_resources: resourceRoot },
    }
  }
}

function expandEnvironmentPath(value: string, homeDir: string): string {
  if (value === '~') return homeDir
  if (value.startsWith('~/')) return path.posix.join(homeDir, value.slice(2))
  return value
}

function qwenWorkRoots(context: LocalDiscoveryContext): ConfigRootResolution {
  const configRoot = path.posix.join(context.homeDir, '.qwenworkcn')
  return {
    roots: [configRoot],
    // QwenWorkCN 1.0.3 and 1.2.0 pass this exact root to its embedded agent runtime.
    // Skills and user settings are different artifacts in one Installation,
    // not profiles and not independent roots.
    canonicalRoot: configRoot,
    componentRoots: {
      instruction: configRoot,
      lifecycle: configRoot,
    },
  }
}

function devinDesktopRoots(context: LocalDiscoveryContext): ConfigRootResolution {
  const configRoot = path.posix.join(context.homeDir, '.config', 'devin')
  return {
    roots: [configRoot],
    canonicalRoot: configRoot,
    componentRoots: {
      instruction: configRoot,
      memory_tools: configRoot,
      lifecycle: configRoot,
    },
    componentFiles: {
      instruction: path.posix.join(configRoot, 'skills', 'tidemind', 'SKILL.md'),
      memory_tools: path.posix.join(configRoot, 'mcp_config.json'),
      lifecycle: path.posix.join(configRoot, 'config.json'),
    },
  }
}

const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const OMP_RESERVED_PROFILE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu

/** Resolve OMP's native user directory without importing or starting OMP. */
function ompRoot(context: LocalDiscoveryContext): ConfigRootResolution {
  const rawProfile = context.environment?.OMP_PROFILE !== undefined
    ? context.environment.OMP_PROFILE
    : context.environment?.PI_PROFILE
  const normalizedProfile = rawProfile?.trim()
  const profile = !normalizedProfile || normalizedProfile === 'default'
    ? undefined
    : normalizedProfile
  if (profile && (!OMP_PROFILE_NAME.test(profile)
    || profile.endsWith('.')
    || OMP_RESERVED_PROFILE.test(profile))) {
    return {
      roots: [],
      explicitProfile: profile,
      invalidOverride: context.environment?.OMP_PROFILE !== undefined ? 'OMP_PROFILE' : 'PI_PROFILE',
    }
  }

  const configDir = context.environment?.PI_CONFIG_DIR?.trim() || '.omp'
  if (path.posix.isAbsolute(configDir)
    || configDir.includes('\0')
    || path.posix.normalize(configDir).split('/').includes('..')) {
    return { roots: [], explicitProfile: profile, invalidOverride: 'PI_CONFIG_DIR' }
  }
  const baseRoot = path.posix.join(context.homeDir, configDir)
  if (profile) {
    return {
      roots: [path.posix.join(baseRoot, 'profiles', profile, 'agent')],
      explicitProfile: profile,
    }
  }

  const agentOverride = context.environment?.PI_CODING_AGENT_DIR?.trim()
  if (!agentOverride) return { roots: [path.posix.join(baseRoot, 'agent')] }
  const expandedAgentDir = expandEnvironmentPath(agentOverride, context.homeDir)
  if (!isSafeAbsolutePath(expandedAgentDir)) {
    return { roots: [], invalidOverride: 'PI_CODING_AGENT_DIR' }
  }
  return { roots: [path.posix.normalize(expandedAgentDir)] }
}

const OMP_PROFILE_ENUMERATION_LIMIT = 256

async function ompRootResolutions(
  context: LocalDiscoveryContext,
  dependencies: DiscoveryDependencies,
  timeoutMs: number,
): Promise<readonly ConfigRootResolution[]> {
  const selected = ompRoot(context)
  const hasExplicitProfile = context.environment?.OMP_PROFILE !== undefined
    || context.environment?.PI_PROFILE !== undefined
  if (hasExplicitProfile || selected.invalidOverride || !dependencies.fs.readDirectoryNames) {
    return [selected]
  }

  const configDir = context.environment?.PI_CONFIG_DIR?.trim() || '.omp'
  const profilesRoot = path.posix.join(context.homeDir, configDir, 'profiles')
  const snapshot = await withTimeout(
    dependencies.fs.readDirectoryNames(profilesRoot, OMP_PROFILE_ENUMERATION_LIMIT),
    timeoutMs,
  )
  if (!snapshot) return [selected]
  if (snapshot.truncated) throw new Error('omp_profile_enumeration_limit')

  const named: ConfigRootResolution[] = []
  for (const profile of [...new Set(snapshot.names)].sort((left, right) => left.localeCompare(right))) {
    if (!OMP_PROFILE_NAME.test(profile)
      || profile.endsWith('.')
      || OMP_RESERVED_PROFILE.test(profile)) continue
    const profileRoot = path.posix.join(profilesRoot, profile)
    const agentRoot = path.posix.join(profileRoot, 'agent')
    const [profileNode, agentNode] = await Promise.all([
      withTimeout(dependencies.fs.lstat(profileRoot), timeoutMs),
      withTimeout(dependencies.fs.lstat(agentRoot), timeoutMs),
    ])
    // OMP itself follows symlinks, but automatic management narrows discovery
    // to host-owned real directories. Relocated roots remain outside this
    // release contract until they receive an explicit supported path.
    if (profileNode?.kind !== 'directory' || agentNode?.kind !== 'directory') continue
    const [profileRealpath, agentRealpath] = await Promise.all([
      withTimeout(dependencies.fs.realpath(profileRoot), timeoutMs),
      withTimeout(dependencies.fs.realpath(agentRoot), timeoutMs),
    ])
    if (path.posix.normalize(profileRealpath) !== profileRoot
      || path.posix.normalize(agentRealpath) !== agentRoot) continue
    named.push({ roots: [agentRoot], explicitProfile: profile })
  }
  return [selected, ...named]
}

export const P0_DISCOVERY_PROBES: readonly P0DiscoveryProbe[] = Object.freeze([
  {
    kind: 'cli', catalogId: 'claude-code-cli', commands: ['claude'], configRoot: environmentRoot('CLAUDE_CONFIG_DIR', ['.claude']),
    detectOnlyFallbackCatalogId: 'claude-code-native',
    managedPackageProvenances: ['npm_metadata:@anthropic-ai/claude-code'],
    signedNativeFallback: {
      identifiers: ['com.anthropic.claude-code'],
      teamIdentifiers: ['Q6L2SF6YDW'],
    },
  },
  {
    kind: 'app',
    catalogId: 'claude-desktop-legacy',
    bundleNames: ['Claude.app'],
    bundleIds: ['com.anthropic.claudefordesktop'],
    // Verified locally with codesign's Developer ID chain on 2026-08-26.
    requiredSigningTeamIds: ['Q6L2SF6YDW'],
    configRoot: homeRoot('Library', 'Application Support', 'Claude'),
  },
  { kind: 'cli', catalogId: 'codex-cli', commands: ['codex'], configRoot: environmentRoot('CODEX_HOME', ['.codex']) },
  {
    kind: 'app', catalogId: 'codex-desktop', bundleNames: ['ChatGPT.app', 'Codex.app'],
    // The current official Codex desktop distribution is shipped inside ChatGPT.app.
    // Keep the historical bundle name only as an alternate name for the same exact
    // bundle ID + publisher identity; neither name is trusted on its own.
    bundleIds: ['com.openai.codex'], requiredSigningTeamIds: ['2DC432GLL2'], configRoot: environmentRoot('CODEX_HOME', ['.codex']),
  },
  {
    kind: 'app', catalogId: 'cursor-desktop', bundleNames: ['Cursor.app', 'Cursor Beta.app'],
    bundleIds: ['com.todesktop.230313mzl4w4u92'], requiredSigningTeamIds: ['VDXQ22DGB9'],
    configRoot: homeRoot('.cursor'),
  },
  {
    kind: 'app', catalogId: 'windsurf-desktop', bundleNames: ['Devin.app'],
    // Windsurf Desktop was renamed to Devin Desktop. Frozen from the official
    // arm64 3.8.20 DMG on 2026-09-04; legacy Windsurf.app is deliberately not
    // treated as the same writable surface because its contract differs.
    bundleIds: ['com.exafunction.windsurf'],
    requiredSigningTeamIds: ['83Z2LHX6XW'],
    configRoot: devinDesktopRoots,
  },
  { kind: 'cli', catalogId: 'gemini-cli', commands: ['gemini'], configRoot: geminiRoot },
  {
    kind: 'cli',
    catalogId: 'kimi-code-cli',
    commands: ['kimi', 'kimi-code'],
    configRoot: environmentRoot('KIMI_CODE_HOME', ['.kimi-code']),
    detectOnlyFallbackCatalogId: 'kimi-code-native',
    managedPackageProvenances: ['npm_metadata:@moonshot-ai/kimi-code'],
    signedNativeFallback: {
      identifiers: ['kimi'],
      teamIdentifiers: ['2J9472RW75'],
    },
  },
  { kind: 'cli', catalogId: 'openclaw-local', commands: ['openclaw'], configRoot: openClawRoot },
  {
    kind: 'cli',
    catalogId: 'qwen-code-cli',
    commands: ['qwen'],
    configRoot: environmentRoot('QWEN_HOME', ['.qwen']),
  },
  {
    kind: 'app',
    catalogId: 'zcode-desktop',
    bundleNames: ['ZCode.app'],
    bundleIds: ['dev.zcode.app'],
    requiredSigningTeamIds: ['8A5X4JJ39T'],
    configRoot: homeRoot('.zcode', 'cli'),
  },
  { kind: 'cli', catalogId: 'zcode-cli', commands: ['zcode'], configRoot: homeRoot('.zcode', 'cli') },
  {
    kind: 'cli', catalogId: 'opencode-v1-cli', commands: ['opencode'],
    configRoot: openCodeRoot('tidemind-v1.ts'),
  },
  {
    kind: 'cli', catalogId: 'opencode-v2-beta-cli', commands: ['opencode2'],
    configRoot: openCodeRoot('tidemind-v2.ts'),
  },
  {
    kind: 'cli',
    catalogId: 'pi-official-cli',
    commands: ['pi'],
    configRoot: environmentRoot('PI_CODING_AGENT_DIR', ['.pi', 'agent']),
    strongDistribution: 'pi_official',
    writablePackageProvenances: ['npm_metadata:@earendil-works/pi-coding-agent'],
  },
  {
    kind: 'cli',
    catalogId: 'omp-cli',
    commands: ['omp'],
    configRoot: ompRoot,
    strongDistribution: 'omp',
  },
  {
    kind: 'app',
    catalogId: 'qwenwork-desktop',
    bundleNames: ['QwenWorkCN.app', '千问办公.app'],
    // Frozen from the official qwenwork.cn arm64 DMG on 2026-09-04.
    // The display name is never trusted without this exact bundle + Team pair.
    bundleIds: ['cn.qwenwork.desktop.mac'],
    requiredSigningTeamIds: ['XN6U3EV979'],
    configRoot: qwenWorkRoots,
  },
  {
    kind: 'app',
    catalogId: 'claude-cowork-local',
    bundleNames: ['Claude.app'],
    bundleIds: ['com.anthropic.claudefordesktop'],
    requiredSigningTeamIds: ['Q6L2SF6YDW'],
    configRoot: homeRoot('Library', 'Application Support', 'Claude'),
    requiresHostLoadedEvidence: true,
  },
] satisfies readonly P0DiscoveryProbe[])

interface PathObservation {
  requestedPath: string
  realpath: string
  kind: 'file' | 'directory'
}

interface ProbeResult {
  installations: DiscoveredInstallation[]
  unresolved: UnresolvedDiscovery[]
  diagnostics: string[]
}

const EMPTY_RESULT = (): ProbeResult => ({ installations: [], unresolved: [], diagnostics: [] })

function isSafeAbsolutePath(value: string): boolean {
  return value.length > 1 && path.posix.isAbsolute(value) && !value.includes('\0')
}

function stableEvidence(evidence: readonly DiscoveryEvidence[]): readonly DiscoveryEvidence[] {
  const unique = new Map<string, DiscoveryEvidence>()
  for (const item of evidence) {
    const key = `${item.kind}\0${item.source}\0${item.value}`
    unique.set(key, item)
  }
  return [...unique.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind)
      || left.source.localeCompare(right.source)
      || left.value.localeCompare(right.value),
  )
}

function evidenceProvenance(evidence: readonly DiscoveryEvidence[]): readonly string[] {
  return stableEvidence(evidence).map(item => `${item.kind}:${item.source}:${item.value}`)
}

function stableErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'DiscoveryTimeoutError') return 'timeout'
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/u.test(code) ? code : 'unavailable'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Discovery operation timed out')
      error.name = 'DiscoveryTimeoutError'
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function observePath(
  dependencies: DiscoveryDependencies,
  targetPath: string,
  expectedKind: 'file' | 'directory',
  timeoutMs: number,
): Promise<PathObservation | undefined> {
  if (!isSafeAbsolutePath(targetPath)) return undefined
  const initial = await withTimeout(dependencies.fs.lstat(targetPath), timeoutMs)
  if (!initial) return undefined
  const resolved = await withTimeout(dependencies.fs.realpath(targetPath), timeoutMs)
  if (!isSafeAbsolutePath(resolved)) throw new Error('realpath_not_absolute')
  const target = initial.kind === 'symbolic_link'
    ? await withTimeout(dependencies.fs.lstat(resolved), timeoutMs)
    : initial
  if (!target || target.kind !== expectedKind) return undefined
  return { requestedPath: targetPath, realpath: path.posix.normalize(resolved), kind: expectedKind }
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/\bv?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/u)
  return match?.[1]
}

function parsePlistString(plist: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = plist.match(new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([^<]{1,512})</string>`, 'u'))
  return match?.[1]?.trim() || undefined
}

const DESKTOP_INFO_PLIST_MAX_BYTES = 256 * 1024
export const DESKTOP_BUNDLE_SURFACE_SCHEMA = 'desktop-bundle-surface-v1'

export interface StableDesktopBundleSurface {
  appRealpath: string
  infoPlistRealpath: string
  infoPlistFingerprint: string
  bundleId: string
  version?: string
  executableName: string
  executableRealpath: string
  executableMetadata: StableFileMetadata
  fingerprint: string
}

/**
 * Proves the exact Info.plist -> CFBundleExecutable relationship without
 * following a leaf symlink or reading the executable body. Every awaitable
 * step is followed by a second snapshot so a bundle update cannot splice
 * metadata from one app generation with an executable from another.
 */
export async function inspectStableDesktopBundleSurface(
  dependencies: DiscoveryDependencies,
  appBundleRealpath: string,
  timeoutMs: number,
): Promise<StableDesktopBundleSurface> {
  if (!dependencies.fs.readStableFileSnapshot || !dependencies.fs.readStableFileMetadata) {
    throw new Error('desktop_bundle_stable_probe_unavailable')
  }
  const appRealpath = path.posix.normalize(appBundleRealpath)
  const appBefore = await withTimeout(dependencies.fs.lstat(appRealpath), timeoutMs)
  if (appBefore?.kind !== 'directory'
    || path.posix.normalize(await withTimeout(dependencies.fs.realpath(appRealpath), timeoutMs)) !== appRealpath) {
    throw new Error('desktop_bundle_not_canonical_directory')
  }

  const infoPlistPath = path.posix.join(appRealpath, 'Contents', 'Info.plist')
  const infoNodeBefore = await withTimeout(dependencies.fs.lstat(infoPlistPath), timeoutMs)
  if (infoNodeBefore?.kind !== 'file') throw new Error('desktop_bundle_info_plist_not_regular')
  const infoPlistRealpath = path.posix.normalize(
    await withTimeout(dependencies.fs.realpath(infoPlistPath), timeoutMs),
  )
  if (infoPlistRealpath !== infoPlistPath) throw new Error('desktop_bundle_info_plist_not_canonical')
  const infoBefore = await withTimeout(
    dependencies.fs.readStableFileSnapshot(infoPlistPath, DESKTOP_INFO_PLIST_MAX_BYTES),
    timeoutMs,
  )
  const plist = Buffer.from(infoBefore.content).toString('utf8')
  const bundleId = parsePlistString(plist, 'CFBundleIdentifier')
  const version = parsePlistString(plist, 'CFBundleShortVersionString')
    ?? parsePlistString(plist, 'CFBundleVersion')
  const executableName = parsePlistString(plist, 'CFBundleExecutable')
  if (!bundleId) throw new Error('desktop_bundle_identifier_missing')
  if (!executableName) throw new Error('desktop_bundle_executable_missing')
  if (executableName !== path.posix.basename(executableName)
    || executableName === '.' || executableName === '..') {
    throw new Error('desktop_bundle_executable_name_invalid')
  }

  const executablePath = path.posix.join(appRealpath, 'Contents', 'MacOS', executableName)
  const executableNodeBefore = await withTimeout(dependencies.fs.lstat(executablePath), timeoutMs)
  if (executableNodeBefore?.kind !== 'file') {
    throw new Error(executableNodeBefore?.kind === 'symbolic_link'
      ? 'desktop_bundle_executable_symlink'
      : 'desktop_bundle_executable_not_regular')
  }
  const executableRealpath = path.posix.normalize(
    await withTimeout(dependencies.fs.realpath(executablePath), timeoutMs),
  )
  if (executableRealpath !== executablePath) throw new Error('desktop_bundle_executable_not_canonical')
  const executableMetadata = await withTimeout(
    dependencies.fs.readStableFileMetadata(executablePath),
    timeoutMs,
  )
  if (!executableMetadata.executable) throw new Error('desktop_bundle_executable_mode_invalid')

  const infoAfter = await withTimeout(
    dependencies.fs.readStableFileSnapshot(infoPlistPath, DESKTOP_INFO_PLIST_MAX_BYTES),
    timeoutMs,
  )
  const executableMetadataAfter = await withTimeout(
    dependencies.fs.readStableFileMetadata(executablePath),
    timeoutMs,
  )
  const [appNodeAfter, appRealpathAfter, infoNodeAfter, infoRealpathAfter, executableNodeAfter, executableRealpathAfter] = await Promise.all([
    withTimeout(dependencies.fs.lstat(appRealpath), timeoutMs),
    withTimeout(dependencies.fs.realpath(appRealpath), timeoutMs),
    withTimeout(dependencies.fs.lstat(infoPlistPath), timeoutMs),
    withTimeout(dependencies.fs.realpath(infoPlistPath), timeoutMs),
    withTimeout(dependencies.fs.lstat(executablePath), timeoutMs),
    withTimeout(dependencies.fs.realpath(executablePath), timeoutMs),
  ])
  if (appNodeAfter?.kind !== 'directory'
    || path.posix.normalize(appRealpathAfter) !== appRealpath
    || infoNodeAfter?.kind !== 'file'
    || path.posix.normalize(infoRealpathAfter) !== infoPlistPath
    || executableNodeAfter?.kind !== 'file'
    || path.posix.normalize(executableRealpathAfter) !== executablePath
    || infoAfter.fingerprint !== infoBefore.fingerprint
    || !sameStableFileMetadata(executableMetadata, executableMetadataAfter)) {
    throw new Error('desktop_bundle_surface_changed_during_probe')
  }

  const fingerprint = sha256Json({
    schema: DESKTOP_BUNDLE_SURFACE_SCHEMA,
    appRealpath,
    infoPlistRealpath,
    infoPlistFingerprint: infoBefore.fingerprint,
    bundleId,
    executableName,
    executableRealpath,
    executableMetadata,
  })
  return {
    appRealpath,
    infoPlistRealpath,
    infoPlistFingerprint: infoBefore.fingerprint,
    bundleId,
    version,
    executableName,
    executableRealpath,
    executableMetadata,
    fingerprint,
  }
}

function strongDistribution(
  kind: NonNullable<CliProbeDefinition['strongDistribution']>,
  executableRealpath: string,
  verifiedPackageProvenance: string | undefined,
  portableArtifactFingerprint: string | undefined,
): DistributionIdentity | undefined {
  const nodePackage = verifiedPackageProvenance?.startsWith('npm_metadata:')
    ? verifiedPackageProvenance.slice('npm_metadata:'.length)
    : undefined
  if (kind === 'pi_official') {
    if (nodePackage !== '@mariozechner/pi-coding-agent'
      && nodePackage !== '@earendil-works/pi-coding-agent') return undefined
    return {
      distributionId: `pi-official:${nodePackage}`,
      executableRealpath,
      packageProvenance: verifiedPackageProvenance,
      capabilityFingerprint: 'pi-official-extension-api',
      portableArtifactFingerprint,
    }
  }

  if (nodePackage !== '@oh-my-pi/pi-coding-agent') return undefined
  return {
    distributionId: 'omp:oh-my-pi',
    executableRealpath,
    packageProvenance: verifiedPackageProvenance,
    capabilityFingerprint: 'omp-native-profile',
    portableArtifactFingerprint,
  }
}

async function existingConfigRoots(
  dependencies: DiscoveryDependencies,
  resolution: ConfigRootResolution,
  timeoutMs: number,
): Promise<{
  selected: string
  componentRoots?: Readonly<Partial<Record<ComponentKey, string>>>
  componentFiles?: Readonly<Partial<Record<ComponentKey, string>>>
  resourceRoots?: Readonly<Record<string, string>>
  evidence: DiscoveryEvidence[]
  ambiguous: boolean
}> {
  const roots = [...new Set(resolution.roots.map(root => path.posix.normalize(root)))]
  const present: PathObservation[] = []
  for (const root of roots) {
    const observed = await observePath(dependencies, root, 'directory', timeoutMs)
    if (observed) present.push(observed)
  }
  const presentByRequestedPath = new Map(
    present.map(item => [path.posix.normalize(item.requestedPath), item.realpath] as const),
  )
  const canonicalRoot = resolution.canonicalRoot
    ? path.posix.normalize(resolution.canonicalRoot)
    : undefined
  const selected = canonicalRoot
    ? presentByRequestedPath.get(canonicalRoot) ?? canonicalRoot
    : present[0]?.realpath ?? roots[0]
  const componentRoots: Partial<Record<ComponentKey, string>> = {}
  const componentRootEvidence: DiscoveryEvidence[] = []
  for (const [componentKey, root] of Object.entries(resolution.componentRoots ?? {}) as Array<[ComponentKey, string]>) {
    const normalized = path.posix.normalize(root)
    const observed = presentByRequestedPath.has(normalized)
      ? { requestedPath: normalized, realpath: presentByRequestedPath.get(normalized)!, kind: 'directory' as const }
      : await observePath(dependencies, normalized, 'directory', timeoutMs)
    componentRoots[componentKey] = observed?.realpath ?? normalized
    if (observed) {
      componentRootEvidence.push({
        kind: 'config_root',
        source: observed.requestedPath,
        value: observed.realpath,
      })
    }
  }
  const componentFiles = resolution.componentFiles
    ? Object.fromEntries(Object.entries(resolution.componentFiles).map(([componentKey, file]) => {
        const normalized = path.posix.normalize(file)
        const requestedComponentRoot = resolution.componentRoots?.[componentKey as ComponentKey]
        const canonicalComponentRoot = componentRoots[componentKey as ComponentKey]
        if (requestedComponentRoot && canonicalComponentRoot) {
          const relative = path.posix.relative(path.posix.normalize(requestedComponentRoot), normalized)
          if (relative === '' || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
            throw new Error(`${componentKey}_config_file_outside_component_root`)
          }
          return [componentKey, path.posix.join(canonicalComponentRoot, relative)]
        }
        const requestedParent = path.posix.dirname(normalized)
        const canonicalParent = presentByRequestedPath.get(requestedParent) ?? requestedParent
        return [componentKey, path.posix.join(canonicalParent, path.posix.basename(normalized))]
    })) as Partial<Record<ComponentKey, string>>
    : undefined
  const resourceRoots: Record<string, string> = {}
  const resourceEvidence: DiscoveryEvidence[] = []
  for (const [resourceKey, resourceRoot] of Object.entries(resolution.resourceRoots ?? {})) {
    const normalized = path.posix.normalize(resourceRoot)
    const observed = await observePath(dependencies, normalized, 'directory', timeoutMs)
    resourceRoots[resourceKey] = observed?.realpath ?? normalized
    if (observed) {
      resourceEvidence.push({
        kind: 'resource_root',
        source: observed.requestedPath,
        value: observed.realpath,
      })
    }
  }
  return {
    selected,
    componentRoots: Object.keys(componentRoots).length > 0 ? componentRoots : undefined,
    componentFiles,
    resourceRoots: Object.keys(resourceRoots).length > 0 ? resourceRoots : undefined,
    evidence: [
      ...present.map(item => ({ kind: 'config_root' as const, source: item.requestedPath, value: item.realpath })),
      ...componentRootEvidence,
      ...resourceEvidence,
    ],
    ambiguous: resolution.allowDistinctComponentRoots !== true && (
      (present.length > 1 && new Set(present.map(item => item.realpath)).size > 1)
        || (present.length === 0 && roots.length > 1)
    ),
  }
}

function makeInstallation(
  context: LocalDiscoveryContext,
  catalogId: CatalogId,
  configRoot: string,
  distribution: DistributionIdentity,
  evidence: readonly DiscoveryEvidence[],
  options: {
    explicitProfile?: string
    executablePath?: string
    appPath?: string
    detectedVersion?: string
    versionDetectionMethod?: 'cli_version' | 'bundle_plist' | 'updater_metadata' | 'release_receipt'
    componentConfigRoots?: Readonly<Partial<Record<ComponentKey, string>>>
    componentConfigFiles?: Readonly<Partial<Record<ComponentKey, string>>>
    resourceRoots?: Readonly<Record<string, string>>
    managementEligibility?: ManagementEligibility
  } = {},
): DiscoveredInstallation {
  const variant = getCatalogVariant(catalogId)
  const normalizedEvidence = stableEvidence(evidence)
  const identity = canonicalizeInstallationIdentity({
    runtimeRealm: 'local_macos',
    osUserIdentity: context.osUserIdentity,
    productFamilyId: variant.productFamilyId,
    hostVariant: catalogId,
    configRoot,
    explicitProfile: options.explicitProfile,
    componentConfigRoots: options.componentConfigRoots,
    componentConfigFiles: options.componentConfigFiles,
    distribution,
  })
  return {
    catalogId,
    displayName: variant.displayName,
    identity,
    configRoot: identity.canonicalConfigRoot,
    componentConfigRoots: identity.componentConfigRoots,
    componentConfigFiles: identity.componentConfigFiles,
    resourceRoots: options.resourceRoots,
    executablePath: options.executablePath,
    appPath: options.appPath,
    detectedVersion: options.detectedVersion,
    versionDetectionMethod: options.versionDetectionMethod,
    managementEligibility: options.managementEligibility,
    provenance: evidenceProvenance(normalizedEvidence),
    evidence: normalizedEvidence,
  }
}

async function discoverCli(
  definition: CliProbeDefinition,
  context: LocalDiscoveryContext,
  dependencies: DiscoveryDependencies,
  timeoutMs: number,
): Promise<ProbeResult> {
  const result = EMPTY_RESULT()
  const unresolvedCatalogIds = definition.detectOnlyFallbackCatalogId
    ? [definition.catalogId, definition.detectOnlyFallbackCatalogId]
    : [definition.catalogId]
  const rootResolution = definition.configRoot(context)
  if (rootResolution.invalidOverride) {
    result.unresolved.push({
      catalogIds: unresolvedCatalogIds,
      reason: 'invalid_environment_override',
      summary: `${rootResolution.invalidOverride} is not an absolute local path.`,
      evidence: [],
    })
    return result
  }

  for (const command of definition.commands) {
    let executables: readonly string[]
    try {
      const discovered = dependencies.whichAll
        ? await withTimeout(dependencies.whichAll(command), timeoutMs)
        : [await withTimeout(dependencies.which(command), timeoutMs)]
      executables = [...new Set(discovered
        .map(candidate => candidate?.trim())
        .filter((candidate): candidate is string => Boolean(candidate)))]
        .slice(0, 256)
    } catch (error) {
      result.diagnostics.push(`${definition.catalogId}:which:${command}:${stableErrorCode(error)}`)
      result.unresolved.push({
        catalogIds: unresolvedCatalogIds,
        reason: 'probe_inaccessible',
        summary: `Unable to inspect the ${command} command path.`,
        evidence: [{ kind: 'command', source: 'PATH', value: command }],
      })
      continue
    }
    if (executables.length === 0) continue
    const commandUnresolvedStart = result.unresolved.length
    const commandInstallationsStart = result.installations.length
    for (const executable of executables) {
    if (!isSafeAbsolutePath(executable)) {
      result.unresolved.push({
        catalogIds: unresolvedCatalogIds,
        reason: 'surface_identity_unproven',
        summary: `PATH returned a non-absolute location for ${command}.`,
        evidence: [{ kind: 'command', source: 'PATH', value: command }],
      })
      continue
    }

    let observedExecutable: PathObservation | undefined
    try {
      observedExecutable = await observePath(dependencies, executable, 'file', timeoutMs)
    } catch (error) {
      result.diagnostics.push(`${definition.catalogId}:realpath:${command}:${stableErrorCode(error)}`)
    }
    if (!observedExecutable) {
      result.unresolved.push({
        catalogIds: unresolvedCatalogIds,
        reason: 'surface_identity_unproven',
        summary: `The ${command} executable could not be resolved to a regular file.`,
        evidence: [{ kind: 'command', source: 'PATH', value: command }],
      })
      continue
    }

    if (definition.catalogId === 'openclaw-local') {
      const openClawPrefix = rootResolution.resourceRoots?.openclaw_prefix
        ?? path.posix.join(context.homeDir, '.openclaw')
      const expectedAlias = path.posix.join(context.homeDir, '.local', 'bin', 'openclaw')
      const expectedWrapper = path.posix.join(openClawPrefix, 'bin', 'openclaw')
      const isPortableWrapper = observedExecutable.realpath === expectedWrapper
      if (isPortableWrapper) {
        try {
          const aliasNode = await withTimeout(dependencies.fs.lstat(executable), timeoutMs)
          const expectedUid = typeof process.getuid === 'function' ? String(process.getuid()) : undefined
          const usesDefaultAlias = path.posix.normalize(executable) === expectedAlias
          const launcherParents = usesDefaultAlias ? await Promise.all([
            path.posix.join(context.homeDir, '.local'), path.posix.join(context.homeDir, '.local', 'bin'),
          ].map(async directory => ({
            directory,
            node: await withTimeout(dependencies.fs.lstat(directory), timeoutMs),
            realpath: path.posix.normalize(await withTimeout(dependencies.fs.realpath(directory), timeoutMs)),
          }))) : []
          const directWrapper = path.posix.normalize(executable) === expectedWrapper
            && aliasNode?.kind === 'file'
          const officialAlias = usesDefaultAlias
            && aliasNode?.kind === 'symbolic_link'
            && expectedUid !== undefined
            && aliasNode.ownerUid === expectedUid
          if ((!directWrapper && !officialAlias)
            || !expectedUid
            || launcherParents.some(parent => parent.node?.kind !== 'directory'
              || parent.node.ownerUid !== expectedUid
              || typeof parent.node.mode !== 'number'
              || (parent.node.mode & 0o022) !== 0
              || parent.realpath !== parent.directory)) {
            result.unresolved.push({
              catalogIds: [definition.catalogId],
              reason: 'surface_identity_unproven',
              summary: 'OpenClaw is present, but its official launcher chain is not intact.',
              evidence: [{ kind: 'command', source: 'PATH', value: command }],
            })
            continue
          }
        } catch {
          result.unresolved.push({
            catalogIds: [definition.catalogId],
            reason: 'surface_identity_unproven',
            summary: 'OpenClaw is present, but its official launcher directories could not be proved.',
            evidence: [{ kind: 'command', source: 'PATH', value: command }],
          })
          continue
        }
      }
    }

    if (definition.catalogId === 'kimi-code-cli'
      && observedExecutable.realpath.endsWith(`${path.posix.sep}.kimi-code${path.posix.sep}bin${path.posix.sep}kimi`)
      && observedExecutable.realpath !== path.posix.join(context.homeDir, '.kimi-code', 'bin', 'kimi')) {
      result.unresolved.push({
        catalogIds: unresolvedCatalogIds,
        reason: 'surface_identity_unproven',
        summary: 'Kimi native is present outside the official per-user installation root.',
        evidence: [{ kind: 'command', source: 'PATH', value: command }],
      })
      continue
    }

    const evidence: DiscoveryEvidence[] = [
      { kind: 'command', source: 'PATH', value: command },
      { kind: 'realpath', source: executable, value: observedExecutable.realpath },
    ]
    let managementEligibility: ManagementEligibility | undefined
    let initialExecutableMetadata: StableFileMetadata | undefined
    if (dependencies.fs.readStableFileMetadata) {
      try {
        initialExecutableMetadata = await withTimeout(
          dependencies.fs.readStableFileMetadata(observedExecutable.realpath),
          timeoutMs,
        )
        managementEligibility = managementEligibilityForMetadata(initialExecutableMetadata)
      } catch (error) {
        result.diagnostics.push(`${definition.catalogId}:executable_metadata:${command}:${stableErrorCode(error)}`)
        managementEligibility = {
          schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
          eligible: false,
          reason: 'executable_metadata_unavailable',
          proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
        }
      }
    }
    let detectedVersion: string | undefined
    let verifiedPackageProvenance: string | undefined
    let packageProofNodes: readonly PackageMetadataProofNode[] | undefined
    let npmComposition: VersionCommandResult['npmComposition']
    let portableArtifactFingerprint: string | undefined
    let versionDetectionMethod: 'cli_version' | 'updater_metadata' | 'release_receipt' | undefined
    let signedNativeReceiptFingerprint: string | undefined
    const isKimiNativeSurface = definition.catalogId === 'kimi-code-cli'
      && observedExecutable.realpath === path.posix.join(context.homeDir, '.kimi-code', 'bin', 'kimi')
    if (!isKimiNativeSurface) {
      try {
        const versionResult = await withTimeout(
          dependencies.execVersion(observedExecutable.realpath, ['--version'], { timeoutMs }),
          timeoutMs,
        )
        const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.slice(0, 4096)
        verifiedPackageProvenance = versionResult.verifiedPackageProvenance
        versionDetectionMethod = 'cli_version'
        packageProofNodes = versionResult.packageProofNodes
        npmComposition = versionResult.npmComposition
        portableArtifactFingerprint = versionResult.portableArtifactFingerprint
        if (versionResult.exitCode === 0) {
          detectedVersion = parseVersion(versionOutput)
          if (detectedVersion) {
            evidence.push({ kind: 'version', source: `${command} --version`, value: detectedVersion })
          }
        } else {
          result.diagnostics.push(`${definition.catalogId}:version:${command}:exit_${versionResult.exitCode}`)
        }
      } catch (error) {
        result.diagnostics.push(`${definition.catalogId}:version:${command}:${stableErrorCode(error)}`)
      }
    }

    if (isKimiNativeSurface) {
      // Updater JSON is mutable local state, not release authority. Kimi's
      // authoritative version and portable fingerprint are resolved below
      // from the exact live signed binary and the frozen receipt matrix.
      detectedVersion = undefined
      versionDetectionMethod = undefined
      verifiedPackageProvenance = undefined
      packageProofNodes = undefined
      portableArtifactFingerprint = undefined
    }
    const isManagedPackage = !isKimiNativeSurface
      && definition.managedPackageProvenances?.includes(verifiedPackageProvenance ?? '') === true
    if (!isManagedPackage && definition.signedNativeFallback && dependencies.inspectAppSignature) {
      try {
        const signedExecutableBefore = dependencies.fs.readStableFileFingerprint
          ? await withTimeout(
              dependencies.fs.readStableFileFingerprint(
                observedExecutable.realpath,
                MAX_CLI_EXECUTABLE_PROOF_BYTES,
              ),
              timeoutMs,
            )
          : undefined
        const signature = await withTimeout(
          dependencies.inspectAppSignature(observedExecutable.realpath, {
            timeoutMs,
            beforeFinalVerification: async () => {
              const currentRealpath = await dependencies.fs.realpath(observedExecutable!.realpath)
              if (currentRealpath !== observedExecutable!.realpath) {
                throw new Error('signed_cli_realpath_changed_during_signature')
              }
              if (dependencies.fs.readStableFileMetadata && initialExecutableMetadata) {
                const currentMetadata = await dependencies.fs.readStableFileMetadata(observedExecutable!.realpath)
                if (!sameStableFileMetadata(initialExecutableMetadata, currentMetadata)) {
                  throw new Error('signed_cli_metadata_changed_during_signature')
                }
              }
              if (signedExecutableBefore && dependencies.fs.readStableFileFingerprint) {
                const currentExecutable = await withTimeout(
                  dependencies.fs.readStableFileFingerprint(
                    observedExecutable!.realpath,
                    MAX_CLI_EXECUTABLE_PROOF_BYTES,
                  ),
                  timeoutMs,
                )
                if (currentExecutable.fingerprint !== signedExecutableBefore.fingerprint) {
                  throw new Error('signed_cli_executable_changed_during_signature')
                }
              }
            },
          }),
          timeoutMs,
        )
        const signedExecutableAfter = signedExecutableBefore && dependencies.fs.readStableFileFingerprint
          ? await withTimeout(
              dependencies.fs.readStableFileFingerprint(
                observedExecutable.realpath,
                MAX_CLI_EXECUTABLE_PROOF_BYTES,
              ),
              timeoutMs,
            )
          : undefined
        const receiptFingerprint = codeSignatureReceiptFingerprint(signature)
        const isKimiNative = definition.detectOnlyFallbackCatalogId === 'kimi-code-native'
        const kimiArchitecture = isKimiNative && dependencies.inspectExecutableArchitecture
          ? await withTimeout(
              dependencies.inspectExecutableArchitecture(observedExecutable.realpath),
              timeoutMs,
            )
          : null
        const kimiLookupFingerprint = isKimiNative
          && kimiArchitecture
          && signedExecutableAfter
          && signature.identifier
          && signature.teamIdentifier
          && signature.cdHash
          && signature.designatedRequirement
          ? kimiNativeReceiptLookupFingerprint({
              architecture: kimiArchitecture,
              executableSha256: signedExecutableAfter.sha256,
              executableSizeBytes: signedExecutableAfter.size,
              identifier: signature.identifier,
              teamIdentifier: signature.teamIdentifier,
              cdHash: signature.cdHash,
              designatedRequirement: signature.designatedRequirement,
            })
          : undefined
        const kimiReleaseResolution = kimiLookupFingerprint && kimiArchitecture
          ? dependencies.resolveKimiNativeReceipt?.({
              architecture: kimiArchitecture,
              lookupFingerprint: kimiLookupFingerprint,
            }) ?? null
          : null
        if (signature.valid
          && signature.verificationBoundary === 'strict_final'
          && (!signedExecutableBefore
            || signedExecutableAfter?.fingerprint === signedExecutableBefore.fingerprint)
          && signature.identifier
          && definition.signedNativeFallback.identifiers.includes(signature.identifier)
          && signature.teamIdentifier
          && definition.signedNativeFallback.teamIdentifiers.includes(signature.teamIdentifier)
          && receiptFingerprint
          && (!isKimiNative || Boolean(kimiLookupFingerprint))) {
          verifiedPackageProvenance = `signed_cli:${signature.identifier}:${signature.teamIdentifier}`
          signedNativeReceiptFingerprint = isKimiNative
            ? kimiLookupFingerprint
            : receiptFingerprint
          if (isKimiNative && kimiReleaseResolution) {
            detectedVersion = kimiReleaseResolution.version
            versionDetectionMethod = 'release_receipt'
            portableArtifactFingerprint = kimiReleaseResolution.portableArtifactFingerprint
            evidence.push({
              kind: 'version',
              source: 'Tide Mind frozen release receipt',
              value: detectedVersion,
            })
          } else if (!isKimiNative) {
            portableArtifactFingerprint = signedCodePortableArtifactFingerprint({
              version: detectedVersion,
              executable: signedExecutableAfter,
              signature,
            })
          }
          evidence.push({
            kind: 'code_signature',
            source: signature.identifier,
            value: signature.teamIdentifier,
          })
        }
      } catch (error) {
        result.diagnostics.push(`${definition.detectOnlyFallbackCatalogId}:signature:${command}:${stableErrorCode(error)}`)
      }
    }

    const catalogId = definition.detectOnlyFallbackCatalogId
      && !isManagedPackage
      ? definition.detectOnlyFallbackCatalogId
      : definition.catalogId

    if (dependencies.fs.readStableFileMetadata) {
      try {
        const [currentRealpath, currentMetadata] = await Promise.all([
          withTimeout(dependencies.fs.realpath(observedExecutable.realpath), timeoutMs),
          withTimeout(dependencies.fs.readStableFileMetadata(observedExecutable.realpath), timeoutMs),
        ])
        if (currentRealpath !== observedExecutable.realpath
          || !initialExecutableMetadata
          || !sameStableFileMetadata(initialExecutableMetadata, currentMetadata)) {
          result.diagnostics.push(`${definition.catalogId}:executable_metadata_changed:${command}`)
          managementEligibility = {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: false,
            reason: 'executable_metadata_unavailable',
            executableSizeBytes: currentMetadata.size,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          }
        } else {
          managementEligibility = managementEligibilityForMetadata(currentMetadata)
        }
      } catch (error) {
        result.diagnostics.push(`${definition.catalogId}:executable_metadata_recheck:${command}:${stableErrorCode(error)}`)
        managementEligibility = {
          schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
          eligible: false,
          reason: 'executable_metadata_unavailable',
          proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
        }
      }
    }

    const distribution = definition.strongDistribution
      ? strongDistribution(
          definition.strongDistribution,
          observedExecutable.realpath,
          verifiedPackageProvenance,
          portableArtifactFingerprint,
        )
      : {
          // Command aliases are evidence, not distribution identity. Keeping
          // them out of the distribution ID prevents `kimi` -> `kimi-code`
          // alias churn from looking like a package replacement.
          distributionId: catalogId === 'openclaw-local'
            ? packageProofNodes?.some(node => node.role === 'openclaw_wrapper')
              ? 'cli:openclaw-local:portable-wrapper'
              : 'cli:openclaw-local:npm-global'
            : catalogId === 'qwen-code-cli'
              ? packageProofNodes?.some(node => node.role === 'qwen_launcher')
                ? 'cli:qwen-code-cli:standalone'
                : 'cli:qwen-code-cli:npm-global'
            : catalogId === 'opencode-v1-cli' || catalogId === 'opencode-v2-beta-cli'
              ? openCodeDistributionId(catalogId, npmComposition, packageProofNodes)
              : `cli:${catalogId}`,
          executableRealpath: observedExecutable.realpath,
          packageProvenance: verifiedPackageProvenance,
          capabilityFingerprint: signedNativeReceiptFingerprint
            ? `${catalogId === 'kimi-code-native' ? 'signed-cli-kimi-receipt-lookup-v1' : 'signed-cli-surface-v1'}:${signedNativeReceiptFingerprint}`
            : `cli-surface:${catalogId}`,
          portableArtifactFingerprint,
        }
    if (!distribution) {
      result.unresolved.push({
        catalogIds: [definition.catalogId],
        reason: 'distribution_identity_unproven',
        summary: `${command} exists, but its distribution does not prove the ${definition.catalogId} identity.`,
        evidence: stableEvidence(evidence),
      })
      continue
    }
    if (managementEligibility?.eligible
      && definition.writablePackageProvenances
      && !definition.writablePackageProvenances.includes(distribution.packageProvenance ?? '')) {
      managementEligibility = {
        ...managementEligibility,
        eligible: false,
        reason: 'distribution_not_managed',
      }
    }
    evidence.push({
      kind: 'distribution',
      source: distribution.distributionId ?? catalogId,
      value: distribution.packageProvenance ?? 'unknown',
    })

    let rootResolutions: readonly ConfigRootResolution[] = [rootResolution]
    if (definition.strongDistribution === 'omp') {
      try {
        rootResolutions = await ompRootResolutions(context, dependencies, timeoutMs)
      } catch (error) {
        result.diagnostics.push(`${catalogId}:profile_registry:${stableErrorCode(error)}`)
        result.unresolved.push({
          catalogIds: [catalogId],
          reason: 'probe_inaccessible',
          summary: `The ${catalogId} profile registry could not be checked authoritatively.`,
          evidence: stableEvidence(evidence),
        })
        continue
      }
    }

    for (const resolvedRoot of rootResolutions) {
      let roots: Awaited<ReturnType<typeof existingConfigRoots>>
      try {
        roots = await existingConfigRoots(dependencies, resolvedRoot, timeoutMs)
      } catch (error) {
        result.diagnostics.push(`${catalogId}:config_root:${stableErrorCode(error)}`)
        result.unresolved.push({
          catalogIds: [catalogId],
          reason: 'probe_inaccessible',
          summary: `The ${catalogId} config root could not be checked authoritatively.`,
          evidence: stableEvidence(evidence),
        })
        continue
      }
      if (roots.ambiguous) {
        result.unresolved.push({
          catalogIds: [catalogId],
          reason: 'multiple_installations_ambiguous',
          summary: `Multiple live config roots were found for ${catalogId} without a host-owned profile identity.`,
          evidence: stableEvidence([...evidence, ...roots.evidence]),
        })
        continue
      }
      result.installations.push(makeInstallation(
        context,
        catalogId,
        roots.selected,
        distribution,
        [...evidence, ...roots.evidence],
        {
          explicitProfile: resolvedRoot.explicitProfile,
          executablePath: observedExecutable.realpath,
          detectedVersion,
          versionDetectionMethod: detectedVersion ? versionDetectionMethod : undefined,
          managementEligibility,
          componentConfigRoots: roots.componentRoots,
          componentConfigFiles: roots.componentFiles,
          resourceRoots: roots.resourceRoots,
        },
      ))
    }
    }
    const commandInstallations = result.installations.slice(commandInstallationsStart)
    const provedInstallations = commandInstallations.filter(installation =>
      Boolean(installation.identity.distribution.packageProvenance),
    )
    if (provedInstallations.length > 0) {
      // Detect-only PATH observations remain useful when they are all we can
      // see, but they must not collide with or shadow an official package (or
      // signed-code) candidate for the same command.
      result.installations.splice(
        commandInstallationsStart,
        commandInstallations.length,
        ...provedInstallations,
      )
      // A PATH shadow without a valid distribution proof is diagnostic noise,
      // not uncertainty about a later official candidate. Multiple proved
      // candidates remain intact and are reconciled by stabilizeReport, which
      // preserves its existing conflict/Installation identity semantics.
      const authoritativeUnresolved = result.unresolved
        .slice(commandUnresolvedStart)
        .filter(item => item.evidence.some(evidence => evidence.kind === 'distribution'))
      result.unresolved.splice(
        commandUnresolvedStart,
        result.unresolved.length - commandUnresolvedStart,
        ...authoritativeUnresolved,
      )
    }
  }
  return result
}

function openCodeDistributionId(
  catalogId: 'opencode-v1-cli' | 'opencode-v2-beta-cli',
  composition: VersionCommandResult['npmComposition'],
  proofNodes: VersionCommandResult['packageProofNodes'],
): string {
  const leaves = composition?.components.filter(component => component.role === 'platform_leaf') ?? []
  const armName = catalogId === 'opencode-v1-cli'
    ? 'opencode-darwin-arm64'
    : '@opencode-ai/cli-darwin-arm64'
  if (leaves.length === 1 && leaves[0]?.installName === armName) {
    return `cli:${catalogId}:darwin-arm64`
  }
  const x64Base = catalogId === 'opencode-v1-cli'
    ? 'opencode-darwin-x64'
    : '@opencode-ai/cli-darwin-x64'
  const modern = leaves.find(leaf => leaf.installName === x64Base)
  const baseline = leaves.find(leaf => leaf.installName === `${x64Base}-baseline`)
  const executable = proofNodes?.find(node => node.role === 'npm_package_executable')
  if (leaves.length !== 2 || !modern || !baseline || !executable) {
    return `cli:${catalogId}:unproven-platform`
  }
  const matches = [modern, baseline].filter(leaf => (
    leaf.nativeExecutableSha256 === executable.sha256
      && leaf.nativeExecutableSizeBytes === executable.size
  ))
  if (catalogId === 'opencode-v1-cli' && matches.length === 2) {
    return 'cli:opencode-v1-cli:darwin-x64'
  }
  if (catalogId === 'opencode-v2-beta-cli' && matches.length === 1) {
    return matches[0] === baseline
      ? 'cli:opencode-v2-beta-cli:darwin-x64-baseline'
      : 'cli:opencode-v2-beta-cli:darwin-x64'
  }
  return `cli:${catalogId}:unproven-platform`
}

async function discoverApp(
  definition: AppProbeDefinition,
  context: LocalDiscoveryContext,
  dependencies: DiscoveryDependencies,
  timeoutMs: number,
  signatureTimeoutMs: number,
): Promise<ProbeResult> {
  const result = EMPTY_RESULT()
  const applicationRoots = context.applicationRoots ?? [
    '/Applications',
    path.posix.join(context.homeDir, 'Applications'),
  ]
  const candidates: PathObservation[] = []
  const inaccessibleBundles: DiscoveryEvidence[] = []
  for (const applicationRoot of applicationRoots) {
    for (const bundleName of definition.bundleNames) {
      const bundlePath = path.posix.join(applicationRoot, bundleName)
      try {
        const observed = await observePath(dependencies, bundlePath, 'directory', timeoutMs)
        if (observed) candidates.push(observed)
      } catch (error) {
        const errorCode = stableErrorCode(error)
        result.diagnostics.push(`${definition.catalogId}:app_bundle:${bundleName}:${errorCode}`)
        inaccessibleBundles.push({
          kind: 'app_bundle',
          source: bundlePath,
          value: errorCode,
        })
      }
    }
  }
  if (inaccessibleBundles.length > 0) {
    result.unresolved.push({
      catalogIds: [definition.catalogId],
      reason: 'probe_inaccessible',
      summary: `Tide Mind could not inspect every ${definition.catalogId} application location, so the previous installation state was preserved.`,
      evidence: stableEvidence(inaccessibleBundles),
    })
  }
  const uniqueCandidates = [...new Map(candidates.map(candidate => [candidate.realpath, candidate])).values()]
  if (uniqueCandidates.length === 0) return result

  if (definition.requiresHostLoadedEvidence) {
    // A generic Claude bundle is neither positive Cowork evidence nor a user-
    // actionable Cowork failure. Stay fail-closed without manufacturing an
    // unresolved item until an authoritative host-loaded registry is present.
    return result
  }

  const rootResolution = definition.configRoot(context)
  if (rootResolution.invalidOverride) {
    result.unresolved.push({
      catalogIds: [definition.catalogId],
      reason: 'invalid_environment_override',
      summary: `${rootResolution.invalidOverride} is not an absolute local path.`,
      evidence: [],
    })
    return result
  }

  for (const app of uniqueCandidates) {
    let bundleSurface: StableDesktopBundleSurface
    try {
      bundleSurface = await inspectStableDesktopBundleSurface(dependencies, app.realpath, timeoutMs)
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : stableErrorCode(error)
      result.diagnostics.push(`${definition.catalogId}:bundle_surface:${errorCode}`)
      result.unresolved.push({
        catalogIds: [definition.catalogId],
        reason: 'surface_identity_unproven',
        summary: `${path.posix.basename(app.requestedPath)} is visible, but its Info.plist/CFBundleExecutable main executable could not be bound to one stable bundle surface.`,
        evidence: stableEvidence([
          { kind: 'app_bundle', source: app.requestedPath, value: app.realpath },
        ]),
      })
      continue
    }
    if (!definition.bundleIds.includes(bundleSurface.bundleId)) {
      result.unresolved.push({
        catalogIds: [definition.catalogId],
        reason: 'distribution_identity_unproven',
        summary: `${path.posix.basename(app.requestedPath)} exists, but its bundle identity is not an approved ${definition.catalogId} distribution.`,
        evidence: stableEvidence([
          { kind: 'app_bundle', source: app.requestedPath, value: app.realpath },
          { kind: 'bundle_id', source: 'Info.plist', value: bundleSurface.bundleId },
        ]),
      })
      continue
    }
    let signingTeamIdentifier: string | undefined
    let signedPortableArtifactFingerprint: string | undefined
    if (definition.requiredSigningTeamIds && definition.requiredSigningTeamIds.length > 0) {
      if (!dependencies.inspectAppSignature) {
        result.unresolved.push({
          catalogIds: [definition.catalogId],
          reason: 'distribution_identity_unproven',
          summary: `${path.posix.basename(app.requestedPath)} has an approved bundle ID, but its code signature could not be verified.`,
          evidence: stableEvidence([
            { kind: 'app_bundle', source: app.requestedPath, value: app.realpath },
            { kind: 'bundle_id', source: 'Info.plist', value: bundleSurface.bundleId },
          ]),
        })
        continue
      }
      let signature: AppCodeSignatureResult
      let executableArtifactBefore: StableFileFingerprint | undefined
      try {
        executableArtifactBefore = dependencies.fs.readStableFileFingerprint
          ? await withTimeout(
              dependencies.fs.readStableFileFingerprint(
                bundleSurface.executableRealpath,
                MAX_CLI_EXECUTABLE_PROOF_BYTES,
              ),
              timeoutMs,
            )
          : undefined
        signature = await withTimeout(
          dependencies.inspectAppSignature(app.realpath, {
            timeoutMs: signatureTimeoutMs,
            beforeFinalVerification: async () => {
              const currentSurface = await inspectStableDesktopBundleSurface(
                dependencies,
                app.realpath,
                timeoutMs,
              )
              if (currentSurface.fingerprint !== bundleSurface.fingerprint) {
                throw new Error('desktop_bundle_surface_changed_during_signature')
              }
              if (executableArtifactBefore && dependencies.fs.readStableFileFingerprint) {
                const currentExecutable = await withTimeout(
                  dependencies.fs.readStableFileFingerprint(
                    bundleSurface.executableRealpath,
                    MAX_CLI_EXECUTABLE_PROOF_BYTES,
                  ),
                  timeoutMs,
                )
                if (currentExecutable.fingerprint !== executableArtifactBefore.fingerprint) {
                  throw new Error('desktop_bundle_executable_changed_during_signature')
                }
              }
            },
          }),
          signatureTimeoutMs,
        )
      } catch (error) {
        const surfaceChanged = error instanceof Error
          && error.message.startsWith('desktop_bundle_')
        result.diagnostics.push(`${definition.catalogId}:code_signature:${surfaceChanged ? error.message : stableErrorCode(error)}`)
        result.unresolved.push({
          catalogIds: [definition.catalogId],
          reason: surfaceChanged ? 'surface_identity_unproven' : 'distribution_identity_unproven',
          summary: surfaceChanged
            ? `${path.posix.basename(app.requestedPath)} changed while Tide Mind verified its signed bundle surface.`
            : `${path.posix.basename(app.requestedPath)} has an approved bundle ID, but its code signature could not be verified.`,
          evidence: stableEvidence([
            { kind: 'app_bundle', source: app.requestedPath, value: app.realpath },
            { kind: 'bundle_id', source: 'Info.plist', value: bundleSurface.bundleId },
          ]),
        })
        continue
      }
      try {
        const surfaceAfterSignature = await inspectStableDesktopBundleSurface(
          dependencies,
          app.realpath,
          timeoutMs,
        )
        const executableArtifactAfter = executableArtifactBefore && dependencies.fs.readStableFileFingerprint
          ? await withTimeout(
              dependencies.fs.readStableFileFingerprint(
                bundleSurface.executableRealpath,
                MAX_CLI_EXECUTABLE_PROOF_BYTES,
              ),
              timeoutMs,
            )
          : undefined
        if (surfaceAfterSignature.fingerprint !== bundleSurface.fingerprint) {
          throw new Error('desktop_bundle_surface_changed_after_signature')
        }
        if (executableArtifactBefore
          && executableArtifactAfter?.fingerprint !== executableArtifactBefore.fingerprint) {
          throw new Error('desktop_bundle_executable_changed_after_signature')
        }
        signedPortableArtifactFingerprint = signedCodePortableArtifactFingerprint({
          version: bundleSurface.version,
          executable: executableArtifactAfter,
          signature,
        })
      } catch (error) {
        const errorCode = error instanceof Error ? error.message : stableErrorCode(error)
        result.diagnostics.push(`${definition.catalogId}:bundle_surface_post_signature:${errorCode}`)
        result.unresolved.push({
          catalogIds: [definition.catalogId],
          reason: 'surface_identity_unproven',
          summary: `${path.posix.basename(app.requestedPath)} changed while Tide Mind verified its signed main executable.`,
          evidence: stableEvidence([
            { kind: 'app_bundle', source: app.requestedPath, value: app.realpath },
            { kind: 'bundle_id', source: 'Info.plist', value: bundleSurface.bundleId },
          ]),
        })
        continue
      }
      signingTeamIdentifier = signature.teamIdentifier
      if (!signature.valid
        || signature.identifier !== bundleSurface.bundleId
        || !signingTeamIdentifier
        || !definition.requiredSigningTeamIds.includes(signingTeamIdentifier)) {
        result.unresolved.push({
          catalogIds: [definition.catalogId],
          reason: 'distribution_identity_unproven',
          summary: `${path.posix.basename(app.requestedPath)} is not signed by an approved ${definition.catalogId} publisher.`,
          evidence: stableEvidence([
            { kind: 'app_bundle', source: app.requestedPath, value: app.realpath },
            { kind: 'bundle_id', source: 'Info.plist', value: bundleSurface.bundleId },
            ...(signingTeamIdentifier ? [{
              kind: 'code_signature' as const,
              source: signature.identifier ?? 'unknown',
              value: signingTeamIdentifier,
            }] : []),
          ]),
        })
        continue
      }
    }
    const executableRealpath = bundleSurface.executableRealpath
    const evidence: DiscoveryEvidence[] = [
      { kind: 'app_bundle', source: app.requestedPath, value: app.realpath },
      { kind: 'realpath', source: app.requestedPath, value: app.realpath },
    ]
    evidence.push({ kind: 'bundle_id', source: 'Info.plist', value: bundleSurface.bundleId })
    if (signingTeamIdentifier) {
      evidence.push({ kind: 'code_signature', source: bundleSurface.bundleId, value: signingTeamIdentifier })
    }
    if (bundleSurface.version) evidence.push({ kind: 'version', source: 'Info.plist', value: bundleSurface.version })
    let roots: Awaited<ReturnType<typeof existingConfigRoots>>
    try {
      roots = await existingConfigRoots(dependencies, rootResolution, timeoutMs)
    } catch (error) {
      result.diagnostics.push(`${definition.catalogId}:config_root:${stableErrorCode(error)}`)
      result.unresolved.push({
        catalogIds: [definition.catalogId],
        reason: 'probe_inaccessible',
        summary: `The ${definition.catalogId} config root could not be checked authoritatively.`,
        evidence: stableEvidence(evidence),
      })
      continue
    }
    if (roots.ambiguous) {
      result.unresolved.push({
        catalogIds: [definition.catalogId],
        reason: 'multiple_installations_ambiguous',
        summary: `Multiple live config roots were found for ${definition.catalogId} without a proven version/profile owner.`,
        evidence: stableEvidence([...evidence, ...roots.evidence]),
      })
      continue
    }
    const configRoot = roots.selected
    const distribution: DistributionIdentity = {
      distributionId: bundleSurface.bundleId,
      executableRealpath,
      packageProvenance: signingTeamIdentifier
        ? `signed_app:${bundleSurface.bundleId}:${signingTeamIdentifier}`
        : `app_bundle:${bundleSurface.bundleId}`,
      capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:${bundleSurface.fingerprint}`,
      portableArtifactFingerprint: signedPortableArtifactFingerprint,
    }
    evidence.push({
      kind: 'distribution',
      source: distribution.distributionId ?? definition.catalogId,
      value: distribution.packageProvenance ?? 'app_bundle',
    })
    result.installations.push(makeInstallation(
      context,
      definition.catalogId,
      configRoot,
      distribution,
      [...evidence, ...roots.evidence],
      {
        appPath: app.realpath,
        executablePath: executableRealpath,
        detectedVersion: bundleSurface.version,
        versionDetectionMethod: bundleSurface.version ? 'bundle_plist' : undefined,
        componentConfigRoots: roots.componentRoots,
        componentConfigFiles: roots.componentFiles,
        resourceRoots: roots.resourceRoots,
      },
    ))
  }
  return result
}

function stabilizeReport(results: readonly ProbeResult[]): LocalDiscoveryReport {
  const allInstallations = results.flatMap(result => result.installations)
  const byKey = new Map<string, DiscoveredInstallation[]>()
  for (const installation of allInstallations) {
    const list = byKey.get(installation.identity.installKey) ?? []
    list.push(installation)
    byKey.set(installation.identity.installKey, list)
  }

  const installations: DiscoveredInstallation[] = []
  const collisions: UnresolvedDiscovery[] = []
  for (const candidates of byKey.values()) {
    const physicalSurfaces = new Set(candidates.map(candidate => JSON.stringify([
      candidate.catalogId,
      candidate.executablePath ?? null,
      candidate.appPath ?? null,
    ])))
    if (physicalSurfaces.size === 1) {
      const selected = [...candidates].sort((left, right) =>
        (left.executablePath ?? left.appPath ?? '').localeCompare(right.executablePath ?? right.appPath ?? ''),
      )[0]
      const evidence = stableEvidence(candidates.flatMap(candidate => candidate.evidence))
      installations.push({
        ...selected,
        evidence,
        provenance: evidenceProvenance(evidence),
      })
      continue
    }
    collisions.push({
      catalogIds: [...new Set(candidates.map(candidate => candidate.catalogId))].sort(),
      reason: 'multiple_installations_ambiguous',
      summary: 'Multiple distributions resolve to the same stable Installation scope.',
      evidence: stableEvidence(candidates.flatMap(candidate => candidate.evidence)),
    })
  }

  installations.sort((left, right) =>
    left.catalogId.localeCompare(right.catalogId)
      || left.identity.explicitProfile.localeCompare(right.identity.explicitProfile)
      || left.identity.installKey.localeCompare(right.identity.installKey),
  )
  const unresolved = [...results.flatMap(result => result.unresolved), ...collisions]
    .map(item => ({ ...item, evidence: stableEvidence(item.evidence) }))
    .sort((left, right) =>
      left.catalogIds.join(',').localeCompare(right.catalogIds.join(','))
        || left.reason.localeCompare(right.reason)
        || left.summary.localeCompare(right.summary),
    )
  const diagnostics = [...new Set(results.flatMap(result => result.diagnostics))].sort()
  return { installations, unresolved, diagnostics }
}

/**
 * Discover the reviewed P0.1/P0.2 macOS surfaces using exact, bounded probes.
 * The function has no persistence or external side effects.
 */
export async function discoverLocalP0Agents(
  context: LocalDiscoveryContext,
  dependencies: DiscoveryDependencies,
): Promise<LocalDiscoveryReport> {
  if (!isSafeAbsolutePath(context.homeDir)) throw new Error('homeDir must be an absolute local path')
  const timeoutMs = Math.max(10, Math.min(context.operationTimeoutMs ?? 2_500, 30_000))
  const signatureTimeoutMs = Math.max(
    timeoutMs,
    Math.min(context.signatureTimeoutMs ?? timeoutMs, 60_000),
  )
  const results = await Promise.all(P0_DISCOVERY_PROBES.map(probe =>
    probe.kind === 'cli'
      ? discoverCli(probe, context, dependencies, timeoutMs)
      : discoverApp(probe, context, dependencies, timeoutMs, signatureTimeoutMs),
  ))
  return stabilizeReport(results)
}

/**
 * Read-only candidate probe used only after the user explicitly starts the
 * Cowork guided setup flow. Passive discovery still refuses to create a
 * Cowork Installation from the shared Claude.app bundle alone.
 */
export async function discoverClaudeCoworkGuidedCandidate(
  context: LocalDiscoveryContext,
  dependencies: DiscoveryDependencies,
): Promise<LocalDiscoveryReport> {
  if (!isSafeAbsolutePath(context.homeDir)) throw new Error('homeDir must be an absolute local path')
  const timeoutMs = Math.max(10, Math.min(context.operationTimeoutMs ?? 2_500, 30_000))
  const signatureTimeoutMs = Math.max(timeoutMs, Math.min(context.signatureTimeoutMs ?? timeoutMs, 60_000))
  const definition = P0_DISCOVERY_PROBES.find(probe => probe.catalogId === 'claude-cowork-local')
  if (!definition || definition.kind !== 'app') throw new Error('claude Cowork discovery contract is unavailable')
  return stabilizeReport([await discoverApp({
    ...definition,
    requiresHostLoadedEvidence: false,
  }, context, dependencies, timeoutMs, signatureTimeoutMs)])
}

/** Pure adapter from a confirmed observation to the v34 repository contract. */
export function toDiscoverInstallationInput(
  installation: DiscoveredInstallation,
  input: { id: string; lastDetectedAt: string },
): DiscoverInstallationInput {
  const variant = getCatalogVariant(installation.catalogId)
  const metadata: Record<string, JsonValue> = {
    discoverySchemaVersion: 1,
    evidence: installation.evidence.map(item => ({
      kind: item.kind,
      source: item.source,
      value: item.value,
    })),
    explicitProfile: installation.identity.explicitProfile,
    hostOwnedIdentity: installation.identity.hostOwnedIdentity ?? null,
    distribution: {
      distributionId: installation.identity.distribution.distributionId ?? null,
      executableRealpath: installation.identity.distribution.executableRealpath ?? null,
      packageProvenance: installation.identity.distribution.packageProvenance ?? null,
      capabilityFingerprint: installation.identity.distribution.capabilityFingerprint ?? null,
      portableArtifactFingerprint: installation.identity.distribution.portableArtifactFingerprint ?? null,
    },
    componentConfigRoots: installation.componentConfigRoots ?? {},
    componentConfigFiles: installation.identity.componentConfigFiles ?? {},
    resourceRoots: installation.resourceRoots ?? {},
    managementEligibility: installation.managementEligibility
      ? {
          schemaVersion: installation.managementEligibility.schemaVersion,
          eligible: installation.managementEligibility.eligible,
          reason: installation.managementEligibility.reason ?? null,
          executableSizeBytes: installation.managementEligibility.executableSizeBytes ?? null,
          proofLimitBytes: installation.managementEligibility.proofLimitBytes,
        }
      : null,
  }
  return {
    id: input.id,
    family: installation.identity.productFamilyId,
    hostVariant: installation.catalogId,
    runtimeRealm: installation.identity.runtimeRealm,
    profileId: installation.identity.explicitProfile,
    installKey: installation.identity.installKey,
    distributionId: installation.identity.distribution.distributionId ?? null,
    provenance: installation.provenance.join('\n'),
    osUserIdentity: installation.identity.osUserIdentity,
    displayName: installation.displayName,
    configRoot: installation.configRoot,
    executablePath: installation.executablePath ?? null,
    appPath: installation.appPath ?? null,
    detectedVersion: installation.detectedVersion ?? null,
    versionDetectionMethod: installation.versionDetectionMethod ?? null,
    supportedCapability: variant.maxCapability,
    lastDetectedAt: input.lastDetectedAt,
    metadata,
  }
}
