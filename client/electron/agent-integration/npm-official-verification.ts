import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  AGENT_INTEGRATION_RELEASE_ENTRY_MAP,
  type AgentReleaseEntry,
  type AgentReleaseMacArchitecture,
} from './release-manifest'
import type { CatalogId } from './types'
import type { VersionCommandResult } from './discovery'
import { inspectPassiveCliVersionForArchitecture } from './passive-cli-version'
import {
  npmComposedDistributionSpec,
  type NpmComposedComponentSpec,
  type NpmComposedDistributionSpec,
} from './npm-distribution-topology'
import {
  DEFAULT_NPM_TARBALL_EXTRACTION_LIMITS,
  NPM_TARBALL_LIMIT_ERROR_PREFIX,
  OPENCLAW_LIFECYCLE_MARKER,
  createPassiveVersionFileSystem,
  materializeCopiedPlatformBinary,
  normalizedNpmBinRelativePath,
  removeStagedNpmHiddenLockfile,
  stageNpmTarball,
  staticallyCompleteOpenClawPackageLifecycle,
  type NpmTarballExtractionLimits,
  type StagedNpmPackage,
} from './npm-tarball-staging'

/**
 * Runtime official-source verification for npm-distributed external Agents.
 *
 * For the exact locally installed version it fetches the official registry
 * version document and tarball(s) from https://registry.npmjs.org only,
 * verifies the registry sha512 integrity over the downloaded bytes, statically
 * stages the packages the way `npm install` lays them out (no lifecycle script
 * and no downloaded code is ever executed), then runs the very same passive
 * discovery proof used at runtime to compute the official portable artifact
 * fingerprint and compares it with the local one. Both npm surfaces are
 * reproduced: the locked one (hidden lockfile with registry integrity, the
 * frozen-receipt schema) and the integrity-free lockless one that every
 * `npm install -g` produces; a lockless local surface can only become trusted
 * here, never through a frozen receipt.
 */

export const NPM_OFFICIAL_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
/** Part of the cache key: bump whenever staging or comparison semantics change. */
export const NPM_OFFICIAL_VERIFIER_VERSION = 'npm-official-verification-v1'

export interface NpmOfficialVerificationLimits {
  maxMetadataBytes: number
  maxTarballBytes: number
  /** Sum of every tarball downloaded for one verification (root + components). */
  maxTotalDownloadBytes: number
  metadataTimeoutMs: number
  tarballTimeoutMs: number
  /** Wall-clock budget for the whole network phase of one verification. */
  totalTimeoutMs: number
  /** A cached mismatch is re-checked online after this age. */
  mismatchCacheTtlMs: number
  /** Maximum `bin` entries tried when the caller does not name the executable. */
  maxBinCandidates: number
  extraction: NpmTarballExtractionLimits
}

export const DEFAULT_NPM_OFFICIAL_VERIFICATION_LIMITS: Readonly<NpmOfficialVerificationLimits> = Object.freeze({
  maxMetadataBytes: 5 * 1024 * 1024,
  maxTarballBytes: 300 * 1024 * 1024,
  maxTotalDownloadBytes: 900 * 1024 * 1024,
  metadataTimeoutMs: 30_000,
  tarballTimeoutMs: 180_000,
  totalTimeoutMs: 600_000,
  mismatchCacheTtlMs: 24 * 60 * 60 * 1000,
  maxBinCandidates: 8,
  extraction: DEFAULT_NPM_TARBALL_EXTRACTION_LIMITS,
})

export type NpmOfficialVerificationUnavailableReason =
  | 'offline'
  | 'timeout'
  | 'http_error'
  | 'too_large'
  | 'integrity_mismatch'
  | 'protocol'

export type NpmOfficialVerificationResult =
  | { status: 'verified'; officialFingerprint: string; checkedAt: string; evidence: 'registry' | 'cache' }
  | { status: 'mismatch'; officialFingerprint: string; checkedAt: string }
  | {
    status: 'unavailable'
    reason: NpmOfficialVerificationUnavailableReason
    checkedAt: string
    /** Stable diagnostic code; never contains local paths or response bodies. */
    detail?: string
  }
  | { status: 'unsupported'; reason: string }

export interface NpmOfficialVerificationInput {
  catalogId: CatalogId | string
  distributionId: string
  packageProvenance: string
  version: string
  architecture: AgentReleaseMacArchitecture
  localPortableArtifactFingerprint: string
  portableFingerprintSchema?: string
  /**
   * Package-relative path of the local npm executable (the discovery
   * `npm_package_executable` proof node). Optional: without it every declared
   * `bin` target of the official package is tried.
   */
  executableRelativePath?: string
}

