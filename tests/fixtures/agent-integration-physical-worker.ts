import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentIntegrationCoordinator, type CoordinatorInstallation } from '../../client/electron/agent-integration/coordinator'
import { SqliteCoordinatorRepository } from '../../client/electron/agent-integration/coordinator-repository'
import { sha256Bytes } from '../../client/electron/agent-integration/fingerprint'
import { createManagedTextHostAdapter } from '../../client/electron/agent-integration/hosts/managed-text-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import {
  AgentIntegrationRepository,
  persistedProjectionSurfaceFingerprint,
} from '../../client/electron/agent-integration/repository'
import type {
  AdapterRuntimeContext,
  AgentHostAdapter,
  ComponentVerificationResult,
} from '../../client/electron/agent-integration/types'
import { ensureSchema } from '../../src/db/schema'

const [mode, rootInput, dbInput, crashPoint] = process.argv.slice(2)
const root = path.resolve(rootInput ?? '')
const dbPath = path.resolve(dbInput ?? '')
const home = path.join(root, 'home')
const applicationData = path.join(root, 'application-data')
const lockDirectory = path.join(home, '.tidemind', 'writer-locks')
const sharedSkillRoot = path.join(home, '.agents', 'skills')
const target = path.join(sharedSkillRoot, 'tidemind', 'SKILL.md')
const applyCountPath = path.join(root, 'physical-apply-count.log')
const CONTENT = '---\nname: tidemind\ndescription: isolated physical fixture\n---\n'
const NOW = '2026-08-26T00:00:00.000Z'

if (!mode || !rootInput || !dbInput) throw new Error('mode, root and db path are required')
if (path.relative(root, dbPath).startsWith('..') || process.env.HOME !== home) {
  throw new Error('physical fixture refused a path outside its isolated HOME')
}

fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(applicationData, { recursive: true })
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = FULL')
ensureSchema(db)

const repository = new AgentIntegrationRepository(db)
const runtime: AdapterRuntimeContext = {
  runtimeRealm: 'local_macos',
  homeDir: home,
  applicationDataDir: applicationData,
  shimPath: path.join(root, 'bin', 'tidemind'),
  mcpServerPath: path.join(root, 'bin', 'mcp-server'),
  hookScriptPath: path.join(root, 'bin', 'hook-session-start'),
  preCompactScriptPath: path.join(root, 'bin', 'hook-pre-compact'),
  postCompactScriptPath: path.join(root, 'bin', 'hook-post-compact'),
  tideMindVersion: 'fixture-1',
  catalogVersion: '1',
  projectionVersion: '1',
}

function identityFor(id: string) {
  const configRoot = path.join(home, `.qwen-${id}`)
  fs.mkdirSync(configRoot, { recursive: true })
  return canonicalizeInstallationIdentity({
    runtimeRealm: 'local_macos',
    osUserIdentity: 'usr_fixture_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    productFamilyId: 'qwen-code',
    hostVariant: 'qwen-code-cli',
    configRoot,
    explicitProfile: id,
    distribution: { distributionId: `fixture-${id}` },
  })
}

function installationFor(id: string): CoordinatorInstallation {
  const identity = identityFor(id)
  const persisted = repository.getInstallation(id)
  return {
    id,
    displayName: `Qwen ${id}`,
    desiredState: persisted?.desired_state ?? 'unmanaged',
    identity,
    agentId: `eb-${id}`,
  }
}

function ensureInstallation(id: string): CoordinatorInstallation {
  const installation = installationFor(id)
  if (!repository.getInstallation(id)) {
    repository.upsertDiscoveredInstallation({
      id,
      family: installation.identity.productFamilyId,
      hostVariant: installation.identity.hostVariant,
      runtimeRealm: installation.identity.runtimeRealm,
      profileId: installation.identity.explicitProfile,
      installKey: installation.identity.installKey,
      distributionId: installation.identity.distribution.distributionId,
      provenance: 'isolated-physical-fixture',
      osUserIdentity: installation.identity.osUserIdentity,
      displayName: installation.displayName,
      configRoot: installation.identity.canonicalConfigRoot,
      agentId: installation.agentId,
      supportedCapability: 1,
      lastDetectedAt: NOW,
    })
  }
  return installationFor(id)
}

