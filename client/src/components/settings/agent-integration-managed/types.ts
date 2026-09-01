import type {
  AgentIntegrationAccessLevel,
  AgentIntegrationComponentDto,
  AgentIntegrationComponentKey,
  AgentIntegrationComponentState,
  AgentIntegrationFamilyDto,
  AgentIntegrationInstallationDto,
  AgentIntegrationSnapshotDto,
  AgentIntegrationStatusGroup,
} from '../../../lib/api-contract'

export type ManagedStatusGroup = AgentIntegrationStatusGroup
export type ManagedAccessLevel = AgentIntegrationAccessLevel
export type ManagedComponentKey = AgentIntegrationComponentKey
export type ManagedComponentStatus = AgentIntegrationComponentState
export type ManagedComponentDto = AgentIntegrationComponentDto
export type ManagedInstallationDto = AgentIntegrationInstallationDto
export type ManagedProductFamilyDto = AgentIntegrationFamilyDto
export type ManagedSnapshotDto = AgentIntegrationSnapshotDto

export function agentIntegrationsApi() {
  return window.api.agentIntegrations
}

export function installationsForFamily(
  family: AgentIntegrationFamilyDto,
  snapshot: AgentIntegrationSnapshotDto,
): AgentIntegrationInstallationDto[] {
  const ids = new Set(family.installationIds)
  return snapshot.installations.filter(installation => ids.has(installation.id))
}
