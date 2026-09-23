#!/usr/bin/env node
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'

const VERSION = '0.2.92'
const REPOSITORY = 'SawyerHan-AI/TideMind'
const SHA256 = /^[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const EXPECTED_FILES = [
  `Tide.Mind-${VERSION}-arm64-stapled-app.zip`,
  `Tide.Mind-${VERSION}-arm64.dmg`,
  `Tide.Mind-${VERSION}-arm64.dmg.blockmap`,
  `Tide.Mind-${VERSION}-arm64.zip`,
  'candidate-verification.json',
  'files.sha256',
  'latest-mac-arm64.yml',
].sort()

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} shape is invalid`)
  }
}

function hashFile(file) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path.basename(file)} must be a regular file`)
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`)
}

export function validateDeferredHostReleaseWaiver(waiver, sourceCommit) {
  exactKeys(waiver, [
    'schemaVersion', 'kind', 'appVersion', 'sourceCommit', 'candidatePublicCommit',
    'candidateRunId', 'candidateRunAttempt', 'artifactId', 'artifactDigest',
    'uploadReceiptArtifactId', 'uploadReceiptArtifactDigest', 'candidateBundleSha256',
    'executableSha256', 'teamId', 'cdhash', 'dmgSha256', 'zipSha256',
    'acceptanceStatus', 'decision',
  ], 'deferred-host waiver')
  assertEqual(waiver.schemaVersion, 1, 'waiver schema')
  assertEqual(waiver.kind, 'deferred_real_host_acceptance', 'waiver kind')
  assertEqual(waiver.appVersion, VERSION, 'waiver version')
  if (!COMMIT.test(waiver.sourceCommit) || !COMMIT.test(waiver.candidatePublicCommit)) {
    throw new Error('waiver source commits are invalid')
  }
  assertEqual(waiver.sourceCommit, sourceCommit, 'waiver source commit')
  for (const key of ['candidateRunId', 'candidateRunAttempt', 'artifactId', 'uploadReceiptArtifactId']) {
    if (!/^[1-9][0-9]*$/u.test(waiver[key])) throw new Error(`waiver ${key} is invalid`)
  }
  for (const key of [
    'artifactDigest', 'uploadReceiptArtifactDigest', 'candidateBundleSha256',
    'executableSha256', 'dmgSha256', 'zipSha256',
  ]) {
    if (!SHA256.test(waiver[key])) throw new Error(`waiver ${key} is invalid`)
  }
  if (waiver.teamId !== 'Z4U232GXH5' || !/^[0-9a-f]{40}$/u.test(waiver.cdhash)) {
    throw new Error('waiver signing identity is invalid')
  }
  assertEqual(waiver.acceptanceStatus, 'not_performed', 'waiver acceptance status')
  if (typeof waiver.decision !== 'string' || !waiver.decision.includes('not real-host evidence')) {
    throw new Error('waiver must disclose that host acceptance was not performed')
  }
  return waiver
}

export function validateDeferredUploadReceipt(receipt, waiver) {
  exactKeys(receipt, [
    'schemaVersion', 'purpose', 'sourceCommit', 'publicCommit', 'appVersion',
    'architecture', 'repository', 'runId', 'runAttempt', 'artifactId',
    'artifactUrl', 'artifactDigest',
  ], 'candidate upload receipt')
  for (const [key, expected] of Object.entries({
    schemaVersion: 1, purpose: 'mac_rc_upload', sourceCommit: waiver.sourceCommit,
    publicCommit: waiver.candidatePublicCommit, appVersion: VERSION,
    architecture: 'arm64', repository: REPOSITORY, runId: waiver.candidateRunId,
    runAttempt: waiver.candidateRunAttempt, artifactId: waiver.artifactId,
    artifactDigest: waiver.artifactDigest,
    artifactUrl: `https://github.com/${REPOSITORY}/actions/runs/${waiver.candidateRunId}/artifacts/${waiver.artifactId}`,
  })) assertEqual(receipt[key], expected, `upload receipt ${key}`)
}

export function validateDeferredCandidateVerification(receipt, waiver) {
  exactKeys(receipt, [
    'schemaVersion', 'verificationClass', 'sourceCommit', 'appVersion', 'architecture',
    'candidateBundleSha256', 'executableSha256', 'teamId', 'signingIdentity',
    'cdhash', 'dmgSha256', 'zipSha256', 'verifiedAt',
  ], 'candidate verification')
  for (const [key, expected] of Object.entries({
    schemaVersion: 1, verificationClass: 'private_rc_candidate',
    sourceCommit: waiver.sourceCommit, appVersion: VERSION, architecture: 'arm64',
    candidateBundleSha256: waiver.candidateBundleSha256,
    executableSha256: waiver.executableSha256, teamId: waiver.teamId,
    cdhash: waiver.cdhash, dmgSha256: waiver.dmgSha256, zipSha256: waiver.zipSha256,
  })) assertEqual(receipt[key], expected, `candidate verification ${key}`)
  if (typeof receipt.signingIdentity !== 'string'
    || !receipt.signingIdentity.startsWith('Developer ID Application:')
    || !receipt.signingIdentity.includes(`(${waiver.teamId})`)) {
    throw new Error('candidate verification signing identity is invalid')
  }
  if (!Number.isFinite(Date.parse(receipt.verifiedAt))) {
    throw new Error('candidate verification timestamp is invalid')
  }
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function extractVerifiedZip(zipPath, expectedDigest, expectedNames, destination) {
  assertEqual(hashFile(zipPath), expectedDigest, `${path.basename(zipPath)} digest`)
  const names = run('/usr/bin/unzip', ['-Z1', zipPath]).split(/\r?\n/u).filter(Boolean).sort()
  assertEqual(JSON.stringify(names), JSON.stringify(expectedNames), `${path.basename(zipPath)} entries`)
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 })
  run('/usr/bin/unzip', ['-q', zipPath, '-d', destination])
}

