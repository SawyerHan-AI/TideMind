import { describe, expect, it, vi } from 'vitest'
import type { AgentIntegrationCoordinator, CoordinatorInstallation } from '../../client/electron/agent-integration/coordinator'
import type { IntegrationEvent } from '../../client/electron/agent-integration/events'
import { buildExecutionPlan } from '../../client/electron/agent-integration/planner'
import {
  ManagedAgentReconciler,
  type MissingEpisodeResult,
  type ReconcileManagedArtifactRequest,
  type ReconcilerRepositoryPort,
} from '../../client/electron/agent-integration/reconciler'

const installation: CoordinatorInstallation = {
  id: 'installation-1',
  displayName: 'Kimi Code',
  desiredState: 'managed',
  agentId: 'eb-agent-1',
  identity: {
    runtimeRealm: 'local_macos',
    osUserIdentity: 'uid:501',
    productFamilyId: 'kimi-code',
    hostVariant: 'kimi-code-cli',
    canonicalConfigRoot: '/tmp/tidemind/kimi',
    explicitProfile: '',
    distribution: { distributionId: 'kimi' },
    installKey: 'kimi:default',
  },
}

const prepared = buildExecutionPlan({
  installationId: installation.id,
  installationKey: installation.identity.installKey,
  operation: 'repair',
  componentKeys: ['memory_tools'],
  inspection: {
    catalogId: 'kimi-code-cli',
    detected: true,
    distribution: { distributionId: 'kimi' },
    components: [],
    provenance: ['fixture'],
    diagnostics: [],
  },
  adapterPlan: {
    catalogId: 'kimi-code-cli',
    installationKey: installation.identity.installKey,
    adapterVersion: '1',
    projectionVersion: '1',
    mutations: [],
    requiredUserActions: [],
    diagnostics: [],
  },
  catalogGeneration: 1,
  adapterGeneration: 1,
  projectionGeneration: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
})

class ReconcilerRepository implements ReconcilerRepositoryPort {
  events: IntegrationEvent[] = []
  episode: MissingEpisodeResult = {
    changed: true,
    eventCount: 1,
    shouldAutoRestore: true,
    circuitBroken: false,
  }
  calls: string[] = []
  recordEvent(event: IntegrationEvent) { this.calls.push('event'); this.events.push(event) }
  beginMissingEpisode() { this.calls.push('episode'); return this.episode }
  markArtifactHealthyAfterReadback() { this.calls.push('healthy'); return true }
}

function request(overrides: Partial<ReconcileManagedArtifactRequest> = {}): ReconcileManagedArtifactRequest {
  return {
    artifactId: 'artifact-1',
    installation,
    installationDesiredState: 'managed',
    componentKey: 'memory_tools',
    componentName: '记忆工具',
    desiredCapability: 3,
    consentId: 'consent-1',
    observation: {
      kind: 'exact_missing',
      selectorEmpty: true,
      ownershipBaselineVerified: true,
      containerResolvable: true,
      observedFingerprint: null,
      diagnostics: [],
    },
    ...overrides,
  }
}

function harness(locale?: string | (() => string)) {
  const repository = new ReconcilerRepository()
  const calls = repository.calls
  const preview = vi.fn(async () => { calls.push('preview'); return prepared })
  const applyPrepared = vi.fn(async () => {
    calls.push('apply')
    return { status: 'committed' as const, runId: 'run-1', verification: [] }
  })
  const deliver = vi.fn(async () => { calls.push('notify') })
  let id = 0
  const reconciler = new ManagedAgentReconciler({
    coordinator: { preview, applyPrepared } as Pick<AgentIntegrationCoordinator, 'preview' | 'applyPrepared'>,
    repository,
    notifications: { deliver },
    clock: { now: () => new Date('2026-08-25T00:00:00.000Z') },
    ids: { next: prefix => `${prefix}-${++id}` },
    locale,
  })
  return { reconciler, repository, preview, applyPrepared, deliver, calls }
}

