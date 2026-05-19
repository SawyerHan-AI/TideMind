import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ModelConnection } from './ModelConnection';
import { ModelSelection } from './ModelSelection';
import { ModelUsage } from './ModelUsage';
import { LLMHealthCard } from './LLMHealthCard';
const SUB_TAB_KEYS = ['connection', 'selection', 'usage'];
function parseSubTab(value) {
    return value && SUB_TAB_KEYS.includes(value) ? value : null;
}
export function ModelConfig({ initialSub } = {}) {
    const { t } = useTranslation('settings');
    const [subTab, setSubTab] = useState(() => parseSubTab(initialSub) ?? 'connection');
    useEffect(() => {
        setSubTab(parseSubTab(initialSub) ?? 'connection');
    }, [initialSub]);
    const SUB_TABS = [
        { key: 'connection', label: t('model.subtabs.connection') },
        { key: 'selection', label: t('model.subtabs.selection') },
        { key: 'usage', label: t('model.subtabs.usage') },
    ];
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "flex items-center gap-2", children: SUB_TABS.map(tab => (_jsx("button", { onClick: () => setSubTab(tab.key), className: `px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${subTab === tab.key ? 'text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'}`, style: subTab === tab.key ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}, children: tab.label }, tab.key))) }), _jsxs(motion.div, { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 }, children: [subTab === 'connection' && (_jsxs("div", { className: "space-y-6 max-w-2xl", children: [_jsx(LLMHealthCard, {}), _jsx(ModelConnection, {})] })), subTab === 'selection' && _jsx(ModelSelection, {}), subTab === 'usage' && _jsx(ModelUsage, {})] }, subTab)] }));
}
