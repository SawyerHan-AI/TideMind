import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { agentIdentityDomainKey } from '../../src/db/agent-identity-binding'
import { AGENT_DIAGNOSTIC_SCHEMA_SQL, captureDiagnosticBinding, diagnosticHash, readDiagnosticContext } from '../../src/agent-diagnostic-contract'
import { AgentDiagnosticRunStore } from '../../client/electron/agent-integration/diagnostic-run-store'

export const MEM='fixture-memory-generation', HOOK='fixture-hook-generation'
export const T0='2026-11-06T01:00:00.000Z'
export function createDiagnosticFixture(shared=false, timeZone='Asia/Shanghai', initialTime=new Date(T0)) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-diagnostic-contract-')))
  const home=path.join(root,'home'), controlData=path.join(home,'.tidemind')
  fs.mkdirSync(path.join(controlData,'graph'),{recursive:true})
  fs.writeFileSync(path.join(controlData,'config.toml'),'[general]\nuser_name = "PRIVATE_PROFILE_SENTINEL"\n[anthropic]\napi_key = "PRIVATE_CONFIG_KEY_SENTINEL"\n')
  const control=path.join(controlData,'graph','brain.sqlite'), diagnostics=path.join(root,'agent-diagnostics')
  const db=new Database(control);ensureSchema(db);db.exec(AGENT_DIAGNOSTIC_SCHEMA_SQL);db.exec(AGENT_DIAGNOSTIC_SCHEMA_SQL)
  const ids=shared?['fixture-cli','fixture-desktop']:['fixture-cli']
  const canonical=shared?'eb_shared':'eb_fixture_cli'
  for(const id of new Set([canonical,...ids.map(id=>'eb_'+id.replaceAll('-','_'))])) db.prepare('INSERT INTO agents(id,name,tool_type,archived,created) VALUES (?,?,?,0,?)').run(id,'Synthetic diagnostic fixture','codex',T0)
  for(const [index,id] of ids.entries()) {
    const variant=shared?(index===0?'codex-cli':'codex-desktop'):'claude-code-native'
    db.prepare(`INSERT INTO agent_installations(id,family,host_variant,runtime_realm,profile_id,install_key,distribution_id,
      os_user_identity,display_name,config_root,executable_path,detected_version,agent_id,desired_state,health_state,metadata_json,created_at,updated_at)
      VALUES (?, ?,?,'local_macos','default',?,?,'synthetic-user','Synthetic host',?,?, '1.0.0',?,'managed','discovered',?,?,?)`).run(
      id,shared?'codex':'claude-code',variant,`key:${id}`,`fixture:${variant}`,path.join(root,'config'),path.join(root,variant),
      'eb_'+id.replaceAll('-','_'),JSON.stringify({distribution:{distributionId:`fixture:${variant}`,packageProvenance:'fixture',capabilityFingerprint:`source:${variant}`}}),T0,T0)
    db.prepare(`INSERT INTO agent_consents(id,installation_id,policy_version,allowed_components_json,selector_schema_version,maximum_risk,status,confirmed_at,created_at)
      VALUES (?,?,'1','["memory_tools","lifecycle"]','1','low','active',?,?)`).run(`consent:${id}`,id,T0,T0)
    db.prepare('UPDATE agent_installations SET consent_envelope_id=? WHERE id=?').run(`consent:${id}`,id)
  }
  if(shared) {
    const row=db.prepare('SELECT * FROM agent_installations WHERE id=?').get(ids[0]) as any
    db.prepare('INSERT INTO agent_identity_bindings(id,domain_key,canonical_agent_id,generation,evidence_hash,created_at,updated_at) VALUES (?,?,?,1,?,?,?)')
      .run('fixture-binding',agentIdentityDomainKey(row),canonical,'a'.repeat(64),T0,T0)
    for(const id of ids)db.prepare('INSERT INTO agent_identity_binding_members(installation_id,binding_id) VALUES (?,?)').run(id,'fixture-binding')
  }
  for(const component of ['memory_tools','lifecycle'] as const) {
    const artifact=`artifact:${component}`, token=component==='memory_tools'?MEM:HOOK, owned=diagnosticHash(`fixture-content:${component}`)
    db.prepare(`INSERT INTO managed_artifacts(id,component_type,target_path,ownership_key,mutation_domain,projection_version,selector_schema_version,
      owned_fragment_hash,observed_fragment_hash,desired_fragment_hash,state,created_at,updated_at) VALUES (?,?,?,'document',?,'1','1',?,?,?,'healthy',?,?)`)
      .run(artifact,component==='memory_tools'?'mcp':'hook',path.join(root,component),`domain:${component}`,owned,owned,owned,T0,T0)
    for(const id of ids) {
      db.prepare(`INSERT INTO installation_components(installation_id,component_key,desired_state,desired_capability,delivery_mode,
        artifact_id,visibility_state,consent_envelope_id,created_at,updated_at) VALUES (?,?,'managed',4,'managed',?,'dedicated',?,?,?)`)
        .run(id,component,artifact,`consent:${id}`,T0,T0)
      db.prepare(`INSERT INTO artifact_consumers(artifact_id,installation_id,component_key,required_capability,consent_envelope_id,added_at,updated_at)
        VALUES (?,?,?,4,?,?,?)`).run(artifact,id,component,`consent:${id}`,T0,T0)
    }
    const run=`run:${component}`
    db.prepare(`INSERT INTO reconcile_runs(id,installation_id,operation_type,execution_plan_hash,consent_envelope_id,state,recovery_strategy,
      prepared_plan_json,created_at,updated_at) VALUES (?,?,'connect','fixture-plan',?,'committed','readback_before_replay',?,?,?)`).run(
      run,ids[0],`consent:${ids[0]}`,JSON.stringify({componentKeys:[component],activityGenerationToken:token,
        executionPlan:{activityGenerationTokenHash:diagnosticHash(JSON.stringify(token))}}),T0,T0)
    db.prepare(`INSERT INTO projection_mutations(id,run_id,operation_id,installation_id,component_key,artifact_id,mutation_domain,target,after_hash,
      idempotency_strategy,readback_strategy,state,committed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'readback_exact_then_replay','adapter_readback','committed',?,?,?)`)
      .run(`mutation:${component}`,run,`operation:${component}`,ids[0],component,artifact,`domain:${component}`,path.join(root,component),owned,T0,T0,T0)
  }
  let now=initialTime
  const options={controlDatabasePath:control,diagnosticsRoot:diagnostics,timeZone,now:()=>now}
  const store=new AgentDiagnosticRunStore(db,options)
  const binding=()=>captureDiagnosticBinding(db,ids[0],{memory_tools:MEM,lifecycle:HOOK})
  const prepare=(mode:'automatic'|'manual'='automatic')=>store.prepare({binding:binding(),mode})
  const context=(run:ReturnType<typeof prepare>)=>readDiagnosticContext({trustedControlDatabasePath:control,env:run.environment,now})!
  const done=(runId:string)=>{store.cancel(runId);store.confirmProcessesExited(runId);store.cleanup(runId)}
  return {root,home,controlData,control,diagnostics,db,store,options,ids,canonical,binding,prepare,context,done,
    close:()=>{if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true})},setNow:(at:string)=>{now=new Date(at)}}
}
