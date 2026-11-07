import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateExistingDatabaseIfNeeded } from '../../src/db/pre-migration.js';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema.js';
import { describe, expect, it, vi } from 'vitest';
import { assertRecoverableSchema41, addRecoveryAuthColumns } from '../../src/db/schema41-recovery.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/db/v41-observed-structure.json', import.meta.url), 'utf8')) as { objects: Array<{ type: string; name: string; table: string; sql: string }> };
function source(withVectors = false): Database.Database {
  const db = new Database(':memory:');
  if (withVectors) db.loadExtension(getLoadablePath());
  // SQLite creates FTS/vec shadow tables; never manufacture those tables.
  for (const type of ['table', 'index', 'trigger', 'view']) {
    for (const o of fixture.objects.filter(o => o.type === type && !o.name.startsWith('sqlite_') && (!o.name.startsWith('nodes_vec') || (withVectors && o.name === 'nodes_vec')))) {
      if (o.name.startsWith('nodes_fts_')) continue; // FTS creates its own shadow tables.
      db.exec(o.sql);
    }
  }
  db.exec(`INSERT INTO metadata VALUES ('schema_version','41');
    INSERT INTO background_schema_capabilities(singleton_id,protocol_version,created_at,updated_at) VALUES (1,1,'synthetic','synthetic');
    INSERT INTO mutation_lane(singleton_id,updated_at) VALUES (1,'synthetic');
    INSERT INTO runtime_leader(singleton_id,protocol_version) VALUES (1,1);
    INSERT INTO sync_apply_guard(k,applying) VALUES (0,0);`);
  return db;
}

