import path from 'node:path'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type {
  PackageMetadataProofNode,
  StableFileFingerprint,
  StableFileMetadata,
  StableFileSnapshot,
  VersionCommandResult,
} from './discovery'

const VERSION = /^(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

export interface PassiveVersionFileSystem {
  lstat(targetPath: string): Promise<{ kind: 'file' | 'directory' | 'symbolic_link' | 'other' } | undefined>
  realpath(targetPath: string): Promise<string>
  readStableFileSnapshot(targetPath: string, maxBytes: number): Promise<StableFileSnapshot>
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
    const fingerprint = createHash('sha256').update(JSON.stringify({
      device,
      inode,
      size: Number(before.size),
      mode,
      linkCount,
      mtimeNs,
      ctimeNs,
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
      sha256,
    })).digest('hex'),
    executable: (mode & 0o111) !== 0,
  }
}

function fileStatIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
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
  const normalized = path.resolve(executableRealpath)
  const qwenLauncher = await inspectOfficialQwenLauncher(normalized, fs)
  if (qwenLauncher) return qwenLauncher
  const npm = npmPackageMetadata(normalized)
  if (npm) {
    try {
      const metadataStat = await fs.lstat(npm.packageJson)
      if (metadataStat?.kind !== 'file') return unavailable('package_metadata_not_regular_file')
      const metadataRealpath = path.resolve(await fs.realpath(npm.packageJson))
      if (metadataRealpath !== npm.packageJson) return unavailable('package_metadata_not_canonical')
      const snapshot = await fs.readStableFileSnapshot(npm.packageJson, 32 * 1024)
      const raw = Buffer.from(snapshot.content).toString('utf8')
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown }
      if (parsed.name === npm.packageName && typeof parsed.version === 'string' && VERSION.test(parsed.version)) {
        return success(
          parsed.version,
          `npm_metadata:${npm.packageName}`,
          snapshot.fingerprint,
          [packageProofNode('package_manifest', npm.packageJson, 32 * 1024, snapshot)],
        )
      }
      return unavailable('package_metadata_identity_mismatch')
    } catch {
      return unavailable('package_metadata_unavailable')
    }
  }

  const homebrew = normalized.match(/\/(?:Cellar|homebrew\/Cellar)\/[^/]+\/([^/]+)(?:\/|$)/u)?.[1]
  if (homebrew && VERSION.test(homebrew)) return success(homebrew)

  const managedVersion = normalized.match(/\/(?:versions|releases)\/([^/]+)(?:\/|$)/u)?.[1]
  if (managedVersion && VERSION.test(managedVersion)) return success(managedVersion)

  return unavailable('passive_version_metadata_unavailable')
}

/**
 * Qwen Code's official local installer places a tiny immutable launcher at
 * `<prefix>/bin/qwen` and the reviewed package under
 * `<prefix>/lib/qwen-code`. The launcher is authority only when its exact
 * grammar points to that contained target and launcher, target and manifest
 * all survive a repeated stable snapshot. An arbitrary same-named shell file
 * or a relocated target remains unproven.
 */
async function inspectOfficialQwenLauncher(
  executableRealpath: string,
  fs: PassiveVersionFileSystem,
): Promise<VersionCommandResult | null> {
  if (path.basename(executableRealpath) !== 'qwen'
    || path.basename(path.dirname(executableRealpath)) !== 'bin') return null
  const prefix = path.dirname(path.dirname(executableRealpath))
  const expectedLauncher = path.join(prefix, 'bin', 'qwen')
  if (executableRealpath !== expectedLauncher) return null
  try {
    const launcherBefore = await fs.readStableFileSnapshot(expectedLauncher, 4 * 1024)
    if (!launcherBefore.executable) return unavailable('qwen_launcher_not_executable')
    const launcher = Buffer.from(launcherBefore.content).toString('utf8')
    const target = launcher.match(/^#!\/usr\/bin\/env sh\r?\nexec '([^'\r\n]+)' "\$@"\r?\n?$/u)?.[1]
    const expectedTarget = path.join(prefix, 'lib', 'qwen-code', 'bin', 'qwen')
    if (!target || path.resolve(target) !== expectedTarget) {
      return unavailable('qwen_launcher_identity_mismatch')
    }
    const packageJson = path.join(prefix, 'lib', 'qwen-code', 'package.json')
    if ((await fs.lstat(expectedTarget))?.kind !== 'file'
      || path.resolve(await fs.realpath(expectedTarget)) !== expectedTarget
      || (await fs.lstat(packageJson))?.kind !== 'file'
      || path.resolve(await fs.realpath(packageJson)) !== packageJson) {
      return unavailable('qwen_launcher_target_not_canonical')
    }
    const targetBefore = await fs.readStableFileSnapshot(expectedTarget, 32 * 1024)
    const manifestBefore = await fs.readStableFileSnapshot(packageJson, 32 * 1024)
    const launcherAfter = await fs.readStableFileSnapshot(expectedLauncher, 4 * 1024)
    const targetAfter = await fs.readStableFileSnapshot(expectedTarget, 32 * 1024)
    const manifestAfter = await fs.readStableFileSnapshot(packageJson, 32 * 1024)
    if (!targetBefore.executable
      || launcherAfter.fingerprint !== launcherBefore.fingerprint
      || targetAfter.fingerprint !== targetBefore.fingerprint
      || manifestAfter.fingerprint !== manifestBefore.fingerprint) {
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
      launcher: launcherBefore.fingerprint,
      target: targetBefore.fingerprint,
      manifest: manifestBefore.fingerprint,
    })).digest('hex')
    return success(
      parsed.version,
      'npm_metadata:@qwen-code/qwen-code',
      packageMetadataFingerprint,
      [
        packageProofNode('qwen_launcher', expectedLauncher, 4 * 1024, launcherBefore),
        packageProofNode('qwen_target', expectedTarget, 32 * 1024, targetBefore),
        packageProofNode('package_manifest', packageJson, 32 * 1024, manifestBefore),
      ],
    )
  } catch {
    return unavailable('qwen_launcher_metadata_unavailable')
  }
}

function npmPackageMetadata(executableRealpath: string): {
  packageName: string
  packageJson: string
} | null {
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
  return { packageName, packageJson: path.join(packageRoot, 'package.json') }
}

function success(
  version: string,
  verifiedPackageProvenance?: string,
  packageMetadataFingerprint?: string,
  packageProofNodes?: readonly PackageMetadataProofNode[],
): VersionCommandResult {
  return verifiedPackageProvenance
    ? {
        exitCode: 0,
        stdout: version,
        stderr: '',
        verifiedPackageProvenance,
        packageMetadataFingerprint,
        ...(packageProofNodes ? { packageProofNodes } : {}),
      }
    : { exitCode: 0, stdout: version, stderr: '' }
}

function packageProofNode(
  role: PackageMetadataProofNode['role'],
  targetPath: string,
  maxBytes: number,
  snapshot: StableFileSnapshot,
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
    role,
    path: path.resolve(targetPath),
    maxBytes,
  }
}

function unavailable(reason: string): VersionCommandResult {
  return { exitCode: 126, stdout: '', stderr: reason }
}
