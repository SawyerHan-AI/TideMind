
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/tm-shared-codex',getVersion:()=> '0.2.94-test',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { parse } from 'smol-toml'
import { ensureSchema } from '../../src/db/schema'
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard'
import { bindAgentIntegrationExecutionPort,createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import { createOfficialCodexHooksPort } from '../../client/electron/agent-integration/hosts/codex-lifecycle-adapter'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'

describe('Fresh Codex domain through production service',()=>{
 it.each([
  ...['source-noop','source-noop-partial','source-noop-drift','source-noop-different-source'].map(mode=>['codex-desktop',mode] as const),
  ['codex-cli','reconnect-batch-disconnect-fence'],
  ['codex-cli','reconnect-batch-recovery-disconnect'],
  ...['verify','partial','drift'].map(mode=>['codex-cli','reconnect-batch-recovery-'+mode] as const),
  ['codex-cli','reconnect-batch'],['codex-desktop','reconnect-batch'],['codex-cli','reconnect-batch-drift'],['codex-cli','reconnect-batch-pending-history'],['codex-cli','applied-pending'],['codex-cli','applied-pending-drift'],['codex-cli','applied-pending-readback-error'],['codex-cli','applied-pending-error-revoke'],['codex-cli','applied-pending-source'],['codex-cli','applied-pending-authorization-race'],['codex-cli','applied-pending-revoke'],['codex-cli','applied-pending-disconnect'],['codex-cli','applied-pending-manual'],['codex-cli','applied-healthy'],['codex-cli','native-trust-confirm'],['codex-cli','native-trust-confirm-drift'],['codex-cli','native-trust-join'],['codex-cli','native-trust-join-paused'],['codex-cli','native-trust-join-no-current-run'],['codex-cli','native-trust-join-revoked'],['codex-cli','native-trust-join-component-consent'],['codex-cli','reconnect-batch-profile'],['codex-cli','reconnect-batch-realm'],['codex-cli','reconnect-batch-root'],['codex-cli',false],['codex-desktop',false],['codex-cli',true],['codex-desktop',true],
  ['codex-cli','batch'],['codex-desktop','batch'],['codex-cli','batch-drift'],['codex-cli','removed'],['codex-desktop','disabled'],['codex-desktop','old-unbound'],['codex-desktop','old-unbound-incomplete'],['codex-cli','competing'],['codex-cli','different-root'],['codex-cli','unknown-carrier'],
 ] as const)('connects %s first, late discovery %s, without legacy seeds',async(first,late)=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-shared-flow-')))
  const home=path.join(root,'home'),configRoot=path.join(home,'.codex'),appData=path.join(root,'app-data')
  for(const dir of [home,appData,path.join(root,'bin')])fs.mkdirSync(dir,{recursive:true})
  fs.mkdirSync(path.join(appData,'graph'),{recursive:true})
  const db=new Database(path.join(appData,'graph','brain.sqlite'));ensureSchema(db)
  const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
   shimPath:path.join(root,'bin','tm-node'),mcpServerPath:path.join(root,'bin','mcp-server.cjs'),
   hookScriptPath:path.join(root,'bin','hook.cjs'),preCompactScriptPath:path.join(root,'bin','pre.cjs'),
   postCompactScriptPath:path.join(root,'bin','post.cjs'),tideMindVersion:'0.2.94-test',catalogVersion:'1',projectionVersion:'1'}

  const adapters=createP0HostAdapters({codexHooksPort:createOfficialCodexHooksPort({managedPolicyPaths:[]})})
  const composition=createProductionAgentIntegrationComposition(db,{homeDir:home,applicationDataDir:appData,runtimeContext:runtime,
    adapters,enabledAdapterIds:['codex-cli','codex-desktop'],observeOnly:false,startRuntime:false,fixtureMode:'isolated_ui_audit',
    canManageInstallation:()=>true,scanner:{scan:async()=>({installations:[],unresolved:[],diagnostics:[]})},notifications:{deliver:vi.fn()}})
  const unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
  const discoveredIdentities=new Map<string,ReturnType<typeof canonicalizeInstallationIdentity>>()
  const discover=(variant:'codex-cli'|'codex-desktop',domainRoot=configRoot,versionOverride?:string,provenanceOverride?:string)=>{
    const installationId=variant
    // Public batching sorts IDs; swap host assignments to exercise both physical writers.
    if(String(late).startsWith('reconnect-batch') && first==='codex-desktop')variant=variant==='codex-cli'?'codex-desktop':'codex-cli'
    const executable=path.join(root,'bin',variant);fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
    const identity=canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'synthetic-user',
     productFamilyId:'codex',hostVariant:variant,configRoot:domainRoot,distribution:{distributionId:'cli:'+variant,executableRealpath:executable,packageProvenance:provenanceOverride ?? 'fixture',capabilityFingerprint:'fixture-'+variant}})
    discoveredIdentities.set(installationId,identity)
    composition.repository.upsertDiscoveredInstallation({id:installationId,family:'codex',hostVariant:variant,runtimeRealm:'local_macos',
      osUserIdentity:'synthetic-user',installKey:identity.installKey,distributionId:'cli:'+variant,provenance:'fixture',displayName:variant,
      configRoot:domainRoot,executablePath:executable,detectedVersion:versionOverride ?? (variant==='codex-cli'?'0.153.4':'26.901.41600'),agentId:'original-'+installationId,
      supportedCapability:4,lastDetectedAt:'2026-10-23T00:00:00Z',metadata:{distribution:identity.distribution,
        managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})

  }
  try {
    const second=first==='codex-cli'?'codex-desktop':'codex-cli'
    const reconnectBatch=String(late).startsWith('reconnect-batch')
    const options=(ids:string[])=>(reconnectBatch || String(late).startsWith('applied-') || String(late).startsWith('native-trust-') || String(late).startsWith('source-noop'))?undefined:{withoutLifecycleInstallationIds:ids}
    discover(first)
    if(String(late).startsWith('source-noop') || reconnectBatch || late===false || late==='competing' || String(late).startsWith('batch'))discover(second)
    expect(fs.existsSync(configRoot)).toBe(false)
    if(late==='unknown-carrier'){
      fs.mkdirSync(configRoot)
      const bytes='[mcp_servers.tidemind-unrecognized]\ncommand="unknown-command"\n'
      fs.writeFileSync(path.join(configRoot,'config.toml'),bytes)
      await expect(composition.service.previewConnect([first],true,undefined,options([first])))
        .rejects.toThrow('existing_codex_connection_requires_review')
      expect(fs.readFileSync(path.join(configRoot,'config.toml'),'utf8')).toBe(bytes)
      expect(db.prepare('SELECT count(*) AS n FROM agent_identity_bindings').get()).toEqual({n:0})
      return
    }
    const batch=typeof late==='string' && late.startsWith('batch')
    const canonical='original-'+(batch?'codex-cli':first)
    const firstIds=batch?[first,second]:[first]
    const priorBehavior=String(late).startsWith('old-unbound')?vi.spyOn(composition.repository,'previewFreshCodexIdentity').mockReturnValue(null):null
    const firstPreview=await composition.service.previewConnect(firstIds,true,undefined,options(firstIds))
    expect(fs.existsSync(configRoot)).toBe(false)
    expect(db.prepare('SELECT count(*) AS n FROM agent_identity_bindings').get()).toEqual({n:0})
    const competing=late==='competing'?await composition.service.previewConnect([second],true,undefined,options([second])):null
    let result: {results:Array<{status:string;reason?:string}>}
    if(batch){
      if(late==='batch-drift')composition.service.onApplyTaskProgress(task=>{
        if(task.results.length===1)fs.appendFileSync(path.join(configRoot,'config.toml'),'# external change after first item\n')
      })
      const started=composition.service.startApplyConnect(firstPreview.planHash,firstIds)
      await vi.waitFor(()=>expect(composition.service.getApplyTask(started.id).pendingInstallationIds).toEqual([]))
      result=composition.service.getApplyTask(started.id)
      if(late==='batch-drift'){
        expect(result.results[0].status).toBe('awaiting_verification')
        expect(result.results[1]).toMatchObject({status:'failed',reason:'Shared batch carrier changed after first connection'})
        expect(db.prepare("SELECT count(*) AS n FROM artifact_consumers WHERE component_key='memory_tools' AND state='active'").get()).toEqual({n:1})
        return
      }
      expect(db.prepare("SELECT count(*) AS n FROM agent_integration_events WHERE kind='shared_batch_join_prepared'").get()).toEqual({n:1})
    } else result=await composition.service.applyConnect(firstPreview.planHash,firstIds)
    expect(result.results.every(item=>item.status==='awaiting_verification'),JSON.stringify(result)).toBe(true)
    priorBehavior?.mockRestore()
    const configFile=path.join(configRoot,'config.toml')
    if(String(late).startsWith('source-noop')){
      const joinPreview=await composition.service.previewConnect([second],true)
      const join=await composition.service.applyConnect(joinPreview.planHash,[second])
      expect(join.results[0],JSON.stringify(join)).toMatchObject({status:'awaiting_verification'})
      const old=db.prepare('SELECT * FROM reconcile_runs WHERE installation_id=?').get(first) as Record<string,string>
      const peer=db.prepare('SELECT * FROM reconcile_runs WHERE installation_id=?').get(second) as Record<string,string>
      expect(db.prepare('SELECT count(*) AS n FROM projection_mutations WHERE run_id=?').get(peer.id)).toEqual({n:0})
      expect(JSON.parse(peer.writer_fence_snapshot_json).mutationDomains).toEqual(JSON.parse(old.writer_fence_snapshot_json).mutationDomains)
      const oldEffects=db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(old.id)
      expect(oldEffects).toHaveLength(3)
      expect(oldEffects.every((row:any)=>row.state==='committed')).toBe(true)
      const physical=[configFile,path.join(configRoot,'hooks.json'),path.join(home,'.agents/skills/tidemind/SKILL.md')]
      const before=physical.map(file=>fs.readFileSync(file))
      discover(first,configRoot,'26.1029.61003',late==='source-noop-different-source'?'other-publisher':undefined)
      await composition.runtime.markScanCompleted()
      expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(old.id)).toEqual({state:'needs_recovery',failure_code:'recovery_source_trust_changed'})
      expect(db.prepare('SELECT state FROM reconcile_runs WHERE id=?').get(peer.id)).toEqual({state:'applied_unverified'})
      if(late==='source-noop-partial')db.prepare("UPDATE projection_mutations SET state='effect_started' WHERE run_id=? AND component_key='memory_tools'").run(old.id)
      if(late==='source-noop-drift')fs.writeFileSync(configFile,fs.readFileSync(configFile,'utf8').replace(runtime.shimPath,runtime.shimPath+'-externally-changed'))
      const beforeConfirm=physical.map(file=>fs.readFileSync(file))
      const runCount=(db.prepare('SELECT count(*) AS n FROM reconcile_runs').get() as {n:number}).n
      const applySpies=[...adapters.values()].map(adapter=>vi.spyOn(adapter,'apply'))
      const preview=await composition.service.previewConnect([first],true)
      const next=await composition.service.applyConnect(preview.planHash,[first])
      for(const apply of applySpies)expect(apply).not.toHaveBeenCalled()
      if(late!=='source-noop'){
        expect(next.results[0].status,JSON.stringify(next)).not.toBe('awaiting_verification')
        expect(db.prepare('SELECT state FROM reconcile_runs WHERE id=?').get(old.id)).toEqual({state:'needs_recovery'})
        expect(db.prepare('SELECT count(*) AS n FROM reconcile_runs').get()).toEqual({n:runCount})
        expect(db.prepare("SELECT count(*) AS n FROM agent_integration_events WHERE kind='completed_generation_superseded'").get()).toEqual({n:0})
        expect(physical.map(file=>fs.readFileSync(file))).toEqual(beforeConfirm)
        expect(db.prepare('SELECT state,consent_envelope_id,execution_plan_hash FROM reconcile_runs WHERE id=?').get(peer.id)).toEqual({state:'applied_unverified',consent_envelope_id:peer.consent_envelope_id,execution_plan_hash:peer.execution_plan_hash})
        return
      }
      expect(next.results[0],JSON.stringify(next)).toMatchObject({status:'awaiting_verification'})
      expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(old.id)).toEqual({state:'cancelled',failure_code:'superseded_by_confirmed_generation'})
      expect(db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(old.id)).toEqual(oldEffects)
      expect(db.prepare('SELECT state,consent_envelope_id,execution_plan_hash FROM reconcile_runs WHERE id=?').get(peer.id)).toEqual({state:'applied_unverified',consent_envelope_id:peer.consent_envelope_id,execution_plan_hash:peer.execution_plan_hash})
      expect(physical.map(file=>fs.readFileSync(file))).toEqual(before)
      const current=db.prepare('SELECT id,prepared_plan_json,writer_fence_snapshot_json FROM reconcile_runs WHERE installation_id=? AND id!=?').get(first,old.id) as {id:string;prepared_plan_json:string;writer_fence_snapshot_json:string}
      expect(JSON.parse(current.writer_fence_snapshot_json).mutationDomains).toEqual(JSON.parse(old.writer_fence_snapshot_json).mutationDomains)
      const plan=JSON.parse(current.prepared_plan_json)
      expect(plan.adapterPlan.mutations).toEqual([])
      expect(plan.executionPlan.hostVersion).toBe('26.1029.61003')
      expect(plan.executionPlan.completedGenerationTakeovers).toEqual([expect.objectContaining({runId:old.id,mutationDomains:JSON.parse(old.writer_fence_snapshot_json).mutationDomains})])
      expect(db.prepare('SELECT count(*) AS n FROM projection_mutations WHERE run_id=?').get(current.id)).toEqual({n:0})
      await composition.runtime.runMaintenance()
      expect(db.prepare('SELECT DISTINCT state FROM managed_artifacts').all()).toEqual([{state:'healthy'}])
      const token=JSON.parse(old.prepared_plan_json).activityGenerationToken
      for(const componentKey of ['memory_tools','lifecycle'] as const){
        expect(evaluateBridgeAdmission(db,{agentId:canonical,activityGenerationToken:token,componentKey})).toEqual({allowed:true})
        expect(evaluateBridgeAdmission(db,{agentId:canonical,activityGenerationToken:'stale-token',componentKey})).toEqual({allowed:false,reason:'activity_generation_mismatch'})
      }
      return
    }
    if(String(late).startsWith('native-trust-')){
      // Native trust state fixture; exercise the production verifier wiring, without an override.
      const join=String(late).startsWith('native-trust-join')
      const trustId=join?second:first
      if(join){
        discover(second)
        const preview=await composition.service.previewConnect([second],true)
        expect(preview.installations[0].targets.every(target=>target.action==='invoke')).toBe(true)
        const joined=await composition.service.applyConnect(preview.planHash,[second])
        expect(joined.results[0]).toMatchObject({status:'awaiting_verification'})
        expect(db.prepare("SELECT COUNT(*) AS n FROM projection_mutations WHERE installation_id=?").get(second)).toEqual({n:0})
        expect(db.prepare("SELECT state,desired_state FROM artifact_consumers WHERE installation_id=? AND component_key='lifecycle'").get(second)).toEqual({state:'active',desired_state:'disabled'})
      }
      const run=db.prepare("SELECT prepared_plan_json FROM reconcile_runs WHERE installation_id=? AND operation_type='connect'").get(trustId) as {prepared_plan_json:string}
      const token=JSON.parse(run.prepared_plan_json).activityGenerationToken
      expect(token).toBeTruthy()
      const context={runtime,installation:discoveredIdentities.get(trustId)!,installationId:trustId,agentId:canonical,
        operationId:'trust-fixture',hostVersion:composition.repository.getInstallation(trustId)!.detected_version!,activityGenerationToken:token}
      const hooks=await createOfficialCodexHooksPort({managedPolicyPaths:[]}).list(context)
      expect(hooks.hooks).toHaveLength(5)
      fs.appendFileSync(configFile,'\n'+hooks.hooks.map(hook=>'[hooks.state.'+JSON.stringify(hook.key)+']\ntrusted_hash = '+JSON.stringify(hook.currentHash)+'\n').join('\n'))
      const configBefore=fs.readFileSync(configFile)
      const review=await composition.service.reviewCodexHookTrust(trustId)
      expect(review.status).toBe('action_required')
      if(late==='native-trust-confirm-drift'){
        const hooksFile=path.join(configRoot,'hooks.json')
        fs.writeFileSync(hooksFile,fs.readFileSync(hooksFile,'utf8').replaceAll(token,'different-generation'))
      }
      if(late==='native-trust-join-paused'){
        composition.service.pause(trustId)
        await expect(composition.service.confirmCodexHookTrust(review.actionHash!)).rejects.toThrow()
        expect(composition.repository.getInstallation(trustId)?.desired_state).toBe('disabled')
        expect(db.prepare("SELECT count(*) AS n FROM agent_integration_events WHERE installation_id=? AND kind='codex_hook_trust_verified'").get(trustId)).toEqual({n:0})
        return
      }
      if(late==='native-trust-join-component-consent'){
        db.prepare("UPDATE installation_components SET consent_envelope_id=? WHERE installation_id=? AND component_key='lifecycle'").run(composition.repository.getInstallation(first)!.consent_envelope_id,trustId)
        await expect(composition.service.confirmCodexHookTrust(review.actionHash!)).rejects.toThrow('Codex hook trust Artifact binding changed')
        return
      }
      if(late==='native-trust-join-revoked'){
        db.prepare("UPDATE agent_consents SET status='revoked' WHERE installation_id=?").run(trustId)
        await expect(composition.service.confirmCodexHookTrust(review.actionHash!)).rejects.toThrow('Codex hook trust Artifact binding changed')
        return
      }
      if(late==='native-trust-join-no-current-run'){
        // A disabled consumer alone is insufficient; no exact pending connect remains.
        db.prepare("UPDATE reconcile_runs SET state='cancelled' WHERE installation_id=? AND operation_type='connect'").run(trustId)
        await expect(composition.service.confirmCodexHookTrust(review.actionHash!)).rejects.toThrow('Codex hook trust Artifact binding changed')
        return
      }
      const confirmation=await composition.service.confirmCodexHookTrust(review.actionHash!)
      expect(confirmation.status,JSON.stringify(confirmation)).toBe(late==='native-trust-confirm-drift'?'not_trusted':'trust_recorded')
      expect(fs.readFileSync(configFile)).toEqual(configBefore)
      if(join){
        expect(db.prepare("SELECT state,desired_state FROM artifact_consumers WHERE installation_id=? AND component_key='lifecycle'").get(trustId)).toEqual({state:'active',desired_state:'disabled'})
        expect(db.prepare("SELECT state FROM reconcile_runs WHERE installation_id=? AND operation_type='connect'").get(trustId)).toEqual({state:'applied_unverified'})
      }
      return
    }
    if(String(late).startsWith('applied-')){
      const skillFile=path.join(home,'.agents','skills','tidemind','SKILL.md')
      const physicalBefore=[configFile,skillFile,path.join(configRoot,'hooks.json')].map(file=>fs.readFileSync(file))
      const runBefore=db.prepare('SELECT * FROM reconcile_runs').all()
      const journalsBefore=db.prepare('SELECT * FROM projection_mutations').all()
      if(late!=='applied-healthy')db.prepare("UPDATE managed_artifacts SET state='removal_pending' WHERE ownership_key='document'").run()
      const adapter=adapters.get(first)!
      const original=adapter.readBack.bind(adapter)
      let recoveryReadbacks=0
      const readback=vi.spyOn(adapter,'readBack').mockImplementation(async(context,mutation)=>{
        recoveryReadbacks++
        if(late==='applied-pending-error-revoke'){
          db.prepare("UPDATE agent_consents SET status='revoked' WHERE installation_id=?").run(first)
          throw new Error('synthetic stale I/O failure')
        }
        if(late==='applied-pending-readback-error')throw new Error('synthetic readback I/O failure')
        if(late==='applied-pending-drift')fs.appendFileSync(skillFile,'\nexternal drift\n')
        const observation=await original(context,mutation)
        if(late==='applied-pending-revoke')db.prepare("UPDATE agent_consents SET status='revoked' WHERE installation_id=?").run(first)
        if(late==='applied-pending-disconnect')db.prepare("UPDATE agent_installations SET desired_state='removed',tombstoned_at='2026-10-27T00:00:00Z' WHERE id=?").run(first)
        if(late==='applied-pending-manual')db.prepare("UPDATE artifact_consumers SET state='removal_pending',desired_state='removal_pending' WHERE installation_id=? AND component_key='instruction'").run(first)
        return observation
      })
      const outcomes=await composition.coordinator.recoverNonTerminalRuns({canContinueRecovery:()=>{
        if(late==='applied-pending-authorization-race' && recoveryReadbacks>0)db.prepare("UPDATE agent_installations SET desired_state='removed',tombstoned_at='2026-10-27T00:00:00Z' WHERE id=?").run(first)
        return late!=='applied-pending-source' || recoveryReadbacks===0
      }})
      const physicalFailure=['applied-pending-drift','applied-pending-readback-error','applied-pending-source'].includes(late)
      const failureReason=late==='applied-pending-source'?'recovery_source_trust_changed':'verification_failed'
      expect(outcomes[0],JSON.stringify(outcomes)).toMatchObject(physicalFailure
        ? {status:'needs_recovery',reason:failureReason} : {status:'awaiting_verification'})
      expect(recoveryReadbacks).toBe(late==='applied-healthy'?0:1)
      if(physicalFailure){
        expect(db.prepare('SELECT state,failure_code,failure_stage FROM reconcile_runs').get()).toEqual({state:'needs_recovery',failure_code:failureReason,failure_stage:late==='applied-pending-source'?'startup_recovery':'host_verification'})
        const frozenFields='SELECT id,execution_plan_hash,prepared_plan_json,consent_envelope_id FROM reconcile_runs'
        expect(db.prepare(frozenFields).get()).toMatchObject(Object.fromEntries(Object.entries(runBefore[0] as object).filter(([key])=>['id','execution_plan_hash','prepared_plan_json','consent_envelope_id'].includes(key))))
      }else expect(db.prepare('SELECT * FROM reconcile_runs').all()).toEqual(runBefore)
      expect(db.prepare('SELECT * FROM projection_mutations').all()).toEqual(journalsBefore)
      const expectedState=physicalFailure?'needs_recovery':['applied-pending','applied-healthy'].includes(late)?'healthy':'removal_pending'
      expect(db.prepare("SELECT state FROM managed_artifacts WHERE ownership_key='document'").get()).toEqual({state:expectedState})
      if(late!=='applied-pending-drift')expect([configFile,skillFile,path.join(configRoot,'hooks.json')].map(file=>fs.readFileSync(file))).toEqual(physicalBefore)
      readback.mockRestore()
      if(late==='applied-pending'){
        const disconnect=await composition.service.previewDisconnect(first)
        const detached=await composition.service.disconnect(disconnect.planHash,first)
        expect(detached.results[0],JSON.stringify(detached)).not.toMatchObject({status:'failed'})
      }
      return
    }
    if(String(late).startsWith('old-unbound')){
      const bytes=fs.readFileSync(configFile,'utf8')
      const history=db.prepare('SELECT execution_plan_hash,prepared_plan_json FROM reconcile_runs').all()
      discover(second)
      await expect(composition.service.previewConnect([second],true,undefined,options([second])))
        .rejects.toThrow('codex_shared_identity_requires_disconnect_reconnect')
      expect(fs.readFileSync(configFile,'utf8')).toBe(bytes)
      expect(db.prepare('SELECT execution_plan_hash,prepared_plan_json FROM reconcile_runs').all()).toEqual(history)
      if(late==='old-unbound-incomplete'){
        // Fault injection: a real prior run loses its physical effect receipt.
        db.prepare('UPDATE projection_mutations SET apply_receipt_json=NULL WHERE run_id IN (SELECT id FROM reconcile_runs WHERE installation_id=?)').run(first)
      }
      const disconnect=await composition.service.previewDisconnect(first)
      const detached=await composition.service.disconnect(disconnect.planHash,first)
      expect(detached.results[0],JSON.stringify(detached)).not.toMatchObject({status:'failed'})
      if(late==='old-unbound-incomplete'){
        expect(db.prepare("SELECT count(*) AS n FROM reconcile_runs WHERE operation_type='connect' AND state='cancelled'").get()).toEqual({n:0})
        expect(db.prepare("SELECT count(*) AS n FROM reconcile_runs WHERE operation_type='connect' AND state='needs_recovery'").get()).toEqual({n:1})
        return
      }
      fs.unlinkSync(path.join(home,'.agents','skills','tidemind','SKILL.md'))
      await composition.coordinator.recoverNonTerminalRuns()
      const reconnect=await composition.service.previewConnect([first],true,undefined,options([first]))
      const connected=await composition.service.applyConnect(reconnect.planHash,[first])
      expect(connected.results[0],JSON.stringify(connected)).toMatchObject({status:'awaiting_verification'})
      const join=await composition.service.previewConnect([second],true,undefined,options([second]))
      const joined=await composition.service.applyConnect(join.planHash,[second])
      expect(joined.results[0],JSON.stringify(joined)).toMatchObject({status:'awaiting_verification'})
      expect(composition.repository.resolveAgentIdentity(second).canonicalAgentId).toBe('original-'+first)
      expect(Object.keys(parse(fs.readFileSync(configFile,'utf8')).mcp_servers as object)).toEqual(['tidemind-original-'+first])
      for(const old of history)expect(db.prepare('SELECT execution_plan_hash,prepared_plan_json FROM reconcile_runs').all()).toContainEqual(old)
      return
    }
    if(late==='different-root'){
      const bytes=fs.readFileSync(configFile,'utf8'),otherRoot=path.join(home,'.codex-other')
      discover(second,otherRoot)
      const preview=await composition.service.previewConnect([second],true,undefined,options([second]))
      expect(preview.installations[0].targets.some(target=>target.selector==='mcp_servers.tidemind-original-'+second && target.action==='create')).toBe(true)
      expect(composition.repository.resolveAgentIdentity(second).canonicalAgentId).toBe('original-'+second)
      expect(fs.readFileSync(configFile,'utf8')).toBe(bytes)
      expect(fs.existsSync(otherRoot)).toBe(false)
      expect(db.prepare('SELECT count(*) AS n FROM agent_identity_bindings').get()).toEqual({n:1})
      return
    }
    if(competing){
      const stale=await composition.service.applyConnect(competing.planHash,[second])
      expect(stale.results[0]).toMatchObject({status:'failed'})
      expect(Object.keys(parse(fs.readFileSync(configFile,'utf8')).mcp_servers as object)).toEqual(['tidemind-'+canonical])
    }
    if(late==='removed' || late==='disabled'){
      const firstBytes=fs.readFileSync(configFile,'utf8')
      if(late==='removed'){
        const disconnect=await composition.service.previewDisconnect(first)
        const detached=await composition.service.disconnect(disconnect.planHash,first)
        expect(detached.results[0],JSON.stringify(detached)).not.toMatchObject({status:'failed'})
      }else composition.service.pause(first)
      discover(second)
      if(late==='removed'){
        const pending=await composition.service.previewConnect([second],true,undefined,options([second]))
        const blocked=await composition.service.applyConnect(pending.planHash,[second])
        expect(blocked.results[0]).toMatchObject({status:'failed',reason:'ownership_conflict:instruction_adoption'})
        // Follow the existing manual whole-file removal action in this isolated fixture.
        fs.unlinkSync(path.join(home,'.agents','skills','tidemind','SKILL.md'))
        await composition.coordinator.recoverNonTerminalRuns()
      }
      const preview=await composition.service.previewConnect([second],true,undefined,options([second]))
      const joined=await composition.service.applyConnect(preview.planHash,[second])
      expect(joined.results[0],JSON.stringify(joined)+JSON.stringify(db.prepare('SELECT operation_type,state,failure_code,failure_stage FROM reconcile_runs').all())).toMatchObject({status:'awaiting_verification'})
      expect(composition.repository.resolveAgentIdentity(second).canonicalAgentId).toBe(canonical)
      expect(composition.repository.getInstallation(first)?.desired_state).toBe(late)
      if(late==='disabled')expect(fs.readFileSync(configFile,'utf8')).toBe(firstBytes)
      expect(Object.keys((parse(fs.readFileSync(configFile,'utf8')).mcp_servers ?? {}) as object)).toEqual(['tidemind-'+canonical])
      return
    }
    const beforeSecond=fs.readFileSync(configFile,'utf8')
    const servers=parse(beforeSecond).mcp_servers as Record<string,{env:Record<string,string>}>
    expect(Object.keys(servers)).toEqual(['tidemind-'+canonical])
    expect(servers[Object.keys(servers)[0]].env.EB_HOST_VARIANT).toBeUndefined()
    if(late===true)discover(second)
    const secondPreview=await composition.service.previewConnect([second],true,undefined,options([second]))
    expect(secondPreview.installations[0].targets.every(target=>target.action==='invoke')).toBe(true)
    const joined=await composition.service.applyConnect(secondPreview.planHash,[second])
    expect(joined.results[0],JSON.stringify(joined)).toMatchObject({status:'awaiting_verification'})
    expect(fs.readFileSync(configFile,'utf8')).toBe(beforeSecond)
    expect(composition.repository.resolveAgentIdentity(first).canonicalAgentId).toBe(canonical)
    expect(composition.repository.resolveAgentIdentity(second).canonicalAgentId).toBe(canonical)
    expect(composition.repository.getInstallation(second)?.agent_id).toBe('original-'+second)
    const retry=await composition.service.previewConnect([second],true,undefined,options([second]))
    expect((await composition.service.applyConnect(retry.planHash,[second])).results[0]).toMatchObject({status:'awaiting_verification'})
    const disconnect=await composition.service.previewDisconnect(first)
    const detached=await composition.service.disconnect(disconnect.planHash,first)
    expect(detached.results[0],JSON.stringify(detached)).not.toMatchObject({status:'failed'})
    expect(fs.readFileSync(configFile,'utf8')).toBe(beforeSecond)
    const last=await composition.service.previewDisconnect(second)
    const recoveryFence=late==='reconnect-batch-disconnect-fence'
    const domain=recoveryFence?(db.prepare("SELECT mutation_domain FROM managed_artifacts WHERE target_path=?").get(configFile) as {mutation_domain:string}).mutation_domain:null
    const heldLease=domain?composition.coordinatorRepository.acquireWriterFence(domain):null
    if(recoveryFence)expect(heldLease).not.toBeNull()
    let removed: Awaited<ReturnType<typeof composition.service.disconnect>>
    try { removed=await composition.service.disconnect(last.planHash,second) } finally { heldLease?.release() }
    expect(removed.results[0],JSON.stringify(removed)).not.toMatchObject({status:'failed'})
    if(recoveryFence){
      expect(removed.results[0]).toMatchObject({status:'needs_recovery'})
      expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(removed.results[0].runId)).toEqual({state:'needs_recovery',failure_code:'writer_fence_unavailable'})
      const recovered=await composition.coordinator.recoverNonTerminalRuns()
      expect(recovered).toContainEqual(expect.objectContaining({runId:removed.results[0].runId,status:'awaiting_verification'}))
      expect(db.prepare('SELECT component_key,state,attempt_count FROM projection_mutations WHERE run_id=? ORDER BY component_key').all(removed.results[0].runId)).toEqual([
        {component_key:'lifecycle',state:'committed',attempt_count:1},{component_key:'memory_tools',state:'committed',attempt_count:1},
      ])
    }
    expect(Object.keys((parse(fs.readFileSync(configFile,'utf8')).mcp_servers ?? {}) as object)).toEqual([])
    fs.unlinkSync(path.join(home,'.agents','skills','tidemind','SKILL.md'))
    await composition.coordinator.recoverNonTerminalRuns()
    expect(db.prepare("SELECT count(*) AS n FROM reconcile_runs WHERE state='needs_recovery'").get(),JSON.stringify(db.prepare('SELECT operation_type,state,failure_code,failure_stage FROM reconcile_runs').all())).toEqual({n:0})
    if(recoveryFence){
      expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(removed.results[0].runId)).toEqual({state:'committed',failure_code:null})
      return
    }
    const historyIds=db.prepare('SELECT id FROM verification_results ORDER BY id').all()
    expect(historyIds.length).toBeGreaterThan(0)
    if(reconnectBatch){
      if(late==='reconnect-batch-pending-history'){
        // Synthetic historical ledger residue matching r14; this is not a host acceptance.
        db.prepare("UPDATE managed_artifacts SET state='removal_pending',owned_fragment_hash=desired_fragment_hash WHERE ownership_key='document'").run()
      }
      const identityBefore=[first,second].map(id=>composition.repository.resolveAgentIdentity(id))
      const history=db.prepare('SELECT id,execution_plan_hash,prepared_plan_json FROM reconcile_runs ORDER BY id').all()
      const driftColumn=late==='reconnect-batch-profile'?'profile_id':late==='reconnect-batch-realm'?'runtime_realm':late==='reconnect-batch-root'?'config_root':null
      if(driftColumn){
        const before=fs.readFileSync(configFile)
        db.prepare('UPDATE agent_installations SET '+driftColumn+'=? WHERE id=?').run('different-domain',second)
        await expect(composition.service.previewConnect([second,first],true)).rejects.toThrow('Shared identity domain changed')
        expect(fs.readFileSync(configFile)).toEqual(before)
        return
      }
      const reconnect=await composition.service.previewConnect([second,first],true)
      const hookTargets=reconnect.installations.map(item=>item.targets.filter(target=>target.componentKey==='lifecycle'))
      expect(hookTargets[0]).toHaveLength(1)
      expect(hookTargets[1]).toHaveLength(1)
      const beforeJoinEvents=(db.prepare("SELECT count(*) AS n FROM agent_integration_events WHERE kind='shared_batch_join_prepared'").get() as {n:number}).n
      let carrierFiles:Buffer[]=[]
      const targets=[configFile,path.join(configRoot,'hooks.json'),path.join(home,'.agents','skills','tidemind','SKILL.md')]
      composition.service.onApplyTaskProgress(task=>{
        if(task.results.length===1){
          carrierFiles=targets.map(target=>fs.readFileSync(target))
          if(late==='reconnect-batch-drift')fs.appendFileSync(configFile,'# external edit during reconnect\n')
        }
      })
      const task=composition.service.startApplyConnect(reconnect.planHash,[second,first])
      await vi.waitFor(()=>expect(composition.service.getApplyTask(task.id).pendingInstallationIds).toEqual([]))
      const outcome=composition.service.getApplyTask(task.id)
      expect(outcome.results[0],JSON.stringify(outcome)).toMatchObject({status:'awaiting_verification'})
      if(late==='reconnect-batch-drift'){
        expect(outcome.results[1]).toMatchObject({status:'failed',reason:'Shared batch carrier changed after first connection'})
      }else{
        expect(outcome.results[1],JSON.stringify(outcome)).toMatchObject({status:'awaiting_verification'})
        expect(targets.map(target=>fs.readFileSync(target))).toEqual(carrierFiles)
        expect(db.prepare("SELECT count(*) AS n FROM agent_integration_events WHERE kind='shared_batch_join_prepared'").get()).toEqual({n:beforeJoinEvents+1})
        const runs=db.prepare("SELECT prepared_plan_json FROM reconcile_runs WHERE operation_type='connect' AND state!='cancelled' ORDER BY created_at").all() as {prepared_plan_json:string}[]
        expect(new Set(runs.map(run=>JSON.parse(run.prepared_plan_json).activityGenerationToken)).size).toBe(1)
        const plans=runs.map(run=>JSON.parse(run.prepared_plan_json))
        const hookHashes=plans.map(plan=>plan.inspection.components.find((component:{componentKey:string})=>component.componentKey==='lifecycle')?.observedFragmentHash).filter(Boolean)
        const writtenHook=plans.flatMap(plan=>plan.adapterPlan.mutations).find(mutation=>mutation.componentKey==='lifecycle')
        expect(hookHashes).toContain(writtenHook.desiredFragmentHash)
        expect(db.prepare("SELECT count(*) AS n FROM projection_mutations WHERE run_id IN (SELECT id FROM reconcile_runs WHERE operation_type='connect' AND state!='cancelled')").get()).toEqual({n:3})
      }
      expect([first,second].map(id=>composition.repository.resolveAgentIdentity(id))).toEqual(identityBefore)
      expect(Object.keys(parse(fs.readFileSync(configFile,'utf8')).mcp_servers as object)).toEqual(['tidemind-'+canonical])
      for(const previous of history)expect(db.prepare('SELECT id,execution_plan_hash,prepared_plan_json FROM reconcile_runs').all()).toContainEqual(previous)
      expect(db.pragma('foreign_key_check')).toEqual([])
      if(String(late).startsWith('reconnect-batch-recovery-')){
        const owner=outcome.results[0]
        const ownerRun=db.prepare('SELECT prepared_plan_json,execution_plan_hash FROM reconcile_runs WHERE id=?').get(owner.runId) as {prepared_plan_json:string;execution_plan_hash:string}
        const ownerPlan=JSON.parse(ownerRun.prepared_plan_json)
        expect(ownerPlan.codexFreshIdentity).toBeUndefined()
        expect(ownerPlan.executionPlan.sharedIdentityBinding).toBeTruthy()
        const effects=db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(owner.runId)
        expect(effects).toHaveLength(3)
        for(const effect of effects)expect(effect).toMatchObject({state:'committed',attempt_count:1})
        if(late==='reconnect-batch-recovery-disconnect'){
          discover(owner.installationId as 'codex-cli'|'codex-desktop',configRoot,'0.154.0')
          await composition.runtime.markScanCompleted()
          expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(owner.runId)).toEqual({state:'needs_recovery',failure_code:'recovery_source_trust_changed'})
        }else{
          const ownerAdapter=adapters.get(composition.repository.getInstallation(owner.installationId)!.host_variant as 'codex-cli'|'codex-desktop')!
          vi.spyOn(ownerAdapter,'verify').mockImplementationOnce(async (_context,request)=>request.componentKeys.map(componentKey=>({
            componentKey,status:'failed' as const,verifiedCapability:null,invalidationKeys:[],diagnostics:['synthetic reconnect verification failure'],
          })))
          await composition.coordinator.recoverNonTerminalRuns()
          expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(owner.runId)).toEqual({state:'needs_recovery',failure_code:'verification_failed'})
          expect(db.prepare('SELECT DISTINCT state FROM managed_artifacts WHERE id IN (SELECT artifact_id FROM projection_mutations WHERE run_id=?)').all(owner.runId)).toEqual([{state:'needs_recovery'}])
        }
        if(late==='reconnect-batch-recovery-partial')db.prepare("UPDATE projection_mutations SET state='effect_started' WHERE run_id=? AND component_key='memory_tools'").run(owner.runId)
        if(late==='reconnect-batch-recovery-drift')fs.writeFileSync(configFile,fs.readFileSync(configFile,'utf8').replace(runtime.shimPath,runtime.shimPath+'-changed'))
        if(late==='reconnect-batch-recovery-partial'||late==='reconnect-batch-recovery-drift'){
          const before=db.prepare('SELECT * FROM reconcile_runs ORDER BY id').all(),artifacts=db.prepare('SELECT * FROM managed_artifacts ORDER BY id').all()
          const bytes=targets.map(target=>fs.readFileSync(target))
          let failure: unknown
          try {
            const preview=await composition.service.previewDisconnect(owner.installationId)
            const result=await composition.service.disconnect(preview.planHash,owner.installationId)
            failure=result.results[0].status==='failed'?result.results[0].reason:undefined
          }catch(error){failure=error}
          expect(failure).toBeTruthy()
          expect(db.prepare('SELECT * FROM reconcile_runs ORDER BY id').all()).toEqual(before)
          expect(db.prepare('SELECT * FROM managed_artifacts ORDER BY id').all()).toEqual(artifacts)
          expect(targets.map(target=>fs.readFileSync(target))).toEqual(bytes)
          return
        }
        const peerBefore=db.prepare('SELECT * FROM reconcile_runs WHERE id=?').get(outcome.results[1].runId)
        const removal=await composition.service.previewDisconnect(owner.installationId)
        const removedAgain=await composition.service.disconnect(removal.planHash,owner.installationId)
        expect(removedAgain.results[0],JSON.stringify(removedAgain)).toMatchObject({status:'committed'})
        expect(targets.map(target=>fs.readFileSync(target))).toEqual(carrierFiles)
        expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(owner.runId)).toEqual({state:'cancelled',failure_code:'superseded_by_disconnect'})
        expect(db.prepare('SELECT * FROM reconcile_runs WHERE id=?').get(outcome.results[1].runId)).toEqual(peerBefore)
        expect(db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(owner.runId)).toEqual(effects)
        expect(db.prepare('SELECT prepared_plan_json,execution_plan_hash FROM reconcile_runs WHERE id=?').get(owner.runId)).toEqual(ownerRun)
      }
      return
    }
    const reconnect=await composition.service.previewConnect([second],true,undefined,options([second]))
    const reconnected=await composition.service.applyConnect(reconnect.planHash,[second])
    expect(reconnected.results[0],JSON.stringify(reconnected)).toMatchObject({status:'awaiting_verification'})
    const afterHistoryIds=db.prepare('SELECT id FROM verification_results ORDER BY id').all()
    for(const historical of historyIds)expect(afterHistoryIds).toContainEqual(historical)
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {unbind();composition.runtime.stop();db.close();fs.rmSync(root,{recursive:true,force:true})}
 },30000)
})
