import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Check, FolderOpen, Loader2, Pencil, RefreshCw, X, } from 'lucide-react';
import { NumberField } from '../shared';
export function NoteSourceDetailPanel({ source, onRefetch, }) {
    const { t } = useTranslation('settings');
    const [editing, setEditing] = useState(false);
    const [newName, setNewName] = useState(source.name);
    const [pollInterval, setPollInterval] = useState(source.poll_interval);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [importing, setImporting] = useState(false);
    const intervalInitialized = useRef(false);
    // 切换 source 时,所有派生自 source.* 的 state 都要重置;否则 source A 的旧值
    // 会被 effect 当作"用户改动"写到 source B 上 (例:展开 A 看到 poll=120,折叠后
    // 展开 B 看到的仍是 120,debounced effect 把 B 的 poll_interval 覆盖为 120)。
    useEffect(() => {
        intervalInitialized.current = false;
        setPollInterval(source.poll_interval);
        setNewName(source.name);
        setEditing(false);
        setTestResult(null);
    }, [source.id, source.poll_interval, source.name]);
    useEffect(() => {
        if (!intervalInitialized.current) {
            intervalInitialized.current = true;
            return;
        }
        const timer = setTimeout(async () => {
            await window.api.noteSources.update(source.id, { pollInterval });
        }, 500);
        return () => clearTimeout(timer);
    }, [pollInterval, source.id]);
    const handleRename = async () => {
        if (newName.trim() && newName !== source.name) {
            await window.api.noteSources.update(source.id, { name: newName.trim() });
            onRefetch();
        }
        setEditing(false);
    };
    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await window.api.noteSources.test(source.tool_type, source.path);
            setTestResult(result);
        }
        catch {
            setTestResult({ accessible: false, fileCount: 0 });
        }
        setTesting(false);
    };
    const handleRescan = async () => {
        setImporting(true);
        try {
            await window.api.noteSources.triggerImport(source.id);
        }
        catch (err) {
            console.error('重新扫描失败:', err);
        }
        setImporting(false);
    };
    const handleArchive = async () => {
        await window.api.noteSources.archive(source.id);
        onRefetch();
    };
    return (_jsxs("div", { className: "ml-6 mr-3 mb-3 p-3 bg-white/[0.02] rounded-lg border border-white/5 space-y-3", children: [_jsx("div", { className: "flex items-center gap-2", children: editing ? (_jsxs("div", { className: "flex items-center gap-2 flex-1", children: [_jsx("input", { value: newName, onChange: e => setNewName(e.target.value), onKeyDown: e => { if (e.key === 'Enter')
                                handleRename(); if (e.key === 'Escape')
                                setEditing(false); }, autoFocus: true, className: "flex-1 px-2 py-1 text-xs bg-white/[0.06] border border-white/[0.1] rounded text-gray-200 focus:outline-none focus:border-blue-500/50" }), _jsx("button", { onClick: handleRename, className: "text-emerald-400 hover:text-emerald-300", children: _jsx(Check, { size: 12 }) }), _jsx("button", { onClick: () => setEditing(false), className: "text-gray-500 hover:text-gray-300", children: _jsx(X, { size: 12 }) })] })) : (_jsxs("button", { onClick: () => { setNewName(source.name); setEditing(true); }, className: "flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors", children: [_jsx(Pencil, { size: 10 }), t('noteSync.detail.rename')] })) }), _jsxs("div", { children: [_jsx("label", { className: "text-[10px] text-gray-500 mb-1 block", children: t('noteSync.detail.watchPath') }), _jsxs("div", { className: "flex gap-2", children: [_jsx("div", { className: "flex-1 px-3 py-2 rounded-lg text-xs text-gray-300 bg-white/[0.04] border border-white/[0.06] truncate", children: source.tool_type === 'apple-notes'
                                    ? source.path.split('?')[0]
                                    : source.tool_type === 'notion'
                                        ? `ntn_${'*'.repeat(8)}`
                                        : source.path }), source.tool_type !== 'apple-notes' && source.tool_type !== 'notion' && (_jsxs("button", { onClick: async () => {
                                    const folder = await window.api.config.selectFolder();
                                    if (folder) {
                                        await window.api.noteSources.update(source.id, { path: folder });
                                        onRefetch();
                                    }
                                }, className: "flex items-center gap-1.5 px-3 py-2 text-xs bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] rounded-lg text-gray-300 transition-colors whitespace-nowrap", children: [_jsx(FolderOpen, { size: 12 }), t('noteSync.detail.changePath')] }))] })] }), _jsx(NumberField, { label: t('noteSync.detail.pollInterval'), tip: t('noteSync.detail.pollIntervalTip'), value: pollInterval, onChange: setPollInterval, unit: t('noteSync.detail.seconds'), step: 10 }), _jsxs("div", { className: "flex items-center gap-3 pt-1", children: [_jsxs("button", { onClick: handleTest, disabled: testing, className: "flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50", children: [testing && _jsx(Loader2, { size: 12, className: "animate-spin" }), t('noteSync.detail.testConnection')] }), _jsxs("button", { onClick: handleRescan, disabled: importing, className: "flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50", children: [importing ? _jsx(Loader2, { size: 12, className: "animate-spin" }) : _jsx(RefreshCw, { size: 12 }), t('noteSync.detail.rescan')] }), testResult && (_jsx("span", { className: `text-[11px] ${testResult.accessible ? 'text-emerald-400' : 'text-red-400'}`, children: testResult.accessible
                            ? t('noteSync.detail.testAccessible', { count: testResult.fileCount })
                            : t('noteSync.detail.testInaccessible') }))] }), _jsx("div", { className: "pt-2 border-t border-white/5", children: _jsxs("button", { onClick: handleArchive, className: "flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-yellow-400 transition-colors", children: [_jsx(Archive, { size: 10 }), t('noteSync.detail.archive')] }) })] }));
}
