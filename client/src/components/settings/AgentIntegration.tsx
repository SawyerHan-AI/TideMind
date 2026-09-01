import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  RefreshCw,
  Search,
  ServerOff,
  Sparkles,
  X,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import type {
  AgentIntegrationFamilyDto,
  AgentIntegrationApplyTaskDto,
  AgentIntegrationApplyTaskPageDto,
  AgentIntegrationInstallationDto,
  AgentIntegrationScanResultDto,
  AgentIntegrationSnapshotDto,
  AgentIntegrationSupportProductDto,
} from '../../lib/api-contract'
import { useIPC } from '../../hooks/useIPC'
import { useFormatters } from '../../hooks/useFormatters'
import { acquireModalInert } from '../../lib/modal-inert'
import { BatchConnectDialog } from './agent-integration-managed/BatchConnectDialog'
import { ManagedAgentDetail } from './agent-integration-managed/ManagedAgentDetail'
import { ManagedFamilyList } from './agent-integration-managed/ManagedFamilyList'
import {
  applyTaskProgressRefreshDelay,
  isStaleTaskFeedCursorError,
  isUnknownApplyTaskError,
  mergeApplyTaskProgress,
  partitionManageableInstallationIds,
  recoverVisibleApplyTask,
} from './agent-integration-managed/apply-task-presentation'
import {
  executionInstallationIds,
  matchesSupportQuery,
  summarizeExecutionResults,
  summarizeSnapshot,
} from './agent-integration-managed/presentation'
import { agentIntegrationsApi } from './agent-integration-managed/types'

function InitialSkeleton() {
  return (
    <div className="space-y-2 rounded-xl border border-white/[0.07] p-4" aria-hidden>
      {[0, 1, 2, 3].map(index => (
        <div key={index} className="grid grid-cols-[1.2fr_.8fr_.8fr_1.4fr] gap-3">
          {[0, 1, 2, 3].map(cell => <div key={cell} className="h-10 animate-pulse rounded bg-white/[0.04]" />)}
        </div>
      ))}
    </div>
  )
}

function historyFamily(installation: AgentIntegrationInstallationDto): AgentIntegrationFamilyDto {
  return {
    id: `history:${installation.id}`,
    displayName: installation.displayName,
    installationIds: [installation.id],
    statusGroup: installation.statusGroup,
    accessLevels: [installation.accessLevel],
    needsAttentionCount: 0,
    unreadEventCount: installation.unreadEventCount,
  }
}

function historyDetailSnapshot(
  snapshot: AgentIntegrationSnapshotDto,
  installation: AgentIntegrationInstallationDto,
): AgentIntegrationSnapshotDto {
  return {
    ...snapshot,
    families: [historyFamily(installation)],
    installations: [installation],
  }
}

function SupportCatalogDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const [products, setProducts] = useState<AgentIntegrationSupportProductDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setProducts(await agentIntegrationsApi().supportCatalog())
    } catch (catalogError) {
      setError(catalogError instanceof Error ? catalogError.message : t('agent.managed.unknownError'))
    }
  }, [t])

  useEffect(() => {
    if (open && products === null && error === null) void load()
  }, [error, load, open, products])

  useEffect(() => {
    if (!open) return
    return acquireModalInert(document.getElementById('root'))
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose, open])

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      requestAnimationFrame(() => closeRef.current?.focus())
      return
    }
    previousFocusRef.current?.focus()
    previousFocusRef.current = null
  }, [open])

  if (!open) return null
  const filtered = (products ?? []).filter(product => matchesSupportQuery(product, query))
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="support-catalog-title" className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-white/10 bg-[#151523] shadow-2xl">
        <header className="flex items-start justify-between border-b border-white/[0.07] p-4">
          <div>
            <h3 id="support-catalog-title" className="text-sm font-semibold text-gray-100">{t('agent.managed.supportCatalog')}</h3>
            <p className="mt-1 text-xs text-gray-400">{t('agent.managed.supportCatalogDescription')}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t('agent.managed.close')} className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-gray-200"><X size={16} aria-hidden /></button>
        </header>
        <div className="border-b border-white/[0.06] p-4">
          <label className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2">
            <Search size={13} className="text-gray-500" aria-hidden />
            <span className="sr-only">{t('agent.managed.searchSupport')}</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('agent.managed.searchSupport')} className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="text-xs text-red-300" role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void load()} className="mt-2 text-indigo-300 hover:text-indigo-200">
                {t('agent.managed.retry')}
              </button>
            </div>
          ) : products === null ? (
            <div className="h-24 animate-pulse rounded-lg bg-white/[0.04]" />
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-xs text-gray-400">{t('agent.managed.noSupportMatch')}</p>
          ) : (
            <div className="space-y-2">
              {filtered.map(product => (
                <section key={product.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                  <h4 className="text-xs font-medium text-gray-200">{product.displayName}</h4>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {product.variants.map(variant => (
                      <span key={variant.id} className="rounded-md bg-white/[0.04] px-2 py-1 text-xs text-gray-400">
                        {variant.displayName} · {t(`agent.managed.maturity.${variant.maturity}`)}
                      </span>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function AgentIntegration() {
  const { t } = useTranslation('settings')
  const { timeAgo } = useFormatters()
  const [searchParams, setSearchParams] = useSearchParams()
  const fetchSnapshot = useCallback(() => agentIntegrationsApi().snapshot(), [])
  const { data: snapshot, loading, error, refetch } = useIPC(fetchSnapshot)
  const [scanning, setScanning] = useState(false)
  const [scanAnnouncement, setScanAnnouncement] = useState('')
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanReport, setScanReport] = useState<Pick<AgentIntegrationScanResultDto, 'detectedCount' | 'newlyDiscoveredCount' | 'unresolved'> | null>(null)
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null)
  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [requestedInstallationIds, setRequestedInstallationIds] = useState<readonly string[] | undefined>()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedHistoryInstallationId, setSelectedHistoryInstallationId] = useState<string | null>(null)
  const [supportOpen, setSupportOpen] = useState(false)
  const [applyTask, setApplyTask] = useState<AgentIntegrationApplyTaskDto | null>(null)
  const applyTaskRef = useRef<AgentIntegrationApplyTaskDto | null>(null)
  const [applyTasks, setApplyTasks] = useState<AgentIntegrationApplyTaskDto[]>([])
  const [applyTaskPage, setApplyTaskPage] = useState<Omit<AgentIntegrationApplyTaskPageDto, 'tasks'>>({
    attentionCount: 0,
    activeCount: 0,
    totalCount: 0,
    startIndex: 0,
    hasMore: false,
    hasPrevious: false,
    nextCursor: null,
    previousCursor: null,
  })
  const [applyTaskPageLoading, setApplyTaskPageLoading] = useState(false)
  const [applyTaskPageError, setApplyTaskPageError] = useState(false)
  const [applyTaskPageAnnouncement, setApplyTaskPageAnnouncement] = useState('')
  const [wideDetailLayout, setWideDetailLayout] = useState(false)
  const layoutRef = useRef<HTMLDivElement>(null)
  const initialScanStartedRef = useRef(false)
  const scanInFlightRef = useRef(false)
  const detailTriggerRef = useRef<{ familyId: string; element: HTMLButtonElement } | null>(null)
  const historyTriggerRef = useRef<{ installationId: string; element: HTMLButtonElement } | null>(null)
  const restoreDetailFocusRef = useRef(false)
  const restoreHistoryFocusRef = useRef(false)
  const localAgentsHeadingRef = useRef<HTMLHeadingElement>(null)
  const previousTaskButtonRef = useRef<HTMLButtonElement>(null)
  const nextTaskButtonRef = useRef<HTMLButtonElement>(null)
  const restoreTaskPageFocusRef = useRef<'previous' | 'next' | null>(null)

  useEffect(() => {
    const element = layoutRef.current
    if (!element) return
    const update = (width: number) => setWideDetailLayout(width >= 900)
    update(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => update(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const loadApplyTaskPage = useCallback(async (
    cursor?: string,
    selectEdge?: 'first' | 'last',
  ) => {
    if (!restoreTaskPageFocusRef.current) {
      if (document.activeElement === previousTaskButtonRef.current) {
        restoreTaskPageFocusRef.current = 'previous'
      } else if (document.activeElement === nextTaskButtonRef.current) {
        restoreTaskPageFocusRef.current = 'next'
      }
    }
    setApplyTaskPageLoading(true)
    setApplyTaskPageError(false)
    try {
      let page: AgentIntegrationApplyTaskPageDto
      try {
        page = await agentIntegrationsApi().listApplyTasks({ limit: 20, ...(cursor ? { cursor } : {}) })
      } catch (error) {
        const stale = isStaleTaskFeedCursorError(error)
        if (!cursor || !stale) throw error
        // A cursor is authority-bound to one durable revision. Any stale or
        // malformed cursor fails closed to a fresh first page.
        page = await agentIntegrationsApi().listApplyTasks({ limit: 20 })
        setApplyTaskPageAnnouncement(t('agent.managed.backgroundTasksUpdated'))
      }
      let pinnedExact: AgentIntegrationApplyTaskDto | null | undefined
      const prior = applyTaskRef.current
      if (!selectEdge && prior?.feedKey && !page.tasks.some(task => task.feedKey === prior.feedKey)) {
        try {
          pinnedExact = await agentIntegrationsApi().getApplyTask(prior.feedKey)
        } catch (error) {
          if (!isUnknownApplyTaskError(error)) throw error
          // The recovered run may have become uniquely owned by a durable task;
          // remove the stale pin and let the authoritative page choose again.
          pinnedExact = null
        }
      }
      setApplyTasks(page.tasks)
      setApplyTaskPage({
        attentionCount: page.attentionCount,
        activeCount: page.activeCount,
        totalCount: page.totalCount,
        startIndex: page.startIndex,
        hasMore: page.hasMore,
        hasPrevious: page.hasPrevious,
        nextCursor: page.nextCursor,
        previousCursor: page.previousCursor,
      })
      setApplyTask(current => {
        let next: AgentIntegrationApplyTaskDto | null
        if (selectEdge && page.tasks.length > 0) {
          next = page.tasks[selectEdge === 'first' ? 0 : page.tasks.length - 1] ?? current
        } else if (pinnedExact !== undefined) {
          next = pinnedExact ?? recoverVisibleApplyTask(null, page.tasks)
        } else {
          next = recoverVisibleApplyTask(current, page.tasks)
        }
        applyTaskRef.current = next
        return next
      })
    } catch {
      setApplyTaskPageError(true)
    } finally {
      setApplyTaskPageLoading(false)
    }
  }, [t])

  const refreshApplyTasks = useCallback(() => {
    void loadApplyTaskPage()
  }, [loadApplyTaskPage])

  useEffect(() => {
    if (applyTaskPageLoading || !restoreTaskPageFocusRef.current) return
    const target = restoreTaskPageFocusRef.current === 'previous'
      ? previousTaskButtonRef.current
      : nextTaskButtonRef.current
    restoreTaskPageFocusRef.current = null
    target?.focus()
  }, [applyTask, applyTaskPageLoading, applyTasks])

  useEffect(() => {
    const unsubscribe = agentIntegrationsApi().onTaskProgress(task => {
      // Keep at most one pinned task outside the bounded page. The durable feed
      // is reloaded instead of infinitely prepending progress DTOs.
      const pinned = { ...task, feedKey: task.feedKey ?? `task:${task.id}` }
      setApplyTask(current => {
        const next = mergeApplyTaskProgress(current, pinned)
        applyTaskRef.current = next
        return next
      })
      setApplyTaskPageAnnouncement(t('agent.managed.backgroundTasksUpdated'))
      refreshApplyTasks()
      if (task.state === 'completed') refetch()
    })
    refreshApplyTasks()
    return unsubscribe
  }, [refetch, refreshApplyTasks, t])

  useEffect(() => {
    const refreshDelay = applyTaskProgressRefreshDelay(applyTasks, applyTask)
    if (refreshDelay === null) return
    const timer = window.setInterval(refreshApplyTasks, refreshDelay)
    return () => window.clearInterval(timer)
  }, [applyTask, applyTasks, refreshApplyTasks])

  const summary = snapshot ? summarizeSnapshot(snapshot) : null
  const applyTaskSummary = applyTask ? summarizeExecutionResults(applyTask.results) : null
  const failedApplyIds = applyTask ? executionInstallationIds(applyTask.results, 'failed') : []
  const recoveryApplyIds = applyTask ? executionInstallationIds(applyTask.results, 'needs_recovery') : []
  const interruptedApplyIds = applyTask ? executionInstallationIds(applyTask.results, 'interrupted') : []
  const interruptedPartitions = partitionManageableInstallationIds(
    interruptedApplyIds,
    snapshot?.installations ?? [],
  )
  const applyTaskIndex = applyTask ? applyTasks.findIndex(task => (
    (task.feedKey ?? `task:${task.id}`) === (applyTask.feedKey ?? `task:${applyTask.id}`)
  )) : -1
  const selectedFamily = snapshot?.families.find(family => family.id === selectedFamilyId) ?? null
  const selectedHistoryInstallation = snapshot?.historyInstallations.find(
    installation => installation.id === selectedHistoryInstallationId,
  ) ?? null

  useEffect(() => {
    const installationId = searchParams.get('installation')
    if (!snapshot || !installationId) return
    const target = snapshot.installations.find(item => item.id === installationId)
    const historyTarget = snapshot.historyInstallations.find(item => item.id === installationId)
    if (!target && !historyTarget) return
    if (target) {
      setSelectedHistoryInstallationId(null)
      setSelectedFamilyId(target.familyId)
      setSelectedInstallationId(target.id)
    } else if (historyTarget) {
      setSelectedFamilyId(null)
      setSelectedInstallationId(null)
      setAdvancedOpen(true)
      setSelectedHistoryInstallationId(historyTarget.id)
    }
    setSearchParams(previous => {
      const next = new URLSearchParams(previous)
      next.delete('installation')
      return next
    }, { replace: true })
  }, [searchParams, setSearchParams, snapshot])

  useLayoutEffect(() => {
    if (selectedFamilyId !== null || !restoreDetailFocusRef.current) return
    restoreDetailFocusRef.current = false
    const trigger = detailTriggerRef.current
    const liveTrigger = trigger?.element.isConnected
      ? trigger.element
      : [...document.querySelectorAll<HTMLButtonElement>('[data-agent-family-trigger]')]
        .find(candidate => candidate.dataset.agentFamilyTrigger === trigger?.familyId)
    liveTrigger?.focus()
  }, [selectedFamilyId])

  useLayoutEffect(() => {
    if (selectedHistoryInstallationId !== null || !restoreHistoryFocusRef.current) return
    restoreHistoryFocusRef.current = false
    const trigger = historyTriggerRef.current
    const liveTrigger = trigger?.element.isConnected
      ? trigger.element
      : [...document.querySelectorAll<HTMLButtonElement>('[data-agent-history-trigger]')]
        .find(candidate => candidate.dataset.agentHistoryTrigger === trigger?.installationId)
    liveTrigger?.focus()
  }, [selectedHistoryInstallationId])

  const scan = useCallback(async () => {
    if (scanInFlightRef.current) return
    scanInFlightRef.current = true
    setScanning(true)
    setScanError(null)
    setScanReport(null)
    setScanAnnouncement(t('agent.managed.scanning'))
    try {
      const result = await agentIntegrationsApi().scan()
      setScanReport({
        detectedCount: result.detectedCount,
        newlyDiscoveredCount: result.newlyDiscoveredCount,
        unresolved: result.unresolved,
      })
      refetch()
      setScanAnnouncement(t('agent.managed.scanComplete', {
        detected: result.detectedCount,
        newCount: result.newlyDiscoveredCount,
        failed: result.unresolved.length,
      }))
    } catch (scanFailure) {
      const message = scanFailure instanceof Error ? scanFailure.message : t('agent.managed.unknownError')
      setScanError(message)
      setScanAnnouncement(t('agent.managed.scanFailed'))
    } finally {
      scanInFlightRef.current = false
      setScanning(false)
    }
  }, [refetch, t])

  useEffect(() => {
    if (initialScanStartedRef.current) return
    initialScanStartedRef.current = true
    void scan()
  }, [scan])

  const openBatch = (ids?: readonly string[]) => {
    setRequestedInstallationIds(ids)
    setBatchOpen(true)
  }

  return (
    <div ref={layoutRef} className="w-full max-w-[1280px] space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-100">{t('agent.managed.title')}</h2>
          <p className="mt-1 text-xs text-gray-400">{t('agent.managed.subtitle')}</p>
          {summary && (
            <p className="mt-2 text-xs text-gray-400">
              {t('agent.managed.summary', {
                products: summary.productCount,
                installations: summary.installationCount,
                available: summary.availableCount,
              })}
              <span className="mx-2 text-gray-700">·</span>
              {snapshot?.lastScanAt ? t('agent.managed.lastChecked', { time: timeAgo(snapshot.lastScanAt) }) : t('agent.managed.notCheckedYet')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning || loading}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-indigo-400/20 bg-indigo-400/10 px-3 py-2 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-400/15 disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw size={13} className={scanning ? 'animate-spin' : ''} aria-hidden />
          {scanning ? t('agent.managed.scanning') : t('agent.managed.recheck')}
        </button>
      </header>

      <div className="sr-only" aria-live="polite">{scanAnnouncement}</div>

      {applyTaskPageError && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-200" role="alert">
          <span>{t('agent.managed.backgroundTaskPageLoadFailed')}</span>
          <button
            type="button"
            className="shrink-0 rounded border border-current/20 px-2 py-1"
            onClick={refreshApplyTasks}
          >
            {t('agent.managed.retryBackgroundTaskPage')}
          </button>
        </div>
      )}

      {applyTask && applyTaskSummary && (() => {
        const failed = applyTaskSummary.failed > 0 || applyTaskSummary.needsRecovery > 0
        const pendingVerification = !failed && applyTask.state === 'completed' && applyTaskSummary.awaitingVerification > 0
        const interrupted = !failed && applyTaskSummary.interrupted > 0
        const tone = applyTask.state === 'running'
          ? 'border-indigo-400/15 bg-indigo-400/[0.06] text-indigo-200'
          : failed
            ? 'border-red-400/15 bg-red-400/[0.06] text-red-200'
            : interrupted || pendingVerification || applyTaskSummary.otherAttention > 0
              ? 'border-amber-400/15 bg-amber-400/[0.06] text-amber-200'
              : 'border-emerald-400/15 bg-emerald-400/[0.06] text-emerald-200'
        return (
          <div
            data-task-feed-key={applyTask.feedKey ?? `task:${applyTask.id}`}
            data-task-feed-total={applyTaskPage.totalCount}
            data-task-feed-start-index={applyTaskPage.startIndex}
            data-task-feed-page-index={applyTaskIndex}
            data-tone={applyTask.state === 'running'
              ? 'running'
              : failed
                ? 'critical'
                : interrupted || pendingVerification || applyTaskSummary.otherAttention > 0
                  ? 'attention'
                  : 'success'}
            className={`rounded-xl border px-4 py-3 text-xs ${tone}`}
            role={failed ? 'alert' : 'status'}
            aria-live="polite"
          >
            <span className="sr-only" aria-live="polite">{applyTaskPageAnnouncement}</span>
            {applyTaskPage.activeCount > 0 && (
              <p className="mb-2 text-indigo-200">
                {t('agent.managed.backgroundTaskActiveCount', { count: applyTaskPage.activeCount })}
              </p>
            )}
            {applyTaskPage.attentionCount > 0 && (
              <p className="mb-2 text-amber-200">
                {t('agent.managed.backgroundTaskAttentionCount', { count: applyTaskPage.attentionCount })}
              </p>
            )}
            {(applyTaskIndex >= 0 ? applyTaskPage.totalCount > 1 : applyTasks.length > 0) && (
              <div className="mb-2 flex items-center justify-end gap-2">
                <button
                  ref={previousTaskButtonRef}
                  type="button"
                  aria-label={t('agent.managed.previousBackgroundTask')}
                  aria-busy={applyTaskPageLoading}
                  disabled={applyTaskPageLoading || applyTaskIndex < 0
                    || (applyTaskIndex === 0 && !applyTaskPage.hasPrevious)}
                  onClick={() => {
                    const previous = applyTasks[applyTaskIndex - 1]
                    if (previous) {
                      restoreTaskPageFocusRef.current = 'previous'
                      applyTaskRef.current = previous
                      setApplyTask(previous)
                      window.setTimeout(() => previousTaskButtonRef.current?.focus(), 0)
                    }
                    else if (applyTaskPage.previousCursor) {
                      restoreTaskPageFocusRef.current = 'previous'
                      void loadApplyTaskPage(applyTaskPage.previousCursor, 'last')
                    }
                  }}
                  className="rounded border border-current/20 p-1 disabled:opacity-30"
                >
                  <ChevronLeft size={13} aria-hidden />
                </button>
                <span>{applyTaskIndex < 0
                  ? t('agent.managed.backgroundTaskPinnedOutsidePage')
                  : t('agent.managed.backgroundTaskPosition', {
                      current: applyTaskPage.startIndex + applyTaskIndex + 1,
                      total: applyTaskPage.totalCount,
                    })}</span>
                <button
                  ref={nextTaskButtonRef}
                  type="button"
                  aria-label={t('agent.managed.nextBackgroundTask')}
                  aria-busy={applyTaskPageLoading}
                  disabled={applyTaskPageLoading || applyTasks.length === 0
                    || (applyTaskIndex >= applyTasks.length - 1 && !applyTaskPage.hasMore)}
                  onClick={() => {
                    const next = applyTasks[applyTaskIndex + 1]
                    if (next) {
                      restoreTaskPageFocusRef.current = 'next'
                      applyTaskRef.current = next
                      setApplyTask(next)
                      window.setTimeout(() => nextTaskButtonRef.current?.focus(), 0)
                    }
                    else if (applyTaskPage.nextCursor) {
                      restoreTaskPageFocusRef.current = 'next'
                      void loadApplyTaskPage(applyTaskPage.nextCursor, 'first')
                    }
                  }}
                  className="rounded border border-current/20 p-1 disabled:opacity-30"
                >
                  <ChevronRight size={13} aria-hidden />
                </button>
              </div>
            )}
            <p>
              {applyTask.state === 'running'
                ? t('agent.managed.backgroundProgress', {
                    completed: applyTask.results.length,
                    total: applyTask.installationIds.length,
                  })
                : t('agent.managed.backgroundComplete', { total: applyTask.installationIds.length })}
            </p>
            {applyTask.state === 'completed' && (
              <p className="mt-1">
                {applyTaskSummary.committed} {t('agent.managed.execution.committed')}
                {' · '}{applyTaskSummary.awaitingVerification} {t('agent.managed.execution.awaiting_verification')}
                {' · '}{applyTaskSummary.failed} {t('agent.managed.execution.failed')}
                {' · '}{applyTaskSummary.needsRecovery} {t('agent.managed.execution.needs_recovery')}
                {' · '}{applyTaskSummary.interrupted} {t('agent.managed.execution.interrupted')}
              </p>
            )}
            {applyTask.state === 'completed' && applyTask.results.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-current">{t('agent.managed.viewDetails')}</summary>
                <ul className="mt-2 space-y-1 text-gray-300">
                  {applyTask.results.map(result => {
                    const installation = snapshot?.installations.find(item => item.id === result.installationId)
                      ?? snapshot?.historyInstallations.find(item => item.id === result.installationId)
                    return (
                      <li key={result.installationId} className="break-words">
                        {installation?.displayName ?? result.installationId}
                        {' · '}{t(`agent.managed.execution.${result.status}`)}
                        {result.reason ? ` · ${result.reason}` : ''}
                      </li>
                    )
                  })}
                </ul>
              </details>
            )}
            {applyTask.state === 'completed' && failedApplyIds.length > 0 && (
              <button
                type="button"
                onClick={() => openBatch(failedApplyIds)}
                className="mt-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
              >
                {t('agent.managed.retryFailedCount', { count: failedApplyIds.length })}
              </button>
            )}
            {applyTask.state === 'completed' && recoveryApplyIds.length > 0 && (
              <button
                type="button"
                onClick={() => openBatch(recoveryApplyIds)}
                className="mt-2 ml-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
              >
                {t('agent.managed.regenerateRecoveryCount', { count: recoveryApplyIds.length })}
              </button>
            )}
            {applyTask.state === 'completed' && interruptedPartitions.retryable.length > 0 && (
              <button
                type="button"
                onClick={() => openBatch(interruptedPartitions.retryable)}
                className="mt-2 ml-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
              >
                {t('agent.managed.regenerateInterruptedCount', { count: interruptedPartitions.retryable.length })}
              </button>
            )}
            {applyTask.state === 'completed' && interruptedPartitions.unavailable.length > 0 && (
              <button
                type="button"
                onClick={() => void scan()}
                disabled={scanning}
                className="mt-2 ml-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5 disabled:cursor-wait disabled:opacity-50"
              >
                {t('agent.managed.recheckUnavailableInterruptedCount', {
                  count: interruptedPartitions.unavailable.length,
                })}
              </button>
            )}
          </div>
        )
      })()}

      {snapshot?.fixtureMode === 'isolated_ui_audit' && (
        <div className="rounded-xl border border-sky-400/15 bg-sky-400/[0.06] px-4 py-3 text-xs text-sky-200" role="note">
          UI Audit Fixture · 合成审计数据，仅用于界面验收，不代表真实宿主验证。
        </div>
      )}

      {(error || scanError) && (
        <div className="flex items-start gap-3 rounded-xl border border-red-400/15 bg-red-400/[0.06] p-4" role="alert">
          <ServerOff size={16} className="mt-0.5 shrink-0 text-red-300" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-medium text-red-200">{t('agent.managed.serviceUnavailable')}</h3>
            <p className="mt-1 break-words text-xs text-red-300/80">{scanError ?? error}</p>
          </div>
          <button
            type="button"
            onClick={() => scanError ? void scan() : refetch()}
            disabled={scanning}
            className="text-xs text-red-200 hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            {t('agent.managed.retry')}
          </button>
        </div>
      )}

      {snapshot && summary && (summary.pendingCount > 0 || summary.attentionCount > 0 || Boolean(scanReport?.unresolved.length)) && (
        <section className="rounded-xl border border-amber-400/15 bg-amber-400/[0.06] p-4" aria-labelledby="managed-attention-title">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" aria-hidden />
              <div>
                <h3 id="managed-attention-title" className="text-xs font-medium text-amber-100">{t('agent.managed.needsAttention')}</h3>
                <ul className="mt-1 space-y-1 text-xs text-amber-200/80">
                  {summary.pendingCount > 0 && <li>{t('agent.managed.newAgentsFound', { count: summary.pendingCount })}</li>}
                  {summary.attentionCount > 0 && <li>{t('agent.managed.existingIssues', { count: summary.attentionCount })}</li>}
                  {scanReport && scanReport.unresolved.length > 0 && (
                    <li>
                      <details>
                        <summary className="cursor-pointer">
                          {t('agent.managed.scanComplete', {
                            detected: scanReport.detectedCount,
                            newCount: scanReport.newlyDiscoveredCount,
                            failed: scanReport.unresolved.length,
                          })}
                        </summary>
                        <ul className="mt-1 space-y-1 pl-4 text-amber-100/70">
                          {scanReport.unresolved.map((item, index) => (
                            <li key={`${item.hostVariants.join(':')}-${index}`} className="break-words">
                              {item.hostVariants.length > 0 ? `${item.hostVariants.join(' / ')} · ` : ''}{item.summary}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  )}
                </ul>
              </div>
            </div>
            {summary.pendingCount > 0 && (
              <button type="button" onClick={() => openBatch()} className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-medium text-amber-950 hover:bg-amber-200">
                {t('agent.managed.reviewAndConnect')}
              </button>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="managed-local-agents-title">
        <div className="mb-2 flex items-center justify-between">
          <h3 ref={localAgentsHeadingRef} id="managed-local-agents-title" tabIndex={-1} className="text-sm font-medium text-gray-300 focus:outline-none">{t('agent.managed.localAgents')}</h3>
          <button type="button" onClick={() => setSupportOpen(true)} className="text-xs text-gray-400 hover:text-indigo-300">{t('agent.managed.viewSupport')}</button>
        </div>

        {((loading && !snapshot) || (scanning && snapshot?.lastScanAt === null && snapshot.families.length === 0)) ? <InitialSkeleton /> : snapshot && snapshot.families.length === 0 ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
            <Sparkles size={20} className="mx-auto text-gray-600" aria-hidden />
            <h4 className="mt-3 text-xs font-medium text-gray-300">{t('agent.managed.emptyTitle')}</h4>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-gray-400">{t('agent.managed.emptyDescription')}</p>
            <div className="mt-4 flex justify-center gap-3">
              <button type="button" onClick={() => void scan()} className="text-xs text-indigo-300 hover:text-indigo-200">{t('agent.managed.recheck')}</button>
              <button type="button" onClick={() => setSupportOpen(true)} className="text-xs text-gray-400 hover:text-gray-300">{t('agent.managed.viewSupport')}</button>
            </div>
          </div>
        ) : snapshot ? (
          <div className={`grid gap-3 ${wideDetailLayout ? 'grid-cols-[minmax(0,1.55fr)_minmax(340px,.95fr)]' : ''}`}>
            <div className={selectedFamily && !wideDetailLayout ? 'hidden' : 'block'}>
              <ManagedFamilyList snapshot={snapshot} selectedFamilyId={selectedFamilyId} onSelect={(familyId, trigger) => {
                detailTriggerRef.current = { familyId, element: trigger }
                setSelectedHistoryInstallationId(null)
                setSelectedFamilyId(familyId)
                setSelectedInstallationId(null)
              }} />
            </div>
            <div className={`${selectedFamily || wideDetailLayout ? 'block' : 'hidden'} overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]`}>
              {selectedFamily ? (
                <ManagedAgentDetail
                  key={selectedFamily.id}
                  family={selectedFamily}
                  snapshot={snapshot}
                  selectedInstallationId={selectedInstallationId}
                  onSelectInstallation={setSelectedInstallationId}
                  onCloseMobile={() => {
                    restoreDetailFocusRef.current = true
                    setSelectedFamilyId(null)
                  }}
                  onChanged={refetch}
                  onReconnect={installationId => openBatch([installationId])}
                  showBackButton={!wideDetailLayout}
                />
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
                  <Search size={18} className="text-gray-700" aria-hidden />
                  <p className="mt-2 text-xs text-gray-400">{t('agent.managed.selectForDetails')}</p>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </section>

      <section className="border-t border-white/[0.05] pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen(value => !value)}
          aria-expanded={advancedOpen}
          aria-controls="agent-advanced-connections"
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-300"
        >
          {advancedOpen ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
          {t('agent.managed.advanced')}
        </button>
        {advancedOpen && (
          <div id="agent-advanced-connections" className="mt-2 space-y-3">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <h4 className="text-xs font-medium text-gray-300">{t('agent.managed.customAgent')}</h4>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{t('agent.managed.customAgentDescription')}</p>
              <p className="mt-2 text-xs text-gray-400">{t('agent.managed.customAgentUnavailable')}</p>
            </div>
            <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4" aria-labelledby="agent-connection-history-title">
              <div className="flex items-start gap-2">
                <History size={14} className="mt-0.5 shrink-0 text-gray-400" aria-hidden />
                <div>
                  <h4 id="agent-connection-history-title" className="text-xs font-medium text-gray-300">
                    {t('agent.managed.connectionHistory')}
                  </h4>
                  <p className="mt-1 text-xs leading-relaxed text-gray-400">
                    {t('agent.managed.connectionHistoryDescription')}
                  </p>
                </div>
              </div>
              {snapshot?.historyInstallations.length ? (
                <div className="mt-3 space-y-2">
                  {snapshot.historyInstallations.map(installation => (
                    <button
                      key={installation.id}
                      type="button"
                      data-agent-history-trigger={installation.id}
                      onClick={event => {
                        historyTriggerRef.current = { installationId: installation.id, element: event.currentTarget }
                        setSelectedHistoryInstallationId(installation.id)
                      }}
                      aria-label={t('agent.managed.viewHistoryFor', { name: installation.displayName })}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-gray-300">{installation.displayName}</span>
                        <span className="mt-0.5 block truncate text-xs text-gray-400">
                          {installation.variantLabel} · {installation.profileLabel ?? t('agent.managed.defaultProfile')}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-gray-400">{t('agent.managed.historyRecord')}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-gray-400">{t('agent.managed.connectionHistoryEmpty')}</p>
              )}
              {selectedHistoryInstallation && snapshot && (
                <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.015]">
                  <ManagedAgentDetail
                    key={`history:${selectedHistoryInstallation.id}`}
                    family={historyFamily(selectedHistoryInstallation)}
                    snapshot={historyDetailSnapshot(snapshot, selectedHistoryInstallation)}
                    selectedInstallationId={selectedHistoryInstallation.id}
                    onSelectInstallation={() => {}}
                    onCloseMobile={() => {
                      restoreHistoryFocusRef.current = true
                      setSelectedHistoryInstallationId(null)
                    }}
                    onChanged={refetch}
                    onReconnect={() => {}}
                    historyOnly
                    showBackButton
                  />
                </div>
              )}
            </section>
          </div>
        )}
      </section>

      {snapshot && (
        <BatchConnectDialog
          open={batchOpen}
          snapshot={snapshot}
          requestedInstallationIds={requestedInstallationIds}
          onClose={() => setBatchOpen(false)}
          onComplete={refetch}
          onTaskUpdate={task => {
            const pinned = { ...task, feedKey: task.feedKey ?? `task:${task.id}` }
            setApplyTask(current => {
              const next = mergeApplyTaskProgress(current, pinned)
              applyTaskRef.current = next
              return next
            })
            setApplyTaskPageAnnouncement(t('agent.managed.backgroundTasksUpdated'))
            refreshApplyTasks()
          }}
          fallbackFocusRef={localAgentsHeadingRef}
        />
      )}
      <SupportCatalogDialog open={supportOpen} onClose={() => setSupportOpen(false)} />
    </div>
  )
}
