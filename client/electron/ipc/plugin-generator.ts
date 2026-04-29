import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  getShimPath,
  getHookScriptPath,
  getPreCompactHookScriptPath,
  getPostCompactHookScriptPath,
  getMcpServerScriptPath,
} from '../runtime/runtime-paths'
import {
  repairMarketplaceJson,
  repairClaudeSettings,
} from '@server/utils/marketplace-repair.js'
import {
  assertPathWithinRoot,
} from './_validate'
import {
  parseAgentId,
  parseCliName,
  parsePluginClientType,
  parsePluginGenerateInput,
  parsePluginName,
} from './_schemas.js'

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
type PluginClientType = 'claude-code' | 'cowork' | 'cursor' | 'codex' | 'windsurf' | 'openclaw' | 'gemini'

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
  'gemini': {
    dirPrefix: 'gemini',
    skillSource: 'gemini-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。用户上下文在会话启动时通过 SessionStart Hook 自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'gemini',
  },
}

/**
 * 原子写文件：先写 `<path>.tmp-<pid>-<rand>`，再 rename 到真实路径。
 * POSIX rename 同目录下是原子的，可避免：
 *   1. 写入中途崩溃 → 留下 half-written / 截断的 JSON；
 *   2. 并发写 → 读者 readFileSync 命中中间态
 * 跨 client 配置都应走这个。
 */
