import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InitPreview, InitProgress, InitReport } from './types'

interface CreateAndPreviewArgs {
  name: string
  toolType: string
  path: string
}

interface UseAddNoteSourceInitializationArgs {
  onInitStep: () => void
  onCompleteStep: () => void
}

export function useAddNoteSourceInitialization({
  onInitStep,
  onCompleteStep,
}: UseAddNoteSourceInitializationArgs) {
  const { t } = useTranslation('settings')
  const [createdSourceId, setCreatedSourceId] = useState<string | null>(null)
  const [initPreview, setInitPreview] = useState<InitPreview | null>(null)
  const [initStarted, setInitStarted] = useState(false)
  const [initProgress, setInitProgress] = useState<InitProgress | null>(null)
  const [initReport, setInitReport] = useState<InitReport | null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [aborting, setAborting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  const clearProgressPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      cancelledRef.current = true
      clearProgressPoll()
    }
  }, [clearProgressPoll])

  const createAndPreview = useCallback(async ({
    name,
    toolType,
    path,
  }: CreateAndPreviewArgs) => {
    cancelledRef.current = false
    setInitPreview(null)
    setInitStarted(false)
    setInitProgress(null)
    setInitReport(null)
    setInitError(null)
    setAborting(false)
    clearProgressPoll()

    const source = await window.api.noteSources.create({
      name: name.trim(),
      toolType,
      path,
    })
    if (cancelledRef.current) return

    setCreatedSourceId(source.id)
    onInitStep()

    try {
      const res = await window.api.noteSources.initPreview(source.id)
      if (cancelledRef.current) return
      if (res.success) {
        setInitPreview(res.data ?? null)
      } else {
        setInitError(res.error ?? 'Preview failed')
      }
    } catch (err) {
      if (!cancelledRef.current) setInitError((err as Error).message)
    }
  }, [clearProgressPoll, onInitStep])

  const startInit = useCallback(async () => {
    if (!createdSourceId) return
    setInitStarted(true)
    setInitProgress({
      phase: 0,
      phaseName: t('noteSync.wizard.starting'),
      current: 0,
      total: 0,
      status: 'running',
    })

    clearProgressPoll()
    pollRef.current = setInterval(async () => {
      try {
        const progress = await window.api.noteSources.initProgress(createdSourceId)
        if (progress) {
          setInitProgress(progress)
          if (progress.status === 'error') {
            clearProgressPoll()
            setInitError(progress.error ?? t('noteSync.wizard.unknownError'))
          }
        }
      } catch (err) {
        console.error('轮询初始化进度失败:', err)
      }
    }, 2000)

    try {
      const res = await window.api.noteSources.initStart(createdSourceId)
      clearProgressPoll()
      if (cancelledRef.current) return

      if (res.success) {
        setInitReport(res.data ?? null)
        onCompleteStep()
      } else {
        setInitError(res.error ?? 'Initialization failed')
      }
    } catch (err) {
      clearProgressPoll()
      if (!cancelledRef.current) setInitError((err as Error).message)
    }
  }, [clearProgressPoll, createdSourceId, onCompleteStep, t])

  const handleAbort = useCallback(async () => {
    if (!createdSourceId) return
    setAborting(true)
    try {
      await window.api.noteSources.initAbort(createdSourceId)
      clearProgressPoll()
      setInitError(t('noteSync.wizard.aborted'))
    } finally {
      setAborting(false)
    }
  }, [clearProgressPoll, createdSourceId, t])

  const cleanupBeforeClose = useCallback(async (): Promise<boolean> => {
    if (initStarted && !initReport && !initError) {
      if (!confirm(t('noteSync.wizard.confirmAbort'))) return false
      cancelledRef.current = true
      if (createdSourceId) {
        await window.api.noteSources.initAbort(createdSourceId)
        await new Promise(r => setTimeout(r, 1000))
        await window.api.noteSources.rollback(createdSourceId)
      }
    } else if (createdSourceId && !initReport) {
      cancelledRef.current = true
      await window.api.noteSources.rollback(createdSourceId)
    } else {
      cancelledRef.current = true
    }

    clearProgressPoll()
    return true
  }, [clearProgressPoll, createdSourceId, initError, initReport, initStarted, t])

  return {
    createdSourceId,
    initPreview,
    initStarted,
    initProgress,
    initReport,
    initError,
    aborting,
    createAndPreview,
    startInit,
    handleAbort,
    cleanupBeforeClose,
  }
}
