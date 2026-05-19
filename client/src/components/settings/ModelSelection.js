import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle, Check } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';
import { Section, Field, inputClass } from './shared';
import { safeJsonParse } from '../../lib/json';
// ============================================================
// 模型选择：从已配置连接聚合可用模型，按连接名分组
// ============================================================
const selectClass = 'w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50 appearance-none cursor-pointer';
// ---- 推荐模型列表（人工维护） ----
const CLAUDE_MODELS = [
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];
const GEMINI_MODELS = [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
    { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (Preview)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
];
// connectionId::model 编码
function encode(connectionId, model) {
    return `${connectionId}::${model}`;
}
function decode(value) {
    const idx = value.indexOf('::');
    if (idx === -1)
        return { connectionId: '', model: value };
    return { connectionId: value.slice(0, idx), model: value.slice(idx + 2) };
}
// ---- 统一模型下拉 ----
function UnifiedModelSelect({ value, onChange, groups, loading, placeholder }) {
    const { t } = useTranslation('settings');
    const allOptions = groups.flatMap(g => g.options);
    const hasOptions = allOptions.length > 0;
    if (loading) {
        return (_jsxs("div", { className: "flex items-center gap-2 py-2 text-xs text-gray-500", children: [_jsx(Loader2, { size: 12, className: "animate-spin" }), t('model.selection.loadingModels')] }));
    }
    if (!hasOptions) {
        return (_jsx("input", { value: decode(value).model, onChange: e => onChange(e.target.value), placeholder: placeholder ?? t('model.selection.noConnectionPlaceholder'), className: inputClass }));
    }
    // 查找当前选中值所属的连接名
    const selectedOption = allOptions.find(o => o.value === value);
    const selectedGroup = selectedOption ? groups.find(g => g.options.includes(selectedOption)) : null;
    const showPrefix = groups.length > 1; // 多个连接时显示前缀
    return (_jsxs("select", { value: value, onChange: e => onChange(e.target.value), className: selectClass, children: [value && !selectedOption && (() => {
                const d = decode(value);
                return _jsxs("option", { value: value, children: [d.model, " (", d.connectionId, ")"] });
            })(), groups.map(g => g.options.length > 0 && (_jsx("optgroup", { label: g.connectionName, children: g.options.map(o => (_jsxs("option", { value: o.value, disabled: o.disabled, children: [showPrefix ? `${g.connectionName} / ${o.label}` : o.label, o.disabled ? ` (${t('model.selection.unavailable')})` : ''] }, o.value))) }, g.connectionName)))] }));
}
export function ModelSelection() {
    const { t } = useTranslation('settings');
    const { data: config, refetch: refetchConfig } = useIPC(() => window.api.config.get());
    const { data: connections } = useIPC(() => window.api.connections.list());
    const { data: reembedStatus, refetch: recheckReembed } = useIPC(() => window.api.embedding.reembedStatus());
    const [lightValue, setLightValue] = useState('');
    const [standardValue, setStandardValue] = useState('');
    const [heavyValue, setHeavyValue] = useState('');
    const [embValue, setEmbValue] = useState('');
    const [saved, setSaved] = useState(false);
    const [reembedding, setReembedding] = useState(false);
    // 历史 bug(2026-05-09):initialized.current 在 mount 后第一次进 debounce
    // effect 时被设 true,后续任何 config refetch 触发的 setLightValue 等都会
    // 让 debounce effect 误判为"用户编辑",把刚拉到的值再写回服务器。任何
    // encode/decode 归一化差异就形成持续抖动。
    // 修复:把"是否触发自动保存"绑定到 dirty.current —— 只在用户通过下拉
    // 菜单 onChange 时才置 true,loading effect 不动它。
    const dirty = useRef(false);
    const saveNowRef = useRef(null);
    // 把每个 setter 包成"用户操作版本":显式标 dirty 才允许触发自动保存
    const onChangeLight = useCallback((v) => { dirty.current = true; setLightValue(v); }, []);
    const onChangeStandard = useCallback((v) => { dirty.current = true; setStandardValue(v); }, []);
    const onChangeHeavy = useCallback((v) => { dirty.current = true; setHeavyValue(v); }, []);
    const onChangeEmb = useCallback((v) => { dirty.current = true; setEmbValue(v); }, []);
    // 构建 connectionId 到 name 的映射
    const connMap = useMemo(() => {
        const m = new Map();
        for (const c of (connections ?? [])) {
            m.set(c.id, c);
        }
        return m;
    }, [connections]);
    useEffect(() => {
        if (config && connections) {
            const c = config;
            // 优先使用 connection_id 编码，回退到旧的 provider 编码
            const resolveSlot = (connKey, providerKey, defaultProvider, modelKey, defaultModel) => {
                const connId = connKey;
                const model = modelKey || defaultModel;
                if (connId && connMap.has(connId)) {
                    return encode(connId, model);
                }
                // 回退：按 provider 找第一个匹配的 connection
                const prov = providerKey || defaultProvider;
                const fallbackConn = connections.find(conn => conn.provider_type === prov && !conn.archived);
                if (fallbackConn) {
                    return encode(fallbackConn.id, model);
                }
                return encode('', model);
            };
            const defaultProv = c.llm?.provider ?? 'anthropic';
            setLightValue(resolveSlot(c.llm?.light_connection, c.llm?.light_provider ?? defaultProv, defaultProv, c.llm?.light_model, 'claude-haiku-4-5'));
            setStandardValue(resolveSlot(c.llm?.standard_connection, c.llm?.standard_provider ?? defaultProv, defaultProv, c.llm?.standard_model, 'claude-sonnet-4-6'));
            setHeavyValue(resolveSlot(c.llm?.heavy_connection, c.llm?.heavy_provider ?? defaultProv, defaultProv, c.llm?.heavy_model, 'claude-opus-4-7'));
            const embProv = c.embedding?.provider ?? 'vertex';
            setEmbValue(resolveSlot(c.embedding?.connection, embProv, embProv, c.embedding?.model, 'gemini-embedding-001'));
        }
    }, [config, connections, connMap]);
    // Polling reembed progress
    useEffect(() => {
        if (!reembedding)
            return;
        const timer = setInterval(() => recheckReembed(), 2000);
        return () => clearInterval(timer);
    }, [reembedding, recheckReembed]);
    useEffect(() => {
        if (reembedStatus && !reembedStatus.running && reembedding) {
            setReembedding(false);
        }
    }, [reembedStatus, reembedding]);
    // ---- 构建 LLM 模型列表（按连接分组） ----
    const llmGroups = useMemo(() => {
        if (!connections)
            return [];
        const groups = [];
        for (const conn of connections) {
            if (conn.archived)
                continue;
            const availableModels = safeJsonParse(conn.available_models, []);
            if (conn.provider_type === 'anthropic' || conn.provider_type === 'vertex') {
                groups.push({
                    connectionName: conn.name,
                    options: CLAUDE_MODELS.map(m => ({
                        connectionId: conn.id, model: m.id,
                        value: encode(conn.id, m.id),
                        label: m.label,
                        disabled: availableModels.length > 0 ? !availableModels.includes(m.id) : false,
                    })),
                });
            }
            if (conn.provider_type === 'gemini') {
                groups.push({
                    connectionName: conn.name,
                    options: GEMINI_MODELS.map(m => ({
                        connectionId: conn.id, model: m.id,
                        value: encode(conn.id, m.id),
                        label: m.label,
                    })),
                });
            }
            if (conn.provider_type === 'ollama' || conn.provider_type === 'openai-compatible') {
                const models = safeJsonParse(conn.available_models, []);
                if (models.length > 0) {
                    groups.push({
                        connectionName: conn.name,
                        options: models.map(m => ({
                            connectionId: conn.id, model: m,
                            value: encode(conn.id, m),
                            label: m,
                        })),
                    });
                }
            }
        }
        return groups;
    }, [connections]);
    // ---- 构建 Embedding 模型列表 ----
    const embGroups = useMemo(() => {
        if (!connections)
            return [];
        const groups = [];
        for (const conn of connections) {
            if (conn.archived)
                continue;
            if (conn.provider_type === 'vertex' || conn.provider_type === 'gemini') {
                groups.push({
                    connectionName: conn.name,
                    options: [{
                            connectionId: conn.id, model: 'gemini-embedding-001',
                            value: encode(conn.id, 'gemini-embedding-001'),
                            label: `Gemini Embedding 001 (3072 dim)`,
                        }],
                });
            }
            if (conn.provider_type === 'ollama') {
                const ollamaModels = safeJsonParse(conn.available_models, []);
                if (ollamaModels.length > 0) {
                    groups.push({
                        connectionName: conn.name,
                        options: ollamaModels.map(m => ({
                            connectionId: conn.id, model: m,
                            value: encode(conn.id, m),
                            label: `${m} (768 dim)`,
                        })),
                    });
                }
            }
        }
        return groups;
    }, [connections]);
    // 当前选中的 embedding 信息
    const selectedEmb = decode(embValue);
    const selectedEmbConn = connMap.get(selectedEmb.connectionId);
    const embDimensions = selectedEmbConn?.provider_type === 'ollama' ? 768 : 3072;
    const handleTriggerReembed = async () => {
        setReembedding(true);
        await window.api.embedding.triggerReembed();
        recheckReembed();
    };
    // 即时保存
    const saveNow = useCallback(async (lv, sv, hv, ev) => {
        const light = decode(lv);
        const standard = decode(sv);
        const heavy = decode(hv);
        const emb = decode(ev);
        // 推断 provider（向后兼容）
        const getProviderType = (connId) => {
            const conn = connMap.get(connId);
            return conn?.provider_type ?? 'anthropic';
        };
        const dims = getProviderType(emb.connectionId) === 'ollama' ? 768 : 3072;
        await window.api.config.update({
            llm: {
                provider: getProviderType(light.connectionId) || 'anthropic',
                light_connection: light.connectionId || undefined,
                light_provider: getProviderType(light.connectionId) || 'anthropic',
                standard_connection: standard.connectionId || undefined,
                standard_provider: getProviderType(standard.connectionId) || 'anthropic',
                heavy_connection: heavy.connectionId || undefined,
                heavy_provider: getProviderType(heavy.connectionId) || 'anthropic',
                light_model: light.model,
                standard_model: standard.model,
                heavy_model: heavy.model,
            },
            embedding: {
                connection: emb.connectionId || undefined,
                provider: getProviderType(emb.connectionId) || 'vertex',
                model: emb.model,
                dimensions: dims,
            },
        });
        // 保存完成后清 dirty,否则 refetchConfig 触发的 setX 会让 debounce effect
        // 再次进入(dirty 仍 true)→ 把刚拉的值反复写回。重置 dirty 必须在 refetch
        // 之前,setX 由 useIPC 派进来时 effect 看到 dirty=false 直接 return。
        dirty.current = false;
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        refetchConfig();
    }, [refetchConfig, connMap]);
    // 始终指向最新的 saveNow（避免 effect deps 循环）
    saveNowRef.current = saveNow;
    // debounce 自动保存:只在用户实际编辑后(dirty.current=true)才触发,
    // config refetch 引发的 setX 不会写回服务器。
    useEffect(() => {
        if (!dirty.current)
            return;
        const timer = setTimeout(() => {
            saveNowRef.current?.(lightValue, standardValue, heavyValue, embValue);
        }, 300);
        return () => clearTimeout(timer);
    }, [lightValue, standardValue, heavyValue, embValue]);
    return (_jsxs("div", { className: "space-y-6 max-w-lg", children: [_jsx(Section, { title: "LLM", children: _jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Field, { label: t('model.selection.lightModel'), tip: t('model.selection.lightModelTip'), children: _jsx(UnifiedModelSelect, { value: lightValue, onChange: onChangeLight, groups: llmGroups }) }), _jsx("p", { className: "text-[10px] text-gray-500", children: t('model.selection.lightModelUsage') })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Field, { label: t('model.selection.standardModel'), tip: t('model.selection.standardModelTip'), children: _jsx(UnifiedModelSelect, { value: standardValue, onChange: onChangeStandard, groups: llmGroups }) }), _jsx("p", { className: "text-[10px] text-gray-500", children: t('model.selection.standardModelUsage') })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Field, { label: t('model.selection.heavyModel'), tip: t('model.selection.heavyModelTip'), children: _jsx(UnifiedModelSelect, { value: heavyValue, onChange: onChangeHeavy, groups: llmGroups }) }), _jsx("p", { className: "text-[10px] text-gray-500", children: t('model.selection.heavyModelUsage') })] })] }) }), _jsxs(Section, { title: "Embedding", children: [_jsxs("div", { className: "space-y-3", children: [_jsx(Field, { label: t('model.selection.embeddingModel'), tip: t('model.selection.embeddingModelTip'), children: _jsx(UnifiedModelSelect, { value: embValue, onChange: onChangeEmb, groups: embGroups }) }), _jsxs("div", { className: "flex items-center gap-4", children: [_jsxs("span", { className: "text-[10px] text-gray-500", children: [t('model.selection.dimensions'), ": ", embDimensions] }), _jsxs("span", { className: "text-[10px] text-gray-500", children: [t('model.selection.connectionLabel'), ": ", selectedEmbConn?.name ?? t('model.selection.notSelected')] })] }), _jsx("p", { className: "text-[10px] text-gray-500", children: t('model.selection.embeddingUsage') })] }), (reembedStatus?.needed || reembedStatus?.running) && (_jsxs("div", { className: "mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg", children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(AlertTriangle, { size: 12, className: "text-amber-400" }), _jsx("p", { className: "text-xs text-amber-300", children: reembedStatus.running
                                            ? t('model.selection.reembedProgress', { done: reembedStatus.done, total: reembedStatus.total })
                                            : t('model.selection.reembedNeeded') })] }), !reembedStatus.running && (_jsxs("button", { onClick: handleTriggerReembed, disabled: reembedding, className: "flex items-center gap-2 px-3 py-1.5 text-xs bg-amber-500/20 hover:bg-amber-500/30 rounded-lg text-amber-300 transition-colors disabled:opacity-50", children: [reembedding && _jsx(Loader2, { size: 12, className: "animate-spin" }), t('model.selection.startReembed')] })), reembedStatus.running && (_jsx("div", { className: "w-full bg-white/10 rounded-full h-1.5 mt-2", children: _jsx("div", { className: "bg-amber-400 h-1.5 rounded-full transition-all", style: { width: `${reembedStatus.total > 0 ? (reembedStatus.done / reembedStatus.total) * 100 : 0}%` } }) }))] }))] }), saved && (_jsxs("div", { className: "flex items-center gap-1.5 text-xs text-green-400 transition-opacity", children: [_jsx(Check, { size: 12 }), t('model.selection.saved')] }))] }));
}
