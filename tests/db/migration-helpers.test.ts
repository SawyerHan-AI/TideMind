import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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
});
