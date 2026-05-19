import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, ChevronDown, ChevronRight, History, Loader2, RotateCcw, Save } from 'lucide-react';
import { useFormatters } from '../../../hooks/useFormatters';
function extractTemplateParams(text) {
    const matches = text.matchAll(/\{\{(\w+)\}\}/g);
    return [...new Set([...matches].map(m => m[1]))];
}
export function EmbeddedStrategyPanel({ name, type = 'system', locked }) {
    const { t } = useTranslation('settings');
    const { formatShortDate } = useFormatters();
    const isUser = type === 'user';
    const [content, setContent] = useState('');
    const [originalContent, setOriginalContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [showReason, setShowReason] = useState(false);
    const [reason, setReason] = useState('');
    const [versions, setVersions] = useState([]);
    const [selectedVersion, setSelectedVersion] = useState(null);
    const [showVersions, setShowVersions] = useState(false);
    const [promptExpanded, setPromptExpanded] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const api = window.api.config;
    const loadContent = useCallback(async () => {
        const c = isUser ? await api.userPromptContent(name) : await api.strategyContent(name);
        setContent(c);
        setOriginalContent(c);
    }, [name, isUser]);
    const loadVersions = useCallback(async () => {
        try {
            const v = isUser ? await api.userPromptVersions(name) : await api.strategyVersions(name);
            setVersions(Array.isArray(v) ? v : []);
        }
        catch {
            setVersions([]);
        }
    }, [name, isUser]);
    useEffect(() => {
        setLoaded(false);
        Promise.all([loadContent(), loadVersions()]).then(() => setLoaded(true)).catch(() => setLoaded(true));
        setSelectedVersion(null);
        setPromptExpanded(false);
    }, [name, isUser]);
    const hasChanges = content !== originalContent;
    const handleSave = async () => {
        if (showReason) {
            setSaving(true);
            try {
                if (isUser) {
                    await api.userPromptUpdate(name, content, reason || undefined);
                }
                else {
                    await api.strategyUpdate(name, content, reason || undefined);
                }
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
            if (isUser) {
                await api.userPromptRollback(name, version);
            }
            else {
                await api.strategyRollback(name, version);
            }
            await loadContent();
            await loadVersions();
            setSelectedVersion(null);
        }
        catch (err) {
            console.error('Rollback failed:', err);
        }
    };
    // User Prompt: 文件不存在且无版本历史时隐藏面板
    if (isUser && loaded && !content && versions.length === 0)
        return null;
    const displayText = selectedVersion
        ? (selectedVersion.content || t('strategy.contentNotRecorded'))
        : content;
    const templateParams = isUser ? extractTemplateParams(displayText) : [];
    const label = isUser ? 'User Prompt' : 'System Prompt';
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("button", { onClick: () => setPromptExpanded(!promptExpanded), className: "flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors", children: [promptExpanded ? _jsx(ChevronDown, { size: 11 }) : _jsx(ChevronRight, { size: 11 }), label, ": ", name, locked && !isUser && _jsx("span", { className: "text-[10px] text-amber-400/70 ml-1", children: t('strategy.autoEvolutionManaged') })] }), _jsxs("button", { onClick: () => { setShowVersions(!showVersions); if (!showVersions) {
                            loadVersions();
                            setPromptExpanded(true);
                        } }, className: `flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${showVersions ? 'text-indigo-400 bg-indigo-400/10' : 'text-gray-500 hover:text-gray-300'}`, children: [_jsx(History, { size: 11 }), t('strategy.versionHistory')] })] }), promptExpanded && (_jsxs("div", { className: "flex gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("textarea", { value: displayText, onChange: e => { if (!selectedVersion)
                                    setContent(e.target.value); }, readOnly: !!selectedVersion, rows: 12, placeholder: isUser ? t('strategy.userPromptPlaceholder') : undefined, className: `w-full px-4 py-3 bg-white/5 border rounded-xl text-sm text-gray-200 font-mono leading-relaxed resize-y focus:outline-none ${selectedVersion ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 focus:border-indigo-400/50'}` }), isUser && templateParams.length > 0 && (_jsxs("div", { className: "flex items-center gap-1.5 mt-2 flex-wrap", children: [_jsx("span", { className: "text-[10px] text-gray-500", children: t('strategy.params') }), templateParams.map(p => (_jsx("span", { className: "text-[10px] px-1.5 py-0.5 rounded bg-indigo-400/10 text-indigo-400 font-mono", children: `{{${p}}}` }, p)))] })), _jsxs("div", { className: "flex items-center justify-between mt-2", children: [selectedVersion ? (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-[11px] text-amber-400", children: t('strategy.previewVersion', { version: selectedVersion.version }) }), _jsx("button", { onClick: () => setSelectedVersion(null), className: "text-[11px] text-gray-400 hover:text-white transition-colors", children: t('strategy.returnToEdit') })] })) : showReason ? (_jsx("div", { className: "flex items-center gap-2 flex-1 mr-3", children: _jsx("input", { value: reason, onChange: e => setReason(e.target.value), placeholder: t('strategy.changeReason'), className: "flex-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50", autoFocus: true, onKeyDown: e => { if (e.key === 'Enter')
                                                handleSave(); if (e.key === 'Escape') {
                                                setShowReason(false);
                                                setReason('');
                                            } } }) })) : _jsx("div", {}), _jsxs("div", { className: "flex items-center gap-2", children: [selectedVersion && (_jsxs("button", { onClick: () => handleRollback(selectedVersion.version), className: "flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors", children: [_jsx(RotateCcw, { size: 12 }), " ", t('strategy.rollbackToVersion')] })), !selectedVersion && (_jsxs("button", { onClick: handleSave, disabled: saving || (!hasChanges && !showReason), className: "flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50", children: [saving ? _jsx(Loader2, { size: 12, className: "animate-spin" }) : saved ? _jsx(CheckCircle, { size: 12 }) : _jsx(Save, { size: 12 }), saved ? t('strategy.saved') : showReason ? t('strategy.confirmSave') : t('strategy.save')] }))] })] })] }), showVersions && (_jsxs("div", { className: "w-48 flex-shrink-0 overflow-y-auto max-h-80 border-l border-white/5 pl-3", children: [_jsx("div", { className: "text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-2", children: t('strategy.versionHistory') }), versions.length === 0 ? (_jsx("p", { className: "text-[11px] text-gray-600 py-2", children: t('strategy.noVersions') })) : (_jsx("div", { className: "space-y-1", children: versions.map(v => (_jsxs("button", { onClick: () => setSelectedVersion(selectedVersion?.version === v.version ? null : v), className: `w-full text-left px-2 py-2 rounded-md transition-colors ${selectedVersion?.version === v.version ? 'bg-amber-500/10 border border-amber-500/20' : 'hover:bg-white/[0.03] border border-transparent'}`, children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("span", { className: "text-[11px] text-gray-300 font-mono", children: ["v", v.version] }), _jsx("span", { className: `text-[9px] px-1 py-0.5 rounded ${v.changed_by === 'user' ? 'text-indigo-300 bg-indigo-400/10' : v.changed_by === 'learning2' ? 'text-indigo-300 bg-indigo-400/10' : v.changed_by === 'file_edit' ? 'text-indigo-300 bg-indigo-400/10' : 'text-indigo-300 bg-indigo-400/10'}`, children: t(`strategy.changedBy.${v.changed_by}`, v.changed_by) })] }), v.change_reason && _jsx("p", { className: "text-[10px] text-gray-500 mt-0.5 truncate", children: v.change_reason }), _jsx("p", { className: "text-[9px] text-gray-600 mt-0.5", children: formatShortDate(v.created) })] }, v.version))) }))] }))] }))] }));
}
