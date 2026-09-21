import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { readStableFileFingerprint } from './passive-cli-version.js'

const MAX_DISTRIBUTION_FILES = 120_000
const MAX_DISTRIBUTION_DIRECTORIES = 24_000
const MAX_DISTRIBUTION_DEPTH = 96
const MAX_DISTRIBUTION_ENTRIES_PER_DIRECTORY = 16_384
const MAX_DISTRIBUTION_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
const MAX_DISTRIBUTION_FILE_BYTES = 2 * 1024 * 1024 * 1024

interface PhysicalNode {
  absolutePath: string
  relativePath: string
  entryType: 'file' | 'symlink'
  identity: string
  symlinkTarget: string | null
}

export interface StableDistributionTree {
  sha256: string
  sizeBytes: number
  entryCount: number
}

/**
 * Version-independent lookup key for one live Kimi native code object. The
 * release receipt supplies the version only after this exact surface has one
 * and only one frozen match.
 */
export function kimiNativeReceiptLookupFingerprint(input: {
  architecture: 'arm64' | 'x64'
  executableSha256: string
  executableSizeBytes: number
  identifier: string
  teamIdentifier: string
  cdHash: string
  designatedRequirement: string
}): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'signed-cli-kimi-receipt-lookup-v1',
    architecture: input.architecture,
    executable: {
      relativePath: 'bin/kimi',
      sha256: input.executableSha256,
      sizeBytes: input.executableSizeBytes,
      executable: true,
    },
    identifier: input.identifier,
    teamIdentifier: input.teamIdentifier,
    cdHash: input.cdHash.trim().toLowerCase(),
    designatedRequirement: input.designatedRequirement.trim(),
  })).digest('hex')
}

/**
 * Cross-machine content tree for an already-extracted official distribution.
 * Paths are relative, files are descriptor-stable, symlinks must remain inside
 * the distribution, and a second exact walk closes the scan/relist race.
 */
export async function readStableDistributionTree(rootPath: string): Promise<StableDistributionTree> {
  const requestedRoot = path.resolve(rootPath)
  const requestedStat = await fs.lstat(requestedRoot, { bigint: true })
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error('distribution_tree_root_not_canonical')
  }
  const root = path.resolve(await fs.realpath(requestedRoot))
  const rootStat = await fs.lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('distribution_tree_root_not_canonical')

  const nodes: PhysicalNode[] = []
  const directories = new Map<string, string>()
  let directoryCount = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    directoryCount += 1
    if (directoryCount > MAX_DISTRIBUTION_DIRECTORIES || depth > MAX_DISTRIBUTION_DEPTH) {
      throw new Error('distribution_tree_directory_limit_exceeded')
    }
    const directoryStat = await fs.lstat(directory, { bigint: true })
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || path.resolve(await fs.realpath(directory)) !== directory) {
      throw new Error('distribution_tree_directory_not_canonical')
    }
    directories.set(directory, statIdentity(directoryStat))
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (entries.length > MAX_DISTRIBUTION_ENTRIES_PER_DIRECTORY) {
      throw new Error('distribution_tree_directory_entry_limit_exceeded')
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error('distribution_tree_special_node_forbidden')
      }
      if (nodes.length >= MAX_DISTRIBUTION_FILES) throw new Error('distribution_tree_file_limit_exceeded')
      const before = await fs.lstat(absolutePath, { bigint: true })
      if (before.nlink > 1n && before.isFile()) throw new Error('distribution_tree_hardlink_forbidden')
      if (entry.isSymbolicLink() !== before.isSymbolicLink()
        || entry.isFile() !== before.isFile()) throw new Error('distribution_tree_node_changed')
      let symlinkTarget: string | null = null
      if (before.isSymbolicLink()) {
        const rawTarget = await fs.readlink(absolutePath)
        if (path.isAbsolute(rawTarget)) throw new Error('distribution_tree_absolute_symlink_forbidden')
        const resolved = path.resolve(path.dirname(absolutePath), rawTarget)
        if (!isWithinOrEqual(root, resolved)) throw new Error('distribution_tree_symlink_escape')
        await fs.lstat(resolved)
        symlinkTarget = path.relative(path.dirname(absolutePath), resolved).split(path.sep).join('/')
      }
      const after = await fs.lstat(absolutePath, { bigint: true })
      if (statIdentity(before) !== statIdentity(after)
        || (symlinkTarget !== null
          && path.relative(path.dirname(absolutePath), path.resolve(path.dirname(absolutePath), await fs.readlink(absolutePath)))
            .split(path.sep).join('/') !== symlinkTarget)) {
        throw new Error('distribution_tree_node_changed')
      }
      nodes.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
        entryType: before.isSymbolicLink() ? 'symlink' : 'file',
        identity: statIdentity(before),
        symlinkTarget,
      })
    }
  }
  await visit(root, 0)
  nodes.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  if (nodes.length === 0) throw new Error('distribution_tree_empty')

  const portableNodes = []
  let sizeBytes = 0
  for (const node of nodes) {
    if (node.entryType === 'symlink') {
      const bytes = Buffer.from(node.symlinkTarget!, 'utf8')
      sizeBytes += bytes.length
      portableNodes.push({
        relativePath: node.relativePath,
        entryType: node.entryType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        executable: false,
        symlinkTarget: node.symlinkTarget,
      })
      continue
    }
    const fingerprint = await readStableFileFingerprint(node.absolutePath, MAX_DISTRIBUTION_FILE_BYTES)
    if (fingerprint.fingerprint.length === 0) throw new Error('distribution_tree_file_unproven')
    sizeBytes += fingerprint.size
    portableNodes.push({
      relativePath: node.relativePath,
      entryType: node.entryType,
      sha256: fingerprint.sha256,
      sizeBytes: fingerprint.size,
      executable: fingerprint.executable,
      symlinkTarget: null,
    })
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_DISTRIBUTION_TOTAL_BYTES) {
    throw new Error('distribution_tree_size_limit_exceeded')
  }

  const observedNodes: string[] = []
  const verify = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DISTRIBUTION_DEPTH) throw new Error('distribution_tree_changed')
    const stat = await fs.lstat(directory, { bigint: true })
    if (directories.get(directory) !== statIdentity(stat)) throw new Error('distribution_tree_changed')
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) await verify(absolutePath, depth + 1)
      else observedNodes.push(path.relative(root, absolutePath).split(path.sep).join('/'))
    }
  }
  await verify(root, 0)
  observedNodes.sort((left, right) => left.localeCompare(right))
  if (JSON.stringify(observedNodes) !== JSON.stringify(nodes.map(node => node.relativePath))) {
    throw new Error('distribution_tree_changed')
  }
  for (const node of nodes) {
    const current = await fs.lstat(node.absolutePath, { bigint: true })
    if (statIdentity(current) !== node.identity) throw new Error('distribution_tree_changed')
    if (node.symlinkTarget !== null) {
      const target = path.relative(
        path.dirname(node.absolutePath),
        path.resolve(path.dirname(node.absolutePath), await fs.readlink(node.absolutePath)),
      ).split(path.sep).join('/')
      if (target !== node.symlinkTarget) throw new Error('distribution_tree_changed')
    }
  }
  return {
    sha256: createHash('sha256').update(JSON.stringify({
      schema: 'official-distribution-tree-v1',
      entries: portableNodes,
    })).digest('hex'),
    sizeBytes,
    entryCount: portableNodes.length,
  }
}

function statIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs, stat.uid, stat.gid].join(':')
}

function isWithinOrEqual(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
