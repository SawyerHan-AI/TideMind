import { type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { useOnboarding } from '../OnboardingContext'
import { AlertTriangle } from 'lucide-react'

interface StepContainerProps {
  title: string
  description?: string
  children: ReactNode
  /** 显示跳过按钮（可跳过的步骤） */
  skippable?: boolean
  /** 跳过时的警告文案 */
  skipWarning?: string
  /** 隐藏底部导航（欢迎页/完成页自己管理按钮） */
  hideNav?: boolean
  /** 自定义下一步按钮文案 */
  nextLabel?: string
  /** 隐藏返回按钮 */
  hideBack?: boolean
}

export function StepContainer({
  title,
  description,
  children,
  skippable,
  skipWarning,
  hideNav,
  nextLabel,
  hideBack,
}: StepContainerProps) {
  const { goNext, goBack, currentStep } = useOnboarding()
  const { t } = useTranslation('onboarding')

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      className="w-full max-w-3xl mx-auto"
    >
      {/* Header */}
      <div className="text-center mb-6">
        <h1 className="text-2xl font-semibold text-white mb-2">{title}</h1>
        {description && (
          <p className="text-sm text-gray-400 max-w-lg mx-auto leading-relaxed">{description}</p>
        )}
      </div>

      {/* Content */}
      <div className="glass-card rounded-2xl p-6 mb-4">{children}</div>

      {/* Navigation */}
      {!hideNav && (
        <div className="flex items-center justify-between">
          <div>
            {!hideBack && currentStep > 0 && (
              <button
                onClick={goBack}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                {t('nav.back')}
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            {skippable && (
              <button
                onClick={goNext}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
              >
                {t('nav.skip')}
              </button>
            )}
            <button
              onClick={goNext}
              className="px-5 py-2 text-sm font-medium text-white rounded-xl transition-all duration-200 hover:brightness-110"
              style={{ background: 'linear-gradient(135deg, #818cf8, #a78bfa)' }}
            >
              {nextLabel || t('nav.next')}
            </button>
          </div>
        </div>
      )}

      {/* Skip warning */}
      {skippable && skipWarning && (
        <div className="mt-3 flex items-start gap-2 px-1">
          <AlertTriangle size={13} className="text-amber-400/70 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-gray-500 leading-relaxed">{skipWarning}</p>
        </div>
      )}
    </motion.div>
  )
}
