/**
 * 启动时扫描已生成的 plugin 配置，做两件事：
 *   1. 【常规】把过期的 command/script 路径修正为当前的 shim 和 bundled 脚本位置
 *   2. 【一次性过渡清理】删除 External Brain → Tide Mind 改名前遗留的 `external-brain-*`
 *      配置条目，以及 Claude Code 插件 `.mcp.json` 里的 `external-brain` key
 *
 * 设计背景：
 *   Plugin 配置是生成时冷冻的绝对路径 + 标识符。当 Tide Mind 升级/迁移/改名时，
 *   外部 Agent（Claude Code / Cursor / Codex / Windsurf / OpenClaw / Cowork）的配置
 *   文件里仍保留着旧的 shim 路径和旧的 `external-brain` key。这个模块负责兜底。
 *
 * 常规修正场景：
 *   1) 用户从 dev 模式切到 packaged（.app），plugin 里的路径还指向 repo/dist/
 *   2) Electron 升级，process.execPath 变了——shim 通过 runtime-path 吸收了这个变化
 *   3) 用户从 ~/.external-brain 迁移/重装 Tide Mind
 *
 * 一次性清理场景：
 *   旧版本 Tide Mind（品牌名还是 External Brain 时）生成的 plugin 配置里，
 *   MCP server key 形如 `external-brain` / `external-brain-<agentId>`，
 *   Shim 路径在 `~/.external-brain/bin/tm-node`。
 *   升级到新版本后：
 *     - 数据目录已被 migrate-data-dir 重命名为 ~/.tidemind/
 *     - 旧 shim 路径不再存在，旧 key 对应的 MCP server 无法启动
 *   因此 self-heal 会主动把所有旧 key 从外部配置中删除，用户随后通过客户端
 *   重新生成 plugin 即可得到新的 `tidemind-*` key。
 *
 * 自愈不负责创建新的 plugin，只修正/清理已有配置的条目。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type Database from 'better-sqlite3'
import { createLogger } from '@server/utils/logger.js'
import { computePluginPatchVersion } from '../ipc/agent-plugins/claude-code-version'
import { buildClaudeCodeSkillFrontmatter } from '../ipc/agent-plugins/claude-code'
import { repairMarketplaceJson, repairClaudeSettings } from '@server/utils/marketplace-repair.js'
import { getShimPath, getHookScriptPath, getPreCompactHookScriptPath, getPostCompactHookScriptPath, getMcpServerScriptPath } from './runtime-paths'
import { listAgents } from '@server/db/agents.js'
import { safeReadTextFileSync } from '@server/utils/safe-fs.js'

const log = createLogger('plugin-self-heal')

interface HealResult {
  scanned: number
  patched: number
  errors: { file: string; error: string }[]
}

function safeReadJson(filePath: string): any | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    // ENOENT / EACCES / etc. — caller already gates on existsSync so this is
    // typically a permission issue. Stay silent to avoid log noise on every
    // restart; the file simply gets skipped.
    return null
  }
  try {
    return JSON.parse(raw)
  } catch (err: any) {
    // File exists but is not parseable. Self-heal will skip it (returning null
    // → caller's `if (!cfg) return`), so no overwrite happens. But surface a
    // warning so the user / debug logs reveal which third-party config is
    // broken. Especially important because self-heal touches files we don't
    // own (cursor mcp.json, claude_desktop_config.json, openclaw.json).
    log.warn(`self-heal: skipping malformed JSON at ${filePath}: ${err.message}`)
    return null
  }
}

/**
 * Atomic JSON write used by self-heal patches. Pattern matches
 * fs-utils:writeFileAtomic so a crash mid-write leaves the original file
 * intact. Self-heal patches third-party files (claude_desktop_config.json,
 * openclaw.json, codex hooks.json…), so non-atomic writes risk leaving the
 * user with a half-truncated config that breaks their other tools.
 */
function safeWriteJson(filePath: string, obj: any): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2))
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/** Atomic text write counterpart to safeWriteJson, for TOML self-heal. */
function safeWriteText(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    fs.writeFileSync(tmpPath, content)
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/**
 * 判断 mcpServers 条目是否需要修正。
 * 条件：command 不等于当前 shim，或 args[0] 指向的脚本名是 mcp-server.cjs 但路径过期。
 */
function mcpEntryNeedsPatch(entry: any, shimPath: string, mcpServerPath: string): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (entry.command !== shimPath) return true
  if (!Array.isArray(entry.args) || entry.args[0] !== mcpServerPath) return true
  return false
}

function patchMcpEntry(entry: any, shimPath: string, mcpServerPath: string): void {
  entry.command = shimPath
  if (!Array.isArray(entry.args) || entry.args.length === 0) {
    entry.args = [mcpServerPath]
  } else {
    entry.args[0] = mcpServerPath
  }
}

/**
 * 判断 hooks.json 里的 hook command 字符串是否需要修正。
 * 识别特征：包含 `--agent-id <agentId>` 但 command 开头不是当前 shim 路径（带双引号）。
 */
