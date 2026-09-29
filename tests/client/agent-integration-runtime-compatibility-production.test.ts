import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-test-app-data',
    getVersion: () => '0.2.92-test',
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
import { createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import {
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  DESKTOP_BUNDLE_SURFACE_SCHEMA,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  type DiscoveredInstallation,
  type LocalDiscoveryReport,
} from '../../client/electron/agent-integration/discovery'
import {
  applyRuntimeCompatibilityToReport,
  currentArchitecture,
  setSourceVerificationStore,
  type SourceVerificationKey,
  type SourceVerificationRecord,
  type SourceVerificationStore,
} from '../../client/electron/agent-integration/runtime-compatibility'
import { AGENT_INTEGRATION_RELEASE_ENTRY_MAP } from '../../client/electron/agent-integration/release-manifest'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'
import { ensureSchema } from '../../src/db/schema.js'

// End-to-end runtime source compatibility through the production composition
// (implementation notes §2 A-WP1). Two seams are exercised:
//  - "enforced": no injected scanner/Adapters, so every read recomputes the runtime
//    source decision from the persisted surface and the process-wide store;
//  - "hermetic scan": an injected scanner gated by applyRuntimeCompatibilityToReport,
//    exactly like the production releaseGatedScanner, so supported_capability and the
//    persisted reason come from a real scan.

const T0 = '2026-09-25T00:00:00.000Z'
const CHECKED_AT = '2026-09-25T00:30:00.000Z'
const UNTESTED_CODEX_VERSION = '0.200.0'
const UNTESTED_FINGERPRINT = 'c'.repeat(64)

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

function freshEligibility() {
  return {
    schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
    eligible: true,
    executableSizeBytes: 1_024,
    proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
  } as const
}

function keyString(key: SourceVerificationKey): string {
  return JSON.stringify([key.distributionId, key.packageProvenance, key.version, key.architecture, key.portableArtifactFingerprint])
}

function mutableStore() {
  const records = new Map<string, SourceVerificationRecord>()
  const store: SourceVerificationStore & { put: (key: SourceVerificationKey, record: SourceVerificationRecord) => void } = {
    lookup: key => records.get(keyString(key)) ?? null,
    put: (key, record) => { records.set(keyString(key), record) },
  }
  return store
}

const CODEX_KEY: SourceVerificationKey = {
  distributionId: 'cli:codex-cli',
  packageProvenance: 'npm_metadata:@openai/codex',
  version: UNTESTED_CODEX_VERSION,
  architecture: currentArchitecture(),
  portableArtifactFingerprint: UNTESTED_FINGERPRINT,
}

function withRoot<T>(prefix: string, run: (root: string, db: Database.Database) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const db = new Database(':memory:')
  ensureSchema(db)
  return run(root, db).finally(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
}

function enforcedComposition(root: string, db: Database.Database, enabledAdapterIds: readonly string[]) {
  return createProductionAgentIntegrationComposition(db, {
    homeDir: root,
    applicationDataDir: path.join(root, 'app-data'),
    runtimeContext: runtimeContext(root),
    fixtureMode: 'isolated_ui_audit',
    // Distribution trust is stubbed; the runtime source decision is not.
    canManageInstallation: () => true,
    enabledAdapterIds: enabledAdapterIds as never,
    observeOnly: false,
    startRuntime: false,
  })
}

function persistCodex(
  composition: ReturnType<typeof createProductionAgentIntegrationComposition>,
  root: string,
  overrides: { eligibility?: Record<string, unknown>; version?: string; fingerprint?: string } = {},
): string {
  const executable = path.join(root, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  composition.repository.upsertDiscoveredInstallation({
    id: 'codex-untested',
    family: 'codex',
    hostVariant: 'codex-cli',
    installKey: 'codex:untested',
    distributionId: 'cli:codex-cli',
    provenance: 'command:PATH:codex',
    osUserIdentity: 'usr_fixture_1234',
    displayName: 'Codex CLI',
    configRoot: path.join(root, '.codex'),
    executablePath: executable,
    detectedVersion: overrides.version ?? UNTESTED_CODEX_VERSION,
    versionDetectionMethod: 'cli_version',
    agentId: 'agent-codex-untested',
    supportedCapability: 3,
    lastDetectedAt: T0,
    metadata: {
      distribution: {
        distributionId: 'cli:codex-cli',
        executableRealpath: executable,
        packageProvenance: 'npm_metadata:@openai/codex',
        capabilityFingerprint: 'cli-surface:fixture-codex',
        portableArtifactFingerprint: overrides.fingerprint ?? UNTESTED_FINGERPRINT,
      },
      managementEligibility: overrides.eligibility ?? freshEligibility(),
    },
  })
  return 'codex-untested'
}

afterEach(() => {
  setSourceVerificationStore(null)
  vi.restoreAllMocks()
})

describe('runtime source compatibility – enforced production composition', () => {
  it('manages an official signed App at a never-tested version', () => withRoot('agent-rc-signed-', async (root, db) => {
    const composition = enforcedComposition(root, db, ['cursor-desktop'])
    try {
      const appPath = path.join(root, 'Cursor.app')
      const executable = path.join(appPath, 'Contents', 'MacOS', 'Cursor')
      const tested = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get('cursor-desktop')!.releaseAcceptedExactVersions
      expect(tested).not.toContain('3.99.0')
      composition.repository.upsertDiscoveredInstallation({
        id: 'cursor-untested',
        family: 'cursor',
        hostVariant: 'cursor-desktop',
        installKey: 'cursor:untested',
        distributionId: 'com.todesktop.230313mzl4w4u92',
        provenance: 'app_bundle',
        osUserIdentity: 'usr_fixture_1234',
        displayName: 'Cursor',
        configRoot: path.join(root, '.cursor'),
        executablePath: executable,
        appPath,
        detectedVersion: '3.99.0',
        versionDetectionMethod: 'bundle_plist',
        agentId: 'agent-cursor-untested',
        supportedCapability: 4,
        lastDetectedAt: T0,
        metadata: {
          distribution: {
            distributionId: 'com.todesktop.230313mzl4w4u92',
            executableRealpath: executable,
            packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9',
            capabilityFingerprint: `${DESKTOP_BUNDLE_SURFACE_SCHEMA}:fixture-untested`,
            portableArtifactFingerprint: UNTESTED_FINGERPRINT,
          },
        },
      })
      const dto = composition.service.snapshot().installations.find(item => item.id === 'cursor-untested')!
      expect(dto).toMatchObject({ manageable: true, version: '3.99.0' })
      expect(dto.statusReason).not.toMatch(/^release_|^source_/)
      expect(composition.service.detail('cursor-untested').installation).toMatchObject({ manageable: true })
    } finally {
      composition.runtime.stop()
    }
  }))

  it('keeps an unverified npm generation visible but pending, then follows the cached registry verdict', () => withRoot('agent-rc-npm-', async (root, db) => {
    const store = mutableStore()
    const composition = enforcedComposition(root, db, ['codex-cli'])
    // The production composition installs its SQLite-backed store; replace it with
    // the in-memory one for this scenario.
    setSourceVerificationStore(store)
    try {
      const id = persistCodex(composition, root)

      // 1. No verification record: visible, not manageable, product capability kept.
      expect(composition.service.snapshot().installations).toHaveLength(1)
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        id,
        manageable: false,
        statusReason: 'source_verification_pending',
        version: UNTESTED_CODEX_VERSION,
      })
      expect(composition.service.detail(id).installation).toMatchObject({
        manageable: false,
        statusReason: 'source_verification_pending',
      })
      await expect(composition.service.previewConnect([id]))
        .rejects.toThrow('managed integration is unavailable: source_verification_pending')
      expect(composition.repository.getInstallation(id)!.supported_capability).toBeGreaterThan(0)
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })

      // 2. The official registry verification for this exact generation is cached.
      store.put(CODEX_KEY, { status: 'verified', checkedAt: CHECKED_AT })
      expect(composition.service.snapshot().installations[0]).toMatchObject({ manageable: true })
      expect(composition.service.snapshot().installations[0].statusReason).not.toMatch(/^source_|^release_/)

      // 3. A later mismatch (local bytes differ from the official tarball) blocks it again.
      store.put(CODEX_KEY, { status: 'mismatch', checkedAt: CHECKED_AT })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'source_not_official',
      })
      await expect(composition.service.previewConnect([id]))
        .rejects.toThrow('managed integration is unavailable: source_not_official')

      // 4. A verification never carries over to another generation.
      store.put(CODEX_KEY, { status: 'verified', checkedAt: CHECKED_AT })
      persistCodex(composition, root, { version: '0.201.0' })
      expect(composition.service.snapshot().installations[0]).toMatchObject({
        manageable: false,
        statusReason: 'source_verification_pending',
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_mutations').get()).toEqual({ count: 0 })
    } finally {
      composition.runtime.stop()
    }
  }))

  it('manages the exact tested npm sample without any registry record', () => withRoot('agent-rc-npm-tested-', async (root, db) => {
    const composition = enforcedComposition(root, db, ['codex-cli'])
    try {
      const sample = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get('codex-cli')!.acceptedDistributionArtifacts
        .find(candidate => candidate.architecture === currentArchitecture())!
      persistCodex(composition, root, { version: sample.version, fingerprint: sample.portableArtifactFingerprint })
      expect(composition.service.snapshot().installations[0]).toMatchObject({ manageable: true })
    } finally {
      composition.runtime.stop()
    }
  }))

  it.each(['release_version_not_accepted', 'release_artifact_not_accepted'] as const)(
    'treats a legacy persisted %s as stale inventory awaiting a rescan, not a permanent rejection',
    reason => withRoot('agent-rc-legacy-reason-', async (root, db) => {
      const store = mutableStore()
      store.put(CODEX_KEY, { status: 'verified', checkedAt: CHECKED_AT })
      setSourceVerificationStore(store)
      const composition = enforcedComposition(root, db, ['codex-cli'])
      try {
        const id = persistCodex(composition, root, {
          eligibility: {
            schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
            eligible: false,
            reason,
            proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
          },
        })
        expect(composition.service.snapshot().installations[0]).toMatchObject({
          manageable: false,
          statusReason: 'source_verification_pending',
        })
        await expect(composition.service.previewConnect([id]))
          .rejects.toThrow('managed integration is unavailable: source_verification_pending')
      } finally {
        composition.runtime.stop()
      }
    }),
  )
})

