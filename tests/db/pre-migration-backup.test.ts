import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { ensureSchema } from '../../src/db/schema.js';
import { migrateExistingDatabaseIfNeeded } from '../../src/db/pre-migration.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDbIfNeeded, getDb, closeDb } from '../../src/db/connection.js';

const testConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/config.js')>(),
  getDataDir: () => testConfig.dataDir,
}));

describe('pre-migration backup (formal rollback point)', () => {
  let root: string;
  let graphDir: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-backup-'));
    testConfig.dataDir = root;
    graphDir = path.join(root, 'graph');
    fs.mkdirSync(graphDir);
    dbPath = path.join(graphDir, 'brain.sqlite');
  });
  afterEach(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

  it('captures committed WAL data held open by another connection, and pairs config.toml', () => {
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('星海科技-1');");
    // A reader keeps an open snapshot so a checkpoint cannot fully truncate the WAL.
    const reader = new Database(dbPath, { readonly: true });
    reader.prepare('BEGIN').run();
    reader.prepare('SELECT COUNT(*) FROM t').get();
    writer.exec("INSERT INTO t VALUES ('星海科技-2');");
    fs.writeFileSync(path.join(root, 'config.toml'), '[llm]\nstandard_model = "default"\n');

    backupDbIfNeeded(dbPath);

    reader.prepare('COMMIT').run();
    reader.close();
    writer.close();
    const files = fs.readdirSync(graphDir);
    const dbBackup = files.find((name) => name.startsWith('brain.backup-') && name.endsWith('.sqlite'));
    const configBackup = files.find((name) => name.startsWith('config.backup-') && name.endsWith('.toml'));
    expect(dbBackup).toBeDefined();
    expect(configBackup?.slice('config.backup-'.length, -'.toml'.length))
      .toBe(dbBackup?.slice('brain.backup-'.length, -'.sqlite'.length));
    const snapshot = new Database(path.join(graphDir, dbBackup!), { readonly: true });
    expect(snapshot.prepare('SELECT v FROM t ORDER BY v').all()).toEqual([{ v: '星海科技-1' }, { v: '星海科技-2' }]);
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
    snapshot.close();
    expect(fs.readFileSync(path.join(graphDir, configBackup!), 'utf8')).toContain('standard_model');
    expect(fs.statSync(path.join(graphDir, configBackup!)).mode & 0o777).toBe(0o600);
  }, 30_000);

  it('fails closed when the route configuration cannot be paired with the DB snapshot', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
    // A directory at config.toml deterministically makes COPYFILE fail, including
    // when the test runs with elevated filesystem privileges.
    fs.mkdirSync(path.join(root, 'config.toml'));
    expect(() => backupDbIfNeeded(dbPath)).toThrow('迁移前备份失败');
    expect(fs.readdirSync(graphDir).filter(name => name.includes('.backup-'))).toEqual([]);
  });

  it.each(['WAL', 'DELETE'])('keeps schema/data and restores %s journal mode when backup fails', (journalMode) => {
    const db = new Database(dbPath);
    db.pragma(`journal_mode = ${journalMode}`);
    db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('schema_version', '34'), ('business-data', 'preserved')");
    db.close();
    fs.mkdirSync(path.join(root, 'config.toml'));
    expect(() => getDb()).toThrow('迁移前备份失败');
    const unchanged = new Database(dbPath, { readonly: true });
    expect(unchanged.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '34' });
    expect(unchanged.prepare("SELECT value FROM metadata WHERE key = 'business-data'").get()).toEqual({ value: 'preserved' });
    expect(unchanged.pragma('journal_mode', { simple: true })).toBe(journalMode.toLowerCase());
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'llm_model_catalog_snapshots'").get()).toBeUndefined();
    unchanged.close();
  });

  it('restores WAL and preserves logical state after snapshot succeeds but config copy fails', () => {
    const db = new Database(dbPath);
    ensureSchema(db);
    db.exec("UPDATE metadata SET value = '34' WHERE key = 'schema_version'; INSERT INTO metadata VALUES ('business-data', 'preserved')");
    db.close();
    fs.writeFileSync(path.join(root, 'config.toml'), '[llm]\nstandard_model = "saved"\n');
    let hadSnapshot = false;
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      hadSnapshot = fs.readdirSync(graphDir).some(name => name.startsWith('brain.backup-'));
      throw Object.assign(new Error('fixture full disk'), { code: 'ENOSPC' });
    });
    try { expect(() => migrateExistingDatabaseIfNeeded(dbPath)).toThrow('迁移前备份失败'); } finally { copySpy.mockRestore(); }
    expect(hadSnapshot).toBe(true);
    const unchanged = new Database(dbPath);
    expect(unchanged.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(unchanged.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '34' });
    expect(unchanged.prepare("SELECT value FROM metadata WHERE key = 'business-data'").get()).toEqual({ value: 'preserved' });
    unchanged.close();
    expect(fs.readdirSync(graphDir).filter(name => name.includes('.backup-'))).toEqual([]);
  });

  it('takes distinct recovery points for consecutive attempts in the same second', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
    fs.writeFileSync(path.join(root, 'config.toml'), '');
    backupDbIfNeeded(dbPath);
    backupDbIfNeeded(dbPath);
    expect(fs.readdirSync(graphDir).filter(name => name.startsWith('brain.backup-'))).toHaveLength(2);
    expect(fs.readdirSync(graphDir).filter(name => name.startsWith('config.backup-'))).toHaveLength(2);
  });

  it('migrates v34 with a pre-repair recovery point while excluding concurrent writers', () => {
    const original = new Database(dbPath);
    ensureSchema(original);
    original.exec("UPDATE metadata SET value = '34' WHERE key = 'schema_version'; DROP TABLE llm_model_catalog_snapshots;");
    original.close();
    fs.writeFileSync(path.join(root, 'config.toml'), '[llm]\nstandard_model = "saved"\n');
    const copy = fs.copyFileSync;
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
      const concurrent = new Database(dbPath);
      concurrent.pragma('busy_timeout = 0');
      try {
        expect(() => concurrent.exec("INSERT INTO metadata VALUES ('other-writer', 'bad')")).toThrow(/locked/);
      } finally { concurrent.close(); }
      return copy(...args);
    });
    try { migrateExistingDatabaseIfNeeded(dbPath); } finally { copySpy.mockRestore(); }
    const upgraded = new Database(dbPath, { readonly: true });
    expect(upgraded.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '35' });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'llm_model_catalog_snapshots'").get()).toBeDefined();
    upgraded.close();
    const backup = fs.readdirSync(graphDir).find(name => name.startsWith('brain.backup-'))!;
    const recovery = new Database(path.join(graphDir, backup), { readonly: true });
    expect(recovery.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '34' });
    expect(recovery.prepare("SELECT name FROM sqlite_master WHERE name = 'llm_model_catalog_snapshots'").get()).toBeUndefined();
    recovery.close();
  });

  it.each(['idle', 'reading', 'writing'])('refuses migration while a separate SQLite process is %s', async (mode) => {
    const original = new Database(dbPath);
    ensureSchema(original);
    original.exec("UPDATE metadata SET value = '34' WHERE key = 'schema_version'");
    original.close();
    const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const child = spawn(process.execPath, ['-e', `
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2]);
      if (process.argv[3] === 'reading') db.exec('BEGIN');
      if (process.argv[3] === 'writing') db.exec("BEGIN IMMEDIATE; INSERT INTO metadata VALUES ('pending-writer', 'pending')");
      db.prepare('SELECT * FROM metadata').all();
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `, sqlitePath, dbPath, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout!, 'data');
      expect(() => migrateExistingDatabaseIfNeeded(dbPath)).toThrow('数据库仍被其他连接使用');
      expect(fs.readdirSync(graphDir).filter(name => name.includes('.backup-'))).toEqual([]);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }, 15_000);

  it('blocks a new SQLite process during the same-connection backup and after returning to WAL', () => {
    const original = new Database(dbPath);
    ensureSchema(original);
    original.exec("UPDATE metadata SET value = '34' WHERE key = 'schema_version'");
    original.close();
    fs.writeFileSync(path.join(root, 'config.toml'), '[llm]\nstandard_model = "saved"\n');
    const attempts: string[] = [];
    const probe = (phase: string) => {
      const output = execFileSync(process.execPath, ['-e', `
        const Database = require(process.argv[1]);
        try {
          const db = new Database(process.argv[2]);
          db.pragma('busy_timeout = 0');
          db.prepare('SELECT * FROM metadata').all();
          db.close();
          process.stdout.write('accessed');
        } catch (error) { process.stdout.write(error.code || error.message); }
      `, createRequire(import.meta.url).resolve('better-sqlite3'), dbPath], { encoding: 'utf8' });
      expect(output, phase).toBe('SQLITE_BUSY');
      attempts.push(phase);
    };
    const originalCopy = fs.copyFileSync;
    const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
      // VACUUM INTO completed, but its connection must still retain EXCLUSIVE.
      probe('after-vacuum');
      return originalCopy(...args);
    });
    const originalExec = Database.prototype.exec;
    const execSpy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      const result = originalExec.call(this, sql);
      if (sql === 'PRAGMA journal_mode = WAL;') probe('schema-wal');
      return result;
    });
    try { migrateExistingDatabaseIfNeeded(dbPath); } finally { copySpy.mockRestore(); execSpy.mockRestore(); }
    expect(attempts).toEqual(['after-vacuum', 'schema-wal']);
    const reopened = new Database(dbPath);
    expect(reopened.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(reopened.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '35' });
    reopened.close();
  });

  it('preserves the v6 nontransactional foreign-key transition under the exclusive connection lock', () => {
    const original = new Database(dbPath);
    ensureSchema(original);
    original.exec(`
      INSERT INTO nodes (id, type, content, created) VALUES ('legacy-a', 'fact', 'a', '2026-09-29'), ('legacy-b', 'fact', 'b', '2026-09-29');
      INSERT INTO links (id, from_id, to_id, relation, created) VALUES ('legacy-link', 'legacy-a', 'legacy-b', '[]', '2026-09-29');
      UPDATE metadata SET value = '5' WHERE key = 'schema_version';
    `);
    original.close();
    const originalPragma = Database.prototype.pragma;
    let checkedV6 = false;
    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: { simple?: boolean }) {
      const result = originalPragma.call(this, source, options);
      if (source === 'foreign_keys = OFF') {
        expect(this.inTransaction).toBe(false);
        expect(originalPragma.call(this, 'locking_mode', { simple: true })).toBe('exclusive');
        expect(originalPragma.call(this, 'foreign_keys', { simple: true })).toBe(0);
        checkedV6 = true;
      }
      return result;
    });
    // Legacy migrations inspect optional config paths; keep those reads/writes
    // inside this fixture, never the user's real HOME.
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(root);
    try { migrateExistingDatabaseIfNeeded(dbPath); } finally { pragmaSpy.mockRestore(); homeSpy.mockRestore(); }
    expect(checkedV6).toBe(true);
    const upgraded = new Database(dbPath);
    expect(upgraded.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: '35' });
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(upgraded.prepare("SELECT from_id, to_id FROM links WHERE id = 'legacy-link'").get()).toEqual({ from_id: 'legacy-a', to_id: 'legacy-b' });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
  });

  it('keeps only the three most recent backup pairs', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
    for (const stamp of ['2026-01-01T00-00-00', '2026-01-02T00-00-00', '2026-01-03T00-00-00']) {
      fs.writeFileSync(path.join(graphDir, `brain.backup-${stamp}.sqlite`), '');
      fs.writeFileSync(path.join(graphDir, `config.backup-${stamp}.toml`), '');
    }
    fs.writeFileSync(path.join(root, 'config.toml'), '');
    backupDbIfNeeded(dbPath);
    const files = fs.readdirSync(graphDir);
    expect(files.filter((name) => name.startsWith('brain.backup-'))).toHaveLength(3);
    expect(files.filter((name) => name.startsWith('config.backup-'))).toHaveLength(3);
    expect(files).not.toContain('brain.backup-2026-01-01T00-00-00.sqlite');
  }, 30_000);
});
