import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SqliteHostActivityEvidenceReader,
  verifyHostActivity,
  verifyMemoryReadWriteActivity,
} from '../../client/electron/agent-integration/host-activity-evidence'
import { createJsonMcpHostAdapter } from '../../client/electron/agent-integration/hosts/json-mcp-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import type { AdapterOperationContext, AdapterVerificationRequest } from '../../client/electron/agent-integration/types'
import {
  recordHookActivityEvidence as recordHookActivityEvidenceRaw,
  recordHostActivityEvidence as recordHostActivityEvidenceRaw,
} from '../../src/db/agent-host-activity'
import { ensureSchema } from '../../src/db/schema'

const T0 = '2026-08-26T00:00:00.000Z'
const T1 = '2026-08-26T00:01:00.000Z'
const AFTER = '2026-07-27T00:00:00.000Z'
const AGENT_ID = 'eb_activity01'
const ACTIVITY_TOKEN = 'operation-activity'

const recordHostActivityEvidence = (
  db: Database.Database,
  input: Omit<Parameters<typeof recordHostActivityEvidenceRaw>[1], 'activityGenerationToken'>
    & { activityGenerationToken?: string },
) => recordHostActivityEvidenceRaw(db, { activityGenerationToken: ACTIVITY_TOKEN, ...input })

const recordHookActivityEvidence = (
  db: Database.Database,
  input: Omit<Parameters<typeof recordHookActivityEvidenceRaw>[1], 'activityGenerationToken'>
    & { activityGenerationToken?: string },
) => recordHookActivityEvidenceRaw(db, { activityGenerationToken: ACTIVITY_TOKEN, ...input })

const databases: Database.Database[] = []
const roots: string[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

function setup(componentKey: 'memory_tools' | 'lifecycle' = 'memory_tools') {
  const db = new Database(':memory:')
  databases.push(db)
  ensureSchema(db)
  db.prepare(`
    INSERT INTO agents (id, name, tool_type, archived, created)
    VALUES (?, 'Activity fixture', 'cursor', 0, ?)
  `).run(AGENT_ID, T0)
  db.prepare(`
    INSERT INTO agent_installations (
      id, family, host_variant, runtime_realm, profile_id, install_key,
      provenance, display_name, detected_version, agent_id, desired_state,
      supported_capability, desired_capability, health_state, created_at, updated_at
    ) VALUES (
      'installation-activity', 'cursor', 'cursor-desktop', 'local_macos',
      'default', 'cursor:activity', 'fixture', 'Cursor', '2.3.4', ?, 'managed',
      4, 4, 'discovered', ?, ?
    )
  `).run(AGENT_ID, T0, T0)
  db.prepare(`
    INSERT INTO managed_artifacts (
      id, component_type, target_path, ownership_key, mutation_domain,
      projection_version, selector_schema_version, owned_fragment_hash,
      observed_fragment_hash, state, created_at, updated_at
    ) VALUES (
      'artifact-activity', ?, '/fixture/activity', 'document',
      'local_macos:file:/fixture/activity:document', '7', '1',
      'owned-hash', 'owned-hash', 'healthy', ?, ?
    )
  `).run(componentKey === 'memory_tools' ? 'mcp' : 'hook', T0, T0)
  db.prepare(`
    INSERT INTO installation_components (
      installation_id, component_key, desired_state, desired_capability,
      delivery_mode, verification_status, artifact_id, visibility_state,
      created_at, updated_at
    ) VALUES (
      'installation-activity', ?, 'managed', 4, 'managed', 'unverified',
      'artifact-activity', 'dedicated', ?, ?
    )
  `).run(componentKey, T0, T0)
  db.prepare(`
    INSERT INTO artifact_consumers (
      artifact_id, installation_id, component_key, required_capability,
      desired_state, discover_reachability, state, added_at, updated_at
    ) VALUES (
      'artifact-activity', 'installation-activity', ?, 4, 'managed',
      'dedicated', 'active', ?, ?
    )
  `).run(componentKey, T0, T0)
  db.prepare(`
    INSERT INTO reconcile_runs (
      id, installation_id, operation_type, execution_plan_hash, state,
      recovery_strategy, adapter_version, catalog_version, projection_version,
      selector_schema_version, prepared_plan_json, desired_capability,
      created_at, updated_at
    ) VALUES (
      'run-activity', 'installation-activity', 'connect', 'plan-hash', 'committed',
      'readback_before_replay', 'adapter-3', '1', '7', '1', ?, 4, ?, ?
    )
  `).run(JSON.stringify({
    componentKeys: [componentKey],
    activityGenerationToken: ACTIVITY_TOKEN,
    executionPlan: { activityGenerationTokenHash: sha256Json(ACTIVITY_TOKEN) },
  }), T0, T0)
  db.prepare(`
    INSERT INTO agent_consents (
      id, installation_id, policy_version, allowed_components_json,
      allowed_scopes_json, normalized_targets_json, selector_schema_version,
      selector_resolution_json, executable_realpaths_json, command_categories_json,
      maximum_risk, status, confirmed_at, created_at
    ) VALUES (
      'consent-activity', 'installation-activity', '1', ?, '[]', '[]', '1',
      '{}', '[]', '[]', 'low', 'active', ?, ?
    )
  `).run(JSON.stringify([componentKey]), T0, T0)
  db.prepare(`UPDATE agent_installations SET consent_envelope_id = 'consent-activity'
    WHERE id = 'installation-activity'`).run()
  db.prepare(`UPDATE installation_components SET consent_envelope_id = 'consent-activity'
    WHERE installation_id = 'installation-activity'`).run()
  db.prepare(`UPDATE artifact_consumers SET consent_envelope_id = 'consent-activity'
    WHERE installation_id = 'installation-activity'`).run()
  db.prepare(`UPDATE reconcile_runs SET consent_envelope_id = 'consent-activity'
    WHERE id = 'run-activity'`).run()
  return db
}

function context(reader?: SqliteHostActivityEvidenceReader): AdapterOperationContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-activity-'))
  roots.push(root)
  const configRoot = path.join(root, '.cursor')
  fs.mkdirSync(configRoot)
  return {
    runtime: {
      runtimeRealm: 'local_macos',
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      shimPath: '/shim',
      mcpServerPath: '/mcp',
      hookScriptPath: '/hook',
      preCompactScriptPath: '/pre',
      postCompactScriptPath: '/post',
      tideMindVersion: '0.2.89',
      catalogVersion: '1',
      projectionVersion: '7',
    },
    installation: canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JHOSTACTIVITY',
      productFamilyId: 'cursor',
      hostVariant: 'cursor-desktop',
      configRoot,
    }),
    agentId: AGENT_ID,
    operationId: 'operation-activity',
    activityGenerationToken: ACTIVITY_TOKEN,
    hostActivityEvidence: reader,
  }
}

