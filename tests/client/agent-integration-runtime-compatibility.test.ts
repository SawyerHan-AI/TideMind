import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_INTEGRATION_RELEASE_ENTRY_MAP,
  type AgentReleaseEntry,
  type AgentReleaseMacArchitecture,
} from '../../client/electron/agent-integration/release-manifest'
import {
  applyRuntimeCompatibilityToReport,
  currentArchitecture,
  evaluateRuntimeSource,
  getSourceVerificationStore,
  isDefinitiveSourceRejection,
  isRuntimeSourceReason,
  RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
  runtimeSourceReason,
  runtimeSourceSurfaceOf,
  setSourceVerificationStore,
  SOURCE_CONFIRMATION_DISTRIBUTION_IDS,
  type RuntimeSourceSurface,
  type SourceVerificationKey,
  type SourceVerificationRecord,
  type SourceVerificationStore,
  type SourceVerifier,
} from '../../client/electron/agent-integration/runtime-compatibility'
import {
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  type DiscoveredInstallation,
  type LocalDiscoveryReport,
} from '../../client/electron/agent-integration/discovery'
import {
  assessDistributionIdentity,
  canonicalizeInstallationIdentity,
  EXACT_INSTALL_KEY_DISTRIBUTION_CONFLICT_REASON,
  matchInstallationIdentity,
} from '../../client/electron/agent-integration/identity'
import { AGENT_CATALOG } from '../../client/electron/agent-integration/catalog'
import type {
  CatalogId,
  DistributionIdentity,
  InstallationIdentityRecord,
  ProductFamilyId,
} from '../../client/electron/agent-integration/types'

// Runtime source compatibility (design §3.1–§3.2; implementation notes §2 A-WP1).
// All release facts below are read from the real signed-build manifest so the tests
// follow the frozen receipts instead of copying them.

const CHECKED_AT = '2026-09-25T08:00:00.000Z'
const UNTESTED_FINGERPRINT = 'f'.repeat(64)

function entry(catalogId: CatalogId): AgentReleaseEntry {
  const found = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(catalogId)
  if (!found) throw new Error(`fixture release entry is missing: ${catalogId}`)
  return found
}

function officialDistribution(catalogId: CatalogId, distributionId?: string) {
  const distributions = entry(catalogId).officialDistributions
  const found = distributionId
    ? distributions.find(candidate => candidate.distributionId === distributionId)
    : distributions[0]
  if (!found) throw new Error(`fixture official distribution is missing: ${catalogId} ${distributionId ?? ''}`)
  return found
}

function receipt(catalogId: CatalogId, distributionId: string, architecture: AgentReleaseMacArchitecture) {
  const found = entry(catalogId).acceptedDistributionArtifacts.find(candidate => (
    candidate.distributionId === distributionId && candidate.architecture === architecture
  ))
  if (!found) throw new Error(`fixture receipt is missing: ${catalogId} ${distributionId} ${architecture}`)
  return found
}

/** A surface that equals a frozen receipt exactly (the "tested sample"). */
function testedSurface(
  catalogId: CatalogId,
  distributionId = officialDistribution(catalogId).distributionId,
  architecture: AgentReleaseMacArchitecture = 'arm64',
): RuntimeSourceSurface {
  const sample = receipt(catalogId, distributionId, architecture)
  return {
    catalogId,
    detectedVersion: sample.version,
    distributionId: sample.distributionId,
    packageProvenance: sample.packageProvenance,
    architecture: sample.architecture,
    portableArtifactFingerprint: sample.portableArtifactFingerprint,
  }
}

/** Official channel, but a version/fingerprint that no frozen receipt covers. */
function untestedSurface(
  catalogId: CatalogId,
  distributionId = officialDistribution(catalogId).distributionId,
  overrides: Partial<RuntimeSourceSurface> = {},
): RuntimeSourceSurface {
  const official = officialDistribution(catalogId, distributionId)
  return {
    catalogId,
    detectedVersion: '999.0.0-untested',
    distributionId: official.distributionId,
    packageProvenance: official.packageProvenance,
    architecture: 'arm64',
    portableArtifactFingerprint: UNTESTED_FINGERPRINT,
    ...overrides,
  }
}

function keyOf(key: SourceVerificationKey): string {
  return JSON.stringify([
    key.distributionId,
    key.packageProvenance,
    key.version,
    key.architecture,
    key.portableArtifactFingerprint,
  ])
}

function memoryStore(initial: ReadonlyArray<readonly [SourceVerificationKey, SourceVerificationRecord]> = []) {
  const records = new Map<string, SourceVerificationRecord>(
    initial.map(([key, record]) => [keyOf(key), record] as const),
  )
  const lookup = vi.fn((key: SourceVerificationKey) => records.get(keyOf(key)) ?? null)
  const store: SourceVerificationStore & {
    put: (key: SourceVerificationKey, record: SourceVerificationRecord) => void
    lookup: typeof lookup
  } = {
    lookup,
    put: (key, record) => { records.set(keyOf(key), record) },
  }
  return store
}

function verificationKey(surface: RuntimeSourceSurface): SourceVerificationKey {
  return {
    distributionId: surface.distributionId!,
    packageProvenance: surface.packageProvenance!,
    version: surface.detectedVersion!,
    architecture: surface.architecture!,
    portableArtifactFingerprint: surface.portableArtifactFingerprint!,
  }
}

