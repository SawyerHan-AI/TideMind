import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import Database from 'better-sqlite3'
import {
  AgentIntegrationRepository,
  persistedConsentSurfaceFingerprint,
  type AgentInstallationRow,
} from '../../client/electron/agent-integration/repository'
import type { DiscoveredInstallation, LocalDiscoveryReport } from '../../client/electron/agent-integration/discovery'
import {
  canonicalizeInstallationIdentity,
  EXACT_INSTALL_KEY_DISTRIBUTION_CONFLICT_REASON,
} from '../../client/electron/agent-integration/identity'
import { AgentIntegrationService } from '../../client/electron/agent-integration/service'
import type { DistributionIdentity } from '../../client/electron/agent-integration/types'
import { ensureSchema } from '../../src/db/schema.js'

// Design §3.1/§3.4 and implementation notes §2 A-WP1: a host upgrade (version,
// versioned executable path, CDHash/Info.plist/artifact fingerprint) ends the old
// generation's verification but keeps the user's approval and the Installation id;
// only a change of the approval scope (identity, source channel, target paths)
// revokes consent. Conflicts raised by the earlier strong-field rule for such a
// generation-only difference are released by the next matching scan.

const T0 = '2026-09-25T00:00:00.000Z'
const T1 = '2026-09-25T01:00:00.000Z'
const T2 = '2026-09-25T02:00:00.000Z'

const CURSOR_ID = 'com.todesktop.230313mzl4w4u92'
const CURSOR_PROVENANCE = 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9'

type Distribution = {
  distributionId: string
  executableRealpath: string
  packageProvenance: string
  capabilityFingerprint: string
  portableArtifactFingerprint: string
}

const GENERATION_1: Distribution = {
  distributionId: CURSOR_ID,
  executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
  packageProvenance: CURSOR_PROVENANCE,
  capabilityFingerprint: 'desktop-bundle-surface-v1:generation-1',
  portableArtifactFingerprint: 'a'.repeat(64),
}

function setup() {
  const db = new Database(':memory:')
  ensureSchema(db)
  return { db, repository: new AgentIntegrationRepository(db) }
}

interface InstallationShape {
  version?: string
  configRoot?: string
  appPath?: string
  distribution?: Partial<Distribution>
  supportedCapability?: number
  componentConfigFiles?: Record<string, string>
  managementEligibility?: Record<string, unknown>
}

function upsert(
  repository: AgentIntegrationRepository,
  shape: InstallationShape,
  lastDetectedAt: string,
): AgentInstallationRow {
  const distribution = { ...GENERATION_1, ...shape.distribution }
  return repository.upsertDiscoveredInstallation({
    id: 'cursor-1',
    family: 'cursor',
    hostVariant: 'cursor-desktop',
    installKey: 'cursor:fixture-default',
    distributionId: distribution.distributionId,
    provenance: 'app_bundle',
    osUserIdentity: 'usr_fixture_0001',
    displayName: 'Cursor',
    configRoot: shape.configRoot ?? '/Users/fixture/.cursor',
    executablePath: distribution.executableRealpath,
    appPath: shape.appPath ?? '/Applications/Cursor.app',
    detectedVersion: shape.version ?? '3.19.7',
    versionDetectionMethod: 'bundle_plist',
    agentId: 'agent-cursor-1',
    supportedCapability: shape.supportedCapability ?? 4,
    lastDetectedAt,
    metadata: {
      distribution,
      ...(shape.componentConfigFiles ? { componentConfigFiles: shape.componentConfigFiles } : {}),
      ...(shape.managementEligibility ? { managementEligibility: shape.managementEligibility } : {}),
    },
  })
}

