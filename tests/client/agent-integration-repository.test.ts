import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import Database from 'better-sqlite3'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { ensureSchema } from '../../src/db/schema.js'

const T0 = '2026-08-25T00:00:00.000Z'

function setup(): { db: Database.Database; repository: AgentIntegrationRepository } {
  const db = new Database(':memory:')
  ensureSchema(db)
  return { db, repository: new AgentIntegrationRepository(db) }
}

function discover(repository: AgentIntegrationRepository, id: string, installKey = id): void {
  repository.upsertDiscoveredInstallation({
    id,
    family: 'cursor',
    hostVariant: 'cursor-desktop',
    installKey,
    distributionId: 'com.todesktop.230313mzl4w4u92',
    provenance: 'bundle_id',
    displayName: 'Cursor',
    agentId: `agent-${id}`,
    supportedCapability: 4,
    lastDetectedAt: T0,
  })
}

function consent(repository: AgentIntegrationRepository, installationId: string, id: string): void {
  repository.createConsent({
    id,
    installationId,
    policyVersion: '1',
    allowedComponents: ['instruction'],
    allowedScopes: ['/tmp/agents'],
    normalizedTargets: ['/tmp/agents/tidemind'],
    selectorSchemaVersion: '1',
    selectorResolution: { key: 'tidemind' },
    executableRealpaths: [],
    commandCategories: ['file_write'],
    maximumRisk: 'low',
    confirmedAt: T0,
  })
}

function artifact(repository: AgentIntegrationRepository, id: string): void {
  repository.createManagedArtifact({
    id,
    componentType: 'skill',
    targetPath: `/tmp/agents/${id}`,
    ownershipKey: 'tidemind',
    mutationDomain: `local_macos:file:/tmp/agents/${id}:tidemind`,
    projectionVersion: '1',
    selectorSchemaVersion: '1',
    ownedFragmentHash: `desired-${id}`,
    desiredFragmentHash: `desired-${id}`,
  }, T0)
}

function componentAndConsumer(
  repository: AgentIntegrationRepository,
  installationId: string,
  artifactId: string,
  consentId: string,
): void {
  repository.upsertComponent({
    installationId,
    componentKey: 'instruction',
    desiredState: 'managed',
    desiredCapability: 1,
    deliveryMode: 'managed',
    artifactId,
    visibilityState: 'shared_visible',
    consentEnvelopeId: consentId,
  }, T0)
  repository.addArtifactConsumer({
    artifactId,
    installationId,
    componentKey: 'instruction',
    requiredCapability: 1,
    discoverReachability: 'shared_visible',
    consentEnvelopeId: consentId,
    ownershipFingerprint: `desired-${artifactId}`,
    addedAt: T0,
  })
}

