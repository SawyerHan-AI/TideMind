import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react'
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
                  {t('model.serviceStatus.statusPaused', '熔断中（剩余 {{min}} 分钟）', {
                    min: Math.max(0, Math.ceil(((health.openedAt + health.cooldownMs) - Date.now()) / 60_000)),
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
