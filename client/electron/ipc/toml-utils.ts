import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './agent-plugins/fs-utils'

// All writes in this module target ~/.codex/config.toml — a file owned by the
// Codex CLI. Use writeFileAtomic so a crash / power loss mid-write can never
// leave the user with a truncated TOML that breaks their entire codex setup.

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
  const lines = content.split('\n')
  const header = `[mcp_servers.${serverName}]`

  // 按行识别段边界：段头单独占一行，下一段也单独占一行。
  // 旧实现用 `[^\[]*` 匹配到任意 `[` 为止，会被段内 `args = [...]` 的 `[` 截断，
  // 导致段头和前几行被删但 `args` 的值和 `env` 行残留（TOML 语法错误）。
  const startIdx = lines.findIndex(l => l.trim() === header)
  if (startIdx === -1) return

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    // TOML table header：整行只包含 `[...]` 或 `[[...]]`
    if (/^\[\[?[^\]]+\]\]?$/.test(trimmed)) {
      endIdx = i
      break
    }
  }

  // 一并吞掉段前紧邻的空行，避免文件里留下多余空白
  let removeStart = startIdx
  while (removeStart > 0 && lines[removeStart - 1].trim() === '') removeStart--

  lines.splice(removeStart, endIdx - removeStart)
  writeFileAtomic(configPath, lines.join('\n'))
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
