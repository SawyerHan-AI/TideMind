import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { brand, btnText } from '../../lib/tokens';
import { Download, Save, Calendar, FileText, Loader2, ArrowUpCircle, ArrowDownCircle, Tag, RotateCcw, Archive, ChevronLeft, ChevronRight, Check, } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';
import { Section } from './shared';
import { Skeleton } from '../Skeleton';
import { formatBytes, truncate } from '../../lib/format';
import { useFormatters } from '../../hooks/useFormatters';
export function DataManagement() {
    const { t } = useTranslation('settings');
    const [subTab, setSubTab] = useState('storage');
    const SUB_TABS = [
        { key: 'storage', label: t('data.subtabs.storage') },
        { key: 'logs', label: t('data.subtabs.logs') },
        { key: 'tags', label: t('data.subtabs.tags') },
        { key: 'archived', label: t('data.subtabs.archive') },
    ];
    return (_jsxs("div", { className: "space-y-4 max-w-3xl", children: [_jsx("div", { className: "flex items-center gap-2", children: SUB_TABS.map(tab => (_jsx("button", { onClick: () => setSubTab(tab.key), className: `px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${subTab === tab.key ? 'text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'}`, style: subTab === tab.key ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}, children: tab.label }, tab.key))) }), _jsxs(motion.div, { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 }, className: "space-y-6", children: [subTab === 'storage' && (_jsxs(_Fragment, { children: [_jsx(ExportSection, {}), _jsx(StorageStats, {})] })), subTab === 'logs' && _jsx(StreamLogBrowser, {}), subTab === 'tags' && _jsx(TagManagement, {}), subTab === 'archived' && _jsx(ArchivedNodes, {})] }, subTab)] }));
}
function ExportSection() {
    const { t } = useTranslation('settings');
    const { data: allTags } = useIPC(() => window.api.nodes.tags());
    const coreTags = (allTags ?? []).filter(tag => tag.isCore);
    const [format, setFormat] = useState('markdown');
    const [scope, setScope] = useState('all');
    const [selectedTag, setSelectedTag] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [exporting, setExporting] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [result, setResult] = useState(null);
    const handleExport = async () => {
        setExporting(true);
        setResult(null);
        setSaved(false);
        try {
            const scopeParam = {};
            if (scope === 'tag' && selectedTag)
                scopeParam.tag = selectedTag;
            if (scope === 'date') {
                if (dateFrom)
                    scopeParam.after = dateFrom;
                if (dateTo)
                    scopeParam.before = dateTo;
            }
            if (format === 'markdown') {
                const md = await window.api.export.markdown(scopeParam);
                setResult(md);
            }
            else {
                const json = await window.api.export.json(scopeParam);
                setResult(JSON.stringify(json, null, 2));
            }
        }
        catch (err) {
            setResult(t('data.export.exportFailed', { message: err.message }));
        }
        finally {
            setExporting(false);
        }
    };
    const handleSaveFile = async () => {
        if (!result)
            return;
        setSaving(true);
        try {
            const today = new Date().toISOString().slice(0, 10);
            const ext = format === 'json' ? 'json' : 'md';
            const defaultName = `tidemind-export-${today}.${ext}`;
            const res = await window.api.export.saveFile(result, defaultName);
            if (res?.saved)
                setSaved(true);
        }
        catch { /* ignore */ }
        finally {
            setSaving(false);
        }
    };
    return (_jsx(Section, { title: t('data.export.title'), children: _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "text-xs text-gray-400 mb-2 block", children: t('data.export.format') }), _jsx("div", { className: "flex items-center gap-3", children: ['markdown', 'json'].map(f => (_jsxs("label", { className: "flex items-center gap-1.5 cursor-pointer", children: [_jsx("input", { type: "radio", name: "export-format", checked: format === f, onChange: () => setFormat(f), className: "accent-indigo-400" }), _jsx("span", { className: "text-xs text-gray-300", children: f === 'markdown' ? 'Markdown' : 'JSON' })] }, f))) })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs text-gray-400 mb-2 block", children: t('data.export.scope') }), _jsx("div", { className: "flex items-center gap-3", children: ([
                                { value: 'all', label: t('data.export.scopeAll') },
                                { value: 'tag', label: t('data.export.scopeByTag') },
                                { value: 'date', label: t('data.export.scopeByDate') },
                            ]).map(s => (_jsxs("label", { className: "flex items-center gap-1.5 cursor-pointer", children: [_jsx("input", { type: "radio", name: "export-scope", checked: scope === s.value, onChange: () => setScope(s.value), className: "accent-indigo-400" }), _jsx("span", { className: "text-xs text-gray-300", children: s.label })] }, s.value))) }), scope === 'all' && (_jsx("p", { className: "text-[10px] text-gray-500 mt-1.5", children: t('data.export.fullExportNote') }))] }), scope === 'tag' && (_jsxs("div", { children: [_jsx("label", { className: "text-xs text-gray-400 mb-1 block", children: t('data.export.tag') }), _jsxs("select", { value: selectedTag, onChange: e => setSelectedTag(e.target.value), className: "w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50", children: [_jsx("option", { value: "", children: t('data.export.selectTag') }), coreTags.map(item => (_jsxs("option", { value: item.tag, children: [item.tag, " (", item.count, ")"] }, item.tag)))] })] })), scope === 'date' && (_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("div", { className: "flex-1", children: [_jsx("label", { className: "text-xs text-gray-400 mb-1 block", children: t('data.export.startDate') }), _jsx("input", { type: "date", value: dateFrom, onChange: e => setDateFrom(e.target.value), className: "w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50" })] }), _jsxs("div", { className: "flex-1", children: [_jsx("label", { className: "text-xs text-gray-400 mb-1 block", children: t('data.export.endDate') }), _jsx("input", { type: "date", value: dateTo, onChange: e => setDateTo(e.target.value), className: "w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50" })] })] })), _jsxs("button", { onClick: handleExport, disabled: exporting || (scope === 'tag' && !selectedTag), className: "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50", style: { background: brand.gradient, color: btnText.onBrand }, children: [exporting ? _jsx(Loader2, { size: 14, className: "animate-spin" }) : _jsx(Download, { size: 14 }), exporting ? t('data.export.exporting') : t('common:actions.export')] }), result && (_jsxs("div", { className: "mt-3", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx("span", { className: "text-xs text-gray-400", children: t('data.export.resultPreview') }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { onClick: handleSaveFile, disabled: saving, className: "flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50", children: [saved ? _jsx(Check, { size: 10 }) : saving ? _jsx(Loader2, { size: 10, className: "animate-spin" }) : _jsx(Save, { size: 10 }), saved ? t('data.export.saved') : t('data.export.saveToFile')] }), _jsx("button", { onClick: () => {
                                                navigator.clipboard.writeText(result);
                                            }, className: "text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors", children: t('common:actions.copy') })] })] }), _jsxs("pre", { className: "max-h-60 overflow-auto px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg text-xs text-gray-300 font-mono whitespace-pre-wrap", children: [result.slice(0, 5000), result.length > 5000 && `\n... (${t('data.export.truncated')})`] })] }))] }) }));
}
function parseStreamEntries(markdown) {
    if (!markdown.trim())
        return [];
    const entries = [];
    const sections = markdown.split(/^## /m).filter(Boolean);
    for (const section of sections) {
        const lines = section.split('\n');
        const header = lines[0]?.trim();
        if (!header)
            continue;
        const parts = header.split(' · ').map(s => s.trim());
        const time = parts[0] ?? '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(time))
            continue;
        const tool = parts[1];
        const session = parts[2];
        const bodyLines = lines.slice(1);
        let project;
        const contentLines = [];
        for (const line of bodyLines) {
            const projectMatch = line.match(/\[project:\s*(.+?)\]/);
            if (projectMatch) {
                project = projectMatch[1];
                continue;
            }
            if (line.trim() === '---')
                continue;
            contentLines.push(line);
        }
        const content = contentLines.join('\n').trim();
        if (!content && !time)
            continue;
        entries.push({ time, tool, session, project, content });
    }
    return entries;
}
function StreamLogBrowser() {
    const { t } = useTranslation('settings');
    const { data: dates, loading: datesLoading } = useIPC(() => window.api.stream.dates());
    const [selectedDate, setSelectedDate] = useState(null);
    const activeDate = selectedDate ?? dates?.[0] ?? null;
    const { data: content, loading: contentLoading } = useIPC(() => activeDate ? window.api.stream.get(activeDate) : Promise.resolve(''), [activeDate]);
    const entries = parseStreamEntries(content ?? '');
    return (_jsx(Section, { title: t('data.logs.title'), children: _jsxs("div", { className: "flex gap-4 h-80", children: [_jsxs("div", { className: "w-36 flex-shrink-0 space-y-1 overflow-auto", children: [_jsxs("h4", { className: "text-xs font-medium text-gray-400 mb-2 flex items-center gap-1.5", children: [_jsx(Calendar, { size: 12 }), t('data.logs.date')] }), datesLoading ? (Array.from({ length: 5 }).map((_, i) => _jsx(Skeleton, { className: "h-8 w-full" }, i))) : dates?.length === 0 ? (_jsx("p", { className: "text-xs text-gray-500 py-4", children: t('data.logs.noLogs') })) : (dates?.map((date) => (_jsx("button", { onClick: () => setSelectedDate(date), className: `w-full text-left px-2 py-1.5 rounded-lg text-xs transition-all duration-150 ${activeDate === date
                                ? 'text-white font-medium'
                                : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'}`, style: activeDate === date ? { background: 'var(--selected-bg)' } : {}, children: date }, date))))] }), _jsx("div", { className: "flex-1 overflow-auto", children: !activeDate ? (_jsxs("div", { className: "flex flex-col items-center justify-center h-full text-gray-500", children: [_jsx(FileText, { size: 32, className: "mb-2 opacity-50" }), _jsx("p", { className: "text-sm", children: t('data.logs.selectDate') })] })) : contentLoading ? (_jsx("div", { className: "space-y-4", children: Array.from({ length: 3 }).map((_, i) => _jsx(Skeleton, { className: "h-20 w-full rounded-xl" }, i)) })) : entries.length === 0 ? (_jsx("div", { className: "text-center py-12 text-gray-500 text-sm", children: t('data.logs.noEntries') })) : (_jsx(motion.div, { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3 }, className: "space-y-2", children: entries.map((entry, i) => (_jsxs("div", { className: "bg-white/[0.02] rounded-lg p-3 border border-white/5", children: [_jsxs("div", { className: "flex items-center gap-2 mb-1.5", children: [_jsx("span", { className: "text-xs text-indigo-400 font-mono", children: entry.time }), entry.tool && (_jsx("span", { className: "text-[10px] text-gray-500 bg-white/5 px-1.5 py-0.5 rounded", children: entry.tool }))] }), entry.project && (_jsxs("div", { className: "text-[10px] text-teal-400 mb-1", children: ["[project: ", entry.project, "]"] })), _jsx("div", { className: "text-xs text-gray-300 whitespace-pre-wrap leading-relaxed", children: truncate(entry.content, 300) })] }, i))) }, activeDate)) })] }) }));
}
// ============================================================
// Storage Stats
// ============================================================
function StorageStats() {
    const { t } = useTranslation('settings');
    const { data: storage } = useIPC(() => window.api.health.storage());
    return (_jsx(Section, { title: t('data.storage.title'), children: _jsxs("div", { className: "space-y-2 text-xs text-gray-400", children: [_jsxs("div", { className: "flex items-center", children: [t('data.storage.dbSize'), _jsx("span", { className: "text-gray-200 ml-2", children: storage ? formatBytes(storage.dbSize) : '-' })] }), _jsxs("div", { className: "flex items-center", children: [t('data.storage.streamFiles'), _jsx("span", { className: "text-gray-200 ml-2", children: storage?.streamFiles ?? 0 })] }), _jsxs("div", { className: "flex items-start", children: [t('data.storage.dataDir'), _jsx("span", { className: "text-gray-200 font-mono ml-2 break-all", children: storage?.path ?? '-' })] })] }) }));
}
// ============================================================
// Tag Management
// ============================================================
function TagManagement() {
    const { t } = useTranslation('settings');
    const { data: allTags, loading, refetch } = useIPC(() => window.api.nodes.tags());
    const [operating, setOperating] = useState(null);
    const coreTags = (allTags ?? []).filter(tag => tag.isCore).sort((a, b) => b.count - a.count);
    const normalTags = (allTags ?? []).filter(tag => !tag.isCore).sort((a, b) => b.count - a.count);
    const handlePromote = async (tag) => {
        setOperating(tag);
        try {
            await window.api.nodes.promoteTag(tag);
            refetch();
        }
        catch { /* ignore */ }
        finally {
            setOperating(null);
        }
    };
    const handleDemote = async (tag) => {
        setOperating(tag);
        try {
            await window.api.nodes.demoteTag(tag);
            refetch();
        }
        catch { /* ignore */ }
        finally {
            setOperating(null);
        }
    };
    if (loading) {
        return (_jsx(Section, { title: t('data.tags.title'), children: _jsx("div", { className: "space-y-2", children: Array.from({ length: 4 }).map((_, i) => _jsx(Skeleton, { className: "h-8 w-full" }, i)) }) }));
    }
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs(Section, { title: t('data.tags.coreTags'), children: [_jsx("p", { className: "text-xs text-gray-500 mb-3", children: t('data.tags.coreDesc') }), coreTags.length === 0 ? (_jsx("p", { className: "text-xs text-gray-500 py-4 text-center", children: t('data.tags.noCoreTags') })) : (_jsx("div", { className: "space-y-1", children: coreTags.map(item => (_jsxs("div", { className: "flex items-center gap-3 px-3 py-2 hover:bg-white/[0.03] rounded-lg transition-colors", children: [_jsx(Tag, { size: 12, className: "text-indigo-400 flex-shrink-0" }), _jsx("span", { className: "flex-1 text-xs text-gray-200 truncate", children: item.tag }), _jsxs("span", { className: "text-[10px] text-gray-500 tabular-nums flex-shrink-0", children: [item.count, " ", t('common:units.items')] }), _jsxs("button", { onClick: () => handleDemote(item.tag), disabled: operating === item.tag, className: "flex items-center gap-1 px-2 py-1 text-[10px] text-gray-400 hover:text-orange-300 hover:bg-orange-500/10 rounded transition-colors disabled:opacity-50", children: [operating === item.tag ? (_jsx(Loader2, { size: 10, className: "animate-spin" })) : (_jsx(ArrowDownCircle, { size: 10 })), t('data.tags.demote')] })] }, item.tag))) }))] }), _jsxs(Section, { title: t('data.tags.normalTags'), children: [_jsx("p", { className: "text-xs text-gray-500 mb-3", children: t('data.tags.normalDesc') }), normalTags.length === 0 ? (_jsx("p", { className: "text-xs text-gray-500 py-4 text-center", children: t('data.tags.noNormalTags') })) : (_jsx("div", { className: "space-y-1", children: normalTags.map(item => (_jsxs("div", { className: "flex items-center gap-3 px-3 py-2 hover:bg-white/[0.03] rounded-lg transition-colors", children: [_jsx(Tag, { size: 12, className: "text-gray-500 flex-shrink-0" }), _jsx("span", { className: "flex-1 text-xs text-gray-300 truncate", children: item.tag }), _jsxs("span", { className: "text-[10px] text-gray-500 tabular-nums flex-shrink-0", children: [item.count, " ", t('common:units.items')] }), _jsxs("button", { onClick: () => handlePromote(item.tag), disabled: operating === item.tag, className: "flex items-center gap-1 px-2 py-1 text-[10px] text-indigo-400 hover:text-indigo-300 hover:bg-indigo-400/10 rounded transition-colors disabled:opacity-50", children: [operating === item.tag ? (_jsx(Loader2, { size: 10, className: "animate-spin" })) : (_jsx(ArrowUpCircle, { size: 10 })), t('data.tags.promote')] })] }, item.tag))) }))] })] }));
}
// ============================================================
// 归档数据
// ============================================================
const TYPE_LABEL_KEYS = {
    fact: { key: 'data.archive.types.fact', cls: 'bg-blue-500/15 text-blue-400' },
    idea: { key: 'data.archive.types.idea', cls: 'bg-amber-500/15 text-amber-400' },
    preference: { key: 'data.archive.types.preference', cls: 'bg-emerald-500/15 text-emerald-400' },
    question: { key: 'data.archive.types.question', cls: 'bg-purple-500/15 text-purple-400' },
};
function NodeRow({ node, actionLabel, actionIcon, actionCls, operating, onAction, }) {
    const { t } = useTranslation('settings');
    const { timeAgo } = useFormatters();
    const typeCfg = TYPE_LABEL_KEYS[node.type] ?? { key: node.type, cls: 'bg-gray-500/15 text-gray-400' };
    return (_jsxs("div", { className: "flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors", children: [_jsx("span", { className: `px-1.5 py-0.5 text-[10px] rounded ${typeCfg.cls} flex-shrink-0`, children: t(typeCfg.key, { defaultValue: node.type }) }), _jsx("span", { className: "flex-1 text-xs text-gray-300 truncate", children: truncate(node.content, 80) }), _jsx("span", { className: "text-[10px] text-gray-500 tabular-nums flex-shrink-0", children: timeAgo(node.created) }), _jsxs("button", { onClick: onAction, disabled: operating, className: `flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors disabled:opacity-50 flex-shrink-0 ${actionCls}`, children: [operating ? _jsx(Loader2, { size: 10, className: "animate-spin" }) : actionIcon, actionLabel] })] }));
}
function Pagination({ page, totalPages, onPageChange }) {
    if (totalPages <= 1)
        return null;
    return (_jsxs("div", { className: "flex items-center justify-center gap-3 pt-3 border-t border-white/5 mt-3", children: [_jsx("button", { onClick: () => onPageChange(Math.max(0, page - 1)), disabled: page === 0, className: "p-1 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors", children: _jsx(ChevronLeft, { size: 14 }) }), _jsxs("span", { className: "text-[10px] text-gray-500 tabular-nums", children: [page + 1, " / ", totalPages] }), _jsx("button", { onClick: () => onPageChange(Math.min(totalPages - 1, page + 1)), disabled: page >= totalPages - 1, className: "p-1 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors", children: _jsx(ChevronRight, { size: 14 }) })] }));
}
function ArchivedNodes() {
    const { t } = useTranslation('settings');
    const PAGE_SIZE = 20;
    const [page, setPage] = useState(0);
    const [operating, setOperating] = useState(null);
    // 已恢复的节点（本地跟踪，刷新后回归正常池）
    const [restoredNodes, setRestoredNodes] = useState([]);
    const { data, loading, refetch } = useIPC(() => window.api.write.listArchived({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }), [page]);
    const archivedNodes = data?.nodes ?? [];
    const total = data?.total ?? 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const handleRestore = async (node) => {
        setOperating(node.id);
        try {
            await window.api.write.unarchiveNode(node.id);
            setRestoredNodes(prev => [node, ...prev]);
            refetch();
        }
        catch (err) {
            console.error('恢复节点失败:', err);
        }
        finally {
            setOperating(null);
        }
    };
    const handleReArchive = async (node) => {
        setOperating(node.id);
        try {
            await window.api.write.reArchiveNode(node.id);
            setRestoredNodes(prev => prev.filter(n => n.id !== node.id));
            refetch();
        }
        catch (err) {
            console.error('归档节点失败:', err);
        }
        finally {
            setOperating(null);
        }
    };
    if (loading) {
        return (_jsx(Section, { title: t('data.subtabs.archive'), children: _jsx("div", { className: "space-y-2", children: Array.from({ length: 4 }).map((_, i) => _jsx(Skeleton, { className: "h-10 w-full" }, i)) }) }));
    }
    return (_jsxs("div", { className: "space-y-6", children: [restoredNodes.length > 0 && (_jsxs(Section, { title: t('data.archive.restored'), children: [_jsx("p", { className: "text-xs text-gray-500 mb-3", children: t('data.archive.restoredDesc') }), _jsx("div", { className: "space-y-1", children: restoredNodes.map(node => (_jsx(NodeRow, { node: node, actionLabel: t('data.archive.archiveBtn'), actionIcon: _jsx(Archive, { size: 10 }), actionCls: "text-orange-400 hover:text-orange-300 hover:bg-orange-500/10", operating: operating === node.id, onAction: () => handleReArchive(node) }, node.id))) })] })), _jsxs(Section, { title: t('data.subtabs.archive'), action: total > 0 ? _jsxs("span", { className: "text-[10px] text-gray-500", children: [total, " ", t('common:units.items')] }) : undefined, children: [_jsx("p", { className: "text-xs text-gray-500 mb-3", children: t('data.archive.archivedDesc') }), archivedNodes.length === 0 && restoredNodes.length === 0 ? (_jsxs("div", { className: "flex flex-col items-center gap-2 py-8 text-gray-500", children: [_jsx(Archive, { size: 20, className: "text-gray-600" }), _jsx("p", { className: "text-xs", children: t('data.archive.noArchived') })] })) : archivedNodes.length === 0 ? (_jsx("p", { className: "text-xs text-gray-500 py-4 text-center", children: t('data.archive.allRestored') })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "space-y-1", children: archivedNodes.map(node => (_jsx(NodeRow, { node: node, actionLabel: t('data.archive.restore'), actionIcon: _jsx(RotateCcw, { size: 10 }), actionCls: "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10", operating: operating === node.id, onAction: () => handleRestore(node) }, node.id))) }), _jsx(Pagination, { page: page, totalPages: totalPages, onPageChange: setPage })] }))] })] }));
}
