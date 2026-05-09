import { ipcMain } from 'electron'
import { getClientDb } from '../db.js'
import { randomBytes } from 'node:crypto'
import {
  parseAgentCreate,
  parseAgentId,
  parseAgentUpdate,
  parseOptionalBoolean,
} from './_schemas.js'
import { getShimPath, getMcpServerScriptPath } from '../runtime/runtime-paths.js'

function generateAgentId(): string {
  return 'eb_' + randomBytes(4).toString('hex')
}

function now(): string {
  return new Date().toISOString()
}

export function registerAgentHandlers(_dataDir: string): void {
  // MCP server 入口路径(2026-05-09 重构):
  // 历史用 `path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js')` 加
  // `command: 'node'`,违反 plugin runtime 强约束(CLAUDE.md):严禁字面量 'node'
  // 或硬编码 Electron 路径。packaged 模式 __dirname 在 asar 内,该路径根本不
  // 存在;packaged 实际入口是 app.asar.unpacked/out/bin/mcp-server.cjs。
  // 改用 runtime-paths.ts 的 helpers,与 plugin-self-heal.ts / agent-plugins/
  // 完全一致。

  ipcMain.handle('agents:list', (_e, includeArchived?: unknown) => {
    const parsed = parseOptionalBoolean(includeArchived, 'includeArchived')
    if (!parsed.ok) return parsed.error

    const db = getClientDb()
    if (parsed.data) {
      return db.prepare('SELECT * FROM agents ORDER BY archived ASC, last_active DESC').all()
    }
    return db.prepare('SELECT * FROM agents WHERE archived = 0 ORDER BY last_active DESC').all()
  })

  ipcMain.handle('agents:create', (_e, params: unknown) => {
    const parsed = parseAgentCreate(params)
    if (!parsed.ok) return parsed.error

    const db = getClientDb()
    const id = generateAgentId()
    const created = now()
    db.prepare(
      'INSERT INTO agents (id, name, tool_type, created) VALUES (?, ?, ?, ?)'
    ).run(id, parsed.data.name, parsed.data.tool_type, created)

    try {
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
      `).run(
        `创建了 Agent: ${parsed.data.name}`,
        JSON.stringify({ section: 'agent', action: 'create', agent_name: parsed.data.name, agent_id: id }),
      )
    } catch {}

    return { id, name: parsed.data.name, tool_type: parsed.data.tool_type, archived: 0, last_active: null, created }
  })

  ipcMain.handle('agents:update', (_e, id: unknown, params: unknown) => {
    const parsedId = parseAgentId(id)
    if (!parsedId.ok) return parsedId.error
    const parsedParams = parseAgentUpdate(params)
    if (!parsedParams.ok) return parsedParams.error

    const db = getClientDb()
    const sets: string[] = []
    const values: unknown[] = []
    if (parsedParams.data.name !== undefined) { sets.push('name = ?'); values.push(parsedParams.data.name) }
    if (parsedParams.data.tool_type !== undefined) { sets.push('tool_type = ?'); values.push(parsedParams.data.tool_type) }
    if (sets.length === 0) return
    values.push(parsedId.data)
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  })

  ipcMain.handle('agents:archive', (_e, id: unknown) => {
    const parsedId = parseAgentId(id)
    if (!parsedId.ok) return parsedId.error

    const db = getClientDb()
    db.prepare('UPDATE agents SET archived = 1 WHERE id = ?').run(parsedId.data)
  })

  ipcMain.handle('agents:unarchive', (_e, id: unknown) => {
    const parsedId = parseAgentId(id)
    if (!parsedId.ok) return parsedId.error

    const db = getClientDb()
    db.prepare('UPDATE agents SET archived = 0 WHERE id = ?').run(parsedId.data)
  })

  ipcMain.handle('agents:stats', () => {
    const db = getClientDb()
    // 每个 agent 的操作统计
    const stats = db.prepare(`
      SELECT
        a.id,
        COUNT(CASE WHEN o.operation = 'digest' THEN 1 END) as digest_count,
        COUNT(CASE WHEN o.operation = 'recall' THEN 1 END) as recall_count,
        COUNT(CASE WHEN o.operation = 'prepare' THEN 1 END) as prepare_count
      FROM agents a
      LEFT JOIN operation_log o ON o.agent_id = a.id
      GROUP BY a.id
    `).all()
    return stats
  })

  ipcMain.handle('agents:delete', (_e, id: unknown) => {
    // 1. 校验格式：agentId 经 IPC 进来未经任何检查，曾被串入 fs.rmSync 路径，
    //    必须先卡死格式（见 _validate.ts）
    const parsedId = parseAgentId(id)
    if (!parsedId.ok) return parsedId.error

    const db = getClientDb()
    // 2. 显式 SELECT 一次：找不到时返回明确错误，而不是静默成功 —
    //    调用方据此判断是否要 cascade 触发 plugin uninstall
    const row = db.prepare('SELECT id FROM agents WHERE id = ?').get(parsedId.data)
    if (!row) {
      throw new Error('Agent not found')
    }
    db.prepare('DELETE FROM agents WHERE id = ?').run(parsedId.data)
    // operation_log 保留 agent_id 作为历史快照，不清理
  })

  ipcMain.handle('agents:mcp-snippet', (_e, agentId: unknown) => {
    const parsedId = parseAgentId(agentId)
    if (!parsedId.ok) return parsedId.error

    return {
      mcpServers: {
        'tidemind': {
          command: getShimPath(),
          args: [getMcpServerScriptPath()],
          env: { EB_AGENT_ID: parsedId.data },
        },
      },
    }
  })
}
