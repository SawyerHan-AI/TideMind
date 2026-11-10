import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema.js';
import { applyCloudNodeRow } from '../../client/electron/cloud/local-apply.js';
import { preserveLegacyVectorData } from '../../src/db/vector-cache-schema.js';
import { assertSupportedDatabaseSchema } from '../../src/db/schema-compatibility.js';

describe('legacy raw vectors survive replaceable index changes',()=>{
 it('preserves exact bytes and segment mapping before a dimension rebuild, without claiming provenance',()=>{
  const db=new Database(':memory:');
  try{
   ensureSchema(db);
   db.exec('CREATE TABLE nodes_vec(id TEXT PRIMARY KEY,embedding BLOB NOT NULL)');
   db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('fixture','fact','synthetic',datetime('now'),datetime('now'))").run();
   db.prepare('INSERT INTO node_segments(segment_id,node_id,segment_index) VALUES (?,?,?)').run('fixture#0','fixture',0);
   const bytes=Buffer.from(new Float32Array([0,-0,0.25,0.5]).buffer);
   db.prepare('INSERT INTO nodes_vec(id,embedding) VALUES (?,?)').run('fixture#0',bytes);
   expect(preserveLegacyVectorData(db)).toBe(1);
   expect(preserveLegacyVectorData(db,true)).toBe(0);
   db.exec('DROP TABLE nodes_vec; CREATE TABLE nodes_vec(id TEXT PRIMARY KEY,embedding BLOB NOT NULL)');
   const row=db.prepare('SELECT dimensions,embedding,node_id,segment_index,original_input_hash FROM vector_legacy_archive').get();
   expect(row).toEqual({dimensions:4,embedding:bytes,node_id:'fixture',segment_index:0,original_input_hash:null});
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0});
   expect(()=>assertSupportedDatabaseSchema(db,47)).toThrow();
  }finally{db.close();}
 });
 it('preserves more than one bounded batch from a real sqlite-vec virtual table',()=>{
  const db=new Database(':memory:');
  try{
   ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath());
   db.exec('CREATE VIRTUAL TABLE nodes_vec USING vec0(id TEXT PRIMARY KEY,embedding float[4])');
   const bytes=Buffer.from(new Float32Array([1,0,0,0]).buffer);
   const insert=db.prepare('INSERT INTO nodes_vec(id,embedding) VALUES (?,?)');
   db.transaction(()=>{for(let i=0;i<301;i++)insert.run('fixture-'+String(i).padStart(4,'0'),bytes);})();
   expect(preserveLegacyVectorData(db)).toBe(301);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_legacy_archive WHERE embedding=?').get(bytes)).toEqual({n:301});
  }finally{db.close();}
 },30000);
 it('keeps durable data through score/content downlinks but cascades a real hard delete',()=>{
  const db=new Database(':memory:');
  try{
   db.pragma('foreign_keys = ON');ensureSchema(db);
   const row={id:'fixture',content:'synthetic',title:null,type:'fact',created:'2026-01-01T00:00:00Z',updated:'2026-01-01T00:00:00Z',edit_seq:1};
   applyCloudNodeRow(db,row);
   db.prepare('INSERT INTO vector_bundles(node_id,profile_id,input_hash,checksum,bundle_json,shareable) VALUES (?,?,?,?,?,1)')
    .run(row.id,'fixture-profile','original-input','fixture-checksum','{}');
   db.prepare('INSERT INTO vector_upload_queue(account_id,node_id,profile_id,input_hash,checksum,payload_json) VALUES (?,?,?,?,?,?)')
    .run('fixture-account',row.id,'fixture-profile','original-input','fixture-checksum','{}');
   applyCloudNodeRow(db,{...row,heat:0.25});
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:1});
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:1});
   applyCloudNodeRow(db,{...row,content:'updated synthetic',edit_seq:2});
   expect(db.prepare('SELECT input_hash FROM vector_bundles').get()).toEqual({input_hash:'original-input'});
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:1});
   db.prepare('DELETE FROM nodes WHERE id=?').run(row.id);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0});
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:0});
  }finally{db.close();}
 });
 it('rolls back preservation when raw bytes are invalid and retains the original projection',()=>{
  const db=new Database(':memory:');
  try{
   ensureSchema(db);db.exec('CREATE TABLE nodes_vec(id TEXT PRIMARY KEY,embedding BLOB NOT NULL)');
   const insert=db.prepare('INSERT INTO nodes_vec(id,embedding) VALUES (?,?)');
   insert.run('a-valid',Buffer.from(new Float32Array([1,0,0,0]).buffer));
   insert.run('b-invalid',Buffer.from([1,2,3]));
   expect(()=>preserveLegacyVectorData(db)).toThrow('cannot be preserved');
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_legacy_archive').get()).toEqual({n:0});
   expect(db.prepare("SELECT value FROM metadata WHERE key='vector.legacy_archive_version'").get()).toBeUndefined();
   expect(db.prepare('SELECT COUNT(*) AS n FROM nodes_vec').get()).toEqual({n:2});
  }finally{db.close();}
 });
 it('upgrades a v47 database idempotently without clearing existing data',()=>{
  const db=new Database(':memory:');
  try{
   ensureSchema(db);
   db.exec("DROP TABLE vector_upload_queue; DROP TABLE vector_bundles; DROP TABLE vector_legacy_archive; DROP INDEX idx_vector_remote_receipt_node; DROP TRIGGER vector_node_proof_insert; DROP TRIGGER vector_node_proof_update; DROP TRIGGER vector_node_proof_delete; DELETE FROM metadata WHERE key GLOB 'vector.proof_generation*'");
   db.prepare("UPDATE metadata SET value='47' WHERE key='schema_version'").run();
   db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('fixture','fact','synthetic',datetime('now'),datetime('now'))").run();
   const oldBackup=db.serialize();
   ensureSchema(db);ensureSchema(db);
   const restored=new Database(oldBackup);
   try { expect(assertSupportedDatabaseSchema(restored,47)).toBe(47); } finally { restored.close(); }
   expect(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({value:'48'});
   expect(db.prepare('SELECT content FROM nodes WHERE id=?').get('fixture')).toEqual({content:'synthetic'});
   expect(db.prepare("SELECT name FROM sqlite_master WHERE name='vector_upload_queue'").get()).toBeDefined();
  }finally{db.close();}
 });
});
