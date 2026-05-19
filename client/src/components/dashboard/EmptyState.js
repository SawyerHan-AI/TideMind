import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import logoSrc from '../../assets/logo@2x.png';
/**
 * Dashboard 空状态
 *
 * 当记忆总量为 0 时显示，替代 SystemPulse / RecentActivity / Discoveries / RecentTags。
 */
export function EmptyState() {
    const { t } = useTranslation('dashboard');
    const navigate = useNavigate();
    return (_jsxs("div", { className: "flex flex-col items-center justify-center text-center py-20", children: [_jsx("img", { src: logoSrc, alt: "Tide Mind", className: "w-16 h-16 rounded-2xl mb-6 opacity-70" }), _jsx("h2", { className: "text-lg font-medium text-white mb-2", children: t('empty.title') }), _jsx("p", { className: "text-sm text-gray-500 max-w-sm mb-8 leading-relaxed", children: t('empty.description') }), _jsx("div", { className: "flex items-center gap-3", children: _jsxs("button", { onClick: () => navigate('/settings'), className: "flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 rounded-xl border border-white/10 hover:border-white/20 hover:text-white transition-all", style: { background: 'var(--theme-glass-bg)' }, children: [_jsx(Settings, { size: 14 }), t('empty.settings')] }) })] }));
}
