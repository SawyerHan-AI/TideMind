import { CATALOG_ALIASES } from './catalog.js'
import { sha256Json } from './fingerprint.js'
import { buildLegacyMutationDomain } from './legacy-writer.js'
import {
  persistedDistribution,
  persistedComponentConfigFiles,
  persistedComponentConfigRoots,
  persistedHostOwnedIdentity,
  legacyAdoptionHostBinding,
  type AgentInstallationRow,
  type AgentIntegrationRepository,
  type LegacyAgentRow,
} from './repository.js'
import type {
  AdapterOperationContext,
  AdapterRuntimeContext,
  AdoptableArtifactObservation,
  AgentHostAdapter,
  CatalogId,
  InstallationIdentity,
} from './types.js'

export interface LegacyAdoptionReport {
  adopted: number
  alreadyAdopted: number
  needsConfirmation: number
  skippedArchived: number
  skippedUnknownType: number
}

/**
 * Read-only host inspection plus local-ledger import.  It never invokes apply,
 * never grants consent, and never moves a writer fence to managed mode.
 */
export async function adoptProvableLegacyConnections(input: {
  repository: AgentIntegrationRepository
  adapters: ReadonlyMap<CatalogId, AgentHostAdapter>
  runtime: AdapterRuntimeContext
  now: string
}): Promise<LegacyAdoptionReport> {
  const report: LegacyAdoptionReport = {
    adopted: 0,
    alreadyAdopted: 0,
    needsConfirmation: 0,
    skippedArchived: 0,
    skippedUnknownType: 0,
  }
  const installations = input.repository.listInstallations({ includeRemoved: false })
  const candidates: Array<{
    legacy: LegacyAgentRow
    possible: AgentInstallationRow[]
    proven: Array<{ installation: AgentInstallationRow; observations: readonly AdoptableArtifactObservation[] }>
    knownSecondary: boolean
  }> = []

  for (const legacy of input.repository.listLegacyAgents()) {
    if (legacy.archived !== 0) {
      report.skippedArchived += 1
      continue
    }
    const historical = input.repository.getInstallationByLegacyAgentAlias(legacy.id, input.runtime.runtimeRealm)
    if (historical) {
      if (historical.host_variant === 'custom-local-mcp') {
        try {
          input.repository.adoptLegacyIdentityOnlyInstallation({
            legacy,
            runtimeRealm: input.runtime.runtimeRealm,
            adoptedAt: input.now,
          })
          report.alreadyAdopted += 1
          continue
        } catch {
          // An alias to an ordinary user-selected Custom target is not proof
          // that this legacy identity was preserved. Continue read-only host
          // matching; any attempted secondary preservation will fail closed
          // without pausing the canonical physical Installation.
        }
      } else if (historical.desired_state !== 'unmanaged'
        || historical.tombstoned_at) {
        report.alreadyAdopted += 1
        continue
      } else {
        const adapter = input.adapters.get(historical.host_variant as CatalogId)
        let observedEvidenceHash: string | null = null
        let observedLegacyEvidenceHash: string | null = null
        if (adapter?.inspectAdoptableArtifacts && historical.config_root) {
          try {
            const observations = (await adapter.inspectAdoptableArtifacts({
              runtime: input.runtime,
              installation: installationIdentity(historical),
              agentId: legacy.id,
              operationId: `legacy_adoption_${legacy.id}:recheck`,
            })).filter(observation => observation.identityAssertion === legacy.id)
            if (observations.length > 0) {
              observedEvidenceHash = legacyEvidenceHash(legacy, historical, observations)
              observedLegacyEvidenceHash = sha256Json({
                legacyAgentId: legacy.id, legacyToolType: legacy.tool_type,
                installationId: historical.id, observations,
              })
            }
          } catch {
            // A read-only probe failure is indistinguishable from missing proof.
            // The repository revokes only historical availability and never writes
            // the host or creates maintenance consent.
          }
        }
        const recheck = input.repository.recheckLegacyAdoption({
          legacyAgentId: legacy.id,
          legacyToolType: legacy.tool_type,
          installationId: historical.id,
          observedEvidenceHash,
          observedLegacyEvidenceHash,
          observedHostBinding: legacyAdoptionHostBinding(historical),
          checkedAt: input.now,
        })
        if (recheck === 'stale') report.needsConfirmation += 1
        else report.alreadyAdopted += 1
        continue
      }
    }
    if (isLegacyCustomToolType(legacy.tool_type)) {
      try {
        const result = input.repository.adoptLegacyCustomInstallation({
          legacy,
          runtimeRealm: input.runtime.runtimeRealm,
          adoptedAt: input.now,
        })
        if (result === 'adopted') report.adopted += 1
        else report.alreadyAdopted += 1
      } catch (error) {
        report.needsConfirmation += 1
        recordNeedsConfirmation(
          input.repository,
          legacy,
          [],
          [],
          input.now,
          error instanceof Error ? error.message : String(error),
        )
      }
      continue
    }
    const alias = CATALOG_ALIASES.find(candidate => candidate.alias === legacy.tool_type)
    if (!alias) {
      report.skippedUnknownType += 1
      continue
    }
    const possible = installations.filter(installation =>
      (alias.targetIds as readonly string[]).includes(installation.host_variant)
      && installation.health_state === 'discovered'
      && installation.status_reason !== 'conflict'
      && installation.status_reason !== 'host_uninstalled',
    )
    const proven: Array<{
      installation: AgentInstallationRow
      observations: readonly AdoptableArtifactObservation[]
    }> = []
    for (const installation of possible) {
      if (!installation.config_root || installation.runtime_realm !== input.runtime.runtimeRealm) continue
      const adapter = input.adapters.get(installation.host_variant as CatalogId)
      if (!adapter?.inspectAdoptableArtifacts) continue
      const context: AdapterOperationContext = {
        runtime: input.runtime,
        installation: installationIdentity(installation),
        agentId: legacy.id,
        operationId: `legacy_adoption_${legacy.id}`,
      }
      const observations = (await adapter.inspectAdoptableArtifacts(context))
        .filter(observation => observation.identityAssertion === legacy.id)
      if (observations.length > 0) {
        proven.push({ installation, observations })
      }
    }

    candidates.push({
      legacy,
      possible,
      proven,
      knownSecondary: proven.length === 1
        && persistedCanonicalSelection(proven[0].installation)?.canonicalAgentId !== legacy.id
        && persistedCanonicalSelection(proven[0].installation)?.candidateLegacyAgentIds.includes(legacy.id) === true,
    })
  }

  const legacyCountByInstallation = new Map<string, number>()
  const claimantsByInstallation = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    if (candidate.knownSecondary) continue
    for (const installationId of new Set(candidate.proven.map(item => item.installation.id))) {
      legacyCountByInstallation.set(
        installationId,
        (legacyCountByInstallation.get(installationId) ?? 0) + 1,
      )
      if (candidate.proven.length === 1) {
        const claimants = claimantsByInstallation.get(installationId) ?? []
        claimants.push(candidate)
        claimantsByInstallation.set(installationId, claimants)
      }
    }
  }
  const canonicalByInstallation = new Map<
    string,
    CanonicalLegacySelection<typeof candidates[number]>
  >()
  for (const [installationId, claimants] of claimantsByInstallation) {
    canonicalByInstallation.set(
      installationId,
      chooseCanonicalLegacyIdentity(claimants, claimants[0].proven[0].installation),
    )
  }
  const claimedInstallations = new Set(
    canonicalByInstallation.keys(),
  )

  for (const { legacy, possible, proven, knownSecondary } of candidates) {
    if (knownSecondary) {
      try {
        const result = input.repository.adoptLegacyIdentityOnlyInstallation({
          legacy,
          runtimeRealm: input.runtime.runtimeRealm,
          adoptedAt: input.now,
        })
        if (result === 'adopted') report.adopted += 1
        else report.alreadyAdopted += 1
      } catch (error) {
        report.needsConfirmation += 1
        recordNeedsConfirmation(
          input.repository, legacy, possible, proven, input.now,
          error instanceof Error ? error.message : String(error), false,
        )
      }
      continue
    }
    const singleTarget = proven.length === 1
    const sharedInstallation = singleTarget
      && (legacyCountByInstallation.get(proven[0].installation.id) ?? 0) > 1
    const canonicalSelection = singleTarget
      ? canonicalByInstallation.get(proven[0].installation.id) ?? null
      : null
    const canonicalIdentity = singleTarget && canonicalSelection?.candidate.legacy.id === legacy.id

    if (sharedInstallation && !canonicalIdentity) {
      try {
        const result = input.repository.adoptLegacyIdentityOnlyInstallation({
          legacy,
          runtimeRealm: input.runtime.runtimeRealm,
          adoptedAt: input.now,
        })
        if (result === 'adopted') report.adopted += 1
        else report.alreadyAdopted += 1
      } catch (error) {
        report.needsConfirmation += 1
        recordNeedsConfirmation(
          input.repository, legacy, possible, proven, input.now,
          error instanceof Error ? error.message : String(error), false,
        )
        continue
      }
      if (canonicalSelection === null) {
        report.needsConfirmation += 1
        recordNeedsConfirmation(
          input.repository,
          legacy,
          possible,
          proven,
          input.now,
          'multiple_legacy_identities_need_canonical_selection',
          false,
        )
      }
      continue
    }

    if (!singleTarget) {
      report.needsConfirmation += 1
      recordNeedsConfirmation(
        input.repository,
        legacy,
        possible.filter(installation => !claimedInstallations.has(installation.id)),
        proven,
        input.now,
      )
      continue
    }
    const candidate = proven[0]
    const adapter = input.adapters.get(candidate.installation.host_variant as CatalogId)!
    const currentObservations = (await adapter.inspectAdoptableArtifacts!({
      runtime: input.runtime,
      installation: installationIdentity(candidate.installation),
      agentId: legacy.id,
      operationId: `legacy_adoption_${legacy.id}:confirm`,
    })).filter(observation => observation.identityAssertion === legacy.id)
    if (sha256Json(currentObservations) !== sha256Json(candidate.observations)) {
      report.needsConfirmation += 1
      recordNeedsConfirmation(input.repository, legacy, possible, [], input.now, 'evidence_changed_during_adoption')
      continue
    }
    const evidenceHash = legacyEvidenceHash(legacy, candidate.installation, candidate.observations)
    try {
      const result = input.repository.adoptLegacyInstallation({
        legacyAgentId: legacy.id,
        legacyToolType: legacy.tool_type,
        installationId: candidate.installation.id,
        expectedHostVariant: candidate.installation.host_variant,
        expectedRuntimeRealm: candidate.installation.runtime_realm,
        expectedConfigRoot: candidate.installation.config_root!,
        expectedDistributionId: candidate.installation.distribution_id,
        expectedInstallKey: candidate.installation.install_key,
        expectedProfileId: candidate.installation.profile_id,
        expectedOsUserIdentity: candidate.installation.os_user_identity,
        expectedProvenance: candidate.installation.provenance,
        expectedExecutablePath: candidate.installation.executable_path,
        expectedAppPath: candidate.installation.app_path,
        expectedDetectedVersion: candidate.installation.detected_version,
        expectedVersionDetectionMethod: candidate.installation.version_detection_method,
        expectedMetadataJson: candidate.installation.metadata_json,
        evidenceHash,
        evidenceVersion: 2,
        canonicalSelectionBasis: canonicalSelection?.basis,
        candidateLegacyAgentIds: canonicalSelection?.claimantAgentIds,
        artifacts: currentObservations.map(observation => ({
          id: `artifact_${sha256Json({
            runtimeRealm: candidate.installation.runtime_realm,
            target: observation.physicalTarget,
            ownershipKey: observation.ownershipKey,
          }).slice(0, 32)}`,
          componentKey: observation.componentKey,
          artifactType: observation.artifactType,
          targetPath: observation.physicalTarget,
          ownershipKey: observation.ownershipKey,
          mutationDomain: observation.domainKind === 'file_fragment'
            && candidate.installation.runtime_realm === 'local_macos'
            ? buildLegacyMutationDomain({
                adapterId: legacy.tool_type,
                target: observation.physicalTarget,
                selector: 'document',
              })
            : `${candidate.installation.runtime_realm}:${observation.domainKind}:${observation.physicalTarget}`,
          projectionVersion: observation.projectionVersion,
          selectorSchemaVersion: String(observation.selectorSchemaVersion),
          containerHash: observation.containerHash ?? null,
          fragmentHash: observation.fragmentHash,
          discoverReachability: observation.discoverReachability,
        })),
        adoptedAt: input.now,
      })
      if (result === 'adopted') report.adopted += 1
      else report.alreadyAdopted += 1
    } catch (error) {
      report.needsConfirmation += 1
      recordNeedsConfirmation(
        input.repository,
        legacy,
        [candidate.installation],
        [],
        input.now,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return report
}

function persistedCanonicalSelection(row: AgentInstallationRow): {
  canonicalAgentId: string
  candidateLegacyAgentIds: string[]
} | null {
  try {
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
    const adoption = metadata.legacyAdoption
    if (!adoption || typeof adoption !== 'object' || Array.isArray(adoption)) return null
    const selection = (adoption as Record<string, unknown>).canonicalSelection
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null
    const canonicalAgentId = (selection as Record<string, unknown>).canonicalAgentId
    const candidates = (selection as Record<string, unknown>).candidateLegacyAgentIds
    if (typeof canonicalAgentId !== 'string'
      || !Array.isArray(candidates)
      || !candidates.every(candidate => typeof candidate === 'string')) return null
    return { canonicalAgentId, candidateLegacyAgentIds: candidates }
  } catch {
    return null
  }
}

type CanonicalLegacySelection<T> = {
  candidate: T
  basis: 'sole_claimant' | 'current_binding' | 'unique_last_active' | 'unique_created' | 'stable_id'
  claimantAgentIds: string[]
}

function chooseCanonicalLegacyIdentity<T extends { legacy: LegacyAgentRow }>(
  claimants: readonly T[],
  installation: AgentInstallationRow,
): CanonicalLegacySelection<T> {
  const result = (
    candidate: T,
    basis: CanonicalLegacySelection<T>['basis'],
  ): CanonicalLegacySelection<T> => ({
    candidate,
    basis,
    claimantAgentIds: claimants.map(item => item.legacy.id).sort(),
  })
  if (claimants.length === 1) return result(claimants[0], 'sole_claimant')
  const exactCurrent = claimants.filter(candidate => candidate.legacy.id === installation.agent_id)
  if (exactCurrent.length === 1) return result(exactCurrent[0], 'current_binding')

  const ranked = claimants
    .map(candidate => ({ candidate, timestamp: Date.parse(candidate.legacy.last_active ?? '') }))
    .filter(item => Number.isFinite(item.timestamp))
    .sort((left, right) => right.timestamp - left.timestamp)
  if (ranked.length > 0 && (!ranked[1] || ranked[0].timestamp !== ranked[1].timestamp)) {
    return result(ranked[0].candidate, 'unique_last_active')
  }

  // Multiple exact Tide Mind selectors on one physical host are equivalent
  // ownership proof.  When activity cannot distinguish them, prefer the most
  // recently created historical identity, then a stable ID order.  This keeps
  // one proven legacy selector canonical instead of inventing a third managed
  // selector under the scanner-generated identity.
  const byCreated = [...claimants].map(candidate => ({
    candidate,
    timestamp: Date.parse(candidate.legacy.created),
  })).sort((left, right) => right.timestamp - left.timestamp)
  if (Number.isFinite(byCreated[0]?.timestamp)
    && (!byCreated[1] || byCreated[0].timestamp !== byCreated[1].timestamp)) {
    return result(byCreated[0].candidate, 'unique_created')
  }
  return result(
    [...claimants].sort((left, right) => right.legacy.id.localeCompare(left.legacy.id))[0],
    'stable_id',
  )
}

function isLegacyCustomToolType(toolType: string): boolean {
  return toolType === 'other' || toolType.startsWith('custom-')
}

function legacyEvidenceHash(
  legacy: Pick<LegacyAgentRow, 'id' | 'tool_type'>,
  installation: AgentInstallationRow,
  observations: readonly AdoptableArtifactObservation[],
): string {
  return sha256Json({
    legacyAgentId: legacy.id,
    legacyToolType: legacy.tool_type,
    installationId: installation.id,
    hostBinding: legacyAdoptionHostBinding(installation),
    // Container bytes are CAS preconditions for a write, not proof that our
    // unchanged selector remains callable after an unrelated config edit.
    observations: observations.map(({ containerHash: _containerHash, ...owned }) => owned)
      .sort((left, right) => sha256Json(left).localeCompare(sha256Json(right))),
  })
}

function installationIdentity(row: AgentInstallationRow): InstallationIdentity {
  return {
    runtimeRealm: row.runtime_realm as InstallationIdentity['runtimeRealm'],
    osUserIdentity: row.os_user_identity ?? 'local-user',
    productFamilyId: row.family as InstallationIdentity['productFamilyId'],
    hostVariant: row.host_variant as CatalogId,
    canonicalConfigRoot: row.config_root!,
    componentConfigRoots: persistedComponentConfigRoots(row),
    componentConfigFiles: persistedComponentConfigFiles(row),
    explicitProfile: row.profile_id || 'default',
    hostOwnedIdentity: persistedHostOwnedIdentity(row),
    distribution: persistedDistribution(row),
    installKey: row.install_key,
  }
}

function recordNeedsConfirmation(
  repository: AgentIntegrationRepository,
  legacy: LegacyAgentRow,
  possible: readonly AgentInstallationRow[],
  proven: readonly { installation: AgentInstallationRow }[],
  createdAt: string,
  explicitReason?: string,
  pauseInstallations = true,
): void {
  const reason = explicitReason ?? (possible.length === 0
    ? 'installation_not_discovered'
    : proven.length === 0
      ? 'exact_generator_identity_evidence_missing'
      : 'multiple_legacy_or_installation_identity_matches')
  const installationIds = [...new Set(possible.map(installation => installation.id))]
  const targets = installationIds.length > 0 ? installationIds : [undefined]
  for (const installationId of targets) {
    if (installationId && pauseInstallations) {
      repository.markLegacyConfirmationRequired(installationId, createdAt)
    }
    repository.recordEvent({
      installationId,
      kind: 'legacy_connection_needs_confirmation',
      severity: 'warning',
      dedupeKey: `${legacy.id}:legacy-needs-confirmation:${installationId ?? 'global'}`,
      payload: {
        legacyAgentId: legacy.id,
        legacyToolType: legacy.tool_type,
        reason,
        candidateInstallationIds: installationIds,
        provenInstallationIds: proven.map(candidate => candidate.installation.id),
      },
      createdAt,
    })
  }
}
