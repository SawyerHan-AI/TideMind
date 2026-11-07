import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CliProcessRegistry, isProcessGroupAlive } from './llm/cli/child-process-runner.js';

export const DIAGNOSTIC_PROCESS_PROTOCOL = 1;
export const DIAGNOSTIC_PREPARE_TIMEOUT_MS = 30_000;
export const DIAGNOSTIC_MODEL_WINDOW_MS = 90_000;
export const DIAGNOSTIC_RAW_PROTOCOL_LIMIT = 8 * 1024 * 1024;
export const DIAGNOSTIC_OBSERVED_OUTPUT_LIMIT = 8 * 1024;
export const DIAGNOSTIC_INPUT_CHUNK_LIMIT = 1024 * 1024;
export type DiagnosticProcessReason = 'exited' | 'cancelled' | 'prepare_timeout' | 'model_timeout'
  | 'protocol_limit' | 'output_limit' | 'controller_disconnected' | 'spawn_failed'
  | 'transport_failed' | 'supervisor_failed' | 'cleanup_failed' | 'invalid_spec' | 'adapter_error';
export interface DiagnosticProcessIdentity {
  protocolVersion: 1;
  pid: number;
  processGroupId: number;
  supervisorPid: number;
  startedAt: string;
  /** Kernel-reported start identity, not an inference from the PID. Null is not restart authority. */
  osStartIdentity: string | null;
  supervisorStartIdentity?: string | null;
  executableRealpath: string;
  argumentsHash: string;
  cwd: string;
}
export interface DiagnosticProcessResult {
  reason: DiagnosticProcessReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processGroupExited: boolean;
  supervisorExited: boolean;
  rawStdoutBytes: number;
  rawStderrBytes: number;
  observedOutputBytes: number;
  modelWindowArmed: boolean;
}
export interface DiagnosticChildSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prepareTimeoutMs?: number;
  rawProtocolLimitBytes?: number;
}
export type DiagnosticSupervisorCommand =
  | { protocolVersion: 1; type: 'init'; spec: DiagnosticChildSpec }
  | { protocolVersion: 1; type: 'write'; id: number; text: string }
  | { protocolVersion: 1; type: 'end_input'; id: number }
  | { protocolVersion: 1; type: 'arm_model'; id: number; deadline: number }
  | { protocolVersion: 1; type: 'observe_output'; id: number; bytes: number }
  | { protocolVersion: 1; type: 'stop'; reason?: 'cancelled' | 'adapter_error' };
export type DiagnosticSupervisorEvent =
  | { protocolVersion: 1; type: 'ready'; identity: DiagnosticProcessIdentity }
  | { protocolVersion: 1; type: 'stdout' | 'stderr'; text: string }
  | { protocolVersion: 1; type: 'ack'; id: number; ok: boolean; code?: string }
  | { protocolVersion: 1; type: 'result'; result: DiagnosticProcessResult };
export class DiagnosticProcessError extends Error {
  constructor(readonly code: string, readonly processExitConfirmed?: boolean) { super(`agent_diagnostic_process:${code}`); this.name = 'DiagnosticProcessError'; }
}
export function boundedDiagnosticPreparation(value?: number): number {
  if (value === undefined) return DIAGNOSTIC_PREPARE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 10 || value > 60_000) throw new DiagnosticProcessError('invalid_prepare_timeout');
  return value;
}
export function boundedDiagnosticProtocol(value?: number): number {
  if (value === undefined) return DIAGNOSTIC_RAW_PROTOCOL_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1024 || value > DIAGNOSTIC_RAW_PROTOCOL_LIMIT) throw new DiagnosticProcessError('invalid_protocol_limit');
  return value;
}
/** Read only; this never signals a PID discovered after a restart. */
export function readDiagnosticProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform === 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      execFile('/bin/ps',['-p',String(pid),'-o','lstart='],{
        encoding:'utf8',timeout:1000,maxBuffer:1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',LANG:'C'},
      },(error,stdout) => resolve(error ? null : stdout.trim().replace(/\s+/gu,' ') || null));
    } catch { resolve(null); }
  });
}

