import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SOURCE_TOOL_LABELS } from '../../lib/constants';
import { useResolvedNodes } from '../../hooks/useResolvedNodes';
/* ── helpers ────────────────────────────────────────────── */
function safeJsonParse(str, fallback) {
    if (!str)
        return fallback;
    try {
        return JSON.parse(str);
    }
    catch {
        return fallback;
    }
}
/** Extract ALL node IDs from both node_ids and detail fields */
function collectNodeIds(nodeIds, detail) {
    const set = new Set(nodeIds);
    for (const key of ['node_id', 'source_id', 'target_id', 'crystal_id']) {
        const v = detail[key];
        if (typeof v === 'string' && v.length > 0)
            set.add(v);
    }
    return [...set];
}
/* ── shared UI blocks ───────────────────────────────────── */
function NodeChips({ nodeIds, nodeMap, onNodeClick, }) {
    if (nodeIds.length === 0)
        return null;
    return (_jsx("div", { className: "flex flex-wrap gap-1.5 mt-2", children: nodeIds.map(id => {
            const info = nodeMap?.[id];
            return (_jsxs("button", { onClick: e => { e.stopPropagation(); onNodeClick(id); }, title: id, className: "inline-flex items-center gap-1 px-2 py-1 bg-white/5 rounded text-xs text-gray-300 hover:bg-white/10 transition-colors max-w-[280px]", children: [_jsx(ExternalLink, { size: 10, className: "text-gray-500 flex-shrink-0" }), _jsx("span", { className: "truncate", children: info ? info.title : id.slice(0, 12) + '...' })] }, id));
        }) }));
}
function Desc({ text }) {
    return _jsx("p", { className: "text-xs text-gray-300 leading-relaxed", children: text });
}
function Field({ label, value }) {
    if (!value)
        return null;
    return (_jsxs("div", { className: "text-xs", children: [_jsxs("span", { className: "text-gray-500", children: [label, ": "] }), _jsx("span", { className: "text-gray-300", children: value })] }));
}
function ContentPreview({ content, label }) {
    if (!content)
        return null;
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
    return (_jsxs("div", { className: "mt-1.5", children: [_jsx("span", { className: "text-[10px] text-gray-500 uppercase tracking-wider", children: label }), _jsx("div", { className: "mt-1 text-xs text-gray-400 bg-white/[0.03] rounded px-2.5 py-2 leading-relaxed whitespace-pre-wrap break-words", children: preview })] }));
}
/* ── Memory subtypes ────────────────────────────────────── */
function DigestDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    const tool = detail.tool;
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Field, { label: t('expanded.summary'), value: detail.input_summary }), _jsx(Field, { label: t('expanded.context'), value: detail.context }), _jsx(Field, { label: t('expanded.tool'), value: tool ? (SOURCE_TOOL_LABELS[tool] ?? tool) : undefined }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function AnnotateDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.annotate', {
                    annotated: detail.annotated ?? 0,
                    skipped: detail.skipped ?? 0,
                    total: detail.total ?? 0,
                }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function DedupMergeDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    const sourceId = detail.source_id;
    const targetId = detail.target_id;
    const sourceName = (sourceId && nodeMap?.[sourceId]?.title) || sourceId?.slice(0, 12);
    const targetName = (targetId && nodeMap?.[targetId]?.title) || targetId?.slice(0, 12);
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.dedup_merge', { source: sourceName, target: targetName }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function LandingDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.landing', {
                    confirmed: detail.confirmed_count ?? 0,
                    pending: detail.pending_count ?? 0,
                }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function SynapticDetail({ detail }) {
    const { t } = useTranslation('timeline');
    return (_jsx(Desc, { text: t('expanded.detail.synaptic', {
            decayed: detail.decayed ?? 0,
            linkDecayed: detail.linkDecayed ?? 0,
            linkDeleted: detail.linkDeleted ?? 0,
        }) }));
}
function DaemonStartDetail({ detail }) {
    const { t } = useTranslation('timeline');
    return (_jsx(Desc, { text: t('expanded.detail.daemon_start', {
            count: detail.task_count ?? 0,
            interval: detail.tick_interval_s ?? 0,
        }) }));
}
function NoteSyncDetail({ detail }) {
    const { t } = useTranslation('timeline');
    const isFirst = detail.is_first_run === true || detail.is_first_run === 1;
    const key = isFirst ? 'expanded.detail.note_sync_first' : 'expanded.detail.note_sync_incremental';
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t(key, {
                    processed: detail.processed ?? 0,
                    skipped: detail.skipped ?? 0,
                    failed: detail.failed ?? 0,
                }) }), Number(detail.failed) > 0 && (_jsxs("span", { className: "text-[10px] text-red-400", children: [String(detail.failed), " ", t('expanded.detail.files_failed')] }))] }));
}
function NoteFileChangeDetail({ detail }) {
    const { t } = useTranslation('timeline');
    return _jsx(Desc, { text: t('expanded.detail.note_file_change', { file: detail.file ?? '' }) });
}
/* ── Think Associate subtypes ───────────────────────────── */
function LinkClassifyDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.link_classify', {
                    evaluated: detail.evaluated ?? 0,
                    confirmed: detail.confirmed ?? 0,
                    deleted: detail.deleted ?? 0,
                }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function RefineLinksDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.refine_links', {
                    checked: detail.checked ?? 0,
                    updated: detail.updated ?? 0,
                    removed: detail.removed ?? 0,
                }) }), typeof detail.query === 'string' && detail.query.length > 0 && (_jsx(Field, { label: t('expanded.detail.trigger_query'), value: String(detail.query) })), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function LinkDiscoverDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.link_discover', {
                    scanned: detail.scanned ?? 0,
                    discovered: detail.discovered ?? 0,
                }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
