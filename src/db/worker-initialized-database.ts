import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { clearUsageDb, setUsageDb } from '../llm/client.js'
import { resolveSqliteVecLoadablePath } from './sqlite-vec-path.js'
import type { VecCapability } from './connection.js'

export interface WorkerStartupAuthorityIdentity {
  readonly controllerReceiptId: string
  readonly dataScopeFingerprint: string
  readonly controllerGeneration: number
}

export interface InitializedDatabaseIdentity {
  readonly canonicalRealPath: string
  readonly deviceId: string
  readonly inodeId: string
  readonly identityCommitment: string
}

export interface InitializedDatabaseIdentityFacts {
  readonly startupAuthority: WorkerStartupAuthorityIdentity
  readonly expectedSchemaVersion: number
  readonly canonicalRealPath: string
  readonly deviceId: string
  readonly inodeId: string
}

export interface OpenInitializedDatabaseRequest {
  readonly startupAuthority: WorkerStartupAuthorityIdentity
  readonly expectedSchemaVersion: number
  readonly databaseIdentity: InitializedDatabaseIdentity
  readonly authorizedDataDir: string
  readonly vecCapability: VecCapability
  readonly busyTimeoutMs: number
}

export interface OpenedInitializedDatabase {
  readonly db: Database.Database
  readonly identity: InitializedDatabaseIdentity
  readonly vecCapability: VecCapability
  close(): void
}

export interface OpenInitializedDatabaseDependencies {
  readonly createDatabase?: (filename: string) => Database.Database
  readonly loadVec?: (db: Database.Database) => Promise<void>
  readonly installUsageDb?: (db: Database.Database) => void
  readonly clearUsageDb?: (db: Database.Database) => void
}

const HASH = /^[a-f0-9]{64}$/
export const WORKER_DATA_SCOPE_METADATA_KEY = 'startup_data_scope_fingerprint'
const WORKER_DATA_SCOPE_DOMAIN = 'metabolism-worker-data-scope-v1'

export class WorkerDatabaseOpenError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'WorkerDatabaseOpenError'
  }
}

function reject(code: string): never {
  throw new WorkerDatabaseOpenError(code)
}

function assertAuthority(value: WorkerStartupAuthorityIdentity): void {
  if (!value || typeof value.controllerReceiptId !== 'string' || value.controllerReceiptId.length < 1 || value.controllerReceiptId.length > 4096) reject('INVALID_STARTUP_AUTHORITY')
  if (!HASH.test(value.dataScopeFingerprint)) reject('INVALID_STARTUP_AUTHORITY')
  if (!Number.isSafeInteger(value.controllerGeneration) || value.controllerGeneration < 1) reject('INVALID_STARTUP_AUTHORITY')
}

function canonicalFacts(facts: InitializedDatabaseIdentityFacts): string {
  return JSON.stringify({
    protocol: 'metabolism-worker-database-identity-v1',
    startupAuthority: {
      controllerReceiptId: facts.startupAuthority.controllerReceiptId,
      dataScopeFingerprint: facts.startupAuthority.dataScopeFingerprint,
      controllerGeneration: facts.startupAuthority.controllerGeneration,
    },
    expectedSchemaVersion: facts.expectedSchemaVersion,
    canonicalRealPath: facts.canonicalRealPath,
    deviceId: facts.deviceId,
    inodeId: facts.inodeId,
  })
}

export function createInitializedDatabaseIdentityCommitment(facts: InitializedDatabaseIdentityFacts): string {
  assertAuthority(facts.startupAuthority)
  if (!Number.isSafeInteger(facts.expectedSchemaVersion) || facts.expectedSchemaVersion < 1) reject('INVALID_SCHEMA_VERSION')
  if (!path.isAbsolute(facts.canonicalRealPath)) reject('INVALID_DATABASE_PATH')
  if (!facts.deviceId || !facts.inodeId) reject('INVALID_DATABASE_FILE_IDENTITY')
  return crypto.createHash('sha256').update(canonicalFacts(facts)).digest('hex')
}

