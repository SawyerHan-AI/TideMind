import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SqliteHostActivityEvidenceReader,
  verifyHostActivity,
} from '../../client/electron/agent-integration/host-activity-evidence'
import { createJsonMcpHostAdapter } from '../../client/electron/agent-integration/hosts/json-mcp-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterOperationContext, AdapterVerificationRequest } from '../../client/electron/agent-integration/types'
import {
  recordHookActivityEvidence,
  recordHostActivityEvidence,
} from '../../src/db/agent-host-activity'
import { ensureSchema } from '../../src/db/schema'

const T0 = '2026-08-26T00:00:00.000Z'
const T1 = '2026-08-26T00:01:00.000Z'
const AFTER = '2026-07-27T00:00:00.000Z'
const AGENT_ID = 'eb_activity01'

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
  `).run(JSON.stringify({ componentKeys: [componentKey] }), T0, T0)
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
      observedAfter: AFTER,
    }
    expect(reader.find(exact)).toHaveLength(1)
    expect(reader.find({ ...exact, adapterVersion: 'adapter-4' })).toEqual([])
    expect(reader.find({ ...exact, observedAfter: T1 })).toEqual([])
    db.prepare(`UPDATE agent_installations SET tombstoned_at = ? WHERE id = 'installation-activity'`).run(T0)
    expect(reader.find(exact)).toEqual([])
  })

  it('requires every declared lifecycle signal while memory tools accept one real invocation', async () => {
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
