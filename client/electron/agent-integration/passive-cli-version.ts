import path from 'node:path'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type {
  PackageMetadataProofNode,
  StableFileFingerprint,
  StableFileMetadata,
  StableFileSnapshot,
  StablePackageTree,
  VersionCommandResult,
} from './discovery'
import { npmComposedDistributionSpec } from './npm-distribution-topology'

const VERSION = /^(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

export interface PassiveVersionFileSystem {
  lstat(targetPath: string): Promise<{
    kind: 'file' | 'directory' | 'symbolic_link' | 'other'
    mode?: number
    ownerUid?: string
    groupGid?: string
  } | undefined>
  realpath(targetPath: string): Promise<string>
  readStableFileSnapshot(targetPath: string, maxBytes: number): Promise<StableFileSnapshot>
  readStableFileFingerprint?(targetPath: string, maxBytes: number): Promise<StableFileFingerprint>
  readStablePackageTree?(targetPath: string, options?: StablePackageTreeOptions): Promise<StablePackageTree>
  verifyStablePackageTree?(
    targetPath: string,
    snapshot: StablePackageTree,
    options?: StablePackageTreeOptions,
  ): Promise<boolean>
}

export const MAX_PACKAGE_TREE_FILES = 20_000
export const MAX_PACKAGE_TREE_DIRECTORIES = 1_024
export const MAX_STANDALONE_PACKAGE_TREE_DIRECTORIES = 4_096
export const MAX_PACKAGE_TREE_DEPTH = 64
export const MAX_PACKAGE_TREE_ENTRIES_PER_DIRECTORY = 8_192
const MAX_PACKAGE_TREE_BYTES = 512 * 1024 * 1024
// Codex's official platform leaf contains a native executable above 256 MiB.
// Keep the per-file bound equal to the already-frozen total tree bound so the
// exact leaf can be streamed without allocating it while still rejecting
// unbounded artifacts.
const MAX_PACKAGE_TREE_FILE_BYTES = 512 * 1024 * 1024
const MAX_NPM_MANIFEST_BYTES = 512 * 1024

export function normalizedOpenClawWrapperBytes(toolchain: string): Buffer {
  if (!/^node-v\d+\.\d+\.\d+$/u.test(toolchain)) {
    throw new Error('openclaw_toolchain_version_invalid')
  }
  return Buffer.from([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `exec "<OPENCLAW_PREFIX>/tools/node/bin/node" "<OPENCLAW_PREFIX>/tools/${toolchain}/lib/node_modules/openclaw/dist/entry.js" "$@"`,
    '',
  ].join('\n'))
}

export function normalizedQwenLauncherBytes(): Buffer {
  return Buffer.from([
    '#!/usr/bin/env sh',
    'set -e',
    'ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
    'QWEN_CODE_LAUNCHER_PATH="$ROOT/bin/qwen" exec "$ROOT/node/bin/node" "$ROOT/lib/cli-entry.js" "$@"',
    '',
  ].join('\n'))
}

function qwenInstallerShimTarget(value: string): string | undefined {
  const prefix = '#!/usr/bin/env sh\nexec '
  const suffix = ' "$@"\n'
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return undefined
  const token = value.slice(prefix.length, -suffix.length)
  if (!token.startsWith("'") || !token.endsWith("'")) return undefined
  const encodedQuote = "'\\''"
  const inner = token.slice(1, -1)
  const decoded = inner.split(encodedQuote).join("'")
  const canonicalToken = `'${decoded.replaceAll("'", encodedQuote)}'`
  if (canonicalToken !== token
    || decoded.includes('\n')
    || decoded.includes('\r')
    || decoded.includes('\0')
    || !path.isAbsolute(decoded)
    || decoded !== path.resolve(decoded)
    || path.basename(decoded) !== 'qwen'
    || path.basename(path.dirname(decoded)) !== 'bin') return undefined
  return path.resolve(decoded)
}

export function kimiNativeExecutablePortableArtifactFingerprint(
  executable: StableFileFingerprint,
): string | undefined {
  if (!executable.executable) return undefined
  return portableFingerprint({
    schema: 'kimi-native-executable-v1',
    executable: portableFile('bin/kimi', executable),
  })
}

export interface StablePackageTreeOptions {
  includeNodeModules?: boolean
}

/** Bounded whole-package snapshot used only for release-frozen npm artifacts. */
export async function readStablePackageTree(
  packageRoot: string,
  options: StablePackageTreeOptions = {},
): Promise<StablePackageTree> {
  const canonicalRoot = path.resolve(packageRoot)
  const uid = expectedOwnerUid()
  if (!uid || path.resolve(await fs.realpath(canonicalRoot)) !== canonicalRoot) {
    throw new Error('package_tree_root_not_canonical')
  }
  const pendingEntries: Array<{ path: string; entryType: 'file' | 'symlink' }> = []
  const maxDirectories = options.includeNodeModules
    ? MAX_STANDALONE_PACKAGE_TREE_DIRECTORIES
    : MAX_PACKAGE_TREE_DIRECTORIES
  let directoryCount = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    directoryCount += 1
    if (directoryCount > maxDirectories || depth > MAX_PACKAGE_TREE_DEPTH) {
      throw new Error('package_tree_directory_limit_exceeded')
    }
    const directoryNode = await fs.lstat(directory)
    if (!directoryNode.isDirectory() || directoryNode.isSymbolicLink()
      || ![uid, '0'].includes(String(directoryNode.uid))
      || (Number(directoryNode.mode & 0o7777) & 0o022) !== 0
      || path.resolve(await fs.realpath(directory)) !== directory) {
      throw new Error('package_tree_directory_not_canonical')
    }
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (entries.length > MAX_PACKAGE_TREE_ENTRIES_PER_DIRECTORY) {
      throw new Error('package_tree_directory_entry_limit_exceeded')
    }
    for (const entry of entries) {
      const targetPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!options.includeNodeModules && entry.name === 'node_modules') continue
        await visit(targetPath, depth + 1)
        continue
      }
      if (pendingEntries.length >= MAX_PACKAGE_TREE_FILES) {
        throw new Error('package_tree_shape_or_file_limit_invalid')
      }
      if (entry.isSymbolicLink()) {
        pendingEntries.push({ path: targetPath, entryType: 'symlink' })
        continue
      }
      if (!entry.isFile()) throw new Error('package_tree_shape_or_file_limit_invalid')
      pendingEntries.push({ path: targetPath, entryType: 'file' })
    }
  }
  await visit(canonicalRoot, 0)
  const proofNodes = await mapWithConcurrency(pendingEntries, 32, async entry => {
    if (entry.entryType === 'symlink') {
      const snapshot = await readStableOwnedSymlinkFingerprint(canonicalRoot, entry.path)
      // Linux reports symlink mode as 0777 because those permission bits are
      // not used for access control. Requiring the regular-file 0022 mask here
      // therefore rejects every otherwise-safe package-owned symlink and
      // drops the npm proof to manifest-only. The containing directories are
      // already non-writable by group/other, and the symlink proof separately
      // binds its owner, inode, relative in-package target and exact owned file.
      if (!isSafeArtifactOwner(snapshot)) throw new Error('package_tree_file_permissions_invalid')
      return {
        ...packageProofNode('npm_package_file', entry.path, 0, snapshot),
        entryType: 'symlink' as const,
        symlinkTarget: snapshot.symlinkTarget,
      }
    }
    const snapshot = await readStableFileFingerprint(entry.path, MAX_PACKAGE_TREE_FILE_BYTES)
    if (!isSafeArtifactOwned(snapshot)) throw new Error('package_tree_file_permissions_invalid')
    return {
      ...packageProofNode('npm_package_file', entry.path, MAX_PACKAGE_TREE_FILE_BYTES, snapshot),
      entryType: 'file' as const,
      symlinkTarget: null,
    }
  })
  if (proofNodes.length === 0) throw new Error('package_tree_empty')
  proofNodes.sort((left, right) => left.path.localeCompare(right.path))
  const totalBytes = proofNodes.reduce((sum, node) => sum + node.size, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PACKAGE_TREE_BYTES) {
    throw new Error('package_tree_size_limit_exceeded')
  }
  const nodeByPath = new Map(proofNodes.map(node => [node.path, node]))
  for (const node of proofNodes) {
    if (node.entryType !== 'symlink') continue
    const resolvedTarget = path.resolve(path.dirname(node.path), node.symlinkTarget!)
    if (nodeByPath.get(resolvedTarget)?.entryType !== 'file') {
      throw new Error('package_tree_symlink_target_not_owned_file')
    }
  }
  const portableEntries = proofNodes.map(node => portableOwnedEntry(canonicalRoot, node))
  return {
    packageTreeSha256: portableFingerprint({ schema: 'npm-owned-package-v1', entries: portableEntries }),
    ownedEntryCount: proofNodes.length,
    ownedTotalBytes: totalBytes,
    physicalTreeFingerprint: portableFingerprint({
      schema: 'npm-owned-package-physical-v1',
      entries: proofNodes.map(node => ({
        path: node.path,
        entryType: node.entryType,
        fingerprint: node.fingerprint,
        symlinkTarget: node.symlinkTarget ?? null,
      })),
    }),
    proofNodes,
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      result[index] = await mapper(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return result
}

/** Metadata-only CAS after the streaming content pass. */
export async function verifyStablePackageTree(
  packageRoot: string,
  snapshot: StablePackageTree,
  options: StablePackageTreeOptions = {},
): Promise<boolean> {
  try {
    const canonicalRoot = path.resolve(packageRoot)
    const uid = expectedOwnerUid()
    if (!uid || path.resolve(await fs.realpath(canonicalRoot)) !== canonicalRoot) return false
    const actualPaths: string[] = []
    const maxDirectories = options.includeNodeModules
      ? MAX_STANDALONE_PACKAGE_TREE_DIRECTORIES
      : MAX_PACKAGE_TREE_DIRECTORIES
    let directoryCount = 0
    const visit = async (directory: string, depth: number): Promise<boolean> => {
      directoryCount += 1
      if (directoryCount > maxDirectories || depth > MAX_PACKAGE_TREE_DEPTH) return false
      const directoryNode = await fs.lstat(directory, { bigint: true })
      if (!directoryNode.isDirectory() || directoryNode.isSymbolicLink()
        || ![uid, '0'].includes(String(directoryNode.uid))
        || (Number(directoryNode.mode & 0o7777n) & 0o022) !== 0
        || path.resolve(await fs.realpath(directory)) !== directory) return false
      const entries = (await fs.readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name))
      if (entries.length > MAX_PACKAGE_TREE_ENTRIES_PER_DIRECTORY) return false
      for (const entry of entries) {
        const targetPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!options.includeNodeModules && entry.name === 'node_modules') continue
          if (!await visit(targetPath, depth + 1)) return false
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          actualPaths.push(targetPath)
          if (actualPaths.length > MAX_PACKAGE_TREE_FILES) return false
        } else return false
      }
      return true
    }
    if (!await visit(canonicalRoot, 0)) return false
    const expected = [...snapshot.proofNodes].sort((left, right) => left.path.localeCompare(right.path))
    actualPaths.sort((left, right) => left.localeCompare(right))
    if (actualPaths.length !== expected.length
      || actualPaths.some((targetPath, index) => targetPath !== expected[index]?.path)) return false
    const expectedByPath = new Map(expected.map(node => [node.path, node]))
    const results = await mapWithConcurrency(expected, 64, async proof => {
      const node = await fs.lstat(proof.path, { bigint: true })
      if (proof.entryType === 'symlink') {
        if (!node.isSymbolicLink()) return false
        const rawTarget = await fs.readlink(proof.path)
        if (path.isAbsolute(rawTarget)) return false
        const resolvedTarget = path.resolve(path.dirname(proof.path), rawTarget)
        const normalizedTarget = path.relative(path.dirname(proof.path), resolvedTarget).split(path.sep).join('/')
        return isPathWithin(canonicalRoot, resolvedTarget)
          && (options.includeNodeModules
            || !path.relative(canonicalRoot, resolvedTarget).split(path.sep).includes('node_modules'))
          && normalizedTarget === proof.symlinkTarget
          && expectedByPath.get(resolvedTarget)?.entryType === 'file'
          && stableSymlinkStatMatches(node, proof)
      }
      return node.isFile() && !node.isSymbolicLink() && stableStatMatches(node, proof)
    })
    return results.every(Boolean)
  } catch {
    return false
  }
}