function hookCommandNeedsPatch(command: string, shimPath: string, hookScriptPath: string, agentId: string): boolean {
  if (!command.includes(`--agent-id`)) return false
  if (!command.includes(agentId)) return false
  const expectedPrefix = `${JSON.stringify(shimPath)} ${JSON.stringify(hookScriptPath)}`
  return !command.startsWith(expectedPrefix)
}

function rebuildHookCommand(shimPath: string, hookScriptPath: string, agentId: string, skillPath: string | undefined, tool: string): string {
  const parts = [
    JSON.stringify(shimPath),
    JSON.stringify(hookScriptPath),
    '--agent-id', JSON.stringify(agentId),
  ]
  // SessionStart hook 需要 --skill-path（读 SKILL.md 原文注入），
  // PostCompact hook 不需要（只重注精简画像）
  if (skillPath !== undefined) {
    parts.push('--skill-path', JSON.stringify(skillPath))
  }
  parts.push('--tool', JSON.stringify(tool))
  return parts.join(' ')
}

/**
 * 从已有 hook command 中尽力提取 agent-id / skill-path / tool，以便重建。
 * 正则匹配带双引号或不带的参数值。
 */
function parseHookCommand(command: string): { agentId?: string; skillPath?: string; tool?: string } {
  const extract = (flag: string): string | undefined => {
    const re = new RegExp(`--${flag}\\s+(?:"([^"]+)"|(\\S+))`)
    const m = command.match(re)
    return m ? (m[1] ?? m[2]) : undefined
  }
  return {
    agentId: extract('agent-id'),
    skillPath: extract('skill-path'),
    tool: extract('tool'),
  }
}

// ----------------------------------------------------------
// 每类配置文件的修正逻辑
// ----------------------------------------------------------

/**
 * 从 SessionStart hook 的 command 里提取 agentId 和 tool，用于升级老 agent
 * 时构造缺失的 PostCompact 段。
 */
function extractSessionIdentity(sessionStartSection: any[]): { agentId: string; tool: string } | null {
  for (const group of sessionStartSection) {
    if (!Array.isArray(group?.hooks)) continue
    for (const h of group.hooks) {
      if (typeof h?.command !== 'string') continue
      const parsed = parseHookCommand(h.command)
      if (parsed.agentId && parsed.tool) return { agentId: parsed.agentId, tool: parsed.tool }
    }
  }
  return null
}

function buildPostCompactSection(shimPath: string, postCompactScriptPath: string, agentId: string, tool: string): any[] {
  return [
    {
      hooks: [
        {
          type: 'command',
          command: rebuildHookCommand(shimPath, postCompactScriptPath, agentId, undefined, tool),
          timeout: 10000,
          statusMessage: '恢复外脑上下文...',
        },
      ],
    },
  ]
}

/**
 * PreCompact 必须传 --tool,与 PostCompact / SessionStart 一致。
 *
 * 历史 bug(audit P0-2 2026-05-09):本函数原本只传 --agent-id 不传 --tool,
 * src/hook-pre-compact.ts:24-43 的 parseArgs 默认 tool='claude-code',
 * Codex 用户的 hooks.json 在 self-heal "升级" 后失去 --tool,
 * hook 输出退化为 plain text → Codex 0.126+ JSON 解析失败 → additionalContext
 * 静默丢失。修复:tool 透传到命令行,与 PostCompact / SessionStart 形态一致。
 */
function buildPreCompactCommand(shimPath: string, preCompactScriptPath: string, agentId: string, tool: string): string {
  return [
    JSON.stringify(shimPath),
    JSON.stringify(preCompactScriptPath),
    '--agent-id', JSON.stringify(agentId),
    '--tool', JSON.stringify(tool),
  ].join(' ')
}

function preCompactCommandNeedsPatch(command: string, shimPath: string, preCompactScriptPath: string): boolean {
  // 老的 echo 形态:不含 --agent-id,整段需要升级
  if (!command.includes('--agent-id')) return true
  // 缺 --tool(老版 self-heal 没传),需要重建
  if (!command.includes('--tool')) return true
  // 新脚本形态但路径过期
  const expectedPrefix = `${JSON.stringify(shimPath)} ${JSON.stringify(preCompactScriptPath)}`
  return !command.startsWith(expectedPrefix)
}

/** Claude Code plugin 目录下的 .mcp.json 和 hooks.json */
/**
 * 检查 Claude Code SKILL.md 的 frontmatter,如果是老版本(只有 description,没有
 * when_to_use / allowed-tools)就用 buildClaudeCodeSkillFrontmatter 重写一遍。
 *
 * Why: Phase 1 升级了 frontmatter 字段,但 self-heal 没同步处理,老用户需要手动
 * "重建 plugin" 才能享用新 frontmatter。
 * How to apply: 在 healClaudeCodePlugins 每个 plugin 循环里调一次。
 *
 * @internal exported only for unit testing.
 */
