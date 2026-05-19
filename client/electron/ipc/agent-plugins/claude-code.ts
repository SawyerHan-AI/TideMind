import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@server/utils/logger.js'
import { repairClaudeSettings, repairMarketplaceJson } from '@server/utils/marketplace-repair.js'
import { computePluginPatchVersion } from './claude-code-version'
import { readJsonStrict, writeFileAtomic, writeJsonAtomic } from './fs-utils'
import { cliEnv, mcpServerEntry } from './paths'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

const execFileAsync = promisify(execFile)
const log = createLogger('agent-plugin-claude-code')

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

/**
 * Tell the Claude Code CLI about our local marketplace.
 *
 * Why we do this in generate() (not just install()):
 *   The wizard renders a "manual" install command (`claude plugin install
 *   xxx@tidemind-local --scope user`) right after generate(). If the user
 *   copies that into their terminal *before* clicking the install button —
 *   or if they retry from a fresh shell after closing the wizard — the CLI
 *   has no idea that "tidemind-local" exists yet, because `marketplace add`
 *   was previously deferred until install time. The result is the
 *   "Plugin not found in marketplace 'tidemind-local'" error users actually hit.
 *
 *   Running `marketplace add` here makes the CLI's known_marketplaces.json
 *   reflect the on-disk marketplace.json as soon as files exist. The CLI
 *   command is idempotent (re-add of an existing marketplace just refreshes).
 *
 * Failures here are non-fatal: they only mean the CLI didn't pre-register.
 * The install adapter will try again with `marketplace add` before installing,
 * so this is a best-effort warm-up, not a hard requirement.
 */
async function syncCliMarketplace(pluginsDir: string): Promise<boolean> {
  try {
    await execFileAsync('claude', ['plugin', 'marketplace', 'add', pluginsDir], {
      timeout: 15000,
      env: cliEnv(),
    })
    return true
  } catch (err: any) {
    // Best-effort warm-up — failure here is OK, install() will retry. But we
    // log so the cause (CLI missing, timeout, wrong PATH, …) is recoverable
    // when users report "marketplace not found" later.
    const reason = err?.stderr?.trim() || err?.message || String(err)
    log.warn(`syncCliMarketplace failed for ${pluginsDir}: ${reason}`)
    return false
  }
}

async function registerMarketplace(ctx: GeneratePluginContext): Promise<boolean> {
  const marketplaceDir = path.join(ctx.runtime.pluginsDir, '.claude-plugin')
  fs.mkdirSync(marketplaceDir, { recursive: true })

  const marketplacePath = path.join(marketplaceDir, 'marketplace.json')
  // marketplace.json holds entries for ALL the user's agents (every Claude Code
  // agent they've ever set up writes here). If it exists but is malformed we
  // MUST NOT silently treat it as empty — that would clobber every other
  // agent's plugin entry the moment we write back. readJsonStrict backs the
  // file up to a .bak and throws so generate() fails loudly. The wizard
  // surfaces the error and the user can manually inspect/restore.
  const existing = fs.existsSync(marketplacePath)
    ? readJsonStrict<any>(marketplacePath, null as any)
    : null
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

  // Update ~/.claude/settings.json's extraKnownMarketplaces. This is a
  // best-effort registration so Claude Code recognizes the marketplace.
  // Failures here MUST NOT fail the whole generate flow — files on disk are
  // already correct, install() can still succeed via `claude plugin
  // marketplace add`. But we no longer swallow the error blindly:
  //   - missing file        → start with {} (normal)
  //   - malformed JSON      → readJsonStrict backs up to .bak; we log and
  //                           skip the settings update so we don't clobber
  //                           the user's settings (other tools, permissions,
  //                           etc.) with our own subset
  //   - write failure       → log and return false
  let settings: any
  const settingsPath = claudeSettingsPath(ctx)
  try {
    settings = readJsonStrict<any>(settingsPath, {})
  } catch (err: any) {
    log.warn(`refusing to update ${settingsPath}: ${err.message}. Marketplace will still be registered via CLI.`)
    return false
  }

  try {
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
  } catch (err: any) {
    log.warn(`failed to write ${settingsPath}: ${err.message}`)
    return false
  }
}

/**
 * 构建 Claude Code SKILL.md 的 YAML frontmatter。
 *
 * Why exported: plugin-self-heal.ts 需要给老用户 SKILL.md 补 when_to_use /
 * allowed-tools 字段时调用同一份生成逻辑,避免两端 frontmatter 漂移。
 * How to apply: generate() 时直接调用;self-heal 检测到 frontmatter 缺 when_to_use
 * 时调用,把新 frontmatter + 原正文重写回去。
 */
export function buildClaudeCodeSkillFrontmatter(
  pluginName: string,
  skillDescription: string,
): string {
  return [
    '---',
    `description: "${skillDescription}"`,
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
}

export const claudeCodeAdapter: AgentPluginAdapter = {
  clientType: 'claude-code',

  async generate(ctx: GeneratePluginContext) {
    fs.mkdirSync(path.join(ctx.pluginDir, '.claude-plugin'), { recursive: true })
    fs.mkdirSync(path.join(ctx.pluginDir, 'skills', 'tidemind'), { recursive: true })

    writeJsonAtomic(
      path.join(ctx.pluginDir, '.mcp.json'),
      {
        mcpServers: {
          tidemind: mcpServerEntry(ctx.runtime, ctx.agentId),
        },
      },
    )

    const frontmatter = buildClaudeCodeSkillFrontmatter(ctx.pluginName, ctx.config.skillDescription)
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

    // plugin.json 必须最后写:它的 version 是其余文件的内容哈希,
    // 任何路径/内容变化都会反映到 version 里,Claude Code 缓存随之失效。
    // 见 claude-code-version.ts 的解释。
    writeJsonAtomic(
      pluginJsonPath(ctx),
      {
        name: ctx.pluginName,
        version: computePluginPatchVersion(ctx.pluginDir),
        description: `外部记忆系统 — ${ctx.agentName}`,
        author: { name: 'TideMind' },
      },
    )

    const marketplaceRegistered = await registerMarketplace(ctx)
    // Best-effort: warm up the Claude Code CLI's marketplace registry so the
    // install command works whether the user clicks the wizard's button or
    // copies the displayed command into a terminal. See syncCliMarketplace.
    await syncCliMarketplace(ctx.runtime.pluginsDir)
    return {
      pluginDir: ctx.pluginDir,
      pluginName: ctx.pluginName,
      marketplaceRegistered,
      pluginsDir: ctx.runtime.pluginsDir,
      success: true,
    }
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
        // readJsonStrict refuses to overwrite a malformed marketplace.json
        // with `{ plugins: [] }` — that would erase every OTHER agent's
        // plugin entry. If it throws, we record the error and leave the file
        // intact (plus a .bak backup); the user can inspect/restore. The
        // plugin directory cleanup below still proceeds.
        const marketplace = readJsonStrict<any>(marketplacePath, { plugins: [] })
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
      } catch (err: any) {
        // `marketplace add` is idempotent — re-adding an already-registered
        // marketplace is fine. But if it fails for a real reason (CLI missing,
        // path invalid, permissions), the next `plugin install` step is the
        // one that will surface "Plugin not found in marketplace …" to the
        // user, with no clue why. Log the underlying reason so it's
        // recoverable from the daemon log.
        const reason = err?.stderr?.trim() || err?.message || String(err)
        log.warn(`pre-install marketplace add failed (${ctx.runtime.pluginsDir}): ${reason}`)
      }

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
