import fs from 'node:fs'
import path from 'node:path'
import { assertPathWithinRoot } from '../_validate'
import { wrapSkillWithFrontmatter } from '../codex-cli'
import { ensureTomlHook, hasTomlHook, removeTomlHook } from '../toml-utils'
import { readJsonStrict, writeFileAtomic, writeJsonAtomic } from './fs-utils'
import { mcpServerEntry } from './paths'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

// Kimi Code 集成的三件套(与 Codex v2 同构):
//   1. MCP server  → <kimiHome>/mcp.json      (mcpServers["tidemind-<agentId>"])
//   2. Skill       → <kimiHome>/skills/tidemind-<agentId>/SKILL.md
//   3. Hook        → <kimiHome>/config.toml   ([[hooks]] UserPromptSubmit + --once-per-session)
// <kimiHome> 默认 ~/.kimi-code,支持 KIMI_CODE_HOME 环境变量覆盖。
// 这三个文件都归 Kimi CLI 所有,只追加/精准删除,绝不整体重写。
//
// 为什么 hook 是 UserPromptSubmit 而不是 SessionStart:Kimi Code 0.29.0 的
// SessionStart hook 输出不会注入会话上下文(二进制分析 + 真机实测确认结果被
// 丢弃),只有 UserPromptSubmit 的 stdout 会以 <hook_result> 用户消息注入。
// UserPromptSubmit 每条消息都触发,因此 hook 脚本侧用 --once-per-session
// 保证每会话只注入一次。

/** Kimi 配置根目录:KIMI_CODE_HOME 优先,默认 ~/.kimi-code。 */
function kimiHome(ctx: PluginLookupContext): string {
  return process.env.KIMI_CODE_HOME || path.join(ctx.runtime.homeDir, '.kimi-code')
}

function kimiMcpPath(ctx: PluginLookupContext): string {
  return path.join(kimiHome(ctx), 'mcp.json')
}

function kimiConfigPath(ctx: PluginLookupContext): string {
  return path.join(kimiHome(ctx), 'config.toml')
}

function serverName(ctx: PluginLookupContext): string {
  return `tidemind-${ctx.agentId}`
}

function skillRootDir(ctx: PluginLookupContext): string {
  return path.join(kimiHome(ctx), 'skills', serverName(ctx))
}

/** [[hooks]] 幂等/定位标记:command 里的 `--agent-id "<id>"` 片段。 */
function agentIdToken(ctx: PluginLookupContext): string {
  return `--agent-id ${JSON.stringify(ctx.agentId)}`
}

