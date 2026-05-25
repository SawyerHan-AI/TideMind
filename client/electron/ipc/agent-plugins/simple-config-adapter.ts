import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { readJsonStrict, unlinkIfExists, writeFileAtomic, writeJsonAtomic } from './fs-utils'
import { downloadPath, mcpServerEntry } from './paths'
import type {
  AgentPluginAdapter,
  GeneratePluginContext,
  PluginLookupContext,
  PluginStatusResult,
} from './types'

// ── Skill copy state（手动复制类 agent 用 hash 跟踪是否 outdated）──
//
// 手动复制类：cursor / windsurf / cowork 把 skill md 输出到 ~/Downloads/，
// 用户手动复制到外部工具配置位置。TideMind 不知道用户什么时候复制了，
// 也不知道外部工具实际位置。所以走 hash 跟踪：
//
//   1. 用户点"复制"按钮时，记录当下 source skill md 的 hash
//   2. App 升级后，比较 hash(current source) vs hash(用户最后一次复制时)
//      不一致 → outdated（提示用户重新复制）
//      一致 → 不提示
//
// 设计 doc: docs/design/brain-recall-redesign-2026-05.md §8.4
const SKILL_COPY_STATE_FILENAME = 'skill-copy-state.json'

function skillCopyStatePath(ctx: PluginLookupContext): string {
  return path.join(ctx.runtime.dataDir, SKILL_COPY_STATE_FILENAME)
}

interface SkillCopyEntry {
  hash: string         // SHA-256 of source skill md content at time user clicked "copied"
  copied_at: string    // ISO timestamp
}

type SkillCopyState = Record<string, SkillCopyEntry>

function readSkillCopyState(ctx: PluginLookupContext): SkillCopyState {
  const p = skillCopyStatePath(ctx)
  if (!fs.existsSync(p)) return {}
  try {
    const content = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    // 损坏的 state 文件按"全部 outdated"处理（safe-by-default）。
    // 不在这里删除文件——让 UI 上的"我已复制"按钮重写覆盖。
    return {}
  }
}

export function markSkillCopied(ctx: PluginLookupContext, sourceSkillPath: string): void {
  const state = readSkillCopyState(ctx)
  let hash = ''
  try {
    const content = fs.readFileSync(sourceSkillPath, 'utf-8')
    hash = crypto.createHash('sha256').update(content).digest('hex')
  } catch {
    // source skill md 不存在——记录空 hash（极端情况，正常不会发生）
  }
  state[ctx.clientType] = { hash, copied_at: new Date().toISOString() }
  try {
    writeFileAtomic(skillCopyStatePath(ctx), JSON.stringify(state, null, 2))
  } catch {
    // 写失败不影响主流程——下次 outdated 检测仍会兜底为"outdated"
  }
}

function sourceSkillHash(ctx: PluginLookupContext): string | null {
  // 1. 优先用 client 自己的 skill md（如 cursor-skill.md），找不到回退到 base-skill.md
  const sourceCandidates = [
    path.join(ctx.runtime.skillDir, `${ctx.clientType}-skill.md`),
    path.join(ctx.runtime.skillDir, 'base-skill.md'),
  ]
  for (const candidate of sourceCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        const content = fs.readFileSync(candidate, 'utf-8')
        return crypto.createHash('sha256').update(content).digest('hex')
      } catch {
        return null
      }
    }
  }
  return null
}

function computeSkillOutdated(ctx: PluginLookupContext): boolean {
  const currentHash = sourceSkillHash(ctx)
  if (!currentHash) return false   // source 找不到时不强提示——但 generate 会失败，UI 层会暴露

  const state = readSkillCopyState(ctx)
  const lastCopied = state[ctx.clientType]
  if (!lastCopied) {
    // 从未点过"我已复制"——视为 outdated（提示用户首次复制）
    return true
  }
  return lastCopied.hash !== currentHash
}

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

      // 手动复制类 outdated 检测：hash 跟踪
      // 用户从未点"我已复制" → outdated（首次提示）
      // hash 不一致 → outdated（app 升级后 skill md 变了）
      // hash 一致 → 不提示
      const skillOutdated = (configWritten || outputExists) ? computeSkillOutdated(ctx) : false
      const generatedAt = outputExists
        ? fs.statSync(outputPath).mtime.toISOString()
        : ''

      return {
        exists: configWritten || outputExists,
        pluginDir: options.pluginDirForStatus?.(ctx, outputPath) ?? outputPath,
        clientType: ctx.clientType,
        tools: ['brain_prepare', 'brain_recall', 'brain_digest'],
        skillOutputPath: outputPath,
        skillOutputExists: outputExists,
        skillOutdated,
        generatedAt,
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
