import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Archive, Check, CheckCircle, Copy, FolderOpen, Package, Pencil, RefreshCw, Terminal, X } from 'lucide-react'
import { useFormatters } from '../../../hooks/useFormatters'
import { inputClass } from '../shared'
import type { Agent } from './types'
import { getToolTypeDef, isPluginSupported } from './toolTypes'
import type { PluginStatusResult } from '../../../lib/api-contract'

// Agent 详情面板（展开后显示）
// ============================================================

export function AgentDetailPanel({ agent, onRefetch }: { agent: Agent; onRefetch: () => void }) {
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
  const [pluginStatus, setPluginStatus] = useState<PluginStatusResult | null>(null)
  const [regenerating, setRegenerating] = useState(false)

  const isPlugin = isPluginSupported(agent.tool_type)
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
  const pluginDetail = toolDef?.pluginDetail
  const pluginDetailToneClass = pluginDetail?.tone === 'emerald'
    ? 'bg-emerald-500/5 border-emerald-500/10 text-emerald-400'
    : pluginDetail?.tone === 'blue'
      ? 'bg-blue-500/5 border-blue-500/10 text-blue-400'
      : 'bg-indigo-400/5 border-indigo-400/10 text-indigo-400'

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
              {pluginDetail ? (
                <div className="space-y-1.5">
                  {pluginDetail.showSkillOutput && pluginStatus?.skillOutputExists && pluginStatus.skillOutputPath && (
                    <div className="flex items-center gap-2">
                      <FolderOpen size={11} className="text-gray-500 flex-shrink-0" />
                      <code className="text-[10px] text-gray-400 font-mono truncate">{pluginStatus.skillOutputPath}</code>
                    </div>
                  )}
                  <div className={`px-3 py-2 border rounded-lg space-y-1 ${pluginDetailToneClass}`}>
                    {pluginDetail.hintKeys.map(key => (
                      <p key={key} className="text-[10px]">
                        {t(key)}
                      </p>
                    ))}
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
