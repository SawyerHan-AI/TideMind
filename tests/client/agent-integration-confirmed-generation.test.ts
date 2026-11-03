import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.2.94', getAppPath: () => '/tmp/Tide Mind.app', isPackaged: false },
  Notification: class { static isSupported() { return false } show() {} } }))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { ensureSchema } from '../../src/db/schema'
import { createProductionAgentIntegrationComposition, bindAgentIntegrationExecutionPort } from '../../client/electron/agent-integration/production-service'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity, EXACT_INSTALL_KEY_DISTRIBUTION_CONFLICT_REASON } from '../../client/electron/agent-integration/identity'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'

async function fixture(failVerification = false) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'confirmed-host-generation-')))
  const configRoot = path.join(home, '.qwen'); fs.mkdirSync(configRoot)
  const settings = path.join(configRoot, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ unrelated: { preserve: true } }))
  const executable = path.join(home, 'bin', 'qwen'); fs.mkdirSync(path.dirname(executable))
  fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const runtime = { runtimeRealm: 'local_macos' as const, homeDir: home, applicationDataDir: path.join(home, 'app-data'),
    shimPath: path.join(home, 'bin', 'tm-node'), mcpServerPath: path.join(home, 'bin', 'mcp-server.cjs'),
    hookScriptPath: path.join(home, 'bin', 'hook-session-start.cjs'), preCompactScriptPath: path.join(home, 'bin', 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(home, 'bin', 'post.cjs'), tideMindVersion: '0.2.94', catalogVersion: 'fixture', projectionVersion: '1' }
  const db = new Database(':memory:'); ensureSchema(db)
  const host = createP0HostAdapters().get('qwen-code-cli')!
  const apply = vi.fn(host.apply.bind(host)); const adapter = { ...host, apply }
  if (failVerification) vi.spyOn(adapter,'verify').mockImplementationOnce(async (_context,request) => request.componentKeys.map(componentKey => ({
    componentKey, status:'failed' as const, verifiedCapability:null, invalidationKeys:[], diagnostics:['synthetic runtime verification failure'],
  })))
  let trusted = true
  const composition = createProductionAgentIntegrationComposition(db, { homeDir: home, applicationDataDir: runtime.applicationDataDir,
    runtimeContext: runtime, adapters: new Map([['qwen-code-cli', adapter]]), fixtureMode: 'isolated_ui_audit',
    canManageInstallation: () => trusted, enabledAdapterIds: ['qwen-code-cli'], observeOnly: false, autoRestore: false, startRuntime: false })
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  const distribution = { distributionId: 'cli:qwen-code-cli:standalone', executableRealpath: executable,
    packageProvenance: 'npm_metadata:@qwen-code/qwen-code', capabilityFingerprint: 'cli-surface:qwen-code-cli' }
  const identity = canonicalizeInstallationIdentity({ runtimeRealm: 'local_macos', osUserIdentity: 'usr_fixture',
    productFamilyId: 'qwen-code', hostVariant: 'qwen-code-cli', configRoot, distribution })
  const id = 'qwen-generation'
  const discover = (version: string, provenance = distribution.packageProvenance) => composition.repository.upsertDiscoveredInstallation({
    id, family: 'qwen-code', hostVariant: 'qwen-code-cli', installKey: identity.installKey, distributionId: distribution.distributionId,
    provenance: 'fixture', osUserIdentity: 'usr_fixture', displayName: 'Qwen Code', configRoot, executablePath: executable,
    detectedVersion: version, versionDetectionMethod: 'cli_version', agentId: 'eb_generation_fixture', supportedCapability: 4,
    lastDetectedAt: new Date().toISOString(), metadata: { distribution: { ...distribution, packageProvenance: provenance,
      portableArtifactFingerprint: createHash('sha256').update(version).digest('hex') }, managementEligibility: {
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, eligible: true, reason: null,
      executableSizeBytes: 18, proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES } },
  })
  discover('0.21.13')
  const initial = await composition.service.previewConnect([id])
  const first = await composition.service.applyConnect(initial.planHash, [id])
  expect(first.results[0].status).toBe(failVerification?'needs_recovery':'awaiting_verification')
  const old = db.prepare('SELECT id,execution_plan_hash,prepared_plan_json,consent_envelope_id FROM reconcile_runs').get() as Record<string,string>
  expect(JSON.parse(old.prepared_plan_json).componentKeys).toEqual(['instruction','lifecycle','memory_tools'])
  expect(db.prepare('SELECT state,attempt_count FROM projection_mutations WHERE run_id=?').all(old.id))
    .toEqual([{ state: 'committed', attempt_count: 1 }, { state: 'committed', attempt_count: 1 }])
  const before = fs.readFileSync(settings, 'utf8')
  const oldEffects = db.prepare('SELECT id,state,attempt_count,after_hash,apply_receipt_json FROM projection_mutations WHERE run_id=? ORDER BY id').all(old.id)
  const upgrade = async (provenance = distribution.packageProvenance, reason = EXACT_INSTALL_KEY_DISTRIBUTION_CONFLICT_REASON) => {
    discover('0.26.1', provenance)
    await composition.runtime.markScanCompleted()
    expect(db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(old.id))
      .toEqual({ state: 'needs_recovery', failure_code: 'recovery_source_trust_changed' })
    // Match the real sticky rule-2 attention followed by a fresh, authoritative observation.
    composition.repository.markInstallationIdentityConflict(id, new Date().toISOString(), reason)
    discover('0.26.1', provenance)
  }
  return { home, settings, db, composition, id, old, before, oldEffects, apply, upgrade, discover, host: adapter, runtime, identity,
    untrust() { trusted = false },
    assertOldUntouched() {
      expect(db.prepare('SELECT id,state,attempt_count,after_hash,apply_receipt_json FROM projection_mutations WHERE run_id=? ORDER BY id').all(old.id)).toEqual(oldEffects)
      expect(db.prepare('SELECT execution_plan_hash,prepared_plan_json,consent_envelope_id FROM reconcile_runs WHERE id=?').get(old.id))
        .toEqual({ execution_plan_hash: old.execution_plan_hash, prepared_plan_json: old.prepared_plan_json, consent_envelope_id: old.consent_envelope_id })
    },
    close() { unbind(); composition.runtime.stop(); db.close(); fs.rmSync(home, { recursive: true, force: true }) },
  }
}

