import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema.js';
import { createVectorBundle, embeddingProfileId, type EmbeddingProfile } from '../../src/embedding/bundle-contract.js';
import { EMBEDDING_INPUT_VERSION, EMBEDDING_SEGMENT_VERSION } from '../../src/embedding/input-contract.js';
import { activateVectorRuntime, commitVectorBundle, readCompatibleVectorBundle, acknowledgeVectorUpload, readVectorRuntime, type VectorRuntimeState } from '../../src/db/vector-cache-store.js';
const p:EmbeddingProfile={version:1,provider:'fixture',model:'fixture-model',revision:null,serviceIdentity:'a'.repeat(64),dimensions:3,requestOptions:{},normalization:'l2-f32-v1',inputVersion:EMBEDDING_INPUT_VERSION,segmentVersion:EMBEDDING_SEGMENT_VERSION};
const node={id:'fixture',content:'synthetic content',title:null};
function setup(){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath());
 db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES (?,'fact',?,datetime('now'),datetime('now'))").run(node.id,node.content);
 const state=activateVectorRuntime(db,{selection:{profile:p,id:embeddingProfileId(p),shareable:true},accountId:'account-a',syncEnabled:true,backgroundBuilder:true});
 return {db,state};
}
const make=(profile=p,content=node.content)=>createVectorBundle({...node,content},profile,[new Float32Array([1,0,0])]);
const queued=(b:ReturnType<typeof make>)=>({accountId:'account-a',nodeId:b.nodeId,profileId:b.profileId,inputHash:b.inputHash,checksum:b.checksum});
const count=(db:Database.Database,table:string)=>(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n;
describe('atomic local vector cache publication',()=>{
 it('commits raw bundle, projection and upload together, then reuses without generation',()=>{
  const {db,state}=setup();try{
   const b=make();expect(commitVectorBundle(db,b,state,true)).toBe(true);
   expect(count(db,'vector_bundles')).toBe(1);expect(count(db,'nodes_vec')).toBe(1);expect(count(db,'vector_upload_queue')).toBe(1);
   expect(readCompatibleVectorBundle(db,node.id,state)).toEqual(b);
   expect(acknowledgeVectorUpload(db,state,queued(b))).toBe(true);expect(count(db,'vector_upload_queue')).toBe(0);
  }finally{db.close();}
 });
 it('requires an exact atomic acknowledgement when adopting different authoritative bytes',()=>{
  const {db,state}=setup();try{
   const local=make();commitVectorBundle(db,local,state,true);
   const authority=createVectorBundle(node,p,[new Float32Array([0,1,0])]);
   expect(commitVectorBundle(db,authority,state,false)).toBe(false);
   expect(readCompatibleVectorBundle(db,node.id,state)).toEqual(local);
   expect(commitVectorBundle(db,authority,state,false,{...queued(local),checksum:'wrong'})).toBe(false);
   expect(commitVectorBundle(db,authority,state,false,queued(local))).toBe(true);
   expect(readCompatibleVectorBundle(db,node.id,state)).toEqual(authority);
   expect(count(db,'vector_upload_queue')).toBe(0);
  }finally{db.close();}
 });
 it.each([{accountId:7},{accountId:null},{syncEnabled:'yes'},{backgroundBuilder:0}])('rejects invalid activation without changing state or projection: %j',patch=>{
  const {db,state}=setup();try{
   const b=make();commitVectorBundle(db,b,state,true);
   expect(()=>activateVectorRuntime(db,{...state,...patch} as never)).toThrow('Invalid vector runtime');
   expect(readVectorRuntime(db)?.epoch).toBe(state.epoch);
   expect(readCompatibleVectorBundle(db,node.id,state)).toEqual(b);
  }finally{db.close();}
 });
 it.each([{epoch:1},{epoch:''},{accountId:null},{accountId:''},{syncEnabled:1},{backgroundBuilder:0}])('rejects invalid persisted runtime metadata: %j',patch=>{
  const {db,state}=setup();try{
   db.prepare("UPDATE metadata SET value=? WHERE key='vector.runtime.v1'").run(JSON.stringify({...state,...patch}));
   expect(()=>readVectorRuntime(db)).toThrow('Invalid vector runtime');
  }finally{db.close();}
 });
 it.each(['disabled','nonshareable','logout'] as const)('preserves the exact pending payload when a local replacement cannot queue: %s',mode=>{
  const {db,state}=setup();try{
   const original=make();commitVectorBundle(db,original,state,true);
   const next=activateVectorRuntime(db,{...state,syncEnabled:mode==='nonshareable',
     accountId:mode==='logout'?null:state.accountId,
     selection:{...state.selection,shareable:mode!=='nonshareable'}});
   const replacement=createVectorBundle(node,p,[new Float32Array([0,1,0])]);
   expect(commitVectorBundle(db,replacement,next,true)).toBe(true);
   expect(readCompatibleVectorBundle(db,node.id,next)).toEqual(replacement);
   const pending=db.prepare('SELECT account_id,checksum,payload_json FROM vector_upload_queue').get() as {account_id:string;checksum:string;payload_json:string};
   expect(pending.account_id).toBe('account-a');expect(pending.checksum).toBe(original.checksum);
   expect(JSON.parse(pending.payload_json)).toEqual(original);
  }finally{db.close();}
 });
 it('preserves retry backoff for identical queued content and resets it only for new input',()=>{
  const {db,state}=setup();try{
   const b=make();commitVectorBundle(db,b,state,true);
   db.prepare('UPDATE vector_upload_queue SET attempts=3,retry_after=123456').run();
   commitVectorBundle(db,b,state,true);
   expect(db.prepare('SELECT attempts,retry_after FROM vector_upload_queue').get()).toEqual({attempts:3,retry_after:123456});
   db.prepare('UPDATE nodes SET content=? WHERE id=?').run('changed content',node.id);
   commitVectorBundle(db,make(p,'changed content'),state,true);
   expect(db.prepare('SELECT attempts,retry_after FROM vector_upload_queue').get()).toEqual({attempts:0,retry_after:0});
  }finally{db.close();}
 });
 it('rechecks the caller generation fence inside the publication transaction',()=>{
  const {db,state}=setup();try{
   const fence=()=>{expect(db.inTransaction).toBe(true);return false;};
   expect(commitVectorBundle(db,make(),state,true,undefined,fence)).toBe(false);
   expect(count(db,'vector_bundles')).toBe(0);expect(count(db,'nodes_vec')).toBe(0);
  }finally{db.close();}
 });
 it('keeps pending payloads isolated across cloud endpoints with the same account and profile',()=>{
  const {db,state}=setup();try{
   const first=activateVectorRuntime(db,{...state,endpointId:'a'.repeat(64)});const b=make();commitVectorBundle(db,b,first,true);
   const second=activateVectorRuntime(db,{...first,endpointId:'b'.repeat(64)});commitVectorBundle(db,b,second,true);
   expect(count(db,'vector_upload_queue')).toBe(2);
   expect(acknowledgeVectorUpload(db,second,{...queued(b),endpointId:first.endpointId})).toBe(false);
   expect(acknowledgeVectorUpload(db,second,{...queued(b),endpointId:second.endpointId})).toBe(true);
   expect(db.prepare('SELECT endpoint_id FROM vector_upload_queue').get()).toEqual({endpoint_id:first.endpointId});
  }finally{db.close();}
 });
 it('rolls back both raw data and projection if upload bookkeeping fails',()=>{
  const {db,state}=setup();try{
   db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON vector_upload_queue BEGIN SELECT RAISE(ABORT,'fixture queue failure'); END");
   expect(()=>commitVectorBundle(db,make(),state,true)).toThrow('fixture queue failure');
   expect(count(db,'vector_bundles')).toBe(0);expect(count(db,'nodes_vec')).toBe(0);expect(count(db,'node_segments')).toBe(0);
  }finally{db.close();}
 });
 it.each(['account','model','role'] as const)('rejects a late result after %s changes',change=>{
  const {db,state}=setup();try{
   const input={selection:state.selection,accountId:state.accountId,syncEnabled:true,backgroundBuilder:true};
   if(change==='account')input.accountId='account-b';
   if(change==='role')input.backgroundBuilder=false;
   if(change==='model'){const profile={...p,model:'different-model'};input.selection={profile,id:embeddingProfileId(profile),shareable:true};}
   activateVectorRuntime(db,input);
   expect(commitVectorBundle(db,make(),state,true)).toBe(false);expect(count(db,'vector_upload_queue')).toBe(0);
  }finally{db.close();}
 });
 it('retains raw bundles but empties the old projection when switching profiles',()=>{
  const {db,state}=setup();try{
   commitVectorBundle(db,make(),state,true);
   const profile={...p,model:'different-model'};
   const next=activateVectorRuntime(db,{...state,selection:{profile,id:embeddingProfileId(profile),shareable:true}});
   expect(count(db,'vector_bundles')).toBe(1);expect(count(db,'nodes_vec')).toBe(0);
   expect(readCompatibleVectorBundle(db,node.id,next)).toBeNull();
  }finally{db.close();}
 });
 it('rolls back a failed profile activation including projection DDL and archive writes',()=>{
  const {db,state}=setup();try{
   const b=make();commitVectorBundle(db,b,state,true);
   db.exec("CREATE TRIGGER fail_runtime BEFORE INSERT ON metadata WHEN NEW.key='vector.runtime.v1' BEGIN SELECT RAISE(ABORT,'fixture runtime failure'); END");
   const profile={...p,model:'different-model'};
   expect(()=>activateVectorRuntime(db,{...state,selection:{profile,id:embeddingProfileId(profile),shareable:true}})).toThrow('fixture runtime failure');
   expect(count(db,'nodes_vec')).toBe(1);expect(count(db,'vector_legacy_archive')).toBe(0);
   expect(readCompatibleVectorBundle(db,node.id,state)).toEqual(b);
  }finally{db.close();}
 });
 it('retains runtime, raw bundle and pending upload through a cold database reopen',()=>{
  const {db,state}=setup();let reopened:Database.Database|undefined;
  try{
   const b=make();commitVectorBundle(db,b,state,true);
   reopened=new Database(db.serialize());reopened.loadExtension(sqliteVec.getLoadablePath());
   expect(activateVectorRuntime(reopened,state).epoch).toBe(state.epoch);
   expect(readCompatibleVectorBundle(reopened,node.id,state)).toEqual(b);
   expect(count(reopened,'nodes_vec')).toBe(1);expect(count(reopened,'vector_upload_queue')).toBe(1);
  }finally{reopened?.close();db.close();}
 });
 it('does not acknowledge a newer pending input with a late old receipt',()=>{
  const {db,state}=setup();try{
   const old=make();commitVectorBundle(db,old,state,true);
   db.prepare('UPDATE nodes SET content=? WHERE id=?').run('changed text',node.id);
   expect(readCompatibleVectorBundle(db,node.id,state)).toBeNull();
   expect(commitVectorBundle(db,old,state,true)).toBe(false);
   const fresh=make(p,'changed text');commitVectorBundle(db,fresh,state,true);
   expect(acknowledgeVectorUpload(db,state,queued(old))).toBe(false);
   expect(count(db,'vector_upload_queue')).toBe(1);
  }finally{db.close();}
 });
 it('does not queue downloaded or nonshareable data and does not allow caller flags to bypass runtime state',()=>{
  const {db,state}=setup();try{
   commitVectorBundle(db,make(),state,false);expect(count(db,'vector_upload_queue')).toBe(0);
   const local=activateVectorRuntime(db,{...state,selection:{...state.selection,shareable:false}});
   commitVectorBundle(db,make(),local,true);expect(count(db,'vector_upload_queue')).toBe(0);
   const forged:VectorRuntimeState={...local,selection:{...local.selection,shareable:true}};
   expect(commitVectorBundle(db,make(),forged,true)).toBe(false);
  }finally{db.close();}
 });
});
