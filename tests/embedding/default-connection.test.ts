import Database from 'better-sqlite3';
import {describe,it,expect,vi} from 'vitest';
import type {AppConfig} from '../../src/types.js';
const state=vi.hoisted(()=>({db:null as Database.Database|null,config:null as AppConfig|null}));
vi.mock('../../src/config.js',()=>({getConfig:()=>state.config,getDataDir:()=>'/synthetic'}));
vi.mock('../../src/db/connection.js',()=>({getExistingDb:()=>state.db}));
import {ensureSchema} from '../../src/db/schema.js';
import {createConnection} from '../../src/db/connections.js';
import {getEmbedding} from '../../src/llm/embedding.js';
describe('default embedding callers use the selected connection',()=>{
 it('routes availability-style requests to selected credentials and rejects archived selection',async()=>{
  const db=new Database(':memory:');state.db=db;
  const fetch=vi.fn(async()=>new Response(JSON.stringify({embedding:{values:[0.6,0.8]}}),{headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetch);
  try{
   ensureSchema(db);const selected=createConnection(db,{name:'Synthetic',provider_type:'gemini',credentials:{api_key:'selected-synthetic'}});
   state.config={embedding:{provider:'gemini',connection:selected.id,model:'gemini-embedding-001',dimensions:2},gemini:{api_key:'legacy-synthetic'}} as AppConfig;
   expect((await getEmbedding('test'))?.length).toBe(2);
   expect((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].headers).toMatchObject({'x-goog-api-key':'selected-synthetic'});
   db.prepare('UPDATE model_connections SET archived=1 WHERE id=?').run(selected.id);fetch.mockClear();
   expect(await getEmbedding('test')).toBeNull();expect(fetch).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();db.close();state.db=null;}
 });
});
