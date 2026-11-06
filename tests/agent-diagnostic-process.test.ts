import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createDiagnosticFixture, MEM, HOOK } from './fixtures/agent-diagnostic-fixture'
import { createNode } from '../src/db/nodes'
import { DIAGNOSTIC_TOOL_DESCRIPTIONS, diagnosticContent, diagnosticToolMarker, diagnosticServerName, readDiagnosticReceipt, verifyDiagnosticReceipt } from '../src/agent-diagnostic-receipts'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(root, 'client/package.json'))
const electron = require('electron') as string
const script = (name: string) => path.join(root, 'client/out/bin', name)
function environment(f: ReturnType<typeof createDiagnosticFixture>, run: ReturnType<typeof f.prepare>) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.home, USER: 'synthetic-user', TMPDIR: f.root,
    ELECTRON_RUN_AS_NODE: '1', ...run.environment, EB_AGENT_ID: f.canonical,
    EB_ACTIVITY_GENERATION_TOKEN: MEM, EB_HOST_VARIANT: 'claude-code-native', ANTHROPIC_API_KEY: 'PRIVATE_ENV_KEY_SENTINEL' }
}
function text(result: any): string { return result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') }
function execute(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin='') {
  return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(command,args,{env,cwd,stdio:['pipe','pipe','pipe']})
    let stdout='',stderr=''
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('diagnostic fixture child timeout'))},15_000)
    child.stdout.on('data',chunk=>{stdout+=String(chunk)});child.stderr.on('data',chunk=>{stderr+=String(chunk)})
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})})
    child.stdin.on('error',()=>{});child.stdin.end(stdin)
  })
}

