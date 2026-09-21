import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { DiscoveredInstallation, LocalDiscoveryReport } from './agent-integration/discovery.js'
import { sha256Json } from './agent-integration/fingerprint.js'
import { createP0HostAdapters } from './agent-integration/hosts/p0-adapter-registry.js'
import type {
  CodexOfficialHookMetadata,
  CodexOfficialHooksPort,
  CodexOfficialHooksSnapshot,
} from './agent-integration/hosts/codex-lifecycle-adapter.js'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from './agent-integration/hosts/portable-skill.js'
import { readStableFileSnapshot } from './agent-integration/passive-cli-version.js'
import { shellArgument } from './agent-integration/shell-argument.js'
import type { ProductionAgentIntegrationOptions } from './agent-integration/production-service.js'
import {
  AgentIntegrationRepository,
  persistedComponentConfigRoots,
  persistedDistribution,
  persistedHostOwnedIdentity,
  persistedManagementEligibility,
  persistedProjectionSurfaceFingerprint,
  type AgentInstallationRow,
} from './agent-integration/repository.js'
import type { CatalogId, InstallationIdentity, RuntimeRealm } from './agent-integration/types.js'

const MARKER = '.tidemind-ui-audit'
const MARKER_CONTENT = 'isolated-tidemind-ui-audit-v1\n'
const MAX_UI_AUDIT_EXECUTABLE_BYTES = 1024 * 1024
const ZCODE_AUDIT_DISTRIBUTION = Object.freeze({
  distributionId: 'dev.zcode.app',
  packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
  capabilityFingerprint: 'app-surface:zcode-desktop',
})

/** Fail closed before Electron registers protocols or starts background work. */
export function resolveUiAuditRoot(environment = process.env): string | null {
  if (environment.TIDEMIND_UI_AUDIT !== '1') return null
  const rawRoot = environment.TIDEMIND_UI_AUDIT_ROOT
  if (!rawRoot || !path.isAbsolute(rawRoot)) throw new Error('UI audit root must be an absolute path')
  const lexicalRoot = path.resolve(rawRoot)
  const lexicalHome = path.join(lexicalRoot, 'home')
  const lexicalUserData = path.join(lexicalRoot, 'user-data')
  const lexicalDataDir = path.join(lexicalHome, '.tidemind')
  if (lexicalRoot === path.parse(lexicalRoot).root || lexicalRoot === os.homedir()
    || path.resolve(environment.HOME ?? '') !== lexicalHome) {
    throw new Error('UI audit HOME/root isolation invariant failed')
  }
  const rootStat = fs.lstatSync(lexicalRoot)
  const homeStat = fs.lstatSync(lexicalHome)
  const userDataStat = fs.lstatSync(lexicalUserData)
  const dataDirStat = fs.lstatSync(lexicalDataDir)
  const marker = path.join(lexicalRoot, MARKER)
  const markerStat = fs.lstatSync(marker)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !homeStat.isDirectory() || homeStat.isSymbolicLink()
    || !userDataStat.isDirectory() || userDataStat.isSymbolicLink()
    || !dataDirStat.isDirectory() || dataDirStat.isSymbolicLink()
    || !markerStat.isFile() || markerStat.isSymbolicLink()
    || fs.readFileSync(marker, 'utf8') !== MARKER_CONTENT) {
    throw new Error('UI audit marker is missing or invalid')
  }
  const root = fs.realpathSync(lexicalRoot)
  const home = fs.realpathSync(lexicalHome)
  const userData = fs.realpathSync(lexicalUserData)
  const dataDir = fs.realpathSync(lexicalDataDir)
  const relativeHome = path.relative(root, home)
  if (relativeHome !== 'home' || path.isAbsolute(relativeHome) || relativeHome.startsWith('..')) {
    throw new Error('UI audit HOME/root canonical isolation invariant failed')
  }
  const relativeUserData = path.relative(root, userData)
  if (relativeUserData !== 'user-data' || path.isAbsolute(relativeUserData) || relativeUserData.startsWith('..')) {
    throw new Error('UI audit userData/root canonical isolation invariant failed')
  }
  const relativeDataDir = path.relative(root, dataDir)
  if (relativeDataDir !== path.join('home', '.tidemind')
    || path.isAbsolute(relativeDataDir) || relativeDataDir.startsWith('..')) {
    throw new Error('UI audit dataDir/root canonical isolation invariant failed')
  }
  return root
}

