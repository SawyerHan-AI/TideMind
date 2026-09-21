import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  protectedRealAgentPaths,
  runWithRealHomeGuard,
} from '../../scripts/agent-integration-ui-e2e-home-guard.mjs'

describe('isolated Electron UI E2E real HOME guard', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function target(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-home-guard-'))
    roots.push(root)
    return path.join(root, '.zcode', 'skills', 'tidemind')
  }

  function mutatingScript(targetPath: string, outcome: 'success' | 'failure' | 'timeout'): string {
    const tail = outcome === 'failure'
      ? 'process.exit(7)'
      : outcome === 'timeout' ? 'setInterval(() => {}, 1000)' : ''
    return `require('node:fs').mkdirSync(${JSON.stringify(targetPath)}, { recursive: true });${tail}`
  }

  function chmodScript(targetPath: string, outcome: 'success' | 'failure' | 'timeout'): string {
    const tail = outcome === 'failure'
      ? 'process.exit(7)'
      : outcome === 'timeout' ? 'setInterval(() => {}, 1000)' : ''
    return `require('node:fs').chmodSync(${JSON.stringify(targetPath)}, 0o644);${tail}`
  }

  for (const outcome of ['success', 'failure', 'timeout'] as const) {
    it(`checks fingerprints after a child ${outcome}`, () => {
      const protectedPath = target()
      expect(() => runWithRealHomeGuard({
        command: process.execPath,
        args: ['-e', mutatingScript(protectedPath, outcome)],
        protectedPaths: [protectedPath],
        // A 100ms timeout can expire before Node executes the mutation on a
        // loaded release machine, which tests "child never started" instead
        // of the intended "child mutated and was then timed out" path.
        timeoutMs: 2_000,
        stdio: 'ignore',
      })).toThrow(/changed real Agent configuration/)
    })

    it(`checks mode fingerprints after a child ${outcome}`, () => {
      const protectedPath = target()
      fs.mkdirSync(path.dirname(protectedPath), { recursive: true })
      fs.writeFileSync(protectedPath, '{}', { mode: 0o600 })
      expect(() => runWithRealHomeGuard({
        command: process.execPath,
        args: ['-e', chmodScript(protectedPath, outcome)],
        protectedPaths: [protectedPath],
        timeoutMs: 2_000,
        stdio: 'ignore',
      })).toThrow(/changed real Agent configuration/)
    })
  }

  it('covers every P0 UI flow actual production target exercised by the isolated audit', () => {
    const paths = protectedRealAgentPaths('/Users/test')
    expect(paths).toEqual(expect.arrayContaining([
      '/Users/test/.agents/skills/tidemind',
      '/Users/test/.qwenworkcn/skills/tidemind',
      '/Users/test/.qwenworkcn/settings.json',
      '/Users/test/.kimi-code/skills/tidemind',
      '/Users/test/.kimi-code/mcp.json',
      '/Users/test/.kimi-code/config.toml',
      '/Users/test/.codex/config.toml',
      '/Users/test/.codex/hooks.json',
      '/Users/test/.cursor/skills/tidemind',
      '/Users/test/.cursor/mcp.json',
      '/Users/test/.cursor/hooks.json',
      '/Users/test/.config/opencode/opencode.json',
      '/Users/test/.config/opencode/opencode.jsonc',
      '/Users/test/.config/opencode/plugins/tidemind-v1.ts',
      '/Users/test/.config/opencode/plugins/tidemind-v2.ts',
      '/Users/test/.tidemind/ui-audit-custom-client/config.json',
    ]))
    expect(paths).toContain('/Users/test/.zcode/skills/tidemind')
    expect(paths).toContain('/Users/test/.zcode/cli/config.json')
    expect(paths).toContain('/Users/test/.zcode-default/config.json')
    expect(paths).toContain('/Users/test/Library/Application Support/Claude/claude_desktop_config.json')
    expect(paths).toContain('/Users/test/Library/Application Support/Claude/plugins')
    expect(paths).toContain('/Users/test/Library/Application Support/Claude/cowork')
    expect(paths).toContain('/Users/test/.claude/plugins')
    expect(paths).toContain('/Users/test/.claude/cowork')
    expect(paths).toContain('/Users/test/Library/Application Support/Tide Mind/agent-integration/claude-cowork')
  })
})