export interface NpmOfficialVerificationCacheKey {
  distributionId: string
  packageProvenance: string
  version: string
  architecture: AgentReleaseMacArchitecture
  localPortableArtifactFingerprint: string
  verifierVersion: string
}

export interface NpmOfficialVerificationEvidence {
  packages: readonly {
    role: 'root' | 'platform_selector' | 'platform_leaf'
    packageName: string
    installName: string
    version: string
    integrity: string
    tarballUrl: string
    tarballBytes: number
  }[]
}

export interface NpmOfficialVerificationCacheRecord extends NpmOfficialVerificationCacheKey {
  status: 'verified' | 'mismatch'
  officialFingerprint: string
  checkedAt: string
  evidence: NpmOfficialVerificationEvidence
}

export interface NpmOfficialVerificationCache {
  get(key: NpmOfficialVerificationCacheKey): NpmOfficialVerificationCacheRecord | null
  put(record: NpmOfficialVerificationCacheRecord): void
}

export type NpmOfficialVerificationFetch = (
  url: string,
  init: { method: 'GET'; redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>

export interface NpmOfficialVerificationDependencies {
  fetch?: NpmOfficialVerificationFetch
  /** Epoch milliseconds used for `checkedAt` and cache freshness. */
  now?: () => number
  cache?: NpmOfficialVerificationCache
  /** Convenience: builds the SQLite cache (agent_npm_official_verifications). */
  db?: Database.Database
  /** Parent of the private per-verification staging directory. */
  tempRoot?: string
  limits?: Partial<Omit<NpmOfficialVerificationLimits, 'extraction'>> & {
    extraction?: Partial<NpmTarballExtractionLimits>
  }
}

/** Distributions whose installed tree is produced by code we must not execute. */
const SOURCE_CONFIRMATION_REQUIRED_DISTRIBUTIONS: ReadonlyMap<string, string> = new Map([
  ['cli:openclaw-local:portable-wrapper', 'portable_wrapper_postinstall_not_statically_reproducible'],
  ['cli:qwen-code-cli:standalone', 'standalone_archive_has_no_registry_integrity'],
])

const OPENCLAW_NPM_GLOBAL_DISTRIBUTION = 'cli:openclaw-local:npm-global'
const VERSION = /^(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const SHA256_HEX = /^[a-f0-9]{64}$/u
const INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/u

export type NpmPortableFingerprintSchema =
  | 'npm-owned-package-surface-v1'
  | 'npm-composed-platform-surface-v1'
  | 'npm-owned-package-surface-lockless-v1'
  | 'npm-composed-platform-surface-lockless-v1'

export interface NpmOfficialVerificationTarget {
  catalogId: CatalogId
  distributionId: string
  packageProvenance: string
  packageName: string
  version: string
  architecture: AgentReleaseMacArchitecture
  composition: NpmComposedDistributionSpec | null
  /** The requested schema, or the locked (receipt) schema when none was named. */
  portableFingerprintSchema: NpmPortableFingerprintSchema
  /**
   * Official surfaces computed and compared, in order. The locked surface is
   * produced from the staged tree with the registry integrity recorded in its
   * hidden lockfile; the lockless surface from the same tree after that
   * lockfile is removed (what every `npm install -g` leaves behind). A caller
   * that does not name its schema gets both: the schema string is part of
   * each digest, so a local fingerprint can only equal the official one of its
   * own schema.
   */
  candidateSchemas: readonly NpmPortableFingerprintSchema[]
}

/**
 * Pure, offline resolution of what an official verification would fetch.
 * Returns the `unsupported` result for anything that is not an official npm
 * distribution this verifier can statically reproduce.
 */
export function resolveNpmOfficialVerificationTarget(
  input: Pick<NpmOfficialVerificationInput, 'catalogId' | 'distributionId' | 'packageProvenance' | 'version'
    | 'architecture' | 'portableFingerprintSchema'>,
  entry: AgentReleaseEntry | undefined = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(input.catalogId as CatalogId),
): NpmOfficialVerificationTarget | { status: 'unsupported'; reason: string } {
  if (!entry) return { status: 'unsupported', reason: 'release_entry_missing' }
  const distribution = entry.officialDistributions.find(candidate => (
    candidate.distributionId === input.distributionId
  ))
  if (!distribution) return { status: 'unsupported', reason: 'distribution_not_official' }
  if (distribution.channel !== 'npm') return { status: 'unsupported', reason: 'distribution_not_npm' }
  if (distribution.packageProvenance !== input.packageProvenance) {
    return { status: 'unsupported', reason: 'package_provenance_mismatch' }
  }
  const confirmation = SOURCE_CONFIRMATION_REQUIRED_DISTRIBUTIONS.get(distribution.distributionId)
  if (confirmation) return { status: 'unsupported', reason: confirmation }
  if (input.architecture !== 'arm64' && input.architecture !== 'x64') {
    return { status: 'unsupported', reason: 'architecture_invalid' }
  }
  if (!distribution.supportedMacArchitectures.includes(input.architecture)) {
    return { status: 'unsupported', reason: 'architecture_not_supported' }
  }
  if (typeof input.version !== 'string' || !VERSION.test(input.version)) {
    return { status: 'unsupported', reason: 'version_invalid' }
  }
  if (!distribution.packageProvenance.startsWith('npm_metadata:')) {
    return { status: 'unsupported', reason: 'package_provenance_invalid' }
  }
  const packageName = distribution.packageProvenance.slice('npm_metadata:'.length)
  if (!PACKAGE_NAME.test(packageName)) return { status: 'unsupported', reason: 'package_name_invalid' }
  const composition = npmComposedDistributionSpec(
    packageName,
    input.version,
    input.architecture,
    distribution.distributionId.endsWith(':darwin-x64-baseline') ? 'baseline' : 'modern',
  )
  if (composition && composition.components.some(component => (
    !PACKAGE_NAME.test(component.manifestName) || !PACKAGE_NAME.test(component.installName)
    || !VERSION.test(component.version)
  ))) return { status: 'unsupported', reason: 'composition_invalid' }
  const lockedSchema: NpmPortableFingerprintSchema = composition
    ? 'npm-composed-platform-surface-v1'
    : 'npm-owned-package-surface-v1'
  const locklessSchema: NpmPortableFingerprintSchema = composition
    ? 'npm-composed-platform-surface-lockless-v1'
    : 'npm-owned-package-surface-lockless-v1'
  if (input.portableFingerprintSchema !== undefined
    && input.portableFingerprintSchema !== lockedSchema
    && input.portableFingerprintSchema !== locklessSchema) {
    return { status: 'unsupported', reason: 'portable_fingerprint_schema_mismatch' }
  }
  const portableFingerprintSchema = (input.portableFingerprintSchema ?? lockedSchema) as NpmPortableFingerprintSchema
  return {
    catalogId: entry.catalogId,
    distributionId: distribution.distributionId,
    packageProvenance: distribution.packageProvenance,
    packageName,
    version: input.version,
    architecture: input.architecture,
    composition,
    portableFingerprintSchema,
    candidateSchemas: input.portableFingerprintSchema === undefined
      ? [lockedSchema, locklessSchema]
      : [portableFingerprintSchema],
  }
}

class VerificationFailure extends Error {
  constructor(readonly reason: NpmOfficialVerificationUnavailableReason, readonly detail: string) {
    super(`${reason}:${detail}`)
  }
}

class UnsupportedDuringVerification extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

const inFlight = new Map<string, Promise<NpmOfficialVerificationResult>>()

export async function verifyNpmOfficialDistribution(
  input: NpmOfficialVerificationInput,
  deps: NpmOfficialVerificationDependencies = {},
): Promise<NpmOfficialVerificationResult> {
  const target = resolveNpmOfficialVerificationTarget(input)
  if ('status' in target) return target
  if (typeof input.localPortableArtifactFingerprint !== 'string'
    || !SHA256_HEX.test(input.localPortableArtifactFingerprint)) {
    return { status: 'unsupported', reason: 'local_fingerprint_invalid' }
  }
  let executableRelativePath: string | undefined
  if (input.executableRelativePath !== undefined) {
    executableRelativePath = normalizedNpmBinRelativePath(input.executableRelativePath)
    if (!executableRelativePath) return { status: 'unsupported', reason: 'executable_relative_path_invalid' }
  }
  const key: NpmOfficialVerificationCacheKey = {
    distributionId: target.distributionId,
    packageProvenance: target.packageProvenance,
    version: target.version,
    architecture: target.architecture,
    localPortableArtifactFingerprint: input.localPortableArtifactFingerprint,
    verifierVersion: NPM_OFFICIAL_VERIFIER_VERSION,
  }
  const flightKey = JSON.stringify([key, executableRelativePath ?? null])
  const existing = inFlight.get(flightKey)
  if (existing) return existing
  const running = runVerification(target, key, executableRelativePath, deps)
    .finally(() => inFlight.delete(flightKey))
  inFlight.set(flightKey, running)
  return running
}

async function runVerification(
  target: NpmOfficialVerificationTarget,
  key: NpmOfficialVerificationCacheKey,
  executableRelativePath: string | undefined,
  deps: NpmOfficialVerificationDependencies,
): Promise<NpmOfficialVerificationResult> {
  const now = deps.now ?? Date.now
  const limits: NpmOfficialVerificationLimits = {
    ...DEFAULT_NPM_OFFICIAL_VERIFICATION_LIMITS,
    ...deps.limits,
    extraction: { ...DEFAULT_NPM_OFFICIAL_VERIFICATION_LIMITS.extraction, ...deps.limits?.extraction },
  }
  const cache = deps.cache ?? (deps.db ? createSqliteNpmOfficialVerificationCache(deps.db) : undefined)
  const cached = safeCacheGet(cache, key)
  if (cached?.status === 'verified') {
    return {
      status: 'verified',
      officialFingerprint: cached.officialFingerprint,
      checkedAt: cached.checkedAt,
      evidence: 'cache',
    }
  }
  if (cached?.status === 'mismatch') {
    const age = now() - Date.parse(cached.checkedAt)
    if (Number.isFinite(age) && age >= 0 && age < limits.mismatchCacheTtlMs) {
      return { status: 'mismatch', officialFingerprint: cached.officialFingerprint, checkedAt: cached.checkedAt }
    }
  }

  const checkedAt = new Date(now()).toISOString()
  try {
    const outcome = await verifyAgainstRegistry(target, executableRelativePath, deps, limits, key)
    const record: NpmOfficialVerificationCacheRecord = {
      ...key,
      status: outcome.matched ? 'verified' : 'mismatch',
      officialFingerprint: outcome.officialFingerprint,
      checkedAt,
      evidence: outcome.evidence,
    }
    safeCachePut(cache, record)
    return outcome.matched
      ? { status: 'verified', officialFingerprint: outcome.officialFingerprint, checkedAt, evidence: 'registry' }
      : { status: 'mismatch', officialFingerprint: outcome.officialFingerprint, checkedAt }
  } catch (error) {
    if (error instanceof UnsupportedDuringVerification) return { status: 'unsupported', reason: error.reason }
    const failure = error instanceof VerificationFailure
      ? error
      : new VerificationFailure('protocol', stableCode(error))
    // An expired but deterministic mismatch is still more accurate than "unknown".
    if (cached?.status === 'mismatch') {
      return { status: 'mismatch', officialFingerprint: cached.officialFingerprint, checkedAt: cached.checkedAt }
    }
    return { status: 'unavailable', reason: failure.reason, checkedAt, detail: failure.detail }
  }
}

interface PackagePlan {
  role: 'root' | 'platform_selector' | 'platform_leaf'
  manifestName: string
  installName: string
  version: string
  spec: NpmComposedComponentSpec | null
}

interface NetworkContext {
  fetch: NpmOfficialVerificationFetch
  deadline: number
  downloadedBytes: number
  limits: NpmOfficialVerificationLimits
}

async function verifyAgainstRegistry(
  target: NpmOfficialVerificationTarget,
  executableRelativePath: string | undefined,
  deps: NpmOfficialVerificationDependencies,
  limits: NpmOfficialVerificationLimits,
  key: NpmOfficialVerificationCacheKey,
): Promise<{ matched: boolean; officialFingerprint: string; evidence: NpmOfficialVerificationEvidence }> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as NpmOfficialVerificationFetch | undefined)
  if (!fetchImpl) throw new VerificationFailure('offline', 'fetch_unavailable')
  const plans: PackagePlan[] = [
    { role: 'root', manifestName: target.packageName, installName: target.packageName, version: target.version, spec: null },
    ...(target.composition?.components ?? []).map(component => ({
      role: component.role,
      manifestName: component.manifestName,
      installName: component.installName,
      version: component.version,
      spec: component,
    })),
  ]
  const context: NetworkContext = {
    fetch: fetchImpl,
    deadline: Date.now() + limits.totalTimeoutMs,
    downloadedBytes: 0,
    limits,
  }

  const workRoot = await createPrivateWorkRoot(deps.tempRoot ?? os.tmpdir())
  try {
    // 1. Official version documents for every package of the exact topology.
    const metadata: VersionMetadata[] = []
    for (const plan of plans) metadata.push(await fetchVersionMetadata(context, plan.manifestName, plan.version))
    // 2. Integrity-bound tarballs, streamed to private files.
    const downloads = path.join(workRoot, 'downloads')
    await fs.mkdir(downloads, { mode: 0o700 })
    const tarballs: Array<{ path: string; bytes: number }> = []
    for (const [index, plan] of plans.entries()) {
      tarballs.push(await downloadTarball(context, metadata[index]!, path.join(downloads, `${index}.tgz`), plan))
    }
    const evidence: NpmOfficialVerificationEvidence = {
      packages: plans.map((plan, index) => ({
        role: plan.role,
        packageName: plan.manifestName,
        installName: plan.installName,
        version: plan.version,
        integrity: metadata[index]!.integrity,
        tarballUrl: metadata[index]!.tarballUrl,
        tarballBytes: tarballs[index]!.bytes,
      })),
    }

    // 3. Static npm-layout staging. No script or downloaded code is executed.
    const stageRoot = path.join(workRoot, 'stage')
    await fs.mkdir(stageRoot, { mode: 0o700 })
    const staged: Array<{ plan: PackagePlan; stage: StagedNpmPackage }> = []
    for (const [index, plan] of plans.entries()) {
      const stage = await stagingStep(() => stageNpmTarball(
        tarballs[index]!.path, stageRoot, plan.manifestName, metadata[index]!.integrity, plan.installName,
        limits.extraction,
      ))
      staged.push({ plan, stage })
    }
    const root = staged[0]!.stage
    if (target.distributionId === OPENCLAW_NPM_GLOBAL_DISTRIBUTION) {
      const marker = path.join(root.packageRoot, OPENCLAW_LIFECYCLE_MARKER)
      if (await fs.lstat(marker).then(() => true, () => false)) {
        try {
          await staticallyCompleteOpenClawPackageLifecycle(root.packageRoot, { expectedVersion: target.version })
        } catch {
          throw new UnsupportedDuringVerification('openclaw_lifecycle_not_statically_reproducible')
        }
      }
    }

    const candidates = await stagingStep(async () => executableCandidates(target, root, executableRelativePath, limits))
    if (target.composition?.entryRule === 'copy_platform_binary_v1') {
      const composition = target.composition
      await stagingStep(() => materializeCopiedPlatformBinary(
        root.packageRoot,
        candidates[0]!,
        composition,
        staged.slice(1).map(entry => ({ spec: entry.plan.spec!, packageRoot: entry.stage.packageRoot })),
      ))
    }

    // 4. The same passive discovery proof the runtime uses on the local install,
    //    once per official surface schema (locked first: removing the hidden
    //    lockfile for the lockless surface is irreversible within this stage).
    const passiveFs = createPassiveVersionFileSystem()
    const officialFingerprints: string[] = []
    for (const schema of target.candidateSchemas) {
      if (isLocklessSchema(schema)) await stagingStep(() => removeStagedNpmHiddenLockfile(stageRoot))
      for (const executable of candidates) {
        const result = await stagingStep(() => inspectPassiveCliVersionForArchitecture(
          executable, passiveFs, target.architecture,
        ))
        if (result.exitCode !== 0 || result.stdout !== target.version
          || result.verifiedPackageProvenance !== target.packageProvenance
          || !result.portableArtifactFingerprint
          || Boolean(target.composition) !== Boolean(result.npmComposition)
          || isLocklessSchema(schema) !== isLocklessProof(result)) continue
        officialFingerprints.push(result.portableArtifactFingerprint)
        if (result.portableArtifactFingerprint === key.localPortableArtifactFingerprint) {
          return { matched: true, officialFingerprint: result.portableArtifactFingerprint, evidence }
        }
      }
    }
    if (officialFingerprints.length === 0) {
      throw new VerificationFailure('protocol', 'official_package_does_not_produce_runtime_identity')
    }
    return { matched: false, officialFingerprint: officialFingerprints[0]!, evidence }
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true })
  }
}

