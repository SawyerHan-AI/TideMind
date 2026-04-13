import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// --- zh-CN ---
import zhCNCommon from '../locales/zh-CN/common.json'
import zhCNSettings from '../locales/zh-CN/settings.json'
import zhCNDashboard from '../locales/zh-CN/dashboard.json'
import zhCNExplorer from '../locales/zh-CN/explorer.json'
import zhCNTimeline from '../locales/zh-CN/timeline.json'
import zhCNConstants from '../locales/zh-CN/constants.json'
import zhCNTooltips from '../locales/zh-CN/tooltips.json'
import zhCNOnboarding from '../locales/zh-CN/onboarding.json'

// --- en ---
import enCommon from '../locales/en/common.json'
import enSettings from '../locales/en/settings.json'
import enDashboard from '../locales/en/dashboard.json'
import enExplorer from '../locales/en/explorer.json'
import enTimeline from '../locales/en/timeline.json'
import enConstants from '../locales/en/constants.json'
import enTooltips from '../locales/en/tooltips.json'
import enOnboarding from '../locales/en/onboarding.json'

// --- zh-TW ---
import zhTWCommon from '../locales/zh-TW/common.json'
import zhTWSettings from '../locales/zh-TW/settings.json'
import zhTWDashboard from '../locales/zh-TW/dashboard.json'
import zhTWExplorer from '../locales/zh-TW/explorer.json'
import zhTWTimeline from '../locales/zh-TW/timeline.json'
import zhTWConstants from '../locales/zh-TW/constants.json'
import zhTWTooltips from '../locales/zh-TW/tooltips.json'
import zhTWOnboarding from '../locales/zh-TW/onboarding.json'

// --- ja ---
import jaCommon from '../locales/ja/common.json'
import jaSettings from '../locales/ja/settings.json'
import jaDashboard from '../locales/ja/dashboard.json'
import jaExplorer from '../locales/ja/explorer.json'
import jaTimeline from '../locales/ja/timeline.json'
import jaConstants from '../locales/ja/constants.json'
import jaTooltips from '../locales/ja/tooltips.json'
import jaOnboarding from '../locales/ja/onboarding.json'

// --- ko ---
import koCommon from '../locales/ko/common.json'
import koSettings from '../locales/ko/settings.json'
import koDashboard from '../locales/ko/dashboard.json'
import koExplorer from '../locales/ko/explorer.json'
import koTimeline from '../locales/ko/timeline.json'
import koConstants from '../locales/ko/constants.json'
import koTooltips from '../locales/ko/tooltips.json'
import koOnboarding from '../locales/ko/onboarding.json'

// --- fr ---
import frCommon from '../locales/fr/common.json'
import frSettings from '../locales/fr/settings.json'
import frDashboard from '../locales/fr/dashboard.json'
import frExplorer from '../locales/fr/explorer.json'
import frTimeline from '../locales/fr/timeline.json'
import frConstants from '../locales/fr/constants.json'
import frTooltips from '../locales/fr/tooltips.json'
import frOnboarding from '../locales/fr/onboarding.json'

// --- es ---
import esCommon from '../locales/es/common.json'
import esSettings from '../locales/es/settings.json'
import esDashboard from '../locales/es/dashboard.json'
import esExplorer from '../locales/es/explorer.json'
import esTimeline from '../locales/es/timeline.json'
import esConstants from '../locales/es/constants.json'
import esTooltips from '../locales/es/tooltips.json'
import esOnboarding from '../locales/es/onboarding.json'

// --- de ---
import deCommon from '../locales/de/common.json'
import deSettings from '../locales/de/settings.json'
import deDashboard from '../locales/de/dashboard.json'
import deExplorer from '../locales/de/explorer.json'
import deTimeline from '../locales/de/timeline.json'
import deConstants from '../locales/de/constants.json'
import deTooltips from '../locales/de/tooltips.json'
import deOnboarding from '../locales/de/onboarding.json'

// --- pt-BR ---
import ptBRCommon from '../locales/pt-BR/common.json'
import ptBRSettings from '../locales/pt-BR/settings.json'
import ptBRDashboard from '../locales/pt-BR/dashboard.json'
import ptBRExplorer from '../locales/pt-BR/explorer.json'
import ptBRTimeline from '../locales/pt-BR/timeline.json'
import ptBRConstants from '../locales/pt-BR/constants.json'
import ptBRTooltips from '../locales/pt-BR/tooltips.json'
import ptBROnboarding from '../locales/pt-BR/onboarding.json'

