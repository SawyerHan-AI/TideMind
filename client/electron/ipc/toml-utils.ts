import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { writeFileAtomic } from './agent-plugins/fs-utils'

// All writes in this module target CLI-owned TOML configs (~/.codex/config.toml,
// ~/.kimi-code/config.toml). Use writeFileAtomic so a crash / power loss
// mid-write can never leave the user with a truncated TOML that breaks their
// entire CLI setup.

export interface TomlTableHeader {
  line: number
  array: boolean
  /** 去掉 quoted key 外空白后的 table path，例如 `mcp_servers.foo` / `hooks`。 */
  key: string
}

function hasOddBackslashPrefix(text: string, index: number): boolean {
  let count = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) count++
  return count % 2 === 1
}

/** 去掉 quoted key 外空白，保留 quoted key 自身内容。 */
function normalizeTomlHeaderKey(raw: string): string {
  let result = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const char of raw.trim()) {
    if (quote === '"') {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      result += char
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      result += char
    } else if (!/\s/.test(char)) {
      result += char
    }
  }
  if (result === '"hooks"' || result === "'hooks'") return 'hooks'
  return result
}

function parseTomlHeaderLine(structuralLine: string): Omit<TomlTableHeader, 'line'> | null {
  const text = structuralLine.trim()
  if (text.startsWith('[[') && text.endsWith(']]')) {
    const key = normalizeTomlHeaderKey(text.slice(2, -2))
    return key ? { array: true, key } : null
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const key = normalizeTomlHeaderKey(text.slice(1, -1))
    return key ? { array: false, key } : null
  }
  return null
}

/**
 * 扫描真实 TOML table header 的行号。
 *
 * 为了保留用户原格式，这里只做最小词法分析：跟踪 basic/literal/multiline
 * string、字符串外注释和多行 array/inline-table 深度，避免把字符串或数组里的
 * `[x]` 当成配置段边界。语法合法性仍由 smol-toml 在写入前后负责验证。
 */
export function scanTomlTableHeaders(content: string): TomlTableHeader[] {
  const headers: TomlTableHeader[] = []
  let multiline: 'basic' | 'literal' | null = null
  let squareDepth = 0
  let curlyDepth = 0
  const lines = content.split('\n')

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const startsAtTopLevel = multiline === null && squareDepth === 0 && curlyDepth === 0
    let structural = ''
    let quote: '"' | "'" | null = null
    let escaped = false

    for (let i = 0; i < line.length; i++) {
      if (multiline === 'basic') {
        if (line.startsWith('"""', i) && !hasOddBackslashPrefix(line, i)) {
          multiline = null
          i += 2
        }
        continue
      }
      if (multiline === 'literal') {
        if (line.startsWith("'''", i)) {
          multiline = null
          i += 2
        }
        continue
      }
      const char = line[i]
      if (quote === '"') {
        structural += char
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quote = null
        continue
      }
      if (quote === "'") {
        structural += char
        if (char === "'") quote = null
        continue
      }
      if (line.startsWith('"""', i)) {
        multiline = 'basic'
        i += 2
        continue
      }
      if (line.startsWith("'''", i)) {
        multiline = 'literal'
        i += 2
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        structural += char
        continue
      }
      if (char === '#') break
      structural += char
      if (char === '[') squareDepth++
      else if (char === ']') squareDepth = Math.max(0, squareDepth - 1)
      else if (char === '{') curlyDepth++
      else if (char === '}') curlyDepth = Math.max(0, curlyDepth - 1)
    }

    if (startsAtTopLevel) {
      const header = parseTomlHeaderLine(structural)
      if (header) headers.push({ line: lineIndex, ...header })
    }
  }
  return headers
}

/** 追加 MCP section 到 TOML 配置文件（如果同名 section 不存在） */
export function appendTomlMcpSection(configPath: string, serverName: string, mcpConfig: { command: string; args: string[]; env: Record<string, string> }): void {
  let content = ''
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf-8')
  }
  const sectionHeader = `[mcp_servers.${serverName}]`
  if (content.includes(sectionHeader)) return // 已存在

  const argsToml = mcpConfig.args.map(a => JSON.stringify(a)).join(', ')
  const envPairs = Object.entries(mcpConfig.env).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')
  const section = [
    '',
    sectionHeader,
    'enabled = true',
    `command = ${JSON.stringify(mcpConfig.command)}`,
    `args = [${argsToml}]`,
    `env = { ${envPairs} }`,
  ].join('\n')

  const configDir = path.dirname(configPath)
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
  writeFileAtomic(configPath, content.trimEnd() + section + '\n')
}

