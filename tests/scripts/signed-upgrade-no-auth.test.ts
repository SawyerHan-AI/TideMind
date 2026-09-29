import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUpgradeArgs, compareUpgradeObservations, restoreUpgradeProfile, targetConfigurationBindings } from '../../scripts/run-signed-upgrade-no-auth.mjs'
const roots: string[]=[]
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})))
const args=['--candidate-app','/fixture/Tide Mind.app','--candidate-bundle-sha256','a'.repeat(64),'--source-commit','b'.repeat(40),'--capture-nonce','c'.repeat(64),'--historical-inputs','/fixture/old.json','--host-samples','/fixture/hosts.json','--workspace','/fixture/work','--output-dir','/fixture/out','--catalog-id','claude-desktop-legacy']
describe('actual signed upgrade orchestration boundaries',()=>{
 it('requires complete immutable bindings and rejects unsupported catalog/duplicate options',()=>{
  expect(parseUpgradeArgs(args)['catalog-id']).toBe('claude-desktop-legacy')
  expect(()=>parseUpgradeArgs([...args,'--fixture','true'])).toThrow()
  expect(()=>parseUpgradeArgs([...args,'--source-commit','d'.repeat(40)])).toThrow()
  expect(()=>parseUpgradeArgs(args.map(v=>v==='claude-desktop-legacy'?'unknown':v))).toThrow()
 })
 it('does not convert unsupported baseline or synthetic statistics to real history claims',()=>{
  const before={tables:{llm_usage_log:{rowCount:1}}},after={tables:{agents:{identities:[{id:'actual-old-id'}]},agent_installations:{identities:[]}},comparison:{}}
  const result=compareUpgradeObservations(before,after,null,'claude-cowork-local')
  expect(result.agentIdPreserved).toBeNull()
  expect(result.statisticsInputOrigin).toBe('synthetic_migration_corpus')
  expect(result.realBillingHistoryClaimed).toBe(false)
  expect(result).not.toHaveProperty('status','passed')
 })
 it('requires the actual target MCP configuration to reference the original Agent ID',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-binding-fixture-')));roots.push(root)
  const home=path.join(root,'home'),codex=path.join(home,'.codex');fs.mkdirSync(codex,{recursive:true})
  const file=path.join(codex,'config.toml');fs.writeFileSync(file,'[mcp_servers.tidemind]\nenv = { EB_AGENT_ID = "old-agent" }\n')
  expect(targetConfigurationBindings(root,[file],'old-agent','codex-desktop')[0].bindings).toEqual([{selector:'tidemind',agentId:'old-agent'}])
  fs.writeFileSync(file,'[mcp_servers.tidemind]\nenv = { EB_AGENT_ID = "new-agent" }\n')
  expect(()=>targetConfigurationBindings(root,[file],'old-agent','codex-desktop')).toThrow('does not bind the original Agent ID')
 })
 it.runIf(process.platform==='darwin')('seeds only labelled non-activity data, snapshots it, and restores a matched stopped profile',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-operator-fixture-')));roots.push(root)
  const workspace=path.join(root,'workspace'),output=path.join(root,'output'),data=path.join(workspace,'home/.tidemind'),graph=path.join(data,'graph')
  fs.mkdirSync(graph,{recursive:true});fs.mkdirSync(output)
  fs.writeFileSync(path.join(workspace,'.tidemind-upgrade-profile'),'isolated-tidemind-upgrade-v1\n')
  fs.writeFileSync(path.join(data,'config.toml'),'[llm]\nstandard_model = "old-choice"\n')
  const dbpath=path.join(graph,'brain.sqlite');let db=new Database(dbpath)
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('schema_version','34');
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,tool_type TEXT,archived INTEGER,created TEXT);INSERT INTO agents VALUES('eb_actual_fixture','old fixture','cowork',0,'now');
    CREATE TABLE nodes(id TEXT PRIMARY KEY,type TEXT,content TEXT,tags TEXT,archived INTEGER,source_tool TEXT,created TEXT,updated TEXT);
    CREATE TABLE llm_usage_log(id INTEGER PRIMARY KEY AUTOINCREMENT,model TEXT,operation TEXT,input_tokens INTEGER,output_tokens INTEGER,thinking_tokens INTEGER,estimated_cost REAL,created TEXT);
    CREATE TABLE agent_host_activity_evidence(id TEXT PRIMARY KEY);`);db.close()
  const corpus=path.join(output,'corpus.json')
  db=new Database(dbpath);db.exec("CREATE TRIGGER forbid_identity_change AFTER INSERT ON nodes BEGIN UPDATE agents SET archived=1; END");db.close()
  expect(()=>execFileSync('/usr/bin/python3',['scripts/seed-upgrade-corpus.py','--workspace',workspace,'--agent-id','eb_actual_fixture','--output',corpus],{stdio:'pipe'})).toThrow()
  db=new Database(dbpath);expect(db.prepare('SELECT archived FROM agents').get()).toEqual({archived:0});expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({n:0});db.exec('DROP TRIGGER forbid_identity_change');db.close()
  expect(fs.existsSync(corpus)).toBe(false)
  execFileSync('/usr/bin/python3',['scripts/seed-upgrade-corpus.py','--workspace',workspace,'--agent-id','eb_actual_fixture','--output',corpus])
  expect(JSON.parse(fs.readFileSync(corpus,'utf8'))).toMatchObject({kind:'synthetic_migration_corpus',isRealCall:false,isRealCharge:false,isHostActivityEvidence:false,protectedTablesUnchanged:true})
  db=new Database(dbpath);expect(db.prepare('SELECT count(*) AS n FROM agent_host_activity_evidence').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) AS n FROM nodes WHERE archived=1').get()).toEqual({n:1});db.close()
  const beforePath=path.join(output,'before.json'),backup=path.join(output,'backup')
  execFileSync('/usr/bin/python3',['scripts/observe-upgrade-profile.py','--workspace',workspace,'--phase','before','--output',beforePath,'--backup-dir',backup])
  const before=JSON.parse(fs.readFileSync(beforePath,'utf8'))
  db=new Database(dbpath);db.exec("UPDATE metadata SET value='35' WHERE key='schema_version';INSERT INTO metadata VALUES('after-only','retained')");db.close()
  expect(()=>restoreUpgradeProfile(workspace,{...before,backup:{...before.backup,databaseSha256:'0'.repeat(64)}},output)).toThrow('restore backup identity differs')
  const restored=restoreUpgradeProfile(workspace,before,output)
  expect(fs.existsSync(path.join(restored.retainedPostUpgradeState,'graph/brain.sqlite'))).toBe(true)
  db=new Database(dbpath);expect(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({value:'34'});expect(db.prepare("SELECT value FROM metadata WHERE key='after-only'").get()).toBeUndefined();db.close()
  expect(restored.hostConfigurationRestored).toBe(false)
  const outside=path.join(root,'outside-canary');fs.writeFileSync(outside,'untouched')
  fs.symlinkSync(outside,dbpath+'-wal')
  expect(()=>execFileSync('/usr/bin/python3',['scripts/seed-upgrade-corpus.py','--workspace',workspace,'--output',path.join(output,'unsafe-corpus.json')],{stdio:'pipe'})).toThrow()
  expect(()=>execFileSync('/usr/bin/python3',['scripts/observe-upgrade-profile.py','--workspace',workspace,'--phase','after','--output',path.join(output,'unsafe-observer.json')],{stdio:'pipe'})).toThrow()
  expect(()=>restoreUpgradeProfile(workspace,before,output)).toThrow('sidecar')
  expect(fs.readFileSync(outside,'utf8')).toBe('untouched');fs.unlinkSync(dbpath+'-wal')
  const marker=path.join(workspace,'.tidemind-upgrade-profile'),markerTarget=path.join(root,'marker-copy');fs.renameSync(marker,markerTarget);fs.symlinkSync(markerTarget,marker)
  expect(()=>restoreUpgradeProfile(workspace,before,output)).toThrow('marker')

 })
})