export interface DiagnosticProcessExitAssessment {
  status: 'exited' | 'running' | 'unknown';
  reason: 'recorded_processes_absent' | 'recorded_processes_replaced' | 'recorded_process_alive'
    | 'process_group_present' | 'identity_unverifiable';
}
/** Copies only the persistable identity fields; never serializes an arbitrary session/env object. */
export function normalizeDiagnosticProcessIdentity(value: DiagnosticProcessIdentity): DiagnosticProcessIdentity {
  const pid = (input: unknown) => Number.isSafeInteger(input) && Number(input)>0 && Number(input)<=2_147_483_647;
  const start = (input: unknown) => input===null || input===undefined
    || (typeof input==='string' && input.length>0 && input.length<=256 && !/[\r\n\0]/.test(input));
  if (!value || value.protocolVersion!==1 || !pid(value.pid) || value.processGroupId!==value.pid
    || !pid(value.supervisorPid) || value.supervisorPid===value.pid
    || !Number.isFinite(Date.parse(value.startedAt)) || !start(value.osStartIdentity) || !start(value.supervisorStartIdentity)
    || typeof value.executableRealpath!=='string' || !path.isAbsolute(value.executableRealpath)
    || typeof value.cwd!=='string' || !path.isAbsolute(value.cwd) || !/^[a-f0-9]{64}$/.test(value.argumentsHash)) {
    throw new DiagnosticProcessError('process_identity_invalid');
  }
  return {protocolVersion:1,pid:value.pid,processGroupId:value.processGroupId,supervisorPid:value.supervisorPid,
    startedAt:new Date(value.startedAt).toISOString(),osStartIdentity:value.osStartIdentity ?? null,
    supervisorStartIdentity:value.supervisorStartIdentity ?? null,executableRealpath:value.executableRealpath,
    argumentsHash:value.argumentsHash,cwd:value.cwd};
}
/** Read-only restart evidence. Reused PIDs are never signalled, and an occupied group is never declared exited. */
export function inspectDiagnosticProcessExit(input: DiagnosticProcessIdentity): DiagnosticProcessExitAssessment {
  try {
    const identity=normalizeDiagnosticProcessIdentity(input);
    if (process.platform==='win32') return {status:'unknown',reason:'identity_unverifiable'};
    const presence=(pid:number):'present'|'absent'|'unknown'=>{
      try {process.kill(pid,0);return 'present';}
      catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'?'absent':'unknown';}
    };
    const inspect=(pid:number,expected:string|null|undefined):'alive'|'absent'|'replaced'|'unknown'=>{
      const state=presence(pid);
      if(state==='absent')return 'absent';
      if(state==='unknown'||!expected)return 'unknown';
      try {
        const current=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{
          encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:1000,maxBuffer:1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',LANG:'C'},
        }).trim().replace(/\s+/gu,' ');
        return current ? current===expected?'alive':'replaced' : presence(pid)==='absent'?'absent':'unknown';
      } catch {return presence(pid)==='absent'?'absent':'unknown';}
    };
    const child=inspect(identity.pid,identity.osStartIdentity);
    const supervisor=inspect(identity.supervisorPid,identity.supervisorStartIdentity);
    const group=presence(-identity.processGroupId);
    if(child==='alive'||supervisor==='alive')return {status:'running',reason:'recorded_process_alive'};
    if(group==='present')return {status:'running',reason:'process_group_present'};
    if(child==='unknown'||supervisor==='unknown'||group==='unknown')return {status:'unknown',reason:'identity_unverifiable'};
    return {status:'exited',reason:child==='replaced'||supervisor==='replaced'?'recorded_processes_replaced':'recorded_processes_absent'};
  } catch {return {status:'unknown',reason:'identity_unverifiable'};}
}

/**
 * Dedicated supervisor entry. The build wrapper must call this before importing
 * app/config/daemon code. Its only child is registered here; IPC loss stops that
 * owned process group even if the Electron controller has already disappeared.
 */
