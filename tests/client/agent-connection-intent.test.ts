import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureSchema } from '../../src/db/schema'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { allowsAutomaticConnection, changeConnectionIntent, connectionIntentDomain, readConnectionIntent } from '../../client/electron/agent-integration/connection-intent'

function setup() {
  const db = new Database(':memory:'); ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  repository.upsertDiscoveredInstallation({ id: 'cli', family: 'codex', hostVariant: 'codex-cli',
    installKey: 'codex-cli:default', provenance: 'test', osUserIdentity: '501', displayName: 'Codex',
    configRoot: '/Users/alice/.codex', supportedCapability: 4, agentId: 'eb_test', lastDetectedAt: '2026-11-06T00:00:00.000Z' })
  return { db, row: repository.getInstallation('cli')! }
}

describe('connection intent', () => {
  it('persists monotonic user choices across readers without depending on binding creation', () => {
    const { db, row } = setup(); const domain = connectionIntentDomain(row)
    expect(allowsAutomaticConnection(readConnectionIntent(db, domain))).toBe(true)
    const first = changeConnectionIntent(db, domain, previous => ({ ...previous, state: 'paused', pausedMemberIds: ['cli'] }))
    expect(first.revision).toBe(1)
    expect(allowsAutomaticConnection(readConnectionIntent(db, domain))).toBe(false)
    const second = changeConnectionIntent(db, domain, previous => ({ ...previous, state: 'active', pausedMemberIds: [] }))
    expect(second.revision).toBe(2)
    expect(readConnectionIntent(db, domain)).toEqual(second)
    db.close()
  })
  it('pauses a pending connection and restores its unmanaged state until real configuration starts', () => {
    const { db } = setup()
    const repository = new AgentIntegrationRepository(db)
    repository.pauseConnection('installation:cli', '2026-11-06T01:00:00Z', true)
    expect(repository.getInstallation('cli')?.desired_state).toBe('disabled')
    repository.resumeConnection('installation:cli', '2026-11-06T01:01:00Z')
    expect(repository.getInstallation('cli')).toMatchObject({ desired_state: 'unmanaged', reconcile_state: 'idle', consent_envelope_id: null })
    db.close()
  })
  it('imports old opt-outs once and does not cancel an explicit reconnect awaiting native permission', () => {
    const { db } = setup(); const repository = new AgentIntegrationRepository(db)
    db.prepare("UPDATE agent_installations SET desired_state='removed',tombstone_reason='user_disconnect' WHERE id='cli'").run()
    repository.preserveUserConnectionChoices()
    expect(repository.connectionIntent('cli').excludedMemberIds).toEqual(['cli'])
    repository.allowExplicitConnection(['cli'])
    const revision = repository.connectionIntent('cli').revision
    repository.preserveUserConnectionChoices()
    expect(repository.connectionIntent('cli')).toMatchObject({ revision, state: 'active', excludedMemberIds: [] })
    repository.recordAutomaticConnectionFailure('cli', revision, [null], 'native_permission_required', '2026-11-06T02:00:00Z')
    expect(repository.getInstallation('cli')).toMatchObject({ desired_state: 'removed', status_reason: 'native_permission_required' })
    db.close()
  })
  it('shares the same Codex config domain but keeps independent profiles separate', () => {
    const { db, row } = setup()
    expect(connectionIntentDomain({ ...row, id: 'desktop', host_variant: 'codex-desktop', detected_version: 'new' })).toBe(connectionIntentDomain(row))
    expect(connectionIntentDomain({ ...row, profile_id: 'separate' })).not.toBe(connectionIntentDomain(row))
    expect(connectionIntentDomain({ ...row, config_root: '/Users/alice/.codex-other' })).not.toBe(connectionIntentDomain(row))
    db.close()
  })
  it('keeps a member opt-out when connection-wide maintenance is resumed', () => {
    const { db, row } = setup(); const domain = connectionIntentDomain(row)
    changeConnectionIntent(db, domain, previous => ({ ...previous, excludedMemberIds: ['desktop'] }))
    changeConnectionIntent(db, domain, previous => ({ ...previous, state: 'paused', pausedMemberIds: ['cli'] }))
    const resumed = changeConnectionIntent(db, domain, previous => ({ ...previous, state: 'active', pausedMemberIds: [] }))
    expect(resumed.excludedMemberIds).toEqual(['desktop'])
    expect(allowsAutomaticConnection(resumed)).toBe(false)
    db.close()
  })
})
