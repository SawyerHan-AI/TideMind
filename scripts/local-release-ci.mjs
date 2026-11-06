#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fingerprintTree, protectedRealAgentPaths } from './agent-integration-ui-e2e-home-guard.mjs'
import {
  captureAgentIntegrationGateProvenance,
  sameAgentIntegrationGateProvenance,
  validateAgentIntegrationGateProvenance,
  verifyAgentIntegrationExactSource,
} from './agent-integration-gate-provenance.mjs'
import {
  validateAgentIntegrationUiE2eReceipt,
  verifyAgentIntegrationUiE2eEvidence,
} from './agent-integration-ui-e2e-evidence.mjs'
import { evaluateAgentIntegrationPerformanceResult } from './evaluate-agent-integration-performance-result.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packages = [
  ['root', '.'],
  ['client', 'client'],
  ['cloud', 'pro/cloud-server'],
  ['website', 'pro/website'],
]
const themes = ['dark', 'light']
const receiptNames = ['performance', ...themes]
const healthChecks = [
  'root lint', 'root build', 'worker bundle', 'root test', 'root audit',
  'cloud typecheck', 'cloud test', 'cloud audit', 'website typecheck',
  'website build', 'website audit', 'client build', 'client typecheck',
  'client audit', 'mac packaging',
]
const checkIds = [
  ...packages.map(([name]) => `audit-lock-${name}`),
  ...packages.map(([name]) => `install-${name}`),
  'install-electron', 'node-sqlite-abi', 'electron-sqlite-abi',
  'health', 'cloud-security', 'i18n', 'version-sync',
  'audit-root', 'audit-client', 'audit-cloud', 'release-dry-run',
  'agent-manifest', 'agent-performance',
  ...themes.flatMap(theme => [`ui-${theme}`, `verify-${theme}`]),
]
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const digest = file => sha256(fs.readFileSync(file))
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const logHeader = (id, sourceCommit) => `Local release CI ${id} at ${sourceCommit}\n`

function inputIdentity(root, sourceCommit, version) {
  assert.match(sourceCommit, /^[a-f0-9]{40,64}$/u, 'expected an exact source commit')
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'expected an exact release version')
  const source = verifyAgentIntegrationExactSource({ repoRoot: root, expectedCommit: sourceCommit })
  assert.equal(readJson(path.join(root, 'package.json')).version, version, 'release version mismatch')
  const locks = Object.fromEntries(packages.map(([, dir]) => {
    const lock = path.posix.join(dir, 'package-lock.json')
    return [lock, digest(path.join(root, lock))]
  }))
  const electronVersion = readJson(path.join(root, 'client/package-lock.json')).packages?.['node_modules/electron']?.version
  assert.match(electronVersion ?? '', /^\d+\.\d+\.\d+$/u, 'missing locked Electron version')
  return { source, version, locks, electronVersion }
}

function privateFile(file) {
  const stat = fs.lstatSync(file)
  assert.ok(stat.isFile() && (stat.mode & 0o077) === 0, 'expected a private ordinary evidence file')
  return fs.readFileSync(file)
}

export function sealLocalCiOutput(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    assert.ok(stat.isFile() && stat.nlink === 1, 'expected an regular collector output with one link')
    fs.fchmodSync(fd, 0o600)
    return fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
}

function validNodeVersion(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? '')) return false
  const [major, minor] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 13)
}

export function assertNoLocalCiEnvironmentFiles(root) {
  for (const [, dir] of packages) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name !== '.env' && !entry.name.startsWith('.env.')) continue
      if (entry.isFile() && entry.name.endsWith('.example')) continue
      throw new Error(`local CI refuses environment files in ${dir}`)
    }
  }
}

export function localCiEnvironment(sourceCommit, home, temp, hostPath) {
  return {
    PATH: [path.dirname(process.execPath), hostPath].filter(Boolean).join(path.delimiter),
    HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    NPM_CONFIG_USERCONFIG: path.join(home, 'npmrc-user'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'npmrc-global'),
    LANG: 'en_US.UTF-8', CI: '1', TIDEMIND_CI_SOURCE_HEAD: sourceCommit, TIDEMIND_SOURCE_COMMIT: sourceCommit,
  }
}

