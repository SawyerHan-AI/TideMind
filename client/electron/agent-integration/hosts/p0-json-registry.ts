import fs from 'node:fs'
import path from 'node:path'
import { inspectJsonProjection } from '../json-projection'
import { createJsonMcpHostAdapter, type JsonMcpHostSpec } from './json-mcp-adapter'
import type { AdapterOperationContext, AgentHostAdapter, CatalogId, JsonValue } from '../types'

const ADAPTER_VERSION = '1'

function managedEnvironment(context: AdapterOperationContext): Record<string, string> {
  return {
    EB_AGENT_ID: context.agentId,
    EB_HOST_VARIANT: context.installation.hostVariant,
    ...(context.activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken } : {}),
  }
}

function openCodeEntry(context: AdapterOperationContext): JsonValue {
  return {
    type: 'local',
    command: [context.runtime.shimPath, context.runtime.mcpServerPath],
    enabled: true,
    environment: managedEnvironment(context),
  }
}

function configFile(name: string): (context: AdapterOperationContext) => string {
  return context => path.join(context.installation.canonicalConfigRoot, name)
}

function openCodeConfigFile(context: AdapterOperationContext): string {
  const explicit = context.installation.componentConfigFiles?.memory_tools
  if (explicit !== undefined) return explicit
  const jsonc = path.join(context.installation.canonicalConfigRoot, 'opencode.jsonc')
  return fs.existsSync(jsonc) ? jsonc : path.join(context.installation.canonicalConfigRoot, 'opencode.json')
}

/**
 * P0 host surfaces whose user-level MCP contract is a documented JSON selector.
 * Complex plugin/TOML/directory projections are registered separately; keeping
 * this registry JSON-only prevents a generic adapter from pretending it can
 * safely manage an unrelated host format.
 */
export const P0_JSON_MCP_SPECS: Readonly<Partial<Record<CatalogId, JsonMcpHostSpec>>> = Object.freeze({
  'claude-desktop-legacy': {
    catalogId: 'claude-desktop-legacy',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('claude_desktop_config.json'),
    selectorRoot: ['mcpServers'],
    reload: 'restart_host',
  },
  'cursor-desktop': {
    catalogId: 'cursor-desktop',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('mcp.json'),
    selectorRoot: ['mcpServers'],
    reload: 'new_session',
  },
  'windsurf-desktop': {
    catalogId: 'windsurf-desktop',
    adapterVersion: ADAPTER_VERSION,
    configFile: context => context.installation.componentConfigFiles?.memory_tools
      ?? path.join(context.installation.canonicalConfigRoot, 'mcp_config.json'),
    selectorRoot: ['mcpServers'],
    reload: 'version_dependent',
  },
  'kimi-code-cli': {
    catalogId: 'kimi-code-cli',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('mcp.json'),
    selectorRoot: ['mcpServers'],
    reload: 'new_session',
  },
  'kimi-code-native': {
    catalogId: 'kimi-code-native',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('mcp.json'),
    selectorRoot: ['mcpServers'],
    reload: 'new_session',
  },
  'qwen-code-cli': {
    catalogId: 'qwen-code-cli',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('settings.json'),
    selectorRoot: ['mcpServers'],
    reload: 'new_session',
  },
  'zcode-desktop': {
    catalogId: 'zcode-desktop',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('config.json'),
    selectorRoot: ['mcp', 'servers'],
    reload: 'new_session',
  },
  'opencode-v1-cli': {
    catalogId: 'opencode-v1-cli',
    adapterVersion: ADAPTER_VERSION,
    configFile: openCodeConfigFile,
    selectorRoot: ['mcp'],
    reload: 'new_session',
    buildEntry: openCodeEntry,
  },
  'opencode-v2-beta-cli': {
    catalogId: 'opencode-v2-beta-cli',
    adapterVersion: ADAPTER_VERSION,
    configFile: openCodeConfigFile,
    // OpenCode V2 officially accepts the V1 MCP shape during migration. Both
    // CLIs share one physical config, so a single V1-compatible selector avoids
    // creating competing mcp.<name> and mcp.servers.<name> projections.
    selectorRoot: ['mcp'],
    legacySelectorRoots: [['mcp', 'servers']],
    reload: 'new_session',
    buildEntry: openCodeEntry,
  },
  'omp-cli': {
    catalogId: 'omp-cli',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('mcp.json'),
    selectorRoot: ['mcpServers'],
    reload: 'reload',
    buildEntry: context => ({
      type: 'stdio',
      command: context.runtime.shimPath,
      args: [context.runtime.mcpServerPath],
      env: managedEnvironment(context),
    }),
    activationGate: (context, serverName) => {
      const configPath = path.join(context.installation.canonicalConfigRoot, 'mcp.json')
      const disabled = inspectJsonProjection(
        configPath,
        ['disabledServers'],
        context.installation.canonicalConfigRoot,
      )
      if (!disabled.fragmentExists) return { allowed: true }
      if (!Array.isArray(disabled.fragment)
        || !disabled.fragment.every(value => typeof value === 'string')) {
        return {
          allowed: false,
          diagnostic: 'omp_mcp_disabled_servers_invalid',
          requiredUserAction: `review_omp_mcp_disabled_servers:${serverName}`,
          requiredUserActionDetail: {
            kind: 'mcp_activation',
            componentKey: 'memory_tools',
            operation: 'connect',
            hostVariant: 'omp-cli',
            serverName,
            configPath,
            reason: 'invalid_policy',
            instruction: `Review disabledServers in ${configPath}, allow ${serverName}, then recheck the connection.`,
          },
        }
      }
      if (!disabled.fragment.includes(serverName)) return { allowed: true }
      return {
        allowed: false,
        diagnostic: 'omp_mcp_server_explicitly_disabled',
        requiredUserAction: `remove_omp_mcp_disabled_server:${serverName}`,
        requiredUserActionDetail: {
          kind: 'mcp_activation',
          componentKey: 'memory_tools',
          operation: 'connect',
          hostVariant: 'omp-cli',
          serverName,
          configPath,
          reason: 'excluded',
          instruction: `Remove ${serverName} from disabledServers in ${configPath}, then recheck the connection.`,
        },
      }
    },
  },
})

export function createP0JsonMcpAdapters(): ReadonlyMap<CatalogId, AgentHostAdapter> {
  return new Map(
    Object.entries(P0_JSON_MCP_SPECS).map(([catalogId, spec]) => [
      catalogId as CatalogId,
      createJsonMcpHostAdapter(spec!),
    ]),
  )
}