/** 从 TOML 配置文件中移除指定 MCP section */
export function removeTomlMcpSection(configPath: string, serverName: string): void {
  if (!fs.existsSync(configPath)) return
  const content = fs.readFileSync(configPath, 'utf-8')
  try {
    parseToml(content)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Refused to modify ${configPath}: existing file is not valid TOML (${reason}). Original file left unchanged.`,
    )
  }
  const lines = content.split('\n')
  const headers = scanTomlTableHeaders(content)
  const headerIndex = headers.findIndex(h => !h.array && h.key === `mcp_servers.${serverName}`)
  if (headerIndex === -1) return
  const startIdx = headers[headerIndex].line
  const endIdx = headers[headerIndex + 1]?.line ?? lines.length

  // 一并吞掉段前紧邻的空行，避免文件里留下多余空白
  let removeStart = startIdx
  while (removeStart > 0 && lines[removeStart - 1].trim() === '') removeStart--

  lines.splice(removeStart, endIdx - removeStart)
  const result = lines.join('\n')
  try {
    parseToml(result)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Refused to write ${configPath}: removing the MCP section would produce invalid TOML (${reason}). ` +
      'Original file left unchanged.',
    )
  }
  writeFileAtomic(configPath, result)
}

/** 确保 TOML 配置文件中有 [features] codex_hooks = true */
export function ensureTomlFeatureFlag(configPath: string, flag: string): void {
  if (!fs.existsSync(configPath)) return
  let content = fs.readFileSync(configPath, 'utf-8')
  if (content.includes(`${flag} = true`)) return
  if (content.includes('[features]')) {
    content = content.replace('[features]', `[features]\n${flag} = true`)
  } else {
    content = content.trimEnd() + `\n\n[features]\n${flag} = true\n`
  }
  writeFileAtomic(configPath, content)
}

// ---------------------------------------------------------------------------
// [[hooks]] array-of-tables helpers(~/.kimi-code/config.toml)
// ---------------------------------------------------------------------------

export interface TomlHookEntry {
  event: string
  /** 可选;缺省时块内不写 matcher 行(Kimi 的 UserPromptSubmit 需要 match all)。 */
  matcher?: string
  command: string
  timeout: number
  /**
   * 幂等标记:某个 [[hooks]] 块里已出现该 token(原始或 TOML 转义形态)则跳过追加。
   * 对 TideMind 来说是 `--agent-id "<id>"`。
   */
  dedupeToken: string
}

/** TOML basic string 转义(与 JSON 字符串转义兼容,JSON.stringify 即可)。
 *  例外:U+007F(DEL)JSON 不转义但 TOML 要求转义,需补一刀。 */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, '\\u007F')
}

/**
 * 按行切出所有 [[hooks]] 块(块头行到下一个 table header 或文件尾)。
 * 与 removeTomlMcpSection 同样的行级策略:不重排用户既有内容。
 */
function findHookBlocks(content: string): { start: number; end: number }[] {
  const lines = content.split('\n')
  const headers = scanTomlTableHeaders(content)
  const blocks: { start: number; end: number }[] = []
  for (let i = 0; i < headers.length; i++) {
    if (!headers[i].array || headers[i].key !== 'hooks') continue
    blocks.push({ start: headers[i].line, end: headers[i + 1]?.line ?? lines.length })
  }
  return blocks
}

function tokenizeHookCommand(command: string): string[] | null {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let started = false
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (quote === '"' && char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }
  if (quote || escaped) return null
  if (started) args.push(current)
  return args
}

