import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { getClientDb } from '../db.js'
import { createNode } from '@server/db/nodes.js'
import { loadConfig, reloadConfig } from '@server/config.js'
import { createLogger } from '@server/utils/logger.js'

const log = createLogger('ipc-config')
import {
  parseConfigContent,
  parseConfigFileName,
  parseConfigPatch,
  parseOptionalReason,
  parsePositiveVersion,
  parseStrategyParamArgs,
  parseStringRecord,
} from './_schemas.js'
import { getShimPath, getMcpServerScriptPath } from '../runtime/runtime-paths.js'
import { mainT } from '../i18n.js'
import { clearClientCache } from '@server/llm/client.js'
import { schedulePush as schedulePushUserStrategy } from '../cloud/strategy-push.js'
import { notifyMetabolismWorkerRuntimeMutation } from '../workers/metabolism-worker-runtime-mutations.js'

export function registerConfigHandlers(dataDir: string): void {
  const configPath = path.join(dataDir, 'config.toml')
  const strategiesDir = path.join(dataDir, 'strategies')
  const skillDir = path.join(dataDir, 'skill')
  const mcpDescPath = path.join(dataDir, 'mcp-descriptions.json')

  ipcMain.handle('config:mcp-command', () => {
    // 历史用 `command: 'node'` + `__dirname/../../../dist/index.js`,违反
    // plugin runtime 强约束 + packaged 模式路径根本不存在(asar 内 + 实际入口
    // 是 app.asar.unpacked/out/bin/mcp-server.cjs)。统一走 runtime-paths.ts。
    return { command: getShimPath(), args: [getMcpServerScriptPath()] }
  })

  ipcMain.handle('config:get', () => {
    try {
      reloadConfig()
      return loadConfig(configPath)
    } catch {
      return {}
    }
  })

  ipcMain.handle('config:update', (_e, patch: unknown) => {
    const parsedPatch = parseConfigPatch(patch)
    if (!parsedPatch.ok) return parsedPatch.error

    // parse 失败时**绝不**降级为 {}:那会让 deepMerge({}, patch) 把整份 config.toml
    // 重写成只含本次 patch 的内容,data_dir / cloud / API key / channel 等全部静默丢失
    // (自我强化故障:第一次非原子写截断 → 第二次写抹掉全部)。损坏时中止本次更新,
    // 向 renderer 返回结构化错误,保留原文件让用户/支持排查。
    let current: Record<string, unknown> = {}
    if (fs.existsSync(configPath)) {
      try {
        current = parseToml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      } catch (err) {
        log.error(`config:update 中止——config.toml 解析失败,拒绝覆盖以免丢失其余配置: ${(err as Error).message}`)
        return { success: false, error: 'config_parse_failed', details: [(err as Error).message] }
      }
    }

    // deep merge
    const merged = deepMerge(current, parsedPatch.data)
    writeConfigAtomic(configPath, stringifyToml(merged as any))
    reloadConfig()

    // 清掉 LLM client 缓存:用户改 API key / Vertex project_id / 模型选择后,
    // 旧 SDK 实例会持续用旧凭证返 401。指纹 cacheKey 已能盖住大多数场景,
    // 但 settings 写入是确定性事件,主动 clear 一次最稳。
    clearClientCache()
    notifyMetabolismWorkerRuntimeMutation('config')

    // 记录到时间线
    try {
      const db = getClientDb()
      const sections = Object.keys(parsedPatch.data)
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
      `).run(
        JSON.stringify({ key: 'settings_changed', params: { section: sections.join('/') } }),
        JSON.stringify({ section: sections.join('/'), changed_keys: Object.keys(parsedPatch.data) }),
      )
    } catch {}

    // 显式返回成功:契约统一为 {success, error?},让 renderer 能区分写入成功 /
    // 校验失败 / config.toml 损坏(后两者已分别返回 {success:false,...})。
    return { success: true }
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

  ipcMain.handle('config:strategy', (_e, name: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error

    const filePath = path.join(strategiesDir, `${parsedName.data}.system.md`)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('config:strategy:update', (_e, name: unknown, content: unknown, reason?: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error
    const parsedContent = parseConfigContent(content)
    if (!parsedContent.ok) return parsedContent.error
    const parsedReason = parseOptionalReason(reason)
    if (!parsedReason.ok) return parsedReason.error

    const filePath = path.join(strategiesDir, `${parsedName.data}.system.md`)
    fs.writeFileSync(filePath, parsedContent.data)

    // 记录版本历史 + 创建 meta 节点
    recordStrategyVersion(parsedName.data, parsedContent.data, parsedReason.data ?? null, 'user')
    notifyMetabolismWorkerRuntimeMutation('strategy')

    // Silent push 到云端,让云代谢用用户自定义 prompt;未登录 / 未开同步 / 网络
    // 异常都是 no-op,不阻塞用户编辑流程。
    schedulePushUserStrategy(parsedName.data, parsedContent.data)
  })

  // --- User Prompt（.user.md）读写 ---

  ipcMain.handle('config:strategy:user', (_e, name: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error

    const filePath = path.join(strategiesDir, `${parsedName.data}.user.md`)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('config:strategy:user:update', (_e, name: unknown, content: unknown, reason?: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error
    const parsedContent = parseConfigContent(content)
    if (!parsedContent.ok) return parsedContent.error
    const parsedReason = parseOptionalReason(reason)
    if (!parsedReason.ok) return parsedReason.error

    const filePath = path.join(strategiesDir, `${parsedName.data}.user.md`)
    fs.writeFileSync(filePath, parsedContent.data)
    recordStrategyVersion(`${parsedName.data}:user`, parsedContent.data, parsedReason.data ?? null, 'user')
    notifyMetabolismWorkerRuntimeMutation('strategy')
  })

  ipcMain.handle('config:strategy:user:versions', (_e, name: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error

    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(`${parsedName.data}:user`)
  })

  ipcMain.handle('config:strategy:user:rollback', (_e, name: unknown, version: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error
    const parsedVersion = parsePositiveVersion(version)
    if (!parsedVersion.ok) return parsedVersion.error

    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(`${parsedName.data}:user`, parsedVersion.data) as { content: string } | undefined
    if (!row) throw new Error(`User prompt version ${parsedVersion.data} not found for strategy ${parsedName.data}`)

    const filePath = path.join(strategiesDir, `${parsedName.data}.user.md`)
    fs.writeFileSync(filePath, row.content)
    recordStrategyVersion(`${parsedName.data}:user`, row.content, `回滚至 v${parsedVersion.data}`, 'user')
    notifyMetabolismWorkerRuntimeMutation('strategy')
  })

  // --- 策略参数单独更新 ---

  ipcMain.handle('config:strategyParamUpdate', (_e, name: unknown, key: unknown, value: unknown) => {
    const parsed = parseStrategyParamArgs(name, key, value)
    if (!parsed.ok) return parsed.error

    // 优先在 .params.md 文件中查找和更新参数
    const paramsPath = path.join(strategiesDir, `${parsed.data.name}.params.md`)
    const mainPath = path.join(strategiesDir, `${parsed.data.name}.system.md`)

    // 尝试在 params 文件中更新
    if (fs.existsSync(paramsPath)) {
      const result = updateParamInFile(paramsPath, parsed.data.key, parsed.data.value)
      if (result) {
        recordStrategyVersion(parsed.data.name, fs.readFileSync(paramsPath, 'utf-8'), `参数 ${parsed.data.key} 更新为 ${parsed.data.value}`, 'user')
        notifyMetabolismWorkerRuntimeMutation('strategy')
        return
      }
    }

    // 回退到主文件
    if (fs.existsSync(mainPath)) {
      const result = updateParamInFile(mainPath, parsed.data.key, parsed.data.value)
      if (result) {
        recordStrategyVersion(parsed.data.name, fs.readFileSync(mainPath, 'utf-8'), `参数 ${parsed.data.key} 更新为 ${parsed.data.value}`, 'user')
        notifyMetabolismWorkerRuntimeMutation('strategy')
        return
      }
    }

    throw new Error(`Param ${parsed.data.key} not found in strategy ${parsed.data.name}`)
  })

  // --- 策略版本历史 ---

  ipcMain.handle('config:strategy:versions', (_e, name: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error

    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(parsedName.data)
  })

  ipcMain.handle('config:strategy:rollback', (_e, name: unknown, version: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error
    const parsedVersion = parsePositiveVersion(version)
    if (!parsedVersion.ok) return parsedVersion.error

    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(parsedName.data, parsedVersion.data) as { content: string } | undefined
    if (!row) throw new Error(`Version ${parsedVersion.data} not found for strategy ${parsedName.data}`)

    // 写入文件
    const filePath = path.join(strategiesDir, `${parsedName.data}.system.md`)
    fs.writeFileSync(filePath, row.content)

    // 记录回滚版本
    recordStrategyVersion(parsedName.data, row.content, `回滚至 v${parsedVersion.data}`, 'user')
    notifyMetabolismWorkerRuntimeMutation('strategy')

    // 回滚也是一次用户改 prompt,同样 silent push 让云端跟上
    schedulePushUserStrategy(parsedName.data, row.content)
  })

  // --- 策略参数读取（只读） ---

  ipcMain.handle('config:strategyParams', (_e, name: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error

    const params: Record<string, number | string | boolean> = {}

    // 先读主文件中的参数（向后兼容）
    const mainPath = path.join(strategiesDir, `${parsedName.data}.system.md`)
    if (fs.existsSync(mainPath)) {
      Object.assign(params, parseParamsFromStrategy(fs.readFileSync(mainPath, 'utf-8')))
    }

    // 再读 .params.md 文件（覆盖主文件中的同名参数）
    const paramsPath = path.join(strategiesDir, `${parsedName.data}.params.md`)
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

  ipcMain.handle('config:mcp-descriptions:update', (_e, descriptions: unknown, changedTool?: unknown) => {
    const parsedDescriptions = parseStringRecord(descriptions, 'descriptions')
    if (!parsedDescriptions.ok) return parsedDescriptions.error

    let parsedChangedTool: string | undefined
    if (changedTool !== undefined) {
      const parsed = parseConfigFileName(changedTool, 'changedTool')
      if (!parsed.ok) return parsed.error
      parsedChangedTool = parsed.data
    }

    // 读取旧版本，找出实际变更的工具
    let oldDescriptions: Record<string, string> = {}
    if (fs.existsSync(mcpDescPath)) {
      try { oldDescriptions = JSON.parse(fs.readFileSync(mcpDescPath, 'utf-8')) } catch {}
    }

    fs.writeFileSync(mcpDescPath, JSON.stringify(parsedDescriptions.data, null, 2))

    // 按工具独立记录版本，只记录实际变更的
    if (parsedChangedTool && parsedDescriptions.data[parsedChangedTool] !== oldDescriptions[parsedChangedTool]) {
      recordStrategyVersion(`mcp-desc:${parsedChangedTool}`, parsedDescriptions.data[parsedChangedTool], 'MCP 工具描述更新', 'user')
    } else {
      // fallback：找出所有变更的工具分别记录
      for (const [name, desc] of Object.entries(parsedDescriptions.data)) {
        if (desc !== oldDescriptions[name]) {
          recordStrategyVersion(`mcp-desc:${name}`, desc, 'MCP 工具描述更新', 'user')
        }
      }
    }
  })

  ipcMain.handle('config:mcp-descriptions:versions', (_e, toolName: unknown) => {
    const parsedToolName = parseConfigFileName(toolName, 'toolName')
    if (!parsedToolName.ok) return parsedToolName.error

    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(`mcp-desc:${parsedToolName.data}`)
  })

  ipcMain.handle('config:mcp-descriptions:rollback', (_e, toolName: unknown, version: unknown) => {
    const parsedToolName = parseConfigFileName(toolName, 'toolName')
    if (!parsedToolName.ok) return parsedToolName.error
    const parsedVersion = parsePositiveVersion(version)
    if (!parsedVersion.ok) return parsedVersion.error

    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(`mcp-desc:${parsedToolName.data}`, parsedVersion.data) as { content: string } | undefined
    if (!row) throw new Error(`Version ${parsedVersion.data} not found for mcp-desc:${parsedToolName.data}`)

    // 更新 JSON 文件中对应工具的描述
    let descriptions: Record<string, string> = {}
    if (fs.existsSync(mcpDescPath)) {
      try { descriptions = JSON.parse(fs.readFileSync(mcpDescPath, 'utf-8')) } catch {}
    }
    descriptions[parsedToolName.data] = row.content
    fs.writeFileSync(mcpDescPath, JSON.stringify(descriptions, null, 2))
    recordStrategyVersion(`mcp-desc:${parsedToolName.data}`, row.content, `回滚至 v${parsedVersion.data}`, 'user')
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

  ipcMain.handle('config:skill', (_e, name: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error

    const filePath = path.join(skillDir, `${parsedName.data}.md`)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('config:skill:update', (_e, name: unknown, content: unknown, reason?: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error
    const parsedContent = parseConfigContent(content)
    if (!parsedContent.ok) return parsedContent.error
    const parsedReason = parseOptionalReason(reason)
    if (!parsedReason.ok) return parsedReason.error

    const filePath = path.join(skillDir, `${parsedName.data}.md`)
    fs.writeFileSync(filePath, parsedContent.data)
    recordStrategyVersion(`skill:${parsedName.data}`, parsedContent.data, parsedReason.data ?? null, 'user')
  })

  // Skill 版本历史
  ipcMain.handle('config:skill:versions', (_e, name: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error

    const db = getClientDb()
    return db.prepare(
      'SELECT version, content, change_reason, changed_by, created FROM strategy_versions WHERE strategy_name = ? ORDER BY version DESC LIMIT 50'
    ).all(`skill:${parsedName.data}`)
  })

  ipcMain.handle('config:skill:rollback', (_e, name: unknown, version: unknown) => {
    const parsedName = parseConfigFileName(name)
    if (!parsedName.ok) return parsedName.error
    const parsedVersion = parsePositiveVersion(version)
    if (!parsedVersion.ok) return parsedVersion.error

    const db = getClientDb()
    const row = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? AND version = ?'
    ).get(`skill:${parsedName.data}`, parsedVersion.data) as { content: string } | undefined
    if (!row) throw new Error(`Version ${parsedVersion.data} not found for skill ${parsedName.data}`)

    const filePath = path.join(skillDir, `${parsedName.data}.md`)
    fs.writeFileSync(filePath, row.content)
    recordStrategyVersion(`skill:${parsedName.data}`, row.content, `回滚至 v${parsedVersion.data}`, 'user')
  })

  // 文件夹选择器
  ipcMain.handle('config:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: mainT('dialog.pickNoteFolder'),
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
    log.error(`策略版本记录失败: ${(err as Error).message}`)
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

/**
 * 原子写 config.toml(与 updater/channel.ts 2026-05-20 Audit B-3 同模式)。
 *
 * 裸 writeFileSync 是 truncate + write 两步,中途崩溃/断电留下半截 TOML;外部并发
 * 读者(外部 Agent 拉起的 mcp-server.cjs / hook 脚本 / daemon)在窗口期会读到 0 字节
 * → parseToml('') → {} → 全字段回退默认。tmp file + POSIX rename(原子)消除该窗口。
 * .tmp 用 pid + 时间戳避免多个 Electron 实例打架;dataDir 与 tmp 同卷,rename 不跨设备。
 */
function writeConfigAtomic(configPath: string, content: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8')
    fs.renameSync(tmpPath, configPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

// Prototype-pollution 守卫:与 src/config.ts:113 的 daemon 端 deepMerge 对齐。
// JSON 反序列化的 own enumerable __proto__ / constructor / prototype key 不应
// 被递归赋值到 target —— 否则攻击 patch 可污染 Object.prototype,影响主进程
// 后续所有对象的属性查询。
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
    } else {
      result[key] = source[key]
    }
  }
  return result
}
