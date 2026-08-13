#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const releaseDir = path.resolve(argument('--release-dir', 'client/release'))
const arch = argument('--arch')
if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64')
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
const executableArchitectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/)
if (!executableArchitectures.includes(expectedMachArch)) {
  throw new Error(`main executable architecture mismatch: ${executableArchitectures.join(', ')}`)
}
if (!fs.existsSync(path.join(app, 'Contents/embedded.provisionprofile'))) {
  throw new Error('packaged app is missing embedded.provisionprofile')
}

run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
run('/usr/sbin/spctl', ['--assess', '--type', 'exec', '--verbose=2', app])
run('/usr/bin/xcrun', ['stapler', 'validate', app])

const nativeFiles = walk(path.join(app, 'Contents/Resources'))
  .filter((file) => file.endsWith('.node') || file.endsWith('.dylib'))
if (nativeFiles.length === 0) throw new Error('packaged app contains no native modules')
const requiredNativeNames = ['better_sqlite3.node', 'secure-store-mac.node', 'vec0.dylib']
for (const requiredName of requiredNativeNames) {
  if (!nativeFiles.some((file) => path.basename(file) === requiredName)) {
    throw new Error(`packaged app is missing required native module ${requiredName}`)
  }
}
for (const nativeFile of nativeFiles) {
  const description = run('/usr/bin/file', [nativeFile]).trim()
  if (!description.includes(expectedMachArch)) {
    throw new Error(`native architecture mismatch for ${nativeFile}: ${description}`)
  }
}

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
