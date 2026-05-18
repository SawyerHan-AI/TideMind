import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// 按需加载 locale(perf-optimization-2026-05-17 P1-4):原本 12 语言 × 8
// 命名空间 = 96 个 JSON 全静态 import 进首包,初始 bundle 带 150-300KB 不
// 必要负担。改成 Vite `import.meta.glob`(惰性)按需加载——main.tsx 启动时
// 仅 await 当前 locale + 英文 fallback 的 16 份 JSON,切换语言时再异步拉
// 对应语言的 8 份。
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>('../locales/*/*.json')

const NS = ['common', 'settings', 'dashboard', 'explorer', 'timeline', 'constants', 'tooltips', 'onboarding'] as const

const VALID_LANGUAGE_CODES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt-BR', 'ru', 'it', 'tr']

export function getSavedLanguage(): string {
  const v = localStorage.getItem('eb-language')
  return v && VALID_LANGUAGE_CODES.includes(v) ? v : 'en'
}

const loadedLocales = new Set<string>()

/**
 * 加载某 locale 的所有命名空间到 i18next resources。
 * 已加载过则直接返回。所有 namespace 并发加载。
 */
export async function loadLocaleNamespaces(lng: string): Promise<void> {
  if (loadedLocales.has(lng)) return
  await Promise.all(
    NS.map(async ns => {
      const key = `../locales/${lng}/${ns}.json`
      const loader = localeModules[key]
      if (!loader) {
        // 缺失文件不致命:i18next 会用 fallbackLng 兜底,t() 返回 key
        console.warn(`[i18n] missing locale file: ${key}`)
        return
      }
      const mod = await loader()
      i18n.addResourceBundle(lng, ns, mod.default, true, true)
    }),
  )
  loadedLocales.add(lng)
}

// 同步 init:resources 为空,等 main.tsx 调用 loadLocaleNamespaces 后填充。
// partialBundledLanguages 允许 resources 在初始化后增量补充。
i18n.use(initReactI18next).init({
  resources: {},
  lng: getSavedLanguage(),
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: [...NS],
  interpolation: { escapeValue: false },
  partialBundledLanguages: true,
})

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'ru', label: 'Русский' },
  { code: 'it', label: 'Italiano' },
  { code: 'tr', label: 'Türkçe' },
] as const

/**
 * 切换应用语言。先 await 加载对应 locale 的所有 namespace,再切换 i18n,
 * 避免短暂"翻译 key 直接显示"闪烁。
 */
export async function changeAppLanguage(code: string): Promise<void> {
  await loadLocaleNamespaces(code)
  await i18n.changeLanguage(code)
}

export default i18n
