
import {describe,it,expect,vi} from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/tm-upgrade-p0',getVersion:()=> '0.2.94-test',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {ensureSchema} from '../../src/db/schema'
import {bindAgentIntegrationExecutionPort,createProductionAgentIntegrationComposition} from '../../client/electron/agent-integration/production-service'
import {createOfficialCodexHooksPort} from '../../client/electron/agent-integration/hosts/codex-lifecycle-adapter'
import {createP0HostAdapters,P0_INSTRUCTION_SPECS} from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import {createCompositeHostAdapter} from '../../client/electron/agent-integration/hosts/composite-adapter'
import {createManagedTextHostAdapter} from '../../client/electron/agent-integration/hosts/managed-text-adapter'
import {createCodexMcpTomlHostAdapter} from '../../client/electron/agent-integration/hosts/codex-mcp-toml-adapter'
import {createJsonLifecycleHookHostAdapter,type ManagedHookEvent} from '../../client/electron/agent-integration/hosts/json-lifecycle-hook-adapter'
import {canonicalizeInstallationIdentity} from '../../client/electron/agent-integration/identity'
import {CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,MAX_CLI_EXECUTABLE_PROOF_BYTES,type DiscoveredInstallation} from '../../client/electron/agent-integration/discovery'
import {persistedProjectionSurfaceFingerprint} from '../../client/electron/agent-integration/repository'
import {sha256Json} from '../../client/electron/agent-integration/fingerprint'
import {shellArgument} from '../../client/electron/agent-integration/shell-argument'
import type {AdapterRuntimeContext,AgentHostAdapter,CatalogId,JsonValue,ComponentVerificationResult} from '../../client/electron/agent-integration/types'

// Frozen old recipe through the production coordinator; new side uses the real
// production five-hook adapter. Synthetic verification is only for settled-old cases.
const variants=['codex-cli','codex-desktop'] as const
type Variant=typeof variants[number]
const verified:AgentHostAdapter['verify']=async(context,request)=>request.componentKeys.map(componentKey=>({
 componentKey,status:'verified',verifiedCapability:request.expectedCapability,identityAssertion:context.agentId,
 invalidationKeys:['artifact_hash','adapter_version'],diagnostics:['synthetic_P0_host_verification'],
} as ComponentVerificationResult))

