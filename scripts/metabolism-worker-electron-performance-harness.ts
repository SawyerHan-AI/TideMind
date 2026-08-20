import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { app, BrowserWindow, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { ensureSchema } from '../src/db/schema.js'
import { runSynapticScaling } from '../src/metabolism/synaptic.js'
import { ALL_TASKS } from '../src/metabolism/tasks.js'
import {
  cpuEnvironmentUtilizationsBetween,
  createCpuUtilizationSampler,
  externalCpuUtilizationBetween,
} from './cpu-utilization-sampler.mjs'
import { tryAcquireSchedulerRunLock } from '../src/metabolism/scheduler-run-lock.js'
import { createNoteSource, updateNoteSource } from '../src/integrations/shared/note-sources.js'
import { createOutboxTable, enqueueOutbox } from '../client/electron/cloud/outbox.js'
import {
  getMetabolismWorkerExecutionDiagnostics,
  startDaemon,
  stopDaemon,
  triggerImmediateSchedulerTick,
} from '../client/electron/daemon.js'
import { getActivityState } from '../client/electron/activity-state.js'
import { getSchedulerExecutionMode } from '../client/electron/scheduler-execution-mode.js'

const root = process.env.TIDEMIND_PERF_ROOT
const clientDir = process.env.TIDEMIND_PERF_CLIENT_DIR
const resultPath = process.env.TIDEMIND_PERF_RESULT
if (!root || !clientDir || !resultPath) throw new Error('performance harness environment is incomplete')

let stopCandidateCpuSampling: (() => Promise<void>) | null = null

const canonicalRoot = fs.realpathSync.native(root)
const canonicalTmp = fs.realpathSync.native(os.tmpdir())
if (path.relative(canonicalTmp, canonicalRoot).startsWith('..')) throw new Error('performance root must be inside the OS temp directory')
if (fs.lstatSync(canonicalRoot).isSymbolicLink()) throw new Error('performance root must not be a symlink')

const dataDir = path.join(canonicalRoot, 'home', '.tidemind')
const dbPath = path.join(dataDir, 'graph', 'brain.sqlite')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })
fs.mkdirSync(path.join(canonicalRoot, 'electron-user-data'), { recursive: true })
app.setPath('userData', path.join(canonicalRoot, 'electron-user-data'))
if (!app.isPackaged) app.setAppPath(clientDir)

const NODE_COUNT = 10_000
const LINK_COUNT = 20_000
const WRITES_PER_KIND = Number(process.env.TIDEMIND_PERF_WRITES_PER_KIND ?? '100')
const ownerTerminateReacquire = process.env.TIDEMIND_PERF_OWNER_TERMINATE_REACQUIRE === '1'
const orphanCliProcessGroupsAfterShutdown = Number(process.env.TIDEMIND_PERF_ORPHAN_CLI_PROCESS_GROUPS)
if (!Number.isSafeInteger(WRITES_PER_KIND) || WRITES_PER_KIND < 0 || WRITES_PER_KIND > 1_000) {
  throw new Error('invalid performance writer count')
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0
}

