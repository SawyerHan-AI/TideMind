import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  FolderOpen,
  Pause,
  Play,
  RefreshCw,
  Unplug,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useIPC } from '../../../hooks/useIPC'
import { useFormatters } from '../../../hooks/useFormatters'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import type {
  AgentIntegrationApplyResultDto,
  AgentIntegrationCircuitResetPreviewDto,
  AgentIntegrationDetailDto,
  AgentIntegrationPlanPreviewDto,
} from '../../../lib/api-contract'
import {
  componentLabelKey,
  componentStatusPresentation,
  detailFocusDestination,
  eventTitle,
  managementUnavailableHelpKey,
  nextRovingTabIndex,
  safeDisplayTarget,
  statusReasonKey,
  summarizeExecutionResults,
} from './presentation'
import { AccessBadge, ComponentFact, StatusBadge } from './ManagedPrimitives'
import type { ManagedInstallationDto, ManagedProductFamilyDto, ManagedSnapshotDto } from './types'
import { agentIntegrationsApi, installationsForFamily } from './types'

function DetailSkeleton() {
  return (
    <div className="space-y-3 p-5" aria-hidden>
      <div className="h-6 w-2/3 animate-pulse rounded bg-white/[0.06]" />
      <div className="h-20 animate-pulse rounded-lg bg-white/[0.04]" />
      <div className="h-36 animate-pulse rounded-lg bg-white/[0.04]" />
    </div>
  )
}

function tabDomId(installationId: string): string {
  return installationId.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function installationLabel(
  installation: ManagedInstallationDto,
  defaultProfile: string,
): string {
  return `${installation.variantLabel} · ${installation.profileLabel ?? defaultProfile}`
}

function formatImplementationType(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    skill: 'Skill',
    mcp: 'MCP',
    hook: 'Hook',
    plugin: 'Plugin',
    extension: 'Extension',
    rule: 'Rule',
    config: 'Config',
  }
  return labels[value] ?? value
}

