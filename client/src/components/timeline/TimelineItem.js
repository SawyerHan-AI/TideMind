import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EVENT_TYPE_COLORS, EVENT_SUBTYPE_LABELS, ACTOR_LABELS, ACTOR_COLORS } from '../../lib/constants';
import { useFormatters } from '../../hooks/useFormatters';
import { resolveEventTitle } from '../../lib/timeline-utils';
import { TimelineExpanded } from './TimelineExpanded';
import { brand } from '../../lib/tokens';
/** Dot fill color — all event types use brand primary. */
const DOT_COLORS = {
    memory: brand.primary,
    think_associate: brand.primary,
    think_emerge: brand.primary,
    output: brand.primary,
    evolution: brand.primary,
    config: brand.primary,
};
export function TimelineItem({ event, isExpanded, onToggle, onNodeClick, }) {
    const { t } = useTranslation();
    const { timeAgo, formatDate } = useFormatters();
    const dotColor = DOT_COLORS[event.type] ?? brand.primary;
    const isImportant = event.important === 1;
    return (_jsxs("div", { className: `relative pl-8 ${isImportant ? 'border-l-2 border-amber-400 ml-[10px]' : ''}`, children: [_jsx("div", { className: "absolute top-3 flex items-center justify-center", style: { left: isImportant ? '-8px' : '6px' }, children: _jsx("div", { className: `rounded-full ${isImportant ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'}`, style: { backgroundColor: dotColor } }) }), _jsxs("button", { onClick: onToggle, className: "w-full flex items-center gap-3 py-2.5 px-3 hover:bg-white/[0.05] rounded-lg transition-all duration-150 text-left group", children: [_jsx("span", { className: "text-xs text-gray-500 tabular-nums flex-shrink-0 w-24", title: formatDate(event.created), children: timeAgo(event.created) }), _jsx("span", { className: `flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-medium ${EVENT_TYPE_COLORS[event.type] ?? 'bg-gray-500/20 text-gray-400'}`, children: EVENT_SUBTYPE_LABELS[event.subtype] ?? event.subtype }), _jsx("span", { className: `flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] ${ACTOR_COLORS[event.actor] ?? 'bg-slate-500/20 text-slate-300'}`, children: ACTOR_LABELS[event.actor] ?? event.actor }), _jsx("span", { className: "flex-1 text-sm text-gray-200 truncate", children: resolveEventTitle(event.title, t) }), _jsx(motion.span, { animate: { rotate: isExpanded ? 90 : 0 }, transition: { duration: 0.15 }, className: "text-gray-600 group-hover:text-gray-300 flex-shrink-0 transition-colors", children: _jsx(ChevronRight, { size: 14 }) })] }), _jsx(AnimatePresence, { children: isExpanded && (_jsx(motion.div, { initial: { height: 0, opacity: 0 }, animate: { height: 'auto', opacity: 1 }, exit: { height: 0, opacity: 0 }, transition: { duration: 0.2 }, className: "overflow-hidden", children: _jsx("div", { className: "px-3 pb-3 ml-3 border-l border-white/[0.08]", children: _jsx(TimelineExpanded, { event: event, onNodeClick: onNodeClick }) }) })) })] }));
}
