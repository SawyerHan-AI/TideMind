import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-test-app-data',
    getVersion: () => '0.2.89-test',
    getAppPath: () => '/tmp/tidemind-test-app',
    isPackaged: false,
  },
  Notification: class {
    static isSupported() { return false }
    show() {}
  },
}))
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  bindAgentIntegrationExecutionPort,
  createProductionAgentHostMetadataEvidenceRuntime,
  createProductionAgentIntegrationComposition,
  createProductionAgentIntegrationService,
  createProductionLiveTrustAttestor,
  discoveryEnvironment,
  findExecutableForAgentDiscovery,
  findExecutablesForAgentDiscovery,
  inspectMacAppSignature,
  inspectMacAppSignatureSync,
  productionAgentDiscoveryExecutableDirectories,
  productionAgentIntegrationWriterLockDirectory,
  startProductionAgentIntegrationRuntime,
  stopProductionAgentIntegrationRuntime,
} from '../../client/electron/agent-integration/production-service'
import {
  inspectPassiveCliVersion,
  kimiNativeExecutablePortableArtifactFingerprint,
  normalizedQwenLauncherBytes,
  readStableFileFingerprint,
  readStableFileMetadata,
  readStableFileSnapshot,
  readStablePackageTree,
  verifyStablePackageTree,
} from '../../client/electron/agent-integration/passive-cli-version'
import {
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  DESKTOP_BUNDLE_SURFACE_SCHEMA,
  discoverLocalP0Agents,
  inspectStableDesktopBundleSurface,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  signedCodePortableArtifactFingerprint,
  signedKimiPortableArtifactFingerprint,
} from '../../client/electron/agent-integration/discovery'
import type { DiscoveredInstallation, DiscoveryDependencies } from '../../client/electron/agent-integration/discovery'
import type { CoordinatorInstallation } from '../../client/electron/agent-integration/coordinator'
import type { ManagedReconcileCandidate } from '../../client/electron/agent-integration/coordinator-repository'
import type { AgentHostAdapter, AdapterRuntimeContext, CatalogId } from '../../client/electron/agent-integration/types'
import {
  AgentIntegrationRepository,
  persistedComponentConfigFiles,
  persistedComponentConfigRoots,
  persistedDistribution,
  persistedHostOwnedIdentity,
} from '../../client/electron/agent-integration/repository'
import { ensureSchema } from '../../src/db/schema.js'
import { createUiAuditAgentIntegrationOptions } from '../../client/electron/ui-audit'
import { createCustomLocalMcpHostAdapter } from '../../client/electron/agent-integration/hosts/custom-local-mcp-adapter'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { recordHostActivityEvidence } from '../../src/db/agent-host-activity'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import { kimiNativeReceiptLookupFingerprint } from '../../client/electron/agent-integration/distribution-artifact'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import {
  AGENT_INTEGRATION_RELEASE_ENTRY_MAP,
  agentReleaseEligibilityReason,
} from '../../client/electron/agent-integration/release-manifest'

function runtimeContext(root: string): AdapterRuntimeContext {
  return {
    runtimeRealm: 'local_macos',
    homeDir: root,
    applicationDataDir: path.join(root, 'app-data'),
    shimPath: path.join(root, 'bin', 'tm-node'),
    mcpServerPath: path.join(root, 'bin', 'mcp-server.cjs'),
    hookScriptPath: path.join(root, 'bin', 'session.cjs'),
    preCompactScriptPath: path.join(root, 'bin', 'pre.cjs'),
    postCompactScriptPath: path.join(root, 'bin', 'post.cjs'),
    tideMindVersion: 'test',
    catalogVersion: '1.0.0',
    projectionVersion: '1',
  }
}

function freshCliManagementEligibility(executableSizeBytes = 1_024) {
  return {
    schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
    eligible: true,
    executableSizeBytes,
    proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
  } as const
}

function zcodeSignature(overrides: Partial<{
  teamIdentifier: string
  cdHash: string
  designatedRequirement: string
}> = {}) {
  return {
    valid: true,
    identifier: 'dev.zcode.app',
    teamIdentifier: overrides.teamIdentifier ?? '8A5X4JJ39T',
    cdHash: overrides.cdHash ?? '0123456789abcdef0123456789abcdef01234567',
    designatedRequirement: overrides.designatedRequirement
      ?? 'identifier "dev.zcode.app" and anchor apple generic',
    verificationBoundary: 'strict_final' as const,
  }
}

function adapter(root: string, catalogId: CatalogId = 'cursor-desktop') {
  let live: string | null = null
  const apply = vi.fn(async (_context, mutation) => {
    live = mutation.operation === 'remove' ? null : 'desired'
    return { operationId: mutation.operationId, effectObserved: true, postEffectFingerprint: live ?? undefined }
  })
  const inspect = vi.fn(async () => ({
    catalogId,
    detected: true,
    distribution: { distributionId: 'cursor' },
    components: [{
      componentKey: 'memory_tools' as const,
      visibility: live === null ? 'absent' as const : 'dedicated' as const,
      verificationStatus: 'unverified' as const,
      observedFragmentHash: live ?? undefined,
    }],
    provenance: ['fixture'],
    diagnostics: [],
  }))
  const host: AgentHostAdapter = {
    catalogId,
    adapterVersion: '1',
    componentKeys: ['memory_tools'],
    implementationTypes: { memory_tools: ['mcp'] },
    inspect,
    plan: async (context) => ({
      catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: '1',
      projectionVersion: '1',
      mutations: [{
        operationId: 'create-memory',
        componentKey: 'memory_tools',
        operation: 'create',
        domainKind: 'file_fragment',
        physicalTarget: path.join(root, '.cursor', 'mcp.json'),
        ownershipKey: 'mcpServers.tidemind',
        selectorSchemaVersion: 1,
        risk: 'low',
        reload: 'new_session',
        desiredFragmentHash: 'desired',
        idempotent: true,
      }],
      requiredUserActions: [],
      diagnostics: [],
    }),
    apply,
    readBack: async (_context, mutation) => ({
      operationId: mutation.operationId,
      observed: live !== null,
      matchesDesired: live === 'desired',
      observedFragmentHash: live ?? undefined,
      visibility: live === null ? 'absent' : 'dedicated',
      diagnostics: [],
    }),
    disconnect: async context => ({
      catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: '1',
      projectionVersion: '1',
      mutations: [],
      requiredUserActions: [],
      diagnostics: [],
    }),
    verify: async () => [{
      componentKey: 'memory_tools',
      status: 'unverified',
      verifiedCapability: null,
      invalidationKeys: ['host_recognition_missing'],
      diagnostics: ['host recognition probe is not implemented'],
    }],
  }
  return { host, apply, inspect }
}

function physicalDiscoveryFileSystem(): DiscoveryDependencies['fs'] {
  return {
    async lstat(targetPath) {
      try {
        const stat = fs.lstatSync(targetPath)
        return {
          kind: stat.isSymbolicLink()
            ? 'symbolic_link'
            : stat.isFile()
              ? 'file'
              : stat.isDirectory()
                ? 'directory'
                : 'other',
          mode: stat.mode & 0o7777,
          ownerUid: String(stat.uid),
          groupGid: String(stat.gid),
        }
      } catch { return undefined }
    },
    realpath: async targetPath => fs.realpathSync(targetPath),
    readTextFile: async (targetPath, maxBytes) => fs.readFileSync(targetPath).subarray(0, maxBytes).toString('utf8'),
    readStableFileSnapshot,
    readStableFileFingerprint,
    readStableFileMetadata,
    readStablePackageTree,
    verifyStablePackageTree,
  }
}