function isLocklessSchema(schema: NpmPortableFingerprintSchema): boolean {
  return schema === 'npm-owned-package-surface-lockless-v1' || schema === 'npm-composed-platform-surface-lockless-v1'
}

/** A locked npm proof always binds the hidden lockfile and integrity; a lockless one never does. */
function isLocklessProof(result: VersionCommandResult): boolean {
  return !result.packageProofNodes?.some(node => node.role === 'npm_install_lock')
    && !result.npmComposition?.components.some(component => component.integrity !== undefined)
}

async function executableCandidates(
  target: NpmOfficialVerificationTarget,
  root: StagedNpmPackage,
  executableRelativePath: string | undefined,
  limits: NpmOfficialVerificationLimits,
): Promise<string[]> {
  if (target.composition) {
    const expected = target.composition.rootExecutableRelativePath
    if (executableRelativePath !== undefined && executableRelativePath !== expected) {
      throw new VerificationFailure('protocol', 'executable_not_topology_entry')
    }
    return [path.join(root.packageRoot, ...expected.split('/'))]
  }
  const bins = root.binTargets()
  const selected = executableRelativePath === undefined
    ? bins.slice(0, limits.maxBinCandidates)
    : bins.includes(executableRelativePath) ? [executableRelativePath] : []
  if (selected.length === 0) {
    throw new VerificationFailure('protocol', executableRelativePath === undefined
      ? 'official_package_has_no_bin'
      : 'executable_not_official_bin')
  }
  return selected.map(relative => path.join(root.packageRoot, ...relative.split('/')))
}

