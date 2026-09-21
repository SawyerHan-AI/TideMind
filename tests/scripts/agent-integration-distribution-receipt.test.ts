import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { deflateRawSync } from 'node:zlib'
import {
  generateAgentDistributionReceipt,
  assertReceiptArtifactUnchanged,
  assertMachOArchitecture,
  copyDmgToPrivateMountInput,
  copyStableInputFile,
  createIsolatedGpgHome,
  extractZipArchive,
  inspectArtifact,
  readExactArchiveBytes,
  validateArchiveEntryNames,
  verifyAnthropicManifestSignature,
  type GeneratorDependencies,
} from '../../scripts/capture-agent-distribution-receipt'
import { portableArtifactFingerprint } from '../../scripts/agent-integration-release-contract.mjs'
import { readStableDistributionTree } from '../../client/electron/agent-integration/distribution-artifact'
import { normalizedQwenLauncherBytes } from '../../client/electron/agent-integration/passive-cli-version'
import { readAgentHostPhysicalDistribution } from '../../client/electron/agent-integration/host-target-metadata-export'
import { createProductionAgentHostMetadataEvidenceRuntime } from '../../client/electron/agent-integration/production-service'
import type { DiscoveredInstallation } from '../../client/electron/agent-integration/discovery'
import {
  AGENT_INTEGRATION_RELEASE_ENTRIES,
  validArtifactReceipt,
  type AgentReleaseDistributionArtifactReceipt,
} from '../../client/electron/agent-integration/release-manifest'
import { npmComposedDistributionSpec } from '../../client/electron/agent-integration/npm-distribution-topology'

const roots: string[] = []
const architecture = (process.arch === 'x64' ? 'x64' : 'arm64') as 'arm64' | 'x64'
const releaseManifestPath = path.resolve('client/electron/agent-integration/release-manifest.ts')

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const fakeSignedDependencies: GeneratorDependencies = {
  async inspectSignature(codeObjectPath) {
    const name = path.basename(codeObjectPath)
    const identifier = name === 'ZCode.app' ? 'dev.zcode.app'
      : name === 'kimi' ? 'kimi' : 'com.anthropic.claude-code'
    const teamIdentifier = identifier === 'dev.zcode.app' ? '8A5X4JJ39T'
      : identifier === 'kimi' ? '2J9472RW75' : 'Q6L2SF6YDW'
    return {
      valid: true,
      identifier,
      teamIdentifier,
      cdHash: '28d49821f609d871c2282bdec52116bd91ea5806',
      designatedRequirement: `identifier "${identifier}" and anchor apple generic`,
      verificationBoundary: 'strict_final',
    }
  },
  assertArchitecture() {},
  async verifyClaudeManifestSignature() {
    return '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE'
  },
  kimiReleaseAuthority() {
    return null
  },
  openclawReleaseAuthority() {
    return null
  },
}

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-receipt-test-')))
  roots.push(root)
  return root
}

function writeExecutable(target: string, content = '#!/bin/sh\nexit 0\n'): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, { mode: 0o755 })
}

function archiveDirectory(parent: string, member: string, output: string): void {
  const result = spawnSync('/usr/bin/tar', ['-czf', output, '-C', parent, member], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function archiveZipFile(parent: string, member: string, output: string, deflate = false): void {
  const name = Buffer.from(member, 'utf8')
  const body = fs.readFileSync(path.join(parent, member))
  const compressed = deflate ? deflateRawSync(body) : body
  const checksum = crc32(body)
  const mode = fs.statSync(path.join(parent, member)).mode & 0xffff
  const flags = 0x0800 | (deflate ? 0x0008 : 0)

  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(deflate ? 8 : 0, 8)
  local.writeUInt32LE(deflate ? 0 : checksum, 14)
  local.writeUInt32LE(deflate ? 0 : compressed.length, 18)
  local.writeUInt32LE(deflate ? 0 : body.length, 22)
  local.writeUInt16LE(name.length, 26)
  name.copy(local, 30)

  const descriptor = deflate ? Buffer.alloc(16) : Buffer.alloc(0)
  if (deflate) {
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(checksum, 4)
    descriptor.writeUInt32LE(compressed.length, 8)
    descriptor.writeUInt32LE(body.length, 12)
  }

  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE((3 << 8) | 20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(flags, 8)
  central.writeUInt16LE(deflate ? 8 : 0, 10)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(body.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((mode * 0x10000) >>> 0, 38)
  name.copy(central, 46)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length + compressed.length + descriptor.length, 16)
  fs.writeFileSync(output, Buffer.concat([local, compressed, descriptor, central, end]))
}

function archiveZipEntries(root: string, entries: Array<{ name: string; body: string; symlink?: boolean; executable?: boolean }>): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [index, entry] of entries.entries()) {
    const source = path.join(root, `zip-source-${index}`)
    fs.mkdirSync(path.dirname(path.join(source, entry.name)), { recursive: true })
    fs.writeFileSync(path.join(source, entry.name), entry.body, { mode: entry.executable ? 0o755 : 0o644 })
    const single = path.join(root, `zip-entry-${index}.zip`)
    archiveZipFile(source, entry.name, single, true)
    const bytes = fs.readFileSync(single)
    const centralOffset = bytes.readUInt32LE(bytes.length - 6)
    const local = bytes.subarray(0, centralOffset)
    const central = Buffer.from(bytes.subarray(centralOffset, bytes.length - 22))
    central.writeUInt32LE(offset, 42)
    if (entry.symlink) central.writeUInt32LE((0o120777 * 0x10000) >>> 0, 38)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  const output = path.join(root, 'links.zip')
  fs.writeFileSync(output, Buffer.concat([...locals, central, end]))
  return output
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function sha512Integrity(target: string): string {
  return `sha512-${createHash('sha512').update(fs.readFileSync(target)).digest('base64')}`
}

function writePackument(target: string, packageName: string, version: string, integrity: string, tarballUrl: string): void {
  fs.writeFileSync(target, JSON.stringify({
    name: packageName,
    versions: { [version]: { name: packageName, version, dist: { integrity, tarball: tarballUrl } } },
  }))
}

function baseOptions(root: string) {
  return {
    architecture,
    releaseManifestPath,
    outputPath: path.join(root, 'receipt.json'),
  }
}

function kimiNpmReceiptFixture(integrity = 'valid', binTarget = 'bin/kimi.js') {
  const root = tempRoot()
  const source = path.join(root, 'source')
  const packageRoot = path.join(source, 'package')
  writeExecutable(path.join(packageRoot, 'bin', 'kimi.js'))
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@moonshot-ai/kimi-code', version: '0.41.0', bin: { kimi: binTarget },
  }))
  const tarball = path.join(root, 'kimi.tgz')
  archiveDirectory(source, 'package', tarball)
  const url = 'https://registry.npmjs.org/@moonshot-ai/kimi-code/-/kimi-code-0.41.0.tgz'
  const metadata = path.join(root, 'packument.json')
  writePackument(
    metadata,
    '@moonshot-ai/kimi-code',
    '0.41.0',
    integrity === 'valid' ? sha512Integrity(tarball) : 'sha512-YmFk',
    url,
  )
  return {
    root,
    options: {
      kind: 'npm-tarball' as const,
      catalogId: 'kimi-code-cli',
      distributionId: 'cli:kimi-code-cli',
      version: '0.41.0',
      artifactPath: tarball,
      sourceUrl: url,
      registryMetadataPath: metadata,
      binName: 'kimi',
      ...baseOptions(root),
    },
  }
}

