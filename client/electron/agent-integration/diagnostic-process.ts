import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  DiagnosticProcessError, boundedDiagnosticPreparation, boundedDiagnosticProtocol, DIAGNOSTIC_INPUT_CHUNK_LIMIT,
  type DiagnosticChildSpec, type DiagnosticProcessIdentity, type DiagnosticProcessResult,
  type DiagnosticSupervisorCommand, type DiagnosticSupervisorEvent,
} from '@server/agent-diagnostic-runner.js'

export interface DiagnosticSupervisorLaunch {
  /** Trusted Node/Electron executable and dedicated runner entry, supplied by composition. */
  executable: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
}
export interface DiagnosticProcessStart extends DiagnosticChildSpec {
  onStdout(text: string): void | Promise<void>
  onStderr?(text: string): void | Promise<void>
  signal?: AbortSignal
}
export interface DiagnosticProcessSession {
  pid: number
  supervisorPid: number
  /** Safe to persist. No raw argv, environment, protocol or capability. */
  identity: DiagnosticProcessIdentity
  write(text: string): Promise<void>
  endInput(): Promise<void>
  armModelWindow(deadline: number | Date): Promise<void>
  /** Adapters report actual observed text, not account/config/schema protocol metadata. */
  observeOutput(text: string): Promise<void>
  stop(): Promise<DiagnosticProcessResult>
  result: Promise<DiagnosticProcessResult>
}