function stableStatMatches(stat: BigIntStats, proof: StableFileFingerprint): boolean {
  return String(stat.dev) === proof.device && String(stat.ino) === proof.inode
    && String(stat.nlink) === proof.linkCount && String(stat.mtimeNs) === proof.mtimeNs
    && String(stat.ctimeNs) === proof.ctimeNs && Number(stat.size) === proof.size
    && Number(stat.mode & 0o7777n) === proof.mode
    && String(stat.uid) === proof.ownerUid && String(stat.gid) === proof.groupGid
}

function stableSymlinkStatMatches(stat: BigIntStats, proof: StableFileFingerprint): boolean {
  return String(stat.dev) === proof.device && String(stat.ino) === proof.inode
    && String(stat.nlink) === proof.linkCount && String(stat.mtimeNs) === proof.mtimeNs
    && String(stat.ctimeNs) === proof.ctimeNs && Number(stat.mode & 0o7777n) === proof.mode
    && String(stat.uid) === proof.ownerUid && String(stat.gid) === proof.groupGid
}

async function readStableOwnedSymlinkFingerprint(
  packageRoot: string,
  targetPath: string,
): Promise<StableFileFingerprint & { symlinkTarget: string }> {
  const before = await fs.lstat(targetPath, { bigint: true })
  if (!before.isSymbolicLink()) throw new Error('package_tree_symlink_changed')
  const rawTarget = await fs.readlink(targetPath)
  if (path.isAbsolute(rawTarget)) throw new Error('package_tree_symlink_absolute')
  const resolvedTarget = path.resolve(path.dirname(targetPath), rawTarget)
  if (!isPathWithin(packageRoot, resolvedTarget)
    || path.relative(packageRoot, resolvedTarget).split(path.sep).includes('node_modules')) {
    throw new Error('package_tree_symlink_escape')
  }
  const normalizedTarget = path.relative(path.dirname(targetPath), resolvedTarget).split(path.sep).join('/')
  const after = await fs.lstat(targetPath, { bigint: true })
  if (!after.isSymbolicLink() || fileStatIdentity(before) !== fileStatIdentity(after)
    || await fs.readlink(targetPath) !== rawTarget) throw new Error('package_tree_symlink_changed')
  const bytes = Buffer.from(normalizedTarget, 'utf8')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const mode = Number(before.mode & 0o7777n)
  const ownerUid = String(before.uid)
  const groupGid = String(before.gid)
  return {
    size: bytes.length,
    mode,
    device: String(before.dev),
    inode: String(before.ino),
    linkCount: String(before.nlink),
    mtimeNs: String(before.mtimeNs),
    ctimeNs: String(before.ctimeNs),
    sha256,
    fingerprint: portableFingerprint({
      schema: 'npm-owned-symlink-physical-v1',
      device: String(before.dev), inode: String(before.ino), linkCount: String(before.nlink),
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), mode,
      ownerUid, groupGid, normalizedTarget,
    }),
    executable: false,
    ownerUid,
    groupGid,
    symlinkTarget: normalizedTarget,
  }
}