function entryMissingCatalogId(): CatalogId {
  const missing = AGENT_CATALOG.variants
    .map(variant => variant.catalogId)
    .find(catalogId => !AGENT_INTEGRATION_RELEASE_ENTRY_MAP.has(catalogId))
  if (!missing) throw new Error('every catalog variant has a release entry; fixture needs another missing id')
  return missing
}

afterEach(() => {
  setSourceVerificationStore(null)
})

describe('evaluateRuntimeSource – evidence matrix', () => {
  it('stamps every decision with the runtime compatibility contract version', () => {
    const decision = evaluateRuntimeSource(testedSurface('cursor-desktop'), undefined, null)
    expect(decision.contractVersion).toBe(RUNTIME_COMPATIBILITY_CONTRACT_VERSION)
    expect(RUNTIME_COMPATIBILITY_CONTRACT_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('rejects a catalog id without a release entry as release_entry_missing', () => {
    const catalogId = entryMissingCatalogId()
    expect(evaluateRuntimeSource({ catalogId, detectedVersion: '1.0.0' }, undefined, null)).toEqual({
      state: 'rejected',
      reason: 'release_entry_missing',
      evidence: 'none',
      checkedAt: null,
      contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
    })
  })

  it('rejects a detect-only / observe-only entry before looking at any evidence', () => {
    const store = memoryStore()
    expect(entry('zcode-cli')).toMatchObject({ releaseMode: 'detect_only', disposition: 'observe_only' })
    expect(evaluateRuntimeSource({
      catalogId: 'zcode-cli',
      detectedVersion: '1.0.0',
      distributionId: 'cli:zcode-cli',
      packageProvenance: 'npm_metadata:zcode',
      architecture: 'arm64',
      portableArtifactFingerprint: UNTESTED_FINGERPRINT,
    }, undefined, store)).toMatchObject({ state: 'rejected', reason: 'release_mode_detect_only', evidence: 'none' })

    // Even a production entry that is later downgraded to observe_only, or a
    // tested sample on a detect_only entry, never becomes trusted.
    const cursor = entry('cursor-desktop')
    expect(evaluateRuntimeSource(testedSurface('cursor-desktop'), { ...cursor, releaseMode: 'detect_only' }, store))
      .toMatchObject({ state: 'rejected', reason: 'release_mode_detect_only' })
    expect(evaluateRuntimeSource(testedSurface('cursor-desktop'), { ...cursor, disposition: 'observe_only' }, store))
      .toMatchObject({ state: 'rejected', reason: 'release_mode_detect_only' })
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it('rejects a distribution or provenance outside the official channels', () => {
    const store = memoryStore()
    const official = officialDistribution('codex-cli')
    for (const surface of [
      untestedSurface('codex-cli', undefined, { distributionId: 'cli:codex-cli:homebrew' }),
      untestedSurface('codex-cli', undefined, { packageProvenance: 'npm_metadata:@fixture-mirror/codex' }),
      untestedSurface('codex-cli', undefined, { packageProvenance: null }),
      untestedSurface('codex-cli', undefined, { distributionId: null }),
      // A signed App re-signed by a different Team is a different source.
      untestedSurface('cursor-desktop', undefined, {
        packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:FIXTURE123',
      }),
      // Provenance of one official distribution combined with the id of another.
      untestedSurface('openclaw-local', 'cli:openclaw-local:npm-global', {
        packageProvenance: official.packageProvenance,
      }),
    ]) {
      expect(evaluateRuntimeSource(surface, undefined, store)).toMatchObject({
        state: 'rejected',
        reason: 'release_distribution_not_accepted',
        evidence: 'none',
      })
    }
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it('requires a detected version: without it the Installation needs confirmation (release_version_unverified)', () => {
    const store = memoryStore()
    for (const catalogId of ['cursor-desktop', 'claude-code-native', 'codex-cli'] as const) {
      for (const detectedVersion of [undefined, null, '']) {
        expect(evaluateRuntimeSource({ ...testedSurface(catalogId), detectedVersion }, undefined, store))
          .toMatchObject({
            state: 'confirmation_required',
            reason: 'release_version_unverified',
            evidence: 'none',
          })
      }
    }
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it.each([
    ['signed App', 'cursor-desktop', undefined],
    ['signed CLI', 'claude-code-native', undefined],
    ['npm', 'codex-cli', undefined],
    ['OpenClaw portable wrapper', 'openclaw-local', 'cli:openclaw-local:portable-wrapper'],
    ['Qwen standalone', 'qwen-code-cli', 'cli:qwen-code-cli:standalone'],
    ['OpenCode v1 per-arch npm', 'opencode-v1-cli', 'cli:opencode-v1-cli:darwin-arm64'],
  ] as const)('trusts an exact frozen receipt of the %s channel as tested_sample', (_label, catalogId, distributionId) => {
    const store = memoryStore()
    for (const architecture of ['arm64', 'x64'] as const) {
      const sample = entry(catalogId).acceptedDistributionArtifacts.find(candidate => (
        candidate.distributionId === (distributionId ?? officialDistribution(catalogId).distributionId)
        && candidate.architecture === architecture
      ))
      if (!sample) continue
      expect(evaluateRuntimeSource(
        testedSurface(catalogId, sample.distributionId, architecture),
        undefined,
        store,
      )).toEqual({
        state: 'trusted',
        reason: null,
        evidence: 'tested_sample',
        checkedAt: null,
        contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
      })
    }
    // A tested sample never needs the registry cache.
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it('prefers the tested sample over a cached registry mismatch for the same generation', () => {
    const surface = testedSurface('codex-cli')
    const store = memoryStore([[verificationKey(surface), { status: 'mismatch', checkedAt: CHECKED_AT }]])
    expect(evaluateRuntimeSource(surface, undefined, store)).toMatchObject({
      state: 'trusted',
      reason: null,
      evidence: 'tested_sample',
    })
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it('prefers the tested sample over signed identity for a signed channel', () => {
    expect(evaluateRuntimeSource(testedSurface('cursor-desktop'), undefined, null).evidence).toBe('tested_sample')
    expect(evaluateRuntimeSource(testedSurface('claude-code-native'), undefined, null).evidence).toBe('tested_sample')
  })

  it('does not treat a receipt that differs in any bound field as a tested sample', () => {
    const tested = testedSurface('openclaw-local', 'cli:openclaw-local:portable-wrapper', 'arm64')
    const x64 = receipt('openclaw-local', 'cli:openclaw-local:portable-wrapper', 'x64')
    expect(x64.portableArtifactFingerprint).not.toBe(tested.portableArtifactFingerprint)
    for (const surface of [
      { ...tested, detectedVersion: '2026.9.2' },
      { ...tested, portableArtifactFingerprint: UNTESTED_FINGERPRINT },
      // arm64 bytes reported on an x64 host are not the x64 tested sample.
      { ...tested, architecture: 'x64' as const },
      { ...tested, architecture: null },
      { ...tested, portableArtifactFingerprint: null },
    ]) {
      expect(evaluateRuntimeSource(surface, undefined, null)).toMatchObject({
        state: 'confirmation_required',
        reason: 'source_confirmation_required',
      })
    }
  })

  it.each([
    ['signed App (Cursor)', 'cursor-desktop'],
    ['signed App (Codex Desktop)', 'codex-desktop'],
    ['signed App (Windsurf)', 'windsurf-desktop'],
    ['signed App (QwenWork)', 'qwenwork-desktop'],
    ['signed App (ZCode)', 'zcode-desktop'],
    ['signed CLI (Claude Code native)', 'claude-code-native'],
    ['signed CLI (Kimi native)', 'kimi-code-native'],
  ] as const)('trusts any untested version of the official %s channel by signed identity', (_label, catalogId) => {
    const store = memoryStore()
    for (const surface of [
      untestedSurface(catalogId),
      untestedSurface(catalogId, undefined, { detectedVersion: '0.0.1' }),
      // Signed identity does not depend on the portable fingerprint or architecture.
      untestedSurface(catalogId, undefined, { portableArtifactFingerprint: null, architecture: null }),
      untestedSurface(catalogId, undefined, { architecture: 'x64' }),
    ]) {
      expect(evaluateRuntimeSource(surface, undefined, store)).toEqual({
        state: 'trusted',
        reason: null,
        evidence: 'signed_identity',
        checkedAt: null,
        contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
      })
    }
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it.each([
    ['OpenClaw portable wrapper', 'openclaw-local', 'cli:openclaw-local:portable-wrapper'],
    ['Qwen standalone', 'qwen-code-cli', 'cli:qwen-code-cli:standalone'],
  ] as const)('requires source confirmation for an untested %s (never laundered via the registry cache)', (_label, catalogId, distributionId) => {
    expect(SOURCE_CONFIRMATION_DISTRIBUTION_IDS.has(distributionId)).toBe(true)
    const surface = untestedSurface(catalogId, distributionId)
    // Even a "verified" record in the store must not upgrade an installer-produced channel.
    const store = memoryStore([[verificationKey(surface), { status: 'verified', checkedAt: CHECKED_AT }]])
    expect(evaluateRuntimeSource(surface, undefined, store)).toEqual({
      state: 'confirmation_required',
      reason: 'source_confirmation_required',
      evidence: 'none',
      checkedAt: null,
      contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
    })
    // Missing architecture/fingerprint on these channels still needs confirmation, not "pending".
    expect(evaluateRuntimeSource(
      { ...surface, architecture: null, portableArtifactFingerprint: null },
      undefined,
      store,
    )).toMatchObject({ state: 'confirmation_required', reason: 'source_confirmation_required' })
    expect(store.lookup).not.toHaveBeenCalled()
  })

  it.each([
    ['Claude Code npm', 'claude-code-cli', undefined],
    ['Codex CLI', 'codex-cli', undefined],
    ['Gemini CLI', 'gemini-cli', undefined],
    ['Kimi CLI npm', 'kimi-code-cli', undefined],
    ['OpenClaw npm-global', 'openclaw-local', 'cli:openclaw-local:npm-global'],
    ['Qwen npm-global', 'qwen-code-cli', 'cli:qwen-code-cli:npm-global'],
    ['OpenCode v1', 'opencode-v1-cli', 'cli:opencode-v1-cli:darwin-arm64'],
    ['OpenCode v2 beta', 'opencode-v2-beta-cli', 'cli:opencode-v2-beta-cli:darwin-arm64'],
    ['Pi official', 'pi-official-cli', undefined],
    ['OMP', 'omp-cli', undefined],
  ] as const)('keeps an untested %s generation pending until the official registry verification is cached', (_label, catalogId, distributionId) => {
    const surface = untestedSurface(catalogId, distributionId)
    const store = memoryStore()
    expect(evaluateRuntimeSource(surface, undefined, store)).toEqual({
      state: 'pending',
      reason: 'source_verification_pending',
      evidence: 'none',
      checkedAt: null,
      contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
    })
    expect(store.lookup).toHaveBeenCalledTimes(1)
    expect(store.lookup).toHaveBeenCalledWith(verificationKey(surface))

    store.put(verificationKey(surface), { status: 'verified', checkedAt: CHECKED_AT })
    expect(evaluateRuntimeSource(surface, undefined, store)).toEqual({
      state: 'trusted',
      reason: null,
      evidence: 'npm_registry',
      checkedAt: CHECKED_AT,
      contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
    })

    store.put(verificationKey(surface), { status: 'mismatch', checkedAt: '2026-09-25T09:00:00.000Z' })
    expect(evaluateRuntimeSource(surface, undefined, store)).toEqual({
      state: 'rejected',
      reason: 'source_not_official',
      evidence: 'npm_registry',
      checkedAt: '2026-09-25T09:00:00.000Z',
      contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION,
    })
  })

  it('stays pending without any store at all', () => {
    expect(evaluateRuntimeSource(untestedSurface('codex-cli'), undefined, null)).toMatchObject({
      state: 'pending',
      reason: 'source_verification_pending',
    })
  })

  it('binds a registry verification to the exact version, architecture and local fingerprint', () => {
    const surface = untestedSurface('gemini-cli')
    const store = memoryStore([[verificationKey(surface), { status: 'verified', checkedAt: CHECKED_AT }]])
    expect(evaluateRuntimeSource(surface, undefined, store).state).toBe('trusted')
    for (const other of [
      { ...surface, detectedVersion: '999.0.1-untested' },
      { ...surface, architecture: 'x64' as const },
      { ...surface, portableArtifactFingerprint: 'e'.repeat(64) },
    ]) {
      expect(evaluateRuntimeSource(other, undefined, store)).toMatchObject({
        state: 'pending',
        reason: 'source_verification_pending',
      })
    }
  })

  it('uses the official distribution identity (not the surface spelling) as the store key', () => {
    const surface = untestedSurface('opencode-v1-cli', 'cli:opencode-v1-cli:darwin-x64', { architecture: 'x64' })
    const store = memoryStore()
    evaluateRuntimeSource(surface, undefined, store)
    expect(store.lookup).toHaveBeenCalledWith({
      distributionId: 'cli:opencode-v1-cli:darwin-x64',
      packageProvenance: 'npm_metadata:opencode-ai',
      version: '999.0.0-untested',
      architecture: 'x64',
      portableArtifactFingerprint: UNTESTED_FINGERPRINT,
    })
  })

  it.each([
    ['architecture', { architecture: null }],
    ['portable fingerprint', { portableArtifactFingerprint: null }],
    ['portable fingerprint (empty)', { portableArtifactFingerprint: '' }],
  ] as const)('stays pending without consulting the store when the npm surface lacks its %s', (_label, overrides) => {
    const complete = untestedSurface('codex-cli')
    const store = memoryStore([[verificationKey(complete), { status: 'verified', checkedAt: CHECKED_AT }]])
    expect(evaluateRuntimeSource({ ...complete, ...overrides }, undefined, store)).toMatchObject({
      state: 'pending',
      reason: 'source_verification_pending',
      evidence: 'none',
    })
    expect(store.lookup).not.toHaveBeenCalled()
  })
})

describe('runtime source helpers', () => {
  it('reads the process-wide store only when no store argument is given', () => {
    const surface = untestedSurface('codex-cli')
    const verified = memoryStore([[verificationKey(surface), { status: 'verified', checkedAt: CHECKED_AT }]])
    expect(getSourceVerificationStore()).toBeNull()
    expect(runtimeSourceReason(surface)).toBe('source_verification_pending')

    setSourceVerificationStore(verified)
    expect(getSourceVerificationStore()).toBe(verified)
    expect(runtimeSourceReason(surface)).toBeNull()
    expect(evaluateRuntimeSource(surface).state).toBe('trusted')
    // An explicit null overrides the active store.
    expect(runtimeSourceReason(surface, undefined, null)).toBe('source_verification_pending')
    // An explicit store overrides the active store.
    expect(runtimeSourceReason(surface, undefined, memoryStore([[verificationKey(surface), {
      status: 'mismatch', checkedAt: CHECKED_AT,
    }]]))).toBe('source_not_official')

    setSourceVerificationStore(null)
    expect(runtimeSourceReason(surface)).toBe('source_verification_pending')
  })

  it('evaluates against an explicitly supplied release entry', () => {
    const cursor = entry('cursor-desktop')
    const surface = untestedSurface('cursor-desktop')
    expect(runtimeSourceReason(surface, cursor)).toBeNull()
    expect(runtimeSourceReason(surface, { ...cursor, officialDistributions: [] }))
      .toBe('release_distribution_not_accepted')
  })

  it('classifies only definitive rejections as incompatible', () => {
    for (const reason of [
      'release_entry_missing',
      'release_mode_detect_only',
      'release_distribution_not_accepted',
      'source_not_official',
    ]) {
      expect(isDefinitiveSourceRejection(reason)).toBe(true)
      expect(isRuntimeSourceReason(reason)).toBe(true)
    }
    for (const reason of [
      'source_verification_pending',
      'source_confirmation_required',
      'release_version_unverified',
    ]) {
      expect(isDefinitiveSourceRejection(reason)).toBe(false)
      expect(isRuntimeSourceReason(reason)).toBe(true)
    }
    // Legacy exact-version reasons are not runtime source reasons any more.
    for (const reason of ['release_version_not_accepted', 'release_artifact_not_accepted', 'conflict', null, undefined]) {
      expect(isDefinitiveSourceRejection(reason)).toBe(false)
      expect(isRuntimeSourceReason(reason)).toBe(false)
    }
  })

  it('derives the runtime surface from a discovered Installation on the current architecture', () => {
    const installation = discovered('codex-cli', { version: '1.2.3', fingerprint: UNTESTED_FINGERPRINT })
    expect(runtimeSourceSurfaceOf(installation)).toEqual({
      catalogId: 'codex-cli',
      detectedVersion: '1.2.3',
      distributionId: 'cli:codex-cli',
      packageProvenance: 'npm_metadata:@openai/codex',
      architecture: currentArchitecture(),
      portableArtifactFingerprint: UNTESTED_FINGERPRINT,
    })
    expect(currentArchitecture()).toBe(process.arch === 'x64' ? 'x64' : 'arm64')
  })
})

// ---------------------------------------------------------------------------
// applyRuntimeCompatibilityToReport
// ---------------------------------------------------------------------------

const FAMILY_BY_CATALOG: Partial<Record<CatalogId, ProductFamilyId>> = {}
for (const variant of AGENT_CATALOG.variants) FAMILY_BY_CATALOG[variant.catalogId] = variant.productFamilyId

function discovered(
  catalogId: CatalogId,
  options: {
    distributionId?: string
    packageProvenance?: string
    version?: string
    fingerprint?: string
    configRoot?: string
    eligibility?: DiscoveredInstallation['managementEligibility']
  } = {},
): DiscoveredInstallation {
  const official = officialDistribution(catalogId, options.distributionId)
  const configRoot = options.configRoot ?? `/Users/fixture/.${catalogId}`
  const executableRealpath = `/Users/fixture/.local/${catalogId}/bin/agent`
  return {
    catalogId,
    displayName: `Fixture ${catalogId}`,
    identity: canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_0001',
      productFamilyId: FAMILY_BY_CATALOG[catalogId]!,
      hostVariant: catalogId,
      configRoot,
      distribution: {
        distributionId: official.distributionId,
        executableRealpath,
        packageProvenance: options.packageProvenance ?? official.packageProvenance,
        capabilityFingerprint: `cli-surface:${catalogId}`,
        ...(options.fingerprint === undefined ? {} : { portableArtifactFingerprint: options.fingerprint }),
      },
    }),
    configRoot,
    executablePath: executableRealpath,
    ...(options.version === undefined ? {} : { detectedVersion: options.version }),
    versionDetectionMethod: 'cli_version',
    managementEligibility: options.eligibility ?? {
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: true,
      executableSizeBytes: 4_096,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    },
    provenance: ['fixture'],
    evidence: [],
  }
}

function report(installations: DiscoveredInstallation[]): LocalDiscoveryReport {
  return {
    installations,
    unresolved: [{ catalogIds: ['cursor-desktop'], reason: 'probe_inaccessible', summary: 'fixture probe', evidence: [] }],
    diagnostics: ['fixture diagnostic'],
  }
}

function surfaceKeyOf(installation: DiscoveredInstallation): SourceVerificationKey {
  return verificationKey(runtimeSourceSurfaceOf(installation))
}

describe('applyRuntimeCompatibilityToReport', () => {
  it('calls the verifier for a pending npm generation with the exact key, then trusts what it cached', async () => {
    const store = memoryStore()
    const codex = discovered('codex-cli', { version: '0.200.0', fingerprint: UNTESTED_FINGERPRINT })
    const verifier = vi.fn<SourceVerifier>(async key => {
      store.put(key, { status: 'verified', checkedAt: CHECKED_AT })
    })

    const gated = await applyRuntimeCompatibilityToReport(report([codex]), { verifier, store })

    expect(verifier).toHaveBeenCalledTimes(1)
    expect(verifier).toHaveBeenCalledWith({
      catalogId: 'codex-cli',
      distributionId: 'cli:codex-cli',
      packageProvenance: 'npm_metadata:@openai/codex',
      version: '0.200.0',
      architecture: currentArchitecture(),
      portableArtifactFingerprint: UNTESTED_FINGERPRINT,
    })
    // Trusted: the Installation is passed through unchanged (its executable-proof eligibility stays).
    expect(gated.installations).toEqual([codex])
    expect(gated.unresolved).toEqual(report([]).unresolved)
    expect(gated.diagnostics).toEqual(['fixture diagnostic'])
  })

  it('records a registry mismatch as source_not_official without hiding the Installation', async () => {
    const store = memoryStore()
    const gemini = discovered('gemini-cli', { version: '0.99.0', fingerprint: UNTESTED_FINGERPRINT })
    const verifier = vi.fn<SourceVerifier>(async key => {
      store.put(key, { status: 'mismatch', checkedAt: CHECKED_AT })
    })

    const gated = await applyRuntimeCompatibilityToReport(report([gemini]), { verifier, store })

    expect(gated.installations).toHaveLength(1)
    expect(gated.installations[0]).toEqual({
      ...gemini,
      managementEligibility: {
        schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
        eligible: false,
        reason: 'source_not_official',
        executableSizeBytes: 4_096,
        proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
      },
    })
  })

  it('never grants trust when the verifier throws, and still verifies the remaining Installations', async () => {
    const store = memoryStore()
    const failing = discovered('codex-cli', { version: '0.200.0', fingerprint: UNTESTED_FINGERPRINT })
    const succeeding = discovered('gemini-cli', { version: '0.99.0', fingerprint: 'd'.repeat(64) })
    const verifier = vi.fn<SourceVerifier>(async key => {
      if (key.catalogId === 'codex-cli') {
        // A partial write that the verifier did not finish must not be enough on its own.
        throw new Error('fixture registry offline')
      }
      store.put(key, { status: 'verified', checkedAt: CHECKED_AT })
    })

    const gated = await applyRuntimeCompatibilityToReport(report([failing, succeeding]), { verifier, store })

    expect(verifier).toHaveBeenCalledTimes(2)
    expect(gated.installations.map(installation => installation.managementEligibility)).toEqual([
      {
        schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
        eligible: false,
        reason: 'source_verification_pending',
        executableSizeBytes: 4_096,
        proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
      },
      succeeding.managementEligibility,
    ])
  })

  it('does not call the verifier for tested, signed, confirmation-required, rejected or incomplete surfaces', async () => {
    const store = memoryStore()
    const verifier = vi.fn<SourceVerifier>(async () => {})
    const arch = currentArchitecture()
    const codexSample = receipt('codex-cli', 'cli:codex-cli', arch)
    const tested = discovered('codex-cli', {
      version: codexSample.version,
      fingerprint: codexSample.portableArtifactFingerprint,
    })
    const signed = discovered('claude-code-native', { version: '9.9.9', fingerprint: UNTESTED_FINGERPRINT })
    const portable = discovered('openclaw-local', {
      distributionId: 'cli:openclaw-local:portable-wrapper',
      version: '2026.12.1',
      fingerprint: UNTESTED_FINGERPRINT,
    })
    const unofficial = discovered('codex-cli', {
      packageProvenance: 'npm_metadata:@fixture-mirror/codex',
      version: '0.200.0',
      fingerprint: UNTESTED_FINGERPRINT,
      configRoot: '/Users/fixture/.codex-mirror',
    })
    const noVersion = discovered('gemini-cli', { fingerprint: UNTESTED_FINGERPRINT })
    // Pending, but the key is incomplete: nothing can be verified.
    const noFingerprint = discovered('kimi-code-cli', { version: '0.50.0' })

    const gated = await applyRuntimeCompatibilityToReport(
      report([tested, signed, portable, unofficial, noVersion, noFingerprint]),
      { verifier, store },
    )

    expect(verifier).not.toHaveBeenCalled()
    expect(gated.installations).toHaveLength(6)
    expect(gated.installations.map(installation => installation.managementEligibility?.reason ?? null)).toEqual([
      null,
      null,
      'source_confirmation_required',
      'release_distribution_not_accepted',
      'release_version_unverified',
      'source_verification_pending',
    ])
    // Trusted Installations keep their original (eligible) record verbatim.
    expect(gated.installations[0]).toBe(tested)
    expect(gated.installations[1]).toBe(signed)
  })

  it('does not call the verifier again once the store already holds a verdict', async () => {
    const codex = discovered('codex-cli', { version: '0.200.0', fingerprint: UNTESTED_FINGERPRINT })
    const store = memoryStore([[surfaceKeyOf(codex), { status: 'verified', checkedAt: CHECKED_AT }]])
    const verifier = vi.fn<SourceVerifier>(async () => {})
    const gated = await applyRuntimeCompatibilityToReport(report([codex]), { verifier, store })
    expect(verifier).not.toHaveBeenCalled()
    expect(gated.installations[0]).toBe(codex)
  })

  it('without a verifier only records the current decision', async () => {
    const codex = discovered('codex-cli', { version: '0.200.0', fingerprint: UNTESTED_FINGERPRINT })
    const gated = await applyRuntimeCompatibilityToReport(report([codex]), { store: memoryStore() })
    expect(gated.installations[0].managementEligibility).toMatchObject({
      eligible: false,
      reason: 'source_verification_pending',
    })
    // Visibility is preserved: identity, paths and version are untouched.
    expect({ ...gated.installations[0], managementEligibility: undefined })
      .toEqual({ ...codex, managementEligibility: undefined })
  })

  it('uses the process-wide store when no store option is passed', async () => {
    const codex = discovered('codex-cli', { version: '0.200.0', fingerprint: UNTESTED_FINGERPRINT })
    setSourceVerificationStore(memoryStore([[surfaceKeyOf(codex), { status: 'verified', checkedAt: CHECKED_AT }]]))
    expect((await applyRuntimeCompatibilityToReport(report([codex]))).installations[0]).toBe(codex)
    expect((await applyRuntimeCompatibilityToReport(report([codex]), { store: null })).installations[0]
      .managementEligibility?.reason).toBe('source_verification_pending')
  })

  it('keeps the executable-proof facts when replacing a missing or ineligible eligibility record', async () => {
    const withoutEligibility = { ...discovered('codex-cli', { version: '0.200.0', fingerprint: UNTESTED_FINGERPRINT }) }
    delete (withoutEligibility as { managementEligibility?: unknown }).managementEligibility
    const tooLarge = discovered('gemini-cli', {
      version: '0.99.0',
      fingerprint: UNTESTED_FINGERPRINT,
      eligibility: {
        schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
        eligible: false,
        reason: 'executable_proof_too_large',
        executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES + 1,
        proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
      },
    })
    const gated = await applyRuntimeCompatibilityToReport(report([withoutEligibility, tooLarge]), { store: null })
    expect(gated.installations[0].managementEligibility).toEqual({
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: false,
      reason: 'source_verification_pending',
      executableSizeBytes: undefined,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    })
    expect(gated.installations[1].managementEligibility).toEqual({
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: false,
      reason: 'source_verification_pending',
      executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES + 1,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    })
  })
})

// ---------------------------------------------------------------------------
// Installation identity: generation facts vs source identity
// ---------------------------------------------------------------------------

describe('Installation identity across host generations', () => {
  const CURSOR_ID = 'com.todesktop.230313mzl4w4u92'
  const CURSOR_PROVENANCE = 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9'

  function cursorIdentity(distribution: DistributionIdentity) {
    return canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_0001',
      productFamilyId: 'cursor',
      hostVariant: 'cursor-desktop',
      configRoot: '/Users/fixture/.cursor',
      distribution,
    })
  }

  function record(distribution: DistributionIdentity): InstallationIdentityRecord {
    return { ...cursorIdentity(distribution), installationId: 'installation-cursor', aliasInstallKeys: [] }
  }

  const previousGeneration: DistributionIdentity = {
    distributionId: CURSOR_ID,
    executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
    packageProvenance: CURSOR_PROVENANCE,
    capabilityFingerprint: 'desktop-bundle-surface-v1:generation-1',
    portableArtifactFingerprint: 'a'.repeat(64),
  }

  it('matches the same install key when only the executable path and code fingerprint changed', () => {
    const upgraded = cursorIdentity({
      ...previousGeneration,
      executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor-3.20',
      capabilityFingerprint: 'desktop-bundle-surface-v1:generation-2',
      portableArtifactFingerprint: 'b'.repeat(64),
    })
    expect(assessDistributionIdentity(upgraded.distribution, previousGeneration)).toMatchObject({
      status: 'not_required',
      conflictingFields: [],
    })
    expect(matchInstallationIdentity(upgraded, [record(previousGeneration)])).toMatchObject({
      kind: 'matched',
      reason: 'install_key',
      record: { installationId: 'installation-cursor' },
    })
  })

  it('matches a versioned npm executable path change of the same official package', () => {
    const codex = (executableRealpath: string, capabilityFingerprint: string) => canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_0001',
      productFamilyId: FAMILY_BY_CATALOG['codex-cli']!,
      hostVariant: 'codex-cli',
      configRoot: '/Users/fixture/.codex',
      distribution: {
        distributionId: 'cli:codex-cli',
        executableRealpath,
        packageProvenance: 'npm_metadata:@openai/codex',
        capabilityFingerprint,
      },
    })
    const before = codex('/Users/fixture/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js', 'cli-surface:1')
    const after = codex('/Users/fixture/.nvm/versions/node/v24.0.0/lib/node_modules/@openai/codex/bin/codex.js', 'cli-surface:2')
    expect(matchInstallationIdentity(after, [{ ...before, installationId: 'codex-1', aliasInstallKeys: [] }]))
      .toMatchObject({ kind: 'matched', reason: 'install_key' })
  })

  it('reports a distribution conflict when the package provenance changes at the same install key', () => {
    const replaced = cursorIdentity({
      ...previousGeneration,
      packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:FIXTURE123',
    })
    expect(assessDistributionIdentity(replaced.distribution, previousGeneration)).toMatchObject({
      status: 'conflict',
      conflictingFields: ['packageProvenance'],
    })
    expect(matchInstallationIdentity(replaced, [record(previousGeneration)])).toEqual({
      kind: 'distribution_conflict',
      candidates: [record(previousGeneration)],
      reason: EXACT_INSTALL_KEY_DISTRIBUTION_CONFLICT_REASON,
    })
  })

  it('reports a distribution conflict when the distribution id changes at the same install key', () => {
    const replaced = cursorIdentity({ ...previousGeneration, distributionId: 'com.fixture.cursor-fork' })
    expect(matchInstallationIdentity(replaced, [record(previousGeneration)])).toMatchObject({
      kind: 'distribution_conflict',
      reason: EXACT_INSTALL_KEY_DISTRIBUTION_CONFLICT_REASON,
    })
  })

  it('stays strict on executable and code fingerprint when the record has no source identity', () => {
    const legacy: DistributionIdentity = {
      executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
      capabilityFingerprint: 'desktop-bundle-surface-v1:generation-1',
    }
    const movedExecutable = cursorIdentity({
      ...previousGeneration,
      executableRealpath: '/Applications/Other.app/Contents/MacOS/Cursor',
    })
    expect(assessDistributionIdentity(movedExecutable.distribution, legacy)).toMatchObject({
      status: 'conflict',
      conflictingFields: ['executableRealpath'],
    })
    expect(matchInstallationIdentity(movedExecutable, [record(legacy)])).toMatchObject({
      kind: 'distribution_conflict',
    })

    const changedCode = cursorIdentity({
      ...previousGeneration,
      capabilityFingerprint: 'desktop-bundle-surface-v1:generation-2',
    })
    expect(matchInstallationIdentity(changedCode, [record(legacy)])).toMatchObject({
      kind: 'distribution_conflict',
    })
  })

  it('stays strict when the observation has no source identity', () => {
    const observedWithoutSource = cursorIdentity({
      executableRealpath: '/Applications/Other.app/Contents/MacOS/Cursor',
      capabilityFingerprint: 'desktop-bundle-surface-v1:generation-1',
    })
    expect(matchInstallationIdentity(observedWithoutSource, [record(previousGeneration)])).toMatchObject({
      kind: 'distribution_conflict',
    })
  })

  it('keeps the Pi official npm scope rename equivalent under the source-identity rule', () => {
    const pi = (scope: string, capabilityFingerprint: string) => canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_0001',
      productFamilyId: 'pi-official',
      hostVariant: 'pi-official-cli',
      configRoot: '/Users/fixture/.pi/agent',
      distribution: {
        distributionId: `pi-official:${scope}/pi-coding-agent`,
        executableRealpath: `/opt/homebrew/lib/node_modules/${scope}/pi-coding-agent/dist/cli.js`,
        packageProvenance: `npm_metadata:${scope}/pi-coding-agent`,
        capabilityFingerprint,
      },
    })
    const oldScope = pi('@mariozechner', 'pi-extension-api:1')
    // The earlier special case required an identical capability fingerprint; a scope
    // rename that also upgrades the package is now a normal generation change.
    const newScope = pi('@earendil-works', 'pi-extension-api:2')
    expect(matchInstallationIdentity(newScope, [{ ...oldScope, installationId: 'pi-1', aliasInstallKeys: [] }]))
      .toMatchObject({ kind: 'matched', reason: 'install_key' })
    // An unrelated npm package at the same install key is still a different source.
    const foreign = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_fixture_0001',
      productFamilyId: 'pi-official',
      hostVariant: 'pi-official-cli',
      configRoot: '/Users/fixture/.pi/agent',
      distribution: {
        distributionId: 'pi-official:@fixture-mirror/pi-coding-agent',
        executableRealpath: '/opt/homebrew/lib/node_modules/@fixture-mirror/pi-coding-agent/dist/cli.js',
        packageProvenance: 'npm_metadata:@fixture-mirror/pi-coding-agent',
        capabilityFingerprint: 'pi-extension-api:2',
      },
    })
    expect(matchInstallationIdentity(foreign, [{ ...oldScope, installationId: 'pi-1', aliasInstallKeys: [] }]))
      .toMatchObject({ kind: 'distribution_conflict' })
  })
})

// ---------------------------------------------------------------------------
// Presentation: every runtime source reason has a translated explanation
// ---------------------------------------------------------------------------

describe('runtime source reasons in the UI', () => {
  const LOCALES = ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN', 'zh-TW'] as const
  const REASONS = [
    'release_entry_missing',
    'release_mode_detect_only',
    'release_distribution_not_accepted',
    'release_version_unverified',
    'release_version_not_accepted',
    'release_artifact_not_accepted',
    'source_verification_pending',
    'source_not_official',
    'source_confirmation_required',
  ] as const

  function lookup(tree: unknown, dotted: string): unknown {
    return dotted.split('.').reduce<unknown>((node, segment) => (
      node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined
    ), tree)
  }

  it('maps each reason to its own help text in all 12 locales', async () => {
    const { managementUnavailableHelpKey, statusReasonKey } = await import(
      '../../client/src/components/settings/agent-integration-managed/presentation'
    )
    const fs = await import('node:fs')
    const path = await import('node:path')
    const keys = REASONS.map(reason => {
      const key = managementUnavailableHelpKey(reason)
      expect(key).toBe(statusReasonKey(reason))
      expect(key).not.toBe('agent.managed.supportMode.detectableHelp')
      return key
    })
    expect(new Set(keys).size).toBe(REASONS.length)
    expect(keys.slice(-3)).toEqual([
      'agent.managed.reason.sourceVerificationPending',
      'agent.managed.reason.sourceNotOfficial',
      'agent.managed.reason.sourceConfirmationRequired',
    ])
    for (const locale of LOCALES) {
      const settings = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../../client/src/locales', locale, 'settings.json'),
        'utf8',
      )) as unknown
      for (const key of keys) {
        const text = lookup(settings, key)
        expect(typeof text, `${locale}:${key}`).toBe('string')
        expect((text as string).trim().length, `${locale}:${key}`).toBeGreaterThan(10)
      }
      for (const suffix of ['title', 'description', 'states.trusted', 'states.pending',
        'states.confirmation_required', 'states.rejected', 'states.user_managed',
        'evidence.tested_sample', 'evidence.signed_identity', 'evidence.npm_registry', 'evidence.npm_registry_cache']) {
        expect(lookup(settings, `agent.managed.sourceVerification.${suffix}`), `${locale}:${suffix}`)
          .toEqual(expect.any(String))
      }
      const reason = lookup(settings, 'agent.managed.reason') as Record<string, string>
      // Distinct explanations: no copy-paste between the new source reasons.
      expect(new Set([
        reason.sourceVerificationPending,
        reason.sourceNotOfficial,
        reason.sourceConfirmationRequired,
        reason.releaseArtifactNotAccepted,
        reason.releaseDistributionNotAccepted,
      ]).size, locale).toBe(5)
    }
  })
})