/** Installation approved by the user, connected and green-verified on generation 1. */
function seedApprovedAndVerified(
  db: Database.Database,
  repository: AgentIntegrationRepository,
  shape: InstallationShape = {},
): void {
  upsert(repository, shape, T0)
  repository.createConsent({
    id: 'consent-1',
    installationId: 'cursor-1',
    policyVersion: '1',
    allowedComponents: ['memory_tools'],
    allowedScopes: ['/Users/fixture/.cursor'],
    normalizedTargets: ['/Users/fixture/.cursor/mcp.json'],
    selectorSchemaVersion: '1',
    selectorResolution: { key: 'tidemind' },
    executableRealpaths: [],
    commandCategories: ['file_write'],
    maximumRisk: 'low',
    confirmedAt: T0,
  })
  repository.upsertComponent({
    installationId: 'cursor-1',
    componentKey: 'memory_tools',
    desiredState: 'managed',
    desiredCapability: 2,
    deliveryMode: 'managed',
    consentEnvelopeId: 'consent-1',
  }, T0)
  repository.recordVerificationResult({
    id: 'verification-1',
    installationId: 'cursor-1',
    componentKey: 'memory_tools',
    family: 'cursor',
    hostVariant: 'cursor-desktop',
    runtimeRealm: 'local_macos',
    hostVersion: shape.version ?? '3.19.7',
    adapterVersion: '1',
    catalogVersion: '1',
    projectionVersion: '1',
    selectorSchemaVersion: '1',
    verificationManifestVersion: '1',
    method: 'host_list',
    identityAssertion: 'agent-cursor-1',
    result: 'verified',
    evidenceHash: 'generation-1-evidence',
    verifiedAt: T0,
  })
  db.prepare(`
    UPDATE agent_installations
    SET desired_state = 'managed', consent_envelope_id = 'consent-1', consented_at = ?,
        verified_capability = 2, verification_summary = 'verified', status_reason = 'verified',
        reconcile_state = 'idle'
    WHERE id = 'cursor-1'
  `).run(T0)
}

function consentState(db: Database.Database) {
  return db.prepare(`SELECT status, revoked_at FROM agent_consents WHERE id = 'consent-1'`).get()
}

function verificationInvalidation(db: Database.Database) {
  return db.prepare(`
    SELECT invalidated_at, invalidation_reason FROM verification_results WHERE id = 'verification-1'
  `).get()
}

describe('repository: generation change keeps approval, approval-scope change revokes it', () => {
  it.each([
    ['the host version', { version: '3.20.0' }, 'host_version_changed'],
    ['the versioned executable path', {
      distribution: { executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor-3.20' },
    }, 'host_installation_surface_changed'],
    ['the code capability fingerprint (CDHash/Info.plist)', {
      distribution: { capabilityFingerprint: 'desktop-bundle-surface-v1:generation-2' },
    }, 'host_installation_surface_changed'],
    ['the portable artifact fingerprint', {
      distribution: { portableArtifactFingerprint: 'b'.repeat(64) },
    }, 'host_installation_surface_changed'],
    ['version, executable, code and artifact fingerprint together (normal upgrade)', {
      version: '3.20.0',
      distribution: {
        executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor-3.20',
        capabilityFingerprint: 'desktop-bundle-surface-v1:generation-2',
        portableArtifactFingerprint: 'b'.repeat(64),
      },
    }, 'host_installation_surface_changed'],
    ['the supported capability (source became not official)', { supportedCapability: 0 }, 'host_installation_surface_changed'],
    ['the persisted management eligibility (source verification pending)', {
      managementEligibility: {
        schemaVersion: 1,
        eligible: false,
        reason: 'source_verification_pending',
        proofLimitBytes: 64 * 1024 * 1024,
      },
    }, 'host_installation_surface_changed'],
  ] as const)('keeps consent active but invalidates verification when %s changes', (_label, change, invalidation) => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      const before = repository.getInstallation('cursor-1')!
      const changed = upsert(repository, change as InstallationShape, T1)

      expect(persistedConsentSurfaceFingerprint(changed)).toBe(persistedConsentSurfaceFingerprint(before))
      expect(changed).toMatchObject({
        id: 'cursor-1',
        agent_id: 'agent-cursor-1',
        desired_state: 'managed',
        consent_envelope_id: 'consent-1',
        consented_at: T0,
        reconcile_state: 'idle',
        verified_capability: 0,
        verification_summary: 'stale',
        status_reason: 'verification_stale',
      })
      expect(consentState(db)).toEqual({ status: 'active', revoked_at: null })
      expect(verificationInvalidation(db)).toEqual({ invalidated_at: T1, invalidation_reason: invalidation })
      expect(db.prepare(`
        SELECT verification_status, consent_envelope_id FROM installation_components
        WHERE installation_id = 'cursor-1' AND component_key = 'memory_tools'
      `).get()).toEqual({ verification_status: 'stale', consent_envelope_id: 'consent-1' })
      expect(repository.listInstallationEvents('cursor-1').map(event => event.kind)).toContain(invalidation)
    } finally {
      db.close()
    }
  })

  it.each([
    ['the config root', { configRoot: '/Users/fixture/.cursor-other' }],
    ['the package provenance (signing Team)', {
      distribution: { packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:FIXTURE123' },
    }],
    ['the distribution id', { distribution: { distributionId: 'com.fixture.cursor-fork' } }],
    ['the app bundle path', { appPath: '/Users/fixture/Applications/Cursor.app' }],
    ['an exact component config target', {
      componentConfigFiles: { memory_tools: '/Users/fixture/.cursor/other-mcp.json' },
    }],
  ] as const)('revokes consent when %s changes', (_label, change) => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      const before = repository.getInstallation('cursor-1')!
      const changed = upsert(repository, change as InstallationShape, T1)

      expect(persistedConsentSurfaceFingerprint(changed)).not.toBe(persistedConsentSurfaceFingerprint(before))
      expect(changed).toMatchObject({
        id: 'cursor-1',
        consent_envelope_id: null,
        consented_at: null,
        reconcile_state: 'awaiting_consent',
        status_reason: 'awaiting_consent',
        verified_capability: 0,
        verification_summary: 'stale',
      })
      expect(consentState(db)).toEqual({ status: 'revoked', revoked_at: T1 })
      expect(verificationInvalidation(db)).toEqual({
        invalidated_at: T1,
        invalidation_reason: 'host_installation_surface_changed',
      })
    } finally {
      db.close()
    }
  })

  it('keeps the approval across several consecutive upgrades and does not touch an unchanged rescan', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      upsert(repository, { version: '3.19.7' }, T1)
      // An identical rescan changes nothing.
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        status_reason: 'verified',
        verification_summary: 'verified',
        verified_capability: 2,
      })
      expect(verificationInvalidation(db)).toEqual({ invalidated_at: null, invalidation_reason: null })

      upsert(repository, {
        version: '3.20.0',
        distribution: { capabilityFingerprint: 'desktop-bundle-surface-v1:generation-2' },
      }, T1)
      upsert(repository, {
        version: '3.21.0',
        distribution: {
          executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor-3.21',
          capabilityFingerprint: 'desktop-bundle-surface-v1:generation-3',
        },
      }, T2)
      expect(consentState(db)).toEqual({ status: 'active', revoked_at: null })
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        consent_envelope_id: 'consent-1',
        detected_version: '3.21.0',
        verification_summary: 'stale',
      })
    } finally {
      db.close()
    }
  })

  it('does not revoke consent for a disabled Installation on a generation change and keeps it paused', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      db.prepare(`UPDATE agent_installations SET desired_state = 'disabled', reconcile_state = 'paused', status_reason = 'paused_by_user' WHERE id = 'cursor-1'`).run()
      const changed = upsert(repository, { version: '3.20.0' }, T1)
      expect(changed).toMatchObject({
        desired_state: 'disabled',
        reconcile_state: 'paused',
        consent_envelope_id: 'consent-1',
        verified_capability: 0,
      })
      expect(consentState(db)).toEqual({ status: 'active', revoked_at: null })
    } finally {
      db.close()
    }
  })
})

