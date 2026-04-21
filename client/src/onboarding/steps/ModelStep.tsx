import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboarding } from '../OnboardingContext'
import { StepContainer } from '../components/StepContainer'
import { ModelConnection } from '../../components/settings/ModelConnection'

export function ModelStep() {
  const { t } = useTranslation('onboarding')
  const { setModelConfigured } = useOnboarding()

  // 轮询检测是否有 online 的连接（页面隐藏时暂停，避免无效请求）
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      if (document.visibilityState !== 'visible') return
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
