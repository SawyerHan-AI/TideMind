import { describe, it, expect } from 'vitest'
import {
  parseGeminiVersion,
  stripFrontmatter,
  GEMINI_MIN_VERSION,
} from '../../client/electron/ipc/gemini-cli'
import { meetsMinVersion } from '../../client/electron/ipc/_semver'

describe('parseGeminiVersion', () => {
  it('parses "gemini 0.26.1"', () => {
    expect(parseGeminiVersion('gemini 0.26.1')).toEqual({ major: 0, minor: 26, patch: 1 })
  })

  it('parses "gemini-cli version 0.30.0"', () => {
    expect(parseGeminiVersion('gemini-cli version 0.30.0\n')).toEqual({ major: 0, minor: 30, patch: 0 })
  })

  it('parses bare "1.0.0"', () => {
    expect(parseGeminiVersion('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 })
  })

  it('returns null for unparseable output', () => {
    expect(parseGeminiVersion('command not found')).toBeNull()
    expect(parseGeminiVersion('')).toBeNull()
  })
})

describe('GEMINI_MIN_VERSION + meetsMinVersion', () => {
  it('GEMINI_MIN_VERSION is 0.26.0 (hooks default-on)', () => {
    expect(GEMINI_MIN_VERSION).toEqual({ major: 0, minor: 26, patch: 0 })
  })

  it('returns false when CLI version is missing', () => {
    expect(meetsMinVersion(null, GEMINI_MIN_VERSION)).toBe(false)
  })

  it('returns true at or above 0.26.0', () => {
    expect(meetsMinVersion({ major: 0, minor: 26, patch: 0 }, GEMINI_MIN_VERSION)).toBe(true)
    expect(meetsMinVersion({ major: 0, minor: 26, patch: 5 }, GEMINI_MIN_VERSION)).toBe(true)
    expect(meetsMinVersion({ major: 0, minor: 30, patch: 0 }, GEMINI_MIN_VERSION)).toBe(true)
    expect(meetsMinVersion({ major: 1, minor: 0, patch: 0 }, GEMINI_MIN_VERSION)).toBe(true)
  })

  it('returns false below 0.26.0', () => {
    expect(meetsMinVersion({ major: 0, minor: 25, patch: 99 }, GEMINI_MIN_VERSION)).toBe(false)
    expect(meetsMinVersion({ major: 0, minor: 0, patch: 1 }, GEMINI_MIN_VERSION)).toBe(false)
  })
})

describe('stripFrontmatter', () => {
  it('returns body unchanged when there is no frontmatter', () => {
    expect(stripFrontmatter('# Hello\n\nNo frontmatter here.\n')).toBe('# Hello\n\nNo frontmatter here.\n')
  })

  it('strips standard YAML frontmatter and the leading newline', () => {
    const input = '---\nname: foo\ndescription: bar\n---\n# Real Body\n\nContent.'
    expect(stripFrontmatter(input)).toBe('# Real Body\n\nContent.')
  })

  it('handles frontmatter with no trailing newline before body', () => {
    const input = '---\nname: foo\n---Body without newline'
    expect(stripFrontmatter(input)).toBe('Body without newline')
  })

  it('returns original when --- appears but no closing --- exists', () => {
    const input = '---\nincomplete frontmatter\nno close marker'
    expect(stripFrontmatter(input)).toBe(input)
  })

  it('preserves frontmatter-like content if it does not start at column 0', () => {
    const input = '\n---\nfake: yaml\n---\nbody'
    expect(stripFrontmatter(input)).toBe(input)
  })
})
