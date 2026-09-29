#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractPartialCandidateAppArchive } from './verify-partial-auth-release.mjs'
import { inspectPhysicalTideMindCandidateApp, TIDEMIND_RELEASE_TEAM_ID } from './tidemind-candidate-app-identity.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHA = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
function equal(a, b, label) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(label + ' mismatch') }
export function signedHostCandidateFiles(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('invalid candidate version')
  return [`Tide.Mind-${version}-arm64-stapled-app.zip`, `Tide.Mind-${version}-arm64.dmg`,
    `Tide.Mind-${version}-arm64.dmg.blockmap`, `Tide.Mind-${version}-arm64.zip`,
    'candidate-verification.json', 'files.sha256', 'latest-mac-arm64.yml'].sort()
}
export function validateSignedHostCandidateReceipt(value, version, sourceCommit) {
  const keys = ['schemaVersion', 'verificationClass', 'sourceCommit', 'appVersion', 'architecture',
    'candidateBundleSha256', 'executableSha256', 'teamId', 'signingIdentity', 'cdhash', 'dmgSha256', 'zipSha256', 'verifiedAt']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())) throw new Error('candidate receipt shape invalid')
  if (!COMMIT.test(sourceCommit) || value.schemaVersion !== 1 || value.verificationClass !== 'private_rc_candidate'
    || value.sourceCommit !== sourceCommit || value.appVersion !== version || value.architecture !== 'arm64'
    || value.teamId !== TIDEMIND_RELEASE_TEAM_ID) throw new Error('candidate receipt source/version/architecture binding failed')
  for (const key of ['candidateBundleSha256', 'executableSha256', 'dmgSha256', 'zipSha256']) {
    if (!SHA.test(value[key])) throw new Error('candidate receipt hash invalid')
  }
  if (!/^[a-f0-9]{40}$/u.test(value.cdhash) || typeof value.signingIdentity !== 'string'
    || !value.signingIdentity.startsWith('Developer ID Application:')
    || !value.signingIdentity.includes('(' + TIDEMIND_RELEASE_TEAM_ID + ')')
    || !Number.isFinite(Date.parse(value.verifiedAt))) throw new Error('candidate signing receipt invalid')
  return { version, sourceCommit, bundleSha256: value.candidateBundleSha256,
    executableSha256: value.executableSha256, teamId: value.teamId,
    signingIdentity: value.signingIdentity, cdhash: value.cdhash }
}
export function validateSignedHostChecksumManifest(text, version) {
  const values = new Map()
  for (const line of text.trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/u.exec(line)
    if (!match || values.has(match[2])) throw new Error('invalid candidate checksum manifest')
    values.set(match[2], match[1])
  }
  equal([...values.keys()].sort(), signedHostCandidateFiles(version).filter(name => name !== 'files.sha256'), 'checksum coverage')
  return values
}
function fileHash(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size > 8n * 1024n * 1024n * 1024n) throw new Error('candidate archive is not a bounded regular file')
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let size
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size))
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true })
    for (const stat of [after, current]) if (!stat.isFile()
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => stat[key] !== before[key])) throw new Error('candidate file changed while hashing')
    return digest.digest('hex')
  } finally { fs.closeSync(fd) }
}
function readBounded(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('candidate metadata size/type invalid')
  return fs.readFileSync(file, 'utf8')
}
/** Stages original signed bytes. This result is NOT a host-acceptance assertion. */
export function stageSignedHostAcceptance({ artifactZip, artifactDigest, sourceCommit, stage }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('signed host acceptance requires native macOS ARM64')
  if (!SHA.test(artifactDigest) || !COMMIT.test(sourceCommit)) throw new Error('invalid expected candidate identity')
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const names = signedHostCandidateFiles(version), directory = path.resolve(stage)
  if (fs.existsSync(directory)) throw new Error('stage must be new')
  fs.mkdirSync(directory, { mode: 0o700 })
  // Freeze the downloaded artifact before any extraction. Never use a mutable input again.
  const snapshot = path.join(directory, 'candidate-artifact.zip')
  fs.copyFileSync(path.resolve(artifactZip), snapshot, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(snapshot, 0o400)
  equal(fileHash(snapshot), artifactDigest, 'downloaded artifact digest')
  const assets = path.join(directory, 'assets'); fs.mkdirSync(assets, { mode: 0o700 })
  const fd = fs.openSync(snapshot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', '/dev/fd/3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }).trim().split(/\r?\n/u).sort()
    equal(entries, names, 'candidate archive fixed entry set')
    for (const name of names) {
      const output = fs.openSync(path.join(assets, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      try { execFileSync('/usr/bin/unzip', ['-p', '/dev/fd/3', name], { stdio: ['ignore', output, 'pipe', fd] }) }
      finally { fs.closeSync(output) }
    }
  } finally { fs.closeSync(fd) }
  equal(fileHash(snapshot), artifactDigest, 'candidate artifact snapshot after extraction')
  const checksums = validateSignedHostChecksumManifest(readBounded(path.join(assets, 'files.sha256')), version)
  for (const [name, digest] of checksums) equal(fileHash(path.join(assets, name)), digest, 'candidate file ' + name)
  const receipt = JSON.parse(readBounded(path.join(assets, 'candidate-verification.json')))
  const expectedApp = validateSignedHostCandidateReceipt(receipt, version, sourceCommit)
  equal(fileHash(path.join(assets, `Tide.Mind-${version}-arm64.dmg`)), receipt.dmgSha256, 'candidate DMG receipt')
  equal(fileHash(path.join(assets, `Tide.Mind-${version}-arm64.zip`)), receipt.zipSha256, 'candidate ZIP receipt')
  const appRoot = path.join(directory, 'app')
  extractPartialCandidateAppArchive(path.join(assets, `Tide.Mind-${version}-arm64-stapled-app.zip`),
    checksums.get(`Tide.Mind-${version}-arm64-stapled-app.zip`), appRoot, path.join(directory, 'stapled-app-snapshot.zip'))
  const app = path.join(appRoot, 'Tide Mind.app')
  const identity = inspectPhysicalTideMindCandidateApp(app, version, sourceCommit, 'arm64')
  equal(identity, expectedApp, 'physical candidate App')
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', app], { stdio: ['ignore', 'pipe', 'pipe'] })
  const result = { schemaVersion: 1, status: 'signed_candidate_staged_not_host_acceptance', app, artifactDigest, identity }
  fs.writeFileSync(path.join(directory, 'candidate-identity.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), values = {}
    for (let index = 0; index < args.length; index += 2) {
      if (!['--artifact-zip', '--artifact-digest', '--source-commit', '--stage'].includes(args[index])
        || values[args[index]] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid stage arguments')
      values[args[index]] = args[index + 1]
    }
    if (Object.keys(values).length !== 4) throw new Error('all stage arguments required')
    console.log(JSON.stringify(stageSignedHostAcceptance({ artifactZip: values['--artifact-zip'], artifactDigest: values['--artifact-digest'],
      sourceCommit: values['--source-commit'], stage: values['--stage'] })))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