function signal(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function hangAfterSignal(value: Record<string, unknown>): Promise<never> {
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  })
}

function incrementApplyCount(): void {
  fs.appendFileSync(applyCountPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 })
  const fd = fs.openSync(applyCountPath, fs.constants.O_RDONLY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function physicalAdapter(blockAfterApply = false): AgentHostAdapter {
  const delegate = createManagedTextHostAdapter({
    catalogId: 'qwen-code-cli',
    adapterVersion: '1',
    componentKey: 'instruction',
    artifactType: 'skill',
    targetFile: () => target,
    allowedRoot: () => sharedSkillRoot,
    content: () => CONTENT,
    reload: 'new_session',
    detect: () => true,
  })
  return {
    ...delegate,
    async apply(context, mutation) {
      const receipt = await delegate.apply(context, mutation)
      incrementApplyCount()
      if (blockAfterApply) {
        const row = db.prepare(`
          SELECT mutation.state, mutation.apply_receipt_json, run.state AS run_state
          FROM projection_mutations mutation
          JOIN reconcile_runs run ON run.id = mutation.run_id
          ORDER BY mutation.created_at DESC LIMIT 1
        `).get() as { state: string; apply_receipt_json: string | null; run_state: string }
        const taskItem = db.prepare(`
          SELECT run_id FROM agent_integration_apply_task_items
          WHERE task_id = 'physical-crash-task' AND installation_id = 'installation-crash'
        `).get() as { run_id: string | null }
        await hangAfterSignal({
          type: 'killpoint',
          point: 'effect_applied_before_receipt',
          runState: row.run_state,
          mutationState: row.state,
          receipt: row.apply_receipt_json,
          fileExists: fs.existsSync(target),
          taskRunId: taskItem.run_id,
        })
      }
      return receipt
    },
    async verify(context, request): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes('instruction')) return []
      const exists = fs.existsSync(target)
      const matches = exists && sha256Bytes(fs.readFileSync(target)) === sha256Bytes(CONTENT)
      const verified = request.expectedCapability === 0 ? !exists : matches
      return [{
        componentKey: 'instruction',
        status: verified ? 'verified' : 'failed',
        verifiedCapability: verified ? request.expectedCapability : null,
        identityAssertion: verified ? context.agentId : undefined,
        evidenceHash: exists ? sha256Bytes(fs.readFileSync(target)) : undefined,
        invalidationKeys: ['artifact_hash', 'adapter_version'],
        diagnostics: verified ? ['isolated_physical_readback_verified'] : ['physical_readback_failed'],
      }]
    },
  }
}

function coordinator(adapter: AgentHostAdapter, bridgeOverride?: SqliteCoordinatorRepository) {
  const bridge = bridgeOverride ?? new SqliteCoordinatorRepository(db, repository, {
    ownerInstanceId: `worker-${process.pid}-${randomUUID()}`,
    leaseDurationMs: 100,
    lockDirectory,
    lockDirectoryTrustRoot: home,
  })
  let sequence = 0
  return {
    bridge,
    coordinator: new AgentIntegrationCoordinator({
      runtime,
      adapters: { get: catalogId => catalogId === adapter.catalogId ? adapter : undefined },
      repository: bridge,
      notifications: { deliver: () => {} },
      clock: { now: () => new Date() },
      ids: { next: prefix => `${prefix}-${process.pid}-${++sequence}-${randomUUID()}` },
      catalogGeneration: 1,
      adapterGeneration: () => 1,
      projectionGeneration: () => 1,
      installationSurfaceFingerprint: installation => {
        const row = repository.getInstallation(installation.id)
        return row ? persistedProjectionSurfaceFingerprint(row) : null
      },
    }),
  }
}

function ensureConsent(installationId: string, consentId: string): void {
  if (repository.getConsent(consentId)) return
  repository.createConsent({
    id: consentId,
    installationId,
    policyVersion: '1',
    allowedComponents: ['instruction'],
    allowedScopes: [`directory:${sharedSkillRoot}`],
    normalizedTargets: [target],
    selectorSchemaVersion: '1',
    selectorResolution: { 'qwen-code-cli:instruction:document': 'document' },
    executableRealpaths: [],
    commandCategories: ['file_write'],
    maximumRisk: 'low',
    confirmedAt: NOW,
  })
}

