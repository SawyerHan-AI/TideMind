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
    'reconcile.failedTitle': 'TideMind — 云端对齐失败',
    // 文件选择对话框标题
    'dialog.pickServiceAccount': '选择 Google Cloud Service Account JSON 文件',
    'dialog.pickNoteFolder': '选择笔记文件夹',
    // 凭证文件校验(connections / credentials handler 返回,renderer 原样渲染)
    'cred.notJson': '文件不是合法的 JSON',
    'cred.notServiceAccount': '不是 Service Account 类型的凭证文件',
    'cred.tooLarge': '文件过大(>1MB),不是合法的 Service Account 凭证',
    'cred.accessFailed': '无法访问文件',
    // 连接测试(connections handler 返回,renderer 原样渲染)
    'conn.notFound': '连接不存在',
    'conn.ollamaSchemeInvalid': 'Ollama URL 协议必须是 http/https',
    'conn.ollamaUrlInvalid': 'Ollama URL 无效',
    'conn.baseUrlSchemeInvalid': 'base_url 协议必须是 http/https',
    'conn.baseUrlInvalid': 'base_url 无效',
    'conn.unknownProvider': '未知 provider 类型',
    // 笔记源(note-sources handler 返回)
    'noteSource.notFound': '笔记源不存在',
    'noteSource.unsupportedType': '不支持的工具类型',
    'noteSource.anotherInitializing': '有其他笔记源正在初始化，请等待完成后再试',
    'noteSource.initFailed': '初始化失败',
    'noteSource.stopped': '已停止',
  },
  en: {
    'tray.showWindow': 'Show Window',
    'tray.quit': 'Quit',
    'login.errorTitle': 'TideMind Login Error',
    'reconcile.failedTitle': 'TideMind — Cloud sync alignment failed',
    'dialog.pickServiceAccount': 'Select Google Cloud Service Account JSON file',
    'dialog.pickNoteFolder': 'Select notes folder',
    'cred.notJson': 'File is not valid JSON',
    'cred.notServiceAccount': 'Not a Service Account credential file',
    'cred.tooLarge': 'File too large (>1MB), not a valid Service Account credential',
    'cred.accessFailed': 'Cannot access file',
    'conn.notFound': 'Connection not found',
    'conn.ollamaSchemeInvalid': 'Ollama URL scheme must be http/https',
    'conn.ollamaUrlInvalid': 'Invalid Ollama URL',
    'conn.baseUrlSchemeInvalid': 'base_url scheme must be http/https',
    'conn.baseUrlInvalid': 'Invalid base_url',
    'conn.unknownProvider': 'Unknown provider type',
    'noteSource.notFound': 'Note source not found',
    'noteSource.unsupportedType': 'Unsupported tool type',
    'noteSource.anotherInitializing': 'Another note source is initializing, please wait and try again',
    'noteSource.initFailed': 'Initialization failed',
    'noteSource.stopped': 'Stopped',
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
