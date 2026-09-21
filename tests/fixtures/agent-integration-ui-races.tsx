import { act, StrictMode } from '../../client/node_modules/react/index.js'
import { createRoot } from '../../client/node_modules/react-dom/client.js'
import i18n from '../../client/node_modules/i18next/dist/esm/i18next.js'
import { initReactI18next } from '../../client/node_modules/react-i18next/dist/es/index.js'
import settings from '../../client/src/locales/en/settings.json'
import { SupportCatalogDialog } from '../../client/src/components/settings/AgentIntegration'
import { ManagedAgentDetail } from '../../client/src/components/settings/agent-integration-managed/ManagedAgentDetail'
import { BatchConnectDialog } from '../../client/src/components/settings/agent-integration-managed/BatchConnectDialog'
import { CustomLocalAgentDialog } from '../../client/src/components/settings/agent-integration-managed/CustomLocalAgentDialog'

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
  return { coworkDelayedSessions: true, narrowPendingAndFailedBackNavigation: true, batchDelayedSessions: true, customDelayedFocusAndSchema: true }
}

Object.assign(window, { regressionResult: run().then(result => ({ ok: true, result }), error => ({ ok: false, error: error.stack })) })
