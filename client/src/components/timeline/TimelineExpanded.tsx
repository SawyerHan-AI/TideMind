import { useMemo } from 'react'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TimelineEvent } from '../../lib/api'
import { SOURCE_TOOL_LABELS } from '../../lib/constants'
import { useResolvedNodes, type NodeMap } from '../../hooks/useResolvedNodes'

/* ── helpers ────────────────────────────────────────────── */

function safeJsonParse<T = unknown>(str: string | null, fallback: T): T {
  if (!str) return fallback
  try { return JSON.parse(str) as T } catch { return fallback }
}

/** Extract ALL node IDs from both node_ids and detail fields */
function collectNodeIds(
  nodeIds: string[],
  detail: Record<string, unknown>,
): string[] {
  const set = new Set(nodeIds)
  for (const key of ['node_id', 'source_id', 'target_id', 'crystal_id']) {
    const v = detail[key]
    if (typeof v === 'string' && v.length > 0) set.add(v)
  }
  return [...set]
}

/* ── shared UI blocks ───────────────────────────────────── */

function NodeChips({
  nodeIds,
  nodeMap,
  onNodeClick,
}: {
  nodeIds: string[]
  nodeMap: NodeMap | null
  onNodeClick: (id: string) => void
}) {
  if (nodeIds.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {nodeIds.map(id => {
        const info = nodeMap?.[id]
        return (
          <button
            key={id}
            onClick={e => { e.stopPropagation(); onNodeClick(id) }}
            title={id}
            className="inline-flex items-center gap-1 px-2 py-1 bg-white/5 rounded text-xs text-gray-300 hover:bg-white/10 transition-colors max-w-[280px]"
          >
            <ExternalLink size={10} className="text-gray-500 flex-shrink-0" />
            <span className="truncate">
              {info ? info.title : id.slice(0, 12) + '...'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Desc({ text }: { text: string }) {
  return <p className="text-xs text-gray-300 leading-relaxed">{text}</p>
}

function Field({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null
  return (
    <div className="text-xs">
      <span className="text-gray-500">{label}: </span>
      <span className="text-gray-300">{value}</span>
    </div>
  )
}

function ContentPreview({ content, label }: { content: string | undefined | null; label: string }) {
  if (!content) return null
  const preview = content.length > 200 ? content.slice(0, 200) + '...' : content
  return (
    <div className="mt-1.5">
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="mt-1 text-xs text-gray-400 bg-white/[0.03] rounded px-2.5 py-2 leading-relaxed whitespace-pre-wrap break-words">
        {preview}
      </div>
    </div>
  )
}

/* ── common props for all detail renderers ──────────────── */

interface DetailProps {
  detail: Record<string, unknown>
  nodeIds: string[]
  nodeMap: NodeMap | null
  onNodeClick: (id: string) => void
}

/* ── Memory subtypes ────────────────────────────────────── */

function DigestDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  const tool = detail.tool as string | undefined
  return (
    <div className="space-y-1.5">
      <Field label={t('expanded.summary')} value={detail.input_summary as string} />
      <Field label={t('expanded.context')} value={detail.context as string} />
      <Field
        label={t('expanded.tool')}
        value={tool ? (SOURCE_TOOL_LABELS[tool] ?? tool) : undefined}
      />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function AnnotateDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.annotate', {
        annotated: detail.annotated ?? 0,
        skipped: detail.skipped ?? 0,
        total: detail.total ?? 0,
      })} />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function DedupMergeDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  const sourceId = detail.source_id as string | undefined
  const targetId = detail.target_id as string | undefined
  const sourceName = (sourceId && nodeMap?.[sourceId]?.title) || sourceId?.slice(0, 12)
  const targetName = (targetId && nodeMap?.[targetId]?.title) || targetId?.slice(0, 12)
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.dedup_merge', { source: sourceName, target: targetName })} />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function LandingDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.landing', {
        confirmed: detail.confirmed_count ?? 0,
        pending: detail.pending_count ?? 0,
      })} />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function SynapticDetail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <Desc text={t('expanded.detail.synaptic', {
      decayed: detail.decayed ?? 0,
      linkDecayed: detail.linkDecayed ?? 0,
      linkDeleted: detail.linkDeleted ?? 0,
    })} />
  )
}

function DaemonStartDetail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <Desc text={t('expanded.detail.daemon_start', {
      count: detail.task_count ?? 0,
      interval: detail.tick_interval_s ?? 0,
    })} />
  )
}

