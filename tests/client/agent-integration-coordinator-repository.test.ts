import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SqliteCoordinatorRepository } from '../../client/electron/agent-integration/coordinator-repository'
import type { MutationJournalRecord } from '../../client/electron/agent-integration/mutation-runner'
import { buildExecutionPlan } from '../../client/electron/agent-integration/planner'
import { executionPlanHash } from '../../client/electron/agent-integration/consent'
import {
  AgentIntegrationRepository,
  persistedProjectionSurfaceFingerprint,
} from '../../client/electron/agent-integration/repository'
import type { PlannedMutation } from '../../client/electron/agent-integration/types'
import { ensureAgentIntegrationSchema } from '../../src/db/agent-integration-schema.js'
import { ensureSchema } from '../../src/db/schema.js'

const T0 = '2026-08-25T00:00:00.000Z'
const TARGET = '/tmp/tidemind-bridge/config.json'
const DOMAIN = `local_macos:file:${TARGET}:document`
const bridgeRepositories = new WeakMap<SqliteCoordinatorRepository, AgentIntegrationRepository>()

function setup(lockDirectory?: string, lockDirectoryTrustRoot?: string) {
  const db = new Database(':memory:')
  ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  let idSequence = 0
  const bridge = new SqliteCoordinatorRepository(db, repository, {
    ownerInstanceId: 'bridge-test',
    now: () => new Date(T0),
    id: prefix => `${prefix}-${++idSequence}`,
    lockDirectory,
    lockDirectoryTrustRoot,
  })
  bridgeRepositories.set(bridge, repository)
  return { db, repository, bridge }
}

function commitRun(db: Database.Database, bridge: SqliteCoordinatorRepository, runId: string): void {
  db.prepare(`UPDATE projection_mutations SET state = 'committed' WHERE run_id = ?`).run(runId)
  markApplied(bridge, runId)
  recordRunVerification(db, bridge, runId)
  bridge.setRunState(runId, 'verified', T0)
  bridge.setRunState(runId, 'committed', T0)
}

function commitMutation(
  bridge: SqliteCoordinatorRepository,
  runId: string,
  journal: MutationJournalRecord,
): MutationJournalRecord {
  const observed = bridge.saveMutation(runId, {
    ...journal,
    state: 'effect_observed',
    postEffectFingerprint: journal.desiredFingerprint,
    compensationPrecondition: journal.desiredFingerprint,
    updatedAt: T0,
  })
  const receipt = bridge.saveMutation(runId, {
    ...observed,
    state: 'receipt_persisted',
    receiptJson: '{}',
    updatedAt: T0,
  })
  const verified = bridge.saveMutation(runId, { ...receipt, state: 'verified', updatedAt: T0 })
  return bridge.saveMutation(runId, { ...verified, state: 'committed', updatedAt: T0 })
}

function markApplied(bridge: SqliteCoordinatorRepository, runId: string): void {
  bridge.setRunState(runId, 'preconditions_checked', T0)
  bridge.setRunState(runId, 'applying', T0)
  bridge.setRunState(runId, 'applied_unverified', T0)
}

function recordRunVerification(
  db: Database.Database,
  bridge: SqliteCoordinatorRepository,
  runId: string,
): void {
  const run = db.prepare(`
    SELECT installation_id, prepared_plan_json, desired_capability
    FROM reconcile_runs WHERE id = ?
  `).get(runId) as { installation_id: string; prepared_plan_json: string; desired_capability: number }
  const installation = db.prepare(`SELECT * FROM agent_installations WHERE id = ?`)
    .get(run.installation_id) as Record<string, unknown>
  const plan = JSON.parse(run.prepared_plan_json) as { componentKeys: Array<'instruction' | 'memory_tools' | 'lifecycle'> }
  const detached = new Set((db.prepare(`
    SELECT component_key FROM projection_mutations
    WHERE run_id = ? AND idempotency_strategy = 'consumer_detach_only'
  `).all(runId) as Array<{ component_key: string }>).map(row => row.component_key))
  for (const componentKey of plan.componentKeys) {
    if (detached.has(componentKey)) continue
    bridge.recordVerification({
      runId,
      installation: {
        id: String(installation.id),
        displayName: String(installation.display_name),
        desiredState: String(installation.desired_state) as 'managed' | 'removed',
        agentId: String(installation.agent_id),
        identity: {
          runtimeRealm: 'local_macos',
          osUserIdentity: String(installation.os_user_identity),
          productFamilyId: 'cursor',
          hostVariant: 'cursor-desktop',
          canonicalConfigRoot: String(installation.config_root),
          explicitProfile: String(installation.profile_id ?? ''),
          distribution: { distributionId: 'cursor' },
          installKey: String(installation.install_key),
        },
      },
      result: {
        componentKey,
        status: 'verified',
        verifiedCapability: run.desired_capability as 0 | 1 | 2 | 3 | 4,
        identityAssertion: String(installation.agent_id),
        invalidationKeys: [],
        diagnostics: [],
      },
      adapterVersion: '7',
      catalogVersion: '3',
      projectionVersion: '9',
      expectedHostVersion: installation.detected_version === null
        ? null
        : String(installation.detected_version),
      verifiedAt: T0,
    })
  }
}

function discover(repository: AgentIntegrationRepository, id: string): void {
  repository.upsertDiscoveredInstallation({
    id,
    family: 'cursor',
    hostVariant: 'cursor-desktop',
    installKey: `cursor:${id}`,
    distributionId: 'cursor',
    provenance: 'fixture',
    osUserIdentity: 'usr_fixture_1234',
    displayName: `Cursor ${id}`,
    configRoot: `/tmp/${id}`,
    agentId: `agent-${id}`,
    supportedCapability: 3,
    lastDetectedAt: T0,
  })
  repository.createConsent({
    id: `consent-${id}`,
    installationId: id,
    policyVersion: '1',
    allowedComponents: ['instruction', 'memory_tools'],
    allowedScopes: [TARGET],
    normalizedTargets: [TARGET],
    selectorSchemaVersion: '1',
    selectorResolution: {
      'cursor-desktop:instruction:document': 'document',
      'cursor-desktop:memory_tools:mcpServers.tidemind': 'mcpServers.tidemind',
    },
    executableRealpaths: [],
    commandCategories: ['file_write'],
    maximumRisk: 'low',
    confirmedAt: T0,
  })
}

function mutation(operation: 'create' | 'remove' = 'create'): PlannedMutation {
  return {
    operationId: `${operation}-mcp`,
    componentKey: 'memory_tools',
    operation,
    domainKind: 'file_fragment',
    physicalTarget: TARGET,
    ownershipKey: 'mcpServers.tidemind',
    selectorSchemaVersion: 1,
    risk: 'low',
    reload: 'new_session',
    ...(operation === 'remove'
      ? { preconditionHash: 'desired' }
      : { desiredFragmentHash: 'desired' }),
    idempotent: true,
  }
}

function prepared(installationId: string, planned: PlannedMutation, operation: 'connect' | 'disconnect' = 'connect') {
  return buildExecutionPlan({
    installationId,
    installationKey: `cursor:${installationId}`,
    operation,
    componentKeys: [planned.componentKey],
    inspection: {
      catalogId: 'cursor-desktop',
      detected: true,
      distribution: { distributionId: 'cursor' },
      components: [],
      provenance: ['fixture'],
      diagnostics: [],
    },
    adapterPlan: {
      catalogId: 'cursor-desktop',
      installationKey: `cursor:${installationId}`,
      adapterVersion: '7',
      projectionVersion: '9',
      mutations: [planned],
      requiredUserActions: [],
      diagnostics: [],
    },
    catalogGeneration: 3,
    adapterGeneration: 7,
    projectionGeneration: 9,
    createdAt: T0,
  })
}

function bindSurface(
  plan: ReturnType<typeof prepared>,
  repository: AgentIntegrationRepository,
  installationId: string,
): typeof plan {
  const installation = repository.getInstallation(installationId)
  if (!installation) throw new Error(`missing fixture Installation: ${installationId}`)
  plan.executionPlan = {
    ...plan.executionPlan,
    installationSurfaceFingerprint: persistedProjectionSurfaceFingerprint(installation),
  }
  plan.executionPlanHash = executionPlanHash(plan.executionPlan)
  return plan
}

function prepare(
  bridge: SqliteCoordinatorRepository,
  installationId: string,
  runId: string,
  planned = mutation(),
  operation: 'connect' | 'disconnect' = 'connect',
  options: {
    consentId?: string
    expectedDesiredState?: 'unmanaged' | 'managed' | 'disabled' | 'removed'
    reconnectFromRemoved?: boolean
    applyTaskId?: string
    disconnectScopeExpectations?: Array<{
      componentKey: 'memory_tools'
      physicalTarget: string
      ownershipKey: string
      consumerKeys: string[]
    }>
  } = {},
): ReturnType<SqliteCoordinatorRepository['prepareExecution']> {
  const plan = prepared(installationId, planned, operation)
  const repository = bridgeRepositories.get(bridge)
  if (!repository) throw new Error('missing fixture repository')
  bindSurface(plan, repository, installationId)
  if (options.applyTaskId) {
    repository.createApplyTask({
      id: options.applyTaskId,
      planHash: `batch-${runId}`,
      startedAt: T0,
      items: [{ installationId, executionPlanHash: plan.executionPlanHash }],
    })
    repository.markApplyTaskItemRunning(options.applyTaskId, installationId, T0)
  }
  return bridge.prepareExecution({
    runId,
    installationId,
    operation,
    planHash: plan.executionPlanHash,
    consentId: options.consentId ?? `consent-${installationId}`,
    preparedPlan: plan,
    desiredCapability: operation === 'disconnect' ? 0 : 3,
    mutations: [{
      operationId: planned.operationId,
      mutationDomain: DOMAIN,
      plannedMutation: planned,
      journal: {
        id: `mutation-${runId}`,
        state: 'prepared',
        journalVersion: 0,
        attemptCount: 0,
        idempotent: true,
        beforeFingerprint: planned.preconditionHash ?? null,
        desiredFingerprint: operation === 'disconnect' ? null : planned.desiredFragmentHash ?? null,
        postEffectFingerprint: null,
        compensationPrecondition: null,
        receiptJson: null,
        failureCode: null,
        failureStage: null,
        updatedAt: T0,
      },
    }],
    expectedDesiredState: options.expectedDesiredState ?? (operation === 'disconnect' ? 'managed' : 'unmanaged'),
    intentAfterPrepare: operation === 'disconnect' ? 'removed' : 'managed',
    reconnectFromRemoved: options.reconnectFromRemoved,
    disconnectScopeExpectations: options.disconnectScopeExpectations,
    applyTaskBinding: options.applyTaskId
      ? {
          taskId: options.applyTaskId,
          installationId,
          executionPlanHash: plan.executionPlanHash,
        }
      : undefined,
    createdAt: T0,
  })
}

