import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { parseSearchLimit, parseNodeId } from './_schemas.js'

// F10 (audit-9): IPC 输入校验。timeline 字段没经验证就拼进 SQL params,
// 攻击 / bug 路径可以塞超大数组 / 不合法 ID 让 SQL 引擎卡死或 timeline_events
// 上百倍放大查询。
const MAX_STRING_LEN = 256
const MAX_ARRAY_LEN = 500

function clampArray<T>(arr: T[] | undefined, predicate: (x: T) => boolean): T[] {
  if (!Array.isArray(arr)) return []
  return arr.filter(predicate).slice(0, MAX_ARRAY_LEN)
}
function isSafeShortString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN
}

export function registerTimelineHandlers(db: Database.Database): void {
  ipcMain.handle('timeline:list', (_e, filter: {
    types?: unknown
    actors?: unknown
    limit?: unknown
    offset?: unknown
    after?: unknown
    before?: unknown
  }) => {
    const parsedLimit = parseSearchLimit(filter.limit)
    const limit = parsedLimit.ok ? parsedLimit.data : 50
    const rawOffset = typeof filter.offset === 'number' && Number.isFinite(filter.offset) ? Math.max(0, Math.floor(filter.offset)) : 0
    const offset = Math.min(rawOffset, 100_000) // 防 OFFSET 太大致 SQL 退化扫整表

    const sanitizedTypes = clampArray(filter.types as unknown[] | undefined, isSafeShortString) as string[]
    const sanitizedActors = clampArray(filter.actors as unknown[] | undefined, isSafeShortString) as string[]
    const after = isSafeShortString(filter.after) ? filter.after : undefined
    const before = isSafeShortString(filter.before) ? filter.before : undefined

    const unionParts = [
      // timeline_events: 映射旧 type → 新认知功能分组
      `SELECT id,
        CASE type
          WHEN 'input' THEN 'memory'
          WHEN 'metabolism' THEN
            CASE subtype
              WHEN 'pending_link_review' THEN 'think_associate'
              WHEN 'conflict_detection' THEN 'think_associate'
              WHEN 'refine_links' THEN 'think_associate'
              WHEN 'link_classify' THEN 'think_associate'
              WHEN 'divergent_scan' THEN 'think_emerge'
              WHEN 'crystal_update' THEN 'think_emerge'
              WHEN 'keystone_identification' THEN 'think_emerge'
              WHEN 'split_merge' THEN 'think_emerge'
              WHEN 'tag_promote' THEN 'think_emerge'
              WHEN 'reconsolidation' THEN 'output'
              ELSE 'memory'
            END
          WHEN 'deep_processing' THEN 'think_emerge'
          ELSE type
        END as type,
        subtype, title, detail, node_ids, important,
        COALESCE(actor, 'brain') as actor,
        created, 'timeline' as source
      FROM timeline_events`,

      // operation_log: 按 operation 分配认知功能类型
      `SELECT id,
        CASE operation
          WHEN 'recall' THEN 'output'
          WHEN 'prepare' THEN 'output'
          ELSE 'memory'
        END as type,
        operation as subtype,
        CASE operation
          WHEN 'digest' THEN '{"key":"digest"}'
          WHEN 'recall' THEN '{"key":"recall"}'
          WHEN 'prepare' THEN '{"key":"prepare"}'
          ELSE operation
        END as title,
        json_object('input_summary', input_summary, 'context', context, 'tool', tool) as detail,
        output_node_ids as node_ids,
        0 as important,
        CASE
          WHEN tool = 'client' THEN 'user'
          WHEN tool IS NULL THEN 'brain'
          ELSE 'agent'
        END as actor,
        created,
        'operation' as source
      FROM operation_log`,

      // node_versions: 再巩固 → 输出
      `SELECT nv.id, 'output' as type, 'reconsolidation' as subtype,
        '{"key":"reconsolidation"}' as title,
        json_object('node_id', nv.node_id, 'version', nv.version, 'reason', nv.change_reason, 'content', nv.content) as detail,
        json_array(nv.node_id) as node_ids,
        0 as important,
        'brain' as actor,
        nv.changed_at as created,
        'version' as source
      FROM node_versions nv`,
    ]

    const baseQuery = unionParts.join(' UNION ALL ')

    const conditions: string[] = []
    const params: unknown[] = []

    if (sanitizedTypes.length > 0) {
      const placeholders = sanitizedTypes.map(() => '?').join(', ')
      conditions.push(`type IN (${placeholders})`)
      params.push(...sanitizedTypes)
    }
    if (sanitizedActors.length > 0) {
      const placeholders = sanitizedActors.map(() => '?').join(', ')
      conditions.push(`actor IN (${placeholders})`)
      params.push(...sanitizedActors)
    }
    if (after) {
      conditions.push('created > ?')
      params.push(after)
    }
    if (before) {
      conditions.push('created < ?')
      params.push(before)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countSql = `SELECT COUNT(*) as cnt FROM (${baseQuery}) AS combined ${where}`
    const total = (db.prepare(countSql).get(...params) as { cnt: number }).cnt

    const dataSql = `SELECT * FROM (${baseQuery}) AS combined ${where} ORDER BY created DESC LIMIT ? OFFSET ?`
    const events = db.prepare(dataSql).all(...params, limit, offset)

    return { events, total }
  })

  ipcMain.handle('timeline:resolve-nodes', (_e, nodeIds: unknown) => {
    // F10 (audit-9): validate + cap input。原代码直接把任意输入 splat 进 SQL params,
    // 超大数组会让 SQLite 单条 query 卡死,且无法控制 row 数量。
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) return {}
    const safeIds: string[] = []
    for (const raw of nodeIds) {
      const parsed = parseNodeId(raw)
      if (parsed.ok) safeIds.push(parsed.data)
      if (safeIds.length >= MAX_ARRAY_LEN) break
    }
    if (safeIds.length === 0) return {}
    const placeholders = safeIds.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT id, title, content, type FROM nodes WHERE id IN (${placeholders})`,
    ).all(...safeIds) as Array<{ id: string; title: string | null; content: string; type: string }>
    const result: Record<string, { title: string; type: string }> = {}
    for (const row of rows) {
      const displayTitle = row.title || row.content.split('\n')[0].slice(0, 60)
      result[row.id] = { title: displayTitle, type: row.type }
    }
    return result
  })

  ipcMain.handle('timeline:get', (_e, id: unknown, source: unknown) => {
    // F10 (audit-9): id 必须是有限整数,source 必须是已知 enum
    if (typeof id !== 'number' || !Number.isFinite(id) || !Number.isInteger(id) || id < 0) {
      return null
    }
    if (source !== 'timeline' && source !== 'operation' && source !== 'version') {
      return null
    }
    if (source === 'timeline') {
      return db.prepare('SELECT * FROM timeline_events WHERE id = ?').get(id)
    }

    if (source === 'operation') {
      const op = db.prepare('SELECT * FROM operation_log WHERE id = ?').get(id) as any
      if (!op) return null

      let nodes: any[] = []
      if (op.output_node_ids) {
        try {
          const nodeIds = JSON.parse(op.output_node_ids) as string[]
          if (nodeIds.length > 0) {
            const placeholders = nodeIds.map(() => '?').join(', ')
            nodes = db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...nodeIds)
          }
        } catch {}
      }

      return { ...op, nodes }
    }

    if (source === 'version') {
      const version = db.prepare('SELECT * FROM node_versions WHERE id = ?').get(id) as any
      if (!version) return null

      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(version.node_id)
      return { ...version, node }
    }

    return null
  })
}
