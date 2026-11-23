import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sha256Bytes } from './fingerprint'
import { bridgeFileIdentity } from '@server/db/codex-bridge-continuity.js'
import { MAX_CODEX_MCP_CONFIG_BYTES } from '@server/utils/codex-mcp-semantic.js'

export interface ManagedTextSnapshot {
  canonicalPath: string
  allowedRoot: string
  content: string
  containerHash: string
  fileIdentity: string
  ancestorIdentity: string
  device: string
}

function snapshotAncestors(target: string, root: string): string {
  assertTargetWithinRoot(target, root)
  if (fs.realpathSync.native(root) !== path.resolve(root)
    || assertSafeManagedAncestorChain(target, root) !== path.dirname(target)) {
    throw new FilePreconditionError('Managed readback path changed')
  }
  const identities: string[] = []
  let cursor = path.resolve(root)
  const parent = path.dirname(target)
  for (;;) {
    const st = fs.lstatSync(cursor, { bigint: true })
    if (!st.isDirectory() || st.isSymbolicLink()) throw new FilePreconditionError('Unsafe readback ancestor')
    identities.push([st.dev, st.ino, st.mode, st.uid, st.gid].join(':'))
    if (cursor === parent) break
    const next = path.relative(cursor, parent).split(path.sep)[0]
    if (!next || next === '..') throw new FilePreconditionError('Invalid readback boundary')
    cursor = path.join(cursor, next)
  }
  return identities.join('|')
}

/** A bounded, single-FD snapshot. Never use a path read after capturing metadata. */
export function readManagedTextSnapshot(targetPath: string, allowedRoot: string): ManagedTextSnapshot {
  let fd: number | undefined
  try {
    const target = path.resolve(targetPath)
    const root = path.resolve(allowedRoot)
    if (target !== targetPath || root !== allowedRoot || fs.realpathSync.native(target) !== target) {
      throw new FilePreconditionError('Noncanonical managed readback target')
    }
    const ancestors = snapshotAncestors(target, root)
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_CODEX_MCP_CONFIG_BYTES)
      || (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) {
      throw new FilePreconditionError('Unsupported managed readback file')
    }
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes)
      if (!read) break
      bytes += read
    }
    const after = fs.fstatSync(fd, { bigint: true })
    const current = fs.lstatSync(target, { bigint: true })
    const equal = (left: fs.BigIntStats, right: fs.BigIntStats) =>
      bridgeFileIdentity(left) === bridgeFileIdentity(right) && left.dev === right.dev
      && left.uid === right.uid && left.gid === right.gid
    if (bytes !== Number(before.size) || !equal(before, after) || !equal(after, current)
      || current.isSymbolicLink() || fs.realpathSync.native(target) !== target
      || snapshotAncestors(target, root) !== ancestors) {
      throw new FilePreconditionError('Managed readback changed during observation')
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))
    return { canonicalPath: target, allowedRoot: root, content, containerHash: sha256Bytes(buffer.subarray(0, bytes)),
      fileIdentity: bridgeFileIdentity(after), ancestorIdentity: ancestors, device: String(after.dev) }
  } catch {
    // OS/parser exceptions may contain private configuration paths or text.
    throw new FilePreconditionError('Unable to obtain a stable managed text snapshot')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Synchronous final check, immediately before the proof transaction publishes. */
export function assertManagedTextSnapshotCurrent(snapshot: ManagedTextSnapshot): void {
  const current = readManagedTextSnapshot(snapshot.canonicalPath, snapshot.allowedRoot)
  if (current.fileIdentity !== snapshot.fileIdentity || current.containerHash !== snapshot.containerHash
    || current.ancestorIdentity !== snapshot.ancestorIdentity || current.device !== snapshot.device) {
    throw new FilePreconditionError('Managed readback snapshot is no longer current')
  }
}

export interface FileFingerprint {
  exists: boolean
  canonicalPath: string
  containerHash: string | null
  mode: number | null
  uid: number | null
  gid: number | null
  size: number | null
  modifiedMs: number | null
  inode: number | null
}

export interface AtomicCasWriteOptions {
  /** null means the target must still be absent. */
  expectedContainerHash: string | null
  expectedCanonicalPath?: string
  expectedUid?: number
  createMode?: number
}

export interface AtomicCasRemoveOptions {
  expectedContainerHash: string
  expectedCanonicalPath: string
  allowedRoot: string
}

export class FilePreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilePreconditionError'
  }
}

