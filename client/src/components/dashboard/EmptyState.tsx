import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Settings } from 'lucide-react'
import logoSrc from '../../assets/logo@2x.png'

/**
 * Dashboard 空状态
 *
 * 当记忆总量为 0 时显示，替代 SystemPulse / RecentActivity / Discoveries / RecentTags。
 */
export function EmptyState() {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center text-center py-20">
      <img
        src={logoSrc}
        alt="Tide Mind"
        className="w-16 h-16 rounded-2xl mb-6 opacity-70"
      />

      <h2 className="text-lg font-medium text-white mb-2">{t('empty.title')}</h2>
      <p className="text-sm text-gray-500 max-w-sm mb-8 leading-relaxed">{t('empty.description')}</p>

      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 rounded-xl border border-white/10 hover:border-white/20 hover:text-white transition-all"
          style={{ background: 'var(--theme-glass-bg)' }}
        >
          <Settings size={14} />
          {t('empty.settings')}
        </button>
      </div>
    </div>
  )
}
