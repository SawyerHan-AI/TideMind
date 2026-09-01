import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AgentIntegrationRepository } from '../client/electron/agent-integration/repository.js'
import type { CatalogId, ComponentKey, ProductFamilyId } from '../client/electron/agent-integration/types.js'
import { uiAuditMarker } from '../client/electron/ui-audit.js'
import { ensureSchema } from '../src/db/schema.js'

const rootArg = process.argv[2]
if (!rootArg || !path.isAbsolute(rootArg)) throw new Error('usage: tsx script <absolute-empty-audit-root>')
const lexicalRoot = path.resolve(rootArg)
const rootStat = fs.lstatSync(lexicalRoot)
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error('audit fixture root must be a real directory, not a symlink')
}
const root = fs.realpathSync(lexicalRoot)
const parent = fs.realpathSync(path.dirname(root))
const allowedTempRoots = new Set([
  fs.realpathSync(os.tmpdir()),
  fs.realpathSync('/tmp'),
])
if (!allowedTempRoots.has(parent) || !path.basename(root).startsWith('tidemind-ui-audit-')) {
  throw new Error('audit fixture root must be a direct mktemp directory under the system temp directory')
}
if (fs.readdirSync(root).length !== 0) {
  throw new Error('audit fixture root must exist and be empty')
}

const home = path.join(root, 'home')
fs.mkdirSync(path.join(root, 'user-data'))
const dataDir = path.join(home, '.tidemind')
const graphDir = path.join(dataDir, 'graph')
fs.mkdirSync(graphDir, { recursive: true })
const marker = uiAuditMarker()
fs.writeFileSync(path.join(root, marker.name), marker.content)
fs.writeFileSync(path.join(dataDir, 'config.toml'), 'onboarding_completed = true\nlanguage = "zh-CN"\n')

const db = new Database(path.join(graphDir, 'brain.sqlite'))
ensureSchema(db)
const repository = new AgentIntegrationRepository(db)
const now = new Date()
const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString()

interface FixtureInstallation {
  id: string
  family: ProductFamilyId
  hostVariant: CatalogId
  displayName: string
  profile?: string
  version: string
  desiredState: 'unmanaged' | 'managed' | 'disabled' | 'removed'
  verifiedCapability: 0 | 1 | 2 | 3 | 4
  verificationSummary: 'unverified' | 'verified' | 'stale' | 'failed' | 'mixed'
  statusReason: string | null
  components: readonly {
    key: ComponentKey
    status: 'unverified' | 'verified' | 'stale' | 'failed'
    state?: 'healthy' | 'conflict' | 'missing'
    shared?: boolean
  }[]
}

const fixtures: readonly FixtureInstallation[] = [
  {
    id: 'cursor-work', family: 'cursor', hostVariant: 'cursor-desktop', displayName: 'Cursor',
    profile: '工作', version: '1.7.2', desiredState: 'managed', verifiedCapability: 3,
    verificationSummary: 'verified', statusReason: 'verified',
    components: [
      { key: 'instruction', status: 'verified' },
      { key: 'memory_tools', status: 'verified' },
    ],
  },
  {
    id: 'kimi-default', family: 'kimi-code', hostVariant: 'kimi-code-cli', displayName: 'Kimi Code',
    version: '1.16.0', desiredState: 'managed', verifiedCapability: 2,
    verificationSummary: 'stale', statusReason: 'verification_stale',
    components: [
      { key: 'instruction', status: 'verified' },
      { key: 'memory_tools', status: 'stale' },
    ],
  },
  {
    id: 'zcode-default', family: 'zcode', hostVariant: 'zcode-desktop', displayName: 'ZCode',
    version: '0.9.4', desiredState: 'unmanaged', verifiedCapability: 0,
    verificationSummary: 'unverified', statusReason: null, components: [],
  },
  {
    id: 'opencode-conflict', family: 'opencode', hostVariant: 'opencode-v1-cli', displayName: 'OpenCode',
    version: '1.3.8', desiredState: 'managed', verifiedCapability: 1,
    verificationSummary: 'failed', statusReason: 'conflict',
    components: [
      { key: 'instruction', status: 'verified', shared: true },
      { key: 'memory_tools', status: 'failed', state: 'conflict' },
    ],
  },
  {
    id: 'codex-cli', family: 'codex', hostVariant: 'codex-cli', displayName: 'Codex',
    profile: 'CLI', version: '0.94.0', desiredState: 'managed', verifiedCapability: 1,
    verificationSummary: 'verified', statusReason: 'instruction_only',
    components: [{ key: 'instruction', status: 'verified', shared: true }],
  },
  {
    id: 'codex-desktop', family: 'codex', hostVariant: 'codex-desktop', displayName: 'Codex',
    profile: 'Desktop', version: '1.12.3', desiredState: 'disabled', verifiedCapability: 1,
    verificationSummary: 'verified', statusReason: 'user_disabled',
    components: [{ key: 'instruction', status: 'verified', shared: true }],
  },
  {
    id: 'claude-history', family: 'claude-code', hostVariant: 'claude-code-cli', displayName: 'Claude Code',
    profile: '已卸载', version: '2.1.0', desiredState: 'removed', verifiedCapability: 3,
    verificationSummary: 'verified', statusReason: 'host_uninstalled',
    components: [
      { key: 'instruction', status: 'verified' },
      { key: 'memory_tools', status: 'verified' },
    ],
  },
]