function cliPostMetadataBarrierFixture(kind: 'npm' | 'qwen') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agent-cli-final-cas-${kind}-`)))
  const home = path.join(root, 'home')
  const appData = path.join(root, 'app-data')
  const catalogId = kind === 'npm' ? 'codex-cli' as const : 'qwen-code-cli' as const
  const packageName = kind === 'npm' ? '@openai/codex' : '@qwen-code/qwen-code'
  const executable = kind === 'npm'
    ? path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : path.join(home, '.local', 'bin', 'qwen')
  const target = kind === 'npm'
    ? executable
    : path.join(home, '.local', 'lib', 'cli-entry.js')
  const packageJson = kind === 'npm'
    ? path.join(root, 'node_modules', '@openai', 'codex', 'package.json')
    : path.join(home, '.local', 'package.json')
  const qwenPackageRoot = kind === 'qwen' ? path.join(home, '.local') : undefined
  const configRoot = kind === 'npm' ? path.join(home, '.codex') : path.join(home, '.qwen')
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 })
  fs.mkdirSync(appData, { recursive: true, mode: 0o700 })
  if (kind === 'qwen') {
    fs.writeFileSync(executable, normalizedQwenLauncherBytes(), { mode: 0o700 })
    fs.mkdirSync(path.join(qwenPackageRoot!, 'lib'), { recursive: true })
    fs.mkdirSync(path.join(qwenPackageRoot!, 'node', 'bin'), { recursive: true })
    fs.writeFileSync(target, 'export async function main() {}\n')
    fs.writeFileSync(path.join(qwenPackageRoot!, 'node', 'bin', 'node'), 'official-node-runtime', { mode: 0o700 })
    fs.writeFileSync(path.join(qwenPackageRoot!, 'manifest.json'), JSON.stringify({
      name: packageName,
      version: '1.2.3',
      target: `darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}`,
      runtime: 'node',
      nodeArchive: `node-v22.0.0-darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}.tar.gz`,
    }))
  } else {
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
  }
  fs.writeFileSync(packageJson, JSON.stringify({ name: packageName, version: '1.2.3' }), { mode: 0o600 })
  const fileSystem = {
    ...physicalDiscoveryFileSystem(),
    readStableFileSnapshot,
    readStableFileFingerprint,
    readStableFileMetadata,
  }
  let armed = false
  let armedMetadataCalls = 0
  const mutateLastProofNode = () => {
    const pathToReplace = kind === 'npm' ? packageJson : target
    const replacement = `${pathToReplace}.replacement`
    fs.writeFileSync(
      replacement,
      kind === 'npm'
        ? JSON.stringify({ name: packageName, version: '9.9.9' })
        : '#!/usr/bin/env sh\necho replaced-after-second-metadata\n',
      { mode: kind === 'npm' ? 0o600 : 0o700 },
    )
    fs.renameSync(replacement, pathToReplace)
  }
  const discoveryDependencies: DiscoveryDependencies = {
    fs: fileSystem,
    which: async () => undefined,
    execVersion: async targetPath => {
      const result = await inspectPassiveCliVersion(targetPath, fileSystem)
      if (armed) {
        armedMetadataCalls += 1
        // Owned-package surfaces are read once and finish with a synchronous
        // exact-tree CAS. Legacy manifest-only npm fixtures retain the older
        // two-read barrier. Mutate after the relevant completed metadata read,
        // never by relying on an unrelated internal package-tree call count.
        if ((kind === 'qwen' && armedMetadataCalls === 1)
          || (kind === 'npm' && armedMetadataCalls === 2)) {
          armed = false
          mutateLastProofNode()
        }
      }
      return result
    },
  }
  const db = new Database(':memory:')
  ensureSchema(db)
  const fake = adapter(home, catalogId)
  const composition = createProductionAgentIntegrationComposition(db, {
    homeDir: home,
    applicationDataDir: appData,
    runtimeContext: runtimeContext(home),
    adapters: new Map([[catalogId, fake.host]]),
    enabledAdapterIds: [catalogId],
    observeOnly: false,
    autoRestore: false,
    startRuntime: false,
    notifications: { deliver: vi.fn() },
    fixtureMode: 'isolated_ui_audit',
    discoveryDependencies,
  })
  composition.repository.upsertDiscoveredInstallation({
    id: `${catalogId}-final-cas`,
    family: kind === 'npm' ? 'codex' : 'qwen-code',
    hostVariant: catalogId,
    installKey: `${catalogId}:final-cas`,
    distributionId: `cli:${catalogId}`,
    provenance: 'fixture',
    osUserIdentity: 'usr_fixture_1234',
    displayName: catalogId,
    configRoot,
    executablePath: executable,
    agentId: `agent-${catalogId}-final-cas`,
    supportedCapability: 3,
    lastDetectedAt: '2026-08-26T00:00:00.000Z',
    metadata: {
      managementEligibility: freshCliManagementEligibility(fs.statSync(executable).size),
      distribution: {
        distributionId: `cli:${catalogId}`,
        executableRealpath: executable,
        packageProvenance: `npm_metadata:${packageName}`,
      },
    },
  })
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  return {
    root,
    db,
    fake,
    composition,
    installationId: `${catalogId}-final-cas`,
    arm() {
      armed = true
      armedMetadataCalls = 0
    },
    close() {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

async function desktopPostFinalReceiptBarrierFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-final-sync-')))
  const home = path.join(root, 'home')
  const appData = path.join(root, 'app-data')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  const db = new Database(':memory:')
  ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  await discoverUiAuditZcode(repository, root)
  const appPath = path.join(root, 'apps', 'ZCode.app')
  const nestedTarget = path.join(appPath, 'Contents', 'Resources', 'app.asar')
  fs.mkdirSync(path.dirname(nestedTarget), { recursive: true })
  const signedContent = Buffer.from('signed-nested-content')
  fs.writeFileSync(nestedTarget, signedContent)
  let armed = false
  const discoveryDependencies: DiscoveryDependencies = {
    fs: physicalDiscoveryFileSystem(),
    which: async () => undefined,
    execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
    inspectAppSignature: async (_targetPath, options) => {
      await options.beforeFinalVerification?.()
      if (armed) {
        armed = false
        // This models a mutation queued after the awaited receipt verifier has
        // resolved but before its caller can resume. The production-owned
        // synchronous codesign boundary below must observe it.
        queueMicrotask(() => fs.writeFileSync(nestedTarget, 'post-final-receipt-tamper'))
      }
      return zcodeSignature()
    },
    finalVerifyAppSignatureSync: () => {
      if (!fs.readFileSync(nestedTarget).equals(signedContent)) {
        throw new Error('code object is not signed at all')
      }
      return zcodeSignature()
    },
  }
  const fake = adapter(home, 'zcode-desktop')
  const composition = createProductionAgentIntegrationComposition(db, {
    homeDir: home,
    applicationDataDir: appData,
    runtimeContext: runtimeContext(home),
    adapters: new Map([['zcode-desktop', fake.host]]),
    enabledAdapterIds: ['zcode-desktop'],
    observeOnly: false,
    autoRestore: false,
    startRuntime: false,
    notifications: { deliver: vi.fn() },
    fixtureMode: 'isolated_ui_audit',
    discoveryDependencies,
  })
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  return {
    root,
    db,
    fake,
    composition,
    installationId: 'zcode-ui-proof',
    arm() { armed = true },
    close() {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

async function discoverUiAuditZcode(
  repository: AgentIntegrationRepository,
  root: string,
  capabilityFingerprint?: string,
): Promise<string> {
  const home = path.join(root, 'home')
  const configRoot = path.join(home, '.zcode-default')
  const appPath = path.join(root, 'apps', 'ZCode.app')
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'ZCode')
  fs.mkdirSync(configRoot, { recursive: true })
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), [
    '<plist><dict>',
    '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
    '<key>CFBundleShortVersionString</key><string>1.0.0</string>',
    '<key>CFBundleExecutable</key><string>ZCode</string>',
    '</dict></plist>',
  ].join(''))
  const canonicalAppPath = fs.realpathSync(appPath)
  const canonicalExecutable = fs.realpathSync(executablePath)
  const surface = await inspectStableDesktopBundleSurface({
    fs: physicalDiscoveryFileSystem(),
    which: async () => undefined,
    execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
  }, canonicalAppPath, 2_000)
  repository.upsertDiscoveredInstallation({
    id: 'zcode-ui-proof', family: 'zcode', hostVariant: 'zcode-desktop',
    runtimeRealm: 'local_macos', profileId: 'default',
    installKey: 'zcode-desktop:ui-proof', distributionId: 'dev.zcode.app',
    provenance: 'isolated_ui_audit_fixture', displayName: 'ZCode',
    configRoot, executablePath: canonicalExecutable, appPath: canonicalAppPath,
    agentId: 'agent-zcode-ui-proof', supportedCapability: 3,
    lastDetectedAt: '2026-08-26T00:00:00.000Z',
    metadata: { distribution: {
      distributionId: 'dev.zcode.app',
      executableRealpath: canonicalExecutable,
      packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
      capabilityFingerprint: capabilityFingerprint
        ?? `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:${surface.fingerprint}`,
    } },
  })
  return canonicalExecutable
}

describe('production Agent Integration writer lock scope', () => {
  it('is stable across product data directories while UI audit remains in its temporary HOME', () => {
    const stable = productionAgentIntegrationWriterLockDirectory({
      homeDir: '/Users/shared-user',
      applicationDataDir: '/tmp/stable-data',
    })
    const beta = productionAgentIntegrationWriterLockDirectory({
      homeDir: '/Users/shared-user',
      applicationDataDir: '/tmp/beta-data',
    })
    expect(stable).toBe(beta)
    expect(stable).toBe('/Users/shared-user/.tidemind/agent-integration/writer-locks')

    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-audit-home-'))
    try {
      expect(productionAgentIntegrationWriterLockDirectory({
        fixtureMode: 'isolated_ui_audit',
        homeDir: auditHome,
        applicationDataDir: path.join(auditHome, 'app-data'),
      })).toBe(path.join(auditHome, '.tidemind', 'agent-integration', 'writer-locks'))
    } finally {
      fs.rmSync(auditHome, { recursive: true, force: true })
    }
  })
})

describe('production Agent Integration discovery environment', () => {
  it('passes only reviewed official config-root overrides to passive discovery', () => {
    const names = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']
    try {
      for (const name of names) vi.stubEnv(name, `/Users/fixture/${name}`)
      vi.stubEnv('UNRELATED_SECRET_FOR_TEST', 'never-copy')
      const environment = discoveryEnvironment()
      for (const name of names) expect(environment[name]).toBe(`/Users/fixture/${name}`)
      expect(environment).not.toHaveProperty('UNRELATED_SECRET_FOR_TEST')
    } finally { vi.unstubAllEnvs() }
  })
  it('adds deterministic GUI-safe executable roots without starting a login shell', () => {
    expect(productionAgentDiscoveryExecutableDirectories('/Users/fixture', '/usr/bin:/bin')).toEqual([
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/local/bin',
      '/Users/fixture/.local/bin',
      '/Users/fixture/.openclaw/bin',
      '/Users/fixture/.kimi-code/bin',
      '/Users/fixture/.volta/bin',
      '/Users/fixture/.bun/bin',
      '/Users/fixture/Library/pnpm',
      '/Users/fixture/.npm-global/bin',
      '/Users/fixture/.local/share/fnm/aliases/default/bin',
      '/Users/fixture/.fnm/aliases/default/bin',
      '/Users/fixture/Library/Application Support/fnm/aliases/default/bin',
      '/Users/fixture/.config/yarn/global/node_modules/.bin',
      '/Users/fixture/.yarn/bin',
    ])
    expect(productionAgentDiscoveryExecutableDirectories(
      '/Users/fixture',
      '/usr/bin',
      { OPENCLAW_PREFIX: '~/Tools/openclaw' },
    )).toContain('/Users/fixture/Tools/openclaw/bin')
    expect(productionAgentDiscoveryExecutableDirectories(
      '/Users/fixture',
      '/usr/bin',
      { OPENCLAW_PREFIX: 'relative/openclaw' },
    )).not.toContain('relative/openclaw/bin')
  })

  it('finds bounded official version-manager npm roots under a Finder-minimal PATH', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-version-managers-')))
    const home = path.join(root, 'home')
    const shadowBin = path.join(root, 'shadow-bin')
    const expectedBins = [
      path.join(home, '.nvm', 'versions', 'node', 'v22.18.0', 'bin'),
      path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v22.18.0', 'installation', 'bin'),
      path.join(home, '.asdf', 'installs', 'nodejs', '22.18.0', 'bin'),
      path.join(home, '.local', 'share', 'mise', 'installs', 'node', '22.18.0', 'bin'),
      path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
    ]
    try {
      fs.mkdirSync(shadowBin, { recursive: true })
      for (const bin of expectedBins) fs.mkdirSync(bin, { recursive: true })
      const shadow = path.join(shadowBin, 'qwen')
      const official = path.join(expectedBins[0], 'qwen')
      fs.writeFileSync(shadow, '#!/bin/sh\n', { mode: 0o700 })
      fs.writeFileSync(official, '#!/bin/sh\n', { mode: 0o700 })

      const directories = productionAgentDiscoveryExecutableDirectories(
        home,
        `${shadowBin}:/usr/bin:/bin`,
        {},
      )
      expect(directories).toEqual(expect.arrayContaining(expectedBins))
      expect(await findExecutablesForAgentDiscovery('qwen', directories)).toEqual([
        shadow,
        official,
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed instead of partially reading an oversized version-manager registry', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-version-bound-')))
    const home = path.join(root, 'home')
    const versions = path.join(home, '.nvm', 'versions', 'node')
    try {
      for (let index = 0; index < 65; index += 1) {
        fs.mkdirSync(path.join(versions, `v22.18.${index}`, 'bin'), { recursive: true })
      }
      expect(productionAgentDiscoveryExecutableDirectories(home, '/usr/bin'))
        .not.toContain(path.join(versions, 'v22.18.0', 'bin'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves the official OpenClaw PATH symlink for production topology verification', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-openclaw-path-')))
    const home = path.join(root, 'home')
    const openClawRoot = path.join(home, '.openclaw')
    const alias = path.join(home, '.local', 'bin', 'openclaw')
    const wrapper = path.join(openClawRoot, 'bin', 'openclaw')
    const toolchain = path.join(openClawRoot, 'tools', 'node-v24.19.0')
    const node = path.join(toolchain, 'bin', 'node')
    const entry = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'dist', 'entry.js')
    const packageJson = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'package.json')
    fs.mkdirSync(path.dirname(alias), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(wrapper), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(node), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 })
    fs.symlinkSync(wrapper, alias)
    fs.symlinkSync(toolchain, path.join(openClawRoot, 'tools', 'node'))
    fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nset -euo pipefail\nexec "${path.join(openClawRoot, 'tools', 'node', 'bin', 'node')}" "${entry}" "$@"\n`, { mode: 0o700 })
    fs.writeFileSync(node, 'official-node-runtime', { mode: 0o700 })
    fs.writeFileSync(entry, 'export async function main() {}\n', { mode: 0o600 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: 'openclaw', version: '2026.8.1', type: 'module', bin: { openclaw: 'openclaw.mjs' } }), { mode: 0o600 })
    try {
      const found = await findExecutableForAgentDiscovery(
        'openclaw',
        productionAgentDiscoveryExecutableDirectories(home, ''),
      )
      expect(found).toBe(alias)
      expect(fs.realpathSync(found!)).toBe(wrapper)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes the official OMP config and profile variables into the production scanner', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-omp-profile-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const executable = path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js')
    const packageJson = path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(packageJson, JSON.stringify({
      name: '@oh-my-pi/pi-coding-agent',
      version: '18.0.5',
    }), { mode: 0o600 })
    const fileSystem = {
      lstat: async (targetPath: string) => {
        try {
          const stat = fs.lstatSync(targetPath)
          return {
            kind: stat.isSymbolicLink()
              ? 'symbolic_link' as const
              : stat.isFile()
                ? 'file' as const
                : stat.isDirectory()
                  ? 'directory' as const
                  : 'other' as const,
          }
        } catch { return undefined }
      },
      realpath: async (targetPath: string) => fs.realpathSync(targetPath),
      readTextFile: async (targetPath: string, maxBytes: number) => fs.readFileSync(targetPath, 'utf8').slice(0, maxBytes),
      readStableFileSnapshot,
      readStableFileFingerprint,
      readStableFileMetadata,
    }
    const previous = {
      PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      OMP_PROFILE: process.env.OMP_PROFILE,
      PI_PROFILE: process.env.PI_PROFILE,
    }
    process.env.PI_CONFIG_DIR = '.config/omp'
    process.env.PI_CODING_AGENT_DIR = path.join(home, 'default-decoy')
    process.env.OMP_PROFILE = 'work'
    process.env.PI_PROFILE = 'ignored'
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtimeContext(home),
      observeOnly: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
      discoveryDependencies: {
        fs: fileSystem,
        which: async command => command === 'omp' ? executable : undefined,
        execVersion: targetPath => inspectPassiveCliVersion(targetPath, fileSystem),
      },
    })
    try {
      const scan = await composition.service.scan()
      const omp = scan.snapshot.installations.find(item => item.hostVariant === 'omp-cli')
      expect(composition.repository.getInstallation(omp!.id)).toMatchObject({
        config_root: path.join(home, '.config', 'omp', 'profiles', 'work', 'agent'),
        profile_id: 'work',
      })
    } finally {
      composition.runtime.stop()
      db.close()
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['XDG_CONFIG_HOME', 'xdg-config', true],
    ['OPENCODE_CONFIG_DIR', 'custom-opencode', false],
    ['OPENCODE_CONFIG', 'configs/opencode.jsonc', false],
  ] as const)('passes %s into the production OpenCode scanner', async (
    environmentKey,
    relativeValue,
    appendsOpenCodeDirectory,
  ) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-opencode-env-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const environmentValue = path.join(home, relativeValue)
    const exactConfigFile = environmentKey === 'OPENCODE_CONFIG' ? environmentValue : undefined
    const configRoot = exactConfigFile
      ? path.dirname(exactConfigFile)
      : appendsOpenCodeDirectory
        ? path.join(environmentValue, 'opencode')
        : environmentValue
    const resourceRoot = exactConfigFile
      ? path.join(home, '.config', 'opencode')
      : configRoot
    const packageRoot = path.join(root, 'node_modules', 'opencode-ai')
    const executable = path.join(packageRoot, 'bin', 'opencode')
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(appData, { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'opencode-ai',
      version: '1.18.28',
    }), { mode: 0o600 })
    const fileSystem = {
      lstat: async (targetPath: string) => {
        try {
          const stat = fs.lstatSync(targetPath)
          return {
            kind: stat.isSymbolicLink()
              ? 'symbolic_link' as const
              : stat.isFile()
                ? 'file' as const
                : stat.isDirectory()
                  ? 'directory' as const
                  : 'other' as const,
          }
        } catch { return undefined }
      },
      realpath: async (targetPath: string) => fs.realpathSync(targetPath),
      readTextFile: async (targetPath: string, maxBytes: number) => fs.readFileSync(targetPath, 'utf8').slice(0, maxBytes),
      readStableFileSnapshot,
      readStableFileFingerprint,
      readStableFileMetadata,
    }
    const previous = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
      OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    }
    delete process.env.XDG_CONFIG_HOME
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG
    process.env[environmentKey] = environmentValue
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtimeContext(home),
      observeOnly: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
      discoveryDependencies: {
        fs: fileSystem,
        which: async command => command === 'opencode' ? executable : undefined,
        execVersion: targetPath => inspectPassiveCliVersion(targetPath, fileSystem),
      },
    })
    try {
      const scan = await composition.service.scan()
      const opencode = scan.snapshot.installations.find(item => item.hostVariant === 'opencode-v1-cli')
      const row = composition.repository.getInstallation(opencode!.id)!
      expect(row).toMatchObject({
        config_root: configRoot,
      })
      const metadata = JSON.parse(row.metadata_json) as {
        componentConfigFiles?: Record<string, string>
        resourceRoots?: Record<string, string>
      }
      expect(metadata.componentConfigFiles).toMatchObject({
        instruction: path.join(home, '.agents', 'skills', 'tidemind', 'SKILL.md'),
        lifecycle: path.join(resourceRoot, 'plugins', 'tidemind-v1.ts'),
      })
      expect(metadata.componentConfigFiles?.memory_tools).toBe(exactConfigFile)
      expect(metadata.resourceRoots).toEqual({ opencode_resources: resourceRoot })
    } finally {
      composition.runtime.stop()
      db.close()
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('production Agent Integration live distribution trust', { timeout: 30_000 }, () => {
  it('ends the production Desktop signature proof with a synchronous recursive verification', () => {
    const calls: string[][] = []
    const runner = vi.fn((args: readonly string[]) => {
      calls.push([...args])
      if (args.includes('--verbose=4')) return {
        stdout: '',
        stderr: 'Identifier=dev.zcode.app\nTeamIdentifier=8A5X4JJ39T\nCDHash=0123456789abcdef0123456789abcdef01234567\n',
      }
      if (args.includes('-r-')) return {
        stdout: '',
        stderr: 'designated => identifier "dev.zcode.app" and anchor apple generic\n',
      }
      return { stdout: '', stderr: '' }
    })

    expect(inspectMacAppSignatureSync('/tmp/ZCode.app', 100, runner)).toMatchObject({
      valid: true,
      identifier: 'dev.zcode.app',
      teamIdentifier: '8A5X4JJ39T',
      verificationBoundary: 'strict_final',
    })
    expect(calls.at(-1)).toEqual(['--verify', '--deep', '--strict', '/tmp/ZCode.app'])
  })

  it('reads an identical Desktop signature receipt around verification and finishes with strict verification', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (args: readonly string[]) => {
      calls.push([...args])
      if (args.includes('--verbose=4')) return {
        stdout: '',
        stderr: 'Identifier=dev.zcode.app\nTeamIdentifier=8A5X4JJ39T\nCDHash=0123456789abcdef0123456789abcdef01234567\n',
      }
      if (args.includes('-r-')) return {
        stdout: '',
        stderr: 'designated => identifier "dev.zcode.app" and anchor apple generic\n',
      }
      return { stdout: '', stderr: '' }
    })

    await expect(inspectMacAppSignature('/tmp/ZCode.app', { timeoutMs: 100 }, runner))
      .resolves.toMatchObject({
        valid: true,
        identifier: 'dev.zcode.app',
        teamIdentifier: '8A5X4JJ39T',
        cdHash: '0123456789abcdef0123456789abcdef01234567',
      })
    expect(calls).toEqual([
      ['-dv', '--verbose=4', '/tmp/ZCode.app'],
      ['-d', '-r-', '/tmp/ZCode.app'],
      ['--verify', '--deep', '--strict', '/tmp/ZCode.app'],
      ['-dv', '--verbose=4', '/tmp/ZCode.app'],
      ['-d', '-r-', '/tmp/ZCode.app'],
      ['--verify', '--deep', '--strict', '/tmp/ZCode.app'],
    ])
  })

  it('rejects a Desktop receipt that changes across strict verification', async () => {
    let detailsReads = 0
    const runner = vi.fn(async (args: readonly string[]) => {
      if (args.includes('--verbose=4')) {
        detailsReads += 1
        const cdHash = detailsReads === 1
          ? '0123456789abcdef0123456789abcdef01234567'
          : '89abcdef0123456789abcdef0123456789abcdef'
        return {
          stdout: '',
          stderr: `Identifier=dev.zcode.app\nTeamIdentifier=8A5X4JJ39T\nCDHash=${cdHash}\n`,
        }
      }
      if (args.includes('-r-')) return {
        stdout: '',
        stderr: 'designated => identifier "dev.zcode.app" and anchor apple generic\n',
      }
      return { stdout: '', stderr: '' }
    })

    await expect(inspectMacAppSignature('/tmp/ZCode.app', { timeoutMs: 100 }, runner))
      .rejects.toThrow('desktop_signature_receipt_changed_during_verification')
    expect(runner).toHaveBeenCalledTimes(5)
  })

  it.each([
    ['opencode-v1-cli', 'opencode', 'opencode-ai'],
    ['opencode-v2-beta-cli', 'opencode2', '@opencode-ai/cli'],
  ] as const)('manages a native-sized %s distribution through discovery, effect and verified recovery', async (
    catalogId,
    command,
    packageName,
  ) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-opencode-native-proof-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const packageRoot = packageName.startsWith('@')
      ? path.join(root, 'node_modules', ...packageName.split('/'))
      : path.join(root, 'node_modules', packageName)
    const executable = path.join(packageRoot, 'bin', command)
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(appData, { recursive: true, mode: 0o700 })
    const descriptor = fs.openSync(executable, 'w', 0o700)
    try {
      fs.ftruncateSync(descriptor, 20 * 1024 * 1024)
      fs.writeSync(descriptor, Buffer.from('#!/bin/sh\n'), 0, 10, 0)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(executable, 0o700)
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: packageName,
      version: '1.2.3',
    }), { mode: 0o600 })
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(home, catalogId)
    fake.host.verify = vi.fn(async context => [{
      componentKey: 'memory_tools' as const,
      status: 'verified' as const,
      verifiedCapability: 2 as const,
      identityAssertion: context.agentId,
      evidenceHash: `native-${catalogId}-evidence`,
      invalidationKeys: [] as const,
      diagnostics: [],
    }])
    const fingerprintReads: string[] = []
    const fileSystem = {
      lstat: async (targetPath: string) => {
        try {
          const stat = fs.lstatSync(targetPath)
          return { kind: stat.isSymbolicLink() ? 'symbolic_link' as const : stat.isFile() ? 'file' as const : stat.isDirectory() ? 'directory' as const : 'other' as const }
        } catch { return undefined }
      },
      realpath: async (targetPath: string) => fs.realpathSync(targetPath),
      readTextFile: async (targetPath: string, maxBytes: number) => fs.readFileSync(targetPath, 'utf8').slice(0, maxBytes),
      readStableFileSnapshot,
      readStableFileFingerprint: async (targetPath: string, maxBytes: number) => {
        fingerprintReads.push(targetPath)
        return readStableFileFingerprint(targetPath, maxBytes)
      },
      readStableFileMetadata,
    }
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtimeContext(home),
      adapters: new Map([[catalogId, fake.host]]),
      enabledAdapterIds: [catalogId],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies: {
        fs: fileSystem,
        which: async candidate => candidate === command ? executable : undefined,
        execVersion: targetPath => inspectPassiveCliVersion(targetPath, fileSystem),
      },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const originalSetRunState = composition.coordinatorRepository.setRunState.bind(composition.coordinatorRepository)
    const finalizerCrash = vi.spyOn(composition.coordinatorRepository, 'setRunState')
      .mockImplementation((runId, state, updatedAt, failure) => {
        if (state === 'committed') throw new Error('fixture crash before native finalizer commit')
        return originalSetRunState(runId, state, updatedAt, failure)
      })
    try {
      const scan = await composition.service.scan()
      const installation = scan.snapshot.installations.find(item => item.hostVariant === catalogId)
      expect(installation).toMatchObject({ manageable: true, version: '1.2.3' })
      expect(fingerprintReads).toHaveLength(0)

      const preview = await composition.service.previewConnect([installation!.id])
      const afterPreview = fingerprintReads.length
      expect(afterPreview).toBeGreaterThanOrEqual(1)
      const applied = await composition.service.applyConnect(preview.planHash, [installation!.id])
      expect(applied.results[0]).toMatchObject({ status: 'failed' })
      expect(fingerprintReads.length).toBeGreaterThan(afterPreview)
      expect(fake.apply).toHaveBeenCalledTimes(1)
      expect(db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'verified' })
      expect(db.prepare(`SELECT state FROM projection_mutations`).get()).toEqual({ state: 'committed' })

      const beforeRecovery = fingerprintReads.length
      finalizerCrash.mockRestore()
      await composition.service.scan()
      expect(fingerprintReads.length).toBeGreaterThan(beforeRecovery)
      expect(db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'committed' })
      expect(composition.repository.getInstallation(installation!.id)).toMatchObject({
        desired_state: 'managed',
        reconcile_state: 'idle',
      })
    } finally {
      finalizerCrash.mockRestore()
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('manages the exact official Qwen installer shim and rejects a nested runtime swap after preview', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-qwen-launcher-proof-')))
    const home = path.join(root, 'home')
    const launcher = path.join(home, '.local', 'bin', 'qwen')
    const packageRoot = path.join(home, '.local', 'lib', 'qwen-code')
    const innerLauncher = path.join(packageRoot, 'bin', 'qwen')
    const packageJson = path.join(packageRoot, 'package.json')
    const standaloneManifest = path.join(packageRoot, 'manifest.json')
    const cliEntry = path.join(packageRoot, 'lib', 'cli-entry.js')
    const nestedRuntime = path.join(packageRoot, 'lib', 'node_modules', '@qwen-code', 'runtime.js')
    const nodeRuntime = path.join(packageRoot, 'node', 'bin', 'node')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.mkdirSync(path.dirname(innerLauncher), { recursive: true })
    fs.mkdirSync(path.dirname(cliEntry), { recursive: true })
    fs.mkdirSync(path.dirname(nestedRuntime), { recursive: true })
    fs.mkdirSync(path.dirname(nodeRuntime), { recursive: true })
    fs.mkdirSync(path.join(home, '.qwen'), { recursive: true })
    fs.writeFileSync(launcher, `#!/usr/bin/env sh\nexec '${innerLauncher}' "$@"\n`, { mode: 0o700 })
    fs.writeFileSync(innerLauncher, normalizedQwenLauncherBytes(), { mode: 0o700 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.23.0' }))
    fs.writeFileSync(standaloneManifest, JSON.stringify({
      name: '@qwen-code/qwen-code',
      version: '0.23.0',
      target: `darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}`,
      runtime: 'node',
      nodeArchive: `node-v22.0.0-darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}.tar.gz`,
    }))
    fs.writeFileSync(cliEntry, 'export async function main() {}\n')
    fs.writeFileSync(nestedRuntime, 'export const runtime = true\n')
    fs.writeFileSync(nodeRuntime, 'official-node-runtime', { mode: 0o700 })
    const fileSystem = {
      ...physicalDiscoveryFileSystem(),
      readStableFileSnapshot,
      readStableFileFingerprint,
      readStableFileMetadata,
    }
    const discoveryDependencies: DiscoveryDependencies = {
      fs: fileSystem,
      which: async command => command === 'qwen' ? launcher : undefined,
      execVersion: targetPath => inspectPassiveCliVersion(targetPath, fileSystem),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(home, 'qwen-code-cli')
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(home),
      adapters: new Map([['qwen-code-cli', fake.host]]),
      enabledAdapterIds: ['qwen-code-cli'],
      observeOnly: false,
      startRuntime: false,
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies,
      scanner: {
        scan: () => discoverLocalP0Agents({
          homeDir: home,
          osUserIdentity: 'usr_fixture_1234',
          applicationRoots: [],
          operationTimeoutMs: 2_000,
        }, discoveryDependencies),
      },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const scan = await composition.service.scan()
      const qwen = scan.snapshot.installations.find(item => item.hostVariant === 'qwen-code-cli')!
      expect(qwen).toMatchObject({ manageable: true, version: '0.23.0' })
      expect(composition.repository.getInstallation(qwen.id)).toMatchObject({
        executable_path: launcher,
        health_state: 'discovered',
      })
      const preview = await composition.service.previewConnect([qwen.id])
      const replacement = `${nestedRuntime}.replacement`
      fs.writeFileSync(replacement, '#!/usr/bin/env sh\necho replaced\n', { mode: 0o700 })
      fs.renameSync(replacement, nestedRuntime)

      const result = await composition.service.applyConnect(preview.planHash, [qwen.id])

      expect(result.results[0]).toMatchObject({ installationId: qwen.id, status: 'failed' })
      expect(fake.apply).not.toHaveBeenCalled()
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds an official npm CLI to the exact canonical manifest and fails closed when it changes or disappears', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-npm-proof-')))
    const executable = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    const packageJson = path.join(root, 'node_modules', '@openai', 'codex', 'package.json')
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: '@openai/codex', version: '1.2.3' }), { mode: 0o600 })
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    repository.upsertDiscoveredInstallation({
      id: 'codex-cli-proof',
      family: 'codex',
      hostVariant: 'codex-cli',
      installKey: 'codex:proof',
      distributionId: 'cli:codex-cli',
      provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234',
      displayName: 'Codex CLI',
      configRoot: path.join(root, '.codex'),
      executablePath: executable,
      agentId: 'agent-codex-proof',
      supportedCapability: 3,
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
      metadata: {
        managementEligibility: freshCliManagementEligibility(fs.statSync(executable).size),
        distribution: {
          distributionId: 'cli:codex-cli',
          executableRealpath: executable,
          packageProvenance: 'npm_metadata:@openai/codex',
        },
      },
    })
    const fileSystem = {
      lstat: async (targetPath: string) => {
        try {
          const stat = fs.lstatSync(targetPath)
          return { kind: stat.isSymbolicLink() ? 'symbolic_link' as const : stat.isFile() ? 'file' as const : stat.isDirectory() ? 'directory' as const : 'other' as const }
        } catch { return undefined }
      },
      realpath: async (targetPath: string) => fs.realpathSync(targetPath),
      readTextFile: async (targetPath: string, maxBytes: number) => fs.readFileSync(targetPath, 'utf8').slice(0, maxBytes),
      readStableFileSnapshot,
      readStableFileFingerprint,
    }
    const attest = createProductionLiveTrustAttestor({
      fs: fileSystem,
      which: async () => undefined,
      execVersion: (targetPath: string) => inspectPassiveCliVersion(targetPath, fileSystem),
    })
    try {
      const row = repository.getInstallation('codex-cli-proof')!
      const first = await attest(row)
      expect(first).toMatch(/^[a-f0-9]{64}$/)

      fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("changed")\n')
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/)
      expect(await attest(row)).not.toBe(first)

      fs.chmodSync(executable, 0o600)
      expect(await attest(row)).toBeNull()
      fs.chmodSync(executable, 0o700)

      const replacement = path.join(root, 'replacement-codex.js')
      fs.writeFileSync(replacement, '#!/usr/bin/env node\n', { mode: 0o700 })
      fs.renameSync(replacement, executable)
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/)
      expect(await attest(row)).not.toBe(first)

      fs.writeFileSync(packageJson, JSON.stringify({ name: '@openai/codex', version: '1.2.4' }), { mode: 0o600 })
      expect(await attest(row)).not.toBe(first)

      fs.unlinkSync(packageJson)
      expect(await attest(row)).toBeNull()
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      catalogId: 'kimi-code-cli' as const,
      family: 'kimi-code',
      command: 'kimi',
      packageName: '@moonshot-ai/kimi-code',
      version: '0.41.0',
      distributionId: 'cli:kimi-code-cli',
    },
    {
      catalogId: 'openclaw-local' as const,
      family: 'openclaw',
      command: 'openclaw',
      packageName: 'openclaw',
      version: '2026.8.1',
      distributionId: 'cli:openclaw-local:npm-global',
    },
  ])('carries $catalogId global npm from physical discovery through receipt gate and live trust', async ({
    catalogId, family, command, packageName, version, distributionId,
  }) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-npm-release-flow-')))
    const home = path.join(root, 'home')
    const nodeModules = path.join(root, 'npm', 'lib', 'node_modules')
    const packageRoot = path.join(nodeModules, ...packageName.split('/'))
    const executable = path.join(packageRoot, 'dist', 'cli.js')
    const secondaryModule = path.join(packageRoot, 'dist', 'secondary.js')
    const packageJson = path.join(packageRoot, 'package.json')
    const installLock = path.join(nodeModules, '.package-lock.json')
    const integrity = 'sha512-YWdlbnQtb2ZmaWNpYWwtYXJ0aWZhY3Q='
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(secondaryModule, 'export const secondary = true\n', { mode: 0o600 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: packageName, version }), { mode: 0o600 })
    fs.writeFileSync(installLock, JSON.stringify({
      lockfileVersion: 3,
      packages: { [`node_modules/${packageName}`]: { version, integrity } },
    }), { mode: 0o600 })
    const fileSystem = physicalDiscoveryFileSystem()
    const dependencies: DiscoveryDependencies = {
      fs: fileSystem,
      which: async candidate => candidate === command ? executable : undefined,
      execVersion: targetPath => inspectPassiveCliVersion(targetPath, fileSystem),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    try {
      const report = await discoverLocalP0Agents({
        homeDir: home,
        osUserIdentity: 'usr_fixture_1234',
        environment: {},
        applicationRoots: [],
        operationTimeoutMs: 2_000,
      }, dependencies)
      const discovered = report.installations.find(item => item.catalogId === catalogId)!
      expect(discovered).toMatchObject({
        executablePath: executable,
        detectedVersion: version,
        identity: { distribution: {
          distributionId,
          packageProvenance: `npm_metadata:${packageName}`,
          portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        } },
      })
      const releaseEntry = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(catalogId)!
      expect(agentReleaseEligibilityReason(discovered, {
        ...releaseEntry,
        releaseAcceptedExactVersions: [version],
        acceptedDistributionArtifacts: [{
          distributionId,
          packageProvenance: `npm_metadata:${packageName}`,
          version,
          architecture: process.arch === 'x64' ? 'x64' : 'arm64',
          artifactSha256: 'a'.repeat(64), artifactSizeBytes: 1,
          executableSha256: 'b'.repeat(64), executableSizeBytes: 1,
          distributionSha256: 'c'.repeat(64), distributionSizeBytes: 1,
          portableFingerprintSchema: 'npm-package-surface-v1',
          portableArtifactFingerprint: discovered.identity.distribution.portableArtifactFingerprint!,
          signedCode: null,
          npmPackage: {
            integrity,
            packageTreeSha256: 'd'.repeat(64),
            proofNodes: [],
          },
        }],
      })).toBeNull()

      const repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: `${catalogId}-npm-proof`, family, hostVariant: catalogId,
        installKey: discovered.identity.installKey, distributionId, provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234', displayName: catalogId,
        configRoot: discovered.configRoot, executablePath: executable,
        detectedVersion: version, versionDetectionMethod: discovered.versionDetectionMethod,
        agentId: `agent-${catalogId}`, supportedCapability: 4,
        lastDetectedAt: '2026-09-05T00:00:00.000Z',
        metadata: {
          managementEligibility: freshCliManagementEligibility(fs.statSync(executable).size),
          distribution: discovered.identity.distribution,
        },
      })
      const attest = createProductionLiveTrustAttestor(dependencies, {
        homeDir: home,
        repository,
        runtime: runtimeContext(home),
      })
      const row = repository.getInstallation(`${catalogId}-npm-proof`)!
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/u)
      fs.writeFileSync(secondaryModule, 'export const secondary = false\n', { mode: 0o600 })
      expect(await attest(row)).toBeNull()
      fs.writeFileSync(secondaryModule, 'export const secondary = true\n', { mode: 0o600 })
      fs.writeFileSync(installLock, JSON.stringify({
        lockfileVersion: 3,
        packages: { [`node_modules/${packageName}`]: { version } },
      }), { mode: 0o600 })
      expect(await attest(row)).toBeNull()
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'Claude', family: 'claude-code', catalogId: 'claude-code-native' as const,
      executableName: 'claude', identifier: 'com.anthropic.claude-code', team: 'Q6L2SF6YDW',
      cdHash: '28d49821f609d871c2282bdec52116bd91ea5806',
    },
  ])('binds $label native write trust to the exact signed Mach-O generation and publisher receipt', async ({
    family, catalogId, executableName, identifier, team, cdHash,
  }) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-signed-cli-proof-')))
    const executable = path.join(root, executableName)
    fs.writeFileSync(executable, 'fixture-native-code', { mode: 0o700 })
    const designatedRequirement = `identifier "${identifier}" and anchor apple generic`
    const receiptFingerprint = sha256Json({ cdHash, designatedRequirement })
    const executableProof = await readStableFileFingerprint(executable, MAX_CLI_EXECUTABLE_PROOF_BYTES)
    const portableArtifactFingerprint = signedCodePortableArtifactFingerprint({
      version: '2.1.260',
      executable: executableProof,
      signature: {
        valid: true, identifier, teamIdentifier: team, cdHash, designatedRequirement,
        verificationBoundary: 'strict_final',
      },
    })!
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    repository.upsertDiscoveredInstallation({
      id: `${catalogId}-proof`, family, hostVariant: catalogId,
      installKey: `${catalogId}:native`, distributionId: `cli:${catalogId}`, provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234', displayName: `${family} native`,
      configRoot: path.join(root, `.${executableName}`), executablePath: executable,
      detectedVersion: '2.1.260', versionDetectionMethod: 'cli_version',
      agentId: `agent-${catalogId}`, supportedCapability: 4,
      lastDetectedAt: '2026-09-03T00:00:00.000Z',
      metadata: {
        managementEligibility: freshCliManagementEligibility(fs.statSync(executable).size),
        distribution: {
          distributionId: `cli:${catalogId}`, executableRealpath: executable,
          packageProvenance: `signed_cli:${identifier}:${team}`,
          capabilityFingerprint: `signed-cli-surface-v1:${receiptFingerprint}`,
          portableArtifactFingerprint,
        },
      },
    })
    const fileSystem = physicalDiscoveryFileSystem()
    let teamIdentifier = team
    let replaceDuringSignature = false
    const signature = () => ({
      valid: true,
      identifier,
      teamIdentifier,
      cdHash,
      designatedRequirement,
      verificationBoundary: 'strict_final' as const,
    })
    const attest = createProductionLiveTrustAttestor({
      fs: fileSystem,
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      inspectAppSignature: async (_targetPath, options) => {
        await options.beforeFinalVerification?.()
        if (replaceDuringSignature) {
          const replacement = path.join(root, `replacement-${executableName}`)
          fs.writeFileSync(replacement, 'different-native-code', { mode: 0o700 })
          fs.renameSync(replacement, executable)
        }
        return signature()
      },
      finalVerifyAppSignatureSync: signature,
    })
    try {
      const row = repository.getInstallation(`${catalogId}-proof`)!
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/u)
      const metadata = JSON.parse(row.metadata_json) as { distribution: { portableArtifactFingerprint: string } }
      metadata.distribution.portableArtifactFingerprint = 'f'.repeat(64)
      expect(await attest({ ...row, metadata_json: JSON.stringify(metadata) })).toBeNull()
      teamIdentifier = 'ATTACKER00'
      expect(await attest(row)).toBeNull()
      teamIdentifier = team
      replaceDuringSignature = true
      expect(await attest(row)).toBeNull()
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves Kimi native version from one frozen receipt and ignores mutable updater state', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-kimi-updater-proof-')))
    const home = path.join(root, 'home')
    const nativeRoot = path.join(home, '.kimi-code')
    const configRoot = path.join(home, 'profiles', 'kimi-data')
    const executable = path.join(nativeRoot, 'bin', 'kimi')
    const installJson = path.join(nativeRoot, 'updates', 'install.json')
    const latestJson = path.join(nativeRoot, 'updates', 'latest.json')
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(installJson), { recursive: true, mode: 0o700 })
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, 'signed-kimi-native', { mode: 0o700 })
    fs.writeFileSync(installJson, JSON.stringify({
      active: null,
      lastFailure: null,
      lastSuccess: { version: '0.40.1', installedAt: '2026-09-03T07:38:44.514Z' },
    }), { mode: 0o600 })
    fs.writeFileSync(latestJson, JSON.stringify({
      source: 'cdn', checkedAt: '2026-09-03T07:56:14.443Z', latest: '0.40.1',
      manifest: { version: '0.40.1', publishedAt: '2026-09-02T10:31:46Z' },
    }), { mode: 0o600 })
    const cdHash = 'bb4cdfad0d4aeb516ba70c5179a7ad23b7d7bbc2'
    const designatedRequirement = 'identifier "kimi" and anchor apple generic'
    const signature = () => ({
      valid: true,
      identifier: 'kimi',
      teamIdentifier: '2J9472RW75',
      cdHash,
      designatedRequirement,
      verificationBoundary: 'strict_final' as const,
    })
    const fileSystem = physicalDiscoveryFileSystem()
    const executableProof = await readStableFileFingerprint(executable, MAX_CLI_EXECUTABLE_PROOF_BYTES)
    const lookupFingerprint = kimiNativeReceiptLookupFingerprint({
      architecture: 'arm64', executableSha256: executableProof.sha256,
      executableSizeBytes: executableProof.size, identifier: 'kimi',
      teamIdentifier: '2J9472RW75', cdHash, designatedRequirement,
    })
    const portableArtifactFingerprint = signedKimiPortableArtifactFingerprint({
      version: '0.41.0',
      executableArtifactFingerprint: kimiNativeExecutablePortableArtifactFingerprint(executableProof),
      signature: signature(),
    })!
    const dependencies: DiscoveryDependencies = {
      fs: fileSystem,
      which: async command => command === 'kimi' ? executable : undefined,
      execVersion: targetPath => inspectPassiveCliVersion(targetPath, fileSystem),
      inspectAppSignature: async (_targetPath, options) => {
        await options.beforeFinalVerification?.()
        return signature()
      },
      finalVerifyAppSignatureSync: signature,
      inspectExecutableArchitecture: async () => 'arm64',
      resolveKimiNativeReceipt: surface => surface.architecture === 'arm64'
        && surface.lookupFingerprint === lookupFingerprint
        ? { version: '0.41.0', portableArtifactFingerprint }
        : null,
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    try {
      const report = await discoverLocalP0Agents({
        homeDir: home,
        osUserIdentity: 'usr_fixture_1234',
        environment: { KIMI_CODE_HOME: configRoot },
        applicationRoots: [],
        operationTimeoutMs: 2_000,
      }, dependencies)
      const discovered = report.installations.find(item => item.catalogId === 'kimi-code-native')!
      expect(discovered).toMatchObject({
        configRoot,
        executablePath: executable,
        detectedVersion: '0.41.0',
        versionDetectionMethod: 'release_receipt',
        identity: { distribution: {
          packageProvenance: 'signed_cli:kimi:2J9472RW75',
          capabilityFingerprint: `signed-cli-kimi-receipt-lookup-v1:${lookupFingerprint}`,
          portableArtifactFingerprint,
        } },
      })
      const repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'kimi-native-proof', family: 'kimi-code', hostVariant: 'kimi-code-native',
        installKey: discovered.identity.installKey, distributionId: 'cli:kimi-code-native', provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234', displayName: 'Kimi native', configRoot,
        executablePath: executable, detectedVersion: discovered.detectedVersion,
        versionDetectionMethod: discovered.versionDetectionMethod,
        agentId: 'agent-kimi-native', supportedCapability: 4,
        lastDetectedAt: '2026-09-03T00:00:00.000Z',
        metadata: {
          managementEligibility: freshCliManagementEligibility(fs.statSync(executable).size),
          distribution: discovered.identity.distribution,
        },
      })
      const attest = createProductionLiveTrustAttestor(dependencies)
      const row = repository.getInstallation('kimi-native-proof')!
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/u)

      fs.writeFileSync(installJson, JSON.stringify({
        lastSuccess: { version: '9.9.9', installedAt: '2026-09-03T07:38:44.514Z' },
      }), { mode: 0o600 })
      fs.rmSync(latestJson)
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/u)
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('discovers and attests the official contained OpenClaw wrapper under an explicit prefix', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-openclaw-wrapper-')))
    const home = path.join(root, 'home')
    const prefix = path.join(home, 'Applications', 'openclaw-portable')
    const effectiveHome = path.join(home, 'profiles', 'assistant')
    const configRoot = path.join(effectiveHome, '.openclaw')
    const wrapper = path.join(prefix, 'bin', 'openclaw')
    const toolchain = path.join(prefix, 'tools', 'node-v24.19.0')
    const node = path.join(toolchain, 'bin', 'node')
    const entry = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'dist', 'entry.js')
    const secondaryModule = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'dist', 'secondary.js')
    const packageJson = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'package.json')
    fs.mkdirSync(path.dirname(wrapper), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(node), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 })
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 })
    fs.symlinkSync(toolchain, path.join(prefix, 'tools', 'node'))
    fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nset -euo pipefail\nexec "${path.join(prefix, 'tools', 'node', 'bin', 'node')}" "${entry}" "$@"\n`, { mode: 0o700 })
    fs.writeFileSync(node, 'official-node-runtime', { mode: 0o700 })
    fs.writeFileSync(entry, 'export async function main() {}\n', { mode: 0o600 })
    fs.writeFileSync(secondaryModule, 'export const secondary = true\n', { mode: 0o600 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: 'openclaw', version: '2026.8.1', type: 'module', bin: { openclaw: 'openclaw.mjs' } }), { mode: 0o600 })
    const fileSystem = physicalDiscoveryFileSystem()
    const dependencies: DiscoveryDependencies = {
      fs: fileSystem,
      which: async command => command === 'openclaw' ? wrapper : undefined,
      execVersion: targetPath => inspectPassiveCliVersion(targetPath, fileSystem),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    try {
      const report = await discoverLocalP0Agents({
        homeDir: home,
        osUserIdentity: 'usr_fixture_1234',
        environment: { OPENCLAW_PREFIX: prefix, OPENCLAW_HOME: effectiveHome },
        applicationRoots: [],
        operationTimeoutMs: 2_000,
      }, dependencies)
      const discovered = report.installations.find(item => item.catalogId === 'openclaw-local')!
      expect(discovered).toMatchObject({
        configRoot,
        executablePath: wrapper,
        detectedVersion: '2026.8.1',
        identity: { distribution: {
          distributionId: 'cli:openclaw-local:portable-wrapper',
          packageProvenance: 'npm_metadata:openclaw',
        } },
      })
      const repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'openclaw-wrapper-proof', family: 'openclaw', hostVariant: 'openclaw-local',
        installKey: discovered.identity.installKey,
        distributionId: 'cli:openclaw-local:portable-wrapper', provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234', displayName: 'OpenClaw', configRoot,
        executablePath: wrapper, detectedVersion: discovered.detectedVersion,
        versionDetectionMethod: discovered.versionDetectionMethod,
        agentId: 'agent-openclaw', supportedCapability: 4,
        lastDetectedAt: '2026-09-03T00:00:00.000Z',
        metadata: {
          managementEligibility: freshCliManagementEligibility(fs.statSync(wrapper).size),
          distribution: discovered.identity.distribution,
        },
      })
      const attest = createProductionLiveTrustAttestor(dependencies, {
        homeDir: home,
        repository,
        runtime: runtimeContext(home),
      })
      const row = repository.getInstallation('openclaw-wrapper-proof')!
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/u)

      fs.writeFileSync(secondaryModule, 'export const secondary = false\n', { mode: 0o600 })
      expect(await attest(row)).toBeNull()
      fs.writeFileSync(secondaryModule, 'export const secondary = true\n', { mode: 0o600 })
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/u)

      const lateModule = path.join(path.dirname(entry), 'late.js')
      let injectedAfterSnapshot = false
      const racingFileSystem: DiscoveryDependencies['fs'] = {
        ...fileSystem,
        verifyStablePackageTree: async (targetPath, snapshot) => {
          if (!injectedAfterSnapshot) {
            injectedAfterSnapshot = true
            fs.writeFileSync(lateModule, 'export const late = true\n', { mode: 0o600 })
          }
          return verifyStablePackageTree(targetPath, snapshot)
        },
      }
      const racingAttest = createProductionLiveTrustAttestor({
        ...dependencies,
        fs: racingFileSystem,
        execVersion: targetPath => inspectPassiveCliVersion(targetPath, racingFileSystem),
      }, {
        homeDir: home,
        repository,
        runtime: runtimeContext(home),
      })
      expect(await racingAttest(row)).toBeNull()
      fs.unlinkSync(lateModule)

      fs.unlinkSync(path.join(prefix, 'tools', 'node'))
      const attackerToolchain = path.join(root, 'attacker-node')
      fs.mkdirSync(path.join(attackerToolchain, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(attackerToolchain, 'bin', 'node'), 'attacker', { mode: 0o700 })
      fs.symlinkSync(attackerToolchain, path.join(prefix, 'tools', 'node'))
      expect(await attest(row)).toBeNull()
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects executable or manifest replacement interleaved between stable CLI snapshots', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-npm-interleave-')))
    const executable = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    const packageJson = path.join(root, 'node_modules', '@openai', 'codex', 'package.json')
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: '@openai/codex', version: '1.2.3' }), { mode: 0o600 })
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    repository.upsertDiscoveredInstallation({
      id: 'codex-cli-interleave', family: 'codex', hostVariant: 'codex-cli',
      installKey: 'codex:interleave', distributionId: 'cli:codex-cli', provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234', displayName: 'Codex CLI',
      configRoot: path.join(root, '.codex'), executablePath: executable,
      agentId: 'agent-codex-interleave', supportedCapability: 3,
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
      metadata: {
        managementEligibility: freshCliManagementEligibility(fs.statSync(executable).size),
        distribution: {
          distributionId: 'cli:codex-cli', executableRealpath: executable,
          packageProvenance: 'npm_metadata:@openai/codex',
        },
      },
    })
    const fileSystem = {
      lstat: async (targetPath: string) => {
        try {
          const stat = fs.lstatSync(targetPath)
          return { kind: stat.isSymbolicLink() ? 'symbolic_link' as const : stat.isFile() ? 'file' as const : stat.isDirectory() ? 'directory' as const : 'other' as const }
        } catch { return undefined }
      },
      realpath: async (targetPath: string) => fs.realpathSync(targetPath),
      readTextFile: async (targetPath: string, maxBytes: number) => fs.readFileSync(targetPath, 'utf8').slice(0, maxBytes),
      readStableFileSnapshot,
      readStableFileFingerprint,
    }
    let replaceDuringProof: 'executable' | 'manifest' | null = 'executable'
    const attest = createProductionLiveTrustAttestor({
      fs: fileSystem,
      which: async () => undefined,
      execVersion: async targetPath => {
        const result = await inspectPassiveCliVersion(targetPath, fileSystem)
        if (replaceDuringProof === 'executable') {
          replaceDuringProof = null
          const replacement = path.join(root, 'replacement-codex.js')
          fs.writeFileSync(replacement, '#!/usr/bin/env node\nconsole.log("replacement")\n', { mode: 0o700 })
          fs.renameSync(replacement, executable)
        } else if (replaceDuringProof === 'manifest') {
          replaceDuringProof = null
          fs.writeFileSync(packageJson, JSON.stringify({ name: '@openai/codex', version: '1.2.4' }), { mode: 0o600 })
        }
        return result
      },
    })
    try {
      const row = repository.getInstallation('codex-cli-interleave')!
      expect(await attest(row)).toBeNull()
      replaceDuringProof = 'manifest'
      expect(await attest(row)).toBeNull()
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['npm', 'qwen'] as const)(
    'rejects a %s proof-node replacement after the final metadata result at preview',
    async kind => {
      const fixture = cliPostMetadataBarrierFixture(kind)
      try {
        fixture.arm()
        await expect(fixture.composition.service.previewConnect([fixture.installationId]))
          .rejects.toThrow('live distribution trust could not be proved')
        expect(fixture.fake.apply).not.toHaveBeenCalled()
        expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
        expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
        expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
      } finally {
        fixture.close()
      }
    },
  )

  it.each(['npm', 'qwen'] as const)(
    'rejects a %s proof-node replacement after the writer precondition and before effect',
    async kind => {
      const fixture = cliPostMetadataBarrierFixture(kind)
      const readBack = deferredBarrier()
      const originalReadBack = fixture.fake.host.readBack.bind(fixture.fake.host)
      fixture.fake.host.readBack = vi.fn(async (...args) => {
        readBack.markStarted()
        await readBack.wait
        return originalReadBack(...args)
      })
      try {
        const preview = await fixture.composition.service.previewConnect([fixture.installationId])
        const applying = fixture.composition.service.applyConnect(preview.planHash, [fixture.installationId])
        await readBack.started
        fixture.arm()
        readBack.release()
        await expect(applying).resolves.toEqual(expect.objectContaining({
          results: expect.arrayContaining([expect.objectContaining({
            installationId: fixture.installationId,
            status: 'needs_recovery',
          })]),
        }))
        expect(fixture.fake.apply).not.toHaveBeenCalled()
      } finally {
        readBack.release()
        fixture.close()
      }
    },
  )

  it.each(['npm', 'qwen'] as const)(
    'rejects a %s proof-node replacement during applied-unverified recovery',
    async kind => {
      const fixture = cliPostMetadataBarrierFixture(kind)
      try {
        const preview = await fixture.composition.service.previewConnect([fixture.installationId])
        const applied = await fixture.composition.service.applyConnect(preview.planHash, [fixture.installationId])
        expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
        expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
        fixture.arm()
        await fixture.composition.runtime.markScanCompleted()
        expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
        expect(fixture.db.prepare(`SELECT state, failure_code FROM reconcile_runs`).get()).toEqual({
          state: 'needs_recovery',
          failure_code: 'recovery_source_trust_changed',
        })
      } finally {
        fixture.close()
      }
    },
  )

  it.each(['npm', 'qwen'] as const)(
    'rejects a %s proof-node replacement before a verified finalizer commit',
    async kind => {
      const fixture = cliPostMetadataBarrierFixture(kind)
      fixture.fake.host.verify = vi.fn(async context => [{
        componentKey: 'memory_tools' as const,
        status: 'verified' as const,
        verifiedCapability: 2 as const,
        identityAssertion: context.agentId,
        evidenceHash: `${kind}-verified-evidence`,
        invalidationKeys: [] as const,
        diagnostics: [],
      }])
      const originalSetRunState = fixture.composition.coordinatorRepository.setRunState
        .bind(fixture.composition.coordinatorRepository)
      const finalizerCrash = vi.spyOn(fixture.composition.coordinatorRepository, 'setRunState')
        .mockImplementation((runId, state, updatedAt, failure) => {
          if (state === 'committed') throw new Error('fixture crash before finalizer commit')
          return originalSetRunState(runId, state, updatedAt, failure)
        })
      try {
        const preview = await fixture.composition.service.previewConnect([fixture.installationId])
        const applied = await fixture.composition.service.applyConnect(preview.planHash, [fixture.installationId])
        expect(applied.results[0]).toMatchObject({ status: 'failed' })
        expect(fixture.db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'verified' })
        expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
        finalizerCrash.mockRestore()
        fixture.arm()
        await fixture.composition.runtime.markScanCompleted()
        expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
        expect(fixture.db.prepare(`SELECT state, failure_code FROM reconcile_runs`).get()).toEqual({
          // A verified run has no remaining effect to replay. Trust loss
          // atomically cancels its finalizer instead of leaving recoverable work.
          state: 'cancelled',
          failure_code: 'recovery_source_trust_changed',
        })
      } finally {
        finalizerCrash.mockRestore()
        fixture.close()
      }
    },
  )

  it('rejects a nested Desktop mutation queued after the awaited receipt at preview', async () => {
    const fixture = await desktopPostFinalReceiptBarrierFixture()
    try {
      fixture.arm()
      await expect(fixture.composition.service.previewConnect([fixture.installationId]))
        .rejects.toThrow('live distribution trust could not be proved')
      expect(fixture.fake.apply).not.toHaveBeenCalled()
      expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      fixture.close()
    }
  })

  it('rejects a nested Desktop mutation queued after the awaited receipt at the effect fence', async () => {
    const fixture = await desktopPostFinalReceiptBarrierFixture()
    const readBack = deferredBarrier()
    const originalReadBack = fixture.fake.host.readBack.bind(fixture.fake.host)
    fixture.fake.host.readBack = vi.fn(async (...args) => {
      readBack.markStarted()
      await readBack.wait
      return originalReadBack(...args)
    })
    try {
      const preview = await fixture.composition.service.previewConnect([fixture.installationId])
      const applying = fixture.composition.service.applyConnect(preview.planHash, [fixture.installationId])
      await readBack.started
      fixture.arm()
      readBack.release()
      await expect(applying).resolves.toEqual(expect.objectContaining({
        results: expect.arrayContaining([expect.objectContaining({
          installationId: fixture.installationId,
          status: 'needs_recovery',
        })]),
      }))
      expect(fixture.fake.apply).not.toHaveBeenCalled()
    } finally {
      readBack.release()
      fixture.close()
    }
  })

  it('rejects a nested Desktop mutation queued after the awaited receipt during recovery', async () => {
    const fixture = await desktopPostFinalReceiptBarrierFixture()
    try {
      const preview = await fixture.composition.service.previewConnect([fixture.installationId])
      const applied = await fixture.composition.service.applyConnect(preview.planHash, [fixture.installationId])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
      fixture.arm()
      await fixture.composition.runtime.markScanCompleted()
      expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
      expect(fixture.db.prepare(`SELECT state, failure_code FROM reconcile_runs`).get()).toEqual({
        state: 'needs_recovery',
        failure_code: 'recovery_source_trust_changed',
      })
    } finally {
      fixture.close()
    }
  })

  it('rejects a nested Desktop mutation queued after the awaited receipt before finalizer commit', async () => {
    const fixture = await desktopPostFinalReceiptBarrierFixture()
    fixture.fake.host.verify = vi.fn(async context => [{
      componentKey: 'memory_tools' as const,
      status: 'verified' as const,
      verifiedCapability: 2 as const,
      identityAssertion: context.agentId,
      evidenceHash: 'desktop-final-receipt-evidence',
      invalidationKeys: [] as const,
      diagnostics: [],
    }])
    const originalSetRunState = fixture.composition.coordinatorRepository.setRunState
      .bind(fixture.composition.coordinatorRepository)
    const finalizerCrash = vi.spyOn(fixture.composition.coordinatorRepository, 'setRunState')
      .mockImplementation((runId, state, updatedAt, failure) => {
        if (state === 'committed') throw new Error('fixture crash before finalizer commit')
        return originalSetRunState(runId, state, updatedAt, failure)
      })
    try {
      const preview = await fixture.composition.service.previewConnect([fixture.installationId])
      const applied = await fixture.composition.service.applyConnect(preview.planHash, [fixture.installationId])
      expect(applied.results[0]).toMatchObject({ status: 'failed' })
      expect(fixture.db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'verified' })
      expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
      finalizerCrash.mockRestore()
      fixture.arm()
      await fixture.composition.runtime.markScanCompleted()
      expect(fixture.fake.apply).toHaveBeenCalledTimes(1)
      expect(fixture.db.prepare(`SELECT state, failure_code FROM reconcile_runs`).get()).toEqual({
        state: 'cancelled',
        failure_code: 'recovery_source_trust_changed',
      })
    } finally {
      finalizerCrash.mockRestore()
      fixture.close()
    }
  })

  it('binds a Desktop proof to the canonical app signature and rejects a Team drift', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-app-proof-')))
    const appPath = path.join(root, 'ZCode.app')
    const executable = path.join(appPath, 'Contents', 'MacOS', 'ZCode')
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, 'fixture', { mode: 0o700 })
    fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), [
      '<plist><dict>',
      '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
      '<key>CFBundleShortVersionString</key><string>3.10.2</string>',
      '<key>CFBundleExecutable</key><string>ZCode</string>',
      '</dict></plist>',
    ].join(''))
    const desktopFs = physicalDiscoveryFileSystem()
    const surface = await inspectStableDesktopBundleSurface({
      fs: desktopFs,
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
    }, appPath, 2_000)
    const executableProof = await readStableFileFingerprint(executable, MAX_CLI_EXECUTABLE_PROOF_BYTES)
    const portableArtifactFingerprint = signedCodePortableArtifactFingerprint({
      version: '3.10.2',
      executable: executableProof,
      signature: {
        valid: true,
        identifier: 'dev.zcode.app',
        teamIdentifier: '8A5X4JJ39T',
        cdHash: '0123456789abcdef0123456789abcdef01234567',
        designatedRequirement: 'identifier "dev.zcode.app" and anchor apple generic',
        verificationBoundary: 'strict_final',
      },
    })!
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    repository.upsertDiscoveredInstallation({
      id: 'zcode-proof',
      family: 'zcode',
      hostVariant: 'zcode-desktop',
      installKey: 'zcode:proof',
      distributionId: 'dev.zcode.app',
      provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234',
      displayName: 'ZCode',
      configRoot: path.join(root, '.zcode'),
      executablePath: executable,
      appPath,
      detectedVersion: '3.10.2',
      versionDetectionMethod: 'bundle_plist',
      agentId: 'agent-zcode-proof',
      supportedCapability: 3,
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
      metadata: {
        distribution: {
          distributionId: 'dev.zcode.app',
          executableRealpath: executable,
          packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
          capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:${surface.fingerprint}`,
          portableArtifactFingerprint,
        },
      },
    })
    let teamIdentifier = '8A5X4JJ39T'
    let cdHash: string | undefined = '0123456789abcdef0123456789abcdef01234567'
    let designatedRequirement: string | undefined = 'identifier "dev.zcode.app" and anchor apple generic'
    let finalIdentityMutation: 'app_mode' | 'executable_mode' | null = null
    const appMode = fs.statSync(appPath).mode & 0o777
    const executableMode = fs.statSync(executable).mode & 0o777
    const attest = createProductionLiveTrustAttestor({
      fs: desktopFs,
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      inspectAppSignature: async (_targetPath, options) => {
        await options.beforeFinalVerification?.()
        if (finalIdentityMutation === 'app_mode') fs.chmodSync(appPath, appMode ^ 0o020)
        if (finalIdentityMutation === 'executable_mode') fs.chmodSync(executable, executableMode ^ 0o020)
        return {
          valid: true,
          identifier: 'dev.zcode.app',
          teamIdentifier,
          cdHash,
          designatedRequirement,
          verificationBoundary: 'strict_final' as const,
        }
      },
      finalVerifyAppSignatureSync: () => ({
        ...zcodeSignature(),
        teamIdentifier,
        cdHash,
        designatedRequirement,
      }),
    })
    try {
      const row = repository.getInstallation('zcode-proof')!
      expect(await attest(row)).toMatch(/^[a-f0-9]{64}$/)
      const metadata = JSON.parse(row.metadata_json) as { distribution: { portableArtifactFingerprint: string } }
      metadata.distribution.portableArtifactFingerprint = 'f'.repeat(64)
      expect(await attest({ ...row, metadata_json: JSON.stringify(metadata) })).toBeNull()
      finalIdentityMutation = 'app_mode'
      expect(await attest(row)).toBeNull()
      fs.chmodSync(appPath, appMode)
      finalIdentityMutation = 'executable_mode'
      expect(await attest(row)).toBeNull()
      fs.chmodSync(executable, executableMode)
      finalIdentityMutation = null
      teamIdentifier = 'ATTACKER00'
      expect(await attest(row)).toBeNull()
      teamIdentifier = '8A5X4JJ39T'
      cdHash = undefined
      expect(await attest(row)).toBeNull()
      cdHash = '0123456789abcdef0123456789abcdef01234567'
      designatedRequirement = undefined
      expect(await attest(row)).toBeNull()
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reparses CFBundleExecutable and rejects an Old-to-New bundle switch before consent', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-app-main-switch-')))
    const home = path.join(root, 'home')
    const appPath = path.join(root, 'apps', 'ZCode.app')
    const infoPath = path.join(appPath, 'Contents', 'Info.plist')
    const oldExecutable = path.join(appPath, 'Contents', 'MacOS', 'Old')
    const newExecutable = path.join(appPath, 'Contents', 'MacOS', 'New')
    fs.mkdirSync(path.dirname(oldExecutable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(oldExecutable, 'signed-old-helper', { mode: 0o700 })
    const plist = (executable: string) => [
      '<plist><dict>',
      '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
      `<key>CFBundleExecutable</key><string>${executable}</string>`,
      '</dict></plist>',
    ].join('')
    fs.writeFileSync(infoPath, plist('Old'))
    const desktopFs = physicalDiscoveryFileSystem()
    const surface = await inspectStableDesktopBundleSurface({
      fs: desktopFs,
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
    }, appPath, 2_000)
    const inspectAppSignature = vi.fn(async (_targetPath: string, options: { beforeFinalVerification?: () => Promise<void> }) => {
      await options.beforeFinalVerification?.()
      return {
        valid: true,
        identifier: 'dev.zcode.app',
        teamIdentifier: '8A5X4JJ39T',
        cdHash: '0123456789abcdef0123456789abcdef01234567',
        designatedRequirement: 'identifier "dev.zcode.app" and anchor apple generic',
        verificationBoundary: 'strict_final' as const,
      }
    })
    const discoveryDependencies: DiscoveryDependencies = {
      fs: desktopFs,
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      inspectAppSignature,
      finalVerifyAppSignatureSync: () => zcodeSignature(),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root, 'zcode-desktop')
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(home),
      adapters: new Map([['zcode-desktop', fake.host]]),
      enabledAdapterIds: ['zcode-desktop'],
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies,
      observeOnly: false,
      startRuntime: false,
    })
    composition.repository.upsertDiscoveredInstallation({
      id: 'zcode-main-switch', family: 'zcode', hostVariant: 'zcode-desktop',
      installKey: 'zcode:main-switch', distributionId: 'dev.zcode.app', provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234', displayName: 'ZCode',
      configRoot: path.join(home, '.zcode', 'cli'), executablePath: oldExecutable, appPath,
      agentId: 'agent-zcode-main-switch', supportedCapability: 3,
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
      metadata: { distribution: {
        distributionId: 'dev.zcode.app', executableRealpath: oldExecutable,
        packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
        capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:${surface.fingerprint}`,
      } },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      expect(composition.service.snapshot().installations[0].manageable).toBe(true)
      fs.writeFileSync(newExecutable, 'signed-new-main', { mode: 0o700 })
      fs.writeFileSync(infoPath, plist('New'))

      await expect(composition.service.previewConnect(['zcode-main-switch']))
        .rejects.toThrow(/live distribution trust|trust proof|not enabled/i)
      expect(inspectAppSignature).not.toHaveBeenCalled()
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a freshly scanned 0644 Desktop main executable visible but unmanageable', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-mode-scan-')))
    const home = path.join(root, 'home')
    const appRoot = path.join(home, 'Applications')
    const appPath = path.join(appRoot, 'ZCode.app')
    const infoPath = path.join(appPath, 'Contents', 'Info.plist')
    const executable = path.join(appPath, 'Contents', 'MacOS', 'ZCode')
    const configRoot = path.join(home, '.zcode', 'cli')
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, 'signed-main', { mode: 0o700 })
    fs.writeFileSync(infoPath, [
      '<plist><dict>',
      '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
      '<key>CFBundleExecutable</key><string>ZCode</string>',
      '</dict></plist>',
    ].join(''))
    const desktopFs = physicalDiscoveryFileSystem()
    const stableDependencies: DiscoveryDependencies = {
      fs: desktopFs,
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      inspectAppSignature: async (_targetPath, options) => {
        await options.beforeFinalVerification?.()
        return {
          valid: true,
          identifier: 'dev.zcode.app',
          teamIdentifier: '8A5X4JJ39T',
          cdHash: '0123456789abcdef0123456789abcdef01234567',
          designatedRequirement: 'identifier "dev.zcode.app" and anchor apple generic',
          verificationBoundary: 'strict_final',
        }
      },
    }
    const surface = await inspectStableDesktopBundleSurface(stableDependencies, appPath, 2_000)
    const scanner = {
      scan: () => discoverLocalP0Agents({
        homeDir: home,
        osUserIdentity: 'usr_fixture_1234',
        applicationRoots: [appRoot],
        operationTimeoutMs: 2_000,
      }, stableDependencies),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root, 'zcode-desktop')
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(home),
      adapters: new Map([['zcode-desktop', fake.host]]),
      enabledAdapterIds: ['zcode-desktop'],
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies: stableDependencies,
      scanner,
      observeOnly: false,
      startRuntime: false,
    })
    composition.repository.upsertDiscoveredInstallation({
      id: 'zcode-mode-scan', family: 'zcode', hostVariant: 'zcode-desktop',
      installKey: 'zcode:mode-scan', distributionId: 'dev.zcode.app', provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234', displayName: 'ZCode', configRoot,
      executablePath: executable, appPath, agentId: 'agent-zcode-mode-scan', supportedCapability: 3,
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
      metadata: { distribution: {
        distributionId: 'dev.zcode.app', executableRealpath: executable,
        packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
        capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:${surface.fingerprint}`,
      } },
    })
    try {
      expect(composition.service.snapshot().installations[0].manageable).toBe(true)
      fs.chmodSync(executable, 0o644)

      const result = await composition.service.scan()
      expect(result.unresolved).toContainEqual(expect.objectContaining({
        hostVariants: ['zcode-desktop'],
        reason: 'surface_identity_unproven',
      }))
      expect(result.snapshot.installations[0]).toMatchObject({
        id: 'zcode-mode-scan',
        manageable: false,
        statusReason: 'detect_only',
      })
      expect(composition.service.detail('zcode-mode-scan').installation.manageable).toBe(false)
      await expect(composition.service.previewConnect(['zcode-mode-scan']))
        .rejects.toThrow('managed integration is not enabled')
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['claude-code-native', 'claude', '.local/share/claude/versions/2.1.246', '2.1.246'],
    ['kimi-code-native', 'kimi', '.kimi-code/bin/kimi', '1.20.0'],
  ] as const)('persists an unaccepted %s native version as detect-only while catalog support remains managed', async (
    catalogId,
    command,
    executableRelativePath,
    version,
  ) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-native-detect-only-')))
    const home = path.join(root, 'home')
    const executable = path.join(home, executableRelativePath)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, 'native-channel', { mode: 0o700 })
    const discoveryDependencies: DiscoveryDependencies = {
      fs: physicalDiscoveryFileSystem(),
      which: async candidate => candidate === command ? executable : undefined,
      execVersion: async () => ({ exitCode: 0, stdout: version, stderr: '' }),
    }
    const scanner = {
      scan: () => discoverLocalP0Agents({
        homeDir: home,
        osUserIdentity: 'usr_fixture_1234',
        applicationRoots: [],
        operationTimeoutMs: 2_000,
      }, discoveryDependencies),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    const options = {
      homeDir: home,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(home),
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies,
      scanner,
      observeOnly: false,
      startRuntime: false,
    } as const
    const first = createProductionAgentIntegrationComposition(db, options)
    let installationId: string
    try {
      const scan = await first.service.scan()
      const installation = scan.snapshot.installations.find(item => item.hostVariant === catalogId)!
      installationId = installation.id
      expect(installation).toMatchObject({
        manageable: false,
        statusReason: 'detect_only',
      })
      expect(first.service.supportCatalog()
        .flatMap(product => product.variants)
        .find(variant => variant.id === catalogId)).toMatchObject({
          hostKind: 'cli',
          maturity: 'managed',
          maximumAccessLevel: 'complete',
        })
      expect(scan.snapshot.installations).not.toContainEqual(expect.objectContaining({
        hostVariant: catalogId === 'claude-code-native' ? 'claude-code-cli' : 'kimi-code-cli',
      }))
      await expect(first.service.previewConnect([installationId]))
        .rejects.toThrow('managed integration is not enabled')
    } finally {
      first.runtime.stop()
    }

    const rebuilt = createProductionAgentIntegrationComposition(db, options)
    try {
      expect(rebuilt.service.snapshot().installations).toContainEqual(expect.objectContaining({
        id: installationId,
        hostVariant: catalogId,
        manageable: false,
        statusReason: 'detect_only',
      }))
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      rebuilt.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a native Kimi Installation probe-uncertain when its config root becomes inaccessible', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-native-probe-uncertain-')))
    const home = path.join(root, 'home')
    const executable = path.join(home, '.kimi-code', 'bin', 'kimi')
    const configRoot = path.join(home, '.kimi-code')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, 'native-kimi', { mode: 0o700 })
    const physical = physicalDiscoveryFileSystem()
    let configRootInaccessible = false
    const discoveryDependencies: DiscoveryDependencies = {
      fs: {
        ...physical,
        lstat: async targetPath => {
          if (configRootInaccessible && targetPath === configRoot) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
          }
          return physical.lstat(targetPath)
        },
      },
      which: async command => command === 'kimi' ? executable : undefined,
      execVersion: async () => ({ exitCode: 0, stdout: '1.20.0', stderr: '' }),
    }
    const scanner = {
      scan: () => discoverLocalP0Agents({
        homeDir: home,
        osUserIdentity: 'usr_fixture_1234',
        applicationRoots: [],
        operationTimeoutMs: 2_000,
      }, discoveryDependencies),
    }
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(home),
      scanner,
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies,
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const first = await composition.service.scan()
      const installation = first.snapshot.installations.find(item => item.hostVariant === 'kimi-code-native')!
      expect(composition.repository.getInstallation(installation.id)).toMatchObject({
        health_state: 'discovered',
      })

      configRootInaccessible = true
      const second = await composition.service.scan()

      expect(second.unresolved).toContainEqual(expect.objectContaining({
        hostVariants: ['kimi-code-native'],
        reason: 'probe_inaccessible',
      }))
      expect(composition.repository.getInstallation(installation.id)).toMatchObject({
        health_state: 'inaccessible',
        status_reason: 'verification_stale',
      })
      expect(db.prepare(`
        SELECT kind FROM agent_integration_events
        WHERE installation_id = ? AND kind = 'host_probe_uncertain'
      `).get(installation.id)).toEqual({ kind: 'host_probe_uncertain' })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a signed Desktop row without an exact main executable detect-only and creates no write state', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-app-no-executable-')))
    const home = path.join(root, 'home')
    const appPath = path.join(root, 'apps', 'ZCode.app')
    fs.mkdirSync(appPath, { recursive: true, mode: 0o700 })
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(home),
      enabledAdapterIds: ['zcode-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    composition.repository.upsertDiscoveredInstallation({
      id: 'zcode-no-executable',
      family: 'zcode',
      hostVariant: 'zcode-desktop',
      installKey: 'zcode:no-executable',
      distributionId: 'dev.zcode.app',
      provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234',
      displayName: 'ZCode',
      configRoot: path.join(home, '.zcode', 'cli'),
      appPath,
      agentId: 'agent-zcode-no-executable',
      supportedCapability: 3,
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
      metadata: {
        distribution: {
          distributionId: 'dev.zcode.app',
          packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
        },
      },
    })
    const inspectAppSignature = vi.fn(async () => ({
      valid: true,
      identifier: 'dev.zcode.app',
      teamIdentifier: '8A5X4JJ39T',
      cdHash: '0123456789abcdef0123456789abcdef01234567',
      designatedRequirement: 'identifier "dev.zcode.app" and anchor apple generic',
      verificationBoundary: 'strict_final' as const,
    }))
    const attest = createProductionLiveTrustAttestor({
      fs: {
        lstat: async () => ({ kind: 'directory' }),
        realpath: async targetPath => targetPath,
        readTextFile: async () => '',
        readStableFileSnapshot,
        readStableFileFingerprint,
      },
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      inspectAppSignature,
    })
    try {
      const row = composition.repository.getInstallation('zcode-no-executable')!
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'release_version_unverified',
      })
      expect(composition.service.detail(row.id).installation.manageable).toBe(false)
      expect(await attest(row)).toBeNull()
      expect(inspectAppSignature).not.toHaveBeenCalled()
      await expect(composition.service.previewConnect([row.id]))
        .rejects.toThrow('managed integration is unavailable: release_version_unverified')
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses recursive strict codesign verification at both Desktop trust boundaries', async () => {
    const appPath = '/Applications/ZCode.app'
    const calls: string[][] = []
    const codesign = vi.fn(async (args: readonly string[]) => {
      calls.push([...args])
      if (args.includes('--verbose=4')) return {
        stdout: '',
        stderr: 'Identifier=dev.zcode.app\nTeamIdentifier=8A5X4JJ39T\nCDHash=0123456789abcdef0123456789abcdef01234567\n',
      }
      if (args.includes('-r-')) return {
        stdout: '',
        stderr: 'designated => identifier "dev.zcode.app" and anchor apple generic\n',
      }
      return { stdout: '', stderr: '' }
    })

    await expect(inspectMacAppSignature(appPath, { timeoutMs: 2_000 }, codesign))
      .resolves.toMatchObject({ valid: true, verificationBoundary: 'strict_final' })
    expect(calls.filter(args => args.includes('--verify'))).toEqual([
      ['--verify', '--deep', '--strict', appPath],
      ['--verify', '--deep', '--strict', appPath],
    ])
  })

  it.each([
    'replace_app',
    'replace_executable',
    'chmod_executable',
    'symlink_executable',
  ] as const)('blocks Desktop %s inside signature await before consent or mutation intent', async scenario => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-app-race-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    const executable = await discoverUiAuditZcode(repository, root)
    const appPath = path.join(root, 'apps', 'ZCode.app')
    const fake = adapter(root, 'zcode-desktop')
    let signatureCalls = 0
    const mutatePhysicalApp = () => {
      if (scenario === 'replace_app') {
        fs.renameSync(appPath, `${appPath}.signed-old`)
        fs.mkdirSync(path.dirname(executable), { recursive: true })
        fs.writeFileSync(executable, '#!/bin/sh\necho unsigned-replacement\n', { mode: 0o700 })
      } else if (scenario === 'replace_executable') {
        const replacement = path.join(root, 'replacement-zcode')
        fs.writeFileSync(replacement, '#!/bin/sh\necho replaced\n', { mode: 0o700 })
        fs.renameSync(replacement, executable)
      } else if (scenario === 'chmod_executable') {
        fs.chmodSync(executable, 0o600)
      } else {
        const external = path.join(root, 'external-zcode')
        fs.writeFileSync(external, '#!/bin/sh\necho external\n', { mode: 0o700 })
        fs.renameSync(executable, `${executable}.signed-old`)
        fs.symlinkSync(external, executable)
      }
    }
    const discoveryDependencies = {
      fs: physicalDiscoveryFileSystem(),
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      inspectAppSignature: async (_targetPath: string, options: { timeoutMs: number; beforeFinalVerification?: () => Promise<void> }) => {
        signatureCalls += 1
        if (signatureCalls === 2) mutatePhysicalApp()
        await options.beforeFinalVerification?.()
        return {
          valid: true,
          identifier: 'dev.zcode.app',
          teamIdentifier: '8A5X4JJ39T',
          cdHash: '0123456789abcdef0123456789abcdef01234567',
          designatedRequirement: 'identifier "dev.zcode.app" and anchor apple generic',
          verificationBoundary: 'strict_final' as const,
        }
      },
      finalVerifyAppSignatureSync: () => zcodeSignature(),
    }
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtimeContext(home),
      adapters: new Map([['zcode-desktop', fake.host]]),
      enabledAdapterIds: ['zcode-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies,
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const preview = await composition.service.previewConnect(['zcode-ui-proof'])
      const result = await composition.service.applyConnect(preview.planHash, ['zcode-ui-proof'])

      expect(result.results[0]).toMatchObject({ installationId: 'zcode-ui-proof', status: 'failed' })
      expect(signatureCalls).toBe(2)
      expect(fake.apply).not.toHaveBeenCalled()
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })

    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['preview', 'ATTACKER00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['effect', '8A5X4JJ39T', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  ] as const)('rejects a valid whole-App replacement inside the final %s attestor boundary', async (
    boundary,
    replacementTeam,
    replacementCdHash,
  ) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-final-app-replace-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    await discoverUiAuditZcode(repository, root)
    const appPath = path.join(root, 'apps', 'ZCode.app')
    const fake = adapter(root, 'zcode-desktop')
    let armed = boundary === 'preview'
    let replaced = false
    const replaceWithValidApp = () => {
      if (replaced) return
      replaced = true
      fs.renameSync(appPath, `${appPath}.frozen-old`)
      const executable = path.join(appPath, 'Contents', 'MacOS', 'ZCode')
      fs.mkdirSync(path.dirname(executable), { recursive: true })
      fs.writeFileSync(executable, '#!/bin/sh\necho valid-replacement\n', { mode: 0o700 })
      fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), [
        '<plist><dict>',
        '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
        '<key>CFBundleShortVersionString</key><string>2.0.0</string>',
        '<key>CFBundleExecutable</key><string>ZCode</string>',
        '</dict></plist>',
      ].join(''))
    }
    const discoveryDependencies: DiscoveryDependencies = {
      fs: physicalDiscoveryFileSystem(),
      which: async () => undefined,
      execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      inspectAppSignature: async (_targetPath, options) => {
        await options.beforeFinalVerification?.()
        return zcodeSignature()
      },
      finalVerifyAppSignatureSync: () => {
        if (armed) replaceWithValidApp()
        return armed
          ? zcodeSignature({ teamIdentifier: replacementTeam, cdHash: replacementCdHash })
          : zcodeSignature()
      },
    }
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtimeContext(home),
      adapters: new Map([['zcode-desktop', fake.host]]),
      enabledAdapterIds: ['zcode-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
      fixtureMode: 'isolated_ui_audit',
      discoveryDependencies,
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      if (boundary === 'preview') {
        await expect(composition.service.previewConnect(['zcode-ui-proof']))
          .rejects.toThrow('live distribution trust could not be proved')
        expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
        expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
        expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
      } else {
        const readBack = deferredBarrier()
        const originalReadBack = fake.host.readBack.bind(fake.host)
        fake.host.readBack = vi.fn(async (...args) => {
          readBack.markStarted()
          await readBack.wait
          return originalReadBack(...args)
        })
        const preview = await composition.service.previewConnect(['zcode-ui-proof'])
        const applying = composition.service.applyConnect(preview.planHash, ['zcode-ui-proof'])
        await readBack.started
        armed = true
        readBack.release()
        await expect(applying).resolves.toEqual(expect.objectContaining({
          results: expect.arrayContaining([expect.objectContaining({
            installationId: 'zcode-ui-proof',
            status: 'needs_recovery',
          })]),
        }))
      }
      expect(replaced).toBe(true)
      expect(fake.apply).not.toHaveBeenCalled()
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['resources_app_asar', 'Contents/Resources/app.asar'],
    ['nested_framework', 'Contents/Frameworks/Helper.framework/Versions/A/Helper'],
    ['nested_plugin', 'Contents/PlugIns/Test.plugin/Contents/MacOS/Test'],
  ] as const)('blocks %s mutation after every codesign await window before consent or mutation intent', async (_label, relativeTarget) => {
    for (const mutationWindow of [1, 2, 3, 4, 5, 6, 7]) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-app-nested-race-')))
      const home = path.join(root, 'home')
      const appData = path.join(root, 'app-data')
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(appData, { recursive: true })
      const db = new Database(':memory:')
      ensureSchema(db)
      const repository = new AgentIntegrationRepository(db)
      await discoverUiAuditZcode(repository, root)
      const appPath = path.join(root, 'apps', 'ZCode.app')
      const nestedTarget = path.join(appPath, relativeTarget)
      fs.mkdirSync(path.dirname(nestedTarget), { recursive: true })
      fs.writeFileSync(nestedTarget, 'signed-content', { mode: relativeTarget.endsWith('/Helper') || relativeTarget.endsWith('/Test') ? 0o700 : 0o600 })
      const original = fs.readFileSync(nestedTarget)
      const fake = adapter(root, 'zcode-desktop')
      let calls = 0
      const codesign = vi.fn(async (args: readonly string[]) => {
        calls += 1
        if (!fs.readFileSync(nestedTarget).equals(original)) throw new Error('code object is not signed at all')
        let result = { stdout: '', stderr: '' }
        if (args.includes('--verbose=4')) result = {
          stdout: '',
          stderr: 'Identifier=dev.zcode.app\nTeamIdentifier=8A5X4JJ39T\nCDHash=0123456789abcdef0123456789abcdef01234567\n',
        }
        if (args.includes('-r-')) result = {
          stdout: '',
          stderr: 'designated => identifier "dev.zcode.app" and anchor apple generic\n',
        }
        if (mutationWindow <= 5 && calls === 6 + mutationWindow) {
          fs.writeFileSync(nestedTarget, 'tampered-content')
        }
        return result
      })
      const discoveryDependencies = {
        fs: physicalDiscoveryFileSystem(),
        which: async () => undefined,
        execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
        inspectAppSignature: async (targetPath: string, options: { timeoutMs: number; beforeFinalVerification?: () => Promise<void> }) => {
          const signature = await inspectMacAppSignature(targetPath, {
            ...options,
            beforeFinalVerification: async () => {
              await options.beforeFinalVerification?.()
              if (mutationWindow === 6 && calls === 11) {
                fs.writeFileSync(nestedTarget, 'tampered-content')
              }
            },
          }, codesign)
          if (mutationWindow === 7 && calls === 12) {
            fs.writeFileSync(nestedTarget, 'tampered-content')
          }
          return signature
        },
        finalVerifyAppSignatureSync: () => {
          if (!fs.readFileSync(nestedTarget).equals(original)) {
            throw new Error('code object is not signed at all')
          }
          return zcodeSignature()
        },
      }
      const composition = createProductionAgentIntegrationComposition(db, {
        homeDir: home,
        applicationDataDir: appData,
        runtimeContext: runtimeContext(home),
        adapters: new Map([['zcode-desktop', fake.host]]),
        enabledAdapterIds: ['zcode-desktop'],
        observeOnly: false,
        startRuntime: false,
        notifications: { deliver: vi.fn() },
        fixtureMode: 'isolated_ui_audit',
        discoveryDependencies,
      })
      const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
      try {
        const preview = await composition.service.previewConnect(['zcode-ui-proof'])
        const result = await composition.service.applyConnect(preview.planHash, ['zcode-ui-proof'])
        expect(result.results[0]).toMatchObject({ installationId: 'zcode-ui-proof', status: 'failed' })
        // Each injected drift is rejected by the immediately following
        // recursive verification boundary, including the seventh window after
        // the first complete receipt has returned.
        expect(calls).toBeGreaterThanOrEqual(mutationWindow)
        expect(fake.apply).not.toHaveBeenCalled()
        expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
        expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
        expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
      } finally {
        unbind()
        composition.runtime.stop()
        db.close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })
})

