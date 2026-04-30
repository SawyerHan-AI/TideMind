import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { repairClaudeSettings, repairMarketplaceJson } from '@server/utils/marketplace-repair.js'
import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from './fs-utils'
import { cliEnv, mcpServerEntry } from './paths'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

const execFileAsync = promisify(execFile)

export const MARKETPLACE_ID = 'tidemind-local'

function claudeSettingsPath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, '.claude', 'settings.json')
}

function pluginJsonPath(ctx: PluginLookupContext): string {
  return path.join(ctx.pluginDir, '.claude-plugin', 'plugin.json')
}

function skillPath(ctx: PluginLookupContext): string {
  return path.join(ctx.pluginDir, 'skills', 'tidemind', 'SKILL.md')
}

async function registerMarketplace(ctx: GeneratePluginContext): Promise<boolean> {
  const marketplaceDir = path.join(ctx.runtime.pluginsDir, '.claude-plugin')
  fs.mkdirSync(marketplaceDir, { recursive: true })

  const marketplacePath = path.join(marketplaceDir, 'marketplace.json')
  let existing: any = null
  if (fs.existsSync(marketplacePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(marketplacePath, 'utf-8'))
    } catch { /* parse failure means repair from empty */ }
  }
  const { output: marketplace } = repairMarketplaceJson(existing)
  marketplace.plugins = marketplace.plugins ?? []

  const existingIdx = marketplace.plugins.findIndex((p: any) => p.name === ctx.pluginName)
  const pluginEntry = {
    name: ctx.pluginName,
    description: `外部记忆系统 — ${ctx.agentName}`,
    source: `./${ctx.pluginDirName}`,
  }
  if (existingIdx >= 0) marketplace.plugins[existingIdx] = pluginEntry
  else marketplace.plugins.push(pluginEntry)
  writeJsonAtomic(marketplacePath, marketplace)

  try {
    let settings: any = {}
    const settingsPath = claudeSettingsPath(ctx)
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }

    const { output: cleanedSettings, changed: settingsChanged } = repairClaudeSettings(settings)
    settings = cleanedSettings

    if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {}
    let addedNew = false
    if (!settings.extraKnownMarketplaces[MARKETPLACE_ID]) {
      settings.extraKnownMarketplaces[MARKETPLACE_ID] = {
        source: { source: 'directory', path: ctx.runtime.pluginsDir },
      }
      addedNew = true
    }
    if (settingsChanged || addedNew) writeJsonAtomic(settingsPath, settings)
    return true
  } catch {
    return false
  }
}

