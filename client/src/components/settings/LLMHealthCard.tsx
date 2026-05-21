import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, Clock, Loader2, RotateCw } from 'lucide-react'
import { Section } from './shared'
import type { LLMHealthSnapshot } from '../../lib/api-contract'

/**
 * AI 服务状态卡片 — 设置页诊断
 *
 * 显示：上次成功调用时间、当前熔断器状态 + 冷却剩余、最近一条错误摘要。
 * 不在此处提供"测试连接"按钮（"模型连接"卡片每条连接已自带，更精确）。
 */
export function LLMHealthCard() {
  const { t, i18n } = useTranslation('settings')
  const [health, setHealth] = useState<LLMHealthSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  // "立即重试" 按钮状态:
  //   - retrying: IPC 调用进行中,按钮 disabled + spinner
  //   - retryDebounce: 防抖 5 秒,避免狂点打死 quota
  //   - retryFeedback: 'success' | 'error' | null,刚点完显示反馈,3 秒后自动消失
  const [retrying, setRetrying] = useState(false)
  const [retryDebounce, setRetryDebounce] = useState(false)
  const [retryFeedback, setRetryFeedback] = useState<'success' | 'error' | null>(null)
  const retryFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // tick 触发 1 Hz 倒计时刷新(只在熔断中需要,避免无意义重渲)
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const h = await window.api.llm.getHealth()
        if (!cancelled) { setHealth(h); setLoading(false) }
      } catch { if (!cancelled) setLoading(false) }
    }
    fetchOnce()
    const unsubscribe = window.api.llm.onHealthChanged((h) => setHealth(h))
    const timer = setInterval(fetchOnce, 30_000)
    return () => { cancelled = true; clearInterval(timer); unsubscribe() }
  }, [])

  // 熔断中时启动 1 Hz 倒计时(每秒强制重渲,让"剩余 N:NN"实时刷新)。
  // 非熔断状态不跑 timer,避免 settings 页常驻 1 Hz 渲染浪费。
  useEffect(() => {
    if (health?.circuitState !== 'open') return
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [health?.circuitState])

  // 卸载时清掉 feedback timer
  useEffect(() => () => {
    if (retryFeedbackTimer.current) clearTimeout(retryFeedbackTimer.current)
  }, [])

  const handleRetry = async () => {
    if (retrying || retryDebounce) return
    setRetrying(true)
    setRetryFeedback(null)
    try {
      const newSnapshot = await window.api.llm.resetAndRetry()
      setHealth(newSnapshot)
      setRetryFeedback('success')
    } catch {
      setRetryFeedback('error')
    } finally {
      setRetrying(false)
      // debounce 5 秒,避免用户狂点打死 quota
      setRetryDebounce(true)
      setTimeout(() => setRetryDebounce(false), 5_000)
      // feedback 3 秒后消失
      if (retryFeedbackTimer.current) clearTimeout(retryFeedbackTimer.current)
      retryFeedbackTimer.current = setTimeout(() => setRetryFeedback(null), 3_000)
    }
  }

  // 计算冷却剩余(秒)。openedAt=0 表示未开过熔断。
  const remainingMs = health && health.openedAt > 0
    ? Math.max(0, (health.openedAt + health.cooldownMs) - Date.now())
    : 0
  const remainingSec = Math.ceil(remainingMs / 1000)
  const remainingMin = Math.floor(remainingSec / 60)
  const remainingSecOfMin = remainingSec % 60
  const cooldownText = remainingMin > 0
    ? `${remainingMin}:${String(remainingSecOfMin).padStart(2, '0')}`
    : `0:${String(remainingSecOfMin).padStart(2, '0')}`

  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' })
  const formatRelative = (ts: number): string => {
    if (!ts || ts <= 0) return t('model.serviceStatus.never', '从未')
    const diffMs = Date.now() - ts
    const diffSec = Math.round(diffMs / 1000)
    if (diffSec < 60) return rtf.format(-diffSec, 'second')
    const diffMin = Math.round(diffSec / 60)
    if (diffMin < 60) return rtf.format(-diffMin, 'minute')
    const diffHour = Math.round(diffMin / 60)
    if (diffHour < 24) return rtf.format(-diffHour, 'hour')
    const diffDay = Math.round(diffHour / 24)
    return rtf.format(-diffDay, 'day')
  }

  return (
    <Section title={t('model.serviceStatus.title', 'AI 服务状态')}>
      {loading || !health ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" />
          {t('common:loading', 'Loading...')}
        </div>
      ) : (
        <div className="space-y-3">
          {/* 当前状态 */}
          <Row
            label={t('model.serviceStatus.currentStatus', '当前状态')}
            value={
              health.circuitState === 'open' ? (
                <span className="flex items-center gap-1.5 text-red-300">
                  <AlertCircle size={12} />
                  {/* 倒计时显示到秒(分:秒),让用户知道 UI 没卡 + 看到熔断窗口正在 tick */}
                  {t('model.serviceStatus.statusPausedCountdown', '熔断中（剩余 {{time}}）', {
                    time: cooldownText,
                  })}
                </span>
              ) : health.failures > 0 ? (
                <span className="flex items-center gap-1.5 text-amber-300">
                  <AlertCircle size={12} />
                  {t('model.serviceStatus.statusDegraded', '近期失败 {{count}} 次', { count: health.failures })}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-emerald-300">
                  <CheckCircle2 size={12} />
                  {t('model.serviceStatus.statusHealthy', '正常')}
                </span>
              )
            }
          />

          {/* 立即重试按钮 — 只在熔断中或有失败时显示 */}
          {(health.circuitState === 'open' || health.failures > 0) && (
            <div className="flex items-center justify-end gap-3">
              {retryFeedback === 'success' && (
                <span className="text-xs text-emerald-300">
                  {t('model.serviceStatus.retrySuccess', '已重置熔断状态')}
                </span>
              )}
              {retryFeedback === 'error' && (
                <span className="text-xs text-red-300">
                  {t('model.serviceStatus.retryError', '重试失败')}
                </span>
              )}
              <button
                type="button"
                onClick={handleRetry}
                disabled={retrying || retryDebounce}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-emerald-600/20 hover:bg-emerald-600/30 disabled:bg-gray-700/30 disabled:cursor-not-allowed text-emerald-200 transition-colors"
                title={retryDebounce && !retrying ? t('model.serviceStatus.retryDebounceHint', '请稍候再试') as string : undefined}
              >
                {retrying ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCw size={12} />
                )}
                {t('model.serviceStatus.retryNow', '立即重试')}
              </button>
            </div>
          )}

          {/* 上次成功 */}
          <Row
            label={t('model.serviceStatus.lastSuccess', '上次成功调用')}
            value={
              <span className="flex items-center gap-1.5 text-gray-300">
                <Clock size={12} />
                {formatRelative(health.lastSuccessAt)}
              </span>
            }
          />

          {/* 上次错误 */}
          {health.lastError && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500">
                {t('model.serviceStatus.lastError', '上次错误')}
                <span className="ml-2 text-gray-600">({formatRelative(health.lastErrorAt)})</span>
              </p>
              <p className="text-[10px] text-red-300/70 font-mono break-all bg-red-950/20 px-2 py-1.5 rounded">
                {health.lastError}
              </p>
            </div>
          )}

          {/* 提示链接到模型连接卡片 */}
          <p className="text-[11px] text-gray-500 pt-1">
            {t('model.serviceStatus.hint', '如需排查或测试连接，请到下方"模型连接"分别测试每个 provider。')}
          </p>
        </div>
      )}
    </Section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-gray-500 flex-shrink-0">{label}</span>
      <span className="text-xs">{value}</span>
    </div>
  )
}
