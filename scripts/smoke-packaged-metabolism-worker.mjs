import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { getConfig } from '../dist/config.js'
import {
  createWorkerDataScopeFingerprint,
  deriveInitializedDatabaseIdentity,
} from '../dist/db/worker-initialized-database.js'
import { CURRENT_SCHEMA_VERSION, ensureSchema, ensureVectorTable } from '../dist/db/schema.js'
import { checkCliEnvironment } from '../dist/llm/cli/readiness.js'
import { ALL_TASKS } from '../dist/metabolism/tasks.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const archFlagIndex = process.argv.indexOf('--arch')
const expectedArch = archFlagIndex >= 0 ? process.argv[archFlagIndex + 1] : process.arch
if (!['arm64', 'x64'].includes(expectedArch)) {
  throw new Error(`unsupported packaged smoke architecture: ${expectedArch}`)
}
if (process.arch !== expectedArch) {
  throw new Error(`packaged smoke must run on ${expectedArch}, current host is ${process.arch}`)
}
const explicitAppIndex = process.argv.indexOf('--app')
const explicitApp = explicitAppIndex >= 0 ? process.argv[explicitAppIndex + 1] : null
const releaseRoot = path.join(root, 'client/release')
const candidateAppDirectories = fs.existsSync(releaseRoot)
  ? fs.readdirSync(releaseRoot)
    .filter((entry) => entry.startsWith('mac'))
    .map((entry) => path.join(releaseRoot, entry, 'Tide Mind.app'))
    .filter((candidate) => fs.existsSync(candidate))
  : []
