#!/usr/bin/env node
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  codeMarkerCount,
  parseSourceAgentIntegrationReleaseContract,
  uniqueCodeMarkerIndex,
  uniqueFunctionBody,
} from './agent-integration-release-contract.mjs'
import {
  TIDEMIND_RELEASE_TEAM_ID,
  inspectPhysicalTideMindCandidateApp,
} from './tidemind-candidate-app-identity.mjs'
import { assertAcceptedReleaseCandidate } from './verify-agent-host-release-artifacts.mjs'
import { validateCandidateArchiveEntries } from './agent-host-candidate-transfer.mjs'

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

/**
 * Inspect the actual Electron main bundle stored in app.asar. The release
 * manifest is code, not a mutable runtime file, so this deliberately parses
 * the stable non-minified Rollup projection without evaluating the Electron
 * entry point or trusting source-tree files outside the signed app.
 */
export function inspectPackagedAgentIntegrationReleaseManifest(source, expectedContract) {
  const packagedContract = parseSourceAgentIntegrationReleaseContract(source)
  const { version, schemaVersion, entries } = packagedContract
  if (version !== expectedContract.version) {
    throw new Error(`packaged Agent release manifest version ${version} does not match app ${expectedContract.version}`)
  }
  if (schemaVersion !== expectedContract.schemaVersion) {
    throw new Error(
      `packaged Agent release manifest schema ${schemaVersion} does not match source schema ${expectedContract.schemaVersion}`,
    )
  }

  const defaultEntries = entries.filter(entry => entry.enabledByDefault)
  if (defaultEntries.length === 0) {
    throw new Error('packaged Agent release manifest has zero default-enabled entries')
  }
  if (new Set(entries.map(entry => entry.catalogId)).size !== entries.length) {
    throw new Error('packaged Agent release manifest has duplicate default-enabled entries')
  }
  if (JSON.stringify(packagedContract) !== JSON.stringify(expectedContract)) {
    throw new Error('packaged Agent release manifest differs from the source release contract')
  }
  const productionComposition = uniqueFunctionBody(
    source,
    'function createProductionAgentIntegrationComposition(',
    'production Agent integration composition',
  )
  uniqueCodeMarkerIndex(
    productionComposition,
    'const releasePolicy = resolveAgentIntegrationReleasePolicy({',
    'production release-policy binding',
  )
  for (const [marker, label] of [
    ['releasePolicy.mode !==', 'production observe-only derivation'],
    ['&& releasePolicy.customLocalAgentEnabled', 'production Custom Agent gate'],
    ['...releasePolicy.enabledAdapterIds,', 'production Adapter allowlist'],
    ['autoRestore: releasePolicy.autoRestore,', 'production auto-restore gate'],
    ['releasePolicyMode: releasePolicy.mode,', 'production policy result binding'],
    ['releasePolicyDiagnostics: releasePolicy.diagnostics', 'production policy diagnostics binding'],
  ]) {
    uniqueCodeMarkerIndex(productionComposition, marker, label)
  }
  if (codeMarkerCount(productionComposition, 'legacyEnvironmentGate(') > 0) {
    throw new Error('packaged production Agent integration composition contains a legacy policy bypass')
  }

  return Object.freeze({ version, schemaVersion, entryCount: entries.length, defaultEntryCount: defaultEntries.length })
}

export function assertAgentIntegrationReleaseAcceptance(contract) {
  const blocked = contract.entries.filter(entry => (
    entry.releaseMode === 'production'
    && (entry.releaseAcceptedExactVersions.length === 0
      || entry.releaseAcceptedExactVersions.some(version => !entry.observedExactVersions.includes(version))
      || entry.releaseAcceptedExactVersions.some(version => entry.officialDistributions.some(distribution => (
        distribution.supportedMacArchitectures.some(architecture => !entry.acceptedDistributionArtifacts.some(receipt => (
          receipt.version === version
          && receipt.architecture === architecture
          && receipt.distributionId === distribution.distributionId
          && receipt.packageProvenance === distribution.packageProvenance
        )))
      ))))
  ))
  if (blocked.length > 0) {
    throw new Error(
      `Agent release acceptance is incomplete for production entries: ${blocked.map(entry => entry.catalogId).join(', ')}`,
    )
  }
}

