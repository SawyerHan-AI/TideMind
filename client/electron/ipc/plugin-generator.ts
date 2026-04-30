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
}
