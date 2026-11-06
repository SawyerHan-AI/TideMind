import { createDiagnosticFixture, MEM, HOOK, T0 } from '../fixtures/agent-diagnostic-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  captureDiagnosticBinding, diagnosticHash, isDiagnosticRequested, isDiagnosticMemoryEvidenceCurrent, assertDiagnosticBindingCurrent,
  readDiagnosticContext, assertDiagnosticBridge, type DiagnosticBinding,
} from '../../src/agent-diagnostic-contract'
import { AgentDiagnosticRunStore } from '../../client/electron/agent-integration/diagnostic-run-store'
import { getTideMindVersion } from '../../src/utils/app-version'
import type { DiagnosticProcessIdentity } from '../../src/agent-diagnostic-runner'

const roots: string[]=[]
const databases: Database.Database[]=[]
afterEach(()=>{vi.restoreAllMocks();for(const db of databases.splice(0)) if(db.open)db.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
function fixture(shared=false, timeZone='Asia/Shanghai') {
  const value=createDiagnosticFixture(shared,timeZone);roots.push(value.root);databases.push(value.db);return value
}

describe('diagnostic capability against the real control ledger',()=>{
  it('isolates each run and never persists its raw capability or account context',()=>{
    const f=fixture(), run=f.prepare(), ctx=f.context(run)
    expect(ctx.dataDir).toBe(run.dataDir);expect(ctx.databasePath).toBe(run.databasePath)
    expect(fs.statSync(run.dataDir).mode & 0o077).toBe(0)
    const raw=JSON.parse(run.environment.TIDEMIND_DIAGNOSTIC_CONTEXT)
    expect(JSON.stringify(f.db.prepare('SELECT * FROM agent_diagnostic_runs').all())).not.toContain(raw.capability)
    const privateDb=new Database(run.databasePath);databases.push(privateDb)
    expect(privateDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
    assertDiagnosticBridge(ctx,{agentId:f.canonical,activityGenerationToken:MEM,componentKey:'memory_tools',operation:'brain_recall',now:new Date(T0)})
    assertDiagnosticBridge(ctx,{agentId:f.canonical,activityGenerationToken:HOOK,componentKey:'lifecycle',operation:'session_start',now:new Date(T0)})
    expect(()=>assertDiagnosticBridge(ctx,{agentId:f.canonical,activityGenerationToken:MEM,componentKey:'lifecycle',now:new Date(T0)})).toThrow('caller_binding_mismatch')
    expect(()=>assertDiagnosticBridge({...ctx},{agentId:f.canonical,activityGenerationToken:MEM,componentKey:'memory_tools'})).toThrow('unbound_context')
  })
  it('fails closed for missing/malformed required credentials, fake control paths and an empty temporary ledger',()=>{
    const f=fixture(),run=f.prepare()
    expect(isDiagnosticRequested({})).toBe(false)
    expect(readDiagnosticContext({trustedControlDatabasePath:f.control,env:{}})).toBeNull()
    for(const env of [{TIDEMIND_DIAGNOSTIC_REQUIRED:'1'},{TIDEMIND_DIAGNOSTIC_REQUIRED:''},
      {TIDEMIND_DIAGNOSTIC_REQUIRED:'1',TIDEMIND_DIAGNOSTIC_CONTEXT:'malformed'},
      {TIDEMIND_DIAGNOSTIC_CONTEXT:run.environment.TIDEMIND_DIAGNOSTIC_CONTEXT}]) {
      expect(isDiagnosticRequested(env)).toBe(true)
      expect(()=>readDiagnosticContext({trustedControlDatabasePath:f.control,env,now:new Date(T0)})).toThrow()
    }
    const envelope=JSON.parse(run.environment.TIDEMIND_DIAGNOSTIC_CONTEXT)
    expect(()=>readDiagnosticContext({trustedControlDatabasePath:f.control,now:new Date(T0),env:{...run.environment,
      TIDEMIND_DIAGNOSTIC_CONTEXT:JSON.stringify({...envelope,controlDatabasePath:run.databasePath})}})).toThrow('control_path_mismatch')
    expect(()=>readDiagnosticContext({trustedControlDatabasePath:run.databasePath,now:new Date(T0),env:{...run.environment,
      TIDEMIND_DIAGNOSTIC_CONTEXT:JSON.stringify({...envelope,controlDatabasePath:run.databasePath})}})).toThrow('diagnostic_unavailable')
    expect(()=>readDiagnosticContext({trustedControlDatabasePath:f.control,now:new Date(T0),env:{...run.environment,
      TIDEMIND_DIAGNOSTIC_CONTEXT:JSON.stringify({...envelope,capability:'A'.repeat(43)})}})).toThrow('credential_mismatch')
  })
  it('refuses a future control schema before reading diagnostic records',()=>{
    const f=fixture(),run=f.prepare()
    f.db.prepare("UPDATE metadata SET value='999' WHERE key='schema_version'").run()
    expect(()=>f.context(run)).toThrow(/schema v999/)
  })
  it('rechecks intent, generation, and expiry on every call rather than trusting the context object',()=>{
    const f=fixture(),binding=f.binding(),run=f.prepare(),ctx=f.context(run)
    f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(`agent_connection_intent:${binding.domainKey}`,
      JSON.stringify({domainKey:binding.domainKey,revision:1,state:'paused',pausedMemberIds:f.ids,excludedMemberIds:[]}))
    expect(()=>f.context(run)).toThrow('intent_inactive')
    expect(()=>f.store.reserve(run.runId,'confirmed_subscription')).toThrow('intent_inactive')
    f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({domainKey:binding.domainKey,revision:2,state:'active',pausedMemberIds:[],excludedMemberIds:[]}),`agent_connection_intent:${binding.domainKey}`)
    expect(()=>assertDiagnosticBridge(ctx,{agentId:f.canonical,activityGenerationToken:MEM,componentKey:'memory_tools',now:new Date(T0)})).toThrow('binding_changed')
    f.db.prepare('DELETE FROM metadata WHERE key=?').run(`agent_connection_intent:${binding.domainKey}`)
    f.db.prepare("UPDATE managed_artifacts SET owned_fragment_hash='changed' WHERE id='artifact:memory_tools'").run()
    expect(()=>f.context(run)).toThrow('bridge_unavailable')
    f.db.prepare("UPDATE managed_artifacts SET owned_fragment_hash=observed_fragment_hash WHERE id='artifact:memory_tools'").run()
    f.setNow('2026-11-06T01:01:30.000Z')
    expect(()=>f.context(run)).toThrow('credential_inactive')
  })
  it('binds shared members to one stable configuration version and real consumers',()=>{
    const f=fixture(true),one=f.binding(),two=captureDiagnosticBinding(f.db,f.ids[1],{memory_tools:MEM,lifecycle:HOOK})
    expect(one.connectionKey).toBe(two.connectionKey);expect(one.configurationVersion).toBe(two.configurationVersion)
    f.db.prepare("UPDATE agent_installations SET last_detected_at=?,metadata_json=json_set(metadata_json,'$.scanTime',?)").run('later','later')
    expect(f.binding().configurationVersion).toBe(one.configurationVersion)
    f.db.prepare("UPDATE agent_installations SET detected_version='2.0.0' WHERE id=?").run(f.ids[1])
    expect(f.binding().configurationVersion).not.toBe(one.configurationVersion)
    f.db.prepare("UPDATE artifact_consumers SET state='removed' WHERE installation_id=?").run(f.ids[1])
    expect(()=>captureDiagnosticBinding(f.db,f.ids[1],{memory_tools:MEM,lifecycle:HOOK})).toThrow('bridge_unavailable')
  })
})

describe('diagnostic runtime binding and historical memory proof',()=>{
  it('freezes the explicit main runtime version and includes it in the configuration budget key',()=>{
    const f=fixture()
    expect(f.binding().runtimeVersion).toBe(getTideMindVersion())
    const one=captureDiagnosticBinding(f.db,f.ids[0],{memory_tools:MEM,lifecycle:HOOK},{runtimeVersion:'fixture-main-a'})
    const two=captureDiagnosticBinding(f.db,f.ids[0],{memory_tools:MEM,lifecycle:HOOK},{runtimeVersion:'fixture-main-b'})
    expect(one.configurationVersion).not.toBe(two.configurationVersion)
    expect(one.sourceIdentityHash).toBe(two.sourceIdentityHash)
    expect(one.installationSourceHash).toBe(two.installationSourceHash)
    // The main bundle and bin version are checked by their respective entry
    // points. Ledger validation reuses the frozen main version, not its own default.
    expect(()=>assertDiagnosticBindingCurrent(f.db,one)).not.toThrow()
    const run=f.store.prepare({binding:one,mode:'automatic'})
    expect(f.context(run).binding.runtimeVersion).toBe('fixture-main-a')
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,one,{runtimeVersion:'fixture-main-a'})).toBe(true)
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,one,{runtimeVersion:'fixture-main-b'})).toBe(false)
  })
  it('keeps successful memory during maintenance pause/revision changes, without authorizing a new diagnostic',()=>{
    const f=fixture(), binding=f.binding()
    f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(`agent_connection_intent:${binding.domainKey}`,
      JSON.stringify({domainKey:binding.domainKey,revision:1,state:'paused',pausedMemberIds:f.ids,excludedMemberIds:[]}))
    f.db.prepare("UPDATE agent_installations SET desired_state='disabled'").run()
    f.db.prepare("UPDATE installation_components SET desired_state='disabled'").run()
    f.db.prepare("UPDATE artifact_consumers SET desired_state='disabled'").run()
    const before=f.db.prepare('SELECT total_changes() n').get()
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(true)
    expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(()=>f.store.prepare({binding,mode:'automatic'})).toThrow('installation_unavailable')
    f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(
      JSON.stringify({domainKey:binding.domainKey,revision:9,state:'active',pausedMemberIds:[],excludedMemberIds:[]}),`agent_connection_intent:${binding.domainKey}`)
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(true)
  })
  it.each(['token','hash','artifact'] as const)('invalidates memory when its physical %s changes',change=>{
    const f=fixture(),binding=f.binding()
    if(change==='token') f.db.prepare(`UPDATE reconcile_runs SET prepared_plan_json=json_set(prepared_plan_json,
      '$.activityGenerationToken',?,'$.executionPlan.activityGenerationTokenHash',?) WHERE id='run:memory_tools'`)
      .run('replacement-memory-token',diagnosticHash(JSON.stringify('replacement-memory-token')))
    if(change==='hash') {
      const next=diagnosticHash('replacement-memory-content')
      f.db.prepare("UPDATE managed_artifacts SET owned_fragment_hash=?,observed_fragment_hash=?,desired_fragment_hash=? WHERE id='artifact:memory_tools'").run(next,next,next)
      f.db.prepare("UPDATE projection_mutations SET after_hash=? WHERE artifact_id='artifact:memory_tools'").run(next)
    }
    if(change==='artifact') {
      f.db.prepare(`INSERT INTO managed_artifacts(id,component_type,target_path,ownership_key,mutation_domain,projection_version,selector_schema_version,
        owned_fragment_hash,observed_fragment_hash,desired_fragment_hash,state,created_at,updated_at)
        SELECT 'replacement-memory',component_type,target_path||'.new',ownership_key,mutation_domain||'.new',projection_version,selector_schema_version,
        owned_fragment_hash,observed_fragment_hash,desired_fragment_hash,state,created_at,updated_at FROM managed_artifacts WHERE id='artifact:memory_tools'`).run()
      f.db.prepare("UPDATE installation_components SET artifact_id='replacement-memory' WHERE component_key='memory_tools'").run()
      f.db.prepare("UPDATE artifact_consumers SET artifact_id='replacement-memory' WHERE component_key='memory_tools'").run()
      f.db.prepare("UPDATE projection_mutations SET artifact_id='replacement-memory' WHERE component_key='memory_tools'").run()
    }
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(false)
  })
  it.each(['consent','removed','stopped','source','source_conflict','disconnect_intent','host_version'] as const)('does not preserve independent memory after %s',change=>{
    const f=fixture(),binding=f.binding()
    if(change==='consent')f.db.prepare("UPDATE agent_consents SET status='revoked'").run()
    if(change==='removed')f.db.prepare("UPDATE agent_installations SET desired_state='removed',tombstoned_at=?").run(T0)
    if(change==='stopped')f.db.prepare("UPDATE agent_installations SET bridge_state='stopped'").run()
    if(change==='source')f.db.prepare("UPDATE agent_installations SET metadata_json=json_set(metadata_json,'$.managementEligibility.reason','source_not_official')").run()
    if(change==='source_conflict')f.db.prepare("UPDATE agent_installations SET health_state='inaccessible',status_reason='conflict'").run()
    if(change==='host_version')f.db.prepare("UPDATE agent_installations SET detected_version='2.0.0'").run()
    if(change==='disconnect_intent')f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(`agent_connection_intent:${binding.domainKey}`,
      JSON.stringify({domainKey:binding.domainKey,revision:1,state:'disconnected',pausedMemberIds:[],excludedMemberIds:[]}))
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(false)
  })
  it('keeps shared physical memory after the original member exits and an unrelated Hook updates',()=>{
    const f=fixture(true),binding=f.binding()
    f.db.prepare("UPDATE agent_installations SET desired_state='removed',tombstoned_at=? WHERE id=?").run(T0,f.ids[0])
    f.db.prepare("UPDATE artifact_consumers SET state='removed',desired_state='removed' WHERE installation_id=?").run(f.ids[0])
    f.db.prepare("UPDATE agent_consents SET status='revoked' WHERE installation_id=?").run(f.ids[0])
    f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(`agent_connection_intent:${binding.domainKey}`,
      JSON.stringify({domainKey:binding.domainKey,revision:1,state:'active',pausedMemberIds:[],excludedMemberIds:[f.ids[0]]}))
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(true)
    const next=diagnosticHash('new-hook-content'),nextToken='new-hook-token'
    f.db.prepare("UPDATE managed_artifacts SET owned_fragment_hash=?,observed_fragment_hash=?,desired_fragment_hash=? WHERE id='artifact:lifecycle'").run(next,next,next)
    f.db.prepare("UPDATE projection_mutations SET after_hash=? WHERE component_key='lifecycle'").run(next)
    f.db.prepare(`UPDATE reconcile_runs SET prepared_plan_json=json_set(prepared_plan_json,
      '$.activityGenerationToken',?,'$.executionPlan.activityGenerationTokenHash',?) WHERE id='run:lifecycle'`).run(nextToken,diagnosticHash(JSON.stringify(nextToken)))
    const nextBinding=captureDiagnosticBinding(f.db,f.ids[1],{memory_tools:MEM,lifecycle:nextToken})
    expect(nextBinding.configurationVersion).not.toBe(binding.configurationVersion)
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(true)
    f.db.prepare("UPDATE agent_consents SET status='revoked' WHERE installation_id=?").run(f.ids[1])
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(false)
  })
  it('rejects a replaced shared binding generation and cannot use an empty temporary ledger as history',()=>{
    const f=fixture(true),binding=f.binding()
    f.db.prepare('UPDATE agent_identity_bindings SET generation=generation+1').run()
    expect(isDiagnosticMemoryEvidenceCurrent(f.db,binding)).toBe(false)
    const empty=new Database(':memory:');databases.push(empty)
    expect(isDiagnosticMemoryEvidenceCurrent(empty,binding)).toBe(false)
  })
})

