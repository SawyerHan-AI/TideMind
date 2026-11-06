import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticBinding } from '../../src/agent-diagnostic-contract'
import type { DiagnosticProcessResult } from '../../src/agent-diagnostic-runner'
import { DiagnosticProcessError } from '../../src/agent-diagnostic-runner'
import type { DiagnosticProcessStart, DiagnosticProcessSession } from '../../client/electron/agent-integration/diagnostic-process'
import { sha256Bytes } from '../../client/electron/agent-integration/fingerprint'
import { codexDiagnosticSandbox, prepareCodexDiagnostic as prepareNativeCodexDiagnostic } from '../../client/electron/agent-integration/codex-diagnostic-adapter'
import type { NativeDiagnosticInput } from '../../client/electron/agent-integration/native-diagnostic-adapter'

const mocks = vi.hoisted(() => ({ metadata: vi.fn(), start: vi.fn(), metadataShutdown: vi.fn() }))
const prepareCodexDiagnostic = (input: NativeDiagnosticInput, systemConfigPaths: readonly string[] = []) =>
  prepareNativeCodexDiagnostic(input, { systemConfigPaths })
vi.mock('@server/llm/cli/child-process-runner.js', () => ({
  CliProcessRegistry: class { shutdown = mocks.metadataShutdown }, CliChildProcessRunner: class { run = mocks.metadata },
}))
vi.mock('../../client/electron/agent-integration/diagnostic-process', () => ({ startDiagnosticProcess: mocks.start }))

let root: string, input: NativeDiagnosticInput, configPath: string, configuration: string
let requestLog: Array<{ method: string; params: any; id?: number }>
let child: DiagnosticProcessSession
let sendNotification: (message: unknown) => Promise<void>
let badMarker: boolean, permissionChanged: boolean, foreignInventory: boolean, defaultModel: string, unknownFeature: boolean, startingInventory: boolean
let effectiveRouteOverride: Record<string, string>
const catalog = { models: ['gpt-6-astra','gpt-6-sol'].map((slug,index) => ({ slug, priority:index,
  apply_patch_tool_type:'freeform', experimental_supported_tools:['fixture-extra-tool'] })) }
