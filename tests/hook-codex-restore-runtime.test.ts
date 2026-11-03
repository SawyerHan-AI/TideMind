
import {PassThrough} from 'node:stream'
import {describe,it,expect} from 'vitest'
import {readCodexHookPayload,codexRestoreInput,CODEX_HOOK_INPUT_LIMIT,CODEX_HOOK_INPUT_TIMEOUT_MS} from '../src/hook-codex-restore-runtime'
describe('bounded Codex hook input',()=>{
 it('keeps full identifiers and selects only the expected event',async()=>{
  const stream=new PassThrough()
  const result=readCodexHookPayload(stream);stream.end(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'a/b ? session',turn_id:'turn-1',prompt:'ignored',transcript_path:'/ignored'}))
  expect(codexRestoreInput(await result,'UserPromptSubmit')).toEqual({sessionId:'a/b ? session',turnId:'turn-1'})
  expect(codexRestoreInput({hook_event_name:'PostCompact',session_id:'s',turn_id:'t'},'UserPromptSubmit')).toBeNull()
  expect(codexRestoreInput({hook_event_name:'PostCompact',session_id:'s'},'PostCompact')).toBeNull()
  expect(codexRestoreInput({hook_event_name:'SessionStart',session_id:'s'},'SessionStart')).toEqual({sessionId:'s',turnId:''})
 })
 it('stops an open pipe on the bounded timer and detaches only its own listeners',async()=>{
  expect(CODEX_HOOK_INPUT_TIMEOUT_MS).toBe(2000)
  const stream=new PassThrough();const other=()=>{}
  stream.on('error',other)
  const result=readCodexHookPayload(stream,15)
  stream.write('{"incomplete":')
  expect(await result).toBeNull()
  expect(stream.listenerCount('data')).toBe(0)
  expect(stream.listeners('error')).toEqual([other])
  stream.destroy()
 })
 it('rejects oversized or non-object input without using truncated identifiers',async()=>{
  for(const input of ['x'.repeat(CODEX_HOOK_INPUT_LIMIT+1),'[]','null']){
   const stream=new PassThrough();const result=readCodexHookPayload(stream);stream.end(input)
   expect(await result).toBeNull();stream.destroy()
  }
 })
})
