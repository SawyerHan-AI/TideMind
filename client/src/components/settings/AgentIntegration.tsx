import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  Plus,
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
  AgentIntegrationClaudeCoworkPreflightDto,
} from '../../lib/api-contract'
import { useIPC } from '../../hooks/useIPC'
import { useFormatters } from '../../hooks/useFormatters'
import { acquireModalInert } from '../../lib/modal-inert'
import { BatchConnectDialog } from './agent-integration-managed/BatchConnectDialog'
import { CustomLocalAgentDialog } from './agent-integration-managed/CustomLocalAgentDialog'
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

function AgentOverviewMetric({
  label,
  value,
  warning = false,
}: {
  label: string
  value: string
  warning?: boolean
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.025] px-3 py-2">
      <p className="text-[10px] text-gray-500">{label}</p>
      <p className={`mt-1 text-sm font-medium ${warning ? 'text-amber-300' : 'text-gray-200'}`}>{value}</p>
    </div>
  )
}

type AgentIntegrationReleasePolicyMode = NonNullable<
  AgentIntegrationSnapshotDto['releasePolicy']
>['mode']

export function AgentIntegrationReleasePolicyBanner({
  mode,
  title,
  description,
}: {
  mode: AgentIntegrationReleasePolicyMode | undefined
  title: string
  description: string
}) {
  if (!mode || mode === 'active') return null

  const invalidManifest = mode === 'invalid_manifest'
  const titleId = `agent-release-policy-${mode}-title`
  const descriptionId = `agent-release-policy-${mode}-description`

  return (
    <div
      data-agent-release-policy={mode}
      className="glass-card mt-4 rounded-xl"
      role={invalidManifest ? 'alert' : 'status'}
      aria-live={invalidManifest ? 'assertive' : 'polite'}
      aria-atomic="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className={`flex items-start gap-3 border-l-4 px-4 py-3 ${invalidManifest
        ? 'border-red-400/30 bg-red-400/[0.06]'
        : 'border-amber-400/30 bg-amber-400/[0.06]'}`}
      >
        {invalidManifest ? (
          <AlertTriangle size={17} className="mt-0.5 shrink-0 text-red-400" aria-hidden />
        ) : (
          <ServerOff size={17} className="mt-0.5 shrink-0 text-amber-400" aria-hidden />
        )}
        <div className="min-w-0">
          <h3 id={titleId} className="text-xs font-semibold text-gray-100">{title}</h3>
          <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-gray-300">{description}</p>
        </div>
      </div>
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

export function SupportCatalogDialog({
  open,
  onClose,
  onCoworkPrepared,
}: {
  open: boolean
  onClose: () => void
  onCoworkPrepared: (installationId: string) => void
}) {
  const { t } = useTranslation('settings')
  const [products, setProducts] = useState<AgentIntegrationSupportProductDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [coworkPreflight, setCoworkPreflight] = useState<AgentIntegrationClaudeCoworkPreflightDto | null>(null)
  const [coworkBusy, setCoworkBusy] = useState(false)
  const [coworkError, setCoworkError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const coworkReviewRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  const coworkSessionSequence = useRef(0)
  const coworkRequestSequence = useRef(0)
  openRef.current = open

  const resetCoworkFlow = useCallback(() => {
    coworkSessionSequence.current += 1
    coworkRequestSequence.current += 1
    setCoworkPreflight(null)
    setCoworkBusy(false)
    setCoworkError(null)
  }, [])

  const close = useCallback(() => {
    resetCoworkFlow()
    onClose()
  }, [onClose, resetCoworkFlow])

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
    resetCoworkFlow()
    const releaseInert = acquireModalInert(document.getElementById('root'))
    return () => {
      coworkSessionSequence.current += 1
      coworkRequestSequence.current += 1
      releaseInert()
    }
  }, [open, resetCoworkFlow])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
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
  }, [close, open])

  useEffect(() => {
    if (!open || !coworkPreflight) return
    requestAnimationFrame(() => coworkReviewRef.current?.focus())
  }, [coworkPreflight, open])

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
  const previewCowork = async () => {
    const session = coworkSessionSequence.current
    const request = ++coworkRequestSequence.current
    const isCurrent = () => openRef.current
      && coworkSessionSequence.current === session
      && coworkRequestSequence.current === request
    setCoworkBusy(true)
    setCoworkError(null)
    try {
      const preflight = await agentIntegrationsApi().previewClaudeCoworkSetup()
      if (isCurrent()) setCoworkPreflight(preflight)
    } catch (previewError) {
      if (isCurrent()) setCoworkError(previewError instanceof Error ? previewError.message : t('agent.managed.unknownError'))
    } finally {
      if (isCurrent()) setCoworkBusy(false)
    }
  }
  const prepareCowork = async () => {
    if (!coworkPreflight) return
    const session = coworkSessionSequence.current
    const request = ++coworkRequestSequence.current
    const isCurrent = () => openRef.current
      && coworkSessionSequence.current === session
      && coworkRequestSequence.current === request
    setCoworkBusy(true)
    setCoworkError(null)
    try {
      const prepared = await agentIntegrationsApi().prepareClaudeCoworkSetup(coworkPreflight.preflightHash)
      if (!isCurrent()) return
      setCoworkPreflight(null)
      onCoworkPrepared(prepared.installationId)
    } catch (prepareError) {
      if (isCurrent()) setCoworkError(prepareError instanceof Error ? prepareError.message : t('agent.managed.unknownError'))
    } finally {
      if (isCurrent()) setCoworkBusy(false)
    }
  }
  const filtered = (products ?? []).filter(product => matchesSupportQuery(product, query))
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="theme-modal-overlay absolute inset-0 backdrop-blur-sm" onClick={close} aria-hidden />
      <div ref={dialogRef} data-support-catalog-dialog role="dialog" aria-modal="true" aria-labelledby="support-catalog-title" className="theme-popup-surface relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border">
        <header className="flex items-start justify-between border-b border-white/[0.07] p-4">
          <div>
            <h3 id="support-catalog-title" className="text-sm font-semibold text-gray-100">{t('agent.managed.supportCatalog')}</h3>
            <p className="mt-1 text-xs text-gray-400">{t('agent.managed.supportCatalogDescription')}</p>
          </div>
          <button ref={closeRef} type="button" onClick={close} aria-label={t('agent.managed.close')} className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-gray-200"><X size={16} aria-hidden /></button>
        </header>
        <div className="border-b border-white/[0.06] p-4">
          <label className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2">
            <Search size={13} className="text-gray-500" aria-hidden />
            <span className="sr-only">{t('agent.managed.searchSupport')}</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('agent.managed.searchSupport')} className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {coworkPreflight && (
            <section
              ref={coworkReviewRef}
              data-cowork-guided-review
              className="mb-3 rounded-xl border border-indigo-400/20 bg-indigo-400/[0.07] p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              aria-labelledby="cowork-guided-title"
              aria-live="polite"
              role="status"
              tabIndex={-1}
            >
              <h4 id="cowork-guided-title" className="text-xs font-semibold text-gray-100">{t('agent.managed.coworkGuided.title')}</h4>
              <p className="mt-1 text-xs text-gray-300">{t('agent.managed.coworkGuided.summary', { version: coworkPreflight.hostVersion })}</p>
              <ul className="mt-2 space-y-1 text-xs text-gray-400">
                <li>{t('agent.managed.coworkGuided.noDesktopWrite')}</li>
                <li>{t('agent.managed.coworkGuided.manualUpload')}</li>
                <li>{t('agent.managed.coworkGuided.runtimeProof')}</li>
              </ul>
              {coworkError && <p className="mt-2 text-xs text-red-300" role="alert">{coworkError}</p>}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" disabled={coworkBusy} onClick={() => setCoworkPreflight(null)} className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50">{t('agent.managed.back')}</button>
                <button data-cowork-guided-confirm type="button" disabled={coworkBusy} onClick={() => void prepareCowork()} className="theme-confirm-primary rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50">{coworkBusy ? t('agent.managed.loadingPlan') : t('agent.managed.coworkGuided.confirm')}</button>
              </div>
            </section>
          )}
          {!coworkPreflight && coworkError && <p className="mb-3 text-xs text-red-300" role="alert">{coworkError}</p>}
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
                    {product.variants.map(variant => variant.id === 'claude-cowork-local' ? (
                      <div key={variant.id} className="flex w-full items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-2 py-1.5">
                        <span className="text-xs text-gray-400">{variant.displayName} · {t(`agent.managed.maturity.${variant.maturity}`)}</span>
                        <button data-cowork-guided-start type="button" disabled={coworkBusy} onClick={() => void previewCowork()} className="shrink-0 rounded-md border border-indigo-400/20 bg-indigo-400/10 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-400/15 disabled:opacity-50">{t('agent.managed.coworkGuided.start')}</button>
                      </div>
                    ) : (
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
  const [customAgentOpen, setCustomAgentOpen] = useState(false)
  const [customLegacyInstallationId, setCustomLegacyInstallationId] = useState<string | null>(null)
  const [selectedHistoryInstallationId, setSelectedHistoryInstallationId] = useState<string | null>(null)
  const [supportOpen, setSupportOpen] = useState(false)
  const [pendingCoworkInstallationId, setPendingCoworkInstallationId] = useState<string | null>(null)
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
  const customSourceInstallations = useMemo(() => snapshot?.installations.filter(installation => (
    installation.familyId !== 'custom-local-agent'
    && installation.hostVariant !== 'custom-local-mcp'
    && installation.manageable
    && installation.statusGroup !== 'disconnected'
  )) ?? [], [snapshot])

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

  useEffect(() => {
    if (!pendingCoworkInstallationId
      || !snapshot?.installations.some(item => item.id === pendingCoworkInstallationId)) return
    setRequestedInstallationIds([pendingCoworkInstallationId])
    setBatchOpen(true)
    setPendingCoworkInstallationId(null)
  }, [pendingCoworkInstallationId, snapshot])

  return (
    <div ref={layoutRef} className="w-full max-w-[1280px] space-y-5">
      <section className="glass-card rounded-xl p-5" aria-labelledby="managed-overview-title">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="managed-overview-title" className="text-base font-semibold text-gray-100">{t('agent.managed.title')}</h2>
            <p className="mt-1 text-xs text-gray-400">{t('agent.managed.subtitle')}</p>
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

        <AgentIntegrationReleasePolicyBanner
          mode={snapshot?.releasePolicy?.mode}
          title={t(snapshot?.releasePolicy?.mode === 'invalid_manifest'
            ? 'agent.managed.releasePolicy.invalidManifestTitle'
            : 'agent.managed.releasePolicy.emergencyReadOnlyTitle')}
          description={t(snapshot?.releasePolicy?.mode === 'invalid_manifest'
            ? 'agent.managed.releasePolicy.invalidManifestDescription'
            : 'agent.managed.releasePolicy.emergencyReadOnlyDescription')}
        />

        {summary && (
          <>
            <div className="mt-4 grid grid-cols-1 gap-2 min-[560px]:grid-cols-3">
              <AgentOverviewMetric
                label={t('agent.managed.status.available')}
                value={String(summary.availableCount)}
              />
              <AgentOverviewMetric
                label={t('agent.managed.needsAttention')}
                value={String(summary.pendingCount + summary.attentionCount + (scanReport?.unresolved.length ?? 0))}
                warning={summary.pendingCount + summary.attentionCount + (scanReport?.unresolved.length ?? 0) > 0}
              />
              <AgentOverviewMetric
                label={t('agent.managed.lastChecked', { time: '' }).replace(/[：:]\s*$/, '').trim()}
                value={snapshot?.lastScanAt ? timeAgo(snapshot.lastScanAt) : t('agent.managed.notCheckedYet')}
              />
            </div>
            <p className="mt-3 text-xs text-gray-400">
              {t('agent.managed.summary', {
                products: summary.productCount,
                installations: summary.installationCount,
                available: summary.availableCount,
              })}
            </p>
          </>
        )}

        <div className="sr-only" aria-live="polite">{scanAnnouncement}</div>
        <div className="mt-4 space-y-3">

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
        const superseded = !failed && !pendingVerification && !interrupted
          && applyTaskSummary.otherAttention === 0 && applyTaskSummary.superseded > 0
        const tone = applyTask.state === 'running'
          ? 'border-indigo-400/15 bg-indigo-400/[0.06] text-indigo-200'
          : failed
            ? 'border-red-400/15 bg-red-400/[0.06] text-red-200'
            : interrupted || pendingVerification || applyTaskSummary.otherAttention > 0
              ? 'border-amber-400/15 bg-amber-400/[0.06] text-amber-200'
              : superseded
                ? 'border-white/[0.08] bg-white/[0.03] text-gray-300'
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
                  : superseded
                    ? 'superseded'
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
                {' · '}{applyTaskSummary.superseded} {t('agent.managed.execution.superseded')}
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
        </div>
      </section>

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
          <div className={`grid gap-3 ${selectedFamily && wideDetailLayout ? 'grid-cols-[minmax(0,1.55fr)_minmax(340px,.95fr)]' : ''}`}>
            <div className={selectedFamily && !wideDetailLayout ? 'hidden' : 'block'}>
              <ManagedFamilyList snapshot={snapshot} selectedFamilyId={selectedFamilyId} onSelect={(familyId, trigger) => {
                detailTriggerRef.current = { familyId, element: trigger }
                setSelectedHistoryInstallationId(null)
                setSelectedFamilyId(familyId)
                setSelectedInstallationId(null)
              }} />
            </div>
            {selectedFamily && (
              <div data-agent-detail-pane className="glass-card overflow-hidden rounded-xl">
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
                  showBackButton
                  focusBackButton={!wideDetailLayout}
                />
              </div>
            )}
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
            <div className="glass-card rounded-xl p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h4 className="text-xs font-medium text-gray-200">{t('agent.managed.customAgent')}</h4>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-gray-400">{t('agent.managed.customAgentDescription')}</p>
                  <p className="mt-2 text-[11px] text-gray-500">{t('agent.managed.customAgentBoundary')}</p>
                </div>
                <button
                  data-custom-agent-open
                  type="button"
                  onClick={() => { setCustomLegacyInstallationId(null); setCustomAgentOpen(true) }}
                  disabled={Boolean(snapshot?.releasePolicy
                    && (snapshot.releasePolicy.mode !== 'active' || !snapshot.releasePolicy.customLocalAgentEnabled))}
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-indigo-400/25 bg-indigo-400/10 px-3 py-2 text-xs font-medium text-indigo-200 hover:bg-indigo-400/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus size={13} aria-hidden />
                  {t('agent.managed.customAgentAdd')}
                </button>
              </div>
              {snapshot?.installations.filter(item => item.familyId === 'custom-local-agent'
                && item.hostVariant === 'custom-local-mcp' && item.version === null
                && item.desiredState === 'unmanaged').map(item => (
                <button key={item.id} type="button" onClick={() => { setCustomLegacyInstallationId(item.id); setCustomAgentOpen(true) }} className="mt-3 rounded-lg border border-indigo-400/20 bg-indigo-400/[0.06] px-3 py-2 text-xs text-indigo-200 hover:bg-indigo-400/10">
                  {t('agent.managed.custom.continueLegacy', { name: item.displayName })}
                </button>
              ))}
              {snapshot?.releasePolicy && (snapshot.releasePolicy.mode !== 'active' || !snapshot.releasePolicy.customLocalAgentEnabled) && (
                <p className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200" role="status">
                  {t('agent.managed.customAgentReadOnly')}
                </p>
              )}
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
                <div className="glass-card mt-3 overflow-hidden rounded-xl">
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
      <SupportCatalogDialog
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        onCoworkPrepared={installationId => {
          setSupportOpen(false)
          setPendingCoworkInstallationId(installationId)
          refetch()
        }}
      />
      {snapshot && (
        <CustomLocalAgentDialog
          open={customAgentOpen}
          sourceInstallations={customSourceInstallations}
          legacyCustomInstallations={snapshot.installations.filter(item => item.familyId === 'custom-local-agent'
            && item.hostVariant === 'custom-local-mcp' && item.version === null
            && item.desiredState === 'unmanaged')}
          initialLegacyInstallationId={customLegacyInstallationId}
          onClose={() => setCustomAgentOpen(false)}
          onComplete={refetch}
          onReviewResult={installationId => {
            const installation = snapshot.installations.find(item => item.id === installationId)
            setCustomAgentOpen(false)
            setSelectedHistoryInstallationId(null)
            setSelectedFamilyId(installation?.familyId ?? 'custom-local-agent')
            setSelectedInstallationId(installationId)
            requestAnimationFrame(() => localAgentsHeadingRef.current?.focus())
          }}
        />
      )}
    </div>
  )
}