function writeFileAtomic(realPath: string, data: string | Buffer, options?: { mode?: number }): void {
  const dir = path.dirname(realPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${realPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    fs.writeFileSync(tmpPath, data, options?.mode !== undefined ? { mode: options.mode } : undefined)
    fs.renameSync(tmpPath, realPath)
  } catch (err) {
    // 失败时清理 tmp 文件；不 rethrow 前先让原文件保持不变（rename 失败 realPath 未变）
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/**
 * 读入 JSON 文件。malformed 或不存在 → 返回传入的 fallback（通常是 {}）。
 * 这样写 handler 里不用每次处理 JSON.parse 抛错的噪声。
 */
function readJsonSafe<T extends Record<string, any>>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

import { appendTomlMcpSection, removeTomlMcpSection, ensureTomlFeatureFlag } from './toml-utils'
import {
  CODEX_V2_MIN_VERSION,
  codexMcpAdd,
  codexMcpRemove,
  detectCodexVersion,
  meetsMinVersion,
  wrapSkillWithFrontmatter,
} from './codex-cli'
import {
  geminiExtensionInstall,
  geminiExtensionUninstall,
  geminiExtensionList,
  stripFrontmatter,
} from './gemini-cli'

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
  const preCompactScriptPath = getPreCompactHookScriptPath()
  const postCompactScriptPath = getPostCompactHookScriptPath()
  const skillDir = path.join(dataDir, 'skill')
  const pluginsDir = path.join(dataDir, 'plugins')
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json')

  // ----------------------------------------------------------
  // 生成插件（Claude Code 或 Claude Cowork）
  // Claude Code: 生成完整 Plugin 目录（.mcp.json + Skill + Hook）
  // Claude Cowork: 写入 Desktop config + 生成 Skill .md 到 ~/Downloads/
  // ----------------------------------------------------------
  ipcMain.handle('agents:generate-plugin', async (_e, params: unknown): Promise<PluginGenerateResult> => {
    const parsed = parsePluginGenerateInput(params)
    if (!parsed.ok) {
      return {
        pluginDir: '',
        pluginName: '',
        marketplaceRegistered: false,
        success: false,
        error: parsed.error.details.join('; '),
      }
    }

    // 校验 agentId：拒掉所有不符合 `eb_<hex>` 形式的输入。
    // 这之前的 path.join(pluginsDir, `prefix-${agentId}`) 在 agentId="../../../etc/passwd" 时
    // 会逃出 ~/.tidemind/plugins/ 写到任意目录。
    const agentId = parsed.data.agentId
    const { agentName } = parsed.data
    const clientType: PluginClientType = parsed.data.clientType
    const config = CLIENT_CONFIG[clientType]
    const pluginDirName = `${config.dirPrefix}-${agentId}`
    const pluginName = `tidemind-${agentId}`
    const pluginDir = path.join(pluginsDir, pluginDirName)
    // 防御性纵深：即便正则被绕过，也确保 pluginDir 仍在 pluginsDir 之下
    assertPathWithinRoot(pluginDir, pluginsDir)

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

        // 1. 写入 Claude Desktop 配置（MCP 桥接）— 原子写，避免中途崩溃留半截 JSON
        const desktopConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        const desktopConfig = readJsonSafe<any>(desktopConfigPath, {})
        if (!desktopConfig.mcpServers) desktopConfig.mcpServers = {}
        desktopConfig.mcpServers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        writeFileAtomic(desktopConfigPath, JSON.stringify(desktopConfig, null, 2))

        // 2. 生成 Skill .md 文件到 ~/Downloads/（Claude Cowork Skills 上传需要 name + description）
        const skillFrontmatter = [
          '---',
          `name: "Tide Mind"`,
          `description: "${config.skillDescription}"`,
          '---',
          '',
        ].join('\n')
        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-skill-${agentId}.md`)
        writeFileAtomic(skillOutputPath, skillFrontmatter + skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'cursor') {
        // ---- Cursor: MCP 配置 + Skill .mdc 文件 ----

        // 1. 写入 Cursor MCP 配置（全局）— 原子写
        const cursorConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json')
        const cursorConfig = readJsonSafe<any>(cursorConfigPath, {})
        if (!cursorConfig.mcpServers) cursorConfig.mcpServers = {}
        cursorConfig.mcpServers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        writeFileAtomic(cursorConfigPath, JSON.stringify(cursorConfig, null, 2))

        // 2. 生成 Skill .mdc 文件到 ~/Downloads/（用户复制到项目 .cursor/rules/）
        const mdcFrontmatter = [
          '---',
          `description: "${config.skillDescription}"`,
          'alwaysApply: true',
          '---',
          '',
        ].join('\n')
        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-cursor-${agentId}.mdc`)
        writeFileAtomic(skillOutputPath, mdcFrontmatter + skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'codex') {
        const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')
        const codexHooksPath = path.join(os.homedir(), '.codex', 'hooks.json')
        const serverName = `tidemind-${agentId}`
        const codexVersion = await detectCodexVersion()
        const useV2 = meetsMinVersion(codexVersion, CODEX_V2_MIN_VERSION)

        // hooks.json 写入逻辑（v1/v2 共用）
        const writeSessionStartHook = (skillFilePath: string): void => {
          const hooksConfig: any = readJsonSafe<any>(codexHooksPath, { hooks: {} })
          if (!hooksConfig.hooks) hooksConfig.hooks = {}
          if (!hooksConfig.hooks.SessionStart) hooksConfig.hooks.SessionStart = []

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
          writeFileAtomic(codexHooksPath, JSON.stringify(hooksConfig, null, 2))
        }

        if (useV2) {
          // ---- v2 主路径：codex mcp add + 原生 Skills ----

          // 1. 用 Codex CLI 写 MCP 配置，转义/幂等交给官方实现
          await codexMcpAdd({
            serverName,
            command: shimPath,
            args: [mcpServerPath],
            env: { EB_AGENT_ID: agentId },
          })

          // 2. 启用 hooks feature flag（Codex 暂无 CLI 替代）
          ensureTomlFeatureFlag(codexConfigPath, 'codex_hooks')

          // 3. 写 SKILL.md 到 ~/.codex/skills/tidemind-<id>/，Codex 启动自动识别
          const skillRootDir = path.join(os.homedir(), '.codex', 'skills', serverName)
          const skillFilePath = path.join(skillRootDir, 'SKILL.md')
          if (!fs.existsSync(skillRootDir)) fs.mkdirSync(skillRootDir, { recursive: true })
          const skillBody = wrapSkillWithFrontmatter(skillContent, serverName, config.skillDescription)
          writeFileAtomic(skillFilePath, skillBody)

          // 4. 写 SessionStart hook（hook 脚本读取 SKILL.md 文件来注入会话上下文）
          writeSessionStartHook(skillFilePath)

          return { pluginDir: skillRootDir, pluginName, marketplaceRegistered: false, success: true }
        }

        // ---- v1 兜底路径：手写 TOML + Downloads/AGENTS.md（Codex <0.121 用） ----

        appendTomlMcpSection(codexConfigPath, serverName, {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        })

        ensureTomlFeatureFlag(codexConfigPath, 'codex_hooks')

        const skillFilePath = path.join(skillDir, config.skillSource)
        writeSessionStartHook(skillFilePath)

        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-codex-${agentId}.md`)
        writeFileAtomic(skillOutputPath, skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'windsurf') {
        // ---- Windsurf: MCP 配置 + 规则 .md 文件 ----

        // 1. 写入 Windsurf MCP 配置（全局）— 原子写
        const windsurfConfigPath = path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
        const windsurfConfig = readJsonSafe<any>(windsurfConfigPath, {})
        if (!windsurfConfig.mcpServers) windsurfConfig.mcpServers = {}
        windsurfConfig.mcpServers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        writeFileAtomic(windsurfConfigPath, JSON.stringify(windsurfConfig, null, 2))

        // 2. 生成规则 .md 文件到 ~/Downloads/（用户复制到项目 .windsurf/rules/）
        const windsurfFrontmatter = [
          '---',
          `trigger: always_on`,
          `description: "${config.skillDescription}"`,
          '---',
          '',
        ].join('\n')
        const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-windsurf-${agentId}.md`)
        writeFileAtomic(skillOutputPath, windsurfFrontmatter + skillContent)

        return { pluginDir: skillOutputPath, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'openclaw') {
        // ---- OpenClaw: MCP 配置 + Bootstrap Hook + Skill 目录 ----
        const openclawHome = path.join(os.homedir(), '.openclaw')

        // 1. 写入 MCP 配置到 openclaw.json（路径是 mcp.servers，不是 mcpServers）— 原子写
        const openclawConfigPath = path.join(openclawHome, 'openclaw.json')
        const openclawConfig = readJsonSafe<any>(openclawConfigPath, {})
        if (!openclawConfig.mcp) openclawConfig.mcp = {}
        if (!openclawConfig.mcp.servers) openclawConfig.mcp.servers = {}
        openclawConfig.mcp.servers[`tidemind-${agentId}`] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        writeFileAtomic(openclawConfigPath, JSON.stringify(openclawConfig, null, 2))

        // 2. 生成 Bootstrap Hook 目录到 ~/.openclaw/hooks/
        const hookDirName = `tidemind-${agentId}`
        const hookDir = path.join(openclawHome, 'hooks', hookDirName)
        fs.mkdirSync(hookDir, { recursive: true })

        const skillFilePath = path.join(skillDir, config.skillSource)

        // HOOK.md
        writeFileAtomic(path.join(hookDir, 'HOOK.md'), [
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
        writeFileAtomic(path.join(hookDir, 'handler.ts'), [
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
        writeFileAtomic(path.join(skillOutputDir, 'SKILL.md'), openclawFrontmatter + skillContent)

        return { pluginDir: skillOutputDir, pluginName, marketplaceRegistered: false, success: true }
      }

      if (clientType === 'gemini') {
        // ---- Gemini CLI: staging 目录 + `gemini extensions install --path` ----
        // Gemini extension 是聚合包：单目录里同时含 mcpServers / contextFile / hooks /
        // commands。我们走官方 CLI 安装入口（与 Codex v2 用 `codex mcp add` 同思路），
        // 让 Gemini CLI 把目录拷到 ~/.gemini/extensions/ 并写注册表。
        const extName = `tidemind-${agentId}`
        const stagingDir = path.join(pluginsDir, `${config.dirPrefix}-${agentId}`)
        // 兜底：staging 必须落在 pluginsDir 之下
        assertPathWithinRoot(stagingDir, pluginsDir)

        fs.mkdirSync(path.join(stagingDir, 'hooks'), { recursive: true })
        fs.mkdirSync(path.join(stagingDir, 'commands'), { recursive: true })

        // hook 触发时 staging 可能已经被重新生成或删除，所以 hook command 的
        // --skill-path 必须指向**安装后位置**而不是 staging 路径。
        const installedExtDir = path.join(os.homedir(), '.gemini', 'extensions', extName)
        const installedSkillPath = path.join(installedExtDir, 'GEMINI.md')

        // 1. gemini-extension.json
        writeFileAtomic(
          path.join(stagingDir, 'gemini-extension.json'),
          JSON.stringify({
            name: extName,
            version: '1.0.0',
            description: `Tide Mind 外部记忆系统 — ${agentName}`,
            mcpServers: {
              tidemind: {
                command: shimPath,
                args: [mcpServerPath],
                env: { EB_AGENT_ID: agentId },
              },
            },
            contextFileName: 'GEMINI.md',
            excludeTools: [],
          }, null, 2),
        )

        // 2. GEMINI.md（剥离 YAML frontmatter；Claude Code SKILL.md 模板的 frontmatter
        //    在 Gemini CLI 是噪音）
        const cleanSkill = stripFrontmatter(skillContent)
        writeFileAtomic(path.join(stagingDir, 'GEMINI.md'), cleanSkill)

        // 3. hooks/hooks.json —— matcher 直接用 `startup|resume` 排除 /clear，
        //    避免每次清屏都重跑 prepare。`session_start_reason` / `source` 字段是
        //    脚本内的二级兜底。
        const hookCommand = [
          JSON.stringify(shimPath),
          JSON.stringify(hookScriptPath),
          '--agent-id', JSON.stringify(agentId),
          '--skill-path', JSON.stringify(installedSkillPath),
          '--tool', JSON.stringify(config.hookToolParam),
        ].join(' ')
        writeFileAtomic(
          path.join(stagingDir, 'hooks', 'hooks.json'),
          JSON.stringify({
            hooks: {
              SessionStart: [
                {
                  matcher: 'startup|resume',
                  hooks: [
                    {
                      type: 'command',
                      command: hookCommand,
                      timeout: 15000,
                    },
                  ],
                },
              ],
            },
          }, null, 2),
        )

        // 4. commands/*.toml —— 从 data/skill/gemini-commands/ 原样拷贝
        const commandsSrcDir = path.join(skillDir, 'gemini-commands')
        const commandFiles = ['brain-recall.toml', 'brain-digest.toml', 'brain-forget.toml']
        for (const cmd of commandFiles) {
          const src = path.join(commandsSrcDir, cmd)
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(stagingDir, 'commands', cmd))
          }
          // 源文件缺失（dev 环境 / 安装包不完整）不阻断主流程，但需要可观测：
          // commands 缺失只是失去 slash 命令，MCP + hook 依然能工作。
        }

        // 5. 调 gemini CLI 安装。失败时 staging 已经写好，调用方可以让用户重试或
        //    手动 `gemini extensions install --path <stagingDir>`。
        try {
          await geminiExtensionInstall({ extName, stagingPath: stagingDir })
        } catch (err: any) {
          return {
            pluginDir: stagingDir,
            pluginName: extName,
            marketplaceRegistered: false,
            success: false,
            error: `gemini extensions install 失败: ${err?.stderr ?? err?.message ?? String(err)}`,
          }
        }

        return { pluginDir: stagingDir, pluginName: extName, marketplaceRegistered: false, success: true }
      }

      // ---- Claude Code: 生成完整 Plugin 目录 ----
      fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true })
      fs.mkdirSync(path.join(pluginDir, 'skills', 'tidemind'), { recursive: true })

      // plugin.json
      writeFileAtomic(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: pluginName,
          version: '1.0.0',
          description: `外部记忆系统 — ${agentName}`,
          author: { name: 'TideMind' },
        }, null, 2),
      )

      // .mcp.json
      writeFileAtomic(
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
      // - description: 用于 Claude 在启动时判断是否把该 skill 纳入候选
      // - when_to_use: 前置触发场景，提升自动命中率（和 description 共用 1536 字符预算）
      // - allowed-tools: 预批准 brain_* 工具，避免每次调用弹权限询问
      //   Claude Code 对 plugin 内的 MCP 工具命名方式有多种实际观测形态：
      //     - mcp__{server_key}__{tool}                 官方 permissions 文档示例
      //     - mcp__{plugin_name}__{tool}                plugin 命名空间 scoped
      //     - mcp__plugin_{plugin_name}_{server_key}__{tool}  早期 plugin 实现
      //   用 tool 名的通配后缀 `__brain_*` 兜底所有形态，确保任一实际命名都命中
      const frontmatter = [
        '---',
        `description: "${config.skillDescription}"`,
        'when_to_use: |',
        '  用户提起"之前"、"上次"、"记得吗"、过去的决定或观点时；',
        '  需要判断用户偏好、历史态度、长期目标时；',
        '  用户明确说"记住"、"别忘了"、"以后不要..."时；',
        '  每次完成实质性请求后、用户做出决策或表达观点时需要沉淀结论。',
        'allowed-tools:',
        '  - mcp__tidemind__brain_prepare',
        '  - mcp__tidemind__brain_recall',
        '  - mcp__tidemind__brain_digest',
        `  - mcp__${pluginName}__brain_prepare`,
        `  - mcp__${pluginName}__brain_recall`,
        `  - mcp__${pluginName}__brain_digest`,
        `  - mcp__plugin_${pluginName}_tidemind__brain_prepare`,
        `  - mcp__plugin_${pluginName}_tidemind__brain_recall`,
        `  - mcp__plugin_${pluginName}_tidemind__brain_digest`,
        '---',
        '',
      ].join('\n')
      writeFileAtomic(
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
      // PreCompact hook：压缩前提示模型检查未 digest 的重要信息
      const preCompactCommand = [
        JSON.stringify(shimPath),
        JSON.stringify(preCompactScriptPath),
        '--agent-id', JSON.stringify(agentId),
      ].join(' ')
      // PostCompact hook：压缩完成后重注一份精简的用户画像（brief 模式），
      // 防止长对话中早期注入的 [TIDE MIND — SESSION CONTEXT] 被压缩摘要吞掉
      const postCompactCommand = [
        JSON.stringify(shimPath),
        JSON.stringify(postCompactScriptPath),
        '--agent-id', JSON.stringify(agentId),
        '--tool', JSON.stringify(config.hookToolParam),
      ].join(' ')
      writeFileAtomic(
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
                    command: preCompactCommand,
                    // 脚本本身不调 DB，但 spawn shim + Electron-as-node cold start 本身约 1-2s
                    timeout: 10000,
                    statusMessage: '检查未保存的记忆...',
                  },
                ],
              },
            ],
            PostCompact: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: postCompactCommand,
                    timeout: 10000,
                    statusMessage: '恢复外脑上下文...',
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
      writeFileAtomic(marketplacePath, JSON.stringify(marketplace, null, 2))

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
          writeFileAtomic(claudeSettingsPath, JSON.stringify(settings, null, 2))
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
  ipcMain.handle('agents:check-cli', async (_e, cli: unknown): Promise<{ available: boolean; path?: string; version?: string }> => {
    // 白名单校验：cli 字符串会被传给 execFile + path.join，
    // 不卡名字就允许 renderer 探测/执行任意可执行文件
    const parsedCli = parseCliName(cli)
    if (!parsedCli.ok) return { available: false }
    const validCli = parsedCli.data
    const parseVersion = (stdout: string): string | undefined => {
      const m = stdout.match(/(\d+\.\d+\.\d+)/)
      return m ? m[1] : undefined
    }
    try {
      // macOS 上 which 可能找不到 GUI 启动的进程路径，也检查常见位置
      const candidates = [validCli, `/opt/homebrew/bin/${validCli}`, `/usr/local/bin/${validCli}`]
      for (const candidate of candidates) {
        try {
          const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 })
          return { available: true, path: candidate, version: parseVersion(stdout) }
        } catch { /* 继续尝试 */ }
      }
      // fallback: which
      const { stdout } = await execFileAsync('which', [validCli])
      const cliPath = stdout.trim()
      if (!cliPath) return { available: false }
      let version: string | undefined
      try {
        const { stdout: vOut } = await execFileAsync(cliPath, ['--version'], { timeout: 5000 })
        version = parseVersion(vOut)
      } catch { /* 版本获取失败不阻塞 */ }
      return { available: true, path: cliPath, version }
    } catch {
      return { available: false }
    }
  })

  // ----------------------------------------------------------
  // 安装插件到 Claude Code（通过 marketplace）
  // ----------------------------------------------------------
  ipcMain.handle('agents:install-plugin', async (_e, pluginName: unknown): Promise<PluginInstallResult> => {
    // pluginName 直接拼到 `claude plugin install <name>@marketplace` 命令，
    // 必须卡死格式（同时也是 path 安全的兜底，因为 install 后续可能拿它去查目录）
    const parsedPluginName = parsePluginName(pluginName)
    if (!parsedPluginName.ok) {
      return { success: false, error: parsedPluginName.error.details.join('; ') }
    }
    const validPluginName = parsedPluginName.data
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

      const installArg = `${validPluginName}@${MARKETPLACE_ID}`
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
  ipcMain.handle('agents:plugin-path', (_e, rawAgentId: unknown, toolType?: unknown): string | null => {
    // 任何拿 agentId 拼路径的入口都先校验 — 此处虽然只是 existsSync，
    // 但拼出非法路径仍可能被用作路径探测渠道，统一卡死
    const parsedAgentId = parseAgentId(rawAgentId)
    if (!parsedAgentId.ok) return null
    const agentId = parsedAgentId.data
    const parsedClientType = parsePluginClientType(toolType)
    if (!parsedClientType.ok) return null
    const clientType = parsedClientType.data

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
    if (clientType === 'gemini') {
      // staging 是「真相源」，installed 是 Gemini CLI 拷贝后的副本。
      // UI 关心的是「能否打开看 staging 内容」，返回 staging 的 manifest。
      const stagingDir = path.join(pluginsDir, `gemini-${agentId}`)
      return fs.existsSync(path.join(stagingDir, 'gemini-extension.json')) ? stagingDir : null
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
  // 注：handler 改为 async，因为 gemini 分支需要调 `gemini extensions list`。
  //     其他分支保持纯同步逻辑，不会被 Promise 包裹拖慢。
  // ----------------------------------------------------------
  ipcMain.handle('agents:plugin-status', async (_e, rawAgentId: unknown, toolType?: unknown) => {
    // 校验 agentId — 失败时返回 exists:false 而不是抛错，
    // renderer 拿不存在状态再决定是否报错（同 plugin-path 行为一致）
    const parsedAgentId = parseAgentId(rawAgentId)
    if (!parsedAgentId.ok) return { exists: false }
    const agentId = parsedAgentId.data
    const parsedClientType = parsePluginClientType(toolType)
    if (!parsedClientType.ok) return { exists: false }
    const clientType: PluginClientType = parsedClientType.data ?? 'claude-code'
    const config = CLIENT_CONFIG[clientType]
    const pluginDirName = `${config.dirPrefix}-${agentId}`
    const pluginDir = path.join(pluginsDir, pluginDirName)
    assertPathWithinRoot(pluginDir, pluginsDir)
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
      // v2：~/.codex/skills/tidemind-<id>/SKILL.md
      const skillRootDir = path.join(os.homedir(), '.codex', 'skills', `tidemind-${agentId}`)
      const skillDirWritten = fs.existsSync(path.join(skillRootDir, 'SKILL.md'))
      // v1：~/Downloads/tidemind-codex-<id>.md
      const skillOutputPath = path.join(os.homedir(), 'Downloads', `tidemind-codex-${agentId}.md`)
      const skillOutputExists = fs.existsSync(skillOutputPath)
      const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']
      return {
        exists: codexConfigWritten || skillOutputExists || skillDirWritten,
        pluginDir: skillDirWritten ? skillRootDir : skillOutputPath,
        clientType,
        tools,
        skillOutputPath,
        skillOutputExists,
        codexConfigWritten,
        hooksConfigured,
        skillDirWritten,
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

    if (clientType === 'gemini') {
      const extName = `tidemind-${agentId}`
      const stagingDir = path.join(pluginsDir, `gemini-${agentId}`)
      const installedDir = path.join(os.homedir(), '.gemini', 'extensions', extName)
      const stagingManifest = path.join(stagingDir, 'gemini-extension.json')
      const installedManifest = path.join(installedDir, 'gemini-extension.json')
      const stagingExists = fs.existsSync(stagingManifest)
      const installedExists = fs.existsSync(installedManifest)

      // CLI 注册表查询：失败（CLI 不存在 / 版本过低）→ null。UI 据此显示「未知」。
      // null 与 false 语义不同：null = 探测失败，false = 探测到了但没该条目。
      let registered: boolean | null = null
      const list = await geminiExtensionList()
      if (list !== null) {
        registered = list.some(line => line.includes(extName))
      }

      // mtime 对比：staging GEMINI.md 比 installed 新 → 提示用户重装
      let skillOutdated = false
      if (stagingExists && installedExists) {
        try {
          const stagingMtime = fs.statSync(path.join(stagingDir, 'GEMINI.md')).mtimeMs
          const installedMtime = fs.statSync(path.join(installedDir, 'GEMINI.md')).mtimeMs
          skillOutdated = stagingMtime > installedMtime
        } catch { /* 任一文件不存在视为 not outdated */ }
      }

      const tools: string[] = ['brain_prepare', 'brain_recall', 'brain_digest']
      const generatedAt = installedExists
        ? fs.statSync(installedManifest).mtime.toISOString()
        : (stagingExists ? fs.statSync(stagingManifest).mtime.toISOString() : '')
      return {
        exists: stagingExists || installedExists,
        pluginDir: installedExists ? installedDir : stagingDir,
        clientType,
        tools,
        stagingExists,
        installedExists,
        registered,
        skillOutdated,
        generatedAt,
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
    const skillOutputPath = undefined
    const skillOutputExists = undefined

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
  ipcMain.handle('agents:uninstall-plugin', async (_e, rawAgentId: unknown, toolType?: unknown): Promise<PluginInstallResult> => {
    // ⚠️ 这是最高危的入口：handler 会 fs.rmSync(pluginDir, {recursive:true,force:true}) +
    // ~/.openclaw/hooks/, ~/.codex/skills/, ~/Downloads/...
    // agentId="../../../Documents" 之前可以擦掉用户磁盘上的任意目录，必须先卡死格式
    const parsedAgentId = parseAgentId(rawAgentId)
    if (!parsedAgentId.ok) {
      return { success: false, error: parsedAgentId.error.details.join('; ') }
    }
    const agentId = parsedAgentId.data
    const parsedClientType = parsePluginClientType(toolType)
    if (!parsedClientType.ok) {
      return { success: false, error: parsedClientType.error.details.join('; ') }
    }
    const clientType: PluginClientType = parsedClientType.data ?? 'claude-code'
    const config = CLIENT_CONFIG[clientType]
    const pluginName = `tidemind-${agentId}`
    const pluginDirName = `${config.dirPrefix}-${agentId}`
    const pluginDir = path.join(pluginsDir, pluginDirName)
    // 防御纵深：在任何 fs 操作前 assert pluginDir 仍在 pluginsDir 之下
    assertPathWithinRoot(pluginDir, pluginsDir)
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
          const marketplace = readJsonSafe<any>(marketplacePath, { plugins: [] })
          marketplace.plugins = (marketplace.plugins ?? []).filter((p: any) => p.name !== pluginName)
          writeFileAtomic(marketplacePath, JSON.stringify(marketplace, null, 2))
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
          const desktopConfig = readJsonSafe<any>(desktopConfigPath, {})
          if (desktopConfig.mcpServers) {
            delete desktopConfig.mcpServers[`tidemind-${agentId}`]
            if (Object.keys(desktopConfig.mcpServers).length === 0) delete desktopConfig.mcpServers
            writeFileAtomic(desktopConfigPath, JSON.stringify(desktopConfig, null, 2))
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
          const cursorConfig = readJsonSafe<any>(cursorConfigPath, {})
          if (cursorConfig.mcpServers) {
            delete cursorConfig.mcpServers[`tidemind-${agentId}`]
            if (Object.keys(cursorConfig.mcpServers).length === 0) delete cursorConfig.mcpServers
            writeFileAtomic(cursorConfigPath, JSON.stringify(cursorConfig, null, 2))
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

    // Codex: 清理 MCP + hooks + Skills 目录 + Downloads（同时处理 v1/v2 两种历史装法）
    if (clientType === 'codex') {
      const serverName = `tidemind-${agentId}`

      // 1a. 优先用 CLI 卸载（v2 装法；CLI 不存在或旧版本时容错跳过）
      try {
        await codexMcpRemove({ serverName })
      } catch { /* 忽略，下一步 TOML 兜底 */ }

      // 1b. 兜底：从 TOML 手工删除 section（处理 v1 装法 + 上一步失败的情况）
      try {
        const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')
        removeTomlMcpSection(codexConfigPath, serverName)
      } catch (err: any) {
        errors.push(`移除 Codex MCP 配置失败: ${err.message}`)
      }

      // 2. 清理 hooks.json 中的 SessionStart hook
      try {
        const codexHooksPath = path.join(os.homedir(), '.codex', 'hooks.json')
        if (fs.existsSync(codexHooksPath)) {
          const hooksConfig = readJsonSafe<any>(codexHooksPath, {})
          if (hooksConfig.hooks?.SessionStart) {
            // 写入时 command 里是 `--agent-id "eb_xxx"`（JSON.stringify 带双引号），
            // 过滤必须匹配带引号的形式，否则永远匹配不到导致卸载残留
            const agentIdToken = `--agent-id ${JSON.stringify(agentId)}`
            hooksConfig.hooks.SessionStart = hooksConfig.hooks.SessionStart.filter((group: any) =>
              !group.hooks?.some((h: any) => h.command?.includes(agentIdToken)),
            )
            if (hooksConfig.hooks.SessionStart.length === 0) delete hooksConfig.hooks.SessionStart
            writeFileAtomic(codexHooksPath, JSON.stringify(hooksConfig, null, 2))
          }
        }
      } catch (err: any) {
        errors.push(`移除 Codex hooks 失败: ${err.message}`)
      }

      // 3. 清理 v2 的原生 Skills 目录（不存在时 no-op）
      try {
        const skillRoot = path.join(os.homedir(), '.codex', 'skills')
        const skillRootDir = path.join(skillRoot, serverName)
        assertPathWithinRoot(skillRootDir, skillRoot)
        fs.rmSync(skillRootDir, { recursive: true, force: true })
      } catch { /* 忽略 */ }

      // 4. 清理 v1 遗留的 Downloads/AGENTS.md
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
          const windsurfConfig = readJsonSafe<any>(windsurfConfigPath, {})
          if (windsurfConfig.mcpServers) {
            delete windsurfConfig.mcpServers[`tidemind-${agentId}`]
            if (Object.keys(windsurfConfig.mcpServers).length === 0) delete windsurfConfig.mcpServers
            writeFileAtomic(windsurfConfigPath, JSON.stringify(windsurfConfig, null, 2))
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

    // Gemini CLI: 三层防御（CLI uninstall → 手工删 ~/.gemini/extensions/<n>/ → 清 staging）
    if (clientType === 'gemini') {
      const extName = `tidemind-${agentId}`
      // 1. 主路径：调 gemini CLI 卸载（不存在视为成功）
      try {
        await geminiExtensionUninstall({ extName })
      } catch (err: any) {
        errors.push(`gemini extensions uninstall 失败: ${err?.stderr ?? err?.message ?? String(err)}`)
      }
      // 2. 兜底：CLI 不存在 / 版本过低 / 卸载失败时手工删 ~/.gemini/extensions/<n>/
      try {
        const installedRoot = path.join(os.homedir(), '.gemini', 'extensions')
        const installedDir = path.join(installedRoot, extName)
        assertPathWithinRoot(installedDir, installedRoot)
        if (fs.existsSync(installedDir)) fs.rmSync(installedDir, { recursive: true, force: true })
      } catch { /* 忽略 */ }
      // 3. 清 staging（同时也是 pluginDir 的一部分，下面通用清理会再处理一次，
      //    这里显式删一次更清晰；assertPathWithinRoot 是必走的安全门）
      try {
        const stagingDir = path.join(pluginsDir, `gemini-${agentId}`)
        assertPathWithinRoot(stagingDir, pluginsDir)
        if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true })
      } catch (err: any) {
        errors.push(`删除 Gemini staging 失败: ${err.message}`)
      }
    }

    // OpenClaw: 移除 MCP 配置 + Hook 目录 + Skill 目录
    if (clientType === 'openclaw') {
      try {
        const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
        if (fs.existsSync(openclawConfigPath)) {
          const openclawConfig = readJsonSafe<any>(openclawConfigPath, {})
          if (openclawConfig.mcp?.servers) {
            delete openclawConfig.mcp.servers[`tidemind-${agentId}`]
            if (Object.keys(openclawConfig.mcp.servers).length === 0) delete openclawConfig.mcp.servers
            writeFileAtomic(openclawConfigPath, JSON.stringify(openclawConfig, null, 2))
          }
        }
      } catch (err: any) {
        errors.push(`移除 OpenClaw MCP 配置失败: ${err.message}`)
      }

      // 删除 Hook 目录
      const openclawHooksRoot = path.join(os.homedir(), '.openclaw', 'hooks')
      const hookDir = path.join(openclawHooksRoot, `tidemind-${agentId}`)
      try {
        assertPathWithinRoot(hookDir, openclawHooksRoot)
        if (fs.existsSync(hookDir)) fs.rmSync(hookDir, { recursive: true, force: true })
      } catch { /* 忽略 */ }

      // 删除 Skill 目录
      const downloadsRoot = path.join(os.homedir(), 'Downloads')
      const skillOutputDir = path.join(downloadsRoot, `tidemind-openclaw-${agentId}`)
      try {
        assertPathWithinRoot(skillOutputDir, downloadsRoot)
        if (fs.existsSync(skillOutputDir)) fs.rmSync(skillOutputDir, { recursive: true, force: true })
      } catch { /* 忽略 */ }
    }

    // 通用：删除插件目录（再 assert 一次，确保 pluginDir 没被中途篡改）
    try {
      assertPathWithinRoot(pluginDir, pluginsDir)
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
