import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { build, type Plugin } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MetabolismWorkerController, type WorkerLike } from '../../client/electron/workers/metabolism-worker-controller.js'
import { MetabolismWorkerGenerationManager } from '../../client/electron/workers/metabolism-worker-generation-manager.js'
import { createWorkerDataScopeFingerprint, deriveInitializedDatabaseIdentity } from '../../src/db/worker-initialized-database.js'
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema.js'
import { ALL_TASKS } from '../../src/metabolism/tasks.js'
import { getConfig } from '../../src/config.js'
import { fingerprintMetabolismWorkerExternalRuntimeSources } from '../../client/electron/workers/metabolism-worker-runtime-mutations.js'

const roots: string[] = []
function createDataDb(dataDir: string): { db: Database.Database; dbPath: string } {
  fs.mkdirSync(path.join(dataDir, 'graph'))
  const dbPath = path.join(dataDir, 'graph', 'brain.sqlite')
  return { db: new Database(dbPath), dbPath }
}

function installAuthority(db: Database.Database, dataDir: string, receipt: string) {
  const dbPath = fs.realpathSync.native(db.name)
  const stat = fs.statSync(dbPath)
  const dataScopeFingerprint = createWorkerDataScopeFingerprint({
    canonicalDataDir: fs.realpathSync.native(dataDir), canonicalRealPath: dbPath,
    deviceId: String(stat.dev), inodeId: String(stat.ino), expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
  })
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('startup_data_scope_fingerprint', dataScopeFingerprint)
  return { controllerReceiptId: receipt, dataScopeFingerprint, controllerGeneration: 1 }
}

async function buildWorkerBundle(
  bundleDir: string,
  plugins: readonly Plugin[] = [],
): Promise<string> {
  const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
  const entry = path.join(bundleDir, 'metabolism-worker.cjs')
  await build({
    entryPoints: [entrySource.pathname],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: entry,
    external: ['better-sqlite3', 'sqlite-vec'],
    define: { 'import.meta.url': '__tm_bundle_url__' },
    banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' },
    plugins: [...plugins],
    logLevel: 'silent',
  })
  return entry
}