const featureText = ['shell_tool','plugins','hooks','skip_host_skill_discovery','mcp_2026_07_28'].map(name => `${name} stable true`).join('\n')
const exit: DiagnosticProcessResult = { reason:'cancelled',exitCode:0,signal:null,processGroupExited:true,supervisorExited:true,
  rawStdoutBytes:0,rawStderrBytes:0,observedOutputBytes:0,modelWindowArmed:false }

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-diagnostic-adapter-')))
  const home = path.join(root,'home'), configRoot = path.join(home,'.codex'), dataDir=path.join(root,'run')
  fs.mkdirSync(configRoot,{recursive:true}); fs.mkdirSync(dataDir)
  const block = `[mcp_servers.tidemind-fixture]\nenabled = true\ncommand = "/usr/bin/true"\nargs = ["/fixture/mcp-server.cjs"]\nenv = { EB_AGENT_ID = "fixture-agent", EB_ACTIVITY_GENERATION_TOKEN = "fixture-generation" }\n`
  configuration = `model = "gpt-6-astra"\nmodel_provider = "openai"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n${block}\n[mcp_servers.foreign]\ncommand = "/usr/bin/false"\n`
  configPath=path.join(configRoot,'config.toml');fs.writeFileSync(configPath,configuration)
  const binding: DiagnosticBinding = { connectionKey:'installation:fixture',configurationVersion:'fixture-version',runtimeVersion:'0.2.94',
    installationSourceHash:'fixture-source',domainKey:'fixture-domain',intentRevision:1,installationId:'fixture',installationAgentId:'fixture-agent',
    canonicalAgentId:'fixture-agent',installKey:'fixture-key',bindingId:null,bindingGeneration:null,hostVariant:'codex-cli',hostVersion:'0.157.1',
    executablePath:'/fixture/codex',configRoot,distributionId:'fixture-codex',sourceIdentityHash:'fixture-source',
    components:{memory_tools:{artifactId:'fixture-mcp',ownedFragmentHash:sha256Bytes(block),activityGenerationToken:'fixture-generation'}} }
  input={binding,homeDir:home,sourceEnv:{},launch:{executable:process.execPath,args:['/fixture/supervisor.cjs']},signal:new AbortController().signal,
    run:{runId:'fixture-run',nonce:'fixture-nonce',dataDir,databasePath:path.join(dataDir,'brain.sqlite'),expiresAt:new Date(Date.now()+90_000).toISOString(),
      environment:{TIDEMIND_DIAGNOSTIC_REQUIRED:'1',TIDEMIND_DIAGNOSTIC_CONTEXT:'synthetic-capability-envelope'}},attest:vi.fn(async()=>true),onProcess:vi.fn()}
  requestLog=[];badMarker=false;permissionChanged=false;foreignInventory=false;defaultModel='gpt-6-sol';unknownFeature=false;startingInventory=false
  effectiveRouteOverride={}
  mocks.metadata.mockReset();mocks.start.mockReset()
  mocks.metadataShutdown.mockReset();mocks.metadataShutdown.mockResolvedValue(undefined)
  mocks.metadata.mockImplementation(async ({args}: {args:string[]}) => {
    let stdout: string
    if(args.includes('--version'))stdout='codex-cli 0.157.1\n'
    else if(args.includes('features'))stdout=featureText
    else if(args.includes('--bundled'))stdout=JSON.stringify(catalog)
    else {
      const arg=args.find(value=>value.startsWith('model_catalog_json='))!
      const file=(parseToml(arg) as {model_catalog_json:string}).model_catalog_json
      stdout=fs.readFileSync(file,'utf8')
    }
    return {stdout,stderr:'',exitCode:0}
  })
  mocks.start.mockImplementation(async (spec:DiagnosticProcessStart) => {
    let resolve!: (value:DiagnosticProcessResult)=>void
    const result = new Promise<DiagnosticProcessResult>(done=>{resolve=done})
    const args=[...spec.args]
    const mcpArg=args.find(value=>value.startsWith('mcp_servers='))!
    const servers=(parseToml(mcpArg) as any).mcp_servers
    const rawConfig=parseToml(fs.readFileSync(configPath,'utf8')) as any
    const nativeConfig={...rawConfig,...effectiveRouteOverride,mcp_servers:Object.fromEntries(Object.entries(servers).map(([name,entry])=>
      [name,{...(entry as object),environment_id:'local',tool_timeout_sec:null}])),model:rawConfig.model ?? null}
    sendNotification=async message=>{await spec.onStdout(JSON.stringify(message)+'\n')}
    child={pid:123,supervisorPid:122,identity:{protocolVersion:1,pid:123,supervisorPid:122,processGroupId:123,startedAt:'fixture',
      osStartIdentity:'fixture',executableRealpath:'/usr/bin/sandbox-exec',argumentsHash:'a'.repeat(64),cwd:spec.cwd},
      write:vi.fn(async text=>{
        const message=JSON.parse(text);requestLog.push(message)
        if(message.id===undefined)return
        let response:unknown={}
        switch(message.method){
          case 'config/read':response={config:nativeConfig};break
          case 'account/read':response={account:{type:'chatgpt',planType:'pro'},requiresOpenaiAuth:true};break
          case 'model/list':response={data:[{model:defaultModel,isDefault:true}],nextCursor:null};break
          case 'thread/start':response={thread:{id:'fixture-thread'},model:message.params.model,modelProvider:'openai',
            approvalPolicy:permissionChanged?'never':'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}};break
          case 'experimentalFeature/list':response={data:[{name:'shell_tool',enabled:false},{name:'plugins',enabled:false},
            {name:'skip_host_skill_discovery',enabled:true},...(unknownFeature?[{name:'new_execution_feature',enabled:true}]:[])],nextCursor:null};break
          case 'mcpServerStatus/list':
            if(startingInventory){startingInventory=false;response={data:[{name:'tidemind-fixture',runtimeStatus:'starting'}],nextCursor:null};break}
            response={data:[{name:'tidemind-fixture',runtimeStatus:'connected',
            serverInfo:{name:`tidemind-diagnostic-v1:fixture-run:${badMarker?'wrong':'fixture-nonce'}`,version:'0.2.94'},
            tools:Object.fromEntries(['brain_prepare','brain_digest','brain_recall'].map(name=>[name,{description:'[TIDEMIND_DIAGNOSTIC_V1:fixture-run:fixture-nonce] isolated tool'}])),
            resources:[],resourceTemplates:[]},...(foreignInventory?[{name:'foreign',runtimeStatus:'connected'}]:[])],nextCursor:null};break
          case 'turn/start':response={turn:{id:'fixture-turn'}};break
          default:break
        }
        queueMicrotask(()=>{void sendNotification({id:message.id,result:response})})
      }),endInput:vi.fn(async()=>{}),armModelWindow:vi.fn(async()=>{}),observeOutput:vi.fn(async()=>{}),
      stop:vi.fn(async()=>{resolve(exit);return exit}),result}
    return child
  })
})
afterEach(()=>{fs.rmSync(root,{recursive:true,force:true})})

