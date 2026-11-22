import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme, type Theme } from '../../contexts/ThemeContext'
import { useTimezone, resolveSystemTimezone } from '../../contexts/TimezoneContext'
import { SUPPORTED_LANGUAGES, changeAppLanguage } from '../../lib/i18n'
import { Section } from './shared'

type UpdateChannel = 'stable' | 'beta'

interface ThemeOption {
  value: Theme
  labelKey: string
  descKey: string
  Icon: typeof Sun
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'light', labelKey: 'settings:general.theme.light', descKey: 'settings:general.theme.lightDesc', Icon: Sun },
  { value: 'dark', labelKey: 'settings:general.theme.dark', descKey: 'settings:general.theme.darkDesc', Icon: Moon },
  { value: 'system', labelKey: 'settings:general.theme.system', descKey: 'settings:general.theme.systemDesc', Icon: Monitor },
]

const ALL_TIMEZONES = Intl.supportedValuesOf('timeZone')

export function GeneralSettings() {
  const { theme, setTheme } = useTheme()
  const { timezone, setTimezone } = useTimezone()
  const { t, i18n } = useTranslation()
  const [updateChannel, setUpdateChannelState] = useState<UpdateChannel>('stable')

  useEffect(() => {
    let cancelled = false
    window.api.updater.getChannel().then((ch) => {
      if (!cancelled) setUpdateChannelState(ch)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleChannelChange = async (next: UpdateChannel) => {
    if (next === updateChannel) return
    // 修复(2026-05-20 产品决策 #2 C 方案):Beta → Stable 切换时确认提示。
    // 用户从 0.2.X-beta.N 切回 stable 时,服务端会立刻下发同 core 的 stable 版本
    // 作为"升级",客户端会自动下载安装。SemVer 上正式版 > beta,但用户语义里
    // "切回 stable" 不代表"立刻给我装东西",所以需要 confirm。Stable → Beta 不需要
    // 确认(切到 Beta 本身就是"想试新东西"的明确意图)。
    if (updateChannel === 'beta' && next === 'stable') {
      const ok = window.confirm(
        t(
          'settings:general.channelSwitchConfirm',
          'Switching to Stable will install the latest stable version on your next update check (this may downgrade some experimental features). Continue?',
        ),
      )
      if (!ok) return
    }
    setUpdateChannelState(next)
    try {
      await window.api.updater.setChannel(next)
    } catch {
      // 回滚 UI 状态,失败时尽量让用户感知不到无声成功
      setUpdateChannelState(updateChannel)
    }
  }

  // perf-optimization-2026-05-17 P1-4:走 changeAppLanguage 先 await 加载
  // locale 文件再切换,避免闪烁。i18n 仍解构用于 i18n.language 读当前值。
  const changeLanguage = (code: string) => {
    localStorage.setItem('eb-language', code)
    void changeAppLanguage(code)
    void window.api.app.setLanguage(code)
  }

  return (
    <div className="space-y-6 max-w-xl">
      <Section title={t('settings:general.appearance')}>
        <div className="space-y-3">
          <label className="text-xs text-gray-400 block">{t('settings:general.themeMode')}</label>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map(({ value, labelKey, descKey, Icon }) => {
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
                  style={
                    active
                      ? {
                          background: 'var(--selected-bg)',
                          boxShadow: 'var(--selected-shadow)',
                        }
                      : {}
                  }
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
                  <div>
                    <p className="text-xs font-medium leading-none mb-1">{t(labelKey)}</p>
                    <p className="text-[10px] text-gray-500 leading-tight">{t(descKey)}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </Section>

      <Section title={t('settings:general.language')}>
        <div className="space-y-3">
          <label className="text-xs text-gray-400 block">{t('settings:general.languageLabel')}</label>
          <div className="relative">
            <select
              value={i18n.language}
              onChange={e => changeLanguage(e.target.value)}
              className="w-full appearance-none rounded-xl px-4 py-3 pr-10 text-sm font-medium transition-all duration-200 border border-white/10 text-white cursor-pointer focus:outline-none focus:border-white/20"
              style={{
                background: 'var(--selected-bg)',
              }}
            >
              {SUPPORTED_LANGUAGES.map(lang => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
              <ChevronDown size={14} />
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('settings:general.timezone')}>
        <div className="space-y-3">
          <label className="text-xs text-gray-400 block">{t('settings:general.timezoneLabel')}</label>
          <div className="relative">
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="w-full appearance-none rounded-xl px-4 py-3 pr-10 text-sm font-medium transition-all duration-200 border border-white/10 text-white cursor-pointer focus:outline-none focus:border-white/20"
              style={{
                background: 'var(--selected-bg)',
              }}
            >
              <option value="system">
                {t('settings:general.timezoneSystem', { timezone: resolveSystemTimezone() })}
              </option>
              {ALL_TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
              <ChevronDown size={14} />
            </div>
          </div>
        </div>
      </Section>
      <Section title={t('settings:general.updateChannel')}>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">{t('settings:general.updateChannelDesc')}</p>
          <div className="grid grid-cols-2 gap-2">
            {(['stable', 'beta'] as const).map((ch) => {
              const active = updateChannel === ch
              return (
                <button
                  key={ch}
                  onClick={() => void handleChannelChange(ch)}
                  className={`px-3 py-3 rounded-xl text-center text-xs font-medium transition-all duration-200 border ${
                    active
                      ? 'text-white border-white/15'
                      : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-white/8'
                  }`}
                  style={
                    active
                      ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' }
                      : {}
                  }
                >
                  {t(`settings:general.updateChannel${ch === 'beta' ? 'Beta' : 'Stable'}`)}
                </button>
              )
            })}
          </div>
        </div>
      </Section>
      <Section title={t('settings:general.onboarding')}>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">{t('settings:general.onboardingDesc')}</p>
          <button
            onClick={async () => {
              await window.api.config.update({ onboarding_completed: false })
              window.location.hash = '#/onboarding'
              window.location.reload()
            }}
            className="px-4 py-2 text-xs font-medium text-gray-300 rounded-xl border border-white/10 hover:border-white/20 hover:text-white transition-all"
            style={{ background: 'var(--theme-glass-bg)' }}
          >
            {t('settings:general.rerunOnboarding')}
          </button>
        </div>
      </Section>
    </div>
  )
}
