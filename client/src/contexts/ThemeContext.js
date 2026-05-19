import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
const ThemeContext = createContext({
    theme: 'dark',
    setTheme: () => { },
});
function getSystemScheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
    const effective = theme === 'system' ? getSystemScheme() : theme;
    document.documentElement.setAttribute('data-theme', effective);
}
const VALID_THEMES = ['dark', 'light', 'system'];
export function ThemeProvider({ children }) {
    const [theme, setThemeState] = useState(() => {
        const v = localStorage.getItem('eb-theme');
        return (v && VALID_THEMES.includes(v) ? v : 'dark');
    });
    // Apply on mount and when theme changes
    useEffect(() => {
        applyTheme(theme);
    }, [theme]);
    // When "system" mode is active, track OS preference changes
    useEffect(() => {
        if (theme !== 'system')
            return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => applyTheme('system');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [theme]);
    const setTheme = useCallback((t) => {
        setThemeState(t);
        localStorage.setItem('eb-theme', t);
    }, []);
    // 修复(2026-05-09 轻微):用 useMemo 包 Provider value,避免每次 ThemeProvider
    // render 都新建对象引用 → 所有 useTheme() 消费者随之 re-render。
    const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
    return (_jsx(ThemeContext.Provider, { value: value, children: children }));
}
export function useTheme() {
    return useContext(ThemeContext);
}