describe('repository: kept approval must still cover host commands of the new generation', () => {
  // Gemini extensions and Pi/OMP packages are installed through `host_command`
  // mutations; their consent envelope binds `executableRealpaths`
  // (service.ts createConsent → consent.ts checkPlanAgainstConsent rejects
  // `executable_out_of_scope`). A normal npm upgrade / Node version switch moves
  // that realpath. Keeping such a consent "active" while it can no longer cover any
  // repair/upgrade plan leaves the Installation idle with an unusable approval:
  // every automatic maintenance fails with "active consent does not cover prepared
  // plan" instead of asking the user to re-approve.
  it('does not keep an active consent bound to the previous executable realpath', () => {
    const { db, repository } = setup()
    try {
      const oldExecutable = '/Users/fixture/.nvm/versions/node/v22.1.0/lib/node_modules/@google/gemini-cli/dist/index.js'
      const newExecutable = '/Users/fixture/.nvm/versions/node/v24.0.0/lib/node_modules/@google/gemini-cli/dist/index.js'
      const base = {
        id: 'gemini-1',
        family: 'gemini',
        hostVariant: 'gemini-cli',
        installKey: 'gemini:fixture-default',
        distributionId: 'cli:gemini-cli',
        provenance: 'command:PATH:gemini',
        osUserIdentity: 'usr_fixture_0001',
        displayName: 'Gemini CLI',
        configRoot: '/Users/fixture/.gemini',
        agentId: 'agent-gemini-1',
        supportedCapability: 4,
      }
      const distribution = (executableRealpath: string) => ({
        distributionId: 'cli:gemini-cli',
        executableRealpath,
        packageProvenance: 'npm_metadata:@google/gemini-cli',
        capabilityFingerprint: `cli-surface:${executableRealpath.length}`,
      })
      repository.upsertDiscoveredInstallation({
        ...base,
        executablePath: oldExecutable,
        detectedVersion: '0.58.0',
        lastDetectedAt: T0,
        metadata: { distribution: distribution(oldExecutable) },
      })
      repository.createConsent({
        id: 'consent-1',
        installationId: 'gemini-1',
        policyVersion: '1',
        allowedComponents: ['instruction', 'memory_tools'],
        allowedScopes: ['file:/Users/fixture/.gemini/extensions/tidemind'],
        normalizedTargets: ['/Users/fixture/.gemini/extensions/tidemind'],
        selectorSchemaVersion: '1',
        selectorResolution: { 'gemini-cli:memory_tools:tidemind': 'tidemind' },
        executableRealpaths: [oldExecutable],
        commandCategories: ['plugin_install'],
        maximumRisk: 'elevated',
        confirmedAt: T0,
      })
      db.prepare(`
        UPDATE agent_installations
        SET desired_state = 'managed', consent_envelope_id = 'consent-1', consented_at = ?, reconcile_state = 'idle'
        WHERE id = 'gemini-1'
      `).run(T0)

      repository.upsertDiscoveredInstallation({
        ...base,
        executablePath: newExecutable,
        detectedVersion: '0.60.0',
        lastDetectedAt: T1,
        metadata: { distribution: distribution(newExecutable) },
      })

      const consent = db.prepare(`
        SELECT status, executable_realpaths_json FROM agent_consents WHERE id = 'consent-1'
      `).get() as { status: string; executable_realpaths_json: string }
      const row = repository.getInstallation('gemini-1')!
      if (consent.status === 'active') {
        // Either the approval is re-bound to the current generation's executable …
        expect(JSON.parse(consent.executable_realpaths_json)).toContain(newExecutable)
      } else {
        // … or it is revoked and the user is asked again.
        expect(row).toMatchObject({ consent_envelope_id: null, reconcile_state: 'awaiting_consent' })
      }
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// resolveGenerationIdentityConflict (repository)
// ---------------------------------------------------------------------------

function markOldBuildConflict(repository: AgentIntegrationRepository, reason = EXACT_INSTALL_KEY_DISTRIBUTION_CONFLICT_REASON) {
  repository.markInstallationIdentityConflict('cursor-1', T1, reason)
  // Builds before the generation-aware matcher wrote no rule marker.
  ;(repository as unknown as { db: Database.Database }).db.prepare(`
    UPDATE agent_integration_events
    SET payload_json = json_remove(payload_json, '$.ruleVersion'),
        dedupe_key = installation_id || ':distribution_identity_conflict'
    WHERE installation_id = 'cursor-1' AND kind = 'discovery_identity_conflict'
  `).run()
}

function conflictRow(repository: AgentIntegrationRepository) {
  const row = repository.getInstallation('cursor-1')!
  return {
    health_state: row.health_state,
    reconcile_state: row.reconcile_state,
    status_reason: row.status_reason,
    consent_envelope_id: row.consent_envelope_id,
  }
}

function addArtifactInState(
  db: Database.Database,
  repository: AgentIntegrationRepository,
  state: 'healthy' | 'conflict' | 'drifted',
): void {
  repository.createManagedArtifact({
    id: 'artifact-1',
    componentType: 'mcp',
    targetPath: '/Users/fixture/.cursor/mcp.json',
    ownershipKey: 'mcpServers.tidemind',
    mutationDomain: 'local_macos:file:/Users/fixture/.cursor/mcp.json:mcpServers.tidemind',
    projectionVersion: '1',
    selectorSchemaVersion: '1',
    ownedFragmentHash: 'owned',
    desiredFragmentHash: 'owned',
  }, T0)
  repository.addArtifactConsumer({
    artifactId: 'artifact-1',
    installationId: 'cursor-1',
    componentKey: 'memory_tools',
    requiredCapability: 2,
    discoverReachability: 'shared_visible',
    consentEnvelopeId: 'consent-1',
    ownershipFingerprint: 'owned',
    addedAt: T0,
  })
  db.prepare(`UPDATE managed_artifacts SET state = ? WHERE id = 'artifact-1'`).run(state)
}

describe('repository.resolveGenerationIdentityConflict', () => {
  it('releases an exact-install-key distribution conflict to verification_stale without recreating consent', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      markOldBuildConflict(repository)
      expect(conflictRow(repository)).toMatchObject({
        health_state: 'inaccessible', reconcile_state: 'paused', status_reason: 'conflict',
      })
      // The new matcher accepted the generation-only difference.
      upsert(repository, { version: '3.20.0', distribution: { capabilityFingerprint: 'desktop-bundle-surface-v1:g2' } }, T2)

      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(true)
      expect(conflictRow(repository)).toEqual({
        health_state: 'discovered',
        reconcile_state: 'idle',
        status_reason: 'verification_stale',
        consent_envelope_id: 'consent-1',
      })
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        verified_capability: 0,
        verification_summary: 'stale',
        updated_at: T2,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 1 })
      const resolved = repository.listInstallationEvents('cursor-1')
        .filter(event => event.kind === 'discovery_identity_conflict_resolved')
      expect(resolved).toHaveLength(1)
      expect(resolved[0]).toMatchObject({ severity: 'info' })
      // Idempotent: nothing left to resolve.
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('moves a managed Installation whose consent was already revoked to awaiting_consent', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      db.prepare(`UPDATE agent_installations SET consent_envelope_id = NULL, consented_at = NULL WHERE id = 'cursor-1'`).run()
      db.prepare(`UPDATE agent_consents SET status = 'revoked', revoked_at = ? WHERE id = 'consent-1'`).run(T0)
      markOldBuildConflict(repository)
      upsert(repository, { version: '3.20.0' }, T2)

      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(true)
      expect(conflictRow(repository)).toEqual({
        health_state: 'discovered',
        reconcile_state: 'awaiting_consent',
        status_reason: 'verification_stale',
        consent_envelope_id: null,
      })
      expect(consentState(db)).toEqual({ status: 'revoked', revoked_at: T0 })
    } finally {
      db.close()
    }
  })

  it('keeps a disabled Installation paused when releasing the conflict', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      db.prepare(`UPDATE agent_installations SET desired_state = 'disabled' WHERE id = 'cursor-1'`).run()
      markOldBuildConflict(repository)
      upsert(repository, { version: '3.20.0' }, T2)

      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(true)
      expect(conflictRow(repository)).toMatchObject({ reconcile_state: 'paused', status_reason: 'verification_stale' })
    } finally {
      db.close()
    }
  })

  it('moves an unmanaged Installation back to idle', () => {
    const { db, repository } = setup()
    try {
      upsert(repository, {}, T0)
      markOldBuildConflict(repository)
      upsert(repository, { version: '3.20.0' }, T2)
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(true)
      expect(conflictRow(repository)).toMatchObject({ reconcile_state: 'idle', status_reason: 'verification_stale' })
    } finally {
      db.close()
    }
  })

  it.each([
    'Multiple records share the exact install key.',
    'A record exists in the same stable scope, but the changed config root has no proven alias.',
    'Strong distribution identity is incomplete: packageProvenance.',
  ])('does not release a conflict raised for another reason: %s', reason => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      markOldBuildConflict(repository, reason)
      upsert(repository, { version: '3.20.0' }, T2)
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(false)
      expect(conflictRow(repository)).toMatchObject({ reconcile_state: 'paused', status_reason: 'conflict' })
      expect(repository.listInstallationEvents('cursor-1').map(event => event.kind))
        .not.toContain('discovery_identity_conflict_resolved')
    } finally {
      db.close()
    }
  })

  it('does not release when the history also holds a conflict with another reason', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      markOldBuildConflict(repository)
      repository.recordEvent({
        installationId: 'cursor-1',
        kind: 'discovery_identity_conflict',
        severity: 'warning',
        dedupeKey: 'cursor-1:ambiguous-history',
        payload: { reason: 'Multiple records share the exact install key.' },
        createdAt: T1,
      })
      upsert(repository, { version: '3.20.0' }, T2)
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(false)
      expect(conflictRow(repository)).toMatchObject({ status_reason: 'conflict' })
    } finally {
      db.close()
    }
  })

  it('does not release when no identity-conflict event proves the reason', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      db.prepare(`
        UPDATE agent_installations SET status_reason = 'conflict', reconcile_state = 'paused' WHERE id = 'cursor-1'
      `).run()
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(false)
      expect(conflictRow(repository)).toMatchObject({ status_reason: 'conflict' })
    } finally {
      db.close()
    }
  })

  it.each(['conflict', 'drifted'] as const)('does not release while a consumed Artifact is %s', state => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      addArtifactInState(db, repository, state)
      markOldBuildConflict(repository)
      upsert(repository, { version: '3.20.0' }, T2)
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(false)
      expect(conflictRow(repository)).toMatchObject({ reconcile_state: 'paused', status_reason: 'conflict' })
      expect(db.prepare(`SELECT state FROM managed_artifacts WHERE id = 'artifact-1'`).get()).toEqual({ state })
    } finally {
      db.close()
    }
  })

  it('releases alongside a healthy consumed Artifact without touching it', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      addArtifactInState(db, repository, 'healthy')
      markOldBuildConflict(repository)
      upsert(repository, { version: '3.20.0' }, T2)
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(true)
      expect(db.prepare(`SELECT state FROM managed_artifacts WHERE id = 'artifact-1'`).get()).toEqual({ state: 'healthy' })
    } finally {
      db.close()
    }
  })

  it('does not touch a row that is not in the paused identity-conflict state', () => {
    const { db, repository } = setup()
    try {
      seedApprovedAndVerified(db, repository)
      markOldBuildConflict(repository)
      db.prepare(`UPDATE agent_installations SET reconcile_state = 'needs_recovery' WHERE id = 'cursor-1'`).run()
      expect(repository.resolveGenerationIdentityConflict('cursor-1', T2)).toBe(false)
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        reconcile_state: 'needs_recovery',
        status_reason: 'conflict',
      })
      expect(repository.resolveGenerationIdentityConflict('missing-installation', T2)).toBe(false)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Service scan: the new matcher + conflict release end to end
// ---------------------------------------------------------------------------

function discoveredCursor(distribution: DistributionIdentity, version: string): DiscoveredInstallation {
  return {
    catalogId: 'cursor-desktop',
    displayName: 'Cursor',
    identity: canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_0001',
      productFamilyId: 'cursor',
      hostVariant: 'cursor-desktop',
      configRoot: '/Users/fixture/.cursor',
      distribution,
    }),
    configRoot: '/Users/fixture/.cursor',
    executablePath: distribution.executableRealpath,
    appPath: '/Applications/Cursor.app',
    detectedVersion: version,
    versionDetectionMethod: 'bundle_plist',
    provenance: ['fixture signed Cursor.app'],
    evidence: [],
  }
}

