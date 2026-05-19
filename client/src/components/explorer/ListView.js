import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TypeBadge } from '../TypeBadge';
import { Skeleton } from '../Skeleton';
import { truncate } from '../../lib/format';
import { useFormatters } from '../../hooks/useFormatters';
import { DERIVED_CATEGORY_COLORS } from '../../lib/constants';
import { deriveCategory } from '../../lib/dimensions';
import { brand, semantic } from '../../lib/tokens';
export function ListView({ nodes, total, page, onPageChange, selectedId, onSelect, loading }) {
    const { t } = useTranslation('explorer');
    const { timeAgo } = useFormatters();
    const limit = 30;
    const totalPages = Math.ceil(total / limit);
    if (loading) {
        return (_jsx("div", { className: "divide-y divide-white/5", children: Array.from({ length: 8 }).map((_, i) => (_jsxs("div", { className: "flex items-center gap-3 px-4 py-3", children: [_jsx(Skeleton, { className: "h-4 w-1 rounded-full" }), _jsx(Skeleton, { className: "h-5 w-12" }), _jsx(Skeleton, { className: "h-4 flex-1" }), _jsx(Skeleton, { className: "h-3 w-12" }), _jsx(Skeleton, { className: "h-1.5 w-5" }), _jsx(Skeleton, { className: "h-3 w-16" })] }, i))) }));
    }
    if (nodes.length === 0) {
        return (_jsx("div", { className: "flex flex-col items-center justify-center py-20 text-gray-500", children: _jsx("p", { className: "text-sm", children: t('list.noResults') }) }));
    }
    return (_jsxs("div", { className: "flex flex-col h-full", children: [_jsx("div", { className: "flex-1 overflow-y-auto", children: nodes.map((node, i) => {
                    const isSelected = node.id === selectedId;
                    const isCrystal = !!node.is_crystal;
                    const category = deriveCategory(node.specificity ?? 0.5, node.subjectivity ?? 0.5, node.actuality ?? 0.5);
                    const typeColor = DERIVED_CATEGORY_COLORS[category] ?? semantic.gray;
                    // Heat bar: normalized to 0-1 (3+ is very hot)
                    const heatNorm = Math.min(node.heat / 3, 1);
                    const heatHue = 220 - heatNorm * 180;
                    const heatSat = 30 + heatNorm * 50;
                    const heatLight = 40 + heatNorm * 15;
                    return (_jsxs(motion.button, { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay: i * 0.02 }, onClick: () => onSelect(node.id), className: `w-full flex items-center gap-3 text-left transition-colors border-l-2 border-b border-b-white/5 ${isCrystal ? 'py-3.5 px-4' : 'py-2.5 px-4'} ${isSelected
                            ? 'bg-white/[0.08]'
                            : 'hover:bg-white/[0.04]'}`, style: { borderLeftColor: isSelected ? brand.primary : 'transparent', boxShadow: isSelected ? `inset 2px 0 8px ${brand.primary}20` : 'none' }, children: [_jsx(TypeBadge, { specificity: node.specificity, subjectivity: node.subjectivity, actuality: node.actuality, refinement: node.refinement, is_crystal: node.is_crystal, is_keystone: node.is_keystone, is_tag: node.is_tag, is_meta: node.is_meta }), _jsx("span", { className: `flex-1 text-sm truncate min-w-0 ${isCrystal ? 'text-gray-100 font-medium' : 'text-gray-300'}`, children: node.title?.trim() || truncate(node.content, 80) }), _jsx("div", { className: "flex-shrink-0 w-5 h-1.5 rounded-full bg-white/10 overflow-hidden", title: t('heat.nodeHeat', { value: node.heat.toFixed(1) }), children: _jsx("div", { className: "h-full rounded-full", style: {
                                        width: `${heatNorm * 100}%`,
                                        backgroundColor: `hsl(${heatHue}, ${heatSat}%, ${heatLight}%)`,
                                    } }) }), _jsx("span", { className: "flex-shrink-0 text-[11px] text-gray-500 tabular-nums w-16 text-right", children: timeAgo(node.created) })] }, node.id));
                }) }), _jsxs("div", { className: "flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-white/5", children: [_jsx("span", { className: "text-[11px] text-gray-500", children: t('list.total', { count: total }) }), totalPages > 1 ? (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("button", { onClick: () => onPageChange(Math.max(0, page - 1)), disabled: page === 0, className: "p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 transition-all", children: _jsx(ChevronLeft, { size: 14 }) }), _jsxs("span", { className: "text-[11px] text-gray-400 tabular-nums", children: [page + 1, " / ", totalPages] }), _jsx("button", { onClick: () => onPageChange(Math.min(totalPages - 1, page + 1)), disabled: page >= totalPages - 1, className: "p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 transition-all", children: _jsx(ChevronRight, { size: 14 }) })] })) : (_jsx("span", {}))] })] }));
}
