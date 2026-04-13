import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboarding } from '../OnboardingContext'
import { StepContainer } from '../components/StepContainer'
import { ModelConnection } from '../../components/settings/ModelConnection'

export function ModelStep() {
  const { t } = useTranslation('onboarding')
  const { setModelConfigured } = useOnboarding()

  // 轮询检测是否有 online 的连接
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const connections = await window.api.connections.list(false)
        const hasOnline = connections?.some(
          (c: any) => c.status === 'online' && !c.archived
        )
        if (!cancelled) setModelConfigured(!!hasOnline)
      } catch { /* ignore */ }
    }
    check()
    const timer = setInterval(check, 3000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [setModelConfigured])

  return (
    <StepContainer
      title={t('model.title')}
      description={t('model.description')}
      skippable
      skipWarning={t('model.skipWarning')}
    >
      <ModelConnection />
    </StepContainer>
  )
}
