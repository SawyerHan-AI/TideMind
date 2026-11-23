import { describe, expect, it, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/synthetic-codex-readback',getVersion:()=> 'synthetic-test',getAppPath:()=>'/tmp/Synthetic.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
// These tests drive each real maintenance boundary explicitly. Native watcher
// scheduling has its own tests; an empty synthetic discovery scan must not race
// this fixture and incorrectly report that its fake hosts were uninstalled.
vi.mock('../../client/electron/agent-integration/config-root-watcher.js',()=>({AgentConfigRootWatcher:class{update(){} close(){}}}))
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'smol-toml'
import { createCodexSemanticComposition } from '../fixtures/codex-semantic-composition.js'
import { evaluateBridgeAdmission as oldAdmission } from '../fixtures/codex-mcp-v0.2.102/src/agent-bridge-guard.js'
import { CodexMcpSemanticReadback } from '../../client/electron/agent-integration/codex-mcp-semantic-readback.js'
import { retainCodexSourceRejection, captureBridgeAnchor, currentBridgeFileIdentity, currentCodexMemberSurface,
  publishAttestedBridgeMember, codexSourceBlockApplies } from '../../src/db/codex-bridge-continuity.js'
import { createHash } from 'node:crypto'
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard.js'

describe('production Codex semantic recovery',()=>{
  it.each([true,false])('recovers without writing configuration and hands back to exact with autoRestore=%s',async autoRestore=>{
    const f = await createCodexSemanticComposition(autoRestore)
    try {
      expect(f.admit()).toEqual({allowed:true})
      expect(f.composition.coordinatorRepository.listCodexMcpSemanticCandidates().length,JSON.stringify({
        candidates:f.composition.coordinatorRepository.listCodexMcpSemanticCandidates().map(c=>c.installation.id),
        rows:f.db.prepare('SELECT id,desired_state,status_reason,reconcile_state FROM agent_installations').all(),
        runs:f.db.prepare("SELECT installation_id,state,failure_code,json_extract(prepared_plan_json,'$.executionPlan.sharedIdentityBinding') binding FROM reconcile_runs").all(),
        consumers:f.db.prepare("SELECT installation_id,component_key,desired_state,state FROM artifact_consumers").all(),
        identities:['codex-cli','codex-desktop'].map(id=>({id,...f.composition.repository.coordinatorAgentIdentity(id)})),
      })).toBe(2)
      const journal = f.db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()
      const bytes = f.rewrite()
      expect(bytes).not.toBe(f.original)
      expect(f.admit().allowed).toBe(false)
      for (let i=0;i<3;i++) await f.composition.runtime.runMaintenance()
      expect(f.admit(),JSON.stringify({
        candidates:f.composition.coordinatorRepository.listCodexMcpSemanticCandidates().map(c=>c.installation.id),
        rows:f.db.prepare('SELECT id,desired_state,status_reason,reconcile_state FROM agent_installations').all(),
        runs:f.db.prepare('SELECT installation_id,state,failure_code FROM reconcile_runs').all(),
        evidence:f.db.prepare('SELECT installation_id,evidence_phase,layout_kind FROM codex_mcp_semantic_member_proofs').all(),
        artifacts:f.db.prepare('SELECT component_type,state,owned_fragment_hash=observed_fragment_hash matched FROM managed_artifacts').all(),
        events:f.db.prepare("SELECT kind,payload_json FROM agent_integration_events WHERE kind LIKE 'codex_mcp%' OR kind='artifact_drifted'").all(),
      })).toEqual({allowed:true})
      expect(fs.readFileSync(f.configFile,'utf8')).toBe(bytes)
      expect(f.db.prepare("SELECT count(*) n FROM codex_mcp_semantic_member_proofs WHERE evidence_phase='active'").get()).toEqual({n:2})
      expect(f.db.prepare("SELECT count(*) n FROM codex_bridge_member_proofs WHERE component_key='memory_tools'").get()).toEqual({n:0})
      const ui=f.composition.service.snapshot()
      for(const installation of ui.installations){
        expect(installation.components.find(component=>component.key==='memory_tools')).toMatchObject({
          state:'configured',configurationVerified:true,configurationCheck:{kind:'semantic'},evidenceScope:'configuration_domain',
        })
      }
      expect(ui.connections.find(connection=>connection.familyId==='codex')?.memoryCallsVerified).toBe(false)
      expect(f.db.prepare("SELECT count(*) n FROM agent_integration_events WHERE kind='shared_agent_activity'").get()).toEqual({n:0})
      expect(oldAdmission(f.db,{agentId:f.canonical,activityGenerationToken:f.token}).allowed).toBe(false)
      expect(f.db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()).toEqual(journal)
      fs.writeFileSync(f.configFile,f.original)
      expect(f.admit().allowed).toBe(false)
      for (let i=0;i<3;i++) await f.composition.runtime.runMaintenance()
      expect(f.admit()).toEqual({allowed:true})
      expect(oldAdmission(f.db,{agentId:f.canonical,activityGenerationToken:f.token}).allowed).toBe(true)
      expect(fs.readFileSync(f.configFile,'utf8')).toBe(f.original)
      expect(f.db.prepare('SELECT count(*) n FROM codex_mcp_semantic_member_proofs').get()).toEqual({n:0})
      expect(f.db.prepare('SELECT * FROM projection_mutations ORDER BY id').all()).toEqual(journal)
    } finally { f.close() }
  })

  it('retains non-authorizing facts when activation rolls back, then activates atomically on retry',async()=>{
    const f = await createCodexSemanticComposition(false)
    const worker = new CodexMcpSemanticReadback({repository:f.composition.coordinatorRepository,runtime:f.runtime,
      enabled:()=>true,attest:async(_installation,expected)=>expected ?? '2'.repeat(64)})
    try {
      const bytes=f.rewrite()
      f.db.exec("CREATE TRIGGER synthetic_activation_abort BEFORE UPDATE OF evidence_phase ON codex_mcp_semantic_member_proofs WHEN NEW.evidence_phase='active' BEGIN SELECT RAISE(ABORT,'synthetic activation abort'); END")
      expect(await worker.renew()).toBe(true)
      expect(f.db.prepare('SELECT DISTINCT evidence_phase FROM codex_mcp_semantic_member_proofs').all()).toEqual([{evidence_phase:'collected'}])
      expect(f.admit().allowed).toBe(false)
      expect(oldAdmission(f.db,{agentId:f.canonical,activityGenerationToken:f.token}).allowed).toBe(false)
      expect(f.composition.service.snapshot().installations.every(installation=>
        !installation.components.find(component=>component.key==='memory_tools')?.configurationCheck)).toBe(true)
      f.db.exec('DROP TRIGGER synthetic_activation_abort')
      await worker.renew()
      expect(f.admit().allowed).toBe(true)
      expect(f.db.prepare("SELECT count(*) n FROM codex_mcp_semantic_member_proofs WHERE evidence_phase='active'").get()).toEqual({n:2})
      expect(fs.readFileSync(f.configFile,'utf8')).toBe(bytes)
      const proofs=f.db.prepare('SELECT * FROM codex_mcp_semantic_member_proofs ORDER BY installation_id').all()
      await worker.renew()
      expect(f.db.prepare('SELECT * FROM codex_mcp_semantic_member_proofs ORDER BY installation_id').all()).toEqual(proofs)
    } finally {worker.stop();f.close()}
  })

  it.each(['resolve','reject'] as const)('releases leases on stop before late attestation %s',async outcome=>{
    const f = await createCodexSemanticComposition(false)
    let release!:(value:string)=>void
    let reject!:(error:Error)=>void
    let signal:AbortSignal|undefined
    let started!:()=>void
    const entered=new Promise<void>(resolve=>{started=resolve})
    const worker=new CodexMcpSemanticReadback({repository:f.composition.coordinatorRepository,runtime:f.runtime,enabled:()=>true,
      attest:async(_installation,_expected,currentSignal)=>{signal=currentSignal;started();return new Promise<string>((resolve,fail)=>{release=resolve;reject=fail})}})
    try {
      f.rewrite()
      const operation=worker.renew()
      await entered
      worker.stop()
      expect(signal?.aborted).toBe(true)
      // Must settle and release our locks without waiting for shared source I/O.
      await operation
      expect(f.db.prepare('SELECT count(*) n FROM codex_mcp_semantic_member_proofs').get()).toEqual({n:0})
      expect(f.admit().allowed).toBe(false)
      expect(f.db.prepare("SELECT count(*) n FROM writer_fences WHERE state='active'").get()).toEqual({n:0})
      if(outcome==='resolve')release('3'.repeat(64));else reject(new Error('late synthetic failure'))
      await Promise.resolve()
      expect(f.db.prepare('SELECT count(*) n FROM codex_mcp_semantic_member_proofs').get()).toEqual({n:0})
    } finally {worker.stop();f.close()}
  })

  it('ignores stale identity-conflict callbacks without revoking a current semantic proof',async()=>{
    const f=await createCodexSemanticComposition(false)
    try{
      f.rewrite()
      await f.composition.runtime.runMaintenance()
      const row=f.composition.repository.getInstallation('codex-cli')!
      f.db.prepare('UPDATE agent_installations SET metadata_json=? WHERE id=?').run(
        JSON.stringify({...JSON.parse(row.metadata_json),detectionSequence:100}),'codex-cli')
      const before=f.db.prepare('SELECT * FROM codex_mcp_semantic_member_proofs ORDER BY installation_id').all()
      f.composition.repository.markInstallationIdentityConflict('codex-cli',new Date().toISOString(),'synthetic-old-observation',99)
      expect(f.db.prepare('SELECT * FROM codex_mcp_semantic_member_proofs ORDER BY installation_id').all()).toEqual(before)
      expect(f.admit()).toEqual({allowed:true})
    }finally{f.close()}
  })

  it('revokes stale semantic facts instead of repairing actual user changes',async()=>{
    const f=await createCodexSemanticComposition(false)
    try {
      f.rewrite()
      await f.composition.runtime.runMaintenance()
      expect(f.admit().allowed).toBe(true)
      const changed=fs.readFileSync(f.configFile,'utf8')+'\nUNREVIEWED_ENV = "synthetic-user-change"\n'
      fs.writeFileSync(f.configFile,changed)
      await f.composition.runtime.runMaintenance()
      expect(f.admit().allowed).toBe(false)
      expect(f.db.prepare('SELECT count(*) n FROM codex_mcp_semantic_member_proofs').get()).toEqual({n:0})
      expect(fs.readFileSync(f.configFile,'utf8')).toBe(changed)
    } finally {f.close()}
  })

  it.each(['file-replaced','paused','scan-invalidated','lease-expired'] as const)(
    'does not publish when %s during the final source attestation',async boundary=>{
      const f=await createCodexSemanticComposition(false)
      let attestations=0,fresh=true,leaseCurrent=true
      const acquire=f.composition.coordinatorRepository.acquireWriterFence.bind(f.composition.coordinatorRepository)
      const fence=vi.spyOn(f.composition.coordinatorRepository,'acquireWriterFence').mockImplementation(domain=>{
        const held=acquire(domain)
        return held?{...held,assertOwned:()=>{if(!leaseCurrent)throw new Error('synthetic expired lease');held.assertOwned()},release:()=>held.release()}:null
      })
      const worker=new CodexMcpSemanticReadback({repository:f.composition.coordinatorRepository,runtime:f.runtime,
        enabled:installation=>installation.id==='codex-cli',canPublish:()=>fresh,
        attest:async(_installation,expected)=>{
          if(++attestations===2){
            if(boundary==='file-replaced'){
              const replacement=f.configFile+'.replacement'
              fs.writeFileSync(replacement,fs.readFileSync(f.configFile))
              fs.renameSync(replacement,f.configFile)
            }else if(boundary==='paused')f.composition.repository.pauseConnection(`binding:${f.bindingId}`,new Date().toISOString())
            else if(boundary==='scan-invalidated')fresh=false
            else leaseCurrent=false
          }
          return expected??'7'.repeat(64)
        }})
      try {
        const bytes=f.rewrite()
        await worker.renew()
        expect(attestations).toBe(2)
        expect(f.db.prepare('SELECT count(*) n FROM codex_mcp_semantic_member_proofs').get()).toEqual({n:0})
        expect(f.admit().allowed).toBe(false)
        expect(fs.readFileSync(f.configFile,'utf8')).toBe(bytes)
      }finally{worker.stop();fence.mockRestore();f.close()}
    })

  it('preserves two historical source barriers through real disconnect and explicit reconnect',async()=>{
    const f=await createCodexSemanticComposition(false)
    try {
      for(const id of ['codex-cli','codex-desktop'])retainCodexSourceRejection(f.db,id)
      expect(f.admit().allowed).toBe(false)
      for(const id of ['codex-cli','codex-desktop']){
        const preview=await f.composition.service.previewDisconnect(id)
        const result=await f.composition.service.disconnect(preview.planHash,id)
        expect(result.results[0]?.status,JSON.stringify(result)).not.toBe('failed')
      }
      // Simulate the documented manual cleanup only inside the synthetic HOME.
      // Production code must not unlink whole managed text files automatically.
      const skills=f.db.prepare("SELECT target_path FROM managed_artifacts WHERE component_type='skill'").all() as Array<{target_path:string}>
      for(const skill of skills){
        expect(path.resolve(skill.target_path).startsWith(f.root+path.sep)).toBe(true)
        if(fs.existsSync(skill.target_path))fs.unlinkSync(skill.target_path)
      }
      await f.composition.coordinator.recoverNonTerminalRuns()
      for(const id of ['codex-cli','codex-desktop']){
        const preview=await f.composition.service.previewConnect([id],true,undefined,{withoutLifecycleInstallationIds:[id]})
        const result=await f.composition.service.applyConnect(preview.planHash,[id])
        expect(result.results[0]?.status,JSON.stringify(result)).toBe('awaiting_verification')
      }
      const identity=f.composition.repository.resolveAgentIdentity('codex-cli')
      const original=fs.readFileSync(f.configFile,'utf8')
      const document=parse(original)
      const entry=(document.mcp_servers as Record<string,{enabled?:boolean;env:Record<string,string>}>)[`tidemind-${identity.canonicalAgentId}`]
      const generation=entry.env.EB_ACTIVITY_GENERATION_TOKEN
      expect(generation).not.toBe(f.token)
      const tokenHash=createHash('sha256').update(JSON.stringify(generation)).digest('hex')
      const artifact=(f.db.prepare("SELECT artifact_id FROM installation_components WHERE installation_id='codex-cli' AND component_key='memory_tools'").get() as {artifact_id:string}).artifact_id
      const anchor=captureBridgeAnchor(f.db,identity.bindingId!,artifact,'memory_tools')!
      expect(anchor).not.toBeNull()
      for(const id of ['codex-cli','codex-desktop'])f.db.transaction(()=>publishAttestedBridgeMember(f.db,anchor,{
        installationId:id,consentId:f.composition.repository.getInstallation(id)!.consent_envelope_id!,
        surface:currentCodexMemberSurface(f.db,id)!,source:'4'.repeat(64),fileIdentity:currentBridgeFileIdentity(f.configFile)!,
        intentRevision:f.composition.repository.connectionIntent(id).revision,observedAt:new Date().toISOString(),
      })).immediate()
      expect(codexSourceBlockApplies(f.db,identity.bindingId!,'memory_tools',tokenHash)).toBe(false)
      delete entry.enabled
      const {stringify}=await import('smol-toml')
      fs.writeFileSync(f.configFile,stringify(document))
      const admitNew=()=>evaluateBridgeAdmission(f.db,{agentId:identity.canonicalAgentId,activityGenerationToken:generation})
      let peerAvailable=false
      const partial=new CodexMcpSemanticReadback({repository:f.composition.coordinatorRepository,runtime:f.runtime,enabled:()=>true,
        attest:async(installation,expected)=>installation.id==='codex-desktop'&&!peerAvailable?null:expected??'5'.repeat(64)})
      try {
        expect(await partial.renew()).toBe(true)
        expect(f.db.prepare('SELECT installation_id,evidence_phase FROM codex_mcp_semantic_member_proofs').all()).toEqual([
          {installation_id:'codex-cli',evidence_phase:'collected'},
        ])
        expect(codexSourceBlockApplies(f.db,identity.bindingId!,'memory_tools',tokenHash)).toBe(true)
        expect(admitNew().allowed).toBe(false)
        expect(oldAdmission(f.db,{agentId:identity.canonicalAgentId,activityGenerationToken:generation}).allowed).toBe(false)
        expect(f.composition.service.snapshot().connections.find(c=>c.familyId==='codex')?.configurationCheck).toBeUndefined()
        // Shutdown discards the incomplete closure; a new worker must attest it
        // again and cannot activate the previous runtime's collection epoch.
        partial.stop()
        expect(f.db.prepare('SELECT count(*) n FROM codex_mcp_semantic_member_proofs').get()).toEqual({n:0})
        peerAvailable=true
        const next=new CodexMcpSemanticReadback({repository:f.composition.coordinatorRepository,runtime:f.runtime,enabled:()=>true,
          attest:async(_installation,expected)=>expected??'6'.repeat(64)})
        try { await next.renew() } finally {next.stop()}
      } finally {partial.stop()}
      expect(codexSourceBlockApplies(f.db,identity.bindingId!,'memory_tools',tokenHash)).toBe(false)
      expect(admitNew()).toEqual({allowed:true})
      expect(f.db.prepare("SELECT count(*) n FROM codex_mcp_semantic_member_proofs WHERE evidence_phase='active'").get()).toEqual({n:2})
      expect(f.admit().allowed).toBe(false)
      expect(f.db.prepare('SELECT count(*) n FROM codex_bridge_source_blocks').get()).toEqual({n:2})
      fs.writeFileSync(f.configFile,original)
      expect(admitNew().allowed).toBe(false)
      await f.composition.runtime.runMaintenance()
      expect(admitNew()).toEqual({allowed:true})
      expect(codexSourceBlockApplies(f.db,identity.bindingId!,'memory_tools',tokenHash)).toBe(false)
      expect(f.db.prepare('SELECT count(*) n FROM codex_mcp_semantic_member_proofs').get()).toEqual({n:0})
      expect(f.admit().allowed).toBe(false)
    } finally {f.close()}
  })

  it('validates a historical no-effect fence after the member disconnects',async()=>{
    const f=await createCodexSemanticComposition(false)
    try {
      const run=f.db.prepare("SELECT * FROM reconcile_runs WHERE installation_id='codex-desktop' AND operation_type='connect' ORDER BY rowid DESC LIMIT 1").get() as {prepared_plan_json:string}
      const plan=JSON.parse(run.prepared_plan_json)
      expect(plan.adapterPlan.mutations).toHaveLength(0)
      const installation=f.composition.coordinatorRepository.codexMcpSemanticSnapshot('codex-desktop')!.installation
      const validate=Reflect.get(f.composition.coordinatorRepository,'validateCodexImmutableJournal')
        .bind(f.composition.coordinatorRepository) as (run:unknown,plan:unknown,installation:unknown)=>void
      expect(()=>validate(run,plan,installation)).not.toThrow()
      const preview=await f.composition.service.previewDisconnect('codex-desktop')
      await f.composition.service.disconnect(preview.planHash,'codex-desktop')
      expect(f.composition.repository.getInstallation('codex-desktop')!.desired_state).toBe('removed')
      // This is a historical-envelope unit check, not an assertion that a
      // disconnected member can receive a new proof or serve memory calls.
      expect(()=>validate(run,plan,installation)).not.toThrow()
      expect(f.composition.coordinatorRepository.codexMcpSemanticSnapshot('codex-desktop')).toBeNull()
    }finally{f.close()}
  })
})
