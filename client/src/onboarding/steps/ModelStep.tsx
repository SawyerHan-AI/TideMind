import { useTranslation } from 'react-i18next'
import { StepContainer } from '../components/StepContainer'
import { ModelConnection } from '../../components/settings/ModelConnection'

// 配置检测轮询已上移到 OnboardingProvider，步骤组件只读渲染即可
export function ModelStep() {
  const { t } = useTranslation('onboarding')

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