export function healClaudeCodeSkillFile(pluginDir: string, result: HealResult): void {
  const skillFilePath = path.join(pluginDir, 'skills', 'tidemind', 'SKILL.md')
  if (!fs.existsSync(skillFilePath)) return

  result.scanned++
  let content: string
  try {
    content = fs.readFileSync(skillFilePath, 'utf-8')
  } catch (err: any) {
    result.errors.push({ file: skillFilePath, error: err.message })
    return
  }

  // 必须以 --- 开头才认为有 frontmatter。
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return

  // 找到第二个 --- 边界。
  const closeMatch = content.indexOf('\n---\n', 4)
  const closeIdx = closeMatch === -1 ? content.indexOf('\n---\r\n', 4) : closeMatch
  if (closeIdx === -1) return  // 残缺 frontmatter,不动

  const frontmatterRaw = content.substring(0, closeIdx)
  // 已含 when_to_use 字段就不需要重写
  if (/^when_to_use\s*:/m.test(frontmatterRaw)) return

  // 解析 plugin.json 拿 name 字段。失败 → 用目录名作 fallback。
  const pluginJsonFile = path.join(pluginDir, '.claude-plugin', 'plugin.json')
  let pluginName = path.basename(pluginDir)
  const pluginCfg = safeReadJson(pluginJsonFile)
  if (pluginCfg?.name && typeof pluginCfg.name === 'string') {
    pluginName = pluginCfg.name
  }

  // 从老 frontmatter 提取 description,没有则给默认值。
  const descMatch = frontmatterRaw.match(/^description\s*:\s*"?([^"\n]+)"?/m)
  const skillDescription = descMatch ? descMatch[1].trim() : '外部记忆系统'

  // 计算 body 起始(跳过结束的 \n---\n)。
  const closeMarkerLen = content.substring(closeIdx).startsWith('\n---\r\n') ? 6 : 5
  const bodyStart = closeIdx + closeMarkerLen
  const body = content.substring(bodyStart)

  const newContent = buildClaudeCodeSkillFrontmatter(pluginName, skillDescription) + body

  try {
    safeWriteText(skillFilePath, newContent)
    result.patched++
    log.info(`patched SKILL.md frontmatter: ${skillFilePath}`)
  } catch (err: any) {
    result.errors.push({ file: skillFilePath, error: err.message })
  }
}

