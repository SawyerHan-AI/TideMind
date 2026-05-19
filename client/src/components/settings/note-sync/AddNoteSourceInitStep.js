import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { AlertCircle, CheckCircle, FileText, Loader2, Zap } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useInitSession } from './useInitSession';
const PHASE_NAMES = [
    'scan',
    'preprocess',
    'import',
    'links',
    'annotate',
    'landing',
    'evaluate',
    'keystone',
    'emerge',
];
/**
 * Onboarding 第 3 步：展示预览 → 启动 → 显示进度。
 *
 * 状态完全由 useInitSession 驱动，不再由父组件传 initStarted/initProgress/initError。
 * 父组件只需提供 sourceId（createAndPreview 后从 useAddNoteSourceInitialization 拿）。
 *
 * 当会话进入终态（done / aborted / error）时，调用 onTerminal——父组件据此切到下一步。
 */
export function AddNoteSourceInitStep({ sourceId, initPreview, onSessionStarted, onTerminal, }) {
    const { t } = useTranslation('settings');
    const { snapshot, uiState, aborting, start, abort } = useInitSession(sourceId, {
        onTerminal: (snap) => onTerminal?.(snap),
    });
    // 第一次看到 running 时通知父组件
    const startedNotifiedRef = useRef(false);
    useEffect(() => {
        if (uiState === 'running' && !startedNotifiedRef.current) {
            startedNotifiedRef.current = true;
            onSessionStarted?.();
        }
    }, [uiState, onSessionStarted]);
    const showPreview = uiState === 'idle' || uiState === 'loading';
    const showProgress = uiState === 'running' || uiState === 'aborting';
    const showError = uiState === 'error';
    return (_jsxs("div", { className: "space-y-4", children: [showPreview && initPreview && (_jsxs(_Fragment, { children: [_jsxs("h3", { className: "text-xs font-medium text-white flex items-center gap-2", children: [_jsx(FileText, { size: 14 }), t('noteSync.wizard.initPreview')] }), _jsxs("div", { className: "grid grid-cols-2 gap-3 text-xs", children: [_jsxs("div", { className: "bg-white/[0.04] rounded-lg p-3", children: [_jsx("div", { className: "text-gray-500 mb-1", children: t('noteSync.wizard.totalFiles') }), _jsx("div", { className: "text-lg text-white font-medium", children: initPreview.totalFiles ?? 0 }), initPreview.breakdown && initPreview.breakdown.length > 1 && (_jsx("div", { className: "mt-2 space-y-1 text-[11px] text-gray-500 border-t border-white/5 pt-2", children: initPreview.breakdown.map(item => (_jsxs("div", { className: "flex justify-between", children: [_jsx("span", { children: t(`noteSync.wizard.breakdown.${item.label}`, item.label) }), _jsx("span", { className: "text-gray-400 tabular-nums", children: item.count })] }, item.label))) }))] }), _jsxs("div", { className: "bg-white/[0.04] rounded-lg p-3", children: [_jsx("div", { className: "text-gray-500 mb-1", children: t('noteSync.wizard.estimatedNodes') }), _jsxs("div", { className: "text-lg text-white font-medium", children: ["~", initPreview.estimatedNodes] })] })] }), _jsxs("div", { className: "bg-white/[0.04] rounded-lg p-3 text-xs", children: [_jsx("div", { className: "text-gray-500 mb-2", children: t('noteSync.wizard.estimatedCost') }), _jsxs("div", { className: "flex justify-between text-white font-medium", children: [_jsx("span", { children: t('noteSync.wizard.total') }), _jsxs("span", { children: ["$", initPreview.estimatedCost?.total ?? 0] })] })] }), _jsxs("button", { onClick: start, disabled: !sourceId, className: "w-full py-2 bg-indigo-500 hover:bg-indigo-400 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50", children: [_jsx(Zap, { size: 14 }), t('noteSync.wizard.startInit')] })] })), showProgress && snapshot && (_jsxs(_Fragment, { children: [_jsxs("h3", { className: "text-sm font-medium text-white flex items-center gap-2", children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), t('noteSync.wizard.initInProgress')] }), _jsxs("div", { className: "text-xs text-gray-400", children: ["Phase ", snapshot.progress.phase, "/8: ", snapshot.progress.phaseName] }), _jsx("div", { className: "w-full bg-white/[0.06] rounded-full h-2", children: _jsx("div", { className: "bg-indigo-400 h-2 rounded-full transition-all duration-500", style: { width: `${snapshot.progress.total > 0 ? Math.max(5, Math.round((snapshot.progress.current / snapshot.progress.total) * 100)) : 5}%` } }) }), _jsxs("div", { className: "text-xs text-gray-500 text-center", children: [snapshot.progress.current, " / ", snapshot.progress.total] }), _jsx("div", { className: "flex gap-0.5", children: PHASE_NAMES.map((pname, i) => (_jsx("div", { className: `h-1 flex-1 rounded-full transition-colors ${i < snapshot.progress.phase ? 'bg-green-500'
                                : i === snapshot.progress.phase ? 'bg-indigo-400'
                                    : 'bg-white/[0.06]'}`, title: `Phase ${i}: ${pname}` }, i))) }), _jsx("button", { onClick: abort, disabled: aborting || uiState === 'aborting', className: "w-full py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg transition-colors disabled:opacity-50", children: aborting || uiState === 'aborting'
                            ? t('noteSync.wizard.aborting')
                            : t('noteSync.wizard.abort') })] })), showError && snapshot && (_jsxs("div", { className: "space-y-3 p-4 bg-white/[0.03] rounded-xl border border-red-500/20", children: [_jsxs("h3", { className: "text-sm font-medium text-red-400 flex items-center gap-2", children: [_jsx(AlertCircle, { size: 14 }), t('noteSync.wizard.initFailed')] }), snapshot.error && _jsx("div", { className: "text-xs text-red-300", children: snapshot.error })] })), !initPreview && !showProgress && !showError && uiState !== 'done' && uiState !== 'aborted' && (_jsxs("div", { className: "flex items-center gap-2 text-gray-400 py-8 justify-center", children: [_jsx(Loader2, { size: 16, className: "animate-spin" }), _jsx("span", { className: "text-sm", children: t('noteSync.wizard.scanning') })] }))] }));
}
export function AddNoteSourceCompleteStep({ initReport, }) {
    const { t } = useTranslation('settings');
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("h3", { className: "text-sm font-medium text-green-400 flex items-center gap-2", children: [_jsx(CheckCircle, { size: 14 }), t('noteSync.wizard.complete')] }), initReport && (_jsx("div", { className: "grid grid-cols-2 gap-2 text-xs", children: [
                    [t('noteSync.wizard.reportNodes'), initReport.nodesCreated],
                    [t('noteSync.wizard.reportLinks'), initReport.linksCreated],
                    [t('noteSync.wizard.reportCrystals'), initReport.crystalsCreated],
                    [t('noteSync.wizard.reportFiles'), initReport.totalFiles],
                    [t('noteSync.wizard.reportDuration'), `${Math.round((initReport.durationMs ?? 0) / 1000)}s`],
                    [t('noteSync.wizard.reportCost'), `$${initReport.totalCost ?? 0}`],
                ].map(([label, value]) => (_jsxs("div", { className: "bg-white/[0.04] rounded-lg p-2", children: [_jsx("div", { className: "text-gray-500", children: label }), _jsx("div", { className: "text-white font-medium", children: value })] }, label))) }))] }));
}