describe('P0 Codex four-to-five public upgrade boundaries',()=>{
 it.each(variants.flatMap(first=>['waiting','waiting-owner-only','waiting-joiner-only','settled','settled-sequential','partial','drift','revoked','paused-peer','resumed-peer','profile','execution-fence','prepare-rollback','batch-file-drift','batch-receipt-drift','peer-source-after-preview','waiting-recovery','peer-await-fence-loss'].map(mode=>({first,mode}))))(
 '$first first / $mode',async({first,mode})=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-upgrade-p0-')))
 const home=path.join(root,'home'),appData=path.join(root,'app-data'),configRoot=path.join(home,'.codex')
 for(const dir of [home,path.join(appData,'graph'),path.join(root,'bin')])fs.mkdirSync(dir,{recursive:true})
 const db=new Database(path.join(appData,'graph','brain.sqlite'));ensureSchema(db)
 const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
 shimPath:path.join(root,'bin','node'),mcpServerPath:path.join(root,'bin','mcp.cjs'),hookScriptPath:path.join(root,'bin','start.cjs'),
 preCompactScriptPath:path.join(root,'bin','pre.cjs'),postCompactScriptPath:path.join(root,'bin','post.cjs'),
 tideMindVersion:'0.2.94-test',catalogVersion:'1',projectionVersion:'1'}
 const discoveredSamples:DiscoveredInstallation[]=[]
 let rejectPeerSource=false
 let armPeerFenceLoss=false,peerAwaitLostFence=false,activeWriterLeases=0
 const compose=(adapters:ReadonlyMap<CatalogId,AgentHostAdapter>)=>createProductionAgentIntegrationComposition(db,{
  homeDir:home,applicationDataDir:appData,runtimeContext:runtime,adapters,enabledAdapterIds:variants,
  observeOnly:false,startRuntime:false,fixtureMode:'isolated_ui_audit',canManageInstallation:()=>true,
  liveTrustAttestor:async row=>{
    if(armPeerFenceLoss && row.id==='b-joiner' && activeWriterLeases>0){
      await Promise.resolve()
      peerAwaitLostFence=true
    }
    return rejectPeerSource && row.id==='b-joiner'?null:sha256Json({fixtureTrust:persistedProjectionSurfaceFingerprint(row)})
  },
  scanner:{scan:async()=>({installations:discoveredSamples,unresolved:[],diagnostics:[]})},notifications:{deliver:vi.fn()},
 })
 const frozenRecipe=fs.readFileSync(new URL('../fixtures/codex-rust-v0.157.1/tidemind-four-hook-recipe-ed1e452d.json',import.meta.url),'utf8')
 const oldAdapters=new Map<CatalogId,AgentHostAdapter>()
 for(const variant of variants){
  const oldLifecycle=createJsonLifecycleHookHostAdapter({catalogId:variant,adapterVersion:'1',
   configFile:()=>path.join(configRoot,'hooks.json'),eventRoot:['hooks'],activationMode:'qwen_default_enabled',reload:'new_session',
   events:context=>{
    const recipe=JSON.parse(frozenRecipe.replaceAll('<ROOT>',root).replaceAll('<GENERATION>',context.activityGenerationToken!)
      .replaceAll('agent-a-owner',context.agentId)).hooks as Record<string,JsonValue[]>
    return Object.entries(recipe).map(([eventName,entries])=>({eventName,entry:entries[0],
     signalName:eventName==='SessionStart'?'session_start':eventName==='SessionEnd'?'session_end':eventName==='PreCompact'?'pre_compact':'post_compact'} as ManagedHookEvent))
   },
   identifiesEntry:(_event,candidate,context)=>JSON.stringify(candidate).includes(shellArgument('--agent-id')+' '+shellArgument(context.agentId))
    && (!context.activityGenerationToken || JSON.stringify(candidate).includes(shellArgument('--activity-generation-token')+' '+shellArgument(context.activityGenerationToken))),
  })
  oldAdapters.set(variant,createCompositeHostAdapter(variant,[createManagedTextHostAdapter(P0_INSTRUCTION_SPECS[variant]!),
   createCodexMcpTomlHostAdapter({catalogId:variant,adapterVersion:'1'}),oldLifecycle]))
 }
 if(mode.startsWith('settled'))for(const variant of variants){const adapter=oldAdapters.get(variant)!;oldAdapters.set(variant,{...adapter,verify:verified})}
 let composition=compose(oldAdapters),unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
 let heldExecutionFence: {release():void}|null=null
 const idFor=(variant:Variant)=>variant===first?'a-owner':'b-joiner' // public batches sort IDs
 const discover=(variant:Variant)=>{
  const executable=path.join(root,'bin',variant);fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
  const identity=canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'p0-fixture-user',productFamilyId:'codex',
   hostVariant:variant,configRoot,distribution:{distributionId:'cli:'+variant,executableRealpath:executable,packageProvenance:'fixture',capabilityFingerprint:'P0-'+variant}})
  discoveredSamples.push({catalogId:variant,displayName:variant,identity,configRoot,executablePath:executable,
    detectedVersion:variant==='codex-cli'?'0.157.1':'26.901.41600',provenance:['fixture'],evidence:[],
    managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}})
  composition.repository.upsertDiscoveredInstallation({id:idFor(variant),family:'codex',hostVariant:variant,runtimeRealm:'local_macos',
   osUserIdentity:'p0-fixture-user',installKey:identity.installKey,distributionId:'cli:'+variant,provenance:'fixture',displayName:variant,
   configRoot,executablePath:executable,detectedVersion:variant==='codex-cli'?'0.157.1':'26.901.41600',agentId:'agent-'+idFor(variant),
   supportedCapability:4,lastDetectedAt:'2026-10-27T00:00:00Z',metadata:{distribution:identity.distribution,
    managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})
 }
 try{
  for(const variant of variants)discover(variant)
  const owner='a-owner',joiner='b-joiner',ids=[owner,joiner]
  for(const id of ids){
   const preview=await composition.service.previewConnect([id],true)
   const outcome=await composition.service.applyConnect(preview.planHash,[id])
   expect(outcome.results[0],JSON.stringify(outcome)).toMatchObject({status:mode.startsWith('settled')?'committed':'awaiting_verification'})
  }
  const hooksFile=path.join(configRoot,'hooks.json')
  const oldDocument=JSON.parse(fs.readFileSync(hooksFile,'utf8'))
  expect(Object.keys(oldDocument.hooks).sort()).toEqual(['PostCompact','PreCompact','SessionEnd','SessionStart'])
  const frozenFour=JSON.parse(fs.readFileSync(new URL('../fixtures/codex-rust-v0.157.1/tidemind-four-hook-recipe-ed1e452d.json',import.meta.url),'utf8'))
  expect(JSON.parse(JSON.stringify(oldDocument).replaceAll(root,'<ROOT>').replace(/operation_[a-z0-9-]+/g,'<GENERATION>'))).toEqual(frozenFour)
  const ownerRun=db.prepare("SELECT id,state FROM reconcile_runs WHERE installation_id=? AND operation_type='connect'").get(owner) as {id:string;state:string}
  expect(db.prepare("SELECT COUNT(*) AS n FROM projection_mutations WHERE run_id=? AND state='committed' AND apply_receipt_json IS NOT NULL").get(ownerRun.id)).toEqual({n:3})
  expect(db.prepare("SELECT COUNT(*) AS n FROM projection_mutations WHERE installation_id=?").get(joiner)).toEqual({n:0})
  if(mode==='partial')db.prepare("UPDATE projection_mutations SET state='effect_observed',apply_receipt_json=NULL WHERE run_id=? AND component_key='lifecycle'").run(ownerRun.id)
  if(mode==='revoked')db.prepare("UPDATE agent_consents SET status='revoked' WHERE installation_id=?").run(owner)
  if(mode==='paused-peer' || mode==='resumed-peer'){
    composition.service.pause(joiner)
    expect(composition.repository.getInstallation(joiner)?.desired_state).toBe('disabled')
    if(mode==='resumed-peer'){
      await composition.service.resume(joiner)
      expect(composition.repository.getInstallation(joiner)?.desired_state).toBe('managed')
    }
  }
  if(mode==='profile')db.prepare("UPDATE agent_installations SET profile_id='different-profile' WHERE id=?").run(joiner)

  // Third-party hook is always retained; drift mode modifies an owned command.
  oldDocument.hooks.Stop=[{hooks:[{type:'command',command:'third-party-P0'}]}]
  if(mode==='drift')oldDocument.hooks.SessionStart[0].hooks[0].command+=' external-change'
  fs.writeFileSync(hooksFile,JSON.stringify(oldDocument,null,2)+'\n')
  const beforeBytes=fs.readFileSync(hooksFile),oldJournals=db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()
  const oldRuns=db.prepare('SELECT * FROM reconcile_runs ORDER BY id').all()
  const oldPeerCapability=composition.repository.getInstallation(joiner)!.verified_capability
  const assertUntouched=()=>{
    expect(fs.readFileSync(hooksFile)).toEqual(beforeBytes)
    expect(db.prepare('SELECT * FROM reconcile_runs ORDER BY id').all()).toEqual(oldRuns)
    expect(db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()).toEqual(oldJournals)
    if(mode==='paused-peer')expect(composition.repository.getInstallation(joiner)?.desired_state).toBe('disabled')
  }

  const candidates=createP0HostAdapters({codexHooksPort:createOfficialCodexHooksPort({managedPolicyPaths:[]})})
  unbind();composition.runtime.stop();composition=compose(candidates);unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
  if(mode==='waiting-recovery'){
    const recovered=await composition.coordinator.recoverNonTerminalRuns()
    expect(recovered.every(item=>item.status==='needs_recovery')).toBe(true)
    expect(db.prepare("SELECT DISTINCT failure_code FROM reconcile_runs WHERE state='needs_recovery'").all()).toEqual([{failure_code:'adapter_generation_changed'}])
  }
  const requestedIds=mode==='waiting-owner-only' || mode==='paused-peer'?[owner]:mode==='waiting-joiner-only'?[joiner]:ids
  let preview
  try{preview=await composition.service.previewConnect(requestedIds,true)}catch(error){
   expect(['partial','revoked','drift','paused-peer','profile'],String(error)+JSON.stringify(db.prepare('SELECT id,desired_state,health_state,status_reason FROM agent_installations').all())).toContain(mode)
   expect(String(error)).toMatch(/ownership|conflict|precondition|domain changed/i)
   assertUntouched();return
  }
  if(mode==='settled-sequential'){
   for(const id of ids){
    const step=await composition.service.previewConnect([id],true)
    const applied=await composition.service.applyConnect(step.planHash,[id])
    expect(applied.results[0],JSON.stringify(applied)).toMatchObject({status:'awaiting_verification'})
   }
   expect(JSON.parse(fs.readFileSync(hooksFile,'utf8')).hooks.UserPromptSubmit).toHaveLength(1)
   expect(JSON.parse(fs.readFileSync(hooksFile,'utf8')).hooks.Stop).toEqual(oldDocument.hooks.Stop)
   for(const old of oldRuns)expect(db.prepare('SELECT * FROM reconcile_runs ORDER BY id').all()).toContainEqual(old)
   for(const old of oldJournals)expect(db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()).toContainEqual(old)
   return
  }
  if(mode==='execution-fence'){
    heldExecutionFence=composition.coordinatorRepository.acquireExecutionFence(ownerRun.id)
    expect(heldExecutionFence).not.toBeNull()
  }
  if(mode==='prepare-rollback')db.exec("CREATE TRIGGER p3_reject_prepare BEFORE INSERT ON projection_mutations BEGIN SELECT RAISE(ABORT,'P3 fixture late prepare rollback'); END")
  const batchDrift=mode==='batch-file-drift' || mode==='batch-receipt-drift'
  let changedAfterFirst=false
  if(batchDrift)composition.service.onApplyTaskProgress(task=>{
    if(changedAfterFirst || task.results.length!==1 || task.results[0].status!=='awaiting_verification')return
    changedAfterFirst=true
    if(mode==='batch-file-drift')fs.appendFileSync(hooksFile,'\n ')
    else db.prepare("UPDATE projection_mutations SET apply_receipt_json=NULL WHERE run_id=? AND component_key='lifecycle'").run(task.results[0].runId)
  })
  if(mode==='peer-source-after-preview')rejectPeerSource=true
  if(mode==='peer-await-fence-loss'){
    const acquire=composition.coordinatorRepository.acquireWriterFence.bind(composition.coordinatorRepository)
    vi.spyOn(composition.coordinatorRepository,'acquireWriterFence').mockImplementation(domain=>{
      const lease=acquire(domain)
      if(!lease)return lease
      activeWriterLeases++
      let released=false
      return {...lease,assertOwned:async()=>{
        if(peerAwaitLostFence)throw new Error('P3 fixture lease lost after peer source')
        await lease.assertOwned()
      },release:()=>{
        if(!released){released=true;activeWriterLeases--}
        return lease.release()
      }}
    })
    armPeerFenceLoss=true
  }

  const task=composition.service.startApplyConnect(preview.planHash,requestedIds)
  await vi.waitFor(()=>expect(composition.service.getApplyTask(task.id).pendingInstallationIds).toEqual([]))
  const result=composition.service.getApplyTask(task.id)
  console.info('P0_UPGRADE_RESULT',JSON.stringify({first,mode,results:result.results}))
  if(batchDrift){
   expect(changedAfterFirst).toBe(true)
   expect(result.results[0]).toMatchObject({status:'awaiting_verification'})
   expect(result.results[1],JSON.stringify(result)).toMatchObject({status:'failed'})
   expect(result.results[1].reason).toMatch(mode==='batch-file-drift'?/carrier changed/i:/carrier evidence changed|receipt|carrier is not proven|carrier is not complete/i)
   expect(db.prepare("SELECT COUNT(*) AS n FROM projection_mutations WHERE run_id=?").get(result.results[0].runId)).toEqual({n:2})
   expect(db.prepare("SELECT COUNT(*) AS n FROM reconcile_runs WHERE installation_id=? AND id NOT IN (?,?)").get(joiner,...(oldRuns as {id:string}[]).map(run=>run.id))).toEqual({n:0})
   expect(composition.repository.getInstallation(joiner)!.verified_capability).toBeLessThanOrEqual(oldPeerCapability)
  }else if(mode.startsWith('settled') || mode.startsWith('waiting') || mode==='resumed-peer'){
   expect(result.results.every(item=>item.status==='awaiting_verification'),JSON.stringify(result)).toBe(true)
   expect(JSON.parse(fs.readFileSync(hooksFile,'utf8')).hooks.UserPromptSubmit).toHaveLength(1)
  }else{
   expect(result.results.every(item=>item.status==='failed'),JSON.stringify(result)).toBe(true)
   if(mode==='execution-fence')expect(result.results[0].reason).toContain('prior generation is executing')
   if(mode==='prepare-rollback')expect(result.results[0].reason).toBe('P3 fixture late prepare rollback')
   if(mode==='peer-source-after-preview')expect(result.results[0].reason).toBe('Recipe upgrade peer source trust changed')
   if(mode==='peer-await-fence-loss'){
     expect(peerAwaitLostFence).toBe(true)
     expect(result.results[0].reason).toBe('P3 fixture lease lost after peer source')
     expect(activeWriterLeases).toBe(0)
   }
   assertUntouched()
  }
  expect(JSON.parse(fs.readFileSync(hooksFile,'utf8')).hooks.Stop).toEqual(oldDocument.hooks.Stop)
  for(const old of oldJournals)expect(db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()).toContainEqual(old)
  for(const old of oldRuns as Array<Record<string,unknown>>){
   const current=db.prepare('SELECT prepared_plan_json,execution_plan_hash FROM reconcile_runs WHERE id=?').get(old.id)
   expect(current).toEqual({prepared_plan_json:old.prepared_plan_json,execution_plan_hash:old.execution_plan_hash})
  }
  expect(db.pragma('foreign_key_check')).toEqual([])
 }finally{heldExecutionFence?.release();unbind();composition.runtime.stop();db.close();fs.rmSync(root,{recursive:true,force:true})}
 },30000)
})
