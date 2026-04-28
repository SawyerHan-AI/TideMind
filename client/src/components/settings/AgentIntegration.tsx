import { useState, useCallback } from 'react'
import { Plug, Plus, ChevronRight, RotateCcw, MoreHorizontal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useIPC } from '../../hooks/useIPC'
import { Section } from './shared'
import { useFormatters } from '../../hooks/useFormatters'
import type { Agent, AgentStats } from './agent-integration/types'
import { AgentDetailPanel } from './agent-integration/AgentDetailPanel'
import { AgentWizard } from './agent-integration/AgentWizard'
import { getToolTypeDef, isPluginSupported } from './agent-integration/toolTypes'

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
