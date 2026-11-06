import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureSchema, CURRENT_SCHEMA_VERSION } from '../../src/db/schema'
import { AgentIntegrationRepository, persistedProjectionSurfaceFingerprint } from '../../client/electron/agent-integration/repository'
import { SqliteCoordinatorRepository } from '../../client/electron/agent-integration/coordinator-repository'
import type { AutomaticConsentContext } from '../../client/electron/agent-integration/consent'

function setup() {
  const db = new Database(':memory:'); ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  repository.upsertDiscoveredInstallation({ id: 'installation', family: 'cursor', hostVariant: 'cursor-desktop',
    installKey: 'cursor:default', provenance: 'test', displayName: 'Cursor', configRoot: '/Users/alice/.cursor',
    agentId: 'eb_fixture', supportedCapability: 4, lastDetectedAt: '2026-11-06T00:00:00Z' })
  const consent = { id: 'consent', installationId: 'installation', policyVersion: '1', allowedComponents: ['memory_tools'],
    allowedScopes: ['file:/Users/alice/.cursor/mcp.json'], normalizedTargets: ['/Users/alice/.cursor/mcp.json'],
    selectorSchemaVersion: '1', selectorResolution: {}, executableRealpaths: [], commandCategories: ['file_write'],
    maximumRisk: 'low' as const, confirmedAt: '2026-01-01T00:00:00Z' }
  return { db, repository, consent }
}

describe('automatic connection consent persistence', () => {
  it('adds origin fields idempotently without relabeling old consent as user confirmation', () => {
    const { db, repository, consent } = setup()
    repository.createConsent(consent)
    db.exec('ALTER TABLE agent_consents DROP COLUMN authorization_origin; ALTER TABLE agent_consents DROP COLUMN authorization_context_json;')
    db.prepare("UPDATE metadata SET value='45' WHERE key='schema_version'").run()
    ensureSchema(db); ensureSchema(db)
    expect(repository.getConsent(consent.id)).toMatchObject({ authorization_origin: 'legacy', authorization_context_json: null,
      confirmed_at: consent.confirmedAt, allowed_scopes_json: JSON.stringify(consent.allowedScopes) })
    expect(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").pluck().get()).toBe(String(CURRENT_SCHEMA_VERSION))
    db.close()
  })
  it('retains explicit origin and rejects automatic grants without policy context', () => {
    const { db, repository, consent } = setup()
    repository.createConsent({ ...consent, origin: 'explicit_user', nativePermissionPlanHash: 'b'.repeat(64) })
    expect(repository.getConsent(consent.id)?.authorization_origin).toBe('explicit_user')
    expect(new SqliteCoordinatorRepository(db, repository).getConsent(consent.id)?.nativePermissionPlanHash).toBe('b'.repeat(64))
    expect(() => repository.createConsent({ ...consent, id: 'auto', origin: 'default_auto_policy' })).toThrow('current policy context')
    db.close()
  })
  it('invalidates an automatic grant when user intent changes without revoking the callable bridge', () => {
    const { db, repository, consent } = setup()
    const intent = repository.connectionIntent('installation')
    const context: AutomaticConsentContext = { policyVersion: 1, connectionKey: 'installation:installation',
      domainKey: intent.domainKey, intentRevision: intent.revision, executionPlanHash: 'a'.repeat(64),
      installationSurfaceFingerprint: persistedProjectionSurfaceFingerprint(repository.getInstallation('installation')!) }
    repository.createConsent({ ...consent, origin: 'default_auto_policy', automaticContext: context })
    const coordinatorRepository = new SqliteCoordinatorRepository(db, repository)
    expect(coordinatorRepository.getConsent(consent.id)?.automaticContext).toEqual(context)
    repository.setMemberUserIntent('installation', 'disabled', '2026-11-06T01:00:00Z')
    expect(coordinatorRepository.isAutomaticConsentIntentCurrent(consent.id)).toBe(false)
    expect(coordinatorRepository.getConsent(consent.id)?.origin).toBe('default_auto_policy')
    expect(repository.getConsent(consent.id)?.status).toBe('active')
    db.close()
  })
})