function healClaudeCodePlugins(
  pluginsRoot: string,
  shimPath: string,
  mcpServerPath: string,
  hookScriptPath: string,
  preCompactScriptPath: string,
  postCompactScriptPath: string,
  result: HealResult,
): void {
  if (!fs.existsSync(pluginsRoot)) return
  let entries: string[] = []
  try {
    entries = fs.readdirSync(pluginsRoot)
  } catch { return }

  for (const name of entries) {
    if (!name.startsWith('claude-code-')) continue
    const pluginDir = path.join(pluginsRoot, name)
    if (!fs.statSync(pluginDir).isDirectory()) continue

    // .mcp.json
    const mcpPath = path.join(pluginDir, '.mcp.json')
    if (fs.existsSync(mcpPath)) {
      result.scanned++
      const cfg = safeReadJson(mcpPath)
      let changed = false

      // 一次性过渡清理：删除遗留的 'external-brain' key
      if (cfg?.mcpServers && 'external-brain' in cfg.mcpServers) {
        delete cfg.mcpServers['external-brain']
        changed = true
        log.info(`cleanup legacy key 'external-brain' in: ${mcpPath}`)
      }

      // 常规修正：patch 新的 'tidemind' key 的路径
      if (cfg?.mcpServers?.['tidemind']) {
        if (mcpEntryNeedsPatch(cfg.mcpServers['tidemind'], shimPath, mcpServerPath)) {
          patchMcpEntry(cfg.mcpServers['tidemind'], shimPath, mcpServerPath)
          changed = true
        }
      }

      if (changed) {
        try {
          safeWriteJson(mcpPath, cfg)
          result.patched++
          log.info(`patched: ${mcpPath}`)
        } catch (err: any) {
          result.errors.push({ file: mcpPath, error: err.message })
        }
      }
    }

    // hooks/hooks.json
    // 注意:历史上这里用过 `if (!cfg?.hooks) continue`,但那个 continue 会跳到
    // 外层 plugin 循环的下一次迭代,把本 plugin 的 step 4/5/6(SKILL.md / version /
    // cache mirror)全部静默跳过——hooks.json 一旦被用户手改坏(变成空 `{}`),
    // SKILL frontmatter 永远不会被 patch、plugin.json#version 永远不会 bump,
    // 整个 plugin 卡在 partial-broken 状态。改成正向条件,避免污染外层循环。
    const hooksPath = path.join(pluginDir, 'hooks', 'hooks.json')
    if (fs.existsSync(hooksPath)) {
      result.scanned++
      const cfg = safeReadJson(hooksPath)
      if (cfg?.hooks) {
        let changed = false

        // 1) SessionStart 路径修正（原有逻辑）
        if (cfg.hooks.SessionStart) {
          for (const group of cfg.hooks.SessionStart) {
            if (!Array.isArray(group?.hooks)) continue
            for (const h of group.hooks) {
              if (typeof h?.command !== 'string') continue
              const parsed = parseHookCommand(h.command)
              if (!parsed.agentId || !parsed.skillPath || !parsed.tool) continue
              if (hookCommandNeedsPatch(h.command, shimPath, hookScriptPath, parsed.agentId)) {
                h.command = rebuildHookCommand(shimPath, hookScriptPath, parsed.agentId, parsed.skillPath, parsed.tool)
                changed = true
              }
            }
          }
        }

        const identity = cfg.hooks.SessionStart ? extractSessionIdentity(cfg.hooks.SessionStart) : null

        // 2) PreCompact：老版本是硬编码 echo 字符串，升级到脚本形态。
        //    有且是 echo：整段替换；有且是新脚本形态但路径过期：修正路径
        if (identity && Array.isArray(cfg.hooks.PreCompact)) {
          for (const group of cfg.hooks.PreCompact) {
            if (!Array.isArray(group?.hooks)) continue
            for (const h of group.hooks) {
              if (typeof h?.command !== 'string') continue
              if (preCompactCommandNeedsPatch(h.command, shimPath, preCompactScriptPath)) {
                h.command = buildPreCompactCommand(shimPath, preCompactScriptPath, identity.agentId, identity.tool)
                if (typeof h.timeout !== 'number') h.timeout = 10000
                changed = true
              }
            }
          }
        }

        // 3) PostCompact：新增 hook，老 agent 可能没有这段。
        //    有：按路径修正；无：从 SessionStart 提取 identity，补齐
        if (identity) {
          if (!Array.isArray(cfg.hooks.PostCompact) || cfg.hooks.PostCompact.length === 0) {
            cfg.hooks.PostCompact = buildPostCompactSection(shimPath, postCompactScriptPath, identity.agentId, identity.tool)
            changed = true
            log.info(`added missing PostCompact section to: ${hooksPath}`)
          } else {
            for (const group of cfg.hooks.PostCompact) {
              if (!Array.isArray(group?.hooks)) continue
              for (const h of group.hooks) {
                if (typeof h?.command !== 'string') continue
                const parsed = parseHookCommand(h.command)
                if (!parsed.agentId || !parsed.tool) continue
                if (hookCommandNeedsPatch(h.command, shimPath, postCompactScriptPath, parsed.agentId)) {
                  h.command = rebuildHookCommand(shimPath, postCompactScriptPath, parsed.agentId, undefined, parsed.tool)
                  changed = true
                }
              }
            }
          }
        }

        if (changed) {
          try {
            safeWriteJson(hooksPath, cfg)
            result.patched++
            log.info(`patched: ${hooksPath}`)
          } catch (err: any) {
            result.errors.push({ file: hooksPath, error: err.message })
          }
        }
      }
    }

    // 4) SKILL.md frontmatter:老版本 plugin 只生成了 description,缺
    //    when_to_use / allowed-tools 字段。补齐后下面 syncPluginVersion
    //    会把 SKILL.md 内容哈希反映到 plugin.json 的 version,从而失效缓存。
    healClaudeCodeSkillFile(pluginDir, result)

    // 5) plugin.json#version 必须跟 hooks.json/.mcp.json/SKILL.md 内容同步,
    //    Claude Code 在 ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
    //    下按 version 缓存,若 version 不变,缓存里的旧 hooks.json 永不更新。
    syncPluginVersion(pluginDir, result)

    // 6) Claude Code 的本地缓存可能仍是旧版本的拷贝。即便我们 bump 了 plugin.json
    //    的 version,Claude 可能不会立即丢弃旧 cache。为兜底:把源镜像同步进
    //    cache 里的所有 version 目录,让"现存任何版本被读到"都是正确内容。
    mirrorPluginToClaudeCache(pluginsRoot, name, result)
  }
}

/**
 * 把 plugin.json 的 version 同步到当前 hooks.json/.mcp.json/SKILL.md
 * 的内容哈希。任何路径或文案变更都会让 Claude Code 把缓存目录名认成
 * 新版本,从而重新拉取插件文件。
 *
 * @internal exported only for unit testing.
 */
export function syncPluginVersion(pluginDir: string, result: HealResult): void {
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json')
  if (!fs.existsSync(pluginJsonPath)) return
  const cfg = safeReadJson(pluginJsonPath)
  if (!cfg || typeof cfg !== 'object') return
  const expected = computePluginPatchVersion(pluginDir)
  if (cfg.version === expected) return
  result.scanned++
  cfg.version = expected
  try {
    safeWriteJson(pluginJsonPath, cfg)
    result.patched++
    log.info(`bumped plugin version to ${expected}: ${pluginJsonPath}`)
  } catch (err: any) {
    result.errors.push({ file: pluginJsonPath, error: err.message })
  }
}