const discoveredApp = candidateAppDirectories.find((candidate) => {
  const candidateExecutable = path.join(candidate, 'Contents/MacOS/Tide Mind')
  if (!fs.existsSync(candidateExecutable)) return false
  const description = execFileSync('/usr/bin/file', [candidateExecutable], { encoding: 'utf8' })
  return description.includes(expectedArch === 'x64' ? 'x86_64' : 'arm64')
})
const app = path.resolve(explicitApp ?? discoveredApp ?? '')
if (!explicitApp && !discoveredApp) {
  throw new Error(`cannot find packaged ${expectedArch} Tide Mind.app under ${releaseRoot}`)
}
const executable = path.join(app, 'Contents/MacOS/Tide Mind')
const unpacked = path.join(app, 'Contents/Resources/app.asar.unpacked')
const workerBundle = path.join(unpacked, 'out/bin/metabolism-worker.cjs')
const nativeModule = path.join(unpacked, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
const vecPackageArch = expectedArch === 'x64' ? 'x64' : 'arm64'
const vecModule = path.join(unpacked, `node_modules/sqlite-vec-darwin-${vecPackageArch}/vec0.dylib`)

for (const required of [executable, workerBundle, nativeModule, vecModule]) {
  if (!fs.statSync(required).isFile()) throw new Error(`packaged metabolism smoke missing ${required}`)
}
for (const modulePath of [nativeModule, vecModule]) {
  const nativeDescription = execFileSync('/usr/bin/file', [modulePath], { encoding: 'utf8' })
  const expectedFileArch = expectedArch === 'x64' ? 'x86_64' : 'arm64'
  if (!nativeDescription.includes(expectedFileArch)) throw new Error(`native architecture mismatch: ${nativeDescription.trim()}`)
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-packaged-metabolism-'))
try {
  const fakeCliDir = path.join(temp, '.local', 'bin')
  fs.mkdirSync(fakeCliDir, { recursive: true })
  const fakeCli = path.join(fakeCliDir, 'claude')
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
    const fs = require('node:fs')
    const path = require('node:path')
    const args = process.argv.slice(2)
    if (args.includes('--version')) { process.stdout.write('2.1.215 (Claude Code)\\n'); process.exit(0) }
    if (args[0] === 'auth' && args[1] === 'status' && args.includes('--json')) {
      process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'firstParty', email: 'fixture@example.com' })); process.exit(0)
    }
    if (args[0] === 'auth' && args[1] === 'status' && args.includes('--help')) { process.stdout.write('--json\\n'); process.exit(0) }
    if (args.includes('--help')) {
      process.stdout.write('-p, --print --safe-mode --tools <tools...> Use "" to disable all tools --disable-slash-commands --no-session-persistence --strict-mcp-config --output-format <format> --system-prompt-file\\n'); process.exit(0)
    }
    fs.writeFileSync(path.join(process.env.HOME, 'mock-cli.pid'), String(process.pid))
    process.on('SIGTERM', () => process.exit(0))
    process.stdin.resume()
    setInterval(() => {}, 1000)
  `, { mode: 0o700 })
  const workerEnv = { ...process.env, HOME: temp }
  const cliEnvironment = await checkCliEnvironment({
    providerType: 'claude-cli',
    sourceEnv: workerEnv,
    homeDir: temp,
  })
  const modelAlias = cliEnvironment.candidateModels[0]
  if (!modelAlias) throw new Error('packaged CLI smoke has no candidate model')

  const graphDir = path.join(temp, 'graph')
  fs.mkdirSync(graphDir)
  const dbPath = path.join(graphDir, 'brain.sqlite')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  ensureSchema(db)
  db.loadExtension(vecModule)
  ensureVectorTable(db, getConfig().embedding.dimensions)
  const canonicalDataDir = fs.realpathSync.native(temp)
  const canonicalDbPath = fs.realpathSync.native(dbPath)
  const dbStat = fs.statSync(canonicalDbPath)
  const dataScopeFingerprint = createWorkerDataScopeFingerprint({
    canonicalDataDir,
    canonicalRealPath: canonicalDbPath,
    deviceId: String(dbStat.dev),
    inodeId: String(dbStat.ino),
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
  })
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('startup_data_scope_fingerprint', dataScopeFingerprint)
  const now = String(Date.now())
  for (const task of ALL_TASKS) {
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
      `last_task_${task.id}`,
      task.id === 'annotate' ? '1577836800000' : now,
    )
  }
  db.prepare("INSERT INTO nodes (id, type, content, created, refinement) VALUES ('packaged-cli-node', 'fact', 'exercise packaged CLI shutdown', ?, 0)").run(new Date().toISOString())
  db.prepare(`
    INSERT INTO model_connections (
      id, name, provider_type, credentials, status, archived, created,
      candidate_models, available_models, validation_fingerprint, auth_fingerprint,
      cli_path, cli_version, auth_method, environment_checked_at
    ) VALUES (?, ?, 'claude-cli', '{}', 'online', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'mc_packaged_cli', 'Packaged CLI smoke', new Date().toISOString(),
    JSON.stringify(cliEnvironment.candidateModels), JSON.stringify([modelAlias]),
    cliEnvironment.validationFingerprint, cliEnvironment.authFingerprint,
    cliEnvironment.resolved.path, cliEnvironment.resolved.version,
    cliEnvironment.auth.method, cliEnvironment.checkedAt,
  )
  const startupAuthority = {
    controllerReceiptId: 'packaged-smoke-receipt',
    dataScopeFingerprint,
    controllerGeneration: 1,
  }
  const databaseIdentity = deriveInitializedDatabaseIdentity(db, startupAuthority, CURRENT_SCHEMA_VERSION)
  db.close()

  const config = structuredClone(getConfig())
  config.general.data_dir = canonicalDataDir
  config.cloud.metabolism_enabled = false
  config.llm.standard_connection = 'mc_packaged_cli'
  config.llm.standard_provider = 'claude-cli'
  config.llm.standard_model = modelAlias
  const bootstrap = {
    protocolVersion: 1,
    lifecycleGeneration: 1,
    startupAuthority,
    databaseIdentity,
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    runtimeRevision: 1,
    runtimeConfigSnapshot: config,
    runtimeConnectionSnapshot: { connections: [{
      id: 'mc_packaged_cli', name: 'Packaged CLI smoke', providerType: 'claude-cli', archived: false,
      status: 'online', statusReason: null, candidateModels: JSON.stringify(cliEnvironment.candidateModels),
      availableModels: JSON.stringify([modelAlias]), validationFingerprint: cliEnvironment.validationFingerprint,
      authFingerprint: cliEnvironment.authFingerprint, modelValidationJson: null, credentials: {},
    }] },
    strategySnapshot: {},
    strategySourceFingerprint: 'b'.repeat(64),
    externalRuntimeSourceFingerprint: crypto.createHash('sha256')
      .update('metabolism-worker-external-runtime-sources-v1\0')
      .update(canonicalDataDir).update('\0').digest('hex'),
    credentialSnapshot: {},
    authorizedRoots: { dataDir: canonicalDataDir },
    vecCapability: 'ready',
  }
  const bootstrapPath = path.join(temp, 'bootstrap.json')
  fs.writeFileSync(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 })
  const runnerPath = path.join(temp, 'runner.cjs')
  fs.writeFileSync(runnerPath, `
    const fs = require('node:fs')
    const { Worker } = require('node:worker_threads')
    const worker = new Worker(process.argv[2], { workerData: JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) })
    let ready = false
    let stopped = false
    worker.postMessage({ protocolVersion: 1, lifecycleGeneration: 1, kind: 'set_schedule_context', mode: 'background', cadence: 'active', revision: 1 })
    const timeout = setTimeout(() => { console.error('packaged metabolism Worker timeout', { ready, stopped }); process.exit(2) }, 15000)
    worker.on('message', message => {
      console.log('packaged metabolism message', message.kind)
      if (message.kind === 'ready') {
        ready = true
        worker.postMessage({ protocolVersion: 1, lifecycleGeneration: 1, kind: 'trigger', reason: 'initial' })
      } else if (message.kind === 'active_llm_task_started') {
        const pidFile = require('node:path').join(process.env.HOME, 'mock-cli.pid')
        const waitForCli = () => {
          if (!require('node:fs').existsSync(pidFile)) return setTimeout(waitForCli, 10)
          worker.postMessage({ protocolVersion: 1, lifecycleGeneration: 1, kind: 'shutdown' })
        }
        waitForCli()
      } else if (message.kind === 'stopped') {
        stopped = true
      } else if (message.kind === 'fatal') {
        console.error(JSON.stringify(message))
      }
    })
    worker.on('error', error => { console.error(error); process.exit(3) })
    worker.on('exit', code => {
      clearTimeout(timeout)
      if (code !== 0 || !ready || !stopped) process.exit(4)
      console.log('packaged metabolism Worker ready -> stopped -> exit 0')
    })
  `, { mode: 0o600 })

  await new Promise((resolve, reject) => {
    const child = spawn(executable, [runnerPath, workerBundle, bootstrapPath], {
      env: { ...workerEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`packaged metabolism smoke failed (${code}): ${stderr || stdout}`))
      else {
        process.stdout.write(stdout)
        const pid = Number(fs.readFileSync(path.join(temp, 'mock-cli.pid'), 'utf8'))
        if (!Number.isSafeInteger(pid) || pid < 1) return reject(new Error('packaged CLI smoke did not record a child pid'))
        try {
          process.kill(pid, 0)
          reject(new Error(`packaged CLI child ${pid} survived Worker shutdown`))
          return
        } catch (error) {
          if (error?.code !== 'ESRCH') return reject(error)
        }
        try {
          process.kill(-pid, 0)
          reject(new Error(`packaged CLI process group ${pid} survived Worker shutdown`))
          return
        } catch (error) {
          if (error?.code !== 'ESRCH') return reject(error)
        }
        process.stdout.write('packaged metabolism CLI child process group -> zero\n')
        resolve()
      }
    })
  })
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