export const claudeCodeAdapter: AgentPluginAdapter = {
  clientType: 'claude-code',

  async generate(ctx: GeneratePluginContext) {
    fs.mkdirSync(path.join(ctx.pluginDir, '.claude-plugin'), { recursive: true })
    fs.mkdirSync(path.join(ctx.pluginDir, 'skills', 'tidemind'), { recursive: true })

    writeJsonAtomic(
      pluginJsonPath(ctx),
      {
        name: ctx.pluginName,
        version: '1.0.0',
        description: `外部记忆系统 — ${ctx.agentName}`,
        author: { name: 'TideMind' },
      },
    )

    writeJsonAtomic(
      path.join(ctx.pluginDir, '.mcp.json'),
      {
        mcpServers: {
          tidemind: mcpServerEntry(ctx.runtime, ctx.agentId),
        },
      },
    )

    const frontmatter = [
      '---',
      `description: "${ctx.config.skillDescription}"`,
      'when_to_use: |',
      '  用户提起"之前"、"上次"、"记得吗"、过去的决定或观点时；',
      '  需要判断用户偏好、历史态度、长期目标时；',
      '  用户明确说"记住"、"别忘了"、"以后不要..."时；',
      '  每次完成实质性请求后、用户做出决策或表达观点时需要沉淀结论。',
      'allowed-tools:',
      '  - mcp__tidemind__brain_prepare',
      '  - mcp__tidemind__brain_recall',
      '  - mcp__tidemind__brain_digest',
      `  - mcp__${ctx.pluginName}__brain_prepare`,
      `  - mcp__${ctx.pluginName}__brain_recall`,
      `  - mcp__${ctx.pluginName}__brain_digest`,
      `  - mcp__plugin_${ctx.pluginName}_tidemind__brain_prepare`,
      `  - mcp__plugin_${ctx.pluginName}_tidemind__brain_recall`,
      `  - mcp__plugin_${ctx.pluginName}_tidemind__brain_digest`,
      '---',
      '',
    ].join('\n')
    writeFileAtomic(skillPath(ctx), frontmatter + ctx.skillContent)

    fs.mkdirSync(path.join(ctx.pluginDir, 'hooks'), { recursive: true })
    const hookCommand = [
      JSON.stringify(ctx.runtime.shimPath),
      JSON.stringify(ctx.runtime.hookScriptPath),
      '--agent-id', JSON.stringify(ctx.agentId),
      '--skill-path', JSON.stringify(skillPath(ctx)),
      '--tool', JSON.stringify(ctx.config.hookToolParam),
    ].join(' ')
    const preCompactCommand = [
      JSON.stringify(ctx.runtime.shimPath),
      JSON.stringify(ctx.runtime.preCompactScriptPath),
      '--agent-id', JSON.stringify(ctx.agentId),
    ].join(' ')
    const postCompactCommand = [
      JSON.stringify(ctx.runtime.shimPath),
      JSON.stringify(ctx.runtime.postCompactScriptPath),
      '--agent-id', JSON.stringify(ctx.agentId),
      '--tool', JSON.stringify(ctx.config.hookToolParam),
    ].join(' ')
    writeJsonAtomic(
      path.join(ctx.pluginDir, 'hooks', 'hooks.json'),
      {
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
      },
    )

    const marketplaceRegistered = await registerMarketplace(ctx)
    return { pluginDir: ctx.pluginDir, pluginName: ctx.pluginName, marketplaceRegistered, success: true }
  },

  getPath(ctx) {
    return fs.existsSync(pluginJsonPath(ctx)) ? ctx.pluginDir : null
  },

  async getStatus(ctx): Promise<PluginStatusResult> {
    if (!fs.existsSync(pluginJsonPath(ctx))) return { exists: false }

    const primarySkillPath = path.join(ctx.runtime.skillDir, ctx.config.skillSource)
    const sourceSkillPath = fs.existsSync(primarySkillPath)
      ? primarySkillPath
      : path.join(ctx.runtime.skillDir, 'base-skill.md')
    const sourceSkillName = path.basename(sourceSkillPath)

    const pluginSkillPath = skillPath(ctx)
    let skillOutdated = false
    let generatedAt = ''
    if (fs.existsSync(pluginSkillPath) && fs.existsSync(sourceSkillPath)) {
      const sourceMtime = fs.statSync(sourceSkillPath).mtimeMs
      const pluginMtime = fs.statSync(pluginSkillPath).mtimeMs
      skillOutdated = sourceMtime > pluginMtime
      generatedAt = fs.statSync(pluginSkillPath).mtime.toISOString()
    }

    return {
      exists: true,
      pluginDir: ctx.pluginDir,
      clientType: ctx.clientType,
      skillFile: sourceSkillName,
      generatedAt,
      skillOutdated,
      tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
      skillOutputPath: undefined,
      skillOutputExists: undefined,
    }
  },

  async uninstall(ctx) {
    const errors: string[] = []
    try {
      await execFileAsync('claude', ['plugin', 'uninstall', `${ctx.pluginName}@${MARKETPLACE_ID}`], {
        timeout: 15000,
        env: cliEnv(),
      })
    } catch { /* may already be uninstalled */ }

    try {
      const marketplacePath = path.join(ctx.runtime.pluginsDir, '.claude-plugin', 'marketplace.json')
      if (fs.existsSync(marketplacePath)) {
        const marketplace = readJsonSafe<any>(marketplacePath, { plugins: [] })
        marketplace.plugins = (marketplace.plugins ?? []).filter((p: any) => p.name !== ctx.pluginName)
        writeJsonAtomic(marketplacePath, marketplace)
      }
    } catch (err: any) {
      errors.push(`更新 marketplace 失败: ${err.message}`)
    }

    try {
      if (fs.existsSync(ctx.pluginDir)) fs.rmSync(ctx.pluginDir, { recursive: true, force: true })
    } catch (err: any) {
      errors.push(`删除插件目录失败: ${err.message}`)
    }

    return errors.length > 0
      ? { success: false, error: errors.join('; ') }
      : { success: true }
  },

  async install(ctx) {
    try {
      try {
        await execFileAsync('claude', ['plugin', 'marketplace', 'remove', 'external-brain-local'], {
          timeout: 10000,
          env: cliEnv(),
        })
      } catch { /* absent legacy marketplace is fine */ }

      try {
        await execFileAsync('claude', ['plugin', 'marketplace', 'add', ctx.runtime.pluginsDir], {
          timeout: 15000,
          env: cliEnv(),
        })
      } catch { /* already exists */ }

      const installArg = `${ctx.pluginName}@${MARKETPLACE_ID}`
      const { stdout, stderr } = await execFileAsync('claude', ['plugin', 'install', installArg, '--scope', 'user'], {
        timeout: 30000,
        env: cliEnv(),
      })
      return { success: true, output: stdout || stderr }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message }
    }
  },
}