export function createLocalCiScratch() {
  // The clean caller may have no TMPDIR, and the CLI rejects ancestors in public /tmp.
  const userTemp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', env: {} }).trim()
  assert.ok(path.isAbsolute(userTemp), 'macOS did not return an absolute user temporary directory')
  const root = fs.realpathSync(userTemp)
  const stat = fs.statSync(root)
  assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
    'macOS user temporary directory must be private and owned by the current user')
  return fs.mkdtempSync(path.join(root, 'tidemind-local-ci-'))
}

export function installLocalCiElectron(client, electronVersion, run) {
  const electronPackage = path.join(client, 'node_modules', 'electron')
  assert.equal(readJson(path.join(electronPackage, 'package.json')).version, electronVersion,
    'installed Electron package differs from its lock')
  // Electron's npm package may be present without a downloaded distribution.
  run('install-electron', process.execPath, ['node_modules/electron/install.js'], client)
  const electronAbi = fs.readFileSync(path.join(electronPackage, 'abi_version'), 'utf8').trim()
  const executable = 'Electron.app/Contents/MacOS/Electron'
  assert.equal(fs.readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim(), executable,
    'installed Electron path differs from the native distribution')
  return { electron: path.join(electronPackage, 'dist', executable), electronAbi }
}

export function validateLocalElectronProbe(probe, electronVersion, abi) {
  assert.ok(probe?.electron === electronVersion && probe.platform === 'darwin'
    && probe.arch === 'arm64' && /^\d+$/u.test(abi ?? '') && probe.modules === abi,
  'Electron runtime version, architecture or ABI differs from the locked installation')
}

export function validateLocalCiManifest(manifest, expected, readLog) {
  assert.equal(manifest?.protocolVersion, 1, 'local evidence protocol mismatch')
  assert.equal(manifest.kind, 'trusted-operator-local-release-ci', 'local evidence kind mismatch')
  assert.deepEqual(manifest.identity, expected, 'local evidence source, version or lock files differ')
  assert.ok(manifest.platform?.os === 'darwin' && manifest.platform.arch === 'arm64'
    && validNodeVersion(manifest.platform.node), 'local evidence must come from macOS arm64 with Node 22.13+')
  assert.equal(manifest.platform.linuxMatrix, 'not-run', 'local evidence misstates workflow coverage')
  assert.deepEqual(manifest.checks?.map(step => step.id), checkIds, 'local evidence has missing or unexpected checks')
  assert.deepEqual(Object.keys(manifest.receipts ?? {}).sort(), [...receiptNames].sort(), 'local evidence receipt set differs')
  for (const receipt of receiptNames) assert.match(manifest.receipts[receipt], /^[a-f0-9]{64}$/u, 'invalid receipt digest')
  const windowStart = Date.parse(manifest.startedAt)
  const windowEnd = Date.parse(manifest.completedAt)
  let previousEnd = windowStart
  for (const step of manifest.checks) {
    assert.equal(step.exitCode, 0, `local check did not pass: ${step.id}`)
    const start = Date.parse(step.startedAt)
    const end = Date.parse(step.completedAt)
    assert.ok(start >= previousEnd && end >= start && end <= windowEnd, `invalid local check window: ${step.id}`)
    previousEnd = end
    const log = readLog(step.id)
    const header = Buffer.from(logHeader(step.id, expected.source.sourceCommit))
    assert.ok(log.length > header.length && log.subarray(0, header.length).equals(header)
      && sha256(log) === step.logSha256, `local check log differs: ${step.id}`)
    if (step.id === 'health') {
      const lines = log.toString('utf8').split(/\r?\n/u)
      assert.ok(healthChecks.every(check => lines.some(line => line.startsWith(`| ${check} | PASS |`)))
        && !lines.some(line => line.startsWith('| ') && /\| (?:FAIL|SOFT_FAIL) \|/u.test(line)),
      'health log is missing required PASS results')
    }
    if (step.id === 'electron-sqlite-abi') {
      const record = log.toString('utf8').split(/\r?\n/u).find(line => line.startsWith('Electron runtime '))
      assert.ok(record, 'missing Electron runtime probe')
      validateLocalElectronProbe(JSON.parse(record.slice('Electron runtime '.length)), expected.electronVersion, manifest.electronAbi)
    }
  }
}