/** Revalidate the exact DB directory immediately before opening SQLite. */
export function resolveUiAuditDataDir(root: string): string {
  const lexical = path.join(root, 'home', '.tidemind')
  const stat = fs.lstatSync(lexical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UI audit dataDir is not an ordinary directory')
  const canonical = fs.realpathSync(lexical)
  const relative = path.relative(root, canonical)
  if (relative !== path.join('home', '.tidemind') || path.isAbsolute(relative) || relative.startsWith('..')) {
    throw new Error('UI audit dataDir escaped isolated root')
  }
  return canonical
}

export function uiAuditMarker(): { name: string; content: string } {
  return { name: MARKER, content: MARKER_CONTENT }
}

/**
 * Replays only rows from the isolated fixture DB. It does not enumerate the
 * real machine, PATH, /Applications, credentials, or external config roots.
 */
export function createUiAuditAgentIntegrationOptions(
  db: Database.Database,
  root: string,
): ProductionAgentIntegrationOptions {
  const repository = new AgentIntegrationRepository(db)
  const auditHome = path.join(root, 'home')
  const runtimeRoot = path.join(root, 'runtime')
  const runtimeContext = {
    runtimeRealm: 'local_macos' as const,
    homeDir: auditHome,
    applicationDataDir: path.join(root, 'user-data'),
    shimPath: path.join(runtimeRoot, 'tm-node'),
    mcpServerPath: path.join(runtimeRoot, 'mcp-server.cjs'),
    hookScriptPath: path.join(runtimeRoot, 'hook-session-start.cjs'),
    preCompactScriptPath: path.join(runtimeRoot, 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(runtimeRoot, 'hook-post-compact.cjs'),
    tideMindVersion: '0.2.92',
    catalogVersion: 'ui-audit',
    projectionVersion: '1',
  }
  let codexHooksTrusted = false
  const codexHooksPort: CodexOfficialHooksPort = {
    list: async context => uiAuditCodexHooks(context, codexHooksTrusted),
    preview: async context => uiAuditCodexHooks(context, codexHooksTrusted),
  }
  return {
    homeDir: auditHome,
    applicationDataDir: path.join(root, 'user-data'),
    runtimeContext,
    adapters: createP0HostAdapters({ codexHooksPort }),
    observeOnly: false,
    autoRestore: false,
    startRuntime: false,
    fixtureMode: 'isolated_ui_audit',
    notifications: { deliver: () => undefined },
    enabledAdapterIds: [
      'codex-cli', 'codex-desktop', 'cursor-desktop', 'kimi-code-cli',
      'openclaw-local', 'qwen-code-cli', 'zcode-desktop', 'opencode-v1-cli',
      'opencode-v2-beta-cli', 'pi-official-cli', 'omp-cli', 'claude-cowork-local',
      'qwenwork-desktop',
    ],
    canManageInstallation: row => uiAuditInstallationManageable(row, root, auditHome),
    liveTrustAttestor: row => uiAuditLiveTrustProof(row, root, auditHome),
    codexHookTrustVerifier: async ({ action }) => {
      if (!pathInside(auditHome, action.sourcePath)
        || path.basename(action.sourcePath) !== 'hooks.json'
        || !action.hookKey.startsWith(`${action.sourcePath}:`)
        || !/^[a-f0-9]{64}$/u.test(action.ownedFragmentHash)
        || !/^sha256:[a-f0-9]{64}$/u.test(action.hostCurrentHash)) return null
      codexHooksTrusted = true
      return {
        trusted: true,
        sourcePath: action.sourcePath,
        hookKey: action.hookKey,
        hostCurrentHash: action.hostCurrentHash,
        hooksFileFingerprint: sha256Json({ fixture: 'hooks', actionHash: action.hostCurrentHash }),
        trustConfigFingerprint: sha256Json({ fixture: 'trust', actionHash: action.hostCurrentHash }),
      }
    },
    scanner: {
      async scan(): Promise<LocalDiscoveryReport> {
        const installations = repository.listInstallations({ includeRemoved: true })
          // Disconnecting management does not uninstall the host. Only the
          // fixture's explicit historical state removes it from discovery.
          .filter(row => row.health_state !== 'absent' && row.status_reason !== 'host_uninstalled')
          .filter(row => row.config_root !== null)
          // Custom targets and user-guided Cowork rows are deliberately not
          // rediscovered by a generic scanner. Production retains them only
          // through their exact scoped probes; mirror that boundary here so
          // the audit cannot fabricate a changed projection surface.
          .filter(row => row.host_variant !== 'custom-local-mcp'
            && row.host_variant !== 'claude-cowork-local')
          .map(row => {
            if (!pathInside(auditHome, row.config_root!)) {
              throw new Error(`UI audit fixture escaped isolated HOME: ${row.id}`)
            }
            const versionDetectionMethod: DiscoveredInstallation['versionDetectionMethod'] = row.version_detection_method === 'cli_version'
              || row.version_detection_method === 'bundle_plist'
              ? row.version_detection_method
              : undefined
            return {
              catalogId: row.host_variant as CatalogId,
              displayName: row.display_name,
              identity: {
                runtimeRealm: row.runtime_realm as RuntimeRealm,
                osUserIdentity: row.os_user_identity ?? 'ui-audit-user',
                productFamilyId: row.family as InstallationIdentity['productFamilyId'],
                hostVariant: row.host_variant as CatalogId,
                canonicalConfigRoot: row.config_root!,
                explicitProfile: row.profile_id || 'default',
                hostOwnedIdentity: persistedHostOwnedIdentity(row),
                distribution: persistedDistribution(row),
                installKey: row.install_key,
              },
              configRoot: row.config_root!,
              executablePath: row.executable_path ?? undefined,
              appPath: row.app_path ?? undefined,
              componentConfigRoots: persistedComponentConfigRoots(row),
              detectedVersion: row.detected_version ?? undefined,
              versionDetectionMethod,
              managementEligibility: persistedManagementEligibility(row) ?? undefined,
              provenance: ['isolated_ui_audit_fixture'],
              evidence: [{
                kind: 'config_root' as const,
                source: 'isolated_ui_audit_fixture',
                value: row.config_root!,
              }],
            }
          })
        return { installations, unresolved: [], diagnostics: [] }
      },
      async previewGuidedInstallation(catalogId): Promise<DiscoveredInstallation | null> {
        if (catalogId !== 'claude-cowork-local') return null
        const appPath = path.join(root, 'apps', 'Claude.app')
        const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Claude')
        const configRoot = path.join(auditHome, 'Library', 'Application Support', 'Claude')
        return {
          catalogId,
          displayName: 'Claude Cowork',
          identity: {
            runtimeRealm: 'local_macos',
            osUserIdentity: 'ui-audit-user',
            productFamilyId: 'claude-cowork',
            hostVariant: catalogId,
            canonicalConfigRoot: configRoot,
            explicitProfile: 'cowork-user-guided',
            distribution: {
              distributionId: 'com.anthropic.claudefordesktop',
              executableRealpath: executablePath,
              packageProvenance: 'signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW',
              capabilityFingerprint: `desktop-bundle-surface-v1:${'c'.repeat(64)}`,
            },
            installKey: `claude-cowork-local:ui-audit:${configRoot}`,
          },
          configRoot,
          executablePath,
          appPath,
          detectedVersion: '1.24012.1',
          versionDetectionMethod: 'bundle_plist',
          provenance: ['isolated_ui_audit_signed_app_fixture'],
          evidence: [{ kind: 'distribution', source: appPath, value: 'Q6L2SF6YDW' }],
        }
      },
    },
  }
}

function uiAuditCodexHooks(
  context: Parameters<CodexOfficialHooksPort['list']>[0],
  trusted: boolean,
): CodexOfficialHooksSnapshot {
  const sourcePath = fs.realpathSync(path.join(context.installation.canonicalConfigRoot, 'hooks.json'))
  const instructionPath = path.join(context.runtime.homeDir, '.agents', 'skills', 'tidemind', 'SKILL.md')
  const definitions = [
    { eventName: 'sessionStart', matcher: 'startup|resume', scriptPath: context.runtime.hookScriptPath, includeSkill: true },
    { eventName: 'preCompact', matcher: 'manual|auto', scriptPath: context.runtime.preCompactScriptPath, includeSkill: false },
    { eventName: 'postCompact', matcher: 'manual|auto', scriptPath: context.runtime.postCompactScriptPath, includeSkill: false },
    { eventName: 'sessionEnd', matcher: 'exit|archive', scriptPath: path.join(path.dirname(context.runtime.hookScriptPath), 'hook-session-end.cjs'), includeSkill: false },
  ] as const
  const hooks: CodexOfficialHookMetadata[] = definitions.map((definition, index) => {
    const args = [
      context.runtime.shimPath,
      definition.scriptPath,
      '--agent-id', context.agentId,
      ...(definition.includeSkill ? [
        '--skill-path', instructionPath,
        '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
      ] : []),
      '--tool', 'codex',
      ...(context.activityGenerationToken
        ? ['--activity-generation-token', context.activityGenerationToken]
        : []),
    ]
    const command = args.map(shellArgument).join(' ')
    return {
      key: `${sourcePath}:${definition.eventName}:${index}:0`,
      eventName: definition.eventName,
      handlerType: 'command',
      matcher: definition.matcher,
      command,
      timeoutSec: 15,
      statusMessage: definition.includeSkill ? '正在加载 Tide Mind 记忆…' : null,
      sourcePath,
      source: 'isolated_ui_audit_fixture',
      enabled: true,
      isManaged: true,
      currentHash: `sha256:${sha256Json({ eventName: definition.eventName, command })}`,
      trustStatus: trusted ? 'trusted' : 'untrusted',
    }
  })
  return {
    hooks,
    hooksFileFingerprint: sha256Json({ fixture: 'hooks', hooks }),
    trustConfigFingerprint: sha256Json({ fixture: 'trust', trusted }),
  }
}

async function uiAuditLiveTrustProof(
  row: AgentInstallationRow,
  root: string,
  auditHome: string,
): Promise<string | null> {
  if (!uiAuditInstallationManageable(row, root, auditHome)) return null
  if (row.host_variant !== 'zcode-desktop') {
    return sha256Json({ fixtureTrust: persistedProjectionSurfaceFingerprint(row) })
  }
  const distribution = persistedDistribution(row)
  if (!row.app_path || !distribution.executableRealpath) return null
  try {
    const appPath = path.resolve(row.app_path)
    const executablePath = path.resolve(distribution.executableRealpath)
    const appStat = fs.lstatSync(appPath)
    if (!appStat.isDirectory() || appStat.isSymbolicLink()
      || fs.realpathSync(appPath) !== appPath) return null
    const executable = await readStableFileSnapshot(executablePath, MAX_UI_AUDIT_EXECUTABLE_BYTES)
    if (!executable.executable) return null
    return sha256Json({
      channel: 'isolated_ui_audit_signed_app_fixture',
      appPath,
      executablePath,
      executableFileFingerprint: executable.fingerprint,
      distributionId: distribution.distributionId,
      packageProvenance: distribution.packageProvenance,
      capabilityFingerprint: distribution.capabilityFingerprint,
    })
  } catch {
    return null
  }
}

function uiAuditInstallationManageable(
  row: AgentInstallationRow,
  root: string,
  auditHome: string,
): boolean {
  if (row.config_root === null || !pathInside(auditHome, row.config_root)) return false
  if (row.host_variant !== 'zcode-desktop') return true

  let distribution: Record<string, unknown>
  try {
    const metadata = JSON.parse(row.metadata_json) as { distribution?: unknown }
    if (!metadata.distribution || typeof metadata.distribution !== 'object'
      || Array.isArray(metadata.distribution)) return false
    distribution = metadata.distribution as Record<string, unknown>
  } catch {
    return false
  }
  const executableRealpath = distribution.executableRealpath
  if (distribution.distributionId !== ZCODE_AUDIT_DISTRIBUTION.distributionId
    || distribution.packageProvenance !== ZCODE_AUDIT_DISTRIBUTION.packageProvenance
    || distribution.capabilityFingerprint !== ZCODE_AUDIT_DISTRIBUTION.capabilityFingerprint
    || typeof executableRealpath !== 'string'
    || row.distribution_id !== ZCODE_AUDIT_DISTRIBUTION.distributionId
    || row.executable_path !== executableRealpath
    || row.app_path === null
    || !pathInside(root, row.app_path)
    || !pathInside(row.app_path, executableRealpath)) return false
  try {
    return fs.lstatSync(executableRealpath).isFile()
      && !fs.lstatSync(executableRealpath).isSymbolicLink()
      && fs.realpathSync(executableRealpath) === executableRealpath
  } catch {
    return false
  }
}

function pathInside(root: string, candidate: string): boolean {
  // The audit root is canonicalized by resolveUiAuditRoot, while nested roots
  // such as an App bundle may still use macOS's /var -> /private/var lexical
  // alias. Canonicalize their existing ancestor without following a symlink at
  // the boundary before comparing the contained candidate.
  const canonicalRoot = canonicalizeExistingAncestor(root)
  const canonicalCandidate = canonicalizeExistingAncestor(candidate)
  const relative = path.relative(canonicalRoot, canonicalCandidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function canonicalizeExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate)
  const missing: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`UI audit path has no existing ancestor: ${candidate}`)
    missing.unshift(path.basename(current))
    current = parent
  }
  const stat = fs.lstatSync(current)
  if (stat.isSymbolicLink()) throw new Error(`UI audit path ancestor is a symlink: ${current}`)
  return path.join(fs.realpathSync(current), ...missing)
}
