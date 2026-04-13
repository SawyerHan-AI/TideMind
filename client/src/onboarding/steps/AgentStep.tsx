import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboarding } from '../OnboardingContext'
import { StepContainer } from '../components/StepContainer'
import { AgentIntegration } from '../../components/settings/AgentIntegration'

export function AgentStep() {
  const { t } = useTranslation('onboarding')
  const { setAgentConfigured } = useOnboarding()

  // 轮询检测是否有 Agent
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const agents = await (window as any).api.agents.list(false)
        if (!cancelled) setAgentConfigured(agents?.length > 0)
      } catch { /* ignore */ }
    }
    check()
    const timer = setInterval(check, 3000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [setAgentConfigured])

  return (
    <StepContainer
      title={t('agent.title')}
      description={t('agent.description')}
      skippable
    >
      <AgentIntegration />
    </StepContainer>
  )
}
