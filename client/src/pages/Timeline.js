import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useIPC } from '../hooks/useIPC';
import { useDataRevision } from '../contexts/DataChangeContext';
import { TimelineFilters } from '../components/timeline/TimelineFilters';
import { TimelineItem } from '../components/timeline/TimelineItem';
import { Skeleton } from '../components/Skeleton';
const ALL_TYPES = ['memory', 'think_associate', 'think_emerge', 'output', 'evolution', 'config'];
const ALL_ACTORS = ['user', 'agent', 'brain'];
const PAGE_SIZE = 30;
export function Timeline() {
    const { t } = useTranslation('timeline');
    const navigate = useNavigate();
    const [activeTypes, setActiveTypes] = useState([...ALL_TYPES]);
    const [activeActors, setActiveActors] = useState([...ALL_ACTORS]);
    const [page, setPage] = useState(0);
    const [expandedId, setExpandedId] = useState(null);
    const toggleType = useCallback((type) => {
        setActiveTypes(prev => {
            const next = prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type];
            return next.length > 0 ? next : prev;
        });
        setPage(0);
    }, []);
    const toggleActor = useCallback((actor) => {
        setActiveActors(prev => {
            const next = prev.includes(actor) ? prev.filter(a => a !== actor) : [...prev, actor];
            return next.length > 0 ? next : prev;
        });
        setPage(0);
    }, []);
    const rev = useDataRevision(['timeline']);
    const { data, loading } = useIPC(() => window.api.timeline.list({
        types: activeTypes.length < ALL_TYPES.length ? activeTypes : undefined,
        actors: activeActors.length < ALL_ACTORS.length ? activeActors : undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
    }), [activeTypes, activeActors, page, rev]);
    const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);
    const handleNodeClick = useCallback((id) => navigate(`/knowledge?node=${id}`), [navigate]);
    const total = data?.total ?? 0;
    return (_jsxs("div", { className: "flex flex-col h-full", children: [_jsx("div", { className: "flex-shrink-0 px-4 pt-9 pb-3 border-b border-white/5", children: _jsx(TimelineFilters, { activeTypes: activeTypes, onToggleType: toggleType, activeActors: activeActors, onToggleActor: toggleActor }) }), _jsx("div", { className: "flex-1 overflow-y-auto px-6", children: loading ? (_jsx("div", { className: "space-y-3 pl-8", children: Array.from({ length: 8 }).map((_, i) => (_jsxs("div", { className: "flex items-center gap-3 py-2.5 px-3", children: [_jsx(Skeleton, { className: "h-4 w-24" }), _jsx(Skeleton, { className: "h-5 w-16" }), _jsx(Skeleton, { className: "h-4 w-48" })] }, i))) })) : data?.events.length === 0 ? (_jsx("div", { className: "text-center py-16 text-gray-500 text-sm", children: t('noEvents') })) : (_jsxs("div", { className: "relative", children: [_jsx("div", { className: "absolute left-[11px] top-0 bottom-0 w-px bg-white/10" }), _jsx("div", { className: "space-y-0.5", children: data?.events.map((event, index) => {
                                const uniqueId = `${event.source}-${event.id}`;
                                return (_jsx(motion.div, { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { delay: index * 0.03, duration: 0.25 }, children: _jsx(TimelineItem, { event: event, isExpanded: expandedId === uniqueId, onToggle: () => setExpandedId(prev => (prev === uniqueId ? null : uniqueId)), onNodeClick: handleNodeClick }) }, uniqueId));
                            }) })] })) }), _jsxs("div", { className: "flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-white/5", children: [_jsx("span", { className: "text-[11px] text-gray-500", children: t('total', { count: total }) }), totalPages > 1 ? (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("button", { onClick: () => { setPage(p => Math.max(0, p - 1)); setExpandedId(null); }, disabled: page === 0, className: "p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 transition-all", children: _jsx(ChevronLeft, { size: 14 }) }), _jsxs("span", { className: "text-[11px] text-gray-400 tabular-nums", children: [page + 1, " / ", totalPages] }), _jsx("button", { onClick: () => { setPage(p => Math.min(totalPages - 1, p + 1)); setExpandedId(null); }, disabled: page >= totalPages - 1, className: "p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 transition-all", children: _jsx(ChevronRight, { size: 14 }) })] })) : (_jsx("span", {}))] })] }));
}
