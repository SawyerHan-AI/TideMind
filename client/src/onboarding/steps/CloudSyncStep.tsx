import { useTranslation } from 'react-i18next'
import { Cloud, Monitor, MessageCircle, Zap } from 'lucide-react'
import { StepContainer } from '../components/StepContainer'

export function CloudSyncStep() {
  const { t } = useTranslation('onboarding')

  const benefits = [
    { Icon: Monitor, text: t('cloudSync.benefitDevices', 'Sync across all your devices') },
    { Icon: MessageCircle, text: t('cloudSync.benefitChatGPT', 'ChatGPT integration via browser extension') },
    { Icon: Zap, text: t('cloudSync.benefitMetabolism', 'Never-stop background metabolism') },
  ]

  return (
    <StepContainer
      title={t('cloudSync.title')}
      description={t('cloudSync.description')}
      skippable
    >
      <div className="space-y-6">
        {/* Benefits list */}
        <div className="space-y-3">
          {benefits.map(({ Icon, text }) => (
            <div key={text} className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(129,140,248,0.12)' }}
              >
                <Icon size={14} className="text-indigo-400" />
              </div>
              <span className="text-sm text-gray-300">{text}</span>
            </div>
          ))}
        </div>

        {/* Cloud icon hero */}
        <div className="flex justify-center py-4">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center"
            style={{
              background: 'rgba(129,140,248,0.08)',
              border: '1px solid rgba(129,140,248,0.15)',
              boxShadow: '0 8px 40px rgba(129,140,248,0.1)',
            }}
          >
            <Cloud size={32} className="text-indigo-400" />
          </div>
        </div>

        {/* Info text */}
        <p className="text-xs text-gray-500 text-center leading-relaxed">
          {t('cloudSync.info', 'Cloud sync is optional. Your local brain works perfectly on its own. You can connect to the cloud anytime in Settings.')}
        </p>
      </div>
    </StepContainer>
  )
}
