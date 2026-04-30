import path from 'node:path'
import { createSimpleConfigAdapter, ensureMcpServers, frontmatter } from './simple-config-adapter'
import type { GeneratePluginContext, PluginLookupContext } from './types'

function skillPath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, 'Downloads', `tidemind-windsurf-${ctx.agentId}.md`)
}

function skillBody(ctx: GeneratePluginContext): string {
  return frontmatter([
    '---',
    `trigger: always_on`,
    `description: "${ctx.config.skillDescription}"`,
    '---',
  ]) + ctx.skillContent
}

export const windsurfAdapter = createSimpleConfigAdapter({
  clientType: 'windsurf',
  configPath: ctx => path.join(ctx.runtime.homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
  configRoot: ensureMcpServers,
  deleteConfigRootIfEmpty: config => {
    if (Object.keys(config.mcpServers ?? {}).length === 0) delete config.mcpServers
  },
  configStatusKey: 'windsurfConfigWritten',
  outputPath: skillPath,
  outputBody: skillBody,
})
