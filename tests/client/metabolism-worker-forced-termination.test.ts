import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MetabolismWorkerController, type WorkerLike } from '../../client/electron/workers/metabolism-worker-controller.js'
import type { MetabolismWorkerBootstrapV1 } from '../../client/electron/workers/metabolism-worker-protocol.js'
import { getSchedulerRunLockPath, tryAcquireSchedulerRunLock } from '../../src/metabolism/scheduler-run-lock.js'

const roots: string[] = []
const hash = (digit: string) => digit.repeat(64)

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function bootstrap(dbPath: string, dataDir: string): MetabolismWorkerBootstrapV1 {
  return {
    protocolVersion: 1,
    lifecycleGeneration: 1,
    startupAuthority: { controllerReceiptId: 'forced-test', dataScopeFingerprint: hash('a'), controllerGeneration: 1 },
    databaseIdentity: { canonicalRealPath: dbPath, deviceId: '1', inodeId: '2', identityCommitment: hash('b') },
    expectedSchemaVersion: 33,
    runtimeRevision: 1,
    runtimeConfigSnapshot: {},
    runtimeConnectionSnapshot: {},
    strategySnapshot: {},
    strategySourceFingerprint: hash('c'), externalRuntimeSourceFingerprint: 'e'.repeat(64),
    credentialSnapshot: {},
    authorizedRoots: { dataDir },
    vecCapability: 'unavailable',
  }
}

describe('metabolism Worker forced termination', () => {
  it('releases a synchronous SQLite writer and never synthesizes stopped', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-metabolism-forced-'))
    roots.push(dataDir)
    const dbPath = path.join(dataDir, 'brain.sqlite')
    new Database(dbPath).close()
    const lockProbeDb = new Database(dbPath)
    const lockPath = getSchedulerRunLockPath(lockProbeDb)
    if (!lockPath) throw new Error('file-backed scheduler lock path is required')
    const require = createRequire(import.meta.url)
    const sqlitePath = require.resolve('better-sqlite3')
    const source = `
      const { parentPort, workerData } = require('node:worker_threads')
      const Database = require(workerData.sqlitePath)
      const db = new Database(workerData.dbPath)
      const owner = new Database(workerData.lockPath)
      parentPort.once('message', message => {
        if (message.kind !== 'set_schedule_context') return
        parentPort.postMessage({ protocolVersion: 1, lifecycleGeneration: 1, kind: 'ready', runtimeRevision: 1, databaseIdentityCommitment: '${hash('b')}', vecCapability: 'unavailable' })
        db.exec('BEGIN IMMEDIATE')
        owner.exec('BEGIN IMMEDIATE')
        parentPort.postMessage({ protocolVersion: 1, lifecycleGeneration: 1, kind: 'idle' })
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      })
    `
    const worker = new Worker(source, { eval: true, workerData: { sqlitePath, dbPath, lockPath } })
    const controller = new MetabolismWorkerController({
      workerPath: '/forced-test.cjs',
      workerFactory: () => worker as WorkerLike,
    })

    const messages: Array<{ kind?: string }> = []
    controller.on('message', message => messages.push(message))
    const ended = new Promise<number>(resolve => controller.once('generation-ended', resolve))

    await controller.start(bootstrap(dbPath, dataDir), 'paused', 'active')
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('writer lock was not acquired')), 5_000)
      const probe = () => {
        const contender = new Database(dbPath)
        contender.pragma('busy_timeout = 0')
        try {
          contender.exec('BEGIN IMMEDIATE')
          contender.exec('ROLLBACK')
          contender.close()
          setTimeout(probe, 10)
        } catch {
          contender.close()
          clearTimeout(deadline)
          resolve()
        }
      }
      probe()
    })
    expect(tryAcquireSchedulerRunLock(lockProbeDb)).toEqual({ acquired: false, reason: 'owner_busy' })

    await controller.forceTerminate()
    await ended
    expect(messages.some(message => message.kind === 'stopped')).toBe(false)
    expect(controller.getState()).toMatchObject({
      lifecycle: 'exited',
      degradationReason: 'forced_termination',
      stoppedSettled: false,
    })

    const schedulerOwner = tryAcquireSchedulerRunLock(lockProbeDb)
    expect(schedulerOwner.acquired).toBe(true)
    if (schedulerOwner.acquired) schedulerOwner.lock.release()
    lockProbeDb.close()

    const contender = new Database(dbPath)
    contender.exec('BEGIN IMMEDIATE')
    contender.exec('ROLLBACK')
    contender.close()
  }, 15_000)
})
