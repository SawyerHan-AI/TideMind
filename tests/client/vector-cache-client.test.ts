import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../client/electron/cloud/auth-client.js',()=>({getCloudAuth:()=>null,getCloudBaseUrl:()=> 'https://fixture.invalid',refreshTokenIfNeeded:async()=>null}))
import { VectorCacheClient, type PendingVectorUpload } from '../../client/electron/cloud/vector-cache-client.js'
import { ensureSchema } from '../../src/db/schema.js'
import * as vectorStore from '../../src/db/vector-cache-store.js'
import { activateVectorRuntime, commitVectorBundle, readCompatibleVectorBundle } from '../../src/db/vector-cache-store.js'
import { createVectorBundle, embeddingProfileId, type EmbeddingProfile } from '../../src/embedding/bundle-contract.js'
import { EMBEDDING_INPUT_VERSION, EMBEDDING_SEGMENT_VERSION } from '../../src/embedding/input-contract.js'
const profile:EmbeddingProfile={version:1,provider:'fixture',model:'fixture-v1',revision:null,serviceIdentity:'a'.repeat(64),dimensions:3,requestOptions:{},normalization:'l2-f32-v1',inputVersion:EMBEDDING_INPUT_VERSION,segmentVersion:EMBEDDING_SEGMENT_VERSION}
const node={id:'fixture-node',content:'Synthetic memory.',title:null}
const key=(b:{nodeId:string;inputHash:string;profileId:string})=>({nodeId:b.nodeId,inputHash:b.inputHash,profileId:b.profileId})
const receipt=(b:ReturnType<typeof createVectorBundle>)=>({...key(b),checksum:b.checksum})
const response=(result:unknown)=>new Response(JSON.stringify({result}),{headers:{'Content-Type':'application/json'}})
function setup(){
 const db=new Database(':memory:');ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath())
 db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES (?,'fact',?,datetime('now'),datetime('now'))").run(node.id,node.content)
 const runtime=activateVectorRuntime(db,{selection:{profile,id:embeddingProfileId(profile),shareable:true},accountId:'account-a',syncEnabled:true,backgroundBuilder:true})
 const bundle=createVectorBundle(node,profile,[new Float32Array([1,0,0])]);commitVectorBundle(db,bundle,runtime,true)
 const identity={accountId:'account-a',...key(bundle),checksum:bundle.checksum,payloadJson:JSON.stringify(bundle)} satisfies PendingVectorUpload
 const current={account:'account-a',enabled:true,baseUrl:'https://fixture.invalid'}
 const transport=vi.fn<typeof fetch>()
 const token=vi.fn(async()=> 'synthetic-access-token')
 const client=new VectorCacheClient(db,{accountId:()=>current.account,enabled:()=>current.enabled,token,baseUrl:()=> current.baseUrl,fetch:transport})
 return {db,runtime,bundle,identity,current,transport,token,client}
}
describe('authenticated vector cache transport',()=>{
 it('sends the exact durable snapshot and acknowledges its identity without storing the token',async()=>{
  const s=setup();try{
   s.transport.mockResolvedValue(response(receipt(s.bundle)))
   expect(await s.client.uploadPending(s.identity,s.runtime)).toBe(true)
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:0})
   const request=s.transport.mock.calls[0][1]!
   expect(JSON.parse(String(request.body))).toEqual(s.bundle)
   expect(request.redirect).toBe('error')
   expect(s.db.prepare('SELECT bundle_json FROM vector_bundles').get()).not.toEqual(expect.objectContaining({bundle_json:expect.stringContaining('synthetic-access-token')}))
  }finally{s.client.dispose();s.db.close()}
 })
 it('adopts the cloud first-writer bytes and clears the old pending item atomically',async()=>{
  const s=setup();try{
   const authority=createVectorBundle(node,profile,[new Float32Array([0,1,0])])
   s.transport.mockResolvedValueOnce(response(receipt(authority))).mockResolvedValueOnce(response(authority))
   expect(await s.client.uploadPending(s.identity,s.runtime)).toBe(true)
   expect(readCompatibleVectorBundle(s.db,node.id,s.runtime)).toEqual(authority)
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:0})
   expect(JSON.parse(String(s.transport.mock.calls[1][1]!.body))).toEqual(key(authority))
  }finally{s.client.dispose();s.db.close()}
 })
 it('does not clear a newer queued input when an old upload finishes',async()=>{
  const s=setup();try{
   const freshNode={...node,content:'New synthetic text.'}
   const newer=createVectorBundle(freshNode,profile,[new Float32Array([0,1,0])])
   s.transport.mockImplementationOnce(async()=>{
    s.db.prepare('UPDATE nodes SET content=? WHERE id=?').run(freshNode.content,node.id)
    commitVectorBundle(s.db,newer,s.runtime,true)
    return response(receipt(s.bundle))
   })
   expect(await s.client.uploadPending(s.identity,s.runtime)).toBe(false)
   expect(s.db.prepare('SELECT checksum FROM vector_upload_queue').get()).toEqual({checksum:newer.checksum})
  }finally{s.client.dispose();s.db.close()}
 })
 it.each(['enabled','endpoint'] as const)('rechecks %s inside the receipt transaction',async change=>{
  const s=setup();const original=vectorStore.acknowledgeVectorUpload;
  const ack=vi.spyOn(vectorStore,'acknowledgeVectorUpload').mockImplementation((db,runtime,sent,fence)=>{
   if(change==='enabled')s.current.enabled=false;else s.current.baseUrl='https://changed-fixture.invalid'
   return original(db,runtime,sent,fence)
  })
  try{
   s.transport.mockResolvedValue(response(receipt(s.bundle)))
   expect(await s.client.uploadPending(s.identity,s.runtime)).toBe(false)
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:1})
  }finally{ack.mockRestore();s.client.dispose();s.db.close()}
 })
 it.each(['token','response'] as const)('rejects an account change during %s',async stage=>{
  const s=setup();try{
   const change=()=>{s.current.account='account-b';activateVectorRuntime(s.db,{...s.runtime,accountId:'account-b'})}
   if(stage==='token')s.token.mockImplementationOnce(async()=>{change();return 'old-token'})
   else s.transport.mockImplementationOnce(async()=>{change();return response(receipt(s.bundle))})
   await expect(s.client.uploadPending(s.identity,s.runtime)).rejects.toMatchObject({kind:'stale'})
   expect(s.db.prepare('SELECT account_id FROM vector_upload_queue').get()).toEqual({account_id:'account-a'})
   if(stage==='token')expect(s.transport).not.toHaveBeenCalled()
  }finally{s.client.dispose();s.db.close()}
 })
 it.each(['node','endpoint'] as const)('rechecks %s after token refresh, before HTTP submission',async change=>{
  const s=setup();try{
   s.token.mockImplementationOnce(async()=>{
    if(change==='node')s.db.prepare('UPDATE nodes SET archived=1 WHERE id=?').run(node.id)
    else s.current.baseUrl='https://another-fixture.invalid'
    return 'synthetic-token'
   })
   await expect(s.client.uploadPending(s.identity,s.runtime)).rejects.toMatchObject({kind:'stale'})
   expect(s.transport).not.toHaveBeenCalled()
  }finally{s.client.dispose();s.db.close()}
 })
 it('aborts an in-flight fetch when disposed',async()=>{
  const s=setup();try{
   s.transport.mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>{
    options!.signal!.addEventListener('abort',()=>reject(new Error('fixture aborted')),{once:true})
   }))
   const pending=s.client.lookup([key(s.bundle)],s.runtime)
   const rejected=expect(pending).rejects.toThrow('fixture aborted')
   await new Promise(resolve=>setImmediate(resolve))
   s.client.dispose();await rejected
  }finally{s.client.dispose();s.db.close()}
 })
 it.each(['token','response','body'] as const)('does not touch a closed database when a late %s finishes after dispose',async stage=>{
  const s=setup();let release!:()=>void;let prepare:ReturnType<typeof vi.spyOn>|undefined;
  try{
   if(stage==='token')s.token.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve('late-token')}))
   if(stage==='response')s.transport.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(response(receipt(s.bundle)))}))
   if(stage==='body')s.transport.mockResolvedValueOnce(new Response(new ReadableStream({start(controller){
    release=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({result:receipt(s.bundle)})));controller.close()}
   }})))
   const pending=s.client.uploadPending(s.identity,s.runtime)
   const rejected=expect(pending).rejects.toMatchObject({kind:'stale'})
   await new Promise(resolve=>setImmediate(resolve))
   s.client.dispose();s.db.close()
   prepare=vi.spyOn(s.db,'prepare')
   release();await rejected
   expect(prepare).not.toHaveBeenCalled()
  }finally{prepare?.mockRestore();s.client.dispose();if(s.db.open)s.db.close()}
 })
 it.each([false,'',{}])('rejects malformed download result %j instead of reporting a cache miss',async invalid=>{
  const s=setup();try{
   s.transport.mockResolvedValueOnce(response(invalid))
   await expect(s.client.download(key(s.bundle),s.runtime)).rejects.toMatchObject({kind:'protocol'})
  }finally{s.client.dispose();s.db.close()}
 })
 it('rejects wrong-node responses and oversized streamed bodies',async()=>{
  const s=setup();try{
   const other=createVectorBundle({...node,id:'other'},profile,[new Float32Array([1,0,0])])
   s.transport.mockResolvedValueOnce(response(other))
   await expect(s.client.download(key(s.bundle),s.runtime)).rejects.toMatchObject({kind:'protocol'})
   s.transport.mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4*1024**2+1));controller.close()}})))
   await expect(s.client.download(key(s.bundle),s.runtime)).rejects.toMatchObject({kind:'protocol'})
   expect(readCompatibleVectorBundle(s.db,node.id,s.runtime)).toEqual(s.bundle)
  }finally{s.client.dispose();s.db.close()}
 })
 it('keeps the pending snapshot on HTTP failure and blocks disabled sync before sending',async()=>{
  const s=setup();try{
   s.transport.mockResolvedValueOnce(new Response('synthetic private error',{status:409}))
   await expect(s.client.uploadPending(s.identity,s.runtime)).rejects.toMatchObject({kind:'http',status:409})
   expect(s.db.prepare('SELECT COUNT(*) AS n FROM vector_upload_queue').get()).toEqual({n:1})
   s.current.enabled=false;s.transport.mockClear()
   await expect(s.client.lookup([key(s.bundle)],s.runtime)).rejects.toMatchObject({kind:'stale'})
   expect(s.transport).not.toHaveBeenCalled()
  }finally{s.client.dispose();s.db.close()}
 })
})
