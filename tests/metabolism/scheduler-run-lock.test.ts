import { linkSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSchedulerRunLockPath,
  tryAcquireSchedulerRunLock,
} from '../../src/metabolism/scheduler-run-lock.js';

const openDbs: Database.Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('scheduler run lock', () => {
  it('同一内存连接不可重入，release幂等且允许下一轮', () => {
    const db = new Database(':memory:');
    openDbs.push(db);

    const first = tryAcquireSchedulerRunLock(db);
    expect(first.acquired).toBe(true);
    expect(tryAcquireSchedulerRunLock(db)).toEqual({
      acquired: false,
      reason: 'owner_busy',
    });

    if (!first.acquired) throw new Error('expected first lock');
    first.lock.release();
    first.lock.release();

    const next = tryAcquireSchedulerRunLock(db);
    expect(next.acquired).toBe(true);
    if (next.acquired) next.lock.release();
  });

  it('两个文件连接共享canonical sidecar，只有一个owner且release后可恢复', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'eb-scheduler-owner-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'brain.sqlite');
    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    openDbs.push(dbA, dbB);

    const expectedLockPath = `${realpathSync(dbPath)}.scheduler-owner.sqlite`;
    expect(getSchedulerRunLockPath(dbA)).toBe(expectedLockPath);
    expect(getSchedulerRunLockPath(dbB)).toBe(expectedLockPath);

    const first = tryAcquireSchedulerRunLock(dbA);
    expect(first.acquired).toBe(true);
    expect(tryAcquireSchedulerRunLock(dbB)).toEqual({
      acquired: false,
      reason: 'owner_busy',
    });

    if (!first.acquired) throw new Error('expected file lock');
    first.lock.release();

    const recovered = tryAcquireSchedulerRunLock(dbB);
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) recovered.lock.release();
  });

  it('持有sidecar owner时不占用业务数据库writer lock', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'eb-scheduler-owner-db-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'brain.sqlite');
    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    openDbs.push(dbA, dbB);
    dbA.exec('CREATE TABLE business_write(value TEXT NOT NULL)');

    const owner = tryAcquireSchedulerRunLock(dbA);
    expect(owner.acquired).toBe(true);

    dbB.prepare('INSERT INTO business_write(value) VALUES (?)').run('foreground-write');
    expect(dbA.prepare('SELECT value FROM business_write').pluck().get()).toBe(
      'foreground-write',
    );

    if (owner.acquired) owner.lock.release();
  });

  it('拒绝hard-linked SQLite身份而不是为同一inode创建两个owner sidecar', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'eb-scheduler-owner-hardlink-'));
    tempDirs.push(tempDir);
    const original = path.join(tempDir, 'brain.sqlite');
    const alias = path.join(tempDir, 'alias.sqlite');
    const originalDb = new Database(original);
    originalDb.close();
    linkSync(original, alias);
    const aliasDb = new Database(alias);
    openDbs.push(aliasDb);
    expect(() => getSchedulerRunLockPath(aliasDb)).toThrow(/hard links are unsupported/);
  });

  it('owner进程被强制终止后操作系统释放sidecar锁', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'eb-scheduler-owner-crash-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'brain.sqlite');
    const db = new Database(dbPath);
    openDbs.push(db);
    const lockPath = getSchedulerRunLockPath(db);
    if (lockPath === null) throw new Error('expected file lock path');

    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import Database from 'better-sqlite3';",
          'const db = new Database(process.env.EB_SCHEDULER_LOCK_PATH, { timeout: 0 });',
          "db.pragma('busy_timeout = 0');",
          "db.exec('BEGIN IMMEDIATE');",
          "process.stdout.write('OWNER_READY\\n');",
          'setInterval(() => {}, 1_000);',
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, EB_SCHEDULER_LOCK_PATH: lockPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child owner did not become ready')), 5_000);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        reject(new Error(`child owner exited before ready: ${code ?? signal}`));
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!chunk.toString().includes('OWNER_READY')) return;
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(tryAcquireSchedulerRunLock(db)).toEqual({
      acquired: false,
      reason: 'owner_busy',
    });

    const childExited = once(child, 'exit');
    child.kill('SIGKILL');
    await childExited;

    const recovered = tryAcquireSchedulerRunLock(db);
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) recovered.lock.release();
  }, 10_000);
});
