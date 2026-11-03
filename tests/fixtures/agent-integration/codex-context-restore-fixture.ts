import { createHash } from 'node:crypto'
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
export function codexContextRestoreFixture(trigger='manual') {
 const now=Date.parse('2026-10-27T10:00:00Z'),session='native-session',turn='restore-turn',path='/task/.codex/hooks.json'
 const expected:any={stepId:`codex_context_restore_${trigger}`,targetKey:'codex-cli:fixture',installationId:'installation',agentId:'agent',hostVersion:'0.157.1',hostVariant:'codex-cli',sourceCommit:'a'.repeat(40),releaseContractSha256:hash('release'),candidateBundleSha256:hash('candidate'),captureNonce:hash('nonce'),captureCreatedAt:now-100,observedAt:now+1000}
 const summary={schemaVersion:1,captureNonce:expected.captureNonce,scopeKey:'codex_context_restore:v1:'+hash('scope'),generationSha256:hash('generation'),sessionIdSha256:hash(session),pendingRevision:2,deliveredRevision:2,deliveredTurnIdHash:hash(turn),updatedAt:now+21,expiresAt:now+10000,hookSourcePathSha256:hash(path),hookDefinitionSha256:hash('definition'),upsScriptSha256:hash('script')}
 const target:any={targetKey:expected.targetKey,targetId:'codex-cli',installationId:'installation',agentId:'agent',hostVersion:'0.157.1',codexContextRestore:summary}
 const metadata:any={exporterVersion:1,evidenceClass:'real_host',candidateBundleSha256:expected.candidateBundleSha256,sourceCommit:expected.sourceCommit,releaseContractSha256:expected.releaseContractSha256,targetMetadata:target,exportedAt:new Date(now+100).toISOString()}
 const sidecar:any={schemaVersion:1,captureNonce:expected.captureNonce,observedAt:now+2,eventName:'PostCompact',sessionId:session,turnId:'compact-turn',trigger,generationSha256:summary.generationSha256,scopeKey:summary.scopeKey,revision:2}
 const native:any[]=[]
 if(trigger==='manual')native.push({id:7,method:'thread/compact/start',params:{threadId:session}},{id:7,result:{}})
 for(const [id,eventName,turnId,start,end] of [['post-run','postCompact','compact-turn',now,now+5],['ups-run','userPromptSubmit',turn,now+20,now+25]] as const){
  const run={id,eventName,handlerType:'command',scope:'turn',source:'user',sourcePath:path,startedAt:Math.floor(start/1000),status:'running',entries:[]}
  native.push({method:'hook/started',params:{threadId:session,turnId,run}})
  native.push({method:'hook/completed',params:{threadId:session,turnId,run:{...run,status:'completed',completedAt:Math.floor(end/1000),durationMs:end-start,entries:eventName==='userPromptSubmit'?[{kind:'context',text:'saved context body'}]:[]}}})
 }
 native.push({method:'item/completed',params:{threadId:session,turnId:'compact-turn',item:{type:'contextCompaction',id:'compact-item'}}})
 const rollout:any[]=[{type:'event_msg',payload:{thread_id:session}},{timestamp:new Date(now+30).toISOString(),type:'response_item',payload:{role:'developer',content:[{type:'input_text',text:'saved context body'}],internal_chat_message_metadata_passthrough:{turn_id:turn,content_item_kinds:['hooks.additional_context']}}}]
 const value:any={schemaVersion:1,trigger,sessionId:session,restoreTurnId:turn,postCompactRunId:'post-run',restoreRunId:'ups-run'}
 function build(){metadata.exportHash=hash(Object.fromEntries(Object.entries(metadata).filter(([k])=>k!=='exportHash')));const files=new Map();for(const [key,doc] of [['metadataExportSha256',metadata],['nativeNotificationsSha256',native],['rolloutSha256',rollout],['postCompactInputSha256',sidecar]] as const){const b=Buffer.from(JSON.stringify(doc));const h=createHash('sha256').update(b).digest('hex');value[key]=h;files.set(h,b)}return files}
 return {expected,metadata,summary,sidecar,native,rollout,value,build}
}
