import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.2.101', getAppPath: () => '/tmp/Tide Mind.app', isPackaged: false },
  Notification: class { static isSupported() { return false } show() {} } }))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { ensureSchema } from '../../src/db/schema'
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard'
import { borrowedByConnectedCaller } from '../../src/agent-borrowed-configuration'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createProductionAgentIntegrationComposition, bindAgentIntegrationExecutionPort } from '../../client/electron/agent-integration/production-service'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'

const AGENT = 'eb_service_fixture'

async function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'service-continuity-')))
  const configRoot = path.join(home, '.qwen'); fs.mkdirSync(configRoot)
  const settings = path.join(configRoot, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ unrelated: { preserve: true } }))
  const executable = path.join(home, 'bin', 'qwen'); fs.mkdirSync(path.dirname(executable))
  fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const runtime = { runtimeRealm: 'local_macos' as const, homeDir: home, applicationDataDir: path.join(home, 'app-data'),
    shimPath: path.join(home, 'bin', 'tm-node'), mcpServerPath: path.join(home, 'bin', 'mcp-server.cjs'),
    hookScriptPath: path.join(home, 'bin', 'hook-session-start.cjs'), preCompactScriptPath: path.join(home, 'bin', 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(home, 'bin', 'post.cjs'), tideMindVersion: '0.2.101', catalogVersion: 'fixture', projectionVersion: '1' }
  const db = new Database(':memory:'); ensureSchema(db)
  const host = createP0HostAdapters().get('qwen-code-cli')!
  const apply = vi.fn(host.apply.bind(host))
  let trusted = true
  const composition = createProductionAgentIntegrationComposition(db, { homeDir: home, applicationDataDir: runtime.applicationDataDir,
    runtimeContext: runtime, adapters: new Map([['qwen-code-cli', { ...host, apply }]]), fixtureMode: 'isolated_ui_audit',
    canManageInstallation: () => trusted, enabledAdapterIds: ['qwen-code-cli'], observeOnly: false, autoRestore: false, startRuntime: false })
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  const distribution = { distributionId: 'cli:qwen-code-cli:standalone', executableRealpath: executable,
    packageProvenance: 'npm_metadata:@qwen-code/qwen-code', capabilityFingerprint: 'cli-surface:qwen-code-cli' }
  const identity = canonicalizeInstallationIdentity({ runtimeRealm: 'local_macos', osUserIdentity: 'usr_fixture',
    productFamilyId: 'qwen-code', hostVariant: 'qwen-code-cli', configRoot, distribution })
  const id = 'qwen-service'
  const discover = (version: string) => composition.repository.upsertDiscoveredInstallation({
    id, family: 'qwen-code', hostVariant: 'qwen-code-cli', installKey: identity.installKey, distributionId: distribution.distributionId,
    provenance: 'fixture', osUserIdentity: 'usr_fixture', displayName: 'Qwen Code', configRoot, executablePath: executable,
    detectedVersion: version, versionDetectionMethod: 'cli_version', agentId: AGENT, supportedCapability: 4,
    lastDetectedAt: new Date().toISOString(), metadata: { distribution: { ...distribution,
      portableArtifactFingerprint: createHash('sha256').update(version).digest('hex') }, managementEligibility: {
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, eligible: true, reason: null,
      executableSizeBytes: 18, proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES } },
  })
  discover('0.21.13')
  const initial = await composition.service.previewConnect([id])
  await composition.service.applyConnect(initial.planHash, [id])
  const run = db.prepare('SELECT id,prepared_plan_json FROM reconcile_runs').get() as { id: string; prepared_plan_json: string }
  const token = JSON.parse(run.prepared_plan_json).activityGenerationToken as string
  const admit = (component: 'memory_tools' | 'lifecycle' = 'memory_tools') =>
    evaluateBridgeAdmission(db, { agentId: AGENT, activityGenerationToken: token, componentKey: component })
  return { home, settings, db, composition, id, run, token, admit, apply, discover,
    untrust() { trusted = false },
    close() { unbind(); composition.runtime.stop(); db.close(); fs.rmSync(home, { recursive: true, force: true }) } }
}

