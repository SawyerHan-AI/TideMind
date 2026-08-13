#!/usr/bin/env node
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { evaluateMetabolismPerformanceResult } from './evaluate-metabolism-performance-result.mjs'
import { createCpuUtilizationSampler } from './cpu-utilization-sampler.mjs'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const clientDir = path.join(repoRoot, 'client')
const bundleDir = path.join(clientDir, 'out')
fs.mkdirSync(bundleDir, { recursive: true })
const bundlePath = path.join(bundleDir, 'metabolism-performance-harness.cjs')
const executableIndex = process.argv.indexOf('--electron-executable')
const explicitExecutable = executableIndex >= 0 ? process.argv[executableIndex + 1] : null
if (executableIndex >= 0 && !explicitExecutable) throw new Error('--electron-executable requires a path')
const packaged = process.argv.includes('--packaged')
const prepareOnly = process.argv.includes('--prepare-only')
const skipBuild = process.argv.includes('--skip-build')
const electronPath = explicitExecutable
  ? path.resolve(explicitExecutable)
  : path.join(clientDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const writesPerKind = process.argv.includes('--no-writers') ? 0 : 100
const outputIndex = process.argv.indexOf('--output')
const retainedOutput = outputIndex >= 0 ? process.argv[outputIndex + 1] : null
if (outputIndex >= 0 && !retainedOutput) throw new Error('--output requires a JSON path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-electron-perf-'))
fs.chmodSync(root, 0o700)
const home = path.join(root, 'home')
fs.mkdirSync(home, { mode: 0o700 })
const resultPath = path.join(root, 'result.json')

async function waitForStableHost(thresholds) {
  const maximumCpuUtilization = thresholds?.environment?.cpuUtilizationMax
  const minimumWindowMs = thresholds?.environment?.cpuSampleMinimumWindowMs
  if (typeof maximumCpuUtilization !== 'number' || maximumCpuUtilization <= 0 || maximumCpuUtilization >= 1
    || !Number.isSafeInteger(minimumWindowMs) || minimumWindowMs < 500) {
    throw new Error('invalid frozen CPU utilization environment gate')
  }
  const sampler = createCpuUtilizationSampler({ minimumWindowMs })
  const deadline = performance.now() + 15 * 60_000
  let consecutiveSamples = 0
  while (consecutiveSamples < 3 && performance.now() < deadline) {
    const utilization = await sampler.sample()
    consecutiveSamples = utilization <= maximumCpuUtilization ? consecutiveSamples + 1 : 0
  }
  if (consecutiveSamples < 3) {
    throw new Error(`host did not restabilize below ${maximumCpuUtilization * 100}% CPU utilization after packaged preflights`)
  }
}

