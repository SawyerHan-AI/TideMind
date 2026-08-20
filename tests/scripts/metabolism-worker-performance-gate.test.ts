import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { readReleaseWorkflow } from '../helpers/release-workflow.js'

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
    protocolVersion: 2,
    status: 'refrozen-before-external-cpu-fix-results',
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
    protocolVersion: 2,
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

  it('latches any focus loss across the complete foreground writer workload', () => {
    const harness = fs.readFileSync(path.join(repoRoot, 'scripts', 'metabolism-worker-electron-performance-harness.ts'), 'utf8')
    const writerStart = harness.indexOf('let focusedRendererIpcWrites = false')
    const writerEnd = harness.indexOf('const eventLoopDelayMs =', writerStart)
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
