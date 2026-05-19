import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Tag, Info } from 'lucide-react';
import { useFormatters } from '../../hooks/useFormatters';
const fadeUp = {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
};
export function RecentTags({ tags, onTagClick }) {
    const { t } = useTranslation('dashboard');
    const { timeAgo } = useFormatters();
    const coreTags = tags.filter(item => item.isCore);
    const [showTip, setShowTip] = useState(false);
    if (coreTags.length === 0)
        return null;
    return (_jsxs(motion.div, { variants: fadeUp, children: [_jsxs("div", { className: "flex items-center gap-1.5 mb-3", children: [_jsx("h3", { className: "text-sm font-medium", style: { color: 'var(--fg-secondary)' }, children: t('recentTags.title') }), _jsxs("div", { className: "relative", children: [_jsx(Info, { size: 12, className: "text-gray-500 cursor-help", onMouseEnter: () => setShowTip(true), onMouseLeave: () => setShowTip(false) }), showTip && (_jsx("div", { className: "absolute left-4 top-0 z-10 px-2.5 py-1.5 rounded-lg bg-gray-800 border border-white/10 text-[10px] text-gray-300 whitespace-nowrap shadow-lg", children: t('recentTags.coreOnly') }))] })] }), _jsx("div", { className: "grid grid-cols-2 gap-3", children: coreTags.map((item) => (_jsxs("button", { onClick: () => onTagClick(item.tag), className: "glass-card rounded-xl p-4 hover:bg-white/[0.07] transition-all duration-200 text-left w-full", children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(Tag, { size: 14, className: "text-gray-400" }), _jsx("span", { className: "text-sm font-medium text-white truncate", children: item.tag })] }), _jsxs("div", { className: "flex items-center gap-3 text-[11px] text-gray-500", children: [_jsx("span", { children: timeAgo(item.lastActivity) }), _jsx("span", { className: "text-gray-600", children: "|" }), _jsxs("span", { children: [item.count, " ", t('common:units.memories')] })] })] }, item.tag))) })] }));
}
