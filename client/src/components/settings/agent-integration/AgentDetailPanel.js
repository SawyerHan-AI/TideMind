import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Archive, Check, CheckCircle, Copy, FolderOpen, Package, Pencil, RefreshCw, Terminal, X } from 'lucide-react';
import { useFormatters } from '../../../hooks/useFormatters';
import { inputClass } from '../shared';
import { getToolTypeDef, isPluginSupported } from './toolTypes';
// Agent 详情面板（展开后显示）
// ============================================================
export function AgentDetailPanel({ agent, onRefetch }) {
    const { t } = useTranslation('settings');
    const { formatShortDate } = useFormatters();
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(agent.name);
    const [mcpSnippet, setMcpSnippet] = useState('');
    const [copied, setCopied] = useState(null);
    const copiedTimerRef = useRef(null);
    const [skillContent, setSkillContent] = useState('');
    const [skillLoaded, setSkillLoaded] = useState(false);
    const [pluginDir, setPluginDir] = useState(null);
    const [pluginStatus, setPluginStatus] = useState(null);
    const [regenerating, setRegenerating] = useState(false);
    const isPlugin = isPluginSupported(agent.tool_type);
    const pluginInstallCmd = `claude plugin install tidemind-${agent.id}@tidemind-local --scope user`;
    const loadPluginStatus = () => {
        window.api.agents.pluginStatus(agent.id, agent.tool_type).then(s => setPluginStatus(s));
        window.api.agents.pluginPath(agent.id, agent.tool_type).then(p => setPluginDir(p));
    };
    useEffect(() => {
        if (isPlugin) {
            loadPluginStatus();
        }
        else {
            window.api.agents.mcpSnippet(agent.id).then(s => setMcpSnippet(JSON.stringify(s, null, 2)));
        }
    }, [agent.id, isPlugin]);
    useEffect(() => {
        if (!isPlugin) {
            window.api.config.skillContent(agent.tool_type).then(c => {
                if (c) {
                    setSkillContent(c);
                }
                else {
                    window.api.config.skillContent('base-skill').then(bc => setSkillContent(bc));
                }
                setSkillLoaded(true);
            });
        }
    }, [agent.tool_type, isPlugin]);
    useEffect(() => {
        return () => {
            if (copiedTimerRef.current)
                clearTimeout(copiedTimerRef.current);
        };
    }, []);
    const handleCopy = async (text, key) => {
        await navigator.clipboard.writeText(text);
        setCopied(key);
        if (copiedTimerRef.current)
            clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(null), 2000);
    };
    const handleRename = async () => {
        if (name.trim() && name !== agent.name) {
            await window.api.agents.update(agent.id, { name: name.trim() });
            onRefetch();
        }
        setEditing(false);
    };
    const handleArchive = async () => {
        await window.api.agents.archive(agent.id);
        onRefetch();
    };
    const toolDef = getToolTypeDef(agent.tool_type);
    const pluginDetail = toolDef?.pluginDetail;
    const pluginDetailToneClass = pluginDetail?.tone === 'emerald'
        ? 'bg-emerald-500/5 border-emerald-500/10 text-emerald-400'
        : pluginDetail?.tone === 'blue'
            ? 'bg-blue-500/5 border-blue-500/10 text-blue-400'
            : 'bg-indigo-400/5 border-indigo-400/10 text-indigo-400';
    return (_jsxs("div", { className: "mx-3 mb-2 p-4 bg-white/[0.02] rounded-lg border border-white/5 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("div", { className: "flex items-center gap-3", children: editing ? (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { value: name, onChange: e => setName(e.target.value), onKeyDown: e => e.key === 'Enter' && handleRename(), className: `${inputClass} w-40 text-xs`, autoFocus: true }), _jsx("button", { onClick: handleRename, className: "text-emerald-400 hover:text-emerald-300", children: _jsx(Check, { size: 14 }) }), _jsx("button", { onClick: () => { setEditing(false); setName(agent.name); }, className: "text-gray-500 hover:text-gray-300", children: _jsx(X, { size: 14 }) })] })) : (_jsxs("button", { onClick: () => setEditing(true), className: "flex items-center gap-1.5 text-xs text-gray-300 hover:text-gray-100 transition-colors", children: [_jsx(Pencil, { size: 11 }), t('agent.rename')] })) }), _jsxs("button", { onClick: handleArchive, className: "flex items-center gap-1 text-[10px] text-gray-500 hover:text-orange-400 transition-colors", children: [_jsx(Archive, { size: 11 }), t('agent.archive')] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-[10px] text-gray-500", children: "Agent ID:" }), _jsx("code", { className: "text-[10px] text-gray-400 bg-white/5 px-1.5 py-0.5 rounded font-mono", children: agent.id })] }), isPlugin && (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2 mb-1.5", children: [_jsx(Package, { size: 12, className: "text-gray-400" }), _jsxs("span", { className: "text-[11px] text-gray-400 font-medium", children: [toolDef?.label ?? 'Plugin', " ", t('agent.plugin')] })] }), pluginDir ? (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg", children: [_jsx(CheckCircle, { size: 12, className: "text-emerald-400 flex-shrink-0" }), _jsx("span", { className: "text-[10px] text-emerald-400", children: t('agent.pluginGenerated') })] }), pluginStatus?.exists && (_jsxs("div", { className: "px-3 py-2 bg-white/[0.02] border border-white/5 rounded-lg space-y-1.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-[10px] text-gray-500 w-16", children: "Skill:" }), _jsx("code", { className: "text-[10px] text-gray-300 font-mono", children: pluginStatus.skillFile })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("span", { className: "text-[10px] text-gray-500 w-16", children: [t('agent.tools'), ":"] }), _jsx("div", { className: "flex gap-1 flex-wrap", children: pluginStatus.tools?.map((item) => (_jsx("span", { className: "text-[9px] text-gray-400 bg-white/5 px-1.5 py-0.5 rounded font-mono", children: item }, item))) })] }), pluginStatus.generatedAt && (_jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("span", { className: "text-[10px] text-gray-500 w-16", children: [t('agent.generatedAt'), ":"] }), _jsx("span", { className: "text-[10px] text-gray-400", children: formatShortDate(pluginStatus.generatedAt) })] }))] })), pluginStatus?.skillOutdated && (_jsxs("div", { className: "flex items-center gap-2 px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg", children: [_jsx(AlertTriangle, { size: 12, className: "text-amber-400 flex-shrink-0" }), _jsx("span", { className: "text-[10px] text-amber-400", children: t('agent.skillOutdatedHint') })] })), _jsx("div", { className: "flex gap-2", children: _jsxs("button", { onClick: async () => {
                                        setRegenerating(true);
                                        try {
                                            await window.api.agents.generatePlugin({ agentId: agent.id, agentName: agent.name, clientType: agent.tool_type });
                                            loadPluginStatus();
                                        }
                                        finally {
                                            setRegenerating(false);
                                        }
                                    }, disabled: regenerating, className: "flex items-center gap-1.5 px-3 py-1.5 text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-gray-300 hover:text-gray-100 transition-colors disabled:opacity-50", children: [_jsx(RefreshCw, { size: 11, className: regenerating ? 'animate-spin' : '' }), regenerating ? t('agent.regenerating') : t('agent.regeneratePlugin')] }) }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(FolderOpen, { size: 11, className: "text-gray-500 flex-shrink-0" }), _jsx("code", { className: "text-[10px] text-gray-400 font-mono truncate", children: pluginDir })] }), pluginDetail ? (_jsxs("div", { className: "space-y-1.5", children: [pluginDetail.showSkillOutput && pluginStatus?.skillOutputExists && pluginStatus.skillOutputPath && (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(FolderOpen, { size: 11, className: "text-gray-500 flex-shrink-0" }), _jsx("code", { className: "text-[10px] text-gray-400 font-mono truncate", children: pluginStatus.skillOutputPath })] })), _jsx("div", { className: `px-3 py-2 border rounded-lg space-y-1 ${pluginDetailToneClass}`, children: pluginDetail.hintKeys.map(key => (_jsx("p", { className: "text-[10px]", children: t(key) }, key))) })] })) : (_jsxs("div", { className: "relative", children: [_jsxs("div", { className: "flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg", children: [_jsx(Terminal, { size: 11, className: "text-gray-400 flex-shrink-0" }), _jsx("code", { className: "text-[10px] text-gray-300 font-mono", children: pluginInstallCmd })] }), _jsx("button", { onClick: () => handleCopy(pluginInstallCmd, 'install-cmd'), className: "absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors", children: copied === 'install-cmd' ? _jsx(Check, { size: 11, className: "text-emerald-400" }) : _jsx(Copy, { size: 11 }) })] }))] })) : (_jsx("div", { className: "px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg", children: _jsx("p", { className: "text-[10px] text-amber-400", children: t('agent.pluginNotGenerated') }) }))] })), !isPlugin && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-1.5", children: [_jsx("span", { className: "text-[11px] text-gray-400 font-medium", children: t('agent.mcpConfig') }), toolDef && (_jsxs("span", { className: "text-[10px] text-gray-500", children: [t('agent.copyTo'), " ", _jsx("code", { className: "text-gray-400", children: t(toolDef.configPathKey) })] }))] }), _jsxs("div", { className: "relative", children: [_jsx("pre", { className: "px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg text-[11px] text-gray-300 font-mono overflow-x-auto leading-relaxed max-h-32 overflow-y-auto", children: mcpSnippet }), _jsx("button", { onClick: () => handleCopy(mcpSnippet, 'mcp'), className: "absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors", children: copied === 'mcp' ? _jsx(Check, { size: 11, className: "text-emerald-400" }) : _jsx(Copy, { size: 11 }) })] })] }), skillLoaded && skillContent && (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-1.5", children: [_jsx("span", { className: "text-[11px] text-gray-400 font-medium", children: t('agent.skillFile') }), toolDef && (_jsxs("span", { className: "text-[10px] text-gray-500", children: [t('agent.copyTo'), " ", _jsx("code", { className: "text-gray-400", children: t(toolDef.skillPathKey) })] }))] }), _jsxs("div", { className: "relative", children: [_jsxs("pre", { className: "px-3 py-2 bg-white/[0.03] border border-white/5 rounded-lg text-[11px] text-gray-300 font-mono overflow-x-auto leading-relaxed max-h-32 overflow-y-auto", children: [skillContent.slice(0, 500), skillContent.length > 500 ? '\n...' : ''] }), _jsx("button", { onClick: () => handleCopy(skillContent, 'skill'), className: "absolute top-1.5 right-1.5 p-1 bg-white/5 hover:bg-white/10 rounded text-gray-400 hover:text-gray-200 transition-colors", children: copied === 'skill' ? _jsx(Check, { size: 11, className: "text-emerald-400" }) : _jsx(Copy, { size: 11 }) })] }), _jsx("p", { className: "text-[10px] text-gray-500 mt-1", children: t('agent.skillHint') })] }))] }))] }));
}
