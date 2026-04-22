import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  getShimPath,
  getHookScriptPath,
  getMcpServerScriptPath,
} from '../runtime/runtime-paths'
import {
  repairMarketplaceJson,
  repairClaudeSettings,
} from '@server/utils/marketplace-repair.js'

const execFileAsync = promisify(execFile)

// ============================================================
// Plugin 生成器（Claude Code + Claude Cowork）
//
// Claude Code：生成 Plugin（.mcp.json + Skill + Hook）→ 通过 marketplace 安装
// Claude Cowork：写入 Desktop config（MCP 桥接）→ 生成 Skill .md 到 ~/Downloads/ → 用户手动上传
//
// 目录结构：
//   ~/.tidemind/plugins/
//   ├── .claude-plugin/marketplace.json     ← 本地 marketplace（Claude Code 用）
//   └── claude-code-{agentId}/              ← Claude Code 插件目录
//       ├── .claude-plugin/plugin.json
//       ├── .mcp.json
//       ├── skills/tidemind/SKILL.md
//       └── hooks/hooks.json
// ============================================================

const MARKETPLACE_ID = 'tidemind-local'
const MARKETPLACE_NAME = 'tidemind-local'

// --- 客户端类型配置 ---
type PluginClientType = 'claude-code' | 'cowork' | 'cursor' | 'codex' | 'windsurf' | 'openclaw'

interface ClientTypeConfig {
  dirPrefix: string
  skillSource: string
  skillDescription: string
  hookToolParam: string
}

const CLIENT_CONFIG: Record<PluginClientType, ClientTypeConfig> = {
  'claude-code': {
    dirPrefix: 'claude-code',
    skillSource: 'claude-code-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统已连接。用户上下文在会话启动时自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'claude-code',
  },
  'cowork': {
    dirPrefix: 'cowork',
    skillSource: 'cowork-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。每次对话开始时调用 brain_prepare 获取用户上下文，使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'cowork',
  },
  'cursor': {
    dirPrefix: 'cursor',
    skillSource: 'cursor-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。每次对话开始时调用 brain_prepare 获取用户上下文，使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'cursor',
  },
  'codex': {
    dirPrefix: 'codex',
    skillSource: 'codex-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。用户上下文在会话启动时通过 SessionStart Hook 自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'codex',
  },
  'windsurf': {
    dirPrefix: 'windsurf',
    skillSource: 'windsurf-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。每次对话开始时调用 brain_prepare 获取用户上下文，使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'windsurf',
  },
  'openclaw': {
    dirPrefix: 'openclaw',
    skillSource: 'openclaw-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。用户上下文在 Agent Bootstrap 时通过 Hook 自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'openclaw',
  },
}

function isPluginClientType(s: string): s is PluginClientType {
  return s === 'claude-code' || s === 'cowork' || s === 'cursor' || s === 'codex' || s === 'windsurf' || s === 'openclaw'
}

import { appendTomlMcpSection, removeTomlMcpSection, ensureTomlFeatureFlag } from './toml-utils'

interface PluginGenerateParams {
  agentId: string
  agentName: string
  clientType?: string
}

interface PluginGenerateResult {
  pluginDir: string
  pluginName: string
  marketplaceRegistered: boolean
  success: boolean
  error?: string
}

interface PluginInstallResult {
  success: boolean
  output?: string
  error?: string
}