async function connect(id: string): Promise<Record<string, unknown>> {
  const installation = ensureInstallation(id)
  const adapter = physicalAdapter(false)
  const active = coordinator(adapter)
  const plan = await active.coordinator.preview({
    installation,
    operation: 'connect',
    componentKeys: ['instruction'],
    desiredCapability: 1,
  })
  const consentId = `consent-${id}`
  ensureConsent(id, consentId)
  return active.coordinator.applyPrepared({
    installation,
    preparedPlan: plan,
    consentId,
    desiredCapability: 1,
  })
}

function activeConsumerKeys(): string[] {
  return (db.prepare(`
    SELECT installation_id, component_key FROM artifact_consumers
    WHERE state = 'active' AND desired_state IN ('managed','disabled') AND tombstoned_at IS NULL
    ORDER BY installation_id, component_key
  `).all() as Array<{ installation_id: string; component_key: string }>)
    .map(row => `${row.installation_id}\0${row.component_key}`)
}

async function disconnect(id: string): Promise<Record<string, unknown>> {
  const installation = installationFor(id)
  const adapter = physicalAdapter(false)
  const active = coordinator(adapter)
  const plan = await active.coordinator.preview({
    installation,
    operation: 'disconnect',
    componentKeys: ['instruction'],
    desiredCapability: 0,
  })
  const approvedMutation = plan.executionPlan.mutations.find(mutation => mutation.componentKey === 'instruction')
  const approvedObservation = plan.inspection.components.find(component => component.componentKey === 'instruction')
  return active.coordinator.applyPrepared({
    installation,
    preparedPlan: plan,
    consentId: `consent-${id}`,
    desiredCapability: 0,
    disconnectScopeExpectations: [{
      componentKey: 'instruction',
      physicalTarget: approvedMutation?.targetPath ?? approvedObservation?.observedTarget ?? target,
      ownershipKey: approvedMutation?.ownershipSelector ?? 'document',
      consumerKeys: activeConsumerKeys(),
    }],
  })
}

function snapshot() {
  return {
    fileExists: fs.existsSync(target),
    fileContent: fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null,
    applyCount: fs.existsSync(applyCountPath)
      ? fs.readFileSync(applyCountPath, 'utf8').trim().split('\n').filter(Boolean).length
      : 0,
    runs: db.prepare(`SELECT state, COUNT(*) AS count FROM reconcile_runs GROUP BY state ORDER BY state`).all(),
    mutations: db.prepare(`
      SELECT state, apply_receipt_json IS NOT NULL AS has_receipt, COUNT(*) AS count
      FROM projection_mutations GROUP BY state, has_receipt ORDER BY state
    `).all(),
    artifacts: db.prepare(`
      SELECT component_type, state, COUNT(*) AS count FROM managed_artifacts
      GROUP BY component_type, state ORDER BY component_type, state
    `).all(),
    consumers: db.prepare(`
      SELECT installation_id, state, desired_state FROM artifact_consumers ORDER BY installation_id
    `).all(),
    missingEvents: db.prepare(`
      SELECT COUNT(*) AS count FROM agent_integration_events WHERE kind = 'artifact_missing'
    `).get(),
  }
}

