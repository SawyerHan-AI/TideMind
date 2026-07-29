import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  validateAgentId,
  validateCli,
  validatePluginName,
} from './_validate.js'

export interface IpcValidationError {
  success: false
  error: 'invalid_arguments'
  details: string[]
}

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IpcValidationError }

export type NoteSourceToolType = 'logseq' | 'obsidian' | 'apple-notes' | 'notion'

export interface NoteSourceCreateInput {
  name: string
  toolType: NoteSourceToolType
  path: string
  pollInterval?: number
}

export interface NoteSourceUpdateInput {
  name?: string
  path?: string
  pollInterval?: number
}

export interface NoteSourceTestInput {
  toolType: NoteSourceToolType
  testPath: string
}

export interface ExportScopeInput {
  tag?: string
  after?: string
  before?: string
}

export interface SaveFileInput {
  content: string
  defaultName: string
}

export type PluginClientType = 'claude-code' | 'cowork' | 'cursor' | 'codex' | 'windsurf' | 'openclaw' | 'gemini' | 'kimi-code'

export interface PluginGenerateInput {
  agentId: string
  agentName: string
  clientType: PluginClientType
}

export interface AgentCreateInput {
  name: string
  tool_type: string
}

export interface AgentUpdateInput {
  name?: string
  tool_type?: string
}

export interface EditNodeInput {
  nodeId: string
  newContent: string
  newTitle: string | null
  reason: string
}

export interface FeedbackInput {
  strategyName: string
  signal: number
}

export interface ListArchivedOpts {
  limit: number
  offset: number
}

export interface NodesListFilterInput {
  type?: string
  archived?: boolean
  search?: string
  sortBy?: string
  sortDir?: string
  limit?: number
  offset?: number
  heatMin?: number
  heatMax?: number
  createdAfter?: string
  createdBefore?: string
  tags?: string[]
  /** GraphView 节点上限(按 heat DESC 取 Top-N) */
  graphLimit?: number
}

const CONFIG_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,98}$/
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const TAG_TEXT_MAX = 200
const SEARCH_QUERY_MAX = 500
const REASON_MAX = 1_000
const TYPE_TOKEN_MAX = 64
const NODE_PATH_MAX = 4096
const NODE_PATH_ALLOWED_ROOTS = [os.homedir(), '/Volumes', '/mnt', '/media'].map(p => path.resolve(p))
const PLUGIN_CLIENT_TYPES = new Set<PluginClientType>([
  'claude-code',
  'cowork',
  'cursor',
  'codex',
  'windsurf',
  'openclaw',
  'gemini',
  'kimi-code',
])

const NOTE_SOURCE_TOOL_TYPES = new Set<NoteSourceToolType>([
  'logseq',
  'obsidian',
  'apple-notes',
  'notion',
])

function invalid(details: string | string[]): ValidationResult<never> {
  return {
    ok: false,
    error: {
      success: false,
      error: 'invalid_arguments',
      details: Array.isArray(details) ? details : [details],
    },
  }
}

function valid<T>(data: T): ValidationResult<T> {
  return { ok: true, data }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNonEmptyString(value: unknown, field: string, maxLength: number): ValidationResult<string> {
  if (typeof value !== 'string') return invalid(`${field} must be a string`)

  const trimmed = value.trim()
  if (!trimmed) return invalid(`${field} is required`)
  if (trimmed.length > maxLength) return invalid(`${field} is too long`)
  return valid(trimmed)
}

function parsePollInterval(value: unknown): ValidationResult<number | undefined> {
  if (value === undefined) return valid(undefined)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid('pollInterval must be an integer')
  }
  if (value < 1 || value > 86_400) {
    return invalid('pollInterval must be between 1 and 86400 seconds')
  }
  return valid(value)
}

function parseNoteSourceToolType(value: unknown): ValidationResult<NoteSourceToolType> {
  if (typeof value !== 'string' || !NOTE_SOURCE_TOOL_TYPES.has(value as NoteSourceToolType)) {
    return invalid('toolType is invalid')
  }
  return valid(value as NoteSourceToolType)
}

export function parseOptionalBoolean(value: unknown, field: string): ValidationResult<boolean | undefined> {
  if (value === undefined) return valid(undefined)
  if (typeof value !== 'boolean') return invalid(`${field} must be a boolean`)
  return valid(value)
}

