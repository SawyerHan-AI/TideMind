import { describe, it, expect, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/tm-claude-flow',getVersion:()=> '0.2.94',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { bindAgentIntegrationExecutionPort,createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import { createClaudeCodePluginHostAdapter, type ClaudeCodeCommandResult, type ClaudeCodePluginAdapterDependencies } from '../../client/electron/agent-integration/hosts/claude-code-plugin-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'

class FakeClaudeCli implements ClaudeCodePluginAdapterDependencies {
  marketplaces = new Map<string, string>()
  plugins = new Map<string, { version: string; enabled: boolean }>()
  calls: string[][] = []
  failAfterStep: string | null = null
  failBeforeStep: string | null = null

  async run(_executable: string, args: readonly string[]): Promise<ClaudeCodeCommandResult> {
    this.calls.push([...args])
    if (args.join(' ') === 'plugin marketplace list --json') {
      return ok([...this.marketplaces].map(([name, marketplacePath]) => ({ name, source: 'directory', path: marketplacePath, installLocation: marketplacePath })))
    }
    if (args.join(' ') === 'plugin list --json') {
      return ok([...this.plugins].map(([id, state]) => ({ id, ...state, scope: 'user' })))
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
      if (this.before('marketplace_add')) return fail('crash-before-marketplace_add')
      const root = args[3]
      const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string }
      this.marketplaces.set(manifest.name, root)
      return this.after('marketplace_add')
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      if (this.before('marketplace_remove')) return fail('crash-before-marketplace_remove')
      const marketplace = args[3]
      this.marketplaces.delete(marketplace)
      for (const id of this.plugins.keys()) if (id.endsWith(`@${marketplace}`)) this.plugins.delete(id)
      return this.after('marketplace_remove')
    }
    if (args[0] === 'plugin' && args[1] === 'install') {
      if (this.before('plugin_install')) return fail('crash-before-plugin_install')
      const qualified = args[2]
      const marketplace = qualified.slice(qualified.lastIndexOf('@') + 1)
      const name = qualified.slice(0, qualified.lastIndexOf('@'))
      const root = this.marketplaces.get(marketplace)
      if (!root) return fail('marketplace missing')
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }
      this.plugins.set(qualified, { version: manifest.version, enabled: true })
      return this.after('plugin_install')
    }
    if (args[0] === 'plugin' && args[1] === 'uninstall') {
      if (this.before('plugin_uninstall')) return fail('crash-before-plugin_uninstall')
      this.plugins.delete(args[2])
      return this.after('plugin_uninstall')
    }
    return fail(`unsupported:${args.join(' ')}`)
  }

  private after(step: string): ClaudeCodeCommandResult {
    if (this.failAfterStep === step) {
      this.failAfterStep = null
      return fail(`crash-after-${step}`)
    }
    return ok({})
  }

  private before(step: string): boolean {
    if (this.failBeforeStep !== step) return false
    this.failBeforeStep = null
    return true
  }
}

function ok(value: unknown): ClaudeCodeCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' }
}

function fail(message: string): ClaudeCodeCommandResult {
  return { exitCode: 1, stdout: '', stderr: message }
}


