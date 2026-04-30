import fs from 'node:fs'
import path from 'node:path'
import { assertPathWithinRoot } from '../_validate'
import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from './fs-utils'
import { mcpServerEntry } from './paths'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

function openclawHome(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, '.openclaw')
}

function configPath(ctx: PluginLookupContext): string {
  return path.join(openclawHome(ctx), 'openclaw.json')
}

function hookDir(ctx: PluginLookupContext): string {
  return path.join(openclawHome(ctx), 'hooks', `tidemind-${ctx.agentId}`)
}

function skillOutputDir(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, 'Downloads', `tidemind-openclaw-${ctx.agentId}`)
}

function skillOutputPath(ctx: PluginLookupContext): string {
  return path.join(skillOutputDir(ctx), 'SKILL.md')
}

export const openclawAdapter: AgentPluginAdapter = {
  clientType: 'openclaw',

  async generate(ctx: GeneratePluginContext) {
    const openclawConfigPath = configPath(ctx)
    const openclawConfig = readJsonSafe<any>(openclawConfigPath, {})
    if (!openclawConfig.mcp) openclawConfig.mcp = {}
    if (!openclawConfig.mcp.servers) openclawConfig.mcp.servers = {}
    openclawConfig.mcp.servers[`tidemind-${ctx.agentId}`] = mcpServerEntry(ctx.runtime, ctx.agentId)
    writeJsonAtomic(openclawConfigPath, openclawConfig)

    const hooksDir = hookDir(ctx)
    fs.mkdirSync(hooksDir, { recursive: true })

    const sourceSkillPath = path.join(ctx.runtime.skillDir, ctx.config.skillSource)
    writeFileAtomic(path.join(hooksDir, 'HOOK.md'), [
      '---',
      `name: tidemind-${ctx.agentId}`,
      `description: "Tide Mind — 自动加载外脑上下文"`,
      'metadata:',
      '  openclaw:',
      '    emoji: "🧠"',
      '    events: ["agent:bootstrap"]',
      '---',
      '',
      '在 Agent Bootstrap 时自动调用 Tide Mind 的 prepare 接口，将用户画像、记忆索引和行为指导注入为 MEMORY.md。',
    ].join('\n'))

    writeFileAtomic(path.join(hooksDir, 'handler.ts'), [
      `import { spawnSync } from 'child_process'`,
      '',
      `const SHIM = ${JSON.stringify(ctx.runtime.shimPath)}`,
      `const HOOK_SCRIPT = ${JSON.stringify(ctx.runtime.hookScriptPath)}`,
      `const SKILL_PATH = ${JSON.stringify(sourceSkillPath)}`,
      `const AGENT_ID = ${JSON.stringify(ctx.agentId)}`,
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

    const outDir = skillOutputDir(ctx)
    fs.mkdirSync(outDir, { recursive: true })
    const frontmatter = [
      '---',
      `name: "tidemind"`,
      `description: "${ctx.config.skillDescription}"`,
      '---',
      '',
    ].join('\n')
    writeFileAtomic(skillOutputPath(ctx), frontmatter + ctx.skillContent)

    return { pluginDir: outDir, pluginName: ctx.pluginName, marketplaceRegistered: false, success: true }
  },

  getPath(ctx) {
    const p = skillOutputPath(ctx)
    return fs.existsSync(p) ? p : null
  },

  async getStatus(ctx): Promise<PluginStatusResult> {
    let openclawConfigWritten = false
    const cfgPath = configPath(ctx)
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
        openclawConfigWritten = !!cfg.mcp?.servers?.[`tidemind-${ctx.agentId}`]
      } catch { /* ignore */ }
    }
    const hooksConfigured = fs.existsSync(path.join(hookDir(ctx), 'handler.ts'))
    const outputDir = skillOutputDir(ctx)
    const outputPath = skillOutputPath(ctx)
    const skillOutputExists = fs.existsSync(outputPath)
    return {
      exists: openclawConfigWritten || skillOutputExists,
      pluginDir: outputDir,
      clientType: ctx.clientType,
      tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
      skillOutputPath: outputDir,
      skillOutputExists,
      openclawConfigWritten,
      hooksConfigured,
    }
  },

  async uninstall(ctx) {
    const errors: string[] = []
    try {
      const cfgPath = configPath(ctx)
      if (fs.existsSync(cfgPath)) {
        const cfg = readJsonSafe<any>(cfgPath, {})
        if (cfg.mcp?.servers) {
          delete cfg.mcp.servers[`tidemind-${ctx.agentId}`]
          if (Object.keys(cfg.mcp.servers).length === 0) delete cfg.mcp.servers
          writeJsonAtomic(cfgPath, cfg)
        }
      }
    } catch (err: any) {
      errors.push(`移除 OpenClaw MCP 配置失败: ${err.message}`)
    }

    try {
      const hooksRoot = path.join(openclawHome(ctx), 'hooks')
      const dir = hookDir(ctx)
      assertPathWithinRoot(dir, hooksRoot)
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }

    try {
      const downloadsRoot = path.join(ctx.runtime.homeDir, 'Downloads')
      const dir = skillOutputDir(ctx)
      assertPathWithinRoot(dir, downloadsRoot)
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
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
