import type {
  AgentData,
  CloudStatusData,
  DashboardData,
  ExplorerFilter,
  GateStatus,
  GraphLinkData,
  GraphNodeData,
  LinkData,
  NodeData,
  OperationData,
  StructureHole,
  TimelineEvent,
  TokenUsageData,
  TokenUsageFilteredData,
  UsageData,
  VersionData,
} from './api'

export type PluginClientType = 'claude-code' | 'cowork' | 'cursor' | 'codex' | 'windsurf' | 'openclaw' | 'gemini'

export interface PluginStatusResult {
  exists: boolean
  clientType?: PluginClientType
  pluginDir?: string
  tools?: string[]
  skillFile?: string
  generatedAt?: string
  skillOutdated?: boolean
  skillOutputPath?: string
  skillOutputExists?: boolean
  desktopConfigWritten?: boolean
  cursorConfigWritten?: boolean
  codexConfigWritten?: boolean
  windsurfConfigWritten?: boolean
  openclawConfigWritten?: boolean
  hooksConfigured?: boolean
  skillDirWritten?: boolean
  stagingExists?: boolean
  installedExists?: boolean
  registered?: boolean | null
}

export interface AppApi {
  onDataChanged: (callback: (payload: { scopes: string[] }) => void) => () => void
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
    list: (filter: { limit?: number; offset?: number; operation?: string }) => Promise<{ operations: OperationData[]; total: number }>
    get: (id: number) => Promise<{ operation: OperationData; nodes: NodeData[] } | null>
  }
  stream: {
    dates: () => Promise<string[]>
    get: (date: string) => Promise<string>
  }
  config: {
    get: () => Promise<Record<string, unknown>>
    update: (patch: Record<string, unknown>) => Promise<void>
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
    mcpCommand: () => Promise<string>
    mcpDescriptions: () => Promise<Record<string, string>>
    mcpDescriptionsUpdate: (descriptions: Record<string, string>, changedTool?: string) => Promise<void>
    mcpDescriptionVersions: (toolName: string) => Promise<Array<{ version: number; content: string; change_reason: string | null; changed_by: string; created: string }>>
    mcpDescriptionRollback: (toolName: string, version: number) => Promise<void>
    skills: () => Promise<Array<{ name: string; path: string }>>
    skillContent: (name: string) => Promise<string>
    skillUpdate: (name: string, content: string, reason?: string) => Promise<void>
    skillVersions: (name: string) => Promise<Array<{ version: number; content: string; change_reason: string | null; changed_by: string; created: string }>>
    skillRollback: (name: string, version: number) => Promise<void>
    selectFolder: () => Promise<string | null>
  }
  health: {
    ollama: () => Promise<{ online: boolean; models?: string[] }>
    anthropic: () => Promise<{ configured: boolean }>
    anthropicModels: () => Promise<{ models: string[]; error?: string }>
    vertex: () => Promise<{ configured: boolean; projectId: string; region: string; hasCredentials: boolean }>
    vertexModels: () => Promise<{ models: string[]; error?: string }>
    logseq: () => Promise<{ accessible: boolean; fileCount: number; path: string }>
    obsidian: () => Promise<{ accessible: boolean; fileCount: number; path: string }>
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
    get: (id: number, source: string) => Promise<unknown>
    resolveNodes: (nodeIds: string[]) => Promise<Record<string, NodeData>>
  }
  export: {
    markdown: (scope: { tag?: string; after?: string; before?: string }) => Promise<string>
    json: (scope: { tag?: string; after?: string; before?: string }) => Promise<unknown>
    saveFile: (content: string, defaultName: string) => Promise<{ saved: boolean; path?: string }>
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
    initPreview: (id: string) => Promise<{ success: boolean; data?: {
      totalFiles?: number
      breakdown?: Array<{ label: string; count: number }>
      estimatedNodes?: number
      estimatedCost?: { total: number }
    }; error?: string }>
    initStart: (id: string) => Promise<{ success: boolean; data?: {
      nodesCreated?: number
      linksCreated?: number
      crystalsCreated?: number
      totalFiles?: number
      durationMs?: number
      totalCost?: number
    }; error?: string }>
    initProgress: (id: string) => Promise<{ phase: number; phaseName: string; current: number; total: number; status: string; error?: string } | null>
    initAbort: (id: string) => Promise<void>
    rollback: (id: string) => Promise<void>
    importStatus: (id: string) => Promise<unknown>
    triggerImport: (id: string) => Promise<{ success: boolean; error?: string }>
    appleNotesCheckPermission: () => Promise<{ accessible: boolean; path: string; error?: string }>
    appleNotesListAccounts: () => Promise<Array<{ zpk: number; name: string; uuid: string; userRecordName: string | null; noteCount: number }>>
  }
  cloud: {
    login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
    logout: () => Promise<void>
    status: () => Promise<CloudStatusData>
    setSyncEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string; errorDetail?: string }>
    setMetabolismEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string; errorDetail?: string }>
    forceReconcile: () => Promise<{ success: boolean; error?: string }>
    abortReconcile: () => Promise<{ success: boolean; error?: string }>
    triggerSync: () => Promise<{ success: boolean; error?: string; errorDetail?: string }>
    onReconcileProgress: (cb: (progress: unknown) => void) => () => void
    outboxCount: () => Promise<number>
    loginUrl: () => Promise<string>
    registerUrl: () => Promise<string>
  }
  app: {
    getVersion: () => Promise<string>
    openExternal: (url: string) => Promise<void>
    checkUpdate: () => Promise<{
      hasUpdate: boolean
      currentVersion: string
      latestVersion: string
      releaseUrl: string | null
      releaseNotes: string | null
      publishedAt: string | null
    }>
  }
  agents: {
    list: (includeArchived?: boolean) => Promise<AgentData[]>
    create: (params: { name: string; tool_type: string }) => Promise<AgentData>
    update: (id: string, params: { name?: string; tool_type?: string }) => Promise<void>
    archive: (id: string) => Promise<void>
    delete: (id: string) => Promise<void>
    unarchive: (id: string) => Promise<void>
    stats: () => Promise<Array<{ id: string; digest_count: number; recall_count: number; prepare_count: number }>>
    mcpSnippet: (agentId: string) => Promise<string>
    generatePlugin: (params: { agentId: string; agentName: string; clientType?: string }) => Promise<{ success: boolean; pluginDir: string; pluginName: string; marketplaceRegistered: boolean; pluginsDir?: string; error?: string }>
    checkCli: (cli: string) => Promise<{ available: boolean; path?: string; version?: string }>
    installPlugin: (pluginName: string) => Promise<{ success: boolean; error?: string }>
    pluginPath: (agentId: string, toolType?: string) => Promise<string | null>
    uninstallPlugin: (agentId: string, toolType?: string) => Promise<{ success: boolean; error?: string }>
    pluginStatus: (agentId: string, toolType?: string) => Promise<PluginStatusResult>
  }
}
