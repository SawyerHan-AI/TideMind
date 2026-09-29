import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream'
import {
  readStableFileFingerprint,
  readStableFileSnapshot,
  readStablePackageTree,
  verifyStablePackageTree,
  type PassiveVersionFileSystem,
} from './passive-cli-version.js'
import type { NpmComposedComponentSpec, NpmComposedDistributionSpec } from './npm-distribution-topology.js'

/**
 * Static, non-executing npm tarball staging shared by the offline receipt
 * generator (scripts/capture-agent-distribution-receipt.ts) and the Electron
 * main-process official registry verification. It reproduces the observable
 * file layout of `npm install` (pacote + bin-links) for one exact tarball
 * without running any lifecycle script or any downloaded code.
 */

export const MAX_STAGING_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_NPM_MANIFEST_BYTES = 512 * 1024
const MAX_OPENCLAW_INVENTORY_BYTES = 16 * 1024 * 1024
const APPLE_DOUBLE_MAGIC = Buffer.from([0x00, 0x05, 0x16, 0x07])
const MAX_APPLE_DOUBLE_BYTES = 1024 * 1024
const MAX_TAR_META_BYTES = 1024 * 1024
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u

export interface NpmTarballExtractionLimits {
  /** Tar headers of every kind, including directory and metadata headers. */
  maxEntries: number
  /** Sum of regular-file payload bytes written to disk. */
  maxUnpackedBytes: number
  /** One regular-file payload. */
  maxFileBytes: number
  /** Relative path segments below `package/`. */
  maxDepth: number
}

export const DEFAULT_NPM_TARBALL_EXTRACTION_LIMITS: Readonly<NpmTarballExtractionLimits> = Object.freeze({
  maxEntries: 50_000,
  maxUnpackedBytes: 768 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxDepth: 64,
})

/** Stable error prefix for every size/count bound so callers can classify it. */
export const NPM_TARBALL_LIMIT_ERROR_PREFIX = 'npm_tarball_limit_exceeded:'

export interface StableArtifact {
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
}

export async function inspectStableArtifact(
  inputPath: string,
  maxBytes = MAX_STAGING_ARTIFACT_BYTES,
): Promise<StableArtifact> {
  if (!path.isAbsolute(inputPath)) throw new Error('artifact_path_must_be_absolute')
  const requested = path.resolve(inputPath)
  const requestedStat = await fs.lstat(requested)
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) throw new Error('artifact_must_be_regular_file')
  const canonical = path.resolve(await fs.realpath(requested))
  const fingerprint = await readStableFileFingerprint(canonical, maxBytes)
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