describe('official Agent distribution receipt capture', () => {
  it('extracts stored and deflated ZIPs without external tools and rejects unsafe ZIP metadata', async () => {
    const root = tempRoot()
    const source = path.join(root, 'kimi')
    writeExecutable(source, '#!/bin/sh\necho safe\n')

    for (const [index, deflate] of [false, true].entries()) {
      const archive = path.join(root, `valid-${index}.zip`)
      archiveZipFile(root, 'kimi', archive, deflate)
      const destination = path.join(root, `valid-${index}`)
      fs.mkdirSync(destination, { mode: 0o700 })
      await extractZipArchive(archive, destination)
      expect(fs.readFileSync(path.join(destination, 'kimi'))).toEqual(fs.readFileSync(source))
      expect(fs.statSync(path.join(destination, 'kimi')).mode & 0o111).not.toBe(0)
    }

    const canonicalPath = path.join(root, 'canonical.zip')
    archiveZipFile(root, 'kimi', canonicalPath, true)
    const canonical = fs.readFileSync(canonicalPath)
    const eocd = canonical.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const central = canonical.readUInt32LE(eocd + 16)
    const dataOffset = 30 + canonical.readUInt16LE(26) + canonical.readUInt16LE(28)
    const reject = async (label: string, candidate: Buffer, expected: string | RegExp) => {
      const archive = path.join(root, `${label}.zip`)
      const destination = path.join(root, label)
      fs.writeFileSync(archive, candidate)
      fs.mkdirSync(destination, { mode: 0o700 })
      await expect(extractZipArchive(archive, destination)).rejects.toThrow(expected)
    }

    const traversal = Buffer.from(canonical)
    Buffer.from('../x').copy(traversal, 30)
    Buffer.from('../x').copy(traversal, central + 46)
    await reject('traversal', traversal, 'archive_entry_path_invalid')

    const encrypted = Buffer.from(canonical)
    encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 0x0001, 6)
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 0x0001, central + 8)
    await reject('encrypted', encrypted, 'zip_entry_features_unsupported')

    const descriptor = Buffer.from(canonical)
    descriptor.writeUInt32LE((descriptor.readUInt32LE(central - 12) ^ 1) >>> 0, central - 12)
    await reject('descriptor', descriptor, 'zip_data_descriptor_mismatch')

    const symlink = Buffer.from(canonical)
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38)
    await reject('symlink', symlink, 'zip_symlink_or_special_node_forbidden')

    const bomb = Buffer.from(canonical)
    const compressedSize = bomb.readUInt32LE(central + 20)
    const expandedSize = compressedSize * 201
    bomb.writeUInt32LE(expandedSize, 22)
    bomb.writeUInt32LE(expandedSize, central + 24)
    await reject('bomb', bomb, 'zip_entry_expansion_limit_exceeded')
    const appBombDestination = path.join(root, 'app-bomb')
    fs.mkdirSync(appBombDestination)
    await expect(extractZipArchive(path.join(root, 'bomb.zip'), appBombDestination, { signedApp: true }))
      .rejects.toThrow('zip_entry_expansion_limit_exceeded')

    const corrupt = Buffer.from(canonical)
    corrupt[dataOffset] ^= 0x01
    await reject('crc', corrupt, /zip_entry_decompression_or_write_failed|zip_entry_size_or_crc_mismatch/u)

    const centralEntry = canonical.subarray(central, eocd)
    const duplicatedEnd = Buffer.from(canonical.subarray(eocd))
    duplicatedEnd.writeUInt16LE(2, 8)
    duplicatedEnd.writeUInt16LE(2, 10)
    duplicatedEnd.writeUInt32LE(centralEntry.length * 2, 12)
    const duplicated = Buffer.concat([
      canonical.subarray(0, central), centralEntry, centralEntry, duplicatedEnd,
    ])
    await reject('duplicate', duplicated, 'zip_portable_path_collision')

    const outOfBounds = Buffer.from(canonical)
    outOfBounds.writeUInt32LE(central, central + 42)
    await reject('bounds', outOfBounds, 'zip_local_header_invalid')

    const prefixed = Buffer.concat([Buffer.from([0]), canonical])
    const prefixedEocd = eocd + 1
    const prefixedCentral = central + 1
    prefixed.writeUInt32LE(prefixedCentral, prefixedEocd + 16)
    prefixed.writeUInt32LE(1, prefixedCentral + 42)
    await reject('prefix', prefixed, 'zip_local_entry_prefix_forbidden')

    const centralGap = Buffer.concat([
      canonical.subarray(0, central), Buffer.from([0]), canonical.subarray(central),
    ])
    centralGap.writeUInt32LE(central + 1, eocd + 1 + 16)
    await reject('central-gap', centralGap, 'zip_central_prefix_gap_forbidden')

    const secondSource = path.join(root, 'tool')
    writeExecutable(secondSource, '#!/bin/sh\necho second\n')
    const secondPath = path.join(root, 'second.zip')
    archiveZipFile(root, 'tool', secondPath, true)
    const second = fs.readFileSync(secondPath)
    const secondEocd = second.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const secondCentral = second.readUInt32LE(secondEocd + 16)
    const firstLocal = canonical.subarray(0, central)
    const secondLocal = second.subarray(0, secondCentral)
    const firstCentralEntry = canonical.subarray(central, eocd)
    const secondCentralEntry = Buffer.from(second.subarray(secondCentral, secondEocd))
    secondCentralEntry.writeUInt32LE(firstLocal.length + 1, 42)
    const combinedCentralOffset = firstLocal.length + 1 + secondLocal.length
    const combinedEnd = Buffer.alloc(22)
    combinedEnd.writeUInt32LE(0x06054b50, 0)
    combinedEnd.writeUInt16LE(2, 8)
    combinedEnd.writeUInt16LE(2, 10)
    combinedEnd.writeUInt32LE(firstCentralEntry.length + secondCentralEntry.length, 12)
    combinedEnd.writeUInt32LE(combinedCentralOffset, 16)
    const entryGap = Buffer.concat([
      firstLocal, Buffer.from([0]), secondLocal,
      firstCentralEntry, secondCentralEntry, combinedEnd,
    ])
    await reject('entry-gap', entryGap, 'zip_local_entry_gap_forbidden')
  })

  it.each([
    { label: 'CLI single boundary', signedApp: false, sizes: [1024 ** 3], expected: 'zip_local_and_central_metadata_mismatch' },
    { label: 'CLI single overflow', signedApp: false, sizes: [1024 ** 3 + 1], expected: 'zip_entry_expansion_limit_exceeded' },
    { label: 'app single boundary', signedApp: true, sizes: [2 * 1024 ** 3], expected: 'zip_local_and_central_metadata_mismatch' },
    { label: 'app single overflow', signedApp: true, sizes: [2 * 1024 ** 3 + 1], expected: 'zip_entry_expansion_limit_exceeded' },
    { label: 'CLI total boundary', signedApp: false, sizes: [512 * 1024 ** 2, 512 * 1024 ** 2], expected: 'zip_local_and_central_metadata_mismatch' },
    { label: 'CLI total overflow', signedApp: false, sizes: [512 * 1024 ** 2, 512 * 1024 ** 2 + 1], expected: 'zip_total_expansion_limit_exceeded' },
    { label: 'app total boundary', signedApp: true, sizes: [1024 ** 3, 1024 ** 3], expected: 'zip_local_and_central_metadata_mismatch' },
    { label: 'app total overflow', signedApp: true, sizes: [1024 ** 3, 1024 ** 3 + 1], expected: 'zip_total_expansion_limit_exceeded' },
  ])('bounds ZIP declarations at the $label without allocating large payloads', async ({ signedApp, sizes, expected }) => {
    const root = tempRoot()
    const archive = archiveZipEntries(root, sizes.map((_size, index) => ({ name: `file-${index}`, body: 'small' })))
    const bytes = fs.readFileSync(archive)
    let central = bytes.readUInt32LE(bytes.length - 6)
    for (const size of sizes) {
      const local = bytes.readUInt32LE(central + 42)
      // Deliberately inconsistent local data: accepted budget declarations
      // must still fail the next validation stage, never read/allocate GiBs.
      bytes.writeUInt16LE(0x0800, central + 8)
      bytes.writeUInt16LE(0x0800, local + 6)
      bytes.writeUInt32LE(Math.ceil(size / 200), central + 20)
      bytes.writeUInt32LE(size, central + 24)
      central += 46 + bytes.readUInt16LE(central + 28) + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32)
    }
    fs.writeFileSync(archive, bytes)
    const destination = path.join(root, 'out')
    fs.mkdirSync(destination)
    await expect(extractZipArchive(archive, destination, { signedApp })).rejects.toThrow(expected)
    expect(fs.readdirSync(destination)).toEqual([])
  })

  it('allows signed-app framework and CodeResources links only after extracting ordinary files', async () => {
    const root = tempRoot()
    const archive = archiveZipEntries(root, [
      { name: 'App.app/Contents/Frameworks/Test.framework/Versions/Current', body: 'A', symlink: true },
      { name: 'App.app/Contents/Frameworks/Test.framework/Test', body: 'Versions/Current/Test', symlink: true },
      { name: 'App.app/Contents/CodeResources', body: '_CodeSignature/CodeResources', symlink: true },
      { name: 'App.app/Contents/Frameworks/Test.framework/Versions/A/Test', body: 'framework binary' },
      { name: 'App.app/Contents/_CodeSignature/CodeResources', body: 'signature resource' },
    ])
    const destination = path.join(root, 'app')
    fs.mkdirSync(destination)
    await extractZipArchive(archive, destination, { signedApp: true })
    expect(fs.readFileSync(path.join(destination, 'App.app/Contents/Frameworks/Test.framework/Test'), 'utf8'))
      .toBe('framework binary')
    expect(fs.readlinkSync(path.join(destination, 'App.app/Contents/CodeResources'))).toBe('_CodeSignature/CodeResources')
    await expect(readStableDistributionTree(destination)).resolves.toBeDefined()
    const cliDestination = path.join(root, 'cli')
    fs.mkdirSync(cliDestination)
    await expect(extractZipArchive(archive, cliDestination)).rejects.toThrow('zip_symlink_or_special_node_forbidden')
  })

  it('opts into internal symlinks through the signed-app receipt path', async () => {
    const root = tempRoot()
    const archive = archiveZipEntries(root, [
      { name: 'ZCode.app/Contents/MacOS/ZCode', body: '#!/bin/sh\nexit 0\n', executable: true },
      { name: 'ZCode.app/Contents/Info.plist', body: `<?xml version="1.0"?><plist><dict>
        <key>CFBundleIdentifier</key><string>dev.zcode.app</string>
        <key>CFBundleShortVersionString</key><string>3.11.2</string>
        <key>CFBundleExecutable</key><string>ZCode</string>
      </dict></plist>` },
      { name: 'ZCode.app/Contents/CodeResources', body: '_CodeSignature/CodeResources', symlink: true },
      { name: 'ZCode.app/Contents/_CodeSignature/CodeResources', body: 'signature' },
    ])
    const envelope = await generateAgentDistributionReceipt({
      kind: 'signed-app', catalogId: 'zcode-desktop', distributionId: 'dev.zcode.app',
      version: '3.11.2', artifactPath: archive, sourceUrl: 'https://download.zcode.example/ZCode.zip',
      memberPath: 'ZCode.app', archiveFormat: 'zip', ...baseOptions(root),
    }, fakeSignedDependencies)
    const receipt = envelope.receipt as AgentReleaseDistributionArtifactReceipt
    expect(receipt.signedCode).toMatchObject({ identifier: 'dev.zcode.app' })
    expect(receipt.artifactSha256).toBe(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'))
  })

  it.each([
    { label: 'absolute', links: [{ name: 'App.app/link', body: '/tmp/outside', symlink: true }], error: 'zip_symlink_target_forbidden' },
    { label: 'escape', links: [{ name: 'App.app/link', body: '../../outside', symlink: true }], error: 'zip_symlink_target_forbidden' },
    { label: 'windows', links: [{ name: 'App.app/link', body: 'C:\\outside', symlink: true }], error: 'zip_symlink_target_forbidden' },
    { label: 'parent pivot', links: [{ name: 'App.app/link', body: 'real', symlink: true }, { name: 'App.app/link/payload', body: 'never written' }], error: 'zip_symlink_parent_forbidden' },
    { label: 'reversed pivot', links: [{ name: 'App.app/link/payload', body: 'never written' }, { name: 'App.app/link', body: 'real', symlink: true }], error: 'zip_symlink_parent_forbidden' },
    { label: 'case-fold pivot', links: [{ name: 'App.app/LINK', body: 'real', symlink: true }, { name: 'App.app/link/payload', body: 'never written' }], error: 'zip_symlink_parent_forbidden' },
    { label: 'cycle', links: [{ name: 'App.app/a', body: 'b', symlink: true }, { name: 'App.app/b', body: 'a', symlink: true }], error: 'zip_symlink_unresolvable' },
    { label: 'dangling', links: [{ name: 'App.app/link', body: 'missing', symlink: true }], error: 'zip_symlink_unresolvable' },
  ])('rejects signed-app ZIP $label links', async ({ links, error }) => {
    const root = tempRoot()
    const destination = path.join(root, 'out')
    fs.mkdirSync(destination)
    const archive = archiveZipEntries(root, links)
    await expect(extractZipArchive(archive, destination, { signedApp: true })).rejects.toThrow(error)
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false)
  })

  it('refuses a non-empty ZIP destination with a symlink parent and never writes outside it', async () => {
    const root = tempRoot()
    const sourceRoot = path.join(root, 'source')
    fs.mkdirSync(path.join(sourceRoot, 'link'), { recursive: true })
    writeExecutable(path.join(sourceRoot, 'link', 'pwn'), 'must stay inside\n')
    const archive = path.join(root, 'escape.zip')
    archiveZipFile(sourceRoot, 'link/pwn', archive)
    const destination = path.join(root, 'destination')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(destination)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(destination, 'link'))

    await expect(extractZipArchive(archive, destination))
      .rejects.toThrow('zip_destination_must_be_new_and_empty')
    expect(fs.existsSync(path.join(outside, 'pwn'))).toBe(false)
  })

  it('fills bounded positional reads across short reads and fails only on actual EOF', async () => {
    const source = Buffer.from('short-read-proof')
    const positions: number[] = []
    const reader = {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        positions.push(position)
        const bytesRead = Math.min(2, length, Math.max(0, source.length - position))
        if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead)
        return { bytesRead, buffer }
      },
    }
    await expect(readExactArchiveBytes(reader, 0, source.length, 'short_read_failed'))
      .resolves.toEqual(source)
    expect(positions).toEqual([0, 2, 4, 6, 8, 10, 12, 14])
    await expect(readExactArchiveBytes(reader, 0, source.length + 1, 'short_read_failed'))
      .rejects.toThrow('short_read_failed')
  })

  it('mounts a private DMG copy while retaining strict ctime CAS on the original input', async () => {
    const root = tempRoot()
    const artifactPath = path.join(root, 'fixture.dmg')
    fs.writeFileSync(artifactPath, 'immutable-dmg-bytes')
    const before = await inspectArtifact(artifactPath)
    const privateDmg = await copyDmgToPrivateMountInput(before, root)
    expect(privateDmg).not.toBe(before.path)
    expect(fs.statSync(path.dirname(privateDmg)).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(privateDmg)).toEqual(fs.readFileSync(artifactPath))

    // Simulate hdiutil adding metadata/xattrs to the private copy. The original
    // remains the receipt/CAS input, so copy ctime changes are irrelevant.
    fs.chmodSync(privateDmg, 0o400)
    fs.chmodSync(privateDmg, 0o600)
    const afterPrivateMount = await inspectArtifact(artifactPath)
    expect(() => assertReceiptArtifactUnchanged(before, afterPrivateMount)).not.toThrow()

    const ctimeOnly = {
      ...before,
      ctimeNs: `${BigInt(before.ctimeNs) + 1n}`,
      physicalFingerprint: 'f'.repeat(64),
    }
    expect(() => assertReceiptArtifactUnchanged(before, ctimeOnly))
      .toThrow('artifact_changed_during_receipt_generation')

    for (const changed of [
      { ...ctimeOnly, sha256: '0'.repeat(64) },
      { ...ctimeOnly, sizeBytes: before.sizeBytes + 1 },
      { ...ctimeOnly, path: path.join(root, 'replacement.dmg') },
      { ...ctimeOnly, inode: `${BigInt(before.inode) + 1n}` },
      { ...ctimeOnly, device: `${BigInt(before.device) + 1n}` },
      { ...ctimeOnly, mode: before.mode ^ 0o100 },
      { ...ctimeOnly, linkCount: `${BigInt(before.linkCount) + 1n}` },
      { ...ctimeOnly, mtimeNs: `${BigInt(before.mtimeNs) + 1n}` },
      { ...ctimeOnly, ownerUid: `${BigInt(before.ownerUid!) + 1n}` },
      { ...ctimeOnly, groupGid: `${BigInt(before.groupGid!) + 1n}` },
    ]) {
      expect(() => assertReceiptArtifactUnchanged(before, changed))
        .toThrow('artifact_changed_during_receipt_generation')
    }

    const bytes = fs.readFileSync(artifactPath)
    const tamperedBytes = Buffer.from(bytes)
    tamperedBytes[0] = tamperedBytes[0]! ^ 1
    fs.writeFileSync(artifactPath, tamperedBytes)
    await expect(inspectArtifact(artifactPath).then(after => assertReceiptArtifactUnchanged(before, after)))
      .rejects.toThrow('artifact_changed_during_receipt_generation')

    fs.unlinkSync(artifactPath)
    fs.writeFileSync(artifactPath, bytes)
    await expect(inspectArtifact(artifactPath).then(after => assertReceiptArtifactUnchanged(before, after)))
      .rejects.toThrow('artifact_changed_during_receipt_generation')

    fs.unlinkSync(artifactPath)
    fs.symlinkSync(path.join(root, 'missing.dmg'), artifactPath)
    await expect(inspectArtifact(artifactPath)).rejects.toThrow('artifact_must_be_regular_file')
  })

  it('rejects an equal-length original DMG rewrite even when bytes and mtime are restored', async () => {
    const root = tempRoot()
    const artifactPath = path.join(root, 'fixture.dmg')
    const original = Buffer.from('original-dmg-bytes')
    fs.writeFileSync(artifactPath, original)
    const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000)
    fs.utimesSync(artifactPath, fixedTime, fixedTime)
    const before = await inspectArtifact(artifactPath)

    fs.writeFileSync(artifactPath, Buffer.from('temporary-dmg-byte'))
    fs.writeFileSync(artifactPath, original)
    fs.utimesSync(artifactPath, fixedTime, fixedTime)
    const after = await inspectArtifact(artifactPath)
    expect(after.sha256).toBe(before.sha256)
    expect(after.sizeBytes).toBe(before.sizeBytes)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.ctimeNs).not.toBe(before.ctimeNs)
    expect(() => assertReceiptArtifactUnchanged(before, after))
      .toThrow('artifact_changed_during_receipt_generation')
  })

  it('completes repeated short writes and verifies the copied bytes by stable read-back', async () => {
    const root = tempRoot()
    const sourcePath = path.join(root, 'source.dmg')
    const destination = path.join(root, 'copy.dmg')
    fs.writeFileSync(sourcePath, 'short-write-copy-fixture')
    const source = await inspectArtifact(sourcePath)
    let writes = 0
    await copyStableInputFile(source, destination, async (output, buffer, offset, length, position) => {
      writes += 1
      const shortLength = Math.min(length, 3)
      return output.write(buffer, offset, shortLength, position)
    })
    expect(writes).toBeGreaterThan(1)
    expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(sourcePath))
  })

  it('rejects zero-progress and corrupted stable-copy writes', async () => {
    const root = tempRoot()
    const sourcePath = path.join(root, 'source.dmg')
    fs.writeFileSync(sourcePath, 'copy-integrity-fixture')
    const source = await inspectArtifact(sourcePath)
    await expect(copyStableInputFile(
      source,
      path.join(root, 'zero-progress.dmg'),
      async () => ({ bytesWritten: 0 }),
    )).rejects.toThrow('artifact_copy_write_no_progress')

    await expect(copyStableInputFile(
      source,
      path.join(root, 'corrupted.dmg'),
      async (output, buffer, offset, length, position) => {
        const corrupted = Buffer.from(buffer.subarray(offset, offset + length))
        corrupted[0] = corrupted[0]! ^ 1
        return output.write(corrupted, 0, corrupted.length, position)
      },
    )).rejects.toThrow('artifact_copy_readback_mismatch')
  })

  it.each([
    ['opencode-ai', '1.18.29', 'opencode-darwin-x64', 'opencode-darwin-x64-baseline', false],
    ['@opencode-ai/cli', '0.0.0-beta-19157', '@opencode-ai/cli-darwin-x64', '@opencode-ai/cli-darwin-x64-baseline', true],
  ] as const)('binds both standard-install x64 leaves for %s', (packageName, version, modern, baseline, selectsVariant) => {
    const modernSpec = npmComposedDistributionSpec(packageName, version, 'x64', 'modern')!
    const baselineSpec = npmComposedDistributionSpec(packageName, version, 'x64', 'baseline')!
    expect(modernSpec.components.map(component => component.installName)).toEqual([modern, baseline])
    expect(baselineSpec.components.map(component => component.installName)).toEqual([modern, baseline])
    expect(modernSpec.copySourceInstallName).toBe(modern)
    expect(baselineSpec.copySourceInstallName).toBe(selectsVariant ? baseline : modern)
  })

  it('freezes the exact OMP 18.1.11 native filenames for both macOS architectures', () => {
    expect(npmComposedDistributionSpec('@oh-my-pi/pi-coding-agent', '18.1.11', 'arm64')
      ?.components.at(-1)?.nativeExecutableRelativePath).toBe('pi_natives.darwin-arm64.node')
    expect(npmComposedDistributionSpec('@oh-my-pi/pi-coding-agent', '18.1.11', 'x64')
      ?.components.at(-1)?.nativeExecutableRelativePath).toBe('pi_natives.darwin-x64-baseline.node')
  })

  it('captures canonical OpenCode v1 x64 only when both identical standard-install leaves are bound', async () => {
    const root = tempRoot()
    const version = '1.18.29'
    const rootSource = path.join(root, 'root-source', 'package')
    const modernSource = path.join(root, 'modern-source', 'package')
    const baselineSource = path.join(root, 'baseline-source', 'package')
    writeExecutable(path.join(rootSource, 'bin', 'opencode.exe'), 'root-placeholder')
    fs.writeFileSync(path.join(rootSource, 'package.json'), JSON.stringify({
      name: 'opencode-ai', version, bin: { opencode: './bin/opencode.exe' },
    }))
    const leafNames = ['opencode-darwin-x64', 'opencode-darwin-x64-baseline']
    for (const [leafSource, leafName] of [[modernSource, leafNames[0]!], [baselineSource, leafNames[1]!]] as const) {
      writeExecutable(path.join(leafSource, 'bin', 'opencode'), 'shared-native')
      fs.writeFileSync(path.join(leafSource, 'package.json'), JSON.stringify({
        name: leafName, version, os: ['darwin'], cpu: ['x64'],
      }))
    }
    const rootTarball = path.join(root, 'root.tgz')
    const leafTarballs = [path.join(root, 'modern.tgz'), path.join(root, 'baseline.tgz')]
    archiveDirectory(path.dirname(rootSource), 'package', rootTarball)
    archiveDirectory(path.dirname(modernSource), 'package', leafTarballs[0]!)
    archiveDirectory(path.dirname(baselineSource), 'package', leafTarballs[1]!)
    const rootUrl = `https://registry.npmjs.org/opencode-ai/-/opencode-ai-${version}.tgz`
    const rootMetadata = path.join(root, 'root.json')
    const leafMetadata = [path.join(root, 'modern.json'), path.join(root, 'baseline.json')]
    writePackument(rootMetadata, 'opencode-ai', version, sha512Integrity(rootTarball), rootUrl)
    for (const [index, leafName] of leafNames.entries()) {
      writePackument(leafMetadata[index]!, leafName, version, sha512Integrity(leafTarballs[index]!),
        `https://registry.npmjs.org/${leafName}/-/${leafName}-${version}.tgz`)
    }
    const common = {
      kind: 'npm-tarball' as const, catalogId: 'opencode-v1-cli', version,
      architecture: 'x64' as const, artifactPath: rootTarball, sourceUrl: rootUrl,
      registryMetadataPath: rootMetadata, binName: 'opencode',
      npmComponents: leafNames.map((installName, index) => ({
        installName, registryMetadataPath: leafMetadata[index]!, tarballPath: leafTarballs[index]!,
      })),
      releaseManifestPath,
    }
    const envelope = await generateAgentDistributionReceipt({
      ...common,
      distributionId: 'cli:opencode-v1-cli:darwin-x64',
      outputPath: path.join(root, 'canonical.json'),
    }, fakeSignedDependencies)
    const receipt = envelope.receipt as AgentReleaseDistributionArtifactReceipt
    const entry = AGENT_INTEGRATION_RELEASE_ENTRIES.find(candidate => candidate.catalogId === 'opencode-v1-cli')!
    expect(validArtifactReceipt(receipt, { ...entry, releaseAcceptedExactVersions: [version] })).toBe(true)
    await expect(generateAgentDistributionReceipt({
      ...common, npmComponents: common.npmComponents.slice(0, 1),
      distributionId: 'cli:opencode-v1-cli:darwin-x64', outputPath: path.join(root, 'missing.json'),
    }, fakeSignedDependencies)).rejects.toThrow('npm_composed_receipt_requires_exact_component_inputs')
    writeExecutable(path.join(baselineSource, 'bin', 'opencode'), 'diverged-baseline-native')
    archiveDirectory(path.dirname(baselineSource), 'package', leafTarballs[1]!)
    writePackument(leafMetadata[1]!, leafNames[1]!, version, sha512Integrity(leafTarballs[1]!),
      `https://registry.npmjs.org/${leafNames[1]}/-/${leafNames[1]}-${version}.tgz`)
    await expect(generateAgentDistributionReceipt({
      ...common, distributionId: 'cli:opencode-v1-cli:darwin-x64',
      outputPath: path.join(root, 'diverged.json'),
    }, fakeSignedDependencies)).rejects.toThrow('npm_tarball_does_not_produce_release_runtime_identity')
  })

  it.each(['modern', 'baseline'] as const)('captures OpenCode v2 x64 %s from the uniquely copied root bytes while binding both leaves', async variant => {
    const root = tempRoot()
    const version = '0.0.0-beta-19157'
    const packageName = '@opencode-ai/cli'
    const rootSource = path.join(root, 'root-source', 'package')
    writeExecutable(path.join(rootSource, 'bin', 'opencode2.exe'), 'root-placeholder')
    fs.writeFileSync(path.join(rootSource, 'package.json'), JSON.stringify({
      name: packageName, version, bin: { opencode2: './bin/opencode2.exe' },
    }))
    const leafNames = ['@opencode-ai/cli-darwin-x64', '@opencode-ai/cli-darwin-x64-baseline']
    const leafTarballs: string[] = []
    const leafMetadata: string[] = []
    for (const [index, leafName] of leafNames.entries()) {
      const leafSource = path.join(root, `leaf-${index}`, 'package')
      writeExecutable(path.join(leafSource, 'bin', 'opencode2'), index === 0 ? 'modern-native' : 'baseline-native')
      fs.writeFileSync(path.join(leafSource, 'package.json'), JSON.stringify({
        name: leafName, version, os: ['darwin'], cpu: ['x64'],
      }))
      const tarball = path.join(root, `leaf-${index}.tgz`)
      const metadata = path.join(root, `leaf-${index}.json`)
      archiveDirectory(path.dirname(leafSource), 'package', tarball)
      writePackument(metadata, leafName, version, sha512Integrity(tarball),
        `https://registry.npmjs.org/${leafName}/-/${path.basename(leafName)}-${version}.tgz`)
      leafTarballs.push(tarball)
      leafMetadata.push(metadata)
    }
    const rootTarball = path.join(root, 'root.tgz')
    archiveDirectory(path.dirname(rootSource), 'package', rootTarball)
    const rootUrl = `https://registry.npmjs.org/@opencode-ai/cli/-/cli-${version}.tgz`
    const rootMetadata = path.join(root, 'root.json')
    writePackument(rootMetadata, packageName, version, sha512Integrity(rootTarball), rootUrl)
    const envelope = await generateAgentDistributionReceipt({
      kind: 'npm-tarball', catalogId: 'opencode-v2-beta-cli',
      distributionId: `cli:opencode-v2-beta-cli:darwin-x64${variant === 'baseline' ? '-baseline' : ''}`,
      version, architecture: 'x64', artifactPath: rootTarball, sourceUrl: rootUrl,
      registryMetadataPath: rootMetadata, binName: 'opencode2',
      npmComponents: leafNames.map((installName, index) => ({
        installName, registryMetadataPath: leafMetadata[index]!, tarballPath: leafTarballs[index]!,
      })),
      releaseManifestPath, outputPath: path.join(root, `${variant}.json`),
    }, fakeSignedDependencies)
    const receipt = envelope.receipt as AgentReleaseDistributionArtifactReceipt
    expect(receipt.npmPackage?.composition?.components.map(component => component.installName)).toEqual(leafNames)
    const expectedBytes = variant === 'baseline' ? 'baseline-native' : 'modern-native'
    expect(receipt.executableSha256).toBe(createHash('sha256').update(expectedBytes).digest('hex'))
    expect(validArtifactReceipt(receipt, {
      ...AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'opencode-v2-beta-cli')!,
      releaseAcceptedExactVersions: [version],
    })).toBe(true)
  })
  it.skipIf(process.platform !== 'darwin')('uses real lipo for both Mach-O architecture names and rejects the opposite slice', () => {
    const root = tempRoot()
    for (const [architecture, cpuType] of [['x64', 0x01000007], ['arm64', 0x0100000c]] as const) {
      const file = path.join(root, `${architecture}.macho`)
      const header = Buffer.alloc(32)
      header.writeUInt32LE(0xfeedfacf, 0)
      header.writeUInt32LE(cpuType, 4)
      header.writeUInt32LE(architecture === 'x64' ? 3 : 0, 8)
      header.writeUInt32LE(2, 12)
      fs.writeFileSync(file, header)
      expect(() => assertMachOArchitecture(file, architecture)).not.toThrow()
      expect(() => assertMachOArchitecture(file, architecture === 'x64' ? 'arm64' : 'x64'))
        .toThrow('signed_distribution_architecture_mismatch')
    }
  })
  it('fails closed when Claude detached-signature verification lacks the fixed Anthropic key', async () => {
    const root = tempRoot()
    const manifest = path.join(root, 'manifest.json')
    const signature = path.join(root, 'manifest.json.sig')
    const key = path.join(root, 'claude-code.asc')
    fs.writeFileSync(manifest, '{}')
    fs.writeFileSync(signature, 'not a signature')
    fs.writeFileSync(key, 'not a public key')
    await expect(verifyAnthropicManifestSignature(
      manifest, signature, key, path.join(root, 'gnupg'),
    )).rejects.toThrow(/gpg_not_available|artifact_tool_failed|fingerprint_mismatch/u)
    expect(fs.existsSync(path.join(root, 'gnupg'))).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin')('keeps a short GPG home private and cleans it after use', async () => {
    const root = fs.realpathSync(fs.mkdtempSync('/tmp/gpg-home-test-'))
    roots.push(root)
    const requested = path.join(root, 'g')
    const home = await createIsolatedGpgHome(requested)
    roots.push(home.path)
    expect(home.path).toBe(requested)
    expect(home.usedShortPath).toBe(false)
    expect(fs.statSync(home.path).mode & 0o777).toBe(0o700)
    await home.cleanup()
    expect(fs.existsSync(home.path)).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin')('selects and cleans a short private GPG home for a long TMPDIR-derived path', async () => {
    const root = tempRoot()
    const longTmpDir = path.join(root, 'x'.repeat(120))
    fs.mkdirSync(longTmpDir)
    const requested = path.join(longTmpDir, 'tidemind-agent-receipt', 'claude-release-evidence', 'gnupg')
    fs.mkdirSync(path.dirname(requested), { recursive: true })
    const home = await createIsolatedGpgHome(requested)
    roots.push(home.path)
    const shortTempRoot = fs.realpathSync('/tmp')
    expect(home.usedShortPath).toBe(true)
    expect(home.path.startsWith(`${shortTempRoot}${path.sep}tm-gpg-`)).toBe(true)
    expect(home.path).not.toBe(requested)
    expect(fs.statSync(home.path).mode & 0o777).toBe(0o700)
    expect(Buffer.byteLength(path.join(home.path, 'S.gpg-agent.browser'), 'utf8')).toBeLessThanOrEqual(103)
    await home.cleanup()
    expect(fs.existsSync(home.path)).toBe(false)
    expect(fs.existsSync(requested)).toBe(false)
  })

  it('generates a canonical generic npm receipt from an integrity-bound tarball', async () => {
    const root = tempRoot()
    const source = path.join(root, 'source')
    const packageRoot = path.join(source, 'package')
    writeExecutable(path.join(packageRoot, 'bin', 'kimi.js'))
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@moonshot-ai/kimi-code', version: '0.41.0', bin: { kimi: 'bin/kimi.js' },
    }))
    const tarball = path.join(root, 'kimi.tgz')
    archiveDirectory(source, 'package', tarball)
    const url = 'https://registry.npmjs.org/@moonshot-ai/kimi-code/-/kimi-code-0.41.0.tgz'
    const metadata = path.join(root, 'packument.json')
    writePackument(metadata, '@moonshot-ai/kimi-code', '0.41.0', sha512Integrity(tarball), url)

    const envelope = await generateAgentDistributionReceipt({
      kind: 'npm-tarball', catalogId: 'kimi-code-cli', distributionId: 'cli:kimi-code-cli',
      version: '0.41.0', artifactPath: tarball, sourceUrl: url,
      registryMetadataPath: metadata, binName: 'kimi', ...baseOptions(root),
    })
    const receipt = envelope.receipt as Record<string, any>
    expect(receipt).toMatchObject({
      packageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
      version: '0.41.0', architecture,
      portableFingerprintSchema: 'npm-owned-package-surface-v1',
      signedCode: null,
    })
    expect(receipt.portableArtifactFingerprint).toBe(portableArtifactFingerprint(receipt))
    expect(receipt.distributionSha256).toBe(receipt.npmPackage.ownedPackageSha256)
    const releaseEntry = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'kimi-code-cli')!
    const acceptedEntry = { ...releaseEntry, releaseAcceptedExactVersions: ['0.41.0'] }
    expect(validArtifactReceipt(receipt as AgentReleaseDistributionArtifactReceipt, acceptedEntry)).toBe(true)
    const fingerprintTamper = structuredClone(receipt)
    fingerprintTamper.npmPackage.ownedPackageSha256 = '0'.repeat(64)
    expect(validArtifactReceipt(
      fingerprintTamper as AgentReleaseDistributionArtifactReceipt, acceptedEntry,
    )).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'), 'utf8')).receiptSha256)
      .toBe(envelope.receiptSha256)
  })

  it('binds a postinstall CLI to the exact platform leaf without executing package scripts', async () => {
    const root = tempRoot()
    const version = '2.1.261'
    const rootSource = path.join(root, 'root-source', 'package')
    const leafSource = path.join(root, 'leaf-source', 'package')
    const binary = '#!/bin/sh\necho composed\n'
    fs.mkdirSync(path.join(rootSource, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(rootSource, 'bin', 'claude.exe'), 'official-placeholder', { mode: 0o644 })
    fs.writeFileSync(path.join(rootSource, 'install.cjs'), 'throw new Error("must not execute")\n')
    fs.writeFileSync(path.join(rootSource, 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-code', version, bin: { claude: './bin/claude.exe' },
      scripts: { postinstall: 'node install.cjs' },
    }))
    writeExecutable(path.join(leafSource, 'claude'), binary)
    const leafName = `@anthropic-ai/claude-code-darwin-${architecture}`
    fs.writeFileSync(path.join(leafSource, 'package.json'), JSON.stringify({
      name: leafName, version, os: ['darwin'], cpu: [architecture],
    }))
    const rootTarball = path.join(root, 'claude-root.tgz')
    const leafTarball = path.join(root, 'claude-leaf.tgz')
    archiveDirectory(path.dirname(rootSource), 'package', rootTarball)
    archiveDirectory(path.dirname(leafSource), 'package', leafTarball)
    const rootUrl = `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`
    const leafUrl = `https://registry.npmjs.org/${leafName}/-/${path.basename(leafName)}-${version}.tgz`
    const rootMetadata = path.join(root, 'root-packument.json')
    const leafMetadata = path.join(root, 'leaf-packument.json')
    writePackument(rootMetadata, '@anthropic-ai/claude-code', version, sha512Integrity(rootTarball), rootUrl)
    writePackument(leafMetadata, leafName, version, sha512Integrity(leafTarball), leafUrl)
    const options = {
      kind: 'npm-tarball' as const,
      catalogId: 'claude-code-cli', distributionId: 'cli:claude-code-cli', version,
      artifactPath: rootTarball, sourceUrl: rootUrl, registryMetadataPath: rootMetadata,
      binName: 'claude', npmComponents: [{
        installName: leafName, registryMetadataPath: leafMetadata, tarballPath: leafTarball,
      }],
      ...baseOptions(root),
    }
    const checkedArchitectures: string[] = []
    const envelope = await generateAgentDistributionReceipt(options, {
      ...fakeSignedDependencies,
      assertArchitecture(_path, selected) { checkedArchitectures.push(selected) },
    })
    const receipt = envelope.receipt as Record<string, any>
    expect(receipt.portableFingerprintSchema).toBe('npm-composed-platform-surface-v1')
    expect(receipt.npmPackage.composition).toMatchObject({
      entryRule: 'copy_platform_binary_v1',
      components: [expect.objectContaining({ installName: leafName, version })],
    })
    expect(receipt.executableSha256).toBe(createHash('sha256').update(binary).digest('hex'))
    expect(receipt.npmPackage.proofNodes.find((node: Record<string, unknown>) => (
      node.role === 'npm_package_executable'
    ))?.executable).toBe(true)
    expect(checkedArchitectures).toEqual([architecture])
    expect(receipt.portableArtifactFingerprint).toBe(portableArtifactFingerprint(receipt))
    const releaseEntry = AGENT_INTEGRATION_RELEASE_ENTRIES.find(entry => entry.catalogId === 'claude-code-cli')!
    expect(validArtifactReceipt(receipt as AgentReleaseDistributionArtifactReceipt, {
      ...releaseEntry,
      releaseAcceptedExactVersions: [version],
    })).toBe(true)
    const runtimeRejected = structuredClone(receipt)
    runtimeRejected.npmPackage.composition.components[0].ownedPackageSha256 = '0'.repeat(64)
    expect(validArtifactReceipt(runtimeRejected as AgentReleaseDistributionArtifactReceipt, {
      ...releaseEntry,
      releaseAcceptedExactVersions: [version],
    })).toBe(false)
    const runtimeExtraField = structuredClone(receipt)
    runtimeExtraField.npmPackage.composition.unreviewed = true
    expect(validArtifactReceipt(runtimeExtraField as AgentReleaseDistributionArtifactReceipt, {
      ...releaseEntry,
      releaseAcceptedExactVersions: [version],
    })).toBe(false)
    const downgradedGeneric = structuredClone(receipt)
    delete downgradedGeneric.npmPackage.composition
    downgradedGeneric.portableFingerprintSchema = 'npm-owned-package-surface-v1'
    downgradedGeneric.portableArtifactFingerprint = portableArtifactFingerprint(downgradedGeneric)
    expect(validArtifactReceipt(downgradedGeneric as AgentReleaseDistributionArtifactReceipt, {
      ...releaseEntry,
      releaseAcceptedExactVersions: [version],
    })).toBe(false)

    await expect(generateAgentDistributionReceipt({ ...options, outputPath: path.join(root, 'missing.json'), npmComponents: [] }, fakeSignedDependencies))
      .rejects.toThrow('npm_composed_receipt_requires_exact_component_inputs')
    fs.writeFileSync(path.join(leafSource, 'package.json'), JSON.stringify({
      name: leafName, version: '2.1.260', os: ['darwin'], cpu: [architecture],
    }))
    archiveDirectory(path.dirname(leafSource), 'package', leafTarball)
    writePackument(leafMetadata, leafName, version, sha512Integrity(leafTarball), leafUrl)
    await expect(generateAgentDistributionReceipt({ ...options, outputPath: path.join(root, 'wrong-version.json') }, fakeSignedDependencies))
      .rejects.toThrow('npm_tarball_does_not_produce_release_runtime_identity')
  })

  it('rejects a composed platform leaf for the wrong architecture or copied bytes', async () => {
    const root = tempRoot()
    const version = '1.18.29'
    const packageName = 'opencode-ai'
    const rootSource = path.join(root, 'root-source', 'package')
    writeExecutable(path.join(rootSource, 'bin', 'opencode.exe'), 'root bytes')
    fs.writeFileSync(path.join(rootSource, 'package.json'), JSON.stringify({ name: packageName, version, bin: { opencode: './bin/opencode.exe' } }))
    const rootTarball = path.join(root, 'root.tgz')
    archiveDirectory(path.dirname(rootSource), 'package', rootTarball)
    const rootUrl = `https://registry.npmjs.org/opencode-ai/-/opencode-ai-${version}.tgz`
    const rootMetadata = path.join(root, 'root.json')
    writePackument(rootMetadata, packageName, version, sha512Integrity(rootTarball), rootUrl)
    const composition = npmComposedDistributionSpec(packageName, version, architecture)!
    const npmComponents = composition.components.map((component, index) => {
      const leafSource = path.join(root, `leaf-source-${index}`, 'package')
      writeExecutable(path.join(leafSource, 'bin', 'opencode'), `leaf bytes ${index}`)
      fs.writeFileSync(path.join(leafSource, 'package.json'), JSON.stringify({
        name: component.manifestName,
        version: component.version,
        os: ['darwin'],
        cpu: [index === 0 ? (architecture === 'arm64' ? 'x64' : 'arm64') : architecture],
      }))
      const leafTarball = path.join(root, `leaf-${index}.tgz`)
      const leafMetadata = path.join(root, `leaf-${index}.json`)
      archiveDirectory(path.dirname(leafSource), 'package', leafTarball)
      writePackument(
        leafMetadata,
        component.manifestName,
        component.version,
        sha512Integrity(leafTarball),
        `https://registry.npmjs.org/${component.manifestName}/-/${path.basename(component.manifestName)}-${component.version}.tgz`,
      )
      return { installName: component.installName, registryMetadataPath: leafMetadata, tarballPath: leafTarball }
    })
    await expect(generateAgentDistributionReceipt({
      kind: 'npm-tarball', catalogId: 'opencode-v1-cli', distributionId: `cli:opencode-v1-cli:darwin-${architecture}`,
      version, artifactPath: rootTarball, sourceUrl: rootUrl, registryMetadataPath: rootMetadata,
      binName: 'opencode', npmComponents,
      ...baseOptions(root),
    }, fakeSignedDependencies)).rejects.toThrow('npm_tarball_does_not_produce_release_runtime_identity')
  })

  it('rejects an npm tarball integrity mismatch', async () => {
    const { options } = kimiNpmReceiptFixture('invalid')
    await expect(generateAgentDistributionReceipt(options)).rejects.toThrow('npm_tarball_integrity_mismatch')
  })

  it('rejects an npm package bin name mismatch', async () => {
    const { options } = kimiNpmReceiptFixture()
    await expect(generateAgentDistributionReceipt({ ...options, binName: 'not-kimi' }))
      .rejects.toThrow('npm_package_bin_mismatch')
  })

  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['absolute', '/absolute/kimi.js'],
    ['duplicate separator', 'bin//kimi.js'],
    ['redundant dot segment', '././bin/kimi.js'],
    ['parent traversal', '../bin/kimi.js'],
    ['backslash separator', 'bin\\kimi.js'],
  ])('rejects an npm package bin path with %s', async (_description, invalidBin) => {
    const { options } = kimiNpmReceiptFixture('valid', invalidBin)
    await expect(generateAgentDistributionReceipt(options)).rejects.toThrow('npm_package_bin_mismatch')
  })

  it('rejects overwriting an existing receipt output', async () => {
    const { options } = kimiNpmReceiptFixture()
    await generateAgentDistributionReceipt(options)
    await expect(generateAgentDistributionReceipt(options)).rejects.toThrow(/EEXIST|exist/u)
  })

  it('generates signed App and signed CLI receipts through the shared signature/fingerprint path', async () => {
    const appRoot = tempRoot()
    const payload = path.join(appRoot, 'payload')
    const app = path.join(payload, 'ZCode.app')
    writeExecutable(path.join(app, 'Contents', 'MacOS', 'ZCode'))
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict>
      <key>CFBundleIdentifier</key><string>dev.zcode.app</string>
      <key>CFBundleShortVersionString</key><string>3.11.2</string>
      <key>CFBundleExecutable</key><string>ZCode</string>
    </dict></plist>`)
    const appArchive = path.join(appRoot, 'zcode.tgz')
    archiveDirectory(payload, 'ZCode.app', appArchive)
    const appEnvelope = await generateAgentDistributionReceipt({
      kind: 'signed-app', catalogId: 'zcode-desktop', distributionId: 'dev.zcode.app',
      version: '3.11.2', artifactPath: appArchive, sourceUrl: 'https://download.zcode.example/ZCode.tgz',
      memberPath: 'ZCode.app', archiveFormat: 'tgz', ...baseOptions(appRoot),
    }, fakeSignedDependencies)
    const appReceipt = appEnvelope.receipt as Record<string, any>
    expect(appReceipt.signedCode).toMatchObject({ identifier: 'dev.zcode.app', teamIdentifier: '8A5X4JJ39T' })
    expect(appReceipt.portableArtifactFingerprint).toBe(portableArtifactFingerprint(appReceipt))

    const cliRoot = tempRoot()
    const cli = path.join(cliRoot, 'claude')
    writeExecutable(cli)
    const cliManifest = path.join(cliRoot, 'manifest.json')
    const cliManifestSignature = path.join(cliRoot, 'manifest.json.sig')
    const cliSigningKey = path.join(cliRoot, 'claude-code.asc')
    fs.writeFileSync(cliManifest, JSON.stringify({
      version: '2.1.261',
      platforms: {
        [`darwin-${architecture}`]: {
          binary: 'claude',
          checksum: createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),
          size: fs.statSync(cli).size,
        },
      },
    }))
    fs.writeFileSync(cliManifestSignature, 'detached signature')
    fs.writeFileSync(cliSigningKey, 'public key')
    const cliEnvelope = await generateAgentDistributionReceipt({
      kind: 'signed-cli', catalogId: 'claude-code-native', distributionId: 'cli:claude-code-native',
      version: '2.1.261', artifactPath: cli,
      sourceUrl: `https://downloads.claude.ai/claude-code-releases/2.1.261/darwin-${architecture}/claude`,
      signedCliManifestPath: cliManifest,
      signedCliManifestSignaturePath: cliManifestSignature,
      signedCliSigningKeyPath: cliSigningKey,
      archiveFormat: 'raw', ...baseOptions(cliRoot),
    }, fakeSignedDependencies)
    const cliReceipt = cliEnvelope.receipt as Record<string, any>
    expect(cliReceipt.distributionSha256).toBe(cliReceipt.executableSha256)
    expect(cliReceipt.distributionSizeBytes).toBe(cliReceipt.executableSizeBytes)
    expect(cliReceipt.portableArtifactFingerprint).toBe(portableArtifactFingerprint(cliReceipt))

    await expect(generateAgentDistributionReceipt({
      kind: 'signed-cli', catalogId: 'claude-code-native', distributionId: 'cli:claude-code-native',
      version: '2.1.261', artifactPath: cli,
      sourceUrl: `https://downloads.claude.ai/claude-code-releases/2.1.261/darwin-${architecture}/claude`,
      archiveFormat: 'raw', outputPath: path.join(cliRoot, 'unproven.json'),
      architecture, releaseManifestPath,
    }, fakeSignedDependencies)).rejects.toThrow('claude_signed_cli_requires_signed_release_manifest')
  })

  it('binds Kimi version and architecture to exact GitHub release assets and the official manifest', async () => {
    const root = tempRoot()
    const cli = path.join(root, 'kimi')
    writeExecutable(cli)
    const artifactName = `kimi-code-darwin-${architecture}.zip`
    const artifact = path.join(root, artifactName)
    archiveZipFile(root, 'kimi', artifact, true)
    const checksum = path.join(root, `${artifactName}.sha256`)
    const artifactSha256 = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')
    fs.writeFileSync(checksum, `${artifactSha256}  ${artifactName}\n`)
    const manifestPath = path.join(root, 'manifest.json')
    const binarySha256 = createHash('sha256').update(fs.readFileSync(cli)).digest('hex')
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: '0.41.0', tag: '@moonshot-ai/kimi-code@0.41.0',
      platforms: { [`darwin-${architecture}`]: {
        filename: `kimi-code-darwin-${architecture}`, checksum: binarySha256,
      } },
    }))
    const releaseMetadataPath = path.join(root, 'github-release.json')
    const releaseRoot = 'https://github.com/MoonshotAI/kimi-code/releases/download/%40moonshot-ai/kimi-code%400.41.0'
    const asset = (id: number, name: string, target: string) => ({
      id, name, browser_download_url: `${releaseRoot}/${name}`,
      size: fs.statSync(target).size,
      digest: `sha256:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`,
      updated_at: '2026-09-04T11:19:09Z',
    })
    fs.writeFileSync(releaseMetadataPath, JSON.stringify({
      id: 382659724, tag_name: '@moonshot-ai/kimi-code@0.41.0',
      html_url: 'https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%400.41.0',
      published_at: '2026-09-04T11:01:07Z', immutable: false,
      assets: [
        asset(544227135, 'manifest.json', manifestPath),
        asset(544226946, artifactName, artifact),
        asset(544226949, `${artifactName}.sha256`, checksum),
      ],
    }))
    const kimiDependencies: GeneratorDependencies = {
      ...fakeSignedDependencies,
      kimiReleaseAuthority: () => ({
        releaseId: 382659724,
        manifest: {
          id: 544227135, name: 'manifest.json', url: `${releaseRoot}/manifest.json`,
          sizeBytes: fs.statSync(manifestPath).size,
          sha256: createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),
        },
        archive: {
          id: 544226946, name: artifactName, url: `${releaseRoot}/${artifactName}`,
          sizeBytes: fs.statSync(artifact).size, sha256: artifactSha256,
        },
        checksum: {
          id: 544226949, name: `${artifactName}.sha256`, url: `${releaseRoot}/${artifactName}.sha256`,
          sizeBytes: fs.statSync(checksum).size,
          sha256: createHash('sha256').update(fs.readFileSync(checksum)).digest('hex'),
        },
      }),
    }
    await expect(generateAgentDistributionReceipt({
      kind: 'signed-cli', catalogId: 'kimi-code-native', distributionId: 'cli:kimi-code-native',
      version: '0.41.0', artifactPath: artifact, sourceUrl: `${releaseRoot}/${artifactName}`,
      kimiGitHubReleaseMetadataPath: releaseMetadataPath, kimiReleaseManifestPath: manifestPath,
      kimiArtifactChecksumPath: checksum, memberPath: 'kimi', archiveFormat: 'zip',
      ...baseOptions(root),
    }, fakeSignedDependencies)).rejects.toThrow('kimi_release_authority_not_frozen')
    const envelope = await generateAgentDistributionReceipt({
      kind: 'signed-cli', catalogId: 'kimi-code-native', distributionId: 'cli:kimi-code-native',
      version: '0.41.0', artifactPath: artifact,
      sourceUrl: `${releaseRoot}/${artifactName}`,
      kimiGitHubReleaseMetadataPath: releaseMetadataPath,
      kimiReleaseManifestPath: manifestPath,
      kimiArtifactChecksumPath: checksum, memberPath: 'kimi',
      archiveFormat: 'zip', ...baseOptions(root),
    }, kimiDependencies)
    const receipt = envelope.receipt as Record<string, any>
    expect(receipt.portableFingerprintSchema).toBe('signed-cli-kimi-release-v2')
    expect(receipt.portableArtifactFingerprint).toBe(portableArtifactFingerprint(receipt))
    expect(envelope.sourceEvidence).toMatchObject({
      kimiGitHubRelease: {
        releaseId: 382659724,
        platform: { key: `darwin-${architecture}`, binarySha256 },
      },
    })
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: '0.41.0', tag: '@moonshot-ai/kimi-code@0.41.0',
      platforms: { [`darwin-${architecture}`]: {
        filename: `kimi-code-darwin-${architecture}`, checksum: 'f'.repeat(64),
      } },
    }))
    await expect(generateAgentDistributionReceipt({
      kind: 'signed-cli', catalogId: 'kimi-code-native', distributionId: 'cli:kimi-code-native',
      version: '0.41.0', artifactPath: artifact,
      sourceUrl: `${releaseRoot}/${artifactName}`,
      kimiGitHubReleaseMetadataPath: releaseMetadataPath,
      kimiReleaseManifestPath: manifestPath,
      kimiArtifactChecksumPath: checksum, memberPath: 'kimi',
      archiveFormat: 'zip', outputPath: path.join(root, 'mismatch.json'),
      architecture, releaseManifestPath,
    }, kimiDependencies)).rejects.toThrow(/kimi_github_release_asset_mismatch|kimi_release_manifest_binary_mismatch/u)
  })

  it('generates the Qwen standalone receipt from an isolated relocatable prefix', async () => {
    const root = tempRoot()
    const payload = path.join(root, 'source', 'payload')
    writeExecutable(path.join(payload, 'bin', 'qwen'), normalizedQwenLauncherBytes().toString('utf8'))
    const packageRoot = payload
    writeExecutable(path.join(packageRoot, 'node', 'bin', 'node'))
    fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'lib', 'cli-entry.js'), 'export {}\n')
    const nestedRuntime = path.join(packageRoot, 'lib', 'node_modules', '@qwen-code', 'runtime.js')
    fs.mkdirSync(path.dirname(nestedRuntime), { recursive: true })
    fs.writeFileSync(nestedRuntime, 'export const runtime = true\n')
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.23.0' }))
    fs.writeFileSync(path.join(packageRoot, 'manifest.json'), JSON.stringify({
      name: '@qwen-code/qwen-code', version: '0.23.0', target: `darwin-${architecture}`, runtime: 'node', nodeArchive: `node-darwin-${architecture}.tar.gz`,
    }))
    const artifact = path.join(root, 'qwen.tgz')
    archiveDirectory(path.dirname(payload), 'payload', artifact)
    const envelope = await generateAgentDistributionReceipt({
      kind: 'qwen-standalone', catalogId: 'qwen-code-cli', distributionId: 'cli:qwen-code-cli:standalone',
      version: '0.23.0', artifactPath: artifact, sourceUrl: 'https://qwen.example/qwen-standalone.tgz',
      memberPath: 'payload', archiveFormat: 'tgz', ...baseOptions(root),
    }, fakeSignedDependencies)
    const receipt = envelope.receipt as Record<string, any>
    expect(receipt.portableFingerprintSchema).toBe('qwen-standalone-surface-v1')
    expect(receipt.npmPackage.proofNodes).toHaveLength(5)
    expect(receipt.portableArtifactFingerprint).toBe(portableArtifactFingerprint(receipt))
    const launcher = path.join(payload, 'bin', 'qwen')
    const physical = await readAgentHostPhysicalDistribution(
      receipt as AgentReleaseDistributionArtifactReceipt,
      { executablePath: launcher } as DiscoveredInstallation,
      createProductionAgentHostMetadataEvidenceRuntime(root),
    )
    expect(physical.executableSha256).toBe(receipt.executableSha256)
    expect(physical.executableSizeBytes).toBe(receipt.executableSizeBytes)
    expect(physical.rawExecutableSha256).toBe(physical.executableSha256)
    expect(physical.rawExecutableSizeBytes).toBe(fs.statSync(launcher).size)
    fs.appendFileSync(nestedRuntime, '/* drift */')
    await expect(readAgentHostPhysicalDistribution(
      receipt as AgentReleaseDistributionArtifactReceipt,
      { executablePath: launcher } as DiscoveredInstallation,
      createProductionAgentHostMetadataEvidenceRuntime(root),
    )).rejects.toThrow('fresh npm distribution proof does not match')
  })

  it('statically completes OpenClaw npm lifecycle and composes its distinct portable receipt', async () => {
    const root = tempRoot()
    const npmSource = path.join(root, 'npm-source', 'package')
    writeExecutable(path.join(npmSource, 'openclaw.mjs'))
    fs.mkdirSync(path.join(npmSource, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(npmSource, 'dist', 'entry.js'), 'export {}\n')
    fs.writeFileSync(path.join(npmSource, 'dist', 'postinstall-inventory.json'), JSON.stringify(['dist/entry.js']))
    fs.mkdirSync(path.join(npmSource, 'scripts', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(npmSource, 'scripts', 'lib', 'package-lifecycle-marker.mjs'), 'export const marker = ".openclaw-lifecycle-pending"\n')
    fs.writeFileSync(path.join(npmSource, 'scripts', 'postinstall-bundled-plugins.mjs'), 'throw new Error("upstream lifecycle must never execute during capture")\n')
    fs.writeFileSync(path.join(npmSource, '.openclaw-lifecycle-pending'), 'pending\n')
    fs.writeFileSync(path.join(npmSource, 'package.json'), JSON.stringify({
      name: 'openclaw', version: '2026.9.1', type: 'module', bin: { openclaw: 'openclaw.mjs' },
      scripts: {
        preinstall: 'node scripts/preinstall-package-manager-warning.mjs',
        postinstall: 'node scripts/postinstall-bundled-plugins.mjs',
      },
    }))
    const npmTarball = path.join(root, 'openclaw-npm.tgz')
    archiveDirectory(path.dirname(npmSource), 'package', npmTarball)
    const npmUrl = 'https://registry.npmjs.org/openclaw/-/openclaw-2026.9.1.tgz'
    const metadata = path.join(root, 'packument.json')
    writePackument(metadata, 'openclaw', '2026.9.1', sha512Integrity(npmTarball), npmUrl)

    const installer = path.join(root, 'install-cli.sh')
    fs.writeFileSync(installer, [
      '#!/usr/bin/env bash',
      'DEFAULT_NODE_VERSION="24.19.0"',
      'cat >"${PREFIX}/bin/openclaw" <<EOF',
      '#!/usr/bin/env bash', 'set -euo pipefail',
      'exec "${PREFIX}/tools/node/bin/node" "$(node_dir)/lib/node_modules/openclaw/dist/entry.js" "\\$@"',
      'EOF', '',
    ].join('\n'))
    const installerSha256 = createHash('sha256').update(fs.readFileSync(installer)).digest('hex')
    const commitSha = 'a'.repeat(40)
    const tagObjectSha = 'b'.repeat(40)
    const installerUrl = `https://raw.githubusercontent.com/openclaw/openclaw/${commitSha}/scripts/install-cli.sh`
    const tagRefMetadata = path.join(root, 'tag-ref.json')
    const tagObjectMetadata = path.join(root, 'tag-object.json')
    fs.writeFileSync(tagRefMetadata, JSON.stringify({
      ref: 'refs/tags/v2026.9.1',
      object: { sha: tagObjectSha, type: 'tag', url: `https://api.github.com/repos/openclaw/openclaw/git/tags/${tagObjectSha}` },
    }))
    fs.writeFileSync(tagObjectMetadata, JSON.stringify({
      sha: tagObjectSha, tag: 'v2026.9.1',
      object: { sha: commitSha, type: 'commit', url: `https://api.github.com/repos/openclaw/openclaw/git/commits/${commitSha}` },
      verification: {
        verified: true, reason: 'valid', signature: 'signed-tag',
        payload: `object ${commitSha}\ntype commit\ntag v2026.9.1\ntagger Test <test@example.com> 0 +0000\n\nOpenClaw 2026.9.1\n`,
        verified_at: '2026-09-03T15:57:11Z',
      },
    }))
    const nodeSource = path.join(root, `node-v24.19.0-darwin-${architecture}`)
    writeExecutable(path.join(nodeSource, 'bin', 'node'), '#!/bin/sh\nexit 0\n')
    const nodeArtifact = path.join(root, `node-v24.19.0-darwin-${architecture}.tar.gz`)
    archiveDirectory(root, path.basename(nodeSource), nodeArtifact)
    const nodeSha256 = createHash('sha256').update(fs.readFileSync(nodeArtifact)).digest('hex')
    const nodeSourceUrl = `https://nodejs.org/dist/v24.19.0/${path.basename(nodeArtifact)}`
    const nodeShasums = path.join(root, 'SHASUMS256.txt')
    fs.writeFileSync(nodeShasums, `${nodeSha256}  ${path.basename(nodeArtifact)}\n`)
    const nodeShasumsUrl = 'https://nodejs.org/dist/v24.19.0/SHASUMS256.txt'
    const openclawAuthority = {
        tag: 'v2026.9.1', tagObjectSha, commitSha,
        installerUrl, installerSha256, installerSizeBytes: fs.statSync(installer).size,
        nodeVersion: '24.19.0', nodeArchiveName: path.basename(nodeArtifact),
        nodeArchiveUrl: nodeSourceUrl, nodeArchiveSha256: nodeSha256, nodeShasumsUrl,
        npmTarballUrl: npmUrl, npmIntegrity: sha512Integrity(npmTarball),
        npmArtifactSha256: createHash('sha256').update(fs.readFileSync(npmTarball)).digest('hex'),
        npmArtifactSizeBytes: fs.statSync(npmTarball).size,
        lifecycleMarkerSha256: createHash('sha256').update(fs.readFileSync(path.join(npmSource, '.openclaw-lifecycle-pending'))).digest('hex'),
        lifecycleContractSha256: createHash('sha256').update(fs.readFileSync(path.join(npmSource, 'scripts', 'lib', 'package-lifecycle-marker.mjs'))).digest('hex'),
        postinstallScriptSha256: createHash('sha256').update(fs.readFileSync(path.join(npmSource, 'scripts', 'postinstall-bundled-plugins.mjs'))).digest('hex'),
        postinstallInventorySha256: createHash('sha256').update(fs.readFileSync(path.join(npmSource, 'dist', 'postinstall-inventory.json'))).digest('hex'),
      }
    const openclawDependencies: GeneratorDependencies = {
      ...fakeSignedDependencies,
      openclawReleaseAuthority: () => openclawAuthority,
    }

    const envelope = await generateAgentDistributionReceipt({
      kind: 'openclaw-portable', catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:portable-wrapper',
      version: '2026.9.1', artifactPath: installer, sourceUrl: installerUrl,
      registryMetadataPath: metadata, npmTarballPath: npmTarball,
      openclawTagRefMetadataPath: tagRefMetadata, openclawTagObjectMetadataPath: tagObjectMetadata,
      openclawNodeArtifactPath: nodeArtifact, openclawNodeSourceUrl: nodeSourceUrl,
      openclawNodeShasumsPath: nodeShasums, openclawNodeShasumsSourceUrl: nodeShasumsUrl,
      ...baseOptions(root),
    }, openclawDependencies)
    const receipt = envelope.receipt as Record<string, any>
    expect(receipt.portableFingerprintSchema).toBe('openclaw-official-wrapper-v1')
    expect(receipt.npmPackage.integrity).toBe(sha512Integrity(npmTarball))
    expect(receipt.portableArtifactFingerprint).toBe(portableArtifactFingerprint(receipt))
    expect(envelope.sourceEvidence).toMatchObject({
      artifact: { name: 'install-cli.sh', sha256: installerSha256 },
      openclawPortableComposition: {
        tag: 'v2026.9.1', commitSha, toolchain: 'node-v24.19.0',
        node: { archiveSha256: nodeSha256, shasumsUrl: nodeShasumsUrl },
      },
    })

    const npmOptions = {
      kind: 'npm-tarball' as const, catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:npm-global',
      version: '2026.9.1', artifactPath: npmTarball, sourceUrl: npmUrl,
      registryMetadataPath: metadata, binName: 'openclaw',
      outputPath: path.join(root, 'npm-postinstall.json'), architecture, releaseManifestPath,
    }
    const npmEnvelope = await generateAgentDistributionReceipt(npmOptions, openclawDependencies)
    const npmReceipt = npmEnvelope.receipt as AgentReleaseDistributionArtifactReceipt
    expect(npmReceipt.portableFingerprintSchema).toBe('npm-owned-package-surface-v1')
    expect(npmReceipt.npmPackage?.ownedPackageSha256).toBe(receipt.npmPackage.ownedPackageSha256)
    expect(npmReceipt.npmPackage?.ownedEntryCount).toBe(receipt.npmPackage.ownedEntryCount)
    expect(npmReceipt.portableArtifactFingerprint).not.toBe(receipt.portableArtifactFingerprint)
    expect(npmEnvelope.sourceEvidence).toMatchObject({
      openclawPackageLifecycle: {
        authority: 'openclaw-2026.9.1-code-frozen',
        schema: 'openclaw-static-postinstall-v1',
        markerRemoved: '.openclaw-lifecycle-pending',
        postinstallOwnedPackageSha256: receipt.npmPackage.ownedPackageSha256,
      },
    })
    // Capture only changes private staging, never the official source bytes.
    expect(fs.readFileSync(path.join(npmSource, '.openclaw-lifecycle-pending'), 'utf8')).toBe('pending\n')
    await expect(generateAgentDistributionReceipt({ ...npmOptions, outputPath: path.join(root, 'unfrozen-npm.json') }, fakeSignedDependencies))
      .rejects.toThrow('openclaw_release_authority_not_frozen')

    const payload = path.join(root, 'installed-prefix')
    const toolchain = path.join(payload, 'tools', 'node-v24.19.0')
    writeExecutable(path.join(toolchain, 'bin', 'node'), '#!/bin/sh\nexit 0\n')
    const installedPackage = path.join(toolchain, 'lib', 'node_modules', 'openclaw')
    fs.cpSync(npmSource, installedPackage, { recursive: true })
    fs.unlinkSync(path.join(installedPackage, '.openclaw-lifecycle-pending'))
    fs.writeFileSync(path.join(toolchain, 'lib', 'node_modules', '.package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/openclaw': { version: '2026.9.1', integrity: sha512Integrity(npmTarball) } },
    }))
    fs.symlinkSync('node-v24.19.0', path.join(payload, 'tools', 'node'))
    const launcher = path.join(payload, 'bin', 'openclaw')
    writeExecutable(launcher, [
      '#!/usr/bin/env bash', 'set -euo pipefail',
      `exec "${path.join(payload, 'tools', 'node', 'bin', 'node')}" "${path.join(installedPackage, 'dist', 'entry.js')}" "$@"`, '',
    ].join('\n'))
    const physical = await readAgentHostPhysicalDistribution(
      receipt as AgentReleaseDistributionArtifactReceipt,
      { executablePath: launcher } as DiscoveredInstallation,
      createProductionAgentHostMetadataEvidenceRuntime(root),
    )
    expect(physical.executableSha256).toBe(receipt.executableSha256)
    expect(physical.executableSizeBytes).toBe(receipt.executableSizeBytes)
    expect(physical.rawExecutableSha256).not.toBe(physical.executableSha256)
    expect(physical.rawExecutableSizeBytes).toBe(fs.statSync(launcher).size)

    await expect(generateAgentDistributionReceipt({
      kind: 'openclaw-portable', catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:portable-wrapper',
      version: '2026.9.1', artifactPath: installer, sourceUrl: installerUrl,
      memberPath: 'payload', archiveFormat: 'tgz', registryMetadataPath: metadata, npmTarballPath: npmTarball,
      openclawTagRefMetadataPath: tagRefMetadata, openclawTagObjectMetadataPath: tagObjectMetadata,
      openclawNodeArtifactPath: nodeArtifact, openclawNodeSourceUrl: nodeSourceUrl,
      openclawNodeShasumsPath: nodeShasums, openclawNodeShasumsSourceUrl: nodeShasumsUrl,
      outputPath: path.join(root, 'legacy-prefix.json'), architecture, releaseManifestPath,
    }, openclawDependencies)).rejects.toThrow('openclaw_portable_rejects_complete_prefix_archive')

    const forgedSource = path.join(root, 'forged-npm', 'package')
    fs.cpSync(npmSource, forgedSource, { recursive: true })
    fs.appendFileSync(path.join(forgedSource, 'dist', 'entry.js'), '/* forged */\n')
    fs.writeFileSync(path.join(forgedSource, 'dist', 'stale.js'), 'export const stale = true\n')
    const forgedNpmTarball = path.join(root, 'forged-openclaw.tgz')
    archiveDirectory(path.dirname(forgedSource), 'package', forgedNpmTarball)
    const forgedMetadata = path.join(root, 'forged-packument.json')
    writePackument(forgedMetadata, 'openclaw', '2026.9.1', sha512Integrity(forgedNpmTarball), npmUrl)
    await expect(generateAgentDistributionReceipt({
      kind: 'openclaw-portable', catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:portable-wrapper',
      version: '2026.9.1', artifactPath: installer, sourceUrl: installerUrl,
      registryMetadataPath: forgedMetadata, npmTarballPath: forgedNpmTarball,
      openclawTagRefMetadataPath: tagRefMetadata, openclawTagObjectMetadataPath: tagObjectMetadata,
      openclawNodeArtifactPath: nodeArtifact, openclawNodeSourceUrl: nodeSourceUrl,
      openclawNodeShasumsPath: nodeShasums, openclawNodeShasumsSourceUrl: nodeShasumsUrl,
      outputPath: path.join(root, 'self-authorized-npm.json'), architecture, releaseManifestPath,
    }, openclawDependencies)).rejects.toThrow('openclaw_npm_release_artifact_mismatch')

    await expect(generateAgentDistributionReceipt({
      ...npmOptions, artifactPath: forgedNpmTarball, registryMetadataPath: forgedMetadata,
      outputPath: path.join(root, 'forged-global-npm.json'),
    }, openclawDependencies)).rejects.toThrow('openclaw_npm_release_artifact_mismatch')

    const forgedAuthorityDependencies: GeneratorDependencies = {
      ...openclawDependencies,
      openclawReleaseAuthority: () => ({
        ...openclawAuthority,
        npmIntegrity: sha512Integrity(forgedNpmTarball),
        npmArtifactSha256: createHash('sha256').update(fs.readFileSync(forgedNpmTarball)).digest('hex'),
        npmArtifactSizeBytes: fs.statSync(forgedNpmTarball).size,
      }),
    }
    await expect(generateAgentDistributionReceipt({
      kind: 'openclaw-portable', catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:portable-wrapper',
      version: '2026.9.1', artifactPath: installer, sourceUrl: installerUrl,
      registryMetadataPath: forgedMetadata, npmTarballPath: forgedNpmTarball,
      openclawTagRefMetadataPath: tagRefMetadata, openclawTagObjectMetadataPath: tagObjectMetadata,
      openclawNodeArtifactPath: nodeArtifact, openclawNodeSourceUrl: nodeSourceUrl,
      openclawNodeShasumsPath: nodeShasums, openclawNodeShasumsSourceUrl: nodeShasumsUrl,
      outputPath: path.join(root, 'stale-dist.json'), architecture, releaseManifestPath,
    }, forgedAuthorityDependencies)).rejects.toThrow('openclaw_postinstall_inventory_does_not_match_dist')

    await expect(generateAgentDistributionReceipt({
      ...npmOptions, artifactPath: forgedNpmTarball, registryMetadataPath: forgedMetadata,
      outputPath: path.join(root, 'stale-global-inventory.json'),
    }, forgedAuthorityDependencies)).rejects.toThrow('openclaw_postinstall_inventory_does_not_match_dist')

    fs.writeFileSync(nodeShasums, `${'f'.repeat(64)}  ${path.basename(nodeArtifact)}\n`)
    await expect(generateAgentDistributionReceipt({
      kind: 'openclaw-portable', catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:portable-wrapper',
      version: '2026.9.1', artifactPath: installer, sourceUrl: installerUrl,
      registryMetadataPath: metadata, npmTarballPath: npmTarball,
      openclawTagRefMetadataPath: tagRefMetadata, openclawTagObjectMetadataPath: tagObjectMetadata,
      openclawNodeArtifactPath: nodeArtifact, openclawNodeSourceUrl: nodeSourceUrl,
      openclawNodeShasumsPath: nodeShasums, openclawNodeShasumsSourceUrl: nodeShasumsUrl,
      outputPath: path.join(root, 'bad-node-checksum.json'), architecture, releaseManifestPath,
    }, openclawDependencies)).rejects.toThrow('openclaw_node_shasums_mismatch')

    fs.writeFileSync(nodeShasums, `${nodeSha256}  ${path.basename(nodeArtifact)}\n`)
    const changedTagObject = JSON.parse(fs.readFileSync(tagObjectMetadata, 'utf8'))
    changedTagObject.object.sha = 'c'.repeat(40)
    fs.writeFileSync(tagObjectMetadata, JSON.stringify(changedTagObject))
    await expect(generateAgentDistributionReceipt({
      kind: 'openclaw-portable', catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:portable-wrapper',
      version: '2026.9.1', artifactPath: installer, sourceUrl: installerUrl,
      registryMetadataPath: metadata, npmTarballPath: npmTarball,
      openclawTagRefMetadataPath: tagRefMetadata, openclawTagObjectMetadataPath: tagObjectMetadata,
      openclawNodeArtifactPath: nodeArtifact, openclawNodeSourceUrl: nodeSourceUrl,
      openclawNodeShasumsPath: nodeShasums, openclawNodeShasumsSourceUrl: nodeShasumsUrl,
      outputPath: path.join(root, 'wrong-tag-target.json'), architecture, releaseManifestPath,
    }, openclawDependencies)).rejects.toThrow('openclaw_tag_release_metadata_mismatch')
  })

  it('rejects archive traversal and extracted symlink/hardlink escapes', async () => {
    expect(() => validateArchiveEntryNames(['package/../escape'])).toThrow('archive_entry_path_invalid')
    expect(() => validateArchiveEntryNames(['/absolute'])).toThrow('archive_entry_path_invalid')
    const root = tempRoot()
    const tree = path.join(root, 'tree')
    fs.mkdirSync(tree)
    fs.symlinkSync('../../outside', path.join(tree, 'escape'))
    await expect(readStableDistributionTree(tree)).rejects.toThrow('distribution_tree_symlink_escape')
    fs.unlinkSync(path.join(tree, 'escape'))
    fs.writeFileSync(path.join(tree, 'one'), 'x')
    fs.linkSync(path.join(tree, 'one'), path.join(tree, 'two'))
    await expect(readStableDistributionTree(tree)).rejects.toThrow('distribution_tree_hardlink_forbidden')
  })
})
