import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Check, Clock, Lock, Database, Link2, Sparkles, Search, Brain, Settings2, Cpu, Timer } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';
import { NumberField, SliderField } from './shared';
import { classifyParam, NODES_BY_GROUP, TRIGGER_ICONS, TRIGGER_LABEL_KEYS, TRIGGER_STYLES } from './internal-strategy/catalog';
import { EmbeddedStrategyPanel } from './internal-strategy/EmbeddedStrategyPanel';
import { ProfileFieldsEditor } from './internal-strategy/ProfileFieldsEditor';
import { EditableStrategyParams, LLMConfigSection } from './internal-strategy/StrategyParamEditors';
import { WeightVisualization } from './internal-strategy/WeightVisualization';
// ============================================================
// 按认知功能分组的内部策略管理 — Master-Detail 布局
// ============================================================
// 主组件
// ============================================================
export function InternalStrategy() {
    const { t } = useTranslation('settings');
    const [activeTab, setActiveTab] = useState('memory');
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const nodes = NODES_BY_GROUP[activeTab];
    // Tab 切换时选中第一个节点
    useEffect(() => {
        setSelectedNodeId(nodes[0]?.id ?? null);
    }, [activeTab]);
    const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null;
    const TABS = [
        { key: 'memory', labelKey: 'strategy.groups.memory', icon: _jsx(Database, { size: 12 }) },
        { key: 'think-associate', labelKey: 'strategy.groups.thinkAssociate', icon: _jsx(Link2, { size: 12 }) },
        { key: 'think-emerge', labelKey: 'strategy.groups.thinkEmerge', icon: _jsx(Sparkles, { size: 12 }) },
        { key: 'output', labelKey: 'strategy.groups.output', icon: _jsx(Search, { size: 12 }) },
        { key: 'evolution', labelKey: 'strategy.groups.evolution', icon: _jsx(Brain, { size: 12 }) },
    ];
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "flex gap-1 overflow-x-auto pb-1", children: TABS.map(item => (_jsxs("button", { onClick: () => setActiveTab(item.key), className: `flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-all duration-150 whitespace-nowrap ${activeTab === item.key
                        ? 'text-white'
                        : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'}`, style: activeTab === item.key ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}, children: [_jsx("span", { style: activeTab === item.key ? {} : { opacity: 0.5 }, children: item.icon }), _jsx("span", { children: t(item.labelKey) })] }, item.key))) }), _jsxs(motion.div, { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 }, className: "flex gap-4", children: [_jsx("div", { className: "w-52 flex-shrink-0", children: _jsx("div", { className: "glass-card rounded-xl overflow-hidden", children: nodes.map(node => (_jsx("button", { onClick: () => setSelectedNodeId(node.id), className: `w-full text-left px-3 py-2.5 border-b border-white/5 last:border-b-0 transition-colors ${selectedNodeId === node.id
                                    ? 'bg-white/[0.06]'
                                    : 'hover:bg-white/[0.03]'}`, children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: `text-xs font-medium ${selectedNodeId === node.id ? 'text-gray-100' : 'text-gray-400'}`, children: t(node.name) }), _jsxs("div", { className: "flex items-center gap-1", children: [node.llmStrategy && (_jsx("span", { className: "text-[9px] px-1 py-0.5 rounded bg-indigo-400/10 border border-indigo-400/25 text-indigo-300", children: "LLM" })), _jsx("span", { className: `text-[9px] px-1 py-0.5 rounded ${TRIGGER_STYLES[node.trigger.type]}`, children: t(TRIGGER_LABEL_KEYS[node.trigger.type]) })] })] }) }, node.id))) }) }), _jsx("div", { className: "flex-1 min-w-0", children: selectedNode ? (_jsx(NodeDetailPanel, { node: selectedNode })) : (_jsx("div", { className: "glass-card rounded-xl p-8 text-center text-gray-500 text-sm", children: t('strategy.selectNodeHint') })) })] }, activeTab)] }));
}
// ============================================================
// NodeDetailPanel — 右侧详情面板
// ============================================================
function NodeDetailPanel({ node }) {
    const { t } = useTranslation('settings');
    const { data: config } = useIPC(() => window.api.config.get());
    const { data: gateStatus } = useIPC(() => window.api.stats.gates());
    const [localConfig, setLocalConfig] = useState({});
    const [saved, setSaved] = useState(false);
    // 历史 bug(2026-05-09):configInitialized.current 在 mount 后 100ms 永久置 true,
    // 后续任何 DataChange 推送触发 useIPC refetch → loading effect setLocalConfig
    // 创建新对象引用 → debounce save effect 把整段 metabolism/search/gates 写回
    // 服务器。任何归一化差异就形成持续抖动。
    // 修复:用 dirty.current 替代 — 只在用户通过 setVal 编辑后才 true,loading
    // effect 不动它。
    const dirty = useRef(false);
    const savedTimerRef = useRef(null);
    useEffect(() => {
        if (!config)
            return;
        const c = config;
        setLocalConfig({
            metabolism: { ...c.metabolism },
            search: { ...c.search },
            gates: { ...c.gates },
        });
        // 注意:不再标记 dirty=true,loading 路径只更新本地展示状态。
    }, [config]);
    const getVal = (section, key, fallback) => localConfig[section]?.[key] ?? fallback;
    const setVal = (section, key, v) => {
        dirty.current = true;
        setLocalConfig(prev => ({
            ...prev,
            [section]: { ...prev[section], [key]: v },
        }));
    };
    // debounce 自动保存 config 参数:仅在 dirty.current=true(用户实际编辑后)才写回
    useEffect(() => {
        if (!dirty.current)
            return;
        const timer = setTimeout(async () => {
            await window.api.config.update(localConfig);
            // 保存完成后清 dirty。否则后续任意 useIPC refetch 触发的 setLocalConfig
            // 会让 effect 再次进入(dirty 仍 true)→ 反复写回相同 config 形成幽灵循环。
            dirty.current = false;
            setSaved(true);
            if (savedTimerRef.current)
                clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
        }, 500);
        return () => {
            clearTimeout(timer);
            if (savedTimerRef.current)
                clearTimeout(savedTimerRef.current);
        };
    }, [localConfig]);
    // 分类策略参数
    const triggerStrategyParams = (node.strategyParams ?? []).filter(p => classifyParam(p.key) === 'trigger');
    const llmStrategyParams = (node.strategyParams ?? []).filter(p => classifyParam(p.key) === 'llm');
    const bizStrategyParams = (node.strategyParams ?? []).filter(p => classifyParam(p.key) === 'param');
    // 判断各板块是否有内容
    const hasTriggerSection = (node.gates && node.gates.length > 0) || node.trigger.intervalParam || triggerStrategyParams.length > 0;
    const hasParamSection = (node.configParams && node.configParams.length > 0) || bizStrategyParams.length > 0;
    const hasLLMSection = node.llmStrategy || node.strategy || llmStrategyParams.length > 0;
    // 门控激体激活状态
    const allGatesActive = node.gates && gateStatus ? node.gates.every(g => {
        const current = (g.metric === 'link_count' ? gateStatus.link_count : gateStatus.node_count) ?? 0;
        return current >= getVal('gates', g.key, g.default);
    }) : false;
    const hasConfigEdits = node.configParams && node.configParams.length > 0;
    return (_jsxs(motion.div, { initial: { opacity: 0, x: 10 }, animate: { opacity: 1, x: 0 }, transition: { duration: 0.15 }, className: "space-y-4", children: [_jsxs("div", { className: "glass-card rounded-xl px-5 py-4", children: [_jsxs("div", { className: "flex items-center gap-2.5", children: [_jsx("h2", { className: "text-base font-medium text-gray-100", children: t(node.name) }), _jsxs("span", { className: `text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${TRIGGER_STYLES[node.trigger.type]}`, children: [TRIGGER_ICONS[node.trigger.type], t(node.trigger.label)] }), node.locked && (_jsxs("span", { className: "text-[10px] text-amber-400/70 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center gap-1", children: [_jsx(Lock, { size: 9 }), " ", t('strategy.noAutoEvolution')] })), node.gates && node.gates.length > 0 && gateStatus && (allGatesActive ? (_jsxs("span", { className: "text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-1", children: [_jsx(Check, { size: 9 }), " ", t('strategy.activated')] })) : (_jsxs("span", { className: "text-[10px] text-gray-500 bg-white/5 px-1.5 py-0.5 rounded flex items-center gap-1", children: [_jsx(Clock, { size: 9 }), " ", t('strategy.notActivated')] })))] }), _jsx("p", { className: "text-[12px] text-gray-500 mt-2 leading-relaxed", children: t(node.description) })] }), hasTriggerSection && (_jsxs(SectionCard, { icon: _jsx(Timer, { size: 13 }), title: t('strategy.triggerConfig'), children: [node.gates?.map(g => (_jsxs("div", { className: "mb-1", children: [_jsx(NumberField, { label: t(g.label), tip: t(g.tip), value: getVal('gates', g.key, g.default), onChange: v => setVal('gates', g.key, v), step: 10, unit: g.unit ? t(g.unit) : undefined }), gateStatus && _jsx(GateProgress, { gateKey: g.key, gateStatus: gateStatus, getVal: getVal, fallback: g.default, metric: g.metric })] }, g.key))), node.trigger.intervalParam && (_jsx(EditableStrategyParams, { params: [node.trigger.intervalParam] })), triggerStrategyParams.length > 0 && (_jsx(EditableStrategyParams, { params: triggerStrategyParams }))] })), hasParamSection && (_jsxs(SectionCard, { icon: _jsx(Settings2, { size: 13 }), title: t('strategy.paramConfig'), children: [node.special === 'weights' && _jsx(WeightVisualization, { getVal: getVal }), node.special === 'profile-fields' && _jsx(ProfileFieldsEditor, { strategyName: "profile-synthesize" }), node.configParams?.map(p => node.special === 'weights' ? (_jsx(SliderField, { label: t(p.label), tip: t(p.tip), value: getVal(p.section, p.key, p.default), onChange: v => setVal(p.section, p.key, v), min: 0, max: 1, step: p.step ?? 0.05 }, p.key)) : (_jsx(NumberField, { label: t(p.label), tip: t(p.tip), value: getVal(p.section, p.key, p.default), onChange: v => setVal(p.section, p.key, v), step: p.step ?? 0.01, unit: p.unit ? t(p.unit) : undefined }, p.key))), bizStrategyParams.length > 0 && (_jsx(EditableStrategyParams, { params: bizStrategyParams })), saved && (_jsxs("div", { className: "flex items-center justify-end gap-1.5 pt-2 text-xs text-green-400", children: [_jsx(Check, { size: 12 }), t('strategy.saved')] }))] })), hasLLMSection && (_jsxs(SectionCard, { icon: _jsx(Cpu, { size: 13 }), title: t('strategy.llmConfig'), children: [node.llmStrategy && (_jsx(LLMConfigSection, { strategyName: node.llmStrategy })), llmStrategyParams.length > 0 && (_jsx(EditableStrategyParams, { params: llmStrategyParams })), node.strategy && (_jsx("div", { className: "pt-2 border-t border-white/5 mt-3", children: _jsx(EmbeddedStrategyPanel, { name: node.strategy, type: "system", locked: node.locked }) })), node.strategy && (_jsx("div", { className: "pt-2 border-t border-white/5 mt-3", children: _jsx(EmbeddedStrategyPanel, { name: node.strategy, type: "user" }) }))] }))] }, node.id));
}
// ============================================================
// SectionCard — 板块容器
// ============================================================
function SectionCard({ icon, title, children }) {
    return (_jsxs("div", { className: "glass-card rounded-xl overflow-hidden", children: [_jsxs("div", { className: "flex items-center gap-2 px-5 py-3 border-b border-white/5", children: [_jsx("span", { className: "text-gray-500", children: icon }), _jsx("span", { className: "text-xs font-medium text-gray-300", children: title })] }), _jsx("div", { className: "px-5 py-3 space-y-2", children: children })] }));
}
// ============================================================
// GateProgress: 门控进度条
// ============================================================
function GateProgress({ gateKey, gateStatus, getVal, fallback, metric }) {
    const threshold = getVal('gates', gateKey, fallback);
    const current = (metric === 'link_count' ? gateStatus.link_count : gateStatus.node_count) ?? 0;
    const progress = threshold > 0 ? Math.min(current / threshold, 1) : 1;
    const active = progress >= 1;
    return (_jsx("div", { className: "w-full h-1.5 rounded-full bg-white/5 overflow-hidden mt-1.5", children: _jsx("div", { className: `h-full rounded-full transition-all duration-700 ${active ? 'bg-emerald-500' : progress >= 0.5 ? 'bg-amber-500/70' : 'bg-gray-600'}`, style: { width: `${progress * 100}%` } }) }));
}