/** Streams one descriptor into an SRI sha512 string; rejects concurrent change. */
export async function sha512FileIntegrity(filePath: string, maxBytes = MAX_STAGING_ARTIFACT_BYTES): Promise<string> {
  const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maxBytes)) {
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

export function safeRelativePath(value: string): boolean {
  if (!value || value === '.' || path.posix.isAbsolute(value)) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

export function normalizedNpmBinRelativePath(value: string): string | undefined {
  const normalized = value.startsWith('./') ? value.slice(2) : value
  if (!normalized || normalized.startsWith('./') || normalized.includes('\\')
    || !safeRelativePath(normalized)) return undefined
  return normalized
}

export function isWithinOrEqual(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Strict bin targets as declared by one package manifest, in declaration order. */
export function strictNpmBinTargets(manifest: { name?: unknown; bin?: unknown }): string[] {
  const values: unknown[] = typeof manifest.bin === 'string'
    ? [manifest.bin]
    : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
      ? Object.values(manifest.bin as Record<string, unknown>)
      : []
  const targets: string[] = []
  for (const value of values) {
    const normalized = typeof value === 'string' ? normalizedNpmBinRelativePath(value) : undefined
    if (normalized && !targets.includes(normalized)) targets.push(normalized)
  }
  return targets
}

/** npm-normalize-package-bin: values are rooted, then made relative again. */
function npmNormalizedBinTargets(manifest: { bin?: unknown }): string[] {
  const values: unknown[] = typeof manifest.bin === 'string'
    ? [manifest.bin]
    : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
      ? Object.values(manifest.bin as Record<string, unknown>)
      : []
  const targets: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.includes('\0')) continue
    const normalized = path.posix.join('/', value.replaceAll('\\', '/')).slice(1)
    if (normalized && safeRelativePath(normalized) && !targets.includes(normalized)) targets.push(normalized)
  }
  return targets
}

export interface NpmTarballExtractionResult {
  /** Canonical `<destination>/package` directory. */
  packageRoot: string
  entryCount: number
  fileCount: number
  unpackedBytes: number
}

type TarEntryKind = 'file' | 'directory' | 'meta'

interface TarHeader {
  name: string
  mode: number
  size: number
  typeflag: string
  linkname: string
}

class LimitError extends Error {
  constructor(detail: string) {
    super(`${NPM_TARBALL_LIMIT_ERROR_PREFIX}${detail}`)
  }
}

class ChunkReader {
  private chunks: Buffer[] = []
  private available = 0
  private finished = false

  constructor(private readonly iterator: AsyncIterator<unknown>) {}

  private async fill(): Promise<boolean> {
    if (this.finished) return false
    const next = await this.iterator.next()
    if (next.done) {
      this.finished = true
      return false
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array)
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.available += chunk.length
    }
    return true
  }

  /** Returns null only on a clean EOF at a block boundary. */
  async read(length: number): Promise<Buffer | null> {
    while (this.available < length) {
      if (!await this.fill()) {
        if (this.available === 0) return null
        throw new Error('npm_tarball_truncated')
      }
    }
    const output = Buffer.allocUnsafe(length)
    let written = 0
    while (written < length) {
      const chunk = this.chunks[0]!
      const take = Math.min(chunk.length, length - written)
      chunk.copy(output, written, 0, take)
      written += take
      if (take === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
      this.available -= take
    }
    return output
  }

  async stream(length: number, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = length
    while (remaining > 0) {
      if (this.available === 0 && !await this.fill()) throw new Error('npm_tarball_truncated')
      if (this.available === 0) continue
      const chunk = this.chunks[0]!
      const take = Math.min(chunk.length, remaining)
      const part = chunk.subarray(0, take)
      if (take === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
      this.available -= take
      remaining -= take
      await sink(part)
    }
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}

function tarNumber(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length)
  if (field[0]! & 0x80) {
    // GNU base-256: only small positive values are meaningful for npm packages.
    if (field[0] !== 0x80) throw new Error('npm_tarball_header_number_invalid')
    let value = 0
    for (let index = 1; index < field.length; index += 1) {
      value = value * 256 + field[index]!
      if (!Number.isSafeInteger(value)) throw new Error('npm_tarball_header_number_invalid')
    }
    return value
  }
  const text = field.toString('latin1').replace(/\0.*$/su, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/u.test(text)) throw new Error('npm_tarball_header_number_invalid')
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new Error('npm_tarball_header_number_invalid')
  return value
}

function parseTarHeader(block: Buffer): TarHeader {
  const expected = tarNumber(block, 148, 8)
  let unsigned = 0
  let signed = 0
  for (let index = 0; index < 512; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : block[index]!
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  if (expected !== unsigned && expected !== signed) throw new Error('npm_tarball_header_checksum_invalid')
  const magic = block.subarray(257, 263).toString('latin1')
  const name = tarString(block, 0, 100)
  const prefix = magic === 'ustar\0' ? tarString(block, 345, 155) : ''
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: tarNumber(block, 100, 8),
    size: tarNumber(block, 124, 12),
    typeflag: String.fromCharCode(block[156]!),
    linkname: tarString(block, 157, 100),
  }
}

function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    if (data[offset] === 0) break
    const space = data.indexOf(0x20, offset)
    if (space < 0) throw new Error('npm_tarball_pax_invalid')
    const lengthText = data.subarray(offset, space).toString('latin1')
    if (!/^\d+$/u.test(lengthText)) throw new Error('npm_tarball_pax_invalid')
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.length) {
      throw new Error('npm_tarball_pax_invalid')
    }
    const record = data.subarray(space + 1, offset + length)
    if (record[record.length - 1] !== 0x0a) throw new Error('npm_tarball_pax_invalid')
    const text = record.subarray(0, record.length - 1).toString('utf8')
    const equals = text.indexOf('=')
    if (equals <= 0) throw new Error('npm_tarball_pax_invalid')
    records.set(text.slice(0, equals), text.slice(equals + 1))
    offset += length
  }
  return records
}

