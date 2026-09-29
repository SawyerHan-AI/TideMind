import {
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  type DiscoveredInstallation,
  type LocalDiscoveryReport,
} from './discovery.js'
import {
  AGENT_INTEGRATION_RELEASE_ENTRY_MAP,
  type AgentReleaseEntry,
  type AgentReleaseMacArchitecture,
} from './release-manifest.js'
import type { CatalogId } from './types.js'

/**
 * Runtime source compatibility (design §3.1–§3.2, implementation notes §2).
 *
 * Replaces "exact version ∈ frozen allowlist ∧ exact artifact receipt" as the
 * *only* runtime write permission. The frozen receipts remain the release
 * acceptance input and become one positive evidence source ("tested sample").
 * Evidence, in order:
 *   1. tested sample   – the local artifact equals a frozen receipt;
 *   2. signed identity – signed App / signed CLI whose bundle/Team/identifier was
 *      proven by discovery (live codesign is re-attested before every write);
 *   3. npm registry    – the exact local version was statically verified against
 *      the official registry tarball (A-WP2), possibly from the local cache.
 * Anything else is not writable: pending (verification not yet possible) or
 * confirmation-required (the channel has no official evidence we can check
 * without executing it). Interface compatibility is decided afterwards by each
 * Adapter's own structural inspect/plan.
 */

export const RUNTIME_COMPATIBILITY_CONTRACT_VERSION = 1

export type RuntimeSourceReason =
  | 'release_entry_missing'
  | 'release_mode_detect_only'
  | 'release_distribution_not_accepted'
  | 'release_version_unverified'
  | 'source_verification_pending'
  | 'source_not_official'
  | 'source_confirmation_required'

export type RuntimeSourceEvidence =
  | 'tested_sample'
  | 'signed_identity'
  | 'npm_registry'
  | 'npm_registry_cache'
  | 'none'

export type RuntimeSourceState = 'trusted' | 'pending' | 'confirmation_required' | 'rejected'

export interface RuntimeSourceDecision {
  state: RuntimeSourceState
  reason: RuntimeSourceReason | null
  evidence: RuntimeSourceEvidence
  /** Time of the registry verification the decision relies on, when applicable. */
  checkedAt: string | null
  contractVersion: number
}

export interface RuntimeSourceSurface {
  catalogId: CatalogId
  detectedVersion?: string | null
  distributionId?: string | null
  packageProvenance?: string | null
  architecture?: AgentReleaseMacArchitecture | null
  portableArtifactFingerprint?: string | null
}

export interface SourceVerificationKey {
  distributionId: string
  packageProvenance: string
  version: string
  architecture: AgentReleaseMacArchitecture
  portableArtifactFingerprint: string
}

export interface SourceVerificationRecord {
  status: 'verified' | 'mismatch'
  checkedAt: string
}

/** Synchronous read of cached official-verification results (A-WP2 table). */
export interface SourceVerificationStore {
  lookup(key: SourceVerificationKey): SourceVerificationRecord | null
}

/** Asynchronous official verification (A-WP2), invoked by the scanner only. */
export type SourceVerifier = (key: SourceVerificationKey & { catalogId: CatalogId }) => Promise<void>

let activeStore: SourceVerificationStore | null = null

/** Production composition installs the SQLite-backed store; tests may inject one. */
export function setSourceVerificationStore(store: SourceVerificationStore | null): void {
  activeStore = store
}

export function getSourceVerificationStore(): SourceVerificationStore | null {
  return activeStore
}

/**
 * Channels whose installed bytes are produced by an installer/postinstall that
 * cannot be reproduced without executing it. Their exact tested samples remain
 * trusted; anything else needs the user to reinstall from an official channel
 * or to use the user-managed Custom path (never auto-laundered).
 */
export const SOURCE_CONFIRMATION_DISTRIBUTION_IDS: ReadonlySet<string> = new Set([
  'cli:openclaw-local:portable-wrapper',
  'cli:qwen-code-cli:standalone',
])

export function isRuntimeSourceReason(reason: string | undefined | null): reason is RuntimeSourceReason {
  return reason === 'release_entry_missing'
    || reason === 'release_mode_detect_only'
    || reason === 'release_distribution_not_accepted'
    || reason === 'release_version_unverified'
    || reason === 'source_verification_pending'
    || reason === 'source_not_official'
    || reason === 'source_confirmation_required'
}

/** Reasons that mean "this is not (or no longer) a trustworthy official source". */
export function isDefinitiveSourceRejection(reason: string | undefined | null): boolean {
  return reason === 'release_entry_missing'
    || reason === 'release_mode_detect_only'
    || reason === 'release_distribution_not_accepted'
    || reason === 'source_not_official'
}

function decision(
  state: RuntimeSourceState,
  reason: RuntimeSourceReason | null,
  evidence: RuntimeSourceEvidence,
  checkedAt: string | null = null,
): RuntimeSourceDecision {
  return { state, reason, evidence, checkedAt, contractVersion: RUNTIME_COMPATIBILITY_CONTRACT_VERSION }
}

function matchesTestedSample(surface: RuntimeSourceSurface, entry: AgentReleaseEntry): boolean {
  return Boolean(
    surface.architecture
    && surface.portableArtifactFingerprint
    && surface.detectedVersion
    && entry.acceptedDistributionArtifacts.some(receipt => (
      receipt.distributionId === surface.distributionId
      && receipt.packageProvenance === surface.packageProvenance
      && receipt.version === surface.detectedVersion
      && receipt.architecture === surface.architecture
      && receipt.portableArtifactFingerprint === surface.portableArtifactFingerprint
    )),
  )
}

