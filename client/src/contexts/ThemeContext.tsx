import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'dark' | 'light' | 'system'

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  setTheme: () => {},
})

function getSystemScheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  const effective = theme === 'system' ? getSystemScheme() : theme
  document.documentElement.setAttribute('data-theme', effective)
}

const VALID_THEMES: Theme[] = ['dark', 'light', 'system']

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const v = localStorage.getItem('eb-theme')
    return (v && VALID_THEMES.includes(v as Theme) ? v as Theme : 'dark')
  })

  // Apply on mount and when theme changes
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // When "system" mode is active, track OS preference changes
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    localStorage.setItem('eb-theme', t)
  }, [])

  // 修复(2026-05-09 轻微):用 useMemo 包 Provider value,避免每次 ThemeProvider
  // render 都新建对象引用 → 所有 useTheme() 消费者随之 re-render。
  const value = useMemo<ThemeContextValue>(() => ({ theme, setTheme }), [theme, setTheme])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
