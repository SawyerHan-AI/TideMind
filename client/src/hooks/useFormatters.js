import { useMemo } from 'react';
import { useTimezone } from '../contexts/TimezoneContext';
import { timeAgo, formatDate, formatShortDate } from '../lib/format';
export function useFormatters() {
    const { resolvedTimezone } = useTimezone();
    return useMemo(() => ({
        timeAgo: (iso) => timeAgo(iso),
        formatDate: (iso) => formatDate(iso, resolvedTimezone),
        formatShortDate: (iso) => formatShortDate(iso, resolvedTimezone),
    }), [resolvedTimezone]);
}