export function evaluateRuntimeSource(
  surface: RuntimeSourceSurface,
  entry: AgentReleaseEntry | undefined = AGENT_INTEGRATION_RELEASE_ENTRY_MAP.get(surface.catalogId),
  store: SourceVerificationStore | null = activeStore,
): RuntimeSourceDecision {
  if (!entry) return decision('rejected', 'release_entry_missing', 'none')
  if (entry.releaseMode !== 'production' || entry.disposition === 'observe_only') {
    return decision('rejected', 'release_mode_detect_only', 'none')
  }
  const official = entry.officialDistributions.find(candidate => (
    candidate.distributionId === surface.distributionId
    && candidate.packageProvenance === surface.packageProvenance
  ))
  if (!official) return decision('rejected', 'release_distribution_not_accepted', 'none')
  // Version is a generation marker bound into plans and activity evidence; it is no
  // longer an allowlist, but an Installation without any version cannot be bound.
  if (!surface.detectedVersion) {
    return decision('confirmation_required', 'release_version_unverified', 'none')
  }
  if (matchesTestedSample(surface, entry)) return decision('trusted', null, 'tested_sample')
  if (official.channel === 'signed_app' || official.channel === 'signed_cli') {
    return decision('trusted', null, 'signed_identity')
  }
  if (SOURCE_CONFIRMATION_DISTRIBUTION_IDS.has(official.distributionId)) {
    return decision('confirmation_required', 'source_confirmation_required', 'none')
  }
  if (!surface.architecture || !surface.portableArtifactFingerprint) {
    return decision('pending', 'source_verification_pending', 'none')
  }
  const record = store?.lookup({
    distributionId: official.distributionId,
    packageProvenance: official.packageProvenance,
    version: surface.detectedVersion,
    architecture: surface.architecture,
    portableArtifactFingerprint: surface.portableArtifactFingerprint,
  }) ?? null
  if (!record) return decision('pending', 'source_verification_pending', 'none')
  if (record.status === 'mismatch') {
    return decision('rejected', 'source_not_official', 'npm_registry', record.checkedAt)
  }
  return decision('trusted', null, 'npm_registry', record.checkedAt)
}

export function runtimeSourceReason(
  surface: RuntimeSourceSurface,
  entry?: AgentReleaseEntry,
  store?: SourceVerificationStore | null,
): RuntimeSourceReason | null {
  return evaluateRuntimeSource(surface, entry, store === undefined ? activeStore : store).reason
}

export function currentArchitecture(): AgentReleaseMacArchitecture {
  return process.arch === 'x64' ? 'x64' : 'arm64'
}

export function runtimeSourceSurfaceOf(installation: Pick<DiscoveredInstallation, 'catalogId' | 'detectedVersion' | 'identity'>): RuntimeSourceSurface {
  return {
    catalogId: installation.catalogId,
    detectedVersion: installation.detectedVersion,
    distributionId: installation.identity.distribution.distributionId,
    packageProvenance: installation.identity.distribution.packageProvenance,
    architecture: currentArchitecture(),
    portableArtifactFingerprint: installation.identity.distribution.portableArtifactFingerprint,
  }
}

/**
 * Scanner-side gate: hands pending official verifications to the verifier (production
 * enqueues a background job and returns immediately; a durable result triggers a
 * rescan) and
 * then records the runtime decision in managementEligibility. Discovery visibility is
 * preserved; only write capability is withheld.
 */
export async function applyRuntimeCompatibilityToReport(
  report: LocalDiscoveryReport,
  options: { verifier?: SourceVerifier | null; store?: SourceVerificationStore | null } = {},
): Promise<LocalDiscoveryReport> {
  const store = options.store === undefined ? activeStore : options.store
  if (options.verifier) {
    for (const installation of report.installations) {
      const surface = runtimeSourceSurfaceOf(installation)
      const first = evaluateRuntimeSource(surface, undefined, store)
      if (first.reason !== 'source_verification_pending') continue
      if (!surface.distributionId || !surface.packageProvenance || !surface.detectedVersion
        || !surface.architecture || !surface.portableArtifactFingerprint) continue
      try {
        await options.verifier({
          catalogId: installation.catalogId,
          distributionId: surface.distributionId,
          packageProvenance: surface.packageProvenance,
          version: surface.detectedVersion,
          architecture: surface.architecture,
          portableArtifactFingerprint: surface.portableArtifactFingerprint,
        })
      } catch {
        // Verification failure leaves the decision pending; it never grants trust.
      }
    }
  }
  return {
    ...report,
    installations: report.installations.map(installation => {
      const reason = evaluateRuntimeSource(runtimeSourceSurfaceOf(installation), undefined, store).reason
      if (!reason) return installation
      return {
        ...installation,
        managementEligibility: {
          schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
          eligible: false,
          reason,
          executableSizeBytes: installation.managementEligibility?.executableSizeBytes,
          proofLimitBytes: installation.managementEligibility?.proofLimitBytes
            ?? MAX_CLI_EXECUTABLE_PROOF_BYTES,
        },
      }
    }),
  }
}
