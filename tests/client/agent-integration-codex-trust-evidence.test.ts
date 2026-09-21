import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { sha256Bytes } from '../../client/electron/agent-integration/fingerprint'
import type { CodexHookTrustBinding } from '../../client/electron/agent-integration/types'
import { ensureSchema } from '../../src/db/schema.js'

const NOW = '2026-09-03T00:02:00.000Z'
const SOURCE_PATH = '/tmp/tidemind-codex-trust/.codex/hooks.json'
const HOOK_KEY = `${SOURCE_PATH}:session_start:0:0`
const OWNED_HASH = 'a'.repeat(64)
const CURRENT_HASH = `sha256:${'b'.repeat(64)}`

describe('Codex hook trust evidence repository', () => {
  it('records no raw path/key and returns evidence only for every exact live binding', () => {
    const { db, repository } = setup()
    const id = repository.recordCodexHookTrustEvidence({
      ...binding(),
      artifactId: 'artifact-codex-hook',
      sourcePath: SOURCE_PATH,
      hookKey: HOOK_KEY,
      hooksFileFingerprint: 'c'.repeat(64),
      trustConfigFingerprint: 'd'.repeat(64),
      verifiedAt: NOW,
    })

    const persisted = db.prepare(`
      SELECT payload_json FROM agent_integration_events WHERE id = ?
    `).get(id) as { payload_json: string }
    expect(persisted.payload_json).not.toContain(SOURCE_PATH)
    expect(persisted.payload_json).not.toContain(HOOK_KEY)
    expect(repository.findCodexHookTrustEvidence(binding())).toEqual({
      ...binding(),
      id,
      artifactId: 'artifact-codex-hook',
      verifiedAt: NOW,
    })
    expect(repository.findCodexHookTrustEvidence({
      ...binding(),
      hostCurrentHash: `sha256:${'c'.repeat(64)}`,
    })).toBeNull()
    expect(repository.findCodexHookTrustEvidence({
      ...binding(),
      hostVersion: '0.146.0',
    })).toBeNull()
  })

  it('rejects stale Installation, Artifact, selector, and host bindings before persistence', () => {
    const { db, repository } = setup()
    const valid = {
      ...binding(),
      artifactId: 'artifact-codex-hook',
      sourcePath: SOURCE_PATH,
      hookKey: HOOK_KEY,
      hooksFileFingerprint: 'c'.repeat(64),
      trustConfigFingerprint: 'd'.repeat(64),
      verifiedAt: NOW,
    }

    expect(() => repository.recordCodexHookTrustEvidence({ ...valid, hostVersion: 'wrong' }))
      .toThrow(/Installation binding changed/u)
    expect(() => repository.recordCodexHookTrustEvidence({ ...valid, hookKey: '/tmp/other:session_start:0:0' }))
      .toThrow(/does not belong/u)

    db.prepare(`UPDATE managed_artifacts SET owned_fragment_hash = ? WHERE id = ?`)
      .run('d'.repeat(64), 'artifact-codex-hook')
    expect(() => repository.recordCodexHookTrustEvidence(valid))
      .toThrow(/Artifact binding changed/u)

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_integration_events
      WHERE kind = 'codex_hook_trust_verified'
    `).get()).toEqual({ count: 0 })
  })

  it('invalidates a prior receipt when the live Artifact ownership changes', () => {
    const { db, repository } = setup()
    repository.recordCodexHookTrustEvidence({
      ...binding(),
      artifactId: 'artifact-codex-hook',
      sourcePath: SOURCE_PATH,
      hookKey: HOOK_KEY,
      hooksFileFingerprint: 'c'.repeat(64),
      trustConfigFingerprint: 'd'.repeat(64),
      verifiedAt: NOW,
    })
    db.prepare(`UPDATE managed_artifacts SET owned_fragment_hash = ? WHERE id = ?`)
      .run('e'.repeat(64), 'artifact-codex-hook')

    expect(repository.findCodexHookTrustEvidence(binding())).toBeNull()
  })
})

function setup(): { db: Database.Database; repository: AgentIntegrationRepository } {
  const db = new Database(':memory:')
  ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  repository.upsertDiscoveredInstallation({
    id: 'installation-codex',
    family: 'codex',
    hostVariant: 'codex-cli',
    installKey: 'codex:cli:default',
    distributionId: 'openai.codex',
    provenance: 'executable_realpath',
    osUserIdentity: 'uid:501',
    displayName: 'Codex CLI',
    configRoot: '/tmp/tidemind-codex-trust/.codex',
    executablePath: '/Applications/Codex.app/Contents/MacOS/Codex',
    detectedVersion: '0.145.0',
    versionDetectionMethod: 'cli_version',
    agentId: 'agent-codex',
    supportedCapability: 4,
    lastDetectedAt: NOW,
  })
  repository.setInstallationIntent('installation-codex', 'managed', NOW)
  repository.createManagedArtifact({
    id: 'artifact-codex-hook',
    componentType: 'hook',
    targetPath: SOURCE_PATH,
    ownershipKey: 'hooks.tidemind-agent-codex',
    mutationDomain: `local_macos:file:${SOURCE_PATH}:hooks.tidemind-agent-codex`,
    projectionVersion: 'projection-7',
    selectorSchemaVersion: '1',
    ownedFragmentHash: OWNED_HASH,
    desiredFragmentHash: OWNED_HASH,
  }, NOW)
  repository.upsertComponent({
    installationId: 'installation-codex',
    componentKey: 'lifecycle',
    desiredState: 'managed',
    desiredCapability: 4,
    deliveryMode: 'managed',
    artifactId: 'artifact-codex-hook',
    visibilityState: 'dedicated',
  }, NOW)
  repository.addArtifactConsumer({
    artifactId: 'artifact-codex-hook',
    installationId: 'installation-codex',
    componentKey: 'lifecycle',
    requiredCapability: 4,
    discoverReachability: 'dedicated',
    ownershipFingerprint: OWNED_HASH,
    addedAt: NOW,
  })
  return { db, repository }
}

function binding(): CodexHookTrustBinding {
  return {
    installationId: 'installation-codex',
    agentId: 'agent-codex',
    hostVariant: 'codex-cli',
    sourcePathHash: sha256Bytes(SOURCE_PATH),
    hookKeyHash: sha256Bytes(HOOK_KEY),
    ownedFragmentHash: OWNED_HASH,
    hostCurrentHash: CURRENT_HASH,
    tideMindVersion: '0.2.92',
    adapterVersion: '7',
    projectionVersion: 'projection-7',
    hostVersion: '0.145.0',
  }
}
