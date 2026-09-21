import { describe, expect, it } from 'vitest'
import {
  formatQwenWorkLifecycleHookOutput,
  parseQwenWorkLifecycleHookMetadata,
} from '../src/hook-qwenwork-protocol'

describe('QwenWork lifecycle Hook protocol', () => {
  it.each([
    ['SessionStart', 'source', 'compact'],
    ['PreCompact', 'trigger', 'auto'],
    ['SessionEnd', 'reason', 'logout'],
  ] as const)('retains only lifecycle identity metadata for %s', (event, field, reason) => {
    const secret = 'private prompt and response text'
    const parsed = parseQwenWorkLifecycleHookMetadata(JSON.stringify({
      hook_event_name: event,
      session_id: 'session-1',
      [field]: reason,
      prompt: secret,
      transcript_path: '/private/conversation.jsonl',
      custom_instructions: secret,
    }), event)
    expect(parsed).toEqual({ event, sessionId: 'session-1', lifecycleReason: reason })
    expect(JSON.stringify(parsed)).not.toContain(secret)
    expect(JSON.stringify(parsed)).not.toContain('transcript')
  })

  it.each([
    ['not-json', 'SessionStart', 'qwenwork_hook_input_not_json'],
    [JSON.stringify([]), 'SessionStart', 'qwenwork_hook_input_not_object'],
    [JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's', reason: 'logout' }), 'SessionStart', 'qwenwork_hook_event_mismatch'],
    [JSON.stringify({ hook_event_name: 'SessionStart', session_id: '', source: 'startup' }), 'SessionStart', 'qwenwork_hook_session_missing'],
    [JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's' }), 'SessionStart', 'qwenwork_hook_source_missing'],
    [JSON.stringify({ hook_event_name: 'PreCompact', session_id: 's' }), 'PreCompact', 'qwenwork_hook_trigger_missing'],
    [JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's' }), 'SessionEnd', 'qwenwork_hook_reason_missing'],
  ] as const)('rejects malformed or mismatched input', (source, event, error) => {
    expect(() => parseQwenWorkLifecycleHookMetadata(source, event)).toThrow(error)
  })

  it('emits the documented strict JSON context envelope for start and pre-compact', () => {
    expect(JSON.parse(formatQwenWorkLifecycleHookOutput('SessionStart', 'prepared context'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'prepared context',
      },
    })
    expect(JSON.parse(formatQwenWorkLifecycleHookOutput('PreCompact', 'compact context'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext: 'compact context',
      },
    })
    expect(JSON.parse(formatQwenWorkLifecycleHookOutput('SessionEnd'))).toEqual({})
    expect(JSON.parse(formatQwenWorkLifecycleHookOutput('SessionEnd', 'must not be injected'))).toEqual({})
  })
})