export function createWorkerDataScopeFingerprint(facts: {
  readonly canonicalDataDir: string
  readonly canonicalRealPath: string
  readonly deviceId: string
  readonly inodeId: string
  readonly expectedSchemaVersion: number
}): string {
  if (!path.isAbsolute(facts.canonicalDataDir) || !path.isAbsolute(facts.canonicalRealPath)) reject('INVALID_DATABASE_PATH')
  if (!facts.deviceId || !facts.inodeId) reject('INVALID_DATABASE_FILE_IDENTITY')
  if (!Number.isSafeInteger(facts.expectedSchemaVersion) || facts.expectedSchemaVersion < 1) reject('INVALID_SCHEMA_VERSION')
  return crypto.createHash('sha256').update(JSON.stringify({
    protocol: WORKER_DATA_SCOPE_DOMAIN,
    canonicalDataDir: facts.canonicalDataDir,
    canonicalRealPath: facts.canonicalRealPath,
    deviceId: facts.deviceId,
    inodeId: facts.inodeId,
    expectedSchemaVersion: facts.expectedSchemaVersion,
  })).digest('hex')
}

function databaseMainPath(db: Database.Database): string {
  const rows = db.pragma('database_list') as Array<{ name: string; file: string }>
  const main = rows.find(row => row.name === 'main')
  if (!main?.file || !path.isAbsolute(main.file)) reject('DATABASE_LIST_INVALID')
  return main.file
}

function schemaVersion(db: Database.Database): number {
  let row: { value: string } | undefined
  try {
    row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined
  } catch {
    reject('DATABASE_SCHEMA_MISSING')
  }
  const version = row ? Number(row.value) : Number.NaN
  if (!Number.isSafeInteger(version) || version < 1) reject('DATABASE_SCHEMA_INVALID')
  return version
}

function dataScopeFingerprint(db: Database.Database): string {
  let row: { value: string } | undefined
  try {
    row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(WORKER_DATA_SCOPE_METADATA_KEY) as { value: string } | undefined
  } catch {
    reject('DATABASE_DATA_SCOPE_MISSING')
  }
  if (!row || !HASH.test(row.value)) reject('DATABASE_DATA_SCOPE_MISSING')
  return row.value
}

function identityFacts(db: Database.Database, startupAuthority: WorkerStartupAuthorityIdentity, expectedSchemaVersion: number): InitializedDatabaseIdentityFacts {
  assertAuthority(startupAuthority)
  const listedPath = databaseMainPath(db)
  let canonicalRealPath: string
  let stat: fs.Stats
  try {
    canonicalRealPath = fs.realpathSync.native(listedPath)
    stat = fs.statSync(canonicalRealPath)
  } catch {
    reject('DATABASE_FILE_IDENTITY_UNAVAILABLE')
  }
  if (!stat.isFile()) reject('DATABASE_FILE_IDENTITY_INVALID')
  if (stat.nlink !== 1) reject('DATABASE_FILE_LINK_COUNT_INVALID')
  if (schemaVersion(db) !== expectedSchemaVersion) reject('DATABASE_SCHEMA_MISMATCH')
  if (dataScopeFingerprint(db) !== startupAuthority.dataScopeFingerprint) reject('DATABASE_DATA_SCOPE_MISMATCH')
  return Object.freeze({
    startupAuthority: Object.freeze({ ...startupAuthority }),
    expectedSchemaVersion,
    canonicalRealPath,
    deviceId: String(stat.dev),
    inodeId: String(stat.ino),
  })
}

export function deriveInitializedDatabaseIdentity(
  db: Database.Database,
  startupAuthority: WorkerStartupAuthorityIdentity,
  expectedSchemaVersion: number,
): InitializedDatabaseIdentity {
  const facts = identityFacts(db, startupAuthority, expectedSchemaVersion)
  return Object.freeze({
    canonicalRealPath: facts.canonicalRealPath,
    deviceId: facts.deviceId,
    inodeId: facts.inodeId,
    identityCommitment: createInitializedDatabaseIdentityCommitment(facts),
  })
}

