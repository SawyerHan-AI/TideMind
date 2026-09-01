import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureSchema } from '../../src/db/schema.js'
import {
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
} from '../../client/electron/agent-integration/discovery.js'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository.js'
import { AgentIntegrationService } from '../../client/electron/agent-integration/service.js'
import type { PreparedCoordinatorPlan } from '../../client/electron/agent-integration/planner.js'
import type {
  ApplyPreparedRequest,
  PreviewRequest,
} from '../../client/electron/agent-integration/coordinator.js'

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _parameter: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

const T0 = '2026-08-25T00:00:00.000Z'

function setup(
  enabledCatalogIds?: readonly [],
  homeDir = '/Users/alice',
  afterDisconnect?: () => Promise<void>,
) {
  const db = new Database(':memory:')
  ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  repository.upsertDiscoveredInstallation({
    id: 'installation-1',
    family: 'cursor',
    hostVariant: 'cursor-desktop',
    installKey: 'cursor:default',
    provenance: 'test',
    osUserIdentity: '501',
    displayName: 'Cursor',
    configRoot: '/Users/alice/.cursor',
    executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
    agentId: 'eb_test',
    supportedCapability: 4,
    lastDetectedAt: T0,
  })
  const preview = vi.fn(async (request: PreviewRequest) => plan(request))
  const applyPrepared = vi.fn(async (request: ApplyPreparedRequest) => {
    if (request.applyTaskBinding) {
      repository.createReconcileRun({
        id: 'run-1',
        installationId: request.installation.id,
        operationType: 'connect',
        executionPlanHash: request.preparedPlan.executionPlanHash,
        recoveryStrategy: 'resume',
        createdAt: T0,
      })
      db.prepare(`
        UPDATE agent_integration_apply_task_items SET run_id = ?
        WHERE task_id = ? AND installation_id = ? AND execution_plan_hash = ?
      `).run(
        'run-1',
        request.applyTaskBinding.taskId,
        request.applyTaskBinding.installationId,
        request.applyTaskBinding.executionPlanHash,
      )
      repository.transitionRunState('run-1', 'planned', 'committed', T0)
    }
    return {
      status: 'committed' as const,
      runId: 'run-1',
      verification: [],
    }
  })
  const service = new AgentIntegrationService({
    repository,
    scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
    execution: { preview, applyPrepared },
    now: () => new Date(T0),
    consentId: () => 'consent-1',
    homeDir,
    enabledCatalogIds,
    afterDisconnect,
  })
  return { db, repository, service, preview, applyPrepared }
}

function listAllApplyTasks(service: AgentIntegrationService, limit = 1) {
  const tasks: ReturnType<AgentIntegrationService['listApplyTasks']>['tasks'] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = service.listApplyTasks({ limit, ...(cursor ? { cursor } : {}) })
    tasks.push(...page.tasks)
    cursor = page.nextCursor ?? undefined
    pages += 1
    if (pages > 20_000) throw new Error('task feed pagination did not terminate')
  } while (cursor)
  return tasks
}

function plan(request: PreviewRequest): PreparedCoordinatorPlan {
  const disconnect = request.operation === 'disconnect'
  const plannedMutation = {
    operationId: 'operation-1',
    componentKey: 'memory_tools' as const,
    operation: disconnect ? 'remove' as const : 'create' as const,
    domainKind: 'file_fragment' as const,
    physicalTarget: '/Users/alice/.cursor/mcp.json',
    ownershipKey: 'mcpServers.tidemind-eb_test',
    selectorSchemaVersion: 1,
    risk: 'low' as const,
    reload: 'new_session' as const,
    ...(disconnect ? { preconditionHash: 'desired' } : { desiredFragmentHash: 'desired' }),
    idempotent: true,
  }
  const mutation = {
    id: 'mutation-1',
    componentKey: 'memory_tools' as const,
    artifactKey: 'cursor:memory',
    action: disconnect ? 'remove' as const : 'create' as const,
    targetPath: '/Users/alice/.cursor/mcp.json',
    ownershipSelector: 'mcpServers.tidemind-eb_test',
    selectorSchemaVersion: 1,
    risk: 'low' as const,
    commandCategory: 'file_write' as const,
    containerPreconditionHash: null,
    desiredFragmentHash: disconnect ? null : 'desired',
    reversible: true,
  }
  return {
    operation: request.operation,
    componentKeys: request.componentKeys,
    inspection: {
      catalogId: 'cursor-desktop',
      detected: true,
      distribution: {},
      components: [],
      provenance: [],
      diagnostics: [],
    },
    adapterPlan: {
      catalogId: 'cursor-desktop',
      installationKey: 'cursor:default',
      adapterVersion: '1',
      projectionVersion: '1',
      mutations: [plannedMutation],
      requiredUserActions: [],
      diagnostics: ['/Users/alice/private/config was inspected; token=should-not-leak'],
    },
    adapterPlanHash: 'adapter-hash',
    executionPlan: {
    installationId: 'installation-1',
    operation: request.operation,
    componentKeys: [...request.componentKeys],
      catalogVersion: 1,
      adapterVersion: 1,
      projectionVersion: 1,
      createdAt: T0,
      mutations: [mutation],
    },
    executionPlanHash: 'execution-hash',
  }
}