export function parseRequiredBoolean(value: unknown, field: string): ValidationResult<boolean> {
  if (typeof value !== 'boolean') return invalid(`${field} must be a boolean`)
  return valid(value)
}

export function parseNoteSourceId(value: unknown): ValidationResult<string> {
  return parseNonEmptyString(value, 'id', 128)
}

export function parseNoteSourceCreate(value: unknown): ValidationResult<NoteSourceCreateInput> {
  if (!isPlainRecord(value)) return invalid('params must be an object')

  const name = parseNonEmptyString(value.name, 'name', 120)
  const toolType = parseNoteSourceToolType(value.toolType)
  const sourcePath = parseNonEmptyString(value.path, 'path', NODE_PATH_MAX)
  const pollInterval = parsePollInterval(value.pollInterval)

  if (!name.ok || !toolType.ok || !sourcePath.ok || !pollInterval.ok) {
    const errors: string[] = []
    if (!name.ok) errors.push(...name.error.details)
    if (!toolType.ok) errors.push(...toolType.error.details)
    if (!sourcePath.ok) errors.push(...sourcePath.error.details)
    if (!pollInterval.ok) errors.push(...pollInterval.error.details)
    return invalid(errors)
  }

  const checkedPath = parseNoteSourcePath(toolType.data, sourcePath.data)
  if (!checkedPath.ok) return checkedPath

  return valid({
    name: name.data,
    toolType: toolType.data,
    path: checkedPath.data,
    pollInterval: pollInterval.data,
  })
}

export function parseNoteSourceUpdate(value: unknown): ValidationResult<NoteSourceUpdateInput> {
  if (!isPlainRecord(value)) return invalid('updates must be an object')

  const updates: NoteSourceUpdateInput = {}
  const errors: string[] = []

  if ('name' in value) {
    const parsed = parseNonEmptyString(value.name, 'name', 120)
    if (parsed.ok) updates.name = parsed.data
    else errors.push(...parsed.error.details)
  }

  if ('path' in value) {
    const parsed = parseNonEmptyString(value.path, 'path', 4096)
    if (parsed.ok) updates.path = parsed.data
    else errors.push(...parsed.error.details)
  }

  if ('pollInterval' in value) {
    const parsed = parsePollInterval(value.pollInterval)
    if (parsed.ok) updates.pollInterval = parsed.data
    else errors.push(...parsed.error.details)
  }

  if (errors.length > 0) return invalid(errors)
  if (Object.keys(updates).length === 0) return invalid('updates cannot be empty')
  return valid(updates)
}

export function parseNoteSourceTest(toolType: unknown, testPath: unknown): ValidationResult<NoteSourceTestInput> {
  const parsedToolType = parseNoteSourceToolType(toolType)
  const parsedPath = parseNonEmptyString(testPath, 'path', 4096)

  if (!parsedToolType.ok || !parsedPath.ok) {
    const errors: string[] = []
    if (!parsedToolType.ok) errors.push(...parsedToolType.error.details)
    if (!parsedPath.ok) errors.push(...parsedPath.error.details)
    return invalid(errors)
  }

  return valid({
    toolType: parsedToolType.data,
    testPath: parsedPath.data,
  })
}

export function parseExportScope(value: unknown): ValidationResult<ExportScopeInput> {
  if (!isPlainRecord(value)) return invalid('scope must be an object')

  const scope: ExportScopeInput = {}
  const errors: string[] = []

  for (const field of ['tag', 'after', 'before'] as const) {
    if (value[field] === undefined) continue
    if (typeof value[field] !== 'string') {
      errors.push(`${field} must be a string`)
      continue
    }
    const trimmed = value[field].trim()
    if (trimmed.length > 512) errors.push(`${field} is too long`)
    else if (trimmed) scope[field] = trimmed
  }

  if (errors.length > 0) return invalid(errors)
  return valid(scope)
}

export function parseSaveFileArgs(content: unknown, defaultName: unknown): ValidationResult<SaveFileInput> {
  if (typeof content !== 'string') return invalid('content must be a string')

  const parsedName = parseNonEmptyString(defaultName, 'defaultName', 255)
  if (!parsedName.ok) return parsedName

  if (/[\\/]/.test(parsedName.data)) {
    return invalid('defaultName must be a file name, not a path')
  }

  if (!parsedName.data.endsWith('.md') && !parsedName.data.endsWith('.json')) {
    return invalid('defaultName must end with .md or .json')
  }

  return valid({ content, defaultName: parsedName.data })
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true
  const [a, b] = parts
  if (a === 10) return true                      // 10.0.0.0/8
  if (a === 127) return true                     // loopback
  if (a === 0) return true                       // 0.0.0.0/8
  if (a === 169 && b === 254) return true        // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true        // 192.168/16
  if (a >= 224) return true                      // multicast / reserved
  return false
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true                         // fc00::/7 ULA
  if (/^::ffff:/.test(lower)) {
    // IPv4-mapped: extract trailing dotted-quad
    const v4 = lower.split(':').pop() ?? ''
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return isPrivateIPv4(v4)
  }
  return false
}

