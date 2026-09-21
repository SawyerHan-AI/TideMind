import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createP0HostAdapters, portableSkillContent } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { createClaudeCodePluginHostAdapter } from '../../client/electron/agent-integration/hosts/claude-code-plugin-adapter'
import { createGeminiExtensionHostAdapter } from '../../client/electron/agent-integration/hosts/gemini-extension-adapter'
import { adoptProvableLegacyConnections } from '../../client/electron/agent-integration/legacy-adoption'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { AgentIntegrationService } from '../../client/electron/agent-integration/service'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterRuntimeContext, AdoptableArtifactObservation } from '../../client/electron/agent-integration/types'
import { ensureSchema } from '../../src/db/schema.js'
import { touchAgent } from '../../src/db/agents.js'

const T0 = '2026-08-25T10:00:00.000Z'

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _parameter: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

describe('legacy Agent adoption', () => {
  let root: string
  let db: Database.Database
  let repository: AgentIntegrationRepository
  let runtime: AdapterRuntimeContext

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-adoption-'))
    db = new Database(':memory:')
    ensureSchema(db)
    repository = new AgentIntegrationRepository(db)
    runtime = {
      runtimeRealm: 'local_macos',
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      shimPath: path.join(root, 'Tide Mind.app', 'tm-node'),
      mcpServerPath: path.join(root, 'Tide Mind.app', 'mcp-server.cjs'),
      hookScriptPath: path.join(root, 'Tide Mind.app', 'hook.cjs'),
      preCompactScriptPath: path.join(root, 'Tide Mind.app', 'pre.cjs'),
      postCompactScriptPath: path.join(root, 'Tide Mind.app', 'post.cjs'),
      tideMindVersion: 'test',
      catalogVersion: '1.0.0',
      projectionVersion: '1',
    }
  })

  afterEach(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function legacy(id = 'eb_legacy01', archived = 0): void {
    db.prepare(`
      INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES (?, 'Legacy Cursor', 'cursor', ?, ?)
    `).run(id, archived, T0)
  }

  function legacyKimi(id = 'eb_kimi_legacy', archived = 0): void {
    db.prepare(`
      INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES (?, 'Legacy Kimi', 'kimi-code', ?, ?)
    `).run(id, archived, T0)
  }

  function kimiInstallation(id = 'kimi-1', configRoot = path.join(root, '.kimi-code')): void {
    repository.upsertDiscoveredInstallation({
      id,
      family: 'kimi-code',
      hostVariant: 'kimi-code-cli',
      runtimeRealm: 'local_macos',
      installKey: `kimi-code:${id}`,
      distributionId: 'cli:kimi-code-cli',
      provenance: 'npm_metadata:@moonshot-ai/kimi-code',
      displayName: 'Kimi Code',
      configRoot,
      agentId: `generated-${id}`,
      supportedCapability: 4,
      lastDetectedAt: T0,
    })
  }

  function exactLegacyKimi091(
    configRoot: string,
    agentId = 'eb_kimi_legacy',
    mutateCommand: (command: string) => string = command => command,
  ): void {
    fs.mkdirSync(configRoot, { recursive: true })
    fs.writeFileSync(path.join(configRoot, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        [`tidemind-${agentId}`]: {
          command: runtime.shimPath,
          args: [runtime.mcpServerPath],
          env: { EB_AGENT_ID: agentId },
        },
      },
    }, null, 2)}\n`)
    const skillPath = path.join(configRoot, 'skills', `tidemind-${agentId}`, 'SKILL.md')
    fs.mkdirSync(path.dirname(skillPath), { recursive: true })
    const legacyBody = fs.readFileSync(path.resolve('data', 'skill', 'kimi-code-skill.md'), 'utf8')
    fs.writeFileSync(skillPath, [
      '---',
      `name: tidemind-${agentId}`,
      `description: ${JSON.stringify('Tide Mind 外部记忆系统。用户上下文在每次会话开始时通过 Hook 自动加载（在第一条消息前注入）。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。')}`,
      '---',
      '',
    ].join('\n') + legacyBody)
    const command = mutateCommand([
      JSON.stringify(runtime.shimPath),
      JSON.stringify(runtime.hookScriptPath),
      '--agent-id', JSON.stringify(agentId),
      '--skill-path', JSON.stringify(skillPath),
      '--tool', JSON.stringify('kimi-code'),
      '--once-per-session',
    ].join(' '))
    fs.writeFileSync(path.join(configRoot, 'config.toml'), [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(command)}`,
      'timeout = 30',
      '',
    ].join('\n'))
  }

  function customLegacy(
    toolType: 'other' | `custom-${string}`,
    id = 'eb_custom01',
    archived = 0,
  ): void {
    db.prepare(`
      INSERT INTO agents (id, name, tool_type, archived, last_active, created)
      VALUES (?, 'Legacy Custom Agent', ?, ?, '2026-08-25T09:59:00.000Z', ?)
    `).run(id, toolType, archived, T0)
  }

  function installation(id = 'cursor-1', configRoot = path.join(root, '.cursor')): void {
    repository.upsertDiscoveredInstallation({
      id,
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos',
      installKey: `cursor:${id}`,
      distributionId: 'com.todesktop.230313mzl4w4u92',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      configRoot,
      agentId: `generated-${id}`,
      supportedCapability: 4,
      lastDetectedAt: T0,
    })
  }

  function exactMcp(
    configRoot: string,
    agentId = 'eb_legacy01',
    options: {
      hostVariant?: string
      command?: string
      extraEntry?: Record<string, unknown>
    } = {},
  ): void {
    fs.mkdirSync(configRoot, { recursive: true })
    fs.writeFileSync(path.join(configRoot, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        [`tidemind-${agentId}`]: {
          command: options.command ?? runtime.shimPath,
          args: [runtime.mcpServerPath],
          env: {
            EB_AGENT_ID: agentId,
            ...(options.hostVariant === undefined ? {} : { EB_HOST_VARIANT: options.hostVariant }),
          },
          ...options.extraEntry,
        },
      },
    }, null, 2)}\n`)
  }

  it.each([false, true])('preserves legacy authority through real scans and a SQLite restart (identity conflict: %s)', async conflict => {
    const databasePath = path.join(root, 'scan-adoption.sqlite')
    let physicalDb = new Database(databasePath)
    ensureSchema(physicalDb)
    let scanRepository = new AgentIntegrationRepository(physicalDb)
    const configRoot = path.join(root, '.cursor')
    exactMcp(configRoot)
    const initialHostBytes = fs.readFileSync(path.join(configRoot, 'mcp.json'))
    physicalDb.prepare(`INSERT INTO agents (id, name, tool_type, created)
      VALUES ('eb_legacy01', 'Legacy Cursor', 'cursor', ?)`).run(T0)
    const identity = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos', osUserIdentity: 'scan-test-user',
      productFamilyId: 'cursor', hostVariant: 'cursor-desktop', configRoot,
      distribution: { distributionId: 'com.todesktop.230313mzl4w4u92' },
    })
    const adapters = createP0HostAdapters()
    const createService = () => new AgentIntegrationService({
      repository: scanRepository,
      scanner: { scan: async () => ({
        installations: [{
          catalogId: 'cursor-desktop' as const, displayName: 'Cursor', identity,
          configRoot, detectedVersion: '1.7.2', provenance: ['bundle_id'], evidence: [],
        }], unresolved: [], diagnostics: [],
      }) },
      execution: {
        preview: async () => { throw new Error('not used') },
        applyPrepared: async () => { throw new Error('not used') },
      },
      afterScan: async () => {
        await adoptProvableLegacyConnections({ repository: scanRepository, adapters, runtime, now: T0 })
      },
      now: () => new Date(T0), homeDir: root,
    })
    try {
      const service = createService()
      await service.scan()
      const first = scanRepository.listInstallations()[0]
      const baseline = JSON.parse(first.metadata_json).legacyAdoption
      expect(baseline).toMatchObject({ evidenceVersion: 2, historicalCapability: 2 })
      if (conflict) {
        scanRepository.markInstallationIdentityConflict(first.id, T0, 'ambiguous_host_identity')
        await adoptProvableLegacyConnections({ repository: scanRepository, adapters, runtime, now: T0 })
        expect(scanRepository.getInstallation(first.id)).toMatchObject({
          verified_capability: 0, status_reason: 'conflict', health_state: 'inaccessible',
        })
      }
      await service.scan()
      physicalDb.close()
      physicalDb = new Database(databasePath)
      ensureSchema(physicalDb)
      scanRepository = new AgentIntegrationRepository(physicalDb)
      await createService().scan()
      const persisted = scanRepository.listInstallations()[0]
      expect(persisted).toMatchObject({
        id: first.id, agent_id: 'eb_legacy01', desired_state: 'unmanaged',
        verified_capability: conflict ? 0 : 2,
        status_reason: conflict ? 'conflict' : 'legacy_callable_unmanaged',
        consent_envelope_id: null, health_state: 'discovered',
      })
      expect(JSON.parse(persisted.metadata_json).legacyAdoption).toEqual(baseline)
      expect(physicalDb.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
      expect(physicalDb.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
      expect(physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE kind = 'legacy_adoption_artifact_changed'`).get()).toEqual({ count: 0 })
      expect(fs.readFileSync(path.join(configRoot, 'mcp.json'))).toEqual(initialHostBytes)
    } finally {
      physicalDb.close()
    }
  })

  it('preserves provable callable legacy access without granting future maintenance consent', async () => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'))

    const first = await adoptProvableLegacyConnections({
      repository,
      adapters: createP0HostAdapters(),
      runtime,
      now: T0,
    })
    expect(first).toMatchObject({ adopted: 1, needsConfirmation: 0 })
    expect(repository.getInstallation('cursor-1')?.agent_id).toBe('eb_legacy01')
    expect(repository.getInstallationByAgentIdOrAlias('eb_legacy01')?.id).toBe('cursor-1')
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT c.component_key, c.desired_state, c.verification_status,
             a.ownership_key, a.state, ac.desired_state AS consumer_state
      FROM installation_components c
      JOIN managed_artifacts a ON a.id = c.artifact_id
      JOIN artifact_consumers ac
        ON ac.artifact_id = a.id AND ac.installation_id = c.installation_id
       AND ac.component_key = c.component_key
      WHERE c.installation_id = 'cursor-1'
    `).all()).toEqual([expect.objectContaining({
      component_key: 'memory_tools',
      desired_state: 'unmanaged',
      verification_status: 'stale',
      ownership_key: 'mcpServers.tidemind-eb_legacy01',
      state: 'needs_recovery',
      consumer_state: 'disabled',
    })])
    expect(db.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
    expect(repository.getInstallation('cursor-1')).toMatchObject({
      desired_state: 'unmanaged',
      consent_envelope_id: null,
      verified_capability: 2,
      verification_summary: 'stale',
      status_reason: 'legacy_callable_unmanaged',
      last_verified_at: T0,
    })
    const service = new AgentIntegrationService({
      repository,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      execution: {
        preview: async () => { throw new Error('not used') },
        applyPrepared: async () => { throw new Error('not used') },
      },
      now: () => new Date(T0),
      homeDir: root,
    })
    expect(service.snapshot().installations).toEqual([
      expect.objectContaining({
        id: 'cursor-1',
        desiredState: 'unmanaged',
        statusGroup: 'available',
        statusReason: 'legacy_callable_unmanaged',
        accessLevel: 'partial',
        accessIsHistorical: true,
        components: expect.arrayContaining([
          expect.objectContaining({ key: 'memory_tools', state: 'verification_stale' }),
        ]),
      }),
    ])

    const second = await adoptProvableLegacyConnections({
      repository,
      adapters: createP0HostAdapters(),
      runtime,
      now: '2026-08-25T10:01:00.000Z',
    })
    expect(second).toMatchObject({ adopted: 0, alreadyAdopted: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get()).toEqual({ count: 1 })
    db.prepare(`UPDATE agent_installations SET desired_state = 'managed' WHERE id = 'cursor-1'`).run()
    const third = await adoptProvableLegacyConnections({
      repository,
      adapters: createP0HostAdapters(),
      runtime,
      now: '2026-08-25T10:02:00.000Z',
    })
    expect(third).toMatchObject({ adopted: 0, alreadyAdopted: 1, needsConfirmation: 0 })
  })

  it.each(['formatting', 'unrelated server'] as const)(
    'keeps historical availability after %s changes without writing the host or granting consent',
    async mutation => {
      legacy()
      installation()
      const configRoot = path.join(root, '.cursor')
      const configPath = path.join(configRoot, 'mcp.json')
      exactMcp(configRoot)
      const scan = () => adoptProvableLegacyConnections({
        repository, adapters: createP0HostAdapters(), runtime, now: T0,
      })
      expect(await scan()).toMatchObject({ adopted: 1, needsConfirmation: 0 })
      const document = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (mutation === 'unrelated server') document.mcpServers.other = { command: '/usr/bin/other' }
      fs.writeFileSync(configPath, JSON.stringify(document))
      const expectedBytes = fs.readFileSync(configPath)
      expect(await scan()).toMatchObject({ adopted: 0, alreadyAdopted: 1, needsConfirmation: 0 })
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        verified_capability: 2, status_reason: 'legacy_callable_unmanaged',
        desired_state: 'unmanaged', consent_envelope_id: null,
      })
      expect(fs.readFileSync(configPath)).toEqual(expectedBytes)
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE kind = 'legacy_adoption_artifact_changed'`).get()).toEqual({ count: 0 })
    },
  )

  it('upgrades an exact still-callable container-bound baseline before accepting unrelated edits', async () => {
    legacy()
    installation()
    const configRoot = path.join(root, '.cursor')
    exactMcp(configRoot)
    const adapters = new Map(createP0HostAdapters())
    const cursor = adapters.get('cursor-desktop')!
    let observations: readonly AdoptableArtifactObservation[] = []
    adapters.set('cursor-desktop', {
      ...cursor,
      inspectAdoptableArtifacts: async context => {
        observations = await cursor.inspectAdoptableArtifacts!(context)
        return observations
      },
    })
    const scan = () => adoptProvableLegacyConnections({ repository, adapters, runtime, now: T0 })
    expect(await scan()).toMatchObject({ adopted: 1 })
    const metadata = JSON.parse(repository.getInstallation('cursor-1')!.metadata_json)
    delete metadata.legacyAdoption.evidenceVersion
    delete metadata.legacyAdoption.historicalCapability
    metadata.legacyAdoption.evidenceHash = sha256Json({
      legacyAgentId: 'eb_legacy01', legacyToolType: 'cursor', installationId: 'cursor-1', observations,
    })
    db.prepare('UPDATE agent_installations SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify(metadata), 'cursor-1')
    expect(await scan()).toMatchObject({ alreadyAdopted: 1, needsConfirmation: 0 })
    expect(JSON.parse(repository.getInstallation('cursor-1')!.metadata_json).legacyAdoption)
      .toMatchObject({ evidenceVersion: 2, historicalCapability: 2 })
    const configPath = path.join(configRoot, 'mcp.json')
    fs.writeFileSync(configPath, JSON.stringify(JSON.parse(fs.readFileSync(configPath, 'utf8'))))
    expect(await scan()).toMatchObject({ alreadyAdopted: 1, needsConfirmation: 0 })
    expect(repository.getInstallation('cursor-1')?.verified_capability).toBe(2)
  })

  it.each(['deleted', 'tampered'] as const)(
    'revokes historical availability when an adopted legacy selector is %s, without writing or granting consent',
    async mutation => {
      const databasePath = path.join(root, `legacy-${mutation}.sqlite`)
      const configRoot = path.join(root, `.cursor-${mutation}`)
      const physicalDb = new Database(databasePath)
      ensureSchema(physicalDb)
      physicalDb.prepare(`
        INSERT INTO agents (id, name, tool_type, archived, created)
        VALUES ('eb_legacy_physical', 'Legacy Cursor', 'cursor', 0, ?)
      `).run(T0)
      let physicalRepository = new AgentIntegrationRepository(physicalDb)
      physicalRepository.upsertDiscoveredInstallation({
        id: 'cursor-physical',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        runtimeRealm: 'local_macos',
        installKey: 'cursor:physical',
        distributionId: 'com.todesktop.230313mzl4w4u92',
        provenance: 'bundle_id',
        displayName: 'Cursor',
        configRoot,
        agentId: 'generated-cursor-physical',
        supportedCapability: 4,
        lastDetectedAt: T0,
      })
      exactMcp(configRoot, 'eb_legacy_physical')
      expect(await adoptProvableLegacyConnections({
        repository: physicalRepository,
        adapters: createP0HostAdapters(),
        runtime,
        now: T0,
      })).toMatchObject({ adopted: 1, alreadyAdopted: 0, needsConfirmation: 0 })
      physicalDb.close()

      const selectorPath = path.join(configRoot, 'mcp.json')
      if (mutation === 'deleted') {
        fs.unlinkSync(selectorPath)
      } else {
        const document = JSON.parse(fs.readFileSync(selectorPath, 'utf8')) as {
          mcpServers: Record<string, { command: string }>
        }
        document.mcpServers['tidemind-eb_legacy_physical'].command = '/tmp/tampered-command'
        fs.writeFileSync(selectorPath, `${JSON.stringify(document, null, 2)}\n`)
      }
      const hostBytesAfterMutation = fs.existsSync(selectorPath)
        ? fs.readFileSync(selectorPath)
        : null

      const restartedDb = new Database(databasePath)
      ensureSchema(restartedDb)
      physicalRepository = new AgentIntegrationRepository(restartedDb)
      const report = await adoptProvableLegacyConnections({
        repository: physicalRepository,
        adapters: createP0HostAdapters(),
        runtime,
        now: '2026-08-25T10:01:00.000Z',
      })
      expect(report).toMatchObject({ adopted: 0, alreadyAdopted: 0, needsConfirmation: 1 })
      expect(physicalRepository.getInstallation('cursor-physical')).toMatchObject({
        agent_id: 'eb_legacy_physical',
        desired_state: 'unmanaged',
        consent_envelope_id: null,
        verified_capability: 0,
        verification_summary: 'stale',
        reconcile_state: 'paused',
        status_reason: 'verification_stale',
      })
      expect(restartedDb.prepare(`SELECT component_key, verification_status, verification_result_id
        FROM installation_components WHERE installation_id = 'cursor-physical'`).all()).toEqual([{
        component_key: 'memory_tools',
        verification_status: 'stale',
        verification_result_id: null,
      }])
      expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
      expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
      expect(restartedDb.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE kind = 'legacy_adoption_artifact_changed'`).get()).toEqual({ count: 1 })
      if (hostBytesAfterMutation === null) expect(fs.existsSync(selectorPath)).toBe(false)
      else expect(fs.readFileSync(selectorPath)).toEqual(hostBytesAfterMutation)

      const service = new AgentIntegrationService({
        repository: physicalRepository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async () => { throw new Error('not used') },
          applyPrepared: async () => { throw new Error('not used') },
        },
        now: () => new Date('2026-08-25T10:01:00.000Z'),
        homeDir: root,
      })
      expect(service.snapshot().installations).toEqual([
        expect.objectContaining({
          id: 'cursor-physical',
          desiredState: 'unmanaged',
          statusGroup: 'awaiting_verification',
          statusReason: 'verification_stale',
          accessLevel: 'unconnected',
          accessIsHistorical: true,
        }),
      ])

      const repeated = await adoptProvableLegacyConnections({
        repository: physicalRepository,
        adapters: createP0HostAdapters(),
        runtime,
        now: '2026-08-25T10:02:00.000Z',
      })
      expect(repeated).toMatchObject({ adopted: 0, alreadyAdopted: 0, needsConfirmation: 1 })
      expect(restartedDb.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE kind = 'legacy_adoption_artifact_changed'`).get()).toEqual({ count: 1 })
      expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
      // A real host repair back to the exact owned baseline restores only the
      // historical summary. No managed consent/verification is manufactured.
      exactMcp(configRoot, 'eb_legacy_physical')
      const restoredBytes = fs.readFileSync(selectorPath)
      restartedDb.close()
      const restoredDb = new Database(databasePath)
      ensureSchema(restoredDb)
      const restoredRepository = new AgentIntegrationRepository(restoredDb)
      expect(await adoptProvableLegacyConnections({
        repository: restoredRepository, adapters: createP0HostAdapters(), runtime,
        now: '2026-08-25T10:03:00.000Z',
      })).toMatchObject({ adopted: 0, alreadyAdopted: 1, needsConfirmation: 0 })
      expect(restoredRepository.getInstallation('cursor-physical')).toMatchObject({
        desired_state: 'unmanaged', consent_envelope_id: null,
        verified_capability: 2, verification_summary: 'stale',
        verification_result_id: null, reconcile_state: 'idle',
        status_reason: 'legacy_callable_unmanaged',
      })
      expect(restoredDb.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
      expect(restoredDb.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
      expect(restoredDb.prepare('SELECT COUNT(*) AS count FROM verification_results').get()).toEqual({ count: 0 })
      expect(fs.readFileSync(selectorPath)).toEqual(restoredBytes)
      restoredDb.close()
    },
  )

  it('adopts the exact 0.2.91 Kimi MCP, Skill and single-hook baselines without granting a writer', async () => {
    legacyKimi()
    kimiInstallation()
    exactLegacyKimi091(path.join(root, '.kimi-code'))

    const before = fs.readFileSync(path.join(root, '.kimi-code', 'config.toml'), 'utf8')
    const report = await adoptProvableLegacyConnections({ repository, adapters: createP0HostAdapters(), runtime, now: T0 })
    expect(report).toMatchObject({ adopted: 1, alreadyAdopted: 0, needsConfirmation: 0 })
    expect(repository.getInstallation('kimi-1')).toMatchObject({
      agent_id: 'eb_kimi_legacy',
      desired_state: 'unmanaged',
      verified_capability: 2,
      status_reason: 'legacy_callable_unmanaged',
      consent_envelope_id: null,
    })
    expect(db.prepare(`SELECT component_type, ownership_key FROM managed_artifacts
      ORDER BY component_type`).all()).toEqual([
      { component_type: 'hook', ownership_key: `hooks.tidemind-eb_kimi_legacy` },
      { component_type: 'mcp', ownership_key: `mcpServers.tidemind-eb_kimi_legacy` },
      { component_type: 'skill', ownership_key: 'document' },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
    expect(fs.readFileSync(path.join(root, '.kimi-code', 'config.toml'), 'utf8')).toBe(before)

    const restarted = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: '2026-08-25T10:01:00.000Z',
    })
    expect(restarted).toMatchObject({ adopted: 0, alreadyAdopted: 1, needsConfirmation: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM managed_artifacts').get()).toEqual({ count: 3 })
  })

  it.each([
    ['claude-code', 'claude-code-cli'],
    ['openclaw', 'openclaw-local'],
    ['gemini', 'gemini-cli'],
  ] as const)('physically adopts exact 0.2.89/0.2.91 %s artifacts without a host writer', async (toolType, hostVariant) => {
    const physicalPath = path.join(root, `${toolType}.sqlite`)
    const physicalDb = new Database(physicalPath)
    ensureSchema(physicalDb)
    const physicalRepository = new AgentIntegrationRepository(physicalDb)
    const agentId = `eb_${toolType.replace(/-/g, '_')}_legacy`
    const configRoot = path.join(root, `.${toolType}`)
    const executable = path.join(root, 'bin', toolType)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
    physicalDb.prepare(`INSERT INTO agents (id, name, tool_type, archived, created) VALUES (?, ?, ?, 0, ?)`)
      .run(agentId, `Legacy ${toolType}`, toolType, T0)
    physicalRepository.upsertDiscoveredInstallation({
      id: `installation-${toolType}`,
      family: toolType === 'claude-code' ? 'claude-code' : toolType,
      hostVariant,
      runtimeRealm: 'local_macos',
      installKey: `${toolType}:fixture`,
      distributionId: `${toolType}:fixture`,
      provenance: 'fixture',
      displayName: toolType,
      configRoot,
      executablePath: executable,
      agentId: `generated-${toolType}`,
      supportedCapability: 4,
      lastDetectedAt: T0,
    })
    fs.mkdirSync(configRoot, { recursive: true })
    if (toolType === 'claude-code') writeLegacyClaude(agentId)
    else if (toolType === 'openclaw') writeLegacyOpenClaw(configRoot, agentId)
    else writeLegacyGemini(configRoot, agentId)
    const before = snapshotFiles(root)

    const adapters = new Map(createP0HostAdapters())
    if (toolType === 'claude-code') {
      const pluginName = `tidemind-${agentId}`
      adapters.set('claude-code-cli', createClaudeCodePluginHostAdapter({
        catalogId: 'claude-code-cli',
        adapterVersion: '1',
        dependencies: { run: async (_executable, args) => ({
          exitCode: 0,
          stdout: JSON.stringify(args[2] === 'marketplace'
            ? []
            : args[1] === 'marketplace'
              ? [{ name: 'tidemind-local', source: 'directory', path: path.join(runtime.applicationDataDir, 'plugins') }]
              : [{ id: `${pluginName}@tidemind-local`, version: '1.0.1', enabled: true }]),
          stderr: '',
        }) },
      }))
    } else if (toolType === 'gemini') {
      const name = `tidemind-${agentId}`
      adapters.set('gemini-cli', createGeminiExtensionHostAdapter({
        adapterVersion: '1',
        dependencies: { run: async () => ({ exitCode: 0, stdout: JSON.stringify([{ name, version: '1.0.0', path: path.join(configRoot, 'extensions', name), isActive: true }]), stderr: '' }) },
      }))
    }
    const first = await adoptProvableLegacyConnections({
      repository: physicalRepository,
      adapters,
      runtime,
      now: T0,
    })
    expect(first).toMatchObject({ adopted: 1, needsConfirmation: 0 })
    expect(physicalRepository.getInstallation(`installation-${toolType}`)).toMatchObject({
      agent_id: agentId,
      desired_state: 'unmanaged',
      verified_capability: 4,
      status_reason: 'legacy_callable_unmanaged',
      consent_envelope_id: null,
    })
    expect(physicalDb.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
    expect(snapshotFiles(root)).toEqual(before)
    const aliasCount = physicalDb.prepare('SELECT COUNT(*) AS count FROM agent_aliases').get() as { count: number }
    physicalDb.close()

    const restartedDb = new Database(physicalPath)
    const restartedRepository = new AgentIntegrationRepository(restartedDb)
    const restarted = await adoptProvableLegacyConnections({
      repository: restartedRepository,
      adapters,
      runtime,
      now: '2026-08-25T10:01:00.000Z',
    })
    expect(restarted).toMatchObject({ adopted: 0, alreadyAdopted: 1, needsConfirmation: 0 })
    expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM agent_aliases').get()).toEqual(aliasCount)
    restartedDb.close()
  })

  function writeLegacyClaude(agentId: string): void {
    const legacyRoot = path.join(runtime.applicationDataDir, 'plugins', `claude-code-${agentId}`)
    const pluginName = `tidemind-${agentId}`
    const sourceSkill = '# Legacy Tide Mind Claude skill\n'
    fs.mkdirSync(path.join(runtime.applicationDataDir, 'skill'), { recursive: true })
    fs.writeFileSync(path.join(runtime.applicationDataDir, 'skill', 'claude-code-skill.md'), sourceSkill)
    const write = (relative: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(legacyRoot, relative)), { recursive: true })
      fs.writeFileSync(path.join(legacyRoot, relative), content)
    }
    write('.claude-plugin/plugin.json', JSON.stringify({ name: pluginName, version: '1.0.1', author: { name: 'TideMind' } }, null, 2))
    write('.mcp.json', JSON.stringify({ mcpServers: { tidemind: { command: runtime.shimPath, args: [runtime.mcpServerPath], env: { EB_AGENT_ID: agentId } } } }, null, 2))
    const command = (script: string, extra: string[]) => [JSON.stringify(runtime.shimPath), JSON.stringify(script), '--agent-id', JSON.stringify(agentId), ...extra].join(' ')
    write('hooks/hooks.json', JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: command(runtime.hookScriptPath, ['--skill-path', JSON.stringify(path.join(legacyRoot, 'skills', 'tidemind', 'SKILL.md')), '--tool', JSON.stringify('claude-code')]) }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: command(runtime.preCompactScriptPath, ['--tool', JSON.stringify('claude-code')]) }] }],
      PostCompact: [{ hooks: [{ type: 'command', command: command(runtime.postCompactScriptPath, ['--tool', JSON.stringify('claude-code')]) }] }],
    } }, null, 2))
    write('skills/tidemind/SKILL.md', legacyClaudeSkill(pluginName) + sourceSkill)
  }

  function writeLegacyOpenClaw(configRoot: string, agentId: string): void {
    fs.writeFileSync(path.join(configRoot, 'openclaw.json'), JSON.stringify({ mcp: { servers: { [`tidemind-${agentId}`]: { command: runtime.shimPath, args: [runtime.mcpServerPath], env: { EB_AGENT_ID: agentId } } } } }, null, 2))
    const hookRoot = path.join(configRoot, 'hooks', `tidemind-${agentId}`)
    fs.mkdirSync(hookRoot, { recursive: true })
    fs.writeFileSync(path.join(hookRoot, 'HOOK.md'), ['---', `name: tidemind-${agentId}`, 'description: "Tide Mind — 自动加载外脑上下文"', 'metadata:', '  openclaw:', '    emoji: "🧠"', '    events: ["agent:bootstrap"]', '---', '', '在 Agent Bootstrap 时自动调用 Tide Mind 的 prepare 接口，将用户画像、记忆索引和行为指导注入为 MEMORY.md。'].join('\n'))
    fs.writeFileSync(path.join(hookRoot, 'handler.ts'), ["import { spawnSync } from 'child_process'", '', `const SHIM = ${JSON.stringify(runtime.shimPath)}`, `const HOOK_SCRIPT = ${JSON.stringify(runtime.hookScriptPath)}`, `const SKILL_PATH = ${JSON.stringify(path.join(runtime.applicationDataDir, 'skill', 'openclaw-skill.md'))}`, `const AGENT_ID = ${JSON.stringify(agentId)}`, '', 'const handler = async (event: any) => {', "  if (event.type !== 'agent' || event.action !== 'bootstrap') return", '  try {', `    const result = spawnSync(SHIM, [HOOK_SCRIPT, '--agent-id', AGENT_ID, '--skill-path', SKILL_PATH, '--tool', 'openclaw'], {`, '      timeout: 15000,', "      encoding: 'utf-8',", '    })', "    const output = result.stdout ?? ''", '    if (output.trim() && event.context.bootstrapFiles) {', "      event.context.bootstrapFiles.push({ name: 'MEMORY.md', content: output })", '    }', '  } catch { /* prepare 失败不阻断启动 */ }', '}', '', 'export default handler', ''].join('\n'))
  }

  function writeLegacyGemini(configRoot: string, agentId: string): void {
    const name = `tidemind-${agentId}`
    const installed = path.join(configRoot, 'extensions', name)
    const staging = path.join(runtime.applicationDataDir, 'plugins', `gemini-${agentId}`)
    fs.mkdirSync(path.join(runtime.applicationDataDir, 'skill'), { recursive: true })
    fs.writeFileSync(path.join(runtime.applicationDataDir, 'skill', 'gemini-skill.md'), '---\ndescription: legacy\n---\n# Tide Mind\n')
    fs.mkdirSync(path.join(installed, 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(installed, 'gemini-extension.json'), JSON.stringify({ name, version: '1.0.0', mcpServers: { tidemind: { command: runtime.shimPath, args: [runtime.mcpServerPath], env: { EB_AGENT_ID: agentId } } }, contextFileName: 'GEMINI.md', excludeTools: [] }, null, 2))
    fs.writeFileSync(path.join(installed, 'GEMINI.md'), '# Tide Mind\n')
    const hookCommand = [JSON.stringify(runtime.shimPath), JSON.stringify(runtime.hookScriptPath), '--agent-id', JSON.stringify(agentId), '--skill-path', JSON.stringify(path.join(installed, 'GEMINI.md')), '--tool', JSON.stringify('gemini')].join(' ')
    fs.writeFileSync(path.join(installed, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: hookCommand, timeout: 15000 }] }] } }, null, 2))
    fs.writeFileSync(path.join(installed, '.gemini-extension-install.json'), JSON.stringify({ source: staging, type: 'local' }))
  }

  function legacyClaudeSkill(pluginName: string): string {
    return [
      '---',
      'description: "Tide Mind 外部记忆系统已连接。用户上下文在会话启动时自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。"',
      'when_to_use: |',
      '  用户提起"之前"、"上次"、"记得吗"、过去的决定或观点时；',
      '  需要判断用户偏好、历史态度、长期目标时；',
      '  用户明确说"记住"、"别忘了"、"以后不要..."时；',
      '  每次完成实质性请求后、用户做出决策或表达观点时需要沉淀结论。',
      'allowed-tools:',
      '  - mcp__tidemind__brain_prepare',
      '  - mcp__tidemind__brain_recall',
      '  - mcp__tidemind__brain_digest',
      `  - mcp__${pluginName}__brain_prepare`,
      `  - mcp__${pluginName}__brain_recall`,
      `  - mcp__${pluginName}__brain_digest`,
      `  - mcp__plugin_${pluginName}_tidemind__brain_prepare`,
      `  - mcp__plugin_${pluginName}_tidemind__brain_recall`,
      `  - mcp__plugin_${pluginName}_tidemind__brain_digest`,
      '---',
      '',
    ].join('\n')
  }

  function snapshotFiles(directory: string): Record<string, string> {
    const result: Record<string, string> = {}
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name)
        if (entry.isDirectory()) walk(target)
        else if (entry.isFile() && !target.endsWith('.sqlite') && !target.includes('.sqlite-')) {
          result[path.relative(directory, target)] = fs.readFileSync(target).toString('base64')
        }
      }
    }
    walk(directory)
    return result
  }

  it('does not adopt a similar 0.2.91 Kimi hook whose command path is not exact', async () => {
    legacyKimi()
    kimiInstallation()
    exactLegacyKimi091(path.join(root, '.kimi-code'), 'eb_kimi_legacy', command => (
      command.replace(runtime.hookScriptPath, '/tmp/user-hook.cjs')
    ))

    const report = await adoptProvableLegacyConnections({ repository, adapters: createP0HostAdapters(), runtime, now: T0 })
    // The exact MCP selector alone can preserve callable memory access, but the
    // user-owned lookalike hook is never claimed as lifecycle ownership.
    expect(report).toMatchObject({ adopted: 1, needsConfirmation: 0 })
    expect(db.prepare(`SELECT component_type, ownership_key FROM managed_artifacts
      ORDER BY component_type`).all()).toEqual([
      { component_type: 'mcp', ownership_key: 'mcpServers.tidemind-eb_kimi_legacy' },
      { component_type: 'skill', ownership_key: 'document' },
    ])
    expect(fs.readFileSync(path.join(root, '.kimi-code', 'config.toml'), 'utf8'))
      .toContain('/tmp/user-hook.cjs')
  })

  it.each(['other', 'custom-local-bridge'] as const)(
    'adopts an active %s legacy identity as an unconfigured Custom Installation idempotently',
    async toolType => {
      customLegacy(toolType)

      const first = await adoptProvableLegacyConnections({
        repository,
        adapters: createP0HostAdapters(),
        runtime,
        now: T0,
      })
      expect(first).toMatchObject({ adopted: 1, alreadyAdopted: 0, needsConfirmation: 0 })

      const installation = repository.getInstallationByAgentIdOrAlias('eb_custom01')
      expect(installation).toMatchObject({
        family: 'custom-local-agent',
        host_variant: 'custom-local-mcp',
        runtime_realm: 'local_macos',
        profile_id: 'legacy-unconfigured',
        provenance: 'legacy_identity_only',
        display_name: 'Legacy Custom Agent',
        agent_id: 'eb_custom01',
        desired_state: 'unmanaged',
        supported_capability: 0,
        desired_capability: 0,
        verified_capability: 0,
        delivery_summary: 'cataloged',
        verification_summary: 'unverified',
        health_state: 'identity_only',
        status_reason: null,
        reconcile_state: 'idle',
        last_detected_at: null,
        config_root: null,
        executable_path: null,
        app_path: null,
        detected_version: null,
        version_detection_method: null,
        os_user_identity: null,
        distribution_id: null,
      })
      expect(installation?.install_key).toMatch(/^custom-local-mcp:legacy:[a-f0-9]{64}$/u)
      expect(JSON.parse(installation!.metadata_json)).toEqual({
        customInstallation: {
          kind: 'legacy_identity_only',
          sourceAgentId: 'eb_custom01',
          sourceToolType: toolType,
          sourceCreatedAt: T0,
          sourceLastActiveAt: '2026-08-25T09:59:00.000Z',
          adoptedAt: T0,
        },
      })
      expect(db.prepare(`SELECT id, name, tool_type, archived, last_active, created
        FROM agents WHERE id = 'eb_custom01'`).get()).toEqual({
        id: 'eb_custom01',
        name: 'Legacy Custom Agent',
        tool_type: toolType,
        archived: 0,
        last_active: '2026-08-25T09:59:00.000Z',
        created: T0,
      })
      for (const table of [
        'agent_consents',
        'installation_components',
        'managed_artifacts',
        'artifact_consumers',
        'reconcile_runs',
        'projection_mutations',
        'writer_fences',
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
      }

      const service = new AgentIntegrationService({
        repository,
        scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
        execution: {
          preview: async () => { throw new Error('not used') },
          applyPrepared: async () => { throw new Error('not used') },
        },
        now: () => new Date(T0),
        homeDir: root,
      })
      expect(service.snapshot().installations).toEqual([
        expect.objectContaining({
          id: installation!.id,
          familyId: 'custom-local-agent',
          hostVariant: 'custom-local-mcp',
          displayName: 'Legacy Custom Agent',
          version: null,
          accessLevel: 'unconnected',
        }),
      ])
      expect(service.detail(installation!.id)).toMatchObject({ configRootLabel: null })

      const second = await adoptProvableLegacyConnections({
        repository,
        adapters: createP0HostAdapters(),
        runtime,
        now: '2026-08-25T10:01:00.000Z',
      })
      expect(second).toMatchObject({ adopted: 0, alreadyAdopted: 1, needsConfirmation: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_installations`).get()).toEqual({ count: 1 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 1 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE kind = 'legacy_custom_identity_adopted'`).get()).toEqual({ count: 1 })
    },
  )

  it('does not adopt archived custom identities or unrelated unknown legacy types', async () => {
    customLegacy('custom-archived', 'eb_archived', 1)
    db.prepare(`
      INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES ('eb_unknown', 'Unknown Agent', 'bespoke', 0, ?)
    `).run(T0)

    const report = await adoptProvableLegacyConnections({
      repository,
      adapters: createP0HostAdapters(),
      runtime,
      now: T0,
    })
    expect(report).toMatchObject({
      adopted: 0,
      skippedArchived: 1,
      skippedUnknownType: 1,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_installations`).get()).toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 0 })
  })

  it('fails closed when the selector does not carry the exact legacy identity', async () => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'), 'another-agent')

    const report = await adoptProvableLegacyConnections({
      repository,
      adapters: createP0HostAdapters(),
      runtime,
      now: T0,
    })
    expect(report).toMatchObject({ adopted: 0, needsConfirmation: 1 })
    expect(repository.getInstallation('cursor-1')?.agent_id).toBe('generated-cursor-1')
    expect(repository.getInstallation('cursor-1')).toMatchObject({
      reconcile_state: 'paused', status_reason: 'legacy_confirmation_required',
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get()).toEqual({ count: 0 })
    expect(repository.listInstallationEvents('cursor-1').map(event => ({
      installationId: event.installation_id,
      kind: event.kind,
      severity: event.severity,
    }))).toContainEqual({
      installationId: 'cursor-1',
      kind: 'legacy_connection_needs_confirmation',
      severity: 'warning',
    })
  })

  it('adopts the current exact entry with an exact host-variant binding', async () => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'), 'eb_legacy01', { hostVariant: 'cursor-desktop' })

    const report = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: T0,
    })
    expect(report).toMatchObject({ adopted: 1, needsConfirmation: 0 })
  })

  it('invalidates adopted callable history when the discovered host version changes', async () => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'))
    db.prepare(`UPDATE agent_installations SET detected_version = '1.0.0' WHERE id = 'cursor-1'`).run()

    await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: T0,
    })
    repository.upsertDiscoveredInstallation({
      id: 'cursor-1',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos',
      installKey: 'cursor:cursor-1',
      distributionId: 'com.todesktop.230313mzl4w4u92',
      provenance: 'bundle_id',
      displayName: 'Cursor',
      configRoot: path.join(root, '.cursor'),
      detectedVersion: '2.0.0',
      agentId: 'eb_legacy01',
      supportedCapability: 4,
      lastDetectedAt: '2026-08-25T10:01:00.000Z',
    })

    expect(repository.getInstallation('cursor-1')).toMatchObject({
      desired_state: 'unmanaged',
      consent_envelope_id: null,
      verified_capability: 0,
      verification_summary: 'stale',
      status_reason: 'verification_stale',
    })
    expect(await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: '2026-08-25T10:02:00.000Z',
    })).toMatchObject({ alreadyAdopted: 0, needsConfirmation: 1 })
    expect(repository.getInstallation('cursor-1')?.verified_capability).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })
  })

  it.each([
    ['wrong host variant', { hostVariant: 'windsurf-desktop' }],
    ['tampered command', { command: '/tmp/not-tidemind' }],
    ['extra entry field', { extraEntry: { transport: 'stdio' } }],
  ])('fails closed for an otherwise matching entry with %s', async (_label, options) => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'), 'eb_legacy01', options)

    const report = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: T0,
    })
    expect(report).toMatchObject({ adopted: 0, needsConfirmation: 1 })
    expect(repository.getInstallation('cursor-1')?.agent_id).toBe('generated-cursor-1')
    expect(db.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get()).toEqual({ count: 0 })
  })

  it('does not guess when two discovered Installations prove the same legacy identity', async () => {
    legacy()
    const firstRoot = path.join(root, 'cursor-a')
    const secondRoot = path.join(root, 'cursor-b')
    installation('cursor-a', firstRoot)
    installation('cursor-b', secondRoot)
    exactMcp(firstRoot)
    exactMcp(secondRoot)

    const report = await adoptProvableLegacyConnections({
      repository,
      adapters: createP0HostAdapters(),
      runtime,
      now: T0,
    })
    expect(report).toMatchObject({ adopted: 0, needsConfirmation: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 0 })
  })

  it('uses a stable-ID canonical identity for equal no-activity history instead of creating a third selector', async () => {
    legacy('eb_A')
    db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES ('eb_B', 'Legacy B', 'cursor', 0, ?)`).run(T0)
    installation()
    const configRoot = path.join(root, '.cursor')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.writeFileSync(path.join(configRoot, 'mcp.json'), `${JSON.stringify({
      mcpServers: Object.fromEntries(['eb_A', 'eb_B'].map(agentId => [
        `tidemind-${agentId}`,
        { command: runtime.shimPath, args: [runtime.mcpServerPath], env: { EB_AGENT_ID: agentId } },
      ])),
    }, null, 2)}\n`)

    const report = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: T0,
    })
    expect(report).toMatchObject({ adopted: 2, needsConfirmation: 0 })
    expect(repository.getInstallation('cursor-1')?.agent_id).toBe('eb_B')
    expect(repository.getInstallation('cursor-1')).toMatchObject({
      reconcile_state: 'idle', status_reason: 'legacy_callable_unmanaged', health_state: 'discovered',
    })
    expect(db.prepare(`SELECT alias_value, reason FROM agent_aliases ORDER BY alias_value`).all()).toEqual([
      { alias_value: 'eb_A', reason: 'legacy_secondary_identity_only' },
      { alias_value: 'eb_B', reason: 'legacy_owned_projection' },
      { alias_value: 'generated-cursor-1', reason: 'pre_adoption_generated_identity' },
    ])
    expect(repository.getInstallationByAgentIdOrAlias('eb_A')).toMatchObject({
      provenance: 'legacy_identity_only', health_state: 'identity_only', agent_id: 'eb_A',
    })
    expect(repository.getInstallationByAgentIdOrAlias('eb_B')).toMatchObject({
      id: 'cursor-1', health_state: 'discovered', agent_id: 'eb_B',
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
      WHERE kind = 'legacy_connection_needs_confirmation'`).get()).toEqual({ count: 0 })
    expect(JSON.parse(repository.getInstallation('cursor-1')!.metadata_json).legacyAdoption)
      .toMatchObject({
        canonicalSelection: {
          basis: 'stable_id', canonicalAgentId: 'eb_B',
          candidateLegacyAgentIds: ['eb_A', 'eb_B'],
        },
      })
    expect(db.prepare(`SELECT ownership_key FROM managed_artifacts`).all())
      .toEqual([{ ownership_key: 'mcpServers.tidemind-eb_B' }])
    const restarted = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: '2026-08-25T10:01:00.000Z',
    })
    expect(restarted).toMatchObject({ adopted: 0, alreadyAdopted: 2, needsConfirmation: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_installations`).get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 3 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get()).toEqual({ count: 1 })
  })

  it('physically migrates the uniquely active canonical identity and preserves secondary history across restart', async () => {
    const databasePath = path.join(root, 'multi-identity.sqlite')
    let physicalDb = new Database(databasePath)
    ensureSchema(physicalDb)
    let physicalRepository = new AgentIntegrationRepository(physicalDb)
    const configRoot = path.join(root, '.cursor-multi')
    const configPath = path.join(configRoot, 'mcp.json')
    physicalDb.prepare(`INSERT INTO agents (id, name, tool_type, archived, last_active, created)
      VALUES ('eb_A', 'Legacy A', 'cursor', 0, '2026-08-25T09:00:00.000Z', ?),
             ('eb_B', 'Legacy B', 'cursor', 0, '2026-08-25T09:59:00.000Z', ?)`)
      .run(T0, '2026-08-25T10:00:01.000Z')
    physicalDb.prepare(`INSERT INTO operation_log (operation, agent_id, created)
      VALUES ('brain_recall', 'eb_A', ?), ('brain_digest', 'eb_B', ?), ('brain_recall', 'eb_B', ?)`)
      .run(T0, T0, T0)
    physicalRepository.upsertDiscoveredInstallation({
      id: 'cursor-multi', family: 'cursor', hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos', installKey: 'cursor:multi',
      distributionId: 'com.todesktop.230313mzl4w4u92', provenance: 'bundle_id',
      displayName: 'Cursor', configRoot, agentId: 'generated-cursor-multi',
      supportedCapability: 4, lastDetectedAt: T0,
    })
    fs.mkdirSync(configRoot, { recursive: true })
    fs.writeFileSync(configPath, `${JSON.stringify({
      mcpServers: Object.fromEntries(['eb_A', 'eb_B'].map(agentId => [
        `tidemind-${agentId}`,
        { command: runtime.shimPath, args: [runtime.mcpServerPath], env: { EB_AGENT_ID: agentId } },
      ])),
    }, null, 2)}\n`)
    const originalHostBytes = fs.readFileSync(configPath)

    const first = await adoptProvableLegacyConnections({
      repository: physicalRepository,
      adapters: createP0HostAdapters(),
      runtime,
      now: T0,
    })
    expect(first).toMatchObject({ adopted: 2, alreadyAdopted: 0, needsConfirmation: 0 })
    expect(physicalRepository.getInstallation('cursor-multi')).toMatchObject({
      agent_id: 'eb_B', reconcile_state: 'idle', status_reason: 'legacy_callable_unmanaged',
      health_state: 'discovered', desired_state: 'unmanaged', verified_capability: 2,
    })
    expect(physicalRepository.getInstallationByAgentIdOrAlias('eb_A')).toMatchObject({
      agent_id: 'eb_A', provenance: 'legacy_identity_only', health_state: 'identity_only',
      config_root: null,
    })
    expect(physicalRepository.getInstallationByAgentIdOrAlias('eb_B')?.id).toBe('cursor-multi')
    expect(physicalDb.prepare(`SELECT agent_id, COUNT(*) AS count FROM operation_log
      WHERE agent_id IN ('eb_A','eb_B') GROUP BY agent_id ORDER BY agent_id`).all()).toEqual([
      { agent_id: 'eb_A', count: 1 },
      { agent_id: 'eb_B', count: 2 },
    ])
    expect(physicalDb.prepare(`SELECT ownership_key FROM managed_artifacts`).all())
      .toEqual([{ ownership_key: 'mcpServers.tidemind-eb_B' }])
    expect(physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
      WHERE kind = 'legacy_connection_needs_confirmation'`).get()).toEqual({ count: 0 })
    const canonicalMetadata = JSON.parse(
      physicalRepository.getInstallation('cursor-multi')!.metadata_json,
    ).legacyAdoption
    expect(canonicalMetadata.canonicalSelection).toEqual({
      basis: 'unique_last_active',
      canonicalAgentId: 'eb_B',
      candidateLegacyAgentIds: ['eb_A', 'eb_B'],
    })
    const adoptionEvent = physicalDb.prepare(`SELECT payload_json FROM agent_integration_events
      WHERE kind = 'legacy_connection_adopted' AND installation_id = 'cursor-multi'`).get() as {
        payload_json: string
      }
    expect(JSON.parse(adoptionEvent.payload_json)).toMatchObject({
      canonicalSelectionBasis: 'unique_last_active',
      candidateLegacyAgentIds: ['eb_A', 'eb_B'],
    })
    expect(fs.readFileSync(configPath)).toEqual(originalHostBytes)

    const cursorAdapter = createP0HostAdapters().get('cursor-desktop')!
    const canonicalContext = {
      runtime,
      installation: {
        runtimeRealm: 'local_macos' as const,
        osUserIdentity: 'local-user',
        productFamilyId: 'cursor' as const,
        hostVariant: 'cursor-desktop' as const,
        canonicalConfigRoot: configRoot,
        explicitProfile: 'default',
        distribution: { distributionId: 'com.todesktop.230313mzl4w4u92' },
        installKey: 'cursor:multi',
      },
      installationId: 'cursor-multi',
      agentId: 'eb_B',
      operationId: 'post-migration-connect-preview',
      activityGenerationToken: 'post-migration-generation',
    }
    const observed = await cursorAdapter.inspect(canonicalContext)
    const planned = await cursorAdapter.plan(canonicalContext, {
      desiredCapability: 2,
      desiredComponents: ['memory_tools'],
      observed,
      ownedArtifacts: [{
        componentKey: 'memory_tools',
        physicalTarget: configPath,
        ownershipKey: 'mcpServers.tidemind-eb_B',
        ownedFragmentHash: (physicalDb.prepare(`SELECT owned_fragment_hash FROM managed_artifacts`).get() as {
          owned_fragment_hash: string
        }).owned_fragment_hash,
        selectorSchemaVersion: 1,
      }],
    })
    expect(planned.mutations).not.toHaveLength(0)
    expect(planned.mutations.map(mutation => mutation.ownershipKey))
      .not.toContain('mcpServers.tidemind-generated-cursor-multi')
    expect(planned.mutations.every(mutation => (
      mutation.ownershipKey.includes('eb_B') || mutation.componentKey !== 'memory_tools'
    ))).toBe(true)

    const inactiveBefore = physicalDb.prepare(`SELECT last_active FROM agents WHERE id = 'eb_A'`).get()
    expect(touchAgent(physicalDb, 'eb_B')).toEqual({ status: 'touched' })
    expect(physicalDb.prepare(`SELECT last_active FROM agents WHERE id = 'eb_A'`).get()).toEqual(inactiveBefore)
    const canonicalAfterActivity = physicalDb.prepare(`SELECT last_active FROM agents WHERE id = 'eb_B'`).get()
    expect(touchAgent(physicalDb, 'eb_A')).toEqual({ status: 'touched' })
    expect(physicalDb.prepare(`SELECT last_active FROM agents WHERE id = 'eb_B'`).get())
      .toEqual(canonicalAfterActivity)
    expect(physicalDb.prepare(`SELECT last_active FROM agents WHERE id = 'eb_A'`).get())
      .not.toEqual(inactiveBefore)
    const countsBeforeRestart = {
      installations: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_installations`).get(),
      aliases: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get(),
      artifacts: physicalDb.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get(),
      operations: physicalDb.prepare(`SELECT COUNT(*) AS count FROM operation_log
        WHERE agent_id IN ('eb_A','eb_B')`).get(),
    }
    physicalDb.close()

    physicalDb = new Database(databasePath)
    physicalRepository = new AgentIntegrationRepository(physicalDb)
    const restarted = await adoptProvableLegacyConnections({
      repository: physicalRepository,
      adapters: createP0HostAdapters(),
      runtime,
      now: '2026-08-25T10:02:00.000Z',
    })
    expect(restarted).toMatchObject({ adopted: 0, alreadyAdopted: 2, needsConfirmation: 0 })
    expect({
      installations: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_installations`).get(),
      aliases: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get(),
      artifacts: physicalDb.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get(),
      operations: physicalDb.prepare(`SELECT COUNT(*) AS count FROM operation_log
        WHERE agent_id IN ('eb_A','eb_B')`).get(),
    }).toEqual(countsBeforeRestart)
    expect(physicalRepository.getInstallation('cursor-multi')?.agent_id).toBe('eb_B')
    expect(fs.readFileSync(configPath)).toEqual(originalHostBytes)
    physicalDb.close()
  })

  it.each([false, true])(
    'does not reuse a user-selected Custom target as a secondary identity-only placeholder (preexisting alias: %s)',
    async preexistingAlias => {
      const databasePath = path.join(root, `custom-collision-${preexistingAlias}.sqlite`)
      let physicalDb = new Database(databasePath)
      ensureSchema(physicalDb)
      let physicalRepository = new AgentIntegrationRepository(physicalDb)
      const cursorRoot = path.join(root, `.cursor-collision-${preexistingAlias}`)
      const cursorPath = path.join(cursorRoot, 'mcp.json')
      const customRoot = path.join(root, `.custom-owned-${preexistingAlias}`)
      const customExecutable = path.join(customRoot, 'agent-cli')
      fs.mkdirSync(customRoot, { recursive: true })
      fs.writeFileSync(customExecutable, '#!/bin/sh\n', { mode: 0o700 })
      fs.writeFileSync(path.join(customRoot, 'mcp.json'), '{"user":"owned"}\n')
      physicalDb.prepare(`INSERT INTO agents (id, name, tool_type, archived, last_active, created)
        VALUES ('eb_A', 'Legacy A', 'cursor', 0, '2026-08-25T09:00:00.000Z', ?),
               ('eb_B', 'Legacy B', 'cursor', 0, '2026-08-25T09:59:00.000Z', ?)`)
        .run(T0, T0)
      physicalRepository.upsertDiscoveredInstallation({
        id: 'cursor-collision', family: 'cursor', hostVariant: 'cursor-desktop',
        runtimeRealm: 'local_macos', installKey: 'cursor:collision',
        provenance: 'bundle_id', displayName: 'Cursor', configRoot: cursorRoot,
        agentId: 'generated-cursor-collision', supportedCapability: 4, lastDetectedAt: T0,
      })
      physicalRepository.upsertDiscoveredInstallation({
        id: 'user-custom-A', family: 'custom-local-agent', hostVariant: 'custom-local-mcp',
        runtimeRealm: 'local_macos', profileId: 'custom-mcp:standard:tidemind',
        installKey: 'custom:user-selected:A', provenance: 'user_selected_local_executable',
        displayName: 'User Custom A', configRoot: customRoot, executablePath: customExecutable,
        detectedVersion: 'custom-user-owned', versionDetectionMethod: 'user_selected_executable_fingerprint',
        agentId: 'eb_A', supportedCapability: 2, lastDetectedAt: T0,
      })
      if (preexistingAlias) {
        physicalRepository.addAlias({
          id: 'forged-custom-alias-A', aliasType: 'legacy_agent_id', aliasValue: 'eb_A',
          runtimeRealm: 'local_macos', canonicalAgentId: 'eb_A', installationId: 'user-custom-A',
          reason: 'preexisting_user_custom_alias', createdAt: T0,
        })
      }
      fs.mkdirSync(cursorRoot, { recursive: true })
      fs.writeFileSync(cursorPath, `${JSON.stringify({
        mcpServers: Object.fromEntries(['eb_A', 'eb_B'].map(agentId => [
          `tidemind-${agentId}`,
          { command: runtime.shimPath, args: [runtime.mcpServerPath], env: { EB_AGENT_ID: agentId } },
        ])),
      }, null, 2)}\n`)
      const hostBefore = snapshotFiles(root)

      const first = await adoptProvableLegacyConnections({
        repository: physicalRepository, adapters: createP0HostAdapters(), runtime, now: T0,
      })
      expect(first).toMatchObject({ adopted: 1, needsConfirmation: 1 })
      expect(physicalRepository.getInstallation('cursor-collision')).toMatchObject({
        agent_id: 'eb_B', reconcile_state: 'idle', status_reason: 'legacy_callable_unmanaged',
      })
      expect(physicalRepository.getInstallation('user-custom-A')).toMatchObject({
        agent_id: 'eb_A', provenance: 'user_selected_local_executable',
        health_state: 'discovered', config_root: customRoot, executable_path: customExecutable,
      })
      expect(physicalRepository.listInstallations()).toHaveLength(2)
      expect(physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_aliases
        WHERE alias_value = 'eb_A' AND reason = 'legacy_secondary_identity_only'`).get())
        .toEqual({ count: 0 })
      expect(physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE installation_id = 'cursor-collision'
          AND kind = 'legacy_connection_needs_confirmation'`).get()).toEqual({ count: 1 })
      expect(snapshotFiles(root)).toEqual(hostBefore)
      const stateBeforeRestart = {
        installations: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_installations`).get(),
        aliases: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get(),
        artifacts: physicalDb.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get(),
        events: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events`).get(),
      }
      physicalDb.close()

      physicalDb = new Database(databasePath)
      physicalRepository = new AgentIntegrationRepository(physicalDb)
      const restarted = await adoptProvableLegacyConnections({
        repository: physicalRepository, adapters: createP0HostAdapters(), runtime,
        now: '2026-08-25T10:02:00.000Z',
      })
      expect(restarted).toMatchObject({ adopted: 0, alreadyAdopted: 1, needsConfirmation: 1 })
      expect(physicalRepository.getInstallation('cursor-collision')).toMatchObject({
        agent_id: 'eb_B', reconcile_state: 'idle', status_reason: 'legacy_callable_unmanaged',
      })
      expect({
        installations: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_installations`).get(),
        aliases: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get(),
        artifacts: physicalDb.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts`).get(),
        events: physicalDb.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events`).get(),
      }).toEqual(stateBeforeRestart)
      expect(snapshotFiles(root)).toEqual(hostBefore)
      physicalDb.close()
    },
  )

  it('does not let an unproven legacy row overwrite a uniquely adopted Installation state', async () => {
    legacy('eb_A')
    db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES ('eb_B', 'Legacy B', 'cursor', 0, '2026-08-25T10:00:01.000Z')`).run()
    installation()
    exactMcp(path.join(root, '.cursor'), 'eb_A')
    const report = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: T0,
    })
    expect(report).toMatchObject({ adopted: 1, needsConfirmation: 1 })
    expect(repository.getInstallation('cursor-1')).toMatchObject({
      agent_id: 'eb_A', reconcile_state: 'idle', status_reason: 'legacy_callable_unmanaged',
    })
  })

  it('rechecks the complete persisted distribution identity before committing adoption', async () => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'))
    const base = createP0HostAdapters().get('cursor-desktop')!
    let inspections = 0
    const adapters = new Map(createP0HostAdapters())
    adapters.set('cursor-desktop', {
      ...base,
      async inspectAdoptableArtifacts(context) {
        inspections += 1
        const result = await base.inspectAdoptableArtifacts!(context)
        if (inspections === 2) {
          db.prepare(`UPDATE agent_installations
            SET executable_path = '/tmp/replaced-cursor', provenance = 'replaced-package'
            WHERE id = 'cursor-1'`).run()
        }
        return result
      },
    })
    const report = await adoptProvableLegacyConnections({ repository, adapters, runtime, now: T0 })
    expect(report).toMatchObject({ adopted: 0, needsConfirmation: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 0 })
    expect(repository.getInstallation('cursor-1')).toMatchObject({
      reconcile_state: 'paused', status_reason: 'legacy_confirmation_required',
    })
  })

  it('imports only artifacts that independently assert the legacy identity', async () => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'))
    const skill = path.join(root, '.cursor', 'skills', 'tidemind', 'SKILL.md')
    fs.mkdirSync(path.dirname(skill), { recursive: true })
    fs.writeFileSync(skill, portableSkillContent())

    const report = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: T0,
    })
    expect(report).toMatchObject({ adopted: 1 })
    expect(db.prepare(`SELECT component_type FROM managed_artifacts`).all())
      .toEqual([{ component_type: 'mcp' }])
  })

  it('does not adopt a conflicted or inaccessible Installation', async () => {
    legacy()
    installation()
    exactMcp(path.join(root, '.cursor'))
    db.prepare(`UPDATE agent_installations SET health_state = 'inaccessible', status_reason = 'conflict'
      WHERE id = 'cursor-1'`).run()
    const report = await adoptProvableLegacyConnections({
      repository, adapters: createP0HostAdapters(), runtime, now: T0,
    })
    expect(report).toMatchObject({ adopted: 0, needsConfirmation: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 0 })
  })

  it('preserves archived legacy rows without binding them to active Installations', async () => {
    legacy('eb_legacy01', 1)
    installation()
    exactMcp(path.join(root, '.cursor'))

    const report = await adoptProvableLegacyConnections({
      repository,
      adapters: createP0HostAdapters(),
      runtime,
      now: T0,
    })
    expect(report).toMatchObject({ adopted: 0, skippedArchived: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 0 })
  })
})