// 故意不镜像 .claude-plugin/plugin.json:cache 目录名是 Claude 选定的某个
// version,而我们更新过的 plugin.json#version 是新的 hash 串,把新 plugin.json
// 写进旧 version 目录会出现"目录名 != plugin.json#version"的不一致。Claude
// Code 在按 version 路由缓存时看的是目录名,不是文件内容,所以镜像 plugin.json
// 本身没有意义,反而引入语义混淆。bump version 已足够触发 Claude 重新缓存。
const CACHE_MIRRORED_FILES = [
  'hooks/hooks.json',
  '.mcp.json',
  'skills/tidemind/SKILL.md',
] as const

/**
 * 把已修复的源插件文件镜像到 Claude Code 的本地缓存目录,治理"plugin
 * version 没变 → 缓存内容陈旧"的存量问题。Claude Code 的缓存路径形如:
 *
 *   ~/.claude/plugins/cache/<marketplace>/<plugin-name>/<version>/...
 *
 * 我们不知道哪个 version 是"活的",所以遍历所有 version 子目录,把镜像
 * 内容写进去。这样无论 Claude Code 选用哪个 version 缓存条目,内容都是
 * 当前正确的。bump version 之后新缓存目录会被 Claude 自动建立,旧目录
 * 也被覆盖到正确内容,两边都不会回到旧路径。
 *
 * @internal exported only for unit testing.
 */
export function mirrorPluginToClaudeCache(
  pluginsRoot: string,
  pluginDirName: string,
  result: HealResult,
  homeDir: string = os.homedir(),
): void {
  const sourcePluginDir = path.join(pluginsRoot, pluginDirName)
  // pluginDirName 是 `claude-code-<agentId>`,但 marketplace.json 里的
  // plugin name 是 `tidemind-<agentId>`(见 claudeCodeAdapter.generate)。
  // 缓存目录用 plugin name,不是目录名。
  const sourcePluginJson = path.join(sourcePluginDir, '.claude-plugin', 'plugin.json')
  let pluginName: string | null = null
  // Audit-3 F9 修复:走 safe-fs。pluginsRoot 是 ~/Library/Application Support/eb/...,
  // 用户在 iCloud "优化存储" 时可能被驱逐成 dataless,readFileSync 会同步阻塞。
  const pjRead = safeReadTextFileSync(sourcePluginJson)
  if (!pjRead.ok) {
    // plugin.json 缺失/dataless/损坏:无法决定缓存目录名,跳过镜像。
    return
  }
  try {
    const pj = JSON.parse(pjRead.content)
    if (typeof pj?.name === 'string') pluginName = pj.name
  } catch {
    return
  }
  if (!pluginName) return

  // 遍历所有 marketplace 下的同名 plugin 缓存(理论上只有 tidemind-local,
  // 但有遗留 external-brain-local 的环境也一并覆盖)。
  const cacheRoot = path.join(homeDir, '.claude', 'plugins', 'cache')
  if (!fs.existsSync(cacheRoot)) return

  let marketplaces: string[] = []
  try {
    marketplaces = fs.readdirSync(cacheRoot)
  } catch { return }

  for (const marketplace of marketplaces) {
    const pluginCacheRoot = path.join(cacheRoot, marketplace, pluginName)
    if (!fs.existsSync(pluginCacheRoot)) continue
    let versions: string[] = []
    try {
      versions = fs.readdirSync(pluginCacheRoot)
    } catch { continue }
    for (const version of versions) {
      const versionDir = path.join(pluginCacheRoot, version)
      // Audit-3 F9 修复:用 lstatSync(不跟随 symlink),且显式跳过 symlink 目录。
      // 之前 statSync 会跟随 symlink → 攻击者(或恶意软件)在 cache 下种一个指向
      // 任意目录的 symlink,镜像逻辑会顺着 symlink 写到 cacheRoot 之外。
      let lstat: fs.Stats
      try {
        lstat = fs.lstatSync(versionDir)
      } catch { continue }
      if (lstat.isSymbolicLink()) {
        log.warn(`skipping symlink in cache dir: ${versionDir}`)
        continue
      }
      if (!lstat.isDirectory()) continue
      // 二次防御:确保 versionDir 真的在 cacheRoot 之下(即便没有 symlink,防御
      // path traversal,例如版本目录名含 '../')
      if (!isPathWithinRoot(versionDir, cacheRoot)) {
        log.warn(`skipping out-of-root version dir: ${versionDir}`)
        continue
      }
      mirrorVersionDir(sourcePluginDir, versionDir, result)
    }
  }
}

/**
 * Audit-3 F9:验证 candidate 真实路径在 root 之下,防御 path traversal 与 symlink 跳出。
 * 用 path.resolve 把 '..' 展开,再用 startsWith + path separator 校验。
 */
