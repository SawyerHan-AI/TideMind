import path from 'node:path'
import { createSimpleConfigAdapter, ensureMcpServers, frontmatter } from './simple-config-adapter'
import type { GeneratePluginContext, PluginLookupContext } from './types'

function skillPath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.homeDir, 'Downloads', `tidemind-skill-${ctx.agentId}.md`)
}

function skillBody(ctx: GeneratePluginContext): string {
  return frontmatter([
    '---',
    `name: "Tide Mind"`,
    `description: "${ctx.config.skillDescription}"`,
    '---',
  ]) + ctx.skillContent
}

export const coworkAdapter = createSimpleConfigAdapter({
  clientType: 'cowork',
  configPath: ctx => path.join(ctx.runtime.homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  configRoot: ensureMcpServers,
  deleteConfigRootIfEmpty: config => {
    if (Object.keys(config.mcpServers ?? {}).length === 0) delete config.mcpServers
  },
  configStatusKey: 'desktopConfigWritten',
  outputPath: skillPath,
  outputBody: skillBody,
})