async function stagingStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof VerificationFailure || error instanceof UnsupportedDuringVerification) throw error
    const code = stableCode(error)
    if (code === 'npm_tarball_integrity_mismatch') throw new VerificationFailure('integrity_mismatch', code)
    if (code.startsWith(NPM_TARBALL_LIMIT_ERROR_PREFIX)
      || code === 'package_tree_size_limit_exceeded'
      || code === 'package_tree_shape_or_file_limit_invalid'
      || code === 'package_tree_directory_limit_exceeded'
      || code === 'package_tree_directory_entry_limit_exceeded'
      || code === 'stable_fingerprint_exceeds_supported_distribution_limit'
      || code === 'stable_snapshot_too_large') {
      throw new VerificationFailure('too_large', code)
    }
    throw new VerificationFailure('protocol', code)
  }
}

async function createPrivateWorkRoot(parent: string): Promise<string> {
  const requested = await fs.mkdtemp(path.join(path.resolve(parent), 'tidemind-npm-verify-'))
  await fs.chmod(requested, 0o700)
  const canonical = path.resolve(await fs.realpath(requested))
  const stat = await fs.lstat(canonical)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (uid !== undefined && stat.uid !== uid)) {
    await fs.rm(requested, { recursive: true, force: true })
    throw new VerificationFailure('protocol', 'private_work_root_invalid')
  }
  return canonical
}