export function inspectRegularFile(targetPath: string): FileFingerprint {
  if (!path.isAbsolute(targetPath)) {
    throw new FilePreconditionError(`Managed target must be absolute: ${targetPath}`)
  }

  const parent = path.dirname(targetPath)
  const canonicalParent = fs.realpathSync(parent)
  const canonicalPath = path.join(canonicalParent, path.basename(targetPath))

  let stat: fs.Stats
  try {
    stat = fs.lstatSync(canonicalPath)
  } catch (error) {
    if (isMissing(error)) {
      return {
        exists: false,
        canonicalPath,
        containerHash: null,
        mode: null,
        uid: null,
        gid: null,
        size: null,
        modifiedMs: null,
        inode: null,
      }
    }
    throw error
  }

  if (stat.isSymbolicLink()) {
    throw new FilePreconditionError(`Refused symbolic-link managed target: ${canonicalPath}`)
  }
  if (!stat.isFile()) {
    throw new FilePreconditionError(`Managed target is not a regular file: ${canonicalPath}`)
  }

  const content = fs.readFileSync(canonicalPath)
  return {
    exists: true,
    canonicalPath,
    containerHash: sha256Bytes(content),
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    inode: stat.ino,
  }
}

/**
 * Inspect a managed file whose config directory may not exist yet. Existing
 * path components below the nearest existing boundary are rejected when they
 * are symlinks, so a first-write plan cannot be redirected after discovery.
 */
export function inspectRegularFileWithinRoot(targetPath: string, allowedRoot: string): FileFingerprint {
  assertTargetWithinRoot(targetPath, allowedRoot)
  const parent = path.dirname(path.resolve(targetPath))
  const canonicalParent = assertSafeManagedAncestorChain(targetPath, allowedRoot)
  if (fs.existsSync(parent)) return inspectRegularFile(targetPath)
  return absentFingerprint(path.join(canonicalParent, path.basename(targetPath)))
}

/** Create only missing directories inside the approved config root. */
export function ensureSafeParentDirectoryWithinRoot(targetPath: string, allowedRoot: string): void {
  assertTargetWithinRoot(targetPath, allowedRoot)
  const parent = path.dirname(path.resolve(targetPath))
  assertSafeManagedAncestorChain(targetPath, allowedRoot)
  const missing: string[] = []
  let cursor = parent
  while (cursor !== path.dirname(cursor) && !fs.existsSync(cursor)) {
    missing.push(cursor)
    cursor = path.dirname(cursor)
  }
  for (const directory of missing.reverse()) {
    fs.mkdirSync(directory)
    if (fs.lstatSync(directory).isSymbolicLink()) {
      throw new FilePreconditionError(`Refused symbolic-link managed parent: ${directory}`)
    }
  }
  assertSafeManagedAncestorChain(targetPath, allowedRoot)
}

/**
 * Replace one regular file with optimistic compare-and-swap semantics.
 *
 * Atomic rename prevents torn files; the final fingerprint/hash check protects
 * the inspect -> apply window. It cannot make third-party, unlocked writes
 * transactional, so callers must still hold the mutation-domain OS lock for
 * the full final-inspect/effect/read-back/receipt window.
 */
