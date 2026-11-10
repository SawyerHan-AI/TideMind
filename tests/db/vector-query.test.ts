import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {AppConfig} from '../../src/types.js';
const context=vi.hoisted(()=>({config:null as AppConfig|null}));
vi.mock('../../src/config.js',()=>({getConfig:()=>context.config,loadConfig:()=>context.config,reloadConfig:()=>{},getLoadedConfigSourcePath:()=>undefined,getDataDir:()=>'/synthetic'}));
vi.mock('../../src/llm/embedding.js',()=>({getEmbedding:vi.fn(),getEmbeddingCredentialSignal:()=> 'fixture',clearEmbeddingTokenCache:()=>{}}));
import {getEmbedding} from '../../src/llm/embedding.js';
import {ensureSchema} from '../../src/db/schema.js';
import {activateVectorRuntime,commitVectorBundle,localEmbeddingInstanceId} from '../../src/db/vector-cache-store.js';
import {createVectorBundle} from '../../src/embedding/bundle-contract.js';
import {selectEmbeddingProfile} from '../../src/embedding/profile.js';
import {stampVector,vectorSpace} from '../../src/embedding/vector-space.js';
import {getVectorForNode,searchVectors,hasVectors,insertVector} from '../../src/db/vectors.js';
import {getQueryEmbedding} from '../../src/db/vector-query.js';
import {SqliteRepository} from '../../src/db/sqlite-repository.js';
function setup(){
 const db=new Database(':memory:');ensureSchema(db);db.loadExtension(sqliteVec.getLoadablePath());
 const config={embedding:{provider:'gemini',model:'gemini-embedding-001',dimensions:3},gemini:{api_key:'synthetic'},vertex:{project_id:'fixture',region:'us-central1'},ollama:{url:'http://localhost:11434'},metabolism:{background_enabled:true},cloud:{sync_enabled:false}} as unknown as AppConfig;
 context.config=config;
 const state=activateVectorRuntime(db,{selection:selectEmbeddingProfile(config,localEmbeddingInstanceId(db)),accountId:null,syncEnabled:false,backgroundBuilder:true});
 const add=(id:string,vector=new Float32Array([0,1,0]))=>{
  const node={id,content:`Synthetic ${id}`,title:null};
  db.prepare("INSERT INTO nodes(id,type,content,heat,created,updated) VALUES (?,'fact',?,1,datetime('now'),datetime('now'))").run(id,node.content);
  const bundle=createVectorBundle(node,state.selection.profile,[vector]);commitVectorBundle(db,bundle,state,false);return node;
 };
 return {db,config,state,add};
}
beforeEach(()=>vi.mocked(getEmbedding).mockReset().mockResolvedValue(new Float32Array([1,0,0])));
describe('profile-bound semantic retrieval',()=>{
 it('filters unknown, stale and hidden nearest vectors before KNN limit',()=>{
  const {db,state,add}=setup();try{
   add('good');
   for(let i=0;i<12;i++){
    const id=`bad-${i}`;add(id,new Float32Array([1,0,0]));
    if(i%4===0)db.prepare('DELETE FROM vector_bundles WHERE node_id=?').run(id);
    if(i%4===1)db.prepare('UPDATE nodes SET content=? WHERE id=?').run('changed input',id);
    if(i%4===2)db.prepare('UPDATE nodes SET archived=1 WHERE id=?').run(id);
    if(i%4===3)db.prepare("UPDATE metadata SET value='different-profile' WHERE key=?").run(`vector.profile:${id}`);
   }
   const query=stampVector(new Float32Array([1,0,0]),state);
   expect(searchVectors(db,query,1).map(row=>row.id)).toEqual(['good']);
   expect(hasVectors(db)).toBe(true);expect(getVectorForNode(db,'bad-0')).toBeNull();expect(getVectorForNode(db,'bad-1')).toBeNull();
  }finally{db.close();}
 });
 it('returns a verified first segment with its vector-space stamp and rejects unbound queries',()=>{
  const {db,state,add}=setup();try{
   add('good',new Float32Array([1,0,0]));const stored=getVectorForNode(db,'good')!;
   expect(Array.from(stored)).toEqual([1,0,0]);expect(vectorSpace(stored)).toMatchObject({profileId:state.selection.id,epoch:state.epoch,nodeId:'good'});
   expect(searchVectors(db,new Float32Array([1,0,0]),1)).toEqual([]);
   expect(searchVectors(db,stored,1).map(row=>row.id)).toEqual(['good']);
  }finally{db.close();}
 });
 it('rejects a stored source vector after its node changes or becomes hidden',()=>{
  const {db,add}=setup();try{
   add('source',new Float32Array([1,0,0]));add('target');const old=getVectorForNode(db,'source')!;
   db.prepare('UPDATE nodes SET content=? WHERE id=?').run('edited source','source');
   expect(searchVectors(db,old,10)).toEqual([]);
  }finally{db.close();}
 });
 it('does not let a legacy raw write inherit the verified bundle projection stamp',()=>{
  const {db,add}=setup();try{
   add('good');expect(getVectorForNode(db,'good')).not.toBeNull();
   insertVector(db,'good',new Float32Array([1,0,0]));
   expect(getVectorForNode(db,'good')).toBeNull();expect(hasVectors(db)).toBe(false);
  }finally{db.close();}
 });
 it('discards a query result if the model space changes while the provider runs',async()=>{
  const {db,config,state,add}=setup();try{
   add('good');vi.mocked(getEmbedding).mockImplementationOnce(async()=>{
    config.embedding.provider='vertex';activateVectorRuntime(db,{...state,selection:selectEmbeddingProfile(config,localEmbeddingInstanceId(db))});
    return new Float32Array([1,0,0]);
   });
   expect(await getQueryEmbedding(db,'synthetic query')).toBeNull();
  }finally{db.close();}
 });
 it('keeps a query bound to its snapshot and rejects an old stamp after same-dimension switching',async()=>{
  const {db,config,state,add}=setup();try{
   add('good');const query=await getQueryEmbedding(db,'synthetic query');expect(query).not.toBeNull();
   config.embedding.provider='vertex';activateVectorRuntime(db,{...state,selection:selectEmbeddingProfile(config,localEmbeddingInstanceId(db))});
   expect(searchVectors(db,query!,10)).toEqual([]);expect(getVectorForNode(db,'good',vectorSpace(query!))).toBeNull();
  }finally{db.close();}
 });
 it('does not read a closed database when a query provider finishes late',async()=>{
  const {db,add}=setup();let release!:(vector:Float32Array)=>void;
  try{
   add('good');vi.mocked(getEmbedding).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
   const pending=getQueryEmbedding(db,'synthetic');db.close();
   const prepare=vi.spyOn(db,'prepare');release(new Float32Array([1,0,0]));expect(await pending).toBeNull();
   expect(prepare).not.toHaveBeenCalled();prepare.mockRestore();
  }finally{if(db.open)db.close();}
 });
 it('fails closed on an old schema without opening or migrating it',async()=>{
  const db=new Database(':memory:');try{
   db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES ('schema_version','47')");
   expect(getVectorForNode(db,'old')).toBeNull();expect(hasVectors(db)).toBe(false);
   expect(searchVectors(db,new Float32Array([1,0,0]),1)).toEqual([]);
   expect(await getQueryEmbedding(db,'synthetic')).toBeNull();expect(getEmbedding).not.toHaveBeenCalled();
   expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'metadata'}]);
  }finally{db.close();}
 });
 it('performs an initialized query without preparing any write statement',async()=>{
  const {db,add}=setup();try{
   add('good');const original=db.prepare.bind(db);
   const prepare=vi.spyOn(db,'prepare').mockImplementation((sql:string)=>{
    expect(sql.trim()).not.toMatch(/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i);
    return original(sql);
   });
   expect(await new SqliteRepository(db).vectors.embedQuery('synthetic')).not.toBeNull();prepare.mockRestore();
  }finally{db.close();}
 });
 it('does not call a model when no compatible projected data can be searched',async()=>{
  const {db}=setup();try{const repo=new SqliteRepository(db);expect(await repo.vectors.embedQuery('synthetic')).toBeNull();expect(getEmbedding).not.toHaveBeenCalled();}finally{db.close();}
 });
});
