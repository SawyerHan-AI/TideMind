// window.api 类型声明

export interface NodeData {
  id: string
  /** @deprecated 双写期间保留，改用维度派生分类 */
  type: string
  title: string | null
  content: string
  // 四维成熟度
  heat: number
  refinement: number
  connectivity: number
  independence: number
  // 三维内容性质
  specificity: number
  subjectivity: number
  actuality: number
  // 来源
  source_tool: string | null
  source_session: string | null
  source_stream: string | null
  source_timestamp: string | null
  // 分类
  tags: string | null
  // 生命周期
  created: string
  last_reconsolidated: string | null
  version: number
  archived: number
  // 结构角色
  is_keystone: number
  is_crystal: number
  is_tag: number
  is_meta: number
  // 汇总
  maturity_score: number
}

export interface LinkRelation {
  type: string
  confidence: number
}

export interface LinkData {
  id: string
  from_id: string
  to_id: string
  relation: LinkRelation[]
  strength: number
  note: string | null
  auto: number
  status: string
  created: string
  target_content_preview: string
  target_title: string | null
  target_type: string
  direction: 'outgoing' | 'incoming'
}

export interface VersionData {
  id: number
  node_id: string
  version: number
  content: string
  change_reason: string | null
  changed_at: string
}

export interface OperationData {
  id: number
  operation: string
  input_summary: string | null
  context: string | null
  output_node_ids: string | null
  tool: string | null
  session: string | null
  created: string
}

export interface GateStatus {
  node_count: number
  link_count: number
  recall_count: number
  features: Record<string, boolean>
}

// --- 新增类型 ---

export interface TimelineEvent {
  id: number
  type: 'memory' | 'think_associate' | 'think_emerge' | 'output' | 'evolution' | 'config'
  subtype: string
  title: string
  detail: string | null
  node_ids: string | null
  important: number
  actor: 'user' | 'agent' | 'brain'
  created: string
  source: 'timeline' | 'operation' | 'version'
}

export interface DashboardData {
  // 指标卡
  totalMemories: number
  todayDigests: number
  todayNewLinks: number
  todayRecalls: number
  // 各指标近 7 天趋势
  memoryTrend: Array<{ date: string; count: number }>
  digestTrend: Array<{ date: string; count: number }>
  linkTrend: Array<{ date: string; count: number }>
  recallTrend: Array<{ date: string; count: number }>
  // 近期动态
  recentActivity: Array<{
    id: number
    type: string
    subtype: string
    title: string
    node_ids: string | null
    created: string
  }>
  // 近期标签
  recentTags: Array<{
    tag: string
    count: number
    lastActivity: string
    isCore: boolean
  }>
}

export interface UsageData {
  operationsByType: Array<{ operation: string; cnt: number }>
  dailyCounts: Array<{ date: string; operation: string; cnt: number }>
}

export interface TokenUsageData {
  totals: {
    input_tokens: number
    output_tokens: number
    thinking_tokens: number
    estimated_cost: number
    call_count: number
  }
  countByOperation: Array<{ operation: string; cnt: number; cost: number }>
  dailyByModel: Array<{ date: string; model: string; input_tokens: number; output_tokens: number; thinking_tokens: number; estimated_cost: number }>
  dailyByOperation: Array<{ date: string; operation: string; input_tokens: number; output_tokens: number; thinking_tokens: number; estimated_cost: number }>
}

export interface TokenUsageFilteredData {
  operationStats: Array<{
    operation: string
    cnt: number
    input_tokens: number
    output_tokens: number
    thinking_tokens: number
    estimated_cost: number
  }>
  recentLogs: Array<{
    id: number
    model: string
    operation: string
    input_tokens: number
    output_tokens: number
    thinking_tokens: number
    estimated_cost: number
    created: string
  }>
  totalLogs: number
}

export interface GraphNodeData {
  id: string
  type: string
  content: string
  heat: number
  refinement: number
  connectivity: number
  independence: number
  specificity: number
  subjectivity: number
  actuality: number
  is_keystone: number
  is_crystal: number
  is_tag: number
  is_meta: number
}

export interface GraphLinkData {
  id: string
  from_id: string
  to_id: string
  relation: LinkRelation[]
  strength: number
  status: string
}

export interface StructureHole {
  nodeA: string
  nodeB: string
  sharedCount: number
  nodeAPreview: string
  nodeBPreview: string
}

