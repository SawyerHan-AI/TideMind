import { describe, expect, it, vi } from 'vitest'
import type { ConsentEnvelope } from '../../client/electron/agent-integration/consent'
import {
  AgentIntegrationCoordinator,
  physicalMutationDomain,
  type CoordinatorDependencies,
  type CoordinatorInstallation,
  type CoordinatorRepositoryPort,
  type InstallationControlState,
  type PrepareExecutionInput,
  type RecoverableExecution,
} from '../../client/electron/agent-integration/coordinator'
import { buildLegacyMutationDomain } from '../../client/electron/agent-integration/legacy-writer'
import type { IntegrationEvent } from '../../client/electron/agent-integration/events'
import type { MutationJournalRecord } from '../../client/electron/agent-integration/mutation-runner'
import type {
  AdapterInspection,
  AgentHostAdapter,
  ComponentVerificationResult,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

const T0 = new Date('2026-08-25T00:00:00.000Z')

const installation: CoordinatorInstallation = {
  id: 'installation-1',
  displayName: 'Cursor',
  desiredState: 'unmanaged',
  agentId: 'eb-agent-1',
  identity: {
    runtimeRealm: 'local_macos',
    osUserIdentity: 'uid:501',
    productFamilyId: 'cursor',
    hostVariant: 'cursor-desktop',
    canonicalConfigRoot: '/tmp/tidemind',
    explicitProfile: '',
    distribution: { distributionId: 'cursor' },
    installKey: 'cursor:default',
  },
}

const consent: ConsentEnvelope = {
  id: 'consent-1',
  installationId: installation.id,
  componentKeys: ['memory_tools'],
  targetScopes: ['directory:/tmp/tidemind'],
  selectorResolution: { 'cursor-desktop:memory_tools:mcpServers.tidemind': 'mcpServers.tidemind' },
  executableRealpaths: [],
  commandCategories: ['file_write'],
  maxRisk: 'low',
  selectorSchemaVersion: 1,
  policyVersion: 1,
  approvedAt: T0.toISOString(),
  revokedAt: null,
}

class MemoryRepository implements CoordinatorRepositoryPort {
  control: InstallationControlState = {
    desiredState: 'unmanaged',
    tombstoned: false,
    healthState: 'discovered',
    statusReason: null,
    installKey: installation.identity.installKey,
    agentId: installation.agentId,
    hostVariant: installation.identity.hostVariant,
    consentId: consent.id,
  }
  consent: ConsentEnvelope | null = consent
  baselines: OwnedArtifactBaseline[] = []
  calls: string[] = []
  prepared: PrepareExecutionInput | null = null
  recoverable: RecoverableExecution[] = []
  mutationRecords = new Map<string, MutationJournalRecord>()
  events: IntegrationEvent[] = []
  releaseThrows = false
  afterEffectRevalidate?: () => void
  afterFenceAssert?: (assertionNumber: number) => void
  fenceAssertCalls = 0
  commitThrows = false
  claimAllowed = true
  beforeVerificationBatch: (() => void) | null = null
  afterRunState: ((state: string) => void) | null = null
  verificationHostVersions: Array<string | null> = []

  getInstallationControl() { return this.control }
  getInstallationHostVersion() { return '2.3.4' }
  listOwnedArtifactBaselines() { return this.baselines }
  getConsent(id: string) { return this.consent?.id === id ? this.consent : null }
  setInstallationReconcileState(
    _id: string,
    state: string,
    _reason: string | null,
    _updatedAt: string,
    options: { expectedDesiredState?: string; expectedConsentId?: string | null } = {},
  ) {
    if (options.expectedDesiredState !== undefined
      && this.control.desiredState !== options.expectedDesiredState) return false
    if (Object.prototype.hasOwnProperty.call(options, 'expectedConsentId')
      && this.control.consentId !== options.expectedConsentId) return false
    this.calls.push(`installation:${state}`)
    return true
  }
  prepareExecution(input: PrepareExecutionInput) {
    this.calls.push('prepare')
    this.prepared = input
    this.control = {
      ...this.control,
      desiredState: input.intentAfterPrepare,
      tombstoned: input.intentAfterPrepare === 'removed',
    }
    for (const mutation of input.mutations) this.mutationRecords.set(mutation.journal.id, mutation.journal)
    return { mutations: input.mutations }
  }
  saveMutation(_runId: string, mutation: MutationJournalRecord) {
    this.calls.push(`journal:${mutation.state}`)
    this.mutationRecords.set(mutation.id, mutation)
  }
  claimMutationEffect() {
    this.calls.push('effect:claim')
    return this.claimAllowed
      && this.control.healthState === 'discovered'
      && this.control.statusReason !== 'conflict'
      && this.consent !== null
  }
  revalidateClaimedMutationEffect(input: { expectedDesiredState: 'managed' | 'removed' }) {
    this.calls.push('effect:revalidate')
    const allowed = this.claimAllowed
      && this.control.healthState === 'discovered'
      && this.control.statusReason !== 'conflict'
      && this.consent !== null
      && this.control.consentId === this.consent.id
      && this.control.desiredState === input.expectedDesiredState
    this.afterEffectRevalidate?.()
    return allowed
  }
  setRunState(_id: string, state: string) {
    this.calls.push(`run:${state}`)
    if (state === 'committed' && this.commitThrows) throw new Error('finalizer unavailable')
    this.afterRunState?.(state)
  }
  acquireWriterFence() {
    this.calls.push('fence:acquire')
    return {
      epoch: 1,
      writerGeneration: 1,
      assertOwned: () => {
        this.calls.push('fence:assert')
        this.fenceAssertCalls += 1
        this.afterFenceAssert?.(this.fenceAssertCalls)
      },
      release: () => {
        this.calls.push('fence:release')
        if (this.releaseThrows) throw new Error('release failed')
      },
    }
  }
  recordVerification(input: { result: ComponentVerificationResult; expectedHostVersion: string | null }) {
    this.calls.push(`verification:${input.result.status}`)
    this.verificationHostVersions.push(input.expectedHostVersion)
  }
  recordVerificationBatch(inputs: readonly {
    result: ComponentVerificationResult
    expectedHostVersion: string | null
  }[]) {
    this.beforeVerificationBatch?.()
    this.calls.push('verification:batch')
    for (const input of inputs) this.recordVerification(input)
  }
  blockVerifiedFinalization(input: { reason: string }) {
    this.calls.push(`run:verified-blocked:${input.reason}`)
    this.calls.push('installation:needs_recovery')
  }
  listRecoverableExecutions() { return this.recoverable }
  recordEvent(event: IntegrationEvent) { this.events.push(event) }
}

function inspection(live: string | null): AdapterInspection {
  return {
    catalogId: 'cursor-desktop',
    detected: true,
    distribution: { distributionId: 'cursor' },
    components: [{
      componentKey: 'memory_tools',
      visibility: live === null ? 'absent' : 'dedicated',
      verificationStatus: live === 'desired' ? 'verified' : 'unverified',
      observedFragmentHash: live ?? undefined,
    }],
    provenance: ['fixture'],
    diagnostics: [],
  }
}

function harness() {
  const repository = new MemoryRepository()
  let live: string | null = null
  let sequence = 0
  const hostActivityEvidence = { find: vi.fn(() => []) }
  const apply = vi.fn(async (context, mutation) => {
    expect(context.agentId).toBe('eb-agent-1')
    repository.calls.push('adapter:apply')
    live = mutation.operation === 'remove' ? null : 'desired'
    return { operationId: mutation.operationId, effectObserved: true, postEffectFingerprint: live ?? undefined }
  })
  const adapter: AgentHostAdapter = {
    catalogId: 'cursor-desktop',
    adapterVersion: '1.0.0',
    componentKeys: ['memory_tools'],
    implementationTypes: { memory_tools: ['mcp'] },
    inspect: vi.fn(async () => inspection(live)),
    plan: vi.fn(async (_context, request) => {
      expect(request.ownedArtifacts).toEqual(repository.baselines)
      return {
        catalogId: 'cursor-desktop',
        installationKey: 'cursor:default',
        adapterVersion: '1.0.0',
        projectionVersion: '1',
        mutations: [{
          operationId: 'write-mcp',
          componentKey: 'memory_tools',
          operation: 'create',
          domainKind: 'file_fragment',
          physicalTarget: '/tmp/tidemind/config.json',
          ownershipKey: 'mcpServers.tidemind',
          selectorSchemaVersion: 1,
          risk: 'low',
          reload: 'reload',
          desiredFragmentHash: 'desired',
          idempotent: true,
        }],
        requiredUserActions: [],
        diagnostics: [],
      }
    }),
    apply,
    readBack: vi.fn(async () => {
      repository.calls.push('adapter:readback')
      return {
        operationId: 'write-mcp',
        observed: live !== null,
        matchesDesired: live === 'desired',
        observedFragmentHash: live ?? undefined,
        diagnostics: [],
      }
    }),
    disconnect: vi.fn(async (_context, request) => {
      expect(request.ownedArtifacts).toEqual(repository.baselines)
      return {
        catalogId: 'cursor-desktop',
        installationKey: 'cursor:default',
        adapterVersion: '1.0.0',
        projectionVersion: '1',
        mutations: [{
          operationId: 'remove-mcp',
          componentKey: 'memory_tools',
          operation: 'remove',
          domainKind: 'file_fragment',
          physicalTarget: '/tmp/tidemind/config.json',
          ownershipKey: 'mcpServers.tidemind',
          selectorSchemaVersion: 1,
          risk: 'low',
          reload: 'reload',
          preconditionHash: 'desired',
          idempotent: true,
        }],
        requiredUserActions: [],
        diagnostics: [],
      }
    }),
    verify: vi.fn(async (context, request) => {
      expect(context.agentId).toBe('eb-agent-1')
      expect(context.hostActivityEvidence).toBe(hostActivityEvidence)
      expect(request.activityBinding).toMatchObject({
        installationId: installation.id,
        tideMindVersion: '0.2.89',
        adapterVersion: '1.0.0',
        projectionVersion: '1',
        hostVersion: '2.3.4',
        verifiedAt: T0.toISOString(),
      })
      repository.calls.push('adapter:verify')
      const disconnected = request.expectedCapability === 0 && live === null
      return [{
        componentKey: 'memory_tools',
        status: live === 'desired' || disconnected ? 'verified' : 'failed',
        verifiedCapability: live === 'desired' ? 3 : disconnected ? 0 : null,
        identityAssertion: live === 'desired' || disconnected ? context.agentId : undefined,
        evidenceHash: live ?? undefined,
        invalidationKeys: [],
        diagnostics: [],
      }]
    }),
  }
  const dependencies: CoordinatorDependencies = {
    runtime: {
      runtimeRealm: 'local_macos',
      homeDir: '/tmp/tidemind/home-fixture',
      applicationDataDir: '/tmp/tidemind/app-fixture',
      tideMindVersion: '0.2.89',
      catalogVersion: '1.0.0',
      projectionVersion: '1',
    },
    adapters: { get: id => id === 'cursor-desktop' ? adapter : undefined },
    repository,
    notifications: { deliver: vi.fn() },
    clock: { now: () => T0 },
    ids: { next: prefix => `${prefix}-${++sequence}` },
    catalogGeneration: 1,
    adapterGeneration: () => 1,
    projectionGeneration: () => 1,
    hostActivityEvidence,
  }
  return {
    repository,
    adapter,
    apply,
    dependencies,
    coordinator: new AgentIntegrationCoordinator(dependencies),
    setLive(value: string | null) { live = value },
  }
}

async function preview(test: ReturnType<typeof harness>) {
  return test.coordinator.preview({
    installation,
    operation: 'connect',
    componentKeys: ['memory_tools'],
    desiredCapability: 3,
  })
}

function appliedUnverifiedExecution(
  plan: Awaited<ReturnType<typeof preview>>,
  runId: string,
): RecoverableExecution {
  return {
    runId,
    runState: 'applied_unverified',
    installation: { ...installation, desiredState: 'managed' },
    consentId: consent.id,
    desiredCapability: 3,
    preparedPlan: plan,
    mutations: [{
      operationId: 'write-mcp',
      mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
      plannedMutation: plan.adapterPlan.mutations[0],
      journal: {
        id: `mutation-${runId}`,
        state: 'committed',
        journalVersion: 5,
        attemptCount: 1,
        idempotent: true,
        beforeFingerprint: null,
        desiredFingerprint: 'desired',
        postEffectFingerprint: 'desired',
        compensationPrecondition: null,
        receiptJson: '{}',
        failureCode: null,
        failureStage: null,
        updatedAt: T0.toISOString(),
      },
    }],
  }
}

describe('AgentIntegrationCoordinator', () => {
  it('keeps a newly discovered Installation awaiting consent and produces no effect', async () => {
    const test = harness()
    const plan = await preview(test)
    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: null,
      desiredCapability: 3,
    })

    expect(result).toMatchObject({ status: 'awaiting_consent' })
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.repository.prepared).toBeNull()
    expect(test.repository.calls).toContain('installation:awaiting_consent')
  })

  it('persists plan and journal before fence/apply, then read-backs and verifies', async () => {
    const test = harness()
    const plan = await preview(test)
    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
      applyTaskBinding: {
        taskId: 'task-1',
        installationId: installation.id,
        executionPlanHash: plan.executionPlanHash,
      },
    })

    expect(result).toMatchObject({ status: 'committed' })
    const order = test.repository.calls
    expect(order.indexOf('prepare')).toBeLessThan(order.indexOf('fence:acquire'))
    expect(test.repository.prepared?.applyTaskBinding).toEqual({
      taskId: 'task-1',
      installationId: installation.id,
      executionPlanHash: plan.executionPlanHash,
    })
    expect(order.indexOf('journal:effect_started')).toBeLessThan(order.indexOf('adapter:apply'))
    expect(order.indexOf('fence:assert')).toBeLessThan(order.indexOf('adapter:apply'))
    expect(order.indexOf('adapter:readback')).toBeLessThan(order.indexOf('adapter:apply'))
    const applyIndex = order.indexOf('adapter:apply')
    expect(order[applyIndex - 1]).toBe('fence:assert')
    expect(applyIndex).toBeLessThan(order.lastIndexOf('adapter:readback'))
    expect(order.slice(applyIndex + 1)).toContain('fence:assert')
    expect(order.lastIndexOf('adapter:readback')).toBeLessThan(order.indexOf('adapter:verify'))
    expect(order).toContain('journal:receipt_persisted')
    expect(test.repository.verificationHostVersions).toEqual(['2.3.4'])
    expect(order.at(-1)).toBe('run:committed')
  })

  it('rechecks current production authority after async precondition read-back and before the physical effect', async () => {
    const test = harness()
    const plan = await preview(test)
    let authorized = true
    test.dependencies.authorizeEffect = () => authorized
    vi.mocked(test.adapter.readBack).mockImplementationOnce(async () => {
      authorized = false
      return {
        operationId: 'write-mcp',
        observed: false,
        matchesDesired: false,
        diagnostics: [],
      }
    })

    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })

    expect(result).toMatchObject({ status: 'needs_recovery' })
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.repository.calls).toContain('effect:claim')
    expect(test.repository.calls).not.toContain('effect:revalidate')
  })

  it('revalidates repository-backed current authority after async read-back', async () => {
    const test = harness()
    const plan = await preview(test)
    vi.mocked(test.adapter.readBack).mockImplementationOnce(async () => {
      test.repository.control = { ...test.repository.control, desiredState: 'disabled' }
      return {
        operationId: 'write-mcp', observed: false, matchesDesired: false, diagnostics: [],
      }
    })

    const result = await test.coordinator.applyPrepared({
      installation, preparedPlan: plan, consentId: consent.id, desiredCapability: 3,
    })

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'effect_failed_or_unknown' })
    expect(test.repository.calls).toContain('effect:revalidate')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it.each([
    ['repository effect revalidation', (test: ReturnType<typeof harness>, revoke: () => void) => {
      test.repository.afterEffectRevalidate = revoke
    }],
    ['final writer-fence assertion', (test: ReturnType<typeof harness>, revoke: () => void) => {
      test.repository.afterFenceAssert = assertionNumber => {
        if (assertionNumber === 2) revoke()
      }
    }],
  ] as const)('re-attests source trust after the %s wait and immediately before apply', async (_label, installRevocation) => {
    const test = harness()
    const plan = await preview(test)
    let authorized = true
    let authorizationCalls = 0
    test.dependencies.authorizeEffect = () => {
      authorizationCalls += 1
      test.repository.calls.push(`trust:authorize:${authorizationCalls}`)
      return authorized
    }
    installRevocation(test, () => { authorized = false })

    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'effect_failed_or_unknown' })
    expect(authorizationCalls).toBe(3)
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('claims current intent, host health, and consent at the effect boundary', async () => {
    const test = harness()
    const plan = await preview(test)
    test.repository.claimAllowed = false

    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'effect_failed_or_unknown' })
    expect(test.repository.calls.indexOf('journal:effect_started')).toBeLessThan(
      test.repository.calls.indexOf('effect:claim'),
    )
    expect(test.apply).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'removed'] as const)('fails closed for a %s Installation', async (state) => {
    const test = harness()
    const plan = await preview(test)
    test.repository.control = { ...test.repository.control, desiredState: state, tombstoned: state === 'removed' }
    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })
    expect(result).toEqual({ status: 'paused', reason: state })
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('rejects a cached plan when the host is no longer authoritatively present', async () => {
    const test = harness()
    const plan = await preview(test)
    test.repository.control = {
      ...test.repository.control,
      healthState: 'unknown',
      statusReason: 'verification_stale',
    }

    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })

    expect(result).toEqual({ status: 'paused', reason: 'host_not_authoritatively_present' })
    expect(test.repository.prepared).toBeNull()
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('does not let an older consent result overwrite a concurrent user pause', async () => {
    const test = harness()
    const plan = await preview(test)
    test.repository.getConsent = () => {
      test.repository.control = {
        ...test.repository.control,
        desiredState: 'disabled',
        consentId: null,
      }
      return null
    }

    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })

    expect(result).toMatchObject({ status: 'awaiting_consent' })
    expect(test.repository.calls).not.toContain('installation:awaiting_consent')
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('recovers a desired live effect without replaying the adapter apply', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [{
      runId: 'run-recover',
      runState: 'applying',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-recover',
          state: 'effect_started',
          journalVersion: 1,
          attemptCount: 1,
          idempotent: true,
          beforeFingerprint: null,
          desiredFingerprint: 'desired',
          postEffectFingerprint: null,
          compensationPrecondition: null,
          receiptJson: null,
          failureCode: null,
          failureStage: null,
          updatedAt: T0.toISOString(),
        },
      }],
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns({ canReplayEffect: () => false })
    expect(result).toMatchObject({ status: 'committed', runId: 'run-recover' })
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.repository.calls).toContain('journal:receipt_persisted')
  })

  it('keeps a before-state mutation recoverable when the production write gate is closed', async () => {
    const test = harness()
    const plan = await preview(test)
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [{
      runId: 'run-gate-closed',
      runState: 'applying',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-gate-closed',
          state: 'effect_started',
          journalVersion: 1,
          attemptCount: 1,
          idempotent: true,
          beforeFingerprint: null,
          desiredFingerprint: 'desired',
          postEffectFingerprint: null,
          compensationPrecondition: null,
          receiptJson: null,
          failureCode: null,
          failureStage: null,
          updatedAt: T0.toISOString(),
        },
      }],
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns({ canReplayEffect: () => false })

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'recovery_write_gate_closed' })
    expect(test.adapter.readBack).toHaveBeenCalledOnce()
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.repository.calls).not.toContain('effect:claim')
  })

  it('never replays a pending connect effect after the host was authoritatively uninstalled', async () => {
    const test = harness()
    const plan = await preview(test)
    test.repository.control = {
      ...test.repository.control,
      desiredState: 'managed',
      healthState: 'host_uninstalled',
    }
    test.repository.recoverable = [{
      runId: 'run-host-gone',
      runState: 'applying',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-host-gone',
          state: 'effect_started',
          journalVersion: 1,
          attemptCount: 1,
          idempotent: true,
          beforeFingerprint: null,
          desiredFingerprint: 'desired',
          postEffectFingerprint: null,
          compensationPrecondition: null,
          receiptJson: null,
          failureCode: null,
          failureStage: null,
          updatedAt: T0.toISOString(),
        },
      }],
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns()

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'host_not_authoritatively_present' })
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('retries only host verification for an applied projection', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [{
      runId: 'run-awaiting-host',
      runState: 'applied_unverified',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-awaiting-host',
          state: 'committed',
          journalVersion: 5,
          attemptCount: 1,
          idempotent: true,
          beforeFingerprint: null,
          desiredFingerprint: 'desired',
          postEffectFingerprint: 'desired',
          compensationPrecondition: null,
          receiptJson: '{}',
          failureCode: null,
          failureStage: null,
          updatedAt: T0.toISOString(),
        },
      }],
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns()

    expect(result).toMatchObject({ status: 'committed', runId: 'run-awaiting-host' })
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.adapter.readBack).not.toHaveBeenCalled()
    expect(test.adapter.verify).toHaveBeenCalledOnce()
    expect(test.repository.calls).toContain('run:verified')
    expect(test.repository.calls).toContain('run:committed')
  })

  it('isolates a missing recovery Adapter and continues the next persisted run', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [
      appliedUnverifiedExecution(plan, 'run-missing-adapter'),
      appliedUnverifiedExecution(plan, 'run-after-missing-adapter'),
    ]
    const normalGet = test.dependencies.adapters.get.bind(test.dependencies.adapters)
    let lookup = 0
    test.dependencies.adapters.get = id => (++lookup === 1 ? undefined : normalGet(id))

    const outcomes = await test.coordinator.recoverNonTerminalRuns()

    expect(outcomes).toEqual([
      { status: 'needs_recovery', runId: 'run-missing-adapter', reason: 'recovery_execution_failed' },
      expect.objectContaining({ status: 'committed', runId: 'run-after-missing-adapter' }),
    ])
    expect(test.repository.calls).toContain('run:needs_recovery')
    expect(test.repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'startup_recovery_execution_failed',
        payload: expect.objectContaining({
          runId: 'run-missing-adapter',
          message: 'no enabled Adapter for cursor-desktop',
        }),
      }),
    ]))
    expect(test.adapter.verify).toHaveBeenCalledOnce()
  })

  it('does not let verification and diagnostic persistence failures starve a later run', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [
      appliedUnverifiedExecution(plan, 'run-diagnostic-failure'),
      appliedUnverifiedExecution(plan, 'run-after-diagnostic-failure'),
    ]
    vi.mocked(test.adapter.verify)
      .mockRejectedValueOnce(new Error('verification backend unavailable'))
    const persist = test.repository.recordEvent.bind(test.repository)
    let persistenceFailures = 2
    test.repository.recordEvent = event => {
      if (persistenceFailures > 0) {
        persistenceFailures -= 1
        throw new Error('event database unavailable')
      }
      persist(event)
    }

    const outcomes = await test.coordinator.recoverNonTerminalRuns()

    expect(outcomes).toEqual([
      { status: 'needs_recovery', runId: 'run-diagnostic-failure', reason: 'recovery_execution_failed' },
      expect.objectContaining({ status: 'committed', runId: 'run-after-diagnostic-failure' }),
    ])
    expect(test.repository.calls.filter(call => call === 'run:needs_recovery').length)
      .toBeGreaterThanOrEqual(1)
    expect(test.adapter.verify).toHaveBeenCalledTimes(2)
  })

  it('keeps a verified finalizer fail-closed when its diagnostic fails and continues a later run', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [{
      runId: 'run-finalizer-failure',
      runState: 'verified',
      installationId: installation.id,
      installationSurfaceFingerprint: null,
      liveTrustProofFingerprint: null,
    }, appliedUnverifiedExecution(plan, 'run-after-finalizer-failure')]
    const setRunState = test.repository.setRunState.bind(test.repository)
    test.repository.setRunState = (runId, state) => {
      if (runId === 'run-finalizer-failure' && state === 'committed') {
        throw new Error('finalizer unavailable')
      }
      setRunState(runId, state)
    }
    const persist = test.repository.recordEvent.bind(test.repository)
    let rejectFinalizerDiagnostic = true
    test.repository.recordEvent = event => {
      if (rejectFinalizerDiagnostic && event.kind === 'verified_finalization_blocked') {
        rejectFinalizerDiagnostic = false
        throw new Error('finalizer diagnostic unavailable')
      }
      persist(event)
    }

    const outcomes = await test.coordinator.recoverNonTerminalRuns()

    expect(outcomes).toEqual([
      { status: 'needs_recovery', runId: 'run-finalizer-failure', reason: 'recovery_execution_failed' },
      expect.objectContaining({ status: 'committed', runId: 'run-after-finalizer-failure' }),
    ])
    expect(test.repository.calls).toContain('run:verified-blocked:recovery_execution_failed')
    expect(test.repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'startup_recovery_execution_failed' }),
    ]))
  })

  it.each(['catalog', 'adapter', 'projection'] as const)(
    'fails closed before verification when the frozen %s generation changed',
    async generation => {
      const test = harness()
      const plan = await preview(test)
      test.setLive('desired')
      test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
      test.repository.recoverable = [appliedUnverifiedExecution(plan, `run-stale-${generation}`)]
      if (generation === 'catalog') test.dependencies.catalogGeneration = 2
      if (generation === 'adapter') test.dependencies.adapterGeneration = () => 2
      if (generation === 'projection') test.dependencies.projectionGeneration = () => 2

      const [result] = await test.coordinator.recoverNonTerminalRuns()

      expect(result).toMatchObject({
        status: 'needs_recovery',
        reason: `${generation}_generation_changed`,
      })
      expect(test.adapter.verify).not.toHaveBeenCalled()
      expect(test.repository.calls.some(call => call.startsWith('verification:'))).toBe(false)
      expect(test.repository.calls).toContain('run:needs_recovery')
      expect(test.apply).not.toHaveBeenCalled()
    },
  )

  it.each(['catalog', 'adapter', 'projection'] as const)(
    'rechecks the frozen %s generation after every async verification boundary and before commit',
    async generation => {
      for (const stage of ['inspect', 'verify', 'evidence', 'commit'] as const) {
        const test = harness()
        const plan = await preview(test)
        test.setLive('desired')
        test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
        test.repository.recoverable = [appliedUnverifiedExecution(plan, `run-${generation}-${stage}`)]
        const drift = () => {
          if (generation === 'catalog') test.dependencies.catalogGeneration = 2
          if (generation === 'adapter') test.dependencies.adapterGeneration = () => 2
          if (generation === 'projection') test.dependencies.projectionGeneration = () => 2
        }
        if (stage === 'inspect') {
          vi.mocked(test.adapter.inspect).mockImplementationOnce(async () => {
            drift()
            return inspection('desired')
          })
        }
        if (stage === 'verify') {
          vi.mocked(test.adapter.verify).mockImplementationOnce(async context => {
            drift()
            return [{
              componentKey: 'memory_tools',
              status: 'verified',
              verifiedCapability: 3,
              identityAssertion: context.agentId,
              evidenceHash: 'desired',
              invalidationKeys: [],
              diagnostics: [],
            }]
          })
        }
        if (stage === 'commit') {
          test.repository.afterRunState = state => {
            if (state === 'verified') drift()
          }
        }
        let authorizationChecks = 0
        const [result] = await test.coordinator.recoverNonTerminalRuns({
          canContinueRecovery: () => {
            authorizationChecks += 1
            if (stage === 'evidence' && authorizationChecks === 5) drift()
            return true
          },
        })

        expect(result).toMatchObject({
          status: 'needs_recovery',
          reason: `${generation}_generation_changed`,
        })
        expect(test.apply).not.toHaveBeenCalled()
        expect(test.repository.calls).not.toContain('run:committed')
        if (stage === 'inspect' || stage === 'verify' || stage === 'evidence') {
          expect(test.repository.calls).not.toContain('verification:batch')
        } else {
          expect(test.repository.calls).toContain('verification:batch')
          expect(test.repository.calls).toContain(
            `run:verified-blocked:${generation}_generation_changed`,
          )
        }
      }
    },
  )

  it('does not inspect, verify, persist evidence or finalize when recovery trust is already gone', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [appliedUnverifiedExecution(plan, 'run-untrusted-recovery')]
    vi.mocked(test.adapter.inspect).mockClear()
    vi.mocked(test.adapter.verify).mockClear()

    const [result] = await test.coordinator.recoverNonTerminalRuns({ canContinueRecovery: () => false })

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'recovery_source_trust_changed' })
    expect(test.adapter.inspect).not.toHaveBeenCalled()
    expect(test.adapter.verify).not.toHaveBeenCalled()
    expect(test.repository.calls).not.toContain('verification:batch')
    expect(test.repository.calls).not.toContain('run:committed')
    expect(test.repository.calls).toContain('run:needs_recovery')
  })

  it('drops applied verification when recovery trust disappears while inspect is awaited', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [appliedUnverifiedExecution(plan, 'run-inspect-trust-loss')]
    vi.mocked(test.adapter.inspect).mockClear()
    vi.mocked(test.adapter.verify).mockClear()
    let checks = 0

    const [result] = await test.coordinator.recoverNonTerminalRuns({
      canContinueRecovery: () => {
        checks += 1
        return checks === 1
      },
    })

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'recovery_source_trust_changed' })
    expect(test.adapter.inspect).toHaveBeenCalledOnce()
    expect(test.adapter.verify).not.toHaveBeenCalled()
    expect(test.repository.calls).not.toContain('verification:batch')
    expect(test.repository.calls).not.toContain('run:committed')
  })

  it('cancels a verified finalizer token atomically when current recovery trust is gone', async () => {
    const test = harness()
    test.repository.recoverable = [{
      runId: 'run-untrusted-verified',
      runState: 'verified',
      installationId: installation.id,
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns({ canContinueRecovery: () => false })

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'recovery_source_trust_changed' })
    expect(test.repository.calls).toContain('run:verified-blocked:recovery_source_trust_changed')
    expect(test.repository.calls).not.toContain('run:committed')
    expect(test.adapter.inspect).not.toHaveBeenCalled()
    expect(test.adapter.verify).not.toHaveBeenCalled()
  })

  it('finalizes a recovered verified run without replaying effects or verification', async () => {
    const test = harness()
    await preview(test)
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [{
      runId: 'run-verified-crash',
      runState: 'verified',
      installationId: installation.id,
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns()

    expect(result).toEqual({ status: 'committed', runId: 'run-verified-crash', verification: [] })
    expect(test.repository.calls).toContain('run:committed')
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.adapter.verify).not.toHaveBeenCalled()
    expect(test.adapter.inspect).toHaveBeenCalledTimes(1)
  })

  it('keeps a verified run finalizer-only when the atomic finalizer temporarily fails', async () => {
    const test = harness()
    await preview(test)
    test.repository.commitThrows = true
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [{
      runId: 'run-verified-finalizer-retry',
      runState: 'verified',
      installationId: installation.id,
    }]

    const [first] = await test.coordinator.recoverNonTerminalRuns()
    const [second] = await test.coordinator.recoverNonTerminalRuns()

    expect(first).toMatchObject({ status: 'needs_recovery', reason: 'verified_finalization_blocked' })
    expect(second).toMatchObject({ status: 'needs_recovery', reason: 'verified_finalization_blocked' })
    expect(test.repository.calls.filter(call => call === 'run:committed')).toHaveLength(2)
    expect(test.repository.calls).not.toContain('run:needs_recovery')
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.adapter.readBack).not.toHaveBeenCalled()
    expect(test.adapter.verify).not.toHaveBeenCalled()
  })

  it('rejects the entire adapter verification batch before persisting an out-of-scope result', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed', tombstoned: false }
    test.repository.recoverable = [{
      runId: 'run-out-of-scope-verification',
      runState: 'applied_unverified',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-out-of-scope-verification', state: 'committed', journalVersion: 5, attemptCount: 1,
          idempotent: true, beforeFingerprint: null, desiredFingerprint: 'desired',
          postEffectFingerprint: 'desired', compensationPrecondition: null, receiptJson: '{}',
          failureCode: null, failureStage: null, updatedAt: T0.toISOString(),
        },
      }],
    }]
    vi.mocked(test.adapter.verify).mockResolvedValueOnce([
      {
        componentKey: 'memory_tools', status: 'verified', verifiedCapability: 3,
        invalidationKeys: [], diagnostics: [],
      },
      {
        componentKey: 'instruction', status: 'verified', verifiedCapability: 1,
        invalidationKeys: [], diagnostics: [],
      },
    ])

    const [result] = await test.coordinator.recoverNonTerminalRuns()

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'verification_failed' })
    expect(test.repository.calls.some(call => call.startsWith('verification:'))).toBe(false)
  })

  it('does not refresh verification after the run consent was revoked', async () => {
    const test = harness()
    const plan = await preview(test)
    test.setLive('desired')
    test.repository.control = {
      ...test.repository.control,
      desiredState: 'disabled',
      tombstoned: false,
      statusReason: 'user_disabled',
    }
    test.repository.consent = null
    test.repository.recoverable = [{
      runId: 'run-revoked',
      runState: 'applied_unverified',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-revoked',
          state: 'committed',
          journalVersion: 5,
          attemptCount: 1,
          idempotent: true,
          beforeFingerprint: null,
          desiredFingerprint: 'desired',
          postEffectFingerprint: 'desired',
          compensationPrecondition: null,
          receiptJson: '{}',
          failureCode: null,
          failureStage: null,
          updatedAt: T0.toISOString(),
        },
      }],
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns()

    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'consent_no_longer_covers_plan' })
    expect(test.adapter.verify).not.toHaveBeenCalled()
  })

  it('cancels stale host verification after the Installation was disconnected', async () => {
    const test = harness()
    const plan = await preview(test)
    test.repository.control = { ...test.repository.control, desiredState: 'removed', tombstoned: true }
    test.repository.recoverable = [{
      runId: 'run-superseded',
      runState: 'applied_unverified',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-superseded',
          state: 'committed',
          journalVersion: 5,
          attemptCount: 1,
          idempotent: true,
          beforeFingerprint: null,
          desiredFingerprint: 'desired',
          postEffectFingerprint: 'desired',
          compensationPrecondition: null,
          receiptJson: '{}',
          failureCode: null,
          failureStage: null,
          updatedAt: T0.toISOString(),
        },
      }],
    }]

    const [result] = await test.coordinator.recoverNonTerminalRuns()

    expect(result).toEqual({ status: 'paused', reason: 'removed' })
    expect(test.repository.calls).toContain('run:cancelled')
    expect(test.apply).not.toHaveBeenCalled()
    expect(test.adapter.verify).not.toHaveBeenCalled()
    expect(test.repository.calls.some(call => call.startsWith('installation:'))).toBe(false)
  })

  it('fails closed when recovery cannot prove the exact live fingerprint', async () => {
    const test = harness()
    const plan = await preview(test)
    test.repository.control = { ...test.repository.control, desiredState: 'managed' }
    test.adapter.readBack = vi.fn(async () => ({
      operationId: 'write-mcp',
      observed: true,
      matchesDesired: false,
      diagnostics: ['host did not expose a stable fingerprint'],
    }))
    test.repository.recoverable = [{
      runId: 'run-unknown',
      runState: 'needs_recovery',
      installation: { ...installation, desiredState: 'managed' },
      consentId: consent.id,
      desiredCapability: 3,
      preparedPlan: plan,
      mutations: [{
        operationId: 'write-mcp',
        mutationDomain: 'local_macos:file:/tmp/tidemind/config.json:document',
        plannedMutation: plan.adapterPlan.mutations[0],
        journal: {
          id: 'mutation-unknown',
          state: 'needs_recovery',
          journalVersion: 2,
          attemptCount: 1,
          idempotent: true,
          beforeFingerprint: 'before',
          desiredFingerprint: 'desired',
          postEffectFingerprint: null,
          compensationPrecondition: null,
          receiptJson: null,
          failureCode: 'read_back_failed',
          failureStage: 'read_back',
          updatedAt: T0.toISOString(),
        },
      }],
    }]
    const [result] = await test.coordinator.recoverNonTerminalRuns()
    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'ambiguous_live_state' })
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('rejects an Adapter plan changed after the consent preview', async () => {
    const test = harness()
    const plan = await preview(test)
    const changed = {
      ...plan,
      adapterPlan: {
        ...plan.adapterPlan,
        mutations: [{ ...plan.adapterPlan.mutations[0], physicalTarget: '/tmp/tidemind/other.json' }],
      },
    }
    await expect(test.coordinator.applyPrepared({
      installation,
      preparedPlan: changed,
      consentId: consent.id,
      desiredCapability: 3,
    })).rejects.toThrow(/Adapter plan was modified/)
    expect(test.apply).not.toHaveBeenCalled()
  })

  it('passes exact Ledger baselines to disconnect planning', async () => {
    const test = harness()
    test.repository.baselines = [{
      componentKey: 'memory_tools',
      physicalTarget: '/tmp/tidemind/config.json',
      ownershipKey: 'mcpServers.tidemind',
      ownedFragmentHash: 'desired',
    }]
    const plan = await test.coordinator.preview({
      installation: { ...installation, desiredState: 'managed' },
      operation: 'disconnect',
      componentKeys: ['memory_tools'],
      desiredCapability: 0,
    })
    expect(plan.adapterPlan.mutations).toHaveLength(1)
  })

  it('commits a disconnect only after the owned selector is proven absent', async () => {
    const test = harness()
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'managed' }
    test.repository.baselines = [{
      componentKey: 'memory_tools',
      physicalTarget: '/tmp/tidemind/config.json',
      ownershipKey: 'mcpServers.tidemind',
      ownedFragmentHash: 'desired',
    }]
    const plan = await test.coordinator.preview({
      installation: { ...installation, desiredState: 'managed' },
      operation: 'disconnect',
      componentKeys: ['memory_tools'],
      desiredCapability: 0,
    })
    const result = await test.coordinator.applyPrepared({
      installation: { ...installation, desiredState: 'managed' },
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 0,
    })
    expect(result).toMatchObject({ status: 'committed' })
    expect(test.repository.calls).toContain('verification:verified')
  })

  it('allows an explicitly approved disconnect while management is paused', async () => {
    const test = harness()
    test.setLive('desired')
    test.repository.control = { ...test.repository.control, desiredState: 'disabled' }
    test.repository.baselines = [{
      componentKey: 'memory_tools',
      physicalTarget: '/tmp/tidemind/config.json',
      ownershipKey: 'mcpServers.tidemind',
      ownedFragmentHash: 'desired',
    }]
    const pausedInstallation = { ...installation, desiredState: 'disabled' as const }
    const plan = await test.coordinator.preview({
      installation: pausedInstallation,
      operation: 'disconnect',
      componentKeys: ['memory_tools'],
      desiredCapability: 0,
    })
    const result = await test.coordinator.applyPrepared({
      installation: pausedInstallation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 0,
    })
    expect(result).toMatchObject({ status: 'committed' })
    expect(test.apply).toHaveBeenCalledOnce()
  })

  it('keeps a safely applied projection awaiting host verification without calling it failed', async () => {
    const test = harness()
    test.adapter.verify = vi.fn(async () => [{
      componentKey: 'memory_tools',
      status: 'unverified',
      verifiedCapability: null,
      invalidationKeys: ['reload_generation'],
      diagnostics: ['host_not_running'],
    }])
    const plan = await preview(test)
    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })
    expect(result).toMatchObject({ status: 'awaiting_verification' })
    expect(test.repository.calls).toContain('run:applied_unverified')
    expect(test.repository.calls).not.toContain('run:needs_recovery')
    expect(test.repository.calls.at(-1)).toBe('installation:idle')
  })

  it('uses the legacy document fence for every selector in the same physical file', () => {
    const base = {
      operationId: 'one',
      componentKey: 'memory_tools' as const,
      operation: 'create' as const,
      domainKind: 'file_fragment' as const,
      physicalTarget: '/tmp/tidemind/config.json',
      ownershipKey: 'mcpServers.tidemind',
      selectorSchemaVersion: 1,
      risk: 'low' as const,
      reload: 'reload' as const,
      idempotent: true,
    }
    const first = physicalMutationDomain(installation, base)
    const second = physicalMutationDomain(installation, {
      ...base,
      operationId: 'two',
      ownershipKey: 'mcpServers.another',
    })
    expect(first).toBe(second)
    expect(first).toBe(buildLegacyMutationDomain({
      adapterId: 'cursor',
      target: base.physicalTarget,
      selector: 'document',
    }))
  })

  it('does not report success when the physical writer fence cannot be released', async () => {
    const test = harness()
    test.repository.releaseThrows = true
    const plan = await preview(test)
    const result = await test.coordinator.applyPrepared({
      installation,
      preparedPlan: plan,
      consentId: consent.id,
      desiredCapability: 3,
    })
    expect(result).toMatchObject({ status: 'needs_recovery', reason: 'writer_fence_release_failed' })
    expect(test.repository.calls).not.toContain('adapter:verify')
  })
})
