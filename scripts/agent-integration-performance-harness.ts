import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { ensureAgentIntegrationSchema } from '../src/db/agent-integration-schema.js'
import {
  P0_DISCOVERY_PROBES,
  discoverLocalP0Agents,
  type DiscoveryDependencies,
} from '../client/electron/agent-integration/discovery.js'
import { canonicalizeInstallationIdentity } from '../client/electron/agent-integration/identity.js'
import { ManagedAgentReconciler } from '../client/electron/agent-integration/reconciler.js'
import { AgentIntegrationRepository } from '../client/electron/agent-integration/repository.js'
import { AgentIntegrationService } from '../client/electron/agent-integration/service.js'

const PROTOCOL_VERSION = 1
const PROBE_OPERATION_TIMEOUT_MS = 20
const PROBE_WARMUP_RUNS = 1
const PROBE_MEASURED_RUNS = 5
const QUERY_WARMUP_RUNS = 2
const QUERY_MEASURED_RUNS = 7
const SCAN_ROUNDS = 100
const RECONCILE_ROUNDS = 100
const T0 = '2026-08-26T00:00:00.000Z'

interface TimingSummary {
  samplesMs: number[]
  p50: number
  p95: number
  max: number
}

function requireIsolatedRoot(): { root: string; home: string; resultPath: string } {
  const rootValue = process.env.TIDEMIND_AGENT_INTEGRATION_PERF_ROOT
  const resultValue = process.env.TIDEMIND_AGENT_INTEGRATION_PERF_RESULT
  if (!rootValue || !resultValue) throw new Error('isolated performance root and result path are required')
  const root = fs.realpathSync(rootValue)
  const home = fs.realpathSync(process.env.HOME ?? '')
  const resultPath = path.join(fs.realpathSync(path.dirname(resultValue)), path.basename(resultValue))
  const inside = (candidate: string) => {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }
  if (!inside(home) || !inside(resultPath)) throw new Error('performance paths escaped the isolated root')
  if (home !== path.join(root, 'home')) throw new Error('HOME is not the frozen isolated performance home')
  return { root, home, resultPath }
}

function rounded(value: number): number {
  return Number(value.toFixed(6))
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

async function measure(
  operation: () => unknown | Promise<unknown>,
  warmupRuns: number,
  measuredRuns: number,
): Promise<TimingSummary> {
  for (let index = 0; index < warmupRuns; index += 1) await operation()
  const samplesMs: number[] = []
  for (let index = 0; index < measuredRuns; index += 1) {
    const startedAt = performance.now()
    await operation()
    samplesMs.push(rounded(performance.now() - startedAt))
  }
  return {
    samplesMs,
    p50: percentile(samplesMs, 0.50),
    p95: percentile(samplesMs, 0.95),
    max: percentile(samplesMs, 1),
  }
}

function openPhysicalDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  ensureAgentIntegrationSchema(db)
  return db
}

function seedQueryFixture(
  db: Database.Database,
  fixtureRoot: string,
  installationCount: number,
  eventCount: number,
): void {
  const insertInstallation = db.prepare(`
    INSERT INTO agent_installations (
      id, family, host_variant, runtime_realm, profile_id, install_key,
      provenance, os_user_identity, display_name, config_root, agent_id,
      supported_capability, last_detected_at, metadata_json, created_at, updated_at
    ) VALUES (?, 'qwen-code', 'qwen-code-cli', 'local_macos', ?, ?,
      'performance-fixture', 'perf-user-0001', ?, ?, ?, 4, ?, '{}', ?, ?)
  `)
  const insertComponent = db.prepare(`
    INSERT INTO installation_components (
      installation_id, component_key, desired_state, desired_capability,
      delivery_mode, verification_status, visibility_state, created_at, updated_at
    ) VALUES (?, ?, 'unmanaged', 0, 'managed', 'unverified', 'absent', ?, ?)
  `)
  const insertEvent = db.prepare(`
    INSERT INTO agent_integration_events (
      id, installation_id, kind, severity, state, payload_json, created_at
    ) VALUES (?, ?, 'performance_fixture_event', 'info', ?, '{}', ?)
  `)
  db.transaction(() => {
    for (let index = 0; index < installationCount; index += 1) {
      const suffix = String(index).padStart(6, '0')
      const installationId = `perf-installation-${suffix}`
      const profile = `profile-${suffix}`
      const configRoot = path.join(fixtureRoot, 'agent-config-roots', suffix)
      insertInstallation.run(
        installationId,
        profile,
        `perf-install-key-${suffix}`,
        `Qwen Code ${suffix}`,
        configRoot,
        `eb_perf_${suffix}`,
        T0,
        T0,
        T0,
      )
      for (const componentKey of ['instruction', 'memory_tools', 'lifecycle']) {
        insertComponent.run(installationId, componentKey, T0, T0)
      }
    }
    for (let index = 0; index < eventCount; index += 1) {
      const eventSuffix = String(index).padStart(12, '0')
      const installationSuffix = String(index % installationCount).padStart(6, '0')
      insertEvent.run(
        `perf-event-${eventSuffix}`,
        `perf-installation-${installationSuffix}`,
        index % 5 === 0 ? 'read' : 'unread',
        `2026-08-26T00:00:${String(index % 60).padStart(2, '0')}.${String(index % 1_000).padStart(3, '0')}Z`,
      )
    }
  })()
}

