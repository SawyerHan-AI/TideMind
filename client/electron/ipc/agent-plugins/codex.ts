import fs from 'node:fs'
import path from 'node:path'
import { assertPathWithinRoot } from '../_validate'
import { appendTomlMcpSection, ensureTomlFeatureFlag, removeTomlMcpSection } from '../toml-utils'
import {
  CODEX_V2_MIN_VERSION,
  codexMcpAdd,
  codexMcpRemove,
  detectCodexVersion,
  meetsMinVersion,
  wrapSkillWithFrontmatter,
} from '../codex-cli'
import { readJsonStrict, unlinkIfExists, writeFileAtomic, writeJsonAtomic } from './fs-utils'
import { mcpServerEntry } from './paths'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

function codexConfigPath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, '.codex', 'config.toml')
}

function codexHooksPath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, '.codex', 'hooks.json')
}

function serverName(ctx: PluginLookupContext): string {
  return `tidemind-${ctx.agentId}`
}

function legacySkillPath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, 'Downloads', `tidemind-codex-${ctx.agentId}.md`)
}

function nativeSkillRoot(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, '.codex', 'skills', serverName(ctx))
}

function writeSessionStartHook(ctx: PluginLookupContext, skillFilePath: string): void {
  const hooksPath = codexHooksPath(ctx)
  // ~/.codex/hooks.json belongs to the Codex CLI. If the file exists but is
  // malformed, readJsonStrict backs it up and throws — never silently overwrite
  // a user's existing hooks with `{ hooks: {} }`. The caller (generate) will
  // surface the error in the wizard.
  const hooksConfig: any = readJsonStrict<any>(hooksPath, { hooks: {} })
  if (!hooksConfig.hooks) hooksConfig.hooks = {}
  if (!hooksConfig.hooks.SessionStart) hooksConfig.hooks.SessionStart = []

  const hookCommand = [
    JSON.stringify(ctx.runtime.shimPath),
    JSON.stringify(ctx.runtime.hookScriptPath),
    '--agent-id', JSON.stringify(ctx.agentId),
    '--skill-path', JSON.stringify(skillFilePath),
    '--tool', 'codex',
  ].join(' ')
  const agentIdToken = `--agent-id ${JSON.stringify(ctx.agentId)}`
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
  writeJsonAtomic(hooksPath, hooksConfig)
}

