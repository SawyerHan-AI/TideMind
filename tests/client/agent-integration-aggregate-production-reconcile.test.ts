import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.2.94', getAppPath: () => '/tmp/Tide Mind.app', isPackaged: false },
  Notification: class { static isSupported() { return false } show() {} } }))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import { createQwenCodeJsonAggregateAdapter, createZCodeDesktopJsonAggregateAdapter } from '../../client/electron/agent-integration/hosts/json-mcp-lifecycle-aggregate-adapter'
import { ManagedAgentReconciler } from '../../client/electron/agent-integration/reconciler'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { persistedDistribution } from '../../client/electron/agent-integration/repository'
import type { AdapterOperationContext } from '../../client/electron/agent-integration/types'
import type { ManagedReconcileCandidate } from '../../client/electron/agent-integration/coordinator-repository'

describe('aggregate JSON production reconciliation', () => {
  it.each(['qwen-code-cli', 'zcode-desktop'] as const)('%s compares the physical aggregate and preserves activation policy', async catalogId => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aggregate-production-reconcile-')))
    const configRoot = path.join(root, catalogId); fs.mkdirSync(configRoot)
    const db = new Database(':memory:'); ensureSchema(db)
    const adapter = catalogId === 'qwen-code-cli' ? createQwenCodeJsonAggregateAdapter() : createZCodeDesktopJsonAggregateAdapter()
    const ctx: AdapterOperationContext = {
      runtime: { runtimeRealm: 'local_macos', homeDir: root, applicationDataDir: path.join(root, 'app-data'),
        shimPath: '/fixture/tm-node', mcpServerPath: '/fixture/mcp.cjs', hookScriptPath: '/fixture/start.cjs',
        preCompactScriptPath: '/fixture/pre.cjs', postCompactScriptPath: '/fixture/post.cjs',
        tideMindVersion: '0.2.94', catalogVersion: 'fixture', projectionVersion: '1' },
      installation: canonicalizeInstallationIdentity({ runtimeRealm: 'local_macos', osUserIdentity: 'usr_fixture',
        productFamilyId: catalogId === 'qwen-code-cli' ? 'qwen-code' : 'zcode', hostVariant: catalogId,
        configRoot, distribution: catalogId === 'zcode-desktop' ? { distributionId: 'dev.zcode.app' } : {} }),
      installationId: 'installation', hostVersion: 'fixture', agentId: 'eb_aggregate_fixture',
      operationId: 'fixture-connect', activityGenerationToken: 'fixture-generation',
    }
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root, applicationDataDir: path.join(root, 'app-data'), runtimeContext: ctx.runtime,
      adapters: new Map([[catalogId, adapter]]), fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true, enabledAdapterIds: [catalogId],
      observeOnly: false, autoRestore: true, startRuntime: false,
    })
    try {
      // Real composite plan/apply/read-back; only discovery/trust inventory is isolated.
      const plan = await adapter.plan(ctx, { desiredCapability: 4, desiredComponents: ['memory_tools', 'lifecycle'],
        observed: await adapter.inspect(ctx), ownedArtifacts: [] })
      expect(plan.mutations).toHaveLength(1)
      const mutation = plan.mutations[0]
      await adapter.apply(ctx, mutation)
      expect(await adapter.readBack(ctx, mutation)).toMatchObject({ matchesDesired: true })
      const baseline = fs.readFileSync(mutation.physicalTarget, 'utf8')
      composition.repository.upsertDiscoveredInstallation({
        id: 'installation', family: ctx.installation.productFamilyId, hostVariant: catalogId,
        installKey: ctx.installation.installKey, provenance: 'fixture', osUserIdentity: ctx.installation.osUserIdentity,
        displayName: catalogId, configRoot, agentId: ctx.agentId, supportedCapability: 4,
        lastDetectedAt: new Date().toISOString(),
      })
      composition.repository.createManagedArtifact({ id: 'aggregate', componentType: 'mcp',
        targetPath: mutation.physicalTarget, ownershipKey: mutation.ownershipKey, mutationDomain: 'fixture-domain',
        projectionVersion: '1', selectorSchemaVersion: '1', ownedFragmentHash: mutation.desiredFragmentHash,
        desiredFragmentHash: mutation.desiredFragmentHash }, new Date().toISOString())
      for (const componentKey of ['memory_tools', 'lifecycle'] as const) composition.repository.upsertComponent({
        installationId: 'installation', componentKey, desiredState: 'managed', desiredCapability: 4,
        deliveryMode: 'managed', artifactId: 'aggregate',
      }, new Date().toISOString())
      const candidate: ManagedReconcileCandidate = { artifactId: 'aggregate', componentKey: 'memory_tools',
        componentKeys: ['memory_tools', 'lifecycle'], componentName: 'MCP and hooks', desiredCapability: 4,
        consentId: null, ownedFragmentHash: mutation.desiredFragmentHash!, desiredFragmentHash: mutation.desiredFragmentHash!,
        installation: { id: 'installation', displayName: catalogId, desiredState: 'managed', agentId: ctx.agentId,
          identity: { ...ctx.installation, distribution: persistedDistribution(composition.repository.getInstallation('installation')!) } },
        affectedConsumers: [{ installationId: 'installation', displayName: catalogId }] }
      vi.spyOn(composition.coordinatorRepository, 'listManagedReconcileCandidates').mockReturnValue([candidate])
      const reconcile = vi.spyOn(ManagedAgentReconciler.prototype, 'reconcileArtifact')
      const state = () => (db.prepare("SELECT state FROM managed_artifacts WHERE id='aggregate'").get() as { state: string }).state
      await composition.runtime.markScanCompleted()
      expect(state()).toBe('healthy')
      expect(db.prepare("SELECT count(*) AS n FROM agent_integration_events WHERE kind='artifact_drifted'").get()).toEqual({ n: 0 })
      const inspect = await adapter.inspect(ctx)
      expect(inspect.components.map(item => item.observedFragmentHash)).toEqual([mutation.desiredFragmentHash, mutation.desiredFragmentHash])
      const reset = () => {
        fs.writeFileSync(mutation.physicalTarget, baseline)
        db.prepare("UPDATE managed_artifacts SET state='healthy' WHERE id='aggregate'").run()
      }
      let current = JSON.parse(baseline); current.userPreference = 'preserve'
      fs.writeFileSync(mutation.physicalTarget, JSON.stringify(current))
      await composition.runtime.runMaintenance(); expect(state()).toBe('healthy')
      expect(JSON.parse(fs.readFileSync(mutation.physicalTarget, 'utf8')).userPreference).toBe('preserve')
      reset(); current = JSON.parse(baseline)
      const servers = catalogId === 'qwen-code-cli' ? current.mcpServers : current.mcp.servers
      servers[Object.keys(servers)[0]].command = '/user/changed'
      fs.writeFileSync(mutation.physicalTarget, JSON.stringify(current))
      const changed = fs.readFileSync(mutation.physicalTarget, 'utf8')
      await composition.runtime.runMaintenance(); expect(state()).toBe('drifted')
      expect(fs.readFileSync(mutation.physicalTarget, 'utf8')).toBe(changed)
      reset(); current = JSON.parse(baseline)
      if (catalogId === 'qwen-code-cli') delete current.mcpServers
      else delete current.mcp.servers
      fs.writeFileSync(mutation.physicalTarget, JSON.stringify(current))
      const partial = fs.readFileSync(mutation.physicalTarget, 'utf8')
      await composition.runtime.runMaintenance(); expect(state()).toBe('drifted')
      expect(fs.readFileSync(mutation.physicalTarget, 'utf8')).toBe(partial)
      reset(); current = JSON.parse(baseline)
      delete current.hooks
      fs.writeFileSync(mutation.physicalTarget, JSON.stringify(current))
      const missingHooks = fs.readFileSync(mutation.physicalTarget, 'utf8')
      await composition.runtime.runMaintenance()
      expect(['drifted', 'conflict']).toContain(state())
      expect(fs.readFileSync(mutation.physicalTarget, 'utf8')).toBe(missingHooks)
      reset(); current = JSON.parse(baseline)
      if (catalogId === 'qwen-code-cli') current.disableAllHooks = true
      else current.hooks.enabled = false
      fs.writeFileSync(mutation.physicalTarget, JSON.stringify(current))
      await composition.runtime.runMaintenance(); expect(state()).toBe('conflict')
      reset(); fs.unlinkSync(mutation.physicalTarget)
      await composition.runtime.runMaintenance()
      expect(reconcile.mock.calls.at(-1)?.[0].observation.kind).toBe('exact_missing')
      if (catalogId === 'qwen-code-cli') {
        reset(); current = JSON.parse(baseline); current.mcp = { excluded: ['*'] }
        fs.writeFileSync(mutation.physicalTarget, JSON.stringify(current))
        await composition.runtime.runMaintenance(); expect(state()).toBe('conflict')
      }
    } finally { composition.runtime.stop(); db.close(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) }
  })
})
