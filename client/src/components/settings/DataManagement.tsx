import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { brand, btnText } from '../../lib/tokens'
import {
  Download,
  Save,
  Calendar,
  FileText,
  Loader2,
  ArrowUpCircle,
  ArrowDownCircle,
  Tag,
  RotateCcw,
  Archive,
  ChevronLeft,
  ChevronRight,
  Check,
} from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { Section } from './shared'
import { Skeleton } from '../Skeleton'
import { formatBytes, truncate } from '../../lib/format'
import { useFormatters } from '../../hooks/useFormatters'

// ============================================================
// Data Management: sub-tab 壳 — 存储与导出 / 日志 / 标签管理
// ============================================================

type SubTab = 'storage' | 'logs' | 'tags' | 'archived'

export function DataManagement() {
  const { t } = useTranslation('settings')
  const [subTab, setSubTab] = useState<SubTab>('storage')

  const SUB_TABS: { key: SubTab; label: string }[] = [
    { key: 'storage', label: t('data.subtabs.storage') },
    { key: 'logs', label: t('data.subtabs.logs') },
    { key: 'tags', label: t('data.subtabs.tags') },
    { key: 'archived', label: t('data.subtabs.archive') },
  ]

  return (
    <div className="space-y-4 max-w-3xl">
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
        className="space-y-6"
      >
        {subTab === 'storage' && (
          <>
            <ExportSection />
            <StorageStats />
          </>
        )}
        {subTab === 'logs' && <StreamLogBrowser />}
        {subTab === 'tags' && <TagManagement />}
        {subTab === 'archived' && <ArchivedNodes />}
      </motion.div>
    </div>
  )
}

// ============================================================
// Export
// ============================================================

type ExportFormat = 'markdown' | 'json'
type ExportScope = 'all' | 'tag' | 'date'

