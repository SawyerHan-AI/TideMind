import { describe, expect, it } from 'vitest'
import {
  formatCursorLifecycleHookOutput,
  parseCursorLifecycleHookPayload,
} from '../src/hook-cursor-protocol'

describe('Cursor lifecycle hook protocol', () => {
  it.each(['sessionStart', 'sessionEnd'] as const)(
    'binds %s to the official session and conversation identity',
    event => {
      expect(parseCursorLifecycleHookPayload(JSON.stringify({
        hook_event_name: event,
        conversation_id: 'conversation-1',
        session_id: 'conversation-1',
        cursor_version: '2.1.0',
      }), event)).toMatchObject({ hook_event_name: event, conversation_id: 'conversation-1' })
      expect(() => parseCursorLifecycleHookPayload(JSON.stringify({
        hook_event_name: event,
        conversation_id: 'conversation-1',
        session_id: 'different-session',
        cursor_version: '2.1.0',
      }), event)).toThrow(/session_identity_mismatch/)
    },
  )

  it('accepts preCompact without manufacturing a session id', () => {
    expect(parseCursorLifecycleHookPayload(JSON.stringify({
      hook_event_name: 'preCompact',
      conversation_id: 'conversation-1',
      cursor_version: '2.1.0',
      compact_count: 2,
    }), 'preCompact')).toMatchObject({ hook_event_name: 'preCompact' })
  })

  it.each([
    ['not-json', 'cursor_hook_input_not_json'],
    [JSON.stringify([]), 'cursor_hook_input_not_object'],
    [JSON.stringify({ hook_event_name: 'sessionEnd', conversation_id: 'c', session_id: 'c', cursor_version: '2' }), 'cursor_hook_event_mismatch'],
    [JSON.stringify({ hook_event_name: 'preCompact', conversation_id: '', cursor_version: '2' }), 'cursor_hook_conversation_missing'],
    [JSON.stringify({ hook_event_name: 'preCompact', conversation_id: 'c', cursor_version: '' }), 'cursor_hook_version_missing'],
  ])('rejects malformed or mismatched input', (source, error) => {
    expect(() => parseCursorLifecycleHookPayload(source, 'preCompact')).toThrow(error)
  })

  it('emits exactly one valid JSON stdout document for each event', () => {
    expect(JSON.parse(formatCursorLifecycleHookOutput('sessionStart', 'context')))
      .toEqual({ additional_context: 'context' })
    expect(formatCursorLifecycleHookOutput('sessionStart', 'context').trimStart().startsWith('{')).toBe(true)
    expect(JSON.parse(formatCursorLifecycleHookOutput('preCompact'))).toEqual({})
    expect(JSON.parse(formatCursorLifecycleHookOutput('sessionEnd'))).toEqual({})
  })
})
