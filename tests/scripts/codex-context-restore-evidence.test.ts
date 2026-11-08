import { historical095RequirementsPath, historical095ManifestPath } from '../fixtures/agent-integration/historical-host-acceptance.js'
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
// @ts-expect-error acceptance-only ESM helper
import { validateCodexContextRestore, rejectReusedCodexRestoreRuns } from '../../scripts/codex-context-restore-evidence.mjs'
// @ts-expect-error existing ESM contract
import { loadAgentHostAcceptanceRequirements, requiredHostAcceptanceSteps } from '../../scripts/verify-agent-integration-host-acceptance.mjs'
import { codexContextRestoreFixture as fixture } from '../fixtures/agent-integration/codex-context-restore-fixture'
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
describe('Codex compact restore original evidence',()=>{
 it.each(['manual','auto'])('accepts paired native %s evidence (synthetic test fixture only)',trigger=>{const f=fixture(trigger);expect(validateCodexContextRestore(f.value,f.expected,f.build()).turnId).toBe('restore-turn')})
 it('allows unrelated SessionStart context in the same turn but rejects duplicate UPS text',()=>{const f=fixture();const extra=structuredClone(f.rollout[1]);extra.payload.content[0].text='separate SS body';f.rollout.push(extra);expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).not.toThrow();f.rollout.push(structuredClone(f.rollout[1]));expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).toThrow(/ambiguous/)})
 it('allows stable handler ids reused in other turns',()=>{const f=fixture();const extra=f.native.filter(x=>x.method==='hook/started'||x.method==='hook/completed').map(x=>{const y=structuredClone(x);y.params.turnId='other-turn';return y});f.native.push(...extra);expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).not.toThrow()})
 it.each(['event','session','generation','source','candidate','marker','manual-as-auto','ss','nonce','revision','missing-start','fifth-hook'])('rejects %s evidence',kind=>{
  const f=fixture();
  if(kind==='event')f.native[5].params.run.eventName='sessionStart'
  if(kind==='session')f.sidecar.sessionId='other'
  if(kind==='generation')f.sidecar.generationSha256=hash('other')
  if(kind==='source')f.native[5].params.run.sourcePath='/daily/hooks.json'
  if(kind==='candidate')f.metadata.candidateBundleSha256=hash('other')
  if(kind==='marker')f.rollout[1].payload.content[0].text='marker alone'
  if(kind==='manual-as-auto')f.expected.stepId='codex_context_restore_auto'
  if(kind==='ss')delete (f.summary as any).deliveredTurnIdHash
  if(kind==='nonce')f.sidecar.captureNonce=hash('other')
  if(kind==='revision')f.summary.deliveredRevision=1
  if(kind==='missing-start')f.native.splice(4,1)
  if(kind==='fifth-hook')delete (f.summary as any).hookDefinitionSha256
  expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).toThrow(/Codex context restore/)
 })
 it('rejects fabricated accepted field and consumed cross-host run reuse',()=>{const f=fixture();f.value.accepted=true;expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).toThrow(/fields/);delete f.value.accepted;expect(()=>rejectReusedCodexRestoreRuns([{steps:[{id:f.expected.stepId,codexContextRestore:f.value}]},{steps:[{id:'codex_context_restore_auto',codexContextRestore:f.value}]}])).toThrow(/reused/)})
 it('never promotes fixture exporter receipts to formal evidence',()=>{const f=fixture();f.metadata.evidenceClass='fixture';expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).toThrow(/real candidate/);expect(()=>validateCodexContextRestore(f.value,{...f.expected,allowFixtureActivity:true},f.build())).not.toThrow()})
 it('requires both steps for Codex and its Custom source, not unrelated hosts',()=>{const r=loadAgentHostAcceptanceRequirements(historical095RequirementsPath, historical095ManifestPath);const c=r.entries.find((x:any)=>x.catalogId==='codex-cli');expect(requiredHostAcceptanceSteps(r,c)).toEqual(expect.arrayContaining(['codex_context_restore_manual','codex_context_restore_auto']));expect(requiredHostAcceptanceSteps(r,{...c,targetId:'nonstandard_config_root',disposition:'custom',policyDisposition:c.disposition})).toContain('codex_context_restore_auto');const other=r.entries.find((x:any)=>x.catalogId==='cursor-desktop');expect(requiredHostAcceptanceSteps(r,other)).not.toContain('codex_context_restore_auto')})
})


describe('native Hook Unix-second timestamps',()=>{
 it('accepts subsecond sidecar and export within the completed native second',()=>{
  const f=fixture();const now=Date.parse('2026-10-27T10:00:00Z')
  f.expected.captureCreatedAt=now+100
  f.sidecar.observedAt=new Date(now+562).toISOString()
  f.summary.updatedAt=now+800
  f.metadata.exportedAt=new Date(now+900).toISOString()
  f.rollout[1].timestamp=new Date(now+850).toISOString()
  expect(f.native[3].params.run.startedAt).toBe(now/1000)
  expect(f.native[3].params.run.completedAt).toBe(now/1000)
  expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).not.toThrow()
 })
 it.each(['milliseconds','fractional-seconds','sidecar-next-second','sidecar-before-start','outside-capture','same-second-reordered'])(
  'rejects %s rather than guessing units or loosening evidence order',kind=>{
   const f=fixture();const now=Date.parse('2026-10-27T10:00:00Z')
   if(kind==='milliseconds')for(const item of f.native)if(item.params?.run){item.params.run.startedAt*=1000;if(item.params.run.completedAt!==undefined)item.params.run.completedAt*=1000}
   if(kind==='fractional-seconds')for(const item of f.native)if(item.params?.run)item.params.run.startedAt+=0.5
   if(kind==='sidecar-next-second')f.sidecar.observedAt=now+1000
   if(kind==='sidecar-before-start')f.sidecar.observedAt=now-1
   if(kind==='outside-capture')f.expected.captureCreatedAt=now+1000
   if(kind==='same-second-reordered'){const started=f.native.splice(4,1)[0];f.native.splice(3,0,started)}
   expect(()=>validateCodexContextRestore(f.value,f.expected,f.build())).toThrow(/Codex context restore/)
  },
 )
})