function ExportSection() {
  const { t } = useTranslation('settings')
  const { data: allTags } = useIPC(() => window.api.nodes.tags())
  const coreTags = (allTags ?? []).filter(tag => tag.isCore)

  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [scope, setScope] = useState<ExportScope>('all')
  const [selectedTag, setSelectedTag] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [exporting, setExporting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const handleExport = async () => {
    setExporting(true)
    setResult(null)
    setSaved(false)
    try {
      const scopeParam: { tag?: string; after?: string; before?: string } = {}
      if (scope === 'tag' && selectedTag) scopeParam.tag = selectedTag
      if (scope === 'date') {
        if (dateFrom) scopeParam.after = dateFrom
        if (dateTo) scopeParam.before = dateTo
      }

      if (format === 'markdown') {
        const md = await window.api.export.markdown(scopeParam)
        setResult(md)
      } else {
        const json = await window.api.export.json(scopeParam)
        setResult(JSON.stringify(json, null, 2))
      }
    } catch (err) {
      setResult(`导出失败: ${(err as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  const handleSaveFile = async () => {
    if (!result) return
    setSaving(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const ext = format === 'json' ? 'json' : 'md'
      const defaultName = `tidemind-export-${today}.${ext}`
      const res = await window.api.export.saveFile(result, defaultName)
      if (res?.saved) setSaved(true)
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  return (
    <Section title={t('data.export.title')}>
      <div className="space-y-4">
        {/* Format */}
        <div>
          <label className="text-xs text-gray-400 mb-2 block">{t('data.export.format')}</label>
          <div className="flex items-center gap-3">
            {(['markdown', 'json'] as const).map(f => (
              <label key={f} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === f}
                  onChange={() => setFormat(f)}
                  className="accent-indigo-400"
                />
                <span className="text-xs text-gray-300">{f === 'markdown' ? 'Markdown' : 'JSON'}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Scope */}
        <div>
          <label className="text-xs text-gray-400 mb-2 block">{t('data.export.scope')}</label>
          <div className="flex items-center gap-3">
            {([
              { value: 'all' as const, label: t('data.export.scopeAll') },
              { value: 'tag' as const, label: t('data.export.scopeByTag') },
              { value: 'date' as const, label: t('data.export.scopeByDate') },
            ]).map(s => (
              <label key={s.value} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="export-scope"
                  checked={scope === s.value}
                  onChange={() => setScope(s.value)}
                  className="accent-indigo-400"
                />
                <span className="text-xs text-gray-300">{s.label}</span>
              </label>
            ))}
          </div>
          {scope === 'all' && (
            <p className="text-[10px] text-gray-500 mt-1.5">{t('data.export.fullExportNote')}</p>
          )}
        </div>

        {/* Conditional inputs */}
        {scope === 'tag' && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">{t('data.export.tag')}</label>
            <select
              value={selectedTag}
              onChange={e => setSelectedTag(e.target.value)}
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50"
            >
              <option value="">{t('data.export.selectTag')}</option>
              {coreTags.map(item => (
                <option key={item.tag} value={item.tag}>{item.tag} ({item.count})</option>
              ))}
            </select>
          </div>
        )}

        {scope === 'date' && (
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">{t('data.export.startDate')}</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">{t('data.export.endDate')}</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50"
              />
            </div>
          </div>
        )}

        <button
          onClick={handleExport}
          disabled={exporting || (scope === 'tag' && !selectedTag)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          style={{ background: brand.gradient, color: btnText.onBrand }}
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {exporting ? t('data.export.exporting') : t('common:actions.export')}
        </button>

        {/* Result preview */}
        {result && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">{t('data.export.resultPreview')}</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSaveFile}
                  disabled={saving}
                  className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
                >
                  {saved ? <Check size={10} /> : saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                  {saved ? t('data.export.saved') : t('data.export.saveToFile')}
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(result)
                  }}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  {t('common:actions.copy')}
                </button>
              </div>
            </div>
            <pre className="max-h-60 overflow-auto px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg text-xs text-gray-300 font-mono whitespace-pre-wrap">
              {result.slice(0, 5000)}
              {result.length > 5000 && `\n... (${t('data.export.truncated')})`}
            </pre>
          </div>
        )}
      </div>
    </Section>
  )
}

// ============================================================
// Stream Log Browser
// ============================================================

interface StreamEntry {
  time: string
  tool?: string
  session?: string
  project?: string
  content: string
}

function parseStreamEntries(markdown: string): StreamEntry[] {
  if (!markdown.trim()) return []

  const entries: StreamEntry[] = []
  const sections = markdown.split(/^## /m).filter(Boolean)

  for (const section of sections) {
    const lines = section.split('\n')
    const header = lines[0]?.trim()
    if (!header) continue

    const parts = header.split(' · ').map(s => s.trim())
    const time = parts[0] ?? ''

    if (/^\d{4}-\d{2}-\d{2}$/.test(time)) continue

    const tool = parts[1]
    const session = parts[2]

    const bodyLines = lines.slice(1)
    let project: string | undefined
    const contentLines: string[] = []

    for (const line of bodyLines) {
      const projectMatch = line.match(/\[project:\s*(.+?)\]/)
      if (projectMatch) {
        project = projectMatch[1]
        continue
      }
      if (line.trim() === '---') continue
      contentLines.push(line)
    }

    const content = contentLines.join('\n').trim()
    if (!content && !time) continue

    entries.push({ time, tool, session, project, content })
  }

  return entries
}

function StreamLogBrowser() {
  const { t } = useTranslation('settings')
  const { data: dates, loading: datesLoading } = useIPC(() => window.api.stream.dates())
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const activeDate = selectedDate ?? dates?.[0] ?? null

  const { data: content, loading: contentLoading } = useIPC(
    () => activeDate ? window.api.stream.get(activeDate) : Promise.resolve(''),
    [activeDate],
  )

  const entries = parseStreamEntries(content ?? '')

  return (
    <Section title={t('data.logs.title')}>
      <div className="flex gap-4 h-80">
        {/* Date list */}
        <div className="w-36 flex-shrink-0 space-y-1 overflow-auto">
          <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1.5">
            <Calendar size={12} />
            {t('data.logs.date')}
          </h4>
          {datesLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)
          ) : dates?.length === 0 ? (
            <p className="text-xs text-gray-500 py-4">{t('data.logs.noLogs')}</p>
          ) : (
            dates?.map((date: string) => (
              <button
                key={date}
                onClick={() => setSelectedDate(date)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-all duration-150 ${
                  activeDate === date
                    ? 'text-white font-medium'
                    : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'
                }`}
                style={activeDate === date ? { background: 'var(--selected-bg)' } : {}}
              >
                {date}
              </button>
            ))
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {!activeDate ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <FileText size={32} className="mb-2 opacity-50" />
              <p className="text-sm">{t('data.logs.selectDate')}</p>
            </div>
          ) : contentLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">{t('data.logs.noEntries')}</div>
          ) : (
            <motion.div
              key={activeDate}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-2"
            >
              {entries.map((entry, i) => (
                <div
                  key={i}
                  className="bg-white/[0.02] rounded-lg p-3 border border-white/5"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs text-indigo-400 font-mono">{entry.time}</span>
                    {entry.tool && (
                      <span className="text-[10px] text-gray-500 bg-white/5 px-1.5 py-0.5 rounded">{entry.tool}</span>
                    )}
                  </div>
                  {entry.project && (
                    <div className="text-[10px] text-teal-400 mb-1">[project: {entry.project}]</div>
                  )}
                  <div className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
                    {truncate(entry.content, 300)}
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </div>
      </div>
    </Section>
  )
}

// ============================================================
// Storage Stats
// ============================================================

function StorageStats() {
  const { t } = useTranslation('settings')
  const { data: storage } = useIPC(() => window.api.health.storage())

  return (
    <Section title={t('data.storage.title')}>
      <div className="space-y-2 text-xs text-gray-400">
        <div className="flex items-center">
          {t('data.storage.dbSize')}
          <span className="text-gray-200 ml-2">{storage ? formatBytes(storage.dbSize) : '-'}</span>
        </div>
        <div className="flex items-center">
          {t('data.storage.streamFiles')}
          <span className="text-gray-200 ml-2">{storage?.streamFiles ?? 0}</span>
        </div>
        <div className="flex items-start">
          {t('data.storage.dataDir')}
          <span className="text-gray-200 font-mono ml-2 break-all">{storage?.path ?? '-'}</span>
        </div>
      </div>
    </Section>
  )
}

// ============================================================
// Tag Management
// ============================================================

function TagManagement() {
  const { t } = useTranslation('settings')
  const { data: allTags, loading, refetch } = useIPC(() => window.api.nodes.tags())
  const [operating, setOperating] = useState<string | null>(null)

  const coreTags = (allTags ?? []).filter(tag => tag.isCore).sort((a, b) => b.count - a.count)
  const normalTags = (allTags ?? []).filter(tag => !tag.isCore).sort((a, b) => b.count - a.count)

  const handlePromote = async (tag: string) => {
    setOperating(tag)
    try {
      await window.api.nodes.promoteTag(tag)
      refetch()
    } catch { /* ignore */ }
    finally { setOperating(null) }
  }

  const handleDemote = async (tag: string) => {
    setOperating(tag)
    try {
      await window.api.nodes.demoteTag(tag)
      refetch()
    } catch { /* ignore */ }
    finally { setOperating(null) }
  }

  if (loading) {
    return (
      <Section title={t('data.tags.title')}>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      </Section>
    )
  }

  return (
    <div className="space-y-6">
      {/* 核心标签 */}
      <Section title={t('data.tags.coreTags')}>
        <p className="text-xs text-gray-500 mb-3">
          {t('data.tags.coreDesc')}
        </p>
        {coreTags.length === 0 ? (
          <p className="text-xs text-gray-500 py-4 text-center">{t('data.tags.noCoreTags')}</p>
        ) : (
          <div className="space-y-1">
            {coreTags.map(item => (
              <div
                key={item.tag}
                className="flex items-center gap-3 px-3 py-2 hover:bg-white/[0.03] rounded-lg transition-colors"
              >
                <Tag size={12} className="text-indigo-400 flex-shrink-0" />
                <span className="flex-1 text-xs text-gray-200 truncate">{item.tag}</span>
                <span className="text-[10px] text-gray-500 tabular-nums flex-shrink-0">{item.count} {t('common:units.items')}</span>
                <button
                  onClick={() => handleDemote(item.tag)}
                  disabled={operating === item.tag}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-gray-400 hover:text-orange-300 hover:bg-orange-500/10 rounded transition-colors disabled:opacity-50"
                >
                  {operating === item.tag ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <ArrowDownCircle size={10} />
                  )}
                  {t('data.tags.demote')}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 普通标签 */}
      <Section title={t('data.tags.normalTags')}>
        <p className="text-xs text-gray-500 mb-3">
          {t('data.tags.normalDesc')}
        </p>
        {normalTags.length === 0 ? (
          <p className="text-xs text-gray-500 py-4 text-center">{t('data.tags.noNormalTags')}</p>
        ) : (
          <div className="space-y-1">
            {normalTags.map(item => (
              <div
                key={item.tag}
                className="flex items-center gap-3 px-3 py-2 hover:bg-white/[0.03] rounded-lg transition-colors"
              >
                <Tag size={12} className="text-gray-500 flex-shrink-0" />
                <span className="flex-1 text-xs text-gray-300 truncate">{item.tag}</span>
                <span className="text-[10px] text-gray-500 tabular-nums flex-shrink-0">{item.count} {t('common:units.items')}</span>
                <button
                  onClick={() => handlePromote(item.tag)}
                  disabled={operating === item.tag}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-indigo-400 hover:text-indigo-300 hover:bg-indigo-400/10 rounded transition-colors disabled:opacity-50"
                >
                  {operating === item.tag ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <ArrowUpCircle size={10} />
                  )}
                  {t('data.tags.promote')}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

// ============================================================
// 归档数据
// ============================================================

const TYPE_LABEL_KEYS: Record<string, { key: string; cls: string }> = {
  fact: { key: 'data.archive.types.fact', cls: 'bg-blue-500/15 text-blue-400' },
  idea: { key: 'data.archive.types.idea', cls: 'bg-amber-500/15 text-amber-400' },
  preference: { key: 'data.archive.types.preference', cls: 'bg-emerald-500/15 text-emerald-400' },
  question: { key: 'data.archive.types.question', cls: 'bg-purple-500/15 text-purple-400' },
}

interface ArchivedNodeItem {
  id: string
  type: string
  content: string
  created: string
}

function NodeRow({
  node, actionLabel, actionIcon, actionCls, operating, onAction,
}: {
  node: ArchivedNodeItem
  actionLabel: string
  actionIcon: React.ReactNode
  actionCls: string
  operating: boolean
  onAction: () => void
}) {
  const { t } = useTranslation('settings')
  const { timeAgo } = useFormatters()
  const typeCfg = TYPE_LABEL_KEYS[node.type] ?? { key: node.type, cls: 'bg-gray-500/15 text-gray-400' }
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors">
      <span className={`px-1.5 py-0.5 text-[10px] rounded ${typeCfg.cls} flex-shrink-0`}>
        {t(typeCfg.key, { defaultValue: node.type })}
      </span>
      <span className="flex-1 text-xs text-gray-300 truncate">
        {truncate(node.content, 80)}
      </span>
      <span className="text-[10px] text-gray-500 tabular-nums flex-shrink-0">
        {timeAgo(node.created)}
      </span>
      <button
        onClick={onAction}
        disabled={operating}
        className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors disabled:opacity-50 flex-shrink-0 ${actionCls}`}
      >
        {operating ? <Loader2 size={10} className="animate-spin" /> : actionIcon}
        {actionLabel}
      </button>
    </div>
  )
}

function Pagination({ page, totalPages, onPageChange }: {
  page: number; totalPages: number; onPageChange: (p: number) => void
}) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-center gap-3 pt-3 border-t border-white/5 mt-3">
      <button
        onClick={() => onPageChange(Math.max(0, page - 1))}
        disabled={page === 0}
        className="p-1 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="text-[10px] text-gray-500 tabular-nums">
        {page + 1} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
        disabled={page >= totalPages - 1}
        className="p-1 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

function ArchivedNodes() {
  const { t } = useTranslation('settings')
  const PAGE_SIZE = 20
  const [page, setPage] = useState(0)
  const [operating, setOperating] = useState<string | null>(null)
  // 已恢复的节点（本地跟踪，刷新后回归正常池）
  const [restoredNodes, setRestoredNodes] = useState<ArchivedNodeItem[]>([])

  const { data, loading, refetch } = useIPC(
    () => window.api.write.listArchived({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    [page],
  )

  const archivedNodes = data?.nodes ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const handleRestore = async (node: ArchivedNodeItem) => {
    setOperating(node.id)
    try {
      await window.api.write.unarchiveNode(node.id)
      setRestoredNodes(prev => [node, ...prev])
      refetch()
    } catch (err) {
      console.error('恢复节点失败:', err)
    } finally {
      setOperating(null)
    }
  }

  const handleReArchive = async (node: ArchivedNodeItem) => {
    setOperating(node.id)
    try {
      await window.api.write.reArchiveNode(node.id)
      setRestoredNodes(prev => prev.filter(n => n.id !== node.id))
      refetch()
    } catch (err) {
      console.error('归档节点失败:', err)
    } finally {
      setOperating(null)
    }
  }

  if (loading) {
    return (
      <Section title={t('data.subtabs.archive')}>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      </Section>
    )
  }

  return (
    <div className="space-y-6">
      {/* 已恢复 */}
      {restoredNodes.length > 0 && (
        <Section title={t('data.archive.restored')}>
          <p className="text-xs text-gray-500 mb-3">
            {t('data.archive.restoredDesc')}
          </p>
          <div className="space-y-1">
            {restoredNodes.map(node => (
              <NodeRow
                key={node.id}
                node={node}
                actionLabel={t('data.archive.archiveBtn')}
                actionIcon={<Archive size={10} />}
                actionCls="text-orange-400 hover:text-orange-300 hover:bg-orange-500/10"
                operating={operating === node.id}
                onAction={() => handleReArchive(node)}
              />
            ))}
          </div>
        </Section>
      )}

      {/* 归档数据 */}
      <Section
        title={t('data.subtabs.archive')}
        action={total > 0 ? <span className="text-[10px] text-gray-500">{total} {t('common:units.items')}</span> : undefined}
      >
        <p className="text-xs text-gray-500 mb-3">
          {t('data.archive.archivedDesc')}
        </p>

        {archivedNodes.length === 0 && restoredNodes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-gray-500">
            <Archive size={20} className="text-gray-600" />
            <p className="text-xs">{t('data.archive.noArchived')}</p>
          </div>
        ) : archivedNodes.length === 0 ? (
          <p className="text-xs text-gray-500 py-4 text-center">{t('data.archive.allRestored')}</p>
        ) : (
          <>
            <div className="space-y-1">
              {archivedNodes.map(node => (
                <NodeRow
                  key={node.id}
                  node={node}
                  actionLabel={t('data.archive.restore')}
                  actionIcon={<RotateCcw size={10} />}
                  actionCls="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                  operating={operating === node.id}
                  onAction={() => handleRestore(node)}
                />
              ))}
            </div>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </Section>
    </div>
  )
}
