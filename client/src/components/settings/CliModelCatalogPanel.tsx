import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from 'lucide-react'
import type {
  ConnectionModelsView,
  ModelAdmissionDto,
  ModelObservationDto,
} from '../../lib/api-contract'

/**
 * 模型对接：CLI 连接的模型目录、账号范围、在用路由与按模型调用观察。
 *
 * 设计 §5–§7：发现 ≠ 可调用 ≠ 最近成功；测试只针对用户明确选中的目标，
 * 不自动全测；历史观察标注其当时的账号 epoch，不冒充当前验证。
 */

const FOLLOW_DEFAULT = 'default'

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return '—'
  return new Date(time).toLocaleString()
}

export function admissionLabelKey(admission: ModelAdmissionDto): string {
  if (admission.allowed) {
    return admission.firstCall ? 'model.catalog.admission.firstCall' : 'model.catalog.admission.allowed'
  }
  return `model.catalog.admission.${admission.reason}`
}

function outcomeTone(outcome: ModelObservationDto['lastOutcome']): string {
  if (outcome === 'success') return 'text-emerald-400'
  if (outcome === 'temporary_failure') return 'text-amber-400'
  return 'text-red-400'
}

export function CliModelCatalogPanel({
  connectionId,
  busy,
  refreshKey,
  onTest,
}: {
  connectionId: string
  busy: boolean
  /** Changes whenever the parent finished a check/test so the view is reloaded. */
  refreshKey: number
  onTest: (models: string[]) => void
}) {
  const { t } = useTranslation('settings')
  const [view, setView] = useState<ConnectionModelsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<string[]>([])
  const [showHistory, setShowHistory] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await window.api.connections.models(connectionId)
      setView(next)
      setLoadError(null)
      return next
    } catch (error) {
      setLoadError((error as Error).message)
      return null
    }
  }, [connectionId])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const result = await window.api.connections.refreshModels(connectionId)
      if (result.error) setRefreshError(result.error.message)
      else if (result.catalog?.status === 'failed') {
        setRefreshError(t('model.catalog.refreshFailed', { kind: result.catalog.errorKind ?? 'unknown' }))
      }
    } catch (error) {
      setRefreshError((error as Error).message)
    } finally {
      setRefreshing(false)
      void load()
    }
  }, [connectionId, load, t])

  useEffect(() => {
    let cancelled = false
    void load().then(next => {
      // Opening the settings shows the cache immediately; a stale catalog is
      // refreshed asynchronously (metadata only, never a model call).
      if (!cancelled && next && next.catalogStale && next.binding && !busy) void refresh()
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, refreshKey])

  // Default test target (design §6): the single in-use model, else the CLI default.
  useEffect(() => {
    if (!view) return
    const inUse = [...new Set(view.inUse.map(route => route.modelId))]
    setSelectedTargets(current => {
      if (current.length > 0) return current
      if (inUse.length === 1) return inUse
      if (inUse.length === 0) return [FOLLOW_DEFAULT]
      return []
    })
  }, [view])

  const catalogItems = useMemo(
    () => (view?.catalog?.items ?? []).filter(item => !item.hidden),
    [view],
  )
  const verifiedCount = useMemo(
    () => new Set((view?.observations ?? [])
      .filter(item => item.lastOutcome === 'success')
      .map(item => item.modelId)).size,
    [view],
  )
  const targetOptions = useMemo(() => {
    const options = new Map<string, string>()
    options.set(FOLLOW_DEFAULT, t('model.selection.followDefault'))
    for (const route of view?.inUse ?? []) options.set(route.modelId, route.modelId)
    for (const item of catalogItems) if (!options.has(item.id)) options.set(item.id, item.displayName)
    return [...options.entries()]
  }, [view, catalogItems, t])

  if (loadError) {
    return <p className="text-[11px] text-red-400">{loadError}</p>
  }
  if (!view) {
    return <Loader2 size={12} className="animate-spin text-gray-500" />
  }

  const toggleTarget = (model: string) => {
    setSelectedTargets(current => current.includes(model)
      ? current.filter(item => item !== model)
      : current.length >= 10 ? current : [...current, model])
  }
  const catalog = view.catalog
  const scopeUnknown = view.binding?.scopeState === 'unknown'

  return (
    <div className="space-y-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
      {/* 账号范围 */}
      <div className="flex items-start justify-between gap-3 text-[11px]">
        <span className="text-gray-400">{t('model.catalog.scope')}</span>
        <span className={scopeUnknown ? 'text-amber-300' : 'text-gray-300'}>
          {!view.binding
            ? t('model.catalog.scopeNotChecked')
            : scopeUnknown
              ? t('model.catalog.scopeUnknown')
              : t('model.catalog.scopeKnown')}
        </span>
      </div>

      {/* 模型目录 */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3 text-[11px]">
          <span className="text-gray-400">{t('model.catalog.title')}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || busy}
            className="flex items-center gap-1 text-gray-400 hover:text-gray-200 disabled:opacity-40"
          >
            {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            {t('model.catalog.refresh')}
          </button>
        </div>
        <p className="text-[11px] text-gray-300">
          {!catalog
            ? t('model.catalog.none')
            : catalog.source === 'unsupported'
              ? t('model.catalog.unsupported')
              : catalog.source === 'claude_aliases'
                ? t('model.catalog.aliasesOnly', { count: catalogItems.length, verified: verifiedCount })
                : t('model.catalog.summary', { count: catalogItems.length, verified: verifiedCount })}
        </p>
        {catalog && (
          <p className={`text-[10px] ${view.catalogOutdated ? 'text-amber-400' : 'text-gray-500'}`}>
            {t('model.catalog.updatedAt', { time: formatTime(catalog.fetchedAt) })}
            {view.catalogOutdated && ` · ${t('model.catalog.outdated')}`}
          </p>
        )}
        {catalog?.lastAttemptErrorKind && (
          <p className="text-[10px] text-amber-400">
            {t('model.catalog.lastAttemptFailed', {
              time: formatTime(catalog.lastAttemptAt),
              kind: catalog.lastAttemptErrorKind,
            })}
          </p>
        )}
        {refreshError && <p className="text-[10px] text-red-400">{refreshError}</p>}
      </div>

      {/* 在用路由 */}
      <div className="space-y-1">
        <span className="text-[11px] text-gray-400">{t('model.catalog.inUse')}</span>
        {view.inUse.length === 0 ? (
          <p className="text-[11px] text-gray-500">{t('model.catalog.inUseNone')}</p>
        ) : view.inUse.map(route => (
          <div key={route.tier} className="flex items-center justify-between gap-3 text-[11px]">
            <span className="text-gray-300">
              {t(`model.catalog.tier.${route.tier}`)} · {route.modelId === FOLLOW_DEFAULT
                ? t('model.selection.followDefault')
                : route.modelId}
              {route.observation?.actualModel && route.modelId !== route.observation.actualModel && (
                <span className="text-gray-500"> → {route.observation.actualModel}</span>
              )}
            </span>
            <span className={route.admission.allowed ? 'text-gray-400' : 'text-amber-300'}>
              {t(admissionLabelKey(route.admission), {
                time: formatTime(route.observation?.lastSuccessAt),
                retryAt: formatTime(!route.admission.allowed ? route.admission.retryAt : null),
              })}
            </span>
          </div>
        ))}
      </div>

      {/* 测试指定模型 */}
      <div className="space-y-1.5">
        <span className="text-[11px] text-gray-400">{t('model.catalog.testTargets')}</span>
        {scopeUnknown && (
          <p className="flex items-center gap-1 text-[10px] text-amber-300">
            <AlertTriangle size={10} /> {t('model.catalog.testScopeUnknownNote')}
          </p>
        )}
        {selectedTargets.includes(FOLLOW_DEFAULT) && (
          <p className="text-[10px] text-gray-500">{t('model.selection.isolatedDefaultHint')}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {targetOptions.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => toggleTarget(id)}
              disabled={busy}
              className={`rounded-md border px-2 py-0.5 text-[10px] ${
                selectedTargets.includes(id)
                  ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-200'
                  : 'border-white/10 text-gray-400 hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] text-gray-500">
            {t('model.catalog.testCostNote', { count: selectedTargets.length })}
          </p>
          <button
            type="button"
            onClick={() => onTest(selectedTargets)}
            disabled={busy || selectedTargets.length === 0}
            className="px-2.5 py-1 text-[11px] bg-white/5 hover:bg-white/10 rounded-md text-gray-300 disabled:opacity-40"
          >
            {t('model.catalog.testSelected')}
          </button>
        </div>
      </div>

      {/* 当前 epoch 的调用观察 */}
      {view.observations.length > 0 && (
        <div className="space-y-1">
          <span className="text-[11px] text-gray-400">{t('model.catalog.observations')}</span>
          {view.observations.map(item => (
            <ObservationRow key={`${item.authEpoch}:${item.modelId}`} item={item} />
          ))}
        </div>
      )}
      {view.history.length > 0 && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setShowHistory(value => !value)}
            className="text-[10px] text-gray-500 hover:text-gray-300"
          >
            {showHistory ? t('model.catalog.hideHistory') : t('model.catalog.showHistory', { count: view.history.length })}
          </button>
          {showHistory && view.history.map(item => (
            <ObservationRow key={`${item.scopeKey}:${item.authEpoch}:${item.modelId}`} item={item} historical />
          ))}
        </div>
      )}
    </div>
  )
}

function ObservationRow({ item, historical = false }: { item: ModelObservationDto; historical?: boolean }) {
  const { t } = useTranslation('settings')
  const Icon = item.lastOutcome === 'success'
    ? CheckCircle2
    : item.lastOutcome === 'temporary_failure' ? Clock : XCircle
  return (
    <div className={`flex items-start justify-between gap-3 text-[10px] ${historical ? 'opacity-60' : ''}`}>
      <span className="flex items-center gap-1 text-gray-300">
        <Icon size={10} className={outcomeTone(item.lastOutcome)} />
        {item.modelId === FOLLOW_DEFAULT ? t('model.selection.followDefault') : item.modelId}
        {item.actualModel && item.actualModel !== item.modelId && (
          <span className="text-gray-500">→ {item.actualModel}</span>
        )}
      </span>
      <span className={`text-right ${outcomeTone(item.lastOutcome)}`}>
        {t(`model.catalog.outcome.${item.lastOutcome}`)}
        {' · '}
        {t(`model.catalog.source.${item.lastSource}`)}
        {' · '}
        {formatTime(item.updatedAt)}
        {historical && ` · ${t('model.catalog.historicalEpoch', { epoch: item.authEpoch })}`}
      </span>
    </div>
  )
}
