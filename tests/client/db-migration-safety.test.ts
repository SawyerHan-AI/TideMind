/**
 * safeAlterAddColumn 行为测试(HIGH bug 修复)。
 *
 * 背景:
 *   db.ts 老代码 14 处 `try { db.exec('ALTER ...') } catch {}` 把以下两类
 *   错误一起吞:
 *     - "duplicate column"(列已存在 = 合法的幂等迁移)→ **应该**吞
 *     - SQLITE_BUSY / SQLITE_FULL / SQLITE_CORRUPT(真错)→ **不应**吞
 *
 *   后果:磁盘满 / 数据库损坏让启动表面成功,但 schema 实际不是预期的,
 *   后续业务读到 0 行或随机崩,排查极难。
 *
 * 修复:safeAlterAddColumn 只吞含 "duplicate column" / "already exists" 文案
 * 的 message,其他直接 throw。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// db.ts module-level 拖了 electron / migrate-data-dir / sync-skill-files,
// 这些在测试里不需要执行。pure stub。
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => '/tmp' },
}));
vi.mock('@server/utils/migrate-data-dir.js', () => ({
  migrateDataDirIfNeeded: vi.fn(),
}));
vi.mock('@server/utils/sync-skill-files.js', () => ({
  syncSkillFiles: vi.fn(() => ({ refreshed: [], userModified: [] })),
  createSyncHashStoreFromDb: vi.fn(() => ({})),
}));
vi.mock('@server/utils/logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../client/electron/cloud/outbox.js', () => ({
  createOutboxTable: vi.fn(),
}));

import { safeAlterAddColumn } from '../../client/electron/db.js';

describe('safeAlterAddColumn — 区分"列已存在"和真错', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
  });

  it('列不存在 → 正常 ALTER 加列', () => {
    expect(() => safeAlterAddColumn(db, 'ALTER TABLE t ADD COLUMN b TEXT')).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(t)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual(['a', 'b', 'id']);
  });

  it('列已存在 → 静默成功(幂等迁移合法场景)', () => {
    db.exec('ALTER TABLE t ADD COLUMN c TEXT');
    expect(() => safeAlterAddColumn(db, 'ALTER TABLE t ADD COLUMN c TEXT')).not.toThrow();
    // 列还在,没被重复添加
    const cols = db.prepare('PRAGMA table_info(t)').all() as Array<{ name: string }>;
    expect(cols.filter(c => c.name === 'c')).toHaveLength(1);
  });

  it('SQL 真错(语法错误) → 抛出,不吞', () => {
    // 故意写一个 SQLite 一定 reject 的语法 — 把 ADD COLUMN 拼成完全无效的 token
    expect(() => safeAlterAddColumn(db, 'NOT_A_VALID_STATEMENT garbage')).toThrow();
  });

  it('表不存在 → 抛出,不吞("no such table" 不是"列已存在")', () => {
    expect(() => safeAlterAddColumn(db, 'ALTER TABLE nonexistent_table ADD COLUMN x TEXT')).toThrow(/no such table/i);
  });

  it('模拟 SQLITE_FULL("disk full") → 抛出,不吞', () => {
    // 用 spy 模拟磁盘满。better-sqlite3 抛的 message 通常是
    // "database or disk is full"(SQLITE_FULL)。
    const fakeDb = {
      exec: (_sql: string) => {
        throw new Error('database or disk is full');
      },
    } as unknown as Database.Database;
    expect(() => safeAlterAddColumn(fakeDb, 'ALTER TABLE t ADD COLUMN z TEXT')).toThrow(/disk is full/i);
  });

  it('模拟 SQLITE_BUSY → 抛出,不吞', () => {
    const fakeDb = {
      exec: (_sql: string) => {
        throw new Error('database is locked');
      },
    } as unknown as Database.Database;
    expect(() => safeAlterAddColumn(fakeDb, 'ALTER TABLE t ADD COLUMN z TEXT')).toThrow(/locked/i);
  });

  it('大小写无关匹配 "Duplicate column" / "ALREADY EXISTS"', () => {
    const fakeDb = {
      exec: (_sql: string) => {
        throw new Error('Duplicate column name: foo');
      },
    } as unknown as Database.Database;
    expect(() => safeAlterAddColumn(fakeDb, 'ALTER TABLE t ADD COLUMN foo TEXT')).not.toThrow();

    const fakeDb2 = {
      exec: (_sql: string) => {
        throw new Error('column foo ALREADY EXISTS');
      },
    } as unknown as Database.Database;
    expect(() => safeAlterAddColumn(fakeDb2, 'ALTER TABLE t ADD COLUMN foo TEXT')).not.toThrow();
  });
});
