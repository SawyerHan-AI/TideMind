import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { useOnboarding, STEP_KEYS } from '../OnboardingContext'

export function StepIndicator() {
  const { currentStep } = useOnboarding()
  const { t } = useTranslation('onboarding')

  return (
    <div className="flex items-center justify-center gap-1">
      {STEP_KEYS.map((key, i) => {
        const isActive = i === currentStep
        const isDone = i < currentStep
        return (
          <div key={key} className="flex items-center gap-1">
            {i > 0 && (
              <div
                className={`w-6 h-px transition-colors duration-300 ${
                  isDone ? 'bg-indigo-400/60' : 'bg-white/10'
                }`}
              />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium transition-all duration-300 ${
                  isActive
                    ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30'
                    : isDone
                      ? 'bg-indigo-400/20 text-indigo-400'
                      : 'bg-white/[0.06] text-gray-500'
                }`}
              >
                {isDone ? <Check size={10} /> : i + 1}
              </div>
              <span
                className={`text-[11px] transition-colors duration-300 hidden sm:inline ${
                  isActive ? 'text-white font-medium' : isDone ? 'text-gray-400' : 'text-gray-600'
                }`}
              >
                {t(`steps.${key}`)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
