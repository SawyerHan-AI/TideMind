#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TIDEMIND_RELEASE_TEAM_ID } from './tidemind-candidate-app-identity.mjs'
import { releaseMacArchitectures } from './release.mjs'

/** Bind the shipped app to the exact signed app exercised by real-host tests. */
export function assertAcceptedReleaseCandidate(index, candidate, architecture, appVersion, sourceCommit) {
  const accepted = index?.candidateAppsByArchitecture?.[architecture]
  if (index?.evidenceClass !== 'real_host' || index.appVersion !== appVersion
    || index.sourceCommit !== sourceCommit || !accepted) {
    throw new Error('release candidate has no matching real-host acceptance')
  }
  for (const key of ['version', 'sourceCommit', 'bundleSha256', 'executableSha256', 'teamId', 'signingIdentity', 'cdhash']) {
    if (candidate[key] !== accepted[key]) throw new Error(`release candidate ${architecture} ${key} differs from accepted app`)
  }
  if (candidate.version !== appVersion || candidate.sourceCommit !== sourceCommit
    || candidate.teamId !== TIDEMIND_RELEASE_TEAM_ID) {
    throw new Error('release candidate identity does not match the release')
  }
}

export function verifyAcceptedReleaseArtifacts({ index, receipt, architecture, appVersion, sourceCommit, readArtifact }) {
  const keys = ['appVersion', 'architecture', 'candidateBundleSha256', 'cdhash', 'dmgSha256',
    'executableSha256', 'schemaVersion', 'signingIdentity', 'sourceCommit', 'teamId', 'verifiedAt', 'zipSha256'].sort()
  if (!receipt || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys)
    || receipt.schemaVersion !== 1 || receipt.architecture !== architecture
    || receipt.appVersion !== appVersion || receipt.sourceCommit !== sourceCommit) {
    throw new Error(`invalid accepted release receipt for ${architecture}`)
  }
  assertAcceptedReleaseCandidate(index, {
    version: receipt.appVersion, sourceCommit: receipt.sourceCommit,
    bundleSha256: receipt.candidateBundleSha256, executableSha256: receipt.executableSha256,
    teamId: receipt.teamId, signingIdentity: receipt.signingIdentity, cdhash: receipt.cdhash,
  }, architecture, appVersion, sourceCommit)
  for (const extension of ['dmg', 'zip']) {
    const actual = crypto.createHash('sha256').update(readArtifact(extension)).digest('hex')
    if (receipt[`${extension}Sha256`] !== actual) throw new Error(`${architecture} ${extension} accepted release receipt mismatch`)
  }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function main() {
  const releaseDir = path.resolve(argument('--release-dir'))
  const index = JSON.parse(fs.readFileSync(argument('--acceptance-index'), 'utf8'))
  const appVersion = argument('--app-version')
  const sourceCommit = argument('--source-commit')
  const architectures = releaseMacArchitectures(appVersion)
  for (const architecture of architectures) {
    const receipt = JSON.parse(fs.readFileSync(path.join(releaseDir, 'provenance', `mac-${architecture}.json`), 'utf8'))
    verifyAcceptedReleaseArtifacts({ index, receipt, architecture, appVersion, sourceCommit,
      readArtifact: extension => fs.readFileSync(path.join(releaseDir, `Tide.Mind-${appVersion}-${architecture}.${extension}`)),
    })
  }
  console.log(`verified ${architectures.join(', ')} release artifacts against accepted candidate identities and artifact hashes`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) { console.error(error.message); process.exit(1) }
}