describe('AgentIntegrationService', () => {
  it('restores exact component config files from persisted discovery metadata for Adapter preview', async () => {
    const { repository, service, preview } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'installation-1',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'test',
      osUserIdentity: '501',
      displayName: 'Cursor',
      configRoot: '/Users/alice/.cursor',
      executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
      agentId: 'eb_test',
      supportedCapability: 4,
      lastDetectedAt: '2026-08-25T00:01:00.000Z',
      metadata: {
        componentConfigFiles: { memory_tools: '/Users/alice/.cursor/custom-mcp.json' },
      },
    })

    await service.previewConnect(['installation-1'])
    expect(preview.mock.calls[0][0].installation.identity.componentConfigFiles).toEqual({
      memory_tools: '/Users/alice/.cursor/custom-mcp.json',
    })
  })

  it('fails closed when persisted component config metadata escapes the Installation root', async () => {
    const { repository, service, preview } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'installation-1',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:default',
      provenance: 'test',
      osUserIdentity: '501',
      displayName: 'Cursor',
      configRoot: '/Users/alice/.cursor',
      executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
      agentId: 'eb_test',
      supportedCapability: 4,
      lastDetectedAt: '2026-08-25T00:01:00.000Z',
      metadata: {
        componentConfigFiles: { memory_tools: '/Users/alice/outside.json' },
      },
    })

    await expect(service.previewConnect(['installation-1'])).rejects.toThrow(/outside the Installation config root/)
    expect(preview).not.toHaveBeenCalled()
  })

  it('returns user-facing Installation facts without absolute paths or event payloads', () => {
    const { repository, service } = setup()
    repository.recordEvent({
      id: 'event-1',
      installationId: 'installation-1',
      kind: 'artifact_missing',
      payload: { secretPath: '/Users/alice/private/token.json', token: 'secret' },
      createdAt: T0,
    })

    const snapshot = service.snapshot()
    expect(snapshot.installations[0]).toMatchObject({
      id: 'installation-1',
      familyId: 'cursor',
      statusGroup: 'awaiting_connection',
      accessLevel: 'unconnected',
    })
    const detail = service.detail('installation-1')
    expect(detail.configRootLabel).toBe('~/.cursor')
    expect(detail.events[0]).not.toHaveProperty('payload')
    expect(JSON.stringify(detail)).not.toContain('/Users/alice')
    expect(detail).not.toHaveProperty('technical')

    const technical = service.detail('installation-1', true)
    expect(technical.technical?.installKey).toMatch(/^installation:[a-f0-9]{16}$/u)
    expect(JSON.stringify(technical)).not.toContain('/Users/alice')
  })

  it('exposes detect-only Installations as non-manageable and rejects a write preview', async () => {
    const { service } = setup([])
    expect(service.snapshot()).toMatchObject({
      summary: { awaitingConnectionCount: 0 },
      installations: [{
        manageable: false,
        statusGroup: 'disconnected',
        statusReason: 'detect_only',
      }],
    })
    expect(service.supportCatalog().find(product => product.id === 'cursor')?.variants[0]).toMatchObject({
      maturity: 'detectable',
      maximumAccessLevel: 'unconnected',
    })
    await expect(service.previewConnect(['installation-1'])).rejects.toThrow(/not enabled/)
  })

  it('preserves OpenClaw CLI eligibility across list, detail, and preview without creating write authority', async () => {
    const { db, repository } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'openclaw-installation',
      family: 'openclaw',
      hostVariant: 'openclaw-local',
      installKey: 'openclaw:default',
      provenance: 'npm_metadata:@openclaw/cli',
      osUserIdentity: '501',
      displayName: 'OpenClaw',
      configRoot: '/Users/alice/.openclaw',
      executablePath: '/Users/alice/.local/bin/openclaw',
      agentId: 'eb_openclaw',
      supportedCapability: 4,
      lastDetectedAt: T0,
      metadata: {
        distribution: {
          distributionId: 'cli:openclaw-local',
          executableRealpath: '/Users/alice/.local/bin/openclaw',
          packageProvenance: 'npm_metadata:openclaw',
          capabilityFingerprint: 'cli-surface:openclaw-local',
        },
        managementEligibility: {
          schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
          eligible: false,
          reason: 'executable_proof_too_large',
          executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES + 1,
          proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
        },
      },
    })
    repository.upsertDiscoveredInstallation({
      id: 'openclaw-metadata-unavailable',
      family: 'openclaw',
      hostVariant: 'openclaw-local',
      installKey: 'openclaw:secondary',
      provenance: 'npm_metadata:openclaw',
      osUserIdentity: '501',
      displayName: 'OpenClaw secondary',
      configRoot: '/Users/alice/.openclaw-secondary',
      executablePath: '/Users/alice/.local/bin/openclaw-secondary',
      agentId: 'eb_openclaw_secondary',
      supportedCapability: 4,
      lastDetectedAt: T0,
      metadata: {
        distribution: {
          distributionId: 'cli:openclaw-local',
          executableRealpath: '/Users/alice/.local/bin/openclaw-secondary',
          packageProvenance: 'npm_metadata:openclaw',
          capabilityFingerprint: 'cli-surface:openclaw-local',
        },
      },
    })
    const preview = vi.fn(async (request: PreviewRequest) => plan(request))
    const service = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: {
        preview,
        applyPrepared: async () => ({ status: 'committed', runId: 'unexpected' }),
      },
      now: () => new Date(T0),
      homeDir: '/Users/alice',
      cliManagementProofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    })

    const listed = service.snapshot().installations.find(item => item.id === 'openclaw-installation')
    expect(listed).toMatchObject({
      manageable: false,
      statusGroup: 'disconnected',
      statusReason: 'executable_proof_too_large',
    })
    expect(service.detail('openclaw-installation').installation).toEqual(listed)
    await expect(service.previewConnect(['openclaw-installation']))
      .rejects.toThrow('managed integration is unavailable: executable_proof_too_large')
    const metadataUnavailable = service.snapshot().installations
      .find(item => item.id === 'openclaw-metadata-unavailable')
    expect(metadataUnavailable).toMatchObject({
      manageable: false,
      statusGroup: 'disconnected',
      statusReason: 'executable_metadata_unavailable',
    })
    expect(service.detail('openclaw-metadata-unavailable').installation).toEqual(metadataUnavailable)
    await expect(service.previewConnect(['openclaw-metadata-unavailable']))
      .rejects.toThrow('managed integration is unavailable: executable_metadata_unavailable')
    expect(preview).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM reconcile_runs').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM projection_mutations').get()).toEqual({ count: 0 })
  })

  it('shows ambiguous legacy ownership as needs attention and blocks connect preview', async () => {
    const { repository, service } = setup()
    repository.markLegacyConfirmationRequired('installation-1', T0)
    expect(service.snapshot()).toMatchObject({
      summary: { awaitingConnectionCount: 0, needsAttentionCount: 1 },
      installations: [{
        statusGroup: 'needs_attention',
        statusReason: 'legacy_confirmation_required',
      }],
    })
    await expect(service.previewConnect(['installation-1'])).rejects.toThrow(/ambiguity/)
  })

  it('rejects disconnect for a never-authorized unmanaged Installation', async () => {
    const { service, preview } = setup()

    await expect(service.previewDisconnect('installation-1')).rejects.toThrow(/unconnected Installation/)
    expect(preview).not.toHaveBeenCalled()
  })

  it('freezes a redacted preview and applies exactly the approved Installation set', async () => {
    const { db, service, applyPrepared } = setup()
    const preview = await service.previewConnect(['installation-1'])
    expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.installations[0].targets[0]).toMatchObject({
      targetLabel: '~/.cursor/mcp.json',
      scope: 'user',
      commandCategory: 'file_write',
    })
    expect(preview.installations[0].targets[0]).not.toHaveProperty('selector')
    expect(preview.installations[0].diagnostics[0]).toContain('<local-path>')
    expect(preview.installations[0].diagnostics[0]).toContain('token=<redacted>')
    expect(JSON.stringify(preview)).not.toContain('should-not-leak')

    await expect(service.applyConnect(preview.planHash, ['other-installation']))
      .rejects.toThrow(/differs from preview/)
    const result = await service.applyConnect(preview.planHash, ['installation-1'])
    expect(result.results).toEqual([{ installationId: 'installation-1', status: 'committed', runId: 'run-1' }])
    expect(applyPrepared).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT installation_id, maximum_risk FROM agent_consents').get())
      .toEqual({ installation_id: 'installation-1', maximum_risk: 'low' })
    await expect(service.applyConnect(preview.planHash, ['installation-1']))
      .rejects.toThrow(/unknown or has expired/)
  })

  it('lets each selected Installation omit lifecycle while keeping memory tools managed', async () => {
    const { service, preview } = setup()
    const planPreview = await service.previewConnect(['installation-1'], false, undefined, {
      withoutLifecycleInstallationIds: ['installation-1'],
    })

    expect(preview.mock.calls[0][0]).toMatchObject({
      componentKeys: ['instruction', 'memory_tools'],
      desiredCapability: 3,
    })
    expect(planPreview.installations[0]).toMatchObject({
      componentKeys: ['instruction', 'memory_tools'],
      desiredCapability: 3,
    })
    await expect(service.previewConnect(['installation-1'], false, undefined, {
      withoutLifecycleInstallationIds: ['installation-other'],
    })).rejects.toThrow(/subset/)
  })

  it('publishes durable per-item task progress while apply continues independently of the dialog', async () => {
    const { service } = setup()
    const preview = await service.previewConnect(['installation-1'])
    const progress: Array<{ state: string; resultCount: number; pendingCount: number }> = []
    service.onApplyTaskProgress(task => progress.push({
      state: task.state,
      resultCount: task.results.length,
      pendingCount: task.pendingInstallationIds.length,
    }))

    const started = service.startApplyConnect(preview.planHash, ['installation-1'])
    expect(started).toMatchObject({ state: 'running', results: [], pendingInstallationIds: ['installation-1'] })
    await vi.waitFor(() => expect(service.getApplyTask(started.id)).toMatchObject({
      state: 'completed',
      pendingInstallationIds: [],
      results: [{ installationId: 'installation-1', status: 'committed' }],
    }))
    expect(progress).toEqual(expect.arrayContaining([
      { state: 'running', resultCount: 0, pendingCount: 1 },
      { state: 'running', resultCount: 1, pendingCount: 0 },
      { state: 'completed', resultCount: 1, pendingCount: 0 },
    ]))
  })

  it('reconstructs active and recent apply summaries from coordinator runs after service rebuild', () => {
    const { repository } = setup()
    repository.createReconcileRun({
      id: 'run-completed', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'b'.repeat(64), recoveryStrategy: 'resume', createdAt: T0,
    })
    repository.transitionRunState('run-completed', 'planned', 'committed', '2026-08-25T00:01:00.000Z')
    repository.createReconcileRun({
      id: 'run-active', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'c'.repeat(64), recoveryStrategy: 'resume', createdAt: '2026-08-25T00:02:00.000Z',
    })
    repository.createReconcileRun({
      id: 'run-stale-completed', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'd'.repeat(64), recoveryStrategy: 'resume', createdAt: '2026-08-20T00:00:00.000Z',
    })
    repository.transitionRunState('run-stale-completed', 'planned', 'committed', '2026-08-20T00:01:00.000Z')

    const rebuilt = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: async request => plan(request), applyPrepared: async () => ({ status: 'paused', reason: 'disabled' }) },
      now: () => new Date('2026-08-25T00:03:00.000Z'),
      homeDir: '/Users/alice',
    })
    const tasks = rebuilt.listApplyTasks({ limit: 20 }).tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({
      state: 'running', installationIds: ['installation-1'], pendingInstallationIds: ['installation-1'],
      planHash: 'c'.repeat(64), results: [],
    })
    expect(tasks[1]).toMatchObject({
      state: 'completed', pendingInstallationIds: [],
      results: [{ installationId: 'installation-1', status: 'committed', runId: 'run-completed' }],
    })
    expect(rebuilt.getApplyTask(tasks[0].feedKey!)).toEqual(tasks[0])
  })

  it('persists the whole batch before execution and interrupts B after a crash between A and B', async () => {
    const { db, repository } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'installation-2', family: 'cursor', hostVariant: 'cursor-desktop',
      installKey: 'cursor:second', provenance: 'test', osUserIdentity: '501',
      displayName: 'Cursor Second', configRoot: '/Users/alice/.cursor-second',
      executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor', agentId: 'eb_second',
      supportedCapability: 4, lastDetectedAt: T0,
    })
    repository.createApplyTask({
      id: 'batch-crash-a-b', planHash: 'frozen-batch-plan', startedAt: T0,
      items: [
        { installationId: 'installation-1', executionPlanHash: 'execution-a' },
        { installationId: 'installation-2', executionPlanHash: 'execution-b' },
      ],
    })
    repository.markApplyTaskItemRunning('batch-crash-a-b', 'installation-1', T0)
    repository.createReconcileRun({
      id: 'run-a', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'execution-a', recoveryStrategy: 'resume', createdAt: T0,
    })
    repository.transitionRunState('run-a', 'planned', 'committed', '2026-08-25T00:00:01.000Z')
    db.prepare(`
      UPDATE agent_integration_apply_task_items SET run_id = ?
      WHERE task_id = 'batch-crash-a-b' AND installation_id = 'installation-1'
    `).run('run-a')
    repository.completeApplyTaskItem('batch-crash-a-b', 'installation-1', {
      installationId: 'installation-1', status: 'committed', runId: 'run-a',
    }, '2026-08-25T00:00:01.000Z')

    const rebuilt = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: async request => plan(request), applyPrepared: async () => ({ status: 'committed', runId: 'unexpected' }) },
      now: () => new Date('2026-08-25T00:00:02.000Z'),
      homeDir: '/Users/alice',
    })

    expect(rebuilt.getApplyTask('batch-crash-a-b')).toMatchObject({
      state: 'completed',
      installationIds: ['installation-1', 'installation-2'],
      pendingInstallationIds: [],
      results: [
        { installationId: 'installation-1', status: 'committed', runId: 'run-a' },
        { installationId: 'installation-2', status: 'interrupted' },
      ],
    })
    expect(db.prepare(`
      SELECT installation_id, state FROM agent_integration_apply_task_items
      WHERE task_id = 'batch-crash-a-b' ORDER BY ordinal
    `).all()).toEqual([
      { installation_id: 'installation-1', state: 'terminal' },
      { installation_id: 'installation-2', state: 'interrupted' },
    ])
    await expect(rebuilt.applyConnect('frozen-batch-plan', ['installation-2']))
      .rejects.toThrow(/unknown or has expired/)
  })

  it('folds an in-flight recovered run back into its physical SQLite batch after restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-apply-task-restart-'))
    const db = new Database(path.join(root, 'brain.sqlite'))
    try {
      ensureSchema(db)
      const repository = new AgentIntegrationRepository(db)
      for (const [ordinal, installationId] of ['installation-1', 'installation-2'].entries()) {
        repository.upsertDiscoveredInstallation({
          id: installationId,
          family: 'cursor',
          hostVariant: 'cursor-desktop',
          installKey: `cursor:${installationId}`,
          provenance: 'test',
          osUserIdentity: '501',
          displayName: installationId,
          configRoot: path.join(root, installationId),
          agentId: `eb_${installationId}`,
          supportedCapability: 4,
          lastDetectedAt: `2026-08-25T00:00:0${ordinal}.000Z`,
        })
      }
      repository.createApplyTask({
        id: 'batch-inflight-restart',
        planHash: 'frozen-batch-plan',
        startedAt: '2026-08-25T00:00:00.000Z',
        items: [
          { installationId: 'installation-1', executionPlanHash: 'execution-a' },
          { installationId: 'installation-2', executionPlanHash: 'execution-b' },
        ],
      })
      repository.markApplyTaskItemRunning(
        'batch-inflight-restart',
        'installation-1',
        '2026-08-25T00:00:01.000Z',
      )
      repository.createReconcileRun({
        id: 'run-inflight-a',
        installationId: 'installation-1',
        operationType: 'connect',
        executionPlanHash: 'execution-a',
        recoveryStrategy: 'resume',
        createdAt: '2026-08-24T00:00:01.000Z',
      })
      db.prepare(`
        UPDATE agent_integration_apply_task_items
        SET run_id = ?, updated_at = ?
        WHERE task_id = ? AND installation_id = ?
      `).run(
        'run-inflight-a',
        '2026-08-25T00:00:01.500Z',
        'batch-inflight-restart',
        'installation-1',
      )

      const dependencies = {
        repository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        // Simulate a wall-clock rollback across both application restarts.
        now: () => new Date('2026-08-23T00:00:02.000Z'),
        homeDir: root,
      }
      const rebuilt = new AgentIntegrationService(dependencies)
      expect(rebuilt.listApplyTasks().tasks).toEqual([
        expect.objectContaining({
          id: 'batch-inflight-restart',
          state: 'running',
          installationIds: ['installation-1', 'installation-2'],
          pendingInstallationIds: ['installation-1'],
          results: [expect.objectContaining({
            installationId: 'installation-2',
            status: 'interrupted',
          })],
        }),
      ])

      expect(repository.transitionRunState(
        'run-inflight-a',
        'planned',
        'committed',
        '2026-08-22T00:00:03.000Z',
      )).toBe(true)
      expect(rebuilt.listApplyTasks().tasks).toEqual([
        expect.objectContaining({
          id: 'batch-inflight-restart',
          state: 'completed',
          completedAt: '2026-08-23T00:00:02.000Z',
          pendingInstallationIds: [],
          results: [
            { installationId: 'installation-1', status: 'committed', runId: 'run-inflight-a' },
            expect.objectContaining({ installationId: 'installation-2', status: 'interrupted' }),
          ],
        }),
      ])

      const restartedAgain = new AgentIntegrationService(dependencies)
      expect(restartedAgain.listApplyTasks().tasks).toHaveLength(1)
      expect(restartedAgain.getApplyTask('batch-inflight-restart')).toMatchObject({
        state: 'completed',
        results: [
          { installationId: 'installation-1', status: 'committed', runId: 'run-inflight-a' },
          expect.objectContaining({ installationId: 'installation-2', status: 'interrupted' }),
        ],
      })
      await expect(restartedAgain.applyConnect('frozen-batch-plan', ['installation-2']))
        .rejects.toThrow(/unknown or has expired/)
      expect(db.prepare(`
        SELECT run_id FROM agent_integration_apply_task_items
        WHERE task_id = 'batch-inflight-restart' AND installation_id = 'installation-1'
      `).get()).toEqual({ run_id: 'run-inflight-a' })

      repository.createApplyTask({
        id: 'batch-newer-success',
        planHash: 'newer-success-plan',
        startedAt: '2026-08-26T00:00:00.000Z',
        items: [{ installationId: 'installation-2', executionPlanHash: 'newer-success-execution' }],
      })
      repository.markApplyTaskItemRunning('batch-newer-success', 'installation-2', '2026-08-26T00:00:01.000Z')
      repository.createReconcileRun({
        id: 'run-newer-success', installationId: 'installation-2', operationType: 'connect',
        executionPlanHash: 'newer-success-execution', recoveryStrategy: 'resume',
        createdAt: '2026-08-26T00:00:01.000Z',
      })
      repository.transitionRunState(
        'run-newer-success', 'planned', 'committed', '2026-08-26T00:00:02.000Z',
      )
      db.prepare(`
        UPDATE agent_integration_apply_task_items SET run_id = ?
        WHERE task_id = 'batch-newer-success' AND installation_id = 'installation-2'
      `).run('run-newer-success')
      repository.completeApplyTaskItem('batch-newer-success', 'installation-2', {
        installationId: 'installation-2', status: 'committed', runId: 'run-newer-success',
      }, '2026-08-26T00:00:02.000Z')
      repository.completeApplyTask('batch-newer-success', '2026-08-26T00:00:02.000Z')

      const mixedRestart = new AgentIntegrationService(dependencies)
      expect(listAllApplyTasks(mixedRestart).map(task => task.id)).toEqual([
        'batch-inflight-restart',
        'batch-newer-success',
      ])
      expect(mixedRestart.getApplyTask('batch-inflight-restart').results).toEqual([
        { installationId: 'installation-1', status: 'committed', runId: 'run-inflight-a' },
        expect.objectContaining({ installationId: 'installation-2', status: 'interrupted' }),
      ])
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('never lets a newer successful batch evict an older attention run at a small API limit', () => {
    const { db, repository } = setup()
    repository.createReconcileRun({
      id: 'run-old-attention', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'attention-plan', recoveryStrategy: 'resume', createdAt: '2026-08-01T00:00:00.000Z',
    })
    db.prepare(`
      UPDATE reconcile_runs SET state = 'needs_recovery', failure_code = 'physical_state_uncertain',
        updated_at = '2026-08-01T00:01:00.000Z' WHERE id = 'run-old-attention'
    `).run()
    for (const [state, day] of [['failed', '02'], ['cancelled', '03']] as const) {
      const id = `run-old-${state}`
      repository.createReconcileRun({
        id, installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: `${state}-plan`, recoveryStrategy: 'resume',
        createdAt: `2026-08-${day}T00:00:00.000Z`,
      })
      db.prepare(`
        UPDATE reconcile_runs SET state = ?, failure_code = ?, completed_at = ?, updated_at = ? WHERE id = ?
      `).run(state, `${state}_fixture`, `2026-08-${day}T00:01:00.000Z`, `2026-08-${day}T00:01:00.000Z`, id)
    }
    for (let index = 0; index < 4; index += 1) {
      const id = `run-new-success-${index}`
      const createdAt = `2026-08-25T00:0${index}:00.000Z`
      repository.createReconcileRun({
        id, installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: `success-plan-${index}`, recoveryStrategy: 'resume', createdAt,
      })
      repository.transitionRunState(id, 'planned', 'committed', createdAt)
    }
    const rebuilt = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: async request => plan(request), applyPrepared: async () => ({ status: 'committed', runId: 'unexpected' }) },
      now: () => new Date('2026-08-25T00:10:00.000Z'),
      homeDir: '/Users/alice',
    })

    const firstPage = rebuilt.listApplyTasks({ limit: 1 })
    expect(firstPage.tasks).toHaveLength(1)
    expect(firstPage.attentionCount).toBe(3)
    expect(firstPage.totalCount).toBe(7)
    expect(firstPage.hasMore).toBe(true)
    const tasks = listAllApplyTasks(rebuilt)
    expect(tasks).toHaveLength(7)
    expect(tasks.slice(0, 3).flatMap(task => task.results.map(result => result.runId))).toEqual([
      'run-old-cancelled',
      'run-old-failed',
      'run-old-attention',
    ])
    expect(tasks[2]).toMatchObject({
      results: [{ installationId: 'installation-1', status: 'needs_recovery', runId: 'run-old-attention' }],
    })
    expect(tasks.slice(3).flatMap(task => task.results.map(result => result.runId))).toContain(
      'run-new-success-3',
    )
  })

  it('keeps unlimited durable attention without spending the pure-success limit or splitting a restarted batch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-durable-task-limit-'))
    const dbPath = path.join(root, 'brain.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      for (const [index, installationId] of ['installation-1', 'installation-2'].entries()) {
        repository.upsertDiscoveredInstallation({
          id: installationId,
          family: 'cursor',
          hostVariant: 'cursor-desktop',
          installKey: `cursor:${installationId}`,
          provenance: 'test',
          osUserIdentity: '501',
          displayName: installationId,
          configRoot: path.join(root, installationId),
          agentId: `eb_${installationId}`,
          supportedCapability: 4,
          lastDetectedAt: `2026-08-01T00:00:0${index}.000Z`,
        })
      }

      repository.createApplyTask({
        id: 'older-success-batch',
        planHash: 'older-success-plan',
        startedAt: '2026-08-01T00:00:00.000Z',
        items: [
          { installationId: 'installation-1', executionPlanHash: 'success-execution-a' },
          { installationId: 'installation-2', executionPlanHash: 'success-execution-b' },
        ],
      })
      for (const [index, installationId] of ['installation-1', 'installation-2'].entries()) {
        const runId = `success-run-${index + 1}`
        const executionPlanHash = `success-execution-${index === 0 ? 'a' : 'b'}`
        repository.createReconcileRun({
          id: runId,
          installationId,
          operationType: 'connect',
          executionPlanHash,
          recoveryStrategy: 'resume',
          createdAt: `2026-08-01T00:00:0${index + 1}.000Z`,
        })
        repository.transitionRunState(
          runId,
          'planned',
          'committed',
          `2026-08-01T00:00:1${index}.000Z`,
        )
        repository.markApplyTaskItemRunning(
          'older-success-batch',
          installationId,
          `2026-08-01T00:00:0${index + 1}.000Z`,
        )
        repository.completeApplyTaskItem('older-success-batch', installationId, {
          installationId,
          status: 'committed',
          runId,
        }, `2026-08-01T00:00:1${index}.000Z`)
        db.prepare(`
          UPDATE agent_integration_apply_task_items SET run_id = ?
          WHERE task_id = 'older-success-batch' AND installation_id = ?
        `).run(runId, installationId)
      }
      repository.completeApplyTask('older-success-batch', '2026-08-01T00:00:20.000Z')

      const attentionFixtures = [
        ['newer-unknown', '2026-08-02T00:00:00.000Z', JSON.stringify({ status: 'unexpected' })],
        ['newer-corrupt', '2026-08-03T00:00:00.000Z', '{broken'],
        ['newer-cancelled', '2026-08-04T00:00:00.000Z', JSON.stringify({ status: 'cancelled' })],
        ['newer-failed', '2026-08-05T00:00:00.000Z', JSON.stringify({ status: 'failed', reason: 'fixture' })],
      ] as const
      for (const [taskId, startedAt, resultJson] of attentionFixtures) {
        repository.createApplyTask({
          id: taskId,
          planHash: taskId,
          startedAt,
          items: [{ installationId: 'installation-1', executionPlanHash: `${taskId}-execution` }],
        })
        repository.markApplyTaskItemRunning(taskId, 'installation-1', startedAt)
        db.prepare(`
          UPDATE agent_integration_apply_task_items
          SET state = 'terminal', result_json = ?, completed_at = ?, updated_at = ?
          WHERE task_id = ? AND installation_id = 'installation-1'
        `).run(resultJson, startedAt, startedAt, taskId)
        repository.completeApplyTask(taskId, startedAt)
      }

      expect(repository.listDurableApplyTasks(1).map(task => task.id)).toEqual([
        'newer-failed',
        'newer-cancelled',
        'newer-corrupt',
        'newer-unknown',
        'older-success-batch',
      ])

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date('2026-08-06T00:00:00.000Z'),
        homeDir: root,
      })
      const firstProcess = new AgentIntegrationService(dependencies(repository))
      expect(listAllApplyTasks(firstProcess).map(task => task.id)).toEqual([
        'newer-failed',
        'newer-cancelled',
        'newer-corrupt',
        'newer-unknown',
        'older-success-batch',
      ])

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      const restarted = new AgentIntegrationService(dependencies(repository))
      const tasks = listAllApplyTasks(restarted)
      expect(tasks.map(task => task.id)).toEqual([
        'newer-failed',
        'newer-cancelled',
        'newer-corrupt',
        'newer-unknown',
        'older-success-batch',
      ])
      expect(tasks.at(-1)).toMatchObject({
        id: 'older-success-batch',
        installationIds: ['installation-1', 'installation-2'],
        results: [
          { installationId: 'installation-1', status: 'committed', runId: 'success-run-1' },
          { installationId: 'installation-2', status: 'committed', runId: 'success-run-2' },
        ],
      })
      expect(tasks.filter(task => task.id.startsWith('agent_recovered_'))).toEqual([])
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed on forged durable success correlation across two physical SQLite restarts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-durable-correlation-'))
    const dbPath = path.join(root, 'brain.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      for (const [index, installationId] of ['installation-1', 'installation-2'].entries()) {
        repository.upsertDiscoveredInstallation({
          id: installationId,
          family: 'cursor',
          hostVariant: 'cursor-desktop',
          installKey: `cursor:${installationId}`,
          provenance: 'test',
          osUserIdentity: '501',
          displayName: installationId,
          configRoot: path.join(root, installationId),
          agentId: `eb_${installationId}`,
          supportedCapability: 4,
          lastDetectedAt: `2026-08-10T00:00:0${index}.000Z`,
        })
      }

      const completedTask = (
        taskId: string,
        startedAt: string,
        executionPlanHash: string,
        resultJson: string,
        runId: string | null,
      ) => {
        repository.createApplyTask({
          id: taskId,
          planHash: `${taskId}-plan`,
          startedAt,
          items: [{ installationId: 'installation-1', executionPlanHash }],
        })
        repository.markApplyTaskItemRunning(taskId, 'installation-1', startedAt)
        db.prepare(`
          UPDATE agent_integration_apply_task_items
          SET state = 'terminal', result_json = ?, run_id = ?, completed_at = ?, updated_at = ?
          WHERE task_id = ? AND installation_id = 'installation-1'
        `).run(resultJson, runId, startedAt, startedAt, taskId)
        repository.completeApplyTask(taskId, startedAt)
      }

      repository.createReconcileRun({
        id: 'run-needs-recovery', installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: 'spoofed-execution', recoveryStrategy: 'resume',
        createdAt: '2026-08-11T00:00:00.000Z',
      })
      repository.transitionRunState(
        'run-needs-recovery', 'planned', 'needs_recovery', '2026-08-11T00:00:01.000Z',
      )
      repository.createReconcileRun({
        id: 'run-foreign', installationId: 'installation-2', operationType: 'connect',
        executionPlanHash: 'foreign-execution', recoveryStrategy: 'resume',
        createdAt: '2026-08-12T00:00:00.000Z',
      })
      repository.transitionRunState(
        'run-foreign', 'planned', 'committed', '2026-08-12T00:00:01.000Z',
      )
      repository.createReconcileRun({
        id: 'run-legacy-unique', installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: 'legacy-unique-execution', recoveryStrategy: 'resume',
        createdAt: '2026-08-18T00:00:00.000Z',
      })
      repository.transitionRunState(
        'run-legacy-unique', 'planned', 'committed', '2026-08-18T00:00:01.000Z',
      )

      completedTask(
        'attention-missing-run',
        '2026-08-14T00:00:00.000Z',
        'missing-run-execution',
        JSON.stringify({ installationId: 'installation-1', status: 'committed' }),
        null,
      )
      completedTask(
        'attention-spoofed-run',
        '2026-08-15T00:00:00.000Z',
        'spoofed-execution',
        JSON.stringify({
          installationId: 'installation-1', status: 'committed', runId: 'run-spoof-target',
        }),
        'run-needs-recovery',
      )
      completedTask(
        'attention-foreign-run',
        '2026-08-16T00:00:00.000Z',
        'wrong-item-execution',
        JSON.stringify({ installationId: 'installation-1', status: 'committed', runId: 'run-foreign' }),
        'run-foreign',
      )
      completedTask(
        'attention-corrupt-json',
        '2026-08-17T00:00:00.000Z',
        'corrupt-execution',
        '{broken',
        null,
      )
      repository.createApplyTask({
        id: 'legacy-null-unique',
        planHash: 'legacy-null-plan',
        startedAt: '2026-08-18T00:00:00.000Z',
        items: [{ installationId: 'installation-1', executionPlanHash: 'legacy-unique-execution' }],
      })
      repository.markApplyTaskItemRunning(
        'legacy-null-unique', 'installation-1', '2026-08-18T00:00:01.000Z',
      )

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date('2026-08-18T12:00:00.000Z'),
        homeDir: root,
      })
      const expectedTaskIds = [
        'attention-corrupt-json',
        'attention-foreign-run',
        'attention-spoofed-run',
        'attention-missing-run',
        'legacy-null-unique',
      ]

      const first = new AgentIntegrationService(dependencies(repository))
      const firstTasks = listAllApplyTasks(first)
      expect(firstTasks.map(task => task.id)).toEqual(expectedTaskIds)
      expect(firstTasks.find(task => task.id === 'attention-spoofed-run')).toMatchObject({
        results: [expect.objectContaining({
          installationId: 'installation-1', status: 'interrupted',
        })],
      })
      expect(firstTasks.filter(task => task.id.startsWith('agent_recovered_'))).toEqual([])
      expect(firstTasks.at(-1)).toMatchObject({
        id: 'legacy-null-unique',
        results: [{ installationId: 'installation-1', status: 'committed', runId: 'run-legacy-unique' }],
      })

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      const second = new AgentIntegrationService(dependencies(repository))
      const secondTasks = listAllApplyTasks(second)
      expect(secondTasks).toEqual(firstTasks)
      expect(secondTasks.filter(task => task.results.some(result => (
        result.status === 'committed' && result.runId === 'run-spoof-target'
      )))).toEqual([])
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the exact ledger run authoritative over live memory and same-hash tasks across restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-durable-live-authority-'))
    const dbPath = path.join(root, 'brain.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
        installKey: 'cursor:default', provenance: 'test', osUserIdentity: '501',
        displayName: 'Cursor', configRoot: root, agentId: 'eb_cursor',
        supportedCapability: 4, lastDetectedAt: '2026-08-26T00:00:00.000Z',
      })
      repository.createApplyTask({
        id: 'progress-task', planHash: 'progress-batch', startedAt: '2026-08-26T00:00:00.000Z',
        items: [{ installationId: 'installation-1', executionPlanHash: 'progress-execution' }],
      })
      repository.markApplyTaskItemRunning('progress-task', 'installation-1', '2026-08-26T00:00:01.000Z')
      repository.createReconcileRun({
        id: 'progress-run', installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: 'progress-execution', recoveryStrategy: 'resume',
        createdAt: '2026-08-26T00:00:01.000Z',
      })
      repository.transitionRunState(
        'progress-run', 'planned', 'applied_unverified', '2026-08-26T00:00:02.000Z',
      )
      db.prepare(`
        UPDATE agent_integration_apply_task_items SET run_id = ?
        WHERE task_id = 'progress-task' AND installation_id = 'installation-1'
      `).run('progress-run')
      repository.completeApplyTaskItem('progress-task', 'installation-1', {
        installationId: 'installation-1', status: 'awaiting_verification', runId: 'progress-run',
      }, '2026-08-26T00:00:03.000Z')
      repository.completeApplyTask('progress-task', '2026-08-26T00:00:03.000Z')

      repository.createReconcileRun({
        id: 'older-same-hash-recovery', installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: 'same-execution', recoveryStrategy: 'resume',
        createdAt: '2026-08-25T00:00:00.000Z',
      })
      repository.transitionRunState(
        'older-same-hash-recovery', 'planned', 'needs_recovery', '2026-08-25T00:00:01.000Z',
      )
      repository.createApplyTask({
        id: 'newer-same-hash-failure', planHash: 'newer-batch', startedAt: '2026-08-26T00:01:00.000Z',
        items: [{ installationId: 'installation-1', executionPlanHash: 'same-execution' }],
      })
      repository.markApplyTaskItemRunning(
        'newer-same-hash-failure', 'installation-1', '2026-08-26T00:01:01.000Z',
      )
      repository.completeApplyTaskItem('newer-same-hash-failure', 'installation-1', {
        installationId: 'installation-1', status: 'failed', reason: 'blocked by the older recovery',
      }, '2026-08-26T00:01:02.000Z')
      repository.completeApplyTask('newer-same-hash-failure', '2026-08-26T00:01:02.000Z')

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date('2026-08-26T00:02:00.000Z'),
        homeDir: root,
      })
      const first = new AgentIntegrationService(dependencies(repository))
      const firstInternals = first as unknown as {
        applyTasks: Map<string, ReturnType<AgentIntegrationService['listApplyTasks']>['tasks'][number]>
        applyTaskExecutionHashes?: Map<string, ReadonlyMap<string, string>>
      }
      firstInternals.applyTasks.set('progress-task', {
        id: 'progress-task', planHash: 'progress-batch', installationIds: ['installation-1'],
        pendingInstallationIds: [], state: 'completed',
        startedAt: '2026-08-26T00:00:00.000Z', completedAt: '2026-08-26T00:00:03.000Z',
        results: [{
          installationId: 'installation-1', status: 'awaiting_verification', runId: 'progress-run',
        }],
      })
      firstInternals.applyTasks.set('newer-same-hash-failure', {
        id: 'newer-same-hash-failure', planHash: 'newer-batch', installationIds: ['installation-1'],
        pendingInstallationIds: [], state: 'completed',
        startedAt: '2026-08-26T00:01:00.000Z', completedAt: '2026-08-26T00:01:02.000Z',
        results: [{
          installationId: 'installation-1', status: 'failed', reason: 'blocked by the older recovery',
        }],
      })
      firstInternals.applyTaskExecutionHashes?.set(
        'newer-same-hash-failure', new Map([['installation-1', 'same-execution']]),
      )

      repository.transitionRunState(
        'progress-run', 'applied_unverified', 'needs_recovery', '2026-08-26T00:02:01.000Z',
      )
      expect(first.getApplyTask('progress-task')).toMatchObject({
        id: 'progress-task',
        results: [{ installationId: 'installation-1', status: 'needs_recovery', runId: 'progress-run' }],
      })
      expect(listAllApplyTasks(first)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'newer-same-hash-failure' }),
        expect.objectContaining({
          installationIds: ['installation-1'],
          results: [expect.objectContaining({
            status: 'needs_recovery', runId: 'older-same-hash-recovery',
          })],
        }),
      ]))

      repository.transitionRunState(
        'progress-run', 'needs_recovery', 'committed', '2026-08-26T00:02:02.000Z',
      )
      expect(first.getApplyTask('progress-task')).toMatchObject({
        id: 'progress-task',
        results: [{ installationId: 'installation-1', status: 'committed', runId: 'progress-run' }],
      })

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      const second = new AgentIntegrationService(dependencies(repository))
      expect(second.getApplyTask('progress-task')).toMatchObject({
        id: 'progress-task',
        results: [{ installationId: 'installation-1', status: 'committed', runId: 'progress-run' }],
      })
      expect(listAllApplyTasks(second)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'newer-same-hash-failure' }),
        expect.objectContaining({
          results: [expect.objectContaining({ runId: 'older-same-hash-recovery' })],
        }),
      ]))
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads an exact bound run beyond both committed history windows across two physical restarts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-durable-exact-window-'))
    const dbPath = path.join(root, 'brain.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
        installKey: 'cursor:default', provenance: 'test', osUserIdentity: '501',
        displayName: 'Cursor', configRoot: root, agentId: 'eb_cursor',
        supportedCapability: 4, lastDetectedAt: '2026-01-01T00:00:00.000Z',
      })
      repository.createApplyTask({
        id: 'window-task', planHash: 'window-batch', startedAt: '2035-01-01T00:00:00.000Z',
        items: [{ installationId: 'installation-1', executionPlanHash: 'window-execution' }],
      })
      repository.markApplyTaskItemRunning('window-task', 'installation-1', '2035-01-01T00:00:01.000Z')
      repository.createReconcileRun({
        id: 'window-run', installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: 'window-execution', recoveryStrategy: 'resume',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      repository.transitionRunState(
        'window-run', 'planned', 'applied_unverified', '2026-01-01T00:00:01.000Z',
      )
      db.prepare(`
        UPDATE agent_integration_apply_task_items SET run_id = ?
        WHERE task_id = 'window-task' AND installation_id = 'installation-1'
      `).run('window-run')
      repository.completeApplyTaskItem('window-task', 'installation-1', {
        installationId: 'installation-1', status: 'awaiting_verification', runId: 'window-run',
      }, '2035-01-01T00:00:02.000Z')
      repository.completeApplyTask('window-task', '2035-01-01T00:00:02.000Z')
      repository.transitionRunState(
        'window-run', 'applied_unverified', 'committed', '2026-01-01T00:00:02.000Z',
      )

      for (let index = 0; index < 501; index += 1) {
        const id = `newer-window-run-${index}`
        const createdAt = new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString()
        repository.createReconcileRun({
          id, installationId: 'installation-1', operationType: 'connect',
          executionPlanHash: `newer-window-execution-${index}`, recoveryStrategy: 'resume', createdAt,
        })
        repository.transitionRunState(id, 'planned', 'committed', createdAt)
      }
      expect(repository.listRecentApplyTaskRuns(100).some(run => run.id === 'window-run')).toBe(false)
      expect(repository.listRecentApplyTaskRuns(500).some(run => run.id === 'window-run')).toBe(false)

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date('2035-01-01T00:01:00.000Z'),
        homeDir: root,
      })
      const first = new AgentIntegrationService(dependencies(repository))
      ;(first as unknown as { applyTasks: Map<string, unknown> }).applyTasks.set('window-task', {
        id: 'window-task', planHash: 'window-batch', installationIds: ['installation-1'],
        pendingInstallationIds: [], state: 'completed', startedAt: '2035-01-01T00:00:00.000Z',
        completedAt: '2035-01-01T00:00:02.000Z', results: [{
          installationId: 'installation-1', status: 'awaiting_verification', runId: 'window-run',
        }],
      })
      expect(first.listApplyTasks({ limit: 20 }).tasks[0]).toMatchObject({
        id: 'window-task',
        results: [{ installationId: 'installation-1', status: 'committed', runId: 'window-run' }],
      })
      expect(first.getApplyTask('window-task')).toMatchObject({
        results: [{ installationId: 'installation-1', status: 'committed', runId: 'window-run' }],
      })

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      const second = new AgentIntegrationService(dependencies(repository))
      expect(second.getApplyTask('window-task').results).toEqual([
        { installationId: 'installation-1', status: 'committed', runId: 'window-run' },
      ])
      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      const third = new AgentIntegrationService(dependencies(repository))
      expect(third.listApplyTasks({ limit: 20 }).tasks[0]).toMatchObject({
        id: 'window-task', results: [{ status: 'committed', runId: 'window-run' }],
      })
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['repair', 'disconnect'] as const)(
    'does not accept a committed %s run as exact success for a connect task',
    operationType => {
      const { db, repository } = setup()
      const runId = `${operationType}-run`
      repository.createApplyTask({
        id: `${operationType}-task`, planHash: `${operationType}-batch`, startedAt: T0,
        items: [{ installationId: 'installation-1', executionPlanHash: `${operationType}-execution` }],
      })
      repository.markApplyTaskItemRunning(`${operationType}-task`, 'installation-1', T0)
      repository.createReconcileRun({
        id: runId, installationId: 'installation-1', operationType,
        executionPlanHash: `${operationType}-execution`, recoveryStrategy: 'resume', createdAt: T0,
      })
      repository.transitionRunState(runId, 'planned', 'committed', T0)
      db.prepare(`
        UPDATE agent_integration_apply_task_items
        SET run_id = ?, state = 'terminal', result_json = ?, completed_at = ?, updated_at = ?
        WHERE task_id = ? AND installation_id = 'installation-1'
      `).run(
        runId,
        JSON.stringify({ installationId: 'installation-1', status: 'committed', runId }),
        T0,
        T0,
        `${operationType}-task`,
      )
      repository.completeApplyTask(`${operationType}-task`, T0)

      expect(repository.listDurableApplyTasks(1)).toEqual([
        expect.objectContaining({
          id: `${operationType}-task`,
          items: [expect.objectContaining({ exact_run_correlation: 0 })],
        }),
      ])
      const rebuilt = new AgentIntegrationService({
        repository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async request => plan(request),
          applyPrepared: async () => ({ status: 'committed', runId: 'unexpected' }),
        },
        now: () => new Date(T0),
        homeDir: '/Users/alice',
      })
      expect(rebuilt.getApplyTask(`${operationType}-task`)).toMatchObject({
        results: [{ installationId: 'installation-1', status: 'interrupted' }],
      })
    },
  )

  it('fails closed on non-terminal repair/disconnect run semantics across a physical restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-durable-operation-mismatch-'))
    const dbPath = path.join(root, 'brain.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
        installKey: 'cursor:default', provenance: 'test', osUserIdentity: '501',
        displayName: 'Cursor', configRoot: root, agentId: 'eb_cursor',
        supportedCapability: 4, lastDetectedAt: T0,
      })
      for (const operationType of ['repair', 'disconnect'] as const) {
        for (const runState of ['applied_unverified', 'needs_recovery'] as const) {
          const taskId = `${operationType}-${runState}-task`
          const runId = `${operationType}-${runState}-run`
          const executionPlanHash = `${operationType}-${runState}-execution`
          repository.createApplyTask({
            id: taskId, planHash: `${taskId}-batch`, startedAt: T0,
            items: [{ installationId: 'installation-1', executionPlanHash }],
          })
          repository.markApplyTaskItemRunning(taskId, 'installation-1', T0)
          repository.createReconcileRun({
            id: runId, installationId: 'installation-1', operationType,
            executionPlanHash, recoveryStrategy: 'resume', createdAt: T0,
          })
          repository.transitionRunState(runId, 'planned', runState, T0)
          db.prepare(`
            UPDATE agent_integration_apply_task_items
            SET run_id = ?, state = 'terminal', result_json = ?, completed_at = ?, updated_at = ?
            WHERE task_id = ? AND installation_id = 'installation-1'
          `).run(
            runId,
            JSON.stringify({
              installationId: 'installation-1',
              status: runState === 'applied_unverified' ? 'awaiting_verification' : 'needs_recovery',
              runId,
            }),
            T0,
            T0,
            taskId,
          )
          repository.completeApplyTask(taskId, T0)
        }
      }

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date(T0),
        homeDir: root,
      })
      const assertInterrupted = (service: AgentIntegrationService) => {
        const tasks = service.listApplyTasks({ limit: 20 }).tasks
        expect(tasks).toHaveLength(4)
        expect(tasks.every(task => task.results.length === 1
          && task.results[0]?.status === 'interrupted'
          && task.results[0].runId === undefined)).toBe(true)
      }
      assertInterrupted(new AgentIntegrationService(dependencies(repository)))
      expect(repository.listDurableApplyTasks(20).every(task => (
        task.items[0]?.exact_run_correlation === 0
      ))).toBe(true)

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      assertInterrupted(new AgentIntegrationService(dependencies(repository)))
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('folds an old-v34 null run_id only by a unique Installation and execution hash despite clock rollback', () => {
    const { repository } = setup()
    repository.createApplyTask({
      id: 'legacy-v34-task', planHash: 'legacy-batch', startedAt: '2026-08-30T00:00:00.000Z',
      items: [{ installationId: 'installation-1', executionPlanHash: 'legacy-execution' }],
    })
    repository.markApplyTaskItemRunning('legacy-v34-task', 'installation-1', '2026-08-30T00:00:01.000Z')
    repository.createReconcileRun({
      id: 'legacy-v34-run', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'legacy-execution', recoveryStrategy: 'resume',
      createdAt: '2026-08-20T00:00:00.000Z',
    })
    repository.transitionRunState(
      'legacy-v34-run', 'planned', 'committed', '2026-08-19T00:00:00.000Z',
    )

    const rebuilt = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: async request => plan(request), applyPrepared: async () => ({ status: 'committed', runId: 'unexpected' }) },
      now: () => new Date('2026-08-18T00:00:00.000Z'),
      homeDir: '/Users/alice',
    })
    expect(rebuilt.listApplyTasks().tasks).toEqual([
      expect.objectContaining({
        id: 'legacy-v34-task',
        results: [{ installationId: 'installation-1', status: 'committed', runId: 'legacy-v34-run' }],
      }),
    ])
  })

  it('fails closed instead of guessing between ambiguous old-v34 null run_id tasks', () => {
    const { repository } = setup()
    for (const id of ['legacy-ambiguous-a', 'legacy-ambiguous-b']) {
      repository.createApplyTask({
        id, planHash: id, startedAt: T0,
        items: [{ installationId: 'installation-1', executionPlanHash: 'same-execution' }],
      })
      repository.markApplyTaskItemRunning(id, 'installation-1', T0)
    }
    repository.createReconcileRun({
      id: 'ambiguous-run', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'same-execution', recoveryStrategy: 'resume', createdAt: T0,
    })
    repository.transitionRunState('ambiguous-run', 'planned', 'committed', T0)

    const rebuilt = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: async request => plan(request), applyPrepared: async () => ({ status: 'committed', runId: 'unexpected' }) },
      now: () => new Date(T0),
      homeDir: '/Users/alice',
    })
    const tasks = rebuilt.listApplyTasks().tasks
    expect(tasks.filter(task => task.results.some(result => result.runId === 'ambiguous-run'))).toHaveLength(1)
    expect(tasks.filter(task => task.id.startsWith('legacy-ambiguous-'))).toHaveLength(2)
    expect(tasks.filter(task => task.id.startsWith('legacy-ambiguous-')).every(task => (
      task.results[0]?.status === 'interrupted'
    ))).toBe(true)
  })

  it('keeps one old-v34 null run_id task separate from two candidate runs across two physical restarts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-legacy-run-graph-'))
    const dbPath = path.join(root, 'agent-integration.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
        installKey: 'cursor:default', provenance: 'test', osUserIdentity: '501',
        displayName: 'Cursor', configRoot: path.join(root, '.cursor'),
        executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
        agentId: 'eb_test', supportedCapability: 4, lastDetectedAt: T0,
      })
      repository.createApplyTask({
        id: 'legacy-one-task-two-runs', planHash: 'legacy-batch', startedAt: T0,
        items: [{ installationId: 'installation-1', executionPlanHash: 'shared-execution' }],
      })
      repository.markApplyTaskItemRunning('legacy-one-task-two-runs', 'installation-1', T0)
      repository.interruptAbandonedApplyTasks(T0)
      for (const id of ['candidate-run-a', 'candidate-run-b']) {
        repository.createReconcileRun({
          id, installationId: 'installation-1', operationType: 'connect',
          executionPlanHash: 'shared-execution', recoveryStrategy: 'resume', createdAt: T0,
        })
      }
      repository.transitionRunState('candidate-run-a', 'planned', 'committed', T0)
      db.prepare(`
        UPDATE reconcile_runs
        SET state = 'needs_recovery', failure_code = 'physical_state_uncertain', updated_at = ?
        WHERE id = 'candidate-run-b'
      `).run(T0)

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date(T0),
        homeDir: root,
      })
      const assertUnboundGraph = (service: AgentIntegrationService) => {
        const tasks = service.listApplyTasks({ limit: 20 }).tasks
        expect(tasks).toHaveLength(3)
        expect(tasks.find(task => task.id === 'legacy-one-task-two-runs')).toMatchObject({
          results: [{ installationId: 'installation-1', status: 'interrupted' }],
        })
        expect(tasks.find(task => task.id === 'legacy-one-task-two-runs')?.results[0]).not.toHaveProperty('runId')
        expect(tasks.flatMap(task => task.results.map(result => result.runId)).filter(Boolean).sort()).toEqual([
          'candidate-run-a',
          'candidate-run-b',
        ])
      }

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      assertUnboundGraph(new AgentIntegrationService(dependencies(repository)))

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      assertUnboundGraph(new AgentIntegrationService(dependencies(repository)))
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves old-v34 ownership beyond the 100 and 500 committed-run windows across two restarts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-legacy-run-window-'))
    const dbPath = path.join(root, 'agent-integration.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
        installKey: 'cursor:default', provenance: 'test', osUserIdentity: '501',
        displayName: 'Cursor', configRoot: path.join(root, '.cursor'),
        executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
        agentId: 'eb_test', supportedCapability: 4, lastDetectedAt: T0,
      })
      repository.createApplyTask({
        id: 'legacy-window-task', planHash: 'legacy-window-batch', startedAt: T0,
        items: [{ installationId: 'installation-1', executionPlanHash: 'shared-window-execution' }],
      })
      repository.markApplyTaskItemRunning('legacy-window-task', 'installation-1', T0)
      repository.interruptAbandonedApplyTasks(T0)
      const commitRun = (id: string, executionPlanHash: string, createdAt: string) => {
        repository.createReconcileRun({
          id, installationId: 'installation-1', operationType: 'connect',
          executionPlanHash, recoveryStrategy: 'resume', createdAt,
        })
        repository.transitionRunState(id, 'planned', 'committed', createdAt)
      }
      commitRun('legacy-window-candidate-new', 'shared-window-execution', '2026-08-25T01:00:00.000Z')
      for (let index = 0; index < 501; index += 1) {
        commitRun(
          `legacy-window-filler-${index}`,
          `unrelated-window-execution-${index}`,
          new Date(Date.UTC(2026, 7, 25, 0, 0, 0, index)).toISOString(),
        )
      }
      commitRun('legacy-window-candidate-old', 'shared-window-execution', '2025-08-24T23:00:00.000Z')
      expect(repository.listRecentApplyTaskRuns(100).some(run => (
        run.id === 'legacy-window-candidate-old'
      ))).toBe(false)
      expect(repository.listRecentApplyTaskRuns(500).some(run => (
        run.id === 'legacy-window-candidate-old'
      ))).toBe(false)

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date('2026-08-25T02:00:00.000Z'),
        homeDir: root,
      })
      const assertWindowIndependent = (service: AgentIntegrationService) => {
        for (const limit of [20, 100]) {
          const tasks = service.listApplyTasks({ limit }).tasks
          const legacy = tasks.find(task => task.id === 'legacy-window-task')
          expect(legacy).toMatchObject({
            results: [{ installationId: 'installation-1', status: 'interrupted' }],
          })
          expect(legacy?.results[0]).not.toHaveProperty('runId')
          for (const runId of ['legacy-window-candidate-new', 'legacy-window-candidate-old']) {
            expect(tasks.filter(task => task.results.some(result => result.runId === runId))).toHaveLength(1)
          }
        }
        expect(service.getApplyTask('legacy-window-task')).toMatchObject({
          results: [{ installationId: 'installation-1', status: 'interrupted' }],
        })
      }

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      assertWindowIndependent(new AgentIntegrationService(dependencies(repository)))

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      assertWindowIndependent(new AgentIntegrationService(dependencies(repository)))
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('never gives a hidden exact-FK run owner to a legacy null item across two restarts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-legacy-exact-owner-'))
    const dbPath = path.join(root, 'agent-integration.sqlite')
    let db = new Database(dbPath)
    try {
      ensureSchema(db)
      let repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
        installKey: 'cursor:default', provenance: 'test', osUserIdentity: '501',
        displayName: 'Cursor', configRoot: path.join(root, '.cursor'),
        executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
        agentId: 'eb_test', supportedCapability: 4, lastDetectedAt: T0,
      })
      const persistExactSuccess = (
        taskId: string,
        runId: string,
        executionPlanHash: string,
        at: string,
      ) => {
        repository.createApplyTask({
          id: taskId, planHash: `${taskId}-batch`, startedAt: at,
          items: [{ installationId: 'installation-1', executionPlanHash }],
        })
        repository.markApplyTaskItemRunning(taskId, 'installation-1', at)
        repository.createReconcileRun({
          id: runId, installationId: 'installation-1', operationType: 'connect',
          executionPlanHash, recoveryStrategy: 'resume', createdAt: at,
        })
        db.prepare(`
          UPDATE agent_integration_apply_task_items SET run_id = ?
          WHERE task_id = ? AND installation_id = 'installation-1'
        `).run(runId, taskId)
        repository.transitionRunState(runId, 'planned', 'committed', at)
        repository.completeApplyTaskItem(taskId, 'installation-1', {
          installationId: 'installation-1', status: 'committed', runId,
        }, at)
        repository.completeApplyTask(taskId, at)
      }
      persistExactSuccess(
        'hidden-exact-owner-task',
        'hidden-exact-owner-run',
        'shared-hidden-execution',
        '2025-01-01T00:00:00.000Z',
      )
      for (let index = 0; index < 501; index += 1) {
        const at = new Date(Date.UTC(2026, 7, 25, 0, 0, 0, index)).toISOString()
        persistExactSuccess(
          `hidden-owner-filler-task-${index}`,
          `hidden-owner-filler-run-${index}`,
          `hidden-owner-filler-execution-${index}`,
          at,
        )
      }
      repository.createApplyTask({
        id: 'legacy-null-hidden-owner', planHash: 'legacy-hidden-owner-batch', startedAt: T0,
        items: [{ installationId: 'installation-1', executionPlanHash: 'shared-hidden-execution' }],
      })
      repository.markApplyTaskItemRunning('legacy-null-hidden-owner', 'installation-1', T0)
      repository.interruptAbandonedApplyTasks(T0)
      expect(repository.listRecentApplyTaskRuns(500).some(run => (
        run.id === 'hidden-exact-owner-run'
      ))).toBe(false)
      expect(repository.listDurableApplyTasks(100).some(task => (
        task.id === 'hidden-exact-owner-task'
      ))).toBe(false)

      const dependencies = (currentRepository: AgentIntegrationRepository) => ({
        repository: currentRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async (request: PreviewRequest) => plan(request),
          applyPrepared: async () => ({ status: 'committed' as const, runId: 'unexpected' }),
        },
        now: () => new Date('2026-08-25T02:00:00.000Z'),
        homeDir: root,
      })
      const assertExactOwnerWins = (service: AgentIntegrationService) => {
        for (const limit of [20, 100]) {
          const tasks = service.listApplyTasks({ limit }).tasks
          expect(tasks.find(task => task.id === 'legacy-null-hidden-owner')).toMatchObject({
            results: [{ installationId: 'installation-1', status: 'interrupted' }],
          })
          expect(tasks.some(task => task.results.some(result => (
            result.runId === 'hidden-exact-owner-run'
          )))).toBe(false)
        }
        expect(service.getApplyTask('legacy-null-hidden-owner')).toMatchObject({
          results: [{ installationId: 'installation-1', status: 'interrupted' }],
        })
        expect(service.getApplyTask('hidden-exact-owner-task')).toMatchObject({
          results: [{
            installationId: 'installation-1', status: 'committed', runId: 'hidden-exact-owner-run',
          }],
        })
      }

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      assertExactOwnerWins(new AgentIntegrationService(dependencies(repository)))

      db.close()
      db = new Database(dbPath)
      repository = new AgentIntegrationRepository(db)
      assertExactOwnerWins(new AgentIntegrationService(dependencies(repository)))
    } finally {
      if (db.open) db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves a 1k by 1k legacy group without materializing candidate edges', () => {
    const { db, repository } = setup()
    const insertTask = db.prepare(`
      INSERT INTO agent_integration_apply_tasks (
        id, plan_hash, operation_type, state, started_at, completed_at, updated_at
      ) VALUES (?, ?, 'connect', 'completed', ?, ?, ?)
    `)
    const insertItem = db.prepare(`
      INSERT INTO agent_integration_apply_task_items (
        task_id, installation_id, run_id, ordinal, execution_plan_hash, state,
        result_json, started_at, completed_at, updated_at
      ) VALUES (?, 'installation-1', NULL, 0, 'shared-performance-execution',
        'interrupted', ?, ?, ?, ?)
    `)
    const insertRun = db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, state,
        recovery_strategy, created_at, completed_at, updated_at
      ) VALUES (?, 'installation-1', 'connect', 'shared-performance-execution',
        'committed', 'resume', ?, ?, ?)
    `)
    db.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        const taskId = `legacy-performance-task-${index}`
        insertTask.run(taskId, `${taskId}-batch`, T0, T0, T0)
        insertItem.run(taskId, JSON.stringify({ status: 'interrupted' }), T0, T0, T0)
        insertRun.run(`legacy-performance-run-${index}`, T0, T0, T0)
      }
    })()

    const rssBefore = process.memoryUsage().rss
    const startedAt = performance.now()
    const resolution = repository.resolveLegacyNullApplyTaskRuns()
    const elapsedMs = performance.now() - startedAt
    const rssGrowth = process.memoryUsage().rss - rssBefore

    expect(resolution.bindings).toHaveLength(0)
    expect(resolution.candidateRuns).toHaveLength(1_000)
    expect(resolution.ambiguousRuns).toHaveLength(1_000)
    expect(elapsedMs).toBeLessThan(1_500)
    expect(rssGrowth).toBeLessThan(64 * 1024 * 1024)
    db.close()
  })

  it('presents an exact needs-recovery Installation after service restart', () => {
    const { db, repository } = setup()
    repository.createReconcileRun({
      id: 'run-needs-recovery', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'recovery-plan', recoveryStrategy: 'resume', createdAt: T0,
    })
    db.prepare(`
      UPDATE reconcile_runs
      SET state = 'needs_recovery', failure_code = 'physical_state_uncertain',
          failure_stage = 'read_back', updated_at = ?
      WHERE id = 'run-needs-recovery'
    `).run('2026-08-25T00:01:00.000Z')

    const rebuilt = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: async request => plan(request), applyPrepared: async () => ({ status: 'committed', runId: 'unexpected' }) },
      now: () => new Date('2026-08-25T00:02:00.000Z'),
      homeDir: '/Users/alice',
    })

    expect(rebuilt.listApplyTasks().tasks).toEqual([
      expect.objectContaining({
        installationIds: ['installation-1'],
        results: [{
          installationId: 'installation-1', status: 'needs_recovery',
          runId: 'run-needs-recovery', reason: 'physical_state_uncertain',
        }],
      }),
    ])
  })

  it('does not duplicate a live task with its matching durable coordinator run', async () => {
    const { service } = setup()
    const preview = await service.previewConnect(['installation-1'])
    const started = service.startApplyConnect(preview.planHash, ['installation-1'])
    await vi.waitFor(() => expect(service.getApplyTask(started.id).state).toBe('completed'))
    expect(service.listApplyTasks({ limit: 20 }).tasks).toHaveLength(1)
  })

  it('resolves only existing repository-owned component paths inside the service HOME', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-component-path-'))
    const outside = path.join(os.tmpdir(), `tidemind-outside-${Date.now()}.json`)
    try {
      const { repository, service } = setup(undefined, homeDir)
      const target = path.join(homeDir, '.cursor', 'mcp.json')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '{}')
      repository.createManagedArtifact({
        id: 'path-artifact', componentType: 'mcp', targetPath: target,
        ownershipKey: 'mcpServers.tidemind-eb_test', mutationDomain: `local_macos:file:${target}:document`,
        projectionVersion: '1', selectorSchemaVersion: '1', ownedFragmentHash: 'exact',
        desiredFragmentHash: 'exact', observedFragmentHash: 'exact', state: 'healthy',
      }, T0)
      repository.upsertComponent({
        installationId: 'installation-1', componentKey: 'memory_tools', desiredState: 'unmanaged',
        desiredCapability: 0, deliveryMode: 'managed', verificationStatus: 'verified',
        artifactId: 'path-artifact', visibilityState: 'dedicated',
      }, T0)
      expect(service.componentTargetPath('installation-1', 'memory_tools')).toBe(fs.realpathSync(target))

      fs.writeFileSync(outside, '{}')
      repository.createManagedArtifact({
        id: 'outside-artifact', componentType: 'skill', targetPath: outside,
        ownershipKey: 'document', mutationDomain: `local_macos:file:${outside}:document`,
        projectionVersion: '1', selectorSchemaVersion: '1', ownedFragmentHash: 'outside',
        desiredFragmentHash: 'outside', observedFragmentHash: 'outside', state: 'healthy',
      }, T0)
      repository.upsertComponent({
        installationId: 'installation-1', componentKey: 'instruction', desiredState: 'unmanaged',
        desiredCapability: 0, deliveryMode: 'managed', verificationStatus: 'verified',
        artifactId: 'outside-artifact', visibilityState: 'dedicated',
      }, T0)
      expect(() => service.componentTargetPath('installation-1', 'instruction')).toThrow(/outside/)
    } finally {
      fs.rmSync(outside, { force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it('exposes only fresh exact-bound host activity as real use', () => {
    const { db, repository, service } = setup()
    const observedAt = '2026-08-24T23:59:30.000Z'
    repository.createManagedArtifact({
      id: 'activity-artifact', componentType: 'mcp', targetPath: '/Users/alice/.cursor/mcp.json',
      ownershipKey: 'mcpServers.tidemind-eb_test',
      mutationDomain: 'local_macos:file:/Users/alice/.cursor/mcp.json:mcpServers.tidemind-eb_test',
      projectionVersion: 'projection-1', selectorSchemaVersion: '1',
      ownedFragmentHash: 'exact', desiredFragmentHash: 'exact', observedFragmentHash: 'exact', state: 'healthy',
    }, T0)
    repository.upsertComponent({
      installationId: 'installation-1', componentKey: 'memory_tools', desiredState: 'managed',
      desiredCapability: 2, deliveryMode: 'managed', verificationStatus: 'unverified',
      artifactId: 'activity-artifact', visibilityState: 'dedicated',
    }, T0)
    db.prepare(`INSERT INTO artifact_consumers (
      artifact_id, installation_id, component_key, required_capability, desired_state,
      discover_reachability, state, added_at, updated_at
    ) VALUES (?, ?, 'memory_tools', 2, 'managed', 'dedicated', 'active', ?, ?)`)
      .run('activity-artifact', 'installation-1', T0, T0)
    db.prepare(`UPDATE agent_installations
      SET desired_state = 'managed', detected_version = '1.0.0', health_state = 'discovered'
      WHERE id = 'installation-1'`).run()
    db.prepare(`INSERT INTO agent_host_activity_evidence (
      id, installation_id, agent_id, host_variant, component_key, signal_name,
      tide_mind_version, adapter_version, projection_version, host_version,
      evidence_hash, observed_at
    ) VALUES (?, ?, ?, ?, 'memory_tools', 'brain_recall', ?, ?, ?, ?, ?, ?)`)
      .run(
        'activity-evidence-1', 'installation-1', 'eb_test', 'cursor-desktop',
        '1.0.0', 'adapter-1', 'projection-1', '1.0.0', 'evidence-hash', observedAt,
      )
    repository.recordVerificationResult({
      id: 'activity-verification-1', installationId: 'installation-1', componentKey: 'memory_tools',
      family: 'cursor', hostVariant: 'cursor-desktop', runtimeRealm: 'local_macos', hostVersion: '1.0.0',
      tideMindVersion: '1.0.0', adapterVersion: 'adapter-1', catalogVersion: '1',
      projectionVersion: 'projection-1', selectorSchemaVersion: '1', verificationManifestVersion: '1',
      method: 'host_activity_recognized:brain_recall', identityAssertion: 'eb_test', artifactHash: 'exact',
      invalidationKeys: ['activity_freshness'], result: 'verified',
      evidenceRef: 'host-activity:activity-evidence-1', evidenceHash: 'verification-hash',
      verifiedAt: T0, expiresAt: '2026-08-25T00:01:00.000Z',
    })

    expect(service.detail('installation-1').installation.lastRealUseAt).toBe(observedAt)

    db.prepare(`UPDATE verification_results
      SET expires_at = '2026-08-24T23:59:59.000Z'
      WHERE id = 'activity-verification-1'`).run()
    expect(service.detail('installation-1').installation.lastRealUseAt).toBeNull()

    db.prepare(`UPDATE verification_results
      SET expires_at = '2026-08-25T00:01:00.000Z'
      WHERE id = 'activity-verification-1'`).run()
    repository.invalidateVerificationResults('installation-1', 'memory_tools', T0, 'test_stale')
    expect(service.detail('installation-1').installation.lastRealUseAt).toBeNull()
  })

  it('shows and persists exact maintenance scope for an adopted no-op connection', async () => {
    const { db, repository, service, preview } = setup()
    const target = '/Users/alice/.cursor/mcp.json'
    repository.createManagedArtifact({
      id: 'legacy-mcp', componentType: 'mcp', targetPath: target,
      ownershipKey: 'mcpServers.tidemind-eb_test',
      mutationDomain: `local_macos:file:${target}:document`,
      projectionVersion: '1', selectorSchemaVersion: '1',
      ownedFragmentHash: 'exact', desiredFragmentHash: 'exact', observedFragmentHash: 'exact',
      state: 'needs_recovery',
    }, T0)
    repository.upsertComponent({
      installationId: 'installation-1', componentKey: 'memory_tools', desiredState: 'unmanaged',
      desiredCapability: 0, deliveryMode: 'managed', verificationStatus: 'unverified',
      artifactId: 'legacy-mcp', visibilityState: 'dedicated',
    }, T0)
    db.prepare(`INSERT INTO artifact_consumers (
      artifact_id, installation_id, component_key, required_capability, desired_state,
      discover_reachability, state, added_at, updated_at
    ) VALUES ('legacy-mcp', 'installation-1', 'memory_tools', 0, 'disabled', 'dedicated', 'active', ?, ?)`)
      .run(T0, T0)
    preview.mockImplementation(async (request: PreviewRequest) => {
      const base = plan(request)
      return {
        ...base,
        componentKeys: ['memory_tools'],
        inspection: {
          ...base.inspection,
          components: [{
            componentKey: 'memory_tools' as const,
            visibility: 'dedicated' as const,
            verificationStatus: 'unverified' as const,
            observedTarget: target,
            observedFragmentHash: 'exact',
          }],
        },
        executionPlan: { ...base.executionPlan, mutations: [] },
        executionPlanHash: 'noop-execution-hash',
      }
    })

    const prepared = await service.previewConnect(['installation-1'])
    expect(prepared.installations[0].targets).toEqual([expect.objectContaining({
      componentKey: 'memory_tools', action: 'invoke', targetLabel: '~/.cursor/mcp.json',
      commandCategory: 'file_write', risk: 'low',
    })])
    const applied = await service.applyConnect(prepared.planHash, ['installation-1'])
    expect(applied.results[0].status).toBe('committed')
    const consent = db.prepare(`SELECT allowed_scopes_json, normalized_targets_json,
      selector_resolution_json, command_categories_json FROM agent_consents`).get() as Record<string, string>
    expect(JSON.parse(consent.normalized_targets_json)).toContain(target)
    expect(JSON.parse(consent.command_categories_json)).toContain('file_write')
    expect(JSON.stringify(consent)).toContain('mcpServers.tidemind-eb_test')
  })

  it('re-inspects immediately before consent and rejects changed no-op evidence', async () => {
    const { db, service, preview } = setup()
    const initial = plan({
      installation: {} as never, operation: 'connect', componentKeys: ['memory_tools'], desiredCapability: 2,
    })
    preview
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        inspection: { ...initial.inspection, diagnostics: ['configuration_changed'] },
      })
    const prepared = await service.previewConnect(['installation-1'])
    const applied = await service.applyConnect(prepared.planHash, ['installation-1'])
    expect(applied.results[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/changed after preview/) })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
  })

  it('rejects a cached plan before persisting consent when fresh discovery becomes uncertain', async () => {
    const { db, repository, service, applyPrepared } = setup()
    const preview = await service.previewConnect(['installation-1'])
    repository.markInstallationProbeUncertain('installation-1', T0, ['probe_inaccessible'])

    const result = await service.applyConnect(preview.planHash, ['installation-1'])

    expect(result.results[0]).toMatchObject({ installationId: 'installation-1', status: 'failed' })
    expect(applyPrepared).not.toHaveBeenCalled()
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
  })

  it('only exposes sanitized command details after an explicit technical preview', async () => {
    const { service, preview } = setup()
    preview.mockImplementationOnce(async request => {
      const prepared = plan(request)
      prepared.executionPlan.mutations[0] = {
        ...prepared.executionPlan.mutations[0],
        action: 'invoke',
        targetPath: null,
        commandCategory: 'host_cli',
        command: {
          category: 'host_cli',
          executablePath: '/Users/alice/bin/agent',
          args: [
            'install',
            '--token',
            'very-secret-token-value',
            'sk-secret0123456789',
            '--password=inline-secret-value',
            'api_key=lowercase-secret-value',
          ],
        },
      }
      return prepared
    })

    const technical = await service.previewConnect(['installation-1'], true)
    expect(technical.installations[0].targets[0]).toMatchObject({
      executableLabel: '~/bin/agent',
      args: [
        'install',
        '--token',
        '<redacted>',
        '<redacted>',
        '--password=<redacted>',
        'api_key=<redacted>',
      ],
    })
    expect(JSON.stringify(technical)).not.toContain('very-secret-token-value')
    expect(JSON.stringify(technical)).not.toContain('inline-secret-value')
    expect(JSON.stringify(technical)).not.toContain('lowercase-secret-value')
  })

  it('reopens the exact frozen plan for technical details without replanning', async () => {
    const { service, preview } = setup()
    const confirmed = await service.previewConnect(['installation-1'], false)

    const technical = await service.previewConnect(
      ['installation-1'],
      true,
      confirmed.planHash,
    )

    expect(technical.planHash).toBe(confirmed.planHash)
    expect(technical.expiresAt).toBe(confirmed.expiresAt)
    expect(technical.installations[0].targets[0].selector).toBe('mcpServers.tidemind-eb_test')
    expect(preview).toHaveBeenCalledOnce()
  })

  it('routes disconnect through a separate frozen plan and keeps pause/resume semantic', async () => {
    const afterDisconnect = vi.fn(async () => {})
    const { db, repository, service, preview } = setup(undefined, '/Users/alice', afterDisconnect)
    repository.setInstallationIntent('installation-1', 'managed', T0)
    db.prepare(`
      INSERT INTO managed_artifacts (
        id, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, owned_fragment_hash,
        desired_fragment_hash, state, created_at, updated_at
      ) VALUES ('artifact-1', 'mcp', '/Users/alice/.cursor/mcp.json',
        'mcpServers.tidemind-eb_test', 'domain-1', '1', '1', 'desired', 'desired',
        'healthy', ?, ?)
    `).run(T0, T0)
    db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, desired_capability,
        delivery_mode, artifact_id, created_at, updated_at
      ) VALUES ('installation-1', 'memory_tools', 'managed', 3, 'managed', 'artifact-1', ?, ?)
    `).run(T0, T0)
    db.prepare(`
      INSERT INTO artifact_consumers (
        artifact_id, installation_id, component_key, required_capability,
        desired_state, discover_reachability, state, added_at, updated_at
      ) VALUES ('artifact-1', 'installation-1', 'memory_tools', 3,
        'managed', 'dedicated', 'active', ?, ?)
    `).run(T0, T0)
    const paused = service.pause('installation-1')
    expect(paused.desiredState).toBe('disabled')
    expect(service.resume('installation-1').desiredState).toBe('managed')

    const disconnect = await service.previewDisconnect('installation-1')
    expect(disconnect.operation).toBe('disconnect')
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'disconnect' }))
    await service.disconnect(disconnect.planHash, 'installation-1')
    expect(afterDisconnect).toHaveBeenCalledTimes(1)

    repository.setInstallationIntent('installation-1', 'removed', T0, 'user_disconnect')
    expect(() => service.resume('installation-1')).toThrow(/only a paused Installation/)
  })

  it('keeps a committed disconnect truthful when immediate maintenance scheduling fails', async () => {
    const { db, repository, service } = setup(
      undefined,
      '/Users/alice',
      async () => { throw new Error('scheduler unavailable') },
    )
    repository.setInstallationIntent('installation-1', 'managed', T0)
    db.prepare(`
      INSERT INTO managed_artifacts (
        id, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, owned_fragment_hash,
        desired_fragment_hash, state, created_at, updated_at
      ) VALUES ('artifact-maintenance', 'mcp', '/Users/alice/.cursor/mcp.json',
        'mcpServers.tidemind-eb_test', 'domain-maintenance', '1', '1', 'desired', 'desired',
        'healthy', ?, ?)
    `).run(T0, T0)
    db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, desired_capability,
        delivery_mode, artifact_id, created_at, updated_at
      ) VALUES ('installation-1', 'memory_tools', 'managed', 3, 'managed', 'artifact-maintenance', ?, ?)
    `).run(T0, T0)
    db.prepare(`
      INSERT INTO artifact_consumers (
        artifact_id, installation_id, component_key, required_capability,
        desired_state, discover_reachability, state, added_at, updated_at
      ) VALUES ('artifact-maintenance', 'installation-1', 'memory_tools', 3,
        'managed', 'dedicated', 'active', ?, ?)
    `).run(T0, T0)

    const preview = await service.previewDisconnect('installation-1')
    const result = await service.disconnect(preview.planHash, 'installation-1')
    expect(result.results).toEqual([expect.objectContaining({ status: 'committed' })])
    expect(db.prepare(`
      SELECT kind FROM agent_integration_events
      WHERE installation_id = 'installation-1' AND kind = 'post_disconnect_maintenance_failed'
    `).get()).toEqual({ kind: 'post_disconnect_maintenance_failed' })
  })

  it('labels a shared disconnect as detach-only and freezes every active consumer', async () => {
    const { db, repository, service, applyPrepared } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'installation-2',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: 'cursor:second',
      provenance: 'test',
      displayName: 'Cursor Second',
      agentId: 'eb_second',
      supportedCapability: 4,
      lastDetectedAt: T0,
    })
    db.prepare(`
      INSERT INTO managed_artifacts (
        id, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, owned_fragment_hash,
        desired_fragment_hash, state, created_at, updated_at
      ) VALUES ('shared-mcp', 'mcp', '/Users/alice/.cursor/mcp.json',
        'mcpServers.tidemind-eb_test', 'domain-shared', '1', '1', 'desired',
        'desired', 'healthy', ?, ?)
    `).run(T0, T0)
    for (const installationId of ['installation-1', 'installation-2']) {
      repository.setInstallationIntent(installationId, 'managed', T0)
      db.prepare(`
        INSERT INTO installation_components (
          installation_id, component_key, desired_state, desired_capability,
          delivery_mode, artifact_id, created_at, updated_at
        ) VALUES (?, 'memory_tools', 'managed', 3, 'managed', 'shared-mcp', ?, ?)
      `).run(installationId, T0, T0)
      db.prepare(`
        INSERT INTO artifact_consumers (
          artifact_id, installation_id, component_key, required_capability,
          desired_state, discover_reachability, state, added_at, updated_at
        ) VALUES ('shared-mcp', ?, 'memory_tools', 3, 'managed', 'shared_visible', 'active', ?, ?)
      `).run(installationId, T0, T0)
    }

    const preview = await service.previewDisconnect('installation-1')
    expect(preview.installations[0].targets[0]).toMatchObject({
      action: 'detach',
      sharedImpact: {
        outcome: 'consumer_detach_only',
        remainsVisibleForCurrentInstallation: true,
        consumers: [
          { installationId: 'installation-1', displayName: 'Cursor' },
          { installationId: 'installation-2', displayName: 'Cursor Second' },
        ],
      },
    })

    const result = await service.disconnect(preview.planHash, 'installation-1')
    expect(result.results).toEqual([expect.objectContaining({
      installationId: 'installation-1',
      status: 'committed',
      completion: 'detached_shared_visible',
    })])
    expect(applyPrepared).toHaveBeenLastCalledWith(expect.objectContaining({
      disconnectScopeExpectations: [{
        componentKey: 'memory_tools',
        physicalTarget: '/Users/alice/.cursor/mcp.json',
        ownershipKey: 'mcpServers.tidemind-eb_test',
        consumerKeys: ['installation-1\0memory_tools', 'installation-2\0memory_tools'],
      }],
    }))
  })

  it('freezes and confirms the full shared scope before resetting automatic repair', async () => {
    const { db, repository, service } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'installation-2', family: 'cursor', hostVariant: 'cursor-desktop',
      installKey: 'cursor:second', provenance: 'fixture', displayName: 'Cursor Second',
      agentId: 'agent-second', supportedCapability: 4, lastDetectedAt: T0,
    })
    for (const installationId of ['installation-1', 'installation-2']) {
      repository.createConsent({
        id: `consent-${installationId}`, installationId, policyVersion: '1',
        allowedComponents: ['instruction'], allowedScopes: ['/tmp/shared-skill'],
        normalizedTargets: ['/tmp/shared-skill'], selectorSchemaVersion: '1',
        selectorResolution: { document: 'document' }, executableRealpaths: [],
        commandCategories: ['file_write'], maximumRisk: 'low', confirmedAt: T0,
      })
      repository.setInstallationIntent(installationId, 'managed', T0)
      db.prepare(`UPDATE agent_installations SET consent_envelope_id = ? WHERE id = ?`)
        .run(`consent-${installationId}`, installationId)
    }
    repository.createManagedArtifact({
      id: 'shared-circuit', componentType: 'skill', targetPath: '/tmp/shared-skill',
      ownershipKey: 'document', mutationDomain: 'local_macos:file:/tmp/shared-skill:document',
      projectionVersion: '1', selectorSchemaVersion: '1', ownedFragmentHash: 'shared-desired',
      desiredFragmentHash: 'shared-desired', observedFragmentHash: 'shared-desired',
    }, T0)
    for (const installationId of ['installation-1', 'installation-2']) {
      repository.upsertComponent({
        installationId, componentKey: 'instruction', desiredState: 'managed', desiredCapability: 1,
        deliveryMode: 'managed', artifactId: 'shared-circuit', visibilityState: 'shared_visible',
        consentEnvelopeId: `consent-${installationId}`,
      }, T0)
      repository.addArtifactConsumer({
        artifactId: 'shared-circuit', installationId, componentKey: 'instruction',
        requiredCapability: 1, discoverReachability: 'shared_visible',
        consentEnvelopeId: `consent-${installationId}`, ownershipFingerprint: 'shared-desired',
        addedAt: T0,
      })
    }
    repository.beginMissingEpisode({ artifactId: 'shared-circuit', episodeId: 'first', observedAt: T0 })
    repository.markArtifactHealthyAfterReadback('shared-circuit', '2026-08-25T00:01:00.000Z')
    repository.beginMissingEpisode({
      artifactId: 'shared-circuit', episodeId: 'second', observedAt: '2026-08-25T01:00:00.000Z',
    })

    const preview = service.previewResetAutoRestore('installation-1')
    expect(preview.artifactCount).toBe(1)
    expect(preview.affectedInstallations.map(item => item.installationId)).toEqual([
      'installation-1',
      'installation-2',
    ])
    await expect(service.resetAutoRestore('f'.repeat(64), 'installation-1')).rejects.toThrow(/confirmation/)
    await expect(service.resetAutoRestore(preview.planHash, 'installation-1')).resolves.toMatchObject({
      id: 'installation-1',
      statusReason: 'verification_stale',
    })
  })

  it('delegates an approved tombstoned reconnect to the coordinator without reopening in the service', async () => {
    const { db, repository, service, applyPrepared } = setup()
    repository.createConsent({
      id: 'old-consent',
      installationId: 'installation-1',
      policyVersion: '1',
      allowedComponents: ['memory_tools'],
      allowedScopes: ['/Users/alice/.cursor/mcp.json'],
      normalizedTargets: ['/Users/alice/.cursor/mcp.json'],
      selectorSchemaVersion: '1',
      selectorResolution: { memory: 'mcpServers.tidemind-eb_test' },
      executableRealpaths: [],
      commandCategories: ['file_write'],
      maximumRisk: 'low',
      confirmedAt: T0,
    })
    repository.setInstallationIntent('installation-1', 'removed', T0, 'user_disconnect')

    const preview = await service.previewConnect(['installation-1'])
    expect(repository.getInstallation('installation-1')?.desired_state).toBe('removed')
    await service.applyConnect(preview.planHash, ['installation-1'])

    expect(applyPrepared).toHaveBeenCalledOnce()
    expect(repository.getInstallation('installation-1')).toMatchObject({
      desired_state: 'removed',
      tombstoned_at: T0,
    })
    expect(applyPrepared).toHaveBeenCalledWith(expect.objectContaining({
      installation: expect.objectContaining({ desiredState: 'removed' }),
    }))
    expect(db.prepare(`SELECT status FROM agent_consents WHERE id = 'old-consent'`).get())
      .toEqual({ status: 'active' })
    expect(db.prepare(`SELECT status FROM agent_consents WHERE id = 'consent-1'`).get())
      .toEqual({ status: 'active' })
  })

  it('does not reopen a tombstoned Installation when reconnect evidence changed after preview', async () => {
    const { repository, service, preview, applyPrepared } = setup()
    repository.setInstallationIntent('installation-1', 'removed', T0, 'user_disconnect')

    const approved = await service.previewConnect(['installation-1'])
    preview.mockImplementationOnce(async request => ({
      ...plan(request),
      inspection: {
        ...plan(request).inspection,
        diagnostics: ['configuration changed after approval'],
      },
    }))
    const result = await service.applyConnect(approved.planHash, ['installation-1'])

    expect(result.results[0]).toMatchObject({ status: 'failed' })
    expect(applyPrepared).not.toHaveBeenCalled()
    expect(repository.getInstallation('installation-1')).toMatchObject({
      desired_state: 'removed',
      tombstoned_at: T0,
    })
  })

  it('coalesces concurrent scans and persists a stable identity only once', async () => {
    const { repository } = setup()
    const report = {
      installations: [{
        catalogId: 'kimi-code-cli' as const,
        displayName: 'Kimi Code',
        identity: {
          runtimeRealm: 'local_macos' as const,
          osUserIdentity: '501',
          productFamilyId: 'kimi-code',
          hostVariant: 'kimi-code-cli' as const,
          canonicalConfigRoot: '/Users/alice/.kimi-code',
          explicitProfile: 'default',
          distribution: { executableRealpath: '/usr/local/bin/kimi' },
          installKey: 'kimi:default',
        },
        configRoot: '/Users/alice/.kimi-code',
        executablePath: '/usr/local/bin/kimi',
        provenance: ['test'],
        evidence: [],
      }],
      unresolved: [],
      diagnostics: [],
    }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const scanner = { scan: vi.fn(async () => { await gate; return report }) }
    const service = new AgentIntegrationService({
      repository,
      scanner,
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(T0),
      installationId: () => 'installation-kimi',
      agentId: () => 'eb_kimi',
      homeDir: '/Users/alice',
    })
    const first = service.scan()
    const second = service.scan()
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(scanner.scan).toHaveBeenCalledTimes(1)
    expect(repository.getInstallation('installation-kimi')?.agent_id).toBe('eb_kimi')
  })

  it('persists and delivers a first-discovery action while ordinary info remains non-actionable', async () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    const deliver = vi.fn(async () => undefined)
    const service = new AgentIntegrationService({
      repository,
      scanner: {
        scan: async () => ({
          installations: [{
            catalogId: 'kimi-code-cli' as const,
            displayName: 'Kimi Code',
            identity: {
              runtimeRealm: 'local_macos' as const,
              osUserIdentity: '501',
              productFamilyId: 'kimi-code',
              hostVariant: 'kimi-code-cli' as const,
              canonicalConfigRoot: '/Users/alice/.kimi-code',
              explicitProfile: 'default',
              distribution: {
                distributionId: 'kimi-code-cli',
                executableRealpath: '/usr/local/bin/kimi',
                packageProvenance: 'npm:@moonshot-ai/kimi-code',
                capabilityFingerprint: 'cli-surface:kimi-code-cli',
              },
              installKey: 'kimi:default',
            },
            configRoot: '/Users/alice/.kimi-code',
            executablePath: '/usr/local/bin/kimi',
            provenance: ['test'],
            evidence: [],
          }],
          unresolved: [],
          diagnostics: [],
        }),
      },
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(T0),
      installationId: () => 'installation-kimi',
      agentId: () => 'eb_kimi',
      homeDir: '/Users/alice',
      notifications: { deliver },
      notificationLocale: 'zh-CN',
    })

    const scan = await service.scan()
    expect(scan.newlyDiscoveredCount).toBe(1)
    expect(service.inbox()).toMatchObject({
      unreadCount: 1,
      actionableUnreadCount: 1,
      startupUnreadCount: 1,
    })
    expect(service.inbox().events[0]).toMatchObject({
      installationId: 'installation-kimi',
      kind: 'installation_discovered_awaiting_consent',
      severity: 'info',
    })
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 'installation-kimi',
      title: '发现新的本机 Agent',
      actions: ['view_details'],
    }))

    repository.recordEvent({
      id: 'auto-restored-info',
      installationId: 'installation-kimi',
      kind: 'artifact_auto_restored',
      severity: 'info',
      payload: {},
      createdAt: '2026-08-25T00:01:00.000Z',
    })
    repository.recordEvent({
      id: 'ordinary-info',
      installationId: 'installation-kimi',
      kind: 'scan_completed',
      severity: 'info',
      payload: {},
      createdAt: '2026-08-25T00:02:00.000Z',
    })
    expect(service.inbox()).toMatchObject({
      unreadCount: 3,
      actionableUnreadCount: 1,
      startupUnreadCount: 2,
      startupEvents: [
        { id: 'auto-restored-info', kind: 'artifact_auto_restored' },
        { kind: 'installation_discovered_awaiting_consent' },
      ],
    })
    expect(service.inbox().startupEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ordinary-info' }),
    ]))
    db.close()
  })

  it('does not announce a row that identity matching calls new but the unique install key reuses', async () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    repository.upsertDiscoveredInstallation({
      id: 'persisted-kimi', family: 'kimi-code', hostVariant: 'kimi-code-cli',
      installKey: 'kimi-code-cli:persisted-kimi', provenance: 'legacy-fixture',
      displayName: 'Kimi Code', configRoot: '/Users/alice/.persisted-kimi',
      supportedCapability: 4, lastDetectedAt: T0,
    })
    const deliver = vi.fn(async () => undefined)
    const service = new AgentIntegrationService({
      repository,
      scanner: {
        scan: async () => ({
          installations: [{
            catalogId: 'kimi-code-cli' as const,
            displayName: 'Kimi Code',
            identity: {
              runtimeRealm: 'local_macos' as const,
              osUserIdentity: 'ui-audit-user',
              productFamilyId: 'kimi-code',
              hostVariant: 'kimi-code-cli' as const,
              canonicalConfigRoot: '/Users/alice/.persisted-kimi',
              explicitProfile: 'default',
              distribution: { distributionId: 'audit.kimi-code-cli' },
              installKey: 'kimi-code-cli:persisted-kimi',
            },
            configRoot: '/Users/alice/.persisted-kimi',
            provenance: ['test'], evidence: [],
          }],
          unresolved: [], diagnostics: [],
        }),
      },
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(T0),
      installationId: () => 'would-be-new-id',
      agentId: () => 'would-be-new-agent',
      homeDir: '/Users/alice',
      notifications: { deliver },
    })

    expect((await service.scan()).newlyDiscoveredCount).toBe(0)
    expect(repository.listInstallations()).toHaveLength(1)
    expect(service.inbox()).toMatchObject({ unreadCount: 0, actionableUnreadCount: 0 })
    expect(deliver).not.toHaveBeenCalled()
    db.close()
  })

  it('preserves the Installation ID when a stable host identity moves its config root', async () => {
    const { db, repository } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'stable-installation', family: 'cursor', hostVariant: 'cursor-desktop',
      installKey: 'cursor:old-root', provenance: 'fixture', osUserIdentity: '501',
      distributionId: 'cursor-stable-distribution',
      displayName: 'Cursor', configRoot: '/Users/alice/.cursor-old', supportedCapability: 4,
      detectedVersion: '1.0.0', agentId: 'agent-stable',
      lastDetectedAt: T0, metadata: { hostOwnedIdentity: 'cursor-profile-owner' },
    })
    repository.createManagedArtifact({
      id: 'artifact-old-root', componentType: 'mcp',
      targetPath: '/Users/alice/.cursor-old/mcp.json', ownershipKey: 'mcpServers.tidemind',
      mutationDomain: 'local_macos:file:/Users/alice/.cursor-old/mcp.json:mcpServers.tidemind',
      projectionVersion: '1', selectorSchemaVersion: '1', ownedFragmentHash: 'desired-old',
      desiredFragmentHash: 'desired-old', observedFragmentHash: 'desired-old',
    }, T0)
    repository.upsertComponent({
      installationId: 'stable-installation', componentKey: 'memory_tools', desiredState: 'managed',
      desiredCapability: 2, deliveryMode: 'managed', verificationStatus: 'verified',
      artifactId: 'artifact-old-root', visibilityState: 'dedicated',
    }, T0)
    repository.recordVerificationResult({
      id: 'verification-old-root', installationId: 'stable-installation', componentKey: 'memory_tools',
      family: 'cursor', hostVariant: 'cursor-desktop', runtimeRealm: 'local_macos',
      hostVersion: '1.0.0', adapterVersion: '1', catalogVersion: '1', projectionVersion: '1',
      selectorSchemaVersion: '1', verificationManifestVersion: '1', method: 'fixture',
      identityAssertion: 'agent-stable', artifactHash: 'desired-old', result: 'verified',
      evidenceHash: 'evidence-old-root', verifiedAt: T0,
    })
    db.prepare(`
      UPDATE agent_installations
      SET verified_capability = 2, verification_summary = 'verified', status_reason = 'verified'
      WHERE id = 'stable-installation'
    `).run()
    const scanner = { scan: vi.fn(async () => ({
      installations: [{
        catalogId: 'cursor-desktop' as const,
        displayName: 'Cursor',
        identity: {
          runtimeRealm: 'local_macos' as const,
          osUserIdentity: '501',
          productFamilyId: 'cursor',
          hostVariant: 'cursor-desktop' as const,
          canonicalConfigRoot: '/Users/alice/.cursor-new',
          explicitProfile: 'default',
          hostOwnedIdentity: 'cursor-profile-owner',
          distribution: { distributionId: 'cursor-stable-distribution' },
          installKey: 'cursor:new-root',
        },
        configRoot: '/Users/alice/.cursor-new',
        detectedVersion: '2.0.0',
        provenance: ['fixture'],
        evidence: [],
      }],
      unresolved: [], diagnostics: [],
    })) }
    const service = new AgentIntegrationService({
      repository,
      scanner,
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(T0),
      homeDir: '/Users/alice',
    })

    await service.scan()

    expect(repository.getInstallation('stable-installation')).toMatchObject({
      install_key: 'cursor:new-root',
      config_root: '/Users/alice/.cursor-new',
      health_state: 'discovered',
      verified_capability: 0,
      verification_summary: 'stale',
      status_reason: 'verification_stale',
    })
    expect(repository.listInstallationEvents('stable-installation').some(event => (
      event.kind === 'host_installation_surface_changed'
    ))).toBe(true)
    expect(repository.listInstallationIdentityRecords()
      .find(record => record.installationId === 'stable-installation')?.aliasInstallKeys)
      .toContain('cursor:old-root')
    expect(repository.listInstallations()).toHaveLength(2)
  })

  it('does not transfer consent or identity across conflicting distribution evidence', async () => {
    const { repository } = setup()
    const scanner = { scan: vi.fn(async () => ({
      installations: [{
        catalogId: 'cursor-desktop' as const,
        displayName: 'Cursor replacement',
        identity: {
          runtimeRealm: 'local_macos' as const,
          osUserIdentity: '501',
          productFamilyId: 'cursor',
          hostVariant: 'cursor-desktop' as const,
          canonicalConfigRoot: '/Users/alice/.cursor',
          explicitProfile: 'default',
          distribution: {
            distributionId: 'different-distribution',
            executableRealpath: '/Applications/Other.app/Contents/MacOS/Other',
          },
          installKey: 'cursor:default',
        },
        configRoot: '/Users/alice/.cursor',
        executablePath: '/Applications/Other.app/Contents/MacOS/Other',
        provenance: ['replacement'],
        evidence: [],
      }],
      unresolved: [],
      diagnostics: [],
    })) }
    const service = new AgentIntegrationService({
      repository,
      scanner,
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(T0),
      homeDir: '/Users/alice',
    })

    await service.scan()

    expect(repository.getInstallation('installation-1')).toMatchObject({
      executable_path: '/Applications/Cursor.app/Contents/MacOS/Cursor',
      reconcile_state: 'paused',
      status_reason: 'conflict',
      verified_capability: 0,
    })
    expect(repository.listInstallationEvents('installation-1').some(event =>
      event.kind === 'discovery_identity_conflict')).toBe(true)
  })

  it('invalidates an absent host only after an authoritative scan, not an inaccessible probe', async () => {
    const certain = setup()
    const certainService = new AgentIntegrationService({
      repository: certain.repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(T0),
      homeDir: '/Users/alice',
    })
    await certainService.scan()
    expect(certain.repository.getInstallation('installation-1')?.status_reason).toBe('verification_stale')
    expect(certainService.snapshot()).toMatchObject({
      installations: [expect.objectContaining({ id: 'installation-1' })],
      historyInstallations: [],
    })
    await certainService.scan()
    expect(certain.repository.getInstallation('installation-1')?.status_reason).toBe('host_uninstalled')
    const historicalSnapshot = certainService.snapshot()
    expect(historicalSnapshot).toMatchObject({
      families: [],
      installations: [],
      historyInstallations: [expect.objectContaining({
        id: 'installation-1',
        manageable: false,
        statusGroup: 'disconnected',
        statusReason: 'host_uninstalled',
        accessIsHistorical: true,
      })],
      summary: {
        familyCount: 0,
        installationCount: 0,
        availableCount: 0,
        needsAttentionCount: 0,
        awaitingConnectionCount: 0,
      },
    })
    expect(certainService.detail('installation-1')).toMatchObject({
      installation: {
        id: 'installation-1',
        manageable: false,
        statusGroup: 'disconnected',
        statusReason: 'host_uninstalled',
      },
      events: expect.arrayContaining([
        expect.objectContaining({ kind: 'host_uninstalled' }),
      ]),
    })

    const uncertain = setup()
    const uncertainService = new AgentIntegrationService({
      repository: uncertain.repository,
      scanner: { scan: async () => ({
        installations: [],
        unresolved: [{
          catalogIds: ['cursor-desktop'],
          reason: 'probe_inaccessible',
          summary: 'permission denied',
          evidence: [],
        }],
        diagnostics: [],
      }) },
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(T0),
      homeDir: '/Users/alice',
    })
    await uncertainService.scan()
    expect(uncertain.repository.getInstallation('installation-1')).toMatchObject({
      health_state: 'inaccessible',
      status_reason: 'verification_stale',
    })
  })

  it('persists the actual successful scan time even when no Installation is detected', async () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    const service = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date('2026-08-25T03:04:05.000Z'),
      homeDir: '/Users/alice',
    })

    expect(service.snapshot().lastScanAt).toBeNull()
    await service.scan()
    expect(service.snapshot().lastScanAt).toBe('2026-08-25T03:04:05.000Z')

    const afterRestart = new AgentIntegrationService({
      repository: new AgentIntegrationRepository(db),
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      homeDir: '/Users/alice',
    })
    expect(afterRestart.snapshot().lastScanAt).toBe('2026-08-25T03:04:05.000Z')
  })

  it('moves a disconnected Installation to history after a later authoritative uninstall', async () => {
    const { db, repository } = setup()
    db.prepare(`
      UPDATE agent_installations
      SET desired_state = 'removed', tombstoned_at = ?, tombstone_reason = 'user_disconnect',
          status_reason = 'disconnect_verified'
      WHERE id = 'installation-1'
    `).run(T0)
    let scannedAt = '2026-08-25T01:00:00.000Z'
    const service = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: { preview: vi.fn(), applyPrepared: vi.fn() },
      now: () => new Date(scannedAt),
      homeDir: '/Users/alice',
    })

    await service.scan()
    expect(repository.getInstallation('installation-1')).toMatchObject({
      desired_state: 'removed',
      health_state: 'inaccessible',
      status_reason: 'disconnect_verified',
    })
    scannedAt = '2026-08-25T02:00:00.000Z'
    await service.scan()

    expect(service.snapshot()).toMatchObject({
      installations: [],
      historyInstallations: [expect.objectContaining({
        id: 'installation-1',
        statusReason: 'host_uninstalled',
        accessIsHistorical: true,
      })],
      lastScanAt: scannedAt,
    })
  })
})