export const kimiCodeAdapter: AgentPluginAdapter = {
  clientType: 'kimi-code',
  async generate(ctx: GeneratePluginContext) {
    const name = serverName(ctx)

    // 1) MCP server → ~/.kimi-code/mcp.json
    // mcp.json 归 Kimi CLI 所有:畸形 JSON 时 readJsonStrict 备份后抛错,
    // 绝不静默覆盖用户已有的其他 MCP server 配置。
    const mcpPath = kimiMcpPath(ctx)
    const mcpConfig = readJsonStrict<any>(mcpPath, {})
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}
    mcpConfig.mcpServers[name] = mcpServerEntry(ctx.runtime, ctx.agentId)
    writeJsonAtomic(mcpPath, mcpConfig)

    // 2) Skill → ~/.kimi-code/skills/tidemind-<agentId>/SKILL.md
    const skillDir = skillRootDir(ctx)
    const skillFilePath = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })
    const skillBody = wrapSkillWithFrontmatter(ctx.skillContent, name, ctx.config.skillDescription)
    writeFileAtomic(skillFilePath, skillBody)

    // 3) UserPromptSubmit hook → ~/.kimi-code/config.toml 的 [[hooks]]
    //    --once-per-session 拼在 --tool 之后:UserPromptSubmit 每条消息都触发,
    //    脚本侧按 session_id 去重,每会话只注入一次。不写 matcher(match all)。
    const hookCommand = [
      JSON.stringify(ctx.runtime.shimPath),
      JSON.stringify(ctx.runtime.hookScriptPath),
      '--agent-id', JSON.stringify(ctx.agentId),
      '--skill-path', JSON.stringify(skillFilePath),
      '--tool', JSON.stringify(ctx.config.hookToolParam),
      '--once-per-session',
    ].join(' ')
    ensureTomlHook(kimiConfigPath(ctx), {
      event: 'UserPromptSubmit',
      command: hookCommand,
      timeout: 30,
      dedupeToken: agentIdToken(ctx),
    })

    return { pluginDir: skillDir, pluginName: ctx.pluginName, marketplaceRegistered: false, success: true }
  },

  getPath(ctx) {
    const skillDir = skillRootDir(ctx)
    return fs.existsSync(path.join(skillDir, 'SKILL.md')) ? skillDir : null
  },

  async getStatus(ctx): Promise<PluginStatusResult> {
    let kimiConfigWritten = false
    const mcpPath = kimiMcpPath(ctx)
    if (fs.existsSync(mcpPath)) {
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'))
        kimiConfigWritten = Boolean(mcpConfig.mcpServers?.[serverName(ctx)])
      } catch { /* ignore */ }
    }

    let hooksConfigured = false
    const configPath = kimiConfigPath(ctx)
    if (fs.existsSync(configPath)) {
      try {
        hooksConfigured = hasTomlHook(fs.readFileSync(configPath, 'utf-8'), agentIdToken(ctx))
      } catch { /* 读失败(EACCES 等)按未配置处理 */ }
    }

    const skillDir = skillRootDir(ctx)
    const installedSkillPath = path.join(skillDir, 'SKILL.md')
    const skillDirWritten = fs.existsSync(installedSkillPath)

    // skillOutdated: 比较 source skill md mtime vs 已安装的 SKILL.md mtime
    // 如果 source 比 installed 新，说明 TideMind app 升级后用户没重新生成
    // 参照 client/electron/ipc/agent-plugins/codex.ts 同款机制
    let skillOutdated = false
    let generatedAt = ''
    const sourceCandidates = [
      path.join(ctx.runtime.skillDir, ctx.config.skillSource),
      path.join(ctx.runtime.skillDir, 'base-skill.md'),
    ]
    const sourceSkillPath = sourceCandidates.find(p => fs.existsSync(p))
    if (sourceSkillPath && fs.existsSync(installedSkillPath)) {
      const sourceMtime = fs.statSync(sourceSkillPath).mtimeMs
      const installedMtime = fs.statSync(installedSkillPath).mtimeMs
      skillOutdated = sourceMtime > installedMtime
      generatedAt = fs.statSync(installedSkillPath).mtime.toISOString()
    }

    return {
      exists: kimiConfigWritten || skillDirWritten,
      pluginDir: skillDirWritten ? skillDir : '',
      clientType: ctx.clientType,
      tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
      kimiConfigWritten,
      hooksConfigured,
      skillDirWritten,
      skillOutdated,
      generatedAt,
    }
  },

  async uninstall(ctx) {
    const errors: string[] = []

    try {
      const mcpPath = kimiMcpPath(ctx)
      if (fs.existsSync(mcpPath)) {
        // Same protection as in generate: readJsonStrict refuses to silently
        // overwrite a malformed mcp.json with `{}`.
        const mcpConfig = readJsonStrict<any>(mcpPath, {})
        if (mcpConfig.mcpServers?.[serverName(ctx)]) {
          delete mcpConfig.mcpServers[serverName(ctx)]
          if (Object.keys(mcpConfig.mcpServers).length === 0) delete mcpConfig.mcpServers
          writeJsonAtomic(mcpPath, mcpConfig)
        }
      }
    } catch (err: any) {
      errors.push(`移除 Kimi Code MCP 配置失败: ${err.message}`)
    }

    try {
      removeTomlHook(kimiConfigPath(ctx), agentIdToken(ctx))
    } catch (err: any) {
      errors.push(`移除 Kimi Code hooks 失败: ${err.message}`)
    }

    try {
      const skillRoot = path.join(kimiHome(ctx), 'skills')
      const skillDir = path.join(skillRoot, serverName(ctx))
      assertPathWithinRoot(skillDir, skillRoot)
      fs.rmSync(skillDir, { recursive: true, force: true })
    } catch { /* ignore */ }

    try {
      if (fs.existsSync(ctx.pluginDir)) fs.rmSync(ctx.pluginDir, { recursive: true, force: true })
    } catch (err: any) {
      errors.push(`删除插件目录失败: ${err.message}`)
    }

    return errors.length > 0
      ? { success: false, error: errors.join('; ') }
      : { success: true }
  },
}