/**
 * Produce a bounded snapshot from one open descriptor. O_NOFOLLOW prevents a
 * leaf symlink swap, while the two fstats reject in-place writes, chmod and
 * inode/size changes during the read. Callers that need a multi-file proof must
 * re-snapshot the first file after reading the second one.
 */
export async function readStableFileSnapshot(
  targetPath: string,
  maxBytes: number,
): Promise<StableFileSnapshot> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('stable_snapshot_invalid_bound')
  const handle = await fs.open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('stable_snapshot_not_regular_file')
    if (before.size > BigInt(maxBytes)) throw new Error('stable_snapshot_too_large')
    const content = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
      if (bytesRead === 0) throw new Error('stable_snapshot_short_read')
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const beforeIdentity = fileStatIdentity(before)
    const afterIdentity = fileStatIdentity(after)
    if (beforeIdentity !== afterIdentity) throw new Error('stable_snapshot_changed_during_read')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const mode = Number(before.mode & 0o7777n)
    const device = String(before.dev)
    const inode = String(before.ino)
    const linkCount = String(before.nlink)
    const mtimeNs = String(before.mtimeNs)
    const ctimeNs = String(before.ctimeNs)
    const ownerUid = String(before.uid)
    const groupGid = String(before.gid)
    const fingerprint = createHash('sha256').update(JSON.stringify({
      device,
      inode,
      size: Number(before.size),
      mode,
      linkCount,
      mtimeNs,
      ctimeNs,
      ownerUid,
      groupGid,
      sha256,
    })).digest('hex')
    return {
      content,
      size: Number(before.size),
      mode,
      device,
      inode,
      linkCount,
      mtimeNs,
      ctimeNs,
      sha256,
      fingerprint,
      executable: (mode & 0o111) !== 0,
      ownerUid,
      groupGid,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Hashes a bounded executable through one descriptor and a fixed-size buffer.
 * Unlike the metadata snapshot this never allocates fileSize bytes.
 */
export async function readStableFileFingerprint(
  targetPath: string,
  maxBytes: number,
): Promise<StableFileFingerprint> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('stable_fingerprint_invalid_bound')
  const handle = await fs.open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('stable_fingerprint_not_regular_file')
    if (before.size > BigInt(maxBytes)) throw new Error('stable_fingerprint_exceeds_supported_distribution_limit')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0n
    while (offset < before.size) {
      const remaining = before.size - offset
      const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining)
      const { bytesRead } = await handle.read(buffer, 0, length, Number(offset))
      if (bytesRead === 0) throw new Error('stable_fingerprint_short_read')
      hash.update(buffer.subarray(0, bytesRead))
      offset += BigInt(bytesRead)
    }
    const after = await handle.stat({ bigint: true })
    if (fileStatIdentity(before) !== fileStatIdentity(after)) {
      throw new Error('stable_fingerprint_changed_during_read')
    }
    return stableFingerprint(before, hash.digest('hex'))
  } finally {
    await handle.close()
  }
}

/**
 * Returns a trustworthy, content-free eligibility fact. The descriptor is
 * opened with O_NOFOLLOW and fstat is repeated so discovery cannot bless a
 * leaf swap or concurrent chmod/resize while deciding whether hashing is
 * bounded.
 */
export async function readStableFileMetadata(targetPath: string): Promise<StableFileMetadata> {
  const handle = await fs.open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('stable_metadata_not_regular_file')
    const after = await handle.stat({ bigint: true })
    if (fileStatIdentity(before) !== fileStatIdentity(after)) {
      throw new Error('stable_metadata_changed_during_probe')
    }
    const size = Number(before.size)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('stable_metadata_size_unrepresentable')
    const mode = Number(before.mode & 0o7777n)
    return {
      size,
      mode,
      device: String(before.dev),
      inode: String(before.ino),
      executable: (mode & 0o111) !== 0,
      ownerUid: String(before.uid),
      groupGid: String(before.gid),
    }
  } finally {
    await handle.close()
  }
}

function stableFingerprint(stat: BigIntStats, sha256: string): StableFileFingerprint {
  const mode = Number(stat.mode & 0o7777n)
  const device = String(stat.dev)
  const inode = String(stat.ino)
  const linkCount = String(stat.nlink)
  const mtimeNs = String(stat.mtimeNs)
  const ctimeNs = String(stat.ctimeNs)
  const ownerUid = String(stat.uid)
  const groupGid = String(stat.gid)
  return {
    size: Number(stat.size),
    mode,
    device,
    inode,
    linkCount,
    mtimeNs,
    ctimeNs,
    sha256,
    fingerprint: createHash('sha256').update(JSON.stringify({
      device,
      inode,
      size: Number(stat.size),
      mode,
      linkCount,
      mtimeNs,
      ctimeNs,
      ownerUid,
      groupGid,
      sha256,
    })).digest('hex'),
    executable: (mode & 0o111) !== 0,
    ownerUid,
    groupGid,
  }
}

function fileStatIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
}

/**
 * Reads a version only from bounded metadata adjacent to the already-resolved
 * executable. It never starts the binary, follows a PATH alias, scans a tree,
 * or reads a user configuration file.
 */
export async function inspectPassiveCliVersion(
  executableRealpath: string,
  fs: PassiveVersionFileSystem,
): Promise<VersionCommandResult> {
  return inspectPassiveCliVersionForArchitecture(
    executableRealpath, fs, process.arch === 'x64' ? 'x64' : 'arm64',
  )
}

/** Explicit-architecture entry used by isolated receipt capture/tests. */
export async function inspectPassiveCliVersionForArchitecture(
  executableRealpath: string,
  fs: PassiveVersionFileSystem,
  architecture: 'arm64' | 'x64',
): Promise<VersionCommandResult> {
  const normalized = path.resolve(executableRealpath)
  const kimiNative = await inspectKimiLocalUpdaterState(normalized, fs)
  if (kimiNative) return kimiNative
  const openClaw = await inspectOfficialOpenClawWrapper(normalized, fs)
  if (openClaw) return openClaw
  const qwenLauncher = await inspectOfficialQwenLauncher(normalized, fs, architecture)
  if (qwenLauncher) return qwenLauncher
  const npm = npmPackageMetadata(normalized)
  if (npm) return inspectNpmPackageMetadata(npm, fs, architecture)

  const homebrew = normalized.match(/\/(?:Cellar|homebrew\/Cellar)\/[^/]+\/([^/]+)(?:\/|$)/u)?.[1]
  if (homebrew && VERSION.test(homebrew)) return success(homebrew)

  const managedVersion = normalized.match(/\/(?:versions|releases)\/([^/]+)(?:\/|$)/u)?.[1]
  if (managedVersion && VERSION.test(managedVersion)) return success(managedVersion)

  return unavailable('passive_version_metadata_unavailable')
}

function expectedOwnerUid(): string | undefined {
  return typeof process.getuid === 'function' ? String(process.getuid()) : undefined
}

function isSafeUserOwned(value: { mode?: number; ownerUid?: string }): boolean {
  const uid = expectedOwnerUid()
  return uid !== undefined
    && value.ownerUid === uid
    && typeof value.mode === 'number'
    && (value.mode & 0o022) === 0
}

function isSafeArtifactOwned(value: { mode?: number; ownerUid?: string }): boolean {
  return isSafeArtifactOwner(value)
    && typeof value.mode === 'number'
    && (value.mode & 0o022) === 0
}

function isSafeArtifactOwner(value: { ownerUid?: string }): boolean {
  const uid = expectedOwnerUid()
  return uid !== undefined
    && (value.ownerUid === uid || value.ownerUid === '0')
}