describe('AgentIntegrationRepository', () => {
  it('deduplicates canonical identity and never resurrects a tombstoned Installation', () => {
    const { db, repository } = setup()
    discover(repository, 'i1', 'cursor:default')
    repository.setInstallationIntent('i1', 'removed', '2026-08-25T00:01:00.000Z', 'user_disconnect')
    db.prepare(`
      UPDATE agent_installations
      SET detected_version = '1.0.0', status_reason = 'disconnect_verified'
      WHERE id = 'i1'
    `).run()

    const observed = repository.upsertDiscoveredInstallation({
      id: 'i2',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'bundle_id',
      displayName: 'Cursor Updated',
      detectedVersion: '2.0.0',
      supportedCapability: 4,
      lastDetectedAt: '2026-08-25T01:00:00.000Z',
    })

    expect(observed.id).toBe('i1')
    expect(observed.display_name).toBe('Cursor Updated')
    expect(observed.desired_state).toBe('removed')
    expect(observed.tombstoned_at).toBe('2026-08-25T00:01:00.000Z')
    expect(observed.status_reason).toBe('disconnect_verified')
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_installations').get())
      .toEqual({ count: 1 })
    expect(() => repository.setInstallationIntent('i1', 'managed', T0)).toThrow(/cannot be reactivated/)
  })

  it('resolves legacy aliases and exposes removed/tombstone suppression to legacy writers', () => {
    const { repository } = setup()
    discover(repository, 'i1')
    repository.addAlias({
      id: 'alias-1',
      aliasType: 'legacy_agent_id',
      aliasValue: 'legacy-cursor',
      canonicalAgentId: 'agent-i1',
      installationId: 'i1',
      reason: 'legacy_profile',
      createdAt: T0,
    })
    expect(repository.isAgentIdentitySuppressed('legacy-cursor')).toBe(false)
    repository.setInstallationIntent('i1', 'removed', '2026-08-25T00:01:00.000Z', 'user_disconnect')
    expect(repository.getInstallationByAgentIdOrAlias('legacy-cursor')?.id).toBe('i1')
    expect(repository.isAgentIdentitySuppressed('legacy-cursor')).toBe(true)
  })

  it('claims writer fences with protocol, generation, lease and epoch CAS', () => {
    const { db, repository } = setup()
    db.prepare(`
      UPDATE metadata SET value = '2' WHERE key = 'agent_integration_minimum_writer_protocol'
    `).run()
    const base = {
      mutationDomain: 'local_macos:file:/tmp/config:tidemind',
      writerGeneration: 3,
      nowMs: 1_000,
      leaseDurationMs: 5_000,
      nowIso: T0,
    }

    expect(repository.claimWriterFence({
      ...base,
      writerProtocol: 1,
      ownerInstanceId: 'old-writer',
    })).toEqual({ acquired: false, reason: 'protocol_too_old' })

    const first = repository.claimWriterFence({
      ...base,
      writerProtocol: 2,
      ownerInstanceId: 'writer-a',
    })
    expect(first).toMatchObject({ acquired: true, fence: { epoch: 1, writer_generation: 3 } })
    expect(repository.claimWriterFence({
      ...base,
      writerProtocol: 2,
      writerGeneration: 4,
      ownerInstanceId: 'writer-b',
      nowMs: 2_000,
    })).toMatchObject({ acquired: false, reason: 'lease_held' })
    expect(repository.renewWriterFence({
      mutationDomain: base.mutationDomain,
      writerProtocol: 2,
      ownerInstanceId: 'writer-a',
      epoch: 1,
      nowMs: 2_000,
      leaseDurationMs: 5_000,
      nowIso: T0,
    })).toBe(true)
    expect(repository.claimWriterFence({
      ...base,
      writerProtocol: 2,
      writerGeneration: 2,
      ownerInstanceId: 'writer-b',
      nowMs: 8_000,
    })).toMatchObject({ acquired: false, reason: 'generation_too_old' })
    expect(repository.claimWriterFence({
      ...base,
      writerProtocol: 2,
      writerGeneration: 4,
      ownerInstanceId: 'writer-b',
      nowMs: 8_000,
    })).toMatchObject({ acquired: true, fence: { epoch: 2, writer_generation: 4 } })
    expect(repository.releaseWriterFence({
      mutationDomain: base.mutationDomain,
      ownerInstanceId: 'writer-a',
      epoch: 1,
      nowIso: T0,
    })).toBe(false)
  })

  it('counts only healthy-to-missing edges and circuit-breaks the second episode in 24 hours', () => {
    const { db, repository } = setup()
    discover(repository, 'i1')
    consent(repository, 'i1', 'consent-i1')
    artifact(repository, 'a1')
    componentAndConsumer(repository, 'i1', 'a1', 'consent-i1')
    repository.setInstallationIntent('i1', 'managed', T0)

    expect(repository.beginMissingEpisode({
      artifactId: 'a1',
      episodeId: 'episode-1',
      observedAt: T0,
    })).toEqual({ changed: true, eventCount: 1, shouldAutoRestore: true, circuitBroken: false })
    expect(repository.beginMissingEpisode({
      artifactId: 'a1',
      episodeId: 'duplicate-watcher',
      observedAt: '2026-08-25T00:00:01.000Z',
    })).toEqual({ changed: false, eventCount: 1, shouldAutoRestore: true, circuitBroken: false })
    expect(db.prepare(`
      SELECT reconcile_state, status_reason, verified_capability
      FROM agent_installations WHERE id = 'i1'
    `).get()).toEqual({
      reconcile_state: 'needs_recovery',
      status_reason: 'repairing',
      verified_capability: 0,
    })
    expect(repository.markArtifactHealthyAfterReadback('a1', '2026-08-25T00:01:00.000Z')).toBe(true)
    expect(repository.beginMissingEpisode({
      artifactId: 'a1',
      episodeId: 'episode-2',
      observedAt: '2026-08-25T01:00:00.000Z',
    })).toEqual({ changed: true, eventCount: 2, shouldAutoRestore: false, circuitBroken: true })

    expect(db.prepare(`
      SELECT state, missing_event_count, paused_reason FROM managed_artifacts WHERE id = 'a1'
    `).get()).toEqual({
      state: 'paused',
      missing_event_count: 2,
      paused_reason: 'missing_circuit_breaker',
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_integration_events WHERE artifact_id = 'a1'
    `).get()).toEqual({ count: 2 })
    expect(db.prepare(`
      SELECT reconcile_state, status_reason, verified_capability
      FROM agent_installations WHERE id = 'i1'
    `).get()).toEqual({
      reconcile_state: 'paused',
      status_reason: 'circuit_breaker',
      verified_capability: 0,
    })
    expect(db.prepare(`
      SELECT verification_status FROM installation_components
      WHERE installation_id = 'i1' AND component_key = 'instruction'
    `).get()).toEqual({ verification_status: 'stale' })

    expect(repository.resetInstallationArtifactCircuits('i1', '2026-08-25T01:05:00.000Z')).toBe(1)
    expect(db.prepare(`SELECT state, missing_event_count FROM managed_artifacts WHERE id = 'a1'`).get())
      .toEqual({ state: 'healthy', missing_event_count: 0 })
    expect(db.prepare(`SELECT reconcile_state, status_reason FROM agent_installations WHERE id = 'i1'`).get())
      .toEqual({ reconcile_state: 'idle', status_reason: 'verification_stale' })
  })

  it('resets a shared Artifact circuit for every active consumer atomically', () => {
    const { db, repository } = setup()
    for (const id of ['i1', 'i2']) {
      discover(repository, id)
      consent(repository, id, `consent-${id}`)
      repository.setInstallationIntent(id, 'managed', T0)
    }
    artifact(repository, 'shared')
    componentAndConsumer(repository, 'i1', 'shared', 'consent-i1')
    componentAndConsumer(repository, 'i2', 'shared', 'consent-i2')
    repository.beginMissingEpisode({ artifactId: 'shared', episodeId: 'first', observedAt: T0 })
    repository.markArtifactHealthyAfterReadback('shared', '2026-08-25T00:01:00.000Z')
    repository.beginMissingEpisode({
      artifactId: 'shared', episodeId: 'second', observedAt: '2026-08-25T01:00:00.000Z',
    })

    expect(repository.resetInstallationArtifactCircuits('i1', '2026-08-25T01:05:00.000Z')).toBe(1)
    expect(db.prepare(`
      SELECT id, reconcile_state, status_reason FROM agent_installations ORDER BY id
    `).all()).toEqual([
      { id: 'i1', reconcile_state: 'idle', status_reason: 'verification_stale' },
      { id: 'i2', reconcile_state: 'idle', status_reason: 'verification_stale' },
    ])
    expect(db.prepare(`
      SELECT installation_id FROM agent_integration_events
      WHERE kind = 'auto_repair_circuit_reset' ORDER BY installation_id
    `).all()).toEqual([{ installation_id: 'i1' }, { installation_id: 'i2' }])
  })

  it('rejects a shared circuit reset when the confirmed consumer scope changes', () => {
    const { db, repository } = setup()
    for (const id of ['i1', 'i2']) {
      discover(repository, id)
      consent(repository, id, `consent-${id}`)
      repository.setInstallationIntent(id, 'managed', T0)
    }
    artifact(repository, 'shared')
    componentAndConsumer(repository, 'i1', 'shared', 'consent-i1')
    componentAndConsumer(repository, 'i2', 'shared', 'consent-i2')
    repository.beginMissingEpisode({ artifactId: 'shared', episodeId: 'first', observedAt: T0 })
    repository.markArtifactHealthyAfterReadback('shared', '2026-08-25T00:01:00.000Z')
    repository.beginMissingEpisode({
      artifactId: 'shared', episodeId: 'second', observedAt: '2026-08-25T01:00:00.000Z',
    })
    const confirmedScope = repository.listResettableArtifactCircuitScope('i1')
    db.prepare(`
      UPDATE artifact_consumers
      SET desired_state = 'removed', state = 'removed', tombstoned_at = ?, removed_at = ?, updated_at = ?
      WHERE artifact_id = 'shared' AND installation_id = 'i2'
    `).run('2026-08-25T01:02:00.000Z', '2026-08-25T01:02:00.000Z', '2026-08-25T01:02:00.000Z')

    expect(() => repository.resetInstallationArtifactCircuits(
      'i1',
      '2026-08-25T01:05:00.000Z',
      confirmedScope,
    )).toThrow(/scope changed/)
    expect(db.prepare(`SELECT state FROM managed_artifacts WHERE id = 'shared'`).get())
      .toEqual({ state: 'paused' })
  })

  it('rejects a circuit reset when the initiating Installation is paused after confirmation', () => {
    const { db, repository } = setup()
    discover(repository, 'i1')
    consent(repository, 'i1', 'consent-i1')
    repository.setInstallationIntent('i1', 'managed', T0)
    artifact(repository, 'a1')
    componentAndConsumer(repository, 'i1', 'a1', 'consent-i1')
    repository.beginMissingEpisode({ artifactId: 'a1', episodeId: 'first', observedAt: T0 })
    repository.markArtifactHealthyAfterReadback('a1', '2026-08-25T00:01:00.000Z')
    repository.beginMissingEpisode({
      artifactId: 'a1', episodeId: 'second', observedAt: '2026-08-25T01:00:00.000Z',
    })
    const confirmedScope = repository.listResettableArtifactCircuitScope('i1')
    repository.setInstallationIntent('i1', 'disabled', '2026-08-25T01:02:00.000Z')

    expect(() => repository.resetInstallationArtifactCircuits(
      'i1',
      '2026-08-25T01:05:00.000Z',
      confirmedScope,
    )).toThrow(/control state changed/)
    expect(db.prepare(`SELECT state FROM managed_artifacts WHERE id = 'a1'`).get())
      .toEqual({ state: 'paused' })
  })

  it('does not overwrite a missing shared consumer when another consumer resets the circuit', () => {
    const { db, repository } = setup()
    for (const id of ['i1', 'i2']) {
      discover(repository, id)
      consent(repository, id, `consent-${id}`)
      repository.setInstallationIntent(id, 'managed', T0)
    }
    artifact(repository, 'shared')
    componentAndConsumer(repository, 'i1', 'shared', 'consent-i1')
    componentAndConsumer(repository, 'i2', 'shared', 'consent-i2')
    repository.beginMissingEpisode({ artifactId: 'shared', episodeId: 'first', observedAt: T0 })
    repository.markArtifactHealthyAfterReadback('shared', '2026-08-25T00:01:00.000Z')
    repository.beginMissingEpisode({
      artifactId: 'shared', episodeId: 'second', observedAt: '2026-08-25T01:00:00.000Z',
    })
    repository.markInstallationNotDetected('i2', '2026-08-25T01:01:00.000Z')
    repository.markInstallationNotDetected('i2', '2026-08-25T01:02:00.000Z')

    expect(repository.resetInstallationArtifactCircuits('i1', '2026-08-25T01:05:00.000Z')).toBe(1)
    expect(db.prepare(`
      SELECT id, health_state, reconcile_state, status_reason
      FROM agent_installations ORDER BY id
    `).all()).toEqual([
      { id: 'i1', health_state: 'discovered', reconcile_state: 'idle', status_reason: 'verification_stale' },
      { id: 'i2', health_state: 'absent', reconcile_state: 'paused', status_reason: 'host_uninstalled' },
    ])
  })

  it('marks every unread event for an Installation in one operation', () => {
    const { db, repository } = setup()
    discover(repository, 'i1')
    for (let index = 0; index < 25; index += 1) {
      repository.recordEvent({
        id: `event-${index}`,
        installationId: 'i1',
        kind: 'fixture',
        createdAt: `2026-08-25T00:${String(index).padStart(2, '0')}:00.000Z`,
      })
    }

    expect(repository.markInstallationEventsRead('i1', '2026-08-25T01:00:00.000Z')).toBe(25)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_integration_events WHERE installation_id = 'i1' AND state = 'unread'
    `).get()).toEqual({ count: 0 })
  })

  it('keeps the newest successful scan time when an older scanner finishes later', () => {
    const { repository } = setup()
    repository.setLastSuccessfulScanAt('2026-08-25T02:00:00.000Z')
    repository.setLastSuccessfulScanAt('2026-08-25T01:00:00.000Z')

    expect(repository.getLastSuccessfulScanAt()).toBe('2026-08-25T02:00:00.000Z')
  })

  it('atomically journals and tombstones every consumer before shared Artifact removal', () => {
    const { db, repository } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    consent(repository, 'i1', 'c1')
    consent(repository, 'i2', 'c2')
    artifact(repository, 'a1')
    componentAndConsumer(repository, 'i1', 'a1', 'c1')
    componentAndConsumer(repository, 'i2', 'a1', 'c2')

    repository.prepareSharedArtifactRemoval({
      artifactId: 'a1',
      consumers: [
        { installationId: 'i1', componentKey: 'instruction' },
        { installationId: 'i2', componentKey: 'instruction' },
      ],
      removePhysicalArtifact: true,
      tombstoneReason: 'shared_disconnect_confirmed',
      consentEnvelopeId: 'c1',
      run: {
        id: 'run-1',
        installationId: 'i1',
        operationType: 'disconnect',
        executionPlanHash: 'plan-hash',
        consentEnvelopeId: 'c1',
        recoveryStrategy: 'readback_then_remove',
        createdAt: T0,
      },
      mutations: [{
        id: 'mutation-1',
        runId: 'run-1',
        operationId: 'remove-a1',
        artifactId: 'a1',
        mutationDomain: 'local_macos:file:/tmp/agents/a1:tidemind',
        target: '/tmp/agents/a1',
        idempotencyStrategy: 'fragment_cas',
        readbackStrategy: 'path_absent',
        createdAt: T0,
      }],
      preparedAt: T0,
    })

    expect(db.prepare(`SELECT state FROM managed_artifacts WHERE id = 'a1'`).get())
      .toEqual({ state: 'removal_pending' })
    expect(db.prepare(`
      SELECT installation_id, state, desired_state, tombstoned_at
      FROM artifact_consumers WHERE artifact_id = 'a1' ORDER BY installation_id
    `).all()).toEqual([
      { installation_id: 'i1', state: 'removal_pending', desired_state: 'removal_pending', tombstoned_at: T0 },
      { installation_id: 'i2', state: 'removal_pending', desired_state: 'removal_pending', tombstoned_at: T0 },
    ])
    expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = 'run-1'`).get())
      .toEqual({ state: 'planned' })
    expect(db.prepare(`SELECT state FROM projection_mutations WHERE id = 'mutation-1'`).get())
      .toEqual({ state: 'prepared' })
  })

  it('rolls back the whole disconnect plan when a live shared consumer is omitted', () => {
    const { db, repository } = setup()
    discover(repository, 'i1')
    discover(repository, 'i2')
    consent(repository, 'i1', 'c1')
    consent(repository, 'i2', 'c2')
    artifact(repository, 'a1')
    componentAndConsumer(repository, 'i1', 'a1', 'c1')
    componentAndConsumer(repository, 'i2', 'a1', 'c2')

    expect(() => repository.prepareSharedArtifactRemoval({
      artifactId: 'a1',
      consumers: [{ installationId: 'i1', componentKey: 'instruction' }],
      removePhysicalArtifact: true,
      tombstoneReason: 'incomplete_plan',
      consentEnvelopeId: 'c1',
      run: {
        id: 'run-bad',
        installationId: 'i1',
        operationType: 'disconnect',
        executionPlanHash: 'bad-plan',
        consentEnvelopeId: 'c1',
        recoveryStrategy: 'readback_then_remove',
        createdAt: T0,
      },
      mutations: [{
        id: 'mutation-bad',
        runId: 'run-bad',
        operationId: 'remove-a1-bad',
        artifactId: 'a1',
        mutationDomain: 'local_macos:file:/tmp/agents/a1:tidemind',
        target: '/tmp/agents/a1',
        idempotencyStrategy: 'fragment_cas',
        readbackStrategy: 'path_absent',
        createdAt: T0,
      }],
      preparedAt: T0,
    })).toThrow(/does not include every live consumer/)

    expect(db.prepare(`SELECT state FROM managed_artifacts WHERE id = 'a1'`).get())
      .toEqual({ state: 'healthy' })
    expect(db.prepare(`
      SELECT DISTINCT state FROM artifact_consumers WHERE artifact_id = 'a1'
    `).all()).toEqual([{ state: 'active' }])
    expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
  })

  it('records versioned evidence and atomically marks it stale on invalidation', () => {
    const { db, repository } = setup()
    discover(repository, 'i1')
    repository.upsertComponent({
      installationId: 'i1',
      componentKey: 'memory_tools',
      desiredState: 'managed',
      desiredCapability: 2,
      deliveryMode: 'managed',
    }, T0)
    repository.recordVerificationResult({
      id: 'vr1',
      installationId: 'i1',
      componentKey: 'memory_tools',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos',
      adapterVersion: '1',
      catalogVersion: '1',
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      verificationManifestVersion: '1',
      method: 'host_list',
      identityAssertion: 'agent-i1',
      result: 'verified',
      evidenceHash: 'evidence-hash',
      verifiedAt: T0,
    })
    expect(db.prepare(`
      SELECT verification_status, verification_result_id
      FROM installation_components WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ verification_status: 'verified', verification_result_id: 'vr1' })

    expect(repository.invalidateVerificationResults(
      'i1',
      'memory_tools',
      '2026-08-25T02:00:00.000Z',
      'host_version_changed',
    )).toBe(1)
    expect(db.prepare(`
      SELECT verification_status FROM installation_components
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ verification_status: 'stale' })
    expect(db.prepare(`
      SELECT invalidated_at, invalidation_reason FROM verification_results WHERE id = 'vr1'
    `).get()).toEqual({
      invalidated_at: '2026-08-25T02:00:00.000Z',
      invalidation_reason: 'host_version_changed',
    })
  })

  it('invalidates previously green evidence when the discovered host version changes', () => {
    const { db, repository } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'i1',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      agentId: 'agent-i1',
      detectedVersion: '1.0.0',
      supportedCapability: 4,
      lastDetectedAt: T0,
    })
    repository.upsertComponent({
      installationId: 'i1',
      componentKey: 'memory_tools',
      desiredState: 'managed',
      desiredCapability: 2,
      deliveryMode: 'managed',
    }, T0)
    repository.recordVerificationResult({
      id: 'vr-version-1',
      installationId: 'i1',
      componentKey: 'memory_tools',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos',
      hostVersion: '1.0.0',
      adapterVersion: '1',
      catalogVersion: '1',
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      verificationManifestVersion: '1',
      method: 'host_list',
      identityAssertion: 'agent-i1',
      result: 'verified',
      evidenceHash: 'version-1-evidence',
      verifiedAt: T0,
    })
    db.prepare(`
      UPDATE agent_installations
      SET verified_capability = 4, verification_summary = 'verified', status_reason = 'verified'
      WHERE id = 'i1'
    `).run()

    const changed = repository.upsertDiscoveredInstallation({
      id: 'ignored-new-id',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      detectedVersion: '2.0.0',
      supportedCapability: 4,
      lastDetectedAt: '2026-08-25T03:00:00.000Z',
    })

    expect(changed).toMatchObject({
      id: 'i1',
      detected_version: '2.0.0',
      verified_capability: 0,
      verification_summary: 'stale',
      status_reason: 'verification_stale',
    })
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-version-1'
    `).get()).toEqual({ invalidation_reason: 'host_version_changed' })
    expect(db.prepare(`
      SELECT verification_status FROM installation_components
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ verification_status: 'stale' })
    expect(db.prepare(`
      SELECT kind FROM agent_integration_events WHERE installation_id = 'i1'
    `).all()).toContainEqual({ kind: 'host_version_changed' })
  })

  it('revokes old evidence and consent when an exact component config target changes', () => {
    const { db, repository } = setup()
    const base = {
      family: 'opencode',
      hostVariant: 'opencode-v1-cli',
      installKey: 'opencode:default',
      distributionId: 'cli:opencode-v1-cli',
      provenance: 'npm:opencode-ai',
      displayName: 'OpenCode',
      agentId: 'agent-opencode',
      configRoot: '/tmp/opencode',
      supportedCapability: 4,
    }
    repository.upsertDiscoveredInstallation({
      ...base,
      id: 'opencode-1',
      lastDetectedAt: T0,
      metadata: { componentConfigFiles: { memory_tools: '/tmp/opencode/first.json' } },
    })
    repository.createConsent({
      id: 'consent-old-target',
      installationId: 'opencode-1',
      policyVersion: '1',
      allowedComponents: ['memory_tools'],
      allowedScopes: ['/tmp/opencode'],
      normalizedTargets: ['/tmp/opencode/first.json'],
      selectorSchemaVersion: '1',
      selectorResolution: { key: 'tide-mind' },
      executableRealpaths: [],
      commandCategories: ['file_write'],
      maximumRisk: 'low',
      confirmedAt: T0,
    })
    repository.upsertComponent({
      installationId: 'opencode-1',
      componentKey: 'memory_tools',
      desiredState: 'managed',
      desiredCapability: 2,
      deliveryMode: 'managed',
      consentEnvelopeId: 'consent-old-target',
    }, T0)
    repository.recordVerificationResult({
      id: 'vr-old-target',
      installationId: 'opencode-1',
      componentKey: 'memory_tools',
      family: 'opencode',
      hostVariant: 'opencode-v1-cli',
      runtimeRealm: 'local_macos',
      adapterVersion: '1',
      catalogVersion: '1',
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      verificationManifestVersion: '1',
      method: 'host_list',
      identityAssertion: 'agent-opencode',
      result: 'verified',
      evidenceHash: 'old-target-evidence',
      verifiedAt: T0,
    })
    db.prepare(`
      UPDATE agent_installations
      SET desired_state = 'managed', consent_envelope_id = 'consent-old-target',
          consented_at = ?, verified_capability = 2,
          verification_summary = 'verified', status_reason = 'verified'
      WHERE id = 'opencode-1'
    `).run(T0)

    const changed = repository.upsertDiscoveredInstallation({
      ...base,
      id: 'opencode-1',
      lastDetectedAt: '2026-08-25T04:00:00.000Z',
      metadata: { componentConfigFiles: { memory_tools: '/tmp/opencode/second.json' } },
    })

    expect(changed).toMatchObject({
      consent_envelope_id: null,
      consented_at: null,
      verified_capability: 0,
      verification_summary: 'stale',
      reconcile_state: 'awaiting_consent',
      status_reason: 'awaiting_consent',
    })
    expect(db.prepare(`SELECT status, revoked_at FROM agent_consents WHERE id = 'consent-old-target'`).get())
      .toEqual({ status: 'revoked', revoked_at: '2026-08-25T04:00:00.000Z' })
    expect(db.prepare(`SELECT invalidation_reason FROM verification_results WHERE id = 'vr-old-target'`).get())
      .toEqual({ invalidation_reason: 'host_installation_surface_changed' })
    expect(db.prepare(`
      SELECT kind FROM agent_integration_events
      WHERE installation_id = 'opencode-1' AND kind = 'host_installation_surface_changed'
    `).get()).toEqual({ kind: 'host_installation_surface_changed' })
  })

  it('preserves a higher-priority recovery reason while invalidating version-bound evidence', () => {
    const { db, repository } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'i1',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      agentId: 'agent-i1',
      detectedVersion: '1.0.0',
      supportedCapability: 2,
      lastDetectedAt: T0,
    })
    db.prepare(`
      UPDATE agent_installations
      SET desired_state = 'managed', reconcile_state = 'needs_recovery', status_reason = 'permission'
      WHERE id = 'i1'
    `).run()

    const changed = repository.upsertDiscoveredInstallation({
      id: 'ignored-new-id',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      detectedVersion: '2.0.0',
      supportedCapability: 2,
      lastDetectedAt: '2026-08-25T03:30:00.000Z',
    })

    expect(changed).toMatchObject({
      reconcile_state: 'needs_recovery',
      status_reason: 'permission',
    })
  })

  it('invalidates previously green evidence when a known host version becomes unknown', () => {
    const { db, repository } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'i1',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      agentId: 'agent-i1',
      detectedVersion: '1.0.0',
      supportedCapability: 2,
      lastDetectedAt: T0,
    })
    repository.upsertComponent({
      installationId: 'i1',
      componentKey: 'memory_tools',
      desiredState: 'managed',
      desiredCapability: 2,
      deliveryMode: 'managed',
    }, T0)
    repository.recordVerificationResult({
      id: 'vr-known-version',
      installationId: 'i1',
      componentKey: 'memory_tools',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos',
      hostVersion: '1.0.0',
      adapterVersion: '1',
      catalogVersion: '1',
      projectionVersion: '1',
      verificationManifestVersion: '1',
      method: 'host_list',
      identityAssertion: 'agent-i1',
      result: 'verified',
      evidenceHash: 'known-version-evidence',
      verifiedAt: T0,
    })
    db.prepare(`
      UPDATE agent_installations
      SET verified_capability = 2, verification_summary = 'verified', status_reason = 'verified'
      WHERE id = 'i1'
    `).run()

    const unknown = repository.upsertDiscoveredInstallation({
      id: 'ignored-new-id',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      detectedVersion: null,
      supportedCapability: 2,
      lastDetectedAt: '2026-08-25T04:00:00.000Z',
    })

    expect(unknown).toMatchObject({
      detected_version: null,
      verified_capability: 0,
      verification_summary: 'stale',
      status_reason: 'verification_stale',
    })
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-known-version'
    `).get()).toEqual({ invalidation_reason: 'host_version_changed' })
    expect(db.prepare(`
      SELECT verification_status FROM installation_components
      WHERE installation_id = 'i1' AND component_key = 'memory_tools'
    `).get()).toEqual({ verification_status: 'stale' })
  })

  it('binds green evidence to the current Agent identity and managed Artifact hash', () => {
    const { db, repository } = setup()
    discover(repository, 'i1')
    consent(repository, 'i1', 'consent-1')
    artifact(repository, 'a1')
    componentAndConsumer(repository, 'i1', 'a1', 'consent-1')
    repository.setInstallationIntent('i1', 'managed', T0)
    db.prepare(`
      UPDATE managed_artifacts SET observed_fragment_hash = 'desired-a1' WHERE id = 'a1'
    `).run()
    const evidence = (
      id: string,
      overrides: Partial<Parameters<typeof repository.recordVerificationResult>[0]> = {},
    ) => repository.recordVerificationResult({
      id,
      installationId: 'i1',
      componentKey: 'instruction',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      distributionId: 'com.todesktop.230313mzl4w4u92',
      runtimeRealm: 'local_macos',
      hostVersion: null,
      osVersion: 'os-1',
      adapterVersion: '1',
      catalogVersion: '1',
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      verificationManifestVersion: '1',
      method: 'host_list',
      identityAssertion: 'agent-i1',
      artifactHash: 'desired-a1',
      invalidationKeys: ['artifact_hash', 'agent_identity'],
      result: 'verified',
      evidenceHash: `${id}-host-evidence`,
      verifiedAt: T0,
      ...overrides,
    })
    const freshness = () => repository.refreshVerificationFreshness({
      now: '2026-08-25T05:00:00.000Z',
      osVersion: 'os-1',
      catalogVersion: '1',
      projectionVersion: '1',
      tideMindVersion: '0.2.89',
      adapterVersion: () => '1',
    })

    evidence('vr-artifact')
    expect(freshness()).toBe(0)
    db.prepare(`UPDATE managed_artifacts SET observed_fragment_hash = 'user-drift' WHERE id = 'a1'`).run()
    expect(freshness()).toBe(1)
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-artifact'
    `).get()).toEqual({ invalidation_reason: 'artifact_hash_changed' })

    db.prepare(`UPDATE managed_artifacts SET observed_fragment_hash = 'desired-a1' WHERE id = 'a1'`).run()
    evidence('vr-identity')
    db.prepare(`UPDATE agent_installations SET agent_id = 'agent-replaced' WHERE id = 'i1'`).run()
    expect(freshness()).toBe(1)
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-identity'
    `).get()).toEqual({ invalidation_reason: 'agent_identity_changed' })

    db.prepare(`UPDATE agent_installations SET agent_id = 'agent-i1' WHERE id = 'i1'`).run()
    evidence('vr-null-identity')
    db.prepare(`UPDATE verification_results SET identity_assertion = NULL WHERE id = 'vr-null-identity'`).run()
    expect(freshness()).toBe(1)
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-null-identity'
    `).get()).toEqual({ invalidation_reason: 'agent_identity_changed' })

    evidence('vr-tide-version', {
      tideMindVersion: '0.2.89',
      invalidationKeys: ['tide_mind_version'],
    })
    expect(freshness()).toBe(0)
    expect(repository.refreshVerificationFreshness({
      now: '2026-08-25T05:00:00.000Z',
      osVersion: 'os-1',
      catalogVersion: '1',
      projectionVersion: '1',
      tideMindVersion: '0.2.90',
      adapterVersion: () => '1',
    })).toBe(1)
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-tide-version'
    `).get()).toEqual({ invalidation_reason: 'tide_mind_version_changed' })

    evidence('vr-reload')
    db.prepare(`
      UPDATE verification_results
      SET reload_generation = 'reload-1', invalidation_keys_json = '["reload_generation"]'
      WHERE id = 'vr-reload'
    `).run()
    expect(freshness()).toBe(1)
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-reload'
    `).get()).toEqual({ invalidation_reason: 'reload_generation_changed' })

    evidence('vr-manifest')
    db.prepare(`
      UPDATE verification_results
      SET reload_generation = 'reload-1', invalidation_keys_json = '["reload_generation"]',
          verification_manifest_version = '2'
      WHERE id = 'vr-manifest'
    `).run()
    expect(repository.refreshVerificationFreshness({
      now: '2026-08-25T05:01:00.000Z',
      osVersion: 'os-1',
      catalogVersion: '1',
      projectionVersion: '1',
      adapterVersion: () => '1',
      reloadGeneration: () => 'reload-1',
    })).toBe(1)
    expect(db.prepare(`
      SELECT invalidation_reason FROM verification_results WHERE id = 'vr-manifest'
    `).get()).toEqual({ invalidation_reason: 'verification_manifest_changed' })

    expect(() => repository.recordVerificationResult({
      id: 'vr-invalid',
      installationId: 'i1',
      componentKey: 'instruction',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos',
      adapterVersion: '1',
      catalogVersion: '1',
      verificationManifestVersion: '1',
      method: 'host_list',
      result: 'verified',
      evidenceHash: 'invalid',
      verifiedAt: T0,
    })).toThrow(/identity assertion/)
  })
})
