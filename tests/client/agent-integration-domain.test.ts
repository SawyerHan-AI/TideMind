import { describe, expect, it } from 'vitest'
import {
  AGENT_CATALOG,
  CATALOG_ALIASES,
  DELIVERY_PRIORITY_BY_CATALOG_ID,
  getCatalogVariant,
  validateAgentCatalog,
} from '../../client/electron/agent-integration/catalog'
import {
  assessDistributionIdentity,
  canonicalizeInstallationIdentity,
  matchInstallationIdentity,
  resolveCatalogIdentity,
} from '../../client/electron/agent-integration/identity'
import {
  CATALOG_IDS,
  COMPONENT_KEYS,
  deriveAccessLevel,
  deriveDeliverySummary,
  deriveInstallationStatus,
  deriveVerificationSummary,
  type InstallationComponentFact,
  type InstallationIdentityRecord,
  type InstallationStatusInput,
} from '../../client/electron/agent-integration/types'

const P0_1 = [
  'claude-code-cli',
  'claude-code-native',
  'claude-desktop-legacy',
  'codex-cli',
  'codex-desktop',
  'cursor-desktop',
  'windsurf-desktop',
  'gemini-cli',
  'kimi-code-cli',
  'kimi-code-native',
  'openclaw-local',
] as const

const P0_2 = [
  'qwen-code-cli',
  'zcode-desktop',
  'zcode-cli',
  'opencode-v1-cli',
  'opencode-v2-beta-cli',
  'pi-official-cli',
  'omp-cli',
  'qwenwork-desktop',
  'claude-cowork-local',
] as const

describe('local Agent Catalog', () => {
  it('contains every frozen canonical ID exactly once and passes consistency checks', () => {
    expect(validateAgentCatalog()).toEqual([])
    expect(AGENT_CATALOG.variants.map(variant => variant.catalogId)).toHaveLength(CATALOG_IDS.length)
    expect(new Set(AGENT_CATALOG.variants.map(variant => variant.catalogId))).toEqual(new Set(CATALOG_IDS))
    expect(Object.keys(DELIVERY_PRIORITY_BY_CATALOG_ID)).toHaveLength(CATALOG_IDS.length)
  })

  it('keeps the reviewed P0.1 and P0.2 priority groups exact', () => {
    expect(CATALOG_IDS.filter(id => DELIVERY_PRIORITY_BY_CATALOG_ID[id] === 'P0.1').sort()).toEqual([...P0_1].sort())
    expect(CATALOG_IDS.filter(id => DELIVERY_PRIORITY_BY_CATALOG_ID[id] === 'P0.2').sort()).toEqual([...P0_2].sort())
  })

  it('declares all three logical components for every P0 host variant', () => {
    for (const variant of AGENT_CATALOG.variants.filter(candidate =>
      candidate.deliveryPriority === 'P0.1' || candidate.deliveryPriority === 'P0.2',
    )) {
      expect(variant.components.map(component => component.componentKey).sort()).toEqual([...COMPONENT_KEYS].sort())
    }
  })

  it('models native Claude and Kimi distributions as CLI hosts even though their IDs do not end in -cli', () => {
    expect(getCatalogVariant('claude-code-native').hostKind).toBe('cli')
    expect(getCatalogVariant('kimi-code-native').hostKind).toBe('cli')
  })

  it('caps Windsurf at basic integration until a lifecycle contract is verified', () => {
    const windsurf = getCatalogVariant('windsurf-desktop')
    expect(windsurf.maxCapability).toBe(3)
    expect(windsurf.components.find(component => component.componentKey === 'lifecycle')).toMatchObject({
      applicability: 'not_applicable',
      deliveryMode: 'cataloged',
      artifactTypes: [],
      mutationDomain: 'none',
      reload: 'none',
    })
  })

  it('keeps unproven Claude and Kimi native channels explicitly detect-only', () => {
    for (const catalogId of ['claude-code-native', 'kimi-code-native'] as const) {
      expect(getCatalogVariant(catalogId).components).toEqual(expect.arrayContaining([
        expect.objectContaining({ deliveryMode: 'detectable' }),
      ]))
      expect(getCatalogVariant(catalogId).components.every(component =>
        component.deliveryMode === 'detectable')).toBe(true)
    }
  })

  it('does not merge sibling surfaces or similarly named Pi distributions', () => {
    expect(getCatalogVariant('codex-cli').productFamilyId).toBe('codex')
    expect(getCatalogVariant('codex-desktop').productFamilyId).toBe('codex')
    expect(getCatalogVariant('opencode-v1-cli').catalogId).not.toBe(getCatalogVariant('opencode-v2-beta-cli').catalogId)
    expect(getCatalogVariant('pi-official-cli').productFamilyId).not.toBe(getCatalogVariant('omp-cli').productFamilyId)
    expect(getCatalogVariant('pi-official-cli').productFamilyId).not.toBe(getCatalogVariant('pi-agent-rust-cli').productFamilyId)
    expect(getCatalogVariant('zcode-desktop').productFamilyId).toBe('zcode')
    expect(getCatalogVariant('zcode-cli').components.every(component => component.deliveryMode === 'detectable')).toBe(true)
  })

  it('maps legacy cowork only to the legacy Claude Desktop audit identity', () => {
    expect(resolveCatalogIdentity('cowork')).toMatchObject({
      kind: 'legacy_audit',
      catalogIds: ['claude-desktop-legacy'],
    })
    expect(resolveCatalogIdentity('cowork').catalogIds).not.toContain('claude-cowork-local')
    expect(resolveCatalogIdentity('codex')).toMatchObject({
      kind: 'requires_discovery',
      catalogIds: ['codex-cli', 'codex-desktop'],
    })
  })

  it('detects alias cycles in a modified catalog', () => {
    const issues = validateAgentCatalog({
      ...AGENT_CATALOG,
      aliases: [
        ...CATALOG_ALIASES,
        { alias: 'cycle-a', targetIds: ['cycle-b'], resolution: 'direct', reason: 'fixture' },
        { alias: 'cycle-b', targetIds: ['cycle-a'], resolution: 'direct', reason: 'fixture' },
      ],
    })
    expect(issues.some(issue => issue.code === 'alias_cycle')).toBe(true)
  })

  it('detects delivery-priority drift from the reviewed mapping', () => {
    const cursor = getCatalogVariant('cursor-desktop')
    const issues = validateAgentCatalog({
      ...AGENT_CATALOG,
      variants: AGENT_CATALOG.variants.map(variant =>
        variant.catalogId === cursor.catalogId ? { ...variant, deliveryPriority: 'P3' } : variant,
      ),
    })
    expect(issues.some(issue => issue.code === 'priority_mismatch')).toBe(true)
  })
})

