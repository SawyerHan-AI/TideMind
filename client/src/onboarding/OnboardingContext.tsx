import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
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

  // 统一的配置检测轮询（原来每个 Step 独立 3s 轮询 → 3 倍 IPC）
  // 现在：一个 10s 周期覆盖 model/agent/noteSource；页面隐藏时自动暂停。
  // 步骤切换不会重建这个 effect，因此 IPC 频率跟当前 step 无关。
  const pollingRef = useRef({ modelConfigured, agentConfigured, noteSourceConfigured })
  pollingRef.current = { modelConfigured, agentConfigured, noteSourceConfigured }
  useEffect(() => {
    let cancelled = false
    const api = (window as any).api
    if (!api) return

    const checkAll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const [connections, agents, sources] = await Promise.all([
          api.connections?.list(false).catch(() => []),
          api.agents?.list(false).catch(() => []),
          api.noteSources?.list(false).catch(() => []),
        ])
        if (cancelled) return
        const hasOnline = Array.isArray(connections) && connections.some(
          (c: any) => c.status === 'online' && !c.archived,
        )
        const hasAgents = Array.isArray(agents) && agents.length > 0
        const hasNoteSources = Array.isArray(sources) && sources.length > 0
        // 避免每 tick 都触发 re-render：只在值真变时 setState
        if (pollingRef.current.modelConfigured !== hasOnline) setModelConfigured(hasOnline)
        if (pollingRef.current.agentConfigured !== hasAgents) setAgentConfigured(hasAgents)
        if (pollingRef.current.noteSourceConfigured !== hasNoteSources) setNoteSourceConfigured(hasNoteSources)
      } catch { /* ignore */ }
    }

    checkAll()
    const timer = setInterval(checkAll, 10_000)
    // visibility 变 visible 时立即触发一次，用户回到 app 时不用等 10s
    const onVis = () => { if (document.visibilityState === 'visible') checkAll() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

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