describe('isolated UI audit live trust barriers', () => {
  async function compositionFixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-live-proof-')))
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    fs.mkdirSync(path.join(root, 'user-data'), { recursive: true })
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    const executable = await discoverUiAuditZcode(repository, root, 'app-surface:zcode-desktop')
    const fake = adapter(root, 'zcode-desktop')
    const options = createUiAuditAgentIntegrationOptions(db, root)
    const runtime = runtimeContext(path.join(root, 'home'))
    runtime.applicationDataDir = path.join(root, 'user-data')
    const composition = createProductionAgentIntegrationComposition(db, {
      ...options,
      runtimeContext: runtime,
      adapters: new Map([['zcode-desktop', fake.host]]),
      enabledAdapterIds: ['zcode-desktop'],
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    return { root, db, executable, fake, composition, unbind }
  }

  it('rejects an in-place ZCode executable replacement before consent is created', async () => {
    const fixture = await compositionFixture()
    try {
      const preview = await fixture.composition.service.previewConnect(['zcode-ui-proof'])
      fs.writeFileSync(fixture.executable, '#!/bin/sh\necho replaced-before-consent\n')

      const result = await fixture.composition.service.applyConnect(preview.planHash, ['zcode-ui-proof'])

      expect(result.results[0]).toMatchObject({ installationId: 'zcode-ui-proof', status: 'failed' })
      expect(fixture.fake.apply).not.toHaveBeenCalled()
      expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(fixture.db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      fixture.unbind()
      fixture.composition.runtime.stop()
      fixture.db.close()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a ZCode executable replacement after precondition read-back and before effect', async () => {
    const fixture = await compositionFixture()
    const readBack = deferredBarrier()
    const originalReadBack = fixture.fake.host.readBack.bind(fixture.fake.host)
    fixture.fake.host.readBack = vi.fn(async (...args) => {
      readBack.markStarted()
      await readBack.wait
      return originalReadBack(...args)
    })
    try {
      const preview = await fixture.composition.service.previewConnect(['zcode-ui-proof'])
      const applying = fixture.composition.service.applyConnect(preview.planHash, ['zcode-ui-proof'])
      await readBack.started
      fs.writeFileSync(fixture.executable, '#!/bin/sh\necho replaced-before-effect\n')
      readBack.release()

      const result = await applying
      expect(result.results[0]).toMatchObject({ installationId: 'zcode-ui-proof', status: 'needs_recovery' })
      expect(fixture.fake.apply).not.toHaveBeenCalled()
      expect(fixture.db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'needs_recovery' })
    } finally {
      readBack.release()
      fixture.unbind()
      fixture.composition.runtime.stop()
      fixture.db.close()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})

function discoverCursor(composition: ReturnType<typeof createProductionAgentIntegrationComposition>, root: string): void {
  composition.repository.upsertDiscoveredInstallation({
    id: 'cursor-1',
    family: 'cursor',
    hostVariant: 'cursor-desktop',
    installKey: 'cursor:test',
    distributionId: 'cursor',
    provenance: 'fixture',
    osUserIdentity: 'usr_fixture_1234',
    displayName: 'Cursor',
    configRoot: path.join(root, '.cursor'),
    agentId: 'agent-cursor',
    supportedCapability: 3,
    lastDetectedAt: '2026-08-25T00:00:00.000Z',
  })
}

function discoverCursorWithPackageProvenance(
  composition: ReturnType<typeof createProductionAgentIntegrationComposition>,
  root: string,
  packageProvenance: string | null,
  lastDetectedAt = '2026-08-25T00:00:00.000Z',
): void {
  composition.repository.upsertDiscoveredInstallation({
    id: 'cursor-1',
    family: 'cursor',
    hostVariant: 'cursor-desktop',
    installKey: 'cursor:test',
    distributionId: 'cursor',
    provenance: 'fixture',
    osUserIdentity: 'usr_fixture_1234',
    displayName: 'Cursor',
    configRoot: path.join(root, '.cursor'),
    agentId: 'agent-cursor',
    supportedCapability: 3,
    lastDetectedAt,
    metadata: { distribution: { distributionId: 'cursor', packageProvenance } },
  })
}

function hasFixturePackageTrust(row: { metadata_json: string }): boolean {
  const metadata = JSON.parse(row.metadata_json) as {
    distribution?: { packageProvenance?: string | null }
  }
  return metadata.distribution?.packageProvenance === 'fixture:trusted'
}

function deferredBarrier(): {
  started: Promise<void>
  release: () => void
  markStarted: () => void
  wait: Promise<void>
} {
  let markStarted!: () => void
  let release!: () => void
  return {
    started: new Promise<void>(resolve => { markStarted = resolve }),
    release: () => release(),
    markStarted: () => markStarted(),
    wait: new Promise<void>(resolve => { release = resolve }),
  }
}

function managedCursorCandidate(
  root: string,
  artifactId = 'artifact-cursor-memory',
  installationId = 'cursor-1',
): ManagedReconcileCandidate {
  const installation: CoordinatorInstallation = {
    id: installationId,
    displayName: 'Cursor',
    desiredState: 'managed',
    agentId: `agent-${installationId}`,
    identity: {
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_1234',
      productFamilyId: 'cursor',
      hostVariant: 'cursor-desktop',
      canonicalConfigRoot: path.join(root, '.cursor'),
      explicitProfile: 'default',
      distribution: { distributionId: 'com.todesktop.230313mzl4w4u92' },
      installKey: `cursor:test:${installationId}`,
    },
  }
  return {
    artifactId,
    componentKey: 'memory_tools',
    componentName: 'Memory tools',
    desiredCapability: 2,
    consentId: 'consent-cursor',
    ownedFragmentHash: 'owned-fragment',
    desiredFragmentHash: 'desired-fragment',
    installation,
    affectedConsumers: [{ installationId, displayName: 'Cursor' }],
  }
}

function freezeCandidateSurface(
  composition: ReturnType<typeof createProductionAgentIntegrationComposition>,
  candidate: ManagedReconcileCandidate,
): ManagedReconcileCandidate {
  const row = composition.repository.getInstallation(candidate.installation.id)
  if (!row) throw new Error(`fixture Installation is missing: ${candidate.installation.id}`)
  return {
    ...candidate,
    installation: {
      ...candidate.installation,
      identity: {
        ...candidate.installation.identity,
        distribution: persistedDistribution(row),
      },
    },
  }
}

describe('production Agent integration composition', () => {
  it.each([
    ['canManageInstallation', { canManageInstallation: () => true }],
    ['liveTrustAttestor', { liveTrustAttestor: async () => 'a'.repeat(64) }],
    ['codexHookTrustVerifier', { codexHookTrustVerifier: async () => null }],
    ['discoveryDependencies', {
      discoveryDependencies: {
        fs: physicalDiscoveryFileSystem(),
        which: async () => undefined,
        execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'not used' }),
      },
    }],
  ] as const)('rejects the %s trust-authority seam outside isolated fixture mode', (seam, injected) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-trust-seam-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    expect(() => createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      startRuntime: false,
      ...injected,
    })).toThrow(`production_trust_seam_injection_forbidden:${seam}`)
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('blocks a pre-0.2.92 eligible row before the first scan and during recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-pre-manifest-row-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      startRuntime: false,
    })
    const candidate = managedCursorCandidate(root).installation
    composition.repository.upsertDiscoveredInstallation({
      id: candidate.id,
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: candidate.identity.installKey,
      distributionId: 'com.todesktop.230313mzl4w4u92',
      provenance: 'app_bundle',
      osUserIdentity: candidate.identity.osUserIdentity,
      displayName: candidate.displayName,
      configRoot: candidate.identity.canonicalConfigRoot,
      executablePath: path.join(root, 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
      appPath: path.join(root, 'Cursor.app'),
      detectedVersion: '3.10.20',
      versionDetectionMethod: 'bundle_short_version',
      agentId: candidate.agentId,
      supportedCapability: 4,
      lastDetectedAt: '2026-08-25T00:00:00.000Z',
      metadata: {
        distribution: {
          distributionId: 'com.todesktop.230313mzl4w4u92',
          packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9',
        },
        managementEligibility: freshCliManagementEligibility(),
      },
    })
    let replayAllowed: boolean | Promise<boolean> | undefined
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockImplementation(async options => {
      replayAllowed = options?.canReplayEffect?.(candidate)
      return []
    })
    try {
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'release_version_not_accepted',
      })
      await expect(composition.service.previewConnect([candidate.id]))
        .rejects.toThrow('managed integration is unavailable: release_version_not_accepted')
      await composition.runtime.markScanCompleted()
      expect(await replayAllowed).toBe(false)
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_mutations').get()).toEqual({ count: 0 })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('defers the first discovery scan until the renderer locale handshake starts the runtime', async () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-agent-locale-start-'))
    const scanner = { scan: vi.fn(async () => ({ installations: [], unresolved: [], diagnostics: [] })) }
    try {
      createProductionAgentIntegrationService(db, {
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        runtimeContext: runtimeContext(root),
        scanner,
        observeOnly: true,
        startRuntime: false,
      })
      expect(scanner.scan).not.toHaveBeenCalled()
      await startProductionAgentIntegrationRuntime()
      expect(scanner.scan).toHaveBeenCalledTimes(1)
    } finally {
      stopProductionAgentIntegrationRuntime()
      fs.rmSync(root, { recursive: true, force: true })
      db.close()
    }
  })

  it('keeps unproven and stale-metadata CLIs unmanageable until a fresh exact eligibility scan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-trust-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['codex-cli'],
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const base = {
        id: 'codex-unproven',
        family: 'codex',
        hostVariant: 'codex-cli' as const,
        installKey: 'codex:unproven',
        distributionId: 'cli:codex-cli',
        provenance: 'command:PATH:codex',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'Codex CLI',
        configRoot: path.join(root, '.codex'),
        executablePath: path.join(root, 'bin', 'codex'),
        agentId: 'agent-codex-unproven',
        supportedCapability: 3,
        lastDetectedAt: '2026-08-25T00:00:00.000Z',
      }
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        metadata: { distribution: { packageProvenance: 'executable:unproven' } },
      })
      expect(composition.service.snapshot().installations[0].manageable).toBe(false)

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        metadata: { distribution: { packageProvenance: 'npm_metadata:@openai/codex' } },
        lastDetectedAt: '2026-08-25T00:01:00.000Z',
      })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'executable_metadata_unavailable',
      })
      expect(composition.service.detail(base.id).installation).toMatchObject({
        manageable: false,
        statusReason: 'executable_metadata_unavailable',
      })
      await expect(composition.service.previewConnect([base.id]))
        .rejects.toThrow('managed integration is unavailable: executable_metadata_unavailable')
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        metadata: {
          distribution: { packageProvenance: 'npm_metadata:@openai/codex' },
          managementEligibility: {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: true,
            executableSizeBytes: 1_024,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
        },
        lastDetectedAt: '2026-08-25T00:02:00.000Z',
      })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'executable_metadata_unavailable',
      })
      expect(composition.service.detail(base.id).installation).toMatchObject({
        manageable: false,
        statusReason: 'executable_metadata_unavailable',
      })
      await expect(composition.service.previewConnect([base.id]))
        .rejects.toThrow('managed integration is unavailable: executable_metadata_unavailable')
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        metadata: {
          distribution: {
            executableRealpath: base.executablePath,
            packageProvenance: 'npm_metadata:@openai/codex',
          },
          managementEligibility: freshCliManagementEligibility(),
        },
        lastDetectedAt: '2026-08-25T00:03:00.000Z',
      })
      expect(composition.service.snapshot().installations[0].manageable).toBe(true)
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('makes a previously trusted CLI unmanageable after a fresh probe becomes inaccessible', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-cli-inaccessible-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      enabledAdapterIds: ['codex-cli'],
      observeOnly: false,
      startRuntime: false,
      scanner: {
        scan: async () => ({
          installations: [],
          unresolved: [{
            catalogIds: ['codex-cli'],
            reason: 'probe_inaccessible' as const,
            summary: 'fixture executable probe denied',
            evidence: [],
          }],
          diagnostics: [],
        }),
      },
    })
    composition.repository.upsertDiscoveredInstallation({
      id: 'codex-cli-inaccessible', family: 'codex', hostVariant: 'codex-cli',
      installKey: 'codex:cli-inaccessible', distributionId: 'cli:codex-cli',
      provenance: 'fixture', osUserIdentity: 'usr_fixture_1234', displayName: 'Codex CLI',
      configRoot: path.join(root, '.codex'), executablePath: path.join(root, 'bin', 'codex'),
      agentId: 'agent-codex-cli-inaccessible', supportedCapability: 3,
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
      metadata: {
        managementEligibility: freshCliManagementEligibility(),
        distribution: {
          distributionId: 'cli:codex-cli',
          executableRealpath: path.join(root, 'bin', 'codex'),
          packageProvenance: 'npm_metadata:@openai/codex',
        },
      },
    })
    try {
      expect(composition.service.snapshot().installations[0].manageable).toBe(true)
      const scan = await composition.service.scan()
      expect(scan.snapshot.installations[0]).toMatchObject({
        id: 'codex-cli-inaccessible',
        manageable: false,
        statusReason: 'detect_only',
      })
      expect(composition.service.detail('codex-cli-inaccessible').installation.manageable).toBe(false)
      await expect(composition.service.previewConnect(['codex-cli-inaccessible']))
        .rejects.toThrow('managed integration is not enabled')
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('presents oversized official CLIs as detected but unmanageable and rejects preview before consent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-size-eligibility-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['opencode-v1-cli'],
      observeOnly: false,
      startRuntime: false,
    })
    const base = {
      id: 'opencode-size-boundary',
      family: 'opencode',
      hostVariant: 'opencode-v1-cli' as const,
      installKey: 'opencode:size-boundary',
      distributionId: 'cli:opencode-v1-cli',
      provenance: 'command:PATH:opencode',
      osUserIdentity: 'usr_fixture_1234',
      displayName: 'OpenCode',
      configRoot: path.join(root, '.config', 'opencode'),
      executablePath: path.join(root, 'bin', 'opencode'),
      agentId: 'agent-opencode-size-boundary',
      supportedCapability: 3,
    }
    try {
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        lastDetectedAt: '2026-08-26T00:00:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: base.executablePath,
            packageProvenance: 'npm_metadata:opencode-ai',
          },
          managementEligibility: {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: true,
            executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
        },
      })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: true,
        statusGroup: 'awaiting_connection',
      })

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        lastDetectedAt: '2026-08-26T00:01:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: base.executablePath,
            packageProvenance: 'npm_metadata:opencode-ai',
          },
          managementEligibility: {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: false,
            reason: 'executable_proof_too_large',
            executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES + 1,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
        },
      })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusGroup: 'disconnected',
        statusReason: 'executable_proof_too_large',
      })
      await expect(composition.service.previewConnect(['opencode-size-boundary']))
        .rejects.toThrow('managed integration is unavailable: executable_proof_too_large')
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        lastDetectedAt: '2026-08-26T00:02:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: base.executablePath,
            packageProvenance: 'npm_metadata:opencode-ai',
          },
          managementEligibility: {
            schemaVersion: 0,
            eligible: true,
            executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES + 1,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
        },
      })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'executable_metadata_unavailable',
      })

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        lastDetectedAt: '2026-08-26T00:03:00.000Z',
        metadata: {
          distribution: { packageProvenance: 'npm_metadata:opencode-ai' },
          managementEligibility: {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: true,
            executableSizeBytes: 1_024,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES - 1,
          },
        },
      })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'executable_metadata_unavailable',
      })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('manages maintained Earendil Pi while keeping historical Mario and third-party Pi read-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-pi-trust-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['pi-official-cli'],
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const base = {
        id: 'pi-official',
        family: 'pi-official',
        hostVariant: 'pi-official-cli' as const,
        installKey: 'pi-official:test',
        provenance: 'command:PATH:pi',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'Pi',
        configRoot: path.join(root, '.pi', 'agent'),
        executablePath: path.join(root, 'bin', 'pi'),
        supportedCapability: 4,
      }
      for (const [index, candidate] of [
        { packageName: '@mariozechner/pi-coding-agent', manageable: false },
        { packageName: '@earendil-works/pi-coding-agent', manageable: true },
      ].entries()) {
        const { packageName, manageable } = candidate
        composition.repository.upsertDiscoveredInstallation({
          ...base,
          distributionId: `pi-official:${packageName}`,
          metadata: {
            managementEligibility: manageable
              ? freshCliManagementEligibility()
              : {
                  ...freshCliManagementEligibility(),
                  eligible: false,
                  reason: 'distribution_not_managed',
                },
            distribution: {
              executableRealpath: base.executablePath,
              packageProvenance: `npm_metadata:${packageName}`,
            },
          },
          lastDetectedAt: `2026-08-25T00:0${index}:00.000Z`,
        })
        expect(composition.service.snapshot().installations[0]).toMatchObject({
          manageable,
          statusGroup: manageable ? 'awaiting_connection' : 'disconnected',
          statusReason: manageable ? 'awaiting_consent' : 'incompatible',
        })
      }

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        distributionId: 'pi-official:pi-coding-agent',
        metadata: { distribution: { packageProvenance: 'npm_metadata:pi-coding-agent' } },
        lastDetectedAt: '2026-08-25T00:02:00.000Z',
      })
      expect(composition.service.snapshot().installations[0].manageable).toBe(false)
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not grant write authority to a CLI merely because it lives under a config root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-config-root-trust-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['opencode-v1-cli'],
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const executablePath = path.join(root, '.opencode', 'bin', 'opencode')
      composition.repository.upsertDiscoveredInstallation({
        id: 'opencode-config-root-binary',
        family: 'opencode',
        hostVariant: 'opencode-v1-cli',
        installKey: 'opencode:config-root-binary',
        distributionId: 'cli:opencode-v1-cli',
        provenance: 'command:PATH:opencode',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'OpenCode',
        configRoot: path.join(root, '.opencode'),
        executablePath,
        supportedCapability: 3,
        lastDetectedAt: '2026-08-25T00:00:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: executablePath,
            packageProvenance: 'executable:unproven',
          },
        },
      })
      expect(composition.service.snapshot().installations[0].manageable).toBe(false)

      composition.repository.upsertDiscoveredInstallation({
        id: 'opencode-config-root-binary',
        family: 'opencode',
        hostVariant: 'opencode-v1-cli',
        installKey: 'opencode:config-root-binary',
        distributionId: 'cli:opencode-v1-cli',
        provenance: 'command:PATH:opencode',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'OpenCode',
        configRoot: path.join(root, '.opencode'),
        executablePath,
        supportedCapability: 3,
        lastDetectedAt: '2026-08-25T00:01:00.000Z',
        metadata: {
          managementEligibility: freshCliManagementEligibility(),
          distribution: {
            executableRealpath: executablePath,
            packageProvenance: 'npm_metadata:opencode-ai',
          },
        },
      })
      expect(composition.service.snapshot().installations[0].manageable).toBe(true)
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('trusts only the official OpenCode V2 npm package and keeps standalone channels detect-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-opencode-v2-trust-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['opencode-v2-beta-cli'],
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const base = {
        id: 'opencode-v2',
        family: 'opencode',
        hostVariant: 'opencode-v2-beta-cli' as const,
        installKey: 'opencode:v2',
        distributionId: 'cli:opencode-v2-beta-cli',
        provenance: 'command:PATH:opencode2',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'OpenCode V2',
        configRoot: path.join(root, '.config', 'opencode'),
        executablePath: path.join(root, 'bin', 'opencode2'),
        supportedCapability: 4,
      }
      for (const [index, packageProvenance] of [
        `executable:${path.join(root, '.opencode', 'bin', 'opencode2')}`,
        'npm_metadata:opencode-ai',
        'npm_metadata:@opencode-ai/cli',
      ].entries()) {
        composition.repository.upsertDiscoveredInstallation({
          ...base,
          lastDetectedAt: `2026-08-25T00:0${index}:00.000Z`,
          metadata: {
            managementEligibility: freshCliManagementEligibility(),
            distribution: { executableRealpath: base.executablePath, packageProvenance },
          },
        })
        expect(composition.service.snapshot().installations[0].manageable).toBe(index === 2)
      }
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('trusts signed official ZCode Desktop but not bundle-only Desktop or the unofficial CLI', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-zcode-trust-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['zcode-desktop'],
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const base = {
        id: 'zcode-desktop',
        family: 'zcode',
        hostVariant: 'zcode-desktop' as const,
        installKey: 'zcode:desktop',
        distributionId: 'dev.zcode.app',
        provenance: 'app_bundle',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'ZCode Desktop',
        configRoot: path.join(root, '.zcode', 'cli'),
        appPath: path.join(root, 'Applications', 'ZCode.app'),
        executablePath: path.join(root, 'Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode'),
        supportedCapability: 4,
      }
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        lastDetectedAt: '2026-08-25T00:00:00.000Z',
        metadata: { distribution: { packageProvenance: 'app_bundle:dev.zcode.app' } },
      })
      expect(composition.service.snapshot().installations[0].manageable).toBe(false)

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        lastDetectedAt: '2026-08-25T00:01:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: base.executablePath,
            packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-zcode`,
          },
        },
      })
      expect(composition.service.snapshot().installations[0].manageable).toBe(true)

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        lastDetectedAt: '2026-08-25T00:01:30.000Z',
        metadata: {
          distribution: {
            executableRealpath: base.executablePath,
            packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-zcode`,
          },
          managementEligibility: {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: false,
            reason: 'release_version_not_accepted',
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
        },
      })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'release_version_not_accepted',
      })
      expect(composition.service.detail(base.id).installation).toMatchObject({
        manageable: false,
        statusReason: 'release_version_not_accepted',
      })

      composition.repository.upsertDiscoveredInstallation({
        id: 'zcode-cli',
        family: 'zcode',
        hostVariant: 'zcode-cli',
        installKey: 'zcode:cli',
        distributionId: 'cli:zcode-cli',
        provenance: 'command:PATH:zcode',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'ZCode Unofficial CLI',
        configRoot: path.join(root, '.zcode', 'cli'),
        supportedCapability: 4,
        lastDetectedAt: '2026-08-25T00:02:00.000Z',
        metadata: { distribution: { packageProvenance: 'executable:unofficial' } },
      })
      const unofficial = composition.service.snapshot().installations.find(item => item.id === 'zcode-cli')
      expect(unofficial?.manageable).toBe(false)
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires an approved signing Team for writable Desktop variants and keeps legacy migration-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-desktop-signing-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: [
        'claude-desktop-legacy', 'cursor-desktop', 'codex-desktop',
        'windsurf-desktop', 'qwenwork-desktop',
      ],
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const base = {
        provenance: 'app_bundle',
        osUserIdentity: 'usr_fixture_1234',
        supportedCapability: 3,
      }
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'claude-desktop',
        family: 'claude',
        hostVariant: 'claude-desktop-legacy',
        installKey: 'claude:desktop',
        distributionId: 'com.anthropic.claudefordesktop',
        displayName: 'Claude Desktop',
        configRoot: path.join(root, 'Library', 'Application Support', 'Claude'),
        appPath: path.join(root, 'Applications', 'Claude.app'),
        executablePath: path.join(root, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
        lastDetectedAt: '2026-08-25T00:00:00.000Z',
        metadata: { distribution: { packageProvenance: 'app_bundle:com.anthropic.claudefordesktop' } },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'cursor-desktop',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: 'cursor:desktop',
        distributionId: 'com.todesktop.230313mzl4w4u92',
        displayName: 'Cursor',
        configRoot: path.join(root, '.cursor'),
        appPath: path.join(root, 'Applications', 'Cursor.app'),
        executablePath: path.join(root, 'Applications', 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
        lastDetectedAt: '2026-08-25T00:01:00.000Z',
        metadata: { distribution: { packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:ATTACKER' } },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'codex-desktop',
        family: 'codex',
        hostVariant: 'codex-desktop',
        installKey: 'codex:desktop',
        distributionId: 'com.openai.codex',
        displayName: 'Codex Desktop',
        configRoot: path.join(root, '.codex'),
        appPath: path.join(root, 'Applications', 'ChatGPT.app'),
        executablePath: path.join(root, 'Applications', 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'),
        lastDetectedAt: '2026-08-25T00:02:00.000Z',
        metadata: { distribution: { packageProvenance: 'signed_app:com.openai.codex:UNVERIFIED' } },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'qwenwork-desktop',
        family: 'qwenwork',
        hostVariant: 'qwenwork-desktop',
        installKey: 'qwenwork:desktop',
        distributionId: 'cn.qwenwork.desktop.mac',
        displayName: 'QwenWork',
        configRoot: path.join(root, '.qwenworkcn'),
        appPath: path.join(root, 'Applications', 'QwenWorkCN.app'),
        executablePath: path.join(root, 'Applications', 'QwenWorkCN.app', 'Contents', 'MacOS', 'QwenWorkCN'),
        lastDetectedAt: '2026-08-25T00:02:30.000Z',
        metadata: { distribution: { packageProvenance: 'signed_app:cn.qwenwork.desktop.mac:UNVERIFIED' } },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'windsurf-desktop',
        family: 'windsurf',
        hostVariant: 'windsurf-desktop',
        installKey: 'windsurf:desktop',
        distributionId: 'com.exafunction.windsurf',
        displayName: 'Devin Desktop（原 Windsurf）',
        configRoot: path.join(root, '.config', 'devin'),
        appPath: path.join(root, 'Applications', 'Devin.app'),
        executablePath: path.join(root, 'Applications', 'Devin.app', 'Contents', 'MacOS', 'Devin'),
        lastDetectedAt: '2026-08-25T00:02:45.000Z',
        metadata: { distribution: { packageProvenance: 'signed_app:com.exafunction.windsurf:ATTACKER' } },
      })
      expect(Object.fromEntries(composition.service.snapshot().installations.map(item => [item.id, item.manageable])))
        .toMatchObject({
          'claude-desktop': false,
          'cursor-desktop': false,
          'codex-desktop': false,
          'windsurf-desktop': false,
          'qwenwork-desktop': false,
        })

      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'claude-desktop',
        family: 'claude',
        hostVariant: 'claude-desktop-legacy',
        installKey: 'claude:desktop',
        distributionId: 'com.anthropic.claudefordesktop',
        displayName: 'Claude Desktop',
        configRoot: path.join(root, 'Library', 'Application Support', 'Claude'),
        appPath: path.join(root, 'Applications', 'Claude.app'),
        executablePath: path.join(root, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
        lastDetectedAt: '2026-08-25T00:03:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: path.join(root, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
            packageProvenance: 'signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-claude`,
          },
        },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'cursor-desktop',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: 'cursor:desktop',
        distributionId: 'com.todesktop.230313mzl4w4u92',
        displayName: 'Cursor',
        configRoot: path.join(root, '.cursor'),
        appPath: path.join(root, 'Applications', 'Cursor.app'),
        executablePath: path.join(root, 'Applications', 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
        lastDetectedAt: '2026-08-25T00:04:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: path.join(root, 'Applications', 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
            packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-cursor`,
          },
        },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'codex-desktop',
        family: 'codex',
        hostVariant: 'codex-desktop',
        installKey: 'codex:desktop',
        distributionId: 'com.openai.codex',
        displayName: 'Codex Desktop',
        configRoot: path.join(root, '.codex'),
        appPath: path.join(root, 'Applications', 'ChatGPT.app'),
        executablePath: path.join(root, 'Applications', 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'),
        lastDetectedAt: '2026-08-25T00:05:00.000Z',
        metadata: {
          distribution: {
            executableRealpath: path.join(root, 'Applications', 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'),
            packageProvenance: 'signed_app:com.openai.codex:2DC432GLL2',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-codex`,
          },
        },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'qwenwork-desktop',
        family: 'qwenwork',
        hostVariant: 'qwenwork-desktop',
        installKey: 'qwenwork:desktop',
        distributionId: 'cn.qwenwork.desktop.mac',
        displayName: 'QwenWork',
        configRoot: path.join(root, '.qwenworkcn'),
        appPath: path.join(root, 'Applications', 'QwenWorkCN.app'),
        executablePath: path.join(root, 'Applications', 'QwenWorkCN.app', 'Contents', 'MacOS', 'QwenWorkCN'),
        lastDetectedAt: '2026-08-25T00:05:30.000Z',
        metadata: {
          distribution: {
            executableRealpath: path.join(root, 'Applications', 'QwenWorkCN.app', 'Contents', 'MacOS', 'QwenWorkCN'),
            packageProvenance: 'signed_app:cn.qwenwork.desktop.mac:XN6U3EV979',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-qwenwork`,
          },
        },
      })
      composition.repository.upsertDiscoveredInstallation({
        ...base,
        id: 'windsurf-desktop',
        family: 'windsurf',
        hostVariant: 'windsurf-desktop',
        installKey: 'windsurf:desktop',
        distributionId: 'com.exafunction.windsurf',
        displayName: 'Devin Desktop（原 Windsurf）',
        configRoot: path.join(root, '.config', 'devin'),
        appPath: path.join(root, 'Applications', 'Devin.app'),
        executablePath: path.join(root, 'Applications', 'Devin.app', 'Contents', 'MacOS', 'Devin'),
        lastDetectedAt: '2026-08-25T00:05:45.000Z',
        metadata: {
          distribution: {
            executableRealpath: path.join(root, 'Applications', 'Devin.app', 'Contents', 'MacOS', 'Devin'),
            packageProvenance: 'signed_app:com.exafunction.windsurf:83Z2LHX6XW',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-devin`,
          },
        },
      })
      expect(Object.fromEntries(composition.service.snapshot().installations.map(item => [item.id, item.manageable])))
        .toMatchObject({
          // Valid signing evidence may preserve/adopt a migrated record, but
          // Claude Desktop legacy is never a new managed-write surface.
          'claude-desktop': false,
          'cursor-desktop': true,
          'codex-desktop': true,
          'windsurf-desktop': true,
          'qwenwork-desktop': true,
        })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects legacy path-derived provenance even when its text names an official package', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-legacy-provenance-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['codex-cli'],
      observeOnly: false,
      startRuntime: false,
    })
    try {
      const base = {
        id: 'codex-cli',
        family: 'codex',
        hostVariant: 'codex-cli' as const,
        installKey: 'codex:cli',
        distributionId: 'cli:codex-cli',
        provenance: 'command:PATH:codex',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'Codex CLI',
        configRoot: path.join(root, '.codex'),
        supportedCapability: 3,
      }
      for (const [index, packageProvenance] of [
        'npm:@openai/codex',
        'homebrew:codex',
        'python:kimi-cli',
      ].entries()) {
        composition.repository.upsertDiscoveredInstallation({
          ...base,
          lastDetectedAt: `2026-08-25T00:0${index}:00.000Z`,
          metadata: { distribution: { packageProvenance } },
        })
        expect(composition.service.snapshot().installations[0].manageable).toBe(false)
      }
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('never replays persisted work before a fresh scan and keeps the scheduler alive after scan failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-startup-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      observeOnly: true,
      startRuntime: false,
    })
    const order: string[] = []
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockImplementation(async () => {
      order.push('recover')
      return []
    })
    const scan = vi.fn(async () => {
      order.push('scan')
      throw new Error('fixture scan failed')
    })
    composition.runtime.configureScheduler(scan, 60_000)
    try {
      await expect(composition.runtime.start()).resolves.toBeUndefined()
      expect(order).toEqual(['scan'])
      await composition.runtime.runMaintenance()
      expect(order).toEqual(['scan'])
      expect(db.prepare(`
        SELECT kind FROM agent_integration_events
        WHERE kind = 'managed_runtime_scan_failed'
      `).get()).toEqual({ kind: 'managed_runtime_scan_failed' })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs read-only recovery after a fresh startup scan but blocks effect replay in observe-only mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-startup-ok-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      observeOnly: true,
      startRuntime: false,
    })
    const order: string[] = []
    let replayAllowed: boolean | Promise<boolean> | undefined
    const recoveryInstallation = managedCursorCandidate(root).installation
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockImplementation(async options => {
      order.push('recover')
      replayAllowed = options?.canReplayEffect?.(recoveryInstallation)
      return []
    })
    composition.runtime.configureScheduler(async () => { order.push('scan') }, 60_000)
    try {
      await composition.runtime.start()
      expect(order).toEqual(['scan', 'recover'])
      expect(await replayAllowed).toBe(false)
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks recovery effect replay for an Adapter outside the production allowlist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-recovery-allowlist-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      enabledAdapterIds: [],
      observeOnly: false,
      startRuntime: false,
    })
    let replayAllowed: boolean | Promise<boolean> | undefined
    const recoveryInstallation = managedCursorCandidate(root).installation
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockImplementation(async options => {
      replayAllowed = options?.canReplayEffect?.(recoveryInstallation)
      return []
    })
    composition.runtime.configureScheduler(async () => {}, 60_000)
    try {
      await composition.runtime.start()
      expect(await replayAllowed).toBe(false)
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks recovery replay for a legacy non-Cursor Custom root even when its host Adapter is enabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-recovery-custom-contract-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const codexHost: AgentHostAdapter = { ...fake.host, catalogId: 'codex-cli' }
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['codex-cli', codexHost]]),
      enabledAdapterIds: ['codex-cli'],
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      observeOnly: false,
      startRuntime: false,
    })
    const sourceRoot = path.join(root, '.codex')
    const customRoot = path.join(root, '.codex-work')
    composition.repository.upsertDiscoveredInstallation({
      id: 'codex-custom-source', family: 'codex', hostVariant: 'codex-cli',
      installKey: 'codex:custom-source', distributionId: 'cli:codex-cli', provenance: 'legacy fixture',
      osUserIdentity: 'usr_fixture_1234', displayName: 'Codex', configRoot: sourceRoot,
      agentId: 'eb_codex_source', supportedCapability: 4, lastDetectedAt: '2026-08-25T00:00:00.000Z',
      metadata: { distribution: { distributionId: 'cli:codex-cli', capabilityFingerprint: 'codex-source-surface' } },
    })
    composition.repository.upsertDiscoveredInstallation({
      id: 'legacy-custom-codex', family: 'custom-local-agent', hostVariant: 'codex-cli',
      installKey: 'custom-local:legacy-wide-allowlist', distributionId: 'cli:codex-cli', provenance: 'legacy fixture',
      osUserIdentity: 'usr_fixture_1234', displayName: 'Legacy Codex Work', configRoot: customRoot,
      agentId: 'eb_legacy_custom', supportedCapability: 4, lastDetectedAt: '2026-08-25T00:00:00.000Z',
      metadata: {
        distribution: { distributionId: 'cli:codex-cli', capabilityFingerprint: 'codex-source-surface' },
        customInstallation: {
          kind: 'nonstandard_config_root', sourceInstallationId: 'codex-custom-source',
          sourceSurfaceFingerprint: 'legacy-source-surface', configFingerprint: 'legacy-root',
        },
      },
    })
    const recoveryInstallation: CoordinatorInstallation = {
      id: 'legacy-custom-codex', displayName: 'Legacy Codex Work', desiredState: 'managed',
      agentId: 'eb_legacy_custom',
      identity: {
        runtimeRealm: 'local_macos', osUserIdentity: 'usr_fixture_1234',
        productFamilyId: 'custom-local-agent', hostVariant: 'codex-cli',
        canonicalConfigRoot: customRoot, explicitProfile: 'default',
        distribution: { distributionId: 'cli:codex-cli', capabilityFingerprint: 'codex-source-surface' },
        installKey: 'custom-local:legacy-wide-allowlist',
      },
    }
    let replayAllowed: boolean | Promise<boolean> | undefined
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockImplementation(async options => {
      replayAllowed = options?.canReplayEffect?.(recoveryInstallation)
      return []
    })
    composition.runtime.configureScheduler(async () => {}, 60_000)
    try {
      await composition.runtime.start()
      expect(await replayAllowed).toBe(false)
      expect(fake.inspect).not.toHaveBeenCalled()
      expect(fake.apply).not.toHaveBeenCalled()
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks background replay and reconcile after current package provenance disappears', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-runtime-trust-loss-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const cliHost: AgentHostAdapter = { ...fake.host, catalogId: 'codex-cli' }
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['codex-cli', cliHost]]),
      enabledAdapterIds: ['codex-cli'],
      observeOnly: false,
      autoRestore: false,
      startRuntime: false,
    })
    const cursorCandidate = managedCursorCandidate(root)
    const candidate: ManagedReconcileCandidate = {
      ...cursorCandidate,
      installation: {
        ...cursorCandidate.installation,
        displayName: 'Codex CLI',
        identity: {
          ...cursorCandidate.installation.identity,
          productFamilyId: 'codex',
          hostVariant: 'codex-cli',
          canonicalConfigRoot: path.join(root, '.codex'),
          distribution: { distributionId: 'cli:codex-cli' },
          installKey: 'codex:test:cli',
        },
      },
    }
    const base = {
      id: candidate.installation.id,
      family: 'codex' as const,
      hostVariant: 'codex-cli' as const,
      installKey: candidate.installation.identity.installKey,
      distributionId: 'cli:codex-cli',
      provenance: 'command:PATH:codex',
      osUserIdentity: candidate.installation.identity.osUserIdentity,
      displayName: candidate.installation.displayName,
      configRoot: candidate.installation.identity.canonicalConfigRoot,
      executablePath: path.join(root, 'bin', 'codex'),
      agentId: candidate.installation.agentId,
      supportedCapability: 3,
    }
    composition.repository.upsertDiscoveredInstallation({
      ...base,
      lastDetectedAt: '2026-08-25T00:00:00.000Z',
      metadata: {
        managementEligibility: freshCliManagementEligibility(),
        distribution: {
          distributionId: 'cli:codex-cli',
          executableRealpath: base.executablePath,
          packageProvenance: 'npm_metadata:@openai/codex',
        },
      },
    })
    expect(composition.service.snapshot().installations[0].manageable).toBe(true)
    composition.repository.upsertDiscoveredInstallation({
      ...base,
      lastDetectedAt: '2026-08-25T00:01:00.000Z',
      metadata: {
        distribution: {
          distributionId: 'cli:codex-cli',
          packageProvenance: null,
        },
      },
    })
    expect(composition.service.snapshot().installations[0].manageable).toBe(false)

    vi.spyOn(composition.coordinatorRepository, 'listManagedReconcileCandidates').mockReturnValue([candidate])
    let replayAllowed: boolean | Promise<boolean> | undefined
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockImplementation(async options => {
      replayAllowed = options?.canReplayEffect?.(candidate.installation)
      return []
    })
    try {
      await composition.runtime.markScanCompleted()
      expect(await replayAllowed).toBe(false)
      expect(fake.inspect).not.toHaveBeenCalled()
      expect(fake.apply).not.toHaveBeenCalled()
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('moves a real applied-unverified run to recovery without host inspection when provenance disappears', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-applied-trust-loss-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      discoverCursorWithPackageProvenance(composition, root, 'fixture:trusted')
      const preview = await composition.service.previewConnect(['cursor-1'])
      const applied = await composition.service.applyConnect(preview.planHash, ['cursor-1'])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      expect(db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'applied_unverified' })

      discoverCursorWithPackageProvenance(
        composition,
        root,
        null,
        '2026-08-25T00:01:00.000Z',
      )
      fake.inspect.mockClear()
      await composition.runtime.markScanCompleted()

      expect(fake.inspect).not.toHaveBeenCalled()
      expect(fake.apply).toHaveBeenCalledTimes(1)
      expect(db.prepare(`
        SELECT state, failure_code, failure_stage FROM reconcile_runs
      `).get()).toEqual({
        state: 'needs_recovery',
        failure_code: 'recovery_source_trust_changed',
        failure_stage: 'startup_recovery',
      })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 0 })
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('continues same-pass managed reconciliation after isolating one persisted recovery failure', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-recovery-reconcile-')))
    const dbPath = path.join(root, 'brain.sqlite')
    const db = new Database(dbPath)
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    let recoveryRunId: string
    try {
      discoverCursor(composition, root)
      const preview = await composition.service.previewConnect(['cursor-1'])
      const applied = await composition.service.applyConnect(preview.planHash, ['cursor-1'])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      const persisted = db.prepare(`
        SELECT id, state FROM reconcile_runs ORDER BY created_at, id LIMIT 1
      `).get() as { id: string; state: string }
      recoveryRunId = persisted.id
      expect(persisted.state).toBe('applied_unverified')

      const originalControl = composition.coordinatorRepository.getInstallationControl
        .bind(composition.coordinatorRepository)
      vi.spyOn(composition.coordinatorRepository, 'getInstallationControl')
        .mockImplementationOnce(() => { throw new Error('fixture recovery control unavailable') })
        .mockImplementation(originalControl)
      fake.inspect.mockClear()

      await composition.runtime.markScanCompleted()

      expect(fake.inspect).toHaveBeenCalledTimes(1)
      expect(db.prepare(`
        SELECT state, failure_code, failure_stage FROM reconcile_runs WHERE id = ?
      `).get(recoveryRunId)).toEqual({
        state: 'needs_recovery',
        failure_code: 'recovery_execution_failed',
        failure_stage: 'startup_recovery',
      })
      expect(db.prepare(`
        SELECT kind, severity, payload_json FROM agent_integration_events
        WHERE kind = 'startup_recovery_execution_failed'
          AND installation_id = 'cursor-1'
      `).get()).toMatchObject({
        kind: 'startup_recovery_execution_failed',
        severity: 'error',
      })
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
    }

    const reopened = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      expect(reopened.prepare(`
        SELECT state, failure_code FROM reconcile_runs WHERE id = ?
      `).get(recoveryRunId)).toEqual({
        state: 'needs_recovery',
        failure_code: 'recovery_execution_failed',
      })
      expect(reopened.prepare(`
        SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE kind = 'startup_recovery_execution_failed'
      `).get()).toEqual({ count: 1 })
    } finally {
      reopened.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'package provenance disappears',
    'the persisted exact version loses release acceptance',
  ])('atomically blocks a real verified finalizer when %s before restart recovery', async revocation => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-verified-trust-loss-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const verify = vi.fn(async (context: Parameters<AgentHostAdapter['verify']>[0]) => [{
      componentKey: 'memory_tools' as const,
      status: 'verified' as const,
      verifiedCapability: 2 as const,
      identityAssertion: context.agentId,
      evidenceHash: 'fixture-host-evidence',
      invalidationKeys: [] as const,
      diagnostics: [],
    }])
    fake.host.verify = verify
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const originalSetRunState = composition.coordinatorRepository.setRunState.bind(composition.coordinatorRepository)
    const finalizerCrash = vi.spyOn(composition.coordinatorRepository, 'setRunState')
      .mockImplementation((runId, state, updatedAt, failure) => {
        if (state === 'committed') throw new Error('fixture crash before committed finalizer')
        return originalSetRunState(runId, state, updatedAt, failure)
      })
    try {
      discoverCursorWithPackageProvenance(composition, root, 'fixture:trusted')
      const preview = await composition.service.previewConnect(['cursor-1'])
      const result = await composition.service.applyConnect(preview.planHash, ['cursor-1'])
      expect(result.results[0].status).toBe('failed')
      expect(db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'verified' })
      finalizerCrash.mockRestore()

      if (revocation === 'package provenance disappears') {
        discoverCursorWithPackageProvenance(
          composition,
          root,
          null,
          '2026-08-25T00:01:00.000Z',
        )
      } else {
        const current = composition.repository.getInstallation('cursor-1')!
        const metadata = JSON.parse(current.metadata_json) as Record<string, unknown>
        db.prepare('UPDATE agent_installations SET metadata_json = ?, last_detected_at = ? WHERE id = ?').run(
          JSON.stringify({
            ...metadata,
            managementEligibility: {
              schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
              eligible: false,
              reason: 'release_version_not_accepted',
              proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
            },
          }),
          '2026-08-25T00:01:00.000Z',
          'cursor-1',
        )
        expect(composition.service.snapshot().installations[0]).toMatchObject({
          manageable: false,
          statusReason: 'release_version_not_accepted',
        })
      }
      fake.inspect.mockClear()
      verify.mockClear()
      await composition.runtime.markScanCompleted()

      expect(fake.inspect).not.toHaveBeenCalled()
      expect(verify).not.toHaveBeenCalled()
      expect(db.prepare(`
        SELECT state, failure_code, failure_stage FROM reconcile_runs
      `).get()).toEqual({
        state: 'cancelled',
        failure_code: 'recovery_source_trust_changed',
        failure_stage: 'startup_recovery',
      })
      expect(composition.repository.getInstallation('cursor-1')).toMatchObject({
        reconcile_state: 'needs_recovery',
        status_reason: 'recovery_source_trust_changed',
      })
    } finally {
      finalizerCrash.mockRestore()
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('atomically blocks a historical verified finalizer whose frozen surface binding is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-verified-unbound-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    fake.host.verify = vi.fn(async context => [{
      componentKey: 'memory_tools',
      status: 'verified',
      verifiedCapability: 2,
      identityAssertion: context.agentId,
      evidenceHash: 'fixture-host-evidence',
      invalidationKeys: [],
      diagnostics: [],
    }])
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const originalSetRunState = composition.coordinatorRepository.setRunState.bind(composition.coordinatorRepository)
    const finalizerCrash = vi.spyOn(composition.coordinatorRepository, 'setRunState')
      .mockImplementation((runId, state, updatedAt, failure) => {
        if (state === 'committed') throw new Error('fixture crash before committed finalizer')
        return originalSetRunState(runId, state, updatedAt, failure)
      })
    try {
      discoverCursorWithPackageProvenance(composition, root, 'fixture:trusted')
      const preview = await composition.service.previewConnect(['cursor-1'])
      const result = await composition.service.applyConnect(preview.planHash, ['cursor-1'])
      expect(result.results[0].status).toBe('failed')
      expect(db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'verified' })
      finalizerCrash.mockRestore()

      const run = db.prepare(`SELECT id, prepared_plan_json FROM reconcile_runs`).get() as {
        id: string
        prepared_plan_json: string
      }
      const legacyPlan = JSON.parse(run.prepared_plan_json) as {
        executionPlan: { installationSurfaceFingerprint?: string }
      }
      delete legacyPlan.executionPlan.installationSurfaceFingerprint
      db.prepare(`UPDATE reconcile_runs SET prepared_plan_json = ? WHERE id = ?`)
        .run(JSON.stringify(legacyPlan), run.id)

      fake.inspect.mockClear()
      await composition.runtime.markScanCompleted()

      expect(fake.inspect).not.toHaveBeenCalled()
      expect(db.prepare(`SELECT state, failure_code, failure_stage FROM reconcile_runs`).get()).toEqual({
        state: 'cancelled',
        failure_code: 'recovery_source_trust_changed',
        failure_stage: 'startup_recovery',
      })
      expect(composition.repository.getInstallation('cursor-1')).toMatchObject({
        reconcile_state: 'needs_recovery',
        status_reason: 'recovery_source_trust_changed',
      })
    } finally {
      finalizerCrash.mockRestore()
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops an inspection result when exact current trust disappears across the await and continues', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-inspect-trust-race-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
    })
    const baseCandidate = managedCursorCandidate(root)
    const candidate: ManagedReconcileCandidate = {
      ...baseCandidate,
      installation: {
        ...baseCandidate.installation,
        agentId: 'agent-cursor',
        identity: {
          ...baseCandidate.installation.identity,
          distribution: { distributionId: 'cursor' },
          installKey: 'cursor:test',
        },
      },
    }
    const second: ManagedReconcileCandidate = {
      ...candidate,
      artifactId: 'artifact-cursor-second',
      installation: {
        ...candidate.installation,
        id: 'cursor-2',
        displayName: 'Cursor Second',
        desiredState: 'disabled',
        agentId: 'agent-cursor-2',
        identity: {
          ...candidate.installation.identity,
          installKey: 'cursor:test:second',
        },
      },
    }
    let releaseInspection!: () => void
    let inspectionStarted!: () => void
    const started = new Promise<void>(resolve => { inspectionStarted = resolve })
    const barrier = new Promise<void>(resolve => { releaseInspection = resolve })
    discoverCursorWithPackageProvenance(composition, root, 'fixture:trusted')
    composition.repository.upsertDiscoveredInstallation({
      id: second.installation.id,
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: second.installation.identity.installKey,
      distributionId: 'cursor',
      provenance: 'fixture',
      osUserIdentity: 'usr_fixture_1234',
      displayName: second.installation.displayName,
      configRoot: path.join(root, '.cursor'),
      agentId: second.installation.agentId,
      supportedCapability: 3,
      lastDetectedAt: '2026-08-25T00:00:00.000Z',
      metadata: {
        distribution: { distributionId: 'cursor', packageProvenance: 'fixture:trusted' },
      },
    })
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockResolvedValue([])
    const frozenCandidate = freezeCandidateSurface(composition, candidate)
    const frozenSecond = freezeCandidateSurface(composition, second)
    vi.spyOn(composition.coordinatorRepository, 'listManagedReconcileCandidates')
      .mockReturnValue([frozenCandidate, frozenSecond])
    fake.inspect.mockImplementationOnce(async () => {
      inspectionStarted()
      await barrier
      return {
        catalogId: 'cursor-desktop',
        detected: true,
        distribution: { distributionId: 'cursor' },
        components: [{
          componentKey: 'memory_tools',
          visibility: 'absent',
          verificationStatus: 'unverified',
        }],
        provenance: ['fixture'],
        diagnostics: [],
      }
    })
    const reconcile = vi.spyOn(composition.coordinator, 'preview')
    try {
      const maintenance = composition.runtime.markScanCompleted()
      await started
      discoverCursorWithPackageProvenance(
        composition,
        root,
        null,
        '2026-08-25T00:01:00.000Z',
      )
      releaseInspection()
      await maintenance

      expect(reconcile).not.toHaveBeenCalled()
      expect(fake.apply).not.toHaveBeenCalled()
      expect(fake.inspect).toHaveBeenCalledTimes(2)
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_integration_events`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('isolates one reconcile failure, records its exact scope, and continues later candidates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-reconcile-isolation-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
    })
    const first = managedCursorCandidate(root, 'artifact-first', 'cursor-first')
    const second = managedCursorCandidate(root, 'artifact-second', 'cursor-second')
    for (const [index, candidate] of [first, second].entries()) {
      composition.repository.upsertDiscoveredInstallation({
        id: candidate.installation.id,
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: candidate.installation.identity.installKey,
        distributionId: 'cursor',
        provenance: 'fixture',
        osUserIdentity: candidate.installation.identity.osUserIdentity,
        displayName: candidate.installation.displayName,
        configRoot: candidate.installation.identity.canonicalConfigRoot,
        agentId: candidate.installation.agentId,
        supportedCapability: 3,
        lastDetectedAt: `2026-08-25T00:0${index}:00.000Z`,
      })
      composition.repository.createManagedArtifact({
        id: candidate.artifactId,
        componentType: 'mcp',
        targetPath: path.join(root, `${candidate.artifactId}.json`),
        ownershipKey: 'mcpServers.tidemind',
        mutationDomain: `local_macos:file:${path.join(root, `${candidate.artifactId}.json`)}:mcpServers.tidemind`,
        projectionVersion: '1',
        selectorSchemaVersion: '1',
        ownedFragmentHash: candidate.ownedFragmentHash,
        desiredFragmentHash: candidate.desiredFragmentHash,
      }, `2026-08-25T00:0${index}:00.000Z`)
      composition.repository.upsertComponent({
        installationId: candidate.installation.id,
        componentKey: candidate.componentKey,
        desiredState: 'managed',
        desiredCapability: candidate.desiredCapability,
        deliveryMode: 'managed',
        artifactId: candidate.artifactId,
      }, `2026-08-25T00:0${index}:00.000Z`)
    }
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockResolvedValue([])
    const frozenFirst = freezeCandidateSurface(composition, first)
    const frozenSecond = freezeCandidateSurface(composition, second)
    vi.spyOn(composition.coordinatorRepository, 'listManagedReconcileCandidates')
      .mockReturnValue([frozenFirst, frozenSecond])
    vi.spyOn(composition.coordinatorRepository, 'beginMissingEpisode').mockImplementation(input => {
      if (input.artifactId === first.artifactId) throw new Error('first artifact ledger unavailable')
      return { changed: false, eventCount: 1, shouldAutoRestore: false, circuitBroken: false }
    })
    try {
      await composition.runtime.markScanCompleted()
      expect(fake.inspect).toHaveBeenCalledTimes(2)
      expect(db.prepare(`
        SELECT installation_id, component_key, artifact_id, kind, payload_json
        FROM agent_integration_events
        WHERE kind = 'managed_runtime_reconcile_failed'
      `).get()).toMatchObject({
        installation_id: first.installation.id,
        component_key: first.componentKey,
        artifact_id: first.artifactId,
        kind: 'managed_runtime_reconcile_failed',
      })
      expect(fake.apply).not.toHaveBeenCalled()
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['lost runtime trust', false],
    ['closed Adapter gate', true],
  ] as const)('selects a later manageable consumer for a shared Artifact after the first has %s', async (_case, gateClosed) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shared-runtime-selection-')))
    const dbPath = path.join(root, 'brain.sqlite')
    const db = new Database(dbPath)
    ensureSchema(db)
    const cursor = adapter(root)
    const blocked = gateClosed ? adapter(root, 'codex-cli') : cursor
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([
        ['cursor-desktop', cursor.host],
        ...(gateClosed ? [['codex-cli', blocked.host] as const] : []),
      ]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: row => gateClosed || row.id === 'b-trusted',
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
    })
    const artifactId = 'artifact-shared-instruction'
    const target = path.join(root, '.agents', 'skills', 'tidemind', 'SKILL.md')
    composition.repository.createManagedArtifact({
      id: artifactId,
      componentType: 'skill',
      targetPath: target,
      ownershipKey: 'document',
      mutationDomain: `local_macos:file:${target}:document`,
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      ownedFragmentHash: 'shared-owned',
      desiredFragmentHash: 'shared-desired',
      observedFragmentHash: 'shared-owned',
    }, '2026-08-25T00:00:00.000Z')
    for (const [index, installationId] of ['a-blocked', 'b-trusted'].entries()) {
      const hostVariant = index === 0 && gateClosed ? 'codex-cli' : 'cursor-desktop'
      composition.repository.upsertDiscoveredInstallation({
        id: installationId,
        family: hostVariant === 'codex-cli' ? 'codex' : 'cursor',
        hostVariant,
        installKey: `${hostVariant}:${installationId}`,
        distributionId: hostVariant,
        provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234',
        displayName: installationId,
        configRoot: path.join(root, installationId),
        agentId: `agent-${installationId}`,
        supportedCapability: 3,
        lastDetectedAt: `2026-08-25T00:0${index}:00.000Z`,
        metadata: { distribution: { distributionId: hostVariant, packageProvenance: 'fixture:trusted' } },
      })
      db.prepare(`UPDATE agent_installations SET desired_state = 'managed' WHERE id = ?`).run(installationId)
      composition.repository.upsertComponent({
        installationId,
        componentKey: 'instruction',
        desiredState: 'managed',
        desiredCapability: 1,
        deliveryMode: 'managed',
        artifactId,
      }, `2026-08-25T00:0${index}:00.000Z`)
      composition.repository.addArtifactConsumer({
        artifactId,
        installationId,
        componentKey: 'instruction',
        requiredCapability: 1,
        discoverReachability: 'shared_visible',
        ownershipFingerprint: 'shared-owned',
        addedAt: `2026-08-25T00:0${index}:00.000Z`,
      })
    }
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockResolvedValue([])
    try {
      expect(composition.coordinatorRepository.listManagedReconcileCandidates())
        .toHaveLength(2)
      await composition.runtime.markScanCompleted()
      expect(cursor.inspect).toHaveBeenCalledTimes(1)
      expect(cursor.inspect.mock.calls[0]?.[0].installation.installKey)
        .toBe('cursor-desktop:b-trusted')
      if (gateClosed) expect(blocked.inspect).not.toHaveBeenCalled()
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prioritizes the shared Artifact consumer with exact current active consent', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shared-consent-selection-')))
    const db = new Database(path.join(root, 'brain.sqlite'))
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      autoRestore: true,
      startRuntime: false,
    })
    const artifactId = 'artifact-shared-active-consent'
    const target = path.join(root, '.agents', 'skills', 'tidemind', 'SKILL.md')
    composition.repository.createManagedArtifact({
      id: artifactId,
      componentType: 'skill',
      targetPath: target,
      ownershipKey: 'document',
      mutationDomain: `local_macos:file:${target}:document`,
      projectionVersion: '1',
      selectorSchemaVersion: '1',
      ownedFragmentHash: 'shared-owned',
      desiredFragmentHash: 'shared-desired',
      observedFragmentHash: 'shared-owned',
    }, '2026-08-25T00:00:00.000Z')
    for (const [ordinal, installationId] of ['a-no-consent', 'b-active-consent'].entries()) {
      composition.repository.upsertDiscoveredInstallation({
        id: installationId,
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: `cursor-desktop:${installationId}`,
        distributionId: 'cursor-desktop',
        provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234',
        displayName: installationId,
        configRoot: path.join(root, installationId),
        agentId: `agent-${installationId}`,
        supportedCapability: 3,
        lastDetectedAt: `2026-08-25T00:0${ordinal}:00.000Z`,
        metadata: { distribution: { distributionId: 'cursor-desktop', packageProvenance: 'fixture:trusted' } },
      })
      composition.repository.upsertComponent({
        installationId,
        componentKey: 'instruction',
        desiredState: 'managed',
        desiredCapability: 1,
        deliveryMode: 'managed',
        artifactId,
      }, `2026-08-25T00:0${ordinal}:00.000Z`)
    }
    composition.repository.createConsent({
      id: 'consent-b-active',
      installationId: 'b-active-consent',
      policyVersion: '1',
      allowedComponents: ['instruction'],
      allowedScopes: [root],
      normalizedTargets: [target],
      selectorSchemaVersion: '1',
      selectorResolution: { document: target },
      executableRealpaths: [],
      commandCategories: ['file_write'],
      maximumRisk: 'low',
      confirmedAt: '2026-08-25T00:02:00.000Z',
    })
    db.prepare(`
      UPDATE agent_installations
      SET desired_state = 'managed', consent_envelope_id = CASE id
        WHEN 'b-active-consent' THEN 'consent-b-active' ELSE NULL END,
        consented_at = CASE id WHEN 'b-active-consent' THEN '2026-08-25T00:02:00.000Z' ELSE NULL END
      WHERE id IN ('a-no-consent', 'b-active-consent')
    `).run()
    composition.repository.addArtifactConsumer({
      artifactId,
      installationId: 'a-no-consent',
      componentKey: 'instruction',
      requiredCapability: 1,
      discoverReachability: 'shared_visible',
      ownershipFingerprint: 'shared-owned',
      addedAt: '2026-08-25T00:00:00.000Z',
    })
    composition.repository.addArtifactConsumer({
      artifactId,
      installationId: 'b-active-consent',
      componentKey: 'instruction',
      requiredCapability: 1,
      discoverReachability: 'shared_visible',
      ownershipFingerprint: 'shared-owned',
      consentEnvelopeId: 'consent-b-active',
      addedAt: '2026-08-25T00:01:00.000Z',
    })
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockResolvedValue([])
    try {
      expect(composition.coordinatorRepository.listManagedReconcileCandidates()
        .map(candidate => candidate.installation.id))
        .toEqual(['b-active-consent', 'a-no-consent'])
      await composition.runtime.markScanCompleted()
      expect(fake.inspect).toHaveBeenCalled()
      expect(fake.inspect.mock.calls.map(call => call[0].installation.installKey))
        .toEqual(expect.arrayContaining(['cursor-desktop:b-active-consent']))
      expect(fake.inspect.mock.calls.every(call => (
        call[0].installation.installKey === 'cursor-desktop:b-active-consent'
      ))).toBe(true)
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refreshes verification generations after the fresh scan and before recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-freshness-order-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const order: string[] = []
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      scanner: {
        scan: async () => {
          order.push('scan')
          return { installations: [], unresolved: [] }
        },
      },
      observeOnly: true,
      startRuntime: false,
    })
    vi.spyOn(composition.repository, 'refreshVerificationFreshness').mockImplementation(() => {
      order.push('freshness')
      return 0
    })
    vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns').mockImplementation(async () => {
      order.push('recover')
      return []
    })
    try {
      await composition.service.scan()
      expect(order[0]).toBe('scan')
      expect(order.indexOf('freshness')).toBeGreaterThan(0)
      expect(order.indexOf('freshness')).toBeLessThan(order.indexOf('recover'))
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('is observe-only by default and exposes detected adapters as non-manageable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-observe-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: true,
      discoveryDependencies: {
        fs: { lstat: async () => undefined, realpath: async value => value, readTextFile: async () => '' },
        which: async () => undefined,
        execVersion: async () => ({ exitCode: 126, stdout: '', stderr: 'passive_probe_disabled' }),
      },
    })
    try {
      discoverCursor(composition, root)
      expect(composition.service.snapshot().installations[0].manageable).toBe(false)
      await expect(composition.service.previewConnect(['cursor-1'])).rejects.toThrow(/not enabled/)
      await composition.runtime.start()
      expect(fake.inspect).not.toHaveBeenCalled()
      expect(fake.apply).not.toHaveBeenCalled()
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists an explicitly gated plan but never marks static-only verification green', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-gated-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      discoverCursor(composition, root)
      expect(composition.service.supportCatalog().find(product => product.id === 'cursor')?.variants[0]).toMatchObject({
        maturity: 'managed',
        maximumAccessLevel: 'partial',
      })
      expect(composition.service.snapshot().installations[0].components).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'instruction', state: 'unsupported' }),
        expect.objectContaining({ key: 'memory_tools', state: 'unconnected' }),
        expect.objectContaining({ key: 'lifecycle', state: 'unsupported' }),
      ]))
      const preview = await composition.service.previewConnect(['cursor-1'])
      expect(preview.installations[0]).toMatchObject({
        desiredCapability: 2,
        componentKeys: ['memory_tools'],
      })
      const result = await composition.service.applyConnect(preview.planHash, ['cursor-1'])
      expect(result.results[0].status).toBe('awaiting_verification')
      expect(fake.apply).toHaveBeenCalledOnce()
      expect(composition.repository.getInstallation('cursor-1')).toMatchObject({
        verified_capability: 0,
        verification_summary: 'unverified',
      })
      expect(fs.existsSync(path.join(root, '.cursor', 'mcp.json'))).toBe(false)
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates no consent, run or intent when the exact projection root drifts after preview', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-preconsent-surface-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const discovered = (resourceRoot: string, lastDetectedAt: string) => {
      composition.repository.upsertDiscoveredInstallation({
        id: 'cursor-1',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: 'cursor:test',
        distributionId: 'cursor',
        provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'Cursor',
        configRoot: path.join(root, '.cursor'),
        agentId: 'agent-cursor',
        supportedCapability: 3,
        lastDetectedAt,
        metadata: {
          componentConfigFiles: { memory_tools: path.join(root, '.cursor', 'mcp.json') },
          componentConfigRoots: { memory_tools: path.join(root, '.cursor') },
          resourceRoots: { memory_tools: resourceRoot },
          distribution: {
            distributionId: 'cursor',
            packageProvenance: 'fixture:trusted',
          },
        },
      })
    }
    try {
      discovered(path.join(root, 'resources-a'), '2026-08-25T00:00:00.000Z')
      const preview = await composition.service.previewConnect(['cursor-1'])
      discovered(path.join(root, 'resources-b'), '2026-08-25T00:01:00.000Z')

      const result = await composition.service.applyConnect(preview.planHash, ['cursor-1'])

      expect(result.results[0]).toMatchObject({
        installationId: 'cursor-1',
        status: 'failed',
        reason: expect.stringMatching(/changed after preview|configuration changed/),
      })
      expect(fake.apply).not.toHaveBeenCalled()
      expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_consents`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM reconcile_runs`).get()).toEqual({ count: 0 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations`).get()).toEqual({ count: 0 })
      expect(composition.repository.getInstallation('cursor-1')).toMatchObject({
        desired_state: 'unmanaged',
        consent_envelope_id: null,
      })
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-attests the frozen package proof after an awaited precondition and before the physical effect', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-live-proof-race-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const readBack = deferredBarrier()
    fake.host.readBack = vi.fn(async (_context, mutation) => {
      readBack.markStarted()
      await readBack.wait
      return {
        operationId: mutation.operationId,
        observed: false,
        matchesDesired: false,
        diagnostics: [],
      }
    })
    let liveProof: string | null = 'a'.repeat(64)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      liveTrustAttestor: async () => liveProof,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      discoverCursorWithPackageProvenance(composition, root, 'fixture:trusted')
      const preview = await composition.service.previewConnect(['cursor-1'])
      const applying = composition.service.applyConnect(preview.planHash, ['cursor-1'])
      await readBack.started

      liveProof = null
      readBack.release()
      const result = await applying

      expect(result.results[0]).toMatchObject({
        installationId: 'cursor-1',
        status: 'needs_recovery',
      })
      expect(fake.apply).not.toHaveBeenCalled()
      expect(db.prepare(`SELECT state FROM reconcile_runs`).get()).toEqual({ state: 'needs_recovery' })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 0 })
    } finally {
      readBack.release()
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('atomically rejects host evidence when detected version drifts during deferred verification', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-version-cas-'))
    const dbPath = path.join(root, 'brain.sqlite')
    const db = new Database(dbPath)
    ensureSchema(db)
    const fake = adapter(root)
    const verification = deferredBarrier()
    fake.host.verify = vi.fn(async context => {
      verification.markStarted()
      await verification.wait
      return [{
        componentKey: 'memory_tools',
        status: 'verified',
        verifiedCapability: 2,
        identityAssertion: context.agentId,
        evidenceHash: 'host-evidence-for-version-1',
        invalidationKeys: [],
        diagnostics: [],
      }]
    })
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    const discovered = (detectedVersion: string, lastDetectedAt: string) => {
      composition.repository.upsertDiscoveredInstallation({
        id: 'cursor-1',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: 'cursor:test',
        distributionId: 'cursor',
        provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'Cursor',
        configRoot: path.join(root, '.cursor'),
        agentId: 'agent-cursor',
        detectedVersion,
        versionDetectionMethod: 'fixture',
        supportedCapability: 3,
        lastDetectedAt,
        metadata: {
          distribution: { distributionId: 'cursor', packageProvenance: 'fixture:trusted' },
        },
      })
    }
    try {
      discovered('1.0.0', '2026-08-25T00:00:00.000Z')
      const preview = await composition.service.previewConnect(['cursor-1'])
      const applying = composition.service.applyConnect(preview.planHash, ['cursor-1'])
      await verification.started

      discovered('2.0.0', '2026-08-25T00:01:00.000Z')
      verification.release()
      const result = await applying

      expect(result.results[0]).toMatchObject({
        installationId: 'cursor-1',
        status: 'needs_recovery',
        reason: 'verification_failed',
      })
      expect(fake.apply).toHaveBeenCalledTimes(1)
      expect(db.prepare(`
        SELECT state, failure_code, failure_stage FROM reconcile_runs
      `).get()).toEqual({
        state: 'needs_recovery',
        failure_code: 'verification_failed',
        failure_stage: 'verification',
      })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 0 })
      expect(composition.repository.getInstallation('cursor-1')?.detected_version).toBe('2.0.0')
      expect(fs.existsSync(dbPath)).toBe(true)
    } finally {
      verification.release()
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('revokes consent and blocks apply when the projection surface drifts during live read-back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-surface-cas-'))
    const dbPath = path.join(root, 'brain.sqlite')
    const db = new Database(dbPath)
    ensureSchema(db)
    const fake = adapter(root)
    const readBack = deferredBarrier()
    fake.host.readBack = vi.fn(async (_context, mutation) => {
      readBack.markStarted()
      await readBack.wait
      return {
        operationId: mutation.operationId,
        observed: false,
        matchesDesired: false,
        diagnostics: [],
      }
    })
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    let primaryOpen = true
    const discovered = (resourceRoot: string, lastDetectedAt: string) => {
      composition.repository.upsertDiscoveredInstallation({
        id: 'cursor-1',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: 'cursor:test',
        distributionId: 'cursor',
        provenance: 'fixture',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'Cursor',
        configRoot: path.join(root, '.cursor'),
        executablePath: path.join(root, 'bin', 'cursor'),
        appPath: path.join(root, 'Cursor.app'),
        agentId: 'agent-cursor',
        detectedVersion: '1.0.0',
        versionDetectionMethod: 'fixture',
        supportedCapability: 3,
        lastDetectedAt,
        metadata: {
          componentConfigFiles: { memory_tools: path.join(root, '.cursor', 'mcp.json') },
          componentConfigRoots: { memory_tools: path.join(root, '.cursor') },
          resourceRoots: { memory_tools: resourceRoot },
          distribution: {
            distributionId: 'cursor',
            executableRealpath: path.join(root, 'bin', 'cursor'),
            packageProvenance: 'fixture:trusted',
            capabilityFingerprint: 'cursor-capability-v1',
          },
        },
      })
    }
    try {
      discovered(path.join(root, 'resources-a'), '2026-08-25T00:00:00.000Z')
      const preview = await composition.service.previewConnect(['cursor-1'])
      const applying = composition.service.applyConnect(preview.planHash, ['cursor-1'])
      await readBack.started

      discovered(path.join(root, 'resources-b'), '2026-08-25T00:01:00.000Z')
      readBack.release()
      const result = await applying

      expect(result.results[0]).toMatchObject({
        installationId: 'cursor-1',
        status: 'needs_recovery',
        reason: 'effect_failed_or_unknown',
      })
      expect(fake.apply).not.toHaveBeenCalled()
      expect(composition.repository.getInstallation('cursor-1')).toMatchObject({
        consent_envelope_id: null,
      })
      expect(db.prepare(`SELECT status FROM agent_consents`).get()).toEqual({ status: 'revoked' })
      expect(db.prepare(`
        SELECT state, failure_code, failure_stage FROM reconcile_runs
      `).get()).toEqual({
        state: 'needs_recovery',
        failure_code: 'effect_failed_or_unknown',
        failure_stage: 'effect',
      })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM verification_results`).get()).toEqual({ count: 0 })
      expect(fs.existsSync(dbPath)).toBe(true)

      unbind()
      composition.runtime.stop()
      db.close()
      primaryOpen = false
      const restartedDb = new Database(dbPath)
      const restartedFake = adapter(root)
      const restarted = createProductionAgentIntegrationComposition(restartedDb, {
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        runtimeContext: runtimeContext(root),
        adapters: new Map([['cursor-desktop', restartedFake.host]]),
        fixtureMode: 'isolated_ui_audit',
        canManageInstallation: hasFixturePackageTrust,
        enabledAdapterIds: ['cursor-desktop'],
        observeOnly: false,
        autoRestore: false,
        startRuntime: false,
        notifications: { deliver: vi.fn() },
      })
      try {
        await restarted.runtime.markScanCompleted()
        expect(restartedFake.inspect).not.toHaveBeenCalled()
        expect(restartedFake.apply).not.toHaveBeenCalled()
        expect(restartedDb.prepare(`
          SELECT state, failure_code, failure_stage FROM reconcile_runs
        `).get()).toEqual({
          state: 'needs_recovery',
          failure_code: 'recovery_source_trust_changed',
          failure_stage: 'startup_recovery',
        })
      } finally {
        restarted.runtime.stop()
        restartedDb.close()
      }
    } finally {
      readBack.release()
      if (primaryOpen) {
        unbind()
        composition.runtime.stop()
        db.close()
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed across restart for a legacy recovery plan without a frozen surface binding', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-unbound-recovery-'))
    const dbPath = path.join(root, 'brain.sqlite')
    const db = new Database(dbPath)
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: hasFixturePackageTrust,
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: false,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      discoverCursorWithPackageProvenance(composition, root, 'fixture:trusted')
      const preview = await composition.service.previewConnect(['cursor-1'])
      const applied = await composition.service.applyConnect(preview.planHash, ['cursor-1'])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      const run = db.prepare(`SELECT id, prepared_plan_json FROM reconcile_runs`).get() as {
        id: string
        prepared_plan_json: string
      }
      const legacyPlan = JSON.parse(run.prepared_plan_json) as {
        executionPlan: { installationSurfaceFingerprint?: string }
      }
      delete legacyPlan.executionPlan.installationSurfaceFingerprint
      db.prepare(`UPDATE reconcile_runs SET prepared_plan_json = ? WHERE id = ?`)
        .run(JSON.stringify(legacyPlan), run.id)

      unbind()
      composition.runtime.stop()
      db.close()
      const restartedDb = new Database(dbPath)
      const restartedFake = adapter(root)
      const restarted = createProductionAgentIntegrationComposition(restartedDb, {
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        runtimeContext: runtimeContext(root),
        adapters: new Map([['cursor-desktop', restartedFake.host]]),
        fixtureMode: 'isolated_ui_audit',
        canManageInstallation: hasFixturePackageTrust,
        enabledAdapterIds: ['cursor-desktop'],
        observeOnly: false,
        autoRestore: false,
        startRuntime: false,
        notifications: { deliver: vi.fn() },
      })
      try {
        await restarted.runtime.markScanCompleted()
        expect(restartedFake.inspect).not.toHaveBeenCalled()
        expect(restartedFake.apply).not.toHaveBeenCalled()
        expect(restartedDb.prepare(`
          SELECT state, failure_code, failure_stage FROM reconcile_runs
        `).get()).toEqual({
          state: 'needs_recovery',
          failure_code: 'recovery_source_trust_changed',
          failure_stage: 'startup_recovery',
        })
      } finally {
        restarted.runtime.stop()
        restartedDb.close()
      }
    } finally {
      composition.runtime.stop()
      if (db.open) {
        unbind()
        db.close()
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('revalidates persisted evidence generations before deriving a renderer snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-freshness-'))
    const db = new Database(':memory:')
    ensureSchema(db)
    const fake = adapter(root)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: root,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtimeContext(root),
      adapters: new Map([['cursor-desktop', fake.host]]),
      enabledAdapterIds: ['cursor-desktop'],
      observeOnly: true,
      startRuntime: false,
    })
    try {
      discoverCursor(composition, root)
      composition.repository.upsertComponent({
        installationId: 'cursor-1',
        componentKey: 'memory_tools',
        desiredState: 'managed',
        desiredCapability: 2,
        deliveryMode: 'managed',
      }, '2026-08-25T00:01:00.000Z')
      composition.repository.recordVerificationResult({
        id: 'verification-old-adapter',
        installationId: 'cursor-1',
        componentKey: 'memory_tools',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        distributionId: 'cursor',
        runtimeRealm: 'local_macos',
        hostVersion: null,
        osVersion: os.release(),
        adapterVersion: '0',
        catalogVersion: '1.0.0',
        projectionVersion: '1',
        verificationManifestVersion: '1',
        method: 'host_list',
        identityAssertion: 'agent-cursor',
        result: 'verified',
        evidenceHash: 'old-adapter-evidence',
        verifiedAt: '2026-08-25T00:02:00.000Z',
      })
      composition.repository.createConsent({
        id: 'consent-freshness',
        installationId: 'cursor-1',
        policyVersion: '1',
        allowedComponents: ['memory_tools'],
        allowedScopes: [root],
        normalizedTargets: [path.join(root, '.cursor', 'mcp.json')],
        selectorSchemaVersion: '1',
        selectorResolution: { key: 'tidemind' },
        executableRealpaths: [],
        commandCategories: ['file_write'],
        maximumRisk: 'low',
        confirmedAt: '2026-08-25T00:02:00.000Z',
      })
      db.prepare(`
        UPDATE agent_installations
        SET desired_state = 'managed', consent_envelope_id = 'consent-freshness',
            consented_at = '2026-08-25T00:02:00.000Z', desired_capability = 2,
            verified_capability = 2, verification_summary = 'verified', status_reason = 'verified'
        WHERE id = 'cursor-1'
      `).run()

      const installation = composition.service.snapshot().installations[0]

      expect(installation).toMatchObject({
        id: 'cursor-1',
        accessIsHistorical: true,
        manageable: false,
        statusReason: 'detect_only',
      })
      expect(installation.components).toContainEqual(expect.objectContaining({
        key: 'memory_tools',
        state: 'verification_stale',
      }))
      expect(db.prepare(`
        SELECT invalidation_reason FROM verification_results WHERE id = 'verification-old-adapter'
      `).get()).toEqual({ invalidation_reason: 'adapter_version_changed' })
    } finally {
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps QwenWork guided MCP pending across restart until the exact generation proves read and write', async () => {
    let currentTime = new Date()
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-qwenwork-guided-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const configRoot = path.join(home, '.qwenworkcn')
    const executable = path.join(root, 'Applications', 'QwenWorkCN.app', 'Contents', 'MacOS', 'QwenWorkCN')
    const runtime = runtimeContext(home)
    const dbPath = path.join(root, 'agent-integration.db')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(path.dirname(runtime.shimPath), { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(runtime.shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(runtime.mcpServerPath, '// packaged MCP runtime\n', { mode: 0o600 })
    fs.writeFileSync(path.join(configRoot, 'settings.json'), '{}\n', { mode: 0o600 })

    const distribution = {
      distributionId: 'cn.qwenwork.desktop.mac',
      executableRealpath: executable,
      packageProvenance: 'signed_app:cn.qwenwork.desktop.mac:XN6U3EV979',
      capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-qwenwork-guided`,
    }
    const identity = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_qwenwork',
      productFamilyId: 'qwenwork',
      hostVariant: 'qwenwork-desktop',
      configRoot,
      componentConfigRoots: { instruction: configRoot, lifecycle: configRoot },
      distribution,
    })
    const discovered: DiscoveredInstallation = {
      catalogId: 'qwenwork-desktop',
      displayName: 'QwenWork',
      identity,
      configRoot,
      componentConfigRoots: identity.componentConfigRoots,
      executablePath: executable,
      appPath: path.join(root, 'Applications', 'QwenWorkCN.app'),
      detectedVersion: '1.2.0',
      versionDetectionMethod: 'bundle_plist',
      provenance: ['fixture:signed-qwenwork'],
      evidence: [{ kind: 'distribution', source: executable, value: distribution.packageProvenance }],
    }
    const scanner = { scan: async () => ({ installations: [discovered], unresolved: [], diagnostics: [] }) }
    const adapters = new Map([['qwenwork-desktop', createP0HostAdapters().get('qwenwork-desktop')!]] as const)
    const options = {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtime,
      adapters,
      enabledAdapterIds: ['qwenwork-desktop'] as const,
      scanner,
      canManageInstallation: row => (
        persistedDistribution(row).packageProvenance === distribution.packageProvenance
      ),
      fixtureMode: 'isolated_ui_audit' as const,
      clock: { now: () => new Date(currentTime) },
      autoRestore: true,
      startRuntime: false,
    }

    let db = new Database(dbPath)
    ensureSchema(db)
    let composition = createProductionAgentIntegrationComposition(db, options)
    let unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      await composition.service.scan()
      const installation = composition.service.snapshot().installations[0]!
      expect(installation).toMatchObject({ hostVariant: 'qwenwork-desktop', manageable: true })

      const preview = await composition.service.previewConnect([installation.id])
      const applied = await composition.service.applyConnect(preview.planHash, [installation.id])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      const connectRun = db.prepare(`
        SELECT id, prepared_plan_json FROM reconcile_runs
        WHERE installation_id = ? AND operation_type = 'connect'
        ORDER BY rowid DESC LIMIT 1
      `).get(installation.id) as { id: string; prepared_plan_json: string }
      const prepared = JSON.parse(connectRun.prepared_plan_json) as {
        activityGenerationToken: string
        adapterPlan: { requiredUserActionDetails: Array<{
          kind: string
          operation: string
          environment: Record<string, string>
        }> }
      }
      const generation = prepared.activityGenerationToken
      expect(generation).toMatch(/^operation_[a-f0-9-]{16,}$/u)
      expect(prepared.adapterPlan.requiredUserActionDetails).toContainEqual(expect.objectContaining({
        kind: 'qwenwork_mcp_gui',
        operation: 'connect',
        environment: expect.objectContaining({ EB_ACTIVITY_GENERATION_TOKEN: generation }),
      }))
      expect(db.prepare(`
        SELECT delivery_mode, desired_state, artifact_id FROM installation_components
        WHERE installation_id = ? AND component_key = 'memory_tools'
      `).get(installation.id)).toEqual({
        delivery_mode: 'guided', desired_state: 'managed', artifact_id: null,
      })
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM artifact_consumers
        WHERE installation_id = ? AND component_key = 'memory_tools'
      `).get(installation.id)).toEqual({ count: 0 })

      // Simulate a real app restart: reopen the durable DB and let production
      // startup recovery retry verification. Static GUI state must not commit.
      unbind()
      composition.runtime.stop()
      db.close()
      db = new Database(dbPath)
      ensureSchema(db)
      composition = createProductionAgentIntegrationComposition(db, options)
      unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
      await composition.runtime.start()
      expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(connectRun.id))
        .toEqual({ state: 'applied_unverified' })

      for (const signalName of ['session_start', 'pre_compact', 'session_end'] as const) {
        expect(recordHostActivityEvidence(db, {
          agentId: composition.repository.getInstallation(installation.id)!.agent_id!,
          hostVariant: 'qwenwork-desktop', componentKey: 'lifecycle', signalName,
          tideMindVersion: runtime.tideMindVersion, activityGenerationToken: generation,
        }).status).toBe('recorded')
      }
      expect(recordHostActivityEvidence(db, {
        agentId: composition.repository.getInstallation(installation.id)!.agent_id!,
        hostVariant: 'qwenwork-desktop', componentKey: 'memory_tools', signalName: 'brain_recall',
        tideMindVersion: runtime.tideMindVersion, activityGenerationToken: generation,
      }).status).toBe('recorded')
      currentTime = new Date(Date.now() + 1_000)
      await composition.runtime.runMaintenance()
      expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(connectRun.id))
        .toEqual({ state: 'applied_unverified' })

      expect(recordHostActivityEvidence(db, {
        agentId: composition.repository.getInstallation(installation.id)!.agent_id!,
        hostVariant: 'qwenwork-desktop', componentKey: 'memory_tools', signalName: 'brain_digest',
        tideMindVersion: runtime.tideMindVersion, activityGenerationToken: generation,
      }).status).toBe('recorded')
      currentTime = new Date(Date.now() + 1_000)
      await composition.runtime.runMaintenance()
      expect(db.prepare(`SELECT state, failure_code, failure_stage FROM reconcile_runs WHERE id = ?`).get(connectRun.id))
        .toEqual({ state: 'committed', failure_code: null, failure_stage: null })
      const verifiedComponents = db.prepare(`
        SELECT component_key FROM verification_results
        WHERE installation_id = ? AND result = 'verified' AND invalidated_at IS NULL
        ORDER BY component_key
      `).all(installation.id)
      expect(verifiedComponents).toEqual([
        { component_key: 'instruction' },
        { component_key: 'lifecycle' },
        { component_key: 'memory_tools' },
      ])
      expect(composition.repository.getInstallation(installation.id)).toMatchObject({ verified_capability: 4 })
      expect(composition.service.detail(installation.id).installation.lastRealUseAt).not.toBeNull()

      await composition.service.scan()
      expect(composition.repository.getInstallation(installation.id)).toMatchObject({
        verified_capability: 4,
        verification_summary: 'verified',
      })
      expect(db.prepare(`
        SELECT component_key FROM verification_results
        WHERE installation_id = ? AND result = 'verified' AND invalidated_at IS NULL
        ORDER BY component_key
      `).all(installation.id)).toEqual(verifiedComponents)

      // Exercise a production-composed guided connector repair. Reinstalling
      // the GUI connector establishes a new host projection, so every
      // token-carrying projection is regenerated and the old process is no
      // longer authoritative.
      const managedRow = composition.repository.getInstallation(installation.id)!
      const repairInstallation: CoordinatorInstallation = {
        id: installation.id,
        displayName: installation.displayName,
        desiredState: 'managed',
        agentId: managedRow.agent_id!,
        identity: {
          runtimeRealm: managedRow.runtime_realm as 'local_macos',
          osUserIdentity: managedRow.os_user_identity!,
          productFamilyId: managedRow.family,
          hostVariant: managedRow.host_variant as CatalogId,
          canonicalConfigRoot: managedRow.config_root!,
          componentConfigRoots: persistedComponentConfigRoots(managedRow),
          componentConfigFiles: persistedComponentConfigFiles(managedRow),
          explicitProfile: managedRow.profile_id || 'default',
          hostOwnedIdentity: persistedHostOwnedIdentity(managedRow),
          distribution: persistedDistribution(managedRow),
          installKey: managedRow.install_key,
        },
      }
      const repairPlan = await composition.coordinator.preview({
        installation: repairInstallation,
        operation: 'repair',
        componentKeys: ['instruction', 'lifecycle', 'memory_tools'],
        desiredCapability: 4,
      })
      const repairGeneration = repairPlan.activityGenerationToken
      expect(repairGeneration).not.toBe(generation)
      expect(repairPlan.adapterPlan.requiredUserActionDetails).toContainEqual(expect.objectContaining({
        kind: 'qwenwork_mcp_gui',
        operation: 'connect',
        environment: expect.objectContaining({ EB_ACTIVITY_GENERATION_TOKEN: repairGeneration }),
      }))
      const repairOutcome = await composition.coordinator.applyPrepared({
        installation: repairInstallation,
        preparedPlan: repairPlan,
        consentId: managedRow.consent_envelope_id,
        desiredCapability: 4,
      })
      expect(repairOutcome).toMatchObject({ status: 'awaiting_verification' })
      const repairRunId = 'runId' in repairOutcome ? repairOutcome.runId : ''
      const repairActivityAt = new Date(currentTime.getTime() + 1_000).toISOString()
      expect(recordHostActivityEvidence(db, {
        agentId: composition.repository.getInstallation(installation.id)!.agent_id!,
        hostVariant: 'qwenwork-desktop', componentKey: 'memory_tools', signalName: 'brain_recall',
        tideMindVersion: runtime.tideMindVersion, activityGenerationToken: generation,
      })).toEqual({ status: 'rejected', reason: 'activity_generation_mismatch' })
      for (const signalName of ['session_start', 'pre_compact', 'session_end'] as const) {
        expect(recordHostActivityEvidence(db, {
          agentId: composition.repository.getInstallation(installation.id)!.agent_id!,
          hostVariant: 'qwenwork-desktop', componentKey: 'lifecycle', signalName,
          tideMindVersion: runtime.tideMindVersion, activityGenerationToken: repairGeneration,
          observedAt: repairActivityAt,
        }).status).toBe('recorded')
      }
      for (const signalName of ['brain_recall', 'brain_digest'] as const) {
        expect(recordHostActivityEvidence(db, {
          agentId: composition.repository.getInstallation(installation.id)!.agent_id!,
          hostVariant: 'qwenwork-desktop', componentKey: 'memory_tools', signalName,
          tideMindVersion: runtime.tideMindVersion, activityGenerationToken: repairGeneration,
          observedAt: repairActivityAt,
        }).status).toBe('recorded')
      }
      currentTime = new Date(Date.parse(repairActivityAt) + 1_000)
      await composition.runtime.runMaintenance()
      expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(repairRunId))
        .toEqual({ state: 'committed' })
      expect(composition.repository.getInstallation(installation.id)).toMatchObject({ verified_capability: 4 })

      const instructionTarget = (db.prepare(`
        SELECT artifact.target_path
        FROM installation_components component
        JOIN managed_artifacts artifact ON artifact.id = component.artifact_id
        WHERE component.installation_id = ? AND component.component_key = 'instruction'
      `).get(installation.id) as { target_path: string }).target_path
      const disconnectPreview = await composition.service.previewDisconnect(installation.id)
      const disconnected = await composition.service.disconnect(disconnectPreview.planHash, installation.id)
      expect(disconnected.results[0]).toMatchObject({ status: 'awaiting_verification' })
      const disconnectRun = db.prepare(`
        SELECT state, prepared_plan_json FROM reconcile_runs
        WHERE installation_id = ? AND operation_type = 'disconnect'
        ORDER BY rowid DESC LIMIT 1
      `).get(installation.id) as { state: string; prepared_plan_json: string }
      expect(disconnectRun.state).toBe('applied_unverified')
      expect(JSON.parse(disconnectRun.prepared_plan_json).adapterPlan.requiredUserActionDetails)
        .toContainEqual(expect.objectContaining({ kind: 'qwenwork_mcp_gui', operation: 'disconnect' }))
      expect(db.prepare(`
        SELECT delivery_mode, desired_state, artifact_id FROM installation_components
        WHERE installation_id = ? AND component_key = 'memory_tools'
      `).get(installation.id)).toEqual({
        delivery_mode: 'guided', desired_state: 'removed', artifact_id: null,
      })
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM artifact_consumers
        WHERE installation_id = ? AND component_key = 'memory_tools'
      `).get(installation.id)).toEqual({ count: 0 })

      const beforeRemovalReview = composition.service.reviewGuidedRemoval(installation.id)
      expect(await composition.service.confirmGuidedRemoval(beforeRemovalReview.actionHash)).toMatchObject({
        status: 'not_ready', receiptId: null, runId: expect.any(String),
      })
      // The opaque confirmation can be reconstructed after restart, but it
      // cannot succeed until the exact frozen managed Skill is physically gone.
      unbind()
      composition.runtime.stop()
      db.close()
      db = new Database(dbPath)
      ensureSchema(db)
      composition = createProductionAgentIntegrationComposition(db, options)
      unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
      await composition.runtime.start()
      const expiredReview = composition.service.reviewGuidedRemoval(installation.id)
      currentTime = new Date(currentTime.getTime() + (16 * 60 * 1_000))
      await expect(composition.service.confirmGuidedRemoval(expiredReview.actionHash))
        .rejects.toThrow(/unknown or has expired/)
      const removalReview = composition.service.reviewGuidedRemoval(installation.id)
      const currentRemoval = composition.repository.getPendingGuidedRemovalAction(installation.id)!
      expect(() => composition.repository.recordGuidedRemovalEvidence({
        installationId: installation.id,
        agentId: composition.repository.getInstallation(installation.id)!.agent_id!,
        hostVariant: 'qwenwork-desktop',
        componentKey: 'memory_tools',
        activationRunId: currentRemoval.runId,
        activityGenerationToken: 'operation-stale-generation',
        connectorName: currentRemoval.connectorAction.connectorName,
        confirmedAt: new Date().toISOString(),
      })).toThrow(/generation changed/)
      db.prepare(`UPDATE agent_installations SET config_root = NULL WHERE id = ?`).run(installation.id)
      await expect(composition.service.confirmGuidedRemoval(removalReview.actionHash))
        .rejects.toThrow(/action changed/)
      db.prepare(`UPDATE agent_installations SET config_root = ? WHERE id = ?`).run(configRoot, installation.id)
      fs.unlinkSync(instructionTarget)
      // A filesystem-triggered maintenance pass can finish checking the old
      // evidence while the user is confirming removal. Hold that pass before
      // it resolves so the new receipt must request another recovery pass.
      let recoveryRead!: () => void
      let releaseRecovery!: () => void
      const recoveryReadBarrier = new Promise<void>(resolve => { recoveryRead = resolve })
      const releaseRecoveryBarrier = new Promise<void>(resolve => { releaseRecovery = resolve })
      const recover = composition.coordinator.recoverNonTerminalRuns.bind(composition.coordinator)
      const recoverySpy = vi.spyOn(composition.coordinator, 'recoverNonTerminalRuns')
        .mockImplementationOnce(async recoveryOptions => {
          const result = await recover(recoveryOptions)
          recoveryRead()
          await releaseRecoveryBarrier
          return result
        })
      const existingMaintenance = composition.runtime.runMaintenance()
      await recoveryReadBarrier
      const confirmation = composition.service.confirmGuidedRemoval(removalReview.actionHash)
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM agent_integration_events
        WHERE installation_id = ? AND kind = 'user_confirmed_guided_removal'
      `).get(installation.id)).toEqual({ count: 1 })
      const concurrentMaintenance = [composition.runtime.runMaintenance(), composition.runtime.runMaintenance()]
      expect(recoverySpy).toHaveBeenCalledTimes(1)
      releaseRecovery()
      const confirmed = await confirmation
      await existingMaintenance
      await Promise.all(concurrentMaintenance)
      expect(recoverySpy).toHaveBeenCalledTimes(2)
      recoverySpy.mockRestore()
      expect(confirmed).toMatchObject({
        installationId: installation.id,
        runId: expect.any(String),
        status: 'removal_confirmed',
        receiptId: expect.stringMatching(/^aie_/u),
      })
      expect(db.prepare(`SELECT state FROM reconcile_runs WHERE id = ?`).get(confirmed.runId))
        .toEqual({ state: 'committed' })
      expect(db.prepare(`
        SELECT component_key, desired_state FROM installation_components
        WHERE installation_id = ? ORDER BY component_key
      `).all(installation.id)).toEqual([
        { component_key: 'instruction', desired_state: 'removed' },
        { component_key: 'lifecycle', desired_state: 'removed' },
        { component_key: 'memory_tools', desired_state: 'removed' },
      ])
      expect(db.prepare(`
        SELECT kind FROM agent_integration_events WHERE id = ?
      `).get(confirmed.receiptId)).toEqual({ kind: 'user_confirmed_guided_removal' })
      await expect(composition.service.confirmGuidedRemoval(removalReview.actionHash))
        .rejects.toThrow(/unknown or has expired/)
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('runs a Custom MCP target through scoped trust, C2 activity, auto-repair, and exact disconnect', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-custom-e2e-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const executable = path.join(home, 'bin', 'private-agent')
    const configFile = path.join(home, '.private-agent', 'mcp.json')
    const runtime = runtimeContext(home)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.mkdirSync(path.dirname(runtime.shimPath), { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(configFile, JSON.stringify({ userSetting: true }, null, 2), { mode: 0o600 })
    fs.writeFileSync(runtime.shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(runtime.mcpServerPath, '// packaged MCP runtime\n', { mode: 0o600 })
    const db = new Database(':memory:')
    ensureSchema(db)
    const customHost = createCustomLocalMcpHostAdapter()
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtime,
      adapters: new Map([['custom-local-mcp', customHost]]),
      enabledAdapterIds: ['custom-local-mcp'],
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      autoRestore: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const preflight = await composition.service.previewCustomInstallation({
        mode: 'manual_mcp_client',
        displayName: 'Private Agent',
        clientExecutablePath: executable,
        configFilePath: configFile,
        schemaKind: 'standard_mcp_servers',
        selectorKey: 'tidemind-private',
      })
      const preview = await composition.service.prepareCustomConnect(preflight.preflightHash)
      const installationId = preview.installations[0]!.installationId
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        id: installationId,
        hostVariant: 'custom-local-mcp',
        manageable: true,
      })

      const applied = await composition.service.applyConnect(preview.planHash, [installationId])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      expect(composition.repository.getInstallation(installationId)).toMatchObject({
        supported_capability: 2,
        desired_capability: 2,
      })
      const installedMcpEntry = JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers['tidemind-private']
      expect(installedMcpEntry).toEqual({
        command: runtime.shimPath,
        args: [runtime.mcpServerPath],
        env: {
          EB_AGENT_ID: preflight.agentId,
          EB_HOST_VARIANT: 'custom-local-mcp',
          EB_ACTIVITY_GENERATION_TOKEN: expect.any(String),
        },
      })
      const activityGenerationToken = installedMcpEntry.env.EB_ACTIVITY_GENERATION_TOKEN as string

      const activity = recordHostActivityEvidence(db, {
        agentId: preflight.agentId,
        hostVariant: 'custom-local-mcp',
        componentKey: 'memory_tools',
        signalName: 'brain_recall',
        tideMindVersion: runtime.tideMindVersion,
        activityGenerationToken,
      })
      expect(activity.status).toBe('recorded')
      await composition.service.scan()
      expect(composition.repository.getInstallation(installationId)).toMatchObject({
        desired_state: 'managed',
        verified_capability: 0,
      })
      expect(db.prepare(`
        SELECT r.state, r.desired_capability, r.failure_code, c.status AS consent_status
        FROM reconcile_runs r JOIN agent_consents c ON c.id = r.consent_envelope_id
        WHERE r.installation_id = ? ORDER BY r.created_at DESC LIMIT 1
      `).get(installationId)).toMatchObject({
        state: 'applied_unverified', desired_capability: 2,
        failure_code: null, consent_status: 'active',
      })
      const writeActivity = recordHostActivityEvidence(db, {
        agentId: preflight.agentId,
        hostVariant: 'custom-local-mcp',
        componentKey: 'memory_tools',
        signalName: 'brain_digest',
        tideMindVersion: runtime.tideMindVersion,
        activityGenerationToken,
      })
      expect(writeActivity.status).toBe('recorded')
      await composition.service.scan()
      expect(composition.repository.getInstallation(installationId)).toMatchObject({
        desired_state: 'managed',
        verified_capability: 2,
      })
      expect(composition.service.snapshot().installations[0]?.accessLevel).toBe('partial')

      const metadataEvidence = createProductionAgentHostMetadataEvidenceRuntime(home, { runtimeContext: runtime })
      const currentCustomRow = composition.repository.getInstallation(installationId)!
      await expect(metadataEvidence.attestCustom(currentCustomRow, db)).resolves.toMatch(/^[a-f0-9]{64}$/u)
      await expect(metadataEvidence.inspect(currentCustomRow, db)).resolves.toMatchObject({
        catalogId: 'custom-local-mcp',
        detected: true,
        components: [{ componentKey: 'memory_tools', visibility: 'dedicated' }],
      })

      const drifted = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      delete drifted.mcpServers['tidemind-private']
      fs.writeFileSync(configFile, JSON.stringify(drifted, null, 2), { mode: 0o600 })
      await composition.service.scan()
      expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers['tidemind-private']).toBeDefined()

      const disconnectPreview = await composition.service.previewDisconnect(installationId)
      const disconnected = await composition.service.disconnect(disconnectPreview.planHash, installationId)
      expect(disconnected.results[0]).toMatchObject({ status: 'committed' })
      expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({ userSetting: true })
      expect(composition.repository.getInstallation(installationId)?.desired_state).toBe('removed')
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.each(['standard_mcp_servers', 'nested_mcp_servers', 'opencode_mcp'] as const)('completes user-owned Custom %s import with no config file, real activity and explicit removal', async (schemaKind) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-custom-guided-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const executable = path.join(home, 'private-agent')
    const runtime = runtimeContext(home)
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    fs.mkdirSync(path.dirname(runtime.shimPath), { recursive: true })
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(runtime.shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(runtime.mcpServerPath, '// MCP runtime\n')
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home, applicationDataDir: appData, runtimeContext: runtime,
      adapters: new Map([['custom-local-mcp', createCustomLocalMcpHostAdapter()]]),
      enabledAdapterIds: ['custom-local-mcp'],
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      autoRestore: true, startRuntime: false, notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const preflight = await composition.service.previewCustomInstallation({
        mode: 'manual_mcp_client', configurationOwnership: 'user', displayName: 'User-owned client',
        clientExecutablePath: executable, configFilePath: '', schemaKind, selectorKey: 'tidemind-private',
      })
      const preview = await composition.service.prepareCustomConnect(preflight.preflightHash)
      const installationId = preview.installations[0].installationId
      expect(preview.installations[0].targets).toEqual([])
      const action = preview.installations[0].requiredUserActionDetails?.find(item => item.kind === 'custom_mcp_import')
      expect(action).toMatchObject({ kind: 'custom_mcp_import', usageGuide: expect.stringContaining('brain_recall') })
      if (action?.kind !== 'custom_mcp_import') throw new Error('missing import action')
      const config = JSON.parse(composition.service.customMcpConfiguration(preflight.preflightHash))
      expect(action.connectorName).toBe('tidemind-private')
      const entry = schemaKind === 'standard_mcp_servers' ? config.mcpServers[action.connectorName]
        : schemaKind === 'nested_mcp_servers' ? config.mcp.servers[action.connectorName] : config.mcp[action.connectorName]
      const token = (entry.env ?? entry.environment).EB_ACTIVITY_GENERATION_TOKEN
      expect(JSON.parse(action.configurationJson)).toEqual(config)
      expect(token).toBeTruthy()
      const before = fs.readdirSync(home, { recursive: true }).sort()
      const userFiles = before.filter(relative => fs.statSync(path.join(home, relative)).isFile())
        .map(relative => ({ relative, bytes: fs.readFileSync(path.join(home, relative)) }))
      const assertOnlyPrivateLockDirectoriesAdded = () => {
        const privateDirectories = ['.tidemind', '.tidemind/agent-integration', '.tidemind/agent-integration/writer-locks']
        expect(fs.readdirSync(home, { recursive: true }).sort()).toEqual([...before, ...privateDirectories].sort())
        for (const relative of privateDirectories) {
          const stat = fs.lstatSync(path.join(home, relative))
          expect(stat.isDirectory()).toBe(true)
          expect(stat.mode & 0o077).toBe(0)
        }
        expect(fs.readdirSync(path.join(home, privateDirectories[2]))).toEqual([])
        for (const file of userFiles) expect(fs.readFileSync(path.join(home, file.relative))).toEqual(file.bytes)
      }
      const result = await composition.service.applyConnect(preview.planHash, [installationId])
      expect(result.results[0]).toMatchObject({ status: 'awaiting_verification' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM managed_artifacts').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_consumers').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT delivery_mode, artifact_id FROM installation_components WHERE installation_id = ?').get(installationId))
        .toMatchObject({ delivery_mode: 'guided', artifact_id: null })
      const invoke = (signalName: 'brain_recall' | 'brain_digest', activityGenerationToken = token) => recordHostActivityEvidence(db, {
        agentId: preflight.agentId, hostVariant: 'custom-local-mcp', componentKey: 'memory_tools', signalName,
        tideMindVersion: runtime.tideMindVersion, activityGenerationToken,
      })
      expect(invoke('brain_recall', 'stale-token').status).toBe('rejected')
      expect(invoke('brain_recall').status).toBe('recorded')
      await composition.service.scan()
      expect(composition.repository.getInstallation(installationId)?.verified_capability).toBe(0)
      expect(invoke('brain_digest').status).toBe('recorded')
      await composition.service.scan()
      expect(composition.repository.getInstallation(installationId)?.verified_capability,
        JSON.stringify({ runs: db.prepare('SELECT state, failure_code FROM reconcile_runs').all(),
          verifications: db.prepare('SELECT result, method FROM verification_results').all(),
          component: db.prepare('SELECT verification_status, visibility_state FROM installation_components').all(),
          events: db.prepare('SELECT signal_name FROM agent_host_activity_evidence').all() })).toBe(2)
      assertOnlyPrivateLockDirectoriesAdded()
      composition.service.pause(installationId)
      expect(invoke('brain_digest').status).toBe('rejected')
      await composition.service.resume(installationId)
      expect(invoke('brain_digest').status).toBe('recorded')
      const disconnect = await composition.service.previewDisconnect(installationId)
      expect(disconnect.installations[0].targets).toEqual([])
      expect((await composition.service.disconnect(disconnect.planHash, installationId)).results[0].status).toBe('awaiting_verification')
      const removal = composition.service.reviewGuidedRemoval(installationId)
      const confirmed = await composition.service.confirmGuidedRemoval(removal.actionHash)
      expect(confirmed.status).toBe('removal_confirmed')
      expect(db.prepare('SELECT state FROM reconcile_runs WHERE id = ?').get(confirmed.runId)).toEqual({ state: 'committed' })
      expect(invoke('brain_digest').status).toBe('rejected')
      await expect(composition.service.confirmGuidedRemoval(removal.actionHash)).rejects.toThrow(/unknown or has expired/)
      assertOnlyPrivateLockDirectoriesAdded()
    } finally {
      unbind(); composition.runtime.stop(); db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('relocates a Custom root through the production coordinator and real Cursor Adapter', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-custom-root-')))
    const home = path.join(root, 'home')
    const sourceRoot = path.join(home, '.cursor')
    const customRoot = path.join(home, '.cursor-work')
    const appData = path.join(root, 'app-data')
    const runtime = runtimeContext(home)
    fs.mkdirSync(sourceRoot, { recursive: true })
    fs.mkdirSync(customRoot, { recursive: true })
    fs.mkdirSync(path.dirname(runtime.shimPath), { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    for (const asset of [
      runtime.shimPath,
      runtime.mcpServerPath,
      path.join(path.dirname(runtime.hookScriptPath), 'hook-cursor-lifecycle.cjs'),
    ]) fs.writeFileSync(asset, '// packaged runtime\n', { mode: 0o700 })
    const sourceIdentity = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_1234',
      productFamilyId: 'cursor',
      hostVariant: 'cursor-desktop',
      configRoot: sourceRoot,
      distribution: {
        distributionId: 'com.todesktop.230313mzl4w4u92',
        executableRealpath: path.join(root, 'Cursor'),
        packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9',
        capabilityFingerprint: 'signed-cursor-test',
      },
    })
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtime,
      enabledAdapterIds: ['cursor-desktop'],
      scanner: { scan: async () => ({
        installations: [{
          catalogId: 'cursor-desktop',
          displayName: 'Cursor',
          identity: sourceIdentity,
          configRoot: sourceRoot,
          executablePath: path.join(root, 'Cursor'),
          detectedVersion: '3.10.20',
          versionDetectionMethod: 'bundle_plist',
          managementEligibility: freshCliManagementEligibility(),
          provenance: ['signed test fixture'],
          evidence: [],
        }],
        unresolved: [],
        diagnostics: [],
      }) },
      fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      startRuntime: false,
    })
    composition.repository.upsertDiscoveredInstallation({
      id: 'cursor-source',
      family: 'cursor',
      hostVariant: 'cursor-desktop',
      installKey: sourceIdentity.installKey,
      distributionId: 'com.todesktop.230313mzl4w4u92',
      provenance: 'signed test fixture',
      osUserIdentity: sourceIdentity.osUserIdentity,
      displayName: 'Cursor',
      configRoot: sourceRoot,
      executablePath: path.join(root, 'Cursor'),
      detectedVersion: '3.10.20',
      versionDetectionMethod: 'bundle_plist',
      agentId: 'eb_cursor_source',
      supportedCapability: 4,
      lastDetectedAt: '2026-09-05T00:00:00.000Z',
      metadata: {
        distribution: {
          distributionId: 'com.todesktop.230313mzl4w4u92',
          executableRealpath: path.join(root, 'Cursor'),
          packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9',
          capabilityFingerprint: 'signed-cursor-test',
        },
        managementEligibility: freshCliManagementEligibility(),
      },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const preflight = await composition.service.previewCustomInstallation({
        mode: 'nonstandard_config_root',
        displayName: 'Cursor Work',
        sourceInstallationId: 'cursor-source',
        configRoot: customRoot,
      })
      const preview = await composition.service.prepareCustomConnect(preflight.preflightHash)
      const custom = preview.installations[0]!
      expect(custom.targets.map(target => target.targetLabel)).toEqual(expect.arrayContaining([
        '~/.cursor-work/skills/tidemind/SKILL.md',
        '~/.cursor-work/mcp.json',
        '~/.cursor-work/hooks.json',
      ]))
      expect(custom.targets.every(target => target.targetLabel.startsWith('~/.cursor-work/'))).toBe(true)

      // Automatic discovery has no standard installKey for this Custom root;
      // two consecutive scans must retain it via its scoped source/root proof.
      await composition.service.scan()
      await composition.service.scan()
      expect(composition.repository.getInstallation(custom.installationId)).toMatchObject({
        health_state: 'discovered',
        status_reason: null,
      })

      const applied = await composition.service.applyConnect(preview.planHash, [custom.installationId])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      expect(fs.existsSync(path.join(customRoot, 'skills', 'tidemind', 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(customRoot, 'mcp.json'))).toBe(true)
      expect(fs.existsSync(path.join(customRoot, 'hooks.json'))).toBe(true)
      expect(fs.readdirSync(sourceRoot)).toEqual([])
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('fails closed when a frozen Custom executable is replaced before preview', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-production-custom-tamper-')))
    const home = path.join(root, 'home')
    const executable = path.join(home, 'bin', 'private-agent')
    const configFile = path.join(home, '.private-agent', 'mcp.json')
    const runtime = runtimeContext(home)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.mkdirSync(path.dirname(runtime.shimPath), { recursive: true })
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(configFile, '{}\n', { mode: 0o600 })
    fs.writeFileSync(runtime.shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fs.writeFileSync(runtime.mcpServerPath, '// packaged MCP runtime\n', { mode: 0o600 })
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home,
      applicationDataDir: path.join(root, 'app-data'),
      runtimeContext: runtime,
      adapters: new Map([['custom-local-mcp', createCustomLocalMcpHostAdapter()]]),
      enabledAdapterIds: ['custom-local-mcp'],
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      startRuntime: false,
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const preflight = await composition.service.previewCustomInstallation({
        mode: 'manual_mcp_client', displayName: 'Private Agent',
        clientExecutablePath: executable, configFilePath: configFile,
        schemaKind: 'standard_mcp_servers', selectorKey: 'tidemind-private',
      })
      const replacement = path.join(home, 'bin', 'replacement')
      fs.writeFileSync(replacement, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
      fs.renameSync(replacement, executable)

      await expect(composition.service.prepareCustomConnect(preflight.preflightHash))
        .rejects.toThrow(/surface changed|not enabled|trust/i)
      expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({})
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
