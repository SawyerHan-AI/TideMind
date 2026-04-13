import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'

/** 派生分类 → 维度条件 SQL（维度化迁移后前端发送派生分类名） */
function applyTypeFilter(type: string, conditions: string[], params: unknown[]): void {
  // 派生分类筛选排除未标注节点（refinement=0 的"待分类"只在全部视图显示）
  const annotated = 'refinement > 0'
  switch (type) {
    case 'record':
      conditions.push(`${annotated} AND specificity > 0.5 AND subjectivity <= 0.5 AND actuality >= 0.4`); break
    case 'knowledge':
      conditions.push(`${annotated} AND specificity <= 0.5 AND subjectivity <= 0.5 AND actuality >= 0.4`); break
    case 'belief':
      conditions.push(`${annotated} AND subjectivity > 0.5 AND actuality >= 0.4`); break
    case 'hypothesis':
      conditions.push(`${annotated} AND subjectivity <= 0.5 AND actuality < 0.4`); break
    case 'intention':
      conditions.push(`${annotated} AND subjectivity > 0.5 AND actuality < 0.4`); break
    default:
      conditions.push('type = ?'); params.push(type)
  }
}

export function registerNodeHandlers(db: Database.Database): void {
  ipcMain.handle('nodes:list', (_e, filter: {
    type?: string
    archived?: boolean
    search?: string
    sortBy?: string
    sortDir?: string
    limit?: number
    offset?: number
    heatMin?: number
    heatMax?: number
    createdAfter?: string
    createdBefore?: string
    tags?: string[]
  }) => {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.type) {
      applyTypeFilter(filter.type, conditions, params)
    }
    // 默认过滤极低 heat 的节点（替代旧的 archived 过滤）
    conditions.push('heat > 0.01')
    if (filter.search) {
      conditions.push('content LIKE ?')
      params.push(`%${filter.search}%`)
    }
    if (filter.heatMin !== undefined) {
      conditions.push('heat >= ?')
      params.push(filter.heatMin)
    }
    if (filter.heatMax !== undefined) {
      conditions.push('heat <= ?')
      params.push(filter.heatMax)
    }
    if (filter.createdAfter) {
      conditions.push('created > ?')
      params.push(filter.createdAfter)
    }
    if (filter.createdBefore) {
      conditions.push('created < ?')
      params.push(filter.createdBefore)
    }
    if (filter.tags) {
      const tagList = Array.isArray(filter.tags) ? filter.tags : [filter.tags]
      for (const tag of tagList) {
        if (tag) {
          conditions.push('tags LIKE ?')
          params.push(`%"${tag}"%`)
        }
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const VALID_SORT_COLS = new Set(['created', 'heat', 'refinement', 'connectivity', 'independence', 'maturity_score', 'id', 'type']);
    const VALID_SORT_DIRS = new Set(['ASC', 'DESC']);
    const safeSortBy = VALID_SORT_COLS.has(filter.sortBy!) ? filter.sortBy! : 'created';
    const safeSortDir = VALID_SORT_DIRS.has(filter.sortDir?.toUpperCase() ?? '') ? filter.sortDir!.toUpperCase() : 'DESC';
    const order = `${safeSortBy} ${safeSortDir}`
    const limit = filter.limit ?? 30
    const offset = filter.offset ?? 0

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM nodes ${where}`).get(...params) as { cnt: number }).cnt
    const nodes = db.prepare(`SELECT * FROM nodes ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset)

    return { nodes, total }
  })

  ipcMain.handle('nodes:get', (_e, id: string) => {
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id)
    if (!node) return null

    const links = db.prepare('SELECT * FROM links WHERE from_id = ? OR to_id = ?').all(id, id)
    const versions = db.prepare('SELECT * FROM node_versions WHERE node_id = ? ORDER BY version DESC').all(id)

    // 获取链接目标节点的预览
    const enrichedLinks = (links as Array<Record<string, unknown>>).map(link => {
      const targetId = link.from_id === id ? link.to_id : link.from_id
      const target = db.prepare('SELECT id, content, type FROM nodes WHERE id = ?').get(targetId as string) as { id: string; content: string; type: string } | undefined
      // 解析 relation JSON（DB 存储为 JSON 字符串）
      let parsedRelation = link.relation
      if (typeof link.relation === 'string') {
        try { parsedRelation = JSON.parse(link.relation as string) } catch { /* keep as-is */ }
      }
      return {
        ...link,
        relation: parsedRelation,
        target_content_preview: target?.content?.slice(0, 80) ?? '',
        target_type: target?.type ?? '',
        direction: link.from_id === id ? 'outgoing' : 'incoming',
      }
    })

    return { node, links: enrichedLinks, versions }
  })

  ipcMain.handle('nodes:search', (_e, query: string, limit?: number) => {
    const safeLimit = limit ?? 20
    try {
      // FTS5 搜索
      const words = query.replace(/[(){}[\]*:^~"]/g, ' ').trim().split(/\s+/).filter(Boolean)
      if (words.length === 0) return { nodes: [], total: 0 }

      const ftsQuery = words.map(w => `"${w}"`).join(' ')
      const nodes = db.prepare(`
        SELECT nodes.* FROM nodes_fts
        JOIN nodes ON nodes.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ? AND nodes.heat > 0.01
        ORDER BY nodes_fts.rank
        LIMIT ?
      `).all(ftsQuery, safeLimit)

      return { nodes, total: nodes.length }
    } catch {
      // fallback LIKE
      const nodes = db.prepare(
        'SELECT * FROM nodes WHERE content LIKE ? AND heat > 0.01 ORDER BY heat DESC LIMIT ?'
      ).all(`%${query}%`, safeLimit)
      return { nodes, total: nodes.length }
    }
  })

  ipcMain.handle('nodes:tags', () => {
    // Aggregate tags from nodes.tags JSON field
    const rows = db.prepare('SELECT tags FROM nodes WHERE tags IS NOT NULL AND heat > 0.01').all() as Array<{ tags: string }>
    const tagCounts = new Map<string, number>()
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.tags)
        if (Array.isArray(parsed)) {
          for (const tag of parsed) {
            if (typeof tag === 'string' && tag.trim()) {
              tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
            }
          }
        }
      } catch { /* skip malformed */ }
    }

    // Check which tags have is_tag=1 nodes (core tags)
    const coreTagRows = db.prepare('SELECT content FROM nodes WHERE is_tag = 1 AND heat > 0.01').all() as Array<{ content: string }>
    const coreTags = new Set(coreTagRows.map(r => r.content.trim()))

    const result = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count, isCore: coreTags.has(tag) }))
      .sort((a, b) => b.count - a.count)

    return result
  })

  ipcMain.handle('nodes:promoteTag', (_e, tag: string) => {
    // computeTagLinkStrength logic inline (from src/metabolism/tag-promote.ts)
    function computeTagLinkStrength(nodeContent: string, tagText: string, nodeTags: string[]): number {
      const contentMention = nodeContent.toLowerCase().includes(tagText.toLowerCase()) ? 0.7 : 0.4
      const concentrationBonus = nodeTags.length === 1 ? 0.1 : 0
      return Math.min(0.8, contentMention + concentrationBonus)
    }

    const { nanoid } = require('nanoid') as { nanoid: () => string }

    // Create the tag node (type='fact' with is_tag=1, matching tag-promote.ts pattern)
    const tagNodeId = nanoid()
    db.prepare(`
      INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence,
        specificity, subjectivity, actuality, is_tag, created, version, archived, maturity_score)
      VALUES (?, 'fact', ?, 1.0, 0, 0, 0, 0.1, 0.1, 0.9, 1, datetime('now'), 1, 0, 0)
    `).run(tagNodeId, tag)

    // Find all nodes that have this tag and create tagged links
    const rows = db.prepare('SELECT id, content, tags FROM nodes WHERE tags IS NOT NULL AND heat > 0.01 AND is_tag = 0').all() as Array<{ id: string; content: string; tags: string }>
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.tags)
        if (Array.isArray(parsed) && parsed.includes(tag)) {
          const strength = computeTagLinkStrength(row.content, tag, parsed)
          const linkId = nanoid()
          db.prepare(`
            INSERT INTO links (id, from_id, to_id, relation, strength, auto, status, created)
            VALUES (?, ?, ?, ?, ?, 1, 'confirmed', datetime('now'))
          `).run(linkId, tagNodeId, row.id, JSON.stringify([{ type: 'tagged', confidence: 1.0 }]), strength)
        }
      } catch { /* skip */ }
    }

    // Remove from demoted_tags blacklist if present
    const raw = db.prepare("SELECT value FROM metadata WHERE key = 'demoted_tags'").get() as { value: string } | undefined
    if (raw) {
      const demoted: string[] = JSON.parse(raw.value).filter((t: string) => t !== tag)
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('demoted_tags', ?)").run(JSON.stringify(demoted))
    }
  })

  ipcMain.handle('nodes:demoteTag', (_e, tag: string) => {
    // Find the tag node
    const tagNode = db.prepare(
      "SELECT id FROM nodes WHERE is_tag = 1 AND content = ? AND heat > 0.01"
    ).get(tag) as { id: string } | undefined
    if (!tagNode) return

    // 1. Delete all links to/from this tag node
    db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(tagNode.id, tagNode.id)

    // 2. Clean up version history and segments
    db.prepare('DELETE FROM node_versions WHERE node_id = ?').run(tagNode.id)
    db.prepare('DELETE FROM node_segments WHERE node_id = ?').run(tagNode.id)

    // 3. Delete the tag node itself (FTS auto-cleaned by trigger)
    db.prepare('DELETE FROM nodes WHERE id = ?').run(tagNode.id)

    // 4. Add to demoted_tags blacklist to prevent tag-promote from re-promoting
    const raw = db.prepare("SELECT value FROM metadata WHERE key = 'demoted_tags'").get() as { value: string } | undefined
    const demoted: string[] = raw ? JSON.parse(raw.value) : []
    if (!demoted.includes(tag)) {
      demoted.push(tag)
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('demoted_tags', ?)").run(JSON.stringify(demoted))
    }
  })

  ipcMain.handle('nodes:graph', (_e, filter: {
    type?: string
    archived?: boolean
    search?: string
    heatMin?: number
    heatMax?: number
    createdAfter?: string
    createdBefore?: string
    tags?: string[]
  }) => {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.type) {
      applyTypeFilter(filter.type, conditions, params)
    }
    // 默认过滤极低 heat 的节点（替代旧的 archived 过滤）
    conditions.push('heat > 0.01')
    if (filter.search) {
      conditions.push('content LIKE ?')
      params.push(`%${filter.search}%`)
    }
    if (filter.heatMin !== undefined) {
      conditions.push('heat >= ?')
      params.push(filter.heatMin)
    }
    if (filter.heatMax !== undefined) {
      conditions.push('heat <= ?')
      params.push(filter.heatMax)
    }
    if (filter.createdAfter) {
      conditions.push('created > ?')
      params.push(filter.createdAfter)
    }
    if (filter.createdBefore) {
      conditions.push('created < ?')
      params.push(filter.createdBefore)
    }
    if (filter.tags) {
      const tagList = Array.isArray(filter.tags) ? filter.tags : [filter.tags]
      for (const tag of tagList) {
        if (tag) {
          conditions.push('tags LIKE ?')
          params.push(`%"${tag}"%`)
        }
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const filteredNodes = db.prepare(`SELECT * FROM nodes ${where} LIMIT 500`).all(...params) as any[]

    // Collect all node IDs, then expand with 1-hop neighbors
    const nodeMap = new Map<string, any>()
    for (const n of filteredNodes) {
      nodeMap.set(n.id, n)
    }

    // Get 1-hop neighbors for each filtered node
    const filteredIds = filteredNodes.map(n => n.id)
    if (filteredIds.length > 0) {
      const placeholders = filteredIds.map(() => '?').join(', ')
      const neighborLinks = db.prepare(
        `SELECT DISTINCT CASE WHEN from_id IN (${placeholders}) THEN to_id ELSE from_id END as neighbor_id
         FROM links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
      ).all(...filteredIds, ...filteredIds, ...filteredIds) as any[]

      const neighborIds = neighborLinks.map(r => r.neighbor_id).filter((id: string) => !nodeMap.has(id))
      if (neighborIds.length > 0) {
        const nPlaceholders = neighborIds.map(() => '?').join(', ')
        const neighbors = db.prepare(`SELECT * FROM nodes WHERE id IN (${nPlaceholders})`).all(...neighborIds) as any[]
        for (const n of neighbors) {
          nodeMap.set(n.id, n)
        }
      }
    }

    // Get all links between the result set
    const allIds = Array.from(nodeMap.keys())
    let links: any[] = []
    if (allIds.length > 0) {
      const placeholders = allIds.map(() => '?').join(', ')
      links = db.prepare(
        `SELECT * FROM links WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})`
      ).all(...allIds, ...allIds)
    }

    // 解析 relation JSON
    const parsedLinks = links.map((link: any) => {
      let parsedRelation = link.relation
      if (typeof link.relation === 'string') {
        try { parsedRelation = JSON.parse(link.relation) } catch { /* keep as-is */ }
      }
      return { ...link, relation: parsedRelation }
    })

    return { nodes: Array.from(nodeMap.values()), links: parsedLinks }
  })

  ipcMain.handle('nodes:path', (_e, fromId: string, toId: string) => {
    if (fromId === toId) return { path: [fromId] }

    // BFS shortest path
    const visited = new Set<string>()
    const parent = new Map<string, string>()
    const queue: string[] = [fromId]
    visited.add(fromId)

    let found = false
    let depth = 0
    const maxDepth = 10

    while (queue.length > 0 && depth < maxDepth && !found) {
      const levelSize = queue.length
      for (let i = 0; i < levelSize; i++) {
        const current = queue.shift()!
        const neighbors = db.prepare(
          'SELECT from_id, to_id FROM links WHERE from_id = ? OR to_id = ?'
        ).all(current, current) as any[]

        for (const link of neighbors) {
          const neighbor = link.from_id === current ? link.to_id : link.from_id
          if (visited.has(neighbor)) continue
          visited.add(neighbor)
          parent.set(neighbor, current)

          if (neighbor === toId) {
            found = true
            break
          }
          queue.push(neighbor)
        }
        if (found) break
      }
      depth++
    }

    if (!found) return { path: [] }

    // Reconstruct path
    const pathResult: string[] = []
    let current: string | undefined = toId
    while (current !== undefined) {
      pathResult.unshift(current)
      current = parent.get(current)
    }

    return { path: pathResult }
  })

  ipcMain.handle('nodes:structureHoles', (_e, limit?: number) => {
    const safeLimit = limit ?? 20

    // Build bidirectional adjacency: treat links as undirected
    // neighbors CTE gives (node, neighbor) for every link in both directions
    const holes = db.prepare(`
      WITH neighbors AS (
        SELECT from_id AS node, to_id AS neighbor FROM links
        UNION ALL
        SELECT to_id AS node, from_id AS neighbor FROM links
      ),
      -- Find node pairs sharing 2+ neighbors but with no direct link
      shared AS (
        SELECT a.node AS node_a, b.node AS node_b, COUNT(*) AS shared
        FROM neighbors a
        JOIN neighbors b ON a.neighbor = b.neighbor AND a.node < b.node
        GROUP BY a.node, b.node
        HAVING shared >= 2
      )
      SELECT s.node_a, s.node_b, s.shared
      FROM shared s
      LEFT JOIN links d1 ON d1.from_id = s.node_a AND d1.to_id = s.node_b
      LEFT JOIN links d2 ON d2.from_id = s.node_b AND d2.to_id = s.node_a
      WHERE d1.id IS NULL AND d2.id IS NULL
      ORDER BY s.shared DESC
      LIMIT ?
    `).all(safeLimit) as any[]

    return holes.map(h => {
      const nodeA = db.prepare('SELECT id, content, type FROM nodes WHERE id = ?').get(h.node_a) as any
      const nodeB = db.prepare('SELECT id, content, type FROM nodes WHERE id = ?').get(h.node_b) as any
      return {
        nodeA: h.node_a,
        nodeB: h.node_b,
        sharedCount: h.shared,
        nodeAPreview: nodeA?.content?.slice(0, 80) ?? '',
        nodeBPreview: nodeB?.content?.slice(0, 80) ?? '',
      }
    })
  })
}