export function parseExternalUrl(value: unknown): ValidationResult<string> {
  const parsed = parseNonEmptyString(value, 'url', 2048)
  if (!parsed.ok) return parsed

  let url: URL
  try {
    url = new URL(parsed.data)
  } catch {
    return invalid('url must be valid')
  }

  if (url.username || url.password) {
    return invalid('url must not contain credentials')
  }

  // URL.hostname keeps brackets around IPv6 literals; strip for net.isIP / matching.
  const rawHost = url.hostname.toLowerCase()
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost

  // 默认只允许 https。开发环境例外: `http://localhost` / `http://127.0.0.1` 让本地
  // 开发服务能跑（dev server / 本地工具）。正式产物里 NODE_ENV 不会是 'development'，
  // 因此对终端用户透明地强制 https。
  const isDev = process.env.NODE_ENV === 'development'
  const isDevLocalhost =
    isDev && url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')

  if (url.protocol !== 'https:' && !isDevLocalhost) {
    return invalid('url protocol must be https')
  }

  // 阻断 localhost / .local / 私网 IP，避免 SSRF；dev 环境对 http://localhost 例外。
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    if (!isDevLocalhost) return invalid('url host is not allowed')
  }

  const ipKind = net.isIP(host)
  if (ipKind === 4 && isPrivateIPv4(host)) {
    if (!isDevLocalhost) return invalid('url host is not allowed')
  }
  if (ipKind === 6 && isPrivateIPv6(host)) return invalid('url host is not allowed')

  return valid(url.toString())
}

export function parseNodeId(value: unknown, field = 'nodeId'): ValidationResult<string> {
  if (typeof value !== 'string') return invalid(`${field} must be a string`)
  if (!NODE_ID_RE.test(value)) return invalid(`${field} must be a safe id`)
  return valid(value)
}

export function parseFeedbackSignal(value: unknown): ValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid('signal must be an integer')
  }
  if (value < -2 || value > 2) return invalid('signal must be between -2 and 2')
  return valid(value)
}

export function parseEditNodeArgs(
  nodeId: unknown,
  newContent: unknown,
  newTitle: unknown,
  reason: unknown,
): ValidationResult<EditNodeInput> {
  const parsedId = parseNodeId(nodeId)
  if (!parsedId.ok) return parsedId

  if (typeof newContent !== 'string') return invalid('newContent must be a string')
  if (newContent.length > 1_000_000) return invalid('newContent is too long')

  let title: string | null = null
  if (newTitle !== null && newTitle !== undefined) {
    if (typeof newTitle !== 'string') return invalid('newTitle must be a string or null')
    if (newTitle.length > 500) return invalid('newTitle is too long')
    title = newTitle
  }

  if (typeof reason !== 'string') return invalid('reason must be a string')
  if (reason.length > REASON_MAX) return invalid('reason is too long')

  return valid({ nodeId: parsedId.data, newContent, newTitle: title, reason })
}

export function parseFeedbackArgs(
  strategyName: unknown,
  signal: unknown,
): ValidationResult<FeedbackInput> {
  const parsedName = parseConfigFileName(strategyName, 'strategyName')
  if (!parsedName.ok) return parsedName
  const parsedSignal = parseFeedbackSignal(signal)
  if (!parsedSignal.ok) return parsedSignal
  return valid({ strategyName: parsedName.data, signal: parsedSignal.data })
}

export function parseListArchivedOpts(value: unknown): ValidationResult<ListArchivedOpts> {
  if (value === undefined || value === null) return valid({ limit: 30, offset: 0 })
  if (!isPlainRecord(value)) return invalid('opts must be an object')

  let limit = 30
  let offset = 0

  if (value.limit !== undefined) {
    if (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1000) {
      return invalid('limit must be an integer between 1 and 1000')
    }
    limit = value.limit
  }

  if (value.offset !== undefined) {
    if (typeof value.offset !== 'number' || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 1_000_000) {
      return invalid('offset must be a non-negative integer')
    }
    offset = value.offset
  }

  return valid({ limit, offset })
}

