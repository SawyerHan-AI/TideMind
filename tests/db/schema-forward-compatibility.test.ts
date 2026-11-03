import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema.js';
import { migrateExistingDatabaseIfNeeded } from '../../src/db/pre-migration.js';

describe('forward-schema rejection before setup writes', () => {
  it.each(['DELETE', 'WAL'])('preserves committed bytes and configuration in %s', mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-forward-'));
    const filename = path.join(root, 'brain.sqlite');
    const config = path.join(root, 'config.toml');
    const owner = new Database(filename);
    try {
      owner.pragma(`journal_mode = ${mode}`);
      owner.pragma('wal_autocheckpoint = 0');
      owner.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      owner.prepare('INSERT INTO metadata VALUES (?, ?)').run('schema_version', String(CURRENT_SCHEMA_VERSION + 6));
      fs.writeFileSync(config, '[llm]\nstandard_model = "unchanged"\n');
      const tracked = [filename, config, `${filename}-wal`].filter(file => fs.existsSync(file));
      const before = tracked.map(file => fs.readFileSync(file));
      const names = fs.readdirSync(root).sort();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => migrateExistingDatabaseIfNeeded(filename, config)).toThrow(/高于/);
        expect(() => ensureSchema(owner)).toThrow(/高于/);
      }
      tracked.forEach((file, index) => expect(fs.readFileSync(file)).toEqual(before[index]));
      expect(fs.readdirSync(root).sort()).toEqual(names);
      expect(owner.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes'").get()).toBeUndefined();
      expect(owner.pragma('journal_mode', { simple: true })).toBe(mode.toLowerCase());
    } finally {
      owner.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['35junk', '', '-1', 'NaN', '9007199254740992'])('does not treat malformed version %j as a fresh database', version => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('schema_version', version);
      expect(() => ensureSchema(db)).toThrow(/版本无效/);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes'").get()).toBeUndefined();
    } finally { db.close(); }
  });
});


describe('startup helpers reject before repairing files', () => {
  it('protects Electron and daemon/Hook initialization plus route migration', async () => {
    const { loadConfig, resetConfigCache, ensureDataDirs, syncStrategiesFromSource } = await import('../../src/config.js');
    const { getClientDb, closeClientDb } = await import('../../client/electron/db');
    const { migrateConfigIfNeeded } = await import('../../src/utils/config-migrate.js');
    const { createLogger } = await import('../../src/utils/logger.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-forward-startup-'));
    const graph = path.join(root, 'graph');
    fs.mkdirSync(graph);
    const filename = path.join(graph, 'brain.sqlite');
    const config = path.join(root, 'config.toml');
    const db = new Database(filename);
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('schema_version', String(CURRENT_SCHEMA_VERSION + 6));
    db.close();
    fs.writeFileSync(config, `[general]\ndata_dir = ${JSON.stringify(root)}\n[llm]\nstandard_model = "claude-sonnet-4-0"\n`);
    const beforeDb = fs.readFileSync(filename);
    const beforeConfig = fs.readFileSync(config);
    const beforeNames = fs.readdirSync(root).sort();
    try {
      resetConfigCache();
      loadConfig(config);
      expect(() => ensureDataDirs()).toThrow(/高于/);
      expect(() => getClientDb(root)).toThrow(/高于/);
      expect(() => migrateConfigIfNeeded(createLogger('test'), config)).toThrow(/高于/);
      expect(fs.readdirSync(root).sort()).toEqual(beforeNames);
      expect(fs.readFileSync(filename)).toEqual(beforeDb);
      expect(fs.readFileSync(config)).toEqual(beforeConfig);
      // Periodic strategy synchronization must not overwrite existing user files.
      fs.mkdirSync(path.join(root, 'strategies'));
      fs.writeFileSync(path.join(root, 'strategies', 'custom.md'), 'user content');
      expect(() => syncStrategiesFromSource()).toThrow(/高于/);
      expect(fs.readFileSync(path.join(root, 'strategies', 'custom.md'), 'utf8')).toBe('user content');
    } finally {
      closeClientDb();
      resetConfigCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


it('does not relocate an old-brand directory containing a forward database', async () => {
  const { migrateDataDirIfNeeded } = await import('../../src/utils/migrate-data-dir.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-forward-relocation-'));
  const old = path.join(root, '.external-brain');
  fs.mkdirSync(path.join(old, 'graph'), { recursive: true });
  const file = path.join(old, 'graph', 'brain.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('schema_version', String(CURRENT_SCHEMA_VERSION + 6));
  db.close();
  try {
    const original = fs.readFileSync(file);
    expect(() => migrateDataDirIfNeeded(undefined, { homeDir: root })).toThrow(/高于/);
    expect(fs.readdirSync(root)).toEqual(['.external-brain']);
    expect(fs.readdirSync(old)).toEqual(['graph']);
    expect(fs.readFileSync(file)).toEqual(original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


it('checks the default data root even when config is stored elsewhere', async () => {
  const { migrateConfigIfNeeded } = await import('../../src/utils/config-migrate.js');
  const { createLogger } = await import('../../src/utils/logger.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-default-root-'));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  const graph = path.join(home, '.tidemind', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  const db = new Database(path.join(graph, 'brain.sqlite'));
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('schema_version', String(CURRENT_SCHEMA_VERSION + 6));
  db.close();
  const config = path.join(home, 'external.toml');
  const original = '[llm]\nstandard_model = "claude-sonnet-4-0"\n';
  fs.writeFileSync(config, original);
  try {
    expect(() => migrateConfigIfNeeded(createLogger('test'), config)).toThrow(/高于/);
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
    expect(fs.readdirSync(home).sort()).toEqual(['.tidemind', 'external.toml']);
  } finally { homeSpy.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('closes failed Electron setup and retries initialization instead of returning a cached connection', async () => {
  const { getClientDb, closeClientDb } = await import('../../client/electron/db');
  const outbox = await import('../../client/electron/cloud/outbox.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-client-init-failure-'));
  let failedConnection: Database.Database | undefined;
  const spy = vi.spyOn(outbox, 'createOutboxTable').mockImplementationOnce(connection => {
    failedConnection = connection;
    throw new Error('injected outbox failure');
  });
  try {
    closeClientDb();
    expect(() => getClientDb(root)).toThrow('injected outbox failure');
    expect(failedConnection?.open).toBe(false);
    const retried = getClientDb(root);
    expect(retried.open).toBe(true);
    expect(retried).not.toBe(failedConnection);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { closeClientDb(); spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});
