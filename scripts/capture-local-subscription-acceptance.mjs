#!/usr/bin/env node
/** Create an empty capture or seal manually reviewed, redacted real observations.
 * No login, inference or synthetic success is performed by this helper. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'
import { loadSubscriptionRequirements, subscriptionCaptureScope, verifyLocalSubscriptionAcceptance } from './verify-local-subscription-acceptance.mjs'

export function initializeSubscriptionCapture({ workspace, sourceCommit, candidateApp, collectedBy }) {
  const requirements = loadSubscriptionRequirements()
  const scope = subscriptionCaptureScope(requirements)
  if (fs.existsSync(workspace)) throw new Error('capture workspace already exists')
  if (!collectedBy?.trim()) throw new Error('collector required')
  const candidate = inspectPhysicalTideMindCandidateApp(candidateApp, requirements.appVersion, sourceCommit, 'arm64')
  const index = {
    schemaVersion: 1, evidenceClass: 'real_subscription', appVersion: requirements.appVersion,
    sourceCommit, requirementsSha256: requirements.sha256,
    captureNonce: crypto.randomBytes(32).toString('hex'), captureCreatedAt: new Date().toISOString(),
    collectedBy, reviewedBy: null, reviewedAt: null,
    candidateAppsByArchitecture: { arm64: candidate },
    deferredProviders: scope.deferredProviders,
    providers: scope.providers.map(provider => ({
      provider, binding: null, steps: Object.fromEntries(requirements.steps.map(step => [step, null])),
    })),
    files: [],
  }
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(workspace, 'index.json'), JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { status: 'pending', workspace }
}

/** evidencePaths are explicit redacted exports, not CLI config/credential folders. */
export function sealSubscriptionCapture({ workspace, evidencePaths, candidateApp }) {
  const file = path.join(workspace, 'index.json')
  const index = JSON.parse(fs.readFileSync(file))
  index.files = evidencePaths.map(name => {
    if (!name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('invalid evidence path')
    const source = path.join(workspace, name)
    const stat = fs.lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence must be regular')
    const bytes = fs.readFileSync(source)
    return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  })
  const previous = fs.readFileSync(file)
  fs.writeFileSync(file, JSON.stringify(index, null, 2) + '\n')
  try {
    return verifyLocalSubscriptionAcceptance({ indexPath: file, expectedAppVersion: index.appVersion,
      expectedSourceCommit: index.sourceCommit, candidateAppPathsByArchitecture: { arm64: candidateApp } })
  } catch (error) { fs.writeFileSync(file, previous); throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    const opts = {}
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i + 1]) throw new Error('missing value')
      const key = { '--workspace': 'workspace', '--source-commit': 'sourceCommit', '--candidate-app': 'candidateApp',
        '--collector': 'collectedBy', '--files': 'files' }[args[i]]
      if (!key) throw new Error('unknown option')
      opts[key] = args[i + 1]
    }
    if (command === 'init') console.log(JSON.stringify(initializeSubscriptionCapture(opts)))
    else if (command === 'seal') console.log(JSON.stringify(sealSubscriptionCapture({ ...opts, evidencePaths: JSON.parse(fs.readFileSync(opts.files)) })))
    else throw new Error('use init or seal; see docs/Codex-guides/local-subscription-acceptance.md')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
