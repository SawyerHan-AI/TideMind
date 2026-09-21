import { describe, expect, it } from 'vitest'
import {
  formatWindsurfLifecycleHookOutput,
  parseWindsurfLifecycleHookMetadata,
} from '../src/hook-windsurf-protocol'

describe('Devin Desktop lifecycle Hook protocol', () => {
  it.each([
    ['SessionStart', 'source', 'startup'],
    ['SessionEnd', 'reason', 'user_exit'],
  ] as const)('retains only non-content metadata for %s', (event, field, reason) => {
    const secret = 'private prompt and response text'
    const parsed = parseWindsurfLifecycleHookMetadata(JSON.stringify({
      hook_event_name: event,
      session_id: 'session-1',
      [field]: reason,
      prompt: secret,
      response: secret,
    }), event)
    expect(parsed).toEqual({
      event,
      sessionId: 'session-1',
      lifecycleReason: reason,
    })
    expect(JSON.stringify(parsed)).not.toContain(secret)
    expect(JSON.stringify(parsed)).not.toContain('prompt')
    expect(JSON.stringify(parsed)).not.toContain('response')
  })

  it.each([
    ['not-json', 'SessionStart', 'windsurf_hook_input_not_json'],
    [JSON.stringify([]), 'SessionStart', 'windsurf_hook_input_not_object'],
    [JSON.stringify({ hook_event_name: 'SessionEnd' }), 'SessionStart', 'windsurf_hook_event_mismatch'],
    [JSON.stringify({ hook_event_name: 'SessionStart', session_id: '', source: 'startup' }), 'SessionStart', 'windsurf_hook_session_missing'],
    [JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's' }), 'SessionStart', 'windsurf_hook_source_missing'],
    [JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's' }), 'SessionEnd', 'windsurf_hook_reason_missing'],
  ] as const)('rejects malformed or mismatched input without fallback coercion', (source, event, error) => {
    expect(() => parseWindsurfLifecycleHookMetadata(source, event)).toThrow(error)
  })

  it('emits the documented strict JSON additional-context envelope only for SessionStart', () => {
    expect(JSON.parse(formatWindsurfLifecycleHookOutput('SessionStart', 'context'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'context',
      },
    })
    expect(JSON.parse(formatWindsurfLifecycleHookOutput('SessionEnd'))).toEqual({})
  })
})
