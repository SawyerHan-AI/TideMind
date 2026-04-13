import { useTranslation } from 'react-i18next'
import { useIPC } from '../../hooks/useIPC'
import { Section } from './shared'

// ============================================================
// About Section: version, user info
// ============================================================

export function AboutSection() {
  const { t } = useTranslation('settings')
  const { data: config } = useIPC(() => window.api.config.get())

  const userName = (config as any)?.user?.name ?? '-'

  return (
    <div className="max-w-lg space-y-4">
      <Section title="Tide Mind">
        <div className="space-y-3 text-xs text-gray-400">
          <div className="flex items-center">
            {t('about.version')}
            <span className="text-gray-200 ml-2">0.1.0</span>
          </div>
          <div className="flex items-center">
            {t('about.user')}
            <span className="text-gray-200 ml-2">{userName}</span>
          </div>
        </div>
      </Section>
    </div>
  )
}
