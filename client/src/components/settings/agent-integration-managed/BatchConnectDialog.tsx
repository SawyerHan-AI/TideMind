import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, ChevronDown, ChevronUp, CircleDashed, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AgentIntegrationApplyResultDto,
  AgentIntegrationApplyTaskDto,
  AgentIntegrationInstallationDto,
  AgentIntegrationPlanInstallationDto,
  AgentIntegrationPlanPreviewDto,
  AgentIntegrationSnapshotDto,
} from '../../../lib/api-contract'
import { acquireModalInert } from '../../../lib/modal-inert'
import {
  canCloseBatchDialog,
  executionInstallationIds,
  safeDisplayTarget,
  summarizeExecutionResults,
} from './presentation'
import { agentIntegrationsApi } from './types'

type DialogStep = 'select' | 'preview' | 'execute'

function isLowRiskDefault(item: AgentIntegrationPlanInstallationDto): boolean {
  return item.requiredUserActions.length === 0
    && item.targets.length > 0
    && item.targets.every(target =>
      (target.risk === 'read_only' || target.risk === 'low')
      && target.reversible
      && target.scope === 'user'
      && Boolean(target.targetLabel)
      && target.commandCategory !== 'host_trust'
      && target.commandCategory !== 'admin'
      && target.commandCategory !== 'plugin_install',
    )
}

function requestedConnectCandidateIds(
  requestedInstallationIds: readonly string[] | undefined,
  installations: readonly AgentIntegrationInstallationDto[],
): string[] {
  return requestedInstallationIds?.length
    ? requestedInstallationIds.filter(id => installations.some(item => item.id === id && item.manageable))
    : installations
      .filter(item => item.manageable && item.statusGroup === 'awaiting_connection')
      .map(item => item.id)
}

function resultTone(status: AgentIntegrationApplyResultDto['results'][number]['status']) {
  if (status === 'committed') return 'text-emerald-300'
  if (status === 'needs_recovery' || status === 'failed') return 'text-red-300'
  return 'text-amber-300'
}

function installationIdentityLabel(
  snapshot: AgentIntegrationSnapshotDto,
  installationId: string,
  defaultProfile: string,
): string {
  const installation = snapshot.installations.find(item => item.id === installationId)
  return installation
    ? `${installation.variantLabel} · ${installation.profileLabel ?? defaultProfile}`
    : installationId
}

