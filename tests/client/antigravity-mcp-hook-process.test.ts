import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {describe,it,expect,vi} from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/antigravity-shared-fixture',getVersion:()=> '0.2.103',getAppPath:()=>'/tmp/Tide Mind.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
import {ensureSchema} from '../../src/db/schema'
import {ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE} from '../../src/antigravity-instruction'
import {bindAgentIntegrationExecutionPort,createProductionAgentIntegrationComposition} from '../../client/electron/agent-integration/production-service'
import {createP0HostAdapters} from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import {canonicalizeInstallationIdentity} from '../../client/electron/agent-integration/identity'
import {CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,MAX_CLI_EXECUTABLE_PROOF_BYTES} from '../../client/electron/agent-integration/discovery'
import type {AdapterRuntimeContext} from '../../client/electron/agent-integration/types'

// Real managed files, SQLite, stdio MCP and Hook subprocesses. Discovery is a
// synthetic fixture; this is not Antigravity model/desktop acceptance.
describe('Antigravity MCP and Hook runtime processes', () => {
 it('persists correction through MCP, reads it back and verifies independent Rule/start evidence', { timeout: 30_000 }, async () => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'antigravity-flow-')))
  const home=path.join(root,'home'),configRoot=path.join(home,'.gemini','config'),appData=path.join(root,'data')
  for(const dir of [home,appData,path.join(root,'bin')]) fs.mkdirSync(dir,{recursive:true})
  fs.mkdirSync(path.join(appData, 'graph'), { recursive: true })
  const db=new Database(path.join(appData, 'graph', 'brain.sqlite'));ensureSchema(db)
  const runtime:AdapterRuntimeContext={runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
   shimPath:process.execPath,mcpServerPath:path.resolve('dist/index.js'),hookScriptPath:path.resolve('dist/hook-session-start.js'),
   preCompactScriptPath:path.join(root,'bin','pre.cjs'),postCompactScriptPath:path.join(root,'bin','post.cjs'),
   tideMindVersion:'0.2.103',catalogVersion:'1',projectionVersion:'1'}
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

  let client: Client | undefined
  let stderr = ''
  try {
    fs.mkdirSync(path.join(home, '.tidemind'), { recursive: true })
    fs.writeFileSync(path.join(home, '.tidemind', 'config.toml'), '[general]\ndata_dir = ' + JSON.stringify(appData) + '\n')
    discover('antigravity-cli')
    const preview = await composition.service.previewConnect(['antigravity-cli'], true)
    const connected = await composition.service.applyConnect(preview.planHash, ['antigravity-cli'])
    expect(connected.results[0].status, JSON.stringify(connected)).not.toBe('failed')
    const entry = Object.values(JSON.parse(fs.readFileSync(path.join(configRoot, 'mcp_config.json'), 'utf8')).mcpServers)[0] as {
      command: string; args: string[]; env: Record<string, string>
    }
    const env = { HOME: home, TMPDIR: root, PATH: process.env.PATH ?? '/usr/bin:/bin', ...entry.env }
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: 'pipe' })
    transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-12_000) })
    client = new Client({ name: 'synthetic-antigravity-transport', version: '1' })
    await client.connect(transport)
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['brain_digest','brain_prepare','brain_recall'])
    const textResult = (result: Awaited<ReturnType<Client['callTool']>>) => {
      expect(result.isError, JSON.stringify(result) + stderr).not.toBe(true)
      const text = (result.content as Array<{ type: string; text?: string }>).filter(item => item.type === 'text').map(item => item.text).join('\n')
      return JSON.parse(text)
    }
    textResult(await client.callTool({ name: 'brain_prepare', arguments: { tool: 'Antigravity', detail_level: 'brief' } }))
    expect(composition.service.snapshot().connections[0].components.find(component => component.key === 'instruction')?.state).not.toBe('verified')
    textResult(await client.callTool({ name: 'brain_prepare', arguments: { tool: 'Antigravity', detail_level: 'brief', integration_probe: ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE } }))
    const target = 'synthetic-antigravity-memory'
    const before = 'synthetic marker before correction'
    const after = 'synthetic marker after correction 724b'
    db.prepare("INSERT INTO nodes (id,type,content,created) VALUES (?, 'fact', ?, ?)").run(target, before, new Date().toISOString())
    const recalled = textResult(await client.callTool({ name: 'brain_recall', arguments: { node_id: target } }))
    expect(JSON.stringify(recalled)).toContain(before)
    const corrected = textResult(await client.callTool({ name: 'brain_digest', arguments: {
      intent: 'correction', target_node: target, content: after, async: false, source: { tool: 'Antigravity' },
    } }))
    expect(corrected.status).toBe('processed')
    expect(db.prepare('SELECT content FROM nodes WHERE id=?').get(target)).toEqual({ content: after })
    const reread = textResult(await client.callTool({ name: 'brain_recall', arguments: { node_id: target } }))
    expect(JSON.stringify(reread)).toContain(after)
    // The emitted command is checked by Adapter tests; execute its real bundle here.
    const hook = spawnSync(runtime.shimPath, [runtime.hookScriptPath, '--agent-id', entry.env.EB_AGENT_ID,
      '--tool', 'antigravity', '--activity-generation-token', entry.env.EB_ACTIVITY_GENERATION_TOKEN], {
      env, cwd: root, encoding: 'utf8', timeout: 15_000,
      input: JSON.stringify({ hookEventName: 'SessionStart', conversationId: 'synthetic-process-session', workspacePaths: [root] }),
    })
    expect(hook.status, hook.stderr).toBe(0)
    const injected = JSON.parse(hook.stdout)
    expect(injected.injectSteps[0].systemMessage.systemMessage).toContain('TIDE MIND')
    expect(hook.stdout).not.toContain(ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE)
    expect(hook.stderr).not.toContain('activity evidence rejected')
    const activity = db.prepare("SELECT payload_json FROM agent_integration_events WHERE kind='shared_agent_activity'").all() as Array<{ payload_json: string }>
    expect(activity.map(row => JSON.parse(row.payload_json).signal_name)).toEqual(expect.arrayContaining(['brain_prepare','brain_recall','brain_digest','session_start']))
    await composition.runtime.markScanCompleted()
    expect(composition.service.snapshot().connections[0].components.map(component => component.state)).toEqual(['verified','verified','verified'])
    expect(composition.repository.getInstallation('antigravity-cli')?.verified_capability).toBe(3)
    expect(db.prepare('SELECT count(*) AS n FROM cli_invocations').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) AS n FROM model_connections').get()).toEqual({ n: 0 })
  } finally {
    await client?.close()
    unbind(); composition.runtime.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true })
  }
 })
})
