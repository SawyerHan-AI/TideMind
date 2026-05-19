import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Palette, Plug, Cpu, Sliders, Database, Info, Cloud, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GeneralSettings } from '../components/settings/GeneralSettings';
import { ExternalIntegration } from '../components/settings/ExternalIntegration';
import { ModelConfig } from '../components/settings/ModelConfig';
import { InternalStrategy } from '../components/settings/InternalStrategy';
import { DataManagement } from '../components/settings/DataManagement';
import { AboutSection } from '../components/settings/AboutSection';
import { CloudSyncSettings } from '../components/settings/CloudSyncSettings';
import { AccountSettings } from '../components/settings/AccountSettings';
const TAB_ITEMS = [
    // 本地设置
    { id: 'general', labelKey: 'settings:tabs.general', icon: Palette },
    { id: 'external', labelKey: 'settings:tabs.external', icon: Plug },
    { id: 'model', labelKey: 'settings:tabs.model', icon: Cpu },
    { id: 'strategy', labelKey: 'settings:tabs.strategy', icon: Sliders },
    { id: 'data', labelKey: 'settings:tabs.data', icon: Database },
    // 账号 + 云
    { separator: true },
    { id: 'account', labelKey: 'settings:tabs.account', icon: User },
    { id: 'cloud', labelKey: 'settings:tabs.cloud', icon: Cloud },
    // 关于
    { separator: true },
    { id: 'about', labelKey: 'settings:tabs.about', icon: Info },
];
const TABS = TAB_ITEMS.filter((t) => !('separator' in t));
// ============================================================
// Main Settings component
// ============================================================
export function Settings() {
    const [searchParams, setSearchParams] = useSearchParams();
    const { t } = useTranslation();
    // 从 URL 参数读取初始 tab，支持 /settings?tab=model&sub=connection
    const urlTab = searchParams.get('tab') || 'general';
    const [tab, setTab] = useState(TABS.some(tb => tb.id === urlTab) ? urlTab : 'general');
    // URL 参数变化时同步 tab
    useEffect(() => {
        const t = searchParams.get('tab');
        // 用函数式 setState 避免 stale closure: 之前 deps 漏 `tab` 时,t === tab
        // 比较的是初次 mount 的闭包值，可能误判跳过更新。
        setTab(prev => (t && TABS.some(tb => tb.id === t) && t !== prev) ? t : prev);
    }, [searchParams]);
    const handleTabChange = (id) => {
        setTab(id);
        // 用户在 tab 间切换时只清掉 tab/sub 参数（这两个对子页有同步意义），
        // 其他 query 保留。旧实现直接 setSearchParams({}) 把 sub 也清了 →
        // 从 Dashboard banner 跳 /settings?tab=external&sub=note 进来,点 tab 后
        // sub 立刻被重置到默认值，用户感知不到为何"跳错位置"。
        if (searchParams.has('tab') || searchParams.has('sub')) {
            setSearchParams(prev => {
                const next = new URLSearchParams(prev);
                next.delete('tab');
                next.delete('sub');
                return next;
            }, { replace: true });
        }
    };
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "flex items-center gap-0.5 pb-0", style: { borderBottom: '1px solid var(--border-faint)' }, children: TAB_ITEMS.map((item, idx) => {
                    if ('separator' in item) {
                        return (_jsx("div", { className: "w-px h-4 mx-1 flex-shrink-0", style: { background: 'var(--border-faint)' } }, `sep-${idx}`));
                    }
                    const tb = item;
                    return (_jsxs("button", { onClick: () => handleTabChange(tb.id), className: `flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-all duration-150 relative ${tab === tb.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`, children: [_jsx(tb.icon, { size: 13 }), t(tb.labelKey), tab === tb.id && (_jsx("span", { className: "absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full", style: { background: 'var(--indicator)' } }))] }, tb.id));
                }) }), _jsxs(motion.div, { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 }, children: [tab === 'general' && _jsx(GeneralSettings, {}), tab === 'external' && _jsx(ExternalIntegration, { initialSub: searchParams.get('sub') || undefined }), tab === 'model' && _jsx(ModelConfig, { initialSub: searchParams.get('sub') || undefined }), tab === 'strategy' && _jsx(InternalStrategy, {}), tab === 'data' && _jsx(DataManagement, {}), tab === 'account' && _jsx(AccountSettings, {}), tab === 'cloud' && _jsx(CloudSyncSettings, {}), tab === 'about' && _jsx(AboutSection, {})] }, tab)] }));
}