describe('diagnostic model budget and cleanup controller ledger',()=>{
  it('allows a no-model prepared domain but requires confirmed subscription before reservation/submission',()=>{
    const f=fixture(),run=f.prepare()
    expect(f.store.get(run.runId)).toMatchObject({phase:'prepared',budgetReserved:false})
    expect(f.context(run).runId).toBe(run.runId)
    for(const billing of ['unknown','metered_api'] as const)expect(()=>f.store.reserve(run.runId,billing)).toThrow('subscription_required')
    expect(()=>f.store.markSubmitted(run.runId)).toThrow('reservation_required')
    f.store.releaseUnsubmitted(run.runId,'qualification_complete')
    expect(f.store.get(run.runId)).toMatchObject({phase:'released',budgetReserved:false})
    expect(()=>f.context(run)).toThrow('credential_inactive')
    expect(()=>f.prepare()).toThrow('diagnostic_active')
    f.store.confirmProcessesExited(run.runId);f.store.cleanup(run.runId)
    expect(f.prepare().runId).not.toBe(run.runId)
  })
  it('uses one transactional active slot across independent controller handles',async()=>{
    const f=fixture(),otherDb=new Database(f.control);databases.push(otherDb)
    const other=new AgentDiagnosticRunStore(otherDb,f.options)
    const attempts=await Promise.allSettled([
      Promise.resolve().then(()=>f.prepare()),
      Promise.resolve().then(()=>other.prepare({binding:f.binding(),mode:'manual'})),
    ])
    expect(attempts.filter(item=>item.status==='fulfilled')).toHaveLength(1)
    expect(f.db.prepare('SELECT COUNT(*) n FROM agent_diagnostic_runs WHERE active_slot=1').get()).toEqual({n:1})
  })
  it('releases an explicitly unsubmitted reservation, but never replays a submitted configuration automatically',()=>{
    const f=fixture(),first=f.prepare()
    f.store.reserve(first.runId,'confirmed_subscription');f.store.releaseUnsubmitted(first.runId,'qualification_failed')
    f.store.confirmProcessesExited(first.runId);f.store.cleanup(first.runId)
    const second=f.prepare();f.store.reserve(second.runId,'confirmed_subscription');f.store.markSubmitted(second.runId)
    expect(()=>f.store.markSubmitted(second.runId)).toThrow('submission_already_recorded')
    expect(()=>f.store.releaseUnsubmitted(second.runId)).toThrow('submission_not_releasable')
    expect(f.store.fail(second.runId,'disconnected')).toMatchObject({phase:'uncertain',budgetReserved:true})
    f.store.confirmProcessesExited(second.runId);f.store.cleanup(second.runId)
    const third=f.prepare()
    expect(()=>f.store.reserve(third.runId,'confirmed_subscription')).toThrow('configuration_already_submitted')
    expect(f.db.prepare('SELECT SUM(budget_reserved) n FROM agent_diagnostic_runs').get()).toEqual({n:1})
  })
  it('charges manual submissions too and applies the user timezone day boundary at submission',()=>{
    const f=fixture()
    f.setNow('2026-11-06T15:59:59.000Z')
    const first=f.prepare('manual');expect(f.store.reserve(first.runId,'confirmed_subscription').budgetDay).toBe('2026-11-06')
    f.setNow('2026-11-06T16:00:01.000Z')
    expect(f.store.markSubmitted(first.runId).budgetDay).toBe('2026-11-07');f.done(first.runId)
    for(let i=0;i<2;i++){const run=f.prepare('manual');f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId);f.done(run.runId)}
    const fourth=f.prepare('manual')
    expect(()=>f.store.reserve(fourth.runId,'confirmed_subscription')).toThrow('daily_budget_exhausted')
    f.store.releaseUnsubmitted(fourth.runId);f.store.confirmProcessesExited(fourth.runId);f.store.cleanup(fourth.runId)
    f.setNow('2026-11-07T16:00:00.000Z')
    const next=f.prepare('manual');expect(f.store.reserve(next.runId,'confirmed_subscription').budgetDay).toBe('2026-11-08')
  })
  it.each(['prepared','reserved','submitted'] as const)('recovers interrupted %s without guessing process exit',phase=>{
    const f=fixture(),run=f.prepare()
    if(phase!=='prepared')f.store.reserve(run.runId,'confirmed_subscription')
    if(phase==='submitted')f.store.markSubmitted(run.runId)
    const reopened=new AgentDiagnosticRunStore(f.db,f.options)
    expect(reopened.recoverInterruptedRuns()).toEqual([expect.objectContaining({
      phase:phase==='submitted'?'uncertain':'released',budgetReserved:phase==='submitted',processesExited:false,
      submittedAt:phase==='submitted'?T0:null,
    })])
    expect(()=>reopened.markSubmitted(run.runId)).toThrow('credential_inactive')
    expect(()=>reopened.cleanup(run.runId)).toThrow('process_exit_required')
    expect(fs.existsSync(run.dataDir)).toBe(true)
    expect(reopened.listPendingCleanup()).toHaveLength(1)
    if(phase==='submitted') expect(()=>f.prepare()).toThrow('diagnostic_active')
    else {
      const next=f.prepare()
      expect(f.store.reserve(next.runId,'confirmed_subscription')).toMatchObject({phase:'reserved',budgetReserved:true})
      expect(fs.existsSync(run.dataDir)).toBe(true)
      f.done(next.runId)
    }
    reopened.confirmProcessesExited(run.runId);reopened.cleanup(run.runId)
    expect(reopened.cleanup(run.runId)).toMatchObject({cleaned:true})
    expect(fs.existsSync(run.dataDir)).toBe(false)
    const next=f.prepare()
    if(phase==='submitted') expect(()=>f.store.reserve(next.runId,'confirmed_subscription')).toThrow('configuration_already_submitted')
    else expect(f.store.reserve(next.runId,'confirmed_subscription')).toMatchObject({phase:'reserved',budgetReserved:true})
  })
  it('can archive a controller-verified old receipt from uncertainty without re-opening its capability',()=>{
    const f=fixture(),run=f.prepare();f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId)
    f.store.fail(run.runId,'response_lost');f.store.confirmProcessesExited(run.runId)
    expect(f.store.recordControllerVerifiedSuccess(run.runId)).toMatchObject({phase:'succeeded',budgetReserved:true,processesExited:true})
    expect(()=>f.context(run)).toThrow('credential_inactive')
    expect(()=>f.store.markSubmitted(run.runId)).toThrow()
  })
  it('requires controller confirmation for success and protects cleanup from a substituted path',()=>{
    const f=fixture(),run=f.prepare()
    expect(()=>f.store.recordControllerVerifiedSuccess(run.runId)).toThrow('submitted_run_required')
    f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId)
    expect(f.store.recordControllerVerifiedSuccess(run.runId)).toMatchObject({phase:'succeeded'})
    expect(()=>f.context(run)).toThrow('credential_inactive')
    expect(()=>f.store.cleanup(run.runId)).toThrow('process_exit_required')
    f.store.confirmProcessesExited(run.runId)
    const saved=run.dataDir+'-saved',outside=path.join(f.root,'do-not-delete');fs.mkdirSync(outside)
    fs.renameSync(run.dataDir,saved);fs.symlinkSync(outside,run.dataDir)
    expect(()=>f.store.cleanup(run.runId)).toThrow('cleanup_scope_invalid');expect(fs.existsSync(outside)).toBe(true)
    fs.unlinkSync(run.dataDir);fs.renameSync(saved,run.dataDir)
    expect(f.store.cleanup(run.runId)).toMatchObject({cleaned:true})
  })
})


