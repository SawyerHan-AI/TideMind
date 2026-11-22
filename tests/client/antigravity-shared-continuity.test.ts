import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {describe,it,expect,vi} from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/antigravity-continuity-fixture',getVersion:()=> '0.2.101',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
import {ensureSchema} from '../../src/db/schema'
import {evaluateBridgeAdmission} from '../../src/agent-bridge-guard'
import {bindAgentIntegrationExecutionPort,createProductionAgentIntegrationComposition} from '../../client/electron/agent-integration/production-service'
import {createP0HostAdapters} from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import {canonicalizeInstallationIdentity} from '../../client/electron/agent-integration/identity'
import {CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,MAX_CLI_EXECUTABLE_PROOF_BYTES} from '../../client/electron/agent-integration/discovery'
import type {AdapterRuntimeContext} from '../../client/electron/agent-integration/types'

// Real SQLite/coordinator/files with synthetic discovery; not a real Antigravity host.
describe('Antigravity shared domain continuity',{timeout:30_000},()=>{
 it('keeps serving the unchanged shared configuration across a host upgrade without writing',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'antigravity-continuity-')))
  const home=path.join(root,'home'),configRoot=path.join(home,'.gemini','config'),appData=path.join(root,'data')
  for(const dir of [home,appData,path.join(root,'bin')]) fs.mkdirSync(dir,{recursive:true})
  const db=new Database(':memory:');ensureSchema(db)
  const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
   shimPath:path.join(root,'bin','tm-node'),mcpServerPath:path.join(root,'bin','mcp.cjs'),hookScriptPath:path.join(root,'bin','hook.cjs'),
   preCompactScriptPath:path.join(root,'bin','pre.cjs'),postCompactScriptPath:path.join(root,'bin','post.cjs'),
   tideMindVersion:'0.2.101',catalogVersion:'1',projectionVersion:'1'}
  const composition=createProductionAgentIntegrationComposition(db,{homeDir:home,applicationDataDir:appData,runtimeContext:runtime,
    adapters:createP0HostAdapters(),enabledAdapterIds:['antigravity-cli','antigravity-app'],observeOnly:false,startRuntime:false,
    fixtureMode:'isolated_ui_audit',automaticConnections:false,canManageInstallation:()=>true,
    scanner:{scan:async()=>({installations:[],unresolved:[],diagnostics:[]})},notifications:{deliver:vi.fn()}})
  const unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
  const executable=path.join(root,'bin','antigravity-cli');fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
  const identity=canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'synthetic',productFamilyId:'antigravity',
    hostVariant:'antigravity-cli',configRoot,distribution:{distributionId:'fixture:antigravity-cli',executableRealpath:executable,
    packageProvenance:'fixture',capabilityFingerprint:'fixture-antigravity-cli'}})
  const discover=(version:string)=>composition.repository.upsertDiscoveredInstallation({id:'antigravity-cli',family:'antigravity',
    hostVariant:'antigravity-cli',runtimeRealm:'local_macos',osUserIdentity:'synthetic',installKey:identity.installKey,
    distributionId:'fixture:antigravity-cli',provenance:'fixture',displayName:'antigravity-cli',configRoot,executablePath:executable,
    detectedVersion:version,agentId:'original-antigravity-cli',supportedCapability:3,lastDetectedAt:new Date().toISOString(),
    metadata:{distribution:identity.distribution,managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,
      executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})
  try {
    discover('1.5.11')
    const preview=await composition.service.previewConnect(['antigravity-cli'],true)
    await composition.service.applyConnect(preview.planHash,['antigravity-cli'])
    const file=path.join(configRoot,'mcp_config.json')
    const entry=Object.values(JSON.parse(fs.readFileSync(file,'utf8')).mcpServers)[0] as {env:{EB_AGENT_ID:string;EB_ACTIVITY_GENERATION_TOKEN:string}}
    const admit=()=>evaluateBridgeAdmission(db,{agentId:entry.env.EB_AGENT_ID,activityGenerationToken:entry.env.EB_ACTIVITY_GENERATION_TOKEN,componentKey:'memory_tools'})
    expect(admit()).toEqual({allowed:true})
    const before=fs.readFileSync(file,'utf8')

    discover('1.6.0')
    await composition.runtime.markScanCompleted()
    await composition.runtime.markScanCompleted()

    expect(admit(),JSON.stringify(db.prepare('SELECT state,failure_code FROM reconcile_runs').all())).toEqual({allowed:true})
    expect(fs.readFileSync(file,'utf8')).toBe(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get()).toEqual({n:1})
    expect(db.prepare('SELECT COUNT(*) AS n FROM codex_bridge_member_proofs').get()).not.toEqual({n:0})
  } finally { unbind(); composition.runtime.stop(); db.close(); fs.rmSync(root,{recursive:true,force:true}) }
 })
})