// ZCode Desktop is a strong-identity host. The isolated scanner replays the
// persisted distribution evidence, so the fixture must contain the same four
// identity fields that a real signed bundle probe would produce. Keep the
// executable inside the audit root; no real /Applications bundle is read.
const zcodeAppPath = path.join(root, 'apps', 'ZCode.app')
const zcodeExecutablePath = path.join(zcodeAppPath, 'Contents', 'MacOS', 'ZCode')
fs.mkdirSync(path.dirname(zcodeExecutablePath), { recursive: true })
fs.writeFileSync(zcodeExecutablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
const zcodeDistribution = {
  distributionId: 'dev.zcode.app',
  executableRealpath: fs.realpathSync(zcodeExecutablePath),
  packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
  capabilityFingerprint: 'app-surface:zcode-desktop',
} as const

for (const fixture of fixtures) {
  const configRoot = path.join(home, `.${fixture.id}`)
  fs.mkdirSync(configRoot, { recursive: true })
  const isZcodeDesktop = fixture.hostVariant === 'zcode-desktop'
  repository.upsertDiscoveredInstallation({
    id: fixture.id,
    family: fixture.family,
    hostVariant: fixture.hostVariant,
    runtimeRealm: 'local_macos',
    profileId: fixture.profile ?? '',
    installKey: `${fixture.hostVariant}:${fixture.id}`,
    distributionId: isZcodeDesktop ? zcodeDistribution.distributionId : `audit.${fixture.hostVariant}`,
    provenance: 'isolated_ui_audit_fixture',
    displayName: fixture.displayName,
    configRoot,
    executablePath: isZcodeDesktop ? zcodeDistribution.executableRealpath : null,
    appPath: isZcodeDesktop ? zcodeAppPath : null,
    detectedVersion: fixture.version,
    agentId: `eb_audit_${fixture.id}`,
    supportedCapability: 4,
    lastDetectedAt: iso(2),
    metadata: isZcodeDesktop ? { distribution: zcodeDistribution } : undefined,
  })
  const consentId = `consent-${fixture.id}`
  if (fixture.desiredState !== 'unmanaged') {
    repository.createConsent({
      id: consentId,
      installationId: fixture.id,
      policyVersion: 'ui-audit-v1',
      allowedComponents: fixture.components.map(component => component.key),
      allowedScopes: [configRoot],
      normalizedTargets: fixture.components.map(component => path.join(configRoot, component.key)),
      selectorSchemaVersion: '1',
      selectorResolution: {},
      executableRealpaths: [],
      commandCategories: ['file_write'],
      maximumRisk: 'low',
      confirmedAt: iso(180),
    })
  }
  for (const component of fixture.components) {
    const sharedTarget = path.join(home, '.agents', 'skills', 'tidemind', 'SKILL.md')
    const target = component.shared
      ? sharedTarget
      : path.join(configRoot, component.key === 'instruction' ? 'skills/tidemind/SKILL.md' : 'mcp.json')
    const artifactId = component.shared ? 'artifact-shared-skill' : `artifact-${fixture.id}-${component.key}`
    if (!repository.getManagedArtifact(artifactId)) repository.createManagedArtifact({
      id: artifactId,
      componentType: component.key === 'instruction' ? 'skill' : 'mcp',
      targetPath: target,
      ownershipKey: component.key === 'instruction' ? 'document' : `mcpServers.tidemind-${fixture.id}`,
      mutationDomain: `local_macos:file:${target}:document`,
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      ownedFragmentHash: `hash-${artifactId}`,
      desiredFragmentHash: `hash-${artifactId}`,
      observedFragmentHash: `hash-${artifactId}`,
      state: 'healthy',
    }, iso(180))
    repository.upsertComponent({
      installationId: fixture.id,
      componentKey: component.key,
      desiredState: fixture.desiredState === 'disabled' ? 'disabled' : 'managed',
      desiredCapability: fixture.verifiedCapability,
      deliveryMode: 'managed',
      verificationStatus: component.status,
      artifactId,
      visibilityState: component.shared ? 'shared_visible' : 'dedicated',
      consentEnvelopeId: fixture.desiredState === 'unmanaged' ? null : consentId,
    }, iso(5))
    repository.addArtifactConsumer({
      artifactId,
      installationId: fixture.id,
      componentKey: component.key,
      requiredCapability: fixture.verifiedCapability,
      discoverReachability: component.shared ? 'shared_visible' : 'dedicated',
      consentEnvelopeId: fixture.desiredState === 'unmanaged' ? null : consentId,
      ownershipFingerprint: `hash-${artifactId}`,
      addedAt: iso(180),
    })
    if (component.state && component.state !== 'healthy') {
      db.prepare(`UPDATE managed_artifacts SET state = ?, updated_at = ? WHERE id = ?`)
        .run(component.state, iso(5), artifactId)
    }
  }
  db.prepare(`
    UPDATE agent_installations
    SET desired_state = ?, consent_envelope_id = ?, consented_at = ?,
        desired_capability = ?, verified_capability = ?,
        delivery_summary = 'fully_managed', verification_summary = ?,
        health_state = ?, status_reason = ?,
        reconcile_state = ?, last_verified_at = ?, last_repaired_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    fixture.desiredState,
    fixture.desiredState === 'unmanaged' ? null : consentId,
    fixture.desiredState === 'unmanaged' ? null : iso(180),
    fixture.desiredState === 'unmanaged' ? 0 : fixture.verifiedCapability,
    fixture.verifiedCapability,
    fixture.verificationSummary,
    fixture.desiredState === 'removed' ? 'absent' : 'discovered',
    fixture.statusReason,
    fixture.desiredState === 'disabled' ? 'paused' : 'idle',
    fixture.verifiedCapability > 0 ? iso(5) : null,
    fixture.id === 'cursor-work' ? iso(70) : null,
    iso(2),
    fixture.id,
  )
}

repository.recordEvent({
  installationId: 'cursor-work', kind: 'artifact_auto_restored', severity: 'info',
  dedupeKey: 'audit-restored', payload: { component: 'memory_tools' }, createdAt: iso(70),
})
repository.recordEvent({
  installationId: 'opencode-conflict', kind: 'legacy_connection_needs_confirmation', severity: 'warning',
  dedupeKey: 'audit-conflict', payload: { reason: 'selector occupied' }, createdAt: iso(15),
})

// Simulate a process exit after a durable batch was accepted but before its
// either item started. Production startup must mark both exact items
// interrupted; the renderer may offer a fresh preview only for the still-live,
// manageable ZCode Installation, never the uninstalled history fixture.
repository.createApplyTask({
  id: 'audit-interrupted-restart-task',
  planHash: 'audit-old-plan-must-not-replay',
  startedAt: iso(12),
  items: [
    { installationId: 'zcode-default', executionPlanHash: 'audit-old-execution-plan' },
    { installationId: 'claude-history', executionPlanHash: 'audit-uninstalled-execution-plan' },
  ],
})

db.close()
process.stdout.write(`${root}\n`)
