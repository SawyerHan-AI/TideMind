#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { captureAgentIntegrationGateProvenance } from './agent-integration-gate-provenance.mjs'
import { evaluateAgentIntegrationPerformanceResult } from './evaluate-agent-integration-performance-result.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node scripts/measure-agent-integration-performance.mjs [--output receipt.json]\n')
  process.exit(0)
}
if (args.length !== 0 && !(args.length === 2 && args[0] === '--output')) {
  throw new Error('accepts only one optional --output JSON path')
}
const retainedOutput = args.length === 2 ? path.resolve(args[1]) : null
if (retainedOutput && fs.existsSync(retainedOutput)) throw new Error(`output already exists: ${retainedOutput}`)
if (retainedOutput && !fs.existsSync(path.dirname(retainedOutput))) {
  throw new Error(`output directory does not exist: ${path.dirname(retainedOutput)}`)
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-agent-integration-performance-'))
fs.chmodSync(temporaryRoot, 0o700)
const home = path.join(temporaryRoot, 'home')
const xdgConfig = path.join(temporaryRoot, 'xdg-config')
const xdgData = path.join(temporaryRoot, 'xdg-data')
const xdgCache = path.join(temporaryRoot, 'xdg-cache')
for (const directory of [home, xdgConfig, xdgData, xdgCache]) fs.mkdirSync(directory, { mode: 0o700 })
const bundlePath = path.join(temporaryRoot, 'agent-integration-performance-harness.cjs')
const resultPath = path.join(temporaryRoot, 'result.json')
const thresholdsPath = path.join(repoRoot, 'scripts', 'agent-integration-performance-thresholds.json')
const harnessPath = path.join(repoRoot, 'scripts', 'agent-integration-performance-harness.ts')

try {
  const require = createRequire(import.meta.url)
  const { build } = require('esbuild')
  await build({
    entryPoints: [harnessPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['better-sqlite3'],
    plugins: [{
      name: 'server-source-alias',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@server\// }, resolveArgs => ({
          path: path.join(repoRoot, 'src', resolveArgs.path.slice('@server/'.length).replace(/\.js$/u, '.ts')),
        }))
      },
    }],
    logLevel: 'silent',
  })
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_CACHE_HOME: xdgCache,
        NODE_PATH: [path.join(repoRoot, 'node_modules'), path.join(repoRoot, 'client', 'node_modules')]
          .filter(fs.existsSync)
          .join(path.delimiter),
        TIDEMIND_AGENT_INTEGRATION_PERF_ROOT: temporaryRoot,
        TIDEMIND_AGENT_INTEGRATION_PERF_RESULT: resultPath,
        EB_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  if (!fs.existsSync(resultPath)) throw new Error(`performance harness exited ${exitCode} without a result`)
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  if (exitCode !== 0 || result.error) throw new Error(result.error ?? `performance harness exited ${exitCode}`)
  const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'))
  const failures = evaluateAgentIntegrationPerformanceResult({ result, thresholds })
  const gateProvenance = retainedOutput
    ? captureAgentIntegrationGateProvenance({
      repoRoot,
      expectedCommit: process.env.TIDEMIND_CI_SOURCE_HEAD ?? null,
    })
    : {}
  result.provenance = {
    ...gateProvenance,
    thresholdSha256: crypto.createHash('sha256').update(fs.readFileSync(thresholdsPath)).digest('hex'),
    harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(harnessPath)).digest('hex'),
  }
  result.thresholdEvaluation = {
    protocolVersion: thresholds.protocolVersion,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  process.stdout.write(serialized)
  if (failures.length > 0) throw new Error(`Agent Integration performance thresholds failed: ${failures.join(', ')}`)
  if (retainedOutput) fs.writeFileSync(retainedOutput, serialized, { flag: 'wx', mode: 0o600 })
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