describe('packaged diagnostic MCP and Hook domain',()=>{
  it('uses the existing MCP entry for a real write/ID-read loop without real memory, async jobs or model calls',async()=>{
    const f=createDiagnosticFixture(false,'Asia/Shanghai',new Date()),run=f.prepare(),context=f.context(run)
    createNode(f.db,{content:'PRIVATE_MEMORY_SENTINEL',source_tool:'fixture'})
    const before=f.db.prepare('SELECT COUNT(*) n FROM nodes').get()
    const client=new Client({name:'diagnostic-fixture',version:'1'})
    const transport=new StdioClientTransport({command:electron,args:[script('mcp-server.cjs')],cwd:f.root,env:environment(f,run),stderr:'pipe'})
    let stderr='';transport.stderr?.on('data',chunk=>{stderr+=String(chunk)})
    let local:Database.Database|undefined
    try {
      await client.connect(transport)
      expect(client.getServerVersion()?.name).toBe(diagnosticServerName(context))
      const tools=await client.listTools()
      expect(tools.tools).toHaveLength(3)
      expect(tools.tools.every(tool=>tool.description?.startsWith(diagnosticToolMarker(context)))).toBe(true)
      const prepared=await client.callTool({name:'brain_prepare',arguments:{tool:'claude-code'}})
      expect(prepared.isError,stderr+'\n'+text(prepared)).not.toBe(true)
      expect(text(prepared)).not.toContain('PRIVATE_')
      const resources=await client.listResources()
      expect(resources.resources).toEqual([])
      await expect(client.readResource({uri:'file://'+path.join(f.controlData,'config.toml')})).rejects.toThrow(/resources.*unavailable|does not support resources/i)
      const written=await client.callTool({name:'brain_digest',arguments:{content:diagnosticContent(context),async:true}})
      expect(written.isError,stderr+'\n'+text(written)).not.toBe(true)
      const output=JSON.parse(text(written));expect(output.status).toBe('processed')
      expect(output.created_nodes).toHaveLength(1)
      const read=await client.callTool({name:'brain_recall',arguments:{node_id:output.created_nodes[0].id}})
      expect(read.isError,stderr+'\n'+text(read)).not.toBe(true)
      expect(text(read)).toContain(diagnosticContent(context));expect(text(read)).not.toContain('PRIVATE_')
      local=new Database(run.databasePath)
      expect(verifyDiagnosticReceipt(local,context)).toMatchObject({toolCalls:3,writtenNodeId:output.created_nodes[0].id,readNodeId:output.created_nodes[0].id})
      expect(local.prepare('SELECT COUNT(*) n FROM pending_digests').get()).toEqual({n:0})
      expect(local.prepare("SELECT COUNT(*) n FROM metadata WHERE key GLOB 'last_task_*'").get()).toEqual({n:0})
      expect(local.prepare("SELECT COUNT(*) n FROM operation_log WHERE operation='prepare'").get()).toEqual({n:0})
      expect(local.prepare('SELECT COUNT(*) n FROM nodes').get()).toEqual({n:1})
      expect(fs.readdirSync(path.join(run.dataDir,'stream')).length).toBeGreaterThan(0)
      expect(f.db.prepare('SELECT COUNT(*) n FROM nodes').get()).toEqual(before)
      expect(f.db.prepare('SELECT COUNT(*) n FROM agent_host_activity_evidence').get()).toEqual({n:0})
      await client.callTool({name:'brain_prepare',arguments:{tool:'claude-code'}})
      await expect(client.callTool({name:'brain_prepare',arguments:{tool:'claude-code'}})).rejects.toThrow('Diagnostic call rejected')
      expect(readDiagnosticReceipt(local,context)).toMatchObject({toolCalls:5,failureCode:'tool_limit'})
      expect(()=>verifyDiagnosticReceipt(local!,context)).toThrow('diagnostic_receipt_incomplete')
    } finally {await client.close();local?.close();f.done(run.runId);f.close()}
  },25_000)

  it('routes startup/compaction/end/restore hooks to the same private domain before reading personal files',async()=>{
    const f=createDiagnosticFixture(true,'Asia/Shanghai',new Date()),run=f.prepare(),context=f.context(run)
    createNode(f.db,{content:'PRIVATE_MEMORY_SENTINEL',source_tool:'fixture'})
    const skill=path.join(f.controlData,'private-skill.md');fs.writeFileSync(skill,'PRIVATE_SKILL_SENTINEL')
    const transcript=path.join(f.controlData,'private-transcript.jsonl');fs.writeFileSync(transcript,'PRIVATE_TRANSCRIPT_SENTINEL')
    const env=environment(f,run)
    const args=['--agent-id',f.canonical,'--activity-generation-token',HOOK,'--tool','codex']
    try {
      for(const [file,extra] of [
        ['hook-session-start.cjs',['--skill-path',skill]],['hook-pre-compact.cjs',[]],['hook-post-compact.cjs',[]],
        ['hook-session-end.cjs',[]],['hook-codex-user-prompt-submit.cjs',[]],
      ] as const) {
        const result=await execute(electron,[script(file),...args,...extra],env,f.root,
          JSON.stringify({session_id:'diagnostic-fixture',transcript_path:transcript,hook_event_name:'SessionStart'}))
        expect(result.code,result.stderr).toBe(0)
        expect(result.stdout+result.stderr).not.toContain('PRIVATE_')
      }
      const local=new Database(run.databasePath)
      try {expect(new Set(readDiagnosticReceipt(local,context).hooks)).toEqual(new Set(['session_start','pre_compact','post_compact','session_end']))}
      finally{local.close()}
      expect(f.db.prepare('SELECT COUNT(*) n FROM agent_host_activity_evidence').get()).toEqual({n:0})
      expect(f.db.prepare('SELECT COUNT(*) n FROM nodes').get()).toEqual({n:1})
    } finally{f.done(run.runId);f.close()}
  },25_000)

  it('rejects a missing required credential instead of opening the normal database',async()=>{
    const f=createDiagnosticFixture(false,'Asia/Shanghai',new Date()),run=f.prepare()
    createNode(f.db,{content:'PRIVATE_MEMORY_SENTINEL',source_tool:'fixture'})
    try {
      const env={...environment(f,run),TIDEMIND_DIAGNOSTIC_CONTEXT:''}
      const output=await execute(electron,[script('mcp-server.cjs')],env,f.root)
      expect(output.code).not.toBe(0);expect(output.stdout+output.stderr).not.toContain('PRIVATE_')
      expect(f.db.prepare('SELECT COUNT(*) n FROM nodes').get()).toEqual({n:1})
      expect(f.db.prepare('SELECT COUNT(*) n FROM operation_log').get()).toEqual({n:0})
    }finally{f.done(run.runId);f.close()}
  })

  it('rejects a revoked capability on an already-open MCP process without falling back',async()=>{
    const f=createDiagnosticFixture(false,'Asia/Shanghai',new Date()),run=f.prepare()
    const client=new Client({name:'diagnostic-fixture',version:'1'})
    const transport=new StdioClientTransport({command:electron,args:[script('mcp-server.cjs')],cwd:f.root,env:environment(f,run),stderr:'pipe'})
    try {
      await client.connect(transport)
      expect((await client.callTool({name:'brain_prepare',arguments:{tool:'claude-code'}})).isError).not.toBe(true)
      f.store.cancel(run.runId)
      await expect(client.callTool({name:'brain_digest',arguments:{content:diagnosticContent({nonce:run.nonce}),async:false}})).rejects.toThrow('Diagnostic call rejected')
      expect(f.db.prepare('SELECT COUNT(*) n FROM nodes').get()).toEqual({n:0})
      expect(f.db.prepare('SELECT COUNT(*) n FROM operation_log').get()).toEqual({n:0})
    }finally{await client.close();f.done(run.runId);f.close()}
  })

  it('pins worker configuration to the private domain and rejects a mismatched worker snapshot',async()=>{
    const f=createDiagnosticFixture(false,'Asia/Shanghai',new Date()),run=f.prepare()
    try {
      const code=`const c=await import(${JSON.stringify(path.join(root,'dist/config.js'))});
        const w=await import(${JSON.stringify(path.join(root,'dist/metabolism/worker-runtime-context.js'))});
        const config=c.loadConfig();
        w.installMetabolismWorkerRuntimeContext({runtimeRevision:1,config:{...config,anthropic:{api_key:'PRIVATE_WORKER_KEY_SENTINEL'}},
          connectionSnapshot:{connections:[]},strategySnapshot:{},credentials:{},dataDir:config.general.data_dir});
        const pinned={dataDir:c.getDataDir(),key:c.getConfig().anthropic.api_key};w.clearMetabolismWorkerRuntimeContext();
        const wrong=${JSON.stringify(f.controlData)};
        w.installMetabolismWorkerRuntimeContext({runtimeRevision:2,config:{...config,general:{...config.general,data_dir:wrong}},
          connectionSnapshot:{connections:[]},strategySnapshot:{},credentials:{},dataDir:wrong});
        let error='';try{c.getDataDir()}catch(e){error=e.message}
        process.stdout.write(JSON.stringify({pinned,error}));`
      const env={...environment(f,run)};delete (env as Record<string,unknown>).ELECTRON_RUN_AS_NODE
      const result=await execute(process.execPath,['--input-type=module','-e',code],env,f.root)
      expect(result.code,result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({pinned:{dataDir:run.dataDir,key:''},error:'agent_diagnostic:worker_domain_mismatch'})
    }finally{f.done(run.runId);f.close()}
  })

  it('does not inherit configuration credentials or enable nested model/embedding work',async()=>{
    const f=createDiagnosticFixture(false,'Asia/Shanghai',new Date()),run=f.prepare()
    try {
      const code=`globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};
        const c=await import(${JSON.stringify(path.join(root,'dist/config.js'))});
        const l=await import(${JSON.stringify(path.join(root,'dist/llm/client.js'))});
        const e=await import(${JSON.stringify(path.join(root,'dist/llm/embedding.js'))});
        const config=c.loadConfig();
        let llm='',embedding='';try{await l.callLLM({prompt:'fixture'})}catch(error){llm=error.message}
        try{await e.getEmbedding('fixture')}catch(error){embedding=error.message}
        process.stdout.write(JSON.stringify({dataDir:c.getDataDir(),user:config.general.user_name,key:config.anthropic.api_key,llm,embedding}));`
      const env={...environment(f,run)};delete (env as Record<string,unknown>).ELECTRON_RUN_AS_NODE
      const result=await execute(process.execPath,['--input-type=module','-e',code],env,f.root)
      expect(result.code,result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({dataDir:run.dataDir,user:'Tide Mind diagnostic',key:'',
        llm:'agent_diagnostic:model_calls_disabled',embedding:'agent_diagnostic:embedding_calls_disabled'})
    }finally{f.done(run.runId);f.close()}
  })

  it('keeps the diagnostic-only tool text and packaged fallback in sync',()=>{
    expect(JSON.parse(fs.readFileSync(path.join(root,'data/mcp-diagnostic-descriptions.json'),'utf8'))).toEqual(DIAGNOSTIC_TOOL_DESCRIPTIONS)
  })
})
