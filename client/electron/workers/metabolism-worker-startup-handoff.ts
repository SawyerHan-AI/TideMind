import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AppConfig } from '../../../src/types.js'
import {
  deriveInitializedDatabaseIdentity,
  createWorkerDataScopeFingerprint,
  WORKER_DATA_SCOPE_METADATA_KEY,
  type WorkerStartupAuthorityIdentity,
} from '../../../src/db/worker-initialized-database.js'
import type { VecCapability } from '../../../src/db/connection.js'
import { buildMetabolismWorkerRuntimeSnapshotFromInitializedMain } from '../../../src/metabolism/worker-runtime-snapshot-source.js'
import {
  snapshotMetabolismWorkerBootstrap,
  type MetabolismWorkerBootstrapV1,
} from './metabolism-worker-protocol.js'
import { fingerprintMetabolismWorkerExternalRuntimeSources } from './metabolism-worker-runtime-mutations.js'

export class MetabolismWorkerStartupHandoffError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'MetabolismWorkerStartupHandoffError'
  }
}

function fail(code: string): never {
  throw new MetabolismWorkerStartupHandoffError(code)
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) fail(code)
  return value
}

function canonicalMainPath(db: Database.Database): string {
  const rows = db.pragma('database_list') as Array<{ name: string; file: string }>
  const main = rows.find(row => row.name === 'main')
  if (!main?.file || !path.isAbsolute(main.file)) fail('DATABASE_LIST_INVALID')
  try {
    return fs.realpathSync.native(main.file)
  } catch {
    fail('DATABASE_FILE_IDENTITY_UNAVAILABLE')
  }
}

function readSchemaVersion(db: Database.Database): number {
  let row: { value: string } | undefined
  try {
    row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined
  } catch {
    fail('DATABASE_SCHEMA_MISSING')
  }
  const version = row ? Number(row.value) : Number.NaN
  if (!Number.isSafeInteger(version) || version < 1) fail('DATABASE_SCHEMA_INVALID')
  return version
}

function canonicalDataDir(dataDir: string): string {
  if (!path.isAbsolute(dataDir)) fail('DATA_DIR_NOT_ABSOLUTE')
  try {
    const real = fs.realpathSync.native(dataDir)
    if (!fs.statSync(real).isDirectory()) fail('DATA_DIR_INVALID')
    return real
  } catch (error) {
    if (error instanceof MetabolismWorkerStartupHandoffError) throw error
    fail('DATA_DIR_UNAVAILABLE')
  }
}

function databaseFacts(db: Database.Database, dataDir: string, expectedSchemaVersion: number) {
  const canonicalRealPath = canonicalMainPath(db)
  const expectedPath = path.join(dataDir, 'graph', 'brain.sqlite')
  if (canonicalRealPath !== expectedPath) fail('DATABASE_PATH_MISMATCH')
  let stat: fs.Stats
  try {
    stat = fs.statSync(canonicalRealPath)
  } catch {
    fail('DATABASE_FILE_IDENTITY_UNAVAILABLE')
  }
  if (!stat.isFile()) fail('DATABASE_FILE_IDENTITY_INVALID')
  if (stat.nlink !== 1) fail('DATABASE_FILE_LINK_COUNT_INVALID')
  if (readSchemaVersion(db) !== expectedSchemaVersion) fail('DATABASE_SCHEMA_MISMATCH')
  return Object.freeze({
    canonicalRealPath,
    deviceId: String(stat.dev),
    inodeId: String(stat.ino),
    expectedSchemaVersion,
  })
}

function assertDatabaseFileIdentityUnchanged(
  db: Database.Database,
  expected: { readonly canonicalRealPath: string; readonly deviceId: string; readonly inodeId: string },
): void {
  const canonicalRealPath = canonicalMainPath(db)
  let stat: fs.Stats
  try {
    stat = fs.statSync(canonicalRealPath)
  } catch {
    fail('DATABASE_FILE_IDENTITY_UNAVAILABLE')
  }
  if (
    canonicalRealPath !== expected.canonicalRealPath
    || String(stat.dev) !== expected.deviceId
    || String(stat.ino) !== expected.inodeId
  ) fail('DATABASE_FILE_IDENTITY_DRIFT')
}

export function createMetabolismWorkerDataScopeFingerprint(facts: {
  readonly canonicalDataDir: string
  readonly canonicalRealPath: string
  readonly deviceId: string
  readonly inodeId: string
  readonly expectedSchemaVersion: number
}): string {
  return createWorkerDataScopeFingerprint(facts)
}

function persistDataScopeFingerprint(db: Database.Database, fingerprint: string): void {
  const writeAndVerify = db.transaction(() => {
    db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(WORKER_DATA_SCOPE_METADATA_KEY, fingerprint)
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(WORKER_DATA_SCOPE_METADATA_KEY) as { value: string } | undefined
    if (row?.value !== fingerprint) fail('DATA_SCOPE_WRITE_MISMATCH')
  })
  try {
    writeAndVerify.immediate()
  } catch (error) {
    if (error instanceof MetabolismWorkerStartupHandoffError) throw error
    fail('DATA_SCOPE_WRITE_FAILED')
  }
}

export interface MetabolismWorkerStartupHandoffIssuerOptions {
  readonly db: Database.Database
  readonly dataDir: string
  readonly expectedSchemaVersion: number
  readonly controllerGeneration: number
  readonly vecCapability: VecCapability
  readonly createReceiptId?: () => string
  readonly _testHooks?: {
    readonly afterRuntimeSnapshotRead?: () => void
  }
}

