import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { createLogger } from '../../../src/utils/logger.js'

const log = createLogger('ipc-operations')

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
    // F8 (audit-8): JSON.parse 出错或 parse 出来不是数组都 log 出来,而不是无声吞掉。
    // 历史 schema 演进或外部修改可能让 output_node_ids 变成对象/字符串/null,
    // 静默 catch 会让 UI 永远看不到关联节点,排查时也不知道是数据问题还是 query 问题。
    const op = operation as Record<string, unknown>
    let nodes: unknown[] = []
    if (op.output_node_ids) {
      try {
        const parsed = JSON.parse(op.output_node_ids as string) as unknown
        if (!Array.isArray(parsed)) {
          log.warn(`operations:get id=${id} output_node_ids 不是数组(type=${typeof parsed}),跳过节点查询`)
        } else {
          const nodeIds = parsed.filter((x): x is string => typeof x === 'string')
          if (nodeIds.length < parsed.length) {
            log.warn(`operations:get id=${id} output_node_ids 含 ${parsed.length - nodeIds.length} 个 non-string,已过滤`)
          }
          if (nodeIds.length > 0) {
            const placeholders = nodeIds.map(() => '?').join(',')
            nodes = db.prepare(`SELECT id, type, content FROM nodes WHERE id IN (${placeholders})`).all(...nodeIds)
          }
        }
      } catch (err) {
        log.warn(`operations:get id=${id} output_node_ids JSON.parse 失败: ${(err as Error).message}`)
      }
    }

    return { operation, nodes }
  })
}