export function parseTagText(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return invalid('tag must be a string')
  const trimmed = value.trim()
  if (!trimmed) return invalid('tag is required')
  if (trimmed.length > TAG_TEXT_MAX) return invalid('tag is too long')
  // 拒绝换行 / 控制字符（防止 timeline detail JSON / node.tags JSON 被人眼误读）
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return invalid('tag contains control characters')
  return valid(trimmed)
}

export function parseSearchQuery(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return invalid('query must be a string')
  if (value.length > SEARCH_QUERY_MAX) return invalid('query is too long')
  return valid(value)
}

export function parseSearchLimit(value: unknown): ValidationResult<number> {
  if (value === undefined) return valid(20)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200) {
    return invalid('limit must be an integer between 1 and 200')
  }
  return valid(value)
}

export function parsePathArgs(fromId: unknown, toId: unknown): ValidationResult<{ fromId: string; toId: string }> {
  const f = parseNodeId(fromId, 'fromId')
  if (!f.ok) return f
  const t = parseNodeId(toId, 'toId')
  if (!t.ok) return t
  return valid({ fromId: f.data, toId: t.data })
}

function parseTypeToken(value: unknown): ValidationResult<string | undefined> {
  if (value === undefined || value === '') return valid(undefined)
  if (typeof value !== 'string') return invalid('type must be a string')
  if (value.length > TYPE_TOKEN_MAX) return invalid('type is too long')
  return valid(value)
}

function parseDateString(value: unknown, field: string): ValidationResult<string | undefined> {
  if (value === undefined || value === '') return valid(undefined)
  if (typeof value !== 'string') return invalid(`${field} must be a string`)
  if (value.length > 64) return invalid(`${field} is too long`)
  return valid(value)
}

function parseHeatBound(value: unknown, field: string): ValidationResult<number | undefined> {
  if (value === undefined) return valid(undefined)
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(`${field} must be a number`)
  return valid(value)
}

function parseTagsArray(value: unknown): ValidationResult<string[] | undefined> {
  if (value === undefined) return valid(undefined)
  const list = Array.isArray(value) ? value : [value]
  const result: string[] = []
  for (const tag of list) {
    if (tag === undefined || tag === null || tag === '') continue
    const parsed = parseTagText(tag)
    if (!parsed.ok) return parsed
    result.push(parsed.data)
  }
  return valid(result.length > 0 ? result : undefined)
}

export function parseNodesListFilter(value: unknown): ValidationResult<NodesListFilterInput> {
  if (value === undefined || value === null) return valid({})
  if (!isPlainRecord(value)) return invalid('filter must be an object')

  const errors: string[] = []
  const filter: NodesListFilterInput = {}

  const t = parseTypeToken(value.type)
  if (!t.ok) errors.push(...t.error.details); else if (t.data) filter.type = t.data

  if (value.archived !== undefined) {
    const a = parseRequiredBoolean(value.archived, 'archived')
    if (!a.ok) errors.push(...a.error.details); else filter.archived = a.data
  }

  if (value.search !== undefined && value.search !== '') {
    if (typeof value.search !== 'string') errors.push('search must be a string')
    else if (value.search.length > SEARCH_QUERY_MAX) errors.push('search is too long')
    else filter.search = value.search
  }

  if (value.sortBy !== undefined) {
    if (typeof value.sortBy !== 'string' || value.sortBy.length > 32) errors.push('sortBy must be a short string')
    else filter.sortBy = value.sortBy
  }

  if (value.sortDir !== undefined) {
    if (typeof value.sortDir !== 'string' || value.sortDir.length > 8) errors.push('sortDir must be ASC or DESC')
    else filter.sortDir = value.sortDir
  }

  if (value.limit !== undefined) {
    if (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 5000) {
      errors.push('limit must be an integer between 1 and 5000')
    } else filter.limit = value.limit
  }

  if (value.offset !== undefined) {
    if (typeof value.offset !== 'number' || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 1_000_000) {
      errors.push('offset must be a non-negative integer')
    } else filter.offset = value.offset
  }

  if (value.graphLimit !== undefined) {
    if (typeof value.graphLimit !== 'number' || !Number.isInteger(value.graphLimit) || value.graphLimit < 1 || value.graphLimit > 5000) {
      errors.push('graphLimit must be an integer between 1 and 5000')
    } else filter.graphLimit = value.graphLimit
  }

  const heatMin = parseHeatBound(value.heatMin, 'heatMin')
  if (!heatMin.ok) errors.push(...heatMin.error.details); else if (heatMin.data !== undefined) filter.heatMin = heatMin.data
  const heatMax = parseHeatBound(value.heatMax, 'heatMax')
  if (!heatMax.ok) errors.push(...heatMax.error.details); else if (heatMax.data !== undefined) filter.heatMax = heatMax.data

  const after = parseDateString(value.createdAfter, 'createdAfter')
  if (!after.ok) errors.push(...after.error.details); else if (after.data) filter.createdAfter = after.data
  const before = parseDateString(value.createdBefore, 'createdBefore')
  if (!before.ok) errors.push(...before.error.details); else if (before.data) filter.createdBefore = before.data

  const tags = parseTagsArray(value.tags)
  if (!tags.ok) errors.push(...tags.error.details); else if (tags.data) filter.tags = tags.data

  if (errors.length > 0) return invalid(errors)
  return valid(filter)
}

