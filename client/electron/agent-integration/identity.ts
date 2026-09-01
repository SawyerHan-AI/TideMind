import path from 'node:path'
import { AGENT_CATALOG, getCatalogVariant } from './catalog'
import type {
  CatalogAliasResolution,
  CatalogId,
  ComponentKey,
  DistributionIdentity,
  InstallationIdentity,
  InstallationIdentityRecord,
  ProductFamilyId,
  RuntimeRealm,
} from './types'

export interface InstallationIdentityInput {
  runtimeRealm: RuntimeRealm
  osUserIdentity: string
  productFamilyId: ProductFamilyId
  hostVariant: CatalogId
  configRoot: string
  componentConfigFiles?: Readonly<Partial<Record<ComponentKey, string>>>
  explicitProfile?: string | null
  hostOwnedIdentity?: string | null
  distribution?: DistributionIdentity
}

export interface CatalogAliasResolutionResult {
  kind: 'canonical' | CatalogAliasResolution | 'unknown'
  input: string
  catalogIds: readonly CatalogId[]
  reason?: string
}

export interface DistributionIdentityAssessment {
  status: 'complete' | 'incomplete' | 'conflict' | 'not_required'
  missingFields: readonly (keyof DistributionIdentity)[]
  conflictingFields: readonly (keyof DistributionIdentity)[]
}

export type InstallationIdentityMatch =
  | { kind: 'matched'; record: InstallationIdentityRecord; reason: 'install_key' | 'alias' | 'host_identity' }
  | { kind: 'new'; reason: 'no_candidate' }
  | { kind: 'ambiguous'; candidates: readonly InstallationIdentityRecord[]; reason: string }
  | { kind: 'distribution_conflict'; candidates: readonly InstallationIdentityRecord[]; reason: string }

const STRONG_DISTRIBUTION_FIELDS = [
  'distributionId',
  'executableRealpath',
  'packageProvenance',
  'capabilityFingerprint',
] as const satisfies readonly (keyof DistributionIdentity)[]

function normalizeRequiredSegment(value: string, label: string): string {
  const normalized = value.trim().normalize('NFC')
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.includes('\0')) throw new Error(`${label} must not contain NUL`)
  return normalized
}

export function normalizeOsUserIdentity(value: string): string {
  const normalized = normalizeRequiredSegment(value, 'osUserIdentity')
  if (normalized.length < 8 || /[\\/\s]/u.test(normalized) || normalized.includes('/Users/')) {
    throw new Error('osUserIdentity must be an opaque local identifier, not a username or path')
  }
  return normalized
}

export function normalizeExplicitProfile(value?: string | null): string {
  if (value == null || value.trim() === '') return 'default'
  return normalizeRequiredSegment(value, 'explicitProfile')
}

export function normalizeIdentityPath(value: string, runtimeRealm: RuntimeRealm): string {
  const normalizedInput = normalizeRequiredSegment(value, 'configRoot')
  if (runtimeRealm === 'local_macos') {
    if (!path.posix.isAbsolute(normalizedInput)) {
      throw new Error('local_macos configRoot must be an absolute canonical path')
    }
    const normalized = path.posix.normalize(normalizedInput)
    return normalized === '/' ? normalized : normalized.replace(/\/+$/u, '')
  }
  // Future realms may use realm-specific syntax. Keep their canonical form
  // opaque instead of accidentally applying the current macOS path rules.
  return normalizedInput.replace(/\/+$/u, '') || '/'
}

function normalizeOptional(value?: string | null): string | undefined {
  const normalized = value?.trim().normalize('NFC')
  return normalized ? normalized : undefined
}

function normalizeDistribution(
  distribution: DistributionIdentity | undefined,
  runtimeRealm: RuntimeRealm,
): DistributionIdentity {
  const executableRealpath = normalizeOptional(distribution?.executableRealpath)
  return {
    distributionId: normalizeOptional(distribution?.distributionId),
    executableRealpath: executableRealpath
      ? normalizeIdentityPath(executableRealpath, runtimeRealm)
      : undefined,
    packageProvenance: normalizeOptional(distribution?.packageProvenance),
    capabilityFingerprint: normalizeOptional(distribution?.capabilityFingerprint),
  }
}

export function buildInstallKey(input: Pick<
  InstallationIdentity,
  'runtimeRealm' | 'osUserIdentity' | 'productFamilyId' | 'hostVariant' | 'canonicalConfigRoot' | 'explicitProfile'
>): string {
  return JSON.stringify([
    input.runtimeRealm,
    input.osUserIdentity,
    input.productFamilyId,
    input.hostVariant,
    input.canonicalConfigRoot,
    input.explicitProfile,
  ])
}