function performanceFile(root) {
  return path.join(root, 'agent-integration-performance.json')
}

function uiFiles(root, theme) {
  return {
    receipt: path.join(root, `agent-integration-ui-${theme}.json`),
    evidence: path.join(root, `agent-integration-ui-${theme}-evidence`),
  }
}

export function readBoundLocalCiReceipt(bytes, expectedDigest) {
  assert.equal(sha256(bytes), expectedDigest, 'retained local CI receipt digest mismatch')
  return JSON.parse(bytes.toString('utf8'))
}

function verifyRetainedGates(root, evidenceDir, manifest) {
  const expected = { ...manifest.identity.source, worktreeClean: true,
    buildManifestSha256: manifest.build?.buildManifestSha256, buildFileCount: manifest.build?.buildFileCount }
  const performance = readBoundLocalCiReceipt(privateFile(performanceFile(evidenceDir)), manifest.receipts.performance)
  const thresholdsPath = path.join(root, 'scripts/agent-integration-performance-thresholds.json')
  const harnessPath = path.join(root, 'scripts/agent-integration-performance-harness.ts')
  const thresholds = readJson(thresholdsPath)
  assert.deepEqual(validateAgentIntegrationGateProvenance(performance.provenance, expected), [], 'performance provenance mismatch')
  assert.equal(performance.provenance.thresholdSha256, digest(thresholdsPath), 'performance thresholds differ')
  assert.equal(performance.provenance.harnessSha256, digest(harnessPath), 'performance harness differs')
  assert.deepEqual(performance.thresholdEvaluation, { protocolVersion: thresholds.protocolVersion, status: 'passed', failures: [] },
    'performance did not pass')
  assert.deepEqual(evaluateAgentIntegrationPerformanceResult({ result: performance, thresholds }), [],
    'performance measurements do not meet current thresholds')
  for (const theme of themes) {
    const files = uiFiles(evidenceDir, theme)
    const receipt = readBoundLocalCiReceipt(privateFile(files.receipt), manifest.receipts[theme])
    assert.deepEqual(validateAgentIntegrationUiE2eReceipt(receipt), [], `invalid ${theme} UI receipt`)
    assert.deepEqual(validateAgentIntegrationGateProvenance(receipt.provenance, expected), [], `${theme} UI provenance mismatch`)
    verifyAgentIntegrationUiE2eEvidence({ evidenceDir: files.evidence, expectedManifestSha256: receipt.evidenceManifestSha256 })
    const report = JSON.parse(privateFile(path.join(files.evidence, 'ui-e2e-report.json')).toString('utf8'))
    assert.equal(report.ok, true, `${theme} UI report did not pass`)
    assert.equal(report.uiAssertions?.theme, theme, 'UI evidence theme mismatch')
    const verifiedLine = privateFile(path.join(evidenceDir, `verify-${theme}.log`)).toString('utf8')
      .split(/\r?\n/u).findLast(line => line.startsWith('{"status":"passed",'))
    assert.ok(verifiedLine, `${theme} check did not record gate verification`)
    const verified = JSON.parse(verifiedLine)
    assert.deepEqual(verified, {
      status: 'passed',
      sourceCommit: expected.sourceCommit,
      sourceManifestSha256: expected.sourceManifestSha256,
      buildManifestSha256: expected.buildManifestSha256,
      evidenceManifestSha256: receipt.evidenceManifestSha256,
    }, `${theme} check log is not bound to the retained evidence`)
  }
}

function verify(root, evidenceDir, sourceCommit, version) {
  assert.ok(fs.lstatSync(evidenceDir).isDirectory() && (fs.statSync(evidenceDir).mode & 0o077) === 0,
    'local evidence must be in a private ordinary directory')
  const manifest = JSON.parse(privateFile(path.join(evidenceDir, 'local-ci.json')).toString('utf8'))
  validateLocalCiManifest(manifest, inputIdentity(root, sourceCommit, version),
    id => privateFile(path.join(evidenceDir, `${id}.log`)))
  verifyRetainedGates(root, evidenceDir, manifest)
  console.log(`Verified local release CI for ${version} at ${sourceCommit} (macOS arm64, Node ${manifest.platform.node}). Linux/Node matrix was not run.`)
}

