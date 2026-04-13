import { formatDistanceToNow, format, type Locale } from 'date-fns'
import { tz } from '@date-fns/tz'
import { zhCN, zhTW, enUS, ja, ko, fr, es, de, ptBR, ru, it, tr } from 'date-fns/locale'
import i18n from './i18n'

const localeMap: Record<string, Locale> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en: enUS,
  ja,
  ko,
  fr,
  es,
  de,
  'pt-BR': ptBR,
  ru,
  it,
  tr,
}

function getDateLocale(): Locale {
  return localeMap[i18n.language] ?? enUS
}

export function timeAgo(isoString: string): string {
  try {
    const raw = formatDistanceToNow(new Date(isoString), { addSuffix: true, locale: getDateLocale() })
    // date-fns 中文 locale 在 hours/months/years 输出"大约 N 小时前"，去掉"大约"前缀。
    // 其他 locale 没有这个词，replace 是 no-op。
    return raw.replace(/^大约\s*/, '')
  } catch {
    return isoString
  }
}

export function formatDate(isoString: string, timezone: string): string {
  try {
    return format(new Date(isoString), 'yyyy-MM-dd HH:mm', { in: tz(timezone), locale: getDateLocale() })
  } catch {
    return isoString
  }
}

/** 短日期格式：MM-DD HH:mm，用于版本历史等空间紧凑的场景 */
export function formatShortDate(isoString: string, timezone: string): string {
  try {
    return format(new Date(isoString), 'MM-dd HH:mm', { in: tz(timezone), locale: getDateLocale() })
  } catch {
    return isoString
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}
