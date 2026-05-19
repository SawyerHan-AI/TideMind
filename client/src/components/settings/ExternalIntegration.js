import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '../../hooks/useFormatters';
import { motion } from 'framer-motion';
import { Save, CheckCircle, Loader2, History, RotateCcw } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';
import { AgentIntegration } from './AgentIntegration';
import { NoteSync } from './NoteSync';
const SUB_TAB_KEYS = ['agent', 'note', 'tools'];
function parseSubTab(value) {
    return value && SUB_TAB_KEYS.includes(value) ? value : null;
}
export function ExternalIntegration({ initialSub } = {}) {
    const { t } = useTranslation('settings');
    const [subTab, setSubTab] = useState(() => parseSubTab(initialSub) ?? 'agent');
    useEffect(() => {
        setSubTab(parseSubTab(initialSub) ?? 'agent');
    }, [initialSub]);
    const SUB_TABS = [
        { key: 'agent', label: t('external.subtabs.agent') },
        { key: 'note', label: t('external.subtabs.noteSync') },
        { key: 'tools', label: t('external.subtabs.tools') },
    ];
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "flex items-center gap-2", children: SUB_TABS.map(tab => (_jsx("button", { onClick: () => setSubTab(tab.key), className: `px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${subTab === tab.key ? 'text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'}`, style: subTab === tab.key ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}, children: tab.label }, tab.key))) }), _jsxs(motion.div, { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 }, children: [subTab === 'agent' && _jsx(AgentIntegration, {}), subTab === 'note' && _jsx(NoteSync, {}), subTab === 'tools' && _jsx(ToolInterface, {})] }, subTab)] }));
}
const MCP_TOOLS = [
    { type: 'mcp', name: 'brain_prepare', labelKey: 'external.tools.prepare', hintKey: 'external.tools.prepareHint' },
    { type: 'mcp', name: 'brain_recall', labelKey: 'external.tools.recall', hintKey: 'external.tools.recallHint' },
    { type: 'mcp', name: 'brain_digest', labelKey: 'external.tools.digest', hintKey: 'external.tools.digestHint' },
];
function ToolInterface() {
    const { t } = useTranslation('settings');
    const { data: skills } = useIPC(() => window.api.config.skills());
    const [selected, setSelected] = useState(null);
    // 构建完整列表
    const skillItems = (skills ?? []).map((s) => ({ type: 'skill', name: s.name }));
    // 自动选择第一个
    useEffect(() => {
        if (!selected) {
            setSelected(MCP_TOOLS[0]);
        }
    }, []);
    return (_jsxs("div", { className: "flex gap-4 items-start", children: [_jsxs("div", { className: "w-52 flex-shrink-0 space-y-4", children: [_jsxs("div", { children: [_jsx("div", { className: "px-1 mb-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider", children: t('external.mcpTools') }), _jsx("div", { className: "glass-card rounded-xl overflow-hidden", children: MCP_TOOLS.map(tool => {
                                    const active = selected?.name === tool.name && selected?.type === 'mcp';
                                    return (_jsx("button", { onClick: () => setSelected(tool), className: `w-full text-left px-3 py-2.5 border-b border-white/5 last:border-b-0 transition-colors ${active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`, children: _jsx("span", { className: `text-xs font-medium ${active ? 'text-gray-100' : 'text-gray-400'}`, children: tool.name }) }, tool.name));
                                }) })] }), skillItems.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "px-1 mb-1.5 text-[10px] text-gray-500 font-medium uppercase tracking-wider", children: t('external.skillFiles') }), _jsx("div", { className: "glass-card rounded-xl overflow-hidden", children: skillItems.map(item => {
                                    const active = selected?.name === item.name && selected?.type === 'skill';
                                    return (_jsx("button", { onClick: () => setSelected(item), className: `w-full text-left px-3 py-2.5 border-b border-white/5 last:border-b-0 transition-colors ${active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`, children: _jsx("span", { className: `text-xs font-medium ${active ? 'text-gray-100' : 'text-gray-400'}`, children: item.name }) }, item.name));
                                }) })] }))] }), _jsx("div", { className: "flex-1 min-w-0 mt-5", children: selected ? (selected.type === 'mcp'
                    ? _jsx(McpDetailPanel, { tool: selected }, selected.name)
                    : _jsx(SkillDetailPanel, { name: selected.name }, selected.name)) : (_jsx("div", { className: "glass-card rounded-xl p-8 text-center text-gray-500 text-sm", children: t('external.selectToView') })) })] }));
}
// --- MCP 工具详情面板 ---
function McpDetailPanel({ tool }) {
    const { t } = useTranslation('settings');
    const [description, setDescription] = useState('');
    const [originalDescription, setOriginalDescription] = useState('');
    const [allDescriptions, setAllDescriptions] = useState({});
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [versions, setVersions] = useState([]);
    const [selectedVersion, setSelectedVersion] = useState(null);
    const [showVersions, setShowVersions] = useState(true);
    // 修复 M32(2026-05-09):用 cancelled flag 防止快速切换条目时旧请求覆盖
    // 新条目的数据。原代码无 cancellation,先选 A 后选 B 时,A 的 mcpDescriptions
    // / mcpDescriptionVersions 响应可能晚到把 B 的状态污染。
    useEffect(() => {
        let cancelled = false;
        setSelectedVersion(null);
        window.api.config.mcpDescriptions().then((d) => {
            if (cancelled)
                return;
            setAllDescriptions(d);
            setDescription(d[tool.name] ?? '');
            setOriginalDescription(d[tool.name] ?? '');
        });
        void loadVersionsWithCancel(() => cancelled);
        return () => { cancelled = true; };
    }, [tool.name]);
    const loadVersionsWithCancel = async (isCancelled) => {
        try {
            const v = await window.api.config.mcpDescriptionVersions(tool.name);
            if (isCancelled())
                return;
            setVersions(Array.isArray(v) ? v : []);
        }
        catch {
            if (!isCancelled())
                setVersions([]);
        }
    };
    const loadVersions = async () => {
        try {
            const v = await window.api.config.mcpDescriptionVersions(tool.name);
            setVersions(Array.isArray(v) ? v : []);
        }
        catch {
            setVersions([]);
        }
    };
    const hasChanges = description !== originalDescription;
    const handleSave = async () => {
        setSaving(true);
        try {
            const updated = { ...allDescriptions, [tool.name]: description };
            await window.api.config.mcpDescriptionsUpdate(updated, tool.name);
            setAllDescriptions(updated);
            setSaved(true);
            setOriginalDescription(description);
            loadVersions();
            setTimeout(() => setSaved(false), 2000);
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsxs("div", { className: "glass-card rounded-xl overflow-hidden", children: [_jsxs("div", { className: "px-5 py-4 border-b border-white/5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-2.5", children: [_jsx("span", { className: "text-base font-medium text-gray-100 font-mono", children: tool.name }), _jsx("span", { className: "text-xs text-gray-500", children: t(tool.labelKey) })] }), _jsxs("button", { onClick: () => setShowVersions(!showVersions), className: `flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${showVersions ? 'text-indigo-400 bg-indigo-400/10' : 'text-gray-500 hover:text-gray-300'}`, children: [_jsx(History, { size: 11 }), t('external.versionHistory')] })] }), _jsxs("p", { className: "text-[11px] text-gray-500 mt-1", children: [t(tool.hintKey), t('external.mcpRestartNote')] })] }), _jsx("div", { className: "px-5 py-3", children: _jsxs("div", { className: "flex gap-3", children: [_jsxs("div", { className: "flex-1 flex flex-col min-w-0", children: [_jsx("textarea", { value: selectedVersion ? selectedVersion.content : description, onChange: e => { if (!selectedVersion)
                                        setDescription(e.target.value); }, readOnly: !!selectedVersion, rows: 10, className: `w-full px-4 py-3 bg-white/5 border rounded-xl text-sm text-gray-200 font-mono leading-relaxed resize-none focus:outline-none ${selectedVersion ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 focus:border-indigo-400/50'}` }), _jsxs("div", { className: "flex items-center justify-between mt-3", children: [selectedVersion ? (_jsxs("span", { className: "text-[11px] text-amber-400", children: [t('external.versionPreview', { version: selectedVersion.version }), _jsx("button", { onClick: () => setSelectedVersion(null), className: "ml-2 text-gray-400 hover:text-white", children: t('external.returnToEdit') })] })) : _jsx("div", {}), !selectedVersion && (_jsxs("button", { onClick: handleSave, disabled: saving || !hasChanges, className: "flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50", children: [saving ? _jsx(Loader2, { size: 14, className: "animate-spin" }) : saved ? _jsx(CheckCircle, { size: 14 }) : _jsx(Save, { size: 14 }), saved ? t('common:actions.saved') : t('common:actions.save')] }))] })] }), showVersions && _jsx(VersionTimeline, { versions: versions, selectedVersion: selectedVersion, onSelect: setSelectedVersion })] }) })] }));
}
// --- Skill 详情面板 ---
function SkillDetailPanel({ name }) {
    const { t } = useTranslation('settings');
    const [content, setContent] = useState('');
    const [originalContent, setOriginalContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [showReason, setShowReason] = useState(false);
    const [reason, setReason] = useState('');
    const [versions, setVersions] = useState([]);
    const [selectedVersion, setSelectedVersion] = useState(null);
    const [showVersions, setShowVersions] = useState(true);
    const loadContent = useCallback(async () => {
        const c = await window.api.config.skillContent(name);
        setContent(c);
        setOriginalContent(c);
    }, [name]);
    const loadVersions = useCallback(async () => {
        try {
            const v = await window.api.config.skillVersions(name);
            setVersions(Array.isArray(v) ? v : []);
        }
        catch {
            setVersions([]);
        }
    }, [name]);
    // 修复 M32:同 MCP 面板,加 cancelled flag 防止快速切换条目时旧请求覆盖
    useEffect(() => {
        let cancelled = false;
        setSelectedVersion(null);
        void (async () => {
            const c = await window.api.config.skillContent(name);
            if (cancelled)
                return;
            setContent(c);
            setOriginalContent(c);
        })();
        void (async () => {
            try {
                const v = await window.api.config.skillVersions(name);
                if (cancelled)
                    return;
                setVersions(Array.isArray(v) ? v : []);
            }
            catch {
                if (!cancelled)
                    setVersions([]);
            }
        })();
        return () => { cancelled = true; };
    }, [name]);
    const hasChanges = content !== originalContent;
    const handleSave = async () => {
        if (showReason) {
            setSaving(true);
            try {
                await window.api.config.skillUpdate(name, content, reason || undefined);
                setSaved(true);
                setShowReason(false);
                setReason('');
                setOriginalContent(content);
                loadVersions();
                setTimeout(() => setSaved(false), 2000);
            }
            finally {
                setSaving(false);
            }
        }
        else {
            setShowReason(true);
        }
    };
    const handleRollback = async (version) => {
        try {
            await window.api.config.skillRollback(name, version);
            await loadContent();
            await loadVersions();
            setSelectedVersion(null);
        }
        catch (err) {
            console.error('Rollback failed:', err);
        }
    };
    return (_jsxs("div", { className: "glass-card rounded-xl overflow-hidden", children: [_jsxs("div", { className: "px-5 py-4 border-b border-white/5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("div", { className: "flex items-center gap-2.5", children: _jsxs("span", { className: "text-base font-medium text-gray-100", children: [name, ".md"] }) }), _jsxs("button", { onClick: () => setShowVersions(!showVersions), className: `flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${showVersions ? 'text-indigo-400 bg-indigo-400/10' : 'text-gray-500 hover:text-gray-300'}`, children: [_jsx(History, { size: 11 }), t('external.versionHistory')] })] }), _jsx("p", { className: "text-[11px] text-gray-500 mt-1", children: t('external.skillDescription', { name }) })] }), _jsx("div", { className: "px-5 py-3", children: _jsxs("div", { className: "flex gap-3", children: [_jsxs("div", { className: "flex-1 flex flex-col min-w-0", children: [_jsx("textarea", { value: selectedVersion ? selectedVersion.content : content, onChange: e => { if (!selectedVersion)
                                        setContent(e.target.value); }, readOnly: !!selectedVersion, rows: 14, className: `w-full px-4 py-3 bg-white/5 border rounded-xl text-sm text-gray-200 font-mono leading-relaxed resize-none focus:outline-none ${selectedVersion ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 focus:border-indigo-400/50'}` }), _jsxs("div", { className: "flex items-center justify-between mt-3", children: [selectedVersion ? (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-[11px] text-amber-400", children: t('external.versionPreview', { version: selectedVersion.version }) }), _jsx("button", { onClick: () => setSelectedVersion(null), className: "text-[11px] text-gray-400 hover:text-white", children: t('external.returnToEdit') })] })) : showReason ? (_jsx("div", { className: "flex items-center gap-2 flex-1 mr-3", children: _jsx("input", { value: reason, onChange: e => setReason(e.target.value), placeholder: t('external.changeReason'), className: "flex-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50", autoFocus: true, onKeyDown: e => {
                                                    if (e.key === 'Enter')
                                                        handleSave();
                                                    if (e.key === 'Escape') {
                                                        setShowReason(false);
                                                        setReason('');
                                                    }
                                                } }) })) : _jsx("div", {}), _jsxs("div", { className: "flex items-center gap-2", children: [selectedVersion && (_jsxs("button", { onClick: () => handleRollback(selectedVersion.version), className: "flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors", children: [_jsx(RotateCcw, { size: 12 }), t('external.rollback')] })), !selectedVersion && (_jsxs("button", { onClick: handleSave, disabled: saving || (!hasChanges && !showReason), className: "flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50", children: [saving ? _jsx(Loader2, { size: 14, className: "animate-spin" }) : saved ? _jsx(CheckCircle, { size: 14 }) : _jsx(Save, { size: 14 }), saved ? t('common:actions.saved') : showReason ? t('external.confirmSave') : t('common:actions.save')] }))] })] })] }), showVersions && _jsx(VersionTimeline, { versions: versions, selectedVersion: selectedVersion, onSelect: setSelectedVersion })] }) })] }));
}
// --- 共享：版本时间线 ---
function VersionTimeline({ versions, selectedVersion, onSelect, }) {
    const { t } = useTranslation('settings');
    const { formatShortDate } = useFormatters();
    return (_jsxs("div", { className: "w-56 flex-shrink-0 overflow-y-auto border-l border-white/5 pl-3", children: [_jsx("div", { className: "text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-2", children: t('external.versionHistory') }), versions.length === 0 ? (_jsx("p", { className: "text-[11px] text-gray-600 py-2", children: t('external.noVersions') })) : (_jsx("div", { className: "space-y-1", children: versions.map(v => (_jsxs("button", { onClick: () => onSelect(selectedVersion?.version === v.version ? null : v), className: `w-full text-left px-2 py-2 rounded-md transition-colors ${selectedVersion?.version === v.version
                        ? 'bg-amber-500/10 border border-amber-500/20'
                        : 'hover:bg-white/[0.03] border border-transparent'}`, children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("span", { className: "text-[11px] text-gray-300 font-mono", children: ["v", v.version] }), _jsx("span", { className: `text-[9px] px-1 py-0.5 rounded ${v.changed_by === 'user' ? 'text-indigo-400 bg-indigo-400/10' : v.changed_by === 'learning2' ? 'text-purple-400 bg-purple-500/10' : v.changed_by === 'file_edit' ? 'text-green-400 bg-green-500/10' : 'text-amber-400 bg-amber-500/10'}`, children: t(`external.changedBy.${v.changed_by}`, { defaultValue: v.changed_by }) })] }), v.change_reason && (_jsx("p", { className: "text-[10px] text-gray-500 mt-0.5 truncate", children: v.change_reason })), _jsx("p", { className: "text-[9px] text-gray-600 mt-0.5", children: formatShortDate(v.created) })] }, v.version))) }))] }));
}
