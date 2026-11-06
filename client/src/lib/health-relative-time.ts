/** Calendar-day labels use the client's local day, not rounded elapsed hours. */
export function formatHealthRelativeTime(timestamp: number, locale: string, empty: string, now = Date.now()): string {
  if (!timestamp || !Number.isFinite(timestamp)) return empty
  const current = new Date(now), previous = new Date(timestamp)
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const days = Math.round((day(previous) - day(current)) / 86_400_000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (days !== 0) return rtf.format(days, 'day')
  const seconds = Math.round((timestamp - now) / 1000)
  if (Math.abs(seconds) < 60) return rtf.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  return rtf.format(Math.round(minutes / 60), 'hour')
}
