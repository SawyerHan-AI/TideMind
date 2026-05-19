import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { EVENT_TYPE_COLORS, EVENT_TYPE_LABELS, ACTOR_LABELS, ACTOR_COLORS } from '../../lib/constants';
const EVENT_TYPES = ['memory', 'think_associate', 'think_emerge', 'output', 'evolution', 'config'];
const ACTORS = ['user', 'agent', 'brain'];
function TogglePill({ isActive, activeClass, onClick, children, }) {
    return (_jsx("button", { onClick: onClick, className: `px-2 py-1 rounded-md text-[11px] font-medium transition-all duration-150 ${isActive
            ? `${activeClass}`
            : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.05]'}`, children: children }));
}
export function TimelineFilters({ activeTypes, onToggleType, activeActors, onToggleActor, }) {
    return (_jsxs("div", { className: "flex items-center gap-1", children: [EVENT_TYPES.map(type => (_jsx(TogglePill, { isActive: activeTypes.includes(type), activeClass: EVENT_TYPE_COLORS[type], onClick: () => onToggleType(type), children: EVENT_TYPE_LABELS[type] }, type))), _jsx("div", { className: "w-px h-4 mx-1.5", style: { background: 'var(--border-subtle)' } }), ACTORS.map(actor => (_jsx(TogglePill, { isActive: activeActors.includes(actor), activeClass: ACTOR_COLORS[actor], onClick: () => onToggleActor(actor), children: ACTOR_LABELS[actor] }, actor)))] }));
}