function scanService(repository: AgentIntegrationRepository, current: { report: LocalDiscoveryReport }, now = T0) {
  let clock = now
  const service = new AgentIntegrationService({
    repository,
    scanner: { scan: async () => current.report },
    execution: { preview: vi.fn(), applyPrepared: vi.fn() },
    now: () => new Date(clock),
    installationId: () => 'cursor-1',
    agentId: () => 'agent-cursor-1',
    homeDir: '/Users/fixture',
  })
  return { service, setNow: (value: string) => { clock = value } }
}

const GENERATION_2: Distribution = {
  ...GENERATION_1,
  executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor-3.20',
  capabilityFingerprint: 'desktop-bundle-surface-v1:generation-2',
  portableArtifactFingerprint: 'b'.repeat(64),
}

async function scannedWithOldBuildConflict(options: {
  reason?: string
  desiredState?: 'managed' | 'disabled'
  artifactState?: 'healthy' | 'conflict' | 'drifted'
} = {}) {
  const { db, repository } = setup()
  const current = { report: { installations: [discoveredCursor(GENERATION_1, '3.19.7')], unresolved: [], diagnostics: [] } as LocalDiscoveryReport }
  const { service, setNow } = scanService(repository, current)
  await service.scan()
  const row = repository.getInstallation('cursor-1')!
  expect(row).toMatchObject({ health_state: 'discovered', detected_version: '3.19.7' })
  // The user approved and connected generation 1.
  repository.createConsent({
    id: 'consent-1',
    installationId: 'cursor-1',
    policyVersion: '1',
    allowedComponents: ['memory_tools'],
    allowedScopes: ['/Users/fixture/.cursor'],
    normalizedTargets: ['/Users/fixture/.cursor/mcp.json'],
    selectorSchemaVersion: '1',
    selectorResolution: { key: 'tidemind' },
    executableRealpaths: [],
    commandCategories: ['file_write'],
    maximumRisk: 'low',
    confirmedAt: T0,
  })
  db.prepare(`
    UPDATE agent_installations
    SET desired_state = ?, consent_envelope_id = 'consent-1', consented_at = ?,
        verified_capability = 2, verification_summary = 'verified', status_reason = 'verified',
        reconcile_state = 'idle'
    WHERE id = 'cursor-1'
  `).run(options.desiredState ?? 'managed', T0)
  repository.upsertComponent({
    installationId: 'cursor-1',
    componentKey: 'memory_tools',
    desiredState: 'managed',
    desiredCapability: 2,
    deliveryMode: 'managed',
    consentEnvelopeId: 'consent-1',
  }, T0)
  if (options.artifactState) addArtifactInState(db, repository, options.artifactState)
  // An earlier build saw generation 2 and — under the strong-field rule — raised a
  // distribution conflict for the versioned executable / CDHash change.
  markOldBuildConflict(repository, options.reason)
  return { db, repository, service, setNow, current }
}

