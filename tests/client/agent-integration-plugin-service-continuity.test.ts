import { describe, it, expect, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/tm-claude-continuity',getVersion:()=> '0.2.94',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard'
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


describe('plugin-manager host service continuity',{timeout:30_000},()=>{
 it('keeps serving an installed, unchanged Claude plugin across a host surface change without running install commands',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'claude-continuity-')))
  const home=path.join(root,'home'),configRoot=path.join(home,'.claude'),appData=path.join(root,'app-data')
  for(const dir of [configRoot,appData,path.join(root,'bin')])fs.mkdirSync(dir,{recursive:true})
  const executable=path.join(root,'bin','claude');fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
  const db=new Database(':memory:');ensureSchema(db)
  const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
   shimPath:path.join(root,'bin','tm-node'),mcpServerPath:path.join(root,'bin','mcp.cjs'),hookScriptPath:path.join(root,'bin','hook.cjs'),
   preCompactScriptPath:path.join(root,'bin','pre.cjs'),postCompactScriptPath:path.join(root,'bin','post.cjs'),
   tideMindVersion:'0.2.101',catalogVersion:'1',projectionVersion:'1'}
  const cli=new FakeClaudeCli()
  const hostVariant='claude-code-native' as const
  const adapter=createClaudeCodePluginHostAdapter({catalogId:hostVariant,adapterVersion:'1',dependencies:cli})
  const composition=createProductionAgentIntegrationComposition(db,{homeDir:home,applicationDataDir:appData,runtimeContext:runtime,
    adapters:new Map([[hostVariant,adapter]]),enabledAdapterIds:[hostVariant],observeOnly:false,autoRestore:false,startRuntime:false,fixtureMode:'isolated_ui_audit',
    canManageInstallation:()=>true,scanner:{scan:async()=>({installations:[],unresolved:[],diagnostics:[]})},notifications:{deliver:vi.fn()}})
  const unbind=bindAgentIntegrationExecutionPort(composition.coordinator)
  try{
   const provenance='signed_cli:com.anthropic.claude-code:Q6L2SF6YDW'
   const identity=canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'synthetic-user',
    productFamilyId:'claude-code',hostVariant,configRoot,distribution:{distributionId:hostVariant,executableRealpath:executable,
    packageProvenance:provenance,capabilityFingerprint:'fixture'}})
   // The plugin bundle is rendered per host version, so a version change is a real
   // reinstall. This covers a surface change that leaves the bundle untouched.
   const discover=(surface:string)=>composition.repository.upsertDiscoveredInstallation({id:'claude',family:'claude-code',hostVariant,runtimeRealm:'local_macos',
    osUserIdentity:'synthetic-user',installKey:identity.installKey,distributionId:hostVariant,provenance,displayName:'Claude fixture',
    configRoot,executablePath:executable,detectedVersion:'2.1.296',agentId:'eb_claude_fixture',supportedCapability:4,
    lastDetectedAt:new Date().toISOString(),metadata:{distribution:{...identity.distribution,capabilityFingerprint:surface},
    managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})
   discover('fixture')
   const connect=await composition.service.previewConnect(['claude'],true)
   await composition.service.applyConnect(connect.planHash,['claude'])
   const run=db.prepare('SELECT id,prepared_plan_json FROM reconcile_runs').get() as {id:string;prepared_plan_json:string}
   const token=JSON.parse(run.prepared_plan_json).activityGenerationToken as string
   const admit=()=>evaluateBridgeAdmission(db,{agentId:'eb_claude_fixture',activityGenerationToken:token,componentKey:'memory_tools'})
   expect(admit()).toEqual({allowed:true})
   const mutating=()=>cli.calls.filter(args=>!args.includes('list')).length
   const installs=mutating()

   discover('fixture-after-reboot')
   await composition.runtime.markScanCompleted()
   await composition.runtime.markScanCompleted()

   expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(run.id))
    .toEqual({state:'cancelled',failure_code:'superseded_by_service_proof'})
   expect(admit()).toEqual({allowed:true})
   expect(mutating()).toBe(installs)

   // A plugin the user disabled in the host is not read back as intact, so nothing is renewed for the next upgrade.
   ;[...cli.plugins.values()][0].enabled=false
   discover('fixture-third')
   await composition.runtime.markScanCompleted()
   expect(admit()).toEqual({allowed:false,reason:'activity_generation_mismatch'})
  }finally{unbind();composition.runtime.stop();db.close();fs.rmSync(root,{recursive:true,force:true})}
 })
})