describe('confirmed same-source host generation takeover through production composition', () => {
  it('disconnects a completed unbound Qwen run after real verification failure', async () => {
    const f=await fixture(true)
    try {
      expect(f.db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(f.old.id)).toEqual({state:'needs_recovery',failure_code:'verification_failed'})
      const preview=await f.composition.service.previewDisconnect(f.id)
      const result=await f.composition.service.disconnect(preview.planHash,f.id)
      expect(result.results[0],JSON.stringify(result)).toMatchObject({status:'awaiting_verification',requiredUserActionDetails:[expect.objectContaining({kind:'manual_file_removal',componentKey:'instruction'})]})
      expect(f.db.prepare('SELECT state,failure_code FROM reconcile_runs WHERE id=?').get(f.old.id)).toEqual({state:'cancelled',failure_code:'superseded_by_disconnect'})
      f.assertOldUntouched()
      fs.unlinkSync(path.join(f.home,'.qwen/skills/tidemind/SKILL.md'))
      const completed=await f.composition.coordinator.recoverNonTerminalRuns()
      expect(completed).toContainEqual(expect.objectContaining({status:'committed'}))
      expect(JSON.parse(fs.readFileSync(f.settings,'utf8')).unrelated).toEqual({preserve:true})
    } finally { f.close() }
  })

  it('replaces the exact completed old waiting generation only after a new explicit plan', async () => {
    const f = await fixture()
    try {
      await f.upgrade()
      const calls = f.apply.mock.calls.length
      const preview = await f.composition.service.previewConnect([f.id])
      expect(fs.readFileSync(f.settings,'utf8')).toBe(f.before)
      expect(f.db.prepare('SELECT state FROM reconcile_runs WHERE id=?').get(f.old.id)).toEqual({ state: 'needs_recovery' })
      const result = await f.composition.service.applyConnect(preview.planHash,[f.id])
      expect(result.results[0].status, JSON.stringify(result)).toBe('awaiting_verification')
      const runs = f.db.prepare('SELECT id,state,failure_code,prepared_plan_json FROM reconcile_runs ORDER BY created_at').all() as Array<Record<string,string>>
      expect(runs).toHaveLength(2)
      expect(runs[0]).toMatchObject({ id: f.old.id, state: 'cancelled', failure_code: 'superseded_by_confirmed_generation' })
      const next = JSON.parse(runs[1].prepared_plan_json)
      expect(next.executionPlan.completedGenerationTakeovers).toEqual([{ runId: f.old.id, executionPlanHash: f.old.execution_plan_hash,
        effectSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/), mutationDomains: expect.arrayContaining([
          expect.stringContaining('SKILL.md'), expect.stringContaining('settings.json'),
        ]) }])
      expect(next.executionPlan.hostVersion).toBe('0.26.1')
      const newEffects = f.db.prepare('SELECT id FROM projection_mutations WHERE run_id=?').all(runs[1].id)
      expect(f.apply).toHaveBeenCalledTimes(calls + newEffects.length)
      f.assertOldUntouched()
      expect(JSON.parse(fs.readFileSync(f.settings,'utf8')).unrelated).toEqual({ preserve: true })
      expect(f.composition.service.getApplyTask(f.old.id).results[0].status).toBe('superseded')
      expect(f.composition.repository.getInstallation(f.id)?.status_reason).not.toBe('conflict')
    } finally { f.close() }
  })

  it.each(['partial','different-source','identity-conflict','owned-drift'] as const)('refuses %s without replacing the old wait', async failure => {
    const f = await fixture()
    try {
      await f.upgrade(failure==='different-source'?'npm_metadata:another-publisher':undefined,
        failure==='identity-conflict'?'Multiple unrelated identities require a choice':undefined)
      if (failure==='partial') f.db.prepare("UPDATE projection_mutations SET state='effect_started' WHERE run_id=? AND component_key='memory_tools'").run(f.old.id)
      if (failure==='owned-drift') {
        const config=JSON.parse(f.before);const name=Object.keys(config.mcpServers)[0];config.mcpServers[name].args.push('--external-change')
        fs.writeFileSync(f.settings,JSON.stringify(config))
      }
      const bytes=fs.readFileSync(f.settings,'utf8'),calls=f.apply.mock.calls.length
      const preview=await f.composition.service.previewConnect([f.id]);const result=await f.composition.service.applyConnect(preview.planHash,[f.id])
      expect(result.results[0].status).not.toBe('awaiting_verification')
      expect(f.apply).toHaveBeenCalledTimes(calls);expect(fs.readFileSync(f.settings,'utf8')).toBe(bytes)
      expect(f.db.prepare('SELECT state FROM reconcile_runs WHERE id=?').get(f.old.id)).toEqual({state:'needs_recovery'})
      expect(f.db.prepare('SELECT count(*) AS n FROM reconcile_runs').get()).toEqual({n:1})
    } finally { f.close() }
  })

  it.each(['source-after-preview','noop-skill-after-preview','old-run-executing','other-run-domain','shared-consumer'] as const)('preserves the old run when %s blocks confirm', async failure => {
    const f=await fixture()
    try {
      await f.upgrade();const preview=await f.composition.service.previewConnect([f.id]);let lock:{release():void}|null=null
      if(failure==='source-after-preview')f.untrust()
      const skill=path.join(f.home,'.qwen/skills/tidemind/SKILL.md')
      if(failure==='noop-skill-after-preview')fs.appendFileSync(skill,'external change')
      if(failure==='old-run-executing')lock=f.composition.coordinatorRepository.acquireExecutionFence(f.old.id)
      if(failure==='other-run-domain'||failure==='shared-consumer') {
        f.composition.repository.upsertDiscoveredInstallation({ id:'other-installation',family:'qwen-code',hostVariant:'qwen-code-cli',
          installKey:'other-installation',provenance:'fixture',osUserIdentity:'usr_fixture',displayName:'Other',
          configRoot:path.join(f.home,'other'),agentId:'eb_other_fixture',supportedCapability:4,lastDetectedAt:new Date().toISOString() })
        if(failure==='shared-consumer') {
          const artifact=f.db.prepare("SELECT a.id,a.owned_fragment_hash FROM managed_artifacts a JOIN installation_components c ON c.artifact_id=a.id WHERE c.installation_id=? AND c.component_key='memory_tools'").get(f.id) as {id:string;owned_fragment_hash:string}
          const oldPlan=JSON.parse(f.old.prepared_plan_json)
          const oldMutation=oldPlan.adapterPlan.mutations.find((mutation:{componentKey:string})=>mutation.componentKey==='memory_tools')
          const observed=await f.host.readBack({runtime:f.runtime,installation:f.identity,installationId:f.id,agentId:'eb_generation_fixture',
            operationId:oldMutation.operationId,hostVersion:'0.26.1',activityGenerationToken:oldPlan.activityGenerationToken},oldMutation)
          expect(observed.matchesDesired).toBe(true)
          expect(observed.observedFragmentHash).toBe(artifact.owned_fragment_hash)
          f.composition.repository.upsertComponent({installationId:'other-installation',componentKey:'memory_tools',desiredState:'managed',desiredCapability:2,deliveryMode:'managed',artifactId:artifact.id},new Date().toISOString())
          f.composition.repository.addArtifactConsumer({artifactId:artifact.id,installationId:'other-installation',componentKey:'memory_tools',requiredCapability:2,
            discoverReachability:'shared_visible',ownershipFingerprint:observed.observedFragmentHash!,allowNeedsRecoveryPending:true,addedAt:new Date().toISOString()})
        } else f.db.prepare(`INSERT INTO reconcile_runs(id,installation_id,operation_type,execution_plan_hash,consent_envelope_id,state,recovery_strategy,
          writer_fence_snapshot_json,adapter_version,catalog_version,projection_version,selector_schema_version,prepared_plan_json,desired_capability,created_at,updated_at)
          SELECT 'other-run','other-installation',operation_type,execution_plan_hash,consent_envelope_id,'needs_recovery',recovery_strategy,
          writer_fence_snapshot_json,adapter_version,catalog_version,projection_version,selector_schema_version,prepared_plan_json,desired_capability,created_at,updated_at
          FROM reconcile_runs WHERE id=?`).run(f.old.id)
      }
      const bytes=fs.readFileSync(f.settings,'utf8'),skillBytes=fs.readFileSync(skill,'utf8'),calls=f.apply.mock.calls.length
      try {
        const result=await f.composition.service.applyConnect(preview.planHash,[f.id])
        expect(result.results[0].status).not.toBe('awaiting_verification')
        expect(f.apply).toHaveBeenCalledTimes(calls);expect(fs.readFileSync(f.settings,'utf8')).toBe(bytes)
        expect(fs.readFileSync(skill,'utf8')).toBe(skillBytes)
        expect(f.db.prepare('SELECT state FROM reconcile_runs WHERE id=?').get(f.old.id)).toEqual({state:'needs_recovery'})
        f.assertOldUntouched()
        expect(f.db.prepare('SELECT count(*) AS n FROM reconcile_runs').get()).toEqual({n:failure==='other-run-domain'?2:1})
        expect(f.db.prepare('SELECT count(*) AS n FROM projection_mutations').get()).toEqual({n:2})
        expect(f.db.prepare("SELECT count(*) AS n FROM agent_integration_events WHERE kind='completed_generation_superseded'").get()).toEqual({n:0})
        expect(f.composition.repository.getInstallation(f.id)).toMatchObject({status_reason:'conflict',reconcile_state:'paused'})
        if(failure==='other-run-domain')expect(f.db.prepare("SELECT state FROM reconcile_runs WHERE id='other-run'").get()).toEqual({state:'needs_recovery'})
        if(failure==='shared-consumer')expect(f.db.prepare("SELECT state FROM artifact_consumers WHERE installation_id='other-installation'").get()).toEqual({state:'active'})
      } finally { lock?.release() }
    } finally { f.close() }
  })
})
