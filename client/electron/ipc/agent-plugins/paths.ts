import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getHookScriptPath,
  getMcpServerScriptPath,
  getPostCompactHookScriptPath,
  getPreCompactHookScriptPath,
  getShimPath,
} from '../../runtime/runtime-paths'
import { assertPathWithinRoot } from '../_validate'
import {
  CLIENT_CONFIG,
  type GeneratePluginContext,
  type PluginClientType,
  type PluginLookupContext,
  type PluginRuntimeContext,
} from './types'

export function createPluginRuntimeContext(dataDir: string, homeDir = os.homedir()): PluginRuntimeContext {
  return {
    dataDir,
    pluginsDir: path.join(dataDir, 'plugins'),
    skillDir: path.join(dataDir, 'skill'),
    shimPath: getShimPath(),
    mcpServerPath: getMcpServerScriptPath(),
    hookScriptPath: getHookScriptPath(),
    preCompactScriptPath: getPreCompactHookScriptPath(),
    postCompactScriptPath: getPostCompactHookScriptPath(),
    homeDir,
  }
}

export function buildPluginLookupContext(
  runtime: PluginRuntimeContext,
  agentId: string,
  clientType: PluginClientType,
): PluginLookupContext {
  const config = CLIENT_CONFIG[clientType]
  const pluginName = `tidemind-${agentId}`
  const pluginDirName = `${config.dirPrefix}-${agentId}`
  const pluginDir = path.join(runtime.pluginsDir, pluginDirName)
  assertPathWithinRoot(pluginDir, runtime.pluginsDir)
  return {
    runtime,
    agentId,
    clientType,
    config,
    pluginName,
    pluginDirName,
    pluginDir,
  }
}

export function buildGeneratePluginContext(
  runtime: PluginRuntimeContext,
  agentId: string,
  agentName: string,
  clientType: PluginClientType,
): GeneratePluginContext {
  return {
    ...buildPluginLookupContext(runtime, agentId, clientType),
    agentName,
    skillContent: loadSkillContent(runtime, CLIENT_CONFIG[clientType].skillSource),
  }
}

export function loadSkillContent(runtime: PluginRuntimeContext, skillSource: string): string {
  const primarySkillPath = path.join(runtime.skillDir, skillSource)
  const fallbackSkillPath = path.join(runtime.skillDir, 'base-skill.md')
  if (fs.existsSync(primarySkillPath)) return fs.readFileSync(primarySkillPath, 'utf-8')
  if (fs.existsSync(fallbackSkillPath)) return fs.readFileSync(fallbackSkillPath, 'utf-8')
  return ''
}

export function downloadPath(runtime: PluginRuntimeContext, name: string): string {
  return path.join(runtime.homeDir, 'Downloads', name)
}

export function mcpServerEntry(runtime: PluginRuntimeContext, agentId: string): {
  command: string
  args: string[]
  env: { EB_AGENT_ID: string }
} {
  return {
    command: runtime.shimPath,
    args: [runtime.mcpServerPath],
    env: { EB_AGENT_ID: agentId },
  }
}

/**
 * 调用 claude CLI 时的环境变量。
 *
 * 安全考量：不直接 `...process.env` 透传——Electron 主进程可能携带各种敏感凭证
 * (ANTHROPIC_API_KEY / OAUTH 令牌 / 内部 ENV 等)，无控透传到外部 claude CLI 会让
 * 凭证流向不在 TideMind 控制范围的进程。
 *
 * 策略：只白名单透传少量必要的 POSIX 环境变量；PATH 固定为系统标准路径
 * (不追加用户自定义 PATH，防止恶意 entry 抢占)。如果用户需要给 claude CLI
 * 自定义 ANTHROPIC_API_KEY 等，应在 claude CLI 自己的配置文件内设置。
 */
export function cliEnv(): NodeJS.ProcessEnv {
  const allowList = ['HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'PWD']
  const filtered: NodeJS.ProcessEnv = {}
  for (const key of allowList) {
    const value = process.env[key]
    if (value !== undefined) filtered[key] = value
  }
  // 固定 PATH（不追加用户 PATH，防恶意 entry 优先）。除系统标准目录外补两个
  // CLI 官方原生安装位置:~/.local/bin(claude / codex / gemini 原生安装器默认落点)
  // 与 nvm 最新版 bin。否则 checkCli 用继承 PATH 的 `which` 能检测到、但用本固定
  // PATH 执行时 ENOENT,出现"检测到可用 → install 失败"的脱节。
  const home = process.env.HOME ?? ''
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  if (home) {
    dirs.push(`${home}/.local/bin`)
    const nvmBin = latestNvmBinDir(home)
    if (nvmBin) dirs.push(nvmBin)
  }
  filtered.PATH = dirs.join(':')
  return filtered
}

/** 解析 ~/.nvm/versions/node 下最新版本的 bin 目录;不存在返回 null。 */
function latestNvmBinDir(home: string): string | null {
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
  try {
    const versions = fs.readdirSync(nvmRoot)
      .filter(v => v.startsWith('v'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const latest = versions[versions.length - 1]
    if (!latest) return null
    const binDir = path.join(nvmRoot, latest, 'bin')
    return fs.existsSync(binDir) ? binDir : null
  } catch {
    return null
  }
}
