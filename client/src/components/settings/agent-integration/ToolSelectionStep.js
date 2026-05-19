import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ChevronRight, Package } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { inputClass } from '../shared';
import { TOOL_TYPES } from './toolTypes';
export function ToolSelectionStep({ agentName, setAgentName, toolType, setToolType, customToolType, setCustomToolType, effectiveToolType, usePlugin, creating, onCreateAndNext, }) {
    const { t } = useTranslation('settings');
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "text-[11px] text-gray-400 mb-1.5 block", children: t('agent.table.toolType') }), _jsxs("div", { className: "grid grid-cols-4 gap-2", children: [TOOL_TYPES.map(item => (_jsx("button", { onClick: () => {
                                    if (item.comingSoon)
                                        return;
                                    setToolType(item.id);
                                    if (!agentName || TOOL_TYPES.some(tt => tt.label === agentName)) {
                                        setAgentName(item.label);
                                    }
                                }, disabled: item.comingSoon, className: `px-3 py-2 rounded-lg border text-xs font-medium transition-all ${item.comingSoon
                                    ? 'bg-white/[0.01] border-white/5 text-gray-600 cursor-not-allowed'
                                    : toolType === item.id
                                        ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                                        : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'}`, children: _jsxs("span", { className: "flex items-center gap-1", children: [item.label, item.comingSoon && _jsx("span", { className: "text-[9px] text-gray-600", children: t('agent.wizard.comingSoon') }), !item.comingSoon && item.pluginSupport && _jsx(Package, { size: 10, className: "opacity-50" })] }) }, item.id))), _jsx("button", { onClick: () => {
                                    setToolType('other');
                                    if (!customToolType) {
                                        setCustomToolType(`custom-${Math.random().toString(36).slice(2, 6)}`);
                                    }
                                }, className: `px-3 py-2 rounded-lg border text-xs font-medium transition-all ${toolType === 'other'
                                    ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                                    : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'}`, children: t('agent.wizard.other') })] }), usePlugin && (_jsxs("p", { className: "text-[10px] text-emerald-400/70 mt-1.5 flex items-center gap-1", children: [_jsx(Package, { size: 10 }), t('agent.wizard.pluginSupportHint')] }))] }), _jsxs("div", { children: [_jsx("label", { className: "text-[11px] text-gray-400 mb-1.5 block", children: t('agent.wizard.agentName') }), _jsx("input", { value: agentName, onChange: e => setAgentName(e.target.value), placeholder: t('agent.wizard.agentNamePlaceholder'), className: `${inputClass} w-full text-xs` }), _jsx("p", { className: "text-[10px] text-gray-500 mt-1", children: t('agent.wizard.agentNameHint') })] }), _jsx("div", { className: "flex justify-end", children: _jsxs("button", { onClick: onCreateAndNext, disabled: !agentName.trim() || !effectiveToolType.trim() || creating, className: "flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed", children: [creating ? t('agent.wizard.creating') : t('agent.wizard.createAndContinue'), _jsx(ChevronRight, { size: 14 })] }) })] }));
}