function collect(root, evidenceDir, sourceCommit, version) {
  assert.ok(process.platform === 'darwin' && process.arch === 'arm64' && validNodeVersion(process.versions.node),
    'collect requires macOS arm64 with Node 22.13+')
  assertNoLocalCiEnvironmentFiles(root)
  const identity = inputIdentity(root, sourceCommit, version)
  fs.mkdirSync(evidenceDir, { mode: 0o700 })
  const scratch = createLocalCiScratch()
  const home = path.join(scratch, 'home')
  const temp = path.join(scratch, 'tmp')
  const env = localCiEnvironment(sourceCommit, home, temp, process.env.PATH)
  const platform = { os: process.platform, arch: process.arch, node: process.versions.node, linuxMatrix: 'not-run' }
  const checks = []
  const receipts = {}
  const startedAt = new Date().toISOString()
  const run = (id, command, args, cwd = root, extraEnv = {}) => {
    assert.equal(id, checkIds[checks.length], 'local check plan drift')
    const logPath = path.join(evidenceDir, `${id}.log`)
    const fd = fs.openSync(logPath, 'wx', 0o600)
    const startedAt = new Date().toISOString()
    let result
    try {
      fs.writeSync(fd, logHeader(id, sourceCommit))
      result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', fd, fd] })
      if (result.error || result.status !== 0) throw new Error(`Local check failed: ${id}. See the private log.`)
      // The official installer can exit successfully without producing output.
      if (id === 'install-electron') fs.writeSync(fd, '\nElectron installer exited successfully.\n')
    } finally { fs.closeSync(fd) }
    checks.push({ id, exitCode: result.status, startedAt, completedAt: new Date().toISOString(), logSha256: digest(logPath) })
    console.log(`PASS ${id}`)
  }
  try {
    fs.mkdirSync(home, { mode: 0o700 })
    fs.mkdirSync(temp, { mode: 0o700 })
    fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, '', { mode: 0o600 })
    fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '', { mode: 0o600 })
    for (const [id, dir] of packages) run(`audit-lock-${id}`, 'npm', ['audit', '--package-lock-only', '--audit-level=high'], path.join(root, dir))
    for (const [id, dir] of packages) run(`install-${id}`, 'npm', ['ci'], path.join(root, dir))
    const sqliteProbe = 'const db = new (require("better-sqlite3"))(":memory:"); if (db.prepare("SELECT 1 AS ok").get().ok !== 1) process.exit(1); db.close();'
    const client = path.join(root, 'client')
    const { electron, electronAbi } = installLocalCiElectron(client, identity.electronVersion, run)
    run('node-sqlite-abi', process.execPath, ['-e', `${sqliteProbe} console.log(process.versions)`])
    run('electron-sqlite-abi', electron, ['-e', `${sqliteProbe} console.log('Electron runtime ' + JSON.stringify({
      electron: process.versions.electron, modules: process.versions.modules, arch: process.arch, platform: process.platform }))`],
      client, { ELECTRON_RUN_AS_NODE: '1' })
    const electronProbe = privateFile(path.join(evidenceDir, 'electron-sqlite-abi.log')).toString('utf8')
      .split(/\r?\n/u).find(line => line.startsWith('Electron runtime '))
    assert.ok(electronProbe, 'missing Electron runtime probe')
    validateLocalElectronProbe(JSON.parse(electronProbe.slice('Electron runtime '.length)), identity.electronVersion, electronAbi)
    run('health', 'npm', ['run', 'health'])
    run('cloud-security', 'npm', ['run', 'test:security'], path.join(root, 'pro/cloud-server'))
    run('i18n', process.execPath, ['scripts/check-i18n-parity.mjs'])
    run('version-sync', process.execPath, ['scripts/check-version-sync.mjs'])
    for (const [id, dir] of packages.slice(0, 3)) run(`audit-${id}`, 'npm', ['audit', '--audit-level=high'], path.join(root, dir))
    const ossRepo = path.join(scratch, 'oss')
    // A real release is never run here. Match the existing CI dry-run fixture.
    for (const args of [
      ['init', '-q', '-b', 'main', ossRepo],
      ['-C', ossRepo, '-c', 'user.email=ci@tidemind.ai', '-c', 'user.name=TideMind CI',
        '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'isolated release fixture'],
    ]) assert.equal(spawnSync('git', args, { cwd: scratch, env, stdio: 'ignore' }).status, 0, 'could not prepare the isolated OSS fixture')
    run('release-dry-run', 'npm', ['run', 'release', '--', '--dry-run', '--allow-non-main', '--oss-repo', ossRepo, '--timeout-minutes', '1', '--yes'])
    run('agent-manifest', process.execPath, ['scripts/check-agent-integration-bundled-release.mjs'])
    const built = captureAgentIntegrationGateProvenance({ repoRoot: root, expectedCommit: sourceCommit })
    const performance = performanceFile(evidenceDir)
    run('agent-performance', 'npm', ['run', 'measure:agent-integration', '--', '--output', performance])
    receipts.performance = sha256(sealLocalCiOutput(performance))
    // The E2E script's normal HOME guard now sees the disposable HOME.
    // Keep an independent read-only before/after guard on actual host targets.
    const protectedPaths = protectedRealAgentPaths(os.userInfo().homedir)
    const originals = protectedPaths.map(fingerprintTree)
    for (const theme of themes) {
      const files = uiFiles(evidenceDir, theme)
      try {
        run(`ui-${theme}`, process.execPath, ['scripts/run-agent-integration-electron-ui-e2e.mjs',
          '--receipt', files.receipt, '--evidence-dir', files.evidence], root, { TIDEMIND_UI_E2E_THEME: theme })
      } finally {
        assert.deepEqual(protectedPaths.map(fingerprintTree), originals, 'isolated UI E2E changed real Agent configuration')
      }
      receipts[theme] = sha256(privateFile(files.receipt))
      run(`verify-${theme}`, 'npm', ['run', 'verify:agent-integration-gates', '--', '--performance', performance,
        '--ui-e2e', files.receipt, '--ui-evidence', files.evidence])
    }
    assertNoLocalCiEnvironmentFiles(root)
    assert.deepEqual(inputIdentity(root, sourceCommit, version), identity, 'local check source or locks changed')
    assert.ok(sameAgentIntegrationGateProvenance(built, captureAgentIntegrationGateProvenance({ repoRoot: root, expectedCommit: sourceCommit })),
      'local check build changed')
    const build = { buildManifestSha256: built.buildManifestSha256, buildFileCount: built.buildFileCount }
    const manifest = { protocolVersion: 1, kind: 'trusted-operator-local-release-ci', identity, platform, build, electronAbi, receipts,
      startedAt, completedAt: new Date().toISOString(), checks }
    validateLocalCiManifest(manifest, identity, id => privateFile(path.join(evidenceDir, `${id}.log`)))
    verifyRetainedGates(root, evidenceDir, manifest)
    fs.writeFileSync(path.join(evidenceDir, 'local-ci.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log('Local macOS evidence collected. Linux/Node matrix was not run.')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, directoryFlag, directory, sourceFlag, sourceCommit, versionFlag, version, ...rest] = process.argv.slice(2)
    if (!['collect', 'verify'].includes(command) || directoryFlag !== '--evidence-dir' || !directory
      || sourceFlag !== '--source-commit' || versionFlag !== '--version' || rest.length !== 0) {
      throw new Error('Usage: node scripts/local-release-ci.mjs collect|verify --evidence-dir PATH --source-commit SHA --version X.Y.Z')
    }
    const absolute = path.resolve(directory)
    const evidenceDir = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
    const sourceRoot = fs.realpathSync(repoRoot)
    if (evidenceDir === sourceRoot || evidenceDir.startsWith(`${sourceRoot}${path.sep}`)) throw new Error('local evidence must stay outside the source checkout')
    if (command === 'collect') collect(repoRoot, evidenceDir, sourceCommit, version)
    else verify(repoRoot, evidenceDir, sourceCommit, version)
  } catch (error) {
    process.stderr.write(`Local release CI rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
