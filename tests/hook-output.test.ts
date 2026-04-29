import { describe, it, expect } from 'vitest'
import { formatHookOutput } from '../src/hook-output.js'

describe('formatHookOutput', () => {
  it('returns plain text for Claude Code (default)', () => {
    expect(formatHookOutput('hello', 'claude-code')).toBe('hello')
  })

  it('returns plain text for Codex (also pass-through)', () => {
    expect(formatHookOutput('codex content', 'codex')).toBe('codex content')
  })

  it('returns plain text for an unknown tool (forward-compatible default)', () => {
    expect(formatHookOutput('something', 'unknown-tool')).toBe('something')
  })

  it('wraps content as JSON for Gemini CLI', () => {
    const out = formatHookOutput('hello world', 'gemini')
    const parsed = JSON.parse(out)
    expect(parsed).toEqual({ hookSpecificOutput: { additionalContext: 'hello world' } })
  })

  it('Gemini output is pure JSON (no leading/trailing text)', () => {
    const out = formatHookOutput('x', 'gemini')
    expect(out.startsWith('{')).toBe(true)
    expect(out.endsWith('}')).toBe(true)
    // Round-trip parse should not throw
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('escapes special characters in Gemini JSON output', () => {
    const out = formatHookOutput('quotes "x" and\nnewline', 'gemini')
    const parsed = JSON.parse(out)
    expect(parsed.hookSpecificOutput.additionalContext).toBe('quotes "x" and\nnewline')
  })

  it('handles empty content for Gemini', () => {
    const out = formatHookOutput('', 'gemini')
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { additionalContext: '' } })
  })
})
