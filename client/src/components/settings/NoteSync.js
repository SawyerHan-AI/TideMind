import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ChevronRight, RotateCcw, X, MoreHorizontal, BookOpen, } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';
import { Section } from './shared';
import { useFormatters } from '../../hooks/useFormatters';
import { InitializingSourceCard } from './note-sync/InitializingSourceCard';
import { NoteSourceDetailPanel } from './note-sync/NoteSourceDetailPanel';
import { useAddNoteSourceInitialization } from './note-sync/useAddNoteSourceInitialization';
import { AddNoteSourceCompleteStep, AddNoteSourceInitStep, } from './note-sync/AddNoteSourceInitStep';
import { AddNoteSourceConnectionStep, AddNoteSourceToolStep, } from './note-sync/AddNoteSourceConnectionSteps';
import { getToolIcon, getToolLabel } from './note-sync/toolTypes';
import { useAddNoteSourceConnection } from './note-sync/useAddNoteSourceConnection';
// ============================================================
// 笔记同步: 列表 + 展开详情 + 添加向导
// ============================================================
// --- 状态指示 ---
function StatusDot({ status }) {
    const { t } = useTranslation('settings');
    const cfg = {
        online: { cls: 'bg-emerald-400 shadow-emerald-400/40 shadow-sm', label: t('noteSync.status.online') },
        syncing: { cls: 'bg-blue-400 shadow-blue-400/40 shadow-sm animate-pulse', label: t('noteSync.status.syncing') },
        offline: { cls: 'bg-red-400 shadow-red-400/40 shadow-sm', label: t('noteSync.status.offline') },
        paused: { cls: 'bg-gray-500', label: t('noteSync.status.paused') },
    };
    const { cls, label } = cfg[status];
    return (_jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: `w-2 h-2 rounded-full inline-block ${cls}` }), _jsx("span", { className: "text-[10px] text-gray-500", children: label })] }));
}
// ============================================================
// 添加向导（Modal）
// ============================================================
function AddNoteSourceWizard({ onClose, }) {
    const { t } = useTranslation('settings');
    const [step, setStep] = useState(0);
    const { toolType, name, selectedPath, testResult, testing, permissionResult, checkingPermission, appleAccounts, selectedAccountZpks, loadingAccounts, canProceed, setName, selectToolType, setNotionToken, testNotionToken, selectFolderAndTest, checkAppleNotesPermission, toggleAccount, buildFinalPath, } = useAddNoteSourceConnection(step);
    const { createdSourceId, initPreview, initReport, createAndPreview, markInitStarted, onSessionTerminal, cleanupBeforeClose, } = useAddNoteSourceInitialization({
        onInitStep: () => setStep(2),
    });
    // Handle close with abort confirmation
    const handleClose = async () => {
        const shouldClose = await cleanupBeforeClose();
        if (shouldClose)
            onClose();
    };
    // Step 2 → Step 3: Create source + load preview
    const goToStep3 = async () => {
        await createAndPreview({
            name,
            toolType,
            path: buildFinalPath(),
        });
    };
    return (_jsxs(Section, { title: t('noteSync.wizard.title'), action: _jsx("button", { onClick: handleClose, className: "text-gray-500 hover:text-gray-300 transition-colors", children: _jsx(X, { size: 16 }) }), children: [_jsxs("div", { children: [step === 0 && (_jsx(AddNoteSourceToolStep, { toolType: toolType, name: name, onToolTypeChange: selectToolType, onNameChange: setName })), step === 1 && (_jsx(AddNoteSourceConnectionStep, { toolType: toolType, selectedPath: selectedPath, testResult: testResult, testing: testing, permissionResult: permissionResult, checkingPermission: checkingPermission, appleAccounts: appleAccounts, selectedAccountZpks: selectedAccountZpks, loadingAccounts: loadingAccounts, onNotionTokenChange: setNotionToken, onTestNotion: testNotionToken, onSelectFolder: selectFolderAndTest, onCheckAppleNotesPermission: checkAppleNotesPermission, onToggleAccount: toggleAccount })), step === 2 && (_jsx(AddNoteSourceInitStep, { sourceId: createdSourceId, initPreview: initPreview, onSessionStarted: markInitStarted, onTerminal: (snap) => {
                            onSessionTerminal(snap.status, snap.report);
                            if (snap.status === 'done')
                                setStep(3);
                        } })), step === 3 && (_jsx(AddNoteSourceCompleteStep, { initReport: initReport }))] }), _jsxs("div", { className: "pt-4 border-t border-white/5 flex justify-between", children: [step > 0 && step < 2 && (_jsx("button", { onClick: () => setStep(step - 1), className: "flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors", children: t('noteSync.wizard.prevStep') })), step === 0 && _jsx("div", {}), step >= 2 && _jsx("div", {}), step === 0 && (_jsx("button", { onClick: () => setStep(1), disabled: !name.trim(), className: "px-4 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg transition-colors disabled:opacity-50", children: t('noteSync.wizard.nextStep') })), step === 1 && (_jsx("button", { onClick: goToStep3, disabled: !canProceed, className: "px-4 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg transition-colors disabled:opacity-50", children: t('noteSync.wizard.nextStep') })), step === 3 && (_jsx("button", { onClick: onClose, className: "px-4 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors", children: t('noteSync.wizard.finish') }))] })] }));
}
// ============================================================
// 主组件
// ============================================================
export function NoteSync() {
    const { t } = useTranslation('settings');
    const { timeAgo } = useFormatters();
    const { data: sources, refetch } = useIPC(() => window.api.noteSources.list(true));
    const [statsMap, setStatsMap] = useState({});
    const [wizardOpen, setWizardOpen] = useState(false);
    const [expandedSource, setExpandedSource] = useState(null);
    const [showArchived, setShowArchived] = useState(false);
    const allSources = (sources ?? []);
    const activeSources = allSources.filter(s => !s.archived);
    const initializedSources = activeSources.filter(s => s.initialized);
    const uninitializedSources = activeSources.filter(s => !s.initialized);
    const archivedSources = allSources.filter(s => s.archived);
    // Load stats for active sources (poll every 3s while any source is syncing)
    useEffect(() => {
        if (activeSources.length === 0)
            return;
        let timer = null;
        let cancelled = false;
        const loadStats = async () => {
            const map = {};
            for (const s of activeSources) {
                try {
                    map[s.id] = await window.api.noteSources.stats(s.id);
                }
                catch (err) {
                    console.error(`加载笔记源统计失败 (${s.id}):`, err);
                }
            }
            if (!cancelled) {
                setStatsMap(map);
                // 有正在同步的源时持续轮询
                const anySyncing = Object.values(map).some(s => s.syncing);
                if (anySyncing && !timer) {
                    timer = setInterval(loadStats, 3000);
                }
                else if (!anySyncing && timer) {
                    clearInterval(timer);
                    timer = null;
                }
            }
        };
        loadStats();
        return () => {
            cancelled = true;
            if (timer)
                clearInterval(timer);
        };
    }, [sources]);
    const getStatus = (source) => {
        if (source.archived)
            return 'paused';
        const stats = statsMap[source.id];
        if (stats?.syncing)
            return 'syncing';
        if (stats && stats.accessible === false)
            return 'offline';
        return 'online';
    };
    return (_jsxs("div", { className: "space-y-6 max-w-2xl", children: [_jsxs(Section, { title: t('noteSync.title'), children: [_jsx("p", { className: "text-xs text-gray-500 mb-4", children: t('noteSync.description') }), initializedSources.length === 0 && uninitializedSources.length === 0 && !wizardOpen && (_jsx("div", { className: "py-8 text-center text-xs text-gray-500", children: t('noteSync.empty') })), initializedSources.length > 0 && (_jsxs("div", { className: "space-y-0.5", children: [_jsxs("div", { className: "flex items-center gap-4 px-3 py-2 text-[11px] text-gray-500 font-medium border-b border-white/5", children: [_jsx("span", { className: "w-36", children: t('noteSync.table.name') }), _jsx("span", { className: "w-20", children: t('noteSync.table.type') }), _jsx("span", { className: "w-16", children: t('noteSync.table.status') }), _jsx("span", { className: "w-20 text-right", children: t('noteSync.table.fileCount') }), _jsx("span", { className: "w-28", children: t('noteSync.table.lastSync') }), _jsx("span", { className: "w-8" })] }), initializedSources.map(source => {
                                const status = getStatus(source);
                                const stats = statsMap[source.id];
                                const isExpanded = expandedSource === source.id;
                                return (_jsxs("div", { children: [_jsxs("button", { onClick: () => setExpandedSource(isExpanded ? null : source.id), className: "w-full flex items-center gap-4 px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors text-left", children: [_jsxs("div", { className: "w-36 flex items-center gap-2", children: [getToolIcon(source.tool_type), _jsx("span", { className: "text-xs text-gray-200 font-medium truncate", children: source.name })] }), _jsx("span", { className: "w-20 text-xs text-gray-400", children: getToolLabel(source.tool_type) }), _jsx("div", { className: "w-16", children: _jsx(StatusDot, { status: status }) }), _jsx("span", { className: "w-20 text-xs text-gray-400 text-right tabular-nums", children: stats?.fileCount ? `${stats.fileCount}` : '-' }), _jsx("span", { className: "w-28 text-xs text-gray-400 tabular-nums", children: source.last_synced ? timeAgo(source.last_synced) : '-' }), _jsx("span", { className: "w-8 flex justify-end", children: _jsx(MoreHorizontal, { size: 14, className: "text-gray-500" }) })] }), isExpanded && (_jsx(NoteSourceDetailPanel, { source: source, onRefetch: refetch }))] }, source.id));
                            })] })), archivedSources.length > 0 && (_jsxs("div", { className: "mt-4", children: [_jsxs("button", { onClick: () => setShowArchived(!showArchived), className: "flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors", children: [_jsx(ChevronRight, { size: 12, className: `transition-transform ${showArchived ? 'rotate-90' : ''}` }), t('noteSync.archived'), " (", archivedSources.length, ")"] }), showArchived && (_jsx("div", { className: "mt-2 space-y-0.5 pl-2 border-l border-white/5", children: archivedSources.map(source => (_jsxs("div", { className: "flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.02]", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(BookOpen, { size: 14, className: "text-gray-600" }), _jsx("span", { className: "text-xs text-gray-500", children: source.name }), _jsx("span", { className: "text-[10px] text-gray-600", children: getToolLabel(source.tool_type) })] }), _jsxs("button", { onClick: async () => {
                                                await window.api.noteSources.unarchive(source.id);
                                                refetch();
                                            }, className: "flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors", children: [_jsx(RotateCcw, { size: 10 }), t('noteSync.restore')] })] }, source.id))) }))] }))] }), uninitializedSources.map(source => (_jsx(InitializingSourceCard, { source: source, onRefetch: refetch }, source.id))), uninitializedSources.length === 0 && (!wizardOpen ? (_jsxs("button", { onClick: () => setWizardOpen(true), className: "flex items-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-gray-300 transition-colors border border-white/5", children: [_jsx(Plus, { size: 14 }), t('noteSync.wizard.title')] })) : (_jsx(AddNoteSourceWizard, { onClose: () => {
                    setWizardOpen(false);
                    refetch();
                } })))] }));
}
