import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, CheckCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

/**
 * 概览页初始化进度横幅
 *
 * 轮询所有已配置笔记源的初始化进度，
 * 只在有正在运行的初始化时显示。完成后短暂显示完成状态，然后消失。
 */
export function InitBanner() {
  const { t } = useTranslation('dashboard')
  const [progress, setProgress] = useState<{
    phase: number; phaseName: string; current: number; total: number; status: string
    sourceName?: string
  } | null>(null)
  const [visible, setVisible] = useState(false)
  const pollRef = useRef<NodeJS.Timeout | null>(null)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)
  const doneHandledRef = useRef(false)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      // done 已处理过，不再轮询
      if (doneHandledRef.current) return

      try {
        // 查询所有笔记源，找到正在初始化的
        const sources = await window.api.noteSources.list(false)
        if (cancelled) return
        let found = false

        for (const source of (sources ?? [])) {
          if (!source.id) continue
          const snap = await window.api.noteSources.initSnapshot(source.id)
          if (cancelled) return
          if (snap && (snap.status === 'running' || snap.status === 'done')) {
            const prog = { ...snap.progress, status: snap.status }
            setProgress({ ...prog, sourceName: source.name })
            setVisible(true)
            found = true
            if (prog.status === 'done') {
              doneHandledRef.current = true
              if (pollRef.current) {
                clearInterval(pollRef.current)
                pollRef.current = null
              }
              if (cancelled) return
              hideTimerRef.current = setTimeout(() => {
                hideTimerRef.current = null
                if (cancelled) return
                setVisible(false)
                // 隐藏后恢复轮询，以便检测新的初始化
                doneHandledRef.current = false
                pollRef.current = setInterval(poll, 3000)
              }, 10_000)
            }
            break // 同一时刻只有一个在初始化
          }
        }

        if (!found && !cancelled) setVisible(false)
      } catch {
        if (!cancelled) setVisible(false)
      }
    }

    poll()
    pollRef.current = setInterval(poll, 3000)
    return () => {
      cancelled = true
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [])

  if (!visible || !progress) return null

  const isDone = progress.status === 'done'
  const label = progress.sourceName ?? t('init.noteSource')

  return (
    <div
      className={`rounded-xl px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors ${
        isDone
          ? 'bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/15'
          : 'bg-indigo-400/10 border border-indigo-400/20 hover:bg-indigo-400/15'
      }`}
      onClick={() => navigate('/settings?tab=external&sub=note')}
    >
      {isDone
        ? <CheckCircle size={14} className="text-emerald-400 flex-shrink-0" />
        : <Loader2 size={14} className="text-indigo-400 animate-spin flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <div className="text-xs text-white">
          {isDone
            ? `${label} ${t('init.complete')}`
            : t('init.progress', { phase: progress.phase, phaseName: t(`init.phases.${progress.phase}`, { defaultValue: progress.phaseName }) })
          }
        </div>
      </div>
      {!isDone && progress.total > 0 && (
        <div className="w-24 bg-white/[0.06] rounded-full h-1.5 flex-shrink-0">
          <div
            className="bg-indigo-400 h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${Math.max(5, Math.round(((progress.current ?? 0) / progress.total) * 100))}%` }}
          />
        </div>
      )}
      <span className="text-[10px] text-gray-500 flex-shrink-0">{t('init.clickDetails')}</span>
    </div>
  )
}
