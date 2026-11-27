import { act, useCallback } from '../../client/node_modules/react/index.js'
import { createRoot } from '../../client/node_modules/react-dom/client.js'
import i18n from '../../client/node_modules/i18next/dist/esm/i18next.js'
import { initReactI18next } from '../../client/node_modules/react-i18next/dist/es/index.js'
import { MemoryRouter } from '../../client/node_modules/react-router-dom/dist/index.mjs'
import common from '../../client/src/locales/en/common.json'
import dashboard from '../../client/src/locales/en/dashboard.json'
import constants from '../../client/src/locales/en/constants.json'
import timeline from '../../client/src/locales/en/timeline.json'
import { useIPC } from '../../client/src/hooks/useIPC'
import { DataChangeProvider } from '../../client/src/contexts/DataChangeContext'
import { Dashboard } from '../../client/src/pages/Dashboard'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

function mount() {
  const container = document.createElement('div')
  document.getElementById('root')!.appendChild(container)
  const root = createRoot(container)
  return { container, root, unmount: async () => { await act(async () => root.unmount()); container.remove() } }
}

/* ---------------- useIPC ---------------- */

type Snapshot = { data: string | null; loading: boolean; error: string | null }

function createProbe() {
  const calls: Array<ReturnType<typeof deferred<string>> & { query: string }> = []
  const renders: Snapshot[] = []
  function Probe({ query, refreshKey }: { query: string; refreshKey?: number }) {
    const fetcher = useCallback(() => {
      const call = Object.assign(deferred<string>(), { query })
      calls.push(call)
      return call.promise
    }, [query])
    const { data, loading, error } = useIPC(fetcher, refreshKey)
    renders.push({ data, loading, error })
    return <output data-probe>{JSON.stringify({ data, loading, error })}</output>
  }
  const current = () => renders[renders.length - 1]
  return { Probe, calls, renders, current }
}

async function withProbe(body: (ctx: ReturnType<typeof createProbe> & {
  render: (query: string, refreshKey?: number) => Promise<void>
  resolve: (index: number, value: string) => Promise<void>
  reject: (index: number, message: string) => Promise<void>
}) => Promise<void>) {
  const probe = createProbe()
  const { root, unmount } = mount()
  const render = (query: string, refreshKey?: number) =>
    act(async () => { root.render(<probe.Probe query={query} refreshKey={refreshKey} />) })
  const resolve = (index: number, value: string) => act(async () => { probe.calls[index].resolve(value); await Promise.resolve() })
  const reject = (index: number, message: string) => act(async () => { probe.calls[index].reject(new Error(message)); await Promise.resolve() })
  try { await body({ ...probe, render, resolve, reject }) } finally { await unmount() }
}

