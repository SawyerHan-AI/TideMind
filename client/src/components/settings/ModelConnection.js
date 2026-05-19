import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ChevronRight, Loader2, CheckCircle2, XCircle, Pencil, Check, X, Archive, RotateCcw, Trash2, Upload, MoreHorizontal, Link, Eye, EyeOff, } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';
import { Section, Field, inputClass, ComingSoonBadge } from './shared';
import { safeJsonParse } from '../../lib/json';
const PROVIDER_TYPES = [
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'vertex', label: 'Google Vertex AI' },
    { id: 'gemini', label: 'Google Gemini API' },
    { id: 'ollama', label: 'Ollama' },
    { id: 'openai-compatible', label: 'OpenAI Compatible' },
];
const VERTEX_REGIONS = [
    'us-central1', 'us-east1', 'us-east4', 'us-east5', 'us-west1',
    'europe-west1', 'europe-west4', 'asia-northeast1', 'asia-southeast1',
];
const PROVIDER_LABELS = {
    anthropic: 'Anthropic',
    vertex: 'Vertex AI',
    gemini: 'Gemini API',
    ollama: 'Ollama',
    'openai-compatible': 'OpenAI Compatible',
};
function getProviderDef(providerType) {
    return PROVIDER_TYPES.find(t => t.id === providerType);
}
/** 生成 4 位随机后缀 */
function randomSuffix() {
    return Math.random().toString(36).slice(2, 6);
}
// ============================================================
// 密钥输入框(带显示/隐藏切换)
// ============================================================
function SecretInput({ value, onChange, placeholder, show, onToggleShow, }) {
    return (_jsxs("div", { className: "relative", children: [_jsx("input", { type: show ? 'text' : 'password', value: value, onChange: e => onChange(e.target.value), placeholder: placeholder, className: `${inputClass} pr-9`, autoComplete: "off", spellCheck: false }), _jsx("button", { type: "button", onClick: onToggleShow, className: "absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 transition-colors p-1", tabIndex: -1, children: show ? _jsx(EyeOff, { size: 14 }) : _jsx(Eye, { size: 14 }) })] }));
}
// ============================================================
// 连接详情面板
// ============================================================
function ConnectionDetailPanel({ conn, onRefresh }) {
    const { t } = useTranslation('settings');
    const [editing, setEditing] = useState(false);
    const [editName, setEditName] = useState(conn.name);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    // 凭证按需取(走 connections:get-credentials),不在 list 里下发避免列表
    // 刷新时把所有连接的密钥扇出到 renderer 内存。creds === null 表示尚未加载,
    // Save 在此期间 disabled,杜绝"空表单写回 DB 擦凭证"路径。
    const [creds, setCreds] = useState(null);
    const [apiKey, setApiKey] = useState('');
    const [projectId, setProjectId] = useState('');
    const [region, setRegion] = useState('us-central1');
    const [uploading, setUploading] = useState(false);
    const [vertexCredStatus, setVertexCredStatus] = useState(null);
    const [geminiKey, setGeminiKey] = useState('');
    const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
    const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
    const [openaiApiKey, setOpenaiApiKey] = useState('');
    const [saved, setSaved] = useState(false);
    // 显示/隐藏密钥切换:同一面板里同一时刻只展示一个 provider 的密钥字段,
    // 共享一个 toggle 即可。
    const [showSecret, setShowSecret] = useState(false);
    useEffect(() => {
        let cancelled = false;
        window.api.connections.getCredentials(conn.id)
            .then(c => {
            if (cancelled)
                return;
            setCreds(c);
            setApiKey(c.api_key ?? '');
            setProjectId(c.project_id ?? '');
            setRegion(c.region ?? 'us-central1');
            setGeminiKey(c.api_key ?? '');
            setOllamaUrl(c.url ?? 'http://localhost:11434');
            setOpenaiBaseUrl(c.base_url ?? '');
            setOpenaiApiKey(c.api_key ?? '');
        })
            .catch(() => {
            // IPC 报错(校验失败 / 通道异常)时降级为空凭证视图,
            // 不让 Save 永远 disabled 卡住用户。
            if (cancelled)
                return;
            setCreds({});
        });
        return () => { cancelled = true; };
    }, [conn.id]);
    useEffect(() => {
        if (conn.provider_type === 'vertex') {
            window.api.connections.vertexCredStatus(conn.id).then(setVertexCredStatus);
        }
    }, [conn.id, conn.provider_type]);
    const handleRename = async () => {
        if (!editName.trim())
            return;
        await window.api.connections.update(conn.id, { name: editName.trim() });
        setEditing(false);
        onRefresh();
    };
    const handleSaveCredentials = async () => {
        // creds 还在加载就不允许保存,否则空表单会写回 DB 擦掉凭证
        if (creds === null)
            return;
        let credentials;
        switch (conn.provider_type) {
            case 'anthropic':
                credentials = { api_key: apiKey };
                break;
            case 'vertex':
                credentials = { project_id: projectId, region };
                break;
            case 'gemini':
                credentials = { api_key: geminiKey };
                break;
            case 'ollama':
                credentials = { url: ollamaUrl };
                break;
            case 'openai-compatible':
                credentials = { base_url: openaiBaseUrl, api_key: openaiApiKey };
                break;
            default: return;
        }
        await window.api.connections.update(conn.id, { credentials });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        onRefresh();
    };
    // 测试连接只读 DB 里的当前凭证,不再 auto-save 表单。否则
    // connections:list 出于安全把 credentials 抹成 undefined,表单
    // 用空值预填,点测试就会把已存的 API Key 覆盖成空串。
    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await window.api.connections.test(conn.id);
            setTestResult(result);
        }
        catch (e) {
            setTestResult({ online: false, models: [], error: e.message });
        }
        setTesting(false);
        onRefresh();
    };
    const handleArchive = async () => {
        await window.api.connections.archive(conn.id);
        onRefresh();
    };
    const handleUploadVertex = async () => {
        setUploading(true);
        try {
            const result = await window.api.connections.pickVertexFile(conn.id);
            if (result.success && result.projectId)
                setProjectId(result.projectId);
            setVertexCredStatus(result.success ? { configured: true, projectId: result.projectId } : { configured: false });
        }
        catch { }
        setUploading(false);
    };
    return (_jsxs("div", { className: "px-3 pb-4 pt-3 border-t border-white/5 space-y-4", children: [_jsx("div", { className: "flex items-center gap-2", children: editing ? (_jsxs(_Fragment, { children: [_jsx("input", { value: editName, onChange: e => setEditName(e.target.value), className: `${inputClass} flex-1`, autoFocus: true, onKeyDown: e => e.key === 'Enter' && handleRename() }), _jsx("button", { onClick: handleRename, className: "p-1 text-emerald-400 hover:bg-white/5 rounded", children: _jsx(Check, { size: 14 }) }), _jsx("button", { onClick: () => { setEditing(false); setEditName(conn.name); }, className: "p-1 text-gray-400 hover:bg-white/5 rounded", children: _jsx(X, { size: 14 }) })] })) : (_jsxs("button", { onClick: () => setEditing(true), className: "flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors", children: [_jsx(Pencil, { size: 11 }), " ", t('model.connection.rename')] })) }), conn.provider_type === 'anthropic' && (_jsx(Field, { label: "API Key", tip: t('model.connection.anthropicTip'), children: _jsx(SecretInput, { value: apiKey, onChange: setApiKey, placeholder: "sk-ant-...", show: showSecret, onToggleShow: () => setShowSecret(!showSecret) }) })), conn.provider_type === 'vertex' && (_jsxs("div", { className: "space-y-3", children: [_jsx(Field, { label: "Project ID", tip: t('model.connection.vertexProjectTip'), children: _jsx("input", { value: projectId, onChange: e => setProjectId(e.target.value), placeholder: "my-gcp-project", className: inputClass }) }), _jsx(Field, { label: "Region", tip: t('model.connection.vertexRegionTip'), children: _jsx("select", { value: region, onChange: e => setRegion(e.target.value), className: inputClass, children: VERTEX_REGIONS.map(r => _jsx("option", { value: r, children: r }, r)) }) }), _jsxs("div", { children: [_jsx("label", { className: "text-xs text-gray-400 mb-1 block", children: t('model.connection.vertexCredLabel') }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { onClick: handleUploadVertex, disabled: uploading, className: "flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50", children: [uploading ? _jsx(Loader2, { size: 12, className: "animate-spin" }) : _jsx(Upload, { size: 12 }), t('model.connection.selectFile')] }), vertexCredStatus?.configured && (_jsxs("span", { className: "flex items-center gap-1 text-[10px] text-emerald-400", children: [_jsx(CheckCircle2, { size: 10 }), t('model.connection.uploaded'), vertexCredStatus.projectId && ` (${vertexCredStatus.projectId})`] }))] })] })] })), conn.provider_type === 'gemini' && (_jsx(Field, { label: "API Key", tip: t('model.connection.geminiTip'), children: _jsx(SecretInput, { value: geminiKey, onChange: setGeminiKey, placeholder: "AIza...", show: showSecret, onToggleShow: () => setShowSecret(!showSecret) }) })), conn.provider_type === 'ollama' && (_jsx(Field, { label: t('model.connection.serviceUrl'), tip: t('model.connection.ollamaTip'), children: _jsx("input", { value: ollamaUrl, onChange: e => setOllamaUrl(e.target.value), className: inputClass }) })), conn.provider_type === 'openai-compatible' && (_jsxs("div", { className: "space-y-3", children: [_jsx(Field, { label: "Base URL", tip: t('model.connection.openaiBaseUrlTip'), children: _jsx("input", { value: openaiBaseUrl, onChange: e => setOpenaiBaseUrl(e.target.value), placeholder: "http://localhost:8000", className: inputClass }) }), _jsx(Field, { label: "API Key", tip: t('model.connection.openaiApiKeyTip'), children: _jsx(SecretInput, { value: openaiApiKey, onChange: setOpenaiApiKey, placeholder: t('model.connection.openaiApiKeyPlaceholder'), show: showSecret, onToggleShow: () => setShowSecret(!showSecret) }) })] })), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("button", { onClick: handleSaveCredentials, disabled: creds === null, className: "flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed", children: t('model.connection.save') }), _jsxs("button", { onClick: handleTest, disabled: testing, className: "flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50", children: [testing && _jsx(Loader2, { size: 12, className: "animate-spin" }), t('model.connection.testConnection')] }), _jsxs("button", { onClick: handleArchive, className: "flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-white/5 rounded-lg transition-colors", children: [_jsx(Archive, { size: 11 }), " ", t('model.connection.archive')] }), saved && (_jsxs("span", { className: "flex items-center gap-1 text-[10px] text-emerald-400", children: [_jsx(Check, { size: 10 }), " ", t('model.connection.saved')] }))] }), testResult && (_jsx("div", { className: `p-2.5 rounded-lg text-[11px] ${testResult.online ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}`, children: testResult.online ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center gap-1.5 text-emerald-400 mb-1.5", children: [_jsx(CheckCircle2, { size: 11 }), _jsx("span", { children: t('model.connection.modelsAvailable', { count: testResult.models.length }) })] }), _jsx("div", { className: "flex flex-wrap gap-1", children: testResult.models.map(m => (_jsx("span", { className: "text-[10px] bg-white/5 text-gray-300 px-1.5 py-0.5 rounded", children: m }, m))) })] })) : (_jsxs("span", { className: "flex items-center gap-1.5 text-red-400", children: [_jsx(XCircle, { size: 11 }), testResult.error ?? t('model.connection.connectionFailed')] })) })), _jsxs("div", { className: "text-[10px] text-gray-600", children: ["ID: ", conn.id] })] }));
}
// ============================================================
// 创建向导
// ============================================================
function ConnectionWizard({ onCreated, onClose }) {
    const { t } = useTranslation('settings');
    const [name, setName] = useState('');
    const [providerType, setProviderType] = useState('');
    const [creating, setCreating] = useState(false);
    // 追踪名称是否被用户手动修改过
    const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
    // 选择类型后自动更新名称（除非用户已手动编辑）
    useEffect(() => {
        if (providerType && !nameManuallyEdited) {
            const def = getProviderDef(providerType);
            if (def)
                setName(`${def.label} ${randomSuffix()}`);
        }
    }, [providerType, nameManuallyEdited]);
    const handleNameChange = (v) => {
        setName(v);
        setNameManuallyEdited(true);
    };
    const handleCreate = async () => {
        if (!name.trim() || !providerType)
            return;
        setCreating(true);
        const conn = await window.api.connections.create({
            name: name.trim(),
            provider_type: providerType,
        });
        setCreating(false);
        onCreated(conn.id);
    };
    return (_jsx(Section, { title: t('model.connection.newConnection'), action: _jsx("button", { onClick: onClose, className: "p-1 text-gray-500 hover:text-gray-300", children: _jsx(X, { size: 14 }) }), children: _jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "grid grid-cols-2 gap-2", children: PROVIDER_TYPES.map(pt => (_jsxs("button", { disabled: pt.comingSoon, onClick: () => setProviderType(pt.id), className: `p-3 rounded-lg text-left transition-all ${pt.comingSoon
                            ? 'opacity-40 cursor-not-allowed bg-white/[0.02]'
                            : providerType === pt.id
                                ? 'bg-indigo-500/10 border border-indigo-400/30'
                                : 'bg-white/[0.03] hover:bg-white/[0.06] border border-white/5'}`, children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-xs font-medium text-gray-200", children: pt.label }), pt.comingSoon && _jsx(ComingSoonBadge, {})] }), _jsx("p", { className: "text-[10px] text-gray-500 mt-1", children: t(`model.connection.providerDesc.${pt.id}`) })] }, pt.id))) }), providerType && (_jsx(Field, { label: t('model.connection.connectionName'), tip: t('model.connection.connectionNameTip'), children: _jsx("input", { value: name, onChange: e => handleNameChange(e.target.value), placeholder: t('model.connection.connectionNamePlaceholder', { provider: PROVIDER_LABELS[providerType] ?? providerType }), className: inputClass, autoFocus: true, onKeyDown: e => e.key === 'Enter' && handleCreate() }) })), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors", children: t('model.connection.cancel') }), _jsxs("button", { onClick: handleCreate, disabled: !name.trim() || !providerType || creating, className: "flex items-center gap-2 px-4 py-1.5 text-xs bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 rounded-lg transition-colors disabled:opacity-50", children: [creating && _jsx(Loader2, { size: 12, className: "animate-spin" }), t('model.connection.create')] })] })] }) }));
}
// ============================================================
// 主组件（表格行布局，与 AgentIntegration 一致）
// ============================================================
export function ModelConnection() {
    const { t } = useTranslation('settings');
    const { data: connections, refetch: refetchConnections } = useIPC(() => window.api.connections.list(true));
    const { data: config } = useIPC(() => window.api.config.get());
    const [wizardOpen, setWizardOpen] = useState(false);
    const [expandedId, setExpandedId] = useState(null);
    const [showArchived, setShowArchived] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const activeConns = (connections ?? []).filter((c) => !c.archived);
    const archivedConns = (connections ?? []).filter((c) => c.archived);
    // 检查连接是否被模型选择引用
    const getUsages = (connId) => {
        if (!config)
            return [];
        const c = config;
        const usages = [];
        const llmConns = [c.llm?.light_connection, c.llm?.standard_connection, c.llm?.heavy_connection];
        if (llmConns.includes(connId))
            usages.push('LLM');
        if (c.embedding?.connection === connId)
            usages.push('Embedding');
        return usages;
    };
    const getStatusInfo = (conn) => {
        if (conn.status === 'online')
            return { color: 'bg-emerald-400', textColor: 'text-emerald-400', label: t('model.connection.status.online') };
        if (conn.status === 'offline')
            return { color: 'bg-red-400', textColor: 'text-red-400', label: t('model.connection.status.offline') };
        return { color: 'bg-gray-600', textColor: 'text-gray-500', label: t('model.connection.status.unconfigured') };
    };
    const handleCreated = (id) => {
        setWizardOpen(false);
        setExpandedId(id);
        refetchConnections();
    };
    return (_jsxs("div", { className: "space-y-6 max-w-2xl", children: [_jsxs(Section, { title: t('model.connection.configuredConnections'), children: [_jsx("p", { className: "text-xs text-gray-500 mb-4", children: t('model.connection.description') }), activeConns.length === 0 && !wizardOpen && (_jsx("div", { className: "py-8 text-center text-xs text-gray-500", children: t('model.connection.noConnections') })), activeConns.length > 0 && (_jsxs("div", { className: "space-y-0.5", children: [_jsxs("div", { className: "grid grid-cols-[10rem_6rem_4rem_5rem_1fr_3rem] gap-x-4 items-center px-3 py-2 text-[11px] text-gray-500 font-medium border-b border-white/5", children: [_jsx("span", { children: t('model.connection.colName') }), _jsx("span", { children: t('model.connection.colType') }), _jsx("span", { children: t('model.connection.colStatus') }), _jsx("span", { children: t('model.connection.colModels') }), _jsx("span", { children: t('model.connection.colUsage') }), _jsx("span", {})] }), activeConns.map((conn) => {
                                const status = getStatusInfo(conn);
                                const models = safeJsonParse(conn.available_models, []);
                                const usages = getUsages(conn.id);
                                const isExpanded = expandedId === conn.id;
                                return (_jsxs("div", { children: [_jsxs("button", { onClick: () => setExpandedId(isExpanded ? null : conn.id), className: "w-full grid grid-cols-[10rem_6rem_4rem_5rem_1fr_3rem] gap-x-4 items-center px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors text-left", children: [_jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [_jsx(Link, { size: 14, className: "text-gray-500 flex-shrink-0" }), _jsx("span", { className: "text-xs text-gray-200 font-medium truncate", children: conn.name })] }), _jsx("span", { className: "text-xs text-gray-400 truncate", children: PROVIDER_LABELS[conn.provider_type] ?? conn.provider_type }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("div", { className: `w-2 h-2 rounded-full ${status.color}` }), _jsx("span", { className: `text-xs ${status.textColor}`, children: status.label })] }), _jsx("span", { className: "text-xs text-gray-400 tabular-nums", children: models.length > 0 ? t('model.connection.modelCount', { count: models.length }) : '-' }), _jsx("div", { className: "flex gap-1", children: usages.map(u => (_jsx("span", { className: "text-[10px] bg-indigo-400/10 text-indigo-300 px-1.5 py-0.5 rounded", children: u }, u))) }), _jsx("span", { className: "flex justify-end", children: _jsx(MoreHorizontal, { size: 14, className: "text-gray-500" }) })] }), isExpanded && (_jsx(ConnectionDetailPanel, { conn: conn, onRefresh: refetchConnections }))] }, conn.id));
                            })] })), archivedConns.length > 0 && (_jsxs("div", { className: "mt-4", children: [_jsxs("button", { onClick: () => setShowArchived(!showArchived), className: "flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors", children: [_jsx(ChevronRight, { size: 12, className: `transition-transform ${showArchived ? 'rotate-90' : ''}` }), t('model.connection.archived'), " (", archivedConns.length, ")"] }), showArchived && (_jsx("div", { className: "mt-2 space-y-0.5 pl-2 border-l border-white/5", children: archivedConns.map((conn) => (_jsxs("div", { className: "flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.02]", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Link, { size: 14, className: "text-gray-600" }), _jsx("span", { className: "text-xs text-gray-500", children: conn.name }), _jsx("span", { className: "text-[10px] text-gray-600", children: PROVIDER_LABELS[conn.provider_type] ?? conn.provider_type })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("button", { onClick: async () => {
                                                        await window.api.connections.unarchive(conn.id);
                                                        refetchConnections();
                                                    }, className: "flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors", children: [_jsx(RotateCcw, { size: 10 }), " ", t('model.connection.restore')] }), confirmDelete === conn.id ? (_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsxs("span", { className: "text-[10px] text-red-400", children: [t('model.connection.confirmDelete'), "?"] }), _jsx("button", { onClick: async () => {
                                                                await window.api.connections.delete(conn.id);
                                                                setConfirmDelete(null);
                                                                refetchConnections();
                                                            }, className: "text-[10px] text-red-400 hover:text-red-300 font-medium", children: t('model.connection.confirm') }), _jsx("button", { onClick: () => setConfirmDelete(null), className: "text-[10px] text-gray-500 hover:text-gray-300", children: t('model.connection.cancel') })] })) : (_jsxs("button", { onClick: () => setConfirmDelete(conn.id), className: "flex items-center gap-1 text-[10px] text-gray-600 hover:text-red-400 transition-colors", children: [_jsx(Trash2, { size: 10 }), " ", t('model.connection.delete')] }))] })] }, conn.id))) }))] }))] }), !wizardOpen ? (_jsxs("button", { onClick: () => setWizardOpen(true), className: "flex items-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-gray-300 transition-colors border border-white/5", children: [_jsx(Plus, { size: 14 }), t('model.connection.newConnection')] })) : (_jsx(ConnectionWizard, { onCreated: handleCreated, onClose: () => setWizardOpen(false) }))] }));
}
