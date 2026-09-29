import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-shared-domain-test',
    getVersion: () => '0.2.92-test',
    getAppPath: () => '/tmp/Tide Mind.app',
    isPackaged: false,
  },
  Notification: class {
    static isSupported() { return false }
    show() {}
  },
}))
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _parameter: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { recordHostActivityEvidence } from '../../src/db/agent-host-activity'
import { bindAgentIntegrationExecutionPort, createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'
import type { DiscoveredInstallation } from '../../client/electron/agent-integration/discovery'

const V1 = 'installation-opencode-v1-shared'
const V2 = 'installation-opencode-v2-shared'

async function sharedSkillFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-domain-consumers-')))
  const home = path.join(root, 'home')
  const configRoot = path.join(home, '.config', 'opencode')
  const skillsRoot = path.join(home, '.agents', 'skills')
  const pluginsRoot = path.join(configRoot, 'plugins')
  const sharedSkill = path.join(skillsRoot, 'tidemind', 'SKILL.md')
  const sharedMcp = path.join(configRoot, 'opencode.jsonc')
  const appData = path.join(root, 'app-data')
  for (const directory of [configRoot, skillsRoot, pluginsRoot, appData, path.join(root, 'bin')]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  const runtime: AdapterRuntimeContext = {
    runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: appData,
    shimPath: path.join(root, 'bin', 'tm-node'),
    mcpServerPath: path.join(root, 'bin', 'mcp-server.cjs'),
    hookScriptPath: path.join(root, 'bin', 'hook-session-start.cjs'),
    preCompactScriptPath: path.join(root, 'bin', 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(root, 'bin', 'hook-post-compact.cjs'),
    tideMindVersion: '0.2.92', catalogVersion: '1', projectionVersion: '1',
  }
  const allAdapters = createP0HostAdapters()
  const adapters = new Map([
    ['opencode-v1-cli', allAdapters.get('opencode-v1-cli')!],
    ['opencode-v2-beta-cli', allAdapters.get('opencode-v2-beta-cli')!],
  ] as const)
  const db = new Database(path.join(root, 'agent-integration.sqlite'))
  ensureSchema(db)
  const discovered: DiscoveredInstallation[] = []
  const composition = createProductionAgentIntegrationComposition(db, {
    homeDir: home, applicationDataDir: appData, runtimeContext: runtime,
    adapters, enabledAdapterIds: [...adapters.keys()], observeOnly: false,
    startRuntime: false, fixtureMode: 'isolated_ui_audit', autoRestore: true,
    canManageInstallation: () => true,
    scanner: { scan: async () => ({ installations: discovered, unresolved: [], diagnostics: [] }) },
    notifications: { deliver: vi.fn() },
  })
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  const eligibility = (executable: string) => ({
    schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
    eligible: true, executableSizeBytes: fs.statSync(executable).size,
    proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
  })
  const add = (catalogId: 'opencode-v1-cli' | 'opencode-v2-beta-cli', id: string, version: string, command: string) => {
    const executable = path.join(root, 'bin', command)
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const identity = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos', osUserIdentity: 'usr_shared_domain',
      productFamilyId: 'opencode', hostVariant: catalogId, configRoot,
      componentConfigRoots: {
        instruction: skillsRoot,
        ...(catalogId === 'opencode-v1-cli' ? { lifecycle: configRoot } : {}),
      },
      componentConfigFiles: {
        instruction: sharedSkill, memory_tools: sharedMcp,
        ...(catalogId === 'opencode-v1-cli' ? { lifecycle: path.join(pluginsRoot, 'tidemind-v1.ts') } : {}),
      },
      distribution: {
        distributionId: `cli:${catalogId}`, executableRealpath: executable,
        packageProvenance: catalogId === 'opencode-v1-cli' ? 'npm_metadata:opencode-ai' : 'npm_metadata:@opencode-ai/cli',
        capabilityFingerprint: `cli-surface:${catalogId}`,
      },
    })
    composition.repository.upsertDiscoveredInstallation({
      id, family: 'opencode', hostVariant: catalogId,
      installKey: identity.installKey, distributionId: `cli:${catalogId}`,
      provenance: `fixture:${catalogId}`, osUserIdentity: 'usr_shared_domain',
      displayName: catalogId, configRoot, executablePath: executable,
      detectedVersion: version, agentId: `eb_${catalogId.replaceAll('-', '_')}`,
      supportedCapability: catalogId === 'opencode-v1-cli' ? 4 : 3,
      lastDetectedAt: '2026-09-25T00:00:00.000Z',
      metadata: {
        componentConfigRoots: identity.componentConfigRoots,
        componentConfigFiles: identity.componentConfigFiles,
        managementEligibility: eligibility(executable),
        distribution: identity.distribution,
      },
    })
    discovered.push({
      catalogId, displayName: catalogId, identity,
      configRoot: identity.canonicalConfigRoot,
      componentConfigRoots: identity.componentConfigRoots,
      componentConfigFiles: identity.componentConfigFiles,
      executablePath: executable, detectedVersion: version,
      managementEligibility: eligibility(executable),
      provenance: [`fixture:${catalogId}`], evidence: [],
    })
  }
  add('opencode-v1-cli', V1, '1.18.28', 'opencode')
  add('opencode-v2-beta-cli', V2, '0.0.0-beta-19086', 'opencode2')

  for (const [id, catalogId] of [[V1, 'opencode-v1-cli'], [V2, 'opencode-v2-beta-cli']] as const) {
    const preview = await composition.service.previewConnect([id])
    const applied = await composition.service.applyConnect(preview.planHash, [id])
    expect(applied.results[0], JSON.stringify(applied.results[0])).toMatchObject({ status: 'awaiting_verification' })
    const agentId = `eb_${catalogId.replaceAll('-', '_')}`
    const config = JSON.parse(fs.readFileSync(sharedMcp, 'utf8')) as { mcp: Record<string, { environment: Record<string, string> }> }
    const token = config.mcp[`tidemind-${agentId}`]!.environment.EB_ACTIVITY_GENERATION_TOKEN!
    const signals = [
      ['memory_tools', 'brain_prepare'], ['memory_tools', 'brain_recall'], ['memory_tools', 'brain_digest'],
      ...(catalogId === 'opencode-v1-cli'
        ? [['lifecycle', 'session_start'], ['lifecycle', 'pre_compact'], ['lifecycle', 'post_compact']]
        : []),
    ] as const
    for (const [componentKey, signalName] of signals) {
      expect(recordHostActivityEvidence(db, {
        agentId, hostVariant: catalogId, componentKey, signalName,
        tideMindVersion: runtime.tideMindVersion, activityGenerationToken: token,
      }).status).toBe('recorded')
    }
    await composition.service.scan()
  }
  // Both Installations are registered consumers of the one shared Skill artifact.
  expect(db.prepare(`
    SELECT c.installation_id, c.state FROM artifact_consumers c
    JOIN managed_artifacts a ON a.id = c.artifact_id
    WHERE a.target_path = ? AND c.component_key = 'instruction' ORDER BY c.installation_id
  `).all(sharedSkill)).toEqual([
    { installation_id: V1, state: 'active' },
    { installation_id: V2, state: 'active' },
  ])

  const setPersistedReason = (id: string, reason: string | null) => {
    const row = composition.repository.getInstallation(id)!
    const metadata = JSON.parse(row.metadata_json) as Record<string, Record<string, unknown>>
    const executable = row.executable_path!
    metadata.managementEligibility = reason
      ? { ...eligibility(executable), eligible: false, reason }
      : eligibility(executable)
    db.prepare('UPDATE agent_installations SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), id)
  }
  const repairRuns = () => db.prepare(`
    SELECT id, installation_id, state, failure_code, prepared_plan_json FROM reconcile_runs
    WHERE operation_type = 'repair' ORDER BY rowid
  `).all() as Array<{ id: string; installation_id: string; state: string; failure_code: string | null; prepared_plan_json: string }>
  const blockedEvents = () => db.prepare(`
    SELECT installation_id, json_extract(payload_json, '$.reason') AS reason FROM agent_integration_events
    WHERE kind = 'shared_restore_blocked_by_consumer' ORDER BY rowid
  `).all()
  const cleanup = () => {
    unbind()
    composition.runtime.stop()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { root, db, composition, sharedSkill, setPersistedReason, repairRuns, blockedEvents, cleanup }
}

describe('shared physical-domain consumers (design §3.3.1)', { timeout: 60_000 }, () => {
  it('does not auto-restore a shared Skill while another registered consumer is definitively rejected', async () => {
    const fixture = await sharedSkillFixture()
    try {
      fs.unlinkSync(fixture.sharedSkill)
      fixture.setPersistedReason(V1, 'source_not_official')
      await fixture.composition.runtime.runMaintenance()
      expect(fs.existsSync(fixture.sharedSkill)).toBe(false)
      expect(fixture.repairRuns()).toEqual([])
      expect(fixture.blockedEvents()).toEqual([
        { installation_id: V2, reason: `shared_consumer_not_compatible:${V1}` },
      ])

      // Control: once the other consumer is trusted again the same maintenance
      // pass restores the shared file and freezes the consumer set into the plan.
      fixture.setPersistedReason(V1, null)
      await fixture.composition.runtime.runMaintenance()
      expect(fs.existsSync(fixture.sharedSkill)).toBe(true)
      const repairs = fixture.repairRuns()
      expect(repairs).toHaveLength(1)
      expect([V1, V2]).toContain(repairs[0].installation_id)
      expect(JSON.parse(repairs[0].prepared_plan_json).executionPlan.sharedDomainBinding).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      fixture.cleanup()
    }
  })

  it('keeps a paused consumer in the shared set: it still blocks when rejected and is bound when compatible', async () => {
    const fixture = await sharedSkillFixture()
    try {
      fixture.composition.service.pause(V1)
      expect(fixture.composition.repository.getInstallation(V1)?.desired_state).toBe('disabled')
      expect(fixture.db.prepare(`
        SELECT state FROM artifact_consumers WHERE installation_id = ? AND component_key = 'instruction'
      `).get(V1)).toEqual({ state: 'active' })

      fs.unlinkSync(fixture.sharedSkill)
      fixture.setPersistedReason(V1, 'release_distribution_not_accepted')
      await fixture.composition.runtime.runMaintenance()
      expect(fs.existsSync(fixture.sharedSkill)).toBe(false)
      expect(fixture.blockedEvents()).toEqual([
        { installation_id: V2, reason: `shared_consumer_not_compatible:${V1}` },
      ])

      fixture.setPersistedReason(V1, null)
      await fixture.composition.runtime.runMaintenance()
      expect(fs.existsSync(fixture.sharedSkill)).toBe(true)
      const [repair] = fixture.repairRuns()
      // Only V2 is a maintenance candidate; the paused V1 is its only other consumer,
      // so a non-empty binding proves the paused consumer was counted.
      expect(repair.installation_id).toBe(V2)
      const binding = JSON.parse(repair.prepared_plan_json).executionPlan.sharedDomainBinding
      expect(binding).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      fixture.cleanup()
    }
  })

  it('abandons an approved shared write when a consumer generation changes after planning', async () => {
    const fixture = await sharedSkillFixture()
    try {
      fs.unlinkSync(fixture.sharedSkill)
      const candidate = fixture.composition.coordinatorRepository.listManagedReconcileCandidates()
        .find(item => item.installation.id === V2 && item.componentKey === 'instruction')!
      expect(candidate).toBeDefined()
      const plan = await fixture.composition.coordinator.preview({
        installation: candidate.installation,
        operation: 'repair',
        componentKeys: [...candidate.componentKeys],
        desiredCapability: candidate.desiredCapability,
      })
      expect(plan.executionPlan.sharedDomainBinding).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.adapterPlan.mutations.map(mutation => mutation.componentKey)).toEqual(['instruction'])
      // The other consumer's host was upgraded between approval and apply.
      fixture.db.prepare(`UPDATE agent_installations SET detected_version = '1.19.0' WHERE id = ?`).run(V1)
      const outcome = await fixture.composition.coordinator.applyPrepared({
        installation: candidate.installation,
        preparedPlan: plan,
        consentId: candidate.consentId,
        desiredCapability: candidate.desiredCapability,
      })
      expect(outcome).toMatchObject({ status: 'needs_recovery', reason: 'shared_consumer_set_changed' })
      expect(fs.existsSync(fixture.sharedSkill)).toBe(false)
      expect(fixture.db.prepare(`
        SELECT COUNT(*) AS count FROM projection_mutations WHERE state != 'prepared'
          AND run_id IN (SELECT id FROM reconcile_runs WHERE operation_type = 'repair')
      `).get()).toEqual({ count: 0 })
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a shared write whose other consumer is incompatible and names that consumer', async () => {
    const fixture = await sharedSkillFixture()
    try {
      fs.unlinkSync(fixture.sharedSkill)
      fixture.db.prepare(`UPDATE agent_installations SET supported_capability = 0 WHERE id = ?`).run(V1)
      const candidate = fixture.composition.coordinatorRepository.listManagedReconcileCandidates()
        .find(item => item.installation.id === V2 && item.componentKey === 'instruction')!
      await expect(fixture.composition.coordinator.preview({
        installation: candidate.installation,
        operation: 'repair',
        componentKeys: ['instruction'],
        desiredCapability: candidate.desiredCapability,
      })).rejects.toThrow(`shared_consumer_not_compatible:${V1}`)
      // Both the shared Skill and the shared opencode.jsonc container would be
      // rewritten by a reconnect; neither write is offered while V1 is incompatible.
      await expect(fixture.composition.service.previewConnect([V2]))
        .rejects.toThrow(`shared_consumer_not_compatible:${V1}`)
      expect(fs.existsSync(fixture.sharedSkill)).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })
})