function verifyInnerChecksums(stage) {
  const lines = fs.readFileSync(path.join(stage, 'files.sha256'), 'utf8').trim().split(/\r?\n/u)
  const listed = new Map()
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  ([^/\\]+)$/u)
    if (!match || listed.has(match[2])) throw new Error('candidate files.sha256 is invalid')
    listed.set(match[2], match[1])
  }
  const expected = EXPECTED_FILES.filter(name => name !== 'files.sha256')
  assertEqual(JSON.stringify([...listed.keys()].sort()), JSON.stringify(expected), 'candidate checksum entries')
  for (const [name, digest] of listed) assertEqual(hashFile(path.join(stage, name)), digest, `candidate ${name}`)
}

function getArg(argv, name) {
  const index = argv.indexOf(name)
  if (index < 0 || !argv[index + 1]) throw new Error(`missing ${name}`)
  return path.resolve(argv[index + 1])
}

export function verifyDeferredHostReleaseCandidate({ waiverPath, sourceCommit, artifactZip, uploadReceiptZip, stage }) {
  hashFile(waiverPath)
  const waiver = validateDeferredHostReleaseWaiver(JSON.parse(fs.readFileSync(waiverPath, 'utf8')), sourceCommit)
  if (fs.existsSync(stage)) throw new Error('candidate staging path already exists')
  const receiptStage = `${stage}-receipt`
  if (fs.existsSync(receiptStage)) throw new Error('receipt staging path already exists')
  extractVerifiedZip(uploadReceiptZip, waiver.uploadReceiptArtifactDigest, ['mac-rc-upload-receipt.json'], receiptStage)
  validateDeferredUploadReceipt(JSON.parse(fs.readFileSync(path.join(receiptStage, 'mac-rc-upload-receipt.json'), 'utf8')), waiver)
  extractVerifiedZip(artifactZip, waiver.artifactDigest, EXPECTED_FILES, stage)
  verifyInnerChecksums(stage)
  validateDeferredCandidateVerification(JSON.parse(fs.readFileSync(path.join(stage, 'candidate-verification.json'), 'utf8')), waiver)
  assertEqual(hashFile(path.join(stage, `Tide.Mind-${VERSION}-arm64.dmg`)), waiver.dmgSha256, 'candidate DMG')
  assertEqual(hashFile(path.join(stage, `Tide.Mind-${VERSION}-arm64.zip`)), waiver.zipSha256, 'candidate updater ZIP')
  if (process.platform !== 'darwin') throw new Error('physical candidate recheck requires macOS')
  const appStage = `${stage}-app`
  if (fs.existsSync(appStage)) throw new Error('App staging path already exists')
  fs.mkdirSync(appStage, { recursive: false, mode: 0o700 })
  run('/usr/bin/ditto', ['-x', '-k', path.join(stage, `Tide.Mind-${VERSION}-arm64-stapled-app.zip`), appStage])
  const app = path.join(appStage, 'Tide Mind.app')
  const physical = inspectPhysicalTideMindCandidateApp(app, VERSION, waiver.sourceCommit, 'arm64')
  for (const [key, expected] of Object.entries({
    bundleSha256: waiver.candidateBundleSha256, executableSha256: waiver.executableSha256,
    teamId: waiver.teamId, cdhash: waiver.cdhash,
  })) assertEqual(physical[key], expected, `physical App ${key}`)
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  run('/usr/bin/xcrun', ['stapler', 'validate', app])
  return Object.freeze({ waiver, physical })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2)
    const sourceIndex = argv.indexOf('--source-commit')
    if (sourceIndex < 0 || !argv[sourceIndex + 1] || !COMMIT.test(argv[sourceIndex + 1])) {
      throw new Error('missing or invalid --source-commit')
    }
    const result = verifyDeferredHostReleaseCandidate({
      waiverPath: getArg(argv, '--waiver'),
      sourceCommit: argv[sourceIndex + 1],
      artifactZip: getArg(argv, '--artifact-zip'),
      uploadReceiptZip: getArg(argv, '--upload-receipt-zip'),
      stage: getArg(argv, '--stage'),
    })
    process.stdout.write(`verified deferred 0.2.92 candidate: ${result.physical.bundleSha256}; real-host acceptance not performed\n`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