const ipcScenarios: Record<string, () => Promise<void>> = {
  async ipcInitialMountFetchesOnce() {
    await withProbe(async ({ render, resolve, calls, current }) => {
      await render('a', 1)
      assert(calls.length === 1, `expected 1 request on mount, got ${calls.length}`)
      assert(current().loading && current().data === null, 'initial state is not loading')
      await resolve(0, 'a1')
      assert(current().data === 'a1' && !current().loading, 'initial data not shown')
      assert(calls.length === 1, `expected still 1 request, got ${calls.length}`)
    })
  },

  async ipcRefreshKeyKeepsData() {
    await withProbe(async ({ render, resolve, calls, renders, current }) => {
      await render('a', 1)
      await resolve(0, 'a1')
      const from = renders.length
      await render('a', 2)
      assert(calls.length === 2, `expected a second request after refreshKey change, got ${calls.length}`)
      await resolve(1, 'a2')
      const during = renders.slice(from)
      assert(during.every(snapshot => snapshot.data !== null), 'data was cleared during a silent refresh')
      assert(during.every(snapshot => !snapshot.loading), 'loading was raised during a silent refresh')
      assert(current().data === 'a2', 'refreshed data not shown')
    })
  },

  async ipcFetcherChangeResets() {
    await withProbe(async ({ render, resolve, calls, renders, current }) => {
      await render('a', 1)
      await resolve(0, 'a1')
      const from = renders.length
      await render('b', 1)
      assert(calls.length === 2 && calls[1].query === 'b', 'query change did not request the new query once')
      assert(renders.slice(from).some(snapshot => snapshot.data === null && snapshot.loading), 'query change did not clear previous data')
      await resolve(1, 'b1')
      assert(current().data === 'b1' && !current().loading, 'new query data not shown')
    })
  },

  async ipcBothChangeFetchesOnce() {
    await withProbe(async ({ render, resolve, calls, renders, current }) => {
      await render('a', 1)
      await resolve(0, 'a1')
      const from = renders.length
      await render('b', 2)
      assert(calls.length === 2, `expected exactly one request when query and refreshKey change together, got ${calls.length - 1}`)
      assert(renders.slice(from).some(snapshot => snapshot.data === null && snapshot.loading), 'combined change was not treated as a query change')
      await resolve(1, 'b2')
      assert(current().data === 'b2', 'combined change data not shown')
    })
  },

  async ipcRefreshDuringInitialLoad() {
    await withProbe(async ({ render, resolve, calls, renders, current }) => {
      await render('a', 1)
      await render('a', 2)
      assert(calls.length === 2, `expected a second request, got ${calls.length}`)
      assert(current().loading, 'loading dropped while the first data is still pending')
      await resolve(0, 'stale')
      assert(current().data === null && current().loading, 'superseded initial response was applied')
      await resolve(1, 'fresh')
      assert(current().data === 'fresh' && !current().loading, 'latest response not shown')
      assert(renders.every(snapshot => snapshot.data !== 'stale'), 'stale data was rendered')
    })
  },

  async ipcOutOfOrderRefresh() {
    await withProbe(async ({ render, resolve, calls, renders, current }) => {
      await render('a', 1)
      await resolve(0, 'a1')
      await render('a', 2)
      await render('a', 3)
      assert(calls.length === 3, `expected 3 requests, got ${calls.length}`)
      await resolve(2, 'a3')
      await resolve(1, 'a2')
      assert(current().data === 'a3', `late response overwrote newer data: ${current().data}`)
      assert(renders.every(snapshot => snapshot.data !== 'a2'), 'superseded data was rendered')
    })
  },

  async ipcSilentRefreshFailureKeepsData() {
    await withProbe(async ({ render, resolve, reject, calls, current }) => {
      await render('a', 1)
      await resolve(0, 'a1')
      await render('a', 2)
      assert(calls.length === 2, `expected a second request, got ${calls.length}`)
      await reject(1, 'boom')
      assert(current().data === 'a1', 'data lost after a failed silent refresh')
      assert(current().error === 'boom' && !current().loading, 'error not reported after a failed silent refresh')
      await render('a', 3)
      await resolve(2, 'a3')
      assert(current().data === 'a3' && current().error === null, 'error not cleared by the next successful refresh')
    })
  },

  async ipcWithoutRefreshKeyIsUnchanged() {
    await withProbe(async ({ render, resolve, calls, current }) => {
      await render('a')
      await resolve(0, 'a1')
      await render('a')
      assert(calls.length === 1, 're-render without changes triggered a request')
      await render('b')
      assert(calls.length === 2 && current().data === null, 'query change without refreshKey did not reset')
    })
  },
}

/* ---------------- Dashboard ---------------- */

