import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SOURCE_ROOTS = [
  '.github/workflows/ci.yml',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'client/package.json',
  'client/package-lock.json',
  'client/electron-builder.yml',
  'client/electron.vite.config.ts',
  'client/index.html',
  'client/postcss.config.js',
  'client/tailwind.config.ts',
  'client/tsconfig.json',
  'client/tsconfig.node.json',
  'client/tsconfig.web.json',
  'scripts',
  'src',
  // electron-vite copies `public` verbatim and electron-builder consumes
  // `resources` plus the repository data bundle. They are source inputs, not
  // build outputs, so hidden content/mode/symlink drift must be compared with
  // the exact commit tree just like renderer and main-process source.
  'client/public',
  'client/resources',
  'data',
  'client/scripts',
  'client/electron',
  'client/src',
]

// `npm ci` rebuilds the local secure-store package inside its tracked source
// directory. These are dependency/build products, not commit-owned source
// shadows. Keep the exclusions exact and bind the runtime binary directory as
// a build root instead of silently omitting it from provenance.
const SOURCE_EXCLUDED_ROOTS = [
  'client/electron/native/secure-store-mac/bin',
  'client/electron/native/secure-store-mac/build',
  'client/electron/native/secure-store-mac/node_modules',
]

const BUILD_ROOTS = [
  'dist',
  'client/out',
  'client/electron/native/secure-store-mac/build',
]
const PROVENANCE_PROTOCOL_VERSION = 3
const BUILD_ENV_DIRECTORIES = ['', 'client']