async function isCanonicalOwnedFile(fs: PassiveVersionFileSystem, targetPath: string): Promise<boolean> {
  const node = await fs.lstat(targetPath)
  return node?.kind === 'file'
    && isSafeUserOwned(node)
    && path.resolve(await fs.realpath(targetPath)) === targetPath
}

async function isCanonicalOwnedDirectory(fs: PassiveVersionFileSystem, targetPath: string): Promise<boolean> {
  const node = await fs.lstat(targetPath)
  return node?.kind === 'directory'
    && isSafeUserOwned(node)
    && path.resolve(await fs.realpath(targetPath)) === targetPath
}

/**
 * Reads Kimi's user-owned updater files as local diagnostic state only. These
 * files are not publisher provenance and must never authorize a release
 * version or contribute a release portable-artifact fingerprint.
 */
async function inspectKimiLocalUpdaterState(
  executableRealpath: string,
  fs: PassiveVersionFileSystem,
): Promise<VersionCommandResult | null> {
  if (path.basename(executableRealpath) !== 'kimi'
    || path.basename(path.dirname(executableRealpath)) !== 'bin') return null
  const root = path.dirname(path.dirname(executableRealpath))
  if (path.basename(root) !== '.kimi-code'
    || executableRealpath !== path.join(root, 'bin', 'kimi')) return null
  if (!fs.readStableFileFingerprint) return null
  const installJson = path.join(root, 'updates', 'install.json')
  const latestJson = path.join(root, 'updates', 'latest.json')
  try {
    for (const directory of [root, path.join(root, 'bin'), path.join(root, 'updates')]) {
      if (!await isCanonicalOwnedDirectory(fs, directory)) {
        return unavailable('kimi_updater_directory_permissions_invalid')
      }
    }
    if (!await isCanonicalOwnedFile(fs, executableRealpath)
      || !await isCanonicalOwnedFile(fs, installJson)
      || !await isCanonicalOwnedFile(fs, latestJson)) {
      return unavailable('kimi_updater_surface_not_canonical')
    }
    const executableBefore = await fs.readStableFileFingerprint(executableRealpath, 512 * 1024 * 1024)
    const installBefore = await fs.readStableFileSnapshot(installJson, 32 * 1024)
    const latestBefore = await fs.readStableFileSnapshot(latestJson, 64 * 1024)
    const executableAfter = await fs.readStableFileFingerprint(executableRealpath, 512 * 1024 * 1024)
    const installAfter = await fs.readStableFileSnapshot(installJson, 32 * 1024)
    const latestAfter = await fs.readStableFileSnapshot(latestJson, 64 * 1024)
    if (!executableBefore.executable
      || !isSafeUserOwned(executableBefore)
      || !isSafeUserOwned(installBefore)
      || !isSafeUserOwned(latestBefore)
      || executableAfter.fingerprint !== executableBefore.fingerprint
      || installAfter.fingerprint !== installBefore.fingerprint
      || latestAfter.fingerprint !== latestBefore.fingerprint) {
      return unavailable('kimi_updater_surface_changed')
    }
    const install = JSON.parse(Buffer.from(installBefore.content).toString('utf8')) as {
      lastSuccess?: { version?: unknown; installedAt?: unknown } | null
    }
    const latest = JSON.parse(Buffer.from(latestBefore.content).toString('utf8')) as {
      source?: unknown
      checkedAt?: unknown
      latest?: unknown
      manifest?: { version?: unknown; publishedAt?: unknown } | null
    }
    const installedVersion = install.lastSuccess?.version
    const latestVersion = latest.latest
    if (typeof installedVersion !== 'string' || !VERSION.test(installedVersion)
      || latest.source !== 'cdn'
      || typeof latestVersion !== 'string' || !VERSION.test(latestVersion)
      || latest.manifest?.version !== latestVersion
      || typeof install.lastSuccess?.installedAt !== 'string'
      || !Number.isFinite(Date.parse(install.lastSuccess.installedAt))
      || typeof latest.checkedAt !== 'string'
      || !Number.isFinite(Date.parse(latest.checkedAt))
      || typeof latest.manifest?.publishedAt !== 'string'
      || !Number.isFinite(Date.parse(latest.manifest.publishedAt))) {
      return unavailable('kimi_updater_metadata_identity_mismatch')
    }
    const packageMetadataFingerprint = createHash('sha256').update(JSON.stringify({
      schema: 'kimi-native-updater-v1',
      executable: executableBefore.fingerprint,
      install: installBefore.fingerprint,
      latest: latestBefore.fingerprint,
      installedVersion,
    })).digest('hex')
    return success(
      installedVersion,
      'local_updater_state:kimi',
      packageMetadataFingerprint,
      [
        packageProofNode('kimi_install_metadata', installJson, 32 * 1024, installBefore),
        packageProofNode('kimi_latest_metadata', latestJson, 64 * 1024, latestBefore),
      ],
      undefined,
    )
  } catch {
    return unavailable('kimi_updater_metadata_unavailable')
  }
}