function classify(typeflag: string): TarEntryKind | 'forbidden' {
  if (typeflag === '0' || typeflag === '\0' || typeflag === '7') return 'file'
  if (typeflag === '5') return 'directory'
  if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') return 'meta'
  // 1 hard link, 2 symlink, 3/4 devices, 6 FIFO, and every vendor extension.
  return 'forbidden'
}

function collisionKey(relativePath: string): string {
  // APFS/HFS+ are case-insensitive and normalization-insensitive by default.
  return relativePath.normalize('NFC').toLowerCase()
}

async function writeAll(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
    if (bytesWritten <= 0) throw new Error('npm_tarball_write_failed')
    offset += bytesWritten
  }
}

/**
 * Pure-JS gzip+tar extraction with npm install semantics:
 * - only `package/...` regular files are materialized (like pacote, which
 *   strips the first path component and filters every non-File entry);
 * - symlinks, hard links, devices, FIFOs and unknown entry types are rejected;
 * - absolute paths, `.`/`..` segments, backslashes, NUL, duplicate and
 *   case/normalization-colliding paths are rejected;
 * - file mode is `(mode | 0644) & 0755` (pacote with the default 022 umask,
 *   minus set-id bits); `.gitignore` becomes `.npmignore` exactly like pacote;
 * - macOS AppleDouble `._*` metadata members are dropped like bsdtar does;
 * - entry count, per-file, total payload and decompressed stream are bounded.
 * The destination must be an empty private directory owned by the caller.
 */