export const AGENT_RUNTIME_BUNDLES = Object.freeze([
  'agent-host-activity-export.cjs',
  'hook-session-start.cjs',
  'hook-kimi-session-start-activity.cjs',
  'hook-pre-compact.cjs',
  'hook-post-compact.cjs',
  'hook-session-end.cjs',
  'hook-cursor-lifecycle.cjs',
  'hook-windsurf-lifecycle.cjs',
  'hook-pi-lifecycle.cjs',
  'hook-openclaw-lifecycle.cjs',
  'hook-qwenwork-lifecycle.cjs',
  'mcp-server.cjs',
  'structure-holes-worker.cjs',
  'metabolism-worker.cjs',
])

function extractPackagedMainBundle(archivePath) {
  const clientRequire = createRequire(path.resolve('client/package.json'))
  let asar
  try {
    asar = clientRequire('@electron/asar')
  } catch (error) {
    throw new Error(`cannot load packaged-app ASAR reader: ${error.message}`)
  }
  try {
    return Buffer.from(asar.extractFile(archivePath, 'out/main/index.js')).toString('utf8')
  } catch (error) {
    throw new Error(`packaged app cannot read out/main/index.js from app.asar: ${error.message}`)
  }
}

function main() {
const releaseDir = fs.realpathSync(path.resolve(argument('--release-dir', 'client/release')))
const arch = argument('--arch')
if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64')
const runtimeAssetsOnly = process.argv.includes('--runtime-assets-only')
const privateRcCandidate = process.argv.includes('--private-rc-candidate')
if (runtimeAssetsOnly && privateRcCandidate) {
  throw new Error('--runtime-assets-only and --private-rc-candidate are mutually exclusive')
}
const sourceCommit = argument('--source-commit')
const receiptPath = argument('--receipt')
const acceptanceIndexPath = argument('--acceptance-index')
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
const app = argument('--app') ?? appCandidates.find((candidate) => {
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
const appAsar = path.join(resources, 'app.asar')
requireNonEmptyFile(appAsar, 'app.asar')
const sourceAgentManifest = parseSourceAgentIntegrationReleaseContract(fs.readFileSync(
  path.resolve('client/electron/agent-integration/release-manifest.ts'),
  'utf8',
))
if (sourceAgentManifest.version !== version) {
  throw new Error(`source Agent release manifest version ${sourceAgentManifest.version} does not match app ${version}`)
}
// A private RC is the input to real-host acceptance, so it cannot already be
// bound to that acceptance index. Formal release verification keeps the
// stronger accepted-version/artifact-matrix gate below.
if (!privateRcCandidate) assertAgentIntegrationReleaseAcceptance(sourceAgentManifest)
const packagedAgentManifest = inspectPackagedAgentIntegrationReleaseManifest(
  extractPackagedMainBundle(appAsar),
  sourceAgentManifest,
)
const unpackedRoot = path.join(resources, 'app.asar.unpacked')
for (const bundle of AGENT_RUNTIME_BUNDLES) {
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
  process.stdout.write(`verified unsigned ${arch} Agent runtime assets, Agent release manifest (${packagedAgentManifest.defaultEntryCount} default entries), and ${nativeFiles.length} native files; signing/notarization not checked\n`)
} else {
  if (!/^[a-f0-9]{40,64}$/u.test(sourceCommit ?? '')) {
    throw new Error('--source-commit must bind the signed package to an exact private source commit')
  }
  if (!receiptPath) throw new Error('--receipt is required for signed release verification')
  if (!fs.existsSync(path.join(app, 'Contents/embedded.provisionprofile'))) {
    throw new Error('packaged app is missing embedded.provisionprofile')
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const signatureDetails = spawnSync('/usr/bin/codesign', ['-dvvv', app], { encoding: 'utf8' })
  if (signatureDetails.status !== 0) throw new Error('cannot inspect packaged Tide Mind signing identity')
  const signatureOutput = `${signatureDetails.stdout ?? ''}\n${signatureDetails.stderr ?? ''}`
  const packagedTeamId = signatureOutput.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim()
  const packagedAuthority = signatureOutput.match(/^Authority=(.+)$/mu)?.[1]?.trim()
  if (packagedTeamId !== TIDEMIND_RELEASE_TEAM_ID
    || !packagedAuthority?.startsWith('Developer ID Application:')
    || !packagedAuthority.includes(`(${TIDEMIND_RELEASE_TEAM_ID})`)) {
    throw new Error(`packaged Tide Mind signing identity is not the expected Developer ID Team ${TIDEMIND_RELEASE_TEAM_ID}`)
  }
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

  if (privateRcCandidate && acceptanceIndexPath) {
    throw new Error('--private-rc-candidate cannot consume a real-host acceptance index')
  }
  if (!privateRcCandidate && !acceptanceIndexPath) {
    throw new Error('--acceptance-index is required for signed release verification')
  }
  const acceptanceIndex = acceptanceIndexPath
    ? JSON.parse(fs.readFileSync(acceptanceIndexPath, 'utf8'))
    : null
  const candidate = inspectPhysicalTideMindCandidateApp(app, version, sourceCommit, arch)
  if (!privateRcCandidate) {
    assertAcceptedReleaseCandidate(acceptanceIndex, candidate, arch, version, sourceCommit)
  }
  const assertSameCandidate = (containerCandidate, label) => {
    for (const key of ['version', 'sourceCommit', 'bundleSha256', 'executableSha256', 'teamId', 'signingIdentity', 'cdhash']) {
      if (containerCandidate[key] !== candidate[key]) {
        throw new Error(`${label} ${key} differs from the verified private RC app`)
      }
    }
  }
  // Inspect the apps actually contained in each final distribution container.
  // A valid adjacent .app cannot vouch for a stale or substituted DMG/ZIP.
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-release-containers-'))
  const mounted = path.join(extracted, 'dmg')
  let attached = false
  try {
    fs.mkdirSync(mounted)
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mounted, dmg])
    attached = true
    const dmgCandidate = inspectPhysicalTideMindCandidateApp(path.join(mounted, 'Tide Mind.app'), version, sourceCommit, arch)
    if (privateRcCandidate) assertSameCandidate(dmgCandidate, 'DMG candidate')
    else assertAcceptedReleaseCandidate(acceptanceIndex, dmgCandidate, arch, version, sourceCommit)
    const zip = path.join(releaseDir, `Tide.Mind-${version}-${arch}.zip`)
    const entries = run('/usr/bin/unzip', ['-Z1', zip]).split(/\r?\n/u).filter(Boolean)
    validateCandidateArchiveEntries(entries)
    const zipRoot = path.join(extracted, 'zip')
    fs.mkdirSync(zipRoot)
    run('/usr/bin/ditto', ['-x', '-k', zip, zipRoot])
    const zipCandidate = inspectPhysicalTideMindCandidateApp(path.join(zipRoot, 'Tide Mind.app'), version, sourceCommit, arch)
    if (privateRcCandidate) assertSameCandidate(zipCandidate, 'ZIP candidate')
    else assertAcceptedReleaseCandidate(acceptanceIndex, zipCandidate, arch, version, sourceCommit)
  } finally {
    if (attached) run('/usr/bin/hdiutil', ['detach', mounted])
    fs.rmSync(extracted, { recursive: true, force: true })
  }
  const artifactSha256 = Object.fromEntries(['dmg', 'zip'].map(extension => {
    const artifact = path.join(releaseDir, `Tide.Mind-${version}-${arch}.${extension}`)
    return [extension, crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')]
  }))
  const receipt = {
    schemaVersion: 1,
    ...(privateRcCandidate ? { verificationClass: 'private_rc_candidate' } : {}),
    sourceCommit,
    appVersion: version,
    architecture: arch,
    candidateBundleSha256: candidate.bundleSha256,
    executableSha256: candidate.executableSha256,
    teamId: candidate.teamId,
    signingIdentity: candidate.signingIdentity,
    cdhash: candidate.cdhash,
    dmgSha256: artifactSha256.dmg,
    zipSha256: artifactSha256.zip,
    verifiedAt: new Date().toISOString(),
  }
  const resolvedReceipt = path.resolve(receiptPath)
  fs.mkdirSync(path.dirname(resolvedReceipt), { recursive: true })
  fs.writeFileSync(resolvedReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })

  const verificationClass = privateRcCandidate ? 'private RC' : 'accepted release'
  process.stdout.write(`verified signed/notarized ${arch} ${verificationClass} app, DMG, ZIP, Agent release manifest (${packagedAgentManifest.defaultEntryCount} default entries), and ${nativeFiles.length} native files\n`)
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
