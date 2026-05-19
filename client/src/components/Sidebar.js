import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Brain, Clock, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logoSrc from '../assets/logo.png';
import { getProFeatures } from '../feature-registry';
import { CloudStatus } from './sidebar/CloudStatus';
import { LLMHealthBadge } from './sidebar/LLMHealthBadge';
const coreNavKeys = [
    { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
    { to: '/knowledge', icon: Brain, labelKey: 'nav.explorer' },
    { to: '/timeline', icon: Clock, labelKey: 'nav.timeline' },
    { to: '/settings', icon: Settings, labelKey: 'nav.settings' },
];
function useAppVersion() {
    const [version, setVersion] = useState('');
    useEffect(() => {
        window.api.app.getVersion().then(setVersion).catch(() => { });
    }, []);
    return version;
}
export function Sidebar() {
    const { t } = useTranslation();
    const appVersion = useAppVersion();
    return (_jsxs("aside", { className: "glass-sidebar w-56 flex-shrink-0 flex flex-col", style: {
            borderRight: '1px solid var(--border-faint)',
        }, children: [_jsx("div", { className: "drag-region px-4", style: { paddingTop: 38 }, children: _jsxs("div", { className: "flex items-center gap-2 pb-2.5", children: [_jsx("img", { src: logoSrc, alt: "Tide Mind", className: "w-7 h-7 rounded-md flex-shrink-0" }), _jsx("h1", { className: "text-[15px] font-semibold tracking-wide", style: { color: 'var(--fg-primary)' }, children: "Tide Mind" })] }) }), _jsx("nav", { className: "flex-1 mt-3 px-2.5 space-y-0.5", children: [...coreNavKeys.map(n => ({ ...n, label: t(n.labelKey) })), ...(getProFeatures()?.sidebarItems ?? [])].map(item => (_jsx(NavLink, { to: item.to, end: item.to === '/', className: ({ isActive }) => `no-drag relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${isActive
                        ? 'text-white'
                        : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'}`, style: ({ isActive }) => isActive ? {
                        background: 'var(--active-bg)',
                        boxShadow: 'var(--active-shadow)',
                    } : {}, children: ({ isActive }) => (_jsxs(_Fragment, { children: [isActive && (_jsx("span", { className: "nav-active-indicator", style: { color: 'var(--indicator)' } })), _jsx(item.icon, { size: 16, style: { color: isActive ? 'var(--fg-primary)' : 'var(--fg-tertiary)' } }), item.label] })) }, item.to))) }), _jsx("div", { className: "mx-3 mb-2", style: {
                    height: '1px',
                    background: 'linear-gradient(90deg, transparent, var(--border-faint) 30%, var(--border-faint) 70%, transparent)',
                } }), _jsx(LLMHealthBadge, {}), _jsx(CloudStatus, {}), appVersion && (_jsxs("div", { className: "px-4 py-3 text-[10px]", style: { color: 'var(--fg-muted)' }, children: ["v", appVersion] }))] }));
}
