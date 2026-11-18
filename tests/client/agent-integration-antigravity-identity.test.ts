import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ensureSchema } from '../../src/db/schema'
import { agentIdentityDomainKey, supportsSharedAgentDomain, confirmSharedAgentIdentity } from '../../src/db/agent-identity-binding'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { connectionIntentDomain, changeConnectionIntent, allowsAutomaticConnection } from '../../client/electron/agent-integration/connection-intent'
import { assertFreshCodexConfig, freshCodexIdentityFingerprint } from '../../client/electron/agent-integration/codex-fresh-identity'
import { runtimeActivityReferencePrefix } from '../../client/electron/agent-integration/activity-reference'
import { capabilityForComponents, capHostCapability } from '../../client/electron/agent-integration/capability'

const at = '2026-11-18T12:00:00.000Z'
function setup() {
  const db = new Database(':memory:'); ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  function discover(id: string, hostVariant: string, configRoot = '/Users/synthetic/.gemini/config') {
    repository.upsertDiscoveredInstallation({ id, family: 'antigravity', hostVariant,
      installKey: `synthetic:${id}`, provenance: 'synthetic', osUserIdentity: '501', displayName: id,
      configRoot, supportedCapability: 3, agentId: `agent-${id}`, lastDetectedAt: at })
    return repository.getInstallation(id)!
  }
  return { db, repository, discover }
}

