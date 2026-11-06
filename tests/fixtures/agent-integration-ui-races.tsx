import { act, StrictMode } from '../../client/node_modules/react/index.js'
import { createRoot } from '../../client/node_modules/react-dom/client.js'
import i18n from '../../client/node_modules/i18next/dist/esm/i18next.js'
import { initReactI18next } from '../../client/node_modules/react-i18next/dist/es/index.js'
import { MemoryRouter } from '../../client/node_modules/react-router-dom/dist/index.mjs'
import settings from '../../client/src/locales/en/settings.json'
import { AgentIntegration, SupportCatalogDialog } from '../../client/src/components/settings/AgentIntegration'
import { ManagedAgentDetail } from '../../client/src/components/settings/agent-integration-managed/ManagedAgentDetail'
import { ManagedFamilyList } from '../../client/src/components/settings/agent-integration-managed/ManagedFamilyList'
import { BatchConnectDialog } from '../../client/src/components/settings/agent-integration-managed/BatchConnectDialog'
import { CustomLocalAgentDialog } from '../../client/src/components/settings/agent-integration-managed/CustomLocalAgentDialog'
import type {
  AgentIntegrationApplyTaskDto,
  AgentIntegrationAuthenticationDto,
  AgentIntegrationConnectionDto,
  AgentIntegrationDetailDto,
  AgentIntegrationInstallationDto,
  AgentIntegrationSnapshotDto,
} from '../../client/src/lib/api-contract'
import type { ManagedProductFamilyDto } from '../../client/src/components/settings/agent-integration-managed/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function run() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { settings } }, interpolation: { escapeValue: false } })
  const root = createRoot(document.getElementById('root')!)
  const previews: ReturnType<typeof deferred>[] = []
  const prepares: ReturnType<typeof deferred>[] = []
  let detail = deferred()
  Object.assign(window, { api: { agentIntegrations: {
    onStateChanged: () => () => {},
    detail: () => detail.promise,
    supportCatalog: async () => [{ id: 'claude', displayName: 'Claude', variants: [{ id: 'claude-cowork-local', displayName: 'Cowork', maturity: 'preview' }] }],
    previewClaudeCoworkSetup: () => { const next = deferred(); previews.push(next); return next.promise },
    prepareClaudeCoworkSetup: () => { const next = deferred(); prepares.push(next); return next.promise },
  } } })
  const change = async (fn: () => void) => act(async () => { fn(); await Promise.resolve() })
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector)
    assert(button && !button.disabled, `missing or disabled control: ${selector}`)
    await change(() => button.click())
  }
  let open = true
  let preparedCount = 0
  const renderSupport = () => root.render(<SupportCatalogDialog open={open}
    onClose={() => { open = false; renderSupport() }}
    onCoworkPrepared={() => { preparedCount += 1 }} />)
  const closeAndReopen = async () => {
    await change(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert(!document.querySelector('[data-support-catalog-dialog]'), 'Escape did not close support dialog')
    await change(() => { open = true; renderSupport() })
  }
  const start = '[data-cowork-guided-start]'
  const review = '[data-cowork-guided-review]'
  const preflight = { preflightHash: 'fresh', hostVersion: '1.0.0' }

  await change(renderSupport)
  await click(start)
  await closeAndReopen()
  await click(start)
  await change(() => previews[0].resolve({ ...preflight, preflightHash: 'stale' }))
  assert(!document.querySelector(review), 'closed preview success revived old authority')
  assert(document.querySelector<HTMLButtonElement>(start)?.disabled, 'stale finally cleared the current preview busy state')
  await change(() => previews[1].resolve(preflight))
  assert(document.querySelector(review), 'current preview was discarded')

  await click('[data-cowork-guided-confirm]')
  await closeAndReopen()
  await click(start)
  await change(() => prepares[0].resolve({ installationId: 'stale-installation' }))
  assert(preparedCount === 0, 'closed preparation navigated to batch connect')
  assert(document.querySelector<HTMLButtonElement>(start)?.disabled, 'stale prepare finally cleared a new request busy state')
  await change(() => previews[2].resolve(preflight))

  // Rejected requests must also stay within the dialog session that started them.
  await closeAndReopen()
  await click(start)
  await closeAndReopen()
  await click(start)
  await change(() => previews[3].reject(new Error('STALE_PREVIEW_FAILURE')))
  assert(!document.body.textContent?.includes('STALE_PREVIEW_FAILURE'), 'closed preview error leaked into new session')
  assert(document.querySelector<HTMLButtonElement>(start)?.disabled, 'stale rejection cleared current busy state')
  await change(() => previews[4].resolve(preflight))
  await click('[data-cowork-guided-confirm]')
  await closeAndReopen()
  await change(() => prepares[1].reject(new Error('STALE_PREPARE_FAILURE')))
  assert(!document.body.textContent?.includes('STALE_PREPARE_FAILURE'), 'closed preparation error leaked into new session')
  await click(start)
  await change(() => previews[5].resolve(preflight))
  await click('[data-cowork-guided-confirm]')
  await change(() => prepares[2].resolve({ installationId: 'current-installation' }))
  assert(preparedCount === 1, 'current preparation did not navigate exactly once')
  await change(() => root.render(null))

  let returned = false
  const installation = { id: 'test-installation' }
  const renderDetail = () => root.render(<ManagedAgentDetail
    family={{ id: 'test', installationIds: [installation.id] } as any}
    snapshot={{ installations: [installation] } as any}
    selectedInstallationId={installation.id}
    onSelectInstallation={() => {}}
    onCloseMobile={() => { returned = true; root.render(<p data-returned-to-list>List</p>) }}
    onChanged={() => {}} onReconnect={() => {}} showBackButton focusBackButton />)
  const backButton = () => [...document.querySelectorAll('button')].find(button => button.querySelector('svg.lucide-arrow-left'))
  await change(renderDetail)
  assert(window.innerWidth < 900, 'detail regression must run in a narrow viewport')
  assert(backButton(), 'pending detail request removed back navigation')
  await change(() => backButton()!.click())
  assert(returned && document.querySelector('[data-returned-to-list]'), 'pending detail request trapped the user')
  // Settle the abandoned request, then test a fresh mounted request failure.
  await change(() => detail.reject(new Error('abandoned detail')))
  detail = deferred()
  returned = false
  await change(renderDetail)
  backButton()!.focus()
  await change(() => detail.reject(new Error('detail unavailable')))
  assert(document.querySelector('[role="alert"]'), 'failed detail did not render its error')
  assert(backButton(), 'failed detail request removed back navigation')
  assert(document.activeElement === backButton(), 'loading-to-error transition discarded navigation focus')
  await change(() => backButton()!.click())
  assert(returned && document.querySelector('[data-returned-to-list]'), 'failed detail request trapped the user')

  // Exercise a fully loaded real detail component, not the loading/error shell.
  // Authentication is an account fact and must not promote configured tools.
  await change(() => root.render(null))
  const rawAuthenticationReason = 'fixture_raw_authentication_reason_do_not_render'
  let authInstallation: AgentIntegrationInstallationDto = {
    id: 'authentication-installation', familyId: 'claude-code', hostVariant: 'claude-code-native',
    displayName: 'Authentication fixture', variantLabel: 'Claude Code', profileLabel: 'Default', version: '1.0.0',
    manageable: true, desiredState: 'managed', statusGroup: 'awaiting_verification', statusReason: 'unverified',
    accessLevel: 'partial', accessIsHistorical: false, unreadEventCount: 0,
    lastDetectedAt: null, lastVerifiedAt: null, lastRepairedAt: null, lastRealUseAt: null,
    components: (['instruction', 'memory_tools', 'lifecycle'] as const).map<AgentIntegrationInstallationDto['components'][number]>(key => ({
      key, state: key === 'lifecycle' ? 'unsupported' : 'configured',
      implementationTypes: [], targetLabel: null, lastVerifiedAt: null,
    })),
    authentication: { status: 'not_checked', billing: 'unknown', reason: rawAuthenticationReason, checkedAt: null },
  }
  const authenticationComponents = authInstallation.components
  let authConnection: AgentIntegrationConnectionDto = {
    id: `installation:${authInstallation.id}`, familyId: authInstallation.familyId, displayName: authInstallation.displayName,
    installationIds: [authInstallation.id], shared: false, bindingGeneration: null, configurationRevision: 'fixture-revision',
    statusGroup: 'awaiting_verification', statusReason: 'unverified', components: authInstallation.components,
    memoryCallsVerified: false, maintenance: 'active', intentRevision: 0, intentState: 'active',
    actionInstallationIds: [], attentionReason: null, issue: null, lastRealUseAt: null,
  }
  const authenticationRequest = deferred<AgentIntegrationAuthenticationDto>()
  const authenticationCalls: string[] = []
  const authenticationDetailCalls: string[] = []
  Object.assign(window.api.agentIntegrations, {
    detail: async (id: string): Promise<AgentIntegrationDetailDto> => {
      authenticationDetailCalls.push(id)
      assert(id === authInstallation.id, 'authentication scene loaded the wrong installation')
      return { installation: authInstallation, configRootLabel: '~/.claude', events: [], requiredUserActionDetails: [] }
    },
    recheckAuthentication: (id: string) => { authenticationCalls.push(id); return authenticationRequest.promise },
  })
  const renderAuthenticationDetail = () => {
    const family: ManagedProductFamilyDto = {
      id: authConnection.id, displayName: authInstallation.displayName, installationIds: [authInstallation.id],
      connection: authConnection, statusGroup: authConnection.statusGroup, accessLevels: [authInstallation.accessLevel],
      needsAttentionCount: 0, unreadEventCount: 0,
    }
    const snapshot: AgentIntegrationSnapshotDto = {
      installations: [authInstallation], connections: [authConnection], families: [family], historyInstallations: [],
      summary: { familyCount: 1, installationCount: 1, availableCount: 0, needsAttentionCount: 0, awaitingConnectionCount: 0 },
      lastScanAt: null,
    }
    root.render(<ManagedAgentDetail family={family} snapshot={snapshot} selectedInstallationId={authInstallation.id}
      onSelectInstallation={() => {}} onCloseMobile={() => {}} onChanged={() => {}} onReconnect={() => {}} showBackButton />)
  }
  const authenticationPanel = () => document.querySelector<HTMLElement>('[data-agent-authentication]')
  const authenticationButton = () => document.querySelector<HTMLButtonElement>('[data-agent-authentication-recheck]')
  const assertMemoryStillUnconfirmed = () => {
    const memory = settings.agent.managed.component.memoryTools
    const labels = [...document.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label'))
    const expectedMemoryState = authInstallation.desiredState === 'removed' ? 'unconnected' : 'configured'
    assert(labels.includes(`${memory}：${settings.agent.managed.componentStatus[expectedMemoryState]}`), 'login check changed the memory tool state')
    assert(!labels.includes(`${memory}：${settings.agent.managed.componentStatus.verified}`), 'login status falsely verified memory tools')
    assert(!document.body.textContent?.includes(rawAuthenticationReason), 'raw authentication reason leaked into rendered detail')
  }
  await change(renderAuthenticationDetail)
  assert(authenticationDetailCalls.length > 0 && authenticationPanel(), 'authentication scene never loaded a real detail response')
  assert(authenticationPanel()!.textContent?.includes(settings.agent.managed.authentication.title), 'login check title missing')
  assert(authenticationPanel()!.textContent?.includes(settings.agent.managed.authentication.status.not_checked), 'unchecked account was reported as signed in')
  assert(authenticationPanel()!.textContent?.includes(settings.agent.managed.authentication.billing.unknown), 'unknown billing omitted the no-model-call explanation')
  assert(authenticationPanel()!.textContent?.includes(settings.agent.managed.authentication.scope), 'login check omitted its verification boundary')
  assertMemoryStillUnconfirmed()
  // Background snapshot invalidations should refresh a changed selected member,
  // but an unrelated snapshot object must not re-inspect this host.
  const unchangedCalls = authenticationDetailCalls.length
  await change(renderAuthenticationDetail)
  assert(authenticationDetailCalls.length === unchangedCalls, 'unchanged selected installation caused a duplicate detail read')
  await change(() => {
    authInstallation = { ...authInstallation, diagnostic: { status: 'checking', reason: 'checking', runId: 'synthetic-diagnostic' } }
    renderAuthenticationDetail()
  })
  assert(authenticationDetailCalls.length === unchangedCalls + 1, 'background diagnostic start did not refresh selected detail')
  assert(document.querySelector('[data-agent-diagnostic="checking"]'), 'background diagnostic checking state was not rendered')
  await change(renderAuthenticationDetail)
  assert(authenticationDetailCalls.length === unchangedCalls + 1, 'same checking state caused repeated detail reads')
  await change(() => {
    authInstallation = { ...authInstallation, diagnostic: { status: 'waiting', reason: 'billing_unconfirmed', runId: null } }
    renderAuthenticationDetail()
  })
  assert(authenticationDetailCalls.length === unchangedCalls + 2, 'background diagnostic completion did not refresh selected detail')
  assert(document.querySelector('[data-agent-diagnostic="waiting"]'), 'completed diagnostic remained in checking state')
  await click('[data-agent-authentication-recheck]')
  assert(authenticationCalls.length === 1 && authenticationCalls[0] === authInstallation.id, 'login recheck did not call the exact installation API once')
  assert(authenticationButton()?.disabled, 'in-flight login recheck remained clickable')
  assert(authenticationPanel()!.textContent?.includes(settings.agent.managed.authentication.status.checking), 'in-flight login check did not show its real busy state')
  await change(() => {
    const authentication: AgentIntegrationAuthenticationDto = {
      status: 'authenticated', billing: 'metered', reason: rawAuthenticationReason, checkedAt: new Date().toISOString(),
    }
    authInstallation = { ...authInstallation, authentication }
    authenticationRequest.resolve(authentication)
  })
  assert(authenticationDetailCalls.length > 1, 'login result was not read back through the loaded detail API')
  assert(authenticationPanel()?.dataset.agentAuthentication === 'authenticated', 'successful login recheck did not refresh the detail state')
  assert(authenticationPanel()!.textContent?.includes(settings.agent.managed.authentication.status.authenticated), 'authenticated account status missing')
  assert(authenticationPanel()!.textContent?.includes(settings.agent.managed.authentication.billing.metered), 'metered billing omitted the no-model-call explanation')
  assert(!authenticationButton()?.disabled, 'completed login recheck remained busy')
  assertMemoryStillUnconfirmed()
  for (const state of ['paused', 'disconnected', 'processing'] as const) {
    await change(() => {
      authInstallation = { ...authInstallation, statusGroup: state,
        desiredState: state === 'paused' ? 'disabled' : state === 'disconnected' ? 'removed' : 'managed',
        components: authenticationComponents.map(component => state === 'disconnected' && component.state !== 'unsupported'
          ? { ...component, state: 'unconnected' } : component) }
      authConnection = { ...authConnection, statusGroup: state,
        components: authInstallation.components,
        intentState: state === 'processing' ? 'active' : state,
        maintenance: state === 'paused' ? 'paused' : state === 'disconnected' ? 'unmanaged' : 'active' }
      renderAuthenticationDetail()
    })
    assert(authenticationPanel(), `${state}: detail disappeared instead of disabling login recheck`)
    assert(authenticationButton()?.disabled, `${state}: login recheck must be disabled`)
    await change(() => authenticationButton()!.click())
    assert(authenticationCalls.length === 1, `${state}: disabled login recheck invoked the API`)
    assertMemoryStillUnconfirmed()
  }
  await change(() => root.render(null))

  // A shared memory check belongs to the connection, while account and
  // lifecycle evidence still belong to the selected Desktop host.
  const sharedDesktop: AgentIntegrationInstallationDto = { ...authInstallation, id: 'shared-desktop',
    familyId: 'codex', hostVariant: 'codex-desktop', variantLabel: 'Desktop', desiredState: 'managed',
    statusGroup: 'awaiting_verification', statusReason: 'unverified',
    components: authenticationComponents.map(component => ({ ...component, configurationVerified: true,
      configurationFingerprint: `shared-${component.key}`, ...(component.key === 'lifecycle' ? { state: 'configured' as const } : {}) })),
    authentication: { status: 'not_checked', billing: 'unknown', reason: 'not_checked', checkedAt: null },
    diagnostic: { status: 'waiting', reason: 'native_diagnostic_unsupported', runId: null } }
  let sharedCli: AgentIntegrationInstallationDto = { ...sharedDesktop, id: 'shared-cli', hostVariant: 'codex-cli', variantLabel: 'CLI',
    authentication: { status: 'authenticated', billing: 'confirmed_subscription', reason: 'authenticated', checkedAt: null },
    diagnostic: { status: 'waiting', reason: 'billing_unconfirmed', runId: null } }
  const unrelatedCli = { ...sharedCli, id: 'other-profile-cli', profileLabel: 'Other profile' }
  let sharedConnection: AgentIntegrationConnectionDto = { ...authConnection, id: 'binding:shared-fixture', shared: true,
    installationIds: [sharedDesktop.id, sharedCli.id], statusGroup: 'awaiting_verification', intentState: 'active',
    maintenance: 'active', memoryCallsVerified: false, components: sharedDesktop.components, diagnostic: sharedCli.diagnostic }
  const diagnosticCalls: string[] = []
  Object.assign(window.api.agentIntegrations, {
    detail: async (id: string) => {
      assert(id === sharedDesktop.id, 'shared check switched the selected host detail')
      return { installation: sharedDesktop, configRootLabel: '~/.codex', events: [], requiredUserActionDetails: [] }
    },
    recheckDiagnostic: async (id: string) => { diagnosticCalls.push(id); return sharedCli.diagnostic },
  })
  const renderSharedDiagnostic = () => {
    const family: ManagedProductFamilyDto = { id: sharedConnection.id, displayName: 'Shared fixture',
      installationIds: sharedConnection.installationIds, connection: sharedConnection, statusGroup: sharedConnection.statusGroup,
      accessLevels: ['partial'], needsAttentionCount: 0, unreadEventCount: 0 }
    const snapshot = { installations: [unrelatedCli, sharedDesktop, sharedCli], connections: [sharedConnection],
      families: [family], historyInstallations: [], summary: { familyCount: 1, installationCount: 3,
        availableCount: 0, needsAttentionCount: 0, awaitingConnectionCount: 0 }, lastScanAt: null }
    root.render(<ManagedAgentDetail family={family} snapshot={snapshot} selectedInstallationId={sharedDesktop.id}
      onSelectInstallation={() => {}} onCloseMobile={() => {}} onChanged={() => {}} onReconnect={() => {}} />)
  }
  await change(renderSharedDiagnostic)
  assert(document.querySelector('[data-agent-diagnostic]')?.textContent?.includes(settings.agent.managed.diagnostic.billing),
    'Desktop unsupported hid the shared CLI billing wait')
  assert(document.querySelector('[data-agent-authentication]')?.getAttribute('data-agent-authentication') === 'not_checked',
    'shared memory diagnostic borrowed the CLI account fact for Desktop')
  await click('[data-agent-diagnostic-recheck]')
  assert(diagnosticCalls.length === 1 && diagnosticCalls[0] === sharedCli.id, 'shared retry did not target its exact CLI member')
  await change(() => { sharedConnection = { ...sharedConnection, diagnostic: { status: 'checking', reason: 'checking', runId: 'shared-run' } }; renderSharedDiagnostic() })
  assert(document.querySelector('[data-agent-diagnostic="checking"]'), 'connection-only background diagnostic update did not render')
  assert(document.querySelector<HTMLButtonElement>('[data-agent-diagnostic-recheck]')?.disabled, 'shared checking was retryable')
  for (const patch of [{ desiredState: 'disabled' }, { desiredState: 'managed', manageable: false },
    { desiredState: 'managed', manageable: true, deactivation: { maintenance: 'paused', bridge: 'stopped', hostComponents: 'loaded_unknown' } }] as const) {
    await change(() => { sharedCli = { ...sharedCli, ...patch }; sharedConnection = { ...sharedConnection, diagnostic: sharedCli.diagnostic }; renderSharedDiagnostic() })
    assert(!document.querySelector('[data-agent-diagnostic-recheck]'), 'inactive/unmanageable shared member remained a retry target')
  }
  await change(() => {
    sharedCli = { ...sharedCli, desiredState: 'managed', manageable: true, deactivation: undefined }
    sharedConnection = { ...sharedConnection, statusGroup: 'available', statusReason: 'verified', memoryCallsVerified: true,
      components: sharedDesktop.components.map(component => component.key !== 'lifecycle' ? { ...component, state: 'verified' } : component) }
    renderSharedDiagnostic()
  })
  const desktopComponents = document.querySelector('[aria-labelledby="components-shared-desktop"]')
  const connectionHeader = desktopComponents?.closest('[role="tabpanel"]')?.previousElementSibling
  assert(connectionHeader?.textContent?.includes(settings.agent.managed.status.available)
    && connectionHeader.textContent.includes(settings.agent.managed.reason.verified)
    && !connectionHeader.textContent.includes(settings.agent.managed.reason.unverified),
  'shared connection header mixed available with the selected host’s unverified summary')
  const lifecycleLabel = settings.agent.managed.component.lifecycle
  const configuredLabel = settings.agent.managed.componentStatus.configured
  const verifiedLabel = settings.agent.managed.componentStatus.verified
  for (const label of [settings.agent.managed.component.instruction, settings.agent.managed.component.memoryTools]) {
    assert(desktopComponents?.querySelector(`[aria-label="${label}：${verifiedLabel}"]`),
      'same-configuration shared Skill/MCP proof was hidden behind a gray member status')
  }
  assert(connectionHeader.querySelector(`[aria-label="${lifecycleLabel}：${configuredLabel}"]`)
    && desktopComponents?.querySelector(`[aria-label="${lifecycleLabel}：${configuredLabel}"]`)
    && !desktopComponents.querySelector(`[aria-label="${lifecycleLabel}：${verifiedLabel}"]`),
  'shared memory success promoted unobserved Desktop session linkage')
  await change(() => {
    sharedConnection = { ...sharedConnection, components: sharedConnection.components.map(component =>
      component.key === 'lifecycle' ? { ...component, state: 'verified' } : component) }
    renderSharedDiagnostic()
  })
  assert(document.querySelector('[aria-labelledby="components-shared-desktop"]')
    ?.querySelector(`[aria-label="${lifecycleLabel}：${configuredLabel}"]`),
  'shared Hook events were presented as selected-host event evidence')
  await change(() => {
    sharedConnection = { ...sharedConnection, components: sharedConnection.components.map(component =>
      component.key === 'instruction' ? { ...component, configurationFingerprint: 'different-configuration' } : component) }
    renderSharedDiagnostic()
  })
  assert(document.querySelector('[aria-labelledby="components-shared-desktop"]')
    ?.querySelector(`[aria-label="${settings.agent.managed.component.instruction}：${configuredLabel}"]`),
  'a different Skill configuration borrowed the shared verification result')
  const availableWithHookAction: AgentIntegrationConnectionDto = {
    ...sharedConnection, actionInstallationIds: [sharedDesktop.id], attentionReason: 'host_confirmation',
    components: sharedConnection.components.map(component => component.key === 'lifecycle'
      ? { ...component, state: 'confirmation_required', hostRecognitionVerified: false, hostRecognitionRejected: true }
      : component),
    issue: { eventId: 'fixture-hook-action', reason: 'host_confirmation', dismissed: true },
  }
  await change(() => root.render(<ManagedFamilyList snapshot={{
    installations: [sharedDesktop, sharedCli], connections: [availableWithHookAction],
    families: [], historyInstallations: [], lastScanAt: null,
    summary: { familyCount: 1, installationCount: 2, availableCount: 1, needsAttentionCount: 1, awaitingConnectionCount: 0 },
  }} selectedFamilyId={null} onSelect={() => {}} />))
  const issueRow = document.querySelector('[data-agent-connection-row="binding:shared-fixture"]')
  const rowTrigger = issueRow?.querySelector('[data-agent-connection-trigger]')
  const accessibleSummary = document.getElementById(rowTrigger?.getAttribute('aria-describedby') ?? '')
  const hookAction = settings.agent.managed.reason.hostConfirmation
  assert(issueRow?.querySelector('[data-agent-current-issue]')?.textContent === hookAction
    && accessibleSummary?.textContent?.includes(hookAction)
    && Array.from(issueRow.querySelectorAll('span')).some(span => span.textContent === settings.agent.managed.status.available
      && span.className.includes('text-emerald')),
  'a current Hook action was hidden or replaced the available connection badge')
  await change(() => {
    sharedConnection = { ...sharedConnection, id: 'installation:desktop-independent', shared: false,
      installationIds: [sharedDesktop.id], statusGroup: 'awaiting_verification', statusReason: 'unverified',
      memoryCallsVerified: false, components: sharedDesktop.components, diagnostic: sharedDesktop.diagnostic }
    renderSharedDiagnostic()
  })
  assert(!document.querySelector('[data-agent-diagnostic-recheck]'), 'independent Desktop borrowed another profile CLI for retry')
  assert(diagnosticCalls.length === 1, 'disabled or independent scene submitted a diagnostic')
  await change(() => root.render(null))

  // Keep the same mounted batch dialog while closing/reopening it. Each API
  // promise is independent, so old success, failure and finally paths can settle
  // while the new session's first preview is still pending.
  const plan = (name = 'CURRENT_AGENT') => ({
    planHash: name,
    installations: [{ installationId: installation.id, displayName: name, desiredCapability: 3,
      componentKeys: ['instruction'], requiredUserActions: [], targets: [{ componentKey: 'instruction',
        risk: 'low', reversible: true, scope: 'user', targetLabel: '~/.agent/skill', commandCategory: 'file_write' }] }],
  })
  const task = (state = 'running', status = 'committed') => ({
    id: 'old-task', planHash: 'old-plan', state, pendingInstallationIds: [],
    results: state === 'completed' ? [{ installationId: installation.id, status }] : [],
  })
  const clickText = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === label)
    assert(button && !button.disabled, `missing batch button: ${label}`)
    await change(() => button.click())
  }
  for (const stage of ['start', 'readback', 'retry', 'recovery', 'reload']) {
    for (const reject of [false, true]) {
      await change(() => root.render(null))
      let batchOpen = true
      let nextPreview: ReturnType<typeof deferred> | null = null
      const startRequest = deferred()
      const readRequest = deferred()
      const updates: any[] = []
      let completed = 0
      let progress: ((value: any) => void) | null = null
      Object.assign(window.api.agentIntegrations, {
        previewConnect: () => nextPreview?.promise ?? Promise.resolve(plan()),
        startApplyConnect: () => startRequest.promise,
        getApplyTask: () => readRequest.promise,
        onTaskProgress: (listener: (value: any) => void) => { progress = listener; return () => { progress = null } },
      })
      const renderBatch = () => root.render(<StrictMode><BatchConnectDialog open={batchOpen}
        snapshot={{ installations: [{ ...installation, manageable: true, statusGroup: 'awaiting_connection', variantLabel: 'Test' }] } as any}
        onClose={() => { batchOpen = false; renderBatch() }}
        onComplete={() => { completed += 1 }} onTaskUpdate={value => { updates.push(value) }} /></StrictMode>)
      await change(renderBatch)
      await clickText('Continue with 1')
      await clickText('Connect 1 installations')
      let oldRequest = startRequest
      if (stage === 'readback') {
        await change(() => startRequest.resolve(task()))
        oldRequest = readRequest
      } else if (stage === 'retry' || stage === 'recovery') {
        const finished = task('completed', stage === 'retry' ? 'failed' : 'needs_recovery')
        await change(() => { readRequest.resolve(finished); startRequest.resolve(finished) })
        nextPreview = deferred()
        oldRequest = nextPreview
        await clickText(stage === 'retry' ? 'Retry failed (1)' : 'Review and generate a new plan (1)')
      } else if (stage === 'reload') {
        await change(() => startRequest.reject(new Error('initial start failed')))
        nextPreview = deferred()
        oldRequest = nextPreview
        await clickText('Regenerate plan')
      }
      if (stage === 'reload') {
        // Reload returns to the non-dismissible selection stage; exercise an
        // external prop close too, without weakening the production close rule.
        await change(() => { batchOpen = false; renderBatch() })
      } else {
        await change(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      }
      assert(!document.querySelector('[role="dialog"]'), `${stage}: did not close`)
      const freshPreview = deferred()
      nextPreview = freshPreview
      await change(() => { batchOpen = true; renderBatch() })
      await change(() => {
        if (reject) oldRequest.reject(new Error(`STALE_${stage}_FAILURE`))
        else if (stage === 'start') { readRequest.resolve(task('completed')); oldRequest.resolve(task()) }
        else if (stage === 'readback') oldRequest.resolve(task('completed'))
        else oldRequest.resolve(plan('STALE_PLAN'))
      })
      const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      assert(close?.disabled, `${stage}/${reject}: old finally cleared new preview loading`)
      assert(!document.body.textContent?.includes('STALE_'), `${stage}/${reject}: old response leaked into new dialog`)
      assert(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy') === 'true', `${stage}: lost busy state`)
      if ((stage === 'start' || stage === 'readback') && !reject) {
        assert(updates.some(value => value.state === 'completed') && completed === 1, `${stage}: closed task lost global completion`)
        await change(() => progress?.(task('completed')))
        assert(completed === 1, `${stage}: duplicate progress repeated global completion`)
        assert(close?.disabled, `${stage}: old progress changed new dialog loading`)
      }
      await change(() => freshPreview.resolve(plan()))
      assert(document.body.textContent?.includes('CURRENT_AGENT'), `${stage}: fresh preview discarded`)
      assert(!document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.disabled, `${stage}: fresh preview stayed busy`)
      if (stage !== 'reload' && !(stage === 'start' && reject)) {
        const updateCount = updates.length
        await change(() => progress?.(task()))
        assert(updates.length === updateCount + 1, `${stage}: old task lost background tracking`)
        assert(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy') === 'false', `${stage}: old task progress rebound to the new dialog`)
      }
    }
  }
  await change(() => root.render(null))
  // Native permissions are reviewed separately from ordinary automatic setup.
  const nativePlan = { ...plan('NATIVE_PLAN'), installations: [{ ...plan().installations[0],
    nativePermissions: ['gemini_extension'], hostVersion: '1.2.3',
    nativePlugin: { name: 'tidemind-fixture', version: '1.0.23', sourceLabel: '~/data/local-extension' },
    targets: [{ ...plan().installations[0].targets[0], commandCategory: 'plugin_install' }],
  }] }
  let nativeCalls: any[] = []
  Object.assign(window.api.agentIntegrations, {
    previewConnect: async () => nativePlan,
    startApplyConnect: async (...args: any[]) => { nativeCalls.push(args); return task('completed') },
    getApplyTask: async () => task('completed'), onTaskProgress: () => () => {},
  })
  await change(() => root.render(<BatchConnectDialog open
    snapshot={{ installations: [{ ...installation, manageable: true, statusGroup: 'awaiting_connection', variantLabel: 'Gemini' }] } as any}
    onClose={() => {}} onComplete={() => {}} onTaskUpdate={() => {}} />))
  const nativeCheckbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  assert(nativeCheckbox && !nativeCheckbox.checked, 'native permission was selected automatically')
  await change(() => nativeCheckbox.click())
  await clickText('Continue with 1')
  for (const text of ['tidemind-fixture', '1.0.23', '~/data/local-extension', 'Host version: 1.2.3', 'extension security notice']) {
    assert(document.body.textContent?.includes(text), `native review omitted ${text}`)
  }
  assert(nativeCalls.length === 0, 'preview already granted native permissions')
  await clickText('Authorize permissions and connect')
  assert(nativeCalls.length === 1 && nativeCalls[0][0] === 'NATIVE_PLAN'
    && JSON.stringify(nativeCalls[0][1]) === JSON.stringify([installation.id]), 'native approval lost the frozen plan binding')
  await change(() => root.render(null))

  const feedSnapshot: AgentIntegrationSnapshotDto = {
    installations: [], connections: [], families: [], historyInstallations: [],
    summary: { familyCount: 0, installationCount: 0, availableCount: 0, needsAttentionCount: 0, awaitingConnectionCount: 0 },
    lastScanAt: null,
  }
  const stateListeners = new Set<() => void>()
  let feedReads = 0
  const progressListeners = new Set<(task: AgentIntegrationApplyTaskDto) => void>()
  let snapshotReads = 0
  Object.assign(window.api.agentIntegrations, {
    snapshot: async () => { snapshotReads += 1; return feedSnapshot },
    scan: async () => ({ snapshot: feedSnapshot, detectedCount: 0, newlyDiscoveredCount: 0, unresolved: [] }),
    listApplyTasks: async () => { feedReads += 1; throw new Error('history must not load on the Agent page') },
    onTaskProgress: (listener: (task: AgentIntegrationApplyTaskDto) => void) => {
      progressListeners.add(listener)
      return () => { progressListeners.delete(listener) }
    },
    onStateChanged: (listener: () => void) => {
      stateListeners.add(listener)
      return () => { stateListeners.delete(listener) }
    },
  })
  await change(() => root.render(<MemoryRouter><AgentIntegration /></MemoryRouter>))
  await click('[aria-controls="agent-advanced-connections"]')
  const feedCard = () => document.querySelector('[data-task-feed-key]')
  assert(!feedCard(), 'empty fixture unexpectedly has a background task')
  const beforeInvalidation = snapshotReads
  await change(() => { for (const listener of stateListeners) listener() })
  assert(snapshotReads > beforeInvalidation, 'state invalidation did not refresh current Agent status')
  const beforeProgress = snapshotReads
  await change(() => { for (const listener of progressListeners) listener(task('completed')) })
  assert(snapshotReads > beforeProgress, 'background progress did not refresh current Agent status')
  assert(feedReads === 0 && !feedCard() && !document.querySelector('#agent-task-history'),
    'Agent page still loads or renders global task history')
  await change(() => root.render(null))

  // Delay frames deterministically: an opening/closing frame may arrive after
  // the next IPC result or even after reopening this dialog.
  const nativeRaf = window.requestAnimationFrame
  const nativeCancelRaf = window.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
  window.cancelAnimationFrame = id => { frames.delete(id) }
  let customOpen = true
  let customRequest: any
  Object.assign(window.api.agentIntegrations, {
    pickCustomPath: async () => '/isolated/private-agent',
    previewCustomInstallation: async (request: any) => {
      customRequest = request
      return { preflightHash: 'custom', displayName: 'Custom', hostLabel: 'Custom', targetLabel: 'User owned', agentId: 'custom-id', componentKeys: ['memory_tools'], warnings: [] }
    },
  })
  const renderCustom = () => root.render(<StrictMode><button data-custom-origin>Origin</button><CustomLocalAgentDialog open={customOpen}
    sourceInstallations={[]} legacyCustomInstallations={[]} initialLegacyInstallationId={null}
    onClose={() => { customOpen = false; renderCustom() }} onComplete={() => {}} onReviewResult={() => {}} /></StrictMode>)
  await change(renderCustom)
  await change(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await change(() => { customOpen = true; renderCustom() })
  await click('input[value="manual_mcp_client"]')
  await change(() => {
    const input = document.querySelector<HTMLInputElement>('[data-custom-agent-dialog] input[maxlength="80"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Custom')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Exercise managed -> guided while retaining a visible explicit schema.
  await click('[data-custom-agent-dialog] input[type="checkbox"]')
  await change(() => {
    const select = document.querySelector<HTMLSelectElement>('[data-custom-agent-dialog] select')!
    select.value = 'opencode_mcp'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('[data-custom-agent-dialog] input[type="checkbox"]')
  assert(document.querySelector<HTMLSelectElement>('[data-custom-agent-dialog] select')?.value === 'opencode_mcp', 'guided schema selection was hidden or reset')
  const picker = document.querySelector<HTMLInputElement>('[data-custom-agent-dialog] input[readonly]')!.parentElement!.querySelector('button')!
  await change(() => picker.click())
  await click('[data-custom-agent-preview]')
  assert(customRequest.configurationOwnership === 'user' && customRequest.schemaKind === 'opencode_mcp', 'guided request does not match visible schema')
  assert(document.activeElement === document.querySelector('[data-custom-agent-step-content]'), 'Custom preflight did not acquire focus')
  await change(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(performance.now())) })
  assert(document.activeElement === document.querySelector('[data-custom-agent-step-content]'), 'delayed Custom opening/restoration frame stole step focus')
  await change(() => root.unmount())
  window.requestAnimationFrame = nativeRaf
  window.cancelAnimationFrame = nativeCancelRaf
  return { coworkDelayedSessions: true, narrowPendingAndFailedBackNavigation: true, loadedAuthenticationDetail: true, sharedDiagnosticTarget: true,
    batchDelayedSessions: true, customDelayedFocusAndSchema: true, backgroundTaskStateRefresh: true, sharedStatusSummary: true, availableConnectionIssue: true }
}

Object.assign(window, { regressionResult: run().then(result => ({ ok: true, result }), error => ({ ok: false, error: error.stack })) })
