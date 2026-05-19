import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { List, Network, Flame } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SearchInput } from '../SearchInput';
import { DERIVED_CATEGORY_LABELS } from '../../lib/constants';
import { useIPC } from '../../hooks/useIPC';
const NODE_TYPES = ['record', 'knowledge', 'belief', 'hypothesis', 'intention'];
const SORT_OPTION_KEYS = [
    { value: 'created', labelKey: 'sort.newest' },
    { value: 'heat', labelKey: 'sort.hottest' },
    { value: 'maturity_score', labelKey: 'sort.maturity' },
    { value: 'connectivity', labelKey: 'sort.connectivity' },
];
const selectClass = 'bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-[7px] text-xs text-gray-300 focus:outline-none focus:border-indigo-400/40 transition-colors appearance-none cursor-pointer hover:bg-white/[0.07]';
export function FilterBar({ filter, onFilterChange, viewMode, onViewModeChange }) {
    const { t } = useTranslation('explorer');
    const { data: allTags } = useIPC(() => window.api.nodes.tags());
    const coreTags = (allTags ?? []).filter(item => item.isCore);
    return (_jsxs("div", { className: "space-y-2.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "flex-1 min-w-0", children: _jsx(SearchInput, { value: filter.search ?? '', onChange: v => onFilterChange({ search: v }), placeholder: t('filter.searchPlaceholder') }) }), _jsxs("div", { className: "flex items-center gap-0.5 bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]", children: [_jsxs("button", { onClick: () => onViewModeChange('list'), className: `flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${viewMode === 'list' ? 'bg-white/[0.1] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`, children: [_jsx(List, { size: 14 }), t('view.list')] }), _jsxs("button", { onClick: () => onViewModeChange('graph'), className: `flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${viewMode === 'graph' ? 'bg-white/[0.1] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`, children: [_jsx(Network, { size: 14 }), t('view.graph')] })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("select", { value: filter.type ?? '', onChange: e => onFilterChange({ type: e.target.value || null }), className: selectClass, children: [_jsx("option", { value: "", children: t('filter.allTypes') }), NODE_TYPES.map(nt => (_jsx("option", { value: nt, children: DERIVED_CATEGORY_LABELS[nt] }, nt)))] }), coreTags.length > 0 && (_jsxs("select", { value: filter.tags ?? '', onChange: e => onFilterChange({ tags: e.target.value || undefined }), className: `${selectClass} max-w-[180px]`, children: [_jsx("option", { value: "", children: t('filter.allTags') }), coreTags.map(item => _jsxs("option", { value: item.tag, children: [item.tag, " (", item.count, ")"] }, item.tag))] })), _jsx("select", { value: filter.sortBy ?? 'created', onChange: e => onFilterChange({ sortBy: e.target.value }), className: selectClass, children: SORT_OPTION_KEYS.map(opt => (_jsx("option", { value: opt.value, children: t(opt.labelKey) }, opt.value))) }), _jsx("div", { className: "flex-1" }), _jsxs("div", { className: "flex items-center gap-1.5 text-xs text-gray-500", children: [_jsx(Flame, { size: 12, className: filter.heatMin && filter.heatMin > 0.05 ? 'text-indigo-400' : '' }), _jsx("input", { type: "range", min: "0", max: "1", step: "0.05", value: filter.heatMin ?? 0.05, onChange: e => onFilterChange({ heatMin: parseFloat(e.target.value) }), className: "w-20 h-1 bg-white/10 rounded-full accent-indigo-400 cursor-pointer", title: t('heat.minLabel', { value: (filter.heatMin ?? 0.05).toFixed(2) }) }), _jsx("span", { className: "w-6 text-right tabular-nums text-gray-400", children: (filter.heatMin ?? 0.05).toFixed(2) })] })] })] }));
}
