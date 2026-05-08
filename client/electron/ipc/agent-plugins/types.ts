export type PluginClientType = 'claude-code' | 'cowork' | 'cursor' | 'codex' | 'windsurf' | 'openclaw' | 'gemini'

export interface ClientTypeConfig {
  dirPrefix: string
  skillSource: string
  skillDescription: string
  hookToolParam: string
}

export const CLIENT_CONFIG: Record<PluginClientType, ClientTypeConfig> = {
  'claude-code': {
    dirPrefix: 'claude-code',
    skillSource: 'claude-code-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统已连接。用户上下文在会话启动时自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'claude-code',
  },
  'cowork': {
    dirPrefix: 'cowork',
    skillSource: 'cowork-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。每次对话开始时调用 brain_prepare 获取用户上下文，使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'cowork',
  },
  'cursor': {
    dirPrefix: 'cursor',
    skillSource: 'cursor-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。每次对话开始时调用 brain_prepare 获取用户上下文，使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'cursor',
  },
  'codex': {
    dirPrefix: 'codex',
    skillSource: 'codex-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。用户上下文在会话启动时通过 SessionStart Hook 自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'codex',
  },
  'windsurf': {
    dirPrefix: 'windsurf',
    skillSource: 'windsurf-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。每次对话开始时调用 brain_prepare 获取用户上下文，使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'windsurf',
  },
  'openclaw': {
    dirPrefix: 'openclaw',
    skillSource: 'openclaw-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。用户上下文在 Agent Bootstrap 时通过 Hook 自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'openclaw',
  },
  'gemini': {
    dirPrefix: 'gemini',
    skillSource: 'gemini-skill.md',
    skillDescription: 'Tide Mind 外部记忆系统。用户上下文在会话启动时通过 SessionStart Hook 自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。',
    hookToolParam: 'gemini',
  },
}

export interface PluginGenerateResult {
  pluginDir: string
  pluginName: string
  marketplaceRegistered: boolean
  /**
   * Marketplace root directory (parent of `.claude-plugin/marketplace.json`).
   * The wizard uses this to render the full install command including the
   * `claude plugin marketplace add` prefix, so users who run it manually
   * don't hit "marketplace not registered" errors. Optional because non-
   * Claude-Code adapters don't have a marketplace.
   */
  pluginsDir?: string
  success: boolean
  error?: string
}

export interface PluginInstallResult {
  success: boolean
  output?: string
  error?: string
}

export interface CliCheckResult {
  available: boolean
  path?: string
  version?: string
}

export interface PluginRuntimeContext {
  dataDir: string
  pluginsDir: string
  skillDir: string
  shimPath: string
  mcpServerPath: string
  hookScriptPath: string
  preCompactScriptPath: string
  postCompactScriptPath: string
  homeDir: string
}

export interface PluginOperationContext {
  runtime: PluginRuntimeContext
  agentId: string
  clientType: PluginClientType
  config: ClientTypeConfig
  pluginName: string
  pluginDirName: string
  pluginDir: string
}

export interface GeneratePluginContext extends PluginOperationContext {
  agentName: string
  skillContent: string
}

export type PluginLookupContext = PluginOperationContext

export type PluginStatusResult = Record<string, unknown> & {
  exists: boolean
}

export interface AgentPluginAdapter {
  clientType: PluginClientType
  generate(ctx: GeneratePluginContext): Promise<PluginGenerateResult>
  getPath(ctx: PluginLookupContext): string | null
  getStatus(ctx: PluginLookupContext): Promise<PluginStatusResult>
  uninstall(ctx: PluginLookupContext): Promise<PluginInstallResult>
  install?(ctx: PluginLookupContext): Promise<PluginInstallResult>
}
