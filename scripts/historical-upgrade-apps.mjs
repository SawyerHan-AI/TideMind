#!/usr/bin/env node
/** Exact historical signed-App inputs. No provenance exception for the new candidate. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { hashPhysicalAppBundle, TIDEMIND_RELEASE_TEAM_ID, TIDEMIND_RELEASE_BUNDLE_ID } from './tidemind-candidate-app-identity.mjs'
import { extractPartialCandidateAppArchive } from './verify-partial-auth-release.mjs'
const recipe = new URL('./historical-upgrade-apps.json', import.meta.url)
const check = (value, message) => { if (!value) throw new Error(message) }
function hashFile(file) {
  check(fs.realpathSync(file) === path.resolve(file), 'historical archive path must be canonical')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd, { bigint: true }); check(before.isFile() && before.size < 2n ** 31n, 'historical artifact type/size invalid')
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size))
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true })
    for (const stat of [after, current]) check(stat.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key]), 'historical artifact changed while hashing')
    return hash.digest('hex')
  } finally { fs.closeSync(fd) }
}
export function loadHistoricalUpgradeApps() {
  const data = JSON.parse(fs.readFileSync(recipe, 'utf8'))
  check(data.schemaVersion === 1 && JSON.stringify(data.samples.map(item => item.version)) === JSON.stringify(['0.2.89', '0.2.91', '0.2.92']), 'invalid historical version scope')
  for (const item of data.samples) {
    check(item.assetName === `Tide.Mind-${item.version}-arm64.zip` && item.sourceUrl === `https://github.com/SawyerHan-AI/TideMind/releases/download/v${item.version}/${item.assetName}`, 'historical source URL/name mismatch')
    check(/^[a-f0-9]{64}$/.test(item.artifactSha256) && Number.isSafeInteger(item.artifactSizeBytes) && item.artifactSizeBytes > 0 && item.artifactSizeBytes < 2 ** 31, 'historical archive binding invalid')
    const identity = item.appIdentity
    check(identity.version === item.version && identity.bundleId === TIDEMIND_RELEASE_BUNDLE_ID && identity.architecture === 'arm64' && identity.teamId === TIDEMIND_RELEASE_TEAM_ID, 'historical signed identity invalid')
    check(/^[a-f0-9]{64}$/.test(identity.bundleSha256) && /^[a-f0-9]{64}$/.test(identity.executableSha256) && /^[a-f0-9]{40}$/.test(identity.cdhash), 'historical signed hashes invalid')
  }
  return data.samples
}
export function validateHistoricalUpgradeArchive(archive, entry) {
  check(fs.lstatSync(archive).isFile() && fs.statSync(archive).size === entry.artifactSizeBytes, 'historical archive size/type mismatch')
  check(hashFile(archive) === entry.artifactSha256, 'historical archive SHA-256 mismatch')
}
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export function inspectHistoricalUpgradeApp(appPath, version) {
  check(process.platform === 'darwin' && process.arch === 'arm64', 'historical App inspection requires native macOS ARM64')
  const entry = loadHistoricalUpgradeApps().find(item => item.version === version)
  check(entry, 'historical App version is not authorized')
  const app = path.resolve(appPath), expected = entry.appIdentity
  check(fs.realpathSync(app) === app && fs.lstatSync(app).isDirectory() && !fs.lstatSync(app).isSymbolicLink(), 'historical App must be a canonical real directory')
  const info = path.join(app, 'Contents/Info.plist')
  check(fs.lstatSync(info).isFile() && !fs.lstatSync(info).isSymbolicLink(), 'historical Info.plist must be a regular file')
  const plist = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info])
  check(plist('CFBundleShortVersionString') === version && plist('CFBundleIdentifier') === expected.bundleId, 'historical App version/bundle mismatch')
  const executableName = plist('CFBundleExecutable')
  check(executableName && path.basename(executableName) === executableName && !['.', '..'].includes(executableName), 'historical executable name invalid')
  const executable = path.join(app, 'Contents/MacOS', executableName)
  check(run('/usr/bin/lipo', ['-archs', executable]) === 'arm64', 'historical App architecture mismatch')
  check(hashFile(executable) === expected.executableSha256, 'historical executable hash mismatch')
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8', timeout: 120_000 })
  check(result.status === 0 && !result.error, 'historical code signature unreadable')
  const details = result.stdout + result.stderr
  for (const [key, value] of [['Identifier', expected.bundleId], ['TeamIdentifier', expected.teamId], ['CDHash', expected.cdhash], ['Authority', expected.signingIdentity]]) check(details.split('\n').includes(`${key}=${value}`), 'historical signature ' + key + ' mismatch')
  check(hashPhysicalAppBundle(app) === expected.bundleSha256, 'historical bundle bytes mismatch')
  return { ...expected, historicalRelease: true, artifactSha256: entry.artifactSha256, provenance: 'frozen_archive_and_signed_bundle', appExecuted: false }
}
async function historicalDownload(url) {
  const signal = AbortSignal.timeout(20 * 60_000)
  const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url)
    check(parsed.protocol === 'https:' && hosts.has(parsed.hostname) && !parsed.username && !parsed.password, 'historical redirect/source is not approved HTTPS')
    const response = await fetch(parsed, { redirect: 'manual', signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location'); check(location, 'historical redirect lacks location')
    await response.body?.cancel()
    url = new URL(location, parsed).href
  }
  throw new Error('historical source exceeded redirect limit')
}
export async function prepareHistoricalUpgradeApps({ workspace, output, archivesDirectory }) {
  workspace = path.resolve(workspace); output = path.resolve(output)
  check(fs.realpathSync(workspace) === workspace && fs.lstatSync(workspace).isDirectory(), 'historical workspace must be canonical')
  check(output.startsWith(workspace + path.sep) && !fs.existsSync(output) && fs.realpathSync(path.dirname(output)) === path.dirname(output), 'historical output must be new inside canonical workspace')
  const root = path.join(workspace, 'historical-apps'); fs.mkdirSync(root, { mode: 0o700 })
  const records = []
  for (const entry of loadHistoricalUpgradeApps()) {
    const stage = path.join(root, entry.version); fs.mkdirSync(stage, { mode: 0o700 })
    const archive = path.join(stage, entry.assetName)
    if (archivesDirectory) fs.copyFileSync(path.join(path.resolve(archivesDirectory), entry.assetName), archive, fs.constants.COPYFILE_EXCL)
    else {
      const response = await historicalDownload(entry.sourceUrl)
      check(response.status === 200 && response.body, 'historical release download failed')
      const fd = fs.openSync(archive, 'wx', 0o600); let total = 0
      try { for await (const chunk of response.body) { total += chunk.length; check(total <= entry.artifactSizeBytes, 'historical download exceeds size'); const bytes = Buffer.from(chunk); let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset) } fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    }
    fs.chmodSync(archive, 0o400); validateHistoricalUpgradeArchive(archive, entry)
    const destination = path.join(stage, 'app')
    extractPartialCandidateAppArchive(archive, entry.artifactSha256, destination, path.join(stage, 'snapshot.zip'))
    const app = path.join(destination, 'Tide Mind.app'), identity = inspectHistoricalUpgradeApp(app, entry.version)
    records.push({ version: entry.version, app, identity })
  }
  const observations = { schemaVersion: 1, kind: 'historical_signed_app_inputs', status: 'prepared_not_upgrade_acceptance', appsExecuted: false, records }
  fs.writeFileSync(output, JSON.stringify(observations, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return observations
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), values = {}
    for (let index = 0; index < args.length; index += 2) {
      check(['--workspace', '--output', '--archives-directory'].includes(args[index]) && !values[args[index]] && args[index + 1], 'invalid historical preparation arguments'); values[args[index]] = args[index + 1]
    }
    check(values['--workspace'] && values['--output'], 'historical --workspace and --output are required')
    console.log(JSON.stringify(await prepareHistoricalUpgradeApps({ workspace: values['--workspace'], output: values['--output'], archivesDirectory: values['--archives-directory'] })))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
