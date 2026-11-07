#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { materializeMetabolismPerformanceRunner } from './materialize-metabolism-performance-runner.mjs'
import { assertPerformanceReleaseAccepted } from './metabolism-performance-release-exception.mjs'
import { verifyAgentIntegrationExactSource } from './agent-integration-gate-provenance.mjs'
import { assertLockedLocalPackagedDependencies, localPackagedMetabolismIdentity, validateLocalPackagedMetabolismReceipt } from './local-packaged-metabolism-evidence.mjs'
import {
  createCpuUtilizationSampler,
  externalCpuUtilizationBetween,
} from './cpu-utilization-sampler.mjs'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const clientDir = path.join(repoRoot, 'client')
const runner = path.join(repoRoot, 'scripts', 'run-metabolism-worker-electron-performance.mjs')
const builder = path.join(clientDir, 'node_modules', '.bin', 'electron-builder')
const releaseDir = path.join(clientDir, 'release', 'metabolism-performance-arm64')
const spotlightMarker = path.join(clientDir, 'release', '.metadata_never_index')
const app = path.join(releaseDir, 'mac-arm64', 'Tide Mind.app')
const executable = path.join(app, 'Contents', 'MacOS', 'Tide Mind')
const args = process.argv.slice(2)
const [outputFlag, output] = args
if (args.length !== 0 && (args.length !== 2 || !['--output', '--local-release-receipt'].includes(outputFlag)
  || !output || output.startsWith('--') || (outputFlag === '--local-release-receipt' && !path.isAbsolute(output)))) {
  throw new Error('packaged performance accepts only one optional --output <json-path> or --local-release-receipt <absolute-json-path> argument')
}
const retainedOutput = output ? path.resolve(output) : null
if (retainedOutput && fs.lstatSync(retainedOutput, { throwIfNoEntry: false })) {
  throw new Error(`packaged performance output already exists: ${retainedOutput}`)
}
const thresholds = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-candidate-thresholds.json'), 'utf8'))
const maximumCpuUtilization = thresholds.environment?.cpuUtilizationMax
const cpuSampleMinimumWindowMs = thresholds.environment?.cpuSampleMinimumWindowMs
if (typeof maximumCpuUtilization !== 'number' || maximumCpuUtilization <= 0 || maximumCpuUtilization >= 1
  || !Number.isSafeInteger(cpuSampleMinimumWindowMs) || cpuSampleMinimumWindowMs < 500) {
  throw new Error('invalid frozen CPU utilization environment gate')
}
const localReceipt = outputFlag === '--local-release-receipt'
const measurementEnv = localReceipt ? isolatedLocalMeasurementEnvironment() : process.env
const trustedRunnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-performance-runner-'))
fs.chmodSync(trustedRunnerRoot, 0o700)
const trustedRunner = path.join(trustedRunnerRoot, 'runner.mjs')
const temporaryResult = path.join(trustedRunnerRoot, 'result.json')

function assertExactHead(expectedHead, env) {
  if (localReceipt) {
    verifyAgentIntegrationExactSource({ repoRoot, expectedCommit: expectedHead })
    return
  }
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  }).trim()
  if (actualHead !== expectedHead || status !== '') {
    throw new Error(`packaged performance source drifted: expected ${expectedHead}, got ${actualHead}, dirty=${status !== ''}`)
  }
}

function isolatedLocalMeasurementEnvironment() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('local packaged performance requires native macOS arm64')
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('local packaged performance forbids Node preload and path overrides')
  const userTemp = fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', env: {} }).trim())
  const { HOME: home, TMPDIR: temp, PATH: executablePath } = process.env
  for (const directory of [home, temp]) {
    if (!directory || fs.realpathSync(directory) !== directory || !directory.startsWith(`${userTemp}${path.sep}`)) {
      throw new Error('local packaged performance requires a separate HOME and TMPDIR in the private macOS user temp directory')
    }
    const stat = fs.statSync(directory)
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('local packaged performance HOME and TMPDIR must be owned private directories')
    }
  }
  if (home === temp || fs.lstatSync(path.join(home, '.tidemind'), { throwIfNoEntry: false })) {
    throw new Error('local packaged performance HOME must be separate and contain no Tide Mind profile')
  }
  return {
    PATH: executablePath, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, LANG: 'en_US.UTF-8', CI: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    NPM_CONFIG_USERCONFIG: path.join(home, 'npmrc-user'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'npmrc-global'),
    ...Object.fromEntries(['ELECTRON_CACHE', 'ELECTRON_BUILDER_CACHE', 'npm_config_cache', 'npm_config_offline']
      .filter(key => process.env[key]).map(key => [key, process.env[key]])),
  }
}

