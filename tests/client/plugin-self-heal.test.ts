/**
 * tests/client/plugin-self-heal.test.ts
 *
 * 覆盖 client/electron/runtime/plugin-self-heal.ts 的"非 SKILL.md frontmatter"
 * 分支(SKILL.md 部分已在 plugin-self-heal-cache.test.ts 测过)。
 *
 * 重点覆盖:
 *   - selfHealPlugins 顶层入口:多个外部配置源同时存在时的整体行为
 *   - healClaudeCodePlugins:
 *       .mcp.json patch + cleanup legacy 'external-brain' key
 *       hooks.json SessionStart 路径过期 patch
 *       hooks.json PreCompact 老 echo → 脚本形态升级
 *       hooks.json PreCompact 缺 --tool 重建
 *       hooks.json PostCompact 缺段补齐
 *       hooks.json PostCompact 路径过期 patch
 *   - healMcpServersFile (Cursor/Windsurf/Cowork):
 *       cleanup legacy external-brain-* keys
 *       patch tidemind-* 已有条目
 *       重建丢失的 expectedAgentIds 条目
 *       缺 mcpServers 字段但 expectedAgentIds 非空 → 创建
 *   - healOpenclawConfig: 嵌套 mcp.servers 结构
 *   - healCodexHooks: codex hooks.json 路径过期
 *   - healCodexTomlConfig: TOML 段落清理 + 路径替换
 *   - healLocalMarketplace: 本地 marketplace.json 修复
 *   - healClaudeSettings: settings.json extraKnownMarketplaces 清理
 *   - 错误兜底:malformed JSON/无文件/权限错都不抛
 *
 * Mock 策略:
 *   - electron + client/node_modules/electron/index.js 双 mock,提供 app
 *   - @server/db/agents.js mock listAgents,提供 expectedAgentIds
 *   - runtime-paths mock,提供稳定的 shim/script 路径
 *   - @server/utils/marketplace-repair.js 不 mock,用真实实现(纯函数,易测)
 *   - os.homedir 通过 vi.spyOn 切到 tmp 目录,避免污染用户主目录
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'

// ---------------------------------------------------------------------------
// Mock electron (双路径)
// ---------------------------------------------------------------------------

const electronMock = {
  app: { isPackaged: false, getAppPath: () => '/fake/app/path' },
}
vi.mock('electron', () => electronMock)
vi.mock('../../client/node_modules/electron/index.js', () => electronMock)

// ---------------------------------------------------------------------------
// Mock @server/db/agents.js (listAgents)
// ---------------------------------------------------------------------------

const listAgentsMock = vi.fn().mockReturnValue([])
vi.mock('@server/db/agents.js', () => ({
  listAgents: (db: any, includeArchived: boolean) => listAgentsMock(db, includeArchived),
}))

// ---------------------------------------------------------------------------
// Mock runtime-paths (稳定路径常量)
// ---------------------------------------------------------------------------

const SHIM_PATH = '/tidemind/bin/tm-node'
const MCP_SERVER_PATH = '/tidemind/out/bin/mcp-server.cjs'
const HOOK_SCRIPT_PATH = '/tidemind/out/bin/hook-session-start.cjs'
const PRE_COMPACT_SCRIPT_PATH = '/tidemind/out/bin/hook-pre-compact.cjs'
const POST_COMPACT_SCRIPT_PATH = '/tidemind/out/bin/hook-post-compact.cjs'

vi.mock('../../client/electron/runtime/runtime-paths', () => ({
  getShimPath: () => SHIM_PATH,
  getMcpServerScriptPath: () => MCP_SERVER_PATH,
  getHookScriptPath: () => HOOK_SCRIPT_PATH,
  getPreCompactHookScriptPath: () => PRE_COMPACT_SCRIPT_PATH,
  getPostCompactHookScriptPath: () => POST_COMPACT_SCRIPT_PATH,
}))

// ---------------------------------------------------------------------------
// 动态 import,确保上面所有 mock 已生效
// ---------------------------------------------------------------------------

const { selfHealPlugins } = await import(
  '../../client/electron/runtime/plugin-self-heal'
)

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function writeJsonFile(filePath: string, obj: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2))
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

/** Make a complete claude-code plugin dir with current shim path baseline. */
function makeClaudeCodePluginDir(
  pluginsRoot: string,
  agentId: string,
  overrides: {
    mcpServers?: Record<string, any>
    sessionStartCmd?: string
    preCompactCmd?: string | null
    postCompactCmd?: string | null
    pluginVersion?: string
    skillFile?: string | null
  } = {},
): string {
  const pluginDirName = `claude-code-${agentId}`
  const pluginDir = path.join(pluginsRoot, pluginDirName)
  fs.mkdirSync(pluginDir, { recursive: true })

  // .claude-plugin/plugin.json
  writeJsonFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'), {
    name: `tidemind-${agentId}`,
    version: overrides.pluginVersion ?? '1.0.0',
    description: 'test',
  })

  // .mcp.json
  const mcpServers = overrides.mcpServers ?? {
    tidemind: { command: SHIM_PATH, args: [MCP_SERVER_PATH], env: {} },
  }
  writeJsonFile(path.join(pluginDir, '.mcp.json'), { mcpServers })

  // hooks.json
  const sessionStartCmd =
    overrides.sessionStartCmd ??
    `${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)} --agent-id ${JSON.stringify(agentId)} --skill-path ${JSON.stringify(path.join(pluginDir, 'skills/tidemind/SKILL.md'))} --tool "claude-code"`
  const hooks: any = {
    SessionStart: [{ hooks: [{ type: 'command', command: sessionStartCmd, timeout: 10000 }] }],
  }
  if (overrides.preCompactCmd !== null) {
    const cmd =
      overrides.preCompactCmd ??
      `${JSON.stringify(SHIM_PATH)} ${JSON.stringify(PRE_COMPACT_SCRIPT_PATH)} --agent-id ${JSON.stringify(agentId)} --tool "claude-code"`
    hooks.PreCompact = [{ hooks: [{ type: 'command', command: cmd, timeout: 10000 }] }]
  }
  if (overrides.postCompactCmd !== null) {
    const cmd =
      overrides.postCompactCmd ??
      `${JSON.stringify(SHIM_PATH)} ${JSON.stringify(POST_COMPACT_SCRIPT_PATH)} --agent-id ${JSON.stringify(agentId)} --tool "claude-code"`
    hooks.PostCompact = [{ hooks: [{ type: 'command', command: cmd, timeout: 10000 }] }]
  }
  writeJsonFile(path.join(pluginDir, 'hooks', 'hooks.json'), { hooks })

  // SKILL.md
  if (overrides.skillFile !== null) {
    const skillContent =
      overrides.skillFile ??
      [
        '---',
        'description: "外部记忆"',
        'when_to_use: |',
        '  helper',
        'allowed-tools:',
        '  - mcp__test__brain_recall',
        '---',
        '',
        '# body',
      ].join('\n')
    writeTextFile(path.join(pluginDir, 'skills', 'tidemind', 'SKILL.md'), skillContent)
  }

  return pluginDir
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('selfHealPlugins — 顶层入口', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-top-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    listAgentsMock.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('完全空 dataDir + 空 homeDir 不报错,扫描数 == 0', () => {
    const result = selfHealPlugins(dataDir)
    expect(result.errors).toEqual([])
    expect(result.scanned).toBe(0)
    expect(result.patched).toBe(0)
  })

  it('selfHealPlugins 不传 db 时,listAgents 不被调用', () => {
    selfHealPlugins(dataDir)
    expect(listAgentsMock).not.toHaveBeenCalled()
  })

  it('selfHealPlugins 传 db 时,listAgents 被调用获取 expectedAgentIds', () => {
    const fakeDb = {} as any
    listAgentsMock.mockReturnValue([
      { id: 'agent-a', name: 'A', tool_type: 'cursor', archived: 0, last_active: null, created: '' },
    ])
    selfHealPlugins(dataDir, fakeDb)
    expect(listAgentsMock).toHaveBeenCalledWith(fakeDb, false)
  })

  it('listAgents 抛错时,会被吞掉并继续 self-heal', () => {
    const fakeDb = {} as any
    listAgentsMock.mockImplementation(() => {
      throw new Error('db down')
    })
    const result = selfHealPlugins(dataDir, fakeDb)
    expect(result.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// .mcp.json patch
// ---------------------------------------------------------------------------

describe('selfHealPlugins — claude-code .mcp.json', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-mcp-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('patches stale command path in tidemind mcp entry', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_xxx', {
      mcpServers: {
        tidemind: { command: '/old/path/tm-node', args: ['/old/mcp.cjs'] },
      },
    })
    const result = selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, '.mcp.json'))
    expect(updated.mcpServers.tidemind.command).toBe(SHIM_PATH)
    expect(updated.mcpServers.tidemind.args[0]).toBe(MCP_SERVER_PATH)
    expect(result.patched).toBeGreaterThan(0)
  })

  it('cleans up legacy "external-brain" key', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_xxx', {
      mcpServers: {
        'external-brain': { command: '/legacy/tm-node', args: ['/legacy/mcp.cjs'] },
        tidemind: { command: SHIM_PATH, args: [MCP_SERVER_PATH] },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, '.mcp.json'))
    expect(updated.mcpServers).not.toHaveProperty('external-brain')
    expect(updated.mcpServers).toHaveProperty('tidemind')
  })

  it('no-op when tidemind entry already current', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_xxx')
    const mcpPath = path.join(pluginDir, '.mcp.json')
    const beforeContent = fs.readFileSync(mcpPath, 'utf-8')
    selfHealPlugins(dataDir)
    // .mcp.json should be unchanged (but plugin.json#version may bump)
    expect(fs.readFileSync(mcpPath, 'utf-8')).toBe(beforeContent)
  })

  it('skips malformed .mcp.json without crashing (records nothing)', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_xxx')
    fs.writeFileSync(path.join(pluginDir, '.mcp.json'), '{not json')
    const result = selfHealPlugins(dataDir)
    expect(result.errors.filter(e => e.file.endsWith('.mcp.json'))).toEqual([])
  })

  it('rebuilds args when args[0] points to stale mcp-server path', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_xxx', {
      mcpServers: {
        tidemind: { command: SHIM_PATH, args: ['/old/mcp.cjs'] },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, '.mcp.json'))
    expect(updated.mcpServers.tidemind.args[0]).toBe(MCP_SERVER_PATH)
  })

  it('creates args array when missing', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_xxx', {
      mcpServers: {
        tidemind: { command: '/old/tm-node' },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, '.mcp.json'))
    expect(updated.mcpServers.tidemind.args).toEqual([MCP_SERVER_PATH])
  })

  it('non-claude-code-* directories under plugins/ are ignored', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    fs.mkdirSync(path.join(pluginsRoot, 'other-plugin'), { recursive: true })
    writeJsonFile(path.join(pluginsRoot, 'other-plugin', '.mcp.json'), {
      mcpServers: { tidemind: { command: '/old', args: ['/old'] } },
    })
    const result = selfHealPlugins(dataDir)
    const file = readJson(path.join(pluginsRoot, 'other-plugin', '.mcp.json'))
    expect(file.mcpServers.tidemind.command).toBe('/old')
    expect(result.errors).toEqual([])
  })

  it('files (not directories) under plugins/ are ignored', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    fs.mkdirSync(pluginsRoot, { recursive: true })
    fs.writeFileSync(path.join(pluginsRoot, 'claude-code-stray'), 'not a dir')
    const result = selfHealPlugins(dataDir)
    expect(result.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// hooks.json patches
// ---------------------------------------------------------------------------

describe('selfHealPlugins — claude-code hooks.json', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-hooks-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('rewrites SessionStart command with stale shim path', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_alpha'
    const skillPath = '/tidemind/skills/tidemind/SKILL.md'
    const staleCmd = `"/old/tm-node" "/old/hook.cjs" --agent-id "${agentId}" --skill-path "${skillPath}" --tool "claude-code"`
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, {
      sessionStartCmd: staleCmd,
    })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, 'hooks/hooks.json'))
    const cmd = updated.hooks.SessionStart[0].hooks[0].command
    expect(cmd.startsWith(`${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)}`)).toBe(true)
    expect(cmd).toContain(agentId)
  })

  it('upgrades old echo-style PreCompact to script-form', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_old'
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, {
      preCompactCmd: 'echo "压缩中..."',
    })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, 'hooks/hooks.json'))
    const cmd = updated.hooks.PreCompact[0].hooks[0].command
    expect(cmd).toContain('--agent-id')
    expect(cmd).toContain(agentId)
    expect(cmd).toContain('--tool')
    expect(cmd.startsWith(JSON.stringify(SHIM_PATH))).toBe(true)
  })

  it('PreCompact missing --tool: rebuilds with --tool added', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_notool'
    // Old (buggy) PreCompact form: has --agent-id but no --tool
    const oldCmd = `${JSON.stringify(SHIM_PATH)} ${JSON.stringify(PRE_COMPACT_SCRIPT_PATH)} --agent-id ${JSON.stringify(agentId)}`
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, { preCompactCmd: oldCmd })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, 'hooks/hooks.json'))
    const cmd = updated.hooks.PreCompact[0].hooks[0].command
    expect(cmd).toContain('--tool')
  })

  it('adds PostCompact section when missing from old agent hooks.json', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_nopost'
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, {
      postCompactCmd: null, // omit entirely
    })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, 'hooks/hooks.json'))
    expect(Array.isArray(updated.hooks.PostCompact)).toBe(true)
    expect(updated.hooks.PostCompact.length).toBeGreaterThan(0)
    const cmd = updated.hooks.PostCompact[0].hooks[0].command
    expect(cmd).toContain(agentId)
    expect(cmd).toContain('--tool')
  })

  it('rewrites PostCompact with stale shim path', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_stalepost'
    const staleCmd = `"/old/tm-node" "/old/post.cjs" --agent-id "${agentId}" --tool "claude-code"`
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, { postCompactCmd: staleCmd })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, 'hooks/hooks.json'))
    const cmd = updated.hooks.PostCompact[0].hooks[0].command
    expect(cmd.startsWith(JSON.stringify(SHIM_PATH))).toBe(true)
    expect(cmd).toContain(POST_COMPACT_SCRIPT_PATH)
  })

  it('no-op when all hooks already current', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_current')
    const hooksPath = path.join(pluginDir, 'hooks/hooks.json')
    const before = fs.readFileSync(hooksPath, 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(hooksPath, 'utf-8')).toBe(before)
  })

  it('skips hooks.json without SessionStart identity (no agent-id parseable)', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_noid'
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, {
      sessionStartCmd: 'echo "no agent id here"',
    })
    const result = selfHealPlugins(dataDir)
    // 不会因为缺 identity 就报错
    expect(result.errors.filter(e => e.file.endsWith('hooks.json'))).toEqual([])
    // SessionStart 也不会被改(因为没法 parse agentId)
    const updated = readJson(path.join(pluginDir, 'hooks/hooks.json'))
    expect(updated.hooks.SessionStart[0].hooks[0].command).toBe('echo "no agent id here"')
  })

  it('preserves timeout field on PreCompact upgrade', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_timeout'
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, {
      preCompactCmd: 'echo "old"',
    })
    selfHealPlugins(dataDir)
    const updated = readJson(path.join(pluginDir, 'hooks/hooks.json'))
    expect(typeof updated.hooks.PreCompact[0].hooks[0].timeout).toBe('number')
  })

  it('skips when hooks.json has no hooks field', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, 'eb_emptyhooks')
    writeJsonFile(path.join(pluginDir, 'hooks/hooks.json'), { someOtherKey: 1 })
    const result = selfHealPlugins(dataDir)
    expect(result.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cursor / Windsurf / Cowork — healMcpServersFile
// ---------------------------------------------------------------------------

describe('selfHealPlugins — Cursor mcp.json (flat mcpServers)', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-cursor-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    listAgentsMock.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('patches stale tidemind-* entry in cursor mcp.json', () => {
    const cursorPath = path.join(homeDir, '.cursor', 'mcp.json')
    writeJsonFile(cursorPath, {
      mcpServers: {
        'tidemind-eb_aaa': { command: '/old/tm', args: ['/old/mcp.cjs'] },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(cursorPath)
    expect(updated.mcpServers['tidemind-eb_aaa'].command).toBe(SHIM_PATH)
    expect(updated.mcpServers['tidemind-eb_aaa'].args[0]).toBe(MCP_SERVER_PATH)
  })

  it('cleans up external-brain-* legacy keys', () => {
    const cursorPath = path.join(homeDir, '.cursor', 'mcp.json')
    writeJsonFile(cursorPath, {
      mcpServers: {
        'external-brain-old': { command: '/legacy', args: [] },
        'tidemind-eb_aaa': { command: SHIM_PATH, args: [MCP_SERVER_PATH] },
        keep_me: { command: '/other', args: [] },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(cursorPath)
    expect(updated.mcpServers).not.toHaveProperty('external-brain-old')
    expect(updated.mcpServers).toHaveProperty('tidemind-eb_aaa')
    expect(updated.mcpServers).toHaveProperty('keep_me')
  })

  it('rebuilds missing tidemind-{agentId} entry when expectedAgentIds includes it', () => {
    const fakeDb = {} as any
    listAgentsMock.mockReturnValue([
      { id: 'agent-cursor-1', name: 'X', tool_type: 'cursor', archived: 0, last_active: null, created: '' },
    ])
    const cursorPath = path.join(homeDir, '.cursor', 'mcp.json')
    writeJsonFile(cursorPath, { mcpServers: {} })
    selfHealPlugins(dataDir, fakeDb)
    const updated = readJson(cursorPath)
    expect(updated.mcpServers['tidemind-agent-cursor-1']).toBeDefined()
    expect(updated.mcpServers['tidemind-agent-cursor-1'].command).toBe(SHIM_PATH)
    expect(updated.mcpServers['tidemind-agent-cursor-1'].args).toEqual([MCP_SERVER_PATH])
    expect(updated.mcpServers['tidemind-agent-cursor-1'].env.EB_AGENT_ID).toBe('agent-cursor-1')
  })

  it('creates mcpServers field if missing and expectedAgentIds non-empty', () => {
    const fakeDb = {} as any
    listAgentsMock.mockReturnValue([
      { id: 'a1', name: 'X', tool_type: 'cursor', archived: 0, last_active: null, created: '' },
    ])
    const cursorPath = path.join(homeDir, '.cursor', 'mcp.json')
    writeJsonFile(cursorPath, { someOther: 'data' })
    selfHealPlugins(dataDir, fakeDb)
    const updated = readJson(cursorPath)
    expect(updated.mcpServers).toBeDefined()
    expect(updated.mcpServers['tidemind-a1']).toBeDefined()
  })

  it('no-op when mcpServers missing and no expectedAgentIds', () => {
    const cursorPath = path.join(homeDir, '.cursor', 'mcp.json')
    writeJsonFile(cursorPath, { someOther: 'x' })
    const before = fs.readFileSync(cursorPath, 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(cursorPath, 'utf-8')).toBe(before)
  })

  it('non-existent cursor mcp.json silently ignored', () => {
    const result = selfHealPlugins(dataDir)
    expect(result.errors).toEqual([])
  })

  it('only archived=false agents are loaded into expectedAgentIds', () => {
    const fakeDb = {} as any
    listAgentsMock.mockReturnValue([
      { id: 'a-alive', name: 'X', tool_type: 'cursor', archived: 0, last_active: null, created: '' },
    ])
    const cursorPath = path.join(homeDir, '.cursor', 'mcp.json')
    writeJsonFile(cursorPath, { mcpServers: {} })
    selfHealPlugins(dataDir, fakeDb)
    expect(listAgentsMock).toHaveBeenCalledWith(fakeDb, false)
  })

  it('Windsurf mcp_config.json: same flat structure, same patching', () => {
    const wsPath = path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json')
    writeJsonFile(wsPath, {
      mcpServers: {
        'tidemind-eb_w': { command: '/old/tm', args: ['/old/mcp.cjs'] },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(wsPath)
    expect(updated.mcpServers['tidemind-eb_w'].command).toBe(SHIM_PATH)
  })

  it('Claude Desktop (cowork) config: same flat structure, same patching', () => {
    const cdPath = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    writeJsonFile(cdPath, {
      mcpServers: {
        'tidemind-eb_d': { command: '/old/tm', args: ['/old/mcp.cjs'] },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(cdPath)
    expect(updated.mcpServers['tidemind-eb_d'].command).toBe(SHIM_PATH)
  })
})

// ---------------------------------------------------------------------------
// OpenClaw (nested mcp.servers)
// ---------------------------------------------------------------------------

describe('selfHealPlugins — OpenClaw config', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-openclaw-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('patches tidemind-* in nested mcp.servers structure', () => {
    const ocPath = path.join(homeDir, '.openclaw', 'openclaw.json')
    writeJsonFile(ocPath, {
      mcp: {
        servers: {
          'tidemind-eb_oc': { command: '/old/tm', args: ['/old/mcp.cjs'] },
        },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(ocPath)
    expect(updated.mcp.servers['tidemind-eb_oc'].command).toBe(SHIM_PATH)
  })

  it('cleans up external-brain-* in openclaw nested servers', () => {
    const ocPath = path.join(homeDir, '.openclaw', 'openclaw.json')
    writeJsonFile(ocPath, {
      mcp: {
        servers: {
          'external-brain-legacy': { command: '/legacy', args: [] },
          'tidemind-eb_oc': { command: SHIM_PATH, args: [MCP_SERVER_PATH] },
        },
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(ocPath)
    expect(updated.mcp.servers).not.toHaveProperty('external-brain-legacy')
  })

  it('skips when no mcp.servers field present', () => {
    const ocPath = path.join(homeDir, '.openclaw', 'openclaw.json')
    writeJsonFile(ocPath, { config: { other: true } })
    const before = fs.readFileSync(ocPath, 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(ocPath, 'utf-8')).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Codex hooks.json + config.toml
// ---------------------------------------------------------------------------

describe('selfHealPlugins — Codex hooks.json', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-codex-h-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('patches stale SessionStart command in codex hooks.json', () => {
    const codexHooksPath = path.join(homeDir, '.codex', 'hooks.json')
    const agentId = 'eb_codex'
    const skillPath = '/codex/skill.md'
    const staleCmd = `"/old/tm" "/old/hook.cjs" --agent-id "${agentId}" --skill-path "${skillPath}" --tool "codex"`
    writeJsonFile(codexHooksPath, {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: staleCmd }] }],
      },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(codexHooksPath)
    const cmd = updated.hooks.SessionStart[0].hooks[0].command
    expect(cmd.startsWith(`${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)}`)).toBe(true)
    expect(cmd).toContain('"codex"')
  })

  it('skips codex hooks.json without SessionStart', () => {
    const codexHooksPath = path.join(homeDir, '.codex', 'hooks.json')
    writeJsonFile(codexHooksPath, { hooks: { SomeOther: [] } })
    const before = fs.readFileSync(codexHooksPath, 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(codexHooksPath, 'utf-8')).toBe(before)
  })

  it('skips codex hook command without --agent-id', () => {
    const codexHooksPath = path.join(homeDir, '.codex', 'hooks.json')
    writeJsonFile(codexHooksPath, {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] },
    })
    const before = fs.readFileSync(codexHooksPath, 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(codexHooksPath, 'utf-8')).toBe(before)
  })
})

describe('selfHealPlugins — Codex config.toml', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-codex-t-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('patches command + args[0] in [mcp_servers.tidemind-*] section', () => {
    const tomlPath = path.join(homeDir, '.codex', 'config.toml')
    const content = [
      '[mcp_servers.tidemind-eb_t1]',
      'command = "/old/tm-node"',
      'args = ["/old/mcp.cjs", "extra"]',
      '',
    ].join('\n')
    writeTextFile(tomlPath, content)
    selfHealPlugins(dataDir)
    const updated = fs.readFileSync(tomlPath, 'utf-8')
    expect(updated).toContain(`command = ${JSON.stringify(SHIM_PATH)}`)
    expect(updated).toContain(`args = [${JSON.stringify(MCP_SERVER_PATH)}`)
    // preserve extra args
    expect(updated).toContain('"extra"')
  })

  it('removes [mcp_servers.external-brain-*] legacy sections entirely', () => {
    const tomlPath = path.join(homeDir, '.codex', 'config.toml')
    const content = [
      '[mcp_servers.external-brain-old]',
      'command = "/legacy/tm"',
      'args = ["/legacy/mcp.cjs"]',
      '',
      '[mcp_servers.tidemind-eb_t]',
      `command = ${JSON.stringify(SHIM_PATH)}`,
      `args = [${JSON.stringify(MCP_SERVER_PATH)}]`,
      '',
    ].join('\n')
    writeTextFile(tomlPath, content)
    selfHealPlugins(dataDir)
    const updated = fs.readFileSync(tomlPath, 'utf-8')
    expect(updated).not.toContain('external-brain-old')
    expect(updated).toContain('tidemind-eb_t')
  })

  it('uses real TOML boundaries when a legacy section contains table-looking multiline text', () => {
    const tomlPath = path.join(homeDir, '.codex', 'config.toml')
    const content = [
      '[mcp_servers.external-brain-old]',
      'command = "/legacy/tm"',
      'note = """',
      '[not-a-table]',
      '"""',
      '',
      '[mcp_servers.tidemind-eb_keep]',
      `command = ${JSON.stringify(SHIM_PATH)}`,
      `args = [${JSON.stringify(MCP_SERVER_PATH)}]`,
      '',
    ].join('\n')
    writeTextFile(tomlPath, content)

    const result = selfHealPlugins(dataDir)

    const updated = fs.readFileSync(tomlPath, 'utf-8')
    expect(result.errors).toEqual([])
    expect(updated).not.toContain('external-brain-old')
    expect((parseToml(updated) as any).mcp_servers['tidemind-eb_keep'].command).toBe(SHIM_PATH)
  })

  it('patches an escaped quoted command without producing invalid TOML', () => {
    const tomlPath = path.join(homeDir, '.codex', 'config.toml')
    const content = [
      '[mcp_servers.tidemind-eb_quoted]',
      `command = ${JSON.stringify('/old/"quoted')}`,
      'args = ["/old/mcp.cjs"]',
      '',
    ].join('\n')
    writeTextFile(tomlPath, content)

    const result = selfHealPlugins(dataDir)

    const parsed = parseToml(fs.readFileSync(tomlPath, 'utf-8')) as any
    expect(result.errors).toEqual([])
    expect(parsed.mcp_servers['tidemind-eb_quoted'].command).toBe(SHIM_PATH)
    expect(parsed.mcp_servers['tidemind-eb_quoted'].args[0]).toBe(MCP_SERVER_PATH)
  })

  it('non-existent codex config.toml silently ignored', () => {
    const result = selfHealPlugins(dataDir)
    expect(result.errors).toEqual([])
  })

  it('preserves unrelated sections in codex TOML', () => {
    const tomlPath = path.join(homeDir, '.codex', 'config.toml')
    const content = [
      '[settings]',
      'theme = "dark"',
      '',
      '[mcp_servers.tidemind-eb_t]',
      'command = "/old"',
      'args = ["/old"]',
      '',
    ].join('\n')
    writeTextFile(tomlPath, content)
    selfHealPlugins(dataDir)
    const updated = fs.readFileSync(tomlPath, 'utf-8')
    expect(updated).toContain('[settings]')
    expect(updated).toContain('theme = "dark"')
  })
})

describe('selfHealPlugins — Kimi Code config.toml', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  const kimiConfigPath = () => path.join(homeDir, '.kimi-code', 'config.toml')

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-kimi-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    delete process.env.KIMI_CODE_HOME
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('patches a stale UserPromptSubmit hook command in the [[hooks]] block, preserving --once-per-session', () => {
    const agentId = 'eb_kimi'
    const staleCmd = `"/old/tm" "/old/hook-session-start.cjs" --agent-id "${agentId}" --skill-path "/old/SKILL.md" --tool "kimi-code" --once-per-session`
    writeTextFile(kimiConfigPath(), [
      'model = "k2"',
      '',
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(staleCmd)}`,
      'timeout = 30',
      '',
    ].join('\n'))

    selfHealPlugins(dataDir)

    const updated = fs.readFileSync(kimiConfigPath(), 'utf-8')
    expect(updated).toContain('model = "k2"')
    const cmdMatch = updated.match(/^command = ("(?:[^"\\]|\\.)*")$/m)
    expect(cmdMatch).not.toBeNull()
    const cmd = JSON.parse(cmdMatch![1])
    expect(cmd.startsWith(`${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)}`)).toBe(true)
    // agent-id / skill-path / tool 从原 command 保留
    expect(cmd).toContain(`--agent-id "${agentId}"`)
    expect(cmd).toContain('--skill-path "/old/SKILL.md"')
    expect(cmd).toContain('"kimi-code"')
    // --once-per-session 必须在自愈后保留,否则 UserPromptSubmit 每条消息都注入
    expect(cmd).toContain('--once-per-session')
  })

  it('patches a stale hook while preserving valid event and command tail comments', () => {
    const staleCmd = '"/old/tm" "/old/hook-session-start.cjs" --agent-id "eb_comments" --skill-path "/old/SKILL.md" --tool "kimi-code"'
    writeTextFile(kimiConfigPath(), [
      '[[hooks]]',
      'event = "UserPromptSubmit" # user note',
      `command = ${JSON.stringify(staleCmd)} # keep this`,
      'timeout = 30',
      '',
    ].join('\n'))

    selfHealPlugins(dataDir)

    const updated = fs.readFileSync(kimiConfigPath(), 'utf-8')
    expect(updated).toContain('# user note')
    expect(updated).toContain('# keep this')
    expect((parseToml(updated) as any).hooks[0].command.startsWith(`${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)}`)).toBe(true)
  })

  it('patches a stale hook whose valid target header is [[ hooks ]]', () => {
    const staleCmd = '"/old/tm" "/old/hook-session-start.cjs" --agent-id "eb_spaced" --skill-path "/old/SKILL.md" --tool "kimi-code" --once-per-session'
    writeTextFile(kimiConfigPath(), [
      '[[ hooks ]]\t# Tide Mind',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(staleCmd)}`,
      'timeout = 30',
      '',
    ].join('\n'))

    selfHealPlugins(dataDir)

    const updated = fs.readFileSync(kimiConfigPath(), 'utf-8')
    const command = JSON.parse(updated.match(/^command = ("(?:[^"\\]|\\.)*")$/m)![1])
    expect(command.startsWith(`${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)}`)).toBe(true)
    expect(command).toContain('--once-per-session')
  })

  it('patches only the stale block when multiple agents have [[hooks]] blocks', () => {
    const staleCmd = `"/old/tm" "/old/hook-session-start.cjs" --agent-id "eb_a" --skill-path "/old/A.md" --tool "kimi-code"`
    const currentCmd = `${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)} --agent-id "eb_b" --skill-path "/home/u/B.md" --tool "kimi-code"`
    writeTextFile(kimiConfigPath(), [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(staleCmd)}`,
      'timeout = 30',
      '',
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(currentCmd)}`,
      'timeout = 30',
      '',
    ].join('\n'))

    selfHealPlugins(dataDir)

    const updated = fs.readFileSync(kimiConfigPath(), 'utf-8')
    const cmds = [...updated.matchAll(/^command = ("(?:[^"\\]|\\.)*")$/gm)].map(m => JSON.parse(m[1]))
    expect(cmds).toHaveLength(2)
    expect(cmds[0].startsWith(`${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)}`)).toBe(true)
    expect(cmds[0]).toContain('"eb_a"')
    // eb_b 的块原样保留
    expect(cmds[1]).toBe(currentCmd)
  })

  it('treats a section header with trailing comment as the block boundary', () => {
    const staleCmd = `"/old/tm" "/old/hook-session-start.cjs" --agent-id "eb_c" --skill-path "/old/C.md" --tool "kimi-code"`
    writeTextFile(kimiConfigPath(), [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(staleCmd)}`,
      '',
      '[providers.anthropic] # user provider',
      'base_url = "https://example.com"',
      '',
    ].join('\n'))

    selfHealPlugins(dataDir)

    const updated = fs.readFileSync(kimiConfigPath(), 'utf-8')
    expect(updated).toContain(JSON.stringify(SHIM_PATH).slice(1, -1))
    // 带注释的用户段完整保留
    expect(updated).toContain('[providers.anthropic] # user provider')
    expect(updated).toContain('base_url = "https://example.com"')
  })

  it('leaves non-UserPromptSubmit [[hooks]] blocks untouched (gate ①)', () => {
    const staleCmd = `"/old/tm" "/old/hook-session-start.cjs" --agent-id "eb_d" --skill-path "/old/D.md" --tool "kimi-code"`
    const original = [
      '[[hooks]]',
      'event = "SessionStart"',
      `command = ${JSON.stringify(staleCmd)}`,
      '',
    ].join('\n')
    writeTextFile(kimiConfigPath(), original)
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(kimiConfigPath(), 'utf-8')).toBe(original)
  })

  it('leaves UserPromptSubmit blocks whose command is not hook-session-start untouched (gate ②)', () => {
    // 用户自定义 hook,碰巧也带 --agent-id 参数
    const customCmd = '"/old/tm" "/old/my-custom-hook.cjs" --agent-id "eb_e" --skill-path "/old/E.md" --tool "kimi-code"'
    const original = [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(customCmd)}`,
      '',
    ].join('\n')
    writeTextFile(kimiConfigPath(), original)
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(kimiConfigPath(), 'utf-8')).toBe(original)
  })

  it('honors KIMI_CODE_HOME and does not touch the default ~/.kimi-code config', () => {
    const envHome = path.join(tmpRoot, 'kimi-env-home')
    process.env.KIMI_CODE_HOME = envHome
    const staleCmd = `"/old/tm" "/old/hook-session-start.cjs" --agent-id "eb_f" --skill-path "/old/F.md" --tool "kimi-code"`
    const block = [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(staleCmd)}`,
      '',
    ].join('\n')
    writeTextFile(path.join(envHome, 'config.toml'), block)
    // 默认位置也放一个过期配置:env 设置时不应被扫描
    writeTextFile(kimiConfigPath(), block)

    selfHealPlugins(dataDir)

    const healed = fs.readFileSync(path.join(envHome, 'config.toml'), 'utf-8')
    expect(healed).toContain(JSON.stringify(SHIM_PATH).slice(1, -1))
    expect(fs.readFileSync(kimiConfigPath(), 'utf-8')).toBe(block)
  })

  it('leaves [[hooks]] blocks without --agent-id untouched', () => {
    const original = [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      'command = "echo hi"',
      '',
    ].join('\n')
    writeTextFile(kimiConfigPath(), original)
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(kimiConfigPath(), 'utf-8')).toBe(original)
  })

  it('leaves an up-to-date hook command untouched', () => {
    const currentCmd = `${JSON.stringify(SHIM_PATH)} ${JSON.stringify(HOOK_SCRIPT_PATH)} --agent-id "eb_kimi" --skill-path "/home/u/.kimi-code/skills/tidemind-eb_kimi/SKILL.md" --tool "kimi-code" --once-per-session`
    writeTextFile(kimiConfigPath(), [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(currentCmd)}`,
      'timeout = 30',
      '',
    ].join('\n'))
    const before = fs.readFileSync(kimiConfigPath(), 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(kimiConfigPath(), 'utf-8')).toBe(before)
  })

  it('non-existent kimi config.toml silently ignored', () => {
    const result = selfHealPlugins(dataDir)
    expect(result.errors).toEqual([])
  })

  it('malformed kimi config.toml is left unchanged and reported', () => {
    const malformed = '[[hooks]\nevent = "UserPromptSubmit"\n'
    writeTextFile(kimiConfigPath(), malformed)

    const result = selfHealPlugins(dataDir)

    expect(fs.readFileSync(kimiConfigPath(), 'utf-8')).toBe(malformed)
    expect(result.errors).toEqual([
      expect.objectContaining({ file: kimiConfigPath(), error: expect.stringContaining('invalid TOML') }),
    ])
  })
})

// ---------------------------------------------------------------------------
// healLocalMarketplace + healClaudeSettings
// ---------------------------------------------------------------------------

describe('selfHealPlugins — local marketplace.json', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-mp-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('rewrites legacy External Brain marketplace.json to TideMind', () => {
    const mpPath = path.join(dataDir, 'plugins', '.claude-plugin', 'marketplace.json')
    writeJsonFile(mpPath, {
      name: 'external-brain-local',
      description: 'External Brain plugins',
      owner: { name: 'External Brain', email: 'eb@old' },
      plugins: [
        { name: 'external-brain-foo', description: 'old' },
        { name: 'tidemind-eb_aaa', description: 'new' },
      ],
    })
    selfHealPlugins(dataDir)
    const updated = readJson(mpPath)
    expect(updated.name).toBe('tidemind-local')
    expect(updated.owner.name).toBe('TideMind')
    expect(updated.plugins.find((p: any) => p.name === 'external-brain-foo')).toBeUndefined()
    expect(updated.plugins.find((p: any) => p.name === 'tidemind-eb_aaa')).toBeDefined()
  })

  it('no-op on already-correct marketplace.json', () => {
    const mpPath = path.join(dataDir, 'plugins', '.claude-plugin', 'marketplace.json')
    writeJsonFile(mpPath, {
      name: 'tidemind-local',
      description: 'Tide Mind 本地插件仓库',
      owner: { name: 'TideMind', email: 'local@tidemind' },
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      plugins: [{ name: 'tidemind-eb_a', source: './claude-code-eb_a' }],
    })
    const before = fs.readFileSync(mpPath, 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(mpPath, 'utf-8')).toBe(before)
  })

  it('handles malformed marketplace.json gracefully', () => {
    const mpPath = path.join(dataDir, 'plugins', '.claude-plugin', 'marketplace.json')
    fs.mkdirSync(path.dirname(mpPath), { recursive: true })
    fs.writeFileSync(mpPath, '{ broken')
    const result = selfHealPlugins(dataDir)
    expect(result.errors.filter(e => e.file.endsWith('marketplace.json'))).toEqual([])
  })
})

describe('selfHealPlugins — claude settings.json', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-cs-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('removes legacy external-brain-local key from extraKnownMarketplaces', () => {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json')
    writeJsonFile(settingsPath, {
      extraKnownMarketplaces: {
        'external-brain-local': { source: '/some/path' },
        'tidemind-local': { source: '/other/path' },
      },
      otherStuff: { keep: true },
    })
    selfHealPlugins(dataDir)
    const updated = readJson(settingsPath)
    expect(updated.extraKnownMarketplaces).not.toHaveProperty('external-brain-local')
    expect(updated.extraKnownMarketplaces).toHaveProperty('tidemind-local')
    expect(updated.otherStuff).toEqual({ keep: true })
  })

  it('no-op when settings.json has no legacy keys', () => {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json')
    writeJsonFile(settingsPath, {
      extraKnownMarketplaces: { 'tidemind-local': { source: '/p' } },
    })
    const before = fs.readFileSync(settingsPath, 'utf-8')
    selfHealPlugins(dataDir)
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(before)
  })

  it('skips when settings.json missing', () => {
    const result = selfHealPlugins(dataDir)
    expect(result.errors.filter(e => e.file.endsWith('settings.json'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 集成场景:多个文件同时存在
// ---------------------------------------------------------------------------

describe('selfHealPlugins — integration scenarios', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-integ-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    listAgentsMock.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('full multi-source migration in one pass: claude-code + cursor + codex', () => {
    // Set up all 3 stale sources
    const pluginsRoot = path.join(dataDir, 'plugins')
    makeClaudeCodePluginDir(pluginsRoot, 'eb_main', {
      mcpServers: { tidemind: { command: '/old/tm', args: ['/old/mcp.cjs'] } },
    })

    writeJsonFile(path.join(homeDir, '.cursor', 'mcp.json'), {
      mcpServers: {
        'tidemind-eb_c1': { command: '/old/tm', args: ['/old/mcp.cjs'] },
      },
    })

    writeJsonFile(path.join(homeDir, '.codex', 'hooks.json'), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `"/old/tm" "/old/hook.cjs" --agent-id "eb_codex" --skill-path "/skill.md" --tool "codex"`,
              },
            ],
          },
        ],
      },
    })

    const result = selfHealPlugins(dataDir)
    expect(result.patched).toBeGreaterThanOrEqual(3)
    expect(result.errors).toEqual([])
  })

  it('errors in one source do not stop other sources', () => {
    // Mix one broken plugin with a valid cursor file
    const pluginsRoot = path.join(dataDir, 'plugins')
    fs.mkdirSync(path.join(pluginsRoot, 'claude-code-broken'), { recursive: true })
    fs.writeFileSync(path.join(pluginsRoot, 'claude-code-broken', '.mcp.json'), '{ broken')

    writeJsonFile(path.join(homeDir, '.cursor', 'mcp.json'), {
      mcpServers: {
        'tidemind-eb_c1': { command: '/old/tm', args: ['/old/mcp.cjs'] },
      },
    })

    const result = selfHealPlugins(dataDir)
    // Cursor file still patched
    const cursor = readJson(path.join(homeDir, '.cursor', 'mcp.json'))
    expect(cursor.mcpServers['tidemind-eb_c1'].command).toBe(SHIM_PATH)
    // No exception leaked
    expect(result.errors).toEqual([])
  })

  it('summary log fields scanned/patched/errors are numeric', () => {
    makeClaudeCodePluginDir(path.join(dataDir, 'plugins'), 'eb_just', {
      mcpServers: { tidemind: { command: '/old/tm', args: ['/old/mcp.cjs'] } },
    })
    const result = selfHealPlugins(dataDir)
    expect(typeof result.scanned).toBe('number')
    expect(typeof result.patched).toBe('number')
    expect(Array.isArray(result.errors)).toBe(true)
  })

  it('returns HealResult shape: { scanned, patched, errors }', () => {
    const result = selfHealPlugins(dataDir)
    expect(result).toHaveProperty('scanned')
    expect(result).toHaveProperty('patched')
    expect(result).toHaveProperty('errors')
  })
})

// ---------------------------------------------------------------------------
// 回归保护: hooks.json 损坏不应跳过同 plugin 的 SKILL.md / version / cache step
// ---------------------------------------------------------------------------
//
// Bug 历史:healClaudeCodePlugins 里 step 3 (hooks/hooks.json) 之前用
//   `if (!cfg?.hooks) continue`
// 来跳过没有 hooks 字段的文件。但这个 continue 跳到的是**外层** plugin 循环的
// 下一次迭代,等于把同一个 plugin 后续的 step 4/5/6:
//   - healClaudeCodeSkillFile  (SKILL.md frontmatter 修复)
//   - syncPluginVersion       (plugin.json#version bump)
//   - mirrorPluginToClaudeCache (Claude Code cache 镜像)
// 全部静默跳过。用户手改坏 hooks.json(空 `{}` 或缺 hooks 字段)时,这个 plugin
// 永远不会被完整自愈,partial-broken 状态长期不收敛。
//
// 修复后:把 continue 改成正向条件(`if (cfg?.hooks) { ... }`),后续 step 依然
// 走得到。本测试通过观察 plugin.json#version 是否被 bump、SKILL.md 是否被改写
// 来证明 step 4/5 确实被执行了。修复前会 FAIL,修复后会 PASS。
//
describe('selfHealPlugins — hooks.json 缺 hooks 字段不应跳过同 plugin 的 SKILL/version step', () => {
  let tmpRoot: string
  let homeDir: string
  let dataDir: string
  let homedirSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-regression-'))
    homeDir = path.join(tmpRoot, 'home')
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    homedirSpy.mockRestore()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('hooks.json 是 {} 时,同 plugin 的 plugin.json#version 仍被 bump,SKILL.md frontmatter 仍被 patch', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_broken_hooks'
    // 用 helper 搭建标准 plugin 目录(plugin.json/.mcp.json/SKILL.md 齐全),
    // 然后把 hooks.json 覆写成空 `{}`,模拟用户手改坏的形态。
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, {
      pluginVersion: '1.0.0', // 故意写老的固定 version,让 syncPluginVersion 必须 bump
      // 用老式 frontmatter(只有 description),让 healClaudeCodeSkillFile 必须 rewrite
      skillFile: [
        '---',
        'description: "外部记忆"',
        '---',
        '',
        '# body',
      ].join('\n'),
    })
    // 把 hooks.json 替换成空对象——触发 step 3 的早退分支
    writeJsonFile(path.join(pluginDir, 'hooks', 'hooks.json'), {})

    selfHealPlugins(dataDir)

    // 断言 1: SKILL.md frontmatter 已被 healClaudeCodeSkillFile 重写
    // (老的只有 description 字段,新版会加上 when_to_use)
    const skillContent = fs.readFileSync(
      path.join(pluginDir, 'skills', 'tidemind', 'SKILL.md'),
      'utf-8',
    )
    expect(skillContent).toMatch(/^when_to_use\s*:/m)

    // 断言 2: plugin.json#version 被 syncPluginVersion bump 到内容 hash 形态
    // (老的写死 '1.0.0',computePluginPatchVersion 返回 '1.0.<hex>',不会等于 '1.0.0')
    const pluginJson = readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'))
    expect(pluginJson.version).not.toBe('1.0.0')
    expect(pluginJson.version).toMatch(/^1\.0\.\d+$/)
  })

  it('hooks.json 完全缺失时也不应跳过同 plugin 的 SKILL/version step', () => {
    const pluginsRoot = path.join(dataDir, 'plugins')
    const agentId = 'eb_no_hooks'
    const pluginDir = makeClaudeCodePluginDir(pluginsRoot, agentId, {
      pluginVersion: '1.0.0',
      skillFile: [
        '---',
        'description: "外部记忆"',
        '---',
        '',
        '# body',
      ].join('\n'),
    })
    // 完全删掉 hooks/hooks.json——触发 step 3 的 existsSync 早退分支
    fs.rmSync(path.join(pluginDir, 'hooks', 'hooks.json'), { force: true })

    selfHealPlugins(dataDir)

    // step 4/5 都应该被执行
    const skillContent = fs.readFileSync(
      path.join(pluginDir, 'skills', 'tidemind', 'SKILL.md'),
      'utf-8',
    )
    expect(skillContent).toMatch(/^when_to_use\s*:/m)

    const pluginJson = readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'))
    expect(pluginJson.version).not.toBe('1.0.0')
  })
})