describe('ManagedAgentReconciler', () => {
  it('auto-restores only the first safe missing edge and persists before notifying', async () => {
    const test = harness()
    const result = await test.reconciler.reconcileArtifact(request())

    expect(result).toMatchObject({ status: 'auto_restored' })
    expect(test.calls).toEqual(['episode', 'preview', 'apply', 'healthy', 'event', 'notify'])
    expect(test.repository.events.at(-1)).toMatchObject({ kind: 'artifact_auto_restored' })
    expect(test.deliver).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Tide Mind 已自动恢复'),
      actions: ['view_details', 'disconnect'],
    }))
  })

  it('retries an already-recorded first missing episode without incrementing it', async () => {
    const test = harness()
    test.repository.episode = {
      changed: false,
      eventCount: 1,
      shouldAutoRestore: true,
      circuitBroken: false,
    }
    const result = await test.reconciler.reconcileArtifact(request())
    expect(result).toMatchObject({ status: 'auto_restored' })
    expect(test.calls).toEqual(['episode', 'preview', 'apply', 'healthy', 'event', 'notify'])
  })

  it('notifies after projection read-back even when host recognition remains pending', async () => {
    const test = harness()
    test.applyPrepared.mockImplementationOnce(async () => {
      test.calls.push('apply')
      return {
        status: 'awaiting_verification',
        runId: 'run-pending',
        verification: [],
      }
    })
    const result = await test.reconciler.reconcileArtifact(request())
    expect(result).toEqual({ status: 'awaiting_verification', runId: 'run-pending' })
    expect(test.calls).toEqual(['episode', 'preview', 'apply', 'healthy', 'event', 'notify'])
    expect(test.repository.events.at(-1)).toMatchObject({
      kind: 'artifact_auto_restored',
      payload: expect.objectContaining({ runId: 'run-pending' }),
    })
  })

  it('localizes system notification copy and component names for non-Chinese users', async () => {
    const test = harness('en-US')

    await test.reconciler.reconcileArtifact(request())

    expect(test.deliver).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Agent configuration restored',
      body: expect.stringContaining('MCP memory tools configuration was removed'),
      actions: ['view_details', 'disconnect'],
    }))
  })

  it('reads the current application locale when a background notification is created', async () => {
    let locale = 'en'
    const test = harness(() => locale)
    locale = 'ja'

    await test.reconciler.reconcileArtifact(request())

    expect(test.deliver).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Agent 設定を自動復元しました',
      body: expect.stringContaining('MCP メモリーツール'),
    }))
  })

  it('circuit-breaks the second episode without planning or applying', async () => {
    const test = harness()
    test.repository.episode = {
      changed: true,
      eventCount: 2,
      shouldAutoRestore: false,
      circuitBroken: true,
    }
    const result = await test.reconciler.reconcileArtifact(request())

    expect(result).toEqual({ status: 'paused', reason: 'circuit_breaker' })
    expect(test.preview).not.toHaveBeenCalled()
    expect(test.applyPrepared).not.toHaveBeenCalled()
    expect(test.repository.events.at(-1)).toMatchObject({ kind: 'auto_repair_circuit_broken' })
  })

  it('fails closed on drift or an occupied selector', async () => {
    const drift = harness()
    expect(await drift.reconciler.reconcileArtifact(request({
      observation: {
        kind: 'drifted',
        selectorEmpty: false,
        ownershipBaselineVerified: true,
        containerResolvable: true,
        observedFingerprint: 'user-edit',
        diagnostics: ['fragment changed'],
      },
    }))).toEqual({ status: 'needs_attention', reason: 'drifted' })
    expect(drift.repository.calls).not.toContain('episode')

    const occupied = harness()
    expect(await occupied.reconciler.reconcileArtifact(request({
      observation: {
        kind: 'exact_missing',
        selectorEmpty: false,
        ownershipBaselineVerified: true,
        containerResolvable: true,
        observedFingerprint: 'foreign-selector',
        diagnostics: [],
      },
    }))).toEqual({ status: 'needs_attention', reason: 'missing_not_safe_to_restore' })
    expect(occupied.applyPrepared).not.toHaveBeenCalled()
  })

  it('does not repair disabled or removed Installations', async () => {
    for (const state of ['disabled', 'removed'] as const) {
      const test = harness()
      expect(await test.reconciler.reconcileArtifact(request({ installationDesiredState: state })))
        .toEqual({ status: 'paused', reason: state })
      expect(test.repository.calls).toEqual([])
    }
  })

  it('closes a prior missing episode after a healthy read-back', async () => {
    const test = harness()
    expect(await test.reconciler.reconcileArtifact(request({
      observation: {
        kind: 'healthy',
        selectorEmpty: false,
        ownershipBaselineVerified: true,
        containerResolvable: true,
        observedFingerprint: 'desired',
        diagnostics: [],
      },
    }))).toEqual({ status: 'healthy' })
    expect(test.repository.calls).toEqual(['healthy'])
    expect(test.preview).not.toHaveBeenCalled()
  })
})