async function crash(): Promise<void> {
  const installation = ensureInstallation('installation-crash')
  const adapter = physicalAdapter(crashPoint === 'effect')
  const bridge = new SqliteCoordinatorRepository(db, repository, {
    ownerInstanceId: `crash-${process.pid}`,
    leaseDurationMs: 100,
    lockDirectory,
    lockDirectoryTrustRoot: home,
  })
  const active = coordinator(adapter, bridge)
  const plan = await active.coordinator.preview({
    installation,
    operation: 'connect',
    componentKeys: ['instruction'],
    desiredCapability: 1,
  })
  ensureConsent(installation.id, 'consent-crash')
  repository.createApplyTask({
    id: 'physical-crash-task',
    planHash: 'physical-crash-batch',
    startedAt: NOW,
    items: [{ installationId: installation.id, executionPlanHash: plan.executionPlanHash }],
  })
  repository.markApplyTaskItemRunning('physical-crash-task', installation.id, NOW)
  const applyTaskBinding = {
    taskId: 'physical-crash-task',
    installationId: installation.id,
    executionPlanHash: plan.executionPlanHash,
  }
  if (crashPoint === 'intent') {
    const originalPrepare = bridge.prepareExecution.bind(bridge)
    const blockingRepository = new Proxy(bridge, {
      get(targetObject, property) {
        if (property === 'prepareExecution') {
          return async (...args: Parameters<typeof originalPrepare>) => {
            originalPrepare(...args)
            const row = db.prepare(`
              SELECT r.state AS run_state, m.state AS mutation_state
              FROM reconcile_runs r JOIN projection_mutations m ON m.run_id = r.id
              ORDER BY r.created_at DESC LIMIT 1
            `).get() as { run_state: string; mutation_state: string }
            const taskItem = db.prepare(`
              SELECT run_id FROM agent_integration_apply_task_items
              WHERE task_id = 'physical-crash-task' AND installation_id = ?
            `).get(installation.id) as { run_id: string | null }
            return hangAfterSignal({
              type: 'killpoint',
              point: 'intent_persisted',
              runState: row.run_state,
              mutationState: row.mutation_state,
              fileExists: fs.existsSync(target),
              taskRunId: taskItem.run_id,
            })
          }
        }
        const value = Reflect.get(targetObject, property)
        return typeof value === 'function' ? value.bind(targetObject) : value
      },
    })
    let sequence = 0
    const blocked = new AgentIntegrationCoordinator({
      runtime,
      adapters: { get: catalogId => catalogId === adapter.catalogId ? adapter : undefined },
      repository: blockingRepository,
      notifications: { deliver: () => {} },
      clock: { now: () => new Date() },
      ids: { next: prefix => `${prefix}-${process.pid}-${++sequence}-${randomUUID()}` },
      catalogGeneration: 1,
      adapterGeneration: () => 1,
      projectionGeneration: () => 1,
      installationSurfaceFingerprint: currentInstallation => {
        const row = repository.getInstallation(currentInstallation.id)
        return row ? persistedProjectionSurfaceFingerprint(row) : null
      },
    })
    const outcome = await blocked.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: 'consent-crash',
      desiredCapability: 1,
      applyTaskBinding,
    })
    throw new Error(`intent crash point was not reached: ${JSON.stringify(outcome)}`)
  }
  const outcome = await active.coordinator.applyPrepared({
    installation,
    preparedPlan: plan,
    consentId: 'consent-crash',
    desiredCapability: 1,
    applyTaskBinding,
  })
  throw new Error(`effect crash point was not reached: ${JSON.stringify(outcome)}`)
}

async function recover(): Promise<void> {
  const active = coordinator(physicalAdapter(false))
  const outcomes = await active.coordinator.recoverNonTerminalRuns({ canReplayEffect: () => true })
  signal({ type: 'result', outcomes, snapshot: snapshot() })
}

async function sharedCycle(): Promise<void> {
  const first = await connect('installation-one')
  const afterFirst = snapshot()
  const second = await connect('installation-two')
  const afterSecond = snapshot()
  let unsafeDetachError: { name: string; message: string } | null = null
  let unsafeDetachResult: Record<string, unknown> | null = null
  try {
    unsafeDetachResult = await disconnect('installation-one')
  } catch (error) {
    unsafeDetachError = error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'NonErrorThrow', message: typeof error === 'string' ? error : 'non_error_throw' }
  }
  const afterUnsafeDetach = snapshot()
  // This models the explicit manual-cleanup action in an isolated fixture.
  // Production code never performs this pathname unlink.
  fs.unlinkSync(target)
  const detach = await disconnect('installation-one')
  const afterDetach = snapshot()
  const last = await disconnect('installation-two')
  const afterLast = snapshot()
  signal({
    type: 'result',
    first,
    second,
    unsafeDetachError,
    unsafeDetachResult,
    detach,
    last,
    afterFirst,
    afterSecond,
    afterUnsafeDetach,
    afterDetach,
    afterLast,
  })
}

