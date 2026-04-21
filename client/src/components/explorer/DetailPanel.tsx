import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Brain, Star, Pencil, Save, X, ArrowRight, ArrowLeft,
  Clock, ChevronDown, ChevronUp, ExternalLink,
} from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { useDataRevision } from '../../contexts/DataChangeContext'
import { useMutation } from '../../hooks/useMutation'
import { TypeBadge } from '../TypeBadge'
import { MaturityRadar } from '../MaturityRadar'
import { HeatIndicator } from '../HeatIndicator'
import { InfoTip } from '../InfoTip'
import { Skeleton } from '../Skeleton'
import { MarkdownContent } from '../MarkdownContent'
import { truncate } from '../../lib/format'
import { useFormatters } from '../../hooks/useFormatters'
import { MATURITY_TIPS, NODE_ATTR_TIPS, LINK_TIPS, NODE_TYPE_TIPS } from '../../lib/tooltips'
import { RELATION_COLORS, RELATION_LABELS } from '../../lib/constants'
import type { LinkData, VersionData } from '../../lib/api'

export function DetailPanel({ nodeId, onNavigate }: {
  nodeId: string | null
  onNavigate: (id: string) => void
}) {
  const { t } = useTranslation('explorer')
  const { formatDate, timeAgo } = useFormatters()
  const rev = useDataRevision(['nodes', 'links'])
  const { data, loading, refetch } = useIPC(
    () => nodeId ? window.api.nodes.get(nodeId) : Promise.resolve(null),
    [nodeId, rev],
  )

  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editReason, setEditReason] = useState('')
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const [showAllVersions, setShowAllVersions] = useState(false)
  // 标签解除 toast（5s 后自动消失，支持撤销）
  const [rejectToast, setRejectToast] = useState<{ linkId: string; tagName: string } | null>(null)


  // 解除标签：调 IPC、用后端返回的权威 tagName 显示 toast、触发 refetch
  const handleRejectTag = async (link: LinkData) => {
    const fallbackName = (link.target_title?.trim() || link.target_content_preview || '').trim()
    const res = await window.api.links.rejectTag(link.id)
    if (!res.success) return
    setRejectToast({ linkId: link.id, tagName: res.tagName || fallbackName })
    refetch()
  }

  const handleUndoReject = async () => {
    if (!rejectToast) return
    await window.api.links.undoRejectTag(rejectToast.linkId)
    setRejectToast(null)
    refetch()
  }

  // Toast 自动消失
  useEffect(() => {
    if (!rejectToast) return
    const timer = setTimeout(() => setRejectToast(null), 5000)
    return () => clearTimeout(timer)
  }, [rejectToast])

  // Reset edit state when node changes
  useEffect(() => {
    setEditing(false)
    setEditContent('')
    setEditTitle('')
    setEditReason('')
    setExpandedVersion(null)
    setShowAllVersions(false)
  }, [nodeId])

  const editMutation = useMutation(
    (args: { id: string; content: string; title: string | null; reason: string }) =>
      window.api.write.editNode(args.id, args.content, args.title, args.reason)
  )

  // Reset edit state when node changes
  const handleStartEdit = () => {
    if (!data?.node) return
    setEditContent(data.node.content)
    setEditTitle(data.node.title ?? '')
    setEditReason('')
    setEditing(true)
  }

  const handleSave = async () => {
    if (!nodeId || !editContent.trim() || !editTitle.trim()) return
    const result = await editMutation.mutate({
      id: nodeId,
      content: editContent,
      title: editTitle.trim(),
      reason: editReason || t('explorer:detail.manualEdit'),
    })
    if (result?.success) {
      setEditing(false)
      refetch()
    }
  }

  const handleCancel = () => {
    setEditing(false)
    setEditContent('')
    setEditTitle('')
    setEditReason('')
  }

  // Empty state
  if (!nodeId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-3">
        <Brain size={32} className="text-gray-600" />
        <p className="text-sm">{t('explorer:detail.selectNode')}</p>
      </div>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-14" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-24 w-full" />
        <div className="flex items-start gap-4">
          <Skeleton className="h-[120px] w-[120px]" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      </div>
    )
  }

  if (!data?.node) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        {t('explorer:detail.nodeNotFound')}
      </div>
    )
  }

  const { node, links, versions } = data
  const confirmed = links.filter((l: LinkData) => l.status === 'confirmed')
  const pending = links.filter((l: LinkData) => l.status === 'pending')

  // Evidence chain: for crystal nodes, find links where relation='summarizes'
  const evidenceLinks = node.is_crystal
    ? links.filter((l: LinkData) => Array.isArray(l.relation) && l.relation.some(r => r.type === 'summarizes'))
    : []

  // Version display logic
  const versionsToShow = showAllVersions ? versions : versions.slice(0, 3)
  const hasMoreVersions = versions.length > 3

  // Parse tags
  let parsedTags: string[] = []
  if (node.tags) {
    try {
      const parsed = JSON.parse(node.tags)
      parsedTags = Array.isArray(parsed) ? parsed : []
    } catch {
      parsedTags = node.tags.split(',').map(s => s.trim()).filter(Boolean)
    }
  }

  return (
    <div className="h-full overflow-auto relative">
      {/* Reject toast（标签解除成功 + 5s 撤销） */}
      <AnimatePresence>
        {rejectToast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-3 py-2 rounded-lg bg-black/80 text-xs text-gray-200 border border-white/10 shadow-lg"
          >
            <span>{t('explorer:detail.rejectTagSuccess', { tag: rejectToast.tagName })}</span>
            <button
              onClick={handleUndoReject}
              className="text-amber-400 hover:text-amber-300 font-medium"
            >
              {t('explorer:detail.undo')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="sticky top-0 panel-header border-b px-5 py-3 flex items-center gap-2 z-10">
        <TypeBadge specificity={node.specificity} subjectivity={node.subjectivity} actuality={node.actuality} refinement={node.refinement} is_crystal={node.is_crystal} is_keystone={node.is_keystone} is_tag={node.is_tag} is_meta={node.is_meta} />
        <span className="text-[10px] text-gray-500 font-mono">{node.id.slice(0, 8)}</span>
        {node.is_keystone ? (
          <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
            <Star size={9} fill="currentColor" />
            <InfoTip content={NODE_ATTR_TIPS.keystone} size={10} />
          </span>
        ) : null}
      </div>

      <div className="p-5 space-y-5">
        {/* Title + Content */}
        <div>
          {editing ? (
            <div className="space-y-2">
              <input
                type="text"
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                placeholder={t('explorer:detail.titlePlaceholder')}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-base font-semibold text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-400/50 focus:ring-1 focus:ring-indigo-400/20"
              />
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="w-full min-h-[120px] p-3 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-400/50 focus:ring-1 focus:ring-indigo-400/20 resize-y"
              />
              <input
                type="text"
                value={editReason}
                onChange={e => setEditReason(e.target.value)}
                placeholder={t('explorer:detail.editReasonPlaceholder')}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-300 placeholder-gray-500 focus:outline-none focus:border-indigo-400/50"
              />
              <p className="text-[10px] text-gray-500">{t('explorer:detail.editVersionNote')}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSave}
                  disabled={editMutation.loading || !editContent.trim() || !editTitle.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-400/20 text-indigo-300 rounded-lg text-xs font-medium hover:bg-indigo-400/30 disabled:opacity-50 transition-all"
                >
                  <Save size={12} />
                  {editMutation.loading ? t('explorer:detail.saving') : t('explorer:detail.save')}
                </button>
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-gray-400 hover:text-gray-200 rounded-lg text-xs transition-colors"
                >
                  <X size={12} />
                  {t('explorer:detail.cancel')}
                </button>
              </div>
              {editMutation.error && (
                <p className="text-xs text-red-400">{editMutation.error}</p>
              )}
            </div>
          ) : (
            <div className="group relative">
              {node.title && (
                <h2 className="text-base font-semibold text-gray-100 leading-snug mb-2 pr-8">
                  {node.title}
                </h2>
              )}
              <MarkdownContent content={node.content} className="text-sm text-gray-200 leading-relaxed" />
              <button
                onClick={handleStartEdit}
                className="absolute top-0 right-0 p-1.5 text-gray-500 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all"
                title={t('explorer:detail.edit')}
              >
                <Pencil size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Maturity radar + dimensions */}
        <div className="flex items-start gap-4">
          <MaturityRadar
            heat={node.heat}
            refinement={node.refinement}
            connectivity={node.connectivity}
            independence={node.independence}
            size={120}
          />
          <div className="space-y-2 text-xs text-gray-400">
            <div>
              {t('explorer:detail.heat')} <InfoTip content={MATURITY_TIPS.heat} size={10} />
              : <HeatIndicator heat={node.heat} className="inline-flex" />
            </div>
            <div>
              {t('explorer:detail.refinement')} <InfoTip content={MATURITY_TIPS.refinement} size={10} />
              : <span className="text-gray-200">{node.refinement.toFixed(2)}</span>
            </div>
            <div>
              {t('explorer:detail.connectivity')} <InfoTip content={MATURITY_TIPS.connectivity} size={10} />
              : <span className="text-gray-200">{node.connectivity.toFixed(2)}</span>
            </div>
            <div>
              {t('explorer:detail.independence')} <InfoTip content={MATURITY_TIPS.independence} size={10} />
              : <span className="text-gray-200">{node.independence.toFixed(2)}</span>
            </div>
            {node.is_keystone ? (
              <div className="flex items-center gap-1 text-amber-400">
                <Star size={10} fill="currentColor" />
                <span>{t('explorer:detail.keystoneNode')}</span>
                <InfoTip content={NODE_ATTR_TIPS.keystone} size={10} />
              </div>
            ) : null}
          </div>
        </div>

        {/* Links */}
        {links.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-gray-300 mb-2">
              {t('explorer:detail.links')} ({links.length})
              {pending.length > 0 && <span className="text-gray-500 font-normal ml-1">({pending.length} {t('explorer:detail.pending')})</span>}
              <InfoTip content={t('explorer:detail.linksTip')} size={10} />
            </h4>
            <div className="space-y-1.5">
              {confirmed.map((link: LinkData) => (
                <LinkRow key={link.id} link={link} nodeId={nodeId!} onNavigate={onNavigate} isPending={false} onReject={handleRejectTag} />
              ))}
              {pending.map((link: LinkData) => (
                <LinkRow key={link.id} link={link} nodeId={nodeId!} onNavigate={onNavigate} isPending={true} onReject={handleRejectTag} />
              ))}
            </div>
          </div>
        )}

        {/* Version History */}
        {versions.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-gray-300 mb-2">
              {t('explorer:detail.versionHistory', { count: versions.length })}
              <InfoTip content={t('explorer:detail.versionTip')} size={10} />
            </h4>
            <div className="space-y-1.5">
              {versionsToShow.map((v: VersionData, idx: number) => {
                const isDeepRecon = v.change_reason?.toLowerCase().includes('reconsolidat')
                const isExpanded = expandedVersion === v.version
                // Find previous version for simple diff
                const prevVersion = versions.find((pv: VersionData) => pv.version === v.version - 1)

                return (
                  <div key={v.id}>
                    <button
                      onClick={() => setExpandedVersion(isExpanded ? null : v.version)}
                      className="w-full flex items-start gap-2 text-xs text-left hover:bg-white/[0.03] rounded px-1 py-0.5 transition-colors"
                    >
                      <Clock size={12} className="text-gray-500 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-gray-400">v{v.version} · {timeAgo(v.changed_at)}</span>
                        {isDeepRecon && (
                          <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] bg-teal-500/20 text-teal-300">{t('explorer:detail.reconsolidation')}</span>
                        )}
                        {v.change_reason && !isDeepRecon && (
                          <span className="text-gray-500 ml-1"> · {v.change_reason}</span>
                        )}
                      </div>
                    </button>
                    <AnimatePresence>
                      {isExpanded && v.content && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          {prevVersion && (
                            <div className="ml-6 mt-1 p-2 rounded bg-red-500/5 border border-red-500/10 text-[11px] text-gray-500 whitespace-pre-wrap break-words line-through decoration-red-400/30">
                              {prevVersion.content}
                            </div>
                          )}
                          <div className="ml-6 mt-1 p-2 rounded bg-white/[0.02] border border-white/5 text-[11px] text-gray-400 whitespace-pre-wrap break-words">
                            {v.content}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </div>
            {hasMoreVersions && (
              <button
                onClick={() => setShowAllVersions(!showAllVersions)}
                className="flex items-center gap-1 mt-2 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                {showAllVersions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {showAllVersions ? t('explorer:detail.collapse') : t('explorer:detail.expandAll', { count: versions.length })}
              </button>
            )}
          </div>
        )}

        {/* Source Tracing */}
        {(node.source_tool || node.source_session || node.source_timestamp || node.source_stream) && (
          <div>
            <h4 className="text-xs font-medium text-gray-300 mb-2">{t('explorer:detail.sourceTracing')}</h4>
            <div className="space-y-1.5 text-xs text-gray-400">
              {node.source_tool && (
                <div>{t('explorer:detail.tool')} <span className="text-gray-200">{node.source_tool}</span></div>
              )}
              {node.source_session && (
                <div>{t('explorer:detail.session')} <span className="text-gray-200 font-mono text-[10px]">{node.source_session}</span></div>
              )}
              {node.source_timestamp && (
                <div>{t('explorer:detail.time')} <span className="text-gray-200">{formatDate(node.source_timestamp)}</span></div>
              )}
              {node.source_stream && (
                <div className="flex items-center gap-1">
                  {t('explorer:detail.stream')} <InfoTip content={NODE_ATTR_TIPS.source_stream} size={10} />
                  : <span className="text-gray-200 font-mono text-[10px]">{node.source_stream}</span>
                  <a
                    href={`#/timeline`}
                    className="inline-flex items-center gap-0.5 text-indigo-400 hover:text-indigo-300 transition-colors ml-1"
                  >
                    <ExternalLink size={10} />
                    <span>{t('explorer:detail.viewTimeline')}</span>
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Evidence Chain (crystal nodes only) */}
        {node.is_crystal && evidenceLinks.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-gray-300 mb-2">
              {t('explorer:detail.evidenceChain')} ({evidenceLinks.length})
              <InfoTip content={t('explorer:detail.evidenceTip')} size={10} />
            </h4>
            <div className="space-y-1.5">
              {evidenceLinks.map((link: LinkData) => {
                const targetId = link.from_id === nodeId ? link.to_id : link.from_id
                return (
                  <button
                    key={link.id}
                    onClick={() => onNavigate(targetId)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors text-left"
                  >
                    <TypeBadge type={link.target_type ?? undefined} />
                    <span className="text-xs text-gray-300 truncate flex-1">{link.target_title?.trim() || link.target_content_preview}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Meta */}
        <div>
          <h4 className="text-xs font-medium text-gray-300 mb-2">{t('explorer:detail.metaInfo')}</h4>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div>{t('explorer:detail.created')} <span className="text-gray-200">{formatDate(node.created)}</span></div>
            {parsedTags.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                <span>{t('explorer:detail.tags')}</span>
                {parsedTags.map((tag, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-white/5 text-gray-300 text-[10px]">{tag}</span>
                ))}
              </div>
            )}
            <div>{t('explorer:detail.id')} <span className="text-gray-200 font-mono text-[10px] select-all">{node.id}</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Single link row, reusable for confirmed & pending */
function LinkRow({ link, nodeId, onNavigate, isPending, onReject }: {
  link: LinkData
  nodeId: string
  onNavigate: (id: string) => void
  isPending: boolean
  onReject?: (link: LinkData) => void
}) {
  const { t } = useTranslation('explorer')
  const targetId = link.from_id === nodeId ? link.to_id : link.from_id
  const isTagged = Array.isArray(link.relation) && link.relation.some(r => r.type === 'tagged')

  return (
    <div
      className={`group w-full flex items-stretch gap-0 rounded-lg hover:bg-white/[0.06] transition-colors overflow-hidden ${
        isPending ? 'border border-dashed border-white/10 bg-white/[0.01]' : 'bg-white/[0.03]'
      }`}
    >
      {/* relation color bar */}
      <div
        className="w-[3px] self-stretch flex-shrink-0 rounded-l"
        style={{ backgroundColor: RELATION_COLORS[Array.isArray(link.relation) && link.relation.length > 0 ? link.relation[0].type : 'analogous'] ?? RELATION_COLORS.analogous }}
      />
      <button
        onClick={() => onNavigate(targetId)}
        className="flex-1 min-w-0 px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          {link.direction === 'outgoing'
            ? <ArrowRight size={12} className="text-gray-400 flex-shrink-0" />
            : <ArrowLeft size={12} className="text-gray-400 flex-shrink-0" />
          }
          <span className="text-[10px] text-gray-500 flex-shrink-0">
            {Array.isArray(link.relation) ? link.relation.map(r => RELATION_LABELS[r.type] ?? r.type).join(', ') : ''}
            {Array.isArray(link.relation) && link.relation.length > 0 && LINK_TIPS[link.relation[0].type as keyof typeof LINK_TIPS] && (
              <InfoTip content={LINK_TIPS[link.relation[0].type as keyof typeof LINK_TIPS]} size={9} />
            )}
          </span>
          {/* strength indicator dot */}
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: '#fff', opacity: Math.max(0.15, link.strength) }}
            title={`${t('explorer:detail.strength')} ${link.strength.toFixed(2)}`}
          />
          <span className="text-xs text-gray-300 truncate">{link.target_title?.trim() || link.target_content_preview}</span>
        </div>
        {link.note && (
          <p className="text-[10px] text-gray-500 mt-0.5 ml-5 truncate">{link.note}</p>
        )}
      </button>
      {isTagged && onReject && (
        <button
          onClick={(e) => { e.stopPropagation(); onReject(link) }}
          className="px-2 self-stretch flex items-center text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
          title={t('explorer:detail.rejectTag')}
          aria-label={t('explorer:detail.rejectTagAria')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