function NoteSyncDetail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  const isFirst = detail.is_first_run === true || detail.is_first_run === 1
  const key = isFirst ? 'expanded.detail.note_sync_first' : 'expanded.detail.note_sync_incremental'
  return (
    <div className="space-y-1.5">
      <Desc text={t(key, {
        processed: detail.processed ?? 0,
        skipped: detail.skipped ?? 0,
        failed: detail.failed ?? 0,
      })} />
      {Number(detail.failed) > 0 && (
        <span className="text-[10px] text-red-400">
          {String(detail.failed)} {t('expanded.detail.files_failed')}
        </span>
      )}
    </div>
  )
}

function NoteFileChangeDetail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  return <Desc text={t('expanded.detail.note_file_change', { file: detail.file as string ?? '' })} />
}

/* ── Think Associate subtypes ───────────────────────────── */

function LinkClassifyDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.link_classify', {
        evaluated: detail.evaluated ?? 0,
        confirmed: detail.confirmed ?? 0,
        deleted: detail.deleted ?? 0,
      })} />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function RefineLinksDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.refine_links', {
        checked: detail.checked ?? 0,
        updated: detail.updated ?? 0,
        removed: detail.removed ?? 0,
      })} />
      {typeof detail.query === 'string' && detail.query.length > 0 && (
        <Field label={t('expanded.detail.trigger_query')} value={String(detail.query)} />
      )}
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function LinkDiscoverDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.link_discover', {
        scanned: detail.scanned ?? 0,
        discovered: detail.discovered ?? 0,
      })} />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

/* ── Think Emerge subtypes ──────────────────────────────── */

function DivergentScanDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.divergent_scan', {
        candidates: detail.candidates_evaluated ?? 0,
        bridges: detail.bridges_created ?? 0,
      })} />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function CrystalUpdateDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  const action = detail.action as string | undefined
  const crystalId = detail.crystal_id as string | undefined
  const summary = detail.summary as string | undefined
  const analyzed = detail.analyzed as number | undefined
  const created = detail.crystals_created as number | undefined

  // temporal-crystal variant (has analyzed + crystals_created)
  if (analyzed != null && created != null) {
    return (
      <div className="space-y-1.5">
        <Desc text={t('expanded.detail.temporal_crystal', { analyzed, created })} />
        <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
      </div>
    )
  }

  // divergent-crystal variant (has action + crystal_id)
  const key = action === 'promoted' ? 'expanded.detail.crystal_promoted' : 'expanded.detail.crystal_generated'
  return (
    <div className="space-y-1.5">
      <Desc text={t(key)} />
      {summary && <Field label={t('expanded.detail.content_preview')} value={summary} />}
      {crystalId && (
        <NodeChips nodeIds={[crystalId]} nodeMap={nodeMap} onNodeClick={onNodeClick} />
      )}
    </div>
  )
}

function KeystoneDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.keystone', {
        total: detail.total_active ?? 0,
        marked: detail.keystones_marked ?? 0,
      })} />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function TagPromoteDetail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <Desc text={t('expanded.detail.tag_promote', {
      promoted: detail.promoted ?? 0,
      created: detail.links_created ?? 0,
      updated: detail.links_updated ?? 0,
      removed: detail.links_removed ?? 0,
    })} />
  )
}

/* ── Output subtypes ────────────────────────────────────── */

function RecallDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  const tool = detail.tool as string | undefined
  return (
    <div className="space-y-1.5">
      <Field label={t('expanded.detail.recall_query')} value={detail.input_summary as string} />
      <Field label={t('expanded.context')} value={detail.context as string} />
      <Field
        label={t('expanded.tool')}
        value={tool ? (SOURCE_TOOL_LABELS[tool] ?? tool) : undefined}
      />
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

function ReconsolidationDetail({ detail, nodeMap, onNodeClick }: DetailProps) {
  const { t } = useTranslation('timeline')
  const nodeId = detail.node_id as string | undefined
  const version = detail.version != null ? String(detail.version) : undefined
  const reason = (detail.reason ?? detail.change_reason) as string | undefined
  const content = detail.content as string | undefined
  const nodeName = (nodeId && nodeMap?.[nodeId]?.title) || nodeId?.slice(0, 20)

  return (
    <div className="space-y-1.5">
      {nodeName && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-300 font-medium">{nodeName}</span>
          {version && (
            <span className="px-1.5 py-0.5 bg-white/5 rounded text-[10px] text-gray-400">
              v{version}
            </span>
          )}
        </div>
      )}
      <Field label={t('expanded.detail.reconsolidation_reason')} value={reason} />
      <ContentPreview content={content} label={t('expanded.detail.content_preview')} />
      {nodeId && (
        <button
          onClick={() => onNodeClick(nodeId)}
          className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 bg-teal-500/10 text-teal-300 rounded text-xs font-medium hover:bg-teal-500/20 transition-colors"
        >
          <ExternalLink size={10} />
          {t('expanded.viewNode')}
        </button>
      )}
    </div>
  )
}

/* ── Evolution subtypes ─────────────────────────────────── */

function Learning2Detail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  const action = detail.action as string | undefined
  const strategy = detail.strategy as string ?? ''
  const param = detail.param as string ?? ''
  const oldVal = detail.old_value != null ? String(detail.old_value) : ''
  const newVal = detail.new_value != null ? String(detail.new_value) : ''
  const reason = (detail.reason ?? detail.why) as string | undefined
  const trend = detail.trend as string | undefined

  if (action === 'rolled_back') {
    return (
      <Desc text={t('expanded.detail.learning2_rolled_back', {
        strategy, param, old: oldVal, new: newVal,
      })} />
    )
  }

  return (
    <div className="space-y-1.5">
      <Desc text={t('expanded.detail.learning2_adjusted', {
        strategy, param, old: oldVal, new: newVal,
      })} />
      {trend && <Field label={t('expanded.detail.trend')} value={trend} />}
      {reason && <Field label={t('expanded.detail.learning2_reason')} value={reason} />}
    </div>
  )
}

function Learning3Detail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  const signals = detail.signals as Record<string, unknown> | undefined
  const count = detail.recommendations_count as number | undefined

  return (
    <div className="space-y-1.5">
      {signals && Object.keys(signals).length > 0 && (
        <div className="bg-white/[0.03] rounded px-2.5 py-2">
          {Object.entries(signals).map(([name, value]) => (
            <div key={name} className="flex justify-between text-xs py-0.5">
              <span className="text-gray-500">{name}</span>
              <span className="text-gray-300 tabular-nums">{String(value)}</span>
            </div>
          ))}
        </div>
      )}
      {count != null && (
        <Desc text={t('expanded.detail.learning3_recommendations', { count })} />
      )}
    </div>
  )
}

/* ── Config subtypes ────────────────────────────────────── */

function CircuitBreakerOnDetail({ detail }: DetailProps) {
  const { t } = useTranslation('timeline')
  return (
    <Desc text={t('expanded.detail.circuit_breaker_on', {
      failures: detail.failures ?? 0,
      minutes: detail.cooldownMinutes ?? 0,
    })} />
  )
}

function CircuitBreakerOffDetail() {
  const { t } = useTranslation('timeline')
  return <Desc text={t('expanded.detail.circuit_breaker_off')} />
}