export async function runDiagnosticSupervisor(): Promise<void> {
  if (typeof process.send !== 'function' || !process.connected || process.platform === 'win32') {
    throw new DiagnosticProcessError('supervisor_ipc_required');
  }
  const registry = new CliProcessRegistry();
  let child: ChildProcessWithoutNullStreams | undefined;
  let identity: DiagnosticProcessIdentity | undefined;
  let reason: DiagnosticProcessReason | undefined;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let childClosed = false, initialized = false, finished = false;
  let stdoutBytes = 0, stderrBytes = 0, observedBytes = 0, inputBytes = 0;
  let protocolLimit = DIAGNOSTIC_RAW_PROTOCOL_LIMIT;
  let modelDeadline: number | null = null;
  let prepareTimer: NodeJS.Timeout | undefined, modelTimer: NodeJS.Timeout | undefined;
  let cleanup: Promise<void> | undefined, unregister: Promise<void> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
  const send = (event: DiagnosticSupervisorEvent): void => {
    if (!process.connected) { stop('controller_disconnected'); return; }
    try { process.send!(event, error => { if (error) stop('controller_disconnected'); }); }
    catch { stop('controller_disconnected'); }
  };
  const ack = (id: number, ok: boolean, code?: string) => send({protocolVersion:1,type:'ack',id,ok,...(code?{code}:{})});
  const finish = (): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      if (prepareTimer) clearTimeout(prepareTimer);
      if (modelTimer) clearTimeout(modelTimer);
      clearTimeout(initTimer);
      let cleanupFailed = false;
      if (child) {
        let shutdownFailed = false;
        try {
          if (!childClosed) await registry.shutdown(300);
        } catch { shutdownFailed = true; }
        // close starts unregister before shutdown resumes. shutdown can see a
        // still-present group while that cleanup is awaiting descendant exit.
        // Always join it, even when shutdown's earlier observation failed; only
        // its settled outcome and the final group check are exit evidence.
        try {
          if (unregister) await unregister;
          else if (childClosed) await registry.unregister(child,300);
          else cleanupFailed = shutdownFailed;
        } catch { cleanupFailed = true; }
      }
      const groupExited = !child || (childClosed && (!child.pid || !isProcessGroupAlive(child.pid)));
      if (!groupExited || cleanupFailed) reason = 'cleanup_failed';
      finished = true;
      process.removeListener('message',onMessage);
      process.removeListener('disconnect',onDisconnect);
      process.removeListener('SIGTERM',onTerm);
      process.removeListener('SIGINT',onTerm);
      const result: DiagnosticProcessResult = {
        reason:reason ?? 'exited',exitCode,signal:exitSignal,processGroupExited:groupExited,
        supervisorExited:false,rawStdoutBytes:stdoutBytes,rawStderrBytes:stderrBytes,
        observedOutputBytes:observedBytes,modelWindowArmed:modelDeadline!==null,
      };
      // No raw protocol, argv, environment or error cause is included in results.
      if (process.connected) {
        await new Promise<void>(resolve => {
          try { process.send!({protocolVersion:1,type:'result',result},()=>resolve()); }
          catch { resolve(); }
        });
        if (process.connected) process.disconnect?.();
      }
      resolveDone();
    })();
    return cleanup;
  };
  const stop = (next: DiagnosticProcessReason): void => {
    if (finished) return;
    reason ??= next;
    void finish();
  };
  const consume = (stream: 'stdout'|'stderr', chunk: Buffer): void => {
    if (stream==='stdout') stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    if (stdoutBytes+stderrBytes > protocolLimit) { stop('protocol_limit'); return; }
    if (reason || finished) return;
    const text = (stream==='stdout'?stdoutDecoder:stderrDecoder).write(chunk);
    if (text) send({protocolVersion:1,type:stream,text});
  };
  const initialize = (spec: DiagnosticChildSpec): void => {
    if (initialized || reason || finished) { stop('invalid_spec'); return; }
    initialized = true;
    clearTimeout(initTimer);
    let executableRealpath: string, cwd: string, prepareTimeout: number;
    try {
      if (!spec || !path.isAbsolute(spec.executable) || !path.isAbsolute(spec.cwd)
        || !Array.isArray(spec.args) || spec.args.length>512 || spec.args.some(arg=>typeof arg!=='string' || arg.includes('\0'))
        || Buffer.byteLength(JSON.stringify(spec.args))>256*1024
        || !spec.env || typeof spec.env!=='object' || Array.isArray(spec.env)
        || Object.values(spec.env).some(value=>value!==undefined && typeof value!=='string')) throw new Error();
      executableRealpath=fs.realpathSync(spec.executable);cwd=fs.realpathSync(spec.cwd);
      if (!fs.statSync(executableRealpath).isFile() || !fs.statSync(cwd).isDirectory()) throw new Error();
      prepareTimeout=boundedDiagnosticPreparation(spec.prepareTimeoutMs);
      protocolLimit=boundedDiagnosticProtocol(spec.rawProtocolLimitBytes);
    } catch { stop('invalid_spec'); return; }
    const release = registry.beginAdmission();
    try {
      const env={...spec.env}; delete env.NODE_CHANNEL_FD; delete env.NODE_CHANNEL_SERIALIZATION_MODE;
      child=spawn(spec.executable,[...spec.args],{cwd:spec.cwd,env,shell:false,detached:true,stdio:['pipe','pipe','pipe']});
      registry.registerAdmitted(child);
    } catch { release();stop('spawn_failed');return; }
    release();
    const current=child;
    prepareTimer=setTimeout(()=>stop('prepare_timeout'),prepareTimeout);
    current.stdout.on('data',(chunk:Buffer)=>consume('stdout',chunk));
    current.stderr.on('data',(chunk:Buffer)=>consume('stderr',chunk));
    current.stdin.on('error',()=>stop('transport_failed'));
    current.once('error',()=>stop('spawn_failed'));
    current.once('exit',(code,signal)=>{exitCode=code;exitSignal=signal;});
    current.once('close',(code,signal)=>{
      childClosed=true;exitCode=code;exitSignal=signal;
      const out=stdoutDecoder.end(), err=stderrDecoder.end();
      if (!reason) { if(out)send({protocolVersion:1,type:'stdout',text:out});if(err)send({protocolVersion:1,type:'stderr',text:err}); }
      unregister=registry.unregister(current,300);
      // The cleanup owner observes this promise; avoid an unhandled rejection
      // while a concurrent shutdown is still waiting for the close event.
      void unregister.catch(()=>{});
      void finish();
    });
    current.once('spawn',()=>{
      if (!current.pid) {stop('spawn_failed');return;}
      const startedAt=new Date().toISOString();
      void Promise.all([readDiagnosticProcessStartIdentity(current.pid),readDiagnosticProcessStartIdentity(process.pid)]).then(([osStartIdentity,supervisorStartIdentity])=>{
        if (reason || finished || childClosed) return;
        identity={protocolVersion:1,pid:current.pid!,processGroupId:current.pid!,supervisorPid:process.pid,
          startedAt,osStartIdentity,supervisorStartIdentity,executableRealpath,cwd,
          argumentsHash:createHash('sha256').update(JSON.stringify([executableRealpath,...spec.args])).digest('hex')};
        send({protocolVersion:1,type:'ready',identity});
      });
    });
  };
  const onMessage = (raw: unknown): void => {
    if (!raw || typeof raw!=='object' || (raw as {protocolVersion?:unknown}).protocolVersion!==1) {stop('invalid_spec');return;}
    const message=raw as DiagnosticSupervisorCommand;
    if (message.type==='stop') {stop(message.reason==='adapter_error'?'adapter_error':'cancelled');return;}
    if (message.type==='init') {initialize(message.spec);return;}
    if (!('id' in message) || !Number.isSafeInteger(message.id) || message.id<1) {stop('invalid_spec');return;}
    if (!identity || !child || finished || reason) {ack(message.id,false,'session_not_ready');return;}
    const commandId=message.id;
    if (message.type==='write') {
      if (typeof message.text!=='string' || Buffer.byteLength(message.text)>DIAGNOSTIC_INPUT_CHUNK_LIMIT) {ack(message.id,false,'input_limit');stop('protocol_limit');return;}
      inputBytes+=Buffer.byteLength(message.text);
      if (inputBytes>DIAGNOSTIC_RAW_PROTOCOL_LIMIT || child.stdin.writableEnded || child.stdin.destroyed) {ack(message.id,false,'input_closed');stop('transport_failed');return;}
      child.stdin.write(message.text,'utf8',error=>{
        if(error){ack(message.id,false,'write_failed');stop('transport_failed');}else ack(message.id,true);
      });
    } else if (message.type==='end_input') {
      if (child.stdin.writableEnded) {ack(message.id,true);return;}
      child.stdin.end(()=>ack(message.id,true));
    } else if (message.type==='arm_model') {
      if (modelDeadline!==null) {ack(message.id,false,'model_window_already_armed');return;}
      const remaining=message.deadline-Date.now();
      if (!Number.isFinite(message.deadline) || remaining<=0 || remaining>DIAGNOSTIC_MODEL_WINDOW_MS) {ack(message.id,false,'invalid_model_deadline');return;}
      modelDeadline=message.deadline;
      if(prepareTimer)clearTimeout(prepareTimer);
      modelTimer=setTimeout(()=>stop('model_timeout'),remaining);
      ack(message.id,true);
    } else if (message.type==='observe_output') {
      if (!Number.isSafeInteger(message.bytes) || message.bytes<0 || modelDeadline===null) {ack(message.id,false,'invalid_output_observation');return;}
      observedBytes+=message.bytes;
      if(observedBytes>DIAGNOSTIC_OBSERVED_OUTPUT_LIMIT){ack(message.id,false,'output_limit');stop('output_limit');return;}
      ack(message.id,true);
    } else { ack(commandId,false,'invalid_command');stop('invalid_spec'); }
  };
  const onDisconnect=()=>stop('controller_disconnected');
  const onTerm=()=>stop('cancelled');
  const initTimer=setTimeout(()=>stop('prepare_timeout'),5_000);
  process.on('message',onMessage);
  process.once('disconnect',onDisconnect);
  process.once('SIGTERM',onTerm);
  process.once('SIGINT',onTerm);
  await done;
}
