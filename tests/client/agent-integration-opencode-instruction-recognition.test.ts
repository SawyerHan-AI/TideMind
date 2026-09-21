import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  digestResultProducedActivity,
  matchesExpectedInstructionSha256,
  OPENCODE_V2_INSTRUCTION_PREPARE_PROBE,
  shouldRecordMcpActivity,
} from '../../src/agent-integration-recognition'
import { sha256Bytes, sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { recordHostActivityEvidence } from '../../src/db/agent-host-activity'
import { ensureSchema } from '../../src/db/schema'
import { SqliteHostActivityEvidenceReader } from '../../client/electron/agent-integration/host-activity-evidence'
import { createP0HostAdapters, P0_INSTRUCTION_SPECS } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterOperationContext, AgentHostAdapter, HostActivitySignal } from '../../client/electron/agent-integration/types'

const roots: string[] = []
const databases: Database.Database[] = []
const ACTIVATION = '2026-09-05T00:01:00.000Z'
const VERIFIED_AT = '2026-09-05T00:10:00.000Z'
const OLD_ACTIVITY = '2026-09-05T00:00:30.000Z'
const CURRENT_ACTIVITY = '2026-09-05T00:02:00.000Z'
const TOKEN = 'opencode-v2-generation-current'
const OLD_TOKEN = 'opencode-v2-generation-old'

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-recognition-')))
  roots.push(root)
  const home = path.join(root, 'home')
  const configRoot = path.join(home, '.config', 'opencode')
  const skillRoot = path.join(home, '.agents', 'skills')
  fs.mkdirSync(configRoot, { recursive: true })
  fs.mkdirSync(skillRoot, { recursive: true })
  const db = new Database(path.join(root, 'activity.sqlite'))
  databases.push(db)
  ensureSchema(db)

  const installationId = 'installation-opencode-v2'
  const agentId = 'eb_opencode_v2'
  const adapter = createP0HostAdapters().get('opencode-v2-beta-cli')!
  const identity = canonicalizeInstallationIdentity({
    runtimeRealm: 'local_macos',
    osUserIdentity: 'usr_01JOPENCODEV2PROOF',
    productFamilyId: 'opencode',
    hostVariant: 'opencode-v2-beta-cli',
    configRoot,
    componentConfigRoots: { instruction: skillRoot },
    componentConfigFiles: {
      instruction: path.join(skillRoot, 'tidemind', 'SKILL.md'),
      memory_tools: path.join(configRoot, 'opencode.jsonc'),
    },
    distribution: {
      distributionId: 'cli:opencode-v2-beta-cli',
      executableRealpath: path.join(root, 'bin', 'opencode2'),
      packageProvenance: 'npm_metadata:@opencode-ai/cli',
    },
  })
  const context: AdapterOperationContext = {
    runtime: {
      runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: path.join(home, '.tidemind'),
      shimPath: path.join(root, 'Tide Mind.app', 'shim'),
      mcpServerPath: path.join(root, 'Tide Mind.app', 'mcp-server.cjs'),
      hookScriptPath: path.join(root, 'Tide Mind.app', 'hook-session-start.cjs'),
      preCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-pre-compact.cjs'),
      postCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-post-compact.cjs'),
      tideMindVersion: '0.2.92', catalogVersion: '1', projectionVersion: '1',
    },
    installation: identity,
    installationId,
    hostVersion: '2.0.0-beta.2',
    agentId,
    operationId: 'operation-opencode-v2',
    activityGenerationToken: TOKEN,
    hostActivityEvidence: new SqliteHostActivityEvidenceReader(db),
  }

  db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created) VALUES (?, 'OpenCode V2', 'opencode', 0, ?)`)
    .run(agentId, OLD_ACTIVITY)
  db.prepare(`
    INSERT INTO agent_installations (
      id, family, host_variant, runtime_realm, profile_id, install_key, provenance,
      display_name, detected_version, agent_id, desired_state, supported_capability,
      desired_capability, health_state, created_at, updated_at
    ) VALUES (?, 'opencode', 'opencode-v2-beta-cli', 'local_macos', 'default', ?, 'fixture',
      'OpenCode V2', '2.0.0-beta.2', ?, 'managed', 3, 3, 'discovered', ?, ?)
  `).run(installationId, identity.installKey, agentId, OLD_ACTIVITY, OLD_ACTIVITY)
  for (const [componentKey, artifactType] of [['instruction', 'skill'], ['memory_tools', 'mcp']] as const) {
    const artifactId = `artifact-${componentKey}`
    db.prepare(`
      INSERT INTO managed_artifacts (
        id, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, owned_fragment_hash,
        observed_fragment_hash, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'document', ?, '1', '1', 'owned', 'owned', 'healthy', ?, ?)
    `).run(artifactId, artifactType, identity.componentConfigFiles![componentKey],
      `local_macos:file:${identity.componentConfigFiles![componentKey]}:document`, OLD_ACTIVITY, OLD_ACTIVITY)
    db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, desired_capability,
        delivery_mode, verification_status, artifact_id, visibility_state,
        created_at, updated_at
      ) VALUES (?, ?, 'managed', 3, 'managed', 'unverified', ?, 'dedicated', ?, ?)
    `).run(installationId, componentKey, artifactId, OLD_ACTIVITY, OLD_ACTIVITY)
    db.prepare(`
      INSERT INTO artifact_consumers (
        artifact_id, installation_id, component_key, required_capability,
        desired_state, discover_reachability, state, added_at, updated_at
      ) VALUES (?, ?, ?, 3, 'managed', 'dedicated', 'active', ?, ?)
    `).run(artifactId, installationId, componentKey, OLD_ACTIVITY, OLD_ACTIVITY)
  }

  const consentId = 'consent-opencode-v2-current'
  db.prepare(`
    INSERT INTO agent_consents (
      id, installation_id, policy_version, allowed_components_json,
      allowed_scopes_json, normalized_targets_json, selector_schema_version,
      selector_resolution_json, executable_realpaths_json, command_categories_json,
      maximum_risk, status, confirmed_at, created_at
    ) VALUES (?, ?, '1', ?, '[]', '[]', '1', '{}', '[]', '[]',
      'low', 'active', ?, ?)
  `).run(
    consentId,
    installationId,
    JSON.stringify(['instruction', 'memory_tools']),
    OLD_ACTIVITY,
    OLD_ACTIVITY,
  )
  db.prepare(`UPDATE agent_installations SET consent_envelope_id = ? WHERE id = ?`)
    .run(consentId, installationId)
  db.prepare(`UPDATE installation_components SET consent_envelope_id = ? WHERE installation_id = ?`)
    .run(consentId, installationId)
  db.prepare(`UPDATE artifact_consumers SET consent_envelope_id = ? WHERE installation_id = ?`)
    .run(consentId, installationId)

  const insertRun = (id: string, token: string, createdAt: string) => db.prepare(`
    INSERT INTO reconcile_runs (
      id, installation_id, operation_type, execution_plan_hash, state,
      recovery_strategy, adapter_version, catalog_version, projection_version,
      selector_schema_version, prepared_plan_json, desired_capability, consent_envelope_id,
      created_at, updated_at
    ) VALUES (?, ?, 'connect', ?, 'committed', 'readback_before_replay', ?, '1', '1', '1', ?, 3, ?, ?, ?)
  `).run(id, installationId, `plan-${id}`, adapter.adapterVersion, JSON.stringify({
    componentKeys: ['instruction', 'memory_tools'],
    activityGenerationToken: token,
    executionPlan: { activityGenerationTokenHash: sha256Json(token) },
  }), consentId, createdAt, createdAt)

  return { adapter, context, db, insertRun }
}