function GenericDetail({ detail, nodeIds, nodeMap, onNodeClick }: DetailProps) {
  const entries = Object.entries(detail).filter(([k]) => !['node_ids'].includes(k))
  return (
    <div className="space-y-1.5">
      {entries.map(([key, value]) => (
        <Field key={key} label={key} value={value != null ? String(value) : undefined} />
      ))}
      <NodeChips nodeIds={nodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    </div>
  )
}

/* ── Subtype dispatch maps ──────────────────────────────── */

type Renderer = (props: DetailProps) => React.JSX.Element | null

const MEMORY_RENDERERS: Record<string, Renderer> = {
  digest: DigestDetail,
  annotate: AnnotateDetail,
  dedup_merge: DedupMergeDetail,
  landing_connection: LandingDetail,
  synaptic_scaling: SynapticDetail,
  daemon_start: DaemonStartDetail,
  daemon_stop: DaemonStartDetail,
  logseq_sync: NoteSyncDetail,
  obsidian_sync: NoteSyncDetail,
  logseq_file_change: NoteFileChangeDetail,
  obsidian_file_change: NoteFileChangeDetail,
  logseq_file_changed: NoteFileChangeDetail,
  obsidian_file_changed: NoteFileChangeDetail,
}

const THINK_ASSOCIATE_RENDERERS: Record<string, Renderer> = {
  link_classify: LinkClassifyDetail,
  refine_links: RefineLinksDetail,
  link_discover: LinkDiscoverDetail,
}

const THINK_EMERGE_RENDERERS: Record<string, Renderer> = {
  divergent_scan: DivergentScanDetail,
  crystal_update: CrystalUpdateDetail,
  keystone_identification: KeystoneDetail,
  tag_promote: TagPromoteDetail,
}

const OUTPUT_RENDERERS: Record<string, Renderer> = {
  recall: RecallDetail,
  prepare: RecallDetail,
  reconsolidation: ReconsolidationDetail,
}

const EVOLUTION_RENDERERS: Record<string, Renderer> = {
  learning2: Learning2Detail,
  learning3: Learning3Detail,
}

const CONFIG_RENDERERS: Record<string, Renderer> = {}

const TYPE_DISPATCH: Record<string, Record<string, Renderer>> = {
  memory: MEMORY_RENDERERS,
  think_associate: THINK_ASSOCIATE_RENDERERS,
  think_emerge: THINK_EMERGE_RENDERERS,
  output: OUTPUT_RENDERERS,
  evolution: EVOLUTION_RENDERERS,
  config: CONFIG_RENDERERS,
}

/* ── Main component ─────────────────────────────────────── */

export function TimelineExpanded({
  event,
  onNodeClick,
}: {
  event: TimelineEvent
  onNodeClick: (id: string) => void
}) {
  const detail = useMemo(() => safeJsonParse<Record<string, unknown>>(event.detail, {}), [event.detail])
  const rawNodeIds = useMemo(() => safeJsonParse<string[]>(event.node_ids, []), [event.node_ids])

  const allNodeIds = useMemo(
    () => collectNodeIds(rawNodeIds, detail),
    [rawNodeIds, detail],
  )

  const { nodeMap } = useResolvedNodes(allNodeIds, true)

  // Config: check for circuit breaker subtypes via title key
  if (event.type === 'config') {
    const titleObj = safeJsonParse<{ key?: string }>(event.title, {})
    if (titleObj.key === 'circuit_breaker_on') {
      return <CircuitBreakerOnDetail detail={detail} nodeIds={allNodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
    }
    if (titleObj.key === 'circuit_breaker_off') {
      return <CircuitBreakerOffDetail />
    }
    return <GenericDetail detail={detail} nodeIds={allNodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
  }

  const rendererMap = TYPE_DISPATCH[event.type]
  const SubRenderer = rendererMap?.[event.subtype]

  if (SubRenderer) {
    return <SubRenderer detail={detail} nodeIds={allNodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
  }

  // Fallback: generic key-value display
  return <GenericDetail detail={detail} nodeIds={allNodeIds} nodeMap={nodeMap} onNodeClick={onNodeClick} />
}
