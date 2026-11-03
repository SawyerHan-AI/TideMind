import Database from 'better-sqlite3';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// Structure-only observation; all application data in this test is synthetic.
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/db/v41-observed-structure.json', import.meta.url), 'utf8')) as {
  schemaVersion: string;
  objects: Array<{ type: string; name: string; table: string; sql: string }>;
};

describe('observed schema41 compatibility spike (not a production migration)', () => {
  it('preserves core rows while adding the four missing auth-binding columns', () => {
    const db = new Database(':memory:');
    try {
      // Vector and FTS virtual tables are not necessary for this column/trigger
      // spike; packaged extension compatibility remains a separate requirement.
      const excluded = (name: string) => name.startsWith('nodes_vec') || name.startsWith('nodes_fts') || name.startsWith('sqlite_');
      for (const object of fixture.objects.filter(o => o.type === 'table' && !excluded(o.name))) db.exec(object.sql);
      for (const object of fixture.objects.filter(o => o.type === 'index' && !excluded(o.table))) db.exec(object.sql);
      for (const object of fixture.objects.filter(o => o.type === 'trigger' && !o.sql.includes('nodes_fts') && !excluded(o.table))) db.exec(object.sql);
      db.exec("INSERT INTO sync_apply_guard(k, applying) VALUES (0, 0)");
      db.exec("INSERT INTO nodes(id,type,content,created) VALUES ('synthetic-node','fact','synthetic migration sample','2026-01-01T00:00:00Z')");
      db.exec("INSERT INTO metadata(key,value) VALUES ('schema_version','41')");
      const before = db.prepare('SELECT * FROM nodes').all();
      const backgroundTables = fixture.objects.filter(o => o.type === 'table' && ['mutation_journal','workflow_runs','recovery_barriers','initialization_overlays'].includes(o.name));
      const backgroundBefore = backgroundTables.map(o => db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(o.name));
      for (const [name, type] of [['last_known_scope_key','TEXT'], ['last_known_epoch','INTEGER'], ['last_known_cli_generation','TEXT'], ['last_known_auth_method','TEXT']]) {
        db.exec(`ALTER TABLE llm_connection_auth_bindings ADD COLUMN ${name} ${type}`);
      }
      expect(db.prepare('SELECT * FROM nodes').all()).toEqual(before);
      expect(backgroundTables.map(o => db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(o.name))).toEqual(backgroundBefore);
      db.prepare('UPDATE nodes SET content = ? WHERE id = ?').run('updated synthetic content', 'synthetic-node');
      expect(db.prepare('SELECT content FROM nodes').get()).toEqual({ content: 'updated synthetic content' });
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
      // The spike deliberately does not relabel the DB or allow production open.
      expect(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: '41' });
    } finally { db.close(); }
  });
});