async function applyProjection(
  adapter: AgentHostAdapter,
  context: AdapterOperationContext,
  desiredCapability: 3 | 4 = 3,
) {
  const inspection = await adapter.inspect(context)
  const plan = await adapter.plan(context, {
    desiredCapability,
    desiredComponents: desiredCapability === 4
      ? ['instruction', 'memory_tools', 'lifecycle']
      : ['instruction', 'memory_tools'],
    observed: inspection,
    ownedArtifacts: [],
  })
  for (const mutation of plan.mutations) await adapter.apply(context, mutation)
}

function record(context: AdapterOperationContext, db: Database.Database, token: string, signalName: HostActivitySignal, observedAt: string) {
  return recordHostActivityEvidence(db, {
    agentId: context.agentId,
    hostVariant: 'opencode-v2-beta-cli',
    componentKey: 'memory_tools',
    signalName,
    tideMindVersion: '0.2.92',
    activityGenerationToken: token,
    observedAt,
  })
}

describe('OpenCode managed instruction recognition', () => {
  it('records digest activity only for explicit durable-success results', () => {
    expect(digestResultProducedActivity({ status: 'accepted', trace_id: 'async-write' })).toBe(true)
    expect(digestResultProducedActivity({ status: 'processed', trace_id: 'sync-write' })).toBe(true)
    expect(digestResultProducedActivity({
      status: 'rejected', trace_id: 'no-write', reject_reason: 'validation failed',
    })).toBe(false)
  })

  it('records V2 prepare as instruction evidence only for the managed proof hint', () => {
    expect(shouldRecordMcpActivity({
      hostVariant: 'opencode-v2-beta-cli', signalName: 'brain_prepare', instructionProbe: 'ordinary user topic',
    })).toBe(false)
    expect(shouldRecordMcpActivity({
      hostVariant: 'opencode-v2-beta-cli', signalName: 'brain_prepare', instructionProbe: OPENCODE_V2_INSTRUCTION_PREPARE_PROBE,
    })).toBe(true)
    expect(shouldRecordMcpActivity({
      hostVariant: 'opencode-v2-beta-cli', signalName: 'brain_recall',
    })).toBe(true)
    expect(P0_INSTRUCTION_SPECS['opencode-v2-beta-cli']!.content({} as AdapterOperationContext))
      .toContain(`\`integration_probe\` 精确设为 \`${OPENCODE_V2_INSTRUCTION_PREPARE_PROBE}\``)
    expect(P0_INSTRUCTION_SPECS['opencode-v2-beta-cli']!.content({} as AdapterOperationContext))
      .toBe(P0_INSTRUCTION_SPECS['opencode-v1-cli']!.content({} as AdapterOperationContext))
  })

  it('lets the V1 hook mint instruction evidence only after reading the exact frozen Skill bytes', () => {
    const content = P0_INSTRUCTION_SPECS['opencode-v1-cli']!.content({} as AdapterOperationContext)
    expect(matchesExpectedInstructionSha256(content, sha256Bytes(content))).toBe(true)
    expect(matchesExpectedInstructionSha256(`${content}\nchanged`, sha256Bytes(content))).toBe(false)
    expect(matchesExpectedInstructionSha256(content, 'not-a-hash')).toBe(false)
  })

  it('lets one current V1 session prove every requested C4 component without static-only promotion', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v1-recognition-')))
    roots.push(root)
    const home = path.join(root, 'home')
    const configRoot = path.join(home, '.config', 'opencode')
    const skillRoot = path.join(home, '.agents', 'skills')
    const lifecycleRoot = path.join(home, '.local', 'share', 'opencode')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(skillRoot, { recursive: true })
    fs.mkdirSync(lifecycleRoot, { recursive: true })
    const adapter = createP0HostAdapters().get('opencode-v1-cli')!
    const context: AdapterOperationContext = {
      runtime: {
        runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: path.join(home, '.tidemind'),
        shimPath: path.join(root, 'Tide Mind.app', 'shim'),
        mcpServerPath: path.join(root, 'Tide Mind.app', 'mcp-server.cjs'),
        hookScriptPath: path.join(root, 'Tide Mind.app', 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(root, 'Tide Mind.app', 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92', catalogVersion: '1', projectionVersion: '1',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos', osUserIdentity: 'usr_01JOPENCODEV1PROOF',
        productFamilyId: 'opencode', hostVariant: 'opencode-v1-cli', configRoot,
        componentConfigRoots: { instruction: skillRoot, lifecycle: lifecycleRoot },
        componentConfigFiles: {
          instruction: path.join(skillRoot, 'tidemind', 'SKILL.md'),
          memory_tools: path.join(configRoot, 'opencode.jsonc'),
          lifecycle: path.join(lifecycleRoot, 'plugins', 'tidemind-v1.ts'),
        },
        distribution: { executableRealpath: path.join(root, 'bin', 'opencode') },
      }),
      installationId: 'installation-opencode-v1-composition', hostVersion: '1.18.28',
      agentId: 'eb_opencode_v1_composition', operationId: 'operation-opencode-v1-composition',
      activityGenerationToken: 'generation-opencode-v1-composition',
      hostActivityEvidence: {
        find(query) {
          return query.signalNames.map(signalName => ({
            id: `activity-${signalName}`, installationId: query.installationId,
            agentId: query.agentId, hostVariant: query.hostVariant,
            componentKey: query.componentKey, signalName,
            tideMindVersion: query.tideMindVersion, adapterVersion: query.adapterVersion,
            projectionVersion: query.projectionVersion, hostVersion: query.hostVersion,
            evidenceHash: `evidence-${signalName}`, observedAt: CURRENT_ACTIVITY,
          }))
        },
      },
    }
    await applyProjection(adapter, context, 4)
    const results = await adapter.verify(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'], expectedCapability: 4,
      inspection: await adapter.inspect(context),
      activityBinding: {
        installationId: context.installationId!, tideMindVersion: '0.2.92',
        adapterVersion: adapter.adapterVersion, projectionVersion: '1', hostVersion: '1.18.28',
        activationRunId: 'run-current', activityGenerationToken: context.activityGenerationToken,
        activationEpoch: ACTIVATION, observedAfter: '2026-09-04T00:00:00.000Z', verifiedAt: VERIFIED_AT,
      },
    })
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'instruction', status: 'verified', verifiedCapability: 1 }),
      expect.objectContaining({ componentKey: 'memory_tools', status: 'verified', verifiedCapability: 2 }),
      expect.objectContaining({ componentKey: 'lifecycle', status: 'verified', verifiedCapability: 4 }),
    ]))
  })

  it('reaches the declared C3 components only with current-generation activity and rejects old SQLite evidence', async () => {
    const { adapter, context, db, insertRun } = fixture()
    await applyProjection(adapter, context)

    insertRun('run-old', OLD_TOKEN, OLD_ACTIVITY)
    expect(record(context, db, OLD_TOKEN, 'brain_prepare', OLD_ACTIVITY)).toEqual({
      status: 'recorded', evidenceId: expect.any(String), installationId: 'installation-opencode-v2',
    })
    insertRun('run-current', TOKEN, ACTIVATION)
    expect(record(context, db, TOKEN, 'brain_recall', CURRENT_ACTIVITY)).toMatchObject({ status: 'recorded' })
    expect(record(context, db, TOKEN, 'brain_digest', CURRENT_ACTIVITY)).toMatchObject({ status: 'recorded' })

    const request = {
      componentKeys: ['instruction', 'memory_tools'] as const,
      expectedCapability: 3 as const,
      inspection: await adapter.inspect(context),
      activityBinding: {
        installationId: context.installationId!, tideMindVersion: '0.2.92',
        adapterVersion: adapter.adapterVersion, projectionVersion: '1', hostVersion: '2.0.0-beta.2',
        activationRunId: 'run-current', activityGenerationToken: TOKEN,
        activationEpoch: ACTIVATION, observedAfter: '2026-09-04T00:00:00.000Z', verifiedAt: VERIFIED_AT,
      },
    }
    const before = await adapter.verify(context, request)
    expect(before).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'instruction', status: 'unverified', verifiedCapability: null }),
      expect.objectContaining({ componentKey: 'memory_tools', status: 'verified', verifiedCapability: 2 }),
    ]))

    expect(record(context, db, OLD_TOKEN, 'brain_prepare', CURRENT_ACTIVITY))
      .toEqual({ status: 'rejected', reason: 'activity_generation_mismatch' })
    expect(record(context, db, TOKEN, 'brain_prepare', CURRENT_ACTIVITY)).toMatchObject({ status: 'recorded' })
    const after = await adapter.verify(context, request)
    expect(after).toEqual(expect.arrayContaining([
      expect.objectContaining({
        componentKey: 'instruction', status: 'verified', verifiedCapability: 1,
        diagnostics: expect.arrayContaining(['document_recognized_by_instruction_triggered_prepare']),
      }),
      expect.objectContaining({ componentKey: 'memory_tools', status: 'verified', verifiedCapability: 2 }),
    ]))
  })
})