describe('dedicated service continuity', { timeout: 30_000 }, () => {
  it('keeps serving the unchanged configuration across a host upgrade without writing or rotating the token', async () => {
    const f = await fixture()
    try {
      expect(f.admit()).toEqual({ allowed: true })
      const before = fs.readFileSync(f.settings, 'utf8')
      const applies = f.apply.mock.calls.length
      f.discover('0.26.1')
      await f.composition.runtime.markScanCompleted()
      await f.composition.runtime.markScanCompleted()

      expect(f.db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(f.run.id))
        .toEqual({ state: 'cancelled', failure_code: 'superseded_by_service_proof' })
      expect(f.admit()).toEqual({ allowed: true })
      expect(f.admit('lifecycle')).toEqual({ allowed: true })
      expect(fs.readFileSync(f.settings, 'utf8')).toBe(before)
      expect(f.apply.mock.calls.length).toBe(applies)
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM reconcile_runs').get()).toEqual({ n: 1 })
      // Told once, in the app, without a system notification; a later renewal does not repeat it.
      expect(f.db.prepare("SELECT severity, COUNT(*) AS n FROM agent_integration_events WHERE kind='connection_auto_recovered'").get())
        .toEqual({ severity: 'info', n: 1 })
      expect(f.composition.service.inbox().startupEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'connection_auto_recovered', installationId: f.id })]))
      expect(f.db.prepare(`SELECT DISTINCT state FROM managed_artifacts`).all()).toEqual([{ state: 'healthy' }])

      // The sealed run no longer occupies the physical domain.
      const preview = await f.composition.service.previewConnect([f.id])
      expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/u)
    } finally { f.close() }
  })

  it('stops serving when the managed fragment is edited, the user disconnects, or the source is no longer trusted', async () => {
    const f = await fixture()
    try {
      f.discover('0.26.1')
      await f.composition.runtime.markScanCompleted()
      await f.composition.runtime.markScanCompleted()
      expect(f.admit()).toEqual({ allowed: true })

      const original = fs.readFileSync(f.settings, 'utf8')
      fs.writeFileSync(f.settings, original.replace(f.token, `${f.token}-edited`))
      expect(f.admit()).toEqual({ allowed: false, reason: 'activity_generation_mismatch' })
      fs.writeFileSync(f.settings, original)

      f.db.prepare("UPDATE agent_consents SET status='revoked'").run()
      expect(f.admit()).toEqual({ allowed: false, reason: 'activity_generation_mismatch' })
      f.db.prepare("UPDATE agent_consents SET status='active'").run()

      f.db.prepare("UPDATE agent_installations SET bridge_state='stopped' WHERE id=?").run(f.id)
      expect(f.admit()).toEqual({ allowed: false, reason: 'bridge_stopped' })
    } finally { f.close() }
  })

  it('honours the emergency switch by leaving the old run for the explicit reconnect path', async () => {
    process.env.TIDEMIND_AGENT_INTEGRATION_SERVICE_CONTINUITY = '0'
    const f = await fixture()
    try {
      f.discover('0.26.1')
      await f.composition.runtime.markScanCompleted()
      expect(f.db.prepare('SELECT state FROM reconcile_runs WHERE id=?').get(f.run.id)).toEqual({ state: 'needs_recovery' })
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_service_proofs').get()).toEqual({ n: 0 })
    } finally { delete process.env.TIDEMIND_AGENT_INTEGRATION_SERVICE_CONTINUITY; f.close() }
  })

  it('hides duplicate tools only for a verified caller whose own connection is provably working', async () => {
    const f = await fixture()
    try {
      // Another host's configuration, loaded by the connected Qwen fixture.
      f.db.prepare(`INSERT INTO agent_installations (id, family, host_variant, runtime_realm, os_user_identity, install_key, provenance,
          display_name, agent_id, desired_state, health_state, reconcile_state, bridge_state, created_at, updated_at)
        SELECT 'other-host', 'cursor', 'cursor-desktop', runtime_realm, os_user_identity, 'other-key', provenance,
          'Other', 'eb_other_host', 'managed', 'discovered', 'idle', 'serving', created_at, updated_at FROM agent_installations WHERE id=?`).run(f.id)
      const caller = { installationId: f.id, hostVariant: 'qwen-code-cli', level: 'verified' as const }
      expect(borrowedByConnectedCaller(f.db, 'eb_other_host', caller)).toBe(true)
      expect(borrowedByConnectedCaller(f.db, AGENT, caller)).toBe(false)
      expect(borrowedByConnectedCaller(f.db, 'eb_other_host', { ...caller, level: 'inferred' })).toBe(false)
      expect(borrowedByConnectedCaller(f.db, 'eb_other_host', { installationId: null, hostVariant: null, level: 'unidentified' })).toBe(false)
      expect(borrowedByConnectedCaller(f.db, 'eb_unknown_configuration', caller)).toBe(false)

      // The caller's own entry is gone from its file: never leave it without tools.
      const original = fs.readFileSync(f.settings, 'utf8')
      fs.writeFileSync(f.settings, JSON.stringify({ unrelated: true }))
      expect(borrowedByConnectedCaller(f.db, 'eb_other_host', caller)).toBe(false)
      fs.writeFileSync(f.settings, original)
      f.db.prepare("UPDATE agent_installations SET bridge_state='stopped' WHERE id=?").run(f.id)
      expect(borrowedByConnectedCaller(f.db, 'eb_other_host', caller)).toBe(false)

      // Disabled tools yield an empty list rather than a protocol error.
      const server = new McpServer({ name: 'fixture', version: '1' })
      const tool = server.tool('brain_recall', 'fixture', async () => ({ content: [] }))
      tool.disable()
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: 'fixture-client', version: '1' })
      await client.connect(clientTransport)
      expect((await client.listTools()).tools).toEqual([])
      await client.close()
    } finally { f.close() }
  })

  it('does not publish a proof for a source that cannot be attested', async () => {
    const f = await fixture()
    try {
      f.untrust()
      f.discover('0.26.1')
      await f.composition.runtime.markScanCompleted()
      await f.composition.runtime.markScanCompleted()
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_service_proofs').get()).toEqual({ n: 0 })
      expect(f.admit()).toEqual({ allowed: false, reason: 'activity_generation_mismatch' })
    } finally { f.close() }
  })
})