function verificationRequest(
  inspection: AdapterVerificationRequest['inspection'],
  componentKey: 'memory_tools' | 'lifecycle',
): AdapterVerificationRequest {
  return {
    componentKeys: [componentKey],
    expectedCapability: 4,
    inspection,
    activityBinding: {
      installationId: 'installation-activity',
      tideMindVersion: '0.2.89',
      adapterVersion: 'adapter-3',
      projectionVersion: '7',
      hostVersion: '2.3.4',
      activationRunId: 'run-activity',
      activityGenerationToken: ACTIVITY_TOKEN,
      observedAfter: AFTER,
      verifiedAt: T1,
    },
  }
}

describe('managed host activity evidence', () => {
  it('records only the latest successful invocation in the local integration table', () => {
    const db = setup()
    const first = recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_recall',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })
    const second = recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_recall',
      tideMindVersion: '0.2.89',
      observedAt: T1,
    })

    expect(first).toMatchObject({ status: 'recorded', installationId: 'installation-activity' })
    expect(second).toMatchObject({ status: 'recorded', installationId: 'installation-activity' })
    expect(db.prepare(`
      SELECT COUNT(*) AS count, MAX(observed_at) AS observed_at
      FROM agent_host_activity_evidence
    `).get()).toEqual({ count: 1, observed_at: T1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM nodes`).get()).toEqual({ count: 0 })
  })

  it('rejects managed activity after its current consent is revoked or switched', () => {
    const db = setup()
    const input = {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools' as const,
      signalName: 'brain_recall' as const,
      tideMindVersion: '0.2.89',
      observedAt: T0,
    }
    const query = {
      installationId: 'installation-activity',
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop' as const,
      componentKey: 'memory_tools' as const,
      signalNames: ['brain_recall'] as const,
      tideMindVersion: '0.2.89',
      adapterVersion: 'adapter-3',
      projectionVersion: '7',
      hostVersion: '2.3.4',
      activationRunId: 'run-activity',
      activityGenerationToken: ACTIVITY_TOKEN,
      observedAfter: AFTER,
    }
    expect(recordHostActivityEvidence(db, input)).toMatchObject({ status: 'recorded' })
    expect(new SqliteHostActivityEvidenceReader(db).find(query)).toHaveLength(1)

    db.prepare(`UPDATE agent_consents SET status = 'revoked' WHERE id = 'consent-activity'`).run()
    expect(recordHostActivityEvidence(db, { ...input, observedAt: T1 }))
      .toEqual({ status: 'rejected', reason: 'component_not_managed' })
    expect(new SqliteHostActivityEvidenceReader(db).find(query)).toEqual([])

    db.prepare(`
      INSERT INTO agent_consents (
        id, installation_id, policy_version, allowed_components_json,
        allowed_scopes_json, normalized_targets_json, selector_schema_version,
        selector_resolution_json, executable_realpaths_json, command_categories_json,
        maximum_risk, status, confirmed_at, created_at
      ) VALUES (
        'consent-replacement', 'installation-activity', '1', '["memory_tools"]',
        '[]', '[]', '1', '{}', '[]', '[]', 'low', 'active', ?, ?
      )
    `).run(T1, T1)
    db.prepare(`UPDATE agent_installations SET consent_envelope_id = 'consent-replacement'
      WHERE id = 'installation-activity'`).run()
    expect(recordHostActivityEvidence(db, { ...input, observedAt: T1 }))
      .toEqual({ status: 'rejected', reason: 'component_not_managed' })
    expect(new SqliteHostActivityEvidenceReader(db).find(query)).toEqual([])
  })

  it('keeps evidence and legacy last_active monotonic across reverse order and timezone offsets', () => {
    const db = setup()
    const newest = recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_recall',
      tideMindVersion: '0.2.89',
      observedAt: T1,
    })
    const olderOffset = recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_recall',
      tideMindVersion: '0.2.89',
      observedAt: '2026-08-26T08:00:00+08:00',
    })
    expect(olderOffset).toMatchObject({ status: 'recorded', evidenceId: newest.status === 'recorded' ? newest.evidenceId : '' })
    expect(db.prepare(`SELECT observed_at FROM agent_host_activity_evidence`).get())
      .toEqual({ observed_at: T1 })
    expect(db.prepare(`SELECT last_active FROM agents WHERE id = ?`).get(AGENT_ID))
      .toEqual({ last_active: T1 })

    recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_recall',
      tideMindVersion: '0.2.89',
      observedAt: '2026-08-26T08:02:00+08:00',
    })
    expect(db.prepare(`SELECT observed_at FROM agent_host_activity_evidence`).get())
      .toEqual({ observed_at: '2026-08-26T00:02:00.000Z' })
    expect(db.prepare(`SELECT last_active FROM agents WHERE id = ?`).get(AGENT_ID))
      .toEqual({ last_active: '2026-08-26T00:02:00.000Z' })
  })

  it('keeps the original evidence id when the same generation replays at the same instant', () => {
    const db = setup()
    const input = {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools' as const,
      signalName: 'brain_recall' as const,
      tideMindVersion: '0.2.89',
      observedAt: T0,
    }
    const first = recordHostActivityEvidence(db, input)
    if (first.status !== 'recorded') throw new Error('expected recorded evidence')
    const repository = new AgentIntegrationRepository(db)
    repository.recordVerificationResult({
      id: 'verification-same-instant', installationId: 'installation-activity',
      componentKey: 'memory_tools', family: 'cursor', hostVariant: 'cursor-desktop',
      runtimeRealm: 'local_macos', hostVersion: '2.3.4', tideMindVersion: '0.2.89',
      adapterVersion: 'adapter-3', catalogVersion: '1', projectionVersion: '7',
      selectorSchemaVersion: '1', verificationManifestVersion: '1',
      method: 'host_activity_recognized:brain_recall', identityAssertion: AGENT_ID,
      artifactHash: 'owned-hash', invalidationKeys: ['activity_freshness'], result: 'verified',
      evidenceRef: `host-activity:${first.evidenceId}`, evidenceHash: 'verification-hash',
      verifiedAt: T1, expiresAt: '2026-09-25T00:00:00.000Z',
    })
    expect(repository.latestVerifiedHostActivityAt('installation-activity', T1)).toBe(T0)
    const replay = recordHostActivityEvidence(db, input)
    expect(first).toMatchObject({ status: 'recorded' })
    expect(replay).toEqual(first)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence`).get())
      .toEqual({ count: 1 })
    expect(repository.latestVerifiedHostActivityAt('installation-activity', T1)).toBe(T0)
  })

  it('accepts a disabled no-op consumer only for its exact active-consent applied_unverified run', () => {
    const db = setup()
    db.prepare(`
      INSERT INTO agent_consents (
        id, installation_id, policy_version, allowed_components_json,
        allowed_scopes_json, normalized_targets_json, selector_schema_version,
        selector_resolution_json, executable_realpaths_json, command_categories_json,
        maximum_risk, status, confirmed_at, created_at
      ) VALUES (
        'consent-pending', 'installation-activity', '1', '["memory_tools"]',
        '[]', '[]', '1', '{}', '[]', '["file_write"]',
        'low', 'active', ?, ?
      )
    `).run(T0, T0)
    db.prepare(`
      UPDATE agent_installations SET consent_envelope_id = 'consent-pending'
      WHERE id = 'installation-activity'
    `).run()
    db.prepare(`
      UPDATE installation_components SET consent_envelope_id = 'consent-pending'
      WHERE installation_id = 'installation-activity' AND component_key = 'memory_tools'
    `).run()
    db.prepare(`
      UPDATE artifact_consumers
      SET desired_state = 'disabled', consent_envelope_id = 'consent-pending'
      WHERE installation_id = 'installation-activity' AND component_key = 'memory_tools'
    `).run()

    const input = {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools' as const,
      signalName: 'brain_recall' as const,
      tideMindVersion: '0.2.89',
      observedAt: T0,
    }
    expect(recordHostActivityEvidence(db, input))
      .toEqual({ status: 'rejected', reason: 'component_not_managed' })

    db.prepare(`
      UPDATE reconcile_runs
      SET state = 'applied_unverified', consent_envelope_id = 'consent-pending'
      WHERE id = 'run-activity'
    `).run()
    expect(recordHostActivityEvidence(db, input))
      .toMatchObject({ status: 'recorded', installationId: 'installation-activity' })
    expect(new SqliteHostActivityEvidenceReader(db).find({
      installationId: 'installation-activity',
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalNames: ['brain_recall'],
      tideMindVersion: '0.2.89',
      adapterVersion: 'adapter-3',
      projectionVersion: '7',
      hostVersion: '2.3.4',
      activationRunId: 'run-activity',
      activityGenerationToken: ACTIVITY_TOKEN,
      observedAfter: AFTER,
    })).toHaveLength(1)

    db.prepare(`UPDATE agent_consents SET status = 'revoked' WHERE id = 'consent-pending'`).run()
    expect(recordHostActivityEvidence(db, { ...input, observedAt: T1 }))
      .toEqual({ status: 'rejected', reason: 'component_not_managed' })
    db.prepare(`UPDATE agent_consents SET status = 'active' WHERE id = 'consent-pending'`).run()
    db.prepare(`UPDATE installation_components SET artifact_id = NULL WHERE installation_id = 'installation-activity'`).run()
    expect(recordHostActivityEvidence(db, { ...input, observedAt: T1 }))
      .toEqual({ status: 'rejected', reason: 'component_not_managed' })
  })

  it('binds a guided component without an Artifact to its exact active-consent run and generation', () => {
    const db = setup()
    db.prepare(`
      INSERT INTO agent_consents (
        id, installation_id, policy_version, allowed_components_json,
        allowed_scopes_json, normalized_targets_json, selector_schema_version,
        selector_resolution_json, executable_realpaths_json, command_categories_json,
        maximum_risk, status, confirmed_at, created_at
      ) VALUES (
        'consent-guided', 'installation-activity', '1', '["memory_tools"]',
        '[]', '[]', '1', '{}', '[]', '[]', 'low', 'active', ?, ?
      )
    `).run(T0, T0)
    db.prepare(`DELETE FROM artifact_consumers WHERE installation_id = 'installation-activity'`).run()
    db.prepare(`
      UPDATE installation_components
      SET delivery_mode = 'guided', artifact_id = NULL, consent_envelope_id = 'consent-guided'
      WHERE installation_id = 'installation-activity' AND component_key = 'memory_tools'
    `).run()
    db.prepare(`
      UPDATE agent_installations SET consent_envelope_id = 'consent-guided'
      WHERE id = 'installation-activity'
    `).run()
    db.prepare(`
      UPDATE reconcile_runs
      SET state = 'applied_unverified', consent_envelope_id = 'consent-guided'
      WHERE id = 'run-activity'
    `).run()

    const input = {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools' as const,
      tideMindVersion: '0.2.89',
      activityGenerationToken: ACTIVITY_TOKEN,
    }
    expect(recordHostActivityEvidenceRaw(db, { ...input, signalName: 'brain_recall', observedAt: T0 }))
      .toMatchObject({ status: 'recorded' })
    expect(recordHostActivityEvidenceRaw(db, { ...input, signalName: 'brain_digest', observedAt: T1 }))
      .toMatchObject({ status: 'recorded' })
    const query = {
      installationId: 'installation-activity',
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop' as const,
      componentKey: 'memory_tools' as const,
      signalNames: ['brain_recall', 'brain_digest'] as const,
      tideMindVersion: '0.2.89',
      adapterVersion: 'adapter-3',
      projectionVersion: '7',
      hostVersion: '2.3.4',
      activationRunId: 'run-activity',
      activityGenerationToken: ACTIVITY_TOKEN,
      observedAfter: AFTER,
    }
    expect(new SqliteHostActivityEvidenceReader(db).find(query)).toHaveLength(2)
    expect(new SqliteHostActivityEvidenceReader(db).find({
      ...query,
      activityGenerationToken: 'old-guided-generation',
    })).toEqual([])

    db.prepare(`UPDATE agent_consents SET status = 'revoked' WHERE id = 'consent-guided'`).run()
    expect(recordHostActivityEvidenceRaw(db, { ...input, signalName: 'brain_recall', observedAt: T1 }))
      .toEqual({ status: 'rejected', reason: 'component_not_managed' })
    expect(new SqliteHostActivityEvidenceReader(db).find(query)).toEqual([])

    db.prepare(`UPDATE installation_components SET delivery_mode = 'managed'
      WHERE installation_id = 'installation-activity' AND component_key = 'memory_tools'`).run()
    expect(recordHostActivityEvidenceRaw(db, { ...input, signalName: 'brain_recall', observedAt: T1 }))
      .toEqual({ status: 'rejected', reason: 'component_not_managed' })
  })

  it('rejects unknown, removed, tombstoned and host-mismatched identities without evidence', () => {
    const db = setup()
    const input = {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools' as const,
      signalName: 'brain_prepare' as const,
      tideMindVersion: '0.2.89',
      observedAt: T0,
    }

    expect(recordHostActivityEvidence(db, { ...input, agentId: 'eb_unknown' }))
      .toEqual({ status: 'rejected', reason: 'unknown_agent' })
    expect(recordHostActivityEvidence(db, { ...input, hostVariant: 'windsurf-desktop' }))
      .toEqual({ status: 'rejected', reason: 'host_variant_mismatch' })
    db.prepare(`UPDATE agent_installations SET tombstoned_at = ? WHERE id = 'installation-activity'`).run(T0)
    expect(recordHostActivityEvidence(db, input))
      .toEqual({ status: 'rejected', reason: 'installation_tombstoned' })
    db.prepare(`UPDATE agent_installations SET desired_state = 'removed' WHERE id = 'installation-activity'`).run()
    expect(recordHostActivityEvidence(db, input))
      .toEqual({ status: 'rejected', reason: 'installation_removed' })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence`).get())
      .toEqual({ count: 0 })
    const diagnostics = db.prepare(`
      SELECT json_extract(payload_json, '$.reason') AS reason
      FROM agent_integration_events
      WHERE kind = 'orphan_agent_activity'
      ORDER BY reason
    `).all() as Array<{ reason: string }>
    expect(diagnostics.map(row => row.reason)).toEqual([
      'removed',
      'tombstoned',
      'unknown_agent',
    ])
    expect(db.prepare(`SELECT last_active FROM agents WHERE id = ?`).get(AGENT_ID))
      .toEqual({ last_active: null })
  })

  it('requires an exact hook tool-to-variant mapping', () => {
    const db = setup('lifecycle')
    expect(recordHookActivityEvidence(db, {
      agentId: AGENT_ID,
      tool: 'codex',
      signalName: 'session_start',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })).toEqual({ status: 'rejected', reason: 'host_variant_mismatch' })
    db.prepare(`
      UPDATE agent_installations
      SET family = 'codex', host_variant = 'codex-cli'
      WHERE id = 'installation-activity'
    `).run()
    expect(recordHookActivityEvidence(db, {
      agentId: AGENT_ID,
      tool: 'codex',
      signalName: 'session_start',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })).toMatchObject({ status: 'recorded', installationId: 'installation-activity' })
  })

  it.each([
    ['claude-code', 'claude-code', 'claude-code-native'],
    ['kimi-code', 'kimi-code', 'kimi-code-native'],
    ['cursor', 'cursor', 'cursor-desktop'],
    ['windsurf', 'windsurf', 'windsurf-desktop'],
    ['qwenwork', 'qwenwork', 'qwenwork-desktop'],
    ['zcode', 'zcode', 'zcode-desktop'],
  ])('records hook activity for the exact %s host variant', (tool, family, hostVariant) => {
    const db = setup('lifecycle')
    db.prepare(`
      UPDATE agent_installations
      SET family = ?, host_variant = ?
      WHERE id = 'installation-activity'
    `).run(family, hostVariant)

    expect(recordHookActivityEvidence(db, {
      agentId: AGENT_ID,
      tool,
      signalName: 'session_start',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })).toMatchObject({ status: 'recorded', installationId: 'installation-activity' })
  })

  it('records Cursor sessionEnd as its own lifecycle signal', () => {
    const db = setup('lifecycle')
    expect(recordHookActivityEvidence(db, {
      agentId: AGENT_ID,
      tool: 'cursor',
      signalName: 'session_end',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })).toMatchObject({ status: 'recorded', installationId: 'installation-activity' })
    expect(db.prepare(`
      SELECT component_key, signal_name FROM agent_host_activity_evidence
    `).get()).toEqual({ component_key: 'lifecycle', signal_name: 'session_end' })
  })

  it.each([
    ['claude-code', 'kimi-code', 'kimi-code-native'],
    ['kimi-code', 'claude-code', 'claude-code-native'],
    ['cursor', 'codex', 'codex-cli'],
    ['windsurf', 'cursor', 'cursor-desktop'],
    ['qwenwork', 'qwen-code', 'qwen-code-cli'],
    ['zcode', 'zcode', 'zcode-cli'],
  ])('rejects hook activity when %s is reported by a different host variant', (tool, family, hostVariant) => {
    const db = setup('lifecycle')
    db.prepare(`
      UPDATE agent_installations
      SET family = ?, host_variant = ?
      WHERE id = 'installation-activity'
    `).run(family, hostVariant)

    expect(recordHookActivityEvidence(db, {
      agentId: AGENT_ID,
      tool,
      signalName: 'session_start',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })).toEqual({ status: 'rejected', reason: 'host_variant_mismatch' })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence`).get())
      .toEqual({ count: 0 })
  })

  it('binds reads to exact versions and freshness, then rejects tombstoned history', () => {
    const db = setup()
    recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_digest',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })
    const reader = new SqliteHostActivityEvidenceReader(db)
    const exact = {
      installationId: 'installation-activity',
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop' as const,
      componentKey: 'memory_tools' as const,
      signalNames: ['brain_digest'] as const,
      tideMindVersion: '0.2.89',
      adapterVersion: 'adapter-3',
      projectionVersion: '7',
      hostVersion: '2.3.4',
      activationRunId: 'run-activity',
      activityGenerationToken: ACTIVITY_TOKEN,
      observedAfter: AFTER,
    }
    expect(reader.find(exact)).toHaveLength(1)
    expect(reader.find({ ...exact, adapterVersion: 'adapter-4' })).toEqual([])
    expect(reader.find({ ...exact, observedAfter: T1 })).toEqual([])
    db.prepare(`UPDATE agent_installations SET tombstoned_at = ? WHERE id = 'installation-activity'`).run(T0)
    expect(reader.find(exact)).toEqual([])
  })

  it('supports explicit any/all evidence policies for non-memory component contracts', async () => {
    const memoryDb = setup()
    recordHostActivityEvidence(memoryDb, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_prepare',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })
    const memoryContext = context(new SqliteHostActivityEvidenceReader(memoryDb))
    const inspection = {
      catalogId: 'cursor-desktop' as const,
      detected: true,
      distribution: {},
      components: [],
      provenance: [],
      diagnostics: [],
    }
    expect(await verifyHostActivity(memoryContext, verificationRequest(inspection, 'memory_tools'), {
      componentKey: 'memory_tools',
      signalNames: ['brain_prepare', 'brain_recall', 'brain_digest'],
      require: 'any',
    })).toMatchObject({
      status: 'verified',
      identityAssertion: AGENT_ID,
      expiresAt: '2026-09-25T00:01:00.000Z',
    })
    const boundaryRequest = verificationRequest(inspection, 'memory_tools')
    boundaryRequest.activityBinding!.observedAfter = T0
    expect(await verifyHostActivity(memoryContext, boundaryRequest, {
      componentKey: 'memory_tools',
      signalNames: ['brain_prepare', 'brain_recall', 'brain_digest'],
      require: 'any',
    })).toMatchObject({
      status: 'unverified',
      diagnostics: ['fresh_host_activity_evidence_missing'],
    })

    const lifecycleDb = setup('lifecycle')
    for (const signalName of ['session_start', 'pre_compact'] as const) {
      recordHostActivityEvidence(lifecycleDb, {
        agentId: AGENT_ID,
        hostVariant: 'cursor-desktop',
        componentKey: 'lifecycle',
        signalName,
        tideMindVersion: '0.2.89',
        observedAt: T0,
      })
    }
    const lifecycleContext = context(new SqliteHostActivityEvidenceReader(lifecycleDb))
    const request = verificationRequest(inspection, 'lifecycle')
    const options = {
      componentKey: 'lifecycle' as const,
      signalNames: ['session_start', 'pre_compact', 'post_compact'] as const,
      require: 'all' as const,
    }
    expect(await verifyHostActivity(lifecycleContext, request, options))
      .toMatchObject({ status: 'unverified', diagnostics: ['fresh_host_activity_evidence_missing'] })
    recordHostActivityEvidence(lifecycleDb, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'lifecycle',
      signalName: 'post_compact',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })
    expect(await verifyHostActivity(lifecycleContext, request, options))
      .toMatchObject({ status: 'verified', identityAssertion: AGENT_ID })
  })

  it('requires both recall and digest before memory read/write is verified', async () => {
    const db = setup()
    const memoryContext = context(new SqliteHostActivityEvidenceReader(db))
    const inspection = {
      catalogId: 'cursor-desktop' as const,
      detected: true,
      distribution: {},
      components: [],
      provenance: [],
      diagnostics: [],
    }
    const request = verificationRequest(inspection, 'memory_tools')
    const record = (signalName: 'brain_prepare' | 'brain_recall' | 'brain_digest') => recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName,
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })

    record('brain_prepare')
    expect(await verifyMemoryReadWriteActivity(memoryContext, request))
      .toMatchObject({ status: 'unverified', diagnostics: ['fresh_host_activity_evidence_missing'] })
    record('brain_recall')
    expect(await verifyMemoryReadWriteActivity(memoryContext, request))
      .toMatchObject({ status: 'unverified', diagnostics: ['fresh_host_activity_evidence_missing'] })
    record('brain_digest')
    expect(await verifyMemoryReadWriteActivity(memoryContext, request)).toMatchObject({
      status: 'verified',
      verifiedCapability: 2,
      diagnostics: ['host_activity_recognized:brain_digest,brain_recall'],
    })
  })

  it('does not compose memory evidence across the current activation epoch', async () => {
    const activationEpoch = '2026-08-26T00:01:00.000Z'
    const verifiedAt = '2026-08-26T00:03:00.000Z'
    const inspection = {
      catalogId: 'cursor-desktop' as const,
      detected: true,
      distribution: {},
      components: [],
      provenance: [],
      diagnostics: [],
    }
    const verify = async (
      db: Database.Database,
      options: { activationEpoch?: string; activationRunId?: string; activityGenerationToken?: string } = {},
    ) => {
      const request = verificationRequest(inspection, 'memory_tools')
      request.activityBinding = {
        ...request.activityBinding!,
        activationEpoch: options.activationEpoch ?? activationEpoch,
        activationRunId: options.activationRunId ?? 'run-activity',
        activityGenerationToken: options.activityGenerationToken ?? ACTIVITY_TOKEN,
        verifiedAt,
      }
      return verifyMemoryReadWriteActivity(context(new SqliteHostActivityEvidenceReader(db)), request)
    }
    const record = (
      db: Database.Database,
      signalName: 'brain_recall' | 'brain_digest',
      observedAt: string,
    ) => recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName,
      tideMindVersion: '0.2.89',
      observedAt,
    })

    const splitAcrossReconnect = setup()
    record(splitAcrossReconnect, 'brain_recall', T0)
    record(splitAcrossReconnect, 'brain_digest', '2026-08-26T00:02:00.000Z')
    expect(await verify(splitAcrossReconnect)).toMatchObject({
      status: 'unverified',
      diagnostics: ['fresh_host_activity_evidence_missing'],
    })

    const bothBeforeApply = setup()
    record(bothBeforeApply, 'brain_recall', T0)
    record(bothBeforeApply, 'brain_digest', '2026-08-26T00:00:30.000Z')
    expect(await verify(bothBeforeApply)).toMatchObject({
      status: 'unverified',
      diagnostics: ['fresh_host_activity_evidence_missing'],
    })

    const priorRunAtSameVersions = setup()
    record(priorRunAtSameVersions, 'brain_recall', T0)
    record(priorRunAtSameVersions, 'brain_digest', '2026-08-26T00:00:30.000Z')
    priorRunAtSameVersions.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, state,
        recovery_strategy, adapter_version, catalog_version, projection_version,
        selector_schema_version, prepared_plan_json, desired_capability, consent_envelope_id,
        created_at, updated_at
      ) VALUES (
        'run-current-activation', 'installation-activity', 'repair', 'plan-current',
        'applied_unverified', 'readback_before_replay', 'adapter-3', '1', '7', '1',
        ?, 4, 'consent-activity', ?, ?
      )
    `).run(JSON.stringify({
      componentKeys: ['memory_tools'],
      activityGenerationToken: 'operation-current-activation',
      executionPlan: { activityGenerationTokenHash: sha256Json('operation-current-activation') },
    }), activationEpoch, activationEpoch)
    expect(await verify(priorRunAtSameVersions, {
      activationEpoch: AFTER,
      activationRunId: 'run-current-activation',
      activityGenerationToken: 'operation-current-activation',
    })).toMatchObject({
      status: 'unverified',
      diagnostics: ['fresh_host_activity_evidence_missing'],
    })
  })

  it('binds physical activity writes to the latest causal projection token even at the same timestamp', () => {
    const db = setup()
    expect(recordHostActivityEvidenceRaw(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_recall',
      tideMindVersion: '0.2.89',
      activityGenerationToken: ACTIVITY_TOKEN,
      observedAt: T1,
    })).toMatchObject({ status: 'recorded' })
    const oldHash = (db.prepare(`SELECT evidence_hash FROM agent_host_activity_evidence`).get() as {
      evidence_hash: string
    }).evidence_hash
    db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, state,
        recovery_strategy, adapter_version, catalog_version, projection_version,
        selector_schema_version, prepared_plan_json, desired_capability, consent_envelope_id,
        created_at, updated_at
      ) VALUES (
        'aaa-random-looking-new-run', 'installation-activity', 'repair', 'plan-new',
        'applied_unverified', 'readback_before_replay', 'adapter-3', '1', '7', '1',
        ?, 4, 'consent-activity', ?, ?
      )
    `).run(JSON.stringify({
      componentKeys: ['memory_tools'],
      activityGenerationToken: 'operation-new-generation',
      executionPlan: { activityGenerationTokenHash: sha256Json('operation-new-generation') },
    }), T0, T0)

    const base = {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools' as const,
      signalName: 'brain_recall' as const,
      tideMindVersion: '0.2.89',
      observedAt: T1,
    }
    expect(recordHostActivityEvidenceRaw(db, {
      ...base,
      activityGenerationToken: ACTIVITY_TOKEN,
    })).toEqual({ status: 'rejected', reason: 'activity_generation_mismatch' })
    expect(recordHostActivityEvidenceRaw(db, {
      ...base,
      activityGenerationToken: 'aaa-random-looking-new-run',
    })).toEqual({ status: 'rejected', reason: 'activity_generation_mismatch' })
    expect(recordHostActivityEvidenceRaw(db, {
      ...base,
      activityGenerationToken: '',
    })).toEqual({ status: 'rejected', reason: 'version_binding_missing' })
    expect(recordHostActivityEvidenceRaw(db, {
      ...base,
      activityGenerationToken: 'operation-new-generation',
    })).toMatchObject({ status: 'recorded', installationId: 'installation-activity' })
    const evidence = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_host_activity_evidence) AS count,
        evidence_hash, observed_at
      FROM agent_host_activity_evidence
      WHERE activation_run_id = 'aaa-random-looking-new-run'
    `).get() as { count: number; evidence_hash: string; observed_at: string }
    expect(evidence).toMatchObject({ count: 2, observed_at: T1 })
    expect(evidence.evidence_hash).not.toBe(oldHash)
  })

  it('lets a JSON MCP Adapter verify only after static read-back and runtime invocation agree', async () => {
    const db = setup()
    const reader = new SqliteHostActivityEvidenceReader(db)
    const operationContext = context(reader)
    const adapter = createJsonMcpHostAdapter({
      catalogId: 'cursor-desktop',
      adapterVersion: 'adapter-3',
      configFile: ctx => path.join(ctx.installation.canonicalConfigRoot, 'mcp.json'),
      reload: 'new_session',
    })
    const before = await adapter.inspect(operationContext)
    const plan = await adapter.plan(operationContext, {
      desiredCapability: 4,
      desiredComponents: ['memory_tools'],
      observed: before,
      ownedArtifacts: [],
    })
    await adapter.apply(operationContext, plan.mutations[0])
    const inspection = await adapter.inspect(operationContext)
    const request = verificationRequest(inspection, 'memory_tools')

    expect((await adapter.verify(operationContext, request))[0]).toMatchObject({
      status: 'unverified',
      diagnostics: ['static_readback_passed', 'fresh_host_activity_evidence_missing'],
    })
    recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_recall',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })
    expect((await adapter.verify(operationContext, request))[0]).toMatchObject({
      status: 'unverified',
      diagnostics: ['static_readback_passed', 'fresh_host_activity_evidence_missing'],
    })
    recordHostActivityEvidence(db, {
      agentId: AGENT_ID,
      hostVariant: 'cursor-desktop',
      componentKey: 'memory_tools',
      signalName: 'brain_digest',
      tideMindVersion: '0.2.89',
      observedAt: T0,
    })
    expect((await adapter.verify(operationContext, request))[0]).toMatchObject({
      status: 'verified',
      identityAssertion: AGENT_ID,
    })
    const config = JSON.parse(fs.readFileSync(
      path.join(operationContext.installation.canonicalConfigRoot, 'mcp.json'),
      'utf8',
    )) as { mcpServers: Record<string, { env: Record<string, string> }> }
    expect(config.mcpServers[`tidemind-${AGENT_ID}`].env).toEqual({
      EB_AGENT_ID: AGENT_ID,
      EB_HOST_VARIANT: 'cursor-desktop',
      EB_ACTIVITY_GENERATION_TOKEN: ACTIVITY_TOKEN,
    })

    config.mcpServers[`tidemind-${AGENT_ID}`].env.EXTRA_UNMANAGED_VALUE = 'tampered'
    fs.writeFileSync(
      path.join(operationContext.installation.canonicalConfigRoot, 'mcp.json'),
      JSON.stringify(config),
    )
    expect((await adapter.verify(operationContext, request))[0]).toMatchObject({
      status: 'failed',
      diagnostics: ['managed_mcp_fragment_drifted_from_current_desired'],
    })
  })
})
