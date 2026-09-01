import Database from 'better-sqlite3'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..')
const WORKER = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'agent-integration-physical-worker.ts')
const WORKER_TSCONFIG = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'agent-integration-worker-tsconfig.json')
const TSX = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
const roots = new Set<string>()

interface WorkerMessage {
  type: 'killpoint' | 'result' | 'error'
  point?: string
  message?: string
  [key: string]: unknown
}

function sandbox(): { root: string; dbPath: string } {
  // macOS exposes /var through a /private/var canonical path. Use the physical
  // root from the beginning so consent scopes and Adapter read-back agree.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-integration-physical-')))
  roots.add(root)
  return { root, dbPath: path.join(root, 'agent-integration.sqlite') }
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function startWorker(
  mode: string,
  root: string,
  dbPath: string,
  point?: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return spawn(TSX, ['--tsconfig', WORKER_TSCONFIG, WORKER, mode, root, dbPath, ...(point ? [point] : [])], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function messages(child: ChildProcessWithoutNullStreams, onMessage: (message: WorkerMessage) => void): void {
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) onMessage(JSON.parse(line) as WorkerMessage)
    }
  })
}

async function killAt(point: 'intent' | 'effect', root: string, dbPath: string): Promise<WorkerMessage> {
  const child = startWorker('crash', root, dbPath, point)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return new Promise((resolve, reject) => {
    let reached: WorkerMessage | undefined
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`worker did not reach ${point}: ${stderr}`))
    }, 15_000)
    messages(child, message => {
      if (message.type === 'error') {
        clearTimeout(timeout)
        reject(new Error(message.message))
        return
      }
      if (message.type !== 'killpoint') return
      reached = message
      child.kill('SIGKILL')
    })
    child.once('close', (_code, signal) => {
      clearTimeout(timeout)
      if (!reached || signal !== 'SIGKILL') {
        reject(new Error(`worker exited before ${point} SIGKILL (${signal}): ${stderr}`))
        return
      }
      resolve(reached)
    })
  })
}

async function runToResult(
  mode: string,
  root: string,
  dbPath: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<WorkerMessage> {
  const child = startWorker(mode, root, dbPath, undefined, extraEnv)
  let result: WorkerMessage | undefined
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  messages(child, message => {
    if (message.type === 'error') result = message
    else if (message.type === 'result') result = message
  })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`worker timed out: ${stderr}`))
    // This worker starts a fresh TSX process and performs synchronous SQLite
    // durability checks. Keep a bounded but realistic budget when the full
    // release suite is compiling other test files concurrently.
    }, 45_000)
    child.once('close', code => {
      clearTimeout(timeout)
      if (code !== 0 || !result || result.type === 'error') {
        reject(new Error(`${result?.message ?? 'worker failed'}\n${stderr}`))
        return
      }
      resolve(result)
    })
  })
}

function persistedCrashState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return {
      run: db.prepare(`SELECT id, state FROM reconcile_runs ORDER BY created_at DESC LIMIT 1`).get(),
      mutation: db.prepare(`
        SELECT state, apply_receipt_json FROM projection_mutations ORDER BY created_at DESC LIMIT 1
      `).get(),
      taskItem: db.prepare(`
        SELECT run_id, state FROM agent_integration_apply_task_items
        WHERE task_id = 'physical-crash-task' AND installation_id = 'installation-crash'
      `).get(),
    }
  } finally {
    db.close()
  }
}

