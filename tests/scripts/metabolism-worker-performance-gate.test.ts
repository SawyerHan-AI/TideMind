import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { load as loadYaml } from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { readReleaseWorkflow } from '../helpers/release-workflow.js'
// @ts-expect-error local plain-ESM script
import { assertLockedLocalPackagedDependencies, localPackagedMetabolismIdentity, readLocalPackagedMetabolismReceipt, validateLocalPackagedMetabolismReceipt } from '../../scripts/local-packaged-metabolism-evidence.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const temporaryRunnerPrefix = 'tide-metabolism-performance-runner-'
const temporaryHarnessPrefix = 'tide-metabolism-electron-perf-'

function assertNoNewTemporaryDirectories(prefix: string, action: () => void) {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix)))
  action()
  const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix) && !before.has(name))
  expect(after).toEqual([])
}

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

describe('packaged metabolism performance gate', () => {
  const validThresholds = {
    protocolVersion: 3,
    status: 'frozen-before-multitrial-contention-sampling-results',
    scope: 'local packaged Electron metabolism Worker candidate; not a release SLO',
    requiredWorkloads: [
      'focused-renderer-ipc-writes', 'note-source-writes', 'cloud-outbox-writes', 'background-full-backlog',
      'foreground-single-attempt', 'suspend-resume', 'worker-owner-terminate-reacquire',
    ],
    environment: { cpuUtilizationMax: 0.5, cpuSampleMinimumWindowMs: 1000 },
    eventLoopDelayMs: { p95Max: 25, p99Max: 50, absoluteMax: 200, p99ImprovementVsMainBaselineMin: 0.5 },
    foregroundWriterDelayMs: {
      rendererIpcP99Max: 75, rendererIpcAbsoluteMax: 250,
      noteSourceP99Max: 100, noteSourceAbsoluteMax: 500,
      cloudOutboxP99Max: 100, cloudOutboxAbsoluteMax: 500,
    },
    throughput: { workerVsMainBaselineRatioMin: 0.85 },
    correctness: {
      unexpectedSqliteBusyOrLockedMax: 0,
      concurrentSchedulerPassesMax: 1,
      mainThreadSchedulerTaskExecutionsMax: 0,
      orphanCliProcessGroupsAfterShutdownMax: 0,
    },
    gateRule: 'Any failure keeps production activation blocked. Rerun the same workload and thresholds after a targeted fix.',
  }
  const validResult = () => ({
    protocolVersion: 3,
    measuredAt: '2026-08-13T00:00:00.000Z',
    fixture: { nodeCount: 10_000, linkCount: 20_000, writesPerKind: 100, dataRoot: 'ephemeral-temp-only' },
    workloads: { focusedRendererIpcWrites: true, backgroundFullBacklog: true },
    machine: {
      cpu: 'test CPU', cpuCount: 8, memoryBytes: 1024, os: 'test OS', arch: 'arm64', electronVersion: '1.0.0',
      loadAverageAtStart: [1, 1, 1], loadAverageAtEnd: [1, 1, 1],
      cpuUtilizationGate: {
        start: 0.1,
        baselineHostMaximumObserved: 0.2,
        baselineProcessMaximumObserved: 0.1,
        baselineExternalMaximumObserved: 0.1,
        baselineWindows: Array.from({ length: 3 }, () => ({ host: 0.2, process: 0.1, external: 0.1 })),
        beforeCandidate: 0.1,
        maximumObserved: 0.1,
        end: 0.1,
      },
    },
    backgroundFullBacklog: { durationMs: 10, llmAndEmbeddingTasksCircuitGated: true },
    mainBaselineEventLoopDelayMs: { p50: 10, p95: 11, p99: 11, max: 11 },
    contentionRuns: Array.from({ length: 3 }, () => ({
      eventLoopDelayMs: { p50: 1, p95: 3, p99: 5, max: 6 },
      foregroundWriterDelayMs: {
        renderer: { count: 100, p50: 1, p95: 5, p99: 10, max: 20 },
        note: { count: 100, p50: 1, p95: 5, p99: 10, max: 20 },
        cloud: { count: 100, p50: 1, p95: 5, p99: 10, max: 20 },
      },
    })),
    eventLoopDelayMs: { p50: 1, p95: 3, p99: 5, max: 6 },
    throughput: {
      mainBaselineRunsMs: [9, 10, 11], workerRunsMs: [10, 11, 12],
      mainBaselineMs: 10, workerRuntimeMs: 11, workerVsMainBaselineRatio: 10 / 11,
    },
    resourceUsage: {
      cpuUserMs: 10, cpuSystemMs: 5, walBytesBeforeCheckpoint: 100,
      checkpoint: { busy: 0, log: 1, checkpointed: 1 },
    },
    foregroundWriterDelayMs: {
      renderer: { count: 100, p50: 1, p95: 5, p99: 10, max: 20 },
      note: { count: 100, p50: 1, p95: 5, p99: 10, max: 20 },
      cloud: { count: 100, p50: 1, p95: 5, p99: 10, max: 20 },
    },
    correctness: {
      foregroundSingleAttempt: true, suspendResume: true, workerOwnerTerminateReacquire: true,
      unexpectedSqliteBusyOrLocked: 0, concurrentSchedulerPasses: 1,
      mainThreadSchedulerTaskExecutions: 0, orphanCliProcessGroupsAfterShutdown: 0,
    },
  })

  it('accepts the complete internally consistent performance receipt', async () => {
    const { evaluateMetabolismPerformanceResult } = await import('../../scripts/evaluate-metabolism-performance-result.mjs')
    expect(evaluateMetabolismPerformanceResult({
      result: validResult(), thresholds: structuredClone(validThresholds), packaged: true, writesPerKind: 100, maximumCpuUtilization: 0.5,
    })).toEqual([])
  })

  it('uses the median of three contention trials so one noisy trial does not dominate the gate', async () => {
    const { evaluateMetabolismPerformanceResult } = await import('../../scripts/evaluate-metabolism-performance-result.mjs')
    const result = validResult()
    result.contentionRuns[2].eventLoopDelayMs = { p50: 40, p95: 80, p99: 120, max: 180 }
    result.contentionRuns[2].foregroundWriterDelayMs.renderer = { count: 100, p50: 40, p95: 80, p99: 120, max: 180 }
    expect(evaluateMetabolismPerformanceResult({
      result, thresholds: structuredClone(validThresholds), packaged: true, writesPerKind: 100, maximumCpuUtilization: 0.5,
    })).toEqual([])
  })

  it('rejects two noisy contention trials through the bound median summary', async () => {
    const { evaluateMetabolismPerformanceResult } = await import('../../scripts/evaluate-metabolism-performance-result.mjs')
    const result = validResult()
    for (const index of [1, 2]) {
      result.contentionRuns[index].eventLoopDelayMs = { p50: 40, p95: 80, p99: 120, max: 180 }
      result.contentionRuns[index].foregroundWriterDelayMs.renderer = { count: 100, p50: 40, p95: 80, p99: 120, max: 180 }
    }
    result.eventLoopDelayMs = { p50: 40, p95: 80, p99: 120, max: 180 }
    result.foregroundWriterDelayMs.renderer = { count: 100, p50: 40, p95: 80, p99: 120, max: 180 }
    const failures = evaluateMetabolismPerformanceResult({
      result, thresholds: structuredClone(validThresholds), packaged: true, writesPerKind: 100, maximumCpuUtilization: 0.5,
    })
    expect(failures).toContain('event-loop p95')
    expect(failures).toContain('event-loop p99')
    expect(failures).toContain('renderer writer p99')
  })

  it.each(['--prepare-only', '--no-writers'])('rejects wrapper bypass flag %s', flag => {
    assertNoNewTemporaryDirectories(temporaryRunnerPrefix, () => {
      const result = run('run-packaged-metabolism-worker-performance.mjs', [flag])
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('accepts only one optional --output')
    })
  })

  it.each(['--output', '--electron-executable'])('rejects missing low-level argument %s without leaking a temporary directory', flag => {
    assertNoNewTemporaryDirectories(temporaryHarnessPrefix, () => {
      const result = run('run-metabolism-worker-electron-performance.mjs', [flag])
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('requires')
    })
  })

  it('rejects direct packaged prepare-only execution', () => {
    const result = run('run-metabolism-worker-electron-performance.mjs', ['--packaged', '--prepare-only'])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('forbids prepare-only')
  })

  it('rejects direct packaged execution without foreground writer workloads', () => {
    const result = run('run-metabolism-worker-electron-performance.mjs', ['--packaged', '--no-writers'])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('requires exactly 100 writes')
  })

  it('rejects direct packaged execution outside the trusted fresh-build wrapper', () => {
    const result = run('run-metabolism-worker-electron-performance.mjs', [
      '--packaged', '--skip-build', '--electron-executable', '/tmp/stale.app/Contents/MacOS/Tide Mind',
    ])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('only available through run-packaged')
  })

  it('does not accept an environment variable as packaged-run authority', () => {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'run-metabolism-worker-electron-performance.mjs'),
      '--packaged', '--skip-build', '--electron-executable', '/tmp/stale.app/Contents/MacOS/Tide Mind',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, TIDEMIND_PERF_TRUSTED_WRAPPER: '1' },
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('only available through run-packaged')
  })

  it('materializes the one-shot runner in a private directory with repo dependency resolution', () => {
    const wrapper = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-packaged-metabolism-worker-performance.mjs'), 'utf8')
    expect(wrapper).toContain("mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-performance-runner-'))")
    expect(wrapper).toContain('materializeMetabolismPerformanceRunner')
    expect(wrapper).toContain("flag: 'wx'")
    expect(wrapper).toContain('fs.rmSync(trustedRunnerRoot, { recursive: true, force: true })')
    expect(wrapper.indexOf('invalid frozen CPU utilization environment gate')).toBeLessThan(
      wrapper.indexOf("mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-performance-runner-'))"),
    )
  })

  it('charges only external CPU to every environment boundary', () => {
    const wrapper = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-packaged-metabolism-worker-performance.mjs'), 'utf8')
    const runner = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-metabolism-worker-electron-performance.mjs'), 'utf8')
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    for (const source of [wrapper, runner, harness]) {
      expect(source).toContain('calculate: externalCpuUtilizationBetween')
    }
  })

  it('executes the materialized runner with repository dependency resolution', async () => {
    const { materializeMetabolismPerformanceRunner } = await import('../../scripts/materialize-metabolism-performance-runner.mjs')
    const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-metabolism-worker-electron-performance.mjs'), 'utf8')
    const root = fs.mkdtempSync(path.join(repoRoot, '.tmp-materialized-runner-'))
    const generated = path.join(root, 'runner.mjs')
    try {
      fs.writeFileSync(generated, materializeMetabolismPerformanceRunner(source, repoRoot), { flag: 'wx' })
      const result = spawnSync(process.execPath, [
        generated, '--skip-build', '--packaged', '--electron-executable', path.join(root, 'missing-electron'),
      ], { cwd: repoRoot, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('Electron executable is not installed')
      expect(`${result.stdout}${result.stderr}`).not.toContain('MODULE_NOT_FOUND')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('stabilizes the host again after packaged smoke and forced termination preflights', () => {
    const runner = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-metabolism-worker-electron-performance.mjs'), 'utf8')
    const smoke = runner.indexOf('smoke-packaged-metabolism-worker.mjs')
    const forcedTermination = runner.indexOf('metabolism-worker-forced-termination.test.ts', smoke)
    const stabilize = runner.indexOf('await waitForStableHost(thresholds)', forcedTermination)
    const spawnHarness = runner.indexOf('const code = await new Promise', stabilize)
    expect(smoke).toBeGreaterThan(0)
    expect(forcedTermination).toBeGreaterThan(smoke)
    expect(stabilize).toBeGreaterThan(forcedTermination)
    expect(spawnHarness).toBeGreaterThan(stabilize)
  })

  it('restabilizes after the synchronous main baseline before admitting the Worker candidate', () => {
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    const baselineLoop = harness.indexOf('for (let run = 0; run < 3; run++)')
    const restabilize = harness.indexOf("await waitForStableCpuBoundary('post-baseline candidate boundary')", baselineLoop)
    const fixture = harness.indexOf('const db = createFixture(dbPath)', restabilize)
    const startDaemonCall = harness.indexOf('await startDaemon()', fixture)
    expect(baselineLoop).toBeGreaterThan(0)
    expect(restabilize).toBeGreaterThan(baselineLoop)
    expect(fixture).toBeGreaterThan(restabilize)
    expect(startDaemonCall).toBeGreaterThan(fixture)
  })

  it('stabilizes inside the packaged Electron process before measuring the main baseline', () => {
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    const startBoundary = harness.indexOf("await waitForStableCpuBoundary('packaged harness start')")
    const createBaseline = harness.indexOf("createFixture(path.join(canonicalRoot, 'baseline.sqlite'))", startBoundary)
    expect(startBoundary).toBeGreaterThan(0)
    expect(createBaseline).toBeGreaterThan(startBoundary)
  })

  it('measures and rejects host CPU contention across every synchronous main baseline run', () => {
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    const baselineLoop = harness.indexOf('for (let run = 0; run < 3; run++)')
    const baselineEnd = harness.indexOf('baseline.close()', baselineLoop)
    const baselineBlock = harness.slice(baselineLoop, baselineEnd)
    expect(baselineBlock).toContain('const baselineCpuSample = await cpuSampler.sampleSnapshot()')
    expect(baselineBlock).toContain('if (baselineCpu.external > maximumCpuUtilization)')
    expect(harness).toContain('baselineExternalMaximumObserved: Math.max(...mainBaselineExternalCpuUtilization)')
    expect(harness).toContain('baselineHostMaximumObserved: Math.max(...mainBaselineHostCpuUtilization)')
    expect(harness).toContain('baselineProcessMaximumObserved: Math.max(...mainBaselineProcessCpuUtilization)')
    expect(harness).toContain('baselineWindows: mainBaselineCpuWindows')
  })

  it.each([
    ['null timing', (result: any) => { result.eventLoopDelayMs.p99 = null }],
    ['string writer latency', (result: any) => { result.foregroundWriterDelayMs.renderer.p99 = '10' }],
    ['null contention count', (result: any) => { result.correctness.unexpectedSqliteBusyOrLocked = null }],
    ['string threshold', (_result: any, thresholds: any) => { thresholds.eventLoopDelayMs.p99Max = '50' }],
    ['invalid CPU sample window', (_result: any, thresholds: any) => { thresholds.environment.cpuSampleMinimumWindowMs = 0 }],
    ['zero fixture', (result: any) => { result.fixture.nodeCount = 0 }],
    ['short run array', (result: any) => { result.throughput.workerRunsMs = [10, 11] }],
    ['short contention run array', (result: any) => { result.contentionRuns.pop() }],
    ['tampered contention median', (result: any) => { result.eventLoopDelayMs.p99 = 4 }],
    ['invalid contention writer count', (result: any) => { result.contentionRuns[0].foregroundWriterDelayMs.note.count = 99 }],
    ['null retained percentile', (result: any) => { result.foregroundWriterDelayMs.cloud.p50 = null }],
    ['inconsistent ratio', (result: any) => { result.throughput.workerVsMainBaselineRatio = 2 }],
    ['changed workload set', (_result: any, thresholds: any) => { thresholds.requiredWorkloads.pop() }],
    ['invalid CPU utilization', (result: any) => { result.machine.cpuUtilizationGate.start = 2 }],
    ['underreported maximum CPU utilization', (result: any) => { result.machine.cpuUtilizationGate.beforeCandidate = 0.4; result.machine.cpuUtilizationGate.maximumObserved = 0.1 }],
    ['polluted main baseline CPU', (result: any) => { result.machine.cpuUtilizationGate.baselineExternalMaximumObserved = 0.75 }],
    ['underreported baseline external CPU', (result: any) => { result.machine.cpuUtilizationGate.baselineWindows[1].external = 0.01 }],
    ['unbound baseline host maximum', (result: any) => { result.machine.cpuUtilizationGate.baselineHostMaximumObserved = 0.3 }],
    ['impossible baseline process CPU', (result: any) => {
      result.machine.cpuUtilizationGate.baselineWindows = Array.from({ length: 3 }, () => ({ host: 0.2, process: 0.9, external: 0 }))
      result.machine.cpuUtilizationGate.baselineProcessMaximumObserved = 0.9
      result.machine.cpuUtilizationGate.baselineExternalMaximumObserved = 0
    }],
    ['missing writer focus evidence', (result: any) => { result.workloads.focusedRendererIpcWrites = false }],
    ['missing background backlog evidence', (result: any) => { result.workloads.backgroundFullBacklog = false }],
    ['inflated baseline summary', (result: any) => { result.mainBaselineEventLoopDelayMs.p99 = 1e9; result.mainBaselineEventLoopDelayMs.max = 1e9 }],
  ])('fails closed for malformed performance data: %s', async (_label, mutate) => {
    const { evaluateMetabolismPerformanceResult } = await import('../../scripts/evaluate-metabolism-performance-result.mjs')
    const result = validResult()
    const thresholds = structuredClone(validThresholds)
    mutate(result, thresholds)
    const failures = evaluateMetabolismPerformanceResult({ result, thresholds, packaged: true, writesPerKind: 100, maximumCpuUtilization: 0.5 })
    expect(failures.length).toBeGreaterThan(0)
  })

  it('refuses to leave a failed run ambiguous beside an existing retained receipt', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-existing-receipt-'))
    const output = path.join(outputRoot, 'receipt.json')
    try {
      fs.writeFileSync(output, '{"old":true}\n')
      const result = run('run-packaged-metabolism-worker-performance.mjs', ['--output', output])
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('output already exists')
      expect(fs.readFileSync(output, 'utf8')).toBe('{"old":true}\n')
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('refuses ignored harness source shadows before starting a local build', () => {
    const userTemp = fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim())
    const root = fs.mkdtempSync(path.join(userTemp, 'packaged-performance-shadow-'))
    const repo = path.join(root, 'repo')
    const archive = path.join(root, 'source.tar')
    const output = path.join(root, 'receipt.json')
    const home = path.join(root, 'home')
    const temp = path.join(root, 'tmp')
    try {
      for (const directory of [repo, home, temp]) fs.mkdirSync(directory, { mode: 0o700 })
      execFileSync('git', ['archive', `--output=${archive}`, 'HEAD'], { cwd: repoRoot })
      execFileSync('/usr/bin/tar', ['-xf', archive, '-C', repo])
      for (const file of ['run-packaged-metabolism-worker-performance.mjs', 'local-packaged-metabolism-evidence.mjs']) {
        fs.copyFileSync(path.join(repoRoot, 'scripts', file), path.join(repo, 'scripts', file))
      }
      const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
      git(['init', '-q'])
      git(['add', '-A'])
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'source fixture'])
      const shadow = 'src/integrations/shared/note-sources.js'
      fs.writeFileSync(path.join(repo, shadow), 'throw new Error("untracked harness code")\n')
      expect(git(['check-ignore', shadow])).toBe(shadow)
      expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe('')
      const result = spawnSync(process.execPath, ['scripts/run-packaged-metabolism-worker-performance.mjs', '--local-release-receipt', output], {
        cwd: repo, encoding: 'utf8', env: { HOME: home, TMPDIR: temp, PATH: process.env.PATH },
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`shadow=${shadow}`)
      expect(fs.existsSync(output)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('makes the trusted release workflow consume the packaged performance receipt', () => {
    const workflow = readReleaseWorkflow(repoRoot)
    expect(workflow).toContain('Run frozen packaged metabolism performance gate')
    expect(workflow).toContain('npm run measure:metabolism:packaged')
    expect(workflow).toContain('metabolism-performance-receipt-${{ github.sha }}')
    expect(workflow).toContain('if-no-files-found: error')
    expect(workflow).toContain('Bind release Worker to the performance receipt')
    expect(workflow).toContain('performance receipt SHA mismatch')
    expect(workflow).toContain('release Worker differs from performance candidate')
    expect(workflow).toContain('Bind release tag to package version')
    expect(workflow).toContain('does not match client package version')
    expect(fs.existsSync(path.join(repoRoot, 'scripts', 'metabolism-worker-candidate-thresholds.json'))).toBe(true)
  })

  it('checks an explicitly staged local receipt before packaging and rechecks the signed App afterward', () => {
    const workflow = readReleaseWorkflow(repoRoot)
    const first = workflow.split('Run frozen packaged metabolism performance gate')[1].split('Retain packaged metabolism performance receipt')[0]
    expect(first).toContain('if [ -e "$local_receipt" ] || [ -L "$local_receipt" ]; then')
    expect(first).toContain('--receipt "$local_receipt" --source-commit "$TIDEMIND_SOURCE_COMMIT"')
    expect(first).toContain('--worker client/out/bin/metabolism-worker.cjs --copy-to "$receipt"')
    expect(first).toMatch(/else\s+npm run measure:metabolism:packaged -- --output "\$receipt"/u)
    const last = workflow.split('Bind release Worker to the performance receipt')[1].split('Verify signed/notarized package')[0]
    expect(last).toContain('--receipt "$RECEIPT_PATH" --source-commit "$TIDEMIND_SOURCE_COMMIT"')
    expect(last).toContain('--worker client/out/bin/metabolism-worker.cjs --app "$TIDEMIND_ACCEPTED_APP"')
    expect(last).not.toContain('inputs.candidate_only')
  })

  // Keep this historical exception's tests independent of the product version.
  let localFixture: string | undefined
  function localFixtureRoot() {
    if (localFixture) return localFixture
    localFixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-performance-095-fixture-')))
    fs.cpSync(path.join(repoRoot, 'scripts'), path.join(localFixture, 'scripts'), { recursive: true })
    for (const file of ['package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json', 'client/electron-builder.yml', 'client/scripts/build-bin.mjs', 'tests/client/metabolism-worker-forced-termination.test.ts']) {
      const target = path.join(localFixture, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(repoRoot, file), target)
      if (file === 'package.json' || file === 'client/package.json') {
        const value = JSON.parse(fs.readFileSync(target, 'utf8'))
        value.version = '0.2.95'
        fs.writeFileSync(target, JSON.stringify(value))
      }
    }
    return localFixture
  }
  afterAll(() => { if (localFixture) fs.rmSync(localFixture, { recursive: true, force: true }) })

  const sourceCommit = 'a'.repeat(40)
  const workerBytes = Buffer.from('synthetic measured Worker')
  const workerHash = crypto.createHash('sha256').update(workerBytes).digest('hex')
  function localReceipt() {
    const identity = localPackagedMetabolismIdentity(localFixtureRoot(), sourceCommit)
    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client/package-lock.json'), 'utf8'))
    const asset = { bytes: workerBytes.length, sha256: workerHash }
    const measured = validResult()
    return {
      schemaVersion: 1, kind: 'local-packaged-metabolism-performance', ...identity,
      result: {
        ...measured,
        machine: { ...measured.machine, cpu: 'Apple M1 Max', os: 'Darwin 25.5.0', electronVersion: lock.packages['node_modules/electron'].version },
        provenance: {
          gitHead: sourceCommit,
          thresholdSha256: identity.inputSha256['scripts/metabolism-worker-candidate-thresholds.json'],
          sourceWorkerSha256: workerHash, assets: { appAsar: asset, executable: asset, workerBundle: { ...asset } },
        },
        thresholdEvaluation: { protocolVersion: 3, status: 'passed', failures: [] },
      },
    }
  }
  const localReceiptBytes = (receipt = localReceipt()) => Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)

  it.each([
    ['mismatched private source', (receipt: any) => { receipt.sourceCommit = 'b'.repeat(40) }, /source or input/],
    ['rewritten raw Git head', (receipt: any) => { receipt.result.provenance.gitHead = 'b'.repeat(40) }, /measured Git head/],
    ['stale root lock', (receipt: any) => { receipt.inputSha256['package-lock.json'] = workerHash }, /source or input/],
    ['stale client lock', (receipt: any) => { receipt.inputSha256['client/package-lock.json'] = workerHash }, /source or input/],
    ['stale harness', (receipt: any) => { receipt.inputSha256['scripts/metabolism-worker-electron-performance-harness.ts'] = workerHash }, /source or input/],
    ['stale measured thresholds', (receipt: any) => { receipt.result.provenance.thresholdSha256 = workerHash }, /measured threshold/],
    ['stale Electron', (receipt: any) => { receipt.result.machine.electronVersion = '1.0.0' }, /locked macOS/],
    ['bad raw CPU despite passed summary', (receipt: any) => { receipt.result.machine.cpuUtilizationGate.maximumObserved = 0.72 }, /frozen thresholds/],
    ['missing foreground focus', (receipt: any) => { receipt.result.workloads.focusedRendererIpcWrites = false }, /frozen thresholds/],
    ['historical exception', (receipt: any) => { receipt.result.releaseException = { id: '0.2.94-packaged-performance-user-approved' } }, /cannot use an exception/],
    ['unreviewed public data', (receipt: any) => { receipt.result.provenance.assets.workerBundle.logPath = '/private/example' }, /unexpected measurement fields/],
    ['nonstandard machine metadata', (receipt: any) => { receipt.result.machine.cpu = 'Apple M1 Max /private/example' }, /unexpected public measurement metadata/],
    ['different measured Worker', (receipt: any) => { receipt.result.provenance.assets.workerBundle.sha256 = 'b'.repeat(64) }, /packaged Worker differs/],
  ])('rejects local packaged evidence with %s', (_name, mutate, error) => {
    const receipt = localReceipt()
    mutate(receipt)
    expect(() => validateLocalPackagedMetabolismReceipt(receipt, { root: localFixtureRoot(), sourceCommit })).toThrow(error)
  })

  it('binds a local measurement to both the fresh Worker and the Worker in the signed App', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-packaged-performance-'))
    try {
      const app = path.join(temp, 'Tide Mind.app')
      const signedWorker = path.join(app, 'Contents/Resources/app.asar.unpacked/out/bin/metabolism-worker.cjs')
      const worker = path.join(temp, 'fresh-worker.cjs')
      const file = path.join(temp, 'receipt.json')
      fs.mkdirSync(path.dirname(signedWorker), { recursive: true })
      fs.writeFileSync(signedWorker, workerBytes)
      fs.writeFileSync(worker, workerBytes)
      const evidence = localReceiptBytes()
      fs.writeFileSync(file, evidence)
      const options = { root: localFixtureRoot(), sourceCommit, worker, app }
      expect(readLocalPackagedMetabolismReceipt(file, options)).toEqual(evidence)
      fs.writeFileSync(file, evidence.toString('utf8').replace('"schemaVersion": 1', '"schemaVersion": "private extra",\n  "schemaVersion": 1'))
      expect(() => readLocalPackagedMetabolismReceipt(file, options)).toThrow(/original producer JSON/)
      fs.writeFileSync(file, evidence)
      fs.symlinkSync(file, path.join(temp, 'alias.json'))
      expect(() => readLocalPackagedMetabolismReceipt(path.join(temp, 'alias.json'), options)).toThrow()
      fs.writeFileSync(worker, Buffer.alloc(workerBytes.length))
      expect(() => readLocalPackagedMetabolismReceipt(file, options)).toThrow(/freshly built Worker differs/)
      fs.writeFileSync(worker, workerBytes)
      fs.writeFileSync(signedWorker, Buffer.alloc(workerBytes.length))
      expect(() => readLocalPackagedMetabolismReceipt(file, options)).toThrow(/signed App Worker differs/)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('rejects installed SQLite runtimes that differ from the fresh source lockfiles', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-packaged-dependencies-'))
    try {
      for (const [directory, names] of [
        ['.', ['esbuild', 'better-sqlite3', 'sqlite-vec', 'sqlite-vec-darwin-arm64']],
        ['client', ['electron', 'electron-builder', 'better-sqlite3', 'sqlite-vec', 'sqlite-vec-darwin-arm64']],
      ] as const) {
        fs.mkdirSync(path.join(temp, directory), { recursive: true })
        const file = path.join(repoRoot, directory, 'package-lock.json')
        fs.copyFileSync(file, path.join(temp, directory, 'package-lock.json'))
        const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const name of names) {
          const packagePath = `node_modules/${name}`
          fs.mkdirSync(path.join(temp, directory, packagePath), { recursive: true })
          fs.writeFileSync(path.join(temp, directory, packagePath, 'package.json'), JSON.stringify({ name, version: lock.packages[packagePath].version }))
        }
      }
      expect(() => assertLockedLocalPackagedDependencies(temp)).not.toThrow()
      fs.writeFileSync(path.join(temp, 'client/node_modules/better-sqlite3/package.json'), '{"name":"better-sqlite3","version":"0.0.0"}')
      expect(() => assertLockedLocalPackagedDependencies(temp)).toThrow(/client\/better-sqlite3 differs from its lock/)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('executes the hosted gate only when no local receipt was staged', () => {
    const workflow = loadYaml(readReleaseWorkflow(repoRoot)) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> }
    const gate = workflow.jobs['build-mac'].steps.find(step => step.name === 'Run frozen packaged metabolism performance gate')?.run
    expect(gate).toBeTruthy()
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-packaged-performance-workflow-'))
    try {
      for (const directory of ['bin', 'runner', 'client/out/bin', 'release-evidence/local-packaged-metabolism-performance']) {
        fs.mkdirSync(path.join(temp, directory), { recursive: true })
      }
      const proof = path.join(temp, 'release-evidence/local-packaged-metabolism-performance/0.2.95.json')
      const hostedRan = path.join(temp, 'hosted-ran')
      const retained = path.join(temp, 'runner/metabolism-performance-receipt.json')
      const gateEnvironment = path.join(temp, 'github-env')
      fs.writeFileSync(path.join(temp, 'package.json'), '{"version":"0.2.95"}')
      fs.writeFileSync(path.join(temp, 'client/out/bin/metabolism-worker.cjs'), workerBytes)
      fs.writeFileSync(path.join(temp, 'bin/node'), `#!/bin/sh
if [ "$1" = scripts/local-packaged-metabolism-evidence.mjs ]; then
  shift
  exec "$TEST_NODE" "$TEST_VERIFIER" "$@"
fi
exec "$TEST_NODE" "$@"
`, { mode: 0o700 })
      fs.writeFileSync(path.join(temp, 'bin/npm'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEST_HOSTED_GATE"\n', { mode: 0o700 })
      const execute = () => spawnSync('/bin/bash', ['-c', gate!], {
        cwd: temp,
        env: {
          PATH: `${path.join(temp, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          RUNNER_TEMP: path.join(temp, 'runner'), GITHUB_ENV: gateEnvironment,
          TIDEMIND_SOURCE_COMMIT: sourceCommit, TEST_HOSTED_GATE: hostedRan,
          TEST_NODE: process.execPath, TEST_VERIFIER: path.join(localFixtureRoot(), 'scripts/local-packaged-metabolism-evidence.mjs'),
        },
        encoding: 'utf8',
      })
      expect(execute().status).toBe(0)
      expect(fs.readFileSync(hostedRan, 'utf8')).toContain('run measure:metabolism:packaged -- --output')
      fs.unlinkSync(hostedRan)
      fs.symlinkSync(path.join(temp, 'not-found'), proof)
      expect(execute().status).not.toBe(0)
      expect(fs.existsSync(hostedRan)).toBe(false)
      fs.unlinkSync(proof)
      const tampered = localReceipt()
      tampered.result.machine.cpuUtilizationGate.maximumObserved = 0.72
      fs.writeFileSync(proof, localReceiptBytes(tampered))
      expect(execute().stderr).toContain('metrics do not meet the frozen thresholds')
      expect(fs.existsSync(hostedRan)).toBe(false)
      expect(fs.existsSync(gateEnvironment)).toBe(false)
      const original = localReceiptBytes()
      fs.writeFileSync(proof, original)
      const accepted = execute()
      expect(accepted.status, accepted.stderr).toBe(0)
      expect(fs.readFileSync(retained)).toEqual(original)
      expect(fs.readFileSync(gateEnvironment, 'utf8')).toBe('TIDEMIND_LOCAL_PACKAGED_METABOLISM_RECEIPT=true\n')
      expect(fs.existsSync(hostedRan)).toBe(false)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('latches any focus loss across the complete foreground writer workload', () => {
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    const writerStart = harness.indexOf('let focusedRendererIpcWrites = false')
    const writerEnd = harness.indexOf('const metadataWrite =', writerStart)
    expect(writerStart).toBeGreaterThan(0)
    expect(writerEnd).toBeGreaterThan(writerStart)
    const writerBlock = harness.slice(writerStart, writerEnd)
    const trigger = writerBlock.indexOf('await triggerImmediateSchedulerTick()')
    const ownerFree = writerBlock.indexOf('await waitForSchedulerOwnerFree(db, 30_000)')
    const focusCheck = writerBlock.indexOf('if (focusLostDuringWriterWorkload || !window.isFocused())')
    const evidence = writerBlock.indexOf('focusedRendererIpcWrites = true')
    expect(writerBlock).toContain("window.on('blur', markWriterFocusLost)")
    expect(writerBlock).toContain("window.on('hide', markWriterFocusLost)")
    expect(writerBlock).toContain("window.on('minimize', markWriterFocusLost)")
    expect(ownerFree).toBeGreaterThan(trigger)
    expect(focusCheck).toBeGreaterThan(ownerFree)
    expect(evidence).toBeGreaterThan(focusCheck)
    expect(writerBlock).toContain("window.off('blur', markWriterFocusLost)")
  })

  it('establishes the baseline after the same renderer used by the Worker is ready', () => {
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    const loaded = harness.indexOf("await window.loadURL('data:text/html")
    const stableCpu = harness.indexOf("await waitForStableCpuBoundary('packaged harness start')")
    const baseline = harness.indexOf("const baseline = createFixture(")
    const worker = harness.indexOf('await startDaemon()')
    expect(loaded).toBeGreaterThan(0)
    expect(stableCpu).toBeGreaterThan(loaded)
    expect(baseline).toBeGreaterThan(stableCpu)
    expect(worker).toBeGreaterThan(baseline)
  })

  it('enters actual background mode before the full backlog workload', () => {
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    const hide = harness.indexOf('window.hide()')
    const backgroundCheck = harness.indexOf("mode.getMode() !== 'background'", hide)
    const allDue = harness.indexOf('setOnlyTasksDue(db, ALL_TASKS.map', hide)
    const trigger = harness.indexOf('await triggerImmediateSchedulerTick()', allDue)
    expect(hide).toBeGreaterThan(0)
    expect(backgroundCheck).toBeGreaterThan(hide)
    expect(allDue).toBeGreaterThan(backgroundCheck)
    expect(trigger).toBeGreaterThan(allDue)
  })
})