function agentIdFromDedupeToken(dedupeToken: string): string | null {
  const match = dedupeToken.match(/^--agent-id\s+("(?:[^"\\]|\\.)*")$/)
  if (!match) return null
  try {
    const value = JSON.parse(match[1])
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** 只认 TideMind 的 Kimi session hook；同 agent-id 的用户自定义命令不属于我们。 */
function commandBelongsToHook(command: string, dedupeToken: string): boolean {
  const expectedAgentId = agentIdFromDedupeToken(dedupeToken)
  const args = tokenizeHookCommand(command)
  if (!expectedAgentId || !args || args.length < 2) return false
  if (path.basename(args[1]) !== 'hook-session-start.cjs') return false
  const agentFlag = args.indexOf('--agent-id')
  const toolFlag = args.indexOf('--tool')
  return agentFlag >= 0
    && args[agentFlag + 1] === expectedAgentId
    && toolFlag >= 0
    && args[toolFlag + 1] === 'kimi-code'
}

/** 某个 [[hooks]] 块是否是指定 agent 的 TideMind Kimi hook。 */
function blockContainsToken(blockText: string, dedupeToken: string): boolean {
  try {
    const parsed = parseToml(blockText) as { hooks?: Array<{ command?: unknown }> }
    return parsed.hooks?.some(h => typeof h.command === 'string' && commandBelongsToHook(h.command, dedupeToken)) ?? false
  } catch {
    return false
  }
}

/** 整个 TOML 内容里是否已有含 dedupeToken 的 [[hooks]] 块。 */
export function hasTomlHook(content: string, dedupeToken: string): boolean {
  const lines = content.split('\n')
  return findHookBlocks(content).some(b => blockContainsToken(lines.slice(b.start, b.end).join('\n'), dedupeToken))
}

/**
 * 向 TOML 配置追加一个 [[hooks]] 条目(array-of-tables)。
 *
 * - 文件不存在则创建;
 * - 已有含 dedupeToken 的 [[hooks]] 块则跳过(幂等);
 * - 文件存在但 TOML 畸形时,与 readJsonStrict 同原则:先备份原文再抛错,
 *   绝不静默覆盖用户既有配置。
 */
export function ensureTomlHook(configPath: string, entry: TomlHookEntry): void {
  let content = ''
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf-8')
    try {
      parseToml(content)
    } catch (err) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = `${configPath}.tidemind-backup-${ts}.bak`
      try {
        fs.writeFileSync(backupPath, content)
      } catch { /* if backup itself fails, still surface the original parse error below */ }
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Refused to overwrite ${configPath}: existing file is not valid TOML (${reason}). ` +
        `Original content backed up to ${backupPath}. Please inspect and restore manually.`,
      )
    }
    if (hasTomlHook(content, entry.dedupeToken)) return // 已存在
  }

  const block = [
    '',
    '[[hooks]]',
    `event = ${tomlString(entry.event)}`,
    ...(entry.matcher !== undefined ? [`matcher = ${tomlString(entry.matcher)}`] : []),
    `command = ${tomlString(entry.command)}`,
    `timeout = ${entry.timeout}`,
  ].join('\n')

  const configDir = path.dirname(configPath)
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
  writeFileAtomic(configPath, content.trimEnd() + block + '\n')
}

/** 移除所有含 dedupeToken 的 [[hooks]] 块(行级精准删除,其余内容原样保留)。 */
export function removeTomlHook(configPath: string, dedupeToken: string): void {
  if (!fs.existsSync(configPath)) return
  const content = fs.readFileSync(configPath, 'utf-8')
  const lines = content.split('\n')
  const blocks = findHookBlocks(content)
    .filter(b => blockContainsToken(lines.slice(b.start, b.end).join('\n'), dedupeToken))
  if (blocks.length === 0) return

  // 先在原始行坐标中计算并合并区间。相邻 hook 吞前置空行后区间可能重叠，
  // 若直接逆序 splice，较早块的旧 end 会越界并吞掉后续用户 table header。
  const ranges: { start: number; end: number }[] = []
  for (const { start, end } of blocks) {
    let removeStart = start
    while (removeStart > 0 && lines[removeStart - 1].trim() === '') removeStart--
    const previous = ranges[ranges.length - 1]
    if (previous && removeStart <= previous.end) previous.end = Math.max(previous.end, end)
    else ranges.push({ start: removeStart, end })
  }
  for (const { start, end } of [...ranges].reverse()) {
    lines.splice(start, end - start)
  }

  // 删除后、写盘前复验:行级切块的边界判断可能被畸形内容骗过(如多行字符串
  // 内含 `[x]` 行导致块被误截断),一旦结果不是合法 TOML 就拒绝写盘——与
  // ensureTomlHook "绝不写坏文件" 的原则一致,原文件保持不动。
  const result = lines.join('\n')
  try {
    parseToml(result)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Refused to write ${configPath}: removing the hook block would produce invalid TOML (${reason}). ` +
      `Original file left unchanged. Please inspect and remove manually.`,
    )
  }
  writeFileAtomic(configPath, result)
}
