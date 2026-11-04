import { describe, it, expect } from 'vitest'
// @ts-expect-error acceptance-only ESM helper
import { validateCodexNativeLifecycleReceipt, codexNativeLifecycleEvidenceHash } from '../../scripts/codex-context-restore-evidence.mjs'
import { codexContextRestoreFixture } from '../fixtures/agent-integration/codex-context-restore-fixture'

function fixture(step = 'lifecycle_session_end') {
  const f = codexContextRestoreFixture()
  const now = Date.parse('2026-10-27T10:00:00Z')
  const pair = (id:string, eventName:string, turnId:string, context?:string) => {
    const run = { id,eventName,handlerType:'command',sourcePath:'/task/.codex/hooks.json',startedAt:now/1000,status:'running',entries:[] }
    return [{method:'hook/started',params:{threadId:'native-session',turnId,run}},
      {method:'hook/completed',params:{threadId:'native-session',turnId,run:{...run,status:'completed',completedAt:now/1000,entries:context?[{kind:'context',text:context}]:[]}}}]
  }
  f.native.unshift(...pair('start-run','sessionStart','start-turn','session start body'))
  f.native.splice(f.native.findIndex(x=>x.method==='hook/started'&&x.params.run.eventName==='postCompact'),0,...pair('pre-run','preCompact','compact-turn'))
  f.native.push(...pair('end-run','sessionEnd','end-turn'))
  f.rollout.push({timestamp:new Date(now+1).toISOString(),type:'response_item',payload:{role:'developer',content:[{type:'input_text',text:'session start body'}],internal_chat_message_metadata_passthrough:{turn_id:'start-turn',content_item_kinds:['hooks.additional_context']}}})
  const runs:Record<string,[string,string]> = {lifecycle_session_start:['start-run','start-turn'],lifecycle_pre_compact:['pre-run','compact-turn'],lifecycle_post_compact:['post-run','compact-turn'],lifecycle_session_end:['end-run','end-turn']}
  const value:any = {ledgerSource:'codex_native_hooks',restoreReceipt:f.value,runId:runs[step][0],turnId:runs[step][1]}
  const expected = {...f.expected,appVersion:'0.2.94',targetId:'codex-cli',stepId:step}
  const build = () => {const files=f.build();value.evidenceHash=codexNativeLifecycleEvidenceHash(value);return files}
  return {...f,value,expected,build}
}

describe('CLI native lifecycle proof reuses the required compact session',()=>{
  it.each(['lifecycle_session_start','lifecycle_pre_compact','lifecycle_post_compact','lifecycle_session_end'])('validates %s without inventing an Installation ledger event',step=>{
    const f=fixture(step);expect(validateCodexNativeLifecycleReceipt(f.value,f.expected,f.build())).toBe(f.value)
  })
  it.each(['desktop','custom','other-version','non-lifecycle','wrong-source','wrong-session','failed','missing-completed','wrong-candidate','wrong-generation','wrong-hash','end-before-restore'])('rejects %s',kind=>{
    const f=fixture()
    if(kind==='desktop')f.expected.hostVariant='codex-desktop'
    if(kind==='custom')f.expected.targetId='nonstandard_config_root'
    if(kind==='other-version')f.expected.appVersion='0.2.93'
    if(kind==='non-lifecycle')f.expected.stepId='brain_recall'
    const end=f.native.find(x=>x.method==='hook/completed'&&x.params.run.id==='end-run')
    if(kind==='wrong-source')end.params.run.sourcePath='/daily/hooks.json'
    if(kind==='wrong-session')end.params.threadId='another-session'
    if(kind==='failed')end.params.run.status='failed'
    if(kind==='missing-completed')f.native.splice(f.native.indexOf(end),1)
    if(kind==='wrong-candidate')f.metadata.sourceCommit='b'.repeat(40)
    if(kind==='wrong-generation')f.sidecar.generationSha256='0'.repeat(64)
    if(kind==='end-before-restore') {const events=f.native.splice(-2);f.native.unshift(...events)}
    const files=f.build();if(kind==='wrong-hash')f.value.evidenceHash='0'.repeat(64)
    expect(()=>validateCodexNativeLifecycleReceipt(f.value,f.expected,files)).toThrow()
  })
  it('requires SessionStart body in actual model input',()=>{
    const f=fixture('lifecycle_session_start');f.rollout.pop()
    expect(()=>validateCodexNativeLifecycleReceipt(f.value,f.expected,f.build())).toThrow(/SessionStart context absent/)
  })
  it('requires PreCompact before the same real compaction',()=>{
    const f=fixture('lifecycle_pre_compact');const events=f.native.filter(x=>x.params?.run?.id==='pre-run');f.native.splice(0,f.native.length,...f.native.filter(x=>x.params?.run?.id!=='pre-run'),...events)
    expect(()=>validateCodexNativeLifecycleReceipt(f.value,f.expected,f.build())).toThrow(/PreCompact must precede/)
  })
})