describe('Agent Integration physical process recovery', () => {
  it.each([
    ['intent', 'intent_persisted', 'planned', 'prepared', false],
    ['effect', 'effect_applied_before_receipt', 'applying', 'effect_started', true],
  ] as const)(
    'recovers after SIGKILL at the %s boundary using a new process and the same SQLite file',
    async (point, reportedPoint, runState, mutationState, effectAlreadyApplied) => {
      const { root, dbPath } = sandbox()
      const killed = await killAt(point, root, dbPath)
      expect(killed).toMatchObject({
        point: reportedPoint,
        runState,
        mutationState,
        fileExists: effectAlreadyApplied,
      })
      expect(killed.taskRunId).toEqual(expect.stringMatching(/^run-/))

      const persisted = persistedCrashState(dbPath)
      expect(persisted.run).toEqual(expect.objectContaining({ state: runState }))
      expect(persisted.mutation).toEqual({ state: mutationState, apply_receipt_json: null })
      expect(persisted.taskItem).toEqual({ run_id: persisted.run.id, state: 'running' })

      // The killed writer cannot release its file lock. Recovery must wait for
      // the real SQLite lease and lock-file staleness window before takeover.
      await new Promise(resolve => setTimeout(resolve, 350))
      const recovered = await runToResult('recover', root, dbPath)
      expect(recovered.outcomes).toEqual([
        expect.objectContaining({ status: 'committed' }),
      ])
      expect(recovered.snapshot).toMatchObject({
        fileExists: true,
        applyCount: 1,
        runs: [{ state: 'committed', count: 1 }],
        mutations: [{ state: 'committed', has_receipt: 1, count: 1 }],
      })
    },
    30_000,
  )

  it('keeps durable receipt evidence when a stale recovery process loses the journal CAS', async () => {
    const { root, dbPath } = sandbox()
    await killAt('intent', root, dbPath)
    const stale = startWorker('journal-stale', root, dbPath)
    let stderr = ''
    stale.stderr.setEncoding('utf8')
    stale.stderr.on('data', chunk => { stderr += String(chunk) })
    let loadedResolve!: (message: WorkerMessage) => void
    let resultResolve!: (message: WorkerMessage) => void
    const loaded = new Promise<WorkerMessage>(resolve => { loadedResolve = resolve })
    const result = new Promise<WorkerMessage>(resolve => { resultResolve = resolve })
    const closed = new Promise<void>((resolve, reject) => {
      stale.once('close', code => code === 0 ? resolve() : reject(new Error(`stale worker failed: ${stderr}`)))
    })
    messages(stale, message => {
      if (message.type === 'killpoint' && message.point === 'journal_loaded') loadedResolve(message)
      if (message.type === 'result') resultResolve(message)
    })
    const timeout = setTimeout(() => stale.kill('SIGKILL'), 15_000)
    try {
      await loaded
      expect(await runToResult('journal-advance', root, dbPath)).toMatchObject({ journalVersion: 2 })
      stale.stdin.write('persist-stale\n')
      expect(await result).toMatchObject({
        conflict: expect.stringMatching(/stale mutation journal version/),
        persisted: {
          state: 'receipt_persisted',
          journal_version: 2,
          attempt_count: 1,
          post_effect_fingerprint: 'desired',
          compensation_precondition: 'desired',
          apply_receipt_json: '{"physical":true}',
          failure_code: null,
        },
      })
      await closed
    } finally {
      clearTimeout(timeout)
      if (stale.exitCode === null && stale.signalCode === null) stale.kill('SIGKILL')
    }
  }, 60_000)

  it('keeps a shared Skill until explicit manual cleanup, then disconnects both consumers', async () => {
    const { root, dbPath } = sandbox()
    const result = await runToResult('shared-cycle', root, dbPath)

    expect(result.first).toMatchObject({ status: 'committed' })
    expect(result.afterFirst).toMatchObject({
      fileExists: true,
      applyCount: 1,
      artifacts: [{ component_type: 'skill', state: 'healthy', count: 1 }],
      consumers: [{ installation_id: 'installation-one', state: 'active', desired_state: 'managed' }],
    })
    expect(result.second).toMatchObject({ status: 'committed' })
    expect(result.afterSecond).toMatchObject({
      fileExists: true,
      applyCount: 1,
      artifacts: [{ component_type: 'skill', state: 'healthy', count: 1 }],
      consumers: [
        { installation_id: 'installation-one', state: 'active', desired_state: 'managed' },
        { installation_id: 'installation-two', state: 'active', desired_state: 'managed' },
      ],
    })
    expect(result.unsafeDetachError).toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/disconnect_noop_requires_absent_readback/),
    })
    expect(result.unsafeDetachResult).toBeNull()
    expect(result.afterUnsafeDetach).toEqual(result.afterSecond)
    expect(result.detach).toMatchObject({ status: 'committed' })
    expect(result.afterDetach).toMatchObject({
      fileExists: false,
      applyCount: 1,
      artifacts: [{ component_type: 'skill', state: 'missing', count: 1 }],
      missingEvents: { count: 1 },
      consumers: [
        { installation_id: 'installation-one', state: 'removed', desired_state: 'removed' },
        { installation_id: 'installation-two', state: 'active', desired_state: 'managed' },
      ],
    })
    expect(result.last).toMatchObject({ status: 'committed' })
    expect(result.afterLast).toMatchObject({
      fileExists: false,
      applyCount: 1,
      artifacts: [{ component_type: 'skill', state: 'removed', count: 1 }],
      consumers: [
        { installation_id: 'installation-one', state: 'removed', desired_state: 'removed' },
        { installation_id: 'installation-two', state: 'removed', desired_state: 'removed' },
      ],
    })
  }, 60_000)

  it('does not let a contender steal an expired lock from a SIGSTOPed live owner', async () => {
    const { root, dbPath } = sandbox()
    const holder = startWorker('fence-hold', root, dbPath, undefined, { LC_ALL: 'zh_CN.UTF-8' })
    let stderr = ''
    holder.stderr.setEncoding('utf8')
    holder.stderr.on('data', chunk => { stderr += String(chunk) })
    let readyResolve!: (message: WorkerMessage) => void
    let releasedResolve!: (message: WorkerMessage) => void
    const ready = new Promise<WorkerMessage>(resolve => { readyResolve = resolve })
    const released = new Promise<WorkerMessage>(resolve => { releasedResolve = resolve })
    const closed = new Promise<void>((resolve, reject) => {
      holder.once('close', code => code === 0 ? resolve() : reject(new Error(`holder failed: ${stderr}`)))
    })
    messages(holder, message => {
      if (message.type === 'killpoint' && message.point === 'fence_held') readyResolve(message)
      if (message.type === 'result') releasedResolve(message)
    })
    const timeout = setTimeout(() => holder.kill('SIGKILL'), 15_000)
    try {
      await ready
      expect(holder.kill('SIGSTOP')).toBe(true)
      // The SQLite lease and lock mtime are both stale now, but PID/start
      // identity still proves that the original owner exists.
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(await runToResult('fence-try', root, dbPath, { LC_ALL: 'fr_FR.UTF-8' }))
        .toMatchObject({ acquired: false })

      expect(holder.kill('SIGCONT')).toBe(true)
      holder.stdin.write('release\n')
      await released
      await closed
      expect(await runToResult('fence-try', root, dbPath)).toMatchObject({ acquired: true })
    } finally {
      clearTimeout(timeout)
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill('SIGCONT')
        holder.kill('SIGKILL')
      }
    }
  }, 60_000)

  it('detects when the lock path is replaced with identical owner content on a new inode', async () => {
    const { root, dbPath } = sandbox()
    const holder = startWorker('fence-hold', root, dbPath)
    let stderr = ''
    holder.stderr.setEncoding('utf8')
    holder.stderr.on('data', chunk => { stderr += String(chunk) })
    let readyResolve!: (message: WorkerMessage) => void
    let resultResolve!: (message: WorkerMessage) => void
    const ready = new Promise<WorkerMessage>(resolve => { readyResolve = resolve })
    const result = new Promise<WorkerMessage>(resolve => { resultResolve = resolve })
    const closed = new Promise<void>((resolve, reject) => {
      holder.once('close', code => code === 0 ? resolve() : reject(new Error(`holder failed: ${stderr}`)))
    })
    messages(holder, message => {
      if (message.type === 'killpoint' && message.point === 'fence_held') readyResolve(message)
      if (message.type === 'result') resultResolve(message)
    })
    const timeout = setTimeout(() => holder.kill('SIGKILL'), 15_000)
    try {
      await ready
      const lockDirectory = path.join(root, 'home', '.tidemind', 'writer-locks')
      const lockName = fs.readdirSync(lockDirectory).find(name => name.endsWith('.lock'))
      expect(lockName).toBeDefined()
      const lockPath = path.join(lockDirectory, lockName!)
      const displacedPath = `${lockPath}.displaced`
      const ownerJson = fs.readFileSync(lockPath)
      fs.renameSync(lockPath, displacedPath)
      fs.writeFileSync(lockPath, ownerJson, { flag: 'wx', mode: 0o600 })

      // Heartbeat runs at a one-second minimum and must notice that its fd no
      // longer names the public lock path even though owner JSON is identical.
      await new Promise(resolve => setTimeout(resolve, 1_100))
      holder.stdin.write('assert\n')
      expect(await result).toMatchObject({ asserted: false, error: expect.stringMatching(/writer lock|heartbeat/) })
      await closed
    } finally {
      clearTimeout(timeout)
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
    }
  }, 30_000)
})
