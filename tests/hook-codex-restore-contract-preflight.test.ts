
import fs from 'node:fs'
import Ajv from 'ajv'
import {describe,it,expect} from 'vitest'
const load=(name:string)=>JSON.parse(fs.readFileSync(new URL('./fixtures/codex-rust-v0.157.1/'+name,import.meta.url),'utf8'))
const ajv=new Ajv()
describe('P0 official Codex 0.157.1 restore protocol',()=>{
 it('accepts the exact UPS input shape and requires session/turn/prompt',()=>{
  const validate=ajv.compile(load('user-prompt-submit.command.input.schema.json'))
  const input={session_id:'session-fixture',turn_id:'turn-fixture',cwd:'/fixture',model:'model-fixture',permission_mode:'default',prompt:'synthetic',transcript_path:null,hook_event_name:'UserPromptSubmit'}
  expect(validate(input)).toBe(true)
  for(const field of ['session_id','turn_id','prompt']){const missing={...input} as Record<string,unknown>;delete missing[field];expect(validate(missing)).toBe(false)}
  expect(validate({...input,hook_event_name:'PostCompact'})).toBe(false)
 })
 it('accepts UPS additionalContext and empty no-op, rejects a wrong event',()=>{
  const validate=ajv.compile(load('user-prompt-submit.command.output.schema.json'))
  expect(validate({})).toBe(true)
  expect(validate({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'synthetic saved context'}})).toBe(true)
  expect(validate({hookSpecificOutput:{hookEventName:'PostCompact',additionalContext:'wrong event'}})).toBe(false)
 })
 it('keeps PostCompact input distinct: trigger exists and prompt is absent',()=>{
  const schema=load('post-compact.command.input.schema.json')
  expect(schema.properties).not.toHaveProperty('prompt')
  const validate=ajv.compile(schema)
  const input={session_id:'session-fixture',turn_id:'turn-fixture',cwd:'/fixture',model:'model-fixture',trigger:'auto',transcript_path:null,hook_event_name:'PostCompact'}
  expect(validate(input)).toBe(true)
  expect(validate({...input,prompt:'not in this contract'})).toBe(false)
 })
})
