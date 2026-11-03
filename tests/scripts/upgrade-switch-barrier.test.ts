/** Synthetic processes only: not real host or signed-candidate acceptance. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { assertUpgradeStopped, restoreUpgradeProfile } from '../../scripts/run-signed-upgrade-no-auth.mjs'
import { migrateExistingDatabaseIfNeeded } from '../../src/db/pre-migration.js'
import { CURRENT_SCHEMA_VERSION } from '../../src/db/schema.js'
const roots:string[]=[]
const children:ChildProcess[]=[]
afterEach(async()=>{
  for(const child of children.splice(0))if(child.exitCode===null){const exit=once(child,'exit');child.stdin!.end();await exit}
  roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true}))
})
function profile(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-upgrade-barrier-')));roots.push(root)
  const workspace=path.join(root,'profile'),graph=path.join(workspace,'home/.tidemind/graph'),output=path.join(root,'output')
  fs.mkdirSync(graph,{recursive:true});fs.mkdirSync(output)
  fs.writeFileSync(path.join(workspace,'.tidemind-upgrade-profile'),'isolated-tidemind-upgrade-v1\n')
  fs.writeFileSync(path.join(workspace,'home/.tidemind/config.toml'),'[llm]\nstandard_model="synthetic"\n')
  const dbpath=path.join(graph,'brain.sqlite'),db=new Database(dbpath)
  const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/db/v41-observed-structure.json',import.meta.url),'utf8'))
  for(const type of ['table','index','trigger','view'])for(const object of fixture.objects.filter((o:any)=>o.type===type&&!o.name.startsWith('sqlite_')&&!o.name.startsWith('nodes_vec')&&!o.name.startsWith('nodes_fts_')))db.exec(object.sql)
  db.exec(`INSERT INTO metadata VALUES ('schema_version','41');
    INSERT INTO background_schema_capabilities(singleton_id,protocol_version,created_at,updated_at) VALUES(1,1,'synthetic','synthetic');
    INSERT INTO mutation_lane(singleton_id,updated_at) VALUES(1,'synthetic');
    INSERT INTO runtime_leader(singleton_id,protocol_version) VALUES(1,1);
    INSERT INTO sync_apply_guard(k,applying) VALUES(0,0);`)
  db.close();return {workspace,output,dbpath}
}
async function helper(dbpath?:string, version = 'old-synthetic'){
  const runtimeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-helper-runtime-'));roots.push(runtimeRoot)
  const runtime=path.join(runtimeRoot,version+'.cjs')
  fs.writeFileSync(runtime,`
    const db=process.argv[3]?new(require(process.argv[2]))(process.argv[3]):null;
    const schema=db?.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value;
    console.log(JSON.stringify({pid:process.pid,executable:process.execPath,database:process.argv[3]||null,schema,version:process.argv[4],runtime:__filename}));
    process.stdin.resume();process.stdin.on('end',()=>{db?.close();process.exit(0)});
  `)
  const child=spawn(process.execPath,[runtime,createRequire(import.meta.url).resolve('better-sqlite3'),dbpath??'',version],{stdio:['pipe','pipe','pipe']});children.push(child)
  const [raw]=await once(child.stdout!,'data');return {child,observation:JSON.parse(String(raw))}
}
async function close(child:ChildProcess){const exit=once(child,'exit');child.stdin!.end();await exit}
describe.runIf(process.platform==='darwin')('P1 synthetic process switch barrier',()=>{
  it('refuses a known host/restart supervisor even while it has no database handle',async()=>{
    const p=profile(),host=await helper()
    expect(()=>assertUpgradeStopped(p.workspace,[host.child.pid])).toThrow('still running')
    await close(host.child);expect(()=>assertUpgradeStopped(p.workspace,[host.child.pid])).not.toThrow()
  })
  it('refuses a resident helper with an open database even without a supplied PID',async()=>{
    const p=profile(),old=await helper(p.dbpath)
    expect(()=>assertUpgradeStopped(p.workspace)).toThrow('fully stopped')
    await close(old.child);expect(()=>assertUpgradeStopped(p.workspace)).not.toThrow()
  })
  it('reopens a helper against the converted database after quiescence and migration',async()=>{
    const p=profile(),old=await helper(p.dbpath);expect(old.observation.schema).toBe('41')
    await close(old.child);assertUpgradeStopped(p.workspace,[old.child.pid])
    migrateExistingDatabaseIfNeeded(p.dbpath,path.join(p.workspace,'home/.tidemind/config.toml'))
    const next=await helper(p.dbpath,'new-synthetic')
    expect(next.observation.runtime).toMatch(/new-synthetic\.cjs$/)
    expect(next.observation.runtime).not.toBe(old.observation.runtime)
    expect(next.observation).toMatchObject({executable:process.execPath,database:p.dbpath,schema:String(CURRENT_SCHEMA_VERSION),version:'new-synthetic'})
  })
  it('rejects restore while a known host has no open database handle',async()=>{
    const p=profile(),beforePath=path.join(p.output,'before.json')
    execFileSync('/usr/bin/python3',['scripts/observe-upgrade-profile.py','--workspace',p.workspace,'--phase','before','--output',beforePath,'--backup-dir',path.join(p.output,'backup')])
    const before=JSON.parse(fs.readFileSync(beforePath,'utf8')),host=await helper()
    expect(()=>restoreUpgradeProfile(p.workspace,before,p.output,[host.child.pid])).toThrow('still running')
    await close(host.child)
    expect(()=>restoreUpgradeProfile(p.workspace,before,p.output,[host.child.pid])).not.toThrow()
  })
  it('requires the new helper to exit before matched restore and then reopens the old database',async()=>{
    const p=profile(),beforePath=path.join(p.output,'before.json')
    execFileSync('/usr/bin/python3',['scripts/observe-upgrade-profile.py','--workspace',p.workspace,'--phase','before','--output',beforePath,'--backup-dir',path.join(p.output,'backup')])
    const before=JSON.parse(fs.readFileSync(beforePath,'utf8'))
    migrateExistingDatabaseIfNeeded(p.dbpath,path.join(p.workspace,'home/.tidemind/config.toml'))
    const next=await helper(p.dbpath,'new-synthetic')
    expect(()=>restoreUpgradeProfile(p.workspace,before,p.output)).toThrow('fully stopped')
    await close(next.child);assertUpgradeStopped(p.workspace,[next.child.pid])
    restoreUpgradeProfile(p.workspace,before,p.output)
    const old=await helper(p.dbpath)
    expect(old.observation.runtime).toMatch(/old-synthetic\.cjs$/)
    expect(old.observation).toMatchObject({executable:process.execPath,database:p.dbpath,schema:'41',version:'old-synthetic'})
  })
})
