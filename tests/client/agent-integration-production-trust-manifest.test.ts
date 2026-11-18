import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tidemind-trust-fixture', getVersion: () => '0.2.101', getAppPath: () => '/tmp/Tide Mind.app', isPackaged: false }, Notification: class { static isSupported() { return false } show() {} } }))
vi.mock('../../src/strategy/loader.js', () => ({ getParam: (_s: string, _p: string, fallback: number) => fallback, getPrompt: () => '', loadStrategies: () => {}, getStrategy: () => null }))
import { ensureSchema } from '../../src/db/schema'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { createProductionAgentIntegrationComposition, isProductionInstallationTrusted } from '../../client/electron/agent-integration/production-service'
import { AGENT_INTEGRATION_RELEASE_ENTRIES } from '../../client/electron/agent-integration/release-manifest'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, DESKTOP_BUNDLE_SURFACE_SCHEMA, MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery'
import type { AgentReleaseEntry, AgentReleaseDistributionIdentity } from '../../client/electron/agent-integration/release-manifest'

function discover(repository: AgentIntegrationRepository, root: string, entry: AgentReleaseEntry, distribution: AgentReleaseDistributionIdentity) {
  const appPath = distribution.channel === 'signed_app' ? path.join(root, 'Synthetic.app') : undefined
  const executablePath = appPath ? path.join(appPath, 'Contents', 'MacOS', 'Synthetic') : path.join(root, 'bin', 'synthetic')
  const receipt = entry.acceptedDistributionArtifacts.find(candidate => candidate.distributionId === distribution.distributionId && candidate.packageProvenance === distribution.packageProvenance)!
  repository.upsertDiscoveredInstallation({
    id: entry.catalogId, family: entry.catalogId.startsWith('antigravity-') ? 'antigravity' : 'fixture', hostVariant: entry.catalogId,
    installKey: 'synthetic-' + entry.catalogId, distributionId: distribution.distributionId, provenance: distribution.packageProvenance,
    displayName: entry.catalogId, osUserIdentity: 'synthetic-user', configRoot: path.join(root, '.gemini', 'config'), appPath, executablePath,
    detectedVersion: receipt.version, agentId: 'synthetic-' + entry.catalogId, supportedCapability: entry.targetCapability,
    lastDetectedAt: new Date().toISOString(), metadata: {
      managementEligibility: { schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, eligible: true, executableSizeBytes: receipt.executableSizeBytes, proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES },
      distribution: { distributionId: distribution.distributionId, executableRealpath: executablePath, packageProvenance: distribution.packageProvenance,
        capabilityFingerprint: `${appPath ? DESKTOP_BUNDLE_SURFACE_SCHEMA : entry.catalogId === 'kimi-code-native' ? 'signed-cli-kimi-receipt-lookup-v1' : 'signed-cli-surface-v1'}:${'a'.repeat(64)}`,
        portableArtifactFingerprint: receipt.portableArtifactFingerprint },
    },
  })
  return repository.getInstallation(entry.catalogId)!
}

describe('released signed distributions reach production trust', () => {
  it('keeps every released signed publisher covered by the production trust contract', () => {
    const db = new Database(':memory:'); ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    try {
      for (const entry of AGENT_INTEGRATION_RELEASE_ENTRIES.filter(value => value.releaseMode === 'production' && value.enabledByDefault)) {
        for (const distribution of entry.officialDistributions.filter(value => value.channel === 'signed_app' || value.channel === 'signed_cli')) {
          const row = discover(repository, '/synthetic-home', entry, distribution)
          expect(isProductionInstallationTrusted(row, '/synthetic-home'), `${entry.catalogId}: ${distribution.packageProvenance}`).toBe(true)
          const metadata = JSON.parse(row.metadata_json)
          metadata.distribution.packageProvenance += ':unapproved'
          expect(isProductionInstallationTrusted({ ...row, metadata_json: JSON.stringify(metadata) }, '/synthetic-home')).toBe(false)
          expect(isProductionInstallationTrusted({ ...row, health_state: 'unresolved' }, '/synthetic-home')).toBe(false)
        }
      }
    } finally { db.close() }
  })

  it('exposes both Antigravity installations as manageable without a canManageInstallation override', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-production-trust-')))
    const db = new Database(':memory:'); ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root, applicationDataDir: path.join(root, 'data'), startRuntime: false,
      runtimeContext: { runtimeRealm: 'local_macos', homeDir: root, applicationDataDir: path.join(root, 'data'),
        shimPath: path.join(root, 'shim'), mcpServerPath: path.join(root, 'mcp'), hookScriptPath: path.join(root, 'hook'),
        preCompactScriptPath: path.join(root, 'pre'), postCompactScriptPath: path.join(root, 'post'),
        tideMindVersion: '0.2.101', catalogVersion: '1', projectionVersion: '1' },
      notifications: { deliver: vi.fn() },
      automaticConnections: false, enabledAdapterIds: ['antigravity-app', 'antigravity-cli'],
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
    })
    try {
      for (const id of ['antigravity-app', 'antigravity-cli']) {
        const entry = AGENT_INTEGRATION_RELEASE_ENTRIES.find(value => value.catalogId === id)!
        discover(composition.repository, root, entry, entry.officialDistributions[0])
      }
      const installations = composition.service.snapshot().installations
      expect(installations.map(row => ({ id: row.id, manageable: row.manageable }))).toEqual(expect.arrayContaining([
        { id: 'antigravity-app', manageable: true }, { id: 'antigravity-cli', manageable: true },
      ]))
      const row = composition.repository.getInstallation('antigravity-app')!
      const metadata = JSON.parse(row.metadata_json)
      metadata.distribution.packageProvenance = 'signed_app:com.google.antigravity:NOT_GOOGLE'
      db.prepare('UPDATE agent_installations SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), row.id)
      expect(composition.service.snapshot().installations.find(value => value.id === row.id)?.manageable).toBe(false)
    } finally { composition.runtime.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }) }
  })
})
