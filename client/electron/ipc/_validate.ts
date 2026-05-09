// Shared input validators for IPC handlers that touch the filesystem or DB
// using renderer-supplied identifiers. All path-traversal / injection guards
// for `agents:*` handlers funnel through here.
import path from 'node:path'

// agentId 来源：`generateAgentId()` → `'eb_' + randomBytes(4).toString('hex')`
// 即固定前缀 `eb_` + 8 个小写十六进制字符。
// 为兼容历史/未来可能加长的 ID，这里允许 8-32 个 [a-z0-9]。
const AGENT_ID_RE = /^eb_[a-z0-9]{8,32}$/

// Plugin name 来源：plugin-generator.ts 里 `tidemind-${agentId}`
const PLUGIN_NAME_RE = /^tidemind-eb_[a-z0-9]{8,32}$/

// agents:check-cli 允许检测的 CLI 二进制
export const ALLOWED_CLIS = ['claude', 'codex', 'cursor', 'windsurf', 'gemini'] as const
export type AllowedCli = typeof ALLOWED_CLIS[number]

// model_connections.id 来源:`generateConnectionId()` → `'mc_' + randomBytes(4).toString('hex')`
// 固定前缀 `mc_` + 8 个小写十六进制字符。
const CONNECTION_ID_RE = /^mc_[a-f0-9]{8}$/

// model_connections.provider_type 白名单
export const ALLOWED_PROVIDER_TYPES = [
  'anthropic', 'vertex', 'gemini', 'ollama', 'openai-compatible',
] as const
export type AllowedProviderType = typeof ALLOWED_PROVIDER_TYPES[number]

export function validateConnectionId(id: unknown): string {
  if (typeof id !== 'string' || !CONNECTION_ID_RE.test(id)) {
    throw new Error(`Invalid connectionId: must match ${CONNECTION_ID_RE.source}`)
  }
  return id
}

export function validateProviderType(t: unknown): AllowedProviderType {
  if (typeof t !== 'string' || !(ALLOWED_PROVIDER_TYPES as readonly string[]).includes(t)) {
    throw new Error(`Invalid provider_type: must be one of ${ALLOWED_PROVIDER_TYPES.join(', ')}`)
  }
  return t as AllowedProviderType
}

export function validateAgentId(id: unknown): string {
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
    throw new Error(`Invalid agentId: must match ${AGENT_ID_RE.source}`)
  }
  return id
}

export function validatePluginName(name: unknown): string {
  if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) {
    throw new Error(`Invalid pluginName: must match ${PLUGIN_NAME_RE.source}`)
  }
  return name
}

export function validateCli(cli: unknown): AllowedCli {
  if (typeof cli !== 'string' || !(ALLOWED_CLIS as readonly string[]).includes(cli)) {
    throw new Error(`Invalid cli: must be one of ${ALLOWED_CLIS.join(', ')}`)
  }
  return cli as AllowedCli
}

/**
 * 防御性纵深：构造路径后必须确认它仍然落在 expectedRoot 之下。
 * 即便 validateAgentId 已经卡住非法字符，这一层也兜底防止上游遗漏。
 * 失败抛错而不是返回 false，调用方不必再做条件分支。
 */
export function assertPathWithinRoot(targetPath: string, expectedRoot: string): void {
  // 用 Node 的 path.resolve 拿到绝对路径。两端都加分隔符防止
  // /foo/bar2 被误判在 /foo/bar 之下
  const resolvedTarget = path.resolve(targetPath)
  const resolvedRoot = path.resolve(expectedRoot)
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    throw new Error(`Path escape detected: ${resolvedTarget} not under ${resolvedRoot}`)
  }
}
