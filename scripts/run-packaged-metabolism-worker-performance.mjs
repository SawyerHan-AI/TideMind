#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { materializeMetabolismPerformanceRunner } from './materialize-metabolism-performance-runner.mjs'
import { createCpuUtilizationSampler } from './cpu-utilization-sampler.mjs'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const clientDir = path.join(repoRoot, 'client')
const runner = path.join(repoRoot, 'scripts', 'run-metabolism-worker-electron-performance.mjs')
const builder = path.join(clientDir, 'node_modules', '.bin', 'electron-builder')
const releaseDir = path.join(clientDir, 'release', 'metabolism-performance-arm64')
const spotlightMarker = path.join(clientDir, 'release', '.metadata_never_index')
const app = path.join(releaseDir, 'mac-arm64', 'Tide Mind.app')
const executable = path.join(app, 'Contents', 'MacOS', 'Tide Mind')
const forwarded = []
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  if (argument !== '--output' || forwarded.length > 0 || index + 1 >= process.argv.length) {
    throw new Error('packaged performance accepts only one optional --output <json-path> argument')
  }
  forwarded.push('--output', process.argv[++index])
}
const retainedOutput = forwarded.length > 0 ? path.resolve(forwarded[1]) : null
if (retainedOutput && fs.existsSync(retainedOutput)) {
  throw new Error(`packaged performance output already exists: ${retainedOutput}`)
}
const thresholds = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-candidate-thresholds.json'), 'utf8'))
const maximumCpuUtilization = thresholds.environment?.cpuUtilizationMax
const cpuSampleMinimumWindowMs = thresholds.environment?.cpuSampleMinimumWindowMs
if (typeof maximumCpuUtilization !== 'number' || maximumCpuUtilization <= 0 || maximumCpuUtilization >= 1
  || !Number.isSafeInteger(cpuSampleMinimumWindowMs) || cpuSampleMinimumWindowMs < 500) {
  throw new Error('invalid frozen CPU utilization environment gate')
}
const trustedRunnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-performance-runner-'))
fs.chmodSync(trustedRunnerRoot, 0o700)
const trustedRunner = path.join(trustedRunnerRoot, 'runner.mjs')
const temporaryResult = path.join(trustedRunnerRoot, 'result.json')

function assertExactHead(expectedHead) {
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  if (actualHead !== expectedHead || status !== '') {
    throw new Error(`packaged performance source drifted: expected ${expectedHead}, got ${actualHead}, dirty=${status !== ''}`)
  }
}

async function waitForStableHost() {
  const deadline = performance.now() + 15 * 60_000
  let consecutiveSamples = 0
  const sampler = createCpuUtilizationSampler({ minimumWindowMs: cpuSampleMinimumWindowMs })
  while (performance.now() < deadline) {
    const utilization = await sampler.sample()
    if (utilization <= maximumCpuUtilization) consecutiveSamples++
    else consecutiveSamples = 0
    if (consecutiveSamples >= 3) return
  }
  throw new Error(`host did not stabilize below ${maximumCpuUtilization * 100}% CPU utilization before the packaged performance run`)
}

try {
  const exactHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  assertExactHead(exactHead)
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync('npm', ['--prefix', 'client', 'run', 'build:bin'], { cwd: repoRoot, stdio: 'inherit' })
  assertExactHead(exactHead)
  fs.mkdirSync(path.dirname(spotlightMarker), { recursive: true })
  fs.writeFileSync(spotlightMarker, '')
  execFileSync(process.execPath, [runner, '--prepare-only'], { cwd: repoRoot, stdio: 'inherit' })
  fs.rmSync(releaseDir, { recursive: true, force: true })
  execFileSync(builder, [
    '--dir', '--arm64',
    '--config.directories.output=release/metabolism-performance-arm64',
    '--config.extraMetadata.main=out/metabolism-performance-harness.cjs',
  ], {
    cwd: clientDir,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
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
  assertExactHead(exactHead)
  // Packaged mode is deliberately absent from the checked-in low-level runner:
  // only this fresh-build wrapper materializes a one-shot copy after all
  // source/package fences pass. An environment variable is not a trust root.
  const runnerSource = materializeMetabolismPerformanceRunner(fs.readFileSync(runner, 'utf8'), repoRoot)
  fs.writeFileSync(trustedRunner, runnerSource, { mode: 0o700, flag: 'wx' })
  execFileSync(process.execPath, [
    trustedRunner, '--skip-build', '--packaged', '--electron-executable', executable, '--output', temporaryResult,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
  assertExactHead(exactHead)
  if (forwarded.length > 0) {
    fs.copyFileSync(temporaryResult, retainedOutput, fs.constants.COPYFILE_EXCL)
  }
} finally {
  fs.rmSync(releaseDir, { recursive: true, force: true })
  fs.rmSync(path.join(clientDir, 'out', 'metabolism-performance-harness.cjs'), { force: true })
  fs.rmSync(spotlightMarker, { force: true })
  fs.rmSync(trustedRunnerRoot, { recursive: true, force: true })
}
