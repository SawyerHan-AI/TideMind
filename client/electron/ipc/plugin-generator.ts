import { ipcMain } from 'electron'
import { checkCli } from './agent-plugins/cli-utils'
import {
  allAgentPluginAdapters,
  getAgentPluginAdapter,
} from './agent-plugins/registry'
import {
  buildGeneratePluginContext,
  buildPluginLookupContext,
  createPluginRuntimeContext,
} from './agent-plugins/paths'
import type {
  PluginClientType,
  PluginGenerateResult,
  PluginInstallResult,
  PluginRuntimeContext,
} from './agent-plugins/types'
import {
  parseAgentId,
  parseCliName,
  parsePluginClientType,
  parsePluginGenerateInput,
  parsePluginName,
} from './_schemas.js'

function validationError(details: string[]): string {
  return details.join('; ')
}

function contextFor(
  runtime: PluginRuntimeContext,
  agentId: string,
  clientType: PluginClientType | undefined,
) {
  return buildPluginLookupContext(runtime, agentId, clientType ?? 'claude-code')
}

export function registerPluginGeneratorHandlers(dataDir: string): void {
  const runtime = createPluginRuntimeContext(dataDir)

  ipcMain.handle('agents:generate-plugin', async (_e, params: unknown): Promise<PluginGenerateResult> => {
    const parsed = parsePluginGenerateInput(params)
    if (!parsed.ok) {
      return {
        pluginDir: '',
        pluginName: '',
        marketplaceRegistered: false,
        success: false,
        error: validationError(parsed.error.details),
      }
    }

    const ctx = buildGeneratePluginContext(
      runtime,
      parsed.data.agentId,
      parsed.data.agentName,
      parsed.data.clientType,
    )
    try {
      return await getAgentPluginAdapter(ctx.clientType).generate(ctx)
    } catch (err) {
      return {
        pluginDir: ctx.pluginDir,
        pluginName: ctx.pluginName,
        marketplaceRegistered: false,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle('agents:check-cli', async (_e, cli: unknown) => {
    const parsed = parseCliName(cli)
    if (!parsed.ok) return { available: false }
    return checkCli(parsed.data)
  })

  ipcMain.handle('agents:install-plugin', async (_e, pluginName: unknown): Promise<PluginInstallResult> => {
    const parsed = parsePluginName(pluginName)
    if (!parsed.ok) return { success: false, error: validationError(parsed.error.details) }

    const agentId = parsed.data.slice('tidemind-'.length)
    const adapter = getAgentPluginAdapter('claude-code')
    if (!adapter.install) return { success: false, error: 'Claude Code install is unavailable' }
    return adapter.install(buildPluginLookupContext(runtime, agentId, 'claude-code'))
  })

  ipcMain.handle('agents:plugin-path', (_e, rawAgentId: unknown, toolType?: unknown): string | null => {
    const parsedAgentId = parseAgentId(rawAgentId)
    if (!parsedAgentId.ok) return null
    const parsedClientType = parsePluginClientType(toolType)
    if (!parsedClientType.ok) return null

    if (parsedClientType.data) {
      return getAgentPluginAdapter(parsedClientType.data).getPath(
        contextFor(runtime, parsedAgentId.data, parsedClientType.data),
      )
    }

    for (const adapter of allAgentPluginAdapters()) {
      const found = adapter.getPath(contextFor(runtime, parsedAgentId.data, adapter.clientType))
      if (found) return found
    }
    return null
  })

  ipcMain.handle('agents:plugin-status', async (_e, rawAgentId: unknown, toolType?: unknown) => {
    const parsedAgentId = parseAgentId(rawAgentId)
    if (!parsedAgentId.ok) return { exists: false }
    const parsedClientType = parsePluginClientType(toolType)
    if (!parsedClientType.ok) return { exists: false }

    const ctx = contextFor(runtime, parsedAgentId.data, parsedClientType.data)
    try {
      return await getAgentPluginAdapter(ctx.clientType).getStatus(ctx)
    } catch {
      return { exists: false }
    }
  })

  ipcMain.handle('agents:uninstall-plugin', async (_e, rawAgentId: unknown, toolType?: unknown): Promise<PluginInstallResult> => {
    const parsedAgentId = parseAgentId(rawAgentId)
    if (!parsedAgentId.ok) return { success: false, error: validationError(parsedAgentId.error.details) }
    const parsedClientType = parsePluginClientType(toolType)
    if (!parsedClientType.ok) return { success: false, error: validationError(parsedClientType.error.details) }

    const ctx = contextFor(runtime, parsedAgentId.data, parsedClientType.data)
    return getAgentPluginAdapter(ctx.clientType).uninstall(ctx)
  })

  // 手动复制类 agent (cursor / windsurf / cowork) 用户点"我已复制 Skill"按钮时调用，
  // 把当前 source skill md 的 hash 记到 ~/.tidemind/skill-copy-state.json，
  // 下次 app 升级后再算 outdated 时跟 source 的新 hash 对比。
  // 设计 doc: docs/design/brain-recall-redesign-2026-05.md §8.4
  ipcMain.handle('agents:mark-skill-copied', async (_e, rawAgentId: unknown, toolType?: unknown): Promise<{ success: boolean; error?: string }> => {
    const parsedAgentId = parseAgentId(rawAgentId)
    if (!parsedAgentId.ok) return { success: false, error: validationError(parsedAgentId.error.details) }
    const parsedClientType = parsePluginClientType(toolType)
    if (!parsedClientType.ok) return { success: false, error: validationError(parsedClientType.error.details) }

    const ctx = contextFor(runtime, parsedAgentId.data, parsedClientType.data)
    // source skill md 路径：data/skill/{clientType}-skill.md，回退到 base-skill.md
    const skillSourceCandidates = [
      `${ctx.clientType}-skill.md`,
      'base-skill.md',
    ]
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sourcePath = skillSourceCandidates
      .map(name => path.join(ctx.runtime.skillDir, name))
      .find(p => fs.existsSync(p))
    if (!sourcePath) {
      return { success: false, error: `skill source not found in ${ctx.runtime.skillDir}` }
    }
    try {
      const { markSkillCopied } = await import('./agent-plugins/simple-config-adapter.js')
      markSkillCopied(ctx, sourcePath)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) }
    }
  })
}
