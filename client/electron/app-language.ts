export const SUPPORTED_APP_LANGUAGES = [
  'en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt-BR', 'ru', 'it', 'tr',
] as const

export type AppLanguage = typeof SUPPORTED_APP_LANGUAGES[number]

let currentLanguage: AppLanguage = 'en'

export function setAppLanguage(value: unknown): AppLanguage {
  if (!SUPPORTED_APP_LANGUAGES.includes(value as AppLanguage)) {
    throw new Error('unsupported app language')
  }
  currentLanguage = value as AppLanguage
  return currentLanguage
}

export function getAppLanguage(): AppLanguage {
  return currentLanguage
}
