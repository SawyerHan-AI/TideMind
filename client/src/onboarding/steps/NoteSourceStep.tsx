import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboarding } from '../OnboardingContext'
import { StepContainer } from '../components/StepContainer'
import { NoteSync } from '../../components/settings/NoteSync'

export function NoteSourceStep() {
  const { t } = useTranslation('onboarding')
  const { setNoteSourceConfigured } = useOnboarding()

  // 轮询检测是否有笔记源（页面隐藏时暂停，避免无效请求）
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const sources = await (window as any).api.noteSources.list(false)
        if (!cancelled) setNoteSourceConfigured(sources?.length > 0)
      } catch { /* ignore */ }
    }
    check()
    const timer = setInterval(check, 3000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [setNoteSourceConfigured])

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
