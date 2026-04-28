import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InitProgress, InitReport, NoteSource } from './types'

export type InitCardState = 'interrupted' | 'running' | 'complete' | 'error'

interface UseInitializingSourceArgs {
  source: NoteSource
  onRefetch: () => void
}

export function useInitializingSource({
  source,
  onRefetch,
}: UseInitializingSourceArgs) {
  const { t } = useTranslation('settings')
  const [state, setState] = useState<InitCardState>('interrupted')
  const [totalFiles, setTotalFiles] = useState<number | null>(null)
  const [syncedFiles, setSyncedFiles] = useState<number>(0)
  const [initProgress, setInitProgress] = useState<InitProgress | null>(null)
  const [initReport, setInitReport] = useState<InitReport | null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [aborting, setAborting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearProgressPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startProgressPoll = useCallback((mode: 'resume' | 'continue') => {
    clearProgressPoll()

    pollRef.current = setInterval(async () => {
      try {
        const progress = await window.api.noteSources.initProgress(source.id)
        if (progress && progress.status !== 'idle') {
          setInitProgress(progress)
          if (progress.status === 'done') {
            clearProgressPoll()
            if (mode === 'resume') onRefetch()
          }
          if (progress.status === 'error') {
            clearProgressPoll()
            setState('error')
            setInitError(progress.error ?? '')
          }
        } else if (progress && progress.status === 'idle' && mode === 'resume') {
          clearProgressPoll()
          onRefetch()
        }
      } catch { /* ignore */ }
    }, 2000)
  }, [clearProgressPoll, onRefetch, source.id])

  // mount 时获取总文件数、已同步数，并检查是否有正在进行的初始化
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const testResult = await window.api.noteSources.test(source.tool_type, source.path)
        if (!cancelled) setTotalFiles(testResult?.fileCount ?? null)
      } catch { /* ignore */ }
      try {
        const stats = await window.api.noteSources.stats(source.id)
        if (!cancelled) setSyncedFiles(stats?.fileCount ?? 0)
      } catch { /* ignore */ }
      // 检查是否有正在进行的初始化（如从概览页跳转过来）
      try {
        const progress = await window.api.noteSources.initProgress(source.id)
        if (cancelled) return
        if (progress && progress.status === 'running') {
          setState('running')
          setInitProgress(progress)
          startProgressPoll('resume')
        }
      } catch { /* ignore */ }
    }
    load()
    return () => {
      cancelled = true
      clearProgressPoll()
    }
  }, [clearProgressPoll, source.id, source.path, source.tool_type, startProgressPoll])

  // 清理轮询
  useEffect(() => {
    return () => clearProgressPoll()
  }, [clearProgressPoll])

  const handleContinue = useCallback(async () => {
    setState('running')
    setInitError(null)
    setInitProgress({
      phase: 0,
      phaseName: t('noteSync.wizard.starting'),
      current: 0,
      total: 0,
      status: 'running',
    })

    startProgressPoll('continue')

    try {
      const res = await window.api.noteSources.initStart(source.id)
      clearProgressPoll()
      if (res?.success) {
        setState('complete')
        setInitReport(res.data ?? null)
        setTimeout(() => onRefetch(), 3000)
      } else {
        setState('error')
        setInitError(res?.error ?? t('noteSync.wizard.unknownError'))
      }
    } catch (err) {
      clearProgressPoll()
      setState('error')
      setInitError((err as Error).message)
    }
  }, [clearProgressPoll, onRefetch, source.id, startProgressPoll, t])

  const handleAbort = useCallback(async () => {
    setAborting(true)
    try {
      await window.api.noteSources.initAbort(source.id)
    } finally {
      setAborting(false)
    }
  }, [source.id])

  const handleDiscard = useCallback(async () => {
    if (!confirm(t('noteSync.init.discardConfirm'))) return
    setDiscarding(true)
    try {
      await window.api.noteSources.rollback(source.id)
    } catch { /* ignore */ }
    finally {
      setDiscarding(false)
    }
    onRefetch()
  }, [onRefetch, source.id, t])

  const processedPct = useMemo(() => {
    return totalFiles && totalFiles > 0
      ? Math.round((syncedFiles / totalFiles) * 100)
      : 0
  }, [syncedFiles, totalFiles])

  const resetToInterrupted = useCallback(() => {
    setState('interrupted')
    setInitError(null)
  }, [])

  return {
    state,
    totalFiles,
    syncedFiles,
    processedPct,
    initProgress,
    initReport,
    initError,
    aborting,
    discarding,
    handleContinue,
    handleAbort,
    handleDiscard,
    resetToInterrupted,
  }
}
