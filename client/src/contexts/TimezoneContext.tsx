import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

type Timezone = string // IANA name or literal 'system'

interface TimezoneContextValue {
  timezone: Timezone
  resolvedTimezone: string
  setTimezone: (tz: Timezone) => void
}

const TimezoneContext = createContext<TimezoneContextValue>({
  timezone: 'system',
  resolvedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  setTimezone: () => {},
})

export function resolveSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezoneState] = useState<Timezone>(
    () => localStorage.getItem('eb-timezone') ?? 'system',
  )
  const [resolvedTimezone, setResolvedTimezone] = useState<string>(
    () => timezone === 'system' ? resolveSystemTimezone() : timezone,
  )

  useEffect(() => {
    if (timezone === 'system') {
      setResolvedTimezone(resolveSystemTimezone())
      // Re-resolve when window regains focus (user may have changed system tz)
      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          setResolvedTimezone(resolveSystemTimezone())
        }
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => document.removeEventListener('visibilitychange', onVisibility)
    } else {
      setResolvedTimezone(timezone)
    }
  }, [timezone])

  const setTimezone = useCallback((tz: Timezone) => {
    localStorage.setItem('eb-timezone', tz)
    setTimezoneState(tz)
  }, [])

  // 行内字面量 value 会导致每次 Provider render 都新建对象,所有 useTimezone
  // 消费者无条件 re-render(perf-optimization-2026-05-17 P0-2)。
  const value = useMemo<TimezoneContextValue>(
    () => ({ timezone, resolvedTimezone, setTimezone }),
    [timezone, resolvedTimezone, setTimezone],
  )

  return (
    <TimezoneContext.Provider value={value}>
      {children}
    </TimezoneContext.Provider>
  )
}

export function useTimezone() {
  return useContext(TimezoneContext)
}
