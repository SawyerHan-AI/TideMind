import { ipcMain } from 'electron'
import path from 'node:path'
import { getClientDb } from '../db.js'
import { randomBytes } from 'node:crypto'
import { validateAgentId } from './_validate'

function generateAgentId(): string {
  return 'eb_' + randomBytes(4).toString('hex')
}

function now(): string {
  return new Date().toISOString()
}

export function registerAgentHandlers(dataDir: string): void {
  // 查找 MCP server 入口路径
  const projectRoot = path.resolve(__dirname, '..', '..', '..')
  const mcpServerPath = path.join(projectRoot, 'dist', 'index.js')

  ipcMain.handle('agents:list', (_e, includeArchived?: boolean) => {
    const db = getClientDb()
    if (includeArchived) {
      return db.prepare('SELECT * FROM agents ORDER BY archived ASC, last_active DESC').all()
    }
    return db.prepare('SELECT * FROM agents WHERE archived = 0 ORDER BY last_active DESC').all()
  })

  ipcMain.handle('agents:create', (_e, params: { name: string; tool_type: string }) => {
    const db = getClientDb()
    const id = generateAgentId()
    const created = now()
    db.prepare(
      'INSERT INTO agents (id, name, tool_type, created) VALUES (?, ?, ?, ?)'
    ).run(id, params.name, params.tool_type, created)

    try {
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
      `).run(
        `创建了 Agent: ${params.name}`,
        JSON.stringify({ section: 'agent', action: 'create', agent_name: params.name, agent_id: id }),
      )
    } catch {}

    return { id, name: params.name, tool_type: params.tool_type, archived: 0, last_active: null, created }
  })

  ipcMain.handle('agents:update', (_e, id: string, params: { name?: string; tool_type?: string }) => {
    const validId = validateAgentId(id)
    const db = getClientDb()
    const sets: string[] = []
    const values: unknown[] = []
    if (params.name !== undefined) { sets.push('name = ?'); values.push(params.name) }
    if (params.tool_type !== undefined) { sets.push('tool_type = ?'); values.push(params.tool_type) }
    if (sets.length === 0) return
    values.push(validId)
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  })

  ipcMain.handle('agents:archive', (_e, id: string) => {
    const validId = validateAgentId(id)
    const db = getClientDb()
    db.prepare('UPDATE agents SET archived = 1 WHERE id = ?').run(validId)
  })

  ipcMain.handle('agents:unarchive', (_e, id: string) => {
    const validId = validateAgentId(id)
    const db = getClientDb()
    db.prepare('UPDATE agents SET archived = 0 WHERE id = ?').run(validId)
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

  ipcMain.handle('agents:delete', (_e, id: string) => {
    // 1. 校验格式：agentId 经 IPC 进来未经任何检查，曾被串入 fs.rmSync 路径，
    //    必须先卡死格式（见 _validate.ts）
    const validId = validateAgentId(id)
    const db = getClientDb()
    // 2. 显式 SELECT 一次：找不到时返回明确错误，而不是静默成功 —
    //    调用方据此判断是否要 cascade 触发 plugin uninstall
    const row = db.prepare('SELECT id FROM agents WHERE id = ?').get(validId)
    if (!row) {
      throw new Error('Agent not found')
    }
    db.prepare('DELETE FROM agents WHERE id = ?').run(validId)
    // operation_log 保留 agent_id 作为历史快照，不清理
  })

  ipcMain.handle('agents:mcp-snippet', (_e, agentId: string) => {
    const validId = validateAgentId(agentId)
    return {
      mcpServers: {
        'tidemind': {
          command: 'node',
          args: [mcpServerPath],
          env: { EB_AGENT_ID: validId },
        },
      },
    }
  })
}
