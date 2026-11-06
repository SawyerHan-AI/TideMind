import type Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  AgentDiagnosticError, DIAGNOSTIC_OPERATIONS, assertDiagnosticBindingCurrent, diagnosticHash, isDiagnosticMemoryEvidenceCurrent,
  type AgentDiagnosticRunRow, type DiagnosticBilling, type DiagnosticBinding, type DiagnosticOperation,
} from '@server/agent-diagnostic-contract.js'
import { resolveInstallationAgentIdentity } from '@server/db/agent-identity-binding.js'
import type { DiagnosticReceiptContext } from '@server/agent-diagnostic-receipts.js'
import { normalizeDiagnosticProcessIdentity, inspectDiagnosticProcessExit, type DiagnosticProcessIdentity, type DiagnosticProcessExitAssessment } from '@server/agent-diagnostic-runner.js'

export interface PreparedDiagnosticRun {
  runId: string
  nonce: string
  dataDir: string
  databasePath: string
  expiresAt: string
  /** Returned only to the controller for its dedicated child. Never persisted or logged. */
  environment: { TIDEMIND_DIAGNOSTIC_REQUIRED: '1'; TIDEMIND_DIAGNOSTIC_CONTEXT: string }
}
export interface DiagnosticRunSummary {
  runId: string
  phase: AgentDiagnosticRunRow['phase']
  mode: AgentDiagnosticRunRow['mode']
  connectionKey: string
  configurationVersion: string
  budgetDay: string
  budgetReserved: boolean
  submittedAt: string | null
  expiresAt: string
  createdAt: string
  finishedAt: string | null
  cleanupDueAt: string
  dataDir: string
  processesExited: boolean
  cleaned: boolean
  outcomeCode: string | null
  processIdentity: DiagnosticProcessIdentity | null
}
export interface DiagnosticRestartCleanupAssessment {
  status: 'exited' | 'running' | 'unknown'
  canCleanup: boolean
  reason: DiagnosticProcessExitAssessment['reason'] | 'process_identity_missing' | 'process_identity_invalid'
    | 'controller_confirmed_exit' | 'cleanup_already_recorded' | 'capability_active'
}
const fail = (code: string): never => { throw new AgentDiagnosticError(code) }
function localDay(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type===type)!.value
  return `${value('year')}-${value('month')}-${value('day')}`
}
function outcomeCode(value: string): string {
  // Classification only: no model text, account identity, paths, or credentials.
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(value)) return fail('invalid_outcome_code')
  return value
}
function savedProcessIdentity(raw: string | null | undefined): DiagnosticProcessIdentity | null {
  if(!raw)return null
  try{return normalizeDiagnosticProcessIdentity(JSON.parse(raw) as DiagnosticProcessIdentity)}catch{return null}
}
function summary(row: AgentDiagnosticRunRow): DiagnosticRunSummary {
  return { runId:row.id,phase:row.phase,mode:row.mode,connectionKey:row.connection_key,
    configurationVersion:row.configuration_version,budgetDay:row.budget_day,budgetReserved:row.budget_reserved===1,
    submittedAt:row.submitted_at,expiresAt:row.expires_at,createdAt:row.created_at,finishedAt:row.finished_at,
    cleanupDueAt:new Date(Date.parse(row.created_at)+24*60*60_000).toISOString(),dataDir:row.data_dir,
    processesExited:row.processes_exited_at!==null,cleaned:row.cleaned_at!==null,outcomeCode:row.outcome_code,processIdentity:savedProcessIdentity(row.process_identity_json) }
}
/** A small controller ledger; no model invocation, host command, receipt interpretation, or process killing. */
export class AgentDiagnosticRunStore {
  private readonly root: string
  private readonly controlPath: string
  private readonly now: () => Date
  private readonly timeZone: string
  constructor(private readonly db: Database.Database, options: {
    controlDatabasePath: string
    diagnosticsRoot: string
    timeZone: string
    now?: () => Date
  }) {
    this.now=options.now ?? (()=>new Date())
    this.timeZone=options.timeZone
    localDay(this.now(),this.timeZone)
    if (!path.isAbsolute(options.controlDatabasePath) || !path.isAbsolute(options.diagnosticsRoot)) fail('invalid_store_path')
    this.controlPath=fs.realpathSync(options.controlDatabasePath)
    // The handle must be the real control file, never a separate in-memory ledger.
    const main=db.prepare('PRAGMA database_list').all() as Array<{name:string;file:string}>
    if (!main.find(item=>item.name==='main' && item.file && fs.realpathSync(item.file)===this.controlPath)) fail('control_path_mismatch')
    fs.mkdirSync(options.diagnosticsRoot,{recursive:true,mode:0o700})
    if (fs.lstatSync(options.diagnosticsRoot).isSymbolicLink()) fail('diagnostic_root_invalid')
    this.root=fs.realpathSync(options.diagnosticsRoot)
    const rootStat=fs.statSync(this.root)
    if (!rootStat.isDirectory() || (typeof process.getuid==='function' && rootStat.uid!==process.getuid()) || (rootStat.mode & 0o077)!==0) fail('diagnostic_root_not_private')
  }
  prepare(input: { binding: DiagnosticBinding; mode: 'automatic' | 'manual'; allowedOperations?: readonly DiagnosticOperation[] }): PreparedDiagnosticRun {
    if (!['automatic','manual'].includes(input.mode)) return fail('invalid_mode')
    const operations=[...new Set(input.allowedOperations ?? DIAGNOSTIC_OPERATIONS.filter(operation=>
      operation.startsWith('brain_') || input.binding.components.lifecycle!==undefined))]
    if (!operations.length || operations.some(operation=>!DIAGNOSTIC_OPERATIONS.includes(operation)
      || (!operation.startsWith('brain_') && !input.binding.components.lifecycle))) return fail('invalid_operations')
    const runId=`diag_${randomBytes(16).toString('hex')}`
    const nonce=randomBytes(24).toString('hex')
    const capability=randomBytes(32).toString('base64url')
    const createdAt=this.now(), at=createdAt.toISOString(), expiresAt=new Date(createdAt.getTime()+90_000).toISOString()
    const dataDir=path.join(this.root,runId), databasePath=path.join(dataDir,'graph','brain.sqlite')
    let directoryCreated=false
    try {
      this.db.transaction(()=>{
        assertDiagnosticBindingCurrent(this.db,input.binding)
        if (this.db.prepare('SELECT 1 FROM agent_diagnostic_runs WHERE active_slot=1').get()) fail('diagnostic_active')
        fs.mkdirSync(dataDir,{mode:0o700}); directoryCreated=true
        fs.mkdirSync(path.dirname(databasePath),{mode:0o700})
        fs.writeFileSync(path.join(dataDir,'.agent-diagnostic-run.json'),JSON.stringify({protocolVersion:1,runId,nonce}),{flag:'wx',mode:0o600})
        // Reuse the supplied control handle's native driver. A separate runtime
        // import here may resolve client/node_modules (Electron ABI) in a Node
        // controller/test process, instead of the already working server driver.
        const DatabaseConstructor=this.db.constructor as new (filename:string)=>Database.Database
        const privateDb=new DatabaseConstructor(databasePath)
        try { privateDb.exec('PRAGMA user_version=0') } finally { privateDb.close() }
        fs.chmodSync(databasePath,0o600)
        this.db.prepare(`INSERT INTO agent_diagnostic_runs
          (id,connection_key,configuration_version,binding_json,nonce,capability_hash,expires_at,data_dir,allowed_operations_json,
           mode,time_zone,budget_day,phase,active_slot,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'prepared',1,?,?)`).run(
          runId,input.binding.connectionKey,input.binding.configurationVersion,JSON.stringify(input.binding),nonce,
          diagnosticHash(capability),expiresAt,dataDir,JSON.stringify(operations),input.mode,this.timeZone,localDay(createdAt,this.timeZone),at,at)
      }).immediate()
    } catch(error) {
      if (directoryCreated) fs.rmSync(dataDir,{recursive:true,force:true})
      if (error instanceof AgentDiagnosticError) throw error
      return fail('diagnostic_prepare_failed')
    }
    return {runId,nonce,dataDir,databasePath,expiresAt,environment:{
      TIDEMIND_DIAGNOSTIC_REQUIRED:'1',TIDEMIND_DIAGNOSTIC_CONTEXT:JSON.stringify({protocolVersion:1,
        controlDatabasePath:this.controlPath,runId,capability}),
    }}
  }
  /** Record the session identity immediately after runner.start, before model submission. */
  recordProcessIdentity(runId: string, input: DiagnosticProcessIdentity): DiagnosticRunSummary {
    let identity: DiagnosticProcessIdentity
    try {identity=normalizeDiagnosticProcessIdentity(input)}catch{return fail('process_identity_invalid')}
    return this.db.transaction(()=>{
      const row=this.requireRun(runId), encoded=JSON.stringify(identity)
      if(row.process_identity_json) {
        const previous=savedProcessIdentity(row.process_identity_json)
        if(!previous || JSON.stringify(previous)!==encoded)return fail('process_identity_changed')
        return summary(row)
      }
      this.assertLive(row,this.now())
      if(!['prepared','reserved'].includes(row.phase)||row.submitted_at)return fail('process_identity_too_late')
      const binding=JSON.parse(row.binding_json) as DiagnosticBinding
      try {
        const relative=path.relative(row.data_dir,identity.cwd)
        // Codex's fixed OS sandbox launcher is part of the native adapter's
        // exact command contract. The binding still names the native CLI; the
        // controller attests that target and sandbox argv before this call.
        const fixedSandbox=identity.executableRealpath==='/usr/bin/sandbox-exec'
        if((!fixedSandbox&&fs.realpathSync(binding.executablePath)!==identity.executableRealpath)
          || fs.realpathSync(identity.cwd)!==identity.cwd
          || relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return fail('process_scope_mismatch')
      } catch {return fail('process_scope_mismatch')}
      this.db.prepare('UPDATE agent_diagnostic_runs SET process_identity_json=?,updated_at=? WHERE id=?')
        .run(encoded,this.now().toISOString(),runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
  /** Frozen ledger scope for controller attestation/receipt review, never an execution capability. */
  bindingForRun(runId: string): DiagnosticBinding {
    const row=this.requireRun(runId)
    try {
      const value=JSON.parse(row.binding_json) as DiagnosticBinding
      const strings=['connectionKey','configurationVersion','runtimeVersion','installationSourceHash','domainKey','installationId',
        'installationAgentId','canonicalAgentId','installKey','hostVariant','hostVersion','executablePath','configRoot','distributionId','sourceIdentityHash'] as const
      const component=(item:unknown):boolean=>{
        if(!item||typeof item!=='object')return false
        const value=item as {artifactId?:unknown;ownedFragmentHash?:unknown;activityGenerationToken?:unknown}
        return [value.artifactId,value.ownedFragmentHash,value.activityGenerationToken].every(part=>typeof part==='string'&&part.length>0)
      }
      if(!value||typeof value!=='object'||strings.some(key=>typeof value[key]!=='string'||!value[key].length)
        ||!Number.isSafeInteger(value.intentRevision)||value.intentRevision<0
        ||!path.isAbsolute(value.executablePath)||!path.isAbsolute(value.configRoot)
        ||!(value.bindingId===null||(typeof value.bindingId==='string'&&value.bindingId.length>0))
        ||!(value.bindingGeneration===null||(Number.isSafeInteger(value.bindingGeneration)&&value.bindingGeneration>0))
        ||!component(value.components?.memory_tools)||(value.components?.lifecycle!==undefined&&!component(value.components.lifecycle))
        ||value.connectionKey!==row.connection_key||value.configurationVersion!==row.configuration_version)return fail('invalid_binding')
      return value
    } catch {return fail('invalid_binding')}
  }
  /** No credential is returned. This scope remains readable after cap revocation, until cleanup. */
  receiptContext(runId: string): DiagnosticReceiptContext {
    const row=this.requireRun(runId)
    if(row.cleaned_at || row.data_dir!==path.join(this.root,row.id))return fail('receipt_scope_unavailable')
    const databasePath=path.join(row.data_dir,'graph','brain.sqlite')
    try {
      if(fs.realpathSync(this.root)!==this.root||fs.realpathSync(row.data_dir)!==row.data_dir
        ||fs.realpathSync(databasePath)!==databasePath||!fs.lstatSync(databasePath).isFile())return fail('receipt_scope_invalid')
      const marker=JSON.parse(fs.readFileSync(path.join(row.data_dir,'.agent-diagnostic-run.json'),'utf8')) as {protocolVersion?:unknown;runId?:unknown;nonce?:unknown}
      if(marker.protocolVersion!==1||marker.runId!==row.id||marker.nonce!==row.nonce)return fail('receipt_scope_invalid')
    } catch {return fail('receipt_scope_invalid')}
    return {runId:row.id,nonce:row.nonce,databasePath,binding:{configurationVersion:row.configuration_version}}
  }
  /** Read-only success projection. Cleanup does not erase the controller's durable proof. */
  getCurrentMemorySuccess(installationId: string, runtimeVersion: string): {verifiedAt:string;runId:string}|null {
    try {
      return this.db.transaction(()=>{
        const installation=this.db.prepare('SELECT desired_state,tombstoned_at FROM agent_installations WHERE id=?').get(installationId) as
          {desired_state:string;tombstoned_at:string|null}|undefined
        if(!installation||!['managed','disabled'].includes(installation.desired_state)||installation.tombstoned_at)return null
        const identity=resolveInstallationAgentIdentity(this.db,installationId)
        const connectionKey=identity.bindingId?`binding:${identity.bindingId}`:`installation:${installationId}`
        const now=this.now(),lower=new Date(now.getTime()-30*24*60*60_000).toISOString(),upper=now.toISOString()
        const rows=this.db.prepare(`SELECT * FROM agent_diagnostic_runs WHERE connection_key=? AND phase='succeeded'
          AND outcome_code='controller_verified' AND submitted_at IS NOT NULL AND budget_reserved=1
          AND finished_at>? AND finished_at<=? ORDER BY finished_at DESC,id DESC`).all(connectionKey,lower,upper) as AgentDiagnosticRunRow[]
        for(const row of rows) {
          let binding:DiagnosticBinding
          try{binding=JSON.parse(row.binding_json) as DiagnosticBinding}catch{continue}
          if(binding.connectionKey!==connectionKey||binding.bindingId!==identity.bindingId||binding.bindingGeneration!==identity.bindingGeneration
            ||binding.canonicalAgentId!==identity.canonicalAgentId
            ||(!identity.bindingId&&binding.installationId!==installationId))continue
          if(!Number.isFinite(Date.parse(row.finished_at!))||!isDiagnosticMemoryEvidenceCurrent(this.db,binding,{runtimeVersion}))continue
          return {verifiedAt:row.finished_at!,runId:row.id}
        }
        return null
      })()
    } catch {return null}
  }
  hasCurrentMemorySuccess(binding: DiagnosticBinding, runtimeVersion=binding.runtimeVersion): boolean {
    return isDiagnosticMemoryEvidenceCurrent(this.db,binding,{runtimeVersion})
      && this.getCurrentMemorySuccess(binding.installationId,runtimeVersion)!==null
  }
  /** Read-only: no process signal other than existence probes, no inferred kill or directory deletion. */
  assessRestartCleanup(runId: string): DiagnosticRestartCleanupAssessment {
    const row=this.requireRun(runId)
    if(row.cleaned_at)return {status:'exited',canCleanup:true,reason:'cleanup_already_recorded'}
    if(!row.capability_revoked_at)return {status:'unknown',canCleanup:false,reason:'capability_active'}
    if(!row.process_identity_json)return row.processes_exited_at
      ?{status:'exited',canCleanup:true,reason:'controller_confirmed_exit'}
      :{status:'unknown',canCleanup:false,reason:'process_identity_missing'}
    const identity=savedProcessIdentity(row.process_identity_json)
    if(!identity)return {status:'unknown',canCleanup:false,reason:'process_identity_invalid'}
    const assessment=inspectDiagnosticProcessExit(identity)
    return {...assessment,canCleanup:assessment.status==='exited'}
  }

  /** Immediately before the first provider request; no API/unknown billing may reserve. */
  reserve(runId: string, billing: DiagnosticBilling): DiagnosticRunSummary {
    if (billing!=='confirmed_subscription') return fail('subscription_required')
    return this.db.transaction(()=>{
      const row=this.requireRun(runId), now=this.now(), at=now.toISOString()
      this.assertLive(row,now)
      if (row.phase==='reserved') return summary(row)
      if (row.phase!=='prepared') return fail('invalid_reservation_phase')
      const day=localDay(now,row.time_zone)
      this.assertBudget(row,day)
      this.db.prepare(`UPDATE agent_diagnostic_runs SET phase='reserved',billing='confirmed_subscription',
        budget_reserved=1,budget_day=?,expires_at=?,updated_at=? WHERE id=?`).run(day,new Date(now.getTime()+90_000).toISOString(),at,runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
  /** Persist this BEFORE crossing the provider submission boundary. Unknown submission is spent. */
  markSubmitted(runId: string): DiagnosticRunSummary {
    return this.db.transaction(()=>{
      const row=this.requireRun(runId), now=this.now(), at=now.toISOString()
      this.assertLive(row,now)
      if (row.submitted_at) return fail('submission_already_recorded')
      if (row.phase!=='reserved' || row.billing!=='confirmed_subscription' || row.budget_reserved!==1) return fail('reservation_required')
      const day=localDay(now,row.time_zone)
      // Reservation crossing local midnight must charge the actual submission day.
      this.assertBudget(row,day)
      this.db.prepare("UPDATE agent_diagnostic_runs SET phase='submitted',submitted_at=?,budget_day=?,updated_at=? WHERE id=?").run(at,day,at,runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
  releaseUnsubmitted(runId: string, code='not_submitted'): DiagnosticRunSummary {
    outcomeCode(code)
    return this.db.transaction(()=>{
      const row=this.requireRun(runId), at=this.now().toISOString()
      if (row.phase==='released') return summary(row)
      if (!['prepared','reserved'].includes(row.phase) || row.submitted_at) return fail('submission_not_releasable')
      this.db.prepare(`UPDATE agent_diagnostic_runs SET phase='released',budget_reserved=0,
        capability_revoked_at=COALESCE(capability_revoked_at,?),finished_at=?,outcome_code=?,updated_at=? WHERE id=?`).run(at,at,code,at,runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
  cancel(runId: string, code='cancelled'): DiagnosticRunSummary { return this.endFailed(runId,'cancelled',code) }
  fail(runId: string, code='execution_failed'): DiagnosticRunSummary { return this.endFailed(runId,'failed',code) }
  /** Controller calls only after verifying completion + nonce/ID readback, source, and intent. */
  recordControllerVerifiedSuccess(runId: string, verifiedAt?: string): DiagnosticRunSummary {
    return this.db.transaction(()=>{
      const row=this.requireRun(runId), at=this.now().toISOString()
      const verifiedMs=verifiedAt===undefined?Date.parse(at):Date.parse(verifiedAt)
      if(!Number.isFinite(verifiedMs)||verifiedMs<Date.parse(row.created_at)||verifiedMs>Date.parse(at))return fail('invalid_verified_time')
      const completedAt=new Date(verifiedMs).toISOString()
      if (row.phase==='succeeded') return summary(row)
      if (!['submitted','uncertain'].includes(row.phase) || !row.submitted_at || row.budget_reserved!==1 || row.cleaned_at) return fail('submitted_run_required')
      assertDiagnosticBindingCurrent(this.db,this.bindingForRun(row.id))
      this.db.prepare(`UPDATE agent_diagnostic_runs SET phase='succeeded',capability_revoked_at=COALESCE(capability_revoked_at,?),finished_at=?,
        outcome_code='controller_verified',updated_at=? WHERE id=?`).run(at,completedAt,at,runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
  /** Explicit controller-startup action, before preparing new runs. Never kills an unknown PID. */
  recoverInterruptedRuns(): readonly DiagnosticRunSummary[] {
    return this.db.transaction(()=>{
      const rows=this.db.prepare("SELECT * FROM agent_diagnostic_runs WHERE active_slot=1 AND phase IN ('prepared','reserved','submitted')").all() as AgentDiagnosticRunRow[]
      const at=this.now().toISOString()
      // The controller must durably markSubmitted before sending a turn.
      // A prepared/reserved run therefore proves no model submission occurred.
      // Keep the slot while an identified process may still be alive.
      for (const row of rows) this.db.prepare(`UPDATE agent_diagnostic_runs SET phase=?,budget_reserved=?,
        capability_revoked_at=COALESCE(capability_revoked_at,?),finished_at=?,outcome_code=?,updated_at=? WHERE id=?`).run(
        row.phase==='submitted'?'uncertain':'released',row.phase==='submitted'?1:0,at,at,
        row.phase==='submitted'?'controller_interrupted':'controller_interrupted_before_submission',at,row.id)
      // Before onProcess, a crash can leave no identity to ever observe. A
      // revoked, unsubmitted run cannot send a turn. Release its logical slot
      // while retaining the directory until its process exit can be proved.
      this.db.prepare(`UPDATE agent_diagnostic_runs SET active_slot=NULL,updated_at=?
        WHERE active_slot=1 AND submitted_at IS NULL AND capability_revoked_at IS NOT NULL
        AND process_identity_json IS NULL AND phase IN ('released','cancelled','failed')`).run(at)
      return rows.map(row=>summary(this.requireRun(row.id)))
    }).immediate()
  }
  listPendingCleanup(): readonly DiagnosticRunSummary[] {
    return (this.db.prepare('SELECT * FROM agent_diagnostic_runs WHERE cleaned_at IS NULL ORDER BY created_at,id').all() as AgentDiagnosticRunRow[]).map(summary)
  }
  /** Controller must have observed its entire dedicated process/worker tree exit. */
  confirmProcessesExited(runId: string): DiagnosticRunSummary {
    const before=this.requireRun(runId)
    if(before.process_identity_json && !this.assessRestartCleanup(runId).canCleanup)return fail('process_exit_unproved')
    return this.db.transaction(()=>{
      const row=this.requireRun(runId), at=this.now().toISOString()
      if (!row.capability_revoked_at) return fail('revoke_before_process_exit')
      this.db.prepare(`UPDATE agent_diagnostic_runs SET processes_exited_at=COALESCE(processes_exited_at,?),active_slot=NULL,updated_at=? WHERE id=?`).run(at,at,runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
  cleanup(runId: string): DiagnosticRunSummary {
    const before=this.requireRun(runId)
    if(!before.cleaned_at && before.process_identity_json && !this.assessRestartCleanup(runId).canCleanup)return fail('process_exit_unproved')
    return this.db.transaction(()=>{
      const row=this.requireRun(runId)
      if (row.cleaned_at) return summary(row)
      if (!row.capability_revoked_at || !row.processes_exited_at || row.active_slot!==null) return fail('process_exit_required')
      if (!/^diag_[a-f0-9]{32}$/.test(row.id) || row.data_dir!==path.join(this.root,row.id)
        || fs.realpathSync(this.root)!==this.root) return fail('cleanup_scope_invalid')
      if (fs.existsSync(row.data_dir)) {
        const stat=fs.lstatSync(row.data_dir)
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(row.data_dir)!==row.data_dir) return fail('cleanup_scope_invalid')
        let marker: {runId?:unknown;nonce?:unknown}
        try { marker=JSON.parse(fs.readFileSync(path.join(row.data_dir,'.agent-diagnostic-run.json'),'utf8')) }
        catch { return fail('cleanup_marker_invalid') }
        if (marker.runId!==row.id || marker.nonce!==row.nonce) return fail('cleanup_marker_invalid')
        fs.rmSync(row.data_dir,{recursive:true})
      }
      const at=this.now().toISOString()
      this.db.prepare('UPDATE agent_diagnostic_runs SET cleaned_at=?,updated_at=? WHERE id=?').run(at,at,runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
  get(runId: string): DiagnosticRunSummary { return summary(this.requireRun(runId)) }
  private requireRun(runId: string): AgentDiagnosticRunRow {
    if (!/^diag_[a-f0-9]{32}$/.test(runId)) return fail('run_missing')
    const row=this.db.prepare('SELECT * FROM agent_diagnostic_runs WHERE id=?').get(runId) as AgentDiagnosticRunRow | undefined
    return row ?? fail('run_missing')
  }
  private assertLive(row: AgentDiagnosticRunRow, now: Date): void {
    if (row.capability_revoked_at || row.active_slot!==1 || row.processes_exited_at || !(Date.parse(row.expires_at)>now.getTime())) fail('credential_inactive')
    assertDiagnosticBindingCurrent(this.db,this.bindingForRun(row.id))
  }
  private assertBudget(row: AgentDiagnosticRunRow, day: string): void {
    const count=this.db.prepare('SELECT COUNT(*) n FROM agent_diagnostic_runs WHERE budget_reserved=1 AND budget_day=? AND id!=?').get(day,row.id) as {n:number}
    if (count.n>=3) fail('daily_budget_exhausted')
    if (row.mode==='automatic' && this.db.prepare(`SELECT 1 FROM agent_diagnostic_runs WHERE mode='automatic'
      AND connection_key=? AND configuration_version=? AND budget_reserved=1 AND id!=?`).get(row.connection_key,row.configuration_version,row.id)) fail('configuration_already_submitted')
  }
  private endFailed(runId: string, phase: 'failed' | 'cancelled', code: string): DiagnosticRunSummary {
    outcomeCode(code)
    return this.db.transaction(()=>{
      const row=this.requireRun(runId), at=this.now().toISOString()
      if (['succeeded','failed','cancelled','released','uncertain'].includes(row.phase)) return summary(row)
      const submitted=row.submitted_at!==null
      this.db.prepare(`UPDATE agent_diagnostic_runs SET phase=?,budget_reserved=?,
        capability_revoked_at=COALESCE(capability_revoked_at,?),finished_at=?,outcome_code=?,updated_at=? WHERE id=?`).run(
        submitted?'uncertain':phase,submitted?1:0,at,at,code,at,runId)
      return summary(this.requireRun(runId))
    }).immediate()
  }
}