/* ── Think Emerge subtypes ──────────────────────────────── */
function DivergentScanDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.divergent_scan', {
                    candidates: detail.candidates_evaluated ?? 0,
                    bridges: detail.bridges_created ?? 0,
                }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function CrystalUpdateDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    const action = detail.action;
    const crystalId = detail.crystal_id;
    const summary = detail.summary;
    const analyzed = detail.analyzed;
    const created = detail.crystals_created;
    // temporal-crystal variant (has analyzed + crystals_created)
    if (analyzed != null && created != null) {
        return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.temporal_crystal', { analyzed, created }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
    }
    // divergent-crystal variant (has action + crystal_id)
    const key = action === 'promoted' ? 'expanded.detail.crystal_promoted' : 'expanded.detail.crystal_generated';
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t(key) }), summary && _jsx(Field, { label: t('expanded.detail.content_preview'), value: summary }), crystalId && (_jsx(NodeChips, { nodeIds: [crystalId], nodeMap: nodeMap, onNodeClick: onNodeClick }))] }));
}
function KeystoneDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.keystone', {
                    total: detail.total_active ?? 0,
                    marked: detail.keystones_marked ?? 0,
                }) }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function TagPromoteDetail({ detail }) {
    const { t } = useTranslation('timeline');
    return (_jsx(Desc, { text: t('expanded.detail.tag_promote', {
            promoted: detail.promoted ?? 0,
            created: detail.links_created ?? 0,
            updated: detail.links_updated ?? 0,
            removed: detail.links_removed ?? 0,
        }) }));
}
/* ── Output subtypes ────────────────────────────────────── */
function RecallDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    const tool = detail.tool;
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Field, { label: t('expanded.detail.recall_query'), value: detail.input_summary }), _jsx(Field, { label: t('expanded.context'), value: detail.context }), _jsx(Field, { label: t('expanded.tool'), value: tool ? (SOURCE_TOOL_LABELS[tool] ?? tool) : undefined }), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
function ReconsolidationDetail({ detail, nodeMap, onNodeClick }) {
    const { t } = useTranslation('timeline');
    const nodeId = detail.node_id;
    const version = detail.version != null ? String(detail.version) : undefined;
    const reason = (detail.reason ?? detail.change_reason);
    const content = detail.content;
    const nodeName = (nodeId && nodeMap?.[nodeId]?.title) || nodeId?.slice(0, 20);
    return (_jsxs("div", { className: "space-y-1.5", children: [nodeName && (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-xs text-gray-300 font-medium", children: nodeName }), version && (_jsxs("span", { className: "px-1.5 py-0.5 bg-white/5 rounded text-[10px] text-gray-400", children: ["v", version] }))] })), _jsx(Field, { label: t('expanded.detail.reconsolidation_reason'), value: reason }), _jsx(ContentPreview, { content: content, label: t('expanded.detail.content_preview') }), nodeId && (_jsxs("button", { onClick: () => onNodeClick(nodeId), className: "mt-1 inline-flex items-center gap-1 px-2.5 py-1 bg-teal-500/10 text-teal-300 rounded text-xs font-medium hover:bg-teal-500/20 transition-colors", children: [_jsx(ExternalLink, { size: 10 }), t('expanded.viewNode')] }))] }));
}
/* ── Evolution subtypes ─────────────────────────────────── */
function Learning2Detail({ detail }) {
    const { t } = useTranslation('timeline');
    const action = detail.action;
    const strategy = detail.strategy ?? '';
    const param = detail.param ?? '';
    const oldVal = detail.old_value != null ? String(detail.old_value) : '';
    const newVal = detail.new_value != null ? String(detail.new_value) : '';
    const reason = (detail.reason ?? detail.why);
    const trend = detail.trend;
    if (action === 'rolled_back') {
        return (_jsx(Desc, { text: t('expanded.detail.learning2_rolled_back', {
                strategy, param, old: oldVal, new: newVal,
            }) }));
    }
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Desc, { text: t('expanded.detail.learning2_adjusted', {
                    strategy, param, old: oldVal, new: newVal,
                }) }), trend && _jsx(Field, { label: t('expanded.detail.trend'), value: trend }), reason && _jsx(Field, { label: t('expanded.detail.learning2_reason'), value: reason })] }));
}
function Learning3Detail({ detail }) {
    const { t } = useTranslation('timeline');
    const signals = detail.signals;
    const count = detail.recommendations_count;
    return (_jsxs("div", { className: "space-y-1.5", children: [signals && Object.keys(signals).length > 0 && (_jsx("div", { className: "bg-white/[0.03] rounded px-2.5 py-2", children: Object.entries(signals).map(([name, value]) => (_jsxs("div", { className: "flex justify-between text-xs py-0.5", children: [_jsx("span", { className: "text-gray-500", children: name }), _jsx("span", { className: "text-gray-300 tabular-nums", children: String(value) })] }, name))) })), count != null && (_jsx(Desc, { text: t('expanded.detail.learning3_recommendations', { count }) }))] }));
}
/* ── Config subtypes ────────────────────────────────────── */
function CircuitBreakerOnDetail({ detail }) {
    const { t } = useTranslation('timeline');
    return (_jsx(Desc, { text: t('expanded.detail.circuit_breaker_on', {
            failures: detail.failures ?? 0,
            minutes: detail.cooldownMinutes ?? 0,
        }) }));
}
function CircuitBreakerOffDetail() {
    const { t } = useTranslation('timeline');
    return _jsx(Desc, { text: t('expanded.detail.circuit_breaker_off') });
}
function GenericDetail({ detail, nodeIds, nodeMap, onNodeClick }) {
    const entries = Object.entries(detail).filter(([k]) => !['node_ids'].includes(k));
    return (_jsxs("div", { className: "space-y-1.5", children: [entries.map(([key, value]) => (_jsx(Field, { label: key, value: value != null ? String(value) : undefined }, key))), _jsx(NodeChips, { nodeIds: nodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick })] }));
}
const MEMORY_RENDERERS = {
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
};
const THINK_ASSOCIATE_RENDERERS = {
    link_classify: LinkClassifyDetail,
    refine_links: RefineLinksDetail,
    link_discover: LinkDiscoverDetail,
};
const THINK_EMERGE_RENDERERS = {
    divergent_scan: DivergentScanDetail,
    crystal_update: CrystalUpdateDetail,
    keystone_identification: KeystoneDetail,
    tag_promote: TagPromoteDetail,
};
const OUTPUT_RENDERERS = {
    recall: RecallDetail,
    prepare: RecallDetail,
    reconsolidation: ReconsolidationDetail,
};
const EVOLUTION_RENDERERS = {
    learning2: Learning2Detail,
    learning3: Learning3Detail,
};
const CONFIG_RENDERERS = {};
const TYPE_DISPATCH = {
    memory: MEMORY_RENDERERS,
    think_associate: THINK_ASSOCIATE_RENDERERS,
    think_emerge: THINK_EMERGE_RENDERERS,
    output: OUTPUT_RENDERERS,
    evolution: EVOLUTION_RENDERERS,
    config: CONFIG_RENDERERS,
};
/* ── Main component ─────────────────────────────────────── */
export function TimelineExpanded({ event, onNodeClick, }) {
    const detail = useMemo(() => safeJsonParse(event.detail, {}), [event.detail]);
    const rawNodeIds = useMemo(() => safeJsonParse(event.node_ids, []), [event.node_ids]);
    const allNodeIds = useMemo(() => collectNodeIds(rawNodeIds, detail), [rawNodeIds, detail]);
    const { nodeMap } = useResolvedNodes(allNodeIds, true);
    // Config: check for circuit breaker subtypes via title key
    if (event.type === 'config') {
        const titleObj = safeJsonParse(event.title, {});
        if (titleObj.key === 'circuit_breaker_on') {
            return _jsx(CircuitBreakerOnDetail, { detail: detail, nodeIds: allNodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick });
        }
        if (titleObj.key === 'circuit_breaker_off') {
            return _jsx(CircuitBreakerOffDetail, {});
        }
        return _jsx(GenericDetail, { detail: detail, nodeIds: allNodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick });
    }
    const rendererMap = TYPE_DISPATCH[event.type];
    const SubRenderer = rendererMap?.[event.subtype];
    if (SubRenderer) {
        return _jsx(SubRenderer, { detail: detail, nodeIds: allNodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick });
    }
    // Fallback: generic key-value display
    return _jsx(GenericDetail, { detail: detail, nodeIds: allNodeIds, nodeMap: nodeMap, onNodeClick: onNodeClick });
}