function isPathWithinRoot(candidate: string, root: string): boolean {
  const resolvedCand = path.resolve(candidate)
  const resolvedRoot = path.resolve(root)
  const sep = path.sep
  return resolvedCand === resolvedRoot
    || resolvedCand.startsWith(resolvedRoot + sep)
}

function mirrorVersionDir(sourcePluginDir: string, versionDir: string, result: HealResult): void {
  for (const rel of CACHE_MIRRORED_FILES) {
    const src = path.join(sourcePluginDir, rel)
    const dst = path.join(versionDir, rel)
    if (!fs.existsSync(src) || !fs.existsSync(dst)) continue
    // Audit-3 F9 修复:dst 是 ~/.claude/plugins/cache/* 下的文件,理论上是程序自己写的,
    // 但用户家目录在 iCloud Drive 时会被 "优化存储" 驱逐成 dataless,fs.readFileSync 命中
    // 会同步阻塞主进程触发 iCloud 下载。走 safeReadTextFileSync,dataless 文件直接跳过。
    const srcRead = safeReadTextFileSync(src)
    if (!srcRead.ok) continue
    const dstRead = safeReadTextFileSync(dst)
    if (!dstRead.ok) continue
    const srcContent = srcRead.content
    const dstContent = dstRead.content
    if (srcContent === dstContent) continue
    result.scanned++
    try {
      // 用与 safeWriteJson 同形态的原子写,文本/JSON 通用——
      // 直接写源端 raw 内容,避免 JSON.parse → stringify 改变格式。
      safeWriteText(dst, srcContent)
      result.patched++
      log.info(`mirrored ${rel} into stale cache: ${dst}`)
    } catch (err: any) {
      result.errors.push({ file: dst, error: err.message })
    }
  }
}

/**
 * Cursor / Windsurf / Cowork 共通的 mcp config 修正（扁平 mcpServers 结构）。
 *
 * @param expectedAgentIds 应该存在于此配置文件中的 agent ID 列表。
 *   如果传入且非空，当配置文件中缺少对应的 `tidemind-{agentId}` 条目时会重建。
 *   这解决了 Claude Desktop 覆写配置导致 mcpServers 整段丢失的问题。
 */
function healMcpServersFile(filePath: string, shimPath: string, mcpServerPath: string, result: HealResult, expectedAgentIds?: string[]): void {
  if (!fs.existsSync(filePath)) return
  result.scanned++
  const cfg = safeReadJson(filePath)
  if (!cfg) return
  let changed = false

  // 确保 mcpServers 字段存在（可能被外部程序覆写丢失）
  if (!cfg.mcpServers) {
    // 没有 expectedAgentIds 需要重建时，保持原有行为——直接跳过
    if (!expectedAgentIds || expectedAgentIds.length === 0) return
    cfg.mcpServers = {}
  }

  // 一次性过渡清理：删除 external-brain-* 旧条目
  for (const name of Object.keys(cfg.mcpServers)) {
    if (name.startsWith('external-brain-')) {
      delete cfg.mcpServers[name]
      changed = true
      log.info(`cleanup legacy key '${name}' in: ${filePath}`)
    }
  }

  // 常规修正：patch tidemind-* 已有条目的路径
  for (const [name, entry] of Object.entries<any>(cfg.mcpServers)) {
    if (!name.startsWith('tidemind-')) continue
    if (mcpEntryNeedsPatch(entry, shimPath, mcpServerPath)) {
      patchMcpEntry(entry, shimPath, mcpServerPath)
      changed = true
    }
  }

  // 重建丢失的条目：expectedAgentIds 中存在但 mcpServers 中缺失的
  if (expectedAgentIds) {
    for (const agentId of expectedAgentIds) {
      const key = `tidemind-${agentId}`
      if (!cfg.mcpServers[key]) {
        cfg.mcpServers[key] = {
          command: shimPath,
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        }
        changed = true
        log.info(`rebuilt missing entry '${key}' in: ${filePath}`)
      }
    }
  }

  if (changed) {
    try {
      safeWriteJson(filePath, cfg)
      result.patched++
      log.info(`patched: ${filePath}`)
    } catch (err: any) {
      result.errors.push({ file: filePath, error: err.message })
    }
  }
}

/** OpenClaw 配置：mcp.servers 嵌套一层 */
function healOpenclawConfig(filePath: string, shimPath: string, mcpServerPath: string, result: HealResult): void {
  if (!fs.existsSync(filePath)) return
  result.scanned++
  const cfg = safeReadJson(filePath)
  if (!cfg?.mcp?.servers) return
  let changed = false

  // 一次性过渡清理：删除 external-brain-* 旧条目
  for (const name of Object.keys(cfg.mcp.servers)) {
    if (name.startsWith('external-brain-')) {
      delete cfg.mcp.servers[name]
      changed = true
      log.info(`cleanup legacy key '${name}' in: ${filePath}`)
    }
  }

  // 常规修正：patch tidemind-* 新条目
  for (const [name, entry] of Object.entries<any>(cfg.mcp.servers)) {
    if (!name.startsWith('tidemind-')) continue
    if (mcpEntryNeedsPatch(entry, shimPath, mcpServerPath)) {
      patchMcpEntry(entry, shimPath, mcpServerPath)
      changed = true
    }
  }

  if (changed) {
    try {
      safeWriteJson(filePath, cfg)
      result.patched++
      log.info(`patched: ${filePath}`)
    } catch (err: any) {
      result.errors.push({ file: filePath, error: err.message })
    }
  }
}