try {
  if (packaged && (prepareOnly || writesPerKind !== 100)) {
    throw new Error('packaged performance forbids prepare-only and requires exactly 100 writes per foreground workload')
  }
  if (packaged) {
    throw new Error('packaged performance is only available through run-packaged-metabolism-worker-performance.mjs')
  }
  if (!fs.existsSync(electronPath)) throw new Error('Electron executable is not installed')
  const sourceWorker = path.join(clientDir, 'out', 'bin', 'metabolism-worker.cjs')
  if (!fs.existsSync(sourceWorker)) throw new Error('metabolism Worker bundle is missing; run npm --prefix client run build:bin')
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const initialStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (packaged && initialStatus !== '') throw new Error('packaged performance requires a clean exact Git worktree')
  if (!skipBuild) await build({
    entryPoints: [path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'sqlite-vec'],
    plugins: [{
      name: 'server-source-alias',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@server\// }, args => ({
          path: path.join(repoRoot, 'src', args.path.slice('@server/'.length).replace(/\.js$/, '.ts')),
        }))
      },
    }],
    define: { 'import.meta.url': '__tm_bundle_url__' },
    banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' },
    logLevel: 'silent',
  })
  if (prepareOnly) {
    process.stdout.write(`${bundlePath}\n`)
    fs.rmSync(root, { recursive: true, force: true })
    process.exit(0)
  }
  let ownerTerminateReacquire = false
  let orphanCliProcessGroupsAfterShutdown = -1
  const thresholdsPath = path.join(repoRoot, 'scripts', 'metabolism-worker-candidate-thresholds.json')
  const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'))
  if (packaged) {
    const app = path.resolve(path.dirname(electronPath), '../..')
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'smoke-packaged-metabolism-worker.mjs'), '--app', app, '--arch', 'arm64'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    execFileSync(path.join(repoRoot, 'node_modules', '.bin', 'vitest'), ['run', 'tests/client/metabolism-worker-forced-termination.test.ts'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    ownerTerminateReacquire = true
    orphanCliProcessGroupsAfterShutdown = 0
    // The smoke and forced-termination preflights intentionally exercise CPU,
    // native modules, and process teardown. Stabilize again after them so the
    // retained candidate sample cannot inherit their transient load.
    await waitForStableHost(thresholds)
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, packaged ? [] : [bundlePath], {
      cwd: clientDir,
      env: {
        ...process.env,
        HOME: home,
        NODE_PATH: path.join(clientDir, 'node_modules'),
        TIDEMIND_PERF_ROOT: root,
        TIDEMIND_PERF_CLIENT_DIR: clientDir,
        TIDEMIND_PERF_RESULT: resultPath,
        TIDEMIND_PERF_WRITES_PER_KIND: String(writesPerKind),
        TIDEMIND_USE_LEGACY_KEYCHAIN: '1',
        EB_LOG_LEVEL: 'error',
        TIDEMIND_PERF_OWNER_TERMINATE_REACQUIRE: ownerTerminateReacquire ? '1' : '0',
        TIDEMIND_PERF_ORPHAN_CLI_PROCESS_GROUPS: String(orphanCliProcessGroupsAfterShutdown),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', exitCode => resolve(exitCode ?? 1))
  })
  if (!fs.existsSync(resultPath)) throw new Error(`Electron performance harness exited ${code} without a result`)
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  if (code !== 0 || result.error) throw new Error(result.error ?? `Electron performance harness exited ${code}`)

  const maximumCpuUtilization = thresholds.environment?.cpuUtilizationMax
  const failures = evaluateMetabolismPerformanceResult({ result, thresholds, packaged, writesPerKind, maximumCpuUtilization })
  result.thresholdEvaluation = {
    protocolVersion: thresholds.protocolVersion,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
  }
  if (packaged) {
    const appContents = path.resolve(path.dirname(electronPath), '..')
    const assets = {
      executable: electronPath,
      appAsar: path.join(appContents, 'Resources', 'app.asar'),
      workerBundle: path.join(appContents, 'Resources', 'app.asar.unpacked', 'out', 'bin', 'metabolism-worker.cjs'),
    }
    const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    result.provenance = {
      gitHead: actualHead,
      thresholdSha256: crypto.createHash('sha256').update(fs.readFileSync(thresholdsPath)).digest('hex'),
      sourceWorkerSha256: crypto.createHash('sha256').update(fs.readFileSync(sourceWorker)).digest('hex'),
      assets: Object.fromEntries(Object.entries(assets).map(([name, file]) => [name, {
        bytes: fs.statSync(file).size,
        sha256: sha256(file),
      }])),
    }
    if (result.provenance.assets.workerBundle.sha256 !== result.provenance.sourceWorkerSha256) {
      failures.push('packaged/source Worker bundle mismatch')
    }
  }
  const finalHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const finalStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (packaged && (finalHead !== actualHead || finalStatus !== '')) failures.push('source drift during measurement')
  result.thresholdEvaluation.status = failures.length === 0 ? 'passed' : 'failed'
  result.thresholdEvaluation.failures = failures
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (retainedOutput && failures.length === 0) fs.writeFileSync(path.resolve(retainedOutput), `${JSON.stringify(result, null, 2)}\n`)
  if (failures.length > 0) throw new Error(`Electron performance thresholds failed: ${failures.join(', ')}`)
} finally {
  if (!prepareOnly) fs.rmSync(bundlePath, { force: true })
  fs.rmSync(root, { recursive: true, force: true })
}
