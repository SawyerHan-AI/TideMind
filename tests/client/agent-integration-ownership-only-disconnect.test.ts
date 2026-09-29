import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-ownership-only-test',
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
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard'
import { bindAgentIntegrationExecutionPort, createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'
import type { AdapterRuntimeContext, AgentHostAdapter } from '../../client/electron/agent-integration/types'

function runtimeFor(root: string, home: string, appData: string): AdapterRuntimeContext {
  return {
    runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: appData,
    shimPath: path.join(root, 'bin', 'tm-node'),
    mcpServerPath: path.join(root, 'bin', 'mcp-server.cjs'),
    hookScriptPath: path.join(root, 'bin', 'hook-session-start.cjs'),
    preCompactScriptPath: path.join(root, 'bin', 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(root, 'bin', 'hook-post-compact.cjs'),
    tideMindVersion: '0.2.92', catalogVersion: '1', projectionVersion: '1',
  }
}

const eligibility = (executable: string, reason?: string) => ({
  schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  eligible: reason === undefined,
  ...(reason ? { reason } : {}),
  executableSizeBytes: fs.statSync(executable).size,
  proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
})

describe('disconnect is not blocked by the runtime source decision (design §3.5)', { timeout: 60_000 }, () => {
  it('removes Tide Mind-owned file fragments with ownership + CAS when the source is no longer official', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-only-file-')))
    const home = path.join(root, 'home')
    const configRoot = path.join(home, '.config', 'opencode')
    const skillsRoot = path.join(home, '.agents', 'skills')
    const pluginsRoot = path.join(configRoot, 'plugins')
    const sharedSkill = path.join(skillsRoot, 'tidemind', 'SKILL.md')
    const opencodeConfig = path.join(configRoot, 'opencode.jsonc')
    const appData = path.join(root, 'app-data')
    for (const directory of [configRoot, skillsRoot, pluginsRoot, appData, path.join(root, 'bin')]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    const executable = path.join(root, 'bin', 'opencode')
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const runtime = runtimeFor(root, home, appData)
    const db = new Database(path.join(root, 'agent-integration.sqlite'))
    ensureSchema(db)
    const identity = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos', osUserIdentity: 'usr_ownership_only',
      productFamilyId: 'opencode', hostVariant: 'opencode-v1-cli', configRoot,
      componentConfigRoots: { instruction: skillsRoot, lifecycle: configRoot },
      componentConfigFiles: {
        instruction: sharedSkill, memory_tools: opencodeConfig, lifecycle: path.join(pluginsRoot, 'tidemind-v1.ts'),
      },
      distribution: {
        distributionId: 'cli:opencode-v1-cli', executableRealpath: executable,
        packageProvenance: 'npm_metadata:opencode-ai', capabilityFingerprint: 'cli-surface:opencode-v1-cli',
      },
    })
    const liveTrustAttestor = vi.fn(async () => 'a'.repeat(64))
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home, applicationDataDir: appData, runtimeContext: runtime,
      adapters: new Map([['opencode-v1-cli', createP0HostAdapters().get('opencode-v1-cli')!]]),
      enabledAdapterIds: ['opencode-v1-cli'], observeOnly: false, startRuntime: false,
      fixtureMode: 'isolated_ui_audit', canManageInstallation: () => true, liveTrustAttestor,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const id = 'installation-opencode-ownership-only'
    const upsert = (reason?: string) => composition.repository.upsertDiscoveredInstallation({
      id, family: 'opencode', hostVariant: 'opencode-v1-cli',
      installKey: identity.installKey, distributionId: 'cli:opencode-v1-cli',
      provenance: 'fixture:opencode', osUserIdentity: 'usr_ownership_only',
      displayName: 'OpenCode', configRoot, executablePath: executable,
      detectedVersion: '1.18.28', agentId: 'eb_opencode_ownership_only',
      supportedCapability: reason === 'source_not_official' ? 0 : 4,
      lastDetectedAt: '2026-09-25T00:00:00.000Z',
      metadata: {
        componentConfigRoots: identity.componentConfigRoots,
        componentConfigFiles: identity.componentConfigFiles,
        managementEligibility: eligibility(executable, reason),
        distribution: identity.distribution,
      },
    })
    try {
      upsert()
      const connectPreview = await composition.service.previewConnect([id])
      expect((await composition.service.applyConnect(connectPreview.planHash, [id])).results[0])
        .toMatchObject({ status: 'awaiting_verification' })
      expect(Object.keys(JSON.parse(fs.readFileSync(opencodeConfig, 'utf8')).mcp))
        .toEqual(['tidemind-eb_opencode_ownership_only'])

      // The installed package is later found not to be the official one.
      upsert('source_not_official')
      expect(composition.service.snapshot().installations[0]).toMatchObject({ manageable: false, disconnectable: true })
      await expect(composition.service.previewConnect([id])).rejects.toThrow('source_not_official')
      // Whole-file carriers stay manual (never unlinked automatically).
      fs.unlinkSync(sharedSkill)
      fs.unlinkSync(path.join(pluginsRoot, 'tidemind-v1.ts'))
      liveTrustAttestor.mockClear()

      const preview = await composition.service.previewDisconnect(id, true)
      expect(preview.installations[0].diagnostics).not.toContain('ownership_only_disconnect_requires_host_manual_removal')
      const disconnected = await composition.service.disconnect(preview.planHash, id)
      expect(disconnected.results[0], JSON.stringify(disconnected.results[0])).toMatchObject({ status: 'committed' })
      // No live source proof was requested or claimed for the untrusted host.
      expect(liveTrustAttestor).not.toHaveBeenCalled()
      const run = db.prepare(`
        SELECT prepared_plan_json FROM reconcile_runs WHERE installation_id = ? AND operation_type = 'disconnect'
      `).get(id) as { prepared_plan_json: string }
      const executionPlan = JSON.parse(run.prepared_plan_json).executionPlan
      expect(executionPlan.ownershipOnlyDisconnectBinding).toMatch(/^[a-f0-9]{64}$/)
      expect(executionPlan.liveTrustProofFingerprint).toBeUndefined()
      expect(JSON.parse(fs.readFileSync(opencodeConfig, 'utf8')).mcp ?? {}).toEqual({})
      expect(composition.repository.getInstallation(id)).toMatchObject({
        desired_state: 'removed', status_reason: 'disconnect_verified', bridge_state: 'stopped',
      })
      expect(evaluateBridgeAdmission(db, { agentId: 'eb_opencode_ownership_only', activityGenerationToken: 'any' }))
        .toEqual({ allowed: false, reason: 'installation_removed' })
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('never runs an untrusted host program: a plugin-manager carrier gets manual steps and only the bridge stops', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-only-host-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const configRoot = path.join(home, '.gemini')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    const executable = path.join(root, 'bin', 'gemini')
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const hostCalls: string[] = []
    const refuse = (name: string) => async () => {
      hostCalls.push(name)
      throw new Error(`host program must not run: ${name}`)
    }
    const hostAdapter: AgentHostAdapter = {
      catalogId: 'gemini-cli',
      adapterVersion: '1',
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      implementationTypes: { instruction: ['plugin', 'skill'], memory_tools: ['plugin', 'mcp'], lifecycle: ['plugin', 'hook'] },
      componentContracts: {
        instruction: { deliveryMode: 'managed', artifactTypes: ['plugin', 'skill'], mutationDomain: 'plugin_manager', reload: 'new_session' },
        memory_tools: { deliveryMode: 'managed', artifactTypes: ['plugin', 'mcp'], mutationDomain: 'plugin_manager', reload: 'new_session' },
        lifecycle: { deliveryMode: 'managed', artifactTypes: ['plugin', 'hook'], mutationDomain: 'plugin_manager', reload: 'new_session' },
      },
      inspect: refuse('inspect'),
      plan: refuse('plan'),
      apply: refuse('apply'),
      readBack: refuse('readBack'),
      disconnect: refuse('disconnect'),
      verify: refuse('verify'),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home, applicationDataDir: appData, runtimeContext: runtimeFor(root, home, appData),
      adapters: new Map([['gemini-cli', hostAdapter]]), enabledAdapterIds: ['gemini-cli'],
      observeOnly: false, startRuntime: false, fixtureMode: 'isolated_ui_audit', canManageInstallation: () => true,
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const id = 'installation-gemini-untrusted'
    const extension = path.join(configRoot, 'extensions', 'tidemind-eb-gemini')
    try {
      composition.repository.upsertDiscoveredInstallation({
        id, family: 'gemini', hostVariant: 'gemini-cli', installKey: `gemini-cli:${configRoot}`,
        distributionId: 'cli:gemini-cli', provenance: 'fixture', osUserIdentity: 'usr_ownership_only',
        displayName: 'Gemini CLI', configRoot, executablePath: executable, detectedVersion: '0.60.0',
        agentId: 'eb_gemini_untrusted', supportedCapability: 0, lastDetectedAt: '2026-09-25T00:00:00.000Z',
        metadata: {
          managementEligibility: eligibility(executable, 'source_not_official'),
          distribution: {
            distributionId: 'cli:gemini-cli', executableRealpath: executable,
            packageProvenance: 'npm_metadata:@google/gemini-cli', capabilityFingerprint: 'cli-surface:gemini-cli',
          },
        },
      })
      composition.repository.createManagedArtifact({
        id: 'artifact-gemini-extension', componentType: 'plugin', targetPath: extension,
        ownershipKey: 'tidemind-eb-gemini', mutationDomain: `local_macos:plugin_manager:${extension}`,
        projectionVersion: '1', selectorSchemaVersion: '1', ownedFragmentHash: 'owned', desiredFragmentHash: 'owned',
        observedFragmentHash: 'owned',
      }, '2026-09-25T00:00:00.000Z')
      for (const componentKey of ['instruction', 'memory_tools', 'lifecycle'] as const) {
        composition.repository.upsertComponent({
          installationId: id, componentKey, desiredState: 'managed', desiredCapability: 4,
          deliveryMode: 'managed', artifactId: 'artifact-gemini-extension',
        }, '2026-09-25T00:00:00.000Z')
      }
      composition.repository.createConsent({
        id: 'consent-gemini-untrusted', installationId: id, policyVersion: '1',
        allowedComponents: ['instruction', 'memory_tools', 'lifecycle'], allowedScopes: [extension],
        normalizedTargets: [extension], selectorSchemaVersion: '1', selectorResolution: {},
        executableRealpaths: [executable], commandCategories: ['plugin_install'], maximumRisk: 'elevated',
        confirmedAt: '2026-09-25T00:00:00.000Z',
      })
      db.prepare(`UPDATE agent_installations SET desired_state = 'managed', consent_envelope_id = 'consent-gemini-untrusted'
        WHERE id = ?`).run(id)

      expect(composition.service.detail(id).installation).toMatchObject({ manageable: false, disconnectable: true })
      const preview = await composition.service.previewDisconnect(id)
      const item = preview.installations[0]
      expect(item.targets).toEqual([])
      expect(item.requiredUserActions).toEqual(['host_manual_removal_required'])
      expect(item.diagnostics).toEqual(['ownership_only_disconnect_requires_host_manual_removal', 'source_not_official'])
      expect(item.requiredUserActionDetails).toEqual([expect.objectContaining({
        kind: 'manual_host_removal',
        componentKeys: ['instruction', 'lifecycle', 'memory_tools'],
        ownershipKey: 'tidemind-eb-gemini',
        hostLabel: expect.any(String),
      })])

      const result = await composition.service.disconnect(preview.planHash, id)
      expect(result.results[0]).toMatchObject({ status: 'paused', reason: 'host_manual_removal_required' })
      expect(hostCalls).toEqual([])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(composition.repository.getInstallation(id)).toMatchObject({
        desired_state: 'disabled',
        bridge_state: 'stopped',
        bridge_state_reason: 'disconnect_pending_manual_removal',
        host_components_state: 'loaded_unknown',
      })
      expect(composition.service.detail(id).installation.deactivation).toEqual({
        maintenance: 'paused', bridge: 'stopped', hostComponents: 'loaded_unknown',
      })
      expect(evaluateBridgeAdmission(db, { agentId: 'eb_gemini_untrusted', activityGenerationToken: 'any' }))
        .toEqual({ allowed: false, reason: 'bridge_stopped' })

      // Resuming maintenance undoes exactly that pending disconnect.
      await composition.service.resume(id)
      expect(composition.repository.getInstallation(id)).toMatchObject({
        desired_state: 'managed', bridge_state: 'serving', bridge_state_reason: null,
      })
      expect(hostCalls).toEqual([])
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