export async function extractNpmTarballSafely(
  tarballPath: string,
  destination: string,
  limits: Partial<NpmTarballExtractionLimits> = {},
): Promise<NpmTarballExtractionResult> {
  const bounds = { ...DEFAULT_NPM_TARBALL_EXTRACTION_LIMITS, ...limits }
  const requestedRoot = path.resolve(destination)
  const rootStat = await fs.lstat(requestedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('npm_tarball_destination_invalid')
  const root = path.resolve(await fs.realpath(requestedRoot))
  if ((await fs.readdir(root)).length !== 0) throw new Error('npm_tarball_destination_not_empty')
  const packageDirectory = path.join(root, 'package')

  const sourceHandle = await fs.open(tarballPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW)
  const source = sourceHandle.createReadStream({ autoClose: true })
  const gunzip = createGunzip()
  const maxInflatedBytes = bounds.maxUnpackedBytes + Math.min(bounds.maxEntries, 1_000_000) * 1024 + 64 * 1024
  let inflatedBytes = 0
  const counted = (async function* () {
    for await (const chunk of gunzip) {
      inflatedBytes += (chunk as Buffer).length
      if (inflatedBytes > maxInflatedBytes) throw new LimitError('inflated_stream')
      yield chunk as Buffer
    }
  })()
  pipeline(source, gunzip, () => {})
  const reader = new ChunkReader(counted[Symbol.asyncIterator]())

  const createdDirectories = new Set<string>([packageDirectory])
  const pathKinds = new Map<string, 'file' | 'directory'>()
  const seenNpmIgnores = new Set<string>()
  const renamedGitIgnores = new Set<string>()
  let entryCount = 0
  let fileCount = 0
  let unpackedBytes = 0
  let pax = new Map<string, string>()
  let longName: string | null = null
  let packageRootCreated = false

  const ensurePackageRoot = async (): Promise<void> => {
    if (packageRootCreated) return
    await fs.mkdir(packageDirectory, { mode: 0o755 })
    await fs.chmod(packageDirectory, 0o755)
    packageRootCreated = true
  }

  const ensureDirectory = async (segments: readonly string[]): Promise<string> => {
    await ensurePackageRoot()
    let current = packageDirectory
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!)
      if (createdDirectories.has(current)) continue
      const key = collisionKey(segments.slice(0, index + 1).join('/'))
      const existing = pathKinds.get(key)
      if (existing === 'file') throw new Error('npm_tarball_entry_collision')
      if (existing === 'directory') throw new Error('npm_tarball_entry_collision')
      await fs.mkdir(current, { mode: 0o755 })
      await fs.chmod(current, 0o755)
      const created = await fs.lstat(current)
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('npm_tarball_directory_invalid')
      createdDirectories.add(current)
      pathKinds.set(key, 'directory')
    }
    return current
  }

  try {
    for (;;) {
      const block = await reader.read(512)
      if (!block || block.every(byte => byte === 0)) break
      entryCount += 1
      if (entryCount > bounds.maxEntries) throw new LimitError('entries')
      const header = parseTarHeader(block)
      const kind = classify(header.typeflag)
      if (kind === 'forbidden') throw new Error(`npm_tarball_entry_type_forbidden:${JSON.stringify(header.typeflag)}`)
      if (kind === 'meta') {
        if (header.size > MAX_TAR_META_BYTES) throw new LimitError('metadata_header')
        const padded = header.size + ((512 - (header.size % 512)) % 512)
        const data = padded === 0 ? Buffer.alloc(0) : await reader.read(padded)
        if (!data) throw new Error('npm_tarball_truncated')
        const payload = data.subarray(0, header.size)
        if (header.typeflag === 'x') pax = parsePaxRecords(payload)
        else if (header.typeflag === 'g') parsePaxRecords(payload)
        else if (header.typeflag === 'L') longName = payload.toString('utf8').replace(/\0+$/u, '')
        // 'K' (GNU long link name) only matters for link entries, which are rejected.
        continue
      }

      const rawName = pax.get('path') ?? longName ?? header.name
      const paxSize = pax.get('size')
      const size = paxSize === undefined ? header.size : Number(paxSize)
      pax = new Map()
      longName = null
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('npm_tarball_header_number_invalid')
      if (rawName.includes('\0') || rawName.includes('\\') || rawName.startsWith('/')
        || Buffer.byteLength(rawName, 'utf8') > 4_096) {
        throw new Error('npm_tarball_entry_path_invalid')
      }
      const trimmed = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
      if (!safeRelativePath(trimmed)) throw new Error('npm_tarball_entry_path_invalid')
      const segments = trimmed.split('/')
      const padding = (512 - (size % 512)) % 512
      let bufferedPayload: Buffer | null = null
      if (kind === 'file' && segments[segments.length - 1]!.startsWith('._') && size <= MAX_APPLE_DOUBLE_BYTES) {
        // bsdtar-created archives carry xattrs as AppleDouble members; they are
        // metadata for a sibling, never package content.
        const data = size + padding === 0 ? Buffer.alloc(0) : await reader.read(size + padding)
        if (!data) throw new Error('npm_tarball_truncated')
        bufferedPayload = data.subarray(0, size)
        if (bufferedPayload.length >= 4 && bufferedPayload.subarray(0, 4).equals(APPLE_DOUBLE_MAGIC)) continue
      }
      if (segments[0] !== 'package') throw new Error('npm_tarball_entry_outside_package')
      const relativeSegments = segments.slice(1)
      if (relativeSegments.length > bounds.maxDepth) throw new LimitError('depth')

      if (kind === 'directory') {
        // pacote materializes directories only as parents of files.
        if (size !== 0) throw new Error('npm_tarball_directory_payload_invalid')
        continue
      }
      if (relativeSegments.length === 0) throw new Error('npm_tarball_entry_path_invalid')
      if (size > bounds.maxFileBytes) throw new LimitError('file')
      if (unpackedBytes + size > bounds.maxUnpackedBytes) throw new LimitError('unpacked_total')

      if (bufferedPayload) {
        const payload = bufferedPayload
        await writeRegularFile(relativeSegments, header.mode, size,
          async handle => writeAll(handle, payload), async () => {})
        continue
      }
      await writeRegularFile(relativeSegments, header.mode, size,
        async handle => reader.stream(size, chunk => writeAll(handle, chunk)),
        async () => reader.stream(size, async () => {}))
      if (padding > 0) await reader.stream(padding, async () => {})
    }
  } finally {
    await counted.return(undefined).catch(() => undefined)
    source.destroy()
    gunzip.destroy()
  }
  if (!packageRootCreated || fileCount === 0) throw new Error('npm_tarball_package_missing')
  return { packageRoot: packageDirectory, entryCount, fileCount, unpackedBytes }

  async function writeRegularFile(
    relativeSegments: string[],
    headerMode: number,
    size: number,
    writeBody: (handle: fs.FileHandle) => Promise<void>,
    discardBody: () => Promise<void>,
  ): Promise<void> {
    let segments = relativeSegments
    const relative = segments.join('/')
    let overwrite = false
    const baseName = segments[segments.length - 1]!
    if (baseName === '.npmignore') {
      seenNpmIgnores.add(relative)
      if (renamedGitIgnores.has(relative)) overwrite = true
    } else if (baseName === '.gitignore') {
      const npmIgnore = [...segments.slice(0, -1), '.npmignore'].join('/')
      if (seenNpmIgnores.has(npmIgnore)) {
        await discardBody()
        return
      }
      segments = [...segments.slice(0, -1), '.npmignore']
      renamedGitIgnores.add(npmIgnore)
    }
    const finalRelative = segments.join('/')
    const key = collisionKey(finalRelative)
    if (pathKinds.has(key) && !(overwrite && pathKinds.get(key) === 'file')) {
      throw new Error('npm_tarball_entry_collision')
    }
    const parent = await ensureDirectory(segments.slice(0, -1))
    const target = path.join(parent, segments[segments.length - 1]!)
    if (!isWithinOrEqual(packageDirectory, target) || target === packageDirectory) {
      throw new Error('npm_tarball_entry_path_invalid')
    }
    if (overwrite) {
      unpackedBytes -= (await fs.lstat(target)).size
      fileCount -= 1
      await fs.unlink(target)
    }
    const mode = ((headerMode & 0o7777) | 0o644) & 0o755
    const handle = await fs.open(
      target,
      fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await writeBody(handle)
      await handle.chmod(mode)
      const written = await handle.stat()
      if (!written.isFile() || written.size !== size) throw new Error('npm_tarball_write_failed')
    } finally {
      await handle.close()
    }
    pathKinds.set(key, 'file')
    fileCount += 1
    unpackedBytes += size
  }
}

