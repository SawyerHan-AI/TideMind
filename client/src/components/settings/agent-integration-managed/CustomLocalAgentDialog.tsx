import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, CircleDashed, FolderOpen, X, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AgentIntegrationApplyResultDto,
  AgentIntegrationCustomMcpSchema,
  AgentIntegrationCustomPreflightDto,
  AgentIntegrationInstallationDto,
  AgentIntegrationPlanPreviewDto,
} from '../../../lib/api-contract'
import { acquireModalInert } from '../../../lib/modal-inert'
import {
  componentLabelKey,
  customApplyOutcome,
  isValidCustomSelectorKey,
  safeDisplayTarget,
} from './presentation'
import { agentIntegrationsApi } from './types'
import { RequiredUserActionDetail } from './RequiredUserActionDetail'

type Step = 'form' | 'preflight' | 'authorize' | 'result'
type Mode = 'nonstandard_config_root' | 'manual_mcp_client'

export function CustomResultPanel({ result }: { result: AgentIntegrationApplyResultDto }) {
  const { t } = useTranslation('settings')
  const outcome = customApplyOutcome(result)
  return (
    <div className={`rounded-xl border p-4 ${outcome === 'committed'
      ? 'border-emerald-400/15 bg-emerald-400/[0.06]'
      : outcome === 'awaiting_verification'
        ? 'border-sky-400/15 bg-sky-400/[0.06]'
        : outcome === 'needs_recovery'
          ? 'border-amber-400/15 bg-amber-400/[0.06]'
          : 'border-red-400/20 bg-red-400/[0.07]'}`} role={outcome === 'failed' || outcome === 'needs_recovery' ? 'alert' : 'status'}>
      <div className={`flex items-center gap-2 ${outcome === 'committed'
        ? 'text-emerald-300'
        : outcome === 'awaiting_verification'
          ? 'text-sky-300'
          : outcome === 'needs_recovery'
            ? 'text-amber-300'
            : 'text-red-300'}`}>
        {outcome === 'committed'
          ? <CheckCircle2 size={16} aria-hidden />
          : outcome === 'awaiting_verification'
            ? <CircleDashed size={16} aria-hidden />
            : outcome === 'needs_recovery'
              ? <AlertTriangle size={16} aria-hidden />
              : <XCircle size={16} aria-hidden />}
        <span className="text-xs font-medium">{t(`agent.managed.custom.result.${outcome}`)}</span>
      </div>
      <ul className="mt-2 text-xs text-gray-300">
        {result.results.map(item => <li key={item.installationId}>{t(`agent.managed.execution.${item.status}`)}</li>)}
      </ul>
    </div>
  )
}

