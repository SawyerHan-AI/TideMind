/** Isolated acceptance: execute actual e57c7589 schema/connection code against
 * temporary DBs. No account, credential, user HOME data or provider is used. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import Database from 'better-sqlite3'
import { ensureSchema } from '../src/db/schema.js'
import { migrateExistingDatabaseIfNeeded } from '../src/db/pre-migration.js'
import { getAuthBinding, reconcileAuthBinding, listModelObservations } from '../src/db/model-discovery.js'

const baseline = 'e57c7589'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-db-roundtrip-'))
const exported = new Map<string, string>()
function exportLegacy(sourcePath: string): string {
  const old = exported.get(sourcePath)
  if (old) return old
  const target = path.join(root, 'legacy', sourcePath.replace(/\.ts$/, '.mjs'))
  exported.set(sourcePath, target)
  const source = execFileSync('git', ['show', `${baseline}:${sourcePath}`], { encoding: 'utf8' })
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  js = js.replace(/(from\s+['"])([^'"]+)(['"])/g, (_match, before, specifier: string, after) => {
    const resolved = specifier.startsWith('.')
      ? pathToFileURL(exportLegacy(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier)).replace(/\.js$/, '.ts'))).href
      : specifier.startsWith('node:') ? specifier : import.meta.resolve(specifier)
    return `${before}${resolved}${after}`
  })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, js)
  return target
}
try {
  const legacySchema = await import(pathToFileURL(exportLegacy('src/db/schema.ts')).href)
  const legacyConnections = await import(pathToFileURL(exportLegacy('src/db/connections.ts')).href)
  const graph = path.join(root, 'data', 'graph')
  fs.mkdirSync(graph, { recursive: true })
  const dbPath = path.join(graph, 'brain.sqlite')
  const configPath = path.join(root, 'data', 'config.toml')
  fs.writeFileSync(configPath, '[llm]\nstandard_model = "old-pinned"\n')
  let db = new Database(dbPath)
  legacySchema.ensureSchema(db)
  const connection = legacyConnections.createConnection(db, { name: 'roundtrip fixture', provider_type: 'codex-cli' })
  legacyConnections.updateConnectionStatus(db, connection.id, 'online', ['old-pinned'])
  db.prepare("INSERT INTO llm_usage_log (model, connection_id, input_tokens, output_tokens, estimated_cost, created) VALUES ('old-pinned', ?, 123, 45, 0.0123, '2026-09-25')").run(connection.id)
  const version = () => (db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as {value: string}).value
  assert.equal(version(), '34')
  db.close()
  migrateExistingDatabaseIfNeeded(dbPath, configPath)
  db = new Database(dbPath)
  assert.equal(version(), '35')
  assert.equal(getAuthBinding(db, connection.id), null)
  const first = reconcileAuthBinding(db, { connectionId: connection.id, auth: { scopeState: 'known', scopeKey: 'account-A', method: 'chatgpt' }, cliGeneration: 'fixture-generation', authStoreSignal: null })
  assert.equal(first.binding.authEpoch, 1)
  db.prepare(`INSERT INTO llm_model_observations
    (connection_id, scope_key, auth_epoch, model_id, selection_mode, last_outcome, last_source, updated_at)
    VALUES (?, 'account-A', 1, 'old-pinned', 'pinned_id', 'success', 'test', '2026-09-25')`).run(connection.id)
  db.exec("INSERT INTO metadata VALUES ('roundtrip_business_marker', 'preserved')")
  // The actual old implementation opens v35 without rejecting its version.
  legacySchema.ensureSchema(db)
  legacyConnections.updateConnectionStatus(db, connection.id, 'online', ['legacy-write-must-not-authorize'])
  fs.writeFileSync(configPath, '[llm]\nstandard_model = "old-version-edited-route"\n')
  assert.equal(version(), '35')
  db.close()
  migrateExistingDatabaseIfNeeded(dbPath, configPath)
  db = new Database(dbPath)
  ensureSchema(db)
  const next = reconcileAuthBinding(db, { connectionId: connection.id, auth: { scopeState: 'known', scopeKey: 'account-B', method: 'chatgpt' }, cliGeneration: 'fixture-generation', authStoreSignal: null })
  assert.equal(next.binding.authEpoch, 2)
  assert.equal(listModelObservations(db, connection.id).filter(row => row.authEpoch === 2).length, 0)
  assert.equal(listModelObservations(db, connection.id).filter(row => row.authEpoch === 1).length, 1)
  assert.equal((db.prepare("SELECT value FROM metadata WHERE key='roundtrip_business_marker'").get() as {value:string}).value, 'preserved')
  assert.match(fs.readFileSync(configPath, 'utf8'), /old-version-edited-route/)
  assert.deepEqual(db.prepare('SELECT input_tokens, output_tokens, estimated_cost FROM llm_usage_log WHERE connection_id = ?').all(connection.id), [{ input_tokens: 123, output_tokens: 45, estimated_cost: 0.0123 }])
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  db.close()
  // Formal recovery is performed only after all handles are closed.
  const backup = fs.readdirSync(graph).find(name => name.startsWith('brain.backup-'))!
  const stamp = backup.slice('brain.backup-'.length, -'.sqlite'.length)
  fs.copyFileSync(path.join(graph, backup), dbPath)
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })
  fs.copyFileSync(path.join(graph, `config.backup-${stamp}.toml`), configPath)
  db = new Database(dbPath)
  legacySchema.ensureSchema(db)
  assert.equal(version(), '34')
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='roundtrip_business_marker'").get(), undefined)
  assert.match(fs.readFileSync(configPath, 'utf8'), /old-pinned/)
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  db.close()
  process.stdout.write(JSON.stringify({ baseline, oldCodeModules: exported.size, upgrade: true, actualOldCodeReopenAndWrite: true,
    reupgradeAuthIsolation: true, oldRoutePreserved: true, costHistoryPreserved: true, formalPairRestore: true, postBackupDataLossConfirmed: true, realUserDataTouched: false }) + '\n')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
