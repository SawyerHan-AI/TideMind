import { useMemo } from 'react'
import { useTimezone } from '../contexts/TimezoneContext'
import { timeAgo, formatDate, formatShortDate } from '../lib/format'

export function useFormatters() {
  const { resolvedTimezone } = useTimezone()
  return useMemo(() => ({
    timeAgo: (iso: string) => timeAgo(iso),
    formatDate: (iso: string) => formatDate(iso, resolvedTimezone),
    formatShortDate: (iso: string) => formatShortDate(iso, resolvedTimezone),
  }), [resolvedTimezone])
}
