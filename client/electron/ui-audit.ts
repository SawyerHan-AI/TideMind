import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { DiscoveredInstallation, LocalDiscoveryReport } from './agent-integration/discovery.js'
import { sha256Json } from './agent-integration/fingerprint.js'
import { readStableFileSnapshot } from './agent-integration/passive-cli-version.js'
import type { ProductionAgentIntegrationOptions } from './agent-integration/production-service.js'
import {
  AgentIntegrationRepository,
  persistedDistribution,
  persistedHostOwnedIdentity,
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
  return {
    homeDir: auditHome,
    applicationDataDir: path.join(root, 'user-data'),
    observeOnly: false,
    autoRestore: false,
    startRuntime: false,
    fixtureMode: 'isolated_ui_audit',
    notifications: { deliver: () => undefined },
    enabledAdapterIds: [
      'codex-cli', 'codex-desktop', 'cursor-desktop', 'kimi-code-cli',
      'openclaw-local', 'qwen-code-cli', 'zcode-desktop', 'opencode-v1-cli',
      'opencode-v2-beta-cli', 'pi-official-cli', 'omp-cli',
    ],
    canManageInstallation: row => uiAuditInstallationManageable(row, root, auditHome),
    liveTrustAttestor: row => uiAuditLiveTrustProof(row, root, auditHome),
    scanner: {
      async scan(): Promise<LocalDiscoveryReport> {
        const installations = repository.listInstallations({ includeRemoved: false })
          .filter(row => row.config_root !== null)
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
              detectedVersion: row.detected_version ?? undefined,
              versionDetectionMethod,
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
    },
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