export function CustomLocalAgentDialog({
  open,
  sourceInstallations,
  legacyCustomInstallations,
  initialLegacyInstallationId,
  onClose,
  onComplete,
  onReviewResult,
}: {
  open: boolean
  sourceInstallations: readonly AgentIntegrationInstallationDto[]
  legacyCustomInstallations: readonly AgentIntegrationInstallationDto[]
  initialLegacyInstallationId: string | null
  onClose: () => void
  onComplete: () => void
  onReviewResult: (installationId: string) => void
}) {
  const { t } = useTranslation('settings')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const stepContentRef = useRef<HTMLDivElement>(null)
  const previousStepRef = useRef<Step | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const initialFocusFrameRef = useRef<number | null>(null)
  const restoreFocusFrameRef = useRef<number | null>(null)
  const sourceInstallationsRef = useRef(sourceInstallations)
  sourceInstallationsRef.current = sourceInstallations
  const legacyCustomInstallationsRef = useRef(legacyCustomInstallations)
  legacyCustomInstallationsRef.current = legacyCustomInstallations
  const [step, setStep] = useState<Step>('form')
  const [mode, setMode] = useState<Mode>('nonstandard_config_root')
  const [displayName, setDisplayName] = useState('')
  const [sourceInstallationId, setSourceInstallationId] = useState('')
  const [configRoot, setConfigRoot] = useState('')
  const [clientExecutablePath, setClientExecutablePath] = useState('')
  const [configFilePath, setConfigFilePath] = useState('')
  const [userOwned, setUserOwned] = useState(true)
  const [schemaKind, setSchemaKind] = useState<AgentIntegrationCustomMcpSchema>('standard_mcp_servers')
  const [selectorKey, setSelectorKey] = useState('tidemind')
  const [legacyInstallationId, setLegacyInstallationId] = useState('')
  const [preflight, setPreflight] = useState<AgentIntegrationCustomPreflightDto | null>(null)
  const [plan, setPlan] = useState<AgentIntegrationPlanPreviewDto | null>(null)
  const [approved, setApproved] = useState(false)
  const [result, setResult] = useState<AgentIntegrationApplyResultDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (restoreFocusFrameRef.current !== null) cancelAnimationFrame(restoreFocusFrameRef.current)
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setStep('form')
    const selectedLegacy = initialLegacyInstallationId
      ? legacyCustomInstallationsRef.current.find(item => item.id === initialLegacyInstallationId)
      : undefined
    setMode(selectedLegacy ? 'manual_mcp_client' : 'nonstandard_config_root')
    setDisplayName(selectedLegacy?.displayName ?? '')
    setSourceInstallationId(sourceInstallationsRef.current[0]?.id ?? '')
    setConfigRoot('')
    setClientExecutablePath('')
    setConfigFilePath('')
    setUserOwned(true)
    setSchemaKind('standard_mcp_servers')
    setSelectorKey('tidemind')
    setLegacyInstallationId(initialLegacyInstallationId ?? '')
    setPreflight(null)
    setPlan(null)
    setApproved(false)
    setResult(null)
    setError(null)
    initialFocusFrameRef.current = requestAnimationFrame(() => {
      initialFocusFrameRef.current = null
      if (openRef.current) closeRef.current?.focus()
    })
    const releaseInert = acquireModalInert(document.getElementById('root'))
    return () => {
      if (initialFocusFrameRef.current !== null) cancelAnimationFrame(initialFocusFrameRef.current)
      initialFocusFrameRef.current = null
      releaseInert()
    }
  }, [initialLegacyInstallationId, open])

  useLayoutEffect(() => {
    if (!open) {
      previousStepRef.current = null
      return
    }
    if (previousStepRef.current === null) {
      previousStepRef.current = step
      return
    }
    if (previousStepRef.current === step) return
    previousStepRef.current = step
    // A delayed initial animation frame must not steal focus from a new step.
    if (initialFocusFrameRef.current !== null) cancelAnimationFrame(initialFocusFrameRef.current)
    initialFocusFrameRef.current = null
    stepContentRef.current?.focus()
  }, [open, step])

  useEffect(() => {
    if (!open || mode !== 'nonstandard_config_root') return
    if (sourceInstallations.some(item => item.id === sourceInstallationId)) return
    setSourceInstallationId(sourceInstallations[0]?.id ?? '')
  }, [mode, open, sourceInstallationId, sourceInstallations])

  const close = useCallback(() => {
    if (loading) return
    const previousFocus = previousFocusRef.current
    onClose()
    restoreFocusFrameRef.current = requestAnimationFrame(() => {
      restoreFocusFrameRef.current = null
      if (!openRef.current && previousFocus?.isConnected) previousFocus.focus()
    })
  }, [loading, onClose])

  useEffect(() => {
    if (!open) return
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [close, open])

  if (!open) return null

  const pick = async (kind: 'config_root' | 'config_file' | 'client_executable') => {
    setLoading(true); setError(null)
    try {
      const selected = await agentIntegrationsApi().pickCustomPath(kind)
      if (!selected) return
      if (kind === 'config_root') setConfigRoot(selected)
      else if (kind === 'config_file') setConfigFilePath(selected)
      else setClientExecutablePath(selected)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('agent.managed.unknownError'))
    } finally {
      setLoading(false)
    }
  }

  const preview = async () => {
    setLoading(true); setError(null)
    try {
      const next = await agentIntegrationsApi().previewCustomInstallation(mode === 'nonstandard_config_root'
        ? { mode, displayName, sourceInstallationId, configRoot }
        : {
            mode, displayName, clientExecutablePath, configFilePath: userOwned ? '' : configFilePath, schemaKind, selectorKey,
            configurationOwnership: userOwned ? 'user' : 'tidemind',
            ...(legacyInstallationId ? { legacyInstallationId } : {}),
          })
      setPreflight(next); setStep('preflight')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('agent.managed.unknownError'))
    } finally { setLoading(false) }
  }

  const prepare = async () => {
    if (!preflight) return
    setLoading(true); setError(null)
    try {
      setPlan(await agentIntegrationsApi().prepareCustomConnect(preflight.preflightHash, false))
      setApproved(false); setStep('authorize')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('agent.managed.unknownError'))
    } finally { setLoading(false) }
  }

  const apply = async () => {
    if (!plan || !approved) return
    setLoading(true); setError(null)
    try {
      const installationIds = plan.installations.map(item => item.installationId)
      const next = await agentIntegrationsApi().applyConnect(plan.planHash, installationIds)
      setResult(next); setStep('result'); onComplete()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('agent.managed.unknownError'))
    } finally { setLoading(false) }
  }

  const reviewAgain = () => {
    setPreflight(null)
    setPlan(null)
    setApproved(false)
    setResult(null)
    setError(null)
    setStep('form')
  }

  const selectorValid = isValidCustomSelectorKey(selectorKey)
  const formValid = displayName.trim().length > 0 && (mode === 'nonstandard_config_root'
    ? Boolean(sourceInstallationId && configRoot)
    : Boolean(clientExecutablePath && (userOwned || configFilePath) && selectorValid))
  const resultOutcome = result ? customApplyOutcome(result) : null
  const resultInstallationId = result?.results.find(item => item.status === 'needs_recovery')?.installationId
    ?? result?.results[0]?.installationId

  return createPortal(
    <div className="theme-modal-overlay fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm" role="presentation">
      <div
        ref={dialogRef}
        data-custom-agent-dialog
        data-custom-agent-step={step}
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-agent-dialog-title"
        aria-describedby="custom-agent-dialog-description"
        className="theme-popup-surface max-h-[min(760px,calc(100vh-2rem))] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 text-gray-200"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 id="custom-agent-dialog-title" className="text-base font-semibold text-gray-100">{t('agent.managed.custom.dialogTitle')}</h2>
            <p id="custom-agent-dialog-description" className="mt-1 text-xs leading-relaxed text-gray-400">{t('agent.managed.custom.dialogDescription')}</p>
          </div>
          <button ref={closeRef} type="button" onClick={close} disabled={loading} aria-label={t('agent.managed.close')} className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-gray-200 disabled:opacity-40">
            <X size={17} aria-hidden />
          </button>
        </header>

        <div
          ref={stepContentRef}
          data-custom-agent-step-content
          tabIndex={-1}
          className="mt-5 focus:outline-none"
          aria-live="polite"
        >
          {step === 'form' && (
            <div className="space-y-4">
              <fieldset>
                <legend className="text-xs font-medium text-gray-300">{t('agent.managed.custom.chooseMode')}</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(['nonstandard_config_root', 'manual_mcp_client'] as const).map(value => (
                    <label key={value} className={`cursor-pointer rounded-xl border p-3 outline-none transition focus-within:ring-2 focus-within:ring-indigo-400/60 ${mode === value ? 'border-indigo-400/40 bg-indigo-400/10' : 'border-white/[0.08] bg-white/[0.025] hover:bg-white/[0.04]'}`}>
                    <input className="sr-only" type="radio" name="custom-mode" value={value} checked={mode === value} disabled={loading} onChange={() => { setMode(value); setError(null) }} />
                      <span className="block text-xs font-medium text-gray-200">{t(`agent.managed.custom.mode.${value}.title`)}</span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-gray-400">{t(`agent.managed.custom.mode.${value}.description`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label={t('agent.managed.custom.name')}>
                <input value={displayName} maxLength={80} disabled={loading} onChange={event => setDisplayName(event.target.value)} className="w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-gray-100 outline-none focus:border-indigo-400/50 disabled:opacity-50" />
              </Field>
              {mode === 'nonstandard_config_root' ? (
                <>
                  <Field label={t('agent.managed.custom.sourceHost')}>
                    <select value={sourceInstallationId} disabled={loading} onChange={event => setSourceInstallationId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-gray-100 outline-none focus:border-indigo-400/50 disabled:opacity-50">
                      {sourceInstallations.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.variantLabel}</option>)}
                    </select>
                  </Field>
                  {sourceInstallations.length === 0 && <p className="text-xs text-amber-300" role="status">{t('agent.managed.custom.noSupportedHost')}</p>}
                  <PathField label={t('agent.managed.custom.configRoot')} value={configRoot} disabled={loading} onPick={() => void pick('config_root')} pickLabel={t('agent.managed.custom.chooseFolder')} />
                </>
              ) : (
                <>
                  {legacyCustomInstallations.length > 0 && (
                    <Field label={t('agent.managed.custom.legacyIdentity')}>
                      <select value={legacyInstallationId} disabled={loading} onChange={event => setLegacyInstallationId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-gray-100 outline-none focus:border-indigo-400/50 disabled:opacity-50">
                        <option value="">{t('agent.managed.custom.newIdentity')}</option>
                        {legacyCustomInstallations.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                      </select>
                    </Field>
                  )}
                  <PathField label={t('agent.managed.custom.clientExecutable')} value={clientExecutablePath} disabled={loading} onPick={() => void pick('client_executable')} pickLabel={t('agent.managed.custom.chooseFile')} />
                  <label className="flex gap-2 text-xs text-gray-300">
                    <input type="checkbox" checked={!userOwned} disabled={loading} onChange={event => setUserOwned(!event.target.checked)} />
                    {t('agent.managed.custom.manageFile', { defaultValue: 'Let Tide Mind manage a compatible JSON configuration file' })}
                  </label>
                  <p className="text-xs text-gray-400">{t('agent.managed.custom.userOwnedNotice', { defaultValue: 'By default, copy and import into your local Agent. You maintain the configuration; Tide Mind does not edit or automatically restore it.' })}</p>
                  {!userOwned && <PathField label={t('agent.managed.custom.configFile')} value={configFilePath} disabled={loading} onPick={() => void pick('config_file')} pickLabel={t('agent.managed.custom.chooseFile')} />}
                  <Field label={t('agent.managed.custom.schema')}>
                    <select value={schemaKind} disabled={loading} onChange={event => setSchemaKind(event.target.value as AgentIntegrationCustomMcpSchema)} className="w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-gray-100 outline-none focus:border-indigo-400/50 disabled:opacity-50">
                      <option value="standard_mcp_servers">mcpServers.&lt;name&gt;</option>
                      <option value="nested_mcp_servers">mcp.servers.&lt;name&gt;</option>
                      <option value="opencode_mcp">mcp.&lt;name&gt; (local command array)</option>
                    </select>
                  </Field>
                  <Field label={t('agent.managed.custom.selectorKey')}>
                    <input value={selectorKey} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" disabled={loading} aria-invalid={!selectorValid} aria-describedby={!selectorValid ? 'custom-agent-selector-error' : undefined} onChange={event => setSelectorKey(event.target.value)} className="w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 font-mono text-xs text-gray-100 outline-none focus:border-indigo-400/50 disabled:opacity-50" />
                  </Field>
                  {!selectorValid && <p id="custom-agent-selector-error" className="text-xs text-red-300" role="alert">{t('agent.managed.custom.selectorInvalid')}</p>}
                  <p className="rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200">{t('agent.managed.custom.localOnlyNotice')}</p>
                </>
              )}
            </div>
          )}

          {step === 'preflight' && preflight && (
            <div className="space-y-3">
              <ReviewRow label={t('agent.managed.custom.name')} value={preflight.displayName} />
              <ReviewRow label={t('agent.managed.custom.host')} value={preflight.hostLabel} />
              <ReviewRow label={t('agent.managed.custom.target')} value={preflight.targetLabel} />
              <ReviewRow label="EB_AGENT_ID" value={preflight.agentId} mono />
              {preflight.reusedLegacyInstallationId && <ReviewRow label={t('agent.managed.custom.legacyIdentity')} value={t('agent.managed.custom.identityPreserved')} />}
              <ReviewRow label={t('agent.managed.custom.components')} value={preflight.componentKeys.map(key => t(`agent.managed.component.${key}`)).join(' · ')} />
              <ul className="rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-[11px] leading-relaxed text-amber-200">
                {preflight.warnings.map(warning => <li key={warning}>• {t(`agent.managed.custom.warning.${warning}`)}</li>)}
              </ul>
            </div>
          )}

          {step === 'authorize' && plan && (
            <div className="space-y-3">
              {plan.installations.flatMap(item => item.targets.map(target => (
                <div key={`${item.installationId}:${target.componentKey}:${target.action}`} className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3">
                  <p className="text-xs font-medium text-gray-200">{t(componentLabelKey(target.componentKey))} · {t(`agent.managed.targetAction.${target.action}`)}</p>
                  <p className="mt-1 text-[11px] text-gray-400">{target.targetLabel ? safeDisplayTarget(target.targetLabel) : t('agent.managed.custom.noFileWrite')} · {t(`agent.managed.risk.${target.risk}`)}</p>
                </div>
              )))}
              {plan.installations.every(item => item.targets.length === 0) && <p className="rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200">{t('agent.managed.custom.noFileWrite')}</p>}
              {plan.installations.flatMap(item => item.requiredUserActionDetails ?? []).filter(action => action.kind === 'custom_mcp_import').map(action => <RequiredUserActionDetail key={action.kind} action={action} />)}
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.08] p-3 text-xs text-gray-300">
                <input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} className="mt-0.5" />
                <span>{t('agent.managed.custom.approveExactPlan')}</span>
              </label>
            </div>
          )}

          {step === 'result' && result && resultOutcome && (
            <><CustomResultPanel result={result} />
              {plan?.installations.flatMap(item => item.requiredUserActionDetails ?? []).filter(action => action.kind === 'custom_mcp_import').map(action => <RequiredUserActionDetail key={action.kind} action={action} />)}
            </>
          )}

          {error && <p className="mt-4 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-xs text-red-300" role="alert">{error}</p>}
        </div>

        <footer className="mt-5 flex flex-wrap justify-end gap-2 border-t border-white/[0.07] pt-4">
          {step !== 'result' && <button type="button" onClick={step === 'form' ? close : () => { setError(null); setStep(step === 'authorize' ? 'preflight' : 'form') }} disabled={loading} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 hover:bg-white/[0.04] disabled:opacity-40">{step === 'form' ? t('agent.managed.custom.cancel') : t('agent.managed.custom.back')}</button>}
          {step === 'form' && <button data-custom-agent-preview type="button" onClick={() => void preview()} disabled={loading || !formValid} className="theme-confirm-primary rounded-lg px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40">{loading ? t('agent.managed.custom.checking') : t('agent.managed.custom.preview')}</button>}
          {step === 'preflight' && <button data-custom-agent-authorize type="button" onClick={() => void prepare()} disabled={loading} className="theme-confirm-primary rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-40">{loading ? t('agent.managed.custom.preparing') : t('agent.managed.custom.continueAuthorization')}</button>}
          {step === 'authorize' && <button data-custom-agent-apply type="button" onClick={() => void apply()} disabled={loading || !approved} className="theme-confirm-primary rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-40">{loading ? t('agent.managed.custom.connecting') : t('agent.managed.custom.connect')}</button>}
          {step === 'result' && resultOutcome === 'failed' && <button type="button" onClick={reviewAgain} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/[0.04]">{t('agent.managed.custom.reviewAgain')}</button>}
          {step === 'result' && resultOutcome === 'needs_recovery' && resultInstallationId && <button type="button" onClick={() => onReviewResult(resultInstallationId)} className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-400/10">{t('agent.managed.custom.reviewRecovery')}</button>}
          {step === 'result' && resultOutcome !== 'failed' && resultOutcome !== 'needs_recovery' && <button type="button" onClick={close} className="theme-confirm-primary rounded-lg px-3 py-2 text-xs font-medium">{t('agent.managed.custom.done')}</button>}
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-medium text-gray-300">{label}</span>{children}</label>
}

function PathField({ label, value, disabled, onPick, pickLabel }: { label: string; value: string; disabled: boolean; onPick: () => void; pickLabel: string }) {
  return <div><span className="mb-1.5 block text-xs font-medium text-gray-300">{label}</span><div className="flex gap-2"><input value={value} readOnly disabled={disabled} aria-label={label} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 font-mono text-[11px] text-gray-300 disabled:opacity-50" /><button type="button" disabled={disabled} onClick={onPick} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 hover:bg-white/[0.05] disabled:opacity-50"><FolderOpen size={13} aria-hidden />{pickLabel}</button></div></div>
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="grid gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 sm:grid-cols-[140px_1fr]"><span className="text-[11px] text-gray-500">{label}</span><span className={`break-all text-xs text-gray-200 ${mono ? 'font-mono' : ''}`}>{value}</span></div>
}