/** Registry path segment: scoped names keep `@` and encode the separator as `%2f`. */
export function npmRegistryPackagePath(packageName: string): string {
  if (!PACKAGE_NAME.test(packageName)) throw new Error('npm_package_name_invalid')
  if (!packageName.startsWith('@')) return packageName
  const [scope, name] = packageName.split('/')
  return `${scope}%2f${name}`
}

export function npmRegistryVersionUrl(packageName: string, version: string): string {
  return `${NPM_OFFICIAL_REGISTRY_ORIGIN}/${npmRegistryPackagePath(packageName)}/${encodeURIComponent(version)}`
}

/** The only accepted tarball location: same origin and `/<name>/-/<unscoped>-<version>.tgz`. */
export function isOfficialNpmTarballUrl(value: string, packageName: string, version: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.origin !== NPM_OFFICIAL_REGISTRY_ORIGIN || url.protocol !== 'https:' || url.port !== ''
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return false
  }
  const unscoped = packageName.split('/').at(-1)!
  return pathname === `/${packageName}/-/${unscoped}-${version}.tgz`
}

interface VersionMetadata {
  packageName: string
  version: string
  integrity: string
  tarballUrl: string
}

async function fetchVersionMetadata(
  context: NetworkContext,
  packageName: string,
  version: string,
): Promise<VersionMetadata> {
  const chunks: Buffer[] = []
  await request(context, npmRegistryVersionUrl(packageName, version), {
    accept: 'application/json',
    maxBytes: context.limits.maxMetadataBytes,
    timeoutMs: context.limits.metadataTimeoutMs,
    sink: async chunk => { chunks.push(chunk) },
  })
  let document: {
    name?: unknown
    version?: unknown
    dist?: { integrity?: unknown; tarball?: unknown }
  }
  try {
    document = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof document
  } catch {
    throw new VerificationFailure('protocol', 'registry_metadata_not_json')
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new VerificationFailure('protocol', 'registry_metadata_invalid')
  }
  if (document.name !== packageName || document.version !== version) {
    throw new VerificationFailure('protocol', 'registry_metadata_identity_mismatch')
  }
  const integrity = document.dist?.integrity
  const tarball = document.dist?.tarball
  if (typeof integrity !== 'string' || !INTEGRITY.test(integrity)) {
    throw new VerificationFailure('protocol', 'registry_integrity_not_sha512')
  }
  if (typeof tarball !== 'string' || !isOfficialNpmTarballUrl(tarball, packageName, version)) {
    throw new VerificationFailure('protocol', 'registry_tarball_url_not_official')
  }
  return { packageName, version, integrity, tarballUrl: tarball }
}

