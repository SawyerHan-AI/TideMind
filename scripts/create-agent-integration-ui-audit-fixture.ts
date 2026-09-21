import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { AgentIntegrationRepository } from '../client/electron/agent-integration/repository.js'
import { sha256Json } from '../client/electron/agent-integration/fingerprint.js'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from '../client/electron/agent-integration/hosts/portable-skill.js'
import { shellArgument } from '../client/electron/agent-integration/shell-argument.js'
import type { CatalogId, ComponentKey, ProductFamilyId } from '../client/electron/agent-integration/types.js'
import { uiAuditMarker } from '../client/electron/ui-audit.js'
import { ensureSchema } from '../src/db/schema.js'
import { ensureAgentIntegrationSchema } from '../src/db/agent-integration-schema.js'

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
const customFixtureRoot = path.join(dataDir, 'ui-audit-custom-client')
fs.mkdirSync(customFixtureRoot, { recursive: true })
fs.mkdirSync(path.join(dataDir, 'ui-audit-custom-root'))
fs.writeFileSync(path.join(customFixtureRoot, 'config.json'), '{}\n', { mode: 0o600 })
fs.writeFileSync(path.join(customFixtureRoot, 'audit-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
const coworkAppPath = path.join(root, 'apps', 'Claude.app')
const coworkExecutablePath = path.join(coworkAppPath, 'Contents', 'MacOS', 'Claude')
fs.mkdirSync(path.dirname(coworkExecutablePath), { recursive: true })
fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Claude'), { recursive: true })
fs.writeFileSync(coworkExecutablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
const runtimeRoot = path.join(root, 'runtime')
fs.mkdirSync(runtimeRoot)
for (const name of [
  'tm-node', 'mcp-server.cjs', 'hook-session-start.cjs', 'hook-pre-compact.cjs',
  'hook-post-compact.cjs', 'hook-session-end.cjs', 'hook-kimi-session-start-activity.cjs',
]) fs.writeFileSync(path.join(runtimeRoot, name), '// isolated UI audit fixture\n', { mode: 0o700 })

const db = new Database(path.join(graphDir, 'brain.sqlite'))
ensureSchema(db)
// The fixture must exercise the same authoritative v34 schema repair used by
// daemon, Electron fresh DBs, and migrations. Calling it explicitly also
// catches accidental omissions in the broader fresh-schema composition.
ensureAgentIntegrationSchema(db)
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

function codexLifecycleFixture(
  configRoot: string,
  agentId: string,
  runtimeRoot: string,
  activityGenerationToken: string,
) {
  const instructionPath = path.join(home, '.agents', 'skills', 'tidemind', 'SKILL.md')
  const definitions = [
    { eventName: 'SessionStart', matcher: 'startup|resume', script: 'hook-session-start.cjs', includeSkill: true },
    { eventName: 'PreCompact', matcher: 'manual|auto', script: 'hook-pre-compact.cjs', includeSkill: false },
    { eventName: 'PostCompact', matcher: 'manual|auto', script: 'hook-post-compact.cjs', includeSkill: false },
    { eventName: 'SessionEnd', matcher: 'exit|archive', script: 'hook-session-end.cjs', includeSkill: false },
  ] as const
  const entries = definitions.map(definition => {
    const args = [
      path.join(runtimeRoot, 'tm-node'), path.join(runtimeRoot, definition.script),
      '--agent-id', agentId,
      ...(definition.includeSkill ? [
        '--skill-path', instructionPath,
        '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
      ] : []),
      '--tool', 'codex',
      '--activity-generation-token', activityGenerationToken,
    ]
    return [definition.eventName, {
      matcher: definition.matcher,
      hooks: [{
        type: 'command',
        command: args.map(shellArgument).join(' '),
        ...(definition.includeSkill ? { statusMessage: '正在加载 Tide Mind 记忆…' } : {}),
        timeout: 15,
      }],
    }] as const
  })
  const fragment = Object.fromEntries(entries)
  const documentHooks = Object.fromEntries(entries.map(([eventName, entry]) => [eventName, [entry]]))
  return { document: { hooks: documentHooks }, hash: sha256Json(fragment), configRoot }
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
    profile: '迁移冲突', version: '0.41.0', desiredState: 'unmanaged', verifiedCapability: 0,
    verificationSummary: 'unverified', statusReason: null, components: [],
  },
  {
    id: 'zcode-default', family: 'zcode', hostVariant: 'zcode-desktop', displayName: 'ZCode',
    version: '0.9.4', desiredState: 'unmanaged', verifiedCapability: 0,
    verificationSummary: 'unverified', statusReason: null, components: [],
  },
  {
    id: 'qwenwork-guided', family: 'qwenwork', hostVariant: 'qwenwork-desktop', displayName: 'QwenWork',
    version: '1.6.2', desiredState: 'unmanaged', verifiedCapability: 0,
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
    profile: 'CLI', version: '0.145.0-alpha.18', desiredState: 'managed', verifiedCapability: 1,
    verificationSummary: 'verified', statusReason: 'host_confirmation',
    components: [
      { key: 'instruction', status: 'verified', shared: true },
      { key: 'lifecycle', status: 'verified' },
    ],
  },
  {
    id: 'codex-desktop', family: 'codex', hostVariant: 'codex-desktop', displayName: 'Codex',
    profile: 'Desktop', version: '26.901.31953', desiredState: 'managed', verifiedCapability: 1,
    verificationSummary: 'verified', statusReason: 'host_confirmation',
    components: [
      { key: 'instruction', status: 'verified', shared: true },
      { key: 'lifecycle', status: 'verified' },
    ],
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
  portableArtifactFingerprint: `fixture:${sha256Json({ executable: 'zcode-ui-audit' })}`,
} as const
const qwenWorkAppPath = path.join(root, 'apps', 'QwenWork.app')
const qwenWorkExecutablePath = path.join(qwenWorkAppPath, 'Contents', 'MacOS', 'QwenWork')
fs.mkdirSync(path.dirname(qwenWorkExecutablePath), { recursive: true })
fs.writeFileSync(qwenWorkExecutablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
const qwenWorkDistribution = {
  distributionId: 'cn.qwenwork.desktop.mac',
  executableRealpath: fs.realpathSync(qwenWorkExecutablePath),
  packageProvenance: 'signed_app:cn.qwenwork.desktop.mac:XN6U3EV979',
  capabilityFingerprint: 'app-surface:qwenwork-desktop',
  portableArtifactFingerprint: `fixture:${sha256Json({ executable: 'qwenwork-ui-audit' })}`,
} as const
const kimiExecutablePath = path.join(root, 'node_modules', '@moonshot-ai', 'kimi-code', 'bin', 'kimi.js')
fs.mkdirSync(path.dirname(kimiExecutablePath), { recursive: true })
fs.writeFileSync(kimiExecutablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
const kimiDistribution = {
  distributionId: 'cli:kimi-code-cli',
  executableRealpath: fs.realpathSync(kimiExecutablePath),
  packageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
  capabilityFingerprint: 'cli-surface:kimi-code-cli',
  portableArtifactFingerprint: `fixture:${sha256Json({ executable: 'kimi-code-ui-audit' })}`,
} as const

for (const fixture of fixtures) {
  const configRoot = path.join(home, `.${fixture.id}`)
  fs.mkdirSync(configRoot, { recursive: true })
  const isZcodeDesktop = fixture.hostVariant === 'zcode-desktop'
  const isQwenWork = fixture.hostVariant === 'qwenwork-desktop'
  const isKimiCode = fixture.hostVariant === 'kimi-code-cli'
  const isCodex = fixture.hostVariant === 'codex-cli' || fixture.hostVariant === 'codex-desktop'
  const codexActivityGenerationToken = isCodex ? randomUUID() : null
  if (fixture.id === 'kimi-default') {
    const legacyTarget = path.join(configRoot, 'skills', `tidemind-eb_audit_${fixture.id}`, 'SKILL.md')
    fs.mkdirSync(path.dirname(legacyTarget), { recursive: true })
    fs.writeFileSync(legacyTarget, '# user-owned legacy conflict fixture\n', { mode: 0o600 })
  }
  const distribution = isZcodeDesktop
    ? zcodeDistribution
    : isQwenWork
      ? qwenWorkDistribution
      : isKimiCode
        ? kimiDistribution
        : null
  repository.upsertDiscoveredInstallation({
    id: fixture.id,
    family: fixture.family,
    hostVariant: fixture.hostVariant,
    runtimeRealm: 'local_macos',
    osUserIdentity: 'ui-audit-user',
    profileId: fixture.profile ?? '',
    installKey: `${fixture.hostVariant}:${fixture.id}`,
    distributionId: distribution?.distributionId ?? `audit.${fixture.hostVariant}`,
    provenance: 'isolated_ui_audit_fixture',
    displayName: fixture.displayName,
    configRoot,
    executablePath: distribution?.executableRealpath ?? null,
    appPath: isZcodeDesktop ? zcodeAppPath : isQwenWork ? qwenWorkAppPath : null,
    detectedVersion: fixture.version,
    agentId: `eb_audit_${fixture.id}`,
    supportedCapability: 4,
    lastDetectedAt: iso(2),
    metadata: distribution ? {
      distribution,
      ...(isKimiCode ? {
        managementEligibility: {
          schemaVersion: 1,
          eligible: true,
          executableSizeBytes: fs.statSync(kimiExecutablePath).size,
          proofLimitBytes: 512 * 1024 * 1024,
        },
      } : {}),
      ...(isQwenWork ? {
        componentConfigRoots: { instruction: configRoot, lifecycle: configRoot },
      } : {}),
    } : undefined,
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
      : (fixture.hostVariant === 'codex-cli' || fixture.hostVariant === 'codex-desktop') && component.key === 'lifecycle'
        ? path.join(configRoot, 'hooks.json')
      : path.join(configRoot, component.key === 'instruction' ? 'skills/tidemind/SKILL.md' : 'mcp.json')
    const artifactId = component.shared ? 'artifact-shared-skill' : `artifact-${fixture.id}-${component.key}`
    const ownedFragmentHash = isCodex && component.key === 'lifecycle'
      ? codexLifecycleFixture(configRoot, `eb_audit_${fixture.id}`, runtimeRoot, codexActivityGenerationToken!).hash
      : `hash-${artifactId}`
    if (isCodex && component.key === 'lifecycle') {
      const hooks = codexLifecycleFixture(configRoot, `eb_audit_${fixture.id}`, runtimeRoot, codexActivityGenerationToken!)
      fs.writeFileSync(target, `${JSON.stringify(hooks.document, null, 2)}\n`, { mode: 0o600 })
    }
    const codexLifecycle = isCodex && component.key === 'lifecycle'
    const ownershipKey = codexLifecycle
      ? `hooks.tidemind-eb_audit_${fixture.id}`
      : component.key === 'instruction'
        ? 'document'
        : `mcpServers.tidemind-${fixture.id}`
    if (!repository.getManagedArtifact(artifactId)) repository.createManagedArtifact({
      id: artifactId,
      componentType: component.key === 'instruction' ? 'skill' : codexLifecycle ? 'hook' : 'mcp',
      targetPath: target,
      ownershipKey,
      mutationDomain: `local_macos:file:${target}:${ownershipKey}`,
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      ownedFragmentHash,
      desiredFragmentHash: ownedFragmentHash,
      observedFragmentHash: ownedFragmentHash,
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
      ownershipFingerprint: ownedFragmentHash,
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
  if (codexActivityGenerationToken) {
    const preparedPlan = {
      componentKeys: ['lifecycle'],
      activityGenerationToken: codexActivityGenerationToken,
      executionPlan: {
        activityGenerationTokenHash: sha256Json(codexActivityGenerationToken),
      },
    }
    db.prepare(`
      INSERT INTO reconcile_runs (
        id, installation_id, operation_type, execution_plan_hash, consent_envelope_id,
        state, recovery_strategy, writer_fence_snapshot_json, adapter_version,
        catalog_version, projection_version, selector_schema_version,
        prepared_plan_json, desired_capability, created_at, completed_at, updated_at
      ) VALUES (?, ?, 'connect', ?, ?, 'committed', 'readback_before_replay', '{}',
        'ui-audit-codex-lifecycle', 'ui-audit', '1', '1', ?, 4, ?, ?, ?)
    `).run(
      `fixture-generation-${fixture.id}`,
      fixture.id,
      sha256Json(preparedPlan),
      consentId,
      JSON.stringify(preparedPlan),
      iso(180),
      iso(180),
      iso(180),
    )
  }
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

// Make the completed fixture self-contained before Electron opens the same
// physical database. This is evidence hygiene, not a production migration.
db.pragma('wal_checkpoint(TRUNCATE)')
db.close()
process.stdout.write(`${root}\n`)
