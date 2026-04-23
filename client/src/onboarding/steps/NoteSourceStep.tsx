import { useTranslation } from 'react-i18next'
import { StepContainer } from '../components/StepContainer'
import { NoteSync } from '../../components/settings/NoteSync'

// 配置检测轮询已上移到 OnboardingProvider，步骤组件只读渲染即可
export function NoteSourceStep() {
  const { t } = useTranslation('onboarding')

  return (
    <StepContainer
      title={t('noteSource.title')}
      description={t('noteSource.description')}
      skippable
    >
      <NoteSync />
    </StepContainer>
  )
}