export function canonicalizeInstallationIdentity(input: InstallationIdentityInput): InstallationIdentity {
  const variant = getCatalogVariant(input.hostVariant)
  if (variant.productFamilyId !== input.productFamilyId) {
    throw new Error(
      `Host variant ${input.hostVariant} belongs to ${variant.productFamilyId}, not ${input.productFamilyId}`,
    )
  }
  const canonicalConfigRoot = normalizeIdentityPath(input.configRoot, input.runtimeRealm)
  const componentConfigFiles = normalizeComponentConfigFiles(
    input.componentConfigFiles,
    canonicalConfigRoot,
    input.runtimeRealm,
  )
  const identityWithoutKey = {
    runtimeRealm: input.runtimeRealm,
    osUserIdentity: normalizeOsUserIdentity(input.osUserIdentity),
    productFamilyId: variant.productFamilyId,
    hostVariant: variant.catalogId,
    canonicalConfigRoot,
    ...(componentConfigFiles === undefined ? {} : { componentConfigFiles }),
    explicitProfile: normalizeExplicitProfile(input.explicitProfile),
    hostOwnedIdentity: normalizeOptional(input.hostOwnedIdentity),
  }
  return {
    ...identityWithoutKey,
    distribution: normalizeDistribution(input.distribution, input.runtimeRealm),
    installKey: buildInstallKey(identityWithoutKey),
  }
}

function normalizeComponentConfigFiles(
  files: Readonly<Partial<Record<ComponentKey, string>>> | undefined,
  canonicalConfigRoot: string,
  runtimeRealm: RuntimeRealm,
): Readonly<Partial<Record<ComponentKey, string>>> | undefined {
  if (!files) return undefined
  const normalized: Partial<Record<ComponentKey, string>> = {}
  for (const componentKey of ['instruction', 'memory_tools', 'lifecycle'] as const) {
    const value = files[componentKey]
    if (!value) continue
    const target = normalizeIdentityPath(value, runtimeRealm)
    if (runtimeRealm === 'local_macos') {
      const relative = path.posix.relative(canonicalConfigRoot, target)
      if (relative === '' || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
        throw new Error(`${componentKey} config file must be inside configRoot`)
      }
    }
    normalized[componentKey] = target
  }
  return Object.keys(normalized).length > 0 ? Object.freeze(normalized) : undefined
}

export function resolveCatalogIdentity(value: string): CatalogAliasResolutionResult {
  const input = normalizeRequiredSegment(value, 'catalog identity')
  const canonical = AGENT_CATALOG.variants.find(variant => variant.catalogId === input)
  if (canonical) return { kind: 'canonical', input, catalogIds: [canonical.catalogId] }

  const alias = AGENT_CATALOG.aliases.find(candidate => candidate.alias === input)
  if (!alias) return { kind: 'unknown', input, catalogIds: [] }
  return {
    kind: alias.resolution,
    input,
    catalogIds: alias.targetIds.filter((target): target is CatalogId =>
      AGENT_CATALOG.variants.some(variant => variant.catalogId === target),
    ),
    reason: alias.reason,
  }
}

export function assessDistributionIdentity(
  observed: DistributionIdentity,
  expected?: DistributionIdentity,
  requiresStrongIdentity = false,
): DistributionIdentityAssessment {
  const piOfficialScopeMigration = expected
    ? equivalentPiOfficialDistribution(observed, expected)
    : false
  const missingFields = requiresStrongIdentity
    ? STRONG_DISTRIBUTION_FIELDS.filter(field => !observed[field])
    : []
  const conflictingFields = expected
    ? STRONG_DISTRIBUTION_FIELDS.filter(field =>
      Boolean(observed[field])
      && Boolean(expected[field])
      && !equivalentDistributionField(field, observed[field]!, expected[field]!)
      && !(field === 'executableRealpath' && piOfficialScopeMigration),
    )
    : []

  if (conflictingFields.length > 0) return { status: 'conflict', missingFields, conflictingFields }
  if (missingFields.length > 0) return { status: 'incomplete', missingFields, conflictingFields }
  return {
    status: requiresStrongIdentity ? 'complete' : 'not_required',
    missingFields,
    conflictingFields,
  }
}

const PI_OFFICIAL_DISTRIBUTION_IDS = new Set([
  'pi-official:@mariozechner/pi-coding-agent',
  'pi-official:@earendil-works/pi-coding-agent',
])
const PI_OFFICIAL_PACKAGE_PROVENANCE = new Set([
  'npm_metadata:@mariozechner/pi-coding-agent',
  'npm_metadata:@earendil-works/pi-coding-agent',
])

function piOfficialPackage(distribution: DistributionIdentity): string | undefined {
  const provenance = distribution.packageProvenance
  if (!provenance || !PI_OFFICIAL_PACKAGE_PROVENANCE.has(provenance)) return undefined
  const packageName = provenance.slice('npm_metadata:'.length)
  if (distribution.distributionId !== `pi-official:${packageName}`) return undefined
  return packageName
}