/** A-side only: spawning does not write initialization, a prompt, a turn, or EOF. */
export async function startDiagnosticProcess(input: DiagnosticProcessStart, launch: DiagnosticSupervisorLaunch): Promise<DiagnosticProcessSession> {
  if (input.signal?.aborted) throw new DiagnosticProcessError('cancelled',true)
  if (process.platform==='win32' || !path.isAbsolute(launch.executable) || typeof input.onStdout!=='function') throw new DiagnosticProcessError('invalid_supervisor',true)
  const prepareTimeoutMs=boundedDiagnosticPreparation(input.prepareTimeoutMs)
  const rawProtocolLimitBytes=boundedDiagnosticProtocol(input.rawProtocolLimitBytes)
  const supervisor=spawn(launch.executable,[...launch.args],{
    cwd:input.cwd,env:launch.env ?? process.env,shell:false,detached:true,stdio:['ignore','pipe','pipe','ipc'],
  })
  let identity: DiagnosticProcessIdentity | undefined
  let reported: DiagnosticProcessResult | undefined
  let closed=false, stopping=false, nextId=0, armed=false
  let stdoutBytes=0,stderrBytes=0,observedBytes=0,supervisorBytes=0
  let forceStopTimer: NodeJS.Timeout | undefined
  let resolveResult!: (result:DiagnosticProcessResult)=>void
  let resolveReady!: (session:DiagnosticProcessSession)=>void
  let rejectReady!: (error:Error)=>void
  const result=new Promise<DiagnosticProcessResult>(resolve=>{resolveResult=resolve})
  const ready=new Promise<DiagnosticProcessSession>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
  const pending=new Map<number,{resolve():void;reject(error:Error):void}>()
  const rejectPending=()=>{
    for(const request of pending.values())request.reject(new DiagnosticProcessError('session_closed'))
    pending.clear()
  }
  const stop=(reason:'cancelled'|'adapter_error'='cancelled'):Promise<DiagnosticProcessResult>=>{
    if(closed||stopping)return result
    stopping=true
    if(supervisor.connected) {
      try {supervisor.send({protocolVersion:1,type:'stop',reason},error=>{if(error)supervisor.kill('SIGTERM')})}
      catch {supervisor.kill('SIGTERM')}
    } else supervisor.kill('SIGTERM')
    // This handle belongs to the supervisor spawned above, never a stored PID.
    // Its own SIGTERM/IPC handler owns target-group cleanup. A failed supervisor
    // is reported as unproved cleanup; the controller must retain the data dir.
    forceStopTimer=setTimeout(()=>{if(!closed)supervisor.kill('SIGKILL')},2500)
    return result
  }
  const request=(message: {type:'write';text:string}|{type:'end_input'}|{type:'arm_model';deadline:number}|{type:'observe_output';bytes:number}):Promise<void>=>{
    if(closed||stopping||!supervisor.connected)return Promise.reject(new DiagnosticProcessError('session_closed'))
    const id=++nextId
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject})
      try {supervisor.send({protocolVersion:1,id,...message},error=>{
        if(!error)return
        pending.delete(id);reject(new DiagnosticProcessError('transport_failed'));void stop()
      })} catch {pending.delete(id);reject(new DiagnosticProcessError('transport_failed'));void stop()}
    })
  }
  const onAbort=()=>{void stop()}
  input.signal?.addEventListener('abort',onAbort,{once:true})
  const bootTimer=setTimeout(()=>{void stop()},5000)
  const deliver=(callback:((text:string)=>void|Promise<void>)|undefined,text:string)=>{
    if(!callback)return
    try {void Promise.resolve(callback(text)).catch(()=>{void stop('adapter_error')})}
    catch {void stop('adapter_error')}
  }
  supervisor.on('message',(raw:unknown)=>{
    if(!raw||typeof raw!=='object'||(raw as {protocolVersion?:unknown}).protocolVersion!==1){void stop('adapter_error');return}
    const event=raw as DiagnosticSupervisorEvent
    if(event.type==='ready') {
      if(identity||!Number.isSafeInteger(event.identity?.pid)||event.identity.pid<1
        ||event.identity.processGroupId!==event.identity.pid||event.identity.supervisorPid!==supervisor.pid){void stop('adapter_error');return}
      identity=event.identity;clearTimeout(bootTimer)
      resolveReady({pid:identity.pid,supervisorPid:supervisor.pid!,identity,
        write:text=>typeof text==='string' && Buffer.byteLength(text)<=DIAGNOSTIC_INPUT_CHUNK_LIMIT
          ?request({type:'write',text}):Promise.reject(new DiagnosticProcessError('input_limit')),
        endInput:()=>request({type:'end_input'}),
        armModelWindow:async deadline=>{await request({type:'arm_model',deadline:deadline instanceof Date?deadline.getTime():deadline});armed=true},
        observeOutput:async text=>{
          if(typeof text!=='string')throw new DiagnosticProcessError('invalid_output_observation')
          const bytes=Buffer.byteLength(text);observedBytes+=bytes
          await request({type:'observe_output',bytes})
        },stop:()=>stop(),result})
    } else if(event.type==='stdout'||event.type==='stderr') {
      if(typeof event.text!=='string'){void stop('adapter_error');return}
      if(event.type==='stdout')stdoutBytes+=Buffer.byteLength(event.text);else stderrBytes+=Buffer.byteLength(event.text)
      if(stdoutBytes+stderrBytes>rawProtocolLimitBytes){void stop('adapter_error');return}
      deliver(event.type==='stdout'?input.onStdout:input.onStderr,event.text)
    } else if(event.type==='ack') {
      const waiter=pending.get(event.id);if(!waiter)return
      pending.delete(event.id)
      if(event.ok)waiter.resolve()
      else waiter.reject(new DiagnosticProcessError(event.code && /^[a-z_]{1,64}$/.test(event.code)?event.code:'command_failed'))
    } else if(event.type==='result') {
      reported=event.result;rejectPending()
    } else {void stop('adapter_error')}
  })
  // These are supervisor startup diagnostics, not the CLI protocol. Drain but
  // never log/return them: a loader error can echo argv or inherited environment.
  const drain=(chunk:Buffer)=>{supervisorBytes+=chunk.byteLength;if(supervisorBytes>64*1024)void stop('adapter_error')}
  supervisor.stdout?.on('data',drain);supervisor.stderr?.on('data',drain)
  supervisor.once('error',()=>{void stop()})
  supervisor.once('disconnect',()=>{if(!reported&&!closed)void stop()})
  supervisor.once('close',()=>{
    closed=true;clearTimeout(bootTimer);if(forceStopTimer)clearTimeout(forceStopTimer)
    input.signal?.removeEventListener('abort',onAbort);rejectPending()
    const outcome:DiagnosticProcessResult=reported?{...reported,supervisorExited:true}:{
      reason:'supervisor_failed',exitCode:null,signal:null,processGroupExited:false,supervisorExited:true,
      rawStdoutBytes:stdoutBytes,rawStderrBytes:stderrBytes,observedOutputBytes:observedBytes,modelWindowArmed:armed,
    }
    if(!identity)rejectReady(new DiagnosticProcessError(outcome.reason,outcome.processGroupExited&&outcome.supervisorExited))
    resolveResult(outcome)
  })
  const spec:DiagnosticChildSpec={executable:input.executable,args:[...input.args],cwd:input.cwd,env:{...input.env},prepareTimeoutMs,rawProtocolLimitBytes}
  const init:DiagnosticSupervisorCommand={protocolVersion:1,type:'init',spec}
  try {supervisor.send(init,error=>{if(error)void stop()})}catch{void stop()}
  if(input.signal?.aborted)void stop()
  return ready
}
