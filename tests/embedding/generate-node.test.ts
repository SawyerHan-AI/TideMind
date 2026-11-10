import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/types.js';
import { createConnection } from '../../src/db/connections.js';
import { ensureSchema } from '../../src/db/schema.js';
import { activateVectorRuntime, localEmbeddingInstanceId, readCompatibleVectorBundle } from '../../src/db/vector-cache-store.js';
import { selectEmbeddingProfile } from '../../src/embedding/profile.js';
import { createVectorBundle } from '../../src/embedding/bundle-contract.js';
import { nodeEmbeddingInput, segmentForEmbedding } from '../../src/embedding/input-contract.js';
vi.mock('../../src/llm/embedding.js',()=>({getEmbedding:vi.fn(),getEmbeddingCredentialSignal:vi.fn(()=> 'credential-1')}));
import { getEmbedding, getEmbeddingCredentialSignal } from '../../src/llm/embedding.js';
import * as workerRuntime from '../../src/metabolism/worker-runtime-context.js';
import { generateNodeVectorBundle } from '../../src/embedding/generate-node.js';
const base={embedding:{provider:'gemini',model:'ignored-alias',dimensions:3},gemini:{api_key:'synthetic'},vertex:{region:'us-central1',project_id:'fixture'},ollama:{url:'http://localhost:11434'}} as unknown as AppConfig;
const node={id:'fixture',content:'Synthetic content. '.repeat(90),title:null};
function setup(builder=true,sync=true){
 const db=new Database(':memory:');ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath());
 db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES (?,'fact',?,datetime('now'),datetime('now'))").run(node.id,node.content);
 const config=structuredClone(base);const selection=selectEmbeddingProfile(config,localEmbeddingInstanceId(db));
 const state=activateVectorRuntime(db,{selection,accountId:sync?'account-a':null,syncEnabled:sync,backgroundBuilder:builder});
 return {db,config,state};
}
const miss=async()=>null;
beforeEach(()=>{vi.mocked(getEmbedding).mockReset().mockResolvedValue(new Float32Array([1,0,0]));vi.mocked(getEmbeddingCredentialSignal).mockReset().mockReturnValue('credential-1');});
describe('cache-first node generation',()=>{
 it('imports a compatible remote bundle without any embedding calls',async()=>{
  const {db,config,state}=setup(false);try{
   const b=createVectorBundle(node,state.selection.profile,segmentForEmbedding(nodeEmbeddingInput(node.content)).map(()=>new Float32Array([1,0,0])));
   expect(await generateNodeVectorBundle(db,node.id,config,{fetchCached:async()=>b})).toBe(b.segments.length);
   expect(getEmbedding).not.toHaveBeenCalled();expect(readCompatibleVectorBundle(db,node.id,state)).toEqual(b);
   await generateNodeVectorBundle(db,node.id,config);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:0});
  }finally{db.close();}
 });
 it.each([false,undefined,''])('does not treat invalid cache response %j as permission to call a model',async response=>{
  const {db,config}=setup();try{
   expect(await generateNodeVectorBundle(db,node.id,config,{fetchCached:async()=>response})).toBe(0);
   expect(getEmbedding).not.toHaveBeenCalled();
  }finally{db.close();}
 });
 it('does not commit a valid different-node cache response',async()=>{
  const {db,config,state}=setup();try{
   const other={id:'other',content:'other synthetic',title:null};
   db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES (?,'fact',?,datetime('now'),datetime('now'))").run(other.id,other.content);
   const b=createVectorBundle(other,state.selection.profile,[new Float32Array([1,0,0])]);
   expect(await generateNodeVectorBundle(db,node.id,config,{fetchCached:async()=>b})).toBe(0);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0});expect(getEmbedding).not.toHaveBeenCalled();
  }finally{db.close();}
 });
 it('discards a node job when its credential generation changes',async()=>{
  const {db,config}=setup();try{
   vi.mocked(getEmbedding).mockImplementationOnce(async()=>{vi.mocked(getEmbeddingCredentialSignal).mockReturnValue('credential-2');return new Float32Array([1,0,0]);});
   expect(await generateNodeVectorBundle(db,node.id,config,{fetchCached:miss})).toBe(0);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0});
  }finally{db.close();}
 });
 it('uses the selected connection and discards results after that credential changes',async()=>{
  const {db,config,state}=setup();try{
   const connection=createConnection(db,{name:'Synthetic',provider_type:'gemini',credentials:{api_key:'selected-fixture-key'}});
   config.embedding.connection=connection.id;activateVectorRuntime(db,{...state,bindingId:connection.id});
   vi.mocked(getEmbedding).mockImplementationOnce(async(_text,options)=>{
    expect(options?.configSnapshot?.gemini.api_key).toBe('selected-fixture-key');
    db.prepare('UPDATE model_connections SET credentials=? WHERE id=?').run(JSON.stringify({api_key:'changed-fixture-key'}),connection.id);
    return new Float32Array([1,0,0]);
   });
   expect(await generateNodeVectorBundle(db,node.id,config,{fetchCached:miss})).toBe(0);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0});
  }finally{db.close();}
 });
 it('waits on an unchecked remote cache and on a non-builder background miss',async()=>{
  const a=setup();const b=setup(false);try{
   expect(await generateNodeVectorBundle(a.db,node.id,a.config)).toBe(0);
   expect(await generateNodeVectorBundle(b.db,node.id,b.config,{fetchCached:miss})).toBe(0);
   expect(getEmbedding).not.toHaveBeenCalled();
  }finally{a.db.close();b.db.close();}
 });
 it('generates after a checked miss with a frozen configuration, then reuses locally',async()=>{
  const {db,config}=setup();try{
   const original=structuredClone(config);
   vi.mocked(getEmbedding).mockImplementation(async()=>{config.gemini.api_key='changed-after-start';return new Float32Array([1,0,0]);});
   const count=await generateNodeVectorBundle(db,node.id,config,{fetchCached:miss});
   expect(count).toBeGreaterThan(1);
   for(const [,options] of vi.mocked(getEmbedding).mock.calls)expect(options?.configSnapshot).toEqual(original);
   vi.mocked(getEmbedding).mockClear();
   expect(await generateNodeVectorBundle(db,node.id,config)).toBe(count);
   expect(getEmbedding).not.toHaveBeenCalled();
  }finally{db.close();}
 });
 it('retains explicit foreground and sync-disabled local generation',async()=>{
  const a=setup(false);const b=setup(false,false);try{
   expect(await generateNodeVectorBundle(a.db,node.id,a.config,{foreground:true,fetchCached:miss})).toBeGreaterThan(0);
   expect(await generateNodeVectorBundle(b.db,node.id,b.config)).toBeGreaterThan(0);
  }finally{a.db.close();b.db.close();}
 });
 it('rejects an old Worker result even while its frozen config still matches the profile',async()=>{
  const {db,config}=setup();
  db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('metabolism_worker_runtime_revision','7')").run();
  const context=vi.spyOn(workerRuntime,'getMetabolismWorkerRuntimeContext').mockReturnValue({runtimeRevision:7} as never);
  try{
   vi.mocked(getEmbedding).mockImplementationOnce(async()=>{
    db.prepare("UPDATE metadata SET value='8' WHERE key='metabolism_worker_runtime_revision'").run();
    return new Float32Array([1,0,0]);
   });
   expect(await generateNodeVectorBundle(db,node.id,config,{fetchCached:miss})).toBe(0);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0});
  }finally{context.mockRestore();db.close();}
 });
 it('does not touch a closed database after a foreground provider finishes late',async()=>{
  const {db,config}=setup();let release!:(v:Float32Array)=>void;
  try{
   vi.mocked(getEmbedding).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
   const work=generateNodeVectorBundle(db,node.id,config,{foreground:true,fetchCached:miss});
   await new Promise(resolve=>setImmediate(resolve));db.close();
   const prepare=vi.spyOn(db,'prepare');release(new Float32Array([1,0,0]));expect(await work).toBe(0);
   expect(prepare).not.toHaveBeenCalled();prepare.mockRestore();
  }finally{if(db.open)db.close();}
 });
 it.each(['content','profile','partial','abort'] as const)('publishes nothing when %s changes during generation',async mode=>{
  const {db,config,state}=setup();const controller=new AbortController();try{
   vi.mocked(getEmbedding).mockImplementationOnce(async()=>{
    if(mode==='content')db.prepare('UPDATE nodes SET content=? WHERE id=?').run('new text',node.id);
    if(mode==='profile'){const changed={...config,embedding:{...config.embedding,dimensions:4}};activateVectorRuntime(db,{...state,selection:selectEmbeddingProfile(changed,localEmbeddingInstanceId(db))});}
    if(mode==='abort')controller.abort();
    return mode==='partial'?null:new Float32Array([1,0,0]);
   });
   expect(await generateNodeVectorBundle(db,node.id,config,{fetchCached:miss,signal:controller.signal})).toBe(0);
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0});
   expect(db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:0});
  }finally{db.close();}
 });
});
