import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CONTEXT_RESTORE_PREFIX, CONTEXT_RESTORE_MAX_BYTES, CONTEXT_RESTORE_CLAIM_MS,
  CONTEXT_RESTORE_RECORD_MS, CONTEXT_RESTORE_CLEANUP_LIMIT,
  contextRestoreKey, createContextRestoreStore,
  type ContextRestoreScope,
} from '../src/hook-codex-context-restore.js';

const T0 = 1_793_000_000_000;
let root: string;
let filename: string;
let db: Database.Database;
let other: Database.Database;
let at: number;
let serial: number;
let scope: ContextRestoreScope;
let store: ReturnType<typeof createContextRestoreStore>;
let peer: ReturnType<typeof createContextRestoreStore>;
const raw = () => (db.prepare('SELECT value FROM metadata WHERE key=?').get(contextRestoreKey(scope)) as { value: string } | undefined)?.value;
const persisted = () => JSON.parse(raw()!);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-restore-')));
  filename = path.join(root, 'brain.sqlite');
  db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  other = new Database(filename);
  for (const connection of [db, other]) connection.pragma('busy_timeout = 0');
  at = T0;
  serial = 0;
  scope = { canonicalDataDir: root, agentId: 'synthetic-agent', generation: 'synthetic-generation', sessionId: 'session/full:identifier' };
  store = createContextRestoreStore(db, { now: () => at, randomClaimId: () => `a-${++serial}` });
  peer = createContextRestoreStore(other, { now: () => at, randomClaimId: () => `b-${++serial}` });
});
afterEach(() => {
  for (const connection of [other, db]) if (connection?.open) {
    if (connection.inTransaction) connection.exec('ROLLBACK');
    connection.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex compaction restore metadata state', () => {
  it('does no DDL and does not own database lifetime', () => {
    const empty = new Database(':memory:');
    createContextRestoreStore(empty);
    expect(empty.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);
    empty.close();
    expect(db.open).toBe(true);
  });

  it('has a write-free missing-marker path', () => {
    db.exec("CREATE TRIGGER no_insert BEFORE INSERT ON metadata BEGIN SELECT RAISE(ABORT,'unexpected insert'); END");
    expect(store.readPending(scope)).toBeNull();
    expect(store.claimPending(scope, 'turn')).toBeNull();
    expect(store.satisfyFromSessionStart(scope, 1)).toBe(false);
    expect(db.prepare('SELECT * FROM metadata').all()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it('hashes the complete four-dimensional scope without persisting raw identifiers', () => {
    store.markPending(scope);
    const variants = [
      { ...scope, canonicalDataDir: root + '/other' }, { ...scope, agentId: 'other-agent' },
      { ...scope, generation: 'other-generation' }, { ...scope, sessionId: 'sessionfullidentifier' },
      { ...scope, sessionId: 'session/full:identifier ' },
    ];
    expect(new Set([scope, ...variants].map(contextRestoreKey)).size).toBe(6);
    for (const variant of variants) expect(peer.readPending(variant)).toBeNull();
    store.claimPending(scope, 'private full turn / identifier');
    const row = db.prepare('SELECT key,value FROM metadata').get() as {key:string;value:string};
    expect(row.key).toMatch(/^codex_context_restore:v1:[a-f0-9]{64}$/);
    for (const value of [...Object.values(scope), 'private full turn / identifier']) expect(row.key + row.value).not.toContain(value);
    expect(Object.keys(persisted()).sort()).toEqual(['claim','deliveredRevision','expiresAt','pendingRevision','updatedAt']);
  });

  it('rejects missing identifiers rather than inventing a global scope', () => {
    expect(() => store.markPending({ ...scope, sessionId: '' })).toThrow(/complete identifiers/);
    expect(() => store.claimPending(scope, '')).toThrow(/turn identifier/);
    expect(db.prepare('SELECT * FROM metadata').all()).toEqual([]);
  });

  it('consumes once per revision, and does not block a new revision in the same turn', () => {
    expect(store.markPending(scope)).toBe(1);
    const claim = store.claimPending(scope, 'same-turn')!;
    expect(store.canEmit(scope, claim)).toBe(true);
    expect(store.markEmitted(scope, claim)).toBe(true);
    expect(peer.claimPending(scope, 'same-turn')).toBeNull();
    expect(peer.claimPending(scope, 'later-turn')).toBeNull();
    expect(peer.markEmitted(scope, claim)).toBe(false);
    expect(store.readPending(scope)).toBeNull();
    expect(store.markPending(scope)).toBe(2);
    const next = peer.claimPending(scope, 'same-turn')!;
    expect(next.revision).toBe(2);
    expect(next.turnIdHash).toBe(claim.turnIdHash);
    expect(peer.markEmitted(scope, next)).toBe(true);
    expect(persisted()).toMatchObject({pendingRevision:2,deliveredRevision:2,deliveredTurnIdHash:next.turnIdHash});
  });

  it('coalesces multiple compactions and invalidates an old claim during prepare', () => {
    store.markPending(scope);
    const old = store.claimPending(scope, 'turn')!;
    peer.markPending(scope);
    peer.markPending(scope);
    expect(store.canEmit(scope, old)).toBe(false);
    expect(store.markEmitted(scope, old)).toBe(false);
    expect(store.releaseClaim(scope, old)).toBe(false);
    const latest = store.claimPending(scope, 'turn')!;
    expect(latest.revision).toBe(3);
    expect(store.markEmitted(scope, latest)).toBe(true);
  });

  it('preserves a newer revision arriving after final check and during stdout flush', () => {
    store.markPending(scope);
    const emitted = store.claimPending(scope, 'turn')!;
    expect(store.canEmit(scope, emitted)).toBe(true);
    // Simulate output already in flight: it cannot be withdrawn, but must not clear revision 2.
    peer.markPending(scope);
    const next = peer.claimPending(scope, 'turn')!;
    expect(store.markEmitted(scope, emitted)).toBe(false);
    expect(peer.canEmit(scope, next)).toBe(true);
    expect(persisted()).toMatchObject({pendingRevision:2,deliveredRevision:0,claim:next});
  });

  it('serializes competing consumers through two actual connections', () => {
    store.markPending(scope);
    const first = store.claimPending(scope, 'a')!;
    expect(peer.claimPending(scope, 'b')).toBeNull();
    expect(peer.canEmit(scope, first)).toBe(true);
    expect(peer.markEmitted(scope, first)).toBe(true);
    expect(store.canEmit(scope, first)).toBe(false);
    expect(db.inTransaction).toBe(false);
    expect(other.inTransaction).toBe(false);
  });

  it('allows exactly one simultaneous claim from two independent processes', async () => {
    store.markPending(scope);
    const script = path.join(root, 'claim.ts');
    fs.writeFileSync(script, `
      import Database from ${JSON.stringify(path.resolve('node_modules/better-sqlite3/lib/index.js'))};
      import { createContextRestoreStore } from ${JSON.stringify(path.resolve('src/hook-codex-context-restore.ts'))};
      const db = new Database(${JSON.stringify(filename)});
      db.pragma('busy_timeout = 2000');
      const store = createContextRestoreStore(db, { now: () => ${T0}, randomClaimId: () => process.argv[2] });
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => {
        process.stdout.write(JSON.stringify(store.claimPending(${JSON.stringify(scope)}, process.argv[2]))+'\\n');
        db.close(); process.stdin.destroy();
      });
    `);
    const children = ['process-a','process-b'].map(id => {
      const child = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'),script,id], { stdio:['pipe','pipe','pipe'] });
      let stdout = '', stderr = '';
      const ready = new Promise<void>((resolve,reject) => {
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.startsWith('ready\n')) resolve(); });
        child.on('error',reject);
        child.on('exit',code => { if (!stdout.startsWith('ready\n')) reject(new Error(`claim child exited ${code}: ${stderr}`)); });
      });
      child.stderr.on('data',chunk => { stderr += chunk; });
      const done = new Promise<unknown>((resolve,reject) => {
        child.on('error',reject);
        child.on('close',code => {
          if (code !== 0) reject(new Error(stderr));
          else { try { resolve(JSON.parse(stdout.trim().split('\n').at(-1)!)); } catch(error) { reject(error); } }
        });
      });
      return {child,ready,done};
    });
    try {
      await Promise.all(children.map(child => child.ready));
      for (const {child} of children) child.stdin.write('claim\n');
      const results = await Promise.all(children.map(child => child.done));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter(result => result === null)).toHaveLength(1);
      expect(persisted().claim).toEqual(results.find(Boolean));
    } finally { for (const {child} of children) if (child.exitCode === null) child.kill(); }
  }, 15_000);

  it('expires claims at 30 seconds and rejects an old owner after takeover', () => {
    store.markPending(scope);
    const first = store.claimPending(scope, 'turn')!;
    at += CONTEXT_RESTORE_CLAIM_MS - 1;
    expect(peer.claimPending(scope, 'next')).toBeNull();
    at++;
    expect(store.canEmit(scope, first)).toBe(false);
    const next = peer.claimPending(scope, 'next')!;
    expect(next.claimId).not.toBe(first.claimId);
    expect(store.releaseClaim(scope, first)).toBe(false);
    expect(store.markEmitted(scope, first)).toBe(false);
    expect(peer.canEmit(scope, next)).toBe(true);
  });

  it('requires the whole own claim identity for CAS, not just a matching revision', () => {
    store.markPending(scope);
    const claim = store.claimPending(scope, 'turn')!;
    for (const wrong of [{...claim,claimId:'wrong'},{...claim,turnIdHash:'0'.repeat(64)},{...claim,expiresAt:claim.expiresAt+1},{...claim,revision:2}]) {
      expect(peer.canEmit(scope,wrong)).toBe(false);
      expect(peer.markEmitted(scope,wrong)).toBe(false);
      expect(peer.releaseClaim(scope,wrong)).toBe(false);
    }
    expect(store.canEmit(scope,claim)).toBe(true);
  });

  it('allows known prepare/output failures to release only their own claim', () => {
    store.markPending(scope);
    const claim = store.claimPending(scope, 'turn')!;
    expect(store.releaseClaim(scope, claim)).toBe(true);
    expect(store.readPending(scope)?.pendingRevision).toBe(1);
    expect(peer.claimPending(scope,'turn')?.claimId).not.toBe(claim.claimId);
  });

  it('documents the non-exactly-once crash window after output and before delivery CAS', () => {
    store.markPending(scope);
    const first = store.claimPending(scope,'turn')!;
    expect(store.canEmit(scope,first)).toBe(true);
    // stdout succeeded, then process died without markEmitted/release.
    expect(peer.claimPending(scope,'turn')).toBeNull();
    at += CONTEXT_RESTORE_CLAIM_MS;
    const retry = peer.claimPending(scope,'turn')!;
    expect(retry.revision).toBe(first.revision);
    expect(peer.canEmit(scope,retry)).toBe(true);
    expect(peer.markEmitted(scope,retry)).toBe(true);
  });

  it('SessionStart satisfies only after output and invalidates the same revision claim', () => {
    store.markPending(scope);
    const observed = store.readPending(scope)!.pendingRevision;
    const claim = peer.claimPending(scope,'turn')!;
    // Merely reading the revision (or failed SS output) does not consume it.
    expect(store.canEmit(scope,claim)).toBe(true);
    expect(store.satisfyFromSessionStart(scope,observed)).toBe(true);
    expect(peer.canEmit(scope,claim)).toBe(false);
    expect(peer.markEmitted(scope,claim)).toBe(false);
    expect(store.readPending(scope)).toBeNull();
    expect(store.satisfyFromSessionStart(scope,observed)).toBe(false);
  });

  it('SessionStart completion for an old revision preserves a newer pending revision and claim', () => {
    store.markPending(scope);
    const snapshot = store.readPending(scope)!.pendingRevision;
    peer.markPending(scope);
    const current = peer.claimPending(scope,'same-turn')!;
    expect(store.satisfyFromSessionStart(scope,snapshot)).toBe(true);
    expect(persisted()).toMatchObject({pendingRevision:2,deliveredRevision:1,claim:current});
    expect(peer.canEmit(scope,current)).toBe(true);
    expect(peer.markEmitted(scope,current)).toBe(true);
    expect(store.satisfyFromSessionStart(scope,3)).toBe(false);
  });

  it('cleans at most 100 expired same-prefix records only when marking a new compaction', () => {
    const expired = JSON.stringify({pendingRevision:1,deliveredRevision:0,updatedAt:T0-CONTEXT_RESTORE_RECORD_MS,expiresAt:T0});
    const insert = db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)');
    for (let i=0;i<105;i++) insert.run(CONTEXT_RESTORE_PREFIX+String(i).padStart(64,'0'),expired);
    insert.run('unrelated-metadata',expired);
    insert.run('codexXcontextXrestore:v1:other',expired);
    insert.run(CONTEXT_RESTORE_PREFIX+'invalid','not-json');
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM metadata').get() as {n:number}).n;
    expect(store.readPending(scope)).toBeNull();
    expect(store.claimPending(scope,'turn')).toBeNull();
    expect(count()).toBe(108);
    store.markPending(scope);
    expect(count()).toBe(108-CONTEXT_RESTORE_CLEANUP_LIMIT+1);
    expect(db.prepare("SELECT value FROM metadata WHERE key='unrelated-metadata'").get()).toEqual({value:expired});
    expect(db.prepare("SELECT value FROM metadata WHERE key='codexXcontextXrestore:v1:other'").get()).toEqual({value:expired});
    expect(db.prepare('SELECT value FROM metadata WHERE key=?').get(CONTEXT_RESTORE_PREFIX+'invalid')).toEqual({value:'not-json'});
  });

  it('expires records after seven days without pretending that they were delivered', () => {
    store.markPending(scope);
    const before = raw();
    at += CONTEXT_RESTORE_RECORD_MS;
    expect(store.readPending(scope)).toBeNull();
    expect(peer.claimPending(scope,'turn')).toBeNull();
    expect(raw()).toBe(before);
    expect(store.markPending(scope)).toBe(1);
    expect(persisted()).toMatchObject({pendingRevision:1,deliveredRevision:0});
  });

  it.each(['not-json','{}',JSON.stringify({pendingRevision:1,deliveredRevision:0,updatedAt:T0,expiresAt:T0+CONTEXT_RESTORE_RECORD_MS,prompt:'untrusted extra field'}),' '.repeat(CONTEXT_RESTORE_MAX_BYTES+1)])('preserves corrupt/oversized metadata until a new legitimate mark (%#)', value => {
    db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(contextRestoreKey(scope),value);
    expect(store.readPending(scope)).toBeNull();
    expect(store.claimPending(scope,'turn')).toBeNull();
    expect(store.satisfyFromSessionStart(scope,1)).toBe(false);
    expect(raw()).toBe(value);
    store.markPending(scope);
    expect(persisted()).toMatchObject({pendingRevision:1,deliveredRevision:0});
    expect(Buffer.byteLength(raw()!)).toBeLessThanOrEqual(CONTEXT_RESTORE_MAX_BYTES);
  });

  it('treats a persisted claim longer than the fixed 30 seconds as invalid, not completed', () => {
    store.markPending(scope);
    store.claimPending(scope,'turn');
    const invalid=persisted();
    invalid.claim.expiresAt=invalid.updatedAt+CONTEXT_RESTORE_CLAIM_MS+1;
    const value=JSON.stringify(invalid);
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run(value,contextRestoreKey(scope));
    expect(store.readPending(scope)).toBeNull();
    expect(peer.claimPending(scope,'turn')).toBeNull();
    expect(raw()).toBe(value);
  });

  it('rejects an unbounded random claim identifier without writing it', () => {
    store.markPending(scope);
    const before = raw();
    const invalid = createContextRestoreStore(db,{now:()=>at,randomClaimId:()=> '界'.repeat(CONTEXT_RESTORE_MAX_BYTES)});
    expect(()=>invalid.claimPending(scope,'turn')).toThrow(/claim identifier/);
    expect(raw()).toBe(before);
    expect(db.inTransaction).toBe(false);
  });

  it('keeps a marker retryable when another connection holds the write lock', () => {
    store.markPending(scope);
    const before = raw();
    other.exec('BEGIN IMMEDIATE');
    expect(()=>store.claimPending(scope,'turn')).toThrow(/locked/);
    expect(raw()).toBe(before);
    other.exec('ROLLBACK');
    expect(store.claimPending(scope,'turn')).not.toBeNull();
  });

  it('rolls back expiry cleanup together with a failed mark', () => {
    const expiredKey = CONTEXT_RESTORE_PREFIX+'expired';
    const value=JSON.stringify({pendingRevision:1,deliveredRevision:0,updatedAt:T0-CONTEXT_RESTORE_RECORD_MS,expiresAt:T0});
    db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(expiredKey,value);
    db.exec("CREATE TRIGGER reject_mark BEFORE INSERT ON metadata BEGIN SELECT RAISE(ABORT,'synthetic mark failure'); END");
    expect(()=>store.markPending(scope)).toThrow('synthetic mark failure');
    expect(db.prepare('SELECT key,value FROM metadata').all()).toEqual([{key:expiredKey,value}]);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls back a failed delivery update and permits a later retry', () => {
    store.markPending(scope);
    const claim=store.claimPending(scope,'turn')!;
    const before=raw();
    db.exec("CREATE TRIGGER reject_delivery BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'synthetic delivery failure'); END");
    expect(()=>store.markEmitted(scope,claim)).toThrow('synthetic delivery failure');
    expect(raw()).toBe(before);
    db.exec('DROP TRIGGER reject_delivery');
    expect(store.markEmitted(scope,claim)).toBe(true);
  });

  it('does not wrap an exhausted revision or silently accept an invalid clock', () => {
    const value=JSON.stringify({pendingRevision:Number.MAX_SAFE_INTEGER,deliveredRevision:0,updatedAt:T0,expiresAt:T0+CONTEXT_RESTORE_RECORD_MS});
    db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(contextRestoreKey(scope),value);
    expect(()=>store.markPending(scope)).toThrow(/revision exhausted/);
    expect(raw()).toBe(value);
    const invalid=createContextRestoreStore(db,{now:()=>Number.NaN});
    expect(()=>invalid.readPending(scope)).toThrow(/time/);
  });
});
