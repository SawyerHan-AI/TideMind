import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../../src/db/schema.js'
import { runSchedulerTick, type TaskDefinition } from '../../src/metabolism/scheduler.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('scheduler WAL checkpoint ownership', () => {
  it('checkpoints only on a pass with no task attempt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-scheduler-checkpoint-'))
    roots.push(root)
    const db = new Database(path.join(root, 'brain.sqlite'))
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    ensureSchema(db)
    const pragma = vi.spyOn(db, 'pragma')

    await runSchedulerTick(db, [])
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)')

    pragma.mockClear()
    const task: TaskDefinition = {
      id: 'checkpoint-effect',
      intervalStrategy: 'test',
      defaultIntervalMinutes: 1,
      execute: vi.fn().mockResolvedValue(undefined),
    }
    await runSchedulerTick(db, [task])
    expect(task.execute).toHaveBeenCalledOnce()
    expect(pragma).not.toHaveBeenCalledWith('wal_checkpoint(PASSIVE)')
    db.close()
  })

  it('makes checkpoint progress after ten minutes of continuously failing attempts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-scheduler-checkpoint-liveness-'))
    roots.push(root)
    const db = new Database(path.join(root, 'brain.sqlite'))
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    ensureSchema(db)
    const pragma = vi.spyOn(db, 'pragma')
    let clock = 1_000
    const task: TaskDefinition = {
      id: 'checkpoint-failing-effect',
      intervalStrategy: 'test',
      defaultIntervalMinutes: 1,
      execute: vi.fn().mockRejectedValue(new Error('still failing')),
    }

    await runSchedulerTick(db, [task], { now: () => clock })
    expect(pragma).not.toHaveBeenCalledWith('wal_checkpoint(PASSIVE)')
    pragma.mockClear()
    clock += 10 * 60 * 1_000 + 1
    await runSchedulerTick(db, [task], { now: () => clock })
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)')
    db.close()
  })

  it('emits structured contention for a task-level SQLite failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-scheduler-contention-'))
    roots.push(root)
    const db = new Database(path.join(root, 'brain.sqlite'))
    ensureSchema(db)
    const events: unknown[] = []
    const task: TaskDefinition = {
      id: 'sqlite-busy-task',
      intervalStrategy: 'test',
      defaultIntervalMinutes: 1,
      execute: vi.fn().mockRejectedValue(Object.assign(new Error('database is busy'), {
        code: 'SQLITE_BUSY',
      })),
    }

    await runSchedulerTick(db, [task], { observer: event => events.push(event) })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'sqlite_contention',
      reason: 'busy_task_failure',
    }))
    db.close()
  })
})
