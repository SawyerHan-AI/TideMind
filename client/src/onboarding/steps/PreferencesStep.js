import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { Sun, Moon, Monitor, ChevronDown } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { SUPPORTED_LANGUAGES, changeAppLanguage } from '../../lib/i18n';
import { StepContainer } from '../components/StepContainer';
const THEME_OPTIONS = [
    { value: 'light', labelKey: 'settings:general.theme.light', Icon: Sun },
    { value: 'dark', labelKey: 'settings:general.theme.dark', Icon: Moon },
    { value: 'system', labelKey: 'settings:general.theme.system', Icon: Monitor },
];
export function PreferencesStep() {
    const { t, i18n } = useTranslation('onboarding');
    const { theme, setTheme } = useTheme();
    // perf-optimization-2026-05-17 P1-4:走 changeAppLanguage 先 await 加载
    // locale 文件再切换,避免闪烁。i18n 仍解构用于 i18n.language 读当前值。
    const changeLanguage = (code) => {
        localStorage.setItem('eb-language', code);
        void changeAppLanguage(code);
    };
    return (_jsx(StepContainer, { title: t('preferences.title'), description: t('preferences.description'), children: _jsxs("div", { className: "space-y-6 max-w-md mx-auto", children: [_jsxs("div", { className: "space-y-3", children: [_jsx("label", { className: "text-xs text-gray-400 block", children: t('settings:general.themeMode') }), _jsx("div", { className: "grid grid-cols-3 gap-2", children: THEME_OPTIONS.map(({ value, labelKey, Icon }) => {
                                const active = theme === value;
                                return (_jsxs("button", { onClick: () => setTheme(value), className: `flex flex-col items-center gap-2.5 px-3 py-4 rounded-xl text-center transition-all duration-200 border ${active
                                        ? 'text-white border-white/15'
                                        : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-white/8'}`, style: active ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}, children: [_jsx("div", { className: "w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200", style: {
                                                background: active ? 'var(--icon-bg-active)' : 'var(--icon-bg-inactive)',
                                                border: '1px solid',
                                                borderColor: active ? 'var(--icon-border-active)' : 'var(--icon-border-inactive)',
                                            }, children: _jsx(Icon, { size: 16 }) }), _jsx("p", { className: "text-xs font-medium", children: t(labelKey) })] }, value));
                            }) })] }), _jsxs("div", { className: "space-y-3", children: [_jsx("label", { className: "text-xs text-gray-400 block", children: t('settings:general.languageLabel') }), _jsxs("div", { className: "relative", children: [_jsx("select", { value: i18n.language, onChange: e => changeLanguage(e.target.value), className: "w-full appearance-none rounded-xl px-4 py-3 pr-10 text-sm font-medium transition-all duration-200 border border-white/10 text-white cursor-pointer focus:outline-none focus:border-white/20", style: { background: 'var(--selected-bg)' }, children: SUPPORTED_LANGUAGES.map(lang => (_jsx("option", { value: lang.code, children: lang.label }, lang.code))) }), _jsx("div", { className: "absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400", children: _jsx(ChevronDown, { size: 14 }) })] })] })] }) }));
}
