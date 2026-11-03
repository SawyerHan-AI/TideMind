
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {describe,it,expect} from 'vitest'
import {ensureSchema} from '../src/db/schema'
import {createContextRestoreStore,contextRestoreKey,CONTEXT_RESTORE_RECORD_MS} from '../src/hook-codex-context-restore'
import {recordCodexPostCompactCapture,codexRestoreCaptureFileName} from '../src/hook-codex-restore-capture'
import {sha256Json} from '../client/electron/agent-integration/fingerprint'

describe('Codex restore exact state and opt-in sidecar',()=>{
 it('reads delivered state without writes and rejects expired or invalid records',()=>{
  const db=new Database(':memory:');ensureSchema(db)
  try {
   let now=1000;const store=createContextRestoreStore(db,{now:()=>now})
   const scope={canonicalDataDir:'/fixture',agentId:'agent',generation:'token',sessionId:'session'}
   store.markPending(scope);const claim=store.claimPending(scope,'turn')!;store.markEmitted(scope,claim)
   const changes=db.prepare('SELECT total_changes() AS n').get()
   expect(store.readPending(scope)).toBeNull();expect(store.readState(scope)?.deliveredRevision).toBe(1)
   expect(store.readState({...scope,sessionId:'different'})).toBeNull()
   expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
   now+=CONTEXT_RESTORE_RECORD_MS+1;expect(store.readState(scope)).toBeNull()
   db.prepare('UPDATE metadata SET value=? WHERE key=?').run('{}',contextRestoreKey(scope))
   expect(store.readState(scope)).toBeNull()
  }finally{db.close()}
 })
 it('writes exactly the whitelisted explicit nonce observation and never defaults trigger',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'restore-capture-'))
  try{
   const scope={canonicalDataDir:'/fixture',agentId:'agent',generation:'SECRET_GENERATION',sessionId:'session'}
   const input={sessionId:'session',turnId:'compact-turn',trigger:'auto' as const,prompt:'PRIVATE_PROMPT',transcript_path:'/private/transcript',body:'PRIVATE_BODY'}
   expect(recordCodexPostCompactCapture(scope,input,1,{})).toBe(false)
   const nonce='fixture_nonce_00000001',env={TIDEMIND_CODEX_RESTORE_CAPTURE_NONCE:nonce,TIDEMIND_CODEX_RESTORE_CAPTURE_DIR:directory}
   expect(recordCodexPostCompactCapture(scope,{...input,trigger:undefined},1,env)).toBe(false)
   expect(recordCodexPostCompactCapture(scope,{...input,trigger:'unknown' as never},1,env)).toBe(false)
   expect(fs.readdirSync(directory)).toEqual([])
   expect(recordCodexPostCompactCapture(scope,input,1,env)).toBe(true)
   const file=path.join(directory,codexRestoreCaptureFileName(nonce)),bytes=fs.readFileSync(file,'utf8'),value=JSON.parse(bytes)
   expect(Object.keys(value).sort()).toEqual(['schemaVersion','captureNonce','observedAt','eventName','sessionId','turnId','trigger','generationSha256','scopeKey','revision'].sort())
   expect(value).toMatchObject({trigger:'auto',generationSha256:sha256Json(scope.generation),scopeKey:contextRestoreKey(scope),revision:1})
   expect(bytes).not.toMatch(/SECRET_GENERATION|PRIVATE_|transcript_path/)
   expect(recordCodexPostCompactCapture(scope,input,2,env)).toBe(false)
   expect(fs.readFileSync(file,'utf8')).toBe(bytes)
  }finally{fs.rmSync(directory,{recursive:true,force:true})}
 })
})