/**
 * bin-links semantics after extraction: every declared bin target that is a
 * regular in-package file is chmod 0755, and a Windows `#!...\r\n` shebang
 * line is rewritten to `\n` through the same UTF-8 round-trip bin-links uses.
 */
async function applyNpmBinLinkSemantics(packageRoot: string): Promise<void> {
  const manifestSnapshot = await readStableFileSnapshot(path.join(packageRoot, 'package.json'), MAX_NPM_MANIFEST_BYTES)
  let manifest: { bin?: unknown }
  try {
    manifest = JSON.parse(Buffer.from(manifestSnapshot.content).toString('utf8')) as { bin?: unknown }
  } catch {
    throw new Error('npm_package_manifest_invalid')
  }
  for (const relative of npmNormalizedBinTargets(manifest)) {
    const target = path.join(packageRoot, ...relative.split('/'))
    if (!isWithinOrEqual(packageRoot, target)) continue
    const node = await fs.lstat(target).catch(() => null)
    if (!node?.isFile() || node.isSymbolicLink()) continue
    if (path.resolve(await fs.realpath(target)) !== target) continue
    await fs.chmod(target, 0o755)
    const handle = await fs.open(target, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW)
    let head: Buffer
    try {
      head = Buffer.alloc(2048)
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      head = head.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    if (head[0] === 0x23 && head[1] === 0x21 && /^#![^\n]+\r\n/u.test(head.toString())) {
      const snapshot = await readStableFileSnapshot(target, MAX_STAGING_ARTIFACT_BYTES)
      const rewritten = Buffer.from(
        Buffer.from(snapshot.content).toString('utf8').replace(/^(#![^\n]+)\r\n/u, '$1\n'),
        'utf8',
      )
      const temporary = `${target}.tidemind-bin-${process.pid}`
      await fs.writeFile(temporary, rewritten, { mode: 0o755, flag: 'wx' })
      await fs.chmod(temporary, 0o755)
      await fs.rename(temporary, target)
    }
  }
}

export interface StagedNpmPackage {
  packageRoot: string
  executableForBin(name: string): string
  binTargets(): string[]
}

/**
 * Stages one integrity-bound npm tarball as `<tempRoot>/node_modules/<installName>`
 * and records it in the hidden npm v7+ lockfile with the registry integrity.
 */
export async function stageNpmTarball(
  tarball: string,
  tempRoot: string,
  packageName: string,
  integrity: string,
  installName = packageName,
  limits: Partial<NpmTarballExtractionLimits> = {},
): Promise<StagedNpmPackage> {
  const artifact = await inspectStableArtifact(tarball)
  if (!INTEGRITY.test(integrity) || await sha512FileIntegrity(artifact.path) !== integrity) {
    throw new Error('npm_tarball_integrity_mismatch')
  }
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const extractRoot = await fs.mkdtemp(path.join(tempRoot, '.npm-extract-'))
  await fs.chmod(extractRoot, 0o700)
  const nodeModulesRoot = path.join(tempRoot, 'node_modules')
  const packageRoot = path.join(nodeModulesRoot, ...installName.split('/'))
  try {
    const extracted = await extractNpmTarballSafely(artifact.path, extractRoot, limits)
    await applyNpmBinLinkSemantics(extracted.packageRoot)
    await fs.mkdir(path.dirname(packageRoot), { recursive: true, mode: 0o755 })
    for (const directory of [nodeModulesRoot, path.dirname(packageRoot)]) {
      if ((((await fs.lstat(directory)).mode) & 0o022) !== 0) await fs.chmod(directory, 0o755)
    }
    await fs.rename(extracted.packageRoot, packageRoot)
  } finally {
    await fs.rm(extractRoot, { recursive: true, force: true })
  }
  const lockPath = path.join(nodeModulesRoot, '.package-lock.json')
  const existingLock = await fs.readFile(lockPath, 'utf8')
    .then(value => JSON.parse(value) as { lockfileVersion: number; packages: Record<string, unknown> })
    .catch(() => ({ lockfileVersion: 3, packages: {} as Record<string, unknown> }))
  existingLock.packages[`node_modules/${installName}`] = {
    version: JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version,
    integrity,
  }
  await fs.writeFile(lockPath, JSON.stringify(existingLock), { mode: 0o600 })
  await readStablePackageTree(packageRoot)
  const after = await inspectStableArtifact(artifact.path)
  if (after.physicalFingerprint !== artifact.physicalFingerprint) throw new Error('npm_tarball_changed_during_extract')
  const readManifest = (): { name?: unknown; bin?: unknown } => (
    JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; bin?: unknown }
  )
  return {
    packageRoot,
    executableForBin(name: string): string {
      const manifest = readManifest()
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
    binTargets(): string[] {
      const manifest = readManifest()
      if (manifest.name !== packageName) throw new Error('npm_package_name_mismatch')
      return strictNpmBinTargets(manifest)
    },
  }
}

/**
 * Turns a stage produced by stageNpmTarball into the lockless layout that
 * `npm install -g` leaves behind: the same package trees without the hidden
 * `node_modules/.package-lock.json` (and therefore without registry integrity).
 * Only a regular, non-symlink lockfile directly under the stage is removed.
 */
export async function removeStagedNpmHiddenLockfile(tempRoot: string): Promise<void> {
  const lockPath = path.join(path.resolve(tempRoot), 'node_modules', '.package-lock.json')
  const node = await fs.lstat(lockPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (node === null) return
  if (!node.isFile() || node.isSymbolicLink()) throw new Error('npm_stage_hidden_lockfile_invalid')
  await fs.unlink(lockPath)
  if (await fs.lstat(lockPath).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })) throw new Error('npm_stage_hidden_lockfile_removal_failed')
}

/**
 * Reproduces the one install-time mutation of the copy-platform-binary
 * topology (e.g. Claude Code / OpenCode postinstall): the exact platform leaf
 * executable is copied over the root placeholder. Nothing is executed.
 */
export async function materializeCopiedPlatformBinary(
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
  const nativeRelative = leaf.spec.nativeExecutableRelativePath
  if (!nativeRelative) throw new Error('npm_copy_platform_binary_topology_invalid')
  const sourcePath = path.join(leaf.packageRoot, ...nativeRelative.split('/'))
  const sourceBefore = await readStableFileFingerprint(sourcePath, MAX_STAGING_ARTIFACT_BYTES)
  if (!sourceBefore.executable) throw new Error('npm_copy_platform_binary_source_not_executable')
  await fs.copyFile(sourcePath, executablePath)
  await fs.chmod(executablePath, sourceBefore.mode & 0o777)
  const sourceAfter = await readStableFileFingerprint(sourcePath, MAX_STAGING_ARTIFACT_BYTES)
  const destinationAfter = await readStableFileFingerprint(executablePath, MAX_STAGING_ARTIFACT_BYTES)
  if (sourceAfter.fingerprint !== sourceBefore.fingerprint
    || destinationAfter.sha256 !== sourceBefore.sha256
    || destinationAfter.size !== sourceBefore.size
    || destinationAfter.mode !== (sourceBefore.mode & 0o777)
    || !destinationAfter.executable
    || path.resolve(await fs.realpath(executablePath)) !== executablePath) {
    throw new Error('npm_copy_platform_binary_readback_mismatch')
  }
}

/** The same passive filesystem surface production discovery hands to inspectPassiveCliVersion. */
export function createPassiveVersionFileSystem(): Required<PassiveVersionFileSystem> {
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

export interface OpenClawLifecyclePins {
  expectedVersion: string
  /** Release-frozen source hashes; omitted by runtime verification of other versions. */
  lifecycleMarkerSha256?: string
  lifecycleContractSha256?: string
  postinstallScriptSha256?: string
  postinstallInventorySha256?: string
}

export interface OpenClawLifecycleEvidence {
  schema: 'openclaw-static-postinstall-v1'
  markerRemoved: '.openclaw-lifecycle-pending'
  inventoryEntryCount: number
  rawOwnedPackageSha256: string
  postinstallOwnedPackageSha256: string
  postinstallOwnedEntryCount: number
  postinstallOwnedTotalBytes: number
}

export const OPENCLAW_LIFECYCLE_MARKER = '.openclaw-lifecycle-pending'

/**
 * OpenClaw's official postinstall, for a package whose shipped dist inventory
 * already matches `dist/`, only deletes the lifecycle marker. Reproduce that
 * statically after proving the package makes no other install-time mutation.
 */
export async function staticallyCompleteOpenClawPackageLifecycle(
  packageRoot: string,
  pins: OpenClawLifecyclePins,
): Promise<OpenClawLifecycleEvidence> {
  const manifestPath = path.join(packageRoot, 'package.json')
  const markerPath = path.join(packageRoot, OPENCLAW_LIFECYCLE_MARKER)
  const contractPath = path.join(packageRoot, 'scripts', 'lib', 'package-lifecycle-marker.mjs')
  const postinstallPath = path.join(packageRoot, 'scripts', 'postinstall-bundled-plugins.mjs')
  const inventoryPath = path.join(packageRoot, 'dist', 'postinstall-inventory.json')
  const [manifest, marker, contract, postinstall, inventory] = await Promise.all([
    readStableFileSnapshot(manifestPath, 512 * 1024),
    readStableFileSnapshot(markerPath, 64),
    readStableFileSnapshot(contractPath, 64 * 1024),
    readStableFileSnapshot(postinstallPath, 512 * 1024),
    readStableFileSnapshot(inventoryPath, MAX_OPENCLAW_INVENTORY_BYTES),
  ])
  const parsedManifest = JSON.parse(Buffer.from(manifest.content).toString('utf8')) as {
    name?: unknown
    version?: unknown
    scripts?: { preinstall?: unknown; postinstall?: unknown }
  }
  const pinned = (expected: string | undefined, actual: string) => expected === undefined || expected === actual
  if (parsedManifest.name !== 'openclaw' || parsedManifest.version !== pins.expectedVersion
    || parsedManifest.scripts?.preinstall !== 'node scripts/preinstall-package-manager-warning.mjs'
    || parsedManifest.scripts.postinstall !== 'node scripts/postinstall-bundled-plugins.mjs'
    || !pinned(pins.lifecycleMarkerSha256, marker.sha256)
    || !pinned(pins.lifecycleContractSha256, contract.sha256)
    || !pinned(pins.postinstallScriptSha256, postinstall.sha256)
    || !pinned(pins.postinstallInventorySha256, inventory.sha256)) {
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
  const expectedSorted = [...(expectedDistFiles as string[])].sort((left, right) => left.localeCompare(right))
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
    markerRemoved: OPENCLAW_LIFECYCLE_MARKER,
    inventoryEntryCount: expectedSorted.length,
    rawOwnedPackageSha256: rawTree.packageTreeSha256,
    postinstallOwnedPackageSha256: postinstallTree.packageTreeSha256,
    postinstallOwnedEntryCount: postinstallTree.ownedEntryCount,
    postinstallOwnedTotalBytes: postinstallTree.ownedTotalBytes,
  }
}
