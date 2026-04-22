import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plug, Plus, ChevronRight, ChevronLeft, Copy, Check,
  CheckCircle, XCircle, Loader2, X, Archive, RotateCcw,
  MoreHorizontal, Pencil, Package, Terminal, FolderOpen, Trash2,
  RefreshCw, AlertTriangle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useIPC } from '../../hooks/useIPC'
import { Section, inputClass } from './shared'
import { useFormatters } from '../../hooks/useFormatters'

// ============================================================
// 工具类型定义 + 配置路径提示
// ============================================================

interface ToolTypeDef {
  id: string
  label: string
  configPathKey: string
  skillPathKey: string
  /** 支持插件化安装 */
  pluginSupport: boolean
  /** 即将支持（置灰不可选） */
  comingSoon?: boolean
}

const TOOL_TYPES: ToolTypeDef[] = [
  { id: 'claude-code', label: 'Claude Code', configPathKey: 'agent.toolConfigPath.claudeCode', skillPathKey: 'agent.toolSkillPath.claudeCode', pluginSupport: true },
  { id: 'cowork', label: 'Claude Cowork', configPathKey: 'agent.toolConfigPath.cowork', skillPathKey: 'agent.toolSkillPath.cowork', pluginSupport: true },
  { id: 'cursor', label: 'Cursor', configPathKey: 'agent.toolConfigPath.cursor', skillPathKey: 'agent.toolSkillPath.cursor', pluginSupport: true },
  { id: 'codex', label: 'Codex', configPathKey: 'agent.toolConfigPath.codex', skillPathKey: 'agent.toolSkillPath.codex', pluginSupport: true },
  { id: 'windsurf', label: 'Windsurf', configPathKey: 'agent.toolConfigPath.windsurf', skillPathKey: 'agent.toolSkillPath.windsurf', pluginSupport: true },
  { id: 'openclaw', label: 'OpenClaw', configPathKey: 'agent.toolConfigPath.openclaw', skillPathKey: 'agent.toolSkillPath.openclaw', pluginSupport: true },
]

function getToolTypeDef(toolType: string): ToolTypeDef | undefined {
  return TOOL_TYPES.find(item => item.id === toolType)
}

function isPluginSupported(toolType: string): boolean {
  return getToolTypeDef(toolType)?.pluginSupport ?? false
}

/** Codex ≥0.121 支持 `codex mcp add` 和原生 Skills 机制（v2 主路径） */
function isCodexV2Version(version: string | null | undefined): boolean {
  if (!version) return false
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major > 0) return true
  return minor >= 121
}

// ============================================================
// Agent 类型
// ============================================================

interface Agent {
  id: string
  name: string
  tool_type: string
  archived: number
  last_active: string | null
  created: string
}

interface AgentStats {
  id: string
  digest_count: number
  recall_count: number
  prepare_count: number
}

// ============================================================
// 主组件
// ============================================================