export function BatchConnectDialog({
  open,
  snapshot,
  requestedInstallationIds,
  onClose,
  onComplete,
  onTaskUpdate,
  fallbackFocusRef,
}: {
  open: boolean
  snapshot: AgentIntegrationSnapshotDto
  requestedInstallationIds?: readonly string[]
  onClose: () => void
  onComplete: () => void
  onTaskUpdate: (task: AgentIntegrationApplyTaskDto) => void
  fallbackFocusRef?: React.RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation('settings')
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const stepContentRef = useRef<HTMLDivElement>(null)
  const previousStepRef = useRef<DialogStep>('select')
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const openedRef = useRef(false)
  const openRef = useRef(open)
  const dialogSessionSequence = useRef(0)
  const technicalRequestSequence = useRef(0)
  const confirmedPlanHashRef = useRef<string | null>(null)
  const taskIdRef = useRef<string | null>(null)
  const completedTaskIdsRef = useRef(new Set<string>())
  openRef.current = open
  const [step, setStep] = useState<DialogStep>('select')
  const [initialPreview, setInitialPreview] = useState<AgentIntegrationPlanPreviewDto | null>(null)
  const [confirmedPreview, setConfirmedPreview] = useState<AgentIntegrationPlanPreviewDto | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [withoutLifecycle, setWithoutLifecycle] = useState<Set<string>>(new Set())
  const [confirmedIds, setConfirmedIds] = useState<string[]>([])
  const [execution, setExecution] = useState<AgentIntegrationApplyResultDto | null>(null)
  const [applyTask, setApplyTask] = useState<AgentIntegrationApplyTaskDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [technicalOpen, setTechnicalOpen] = useState<Set<string>>(new Set())
  const [technicalPreview, setTechnicalPreview] = useState<AgentIntegrationPlanPreviewDto | null>(null)
  const [technicalLoading, setTechnicalLoading] = useState(false)
  confirmedPlanHashRef.current = confirmedPreview?.planHash ?? null

  const invalidateTechnical = () => {
    technicalRequestSequence.current += 1
    setTechnicalOpen(new Set())
    setTechnicalPreview(null)
    setTechnicalLoading(false)
  }

  const candidateIds = useMemo(() => requestedConnectCandidateIds(
    requestedInstallationIds,
    snapshot.installations,
  ), [requestedInstallationIds, snapshot.installations])

  const loadInitialPreview = useCallback(async () => {
    if (candidateIds.length === 0) {
      if (requestedInstallationIds?.length) {
        setInitialPreview(null)
        setError(t('agent.managed.requestedInstallationsUnavailable'))
      }
      return
    }
    setLoading(true)
    setError(null)
    try {
      const preview = await agentIntegrationsApi().previewConnect(candidateIds, false)
      setInitialPreview(preview)
      setSelected(new Set(preview.installations.filter(isLowRiskDefault).map(item => item.installationId)))
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : t('agent.managed.unknownError'))
    } finally {
      setLoading(false)
    }
  }, [candidateIds, requestedInstallationIds, t])

  useEffect(() => {
    if (!open) {
      openedRef.current = false
      dialogSessionSequence.current += 1
      technicalRequestSequence.current += 1
      return
    }
    if (openedRef.current) return
    openedRef.current = true
    dialogSessionSequence.current += 1
    technicalRequestSequence.current += 1
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setStep('select')
    setInitialPreview(null)
    setConfirmedPreview(null)
    setExecution(null)
    setApplyTask(null)
    setSelected(new Set())
    setWithoutLifecycle(new Set())
    setConfirmedIds([])
    taskIdRef.current = null
    setError(null)
    setTechnicalOpen(new Set())
    setTechnicalPreview(null)
    setTechnicalLoading(false)
    void loadInitialPreview()
    requestAnimationFrame(() => {
      const close = closeRef.current
      if (close && !close.disabled) close.focus()
      else stepContentRef.current?.focus()
    })
  }, [loadInitialPreview, open])

  useLayoutEffect(() => {
    if (!open || step !== 'select' || loading || !initialPreview) return
    const active = document.activeElement
    if (!dialogRef.current?.contains(active) || active === stepContentRef.current) {
      closeRef.current?.focus()
    }
  }, [initialPreview, loading, open, step])

  useLayoutEffect(() => {
    if (!open || previousStepRef.current === step) return
    previousStepRef.current = step
    stepContentRef.current?.focus()
  }, [open, step])

  useEffect(() => {
    if (!open) return
    return acquireModalInert(document.getElementById('root'))
  }, [open])

  useEffect(() => agentIntegrationsApi().onTaskProgress(task => {
    if (task.id !== taskIdRef.current) return
    setApplyTask(task)
    setExecution({ planHash: task.planHash, results: task.results })
    onTaskUpdate(task)
    if (task.state === 'completed' && !completedTaskIdsRef.current.has(task.id)) {
      completedTaskIdsRef.current.add(task.id)
      onComplete()
    }
  }), [onComplete, onTaskUpdate])

  const closeDialog = useCallback(() => {
    dialogSessionSequence.current += 1
    technicalRequestSequence.current += 1
    onClose()
  }, [onClose])

  useEffect(() => {
    if (open) return
    const previous = previousFocusRef.current
    if (!previous) return
    const executionMayChangeTrigger = execution !== null
    if (!executionMayChangeTrigger && previous.isConnected) previous.focus()
    else fallbackFocusRef?.current?.focus()
    previousFocusRef.current = null
  }, [execution, fallbackFocusRef, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!canCloseBatchDialog(loading && step !== 'execute')) return
        event.stopPropagation()
        closeDialog()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closeDialog, loading, open, step])

  if (!open) return null

  const continueToPreview = async () => {
    const ids = [...selected].sort()
    if (ids.length === 0) return
    setLoading(true)
    setError(null)
    invalidateTechnical()
    try {
      const preview = await agentIntegrationsApi().previewConnect(ids, false, undefined, {
        withoutLifecycleInstallationIds: [...withoutLifecycle].filter(id => selected.has(id)),
      })
      setConfirmedPreview(preview)
      setConfirmedIds(ids)
      setStep('preview')
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : t('agent.managed.unknownError'))
    } finally {
      setLoading(false)
    }
  }

  const applyPlan = async () => {
    if (!confirmedPreview) return
    setLoading(true)
    setError(null)
    invalidateTechnical()
    setStep('execute')
    try {
      const task = await agentIntegrationsApi().startApplyConnect(confirmedPreview.planHash, confirmedIds)
      taskIdRef.current = task.id
      setApplyTask(task)
      setExecution({ planHash: task.planHash, results: task.results })
      onTaskUpdate(task)
      setLoading(false)
      // The preload listener is registered before React. Read the task back as
      // well so an extremely fast completion cannot be lost between invoke and
      // the renderer committing its task id.
      const latest = await agentIntegrationsApi().getApplyTask(task.id)
      if (taskIdRef.current === latest.id) {
        setApplyTask(latest)
        setExecution({ planHash: latest.planHash, results: latest.results })
        onTaskUpdate(latest)
        if (latest.state === 'completed' && !completedTaskIdsRef.current.has(latest.id)) {
          completedTaskIdsRef.current.add(latest.id)
          onComplete()
        }
      }
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : t('agent.managed.unknownError'))
    } finally {
      setLoading(false)
    }
  }

  const retryFailed = async () => {
    const failedIds = execution ? executionInstallationIds(execution.results, 'failed') : []
    if (failedIds.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const next = await agentIntegrationsApi().previewConnect(failedIds, false)
      setInitialPreview(next)
      setConfirmedPreview(null)
      setExecution(null)
      setSelected(new Set(failedIds))
      setWithoutLifecycle(current => new Set([...current].filter(id => failedIds.includes(id))))
      setConfirmedIds([])
      invalidateTechnical()
      setStep('select')
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : t('agent.managed.unknownError'))
    } finally {
      setLoading(false)
    }
  }

  const regenerateRecovery = async () => {
    const recoveryIds = execution ? executionInstallationIds(execution.results, 'needs_recovery') : []
    if (recoveryIds.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const next = await agentIntegrationsApi().previewConnect(recoveryIds, false)
      setInitialPreview(next)
      setConfirmedPreview(null)
      setExecution(null)
      setSelected(new Set(recoveryIds))
      setWithoutLifecycle(current => new Set([...current].filter(id => recoveryIds.includes(id))))
      setConfirmedIds([])
      invalidateTechnical()
      setStep('select')
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : t('agent.managed.unknownError'))
    } finally {
      setLoading(false)
    }
  }

  const reloadCurrentSelection = async () => {
    const ids = selected.size > 0 ? [...selected] : candidateIds
    if (ids.length === 0) return
    setLoading(true)
    setError(null)
    invalidateTechnical()
    setInitialPreview(null)
    setConfirmedPreview(null)
    setConfirmedIds([])
      setExecution(null)
      setApplyTask(null)
      setStep('select')
    try {
      const next = await agentIntegrationsApi().previewConnect(ids, false)
      setInitialPreview(next)
      setSelected(new Set(ids))
      setWithoutLifecycle(current => new Set([...current].filter(id => ids.includes(id))))
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : t('agent.managed.unknownError'))
    } finally {
      setLoading(false)
    }
  }

  const toggleTechnical = async (installationId: string) => {
    const isOpen = technicalOpen.has(installationId)
    setTechnicalOpen(current => {
      const next = new Set(current)
      if (isOpen) next.delete(installationId)
      else next.add(installationId)
      return next
    })
    if (isOpen || technicalPreview || !confirmedPreview) return
    const sessionSequence = dialogSessionSequence.current
    const requestSequence = ++technicalRequestSequence.current
    const frozenPlanHash = confirmedPreview.planHash
    setTechnicalLoading(true)
    setError(null)
    try {
      const next = await agentIntegrationsApi().previewConnect(
        confirmedIds,
        true,
        frozenPlanHash,
      )
      if (!openRef.current
        || dialogSessionSequence.current !== sessionSequence
        || technicalRequestSequence.current !== requestSequence
        || confirmedPlanHashRef.current !== frozenPlanHash) return
      if (next.planHash !== frozenPlanHash) {
        setInitialPreview(next)
        setConfirmedPreview(null)
        setStep('select')
        setError(t('agent.managed.planChanged'))
        setTechnicalOpen(new Set())
        return
      }
      setTechnicalPreview(next)
    } catch (previewError) {
      if (openRef.current
        && dialogSessionSequence.current === sessionSequence
        && technicalRequestSequence.current === requestSequence
        && confirmedPlanHashRef.current === frozenPlanHash) {
        setError(previewError instanceof Error ? previewError.message : t('agent.managed.unknownError'))
        setTechnicalOpen(new Set())
      }
    } finally {
      if (openRef.current
        && dialogSessionSequence.current === sessionSequence
        && technicalRequestSequence.current === requestSequence
        && confirmedPlanHashRef.current === frozenPlanHash) setTechnicalLoading(false)
    }
  }

  const preview = step === 'select' ? initialPreview : confirmedPreview
  const executionSummary = execution ? summarizeExecutionResults(execution.results) : null
  const titleId = 'managed-agent-connect-title'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center min-[720px]:p-6">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={loading || applyTask?.state === 'running'}
        className="relative flex h-full w-full flex-col border-white/10 bg-[#151523] shadow-2xl min-[720px]:h-auto min-[720px]:max-h-[86vh] min-[720px]:max-w-2xl min-[720px]:rounded-2xl min-[720px]:border"
      >
        <header className="flex items-start justify-between border-b border-white/[0.07] px-5 py-4">
          <div>
            <h3 id={titleId} className="text-sm font-semibold text-gray-100">{t('agent.managed.connectTitle')}</h3>
            <p className="mt-1 text-xs text-gray-400">
              {t('agent.managed.stepProgress', { current: step === 'select' ? 1 : step === 'preview' ? 2 : 3, total: 3 })}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={closeDialog}
            disabled={loading && step !== 'execute'}
            aria-label={t('agent.managed.close')}
            className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-gray-200 disabled:opacity-40"
          >
            <XCircle size={17} aria-hidden />
          </button>
        </header>

        <div ref={stepContentRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 focus:outline-none">
          {loading && preview && step !== 'execute' && (
            <p className="mb-3 flex items-center gap-2 text-xs text-indigo-200" role="status" aria-live="polite">
              <CircleDashed size={13} className="animate-spin" aria-hidden />
              {t('agent.managed.loadingPlan')}
            </p>
          )}
          {step === 'select' && (
            <div>
              <p className="mb-4 text-xs leading-relaxed text-gray-400">
                {t('agent.managed.selectDescription', { count: candidateIds.length })}
              </p>
              {loading && !preview ? (
                <div className="space-y-2" aria-label={t('agent.managed.loadingPlan')}>
                  {[0, 1, 2].map(item => <div key={item} className="h-20 animate-pulse rounded-lg bg-white/[0.04]" />)}
                </div>
              ) : (
                <div className="space-y-2">
                  {preview?.installations.map(item => {
                    const checked = selected.has(item.installationId)
                    return (
                      <div key={item.installationId} className={`rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 ${loading ? 'opacity-70' : 'hover:bg-white/[0.035]'}`}>
                        <label className={`flex gap-3 ${loading ? 'cursor-wait' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={loading}
                            onChange={() => setSelected(current => {
                              const next = new Set(current)
                              if (checked) next.delete(item.installationId)
                              else next.add(item.installationId)
                              return next
                            })}
                            className="mt-0.5 h-4 w-4 accent-indigo-500"
                          />
                          <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-gray-200">{item.displayName}</span>
                            <span className="text-xs text-indigo-300">{t(`agent.managed.targetAccess.${item.desiredCapability}`)}</span>
                          </span>
                          <span className="mt-1 block text-xs text-gray-400">
                            {installationIdentityLabel(snapshot, item.installationId, t('agent.managed.defaultProfile'))} · {item.componentKeys.map(key => t(`agent.managed.component.${key === 'memory_tools' ? 'memoryTools' : key}`)).join(' · ')}
                          </span>
                          <span className="mt-1 block text-xs text-gray-400">
                            {item.targets.map(target => [
                              t(`agent.managed.scope.${target.scope}`),
                              safeDisplayTarget(target.targetLabel),
                              t(`agent.managed.commandCategory.${target.commandCategory}`),
                              t(`agent.managed.risk.${target.risk}`),
                            ].join(' · ')).join(' / ')}
                          </span>
                          {item.requiredUserActions.length > 0 && (
                            <span className="mt-1 block text-xs text-amber-300">{item.requiredUserActions.join(' · ')}</span>
                          )}
                          </span>
                        </label>
                        {item.componentKeys.includes('lifecycle') && (
                          <label className="ml-7 mt-2 flex items-start gap-2 rounded-lg bg-white/[0.025] p-2 text-xs text-gray-400">
                            <input
                              type="checkbox"
                              checked={!withoutLifecycle.has(item.installationId)}
                              disabled={loading || !checked}
                              onChange={event => setWithoutLifecycle(current => {
                                const next = new Set(current)
                                if (event.target.checked) next.delete(item.installationId)
                                else next.add(item.installationId)
                                return next
                              })}
                              className="mt-0.5 h-3.5 w-3.5 accent-indigo-500"
                            />
                            <span>
                              <span className="block text-gray-300">{t('agent.managed.includeLifecycle')}</span>
                              <span className="mt-0.5 block">{t('agent.managed.includeLifecycleHelp')}</span>
                            </span>
                          </label>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {step === 'preview' && confirmedPreview && (
            <div>
              <p className="mb-4 text-xs leading-relaxed text-gray-400">{t('agent.managed.previewDescription')}</p>
              <div className="space-y-3">
                {confirmedPreview.installations.map(item => (
                  <section key={item.installationId} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                    <h4 className="text-xs font-medium text-gray-200">{item.displayName}</h4>
                    <p className="mt-1 text-xs text-gray-400">
                      {installationIdentityLabel(snapshot, item.installationId, t('agent.managed.defaultProfile'))}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      {t('agent.managed.changeSummary', { components: item.componentKeys.length, targets: item.targets.length })}
                    </p>
                    <div className="mt-2 space-y-1.5">
                      {item.targets.map((target, index) => (
                        <div key={`${target.componentKey}-${index}`} className="grid gap-1 rounded-lg bg-white/[0.025] px-2 py-1.5 text-xs sm:grid-cols-[80px_1fr_auto] sm:gap-2">
                          <span className="text-gray-400">{t(`agent.managed.component.${target.componentKey === 'memory_tools' ? 'memoryTools' : target.componentKey}`)}</span>
                          <span className="truncate font-mono text-gray-400">{safeDisplayTarget(target.targetLabel)}</span>
                          <span className={target.risk === 'high' || target.risk === 'elevated' ? 'text-amber-300' : 'text-gray-400'}>
                            {t(`agent.managed.scope.${target.scope}`)} · {t(`agent.managed.commandCategory.${target.commandCategory}`)} · {t(`agent.managed.risk.${target.risk}`)} · {t(target.reversible ? 'agent.managed.reversible' : 'agent.managed.notReversible')}
                          </span>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => void toggleTechnical(item.installationId)}
                      aria-expanded={technicalOpen.has(item.installationId)}
                      className="mt-2 flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300"
                    >
                      {technicalOpen.has(item.installationId) ? <ChevronUp size={11} aria-hidden /> : <ChevronDown size={11} aria-hidden />}
                      {t('agent.managed.technicalDetails')}
                    </button>
                    {technicalOpen.has(item.installationId) && (
                      <div className="mt-2 space-y-1 rounded bg-black/10 p-2 font-mono text-xs text-gray-400">
                        {technicalLoading && !technicalPreview ? (
                          <div>{t('agent.managed.loading')}</div>
                        ) : (technicalPreview?.installations.find(candidate => candidate.installationId === item.installationId)?.targets ?? []).map((target, index) => (
                          <div key={`${target.componentKey}-${index}`} className="break-all">
                            <span>{target.selector ?? safeDisplayTarget(target.targetLabel)}</span>
                            {target.executableLabel && <span> · {safeDisplayTarget(target.executableLabel)}</span>}
                            {target.args?.length ? <span> · {target.args.map(argument => safeDisplayTarget(argument)).join(' ')}</span> : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>
              <p className="mt-4 rounded-lg border border-indigo-400/15 bg-indigo-400/[0.06] p-3 text-xs leading-relaxed text-indigo-200">
                {t('agent.managed.consentBoundary')}
              </p>
            </div>
          )}

          {step === 'execute' && (
            <div>
              <p className="mb-4 text-xs text-gray-400">{applyTask?.state === 'running' ? t('agent.managed.connectingAndVerifying') : t('agent.managed.executionComplete')}</p>
              {executionSummary && (
                <p className="mb-3 text-xs text-gray-300" aria-live="polite">
                  {executionSummary.total}
                  {' · '}{executionSummary.committed} {t('agent.managed.execution.committed')}
                  {' · '}{executionSummary.awaitingVerification} {t('agent.managed.execution.awaiting_verification')}
                  {' · '}{executionSummary.needsAttention} {t('agent.managed.needsAttention')}
                </p>
              )}
              <div className="space-y-2" aria-live="polite">
                {applyTask?.pendingInstallationIds.map(installationId => {
                  const item = confirmedPreview?.installations.find(candidate => candidate.installationId === installationId)
                  if (!item) return null
                  return (
                  <div key={item.installationId} className="rounded-lg bg-white/[0.025] px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <CircleDashed size={14} className="animate-spin text-indigo-300" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-gray-300">
                        {item.displayName} · {installationIdentityLabel(snapshot, item.installationId, t('agent.managed.defaultProfile'))}
                      </span>
                      <span className="text-indigo-300">{t('agent.managed.execution.in_progress')}</span>
                    </div>
                  </div>
                  )
                })}
                {execution?.results.map(item => {
                  const displayName = confirmedPreview?.installations.find(candidate => candidate.installationId === item.installationId)?.displayName ?? item.installationId
                  const name = `${displayName} · ${installationIdentityLabel(snapshot, item.installationId, t('agent.managed.defaultProfile'))}`
                  return (
                    <div key={item.installationId} className="rounded-lg bg-white/[0.025] px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        {item.status === 'committed'
                          ? <CheckCircle2 size={14} className="text-emerald-300" aria-hidden />
                          : <CircleDashed size={14} className={resultTone(item.status)} aria-hidden />}
                        <span className="min-w-0 flex-1 truncate text-gray-300">{name}</span>
                        <span className={`text-xs ${resultTone(item.status)}`}>{t(`agent.managed.execution.${item.status}`)}</span>
                      </div>
                      {'reason' in item && item.reason && (
                        <p className="mt-1 break-words pl-[22px] text-xs leading-relaxed text-gray-400">{item.reason}</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-xs text-red-300" role="alert">{error}</p>}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-white/[0.07] px-5 py-4">
          <button
            type="button"
            onClick={step === 'preview' ? () => {
              invalidateTechnical()
              setConfirmedPreview(null)
              setConfirmedIds([])
              setStep('select')
            } : closeDialog}
            disabled={!canCloseBatchDialog(loading && step !== 'execute')}
            className="px-3 py-2 text-xs text-gray-400 hover:text-gray-300 disabled:cursor-wait disabled:opacity-40"
          >
            {step === 'preview' ? t('agent.managed.back') : step === 'execute' ? t('agent.managed.close') : t('agent.managed.later')}
          </button>
          {step === 'select' && (
            <div className="flex items-center gap-2">
              {error && !initialPreview && (
                <button
                  type="button"
                  onClick={() => void loadInitialPreview()}
                  disabled={loading}
                  className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-40"
                >
                  {t('agent.managed.retry')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void continueToPreview()}
                disabled={loading || selected.size === 0}
                className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('agent.managed.continueWithCount', { count: selected.size })}
              </button>
            </div>
          )}
          {step === 'preview' && (
            <button
              type="button"
              onClick={() => void applyPlan()}
              disabled={loading}
              className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-40"
            >
              {t('agent.managed.connectCount', { count: confirmedIds.length })}
            </button>
          )}
          {step === 'execute' && applyTask?.state !== 'running' && !loading && (
            <div className="flex items-center gap-2">
              {error && !execution && (
                <button
                  type="button"
                  onClick={() => void reloadCurrentSelection()}
                  className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-300 hover:bg-white/5"
                >
                  {t('agent.managed.regeneratePlan')}
                </button>
              )}
              {execution?.results.some(result => result.status === 'failed') && (
                <button
                  type="button"
                  onClick={() => void retryFailed()}
                  className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-300 hover:bg-white/5"
                >
                  {t('agent.managed.retryFailedCount', { count: execution.results.filter(result => result.status === 'failed').length })}
                </button>
              )}
              {execution?.results.some(result => result.status === 'needs_recovery') && (
                <button
                  type="button"
                  onClick={() => void regenerateRecovery()}
                  className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-300 hover:bg-white/5"
                >
                  {t('agent.managed.regenerateRecoveryCount', {
                    count: execution.results.filter(result => result.status === 'needs_recovery').length,
                  })}
                </button>
              )}
              <button type="button" onClick={closeDialog} className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-400">
                {t('agent.managed.done')}
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}

export { isLowRiskDefault, requestedConnectCandidateIds }
