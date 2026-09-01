import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createP0HostAdapters, portableSkillContent } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { adoptProvableLegacyConnections } from '../../client/electron/agent-integration/legacy-adoption'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'
import { ensureSchema } from '../../src/db/schema.js'

const T0 = '2026-08-25T10:00:00.000Z'

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

  it('atomically preserves a provable old identity and owned baseline without granting consent', async () => {
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
      verification_status: 'unverified',
      ownership_key: 'mcpServers.tidemind-eb_legacy01',
      state: 'needs_recovery',
      consumer_state: 'disabled',
    })])
    expect(db.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })

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

  it('does not guess when one Installation contains selectors for two legacy identities', async () => {
    legacy('eb_A')
    db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES ('eb_B', 'Legacy B', 'cursor', 0, '2026-08-25T10:00:01.000Z')`).run()
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
    expect(report).toMatchObject({ adopted: 0, needsConfirmation: 2 })
    expect(repository.getInstallation('cursor-1')?.agent_id).toBe('generated-cursor-1')
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_aliases`).get()).toEqual({ count: 0 })
  })

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
      agent_id: 'eb_A', reconcile_state: 'idle', status_reason: 'awaiting_consent',
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
