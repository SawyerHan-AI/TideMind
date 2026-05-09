import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { coworkAdapter } from '../../client/electron/ipc/agent-plugins/cowork'
import { codexAdapter } from '../../client/electron/ipc/agent-plugins/codex'
import { cursorAdapter } from '../../client/electron/ipc/agent-plugins/cursor'
import { openclawAdapter } from '../../client/electron/ipc/agent-plugins/openclaw'
import type {
  GeneratePluginContext,
  PluginClientType,
  PluginRuntimeContext,
} from '../../client/electron/ipc/agent-plugins/types'
import { CLIENT_CONFIG } from '../../client/electron/ipc/agent-plugins/types'
import { windsurfAdapter } from '../../client/electron/ipc/agent-plugins/windsurf'

const AGENT_ID = 'eb_1234abcd'

function makeRuntime(tmpDir: string): PluginRuntimeContext {
  return {
    dataDir: path.join(tmpDir, 'data'),
    pluginsDir: path.join(tmpDir, 'data', 'plugins'),
    skillDir: path.join(tmpDir, 'data', 'skill'),
    shimPath: path.join(tmpDir, 'bin', 'tm-node'),
    mcpServerPath: path.join(tmpDir, 'out', 'bin', 'mcp-server.cjs'),
    hookScriptPath: path.join(tmpDir, 'out', 'bin', 'hook-session-start.cjs'),
    preCompactScriptPath: path.join(tmpDir, 'out', 'bin', 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(tmpDir, 'out', 'bin', 'hook-post-compact.cjs'),
    homeDir: path.join(tmpDir, 'home'),
  }
}

function makeContext(runtime: PluginRuntimeContext, clientType: PluginClientType): GeneratePluginContext {
  const config = CLIENT_CONFIG[clientType]
  return {
    runtime,
    agentId: AGENT_ID,
    agentName: 'Research Agent',
    clientType,
    config,
    pluginName: `tidemind-${AGENT_ID}`,
    pluginDirName: `${config.dirPrefix}-${AGENT_ID}`,
    pluginDir: path.join(runtime.pluginsDir, `${config.dirPrefix}-${AGENT_ID}`),
    skillContent: '# Skill\n\nUse memory well.',
  }
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

describe('simple agent plugin adapters', () => {
  let tmpDir: string
  let runtime: PluginRuntimeContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-adapters-'))
    runtime = makeRuntime(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each([
    {
      adapter: coworkAdapter,
      clientType: 'cowork' as const,
      configPath: (home: string) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      outputPath: (home: string) => path.join(home, 'Downloads', `tidemind-skill-${AGENT_ID}.md`),
      statusKey: 'desktopConfigWritten',
    },
    {
      adapter: cursorAdapter,
      clientType: 'cursor' as const,
      configPath: (home: string) => path.join(home, '.cursor', 'mcp.json'),
      outputPath: (home: string) => path.join(home, 'Downloads', `tidemind-cursor-${AGENT_ID}.mdc`),
      statusKey: 'cursorConfigWritten',
    },
    {
      adapter: windsurfAdapter,
      clientType: 'windsurf' as const,
      configPath: (home: string) => path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      outputPath: (home: string) => path.join(home, 'Downloads', `tidemind-windsurf-${AGENT_ID}.md`),
      statusKey: 'windsurfConfigWritten',
    },
  ])('generates, reports, and uninstalls $clientType artifacts', async ({ adapter, clientType, configPath, outputPath, statusKey }) => {
    const ctx = makeContext(runtime, clientType)

    const generated = await adapter.generate(ctx)
    expect(generated.success).toBe(true)
    expect(generated.pluginName).toBe(`tidemind-${AGENT_ID}`)

    const cfg = readJson(configPath(runtime.homeDir))
    expect(cfg.mcpServers[`tidemind-${AGENT_ID}`]).toEqual({
      command: runtime.shimPath,
      args: [runtime.mcpServerPath],
      env: { EB_AGENT_ID: AGENT_ID },
    })
    expect(fs.readFileSync(outputPath(runtime.homeDir), 'utf-8')).toContain('Use memory well.')
    expect(adapter.getPath(ctx)).toBe(outputPath(runtime.homeDir))

    const status = await adapter.getStatus(ctx)
    expect(status.exists).toBe(true)
    expect(status[statusKey]).toBe(true)
    expect(status.skillOutputExists).toBe(true)

    await adapter.uninstall(ctx)
    expect(readJson(configPath(runtime.homeDir)).mcpServers).toBeUndefined()
    expect(fs.existsSync(outputPath(runtime.homeDir))).toBe(false)
  })

  // Regression: if the user's third-party config file (claude_desktop_config /
  // cursor mcp.json / windsurf mcp_config) exists but is malformed JSON, the
  // adapter must NOT silently rewrite it as `{}` (clobbering all the user's
  // other MCP servers / preferences). It must throw and leave a .bak.
  it('refuses to clobber a malformed cursor mcp.json and writes a backup', async () => {
    const ctx = makeContext(runtime, 'cursor')
    const cfgPath = path.join(runtime.homeDir, '.cursor', 'mcp.json')
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    const original = '{ "mcpServers": { "user-tool": { "command": "/usr/local/bin/tool" } broken'
    fs.writeFileSync(cfgPath, original)

    await expect(cursorAdapter.generate(ctx)).rejects.toThrow(/Refused to overwrite/)

    // Original file untouched
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(original)
    // Backup sibling exists with original content
    const baks = fs.readdirSync(path.dirname(cfgPath))
      .filter(n => n.startsWith('mcp.json.tidemind-backup-') && n.endsWith('.bak'))
    expect(baks.length).toBe(1)
    expect(fs.readFileSync(path.join(path.dirname(cfgPath), baks[0]), 'utf-8')).toBe(original)
  })
})

describe('openclaw agent plugin adapter', () => {
  let tmpDir: string
  let runtime: PluginRuntimeContext
  let ctx: GeneratePluginContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-openclaw-'))
    runtime = makeRuntime(tmpDir)
    ctx = makeContext(runtime, 'openclaw')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('generates config, bootstrap hook, skill output, and can uninstall them', async () => {
    const generated = await openclawAdapter.generate(ctx)
    const configPath = path.join(runtime.homeDir, '.openclaw', 'openclaw.json')
    const hookPath = path.join(runtime.homeDir, '.openclaw', 'hooks', `tidemind-${AGENT_ID}`, 'handler.ts')
    const skillPath = path.join(runtime.homeDir, 'Downloads', `tidemind-openclaw-${AGENT_ID}`, 'SKILL.md')

    expect(generated.success).toBe(true)
    expect(readJson(configPath).mcp.servers[`tidemind-${AGENT_ID}`].command).toBe(runtime.shimPath)
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain(`const AGENT_ID = "${AGENT_ID}"`)
    expect(fs.readFileSync(skillPath, 'utf-8')).toContain('Use memory well.')
    expect(openclawAdapter.getPath(ctx)).toBe(skillPath)

    const status = await openclawAdapter.getStatus(ctx)
    expect(status.exists).toBe(true)
    expect(status.openclawConfigWritten).toBe(true)
    expect(status.hooksConfigured).toBe(true)

    await openclawAdapter.uninstall(ctx)
    expect(readJson(configPath).mcp.servers).toBeUndefined()
    expect(fs.existsSync(hookPath)).toBe(false)
    expect(fs.existsSync(skillPath)).toBe(false)
  })

  // Regression: malformed openclaw.json must not be silently overwritten with
  // `{}` — that would erase any other MCP servers / config the user has set up.
  it('refuses to clobber a malformed ~/.openclaw/openclaw.json and writes a backup', async () => {
    const configPath = path.join(runtime.homeDir, '.openclaw', 'openclaw.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const original = '{"mcp": {"servers": {"foo": {"command": "broken'
    fs.writeFileSync(configPath, original)

    await expect(openclawAdapter.generate(ctx)).rejects.toThrow(/Refused to overwrite/)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original)
    const baks = fs.readdirSync(path.dirname(configPath))
      .filter(n => n.startsWith('openclaw.json.tidemind-backup-') && n.endsWith('.bak'))
    expect(baks.length).toBe(1)
  })
})

describe('codex agent plugin adapter', () => {
  let tmpDir: string
  let runtime: PluginRuntimeContext
  let ctx: GeneratePluginContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-codex-'))
    runtime = makeRuntime(tmpDir)
    ctx = makeContext(runtime, 'codex')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports native Codex skill directory as generated path', () => {
    const skillDir = path.join(runtime.homeDir, '.codex', 'skills', `tidemind-${AGENT_ID}`)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill')

    expect(codexAdapter.getPath(ctx)).toBe(skillDir)
  })
})