describe('SqliteCoordinatorRepository', () => {
  it('commits the reconcile run and exact apply-task binding in one immediate transaction', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')

    prepare(bridge, 'i1', 'run-task-atomic', mutation(), 'connect', {
      applyTaskId: 'task-atomic',
    })

    expect(db.prepare(`
      SELECT item.run_id, run.installation_id, run.execution_plan_hash
      FROM agent_integration_apply_task_items item
      JOIN reconcile_runs run ON run.id = item.run_id
      WHERE item.task_id = 'task-atomic' AND item.installation_id = 'i1'
    `).get()).toEqual(expect.objectContaining({
      run_id: 'run-task-atomic',
      installation_id: 'i1',
    }))
  })

  it('rolls the reconcile run back when the frozen task binding cannot be claimed', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    const plan = prepared('i1', mutation(), 'connect')
    bindSurface(plan, repository, 'i1')

    expect(() => bridge.prepareExecution({
      runId: 'run-task-rollback',
      installationId: 'i1',
      operation: 'connect',
      planHash: plan.executionPlanHash,
      consentId: 'consent-i1',
      preparedPlan: plan,
      desiredCapability: 3,
      mutations: [],
      expectedDesiredState: 'unmanaged',
      intentAfterPrepare: 'managed',
      applyTaskBinding: {
        taskId: 'missing-task',
        installationId: 'i1',
        executionPlanHash: plan.executionPlanHash,
      },
      createdAt: T0,
    })).toThrow(/could not bind exact run/)
    expect(db.prepare(`SELECT id FROM reconcile_runs WHERE id = 'run-task-rollback'`).get()).toBeUndefined()
  })

  it('rejects a stale connect when the user pauses before the prepare transaction', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    repository.setInstallationIntent('i1', 'managed', T0)
    repository.setInstallationIntent('i1', 'disabled', T0, 'user_pause')

    expect(() => prepare(bridge, 'i1', 'run-stale-intent', mutation(), 'connect', {
      expectedDesiredState: 'managed',
    })).toThrow(/intent changed/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs WHERE id = 'run-stale-intent'`).get())
      .toEqual({ count: 0 })
  })

  it('does not let an older run overwrite reconcile state after current consent changes', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-old')
    repository.createConsent({
      id: 'consent-new', installationId: 'i1', policyVersion: '1',
      allowedComponents: ['memory_tools'], allowedScopes: [TARGET], normalizedTargets: [TARGET],
      selectorSchemaVersion: '1',
      selectorResolution: {
        'cursor-desktop:memory_tools:mcpServers.tidemind': 'mcpServers.tidemind',
      },
      executableRealpaths: [], commandCategories: ['file_write'], maximumRisk: 'low', confirmedAt: T0,
    })
    db.prepare(`
      UPDATE agent_installations
      SET consent_envelope_id = 'consent-new', reconcile_state = 'idle', status_reason = NULL
      WHERE id = 'i1'
    `).run()

    expect(bridge.setInstallationReconcileState(
      'i1', 'needs_recovery', 'old_run_failed', T0,
      { expectedDesiredState: 'managed', expectedConsentId: 'consent-i1' },
    )).toBe(false)
    expect(repository.getInstallation('i1')).toMatchObject({
      consent_envelope_id: 'consent-new', reconcile_state: 'idle', status_reason: null,
    })
  })

  it('distinguishes an exact null consent CAS from an omitted consent guard', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')

    expect(bridge.setInstallationReconcileState(
      'i1', 'awaiting_consent', 'consent_missing', T0,
      { expectedDesiredState: 'unmanaged', expectedConsentId: null },
    )).toBe(true)
    db.prepare(`UPDATE agent_installations SET consent_envelope_id = 'consent-i1' WHERE id = 'i1'`).run()

    expect(bridge.setInstallationReconcileState(
      'i1', 'awaiting_consent', 'stale_missing', T0,
      { expectedDesiredState: 'unmanaged', expectedConsentId: null },
    )).toBe(false)
    expect(bridge.setInstallationReconcileState(
      'i1', 'paused', 'diagnostic_only', T0,
      { expectedDesiredState: 'unmanaged' },
    )).toBe(true)
  })

  it('reopens a tombstone, revokes old consent and persists reconnect intent atomically in prepare', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    repository.setInstallationIntent('i1', 'removed', T0, 'user_disconnect')
    repository.createConsent({
      id: 'consent-reconnect', installationId: 'i1', policyVersion: '1',
      allowedComponents: ['memory_tools'], allowedScopes: [TARGET], normalizedTargets: [TARGET],
      selectorSchemaVersion: '1',
      selectorResolution: {
        'cursor-desktop:memory_tools:mcpServers.tidemind': 'mcpServers.tidemind',
      },
      executableRealpaths: [], commandCategories: ['file_write'], maximumRisk: 'low', confirmedAt: T0,
    })

    prepare(bridge, 'i1', 'run-reconnect', mutation(), 'connect', {
      consentId: 'consent-reconnect',
      expectedDesiredState: 'removed',
      reconnectFromRemoved: true,
    })

    expect(repository.getInstallation('i1')).toMatchObject({
      desired_state: 'managed', tombstoned_at: null, tombstone_reason: null,
      consent_envelope_id: 'consent-reconnect', reconcile_state: 'planning',
    })
    expect(db.prepare(`SELECT status FROM agent_consents WHERE id = 'consent-i1'`).get())
      .toEqual({ status: 'revoked' })
    expect(db.prepare(`SELECT status FROM agent_consents WHERE id = 'consent-reconnect'`).get())
      .toEqual({ status: 'active' })
  })

  it('atomically persists intent, serialized plan, mutation, consumer and long-lived scope cutover', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')

    prepare(bridge, 'i1', 'run-1')

    expect(db.prepare(`SELECT desired_state, reconcile_state FROM agent_installations WHERE id = 'i1'`).get())
      .toEqual({ desired_state: 'managed', reconcile_state: 'planning' })
    expect(db.prepare(`SELECT state, desired_capability FROM reconcile_runs WHERE id = 'run-1'`).get())
      .toEqual({ state: 'planned', desired_capability: 3 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations WHERE run_id = 'run-1'`).get())
      .toEqual({ count: 1 })
    expect(db.prepare(`SELECT scope_mode, state FROM writer_fences WHERE mutation_domain = ?`).get(DOMAIN))
      .toEqual({ scope_mode: 'managed', state: 'released' })
    markApplied(bridge, 'run-1')
    expect(bridge.listOwnedArtifactBaselines('i1')).toEqual([{
      componentKey: 'memory_tools',
      physicalTarget: TARGET,
      ownershipKey: 'mcpServers.tidemind',
      ownedFragmentHash: 'desired',
      selectorSchemaVersion: 1,
    }])
  })

  it('reconstructs exact persisted plans and desired capability after a process restart', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-1')

    const restarted = new SqliteCoordinatorRepository(db, repository, { ownerInstanceId: 'restart' })
    const [run] = restarted.listRecoverableExecutions()

    expect(run.runId).toBe('run-1')
    expect(run.desiredCapability).toBe(3)
    expect(run.preparedPlan.adapterPlan.adapterVersion).toBe('7')
    expect(run.preparedPlan.adapterPlan.projectionVersion).toBe('9')
    expect(run.mutations[0].plannedMutation).toEqual(mutation())
    expect(run.mutations[0].journal.desiredFingerprint).toBe('desired')
  })

  it('requires applied-unverified then verified before a run can commit', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-state-cas')

    expect(() => bridge.setRunState('run-state-cas', 'verified', T0))
      .toThrow(/invalid reconcile run transition/)
    db.prepare(`UPDATE projection_mutations SET state = 'committed' WHERE run_id = 'run-state-cas'`).run()
    markApplied(bridge, 'run-state-cas')
    expect(() => bridge.setRunState('run-state-cas', 'committed', T0))
      .toThrow(/invalid reconcile run transition/)
    recordRunVerification(db, bridge, 'run-state-cas')
    bridge.setRunState('run-state-cas', 'verified', T0)
    expect(() => bridge.setRunState('run-state-cas', 'applied_unverified', T0))
      .toThrow(/invalid reconcile run transition/)
    expect(() => bridge.setRunState('run-state-cas', 'committed', T0)).not.toThrow()

    discover(repository, 'i2')
    prepare(bridge, 'i2', 'run-cancelled-cas')
    bridge.setRunState('run-cancelled-cas', 'cancelled', T0)
    expect(() => bridge.setRunState('run-cancelled-cas', 'applying', T0))
      .toThrow(/invalid reconcile run transition/)
  })

  it('recovers a crash after verified as a finalizer-only run', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-verified')
    db.prepare(`UPDATE projection_mutations SET state = 'committed' WHERE run_id = 'run-verified'`).run()
    markApplied(bridge, 'run-verified')
    bridge.setRunState('run-verified', 'verified', T0)
    db.prepare(`
      UPDATE reconcile_runs SET prepared_plan_json = 'not-json' WHERE id = 'run-verified'
    `).run()
    db.prepare(`UPDATE agent_installations SET agent_id = NULL WHERE id = 'i1'`).run()

    expect(bridge.listRecoverableExecutions()).toHaveLength(1)
    expect(bridge.listRecoverableExecutions()[0]).toMatchObject({
      runId: 'run-verified',
      runState: 'verified',
      installationId: 'i1',
    })
  })

  it('blocks only the exact verified finalizer token and Installation in one transaction', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-verified-trust')
    db.prepare(`UPDATE projection_mutations SET state = 'committed' WHERE run_id = 'run-verified-trust'`).run()
    markApplied(bridge, 'run-verified-trust')
    recordRunVerification(db, bridge, 'run-verified-trust')
    bridge.setRunState('run-verified-trust', 'verified', T0)

    expect(() => bridge.blockVerifiedFinalization({
      runId: 'run-verified-trust',
      installationId: 'i2',
      reason: 'recovery_source_trust_changed',
      blockedAt: T0,
    })).toThrow(/verified recovery token changed/)
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-verified-trust'`).get())
      .toEqual({ state: 'verified' })
    expect(repository.getInstallation('i2')).toMatchObject({ reconcile_state: 'idle' })

    bridge.blockVerifiedFinalization({
      runId: 'run-verified-trust',
      installationId: 'i1',
      reason: 'recovery_source_trust_changed',
      blockedAt: T0,
    })
    expect(db.prepare(`
      SELECT state, failure_code, failure_stage FROM reconcile_runs WHERE id = 'run-verified-trust'
    `).get()).toEqual({
      state: 'cancelled',
      failure_code: 'recovery_source_trust_changed',
      failure_stage: 'startup_recovery',
    })
    expect(repository.getInstallation('i1')).toMatchObject({
      reconcile_state: 'needs_recovery',
      status_reason: 'recovery_source_trust_changed',
    })
  })

  it('rejects a second ordinary run for the same physical domain while recovery is non-terminal', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')

    expect(() => prepare(bridge, 'i2', 'run-2')).toThrow(/non-terminal run/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs WHERE id = 'run-2'`).get())
      .toEqual({ count: 0 })
  })

  it('rechecks authoritative host presence inside the prepare transaction', () => {
    const { repository, bridge } = setup()
    discover(repository, 'i1')
    repository.markInstallationIdentityConflict('i1', T0, 'fixture distribution conflict')

    expect(() => prepare(bridge, 'i1', 'run-conflict')).toThrow(/not authoritatively present/)
  })

  it('atomically rejects an effect claim after the Installation was paused', () => {
    const { repository, bridge } = setup()
    discover(repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-claim')
    bridge.setRunState('run-claim', 'preconditions_checked', T0)
    bridge.setRunState('run-claim', 'applying', T0)
    bridge.saveMutation('run-claim', {
      ...execution.mutations[0].journal,
      state: 'effect_started',
      attemptCount: 1,
      updatedAt: T0,
    })
    repository.setInstallationIntent('i1', 'disabled', '2026-08-25T00:01:00.000Z')

    expect(bridge.claimMutationEffect({
      runId: 'run-claim',
      mutationId: execution.mutations[0].journal.id,
      installation: {
        id: 'i1', displayName: 'Cursor i1', desiredState: 'managed', agentId: 'agent-i1',
        identity: {
          runtimeRealm: 'local_macos', osUserIdentity: 'usr_fixture_1234', productFamilyId: 'cursor',
          hostVariant: 'cursor-desktop', canonicalConfigRoot: '/tmp/i1', explicitProfile: '',
          distribution: { distributionId: 'cursor' }, installKey: 'cursor:i1',
        },
      },
      consentId: 'consent-i1',
      expectedDesiredState: 'managed',
      claimedAt: '2026-08-25T00:01:01.000Z',
    })).toBe(false)
  })

  it.each([
    ['pause', ({ repository }: ReturnType<typeof setup>) => {
      repository.setInstallationIntent('i1', 'disabled', '2026-08-25T00:01:00.000Z')
    }],
    ['consent revoke', ({ db }: ReturnType<typeof setup>) => {
      db.prepare(`UPDATE agent_consents SET status = 'revoked', revoked_at = ? WHERE id = 'consent-i1'`)
        .run('2026-08-25T00:01:00.000Z')
    }],
    ['identity conflict', ({ repository }: ReturnType<typeof setup>) => {
      repository.markInstallationIdentityConflict('i1', '2026-08-25T00:01:00.000Z', 'fixture conflict')
    }],
  ])('rechecks physical SQLite authority after claim when an async barrier permits %s', (_label, mutate) => {
    const fixture = setup()
    const { bridge } = fixture
    discover(fixture.repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-second-gate')
    bridge.setRunState('run-second-gate', 'preconditions_checked', T0)
    bridge.setRunState('run-second-gate', 'applying', T0)
    bridge.saveMutation('run-second-gate', {
      ...execution.mutations[0].journal,
      state: 'effect_started',
      attemptCount: 1,
      updatedAt: T0,
    })
    const authority = {
      runId: 'run-second-gate',
      mutationId: execution.mutations[0].journal.id,
      installation: {
        id: 'i1', displayName: 'Cursor i1', desiredState: 'managed' as const, agentId: 'agent-i1',
        identity: {
          runtimeRealm: 'local_macos' as const, osUserIdentity: 'usr_fixture_1234',
          productFamilyId: 'cursor' as const, hostVariant: 'cursor-desktop' as const,
          canonicalConfigRoot: '/tmp/i1', explicitProfile: '',
          distribution: { distributionId: 'cursor' }, installKey: 'cursor:i1',
        },
      },
      consentId: 'consent-i1',
      expectedDesiredState: 'managed' as const,
    }
    expect(bridge.claimMutationEffect({ ...authority, claimedAt: T0 })).toBe(true)

    mutate(fixture)

    expect(bridge.revalidateClaimedMutationEffect(authority)).toBe(false)
  })

  it('rejects stale verification evidence and preserves a later identity conflict at finalization', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-verify-race')
    markApplied(bridge, 'run-verify-race')
    repository.markInstallationIdentityConflict('i1', '2026-08-25T00:01:00.000Z', 'fixture conflict')
    const current = repository.getInstallation('i1')!
    const coordinatorInstallation = {
      id: 'i1', displayName: 'Cursor i1', desiredState: 'managed' as const, agentId: 'agent-i1',
      identity: {
        runtimeRealm: 'local_macos' as const, osUserIdentity: 'usr_fixture_1234',
        productFamilyId: 'cursor' as const, hostVariant: 'cursor-desktop' as const,
        canonicalConfigRoot: '/tmp/i1', explicitProfile: '',
        distribution: { distributionId: 'cursor' }, installKey: 'cursor:i1',
      },
    }

    expect(() => bridge.recordVerification({
      runId: 'run-verify-race',
      installation: coordinatorInstallation,
      result: {
        componentKey: 'memory_tools', status: 'verified', verifiedCapability: 3,
        identityAssertion: current.agent_id!, invalidationKeys: [], diagnostics: [],
      },
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9',
      verifiedAt: '2026-08-25T00:02:00.000Z',
    })).toThrow(/verification authorization changed/)

    commitMutation(bridge, 'run-verify-race', execution.mutations[0].journal)
    bridge.setRunState('run-verify-race', 'verified', '2026-08-25T00:02:00.000Z')
    expect(() => bridge.setRunState(
      'run-verify-race', 'committed', '2026-08-25T00:02:00.000Z',
    )).toThrow(/verification evidence is not current/)
    expect(db.prepare(`SELECT status_reason, health_state FROM agent_installations WHERE id = 'i1'`).get())
      .toEqual({ status_reason: 'conflict', health_state: 'inaccessible' })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results WHERE installation_id = 'i1'`).get())
      .toEqual({ count: 0 })
  })

  it('keeps host verification recoverable while allowing a disconnect after projection apply', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-connect')
    markApplied(bridge, 'run-connect')

    expect(bridge.listRecoverableExecutions()).toHaveLength(1)
    expect(() => prepare(bridge, 'i1', 'run-disconnect', mutation('remove'), 'disconnect')).not.toThrow()
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-disconnect'`).get())
      .toEqual({ state: 'planned' })
  })

  it('blocks a same-direction run while an applied projection is still awaiting verification', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-connect')
    markApplied(bridge, 'run-connect')

    expect(() => prepare(bridge, 'i1', 'run-repair', mutation(), 'connect', {
      expectedDesiredState: 'managed',
    })).toThrow(/non-terminal run/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs WHERE id = 'run-repair'`).get())
      .toEqual({ count: 0 })
  })

  it('rejects verification evidence for a component outside the persisted plan', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-scope')
    markApplied(bridge, 'run-scope')
    const installationRow = repository.getInstallation('i1')!
    const coordinatorInstallation = {
      id: 'i1', displayName: 'Cursor i1', desiredState: 'managed' as const, agentId: 'agent-i1',
      identity: {
        runtimeRealm: 'local_macos' as const, osUserIdentity: 'usr_fixture_1234',
        productFamilyId: 'cursor' as const, hostVariant: 'cursor-desktop' as const,
        canonicalConfigRoot: '/tmp/i1', explicitProfile: '', distribution: { distributionId: 'cursor' },
        installKey: 'cursor:i1',
      },
    }

    expect(() => bridge.recordVerification({
      runId: 'run-scope',
      installation: coordinatorInstallation,
      result: {
        componentKey: 'instruction', status: 'verified', verifiedCapability: 1,
        identityAssertion: installationRow.agent_id!, invalidationKeys: [], diagnostics: [],
      },
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9', verifiedAt: T0,
    })).toThrow(/outside persisted plan scope/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 0 })
  })

  it('rolls back the complete verification batch when any result is outside the frozen plan', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-batch-scope')
    markApplied(bridge, 'run-batch-scope')
    const coordinatorInstallation = {
      id: 'i1', displayName: 'Cursor i1', desiredState: 'managed' as const, agentId: 'agent-i1',
      identity: {
        runtimeRealm: 'local_macos' as const, osUserIdentity: 'usr_fixture_1234',
        productFamilyId: 'cursor' as const, hostVariant: 'cursor-desktop' as const,
        canonicalConfigRoot: '/tmp/i1', explicitProfile: '', distribution: { distributionId: 'cursor' },
        installKey: 'cursor:i1',
      },
    }
    const common = {
      runId: 'run-batch-scope',
      installation: coordinatorInstallation,
      adapterVersion: '7',
      catalogVersion: '3',
      tideMindVersion: 'test',
      projectionVersion: '9',
      expectedHostVersion: null,
      verifiedAt: T0,
    }

    expect(() => bridge.recordVerificationBatch([
      {
        ...common,
        result: {
          componentKey: 'memory_tools' as const, status: 'verified' as const, verifiedCapability: 3 as const,
          identityAssertion: 'agent-i1', invalidationKeys: [], diagnostics: [],
        },
      },
      {
        ...common,
        result: {
          componentKey: 'instruction' as const, status: 'verified' as const, verifiedCapability: 1 as const,
          identityAssertion: 'agent-i1', invalidationKeys: [], diagnostics: [],
        },
      },
    ])).toThrow(/outside persisted plan scope/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 0 })
  })

  it('rejects mismatched identities while making exact crash-retry evidence idempotent', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-evidence')
    markApplied(bridge, 'run-evidence')
    const coordinatorInstallation = {
      id: 'i1', displayName: 'Cursor i1', desiredState: 'managed' as const, agentId: 'agent-i1',
      identity: {
        runtimeRealm: 'local_macos' as const, osUserIdentity: 'usr_fixture_1234',
        productFamilyId: 'cursor' as const, hostVariant: 'cursor-desktop' as const,
        canonicalConfigRoot: '/tmp/i1', explicitProfile: '', distribution: { distributionId: 'cursor' },
        installKey: 'cursor:i1',
      },
    }
    const verified = {
      componentKey: 'memory_tools' as const,
      status: 'verified' as const,
      verifiedCapability: 2 as const,
      identityAssertion: 'agent-i1',
      evidenceRef: 'host-activity:aha_fixture',
      evidenceHash: 'activity-evidence-hash',
      expiresAt: '2026-09-24T00:00:00.000Z',
      invalidationKeys: [],
      diagnostics: [],
    }

    expect(() => bridge.recordVerification({
      runId: 'run-evidence', installation: coordinatorInstallation,
      result: { ...verified, identityAssertion: 'agent-other' },
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9', verifiedAt: T0,
    })).toThrow(/identity assertion/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 0 })

    bridge.recordVerification({
      runId: 'run-evidence', installation: coordinatorInstallation, result: verified,
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9', verifiedAt: T0,
    })
    expect(() => bridge.recordVerification({
      runId: 'run-evidence', installation: coordinatorInstallation, result: verified,
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9', verifiedAt: T0,
    })).not.toThrow()
    expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT evidence_ref, evidence_hash, expires_at FROM verification_results
    `).get()).toEqual({
      evidence_ref: 'host-activity:aha_fixture',
      evidence_hash: 'activity-evidence-hash',
      expires_at: '2026-09-24T00:00:00.000Z',
    })
    expect(() => bridge.recordVerification({
      runId: 'run-evidence', installation: coordinatorInstallation,
      result: { ...verified, evidenceHash: 'changed-on-retry' },
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9', verifiedAt: T0,
    })).toThrow(/evidence changed during retry/)

    repository.invalidateVerificationResults('i1', 'memory_tools', '2026-08-25T00:01:00.000Z', 'freshness_changed')
    expect(() => bridge.recordVerification({
      runId: 'run-evidence', installation: coordinatorInstallation, result: verified,
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9',
      verifiedAt: '2026-08-25T00:02:00.000Z',
    })).not.toThrow()
    expect(db.prepare(`
      SELECT run_id, invalidation_reason FROM verification_results ORDER BY verified_at
    `).all()).toEqual([
      { run_id: null, invalidation_reason: 'freshness_changed' },
      { run_id: 'run-evidence', invalidation_reason: null },
    ])
  })

  it('supersedes failed evidence when the same recovery run later verifies', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-retry')
    markApplied(bridge, 'run-retry')
    const installation = {
      id: 'i1', displayName: 'Cursor i1', desiredState: 'managed' as const, agentId: 'agent-i1',
      identity: {
        runtimeRealm: 'local_macos' as const, osUserIdentity: 'usr_fixture_1234',
        productFamilyId: 'cursor' as const, hostVariant: 'cursor-desktop' as const,
        canonicalConfigRoot: '/tmp/i1', explicitProfile: '', distribution: { distributionId: 'cursor' },
        installKey: 'cursor:i1',
      },
    }
    bridge.recordVerification({
      runId: 'run-retry', installation,
      result: {
        componentKey: 'memory_tools', status: 'failed', verifiedCapability: 0,
        identityAssertion: null, invalidationKeys: [], diagnostics: ['host-not-ready'],
      },
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9', verifiedAt: T0,
    })
    bridge.setRunState('run-retry', 'needs_recovery', '2026-08-25T00:01:00.000Z', {
      code: 'verification_failed', stage: 'verification',
    })
    db.prepare(`UPDATE reconcile_runs SET state = 'applied_unverified' WHERE id = 'run-retry'`).run()
    bridge.recordVerification({
      runId: 'run-retry', installation,
      result: {
        componentKey: 'memory_tools', status: 'verified', verifiedCapability: 2,
        identityAssertion: 'agent-i1', invalidationKeys: [], diagnostics: [],
      },
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9',
      verifiedAt: '2026-08-25T00:02:00.000Z',
    })

    expect(db.prepare(`
      SELECT run_id, result, invalidation_reason FROM verification_results ORDER BY verified_at
    `).all()).toEqual([
      { run_id: null, result: 'failed', invalidation_reason: 'verification_retry_superseded' },
      { run_id: 'run-retry', result: 'verified', invalidation_reason: null },
    ])
  })

  it('keeps mutation terminal states monotonic under a stale duplicate recovery', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-terminal')
    const stale = execution.mutations[0].journal
    db.prepare(`UPDATE projection_mutations SET state = 'committed' WHERE id = ?`).run(stale.id)

    expect(() => bridge.saveMutation('run-terminal', {
      ...stale, state: 'effect_observed', updatedAt: '2026-08-25T00:01:00.000Z',
    })).not.toThrow()
    expect(db.prepare(`SELECT state FROM projection_mutations WHERE id = ?`).get(stale.id))
      .toEqual({ state: 'committed' })
  })

  it('rejects a stale non-terminal recovery without clearing durable effect evidence', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-journal-cas')
    const stale = execution.mutations[0].journal
    const observed = bridge.saveMutation('run-journal-cas', {
      ...stale,
      state: 'effect_observed',
      attemptCount: 1,
      postEffectFingerprint: 'desired',
      compensationPrecondition: 'desired',
      updatedAt: '2026-08-25T00:00:30.000Z',
    })
    const advanced = bridge.saveMutation('run-journal-cas', {
      ...observed,
      state: 'receipt_persisted',
      receiptJson: '{"applied":true}',
      updatedAt: '2026-08-25T00:01:00.000Z',
    })

    expect(advanced.journalVersion).toBe(2)
    expect(() => bridge.saveMutation('run-journal-cas', {
      ...stale,
      state: 'needs_recovery',
      failureCode: 'writer_fence_lost',
      failureStage: 'recovery_read_back',
      updatedAt: '2026-08-25T00:02:00.000Z',
    })).toThrow(/stale mutation journal version/)
    expect(db.prepare(`
      SELECT state, journal_version, attempt_count, post_effect_fingerprint,
             compensation_precondition, apply_receipt_json, failure_code
      FROM projection_mutations WHERE id = ?
    `).get(stale.id)).toEqual({
      state: 'receipt_persisted',
      journal_version: 2,
      attempt_count: 1,
      post_effect_fingerprint: 'desired',
      compensation_precondition: 'desired',
      apply_receipt_json: '{"applied":true}',
      failure_code: null,
    })
  })

  it('rejects a current-version mutation journal transition to an earlier durable phase', () => {
    const { repository, bridge } = setup()
    discover(repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-journal-predecessor')
    const prepared = execution.mutations[0].journal
    const observed = bridge.saveMutation('run-journal-predecessor', {
      ...prepared,
      state: 'effect_observed',
      postEffectFingerprint: 'desired',
      compensationPrecondition: 'desired',
      updatedAt: '2026-08-25T00:01:00.000Z',
    })
    const receipt = bridge.saveMutation('run-journal-predecessor', {
      ...observed,
      state: 'receipt_persisted',
      receiptJson: '{"applied":true}',
      updatedAt: '2026-08-25T00:02:00.000Z',
    })

    expect(() => bridge.saveMutation('run-journal-predecessor', {
      ...receipt,
      state: 'effect_started',
      updatedAt: '2026-08-25T00:03:00.000Z',
    })).toThrow(/invalid mutation journal transition.*receipt_persisted -> effect_started/)
  })

  it('cancels a verified finalizer when its current evidence became stale', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-stale-finalizer')
    db.prepare(`UPDATE projection_mutations SET state = 'committed' WHERE run_id = 'run-stale-finalizer'`).run()
    markApplied(bridge, 'run-stale-finalizer')
    recordRunVerification(db, bridge, 'run-stale-finalizer')
    bridge.setRunState('run-stale-finalizer', 'verified', T0)
    repository.invalidateVerificationResults(
      'i1', 'memory_tools', '2026-08-25T00:01:00.000Z', 'adapter_version_changed',
    )

    expect(() => bridge.setRunState(
      'run-stale-finalizer', 'committed', '2026-08-25T00:02:00.000Z',
    )).toThrow(/verification evidence is not current/)
    expect(db.prepare(`
      SELECT state, failure_code, failure_stage FROM reconcile_runs WHERE id = 'run-stale-finalizer'
    `).get()).toEqual({
      state: 'cancelled',
      failure_code: 'verification_evidence_stale',
      failure_stage: 'finalization',
    })
  })

  it('suppresses repair candidates while the host is missing and restores them only after rediscovery', () => {
    const { repository, bridge } = setup()
    discover(repository, 'i1')
    prepare(bridge, 'i1', 'run-connect')
    markApplied(bridge, 'run-connect')
    expect(bridge.listManagedReconcileCandidates()).toHaveLength(1)

    repository.markInstallationNotDetected('i1', '2026-08-25T00:01:00.000Z')
    expect(bridge.listManagedReconcileCandidates()).toEqual([])
    repository.markInstallationNotDetected('i1', '2026-08-25T00:02:00.000Z')
    expect(bridge.listManagedReconcileCandidates()).toEqual([])

    repository.upsertDiscoveredInstallation({
      id: 'ignored-on-upsert',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:i1',
      distributionId: 'cursor',
      provenance: 'fixture-rediscovered',
      osUserIdentity: 'usr_fixture_1234',
      displayName: 'Cursor i1',
      configRoot: '/tmp/i1',
      supportedCapability: 3,
      lastDetectedAt: '2026-08-25T00:03:00.000Z',
    })
    expect(bridge.listManagedReconcileCandidates()).toHaveLength(1)
  })

  it('atomically adopts a healthy shared portable Skill only with exact owned read-back evidence', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    const create = mutation()
    create.componentKey = 'instruction'
    create.physicalTarget = TARGET
    create.ownershipKey = 'document'
    prepare(bridge, 'i1', 'run-1', create)
    commitRun(db, bridge, 'run-1')

    const adoptionPlan = buildExecutionPlan({
      installationId: 'i2',
      installationKey: 'cursor:i2',
      operation: 'connect',
      componentKeys: ['instruction'],
      inspection: {
        catalogId: 'cursor-desktop', detected: true, distribution: { distributionId: 'cursor' },
        components: [{
          componentKey: 'instruction', visibility: 'shared_visible', verificationStatus: 'unverified',
          observedTarget: TARGET, observedFragmentHash: 'desired',
        }],
        provenance: ['fixture'], diagnostics: [],
      },
      adapterPlan: {
        catalogId: 'cursor-desktop', installationKey: 'cursor:i2', adapterVersion: '7', projectionVersion: '9',
        mutations: [], requiredUserActions: [], diagnostics: ['matching_document_has_no_ownership_evidence'],
      },
      catalogGeneration: 3, adapterGeneration: 7, projectionGeneration: 9, createdAt: T0,
    })
    const adopted = bridge.prepareExecution({
      runId: 'run-adopt', installationId: 'i2', operation: 'connect',
      planHash: adoptionPlan.executionPlanHash, consentId: 'consent-i2', preparedPlan: adoptionPlan,
      desiredCapability: 1, mutations: [], intentAfterPrepare: 'managed', createdAt: T0,
      expectedDesiredState: 'unmanaged',
    })

    expect(adopted.mutations).toEqual([])
    expect(db.prepare(`SELECT COUNT(*) AS count FROM artifact_consumers WHERE state = 'active'`).get())
      .toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(DISTINCT artifact_id) AS count FROM artifact_consumers`).get())
      .toEqual({ count: 1 })
    expect(() => prepare(bridge, 'i1', 'run-after-adopt', mutation(), 'connect', {
      expectedDesiredState: 'managed',
    })).toThrow(/non-terminal run/)
  })

  it('activates a migrated exact MCP baseline without requiring a duplicate mutation', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    repository.createManagedArtifact({
      id: 'legacy-mcp',
      componentType: 'mcp',
      targetPath: TARGET,
      ownershipKey: 'mcpServers.tidemind',
      mutationDomain: DOMAIN,
      projectionVersion: '9',
      selectorSchemaVersion: '1',
      ownedFragmentHash: 'desired',
      desiredFragmentHash: 'desired',
      observedFragmentHash: 'desired',
      state: 'needs_recovery',
    }, T0)
    repository.upsertComponent({
      installationId: 'i1', componentKey: 'memory_tools', desiredState: 'unmanaged',
      desiredCapability: 0, deliveryMode: 'managed', verificationStatus: 'unverified',
      artifactId: 'legacy-mcp', visibilityState: 'dedicated',
    }, T0)
    repository.addArtifactConsumer({
      artifactId: 'legacy-mcp', installationId: 'i1', componentKey: 'memory_tools',
      requiredCapability: 0, discoverReachability: 'dedicated',
      ownershipFingerprint: 'desired', allowNeedsRecoveryPending: true, addedAt: T0,
    })
    db.prepare(`UPDATE artifact_consumers SET desired_state = 'disabled' WHERE artifact_id = 'legacy-mcp'`).run()

    const plan = buildExecutionPlan({
      installationId: 'i1', installationKey: 'cursor:i1', operation: 'connect',
      componentKeys: ['memory_tools'],
      inspection: {
        catalogId: 'cursor-desktop', detected: true, distribution: { distributionId: 'cursor' },
        components: [{
          componentKey: 'memory_tools', visibility: 'dedicated', verificationStatus: 'unverified',
          observedTarget: TARGET, observedFragmentHash: 'desired',
        }],
        provenance: ['fixture'], diagnostics: [],
      },
      adapterPlan: {
        catalogId: 'cursor-desktop', installationKey: 'cursor:i1', adapterVersion: '7', projectionVersion: '9',
        mutations: [], requiredUserActions: [], diagnostics: [],
      },
      catalogGeneration: 3, adapterGeneration: 7, projectionGeneration: 9, createdAt: T0,
    })
    bindSurface(plan, repository, 'i1')
    expect(() => bridge.prepareExecution({
      runId: 'run-migrated-mcp', installationId: 'i1', operation: 'connect',
      planHash: plan.executionPlanHash, consentId: 'consent-i1', preparedPlan: plan,
      desiredCapability: 2, mutations: [], intentAfterPrepare: 'managed', createdAt: T0,
      expectedDesiredState: 'unmanaged',
    })).not.toThrow()
    expect(db.prepare(`
      SELECT desired_state, required_capability, consent_envelope_id
      FROM artifact_consumers WHERE artifact_id = 'legacy-mcp'
    `).get()).toEqual({
      desired_state: 'disabled', required_capability: 2, consent_envelope_id: 'consent-i1',
    })
    expect(db.prepare(`SELECT scope_mode FROM writer_fences WHERE mutation_domain = ?`).get(DOMAIN))
      .toEqual({ scope_mode: 'managed' })
    commitRun(db, bridge, 'run-migrated-mcp')
    expect(db.prepare(`
      SELECT desired_state FROM artifact_consumers WHERE artifact_id = 'legacy-mcp'
    `).get()).toEqual({ desired_state: 'managed' })
    expect(db.prepare(`SELECT state FROM managed_artifacts WHERE id = 'legacy-mcp'`).get())
      .toEqual({ state: 'healthy' })
  })

  it('rebinds a moved Installation component before verification and disconnect planning', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    repository.createManagedArtifact({
      id: 'old-surface', componentType: 'mcp', targetPath: '/tmp/old-root/config.json',
      ownershipKey: 'mcpServers.tidemind',
      mutationDomain: 'local_macos:file:/tmp/old-root/config.json:mcpServers.tidemind',
      projectionVersion: '9', selectorSchemaVersion: '1', ownedFragmentHash: 'old-desired',
      desiredFragmentHash: 'old-desired', observedFragmentHash: 'old-desired',
    }, T0)
    repository.upsertComponent({
      installationId: 'i1', componentKey: 'memory_tools', desiredState: 'unmanaged',
      desiredCapability: 0, deliveryMode: 'managed', verificationStatus: 'stale',
      artifactId: 'old-surface', visibilityState: 'dedicated',
    }, T0)
    repository.addArtifactConsumer({
      artifactId: 'old-surface', installationId: 'i1', componentKey: 'memory_tools',
      requiredCapability: 0, discoverReachability: 'dedicated', consentEnvelopeId: 'consent-i1',
      ownershipFingerprint: 'old-desired', addedAt: T0,
    })

    const connect = prepare(bridge, 'i1', 'run-new-surface')
    const newArtifactId = db.prepare(`
      SELECT artifact_id AS id FROM installation_components
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get() as { id: string }
    expect(newArtifactId.id).not.toBe('old-surface')
    expect(db.prepare(`
      SELECT state, tombstone_reason FROM artifact_consumers
      WHERE artifact_id = 'old-surface' AND installation_id = 'i1'
    `).get()).toEqual({ state: 'removed', tombstone_reason: 'host_installation_surface_changed' })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM artifact_consumers
      WHERE installation_id = 'i1' AND component_key = 'memory_tools' AND state = 'active'
    `).get()).toEqual({ count: 1 })

    markApplied(bridge, 'run-new-surface')
    bridge.recordVerification({
      runId: 'run-new-surface',
      installation: {
        id: 'i1', displayName: 'Cursor i1', desiredState: 'managed', agentId: 'agent-i1',
        identity: {
          runtimeRealm: 'local_macos', osUserIdentity: 'usr_fixture_1234', productFamilyId: 'cursor',
          hostVariant: 'cursor-desktop', canonicalConfigRoot: '/tmp/i1', explicitProfile: '',
          distribution: { distributionId: 'cursor' }, installKey: 'cursor:i1',
        },
      },
      result: {
        componentKey: 'memory_tools', status: 'verified', verifiedCapability: 2,
        identityAssertion: 'agent-i1', evidenceHash: 'desired', invalidationKeys: [], diagnostics: [],
      },
      adapterVersion: '7', catalogVersion: '3', projectionVersion: '9', verifiedAt: T0,
    })
    commitMutation(bridge, 'run-new-surface', connect.mutations[0].journal)
    bridge.setRunState('run-new-surface', 'verified', T0)
    bridge.setRunState('run-new-surface', 'committed', T0)
    expect(db.prepare(`
      SELECT artifact_id AS id, verification_status FROM installation_components
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ id: newArtifactId.id, verification_status: 'verified' })

    const disconnect = prepare(bridge, 'i1', 'run-new-surface-disconnect', mutation('remove'), 'disconnect', {
      expectedDesiredState: 'managed',
    })
    expect(disconnect.mutations[0].plannedMutation.physicalTarget).toBe(TARGET)
    expect(db.prepare(`
      SELECT artifact_id AS id, target FROM projection_mutations
      WHERE run_id = 'run-new-surface-disconnect'
    `).get()).toEqual({ id: newArtifactId.id, target: TARGET })
  })

  it('rebinds an exact no-op projection after a stable Installation moves config root', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    repository.createManagedArtifact({
      id: 'old-noop-surface', componentType: 'mcp', targetPath: '/tmp/old-root/config.json',
      ownershipKey: 'mcpServers.tidemind',
      mutationDomain: 'local_macos:file:/tmp/old-root/config.json:document',
      projectionVersion: '9', selectorSchemaVersion: '1', ownedFragmentHash: 'desired',
      desiredFragmentHash: 'desired', observedFragmentHash: 'desired',
    }, T0)
    repository.upsertComponent({
      installationId: 'i1', componentKey: 'memory_tools', desiredState: 'unmanaged',
      desiredCapability: 0, deliveryMode: 'managed', verificationStatus: 'stale',
      artifactId: 'old-noop-surface', visibilityState: 'dedicated',
    }, T0)
    repository.addArtifactConsumer({
      artifactId: 'old-noop-surface', installationId: 'i1', componentKey: 'memory_tools',
      requiredCapability: 0, discoverReachability: 'dedicated', consentEnvelopeId: 'consent-i1',
      ownershipFingerprint: 'desired', addedAt: T0,
    })
    const noopPlan = buildExecutionPlan({
      installationId: 'i1', installationKey: 'cursor:i1', operation: 'connect',
      componentKeys: ['memory_tools'],
      inspection: {
        catalogId: 'cursor-desktop', detected: true, distribution: { distributionId: 'cursor' },
        components: [{
          componentKey: 'memory_tools', artifactTypes: ['mcp'], visibility: 'dedicated',
          observedTarget: TARGET, observedFragmentHash: 'desired', diagnostics: [],
        }],
        provenance: ['fixture'], diagnostics: [],
      },
      adapterPlan: {
        catalogId: 'cursor-desktop', installationKey: 'cursor:i1', adapterVersion: '7',
        projectionVersion: '9', mutations: [], requiredUserActions: [], diagnostics: [],
      },
      catalogGeneration: 3, adapterGeneration: 7, projectionGeneration: 9, createdAt: T0,
    })

    expect(() => bridge.prepareExecution({
      runId: 'run-noop-rekey', installationId: 'i1', operation: 'connect',
      planHash: noopPlan.executionPlanHash, consentId: 'consent-i1', preparedPlan: noopPlan,
      desiredCapability: 2, mutations: [], expectedDesiredState: 'unmanaged',
      intentAfterPrepare: 'managed', createdAt: T0,
    })).not.toThrow()
    const active = db.prepare(`
      SELECT a.target_path, a.state, c.desired_state
      FROM artifact_consumers c JOIN managed_artifacts a ON a.id = c.artifact_id
      WHERE c.installation_id = 'i1' AND c.component_key = 'memory_tools' AND c.state = 'active'
    `).get()
    expect(active).toEqual({ target_path: TARGET, state: 'needs_recovery', desired_state: 'disabled' })
    expect(db.prepare(`
      SELECT state, tombstone_reason FROM artifact_consumers
      WHERE artifact_id = 'old-noop-surface' AND installation_id = 'i1'
    `).get()).toEqual({ state: 'removed', tombstone_reason: 'host_installation_surface_changed' })
  })

  it('promotes only no-op components verified by the committing run', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    const instructionTarget = '/tmp/tidemind-bridge/skill.md'
    repository.createManagedArtifact({
      id: 'pending-instruction', componentType: 'skill', targetPath: instructionTarget,
      ownershipKey: 'document', mutationDomain: `local_macos:file:${instructionTarget}:document`,
      projectionVersion: '9', selectorSchemaVersion: '1',
      ownedFragmentHash: 'instruction-hash', desiredFragmentHash: 'instruction-hash',
      observedFragmentHash: 'instruction-hash', state: 'needs_recovery',
    }, T0)
    repository.createManagedArtifact({
      id: 'pending-memory', componentType: 'mcp', targetPath: TARGET,
      ownershipKey: 'mcpServers.tidemind', mutationDomain: DOMAIN,
      projectionVersion: '9', selectorSchemaVersion: '1',
      ownedFragmentHash: 'desired', desiredFragmentHash: 'desired',
      observedFragmentHash: 'desired', state: 'needs_recovery',
    }, T0)
    for (const [componentKey, artifactId, visibility] of [
      ['instruction', 'pending-instruction', 'shared_visible'],
      ['memory_tools', 'pending-memory', 'dedicated'],
    ] as const) {
      repository.upsertComponent({
        installationId: 'i1', componentKey, desiredState: 'unmanaged', desiredCapability: 0,
        deliveryMode: 'managed', verificationStatus: 'unverified', artifactId, visibilityState: visibility,
      }, T0)
      repository.addArtifactConsumer({
        artifactId, installationId: 'i1', componentKey, requiredCapability: 0,
        discoverReachability: visibility, consentEnvelopeId: 'consent-i1',
        ownershipFingerprint: componentKey === 'instruction' ? 'instruction-hash' : 'desired',
        allowNeedsRecoveryPending: true, addedAt: T0,
      })
    }
    db.prepare(`UPDATE artifact_consumers SET desired_state = 'disabled'`).run()

    const plan = buildExecutionPlan({
      installationId: 'i1', installationKey: 'cursor:i1', operation: 'connect',
      componentKeys: ['memory_tools'],
      inspection: {
        catalogId: 'cursor-desktop', detected: true, distribution: { distributionId: 'cursor' },
        components: [{
          componentKey: 'memory_tools', visibility: 'dedicated', verificationStatus: 'unverified',
          observedTarget: TARGET, observedFragmentHash: 'desired',
        }],
        provenance: ['fixture'], diagnostics: [],
      },
      adapterPlan: {
        catalogId: 'cursor-desktop', installationKey: 'cursor:i1', adapterVersion: '7', projectionVersion: '9',
        mutations: [], requiredUserActions: [], diagnostics: [],
      },
      catalogGeneration: 3, adapterGeneration: 7, projectionGeneration: 9, createdAt: T0,
    })
    bindSurface(plan, repository, 'i1')
    bridge.prepareExecution({
      runId: 'run-memory-only', installationId: 'i1', operation: 'connect',
      planHash: plan.executionPlanHash, consentId: 'consent-i1', preparedPlan: plan,
      desiredCapability: 2, mutations: [], intentAfterPrepare: 'managed', createdAt: T0,
      expectedDesiredState: 'unmanaged',
    })
    commitRun(db, bridge, 'run-memory-only')

    expect(db.prepare(`
      SELECT artifact_id, desired_state FROM artifact_consumers ORDER BY artifact_id
    `).all()).toEqual([
      { artifact_id: 'pending-instruction', desired_state: 'disabled' },
      { artifact_id: 'pending-memory', desired_state: 'managed' },
    ])
    expect(db.prepare(`
      SELECT id, state FROM managed_artifacts ORDER BY id
    `).all()).toEqual([
      { id: 'pending-instruction', state: 'needs_recovery' },
      { id: 'pending-memory', state: 'healthy' },
    ])
  })

  it('stages an already-absent owned Artifact so a no-op disconnect can close its consumer', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    repository.setInstallationIntent('i1', 'managed', T0)
    repository.createManagedArtifact({
      id: 'missing-mcp', componentType: 'mcp', targetPath: TARGET,
      ownershipKey: 'mcpServers.tidemind', mutationDomain: DOMAIN,
      projectionVersion: '9', selectorSchemaVersion: '1',
      ownedFragmentHash: 'desired', desiredFragmentHash: 'desired',
      observedFragmentHash: 'desired', state: 'healthy',
    }, T0)
    repository.upsertComponent({
      installationId: 'i1', componentKey: 'memory_tools', desiredState: 'managed',
      desiredCapability: 2, deliveryMode: 'managed', verificationStatus: 'stale',
      artifactId: 'missing-mcp', visibilityState: 'absent',
    }, T0)
    repository.addArtifactConsumer({
      artifactId: 'missing-mcp', installationId: 'i1', componentKey: 'memory_tools',
      requiredCapability: 2, discoverReachability: 'dedicated',
      consentEnvelopeId: 'consent-i1', ownershipFingerprint: 'desired', addedAt: T0,
    })
    db.prepare(`UPDATE managed_artifacts SET state = 'missing', observed_fragment_hash = NULL
      WHERE id = 'missing-mcp'`).run()
    const plan = buildExecutionPlan({
      installationId: 'i1', installationKey: 'cursor:i1', operation: 'disconnect',
      componentKeys: ['memory_tools'],
      inspection: {
        catalogId: 'cursor-desktop', detected: true, distribution: { distributionId: 'cursor' },
        components: [{ componentKey: 'memory_tools', visibility: 'absent', verificationStatus: 'stale' }],
        provenance: ['fixture'], diagnostics: [],
      },
      adapterPlan: {
        catalogId: 'cursor-desktop', installationKey: 'cursor:i1', adapterVersion: '7', projectionVersion: '9',
        mutations: [], requiredUserActions: [], diagnostics: [],
      },
      catalogGeneration: 3, adapterGeneration: 7, projectionGeneration: 9, createdAt: T0,
    })
    bindSurface(plan, repository, 'i1')
    const result = bridge.prepareExecution({
      runId: 'run-missing-disconnect', installationId: 'i1', operation: 'disconnect',
      planHash: plan.executionPlanHash, consentId: 'consent-i1', preparedPlan: plan,
      desiredCapability: 0, mutations: [], intentAfterPrepare: 'removed', createdAt: T0,
      expectedDesiredState: 'managed',
    })
    expect(result.mutations).toEqual([])
    expect(db.prepare(`SELECT state, desired_state FROM artifact_consumers WHERE artifact_id = 'missing-mcp'`).get())
      .toEqual({ state: 'removal_pending', desired_state: 'removal_pending' })
    expect(db.prepare(`SELECT state, observed_fragment_hash FROM managed_artifacts WHERE id = 'missing-mcp'`).get())
      .toEqual({ state: 'removal_pending', observed_fragment_hash: null })
    expect(db.prepare(`SELECT scope_mode FROM writer_fences WHERE mutation_domain = ?`).get(DOMAIN))
      .toEqual({ scope_mode: 'managed' })
    commitRun(db, bridge, 'run-missing-disconnect')
    expect(db.prepare(`SELECT state FROM artifact_consumers WHERE artifact_id = 'missing-mcp'`).get())
      .toEqual({ state: 'removed' })
    expect(db.prepare(`SELECT state, owned_fragment_hash FROM managed_artifacts WHERE id = 'missing-mcp'`).get())
      .toEqual({ state: 'removed', owned_fragment_hash: null })
  })

  it('detaches one shared consumer and only plans physical removal for the last consumer', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    const detach = prepare(bridge, 'i1', 'run-detach', mutation('remove'), 'disconnect')
    expect(detach.mutations[0]).toMatchObject({
      effectDisposition: 'consumer_detach',
      journal: { state: 'committed' },
    })
    expect(db.prepare(`SELECT state FROM managed_artifacts`).get()).toEqual({ state: 'healthy' })
    expect(db.prepare(`
      SELECT installation_id, state FROM artifact_consumers ORDER BY installation_id
    `).all()).toEqual([
      { installation_id: 'i1', state: 'removal_pending' },
      { installation_id: 'i2', state: 'active' },
    ])
    commitRun(db, bridge, 'run-detach')
    expect(db.prepare(`SELECT status_reason FROM agent_installations WHERE id = 'i1'`).get())
      .toEqual({ status_reason: 'shared_visibility_remaining' })
    expect(db.prepare(`SELECT state FROM managed_artifacts`).get()).toEqual({ state: 'healthy' })

    const last = prepare(bridge, 'i2', 'run-remove', mutation('remove'), 'disconnect')
    expect(last.mutations[0]).toMatchObject({ effectDisposition: 'apply', journal: { state: 'prepared' } })
    expect(db.prepare(`SELECT state FROM managed_artifacts`).get()).toEqual({ state: 'removal_pending' })
  })

  it('preserves an evidence-free detach-only verified token across startup schema repair', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    const detach = prepare(bridge, 'i1', 'run-detach-crash', mutation('remove'), 'disconnect')
    expect(detach.mutations[0]).toMatchObject({
      effectDisposition: 'consumer_detach',
      journal: { state: 'committed' },
    })
    markApplied(bridge, 'run-detach-crash')
    bridge.setRunState('run-detach-crash', 'verified', T0)

    ensureAgentIntegrationSchema(db)

    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-detach-crash'`).get())
      .toEqual({ state: 'verified' })
    bridge.setRunState('run-detach-crash', 'committed', T0)
    expect(db.prepare(`
      SELECT state FROM artifact_consumers
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ state: 'removed' })
    expect(db.prepare(`SELECT status_reason FROM agent_installations WHERE id = 'i1'`).get())
      .toEqual({ status_reason: 'shared_visibility_remaining' })
  })

  it.each([
    ['wrong Installation', `UPDATE projection_mutations SET installation_id = 'i2' WHERE run_id = 'run-detach-corrupt'`],
    ['missing Artifact', `UPDATE projection_mutations SET artifact_id = NULL WHERE run_id = 'run-detach-corrupt'`],
  ])('cancels an evidence-free detach finalizer with %s binding', (_label, corruptMutation) => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    prepare(bridge, 'i1', 'run-detach-corrupt', mutation('remove'), 'disconnect')
    markApplied(bridge, 'run-detach-corrupt')
    bridge.setRunState('run-detach-corrupt', 'verified', T0)
    db.exec(corruptMutation)

    expect(() => bridge.setRunState('run-detach-corrupt', 'committed', T0))
      .toThrow(/verification evidence is not current at finalization/)
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-detach-corrupt'`).get())
      .toEqual({ state: 'cancelled' })
    expect(db.prepare(`
      SELECT state FROM artifact_consumers
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ state: 'removal_pending' })
  })

  it.each([
    ['revoked consent', `UPDATE agent_consents SET status = 'revoked', revoked_at = '${T0}' WHERE id = 'consent-i1'`],
    ['cleared tombstone', `UPDATE agent_installations SET tombstoned_at = NULL WHERE id = 'i1'`],
    ['missing host', `UPDATE agent_installations SET health_state = 'absent', status_reason = 'host_uninstalled' WHERE id = 'i1'`],
  ])('rechecks %s before an evidence-free detach finalizer commits', (_label, changeControl) => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    prepare(bridge, 'i1', 'run-detach-control', mutation('remove'), 'disconnect')
    markApplied(bridge, 'run-detach-control')
    bridge.setRunState('run-detach-control', 'verified', T0)
    db.exec(changeControl)

    expect(() => bridge.setRunState('run-detach-control', 'committed', T0))
      .toThrow(/verification evidence is not current at finalization/)
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-detach-control'`).get())
      .toEqual({ state: 'cancelled' })
    expect(db.prepare(`
      SELECT state FROM artifact_consumers
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ state: 'removal_pending' })
  })

  it('rejects an extra old-consent removal-pending consumer for the same Installation component', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    prepare(bridge, 'i1', 'run-detach-extra-consumer', mutation('remove'), 'disconnect')
    markApplied(bridge, 'run-detach-extra-consumer')
    bridge.setRunState('run-detach-extra-consumer', 'verified', T0)
    repository.createConsent({
      id: 'consent-i1-old', installationId: 'i1', policyVersion: '1',
      allowedComponents: ['memory_tools'], allowedScopes: [TARGET], normalizedTargets: [TARGET],
      selectorSchemaVersion: '1',
      selectorResolution: {
        'cursor-desktop:memory_tools:mcpServers.tidemind': 'mcpServers.tidemind',
      },
      executableRealpaths: [], commandCategories: ['file_write'], maximumRisk: 'low', confirmedAt: T0,
    })
    db.prepare(`
      UPDATE agent_consents SET status = 'revoked', revoked_at = ? WHERE id = 'consent-i1-old'
    `).run(T0)
    repository.createManagedArtifact({
      id: 'artifact-old-consent', componentType: 'mcp', targetPath: `${TARGET}.old`,
      ownershipKey: 'mcpServers.tidemind.old', mutationDomain: `${DOMAIN}:old`,
      projectionVersion: '9', selectorSchemaVersion: '1',
      ownedFragmentHash: 'old', desiredFragmentHash: 'old', observedFragmentHash: 'old', state: 'healthy',
    }, T0)
    db.prepare(`
      INSERT INTO artifact_consumers (
        artifact_id, installation_id, component_key, required_capability, desired_state,
        discover_reachability, tombstoned_at, tombstone_reason, consent_envelope_id,
        state, added_at, updated_at
      ) VALUES ('artifact-old-consent', 'i1', 'memory_tools', 2, 'removal_pending',
        'dedicated', ?, 'user_disconnect', 'consent-i1-old', 'removal_pending', ?, ?)
    `).run(T0, T0, T0)

    expect(() => bridge.setRunState('run-detach-extra-consumer', 'committed', T0))
      .toThrow(/verification evidence is not current at finalization/)
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-detach-extra-consumer'`).get())
      .toEqual({ state: 'cancelled' })
    const consumers = db.prepare(`
      SELECT artifact_id, consent_envelope_id, state FROM artifact_consumers
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
      ORDER BY artifact_id
    `).all() as Array<{ artifact_id: string; consent_envelope_id: string; state: string }>
    expect(consumers).toHaveLength(2)
    expect(consumers).toContainEqual({
      artifact_id: 'artifact-old-consent',
      consent_envelope_id: 'consent-i1-old',
      state: 'removal_pending',
    })
    expect(consumers).toContainEqual(expect.objectContaining({
      consent_envelope_id: 'consent-i1',
      state: 'removal_pending',
    }))
  })

  it('does not use a detach-only journal as evidence for a non-disconnect run', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    prepare(bridge, 'i1', 'run-detach-operation', mutation('remove'), 'disconnect')
    markApplied(bridge, 'run-detach-operation')
    bridge.setRunState('run-detach-operation', 'verified', T0)
    db.prepare(`UPDATE reconcile_runs SET operation_type = 'connect' WHERE id = 'run-detach-operation'`).run()
    db.prepare(`
      UPDATE agent_installations SET desired_state = 'managed', tombstoned_at = NULL WHERE id = 'i1'
    `).run()

    expect(() => bridge.setRunState('run-detach-operation', 'committed', T0))
      .toThrow(/verification evidence is not current at finalization/)
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-detach-operation'`).get())
      .toEqual({ state: 'cancelled' })
    expect(db.prepare(`
      SELECT state FROM artifact_consumers
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ state: 'removal_pending' })
  })

  it('reserves the physical removal when shared consumers disconnect before either run finalizes', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    const first = prepare(bridge, 'i1', 'run-detach-a', mutation('remove'), 'disconnect')
    markApplied(bridge, 'run-detach-a')
    const second = prepare(bridge, 'i2', 'run-remove-b', mutation('remove'), 'disconnect')
    expect(first.mutations[0].effectDisposition).toBe('consumer_detach')
    expect(second.mutations[0].effectDisposition).toBe('apply')

    bridge.setRunState('run-detach-a', 'verified', T0)
    bridge.setRunState('run-detach-a', 'committed', T0)
    expect(db.prepare(`SELECT state FROM managed_artifacts`).get()).toEqual({ state: 'removal_pending' })

    commitMutation(bridge, 'run-remove-b', second.mutations[0].journal)
    commitRun(db, bridge, 'run-remove-b')
    expect(db.prepare(`SELECT state FROM managed_artifacts`).get()).toEqual({ state: 'removed' })
    expect(db.prepare(`SELECT status_reason FROM agent_installations WHERE id = 'i1'`).get())
      .toEqual({ status_reason: 'disconnect_verified' })
  })

  it('closes a shared Artifact when the physical disconnect finalizes before the detach run', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    prepare(bridge, 'i1', 'run-1')
    commitRun(db, bridge, 'run-1')
    prepare(bridge, 'i2', 'run-2')
    commitRun(db, bridge, 'run-2')

    const detach = prepare(bridge, 'i1', 'run-detach-first', mutation('remove'), 'disconnect')
    markApplied(bridge, 'run-detach-first')
    const physical = prepare(bridge, 'i2', 'run-physical-second', mutation('remove'), 'disconnect')
    commitMutation(bridge, 'run-physical-second', physical.mutations[0].journal)
    commitRun(db, bridge, 'run-physical-second')
    expect(db.prepare(`SELECT state FROM managed_artifacts`).get()).toEqual({ state: 'removal_pending' })

    expect(detach.mutations[0].effectDisposition).toBe('consumer_detach')
    bridge.setRunState('run-detach-first', 'verified', T0)
    bridge.setRunState('run-detach-first', 'committed', T0)
    expect(db.prepare(`SELECT state FROM managed_artifacts`).get()).toEqual({ state: 'removed' })
    expect(db.prepare(`SELECT status_reason FROM agent_installations WHERE id = 'i1'`).get())
      .toEqual({ status_reason: 'disconnect_verified' })
  })

  it('rejects a disconnect atomically when the shared consumer set changed after confirmation', () => {
    const { db, repository, bridge } = setup()
    for (const installationId of ['i1', 'i2', 'i3']) discover(repository, installationId)
    for (const [installationId, runId] of [['i1', 'run-1'], ['i2', 'run-2']] as const) {
      prepare(bridge, installationId, runId)
      commitRun(db, bridge, runId)
    }
    const frozenConsumers = ['i1\0memory_tools', 'i2\0memory_tools']
    prepare(bridge, 'i3', 'run-3')
    commitRun(db, bridge, 'run-3')

    expect(() => prepare(bridge, 'i1', 'run-stale-disconnect', mutation('remove'), 'disconnect', {
      disconnectScopeExpectations: [{
        componentKey: 'memory_tools',
        physicalTarget: TARGET,
        ownershipKey: 'mcpServers.tidemind',
        consumerKeys: frozenConsumers,
      }],
    })).toThrow(/consumer scope changed after confirmation/)
    expect(db.prepare(`SELECT id FROM reconcile_runs WHERE id = 'run-stale-disconnect'`).get()).toBeUndefined()
    expect(db.prepare(`
      SELECT state FROM artifact_consumers
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ state: 'active' })
  })

  it('does not overwrite a later user pause when an older connect run finalizes', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-connect')
    repository.setInstallationIntent('i1', 'disabled', '2026-08-25T00:01:00.000Z')

    markApplied(bridge, 'run-connect')
    commitMutation(bridge, 'run-connect', execution.mutations[0].journal)
    bridge.setRunState('run-connect', 'verified', T0)
    expect(() => bridge.setRunState('run-connect', 'committed', T0))
      .toThrow(/verification evidence is not current/)

    expect(db.prepare(`
      SELECT desired_state, reconcile_state, status_reason FROM agent_installations WHERE id = 'i1'
    `).get()).toEqual({
      desired_state: 'disabled',
      reconcile_state: 'paused',
      status_reason: 'user_disabled',
    })
  })

  it('does not promote old verification after the Installation switches to a newer consent', () => {
    const { db, repository, bridge } = setup()
    discover(repository, 'i1')
    const execution = prepare(bridge, 'i1', 'run-old-consent')
    commitMutation(bridge, 'run-old-consent', execution.mutations[0].journal)
    markApplied(bridge, 'run-old-consent')
    recordRunVerification(db, bridge, 'run-old-consent')
    bridge.setRunState('run-old-consent', 'verified', T0)
    repository.createConsent({
      id: 'consent-new', installationId: 'i1', policyVersion: '1',
      allowedComponents: ['memory_tools'], allowedScopes: [TARGET], normalizedTargets: [TARGET],
      selectorSchemaVersion: '1', selectorResolution: { memory: 'mcpServers.tidemind' },
      executableRealpaths: [], commandCategories: ['file_write'], maximumRisk: 'low', confirmedAt: T0,
    })
    db.prepare(`UPDATE agent_consents SET status = 'revoked', revoked_at = ? WHERE id = 'consent-i1'`).run(T0)
    db.prepare(`
      UPDATE agent_installations
      SET consent_envelope_id = 'consent-new', reconcile_state = 'paused',
          status_reason = 'new_consent_pending', verified_capability = 0,
          verification_summary = 'unverified'
      WHERE id = 'i1'
    `).run()
    db.prepare(`
      UPDATE installation_components
      SET consent_envelope_id = 'consent-new', verification_status = 'unverified'
      WHERE installation_id = 'i1'
    `).run()

    expect(() => bridge.setRunState('run-old-consent', 'committed', T0))
      .toThrow(/verification evidence is not current/)

    expect(db.prepare(`
      SELECT reconcile_state, status_reason, verified_capability, verification_summary
      FROM agent_installations WHERE id = 'i1'
    `).get()).toEqual({
      reconcile_state: 'paused',
      status_reason: 'new_consent_pending',
      verified_capability: 0,
      verification_summary: 'unverified',
    })
  })

  it('holds an OS lock in addition to the renewable SQLite lease', () => {
    const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-lock-'))
    try {
      const { db, repository, bridge } = setup(lockDirectory)
      const first = bridge.acquireWriterFence(DOMAIN)
      expect(first).not.toBeNull()
      // Simulate DB state corruption/release while the process still owns the OS lock.
      db.prepare(`UPDATE writer_fences SET state = 'released', owner_instance_id = NULL, lease_expires_at = NULL`).run()
      const contender = new SqliteCoordinatorRepository(db, repository, {
        ownerInstanceId: 'contender',
        lockDirectory,
      })
      expect(contender.acquireWriterFence(DOMAIN)).toBeNull()
      expect(() => first!.release()).toThrow(/release failed/)
      const recovered = contender.acquireWriterFence(DOMAIN)
      expect(recovered).not.toBeNull()
      recovered!.release()
    } finally {
      fs.rmSync(lockDirectory, { recursive: true, force: true })
    }
  })

  it('serializes the same physical domain across independent SQLite ledgers', () => {
    const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-cross-ledger-'))
    const firstDb = new Database(':memory:')
    const secondDb = new Database(':memory:')
    try {
      ensureSchema(firstDb)
      ensureSchema(secondDb)
      const first = new SqliteCoordinatorRepository(
        firstDb,
        new AgentIntegrationRepository(firstDb),
        { ownerInstanceId: 'stable-channel', lockDirectory },
      )
      const second = new SqliteCoordinatorRepository(
        secondDb,
        new AgentIntegrationRepository(secondDb),
        { ownerInstanceId: 'beta-channel', lockDirectory },
      )
      const lease = first.acquireWriterFence(DOMAIN)
      expect(lease).not.toBeNull()
      expect(second.acquireWriterFence(DOMAIN)).toBeNull()
      lease!.release()
      const next = second.acquireWriterFence(DOMAIN)
      expect(next).not.toBeNull()
      next!.release()
    } finally {
      firstDb.close()
      secondDb.close()
      fs.rmSync(lockDirectory, { recursive: true, force: true })
    }
  })

  it('rejects group/world-accessible or symlinked OS lock roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-root-security-'))
    const insecure = path.join(root, 'insecure')
    const target = path.join(root, 'target')
    const symlink = path.join(root, 'symlink')
    fs.mkdirSync(insecure, { mode: 0o700 })
    fs.chmodSync(insecure, 0o755)
    fs.mkdirSync(target, { mode: 0o700 })
    fs.symlinkSync(target, symlink, 'dir')
    try {
      const { bridge: insecureBridge } = setup(insecure)
      expect(() => insecureBridge.acquireWriterFence(DOMAIN)).toThrow(/insecure OS writer lock directory/)
      const { bridge: symlinkBridge } = setup(symlink)
      expect(() => symlinkBridge.acquireWriterFence(DOMAIN)).toThrow(/insecure OS writer lock directory/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('loses the fence and blocks a second ledger when a trusted ancestor is switched to a symlink', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-ancestor-switch-'))
    const trustedParent = path.join(home, '.tidemind')
    const movedParent = path.join(home, '.tidemind-held')
    const alternateParent = path.join(home, 'alternate')
    const lockDirectory = path.join(trustedParent, 'writer-locks')
    const firstDb = new Database(':memory:')
    const secondDb = new Database(':memory:')
    try {
      fs.mkdirSync(trustedParent, { mode: 0o700 })
      fs.mkdirSync(alternateParent, { mode: 0o700 })
      ensureSchema(firstDb)
      ensureSchema(secondDb)
      const first = new SqliteCoordinatorRepository(
        firstDb,
        new AgentIntegrationRepository(firstDb),
        { ownerInstanceId: 'stable-ledger', lockDirectory, lockDirectoryTrustRoot: home },
      )
      const second = new SqliteCoordinatorRepository(
        secondDb,
        new AgentIntegrationRepository(secondDb),
        { ownerInstanceId: 'beta-ledger', lockDirectory, lockDirectoryTrustRoot: home },
      )
      const lease = first.acquireWriterFence(DOMAIN)
      expect(lease).not.toBeNull()

      fs.renameSync(trustedParent, movedParent)
      fs.symlinkSync(alternateParent, trustedParent, 'dir')

      expect(() => second.acquireWriterFence(DOMAIN)).toThrow(/lock directory ancestor/)
      expect(() => lease!.assertOwned()).toThrow(/OS writer lock lost/)
      lease!.release()
    } finally {
      firstDb.close()
      secondDb.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('treats a lock file whose private mode was widened as lost ownership', () => {
    const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-file-security-'))
    try {
      const { bridge } = setup(lockDirectory)
      const lease = bridge.acquireWriterFence(DOMAIN)
      expect(lease).not.toBeNull()
      const [lockName] = fs.readdirSync(lockDirectory)
      fs.chmodSync(path.join(lockDirectory, lockName), 0o666)
      expect(() => lease!.assertOwned()).toThrow(/OS writer lock lost/)
      // release fails closed and leaves the now-untrusted path for explicit
      // quarantine/diagnosis instead of unlinking by pathname.
      lease!.release()
      expect(fs.existsSync(path.join(lockDirectory, lockName))).toBe(true)
    } finally {
      fs.rmSync(lockDirectory, { recursive: true, force: true })
    }
  })

  it('does not steal an expired OS lock while its exact process owner is alive', async () => {
    const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-live-lock-'))
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      const repository = new AgentIntegrationRepository(db)
      const firstBridge = new SqliteCoordinatorRepository(db, repository, {
        ownerInstanceId: 'live-owner', leaseDurationMs: 25, lockDirectory,
      })
      const contender = new SqliteCoordinatorRepository(db, repository, {
        ownerInstanceId: 'contender', leaseDurationMs: 25, lockDirectory,
      })
      const first = firstBridge.acquireWriterFence(DOMAIN)
      expect(first).not.toBeNull()
      await new Promise(resolve => setTimeout(resolve, 80))

      expect(contender.acquireWriterFence(DOMAIN)).toBeNull()
      first!.release()
      const recovered = contender.acquireWriterFence(DOMAIN)
      expect(recovered).not.toBeNull()
      recovered!.release()
    } finally {
      db.close()
      fs.rmSync(lockDirectory, { recursive: true, force: true })
    }
  })

  it('does not unlink a successor lock when an old owner releases its file descriptor', () => {
    const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-token-lock-'))
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      const repository = new AgentIntegrationRepository(db)
      const bridge = new SqliteCoordinatorRepository(db, repository, {
        ownerInstanceId: 'old-owner', lockDirectory,
      })
      const lease = bridge.acquireWriterFence(DOMAIN)
      expect(lease).not.toBeNull()
      const [lockName] = fs.readdirSync(lockDirectory)
      const lockPath = path.join(lockDirectory, lockName)
      const original = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>
      fs.unlinkSync(lockPath)
      fs.writeFileSync(lockPath, JSON.stringify({ ...original, owner: 'successor', ownerToken: 'successor-token' }))

      lease!.release()

      expect(fs.existsSync(lockPath)).toBe(true)
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
        owner: 'successor', ownerToken: 'successor-token',
      })
    } finally {
      db.close()
      fs.rmSync(lockDirectory, { recursive: true, force: true })
    }
  })

  it('does not quarantine a successor that replaced the stale inode after observation', () => {
    const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-stale-race-'))
    const { db, repository, bridge } = setup(lockDirectory)
    const initial = bridge.acquireWriterFence(DOMAIN)
    expect(initial).not.toBeNull()
    const [lockName] = fs.readdirSync(lockDirectory)
    const lockPath = path.join(lockDirectory, lockName)
    initial!.release()
    fs.writeFileSync(lockPath, JSON.stringify({
      owner: 'dead-owner', ownerToken: 'dead-token', pid: 2_147_483_647,
      processStartIdentity: 'dead-start', mutationDomain: DOMAIN,
    }), { flag: 'wx', mode: 0o600 })
    fs.utimesSync(lockPath, new Date(0), new Date(0))

    const realRename = fs.renameSync.bind(fs)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, destination) => {
      fs.unlinkSync(source)
      fs.writeFileSync(source, JSON.stringify({
        owner: 'successor', ownerToken: 'successor-token', pid: process.pid,
        processStartIdentity: null, mutationDomain: DOMAIN,
      }), { flag: 'wx', mode: 0o600 })
      realRename(source, destination)
    })
    try {
      const contender = new SqliteCoordinatorRepository(db, repository, {
        ownerInstanceId: 'contender', leaseDurationMs: 25, lockDirectory,
        now: () => new Date(T0),
      })
      expect(contender.acquireWriterFence(DOMAIN)).toBeNull()
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({
        owner: 'successor', ownerToken: 'successor-token',
      })
    } finally {
      rename.mockRestore()
      db.close()
      fs.rmSync(lockDirectory, { recursive: true, force: true })
    }
  })

  it('preserves the primary close failure while still attempting OS lock cleanup', () => {
    const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-lock-cleanup-'))
    const close = vi.spyOn(fs, 'closeSync').mockImplementationOnce(() => {
      throw new Error('primary close failure')
    })
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('secondary unlink failure')
    })
    try {
      const { bridge } = setup(lockDirectory)
      const lease = bridge.acquireWriterFence(DOMAIN)
      expect(lease).not.toBeNull()
      expect(() => lease!.release()).toThrow('primary close failure')
      expect(unlink).toHaveBeenCalledTimes(1)
    } finally {
      close.mockRestore()
      unlink.mockRestore()
      fs.rmSync(lockDirectory, { recursive: true, force: true })
    }
  })
})
