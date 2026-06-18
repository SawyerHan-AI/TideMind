import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useFormatters } from '../../hooks/useFormatters'
import { motion } from 'framer-motion'
import { Save, CheckCircle, Loader2, FileText, ChevronRight, History, Lock, RotateCcw } from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { AgentIntegration } from './AgentIntegration'
import { NoteSync } from './NoteSync'

// ============================================================
// External Integration: Agent 对接 / 笔记同步 / 工具接口
// ============================================================

type SubTab = 'agent' | 'note' | 'tools'
const SUB_TAB_KEYS: SubTab[] = ['agent', 'note', 'tools']

function parseSubTab(value: string | undefined): SubTab | null {
  return value && SUB_TAB_KEYS.includes(value as SubTab) ? value as SubTab : null
}

export function ExternalIntegration({ initialSub }: { initialSub?: string } = {}) {
  const { t } = useTranslation('settings')
  const [subTab, setSubTab] = useState<SubTab>(() => parseSubTab(initialSub) ?? 'agent')

  useEffect(() => {
    setSubTab(parseSubTab(initialSub) ?? 'agent')
  }, [initialSub])

  const SUB_TABS: { key: SubTab; label: string }[] = [
    { key: 'agent', label: t('external.subtabs.agent') },
    { key: 'note', label: t('external.subtabs.noteSync') },
    { key: 'tools', label: t('external.subtabs.tools') },
  ]

  return (
    <div className="space-y-4">
      {/* Sub-tab switcher */}
      <div className="flex items-center gap-2">
        {SUB_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setSubTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
              subTab === tab.key ? 'text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'
            }`}
            style={subTab === tab.key ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <motion.div
        key={subTab}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        {subTab === 'agent' && <AgentIntegration />}
        {subTab === 'note' && <NoteSync />}
        {subTab === 'tools' && <ToolInterface />}
      </motion.div>
    </div>
  )
}

// ============================================================
// 工具接口：左右分栏 — 列表 + 详情/版本历史
// ============================================================

type ToolItem = { type: 'mcp'; name: string; labelKey: string; hintKey: string }
  | { type: 'skill'; name: string }

const MCP_TOOLS: ToolItem[] = [
  { type: 'mcp', name: 'brain_prepare', labelKey: 'external.tools.prepare', hintKey: 'external.tools.prepareHint' },
  { type: 'mcp', name: 'brain_recall', labelKey: 'external.tools.recall', hintKey: 'external.tools.recallHint' },
  { type: 'mcp', name: 'brain_digest', labelKey: 'external.tools.digest', hintKey: 'external.tools.digestHint' },
]

interface VersionEntry {
  version: number
  content: string
  change_reason: string | null
  changed_by: string
  created: string
}

function ToolInterface() {
  const { t } = useTranslation('settings')
  const fetchSkills = useCallback(() => window.api.config.skills(), [])
  const { data: skills } = useIPC(fetchSkills)
  const [selected, setSelected] = useState<ToolItem | null>(null)

  // 构建完整列表
  const skillItems: ToolItem[] = (skills ?? []).map((s: any) => ({ type: 'skill' as const, name: s.name }))

  // 自动选择第一个
  useEffect(() => {
    if (!selected) {
      setSelected(MCP_TOOLS[0])
    }
  }, [])

  return (
    <div className="flex gap-4 items-start">
      {/* 左侧列表 */}
      <div className="w-52 flex-shrink-0 space-y-4">
        {/* MCP 工具 */}
        <div>
          <div className="px-1 mb-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider">
            {t('external.mcpTools')}
          </div>
          <div className="glass-card rounded-xl overflow-hidden">
            {MCP_TOOLS.map(tool => {
              const active = selected?.name === tool.name && selected?.type === 'mcp'
              return (
                <button
                  key={tool.name}
                  onClick={() => setSelected(tool)}
                  className={`w-full text-left px-3 py-2.5 border-b border-white/5 last:border-b-0 transition-colors ${
                    active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <span className={`text-xs font-medium ${active ? 'text-gray-100' : 'text-gray-400'}`}>
                    {tool.name}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Skill 文件 */}
        {skillItems.length > 0 && (
          <div>
            <div className="px-1 mb-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider">
              {t('external.skillFiles')}
            </div>
            <div className="glass-card rounded-xl overflow-hidden">
              {skillItems.map(item => {
                const active = selected?.name === item.name && selected?.type === 'skill'
                return (
                  <button
                    key={item.name}
                    onClick={() => setSelected(item)}
                    className={`w-full text-left px-3 py-2.5 border-b border-white/5 last:border-b-0 transition-colors ${
                      active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <span className={`text-xs font-medium ${active ? 'text-gray-100' : 'text-gray-400'}`}>
                      {item.name}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* 右侧详情 — mt-5 对齐左侧卡片顶部（跳过标题行高度） */}
      <div className="flex-1 min-w-0 mt-5">
        {selected ? (
          selected.type === 'mcp'
            ? <McpDetailPanel key={selected.name} tool={selected} />
            : <SkillDetailPanel key={selected.name} name={selected.name} />
        ) : (
          <div className="glass-card rounded-xl p-8 text-center text-gray-500 text-sm">
            {t('external.selectToView')}
          </div>
        )}
      </div>
    </div>
  )
}

// --- MCP 工具详情面板 ---

function McpDetailPanel({ tool }: { tool: Extract<ToolItem, { type: 'mcp' }> }) {
  const { t } = useTranslation('settings')
  const [description, setDescription] = useState('')
  const [originalDescription, setOriginalDescription] = useState('')
  const [allDescriptions, setAllDescriptions] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [selectedVersion, setSelectedVersion] = useState<VersionEntry | null>(null)
  const [showVersions, setShowVersions] = useState(true)

  // 修复 M32(2026-05-09):用 cancelled flag 防止快速切换条目时旧请求覆盖
  // 新条目的数据。原代码无 cancellation,先选 A 后选 B 时,A 的 mcpDescriptions
  // / mcpDescriptionVersions 响应可能晚到把 B 的状态污染。
  useEffect(() => {
    let cancelled = false
    setSelectedVersion(null)
    window.api.config.mcpDescriptions().then((d: Record<string, string>) => {
      if (cancelled) return
      setAllDescriptions(d)
      setDescription(d[tool.name] ?? '')
      setOriginalDescription(d[tool.name] ?? '')
    })
    void loadVersionsWithCancel(() => cancelled)
    return () => { cancelled = true }
  }, [tool.name])

  const loadVersionsWithCancel = async (isCancelled: () => boolean) => {
    try {
      const v = await window.api.config.mcpDescriptionVersions(tool.name)
      if (isCancelled()) return
      setVersions(Array.isArray(v) ? (v as VersionEntry[]) : [])
    } catch {
      if (!isCancelled()) setVersions([])
    }
  }

  const loadVersions = async () => {
    try {
      const v = await window.api.config.mcpDescriptionVersions(tool.name)
      setVersions(Array.isArray(v) ? (v as VersionEntry[]) : [])
    } catch { setVersions([]) }
  }

  const hasChanges = description !== originalDescription

  const handleSave = async () => {
    setSaving(true)
    setSaveError(false)
    try {
      const updated = { ...allDescriptions, [tool.name]: description }
      await window.api.config.mcpDescriptionsUpdate(updated, tool.name)
      setAllDescriptions(updated)
      setSaved(true)
      setOriginalDescription(description)
      loadVersions()
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      {/* 标题区 */}
      <div className="px-5 py-4 border-b border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-base font-medium text-gray-100 font-mono">{tool.name}</span>
            <span className="text-xs text-gray-500">{t(tool.labelKey)}</span>
          </div>
          <button
            onClick={() => setShowVersions(!showVersions)}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
              showVersions ? 'text-indigo-400 bg-indigo-400/10' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <History size={11} />
            {t('external.versionHistory')}
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mt-1">{t(tool.hintKey)}{t('external.mcpRestartNote')}</p>
      </div>

      {/* 编辑区 */}
      <div className="px-5 py-3">
        <div className="flex gap-3">
          <div className="flex-1 flex flex-col min-w-0">
            <textarea
              value={selectedVersion ? selectedVersion.content : description}
              onChange={e => { if (!selectedVersion) setDescription(e.target.value) }}
              readOnly={!!selectedVersion}
              rows={10}
              className={`w-full px-4 py-3 bg-white/5 border rounded-xl text-sm text-gray-200 font-mono leading-relaxed resize-none focus:outline-none ${
                selectedVersion ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 focus:border-indigo-400/50'
              }`}
            />

            <div className="flex items-center justify-between mt-3">
              {selectedVersion ? (
                <span className="text-[11px] text-amber-400">
                  {t('external.versionPreview', { version: selectedVersion.version })}
                  <button onClick={() => setSelectedVersion(null)} className="ml-2 text-gray-400 hover:text-white">{t('external.returnToEdit')}</button>
                </span>
              ) : <div />}
              {!selectedVersion && (
                <div className="flex items-center gap-3">
                  {saveError && (
                    <span className="text-[11px] text-red-400">{t('external.saveFailed')}</span>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={saving || !hasChanges}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <CheckCircle size={14} /> : <Save size={14} />}
                    {saved ? t('common:actions.saved') : t('common:actions.save')}
                  </button>
                </div>
              )}
            </div>
          </div>

          {showVersions && <VersionTimeline versions={versions} selectedVersion={selectedVersion} onSelect={setSelectedVersion} />}
        </div>
      </div>
    </div>
  )
}

// --- Skill 详情面板 ---

function SkillDetailPanel({ name }: { name: string }) {
  const { t } = useTranslation('settings')
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [showReason, setShowReason] = useState(false)
  const [reason, setReason] = useState('')
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [selectedVersion, setSelectedVersion] = useState<VersionEntry | null>(null)
  const [showVersions, setShowVersions] = useState(true)

  const loadContent = useCallback(async () => {
    const c = await window.api.config.skillContent(name)
    setContent(c)
    setOriginalContent(c)
  }, [name])

  const loadVersions = useCallback(async () => {
    try {
      const v = await window.api.config.skillVersions(name)
      setVersions(Array.isArray(v) ? (v as VersionEntry[]) : [])
    } catch { setVersions([]) }
  }, [name])

  // 修复 M32:同 MCP 面板,加 cancelled flag 防止快速切换条目时旧请求覆盖
  useEffect(() => {
    let cancelled = false
    setSelectedVersion(null)
    void (async () => {
      const c = await window.api.config.skillContent(name)
      if (cancelled) return
      setContent(c)
      setOriginalContent(c)
    })()
    void (async () => {
      try {
        const v = await window.api.config.skillVersions(name)
        if (cancelled) return
        setVersions(Array.isArray(v) ? (v as VersionEntry[]) : [])
      } catch {
        if (!cancelled) setVersions([])
      }
    })()
    return () => { cancelled = true }
  }, [name])

  const hasChanges = content !== originalContent

  const handleSave = async () => {
    if (showReason) {
      setSaving(true)
      setSaveError(false)
      try {
        await window.api.config.skillUpdate(name, content, reason || undefined)
        setSaved(true)
        setShowReason(false)
        setReason('')
        setOriginalContent(content)
        loadVersions()
        setTimeout(() => setSaved(false), 2000)
      } catch {
        setSaveError(true)
      } finally {
        setSaving(false)
      }
    } else {
      setShowReason(true)
    }
  }

  const handleRollback = async (version: number) => {
    try {
      await window.api.config.skillRollback(name, version)
      await loadContent()
      await loadVersions()
      setSelectedVersion(null)
    } catch (err) {
      console.error('Rollback failed:', err)
    }
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      {/* 标题区 */}
      <div className="px-5 py-4 border-b border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-base font-medium text-gray-100">{name}.md</span>
          </div>
          <button
            onClick={() => setShowVersions(!showVersions)}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
              showVersions ? 'text-indigo-400 bg-indigo-400/10' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <History size={11} />
            {t('external.versionHistory')}
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mt-1">
          {t('external.skillDescription', { name })}
        </p>
      </div>

      {/* 编辑区 */}
      <div className="px-5 py-3">
          <div className="flex gap-3">
            <div className="flex-1 flex flex-col min-w-0">
              <textarea
                value={selectedVersion ? selectedVersion.content : content}
                onChange={e => { if (!selectedVersion) setContent(e.target.value) }}
                readOnly={!!selectedVersion}
                rows={14}
                className={`w-full px-4 py-3 bg-white/5 border rounded-xl text-sm text-gray-200 font-mono leading-relaxed resize-none focus:outline-none ${
                  selectedVersion ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 focus:border-indigo-400/50'
                }`}
              />

              <div className="flex items-center justify-between mt-3">
                {selectedVersion ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-amber-400">{t('external.versionPreview', { version: selectedVersion.version })}</span>
                    <button onClick={() => setSelectedVersion(null)} className="text-[11px] text-gray-400 hover:text-white">{t('external.returnToEdit')}</button>
                  </div>
                ) : showReason ? (
                  <div className="flex items-center gap-2 flex-1 mr-3">
                    <input
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      placeholder={t('external.changeReason')}
                      className="flex-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50"
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSave()
                        if (e.key === 'Escape') { setShowReason(false); setReason('') }
                      }}
                    />
                  </div>
                ) : <div />}

                <div className="flex items-center gap-2">
                  {saveError && !selectedVersion && (
                    <span className="text-[11px] text-red-400">{t('external.saveFailed')}</span>
                  )}
                  {selectedVersion && (
                    <button
                      onClick={() => handleRollback(selectedVersion.version)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors"
                    >
                      <RotateCcw size={12} />
                      {t('external.rollback')}
                    </button>
                  )}
                  {!selectedVersion && (
                    <button
                      onClick={handleSave}
                      disabled={saving || (!hasChanges && !showReason)}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50"
                    >
                      {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <CheckCircle size={14} /> : <Save size={14} />}
                      {saved ? t('common:actions.saved') : showReason ? t('external.confirmSave') : t('common:actions.save')}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {showVersions && <VersionTimeline versions={versions} selectedVersion={selectedVersion} onSelect={setSelectedVersion} />}
          </div>
        </div>
    </div>
  )
}

// --- 共享：版本时间线 ---

function VersionTimeline({
  versions,
  selectedVersion,
  onSelect,
}: {
  versions: VersionEntry[]
  selectedVersion: VersionEntry | null
  onSelect: (v: VersionEntry | null) => void
}) {
  const { t } = useTranslation('settings')
  const { formatShortDate } = useFormatters()
  return (
    <div className="w-56 flex-shrink-0 overflow-y-auto border-l border-white/5 pl-3">
      <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-2">
        {t('external.versionHistory')}
      </div>
      {versions.length === 0 ? (
        <p className="text-[11px] text-gray-600 py-2">{t('external.noVersions')}</p>
      ) : (
        <div className="space-y-1">
          {versions.map(v => (
            <button
              key={v.version}
              onClick={() => onSelect(selectedVersion?.version === v.version ? null : v)}
              className={`w-full text-left px-2 py-2 rounded-md transition-colors ${
                selectedVersion?.version === v.version
                  ? 'bg-amber-500/10 border border-amber-500/20'
                  : 'hover:bg-white/[0.03] border border-transparent'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-300 font-mono">v{v.version}</span>
                <span className={`text-[9px] px-1 py-0.5 rounded ${
                  v.changed_by === 'user' ? 'text-indigo-400 bg-indigo-400/10' : v.changed_by === 'learning2' ? 'text-purple-400 bg-purple-500/10' : v.changed_by === 'file_edit' ? 'text-green-400 bg-green-500/10' : 'text-amber-400 bg-amber-500/10'
                }`}>
                  {t(`external.changedBy.${v.changed_by}`, { defaultValue: v.changed_by })}
                </span>
              </div>
              {v.change_reason && (
                <p className="text-[10px] text-gray-500 mt-0.5 truncate">{v.change_reason}</p>
              )}
              <p className="text-[9px] text-gray-600 mt-0.5">{formatShortDate(v.created)}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
