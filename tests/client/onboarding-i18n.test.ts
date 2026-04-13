/**
 * Onboarding i18n 完整性测试
 *
 * 确保所有 12 种语言的 onboarding.json 包含相同的 key 集合，
 * 以及 dashboard.json 和 settings.json 中新增的 onboarding 相关 key。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const LOCALES_DIR = path.resolve(__dirname, '../../client/src/locales')

const LANGUAGES = [
  'en', 'zh-CN', 'zh-TW', 'ja', 'ko',
  'fr', 'es', 'de', 'pt-BR', 'ru', 'it', 'tr',
]

/** 递归提取所有叶子节点的 key 路径 */
function flatKeys(obj: Record<string, any>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      keys.push(...flatKeys(v, full))
    } else {
      keys.push(full)
    }
  }
  return keys.sort()
}

function loadJson(lang: string, file: string): Record<string, any> {
  const filePath = path.join(LOCALES_DIR, lang, file)
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

describe('onboarding i18n 完整性', () => {
  const enOnboarding = loadJson('en', 'onboarding.json')
  const enKeys = flatKeys(enOnboarding)

  it('英文 onboarding.json 包含所有必要 key', () => {
    const required = [
      'welcome.title', 'welcome.subtitle', 'welcome.description', 'welcome.start',
      'preferences.title', 'preferences.description',
      'model.title', 'model.description', 'model.skipWarning', 'model.skip',
      'agent.title', 'agent.description', 'agent.skip',
      'noteSource.title', 'noteSource.description', 'noteSource.skip',
      'complete.title', 'complete.subtitle', 'complete.configured', 'complete.skipped',
      'complete.modelLabel', 'complete.agentLabel', 'complete.noteSourceLabel',
      'complete.preferencesLabel', 'complete.enter',
      'steps.welcome', 'steps.preferences', 'steps.model', 'steps.agent',
      'steps.noteSource', 'steps.complete',
      'nav.next', 'nav.back', 'nav.skip',
    ]
    for (const key of required) {
      expect(enKeys, `missing key: ${key}`).toContain(key)
    }
  })

  for (const lang of LANGUAGES.filter(l => l !== 'en')) {
    it(`${lang}/onboarding.json 与 en 的 key 完全一致`, () => {
      const langJson = loadJson(lang, 'onboarding.json')
      const langKeys = flatKeys(langJson)
      expect(langKeys).toEqual(enKeys)
    })
  }
})

describe('dashboard i18n 新增 key', () => {
  const REQUIRED_KEYS = ['empty.title', 'empty.description', 'empty.settings', 'modelWarning.message', 'modelWarning.action']

  for (const lang of LANGUAGES) {
    it(`${lang}/dashboard.json 包含 empty 和 modelWarning key`, () => {
      const json = loadJson(lang, 'dashboard.json')
      const keys = flatKeys(json)
      for (const key of REQUIRED_KEYS) {
        expect(keys, `${lang} missing key: ${key}`).toContain(key)
      }
    })
  }
})

describe('settings i18n 新增 key', () => {
  const REQUIRED_KEYS = ['general.onboarding', 'general.onboardingDesc', 'general.rerunOnboarding']

  for (const lang of LANGUAGES) {
    it(`${lang}/settings.json 包含 onboarding 相关 key`, () => {
      const json = loadJson(lang, 'settings.json')
      const keys = flatKeys(json)
      for (const key of REQUIRED_KEYS) {
        expect(keys, `${lang} missing key: ${key}`).toContain(key)
      }
    })
  }
})
