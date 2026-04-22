import { describe, it, expect } from 'vitest'
import {
  parseCodexVersion,
  compareSemver,
  meetsMinVersion,
  wrapSkillWithFrontmatter,
  CODEX_V2_MIN_VERSION,
} from '../../client/electron/ipc/codex-cli'

describe('parseCodexVersion', () => {
  it('parses "codex 0.121.4"', () => {
    expect(parseCodexVersion('codex 0.121.4')).toEqual({ major: 0, minor: 121, patch: 4 })
  })

  it('parses "codex version 0.120.0"', () => {
    expect(parseCodexVersion('codex version 0.120.0\n')).toEqual({ major: 0, minor: 120, patch: 0 })
  })

  it('parses bare "0.115.2"', () => {
    expect(parseCodexVersion('0.115.2')).toEqual({ major: 0, minor: 115, patch: 2 })
  })

  it('returns null for unparseable output', () => {
    expect(parseCodexVersion('command not found')).toBeNull()
    expect(parseCodexVersion('')).toBeNull()
  })
})

describe('compareSemver', () => {
  it('compares major/minor/patch in order', () => {
    expect(compareSemver({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 121, patch: 4 })).toBe(1)
    expect(compareSemver({ major: 0, minor: 121, patch: 4 }, { major: 0, minor: 121, patch: 4 })).toBe(0)
    expect(compareSemver({ major: 0, minor: 120, patch: 999 }, { major: 0, minor: 121, patch: 0 })).toBe(-1)
    expect(compareSemver({ major: 0, minor: 121, patch: 3 }, { major: 0, minor: 121, patch: 4 })).toBe(-1)
  })
})

describe('meetsMinVersion', () => {
  it('returns false for null', () => {
    expect(meetsMinVersion(null, CODEX_V2_MIN_VERSION)).toBe(false)
  })

  it('returns true when equal or newer', () => {
    expect(meetsMinVersion({ major: 0, minor: 121, patch: 0 }, CODEX_V2_MIN_VERSION)).toBe(true)
    expect(meetsMinVersion({ major: 0, minor: 122, patch: 5 }, CODEX_V2_MIN_VERSION)).toBe(true)
    expect(meetsMinVersion({ major: 1, minor: 0, patch: 0 }, CODEX_V2_MIN_VERSION)).toBe(true)
  })

  it('returns false when older', () => {
    expect(meetsMinVersion({ major: 0, minor: 120, patch: 99 }, CODEX_V2_MIN_VERSION)).toBe(false)
    expect(meetsMinVersion({ major: 0, minor: 115, patch: 0 }, CODEX_V2_MIN_VERSION)).toBe(false)
  })
})

describe('wrapSkillWithFrontmatter', () => {
  it('prepends frontmatter to plain body', () => {
    const out = wrapSkillWithFrontmatter('# Hello\n\nBody.', 'tidemind-eb_123', 'Test desc')
    expect(out.startsWith('---\nname: tidemind-eb_123\ndescription: "Test desc"\n---\n')).toBe(true)
    expect(out).toContain('# Hello')
    expect(out).toContain('Body.')
  })

  it('escapes description via JSON.stringify', () => {
    const out = wrapSkillWithFrontmatter('body', 'n', 'has "quotes" and\nnewline')
    expect(out).toContain('description: "has \\"quotes\\" and\\nnewline"')
  })

  it('strips existing frontmatter before re-wrapping', () => {
    const input = '---\nname: old\ndescription: "old"\n---\n\n# Real Body\n'
    const out = wrapSkillWithFrontmatter(input, 'new-name', 'new desc')
    expect(out).toContain('name: new-name')
    expect(out).not.toContain('name: old')
    expect(out).toContain('# Real Body')
    // 只有一对 frontmatter 分隔符（开头的两个 ---）
    const matches = out.match(/^---$/gm)
    expect(matches).toHaveLength(2)
  })
})
