#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { loadAgentHostAcceptanceRequirements } from './verify-agent-integration-host-acceptance.mjs'
import { extractPartialCandidateAppArchive } from './verify-partial-auth-release.mjs'

const recipesFile = new URL('./host-no-auth-desktop-samples.json', import.meta.url)
const sourceHosts = new Set(['persistent.oaistatic.com', 'downloads.claude.ai'])
const sha = file => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let count
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count))
    return digest.digest('hex')
  } finally { fs.closeSync(fd) }
}
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const plist = (file, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file]).trim()
const check = (value, message) => { if (!value) throw new Error(message) }

export function loadHostNoAuthSamples() {
  const data = JSON.parse(fs.readFileSync(recipesFile, 'utf8'))
  check(data.schemaVersion === 1 && data.appVersion === '0.2.93' && data.samples.length === 2, 'invalid frozen desktop samples')
  const requirements = loadAgentHostAcceptanceRequirements()
  const expectedCatalogs = [['codex-desktop'], ['claude-cowork-local', 'claude-desktop-legacy']]
  check(isDeepStrictEqual(data.samples.map(item => item.catalogIds), expectedCatalogs), 'unexpected desktop sample catalog scope')
  for (const item of data.samples) {
    for (const catalogId of item.catalogIds) {
      const target = requirements.targets.find(target => target.catalogId === catalogId && target.architecture === 'arm64' && target.acceptedDistributionArtifacts.some(receipt => receipt.distributionId === item.receipt.distributionId))
      check(target && target.acceptedDistributionArtifacts.some(receipt => isDeepStrictEqual(receipt, item.receipt)), 'sample receipt differs from frozen release contract')
    }
    const url = new URL(item.sourceUrl)
    check(url.protocol === 'https:' && sourceHosts.has(url.hostname) && !url.username && !url.password && !url.search && !url.hash, 'invalid frozen source URL')
    check(['ChatGPT.app', 'Claude.app'].includes(item.appName), 'invalid frozen App name')
    check(/^[a-f0-9]{64}$/.test(item.receipt.artifactSha256) && item.receipt.artifactSizeBytes > 0 && item.receipt.artifactSizeBytes < 1024 ** 3, 'invalid frozen artifact identity')
  }
  return data.samples
}

export function validateHostSampleArtifact(archive, receipt) {
  check(fs.realpathSync(archive) === path.resolve(archive), 'official sample path traverses a symlink')
  const stat = fs.lstatSync(archive)
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size === receipt.artifactSizeBytes, 'official sample size mismatch')
  check(sha(archive) === receipt.artifactSha256, 'official sample SHA-256 mismatch')
}