describe('service scan releases conflicts raised by the old strong-field rule', () => {
  it('matches the upgraded generation, releases the conflict and keeps the approval', async () => {
    const { db, repository, service, setNow, current } = await scannedWithOldBuildConflict()
    try {
      current.report = { installations: [discoveredCursor(GENERATION_2, '3.20.0')], unresolved: [], diagnostics: [] }
      setNow(T2)
      await service.scan()

      expect(repository.listInstallations()).toHaveLength(1)
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        id: 'cursor-1',
        agent_id: 'agent-cursor-1',
        health_state: 'discovered',
        detected_version: '3.20.0',
        executable_path: GENERATION_2.executableRealpath,
        reconcile_state: 'idle',
        status_reason: 'verification_stale',
        verified_capability: 0,
        consent_envelope_id: 'consent-1',
      })
      expect(consentState(db)).toEqual({ status: 'active', revoked_at: null })
      expect(repository.listInstallationEvents('cursor-1').map(event => event.kind))
        .toContain('discovery_identity_conflict_resolved')
    } finally {
      db.close()
    }
  })

  it('keeps a disabled Installation paused after the release', async () => {
    const { db, repository, service, setNow, current } = await scannedWithOldBuildConflict({ desiredState: 'disabled' })
    try {
      current.report = { installations: [discoveredCursor(GENERATION_2, '3.20.0')], unresolved: [], diagnostics: [] }
      setNow(T2)
      await service.scan()
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        desired_state: 'disabled',
        reconcile_state: 'paused',
        status_reason: 'verification_stale',
        health_state: 'discovered',
      })
    } finally {
      db.close()
    }
  })

  it('does not release an ambiguous-identity conflict', async () => {
    const { db, repository, service, setNow, current } = await scannedWithOldBuildConflict({
      reason: 'Multiple records share the exact install key.',
    })
    try {
      current.report = { installations: [discoveredCursor(GENERATION_2, '3.20.0')], unresolved: [], diagnostics: [] }
      setNow(T2)
      await service.scan()
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        reconcile_state: 'paused',
        status_reason: 'conflict',
      })
      expect(repository.listInstallationEvents('cursor-1').map(event => event.kind))
        .not.toContain('discovery_identity_conflict_resolved')
    } finally {
      db.close()
    }
  })

  it.each(['conflict', 'drifted'] as const)('does not release while a consumed Artifact is %s', async artifactState => {
    const { db, repository, service, setNow, current } = await scannedWithOldBuildConflict({ artifactState })
    try {
      current.report = { installations: [discoveredCursor(GENERATION_2, '3.20.0')], unresolved: [], diagnostics: [] }
      setNow(T2)
      await service.scan()
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        reconcile_state: 'paused',
        status_reason: 'conflict',
      })
    } finally {
      db.close()
    }
  })

  it('still raises a conflict (and does not release it) when the rescan reports a different provenance', async () => {
    const { db, repository, service, setNow, current } = await scannedWithOldBuildConflict()
    try {
      current.report = {
        installations: [discoveredCursor({
          ...GENERATION_2,
          packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:FIXTURE123',
        }, '3.20.0')],
        unresolved: [],
        diagnostics: [],
      }
      setNow(T2)
      await service.scan()
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        health_state: 'inaccessible',
        reconcile_state: 'paused',
        status_reason: 'conflict',
        detected_version: '3.19.7',
        executable_path: GENERATION_1.executableRealpath,
      })
      expect(repository.listInstallationEvents('cursor-1').map(event => event.kind))
        .not.toContain('discovery_identity_conflict_resolved')
    } finally {
      db.close()
    }
  })

  it('keeps a conflict raised by the current rule for a real provenance change sticky after the source flips back', async () => {
    // Under the new matcher an exact-install-key conflict is only raised for a real
    // source change (distributionId/packageProvenance). The release path cannot tell
    // such a conflict from one raised by an older build for a generation-only
    // difference (same reason text, same per-installation dedupe key), so a briefly
    // replaced binary that is later restored silently regains its active consent.
    const { db, repository } = setup()
    try {
      const current = { report: { installations: [discoveredCursor(GENERATION_1, '3.19.7')], unresolved: [], diagnostics: [] } as LocalDiscoveryReport }
      const { service, setNow } = scanService(repository, current)
      await service.scan()
      db.prepare(`UPDATE agent_installations SET desired_state = 'managed', reconcile_state = 'idle' WHERE id = 'cursor-1'`).run()

      current.report = {
        installations: [discoveredCursor({
          ...GENERATION_1,
          packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:FIXTURE123',
        }, '3.19.7')],
        unresolved: [],
        diagnostics: [],
      }
      setNow(T1)
      await service.scan()
      expect(repository.getInstallation('cursor-1')).toMatchObject({ status_reason: 'conflict', reconcile_state: 'paused' })

      current.report = { installations: [discoveredCursor(GENERATION_1, '3.19.7')], unresolved: [], diagnostics: [] }
      setNow(T2)
      await service.scan()
      expect(repository.getInstallation('cursor-1')).toMatchObject({ status_reason: 'conflict', reconcile_state: 'paused' })
    } finally {
      db.close()
    }
  })

  it('keeps strict matching for a legacy row without provenance: an executable change is an identity conflict', async () => {
    // Without a verified provenance on the stored record, an executable change cannot
    // be told apart from a replacement: the matcher stays strict and does not merge.
    const { db, repository } = setup()
    try {
      const legacy = { distributionId: CURSOR_ID, executableRealpath: GENERATION_1.executableRealpath }
      const current = { report: { installations: [discoveredCursor(legacy, '3.19.7')], unresolved: [], diagnostics: [] } as LocalDiscoveryReport }
      const { service, setNow } = scanService(repository, current)
      await service.scan()
      repository.createConsent({
        id: 'consent-1',
        installationId: 'cursor-1',
        policyVersion: '1',
        allowedComponents: ['memory_tools'],
        allowedScopes: ['/Users/fixture/.cursor'],
        normalizedTargets: ['/Users/fixture/.cursor/mcp.json'],
        selectorSchemaVersion: '1',
        selectorResolution: { key: 'tidemind' },
        executableRealpaths: [],
        commandCategories: ['file_write'],
        maximumRisk: 'low',
        confirmedAt: T0,
      })
      db.prepare(`
        UPDATE agent_installations
        SET desired_state = 'managed', consent_envelope_id = 'consent-1', consented_at = ?, reconcile_state = 'idle'
        WHERE id = 'cursor-1'
      `).run(T0)

      current.report = { installations: [discoveredCursor(GENERATION_2, '3.20.0')], unresolved: [], diagnostics: [] }
      setNow(T2)
      await service.scan()

      expect(repository.listInstallations()).toHaveLength(1)
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        health_state: 'inaccessible',
        status_reason: 'conflict',
        executable_path: GENERATION_1.executableRealpath,
        reconcile_state: 'paused',
      })
      // A conflict raised by the current rule is never auto-released on a later scan.
      await service.scan()
      expect(repository.getInstallation('cursor-1')?.status_reason).toBe('conflict')
      expect(consentState(db)).toEqual({ status: 'active', revoked_at: null })
    } finally {
      db.close()
    }
  })

  it('upgrades without any conflict when the Installation was never marked by an old build', async () => {
    const { db, repository } = setup()
    try {
      const current = { report: { installations: [discoveredCursor(GENERATION_1, '3.19.7')], unresolved: [], diagnostics: [] } as LocalDiscoveryReport }
      const { service, setNow } = scanService(repository, current)
      await service.scan()
      current.report = { installations: [discoveredCursor(GENERATION_2, '3.20.0')], unresolved: [], diagnostics: [] }
      setNow(T2)
      await service.scan()
      expect(repository.listInstallations()).toHaveLength(1)
      expect(repository.getInstallation('cursor-1')).toMatchObject({
        health_state: 'discovered',
        detected_version: '3.20.0',
      })
      expect(repository.getInstallation('cursor-1')!.status_reason).not.toBe('conflict')
      expect(repository.listInstallationEvents('cursor-1').map(event => event.kind))
        .not.toContain('discovery_identity_conflict')
    } finally {
      db.close()
    }
  })
})
