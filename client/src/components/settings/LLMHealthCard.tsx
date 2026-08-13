import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, RotateCw } from 'lucide-react'
import type { LLMHealthSnapshot } from '../../lib/api-contract'
import { Section } from './shared'

export function LLMHealthCard() {
  const { t, i18n } = useTranslation('settings')
  const [health, setHealth] = useState<LLMHealthSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchHealth = async () => {
      try {
        const snapshot = await window.api.llm.getHealth()
        if (!cancelled) setHealth(snapshot)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchHealth()
    const unsubscribe = window.api.llm.onHealthChanged(snapshot => setHealth(snapshot))
    const timer = setInterval(fetchHealth, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [])

  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' })
  const formatRelative = (timestamp: number) => {
    if (!timestamp) return t('model.serviceStatus.never')
    const seconds = Math.round((Date.now() - timestamp) / 1000)
    if (seconds < 60) return rtf.format(-seconds, 'second')
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return rtf.format(-minutes, 'minute')
    const hours = Math.round(minutes / 60)
    return hours < 24 ? rtf.format(-hours, 'hour') : rtf.format(-Math.round(hours / 24), 'day')
  }

  const fallbackErrors: NonNullable<LLMHealthSnapshot['errors']> = health?.lastError ? [{
    connectionId: '',
    providerType: '',
    kind: 'legacy',
    message: health.lastError,
    needsUserAction: health.circuitState === 'open',
    occurredAt: health.lastErrorAt,
  }] : []
  const errors = [...(health?.errors ?? fallbackErrors)].sort((a, b) =>
    Number(b.needsUserAction) - Number(a.needsUserAction) || b.occurredAt - a.occurredAt,
  )
  const shownErrors = expanded ? errors : errors.slice(0, 3)
  const retryableKinds = new Set(['offline', 'timeout', 'quota', 'rate_limit', 'network', 'provider_error'])

  const reset = async (connectionId: string) => {
    setRetryingId(connectionId || 'legacy')
    try {
      setHealth(await window.api.llm.resetAndRetry(connectionId || undefined))
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <Section title={t('model.serviceStatus.title')}>
      {loading || !health ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" />
          {t('common:loading')}
        </div>
      ) : (
        <div className="space-y-3">
          {health.metabolismWorkerDegradedReason && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.08] px-3 py-2 text-xs text-red-300">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">
                  {t('model.serviceStatus.backgroundSchedulerUnavailable', { defaultValue: '后台记忆整理暂不可用' })}
                </div>
                <p className="mt-0.5 break-words text-[11px] text-red-300/80">
                  {health.metabolismWorkerDegradedReason}
                </p>
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <Metric label={t('model.serviceStatus.availableConnections')} value={String(health.availableCount ?? (health.circuitState === 'closed' ? 1 : 0))} />
            <Metric label={t('model.serviceStatus.needsAttention')} value={String(health.needsAttentionCount ?? errors.length)} warning={errors.length > 0} />
            <Metric label={t('model.serviceStatus.lastSuccess')} value={formatRelative(health.lastSuccessAt)} icon={<Clock size={11} />} />
          </div>

          {errors.length === 0 && !health.metabolismWorkerDegradedReason ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.07] px-3 py-2 text-xs text-emerald-300">
              <CheckCircle2 size={13} />
              {t('model.serviceStatus.statusHealthy')}
            </div>
          ) : (
            <div id="llm-health-errors" className="space-y-1.5">
              {shownErrors.map((error, index) => (
                <div key={`${error.connectionId}-${error.kind}-${index}`} className="rounded-lg border border-red-500/15 bg-red-500/[0.07] px-3 py-2">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={13} className="mt-0.5 shrink-0 text-red-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-gray-200">
                          {error.connectionName || error.providerType || t('model.serviceStatus.unknownConnection')}
                        </span>
                        <span className="text-[10px] text-gray-600">{formatRelative(error.occurredAt)}</span>
                      </div>
                      <p className="mt-0.5 break-words text-[11px] text-red-300">{error.message}</p>
                    </div>
                    {error.connectionId && retryableKinds.has(error.kind) && (
                      <button
                        type="button"
                        onClick={() => reset(error.connectionId)}
                        disabled={retryingId !== null}
                        className="shrink-0 flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-gray-400 hover:text-gray-200 disabled:opacity-50"
                      >
                        {retryingId === error.connectionId ? <Loader2 size={10} className="animate-spin" /> : <RotateCw size={10} />}
                        {t('model.serviceStatus.retryNow')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {errors.length > 3 && (
                <button
                  type="button"
                  onClick={() => setExpanded(value => !value)}
                  aria-expanded={expanded}
                  aria-controls="llm-health-errors"
                  className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300"
                >
                  {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {expanded ? t('model.serviceStatus.collapseErrors') : t('model.serviceStatus.expandErrors', { count: errors.length - 3 })}
                </button>
              )}
            </div>
          )}

          <p className="text-[11px] text-gray-500">{t('model.serviceStatus.hint')}</p>
        </div>
      )}
    </Section>
  )
}

function Metric({ label, value, warning = false, icon }: {
  label: string
  value: string
  warning?: boolean
  icon?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.025] px-3 py-2">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`mt-1 flex items-center gap-1.5 text-sm font-medium ${warning ? 'text-amber-300' : 'text-gray-200'}`}>
        {icon}{value}
      </div>
    </div>
  )
}