function seedTaskFeedFixture(db: Database.Database, taskCount: number): void {
  db.prepare(`
    INSERT INTO agent_installations (
      id, family, host_variant, runtime_realm, install_key, provenance,
      display_name, supported_capability, last_detected_at, metadata_json,
      created_at, updated_at
    ) VALUES (
      'perf-task-feed-installation', 'qwen-code', 'qwen-code-cli', 'local_macos',
      'perf-task-feed', 'performance-fixture', 'Qwen Code Task Feed', 4, ?, '{}', ?, ?
    )
  `).run(T0, T0, T0)
  const insertTask = db.prepare(`
    INSERT INTO agent_integration_apply_tasks (
      id, plan_hash, operation_type, state, started_at, completed_at, updated_at
    ) VALUES (?, ?, 'connect', 'completed', ?, ?, ?)
  `)
  const insertItem = db.prepare(`
    INSERT INTO agent_integration_apply_task_items (
      task_id, installation_id, ordinal, execution_plan_hash, state,
      result_json, started_at, completed_at, updated_at
    ) VALUES (?, 'perf-task-feed-installation', 0, ?, 'terminal', ?, ?, ?, ?)
  `)
  db.transaction(() => {
    for (let index = 0; index < taskCount; index += 1) {
      const suffix = String(index).padStart(6, '0')
      const id = `perf-task-${suffix}`
      const timestamp = new Date(Date.parse(T0) + index).toISOString()
      insertTask.run(id, `perf-plan-${suffix}`, timestamp, timestamp, timestamp)
      insertItem.run(
        id,
        `perf-execution-${suffix}`,
        JSON.stringify({
          installationId: 'perf-task-feed-installation',
          status: 'failed',
          reason: 'performance-fixture',
        }),
        timestamp,
        timestamp,
        timestamp,
      )
    }
  }).immediate()
}

function measureTaskFeedScale(root: string, taskCount: number, traverseAll: boolean) {
  const db = openPhysicalDatabase(path.join(root, `task-feed-${taskCount}.sqlite`))
  try {
    seedTaskFeedFixture(db, taskCount)
    const repository = new AgentIntegrationRepository(db)
    const pageLimit = 50
    const rssBefore = process.memoryUsage().rss
    const startedAt = performance.now()
    let cursor: string | undefined
    let pageCount = 0
    let returnedCount = 0
    let totalCount = 0
    do {
      const page = repository.listApplyTaskFeedPage({
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
        nowMs: Date.parse(T0) + 60_000,
      })
      pageCount += 1
      returnedCount += page.entries.length
      totalCount = page.totalCount
      cursor = traverseAll ? page.nextCursor ?? undefined : undefined
    } while (cursor)
    return {
      taskCount,
      pageLimit,
      traverseAll,
      pageCount,
      returnedCount,
      totalCount,
      elapsedMs: rounded(performance.now() - startedAt),
      rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
      physicalSqlite: true,
      writesRealAgentConfiguration: false,
    }
  } finally {
    db.close()
  }
}