export async function prepareHostNoAuthSamples({ workspace, output, catalogId }) {
  check(process.platform === 'darwin' && process.arch === 'arm64', 'native macOS ARM64 required')
  check(run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']).trim() === '1', 'native ARM hardware required')
  workspace = path.resolve(workspace); output = path.resolve(output)
  check(fs.realpathSync(workspace) === workspace && fs.lstatSync(workspace).isDirectory(), 'workspace must be a canonical real directory')
  check(output.startsWith(workspace + path.sep) && !fs.existsSync(output), 'output must be new and inside workspace')
  check(fs.realpathSync(path.dirname(output)) === path.dirname(output), 'output parent must be canonical and not traverse symlinks')
  if (catalogId !== undefined) check(['codex-desktop', 'claude-cowork-local', 'claude-desktop-legacy'].includes(catalogId), 'unreviewed desktop sample target')
  const samples = loadHostNoAuthSamples().filter(item => catalogId === undefined || item.catalogIds.includes(catalogId))
  const home = path.join(workspace, 'home'), applications = path.join(home, 'Applications')
  if (!fs.existsSync(home)) fs.mkdirSync(home, { mode: 0o700 })
  check(fs.realpathSync(home) === home && fs.lstatSync(home).isDirectory(), 'task HOME must be a real directory')
  check(!fs.existsSync(applications), 'task Applications must be new; no installed apps are overwritten')
  // A duplicate global installation is an environment problem, never filtered out of discovery.
  for (const entry of fs.readdirSync('/Applications')) {
    if (!entry.endsWith('.app')) continue
    const info = path.join('/Applications', entry, 'Contents/Info.plist')
    if (!fs.existsSync(info)) continue
    const id = plist(info, 'CFBundleIdentifier')
    check(!samples.some(item => item.receipt.distributionId === id), `conflicting system application: ${entry}`)
  }
  const artifacts = path.join(workspace, 'host-sample-artifacts')
  fs.mkdirSync(artifacts, { mode: 0o700 }); fs.mkdirSync(applications, { mode: 0o700 })
  const observations = [], targets = []
  for (const item of samples) {
    const receipt = item.receipt, archive = path.join(artifacts, `${item.catalogIds[0]}.zip`)
    const response = await fetch(item.sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(20 * 60_000) })
    check(response.status === 200 && response.body, 'official sample download failed')
    const expectedLength = response.headers.get('content-length')
    if (expectedLength) check(Number(expectedLength) === receipt.artifactSizeBytes, 'official sample response size mismatch')
    const fd = fs.openSync(archive, 'wx', 0o400)
    let total = 0
    try {
      for await (const chunk of response.body) {
        total += chunk.length; check(total <= receipt.artifactSizeBytes, 'official sample download exceeded bound')
        const bytes = Buffer.from(chunk); let offset = 0
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
      }
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    validateHostSampleArtifact(archive, receipt)
    const extracted = path.join(artifacts, `${item.catalogIds[0]}-extracted`)
    extractPartialCandidateAppArchive(archive, receipt.artifactSha256, extracted, archive + '.snapshot', item.appName)
    fs.renameSync(path.join(extracted, item.appName), path.join(applications, item.appName))
    validateHostSampleArtifact(archive, receipt)
    const app = path.join(applications, item.appName), info = path.join(app, 'Contents/Info.plist')
    check(plist(info, 'CFBundleIdentifier') === receipt.distributionId && plist(info, 'CFBundleShortVersionString') === receipt.version, 'official sample bundle/version mismatch')
    const executableName = plist(info, 'CFBundleExecutable')
    check(path.basename(executableName) === executableName && executableName !== '.' && executableName !== '..', 'invalid official executable name')
    const executable = path.join(app, 'Contents/MacOS', executableName)
    check(fs.statSync(executable).size === receipt.executableSizeBytes && sha(executable) === receipt.executableSha256, 'official sample executable mismatch')
    const codesign = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    const detailsResult = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    check(detailsResult.status === 0 && !detailsResult.error, 'official sample signed identity unreadable')
    const details = detailsResult.stdout + detailsResult.stderr
    for (const [field, expected] of [['Identifier', receipt.signedCode.identifier], ['TeamIdentifier', receipt.signedCode.teamIdentifier], ['CDHash', receipt.signedCode.cdhash]]) {
      check(details.split('\n').includes(`${field}=${expected}`), `official sample ${field} mismatch`)
    }
    // codesign -d uses stderr; independently query exact signed requirement using -R.
    run('/usr/bin/codesign', ['--verify', '--strict', '-R', receipt.signedCode.designatedRequirement, app])
    observations.push({ catalogIds: item.catalogIds, appPath: app, sourceUrl: item.sourceUrl, artifactSha256: sha(archive), version: receipt.version, receipt, appExecuted: false, codesignStdout: codesign + details })
    for (const selectedCatalog of item.catalogIds) {
      if (catalogId === undefined || selectedCatalog === catalogId) targets.push({ catalogId: selectedCatalog, distributionId: receipt.distributionId, appPath: app })
    }
  }
  const manifest = { schemaVersion: 1, kind: 'static_official_host_sample_preparation', observedAt: new Date().toISOString(), hostAppsExecuted: false, workspace, targets, observations }
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { output, targets, hostAppsExecuted: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), values = {}
    for (let i = 0; i < args.length; i += 2) {
      check(['--workspace', '--output', '--catalog-id'].includes(args[i]) && args[i + 1] && !values[args[i]], 'invalid preparation arguments')
      values[args[i]] = args[i + 1]
    }
    check(values['--workspace'] && values['--output'], '--workspace and --output required')
    console.log(JSON.stringify(await prepareHostNoAuthSamples({ workspace: values['--workspace'], output: values['--output'], catalogId: values['--catalog-id'] })))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
