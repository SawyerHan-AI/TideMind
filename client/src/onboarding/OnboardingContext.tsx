import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

export interface OnboardingState {
  currentStep: number
  modelConfigured: boolean
  agentConfigured: boolean
  noteSourceConfigured: boolean
}

interface OnboardingContextValue extends OnboardingState {
  totalSteps: number
  goNext: () => void
  goBack: () => void
  goTo: (step: number) => void
  setModelConfigured: (v: boolean) => void
  setAgentConfigured: (v: boolean) => void
  setNoteSourceConfigured: (v: boolean) => void
  finish: () => Promise<void>
}

const OnboardingCtx = createContext<OnboardingContextValue | null>(null)

export const STEP_KEYS = ['welcome', 'preferences', 'model', 'agent', 'noteSource', 'cloudSync', 'complete'] as const
export type StepKey = (typeof STEP_KEYS)[number]

export function OnboardingProvider({ children, onFinish }: { children: ReactNode; onFinish: () => void }) {
  const [currentStep, setCurrentStep] = useState(0)
  const [modelConfigured, setModelConfigured] = useState(false)
  const [agentConfigured, setAgentConfigured] = useState(false)
  const [noteSourceConfigured, setNoteSourceConfigured] = useState(false)
  const navigate = useNavigate()

  const totalSteps = STEP_KEYS.length

  const goNext = useCallback(() => setCurrentStep(s => Math.min(s + 1, totalSteps - 1)), [totalSteps])
  const goBack = useCallback(() => setCurrentStep(s => Math.max(s - 1, 0)), [])
  const goTo = useCallback((step: number) => setCurrentStep(step), [])

  const finish = useCallback(async () => {
    try {
      await window.api.config.update({ onboarding_completed: true })
    } catch { /* config 写入失败不阻塞进入主界面 */ }
    onFinish()
    navigate('/')
  }, [onFinish, navigate])

  return (
    <OnboardingCtx.Provider
      value={{
        currentStep,
        totalSteps,
        modelConfigured,
        agentConfigured,
        noteSourceConfigured,
        goNext,
        goBack,
        goTo,
        setModelConfigured,
        setAgentConfigured,
        setNoteSourceConfigured,
        finish,
      }}
    >
      {children}
    </OnboardingCtx.Provider>
  )
}

export function useOnboarding() {
  const ctx = useContext(OnboardingCtx)
  if (!ctx) throw new Error('useOnboarding must be used inside OnboardingProvider')
  return ctx
}
