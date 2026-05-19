import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
const TimezoneContext = createContext({
    timezone: 'system',
    resolvedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    setTimezone: () => { },
});
export function resolveSystemTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
export function TimezoneProvider({ children }) {
    const [timezone, setTimezoneState] = useState(() => localStorage.getItem('eb-timezone') ?? 'system');
    const [resolvedTimezone, setResolvedTimezone] = useState(() => timezone === 'system' ? resolveSystemTimezone() : timezone);
    useEffect(() => {
        if (timezone === 'system') {
            setResolvedTimezone(resolveSystemTimezone());
            // Re-resolve when window regains focus (user may have changed system tz)
            const onVisibility = () => {
                if (document.visibilityState === 'visible') {
                    setResolvedTimezone(resolveSystemTimezone());
                }
            };
            document.addEventListener('visibilitychange', onVisibility);
            return () => document.removeEventListener('visibilitychange', onVisibility);
        }
        else {
            setResolvedTimezone(timezone);
        }
    }, [timezone]);
    const setTimezone = useCallback((tz) => {
        localStorage.setItem('eb-timezone', tz);
        setTimezoneState(tz);
    }, []);
    // 行内字面量 value 会导致每次 Provider render 都新建对象,所有 useTimezone
    // 消费者无条件 re-render(perf-optimization-2026-05-17 P0-2)。
    const value = useMemo(() => ({ timezone, resolvedTimezone, setTimezone }), [timezone, resolvedTimezone, setTimezone]);
    return (_jsx(TimezoneContext.Provider, { value: value, children: children }));
}
export function useTimezone() {
    return useContext(TimezoneContext);
}