function queryService(db: Database.Database, home: string): AgentIntegrationService {
  return new AgentIntegrationService({
    repository: new AgentIntegrationRepository(db),
    scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
    execution: {
      preview: async () => { throw new Error('performance fixture forbids coordinator writes') },
      applyPrepared: async () => { throw new Error('performance fixture forbids coordinator writes') },
    },
    now: () => new Date(T0),
    homeDir: home,
  })
}

async function measureQueryScale(
  root: string,
  home: string,
  installationCount: number,
  eventCount: number,
) {
  const dbPath = path.join(root, `queries-${installationCount}-${eventCount}.sqlite`)
  const db = openPhysicalDatabase(dbPath)
  try {
    seedQueryFixture(db, root, installationCount, eventCount)
    const service = queryService(db, home)
    const middleId = `perf-installation-${String(Math.floor(installationCount / 2)).padStart(6, '0')}`
    const snapshot = await measure(() => {
      const value = service.snapshot()
      if (value.installations.length !== installationCount) throw new Error('snapshot fixture cardinality changed')
    }, QUERY_WARMUP_RUNS, QUERY_MEASURED_RUNS)
    const detail = await measure(() => {
      const value = service.detail(middleId, true)
      if (value.installation.id !== middleId || value.technical?.components.length !== 3) {
        throw new Error('detail fixture cardinality changed')
      }
    }, QUERY_WARMUP_RUNS, QUERY_MEASURED_RUNS)
    const events = await measure(() => {
      const value = service.listEvents(middleId, undefined, 100)
      if (value.length !== eventCount / installationCount) throw new Error('event fixture cardinality changed')
    }, QUERY_WARMUP_RUNS, QUERY_MEASURED_RUNS)
    return { installationCount, eventCount, snapshot, detail, events }
  } finally {
    db.close()
  }
}

function absentDiscoveryDependencies(): DiscoveryDependencies {
  return {
    fs: {
      lstat: async () => undefined,
      realpath: async targetPath => targetPath,
      readTextFile: async () => '',
    },
    which: async () => undefined,
    execVersion: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  }
}

async function measureP0Timeout(home: string) {
  const never = new Promise<never>(() => {})
  const dependencies: DiscoveryDependencies = {
    fs: {
      lstat: async () => never,
      realpath: async () => never,
      readTextFile: async () => never,
    },
    which: async () => never,
    execVersion: async () => never,
  }
  let timedOutCatalogIds: string[] = []
  const wall = await measure(async () => {
    const report = await discoverLocalP0Agents({
      homeDir: home,
      osUserIdentity: 'perf-user-0001',
      applicationRoots: [path.join(home, 'Applications')],
      operationTimeoutMs: PROBE_OPERATION_TIMEOUT_MS,
    }, dependencies)
    timedOutCatalogIds = [...new Set(report.diagnostics
      .filter(diagnostic => diagnostic.endsWith(':timeout'))
      .map(diagnostic => diagnostic.split(':', 1)[0]))].sort()
    const expectedProbeIds = [...new Set(P0_DISCOVERY_PROBES.map(probe => probe.catalogId))].sort()
    if (timedOutCatalogIds.length !== expectedProbeIds.length
      || timedOutCatalogIds.some((catalogId, index) => catalogId !== expectedProbeIds[index])) {
      throw new Error(`timeout fixture exercised ${timedOutCatalogIds.length} of ${expectedProbeIds.length} P0 probes`)
    }
  }, PROBE_WARMUP_RUNS, PROBE_MEASURED_RUNS)
  return {
    timedOutCatalogCount: timedOutCatalogIds.length,
    timedOutCatalogIds,
    wall,
  }
}

const INTEGRATION_TABLES = [
  'agent_aliases',
  'agent_consents',
  'agent_host_activity_evidence',
  'agent_installations',
  'agent_integration_apply_task_feed_state',
  'agent_integration_apply_task_items',
  'agent_integration_apply_tasks',
  'agent_integration_events',
  'artifact_consumers',
  'installation_components',
  'managed_artifacts',
  'metadata',
  'projection_mutations',
  'reconcile_runs',
  'verification_results',
  'writer_fences',
] as const

