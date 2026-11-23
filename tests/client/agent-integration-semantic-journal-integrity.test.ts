import { describe, expect, it, vi } from 'vitest'
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/synthetic-codex-readback',getVersion:()=> 'synthetic-test',getAppPath:()=>'/tmp/Synthetic.app',isPackaged:false},Notification:class{static isSupported(){return false} show(){}}}))
vi.mock('../../src/strategy/loader.js',()=>({getParam:(_s:string,_p:string,f:number)=>f,getPrompt:()=>'',loadStrategies:()=>{},getStrategy:()=>null}))
vi.mock('../../client/electron/agent-integration/config-root-watcher.js',()=>({AgentConfigRootWatcher:class{update(){} close(){}}}))
import { createCodexSemanticComposition } from '../../tests/fixtures/codex-semantic-composition.js'
import { CodexMcpSemanticReadback } from '../../client/electron/agent-integration/codex-mcp-semantic-readback.js'

describe('semantic readback rejects damaged physical journals',()=>{
  it.each(['missing_effect','changed_domain','changed_strategy','changed_fence'])('checks complete physical journal after %s',async change=>{
    const f=await createCodexSemanticComposition(false)
    const worker=new CodexMcpSemanticReadback({repository:f.composition.coordinatorRepository,runtime:f.runtime,enabled:()=>true,attest:async(_i,expected)=>expected??'2'.repeat(64)})
    try {
      const writer=f.db.prepare('SELECT run_id FROM projection_mutations WHERE id=?').get(f.anchor.mutation_id) as {run_id:string}
      if(change==='missing_effect') {
        const other=f.db.prepare('SELECT id FROM projection_mutations WHERE run_id=? AND id!=?').all(writer.run_id,f.anchor.mutation_id) as Array<{id:string}>
        expect(other.length).toBeGreaterThan(0)
        f.db.prepare('DELETE FROM projection_mutations WHERE id=?').run(other[0].id)
      }
      if(change==='changed_domain')f.db.prepare("UPDATE projection_mutations SET mutation_domain='synthetic-broken-domain' WHERE id=?").run(f.anchor.mutation_id)
      if(change==='changed_strategy')f.db.prepare("UPDATE projection_mutations SET idempotency_strategy='never_replay' WHERE id=?").run(f.anchor.mutation_id)
      if(change==='changed_fence')f.db.prepare("UPDATE reconcile_runs SET writer_fence_snapshot_json='{}' WHERE id=?").run(writer.run_id)
      f.rewrite()
      const candidates=f.composition.coordinatorRepository.listCodexMcpSemanticCandidates()
      await worker.renew()
      const admission=f.admit()
      expect(candidates).toEqual([])
      // The intended complete-journal contract should refuse every probe.
      expect(admission.allowed).toBe(false)
    } finally {worker.stop();f.close()}
  })
})
