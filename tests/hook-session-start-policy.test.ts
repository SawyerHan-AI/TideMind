import { describe, expect, it } from 'vitest'
import { shouldRecordSessionStartActivity } from '../src/hook-session-start-policy.js'

describe('hook session-start activity policy', () => {
  it('blocks a legacy Kimi per-session injection without exact Skill proof', () => {
    expect(shouldRecordSessionStartActivity({
      tool: 'kimi-code',
      oncePerSession: true,
      suppressSessionStartActivity: false,
      exactSkillGenerationLoaded: false,
    })).toBe(false)
  })

  it('also honors explicit suppression on the 0.2.92 injection', () => {
    expect(shouldRecordSessionStartActivity({
      tool: 'kimi-code',
      oncePerSession: true,
      suppressSessionStartActivity: true,
      exactSkillGenerationLoaded: true,
    })).toBe(false)
  })

  it('enables evidence only after a non-Kimi hook loads the exact Skill', () => {
    expect(shouldRecordSessionStartActivity({
      tool: 'claude-code',
      oncePerSession: false,
      suppressSessionStartActivity: false,
      exactSkillGenerationLoaded: true,
    })).toBe(true)
  })

  it('never lets a Kimi UserPromptSubmit injection impersonate SessionStart', () => {
    expect(shouldRecordSessionStartActivity({
      tool: 'kimi-code',
      oncePerSession: true,
      suppressSessionStartActivity: false,
      exactSkillGenerationLoaded: true,
    })).toBe(false)
  })
})