function executableBelongsToPackage(executableRealpath: string, packageName: string): boolean {
  return executableRealpath.includes(`/node_modules/${packageName}/`)
}

function equivalentPiOfficialDistribution(
  observed: DistributionIdentity,
  expected: DistributionIdentity,
): boolean {
  const observedPackage = piOfficialPackage(observed)
  const expectedPackage = piOfficialPackage(expected)
  if (!observedPackage || !expectedPackage) return false
  if (observed.capabilityFingerprint !== expected.capabilityFingerprint) return false
  if (!observed.executableRealpath || !expected.executableRealpath) return false
  return executableBelongsToPackage(observed.executableRealpath, observedPackage)
    && executableBelongsToPackage(expected.executableRealpath, expectedPackage)
}

function equivalentDistributionField(
  field: (typeof STRONG_DISTRIBUTION_FIELDS)[number],
  observed: string,
  expected: string,
): boolean {
  if (observed === expected) return true
  if (field === 'distributionId') {
    return PI_OFFICIAL_DISTRIBUTION_IDS.has(observed) && PI_OFFICIAL_DISTRIBUTION_IDS.has(expected)
  }
  if (field === 'packageProvenance') {
    return PI_OFFICIAL_PACKAGE_PROVENANCE.has(observed) && PI_OFFICIAL_PACKAGE_PROVENANCE.has(expected)
  }
  return false
}

function sameStableScope(
  record: InstallationIdentityRecord,
  observed: InstallationIdentity,
): boolean {
  return record.runtimeRealm === observed.runtimeRealm
    && record.osUserIdentity === observed.osUserIdentity
    && record.productFamilyId === observed.productFamilyId
    && record.hostVariant === observed.hostVariant
    && record.explicitProfile === observed.explicitProfile
}

function distributionConflicts(
  record: InstallationIdentityRecord,
  observed: InstallationIdentity,
): boolean {
  return assessDistributionIdentity(observed.distribution, record.distribution).status === 'conflict'
}

/**
 * Match an observation without deriving a durable installation_id from paths.
 * A caller persists a generated installation_id only for the `new` result and
 * preserves the existing ID for every `matched` result.
 */
export function matchInstallationIdentity(
  observed: InstallationIdentity,
  records: readonly InstallationIdentityRecord[],
): InstallationIdentityMatch {
  const scoped = records.filter(record => sameStableScope(record, observed))
  const variant = getCatalogVariant(observed.hostVariant)
  const distribution = assessDistributionIdentity(
    observed.distribution,
    undefined,
    variant.requiresStrongDistributionIdentity === true,
  )
  if (distribution.status === 'incomplete') {
    return {
      kind: 'ambiguous',
      candidates: scoped,
      reason: `Strong distribution identity is incomplete: ${distribution.missingFields.join(', ')}.`,
    }
  }

  const exact = scoped.filter(record => record.installKey === observed.installKey)
  if (exact.length > 1) {
    return { kind: 'ambiguous', candidates: exact, reason: 'Multiple records share the exact install key.' }
  }
  const exactCompatible = exact.filter(record => !distributionConflicts(record, observed))
  if (exactCompatible.length === 1) {
    return { kind: 'matched', record: exactCompatible[0], reason: 'install_key' }
  }
  if (exact.length > 0 && exactCompatible.length === 0) {
    return { kind: 'distribution_conflict', candidates: exact, reason: 'Exact install key has conflicting distribution provenance.' }
  }
  const aliases = scoped.filter(record =>
    record.aliasInstallKeys.includes(observed.installKey)
    && !distributionConflicts(record, observed),
  )
  if (aliases.length === 1) return { kind: 'matched', record: aliases[0], reason: 'alias' }
  if (aliases.length > 1) {
    return { kind: 'ambiguous', candidates: aliases, reason: 'The observed install key matches multiple aliases.' }
  }

  if (observed.hostOwnedIdentity) {
    const hostIdentityMatches = scoped.filter(record =>
      record.hostOwnedIdentity === observed.hostOwnedIdentity
      && !distributionConflicts(record, observed),
    )
    if (hostIdentityMatches.length === 1) {
      return { kind: 'matched', record: hostIdentityMatches[0], reason: 'host_identity' }
    }
    if (hostIdentityMatches.length > 1) {
      return { kind: 'ambiguous', candidates: hostIdentityMatches, reason: 'Host-owned identity is not unique.' }
    }
  }

  if (scoped.length > 0) {
    return {
      kind: 'ambiguous',
      candidates: scoped,
      reason: 'A record exists in the same stable scope, but the changed config root has no proven alias.',
    }
  }
  return { kind: 'new', reason: 'no_candidate' }
}
