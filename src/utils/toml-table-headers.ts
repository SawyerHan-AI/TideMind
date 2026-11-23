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

