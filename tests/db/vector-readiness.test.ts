import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {describe,it,expect,vi} from 'vitest';
import type {AppConfig} from '../../src/types.js';
const context=vi.hoisted(()=>({config:null as AppConfig|null}));
vi.mock('../../src/config.js',()=>({getConfig:()=>context.config,getDataDir:()=>'/synthetic'}));
vi.mock('../../src/llm/embedding.js',()=>({getEmbedding:vi.fn(async()=>null),getEmbeddingCredentialSignal:()=> 'fixture',clearEmbeddingTokenCache:()=>{}}));
import {installDesktopVectorCacheFetcher} from '../../src/embedding/generate-node.js';
import {getEmbedding} from '../../src/llm/embedding.js';
import {ensureSchema} from '../../src/db/schema.js';
import {activateVectorRuntime,commitVectorBundle,localEmbeddingInstanceId} from '../../src/db/vector-cache-store.js';
import {selectEmbeddingProfile} from '../../src/embedding/profile.js';
import {createVectorBundle} from '../../src/embedding/bundle-contract.js';
import {getVectorReadiness} from '../../src/db/vector-readiness.js';
import {reembedAllNodes,getReembedProgress} from '../../src/db/vectors.js';
function setup(shared=false){
 const db=new Database(':memory:');ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath());
 const config={embedding:{provider:'gemini',model:'gemini-embedding-001',dimensions:3},gemini:{api_key:'fixture'},vertex:{project_id:'fixture',region:'us-central1'},ollama:{url:'http://localhost:11434'}} as unknown as AppConfig;
 context.config=config;
 const state=activateVectorRuntime(db,{selection:selectEmbeddingProfile(config,localEmbeddingInstanceId(db)),accountId:shared?'user':null,endpointId:shared?'a'.repeat(64):null,syncEnabled:shared,backgroundBuilder:!shared});
 const add=(id:string,content='synthetic',ready=true)=>{
  const node={id,content,title:null};db.prepare("INSERT INTO nodes(id,type,content,heat,created,updated) VALUES (?,'fact',?,1,datetime('now'),datetime('now'))").run(id,content);
  const bundle=content.trim()?createVectorBundle(node,state.selection.profile,[new Float32Array([1,0,0])]):null;
  if(ready&&bundle)commitVectorBundle(db,bundle,state,shared);return bundle;
 };return {db,state,config,add};
}
describe('truthful vector readiness',()=>{
 it('counts current complete projections only, excluding empty and hidden nodes',()=>{
  const {db,add}=setup();try{
   add('ready');add('stale');add('missing');add('hidden');add('empty','   ');
   db.prepare("UPDATE nodes SET content='edited' WHERE id='stale'").run();
   db.prepare("DELETE FROM nodes_vec WHERE id='missing#0'").run();
   db.prepare("UPDATE nodes SET archived=1 WHERE id='hidden'").run();
   expect(getVectorReadiness(db)).toMatchObject({eligible:3,ready:1,missing:2,mode:'waiting_generation'});
  }finally{db.close();}
 });
 it('keeps queued uploads distinct from local coverage and scopes them to endpoint',()=>{
  const {db,state,add}=setup(true);try{
   add('ready');expect(getVectorReadiness(db)).toMatchObject({ready:1,missing:0,queued:1,mode:'waiting_sync'});
   db.prepare('UPDATE vector_upload_queue SET attempts=1').run();expect(getVectorReadiness(db)).toMatchObject({uploadFailed:1,mode:'error'});
   activateVectorRuntime(db,{...state,endpointId:'b'.repeat(64)});
   expect(getVectorReadiness(db)).toMatchObject({ready:1,queued:0,uploadFailed:0,mode:'ready'});
  }finally{db.close();}
 });
 it('reports nonbuilder waiting for sync and ignores obsolete generation failures',()=>{
  const {db,state,add}=setup(true);try{
   const bundle=add('missing','synthetic',false)!;
   expect(getVectorReadiness(db).mode).toBe('waiting_sync');
   const key=`vector.generate_retry:${JSON.stringify([state.endpointId,state.accountId,state.selection.id,'missing'])}`;
   db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(key,JSON.stringify({inputHash:bundle.inputHash,reason:'generation_failed'}));
   expect(getVectorReadiness(db)).toMatchObject({failed:1,mode:'error'});
   db.prepare("UPDATE nodes SET content='edited' WHERE id='missing'").run();
   expect(getVectorReadiness(db)).toMatchObject({failed:0,mode:'waiting_sync'});
  }finally{db.close();}
 });
 it('ignores archived and stale upload failures',()=>{
  const {db,add}=setup(true);try{
   add('archived');add('edited');db.prepare('UPDATE vector_upload_queue SET attempts=1').run();
   db.prepare("UPDATE nodes SET archived=1 WHERE id='archived'").run();
   db.prepare("UPDATE nodes SET content='new input' WHERE id='edited'").run();
   expect(getVectorReadiness(db)).toMatchObject({eligible:1,queued:0,uploadFailed:0,mode:'waiting_sync'});
  }finally{db.close();}
 });
 it('does not reuse readiness after a same-dimension profile switch',()=>{
  const {db,state,config,add}=setup();try{
   add('ready');expect(getVectorReadiness(db).ready).toBe(1);
   config.embedding.provider='vertex';activateVectorRuntime(db,{...state,selection:selectEmbeddingProfile(config,localEmbeddingInstanceId(db))});
   expect(getVectorReadiness(db)).toMatchObject({ready:0,missing:1,mode:'waiting_generation'});
  }finally{db.close();}
 });
 it('does not call an exhausted traversal a completed rebuild',async()=>{
  const {db,add}=setup(true);try{
   add('missing','synthetic',false);
   expect(await reembedAllNodes(db)).toBe(false);
   expect(getReembedProgress()).toMatchObject({running:false,done:1,total:1});
   expect(db.prepare("SELECT value FROM metadata WHERE key='embedding_normalization_version'").get()).toBeUndefined();
  }finally{db.close();}
 });
 it('records actual provider failure, then clears its status after successful coverage',async()=>{
  const {db,state,add}=setup();try{
   const bundle=add('missing','synthetic',false)!;
   expect(await reembedAllNodes(db)).toBe(false);
   expect(getVectorReadiness(db)).toMatchObject({mode:'error',failed:1});
   commitVectorBundle(db,bundle,state,false);
   expect(getVectorReadiness(db)).toMatchObject({mode:'ready',failed:0});
  }finally{db.close();}
 });
 it('does not label a cache transport failure as a model generation failure',async()=>{
  const {db,add}=setup(true);const remove=installDesktopVectorCacheFetcher(async()=>{throw new Error('cache HTTP 503');});
  try{add('missing','synthetic',false);vi.mocked(getEmbedding).mockClear();
   expect(await reembedAllNodes(db)).toBe(false);expect(getEmbedding).not.toHaveBeenCalled();
   expect(getVectorReadiness(db)).toMatchObject({failed:0,mode:'waiting_sync'});
  }finally{remove();db.close();}
 });
 it('stops the entire manual rebuild when its epoch changes',async()=>{
  const {db,state,add}=setup();try{
   add('a','first',false);add('b','second',false);
   vi.mocked(getEmbedding).mockClear().mockImplementationOnce(async()=>{
    activateVectorRuntime(db,{...state,backgroundBuilder:false});return new Float32Array([1,0,0]);
   });
   expect(await reembedAllNodes(db)).toBe(false);
   expect(getEmbedding).toHaveBeenCalledTimes(1);
   expect(getVectorReadiness(db).failed).toBe(0);
  }finally{db.close();}
 });
 it('fails closed without migrating an old database',()=>{
  const db=new Database(':memory:');try{
   db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
   expect(getVectorReadiness(db).mode).toBe('initializing');
   expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'metadata'}]);
  }finally{db.close();}
 });
 it('does not read the database after close',()=>{
  const {db}=setup();db.close();const spy=vi.spyOn(db,'prepare');
  expect(getVectorReadiness(db).mode).toBe('initializing');expect(spy).not.toHaveBeenCalled();spy.mockRestore();
 });
});
