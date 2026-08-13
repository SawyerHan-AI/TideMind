import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEDULER_RUN_LOCK_SUFFIX = '.scheduler-owner.sqlite';

export interface SchedulerRunLock {
  readonly lockPath: string | null;
  release(): void;
}

export type SchedulerRunLockResult =
  | { acquired: true; lock: SchedulerRunLock }
  | { acquired: false; reason: 'owner_busy' };

const inMemoryOwners = new WeakSet<Database.Database>();

function isBusyOrLocked(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function canonicalDatabasePath(dbName: string): string {
  const absolutePath = path.resolve(dbName);
  const canonical = realpathSync.native(absolutePath);
  // A hard-linked SQLite database would receive a different -wal and owner
  // sidecar for each pathname. Refuse that unsupported identity instead of
  // pretending cross-entry exclusion still holds.
  if (statSync(canonical).nlink !== 1) throw new Error('scheduler database hard links are unsupported');
  return canonical;
}

export function getSchedulerRunLockPath(db: Database.Database): string | null {
  if (db.name === '' || db.name === ':memory:') return null;
  return `${canonicalDatabasePath(db.name)}${SCHEDULER_RUN_LOCK_SUFFIX}`;
}

function acquireInMemoryRunLock(db: Database.Database): SchedulerRunLockResult {
  if (inMemoryOwners.has(db)) return { acquired: false, reason: 'owner_busy' };

  inMemoryOwners.add(db);
  let released = false;
  return {
    acquired: true,
    lock: {
      lockPath: null,
      release: () => {
        if (released) return;
        released = true;
        inMemoryOwners.delete(db);
      },
    },
  };
}

/**
 * Acquires the scheduler-wide run lock for one complete pass.
 *
 * File databases use a distinct SQLite sidecar so the lock never occupies the business
 * database's writer slot. The open transaction contains no business data and is released by
 * SQLite/OS process teardown if the owner crashes. In-memory databases use a connection-local
 * WeakSet solely for unit tests; they do not claim cross-process exclusion.
 */
export function tryAcquireSchedulerRunLock(db: Database.Database): SchedulerRunLockResult {
  const lockPath = getSchedulerRunLockPath(db);
  if (lockPath === null) return acquireInMemoryRunLock(db);

  let lockDb: Database.Database | null = null;
  try {
    lockDb = new Database(lockPath, { timeout: 0 });
    lockDb.pragma('busy_timeout = 0');
    lockDb.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try {
      lockDb?.close();
    } catch {
      // Preserve the acquisition result/error. A connection that failed before ownership does
      // not carry scheduler authority.
    }
    if (isBusyOrLocked(error)) return { acquired: false, reason: 'owner_busy' };
    throw error;
  }

  let released = false;
  return {
    acquired: true,
    lock: {
      lockPath,
      release: () => {
        if (released) return;
        released = true;
        try {
          if (lockDb?.inTransaction) lockDb.exec('ROLLBACK');
        } finally {
          lockDb?.close();
          lockDb = null;
        }
      },
    },
  };
}