it.each(['openai_base_url', 'chatgpt_base_url'])('blocks explicit %s before starting metadata or app-server', async key => {
  fs.writeFileSync(configPath, `${key} = "https://fixture.invalid"\n${configuration}`)
  await expect(prepareCodexDiagnostic(input)).rejects.toThrow('billing_settings_override')
  expect(mocks.metadata).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it.each(['config.toml', 'requirements.toml', 'managed_config.toml'])('blocks a standard system override in %s before spawning', async filename => {
  const systemConfig = path.join(root, filename)
  fs.writeFileSync(systemConfig, 'chatgpt_base_url = "https://fixture.invalid"\n')
  await expect(prepareCodexDiagnostic(input, [systemConfig])).rejects.toThrow('billing_settings_override')
  expect(mocks.metadata).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('rechecks local routing after metadata, before starting app-server', async () => {
  const systemConfig = path.join(root, 'requirements.toml')
  const run = mocks.metadata.getMockImplementation()!
  mocks.metadata.mockImplementation(async spec => {
    const result = await run(spec)
    fs.writeFileSync(systemConfig, 'openai_base_url = "https://fixture.invalid"\n')
    return result
  })
  await expect(prepareCodexDiagnostic(input, [systemConfig])).rejects.toThrow('billing_settings_override')
  expect(mocks.metadata).toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it.each(['openai_base_url', 'chatgpt_base_url'])('rejects effective %s from a separate config layer', async key => {
  effectiveRouteOverride = { [key]: 'https://fixture.invalid' }
  await expect(prepareCodexDiagnostic(input)).rejects.toThrow('billing_settings_override')
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(child.stop).toHaveBeenCalledOnce()
  expect(requestLog.map(request => request.method)).not.toContain('account/read')
  expect(requestLog.map(request => request.method)).not.toContain('turn/start')
})

it('passes the capability to the dedicated app-server only, not to metadata processes', async () => {
  const session = await prepareCodexDiagnostic(input)
  try {
    expect(mocks.metadata).toHaveBeenCalled()
    for (const [{ env }] of mocks.metadata.mock.calls) {
      expect(env).not.toHaveProperty('TIDEMIND_DIAGNOSTIC_CONTEXT')
      expect(env).not.toHaveProperty('TIDEMIND_DIAGNOSTIC_REQUIRED')
    }
    expect(mocks.start.mock.calls[0][0].env).toMatchObject(input.run.environment)
  } finally {
    await session.process.stop()
  }
})

describe.skipIf(process.platform!=='darwin')('Codex native diagnostic adapter',()=>{
  it('preserves the original entry/account/model/permissions and prepares without a model turn',async()=>{
    const session=await prepareCodexDiagnostic(input)
    expect(input.onProcess).toHaveBeenCalledWith(session.process)
    expect(session.billing).toBe('confirmed_subscription')
    expect(requestLog.some(message=>message.method==='turn/start')).toBe(false)
    expect(requestLog.some(message=>message.method==='mcpServer/toolCall')).toBe(false)
    expect(child.armModelWindow).not.toHaveBeenCalled()
    const spec=mocks.start.mock.calls[0][0] as DiagnosticProcessStart
    const catalogArgument=spec.args.find(arg=>arg.startsWith('model_catalog_json='))
    expect(catalogArgument,'the native model manager must load the constrained catalog at process launch').toBeTruthy()
    const catalogPath=(parseToml(catalogArgument!) as {model_catalog_json:string}).model_catalog_json
    const executionCatalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'))
    expect(executionCatalog.models.map((model:{slug:string})=>model.slug)).toEqual(catalog.models.map(model=>model.slug))
    expect(executionCatalog.models.every((model:{apply_patch_tool_type:unknown;experimental_supported_tools:unknown[]})=>
      model.apply_patch_tool_type===null && model.experimental_supported_tools.length===0)).toBe(true)
    expect(spec.env).toMatchObject({HOME:input.homeDir,CODEX_HOME:input.binding.configRoot,...input.run.environment})
    const servers=(parseToml(spec.args.find(arg=>arg.startsWith('mcp_servers='))!) as any).mcp_servers
    expect(Object.keys(servers)).toEqual(['tidemind-fixture'])
    expect(servers['tidemind-fixture']).toMatchObject({command:'/usr/bin/true',args:['/fixture/mcp-server.cjs'],
      env:{EB_AGENT_ID:'fixture-agent',EB_ACTIVITY_GENERATION_TOKEN:'fixture-generation'},
      enabled_tools:['brain_digest','brain_prepare','brain_recall'],env_vars:['TIDEMIND_DIAGNOSTIC_REQUIRED','TIDEMIND_DIAGNOSTIC_CONTEXT']})
    expect(spec.args.some(arg=>arg.startsWith('approval_policy=')||arg.startsWith('sandbox_mode='))).toBe(false)
    expect(fs.readFileSync(configPath,'utf8')).toBe(configuration)
    await expect(session.submit('must not start unarmed')).rejects.toMatchObject({code:'model_window_not_armed'})
    expect(requestLog.some(message=>message.method==='turn/start')).toBe(false)
    await session.process.armModelWindow(Date.now()+5000)
    await session.assertUnchanged()
    const preSubmitRequests=requestLog.length
    await session.submit('synthetic controller prompt')
    expect(requestLog.slice(preSubmitRequests).map(message=>message.method)).toEqual(['turn/start'])
    expect(requestLog.filter(message=>message.method==='turn/start')).toHaveLength(1)
    await sendNotification({method:'item/agentMessage/delta',params:{itemId:'message-1',delta:'done'}})
    await sendNotification({method:'item/completed',params:{item:{type:'agentMessage',id:'message-1',text:'done'}}})
    await sendNotification({method:'turn/completed',params:{threadId:'fixture-thread',turn:{status:'completed'}}})
    expect(await session.completion).toEqual({status:'completed',reason:'native_turn_completed'})
    expect(child.observeOutput).toHaveBeenCalledWith('done')
    expect(child.observeOutput).toHaveBeenCalledTimes(1)
    await child.stop()
  })
  it('does not guess an implicit default from the execution-only sanitized catalog',async()=>{
    fs.writeFileSync(configPath,configuration.replace('model = "gpt-6-astra"\n',''))
    await expect(prepareCodexDiagnostic(input)).rejects.toMatchObject({code:'codex_model_selection_unsupported'})
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('waits for a starting original MCP without submitting a model turn',async()=>{
    startingInventory=true
    const session=await prepareCodexDiagnostic(input)
    expect(requestLog.filter(message=>message.method==='mcpServerStatus/list')).toHaveLength(2)
    expect(requestLog.some(message=>message.method==='turn/start')).toBe(false)
    await session.process.stop()
  })
  it('rejects unsupported versions and custom permission profiles before spawning',async()=>{
    await expect(prepareCodexDiagnostic({...input,binding:{...input.binding,hostVersion:'0.157.2'}})).rejects.toMatchObject({code:'codex_diagnostic_version_unsupported'})
    fs.writeFileSync(configPath,'default_permissions="custom"\n'+configuration)
    await expect(prepareCodexDiagnostic(input)).rejects.toMatchObject({code:'codex_permission_profile_unsupported'})
    expect(mocks.start).not.toHaveBeenCalled();expect(mocks.metadata).not.toHaveBeenCalled()
  })
  it('preserves unproved process exit on supervisor startup failure',async()=>{
    const error=new DiagnosticProcessError('supervisor_failed',false)
    mocks.start.mockRejectedValueOnce(error)
    await expect(prepareCodexDiagnostic(input)).rejects.toBe(error)
    expect(error.processExitConfirmed).toBe(false)
    expect(input.onProcess).not.toHaveBeenCalled()
  })
  it('retains cleanup uncertainty when an offline metadata process cannot be stopped',async()=>{
    mocks.metadata.mockRejectedValueOnce(new Error('synthetic metadata error'))
    mocks.metadataShutdown.mockRejectedValueOnce(new Error('synthetic exit unproved'))
    await expect(prepareCodexDiagnostic(input)).rejects.toMatchObject({code:'codex_metadata_unavailable',processExitConfirmed:false})
    expect(mocks.start).not.toHaveBeenCalled();expect(input.onProcess).not.toHaveBeenCalled()
  })
  it.each(['nonce','permissions','foreign','feature'])('stops failed %s preflight before any model submission',async kind=>{
    badMarker=kind==='nonce';permissionChanged=kind==='permissions';foreignInventory=kind==='foreign';unknownFeature=kind==='feature'
    await expect(prepareCodexDiagnostic(input)).rejects.toBeInstanceOf(Error)
    expect(input.onProcess).toHaveBeenCalledWith(expect.objectContaining({identity:child.identity}))
    expect(child.stop).toHaveBeenCalled()
    expect(requestLog.some(message=>message.method==='turn/start')).toBe(false)
  })
  it('does not call billing overrides a subscription, but preserves them in the native environment',async()=>{
    input.sourceEnv.OPENAI_BASE_URL='https://fixture.invalid/v1'
    const session=await prepareCodexDiagnostic(input)
    expect(session.billing).toBe('unknown')
    expect(mocks.start.mock.calls[0][0].env.OPENAI_BASE_URL).toBe(input.sourceEnv.OPENAI_BASE_URL)
    await child.stop()
  })
  it('rejects changed configuration and concurrent duplicate submissions without sending a second turn',async()=>{
    const session=await prepareCodexDiagnostic(input)
    await session.process.armModelWindow(Date.now()+5000)
    const attempts=await Promise.allSettled([session.submit('once'),session.submit('twice')])
    expect(attempts.map(item=>item.status).sort()).toEqual(['fulfilled','rejected'])
    expect(requestLog.filter(message=>message.method==='turn/start')).toHaveLength(1)
    fs.appendFileSync(configPath,'\n# changed\n')
    await expect(session.assertUnchanged()).rejects.toMatchObject({code:'codex_configuration_changed'})
    await child.stop()
  })
  it('rejects a known changed configuration in the final pre-submit check without sending a turn',async()=>{
    const session=await prepareCodexDiagnostic(input)
    await session.process.armModelWindow(Date.now()+5000)
    fs.appendFileSync(configPath,'\n# changed before submission\n')
    await expect(session.assertUnchanged()).rejects.toMatchObject({code:'codex_configuration_changed'})
    expect(requestLog.some(message=>message.method==='turn/start')).toBe(false)
    await child.stop()
  })
  it('checks cancellation locally after final preflight and never submits after cancellation',async()=>{
    const abort=new AbortController();input.signal=abort.signal
    const session=await prepareCodexDiagnostic(input)
    await session.process.armModelWindow(Date.now()+5000);await session.assertUnchanged();abort.abort()
    await expect(session.submit('cancelled prompt')).rejects.toMatchObject({code:'cancelled'})
    expect(requestLog.some(message=>message.method==='turn/start')).toBe(false)
    await child.stop()
  })
  it('returns native permission required without approving the request',async()=>{
    const session=await prepareCodexDiagnostic(input);await session.process.armModelWindow(Date.now()+5000);await session.submit('synthetic prompt')
    await sendNotification({id:999,method:'item/tool/requestUserInput',params:{}})
    expect(await session.completion).toEqual({status:'permission_required',reason:'native_permission_required'})
    const response=(child.write as ReturnType<typeof vi.fn>).mock.calls.map(([text])=>JSON.parse(text)).find(message=>message.id===999)
    expect(response.error.code).toBe(-32601);expect(response.result).toBeUndefined()
    await child.stop()
  })
  it('counts final-only assistant text even when the provider did not stream deltas',async()=>{
    const session=await prepareCodexDiagnostic(input);await session.process.armModelWindow(Date.now()+5000);await session.submit('synthetic prompt')
    await sendNotification({method:'item/completed',params:{item:{type:'agentMessage',id:'final-only',text:'final text without deltas'}}})
    expect(child.observeOutput).toHaveBeenCalledWith('final text without deltas')
    await child.stop()
  })
  it('denies global AGENTS and its canonical symlink target without changing either file',()=>{
    const canonical=path.join(root,'private-context.md'),link=path.join(input.binding.configRoot,'AGENTS.md')
    fs.writeFileSync(canonical,'private fixture');fs.symlinkSync(canonical,link)
    const policy=codexDiagnosticSandbox(input.binding.configRoot)
    expect(policy).toContain(JSON.stringify(link));expect(policy).toContain(JSON.stringify(canonical))
    expect(fs.readFileSync(link,'utf8')).toBe('private fixture');expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })
})
