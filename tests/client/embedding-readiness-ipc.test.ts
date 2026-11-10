import {describe,it,expect,vi,beforeEach} from 'vitest';
const fixture=vi.hoisted(()=>({handlers:new Map<string,()=>unknown>(),bootstrap:false}));
vi.mock('../../client/node_modules/electron/index.js',()=>({ipcMain:{handle:(name:string,handler:()=>unknown)=>fixture.handlers.set(name,handler)}}));
vi.mock('../../client/electron/sync-bootstrap.js',()=>({isSyncBootstrapCheck:()=>fixture.bootstrap}));
vi.mock('@server/db/vectors.js',()=>({getReembedProgress:()=>({running:false,done:10,total:10}),reembedAllNodes:vi.fn(async()=>false)}));
vi.mock('@server/db/vector-readiness.js',()=>({getVectorReadiness:()=>({mode:'waiting_generation',eligible:10,ready:4,missing:6,failed:0,queued:0,uploadFailed:0})}));
import {reembedAllNodes} from '@server/db/vectors.js';
import {registerEmbeddingHandlers} from '../../client/electron/ipc/embedding.js';
import type Database from 'better-sqlite3';
beforeEach(()=>{fixture.bootstrap=false;fixture.handlers.clear();vi.mocked(reembedAllNodes).mockClear();registerEmbeddingHandlers({} as Database.Database);});
describe('embedding readiness IPC',()=>{
 it('exposes real coverage independently of completed traversal',()=>{
  expect(fixture.handlers.get('embedding:reembed-status')!()).toMatchObject({needed:true,done:10,total:10,canRebuild:true,coverage:{ready:4,missing:6}});
 });
 it('returns incomplete instead of success after a failed rebuild',async()=>{
  expect(await fixture.handlers.get('embedding:trigger-reembed')!()).toEqual({success:false,error:'embedding_incomplete'});
 });
 it('blocks manual generation in bootstrap at the IPC boundary',async()=>{
  fixture.bootstrap=true;
  expect(fixture.handlers.get('embedding:reembed-status')!()).toMatchObject({canRebuild:false});
  expect(await fixture.handlers.get('embedding:trigger-reembed')!()).toEqual({success:false,error:'sync_bootstrap_active'});
  expect(reembedAllNodes).not.toHaveBeenCalled();
 });
});