describe('stable Installation identity', () => {
  function cursorIdentity(configRoot = '/Users/test/.cursor') {
    return canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JABCDEF0123456789',
      productFamilyId: 'cursor',
      hostVariant: 'cursor-desktop',
      configRoot,
      explicitProfile: 'default',
      hostOwnedIdentity: 'cursor-profile-default',
      distribution: {
        distributionId: 'com.todesktop.230313mzl4w4u92',
        executableRealpath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
        packageProvenance: 'app_bundle',
        capabilityFingerprint: 'cursor-desktop',
      },
    })
  }

  function recordFromIdentity(
    identity: ReturnType<typeof cursorIdentity>,
    overrides: Partial<InstallationIdentityRecord> = {},
  ): InstallationIdentityRecord {
    return {
      ...identity,
      installationId: 'installation_1',
      aliasInstallKeys: [],
      ...overrides,
    }
  }

  it('normalizes lexical path aliases and excludes version/executable from the stable key', () => {
    const first = cursorIdentity('/Users/test/.cursor/../.cursor/')
    const second = cursorIdentity('/Users/test/.cursor')
    const upgraded = {
      ...second,
      distribution: { ...second.distribution, executableRealpath: '/Applications/Cursor 2.app/Contents/MacOS/Cursor' },
    }

    expect(first.installKey).toBe(second.installKey)
    expect(upgraded.installKey).toBe(second.installKey)
  })

  it('preserves an existing installation ID across a proven config-root move', () => {
    const oldIdentity = cursorIdentity('/Users/test/.cursor-old')
    const moved = cursorIdentity('/Users/test/.cursor')
    const record = recordFromIdentity(oldIdentity, { aliasInstallKeys: [moved.installKey] })

    expect(matchInstallationIdentity(moved, [record])).toMatchObject({
      kind: 'matched',
      reason: 'alias',
      record: { installationId: 'installation_1' },
    })
  })

  it('uses a host-owned identity to avoid duplicating an installation after a path move', () => {
    const oldIdentity = cursorIdentity('/Users/test/.cursor-old')
    const moved = cursorIdentity('/Users/test/.cursor')

    expect(matchInstallationIdentity(moved, [recordFromIdentity(oldIdentity)])).toMatchObject({
      kind: 'matched',
      reason: 'host_identity',
    })
  })

  it('fails closed when a changed config root has no proven alias', () => {
    const oldIdentity = { ...cursorIdentity('/Users/test/.cursor-old'), hostOwnedIdentity: undefined }
    const moved = { ...cursorIdentity('/Users/test/.cursor'), hostOwnedIdentity: undefined }

    expect(matchInstallationIdentity(moved, [recordFromIdentity(oldIdentity)])).toMatchObject({
      kind: 'ambiguous',
    })
  })

  it('requires the full distribution fingerprint for Pi-family creation', () => {
    const pi = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JABCDEF0123456789',
      productFamilyId: 'pi-official',
      hostVariant: 'pi-official-cli',
      configRoot: '/Users/test/.pi/agent',
      distribution: { distributionId: 'pi-official' },
    })

    expect(assessDistributionIdentity(pi.distribution, undefined, true)).toMatchObject({
      status: 'incomplete',
      missingFields: ['executableRealpath', 'packageProvenance', 'capabilityFingerprint'],
    })
    expect(matchInstallationIdentity(pi, [])).toMatchObject({ kind: 'ambiguous' })
  })

  it('does not adopt an existing Pi record from an incomplete strong fingerprint', () => {
    const complete = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JABCDEF0123456789',
      productFamilyId: 'pi-official',
      hostVariant: 'pi-official-cli',
      configRoot: '/Users/test/.pi/agent',
      distribution: {
        distributionId: 'pi-official',
        executableRealpath: '/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
        packageProvenance: 'npm_metadata:@mariozechner/pi-coding-agent',
        capabilityFingerprint: 'pi-extension-api-v1',
      },
    })
    const incomplete = { ...complete, distribution: { distributionId: 'pi-official' } }
    const record: InstallationIdentityRecord = {
      ...complete,
      installationId: 'pi_installation',
      aliasInstallKeys: [],
    }
    expect(matchInstallationIdentity(incomplete, [record])).toMatchObject({ kind: 'ambiguous' })
  })

  it('treats the old and new official Pi npm scopes as the same package lineage', () => {
    const oldScope = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JABCDEF0123456789',
      productFamilyId: 'pi-official',
      hostVariant: 'pi-official-cli',
      configRoot: '/Users/test/.pi/agent',
      distribution: {
        distributionId: 'pi-official:@mariozechner/pi-coding-agent',
        executableRealpath: '/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
        packageProvenance: 'npm_metadata:@mariozechner/pi-coding-agent',
        capabilityFingerprint: 'pi-official-extension-api',
      },
    })
    const newScope = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JABCDEF0123456789',
      productFamilyId: 'pi-official',
      hostVariant: 'pi-official-cli',
      configRoot: '/Users/test/.pi/agent',
      distribution: {
        distributionId: 'pi-official:@earendil-works/pi-coding-agent',
        executableRealpath: '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
        packageProvenance: 'npm_metadata:@earendil-works/pi-coding-agent',
        capabilityFingerprint: 'pi-official-extension-api',
      },
    })
    const record: InstallationIdentityRecord = {
      ...oldScope,
      installationId: 'pi_installation',
      aliasInstallKeys: [],
    }

    expect(assessDistributionIdentity(newScope.distribution, oldScope.distribution)).toMatchObject({
      status: 'not_required',
      conflictingFields: [],
    })
    expect(matchInstallationIdentity(newScope, [record])).toMatchObject({
      kind: 'matched',
      record: { installationId: 'pi_installation' },
    })
  })

  it('does not merge an exact path with conflicting distribution provenance', () => {
    const observed = cursorIdentity()
    const conflicting = recordFromIdentity({
      ...observed,
      distribution: { ...observed.distribution, distributionId: 'different-distribution' },
    })
    expect(matchInstallationIdentity(observed, [conflicting])).toMatchObject({ kind: 'distribution_conflict' })
  })

  it('rejects a raw path as os_user_identity', () => {
    expect(() => canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: '/Users/test',
      productFamilyId: 'cursor',
      hostVariant: 'cursor-desktop',
      configRoot: '/Users/test/.cursor',
    })).toThrow(/opaque local identifier/)
  })

  it('rejects an exact component config file outside the Installation config root', () => {
    expect(() => canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JABCDEF0123456789',
      productFamilyId: 'opencode',
      hostVariant: 'opencode-v1-cli',
      configRoot: '/Users/test/.config/opencode',
      componentConfigFiles: { memory_tools: '/Users/test/outside.json' },
    })).toThrow(/config file must be inside configRoot/)
  })
})

