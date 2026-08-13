import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deriveInitializedDatabaseIdentity,
  createWorkerDataScopeFingerprint,
  openInitializedDatabase,
  WorkerDatabaseOpenError,
  type WorkerStartupAuthorityIdentity,
} from '../../src/db/worker-initialized-database.js'
import { resolveSqliteVecLoadablePath } from '../../src/db/sqlite-vec-path.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(options: { schema?: number; scope?: string; vec?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-worker-db-'))
  roots.push(dataDir)
  fs.mkdirSync(path.join(dataDir, 'graph'))
  const dbPath = path.join(dataDir, 'graph', 'brain.sqlite')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('schema_version', String(options.schema ?? 33))
  const stat = fs.statSync(dbPath)
  const computedScope = createWorkerDataScopeFingerprint({
    canonicalDataDir: fs.realpathSync.native(dataDir),
    canonicalRealPath: fs.realpathSync.native(dbPath),
    deviceId: String(stat.dev),
    inodeId: String(stat.ino),
    expectedSchemaVersion: options.schema ?? 33,
  })
  const authority: WorkerStartupAuthorityIdentity = {
    controllerReceiptId: 'controller-receipt-1',
    dataScopeFingerprint: computedScope,
    controllerGeneration: 1,
  }
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('startup_data_scope_fingerprint', options.scope ?? computedScope)
  if (options.vec) db.exec('CREATE TABLE nodes_vec (id TEXT PRIMARY KEY, embedding BLOB)')
  return { dataDir, dbPath, db, authority }
}

describe('Worker initialized database opener', () => {
  it('rewrites only the packed asar path segment for sqlite-vec', () => {
    expect(resolveSqliteVecLoadablePath('/Applications/Tide Mind.app/Contents/Resources/app.asar/node_modules/sqlite-vec/vec0.dylib'))
      .toBe('/Applications/Tide Mind.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec/vec0.dylib')
    expect(resolveSqliteVecLoadablePath('/Applications/Tide Mind.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec/vec0.dylib'))
      .toBe('/Applications/Tide Mind.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec/vec0.dylib')
  })
  it('opens the exact existing WAL database without migration or path fallback', async () => {
    const { dataDir, db, dbPath, authority } = fixture()
    const identity = deriveInitializedDatabaseIdentity(db, authority, 33)
    db.close()
    const installed = vi.fn()
    const cleared = vi.fn()
    const opened = await openInitializedDatabase({
      startupAuthority: authority,
      expectedSchemaVersion: 33,
      databaseIdentity: identity,
      authorizedDataDir: dataDir,
      vecCapability: 'unavailable',
      busyTimeoutMs: 250,
    }, { installUsageDb: installed, clearUsageDb: cleared })
    expect(opened.db.name).toBe(fs.realpathSync.native(dbPath))
    expect(opened.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(opened.db.pragma('wal_autocheckpoint', { simple: true })).toBe(0)
    expect(installed).toHaveBeenCalledTimes(1)
    opened.close()
    opened.close()
    expect(cleared).toHaveBeenCalledTimes(1)
  })

  it('rejects file replacement, schema and data-scope drift', async () => {
    const first = fixture()
    const identity = deriveInitializedDatabaseIdentity(first.db, first.authority, 33)
    first.db.close()
    fs.renameSync(first.dbPath, `${first.dbPath}.old`)
    const replacement = new Database(first.dbPath)
    replacement.pragma('journal_mode = WAL')
    replacement.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    replacement.prepare('INSERT INTO metadata VALUES (?, ?)').run('schema_version', '33')
    replacement.prepare('INSERT INTO metadata VALUES (?, ?)').run('startup_data_scope_fingerprint', first.authority.dataScopeFingerprint)
    replacement.close()
    await expect(openInitializedDatabase({ startupAuthority: first.authority, expectedSchemaVersion: 33, databaseIdentity: identity, authorizedDataDir: first.dataDir, vecCapability: 'unavailable', busyTimeoutMs: 0 })).rejects.toBeInstanceOf(WorkerDatabaseOpenError)

    const wrongSchema = fixture({ schema: 32 })
    expect(() => deriveInitializedDatabaseIdentity(wrongSchema.db, wrongSchema.authority, 33)).toThrowError(WorkerDatabaseOpenError)
    wrongSchema.db.close()
    const wrongScope = fixture({ scope: 'b'.repeat(64) })
    expect(() => deriveInitializedDatabaseIdentity(wrongScope.db, wrongScope.authority, 33)).toThrowError(WorkerDatabaseOpenError)
    wrongScope.db.close()
  })

  it('never creates a missing file and rejects a database outside its authorized root', async () => {
    const { dataDir, db, authority } = fixture()
    const identity = deriveInitializedDatabaseIdentity(db, authority, 33)
    db.close()
    fs.unlinkSync(identity.canonicalRealPath)
    await expect(openInitializedDatabase({ startupAuthority: authority, expectedSchemaVersion: 33, databaseIdentity: identity, authorizedDataDir: dataDir, vecCapability: 'unavailable', busyTimeoutMs: 0 })).rejects.toBeInstanceOf(WorkerDatabaseOpenError)
    expect(fs.existsSync(identity.canonicalRealPath)).toBe(false)

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-worker-other-'))
    roots.push(otherRoot)
    await expect(openInitializedDatabase({ startupAuthority: authority, expectedSchemaVersion: 33, databaseIdentity: identity, authorizedDataDir: otherRoot, vecCapability: 'unavailable', busyTimeoutMs: 0 })).rejects.toMatchObject({ code: 'DATABASE_OUTSIDE_AUTHORIZED_ROOT' })

    // A broader parent still contains the DB, but is not the exact data scope
    // that produced the startup authority.
    const broad = fixture()
    const broadIdentity = deriveInitializedDatabaseIdentity(broad.db, broad.authority, 33)
    broad.db.close()
    await expect(openInitializedDatabase({
      startupAuthority: broad.authority,
      expectedSchemaVersion: 33,
      databaseIdentity: broadIdentity,
      authorizedDataDir: path.dirname(broad.dataDir),
      vecCapability: 'unavailable',
      busyTimeoutMs: 0,
    })).rejects.toBeInstanceOf(WorkerDatabaseOpenError)
  })

  it('requires vec load and the initialized vector table when capability is ready', async () => {
    const { dataDir, db, authority } = fixture({ vec: true })
    const identity = deriveInitializedDatabaseIdentity(db, authority, 33)
    db.close()
    const loadVec = vi.fn(async () => {})
    const opened = await openInitializedDatabase({ startupAuthority: authority, expectedSchemaVersion: 33, databaseIdentity: identity, authorizedDataDir: dataDir, vecCapability: 'ready', busyTimeoutMs: 100 }, { loadVec })
    expect(loadVec).toHaveBeenCalledTimes(1)
    opened.close()

    const noVec = fixture()
    const noVecIdentity = deriveInitializedDatabaseIdentity(noVec.db, noVec.authority, 33)
    noVec.db.close()
    await expect(openInitializedDatabase({ startupAuthority: noVec.authority, expectedSchemaVersion: 33, databaseIdentity: noVecIdentity, authorizedDataDir: noVec.dataDir, vecCapability: 'ready', busyTimeoutMs: 100 }, { loadVec })).rejects.toMatchObject({ code: 'DATABASE_VEC_TABLE_MISSING' })
  })
})