export interface MetabolismWorkerStartupHandoffIssuer {
  readonly startupAuthority: WorkerStartupAuthorityIdentity
  build(config: AppConfig, lifecycleGeneration: number, runtimeRevision: number): MetabolismWorkerBootstrapV1
  invalidate(): void
}

export function createMetabolismWorkerStartupHandoffIssuer(
  options: MetabolismWorkerStartupHandoffIssuerOptions,
): MetabolismWorkerStartupHandoffIssuer {
  positiveInteger(options.expectedSchemaVersion, 'INVALID_SCHEMA_VERSION')
  positiveInteger(options.controllerGeneration, 'INVALID_CONTROLLER_GENERATION')
  if (options.vecCapability !== 'ready' && options.vecCapability !== 'unavailable') fail('INVALID_VEC_CAPABILITY')

  const originalDataDir = options.dataDir
  const dataDir = canonicalDataDir(originalDataDir)
  const initialFacts = databaseFacts(options.db, dataDir, options.expectedSchemaVersion)
  const dataScopeFingerprint = createMetabolismWorkerDataScopeFingerprint({
    canonicalDataDir: dataDir,
    ...initialFacts,
  })
  persistDataScopeFingerprint(options.db, dataScopeFingerprint)

  const controllerReceiptId = (options.createReceiptId ?? (() => crypto.randomUUID()))()
  if (typeof controllerReceiptId !== 'string' || controllerReceiptId.length < 1 || controllerReceiptId.length > 4096) {
    fail('INVALID_CONTROLLER_RECEIPT')
  }
  const startupAuthority = Object.freeze({
    controllerReceiptId,
    dataScopeFingerprint,
    controllerGeneration: options.controllerGeneration,
  })
  let active = true
  let lastLifecycleGeneration = 0
  let lastRuntimeRevision = 0

  return Object.freeze({
    startupAuthority,
    build(config: AppConfig, lifecycleGeneration: number, runtimeRevision: number): MetabolismWorkerBootstrapV1 {
      if (!active) fail('HANDOFF_INVALIDATED')
      positiveInteger(lifecycleGeneration, 'INVALID_LIFECYCLE_GENERATION')
      positiveInteger(runtimeRevision, 'INVALID_RUNTIME_REVISION')
      if (lifecycleGeneration !== lastLifecycleGeneration + 1) fail('LIFECYCLE_GENERATION_OUT_OF_ORDER')
      if (runtimeRevision <= lastRuntimeRevision) fail('RUNTIME_REVISION_NOT_MONOTONIC')

      if (canonicalDataDir(originalDataDir) !== dataDir) fail('DATA_DIR_DRIFT')
      if (!config.general || canonicalDataDir(config.general.data_dir) !== dataDir) fail('CONFIG_DATA_DIR_DRIFT')
      assertDatabaseFileIdentityUnchanged(options.db, initialFacts)
      const currentFacts = databaseFacts(options.db, dataDir, options.expectedSchemaVersion)
      if (
        currentFacts.canonicalRealPath !== initialFacts.canonicalRealPath
        || currentFacts.deviceId !== initialFacts.deviceId
        || currentFacts.inodeId !== initialFacts.inodeId
      ) fail('DATABASE_FILE_IDENTITY_DRIFT')

      const metadata = options.db.prepare('SELECT value FROM metadata WHERE key = ?').get(WORKER_DATA_SCOPE_METADATA_KEY) as { value: string } | undefined
      if (metadata?.value !== dataScopeFingerprint) fail('DATA_SCOPE_DRIFT')

      const normalizedConfig = structuredClone(config)
      normalizedConfig.general.data_dir = dataDir
      const externalSourceFingerprintBefore = fingerprintMetabolismWorkerExternalRuntimeSources(dataDir)
      const runtime = buildMetabolismWorkerRuntimeSnapshotFromInitializedMain(
        options.db,
        normalizedConfig,
        dataDir,
        runtimeRevision,
      )
      options._testHooks?.afterRuntimeSnapshotRead?.()
      const externalSourceFingerprintAfter = fingerprintMetabolismWorkerExternalRuntimeSources(dataDir)
      if (externalSourceFingerprintAfter !== externalSourceFingerprintBefore) {
        fail('EXTERNAL_RUNTIME_SOURCE_DRIFT')
      }
      const databaseIdentity = deriveInitializedDatabaseIdentity(
        options.db,
        startupAuthority,
        options.expectedSchemaVersion,
      )
      const bootstrap = snapshotMetabolismWorkerBootstrap({
        protocolVersion: 1,
        lifecycleGeneration,
        startupAuthority,
        databaseIdentity,
        expectedSchemaVersion: options.expectedSchemaVersion,
        runtimeRevision,
        runtimeConfigSnapshot: runtime.runtimeConfig,
        runtimeConnectionSnapshot: { connections: runtime.connections },
        strategySnapshot: runtime.strategy,
        strategySourceFingerprint: runtime.strategySourceFingerprint,
        externalRuntimeSourceFingerprint: externalSourceFingerprintAfter,
        credentialSnapshot: runtime.credentials,
        authorizedRoots: runtime.authorizedRoots,
        vecCapability: options.vecCapability,
      })
      lastLifecycleGeneration = lifecycleGeneration
      lastRuntimeRevision = runtimeRevision
      return bootstrap
    },
    invalidate(): void {
      active = false
    },
  })
}
