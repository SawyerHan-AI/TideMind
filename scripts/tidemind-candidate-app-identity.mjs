import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TIDEMIND_RELEASE_BUNDLE_ID = 'com.tidemind.app'
export const TIDEMIND_RELEASE_TEAM_ID = 'Z4U232GXH5'

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function bundleEntries(root, current = root) {
  const entries = []
  for (const name of fs.readdirSync(current).sort()) {
    const absolute = path.join(current, name)
    const stat = fs.lstatSync(absolute)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const mode = stat.mode & 0o777
    if (stat.isDirectory()) entries.push({ relative, type: 'directory', mode, bytes: Buffer.alloc(0) }, ...bundleEntries(root, absolute))
    else if (stat.isFile()) entries.push({ relative, type: 'file', mode, bytes: fs.readFileSync(absolute) })
    else if (stat.isSymbolicLink()) entries.push({ relative, type: 'symlink', mode, bytes: Buffer.from(fs.readlinkSync(absolute)) })
    else throw new Error(`candidate app contains unsupported filesystem entry: ${relative}`)
  }
  return entries
}

/** Stable physical tree digest; it hashes paths, entry types, symlink targets and file bytes. */
export function hashPhysicalAppBundle(appPath) {
  const requested = path.resolve(appPath)
  const stat = fs.lstatSync(requested)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('candidate app must be a real, non-symlink directory')
  }
  const root = fs.realpathSync(requested)
  const hash = crypto.createHash('sha256')
  for (const entry of bundleEntries(root)) {
    hash.update(entry.relative).update('\0').update(entry.type).update('\0').update(String(entry.mode)).update('\0')
    hash.update(String(entry.bytes.length)).update('\0').update(entry.bytes).update('\0')
  }
  return hash.digest('hex')
}

export function inspectPhysicalTideMindCandidateApp(appPath, expectedVersion, expectedSourceCommit, expectedArchitecture) {
  if (process.platform !== 'darwin') throw new Error('physical Tide Mind candidate verification requires macOS')
  const app = path.resolve(appPath)
  if (!app.endsWith('.app')) throw new Error('candidate app path must identify an .app bundle')
  const infoPlist = path.join(app, 'Contents', 'Info.plist')
  const version = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist])
  const bundleId = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist])
  const executableName = run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', infoPlist])
  if (version !== expectedVersion) throw new Error(`candidate app version ${version} does not match ${expectedVersion}`)
  if (bundleId !== TIDEMIND_RELEASE_BUNDLE_ID) throw new Error(`candidate app bundle ID ${bundleId} is not Tide Mind`)
  const provenancePath = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'bin', 'build-provenance.json')
  const provenanceStat = fs.lstatSync(provenancePath)
  if (provenanceStat.isSymbolicLink() || !provenanceStat.isFile()) {
    throw new Error('candidate app build provenance is not a regular file')
  }
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
  if (JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(['appVersion', 'schemaVersion', 'sourceCommit'])) {
    throw new Error('candidate app build provenance shape is invalid')
  }
  if (provenance.schemaVersion !== 1 || provenance.appVersion !== expectedVersion
    || provenance.sourceCommit !== expectedSourceCommit) {
    throw new Error('candidate app build provenance does not match the exact source commit and version')
  }
  const executable = path.join(app, 'Contents', 'MacOS', executableName)
  const executableStat = fs.lstatSync(executable)
  if (executableStat.isSymbolicLink() || !executableStat.isFile()) throw new Error('candidate app executable is not a regular file')
  if (expectedArchitecture) {
    const expectedMachArchitecture = expectedArchitecture === 'x64' ? 'x86_64' : expectedArchitecture
    const executableArchitectures = run('/usr/bin/lipo', ['-archs', executable]).split(/\s+/u)
    if (executableArchitectures.length !== 1 || executableArchitectures[0] !== expectedMachArchitecture) {
      throw new Error(`candidate app executable is not the exact ${expectedArchitecture} architecture`)
    }
  }
  const bundleSha256BeforeVerification = hashPhysicalAppBundle(app)
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'pipe' })
  const details = spawnSync('/usr/bin/codesign', ['-dvvv', app], { encoding: 'utf8' })
  if (details.status !== 0) throw new Error(`cannot inspect candidate app signature: ${details.stderr || details.stdout}`)
  // codesign writes display output to stderr.
  const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`
  const teamId = output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim()
  const cdhash = output.match(/^CDHash=(.+)$/mu)?.[1]?.trim()
  const authorities = [...output.matchAll(/^Authority=(.+)$/gmu)].map(match => match[1].trim())
  const signingIdentity = authorities[0]
  if (teamId !== TIDEMIND_RELEASE_TEAM_ID) throw new Error(`candidate app Team ID ${teamId ?? '(missing)'} is not ${TIDEMIND_RELEASE_TEAM_ID}`)
  if (!signingIdentity?.startsWith('Developer ID Application:')
    || !signingIdentity.includes(`(${TIDEMIND_RELEASE_TEAM_ID})`)) {
    throw new Error(`candidate app signing identity is not the Tide Mind Developer ID: ${signingIdentity ?? '(missing)'}`)
  }
  if (!cdhash) throw new Error('candidate app CDHash is missing')
  const executableSha256 = sha256(fs.readFileSync(executable))
  const bundleSha256 = hashPhysicalAppBundle(app)
  if (bundleSha256 !== bundleSha256BeforeVerification) {
    throw new Error('candidate app changed while its physical signature and identity were being verified')
  }
  return Object.freeze({
    version,
    sourceCommit: provenance.sourceCommit,
    bundleSha256,
    executableSha256,
    teamId,
    signingIdentity,
    cdhash,
  })
}
