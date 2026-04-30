import { describe, it, expect } from 'vitest'
import { formatHookOutput } from '../src/hook-output.js'

describe('formatHookOutput', () => {
  it('returns plain text for Claude Code (default)', () => {
    expect(formatHookOutput('hello', 'claude-code')).toBe('hello')
  })

  it('returns plain text for an unknown tool (forward-compatible default)', () => {
    expect(formatHookOutput('something', 'unknown-tool')).toBe('something')
  })

  it.each(['codex', 'gemini'])('wraps content as JSON for %s', (tool) => {
    const out = formatHookOutput('hello world', tool)
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'hello world',
      },
    })
  })

  it.each(['codex', 'gemini'])('%s output is pure JSON (no leading/trailing text)', (tool) => {
    const out = formatHookOutput('x', tool)
    expect(out.startsWith('{')).toBe(true)
    expect(out.endsWith('}')).toBe(true)
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it.each(['codex', 'gemini'])('escapes special characters in %s JSON output', (tool) => {
    const out = formatHookOutput('quotes "x" and\nnewline', tool)
    const parsed = JSON.parse(out)
    expect(parsed.hookSpecificOutput.additionalContext).toBe('quotes "x" and\nnewline')
  })

  it.each(['codex', 'gemini'])('handles empty content for %s', (tool) => {
    const out = formatHookOutput('', tool)
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '',
      },
    })
  })
})