function command(commandName, args, cwd, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${commandName} ${args.join(' ')} failed: ${String(result.stderr || result.stdout)}`)
  }
  return result.stdout
}

function commandOutput(commandName, args, cwd) {
  return String(command(commandName, args, cwd)).trim()
}

function normalizedRelative(repoRoot, absolute) {
  return path.relative(repoRoot, absolute).split(path.sep).join('/')
}

function normalizedExecutableMode(stat) {
  return (stat.mode & 0o111) === 0 ? '100644' : '100755'
}

function assertNoBuildEnvironmentFiles(repoRoot) {
  for (const relativeDirectory of BUILD_ENV_DIRECTORIES) {
    const directory = path.join(repoRoot, relativeDirectory)
    if (!fs.existsSync(directory)) continue
    for (const name of fs.readdirSync(directory).sort()) {
      if (name !== '.env' && !name.startsWith('.env.')) continue
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name
      // Vite loads these files implicitly and `.gitignore` intentionally hides
      // them. A clean Git status therefore cannot prove that the build came
      // only from the selected commit. CI gate builds use explicit workflow
      // environment instead; any filesystem env input is refused wholesale.
      throw new Error(`Agent Integration gate refuses implicit build environment file: ${relative}`)
    }
  }
}

function collectRegularFiles(repoRoot, roots, excludedRoots = []) {
  const files = []
  const excluded = excludedRoots.map(root => path.resolve(repoRoot, root))
  const isExcluded = absolute => excluded.some(root => absolute === root || absolute.startsWith(`${root}${path.sep}`))
  const visit = absolute => {
    if (isExcluded(absolute)) return
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`gate provenance refuses symlink: ${absolute}`)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name))
      return
    }
    if (!stat.isFile()) throw new Error(`gate provenance requires a regular file: ${absolute}`)
    files.push(absolute)
  }
  for (const root of roots) {
    const absolute = path.join(repoRoot, root)
    if (!fs.existsSync(absolute)) throw new Error(`gate provenance input is missing: ${root}`)
    visit(absolute)
  }
  return files.sort((left, right) => normalizedRelative(repoRoot, left).localeCompare(normalizedRelative(repoRoot, right)))
}

function physicalManifest(repoRoot, roots, excludedRoots = []) {
  const files = collectRegularFiles(repoRoot, roots, excludedRoots)
  const hash = crypto.createHash('sha256')
  for (const absolute of files) {
    const relative = normalizedRelative(repoRoot, absolute)
    const mode = normalizedExecutableMode(fs.lstatSync(absolute))
    const contentHash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
    hash.update(relative).update('\0').update(mode).update('\0').update(contentHash).update('\n')
  }
  return { fileCount: files.length, sha256: hash.digest('hex') }
}

function trackedSourceEntries(repoRoot, sourceCommit, roots) {
  const output = command('git', ['ls-tree', '-rz', '--full-tree', sourceCommit, '--', ...roots], repoRoot, {
    encoding: 'buffer',
  })
  const entries = []
  for (const raw of output.toString('utf8').split('\0')) {
    if (!raw) continue
    const match = /^(\d+) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/u.exec(raw)
    if (!match) throw new Error('Agent Integration source tree contains an unreadable entry')
    const [, mode, type, objectId, relative] = match
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`Agent Integration source tree refuses ${type}/${mode}: ${relative}`)
    }
    if (/\r|\n|\0/u.test(relative)) {
      throw new Error(`Agent Integration source tree refuses control characters: ${JSON.stringify(relative)}`)
    }
    entries.push({ mode, objectId, relative })
  }
  entries.sort((left, right) => left.relative.localeCompare(right.relative))
  if (entries.length === 0) throw new Error('Agent Integration source tree is empty')
  return entries
}

function assertExactTrackedSource(repoRoot, sourceCommit, roots, excludedRoots = []) {
  const tracked = trackedSourceEntries(repoRoot, sourceCommit, roots)
  const physical = collectRegularFiles(repoRoot, roots, excludedRoots).map(absolute => ({
    relative: normalizedRelative(repoRoot, absolute),
    mode: normalizedExecutableMode(fs.lstatSync(absolute)),
  }))
  const physicalPaths = physical.map(entry => entry.relative)
  const trackedPaths = tracked.map(entry => entry.relative)
  if (JSON.stringify(physicalPaths) !== JSON.stringify(trackedPaths)) {
    const trackedSet = new Set(trackedPaths)
    const physicalSet = new Set(physicalPaths)
    const shadow = physicalPaths.filter(relative => !trackedSet.has(relative))
    const missing = trackedPaths.filter(relative => !physicalSet.has(relative))
    throw new Error(`Agent Integration source roots differ from the exact commit tree; shadow=${shadow.join(',') || 'none'} missing=${missing.join(',') || 'none'}`)
  }

  for (let index = 0; index < tracked.length; index += 1) {
    if (physical[index].mode !== tracked[index].mode) {
      throw new Error(`Agent Integration tracked source mode drifted from ${sourceCommit}: ${tracked[index].relative}; expected ${tracked[index].mode}, got ${physical[index].mode}`)
    }
  }

  const worktreeObjectIds = String(command(
    'git',
    ['hash-object', '--stdin-paths'],
    repoRoot,
    { input: `${trackedPaths.join('\n')}\n` },
  )).trim().split('\n')
  if (worktreeObjectIds.length !== tracked.length) {
    throw new Error('Agent Integration source hash count differs from the exact commit tree')
  }
  for (let index = 0; index < tracked.length; index += 1) {
    if (worktreeObjectIds[index] !== tracked[index].objectId) {
      throw new Error(`Agent Integration tracked source drifted from ${sourceCommit}: ${tracked[index].relative}`)
    }
  }

  const hash = crypto.createHash('sha256')
  for (const entry of tracked) {
    hash.update(entry.relative).update('\0').update(entry.mode).update('\0').update(entry.objectId).update('\n')
  }
  return { fileCount: tracked.length, sha256: hash.digest('hex') }
}

function sourceCommitAt(repoRoot, expectedCommit) {
  const sourceCommit = commandOutput('git', ['rev-parse', 'HEAD'], repoRoot)
  if (!/^[a-f0-9]{40,64}$/u.test(sourceCommit)) throw new Error(`invalid git commit: ${sourceCommit}`)
  if (expectedCommit !== null && sourceCommit !== expectedCommit) {
    throw new Error(`Agent Integration gate HEAD mismatch: expected ${expectedCommit}, got ${sourceCommit}`)
  }
  return sourceCommit
}

export function verifyAgentIntegrationExactSource({
  repoRoot,
  expectedCommit,
  sourceRoots = SOURCE_ROOTS,
  sourceExcludedRoots = SOURCE_EXCLUDED_ROOTS,
}) {
  assertNoBuildEnvironmentFiles(repoRoot)
  if (typeof expectedCommit !== 'string' || !/^[a-f0-9]{40,64}$/u.test(expectedCommit)) {
    throw new Error('Agent Integration exact-source verification requires an expected commit')
  }
  const sourceCommit = sourceCommitAt(repoRoot, expectedCommit)
  const worktreeStatus = commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot)
  if (worktreeStatus) {
    throw new Error(`Agent Integration gate requires a clean exact checkout:\n${worktreeStatus}`)
  }
  const source = assertExactTrackedSource(repoRoot, sourceCommit, sourceRoots, sourceExcludedRoots)
  return {
    protocolVersion: PROVENANCE_PROTOCOL_VERSION,
    sourceCommit,
    sourceAuthority: 'git-head-tree',
    sourceManifestSha256: source.sha256,
    sourceFileCount: source.fileCount,
  }
}

export function captureAgentIntegrationGateProvenance({
  repoRoot,
  expectedCommit = null,
  requireClean = expectedCommit !== null,
  sourceRoots = SOURCE_ROOTS,
  sourceExcludedRoots = SOURCE_EXCLUDED_ROOTS,
  buildRoots = BUILD_ROOTS,
}) {
  assertNoBuildEnvironmentFiles(repoRoot)
  const sourceCommit = sourceCommitAt(repoRoot, expectedCommit)
  const worktreeStatus = commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot)
  if (requireClean && worktreeStatus) {
    throw new Error(`Agent Integration gate requires a clean exact checkout:\n${worktreeStatus}`)
  }
  const source = requireClean
    ? assertExactTrackedSource(repoRoot, sourceCommit, sourceRoots, sourceExcludedRoots)
    : physicalManifest(repoRoot, sourceRoots, sourceExcludedRoots)
  const build = physicalManifest(repoRoot, buildRoots)
  return {
    protocolVersion: PROVENANCE_PROTOCOL_VERSION,
    sourceCommit,
    sourceAuthority: requireClean ? 'git-head-tree' : 'worktree-snapshot',
    worktreeClean: worktreeStatus.length === 0,
    sourceManifestSha256: source.sha256,
    sourceFileCount: source.fileCount,
    buildManifestSha256: build.sha256,
    buildFileCount: build.fileCount,
  }
}

export function validateAgentIntegrationGateProvenance(receipt, expected) {
  const failures = []
  if (receipt?.protocolVersion !== PROVENANCE_PROTOCOL_VERSION) failures.push('provenance protocol version')
  if (receipt?.sourceAuthority !== 'git-head-tree' && receipt?.sourceAuthority !== 'worktree-snapshot') {
    failures.push('provenance source authority')
  }
  for (const field of [
    'sourceCommit',
    'sourceAuthority',
    'worktreeClean',
    'sourceManifestSha256',
    'sourceFileCount',
    'buildManifestSha256',
    'buildFileCount',
  ]) {
    if (receipt?.[field] !== expected?.[field]) failures.push(`provenance ${field}`)
  }
  if (!/^[a-f0-9]{64}$/u.test(receipt?.sourceManifestSha256 ?? '')) failures.push('source manifest digest')
  if (!/^[a-f0-9]{64}$/u.test(receipt?.buildManifestSha256 ?? '')) failures.push('build manifest digest')
  if (!Number.isSafeInteger(receipt?.sourceFileCount) || receipt.sourceFileCount <= 0) {
    failures.push('source manifest file count')
  }
  if (!Number.isSafeInteger(receipt?.buildFileCount) || receipt.buildFileCount <= 0) {
    failures.push('build manifest file count')
  }
  return [...new Set(failures)]
}

export function sameAgentIntegrationGateProvenance(left, right) {
  return validateAgentIntegrationGateProvenance(left, right).length === 0
    && validateAgentIntegrationGateProvenance(right, left).length === 0
}
