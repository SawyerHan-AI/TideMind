import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-opencode-shared-test',
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

describe('OpenCode V1/V2 shared Skill production composition', () => {
  it.each([
    ['V1→V2 / V1→V2', ['opencode-v1-cli', 'opencode-v2-beta-cli'] as const, 'opencode-v1-cli' as const],
    ['V1→V2 / V2→V1', ['opencode-v1-cli', 'opencode-v2-beta-cli'] as const, 'opencode-v2-beta-cli' as const],
    ['V2→V1 / V1→V2', ['opencode-v2-beta-cli', 'opencode-v1-cli'] as const, 'opencode-v1-cli' as const],
    ['V2→V1 / V2→V1', ['opencode-v2-beta-cli', 'opencode-v1-cli'] as const, 'opencode-v2-beta-cli' as const],
    ['progressive runtime evidence', ['opencode-v1-cli', 'opencode-v2-beta-cli'] as const, 'opencode-v1-cli' as const, 'progressive'],
    ['single MCP repair', ['opencode-v1-cli', 'opencode-v2-beta-cli'] as const, 'opencode-v1-cli' as const, 'repair'],
    ['missing shared Skill disconnect', ['opencode-v1-cli', 'opencode-v2-beta-cli'] as const, 'opencode-v1-cli' as const, 'missing_shared'],
    ['instruction dependency drift', ['opencode-v1-cli', 'opencode-v2-beta-cli'] as const, 'opencode-v1-cli' as const, 'dependency_drift'],
  ])('connect/disconnect order %s survives restart without deleting the remaining consumer Skill', async (_label, connectOrder, firstDisconnect, scenario) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-shared-production-')))
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
    const dbPath = path.join(root, 'agent-integration.sqlite')
    let db = new Database(dbPath)
    ensureSchema(db)
    const discoveredInstallations: DiscoveredInstallation[] = []
    const createComposition = () => createProductionAgentIntegrationComposition(db, {
      homeDir: home, applicationDataDir: appData, runtimeContext: runtime,
      adapters, enabledAdapterIds: [...adapters.keys()], observeOnly: false,
      startRuntime: false, fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      scanner: { scan: async () => ({ installations: discoveredInstallations, unresolved: [], diagnostics: [] }) },
      notifications: { deliver: vi.fn() },
    })
    let composition = createComposition()
    let unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const installationIds = {
      'opencode-v1-cli': 'installation-opencode-v1-shared',
      'opencode-v2-beta-cli': 'installation-opencode-v2-shared',
    } as const

    const addInstallation = (catalogId: keyof typeof installationIds, version: string, command: string) => {
      const executable = path.join(root, 'bin', command)
      fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      const identity = canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos', osUserIdentity: 'usr_opencode_shared',
        productFamilyId: 'opencode', hostVariant: catalogId, configRoot,
        componentConfigRoots: {
          instruction: skillsRoot,
          ...(catalogId === 'opencode-v1-cli' ? { lifecycle: configRoot } : {}),
        },
        componentConfigFiles: {
          instruction: sharedSkill, memory_tools: sharedMcp,
          ...(catalogId === 'opencode-v1-cli'
            ? { lifecycle: path.join(pluginsRoot, 'tidemind-v1.ts') }
            : {}),
        },
        distribution: {
          distributionId: `cli:${catalogId}`, executableRealpath: executable,
          packageProvenance: catalogId === 'opencode-v1-cli'
            ? 'npm_metadata:opencode-ai'
            : 'npm_metadata:@opencode-ai/cli',
          capabilityFingerprint: `cli-surface:${catalogId}`,
        },
      })
      composition.repository.upsertDiscoveredInstallation({
        id: installationIds[catalogId], family: 'opencode', hostVariant: catalogId,
        installKey: identity.installKey, distributionId: `cli:${catalogId}`,
        provenance: `fixture:${catalogId}`, osUserIdentity: 'usr_opencode_shared',
        displayName: catalogId, configRoot, executablePath: executable,
        detectedVersion: version, agentId: `eb_${catalogId.replaceAll('-', '_')}`,
        supportedCapability: catalogId === 'opencode-v1-cli' ? 4 : 3,
        lastDetectedAt: '2026-09-05T00:00:00.000Z',
        metadata: {
          componentConfigRoots: identity.componentConfigRoots,
          componentConfigFiles: identity.componentConfigFiles,
          managementEligibility: {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: true, executableSizeBytes: fs.statSync(executable).size,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
          distribution: identity.distribution,
        },
      })
      discoveredInstallations.push({
        catalogId, displayName: catalogId, identity,
        configRoot: identity.canonicalConfigRoot,
        componentConfigRoots: identity.componentConfigRoots,
        componentConfigFiles: identity.componentConfigFiles,
        executablePath: executable, detectedVersion: version,
        managementEligibility: {
          schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
          eligible: true, executableSizeBytes: fs.statSync(executable).size,
          proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
        },
        provenance: [`fixture:${catalogId}`], evidence: [],
      })
    }

    try {
      addInstallation('opencode-v1-cli', '1.18.28', 'opencode')
      addInstallation('opencode-v2-beta-cli', '0.0.0-beta-19086', 'opencode2')

      for (const catalogId of connectOrder) {
        const installationId = installationIds[catalogId]
        const preview = await composition.service.previewConnect([installationId])
        const applied = await composition.service.applyConnect(preview.planHash, [installationId])
        expect(applied.results[0], JSON.stringify(applied.results[0])).toMatchObject({
          installationId, status: 'awaiting_verification',
        })
        const agentId = `eb_${catalogId.replaceAll('-', '_')}`
        const config = JSON.parse(fs.readFileSync(sharedMcp, 'utf8')) as {
          mcp: Record<string, { environment: Record<string, string> }>
        }
        const token = config.mcp[`tidemind-${agentId}`]!.environment.EB_ACTIVITY_GENERATION_TOKEN!
        const record = (componentKey: 'memory_tools' | 'lifecycle', signalName: 'brain_prepare' | 'brain_recall' | 'brain_digest' | 'session_start' | 'pre_compact' | 'post_compact') => {
          expect(recordHostActivityEvidence(db, {
            agentId, hostVariant: catalogId, componentKey, signalName,
            tideMindVersion: runtime.tideMindVersion, activityGenerationToken: token,
          }).status).toBe('recorded')
        }
        record('memory_tools', 'brain_prepare')
        record('memory_tools', 'brain_recall')
        record('memory_tools', 'brain_digest')
        if (scenario === 'progressive' && catalogId === 'opencode-v1-cli') {
          await composition.service.scan()
          expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(applied.results[0]!.runId))
            .toEqual({ state: 'applied_unverified' })
          await new Promise(resolve => setTimeout(resolve, 5))
          record('memory_tools', 'brain_prepare')
          record('memory_tools', 'brain_recall')
          record('memory_tools', 'brain_digest')
        }
        if (catalogId === 'opencode-v1-cli') {
          record('lifecycle', 'session_start')
          record('lifecycle', 'pre_compact')
          record('lifecycle', 'post_compact')
        }
        await composition.service.scan()
        const run = db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(applied.results[0]!.runId) as { state: string }
        if (run.state !== 'committed') {
          const recovery = await composition.coordinator.recoverNonTerminalRuns({ canReplayEffect: () => true })
          expect(recovery, JSON.stringify(recovery, null, 2)).toEqual([
            expect.objectContaining({ installationId, status: 'committed' }),
          ])
        }
        expect(composition.repository.getInstallation(installationId)).toMatchObject({
          desired_state: 'managed', verified_capability: catalogId === 'opencode-v1-cli' ? 4 : 3,
          verification_summary: 'verified',
        })
      }

      // Exercise the durable path, not just one in-memory composition. A
      // second maintenance pass must be an idempotent no-op after commit.
      unbind()
      composition.runtime.stop()
      db.close()
      db = new Database(dbPath)
      ensureSchema(db)
      composition = createComposition()
      unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
      await composition.service.scan()
      await composition.runtime.runMaintenance()
      await composition.runtime.runMaintenance()

      expect(fs.readFileSync(sharedSkill, 'utf8')).toContain('Tide Mind')
      const sharedConsumers = db.prepare(`
        SELECT c.installation_id, c.state
        FROM artifact_consumers c
        JOIN managed_artifacts a ON a.id = c.artifact_id
        WHERE a.target_path = ? AND c.component_key = 'instruction'
        ORDER BY c.installation_id
      `).all(sharedSkill)
      expect(sharedConsumers).toEqual([
        { installation_id: installationIds['opencode-v1-cli'], state: 'active' },
        { installation_id: installationIds['opencode-v2-beta-cli'], state: 'active' },
      ])
      const runRows = db.prepare(`SELECT installation_id, operation_type, state, failure_code, failure_stage FROM reconcile_runs ORDER BY rowid`).all()
      expect(runRows, JSON.stringify({
        runs: runRows,
        verifications: db.prepare(`SELECT installation_id, component_key, result, evidence_ref FROM verification_results ORDER BY rowid`).all(),
      }, null, 2))
        .toEqual([
          ...connectOrder.map(catalogId => ({
            installation_id: installationIds[catalogId], operation_type: 'connect', state: 'committed',
            failure_code: null, failure_stage: null,
          })),
        ])

      if (scenario === 'repair') {
        const document = JSON.parse(fs.readFileSync(sharedMcp, 'utf8'))
        delete document.mcp['tidemind-eb_opencode_v1_cli']
        fs.writeFileSync(sharedMcp, JSON.stringify(document))
        await composition.runtime.runMaintenance()
        const repair = db.prepare(`SELECT id, desired_capability FROM reconcile_runs WHERE operation_type = 'repair'`)
          .get() as { id: string; desired_capability: number }
        expect(repair.desired_capability).toBe(2)
        const token = JSON.parse(fs.readFileSync(sharedMcp, 'utf8'))
          .mcp['tidemind-eb_opencode_v1_cli'].environment.EB_ACTIVITY_GENERATION_TOKEN
        for (const signalName of ['brain_prepare', 'brain_recall', 'brain_digest'] as const) {
          expect(recordHostActivityEvidence(db, {
            agentId: 'eb_opencode_v1_cli', hostVariant: 'opencode-v1-cli', componentKey: 'memory_tools',
            signalName, tideMindVersion: runtime.tideMindVersion, activityGenerationToken: token,
          }).status).toBe('recorded')
        }
        await composition.service.scan()
        expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(repair.id))
          .toEqual({ state: 'committed' })
        expect(composition.repository.getInstallation(installationIds['opencode-v1-cli'])?.desired_capability).toBe(4)
      }
      if (scenario === 'dependency_drift') {
        fs.writeFileSync(path.join(pluginsRoot, 'tidemind-v1.ts'), 'user changed the lifecycle document')
        fs.unlinkSync(sharedSkill)
        await composition.runtime.runMaintenance()
        expect(fs.existsSync(sharedSkill)).toBe(false)
        expect(db.prepare(`SELECT id FROM reconcile_runs WHERE operation_type = 'repair'`).all()).toEqual([])
        return
      }

      // V1's dedicated lifecycle document requires explicit cleanup, while the
      // shared Skill must remain for whichever consumer stays connected.
      if (firstDisconnect === 'opencode-v1-cli') fs.unlinkSync(path.join(pluginsRoot, 'tidemind-v1.ts'))
      if (scenario === 'missing_shared') fs.unlinkSync(sharedSkill)
      const firstPreview = await composition.service.previewDisconnect(installationIds[firstDisconnect])
      const firstResult = await composition.service.disconnect(firstPreview.planHash, installationIds[firstDisconnect])
      expect(firstResult.results[0], JSON.stringify(firstResult.results[0], null, 2)).toMatchObject({ status: 'committed' })
      expect(fs.existsSync(sharedSkill)).toBe(true)
      const remaining = firstDisconnect === 'opencode-v1-cli' ? 'opencode-v2-beta-cli' : 'opencode-v1-cli'
      expect(db.prepare(`
        SELECT state FROM artifact_consumers
        WHERE installation_id = ? AND component_key = 'instruction'
      `).get(installationIds[remaining])).toEqual({ state: 'active' })
      if (scenario === 'missing_shared') {
        // Disconnect's maintenance pass restores the proven missing shared
        // file for the remaining consumer; host recognition is still pending.
        expect(db.prepare(`SELECT state FROM managed_artifacts WHERE target_path = ?`).get(sharedSkill))
          .toEqual({ state: 'healthy' })
        expect(db.prepare(`SELECT state, desired_capability FROM reconcile_runs WHERE operation_type = 'repair'`).get())
          .toEqual({ state: 'applied_unverified', desired_capability: 1 })
        const repair = db.prepare(`SELECT id, prepared_plan_json FROM reconcile_runs WHERE operation_type = 'repair'`)
          .get() as { id: string; prepared_plan_json: string }
        const prepared = JSON.parse(repair.prepared_plan_json)
        expect(prepared.componentKeys).toEqual(['instruction', 'memory_tools'])
        expect(prepared.adapterPlan.mutations.map((mutation: { componentKey: string }) => mutation.componentKey))
          .toEqual(['instruction'])
        const token = JSON.parse(fs.readFileSync(sharedMcp, 'utf8'))
          .mcp['tidemind-eb_opencode_v2_beta_cli'].environment.EB_ACTIVITY_GENERATION_TOKEN
        expect(prepared.activityGenerationToken).toBe(token)
        // The earlier connection's successful activities cannot prove this repair.
        await composition.service.scan()
        expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(repair.id))
          .toEqual({ state: 'applied_unverified' })
        expect(recordHostActivityEvidence(db, {
          agentId: 'eb_opencode_v2_beta_cli', hostVariant: 'opencode-v2-beta-cli', componentKey: 'memory_tools',
          signalName: 'brain_prepare', tideMindVersion: runtime.tideMindVersion, activityGenerationToken: 'stale-token',
        }).status).toBe('rejected')
        for (const signalName of ['brain_prepare', 'brain_recall', 'brain_digest'] as const) {
          expect(recordHostActivityEvidence(db, {
            agentId: 'eb_opencode_v2_beta_cli', hostVariant: 'opencode-v2-beta-cli', componentKey: 'memory_tools',
            signalName, tideMindVersion: runtime.tideMindVersion, activityGenerationToken: token,
          }).status).toBe('recorded')
        }
        await composition.service.scan()
        expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(repair.id))
          .toEqual({ state: 'committed' })
        expect(db.prepare(`SELECT DISTINCT activation_run_id FROM agent_host_activity_evidence WHERE activation_run_id = ?`)
          .all(repair.id)).toEqual([{ activation_run_id: repair.id }])
      }

      // The last managed-text consumer likewise requires explicit deletion;
      // the remaining JSON MCP selector is removed by the real Adapter.
      if (remaining === 'opencode-v1-cli') fs.unlinkSync(path.join(pluginsRoot, 'tidemind-v1.ts'))
      if (fs.existsSync(sharedSkill)) fs.unlinkSync(sharedSkill)
      const lastPreview = await composition.service.previewDisconnect(installationIds[remaining])
      const lastResult = await composition.service.disconnect(lastPreview.planHash, installationIds[remaining])
      expect(lastResult.results[0]).toMatchObject({ status: 'committed' })
      expect(composition.repository.getInstallation(installationIds['opencode-v1-cli'])?.desired_state).toBe('removed')
      expect(composition.repository.getInstallation(installationIds['opencode-v2-beta-cli'])?.desired_state).toBe('removed')
      expect(db.prepare(`SELECT state FROM managed_artifacts WHERE target_path = ? AND ownership_key = 'document'`)
        .get(sharedSkill)).toEqual({ state: 'removed' })
      const finalConfig = JSON.parse(fs.readFileSync(sharedMcp, 'utf8')) as { mcp?: Record<string, unknown> }
      expect(Object.keys(finalConfig.mcp ?? {}).filter(key => key.startsWith('tidemind-'))).toEqual([])
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