// ---------------------------------------------------------------------------
// Hermetic scan through the same gate the production scanner uses
// ---------------------------------------------------------------------------

function discoveredCodex(root: string): DiscoveredInstallation {
  const executable = path.join(root, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const configRoot = path.join(root, '.codex')
  return {
    catalogId: 'codex-cli',
    displayName: 'Codex CLI',
    identity: canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_1234',
      productFamilyId: 'codex',
      hostVariant: 'codex-cli',
      configRoot,
      distribution: {
        distributionId: 'cli:codex-cli',
        executableRealpath: executable,
        packageProvenance: 'npm_metadata:@openai/codex',
        capabilityFingerprint: 'cli-surface:fixture-codex',
        portableArtifactFingerprint: UNTESTED_FINGERPRINT,
      },
    }),
    configRoot,
    executablePath: executable,
    detectedVersion: UNTESTED_CODEX_VERSION,
    versionDetectionMethod: 'cli_version',
    managementEligibility: freshEligibility(),
    provenance: ['npm_metadata:@openai/codex'],
    evidence: [],
  }
}

function hermeticScanComposition(root: string, db: Database.Database, store: SourceVerificationStore) {
  const scanner = {
    scan: vi.fn(async (): Promise<LocalDiscoveryReport> => applyRuntimeCompatibilityToReport({
      installations: [discoveredCodex(root)],
      unresolved: [],
      diagnostics: [],
    }, { store })),
  }
  const composition = createProductionAgentIntegrationComposition(db, {
    homeDir: root,
    applicationDataDir: path.join(root, 'app-data'),
    runtimeContext: runtimeContext(root),
    scanner,
    enabledAdapterIds: ['codex-cli'],
    observeOnly: false,
    startRuntime: false,
    notifications: { deliver: vi.fn() },
  })
  return { composition, scanner }
}