async function inspectOfficialOpenClawWrapper(
  executableRealpath: string,
  fs: PassiveVersionFileSystem,
): Promise<VersionCommandResult | null> {
  if (path.basename(executableRealpath) !== 'openclaw'
    || path.basename(path.dirname(executableRealpath)) !== 'bin') return null
  const root = path.dirname(path.dirname(executableRealpath))
  if (executableRealpath !== path.join(root, 'bin', 'openclaw')) return null
  if (!fs.readStableFileFingerprint || !fs.readStablePackageTree || !fs.verifyStablePackageTree) return null
  try {
    const wrapperBefore = await fs.readStableFileSnapshot(executableRealpath, 4 * 1024)
    if (!wrapperBefore.executable || !isSafeUserOwned(wrapperBefore)) {
      return unavailable('openclaw_wrapper_permissions_invalid')
    }
    const wrapper = Buffer.from(wrapperBefore.content).toString('utf8')
    const match = wrapper.match(/^#!\/usr\/bin\/env bash\r?\nset -euo pipefail\r?\nexec "([^"\r\n]+)" "([^"\r\n]+)" "\$@"\r?\n?$/u)
    if (!match) return unavailable('openclaw_wrapper_identity_mismatch')
    const nodeAlias = path.resolve(match[1]!)
    const entry = path.resolve(match[2]!)
    const expectedNodeAlias = path.join(root, 'tools', 'node', 'bin', 'node')
    const entryRelative = path.relative(path.join(root, 'tools'), entry).split(path.sep)
    if (nodeAlias !== expectedNodeAlias
      || entryRelative.length !== 6
      || !/^node-v\d+\.\d+\.\d+$/u.test(entryRelative[0] ?? '')
      || entryRelative.slice(1).join('/') !== 'lib/node_modules/openclaw/dist/entry.js') {
      return unavailable('openclaw_wrapper_path_escape')
    }
    const toolchainRoot = path.join(root, 'tools', entryRelative[0]!)
    const expectedNode = path.join(toolchainRoot, 'bin', 'node')
    const packageJson = path.join(toolchainRoot, 'lib', 'node_modules', 'openclaw', 'package.json')
    const packageRoot = path.dirname(packageJson)
    const nodeAliasRoot = path.join(root, 'tools', 'node')
    const alias = await fs.lstat(nodeAliasRoot)
    if (alias?.kind !== 'symbolic_link'
      || alias.ownerUid !== expectedOwnerUid()
      || path.resolve(await fs.realpath(nodeAliasRoot)) !== toolchainRoot
      || path.resolve(await fs.realpath(nodeAlias)) !== expectedNode) {
      return unavailable('openclaw_node_alias_identity_mismatch')
    }
    for (const directory of [
      root,
      path.join(root, 'bin'),
      path.join(root, 'tools'),
      toolchainRoot,
      path.join(toolchainRoot, 'bin'),
      path.join(toolchainRoot, 'lib'),
      path.join(toolchainRoot, 'lib', 'node_modules'),
      path.join(toolchainRoot, 'lib', 'node_modules', 'openclaw'),
      path.join(toolchainRoot, 'lib', 'node_modules', 'openclaw', 'dist'),
    ]) {
      if (!await isCanonicalOwnedDirectory(fs, directory)) {
        return unavailable('openclaw_directory_permissions_invalid')
      }
    }
    for (const file of [executableRealpath, expectedNode, entry, packageJson]) {
      if (!await isCanonicalOwnedFile(fs, file)) return unavailable('openclaw_surface_not_canonical')
    }
    const nodeBefore = await fs.readStableFileFingerprint(expectedNode, 256 * 1024 * 1024)
    const entryBefore = await fs.readStableFileSnapshot(entry, 4 * 1024 * 1024)
    const manifestBefore = await fs.readStableFileSnapshot(packageJson, 256 * 1024)
    const tree = await fs.readStablePackageTree(packageRoot)
    const wrapperAfter = await fs.readStableFileSnapshot(executableRealpath, 4 * 1024)
    const nodeAfter = await fs.readStableFileFingerprint(expectedNode, 256 * 1024 * 1024)
    const entryAfter = await fs.readStableFileSnapshot(entry, 4 * 1024 * 1024)
    const manifestAfter = await fs.readStableFileSnapshot(packageJson, 256 * 1024)
    const treeEntry = tree.proofNodes.find(node => node.path === entry)
    const treeManifest = tree.proofNodes.find(node => node.path === packageJson)
    if (!nodeBefore.executable
      || !isSafeUserOwned(nodeBefore)
      || !isSafeUserOwned(entryBefore)
      || !isSafeUserOwned(manifestBefore)
      || wrapperAfter.fingerprint !== wrapperBefore.fingerprint
      || nodeAfter.fingerprint !== nodeBefore.fingerprint
      || entryAfter.fingerprint !== entryBefore.fingerprint
      || manifestAfter.fingerprint !== manifestBefore.fingerprint
      || treeEntry?.fingerprint !== entryBefore.fingerprint
      || treeManifest?.fingerprint !== manifestBefore.fingerprint
      || !await fs.verifyStablePackageTree(packageRoot, tree)
      || path.resolve(await fs.realpath(nodeAliasRoot)) !== toolchainRoot
      || path.resolve(await fs.realpath(nodeAlias)) !== expectedNode) {
      return unavailable('openclaw_wrapper_surface_changed')
    }
    const parsed = JSON.parse(Buffer.from(manifestBefore.content).toString('utf8')) as {
      name?: unknown
      version?: unknown
      type?: unknown
      bin?: unknown
    }
    if (parsed.name !== 'openclaw'
      || typeof parsed.version !== 'string' || !VERSION.test(parsed.version)
      || parsed.type !== 'module'
      || !parsed.bin || typeof parsed.bin !== 'object' || Array.isArray(parsed.bin)
      || (parsed.bin as Record<string, unknown>).openclaw !== 'openclaw.mjs') {
      return unavailable('openclaw_package_identity_mismatch')
    }
    const packageMetadataFingerprint = createHash('sha256').update(JSON.stringify({
      schema: 'openclaw-official-wrapper-v1',
      wrapper: wrapperBefore.fingerprint,
      node: nodeBefore.fingerprint,
      entry: entryBefore.fingerprint,
      manifest: manifestBefore.fingerprint,
      version: parsed.version,
    })).digest('hex')
    const proofNodes = [
      packageProofNode('openclaw_wrapper', executableRealpath, 4 * 1024, wrapperBefore),
      packageProofNode('openclaw_node_runtime', expectedNode, 256 * 1024 * 1024, nodeBefore),
      ...tree.proofNodes.map(node => ({
        ...node,
        role: node.path === entry
          ? 'openclaw_entry' as const
          : node.path === packageJson
            ? 'package_manifest' as const
            : 'openclaw_package_file' as const,
      })),
    ] as const
    const portableWrapper = normalizedOpenClawWrapperBytes(entryRelative[0]!)
    return success(
      parsed.version,
      'npm_metadata:openclaw',
      packageMetadataFingerprint,
      proofNodes,
      portableFingerprint({
        schema: 'openclaw-official-wrapper-v1',
        version: parsed.version,
        wrapper: {
          relativePath: 'bin/openclaw',
          sha256: createHash('sha256').update(portableWrapper).digest('hex'),
          sizeBytes: portableWrapper.length,
          executable: true,
        },
        node: portableFile(path.relative(root, expectedNode), nodeBefore),
        ownedPackageSha256: tree.packageTreeSha256,
        ownedEntryCount: tree.ownedEntryCount,
        ownedTotalBytes: tree.ownedTotalBytes,
      }),
      tree.packageTreeSha256,
    )
  } catch {
    return unavailable('openclaw_wrapper_metadata_unavailable')
  }
}

/**
 * Qwen Code 0.23.0's official archive contains one self-contained root whose
 * inner launcher derives that root and invokes the exact bundled Node/CLI.
 * The official installer may additionally expose a three-line absolute outer
 * shim. That shim is decoded and canonically re-encoded without evaluating
 * shell text; both layers and the complete owned root remain frozen.
 */
async function inspectOfficialQwenLauncher(
  executableRealpath: string,
  fs: PassiveVersionFileSystem,
  architecture: 'arm64' | 'x64',
): Promise<VersionCommandResult | null> {
  if (path.basename(executableRealpath) !== 'qwen') return null
  try {
    const entryLauncherBefore = await fs.readStableFileSnapshot(executableRealpath, 4 * 1024)
    if (!entryLauncherBefore.executable) return unavailable('qwen_launcher_not_executable')
    const entryLauncher = Buffer.from(entryLauncherBefore.content).toString('utf8')
    const canonicalInnerLauncher = normalizedQwenLauncherBytes().toString('utf8')
    const installerTarget = qwenInstallerShimTarget(entryLauncher)
    const isInstallerShim = installerTarget !== undefined
    const expectedLauncher = installerTarget ?? executableRealpath
    if (expectedLauncher === executableRealpath && entryLauncher !== canonicalInnerLauncher) {
      return unavailable('qwen_launcher_identity_mismatch')
    }
    if (!isInstallerShim && path.basename(path.dirname(expectedLauncher)) !== 'bin') {
      return unavailable('qwen_launcher_target_not_canonical')
    }
    const launcherBefore = isInstallerShim
      ? await fs.readStableFileSnapshot(expectedLauncher, 4 * 1024)
      : entryLauncherBefore
    if (Buffer.from(launcherBefore.content).toString('utf8') !== canonicalInnerLauncher) {
      return unavailable('qwen_launcher_identity_mismatch')
    }
    const packageRoot = path.dirname(path.dirname(expectedLauncher))
    const packageJson = path.join(packageRoot, 'package.json')
    const standaloneManifest = path.join(packageRoot, 'manifest.json')
    const cliEntry = path.join(packageRoot, 'lib', 'cli-entry.js')
    const nodeRuntime = path.join(packageRoot, 'node', 'bin', 'node')
    const canonicalFiles = [executableRealpath, expectedLauncher, packageJson, standaloneManifest, cliEntry, nodeRuntime]
    if ((await fs.lstat(packageRoot))?.kind !== 'directory'
      || path.resolve(await fs.realpath(packageRoot)) !== packageRoot
      || (await Promise.all(canonicalFiles.map(async filePath => (
        (await fs.lstat(filePath))?.kind === 'file'
        && path.resolve(await fs.realpath(filePath)) === filePath
      )))).some(canonical => !canonical)) {
      return unavailable('qwen_launcher_target_not_canonical')
    }
    const manifestBefore = await fs.readStableFileSnapshot(packageJson, 32 * 1024)
    const standaloneBefore = await fs.readStableFileSnapshot(standaloneManifest, 64 * 1024)
    const cliEntryBefore = await fs.readStableFileSnapshot(cliEntry, 32 * 1024)
    const entryLauncherAfter = await fs.readStableFileSnapshot(executableRealpath, 4 * 1024)
    const launcherAfter = await fs.readStableFileSnapshot(expectedLauncher, 4 * 1024)
    const manifestAfter = await fs.readStableFileSnapshot(packageJson, 32 * 1024)
    const standaloneAfter = await fs.readStableFileSnapshot(standaloneManifest, 64 * 1024)
    const cliEntryAfter = await fs.readStableFileSnapshot(cliEntry, 32 * 1024)
    if (entryLauncherAfter.fingerprint !== entryLauncherBefore.fingerprint
      || launcherAfter.fingerprint !== launcherBefore.fingerprint
      || manifestAfter.fingerprint !== manifestBefore.fingerprint
      || standaloneAfter.fingerprint !== standaloneBefore.fingerprint
      || cliEntryAfter.fingerprint !== cliEntryBefore.fingerprint) {
      return unavailable('qwen_launcher_surface_changed')
    }
    const parsed = JSON.parse(Buffer.from(manifestBefore.content).toString('utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (parsed.name !== '@qwen-code/qwen-code'
      || typeof parsed.version !== 'string'
      || !VERSION.test(parsed.version)) {
      return unavailable('qwen_launcher_package_identity_mismatch')
    }
    const packageMetadataFingerprint = createHash('sha256').update(JSON.stringify({
      schema: 'qwen-local-launcher-v1',
      entryLauncher: entryLauncherBefore.fingerprint,
      launcher: launcherBefore.fingerprint,
      packageManifest: manifestBefore.fingerprint,
      standaloneManifest: standaloneBefore.fingerprint,
      cliEntry: cliEntryBefore.fingerprint,
    })).digest('hex')
    const detected = () => success(
      parsed.version as string,
      'npm_metadata:@qwen-code/qwen-code',
      packageMetadataFingerprint,
      [
        packageProofNode('qwen_launcher', executableRealpath, 4 * 1024, entryLauncherBefore),
        ...(isInstallerShim
          ? [packageProofNode('qwen_inner_launcher', expectedLauncher, 4 * 1024, launcherBefore)]
          : []),
        packageProofNode('package_manifest', packageJson, 32 * 1024, manifestBefore),
        packageProofNode('qwen_standalone_manifest', standaloneManifest, 64 * 1024, standaloneBefore),
        packageProofNode('qwen_cli_entry', cliEntry, 32 * 1024, cliEntryBefore),
      ],
    )
    if (!fs.readStablePackageTree || !fs.verifyStablePackageTree) return detected()

    const standalone = JSON.parse(Buffer.from(standaloneBefore.content).toString('utf8')) as {
      name?: unknown
      version?: unknown
      target?: unknown
      runtime?: unknown
      nodeArchive?: unknown
    }
    if (standalone.name !== '@qwen-code/qwen-code'
      || standalone.version !== parsed.version
      || standalone.target !== `darwin-${architecture}`
      || standalone.runtime !== 'node'
      || typeof standalone.nodeArchive !== 'string'
      || !standalone.nodeArchive.includes(`darwin-${architecture}`)) return detected()

    const treeOptions = { includeNodeModules: true }
    const tree = await fs.readStablePackageTree(packageRoot, treeOptions)
    const launcherTreeNode = tree.proofNodes.find(node => node.path === expectedLauncher)
    const packageNode = tree.proofNodes.find(node => node.path === packageJson)
    const standaloneNode = tree.proofNodes.find(node => node.path === standaloneManifest)
    const cliEntryNode = tree.proofNodes.find(node => node.path === cliEntry)
    const nodeRuntimeNode = tree.proofNodes.find(node => node.path === nodeRuntime)
    const entryLauncherAfterTree = await fs.readStableFileSnapshot(executableRealpath, 4 * 1024)
    const launcherAfterTree = await fs.readStableFileSnapshot(expectedLauncher, 4 * 1024)
    const manifestAfterTree = await fs.readStableFileSnapshot(packageJson, 32 * 1024)
    const standaloneAfterTree = await fs.readStableFileSnapshot(standaloneManifest, 64 * 1024)
    const cliEntryAfterTree = await fs.readStableFileSnapshot(cliEntry, 32 * 1024)
    if (!isSafeArtifactOwned(entryLauncherBefore)
      || !isSafeArtifactOwned(launcherBefore)
      || !isSafeArtifactOwned(manifestBefore)
      || !isSafeArtifactOwned(standaloneBefore)
      || !isSafeArtifactOwned(cliEntryBefore)
      || entryLauncherAfterTree.fingerprint !== entryLauncherBefore.fingerprint
      || launcherAfterTree.fingerprint !== launcherBefore.fingerprint
      || manifestAfterTree.fingerprint !== manifestBefore.fingerprint
      || standaloneAfterTree.fingerprint !== standaloneBefore.fingerprint
      || cliEntryAfterTree.fingerprint !== cliEntryBefore.fingerprint
      || launcherTreeNode?.fingerprint !== launcherBefore.fingerprint
      || packageNode?.fingerprint !== manifestBefore.fingerprint
      || standaloneNode?.fingerprint !== standaloneBefore.fingerprint
      || cliEntryNode?.fingerprint !== cliEntryBefore.fingerprint
      || !launcherTreeNode.executable
      || !nodeRuntimeNode?.executable
      || !await fs.verifyStablePackageTree(packageRoot, tree, treeOptions)) return detected()

    const normalizedLauncher = normalizedQwenLauncherBytes()
    const launcherPortable = {
      relativePath: 'bin/qwen',
      sha256: createHash('sha256').update(normalizedLauncher).digest('hex'),
      sizeBytes: normalizedLauncher.length,
      executable: true,
    }
    const proofNodes = [
      ...(isInstallerShim
        ? [packageProofNode('qwen_launcher', executableRealpath, 4 * 1024, entryLauncherBefore)]
        : []),
      ...tree.proofNodes.map(node => ({
        ...node,
        role: node.path === expectedLauncher
          ? (isInstallerShim ? 'qwen_inner_launcher' as const : 'qwen_launcher' as const)
          : node.path === packageJson
            ? 'package_manifest' as const
            : node.path === standaloneManifest
            ? 'qwen_standalone_manifest' as const
            : node.path === cliEntry
              ? 'qwen_cli_entry' as const
              : node.path === nodeRuntime
                ? 'qwen_node_runtime' as const
                : 'qwen_package_file' as const,
      })),
    ]
    return success(
      parsed.version,
      'npm_metadata:@qwen-code/qwen-code',
      portableFingerprint({
        schema: 'qwen-standalone-install-physical-v1',
        entryLauncher: entryLauncherBefore.fingerprint,
        innerLauncher: launcherBefore.fingerprint,
        ownedPackage: tree.physicalTreeFingerprint,
      }),
      proofNodes,
      portableFingerprint({
        schema: 'qwen-standalone-surface-v1',
        version: parsed.version,
        launcher: launcherPortable,
        standaloneManifest: portableFile(path.relative(packageRoot, standaloneManifest), standaloneNode),
        cliEntry: portableFile(path.relative(packageRoot, cliEntry), cliEntryNode),
        node: portableFile(path.relative(packageRoot, nodeRuntime), nodeRuntimeNode),
        ownedPackageSha256: tree.packageTreeSha256,
        ownedEntryCount: tree.ownedEntryCount,
        ownedTotalBytes: tree.ownedTotalBytes,
      }),
      tree.packageTreeSha256,
    )
  } catch {
    return unavailable('qwen_launcher_metadata_unavailable')
  }
}

interface NpmPackageLocation {
  packageName: string
  nodeModulesRoot: string
  packageRoot: string
  packageJson: string
  installLock: string
  installLockKey: string
  executableRealpath: string
}

function npmPackageMetadata(executableRealpath: string): NpmPackageLocation | null {
  const marker = `${path.sep}node_modules${path.sep}`
  const markerIndex = executableRealpath.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const suffix = executableRealpath.slice(markerIndex + marker.length).split(path.sep)
  const packageName = suffix[0]?.startsWith('@')
    ? `${suffix[0]}/${suffix[1] ?? ''}`
    : suffix[0]
  if (!packageName || !PACKAGE_NAME.test(packageName)) return null
  const segments = packageName.startsWith('@') ? 2 : 1
  const packageRoot = executableRealpath.slice(
    0,
    markerIndex + marker.length + suffix.slice(0, segments).join(path.sep).length,
  )
  const nodeModulesRoot = executableRealpath.slice(0, markerIndex + marker.length - 1)
  return {
    packageName,
    nodeModulesRoot,
    packageRoot,
    packageJson: path.join(packageRoot, 'package.json'),
    installLock: path.join(nodeModulesRoot, '.package-lock.json'),
    installLockKey: `node_modules/${packageName}`,
    executableRealpath,
  }
}

async function inspectNpmPackageMetadata(
  npm: NpmPackageLocation,
  fs: PassiveVersionFileSystem,
  architecture: 'arm64' | 'x64',
): Promise<VersionCommandResult> {
  try {
    const metadataStat = await fs.lstat(npm.packageJson)
    if (metadataStat?.kind !== 'file') return unavailable('package_metadata_not_regular_file')
    const metadataRealpath = path.resolve(await fs.realpath(npm.packageJson))
    if (metadataRealpath !== npm.packageJson) return unavailable('package_metadata_not_canonical')
    const manifestBefore = await fs.readStableFileSnapshot(npm.packageJson, MAX_NPM_MANIFEST_BYTES)
    const parsed = JSON.parse(Buffer.from(manifestBefore.content).toString('utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (parsed.name !== npm.packageName || typeof parsed.version !== 'string' || !VERSION.test(parsed.version)) {
      return unavailable('package_metadata_identity_mismatch')
    }
    const detected = () => success(
      parsed.version as string,
      `npm_metadata:${npm.packageName}`,
      manifestBefore.fingerprint,
      [packageProofNode('package_manifest', npm.packageJson, MAX_NPM_MANIFEST_BYTES, manifestBefore)],
    )
    if (!fs.readStablePackageTree || !fs.verifyStablePackageTree) return detected()

    try {
      const packageParent = path.dirname(npm.packageRoot)
      for (const directory of [...new Set([npm.nodeModulesRoot, packageParent])]) {
        const directoryNode = await fs.lstat(directory)
        if (directoryNode?.kind !== 'directory' || !isSafeArtifactOwned(directoryNode)
          || path.resolve(await fs.realpath(directory)) !== directory) return detected()
      }
      const lockNode = await fs.lstat(npm.installLock)
      if (lockNode?.kind !== 'file' || !isSafeArtifactOwned(lockNode)
        || path.resolve(await fs.realpath(npm.installLock)) !== npm.installLock) return detected()
      const lockBefore = await fs.readStableFileSnapshot(npm.installLock, 16 * 1024 * 1024)
      if (!isSafeArtifactOwned(lockBefore)) return detected()
      const lock = JSON.parse(Buffer.from(lockBefore.content).toString('utf8')) as {
        lockfileVersion?: unknown
        packages?: Record<string, { version?: unknown; integrity?: unknown }>
      }
      const lockEntry = lock.packages?.[npm.installLockKey]
      const integrity = lockEntry?.integrity
      if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 2
        || lockEntry?.version !== parsed.version
        || typeof integrity !== 'string'
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) return detected()

      const tree = await fs.readStablePackageTree(npm.packageRoot)
      const manifestAfter = await fs.readStableFileSnapshot(npm.packageJson, MAX_NPM_MANIFEST_BYTES)
      const lockAfter = await fs.readStableFileSnapshot(npm.installLock, 16 * 1024 * 1024)
      const treeManifest = tree.proofNodes.find(node => node.path === npm.packageJson)
      const treeExecutable = tree.proofNodes.find(node => node.path === npm.executableRealpath)
      if (manifestAfter.fingerprint !== manifestBefore.fingerprint
        || lockAfter.fingerprint !== lockBefore.fingerprint
        || treeManifest?.fingerprint !== manifestAfter.fingerprint
        || !treeExecutable?.executable
        || !await fs.verifyStablePackageTree(npm.packageRoot, tree)) return detected()
      const proofNodes = [
        packageProofNode('npm_install_lock', npm.installLock, 16 * 1024 * 1024, lockAfter),
        ...tree.proofNodes.map(node => ({
          ...node,
          role: node.path === npm.packageJson
            ? 'package_manifest' as const
            : node.path === npm.executableRealpath
              ? 'npm_package_executable' as const
              : 'npm_package_file' as const,
        })),
      ]
      const openCodeLeafBase = architecture === 'x64' && npm.packageName === 'opencode-ai'
        ? 'opencode-darwin-x64'
        : architecture === 'x64' && npm.packageName === '@opencode-ai/cli'
          ? '@opencode-ai/cli-darwin-x64'
          : null
      const lockKeys = Object.keys(lock.packages ?? {})
      const hasInstalledComponent = (name: string) => lockKeys.some(candidate => (
        candidate === `node_modules/${name}` || candidate.endsWith(`/node_modules/${name}`)
      ))
      const hasModern = Boolean(openCodeLeafBase && hasInstalledComponent(openCodeLeafBase))
      const hasBaseline = Boolean(openCodeLeafBase && hasInstalledComponent(`${openCodeLeafBase}-baseline`))
      if (openCodeLeafBase && (!hasModern || !hasBaseline)) return detected()
      const compositionSpec = npmComposedDistributionSpec(
        npm.packageName,
        parsed.version as string,
        architecture,
        'modern',
      )
      if (compositionSpec) {
        if (path.relative(npm.packageRoot, npm.executableRealpath).split(path.sep).join('/')
          !== compositionSpec.rootExecutableRelativePath) return detected()
        const components = []
        const componentProofNodes: PackageMetadataProofNode[] = []
        for (const component of compositionSpec.components) {
          const lockSuffix = `node_modules/${component.installName}`
          const lockKeys = Object.keys(lock.packages ?? {}).filter(candidate => (
            candidate === lockSuffix || candidate.endsWith(`/${lockSuffix}`)
          ))
          if (lockKeys.length !== 1) return detected()
          const lockKey = lockKeys[0]!
          const packageRelative = lockKey.slice('node_modules/'.length)
          if (!packageRelative || packageRelative.split('/').includes('..')) return detected()
          const packageRoot = path.join(npm.nodeModulesRoot, ...packageRelative.split('/'))
          const packageJson = path.join(packageRoot, 'package.json')
          const lockComponent = lock.packages?.[lockKey]
          if (lockComponent?.version !== component.version
            || typeof lockComponent.integrity !== 'string'
            || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockComponent.integrity)) return detected()
          const manifest = await fs.readStableFileSnapshot(packageJson, MAX_NPM_MANIFEST_BYTES)
          const manifestValue = JSON.parse(Buffer.from(manifest.content).toString('utf8')) as {
            name?: unknown
            version?: unknown
            os?: unknown
            cpu?: unknown
          }
          if (manifestValue.name !== component.manifestName || manifestValue.version !== component.version
            || (Array.isArray(manifestValue.os) && !manifestValue.os.includes('darwin'))
            || (Array.isArray(manifestValue.cpu) && !manifestValue.cpu.includes(architecture))) return detected()
          const componentTree = await fs.readStablePackageTree(packageRoot)
          const manifestNode = componentTree.proofNodes.find(node => node.path === packageJson)
          if (manifestNode?.fingerprint !== manifest.fingerprint
            || !await fs.verifyStablePackageTree(packageRoot, componentTree)) return detected()
          let native = null
          if (component.nativeExecutableRelativePath) {
            const nativePath = path.join(packageRoot, ...component.nativeExecutableRelativePath.split('/'))
            native = componentTree.proofNodes.find(node => node.path === nativePath) ?? null
            if (!native || native.entryType === 'symlink'
              || (compositionSpec.entryRule !== 'js_entry_loads_platform_native_v1' && !native.executable)) return detected()
          }
          componentProofNodes.push(...componentTree.proofNodes.map(node => ({
            ...node,
            role: node.path === packageJson
              ? 'npm_component_manifest' as const
              : node.path === native?.path
                ? 'npm_component_native_executable' as const
                : 'npm_component_file' as const,
          })))
          components.push({
            role: component.role,
            installName: component.installName,
            manifestName: component.manifestName,
            version: component.version,
            integrity: lockComponent.integrity,
            ownedPackageSha256: componentTree.packageTreeSha256,
            ownedEntryCount: componentTree.ownedEntryCount,
            ownedTotalBytes: componentTree.ownedTotalBytes,
            nativeExecutableRelativePath: component.nativeExecutableRelativePath,
            nativeExecutableSha256: native?.sha256 ?? null,
            nativeExecutableSizeBytes: native?.size ?? null,
          })
        }
        const leaves = components.filter(component => component.role === 'platform_leaf')
        if (leaves.length === 0 || leaves.some(leaf => (
          !leaf.nativeExecutableSha256 || !leaf.nativeExecutableSizeBytes
        ))) return detected()
        if (compositionSpec.entryRule === 'copy_platform_binary_v1') {
          const matches = leaves.filter(leaf => (
            treeExecutable.sha256 === leaf.nativeExecutableSha256
              && treeExecutable.size === leaf.nativeExecutableSizeBytes
          ))
          const isOpenCodeV1X64 = architecture === 'x64' && npm.packageName === 'opencode-ai'
          const isOpenCodeV2X64 = architecture === 'x64' && npm.packageName === '@opencode-ai/cli'
          if ((isOpenCodeV1X64 && (leaves.length !== 2 || matches.length !== 2))
            || (isOpenCodeV2X64 && (leaves.length !== 2 || matches.length !== 1))
            || (!isOpenCodeV1X64 && !isOpenCodeV2X64 && matches.length !== 1)) return detected()
        }
        const composed = {
          entryRule: compositionSpec.entryRule,
          components,
        }
        const composedTreeSha256 = portableFingerprint({
          schema: 'npm-composed-owned-packages-v1',
          root: {
            packageName: npm.packageName,
            integrity,
            ownedPackageSha256: tree.packageTreeSha256,
            ownedEntryCount: tree.ownedEntryCount,
            ownedTotalBytes: tree.ownedTotalBytes,
          },
          ...composed,
        })
        return success(
          parsed.version as string,
          `npm_metadata:${npm.packageName}`,
          portableFingerprint({
            schema: 'npm-composed-install-receipt-physical-v1',
            rootPackage: tree.physicalTreeFingerprint,
            components: componentProofNodes.map(node => node.fingerprint),
            installLock: lockAfter.fingerprint,
          }),
          [...proofNodes, ...componentProofNodes],
          portableFingerprint({
            schema: 'npm-composed-platform-surface-v1',
            version: parsed.version,
            packageName: npm.packageName,
            integrity,
            executable: portableFile(path.relative(npm.packageRoot, npm.executableRealpath), treeExecutable),
            ownedPackageSha256: tree.packageTreeSha256,
            ownedEntryCount: tree.ownedEntryCount,
            ownedTotalBytes: tree.ownedTotalBytes,
            ...composed,
          }),
          composedTreeSha256,
          composed,
        )
      }
      return success(
        parsed.version,
        `npm_metadata:${npm.packageName}`,
        portableFingerprint({
          schema: 'npm-package-install-receipt-physical-v1',
          packageName: npm.packageName,
          version: parsed.version,
          integrity,
          installLock: lockAfter.fingerprint,
          packageTree: tree.physicalTreeFingerprint,
        }),
        proofNodes,
        portableFingerprint({
          schema: 'npm-owned-package-surface-v1',
          version: parsed.version,
          packageName: npm.packageName,
          integrity,
          executable: portableFile(path.relative(npm.packageRoot, npm.executableRealpath), treeExecutable),
          ownedPackageSha256: tree.packageTreeSha256,
          ownedEntryCount: tree.ownedEntryCount,
          ownedTotalBytes: tree.ownedTotalBytes,
        }),
        tree.packageTreeSha256,
      )
    } catch {
      return detected()
    }
  } catch {
    return unavailable('package_metadata_unavailable')
  }
}

function success(
  version: string,
  verifiedPackageProvenance?: string,
  packageMetadataFingerprint?: string,
  packageProofNodes?: readonly PackageMetadataProofNode[],
  portableArtifactFingerprint?: string,
  packageTreeSha256?: string,
  npmComposition?: VersionCommandResult['npmComposition'],
): VersionCommandResult {
  return verifiedPackageProvenance
    ? {
        exitCode: 0,
        stdout: version,
        stderr: '',
        verifiedPackageProvenance,
        packageMetadataFingerprint,
        ...(packageProofNodes ? { packageProofNodes } : {}),
        ...(portableArtifactFingerprint ? { portableArtifactFingerprint } : {}),
        ...(packageTreeSha256 ? { packageTreeSha256 } : {}),
        ...(npmComposition ? { npmComposition } : {}),
      }
    : { exitCode: 0, stdout: version, stderr: '' }
}

function portableFile(relativePath: string, snapshot: StableFileFingerprint): Record<string, unknown> {
  return {
    relativePath: relativePath.split(path.sep).join('/'),
    sha256: snapshot.sha256,
    sizeBytes: snapshot.size,
    executable: snapshot.executable,
  }
}

function portableOwnedEntry(packageRoot: string, node: PackageMetadataProofNode): Record<string, unknown> {
  return {
    relativePath: path.relative(packageRoot, node.path).split(path.sep).join('/'),
    entryType: node.entryType ?? 'file',
    sha256: node.sha256,
    sizeBytes: node.size,
    executable: node.entryType === 'symlink' ? false : node.executable,
    symlinkTarget: node.entryType === 'symlink' ? node.symlinkTarget ?? null : null,
  }
}

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function portableFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function packageProofNode(
  role: PackageMetadataProofNode['role'],
  targetPath: string,
  maxBytes: number,
  snapshot: StableFileFingerprint,
): PackageMetadataProofNode {
  return {
    device: snapshot.device,
    inode: snapshot.inode,
    linkCount: snapshot.linkCount,
    mode: snapshot.mode,
    size: snapshot.size,
    mtimeNs: snapshot.mtimeNs,
    ctimeNs: snapshot.ctimeNs,
    sha256: snapshot.sha256,
    fingerprint: snapshot.fingerprint,
    executable: snapshot.executable,
    ownerUid: snapshot.ownerUid,
    groupGid: snapshot.groupGid,
    role,
    path: path.resolve(targetPath),
    maxBytes,
  }
}

function unavailable(reason: string): VersionCommandResult {
  return { exitCode: 126, stdout: '', stderr: reason }
}
