import { ipcMain, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import type Database from 'better-sqlite3'

interface ExportScope {
  tag?: string
  after?: string
  before?: string
}

/** 是否为"全部"导出（无任何筛选条件） */
function isFullScope(scope: ExportScope): boolean {
  return !scope.tag && !scope.after && !scope.before
}

/** 构建 nodes 查询的 WHERE 子句 */
function buildNodeQuery(scope: ExportScope): { where: string; params: unknown[] } {
  if (isFullScope(scope)) {
    // 全量导出：不加任何过滤，含 archived、低热度节点
    return { where: '', params: [] }
  }

  const conditions: string[] = []
  const params: unknown[] = []

  if (scope.tag) {
    const escapedTag = scope.tag.replace(/%/g, '\\%').replace(/_/g, '\\_')
    conditions.push('tags LIKE ? ESCAPE \'\\\'')
    params.push(`%"${escapedTag}"%`)
  }
  if (scope.after) {
    conditions.push('created > ?')
    params.push(scope.after)
  }
  if (scope.before) {
    conditions.push('created < ?')
    params.push(scope.before)
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

function safeQuery(db: Database.Database, sql: string): unknown[] {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

export function registerExportHandlers(db: Database.Database, _dataDir: string): void {
  // ── Markdown 导出 ──────────────────────────────────────────
  ipcMain.handle('export:markdown', (_e, scope: ExportScope) => {
    const { where, params } = buildNodeQuery(scope)
    const nodes = db.prepare(`SELECT * FROM nodes ${where} ORDER BY created DESC`).all(...params) as any[]

    const lines: string[] = ['# Tide Mind Export', '']

    // 全量模式下预加载所有 node_versions
    const full = isFullScope(scope)
    let versionsMap: Map<string, any[]> | undefined
    if (full) {
      const allVersions = db.prepare('SELECT * FROM node_versions ORDER BY version DESC').all() as any[]
      versionsMap = new Map()
      for (const v of allVersions) {
        const list = versionsMap.get(v.node_id) ?? []
        list.push(v)
        versionsMap.set(v.node_id, list)
      }
    }

    lines.push(`## Nodes (${nodes.length})`, '')

    for (const node of nodes) {
      const shortId = node.id.slice(0, 8)
      lines.push(`### [${node.type}] ${shortId}`)
      lines.push('')
      lines.push(node.content)
      lines.push('')
      lines.push(`- Heat: ${node.heat}, Refinement: ${node.refinement}, Connectivity: ${node.connectivity}, Independence: ${node.independence}`)
      lines.push(`- Tags: ${node.tags ?? 'N/A'}, Created: ${node.created}`)
      if (node.archived) lines.push('- **Archived**')

      // Links
      const links = db.prepare('SELECT * FROM links WHERE from_id = ? OR to_id = ?').all(node.id, node.id) as any[]
      if (links.length > 0) {
        lines.push('')
        lines.push('#### Links')
        for (const link of links) {
          const targetId = link.from_id === node.id ? link.to_id : link.from_id
          const target = db.prepare('SELECT id, content FROM nodes WHERE id = ?').get(targetId) as any
          const preview = target?.content?.slice(0, 60) ?? 'unknown'
          const direction = link.from_id === node.id ? '\u2192' : '\u2190'
          let relLabel = 'unknown'
          try {
            const parsed = typeof link.relation === 'string' ? JSON.parse(link.relation) : link.relation
            relLabel = Array.isArray(parsed) && parsed.length > 0 ? parsed[0].type : String(link.relation)
          } catch { relLabel = String(link.relation) }
          lines.push(`- ${direction} [${relLabel}] ${preview} (strength: ${link.strength})`)
        }
      }

      // Node versions（全量模式）
      if (versionsMap) {
        const versions = versionsMap.get(node.id)
        if (versions && versions.length > 0) {
          lines.push('')
          lines.push('#### History')
          for (const v of versions) {
            lines.push(`- v${v.version} (${v.changed_at}): ${v.change_reason ?? ''}`)
            lines.push(`  ${v.content.slice(0, 120)}${v.content.length > 120 ? '...' : ''}`)
          }
        }
      }

      lines.push('')
    }

    return lines.join('\n')
  })

  // ── JSON 导出 ──────────────────────────────────────────────
  ipcMain.handle('export:json', (_e, scope: ExportScope) => {
    const { where, params } = buildNodeQuery(scope)
    const nodes = db.prepare(`SELECT * FROM nodes ${where} ORDER BY created DESC`).all(...params)

    const nodeIds = (nodes as any[]).map(n => n.id)

    // Links: 全量模式导出全部，筛选模式只导出关联 nodes 的
    let links: any[]
    if (isFullScope(scope)) {
      links = db.prepare('SELECT * FROM links').all()
    } else if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => '?').join(', ')
      links = db.prepare(
        `SELECT * FROM links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
      ).all(...nodeIds, ...nodeIds)
    } else {
      links = []
    }

    const result: Record<string, unknown> = {
      version: 1,
      exportedAt: new Date().toISOString(),
      nodes,
      links,
    }

    // 全量模式：附带所有用户数据表
    if (isFullScope(scope)) {
      result.nodeVersions = db.prepare('SELECT * FROM node_versions ORDER BY node_id, version').all()
      result.agents = db.prepare('SELECT * FROM agents').all()
      result.noteSources = db.prepare('SELECT * FROM note_sources').all()

      // model_connections: credentials 脱敏
      const conns = db.prepare('SELECT * FROM model_connections').all() as any[]
      result.modelConnections = conns.map(c => ({
        ...c,
        credentials: c.credentials ? '[REDACTED]' : null,
      }))

      result.timelineEvents = db.prepare('SELECT * FROM timeline_events ORDER BY created DESC').all()
      result.operationLog = db.prepare('SELECT * FROM operation_log ORDER BY created DESC').all()
      result.strategyFeedback = db.prepare('SELECT * FROM strategy_feedback ORDER BY created DESC').all()
      result.strategyVersions = db.prepare('SELECT * FROM strategy_versions ORDER BY created DESC').all()
      result.llmUsageLog = db.prepare('SELECT * FROM llm_usage_log ORDER BY created DESC').all()
      result.paramFeedback = safeQuery(db, 'SELECT * FROM param_feedback ORDER BY created DESC')
      result.paramAdjustments = safeQuery(db, 'SELECT * FROM param_adjustments ORDER BY created DESC')
    }

    return result
  })

  // ── 保存到文件 ─────────────────────────────────────────────
  ipcMain.handle('export:save-file', async (_e, content: string, defaultName: string) => {
    const ext = defaultName.endsWith('.json') ? 'json' : 'md'
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [
        ext === 'json'
          ? { name: 'JSON', extensions: ['json'] }
          : { name: 'Markdown', extensions: ['md'] },
      ],
    })

    if (canceled || !filePath) return { saved: false }

    await writeFile(filePath, content, 'utf-8')
    return { saved: true, path: filePath }
  })
}
