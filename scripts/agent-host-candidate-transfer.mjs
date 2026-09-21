#!/usr/bin/env node
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readJson(file, label) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} shape is invalid`)
  }
}

export function validateCandidateTransferReceipt(receipt, expected) {
  exactKeys(receipt, [
    'schemaVersion', 'architecture', 'appVersion', 'sourceCommit', 'candidateBundleSha256',
    'archiveSha256', 'archiveBytes', 'transferTag', 'assetName', 'appBundleName',
  ], 'candidate transfer receipt')
  if (receipt.schemaVersion !== 1) throw new Error('unsupported candidate transfer receipt schema')
  if (!['arm64', 'x64'].includes(receipt.architecture)) throw new Error('candidate transfer architecture is invalid')
  for (const key of ['candidateBundleSha256', 'archiveSha256']) {
    if (!/^[a-f0-9]{64}$/u.test(receipt[key])) throw new Error(`candidate transfer ${key} is invalid`)
  }
  if (!Number.isSafeInteger(receipt.archiveBytes) || receipt.archiveBytes <= 0) {
    throw new Error('candidate transfer archiveBytes is invalid')
  }
  if (!/^agent-host-candidate-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}$/u.test(receipt.transferTag)) {
    throw new Error('candidate transfer tag is invalid')
  }
  if (!/^Tide\.Mind-[0-9]+\.[0-9]+\.[0-9]+-(?:arm64|x64)-[a-f0-9]{12}\.zip$/u.test(receipt.assetName)) {
    throw new Error('candidate transfer asset name is invalid')
  }
  if (receipt.appBundleName !== 'Tide Mind.app') throw new Error('candidate transfer app bundle name is invalid')
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) throw new Error(`candidate transfer ${key} does not match the frozen release`)
  }
  return Object.freeze({ ...receipt })
}

export function validateCandidateArchiveEntries(entries, appBundleName = 'Tide Mind.app') {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('candidate transfer archive is empty')
  const prefix = `${appBundleName}/`
  for (const raw of entries) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0') || raw.startsWith('/')) {
      throw new Error('candidate transfer archive contains an unsafe entry')
    }
    const normalized = path.posix.normalize(raw)
    if (normalized === '..' || normalized.startsWith('../')
      || (normalized !== appBundleName && !normalized.startsWith(prefix))) {
      throw new Error(`candidate transfer archive entry escapes ${appBundleName}: ${raw}`)
    }
  }
}

export function prepareCandidateTransfer({ architecture, candidateAppPath, indexPath, sourceCommit, appVersion, archivePath, receiptPath }) {
  if (!['arm64', 'x64'].includes(architecture)) throw new Error('candidate transfer architecture is invalid')
  const candidate = inspectPhysicalTideMindCandidateApp(candidateAppPath, appVersion, sourceCommit, architecture)
  const index = readJson(indexPath, 'acceptance index')
  if (index.appVersion !== appVersion || index.sourceCommit !== sourceCommit
    || index.candidateAppsByArchitecture?.[architecture]?.bundleSha256 !== candidate.bundleSha256) {
    throw new Error('acceptance index is not bound to the physical candidate app')
  }
  const sourcePrefix = sourceCommit.slice(0, 12)
  const transferTag = `agent-host-candidate-v${appVersion}-${sourcePrefix}`
  const assetName = `Tide.Mind-${appVersion}-${architecture}-${sourcePrefix}.zip`
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.resolve(candidateAppPath), path.resolve(archivePath)], { stdio: 'pipe' })
  const archive = fs.readFileSync(archivePath)
  const receipt = {
    schemaVersion: 1,
    architecture,
    appVersion,
    sourceCommit,
    candidateBundleSha256: candidate.bundleSha256,
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    transferTag,
    assetName,
    appBundleName: 'Tide Mind.app',
  }
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  return Object.freeze(receipt)
}

export function extractAndVerifyCandidateTransfer({ architecture, receiptPath, archivePath, indexPath, destination, sourceCommit, appVersion }) {
  const receipt = validateCandidateTransferReceipt(readJson(receiptPath, 'candidate transfer receipt'), {
    appVersion,
    sourceCommit,
    architecture,
  })
  const archiveStat = fs.lstatSync(archivePath)
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) throw new Error('candidate transfer archive must be a regular file')
  const archive = fs.readFileSync(archivePath)
  if (archive.length !== receipt.archiveBytes || sha256(archive) !== receipt.archiveSha256) {
    throw new Error('candidate transfer archive hash or size mismatch')
  }
  const entries = execFileSync('/usr/bin/unzip', ['-Z1', archivePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split(/\r?\n/u).filter(Boolean)
  validateCandidateArchiveEntries(entries, receipt.appBundleName)
  fs.mkdirSync(destination, { recursive: false })
  execFileSync('/usr/bin/ditto', ['-x', '-k', archivePath, destination], { stdio: 'pipe' })
  const candidateAppPath = path.join(destination, receipt.appBundleName)
  const candidate = inspectPhysicalTideMindCandidateApp(candidateAppPath, appVersion, sourceCommit, architecture)
  const index = readJson(indexPath, 'acceptance index')
  if (candidate.bundleSha256 !== receipt.candidateBundleSha256
    || index.candidateAppsByArchitecture?.[architecture]?.bundleSha256 !== candidate.bundleSha256) {
    throw new Error('extracted candidate does not match its receipt and acceptance index')
  }
  return Object.freeze({ candidateAppPath, receipt, candidate })
}

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function main() {
  const mode = process.argv[2]
  if (mode === 'prepare') {
    const result = prepareCandidateTransfer({
      architecture: argument('--architecture'),
      candidateAppPath: argument('--candidate-app'), indexPath: argument('--index'),
      sourceCommit: argument('--source-commit'), appVersion: argument('--app-version'),
      archivePath: argument('--archive'), receiptPath: argument('--receipt'),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (mode === 'extract') {
    const result = extractAndVerifyCandidateTransfer({
      architecture: argument('--architecture'),
      receiptPath: argument('--receipt'), archivePath: argument('--archive'),
      indexPath: argument('--index'), destination: argument('--destination'),
      sourceCommit: argument('--source-commit'), appVersion: argument('--app-version'),
    })
    process.stdout.write(`${result.candidateAppPath}\n`)
    return
  }
  throw new Error('usage: agent-host-candidate-transfer.mjs prepare|extract ...')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) { console.error(error.message); process.exit(1) }
}
