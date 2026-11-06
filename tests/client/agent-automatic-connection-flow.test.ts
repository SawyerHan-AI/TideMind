import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard'
import { recordHostActivityEvidence } from '../../src/db/agent-host-activity'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'fixture', getAppPath: () => '/tmp/fixture.app', isPackaged: false },
  Notification: class { static isSupported() { return false } show() {} } }))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { bindAgentIntegrationExecutionPort, createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import type { AgentHostAdapter } from '../../client/electron/agent-integration/types'

async function fixture(wrap?: (adapter: AgentHostAdapter) => AgentHostAdapter, sourceGate?: () => Promise<void>, automaticConnections = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-connect-')))
  const home = path.join(root, 'home'), data = path.join(root, 'data'), configRoot = path.join(home, '.cursor')
  fs.mkdirSync(configRoot, { recursive: true }); fs.mkdirSync(data)
  for (const file of ['tm-node','hook-cursor-lifecycle.cjs']) fs.writeFileSync(path.join(root,file), '// synthetic runtime fixture\n')
  const executable = path.join(root, 'fixture-cursor'); fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const identity = canonicalizeInstallationIdentity({ runtimeRealm: 'local_macos', osUserIdentity: 'fixture-user-01',
    productFamilyId: 'cursor', hostVariant: 'cursor-desktop', configRoot,
    distribution: { distributionId: 'fixture:cursor', executableRealpath: executable, packageProvenance: 'fixture', capabilityFingerprint: 'fixture' } })
  const db = new Database(':memory:'); ensureSchema(db)
  const original = createP0HostAdapters().get('cursor-desktop')!
  const adapter = wrap ? wrap(original) : original
  const composition = createProductionAgentIntegrationComposition(db, { homeDir: home, applicationDataDir: data,
    runtimeContext: { runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: data,
      shimPath: path.join(root, 'tm-node'), mcpServerPath: path.join(root, 'mcp-server.cjs'),
      hookScriptPath: path.join(root, 'hook-session-start.cjs'), preCompactScriptPath: path.join(root, 'hook-pre-compact.cjs'),
      postCompactScriptPath: path.join(root, 'hook-post-compact.cjs'), tideMindVersion: 'fixture', catalogVersion: '1', projectionVersion: '1' },
    adapters: new Map([['cursor-desktop', adapter]]), fixtureMode: 'isolated_ui_audit', automaticConnections,
    enabledAdapterIds: ['cursor-desktop'], observeOnly: false, autoRestore: true, startRuntime: false,
    canManageInstallation: () => true, liveTrustAttestor: async () => { await sourceGate?.(); return 'a'.repeat(64) },
    scanner: { scan: async () => ({ installations: [{ catalogId: 'cursor-desktop', displayName: 'Cursor', identity,
      configRoot, executablePath: executable, detectedVersion: '1.0.0', provenance: ['fixture'], evidence: [] }], unresolved: [], diagnostics: [] }) },
    notifications: { deliver: vi.fn() } })
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  const settled = async () => vi.waitFor(() => {
    expect(composition.service.listApplyTasks().tasks.filter(task => task.state === 'running')).toHaveLength(0)
  }, { timeout: 5_000 })
  return { ...composition, root, home, data, configRoot, db, settled,
    close: async () => { composition.runtime.stop(); await settled(); unbind(); db.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

describe('default connection through production composition', () => {
  it('discovers and configures a supported host without a renderer approval and does not repeat on scans', async () => {
    const f = await fixture()
    try {
      await f.service.scan(); await f.settled()
      const row = f.repository.listInstallations()[0]
      expect(row.desired_state, JSON.stringify({ installation: f.service.snapshot().installations[0], tasks: f.service.listApplyTasks(), events: f.repository.listEvents(), settings: (f.service as any).dependencies.automaticConnections })).toBe('managed')
      expect(f.repository.getConsent(row.consent_envelope_id!)?.authorization_origin).toBe('default_auto_policy')
      expect(fs.existsSync(path.join(f.configRoot, 'mcp.json'))).toBe(true)
      const grants = f.db.prepare('SELECT COUNT(*) n FROM agent_consents').get()
      await f.service.scan(); await f.settled()
      expect(f.db.prepare('SELECT COUNT(*) n FROM agent_consents').get()).toEqual(grants)
      expect(f.db.prepare("SELECT COUNT(*) n FROM agent_integration_events WHERE kind='installation_discovered_awaiting_consent'").get()).toEqual({ n: 0 })
      expect(f.service.snapshot().connections[0].statusGroup).toBe('awaiting_verification')
    } finally { await f.close() }
  })
  it('schedules a new connection after legacy inspection without waiting for old maintenance to drain', async () => {
    const f = await fixture()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let maintenanceEntered = false, scanFinished = false, legacyInspected = false
    const legacy = f.repository.listLegacyAgents.bind(f.repository)
    vi.spyOn(f.repository, 'listLegacyAgents').mockImplementation(() => { legacyInspected = true; return legacy() })
    vi.spyOn(f.runtime, 'markScanCompleted').mockImplementation(async () => {
      expect(legacyInspected).toBe(true)
      maintenanceEntered = true
      await blocked
    })
    const scan = f.service.scan().then(() => { scanFinished = true })
    try {
      await vi.waitFor(() => expect(maintenanceEntered).toBe(true))
      await f.settled()
      expect(scanFinished).toBe(false)
      expect(f.repository.listInstallations()[0].desired_state).toBe('managed')
      expect(fs.existsSync(path.join(f.configRoot, 'mcp.json'))).toBe(true)
      expect(f.service.snapshot().scanProgress?.phase).toBe('maintenance')
    } finally { release(); await scan; await f.close() }
  })
  it('shows failed setup as an actionable issue and retries directly without an approval dialog', async () => {
    let badTarget = true
    const f = await fixture(adapter => ({ ...adapter, plan: async (...args) => {
      const plan = await adapter.plan(...args)
      if (badTarget && plan.mutations[0]) {
        const target = path.join(os.tmpdir(), 'outside-automatic-policy', 'SKILL.md')
        plan.mutations[0] = { ...plan.mutations[0], physicalTarget: target,
          metadata: { ...plan.mutations[0].metadata, canonicalPath: target } }
      }
      return plan
    } }))
    try {
      await f.service.scan(); await f.settled()
      expect(f.service.snapshot().installations[0]).toMatchObject({ desiredState: 'unmanaged', statusGroup: 'needs_attention', statusReason: 'automatic_configuration_failed' })
      expect(f.db.prepare('SELECT COUNT(*) n FROM agent_consents').get()).toEqual({ n: 0 })
      await f.service.scan()
      expect(f.db.prepare("SELECT COUNT(*) n FROM agent_integration_events WHERE kind='automatic_connection_failure_attempt'").get()).toEqual({ n: 1 })
      badTarget = false
      expect(await f.service.retryAutomaticConnection(f.service.snapshot().connections[0].id)).not.toBeNull()
      await f.settled()
      expect(f.repository.listInstallations()[0].desired_state).toBe('managed')
      expect(f.service.snapshot().connections[0].issue).toBeNull()
    } finally { await f.close() }
  })
  it('can pause while initial preparation is pending and resumes from an unconfigured state', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const f = await fixture(undefined, async () => {
      if ((f.service as any).automaticDomains.size > 0 && !entered) { entered = true; await gate }
    })
    try {
      const scan = f.service.scan()
      await vi.waitFor(() => expect(entered).toBe(true))
      const key = f.service.snapshot().connections[0].id
      f.service.pauseConnection(key)
      release(); await scan; await f.settled()
      expect(f.repository.listInstallations()[0].desired_state).toBe('disabled')
      expect(f.db.prepare('SELECT COUNT(*) n FROM managed_artifacts').get()).toEqual({ n: 0 })
      await f.service.resumeConnection(key); await f.settled()
      expect(f.repository.listInstallations()[0].desired_state).toBe('managed')
      expect(fs.existsSync(path.join(f.configRoot, 'mcp.json'))).toBe(true)
    } finally { release(); await f.close() }
  })
  it('does not let late verification undo pause; resume recovers committed effects without rewriting them', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const f = await fixture(adapter => ({ ...adapter, verify: async (...args) => {
      if (!entered) { entered = true; await gate }
      return adapter.verify(...args)
    } }))
    try {
      await f.service.scan()
      await vi.waitFor(() => expect(entered).toBe(true))
      const connectionId = f.service.snapshot().connections[0].id
      f.service.pauseConnection(connectionId)
      release(); await f.settled()
      expect(f.repository.listInstallations()[0].desired_state).toBe('disabled')
      const mutations = f.db.prepare('SELECT id,state,attempt_count,after_hash FROM projection_mutations ORDER BY id').all()
      await f.service.resumeConnection(connectionId)
      await f.runtime.runMaintenance()
      expect(f.repository.listInstallations()[0].desired_state).toBe('managed')
      expect(f.db.prepare('SELECT id,state,attempt_count,after_hash FROM projection_mutations ORDER BY id').all()).toEqual(mutations)
      expect(f.db.prepare("SELECT COUNT(*) n FROM agent_integration_events WHERE kind='automatic_recovery_authorized'").get()).toEqual({ n: 1 })
    } finally { release(); await f.close() }
  })
  it('repairs under a new exact policy plan while retaining the existing consent for unaffected components', async () => {
    const f = await fixture()
    try {
      await f.service.scan(); await f.settled()
      const row = f.repository.listInstallations()[0]
      const beforeConsent = f.repository.getConsent(row.consent_envelope_id!)!
      const file = path.join(f.configRoot, 'skills', 'tidemind', 'SKILL.md')
      fs.unlinkSync(file)
      await f.runtime.runMaintenance()
      expect(fs.existsSync(file), JSON.stringify({events:f.repository.listEvents(),runs:f.db.prepare('SELECT id,state,failure_code,failure_stage FROM reconcile_runs').all()})).toBe(true)
      expect(f.repository.getInstallation(row.id)?.consent_envelope_id).toBe(row.consent_envelope_id)
      expect(f.repository.getConsent(row.consent_envelope_id!)?.authorization_context_json).toBe(beforeConsent.authorization_context_json)
      expect(f.db.prepare("SELECT COUNT(*) n FROM agent_integration_events WHERE kind='automatic_plan_authorized'").get()).toEqual({ n: 1 })
      const entry = Object.values(JSON.parse(fs.readFileSync(path.join(f.configRoot, 'mcp.json'), 'utf8')).mcpServers)[0] as { env: Record<string,string> }
      expect(evaluateBridgeAdmission(f.db, { agentId: entry.env.EB_AGENT_ID, activityGenerationToken: entry.env.EB_ACTIVITY_GENERATION_TOKEN }).allowed).toBe(true)
      expect(f.db.prepare("SELECT COUNT(*) n FROM reconcile_runs WHERE failure_code='superseded_by_same_generation_repair'").get()).toEqual({ n: 1 })
    } finally { await f.close() }
  })
  it.each([false, true])('preserves the verified bridge and finalizes it on resume (while applying: %s)', async resumeWhileApplying => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const verify = vi.fn<AgentHostAdapter['verify']>(async (context, request) => request.componentKeys.map(componentKey => ({
      componentKey, status: 'verified', identityAssertion: context.agentId, diagnostics: [], invalidationKeys: [],
    })))
    const f = await fixture(adapter => ({ ...adapter, verify }), async () => {
      if (!entered && f.db.prepare("SELECT 1 FROM reconcile_runs WHERE state='verified'").get()) {
        entered = true
        await gate
      }
    })
    try {
      await f.service.scan()
      await vi.waitFor(() => expect(entered).toBe(true))
      const connectionId = f.service.snapshot().connections[0].id
      const entry = Object.values(JSON.parse(fs.readFileSync(path.join(f.configRoot, 'mcp.json'), 'utf8')).mcpServers)[0] as { env: Record<string, string> }
      const bridge = () => evaluateBridgeAdmission(f.db, { agentId: entry.env.EB_AGENT_ID, activityGenerationToken: entry.env.EB_ACTIVITY_GENERATION_TOKEN })
      const journal = () => f.db.prepare('SELECT id,state,attempt_count,after_hash FROM projection_mutations ORDER BY id').all()
      const mutations = journal()
      f.service.pauseConnection(connectionId)
      if (resumeWhileApplying) await f.service.resumeConnection(connectionId)
      release()
      await f.settled()
      if (!resumeWhileApplying) {
        await f.runtime.runMaintenance()
        expect(f.db.prepare('SELECT state FROM reconcile_runs').all()).toEqual([{ state: 'verified' }])
        expect(f.repository.listInstallations()[0].desired_state).toBe('disabled')
        expect(bridge()).toEqual({ allowed: true })
        await f.service.resumeConnection(connectionId)
      }
      await vi.waitFor(() => expect(f.db.prepare('SELECT state FROM reconcile_runs').all()).toEqual([{ state: 'committed' }]))
      expect(bridge()).toEqual({ allowed: true })
      expect(journal()).toEqual(mutations)
      expect(verify).toHaveBeenCalledTimes(1)
    } finally { release(); await f.close() }
  })
  it.each(['explicit_user', 'legacy'] as const)('blocks %s repair after a stale disconnect preview, but permits retrying disconnect', async origin => {
    const f = await fixture(undefined, undefined, false)
    try {
      await f.service.scan()
      const row = f.repository.listInstallations()[0]
      const approved = await f.service.previewConnect([row.id])
      expect((await f.service.applyConnect(approved.planHash, [row.id])).results[0]).toMatchObject({ status: 'awaiting_verification' })
      if (origin === 'legacy') {
        f.db.prepare("UPDATE agent_consents SET authorization_origin='legacy' WHERE installation_id=?").run(row.id)
      }
      const disconnect = await f.service.previewDisconnect(row.id)
      const skill = path.join(f.configRoot, 'skills', 'tidemind', 'SKILL.md')
      fs.unlinkSync(skill)
      const removal = await f.service.disconnect(disconnect.planHash, row.id)
      expect(removal.results[0]).toMatchObject({ status: 'failed' })
      expect(f.repository.connectionIntent(row.id).excludedMemberIds).toContain(row.id)
      await f.runtime.runMaintenance()
      expect(fs.existsSync(skill)).toBe(false)
      expect(f.db.prepare("SELECT 1 FROM reconcile_runs WHERE operation_type='repair'").get()).toBeUndefined()
      const fresh = await f.service.previewDisconnect(row.id)
      const retried = await f.service.disconnect(fresh.planHash, row.id)
      expect(retried.results[0].status).not.toBe('failed')
      expect(f.repository.getInstallation(row.id)?.desired_state).toBe('removed')
    } finally { await f.close() }
  })
  it('restores all missing files of one completed wait without rewriting healthy lifecycle', async () => {
    const f = await fixture()
    try {
      await f.service.scan(); await f.settled()
      const skill = path.join(f.configRoot,'skills','tidemind','SKILL.md'), mcp = path.join(f.configRoot,'mcp.json')
      const old = f.db.prepare('SELECT * FROM reconcile_runs').get() as { id: string; prepared_plan_json: string }
      const effects = f.db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(old.id)
      const hook = path.join(f.configRoot,'hooks.json'), hookBytes = fs.readFileSync(hook)
      fs.unlinkSync(skill); fs.unlinkSync(mcp)
      const candidate=f.coordinatorRepository.listManagedReconcileCandidates().find(item=>item.componentKey==='instruction')!
      for(let attempt=0;attempt<2;attempt++) await f.coordinator.preview({installation:candidate.installation,
        operation:'repair',componentKeys:candidate.componentKeys,desiredCapability:candidate.desiredCapability})
      expect(f.db.prepare('SELECT SUM(missing_event_count) n FROM managed_artifacts').get()).toEqual({n:0})
      await f.runtime.runMaintenance()
      expect(fs.existsSync(skill),JSON.stringify(f.repository.listEvents())).toBe(true)
      expect(fs.existsSync(mcp)).toBe(true)
      expect(fs.readFileSync(hook)).toEqual(hookBytes)
      expect(f.db.prepare('SELECT * FROM projection_mutations WHERE run_id=? ORDER BY id').all(old.id)).toEqual(effects)
      const repaired = f.db.prepare("SELECT id,prepared_plan_json FROM reconcile_runs WHERE operation_type='repair'").get() as { id: string; prepared_plan_json: string }
      expect(JSON.parse(repaired.prepared_plan_json).componentKeys.sort()).toEqual(JSON.parse(old.prepared_plan_json).componentKeys.sort())
      expect(JSON.parse(repaired.prepared_plan_json).activityGenerationToken).toBe(JSON.parse(old.prepared_plan_json).activityGenerationToken)
      expect(f.db.prepare('SELECT component_key FROM projection_mutations WHERE run_id=? ORDER BY component_key').all(repaired.id))
        .toEqual([{component_key:'instruction'},{component_key:'memory_tools'}])
      const counts=()=>f.db.prepare("SELECT c.component_key,a.missing_event_count FROM installation_components c JOIN managed_artifacts a ON a.id=c.artifact_id WHERE c.component_key IN ('instruction','memory_tools') ORDER BY c.component_key").all()
      expect(counts()).toEqual([{component_key:'instruction',missing_event_count:1},{component_key:'memory_tools',missing_event_count:1}])
      fs.unlinkSync(skill);fs.unlinkSync(mcp)
      await f.runtime.runMaintenance();await f.runtime.runMaintenance()
      expect(fs.existsSync(skill)).toBe(false);expect(fs.existsSync(mcp)).toBe(false)
      expect(counts()).toEqual([{component_key:'instruction',missing_event_count:2},{component_key:'memory_tools',missing_event_count:2}])
    } finally { await f.close() }
  })
  it('carries forward valid healthy memory evidence without changing its events or expiry', async () => {
    const f = await fixture()
    try {
      await f.service.scan(); await f.settled()
      const installation = f.repository.listInstallations()[0]
      const original = f.db.prepare('SELECT id,prepared_plan_json FROM reconcile_runs').get() as { id: string; prepared_plan_json: string }
      const token = JSON.parse(original.prepared_plan_json).activityGenerationToken
      for (const signalName of ['brain_recall','brain_digest'] as const) expect(recordHostActivityEvidence(f.db, {
        agentId: installation.agent_id!, hostVariant:'cursor-desktop', componentKey:'memory_tools', signalName,
        tideMindVersion:'fixture', activityGenerationToken:token,
      }).status).toBe('recorded')
      await f.runtime.runMaintenance()
      const before = f.db.prepare("SELECT v.* FROM installation_components c JOIN verification_results v ON v.id=c.verification_result_id WHERE c.component_key='memory_tools'").get() as Record<string,unknown>
      expect(before.result).toBe('verified')
      const events = f.db.prepare('SELECT * FROM agent_host_activity_evidence ORDER BY id').all()
      fs.unlinkSync(path.join(f.configRoot,'skills','tidemind','SKILL.md'))
      await f.runtime.runMaintenance()
      const after = f.db.prepare("SELECT c.verification_status,v.* FROM installation_components c JOIN verification_results v ON v.id=c.verification_result_id WHERE c.component_key='memory_tools'").get() as Record<string,unknown>
      expect(after.verification_status,JSON.stringify(f.repository.listEvents())).toBe('verified')
      expect(after.run_id).not.toBe(before.run_id)
      for (const key of ['evidence_ref','evidence_hash','expires_at']) expect(after[key]).toBe(before[key])
      expect(f.db.prepare('SELECT * FROM verification_results WHERE id=?').get(before.id)).toEqual(before)
      expect(f.db.prepare('SELECT * FROM agent_host_activity_evidence ORDER BY id').all()).toEqual(events)
      const currentRun = String(after.run_id)
      expect(f.coordinatorRepository.reusableMemoryVerification(currentRun,new Date().toISOString(),'fixture','1')).not.toBeNull()
      f.db.prepare("UPDATE verification_results SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(after.id)
      expect(f.coordinatorRepository.reusableMemoryVerification(currentRun,new Date().toISOString(),'fixture','1')).toBeNull()
      f.db.prepare("UPDATE verification_results SET expires_at=?,invalidated_at=? WHERE id=?").run(after.expires_at,new Date().toISOString(),after.id)
      expect(f.coordinatorRepository.reusableMemoryVerification(currentRun,new Date().toISOString(),'fixture','1')).toBeNull()
    } finally { await f.close() }
  })
  it.each(['partial_journal','owned_drift_elsewhere'])('does not retire uncertain history for a repair: %s', async failure => {
    const f = await fixture()
    try {
      await f.service.scan(); await f.settled()
      const file = path.join(f.configRoot, 'skills', 'tidemind', 'SKILL.md')
      fs.unlinkSync(file)
      if (failure === 'partial_journal') f.db.exec("UPDATE projection_mutations SET state='effect_started' WHERE component_key='memory_tools'")
      else {
        const target = path.join(f.configRoot, 'mcp.json')
        const document = JSON.parse(fs.readFileSync(target, 'utf8'))
        const entry = Object.values(document.mcpServers)[0] as { command: string }
        entry.command = '/changed-by-user'
        fs.writeFileSync(target, JSON.stringify(document))
      }
      await f.runtime.runMaintenance()
      expect(f.db.prepare("SELECT COUNT(*) n FROM reconcile_runs WHERE failure_code='superseded_by_same_generation_repair'").get()).toEqual({ n: 0 })
      expect(fs.existsSync(file)).toBe(false)
    } finally { await f.close() }
  })

})