describe('component and presentation derivation', () => {
  const component = (
    componentKey: InstallationComponentFact['componentKey'],
    deliveryMode: InstallationComponentFact['deliveryMode'],
    verificationStatus: InstallationComponentFact['verificationStatus'],
  ): InstallationComponentFact => ({
    componentKey,
    applicability: 'supported',
    desiredState: 'managed',
    deliveryMode,
    verificationStatus,
    visibilityState: 'dedicated',
  })

  const statusInput = (overrides: Partial<InstallationStatusInput> = {}): InstallationStatusInput => ({
    desiredState: 'managed',
    reconcileState: 'idle',
    hasConsent: true,
    compatible: true,
    hostPresent: true,
    verifiedCapability: 4,
    verificationSummary: 'verified',
    disconnectVerified: false,
    circuitBreakerOpen: false,
    ...overrides,
  })

  it('derives user access levels from verified capability only', () => {
    expect([0, 1, 2, 3, 4].map(level => deriveAccessLevel(level as 0 | 1 | 2 | 3 | 4))).toEqual([
      'unconnected', 'partial', 'partial', 'basic', 'complete',
    ])
    expect(deriveAccessLevel(null)).toBe('unconnected')
  })

  it('keeps delivery and verification summaries component-granular', () => {
    const facts = [
      component('instruction', 'managed', 'verified'),
      component('memory_tools', 'managed', 'verified'),
      component('lifecycle', 'guided', 'stale'),
    ]
    expect(deriveDeliverySummary(facts)).toBe('hybrid')
    expect(deriveVerificationSummary(facts)).toBe('mixed')
  })

  it('allows a verified C2 installation to be available while still partially integrated', () => {
    expect(deriveInstallationStatus(statusInput({ verifiedCapability: 2 }))).toEqual({
      statusGroup: 'available',
      statusReason: 'verified',
      accessLevel: 'partial',
      accessIsHistorical: false,
    })
  })

  it('keeps access level orthogonal to a current conflict', () => {
    expect(deriveInstallationStatus(statusInput({ blockingReasons: ['conflict'] }))).toMatchObject({
      statusGroup: 'needs_attention',
      statusReason: 'conflict',
      accessLevel: 'complete',
    })
  })

  it('marks stale access as historical instead of claiming current availability', () => {
    expect(deriveInstallationStatus(statusInput({ verificationSummary: 'stale' }))).toEqual({
      statusGroup: 'awaiting_verification',
      statusReason: 'verification_stale',
      accessLevel: 'complete',
      accessIsHistorical: true,
    })
  })

  it('does not mislabel paused identity conflicts or uncertain discovery as a repair circuit', () => {
    expect(deriveInstallationStatus(statusInput({
      reconcileState: 'paused',
      blockingReasons: ['conflict'],
    }))).toMatchObject({ statusGroup: 'needs_attention', statusReason: 'conflict' })
    expect(deriveInstallationStatus(statusInput({
      reconcileState: 'paused',
      blockingReasons: ['verification_stale'],
    }))).toMatchObject({ statusGroup: 'awaiting_verification', statusReason: 'verification_stale' })
    expect(deriveInstallationStatus(statusInput({
      reconcileState: 'paused',
      circuitBreakerOpen: true,
    }))).toMatchObject({ statusGroup: 'paused', statusReason: 'circuit_breaker' })
  })

  it('only reports disconnected after read-back has verified absence', () => {
    expect(deriveInstallationStatus(statusInput({ desiredState: 'removed' }))).toMatchObject({
      statusGroup: 'needs_attention', statusReason: 'disconnect_incomplete',
    })
    expect(deriveInstallationStatus(statusInput({ desiredState: 'removed', disconnectVerified: true }))).toMatchObject({
      statusGroup: 'disconnected', statusReason: 'disconnect_verified',
    })
  })

  it('surfaces needs_recovery as an actionable problem rather than active progress', () => {
    expect(deriveInstallationStatus(statusInput({ reconcileState: 'needs_recovery' }))).toMatchObject({
      statusGroup: 'needs_attention', statusReason: 'verification_failed',
    })
  })
})
