import fs from 'node:fs'
import { readJsonStrict, unlinkIfExists, writeFileAtomic, writeJsonAtomic } from './fs-utils'
import { downloadPath, mcpServerEntry } from './paths'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

interface SimpleConfigAdapterOptions {
  clientType: AgentPluginAdapter['clientType']
  configPath(ctx: PluginLookupContext): string
  configRoot(config: any): Record<string, any>
  deleteConfigRootIfEmpty?: (config: any) => void
  configStatusKey: string
  outputPath(ctx: PluginLookupContext): string
  outputBody(ctx: GeneratePluginContext): string
  pluginDirForStatus?(ctx: PluginLookupContext, outputPath: string): string
}

export function createSimpleConfigAdapter(options: SimpleConfigAdapterOptions): AgentPluginAdapter {
  return {
    clientType: options.clientType,
    async generate(ctx) {
      const configPath = options.configPath(ctx)
      // CRITICAL: this config file belongs to a third-party app (Claude Desktop,
      // Cursor, Codex, Windsurf, OpenClaw, Gemini). If it exists but is malformed,
      // we MUST NOT silently fall back to {} — that would clobber whatever the user
      // had (other tools' MCP servers, preferences). readJsonStrict backs up the
      // original to a .bak and throws so the wizard surfaces the error.
      const config = readJsonStrict<any>(configPath, {})
      const root = options.configRoot(config)
      root[`tidemind-${ctx.agentId}`] = mcpServerEntry(ctx.runtime, ctx.agentId)
      writeJsonAtomic(configPath, config)

      const outputPath = options.outputPath(ctx)
      writeFileAtomic(outputPath, options.outputBody(ctx))

      return {
        pluginDir: outputPath,
        pluginName: ctx.pluginName,
        marketplaceRegistered: false,
        success: true,
      }
    },
    getPath(ctx) {
      const outputPath = options.outputPath(ctx)
      return fs.existsSync(outputPath) ? outputPath : null
    },
    async getStatus(ctx): Promise<PluginStatusResult> {
      const configPath = options.configPath(ctx)
      let configWritten = false
      if (fs.existsSync(configPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          const root = options.configRoot(cfg)
          configWritten = !!root[`tidemind-${ctx.agentId}`]
        } catch { /* malformed config means status is unknown/false */ }
      }
      const outputPath = options.outputPath(ctx)
      const outputExists = fs.existsSync(outputPath)
      return {
        exists: configWritten || outputExists,
        pluginDir: options.pluginDirForStatus?.(ctx, outputPath) ?? outputPath,
        clientType: ctx.clientType,
        tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
        skillOutputPath: outputPath,
        skillOutputExists: outputExists,
        [options.configStatusKey]: configWritten,
      }
    },
    async uninstall(ctx) {
      const errors: string[] = []
      try {
        const configPath = options.configPath(ctx)
        if (fs.existsSync(configPath)) {
          // Same reasoning as in generate(): never silently rewrite a malformed
          // third-party config with an empty object. readJsonStrict backs up
          // and throws; the catch below records the error so the user sees it.
          const config = readJsonStrict<any>(configPath, {})
          const root = options.configRoot(config)
          delete root[`tidemind-${ctx.agentId}`]
          options.deleteConfigRootIfEmpty?.(config)
          writeJsonAtomic(configPath, config)
        }
      } catch (err: any) {
        errors.push(`移除 MCP 配置失败: ${err.message}`)
      }

      try {
        const outputPath = options.outputPath(ctx)
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
          fs.rmSync(outputPath, { recursive: true, force: true })
        } else {
          unlinkIfExists(outputPath)
        }
      } catch { /* ignore generated artifact cleanup */ }

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
}

export function ensureMcpServers(config: any): Record<string, any> {
  if (!config.mcpServers) config.mcpServers = {}
  return config.mcpServers
}

export function frontmatter(lines: string[]): string {
  return [...lines, ''].join('\n')
}

export function downloadsFile(ctx: PluginLookupContext, filename: string): string {
  return downloadPath(ctx.runtime, filename)
}