/** Codex hooks.json（结构和 Claude Code 的 hooks.json 几乎一样，复用逻辑） */
function healCodexHooks(filePath: string, shimPath: string, hookScriptPath: string, result: HealResult): void {
  if (!fs.existsSync(filePath)) return
  result.scanned++
  const cfg = safeReadJson(filePath)
  if (!cfg?.hooks?.SessionStart) return
  let changed = false
  for (const group of cfg.hooks.SessionStart) {
    if (!Array.isArray(group?.hooks)) continue
    for (const h of group.hooks) {
      if (typeof h?.command !== 'string') continue
      if (!h.command.includes('--agent-id')) continue
      const parsed = parseHookCommand(h.command)
      if (!parsed.agentId || !parsed.skillPath || !parsed.tool) continue
      if (hookCommandNeedsPatch(h.command, shimPath, hookScriptPath, parsed.agentId)) {
        h.command = rebuildHookCommand(shimPath, hookScriptPath, parsed.agentId, parsed.skillPath, parsed.tool)
        changed = true
      }
    }
  }
  if (changed) {
    try {
      safeWriteJson(filePath, cfg)
      result.patched++
      log.info(`patched: ${filePath}`)
    } catch (err: any) {
      result.errors.push({ file: filePath, error: err.message })
    }
  }
}

/**
 * Codex TOML config 中的 [mcp_servers.tidemind-*] 段落路径修正，
 * 以及 [mcp_servers.external-brain-*] 旧段落的一次性清理。
 * 用字符串替换：找到 `command = "..."` 和 `args = [...]` 行并替换。
 * 简单粗暴但够用——toml-utils 的 appendTomlMcpSection 会在 self-heal 场景下重复追加段落，不合适。
 */
function healCodexTomlConfig(filePath: string, shimPath: string, mcpServerPath: string, result: HealResult): void {
  if (!fs.existsSync(filePath)) return
  result.scanned++
  let content: string
  try { content = fs.readFileSync(filePath, 'utf-8') } catch { return }

  let changed = false

  // 一次性过渡清理：移除 [mcp_servers.external-brain-*] 段落
  // 匹配从段落标题开始到下一个段落或文件结尾
  const legacySectionRe = /(?:^|\n)\[mcp_servers\.external-brain-[\w-]+\][\s\S]*?(?=\n\[|$)/g
  const withoutLegacy = content.replace(legacySectionRe, '')
  if (withoutLegacy !== content) {
    content = withoutLegacy
    changed = true
    log.info(`cleanup legacy [mcp_servers.external-brain-*] sections in: ${filePath}`)
  }

  // 常规修正：patch [mcp_servers.tidemind-*] 段落的路径
  const sectionRe = /\[mcp_servers\.(tidemind-[\w-]+)\]([\s\S]*?)(?=\n\[|\n*$)/g
  const patched = content.replace(sectionRe, (whole: string, _name: string, body: string) => {
    let newBody = body
    // command = "..."
    const cmdRe = /^(\s*)command\s*=\s*"[^"]*"/m
    if (cmdRe.test(newBody)) {
      const replacement = `$1command = ${JSON.stringify(shimPath)}`
      const updated = newBody.replace(cmdRe, replacement)
      if (updated !== newBody) { newBody = updated; changed = true }
    }
    // args = [ "..." ] 只改第一个元素
    const argsRe = /^(\s*)args\s*=\s*\[\s*"[^"]*"([\s\S]*?)\]/m
    if (argsRe.test(newBody)) {
      const replacement = `$1args = [${JSON.stringify(mcpServerPath)}$2]`
      const updated = newBody.replace(argsRe, replacement)
      if (updated !== newBody) { newBody = updated; changed = true }
    }
    return whole.replace(body, newBody)
  })

  if (changed) {
    try {
      safeWriteText(filePath, patched)
      result.patched++
      log.info(`patched: ${filePath}`)
    } catch (err: any) {
      result.errors.push({ file: filePath, error: err.message })
    }
  }
}

// ----------------------------------------------------------
// marketplace.json 过渡清理
// ----------------------------------------------------------

/**
 * 修复 Tide Mind 自己的 local marketplace.json：
 *   - 顶层 name/description/owner 强制改为新品牌
 *   - plugins 列表里的 external-brain-* 旧条目删掉
 * 只处理这一个文件，不触碰 Claude Code 真正的 plugin 安装位置。
 *
 * 纯转换逻辑在 src/utils/marketplace-repair.ts，方便单元测试。
 */
function healLocalMarketplace(pluginsRoot: string, result: HealResult): void {
  const mpPath = path.join(pluginsRoot, '.claude-plugin', 'marketplace.json')
  if (!fs.existsSync(mpPath)) return
  result.scanned++
  const cfg = safeReadJson(mpPath)
  if (!cfg || typeof cfg !== 'object') return

  const { output, changed, removedLegacyPlugins } = repairMarketplaceJson(cfg)
  if (!changed) return

  if (removedLegacyPlugins > 0) {
    log.info(`removed ${removedLegacyPlugins} legacy external-brain-* entries from: ${mpPath}`)
  }
  try {
    safeWriteJson(mpPath, output)
    result.patched++
    log.info(`patched marketplace: ${mpPath}`)
  } catch (err: any) {
    result.errors.push({ file: mpPath, error: err.message })
  }
}

/**
 * 修复 Claude Code settings.json 里的 extraKnownMarketplaces：
 *   - 删除遗留的 external-brain-local 条目
 *   - 这不会影响 Claude Code 真正的内部 marketplace 状态（那是独立的），
 *     但至少让 settings.json 自身保持干净。
 *     真正的内部状态要在 install-plugin handler 里通过 CLI 命令 remove。
 */
function healClaudeSettings(result: HealResult): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) return
  result.scanned++
  const cfg = safeReadJson(settingsPath)
  if (!cfg || typeof cfg !== 'object') return

  const { output, changed, removedKeys } = repairClaudeSettings(cfg)
  if (!changed) return

  log.info(`removed legacy extraKnownMarketplaces keys [${removedKeys.join(', ')}] from: ${settingsPath}`)
  try {
    safeWriteJson(settingsPath, output)
    result.patched++
  } catch (err: any) {
    result.errors.push({ file: settingsPath, error: err.message })
  }
}