describe('persisted diagnostic process ownership and historical success',()=>{
  function recordedProcess() {
    const f=fixture()
    f.db.prepare('UPDATE agent_installations SET executable_path=? WHERE id=?').run(process.execPath,f.ids[0])
    const run=f.prepare()
    const identity:DiagnosticProcessIdentity={protocolVersion:1,pid:300001,processGroupId:300001,supervisorPid:300002,
      startedAt:T0,osStartIdentity:'fixture-old-child',supervisorStartIdentity:'fixture-old-supervisor',
      executableRealpath:fs.realpathSync(process.execPath),cwd:run.dataDir,argumentsHash:'a'.repeat(64)}
    return {f,run,identity}
  }
  function absentProcesses() {
    return vi.spyOn(process,'kill').mockImplementation((_pid,signal)=>{
      expect(signal).toBe(0)
      throw Object.assign(new Error('synthetic absent process'),{code:'ESRCH'})
    })
  }
  it('persists only immutable process identity and confirms restart cleanup only after absent-process evidence',()=>{
    const {f,run,identity}=recordedProcess()
    f.store.recordProcessIdentity(run.runId,{...identity,env:{PRIVATE_KEY:'DO_NOT_PERSIST'}} as DiagnosticProcessIdentity)
    expect(f.store.get(run.runId).processIdentity).toEqual(identity)
    expect(JSON.stringify(f.db.prepare('SELECT process_identity_json FROM agent_diagnostic_runs').all())).not.toContain('PRIVATE_KEY')
    expect(()=>f.store.recordProcessIdentity(run.runId,{...identity,pid:300003,processGroupId:300003})).toThrow('process_identity_changed')
    f.store.recoverInterruptedRuns()
    expect(()=>f.prepare()).toThrow('diagnostic_active')
    const probe=absentProcesses()
    expect(f.store.assessRestartCleanup(run.runId)).toMatchObject({status:'exited',canCleanup:true})
    f.store.confirmProcessesExited(run.runId)
    expect(f.store.cleanup(run.runId).cleaned).toBe(true)
    expect(probe.mock.calls.every(call=>call[1]===0)).toBe(true)
  })
  it('does not delete a directory with a present process group even if an old exit flag exists',()=>{
    const {f,run,identity}=recordedProcess()
    f.store.recordProcessIdentity(run.runId,{...identity,osStartIdentity:null,supervisorStartIdentity:null})
    f.store.cancel(run.runId)
    const probe=vi.spyOn(process,'kill').mockImplementation((_pid,signal)=>{expect(signal).toBe(0);return true})
    expect(f.store.assessRestartCleanup(run.runId)).toMatchObject({status:'running',canCleanup:false})
    expect(()=>f.store.confirmProcessesExited(run.runId)).toThrow('process_exit_unproved')
    f.db.prepare('UPDATE agent_diagnostic_runs SET processes_exited_at=?,active_slot=NULL WHERE id=?').run(T0,run.runId)
    expect(()=>f.store.cleanup(run.runId)).toThrow('process_exit_unproved')
    expect(fs.existsSync(run.dataDir)).toBe(true)
    expect(probe.mock.calls.every(call=>call[1]===0)).toBe(true)
  })
  it('retains unrecorded or uninspectable processes for review without sending termination signals',()=>{
    const f=fixture(),run=f.prepare();f.store.recoverInterruptedRuns()
    expect(f.store.assessRestartCleanup(run.runId)).toMatchObject({status:'unknown',canCleanup:false,reason:'process_identity_missing'})
    expect(fs.existsSync(run.dataDir)).toBe(true)
    const other=recordedProcess();other.f.store.recordProcessIdentity(other.run.runId,other.identity);other.f.store.cancel(other.run.runId)
    const probe=vi.spyOn(process,'kill').mockImplementation((_pid,signal)=>{expect(signal).toBe(0);throw Object.assign(new Error('synthetic access denied'),{code:'EPERM'})})
    expect(other.f.store.assessRestartCleanup(other.run.runId)).toMatchObject({status:'unknown',canCleanup:false})
    expect(()=>other.f.store.cleanup(other.run.runId)).toThrow('process_exit_unproved')
    expect(probe.mock.calls.every(call=>call[1]===0)).toBe(true)
  })
  it('releases a previously failed unsubmitted slot on restart without deleting its unknown process directory',()=>{
    const f=fixture(),run=f.prepare()
    f.store.fail(run.runId,'supervisor_failed')
    expect(()=>f.prepare()).toThrow('diagnostic_active')
    f.store.recoverInterruptedRuns()
    expect(f.store.assessRestartCleanup(run.runId)).toMatchObject({canCleanup:false,reason:'process_identity_missing'})
    expect(()=>f.store.cleanup(run.runId)).toThrow('process_exit_required')
    expect(f.prepare().runId).not.toBe(run.runId)
    expect(fs.existsSync(run.dataDir)).toBe(true)
  })
  it('does not kill a reused PID and can distinguish it from the exited recorded process',()=>{
    const {f,run,identity}=recordedProcess()
    f.store.recordProcessIdentity(run.runId,{...identity,pid:process.pid,processGroupId:process.pid,osStartIdentity:'not-the-current-process-start'})
    f.store.cancel(run.runId)
    const probe=vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
      expect(signal).toBe(0)
      if(pid===process.pid)return true
      throw Object.assign(new Error('synthetic absent process'),{code:'ESRCH'})
    })
    expect(f.store.assessRestartCleanup(run.runId)).toEqual({status:'exited',canCleanup:true,reason:'recorded_processes_replaced'})
    f.store.confirmProcessesExited(run.runId);expect(f.store.cleanup(run.runId).cleaned).toBe(true)
    expect(probe.mock.calls.every(call=>call[1]===0)).toBe(true)
  })
  it.each(['before_creation','future','invalid'] as const)('rejects %s receipt time without changing the ledger',kind=>{
    const f=fixture(),run=f.prepare();f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId)
    f.setNow(new Date(Date.parse(T0)+1000).toISOString())
    const timestamp=kind==='invalid'?'not-a-date':new Date(Date.parse(T0)+(kind==='before_creation'?-1:1001)).toISOString()
    expect(()=>f.store.recordControllerVerifiedSuccess(run.runId,timestamp)).toThrow('invalid_verified_time')
    expect(f.store.get(run.runId).phase).toBe('submitted')
  })
  it('uses the original receipt time when archiving an old uncertain success, without renewing 30-day evidence',()=>{
    const f=fixture(),binding=f.binding(),run=f.prepare();f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId)
    const completedAt=new Date(Date.parse(T0)+500).toISOString()
    f.setNow(new Date(Date.parse(T0)+1000).toISOString());f.store.fail(run.runId,'response_lost');f.store.confirmProcessesExited(run.runId)
    const recoveredAt=new Date(Date.parse(T0)+40*24*60*60_000).toISOString();f.setNow(recoveredAt)
    expect(f.store.bindingForRun(run.runId)).toEqual(binding)
    f.store.recordControllerVerifiedSuccess(run.runId,completedAt)
    expect(f.db.prepare('SELECT finished_at,updated_at FROM agent_diagnostic_runs WHERE id=?').get(run.runId))
      .toEqual({finished_at:completedAt,updated_at:recoveredAt})
    expect(f.store.getCurrentMemorySuccess(f.ids[0],binding.runtimeVersion)).toBeNull()
    expect(()=>f.context(run)).toThrow('credential_inactive')
  })
  it('keeps a cleaned successful memory proof for 30 days through pause, without restoring its capability',()=>{
    const f=fixture(),binding=f.binding(),run=f.prepare()
    f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId);f.store.recordControllerVerifiedSuccess(run.runId)
    f.store.confirmProcessesExited(run.runId);f.store.cleanup(run.runId)
    expect(f.store.getCurrentMemorySuccess(f.ids[0],binding.runtimeVersion)).toEqual({verifiedAt:T0,runId:run.runId})
    f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(`agent_connection_intent:${binding.domainKey}`,
      JSON.stringify({domainKey:binding.domainKey,revision:2,state:'paused',pausedMemberIds:f.ids,excludedMemberIds:[]}))
    f.db.prepare("UPDATE agent_installations SET desired_state='disabled'").run()
    expect(f.store.hasCurrentMemorySuccess(binding)).toBe(true)
    expect(()=>f.context(run)).toThrow('credential_inactive')
    expect(()=>f.store.receiptContext(run.runId)).toThrow('receipt_scope_unavailable')
    expect(f.store.getCurrentMemorySuccess(f.ids[0],'another-runtime')).toBeNull()
    f.setNow(new Date(Date.parse(T0)+30*24*60*60_000-1).toISOString())
    expect(f.store.hasCurrentMemorySuccess(binding)).toBe(true)
    f.setNow(new Date(Date.parse(T0)+30*24*60*60_000).toISOString())
    expect(f.store.hasCurrentMemorySuccess(binding)).toBe(false)
  })
  it('projects shared success only to a real remaining member, never merely the same family or a forged connection key',()=>{
    const f=fixture(true),binding=f.binding(),run=f.prepare()
    f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId);f.store.recordControllerVerifiedSuccess(run.runId)
    f.store.confirmProcessesExited(run.runId);f.store.cleanup(run.runId)
    f.db.prepare("UPDATE agent_installations SET desired_state='removed',tombstoned_at=? WHERE id=?").run(T0,f.ids[0])
    f.db.prepare("UPDATE artifact_consumers SET state='removed' WHERE installation_id=?").run(f.ids[0])
    expect(f.store.getCurrentMemorySuccess(f.ids[1],binding.runtimeVersion)).toEqual({verifiedAt:T0,runId:run.runId})
    expect(f.store.getCurrentMemorySuccess(f.ids[0],binding.runtimeVersion)).toBeNull()
    f.db.prepare("INSERT INTO agents(id,name,tool_type,archived,created) VALUES ('eb_outside','Synthetic outsider','codex',0,?)").run(T0)
    f.db.prepare(`INSERT INTO agent_installations(id,family,host_variant,install_key,display_name,agent_id,desired_state,created_at,updated_at)
      VALUES ('outside','codex','codex-cli','outside-key','Synthetic outsider','eb_outside','managed',?,?)`).run(T0,T0)
    f.db.prepare("UPDATE agent_diagnostic_runs SET connection_key='installation:outside' WHERE id=?").run(run.runId)
    expect(f.store.getCurrentMemorySuccess('outside',binding.runtimeVersion)).toBeNull()
  })
  it('returns a non-authorizing receipt scope after revocation and refuses paths escaping the private run directory',()=>{
    const f=fixture(),run=f.prepare(),binding=f.binding()
    f.store.reserve(run.runId,'confirmed_subscription');f.store.markSubmitted(run.runId);f.store.fail(run.runId,'response_lost')
    const scope=f.store.receiptContext(run.runId)
    expect(scope).toEqual({runId:run.runId,nonce:run.nonce,databasePath:run.databasePath,binding:{configurationVersion:binding.configurationVersion}})
    expect(()=>assertDiagnosticBridge(scope as never,{agentId:f.canonical,activityGenerationToken:MEM,componentKey:'memory_tools'})).toThrow('unbound_context')
    expect(f.store.getCurrentMemorySuccess(f.ids[0],binding.runtimeVersion)).toBeNull()
    fs.rmSync(path.dirname(run.databasePath),{recursive:true})
    fs.symlinkSync(path.dirname(f.control),path.dirname(run.databasePath))
    expect(()=>f.store.receiptContext(run.runId)).toThrow('receipt_scope_invalid')
  })
})