export function AgentIntegration() {
  const { t } = useTranslation('settings')
  const { timeAgo } = useFormatters()
  const { data: agents, refetch: refetchAgents } = useIPC(() => window.api.agents.list(true))
  const { data: agentStats, refetch: refetchStats } = useIPC(() => window.api.agents.stats())

  const [wizardOpen, setWizardOpen] = useState(false)
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const refetchAll = useCallback(() => {
    refetchAgents()
    refetchStats()
  }, [refetchAgents, refetchStats])

  const activeAgents = (agents ?? []).filter((a: Agent) => !a.archived)
  const archivedAgents = (agents ?? []).filter((a: Agent) => a.archived)

  const getStats = (agentId: string): AgentStats | undefined => {
    return (agentStats ?? []).find((s: AgentStats) => s.id === agentId)
  }

  const getStatusInfo = (agent: Agent) => {
    if (!agent.last_active) return { color: 'bg-gray-600', textColor: 'text-gray-500', label: t('agent.status.notConnected') }
    const hoursSince = (Date.now() - new Date(agent.last_active).getTime()) / (1000 * 60 * 60)
    if (hoursSince < 24 * 7) return { color: 'bg-emerald-400', textColor: 'text-emerald-400', label: t('agent.status.active') }
    return { color: 'bg-yellow-500', textColor: 'text-yellow-500', label: t('agent.status.inactive') }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* 已配置 Agent */}
      <Section title={t('agent.configuredAgents')}>
        <p className="text-xs text-gray-500 mb-4">
          {t('agent.description')}
        </p>

        {activeAgents.length === 0 && !wizardOpen && (
          <div className="py-8 text-center text-xs text-gray-500">
            {t('agent.empty')}
          </div>
        )}

        {activeAgents.length > 0 && (
          <div className="space-y-0.5">
            {/* Table header */}
            <div className="flex items-center gap-4 px-3 py-2 text-[11px] text-gray-500 font-medium border-b border-white/5">
              <span className="w-40">{t('agent.table.name')}</span>
              <span className="w-24">{t('agent.table.toolType')}</span>
              <span className="w-16">{t('agent.table.status')}</span>
              <span className="w-28">{t('agent.table.lastActive')}</span>
              <span className="w-20 text-right">{t('agent.table.digestCount')}</span>
              <span className="w-12"></span>
            </div>

            {activeAgents.map((agent: Agent) => {
              const status = getStatusInfo(agent)
              const stats = getStats(agent.id)
              const isExpanded = expandedAgent === agent.id

              return (
                <div key={agent.id}>
                  <button
                    onClick={() => setExpandedAgent(isExpanded ? null : agent.id)}
                    className="w-full flex items-center gap-4 px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors text-left"
                  >
                    <div className="w-40 flex items-center gap-2">
                      <Plug size={14} className="text-gray-500 flex-shrink-0" />
                      <span className="text-xs text-gray-200 font-medium truncate">{agent.name}</span>
                    </div>
                    <span className="w-24 text-xs text-gray-400">
                      {getToolTypeDef(agent.tool_type)?.label ?? agent.tool_type}
                    </span>
                    <div className="w-16 flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${status.color}`} />
                      <span className={`text-xs ${status.textColor}`}>{status.label}</span>
                    </div>
                    <span className="w-28 text-xs text-gray-400 tabular-nums">
                      {agent.last_active ? timeAgo(agent.last_active) : '-'}
                    </span>
                    <span className="w-20 text-xs text-gray-400 text-right tabular-nums">
                      {stats?.digest_count ? t('agent.countSuffix', { count: stats.digest_count }) : '-'}
                    </span>
                    <span className="w-12 flex justify-end">
                      <MoreHorizontal size={14} className="text-gray-500" />
                    </span>
                  </button>

                  {isExpanded && (
                    <AgentDetailPanel agent={agent} onRefetch={refetchAll} />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 已归档 */}
        {archivedAgents.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ChevronRight size={12} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
              {t('agent.archived')} ({archivedAgents.length})
            </button>
            {showArchived && (
              <div className="mt-2 space-y-0.5 pl-2 border-l border-white/5">
                {archivedAgents.map((agent: Agent) => (
                  <div key={agent.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                    <div className="flex items-center gap-2">
                      <Plug size={14} className="text-gray-600" />
                      <span className="text-xs text-gray-500">{agent.name}</span>
                      <span className="text-[10px] text-gray-600">
                        {getToolTypeDef(agent.tool_type)?.label ?? agent.tool_type}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          await window.api.agents.unarchive(agent.id)
                          refetchAll()
                        }}
                        className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        <RotateCcw size={10} />
                        {t('agent.restore')}
                      </button>
                      {confirmDelete === agent.id ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-red-400">{t('agent.confirmDeleteQuestion')}</span>
                          <button
                            onClick={async () => {
                              if (isPluginSupported(agent.tool_type)) {
                                await window.api.agents.uninstallPlugin(agent.id, agent.tool_type)
                              }
                              await window.api.agents.delete(agent.id)
                              setConfirmDelete(null)
                              refetchAll()
                            }}
                            className="text-[10px] text-red-400 hover:text-red-300 font-medium"
                          >
                            {t('agent.confirm')}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="text-[10px] text-gray-500 hover:text-gray-300"
                          >
                            {t('agent.cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(agent.id)}
                          className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={10} />
                          {t('agent.delete')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* 配置新 Agent */}
      {!wizardOpen ? (
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-gray-300 transition-colors border border-white/5"
        >
          <Plus size={14} />
          {t('agent.newAgent')}
        </button>
      ) : (
        <AgentWizard
          onClose={() => {
            setWizardOpen(false)
            refetchAll()
          }}
        />
      )}
    </div>
  )
}

// ============================================================
// Agent 详情面板（展开后显示）
// ============================================================

function AgentDetailPanel({ agent, onRefetch }: { agent: Agent; onRefetch: () => void }) {
  const { t } = useTranslation('settings')
  const { formatShortDate } = useFormatters()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(agent.name)
  const [mcpSnippet, setMcpSnippet] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [skillContent, setSkillContent] = useState('')
  const [skillLoaded, setSkillLoaded] = useState(false)
  const [pluginDir, setPluginDir] = useState<string | null>(null)
  const [pluginStatus, setPluginStatus] = useState<any>(null)
  const [regenerating, setRegenerating] = useState(false)

  const isPlugin = isPluginSupported(agent.tool_type)
  const isCowork = agent.tool_type === 'cowork'
  const isCursor = agent.tool_type === 'cursor'
  const isCodex = agent.tool_type === 'codex'
  const isWindsurf = agent.tool_type === 'windsurf'
  const isOpenClaw = agent.tool_type === 'openclaw'
  const pluginInstallCmd = `claude plugin install tidemind-${agent.id}@tidemind-local --scope user`

  const loadPluginStatus = () => {
    window.api.agents.pluginStatus(agent.id, agent.tool_type).then(s => setPluginStatus(s))
    window.api.agents.pluginPath(agent.id, agent.tool_type).then(p => setPluginDir(p))
  }

  useEffect(() => {
    if (isPlugin) {
      loadPluginStatus()
    } else {
      window.api.agents.mcpSnippet(agent.id).then(s => setMcpSnippet(JSON.stringify(s, null, 2)))
    }
  }, [agent.id, isPlugin])

  useEffect(() => {
    if (!isPlugin) {
      window.api.config.skillContent(agent.tool_type).then(c => {
        if (c) {
          setSkillContent(c)
        } else {
          window.api.config.skillContent('base-skill').then(bc => setSkillContent(bc))
        }
        setSkillLoaded(true)
      })
    }
  }, [agent.tool_type, isPlugin])

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(null), 2000)
  }

  const handleRename = async () => {
    if (name.trim() && name !== agent.name) {
      await window.api.agents.update(agent.id, { name: name.trim() })
      onRefetch()
    }
    setEditing(false)
  }

  const handleArchive = async () => {
    await window.api.agents.archive(agent.id)
    onRefetch()
  }

  const toolDef = getToolTypeDef(agent.tool_type)

  return (
    <div className="mx-3 mb-2 p-4 bg-white/[0.02] rounded-lg border border-white/5 space-y-4">
      {/* 基本信息 + 操作 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleRename()}
                className={`${inputClass} w-40 text-xs`}
                autoFocus
              />
              <button onClick={handleRename} className="text-emerald-400 hover:text-emerald-300">
                <Check size={14} />
              </button>
              <button onClick={() => { setEditing(false); setName(agent.name) }} className="text-gray-500 hover:text-gray-300">
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-gray-100 transition-colors"
            >
              <Pencil size={11} />
              {t('agent.rename')}
            </button>
          )}
        </div>
        <button
          onClick={handleArchive}
          className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-orange-400 transition-colors"
        >
          <Archive size={11} />
          {t('agent.archive')}
        </button>
      </div>

      {/* Agent ID */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-gray-500">Agent ID:</span>
        <code className="text-[10px] text-gray-400 bg-white/5 px-1.5 py-0.5 rounded font-mono">{agent.id}</code>
      </div>

      {/* 插件模式：显示插件状态 */}
      {isPlugin && (
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Package size={12} className="text-gray-400" />
            <span className="text-[11px] text-gray-400 font-medium">{toolDef?.label ?? 'Plugin'} {t('agent.plugin')}</span>
          </div>
          {pluginDir ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg">
                <CheckCircle size={12} className="text-emerald-400 flex-shrink-0" />
                <span className="text-[10px] text-emerald-400">{t('agent.pluginGenerated')}</span>
              </div>

              {/* Skill 文件 + 工具列表 + 生成时间 */}
              {pluginStatus?.exists && (
                <div className="px-3 py-2 bg-white/[0.02] border border-white/5 rounded-lg space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 w-16">Skill:</span>
                    <code className="text-[10px] text-gray-300 font-mono">{pluginStatus.skillFile}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 w-16">{t('agent.tools')}:</span>
                    <div className="flex gap-1 flex-wrap">
                      {pluginStatus.tools?.map((item: string) => (
                        <span key={item} className="text-[9px] text-gray-400 bg-white/5 px-1.5 py-0.5 rounded font-mono">{item}</span>
                      ))}
                    </div>
                  </div>
                  {pluginStatus.generatedAt && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-500 w-16">{t('agent.generatedAt')}:</span>
                      <span className="text-[10px] text-gray-400">{formatShortDate(pluginStatus.generatedAt)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Skill 过期提示 + 重新生成 */}
              {pluginStatus?.skillOutdated && (
                <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg">
                  <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
                  <span className="text-[10px] text-amber-400">{t('agent.skillOutdatedHint')}</span>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    setRegenerating(true)
                    try {
                      await window.api.agents.generatePlugin({ agentId: agent.id, agentName: agent.name, clientType: agent.tool_type })
                      loadPluginStatus()
                    } finally {
                      setRegenerating(false)
                    }
                  }}
                  disabled={regenerating}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-gray-300 hover:text-gray-100 transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={11} className={regenerating ? 'animate-spin' : ''} />
                  {regenerating ? t('agent.regenerating') : t('agent.regeneratePlugin')}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>
              {isCowork ? (
                <div className="space-y-1.5">
                  {pluginStatus?.skillOutputExists && (
                    <div className="flex items-center gap-2">
                      <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                      <code className="text-[10px] text-gray-400 font-mono truncate">{pluginStatus.skillOutputPath}</code>
                    </div>
                  )}
                  <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-indigo-400">
                      {t('agent.detail.coworkMcpHint')}
                    </p>
                    <p className="text-[10px] text-indigo-400">
                      {t('agent.detail.coworkSkillHint')}
                    </p>
                  </div>
                </div>
              ) : isCursor ? (
                <div className="space-y-1.5">
                  {pluginStatus?.skillOutputExists && (
                    <div className="flex items-center gap-2">
                      <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                      <code className="text-[10px] text-gray-400 font-mono truncate">{pluginStatus.skillOutputPath}</code>
                    </div>
                  )}
                  <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-indigo-400">
                      {t('agent.detail.cursorMcpHint')}
                    </p>
                    <p className="text-[10px] text-indigo-400">
                      {t('agent.detail.cursorSkillHint')}
                    </p>
                  </div>
                </div>
              ) : isCodex ? (
                <div className="space-y-1.5">
                  {pluginStatus?.skillOutputExists && (
                    <div className="flex items-center gap-2">
                      <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                      <code className="text-[10px] text-gray-400 font-mono truncate">{pluginStatus.skillOutputPath}</code>
                    </div>
                  )}
                  <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-indigo-400">
                      {t('agent.detail.codexMcpHint')}
                    </p>
                    <p className="text-[10px] text-indigo-400">
                      {t('agent.detail.codexSkillHint')}
                    </p>
                  </div>
                </div>
              ) : isWindsurf ? (
                <div className="space-y-1.5">
                  {pluginStatus?.skillOutputExists && (
                    <div className="flex items-center gap-2">
                      <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                      <code className="text-[10px] text-gray-400 font-mono truncate">{pluginStatus.skillOutputPath}</code>
                    </div>
                  )}
                  <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-blue-400">
                      {t('agent.detail.windsurfMcpHint')}
                    </p>
                    <p className="text-[10px] text-blue-400">
                      {t('agent.detail.windsurfSkillHint')}
                    </p>
                  </div>
                </div>
              ) : isOpenClaw ? (
                <div className="space-y-1.5">
                  {pluginStatus?.skillOutputExists && (
                    <div className="flex items-center gap-2">
                      <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                      <code className="text-[10px] text-gray-400 font-mono truncate">{pluginStatus.skillOutputPath}</code>
                    </div>
                  )}
                  <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-blue-400">
                      {t('agent.detail.openclawMcpHint')}
                    </p>
                    <p className="text-[10px] text-blue-400">
                      {t('agent.detail.openclawSkillHint')}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="relative">
                  <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg">
                    <Terminal size={11} className="text-gray-400 flex-shrink-0" />
                    <code className="text-[10px] text-gray-300 font-mono">
                      {pluginInstallCmd}
                    </code>
                  </div>
                  <button
                    onClick={() => handleCopy(pluginInstallCmd, 'install-cmd')}
                    className="absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors"
                  >
                    {copied === 'install-cmd' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg">
              <p className="text-[10px] text-amber-400">
                {t('agent.pluginNotGenerated')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* 手动配置模式：MCP 配置 + Skill */}
      {!isPlugin && (
        <>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] text-gray-400 font-medium">{t('agent.mcpConfig')}</span>
              {toolDef && (
                <span className="text-[10px] text-gray-500">
                  {t('agent.copyTo')} <code className="text-gray-400">{t(toolDef.configPathKey)}</code>
                </span>
              )}
            </div>
            <div className="relative">
              <pre className="px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg text-[11px] text-gray-300 font-mono overflow-x-auto leading-relaxed max-h-32 overflow-y-auto">
                {mcpSnippet}
              </pre>
              <button
                onClick={() => handleCopy(mcpSnippet, 'mcp')}
                className="absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors"
              >
                {copied === 'mcp' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
              </button>
            </div>
          </div>

          {skillLoaded && skillContent && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-gray-400 font-medium">{t('agent.skillFile')}</span>
                {toolDef && (
                  <span className="text-[10px] text-gray-500">
                    {t('agent.copyTo')} <code className="text-gray-400">{t(toolDef.skillPathKey)}</code>
                  </span>
                )}
              </div>
              <div className="relative">
                <pre className="px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg text-[11px] text-gray-300 font-mono overflow-x-auto leading-relaxed max-h-32 overflow-y-auto">
                  {skillContent.slice(0, 500)}{skillContent.length > 500 ? '\n...' : ''}
                </pre>
                <button
                  onClick={() => handleCopy(skillContent, 'skill')}
                  className="absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {copied === 'skill' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {t('agent.skillHint')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================
// 配置向导
// ============================================================

function AgentWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('settings')
  const [step, setStep] = useState(0)
  const [agentName, setAgentName] = useState('')
  const [toolType, setToolType] = useState('')
  const [customToolType, setCustomToolType] = useState('')
  const [usingBaseFallback, setUsingBaseFallback] = useState(false)
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const wizardCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 手动流程用的状态
  const [mcpSnippet, setMcpSnippet] = useState('')
  const [skillContent, setSkillContent] = useState('')
  const [skillLoaded, setSkillLoaded] = useState(false)

  // 插件流程用的状态
  const [pluginDir, setPluginDir] = useState('')
  const [pluginName, setPluginName] = useState('')
  const [pluginGenerating, setPluginGenerating] = useState(false)
  const [pluginGenerated, setPluginGenerated] = useState(false)
  const [pluginError, setPluginError] = useState('')
  const [marketplaceRegistered, setMarketplaceRegistered] = useState(false)
  const [cliAvailable, setCliAvailable] = useState(false)
  const [codexVersion, setCodexVersion] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(null)
  // Claude Cowork 专用状态
  // packagePath 已移除：Claude Cowork 不再打包 .plugin，改为生成 Skill .md 文件
  const [desktopConfigWritten, setDesktopConfigWritten] = useState(false)

  const effectiveToolType = toolType === 'other' ? customToolType : toolType
  const toolDef = getToolTypeDef(effectiveToolType)
  const usePlugin = isPluginSupported(effectiveToolType)
  const isCowork = effectiveToolType === 'cowork'
  const isCursor = effectiveToolType === 'cursor'
  const isCodex = effectiveToolType === 'codex'
  const isWindsurf = effectiveToolType === 'windsurf'
  const isOpenClaw = effectiveToolType === 'openclaw'
  const isManual = !usePlugin  // "其他"工具走手动配置流程

  // 根据流程类型决定步骤
  const stepLabels = usePlugin
    ? isCowork
      ? [t('agent.wizard.nameAgent'), t('agent.wizard.configCowork'), t('agent.wizard.verify')]
      : isCursor
        ? [t('agent.wizard.nameAgent'), t('agent.wizard.configCursor'), t('agent.wizard.verify')]
        : isCodex
          ? [t('agent.wizard.nameAgent'), t('agent.wizard.configCodex'), t('agent.wizard.verify')]
          : isWindsurf
            ? [t('agent.wizard.nameAgent'), t('agent.wizard.configWindsurf'), t('agent.wizard.verify')]
            : isOpenClaw
              ? [t('agent.wizard.nameAgent'), t('agent.wizard.configOpenClaw'), t('agent.wizard.verify')]
              : [t('agent.wizard.nameAgent'), t('agent.wizard.installPlugin'), t('agent.wizard.verify')]
    : [t('agent.wizard.nameAgent'), t('agent.wizard.mcpConfig'), t('agent.wizard.skillFile'), t('agent.wizard.verify')]

  // 选择工具类型后自动填充名称
  useEffect(() => {
    if (toolType && toolType !== 'other' && !agentName) {
      const def = getToolTypeDef(toolType)
      if (def) setAgentName(def.label)
    }
  }, [toolType, agentName])

  // Step 0 → Step 1: 创建 Agent
  const [creating, setCreating] = useState(false)
  const handleCreateAndNext = async () => {
    const finalToolType = effectiveToolType
    if (!agentName.trim() || !finalToolType.trim() || creating) return
    setCreating(true)

    const agent = await window.api.agents.create({ name: agentName.trim(), tool_type: finalToolType.trim() })
    setCreatedAgent(agent)

    if (usePlugin) {
      // 插件流程：
      // Claude Code: 生成 Plugin + marketplace + CLI 安装
      // Claude Cowork: 写入 Desktop config + 生成 Skill 到 Downloads
      setPluginGenerating(true)
      try {
        const [result, cliCheck, codexCheck] = await Promise.all([
          window.api.agents.generatePlugin({ agentId: agent.id, agentName: agent.name, clientType: finalToolType }),
          window.api.agents.checkCli('claude'),
          isCodex
            ? window.api.agents.checkCli('codex')
            : Promise.resolve({ available: false } as { available: boolean; path?: string; version?: string }),
        ])
        if (result.success) {
          setPluginDir(result.pluginDir)
          setPluginName(result.pluginName)
          setPluginGenerated(true)
          setMarketplaceRegistered(result.marketplaceRegistered)
          if (isCowork || isCursor || isCodex || isWindsurf || isOpenClaw) {
            setDesktopConfigWritten(true)
          }
        } else {
          setPluginError(result.error ?? t('agent.wizard.generateFailed'))
          await window.api.agents.delete(agent.id)
          setCreatedAgent(null)
        }
        setCliAvailable(cliCheck.available)
        setCodexVersion(codexCheck.version ?? null)
      } catch (err: any) {
        setPluginError(err.message)
        await window.api.agents.delete(agent.id)
        setCreatedAgent(null)
      } finally {
        setPluginGenerating(false)
      }
    } else {
      // 手动流程：获取 MCP snippet
      const snippet = await window.api.agents.mcpSnippet(agent.id)
      setMcpSnippet(JSON.stringify(snippet, null, 2))
    }

    setStep(1)
  }

  // 插件安装（通过 marketplace）
  const handleInstallPlugin = async () => {
    if (!pluginName) return
    setInstalling(true)
    try {
      const result = await window.api.agents.installPlugin(pluginName)
      setInstallResult({
        success: result.success,
        message: result.success ? t('agent.wizard.installSuccess') : (result.error ?? t('agent.wizard.installFailed')),
      })
    } catch (err: any) {
      setInstallResult({ success: false, message: err.message })
    } finally {
      setInstalling(false)
    }
  }

  const installCommand = pluginName
    ? `claude plugin install ${pluginName}@tidemind-local --scope user`
    : ''

  // Load skill content (手动流程)
  useEffect(() => {
    if (!usePlugin && step === 2 && !skillLoaded) {
      const skillName = effectiveToolType || 'base-skill'
      window.api.config.skillContent(skillName).then(c => {
        if (!c) {
          setUsingBaseFallback(true)
          window.api.config.skillContent('base-skill').then(bc => {
            setSkillContent(bc)
            setSkillLoaded(true)
          })
        } else {
          setUsingBaseFallback(skillName === 'base-skill')
          setSkillContent(c)
          setSkillLoaded(true)
        }
      })
    }
  }, [step, skillLoaded, effectiveToolType, usePlugin])

  useEffect(() => {
    return () => {
      if (wizardCopiedTimerRef.current) clearTimeout(wizardCopiedTimerRef.current)
    }
  }, [])

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    if (wizardCopiedTimerRef.current) clearTimeout(wizardCopiedTimerRef.current)
    wizardCopiedTimerRef.current = setTimeout(() => setCopied(null), 2000)
  }

  // 验证步骤的 index
  const verifyStep = usePlugin ? 2 : 3

  return (
    <Section
      title={t('agent.newAgent')}
      action={<button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors"><X size={16} /></button>}
    >
      {/* 步骤条 */}
      <div className="flex items-center gap-1 mb-4">
        {(effectiveToolType || step > 0) ? stepLabels.map((label, i) => (
          <div key={i} className="flex items-center">
            <div className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium ${
              i === step ? 'bg-indigo-400/20 text-indigo-400' :
              i < step ? 'text-emerald-400' : 'text-gray-500'
            }`}>
              {i < step ? <Check size={10} /> : <span>{i + 1}</span>}
              {label}
            </div>
            {i < stepLabels.length - 1 && (
              <ChevronRight size={12} className="text-gray-600 mx-0.5" />
            )}
          </div>
        )) : (
          <span className="text-[10px] text-gray-500">{t('agent.wizard.selectToolHint')}</span>
        )}
      </div>

      {/* Step 0: 命名 + 选择工具类型 */}
      {step === 0 && (
        <div className="space-y-4">
          <div>
            <label className="text-[11px] text-gray-400 mb-1.5 block">{t('agent.table.toolType')}</label>
            <div className="grid grid-cols-4 gap-2">
              {TOOL_TYPES.map(item => (
                <button
                  key={item.id}
                  onClick={() => {
                    if (item.comingSoon) return
                    setToolType(item.id)
                    if (!agentName || TOOL_TYPES.some(tt => tt.label === agentName)) {
                      setAgentName(item.label)
                    }
                  }}
                  disabled={item.comingSoon}
                  className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                    item.comingSoon
                      ? 'bg-white/[0.01] border-white/5 text-gray-600 cursor-not-allowed'
                      : toolType === item.id
                        ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                        : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'
                  }`}
                >
                  <span className="flex items-center gap-1">
                    {item.label}
                    {item.comingSoon && <span className="text-[9px] text-gray-600">{t('agent.wizard.comingSoon')}</span>}
                    {!item.comingSoon && item.pluginSupport && <Package size={10} className="opacity-50" />}
                  </span>
                </button>
              ))}
              <button
                onClick={() => {
                  setToolType('other')
                  if (!customToolType) {
                    setCustomToolType(`custom-${Math.random().toString(36).slice(2, 6)}`)
                  }
                }}
                className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                  toolType === 'other'
                    ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                    : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'
                }`}
              >
                {t('agent.wizard.other')}
              </button>
            </div>
            {usePlugin && (
              <p className="text-[10px] text-emerald-400/70 mt-1.5 flex items-center gap-1">
                <Package size={10} />
                {t('agent.wizard.pluginSupportHint')}
              </p>
            )}
          </div>

          <div>
            <label className="text-[11px] text-gray-400 mb-1.5 block">{t('agent.wizard.agentName')}</label>
            <input
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              placeholder={t('agent.wizard.agentNamePlaceholder')}
              className={`${inputClass} w-full text-xs`}
            />
            <p className="text-[10px] text-gray-500 mt-1">
              {t('agent.wizard.agentNameHint')}
            </p>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleCreateAndNext}
              disabled={!agentName.trim() || !effectiveToolType.trim() || creating}
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? t('agent.wizard.creating') : t('agent.wizard.createAndContinue')}
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* 插件流程 Step 1: 安装插件 */}
      {/* ========================================== */}
      {step === 1 && usePlugin && createdAgent && (
        <div className="space-y-3">
          {pluginGenerating ? (
            <div className="flex items-center gap-2 py-8 justify-center text-xs text-gray-500">
              <Loader2 size={14} className="animate-spin" />
              {t('agent.wizard.generatingPlugin')}
            </div>
          ) : pluginError ? (
            <div className="px-3 py-2 bg-red-500/5 border border-red-500/10 rounded-lg">
              <p className="text-[10px] text-red-400">{t('agent.wizard.pluginGenerateFailed')}:{pluginError}</p>
            </div>
          ) : pluginGenerated ? (
            <>
              {/* 生成成功 */}
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg">
                <CheckCircle size={12} className="text-emerald-400 flex-shrink-0" />
                <span className="text-xs text-emerald-400">{t('agent.pluginGenerated')}</span>
              </div>

              {/* 插件包含的内容 */}
              <div className="px-3 py-2 bg-white/[0.02] border border-white/5 rounded-lg space-y-1.5">
                <p className="text-[10px] text-gray-400 font-medium">{t('agent.wizard.completed')}:</p>
                {isCowork ? (
                  <>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.cowork.skillFile')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      {desktopConfigWritten
                        ? <CheckCircle size={10} className="text-emerald-400/60" />
                        : <XCircle size={10} className="text-red-400/60" />}
                      {t('agent.wizard.cowork.desktopMcpConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.cowork.skillDownloaded')}
                    </div>
                  </>
                ) : isCursor ? (
                  <>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      {desktopConfigWritten
                        ? <CheckCircle size={10} className="text-emerald-400/60" />
                        : <XCircle size={10} className="text-red-400/60" />}
                      {t('agent.wizard.cursor.mcpConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.cursor.skillDownloaded')}
                    </div>
                  </>
                ) : isCodex ? (
                  <>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      {desktopConfigWritten
                        ? <CheckCircle size={10} className="text-emerald-400/60" />
                        : <XCircle size={10} className="text-red-400/60" />}
                      {t('agent.wizard.codex.mcpConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.codex.hookConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {isCodexV2Version(codexVersion)
                        ? t('agent.wizard.codex.skillInjected')
                        : t('agent.wizard.codex.agentsDownloaded')}
                    </div>
                  </>
                ) : isWindsurf ? (
                  <>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      {desktopConfigWritten
                        ? <CheckCircle size={10} className="text-emerald-400/60" />
                        : <XCircle size={10} className="text-red-400/60" />}
                      {t('agent.wizard.windsurf.mcpConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.windsurf.rulesDownloaded')}
                    </div>
                  </>
                ) : isOpenClaw ? (
                  <>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      {desktopConfigWritten
                        ? <CheckCircle size={10} className="text-emerald-400/60" />
                        : <XCircle size={10} className="text-red-400/60" />}
                      {t('agent.wizard.openclaw.mcpConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.openclaw.hookConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.openclaw.skillDownloaded')}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.claudeCode.mcpConfig')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.claudeCode.skillFile')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <CheckCircle size={10} className="text-emerald-400/60" />
                      {t('agent.wizard.claudeCode.hooks')}
                    </div>
                  </>
                )}
              </div>

              {/* 插件路径 */}
              <div className="flex items-center gap-2">
                <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
              </div>

              {/* 安装方式 */}
              {isCowork ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                    <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
                  </div>
                  <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-indigo-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                    <p className="text-[10px] text-indigo-400">{t('agent.wizard.cowork.step1')}</p>
                    <p className="text-[10px] text-indigo-400">{t('agent.wizard.cowork.step2')}</p>
                    <p className="text-[10px] text-indigo-400">{t('agent.wizard.cowork.step3')}</p>
                  </div>
                </div>
              ) : isCursor ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                    <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
                  </div>
                  <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-indigo-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                    <p className="text-[10px] text-indigo-400">{t('agent.wizard.cursor.step1')}</p>
                    <p className="text-[10px] text-indigo-400">{t('agent.wizard.cursor.step2')}</p>
                    <p className="text-[10px] text-gray-500">{t('agent.wizard.cursor.mcpNote')}</p>
                  </div>
                </div>
              ) : isCodex ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                    <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
                  </div>
                  {isCodexV2Version(codexVersion) ? (
                    <div className="px-3 py-2 bg-emerald-400/5 border border-emerald-400/10 rounded-lg space-y-1">
                      <p className="text-[10px] text-emerald-400 font-medium">{t('agent.wizard.codex.autoReadyTitle')}</p>
                      <p className="text-[10px] text-emerald-400">{t('agent.wizard.codex.autoReadyNote')}</p>
                    </div>
                  ) : (
                    <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg space-y-1">
                      <p className="text-[10px] text-indigo-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                      <p className="text-[10px] text-indigo-400">{t('agent.wizard.codex.step1')}</p>
                      <p className="text-[10px] text-indigo-400">{t('agent.wizard.codex.step2')}</p>
                      <p className="text-[10px] text-gray-500">{t('agent.wizard.codex.mcpNote')}</p>
                      {codexVersion && (
                        <p className="text-[10px] text-amber-400 mt-1">
                          {t('agent.wizard.codex.upgradeHint', { version: codexVersion })}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : isWindsurf ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                    <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
                  </div>
                  <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-blue-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                    <p className="text-[10px] text-blue-400">{t('agent.wizard.windsurf.step1')}</p>
                    <p className="text-[10px] text-blue-400">{t('agent.wizard.windsurf.step2')}</p>
                    <p className="text-[10px] text-gray-500">{t('agent.wizard.windsurf.mcpNote')}</p>
                  </div>
                </div>
              ) : isOpenClaw ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                    <code className="text-[10px] text-gray-400 font-mono truncate">{pluginDir}</code>
                  </div>
                  <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-1">
                    <p className="text-[10px] text-blue-400 font-medium">{t('agent.wizard.manualStepsTitle')}</p>
                    <p className="text-[10px] text-blue-400">{t('agent.wizard.openclaw.step1')}</p>
                    <p className="text-[10px] text-blue-400">{t('agent.wizard.openclaw.step2')}</p>
                    <p className="text-[10px] text-gray-500">{t('agent.wizard.openclaw.mcpNote')}</p>
                  </div>
                </div>
              ) : cliAvailable ? (
                <div className="space-y-2">
                  <button
                    onClick={handleInstallPlugin}
                    disabled={installing || installResult?.success}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {installing ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        {t('agent.wizard.installing')}
                      </>
                    ) : installResult?.success ? (
                      <>
                        <CheckCircle size={14} />
                        {t('agent.wizard.installed')}
                      </>
                    ) : (
                      <>
                        <Package size={14} />
                        {t('agent.wizard.oneClickInstall')}
                      </>
                    )}
                  </button>
                  {installResult && !installResult.success && (
                    <div className="px-3 py-2 bg-red-500/5 border border-red-500/10 rounded-lg">
                      <p className="text-[10px] text-red-400">{installResult.message}</p>
                      <p className="text-[10px] text-gray-500 mt-1">{t('agent.wizard.manualInstallHint')}</p>
                    </div>
                  )}
                  {/* 始终显示手动命令作为 fallback */}
                  <div className="relative">
                    <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg">
                      <Terminal size={11} className="text-gray-500 flex-shrink-0" />
                      <code className="text-[10px] text-gray-400 font-mono">
                        {installCommand}
                      </code>
                    </div>
                    <button
                      onClick={() => handleCopy(installCommand, 'install')}
                      className="absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      {copied === 'install' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg">
                    <p className="text-[10px] text-amber-400">
                      {t('agent.wizard.cliNotDetected')}
                    </p>
                  </div>
                  <div className="relative">
                    <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg">
                      <Terminal size={11} className="text-gray-400 flex-shrink-0" />
                      <code className="text-[10px] text-gray-300 font-mono">
                        {installCommand}
                      </code>
                    </div>
                    <button
                      onClick={() => handleCopy(installCommand, 'install')}
                      className="absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      {copied === 'install' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setStep(0)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              <ChevronLeft size={14} />
              {t('agent.wizard.prevStep')}
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={!pluginGenerated}
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('agent.wizard.nextStep')}
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* 手动流程 Step 1: MCP 配置 */}
      {/* ========================================== */}
      {step === 1 && !usePlugin && createdAgent && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            {toolDef ? (
              <>{t('agent.wizard.addConfigTo')} <code className="text-gray-300 bg-white/5 px-1 py-0.5 rounded">{t(toolDef.configPathKey)}</code>:</>
            ) : (
              <>{t('agent.wizard.addConfigGeneric')}</>
            )}
          </p>
          <div className="relative">
            <pre className="px-4 py-3 bg-white/[0.03] border border-white/5 rounded-lg text-xs text-gray-300 font-mono overflow-x-auto leading-relaxed">
              {mcpSnippet}
            </pre>
            <button
              onClick={() => handleCopy(mcpSnippet, 'mcp')}
              className="absolute top-2 right-2 p-1.5 bg-white/5 hover:bg-white/10 rounded-md text-gray-400 hover:text-gray-200 transition-colors"
            >
              {copied === 'mcp' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
          </div>
          <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg">
            <p className="text-[10px] text-indigo-400">
              {t('agent.wizard.mcpConfigHint')}
            </p>
          </div>
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setStep(0)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              <ChevronLeft size={14} />
              {t('agent.wizard.prevStep')}
            </button>
            <button
              onClick={() => setStep(2)}
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors"
            >
              {t('agent.wizard.nextStep')}
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* 手动流程 Step 2: Skill 文件 */}
      {/* ========================================== */}
      {step === 2 && !usePlugin && createdAgent && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            {toolDef ? (
              <>{t('agent.wizard.copySkillTo')} <code className="text-gray-300 bg-white/5 px-1 py-0.5 rounded">{t(toolDef.skillPathKey)}</code>:</>
            ) : (
              <>{t('agent.wizard.copySkillGeneric')}</>
            )}
          </p>
          {!skillLoaded ? (
            <div className="flex items-center gap-2 py-8 justify-center text-xs text-gray-500">
              <Loader2 size={14} className="animate-spin" />
              {t('agent.wizard.loading')}
            </div>
          ) : (
            <>
              <div className="relative">
                <pre className="px-4 py-3 bg-white/[0.03] border border-white/5 rounded-lg text-xs text-gray-300 font-mono overflow-x-auto leading-relaxed max-h-56 overflow-y-auto">
                  {skillContent}
                </pre>
                <button
                  onClick={() => handleCopy(skillContent, 'skill')}
                  className="absolute top-2 right-2 p-1.5 bg-white/5 hover:bg-white/10 rounded-md text-gray-400 hover:text-gray-200 transition-colors"
                >
                  {copied === 'skill' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                </button>
              </div>
              <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg">
                <p className="text-[10px] text-amber-400">
                  {t('agent.wizard.skillHint')}
                </p>
              </div>
              {usingBaseFallback && (
                <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg">
                  <p className="text-[10px] text-blue-400">
                    {t('agent.wizard.baseFallbackHint')}
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  <ChevronLeft size={14} />
                  {t('agent.wizard.prevStep')}
                </button>
                <button
                  onClick={() => setStep(3)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors"
                >
                  {t('agent.wizard.nextStep')}
                  <ChevronRight size={14} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ========================================== */}
      {/* 验证步骤（两种流程共用） */}
      {/* ========================================== */}
      {step === verifyStep && createdAgent && (
        <div className="space-y-4">
          <p className="text-xs text-gray-400">{t('agent.wizard.verifyDescription')}</p>
          <div className="space-y-2">
            <VerifyItem
              ok={true}
              label={t('agent.wizard.verifyAgentCreated', { name: createdAgent.name, id: createdAgent.id })}
            />
            {usePlugin && (
              <VerifyItem
                ok={pluginGenerated}
                label={t('agent.wizard.verifyPluginGenerated', { tool: isCowork ? 'Claude Cowork' : isCursor ? 'Cursor' : isCodex ? 'Codex' : isWindsurf ? 'Windsurf' : isOpenClaw ? 'OpenClaw' : 'Claude Code' })}
              />
            )}
            {isCowork && (
              <VerifyItem
                ok={desktopConfigWritten}
                label={t('agent.wizard.verifyDesktopMcp')}
                hint={!desktopConfigWritten ? t('agent.wizard.verifyDesktopMcpHintNeeded') : t('agent.wizard.verifyDesktopMcpHintDone')}
              />
            )}
            {isCursor && (
              <VerifyItem
                ok={desktopConfigWritten}
                label={t('agent.wizard.verifyCursorMcp')}
                hint={desktopConfigWritten ? t('agent.wizard.verifyCursorMcpHintOk') : t('agent.wizard.verifyCursorMcpHintFail')}
              />
            )}
            {isCodex && (
              <VerifyItem
                ok={desktopConfigWritten}
                label={t('agent.wizard.verifyCodexMcp')}
                hint={desktopConfigWritten ? t('agent.wizard.verifyCodexMcpHintOk') : t('agent.wizard.verifyCodexMcpHintFail')}
              />
            )}
            {isWindsurf && (
              <VerifyItem
                ok={desktopConfigWritten}
                label={t('agent.wizard.verifyWindsurfMcp')}
                hint={desktopConfigWritten ? t('agent.wizard.verifyWindsurfMcpHintOk') : t('agent.wizard.verifyWindsurfMcpHintFail')}
              />
            )}
            {isOpenClaw && (
              <VerifyItem
                ok={desktopConfigWritten}
                label={t('agent.wizard.verifyOpenClawMcp')}
                hint={desktopConfigWritten ? t('agent.wizard.verifyOpenClawMcpHintOk') : t('agent.wizard.verifyOpenClawMcpHintFail')}
              />
            )}
            {isManual && (
              <>
                <VerifyItem
                  ok={false}
                  label={t('agent.wizard.verifyMcpAdded')}
                  hint={t('agent.wizard.verifyMcpAddedHint')}
                />
                <VerifyItem
                  ok={false}
                  label={t('agent.wizard.verifySkillCopied')}
                  hint={t('agent.wizard.verifySkillCopiedHint')}
                />
                <VerifyItem
                  ok={false}
                  label={t('agent.wizard.verifyToolRestarted')}
                />
              </>
            )}
            <VerifyItem
              ok={!!createdAgent.last_active}
              label={t('agent.wizard.verifyFirstConnection')}
              hint={!createdAgent.last_active ? t('agent.wizard.verifyFirstConnectionHint') : undefined}
            />
          </div>
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setStep(usePlugin ? 1 : 2)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              <ChevronLeft size={14} />
              {t('agent.wizard.prevStep')}
            </button>
            <button
              onClick={onClose}
              className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium text-white transition-colors"
            >
              <CheckCircle size={14} />
              {t('agent.wizard.finish')}
            </button>
          </div>
        </div>
      )}
    </Section>
  )
}

// ============================================================
// 验证项
// ============================================================

function VerifyItem({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-white/[0.02] rounded-lg">
      {ok ? (
        <CheckCircle size={14} className="text-emerald-400 mt-0.5 flex-shrink-0" />
      ) : (
        <XCircle size={14} className="text-gray-500 mt-0.5 flex-shrink-0" />
      )}
      <div>
        <span className={`text-xs ${ok ? 'text-gray-200' : 'text-gray-400'}`}>{label}</span>
        {hint && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}
      </div>
    </div>
  )
}
