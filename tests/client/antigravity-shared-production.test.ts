import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
import {readAntigravityStartupExport} from '../../src/antigravity-activity-export'
import {hostActivityLedgerExportHash,hostActivityLedgerEvidenceHash,validateAntigravitySharedActivityReceipt} from '../../scripts/verify-agent-integration-host-acceptance.mjs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {describe,it,expect,vi} from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/antigravity-shared-fixture',getVersion:()=> '0.2.104',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
import {ensureSchema} from '../../src/db/schema'
import {recordHostActivityEvidence,recordHookActivityEvidence} from '../../src/db/agent-host-activity'
import {currentAntigravityRule} from '../../src/antigravity-rule-evidence'
import {ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE} from '../../src/antigravity-instruction'
import {evaluateBridgeAdmission} from '../../src/agent-bridge-guard'
import {bindAgentIntegrationExecutionPort,createProductionAgentIntegrationComposition} from '../../client/electron/agent-integration/production-service'
import {createP0HostAdapters} from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import {canonicalizeInstallationIdentity} from '../../client/electron/agent-integration/identity'
import {CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,MAX_CLI_EXECUTABLE_PROOF_BYTES} from '../../client/electron/agent-integration/discovery'
import type {AdapterRuntimeContext} from '../../client/electron/agent-integration/types'

