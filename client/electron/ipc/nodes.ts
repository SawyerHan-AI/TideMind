import { ipcMain } from 'electron'
import crypto from 'node:crypto'
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
    // 默认只显示"当前活跃"的节点：未归档、未被 supersede。
    // 调用方传 filter.archived=true 时，走"已归档节点"视图。
    if (filter.archived === true) {
      conditions.push('archived = 1')
    } else {
      conditions.push('archived = 0')
      conditions.push('is_superseded = 0')
    }
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
          const escapedTag = tag.replace(/%/g, '\\%').replace(/_/g, '\\_')
          conditions.push('tags LIKE ? ESCAPE \'\\\'')
          params.push(`%"${escapedTag}"%`)
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

    // 过滤掉用户已拒绝的 tagged 链接（rejected_by_user 状态保留在 DB 作反馈痕迹，但不再展示）
    const links = db.prepare(
      "SELECT * FROM links WHERE (from_id = ? OR to_id = ?) AND status != 'rejected_by_user'"
    ).all(id, id)
    const versions = db.prepare('SELECT * FROM node_versions WHERE node_id = ? ORDER BY version DESC').all(id)

    // 获取链接目标节点的预览
    const enrichedLinks = (links as Array<Record<string, unknown>>).map(link => {
      const targetId = link.from_id === id ? link.to_id : link.from_id
      const target = db.prepare('SELECT id, content, title, type FROM nodes WHERE id = ?').get(targetId as string) as { id: string; content: string; title: string | null; type: string } | undefined
      // 解析 relation JSON（DB 存储为 JSON 字符串）
      let parsedRelation = link.relation
      if (typeof link.relation === 'string') {
        try { parsedRelation = JSON.parse(link.relation as string) } catch { /* keep as-is */ }
      }
      return {
        ...link,
        relation: parsedRelation,
        target_content_preview: target?.content?.slice(0, 80) ?? '',
        target_title: target?.title ?? null,
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
        WHERE nodes_fts MATCH ? AND nodes.archived = 0 AND nodes.is_superseded = 0
        ORDER BY bm25(nodes_fts, 5.0, 1.0, 2.0)
        LIMIT ?
      `).all(ftsQuery, safeLimit)

      return { nodes, total: nodes.length }
    } catch {
      // fallback LIKE
      const escapedQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_')
      const nodes = db.prepare(
        "SELECT * FROM nodes WHERE content LIKE ? ESCAPE '\\' AND archived = 0 AND is_superseded = 0 ORDER BY heat DESC LIMIT ?"
      ).all(`%${escapedQuery}%`, safeLimit)
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
    // tag-promote 把标签名存在 title，content 是 LLM 生成的定义；兼容两种情况
    const coreTagRows = db.prepare('SELECT title, content FROM nodes WHERE is_tag = 1 AND heat > 0.01').all() as Array<{ title: string | null; content: string }>
    const coreTags = new Set(coreTagRows.map(r => (r.title ?? r.content).trim()))

    const result = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count, isCore: coreTags.has(tag) }))
      .sort((a, b) => b.count - a.count)

    return result
  })

  ipcMain.handle('nodes:promoteTag', (_e, tag: string) => {
    // P3-NEW-G: 校验入参类型 / 非空，避免写入畸形数据
    if (typeof tag !== 'string' || !tag.trim()) {
      throw new Error('invalid tag')
    }
    function computeTagLinkStrength(nodeContent: string, tagText: string, nodeTags: string[]): number {
      const contentMention = nodeContent.toLowerCase().includes(tagText.toLowerCase()) ? 0.7 : 0.4
      const concentrationBonus = nodeTags.length === 1 ? 0.1 : 0
      return Math.min(0.8, contentMention + concentrationBonus)
    }

    // 生成 URL-safe 随机 ID(32 字符 hex)。client/ 未安装 nanoid,复用 node:crypto,
    // 语义与 tag-promote.ts 的 nanoid(21) 等价——唯一性足够且路径独立(不跨系统比较)。
    const genId = () => crypto.randomBytes(16).toString('hex')

    db.transaction(() => {
      // 标签名存 title，content 留空（与 tag-promote.ts 一致）
      const tagNodeId = genId()
      db.prepare(`
        INSERT INTO nodes (id, type, content, title, heat, refinement, connectivity, independence,
          specificity, subjectivity, actuality, is_tag, created, version, archived, maturity_score)
        VALUES (?, 'fact', '', ?, 1.0, 0, 0, 0, 0.1, 0.1, 0.9, 1, datetime('now'), 1, 0, 0)
      `).run(tagNodeId, tag)

      // 链接方向：content_node → tag_node（与 tag-promote.ts 一致）
      const rows = db.prepare('SELECT id, content, tags FROM nodes WHERE tags IS NOT NULL AND heat > 0.01 AND is_tag = 0').all() as Array<{ id: string; content: string; tags: string }>
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.tags)
          if (Array.isArray(parsed) && parsed.includes(tag)) {
            const strength = computeTagLinkStrength(row.content, tag, parsed)
            const linkId = genId()
            db.prepare(`
              INSERT INTO links (id, from_id, to_id, relation, strength, auto, status, created)
              VALUES (?, ?, ?, ?, ?, 1, 'confirmed', datetime('now'))
            `).run(linkId, row.id, tagNodeId, JSON.stringify([{ type: 'tagged', confidence: 1.0 }]), strength)
          }
        } catch { /* skip malformed tags JSON */ }
      }

      // 从降级黑名单移除
      const raw = db.prepare("SELECT value FROM metadata WHERE key = 'demoted_tags'").get() as { value: string } | undefined
      if (raw) {
        try {
          const demoted: string[] = JSON.parse(raw.value).filter((t: string) => t !== tag)
          db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('demoted_tags', ?)").run(JSON.stringify(demoted))
        } catch { /* skip corrupted blacklist */ }
      }
    })()
  })

  ipcMain.handle('nodes:demoteTag', (_e, tag: string) => {
    db.transaction(() => {
      // 兼容新旧格式：新格式标签名在 title，旧格式在 content
      const tagNode = db.prepare(
        "SELECT id FROM nodes WHERE is_tag = 1 AND (title = ? OR content = ?) AND heat > 0.01 LIMIT 1"
      ).get(tag, tag) as { id: string } | undefined
      if (!tagNode) return

      db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(tagNode.id, tagNode.id)
      db.prepare('DELETE FROM node_versions WHERE node_id = ?').run(tagNode.id)
      db.prepare('DELETE FROM node_segments WHERE node_id = ?').run(tagNode.id)
      db.prepare('DELETE FROM nodes WHERE id = ?').run(tagNode.id)

      // 加入降级黑名单
      const raw = db.prepare("SELECT value FROM metadata WHERE key = 'demoted_tags'").get() as { value: string } | undefined
      let demoted: string[] = []
      if (raw) {
        try { demoted = JSON.parse(raw.value) } catch { /* reset if corrupted */ }
      }
      if (!demoted.includes(tag)) {
        demoted.push(tag)
        db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('demoted_tags', ?)").run(JSON.stringify(demoted))
      }
    })()
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
    // graph 视图也只展示"当前活跃"的节点
    if (filter.archived === true) {
      conditions.push('archived = 1')
    } else {
      conditions.push('archived = 0')
      conditions.push('is_superseded = 0')
    }
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
          const escapedTag = tag.replace(/%/g, '\\%').replace(/_/g, '\\_')
          conditions.push('tags LIKE ? ESCAPE \'\\\'')
          params.push(`%"${escapedTag}"%`)
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

    // Get 1-hop neighbors for each filtered node.
    //
    // P1-NEW-8: SQLite 默认 999 变量上限。单条 SQL 展开 3 × filteredIds，
    // filteredIds 超过 ~333 必 crash。按 BATCH 分批查后 JS 侧合并 + 去重。
    //
    // P3-NEW-E: SQL 语义简化 —— 查询直接返回所有 neighbor_id（可能包含 filter-set
    // 内自身节点 id），JS 侧统一用 `!nodeMap.has(id)` 过滤，避免 `DISTINCT CASE WHEN`
    // 子查询的语义歧义。
    const filteredIds = filteredNodes.map(n => n.id)
    // 单条 SQL 展开 2 × ids + 常量，保守 BATCH=400（留余量给 status 等）
    const BATCH = 400
    if (filteredIds.length > 0) {
      const neighborIdSet = new Set<string>()
      for (let i = 0; i < filteredIds.length; i += BATCH) {
        const slice = filteredIds.slice(i, i + BATCH)
        const placeholders = slice.map(() => '?').join(', ')
        const rows = db.prepare(
          `SELECT from_id, to_id FROM links
           WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
             AND status != 'rejected_by_user'`
        ).all(...slice, ...slice) as Array<{ from_id: string; to_id: string }>
        for (const r of rows) {
          neighborIdSet.add(r.from_id)
          neighborIdSet.add(r.to_id)
        }
      }
      // 去掉 filter-set 内节点（仅保留真正的 1-hop 外部邻居）
      const neighborIds = Array.from(neighborIdSet).filter(id => !nodeMap.has(id))
      if (neighborIds.length > 0) {
        for (let i = 0; i < neighborIds.length; i += BATCH) {
          const slice = neighborIds.slice(i, i + BATCH)
          const nPlaceholders = slice.map(() => '?').join(', ')
          const neighbors = db.prepare(`SELECT * FROM nodes WHERE id IN (${nPlaceholders})`).all(...slice) as any[]
          for (const n of neighbors) {
            nodeMap.set(n.id, n)
          }
        }
      }
    }

    // Get all links between the result set. 同样受 999-var 限制影响 —— 分批 + JS 去重。
    const allIds = Array.from(nodeMap.keys())
    let links: any[] = []
    if (allIds.length > 0) {
      const allIdsSet = new Set(allIds)
      const seenLinkIds = new Set<string>()
      for (let i = 0; i < allIds.length; i += BATCH) {
        const slice = allIds.slice(i, i + BATCH)
        const placeholders = slice.map(() => '?').join(', ')
        // 对每批 slice：取该批节点作为端点之一的所有链接
        // 再在 JS 侧过滤"另一端必须也在 allIds 内"，实现跨批 UNION 的等价语义
        const rows = db.prepare(
          `SELECT * FROM links
           WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
             AND status != 'rejected_by_user'`
        ).all(...slice, ...slice) as any[]
        for (const r of rows) {
          if (seenLinkIds.has(r.id)) continue
          if (!allIdsSet.has(r.from_id) || !allIdsSet.has(r.to_id)) continue
          seenLinkIds.add(r.id)
          links.push(r)
        }
      }
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

    // P2-NEW-K: prepare 一次，循环内仅 .all()，避免每节点重新编译 SQL
    const neighborsStmt = db.prepare(
      "SELECT from_id, to_id FROM links WHERE (from_id = ? OR to_id = ?) AND status != 'rejected_by_user'"
    )

    while (queue.length > 0 && depth < maxDepth && !found) {
      const levelSize = queue.length
      for (let i = 0; i < levelSize; i++) {
        const current = queue.shift()!
        const neighbors = neighborsStmt.all(current, current) as any[]

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
        SELECT from_id AS node, to_id AS neighbor FROM links WHERE status != 'rejected_by_user'
        UNION ALL
        SELECT to_id AS node, from_id AS neighbor FROM links WHERE status != 'rejected_by_user'
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
      LEFT JOIN links d1 ON d1.from_id = s.node_a AND d1.to_id = s.node_b AND d1.status != 'rejected_by_user'
      LEFT JOIN links d2 ON d2.from_id = s.node_b AND d2.to_id = s.node_a AND d2.status != 'rejected_by_user'
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

  // ────── 标签纠错（用户解除错误标签）──────
  //
  // 语义：不 DELETE 链接，而是改 status 作"用户拒绝"痕迹。tag-promote 感知该状态
  // 不再重建；annotate 过滤掉该标签避免 LLM 重新打上。同时同步清理 node.tags
  // JSON 中的标签名，保持 UI 一致（详情页元信息区的标签 pill 也应消失）。
  // timeline 事件仅记录，不进 recall/dashboard，只用于审计与撤销。

  ipcMain.handle('links:rejectTag', (_e, linkId: string) => {
    let resolvedTagName = ''
    let ok = false
    db.transaction(() => {
      const link = db.prepare(
        'SELECT id, from_id, to_id, strength, relation, status FROM links WHERE id = ?',
      ).get(linkId) as { id: string; from_id: string; to_id: string; strength: number; relation: string; status: string } | undefined
      if (!link) return
      // 已是 rejected 状态就不重复处理（也不重复写 timeline）
      if (link.status === 'rejected_by_user') { ok = true; return }

      // 取标签名（title 优先、fallback content），用于同步清理 node.tags 和撤销时回填
      const tag = db.prepare(
        'SELECT title, content FROM nodes WHERE id = ?',
      ).get(link.to_id) as { title: string | null; content: string } | undefined
      const tagName = ((tag?.title && tag.title.trim().length > 0) ? tag.title : tag?.content ?? '').trim()
      resolvedTagName = tagName

      // 1) UPDATE link 状态与强度
      db.prepare(
        "UPDATE links SET status = 'rejected_by_user', strength = 0, updated = datetime('now') WHERE id = ?",
      ).run(linkId)

      // 2) 从 node.tags JSON 里移除标签名（若存在），保持 UI 元信息区一致
      let tagRemovedFromNode = false
      if (tagName.length > 0) {
        const node = db.prepare('SELECT tags FROM nodes WHERE id = ?').get(link.from_id) as { tags: string | null } | undefined
        if (node?.tags) {
          try {
            const tags: string[] = JSON.parse(node.tags)
            if (Array.isArray(tags) && tags.includes(tagName)) {
              const filtered = tags.filter(t => t !== tagName)
              db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run(JSON.stringify(filtered), link.from_id)
              tagRemovedFromNode = true
            }
          } catch { /* 解析失败不阻塞主流程 */ }
        }
      }

      // 3) timeline 事件（type='memory' subtype='tag_rejected'），detail 里记录 prev_strength 供撤销使用
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, node_ids, important, actor, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        'memory',
        'tag_rejected',
        JSON.stringify({ key: 'tag_rejected', params: { tag: tagName } }),
        JSON.stringify({
          link_id: linkId,
          from_id: link.from_id,
          to_id: link.to_id,
          prev_strength: link.strength,
          tag_name: tagName,
          tag_removed_from_node: tagRemovedFromNode,
        }),
        JSON.stringify([link.from_id, link.to_id]),
        0,
        'user',
      )
      ok = true
    })()
    return { success: ok, tagName: resolvedTagName }
  })

  ipcMain.handle('links:undoRejectTag', (_e, linkId: string) => {
    let changed = false
    db.transaction(() => {
      // 读最新一条 tag_rejected 事件恢复 strength 和 tag_name
      const event = db.prepare(`
        SELECT detail FROM timeline_events
        WHERE subtype = 'tag_rejected' AND json_extract(detail, '$.link_id') = ?
        ORDER BY created DESC LIMIT 1
      `).get(linkId) as { detail: string } | undefined

      let prevStrength = 0.5
      let tagName = ''
      let tagRemovedFromNode = false
      let fromId: string | undefined
      if (event?.detail) {
        try {
          const d = JSON.parse(event.detail)
          if (typeof d.prev_strength === 'number') prevStrength = d.prev_strength
          if (typeof d.tag_name === 'string') tagName = d.tag_name
          if (typeof d.tag_removed_from_node === 'boolean') tagRemovedFromNode = d.tag_removed_from_node
          if (typeof d.from_id === 'string') fromId = d.from_id
        } catch { /* 事件 detail 解析失败，按默认值恢复 */ }
      }

      // 1) 恢复 link — 只对当前 status='rejected_by_user' 的链接生效
      // 守卫防御：对 confirmed / pending 链接误调用不会覆盖其数据。
      const result = db.prepare(
        "UPDATE links SET status = 'confirmed', strength = ?, updated = datetime('now') WHERE id = ? AND status = 'rejected_by_user'",
      ).run(prevStrength, linkId)
      if (result.changes === 0) return
      changed = true

      // 2) 把标签名加回 node.tags（仅当之前确实移除过、且目前不存在）
      if (tagRemovedFromNode && tagName.length > 0 && fromId) {
        const node = db.prepare('SELECT tags FROM nodes WHERE id = ?').get(fromId) as { tags: string | null } | undefined
        let tags: string[] = []
        if (node?.tags) {
          try { tags = JSON.parse(node.tags); if (!Array.isArray(tags)) tags = [] } catch { tags = [] }
        }
        if (!tags.includes(tagName)) {
          tags.push(tagName)
          db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run(JSON.stringify(tags), fromId)
        }
      }
    })()
    return { success: changed }
  })
}
