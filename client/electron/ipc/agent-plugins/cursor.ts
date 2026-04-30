import path from 'node:path'
import { createSimpleConfigAdapter, ensureMcpServers, frontmatter } from './simple-config-adapter'
import type { GeneratePluginContext, PluginLookupContext } from './types'

function skillPath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, 'Downloads', `tidemind-cursor-${ctx.agentId}.mdc`)
}

function skillBody(ctx: GeneratePluginContext): string {
  return frontmatter([
    '---',
    `description: "${ctx.config.skillDescription}"`,
    'alwaysApply: true',
    '---',
  ]) + ctx.skillContent
}

export const cursorAdapter = createSimpleConfigAdapter({
  clientType: 'cursor',
  configPath: ctx => path.join(ctx.runtime.homeDir, '.cursor', 'mcp.json'),
  configRoot: ensureMcpServers,
  deleteConfigRootIfEmpty: config => {
    if (Object.keys(config.mcpServers ?? {}).length === 0) delete config.mcpServers
  },
  configStatusKey: 'cursorConfigWritten',
  outputPath: skillPath,
  outputBody: skillBody,
})