function createFixture(filePath: string): Database.Database {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 10000')
  db.pragma('wal_autocheckpoint = 0')
  ensureSchema(db)
  const timestamp = new Date(0).toISOString()
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence, created, updated)
    VALUES (?, 'fact', ?, ?, ?, 0.3, ?, 0.2, ?, ?)
  `)
  const insertLink = db.prepare(`
    INSERT INTO links (id, from_id, to_id, relation, strength, status, created, updated)
    VALUES (?, ?, ?, '[]', ?, 'confirmed', ?, ?)
  `)
  db.transaction(() => {
    for (let index = 0; index < NODE_COUNT; index++) {
      insertNode.run(`node-${index}`, `synthetic node ${index}`, `Node ${index}`, 0.75, (index % 1000) / 1000, timestamp, timestamp)
    }
    for (let index = 0; index < LINK_COUNT; index++) {
      insertLink.run(`link-${index}`, `node-${index % NODE_COUNT}`, `node-${(index * 17 + 1) % NODE_COUNT}`, 0.75, timestamp, timestamp)
    }
  })()
  return db
}

function setOnlyTasksDue(db: Database.Database, dueTaskIds: readonly string[]): void {
  const current = String(Date.now())
  const due = new Set(dueTaskIds)
  const write = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
  db.transaction(() => {
    for (const task of ALL_TASKS) write.run(`last_task_${task.id}`, due.has(task.id) ? '1577836800000' : current)
  })()
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function waitForSchedulerOwnerFree(db: Database.Database, timeoutMs: number): Promise<void> {
  await waitFor(() => {
    const lock = tryAcquireSchedulerRunLock(db)
    if (!lock.acquired) return false
    lock.lock.release()
    return true
  }, timeoutMs, 'scheduler owner release')
}

function measureMainThreadStall(run: () => void): { durationMs: number; delaysMs: number[] } {
  const startedAt = performance.now()
  run()
  const durationMs = performance.now() - startedAt
  // runSynapticScaling is one uninterrupted synchronous main-isolate call. Its
  // wall time is therefore the exact interval in which the Electron main loop
  // cannot service another callback; using a timer after the call would also
  // include unrelated post-run queueing and can exceed the actual block.
  return { durationMs, delaysMs: [durationMs] }
}

async function main(): Promise<void> {
  const loadAverageAtStart = os.loadavg()
  const cpuUtilizationSamples: number[] = []
  const thresholds = JSON.parse(fs.readFileSync(path.join(clientDir, '..', 'scripts', 'metabolism-worker-candidate-thresholds.json'), 'utf8'))
  const maximumCpuUtilization = thresholds?.environment?.cpuUtilizationMax
  const cpuSampleMinimumWindowMs = thresholds?.environment?.cpuSampleMinimumWindowMs
  if (typeof maximumCpuUtilization !== 'number' || maximumCpuUtilization <= 0 || maximumCpuUtilization >= 1
    || !Number.isSafeInteger(cpuSampleMinimumWindowMs) || cpuSampleMinimumWindowMs < 500) {
    throw new Error('invalid frozen CPU utilization sample window')
  }
  const cpuSampler = createCpuUtilizationSampler({
    minimumWindowMs: cpuSampleMinimumWindowMs,
    calculate: externalCpuUtilizationBetween,
  })
  const sampleCpuUtilization = async (): Promise<number> => {
    const utilization = await cpuSampler.sample()
    cpuUtilizationSamples.push(utilization)
    return utilization
  }
  const waitForStableCpuBoundary = async (label: string): Promise<number> => {
    const deadline = performance.now() + 15 * 60_000
    let consecutiveSamples = 0
    let utilization = 1
    while (consecutiveSamples < 3 && performance.now() < deadline) {
      utilization = await cpuSampler.sample()
      consecutiveSamples = utilization <= maximumCpuUtilization ? consecutiveSamples + 1 : 0
    }
    if (consecutiveSamples < 3) throw new Error(`host did not stabilize at ${label}`)
    cpuUtilizationSamples.push(utilization)
    return utilization
  }
  // Starting the packaged Electron host loads native modules and can create a
  // short CPU burst even when the wrapper was previously idle. Establish the
  // retained baseline only after that process-local startup has settled.
  const cpuUtilizationAtStart = await waitForStableCpuBoundary('packaged harness start')
  const mainBaselineRunsMs: number[] = []
  const mainBaselineEventLoopDelaysMs: number[] = []
  const mainBaselineHostCpuUtilization: number[] = []
  const mainBaselineProcessCpuUtilization: number[] = []
  const mainBaselineExternalCpuUtilization: number[] = []
  const mainBaselineCpuWindows: Array<{ host: number; process: number; external: number }> = []
  const baseline = createFixture(path.join(canonicalRoot, 'baseline.sqlite'))
  for (let run = 0; run < 3; run++) {
    baseline.transaction(() => {
      baseline.prepare('UPDATE nodes SET heat = 0.75, archived = 0, is_superseded = 0').run()
      baseline.prepare("UPDATE links SET strength = 0.75, status = 'confirmed', deleted = 0").run()
    })()
    baseline.pragma('wal_checkpoint(TRUNCATE)')
    const measurement = measureMainThreadStall(() => runSynapticScaling(baseline))
    mainBaselineRunsMs.push(measurement.durationMs)
    mainBaselineEventLoopDelaysMs.push(...measurement.delaysMs)
    // This complete CPU-time window begins at the prior stable boundary (or
    // prior baseline sample) and spans the synchronous run. Reject external
    // host contention during the comparison baseline instead of allowing it
    // to inflate the relative Worker improvement.
    const baselineCpuSample = await cpuSampler.sampleSnapshot()
    const baselineCpu = cpuEnvironmentUtilizationsBetween(baselineCpuSample.previous, baselineCpuSample.current)
    mainBaselineHostCpuUtilization.push(baselineCpu.host)
    mainBaselineProcessCpuUtilization.push(baselineCpu.process)
    mainBaselineExternalCpuUtilization.push(baselineCpu.external)
    mainBaselineCpuWindows.push(baselineCpu)
    if (baselineCpu.external > maximumCpuUtilization) {
      throw new Error(`main baseline external CPU environment exceeded the frozen limit: run=${run + 1}, host=${baselineCpu.host.toFixed(4)}, process=${baselineCpu.process.toFixed(4)}, external=${baselineCpu.external.toFixed(4)}, limit=${maximumCpuUtilization.toFixed(4)}`)
    }
  }
  baseline.close()
  const mainBaselineMs = percentile(mainBaselineRunsMs, 0.5)
  // The synchronous baseline is intentionally CPU-heavy. It is comparison
  // work, not candidate environment evidence. Require the host to settle again
  // before admitting any Worker candidate task, then monitor the candidate
  // continuously from that stable boundary.
  const cpuUtilizationBeforeCandidate = await waitForStableCpuBoundary('post-baseline candidate boundary')
  let continueCpuSampling = true
  const candidateCpuSampling = (async (): Promise<void> => {
    while (continueCpuSampling) await sampleCpuUtilization()
  })()
  void candidateCpuSampling.catch(() => { /* observed again by the stop barrier */ })
  let candidateCpuSamplingStop: Promise<void> | null = null
  stopCandidateCpuSampling = (): Promise<void> => {
    candidateCpuSamplingStop ??= (async (): Promise<void> => {
      continueCpuSampling = false
      await candidateCpuSampling
    })()
    return candidateCpuSamplingStop
  }

  const db = createFixture(dbPath)
  createOutboxTable(db)
  const noteSource = createNoteSource(db, {
    name: 'performance-source',
    toolType: 'obsidian',
    path: path.join(canonicalRoot, 'notes'),
    pollInterval: 60,
  })
  fs.mkdirSync(path.join(canonicalRoot, 'notes'))
  setOnlyTasksDue(db, ['synaptic-decay'])

  await app.whenReady()
  const window = new BrowserWindow({
    show: true,
    width: 640,
    height: 480,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  })
  await window.loadURL('data:text/html,<html><body>metabolism performance harness</body></html>')
  app.focus({ steal: true })
  window.show()
  window.focus()

  ipcMain.handle('perf:writer', (_event, kind: string, sequence: number) => {
    if (kind === 'renderer') {
      db.prepare('UPDATE nodes SET title = ?, edit_seq = edit_seq + 1, updated = ? WHERE id = ?')
        .run(`renderer-${sequence}`, new Date().toISOString(), `node-${sequence % NODE_COUNT}`)
    } else if (kind === 'note') {
      updateNoteSource(db, noteSource.id, { name: `performance-source-${sequence}` })
    } else if (kind === 'cloud') {
      enqueueOutbox(db, 'perf', { sequence }, 'performance-harness')
    } else {
      throw new Error('unknown performance writer')
    }
    return true
  })

  const writerSamples: Record<'renderer' | 'note' | 'cloud', number[]> = { renderer: [], note: [], cloud: [] }
  const runWriter = async (kind: keyof typeof writerSamples): Promise<void> => {
    for (let sequence = 0; sequence < WRITES_PER_KIND; sequence++) {
      const startedAt = performance.now()
      await window.webContents.executeJavaScript(
        `require('electron').ipcRenderer.invoke('perf:writer', ${JSON.stringify(kind)}, ${sequence})`,
        true,
      )
      writerSamples[kind].push(performance.now() - startedAt)
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  getSchedulerExecutionMode().sampleWindow(null)
  const candidateCpuStartedAt = process.cpuUsage()
  const countSynapticEvents = (): number => (db.prepare(
    "SELECT COUNT(*) AS count FROM timeline_events WHERE subtype = 'synaptic_scaling'",
  ).get() as { count: number }).count
  const beginWorkerTiming = (): Promise<number> => {
    const initialEvents = countSynapticEvents()
    return (async (): Promise<number> => {
    await waitFor(
      () => Number(db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").pluck().get()) > 1_600_000_000_000,
      30_000,
      'background synaptic claim',
    )
    const startedAt = performance.now()
    await waitFor(() => countSynapticEvents() > initialEvents, 30_000, 'background synaptic completion')
    await waitForSchedulerOwnerFree(db, 30_000)
    return performance.now() - startedAt
    })()
  }
  const resetSynapticFixture = (): void => {
    db.transaction(() => {
      db.prepare('UPDATE nodes SET heat = 0.75, archived = 0, is_superseded = 0').run()
      db.prepare('UPDATE links SET strength = 0.75, status = ?, deleted = 0').run('confirmed')
      setOnlyTasksDue(db, ['synaptic-decay'])
    })()
    // Fixture reset is harness setup, not candidate work. Checkpoint it before
    // timing so the measured pass owns only the WAL it actually produces.
    db.pragma('wal_checkpoint(TRUNCATE)')
  }

  const workerRunsMs: number[] = []
  const initialTiming = beginWorkerTiming()
  await startDaemon()
  workerRunsMs.push(await initialTiming)
  for (let run = 1; run < 3; run++) {
    await new Promise(resolve => setTimeout(resolve, 25))
    resetSynapticFixture()
    const timing = beginWorkerTiming()
    await triggerImmediateSchedulerTick()
    workerRunsMs.push(await timing)
  }
  const workerRuntimeMs = percentile(workerRunsMs, 0.5)

  const mode = getSchedulerExecutionMode()
  const activity = getActivityState()
  await waitFor(() => {
    app.focus({ steal: true })
    window.show()
    window.focus()
    return window.isFocused()
  }, 5_000, 'focused writer BrowserWindow focus')
  mode.sampleWindow(window)
  if (mode.getMode() !== 'foreground') throw new Error('writer workload BrowserWindow did not become foreground')
  let focusedRendererIpcWrites = false
  let focusLostDuringWriterWorkload = false
  const markWriterFocusLost = (): void => { focusLostDuringWriterWorkload = true }
  window.on('blur', markWriterFocusLost)
  window.on('hide', markWriterFocusLost)
  window.on('minimize', markWriterFocusLost)
  const eventLoop = monitorEventLoopDelay({ resolution: 1 })
  try {
    resetSynapticFixture()
    eventLoop.enable()
    const writerPromises = [runWriter('renderer'), runWriter('note'), runWriter('cloud')]
    const contentionTiming = beginWorkerTiming()
    await triggerImmediateSchedulerTick()
    await contentionTiming
    await Promise.all(writerPromises)
    await waitForSchedulerOwnerFree(db, 30_000)
    if (focusLostDuringWriterWorkload || !window.isFocused()) throw new Error('writer workload BrowserWindow lost focus')
    focusedRendererIpcWrites = true
  } finally {
    window.off('blur', markWriterFocusLost)
    window.off('hide', markWriterFocusLost)
    window.off('minimize', markWriterFocusLost)
    eventLoop.disable()
  }
  const eventLoopDelayMs = {
    p50: eventLoop.percentile(50),
    p95: eventLoop.percentile(95),
    p99: eventLoop.percentile(99),
    max: eventLoop.max,
  }

  const metadataWrite = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
  metadataWrite.run('circuit_breaker_failures', '5')
  metadataWrite.run('circuit_breaker_opened_at', String(Date.now()))
  metadataWrite.run('circuit_breaker_cooldown_ms', String(60 * 60 * 1_000))
  metadataWrite.run('embedding_circuit_failures', '5')
  metadataWrite.run('embedding_circuit_opened_at', String(Date.now()))
  metadataWrite.run('embedding_circuit_cooldown_ms', String(60 * 60 * 1_000))
  metadataWrite.run('llm_last_success_at', String(Date.now()))
  window.hide()
  mode.sampleWindow(window)
  if (mode.getMode() !== 'background') throw new Error('full backlog workload did not enter background mode')
  setOnlyTasksDue(db, ALL_TASKS.map(task => task.id))
  const fullBacklogStartedAt = performance.now()
  await triggerImmediateSchedulerTick()
  await waitFor(
    () => Number(db.prepare("SELECT value FROM metadata WHERE key = 'last_task_structure-holes-precompute'").pluck().get()) > 1_600_000_000_000,
    60_000,
    'background full backlog completion',
  )
  await waitForSchedulerOwnerFree(db, 60_000)
  const backgroundFullBacklogMs = performance.now() - fullBacklogStartedAt
  db.prepare("DELETE FROM metadata WHERE key IN ('circuit_breaker_failures', 'circuit_breaker_opened_at', 'circuit_breaker_cooldown_ms', 'embedding_circuit_failures', 'embedding_circuit_opened_at', 'embedding_circuit_cooldown_ms')").run()

  await waitFor(() => {
    app.focus({ steal: true })
    window.show()
    window.focus()
    return window.isFocused()
  }, 5_000, 'foreground BrowserWindow focus')
  mode.sampleWindow(window)
  if (mode.getMode() !== 'foreground') throw new Error('harness BrowserWindow did not become foreground')
  setOnlyTasksDue(db, ['synaptic-decay', 'keystone-enrich'])
  await triggerImmediateSchedulerTick()
  await waitFor(() => Number(db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").pluck().get()) > 1_600_000_000_000, 30_000, 'foreground attempt')
  const foregroundKeystone = Number(db.prepare("SELECT value FROM metadata WHERE key = 'last_task_keystone-enrich'").pluck().get())
  if (foregroundKeystone > 1_600_000_000_000) throw new Error('foreground pass admitted more than one task attempt')

  setOnlyTasksDue(db, ['synaptic-decay'])
  const suspendedClaim = String(db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").pluck().get())
  mode.notifySuspend()
  activity.notifySuspend()
  await triggerImmediateSchedulerTick()
  await new Promise(resolve => setTimeout(resolve, 250))
  if (String(db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").pluck().get()) !== suspendedClaim) {
    throw new Error('paused scheduler admitted a task')
  }
  activity.notifyResume('resume')
  mode.notifyResume(window)
  await waitFor(() => String(db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").pluck().get()) !== suspendedClaim, 30_000, 'resume trigger')

  const executionDiagnostics = getMetabolismWorkerExecutionDiagnostics()
  await stopDaemon()
  const loadAverageAtEnd = os.loadavg()
  await stopCandidateCpuSampling()
  stopCandidateCpuSampling = null
  const cpuUtilizationAtEnd = cpuUtilizationSamples.at(-1) ?? cpuUtilizationBeforeCandidate
  const candidateCpu = process.cpuUsage(candidateCpuStartedAt)
  const walPath = `${dbPath}-wal`
  const walBytesBeforeCheckpoint = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  const checkpoint = db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>
  const toMs = (nanoseconds: number): number => nanoseconds / 1_000_000
  const result = {
    protocolVersion: 2,
    measuredAt: new Date().toISOString(),
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      loadAverageAtStart,
      loadAverageAtEnd,
      cpuUtilizationGate: {
        start: cpuUtilizationAtStart,
        baselineHostMaximumObserved: Math.max(...mainBaselineHostCpuUtilization),
        baselineProcessMaximumObserved: Math.max(...mainBaselineProcessCpuUtilization),
        baselineExternalMaximumObserved: Math.max(...mainBaselineExternalCpuUtilization),
        baselineWindows: mainBaselineCpuWindows,
        beforeCandidate: cpuUtilizationBeforeCandidate,
        maximumObserved: Math.max(...cpuUtilizationSamples),
        end: cpuUtilizationAtEnd,
      },
      memoryBytes: os.totalmem(),
      os: `${os.type()} ${os.release()}`,
      arch: process.arch,
      electronVersion: process.versions.electron,
    },
    fixture: { nodeCount: NODE_COUNT, linkCount: LINK_COUNT, writesPerKind: WRITES_PER_KIND, dataRoot: 'ephemeral-temp-only' },
    workloads: { focusedRendererIpcWrites, backgroundFullBacklog: true },
    throughput: { mainBaselineRunsMs, workerRunsMs, mainBaselineMs, workerRuntimeMs, workerVsMainBaselineRatio: mainBaselineMs / workerRuntimeMs },
    mainBaselineEventLoopDelayMs: {
      p50: percentile(mainBaselineEventLoopDelaysMs, 0.5),
      p95: percentile(mainBaselineEventLoopDelaysMs, 0.95),
      p99: percentile(mainBaselineEventLoopDelaysMs, 0.99),
      max: percentile(mainBaselineEventLoopDelaysMs, 1),
    },
    backgroundFullBacklog: { durationMs: backgroundFullBacklogMs, llmAndEmbeddingTasksCircuitGated: true },
    eventLoopDelayMs: Object.fromEntries(Object.entries(eventLoopDelayMs).map(([key, value]) => [key, toMs(value)])),
    resourceUsage: {
      cpuUserMs: candidateCpu.user / 1_000,
      cpuSystemMs: candidateCpu.system / 1_000,
      walBytesBeforeCheckpoint,
      checkpoint: checkpoint[0] ?? null,
    },
    foregroundWriterDelayMs: Object.fromEntries(Object.entries(writerSamples).map(([kind, values]) => [kind, { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: percentile(values, 1) }])),
    correctness: {
      foregroundSingleAttempt: true,
      suspendResume: true,
      workerOwnerTerminateReacquire: ownerTerminateReacquire,
      unexpectedSqliteBusyOrLocked: executionDiagnostics.sqliteContentionEvents,
      concurrentSchedulerPasses: executionDiagnostics.concurrentSchedulerPasses,
      mainThreadSchedulerTaskExecutions: executionDiagnostics.mainThreadSchedulerTaskExecutions,
      orphanCliProcessGroupsAfterShutdown,
    },
  }
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  ipcMain.removeHandler('perf:writer')
  window.destroy()
  db.close()
  app.quit()
}

void main().catch(async error => {
  try { await stopCandidateCpuSampling?.() } catch { /* preserve primary failure */ }
  stopCandidateCpuSampling = null
  try { await stopDaemon() } catch { /* preserve primary failure */ }
  try { fs.writeFileSync(resultPath, `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, { mode: 0o600 }) } catch { /* preserve primary failure */ }
  process.exitCode = 1
  app.quit()
})