function tableRowCounts(db: Database.Database): Array<{ table: string; rows: number }> {
  return INTEGRATION_TABLES.map(table => ({
    table,
    rows: (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  }))
}

class TimerTracker {
  private readonly originalSetTimeout = globalThis.setTimeout
  private readonly originalClearTimeout = globalThis.clearTimeout
  private readonly outstanding = new Set<ReturnType<typeof setTimeout>>()
  maximum = 0

  start(): void {
    const outstanding = this.outstanding
    const originalSetTimeout = this.originalSetTimeout
    const originalClearTimeout = this.originalClearTimeout
    const recordMaximum = (size: number) => { this.maximum = Math.max(this.maximum, size) }
    globalThis.setTimeout = function trackedSetTimeout(
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) {
      const handle = originalSetTimeout((...callbackArgs: unknown[]) => {
        outstanding.delete(handle)
        callback(...callbackArgs)
      }, delay, ...args)
      outstanding.add(handle)
      recordMaximum(outstanding.size)
      return handle
    } as typeof setTimeout
    globalThis.clearTimeout = function trackedClearTimeout(handle?: ReturnType<typeof setTimeout>) {
      if (handle !== undefined) outstanding.delete(handle)
      return originalClearTimeout(handle)
    } as typeof clearTimeout
  }

  stop(): void {
    globalThis.setTimeout = this.originalSetTimeout
    globalThis.clearTimeout = this.originalClearTimeout
  }

  get size(): number {
    return this.outstanding.size
  }
}

async function measureStability(root: string, home: string) {
  const db = openPhysicalDatabase(path.join(root, 'stability.sqlite'))
  const repository = new AgentIntegrationRepository(db)
  const service = queryService(db, home)
  const installationId = 'stability-installation'
  const configRoot = path.join(root, 'stability-agent-root')
  repository.upsertDiscoveredInstallation({
    id: installationId,
    family: 'qwen-code',
    hostVariant: 'qwen-code-cli',
    installKey: 'stability-install-key',
    provenance: 'performance-fixture',
    osUserIdentity: 'perf-user-0001',
    displayName: 'Qwen Code Stability Fixture',
    configRoot,
    agentId: 'eb_perf_stability',
    supportedCapability: 4,
    lastDetectedAt: T0,
  })
  repository.createManagedArtifact({
    id: 'stability-artifact',
    componentType: 'skill',
    targetPath: path.join(configRoot, 'skills', 'tidemind'),
    ownershipKey: 'tidemind',
    mutationDomain: `file:${path.join(configRoot, 'skills', 'tidemind')}`,
    projectionVersion: '1',
    selectorSchemaVersion: '1',
    state: 'healthy',
  }, T0)
  repository.upsertComponent({
    installationId,
    componentKey: 'instruction',
    desiredState: 'managed',
    desiredCapability: 1,
    deliveryMode: 'managed',
    verificationStatus: 'verified',
    artifactId: 'stability-artifact',
    visibilityState: 'dedicated',
  }, T0)
  db.prepare(`UPDATE agent_installations SET desired_state = 'managed', desired_capability = 1 WHERE id = ?`)
    .run(installationId)

  const identity = canonicalizeInstallationIdentity({
    runtimeRealm: 'local_macos',
    osUserIdentity: 'perf-user-0001',
    productFamilyId: 'qwen-code',
    hostVariant: 'qwen-code-cli',
    configRoot,
  })
  const reconciler = new ManagedAgentReconciler({
    coordinator: {
      preview: async () => { throw new Error('healthy stability fixture must not preview') },
      applyPrepared: async () => { throw new Error('healthy stability fixture must not apply') },
    },
    repository: {
      recordEvent: event => { repository.recordEvent(event) },
      beginMissingEpisode: input => repository.beginMissingEpisode(input),
      markArtifactHealthyAfterReadback: (artifactId, verifiedAt) => (
        repository.markArtifactHealthyAfterReadback(artifactId, verifiedAt)
      ),
    },
    notifications: { deliver: async () => {} },
    clock: { now: () => new Date(T0) },
    ids: { next: prefix => `${prefix}-unused` },
  })
  const reconcileRequest = {
    artifactId: 'stability-artifact',
    installation: {
      id: installationId,
      displayName: 'Qwen Code Stability Fixture',
      desiredState: 'managed' as const,
      identity,
      agentId: 'eb_perf_stability',
    },
    installationDesiredState: 'managed' as const,
    componentKey: 'instruction' as const,
    componentName: 'Instruction',
    desiredCapability: 1 as const,
    consentId: null,
    observation: {
      kind: 'healthy' as const,
      selectorEmpty: false,
      ownershipBaselineVerified: true,
      containerResolvable: true,
      observedFingerprint: 'healthy-fixture',
      diagnostics: [] as string[],
    },
  }

  // Prime all one-time state changes before the frozen no-growth boundary.
  await service.scan()
  await service.scan()
  await reconciler.reconcileArtifact(reconcileRequest)
  const rowCountsBefore = tableRowCounts(db)
  const tracker = new TimerTracker()
  tracker.start()
  try {
    for (let round = 0; round < SCAN_ROUNDS; round += 1) {
      const report = await discoverLocalP0Agents({
        homeDir: home,
        osUserIdentity: 'perf-user-0001',
        applicationRoots: [path.join(home, 'Applications')],
        operationTimeoutMs: PROBE_OPERATION_TIMEOUT_MS,
      }, absentDiscoveryDependencies())
      if (report.installations.length !== 0) throw new Error('absent discovery fixture produced an Installation')
      await service.scan()
      if (tracker.size !== 0) throw new Error(`timer leak after stability scan ${round + 1}`)
    }
    for (let round = 0; round < RECONCILE_ROUNDS; round += 1) {
      const outcome = await reconciler.reconcileArtifact(reconcileRequest)
      if (outcome.status !== 'healthy') throw new Error('healthy reconcile fixture changed outcome')
      if (tracker.size !== 0) throw new Error(`timer leak after stability reconcile ${round + 1}`)
    }
  } finally {
    tracker.stop()
  }
  const rowCountsAfter = tableRowCounts(db)
  const databaseRowGrowth = rowCountsAfter.reduce((total, current, index) => (
    total + Math.max(0, current.rows - rowCountsBefore[index].rows)
  ), 0)
  const result = {
    scanRounds: SCAN_ROUNDS,
    reconcileRounds: RECONCILE_ROUNDS,
    finalOutstandingTimers: tracker.size,
    maxOutstandingTimers: tracker.maximum,
    databaseRowGrowth,
    rowCountsBefore,
    rowCountsAfter,
    physicalSqlite: true,
    writesRealAgentConfiguration: false,
  }
  db.close()
  return result
}

async function main(): Promise<void> {
  const { root, home, resultPath } = requireIsolatedRoot()
  const result = {
    protocolVersion: PROTOCOL_VERSION,
    measuredAt: new Date().toISOString(),
    fixture: {
      dataRoot: 'ephemeral-physical-sqlite-only',
      writesRealAgentConfiguration: false,
      probeCount: P0_DISCOVERY_PROBES.length,
      probeOperationTimeoutMs: PROBE_OPERATION_TIMEOUT_MS,
      probeWarmupRuns: PROBE_WARMUP_RUNS,
      probeMeasuredRuns: PROBE_MEASURED_RUNS,
      queryWarmupRuns: QUERY_WARMUP_RUNS,
      queryMeasuredRuns: QUERY_MEASURED_RUNS,
      scanRounds: SCAN_ROUNDS,
      reconcileRounds: RECONCILE_ROUNDS,
    },
    machine: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      nodeVersion: process.version,
    },
    discoveryTimeout: await measureP0Timeout(home),
    queries: {
      '100-installations-10000-events': await measureQueryScale(root, home, 100, 10_000),
      '1000-installations-100000-events': await measureQueryScale(root, home, 1_000, 100_000),
    },
    taskFeed: {
      '10000-attention-full-traversal': measureTaskFeedScale(root, 10_000, true),
      '100000-attention-first-page': measureTaskFeedScale(root, 100_000, false),
    },
    stability: await measureStability(root, home),
  }
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
}

const isolated = requireIsolatedRoot()
main().catch(error => {
  const failure = {
    protocolVersion: PROTOCOL_VERSION,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  }
  fs.writeFileSync(isolated.resultPath, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' })
  process.exitCode = 1
})