/**
 * Note source 物理路径白名单：仅允许 homedir / /Volumes / /mnt / /media。
 * - notion: 跳过（path 是 token，非物理路径）
 * - apple-notes: 跳过（路径含 ?accounts= query string，由系统决定）
 * - logseq / obsidian: 强校验，避免 renderer 创建指向 /etc 的源造成系统目录递归
 */
export function parseNoteSourcePath(toolType: NoteSourceToolType, rawPath: string): ValidationResult<string> {
  if (toolType === 'notion' || toolType === 'apple-notes') return valid(rawPath)

  const expanded = rawPath.replace(/^~(?=$|\/)/, os.homedir())
  let resolved: string
  try {
    resolved = path.resolve(expanded)
  } catch {
    return invalid('path is not resolvable')
  }

  const within = NODE_PATH_ALLOWED_ROOTS.some(root =>
    resolved === root || resolved.startsWith(root + path.sep),
  )
  if (!within) return invalid('path outside allowed roots')
  if (resolved.length > NODE_PATH_MAX) return invalid('path is too long')
  return valid(resolved)
}

export function parseConfigPatch(value: unknown): ValidationResult<Record<string, unknown>> {
  if (!isPlainRecord(value)) return invalid('patch must be an object')
  // Prototype-pollution 纵深防御:递归剥离 __proto__ / constructor / prototype。
  // deepMerge 也有同样守卫,这里在校验阶段先剥一道,让"attacker patch 含
  // forbidden key"在 IPC 边界就被静默移除,日志上看到原 patch 不会因含此 key 失败。
  return valid(stripForbiddenKeys(value))
}

const FORBIDDEN_PATCH_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function stripForbiddenKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_PATCH_KEYS.has(k)) continue
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = stripForbiddenKeys(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

export function parseConfigFileName(value: unknown, field = 'name'): ValidationResult<string> {
  const parsed = parseNonEmptyString(value, field, 99)
  if (!parsed.ok) return parsed

  if (!CONFIG_FILE_NAME_RE.test(parsed.data) || parsed.data.includes('..')) {
    return invalid(`${field} must be a safe file name`)
  }

  return parsed
}

export function parseConfigContent(value: unknown, field = 'content'): ValidationResult<string> {
  if (typeof value !== 'string') return invalid(`${field} must be a string`)
  if (value.length > 1_000_000) return invalid(`${field} is too long`)
  return valid(value)
}

export function parseOptionalReason(value: unknown): ValidationResult<string | undefined> {
  if (value === undefined) return valid(undefined)
  return parseConfigContent(value, 'reason')
}

export function parsePositiveVersion(value: unknown): ValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return invalid('version must be a positive integer')
  }
  return valid(value)
}

export function parseStrategyParamArgs(
  name: unknown,
  key: unknown,
  value: unknown,
): ValidationResult<{ name: string; key: string; value: string }> {
  const parsedName = parseConfigFileName(name)
  const parsedKey = parseConfigFileName(key, 'key')
  const parsedValue = parseConfigContent(value, 'value')

  if (!parsedName.ok || !parsedKey.ok || !parsedValue.ok) {
    const errors: string[] = []
    if (!parsedName.ok) errors.push(...parsedName.error.details)
    if (!parsedKey.ok) errors.push(...parsedKey.error.details)
    if (!parsedValue.ok) errors.push(...parsedValue.error.details)
    return invalid(errors)
  }

  return valid({ name: parsedName.data, key: parsedKey.data, value: parsedValue.data })
}

