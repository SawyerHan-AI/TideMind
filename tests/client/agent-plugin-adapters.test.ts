import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { coworkAdapter } from '../../client/electron/ipc/agent-plugins/cowork'
import { codexAdapter } from '../../client/electron/ipc/agent-plugins/codex'
import { cursorAdapter } from '../../client/electron/ipc/agent-plugins/cursor'
import { kimiCodeAdapter } from '../../client/electron/ipc/agent-plugins/kimi-code'
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

describe('kimi-code agent plugin adapter', () => {
  let tmpDir: string
  let runtime: PluginRuntimeContext
  let ctx: GeneratePluginContext

  const mcpPath = () => path.join(runtime.homeDir, '.kimi-code', 'mcp.json')
  const configPath = () => path.join(runtime.homeDir, '.kimi-code', 'config.toml')
  const skillDir = () => path.join(runtime.homeDir, '.kimi-code', 'skills', `tidemind-${AGENT_ID}`)
  const skillFilePath = () => path.join(skillDir(), 'SKILL.md')

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-kimi-'))
    runtime = makeRuntime(tmpDir)
    ctx = makeContext(runtime, 'kimi-code')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('generates mcp.json, SKILL.md and config.toml hook; reports status; uninstalls cleanly', async () => {
    const generated = await kimiCodeAdapter.generate(ctx)
    expect(generated.success).toBe(true)
    expect(generated.pluginName).toBe(`tidemind-${AGENT_ID}`)
    expect(generated.pluginDir).toBe(skillDir())

    // 1) ~/.kimi-code/mcp.json
    const mcp = readJson(mcpPath())
    expect(mcp.mcpServers[`tidemind-${AGENT_ID}`]).toEqual({
      command: runtime.shimPath,
      args: [runtime.mcpServerPath],
      env: { EB_AGENT_ID: AGENT_ID },
    })

    // 2) ~/.kimi-code/skills/tidemind-<agentId>/SKILL.md(带 frontmatter)
    const skill = fs.readFileSync(skillFilePath(), 'utf-8')
    expect(skill).toContain(`name: tidemind-${AGENT_ID}`)
    expect(skill).toContain('Use memory well.')

    // 3) ~/.kimi-code/config.toml 的 [[hooks]]
    // UserPromptSubmit(实测 SessionStart 输出不被 Kimi 注入);无 matcher(match all);
    // timeout 30;command 含 --once-per-session(拼在 --tool 之后,每会话只注入一次)
    const tomlContent = fs.readFileSync(configPath(), 'utf-8')
    expect(tomlContent).toContain('[[hooks]]')
    expect(tomlContent).toContain('event = "UserPromptSubmit"')
    expect(tomlContent).not.toContain('matcher')
    expect(tomlContent).toContain('timeout = 30')
    const parsed = parseToml(tomlContent) as any
    expect(parsed.hooks).toHaveLength(1)
    const cmd = parsed.hooks[0].command as string
    expect(parsed.hooks[0].event).toBe('UserPromptSubmit')
    expect(parsed.hooks[0].timeout).toBe(30)
    expect('matcher' in parsed.hooks[0]).toBe(false)
    expect(cmd.startsWith(`${JSON.stringify(runtime.shimPath)} ${JSON.stringify(runtime.hookScriptPath)}`)).toBe(true)
    expect(cmd).toContain(`--agent-id "${AGENT_ID}"`)
    expect(cmd).toContain(`--skill-path "${skillFilePath()}"`)
    expect(cmd).toContain('--tool "kimi-code" --once-per-session')

    expect(kimiCodeAdapter.getPath(ctx)).toBe(skillDir())

    const status = await kimiCodeAdapter.getStatus(ctx)
    expect(status.exists).toBe(true)
    expect(status.kimiConfigWritten).toBe(true)
    expect(status.hooksConfigured).toBe(true)
    expect(status.skillDirWritten).toBe(true)

    const result = await kimiCodeAdapter.uninstall(ctx)
    expect(result.success).toBe(true)
    expect(readJson(mcpPath()).mcpServers).toBeUndefined()
    expect(fs.readFileSync(configPath(), 'utf-8')).not.toContain('[[hooks]]')
    expect(fs.existsSync(skillDir())).toBe(false)
    expect(kimiCodeAdapter.getPath(ctx)).toBeNull()
  })

  it('does not duplicate the [[hooks]] entry on repeated generate', async () => {
    await kimiCodeAdapter.generate(ctx)
    await kimiCodeAdapter.generate(ctx)

    const parsed = parseToml(fs.readFileSync(configPath(), 'utf-8')) as any
    expect(parsed.hooks).toHaveLength(1)
  })

  it('preserves existing user content in mcp.json and config.toml', async () => {
    fs.mkdirSync(path.dirname(mcpPath()), { recursive: true })
    fs.writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { 'user-tool': { command: '/usr/local/bin/tool' } } }))
    fs.writeFileSync(configPath(), 'model = "k2"\n')

    await kimiCodeAdapter.generate(ctx)

    const mcp = readJson(mcpPath())
    expect(mcp.mcpServers['user-tool']).toEqual({ command: '/usr/local/bin/tool' })
    expect(mcp.mcpServers[`tidemind-${AGENT_ID}`]).toBeDefined()
    const tomlContent = fs.readFileSync(configPath(), 'utf-8')
    expect(tomlContent).toContain('model = "k2"')
  })

  // Regression: malformed ~/.kimi-code/mcp.json must not be silently overwritten
  // with `{}` — that would erase any other MCP servers the user has set up.
  it('refuses to clobber a malformed ~/.kimi-code/mcp.json and writes a backup', async () => {
    fs.mkdirSync(path.dirname(mcpPath()), { recursive: true })
    const original = '{ "mcpServers": { "user-tool": { "command": "/usr/local/bin/tool" } broken'
    fs.writeFileSync(mcpPath(), original)

    await expect(kimiCodeAdapter.generate(ctx)).rejects.toThrow(/Refused to overwrite/)
    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe(original)
    const baks = fs.readdirSync(path.dirname(mcpPath()))
      .filter(n => n.startsWith('mcp.json.tidemind-backup-') && n.endsWith('.bak'))
    expect(baks).toHaveLength(1)
  })

  it('honors KIMI_CODE_HOME as the config root for generate / getStatus / uninstall', async () => {
    const kimiHome = path.join(tmpDir, 'custom-kimi-home')
    process.env.KIMI_CODE_HOME = kimiHome
    try {
      const generated = await kimiCodeAdapter.generate(ctx)
      expect(generated.success).toBe(true)

      // 三件套全部落在 KIMI_CODE_HOME 下,默认 ~/.kimi-code 不出现
      const envMcp = path.join(kimiHome, 'mcp.json')
      const envConfig = path.join(kimiHome, 'config.toml')
      const envSkillDir = path.join(kimiHome, 'skills', `tidemind-${AGENT_ID}`)
      expect(readJson(envMcp).mcpServers[`tidemind-${AGENT_ID}`]).toBeDefined()
      expect(fs.readFileSync(envConfig, 'utf-8')).toContain('event = "UserPromptSubmit"')
      expect(fs.existsSync(path.join(envSkillDir, 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(runtime.homeDir, '.kimi-code'))).toBe(false)

      expect(kimiCodeAdapter.getPath(ctx)).toBe(envSkillDir)
      const status = await kimiCodeAdapter.getStatus(ctx)
      expect(status.kimiConfigWritten).toBe(true)
      expect(status.hooksConfigured).toBe(true)
      expect(status.skillDirWritten).toBe(true)

      const result = await kimiCodeAdapter.uninstall(ctx)
      expect(result.success).toBe(true)
      expect(fs.existsSync(envSkillDir)).toBe(false)
      expect(fs.readFileSync(envConfig, 'utf-8')).not.toContain('[[hooks]]')
    } finally {
      delete process.env.KIMI_CODE_HOME
    }
  })
})