export function registerPluginGeneratorHandlers(dataDir: string): void {
  // Runtime 路径都通过 runtime-paths 模块解析，dev 和 packaged 模式自动分流
  const shimPath = getShimPath()
  const mcpServerPath = getMcpServerScriptPath()
  const hookScriptPath = getHookScriptPath()
  const skillDir = path.join(dataDir, 'skill')
  const pluginsDir = path.join(dataDir, 'plugins')
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json')

  // ----------------------------------------------------------
  // 生成插件（Claude Code 或 Claude Cowork）
  // Claude Code: 生成完整 Plugin 目录（.mcp.json + Skill + Hook）
  // Claude Cowork: 写入 Desktop config + 生成 Skill .md 到 ~/Downloads/
  // ----------------------------------------------------------
  ipcMain.handle('agents:generate-plugin', async (_e, params: PluginGenerateParams): Promise<PluginGenerateResult> => {
    const { agentId, agentName } = params
    const clientType: PluginClientType = isPluginClientType(params.clientType ?? '') ? params.clientType as PluginClientType : 'claude-code'
    const config = CLIENT_CONFIG[clientType]
    const pluginDirName = `${config.dirPrefix}-${agentId}`
    const pluginName = `tidemind-${agentId}`
    const pluginDir = path.join(pluginsDir, pluginDirName)

    // 读取 Skill 源文件（两种类型共用）
    const primarySkillPath = path.join(skillDir, config.skillSource)
    const fallbackSkillPath = path.join(skillDir, 'base-skill.md')
    let skillContent = ''
    if (fs.existsSync(primarySkillPath)) {
      skillContent = fs.readFileSync(primarySkillPath, 'utf-8')
    } else if (fs.existsSync(fallbackSkillPath)) {
      skillContent = fs.readFileSync(fallbackSkillPath, 'utf-8')
    }

    try {
      if (clientType === 'cowork') {
        // ---- Claude Cowork: Desktop config + Skill 文件 ----

        // 1. 写入 Claude Desktop 配置（MCP 桥接）
        const desktopConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        let desktopConfig: any = {}
        if (fs.existsSync(desktopConfigPath)) {
          desktopConfig = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
        }
        if (!desktopConfig.mcpServers) desktopConfig.mcpServers = {}
        desktopConfig.mcpServers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        // 确保目录存在
        const desktopConfigDir = path.dirname(desktopConfigPath)
        if (!fs.existsSync(desktopConfigDir)) fs.mkdirSync(desktopConfigDir, { recursive: true })
        fs.writeFileSync(desktopConfigPath, JSON.stringify(desktopConfig, null, 2))

        // 2. 生成 Skill .md 文件到 ~/Downloads/（Claude Cowork Skills 上传需要 name + description）
        const skillFrontmatter = [
          '---',
          `name: "Tide Mind"`,
          `description: "${config.skillDescription}"`,
          '---',
          '',
        ].join('\n')
        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-skill-${agentId}.md`)
        fs.writeFileSync(skillOutputPath, skillFrontmatter + skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'cursor') {
        // ---- Cursor: MCP 配置 + Skill .mdc 文件 ----

        // 1. 写入 Cursor MCP 配置（全局）
        const cursorConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json')
        let cursorConfig: any = {}
        if (fs.existsSync(cursorConfigPath)) {
          cursorConfig = JSON.parse(fs.readFileSync(cursorConfigPath, 'utf-8'))
        }
        if (!cursorConfig.mcpServers) cursorConfig.mcpServers = {}
        cursorConfig.mcpServers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        const cursorConfigDir = path.dirname(cursorConfigPath)
        if (!fs.existsSync(cursorConfigDir)) fs.mkdirSync(cursorConfigDir, { recursive: true })
        fs.writeFileSync(cursorConfigPath, JSON.stringify(cursorConfig, null, 2))

        // 2. 生成 Skill .mdc 文件到 ~/Downloads/（用户复制到项目 .cursor/rules/）
        const mdcFrontmatter = [
          '---',
          `description: "${config.skillDescription}"`,
          'alwaysApply: true',
          '---',
          '',
        ].join('\n')
        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-cursor-${agentId}.mdc`)
        fs.writeFileSync(skillOutputPath, mdcFrontmatter + skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'codex') {
        // ---- Codex: TOML MCP 配置 + SessionStart Hook + AGENTS.md ----
        const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')
        const codexHooksPath = path.join(os.homedir(), '.codex', 'hooks.json')
        const serverName = `tidemind-${agentId}`

        // 1. 追加 MCP section 到 config.toml
        appendTomlMcpSection(codexConfigPath, serverName, {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        })

        // 2. 启用 hooks feature flag
        ensureTomlFeatureFlag(codexConfigPath, 'codex_hooks')

        // 3. 写入 SessionStart hook 到 hooks.json
        const skillFilePath = path.join(skillDir, config.skillSource)
        let hooksConfig: any = { hooks: {} }
        if (fs.existsSync(codexHooksPath)) {
          try { hooksConfig = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8')) } catch { /* 解析失败用新的 */ }
        }
        if (!hooksConfig.hooks) hooksConfig.hooks = {}
        if (!hooksConfig.hooks.SessionStart) hooksConfig.hooks.SessionStart = []

        // hooks.json 的 command 是纯 shell 字符串，必须对带空格的路径做引号转义
        const hookCommand = [
          JSON.stringify(shimPath),
          JSON.stringify(hookScriptPath),
          '--agent-id', JSON.stringify(agentId),
          '--skill-path', JSON.stringify(skillFilePath),
          '--tool', 'codex',
        ].join(' ')
        // 写入的 command 里是 `--agent-id "eb_xxx"`（JSON.stringify 带引号），
        // 匹配时也必须带引号，否则每次生成都判定为"不存在"导致重复 push
        const agentIdToken = `--agent-id ${JSON.stringify(agentId)}`
        const existing = hooksConfig.hooks.SessionStart.some((group: any) =>
          group.hooks?.some((h: any) => h.command?.includes(agentIdToken)),
        )
        if (!existing) {
          hooksConfig.hooks.SessionStart.push({
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: hookCommand,
              statusMessage: '加载外脑上下文...',
              timeoutSec: 15,
            }],
          })
        }
        const codexDir = path.dirname(codexHooksPath)
        if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true })
        fs.writeFileSync(codexHooksPath, JSON.stringify(hooksConfig, null, 2))

        // 4. 生成 AGENTS.md 到 ~/Downloads/
        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-codex-${agentId}.md`)
        fs.writeFileSync(skillOutputPath, skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'windsurf') {
        // ---- Windsurf: MCP 配置 + 规则 .md 文件 ----

        // 1. 写入 Windsurf MCP 配置（全局）
        const windsurfConfigPath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
        let windsurfConfig: any = {}
        if (fs.existsSync(windsurfConfigPath)) {
          windsurfConfig = JSON.parse(fs.readFileSync(windsurfConfigPath, 'utf-8'))
        }
        if (!windsurfConfig.mcpServers) windsurfConfig.mcpServers = {}
        windsurfConfig.mcpServers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        const windsurfConfigDir = path.dirname(windsurfConfigPath)
        if (!fs.existsSync(windsurfConfigDir)) fs.mkdirSync(windsurfConfigDir, { recursive: true })
        fs.writeFileSync(windsurfConfigPath, JSON.stringify(windsurfConfig, null, 2))

        // 2. 生成规则 .md 文件到 ~/Downloads/（用户复制到项目 .windsurf/rules/）
        const windsurfFrontmatter = [
          '---',
          `trigger: always_on`,
          `description: "${config.skillDescription}"`,
          '---',
          '',
        ].join('\n')
        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-windsurf-${agentId}.md`)
        fs.writeFileSync(skillOutputPath, windsurfFrontmatter + skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'openclaw') {
        // ---- OpenClaw: MCP 配置 + Bootstrap Hook + Skill 目录 ----
        const openclawHome = path.join(os.homedir(), '.openclaw')

        // 1. 写入 MCP 配置到 openclaw.json（路径是 mcp.servers，不是 mcpServers）
        const openclawConfigPath = path.join(openclawHome, 'openclaw.json')
        let openclawConfig: any = {}
        if (fs.existsSync(openclawConfigPath)) {
          openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'))
        }
        if (!openclawConfig.mcp) openclawConfig.mcp = {}
        if (!openclawConfig.mcp.servers) openclawConfig.mcp.servers = {}
        openclawConfig.mcp.servers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        if (!fs.existsSync(openclawHome)) fs.mkdirSync(openclawHome, { recursive: true })
        fs.writeFileSync(openclawConfigPath, JSON.stringify(openclawConfig, null, 2))

        // 2. 生成 Bootstrap Hook 目录到 ~/.openclaw/hooks/
        const hookDirName = `tidemind-${agentId}`
        const hookDir = path.join(openclawHome, 'hooks', hookDirName)
        fs.mkdirSync(hookDir, { recursive: true })

        const skillFilePath = path.join(skillDir, config.skillSource)

        // HOOK.md
        fs.writeFileSync(path.join(hookDir, 'HOOK.md'), [
          '---',
          `name: ${hookDirName}`,
          `description: "Tide Mind — 自动加载外脑上下文"`,
          'metadata:',
          '  openclaw:',
          '    emoji: "🧠"',
          '    events: ["agent:bootstrap"]',
          '---',
          '',
          '在 Agent Bootstrap 时自动调用 Tide Mind 的 prepare 接口，将用户画像、记忆索引和行为指导注入为 MEMORY.md。',
        ].join('\n'))

        // handler.ts —— 用 spawnSync 传递参数数组，避免 shell 字符串拼接的转义问题
        fs.writeFileSync(path.join(hookDir, 'handler.ts'), [
          `import { spawnSync } from 'child_process'`,
          '',
          `const SHIM = ${JSON.stringify(shimPath)}`,
          `const HOOK_SCRIPT = ${JSON.stringify(hookScriptPath)}`,
          `const SKILL_PATH = ${JSON.stringify(skillFilePath)}`,
          `const AGENT_ID = ${JSON.stringify(agentId)}`,
          '',
          'const handler = async (event: any) => {',
          `  if (event.type !== 'agent' || event.action !== 'bootstrap') return`,
          '  try {',
          `    const result = spawnSync(SHIM, [HOOK_SCRIPT, '--agent-id', AGENT_ID, '--skill-path', SKILL_PATH, '--tool', 'openclaw'], {`,
          '      timeout: 15000,',
          `      encoding: 'utf-8',`,
          '    })',
          `    const output = result.stdout ?? ''`,
          '    if (output.trim() && event.context.bootstrapFiles) {',
          `      event.context.bootstrapFiles.push({ name: 'MEMORY.md', content: output })`,
          '    }',
          '  } catch { /* prepare 失败不阻断启动 */ }',
          '}',
          '',
          'export default handler',
          '',
        ].join('\n'))

        // 3. 生成 Skill 目录到 ~/Downloads/
        const skillOutputDir = path.join(os.homedir(), 'Downloads', `tidemind-openclaw-${agentId}`)
        fs.mkdirSync(skillOutputDir, { recursive: true })
        const openclawFrontmatter = [
          '---',
          `name: "tidemind"`,
          `description: "${config.skillDescription}"`,
          '---',
          '',
        ].join('\n')
        fs.writeFileSync(path.join(skillOutputDir, 'SKILL.md'), openclawFrontmatter + skillContent)

        return { pluginDir: skillOutputDir, pluginName, marketplaceRegistered: false, success: true }
      }

      // ---- Claude Code: 生成完整 Plugin 目录 ----
      fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true })
      fs.mkdirSync(path.join(pluginDir, 'skills', 'tidemind'), { recursive: true })

      // plugin.json
      fs.writeFileSync(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: pluginName,
          version: '1.0.0',
          description: `外部记忆系统 — ${agentName}`,
          author: { name: 'TideMind' },
        }, null, 2),
      )

      // .mcp.json
      fs.writeFileSync(
        path.join(pluginDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'tidemind': {
              command: shimPath,
              args: [mcpServerPath],
              env: { EB_AGENT_ID: agentId },
            },
          },
        }, null, 2),
      )

      // SKILL.md（Claude Code 版本不需要 name，Plugin 自带命名）
      const frontmatter = [
        '---',
        `description: "${config.skillDescription}"`,
        '---',
        '',
      ].join('\n')
      fs.writeFileSync(
        path.join(pluginDir, 'skills', 'tidemind', 'SKILL.md'),
        frontmatter + skillContent,
      )

      // hooks.json —— command 是 shell 字符串，所有路径用 JSON.stringify 做双引号转义
      fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true })
      const skillFilePath = path.join(pluginDir, 'skills', 'tidemind', 'SKILL.md')
      const hookCommand = [
        JSON.stringify(shimPath),
        JSON.stringify(hookScriptPath),
        '--agent-id', JSON.stringify(agentId),
        '--skill-path', JSON.stringify(skillFilePath),
        '--tool', JSON.stringify(config.hookToolParam),
      ].join(' ')
      fs.writeFileSync(
        path.join(pluginDir, 'hooks', 'hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: hookCommand,
                    timeout: 15000,
                    statusMessage: '加载外脑上下文...',
                  },
                ],
              },
            ],
            PreCompact: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'echo "上下文即将被压缩。请检查对话中是否有尚未 brain_digest 的重要信息，如有请立刻 digest。"',
                    statusMessage: '检查未保存的记忆...',
                  },
                ],
              },
            ],
          },
        }, null, 2),
      )

      // 生成/更新本地 marketplace
      // 使用 repairMarketplaceJson 统一处理顶层字段 + 过滤旧 external-brain-* 条目
      let marketplaceRegistered = false
      const marketplaceDir = path.join(pluginsDir, '.claude-plugin')
      fs.mkdirSync(marketplaceDir, { recursive: true })

      const marketplacePath = path.join(marketplaceDir, 'marketplace.json')
      let existing: any = null
      if (fs.existsSync(marketplacePath)) {
        try {
          existing = JSON.parse(fs.readFileSync(marketplacePath, 'utf-8'))
        } catch { /* 解析失败就当空 */ }
      }
      const { output: marketplace } = repairMarketplaceJson(existing)
      // TS narrowing: repaired output 的 plugins 始终是数组
      marketplace.plugins = marketplace.plugins ?? []

      const existingIdx = marketplace.plugins.findIndex((p: any) => p.name === pluginName)
      const pluginEntry = {
        name: pluginName,
        description: `外部记忆系统 — ${agentName}`,
        source: `./${pluginDirName}`,
      }
      if (existingIdx >= 0) {
        marketplace.plugins[existingIdx] = pluginEntry
      } else {
        marketplace.plugins.push(pluginEntry)
      }
      fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2))

      // 注册 marketplace 到 Claude Code settings.json
      // 注意：settings.json.extraKnownMarketplaces 只是"已知列表"，Claude Code 启动时据此初始化
      // 内部 marketplace state。Claude 的内部状态是独立的（用 `claude plugin marketplace list` 能看到），
      // 真正的 add/remove 要走 install-plugin handler 里的 CLI 命令。这里只管文件。
      try {
        let settings: any = {}
        if (fs.existsSync(claudeSettingsPath)) {
          settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'))
        }

        // 一次性过渡清理：删除遗留的 external-brain-local 条目
        const { output: cleanedSettings, changed: settingsChanged } = repairClaudeSettings(settings)
        settings = cleanedSettings

        if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {}
        let addedNew = false
        if (!settings.extraKnownMarketplaces[MARKETPLACE_ID]) {
          settings.extraKnownMarketplaces[MARKETPLACE_ID] = {
            source: { source: 'directory', path: pluginsDir },
          }
          addedNew = true
        }
        if (settingsChanged || addedNew) {
          fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2))
        }
        marketplaceRegistered = true
      } catch { /* 注册失败不阻塞 */ }

      return { pluginDir, pluginName, marketplaceRegistered, success: true }
    } catch (err: any) {
      return { pluginDir, pluginName, marketplaceRegistered: false, success: false, error: err.message }
    }
  })

  // ----------------------------------------------------------
  // 检测 claude CLI 是否可用
  // ----------------------------------------------------------
  ipcMain.handle('agents:check-cli', async (_e, cli: string): Promise<{ available: boolean; path?: string }> => {
    try {
      // macOS 上 which 可能找不到 GUI 启动的进程路径，也检查常见位置
      const candidates = [cli, `/opt/homebrew/bin/${cli}`, `/usr/local/bin/${cli}`]
      for (const candidate of candidates) {
        try {
          await execFileAsync(candidate, ['--version'], { timeout: 5000 })
          return { available: true, path: candidate }
        } catch { /* 继续尝试 */ }
      }
      // fallback: which
      const { stdout } = await execFileAsync('which', [cli])
      const cliPath = stdout.trim()
      return { available: !!cliPath, path: cliPath || undefined }
    } catch {
      return { available: false }
    }
  })

  // ----------------------------------------------------------
  // 安装插件到 Claude Code（通过 marketplace）
  // ----------------------------------------------------------
  ipcMain.handle('agents:install-plugin', async (_e, pluginName: string): Promise<PluginInstallResult> => {
    const cliEnv = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` }

    try {
      // 一次性过渡清理：移除 Claude Code 内部状态里遗留的 external-brain-local marketplace。
      // 注意 Claude 的 marketplace 注册是独立于 settings.json 的内部状态，
      // `claude plugin marketplace list` 能看到、`remove` 能清掉。
      // 不 remove 就 add 同一目录的话，Claude 仍用旧 name 缓存，导致 install 时报
      // "Plugin X not found in marketplace tidemind-local"。
      try {
        await execFileAsync('claude', ['plugin', 'marketplace', 'remove', 'external-brain-local'], {
          timeout: 10000,
          env: cliEnv,
        })
      } catch {
        // 不存在就忽略
      }

      // 确保 marketplace 已注册到 CLI（extraKnownMarketplaces 只写 settings.json，CLI 需要 add 才能索引）
      try {
        await execFileAsync('claude', ['plugin', 'marketplace', 'add', pluginsDir], {
          timeout: 15000,
          env: cliEnv,
        })
      } catch {
        // 已存在时会报错，忽略
      }

      const installArg = `${pluginName}@${MARKETPLACE_ID}`
      const { stdout, stderr } = await execFileAsync('claude', ['plugin', 'install', installArg, '--scope', 'user'], {
        timeout: 30000,
        env: cliEnv,
      })
      return { success: true, output: stdout || stderr }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message }
    }
  })

  // ----------------------------------------------------------
  // 获取已生成的插件信息
  // ----------------------------------------------------------
  ipcMain.handle('agents:plugin-path', (_e, agentId: string, toolType?: string): string | null => {
    const clientType = toolType && isPluginClientType(toolType) ? toolType : undefined

    // 非 Claude Code 类型：返回 Downloads 中的 Skill 文件路径
    if (clientType === 'cowork') {
      const p = path.join(os.homedir(), 'Downloads', `tidemind-skill-${agentId}.md`)
      return fs.existsSync(p) ? p : null
    }
    if (clientType === 'cursor') {
      const p = path.join(os.homedir(), 'Downloads', `tidemind-cursor-${agentId}.mdc`)
      return fs.existsSync(p) ? p : null
    }
    if (clientType === 'codex') {
      const p = path.join(os.homedir(), 'Downloads', `tidemind-codex-${agentId}.md`)
      return fs.existsSync(p) ? p : null
    }
    if (clientType === 'windsurf') {
      const p = path.join(os.homedir(), 'Downloads', `tidemind-windsurf-${agentId}.md`)
      return fs.existsSync(p) ? p : null
    }
    if (clientType === 'openclaw') {
      const p = path.join(os.homedir(), 'Downloads', `tidemind-openclaw-${agentId}`, 'SKILL.md')
      return fs.existsSync(p) ? p : null
    }

    // Claude Code：检查 Plugin 目录
    const prefixes = clientType
      ? [CLIENT_CONFIG[clientType].dirPrefix]
      : Object.values(CLIENT_CONFIG).map(c => c.dirPrefix)

    for (const prefix of prefixes) {
      const pluginDir = path.join(pluginsDir, `${prefix}-${agentId}`)
      if (fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'))) {
        return pluginDir
      }
    }
    return null
  })

  // ----------------------------------------------------------
  // 获取插件详细状态（Skill 文件、工具列表、是否过期）
  // ----------------------------------------------------------
  ipcMain.handle('agents:plugin-status', (_e, agentId: string, toolType?: string) => {
    const clientType: PluginClientType = isPluginClientType(toolType ?? '') ? toolType as PluginClientType : 'claude-code'
    const config = CLIENT_CONFIG[clientType]
    const pluginDirName = `${config.dirPrefix}-${agentId}`
    const pluginDir = path.join(pluginsDir, pluginDirName)
    const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json')

    // Cowork / Cursor / Codex / Windsurf: 没有 .claude-plugin 目录，通过配置文件和 Skill 文件判断
    if (clientType === 'cowork') {
      const desktopConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      let desktopConfigWritten = false
      if (fs.existsSync(desktopConfigPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
          desktopConfigWritten = !!cfg.mcpServers?.[`tidemind-${agentId}`]
        } catch { /* 解析失败 */ }
      }
      const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-skill-${agentId}.md`)
      const skillOutputExists = fs.existsSync(skillOutputPath)
      const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']
      return {
        exists: desktopConfigWritten || skillOutputExists,
        pluginDir: skillOutputPath,
        clientType,
        tools,
        skillOutputPath,
        skillOutputExists,
        desktopConfigWritten,
      }
    }

    if (clientType === 'cursor') {
      const cursorConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json')
      let cursorConfigWritten = false
      if (fs.existsSync(cursorConfigPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cursorConfigPath, 'utf-8'))
          cursorConfigWritten = !!cfg.mcpServers?.[`tidemind-${agentId}`]
        } catch { /* 解析失败 */ }
      }
      const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-cursor-${agentId}.mdc`)
      const skillOutputExists = fs.existsSync(skillOutputPath)
      const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']
      return {
        exists: cursorConfigWritten || skillOutputExists,
        pluginDir: skillOutputPath,
        clientType,
        tools,
        skillOutputPath,
        skillOutputExists,
        cursorConfigWritten,
      }
    }

    if (clientType === 'codex') {
      const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')
      let codexConfigWritten = false
      if (fs.existsSync(codexConfigPath)) {
        const content = fs.readFileSync(codexConfigPath, 'utf-8')
        codexConfigWritten = content.includes(`[mcp_servers.tidemind-${agentId}]`)
      }
      const codexHooksPath = path.join(os.homedir(), '.codex', 'hooks.json')
      let hooksConfigured = false
      if (fs.existsSync(codexHooksPath)) {
        try {
          const hooks = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'))
          const agentIdToken = `--agent-id ${JSON.stringify(agentId)}`
          hooksConfigured = hooks.hooks?.SessionStart?.some((group: any) =>
            group.hooks?.some((h: any) => h.command?.includes(agentIdToken)),
          ) ?? false
        } catch { /* 忽略 */ }
      }
      const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-codex-${agentId}.md`)
      const skillOutputExists = fs.existsSync(skillOutputPath)
      const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']
      return {
        exists: codexConfigWritten || skillOutputExists,
        pluginDir: skillOutputPath,
        clientType,
        tools,
        skillOutputPath,
        skillOutputExists,
        codexConfigWritten,
        hooksConfigured,
      }
    }

    if (clientType === 'windsurf') {
      const windsurfConfigPath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
      let windsurfConfigWritten = false
      if (fs.existsSync(windsurfConfigPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(windsurfConfigPath, 'utf-8'))
          windsurfConfigWritten = !!cfg.mcpServers?.[`tidemind-${agentId}`]
        } catch { /* 解析失败 */ }
      }
      const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-windsurf-${agentId}.md`)
      const skillOutputExists = fs.existsSync(skillOutputPath)
      const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']
      return {
        exists: windsurfConfigWritten || skillOutputExists,
        pluginDir: skillOutputPath,
        clientType,
        tools,
        skillOutputPath,
        skillOutputExists,
        windsurfConfigWritten,
      }
    }

    if (clientType === 'openclaw') {
      const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
      let openclawConfigWritten = false
      if (fs.existsSync(openclawConfigPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'))
          openclawConfigWritten = !!cfg.mcp?.servers?.[`tidemind-${agentId}`]
        } catch { /* 解析失败 */ }
      }
      const hookDir = path.join(os.homedir(), '.openclaw', 'hooks', `tidemind-${agentId}`)
      const hooksConfigured = fs.existsSync(path.join(hookDir, 'handler.ts'))
      const skillOutputDir = path.join(os.homedir(), 'Downloads', `tidemind-openclaw-${agentId}`)
      const skillOutputPath = path.join(skillOutputDir, 'SKILL.md')
      const skillOutputExists = fs.existsSync(skillOutputPath)
      const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']
      return {
        exists: openclawConfigWritten || skillOutputExists,
        pluginDir: skillOutputDir,
        clientType,
        tools,
        skillOutputPath: skillOutputDir,
        skillOutputExists,
        openclawConfigWritten,
        hooksConfigured,
      }
    }

    if (!fs.existsSync(pluginJsonPath)) {
      return { exists: false }
    }

    // 判断用的是哪个 Skill 源文件
    const primarySkillPath = path.join(skillDir, config.skillSource)
    const sourceSkillPath = fs.existsSync(primarySkillPath)
      ? primarySkillPath
      : path.join(skillDir, 'base-skill.md')
    const sourceSkillName = path.basename(sourceSkillPath)

    // 对比源文件和插件中 SKILL.md 的修改时间
    const pluginSkillPath = path.join(pluginDir, 'skills', 'tidemind', 'SKILL.md')
    let skillOutdated = false
    let generatedAt = ''
    if (fs.existsSync(pluginSkillPath) && fs.existsSync(sourceSkillPath)) {
      const sourceMtime = fs.statSync(sourceSkillPath).mtimeMs
      const pluginMtime = fs.statSync(pluginSkillPath).mtimeMs
      skillOutdated = sourceMtime > pluginMtime
      generatedAt = fs.statSync(pluginSkillPath).mtime.toISOString()
    }

    const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']

    // Claude Cowork: 检查 Skill 文件是否已生成到 Downloads
    const skillOutputPath = clientType === 'cowork'
      ? path.join(os.homedir(), 'Downloads', `tidemind-skill-${agentId}.md`)
      : undefined
    const skillOutputExists = skillOutputPath ? fs.existsSync(skillOutputPath) : undefined

    return {
      exists: true,
      pluginDir,
      clientType,
      skillFile: sourceSkillName,
      generatedAt,
      skillOutdated,
      tools,
      skillOutputPath,
      skillOutputExists,
    }
  })

  // ----------------------------------------------------------
  // 卸载插件
  // ----------------------------------------------------------
  ipcMain.handle('agents:uninstall-plugin', async (_e, agentId: string, toolType?: string): Promise<PluginInstallResult> => {
    const clientType: PluginClientType = isPluginClientType(toolType ?? '') ? toolType as PluginClientType : 'claude-code'
    const config = CLIENT_CONFIG[clientType]
    const pluginName = `tidemind-${agentId}`
    const pluginDirName = `${config.dirPrefix}-${agentId}`
    const pluginDir = path.join(pluginsDir, pluginDirName)
    const cliEnv = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` }

    const errors: string[] = []

    // Claude Code: 从 CLI 卸载 + marketplace 移除
    if (clientType === 'claude-code') {
      try {
        await execFileAsync('claude', ['plugin', 'uninstall', `${pluginName}@${MARKETPLACE_ID}`], {
          timeout: 15000,
          env: cliEnv,
        })
      } catch { /* 可能已经卸载了 */ }

      try {
        const marketplacePath = path.join(pluginsDir, '.claude-plugin', 'marketplace.json')
        if (fs.existsSync(marketplacePath)) {
          const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf-8'))
          marketplace.plugins = marketplace.plugins.filter((p: any) => p.name !== pluginName)
          fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2))
        }
      } catch (err: any) {
        errors.push(`更新 marketplace 失败: ${err.message}`)
      }
    }

    // Claude Cowork: 移除 Desktop config 条目 + 删除 Skill 文件
    if (clientType === 'cowork') {
      try {
        const desktopConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        if (fs.existsSync(desktopConfigPath)) {
          const desktopConfig = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
          if (desktopConfig.mcpServers) {
            delete desktopConfig.mcpServers[`tidemind-${agentId}`]
            if (Object.keys(desktopConfig.mcpServers).length === 0) delete desktopConfig.mcpServers
            fs.writeFileSync(desktopConfigPath, JSON.stringify(desktopConfig, null, 2))
          }
        }
      } catch (err: any) {
        errors.push(`移除 Desktop 配置失败: ${err.message}`)
      }

      // 删除生成的 Skill 文件
      const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-skill-${agentId}.md`)
      try {
        if (fs.existsSync(skillOutputPath)) fs.unlinkSync(skillOutputPath)
      } catch { /* 忽略 */ }
    }

    // Cursor: 移除 MCP 配置条目 + 删除 Skill .mdc 文件
    if (clientType === 'cursor') {
      try {
        const cursorConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json')
        if (fs.existsSync(cursorConfigPath)) {
          const cursorConfig = JSON.parse(fs.readFileSync(cursorConfigPath, 'utf-8'))
          if (cursorConfig.mcpServers) {
            delete cursorConfig.mcpServers[`tidemind-${agentId}`]
            if (Object.keys(cursorConfig.mcpServers).length === 0) delete cursorConfig.mcpServers
            fs.writeFileSync(cursorConfigPath, JSON.stringify(cursorConfig, null, 2))
          }
        }
      } catch (err: any) {
        errors.push(`移除 Cursor MCP 配置失败: ${err.message}`)
      }

      const cursorSkillPath = path.join(os.homedir(), 'Downloads', `tidemind-cursor-${agentId}.mdc`)
      try {
        if (fs.existsSync(cursorSkillPath)) fs.unlinkSync(cursorSkillPath)
      } catch { /* 忽略 */ }
    }

    // Codex: 移除 TOML MCP section + hooks + Skill 文件
    if (clientType === 'codex') {
      try {
        const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')
        removeTomlMcpSection(codexConfigPath, `tidemind-${agentId}`)
      } catch (err: any) {
        errors.push(`移除 Codex MCP 配置失败: ${err.message}`)
      }

      try {
        const codexHooksPath = path.join(os.homedir(), '.codex', 'hooks.json')
        if (fs.existsSync(codexHooksPath)) {
          const hooksConfig = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'))
          if (hooksConfig.hooks?.SessionStart) {
            // 写入时 command 里是 `--agent-id "eb_xxx"`（JSON.stringify 带双引号），
            // 过滤必须匹配带引号的形式，否则永远匹配不到导致卸载残留
            const agentIdToken = `--agent-id ${JSON.stringify(agentId)}`
            hooksConfig.hooks.SessionStart = hooksConfig.hooks.SessionStart.filter((group: any) =>
              !group.hooks?.some((h: any) => h.command?.includes(agentIdToken)),
            )
            if (hooksConfig.hooks.SessionStart.length === 0) delete hooksConfig.hooks.SessionStart
            fs.writeFileSync(codexHooksPath, JSON.stringify(hooksConfig, null, 2))
          }
        }
      } catch (err: any) {
        errors.push(`移除 Codex hooks 失败: ${err.message}`)
      }

      const codexSkillPath = path.join(os.homedir(), 'Downloads', `tidemind-codex-${agentId}.md`)
      try {
        if (fs.existsSync(codexSkillPath)) fs.unlinkSync(codexSkillPath)
      } catch { /* 忽略 */ }
    }

    // Windsurf: 移除 MCP 配置条目 + 删除规则文件
    if (clientType === 'windsurf') {
      try {
        const windsurfConfigPath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
        if (fs.existsSync(windsurfConfigPath)) {
          const windsurfConfig = JSON.parse(fs.readFileSync(windsurfConfigPath, 'utf-8'))
          if (windsurfConfig.mcpServers) {
            delete windsurfConfig.mcpServers[`tidemind-${agentId}`]
            if (Object.keys(windsurfConfig.mcpServers).length === 0) delete windsurfConfig.mcpServers
            fs.writeFileSync(windsurfConfigPath, JSON.stringify(windsurfConfig, null, 2))
          }
        }
      } catch (err: any) {
        errors.push(`移除 Windsurf MCP 配置失败: ${err.message}`)
      }

      const windsurfSkillPath = path.join(os.homedir(), 'Downloads', `tidemind-windsurf-${agentId}.md`)
      try {
        if (fs.existsSync(windsurfSkillPath)) fs.unlinkSync(windsurfSkillPath)
      } catch { /* 忽略 */ }
    }

    // OpenClaw: 移除 MCP 配置 + Hook 目录 + Skill 目录
    if (clientType === 'openclaw') {
      try {
        const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
        if (fs.existsSync(openclawConfigPath)) {
          const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf-8'))
          if (openclawConfig.mcp?.servers) {
            delete openclawConfig.mcp.servers[`tidemind-${agentId}`]
            if (Object.keys(openclawConfig.mcp.servers).length === 0) delete openclawConfig.mcp.servers
            fs.writeFileSync(openclawConfigPath, JSON.stringify(openclawConfig, null, 2))
          }
        }
      } catch (err: any) {
        errors.push(`移除 OpenClaw MCP 配置失败: ${err.message}`)
      }

      // 删除 Hook 目录
      const hookDir = path.join(os.homedir(), '.openclaw', 'hooks', `tidemind-${agentId}`)
      try {
        if (fs.existsSync(hookDir)) fs.rmSync(hookDir, { recursive: true, force: true })
      } catch { /* 忽略 */ }

      // 删除 Skill 目录
      const skillOutputDir = path.join(os.homedir(), 'Downloads', `tidemind-openclaw-${agentId}`)
      try {
        if (fs.existsSync(skillOutputDir)) fs.rmSync(skillOutputDir, { recursive: true, force: true })
      } catch { /* 忽略 */ }
    }

    // 通用：删除插件目录
    try {
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true })
      }
    } catch (err: any) {
      errors.push(`删除插件目录失败: ${err.message}`)
    }

    return errors.length > 0
      ? { success: false, error: errors.join('; ') }
      : { success: true }
  })
}