describe('schema41 dormant lineage admission', () => {
  it('accepts the known dormant structure and retains FTS and core rows through additive conversion', () => {
    const db=source();
    try {
      db.exec("INSERT INTO nodes(id,type,content,created) VALUES ('synthetic','fact','unique synthetic memory','2026-01-01')");
      expect(() => assertRecoverableSchema41(db)).not.toThrow();
      const before=db.prepare('SELECT * FROM nodes').all();
      db.transaction(() => addRecoveryAuthColumns(db))();
      expect(db.prepare('SELECT * FROM nodes').all()).toEqual(before);
      expect(db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH 'unique'").get()).toEqual({ n:1 });
      expect(db.pragma('quick_check',{simple:true})).toBe('ok');
    } finally {db.close();}
  });
  it.each([
    "UPDATE background_schema_capabilities SET scheduler_worker_enabled=1",
    "UPDATE mutation_lane SET current_owner_instance='synthetic-owner'",
    "UPDATE runtime_leader SET protocol_version=2",
    "CREATE TRIGGER nodes_fts_hidden_guard AFTER INSERT ON nodes BEGIN SELECT 1; END",
    "ALTER TABLE nodes ADD COLUMN unknown_branch TEXT",
    "INSERT INTO graph_projection_head(scope,updated_at) VALUES ('synthetic','synthetic')",
    "INSERT INTO maintenance_intents(intent_id,source_runtime,kind,payload_version,priority_class,admitted_at,eligible_at) VALUES ('synthetic','test','test',1,'scheduler',1,1)",
  ])('rejects before writes: %s', sql => {
    const db=source();
    try {
      db.exec(sql);
      const before=db.serialize();
      expect(() => assertRecoverableSchema41(db)).toThrow(/自动恢复已停止/);
      expect(db.serialize()).toEqual(before);
    } finally {db.close();}
  }, 30_000);
  it('rolls back additive DDL when later conversion fails', () => {
    const db=source();
    try {
      expect(() => db.transaction(() => { addRecoveryAuthColumns(db); throw new Error('injected failure'); })()).toThrow('injected failure');
      expect(() => assertRecoverableSchema41(db)).not.toThrow();
    } finally {db.close();}
  });
});


it('backs up a physical schema41, migrates atomically and opens it again without a second backup', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tidemind-recover41-'));
  const file=path.join(root,'brain.sqlite');
  const config=path.join(root,'config.toml');
  const original=source();
  try {
    original.exec("INSERT INTO nodes(id,type,content,created) VALUES ('retained','fact','persistent synthetic memory','2026-01-01')");
    await original.backup(file); original.close();
    fs.writeFileSync(config,'[llm]\nstandard_model="default"\n');
    migrateExistingDatabaseIfNeeded(file,config);
    const result=new Database(file);
    try {
      expect(result.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({value:String(CURRENT_SCHEMA_VERSION)});
      expect(result.prepare("SELECT value FROM metadata WHERE key='schema_lineage'").get()).toEqual({value:'stable-0.2.94'});
      expect(() => ensureSchema(result)).not.toThrow();
      expect(result.prepare("SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH 'persistent'").get()).toEqual({n:1});
      expect(result.prepare('SELECT count(*) AS n FROM workflow_runs').get()).toEqual({n:0});
      expect(result.pragma('foreign_key_check')).toEqual([]);
    } finally {result.close();}
    const backups=fs.readdirSync(root).filter(f=>f.startsWith('brain.backup-'));
    expect(backups).toHaveLength(1);
    const backup=new Database(path.join(root,backups[0]),{readonly:true});
    try {expect(() => assertRecoverableSchema41(backup)).not.toThrow();} finally {backup.close();}
    migrateExistingDatabaseIfNeeded(file,config);
    expect(fs.readdirSync(root).filter(f=>f.startsWith('brain.backup-'))).toEqual(backups);
  } finally {if(original.open)original.close();fs.rmSync(root,{recursive:true,force:true});}
});

it.each([36,40,42,44])('rejects unknown migration branch %s without reclassifying it as an ordinary old database', version => {
  const db=new Database(':memory:');
  try {
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('schema_version',String(version));
    expect(() => ensureSchema(db)).toThrow(/独立开发迁移线/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='nodes'").get()).toBeUndefined();
  } finally {db.close();}
});


it('restores schema41 after a failure inside the backed-up conversion transaction', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tidemind-recovery-failure-'));
  const file=path.join(root,'brain.sqlite');
  const initial=source();
  await initial.backup(file);initial.close();
  const originalExec=Database.prototype.exec;
  const spy=vi.spyOn(Database.prototype,'exec').mockImplementation(function(this: Database.Database, sql: string) {
    if(sql.includes('-- 节点表')) throw new Error('injected core setup failure');
    return originalExec.call(this,sql);
  });
  try {
    expect(()=>migrateExistingDatabaseIfNeeded(file)).toThrow('injected core setup failure');
    spy.mockRestore();
    const restored=new Database(file);
    try {expect(()=>assertRecoverableSchema41(restored)).not.toThrow();} finally {restored.close();}
    expect(fs.readdirSync(root).filter(f=>f.startsWith('brain.backup-'))).toHaveLength(1);
    migrateExistingDatabaseIfNeeded(file);
    const recovered=new Database(file);
    try {expect(recovered.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({value:String(CURRENT_SCHEMA_VERSION)});}finally{recovered.close();}
  } finally {spy.mockRestore();fs.rmSync(root,{recursive:true,force:true});}
});


it('preserves real sqlite-vec content and search through physical schema41 backup and recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-recover41-vector-'));
  const file = path.join(root, 'brain.sqlite');
  const original = source(true);
  const vector = Buffer.from(new Float32Array(3072).fill(0.25).buffer);
  try {
    original.exec("INSERT INTO nodes(id,type,content,created) VALUES ('vector-retained','fact','synthetic vector memory','2026-01-01')");
    original.prepare('INSERT INTO nodes_vec(id,embedding) VALUES (?,?)').run('vector-retained', vector);
    expect(() => assertRecoverableSchema41(original)).not.toThrow();
    await original.backup(file); original.close();
    migrateExistingDatabaseIfNeeded(file);
    for (const target of [file, path.join(root, fs.readdirSync(root).find(name => name.startsWith('brain.backup-'))!)]) {
      const reopened = new Database(target, {readonly:true});
      try {
        reopened.loadExtension(getLoadablePath());
        expect(reopened.prepare("SELECT value FROM metadata WHERE key='schema_version'").get())
          .toEqual({value:target === file ? String(CURRENT_SCHEMA_VERSION) : '41'});
        expect(reopened.prepare('SELECT id, embedding FROM nodes_vec').get()).toEqual({id:'vector-retained',embedding:vector});
        expect(reopened.prepare('SELECT id,distance FROM nodes_vec WHERE embedding MATCH ? AND k=1').get(vector))
          .toEqual({id:'vector-retained',distance:0});
        expect(reopened.pragma('quick_check', {simple:true})).toBe('ok');
      } finally { reopened.close(); }
    }
  } finally { if(original.open)original.close();fs.rmSync(root,{recursive:true,force:true}); }
});