// Real SQLite/coordinator/files, synthetic discovery and activity. This does
// not represent a real Antigravity host or production memory acceptance.
describe('Antigravity shared production composition',()=>{
 it('closes three component verification at C3 and preserves scope across joining and disconnect',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'antigravity-flow-')))
  const home=path.join(root,'home'),configRoot=path.join(home,'.gemini','config'),appData=path.join(root,'data')
  for(const dir of [home,appData,path.join(root,'bin')]) fs.mkdirSync(dir,{recursive:true})
  const db=new Database(':memory:');ensureSchema(db)
  const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
   shimPath:path.join(root,'bin','tm-node'),mcpServerPath:path.join(root,'bin','mcp.cjs'),hookScriptPath:path.join(root,'bin','hook.cjs'),
   preCompactScriptPath:path.join(root,'bin','pre.cjs'),postCompactScriptPath:path.join(root,'bin','post.cjs'),
   tideMindVersion:'0.2.104',catalogVersion:'1',projectionVersion:'1'}
  const composition=createProductionAgentIntegrationComposition(db,{homeDir:home,applicationDataDir:appData,runtimeContext:runtime,
    adapters:createP0HostAdapters(),enabledAdapterIds:['antigravity-cli','antigravity-app'],observeOnly:false,startRuntime:false,
    fixtureMode:'isolated_ui_audit',automaticConnections:false,canManageInstallation:()=>true,
    scanner:{scan:async()=>({installations:[],unresolved:[],diagnostics:[]})},notifications:{deliver:vi.fn()}})
  const unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
  const discover=(variant:'antigravity-cli'|'antigravity-app')=>{
    const executable=path.join(root,'bin',variant);fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
    const identity=canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'synthetic',productFamilyId:'antigravity',
      hostVariant:variant,configRoot,distribution:{distributionId:'fixture:'+variant,executableRealpath:executable,
      packageProvenance:'fixture',capabilityFingerprint:'fixture-'+variant}})
    composition.repository.upsertDiscoveredInstallation({id:variant,family:'antigravity',hostVariant:variant,runtimeRealm:'local_macos',
      osUserIdentity:'synthetic',installKey:identity.installKey,distributionId:'fixture:'+variant,provenance:'fixture',displayName:variant,
      configRoot,executablePath:executable,detectedVersion:variant==='antigravity-cli'?'1.5.11':'2.33.0',agentId:'original-'+variant,
      supportedCapability:3,lastDetectedAt:new Date().toISOString(),metadata:{distribution:identity.distribution,
        managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,
          executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})
  }
  try {
    discover('antigravity-cli')
    const preview=await composition.service.previewConnect(['antigravity-cli'],true)
    const connected=await composition.service.applyConnect(preview.planHash,['antigravity-cli'])
    expect(connected.results[0].status,JSON.stringify(connected)).not.toBe('failed')
    const entry=()=>Object.values(JSON.parse(fs.readFileSync(path.join(configRoot,'mcp_config.json'),'utf8')).mcpServers)[0] as {env:{EB_AGENT_ID:string;EB_ACTIVITY_GENERATION_TOKEN:string}}
    const initial=entry(),agentId=initial.env.EB_AGENT_ID,token=initial.env.EB_ACTIVITY_GENERATION_TOKEN
    expect(currentAntigravityRule(db,agentId)).not.toBeNull()
    const record=(signalName:'brain_prepare'|'brain_recall'|'brain_digest',instructionProbe?:string)=>recordHostActivityEvidence(db,{
      agentId,activityGenerationToken:token,componentKey:'memory_tools',signalName,hostVariant:'shared',tideMindVersion:runtime.tideMindVersion,instructionProbe})
    expect(record('brain_prepare')).toMatchObject({status:'rejected',reason:'instruction_recognition_missing'})
    expect(record('brain_recall').status).toBe('shared_recorded')
    expect(record('brain_digest').status).toBe('shared_recorded')
    expect(recordHookActivityEvidence(db,{agentId,activityGenerationToken:token,signalName:'session_start',tool:'antigravity',tideMindVersion:runtime.tideMindVersion}).status).toBe('shared_recorded')
    expect(composition.service.snapshot().connections[0].components.find(c=>c.key==='instruction')?.state).not.toBe('verified')
    expect(record('brain_prepare',ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE).status).toBe('shared_recorded')
    await composition.runtime.markScanCompleted()
    const states=()=>composition.service.snapshot().connections[0].components
    expect(states().map(c=>c.state)).toEqual(['verified','verified','verified'])
    expect(composition.repository.getInstallation('antigravity-cli')?.verified_capability,JSON.stringify(db.prepare('SELECT state,failure_code,failure_stage FROM reconcile_runs').all())).toBe(3)
    expect(db.prepare("SELECT count(*) n FROM reconcile_runs WHERE state='committed'").get()).toMatchObject({n:1})
    expect(states().every(c=>c.evidenceScope==='configuration_domain')).toBe(true)
    const startupEvent=db.prepare("SELECT id FROM agent_integration_events WHERE kind='shared_agent_activity' AND json_extract(payload_json,'$.signal_name')='session_start'").get() as {id:string}
    const targetKey='antigravity-cli:arm64:cli%3Aantigravity-cli'
    const startup=readAntigravityStartupExport(db,{eventId:startupEvent.id,installationId:'antigravity-cli',targetKey,tideMindVersion:'0.2.104'})
    expect(startup).toMatchObject({evidenceScope:'configuration_domain',requestedInstallationId:'antigravity-cli',signalName:'session_start'})
    expect(startup).not.toHaveProperty('hostVariant')
    expect(()=>readAntigravityStartupExport(db,{eventId:startupEvent.id,installationId:'antigravity-cli',targetKey:'codex-cli:arm64:fixture',tideMindVersion:'0.2.104'})).toThrow()
    const snapshot=path.join(root,'export-ledger.sqlite');await db.backup(snapshot)
    const child=spawnSync(process.execPath,[path.resolve('dist/agent-host-activity-export.js'),
      '--event-id',startupEvent.id,'--installation-id','antigravity-cli','--target-key',targetKey,
      '--capture-nonce','a'.repeat(64),'--candidate-bundle-sha256','b'.repeat(64),
      '--source-commit','c'.repeat(40),'--release-contract-sha256','d'.repeat(64),'--fixture-database',snapshot],{encoding:'utf8'})
    expect(child.status,child.stderr).toBe(0)
    const exported=JSON.parse(child.stdout)
    expect(exported).toMatchObject({exporterVersion:2,evidenceScope:'configuration_domain',databaseSchemaVersion:53,ledgerSource:'fixture'})
    expect(exported.evidenceHash).toBe(hostActivityLedgerEvidenceHash(exported))
    expect(exported.exportHash).toBe(hostActivityLedgerExportHash(exported))
    const expectedCapture={appVersion:'0.2.104',hostVariant:'antigravity-cli',stepId:'lifecycle_session_start',
      installationId:'antigravity-cli',agentId,allowFixtureActivity:true,captureNonce:'a'.repeat(64),targetKey,
      candidateBundleSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40),releaseContractSha256:'d'.repeat(64),
      captureCreatedAt:new Date(Date.now()-60_000).toISOString()}
    expect(validateAntigravitySharedActivityReceipt(exported,expectedCapture,new Date().toISOString())).toEqual(exported)
    expect(()=>validateAntigravitySharedActivityReceipt(exported,{...expectedCapture,hostVariant:'codex-cli'},new Date().toISOString())).toThrow(/outside/)


    const rulePath=path.join(configRoot,'rules','tidemind.md'),bytes=fs.readFileSync(rulePath)
    fs.appendFileSync(rulePath,'external change')
    expect(currentAntigravityRule(db,agentId)).toBeNull()
    expect(record('brain_prepare',ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE).status).toBe('rejected')
    expect(states().find(c=>c.key==='instruction')?.state).not.toBe('verified')
    fs.writeFileSync(rulePath,bytes)
    discover('antigravity-app')
    const joinPreview=await composition.service.previewConnect(['antigravity-app'],true)
    const joined=await composition.service.applyConnect(joinPreview.planHash,['antigravity-app'])
    expect(joined.results[0].status,JSON.stringify(joined)).not.toBe('failed')
    expect(entry()).toEqual(initial)
    expect(composition.service.snapshot().connections).toHaveLength(1)
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(configRoot,'mcp_config.json'),'utf8')).mcpServers)).toHaveLength(1)
    for(const signal of ['brain_prepare','brain_recall','brain_digest'] as const)record(signal,ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE)
    recordHookActivityEvidence(db,{agentId,activityGenerationToken:token,signalName:'session_start',tool:'antigravity',tideMindVersion:runtime.tideMindVersion})
    await composition.runtime.markScanCompleted()
    expect(composition.repository.getInstallation('antigravity-app')?.verified_capability).toBe(3)
    const connection=composition.service.snapshot().connections[0]
    composition.service.pauseConnection(connection.id)
    expect(evaluateBridgeAdmission(db,{agentId,activityGenerationToken:token}).allowed).toBe(true)
    composition.service.resumeConnection(connection.id)
    const removal=await composition.service.previewConnectionDisconnect(connection.id)
    await composition.service.disconnectConnection(removal.planHash,connection.id)
    expect(evaluateBridgeAdmission(db,{agentId,activityGenerationToken:token}).allowed).toBe(false)
    expect(record('brain_digest').status).toBe('rejected')
  } finally {unbind();composition.runtime.stop();db.close();fs.rmSync(root,{recursive:true,force:true})}
 })
})