export interface ExplorerFilter {
  search?: string
  type?: string | null
  heatMin?: number
  heatMax?: number
  createdAfter?: string
  createdBefore?: string
  tags?: string
  sortBy?: string
  sortDir?: string
  archived?: boolean
  limit?: number
  offset?: number
}

declare global {
  interface Window {
    api: {
      nodes: {
        list: (filter: ExplorerFilter) => Promise<{ nodes: NodeData[]; total: number }>
        get: (id: string) => Promise<{ node: NodeData; links: LinkData[]; versions: VersionData[] } | null>
        search: (query: string, limit?: number) => Promise<{ nodes: NodeData[]; total: number }>
        tags: () => Promise<Array<{ tag: string; count: number; isCore: boolean }>>
        promoteTag: (tag: string) => Promise<void>
        demoteTag: (tag: string) => Promise<void>
        graph: (filter: ExplorerFilter) => Promise<{ nodes: GraphNodeData[]; links: GraphLinkData[] }>
        path: (fromId: string, toId: string) => Promise<{ path: string[] }>
        structureHoles: (limit?: number) => Promise<StructureHole[]>
      }
      links: {
        rejectTag: (linkId: string) => Promise<{ success: boolean; tagName: string }>
        undoRejectTag: (linkId: string) => Promise<{ success: boolean }>
      }
      stats: {
        overview: () => Promise<{
          totalNodes: number
          byType: Array<{ type: string; cnt: number }>
          byTag: Array<{ tag: string; cnt: number }>
          linkCount: number
          recallCount: number
          recentCounts: Array<{ date: string; count: number }>
          linksByRelation: Array<{ relation: string; cnt: number }>
          linksByStatus: { confirmed: number; pending: number }
          reconsolidateCount: number
          avgVersion: number
        }>
        gates: () => Promise<GateStatus>
        maintenance: () => Promise<{
          lastDaily: string | null
          lastWeekly: string | null
          lastLearning2: string | null
          lastLearning3: string | null
          lastL3ReportId: string | null
        }>
        evolution: () => Promise<{
          learning2_ready: boolean
          learning3_ready: boolean
          nodeCount: number
          recallCount: number
          feedbackCount: number
          feedbackByStrategy: Array<{ strategy: string; avg_signal: number; cnt: number }>
          activeTests: Array<{
            strategy: string
            status: string
            variant_id: string
            testing_operations: number
          }>
        }>
        dashboard: () => Promise<DashboardData>
        usage: () => Promise<UsageData>
        tokenUsage: () => Promise<TokenUsageData>
        tokenUsageFiltered: (filter: { after?: string; before?: string; limit?: number; offset?: number }) => Promise<TokenUsageFilteredData>
      }
      operations: {
        list: (filter: any) => Promise<{ operations: OperationData[]; total: number }>
        get: (id: number) => Promise<{ operation: OperationData; nodes: any[] } | null>
      }
      stream: {
        dates: () => Promise<string[]>
        get: (date: string) => Promise<string>
      }
      config: {
        get: () => Promise<any>
        update: (patch: any) => Promise<void>
        strategies: () => Promise<Array<{ name: string; path: string }>>
        strategyContent: (name: string) => Promise<string>
        strategyUpdate: (name: string, content: string, reason?: string) => Promise<void>
        strategyParams: (name: string) => Promise<Record<string, number | string | boolean>>
        strategyParamUpdate: (name: string, key: string, value: string) => Promise<void>
        strategyVersions: (name: string) => Promise<Array<{ version: number; content: string; change_reason: string | null; changed_by: string; created: string }>>
        strategyRollback: (name: string, version: number) => Promise<void>
        userPromptContent: (name: string) => Promise<string>
        userPromptUpdate: (name: string, content: string, reason?: string) => Promise<void>
        userPromptVersions: (name: string) => Promise<Array<{ version: number; content: string; change_reason: string | null; changed_by: string; created: string }>>
        userPromptRollback: (name: string, version: number) => Promise<void>
        skills: () => Promise<Array<{ name: string; path: string }>>
        skillContent: (name: string) => Promise<string>
        skillUpdate: (name: string, content: string) => Promise<void>
      }
      health: {
        ollama: () => Promise<{ online: boolean; models?: string[] }>
        anthropic: () => Promise<{ configured: boolean }>
        anthropicModels: () => Promise<{ models: string[]; error?: string }>
        vertex: () => Promise<{ configured: boolean; projectId: string; region: string; hasCredentials: boolean }>
        vertexModels: () => Promise<{ models: string[]; error?: string }>
        logseq: () => Promise<{ accessible: boolean; fileCount: number; path: string }>
        geminiEmbedding: () => Promise<{ online: boolean; error?: string }>
        geminiModels: () => Promise<{ models: string[]; error?: string }>
        storage: () => Promise<{ path: string; dbSize: number; streamFiles: number }>
      }
      credentials: {
        pickVertexFile: () => Promise<{ success: boolean; projectId?: string; error?: string }>
        vertexStatus: () => Promise<{ configured: boolean; projectId?: string }>
      }
      embedding: {
        reembedStatus: () => Promise<{ needed: boolean; running: boolean; done: number; total: number }>
        triggerReembed: () => Promise<{ success: boolean; error?: string }>
      }
      write: {
        editNode: (nodeId: string, newContent: string, newTitle: string | null, reason: string) => Promise<{ success: boolean; newVersion?: number; newNodeId?: string; error?: string }>
        archiveNode: (nodeId: string) => Promise<{ success: boolean }>
        deleteLink: (linkId: string) => Promise<{ success: boolean }>
        submitFeedback: (strategyName: string, signal: number) => Promise<{ success: boolean }>
        listArchived: (opts?: { limit?: number; offset?: number }) => Promise<{ nodes: NodeData[]; total: number }>
        unarchiveNode: (nodeId: string) => Promise<{ success: boolean }>
        reArchiveNode: (nodeId: string) => Promise<{ success: boolean }>
      }
      timeline: {
        list: (filter: { types?: string[]; actors?: string[]; limit?: number; offset?: number; after?: string; before?: string }) => Promise<{ events: TimelineEvent[]; total: number }>
        get: (id: number, source: string) => Promise<any>
        resolveNodes: (nodeIds: string[]) => Promise<Record<string, NodeData>>
      }
      export: {
        markdown: (scope: { tag?: string; after?: string; before?: string }) => Promise<string>
        json: (scope: { tag?: string; after?: string; before?: string }) => Promise<any>
      }
      connections: {
        list: (includeArchived?: boolean) => Promise<Array<{
          id: string; name: string; provider_type: string; credentials: string
          status: string; available_models: string | null; last_checked: string | null
          archived: number; created: string
        }>>
        get: (id: string) => Promise<{
          id: string; name: string; provider_type: string; credentials: string
          status: string; available_models: string | null; last_checked: string | null
          archived: number; created: string
        } | null>
        create: (params: { name: string; provider_type: string; credentials?: Record<string, unknown> }) => Promise<{
          id: string; name: string; provider_type: string; credentials: string
          status: string; available_models: string | null; last_checked: string | null
          archived: number; created: string
        }>
        update: (id: string, params: { name?: string; credentials?: Record<string, unknown> }) => Promise<void>
        archive: (id: string) => Promise<void>
        unarchive: (id: string) => Promise<void>
        delete: (id: string) => Promise<void>
        test: (connectionId: string) => Promise<{ online: boolean; models: string[]; error?: string; region?: string }>
        pickVertexFile: (connectionId: string) => Promise<{ success: boolean; projectId?: string; error?: string }>
        vertexCredStatus: (connectionId: string) => Promise<{ configured: boolean; projectId?: string }>
      }
      noteSources: {
        list: (includeArchived?: boolean) => Promise<Array<{
          id: string; name: string; tool_type: string; path: string
          poll_interval: number; archived: number; initialized: number
          created: string; last_synced: string | null
        }>>
        create: (params: { name: string; toolType: string; path: string; pollInterval?: number }) => Promise<{ id: string }>
        update: (id: string, updates: { name?: string; path?: string; pollInterval?: number }) => Promise<void>
        archive: (id: string) => Promise<void>
        unarchive: (id: string) => Promise<void>
        test: (toolType: string, path: string) => Promise<{ accessible: boolean; fileCount: number }>
        stats: (id: string) => Promise<{ fileCount: number; nodeCount: number; lastSynced: string | null; syncing?: boolean; accessible?: boolean }>
        initPreview: (id: string) => Promise<any>
        initStart: (id: string) => Promise<{ success: boolean; data?: any; error?: string }>
        initProgress: (id: string) => Promise<{ phase: number; phaseName: string; current: number; total: number; status: string; error?: string } | null>
        initAbort: (id: string) => Promise<void>
        rollback: (id: string) => Promise<void>
        importStatus: (id: string) => Promise<any>
        triggerImport: (id: string) => Promise<{ success: boolean; error?: string }>
      }
    }
  }
}