function createDashboardApi() {
  const counts = { metrics: 0, activity: 0, tags: 0, discoveries: 0, connections: 0 }
  let tagName = 'starlight-roadmap'
  let hold: ReturnType<typeof deferred<void>> | null = null
  let push: ((payload: { scopes: string[] }) => void) | null = null
  const gate = async <T,>(value: T) => { if (hold) await hold.promise; return value }
  const trend = [{ date: '2026-01-01', count: 1 }, { date: '2026-01-02', count: 2 }]
  const api = {
    onDataChanged: (callback: (payload: { scopes: string[] }) => void) => { push = callback; return () => { push = null } },
    stats: {
      dashboardMetrics: () => { counts.metrics += 1; return gate({ totalMemories: 12, todayDigests: 3, todayNewLinks: 2, todayRecalls: 1,
        memoryTrend: trend, digestTrend: trend, linkTrend: trend, recallTrend: trend }) },
      dashboardActivity: () => { counts.activity += 1; return gate([{ id: 1, type: 'digest', subtype: 'created', title: 'DataPilot kickoff notes', node_ids: null, created: '2026-01-02T08:00:00.000Z' }]) },
      dashboardTags: () => { counts.tags += 1; return gate([{ tag: tagName, count: 4, lastActivity: '2026-01-02T08:00:00.000Z', isCore: true }]) },
    },
    timeline: { list: () => { counts.discoveries += 1; return gate({ events: [], total: 0 }) } },
    connections: { list: async () => { counts.connections += 1; return [{ status: 'online', archived: false }] } },
    noteSources: { list: async () => [], initSnapshot: async () => null },
    write: { submitFeedback: async () => ({ success: true }) },
  }
  return {
    api, counts,
    setTagName: (next: string) => { tagName = next },
    holdResponses: () => { hold = deferred<void>() },
    releaseResponses: async () => { const pending = hold; hold = null; await act(async () => { pending?.resolve(); await Promise.resolve() }); await settle() },
    push: (scopes: string[]) => act(async () => { assert(push, 'no data-changed subscriber'); push({ scopes }) }),
  }
}

async function withDashboard(body: (ctx: ReturnType<typeof createDashboardApi> & {
  container: HTMLElement
  sawSkeleton: () => boolean
}) => Promise<void>) {
  const harness = createDashboardApi()
  Object.assign(window, { api: harness.api })
  const { container, root, unmount } = mount()
  let skeletonSeen = false
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      if (node.matches('.skeleton') || node.querySelector('.skeleton')) skeletonSeen = true
    }
  })
  try {
    await act(async () => { root.render(<MemoryRouter><DataChangeProvider><Dashboard /></DataChangeProvider></MemoryRouter>) })
    await settle()
    assert(!container.querySelector('.skeleton'), 'dashboard never left its initial skeleton')
    assert(container.textContent?.includes('starlight-roadmap'), 'dashboard content did not render: ' + container.textContent?.slice(0, 400))
    observer.observe(container, { childList: true, subtree: true })
    await body({
      ...harness, container,
      sawSkeleton: () => { for (const record of observer.takeRecords()) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('.skeleton') || node.querySelector('.skeleton'))) skeletonSeen = true
      } return skeletonSeen },
    })
  } finally {
    observer.disconnect()
    await unmount()
  }
}

