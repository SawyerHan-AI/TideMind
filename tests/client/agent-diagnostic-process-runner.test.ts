import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { startDiagnosticProcess, type DiagnosticProcessSession } from '../../client/electron/agent-integration/diagnostic-process'
import { readDiagnosticProcessStartIdentity, type DiagnosticProcessIdentity, type DiagnosticSupervisorEvent } from '../../src/agent-diagnostic-runner'
vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>()
  return {...actual,execFile:vi.fn(actual.execFile)}
})

const repo=path.resolve(import.meta.dirname,'../..')
let root:string,supervisorEntry:string
const sessions:DiagnosticProcessSession[]=[]
const directChildren:ChildProcess[]=[]
function alive(pid:number):boolean {try{process.kill(pid,0);return true}catch{return false}}
function script(name:string,content:string):string {const file=path.join(root,name);fs.writeFileSync(file,content);return file}
async function bundle(entry:string,outfile:string) {
  await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',target:'node20',
    alias:{'@server':path.join(repo,'src')},logLevel:'silent'})
}
const launch=()=>({executable:process.execPath,args:[supervisorEntry]})
const environment=(extra:NodeJS.ProcessEnv={})=>({PATH:process.env.PATH ?? '/usr/bin:/bin',...extra})
async function start(file:string,options:Partial<Parameters<typeof startDiagnosticProcess>[0]>={}) {
  const session=await startDiagnosticProcess({executable:process.execPath,args:[file],cwd:root,env:environment(),onStdout:()=>{},...options},launch())
  sessions.push(session);return session
}
beforeAll(async()=>{
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-process-runner-')))
  const entry=script('supervisor-entry.ts',`import {runDiagnosticSupervisor} from ${JSON.stringify(path.join(repo,'src/agent-diagnostic-runner.ts'))};
    runDiagnosticSupervisor().catch(()=>{process.exitCode=1});`)
  supervisorEntry=path.join(root,'supervisor.mjs');await bundle(entry,supervisorEntry)
})
afterEach(async()=>{
  await Promise.all(sessions.splice(0).map(session=>session.stop()))
  for(const child of directChildren.splice(0)){if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL')}
})
afterAll(()=>{fs.rmSync(root,{recursive:true,force:true})})

describe('dedicated A-side diagnostic supervisor',()=>{
  it('treats a synchronous ps EPERM as unknown identity without crashing supervision',async()=>{
    vi.mocked(execFile).mockImplementationOnce(()=>{throw Object.assign(new Error('synthetic EPERM'),{code:'EPERM'})})
    await expect(readDiagnosticProcessStartIdentity(process.pid)).resolves.toBeNull()
  })
  it.each(['codex-json-lines','claude-stream-json'])('keeps %s stdin open for initialization and a later turn',async kind=>{
    const received=path.join(root,kind+'.received')
    const target=script(kind+'.mjs',`import fs from 'node:fs';import readline from 'node:readline';
      fs.writeFileSync(process.env.RECEIVED,'');
      const reader=readline.createInterface({input:process.stdin});
      console.log(JSON.stringify({type:'metadata',schema:'x'.repeat(12*1024)}));
      reader.on('line',line=>{fs.appendFileSync(process.env.RECEIVED,line+'\\n');const value=JSON.parse(line);
        console.log(JSON.stringify({type:'reply',received:value}));});
      reader.on('close',()=>console.log(JSON.stringify({type:'eof'})));`)
    let stdout=''
    const session=await start(target,{env:environment({RECEIVED:received}),onStdout:text=>{stdout+=text}})
    await vi.waitFor(()=>expect(stdout).toContain('metadata'))
    expect(fs.readFileSync(received,'utf8')).toBe('')
    expect(session.identity).toMatchObject({pid:session.pid,processGroupId:session.pid,supervisorPid:session.supervisorPid,cwd:root})
    expect(session.identity.executableRealpath).toBe(fs.realpathSync(process.execPath))
    expect(session.identity.argumentsHash).toMatch(/^[a-f0-9]{64}$/)
    expect(session.identity.osStartIdentity).toBeTruthy()
    await session.write(JSON.stringify({method:'initialize',kind})+'\n')
    await vi.waitFor(()=>expect(stdout).toContain('initialize'))
    expect(alive(session.pid)).toBe(true)
    await session.armModelWindow(Date.now()+5000)
    await session.write(JSON.stringify({method:'turn',text:'synthetic prompt'})+'\n')
    await vi.waitFor(()=>expect(stdout).toContain('synthetic prompt'))
    await session.observeOutput('synthetic reply')
    await session.endInput()
    const result=await session.result
    expect(result).toMatchObject({reason:'exited',exitCode:0,processGroupExited:true,supervisorExited:true,modelWindowArmed:true,observedOutputBytes:15})
    expect(result.rawStdoutBytes).toBeGreaterThan(8*1024)
    expect(fs.readFileSync(received,'utf8').trim().split('\n')).toHaveLength(2)
  })
  it('counts only adapter-observed text against 8KiB, separately from protocol metadata',async()=>{
    let output=''
    const target=script('output.mjs',`console.log(JSON.stringify({account:{synthetic:true},tools:'m'.repeat(20000)}));setInterval(()=>{},1000);`)
    const session=await start(target,{onStdout:text=>{output+=text}})
    await vi.waitFor(()=>expect(output.length).toBeGreaterThan(8192))
    await session.armModelWindow(Date.now()+5000)
    await session.observeOutput('x'.repeat(8192))
    await expect(session.observeOutput('界')).rejects.toThrow('output_limit')
    expect(await session.result).toMatchObject({reason:'output_limit',observedOutputBytes:8195,processGroupExited:true,supervisorExited:true})
  })
  it('bounds raw protocol independently before any model window is armed',async()=>{
    const target=script('protocol.mjs',`process.stdin.on('data',()=>process.stdout.write('x'.repeat(4096)));setInterval(()=>{},1000);`)
    const session=await start(target,{rawProtocolLimitBytes:1024})
    await session.write('metadata request\n').catch(()=>{})
    expect(await session.result).toMatchObject({reason:'protocol_limit',modelWindowArmed:false,observedOutputBytes:0,processGroupExited:true})
  })
  it('allows arming only once and distinguishes preparation from model timeout',async()=>{
    const target=script('waiting.mjs','setInterval(()=>{},1000)')
    const prepared=await start(target,{prepareTimeoutMs:1000})
    expect(await prepared.result).toMatchObject({reason:'prepare_timeout',modelWindowArmed:false,processGroupExited:true})
    const model=await start(target)
    await model.armModelWindow(Date.now()+500)
    await expect(model.armModelWindow(Date.now()+5000)).rejects.toThrow('model_window_already_armed')
    expect(await model.result).toMatchObject({reason:'model_timeout',modelWindowArmed:true,processGroupExited:true})
  })
  it('cancels the owned child and descendants without touching an unrelated process',async()=>{
    const pids=path.join(root,'cancel-descendants.json')
    const target=script('tree.mjs',`import fs from 'node:fs';import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(process.env.PIDS,JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`)
    const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});directChildren.push(unrelated)
    const abort=new AbortController(), session=await start(target,{env:environment({PIDS:pids}),signal:abort.signal})
    await vi.waitFor(()=>expect(fs.existsSync(pids)).toBe(true))
    const owned=JSON.parse(fs.readFileSync(pids,'utf8')) as number[]
    abort.abort(new Error('PRIVATE_ABORT_REASON_SENTINEL'))
    const result=await session.result
    expect(result).toMatchObject({reason:'cancelled',processGroupExited:true,supervisorExited:true})
    await vi.waitFor(()=>expect(owned.map(alive)).toEqual([false,false]))
    expect(alive(unrelated.pid!)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })
  it('cleans its group when the controller is killed, using IPC disconnection rather than a controller finally block',async()=>{
    const ready=path.join(root,'controller-ready.json'), descendants=path.join(root,'orphan-descendants.json')
    const target=script('orphan-tree.mjs',`import fs from 'node:fs';import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(process.env.PIDS,JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`)
    const controllerEntry=script('controller-entry.ts',`import fs from 'node:fs';
      import {startDiagnosticProcess} from ${JSON.stringify(path.join(repo,'client/electron/agent-integration/diagnostic-process.ts'))};
      const session=await startDiagnosticProcess({executable:process.execPath,args:[${JSON.stringify(target)}],cwd:${JSON.stringify(root)},
        env:{PATH:process.env.PATH,PIDS:${JSON.stringify(descendants)}},onStdout:()=>{}},
        {executable:process.execPath,args:[${JSON.stringify(supervisorEntry)}]});
      fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify(session.identity));setInterval(()=>{},1000);`)
    const controllerBundle=path.join(root,'controller.mjs');await bundle(controllerEntry,controllerBundle)
    const controller=spawn(process.execPath,[controllerBundle],{stdio:'ignore'});directChildren.push(controller)
    await vi.waitFor(()=>expect(fs.existsSync(ready)&&fs.existsSync(descendants)).toBe(true),{timeout:5000})
    const identity=JSON.parse(fs.readFileSync(ready,'utf8')) as DiagnosticProcessIdentity
    const children=JSON.parse(fs.readFileSync(descendants,'utf8')) as number[]
    controller.kill('SIGKILL')
    await vi.waitFor(()=>expect([...children,identity.supervisorPid].map(alive)).toEqual([false,false,false]),{timeout:5000})
  })
  it('also stops the child on explicit IPC disconnection while the controller remains alive',async()=>{
    const target=script('ipc-child.mjs','setInterval(()=>{},1000)')
    const supervisor=spawn(process.execPath,[supervisorEntry],{stdio:['ignore','ignore','ignore','ipc'],detached:true});directChildren.push(supervisor)
    const ready=new Promise<DiagnosticProcessIdentity>((resolve,reject)=>{
      supervisor.on('message',(message:DiagnosticSupervisorEvent)=>{if(message.type==='ready')resolve(message.identity)})
      supervisor.once('error',()=>reject(new Error('fixture supervisor failed')))
    })
    supervisor.send({protocolVersion:1,type:'init',spec:{executable:process.execPath,args:[target],cwd:root,env:environment()}})
    const identity=await ready
    supervisor.disconnect()
    await vi.waitFor(()=>expect([identity.pid,identity.supervisorPid].map(alive)).toEqual([false,false]),{timeout:5000})
  })
  it('does not return or log environment, raw stderr, callback errors, or supervisor loader output',async()=>{
    const secret='PRIVATE_ENV_CREDENTIAL_SENTINEL'
    const target=script('private-error.mjs',`process.stdin.on('data',()=>{console.log(process.env.PRIVATE_ENV);console.error(process.env.PRIVATE_ENV)});setInterval(()=>{},1000);`)
    const log=vi.spyOn(console,'error').mockImplementation(()=>{})
    try {
      const session=await start(target,{env:environment({PRIVATE_ENV:secret}),onStdout:text=>{if(text.includes(secret))throw new Error(secret)}})
      await session.write('go\n').catch(()=>{})
      const result=await session.result
      expect(result).toMatchObject({reason:'adapter_error',processGroupExited:true})
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(session.identity)).not.toContain(secret)
      expect(log).not.toHaveBeenCalled()
      const badSupervisor=script('bad-supervisor.mjs',`console.error(process.env.PRIVATE_ENV);process.exit(1)`)
      await expect(startDiagnosticProcess({executable:process.execPath,args:[target],cwd:root,env:environment(),onStdout:()=>{}},
        {executable:process.execPath,args:[badSupervisor],env:environment({PRIVATE_ENV:secret})})).rejects.toThrow('supervisor_failed')
      expect(log).not.toHaveBeenCalled()
    } finally {log.mockRestore()}
  })
})
