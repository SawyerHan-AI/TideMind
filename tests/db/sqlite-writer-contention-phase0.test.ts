/**
 * Phase 0 SQLite writer contention 基线。
 *
 * WAL 允许reader与writer并行，但不允许两个writer同时写。better-sqlite3的
 * busy_timeout等待是同步的；若第二个writer位于Electron main，会在等待期间阻塞
 * main事件循环。测试使用75ms而非生产10s，锁定机制而不拖慢测试套件。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite writer contention Phase 0 baseline', () => {
  it('第二个同步writer在busy timeout期间阻塞其调用线程', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'eb-scheduler-contention-'));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, 'brain.sqlite');
    const writerA = new Database(dbPath);
    const writerB = new Database(dbPath);

    try {
      writerA.pragma('journal_mode = WAL');
      writerB.pragma('journal_mode = WAL');
      writerA.pragma('busy_timeout = 75');
      writerB.pragma('busy_timeout = 75');
      writerA.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

      writerA.exec('BEGIN IMMEDIATE');
      writerA.prepare('INSERT INTO events (value) VALUES (?)').run('writer-a');

      let eventLoopAdvanced = false;
      const turn = new Promise<void>((resolve) => {
        setImmediate(() => {
          eventLoopAdvanced = true;
          resolve();
        });
      });

      const startedAt = performance.now();
      expect(() => {
        writerB.prepare('INSERT INTO events (value) VALUES (?)').run('writer-b');
      }).toThrow(/locked|busy/i);
      const blockedForMs = performance.now() - startedAt;

      expect(blockedForMs).toBeGreaterThanOrEqual(60);
      expect(eventLoopAdvanced).toBe(false);
      await turn;
      expect(eventLoopAdvanced).toBe(true);
    } finally {
      if (writerA.inTransaction) writerA.exec('ROLLBACK');
      writerA.close();
      writerB.close();
    }
  });
});