describe('runtime source compatibility – scanned capability and write gate', () => {
  it('keeps supported capability while pending, becomes manageable once verified, and drops to 0 on mismatch', () => withRoot('agent-rc-scan-', async (root, db) => {
    const store = mutableStore()
    const { composition, scanner } = hermeticScanComposition(root, db, store)
    const targetCapability = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get('codex-cli')!.targetCapability
    try {
      // Pending: product capability retained (not "incompatible"), writes refused.
      const first = await composition.service.scan()
      expect(scanner.scan).toHaveBeenCalledTimes(1)
      const pending = first.snapshot.installations.find(item => item.hostVariant === 'codex-cli')!
      expect(pending).toMatchObject({ manageable: false, statusReason: 'source_verification_pending' })
      const pendingRow = composition.repository.getInstallation(pending.id)!
      expect(pendingRow.supported_capability).toBe(targetCapability)
      expect(pendingRow.supported_capability).toBeGreaterThan(0)
      expect(pendingRow.health_state).toBe('discovered')
      await expect(composition.service.previewConnect([pending.id]))
        .rejects.toThrow('managed integration is unavailable: source_verification_pending')

      // Verified: the next scan leaves the executable-proof eligibility intact.
      store.put(CODEX_KEY, { status: 'verified', checkedAt: CHECKED_AT })
      const second = await composition.service.scan()
      const verified = second.snapshot.installations.find(item => item.id === pending.id)!
      expect(verified).toMatchObject({ manageable: true })
      expect(composition.repository.getInstallation(pending.id)!.supported_capability).toBe(targetCapability)

      // Mismatch: definitive rejection → incompatible (capability 0) and not manageable.
      store.put(CODEX_KEY, { status: 'mismatch', checkedAt: CHECKED_AT })
      const third = await composition.service.scan()
      const mismatch = third.snapshot.installations.find(item => item.id === pending.id)!
      expect(mismatch).toMatchObject({ manageable: false, statusReason: 'source_not_official' })
      expect(composition.repository.getInstallation(pending.id)).toMatchObject({
        id: pending.id,
        supported_capability: 0,
        health_state: 'discovered',
      })
      await expect(composition.service.previewConnect([pending.id]))
        .rejects.toThrow('managed integration is unavailable: source_not_official')
      // The same Installation (and Agent id) is kept through every decision.
      expect(composition.repository.listInstallations()).toHaveLength(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 0 })
    } finally {
      composition.runtime.stop()
    }
  }))
})
