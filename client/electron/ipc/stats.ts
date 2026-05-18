import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'

export function registerStatsHandlers(db: Database.Database): void {
  ipcMain.handle('stats:overview', () => {
    const totalNodes = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01').get() as any).cnt
    const byType = db.prepare('SELECT type, COUNT(*) as cnt FROM nodes WHERE heat > 0.01 GROUP BY type').all()
    // Top tags(perf-optimization-2026-05-17 P1-2):原本 SELECT tags FROM
    // nodes WHERE heat > 0.01 + JS JSON.parse 全表聚合,万节点下数百 ms。
    // 改读 tag_usage 物化表(由 trigger 实时维护),毫秒级。
    const byTag = db.prepare(`
      SELECT tag, node_count AS cnt
      FROM tag_usage
      WHERE node_count > 0
      ORDER BY node_count DESC
      LIMIT 10
    `).all()
    const linkCount = (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status = 'confirmed'").get() as any).cnt
    const recallCount = (db.prepare("SELECT COUNT(*) as cnt FROM operation_log WHERE operation = 'recall'").get() as any).cnt

    // 最近 7 天节点增长
    const recentCounts = db.prepare(`
      SELECT date(created) as date, COUNT(*) as count
      FROM nodes
      WHERE created > date('now', '-7 days')
      GROUP BY date(created)
      ORDER BY date
    `).all()

    // 链接按主要 relation 类型分布（relation 是 JSON 数组，提取第一个元素的 type）
    const linksByRelation = db.prepare(`
      SELECT json_extract(relation, '$[0].type') as relation, COUNT(*) as cnt
      FROM links WHERE status = 'confirmed'
      GROUP BY json_extract(relation, '$[0].type') ORDER BY cnt DESC
    `).all()

    // 链接按状态分布
    const confirmed = (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status = 'confirmed'").get() as any).cnt
    const pending = (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status = 'pending'").get() as any).cnt
    const linksByStatus = { confirmed, pending }

    // 再巩固统计
    const reconsolidateCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM node_versions WHERE change_reason LIKE '%reconsolidat%'"
    ).get() as any).cnt
    const avgVersionRow = db.prepare(
      'SELECT AVG(version) as avg FROM nodes WHERE heat > 0.01'
    ).get() as { avg: number | null }
    const avgVersion = Math.round((avgVersionRow?.avg ?? 1) * 100) / 100

    return { totalNodes, byType, byTag, linkCount, recallCount, recentCounts, linksByRelation, linksByStatus, reconsolidateCount, avgVersion }
  })

  ipcMain.handle('stats:gates', () => {
    const nodeCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01').get() as any).cnt
    const linkCount = (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status = 'confirmed'").get() as any).cnt
    const recallCount = (db.prepare("SELECT COUNT(*) as cnt FROM operation_log WHERE operation = 'recall'").get() as any).cnt

    return {
      node_count: nodeCount,
      link_count: linkCount,
      recall_count: recallCount,
      features: {
        basic_digest: true,
        bm25_search: true,
        vector_search: nodeCount >= 50,
        graph_expansion: nodeCount >= 100 && linkCount >= 50,
        crystal_generation: nodeCount >= 200,
        divergent_scan: nodeCount >= 500,
      }
    }
  })

  ipcMain.handle('stats:maintenance', () => {
    // 对齐 scheduler.ts 统一 key: `last_task_{id}`,毫秒数字字符串
    // (不再读旧的 last_{daily|weekly}_maintenance —— 后者自 2026-04-21 起
    //  无人写入, claimMaintenance / needsWeeklyMaintenance 已删除)。
    //
    // 旧 daily 概念 → synaptic-decay (每日衰减,24h interval)
    // 旧 weekly 概念 → divergent-scan (每周发散扫描,7d interval,最具代表性)
    //
    // API 形状保持为 ISO 字符串以兼容 preload 类型,存储的毫秒值在这里转换。
    const toIso = (row: { value: string } | undefined): string | null => {
      if (!row?.value) return null
      // 毫秒数字字符串 → ISO (新格式)
      if (/^\d+$/.test(row.value)) {
        const ms = Number(row.value)
        return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
      }
      // 兼容旧 ISO 字符串(历史 learning2/3 若还是旧格式,不强制迁移)
      return row.value
    }
    const daily = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_synaptic-decay'").get() as { value: string } | undefined
    const weekly = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_divergent-scan'").get() as { value: string } | undefined
    const l2 = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_learning2'").get() as { value: string } | undefined
    const l3 = db.prepare("SELECT value FROM metadata WHERE key = 'last_task_learning3'").get() as { value: string } | undefined
    const l3Report = db.prepare("SELECT value FROM metadata WHERE key = 'last_learning3_report'").get() as { value: string } | undefined
    return {
      lastDaily: toIso(daily),
      lastWeekly: toIso(weekly),
      lastLearning2: toIso(l2),
      lastLearning3: toIso(l3),
      lastL3ReportId: l3Report?.value ?? null,
    }
  })

  ipcMain.handle('stats:evolution', () => {
    // 获取进化相关的统计
    const nodeCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01').get() as any).cnt
    const recallCount = (db.prepare("SELECT COUNT(*) as cnt FROM operation_log WHERE operation = 'recall'").get() as any).cnt
    const feedbackCount = (db.prepare('SELECT COUNT(*) as cnt FROM strategy_feedback').get() as any).cnt

    // 按策略分组的反馈
    const feedbackByStrategy = db.prepare(`
      SELECT strategy_name as strategy, AVG(feedback_signal) as avg_signal, COUNT(*) as cnt
      FROM strategy_feedback GROUP BY strategy_name ORDER BY cnt DESC
    `).all()

    // A/B 测试状态
    const variants = db.prepare(
      "SELECT key, value FROM metadata WHERE key LIKE 'learning2:variant:%'"
    ).all() as Array<{ key: string; value: string }>

    const activeTests = variants.map(v => {
      try {
        const data = JSON.parse(v.value)
        return {
          strategy: v.key.replace('learning2:variant:', ''),
          status: data.status,
          variant_id: data.variant_id,
          testing_operations: data.testing_operations ?? 0,
        }
      } catch { return null }
    }).filter(Boolean)

    return {
      learning2_ready: nodeCount >= 500 && recallCount >= 200,
      learning3_ready: false, // 需要 L2 运行 3+ 月
      nodeCount,
      recallCount,
      feedbackCount,
      feedbackByStrategy,
      activeTests,
    }
  })

  // 共用:补全 7 天空隙的辅助
  const fillDays = (sparse: Array<{ date: string; count: number }>): Array<{ date: string; count: number }> => {
    const map = new Map(sparse.map(d => [d.date, d.count]))
    const result: Array<{ date: string; count: number }> = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      result.push({ date: key, count: map.get(key) ?? 0 })
    }
    return result
  }

  // perf-optimization-2026-05-17 P1-3:Dashboard 切片化。
  // 原 stats:dashboard 一个 handler 串行做 8+ 条 SQL,Dashboard 必须等
  // 全部结果才能渲染首屏(其中 recentTags 全表 JSON.parse 在万节点下
  // 500-1000ms,堵住整个 IPC)。
  //
  // 切成 3 个独立 handler,renderer 并发拉、各自 loading 状态:
  // - dashboard-metrics:4 个 count + 4 个 trend(全部毫秒级)
  // - dashboard-activity:timeline UNION(10-100ms)
  // - dashboard-tags:SQL 级 json_each + GROUP BY(替代 JS JSON.parse)

  ipcMain.handle('stats:dashboard-metrics', () => {
    const totalMemories = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01').get() as any).cnt
    const todayDigests = (db.prepare("SELECT COUNT(*) as cnt FROM operation_log WHERE operation = 'digest' AND date(created) = date('now')").get() as any).cnt
    const todayNewLinks = (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE status = 'confirmed' AND date(created) = date('now')").get() as any).cnt
    const todayRecalls = (db.prepare("SELECT COUNT(*) as cnt FROM operation_log WHERE operation = 'recall' AND date(created) = date('now')").get() as any).cnt

    const memoryTrendRaw = db.prepare(`
      SELECT date(created) as date, COUNT(*) as count
      FROM nodes WHERE heat > 0.01 AND created > date('now', '-7 days')
      GROUP BY date(created) ORDER BY date
    `).all() as Array<{ date: string; count: number }>

    const digestTrendRaw = db.prepare(`
      SELECT date(created) as date, COUNT(*) as count
      FROM operation_log WHERE operation = 'digest' AND created > date('now', '-7 days')
      GROUP BY date(created) ORDER BY date
    `).all() as Array<{ date: string; count: number }>

    const linkTrendRaw = db.prepare(`
      SELECT date(created) as date, COUNT(*) as count
      FROM links WHERE status = 'confirmed' AND created > date('now', '-7 days')
      GROUP BY date(created) ORDER BY date
    `).all() as Array<{ date: string; count: number }>

    const recallTrendRaw = db.prepare(`
      SELECT date(created) as date, COUNT(*) as count
      FROM operation_log WHERE operation = 'recall' AND created > date('now', '-7 days')
      GROUP BY date(created) ORDER BY date
    `).all() as Array<{ date: string; count: number }>

    return {
      totalMemories,
      todayDigests,
      todayNewLinks,
      todayRecalls,
      memoryTrend: fillDays(memoryTrendRaw),
      digestTrend: fillDays(digestTrendRaw),
      linkTrend: fillDays(linkTrendRaw),
      recallTrend: fillDays(recallTrendRaw),
    }
  })

  ipcMain.handle('stats:dashboard-activity', () => {
    return db.prepare(`
      SELECT * FROM (
        SELECT id,
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
          subtype, title, node_ids, created
        FROM timeline_events
        UNION ALL
        SELECT id,
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
          output_node_ids as node_ids,
          created
        FROM operation_log
        UNION ALL
        SELECT nv.id, 'output' as type, 'reconsolidation' as subtype,
          '{"key":"reconsolidation"}' as title,
          json_array(nv.node_id) as node_ids,
          nv.changed_at as created
        FROM node_versions nv
      ) AS combined
      WHERE type != 'config'
      ORDER BY created DESC LIMIT 20
    `).all()
  })

  ipcMain.handle('stats:dashboard-tags', () => {
    // SQL 级聚合(perf-optimization-2026-05-17 P1-3):用 json_each 拆 tags +
    // GROUP BY 一次完成 count + MAX(created),替代原本"全表 SELECT tags +
    // JS JSON.parse + Map 聚合"的两阶段工作。
    const tagAgg = db.prepare(`
      SELECT je.value AS tag,
             COUNT(*) AS count,
             MAX(n.created) AS lastActivity
      FROM nodes n, json_each(COALESCE(n.tags, '[]')) je
      WHERE COALESCE(n.archived, 0) = 0
        AND COALESCE(n.is_superseded, 0) = 0
        AND typeof(je.value) = 'text'
        AND length(je.value) > 0
      GROUP BY je.value
    `).all() as Array<{ tag: string; count: number; lastActivity: string }>

    const coreTagRows = db.prepare('SELECT title, content FROM nodes WHERE is_tag = 1 AND heat > 0.01').all() as Array<{ title: string | null; content: string }>
    const coreTagSet = new Set(coreTagRows.map(r => (r.title ?? r.content).trim()))

    const withCore = tagAgg
      .map(r => ({ tag: r.tag, count: r.count, lastActivity: r.lastActivity, isCore: coreTagSet.has(r.tag) }))
      .sort((a, b) => b.count - a.count)

    // 核心标签全部保留 + 非核心取 top 10
    const coreTags = withCore.filter(t => t.isCore)
    const nonCoreTags = withCore.filter(t => !t.isCore).slice(0, 10)
    return [...coreTags, ...nonCoreTags].sort((a, b) => b.count - a.count)
  })

  ipcMain.handle('stats:usage', () => {
    const operationsByType = db.prepare(
      'SELECT operation, COUNT(*) as cnt FROM operation_log GROUP BY operation'
    ).all()

    const dailyCounts = db.prepare(`
      SELECT date(created) as date, operation, COUNT(*) as cnt
      FROM operation_log
      WHERE created > date('now', '-30 days')
      GROUP BY date(created), operation
    `).all()

    return { operationsByType, dailyCounts }
  })

  ipcMain.handle('stats:token-usage', () => {
    try {
      // 全局汇总（不限时间范围）
      const totals = db.prepare(`
        SELECT
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(thinking_tokens), 0) as thinking_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost,
          COUNT(*) as call_count
        FROM llm_usage_log
      `).get() as any

      // 按操作分组的费用汇总（用于拆解输入/输出/思考费用无法直接得到，用 token 级别即可）
      const costByTokenType = db.prepare(`
        SELECT
          COALESCE(SUM(estimated_cost), 0) as total_cost
        FROM llm_usage_log
      `).get() as any

      // 按操作分组的调用次数（用于汇总卡片 hover）
      const countByOperation = db.prepare(`
        SELECT operation, COUNT(*) as cnt, COALESCE(SUM(estimated_cost), 0) as cost
        FROM llm_usage_log
        GROUP BY operation
      `).all()

      // 最近10天按模型聚合（趋势图）
      const dailyByModel = db.prepare(`
        SELECT date(created) as date, model,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(thinking_tokens) as thinking_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM llm_usage_log
        WHERE created > date('now', '-10 days')
        GROUP BY date(created), model
        ORDER BY date(created)
      `).all()

      // 最近10天按操作聚合（趋势图）
      const dailyByOperation = db.prepare(`
        SELECT date(created) as date, operation,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(thinking_tokens) as thinking_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM llm_usage_log
        WHERE created > date('now', '-10 days')
        GROUP BY date(created), operation
        ORDER BY date(created)
      `).all()

      return { totals, countByOperation, dailyByModel, dailyByOperation }
    } catch {
      return {
        totals: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, estimated_cost: 0, call_count: 0 },
        countByOperation: [],
        dailyByModel: [],
        dailyByOperation: [],
      }
    }
  })

  // 带日期筛选的操作统计 + 明细（支持分页）
  ipcMain.handle('stats:token-usage-filtered', (_event, filter: { after?: string; before?: string; limit?: number; offset?: number }) => {
    try {
      const conditions: string[] = []
      const params: string[] = []

      if (filter.after) {
        conditions.push('created >= ?')
        params.push(filter.after)
      }
      if (filter.before) {
        conditions.push('created < ?')
        params.push(filter.before)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // 按操作分组统计
      const operationStats = db.prepare(`
        SELECT operation, COUNT(*) as cnt,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(thinking_tokens) as thinking_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM llm_usage_log
        ${where}
        GROUP BY operation
        ORDER BY cnt DESC
      `).all(...params)

      // 明细总数
      const totalRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM llm_usage_log ${where}
      `).get(...params) as { cnt: number }
      const totalLogs = totalRow.cnt

      // 明细日志（分页）
      const limit = filter.limit ?? 100
      const offset = filter.offset ?? 0
      const recentLogs = db.prepare(`
        SELECT id, model, operation, input_tokens, output_tokens, thinking_tokens, estimated_cost, created
        FROM llm_usage_log
        ${where}
        ORDER BY created DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset)

      return { operationStats, recentLogs, totalLogs }
    } catch {
      return { operationStats: [], recentLogs: [], totalLogs: 0 }
    }
  })
}