// --- ru ---
import ruCommon from '../locales/ru/common.json'
import ruSettings from '../locales/ru/settings.json'
import ruDashboard from '../locales/ru/dashboard.json'
import ruExplorer from '../locales/ru/explorer.json'
import ruTimeline from '../locales/ru/timeline.json'
import ruConstants from '../locales/ru/constants.json'
import ruTooltips from '../locales/ru/tooltips.json'
import ruOnboarding from '../locales/ru/onboarding.json'

// --- it ---
import itCommon from '../locales/it/common.json'
import itSettings from '../locales/it/settings.json'
import itDashboard from '../locales/it/dashboard.json'
import itExplorer from '../locales/it/explorer.json'
import itTimeline from '../locales/it/timeline.json'
import itConstants from '../locales/it/constants.json'
import itTooltips from '../locales/it/tooltips.json'
import itOnboarding from '../locales/it/onboarding.json'

// --- tr ---
import trCommon from '../locales/tr/common.json'
import trSettings from '../locales/tr/settings.json'
import trDashboard from '../locales/tr/dashboard.json'
import trExplorer from '../locales/tr/explorer.json'
import trTimeline from '../locales/tr/timeline.json'
import trConstants from '../locales/tr/constants.json'
import trTooltips from '../locales/tr/tooltips.json'
import trOnboarding from '../locales/tr/onboarding.json'

const ns = ['common', 'settings', 'dashboard', 'explorer', 'timeline', 'constants', 'tooltips', 'onboarding'] as const

i18n.use(initReactI18next).init({
  resources: {
    en:      { common: enCommon, settings: enSettings, dashboard: enDashboard, explorer: enExplorer, timeline: enTimeline, constants: enConstants, tooltips: enTooltips, onboarding: enOnboarding },
    'zh-CN': { common: zhCNCommon, settings: zhCNSettings, dashboard: zhCNDashboard, explorer: zhCNExplorer, timeline: zhCNTimeline, constants: zhCNConstants, tooltips: zhCNTooltips, onboarding: zhCNOnboarding },
    'zh-TW': { common: zhTWCommon, settings: zhTWSettings, dashboard: zhTWDashboard, explorer: zhTWExplorer, timeline: zhTWTimeline, constants: zhTWConstants, tooltips: zhTWTooltips, onboarding: zhTWOnboarding },
    ja:      { common: jaCommon, settings: jaSettings, dashboard: jaDashboard, explorer: jaExplorer, timeline: jaTimeline, constants: jaConstants, tooltips: jaTooltips, onboarding: jaOnboarding },
    ko:      { common: koCommon, settings: koSettings, dashboard: koDashboard, explorer: koExplorer, timeline: koTimeline, constants: koConstants, tooltips: koTooltips, onboarding: koOnboarding },
    fr:      { common: frCommon, settings: frSettings, dashboard: frDashboard, explorer: frExplorer, timeline: frTimeline, constants: frConstants, tooltips: frTooltips, onboarding: frOnboarding },
    es:      { common: esCommon, settings: esSettings, dashboard: esDashboard, explorer: esExplorer, timeline: esTimeline, constants: esConstants, tooltips: esTooltips, onboarding: esOnboarding },
    de:      { common: deCommon, settings: deSettings, dashboard: deDashboard, explorer: deExplorer, timeline: deTimeline, constants: deConstants, tooltips: deTooltips, onboarding: deOnboarding },
    'pt-BR': { common: ptBRCommon, settings: ptBRSettings, dashboard: ptBRDashboard, explorer: ptBRExplorer, timeline: ptBRTimeline, constants: ptBRConstants, tooltips: ptBRTooltips, onboarding: ptBROnboarding },
    ru:      { common: ruCommon, settings: ruSettings, dashboard: ruDashboard, explorer: ruExplorer, timeline: ruTimeline, constants: ruConstants, tooltips: ruTooltips, onboarding: ruOnboarding },
    it:      { common: itCommon, settings: itSettings, dashboard: itDashboard, explorer: itExplorer, timeline: itTimeline, constants: itConstants, tooltips: itTooltips, onboarding: itOnboarding },
    tr:      { common: trCommon, settings: trSettings, dashboard: trDashboard, explorer: trExplorer, timeline: trTimeline, constants: trConstants, tooltips: trTooltips, onboarding: trOnboarding },
  },
  lng: localStorage.getItem('eb-language') || 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: [...ns],
  interpolation: { escapeValue: false },
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

export default i18n
