import { contextBridge, ipcRenderer } from 'electron'
import type { AppApi } from '../src/lib/api-contract'

const api: AppApi = {
  /** 监听后端数据变更事件，返回取消监听函数 */
  onDataChanged: (callback: (payload: { scopes: string[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { scopes: string[] }) => callback(payload)
    ipcRenderer.on('data-changed', handler)
    return () => { ipcRenderer.removeListener('data-changed', handler) }
  },
  nodes: {
    list: (filter: any) => ipcRenderer.invoke('nodes:list', filter),
    get: (id: string) => ipcRenderer.invoke('nodes:get', id),
    search: (query: string, limit?: number) => ipcRenderer.invoke('nodes:search', query, limit),
    tags: () => ipcRenderer.invoke('nodes:tags'),
    promoteTag: (tag: string) => ipcRenderer.invoke('nodes:promoteTag', tag),
    demoteTag: (tag: string) => ipcRenderer.invoke('nodes:demoteTag', tag),
    graph: (filter: any) => ipcRenderer.invoke('nodes:graph', filter),
    path: (fromId: string, toId: string) => ipcRenderer.invoke('nodes:path', fromId, toId),
    structureHoles: (limit?: number) => ipcRenderer.invoke('nodes:structureHoles', limit),
  },
  links: {
    rejectTag: (linkId: string) => ipcRenderer.invoke('links:rejectTag', linkId),
    undoRejectTag: (linkId: string) => ipcRenderer.invoke('links:undoRejectTag', linkId),
  },
  stats: {
    overview: () => ipcRenderer.invoke('stats:overview'),
    gates: () => ipcRenderer.invoke('stats:gates'),
    maintenance: () => ipcRenderer.invoke('stats:maintenance'),
    evolution: () => ipcRenderer.invoke('stats:evolution'),
    dashboard: () => ipcRenderer.invoke('stats:dashboard'),
    usage: () => ipcRenderer.invoke('stats:usage'),
    tokenUsage: () => ipcRenderer.invoke('stats:token-usage'),
    tokenUsageFiltered: (filter: { after?: string; before?: string; limit?: number; offset?: number }) => ipcRenderer.invoke('stats:token-usage-filtered', filter),
  },
  operations: {
    list: (filter: any) => ipcRenderer.invoke('operations:list', filter),
    get: (id: number) => ipcRenderer.invoke('operations:get', id),
  },
  stream: {
    dates: () => ipcRenderer.invoke('stream:dates'),
    get: (date: string) => ipcRenderer.invoke('stream:get', date),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    update: (patch: any) => ipcRenderer.invoke('config:update', patch),
    strategies: () => ipcRenderer.invoke('config:strategies'),
    strategyContent: (name: string) => ipcRenderer.invoke('config:strategy', name),
    strategyUpdate: (name: string, content: string, reason?: string) => ipcRenderer.invoke('config:strategy:update', name, content, reason),
    strategyVersions: (name: string) => ipcRenderer.invoke('config:strategy:versions', name),
    strategyRollback: (name: string, version: number) => ipcRenderer.invoke('config:strategy:rollback', name, version),
    strategyParams: (name: string) => ipcRenderer.invoke('config:strategyParams', name),
    strategyParamUpdate: (name: string, key: string, value: string) => ipcRenderer.invoke('config:strategyParamUpdate', name, key, value),
    userPromptContent: (name: string) => ipcRenderer.invoke('config:strategy:user', name),
    userPromptUpdate: (name: string, content: string, reason?: string) => ipcRenderer.invoke('config:strategy:user:update', name, content, reason),
    userPromptVersions: (name: string) => ipcRenderer.invoke('config:strategy:user:versions', name),
    userPromptRollback: (name: string, version: number) => ipcRenderer.invoke('config:strategy:user:rollback', name, version),
    mcpCommand: () => ipcRenderer.invoke('config:mcp-command'),
    mcpDescriptions: () => ipcRenderer.invoke('config:mcp-descriptions'),
    mcpDescriptionsUpdate: (descriptions: Record<string, string>, changedTool?: string) => ipcRenderer.invoke('config:mcp-descriptions:update', descriptions, changedTool),
    mcpDescriptionVersions: (toolName: string) => ipcRenderer.invoke('config:mcp-descriptions:versions', toolName),
    mcpDescriptionRollback: (toolName: string, version: number) => ipcRenderer.invoke('config:mcp-descriptions:rollback', toolName, version),
    skills: () => ipcRenderer.invoke('config:skills'),
    skillContent: (name: string) => ipcRenderer.invoke('config:skill', name),
    skillUpdate: (name: string, content: string, reason?: string) => ipcRenderer.invoke('config:skill:update', name, content, reason),
    skillVersions: (name: string) => ipcRenderer.invoke('config:skill:versions', name),
    skillRollback: (name: string, version: number) => ipcRenderer.invoke('config:skill:rollback', name, version),
    selectFolder: () => ipcRenderer.invoke('config:selectFolder'),
  },
  health: {
    ollama: () => ipcRenderer.invoke('health:ollama'),
    anthropic: () => ipcRenderer.invoke('health:anthropic'),
    anthropicModels: () => ipcRenderer.invoke('health:anthropic-models'),
    vertex: () => ipcRenderer.invoke('health:vertex'),
    vertexModels: () => ipcRenderer.invoke('health:vertex-models'),
    logseq: () => ipcRenderer.invoke('health:logseq'),
    obsidian: () => ipcRenderer.invoke('health:obsidian'),
    geminiEmbedding: () => ipcRenderer.invoke('health:gemini-embedding'),
    geminiModels: () => ipcRenderer.invoke('health:gemini-models'),
    storage: () => ipcRenderer.invoke('health:storage'),
  },
  credentials: {
    pickVertexFile: () => ipcRenderer.invoke('credentials:pick-vertex-file'),
    vertexStatus: () => ipcRenderer.invoke('credentials:vertex-status'),
  },
  embedding: {
    reembedStatus: () => ipcRenderer.invoke('embedding:reembed-status'),
    triggerReembed: () => ipcRenderer.invoke('embedding:trigger-reembed'),
  },
  write: {
    editNode: (nodeId: string, newContent: string, newTitle: string | null, reason: string) => ipcRenderer.invoke('write:editNode', nodeId, newContent, newTitle, reason),
    archiveNode: (nodeId: string) => ipcRenderer.invoke('write:archiveNode', nodeId),
    deleteLink: (linkId: string) => ipcRenderer.invoke('write:deleteLink', linkId),
    submitFeedback: (strategyName: string, signal: number) => ipcRenderer.invoke('write:submitFeedback', strategyName, signal),
    listArchived: (opts?: { limit?: number; offset?: number }) => ipcRenderer.invoke('write:listArchived', opts),
    unarchiveNode: (nodeId: string) => ipcRenderer.invoke('write:unarchiveNode', nodeId),
    reArchiveNode: (nodeId: string) => ipcRenderer.invoke('write:reArchiveNode', nodeId),
  },
  timeline: {
    list: (filter: any) => ipcRenderer.invoke('timeline:list', filter),
    get: (id: number, source: string) => ipcRenderer.invoke('timeline:get', id, source),
    resolveNodes: (nodeIds: string[]) => ipcRenderer.invoke('timeline:resolve-nodes', nodeIds),
  },
  export: {
    markdown: (scope: any) => ipcRenderer.invoke('export:markdown', scope),
    json: (scope: any) => ipcRenderer.invoke('export:json', scope),
    saveFile: (content: string, defaultName: string) => ipcRenderer.invoke('export:save-file', content, defaultName),
  },
  noteSources: {
    list: (includeArchived?: boolean) => ipcRenderer.invoke('note-sources:list', includeArchived),
    create: (params: { name: string; toolType: string; path: string; pollInterval?: number }) => ipcRenderer.invoke('note-sources:create', params),
    update: (id: string, updates: { name?: string; path?: string; pollInterval?: number }) => ipcRenderer.invoke('note-sources:update', id, updates),
    archive: (id: string) => ipcRenderer.invoke('note-sources:archive', id),
    unarchive: (id: string) => ipcRenderer.invoke('note-sources:unarchive', id),
    test: (toolType: string, path: string) => ipcRenderer.invoke('note-sources:test', toolType, path),
    stats: (id: string) => ipcRenderer.invoke('note-sources:stats', id),
    initPreview: (id: string) => ipcRenderer.invoke('note-sources:init-preview', id),
    initStart: (id: string) => ipcRenderer.invoke('note-sources:init-start', id),
    initProgress: (id: string) => ipcRenderer.invoke('note-sources:init-progress', id),
    initAbort: (id: string) => ipcRenderer.invoke('note-sources:init-abort', id),
    rollback: (id: string) => ipcRenderer.invoke('note-sources:rollback', id),
    importStatus: (id: string) => ipcRenderer.invoke('note-sources:import-status', id),
    triggerImport: (id: string) => ipcRenderer.invoke('note-sources:trigger-import', id),
    appleNotesCheckPermission: () => ipcRenderer.invoke('note-sources:apple-notes-check-permission'),
    appleNotesListAccounts: () => ipcRenderer.invoke('note-sources:apple-notes-list-accounts'),
  },
  connections: {
    list: (includeArchived?: boolean) => ipcRenderer.invoke('connections:list', includeArchived),
    get: (id: string) => ipcRenderer.invoke('connections:get', id),
    create: (params: { name: string; provider_type: string; credentials?: Record<string, unknown> }) => ipcRenderer.invoke('connections:create', params),
    update: (id: string, params: { name?: string; credentials?: Record<string, unknown> }) => ipcRenderer.invoke('connections:update', id, params),
    archive: (id: string) => ipcRenderer.invoke('connections:archive', id),
    unarchive: (id: string) => ipcRenderer.invoke('connections:unarchive', id),
    delete: (id: string) => ipcRenderer.invoke('connections:delete', id),
    test: (connectionId: string) => ipcRenderer.invoke('connections:test', connectionId),
    pickVertexFile: (connectionId: string) => ipcRenderer.invoke('connections:pick-vertex-file', connectionId),
    vertexCredStatus: (connectionId: string) => ipcRenderer.invoke('connections:vertex-cred-status', connectionId),
  },
  cloud: {
    login: (email: string, password: string) => ipcRenderer.invoke('cloud:login', email, password),
    logout: () => ipcRenderer.invoke('cloud:logout'),
    status: () => ipcRenderer.invoke('cloud:status'),
    setSyncEnabled: (enabled: boolean) => ipcRenderer.invoke('cloud:set-sync-enabled', enabled),
    setMetabolismEnabled: (enabled: boolean) => ipcRenderer.invoke('cloud:set-metabolism-enabled', enabled),
    forceReconcile: () => ipcRenderer.invoke('cloud:force-reconcile'),
    abortReconcile: () => ipcRenderer.invoke('cloud:abort-reconcile'),
    triggerSync: () => ipcRenderer.invoke('cloud:trigger-sync'),
    // reconcile 进度事件订阅
    onReconcileProgress: (cb: (p: unknown) => void) => {
      const listener = (_ev: unknown, p: unknown) => cb(p);
      ipcRenderer.on('reconcile-progress', listener);
      return () => ipcRenderer.off('reconcile-progress', listener);
    },
    outboxCount: () => ipcRenderer.invoke('cloud:outbox-count'),
    loginUrl: () => ipcRenderer.invoke('cloud:login-url'),
    registerUrl: () => ipcRenderer.invoke('cloud:register-url'),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  },
  agents: {
    list: (includeArchived?: boolean) => ipcRenderer.invoke('agents:list', includeArchived),
    create: (params: { name: string; tool_type: string }) => ipcRenderer.invoke('agents:create', params),
    update: (id: string, params: { name?: string; tool_type?: string }) => ipcRenderer.invoke('agents:update', id, params),
    archive: (id: string) => ipcRenderer.invoke('agents:archive', id),
    delete: (id: string) => ipcRenderer.invoke('agents:delete', id),
    unarchive: (id: string) => ipcRenderer.invoke('agents:unarchive', id),
    stats: () => ipcRenderer.invoke('agents:stats'),
    mcpSnippet: (agentId: string) => ipcRenderer.invoke('agents:mcp-snippet', agentId),
    generatePlugin: (params: { agentId: string; agentName: string; clientType?: string }) => ipcRenderer.invoke('agents:generate-plugin', params),
    checkCli: (cli: string) => ipcRenderer.invoke('agents:check-cli', cli),
    installPlugin: (pluginName: string) => ipcRenderer.invoke('agents:install-plugin', pluginName),
    pluginPath: (agentId: string, toolType?: string) => ipcRenderer.invoke('agents:plugin-path', agentId, toolType),
    uninstallPlugin: (agentId: string, toolType?: string) => ipcRenderer.invoke('agents:uninstall-plugin', agentId, toolType),
    pluginStatus: (agentId: string, toolType?: string) => ipcRenderer.invoke('agents:plugin-status', agentId, toolType),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ApiType = AppApi