export const codexAdapter: AgentPluginAdapter = {
  clientType: 'codex',
  async generate(ctx: GeneratePluginContext) {
    const configPath = codexConfigPath(ctx)
    const name = serverName(ctx)
    const codexVersion = await detectCodexVersion()
    const useV2 = meetsMinVersion(codexVersion, CODEX_V2_MIN_VERSION)

    if (useV2) {
      await codexMcpAdd({
        serverName: name,
        command: ctx.runtime.shimPath,
        args: [ctx.runtime.mcpServerPath],
        env: { EB_AGENT_ID: ctx.agentId },
      })

      ensureTomlFeatureFlag(configPath, 'codex_hooks')

      const skillRootDir = nativeSkillRoot(ctx)
      const skillFilePath = path.join(skillRootDir, 'SKILL.md')
      if (!fs.existsSync(skillRootDir)) fs.mkdirSync(skillRootDir, { recursive: true })
      const skillBody = wrapSkillWithFrontmatter(ctx.skillContent, name, ctx.config.skillDescription)
      writeFileAtomic(skillFilePath, skillBody)
      writeSessionStartHook(ctx, skillFilePath)

      return { pluginDir: skillRootDir, pluginName: ctx.pluginName, marketplaceRegistered: false, success: true }
    }

    appendTomlMcpSection(configPath, name, mcpServerEntry(ctx.runtime, ctx.agentId))
    ensureTomlFeatureFlag(configPath, 'codex_hooks')

    const skillFilePath = path.join(ctx.runtime.skillDir, ctx.config.skillSource)
    writeSessionStartHook(ctx, skillFilePath)

    const outputPath = legacySkillPath(ctx)
    writeFileAtomic(outputPath, ctx.skillContent)

    return { pluginDir: outputPath, pluginName: ctx.pluginName, marketplaceRegistered: false, success: true }
  },

  getPath(ctx) {
    const skillRootDir = nativeSkillRoot(ctx)
    if (fs.existsSync(path.join(skillRootDir, 'SKILL.md'))) return skillRootDir

    const legacyPath = legacySkillPath(ctx)
    return fs.existsSync(legacyPath) ? legacyPath : null
  },

  async getStatus(ctx): Promise<PluginStatusResult> {
    const configPath = codexConfigPath(ctx)
    let codexConfigWritten = false
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      codexConfigWritten = content.includes(`[mcp_servers.tidemind-${ctx.agentId}]`)
    }

    let hooksConfigured = false
    const hooksPath = codexHooksPath(ctx)
    if (fs.existsSync(hooksPath)) {
      try {
        const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'))
        const agentIdToken = `--agent-id ${JSON.stringify(ctx.agentId)}`
        hooksConfigured = hooks.hooks?.SessionStart?.some((group: any) =>
          group.hooks?.some((h: any) => h.command?.includes(agentIdToken)),
        ) ?? false
      } catch { /* ignore */ }
    }

    const skillRootDir = nativeSkillRoot(ctx)
    const installedSkillPath = path.join(skillRootDir, 'SKILL.md')
    const skillDirWritten = fs.existsSync(installedSkillPath)
    // v2 用户 skill 装在 ~/.codex/skills/ (Codex CLI 0.121+ 启动自动加载),
    // Downloads 那份是 v1 legacy 残留。skillDirWritten=true 时把 skillOutputPath
    // 隐藏起来,避免 v2 用户看到两条路径反而困惑 "我要不要复制?"。
    const legacyPath = legacySkillPath(ctx)
    const legacyExists = fs.existsSync(legacyPath)
    const skillOutputPath = skillDirWritten ? '' : legacyPath
    const skillOutputExists = skillDirWritten ? false : legacyExists

    // skillOutdated: 比较 source skill md mtime vs 已安装的 SKILL.md mtime
    // 如果 source 比 installed 新，说明 TideMind app 升级后用户没重新生成
    // 参照 client/electron/ipc/agent-plugins/claude-code.ts:296-302 同款机制
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
      exists: codexConfigWritten || skillOutputExists || skillDirWritten,
      pluginDir: skillDirWritten ? skillRootDir : skillOutputPath,
      clientType: ctx.clientType,
      tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
      skillOutputPath,
      skillOutputExists,
      codexConfigWritten,
      hooksConfigured,
      skillDirWritten,
      skillOutdated,
      generatedAt,
    }
  },

  async uninstall(ctx) {
    const errors: string[] = []
    const name = serverName(ctx)

    try {
      await codexMcpRemove({ serverName: name })
    } catch { /* TOML fallback below */ }

    try {
      removeTomlMcpSection(codexConfigPath(ctx), name)
    } catch (err: any) {
      errors.push(`移除 Codex MCP 配置失败: ${err.message}`)
    }

    try {
      const hooksPath = codexHooksPath(ctx)
      if (fs.existsSync(hooksPath)) {
        // Same protection as in writeSessionStartHook: readJsonStrict refuses
        // to silently overwrite a malformed hooks.json with `{}`.
        const hooksConfig = readJsonStrict<any>(hooksPath, {})
        if (hooksConfig.hooks?.SessionStart) {
          const agentIdToken = `--agent-id ${JSON.stringify(ctx.agentId)}`
          hooksConfig.hooks.SessionStart = hooksConfig.hooks.SessionStart.filter((group: any) =>
            !group.hooks?.some((h: any) => h.command?.includes(agentIdToken)),
          )
          if (hooksConfig.hooks.SessionStart.length === 0) delete hooksConfig.hooks.SessionStart
          writeJsonAtomic(hooksPath, hooksConfig)
        }
      }
    } catch (err: any) {
      errors.push(`移除 Codex hooks 失败: ${err.message}`)
    }

    try {
      const skillRoot = path.join(ctx.runtime.homeDir, '.codex', 'skills')
      const skillRootDir = path.join(skillRoot, name)
      assertPathWithinRoot(skillRootDir, skillRoot)
      fs.rmSync(skillRootDir, { recursive: true, force: true })
    } catch { /* ignore */ }

    unlinkIfExists(legacySkillPath(ctx))

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
