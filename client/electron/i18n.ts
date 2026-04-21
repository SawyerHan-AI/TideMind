/**
 * Minimal i18n helper for Electron main process.
 * Only covers zh/en (zh-TW falls back to zh). System locale → 2-char prefix match.
 * 12-language coverage is not needed here: tray menus and system dialogs are OS-native,
 * and macOS itself will adjust system strings. We handle zh vs. en as the primary split.
 */

import { app } from 'electron'

type MainLocale = 'zh' | 'en'

const translations: Record<MainLocale, Record<string, string>> = {
  zh: {
    'tray.showWindow': '显示窗口',
    'tray.quit': '退出',
    'login.errorTitle': 'TideMind 登录错误',
  },
  en: {
    'tray.showWindow': 'Show Window',
    'tray.quit': 'Quit',
    'login.errorTitle': 'TideMind Login Error',
  },
}

function getLocale(): MainLocale {
  const locale = app.getLocale()
  if (locale.startsWith('zh')) return 'zh'
  return 'en'
}

export function mainT(key: string): string {
  const locale = getLocale()
  return translations[locale][key] ?? translations['en'][key] ?? key
}
