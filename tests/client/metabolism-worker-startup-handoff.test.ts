import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMetabolismWorkerStartupHandoffIssuer,
  MetabolismWorkerStartupHandoffError,
} from '../../client/electron/workers/metabolism-worker-startup-handoff.js'
import { getConfig } from '../../src/config.js'
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema.js'
import { WORKER_DATA_SCOPE_METADATA_KEY } from '../../src/db/worker-initialized-database.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-worker-handoff-'))
  roots.push(dataDir)
  const graphDir = path.join(dataDir, 'graph')
  fs.mkdirSync(graphDir)
  const dbPath = path.join(graphDir, 'brain.sqlite')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  ensureSchema(db)
  const config = structuredClone(getConfig())
  config.general.data_dir = dataDir
  config.cloud.metabolism_enabled = false
  return { dataDir, dbPath, db, config }
}

function schemaObjects(db: Database.Database): string[] {
  return (db.prepare("SELECT type || ':' || name AS value FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ value: string }>).map(row => row.value)
}

describe('metabolism Worker startup handoff', () => {
  it('derives the bootstrap from the initialized main connection without changing schema objects', () => {
    const { dataDir, db, config } = fixture()
    const before = schemaObjects(db)
    const issuer = createMetabolismWorkerStartupHandoffIssuer({
      db,
      dataDir,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 7,
      vecCapability: 'unavailable',
      createReceiptId: () => 'daemon-receipt-7',
    })
    const first = issuer.build(config, 1, 1)
    expect(first.startupAuthority).toEqual({
      controllerReceiptId: 'daemon-receipt-7',
      dataScopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      controllerGeneration: 7,
    })
    expect(first.databaseIdentity.canonicalRealPath).toBe(fs.realpathSync.native(path.join(dataDir, 'graph', 'brain.sqlite')))
    expect(first.expectedSchemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(first.runtimeConfigSnapshot.general).toMatchObject({ data_dir: fs.realpathSync.native(dataDir) })
    expect(first.runtimeConnectionSnapshot).toEqual({ connections: [] })
    expect(first.authorizedRoots.dataDir).toBe(fs.realpathSync.native(dataDir))
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?').pluck().get(WORKER_DATA_SCOPE_METADATA_KEY)).toBe(first.startupAuthority.dataScopeFingerprint)
    expect(schemaObjects(db)).toEqual(before)

    const second = issuer.build(config, 2, 2)
    expect(second.startupAuthority).toEqual(first.startupAuthority)
    expect(second.lifecycleGeneration).toBe(2)
    expect(second.runtimeRevision).toBe(2)
    expect(second.databaseIdentity.identityCommitment).toBe(first.databaseIdentity.identityCommitment)
    db.close()
  })

  it('requires the canonical server database location and exact schema', () => {
    const { dataDir, db, config } = fixture()
    db.close()
    const wrongPath = path.join(dataDir, 'other.sqlite')
    const wrongDb = new Database(wrongPath)
    wrongDb.pragma('journal_mode = WAL')
    ensureSchema(wrongDb)
    expect(() => createMetabolismWorkerStartupHandoffIssuer({
      db: wrongDb,
      dataDir,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 1,
      vecCapability: 'unavailable',
    })).toThrowError(expect.objectContaining({ code: 'DATABASE_PATH_MISMATCH' }))
    wrongDb.close()

    const valid = new Database(path.join(dataDir, 'graph', 'brain.sqlite'))
    valid.prepare("UPDATE metadata SET value = '32' WHERE key = 'schema_version'").run()
    expect(() => createMetabolismWorkerStartupHandoffIssuer({
      db: valid,
      dataDir,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 1,
      vecCapability: 'unavailable',
    })).toThrowError(expect.objectContaining({ code: 'DATABASE_SCHEMA_MISMATCH' }))
    valid.close()
    expect(config.general.data_dir).toBe(dataDir)
  })

  it('fails closed on file, metadata, data-dir, generation and lifecycle drift', () => {
    const first = fixture()
    const issuer = createMetabolismWorkerStartupHandoffIssuer({
      db: first.db,
      dataDir: first.dataDir,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 1,
      vecCapability: 'unavailable',
      createReceiptId: () => 'receipt',
    })
    issuer.build(first.config, 1, 1)
    expect(() => issuer.build(first.config, 3, 2)).toThrowError(expect.objectContaining({ code: 'LIFECYCLE_GENERATION_OUT_OF_ORDER' }))
    expect(() => issuer.build(first.config, 2, 1)).toThrowError(expect.objectContaining({ code: 'RUNTIME_REVISION_NOT_MONOTONIC' }))

    first.db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run('f'.repeat(64), WORKER_DATA_SCOPE_METADATA_KEY)
    expect(() => issuer.build(first.config, 2, 2)).toThrowError(expect.objectContaining({ code: 'DATA_SCOPE_DRIFT' }))
    first.db.close()

    const second = fixture()
    const replacementIssuer = createMetabolismWorkerStartupHandoffIssuer({
      db: second.db,
      dataDir: second.dataDir,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 2,
      vecCapability: 'unavailable',
    })
    fs.renameSync(second.dbPath, `${second.dbPath}.old`)
    const replacement = new Database(second.dbPath)
    replacement.pragma('journal_mode = WAL')
    ensureSchema(replacement)
    replacement.close()
    expect(() => replacementIssuer.build(second.config, 1, 1)).toThrowError(expect.objectContaining({ code: 'DATABASE_FILE_IDENTITY_DRIFT' }))
    second.db.close()

    const third = fixture()
    const invalidated = createMetabolismWorkerStartupHandoffIssuer({
      db: third.db,
      dataDir: third.dataDir,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 3,
      vecCapability: 'unavailable',
    })
    invalidated.invalidate()
    expect(() => invalidated.build(third.config, 1, 1)).toThrowError(expect.objectContaining({ code: 'HANDOFF_INVALIDATED' }))
    third.db.close()
  })

  it('rejects a configured data-dir symlink that drifts after issuer creation', () => {
    const actual = fixture()
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-worker-handoff-link-'))
    roots.push(linkRoot)
    const configuredPath = path.join(linkRoot, 'data')
    fs.symlinkSync(actual.dataDir, configuredPath)
    actual.config.general.data_dir = configuredPath
    const issuer = createMetabolismWorkerStartupHandoffIssuer({
      db: actual.db,
      dataDir: configuredPath,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 1,
      vecCapability: 'unavailable',
    })
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-worker-handoff-other-'))
    roots.push(other)
    fs.unlinkSync(configuredPath)
    fs.symlinkSync(other, configuredPath)
    expect(() => issuer.build(actual.config, 1, 1)).toThrowError(MetabolismWorkerStartupHandoffError)
    expect(() => issuer.build(actual.config, 1, 1)).toThrowError(expect.objectContaining({ code: 'DATA_DIR_DRIFT' }))
    actual.db.close()
  })

  it('rejects an external runtime source that changes while its snapshot is being built', () => {
    const actual = fixture()
    const strategiesDir = path.join(actual.dataDir, 'strategies')
    fs.mkdirSync(strategiesDir)
    fs.writeFileSync(path.join(strategiesDir, 'worker.system.md'), 'before')
    const issuer = createMetabolismWorkerStartupHandoffIssuer({
      db: actual.db,
      dataDir: actual.dataDir,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      controllerGeneration: 1,
      vecCapability: 'unavailable',
      _testHooks: {
        afterRuntimeSnapshotRead: () => {
          fs.writeFileSync(path.join(strategiesDir, 'worker.system.md'), 'after')
        },
      },
    })

    expect(() => issuer.build(actual.config, 1, 1)).toThrowError(
      expect.objectContaining({ code: 'EXTERNAL_RUNTIME_SOURCE_DRIFT' }),
    )
    actual.db.close()
  })
})
