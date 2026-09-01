import fs from 'node:fs'
import path from 'node:path'
import { createJsonMcpHostAdapter, type JsonMcpHostSpec } from './json-mcp-adapter'
import type { AdapterOperationContext, AgentHostAdapter, CatalogId, JsonValue } from '../types'

const ADAPTER_VERSION = '1'

function managedEnvironment(context: AdapterOperationContext): Record<string, string> {
  return {
    EB_AGENT_ID: context.agentId,
    EB_HOST_VARIANT: context.installation.hostVariant,
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

function openCodeV2Entry(context: AdapterOperationContext): JsonValue {
  return {
    type: 'local',
    command: [context.runtime.shimPath, context.runtime.mcpServerPath],
    environment: managedEnvironment(context),
  }
}

function configFile(name: string): (context: AdapterOperationContext) => string {
  return context => path.join(context.installation.canonicalConfigRoot, name)
}

function openCodeConfigFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.memory_tools
    ?? path.join(context.installation.canonicalConfigRoot, 'opencode.json')
}

function openCodeJsonSupported(context: AdapterOperationContext): boolean {
  const explicitFile = context.installation.componentConfigFiles?.memory_tools
  if (explicitFile) return path.extname(explicitFile).toLowerCase() === '.json'
  return !fs.existsSync(path.join(context.installation.canonicalConfigRoot, 'opencode.jsonc'))
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
    configFile: configFile('mcp_config.json'),
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
  'openclaw-local': {
    catalogId: 'openclaw-local',
    adapterVersion: ADAPTER_VERSION,
    configFile: configFile('openclaw.json'),
    selectorRoot: ['mcp', 'servers'],
    reload: 'reload',
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
    detect: openCodeJsonSupported,
  },
  'opencode-v2-beta-cli': {
    catalogId: 'opencode-v2-beta-cli',
    adapterVersion: ADAPTER_VERSION,
    configFile: openCodeConfigFile,
    selectorRoot: ['mcp', 'servers'],
    reload: 'new_session',
    buildEntry: openCodeV2Entry,
    detect: openCodeJsonSupported,
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
