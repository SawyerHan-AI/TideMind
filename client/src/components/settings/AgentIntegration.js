import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { Plug, Plus, ChevronRight, RotateCcw, MoreHorizontal, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../../hooks/useIPC';
import { Section } from './shared';
import { useFormatters } from '../../hooks/useFormatters';
import { AgentDetailPanel } from './agent-integration/AgentDetailPanel';
import { AgentWizard } from './agent-integration/AgentWizard';
import { getToolTypeDef, isPluginSupported } from './agent-integration/toolTypes';
// 主组件
// ============================================================
export function AgentIntegration() {
    const { t } = useTranslation('settings');
    const { timeAgo } = useFormatters();
    const { data: agents, refetch: refetchAgents } = useIPC(() => window.api.agents.list(true));
    const { data: agentStats, refetch: refetchStats } = useIPC(() => window.api.agents.stats());
    const [wizardOpen, setWizardOpen] = useState(false);
    const [expandedAgent, setExpandedAgent] = useState(null);
    const [showArchived, setShowArchived] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const refetchAll = useCallback(() => {
        refetchAgents();
        refetchStats();
    }, [refetchAgents, refetchStats]);
    const activeAgents = (agents ?? []).filter((a) => !a.archived);
    const archivedAgents = (agents ?? []).filter((a) => a.archived);
    const getStats = (agentId) => {
        return (agentStats ?? []).find((s) => s.id === agentId);
    };
    const getStatusInfo = (agent) => {
        if (!agent.last_active)
            return { color: 'bg-gray-600', textColor: 'text-gray-500', label: t('agent.status.notConnected') };
        const hoursSince = (Date.now() - new Date(agent.last_active).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 24 * 7)
            return { color: 'bg-emerald-400', textColor: 'text-emerald-400', label: t('agent.status.active') };
        return { color: 'bg-yellow-500', textColor: 'text-yellow-500', label: t('agent.status.inactive') };
    };
    return (_jsxs("div", { className: "space-y-6 max-w-2xl", children: [_jsxs(Section, { title: t('agent.configuredAgents'), children: [_jsx("p", { className: "text-xs text-gray-500 mb-4", children: t('agent.description') }), activeAgents.length === 0 && !wizardOpen && (_jsx("div", { className: "py-8 text-center text-xs text-gray-500", children: t('agent.empty') })), activeAgents.length > 0 && (_jsxs("div", { className: "space-y-0.5", children: [_jsxs("div", { className: "flex items-center gap-4 px-3 py-2 text-[11px] text-gray-500 font-medium border-b border-white/5", children: [_jsx("span", { className: "w-40", children: t('agent.table.name') }), _jsx("span", { className: "w-24", children: t('agent.table.toolType') }), _jsx("span", { className: "w-16", children: t('agent.table.status') }), _jsx("span", { className: "w-28", children: t('agent.table.lastActive') }), _jsx("span", { className: "w-20 text-right", children: t('agent.table.digestCount') }), _jsx("span", { className: "w-12" })] }), activeAgents.map((agent) => {
                                const status = getStatusInfo(agent);
                                const stats = getStats(agent.id);
                                const isExpanded = expandedAgent === agent.id;
                                return (_jsxs("div", { children: [_jsxs("button", { onClick: () => setExpandedAgent(isExpanded ? null : agent.id), className: "w-full flex items-center gap-4 px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors text-left", children: [_jsxs("div", { className: "w-40 flex items-center gap-2", children: [_jsx(Plug, { size: 14, className: "text-gray-500 flex-shrink-0" }), _jsx("span", { className: "text-xs text-gray-200 font-medium truncate", children: agent.name })] }), _jsx("span", { className: "w-24 text-xs text-gray-400", children: getToolTypeDef(agent.tool_type)?.label ?? agent.tool_type }), _jsxs("div", { className: "w-16 flex items-center gap-1.5", children: [_jsx("div", { className: `w-2 h-2 rounded-full ${status.color}` }), _jsx("span", { className: `text-xs ${status.textColor}`, children: status.label })] }), _jsx("span", { className: "w-28 text-xs text-gray-400 tabular-nums", children: agent.last_active ? timeAgo(agent.last_active) : '-' }), _jsx("span", { className: "w-20 text-xs text-gray-400 text-right tabular-nums", children: stats?.digest_count ? t('agent.countSuffix', { count: stats.digest_count }) : '-' }), _jsx("span", { className: "w-12 flex justify-end", children: _jsx(MoreHorizontal, { size: 14, className: "text-gray-500" }) })] }), isExpanded && (_jsx(AgentDetailPanel, { agent: agent, onRefetch: refetchAll }))] }, agent.id));
                            })] })), archivedAgents.length > 0 && (_jsxs("div", { className: "mt-4", children: [_jsxs("button", { onClick: () => setShowArchived(!showArchived), className: "flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors", children: [_jsx(ChevronRight, { size: 12, className: `transition-transform ${showArchived ? 'rotate-90' : ''}` }), t('agent.archived'), " (", archivedAgents.length, ")"] }), showArchived && (_jsx("div", { className: "mt-2 space-y-0.5 pl-2 border-l border-white/5", children: archivedAgents.map((agent) => (_jsxs("div", { className: "flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.02]", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Plug, { size: 14, className: "text-gray-600" }), _jsx("span", { className: "text-xs text-gray-500", children: agent.name }), _jsx("span", { className: "text-[10px] text-gray-600", children: getToolTypeDef(agent.tool_type)?.label ?? agent.tool_type })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("button", { onClick: async () => {
                                                        await window.api.agents.unarchive(agent.id);
                                                        refetchAll();
                                                    }, className: "flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors", children: [_jsx(RotateCcw, { size: 10 }), t('agent.restore')] }), confirmDelete === agent.id ? (_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-[10px] text-red-400", children: t('agent.confirmDeleteQuestion') }), _jsx("button", { onClick: async () => {
                                                                if (isPluginSupported(agent.tool_type)) {
                                                                    await window.api.agents.uninstallPlugin(agent.id, agent.tool_type);
                                                                }
                                                                await window.api.agents.delete(agent.id);
                                                                setConfirmDelete(null);
                                                                refetchAll();
                                                            }, className: "text-[10px] text-red-400 hover:text-red-300 font-medium", children: t('agent.confirm') }), _jsx("button", { onClick: () => setConfirmDelete(null), className: "text-[10px] text-gray-500 hover:text-gray-300", children: t('agent.cancel') })] })) : (_jsxs("button", { onClick: () => setConfirmDelete(agent.id), className: "flex items-center gap-1 text-[10px] text-gray-600 hover:text-red-400 transition-colors", children: [_jsx(Trash2, { size: 10 }), t('agent.delete')] }))] })] }, agent.id))) }))] }))] }), !wizardOpen ? (_jsxs("button", { onClick: () => setWizardOpen(true), className: "flex items-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-gray-300 transition-colors border border-white/5", children: [_jsx(Plus, { size: 14 }), t('agent.newAgent')] })) : (_jsx(AgentWizard, { onClose: () => {
                    setWizardOpen(false);
                    refetchAll();
                } }))] }));
}