export function writeRegularFileAtomicCas(
  targetPath: string,
  content: string | Buffer,
  options: AtomicCasWriteOptions,
): FileFingerprint {
  const before = inspectRegularFile(targetPath)
  assertPreconditions(before, options)

  const parent = path.dirname(before.canonicalPath)
  const tempPath = path.join(
    parent,
    `.${path.basename(before.canonicalPath)}.tidemind-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  )
  const mode = before.mode ?? options.createMode ?? 0o600
  let tempFd: number | undefined

  try {
    tempFd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode)
    fs.writeFileSync(tempFd, content)
    fs.fsyncSync(tempFd)
    fs.closeSync(tempFd)
    tempFd = undefined

    // Re-check immediately before replace. The mutation-domain lock protects
    // cooperative writers; this catches uncoordinated edits in the common case.
    const finalBefore = inspectRegularFile(before.canonicalPath)
    assertSameObservedFile(before, finalBefore)
    assertPreconditions(finalBefore, options)

    fs.renameSync(tempPath, before.canonicalPath)
    fs.chmodSync(before.canonicalPath, mode)
    fsyncDirectory(parent)
  } catch (error) {
    if (tempFd !== undefined) {
      try { fs.closeSync(tempFd) } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath) } catch { /* missing or cleanup failure */ }
    throw error
  }

  const after = inspectRegularFile(before.canonicalPath)
  const desiredHash = sha256Bytes(content)
  if (after.containerHash !== desiredHash) {
    throw new FilePreconditionError(`Managed target read-back mismatch: ${after.canonicalPath}`)
  }
  return after
}

/**
 * Whole-file removal is intentionally unavailable. Node does not expose a
 * portable dirfd-relative unlink primitive, so a pathname unlink would retain
 * a final parent-directory symlink race after the last read-back.
 */
export function removeRegularFileAtomicCas(
  targetPath: string,
  options: AtomicCasRemoveOptions,
): FileFingerprint {
  void targetPath
  void options
  throw new FilePreconditionError('Automatic whole-file removal requires a safe dirfd-relative unlink primitive')
}

function assertPreconditions(observed: FileFingerprint, options: AtomicCasWriteOptions): void {
  if (options.expectedCanonicalPath !== undefined && observed.canonicalPath !== options.expectedCanonicalPath) {
    throw new FilePreconditionError(
      `Managed target canonical path changed: expected ${options.expectedCanonicalPath}, got ${observed.canonicalPath}`,
    )
  }
  if (observed.containerHash !== options.expectedContainerHash) {
    throw new FilePreconditionError(
      `Managed target changed since plan: expected ${options.expectedContainerHash ?? 'absent'}, got ${observed.containerHash ?? 'absent'}`,
    )
  }
  if (options.expectedUid !== undefined && observed.exists && observed.uid !== options.expectedUid) {
    throw new FilePreconditionError(
      `Managed target owner changed: expected uid ${options.expectedUid}, got ${observed.uid}`,
    )
  }
}

function assertSameObservedFile(before: FileFingerprint, after: FileFingerprint): void {
  if (before.exists !== after.exists) {
    throw new FilePreconditionError(`Managed target existence changed: ${after.canonicalPath}`)
  }
  if (!before.exists) return
  if (
    before.inode !== after.inode
    || before.size !== after.size
    || before.modifiedMs !== after.modifiedMs
    || before.containerHash !== after.containerHash
  ) {
    throw new FilePreconditionError(`Managed target changed during apply: ${after.canonicalPath}`)
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function absentFingerprint(canonicalPath: string): FileFingerprint {
  return {
    exists: false,
    canonicalPath,
    containerHash: null,
    mode: null,
    uid: null,
    gid: null,
    size: null,
    modifiedMs: null,
    inode: null,
  }
}

function assertTargetWithinRoot(targetPath: string, allowedRoot: string): void {
  if (!path.isAbsolute(targetPath) || !path.isAbsolute(allowedRoot)) {
    throw new FilePreconditionError('Managed target and root must be absolute')
  }
  const relative = path.relative(path.resolve(allowedRoot), path.resolve(targetPath))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FilePreconditionError(`Managed target is outside approved root: ${targetPath}`)
  }
}

function assertSafeManagedAncestorChain(targetPath: string, allowedRoot: string): string {
  const rootBoundary = path.dirname(path.resolve(allowedRoot))
  const parent = path.dirname(path.resolve(targetPath))
  let anchor = rootBoundary
  while (!fs.existsSync(anchor)) {
    const next = path.dirname(anchor)
    if (next === anchor) throw new FilePreconditionError(`Managed parent is unresolvable: ${targetPath}`)
    anchor = next
  }
  if (fs.lstatSync(anchor).isSymbolicLink()) {
    throw new FilePreconditionError(`Refused symbolic-link managed parent: ${anchor}`)
  }
  const relative = path.relative(anchor, parent)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FilePreconditionError(`Managed parent is outside approved boundary: ${targetPath}`)
  }
  let cursor = anchor
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new FilePreconditionError(`Refused symbolic-link managed parent: ${cursor}`)
    }
  }
  return path.join(fs.realpathSync(anchor), relative)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
