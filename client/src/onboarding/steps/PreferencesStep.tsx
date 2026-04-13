import { useTranslation } from 'react-i18next'
import { Sun, Moon, Monitor, ChevronDown } from 'lucide-react'
import { useTheme, type Theme } from '../../contexts/ThemeContext'
import { SUPPORTED_LANGUAGES } from '../../lib/i18n'
import { StepContainer } from '../components/StepContainer'

const THEME_OPTIONS: { value: Theme; labelKey: string; Icon: typeof Sun }[] = [
  { value: 'light', labelKey: 'settings:general.theme.light', Icon: Sun },
  { value: 'dark', labelKey: 'settings:general.theme.dark', Icon: Moon },
  { value: 'system', labelKey: 'settings:general.theme.system', Icon: Monitor },
]

export function PreferencesStep() {
  const { t, i18n } = useTranslation('onboarding')
  const { theme, setTheme } = useTheme()

  const changeLanguage = (code: string) => {
    i18n.changeLanguage(code)
    localStorage.setItem('eb-language', code)
  }

  return (
    <StepContainer title={t('preferences.title')} description={t('preferences.description')}>
      <div className="space-y-6 max-w-md mx-auto">
        {/* Theme */}
        <div className="space-y-3">
          <label className="text-xs text-gray-400 block">{t('settings:general.themeMode')}</label>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map(({ value, labelKey, Icon }) => {
              const active = theme === value
              return (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={`flex flex-col items-center gap-2.5 px-3 py-4 rounded-xl text-center transition-all duration-200 border ${
                    active
                      ? 'text-white border-white/15'
                      : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-white/8'
                  }`}
                  style={active ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200"
                    style={{
                      background: active ? 'var(--icon-bg-active)' : 'var(--icon-bg-inactive)',
                      border: '1px solid',
                      borderColor: active ? 'var(--icon-border-active)' : 'var(--icon-border-inactive)',
                    }}
                  >
                    <Icon size={16} />
                  </div>
                  <p className="text-xs font-medium">{t(labelKey)}</p>
                </button>
              )
            })}
          </div>
        </div>

        {/* Language */}
        <div className="space-y-3">
          <label className="text-xs text-gray-400 block">{t('settings:general.languageLabel')}</label>
          <div className="relative">
            <select
              value={i18n.language}
              onChange={e => changeLanguage(e.target.value)}
              className="w-full appearance-none rounded-xl px-4 py-3 pr-10 text-sm font-medium transition-all duration-200 border border-white/10 text-white cursor-pointer focus:outline-none focus:border-white/20"
              style={{ background: 'var(--selected-bg)' }}
            >
              {SUPPORTED_LANGUAGES.map(lang => (
                <option key={lang.code} value={lang.code}>{lang.label}</option>
              ))}
            </select>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
              <ChevronDown size={14} />
            </div>
          </div>
        </div>
      </div>
    </StepContainer>
  )
}
