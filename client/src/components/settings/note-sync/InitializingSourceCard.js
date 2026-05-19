import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle, Loader2, Play, RefreshCw, Trash2, XCircle, } from 'lucide-react';
import { useInitSession } from './useInitSession';
const PHASE_KEYS = ['scan', 'preprocess', 'digest', 'explicitLinks', 'annotate', 'landing', 'linkEval', 'keystone', 'emergence'];
export function InitializingSourceCard({ source, onRefetch, }) {
    const { t } = useTranslation('settings');
    const [totalFiles, setTotalFiles] = useState(null);
    const [syncedFiles, setSyncedFiles] = useState(0);
    const { snapshot, uiState, aborting, discarding, start, abort, discard } = useInitSession(source.id, {
        onTerminal: (snap) => {
            // done / aborted / error 终态时同步外层列表（不会阻塞 UI 渲染）
            if (snap.status === 'done') {
                setTimeout(() => onRefetch(), 1500);
            }
        },
    });
    // 加载文件总数与已同步数（与 init session 状态独立）
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const testResult = await window.api.noteSources.test(source.tool_type, source.path);
                if (!cancelled)
                    setTotalFiles(testResult?.fileCount ?? null);
            }
            catch { /* ignore */ }
            try {
                const stats = await window.api.noteSources.stats(source.id);
                if (!cancelled)
                    setSyncedFiles(stats?.fileCount ?? 0);
            }
            catch { /* ignore */ }
        };
        load();
        return () => { cancelled = true; };
    }, [source.id, source.path, source.tool_type]);
    const processedPct = totalFiles && totalFiles > 0
        ? Math.round((syncedFiles / totalFiles) * 100)
        : 0;
    const handleDiscard = async () => {
        if (!confirm(t('noteSync.init.discardConfirm')))
            return;
        await discard();
        onRefetch();
    };
    // ─────────────────────────────────────────────────────────────
    // UI 状态映射（设计文档第八章）
    // ─────────────────────────────────────────────────────────────
    // loading：mount 后第一次 fetch 中
    if (uiState === 'loading') {
        return (_jsx("div", { className: "rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Loader2, { size: 14, className: "text-gray-400 animate-spin flex-shrink-0" }), _jsx("span", { className: "text-xs text-white font-medium", children: source.name })] }) }));
    }
    // running：进度条 + 终止
    if (uiState === 'running' && snapshot) {
        return (_jsxs("div", { className: "rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Loader2, { size: 14, className: "text-indigo-400 animate-spin flex-shrink-0" }), _jsx("span", { className: "text-xs text-white font-medium", children: source.name }), _jsx("span", { className: "text-[10px] text-indigo-400", children: t('noteSync.init.inProgress') })] }), _jsxs("div", { className: "text-xs text-gray-400", children: ["Phase ", snapshot.progress.phase, "/8: ", snapshot.progress.phaseName] }), _jsx("div", { className: "w-full bg-white/[0.06] rounded-full h-2", children: _jsx("div", { className: "bg-indigo-400 h-2 rounded-full transition-all duration-500", style: { width: `${snapshot.progress.total > 0 ? Math.max(5, Math.round((snapshot.progress.current / snapshot.progress.total) * 100)) : 5}%` } }) }), _jsxs("div", { className: "text-xs text-gray-500 text-center", children: [snapshot.progress.current, " / ", snapshot.progress.total] }), _jsx("div", { className: "flex gap-0.5", children: PHASE_KEYS.map((key, i) => (_jsx("div", { className: `h-1 flex-1 rounded-full transition-colors ${i < snapshot.progress.phase ? 'bg-green-500'
                            : i === snapshot.progress.phase ? 'bg-indigo-400'
                                : 'bg-white/[0.06]'}`, title: `Phase ${i}: ${t(`noteSync.init.phase.${key}`)}` }, i))) }), _jsx("button", { onClick: abort, disabled: aborting, className: "w-full py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg transition-colors disabled:opacity-50", children: aborting ? t('noteSync.wizard.aborting') : t('noteSync.wizard.abort') })] }));
    }
    // aborting：等业务真停
    if (uiState === 'aborting') {
        return (_jsx("div", { className: "rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Loader2, { size: 14, className: "text-amber-400 animate-spin flex-shrink-0" }), _jsx("span", { className: "text-xs text-white font-medium", children: source.name }), _jsx("span", { className: "text-[10px] text-amber-400", children: t('noteSync.init.aborting') })] }) }));
    }
    // aborted：显示原因 + 继续/丢弃
    if (uiState === 'aborted' && snapshot) {
        const reasonKey = snapshot.abortReason ?? 'user';
        return (_jsxs("div", { className: "rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(XCircle, { size: 14, className: "text-amber-400 flex-shrink-0" }), _jsx("span", { className: "text-xs text-white font-medium", children: source.name }), _jsx("span", { className: "text-[10px] text-amber-400", children: t(`noteSync.init.abortedBy.${reasonKey}`, { defaultValue: t('noteSync.init.interrupted') }) })] }), totalFiles !== null && (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-[11px] text-gray-400", children: t('noteSync.init.processedFiles', { current: syncedFiles, total: totalFiles }) }), _jsx("div", { className: "w-full bg-white/[0.06] rounded-full h-1.5", children: _jsx("div", { className: "bg-amber-400 h-1.5 rounded-full transition-all", style: { width: `${Math.max(2, processedPct)}%` } }) })] })), _jsxs("div", { className: "flex items-center gap-3 pt-1", children: [_jsxs("button", { onClick: start, className: "flex items-center gap-2 px-4 py-2 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg transition-colors", children: [_jsx(Play, { size: 12 }), t('noteSync.init.continueInit')] }), _jsxs("button", { onClick: handleDiscard, disabled: discarding, className: "flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50", children: [_jsx(Trash2, { size: 12 }), t('noteSync.init.discard')] })] })] }));
    }
    // error：显示错误 + 重试
    if (uiState === 'error' && snapshot) {
        return (_jsxs("div", { className: "rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(AlertCircle, { size: 14, className: "text-red-400 flex-shrink-0" }), _jsx("span", { className: "text-xs text-white font-medium", children: source.name }), _jsx("span", { className: "text-[10px] text-red-400", children: t('noteSync.wizard.initFailed') })] }), snapshot.error && _jsx("div", { className: "text-xs text-red-300", children: snapshot.error }), _jsxs("div", { className: "flex items-center gap-3 pt-1", children: [_jsxs("button", { onClick: start, className: "flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors", children: [_jsx(RefreshCw, { size: 12 }), t('noteSync.init.retry', { defaultValue: t('noteSync.init.continueInit') })] }), _jsxs("button", { onClick: handleDiscard, disabled: discarding, className: "flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50", children: [_jsx(Trash2, { size: 12 }), t('noteSync.init.discard')] })] })] }));
    }
    // done：报告
    if (uiState === 'done' && snapshot?.report) {
        const report = snapshot.report;
        return (_jsxs("div", { className: "rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(CheckCircle, { size: 14, className: "text-emerald-400 flex-shrink-0" }), _jsx("span", { className: "text-xs text-white font-medium", children: source.name }), _jsx("span", { className: "text-[10px] text-emerald-400", children: t('noteSync.init.complete') })] }), _jsx("div", { className: "grid grid-cols-4 gap-2 text-xs", children: [
                        [t('noteSync.wizard.reportNodes'), report.nodesCreated ?? 0],
                        [t('noteSync.wizard.reportLinks'), report.linksCreated ?? 0],
                        [t('noteSync.wizard.reportCrystals'), report.crystalsCreated ?? 0],
                        [t('noteSync.wizard.reportDuration'), `${Math.round((report.durationMs ?? 0) / 1000)}s`],
                    ].map(([label, value]) => (_jsxs("div", { className: "bg-white/[0.04] rounded-lg p-2 text-center", children: [_jsx("div", { className: "text-gray-500 text-[10px]", children: label }), _jsx("div", { className: "text-white font-medium", children: value })] }, label))) })] }));
    }
    // idle：从未启动（或 discard 后）— 显示"未初始化 + 开始"
    // 这种情况通常意味着设置页里看到一个未 initialized 的笔记源
    return (_jsxs("div", { className: "rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(AlertCircle, { size: 14, className: "text-amber-400 flex-shrink-0" }), _jsx("span", { className: "text-xs text-white font-medium", children: source.name }), _jsx("span", { className: "text-[10px] text-amber-400", children: t('noteSync.init.interrupted') })] }), totalFiles !== null && (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-[11px] text-gray-400", children: t('noteSync.init.processedFiles', { current: syncedFiles, total: totalFiles }) }), _jsx("div", { className: "w-full bg-white/[0.06] rounded-full h-1.5", children: _jsx("div", { className: "bg-amber-400 h-1.5 rounded-full transition-all", style: { width: `${Math.max(2, processedPct)}%` } }) })] })), _jsxs("div", { className: "flex items-center gap-3 pt-1", children: [_jsxs("button", { onClick: start, className: "flex items-center gap-2 px-4 py-2 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg transition-colors", children: [_jsx(Play, { size: 12 }), t('noteSync.init.continueInit')] }), _jsxs("button", { onClick: handleDiscard, disabled: discarding, className: "flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50", children: [_jsx(Trash2, { size: 12 }), t('noteSync.init.discard')] })] })] }));
}
