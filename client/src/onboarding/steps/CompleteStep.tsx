import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { CheckCircle, SkipForward, Cpu, Plug, BookOpen, Palette } from 'lucide-react'
import { useOnboarding } from '../OnboardingContext'

export function CompleteStep() {
  const { t } = useTranslation('onboarding')
  const { modelConfigured, agentConfigured, noteSourceConfigured, finish, goBack } = useOnboarding()

  const items = [
    { label: t('complete.preferencesLabel'), done: true, Icon: Palette },
    { label: t('complete.modelLabel'), done: modelConfigured, Icon: Cpu },
    { label: t('complete.agentLabel'), done: agentConfigured, Icon: Plug },
    { label: t('complete.noteSourceLabel'), done: noteSourceConfigured, Icon: BookOpen },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="max-w-md mx-auto text-center"
    >
      <h1 className="text-2xl font-semibold text-white mb-2">{t('complete.title')}</h1>
      <p className="text-sm text-gray-400 mb-8">{t('complete.subtitle')}</p>

      <div className="glass-card rounded-2xl p-5 mb-8 text-left space-y-3">
        {items.map(({ label, done, Icon }) => (
          <div key={label} className="flex items-center gap-3">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                done ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.04] text-gray-500'
              }`}
            >
              <Icon size={14} />
            </div>
            <span className="text-sm text-white flex-1">{label}</span>
            {done ? (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <CheckCircle size={12} />
                {t('complete.configured')}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <SkipForward size={12} />
                {t('complete.skipped')}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={goBack}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          {t('nav.back')}
        </button>
        <button
          onClick={finish}
          className="px-8 py-3 text-sm font-medium text-white rounded-xl transition-all duration-200 hover:brightness-110 hover:scale-[1.02]"
          style={{
            background: 'linear-gradient(135deg, #818cf8, #a78bfa)',
            boxShadow: '0 4px 20px rgba(129,140,248,0.3)',
          }}
        >
          {t('complete.enter')}
        </button>
      </div>
    </motion.div>
  )
}
