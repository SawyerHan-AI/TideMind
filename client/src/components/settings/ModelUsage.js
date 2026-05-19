import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, } from 'recharts';
import { Info, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';
import { useFormatters } from '../../hooks/useFormatters';
import { Section } from './shared';
import { EVENT_TYPE_LABELS, OPERATION_LABELS, getOperationCategory, } from '../../lib/constants';
import { modelColors, categoryColors, chartVar, semantic } from '../../lib/tokens';
// --- 颜色（引用 tokens 单一来源）---
const MODEL_COLORS = modelColors;
const CATEGORY_COLORS = categoryColors;
const CATEGORY_ORDER = ['memory', 'think_associate', 'think_emerge', 'output', 'evolution'];
// --- 工具函数 ---
function formatTokenCount(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)
        return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
function formatCost(n) {
    if (n >= 1)
        return `$${n.toFixed(2)}`;
    if (n >= 0.01)
        return `$${n.toFixed(3)}`;
    if (n > 0)
        return `$${n.toFixed(4)}`;
    return '$0';
}
/** 将 model ID 归入显示类别 */
function getModelGroup(model) {
    const m = model.toLowerCase();
    if (m.includes('haiku'))
        return 'claude-haiku';
    if (m.includes('sonnet'))
        return 'claude-sonnet';
    if (m.includes('opus'))
        return 'claude-opus';
    if (m.includes('flash'))
        return 'gemini-flash';
    if (m.includes('gemini') && m.includes('pro'))
        return 'gemini-pro';
    return 'other';
}
const MODEL_GROUP_LABELS = {
    'claude-haiku': 'Haiku',
    'claude-sonnet': 'Sonnet',
    'claude-opus': 'Opus',
    'gemini-flash': 'Gemini Flash',
    'gemini-pro': 'Gemini Pro',
    other: 'other', // will be resolved via t() at render time
};
function getDateFilter(range) {
    if (range === 'all')
        return {};
    const days = range === '7d' ? 7 : 30;
    const d = new Date();
    d.setDate(d.getDate() - days);
    return { after: d.toISOString().slice(0, 10) };
}
// --- 主组件 ---
const DETAIL_PAGE_SIZE = 100;
export function ModelUsage() {
    const { t } = useTranslation('settings');
    const { data: tokenUsage } = useIPC(() => window.api.stats.tokenUsage());
    const [opsRange, setOpsRange] = useState('30d');
    const [detailRange, setDetailRange] = useState('30d');
    const [detailPage, setDetailPage] = useState(0);
    const opsFilter = useMemo(() => getDateFilter(opsRange), [opsRange]);
    const detailFilter = useMemo(() => ({
        ...getDateFilter(detailRange),
        limit: DETAIL_PAGE_SIZE,
        offset: detailPage * DETAIL_PAGE_SIZE,
    }), [detailRange, detailPage]);
    const { data: opsData } = useIPC(() => window.api.stats.tokenUsageFiltered(opsFilter), [opsFilter]);
    const { data: detailData } = useIPC(() => window.api.stats.tokenUsageFiltered(detailFilter), [detailFilter]);
    const handleDetailRangeChange = useCallback((r) => {
        setDetailRange(r);
        setDetailPage(0);
    }, []);
    const totals = tokenUsage?.totals ?? { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, estimated_cost: 0, call_count: 0 };
    const totalTokens = totals.input_tokens + totals.output_tokens + totals.thinking_tokens;
    return (_jsxs("div", { className: "space-y-6 max-w-2xl", children: [_jsx(SummaryCards, { totals: totals, totalTokens: totalTokens, countByOperation: tokenUsage?.countByOperation ?? [] }), _jsx(TrendChart, { tokenUsage: tokenUsage }), _jsx(OperationStats, { data: opsData, range: opsRange, onRangeChange: setOpsRange }), _jsx(DetailTable, { data: detailData, range: detailRange, onRangeChange: handleDetailRangeChange, page: detailPage, onPageChange: setDetailPage, pageSize: DETAIL_PAGE_SIZE })] }));
}
// ============================================================
// 1. 汇总卡片
// ============================================================
function SummaryCards({ totals, totalTokens, countByOperation }) {
    const { t } = useTranslation('settings');
    // 按5大类别聚合调用次数
    const countByCategory = useMemo(() => {
        const map = {};
        for (const cat of CATEGORY_ORDER)
            map[cat] = 0;
        for (const row of countByOperation) {
            const cat = getOperationCategory(row.operation);
            map[cat] = (map[cat] ?? 0) + row.cnt;
        }
        return map;
    }, [countByOperation]);
    return (_jsxs("div", { className: "grid grid-cols-3 gap-3", children: [_jsx(SummaryCard, { label: t('usage.totalTokens'), value: formatTokenCount(totalTokens), tooltip: _jsxs("div", { className: "space-y-1", children: [_jsxs("div", { className: "flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-400", children: t('usage.input') }), _jsx("span", { children: formatTokenCount(totals.input_tokens) })] }), _jsxs("div", { className: "flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-400", children: t('usage.output') }), _jsx("span", { children: formatTokenCount(totals.output_tokens) })] }), _jsxs("div", { className: "flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-400", children: t('usage.thinking') }), _jsx("span", { children: formatTokenCount(totals.thinking_tokens) })] })] }) }), _jsx(SummaryCard, { label: t('usage.totalCalls'), value: String(totals.call_count), tooltip: _jsx("div", { className: "space-y-1", children: CATEGORY_ORDER.map(cat => (_jsxs("div", { className: "flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-400", children: EVENT_TYPE_LABELS[cat] }), _jsx("span", { children: countByCategory[cat] ?? 0 })] }, cat))) }) }), _jsx(SummaryCard, { label: t('usage.totalEstimatedCost'), value: formatCost(totals.estimated_cost), tooltip: _jsxs("div", { className: "space-y-1", children: [_jsxs("div", { className: "flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-400", children: t('usage.input') }), _jsx("span", { className: "text-[10px] text-gray-500", children: t('usage.perToken') })] }), _jsxs("div", { className: "flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-400", children: t('usage.output') }), _jsx("span", { className: "text-[10px] text-gray-500", children: t('usage.perToken') })] }), _jsxs("div", { className: "flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-400", children: t('usage.thinking') }), _jsx("span", { className: "text-[10px] text-gray-500", children: t('usage.perToken') })] }), _jsxs("div", { className: "border-t border-white/10 pt-1 mt-1 flex justify-between gap-4", children: [_jsx("span", { className: "text-gray-300", children: t('usage.subtotal') }), _jsx("span", { className: "text-white font-medium", children: formatCost(totals.estimated_cost) })] })] }) })] }));
}
function SummaryCard({ label, value, tooltip }) {
    const [visible, setVisible] = useState(false);
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const iconRef = useRef(null);
    const show = () => {
        if (!iconRef.current)
            return;
        const rect = iconRef.current.getBoundingClientRect();
        setPos({ x: rect.right, y: rect.bottom });
        setVisible(true);
    };
    return (_jsxs("div", { className: "glass-card rounded-xl p-3 relative", children: [_jsxs("div", { className: "flex items-start justify-between", children: [_jsx("p", { className: "text-[10px] text-gray-500 mb-1", children: label }), _jsx("span", { ref: iconRef, className: "text-gray-500 hover:text-gray-300 transition-colors cursor-help", onMouseEnter: show, onMouseLeave: () => setVisible(false), children: _jsx(Info, { size: 12 }) }), visible && createPortal(_jsx("div", { className: "fixed z-[9999] min-w-[160px] px-3 py-2.5 rounded-lg text-[11px] text-gray-200 leading-relaxed pointer-events-none backdrop-blur-xl border", style: {
                            right: window.innerWidth - pos.x,
                            top: pos.y + 6,
                            background: 'var(--theme-popup-bg)',
                            borderColor: 'var(--theme-popup-border)',
                            boxShadow: 'var(--theme-popup-shadow)',
                        }, children: tooltip }), document.body)] }), _jsx("p", { className: "text-lg font-semibold font-mono tabular-nums text-gray-100", children: value })] }));
}
// ============================================================
// 2. 趋势图
// ============================================================
function TrendChart({ tokenUsage }) {
    const { t } = useTranslation('settings');
    const [metric, setMetric] = useState('tokens');
    const [dimension, setDimension] = useState('model');
    // 构建堆叠面积图数据
    const { chartData, keys, colors, labels } = useMemo(() => {
        // 动态解析 other 标签（放在 memo 内，依赖 t 以响应语言切换）
        const resolvedModelGroupLabels = {
            ...MODEL_GROUP_LABELS,
            other: t('usage.otherModel'),
        };
        if (!tokenUsage)
            return { chartData: [], keys: [], colors: {}, labels: {} };
        if (dimension === 'model') {
            // 按模型分组
            const source = tokenUsage.dailyByModel;
            const allGroups = new Set();
            const byDate = {};
            for (const row of source) {
                const group = getModelGroup(row.model);
                allGroups.add(group);
                if (!byDate[row.date])
                    byDate[row.date] = {};
                const val = metric === 'tokens'
                    ? (row.input_tokens + row.output_tokens + row.thinking_tokens)
                    : row.estimated_cost;
                byDate[row.date][group] = (byDate[row.date][group] ?? 0) + val;
            }
            const sortedKeys = Array.from(allGroups).sort((a, b) => {
                // 按总量排序，大的在上
                let sumA = 0, sumB = 0;
                for (const d of Object.values(byDate)) {
                    sumA += d[a] ?? 0;
                    sumB += d[b] ?? 0;
                }
                return sumB - sumA;
            });
            // 确保每个日期都包含所有模型 key（缺失补 0），否则单点数据不渲染
            const defaults = Object.fromEntries(sortedKeys.map(k => [k, 0]));
            const data = Object.entries(byDate)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([date, vals]) => ({ date: date.slice(5), ...defaults, ...vals }));
            return {
                chartData: data,
                keys: sortedKeys,
                colors: MODEL_COLORS,
                labels: resolvedModelGroupLabels,
            };
        }
        else {
            // 按操作类别分组
            const source = tokenUsage.dailyByOperation;
            const byDate = {};
            for (const row of source) {
                const cat = getOperationCategory(row.operation);
                if (!byDate[row.date])
                    byDate[row.date] = {};
                const val = metric === 'tokens'
                    ? (row.input_tokens + row.output_tokens + row.thinking_tokens)
                    : row.estimated_cost;
                byDate[row.date][cat] = (byDate[row.date][cat] ?? 0) + val;
            }
            // 确保每个日期都包含所有类别 key（缺失补 0）
            const totalByCat = {};
            for (const d of Object.values(byDate)) {
                for (const [k, v] of Object.entries(d))
                    totalByCat[k] = (totalByCat[k] ?? 0) + v;
            }
            const sortedCatKeys = CATEGORY_ORDER.filter(c => (totalByCat[c] ?? 0) > 0)
                .sort((a, b) => (totalByCat[b] ?? 0) - (totalByCat[a] ?? 0));
            const catDefaults = Object.fromEntries(sortedCatKeys.map(k => [k, 0]));
            const data = Object.entries(byDate)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([date, vals]) => ({ date: date.slice(5), ...catDefaults, ...vals }));
            return {
                chartData: data,
                keys: sortedCatKeys,
                colors: CATEGORY_COLORS,
                labels: EVENT_TYPE_LABELS,
            };
        }
    }, [tokenUsage, metric, dimension, t]);
    const tooltipStyle = {
        backgroundColor: chartVar.tooltipBg,
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        fontSize: '11px',
        color: chartVar.tooltipText,
    };
    return (_jsx(Section, { title: t('usage.trendTitle'), children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("div", { className: "flex items-center gap-2", children: _jsx(ToggleGroup, { options: [{ value: 'model', label: t('usage.byModel') }, { value: 'category', label: t('usage.byCategory') }], value: dimension, onChange: (v) => setDimension(v) }) }), _jsx("div", { className: "flex items-center gap-2", children: _jsx(ToggleGroup, { options: [{ value: 'tokens', label: t('usage.token') }, { value: 'cost', label: t('usage.cost') }], value: metric, onChange: (v) => setMetric(v) }) })] }), chartData.length > 0 ? (_jsx("div", { className: "h-48", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(AreaChart, { data: chartData, margin: { top: 4, right: 4, bottom: 0, left: -20 }, children: [_jsx("defs", { children: keys.map(key => (_jsxs("linearGradient", { id: `grad-${key}`, x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "5%", stopColor: colors[key] ?? semantic.gray, stopOpacity: 0.6 }), _jsx("stop", { offset: "95%", stopColor: colors[key] ?? semantic.gray, stopOpacity: 0.25 })] }, key))) }), _jsx(XAxis, { dataKey: "date", tick: { fontSize: 9, fill: chartVar.tick }, axisLine: false, tickLine: false, interval: "preserveStartEnd" }), _jsx(YAxis, { tick: { fontSize: 9, fill: chartVar.tick }, axisLine: false, tickLine: false, tickFormatter: metric === 'tokens' ? formatTokenCount : (v) => formatCost(v) }), _jsx(Tooltip, { contentStyle: tooltipStyle, formatter: (v) => metric === 'tokens' ? formatTokenCount(v) : formatCost(v), labelFormatter: (label) => `${t('usage.tooltipDate')}: ${label}` }), _jsx(Legend, { wrapperStyle: { fontSize: '10px', color: chartVar.tick }, iconSize: 8, formatter: (value) => labels[value] ?? value }), keys.map(key => (_jsx(Area, { type: "monotone", dataKey: key, name: key, stackId: "1", stroke: colors[key] ?? semantic.gray, fill: `url(#grad-${key})`, strokeWidth: 1.5 }, key)))] }) }) })) : (_jsx("p", { className: "text-xs text-gray-500 py-8 text-center", children: t('usage.noData') }))] }) }));
}
// ============================================================
// 3. 操作统计
// ============================================================
function OperationStats({ data, range, onRangeChange }) {
    const { t } = useTranslation('settings');
    const [expanded, setExpanded] = useState(new Set());
    // 按5大类别分组
    const grouped = useMemo(() => {
        if (!data)
            return [];
        const map = {};
        for (const cat of CATEGORY_ORDER) {
            map[cat] = { cnt: 0, cost: 0, operations: [] };
        }
        for (const row of data.operationStats) {
            const cat = getOperationCategory(row.operation);
            if (!map[cat])
                map[cat] = { cnt: 0, cost: 0, operations: [] };
            map[cat].cnt += row.cnt;
            map[cat].cost += row.estimated_cost;
            map[cat].operations.push({
                operation: row.operation,
                cnt: row.cnt,
                cost: row.estimated_cost,
            });
        }
        return CATEGORY_ORDER
            .filter(cat => map[cat].cnt > 0)
            .map(cat => ({
            category: cat,
            label: EVENT_TYPE_LABELS[cat],
            ...map[cat],
        }));
    }, [data]);
    const toggle = (cat) => {
        setExpanded(prev => {
            const next = new Set(prev);
            next.has(cat) ? next.delete(cat) : next.add(cat);
            return next;
        });
    };
    return (_jsx(Section, { title: t('usage.operationStats'), children: _jsxs("div", { className: "space-y-3", children: [_jsx(RangeSelector, { value: range, onChange: onRangeChange }), grouped.length > 0 ? (_jsxs("div", { className: "space-y-1", children: [_jsxs("div", { className: "flex items-center gap-4 px-2 py-1.5 text-[11px] text-gray-500 font-medium border-b border-white/5", children: [_jsx("span", { className: "flex-1", children: t('usage.opsCategory') }), _jsx("span", { className: "w-16 text-right", children: t('usage.opsCount') }), _jsx("span", { className: "w-20 text-right", children: t('usage.opsEstimatedCost') })] }), grouped.map(group => {
                            const isExpanded = expanded.has(group.category);
                            return (_jsxs("div", { children: [_jsxs("button", { onClick: () => toggle(group.category), className: "flex items-center gap-4 px-2 py-2 w-full hover:bg-white/[0.03] rounded transition-colors", children: [_jsxs("span", { className: "flex items-center gap-1.5 flex-1 text-left", children: [isExpanded ? _jsx(ChevronDown, { size: 12, className: "text-gray-500" }) : _jsx(ChevronRight, { size: 12, className: "text-gray-500" }), _jsx("span", { className: "text-xs font-medium text-gray-300", children: group.label })] }), _jsx("span", { className: "w-16 text-xs text-gray-300 text-right tabular-nums font-mono", children: group.cnt }), _jsx("span", { className: "w-20 text-xs text-gray-300 text-right tabular-nums font-mono", children: formatCost(group.cost) })] }), isExpanded && group.operations.length > 0 && (_jsx("div", { className: "ml-6 border-l border-white/5 pl-3 mb-1", children: group.operations.map(op => (_jsxs("div", { className: "flex items-center gap-4 px-2 py-1.5", children: [_jsx("span", { className: "flex-1 text-[11px] text-gray-400", children: OPERATION_LABELS[op.operation] ?? op.operation }), _jsx("span", { className: "w-16 text-[11px] text-gray-400 text-right tabular-nums font-mono", children: op.cnt }), _jsx("span", { className: "w-20 text-[11px] text-gray-400 text-right tabular-nums font-mono", children: formatCost(op.cost) })] }, op.operation))) }))] }, group.category));
                        })] })) : (_jsx("p", { className: "text-xs text-gray-500 py-4 text-center", children: t('usage.noOpsData') }))] }) }));
}
// ============================================================
// 4. 明细表
// ============================================================
function DetailTable({ data, range, onRangeChange, page, onPageChange, pageSize }) {
    const { t } = useTranslation('settings');
    const { formatShortDate } = useFormatters();
    const totalLogs = data?.totalLogs ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalLogs / pageSize));
    // 动态解析 other 标签
    const resolvedModelGroupLabels = {
        ...MODEL_GROUP_LABELS,
        other: t('usage.otherModel'),
    };
    if (!data || totalLogs === 0)
        return null;
    return (_jsx(Section, { title: t('usage.detailTitle'), children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(RangeSelector, { value: range, onChange: onRangeChange }), _jsx("span", { className: "text-[11px] text-gray-500", children: t('usage.totalRecords', { count: totalLogs }) })] }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-[11px]", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-gray-500 border-b border-white/5", children: [_jsx("th", { className: "text-left py-1.5 px-2 font-medium", children: t('usage.colTime') }), _jsx("th", { className: "text-left py-1.5 px-2 font-medium", children: t('usage.colOperation') }), _jsx("th", { className: "text-left py-1.5 px-2 font-medium", children: t('usage.colModel') }), _jsx("th", { className: "text-right py-1.5 px-2 font-medium", children: t('usage.colTotalTokens') }), _jsx("th", { className: "text-right py-1.5 px-2 font-medium", children: t('usage.colEstimatedCost') })] }) }), _jsx("tbody", { children: data.recentLogs.map((log) => {
                                    const cat = getOperationCategory(log.operation);
                                    const totalTk = log.input_tokens + log.output_tokens + log.thinking_tokens;
                                    return (_jsxs("tr", { className: "border-b border-white/[0.03] hover:bg-white/[0.02]", children: [_jsx("td", { className: "py-1.5 px-2 text-gray-400 font-mono whitespace-nowrap", children: formatShortDate(log.created) }), _jsx("td", { className: "py-1.5 px-2", children: _jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-[10px] text-gray-400", children: EVENT_TYPE_LABELS[cat] }), _jsx("span", { className: "text-gray-500", children: "\u00B7" }), _jsx("span", { className: "text-gray-300 text-[11px]", children: OPERATION_LABELS[log.operation] ?? log.operation ?? '-' })] }) }), _jsx("td", { className: "py-1.5 px-2 text-gray-300 truncate max-w-[120px]", children: resolvedModelGroupLabels[getModelGroup(log.model)] ?? log.model }), _jsx("td", { className: "py-1.5 px-2 text-right text-gray-300 font-mono tabular-nums", children: formatTokenCount(totalTk) }), _jsx("td", { className: "py-1.5 px-2 text-right text-gray-300 font-mono tabular-nums", children: formatCost(log.estimated_cost) })] }, log.id));
                                }) })] }) }), totalPages > 1 && (_jsxs("div", { className: "flex items-center justify-center gap-3 pt-1", children: [_jsx("button", { disabled: page === 0, onClick: () => onPageChange(page - 1), className: "p-1 rounded hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors", children: _jsx(ChevronLeft, { size: 14, className: "text-gray-400" }) }), _jsxs("span", { className: "text-[11px] text-gray-400 tabular-nums font-mono", children: [page + 1, " / ", totalPages] }), _jsx("button", { disabled: page >= totalPages - 1, onClick: () => onPageChange(page + 1), className: "p-1 rounded hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors", children: _jsx(ChevronRight, { size: 14, className: "text-gray-400" }) })] }))] }) }));
}
// ============================================================
// 共用组件
// ============================================================
function RangeSelector({ value, onChange }) {
    const { t } = useTranslation('settings');
    const options = [
        { value: '7d', label: t('usage.range7d') },
        { value: '30d', label: t('usage.range30d') },
        { value: 'all', label: t('usage.rangeAll') },
    ];
    return (_jsx(ToggleGroup, { options: options, value: value, onChange: (v) => onChange(v) }));
}
function ToggleGroup({ options, value, onChange }) {
    return (_jsx("div", { className: "flex items-center gap-1", children: options.map(opt => (_jsx("button", { onClick: () => onChange(opt.value), className: `px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-150 ${value === opt.value ? 'text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'}`, style: value === opt.value ? { background: 'var(--selected-bg)' } : {}, children: opt.label }, opt.value))) }));
}
