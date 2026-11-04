
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/tm-shared-codex',getVersion:()=> '0.2.94-test',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parse } from 'smol-toml'
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard'
import { ensureSchema } from '../../src/db/schema'
import { adoptProvableLegacyConnections, installationIdentity } from '../../client/electron/agent-integration/legacy-adoption'
import { bindAgentIntegrationExecutionPort,createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import { createOfficialCodexHooksPort, createCodexLifecycleHostAdapter } from '../../client/electron/agent-integration/hosts/codex-lifecycle-adapter'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'

describe('Codex shared identity through service and physical files',()=>{
 it.each([
  ...['same-generation-owner','same-generation-drift','same-generation-tampered','same-generation-rollback'].map(mode=>({firstDisconnect:'codex-cli',mode})),
  { firstDisconnect:'codex-cli', mode:'completed-waits' },
  ...['completed-waits','completed-waits-partial','completed-waits-active','completed-waits-unbound','completed-waits-drift','completed-waits-rollback'].map(mode=>({firstDisconnect:'codex-desktop',mode})),
  { firstDisconnect:'codex-cli', mode:'normal' },
  { firstDisconnect:'codex-cli', mode:'legacy-hooks-single' },
  { firstDisconnect:'codex-cli', mode:'legacy-hooks-old-token' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection-restored-hook' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection-other-hook-only' },
  { firstDisconnect:'codex-desktop', mode:'legacy-selection-second' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection-drift' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection-unproven' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection-rollback' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection-recovery' },
  { firstDisconnect:'codex-cli', mode:'legacy-selection-restored-old' },
  { firstDisconnect:'codex-desktop', mode:'normal' },
  { firstDisconnect:'codex-cli', mode:'full-lifecycle' },
  { firstDisconnect:'codex-cli', mode:'lifecycle-trust-recheck' },
  { firstDisconnect:'codex-desktop', mode:'full-lifecycle' },
  { firstDisconnect:'codex-cli', mode:'recovery' },
  { firstDisconnect:'codex-cli', mode:'different-token' },
  { firstDisconnect:'codex-cli', mode:'unbound' },
 ])('runs shared control flow with $mode and first disconnect $firstDisconnect',async({firstDisconnect,mode})=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-shared-flow-')))
  const home=path.join(root,'home'),configRoot=path.join(home,'.codex'),appData=path.join(root,'app-data')
  for(const dir of [configRoot,appData,path.join(root,'bin')])fs.mkdirSync(dir,{recursive:true})
  fs.mkdirSync(path.join(appData,'graph'),{recursive:true})
  const db=new Database(path.join(appData,'graph','brain.sqlite'));ensureSchema(db)
  const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
   shimPath:path.join(root,'bin','tm-node'),mcpServerPath:path.join(root,'bin','mcp-server.cjs'),
   hookScriptPath:path.join(root,'bin','hook.cjs'),preCompactScriptPath:path.join(root,'bin','pre.cjs'),
   postCompactScriptPath:path.join(root,'bin','post.cjs'),tideMindVersion:'0.2.94-test',catalogVersion:'1',projectionVersion:'1'}
  let fixtureTrusted=false
  const fullLifecycle=mode.startsWith('same-generation') || mode.startsWith('completed-waits') || ['full-lifecycle','lifecycle-trust-recheck','legacy-hooks-single','legacy-hooks-old-token'].includes(mode)
  const officialHooks=createOfficialCodexHooksPort()
  const all=createP0HostAdapters({codexHooksPort:{
    preview:(...args)=>officialHooks.preview(...args),
    list:async context=>{
      const snapshot=await officialHooks.list(context)
      return fixtureTrusted?{...snapshot,hooks:snapshot.hooks.map(hook=>({...hook,trustStatus:'trusted' as const}))}:snapshot
    },
  }})
  const adapters=new Map([['codex-cli',all.get('codex-cli')!],['codex-desktop',all.get('codex-desktop')!]] as const)
  const composition=createProductionAgentIntegrationComposition(db,{homeDir:home,applicationDataDir:appData,runtimeContext:runtime,
    adapters,enabledAdapterIds:[...adapters.keys()],observeOnly:false,startRuntime:false,fixtureMode:'isolated_ui_audit',
    canManageInstallation:()=>true,scanner:{scan:async()=>({installations:[],unresolved:[],diagnostics:[]})},notifications:{deliver:vi.fn()}})
  const unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
  // Synthetic trust/activity readers exercise real Adapter/coordinator contracts;
  // these records are not real Codex acceptance evidence.
  if(mode==='lifecycle-trust-recheck')for(const adapter of adapters.values()){
    const verify=adapter.verify.bind(adapter)
    vi.spyOn(adapter,'verify').mockImplementation((context,request)=>verify(fixtureTrusted?{
      ...context,
      codexHookTrustEvidence:{findCodexHookTrustEvidence:async query=>({...query,id:'synthetic-trust',artifactId:'synthetic',verifiedAt:new Date().toISOString()})},
      hostActivityEvidence:{find:async query=>query.componentKey==='lifecycle'?query.signalNames.map(signalName=>({
        ...query,id:'synthetic-'+signalName,signalName,evidenceHash:'synthetic-'+signalName,
        observedAt:request.activityBinding!.verifiedAt,
      })):[]},
    }:context,request))
  }

  try{
   for(const variant of ['codex-cli','codex-desktop'] as const){
    const executable=path.join(root,'bin',variant);fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
    const identity=canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'synthetic-user',
     productFamilyId:'codex',hostVariant:variant,configRoot,distribution:{distributionId:'cli:'+variant,executableRealpath:executable,packageProvenance:'fixture',capabilityFingerprint:'fixture-'+variant}})
    composition.repository.upsertDiscoveredInstallation({id:variant,family:'codex',hostVariant:variant,runtimeRealm:'local_macos',
      osUserIdentity:'synthetic-user',installKey:identity.installKey,distributionId:'cli:'+variant,provenance:'fixture',displayName:variant,
      configRoot,executablePath:executable,detectedVersion:variant==='codex-cli'?'0.153.4':'26.901.41600',agentId:'original-'+variant,
      supportedCapability:4,lastDetectedAt:'2026-10-23T00:00:00Z',metadata:{distribution:identity.distribution,
        managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})
   }
   db.exec("INSERT INTO agents(id,name,tool_type,created) VALUES ('canonical','synthetic','codex','2026-10-23')")
   const configFile=path.join(configRoot,'config.toml')
   fs.writeFileSync(configFile,['[mcp_servers.tidemind-canonical]','enabled = true','command = '+JSON.stringify(runtime.shimPath),
    'args = ['+JSON.stringify(runtime.mcpServerPath)+']','env = { EB_AGENT_ID = \"canonical\" }',''].join('\n'))
   const legacyHook=(agentId:string)=>({matcher:'startup',hooks:[{type:'command',
    command:[JSON.stringify(runtime.shimPath),JSON.stringify(runtime.hookScriptPath),'--agent-id',JSON.stringify(agentId),'--skill-path',JSON.stringify(path.join(configRoot,'skills','tidemind-'+agentId,'SKILL.md')),'--tool','codex'].join(' '),statusMessage:'加载外脑上下文...',timeoutSec:15}]})
   const thirdPartyHook={matcher:'startup',hooks:[{type:'command',command:'echo third-party'}]}
   if(mode==='legacy-hooks-single')fs.writeFileSync(path.join(configRoot,'hooks.json'),JSON.stringify({hooks:{SessionStart:[legacyHook('canonical'),thirdPartyHook]}}))
   if(mode==='legacy-hooks-old-token'){
     const adapter=createCodexLifecycleHostAdapter({catalogId:'codex-cli',adapterVersion:'fixture'})
     const context={runtime,installation:installationIdentity(composition.repository.getInstallation('codex-cli')!),agentId:'canonical',operationId:'old-projection',activityGenerationToken:'old-token'}
     const plan=await adapter.plan(context,{desiredCapability:4,desiredComponents:['lifecycle'],observed:await adapter.inspect(context),ownedArtifacts:[]})
     for(const mutation of plan.mutations)await adapter.apply(context,mutation)
   }
   if(mode.startsWith('legacy-selection')){
    fs.writeFileSync(path.join(configRoot,'hooks.json'),JSON.stringify({hooks:{SessionStart:[...(mode==='legacy-selection-other-hook-only'?[]:[legacyHook('canonical')]),legacyHook('old-other'),thirdPartyHook]}}))
    db.exec("INSERT INTO agents(id,name,tool_type,created) VALUES ('old-other','other','codex','2026-10-22')")
    fs.appendFileSync(configFile,fs.readFileSync(configFile,'utf8').replaceAll('canonical','old-other'))
    fs.appendFileSync(configFile,'\n[mcp_servers.third_party]\ncommand="untouched"\n')
    const original=fs.readFileSync(configFile)
    if(mode==='legacy-selection-unproven'){
      fs.appendFileSync(configFile,'\n[mcp_servers.tidemind-user_modified]\ncommand="custom-command"\n')
      await expect(composition.service.reviewCodexLegacySelection('codex-cli')).rejects.toThrow('cannot be proved')
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_identity_bindings').get()).toEqual({n:0})
      return
    }
    const review=await composition.service.reviewCodexLegacySelection('codex-cli')
    expect(review.candidates.map(item=>item.agentId)).toEqual(['canonical','old-other'])
    const selected=mode==='legacy-selection-second'?'old-other':'canonical'
    const preview=await composition.service.previewCodexLegacySelection('codex-cli',selected)
    expect(fs.readFileSync(configFile)).toEqual(original)
    expect(preview.installations[0].componentKeys).toContain('lifecycle')
    expect(preview.installations[0].requiredUserActionDetails?.some(action=>action.kind==='codex_hook_trust')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_identity_bindings').get()).toEqual({n:0})
    if(mode==='legacy-selection-drift')fs.appendFileSync(configFile,'# changed after approval preview\n')
    if(mode==='legacy-selection-rollback')db.exec("CREATE TRIGGER fail_binding_member BEFORE INSERT ON agent_identity_binding_members WHEN NEW.installation_id='codex-desktop' BEGIN SELECT RAISE(ABORT,'synthetic second member failure'); END")
    if(mode==='legacy-selection-recovery'){
      const adapter=adapters.get('codex-cli')!,apply=adapter.apply.bind(adapter)
      let thrown=false
      vi.spyOn(adapter,'apply').mockImplementation(async(context,mutation)=>{
        const result=await apply(context,mutation)
        if(!thrown && mutation.componentKey==='memory_tools'){thrown=true;throw new Error('synthetic crash after physical write')}
        return result
      })
    }
    const result=await composition.service.applyConnect(preview.planHash,['codex-cli'])
    if(mode==='legacy-selection-drift' || mode==='legacy-selection-rollback'){
      expect(result.results[0],JSON.stringify(result)).toMatchObject({status:'failed'})
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_identity_bindings').get()).toEqual({n:0})
      expect(db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get()).toEqual({n:0})
      expect(db.prepare('SELECT COUNT(*) AS n FROM managed_artifacts').get()).toEqual({n:0})
      expect(fs.readFileSync(configFile,'utf8')).toBe(original.toString()+(mode==='legacy-selection-drift'?'# changed after approval preview\n':''))
      return
    }
    if(mode==='legacy-selection-recovery'){
      expect(result.results[0].status).toBe('needs_recovery')
      const recovered=await composition.coordinator.recoverNonTerminalRuns()
      expect(recovered[0],JSON.stringify(recovered)+JSON.stringify(db.prepare('SELECT component_key,state,before_hash,after_hash,failure_code,failure_stage FROM projection_mutations').all())).toMatchObject({status:'awaiting_verification'})
    }else expect(result.results[0],JSON.stringify(result)).toMatchObject({status:'awaiting_verification'})
    const parsed=parse(fs.readFileSync(configFile,'utf8')).mcp_servers as Record<string,unknown>
    expect(Object.keys(parsed).sort()).toEqual(['third_party','tidemind-'+selected])
    expect(parsed.third_party).toEqual({command:'untouched'})
    expect(db.prepare("SELECT archived FROM agents WHERE id='old-other'").get()).toEqual({archived:0})
    expect(composition.repository.resolveAgentIdentity('codex-desktop').canonicalAgentId).toBe(selected)
    const migratedHooks=JSON.parse(fs.readFileSync(path.join(configRoot,'hooks.json'),'utf8')).hooks
    expect(migratedHooks.SessionStart).toContainEqual(thirdPartyHook)
    expect(migratedHooks.SessionStart).toHaveLength(2)
    for(const event of ['PreCompact','PostCompact','SessionEnd'])expect(migratedHooks[event]).toHaveLength(1)
    expect(JSON.stringify(migratedHooks)).not.toContain('--agent-id \"canonical\"')
    expect(JSON.stringify(migratedHooks)).not.toContain('--agent-id \"old-other\"')
    const journalCount=db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get()
    const bytesAfter=fs.readFileSync(configFile),hooksAfter=fs.readFileSync(path.join(configRoot,'hooks.json'))
    await expect(composition.service.applyConnect(preview.planHash,['codex-cli'])).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get()).toEqual(journalCount)
    expect(fs.readFileSync(configFile)).toEqual(bytesAfter)
    expect(fs.readFileSync(path.join(configRoot,'hooks.json'))).toEqual(hooksAfter)
    if(mode==='legacy-selection-restored-hook'){
      migratedHooks.SessionStart.push(legacyHook('old-other'))
      fs.writeFileSync(path.join(configRoot,'hooks.json'),JSON.stringify({hooks:migratedHooks}))
      const restored=fs.readFileSync(path.join(configRoot,'hooks.json'))
      const outcomes=await composition.coordinator.recoverNonTerminalRuns()
      expect(outcomes[0],JSON.stringify(outcomes)).toMatchObject({status:'needs_recovery'})
      expect(fs.readFileSync(path.join(configRoot,'hooks.json'))).toEqual(restored)
      return
    }
    if(mode==='legacy-selection-restored-old'){
      const old='[mcp_servers.tidemind-old-other]'+original.toString().split('[mcp_servers.tidemind-old-other]')[1].split('[mcp_servers.third_party]')[0]
      fs.appendFileSync(configFile,'\n'+old)
      const restored=fs.readFileSync(configFile)
      const recovery=await composition.coordinator.recoverNonTerminalRuns()
      expect(recovery.length).toBeGreaterThan(0)
      expect(recovery[0],JSON.stringify(recovery)).toMatchObject({status:'needs_recovery'})
      expect(fs.readFileSync(configFile)).toEqual(restored)
      return
    }
    const second=await composition.service.previewConnect(['codex-desktop'],true,undefined,{withoutLifecycleInstallationIds:['codex-desktop']})
    const secondResult=await composition.service.applyConnect(second.planHash,['codex-desktop'])
    expect(secondResult.results[0],JSON.stringify(secondResult)).toMatchObject({status:'awaiting_verification'})
    const recovery=await composition.coordinator.recoverNonTerminalRuns()
    expect(recovery.length).toBeGreaterThan(0)
    expect(recovery.every(item=>item.status==='awaiting_verification'),JSON.stringify(recovery)).toBe(true)
    return
   }
   let canonical='canonical'
   if(mode.startsWith('completed-waits'))fs.unlinkSync(configFile)
   const adoption=mode.startsWith('completed-waits')?{adopted:0}:await adoptProvableLegacyConnections({repository:composition.repository,adapters,runtime,now:'2026-10-23T00:00:00Z'})
   expect(adoption.adopted).toBe(mode.startsWith('completed-waits')?0:1)
   if(['legacy-hooks-single','legacy-hooks-old-token'].includes(mode)){
     const beforeConfig=fs.readFileSync(configFile),beforeHooks=fs.readFileSync(path.join(configRoot,'hooks.json'))
     const runsBefore=db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get()
     await expect(composition.service.previewDisconnect('codex-cli')).rejects.toThrow('an unconnected Installation cannot be disconnected')
     expect(fs.readFileSync(configFile)).toEqual(beforeConfig)
     expect(fs.readFileSync(path.join(configRoot,'hooks.json'))).toEqual(beforeHooks)
     expect(db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get()).toEqual(runsBefore)
   }
   for(const id of ['codex-cli','codex-desktop']){
    if(id==='codex-desktop'){
      if(mode==='recovery')db.exec("UPDATE reconcile_runs SET state='needs_recovery' WHERE installation_id='codex-cli'")
      if(mode==='different-token')db.exec("UPDATE reconcile_runs SET prepared_plan_json=json_set(prepared_plan_json,'$.activityGenerationToken','not-the-carrier') WHERE installation_id='codex-cli'")
      if(mode==='unbound')db.exec("DELETE FROM agent_identity_binding_members WHERE installation_id='codex-desktop'")
    }
    const beforeApply=fs.existsSync(configFile)?fs.readFileSync(configFile):null
    const preview=await composition.service.previewConnect([id],true,undefined,fullLifecycle?{}:{withoutLifecycleInstallationIds:[id]})
    const applied=await composition.service.applyConnect(preview.planHash,[id])
    if(id==='codex-desktop' && !mode.startsWith('same-generation') && !mode.startsWith('completed-waits') && !['normal','full-lifecycle','lifecycle-trust-recheck','legacy-hooks-single','legacy-hooks-old-token'].includes(mode)){
      expect(applied.results[0]).toMatchObject({status:'failed'})
      expect(fs.readFileSync(configFile)).toEqual(beforeApply)
      return
    }
    expect(applied.results[0],JSON.stringify(applied.results[0])+JSON.stringify(db.prepare('SELECT component_key,result,evidence_ref FROM verification_results').all())).toMatchObject({status:'awaiting_verification'})
    canonical=composition.repository.resolveAgentIdentity(id).canonicalAgentId
    const config=parse(fs.readFileSync(configFile,'utf8'))
    expect(Object.keys(config.mcp_servers as object)).toEqual(['tidemind-'+canonical])
   }
   if(mode==='lifecycle-trust-recheck'){
    expect(db.prepare("SELECT COUNT(*) AS n FROM verification_results WHERE component_key='lifecycle' AND evidence_ref IS NULL AND run_id IS NOT NULL").get()).toEqual({n:2})
    fixtureTrusted=true
    const outcomes=await composition.coordinator.recoverNonTerminalRuns()
    expect(outcomes.every(outcome=>outcome.status==='awaiting_verification'),JSON.stringify(outcomes)).toBe(true)
    expect(db.prepare("SELECT COUNT(*) AS n FROM verification_results WHERE component_key='lifecycle' AND evidence_ref LIKE 'host-activity:%;codex-hook-trust:synthetic-trust' AND run_id IS NOT NULL").get()).toEqual({n:2})
   }
   if(mode.startsWith('same-generation')){
    const carrier=db.prepare("SELECT * FROM reconcile_runs WHERE installation_id='codex-cli'").get() as Record<string,unknown>
    const effects=db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(carrier.id)
    const before=fs.readFileSync(configFile)
    const bindings=db.prepare("SELECT * FROM artifact_consumers WHERE installation_id='codex-cli' ORDER BY component_key").all()
    const components=db.prepare("SELECT * FROM installation_components WHERE installation_id='codex-cli' ORDER BY component_key").all()
    const repeat=await composition.service.previewConnect(['codex-cli'],true)
    if(mode==='same-generation-drift')fs.writeFileSync(configFile,fs.readFileSync(configFile,'utf8').replace(runtime.shimPath,runtime.shimPath+'-changed'))
    if(mode==='same-generation-tampered')db.prepare("UPDATE projection_mutations SET apply_receipt_json='{}' WHERE run_id=?").run(carrier.id)
    if(mode==='same-generation-rollback'){
      db.exec("CREATE TRIGGER fail_same_generation BEFORE UPDATE OF consent_envelope_id ON agent_installations WHEN NEW.id='codex-cli' AND NEW.consent_envelope_id!=OLD.consent_envelope_id BEGIN SELECT RAISE(ABORT,'synthetic same-generation rollback'); END")
      const acquire=composition.coordinatorRepository.acquireExecutionFence.bind(composition.coordinatorRepository)
      vi.spyOn(composition.coordinatorRepository,'acquireExecutionFence').mockImplementation(runId=>{
        const lease=acquire(runId)
        return runId===carrier.id && lease?{assertOwned:()=>lease.assertOwned(),release(){lease.release();throw new Error('synthetic secondary release failure')}}:lease
      })
    }
    const repeated=await composition.service.applyConnect(repeat.planHash,['codex-cli'])
    if(mode!=='same-generation-owner'){
      expect(repeated.results[0],JSON.stringify(repeated)).toMatchObject({status:'failed'})
      expect(db.prepare('SELECT * FROM reconcile_runs WHERE id=?').get(carrier.id)).toEqual(carrier)
      if(mode==='same-generation-rollback'){
        expect(repeated.results[0].reason).toContain('synthetic same-generation rollback')
        expect(db.prepare("SELECT * FROM artifact_consumers WHERE installation_id='codex-cli' ORDER BY component_key").all()).toEqual(bindings)
        expect(db.prepare("SELECT * FROM installation_components WHERE installation_id='codex-cli' ORDER BY component_key").all()).toEqual(components)
        expect(db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(carrier.id)).toEqual(effects)
        expect(fs.readFileSync(configFile)).toEqual(before)
      }
      return
    }
    expect(repeated.results[0]).toMatchObject({status:'awaiting_verification'})
    await composition.runtime.markScanCompleted()
    await composition.runtime.runMaintenance()
    expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(carrier.id)).toEqual({state:'cancelled',failure_code:'superseded_by_same_generation_connect'})
    expect(db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(carrier.id)).toEqual(effects)
    expect(fs.readFileSync(configFile)).toEqual(before)
    // Confirm again through both the original writer and the other consumer.
    // Their current no-effect successors must retain the same physical carrier.
    for(const id of ['codex-cli','codex-desktop']){
      const preview=await composition.service.previewConnect([id],true)
      const applied=await composition.service.applyConnect(preview.planHash,[id])
      expect(applied.results[0],JSON.stringify(applied)).toMatchObject({status:'awaiting_verification'})
      await composition.runtime.runMaintenance()
    }
    expect(fs.readFileSync(configFile)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM projection_mutations WHERE run_id NOT IN (?,?)').get(carrier.id,
      (db.prepare("SELECT id FROM reconcile_runs WHERE installation_id='codex-desktop' ORDER BY rowid LIMIT 1").get() as {id:string}).id)).toEqual({n:0})
    expect(db.prepare("SELECT COUNT(*) AS n FROM reconcile_runs WHERE failure_code='journal_decode_failed'").get()).toEqual({n:0})
   }
   const consumers=db.prepare("SELECT installation_id FROM artifact_consumers WHERE component_key='memory_tools' AND state='active' ORDER BY installation_id").all()
   expect(consumers).toEqual([{installation_id:'codex-cli'},{installation_id:'codex-desktop'}])
   const hooksFile=path.join(configRoot,'hooks.json')
   const hooksBefore=fullLifecycle?fs.readFileSync(hooksFile,'utf8'):null
   const beforeDisconnect=fs.readFileSync(configFile,'utf8')
   const current=parse(beforeDisconnect).mcp_servers as Record<string,{env:Record<string,string>}>
   const token=current['tidemind-'+canonical].env.EB_ACTIVITY_GENERATION_TOKEN
   expect(evaluateBridgeAdmission(db,{agentId:canonical,activityGenerationToken:token,componentKey:'memory_tools'})).toEqual({allowed:true})
   // Actual MCP entrypoint, isolated HOME and no cloud credentials; no Agent host
   // or subscription is simulated as having passed acceptance.
   fs.mkdirSync(path.join(home,'.tidemind'),{recursive:true})
   fs.writeFileSync(path.join(home,'.tidemind','config.toml'),'[general]\ndata_dir = '+JSON.stringify(appData)+'\n')
   const mcp=new Client({name:'synthetic-shared-entrypoint',version:'1'})
   const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('node_modules/tsx/dist/cli.mjs'),path.resolve('src/index.ts')],
    env:{HOME:home,PATH:process.env.PATH ?? '/usr/bin:/bin',EB_AGENT_ID:canonical,EB_ACTIVITY_GENERATION_TOKEN:token},stderr:'pipe'})
   try{
    await mcp.connect(transport)
    const result=await mcp.callTool({name:'brain_prepare',arguments:{tool:'codex'}},undefined,{timeout:10000})
    expect(result.isError).not.toBe(true)
    expect(composition.repository.sharedConnectionStatus('codex-cli')?.status).toBe('call_observed')
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_host_activity_evidence').get()).toEqual({n:0})
   }finally{await mcp.close()}

   const oldRuns=db.prepare('SELECT id,installation_id,execution_plan_hash FROM reconcile_runs ORDER BY id').all() as Array<{id:string;installation_id:string;execution_plan_hash:string}>
   if(mode.startsWith('completed-waits')){
    db.exec("UPDATE reconcile_runs SET state='needs_recovery',failure_code=CASE WHEN installation_id='codex-cli' THEN 'recovery_source_trust_changed' ELSE 'verification_failed' END")
    expect(db.prepare("SELECT DISTINCT state FROM projection_mutations WHERE installation_id='codex-cli'").all()).toEqual([{state:'committed'}])
    expect(db.prepare("SELECT COUNT(*) AS n FROM projection_mutations WHERE installation_id='codex-desktop'").get()).toEqual({n:0})
    if(mode==='completed-waits-partial')db.exec("UPDATE projection_mutations SET state='effect_started' WHERE id=(SELECT id FROM projection_mutations LIMIT 1)")
    if(mode==='completed-waits-active')db.exec("UPDATE reconcile_runs SET state='applying' WHERE installation_id='codex-cli'")
    if(mode==='completed-waits-unbound')db.exec("DELETE FROM agent_identity_binding_members WHERE installation_id='codex-cli'")
    if(mode==='completed-waits-drift')fs.writeFileSync(configFile,fs.readFileSync(configFile,'utf8').replace('command = '+JSON.stringify(runtime.shimPath),'command = "changed"'))
   }
   if(mode==='completed-waits-rollback')db.exec("CREATE TRIGGER fail_disconnect_finalize BEFORE UPDATE OF desired_state ON agent_installations WHEN NEW.desired_state='removed' BEGIN SELECT RAISE(ABORT,'synthetic disconnect prepare failure'); END")
   const oldMutations=db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()
   const peerId=firstDisconnect==='codex-cli'?'codex-desktop':'codex-cli'
   const oldPeer=db.prepare("SELECT * FROM reconcile_runs WHERE installation_id=?").get(peerId)
   const statesBefore=db.prepare('SELECT id,state,failure_code,execution_plan_hash FROM reconcile_runs ORDER BY id').all()
   if(mode.startsWith('completed-waits-')){
    const bytes=fs.readFileSync(configFile)
    try{
      const blocked=await composition.service.previewDisconnect(firstDisconnect)
      const result=await composition.service.disconnect(blocked.planHash,firstDisconnect)
      expect(result.results[0],JSON.stringify(result)).toMatchObject({status:'failed'})
      if(mode==='completed-waits-rollback')expect(result.results[0].reason).toContain('synthetic disconnect prepare failure')
    }catch(error){expect(String(error)).toMatch(/conflict|scope|binding|changed|drift|owned|managed|shared|disconnect/i)}
    expect(db.prepare('SELECT id,state,failure_code,execution_plan_hash FROM reconcile_runs ORDER BY id').all()).toEqual(statesBefore)
    expect(fs.readFileSync(configFile)).toEqual(bytes)
    expect(db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()).toEqual(oldMutations)
    return
   }
   const first=await composition.service.previewDisconnect(firstDisconnect)
   const firstResult=await composition.service.disconnect(first.planHash,firstDisconnect)
   expect(firstResult.results[0],JSON.stringify(firstResult.results[0])).not.toMatchObject({status:'failed'})
   expect(fs.readFileSync(configFile,'utf8')).toBe(beforeDisconnect)
   if(hooksBefore!==null)expect(fs.readFileSync(hooksFile,'utf8')).toBe(hooksBefore)
   if(mode!=='completed-waits' || firstDisconnect==='codex-cli'){
    for(const componentKey of (fullLifecycle?['memory_tools','lifecycle']:['memory_tools']) as Array<'memory_tools'|'lifecycle'>){
     expect(evaluateBridgeAdmission(db,{agentId:canonical,activityGenerationToken:token,componentKey})).toEqual({allowed:true})
    }
   }else{
    // Detaching the zero-write peer cannot approve the still-unrecovered physical writer.
    expect(evaluateBridgeAdmission(db,{agentId:canonical,activityGenerationToken:token,componentKey:'memory_tools'})).toEqual({allowed:false,reason:'activity_generation_mismatch'})
   }
   if(mode==='completed-waits'){
    expect(db.prepare("SELECT * FROM reconcile_runs WHERE installation_id=?").get(peerId)).toEqual(oldPeer)
    expect(db.prepare('SELECT * FROM projection_mutations WHERE run_id IN (?,?) ORDER BY id').all(...oldRuns.map(run=>run.id))).toEqual(oldMutations)
    expect(db.prepare("SELECT state,failure_code FROM reconcile_runs WHERE id=?").get(oldRuns.find(run=>run.installation_id===firstDisconnect)!.id)).toEqual({state:'cancelled',failure_code:'superseded_by_disconnect'})
    expect(db.prepare("SELECT state,failure_code FROM reconcile_runs WHERE id=?").get(oldRuns.find(run=>run.installation_id!==firstDisconnect)!.id)).toEqual({state:'needs_recovery',failure_code:peerId==='codex-cli'?'recovery_source_trust_changed':'verification_failed'})
   }
   const last=await composition.service.previewDisconnect(firstDisconnect==='codex-cli'?'codex-desktop':'codex-cli')
   const lastResult=await composition.service.disconnect(last.planHash,firstDisconnect==='codex-cli'?'codex-desktop':'codex-cli')
   expect(lastResult.results[0],JSON.stringify(lastResult.results[0])).not.toMatchObject({status:'failed'})
   if(mode==='completed-waits')for(const old of oldRuns){
    expect(db.prepare('SELECT state,execution_plan_hash FROM reconcile_runs WHERE id=?').get(old.id)).toEqual({state:'cancelled',execution_plan_hash:old.execution_plan_hash})
   }
   expect((parse(fs.readFileSync(configFile,'utf8')).mcp_servers as Record<string,unknown> | undefined)?.['tidemind-'+canonical]).toBeUndefined()
   expect(evaluateBridgeAdmission(db,{agentId:canonical,activityGenerationToken:token,componentKey:'memory_tools'}).allowed).toBe(false)
   if(hooksBefore!==null){
    const hooks=JSON.parse(fs.readFileSync(hooksFile,'utf8')).hooks ?? {}
    for(const event of ['SessionStart','PreCompact','PostCompact','SessionEnd']){
      if(mode==='legacy-hooks-single' && event==='SessionStart')expect(hooks[event]).toEqual([thirdPartyHook])
      else expect(hooks[event]).toBeUndefined()
    }
   }

  }finally{unbind();composition.runtime.stop();db.close();fs.rmSync(root,{recursive:true,force:true})}
 },30000)
})
