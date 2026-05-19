import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { CircleDashed } from 'lucide-react';
import { truncate } from '../../lib/format';
import { useFormatters } from '../../hooks/useFormatters';
import { EVENT_TYPE_COLORS, EVENT_TYPE_LABELS, EVENT_SUBTYPE_LABELS } from '../../lib/constants';
import { resolveEventTitle } from '../../lib/timeline-utils';
const fadeUp = {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
};
export function RecentActivity({ activity, onNodeClick }) {
    const { t } = useTranslation('dashboard');
    const { timeAgo } = useFormatters();
    return (_jsxs(motion.div, { variants: fadeUp, className: "glass-card rounded-xl p-4 h-full", children: [_jsx("h3", { className: "text-sm font-medium mb-3", style: { color: 'var(--fg-secondary)' }, children: t('recentActivity.title') }), activity.length === 0 ? (_jsxs("div", { className: "flex flex-col items-center justify-center py-8 text-gray-500", children: [_jsx(CircleDashed, { size: 24, className: "mb-2 opacity-40" }), _jsx("p", { className: "text-sm", children: t('recentActivity.brainNotStarted') })] })) : (_jsx("div", { className: "space-y-1 max-h-64 overflow-auto", children: activity.map((event) => {
                    const nodeIds = event.node_ids ? (() => { try {
                        return JSON.parse(event.node_ids);
                    }
                    catch {
                        return [];
                    } })() : [];
                    const firstNodeId = nodeIds[0];
                    const colorClass = EVENT_TYPE_COLORS[event.type] ?? 'bg-gray-500/20 text-gray-400';
                    const typeLabel = EVENT_TYPE_LABELS[event.type] ?? event.type;
                    const subtypeLabel = EVENT_SUBTYPE_LABELS[event.subtype] ?? event.subtype;
                    return (_jsxs("button", { onClick: () => firstNodeId && onNodeClick(firstNodeId), disabled: !firstNodeId, className: "w-full flex items-center gap-3 text-xs py-2 px-2 rounded-lg hover:bg-white/[0.06] transition-all duration-150 text-left disabled:opacity-40 disabled:cursor-default", children: [_jsx("span", { className: "text-gray-500 tabular-nums w-16 flex-shrink-0", children: timeAgo(event.created) }), _jsx("span", { className: `px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${colorClass}`, children: subtypeLabel || typeLabel }), _jsx("span", { className: "text-gray-300 truncate", children: truncate(resolveEventTitle(event.title, t), 60) })] }, `${event.type}-${event.id}-${event.created}`));
                }) }))] }));
}