function insideRoot(filePath: string, dataDir: string): boolean {
  const relative = path.relative(dataDir, filePath)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function defaultLoadVec(db: Database.Database): Promise<void> {
  const sqliteVec = await import('sqlite-vec')
  const loadablePath = resolveSqliteVecLoadablePath(sqliteVec.getLoadablePath())
  db.loadExtension(loadablePath)
}

export async function openInitializedDatabase(
  request: OpenInitializedDatabaseRequest,
  dependencies: OpenInitializedDatabaseDependencies = {},
): Promise<OpenedInitializedDatabase> {
  assertAuthority(request.startupAuthority)
  if (!Number.isSafeInteger(request.busyTimeoutMs) || request.busyTimeoutMs < 0 || request.busyTimeoutMs > 60_000) reject('INVALID_BUSY_TIMEOUT')
  let canonicalDataDir: string
  try {
    canonicalDataDir = fs.realpathSync.native(request.authorizedDataDir)
  } catch {
    reject('AUTHORIZED_ROOT_UNAVAILABLE')
  }
  try {
    if (!fs.statSync(canonicalDataDir).isDirectory()) reject('AUTHORIZED_ROOT_INVALID')
  } catch (error) {
    if (error instanceof WorkerDatabaseOpenError) throw error
    reject('AUTHORIZED_ROOT_UNAVAILABLE')
  }
  if (!insideRoot(request.databaseIdentity.canonicalRealPath, canonicalDataDir)) reject('DATABASE_OUTSIDE_AUTHORIZED_ROOT')
  if (!HASH.test(request.databaseIdentity.identityCommitment)) reject('DATABASE_IDENTITY_INVALID')

  const createDatabase = dependencies.createDatabase ?? ((filename: string) => new Database(filename, { fileMustExist: true }))
  const installUsage = dependencies.installUsageDb ?? setUsageDb
  const clearUsage = dependencies.clearUsageDb ?? clearUsageDb
  let db: Database.Database | null = null
  try {
    try { db = createDatabase(request.databaseIdentity.canonicalRealPath) } catch { reject('DATABASE_CONNECTION_FAILED') }
    try {
      db.pragma(`busy_timeout = ${request.busyTimeoutMs}`)
      db.pragma('foreign_keys = ON')
      // Checkpoint ownership belongs to the scheduler pass boundary. Automatic
      // checkpoints can otherwise make an arbitrary short batch/foreground
      // commit inherit hundreds of milliseconds of checkpoint I/O.
      db.pragma('wal_autocheckpoint = 0')
    } catch { reject('DATABASE_PRAGMA_FAILED') }
    if (db.pragma('foreign_keys', { simple: true }) !== 1) reject('DATABASE_FOREIGN_KEYS_UNAVAILABLE')
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') reject('DATABASE_JOURNAL_MODE_MISMATCH')

    const actualIdentity = deriveInitializedDatabaseIdentity(db, request.startupAuthority, request.expectedSchemaVersion)
    if (actualIdentity.canonicalRealPath !== path.join(canonicalDataDir, 'graph', 'brain.sqlite')) {
      reject('DATABASE_PATH_MISMATCH')
    }
    const recomputedDataScope = createWorkerDataScopeFingerprint({
      canonicalDataDir,
      canonicalRealPath: actualIdentity.canonicalRealPath,
      deviceId: actualIdentity.deviceId,
      inodeId: actualIdentity.inodeId,
      expectedSchemaVersion: request.expectedSchemaVersion,
    })
    if (recomputedDataScope !== request.startupAuthority.dataScopeFingerprint) reject('DATABASE_DATA_SCOPE_MISMATCH')
    if (
      actualIdentity.canonicalRealPath !== request.databaseIdentity.canonicalRealPath
      || actualIdentity.deviceId !== request.databaseIdentity.deviceId
      || actualIdentity.inodeId !== request.databaseIdentity.inodeId
      || actualIdentity.identityCommitment !== request.databaseIdentity.identityCommitment
    ) reject('DATABASE_IDENTITY_MISMATCH')

    if (request.vecCapability === 'ready') {
      try { await (dependencies.loadVec ?? defaultLoadVec)(db) } catch { reject('DATABASE_VEC_LOAD_FAILED') }
      const vectorTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes_vec'").get()
      if (!vectorTable) reject('DATABASE_VEC_TABLE_MISSING')
    } else if (request.vecCapability !== 'unavailable') {
      reject('INVALID_VEC_CAPABILITY')
    }

    installUsage(db)
    const openedDb = db
    let closed = false
    return Object.freeze({
      db: openedDb,
      identity: actualIdentity,
      vecCapability: request.vecCapability,
      close(): void {
        if (closed) return
        closed = true
        clearUsage(openedDb)
        openedDb.close()
      },
    })
  } catch (error) {
    if (db) {
      try { clearUsage(db) } catch { /* best effort local reference cleanup */ }
      try { db.close() } catch { /* preserve original failure */ }
    }
    if (error instanceof WorkerDatabaseOpenError) throw error
    throw new WorkerDatabaseOpenError('DATABASE_OPEN_FAILED')
  }
}