async function downloadTarball(
  context: NetworkContext,
  metadata: VersionMetadata,
  destination: string,
  plan: PackagePlan,
): Promise<{ path: string; bytes: number }> {
  const remaining = context.limits.maxTotalDownloadBytes - context.downloadedBytes
  if (remaining <= 0) throw new VerificationFailure('too_large', 'total_download_budget')
  const maxBytes = Math.min(context.limits.maxTarballBytes, remaining)
  const hash = createHash('sha512')
  const handle = await fs.open(
    destination,
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW,
    0o600,
  )
  let bytes = 0
  try {
    bytes = await request(context, metadata.tarballUrl, {
      accept: 'application/octet-stream',
      maxBytes,
      timeoutMs: context.limits.tarballTimeoutMs,
      sink: async chunk => {
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
          if (bytesWritten <= 0) throw new VerificationFailure('protocol', 'tarball_write_failed')
          offset += bytesWritten
        }
      },
    })
  } finally {
    await handle.close()
  }
  context.downloadedBytes += bytes
  if (bytes === 0) throw new VerificationFailure('protocol', 'tarball_empty')
  if (`sha512-${hash.digest('base64')}` !== metadata.integrity) {
    throw new VerificationFailure('integrity_mismatch', `tarball_integrity_mismatch:${plan.role}`)
  }
  return { path: destination, bytes }
}

