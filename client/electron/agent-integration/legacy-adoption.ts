import { CATALOG_ALIASES } from './catalog.js'
import { sha256Json } from './fingerprint.js'
import { buildLegacyMutationDomain } from './legacy-writer.js'
import {
  persistedDistribution,
  persistedComponentConfigFiles,
  persistedHostOwnedIdentity,
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
  }> = []

  for (const legacy of input.repository.listLegacyAgents()) {
    if (legacy.archived !== 0) {
      report.skippedArchived += 1
      continue
    }
    const historical = input.repository.getInstallationByLegacyAgentAlias(legacy.id, input.runtime.runtimeRealm)
    if (historical) {
      report.alreadyAdopted += 1
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

    candidates.push({ legacy, possible, proven })
  }

  const legacyCountByInstallation = new Map<string, number>()
  for (const candidate of candidates) {
    for (const installationId of new Set(candidate.proven.map(item => item.installation.id))) {
      legacyCountByInstallation.set(
        installationId,
        (legacyCountByInstallation.get(installationId) ?? 0) + 1,
      )
    }
  }
  const uniquelyClaimedInstallations = new Set(candidates.flatMap(candidate => (
    candidate.proven.length === 1
      && legacyCountByInstallation.get(candidate.proven[0].installation.id) === 1
      ? [candidate.proven[0].installation.id]
      : []
  )))

  for (const { legacy, possible, proven } of candidates) {
    const globallyUnique = proven.length === 1
      && legacyCountByInstallation.get(proven[0].installation.id) === 1

    if (!globallyUnique) {
      report.needsConfirmation += 1
      recordNeedsConfirmation(
        input.repository,
        legacy,
        possible.filter(installation => !uniquelyClaimedInstallations.has(installation.id)),
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
    const evidenceHash = sha256Json({
      legacyAgentId: legacy.id,
      legacyToolType: legacy.tool_type,
      installationId: candidate.installation.id,
      observations: candidate.observations,
    })
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

function installationIdentity(row: AgentInstallationRow): InstallationIdentity {
  return {
    runtimeRealm: row.runtime_realm as InstallationIdentity['runtimeRealm'],
    osUserIdentity: row.os_user_identity ?? 'local-user',
    productFamilyId: row.family as InstallationIdentity['productFamilyId'],
    hostVariant: row.host_variant as CatalogId,
    canonicalConfigRoot: row.config_root!,
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
): void {
  const reason = explicitReason ?? (possible.length === 0
    ? 'installation_not_discovered'
    : proven.length === 0
      ? 'exact_generator_identity_evidence_missing'
      : 'multiple_legacy_or_installation_identity_matches')
  const installationIds = [...new Set(possible.map(installation => installation.id))]
  const targets = installationIds.length > 0 ? installationIds : [undefined]
  for (const installationId of targets) {
    if (installationId) repository.markLegacyConfirmationRequired(installationId, createdAt)
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
