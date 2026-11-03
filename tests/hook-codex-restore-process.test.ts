
import {execFile} from 'node:child_process'
import {build} from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import Ajv from 'ajv'
import {beforeEach,afterEach,describe,it,expect} from 'vitest'
import {ensureSchema} from '../src/db/schema'
import {sha256Json} from '../client/electron/agent-integration/fingerprint'
import {createContextRestoreStore,contextRestoreKey} from '../src/hook-codex-context-restore'
import {seedNode} from './helpers/test-db'
const ACTIVITY_TOKEN='hook-output-generation',AGENT_ID='eb_hook_output'
function lifecycleEvidenceDb(dbPath:string): Database.Database {
  const db = new Database(dbPath)
  ensureSchema(db)
  const createdAt = '2026-09-05T00:00:00.000Z'
  db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
    VALUES (?, 'Hook output fixture', 'codex', 0, ?)`).run(AGENT_ID, createdAt)
  db.prepare(`INSERT INTO agent_installations (
      id, family, host_variant, runtime_realm, profile_id, install_key,
      provenance, display_name, detected_version, agent_id, desired_state,
      supported_capability, desired_capability, health_state, created_at, updated_at
    ) VALUES (
      'installation-hook-output', 'codex', 'codex-cli', 'local_macos',
      'default', 'opencode:hook-output', 'fixture', 'OpenCode', '1.18.28', ?,
      'managed', 4, 4, 'discovered', ?, ?
    )`).run(AGENT_ID, createdAt, createdAt)
  db.prepare(`INSERT INTO managed_artifacts (
      id, component_type, target_path, ownership_key, mutation_domain,
      projection_version, selector_schema_version, owned_fragment_hash,
      observed_fragment_hash, state, created_at, updated_at
    ) VALUES (
      'artifact-hook-output', 'hook', '/fixture/hook-output', 'document',
      'local_macos:file:/fixture/hook-output:document', '1', '1',
      'owned-hash', 'owned-hash', 'healthy', ?, ?
    )`).run(createdAt, createdAt)
  db.prepare(`INSERT INTO installation_components (
      installation_id, component_key, desired_state, desired_capability,
      delivery_mode, verification_status, artifact_id, visibility_state,
      created_at, updated_at
    ) VALUES (
      'installation-hook-output', 'lifecycle', 'managed', 4, 'managed',
      'unverified', 'artifact-hook-output', 'dedicated', ?, ?
    )`).run(createdAt, createdAt)
  db.prepare(`INSERT INTO artifact_consumers (
      artifact_id, installation_id, component_key, required_capability,
      desired_state, discover_reachability, state, added_at, updated_at
    ) VALUES (
      'artifact-hook-output', 'installation-hook-output', 'lifecycle', 4,
      'managed', 'dedicated', 'active', ?, ?
    )`).run(createdAt, createdAt)
  db.prepare(`INSERT INTO reconcile_runs (
      id, installation_id, operation_type, execution_plan_hash, state,
      recovery_strategy, adapter_version, catalog_version, projection_version,
      selector_schema_version, prepared_plan_json, desired_capability,
      created_at, updated_at
    ) VALUES (
      'run-hook-output', 'installation-hook-output', 'connect', 'plan-hash', 'committed',
      'readback_before_replay', '1+1+1', '1', '1', '1', ?, 4, ?, ?
    )`).run(JSON.stringify({
      componentKeys: ['lifecycle'],
      activityGenerationToken: ACTIVITY_TOKEN,
      executionPlan: { activityGenerationTokenHash: sha256Json(ACTIVITY_TOKEN) },
    }), createdAt, createdAt)
  return db
}

describe('Codex context restore real scripts', {timeout:30000},()=>{
 let home:string, dataDir:string, db:Database.Database, skill:string,profileId:string
 const session='restore-session'
 const scope=()=>({canonicalDataDir:dataDir,agentId:AGENT_ID,generation:ACTIVITY_TOKEN,sessionId:session})
 beforeEach(()=>{
  home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-restore-process-')))
  dataDir=path.join(home,'.tidemind');fs.mkdirSync(path.join(dataDir,'graph'),{recursive:true})
  db=lifecycleEvidenceDb(path.join(dataDir,'graph','brain.sqlite'))
  profileId=seedNode(db,{type:'meta',title:'user-profile',content:'SAVED_PROFILE_V1'}).id
  skill=path.join(home,'SKILL.md');fs.writeFileSync(skill,'# skill-only fixture')
 })
 afterEach(()=>{db.close();fs.rmSync(home,{recursive:true,force:true})})
 const payload=(event:string,turn='turn-1')=>({hook_event_name:event,session_id:session,turn_id:turn,prompt:'PRIVATE_PROMPT_SENTINEL',transcript_path:'/PRIVATE_TRANSCRIPT_SENTINEL'})
 function run(script:string,event:string,options:{input?:string;turn?:string;generation?:string;brokenOutput?:boolean;extra?:string[];bundle?:string;captureDirectory?:string;captureNonce?:string}={}){
  const input=options.input??JSON.stringify(payload(event,options.turn))
  return new Promise<{status:number;stdout:string;stderr:string}>((resolve,reject)=>{
   const child=execFile(options.bundle?process.execPath:path.resolve('node_modules/.bin/tsx'),[options.bundle??path.resolve('src/'+script+'.ts'),
    '--agent-id',AGENT_ID,'--tool','codex','--activity-generation-token',options.generation??ACTIVITY_TOKEN,
    ...(script==='hook-session-start'?['--skill-path',skill]:[]),...(options.extra??[])],
    {cwd:path.resolve('.'),env:{...process.env,HOME:home,ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',NODE_PATH:path.resolve('node_modules'),TIDEMIND_CODEX_RESTORE_CAPTURE_NONCE:options.captureNonce??'',TIDEMIND_CODEX_RESTORE_CAPTURE_DIR:options.captureDirectory??''},timeout:12000,maxBuffer:2*1024*1024},
    (error,stdout,stderr)=>{if(error && typeof error.code!=='number'){reject(error);return}resolve({status:error?.code??0,stdout,stderr})})
   if(options.brokenOutput)child.stdout?.destroy()
   child.stdin?.on('error',()=>{})
   child.stdin?.end(input)
  })
 }
 const pc=()=>run('hook-post-compact','PostCompact')
 const ups=(turn='turn-1')=>run('hook-codex-user-prompt-submit','UserPromptSubmit',{turn})
 it('does nothing without a marker or for invalid bounded input',async()=>{
  const before=db.prepare('SELECT * FROM metadata ORDER BY key').all()
  expect((await ups()).stdout).toBe('{}')
  for(const input of [JSON.stringify({hook_event_name:'PostCompact',session_id:session}),JSON.stringify({session_id:session}), 'x'.repeat(1024*1024+1)]){
   expect((await run('hook-codex-user-prompt-submit','UserPromptSubmit',{input})).stdout).toBe('{}')
  }
  expect(db.prepare('SELECT * FROM metadata ORDER BY key').all()).toEqual(before)
  expect(db.prepare("SELECT count(*) AS n FROM operation_log WHERE operation='prepare'").get()).toEqual({n:0})
 })
 it('marks PostCompact without prepare, emits saved context once, and handles new revision in the same turn',async()=>{
  expect((await pc()).stdout).toBe('{}')
  expect(db.prepare("SELECT count(*) AS n FROM operation_log WHERE operation='prepare'").get()).toEqual({n:0})
  expect(createContextRestoreStore(db).readPending(scope())?.pendingRevision).toBe(1)
  const output=await ups();expect(output.status).toBe(0)
  const parsed=JSON.parse(output.stdout)
  const validate=new Ajv().compile(JSON.parse(fs.readFileSync(new URL('./fixtures/codex-rust-v0.157.1/user-prompt-submit.command.output.schema.json',import.meta.url),'utf8')))
  expect(validate(parsed)).toBe(true)
  expect(parsed.hookSpecificOutput.additionalContext).toContain('SAVED_PROFILE_V1')
  expect((await ups()).stdout).toBe('{}');expect((await ups('turn-2')).stdout).toBe('{}')
  await pc();db.prepare("UPDATE nodes SET content='SAVED_PROFILE_V2' WHERE id=?").run(profileId)
  expect((await ups()).stdout).toContain('SAVED_PROFILE_V2')
  expect(db.prepare("SELECT count(*) AS n FROM operation_log WHERE operation='prepare'").get()).toEqual({n:0})
  const marker=db.prepare('SELECT value FROM metadata WHERE key=?').get(contextRestoreKey(scope())) as {value:string}
  expect(marker.value).not.toContain('PRIVATE_');expect(marker.value).not.toContain('SAVED_PROFILE')
 })
 it('admits paused bridge but rejects removed or stale-generation invocations without consuming',async()=>{
  await pc();db.prepare("UPDATE agent_installations SET desired_state='disabled'").run()
  expect((await ups()).stdout).toContain('SAVED_PROFILE_V1')
  await pc();db.prepare("UPDATE agent_installations SET desired_state='removed'").run()
  expect((await ups()).stdout).toBe('{}')
  expect(createContextRestoreStore(db).readPending(scope())).not.toBeNull()
  db.prepare("UPDATE agent_installations SET desired_state='managed'").run()
  expect((await run('hook-codex-user-prompt-submit','UserPromptSubmit',{generation:'stale'})).stdout).toBe('{}')
  expect(createContextRestoreStore(db).readPending(scope())).not.toBeNull()
 })
 it('successful SessionStart satisfies only after saved context is emitted',async()=>{
  await pc()
  const start=await run('hook-session-start','SessionStart')
  expect(start.stdout).toContain('SAVED_PROFILE_V1')
  expect(createContextRestoreStore(db).readPending(scope())).toBeNull()
  expect((await ups()).stdout).toBe('{}')
 })
 it('Skill-only SessionStart fallback does not consume pending recovery',async()=>{
  await pc()
  db.exec("CREATE TRIGGER fail_prepare BEFORE INSERT ON operation_log BEGIN SELECT RAISE(ABORT,'fixture prepare unavailable'); END")
  const start=await run('hook-session-start','SessionStart')
  expect(start.stdout).toContain('skill-only fixture')
  expect(start.stdout).not.toContain('SAVED_PROFILE_V1')
  expect(createContextRestoreStore(db).readPending(scope())).not.toBeNull()
  expect((await ups()).stdout).toContain('SAVED_PROFILE_V1') // readOnly path never hits the write trigger
 })
 it('concurrent processes consume at most one normal emission',async()=>{
  await pc();const results=await Promise.all([ups(),ups()])
  expect(results.filter(result=>result.stdout.includes('SAVED_PROFILE_V1'))).toHaveLength(1)
  expect(results.filter(result=>result.stdout==='{}')).toHaveLength(1)
 })
 it('runs the self-contained CJS entry with the existing native externals',async()=>{
  await pc()
  const outfile=path.join(home,'hook-codex-user-prompt-submit.cjs')
  await build({entryPoints:[path.resolve('src/hook-codex-user-prompt-submit.ts')],bundle:true,platform:'node',target:'node20',format:'cjs',outfile,
   external:['better-sqlite3','sqlite-vec','electron'],alias:{'@server':path.resolve('src')},
   define:{'import.meta.url':'__tm_bundle_url__','__TIDEMIND_BUNDLED_VERSION__':JSON.stringify('0.2.94-test'),'__TIDEMIND_BUNDLED_SOURCE_COMMIT__':JSON.stringify('p2-fixture')},
   banner:{js:'const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;'},logLevel:'silent'})
  expect((await run('hook-codex-user-prompt-submit','UserPromptSubmit',{bundle:outfile})).stdout).toContain('SAVED_PROFILE_V1')
  expect(createContextRestoreStore(db).readPending(scope())).toBeNull()
 })
 it('records only an explicitly opted-in native PostCompact trigger sidecar',async()=>{
  const directory=path.join(home,'capture');fs.mkdirSync(directory)
  const nonce='process_capture_nonce_001'
  const result=await run('hook-post-compact','PostCompact',{captureDirectory:directory,captureNonce:nonce,input:JSON.stringify({...payload('PostCompact'),trigger:'manual'})})
  expect(result.stdout).toBe('{}')
  const observation=JSON.parse(fs.readFileSync(path.join(directory,nonce+'.post-compact.json'),'utf8'))
  expect(observation).toMatchObject({captureNonce:nonce,eventName:'PostCompact',trigger:'manual',sessionId:session,turnId:'turn-1',scopeKey:contextRestoreKey(scope()),revision:1,generationSha256:sha256Json(ACTIVITY_TOKEN)})
  expect(JSON.stringify(observation)).not.toContain('PRIVATE_')
  await pc()
  await run('hook-post-compact','PostCompact',{captureDirectory:directory,captureNonce:'process_missing_trigger_001'})
  expect(fs.readdirSync(directory)).toEqual([nonce+'.post-compact.json'])
  expect(createContextRestoreStore(db).readState(scope())?.pendingRevision).toBe(3)
 })
 it('prepare failure returns empty and releases only its own claim for retry',async()=>{
  await pc();db.exec('ALTER TABLE nodes RENAME TO nodes_unavailable')
  try{
   const failed=await ups();expect(failed.stdout).toBe('{}')
   expect(failed.stderr).toContain('restore_unavailable')
   const pending=createContextRestoreStore(db).readPending(scope())
   expect(pending?.pendingRevision).toBe(1);expect(pending?.claim).toBeUndefined()
  }finally{db.exec('ALTER TABLE nodes_unavailable RENAME TO nodes')}
  expect((await ups()).stdout).toContain('SAVED_PROFILE_V1')
 })
 it('busy database and broken stdout retain pending work',async()=>{
  await pc()
  db.exec('BEGIN IMMEDIATE')
  try{expect((await ups()).stdout).toBe('{}')}finally{db.exec('ROLLBACK')}
  expect(createContextRestoreStore(db).readPending(scope())).not.toBeNull()
  const broken=await run('hook-codex-user-prompt-submit','UserPromptSubmit',{brokenOutput:true})
  expect(broken.stderr).toContain('restore_unavailable')
  expect(createContextRestoreStore(db).readPending(scope())).not.toBeNull()
  expect((await ups()).stdout).toContain('SAVED_PROFILE_V1')
 })
})
