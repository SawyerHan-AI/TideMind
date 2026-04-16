import { AnimatePresence } from 'framer-motion'
import { useOnboarding, STEP_KEYS } from './OnboardingContext'
import { StepIndicator } from './components/StepIndicator'
import { WelcomeStep } from './steps/WelcomeStep'
import { PreferencesStep } from './steps/PreferencesStep'
import { ModelStep } from './steps/ModelStep'
import { AgentStep } from './steps/AgentStep'
import { NoteSourceStep } from './steps/NoteSourceStep'
import { CloudSyncStep } from './steps/CloudSyncStep'
import { CompleteStep } from './steps/CompleteStep'

const STEP_COMPONENTS = {
  welcome: WelcomeStep,
  preferences: PreferencesStep,
  model: ModelStep,
  agent: AgentStep,
  noteSource: NoteSourceStep,
  cloudSync: CloudSyncStep,
  complete: CompleteStep,
} as const

export function OnboardingPage() {
  const { currentStep } = useOnboarding()
  const stepKey = STEP_KEYS[currentStep]
  const StepComponent = STEP_COMPONENTS[stepKey]

  const isEdge = stepKey === 'welcome' || stepKey === 'complete'

  return (
    <div
      className="h-screen flex flex-col"
      style={{
        background: [
          'radial-gradient(ellipse at 25% 15%, var(--theme-glow-1), transparent 55%)',
          'radial-gradient(ellipse at 78% 88%, var(--theme-glow-2), transparent 55%)',
          'var(--theme-bg)',
        ].join(', '),
      }}
    >
      {/* Drag region for Electron window */}
      <div className="drag-region h-8 w-full flex-shrink-0" />

      {/* Step indicator (hidden on welcome & complete) */}
      {!isEdge && (
        <div className="flex-shrink-0 px-6 py-3">
          <StepIndicator />
        </div>
      )}

      {/* Step content */}
      <div className={`flex-1 overflow-auto px-6 pb-8 flex items-center ${isEdge ? 'justify-center' : ''}`}>
        <div className="w-full">
          <AnimatePresence mode="wait">
            <StepComponent key={stepKey} />
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