export function ManagedAgentDetail({
  family,
  snapshot,
  selectedInstallationId,
  onSelectInstallation,
  onCloseMobile,
  onChanged,
  onReconnect,
  historyOnly = false,
  showBackButton = false,
  focusBackButton = showBackButton,
}: {
  family: ManagedProductFamilyDto
  snapshot: ManagedSnapshotDto
  selectedInstallationId: string | null
  onSelectInstallation: (installationId: string) => void
  onCloseMobile: () => void
  onChanged: () => void
  onReconnect: (installationId: string) => void
  historyOnly?: boolean
  showBackButton?: boolean
  focusBackButton?: boolean
}) {
  const { t } = useTranslation('settings')
  const { timeAgo } = useFormatters()
  const installations = useMemo(() => installationsForFamily(family, snapshot), [family, snapshot])
  const installationId = selectedInstallationId && installations.some(item => item.id === selectedInstallationId)
    ? selectedInstallationId
    : installations[0]?.id
  const fetchDetail = useCallback(
    () => agentIntegrationsApi().detail(installationId, false),
    [installationId],
  )
  const { data: detail, loading, error, refetch } = useIPC(fetchDetail)
  const [technical, setTechnical] = useState<AgentIntegrationDetailDto['technical'] | null>(null)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmPauseInstallationId, setConfirmPauseInstallationId] = useState<string | null>(null)
  const [disconnectPreview, setDisconnectPreview] = useState<AgentIntegrationPlanPreviewDto | null>(null)
  const [circuitResetPreview, setCircuitResetPreview] = useState<AgentIntegrationCircuitResetPreviewDto | null>(null)
  const [disconnectResult, setDisconnectResult] = useState<AgentIntegrationApplyResultDto | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const retryDetailRef = useRef<HTMLButtonElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const detailPanelRef = useRef<HTMLDivElement>(null)
  const technicalRequestSequence = useRef(0)
  const actionRequestSequence = useRef(0)
  const pendingTabFocusInstallationId = useRef<string | null>(null)
  const activeInstallationId = useRef(installationId)
  activeInstallationId.current = installationId
  const acknowledgedInstallations = useRef(new Set<string>())
  const acknowledgingInstallations = useRef(new Set<string>())

  useEffect(() => {
    if (!focusBackButton) return
    requestAnimationFrame(() => backRef.current?.focus())
  }, [focusBackButton])

  useEffect(() => {
    technicalRequestSequence.current += 1
    actionRequestSequence.current += 1
    setTechnical(null)
    setTechnicalOpen(false)
    setDisconnectPreview(null)
    setCircuitResetPreview(null)
    setDisconnectResult(null)
    setActionError(null)
    setConfirmPauseInstallationId(null)
    setBusyAction(null)
  }, [installationId])

  useEffect(() => {
    const pendingId = pendingTabFocusInstallationId.current
    if (detail?.installation.id !== installationId
      || detailFocusDestination(pendingId, installationId, 'success') !== 'tab') return
    pendingTabFocusInstallationId.current = null
    requestAnimationFrame(() => {
      const tab = tabListRef.current?.querySelector<HTMLButtonElement>(`[data-installation-tab-id="${tabDomId(installationId)}"]`)
      if (tab) tab.focus()
      else detailPanelRef.current?.focus()
    })
  }, [detail, installationId])

  useEffect(() => {
    const pendingId = pendingTabFocusInstallationId.current
    if (!error || detailFocusDestination(pendingId, installationId, 'failure') !== 'retry') return
    pendingTabFocusInstallationId.current = null
    requestAnimationFrame(() => retryDetailRef.current?.focus())
  }, [error, installationId])

  const retryDetail = () => {
    pendingTabFocusInstallationId.current = installationId
    refetch()
  }

  useEffect(() => {
    if (!detail || detail.installation.id !== installationId) return
    if (detail.installation.unreadEventCount <= 0) {
      acknowledgedInstallations.current.delete(installationId)
      return
    }
    if (acknowledgedInstallations.current.has(installationId)) return
    if (acknowledgingInstallations.current.has(installationId)) return
    const targetInstallationId = installationId
    acknowledgingInstallations.current.add(installationId)
    void agentIntegrationsApi().markInstallationEventsRead(targetInstallationId)
      .then(() => {
        acknowledgedInstallations.current.add(targetInstallationId)
        if (activeInstallationId.current === targetInstallationId) {
          refetch()
          onChanged()
          window.dispatchEvent(new CustomEvent('agent-integration-inbox-changed'))
        }
      })
      .catch(() => {
        acknowledgedInstallations.current.delete(targetInstallationId)
      })
      .finally(() => {
        acknowledgingInstallations.current.delete(targetInstallationId)
      })
  }, [detail, installationId, onChanged, refetch])

  const refreshAfterAction = useCallback(() => {
    refetch()
    onChanged()
  }, [onChanged, refetch])

  if ((loading && !detail) || (detail && detail.installation.id !== installationId)) {
    return <DetailSkeleton />
  }
  if (error || !detail) {
    return (
      <div className="p-5 text-xs text-red-300" role="alert">
        {t('agent.managed.detailLoadFailed')}
        <button ref={retryDetailRef} type="button" onClick={retryDetail} className="ml-2 text-indigo-300 hover:text-indigo-200">
          {t('agent.managed.retry')}
        </button>
      </div>
    )
  }

  const installation = detail.installation
  const doAction = async (name: string, action: () => Promise<unknown>) => {
    const targetInstallationId = installation.id
    const requestSequence = ++actionRequestSequence.current
    setBusyAction(name)
    setActionError(null)
    try {
      await action()
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) refreshAfterAction()
    } catch (actionFailure) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setActionError(actionFailure instanceof Error ? actionFailure.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const openDisconnect = async () => {
    const targetInstallationId = installation.id
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('disconnect-preview')
    setActionError(null)
    setDisconnectResult(null)
    try {
      const preview = await agentIntegrationsApi().previewDisconnect(targetInstallationId, false)
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setDisconnectPreview(preview)
    } catch (previewError) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setActionError(previewError instanceof Error ? previewError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const openCircuitReset = async () => {
    const targetInstallationId = installation.id
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('reset-auto-restore-preview')
    setActionError(null)
    try {
      const preview = await agentIntegrationsApi().previewResetAutoRestore(targetInstallationId)
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setCircuitResetPreview(preview)
    } catch (previewError) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setActionError(previewError instanceof Error ? previewError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const executeDisconnect = async (preview: AgentIntegrationPlanPreviewDto) => {
    const targetInstallationId = preview.installations[0]?.installationId
    if (!targetInstallationId || targetInstallationId !== activeInstallationId.current) return
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('disconnect')
    setActionError(null)
    try {
      const result = await agentIntegrationsApi().disconnect(preview.planHash, targetInstallationId)
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setDisconnectResult(result)
        refreshAfterAction()
      }
    } catch (disconnectError) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setActionError(disconnectError instanceof Error ? disconnectError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const loadTechnical = async () => {
    const next = !technicalOpen
    setTechnicalOpen(next)
    if (!next || technical) return
    const requestSequence = ++technicalRequestSequence.current
    setBusyAction('technical')
    try {
      const technicalDetail = await agentIntegrationsApi().detail(installation.id, true)
      if (technicalRequestSequence.current === requestSequence) {
        setTechnical(technicalDetail.technical ?? null)
      }
    } catch (technicalError) {
      if (technicalRequestSequence.current === requestSequence) {
        setActionError(technicalError instanceof Error ? technicalError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (technicalRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = nextRovingTabIndex(index, installations.length, event.key)
    if (nextIndex === null) return
    event.preventDefault()
    const nextInstallation = installations[nextIndex]
    pendingTabFocusInstallationId.current = nextInstallation.id
    onSelectInstallation(nextInstallation.id)
  }

  const selectInstallationTab = (nextInstallationId: string) => {
    if (nextInstallationId === installation.id) return
    pendingTabFocusInstallationId.current = nextInstallationId
    onSelectInstallation(nextInstallationId)
  }

  const selectedTabId = `installation-tab-${tabDomId(installation.id)}`
  const selectedPanelId = `installation-panel-${tabDomId(installation.id)}`
  const accessDetail = (['instruction', 'memory_tools', 'lifecycle'] as const).map(componentKey => {
    const state = installation.components.find(component => component.key === componentKey)?.state ?? 'unsupported'
    return `${t(componentLabelKey(componentKey))}：${t(componentStatusPresentation(state).labelKey)}`
  }).join(' · ')
  const managementUnavailableHelp = t(managementUnavailableHelpKey(installation.statusReason))

  return (
    <div className="min-w-0">
      <div className="border-b border-white/[0.06] p-4">
        <button
          ref={backRef}
          type="button"
          onClick={onCloseMobile}
          className={`mb-3 items-center gap-1 text-xs text-gray-400 hover:text-gray-200 ${historyOnly || showBackButton ? 'inline-flex' : 'hidden'}`}
        >
          <ArrowLeft size={13} aria-hidden />
          {t(historyOnly ? 'agent.managed.backToHistory' : 'agent.managed.backToList')}
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-gray-100">{family.displayName}</h3>
            <p className="mt-1 truncate text-xs text-gray-400">
              {installation.variantLabel} · {installation.profileLabel ?? t('agent.managed.defaultProfile')}
              {installation.version ? ` · v${installation.version}` : ''}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-gray-400">
              {historyOnly
                ? t(statusReasonKey(installation.statusReason))
                : installation.manageable
                ? t(statusReasonKey(installation.statusReason))
                : managementUnavailableHelp}
            </p>
          </div>
          <StatusBadge
            group={installation.statusGroup}
            reason={installation.statusReason}
            compact
            detectOnly={!installation.manageable && !historyOnly}
          />
        </div>
        <div className="mt-3">
          <AccessBadge
            level={installation.accessLevel}
            historical={installation.accessIsHistorical}
            detail={`${historyOnly
              ? t(statusReasonKey(installation.statusReason))
              : installation.manageable
              ? t(statusReasonKey(installation.statusReason))
              : managementUnavailableHelp} · ${accessDetail}`}
          />
        </div>
        {installations.length > 1 && (
          <div ref={tabListRef} className="mt-3 flex flex-wrap gap-1" role="tablist" aria-label={t('agent.managed.installations')}>
            {installations.map((item, index) => {
              const selected = item.id === installation.id
              const itemDomId = tabDomId(item.id)
              return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`installation-tab-${itemDomId}`}
                aria-controls={`installation-panel-${itemDomId}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-installation-tab-id={itemDomId}
                onClick={() => selectInstallationTab(item.id)}
                onKeyDown={event => handleTabKeyDown(event, index)}
                className={`rounded-md border px-2 py-1 text-xs ${selected
                  ? 'border-indigo-400/30 bg-indigo-400/10 text-indigo-200'
                  : 'border-white/[0.06] text-gray-400 hover:text-gray-300'}`}
              >
                {installationLabel(item, t('agent.managed.defaultProfile'))}
              </button>
              )
            })}
          </div>
        )}
      </div>

      <div
        ref={detailPanelRef}
        id={installations.length > 1 ? selectedPanelId : undefined}
        role={installations.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={installations.length > 1 ? selectedTabId : undefined}
        tabIndex={installations.length > 1 ? 0 : -1}
        className="max-h-[min(68vh,680px)] space-y-5 overflow-y-auto p-4"
      >
        <section aria-labelledby={`components-${installation.id}`}>
          <h4 id={`components-${installation.id}`} className="mb-2 text-xs font-medium text-gray-300">
            {t('agent.managed.integrationComponents')}
          </h4>
          <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
            {(['instruction', 'memory_tools', 'lifecycle'] as const).map(componentKey => {
              const component = installation.components.find(candidate => candidate.key === componentKey)
              return (
                <div key={componentKey} className="grid items-center gap-1 text-xs min-[520px]:grid-cols-[minmax(110px,.8fr)_minmax(100px,.8fr)_minmax(0,1.5fr)] min-[520px]:gap-2">
                  <ComponentFact
                    componentKey={componentKey}
                    status={component?.state ?? 'unsupported'}
                    showStatusLabel
                  />
                  <span className="truncate text-gray-400">
                    {component?.implementationTypes.length
                      ? component.implementationTypes.map(formatImplementationType).join(' + ')
                      : '—'}
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 flex-1 truncate font-mono text-gray-400" title={safeDisplayTarget(component?.targetLabel)}>
                      {safeDisplayTarget(component?.targetLabel)}
                    </span>
                    {!historyOnly && component?.targetLabel && component.state !== 'unsupported' && component.state !== 'unconnected' && (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => void doAction(`copy-${componentKey}`, () => agentIntegrationsApi().copyComponentPath(installation.id, componentKey))}
                          disabled={busyAction !== null}
                          aria-label={t('agent.managed.copyComponentPath', { component: t(componentLabelKey(componentKey)) })}
                          className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-gray-200 disabled:opacity-40"
                        >
                          <Copy size={11} aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => void doAction(`reveal-${componentKey}`, () => agentIntegrationsApi().revealComponentPath(installation.id, componentKey))}
                          disabled={busyAction !== null}
                          aria-label={t('agent.managed.revealComponentPath', { component: t(componentLabelKey(componentKey)) })}
                          className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-gray-200 disabled:opacity-40"
                        >
                          <FolderOpen size={11} aria-hidden />
                        </button>
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        <section aria-labelledby={`health-${installation.id}`}>
          <h4 id={`health-${installation.id}`} className="mb-2 text-xs font-medium text-gray-300">
            {t('agent.managed.healthAndActivity')}
          </h4>
          <dl className="grid grid-cols-1 gap-2 text-xs min-[420px]:grid-cols-2">
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.lastVerified')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastVerifiedAt ? timeAgo(installation.lastVerifiedAt) : t('agent.managed.neverVerified')}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.lastRepair')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastRepairedAt ? timeAgo(installation.lastRepairedAt) : t('agent.managed.noRecord')}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.lastDetected')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastDetectedAt ? timeAgo(installation.lastDetectedAt) : t('agent.managed.noRecord')}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.lastUsed')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastRealUseAt ? timeAgo(installation.lastRealUseAt) : t('agent.managed.noReliableUsage')}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby={`events-${installation.id}`}>
          <h4 id={`events-${installation.id}`} className="mb-2 text-xs font-medium text-gray-300">
            {t('agent.managed.recentEvents')}
          </h4>
          {detail.events.length === 0 ? (
            <p className="text-xs text-gray-400">{t('agent.managed.noEvents')}</p>
          ) : (
            <ul className="space-y-1.5">
              {detail.events.slice(0, 8).map(event => {
                const title = eventTitle(event.kind)
                return (
                <li key={event.id} className={`flex gap-2 rounded-lg border p-2.5 text-xs ${event.state === 'unread' ? 'border-sky-400/15 bg-sky-400/[0.06]' : 'border-white/5 bg-white/[0.025]'}`}>
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${event.severity === 'error' ? 'bg-red-400' : event.severity === 'warning' ? 'bg-amber-400' : 'bg-sky-400'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-gray-300">{t(title.key, { defaultValue: title.fallback })}</span>
                    {event.componentKey && (
                      <span className="block text-gray-400">{t(componentLabelKey(event.componentKey))}</span>
                    )}
                    <span className="text-gray-400">{timeAgo(event.createdAt)}</span>
                  </span>
                </li>
                )
              })}
            </ul>
          )}
        </section>

        {!historyOnly && <section aria-labelledby={`management-${installation.id}`}>
          <h4 id={`management-${installation.id}`} className="mb-2 text-xs font-medium text-gray-300">
            {t('agent.managed.management')}
          </h4>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void doAction('refresh', () => agentIntegrationsApi().scan())}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCw size={11} aria-hidden /> {t('agent.managed.recheck')}
            </button>
            {!installation.manageable ? (
              <span
                className="inline-flex items-center rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-400"
                title={managementUnavailableHelp}
              >
                {t('agent.managed.supportMode.detectable')}
              </span>
            ) : installation.statusReason === 'circuit_breaker' ? (
              <button
                type="button"
                onClick={() => void openCircuitReset()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-400/10 disabled:opacity-50"
                title={t('agent.managed.resetAutoRestoreHelp')}
              >
                <RefreshCw size={11} aria-hidden /> {t('agent.managed.resetAutoRestore')}
              </button>
            ) : installation.desiredState === 'disabled' ? (
              <button
                type="button"
                onClick={() => void doAction('resume', () => agentIntegrationsApi().resume(installation.id))}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/20 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-50"
              >
                <Play size={11} aria-hidden /> {t('agent.managed.resume')}
              </button>
            ) : installation.desiredState === 'managed' ? (
              <button
                type="button"
                onClick={() => setConfirmPauseInstallationId(installation.id)}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-400 hover:bg-white/5 disabled:opacity-50"
              >
                <Pause size={11} aria-hidden /> {t('agent.managed.pause')}
              </button>
            ) : null}
            {installation.manageable
            && installation.desiredState === 'unmanaged'
            && installation.statusGroup === 'awaiting_connection' ? (
              <button
                type="button"
                onClick={() => onReconnect(installation.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-400/20 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-400/10"
              >
                <Play size={11} aria-hidden /> {t('agent.managed.reviewAndConnect')}
              </button>
            ) : installation.manageable && installation.desiredState === 'removed' ? (
              <button
                type="button"
                onClick={() => onReconnect(installation.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-400/20 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-400/10"
              >
                <Play size={11} aria-hidden /> {t('agent.managed.reconnect')}
              </button>
            ) : installation.manageable && (installation.desiredState === 'managed' || installation.desiredState === 'disabled') ? (
              <button
                type="button"
                onClick={() => void openDisconnect()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/20 px-3 py-1.5 text-xs text-red-300 hover:bg-red-400/10 disabled:opacity-50"
              >
                <Unplug size={11} aria-hidden /> {t('agent.managed.disconnect')}
              </button>
            ) : null}
          </div>
          {actionError && <p className="mt-2 text-xs text-red-300" role="alert">{actionError}</p>}
          {disconnectResult && (() => {
            const summary = summarizeExecutionResults(disconnectResult.results)
            const detachedSharedVisible = disconnectResult.results.filter(result => (
              result.status === 'committed' && result.completion === 'detached_shared_visible'
            )).length
            const fullyDisconnected = summary.committed - detachedSharedVisible
            return (
              <div className="mt-2 rounded-lg border border-white/[0.07] bg-white/[0.025] p-3 text-xs" role="status">
                <p className="font-medium text-gray-300">{t('agent.managed.disconnectResult')}</p>
                <p className="mt-1 text-gray-400">
                  {fullyDisconnected} {t('agent.managed.disconnectExecution.committed')}
                  {' · '}{detachedSharedVisible} {t('agent.managed.disconnectExecution.detached_shared_visible')}
                  {' · '}{summary.awaitingVerification} {t('agent.managed.disconnectExecution.awaiting_verification')}
                  {' · '}{summary.needsAttention} {t('agent.managed.needsAttention')}
                </p>
                {disconnectResult.results.map(result => result.reason && (
                  <p key={result.installationId} className="mt-1 break-words text-amber-300">{result.reason}</p>
                ))}
              </div>
            )
          })()}
        </section>}

        <section>
          <button
            type="button"
            onClick={() => void loadTechnical()}
            aria-expanded={technicalOpen}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300"
          >
            {technicalOpen ? <ChevronUp size={11} aria-hidden /> : <ChevronDown size={11} aria-hidden />}
            {t('agent.managed.technicalDetails')}
          </button>
          {technicalOpen && (
            <dl className="mt-2 space-y-1 rounded-lg border border-white/[0.06] bg-black/10 p-3 font-mono text-xs text-gray-400">
              {busyAction === 'technical' ? (
                <div>{t('agent.managed.loading')}</div>
              ) : technical ? (
                <>
                  <div><dt className="inline">host_variant: </dt><dd className="inline">{installation.hostVariant}</dd></div>
                  <div><dt className="inline">config_root: </dt><dd className="inline break-all">{safeDisplayTarget(detail.configRootLabel)}</dd></div>
                  <div><dt className="inline">install_key: </dt><dd className="inline break-all">{technical.installKey}</dd></div>
                  <div><dt className="inline">distribution: </dt><dd className="inline">{technical.distributionId ?? '—'}</dd></div>
                  <div><dt className="inline">reconcile: </dt><dd className="inline">{technical.reconcileState}</dd></div>
                  {technical.agentId && <div><dt className="inline">EB_AGENT_ID: </dt><dd className="inline">{technical.agentId}</dd></div>}
                  {technical.latestRun && (
                    <div>
                      <dt className="inline">latest_run: </dt>
                      <dd className="inline break-all">
                        {technical.latestRun.state} · plan {technical.latestRun.planHash} · adapter {technical.latestRun.adapterVersion}
                        {' · '}catalog {technical.latestRun.catalogVersion} · projection {technical.latestRun.projectionVersion}
                        {' · '}selector {technical.latestRun.selectorSchemaVersion}
                      </dd>
                    </div>
                  )}
                  {technical.components.map(component => (
                    <div key={component.componentKey}>
                      <dt className="inline">{component.componentKey}: </dt>
                      <dd className="inline break-all">
                        {component.artifactState ?? '—'} · {safeDisplayTarget(component.targetLabel)}
                        {' · '}selector {component.ownershipSelector ?? '—'}@{component.selectorSchemaVersion ?? '—'}
                        {' · '}projection {component.projectionVersion ?? '—'}
                        {' · '}applied {component.ownedHash ?? '—'} · read {component.observedHash ?? '—'}
                      </dd>
                    </div>
                  ))}
                </>
              ) : <div>{t('agent.managed.noTechnicalDetails')}</div>}
            </dl>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmPauseInstallationId === installation.id}
        onCancel={() => setConfirmPauseInstallationId(null)}
        onConfirm={() => {
          const targetInstallationId = confirmPauseInstallationId
          setConfirmPauseInstallationId(null)
          if (!targetInstallationId || targetInstallationId !== activeInstallationId.current) return
          void doAction('pause', () => agentIntegrationsApi().pause(targetInstallationId))
        }}
        title={t('agent.managed.pauseTitle', { name: installationLabel(installation, t('agent.managed.defaultProfile')) })}
        description={t('agent.managed.pauseDescription')}
        confirmText={t('agent.managed.pause')}
      />
      <ConfirmDialog
        open={circuitResetPreview !== null}
        onCancel={() => setCircuitResetPreview(null)}
        onConfirm={() => {
          const preview = circuitResetPreview
          setCircuitResetPreview(null)
          if (!preview || preview.initiatingInstallationId !== activeInstallationId.current) return
          void doAction('reset-auto-restore', () => (
            agentIntegrationsApi().resetAutoRestore(preview.planHash, preview.initiatingInstallationId)
          ))
        }}
        title={t(circuitResetPreview?.hasSharedArtifacts
          ? 'agent.managed.resetAutoRestoreSharedTitle'
          : 'agent.managed.resetAutoRestoreTitle')}
        description={t('agent.managed.resetAutoRestoreDescription', {
          count: circuitResetPreview?.affectedInstallations.length ?? 0,
          artifacts: circuitResetPreview?.artifactCount ?? 0,
        })}
        confirmText={t('agent.managed.resetAutoRestore')}
      >
        {circuitResetPreview && (
          <ul className="space-y-1.5 text-xs text-gray-400">
            {circuitResetPreview.affectedInstallations.map(item => (
              <li key={item.installationId} className="rounded bg-white/[0.03] px-2 py-1.5">
                <span className="text-gray-300">{item.displayName}</span>
                {' · '}{item.variantLabel} · {item.profileLabel ?? t('agent.managed.defaultProfile')}
                {' · '}{item.componentKeys.map(key => t(componentLabelKey(key))).join(' · ')}
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={disconnectPreview !== null}
        onCancel={() => setDisconnectPreview(null)}
        onConfirm={() => {
          const preview = disconnectPreview
          setDisconnectPreview(null)
          if (!preview) return
          void executeDisconnect(preview)
        }}
        title={t('agent.managed.disconnectTitle', { name: installationLabel(installation, t('agent.managed.defaultProfile')) })}
        description={t('agent.managed.disconnectDescription')}
        confirmText={t('agent.managed.disconnect')}
        danger
      >
        {disconnectPreview && (
          <div className="space-y-2 text-xs text-gray-400">
            {disconnectPreview.installations.flatMap(item => item.targets).map((target, index) => (
              <div key={`${target.componentKey}-${index}`} className="rounded bg-white/[0.03] px-2 py-1.5">
                {t(`agent.managed.targetAction.${target.action}`)} · {safeDisplayTarget(target.targetLabel)}
                {!target.reversible && <span className="ml-1 text-amber-300">{t('agent.managed.notFullyReversible')}</span>}
                {target.sharedImpact && (
                  <div className="mt-2 rounded border border-amber-400/15 bg-amber-400/[0.05] p-2 text-amber-200">
                    <p>{t(target.sharedImpact.remainsVisibleForCurrentInstallation
                      ? 'agent.managed.sharedDisconnectStillVisible'
                      : 'agent.managed.sharedDisconnectRetained')}</p>
                    <p className="mt-1 text-gray-400">{t('agent.managed.sharedDisconnectConsumers')}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-gray-300">
                      {target.sharedImpact.consumers.map(consumer => (
                        <li key={`${consumer.installationId}-${consumer.componentKey}`}>
                          {consumer.displayName} · {t(componentLabelKey(consumer.componentKey))}
                          {' · '}{consumer.variantLabel} · {consumer.profileLabel ?? t('agent.managed.defaultProfile')}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