async function request(
  context: NetworkContext,
  url: string,
  options: { accept: string; maxBytes: number; timeoutMs: number; sink: (chunk: Buffer) => Promise<void> },
): Promise<number> {
  const budget = Math.min(options.timeoutMs, context.deadline - Date.now())
  if (budget <= 0) throw new VerificationFailure('timeout', 'total_budget_exhausted')
  const controller = new AbortController()
  let timedOut = false
  let rejectTimeout!: (error: VerificationFailure) => void
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectTimeout(new VerificationFailure('timeout', 'request_timeout'))
  }, budget)
  timer.unref?.()
  try {
    let response: Response
    try {
      const pendingResponse = context.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: options.accept },
      })
      // Abort is advisory for injected transports and some stream adapters. A
      // hung transport must not monopolize the serialized verification queue.
      void pendingResponse.then(late => {
        if (timedOut) void late.body?.cancel().catch(() => undefined)
      }, () => undefined)
      response = await Promise.race([pendingResponse, timeout])
    } catch {
      throw new VerificationFailure(timedOut ? 'timeout' : 'offline', timedOut ? 'request_timeout' : 'network_error')
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined)
      throw new VerificationFailure('http_error', `http_${response.status}`)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && /^\d+$/u.test(declared.trim()) && Number(declared.trim()) > options.maxBytes) {
      void response.body?.cancel().catch(() => undefined)
      throw new VerificationFailure('too_large', 'declared_length_exceeds_limit')
    }
    if (!response.body) throw new VerificationFailure('protocol', 'response_body_missing')
    const reader = response.body.getReader()
    let total = 0
    try {
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await Promise.race([reader.read(), timeout])
        } catch {
          throw new VerificationFailure(timedOut ? 'timeout' : 'offline', timedOut ? 'body_timeout' : 'body_network_error')
        }
        if (next.done) break
        total += next.value.byteLength
        if (total > options.maxBytes) throw new VerificationFailure('too_large', 'response_exceeds_limit')
        await options.sink(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength))
        if (timedOut || Date.now() >= context.deadline) {
          throw new VerificationFailure('timeout', 'total_budget_exhausted')
        }
      }
    } catch (error) {
      // Cancellation itself may wait on the stalled source; never await it.
      void reader.cancel().catch(() => undefined)
      throw error
    }
    return total
  } finally {
    clearTimeout(timer)
  }
}

function stableCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.split(/\s/u)[0] ?? 'unknown'
  return /^[a-z0-9_:"\\.-]{1,120}$/iu.test(code) && !code.includes('/') ? code : 'staging_failed'
}

function safeCacheGet(
  cache: NpmOfficialVerificationCache | undefined,
  key: NpmOfficialVerificationCacheKey,
): NpmOfficialVerificationCacheRecord | null {
  if (!cache) return null
  try {
    const record = cache.get(key)
    if (!record || (record.status !== 'verified' && record.status !== 'mismatch')
      || !SHA256_HEX.test(record.officialFingerprint)
      || !Number.isFinite(Date.parse(record.checkedAt))) return null
    // Defensive: a cache must never bless a different key.
    if (record.distributionId !== key.distributionId || record.packageProvenance !== key.packageProvenance
      || record.version !== key.version || record.architecture !== key.architecture
      || record.localPortableArtifactFingerprint !== key.localPortableArtifactFingerprint
      || record.verifierVersion !== key.verifierVersion) return null
    if (record.status === 'verified' && record.officialFingerprint !== key.localPortableArtifactFingerprint) return null
    return record
  } catch {
    return null
  }
}

function safeCachePut(cache: NpmOfficialVerificationCache | undefined, record: NpmOfficialVerificationCacheRecord): void {
  if (!cache) return
  try {
    cache.put(record)
  } catch {
    // The cache is an optimization; a failed write must not change the result.
  }
}

interface CacheRow {
  distribution_id: string
  package_provenance: string
  version: string
  architecture: AgentReleaseMacArchitecture
  local_portable_fingerprint: string
  verifier_version: string
  status: 'verified' | 'mismatch'
  official_fingerprint: string
  evidence_json: string
  checked_at: string
}

/** SQLite cache over `agent_npm_official_verifications` (created by ensureAgentIntegrationSchema). */
export function createSqliteNpmOfficialVerificationCache(db: Database.Database): NpmOfficialVerificationCache {
  const select = db.prepare(`
    SELECT distribution_id, package_provenance, version, architecture, local_portable_fingerprint,
      verifier_version, status, official_fingerprint, evidence_json, checked_at
    FROM agent_npm_official_verifications
    WHERE distribution_id = ? AND package_provenance = ? AND version = ? AND architecture = ?
      AND local_portable_fingerprint = ? AND verifier_version = ?
  `)
  const upsert = db.prepare(`
    INSERT INTO agent_npm_official_verifications (
      distribution_id, package_provenance, version, architecture, local_portable_fingerprint,
      verifier_version, status, official_fingerprint, evidence_json, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(distribution_id, package_provenance, version, architecture, local_portable_fingerprint, verifier_version)
    DO UPDATE SET
      status = excluded.status,
      official_fingerprint = excluded.official_fingerprint,
      evidence_json = excluded.evidence_json,
      checked_at = excluded.checked_at
  `)
  return {
    get(key) {
      const row = select.get(
        key.distributionId, key.packageProvenance, key.version, key.architecture,
        key.localPortableArtifactFingerprint, key.verifierVersion,
      ) as CacheRow | undefined
      if (!row) return null
      let evidence: NpmOfficialVerificationEvidence = { packages: [] }
      try {
        const parsed = JSON.parse(row.evidence_json) as NpmOfficialVerificationEvidence
        if (parsed && Array.isArray(parsed.packages)) evidence = parsed
      } catch {
        // Evidence is informational only.
      }
      return {
        distributionId: row.distribution_id,
        packageProvenance: row.package_provenance,
        version: row.version,
        architecture: row.architecture,
        localPortableArtifactFingerprint: row.local_portable_fingerprint,
        verifierVersion: row.verifier_version,
        status: row.status,
        officialFingerprint: row.official_fingerprint,
        checkedAt: row.checked_at,
        evidence,
      }
    },
    put(record) {
      upsert.run(
        record.distributionId, record.packageProvenance, record.version, record.architecture,
        record.localPortableArtifactFingerprint, record.verifierVersion, record.status,
        record.officialFingerprint, JSON.stringify(record.evidence), record.checkedAt,
      )
    },
  }
}
