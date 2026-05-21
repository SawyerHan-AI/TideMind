import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  addColumnIfMissing,
  execIgnoringDuplicateColumn,
  execIgnoringErrors,
  tableHasColumn,
} from '../../src/db/migration-helpers.js';

describe('migration helpers', () => {
  it('detects columns and adds missing columns idempotently', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE sample (id TEXT PRIMARY KEY)');

    expect(tableHasColumn(db, 'sample', 'id')).toBe(true);
    expect(tableHasColumn(db, 'sample', 'extra')).toBe(false);

    addColumnIfMissing(db, 'sample', 'extra', 'ALTER TABLE sample ADD COLUMN extra TEXT');
    addColumnIfMissing(db, 'sample', 'extra', 'ALTER TABLE sample ADD COLUMN extra TEXT');

    expect(tableHasColumn(db, 'sample', 'extra')).toBe(true);
  });

  it('ignores duplicate column errors and rethrows unrelated errors', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE sample (id TEXT PRIMARY KEY)');

    execIgnoringDuplicateColumn(db, 'ALTER TABLE sample ADD COLUMN extra TEXT');
    expect(() => execIgnoringDuplicateColumn(db, 'ALTER TABLE sample ADD COLUMN extra TEXT')).not.toThrow();
    expect(() => execIgnoringDuplicateColumn(db, 'ALTER TABLE missing ADD COLUMN extra TEXT')).toThrow();
  });

  it('supports migration-specific ignored error messages', () => {
    const db = new Database(':memory:');

    expect(() => {
      execIgnoringErrors(db, 'ALTER TABLE missing ADD COLUMN source_id TEXT', ['no such table']);
    }).not.toThrow();
  });

  it('quotes unusual table names when checking columns', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE "sample.with.dot" ("odd column" TEXT)');

    expect(tableHasColumn(db, 'sample.with.dot', 'odd column')).toBe(true);
    expect(tableHasColumn(db, 'sample.with.dot', 'missing')).toBe(false);
  });

  // MEDIUM 6 (audit-10, 2026-05-21): "already exists" 也应被吞(SQLite 不同
  // 版本 / 编译选项可能用这种文案)
  it('execIgnoringDuplicateColumn 容忍 "already exists" 文案', () => {
    const fakeDb = {
      exec: () => { throw new Error('column foo already exists'); },
    } as unknown as Database.Database;
    expect(() => execIgnoringDuplicateColumn(fakeDb, 'ALTER TABLE t ADD COLUMN foo TEXT')).not.toThrow();
  });

  it('execIgnoringDuplicateColumn 大小写无关("DUPLICATE COLUMN")', () => {
    const fakeDb = {
      exec: () => { throw new Error('DUPLICATE COLUMN name'); },
    } as unknown as Database.Database;
    expect(() => execIgnoringDuplicateColumn(fakeDb, 'ALTER TABLE t ADD COLUMN x')).not.toThrow();
  });
});

// MEDIUM 6 (audit-10, 2026-05-21): source-level grep 验证没有裸 try { ALTER } catch {}
// 残留。改用 execIgnoringDuplicateColumn / safeAlterAddColumn 保证 SQLITE_FULL /
// SQLITE_BUSY 不被吞。
describe('MEDIUM 6: no bare try { ALTER ... } catch {} pattern in source', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 检查目标文件:5 个 LOW-risk 之前裸 try/catch + db.ts 自身
  const filesToCheck = [
    'client/electron/cloud/outbox.ts',
    'src/integrations/logseq/sync-state.ts',
    'src/integrations/obsidian/sync-state.ts',
    'src/integrations/apple-notes/sync-state.ts',
  ];
  // 匹配 `try { db.exec(`...ALTER ...`) } catch { ... }` 反模式(catch block 是空或只有注释)
  // 注:正则只挡 ALTER 的;CREATE/INSERT 等其他 SQL 的 try/catch 不在审计范围。
  const badPattern = /try\s*\{\s*[\w$]+\.exec\s*\(\s*[`"']\s*ALTER\b[\s\S]{0,400}\}\s*catch\s*(\(\s*[\w$]*\s*(?::\s*\w+)?\s*\))?\s*\{\s*(\/\*[^*]*\*\/\s*|\/\/[^\n]*\n\s*)*\}/i;

  for (const rel of filesToCheck) {
    it(`${rel} 无裸 try { ALTER } catch {} 残留`, () => {
      const abs = path.resolve(here, '../..', rel);
      const src = readFileSync(abs, 'utf-8');
      const found = badPattern.test(src);
      expect(
        found,
        `${rel} 仍含裸 try { db.exec('ALTER ...') } catch {} 反模式,请改用 execIgnoringDuplicateColumn`,
      ).toBe(false);
    });
  }
});