export function parseStringRecord(value: unknown, field: string): ValidationResult<Record<string, string>> {
  if (!isPlainRecord(value)) return invalid(`${field} must be an object`)

  const result: Record<string, string> = {}
  const errors: string[] = []
  for (const [key, val] of Object.entries(value)) {
    const parsedKey = parseConfigFileName(key, `${field} key`)
    if (!parsedKey.ok) {
      errors.push(...parsedKey.error.details)
      continue
    }
    if (typeof val !== 'string') {
      errors.push(`${field}.${key} must be a string`)
      continue
    }
    if (val.length > 50_000) {
      errors.push(`${field}.${key} is too long`)
      continue
    }
    result[parsedKey.data] = val
  }

  if (errors.length > 0) return invalid(errors)
  return valid(result)
}

export function parsePluginClientType(value: unknown): ValidationResult<PluginClientType | undefined> {
  if (value === undefined || value === null || value === '') return valid(undefined)
  if (typeof value !== 'string' || !PLUGIN_CLIENT_TYPES.has(value as PluginClientType)) {
    return invalid('toolType is invalid')
  }
  return valid(value as PluginClientType)
}

export function parsePluginGenerateInput(value: unknown): ValidationResult<PluginGenerateInput> {
  if (!isPlainRecord(value)) return invalid('params must be an object')

  let agentId: string
  try {
    agentId = validateAgentId(value.agentId)
  } catch (err) {
    return invalid((err as Error).message)
  }

  const agentName = parseNonEmptyString(value.agentName, 'agentName', 120)
  if (!agentName.ok) return agentName
  // 防御纵深：拒绝控制字符 / 换行 / 引号 / 反斜杠。
  // agentName 当前都进 JSON.stringify 安全，但严格化避免 marketplace.json
  // 人眼读取被混淆，也让未来的 hooks.json shell command 拼接更安全。
  if (/["\\\x00-\x1f\x7f]/.test(agentName.data)) {
    return invalid('agentName contains invalid characters')
  }

  const clientType = parsePluginClientType(value.clientType)
  if (!clientType.ok) return clientType

  return valid({
    agentId,
    agentName: agentName.data,
    clientType: clientType.data ?? 'claude-code',
  })
}

export function parseAgentId(value: unknown): ValidationResult<string> {
  try {
    return valid(validateAgentId(value))
  } catch (err) {
    return invalid((err as Error).message)
  }
}

export function parsePluginName(value: unknown): ValidationResult<string> {
  try {
    return valid(validatePluginName(value))
  } catch (err) {
    return invalid((err as Error).message)
  }
}

export function parseCliName(value: unknown): ValidationResult<string> {
  try {
    return valid(validateCli(value))
  } catch (err) {
    return invalid((err as Error).message)
  }
}

export function parseAgentCreate(value: unknown): ValidationResult<AgentCreateInput> {
  if (!isPlainRecord(value)) return invalid('params must be an object')

  const name = parseNonEmptyString(value.name, 'name', 120)
  const toolType = parseConfigFileName(value.tool_type, 'tool_type')
  if (!name.ok || !toolType.ok) {
    const errors: string[] = []
    if (!name.ok) errors.push(...name.error.details)
    if (!toolType.ok) errors.push(...toolType.error.details)
    return invalid(errors)
  }

  return valid({ name: name.data, tool_type: toolType.data })
}

export function parseAgentUpdate(value: unknown): ValidationResult<AgentUpdateInput> {
  if (!isPlainRecord(value)) return invalid('params must be an object')

  const updates: AgentUpdateInput = {}
  const errors: string[] = []

  if ('name' in value) {
    const name = parseNonEmptyString(value.name, 'name', 120)
    if (name.ok) updates.name = name.data
    else errors.push(...name.error.details)
  }

  if ('tool_type' in value) {
    const toolType = parseConfigFileName(value.tool_type, 'tool_type')
    if (toolType.ok) updates.tool_type = toolType.data
    else errors.push(...toolType.error.details)
  }

  if (errors.length > 0) return invalid(errors)
  if (Object.keys(updates).length === 0) return invalid('params cannot be empty')
  return valid(updates)
}
