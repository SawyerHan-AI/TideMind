import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../client/electron/cloud/auth-client.js',()=>({getCloudAuth:()=>null,getCloudBaseUrl:()=> 'https://fixture.invalid',refreshTokenIfNeeded:async()=>null}))
vi.mock('../../src/llm/embedding.js',()=>({getEmbedding:vi.fn(),getEmbeddingCredentialSignal:()=> 'fixture',clearEmbeddingTokenCache:()=>{}}))
import { getEmbedding } from '../../src/llm/embedding.js'
import { DesktopVectorSync, type VectorSyncDependencies } from '../../client/electron/cloud/vector-sync.js'
import { refreshDesktopVectorRuntime } from '../../client/electron/cloud/vector-runtime.js'
import { applyCloudNodeRow } from '../../client/electron/cloud/local-apply.js'
import { ensureSchema } from '../../src/db/schema.js'
import { createVectorBundle, type VectorBundle } from '../../src/embedding/bundle-contract.js'
import { acknowledgeVectorUpload, commitVectorBundle, readCompatibleVectorBundle, readVectorRuntime, type VectorRuntimeState } from '../../src/db/vector-cache-store.js'
import type { AppConfig } from '../../src/types.js'
import type { PendingVectorUpload, VectorCacheKey } from '../../client/electron/cloud/vector-cache-client.js'
const node={id:'a',content:'Synthetic shared memory.',title:null}
const key=(b:VectorBundle)=>({nodeId:b.nodeId,inputHash:b.inputHash,profileId:b.profileId})
function setup(builder:boolean,remote=new Map<string,VectorBundle>()){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath())
 db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES (?,'fact',?,datetime('now'),datetime('now'))").run(node.id,node.content)
 const config={embedding:{provider:'gemini',model:'ignored-alias',dimensions:3},gemini:{api_key:'synthetic'},vertex:{region:'us-central1'},ollama:{url:'http://localhost:11434'},cloud:{sync_enabled:true},metabolism:{background_enabled:builder}} as unknown as AppConfig
 const clients:Array<{lookup:ReturnType<typeof vi.fn>;download:ReturnType<typeof vi.fn>;uploadPending:ReturnType<typeof vi.fn>;dispose:ReturnType<typeof vi.fn>}> = []
 const deps:VectorSyncDependencies={config:()=>config,accountId:()=> 'account-a',allowGeneration:()=>true,client:()=>{
  const client={
   lookup:vi.fn(async(keys:VectorCacheKey[])=>keys.flatMap(k=>{const b=remote.get(k.nodeId);return b&&b.inputHash===k.inputHash&&b.profileId===k.profileId?[{...key(b),checksum:b.checksum}]:[]})),
   download:vi.fn(async(k:VectorCacheKey)=>{const b=remote.get(k.nodeId);return b&&b.inputHash===k.inputHash&&b.profileId===k.profileId?b:null}),
   uploadPending:vi.fn(async(sent:PendingVectorUpload,state:VectorRuntimeState)=>{
    const local=JSON.parse(sent.payloadJson) as VectorBundle
    const authority=remote.get(sent.nodeId)??local;remote.set(sent.nodeId,authority)
    return authority.checksum===sent.checksum?acknowledgeVectorUpload(db,state,sent):commitVectorBundle(db,authority,state,false,sent)
   }),dispose:vi.fn(),
  };clients.push(client);return client
 }}
 const owner=new DesktopVectorSync(db,deps)
 return {db,owner,deps,config,remote,clients}
}
beforeEach(()=>{vi.mocked(getEmbedding).mockReset().mockResolvedValue(new Float32Array([1,0,0]))})
describe('desktop vector sync owner',()=>{
 it('generates on the builder and transfers to a non-builder without a second model call',async()=>{
  const a=setup(true);const b=setup(false,a.remote)
  try{
   await a.owner.runBatch();expect(getEmbedding).toHaveBeenCalledTimes(1)
   await a.owner.runBatch();expect(a.remote.size).toBe(1)
   await b.owner.runBatch();expect(getEmbedding).toHaveBeenCalledTimes(1)
   expect(readCompatibleVectorBundle(b.db,node.id,readVectorRuntime(b.db)!)).toEqual(a.remote.get(node.id))
  }finally{a.owner.dispose();b.owner.dispose();a.db.close();b.db.close()}
 })
 it('advances past a non-builder cache miss rather than starving later nodes',async()=>{
  const s=setup(false);try{
   const state=(await s.owner.prepare())!
   s.db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('z','fact','Later synthetic',datetime('now'),datetime('now'))").run()
   const later=createVectorBundle({id:'z',content:'Later synthetic',title:null},state.selection.profile,[new Float32Array([0,1,0])])
   s.remote.set('z',later);await s.owner.runBatch()
   expect(getEmbedding).not.toHaveBeenCalled();expect(readCompatibleVectorBundle(s.db,'z',readVectorRuntime(s.db)!)).toEqual(later)
  }finally{s.owner.dispose();s.db.close()}
 })
 it('does not clear a newer pending upload with an older lookup response',async()=>{
  const s=setup(false);try{
   const state=(await s.owner.prepare())!
   const old=createVectorBundle(node,state.selection.profile,[new Float32Array([1,0,0])])
   const authority=createVectorBundle(node,state.selection.profile,[new Float32Array([0,1,0])])
   const newer=createVectorBundle(node,state.selection.profile,[new Float32Array([0,0,1])])
   commitVectorBundle(s.db,old,state,true);s.db.prepare('UPDATE vector_upload_queue SET retry_after=?').run(Date.now()+60_000)
   s.remote.set(node.id,authority)
   s.clients[0].download.mockImplementationOnce(async()=>{commitVectorBundle(s.db,newer,state,true);return authority})
   await s.owner.runBatch()
   expect(s.db.prepare('SELECT checksum FROM vector_upload_queue').get()).toEqual({checksum:newer.checksum})
   expect(readCompatibleVectorBundle(s.db,node.id,state)).toEqual(newer)
  }finally{s.owner.dispose();s.db.close()}
 })
 it('an older owner cannot invalidate the replacement owner during disposal',async()=>{
  const s=setup(false);const next=new DesktopVectorSync(s.db,s.deps)
  try{
   const first=(await s.owner.prepare())!;const second=(await next.prepare())!
   expect(first.epoch).not.toBe(second.epoch);s.owner.dispose()
   expect(readVectorRuntime(s.db)?.epoch).toBe(second.epoch)
   await next.runBatch();expect(getEmbedding).not.toHaveBeenCalled()
  }finally{s.owner.dispose();next.dispose();s.db.close()}
 })
 it('stops before touching SQLite after a late download and database close',async()=>{
  const s=setup(false);let release!:(value:VectorBundle)=>void;let entered!:()=>void
  const ready=new Promise<void>(resolve=>{entered=resolve})
  try{
   const state=(await s.owner.prepare())!;const remote=createVectorBundle(node,state.selection.profile,[new Float32Array([1,0,0])]);s.remote.set(node.id,remote)
   s.clients[0].download.mockImplementationOnce(()=>new Promise<VectorBundle>(resolve=>{release=resolve;entered()}))
   const work=s.owner.runBatch();await ready;s.owner.dispose();s.db.close()
   const prepare=vi.spyOn(s.db,'prepare');release(remote);await work;expect(prepare).not.toHaveBeenCalled();prepare.mockRestore()
  }finally{s.owner.dispose();if(s.db.open)s.db.close()}
 })
 it('drops old work after a configuration epoch change during generation',async()=>{
  const s=setup(true);try{
   vi.mocked(getEmbedding).mockImplementationOnce(async()=>{s.config.embedding.dimensions=4;await refreshDesktopVectorRuntime(s.db,s.deps);return new Float32Array([1,0,0])})
   await s.owner.runBatch()
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0})
  }finally{s.owner.dispose();s.db.close()}
 })
 it('keeps requested cloud mode waiting when authentication is unavailable',async()=>{
  const s=setup(false);s.deps.accountId=()=>null
  try{
   const state=await s.owner.prepare()
   expect(state).toMatchObject({syncEnabled:false,awaitingDesktopAuth:true,accountId:null})
   await s.owner.runBatch();expect(getEmbedding).not.toHaveBeenCalled()
  }finally{s.owner.dispose();s.db.close()}
 })
 it('generates an unshareable local profile without creating a cloud client',async()=>{
  const s=setup(false);s.config.embedding.provider='ollama';s.config.embedding.model='synthetic-local'
  try{
   await s.owner.runBatch()
   expect(s.clients).toHaveLength(0);expect(getEmbedding).toHaveBeenCalledTimes(1)
   expect(readCompatibleVectorBundle(s.db,node.id,readVectorRuntime(s.db)!)).not.toBeNull()
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:0})
  }finally{s.owner.dispose();s.db.close()}
 })
 it('continues to a valid node after an oversized first node',async()=>{
  const s=setup(true);try{
   s.db.prepare('UPDATE nodes SET content=? WHERE id=?').run('x'.repeat(60_000),node.id)
   s.db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('z','fact','Valid synthetic',datetime('now'),datetime('now'))").run()
   await s.owner.runBatch()
   expect(getEmbedding).toHaveBeenCalledTimes(1)
   expect(readCompatibleVectorBundle(s.db,'z',readVectorRuntime(s.db)!)).not.toBeNull()
  }finally{s.owner.dispose();s.db.close()}
 })
 it('node-level retry stops a repeatedly failing first node from starving later nodes',async()=>{
  const s=setup(true);let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now)
  try{
   s.db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('z','fact','Valid synthetic',datetime('now'),datetime('now'))").run()
   vi.mocked(getEmbedding).mockImplementation(async text=>text===node.content?null:new Float32Array([1,0,0]))
   await s.owner.runBatch();await s.owner.runBatch();now+=61_000;await s.owner.runBatch()
   expect(readCompatibleVectorBundle(s.db,'z',readVectorRuntime(s.db)!)).not.toBeNull()
  }finally{clock.mockRestore();s.owner.dispose();s.db.close()}
 })
 it('allows foreground local Ollama generation while cloud authentication is absent',async()=>{
  const s=setup(false);s.config.embedding.provider='ollama';s.config.embedding.model='synthetic-local';s.deps.accountId=()=>null
  try{
   const state=await s.owner.prepare();expect(state?.awaitingDesktopAuth).toBe(false)
   const {generateNodeVectorBundle}=await import('../../src/embedding/generate-node.js')
   expect(await generateNodeVectorBundle(s.db,node.id,s.config,{foreground:true})).toBe(1)
   expect(s.clients).toHaveLength(0)
  }finally{s.owner.dispose();s.db.close()}
 })
 it('rotates past a node whose provider output throws bundle validation',async()=>{
  const s=setup(true);let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now)
  try{
   s.db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('z','fact','Valid synthetic',datetime('now'),datetime('now'))").run()
   vi.mocked(getEmbedding).mockImplementation(async text=>text===node.content?new Float32Array([0,0,0]):new Float32Array([1,0,0]))
   await s.owner.runBatch();await s.owner.runBatch();now+=61_000;await s.owner.runBatch()
   expect(readCompatibleVectorBundle(s.db,'z',readVectorRuntime(s.db)!)).not.toBeNull()
  }finally{clock.mockRestore();s.owner.dispose();s.db.close()}
 })
 it('reuses checked remote availability without rewriting a ready index or extending its proof',async()=>{
  const s=setup(false);let clock:ReturnType<typeof vi.spyOn>|undefined
  try{
   const state=(await s.owner.prepare())!;const b=createVectorBundle(node,state.selection.profile,[new Float32Array([1,0,0])]);s.remote.set(node.id,b)
   await s.owner.runBatch();await s.owner.runBatch()
   const proof=s.db.prepare("SELECT value FROM metadata WHERE key LIKE 'vector.remote_receipt:%'").get()
   s.db.exec('CREATE TABLE fixture_writes(n INTEGER); INSERT INTO fixture_writes VALUES(0); CREATE TRIGGER count_bundle_write AFTER UPDATE ON vector_bundles BEGIN UPDATE fixture_writes SET n=n+1; END')
   clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+60_000)
   s.owner.kick(true);await new Promise(resolve=>setImmediate(resolve))
   expect(s.clients[0].lookup).toHaveBeenCalledTimes(1)
   expect(s.db.prepare('SELECT n FROM fixture_writes').get()).toEqual({n:0})
   expect(s.db.prepare("SELECT value FROM metadata WHERE key LIKE 'vector.remote_receipt:%'").get()).toEqual(proof)
  }finally{clock?.mockRestore();s.owner.dispose();s.db.close()}
 })
 it('invalidates a checked receipt after a newer cloud content version even when text returns to the same value',async()=>{
  const s=setup(false);try{
   const state=(await s.owner.prepare())!;const b=createVectorBundle(node,state.selection.profile,[new Float32Array([1,0,0])]);s.remote.set(node.id,b)
   await s.owner.runBatch();await s.owner.runBatch()
   applyCloudNodeRow(s.db,{...node,type:'fact',edit_seq:2,updated:'2099-01-01T00:00:00Z',created:'2026-01-01T00:00:00Z'})
   expect(s.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'vector.remote_receipt:%'").get()).toEqual({n:0})
   s.remote.delete(node.id);s.owner.kick(true);await new Promise(resolve=>setImmediate(resolve))
   expect(s.clients[0].lookup).toHaveBeenCalledTimes(2)
   expect(getEmbedding).not.toHaveBeenCalled()
  }finally{s.owner.dispose();s.db.close()}
 })
 it('does not reuse old endpoint receipts and recreates transport when the endpoint changes',async()=>{
  const s=setup(false);try{
   const first=(await s.owner.prepare())!;const b=createVectorBundle(node,first.selection.profile,[new Float32Array([1,0,0])]);s.remote.set(node.id,b)
   await s.owner.runBatch();await s.owner.runBatch()
   s.config.cloud!.server_url='https://changed-fixture.invalid';s.remote.clear()
   const next=(await s.owner.prepare())!;expect(next.epoch).not.toBe(first.epoch);expect(next.endpointId).not.toBe(first.endpointId)
   await s.owner.runBatch()
   expect(s.clients).toHaveLength(2);expect(s.clients[0].dispose).toHaveBeenCalledTimes(1);expect(s.clients[1].lookup).toHaveBeenCalledTimes(1)
   expect(s.db.prepare('SELECT endpoint_id FROM vector_upload_queue').get()).toEqual({endpoint_id:next.endpointId})
   expect(getEmbedding).not.toHaveBeenCalled()
  }finally{s.owner.dispose();s.db.close()}
 })
 it.each(['lookup','download'] as const)('does not recreate a proof from a late %s after a local A-to-B-to-A change',async stage=>{
  const s=setup(false);try{
   const state=(await s.owner.prepare())!;const b=createVectorBundle(node,state.selection.profile,[new Float32Array([1,0,0])]);s.remote.set(node.id,b)
   const change=()=>{s.db.prepare('UPDATE nodes SET content=? WHERE id=?').run('intermediate',node.id);s.db.prepare('UPDATE nodes SET content=? WHERE id=?').run(node.content,node.id)}
   if(stage==='lookup')s.clients[0].lookup.mockImplementationOnce(async()=>{change();return[{...key(b),checksum:b.checksum}]})
   else s.clients[0].download.mockImplementationOnce(async()=>{change();return b})
   await s.owner.runBatch()
   expect(s.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key GLOB 'vector.remote_receipt:*'").get()).toEqual({n:0})
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0})
  }finally{s.owner.dispose();s.db.close()}
 })
 it('invalidates local A-to-B-to-A proofs even if the later cloud echo exactly matches local version',async()=>{
  const s=setup(false);try{
   const state=(await s.owner.prepare())!;const b=createVectorBundle(node,state.selection.profile,[new Float32Array([1,0,0])]);s.remote.set(node.id,b)
   await s.owner.runBatch();await s.owner.runBatch()
   s.db.prepare('UPDATE nodes SET content=? WHERE id=?').run('intermediate',node.id)
   s.db.prepare('UPDATE nodes SET content=? WHERE id=?').run(node.content,node.id)
   const echo=s.db.prepare('SELECT * FROM nodes WHERE id=?').get(node.id) as Record<string,unknown>;applyCloudNodeRow(s.db,echo)
   expect(s.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key GLOB 'vector.remote_receipt:*'").get()).toEqual({n:0})
   s.remote.clear();s.owner.kick(true);await new Promise(resolve=>setImmediate(resolve))
   expect(s.clients[0].lookup).toHaveBeenCalledTimes(2)
  }finally{s.owner.dispose();s.db.close()}
 })
 it('revokes the latest published epoch on dispose even before the owner prepares it',async()=>{
  const s=setup(true);let release!:(v:Float32Array)=>void;let entered!:()=>void
  const ready=new Promise<void>(resolve=>{entered=resolve})
  try{
   const first=(await s.owner.prepare())!;s.config.metabolism.background_enabled=false
   const published=(await refreshDesktopVectorRuntime(s.db,s.deps))!;expect(published.epoch).not.toBe(first.epoch)
   const {generateNodeVectorBundle}=await import('../../src/embedding/generate-node.js')
   vi.mocked(getEmbedding).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered()}))
   const generation=generateNodeVectorBundle(s.db,node.id,s.config,{foreground:true,fetchCached:async()=>null})
   await ready;s.owner.dispose();release(new Float32Array([1,0,0]));expect(await generation).toBe(0)
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_bundles').get()).toEqual({n:0})
  }finally{s.owner.dispose();s.db.close()}
 })
 it('bootstrap downloads remain enabled but missing data does not invoke a model',async()=>{
  const s=setup(true);s.deps.allowGeneration=()=>false
  try{await s.owner.runBatch();expect(getEmbedding).not.toHaveBeenCalled()}
  finally{s.owner.dispose();s.db.close()}
 })
})