async function holdFence(): Promise<void> {
  const bridge = new SqliteCoordinatorRepository(db, repository, {
    ownerInstanceId: `fence-holder-${process.pid}`,
    leaseDurationMs: 100,
    lockDirectory,
    lockDirectoryTrustRoot: home,
  })
  const lease = bridge.acquireWriterFence('physical-fence-sigstop')
  if (!lease) throw new Error('fence holder could not acquire its initial lease')
  signal({ type: 'killpoint', point: 'fence_held', pid: process.pid })
  const command = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', value => resolve(String(value).trim()))
  })
  process.stdin.pause()
  if (command === 'assert') {
    try {
      lease.assertOwned()
      signal({ type: 'result', asserted: true })
    } catch (error) {
      signal({ type: 'result', asserted: false, error: error instanceof Error ? error.message : String(error) })
    }
    lease.release()
    return
  }
  lease.release()
  signal({ type: 'result', released: true })
}

async function tryFence(): Promise<void> {
  const bridge = new SqliteCoordinatorRepository(db, repository, {
    ownerInstanceId: `fence-contender-${process.pid}`,
    leaseDurationMs: 100,
    lockDirectory,
    lockDirectoryTrustRoot: home,
  })
  const lease = bridge.acquireWriterFence('physical-fence-sigstop')
  const acquired = lease !== null
  lease?.release()
  signal({ type: 'result', acquired })
}

function firstRecoverableJournal(bridge: SqliteCoordinatorRepository) {
  const execution = bridge.listRecoverableExecutions()[0]
  if (!execution || execution.runState === 'verified' || execution.mutations.length === 0) {
    throw new Error('journal race fixture has no mutable recoverable mutation')
  }
  return { runId: execution.runId, journal: execution.mutations[0].journal }
}

async function advanceJournal(): Promise<void> {
  const bridge = new SqliteCoordinatorRepository(db, repository, {
    ownerInstanceId: `journal-advance-${process.pid}`, lockDirectory, lockDirectoryTrustRoot: home,
  })
  const { runId, journal } = firstRecoverableJournal(bridge)
  const observed = bridge.saveMutation(runId, {
    ...journal,
    state: 'effect_observed',
    attemptCount: 1,
    postEffectFingerprint: 'desired',
    compensationPrecondition: 'desired',
    updatedAt: new Date().toISOString(),
  })
  const advanced = bridge.saveMutation(runId, {
    ...observed,
    state: 'receipt_persisted',
    receiptJson: '{"physical":true}',
    updatedAt: new Date().toISOString(),
  })
  signal({ type: 'result', journalVersion: advanced.journalVersion })
}

async function persistStaleJournal(): Promise<void> {
  const bridge = new SqliteCoordinatorRepository(db, repository, {
    ownerInstanceId: `journal-stale-${process.pid}`, lockDirectory, lockDirectoryTrustRoot: home,
  })
  const { runId, journal } = firstRecoverableJournal(bridge)
  signal({ type: 'killpoint', point: 'journal_loaded', journalVersion: journal.journalVersion })
  await new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', () => resolve())
  })
  process.stdin.pause()
  let conflict: string | null = null
  try {
    bridge.saveMutation(runId, {
      ...journal,
      state: 'needs_recovery',
      failureCode: 'writer_fence_lost',
      failureStage: 'recovery_read_back',
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    conflict = error instanceof Error ? error.message : String(error)
  }
  const persisted = db.prepare(`
    SELECT state, journal_version, attempt_count, post_effect_fingerprint,
           compensation_precondition, apply_receipt_json, failure_code
    FROM projection_mutations ORDER BY created_at DESC LIMIT 1
  `).get()
  signal({ type: 'result', conflict, persisted })
}

try {
  if (mode === 'crash') await crash()
  else if (mode === 'recover') await recover()
  else if (mode === 'shared-cycle') await sharedCycle()
  else if (mode === 'fence-hold') await holdFence()
  else if (mode === 'fence-try') await tryFence()
  else if (mode === 'journal-advance') await advanceJournal()
  else if (mode === 'journal-stale') await persistStaleJournal()
  else throw new Error(`unknown worker mode: ${mode}`)
  db.close()
} catch (error) {
  signal({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) })
  db.close()
  process.exitCode = 1
}
