import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { semantic } from '../../../lib/tokens';
// ============================================================
// WeightVisualization
// ============================================================
export function WeightVisualization({ getVal }) {
    const { t } = useTranslation('settings');
    const weights = [
        { label: 'BM25 (\u03b1)', value: getVal('search', 'alpha', 0.3), color: semantic.blue },
        { label: t('strategy.nodes.searchWeights.beta'), value: getVal('search', 'beta', 0.5), color: semantic.purple },
        { label: t('strategy.nodes.searchWeights.gamma'), value: getVal('search', 'gamma', 0.1), color: semantic.amber },
        { label: t('strategy.nodes.searchWeights.delta'), value: getVal('search', 'delta', 0.1), color: semantic.teal },
    ];
    const total = weights.reduce((s, w) => s + w.value, 0);
    return (_jsxs("div", { className: "mb-3", children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx("span", { className: "text-xs text-gray-400", children: t('strategy.weightDistribution') }), _jsxs("span", { className: "text-[10px] text-gray-500", children: ["(", t('strategy.weightTotal', { total: total.toFixed(2) }), ")"] })] }), _jsx("div", { className: "flex h-6 rounded-lg overflow-hidden border border-white/5", children: weights.map(w => (_jsx("div", { style: {
                        width: total > 0 ? `${(w.value / total) * 100}%` : '25%',
                        backgroundColor: w.color,
                        minWidth: w.value > 0 ? '2px' : 0,
                    }, className: "transition-all duration-300 flex items-center justify-center", children: w.value / total > 0.15 && (_jsx("span", { className: "text-[9px] text-white font-medium truncate px-1", children: w.label })) }, w.label))) }), _jsx("div", { className: "flex gap-3 mt-2", children: weights.map(w => (_jsxs("div", { className: "flex items-center gap-1", children: [_jsx("div", { className: "w-2 h-2 rounded-full", style: { backgroundColor: w.color } }), _jsx("span", { className: "text-[10px] text-gray-500", children: w.label })] }, w.label))) })] }));
}
