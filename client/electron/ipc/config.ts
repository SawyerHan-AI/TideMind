import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { getClientDb } from '../db.js'
import { createNode } from '@server/db/nodes.js'
import { loadConfig, reloadConfig } from '@server/config.js'

function validateFileName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.length >= 100 || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Invalid file name: ${name}`);
  }
}

export function registerConfigHandlers(dataDir: string): void {
  const configPath = path.join(dataDir, 'config.toml')
  const strategiesDir = path.join(dataDir, 'strategies')
  const skillDir = path.join(dataDir, 'skill')
  const mcpDescPath = path.join(dataDir, 'mcp-descriptions.json')

  // MCP server 入口路径：从 client/electron/ipc/ 向上 3 级到项目根目录
  const projectRoot = path.resolve(__dirname, '..', '..', '..')
  const mcpServerPath = path.join(projectRoot, 'dist', 'index.js')

  ipcMain.handle('config:mcp-command', () => {
    return { command: 'node', args: [mcpServerPath] }
  })

  ipcMain.handle('config:get', () => {
    try {
      reloadConfig()
      return loadConfig(configPath)
    } catch {
      return {}
    }
  })

  ipcMain.handle('config:update', (_e, patch: Record<string, unknown>) => {
    let current: Record<string, unknown> = {}
    if (fs.existsSync(configPath)) {
      try {
        current = parseToml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      } catch {}
    }

    // deep merge
    const merged = deepMerge(current, patch)
    fs.writeFileSync(configPath, stringifyToml(merged as any))
    reloadConfig()

    // 记录到时间线
    try {
      const db = getClientDb()
      const sections = Object.keys(patch)
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
      `).run(
        JSON.stringify({ key: 'settings_changed', params: { section: sections.join('/') } }),
        JSON.stringify({ section: sections.join('/'), changed_keys: Object.keys(patch) }),
      )
    } catch {}
  })

  // --- 策略文件 ---

  ipcMain.handle('config:strategies', () => {
    if (!fs.existsSync(strategiesDir)) return []
    return fs.readdirSync(strategiesDir)
      .filter(f => f.endsWith('.system.md'))
      .map(f => ({
        name: f.replace('.system.md', ''),
        path: path.join(strategiesDir, f),
      }))
  })

  ipcMain.handle('config:strategy', (_e, name: string) => {
    validateFileName(name);
    const filePath = path.join(strategiesDir, `${name}.system.md`)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('config:strategy:update', (_e, name: string, content: string, reason?: string) => {
    validateFileName(name);
    const filePath = path.join(strategiesDir, `${name}.system.md`)
    fs.writeFileSync(filePath, content)

    // 记录版本历史 + 创建 meta 节点
    recordStrategyVersion(name, content, reason ?? null, 'user')
  })

  // --- User Prompt（.user.md）读写 ---

  ipcMain.handle('config:strategy:user', (_e, name: string) => {
    validateFileName(name);
    const filePath = path.join(strategiesDir, `${name}.user.md`)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('config:strategy:user:update', (_e, name: string, content: string, reason?: string) => {
    validateFileName(name);
    const filePath = path.join(strategiesDir, `${name}.user.md`)
    fs.writeFileSync(filePath, content)
    recordStrategyVersion(`${name}:user`, content, reason ?? null, 'user')
  })

  ipcMain.handle('config:strategy:user:versions', (_e, name: string) => {
    validateFileName(name);
    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(`${name}:user`)
  })

  ipcMain.handle('config:strategy:user:rollback', (_e, name: string, version: number) => {
    validateFileName(name);
    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(`${name}:user`, version) as { content: string } | undefined
    if (!row) throw new Error(`User prompt version ${version} not found for strategy ${name}`)

    const filePath = path.join(strategiesDir, `${name}.user.md`)
    fs.writeFileSync(filePath, row.content)
    recordStrategyVersion(`${name}:user`, row.content, `回滚至 v${version}`, 'user')
  })

  // --- 策略参数单独更新 ---

  ipcMain.handle('config:strategyParamUpdate', (_e, name: string, key: string, value: string) => {
    validateFileName(name);
    // 优先在 .params.md 文件中查找和更新参数
    const paramsPath = path.join(strategiesDir, `${name}.params.md`)
    const mainPath = path.join(strategiesDir, `${name}.system.md`)

    // 尝试在 params 文件中更新
    if (fs.existsSync(paramsPath)) {
      const result = updateParamInFile(paramsPath, key, value)
      if (result) {
        recordStrategyVersion(name, fs.readFileSync(paramsPath, 'utf-8'), `参数 ${key} 更新为 ${value}`, 'user')
        return
      }
    }

    // 回退到主文件
    if (fs.existsSync(mainPath)) {
      const result = updateParamInFile(mainPath, key, value)
      if (result) {
        recordStrategyVersion(name, fs.readFileSync(mainPath, 'utf-8'), `参数 ${key} 更新为 ${value}`, 'user')
        return
      }
    }

    throw new Error(`Param ${key} not found in strategy ${name}`)
  })

  // --- 策略版本历史 ---

  ipcMain.handle('config:strategy:versions', (_e, name: string) => {
    validateFileName(name);
    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(name)
  })

  ipcMain.handle('config:strategy:rollback', (_e, name: string, version: number) => {
    validateFileName(name);
    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(name, version) as { content: string } | undefined
    if (!row) throw new Error(`Version ${version} not found for strategy ${name}`)

    // 写入文件
    const filePath = path.join(strategiesDir, `${name}.system.md`)
    fs.writeFileSync(filePath, row.content)

    // 记录回滚版本
    recordStrategyVersion(name, row.content, `回滚至 v${version}`, 'user')
  })

  // --- 策略参数读取（只读） ---

  ipcMain.handle('config:strategyParams', (_e, name: string) => {
    validateFileName(name);
    const params: Record<string, number | string | boolean> = {}

    // 先读主文件中的参数（向后兼容）
    const mainPath = path.join(strategiesDir, `${name}.system.md`)
    if (fs.existsSync(mainPath)) {
      Object.assign(params, parseParamsFromStrategy(fs.readFileSync(mainPath, 'utf-8')))
    }

    // 再读 .params.md 文件（覆盖主文件中的同名参数）
    const paramsPath = path.join(strategiesDir, `${name}.params.md`)
    if (fs.existsSync(paramsPath)) {
      Object.assign(params, parseParamsFromStrategy(fs.readFileSync(paramsPath, 'utf-8')))
    }

    return params
  })

  // --- MCP 工具描述 ---

  ipcMain.handle('config:mcp-descriptions', () => {
    if (!fs.existsSync(mcpDescPath)) return {}
    try {
      return JSON.parse(fs.readFileSync(mcpDescPath, 'utf-8'))
    } catch {
      return {}
    }
  })

  ipcMain.handle('config:mcp-descriptions:update', (_e, descriptions: Record<string, string>, changedTool?: string) => {
    // 读取旧版本，找出实际变更的工具
    let oldDescriptions: Record<string, string> = {}
    if (fs.existsSync(mcpDescPath)) {
      try { oldDescriptions = JSON.parse(fs.readFileSync(mcpDescPath, 'utf-8')) } catch {}
    }

    fs.writeFileSync(mcpDescPath, JSON.stringify(descriptions, null, 2))

    // 按工具独立记录版本，只记录实际变更的
    if (changedTool && descriptions[changedTool] !== oldDescriptions[changedTool]) {
      recordStrategyVersion(`mcp-desc:${changedTool}`, descriptions[changedTool], 'MCP 工具描述更新', 'user')
    } else {
      // fallback：找出所有变更的工具分别记录
      for (const [name, desc] of Object.entries(descriptions)) {
        if (desc !== oldDescriptions[name]) {
          recordStrategyVersion(`mcp-desc:${name}`, desc, 'MCP 工具描述更新', 'user')
        }
      }
    }
  })

  ipcMain.handle('config:mcp-descriptions:versions', (_e, toolName: string) => {
    validateFileName(toolName);
    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(`mcp-desc:${toolName}`)
  })

  ipcMain.handle('config:mcp-descriptions:rollback', (_e, toolName: string, version: number) => {
    validateFileName(toolName);
    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(`mcp-desc:${toolName}`, version) as { content: string } | undefined
    if (!row) throw new Error(`Version ${version} not found for mcp-desc:${toolName}`)

    // 更新 JSON 文件中对应工具的描述
    let descriptions: Record<string, string> = {}
    if (fs.existsSync(mcpDescPath)) {
      try { descriptions = JSON.parse(fs.readFileSync(mcpDescPath, 'utf-8')) } catch {}
    }
    descriptions[toolName] = row.content
    fs.writeFileSync(mcpDescPath, JSON.stringify(descriptions, null, 2))
    recordStrategyVersion(`mcp-desc:${toolName}`, row.content, `回滚至 v${version}`, 'user')
  })

  // --- Skill 文件 ---

  ipcMain.handle('config:skills', () => {
    if (!fs.existsSync(skillDir)) return []
    return fs.readdirSync(skillDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f.replace('.md', ''),
        path: path.join(skillDir, f),
      }))
  })

  ipcMain.handle('config:skill', (_e, name: string) => {
    validateFileName(name);
    const filePath = path.join(skillDir, `${name}.md`)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('config:skill:update', (_e, name: string, content: string, reason?: string) => {
    validateFileName(name);
    const filePath = path.join(skillDir, `${name}.md`)
    fs.writeFileSync(filePath, content)
    recordStrategyVersion(`skill:${name}`, content, reason ?? null, 'user')
  })

  // Skill 版本历史
  ipcMain.handle('config:skill:versions', (_e, name: string) => {
    validateFileName(name);
    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(`skill:${name}`)
  })

  ipcMain.handle('config:skill:rollback', (_e, name: string, version: number) => {
    validateFileName(name);
    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(`skill:${name}`, version) as { content: string } | undefined
    if (!row) throw new Error(`Version ${version} not found for skill ${name}`)

    const filePath = path.join(skillDir, `${name}.md`)
    fs.writeFileSync(filePath, row.content)
    recordStrategyVersion(`skill:${name}`, row.content, `回滚至 v${version}`, 'user')
  })

  // 文件夹选择器
  ipcMain.handle('config:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择笔记文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

/**
 * 在指定文件中查找并更新参数值，返回是否成功
 */
function updateParamInFile(filePath: string, key: string, value: string): boolean {
  let content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|') || line.match(/^\|\s*-+/)) continue
    const cells = line.split('|').map(c => c.trim()).filter(Boolean)
    if (cells.length < 2) continue
    if (cells[0] === key) {
      const parts = line.split('|')
      if (parts.length >= 3) {
        const oldVal = parts[2]
        const padded = oldVal.replace(oldVal.trim(), value)
        parts[2] = padded
        lines[i] = parts.join('|')
        fs.writeFileSync(filePath, lines.join('\n'))
        return true
      }
    }
  }
  return false
}

/**
 * 记录策略版本历史 + 创建 meta 节点进入知识图谱
 */
function recordStrategyVersion(
  name: string,
  content: string,
  reason: string | null,
  changedBy: string,
): void {
  if (!content) return; // 不记录空内容
  try {
    const db = getClientDb()

    // 获取下一个版本号
    const lastVersion = db.prepare(
      'SELECT MAX(version) as v FROM strategy_versions WHERE strategy_name = ?'
    ).get(name) as { v: number | null } | undefined
    const newVersion = (lastVersion?.v ?? 0) + 1

    // 插入版本记录
    db.prepare(
      'INSERT INTO strategy_versions (strategy_name, version, content, change_reason, changed_by, created) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
    ).run(name, newVersion, content, reason, changedBy)

    // 创建 meta 节点进入知识图谱（一切都是知识）
    try {
      createNode(db, {
        type: 'meta',
        content: `策略 ${name} v${newVersion} 更新${reason ? ': ' + reason : ''}`,
        tags: ['strategy-evolution'],
        source_tool: 'client',
      })
    } catch {
      // meta 节点创建失败不影响版本记录
    }

    // 记录到时间线
    try {
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'strategy_update', ?, ?, 0, ?, datetime('now'))
      `).run(
        JSON.stringify({ key: 'strategy_updated', params: { name } }),
        JSON.stringify({ strategy_name: name, version: newVersion, action: reason?.includes('回滚') ? 'rollback' : 'update' }),
        changedBy === 'learning2' ? 'brain' : 'user',
      )
    } catch {}
  } catch (err) {
    console.error('[config] 策略版本记录失败:', (err as Error).message)
  }
}

/**
 * 从策略 .md 文件中解析参数表（与 server 端 loader.ts 的 parseParams 同逻辑）
 */
function parseParamsFromStrategy(content: string): Record<string, number | string | boolean> {
  const params: Record<string, number | string | boolean> = {}
  const lines = content.split('\n')
  for (const line of lines) {
    let key: string | null = null
    let val: string | null = null

    // 格式 1: 表格 | key | value | description |
    if (line.startsWith('|') && !line.match(/^\|\s*-+/)) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean)
      if (cells.length >= 2) {
        key = cells[0]
        val = cells[1]
        if (key === '参数' || key === 'param' || key === 'key') continue
      }
    }
    // 格式 2: 列表 - key: value
    else if (line.match(/^\s*-\s+\w[\w_]*\s*:/)) {
      const m = line.match(/^\s*-\s+([\w_]+)\s*:\s*(.+)$/)
      if (m) {
        key = m[1]
        val = m[2].trim()
      }
    }

    if (!key || val === null) continue

    // 类型推断
    if (val === 'true' || val === 'false') {
      params[key] = val === 'true'
    } else if (!isNaN(Number(val)) && val !== '') {
      params[key] = Number(val)
    } else {
      params[key] = val
    }
  }
  return params
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
    } else {
      result[key] = source[key]
    }
  }
  return result
}