const dashboardScenarios: Record<string, () => Promise<void>> = {
  async dashboardIgnoresCloudHeartbeat() {
    await withDashboard(async ({ counts, push, container, sawSkeleton }) => {
      const before = { ...counts }
      const rootNode = container.firstElementChild
      await push(['cloud'])
      await settle()
      assert(counts.metrics === before.metrics && counts.activity === before.activity && counts.tags === before.tags,
        `cloud heartbeat refetched dashboard data: ${JSON.stringify(counts)}`)
      assert(counts.discoveries === before.discoveries, 'cloud heartbeat refetched discoveries')
      assert(!sawSkeleton(), 'cloud heartbeat showed a skeleton')
      assert(container.firstElementChild === rootNode, 'cloud heartbeat remounted the dashboard content')
    })
  },

  async dashboardNodesChangeRefreshesInPlace() {
    await withDashboard(async ({ counts, push, container, sawSkeleton, holdResponses, releaseResponses, setTagName }) => {
      const before = { ...counts }
      const rootNode = container.firstElementChild
      setTagName('orbital-launch-plan')
      holdResponses()
      await push(['nodes'])
      await settle()
      assert(counts.metrics === before.metrics + 1 && counts.activity === before.activity + 1 && counts.tags === before.tags + 1,
        `nodes change did not refetch each dashboard query once: ${JSON.stringify(counts)} from ${JSON.stringify(before)}`)
      assert(counts.discoveries === before.discoveries, 'nodes change refetched discoveries')
      assert(!container.querySelector('.skeleton'), 'skeleton is visible while a background refresh is pending')
      assert(container.textContent?.includes('starlight-roadmap'), 'previous content disappeared while refreshing')
      await releaseResponses()
      assert(!sawSkeleton(), 'a skeleton appeared during a background refresh')
      assert(container.firstElementChild === rootNode, 'dashboard content was remounted by a background refresh')
      assert(container.textContent?.includes('orbital-launch-plan'), 'refreshed data was not rendered')
      assert(!container.textContent?.includes('starlight-roadmap'), 'previous data is still rendered after the refresh')
    })
  },

  async dashboardTimelineChangeRefreshesDiscoveries() {
    await withDashboard(async ({ counts, push, sawSkeleton }) => {
      const before = { ...counts }
      await push(['timeline'])
      await settle()
      assert(counts.metrics === before.metrics + 1 && counts.activity === before.activity + 1 && counts.tags === before.tags + 1,
        `timeline change did not refetch each dashboard query once: ${JSON.stringify(counts)} from ${JSON.stringify(before)}`)
      assert(counts.discoveries === before.discoveries + 1, 'timeline change did not refetch discoveries once')
      assert(!sawSkeleton(), 'a skeleton appeared after a timeline change')
    })
  },

  async dashboardRefreshesWhenUtcDayChanges() {
    const realNow = Date.now
    try {
      await withDashboard(async ({ counts, container, sawSkeleton }) => {
        const before = { ...counts }
        const rootNode = container.firstElementChild
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        await settle()
        assert(counts.metrics === before.metrics, 'visibility change within the same day refetched metrics')
        const tomorrow = realNow() + 24 * 60 * 60 * 1000
        Date.now = () => tomorrow
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        await settle()
        assert(counts.metrics === before.metrics + 1 && counts.activity === before.activity + 1 && counts.tags === before.tags + 1,
          `day change did not refetch each dashboard query once: ${JSON.stringify(counts)} from ${JSON.stringify(before)}`)
        assert(counts.discoveries === before.discoveries, 'day change refetched discoveries')
        assert(!sawSkeleton(), 'a skeleton appeared after the day changed')
        assert(container.firstElementChild === rootNode, 'dashboard content was remounted when the day changed')
      })
    } finally {
      Date.now = realNow
    }
  },

  async dashboardOllamaMissingRechecksModels() {
    await withDashboard(async ({ counts, push, sawSkeleton }) => {
      const before = { ...counts }
      await push(['ollama-missing'])
      await settle()
      assert(counts.connections === before.connections + 1, `model warning did not recheck connections: ${counts.connections}`)
      assert(counts.metrics === before.metrics && counts.activity === before.activity && counts.tags === before.tags,
        'ollama-missing refetched dashboard data')
      assert(!sawSkeleton(), 'ollama-missing showed a skeleton')
    })
  },
}

async function run() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common, dashboard, constants, timeline } },
    interpolation: { escapeValue: false },
  })
  const scenarios = { ...ipcScenarios, ...dashboardScenarios }
  const passed: string[] = []
  const failures: Record<string, string> = {}
  for (const [name, scenario] of Object.entries(scenarios)) {
    try { await scenario(); passed.push(name) } catch (error) { failures[name] = (error as Error).message }
  }
  return { ok: Object.keys(failures).length === 0, passed, failures }
}

Object.assign(window, { regressionResult: run().catch(error => ({ ok: false, passed: [], failures: { harness: String(error?.stack ?? error) } })) })
