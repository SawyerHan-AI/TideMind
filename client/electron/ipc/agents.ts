import { ipcMain } from 'electron'
import path from 'node:path'
import { getClientDb } from '../db.js'
import { randomBytes } from 'node:crypto'

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
    const db = getClientDb()
    const sets: string[] = []
    const values: unknown[] = []
    if (params.name !== undefined) { sets.push('name = ?'); values.push(params.name) }
    if (params.tool_type !== undefined) { sets.push('tool_type = ?'); values.push(params.tool_type) }
    if (sets.length === 0) return
    values.push(id)
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  })

  ipcMain.handle('agents:archive', (_e, id: string) => {
    const db = getClientDb()
    db.prepare('UPDATE agents SET archived = 1 WHERE id = ?').run(id)
  })

  ipcMain.handle('agents:unarchive', (_e, id: string) => {
    const db = getClientDb()
    db.prepare('UPDATE agents SET archived = 0 WHERE id = ?').run(id)
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
    const db = getClientDb()
    db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    // operation_log 保留 agent_id 作为历史快照，不清理
  })

  ipcMain.handle('agents:mcp-snippet', (_e, agentId: string) => {
    return {
      mcpServers: {
        'tidemind': {
          command: 'node',
          args: [mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        },
      },
    }
  })
}
