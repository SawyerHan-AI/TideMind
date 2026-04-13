import fs from 'node:fs'
import path from 'node:path'

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
  fs.writeFileSync(configPath, content.trimEnd() + section + '\n')
}

/** 从 TOML 配置文件中移除指定 MCP section */
export function removeTomlMcpSection(configPath: string, serverName: string): void {
  if (!fs.existsSync(configPath)) return
  const content = fs.readFileSync(configPath, 'utf-8')
  // 匹配 [mcp_servers.<name>] 段直到下一个 [section] 或文件末尾
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`\\n?\\[mcp_servers\\.${escaped}\\][^\\[]*`, 'g')
  const updated = content.replace(regex, '')
  fs.writeFileSync(configPath, updated)
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
  fs.writeFileSync(configPath, content)
}
