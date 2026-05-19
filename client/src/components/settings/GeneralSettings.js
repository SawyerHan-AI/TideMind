import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/ThemeContext';
import { useTimezone, resolveSystemTimezone } from '../../contexts/TimezoneContext';
import { SUPPORTED_LANGUAGES, changeAppLanguage } from '../../lib/i18n';
import { Section } from './shared';
const THEME_OPTIONS = [
    { value: 'light', labelKey: 'settings:general.theme.light', descKey: 'settings:general.theme.lightDesc', Icon: Sun },
    { value: 'dark', labelKey: 'settings:general.theme.dark', descKey: 'settings:general.theme.darkDesc', Icon: Moon },
    { value: 'system', labelKey: 'settings:general.theme.system', descKey: 'settings:general.theme.systemDesc', Icon: Monitor },
];
const ALL_TIMEZONES = Intl.supportedValuesOf('timeZone');
export function GeneralSettings() {
    const { theme, setTheme } = useTheme();
    const { timezone, setTimezone } = useTimezone();
    const { t, i18n } = useTranslation();
    const [updateChannel, setUpdateChannelState] = useState('stable');
    useEffect(() => {
        let cancelled = false;
        window.api.updater.getChannel().then((ch) => {
            if (!cancelled)
                setUpdateChannelState(ch);
        }).catch(() => { });
        return () => { cancelled = true; };
    }, []);
    const handleChannelChange = async (next) => {
        if (next === updateChannel)
            return;
        setUpdateChannelState(next);
        try {
            await window.api.updater.setChannel(next);
        }
        catch {
            // 回滚 UI 状态,失败时尽量让用户感知不到无声成功
            setUpdateChannelState(updateChannel);
        }
    };
    // perf-optimization-2026-05-17 P1-4:走 changeAppLanguage 先 await 加载
    // locale 文件再切换,避免闪烁。i18n 仍解构用于 i18n.language 读当前值。
    const changeLanguage = (code) => {
        localStorage.setItem('eb-language', code);
        void changeAppLanguage(code);
    };
    return (_jsxs("div", { className: "space-y-6 max-w-xl", children: [_jsx(Section, { title: t('settings:general.appearance'), children: _jsxs("div", { className: "space-y-3", children: [_jsx("label", { className: "text-xs text-gray-400 block", children: t('settings:general.themeMode') }), _jsx("div", { className: "grid grid-cols-3 gap-2", children: THEME_OPTIONS.map(({ value, labelKey, descKey, Icon }) => {
                                const active = theme === value;
                                return (_jsxs("button", { onClick: () => setTheme(value), className: `flex flex-col items-center gap-2.5 px-3 py-4 rounded-xl text-center transition-all duration-200 border ${active
                                        ? 'text-white border-white/15'
                                        : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-white/8'}`, style: active
                                        ? {
                                            background: 'var(--selected-bg)',
                                            boxShadow: 'var(--selected-shadow)',
                                        }
                                        : {}, children: [_jsx("div", { className: "w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200", style: {
                                                background: active ? 'var(--icon-bg-active)' : 'var(--icon-bg-inactive)',
                                                border: '1px solid',
                                                borderColor: active ? 'var(--icon-border-active)' : 'var(--icon-border-inactive)',
                                            }, children: _jsx(Icon, { size: 16 }) }), _jsxs("div", { children: [_jsx("p", { className: "text-xs font-medium leading-none mb-1", children: t(labelKey) }), _jsx("p", { className: "text-[10px] text-gray-500 leading-tight", children: t(descKey) })] })] }, value));
                            }) })] }) }), _jsx(Section, { title: t('settings:general.language'), children: _jsxs("div", { className: "space-y-3", children: [_jsx("label", { className: "text-xs text-gray-400 block", children: t('settings:general.languageLabel') }), _jsxs("div", { className: "relative", children: [_jsx("select", { value: i18n.language, onChange: e => changeLanguage(e.target.value), className: "w-full appearance-none rounded-xl px-4 py-3 pr-10 text-sm font-medium transition-all duration-200 border border-white/10 text-white cursor-pointer focus:outline-none focus:border-white/20", style: {
                                        background: 'var(--selected-bg)',
                                    }, children: SUPPORTED_LANGUAGES.map(lang => (_jsx("option", { value: lang.code, children: lang.label }, lang.code))) }), _jsx("div", { className: "absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400", children: _jsx(ChevronDown, { size: 14 }) })] })] }) }), _jsx(Section, { title: t('settings:general.timezone'), children: _jsxs("div", { className: "space-y-3", children: [_jsx("label", { className: "text-xs text-gray-400 block", children: t('settings:general.timezoneLabel') }), _jsxs("div", { className: "relative", children: [_jsxs("select", { value: timezone, onChange: e => setTimezone(e.target.value), className: "w-full appearance-none rounded-xl px-4 py-3 pr-10 text-sm font-medium transition-all duration-200 border border-white/10 text-white cursor-pointer focus:outline-none focus:border-white/20", style: {
                                        background: 'var(--selected-bg)',
                                    }, children: [_jsx("option", { value: "system", children: t('settings:general.timezoneSystem', { timezone: resolveSystemTimezone() }) }), ALL_TIMEZONES.map(tz => (_jsx("option", { value: tz, children: tz }, tz)))] }), _jsx("div", { className: "absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400", children: _jsx(ChevronDown, { size: 14 }) })] })] }) }), _jsx(Section, { title: t('settings:general.updateChannel'), children: _jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-xs text-gray-500", children: t('settings:general.updateChannelDesc') }), _jsx("div", { className: "grid grid-cols-2 gap-2", children: ['stable', 'beta'].map((ch) => {
                                const active = updateChannel === ch;
                                return (_jsx("button", { onClick: () => void handleChannelChange(ch), className: `px-3 py-3 rounded-xl text-center text-xs font-medium transition-all duration-200 border ${active
                                        ? 'text-white border-white/15'
                                        : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-white/8'}`, style: active
                                        ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' }
                                        : {}, children: t(`settings:general.updateChannel${ch === 'beta' ? 'Beta' : 'Stable'}`) }, ch));
                            }) })] }) }), _jsx(Section, { title: t('settings:general.onboarding'), children: _jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-xs text-gray-500", children: t('settings:general.onboardingDesc') }), _jsx("button", { onClick: async () => {
                                await window.api.config.update({ onboarding_completed: false });
                                window.location.hash = '#/onboarding';
                                window.location.reload();
                            }, className: "px-4 py-2 text-xs font-medium text-gray-300 rounded-xl border border-white/10 hover:border-white/20 hover:text-white transition-all", style: { background: 'var(--theme-glass-bg)' }, children: t('settings:general.rerunOnboarding') })] }) })] }));
}
