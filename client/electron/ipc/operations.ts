import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'

export function registerOperationHandlers(db: Database.Database): void {
  ipcMain.handle('operations:list', (_e, filter: {
    operation?: string
    limit?: number
    offset?: number
  }) => {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.operation) {
      conditions.push('operation = ?')
      params.push(filter.operation)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filter.limit ?? 30
    const offset = filter.offset ?? 0

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM operation_log ${where}`).get(...params) as any).cnt
    const operations = db.prepare(
      `SELECT * FROM operation_log ${where} ORDER BY created DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset)

    return { operations, total }
  })

  ipcMain.handle('operations:get', (_e, id: number) => {
    const operation = db.prepare('SELECT * FROM operation_log WHERE id = ?').get(id)
    if (!operation) return null

    // 解析 output_node_ids 并获取对应节点
    const op = operation as Record<string, unknown>
    let nodes: unknown[] = []
    if (op.output_node_ids) {
      try {
        const nodeIds = JSON.parse(op.output_node_ids as string) as string[]
        if (nodeIds.length > 0) {
          const placeholders = nodeIds.map(() => '?').join(',')
          nodes = db.prepare(`SELECT id, type, content FROM nodes WHERE id IN (${placeholders})`).all(...nodeIds)
        }
      } catch {}
    }

    return { operation, nodes }
  })
}
