import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

function readProjectFile(...parts: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf-8')
}

describe('agent plugin IPC boundary', () => {
  it('keeps plugin-generator as a thin dispatch layer', () => {
    const source = readProjectFile('client', 'electron', 'ipc', 'plugin-generator.ts')
    const lines = source.trim().split(/\r?\n/)

    expect(lines.length).toBeLessThan(180)
    expect(source).toContain('getAgentPluginAdapter')
    expect(source).toContain('createPluginRuntimeContext')
    expect(source).not.toContain('clientType ===')
    expect(source).not.toContain('writeFileAtomic')
    expect(source).not.toContain('readJsonSafe')
    expect(source).not.toContain('fs.rmSync')
    expect(source).not.toContain('codexMcpAdd')
    expect(source).not.toContain('geminiExtensionInstall')
  })

  it('registers every supported client type in the adapter registry', () => {
    const source = readProjectFile('client', 'electron', 'ipc', 'agent-plugins', 'registry.ts')

    for (const clientType of ['claude-code', 'cowork', 'cursor', 'codex', 'windsurf', 'openclaw', 'gemini']) {
      expect(source).toContain(clientType)
    }
  })
})