async function waitForStableHost() {
  const deadline = performance.now() + 15 * 60_000
  let consecutiveSamples = 0
  const sampler = createCpuUtilizationSampler({
    minimumWindowMs: cpuSampleMinimumWindowMs,
    calculate: externalCpuUtilizationBetween,
  })
  while (performance.now() < deadline) {
    const utilization = await sampler.sample()
    if (utilization <= maximumCpuUtilization) consecutiveSamples++
    else consecutiveSamples = 0
    if (consecutiveSamples >= 3) return
  }
  throw new Error(`host did not stabilize below ${maximumCpuUtilization * 100}% CPU utilization before the packaged performance run`)
}

try {
  const exactHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env: measurementEnv, encoding: 'utf8' }).trim()
  assertExactHead(exactHead, measurementEnv)
  if (localReceipt) assertLockedLocalPackagedDependencies(repoRoot)
  const identity = localReceipt ? localPackagedMetabolismIdentity(repoRoot, exactHead) : null
  const env = localReceipt ? { ...measurementEnv, TIDEMIND_SOURCE_COMMIT: exactHead } : measurementEnv
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, env, stdio: 'inherit' })
  execFileSync('npm', ['--prefix', 'client', 'run', 'build:bin'], { cwd: repoRoot, env, stdio: 'inherit' })
  assertExactHead(exactHead, env)
  fs.mkdirSync(path.dirname(spotlightMarker), { recursive: true })
  fs.writeFileSync(spotlightMarker, '')
  execFileSync(process.execPath, [runner, '--prepare-only'], { cwd: repoRoot, env, stdio: 'inherit' })
  fs.rmSync(releaseDir, { recursive: true, force: true })
  execFileSync(builder, [
    '--dir', '--arm64',
    '--config.directories.output=release/metabolism-performance-arm64',
    '--config.extraMetadata.main=out/metabolism-performance-harness.cjs',
  ], {
    cwd: clientDir,
    env: { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    stdio: 'inherit',
  })
  if (!fs.existsSync(executable)) throw new Error('packaged performance executable was not created')
  const sourceWorker = path.join(clientDir, 'out', 'bin', 'metabolism-worker.cjs')
  const packagedWorker = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'bin', 'metabolism-worker.cjs')
  const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (sha256(sourceWorker) !== sha256(packagedWorker)) {
    throw new Error('packaged Worker bundle does not match the freshly built source bundle')
  }
  // Packaging/native rebuilds and unrelated local suites can transiently
  // saturate the shared development Mac. Do not retain a pass or failure from
  // that environment: require three independent minimum-window CPU samples first.
  await waitForStableHost()
  assertExactHead(exactHead, env)
  // Packaged mode is deliberately absent from the checked-in low-level runner:
  // only this fresh-build wrapper materializes a one-shot copy after all
  // source/package fences pass. An environment variable is not a trust root.
  const runnerSource = materializeMetabolismPerformanceRunner(fs.readFileSync(runner, 'utf8'), repoRoot)
  fs.writeFileSync(trustedRunner, runnerSource, { mode: 0o700, flag: 'wx' })
  execFileSync(process.execPath, [
    trustedRunner, '--skip-build', '--packaged', '--electron-executable', executable, '--output', temporaryResult,
  ], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  })
  assertExactHead(exactHead, env)
  const receipt = JSON.parse(fs.readFileSync(temporaryResult, 'utf8'))
  const appVersion = JSON.parse(fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8')).version
  const rootVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  assertPerformanceReleaseAccepted(receipt, { appVersion: appVersion === rootVersion ? appVersion : null, packaged: true })
  if (identity) {
    assertLockedLocalPackagedDependencies(repoRoot)
    const evidence = { schemaVersion: 1, kind: 'local-packaged-metabolism-performance', ...identity, result: receipt }
    validateLocalPackagedMetabolismReceipt(evidence, { root: repoRoot, sourceCommit: exactHead, worker: sourceWorker })
    fs.writeFileSync(retainedOutput, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } else if (retainedOutput) {
    fs.copyFileSync(temporaryResult, retainedOutput, fs.constants.COPYFILE_EXCL)
  }
} finally {
  fs.rmSync(releaseDir, { recursive: true, force: true })
  fs.rmSync(path.join(clientDir, 'out', 'metabolism-performance-harness.cjs'), { force: true })
  fs.rmSync(spotlightMarker, { force: true })
  fs.rmSync(trustedRunnerRoot, { recursive: true, force: true })
}
