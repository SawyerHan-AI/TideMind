import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Sparkles, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useIPC } from '../../hooks/useIPC';
import { useDataRevision } from '../../contexts/DataChangeContext';
import { useFormatters } from '../../hooks/useFormatters';
import { resolveEventTitle } from '../../lib/timeline-utils';
const fadeUp = {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
};
function FeedbackButtons({ event }) {
    const { t } = useTranslation('dashboard');
    const [submitted, setSubmitted] = useState(null);
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const handleFeedback = async (signal) => {
        try {
            await window.api.write.submitFeedback(event.subtype, signal);
            if (mountedRef.current)
                setSubmitted(signal);
        }
        catch {
            // silently fail
        }
    };
    if (submitted !== null) {
        return (_jsx("span", { className: "text-[10px] text-gray-500", children: submitted > 0 ? t('discoveries.liked') : t('discoveries.disliked') }));
    }
    return (_jsxs("span", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => handleFeedback(1), className: "p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-emerald-400 transition-colors", children: _jsx(ThumbsUp, { size: 12 }) }), _jsx("button", { onClick: () => handleFeedback(-1), className: "p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-red-400 transition-colors", children: _jsx(ThumbsDown, { size: 12 }) })] }));
}
export function Discoveries() {
    const { t } = useTranslation('dashboard');
    const { timeAgo } = useFormatters();
    const rev = useDataRevision(['timeline']);
    const { data } = useIPC(() => window.api.timeline.list({ types: ['think_emerge', 'evolution'], limit: 5 }), [rev]);
    const events = data?.events ?? [];
    return (_jsxs(motion.div, { variants: fadeUp, className: "glass-card rounded-xl p-4 h-full", children: [_jsx("h3", { className: "text-sm font-medium mb-3", style: { color: 'var(--fg-secondary)' }, children: t('discoveries.title') }), events.length === 0 ? (_jsxs("div", { className: "flex flex-col items-center justify-center py-8 text-gray-600", children: [_jsx(Sparkles, { size: 24, className: "mb-2 opacity-40" }), _jsx("p", { className: "text-sm", children: t('discoveries.brewing') })] })) : (_jsx("div", { className: "space-y-2 max-h-64 overflow-auto", children: events.map((event) => (_jsxs("div", { className: "flex items-start gap-2 text-xs py-1.5", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-gray-300 truncate", children: resolveEventTitle(event.title, t) }), _jsx("p", { className: "text-gray-500 text-[10px] mt-0.5", children: timeAgo(event.created) })] }), _jsx(FeedbackButtons, { event: event })] }, `${event.source}-${event.id}`))) }))] }));
}