describe('Claude plugin preview freshness through production service',()=>{
 it.each([{hostVariant:'claude-code-cli' as const,wrongAbsentHash:false},{hostVariant:'claude-code-native' as const,wrongAbsentHash:false},{hostVariant:'claude-code-native' as const,wrongAbsentHash:true}])('preserves operation seed for $hostVariant connect/upgrade/disconnect (wrong absent hash=$wrongAbsentHash)',async ({hostVariant,wrongAbsentHash})=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'claude-preview-flow-')))
  const home=path.join(root,'home'),configRoot=path.join(home,'.claude'),appData=path.join(root,'app-data')
  for(const dir of [configRoot,appData,path.join(root,'bin')])fs.mkdirSync(dir,{recursive:true})
  const executable=path.join(root,'bin','claude');fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
  const db=new Database(':memory:');ensureSchema(db)
  const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
   shimPath:path.join(root,'bin','tm-node'),mcpServerPath:path.join(root,'bin','mcp.cjs'),hookScriptPath:path.join(root,'bin','hook.cjs'),
   preCompactScriptPath:path.join(root,'bin','pre.cjs'),postCompactScriptPath:path.join(root,'bin','post.cjs'),
   tideMindVersion:'0.2.94',catalogVersion:'1',projectionVersion:'1'}
  const cli=new FakeClaudeCli()
  const adapter=createClaudeCodePluginHostAdapter({catalogId:hostVariant,adapterVersion:'1',dependencies:cli})
  // Production adapter verification, with explicit synthetic host activity.
  // This regression checks plumbing only, not actual Claude acceptance.
  const verify=adapter.verify.bind(adapter)
  vi.spyOn(adapter,'verify').mockImplementation((context,request)=>verify({...context,
    hostActivityEvidence:{find:async query=>query.signalNames.map(signalName=>({...query,id:'synthetic-'+signalName,signalName,
      evidenceHash:'synthetic-'+signalName,observedAt:request.activityBinding!.verifiedAt}))},
  },request))
  const adapters=new Map([[hostVariant,adapter]])
  const composition=createProductionAgentIntegrationComposition(db,{homeDir:home,applicationDataDir:appData,runtimeContext:runtime,
    adapters,enabledAdapterIds:[hostVariant],observeOnly:false,startRuntime:false,fixtureMode:'isolated_ui_audit',
    canManageInstallation:()=>true,scanner:{scan:async()=>({installations:[],unresolved:[],diagnostics:[]})},notifications:{deliver:vi.fn()}})
  const unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
  try{
   const provenance=hostVariant==='claude-code-native'?'signed_cli:com.anthropic.claude-code:Q6L2SF6YDW':'npm_metadata:@anthropic-ai/claude-code'
   const identity=canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'synthetic-user',
    productFamilyId:'claude-code',hostVariant,configRoot,distribution:{distributionId:hostVariant,executableRealpath:executable,
    packageProvenance:provenance,capabilityFingerprint:'fixture'}})
   composition.repository.upsertDiscoveredInstallation({id:'claude',family:'claude-code',hostVariant,runtimeRealm:'local_macos',
    osUserIdentity:'synthetic-user',installKey:identity.installKey,distributionId:hostVariant,provenance,displayName:'Claude fixture',
    configRoot,executablePath:executable,detectedVersion:'2.1.296',agentId:'eb_claude_fixture',supportedCapability:4,
    lastDetectedAt:new Date().toISOString(),metadata:{distribution:identity.distribution,
    managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})
   const connect=await composition.service.previewConnect(['claude'],true)
   const result=await composition.service.applyConnect(connect.planHash,['claude'])
   expect(result.results[0],JSON.stringify(result)).toMatchObject({status:'committed'})
   const reconcile = async () => {
    const candidates = composition.coordinatorRepository.listManagedReconcileCandidates()
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) await composition.runtime['reconcile'](candidate)
    return db.prepare('SELECT state FROM managed_artifacts').all()
   }
   expect(await reconcile()).toEqual([{state:'healthy'}])
   const pluginState=[...cli.plugins.values()][0]
   pluginState.enabled=false
   expect(await reconcile()).toEqual([{state:'drifted'}])
   pluginState.enabled=true
   expect(await reconcile()).toEqual([{state:'healthy'}])
   const firstVersion=[...cli.plugins.values()][0].version
   runtime.tideMindVersion='0.2.94-next'
   expect(await reconcile()).toEqual([{state:'healthy'}])
   const upgrade=await composition.service.previewConnect(['claude'],true)
   const upgraded=await composition.service.applyConnect(upgrade.planHash,['claude'])
   expect(upgraded.results[0],JSON.stringify(upgraded)).toMatchObject({status:'committed'})
   expect([...cli.plugins.values()][0].version).not.toBe(firstVersion)
   for(const defect of ['wrong-target','missing-covered-scope'] as const){
    const negativePreview=await composition.service.previewDisconnect('claude')
    const originalApply=composition.coordinator.applyPrepared.bind(composition.coordinator)
    const spy=vi.spyOn(composition.coordinator,'applyPrepared').mockImplementationOnce(request=>{
      const scopes=request.disconnectScopeExpectations!.map(scope=>({...scope}))
      expect(scopes.map(scope=>scope.componentKey).sort()).toEqual(['instruction','lifecycle','memory_tools'])
      if(defect==='wrong-target')scopes.find(scope=>scope.componentKey==='lifecycle')!.physicalTarget+='-wrong'
      else scopes.splice(scopes.findIndex(scope=>scope.componentKey==='memory_tools'),1)
      return originalApply({...request,disconnectScopeExpectations:scopes})
    })
    const beforeCalls=cli.calls.length
    const negative=await composition.service.disconnect(negativePreview.planHash,'claude')
    spy.mockRestore()
    expect(negative.results[0]).toMatchObject({status:'failed',reason:defect==='wrong-target'
      ?'disconnect consumer scope target differs from the approved mutation':'disconnect consumer scope no longer matches the approved plan'})
    expect(cli.calls.slice(beforeCalls)).toEqual([['plugin','marketplace','list','--json'],['plugin','list','--json']])
   }
   const driftPreview=await composition.service.previewDisconnect('claude')
   const marketplaceRoot=[...cli.marketplaces.values()][0]
   const manifestPath=path.join(marketplaceRoot,'.claude-plugin','marketplace.json')
   const before=fs.readFileSync(manifestPath)
   fs.appendFileSync(manifestPath,'\n')
   const callsBefore=cli.calls.length
   const drift=await composition.service.disconnect(driftPreview.planHash,'claude')
   expect(drift.results[0]).toMatchObject({status:'failed',reason:'claude_plugin_aggregate_baseline_mismatch'})
   expect(cli.calls.slice(callsBefore)).toEqual([['plugin','marketplace','list','--json'],['plugin','list','--json']])
   fs.writeFileSync(manifestPath,before)
   const disconnect=await composition.service.previewDisconnect('claude')
   if(wrongAbsentHash){
    const readBack=adapter.readBack.bind(adapter)
    vi.spyOn(adapter,'readBack').mockImplementation(async(...args)=>{
      const result=await readBack(...args)
      return result.visibility==='absent'?{...result,observedFragmentHash:'wrong-absent-fingerprint'}:result
    })
   }
   const removed=await composition.service.disconnect(disconnect.planHash,'claude')
   if(wrongAbsentHash){
    expect(removed.results[0]).toMatchObject({status:'needs_recovery',reason:'effect_read_back_mismatch'})
    return
   }
   expect(removed.results[0],JSON.stringify(removed)+JSON.stringify(db.prepare('SELECT component_key,target_path,ownership_key FROM artifact_consumers JOIN managed_artifacts ON artifact_id=managed_artifacts.id').all())).toMatchObject({status:'committed'})
   expect(cli.plugins.size).toBe(0);expect(cli.marketplaces.size).toBe(0)
  }finally{unbind();composition.runtime.stop();db.close();fs.rmSync(root,{recursive:true,force:true})}
 },30000)
})
