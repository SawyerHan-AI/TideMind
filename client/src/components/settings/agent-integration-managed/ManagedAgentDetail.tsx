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
  AgentIntegrationSourceRetryDto,
  AgentIntegrationCircuitResetPreviewDto,
  AgentIntegrationCodexTrustReviewDto,
  AgentIntegrationCodexTrustResultDto,
  AgentIntegrationDetailDto,
  AgentIntegrationGuidedRemovalResultDto,
  AgentIntegrationGuidedRemovalReviewDto,
  AgentIntegrationPlanPreviewDto,
} from '../../../lib/api-contract'
import {
  componentLabelKey,
  componentStatusPresentation,
  detailFocusDestination,
  eventTitle,
  managementUnavailableHelpKey,
  nextRovingTabIndex,
  requiredUserActionDetailKey,
  requiredUserActionPresentation,
  safeDisplayTarget,
  statusReasonKey,
  deactivationNoticeKey,
  summarizeExecutionResults,
} from './presentation'
import { RequiredUserActionDetail } from './RequiredUserActionDetail'
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
  const sourceTaskState = detail?.installation.sourceVerification?.task?.state
  useEffect(() => {
    if (sourceTaskState !== 'checking' && sourceTaskState !== 'queued') return
    const timer = window.setTimeout(refetch, 2_000)
    return () => window.clearTimeout(timer)
  }, [detail, sourceTaskState, refetch])
  const [technical, setTechnical] = useState<AgentIntegrationDetailDto['technical'] | null>(null)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [sourceRetry, setSourceRetry] = useState<{ installationId: string; result: AgentIntegrationSourceRetryDto } | null>(null)
  const [confirmPauseInstallationId, setConfirmPauseInstallationId] = useState<string | null>(null)
  const [legacyCandidates,setLegacyCandidates]=useState<{agentId:string;name:string}[]>([])
  const [legacySelected,setLegacySelected]=useState('')
  const [legacyPreview,setLegacyPreview]=useState<AgentIntegrationPlanPreviewDto|null>(null)
  const [disconnectPreview, setDisconnectPreview] = useState<AgentIntegrationPlanPreviewDto | null>(null)
  const [circuitResetPreview, setCircuitResetPreview] = useState<AgentIntegrationCircuitResetPreviewDto | null>(null)
  const [disconnectResult, setDisconnectResult] = useState<AgentIntegrationApplyResultDto | null>(null)
  const [codexTrustReview, setCodexTrustReview] = useState<AgentIntegrationCodexTrustReviewDto | null>(null)
  const [codexTrustResult, setCodexTrustResult] = useState<AgentIntegrationCodexTrustResultDto | null>(null)
  const [guidedRemovalReview, setGuidedRemovalReview] = useState<AgentIntegrationGuidedRemovalReviewDto | null>(null)
  const [guidedRemovalResult, setGuidedRemovalResult] = useState<AgentIntegrationGuidedRemovalResultDto | null>(null)
  const codexTrustConfirmRef = useRef<HTMLButtonElement>(null)
  const codexTrustStatusRef = useRef<HTMLParagraphElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const retryDetailRef = useRef<HTMLButtonElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const requiredActionText = useCallback((action: string) => {
    const presentation = requiredUserActionPresentation(action)
    return t(presentation.labelKey, {
      ...(presentation.count === undefined ? {} : { count: presentation.count }),
      ...(presentation.componentKey === undefined
        ? {}
        : { component: t(componentLabelKey(presentation.componentKey)) }),
    })
  }, [t])
  const detailPanelRef = useRef<HTMLDivElement>(null)
  const technicalRequestSequence = useRef(0)
  const actionRequestSequence = useRef(0)
  const pendingTabFocusInstallationId = useRef<string | null>(null)
  const activeInstallationId = useRef(installationId)
  const installationSnapshotState = JSON.stringify(snapshot.installations.find(item => item.id === installationId))
  const detailSnapshotRef = useRef({ id: installationId, state: installationSnapshotState })
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
    setLegacyCandidates([])
    setLegacySelected('')
    setLegacyPreview(null)
    setDisconnectPreview(null)
    setCircuitResetPreview(null)
    setDisconnectResult(null)
    setCodexTrustReview(null)
    setCodexTrustResult(null)
    setGuidedRemovalReview(null)
    setGuidedRemovalResult(null)
    setActionError(null)
    setConfirmPauseInstallationId(null)
    setBusyAction(null)
  }, [installationId])

  useEffect(() => {
    const previous = detailSnapshotRef.current
    detailSnapshotRef.current = { id: installationId, state: installationSnapshotState }
    // Selection changes already cause useIPC(fetchDetail) to reload. Background
    // changes to another connection should not inspect this host again.
    if (previous.id !== installationId || previous.state === installationSnapshotState) return
    refetch()
  }, [refetch, installationId, installationSnapshotState])

  useEffect(() => {
    if (codexTrustReview?.status !== 'action_required') return
    requestAnimationFrame(() => codexTrustConfirmRef.current?.focus())
  }, [codexTrustReview])

  useEffect(() => {
    if (codexTrustReview?.status !== 'already_recorded' && !codexTrustResult) return
    requestAnimationFrame(() => codexTrustStatusRef.current?.focus())
  }, [codexTrustResult, codexTrustReview])

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

  const backNavigation = (
    <button
      ref={backRef}
      type="button"
      onClick={onCloseMobile}
      className={`mb-3 items-center gap-1 text-xs text-gray-400 hover:text-gray-200 ${historyOnly || showBackButton ? 'inline-flex' : 'hidden'}`}
    >
      <ArrowLeft size={13} aria-hidden />
      {t(historyOnly ? 'agent.managed.backToHistory' : 'agent.managed.backToList')}
    </button>
  )

  if ((loading && !detail) || (detail && detail.installation.id !== installationId)) {
    return <div className="min-w-0"><div className="border-b border-white/[0.06] p-4">{backNavigation}</div><DetailSkeleton /></div>
  }
  if (error || !detail) {
    return (
      <div className="min-w-0">
        <div className="border-b border-white/[0.06] p-4">{backNavigation}</div>
        <div className="p-4 text-xs text-red-300" role="alert">
          {t('agent.managed.detailLoadFailed')}
          <button ref={retryDetailRef} type="button" onClick={retryDetail} className="ml-2 text-indigo-300 hover:text-indigo-200">
            {t('agent.managed.retry')}
          </button>
        </div>
      </div>
    )
  }

  const installation = detail.installation
  // Only memory diagnostics are connection-wide. Account and lifecycle facts
  // below remain attached to the selected host.
  const diagnostic = family.connection?.shared ? family.connection.diagnostic : installation.diagnostic
  const diagnosticMembers = family.connection?.shared
    ? snapshot.installations.filter(member => family.connection!.installationIds.includes(member.id))
    : [installation]
  const diagnosticTarget = diagnosticMembers.find(member => member.manageable && member.desiredState === 'managed'
    && member.deactivation?.bridge !== 'stopped' && member.deactivation?.maintenance !== 'paused'
    && ['codex-cli', 'claude-code-cli', 'claude-code-native'].includes(member.hostVariant))
  const hostLifecycle = installation.components.find(component => component.key === 'lifecycle')
  const sharedLifecycle = family.connection?.components.find(component => component.key === 'lifecycle')
  const nativeTrustKnown = family.connection?.shared
    ? Boolean(sharedLifecycle?.hostRecognitionVerified && !sharedLifecycle.hostRecognitionRejected && sharedLifecycle.configurationFingerprint
      && sharedLifecycle.configurationFingerprint === hostLifecycle?.configurationFingerprint)
    : Boolean(hostLifecycle?.hostRecognitionVerified && !hostLifecycle.hostRecognitionRejected)
  const currentRequiredActions = detail.requiredUserActionDetails?.filter(action => action.kind !== 'codex_hook_trust' || (installation.manageable && hostLifecycle?.state === 'confirmation_required' && !nativeTrustKnown)) ?? []

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

  const openDisconnect = async (wholeConnection = false) => {
    const targetInstallationId = installation.id
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('disconnect-preview')
    setActionError(null)
    setDisconnectResult(null)
    try {
      const preview = wholeConnection && family.connection
        ? await agentIntegrationsApi().previewConnectionDisconnect(family.connection.id)
        : await agentIntegrationsApi().previewDisconnect(targetInstallationId, false)
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

  const runLegacySelection = async (action:'review'|'preview'|'apply') => {
    const id=installation.id
    const sequence=++actionRequestSequence.current
    setBusyAction('legacy-'+action);setActionError(null)
    try{
      if(action==='review'){
        const review=await agentIntegrationsApi().reviewCodexLegacySelection(id)
        if(activeInstallationId.current===id && actionRequestSequence.current===sequence){setLegacyCandidates(review.candidates);setLegacySelected(review.candidates[0]?.agentId ?? '');setLegacyPreview(null)}
      }else if(action==='preview'){
        const preview=await agentIntegrationsApi().previewCodexLegacySelection(id,legacySelected)
        if(activeInstallationId.current===id && actionRequestSequence.current===sequence)setLegacyPreview(preview)
      }else if(legacyPreview){
        const preview=legacyPreview;setLegacyPreview(null)
        const result=await agentIntegrationsApi().applyConnect(preview.planHash,[id])
        const failure=result.results.find(item=>item.status==='failed')
        if(failure)throw new Error(failure.reason)
        if(activeInstallationId.current===id && actionRequestSequence.current===sequence){setLegacyCandidates([]);refreshAfterAction()}
      }
    }catch(error){if(activeInstallationId.current===id && actionRequestSequence.current===sequence)setActionError(error instanceof Error?error.message:t('agent.managed.unknownError'))}
    finally{if(activeInstallationId.current===id && actionRequestSequence.current===sequence)setBusyAction(null)}
  }

  const executeDisconnect = async (preview: AgentIntegrationPlanPreviewDto) => {
    const targetInstallationId = preview.connectionId ? activeInstallationId.current : preview.installations[0]?.installationId
    if (!targetInstallationId || targetInstallationId !== activeInstallationId.current
      || (preview.connectionId && preview.connectionId !== family.connection?.id)) return
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('disconnect')
    setActionError(null)
    try {
      const result = preview.connectionId
        ? await agentIntegrationsApi().disconnectConnection(preview.planHash, preview.connectionId)
        : await agentIntegrationsApi().disconnect(preview.planHash, targetInstallationId)
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

  const reviewCodexTrust = async () => {
    const targetInstallationId = installation.id
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('codex-trust-review')
    setActionError(null)
    setCodexTrustResult(null)
    try {
      const review = await agentIntegrationsApi().reviewCodexHookTrust(targetInstallationId)
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setCodexTrustReview(review)
    } catch (reviewError) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setActionError(reviewError instanceof Error ? reviewError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const confirmCodexTrust = async () => {
    if (!codexTrustReview?.actionHash) return
    const targetInstallationId = installation.id
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('codex-trust-confirm')
    setActionError(null)
    try {
      const result = await agentIntegrationsApi().confirmCodexHookTrust(codexTrustReview.actionHash)
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setCodexTrustResult(result)
        if (result.status === 'trust_recorded') {
          setCodexTrustReview(current => current ? { ...current, status: 'already_recorded', actionHash: null } : current)
          refreshAfterAction()
        }
      }
    } catch (confirmError) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setActionError(confirmError instanceof Error ? confirmError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const reviewGuidedRemoval = async () => {
    const targetInstallationId = installation.id
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('guided-removal-review')
    setActionError(null)
    setGuidedRemovalResult(null)
    try {
      const review = await agentIntegrationsApi().reviewGuidedRemoval(targetInstallationId)
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setGuidedRemovalReview(review)
    } catch (reviewError) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setActionError(reviewError instanceof Error ? reviewError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
    }
  }

  const confirmGuidedRemoval = async () => {
    if (!guidedRemovalReview) return
    const targetInstallationId = guidedRemovalReview.installationId
    const requestSequence = ++actionRequestSequence.current
    setBusyAction('guided-removal-confirm')
    setActionError(null)
    try {
      const result = await agentIntegrationsApi().confirmGuidedRemoval(guidedRemovalReview.actionHash)
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setGuidedRemovalResult(result)
        setGuidedRemovalReview(null)
        if (result.status === 'removal_confirmed') {
          refreshAfterAction()
        }
      }
    } catch (confirmError) {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) {
        setGuidedRemovalReview(null)
        setActionError(confirmError instanceof Error ? confirmError.message : t('agent.managed.unknownError'))
      }
    } finally {
      if (activeInstallationId.current === targetInstallationId
        && actionRequestSequence.current === requestSequence) setBusyAction(null)
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
        {backNavigation}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-gray-100">{family.displayName}</h3>
            <p className="mt-1 truncate text-xs text-gray-400">
              {installation.variantLabel} · {installation.profileLabel ?? t('agent.managed.defaultProfile')}
              {installation.version ? ` · v${installation.version}` : ''}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-gray-400">
              {family.connection?.shared
                ? t(statusReasonKey(family.connection.statusReason))
                : historyOnly || installation.manageable
                  ? t(statusReasonKey(installation.statusReason))
                  : managementUnavailableHelp}
            </p>
            {deactivationNoticeKey(installation) && (
              <p
                data-deactivation-state={`${installation.deactivation?.bridge}:${installation.deactivation?.hostComponents}`}
                className="mt-1 text-xs leading-relaxed text-amber-200"
              >
                {t(deactivationNoticeKey(installation)!)}
              </p>
            )}
          </div>
          <StatusBadge
            group={family.connection?.statusGroup ?? installation.statusGroup}
            reason={family.connection?.statusGroup !== 'needs_attention' && !installation.manageable
              ? installation.statusReason : family.connection?.statusReason ?? installation.statusReason}
            compact
            detectOnly={!historyOnly && (family.connection
              ? installations.every(member => !member.manageable)
              : !installation.manageable)}
          />
        </div>
        {family.connection && (family.connection.shared || family.connection.intentState === 'paused' || family.connection.statusGroup === 'processing') && (
          <div className="mt-3 space-y-2 rounded-lg border border-white/10 p-3 text-xs text-gray-400">
            {family.connection.shared && <p>{t('agent.managed.sharedConnectionScope')}</p>}
            <div className="flex flex-wrap gap-3">{family.connection.components.map(component =>
              <ComponentFact key={component.key} componentKey={component.key} status={component.state} showStatusLabel />,
            )}</div>
            <div className="flex flex-wrap gap-2" data-connection-actions={family.connection.id}>
              {family.connection.intentState === 'paused' ? (
                <button type="button" disabled={busyAction !== null} className="rounded border border-white/10 px-2 py-1 text-emerald-300 disabled:opacity-50"
                  onClick={() => void doAction('resume-connection', () => agentIntegrationsApi().resumeConnection(family.connection!.id))}>{t('agent.managed.resume')}</button>
              ) : (family.connection.maintenance === 'active' || family.connection.statusGroup === 'processing') && family.connection.intentState !== 'disconnected' ? (
                <button type="button" disabled={busyAction !== null} className="rounded border border-white/10 px-2 py-1 disabled:opacity-50"
                  onClick={() => void doAction('pause-connection', () => agentIntegrationsApi().pauseConnection(family.connection!.id))}>{t('agent.managed.pause')}</button>
              ) : null}
              {family.connection.shared && family.connection.installationIds.some(id => snapshot.installations.some(member => member.id === id && ['managed', 'disabled'].includes(member.desiredState))) && (
                <button type="button" disabled={busyAction !== null} className="rounded border border-red-400/20 px-2 py-1 text-red-300 disabled:opacity-50"
                  onClick={() => void openDisconnect(true)}>{t('agent.managed.disconnectConnection')}</button>
              )}
            </div>
            {family.connection.maintenance === 'paused' && <p>{t('agent.managed.reason.userDisabled')}</p>}
            {family.connection.shared && <p>{t('agent.managed.hostEvidenceScope')}</p>}
          </div>
        )}
        {!family.connection?.shared && <div className="mt-3">
          {installation.accessLevel === 'unconnected' && installation.desiredState === 'managed'
            ? <span className="text-xs text-sky-300">{t('agent.managed.componentStatus.configured')}</span>
            : <AccessBadge
            level={installation.accessLevel}
            historical={installation.accessIsHistorical}
            detail={`${historyOnly
              ? t(statusReasonKey(installation.statusReason))
              : installation.manageable
              ? t(statusReasonKey(installation.statusReason))
              : managementUnavailableHelp} · ${accessDetail}`}
          />}
        </div>}
        {installation.statusReason === 'legacy_confirmation_required' && ['codex-cli','codex-desktop'].includes(installation.hostVariant) && (
          <div className="mt-3 space-y-2 rounded border border-amber-400/30 p-3 text-xs">
            <p>{t('agent.managed.legacyChoice.description','Choose the existing Tide Mind identity to keep for Codex CLI and Desktop. History is preserved.')}</p>
            {!legacyCandidates.length ? <button disabled={busyAction!==null} onClick={()=>void runLegacySelection('review')}>{t('agent.managed.legacyChoice.review','Review existing identities')}</button> : <>
              <select aria-label={t('agent.managed.legacyChoice.select','Existing identity')} value={legacySelected} disabled={busyAction!==null}
                onChange={event=>{setLegacySelected(event.target.value);setLegacyPreview(null)}}>
                {legacyCandidates.map(item=><option key={item.agentId} value={item.agentId}>{item.name} ({item.agentId})</option>)}
              </select>
              <button disabled={busyAction!==null || !legacySelected} onClick={()=>void runLegacySelection('preview')}>{t('agent.managed.legacyChoice.preview','Preview changes')}</button>
            </>}
            {legacyPreview && <>
              <p>{t('agent.managed.legacyChoice.remove','Remove only the listed Tide Mind connection entries; keep all history and other configuration:')} {legacyPreview.legacySelection?.removedAgentIds.join(', ')}</p>
              <p>{t('agent.managed.legacyChoice.connect','This also enables Tide Mind management for this installation. The other Codex surface shares the identity and can be connected separately.')}</p>
              <ul>{legacyPreview.installations.flatMap(item=>item.targets.map((target,index)=><li key={item.installationId+index}>{t(componentLabelKey(target.componentKey))} · {target.targetLabel}</li>))}</ul>
              <button disabled={busyAction!==null} onClick={()=>void runLegacySelection('apply')}>{t('agent.managed.legacyChoice.confirm','Confirm selection and connect')}</button>
            </>}
          </div>
        )}
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
              const sharedComponent = family.connection?.components.find(candidate => candidate.key === componentKey)
              const sharedVerified = !historyOnly && family.connection?.shared
                && family.connection.installationIds.includes(installation.id)
                && componentKey !== 'lifecycle' && component?.configurationVerified
                && ['configured', 'verification_stale', 'verified'].includes(component.state)
                && component.configurationFingerprint
                && component.configurationFingerprint === sharedComponent?.configurationFingerprint
                && sharedComponent.state === 'verified'
              return (
                <div key={componentKey} className="grid items-center gap-1 text-xs min-[520px]:grid-cols-[minmax(110px,.8fr)_minmax(100px,.8fr)_minmax(0,1.5fr)] min-[520px]:gap-2">
                  <ComponentFact
                    componentKey={componentKey}
                    status={sharedVerified ? 'verified' : componentKey === 'lifecycle' && nativeTrustKnown && component?.state === 'confirmation_required' ? 'configured' : component?.state ?? 'unsupported'}
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
                          className="inline-flex min-h-6 min-w-6 items-center justify-center rounded text-gray-500 hover:bg-white/5 hover:text-gray-200 disabled:opacity-40"
                        >
                          <Copy size={11} aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => void doAction(`reveal-${componentKey}`, () => agentIntegrationsApi().revealComponentPath(installation.id, componentKey))}
                          disabled={busyAction !== null}
                          aria-label={t('agent.managed.revealComponentPath', { component: t(componentLabelKey(componentKey)) })}
                          className="inline-flex min-h-6 min-w-6 items-center justify-center rounded text-gray-500 hover:bg-white/5 hover:text-gray-200 disabled:opacity-40"
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

        {currentRequiredActions.length > 0 && (
          <section data-required-user-actions={installation.id} aria-labelledby={`required-actions-${installation.id}`}>
            <h4 id={`required-actions-${installation.id}`} className="mb-2 text-xs font-medium text-gray-300">
              {t('agent.managed.currentRequiredAction')}
            </h4>
            <details className="group rounded-xl border border-amber-400/15 bg-amber-400/[0.04] p-3">
              <summary className="cursor-pointer text-xs font-medium text-amber-200">
                {t('agent.managed.openCurrentRequiredAction')}
              </summary>
              <div className="mt-2">
                {currentRequiredActions.map(action => (
                  <RequiredUserActionDetail key={requiredUserActionDetailKey(action)} action={action} />
                ))}
                {currentRequiredActions.some(action => (
                  (action.kind === 'qwenwork_mcp_gui'
                    || action.kind === 'custom_mcp_import'
                    || action.kind === 'claude_cowork_plugin_upload') && action.operation === 'disconnect'
                )) && (
                  <div className="mt-3 border-t border-amber-400/15 pt-3">
                    <p className="mb-2 text-xs leading-relaxed text-gray-300">
                      {t(installation.hostVariant === 'custom-local-mcp'
                        ? 'agent.managed.custom.guidedRemoveStep'
                        : installation.hostVariant === 'claude-cowork-local'
                          ? 'agent.managed.guidedRemoval.coworkExplanation'
                          : 'agent.managed.guidedRemoval.explanation')}
                    </p>
                    <button
                      data-guided-removal-review
                      type="button"
                      onClick={() => void reviewGuidedRemoval()}
                      disabled={busyAction !== null}
                      className="inline-flex min-h-8 items-center rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-400/15 disabled:opacity-50"
                    >
                      {busyAction === 'guided-removal-review'
                        ? t('agent.managed.guidedRemoval.checking')
                        : t('agent.managed.guidedRemoval.reviewConfirmation')}
                    </button>
                  </div>
                )}
              </div>
            </details>
          </section>
        )}
        {guidedRemovalResult && (
          <p
            className={`rounded-lg border border-white/[0.07] bg-white/[0.025] p-3 text-xs ${guidedRemovalResult.status === 'removal_confirmed' ? 'text-emerald-300' : 'text-amber-200'}`}
            role="status"
          >
            {t(`agent.managed.guidedRemoval.${guidedRemovalResult.status === 'removal_confirmed'
              ? 'confirmed'
              : installation.hostVariant === 'claude-cowork-local' ? 'coworkNotReady' : 'notReady'}`)}
          </p>
        )}

        {!historyOnly
          && (installation.hostVariant === 'codex-cli' || installation.hostVariant === 'codex-desktop')
          && installation.desiredState === 'managed' && installation.manageable
          && (hostLifecycle?.state === 'confirmation_required' || codexTrustResult !== null || codexTrustReview !== null)
          && installation.accessLevel !== 'complete' && (!nativeTrustKnown || codexTrustResult !== null || codexTrustReview !== null) && (
          <section data-codex-trust-section={installation.id} aria-labelledby={`codex-trust-${installation.id}`}>
            <h4 id={`codex-trust-${installation.id}`} className="mb-2 text-xs font-medium text-gray-300">
              {t('agent.managed.codexTrust.title')}
            </h4>
            <div className="space-y-3 rounded-xl border border-amber-400/15 bg-amber-400/[0.055] p-3 text-xs">
              <p className="leading-relaxed text-gray-300">{t('agent.managed.codexTrust.description')}</p>
              {codexTrustReview?.status === 'action_required' && (
                <div className="space-y-2">
                  <p className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-2.5 leading-relaxed text-amber-200">
                    {codexTrustReview.instruction}
                  </p>
                  <dl className="space-y-1.5 text-[11px]">
                    <TrustFact label={t('agent.managed.codexTrust.source')} value={codexTrustReview.sourceLabel} />
                    <TrustFact label={t('agent.managed.codexTrust.hostHash')} value={codexTrustReview.hostCurrentHash} mono />
                    <TrustFact label={t('agent.managed.codexTrust.ownedHash')} value={codexTrustReview.ownedFragmentHash} mono />
                  </dl>
                </div>
              )}
              {(codexTrustReview?.status === 'already_recorded' || codexTrustResult?.status === 'trust_recorded') && (
                <p ref={codexTrustStatusRef} className="leading-relaxed text-emerald-300 focus:outline-none" role="status" tabIndex={-1}>{t('agent.managed.codexTrust.recorded')}</p>
              )}
              {codexTrustResult?.status === 'not_trusted' && (
                <p ref={codexTrustStatusRef} className="leading-relaxed text-amber-200 focus:outline-none" role="status" tabIndex={-1}>{t('agent.managed.codexTrust.notTrusted')}</p>
              )}
              {codexTrustReview?.status === 'action_required' ? (
                <button
                  ref={codexTrustConfirmRef}
                  data-codex-trust-confirm
                  type="button"
                  onClick={() => void confirmCodexTrust()}
                  disabled={busyAction !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-400/15 disabled:opacity-50"
                >
                  <RefreshCw size={11} aria-hidden />
                  {busyAction === 'codex-trust-confirm' ? t('agent.managed.codexTrust.checking') : t('agent.managed.codexTrust.confirm')}
                </button>
              ) : codexTrustReview?.status !== 'already_recorded' ? (
                <button
                  data-codex-trust-review
                  type="button"
                  onClick={() => void reviewCodexTrust()}
                  disabled={busyAction !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-50"
                >
                  <RefreshCw size={11} aria-hidden />
                  {busyAction === 'codex-trust-review' ? t('agent.managed.codexTrust.checking') : t('agent.managed.codexTrust.check')}
                </button>
              ) : null}
            </div>
          </section>
        )}

        <section aria-labelledby={`health-${installation.id}`}>
          <h4 id={`health-${installation.id}`} className="mb-2 text-xs font-medium text-gray-300">
            {t('agent.managed.healthAndActivity')}
          </h4>
          <dl className="grid grid-cols-1 gap-2 text-xs min-[420px]:grid-cols-2">
            {diagnostic && (
              <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5 min-[420px]:col-span-2" data-agent-diagnostic={diagnostic.status}>
                <dt className="text-gray-400">{t('agent.managed.modelTestLabel')}</dt>
                <dd className="mt-1 text-gray-300" role="status" aria-live="polite">
                  {t(`agent.managed.diagnostic.${diagnosticMessage(diagnostic.status, diagnostic.reason)}`)}
                </dd>
                <p className="mt-1 text-gray-500">{t('agent.managed.diagnostic.scope')}</p>
                {diagnostic.lastTestAt && <p className="mt-1 text-gray-400">{t('agent.managed.testTimeLabel')}：{timeAgo(diagnostic.lastTestAt)}</p>}
                {!historyOnly && diagnosticTarget && diagnostic.status !== 'passed' && !family.connection?.memoryCallsVerified && (
                  <button type="button" data-agent-diagnostic-recheck
                    disabled={busyAction !== null || diagnostic.status === 'checking'
                      || ['paused','disconnected','processing'].includes(family.connection?.statusGroup ?? '')
                      || ['paused','disconnected'].includes(family.connection?.intentState ?? '')}
                    className="mt-2 inline-flex items-center gap-1.5 rounded border border-white/10 px-2 py-1 text-xs text-indigo-300 hover:bg-white/5 disabled:opacity-50"
                    onClick={() => void doAction('recheck-diagnostic', async () => {
                      try { await agentIntegrationsApi().recheckDiagnostic(diagnosticTarget.id) }
                      catch { throw new Error(t('agent.managed.diagnostic.failed')) }
                    })}>
                    <RefreshCw size={11} aria-hidden /> {t('agent.managed.diagnostic.retry')}
                  </button>
                )}
              </div>
            )}
            {installation.authentication && !(installation.authentication.status === 'not_checked' && family.connection?.memoryCallsVerified) && (
              <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5 min-[420px]:col-span-2" data-agent-authentication={installation.authentication.status}>
                <dt className="text-gray-400">{t('agent.managed.authentication.title')}</dt>
                <dd className="mt-1 text-gray-300" role="status" aria-live="polite">
                  {t(`agent.managed.authentication.status.${busyAction === 'recheck-authentication' ? 'checking' : installation.authentication.status}`)}
                  {busyAction !== 'recheck-authentication' && installation.authentication.checkedAt && <> · {timeAgo(installation.authentication.checkedAt)}</>}
                </dd>
                <p className="mt-1 text-gray-400">{t(`agent.managed.authentication.billing.${installation.authentication.billing}`)}</p>
                <p className="mt-1 text-gray-500">{t('agent.managed.authentication.scope')}</p>
                {!historyOnly && (
                  <button type="button" data-agent-authentication-recheck
                    disabled={busyAction !== null || installation.authentication.status === 'checking'
                      || ['disabled', 'removed'].includes(installation.desiredState)
                      || ['paused', 'disconnected', 'processing'].includes(installation.statusGroup)
                      || ['paused', 'disconnected'].includes(family.connection?.intentState ?? '')
                      || ['paused', 'disconnected', 'processing'].includes(family.connection?.statusGroup ?? '')}
                    className="mt-2 inline-flex items-center gap-1.5 rounded border border-white/10 px-2 py-1 text-xs text-indigo-300 hover:bg-white/5 disabled:opacity-50"
                    onClick={() => void doAction('recheck-authentication', async () => {
                      try { await agentIntegrationsApi().recheckAuthentication(installation.id) }
                      catch { throw new Error(t('agent.managed.authentication.status.unavailable')) }
                    })}>
                    <RefreshCw size={11} aria-hidden /> {t('agent.managed.authentication.recheck')}
                  </button>
                )}
              </div>
            )}
            {installation.sourceVerification && (
              <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5" data-source-state={installation.sourceVerification.state}>
                <dt className="text-gray-400">{t('agent.managed.sourceVerification.title')}</dt>
                <dd className="mt-1 text-gray-300">
                  {t(`agent.managed.sourceVerification.states.${installation.sourceVerification.state}`)}
                  {installation.sourceVerification.evidence !== 'none' && (
                    <> · {t(`agent.managed.sourceVerification.evidence.${installation.sourceVerification.evidence}`)}</>
                  )}
                  {installation.sourceVerification.checkedAt && <> · {timeAgo(installation.sourceVerification.checkedAt)}</>}
                </dd>
                <p className="mt-1 text-gray-500">{t('agent.managed.sourceVerification.description')}</p>
                {installation.sourceVerification.task && (
                  <p className="mt-1 text-gray-400" role="status" data-source-check-task={installation.sourceVerification.task.state}>
                    {t(`agent.managed.sourceVerification.${({
                      queued: 'queued', checking: 'checking', unavailable: 'unavailable', unsupported: 'unsupported',
                      verified: 'states.trusted', mismatch: 'states.rejected', stopped: 'unavailable',
                    } as const)[installation.sourceVerification.task.state]}`)}
                  </p>
                )}
                {!historyOnly && installation.sourceVerification.state === 'pending'
                  && installation.sourceVerification.task?.state !== 'unsupported' && (
                  <button type="button" data-source-check-retry
                    disabled={busyAction !== null || sourceTaskState === 'checking' || sourceTaskState === 'queued'}
                    className="mt-2 rounded border border-white/10 px-2 py-1 text-xs text-indigo-300 hover:bg-white/5 disabled:opacity-50"
                    onClick={() => void doAction('retry-source', async () => {
                      const result = await agentIntegrationsApi().retrySourceCheck(installation.id)
                      if (activeInstallationId.current === installation.id) setSourceRetry({ installationId: installation.id, result })
                    })}>
                    {t('agent.managed.sourceVerification.retry')}
                  </button>
                )}
                {sourceRetry?.installationId === installation.id && (
                  <p className="mt-1 text-gray-400" role="status">
                    {t(`agent.managed.sourceVerification.${({
                      started: 'requested', in_progress: 'checking', throttled: 'retryAt', unsupported: 'unsupported',
                      not_needed: 'states.trusted', stopped: 'unavailable', unavailable: 'unavailable',
                    } as const)[sourceRetry.result.status]}`, { time: sourceRetry.result.retryAt ? new Date(sourceRetry.result.retryAt).toLocaleTimeString() : '' })}
                  </p>
                )}
              </div>
            )}
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.checkLabel')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastVerifiedAt ? timeAgo(installation.lastVerifiedAt) : t('agent.managed.noRecord')}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.lastRepair')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastRepairedAt ? timeAgo(installation.lastRepairedAt) : t('agent.managed.noRecord')}</dd>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.lastDetected')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastDetectedAt ? timeAgo(installation.lastDetectedAt) : t('agent.managed.noRecord')}</dd>
            </div>
            {installation.sharedConnection && (
              <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5" data-shared-connection={installation.sharedConnection.status}>
                <dt className="text-gray-400">{t('agent.managed.sharedConnection.title')}</dt>
                <dd className="mt-1 text-gray-300">{t(`agent.managed.sharedConnection.${installation.sharedConnection.status}`)}</dd>
                <p className="mt-1 text-gray-500">{t('agent.managed.sharedConnection.scope')}</p>
              </div>
            )}
            <div className="rounded-lg border border-white/5 bg-white/[0.025] p-2.5">
              <dt className="text-gray-400">{t('agent.managed.activityLabel')}</dt>
              <dd className="mt-1 text-gray-300">{installation.lastRealUseAt ? timeAgo(installation.lastRealUseAt) : t('agent.managed.noActivity')}</dd>
              <p className="mt-1 text-gray-500">{t('agent.managed.activityScope')}</p>
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
            {installation.automaticConnectionEnabled && family.connection
              && installation.statusReason !== 'native_permission_required'
              && ['unmanaged','managed'].includes(installation.desiredState)
              && (installation.desiredState === 'unmanaged' || installation.statusGroup === 'needs_attention') && (
              <button type="button" data-automatic-connection-retry
                disabled={busyAction !== null || family.connection.statusGroup === 'processing' || family.connection.intentState !== 'active'}
                className="rounded-lg border border-indigo-400/20 px-3 py-1.5 text-xs text-indigo-300 disabled:opacity-50"
                onClick={() => void doAction('retry-automatic', async () => {
                  const result = await agentIntegrationsApi().retryAutomaticConnection(family.connection!.id)
                  if (!result) throw new Error(t('agent.managed.automaticRetryUnavailable'))
                })}>{t('agent.managed.retryAutomaticConnection')}</button>
            )}
            {installation.manageable && installation.statusReason === 'native_permission_required' && (
              <button type="button" disabled={busyAction !== null || family.connection?.intentState === 'paused'}
                onClick={() => onReconnect(installation.id)}
                className="rounded-lg border border-amber-400/20 px-3 py-1.5 text-xs text-amber-300 disabled:opacity-50">
                {t('agent.managed.reviewNativePermissions')}
              </button>
            )}
            {!installation.manageable && !installation.disconnectable ? (
              <span
                className="inline-flex items-center rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-400"
                title={managementUnavailableHelp}
              >
                {t('agent.managed.supportMode.detectable')}
              </span>
            ) : installation.manageable && installation.statusReason === 'circuit_breaker' ? (
              <button
                type="button"
                onClick={() => void openCircuitReset()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-400/10 disabled:opacity-50"
                title={t('agent.managed.resetAutoRestoreHelp')}
              >
                <RefreshCw size={11} aria-hidden /> {t('agent.managed.resetAutoRestore')}
              </button>
            ) : installation.desiredState === 'disabled' && family.connection?.intentState !== 'paused' ? (
              <button
                type="button"
                onClick={() => void doAction('resume', () => agentIntegrationsApi().resume(installation.id))}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/20 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-50"
              >
                <Play size={11} aria-hidden /> {t(family.connection?.shared ? 'agent.managed.resumeMember' : 'agent.managed.resume')}
              </button>
            ) : installation.desiredState === 'managed' ? (
              <button
                type="button"
                onClick={() => setConfirmPauseInstallationId(installation.id)}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-400 hover:bg-white/5 disabled:opacity-50"
              >
                <Pause size={11} aria-hidden /> {t(family.connection?.shared ? 'agent.managed.pauseMember' : 'agent.managed.pause')}
              </button>
            ) : null}
            {installation.manageable && (!installation.automaticConnectionEnabled || installation.statusReason === 'conflict') && installation.desiredState === 'managed'
              && installation.statusGroup === 'needs_attention' && (
              <button type="button" disabled={busyAction !== null} onClick={() => onReconnect(installation.id)}
                className="rounded-lg border border-amber-400/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-400/10 disabled:opacity-50">
                {t('agent.managed.reconnect')}
              </button>
            )}
            {installation.manageable && !installation.automaticConnectionEnabled
            && installation.desiredState === 'unmanaged'
            && (installation.statusGroup === 'awaiting_connection'
              || installation.statusReason === 'legacy_callable_unmanaged') ? (
              <button
                type="button"
                onClick={() => onReconnect(installation.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-400/20 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-400/10"
              >
                <Play size={11} aria-hidden /> {t(installation.statusReason === 'legacy_callable_unmanaged'
                  ? 'agent.managed.reviewAndEnableMaintenance'
                  : 'agent.managed.reviewAndConnect')}
              </button>
            ) : installation.manageable && installation.desiredState === 'removed' && installation.statusReason !== 'native_permission_required' ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => installation.automaticConnectionEnabled
                  ? void doAction('reconnect-automatic', async () => {
                    const result = await agentIntegrationsApi().reconnectAutomaticInstallation(installation.id)
                    if (!result) {
                      const latest = await agentIntegrationsApi().snapshot()
                      if (latest.installations.find(item => item.id === installation.id)?.statusReason === 'native_permission_required') {
                        onReconnect(installation.id)
                        return
                      }
                      throw new Error(t('agent.managed.automaticRetryUnavailable'))
                    }
                  }) : onReconnect(installation.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-400/20 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-400/10"
              >
                <Play size={11} aria-hidden /> {t('agent.managed.reconnect')}
              </button>
            ) : (installation.manageable || installation.disconnectable)
              && (installation.desiredState === 'managed' || installation.desiredState === 'disabled') ? (
              <button
                type="button"
                onClick={() => void openDisconnect()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/20 px-3 py-1.5 text-xs text-red-300 hover:bg-red-400/10 disabled:opacity-50"
              >
                <Unplug size={11} aria-hidden /> {t(family.connection?.shared ? 'agent.managed.disconnectMember' : 'agent.managed.disconnect')}
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
                  <p key={result.installationId} className="mt-1 break-words text-amber-300">
                    {result.reason === 'host_manual_removal_required'
                      ? t('agent.managed.userAction.hostManualRemoval')
                      : result.reason}
                  </p>
                ))}
                {disconnectResult.results.flatMap(result => result.requiredUserActionDetails ?? [])
                  .map(action => <RequiredUserActionDetail key={requiredUserActionDetailKey(action)} action={action} />)}
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
        title={t(disconnectPreview?.connectionId ? 'agent.managed.disconnectConnectionTitle' : 'agent.managed.disconnectTitle', { name: disconnectPreview?.connectionId ? family.displayName : installationLabel(installation, t('agent.managed.defaultProfile')) })}
        description={t(disconnectPreview?.connectionId ? 'agent.managed.disconnectConnectionDescription' : 'agent.managed.disconnectDescription')}
        confirmText={t('agent.managed.disconnect')}
        danger
      >
        {disconnectPreview && (
          <div className="space-y-2 text-xs text-gray-400">
            {disconnectPreview.connectionId && <p>{disconnectPreview.installations.map(item => item.displayName).join(' · ')}</p>}
            {disconnectPreview.installations.flatMap(item => item.requiredUserActions).map(action => (
              <div key={action} className="rounded border border-amber-400/20 bg-amber-400/[0.06] px-2 py-2 text-amber-200">
                {requiredActionText(action)}
              </div>
            ))}
            {disconnectPreview.installations.flatMap(item => (
              (item.requiredUserActionDetails ?? []).map(action => ({ installationId: item.installationId, action }))
            )).map(({ installationId: actionInstallationId, action }) => (
              <RequiredUserActionDetail key={`${actionInstallationId}:${requiredUserActionDetailKey(action)}`} action={action} />
            ))}
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
      <ConfirmDialog
        open={guidedRemovalReview !== null}
        onCancel={() => setGuidedRemovalReview(null)}
        onConfirm={() => void confirmGuidedRemoval()}
        title={t('agent.managed.guidedRemoval.title', {
          connector: guidedRemovalReview?.connectorName ?? 'Tide Mind',
        })}
        description={t(installation.hostVariant === 'custom-local-mcp'
          ? 'agent.managed.guidedRemoval.userConfirmedNotice'
          : installation.hostVariant === 'claude-cowork-local'
            ? 'agent.managed.guidedRemoval.coworkDescription'
            : 'agent.managed.guidedRemoval.description')}
        confirmText={t(installation.hostVariant === 'custom-local-mcp'
          ? 'agent.managed.guidedRemoval.reviewConfirmation'
          : installation.hostVariant === 'claude-cowork-local'
            ? 'agent.managed.guidedRemoval.coworkConfirm'
            : 'agent.managed.guidedRemoval.confirm')}
        confirmDisabled={busyAction !== null}
      >
        <p className="text-xs leading-relaxed text-gray-300">
          {t('agent.managed.guidedRemoval.userConfirmedNotice')}
        </p>
      </ConfirmDialog>
    </div>
  )
}

function diagnosticMessage(status: string, reason: string): string {
  if (status === 'checking') return 'checking'
  if (status === 'passed') return 'passed'
  if (reason === 'native_permission_required') return 'permission'
  if (/unsupported|unqualified|unproven|hooks_present|managed_policy|context_isolation_unavailable/.test(reason)) return 'unsupported'
  if (status === 'uncertain') return 'uncertain'
  if (status === 'cancelled') return 'cancelled'
  if (reason === 'host_reports_not_authenticated') return 'login'
  if (reason.includes('metered')) return 'metered'
  if (reason.includes('billing') || reason === 'subscription_required') return 'billing'
  if (reason === 'daily_budget_exhausted') return 'dailyLimit'
  if (reason === 'configuration_already_submitted') return 'alreadyTested'
  if (['awaiting_diagnostic','another_diagnostic_running'].includes(reason)) return 'waiting'
  return 'failed'
}

function TrustFact({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="grid gap-1 min-[520px]:grid-cols-[120px_minmax(0,1fr)]">
      <dt className="text-gray-400">{label}</dt>
      <dd className={`break-all text-gray-300 ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</dd>
    </div>
  )
}
