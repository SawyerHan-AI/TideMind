import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { LLMHealthSnapshot } from '../../lib/api-contract'

type Severity = 'hidden' | 'warning' | 'error'

const IDLE_WARN_MS = 24 * 60 * 60 * 1000 // 24h

interface Display {
  severity: Severity
  label: string
  /** 圆点 tailwind 类（动效 / 颜色） */
  dotClass: string
  /** 圆点 box-shadow */
  dotShadow: string
}

export function LLMHealthBadge() {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const [health, setHealth] = useState<LLMHealthSnapshot | null>(null)
  // F6: circuit open 时倒计时基于 Date.now() 计算,但组件本身不会主动 re-render,
  // 标签会冻结显示"X 分钟后重试"。加 1s tick 在 open 状态下推动 re-render。
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const h = await window.api.llm.getHealth()
        if (!cancelled) setHealth(h)
      } catch { /* main 进程没准备好就忽略 */ }
    }
    fetchOnce()
    // 推送订阅 + 30s 轮询兜底
    const unsubscribe = window.api.llm.onHealthChanged((h) => setHealth(h))
    const timer = setInterval(fetchOnce, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [])

  const activeError = health?.activeTask?.connectionId
    ? health.errors?.find(error => error.connectionId === health.activeTask?.connectionId)
    : null

  // F6:当前任务所用连接 open 时每秒 tick 一次,推动倒计时刷新。
  useEffect(() => {
    if (activeError?.circuitState !== 'open') return
    const t = setInterval(() => setTick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [activeError?.circuitState])

  if (!health) return null

  let display: Display = { severity: 'hidden', label: '', dotClass: '', dotShadow: '' }
  if (health.metabolismWorkerDegradedReason) {
    display = {
      severity: 'error',
      label: t('llmHealth.backgroundSchedulerUnavailable', { defaultValue: '后台记忆整理暂不可用' }),
      dotClass: 'bg-red-400 animate-pulse',
      dotShadow: '0 0 6px rgba(248,113,113,0.5)',
    }
  } else if (activeError?.circuitState === 'open') {
    const retryAt = activeError.retryAt
      ?? ((activeError.openedAt ?? 0) + (activeError.cooldownMs ?? 0))
    const remainingMs = Math.max(0, retryAt - Date.now())
    const min = Math.ceil(remainingMs / 60_000)
    display = {
      severity: 'error',
      label: t('llmHealth.paused', { min, defaultValue: 'AI 暂停中（{{min}} 分钟后重试）' }),
      dotClass: 'bg-red-400 animate-pulse',
      dotShadow: '0 0 6px rgba(248,113,113,0.5)',
    }
  } else if ((health.errors?.length ?? health.failures) > 0) {
    display = {
      severity: 'warning',
      label: t('llmHealth.recentFailures', { defaultValue: 'AI 近期有失败' }),
      dotClass: 'bg-amber-400',
      dotShadow: '0 0 6px rgba(251,191,36,0.4)',
    }
  } else if (health.lastSuccessAt > 0 && Date.now() - health.lastSuccessAt > IDLE_WARN_MS) {
    display = {
      severity: 'warning',
      label: t('llmHealth.idle', { defaultValue: 'AI 长时间无活动' }),
      dotClass: 'bg-amber-400',
      dotShadow: '0 0 6px rgba(251,191,36,0.4)',
    }
  }
  if (display.severity === 'hidden') return null

  return (
    <button
      type="button"
      onClick={() => navigate('/settings')}
      className="w-full px-4 py-1.5 flex items-center gap-2 min-h-[28px] hover:bg-white/[0.03] transition-colors text-left"
      title={display.label}
    >
      <div
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${display.dotClass}`}
        style={{ boxShadow: display.dotShadow }}
      />
      <span className="text-[10px] text-gray-500 truncate">{display.label}</span>
    </button>
  )
}
