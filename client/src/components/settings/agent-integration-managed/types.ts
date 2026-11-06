import type {
  AgentIntegrationAccessLevel,
  AgentIntegrationConnectionDto,
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
export type ManagedProductFamilyDto = AgentIntegrationFamilyDto & { connection?: AgentIntegrationConnectionDto }
export type ManagedSnapshotDto = AgentIntegrationSnapshotDto

export function agentIntegrationsApi() {
  return window.api.agentIntegrations
}

export function installationsForFamily(
  family: AgentIntegrationFamilyDto,
  snapshot: AgentIntegrationSnapshotDto,
): AgentIntegrationInstallationDto[] {
  const byId = new Map(snapshot.installations.map(installation => [installation.id, installation]))
  return family.installationIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
}

/** Product metadata stays separate; each visible row represents one real configuration domain. */
export function connectionFamilies(snapshot: AgentIntegrationSnapshotDto): ManagedProductFamilyDto[] {
  return snapshot.connections.map(connection => {
    const members = snapshot.installations.filter(item => connection.installationIds.includes(item.id))
    members.sort((a, b) => Number(b.desiredState === 'managed') - Number(a.desiredState === 'managed')
      || connection.actionInstallationIds.indexOf(b.id) - connection.actionInstallationIds.indexOf(a.id))
    return { id: connection.id, displayName: connection.displayName, connection,
      installationIds: members.map(item => item.id), statusGroup: connection.statusGroup,
      accessLevels: [...new Set(members.map(item => item.accessLevel))],
      needsAttentionCount: connection.actionInstallationIds.length,
      unreadEventCount: members.reduce((total, item) => total + item.unreadEventCount, 0) }
  })
}

export function connectionIdForInstallation(snapshot: AgentIntegrationSnapshotDto, installationId: string): string | null {
  return snapshot.connections.find(connection => connection.installationIds.includes(installationId))?.id ?? null
}
