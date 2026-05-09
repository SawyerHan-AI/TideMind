import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, ChevronRight, History, Loader2, RotateCcw, Save } from 'lucide-react'
import { useFormatters } from '../../../hooks/useFormatters'

// ============================================================
// EmbeddedStrategyPanel
// ============================================================

interface StrategyVersion {
  version: number
  content: string
  change_reason: string | null
  changed_by: string
  created: string
}

function extractTemplateParams(text: string): string[] {
  const matches = text.matchAll(/\{\{(\w+)\}\}/g)
  return [...new Set([...matches].map(m => m[1]))]
}

export function EmbeddedStrategyPanel({ name, type = 'system', locked }: { name: string; type?: 'system' | 'user'; locked?: boolean }) {
  const { t } = useTranslation('settings')
  const { formatShortDate } = useFormatters()
  const isUser = type === 'user'
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showReason, setShowReason] = useState(false)
  const [reason, setReason] = useState('')
  const [versions, setVersions] = useState<StrategyVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<StrategyVersion | null>(null)
  const [showVersions, setShowVersions] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const api = window.api.config

  const loadContent = useCallback(async () => {
    const c = isUser ? await api.userPromptContent(name) : await api.strategyContent(name)
    setContent(c)
    setOriginalContent(c)
  }, [name, isUser])

  const loadVersions = useCallback(async () => {
    try {
      const v = isUser ? await api.userPromptVersions(name) : await api.strategyVersions(name)
      setVersions(Array.isArray(v) ? (v as StrategyVersion[]) : [])
    } catch { setVersions([]) }
  }, [name, isUser])

  useEffect(() => {
    setLoaded(false)
    Promise.all([loadContent(), loadVersions()]).then(() => setLoaded(true)).catch(() => setLoaded(true))
    setSelectedVersion(null)
    setPromptExpanded(false)
  }, [name, isUser])

  const hasChanges = content !== originalContent

  const handleSave = async () => {
    if (showReason) {
      setSaving(true)
      try {
        if (isUser) {
          await api.userPromptUpdate(name, content, reason || undefined)
        } else {
          await api.strategyUpdate(name, content, reason || undefined)
        }
        setSaved(true)
        setShowReason(false)
        setReason('')
        setOriginalContent(content)
        loadVersions()
        setTimeout(() => setSaved(false), 2000)
      } finally {
        setSaving(false)
      }
    } else {
      setShowReason(true)
    }
  }

  const handleRollback = async (version: number) => {
    try {
      if (isUser) {
        await api.userPromptRollback(name, version)
      } else {
        await api.strategyRollback(name, version)
      }
      await loadContent()
      await loadVersions()
      setSelectedVersion(null)
    } catch (err) { console.error('Rollback failed:', err) }
  }

  // User Prompt: 文件不存在且无版本历史时隐藏面板
  if (isUser && loaded && !content && versions.length === 0) return null

  const displayText = selectedVersion
    ? (selectedVersion.content || t('strategy.contentNotRecorded'))
    : content
  const templateParams = isUser ? extractTemplateParams(displayText) : []
  const label = isUser ? 'User Prompt' : 'System Prompt'

  return (
    <div className="space-y-2">
      {/* Prompt 折叠头 */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setPromptExpanded(!promptExpanded)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          {promptExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {label}: {name}
          {locked && !isUser && <span className="text-[10px] text-amber-400/70 ml-1">{t('strategy.autoEvolutionManaged')}</span>}
        </button>
        <button
          onClick={() => { setShowVersions(!showVersions); if (!showVersions) { loadVersions(); setPromptExpanded(true) } }}
          className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
            showVersions ? 'text-indigo-400 bg-indigo-400/10' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <History size={11} />
          {t('strategy.versionHistory')}
        </button>
      </div>

      {promptExpanded && (
        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            <textarea
              value={displayText}
              onChange={e => { if (!selectedVersion) setContent(e.target.value) }}
              readOnly={!!selectedVersion}
              rows={12}
              placeholder={isUser ? t('strategy.userPromptPlaceholder') : undefined}
              className={`w-full px-4 py-3 bg-white/5 border rounded-xl text-sm text-gray-200 font-mono leading-relaxed resize-y focus:outline-none ${
                selectedVersion ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 focus:border-indigo-400/50'
              }`}
            />

            {/* User Prompt 参数标签 */}
            {isUser && templateParams.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <span className="text-[10px] text-gray-500">{t('strategy.params')}</span>
                {templateParams.map(p => (
                  <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-400/10 text-indigo-400 font-mono">
                    {`{{${p}}}`}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between mt-2">
              {selectedVersion ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-amber-400">{t('strategy.previewVersion', { version: selectedVersion.version })}</span>
                  <button onClick={() => setSelectedVersion(null)} className="text-[11px] text-gray-400 hover:text-white transition-colors">{t('strategy.returnToEdit')}</button>
                </div>
              ) : showReason ? (
                <div className="flex items-center gap-2 flex-1 mr-3">
                  <input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('strategy.changeReason')}
                    className="flex-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50"
                    autoFocus onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setShowReason(false); setReason('') } }} />
                </div>
              ) : <div />}
              <div className="flex items-center gap-2">
                {selectedVersion && (
                  <button onClick={() => handleRollback(selectedVersion.version)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors">
                    <RotateCcw size={12} /> {t('strategy.rollbackToVersion')}
                  </button>
                )}
                {!selectedVersion && (
                  <button onClick={handleSave} disabled={saving || (!hasChanges && !showReason)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <CheckCircle size={12} /> : <Save size={12} />}
                    {saved ? t('strategy.saved') : showReason ? t('strategy.confirmSave') : t('strategy.save')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {showVersions && (
            <div className="w-48 flex-shrink-0 overflow-y-auto max-h-80 border-l border-white/5 pl-3">
              <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-2">{t('strategy.versionHistory')}</div>
              {versions.length === 0 ? (
                <p className="text-[11px] text-gray-600 py-2">{t('strategy.noVersions')}</p>
              ) : (
                <div className="space-y-1">
                  {versions.map(v => (
                    <button key={v.version} onClick={() => setSelectedVersion(selectedVersion?.version === v.version ? null : v)}
                      className={`w-full text-left px-2 py-2 rounded-md transition-colors ${
                        selectedVersion?.version === v.version ? 'bg-amber-500/10 border border-amber-500/20' : 'hover:bg-white/[0.03] border border-transparent'
                      }`}>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-gray-300 font-mono">v{v.version}</span>
                        <span className={`text-[9px] px-1 py-0.5 rounded ${
                          v.changed_by === 'user' ? 'text-indigo-300 bg-indigo-400/10' : v.changed_by === 'learning2' ? 'text-indigo-300 bg-indigo-400/10' : v.changed_by === 'file_edit' ? 'text-indigo-300 bg-indigo-400/10' : 'text-indigo-300 bg-indigo-400/10'
                        }`}>{t(`strategy.changedBy.${v.changed_by}`, v.changed_by)}</span>
                      </div>
                      {v.change_reason && <p className="text-[10px] text-gray-500 mt-0.5 truncate">{v.change_reason}</p>}
                      <p className="text-[9px] text-gray-600 mt-0.5">{formatShortDate(v.created)}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
