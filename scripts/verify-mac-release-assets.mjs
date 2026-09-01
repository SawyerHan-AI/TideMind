#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const releaseDir = fs.realpathSync(path.resolve(argument('--release-dir', 'client/release')))
const arch = argument('--arch')
if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64')
const runtimeAssetsOnly = process.argv.includes('--runtime-assets-only')
const version = JSON.parse(fs.readFileSync('client/package.json', 'utf8')).version
const expectedMachArch = arch === 'x64' ? 'x86_64' : 'arm64'

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function walk(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...walk(target))
    else if (entry.isFile()) result.push(target)
  }
  return result
}

function requireNonEmptyFile(target, label) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size === 0) {
    throw new Error(`packaged app is missing ${label}: ${target}`)
  }
}

function requireContainedRuntimeResolution(runtimeRequire, unpackedRoot, specifier, label) {
  let resolved
  try {
    resolved = runtimeRequire.resolve(specifier)
  } catch (error) {
    throw new Error(`packaged app cannot resolve ${label} (${specifier}) from Agent runtime: ${error.message}`)
  }
  requireNonEmptyFile(resolved, label)
  const relative = path.relative(unpackedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`packaged ${label} resolved outside app.asar.unpacked: ${resolved}`)
  }
  return resolved
}

const appCandidates = fs.readdirSync(releaseDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
  .map((entry) => path.join(releaseDir, entry.name, 'Tide Mind.app'))
  .filter((candidate) => fs.existsSync(candidate))
const app = appCandidates.find((candidate) => {
  const executable = path.join(candidate, 'Contents/MacOS/Tide Mind')
  return fs.existsSync(executable) && run('/usr/bin/file', [executable]).includes(expectedMachArch)
})
if (!app) throw new Error(`missing ${arch} Tide Mind.app in ${releaseDir}`)

const executable = path.join(app, 'Contents/MacOS/Tide Mind')
const resources = path.join(app, 'Contents/Resources')
const executableArchitectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/)
if (!executableArchitectures.includes(expectedMachArch)) {
  throw new Error(`main executable architecture mismatch: ${executableArchitectures.join(', ')}`)
}
// External Agents start these bundles through a real OS path. Electron's ASAR
// virtual filesystem is not available to /bin/sh or ELECTRON_RUN_AS_NODE, so a
// signed app is not releasable unless the complete runtime chain is present in
// app.asar.unpacked. This is deliberately checked before any host Adapter gate
// may use the package as evidence.
requireNonEmptyFile(path.join(resources, 'app.asar'), 'app.asar')
const unpackedRoot = path.join(resources, 'app.asar.unpacked')
const agentRuntimeBundles = [
  'hook-session-start.cjs',
  'hook-pre-compact.cjs',
  'hook-post-compact.cjs',
  'mcp-server.cjs',
  'structure-holes-worker.cjs',
  'metabolism-worker.cjs',
]
for (const bundle of agentRuntimeBundles) {
  requireNonEmptyFile(path.join(unpackedRoot, 'out', 'bin', bundle), `Agent runtime bundle ${bundle}`)
}

// Resolve from the same real OS location used by tm-node/ELECTRON_RUN_AS_NODE.
// Checking a few leaf filenames is insufficient: Node first needs each package
// manifest and main/exports entry before better-sqlite3 or sqlite-vec can reach
// its native binary.
const runtimeRequire = createRequire(path.join(unpackedRoot, 'out', 'bin', 'mcp-server.cjs'))
requireContainedRuntimeResolution(runtimeRequire, unpackedRoot, 'better-sqlite3', 'better-sqlite3 JavaScript entry')
requireContainedRuntimeResolution(runtimeRequire, unpackedRoot, 'bindings', 'bindings runtime')
requireContainedRuntimeResolution(runtimeRequire, unpackedRoot, 'file-uri-to-path', 'file-uri-to-path runtime')
requireContainedRuntimeResolution(runtimeRequire, unpackedRoot, 'sqlite-vec', 'sqlite-vec JavaScript entry')
const sqliteVecNative = requireContainedRuntimeResolution(
  runtimeRequire,
  unpackedRoot,
  `sqlite-vec-darwin-${arch}/vec0.dylib`,
  `sqlite-vec darwin-${arch} native runtime`,
)
const betterSqliteNative = path.join(
  unpackedRoot,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
)
requireNonEmptyFile(betterSqliteNative, 'better-sqlite3 native runtime')

const nativeFiles = walk(resources)
  .filter((file) => file.endsWith('.node') || file.endsWith('.dylib'))
if (nativeFiles.length === 0) throw new Error('packaged app contains no native modules')
const requiredNativeNames = ['better_sqlite3.node', 'secure-store-mac.node', 'vec0.dylib']
for (const requiredName of requiredNativeNames) {
  if (!nativeFiles.some((file) => path.basename(file) === requiredName)) {
    throw new Error(`packaged app is missing required native module ${requiredName}`)
  }
}
if (!nativeFiles.includes(betterSqliteNative) || !nativeFiles.includes(sqliteVecNative)) {
  throw new Error('packaged Agent runtime native dependency is outside the verified native file set')
}
for (const nativeFile of nativeFiles) {
  const description = run('/usr/bin/file', [nativeFile]).trim()
  if (!description.includes(expectedMachArch)) {
    throw new Error(`native architecture mismatch for ${nativeFile}: ${description}`)
  }
}

if (runtimeAssetsOnly) {
  process.stdout.write(`verified unsigned ${arch} Agent runtime assets and ${nativeFiles.length} native files; signing/notarization not checked\n`)
} else {
  if (!fs.existsSync(path.join(app, 'Contents/embedded.provisionprofile'))) {
    throw new Error('packaged app is missing embedded.provisionprofile')
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  run('/usr/sbin/spctl', ['--assess', '--type', 'exec', '--verbose=2', app])
  run('/usr/bin/xcrun', ['stapler', 'validate', app])

  for (const extension of ['dmg', 'zip']) {
    const artifact = path.join(releaseDir, `Tide.Mind-${version}-${arch}.${extension}`)
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile() || fs.statSync(artifact).size === 0) {
      throw new Error(`missing release artifact ${artifact}`)
    }
  }
  const dmg = path.join(releaseDir, `Tide.Mind-${version}-${arch}.dmg`)
  run('/usr/bin/xcrun', ['stapler', 'validate', dmg])
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg])

  process.stdout.write(`verified signed/notarized ${arch} app, DMG, ZIP and ${nativeFiles.length} native files\n`)
}