function rejectLlmShutdownPlugin(): Plugin {
  const actualClient = new URL('../../src/llm/client.ts', import.meta.url).pathname
  return {
    name: 'reject-llm-shutdown',
    setup(buildApi) {
      buildApi.onResolve({ filter: /(?:^|\/)client\.js$/ }, args => {
        if (!args.importer.includes(`${path.sep}src${path.sep}llm${path.sep}`)
          && !args.importer.includes(`${path.sep}client${path.sep}electron${path.sep}workers${path.sep}`)) return
        return { path: 'fault-client', namespace: 'reject-llm-shutdown' }
      })
      buildApi.onResolve({ filter: /^\//, namespace: 'reject-llm-shutdown' }, args => ({ path: args.path }))
      buildApi.onLoad({ filter: /.*/, namespace: 'reject-llm-shutdown' }, () => ({
        loader: 'ts',
        contents: `
          export * from ${JSON.stringify(actualClient)}
          export async function shutdownLLMClient(): Promise<void> {
            throw new Error('injected LLM shutdown failure')
          }
        `,
      }))
    },
  }
}

function delayInitializedDatabaseOpenPlugin(delayMs: number): Plugin {
  const actualDatabase = new URL('../../src/db/worker-initialized-database.ts', import.meta.url).pathname
  return {
    name: 'delay-worker-database-open',
    setup(buildApi) {
      buildApi.onResolve({ filter: /worker-initialized-database\.js$/ }, args => {
        if (!args.importer.includes(`${path.sep}client${path.sep}electron${path.sep}workers${path.sep}`)) return
        return { path: 'delayed-database', namespace: 'delay-worker-database-open' }
      })
      buildApi.onResolve({ filter: /^\//, namespace: 'delay-worker-database-open' }, args => ({ path: args.path }))
      buildApi.onLoad({ filter: /.*/, namespace: 'delay-worker-database-open' }, () => ({
        loader: 'ts',
        contents: `
          import { openInitializedDatabase as actualOpen } from ${JSON.stringify(actualDatabase)}
          export * from ${JSON.stringify(actualDatabase)}
          export async function openInitializedDatabase(options: Parameters<typeof actualOpen>[0]) {
            await new Promise(resolve => setTimeout(resolve, ${delayMs}))
            return actualOpen(options)
          }
        `,
      }))
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('dormant metabolism Worker', () => {
  it('opens the verified DB, installs runtime hooks, becomes ready and stops before exit', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-worker-'))
    roots.push(dataDir)
    const { db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('schema_version', '33')
    const authority = installAuthority(db, dataDir, 'receipt-1')
    const identity = deriveInitializedDatabaseIdentity(db, authority, 33)
    db.close()

    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
    const entry = path.join(bundleDir, 'metabolism-worker.cjs')
    await build({
      entryPoints: [entrySource.pathname],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: entry,
      external: ['better-sqlite3', 'sqlite-vec'],
      define: { 'import.meta.url': '__tm_bundle_url__' },
      banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' },
      logLevel: 'silent',
    })
    const controller = new MetabolismWorkerController({
      workerPath: entry,
      readyTimeoutMs: 10_000,
      stoppedTimeoutMs: 10_000,
      exitTimeoutMs: 10_000,
      workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike,
    })
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))
    await controller.start({
      protocolVersion: 1,
      lifecycleGeneration: 1,
      startupAuthority: authority,
      databaseIdentity: identity,
      expectedSchemaVersion: 33,
      runtimeRevision: 1,
      runtimeConfigSnapshot: {
        general: { data_dir: fs.realpathSync.native(dataDir) },
        metabolism: { annotate_interval_minutes: 3 },
        llm: { provider: 'anthropic' },
        embedding: { provider: 'vertex', dimensions: 768 },
      },
      runtimeConnectionSnapshot: { connections: [] },
      strategySnapshot: {},
      strategySourceFingerprint: 'b'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {},
      authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) },
      vecCapability: 'unavailable',
    }, 'paused', 'active')
    expect(controller.getState()?.lifecycle).toBe('ready')
    controller.shutdown()
    await expect(ended).resolves.toBe(1)
    expect(controller.getState()?.lifecycle).toBe('exited')
    expect(controller.getState()?.stoppedSettled).toBe(true)
  }, 20_000)

  it('fails closed without stopped when real Worker LLM shutdown rejects', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-shutdown-fault-'))
    roots.push(dataDir)
    const { db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const now = String(Date.now())
    for (const task of ALL_TASKS) db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(`last_task_${task.id}`, now)
    const authority = installAuthority(db, dataDir, 'receipt-shutdown-fault')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()

    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entry = await buildWorkerBundle(bundleDir, [rejectLlmShutdownPlugin()])
    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    const controller = new MetabolismWorkerController({
      workerPath: entry,
      workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike,
    })
    const messages: Array<{ kind?: string }> = []
    controller.on('message', message => messages.push(message))
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))
    await controller.start({
      protocolVersion: 1, lifecycleGeneration: 10, startupAuthority: authority, databaseIdentity: identity,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION, runtimeRevision: 1, runtimeConfigSnapshot: config,
      runtimeConnectionSnapshot: { connections: [] }, strategySnapshot: {}, strategySourceFingerprint: 'a'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {}, authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) }, vecCapability: 'unavailable',
    }, 'paused', 'active')

    await controller.shutdown()
    await expect(ended).resolves.toBe(10)
    expect(messages.some(message => message.kind === 'fatal')).toBe(true)
    expect(messages.some(message => message.kind === 'stopped')).toBe(false)
    expect(controller.getState()).toMatchObject({ lifecycle: 'exited', stoppedSettled: false })
  }, 20_000)

  it('rejects external source mutation after handoff and before real Worker ready', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-ready-drift-'))
    roots.push(dataDir)
    fs.mkdirSync(path.join(dataDir, 'strategies'))
    const strategyPath = path.join(dataDir, 'strategies', 'runtime.system.md')
    fs.writeFileSync(strategyPath, 'before-ready')
    const { db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const authority = installAuthority(db, dataDir, 'receipt-ready-drift')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()

    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entry = await buildWorkerBundle(bundleDir, [delayInitializedDatabaseOpenPlugin(250)])
    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    const controller = new MetabolismWorkerController({
      workerPath: entry,
      readyTimeoutMs: 10_000,
      workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike,
    })
    const messages: Array<{ kind?: string }> = []
    controller.on('message', message => messages.push(message))
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))
    const starting = controller.start({
      protocolVersion: 1, lifecycleGeneration: 11, startupAuthority: authority, databaseIdentity: identity,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION, runtimeRevision: 1, runtimeConfigSnapshot: config,
      runtimeConnectionSnapshot: { connections: [] }, strategySnapshot: {}, strategySourceFingerprint: 'b'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {}, authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) }, vecCapability: 'unavailable',
    }, 'paused', 'active')
    fs.writeFileSync(strategyPath, 'changed-before-ready')

    await expect(starting).rejects.toThrow(/worker_fatal|worker_exit/)
    await expect(ended).resolves.toBe(11)
    expect(messages.some(message => message.kind === 'ready')).toBe(false)
    expect(messages.some(message => message.kind === 'task_started')).toBe(false)
    expect(controller.getState()).toMatchObject({ lifecycle: 'exited', stoppedSettled: false })
  }, 20_000)

  it('runs the scheduler pass in the Worker isolate and remains single-owner', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-scheduler-'))
    roots.push(dataDir)
    const { db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const now = String(Date.now())
    for (const task of ALL_TASKS) db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(`last_task_${task.id}`, now)
    const authority = installAuthority(db, dataDir, 'receipt-scheduler')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()

    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
    const entry = path.join(bundleDir, 'metabolism-worker.cjs')
    await build({ entryPoints: [entrySource.pathname], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: entry, external: ['better-sqlite3', 'sqlite-vec'], define: { 'import.meta.url': '__tm_bundle_url__' }, banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' }, logLevel: 'silent' })

    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    const controller = new MetabolismWorkerController({ workerPath: entry, workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike })
    const messages: Array<{ kind?: string }> = []
    controller.on('message', message => messages.push(message))
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))
    await controller.start({
      protocolVersion: 1,
      lifecycleGeneration: 2,
      startupAuthority: authority,
      databaseIdentity: identity,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      runtimeRevision: 1,
      runtimeConfigSnapshot: config,
      runtimeConnectionSnapshot: { connections: [] },
      strategySnapshot: {},
      strategySourceFingerprint: 'c'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {},
      authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) },
      vecCapability: 'unavailable',
    }, 'background', 'active')
    await vi.waitFor(() => expect(messages.some(message => message.kind === 'idle')).toBe(true), { timeout: 10_000 })
    expect(messages.filter(message => message.kind === 'task_started')).toHaveLength(0)
    controller.shutdown()
    await ended
  }, 20_000)

  it('defers a pass on foreground SQLITE_BUSY and remains usable for the next trigger', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-busy-'))
    roots.push(dataDir)
    const { dbPath, db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const current = String(Date.now())
    for (const task of ALL_TASKS) db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(`last_task_${task.id}`, task.id === 'synaptic-decay' ? '1577836800000' : current)
    const authority = installAuthority(db, dataDir, 'receipt-busy')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()

    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entry = path.join(bundleDir, 'metabolism-worker.cjs')
    const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
    await build({ entryPoints: [entrySource.pathname], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: entry, external: ['better-sqlite3', 'sqlite-vec'], define: { 'import.meta.url': '__tm_bundle_url__' }, banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' }, logLevel: 'silent' })
    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    const controller = new MetabolismWorkerController({ workerPath: entry, workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike })
    const messages: Array<{ kind?: string; taskId?: string }> = []
    controller.on('message', message => messages.push(message))
    await controller.start({
      protocolVersion: 1, lifecycleGeneration: 7, startupAuthority: authority, databaseIdentity: identity,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION, runtimeRevision: 1, runtimeConfigSnapshot: config,
      runtimeConnectionSnapshot: { connections: [] }, strategySnapshot: {}, strategySourceFingerprint: '7'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {}, authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) }, vecCapability: 'unavailable',
    }, 'paused', 'active')

    const foreground = new Database(dbPath)
    foreground.exec('BEGIN IMMEDIATE')
    controller.setScheduleContext('foreground', 'active')
    controller.trigger('immediate')
    await vi.waitFor(() => expect(messages.some(message => message.kind === 'idle')).toBe(true), { timeout: 5_000 })
    expect(controller.getState()?.lifecycle).toBe('ready')
    expect(messages.some(message => message.kind === 'fatal')).toBe(false)

    foreground.exec('ROLLBACK')
    foreground.close()
    messages.length = 0
    controller.trigger('immediate')
    await vi.waitFor(() => expect(messages.some(message => message.kind === 'task_finished' && message.taskId === 'synaptic-decay')).toBe(true), { timeout: 5_000 })
    const ended = new Promise(resolve => controller.once('generation-ended', resolve))
    controller.shutdown()
    await ended
  }, 20_000)

  it('routes structure-holes through the main-owned RPC and writes the Worker-side cache', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-structure-rpc-'))
    roots.push(dataDir)
    const { dbPath, db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const current = String(Date.now())
    for (const task of ALL_TASKS) {
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(`last_task_${task.id}`, task.id === 'structure-holes-precompute' ? '1577836800000' : current)
    }
    const insertNode = db.prepare("INSERT INTO nodes (id, type, content, created) VALUES (?, 'fact', ?, ?)")
    for (let index = 0; index < 50; index++) insertNode.run(`node-${index}`, `content-${index}`, new Date().toISOString())
    const authority = installAuthority(db, dataDir, 'receipt-structure')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()

    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entry = path.join(bundleDir, 'metabolism-worker.cjs')
    const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
    await build({ entryPoints: [entrySource.pathname], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: entry, external: ['better-sqlite3', 'sqlite-vec'], define: { 'import.meta.url': '__tm_bundle_url__' }, banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' }, logLevel: 'silent' })
    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    const handler = vi.fn(async () => [{ sourceId: 'node-1', targetId: 'node-2', score: 0.8, reason: 'test' }])
    const controller = new MetabolismWorkerController({ workerPath: entry, workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike, structureHolesHandler: handler })
    const messages: Array<{ kind?: string; taskId?: string }> = []
    controller.on('message', message => messages.push(message))
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))
    await controller.start({
      protocolVersion: 1, lifecycleGeneration: 3, startupAuthority: authority, databaseIdentity: identity,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION, runtimeRevision: 1, runtimeConfigSnapshot: config,
      runtimeConnectionSnapshot: { connections: [] }, strategySnapshot: {}, strategySourceFingerprint: 'd'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {}, authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) }, vecCapability: 'unavailable',
    }, 'background', 'active')
    await vi.waitFor(() => expect(messages.some(message => message.kind === 'task_finished' && message.taskId === 'structure-holes-precompute')).toBe(true), { timeout: 10_000 })
    expect(handler).toHaveBeenCalledTimes(1)
    const verify = new Database(dbPath, { readonly: true })
    const cached = verify.prepare('SELECT payload FROM structure_holes_cache WHERE id = 1').get() as { payload: string }
    expect(JSON.parse(cached.payload)).toHaveLength(1)
    verify.close()
    controller.shutdown()
    await ended
  }, 20_000)

  it('upgrades an in-flight restart drain to shutdown and aborts the pending Worker RPC', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-stop-upgrade-'))
    roots.push(dataDir)
    const { db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const current = String(Date.now())
    for (const task of ALL_TASKS) {
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        `last_task_${task.id}`,
        task.id === 'structure-holes-precompute' ? '1577836800000' : current,
      )
    }
    const insertNode = db.prepare("INSERT INTO nodes (id, type, content, created) VALUES (?, 'fact', ?, ?)")
    for (let index = 0; index < 50; index++) insertNode.run(`stop-node-${index}`, `content-${index}`, new Date().toISOString())
    const authority = installAuthority(db, dataDir, 'receipt-stop-upgrade')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()

    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entry = path.join(bundleDir, 'metabolism-worker.cjs')
    const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
    await build({ entryPoints: [entrySource.pathname], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: entry, external: ['better-sqlite3', 'sqlite-vec'], define: { 'import.meta.url': '__tm_bundle_url__' }, banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' }, logLevel: 'silent' })
    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    const handler = vi.fn(() => new Promise<never>(() => {}))
    const controller = new MetabolismWorkerController({
      workerPath: entry,
      readyTimeoutMs: 10_000,
      stoppedTimeoutMs: 3_000,
      exitTimeoutMs: 3_000,
      workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike,
      structureHolesHandler: handler,
    })
    const messages: Array<{ kind?: string; taskId?: string }> = []
    controller.on('message', message => messages.push(message))
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))
    await controller.start({
      protocolVersion: 1, lifecycleGeneration: 8, startupAuthority: authority, databaseIdentity: identity,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION, runtimeRevision: 1, runtimeConfigSnapshot: config,
      runtimeConnectionSnapshot: { connections: [] }, strategySnapshot: {}, strategySourceFingerprint: '8'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {}, authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) }, vecCapability: 'unavailable',
    }, 'background', 'active')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    controller.drainForRestart()
    await controller.shutdown()
    await expect(ended).resolves.toBe(8)
    expect(controller.getState()).toMatchObject({ lifecycle: 'exited', stoppedSettled: true, degradationReason: null })
    expect(messages.some(message => message.kind === 'fatal')).toBe(false)
  }, 20_000)

  it('lets an in-flight structure RPC settle during an ordinary restart drain', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-restart-rpc-'))
    roots.push(dataDir)
    const { db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const current = String(Date.now())
    for (const task of ALL_TASKS) db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
      `last_task_${task.id}`,
      task.id === 'structure-holes-precompute' ? '1577836800000' : current,
    )
    const insertNode = db.prepare("INSERT INTO nodes (id, type, content, created) VALUES (?, 'fact', ?, ?)")
    for (let index = 0; index < 50; index++) insertNode.run(`restart-node-${index}`, `content-${index}`, new Date().toISOString())
    const authority = installAuthority(db, dataDir, 'receipt-restart-rpc')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()
    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entry = path.join(bundleDir, 'metabolism-worker.cjs')
    const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
    await build({ entryPoints: [entrySource.pathname], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: entry, external: ['better-sqlite3', 'sqlite-vec'], define: { 'import.meta.url': '__tm_bundle_url__' }, banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' }, logLevel: 'silent' })
    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    let resolveRpc: ((value: Array<{ sourceId: string; targetId: string; score: number; reason: string }>) => void) | null = null
    const handler = vi.fn(() => new Promise<Array<{ sourceId: string; targetId: string; score: number; reason: string }>>(resolve => { resolveRpc = resolve }))
    const controller = new MetabolismWorkerController({ workerPath: entry, workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike, structureHolesHandler: handler })
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))
    await controller.start({
      protocolVersion: 1, lifecycleGeneration: 9, startupAuthority: authority, databaseIdentity: identity,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION, runtimeRevision: 1, runtimeConfigSnapshot: config,
      runtimeConnectionSnapshot: { connections: [] }, strategySnapshot: {}, strategySourceFingerprint: '9'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
      credentialSnapshot: {}, authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) }, vecCapability: 'unavailable',
    }, 'background', 'active')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    controller.drainForRestart()
    resolveRpc?.([{ sourceId: 'restart-node-1', targetId: 'restart-node-2', score: 0.8, reason: 'restart' }])
    await expect(ended).resolves.toBe(9)
    expect(controller.getState()).toMatchObject({ lifecycle: 'exited', stoppedSettled: true, degradationReason: null })
  }, 20_000)

  it('drains the real Worker before starting the next immutable generation', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-generation-'))
    roots.push(dataDir)
    const { db } = createDataDb(dataDir)
    db.pragma('journal_mode = WAL')
    ensureSchema(db)
    const current = String(Date.now())
    for (const task of ALL_TASKS) db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(`last_task_${task.id}`, current)
    const authority = installAuthority(db, dataDir, 'receipt-generation')
    const identity = deriveInitializedDatabaseIdentity(db, authority, CURRENT_SCHEMA_VERSION)
    db.close()
    const bundleDir = fs.mkdtempSync(path.join(process.cwd(), '.metabolism-worker-test-'))
    roots.push(bundleDir)
    const entry = path.join(bundleDir, 'metabolism-worker.cjs')
    const entrySource = new URL('../../client/electron/workers/metabolism-worker-entry.ts', import.meta.url)
    await build({ entryPoints: [entrySource.pathname], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: entry, external: ['better-sqlite3', 'sqlite-vec'], define: { 'import.meta.url': '__tm_bundle_url__' }, banner: { js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;' }, logLevel: 'silent' })
    const config = structuredClone(getConfig())
    config.general.data_dir = fs.realpathSync.native(dataDir)
    config.cloud.metabolism_enabled = false
    const started: number[] = []
    const ended: number[] = []
    const manager = new MetabolismWorkerGenerationManager({
      buildBootstrap: async lifecycleGeneration => ({
        protocolVersion: 1, lifecycleGeneration, startupAuthority: authority, databaseIdentity: identity,
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION, runtimeRevision: lifecycleGeneration, runtimeConfigSnapshot: config,
        runtimeConnectionSnapshot: { connections: [] }, strategySnapshot: {}, strategySourceFingerprint: 'e'.repeat(64), externalRuntimeSourceFingerprint: fingerprintMetabolismWorkerExternalRuntimeSources(dataDir),
        credentialSnapshot: {}, authorizedRoots: { dataDir: fs.realpathSync.native(dataDir) }, vecCapability: 'unavailable',
      }),
      createController: lifecycleGeneration => {
        const controller = new MetabolismWorkerController({ workerPath: entry, workerFactory: (workerPath, workerData) => new Worker(workerPath, { workerData }) as WorkerLike })
        controller.once('generation-ended', () => ended.push(lifecycleGeneration))
        return controller
      },
      initialMode: 'paused', initialCadence: 'active',
    })
    manager.on('generation-ready', generation => started.push(generation as number))
    await manager.start()
    await manager.requestRestart()
    expect(started).toEqual([1, 2])
    expect(ended).toEqual([1])
    await manager.shutdown()
    expect(ended).toEqual([1, 2])
  }, 20_000)
})