// ----------------------------------------------------------
// 主入口
// ----------------------------------------------------------

/**
 * 按 tool_type 分组获取活跃 agent ID 列表。
 * 这些 ID 用于判断哪些配置文件中应该有对应的 MCP 条目——
 * 如果条目丢失（比如被外部程序覆写），自愈会重建它们。
 */
function getExpectedAgentIdsByType(db?: Database.Database): Record<string, string[]> {
  if (!db) return {}
  try {
    const agents = listAgents(db, false) // 只取未归档的
    const byType: Record<string, string[]> = {}
    for (const agent of agents) {
      if (!byType[agent.tool_type]) byType[agent.tool_type] = []
      byType[agent.tool_type].push(agent.id)
    }
    return byType
  } catch (err: any) {
    log.warn(`failed to query agents for self-heal: ${err.message}`)
    return {}
  }
}

export function selfHealPlugins(dataDir: string, db?: Database.Database): HealResult {
  const shimPath = getShimPath()
  const mcpServerPath = getMcpServerScriptPath()
  const hookScriptPath = getHookScriptPath()
  const preCompactScriptPath = getPreCompactHookScriptPath()
  const postCompactScriptPath = getPostCompactHookScriptPath()
  const result: HealResult = { scanned: 0, patched: 0, errors: [] }

  const agentsByType = getExpectedAgentIdsByType(db)

  // Claude Code
  healClaudeCodePlugins(path.join(dataDir, 'plugins'), shimPath, mcpServerPath, hookScriptPath, preCompactScriptPath, postCompactScriptPath, result)

  // Tide Mind 自己的 local marketplace.json（过渡清理）
  healLocalMarketplace(path.join(dataDir, 'plugins'), result)

  // Claude Code settings.json 里的 extraKnownMarketplaces 遗留条目
  healClaudeSettings(result)

  // Cursor
  healMcpServersFile(path.join(os.homedir(), '.cursor', 'mcp.json'), shimPath, mcpServerPath, result, agentsByType['cursor'])

  // Windsurf
  healMcpServersFile(path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'), shimPath, mcpServerPath, result, agentsByType['windsurf'])

  // Claude Cowork (Desktop)
  healMcpServersFile(
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    shimPath,
    mcpServerPath,
    result,
    agentsByType['cowork'],
  )

  // OpenClaw
  healOpenclawConfig(path.join(os.homedir(), '.openclaw', 'openclaw.json'), shimPath, mcpServerPath, result)

  // Codex
  healCodexHooks(path.join(os.homedir(), '.codex', 'hooks.json'), shimPath, hookScriptPath, result)
  healCodexTomlConfig(path.join(os.homedir(), '.codex', 'config.toml'), shimPath, mcpServerPath, result)

  log.info(`self-heal done: scanned=${result.scanned} patched=${result.patched} errors=${result.errors.length}`)
  if (result.errors.length > 0) {
    for (const e of result.errors) log.warn(`self-heal error: ${e.file} — ${e.error}`)
  }
  return result
}
