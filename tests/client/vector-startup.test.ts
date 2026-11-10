import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import {describe,it,expect,vi} from 'vitest'
const fixture=vi.hoisted(()=>({start:vi.fn(async()=>{}),create:vi.fn(),config:{embedding:{provider:'gemini',model:'gemini-embedding-001',dimensions:3,connection:'mc_12345678'},gemini:{api_key:''},vertex:{region:'us-central1'},ollama:{url:'http://localhost:11434'},cloud:{sync_enabled:true},metabolism:{background_enabled:true}}}))
vi.mock('../../client/electron/cloud/auth-client.js',()=>({isLoggedIn:()=>true,getCloudAuth:()=>({userId:'fixture-user'})}))
vi.mock('../../client/electron/cloud/sync-client.js',()=>({getCloudSyncClient:()=>null,createCloudSyncClient:(db:unknown)=>{fixture.create(db);return{start:fixture.start}}}))
vi.mock('../../src/config.js',()=>({getConfig:()=>fixture.config}))
vi.mock('../../src/llm/embedding.js',()=>({getEmbedding:vi.fn(async()=>new Float32Array([1,0,0])),getEmbeddingCredentialSignal:()=> 'fixture',clearEmbeddingTokenCache:()=>{}}))
import {getEmbedding} from '../../src/llm/embedding.js'
import {insertSegmentVectors} from '../../src/db/vectors.js'
import {ensureSchema} from '../../src/db/schema.js'
import {refreshDesktopVectorRuntime} from '../../client/electron/cloud/vector-runtime.js'
import {startCloudSyncIfConfigured} from '../../client/electron/cloud/startup.js'
describe('embedding failure never blocks basic cloud startup',()=>{
 it.each(['missing','archived'])('starts node sync with a %s selected embedding connection',async mode=>{
  const db=new Database(':memory:');fixture.create.mockClear();fixture.start.mockClear()
  try{
   ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath())
   if(mode==='archived'){
    db.prepare("INSERT INTO model_connections(id,name,provider_type,credentials,archived,created) VALUES ('mc_12345678','Fixture','gemini','{}',0,datetime('now'))").run()
    expect(await refreshDesktopVectorRuntime(db)).not.toBeNull()
    db.prepare("UPDATE model_connections SET archived=1 WHERE id='mc_12345678'").run()
   }
   db.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('fixture','fact','synthetic',datetime('now'),datetime('now'))").run()
   await expect(startCloudSyncIfConfigured(db)).resolves.toBeUndefined()
   expect(fixture.create).toHaveBeenCalledWith(db);expect(fixture.start).toHaveBeenCalledTimes(1)
   vi.mocked(getEmbedding).mockClear()
   expect(await insertSegmentVectors(db,'fixture','synthetic')).toBe(0)
   expect(getEmbedding).not.toHaveBeenCalled()
   expect(db.prepare("SELECT value FROM metadata WHERE key='vector.runtime_error'").get()).toEqual({value:'embedding_configuration_unavailable'})
  }finally{db.close()}
 })
})