describe('Antigravity shared configuration domain', () => {
  it('creates a single-member identity and joins the second host without replacing its canonical identity', () => {
    const { db, repository, discover } = setup()
    try {
      const cli = discover('cli', 'antigravity-cli')
      const before = connectionIntentDomain(cli)
      const first = repository.previewFreshCodexIdentity(cli.id)!
      expect(first.members).toHaveLength(1)
      db.transaction(() => repository.prepareFreshCodexIdentity(cli.id, first, at))()
      expect(repository.resolveAgentIdentity(cli.id).canonicalAgentId).toBe(first.canonicalAgentId)
      db.prepare("UPDATE agent_installations SET desired_state='managed' WHERE id=?").run(cli.id)
      const app = discover('app', 'antigravity-app')
      expect(connectionIntentDomain(app)).toBe(before)
      const next = repository.previewFreshCodexIdentity(app.id)!
      expect(next).toMatchObject({ canonicalAgentId: first.canonicalAgentId, generation: 1, existingBinding: true, carrierInstallationId: 'cli' })
      db.transaction(() => repository.prepareFreshCodexIdentity(app.id, next, at))()
      expect(repository.resolveAgentIdentity(app.id)).toMatchObject({ canonicalAgentId: first.canonicalAgentId, bindingGeneration: 1 })
      expect(repository.getInstallation(app.id)?.desired_state).toBe('unmanaged')
      expect(db.prepare('SELECT count(*) AS n FROM artifact_consumers').get()).toEqual({ n: 0 })
      expect(repository.connectionIdentity(app.id).key).toBe(repository.connectionIdentity(cli.id).key)
      expect(connectionIntentDomain(repository.getInstallation(cli.id)!)).toBe(before)
      expect(repository.previewFreshCodexIdentity(app.id)).toBeNull()
    } finally { db.close() }
  })

  it('uses the stable domain intent before binding so a new member cannot bypass a pause or disconnect', () => {
    const { db, repository, discover } = setup()
    try {
      const cli = discover('cli', 'antigravity-cli')
      const domain = connectionIntentDomain(cli)
      changeConnectionIntent(db, domain, previous => ({ ...previous, state: 'paused', pausedMemberIds: ['cli'] }))
      const app = discover('app', 'antigravity-app')
      expect(repository.connectionIntent(app.id).state).toBe('paused')
      expect(allowsAutomaticConnection(repository.connectionIntent(app.id))).toBe(false)
      changeConnectionIntent(db, domain, previous => ({ ...previous, state: 'disconnected' }))
      expect(repository.connectionIntent(cli.id).state).toBe('disconnected')
      expect(repository.connectionIntent(app.id).state).toBe('disconnected')
      expect(agentIdentityDomainKey(discover('other', 'antigravity-app', '/Users/synthetic/other'))).not.toBe(agentIdentityDomainKey(app))
      expect(supportsSharedAgentDomain({ ...app, host_variant: 'gemini-cli' })).toBe(false)
    } finally { db.close() }
  })

  it('rejects a stale member-set proposal and does not expand the legacy Codex adoption path', () => {
    const { db, repository, discover } = setup()
    try {
      const cli = discover('cli', 'antigravity-cli')
      const old = repository.previewFreshCodexIdentity(cli.id)!
      const app = discover('app', 'antigravity-app')
      expect(freshCodexIdentityFingerprint(repository.previewFreshCodexIdentity(cli.id)!)).not.toBe(freshCodexIdentityFingerprint(old))
      expect(() => repository.prepareFreshCodexIdentity(cli.id, old, at)).toThrow('changed before prepare')
      const plan = repository.previewFreshCodexIdentity(cli.id)!
      db.prepare("INSERT OR IGNORE INTO agents(id,name,tool_type,created) VALUES (?,?,?,?)").run(plan.canonicalAgentId, 'Synthetic', 'antigravity', at)
      expect(() => confirmSharedAgentIdentity(db, {
        id: plan.bindingId, canonicalAgentId: plan.canonicalAgentId, evidenceHash: 'a'.repeat(64), confirmedAt: at,
        members: [cli, app].map(row => ({ installationId: row.id, installationAgentId: row.agent_id!, installKey: row.install_key, domainKey: agentIdentityDomainKey(row) })),
      })).toThrow('stale or requires managed migration')
    } finally { db.close() }
  })

  it('checks strict Antigravity JSON instead of the unrelated Codex TOML surface', () => {
    const { db, repository, discover } = setup()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-agy-'))
    try {
      const row = discover('cli', 'antigravity-cli', root)
      const plan = repository.previewFreshCodexIdentity(row.id)!
      const target = path.join(root, 'mcp_config.json')
      fs.writeFileSync(target, '')
      expect(() => assertFreshCodexConfig(plan, root, 'antigravity')).not.toThrow()
      fs.writeFileSync(target, '{"mcpServers":{"tidemind-prior":{}}}')
      expect(() => assertFreshCodexConfig(plan, root, 'antigravity')).toThrow('existing_antigravity_connection_requires_review')
      fs.writeFileSync(target, '{"mcpServers":')
      expect(() => assertFreshCodexConfig(plan, root, 'antigravity')).toThrow()
      fs.writeFileSync(target, '{"mcpServers":{"other":{"command":"synthetic"}}}')
      expect(() => assertFreshCodexConfig(plan, root, 'antigravity')).not.toThrow()
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('accepts configuration-domain evidence references only for Antigravity', () => {
    const domain = { evidenceRef: 'shared-activity:synthetic', evidenceScope: 'configuration_domain' }
    expect(runtimeActivityReferencePrefix('antigravity-cli', domain)).toBe('shared-activity:')
    expect(runtimeActivityReferencePrefix('antigravity-app', domain)).toBe('shared-activity:')
    expect(runtimeActivityReferencePrefix('codex-cli', domain)).toBeNull()
    expect(runtimeActivityReferencePrefix('cursor-desktop', domain)).toBeNull()
    expect(runtimeActivityReferencePrefix('antigravity-cli', { ...domain, evidenceScope: 'host' })).toBeNull()
    expect(runtimeActivityReferencePrefix('antigravity-cli', { evidenceRef: domain.evidenceRef })).toBeNull()
    expect(runtimeActivityReferencePrefix('codex-cli', { evidenceRef: 'host-activity:synthetic' })).toBe('host-activity:')
  })

  it('caps startup-only hosts at C3 without downgrading other hosts or custom MCP', () => {
    const all = ['instruction', 'memory_tools', 'lifecycle'] as const
    expect(capabilityForComponents(all, 'antigravity-app')).toBe(3)
    expect(capabilityForComponents(all, 'antigravity-cli')).toBe(3)
    expect(capHostCapability(4, 'antigravity-app')).toBe(3)
    expect(capabilityForComponents(all, 'codex-cli')).toBe(4)
    expect(capabilityForComponents(all, 'custom-local-mcp')).toBe(2)
    expect(capabilityForComponents(['instruction'], 'antigravity-cli')).toBe(1)
  })
})
