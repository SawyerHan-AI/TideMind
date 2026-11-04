import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { AgentIntegrationRepository } from '../client/electron/agent-integration/repository'
import { ensureSchema } from '../src/db/schema.js'
import { agentIdentityDomainKey } from '../src/db/agent-identity-binding.js'
import { evaluateBridgeAdmission } from '../src/agent-bridge-guard.js'
import { recordHostActivityEvidence } from '../src/db/agent-host-activity.js'
import { touchAgent } from '../src/db/agents.js'
import { seedLifecycle } from './fixtures/seed-managed-lifecycle'

describe('shared identity runtime carrier',()=>{
 let db:Database.Database
 beforeEach(()=>{
  db=new Database(':memory:');ensureSchema(db)
  seedLifecycle(db,'cli','codex','codex-cli');seedLifecycle(db,'desktop','codex','codex-desktop')
  db.exec("UPDATE agent_installations SET config_root='/fixture/.codex'")
  const row=db.prepare("SELECT * FROM agent_installations WHERE agent_id='cli'").get() as Parameters<typeof agentIdentityDomainKey>[0]
  db.prepare(`INSERT INTO agent_identity_bindings(id,domain_key,canonical_agent_id,generation,evidence_hash,created_at,updated_at)
    VALUES ('binding',?,'cli',1,?,'now','now')`).run(agentIdentityDomainKey(row),'a'.repeat(64))
  db.exec(`INSERT INTO agent_identity_binding_members VALUES ('installation_cli','binding'),('installation_desktop','binding');
    DELETE FROM artifact_consumers WHERE installation_id='installation_desktop';
    UPDATE installation_components SET artifact_id='artifact_cli' WHERE installation_id='installation_desktop';
    INSERT INTO artifact_consumers(artifact_id,installation_id,component_key,required_capability,desired_state,discover_reachability,state,consent_envelope_id,added_at,updated_at)
      VALUES ('artifact_cli','installation_desktop','lifecycle',4,'managed','dedicated','active','consent_desktop','now','now');
    INSERT INTO projection_mutations(id,run_id,operation_id,installation_id,component_key,artifact_id,mutation_domain,target,after_hash,idempotency_strategy,readback_strategy,state,committed_at,created_at,updated_at)
      VALUES ('mutation','run_cli','op','installation_cli','lifecycle','artifact_cli','domain','/fixture/cli','owned','test','test','committed','2026-01-01','now','now');`)
 })
 afterEach(()=>db.close())
 const request={agentId:'cli',activityGenerationToken:'generation_cli',componentKey:'lifecycle' as const}
 it('keeps the carrier alive after its original owner disconnects but stops after the last consumer',()=>{
  expect(evaluateBridgeAdmission(db,request)).toEqual({allowed:true})
  db.exec("UPDATE agent_installations SET desired_state='removed' WHERE agent_id='cli'; UPDATE artifact_consumers SET state='removed' WHERE installation_id='installation_cli'")
  db.exec("UPDATE agent_installations SET bridge_state='stopped',tombstoned_at='2026-01-03' WHERE agent_id='cli'; UPDATE agent_consents SET status='revoked' WHERE id='consent_cli'")
  const oldRun=db.prepare("SELECT * FROM reconcile_runs WHERE id='run_cli'").get() as Record<string, unknown>
  const disconnectRun={...oldRun,id:'run_disconnect',operation_type:'disconnect'}
  db.prepare(`INSERT INTO reconcile_runs (${Object.keys(disconnectRun).join(',')}) VALUES (${Object.keys(disconnectRun).map(()=>'?').join(',')})`).run(...Object.values(disconnectRun))
  // This fixture mirrors a detach-only journal; full coordinator E2E is separate.
  db.exec(`INSERT INTO projection_mutations(id,run_id,operation_id,installation_id,component_key,artifact_id,mutation_domain,target,after_hash,idempotency_strategy,readback_strategy,state,committed_at,created_at,updated_at)
    VALUES ('detach','run_disconnect','detach','installation_cli','lifecycle','artifact_cli','domain','/fixture/cli','owned','consumer_detach_only','test','committed','2026-01-03','now','now');`)
  expect(evaluateBridgeAdmission(db,request)).toEqual({allowed:true})
  touchAgent(db,'cli')
  expect(db.prepare("SELECT last_active FROM agents WHERE id='cli'").get()).not.toEqual({last_active:null})
  db.exec("UPDATE agent_installations SET desired_state='removed' WHERE agent_id='desktop'")
  expect(evaluateBridgeAdmission(db,request)).toEqual({allowed:false,reason:'installation_removed'})
 })
 it('uses latest physical generation rather than another consumers old run',()=>{
  db.exec(`INSERT INTO projection_mutations(id,run_id,operation_id,installation_id,component_key,artifact_id,mutation_domain,target,after_hash,idempotency_strategy,readback_strategy,state,committed_at,created_at,updated_at)
    VALUES ('mutation2','run_desktop','op2','installation_desktop','lifecycle','artifact_cli','domain','/fixture/cli','new','test','test','committed','2026-01-02','now','now');
    UPDATE managed_artifacts SET owned_fragment_hash='new' WHERE id='artifact_cli';`)
  expect(evaluateBridgeAdmission(db,request)).toEqual({allowed:false,reason:'activity_generation_mismatch'})
  expect(evaluateBridgeAdmission(db,{...request,activityGenerationToken:'generation_desktop'})).toEqual({allowed:true})
 })
 it('does not accept activity without a current consumer consent',()=>{
  db.exec("UPDATE agent_consents SET status='revoked'")
  expect(evaluateBridgeAdmission(db,request).allowed).toBe(false)
 })
 it.each(['superseded_by_confirmed_generation','superseded_by_disconnect'])(
  'keeps current authority checks after the physical carrier is retired by %s',reason=>{
   db.prepare("UPDATE reconcile_runs SET state='cancelled',failure_code=? WHERE id='run_cli'").run(reason)
   expect(evaluateBridgeAdmission(db,request)).toEqual({allowed:true})
   expect(evaluateBridgeAdmission(db,{...request,activityGenerationToken:'old-token'}).allowed).toBe(false)
   db.exec("UPDATE agent_consents SET status='revoked'")
   expect(evaluateBridgeAdmission(db,request).allowed).toBe(false)
   db.exec("UPDATE agent_consents SET status='active'; UPDATE managed_artifacts SET state='needs_recovery' WHERE id='artifact_cli'")
   expect(evaluateBridgeAdmission(db,request).allowed).toBe(false)
   db.exec("UPDATE managed_artifacts SET state='healthy' WHERE id='artifact_cli'; UPDATE reconcile_runs SET failure_code='unrelated_cancel' WHERE id='run_cli'")
   expect(evaluateBridgeAdmission(db,request).allowed).toBe(false)
   db.prepare("UPDATE reconcile_runs SET failure_code=? WHERE id='run_cli'").run(reason)
   db.exec(`INSERT INTO projection_mutations(id,run_id,operation_id,installation_id,component_key,artifact_id,mutation_domain,target,after_hash,idempotency_strategy,readback_strategy,state,committed_at,created_at,updated_at)
     VALUES ('replacement','run_desktop','replace','installation_desktop','lifecycle','artifact_cli','domain','/fixture/cli','new','test','test','committed','2026-01-02','now','now');
     UPDATE managed_artifacts SET owned_fragment_hash='new' WHERE id='artifact_cli';`)
   const latestRequest={...request,activityGenerationToken:'generation_desktop'}
   expect(evaluateBridgeAdmission(db,request).allowed).toBe(false)
   expect(evaluateBridgeAdmission(db,latestRequest)).toEqual({allowed:true})
   const previous=db.prepare("SELECT * FROM reconcile_runs WHERE id='run_cli'").get() as Record<string,unknown>
   for(const next of [{...previous,id:'physical_disconnect',operation_type:'disconnect',state:'committed'},
     {...previous,id:'waiting_reconnect',operation_type:'connect',state:'planned'}]){
    db.prepare(`INSERT INTO reconcile_runs (${Object.keys(next).join(',')}) VALUES (${Object.keys(next).map(()=>'?').join(',')})`).run(...Object.values(next))
   }
   db.exec(`INSERT INTO projection_mutations(id,run_id,operation_id,installation_id,component_key,artifact_id,mutation_domain,target,after_hash,idempotency_strategy,readback_strategy,state,committed_at,created_at,updated_at)
     VALUES ('physical-removal','physical_disconnect','remove','installation_cli','lifecycle','artifact_cli','domain','/fixture/cli','new','test','test','committed','2026-02-01','now','now');`)
   // A planned reconnect cannot revive the pre-removal token, even if a cached
   // consumer and Artifact have already been reopened.
   expect(evaluateBridgeAdmission(db,request).allowed).toBe(false)
   expect(evaluateBridgeAdmission(db,latestRequest).allowed).toBe(false)
  },
 )
 it('records a shared event once without treating a static surface hint as exact host evidence',()=>{
  const input={...request,signalName:'session_start' as const,tideMindVersion:'test',hostVariant:'codex-cli'}
  expect(recordHostActivityEvidence(db,input)).toEqual({status:'shared_recorded',bindingId:'binding'})
  recordHostActivityEvidence(db,{...input,hostVariant:'codex-desktop'})
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_host_activity_evidence').get()).toEqual({n:0})
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_integration_events WHERE kind='shared_agent_activity'").get()).toEqual({n:1})
 })
 it('does not revive an archived canonical Agent through an active consumer',()=>{
  db.exec("UPDATE agents SET archived=1 WHERE id='cli'")
  expect(evaluateBridgeAdmission(db,request).allowed).toBe(false)
  expect(recordHostActivityEvidence(db,{...request,signalName:'session_start',tideMindVersion:'test',hostVariant:'codex-cli'})).toEqual({status:'rejected',reason:'agent_archived'})
  expect(db.prepare("SELECT COUNT(*) AS n FROM agent_integration_events WHERE kind='shared_agent_activity'").get()).toEqual({n:0})
 })

 it('reports current shared memory activity separately from exact host verification',()=>{
  db.pragma('foreign_keys=OFF')
  db.exec("UPDATE installation_components SET component_key='memory_tools'; UPDATE artifact_consumers SET component_key='memory_tools'; UPDATE projection_mutations SET component_key='memory_tools'; UPDATE managed_artifacts SET component_type='mcp'; UPDATE reconcile_runs SET prepared_plan_json=json_set(prepared_plan_json,'$.componentKeys',json('[\"memory_tools\"]'))")
  db.pragma('foreign_keys=ON')
  const repository=new AgentIntegrationRepository(db)
  expect(repository.sharedConnectionStatus('installation_cli')?.status).toBe('waiting_for_call')
  expect(recordHostActivityEvidence(db,{agentId:'cli',activityGenerationToken:'generation_cli',componentKey:'memory_tools',signalName:'brain_recall',hostVariant:'shared',tideMindVersion:'test'}).status).toBe('shared_recorded')
  expect(repository.sharedConnectionStatus('installation_cli')).toMatchObject({status:'call_observed',memberCount:2})
  expect(repository.sharedConnectionStatus('installation_desktop')?.status).toBe('call_observed')
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_host_activity_evidence').get()).toEqual({n:0})
  db.exec("UPDATE agent_installations SET bridge_state='stopped' WHERE agent_id='cli'")
  expect(repository.sharedConnectionStatus('installation_cli')?.status).toBe('inactive')
  expect(repository.sharedConnectionStatus('installation_desktop')?.status).toBe('call_observed')
  db.exec("UPDATE agent_installations SET bridge_state='serving' WHERE agent_id='cli'")
  db.exec("UPDATE agent_consents SET status='revoked'")
  expect(repository.sharedConnectionStatus('installation_cli')?.status).toBe('inactive')
  db.exec("UPDATE agent_installations SET desired_state='removed' WHERE agent_id='cli'")
  expect(repository.sharedConnectionStatus('installation_cli')?.status).toBe('inactive')
 })

})
