import type {
  ManagedAccessLevel,
  ManagedComponentKey,
  ManagedComponentStatus,
  ManagedInstallationDto,
  ManagedProductFamilyDto,
  ManagedSnapshotDto,
  ManagedStatusGroup,
} from './types'
import type {
  AgentIntegrationApplyResultDto,
  AgentIntegrationSupportProductDto,
} from '../../../lib/api-contract'
import { installationsForFamily } from './types'

export interface PresentationToken {
  labelKey: string
  tone: 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet'
}

const STATUS_TOKENS: Readonly<Record<ManagedStatusGroup, PresentationToken>> = {
  available: { labelKey: 'agent.managed.status.available', tone: 'green' },
  limited: { labelKey: 'agent.managed.status.limited', tone: 'amber' },
  awaiting_connection: { labelKey: 'agent.managed.status.awaitingConnection', tone: 'blue' },
  awaiting_verification: { labelKey: 'agent.managed.status.awaitingVerification', tone: 'blue' },
  processing: { labelKey: 'agent.managed.status.processing', tone: 'violet' },
  needs_attention: { labelKey: 'agent.managed.status.needsAttention', tone: 'red' },
  paused: { labelKey: 'agent.managed.status.paused', tone: 'gray' },
  disconnected: { labelKey: 'agent.managed.status.disconnected', tone: 'gray' },
}

const REASON_KEY_BY_VALUE: Readonly<Record<string, string>> = {
  verified: 'verified', instruction_only: 'instructionOnly', capability_ceiling: 'capabilityCeiling',
  awaiting_consent: 'awaitingConsent', incompatible: 'incompatible', unverified: 'unverified',
  verification_stale: 'verificationStale', connecting: 'connecting', verifying: 'verifying',
  repairing: 'repairing', disconnecting: 'disconnecting', new_session: 'newSession',
  host_confirmation: 'hostConfirmation', conflict: 'conflict', permission: 'permission',
  legacy_confirmation_required: 'legacyConfirmationRequired',
  verification_failed: 'verificationFailed', disconnect_incomplete: 'disconnectIncomplete',
  shared_visibility_remaining: 'sharedVisibilityRemaining', user_disabled: 'userDisabled',
  circuit_breaker: 'circuitBreaker', disconnect_verified: 'disconnectVerified',
  host_uninstalled: 'hostUninstalled', detect_only: 'detectOnly',
  executable_proof_too_large: 'executableProofTooLarge',
  executable_metadata_unavailable: 'executableMetadataUnavailable',
}

const EVENT_TITLES: Readonly<Record<string, { key: string; fallback: string }>> = {
  auto_repair_circuit_reset: {
    key: 'agent.managed.event.autoRepairCircuitReset',
    fallback: 'Automatic repair was re-enabled',
  },
  artifact_auto_restored: {
    key: 'agent.managed.event.artifactAutoRestored',
    fallback: 'A deleted configuration was automatically restored',
  },
  host_probe_uncertain: {
    key: 'agent.managed.event.hostProbeUncertain',
    fallback: 'The Agent could not be checked reliably',
  },
  legacy_connection_adopted: {
    key: 'agent.managed.event.legacyConnectionAdopted',
    fallback: 'An existing Tide Mind connection was recognized',
  },
  legacy_connection_needs_confirmation: {
    key: 'agent.managed.event.legacyConnectionNeedsConfirmation',
    fallback: 'An existing connection needs confirmation',
  },
  legacy_adoption_scan_failed: {
    key: 'agent.managed.event.legacyAdoptionScanFailed',
    fallback: 'Existing connections could not be checked',
  },
}

const ACCESS_KEYS: Readonly<Record<ManagedAccessLevel, string>> = {
  complete: 'agent.managed.access.complete',
  basic: 'agent.managed.access.basic',
  partial: 'agent.managed.access.partial',
  unconnected: 'agent.managed.access.unconnected',
}

const ACCESS_INFO_KEYS: Readonly<Record<ManagedAccessLevel, string>> = {
  complete: 'agent.managed.accessInfo.complete',
  basic: 'agent.managed.accessInfo.basic',
  partial: 'agent.managed.accessInfo.partial',
  unconnected: 'agent.managed.accessInfo.unconnected',
}

const COMPONENT_KEYS: Readonly<Record<ManagedComponentKey, string>> = {
  instruction: 'agent.managed.component.instruction',
  memory_tools: 'agent.managed.component.memoryTools',
  lifecycle: 'agent.managed.component.lifecycle',
}

const COMPONENT_STATUS: Readonly<Record<ManagedComponentStatus, PresentationToken>> = {
  verified: { labelKey: 'agent.managed.componentStatus.verified', tone: 'green' },
  configured: { labelKey: 'agent.managed.componentStatus.configured', tone: 'blue' },
  verification_stale: { labelKey: 'agent.managed.componentStatus.stale', tone: 'amber' },
  new_session: { labelKey: 'agent.managed.componentStatus.needsSession', tone: 'amber' },
  confirmation_required: { labelKey: 'agent.managed.componentStatus.needsConfirmation', tone: 'amber' },
  missing: { labelKey: 'agent.managed.componentStatus.missing', tone: 'red' },
  conflict: { labelKey: 'agent.managed.componentStatus.conflict', tone: 'red' },
  unsupported: { labelKey: 'agent.managed.componentStatus.unsupported', tone: 'gray' },
  unconnected: { labelKey: 'agent.managed.componentStatus.unconnected', tone: 'gray' },
}

export const STATUS_SORT_PRIORITY: Readonly<Record<ManagedStatusGroup, number>> = {
  needs_attention: 0,
  awaiting_connection: 1,
  awaiting_verification: 2,
  processing: 3,
  limited: 4,
  paused: 5,
  available: 6,
  disconnected: 7,
}

export function statusPresentation(status: ManagedStatusGroup): PresentationToken {
  return STATUS_TOKENS[status]
}

export function statusReasonKey(reason: string): string {
  const suffix = REASON_KEY_BY_VALUE[reason]
  return suffix ? `agent.managed.reason.${suffix}` : 'agent.managed.reason.unknown'
}

export function managementUnavailableHelpKey(reason: string): string {
  return reason === 'executable_proof_too_large' || reason === 'executable_metadata_unavailable'
    ? statusReasonKey(reason)
    : 'agent.managed.supportMode.detectableHelp'
}

export function eventTitle(eventKind: string): { key: string; fallback: string } {
  return EVENT_TITLES[eventKind] ?? {
    key: 'agent.managed.event.activity',
    fallback: 'Agent connection activity',
  }
}

export function accessLabelKey(level: ManagedAccessLevel, historical: boolean): string {
  return historical ? `agent.managed.accessHistorical.${level}` : ACCESS_KEYS[level]
}

export function accessInfoKey(level: ManagedAccessLevel): string {
  return ACCESS_INFO_KEYS[level]
}

export function componentLabelKey(key: ManagedComponentKey): string {
  return COMPONENT_KEYS[key]
}

export function componentStatusPresentation(status: ManagedComponentStatus): PresentationToken {
  return COMPONENT_STATUS[status]
}

export function primaryInstallation(
  family: ManagedProductFamilyDto,
  snapshot: ManagedSnapshotDto,
): ManagedInstallationDto {
  return installationsForFamily(family, snapshot).sort((left, right) =>
    STATUS_SORT_PRIORITY[left.statusGroup] - STATUS_SORT_PRIORITY[right.statusGroup]
      || (left.profileLabel ?? '').localeCompare(right.profileLabel ?? ''),
  )[0]
}

export function sortProductFamilies(
  products: readonly ManagedProductFamilyDto[],
  snapshot: ManagedSnapshotDto,
): ManagedProductFamilyDto[] {
  return [...products].sort((left, right) => {
    const leftInstallation = primaryInstallation(left, snapshot)
    const rightInstallation = primaryInstallation(right, snapshot)
    return STATUS_SORT_PRIORITY[leftInstallation.statusGroup] - STATUS_SORT_PRIORITY[rightInstallation.statusGroup]
      || left.displayName.localeCompare(right.displayName)
  })
}

export interface SnapshotSummary {
  productCount: number
  installationCount: number
  availableCount: number
  pendingCount: number
  attentionCount: number
}

export function summarizeSnapshot(snapshot: ManagedSnapshotDto): SnapshotSummary {
  return {
    productCount: snapshot.summary.familyCount,
    installationCount: snapshot.summary.installationCount,
    availableCount: snapshot.summary.availableCount,
    // Detect-only catalog entries remain visible, but must never advertise a
    // connect flow which production has deliberately gated off.
    pendingCount: snapshot.installations.filter(item =>
      item.manageable && item.statusGroup === 'awaiting_connection',
    ).length,
    attentionCount: snapshot.summary.needsAttentionCount,
  }
}

export interface AggregatedAccess {
  kind: 'uniform' | 'mixed'
  level?: ManagedAccessLevel
  historical: boolean
  counts: Partial<Record<ManagedAccessLevel, number>>
}

export function aggregateAccess(installations: readonly ManagedInstallationDto[]): AggregatedAccess {
  const counts: Partial<Record<ManagedAccessLevel, number>> = {}
  for (const installation of installations) {
    counts[installation.accessLevel] = (counts[installation.accessLevel] ?? 0) + 1
  }
  const levels = Object.keys(counts) as ManagedAccessLevel[]
  const historical = installations.some(installation => installation.accessIsHistorical)
  if (levels.length === 1 && installations.every(item => item.accessIsHistorical === historical)) {
    return { kind: 'uniform', level: levels[0], historical, counts }
  }
  return { kind: 'mixed', historical, counts }
}

export interface AggregatedComponent {
  key: ManagedComponentKey
  kind: 'uniform' | 'mixed'
  status?: ManagedComponentStatus
  counts: Partial<Record<ManagedComponentStatus, number>>
}

export function aggregateComponents(
  installations: readonly ManagedInstallationDto[],
): AggregatedComponent[] {
  return (['instruction', 'memory_tools', 'lifecycle'] as const).map(key => {
    const counts: Partial<Record<ManagedComponentStatus, number>> = {}
    for (const installation of installations) {
      const state = installation.components.find(component => component.key === key)?.state ?? 'unsupported'
      counts[state] = (counts[state] ?? 0) + 1
    }
    const states = Object.keys(counts) as ManagedComponentStatus[]
    return states.length === 1
      ? { key, kind: 'uniform', status: states[0], counts }
      : { key, kind: 'mixed', counts }
  })
}

/** Renderer receives redacted labels; this is a final accidental-secret guard. */
export function safeDisplayTarget(value: string | null | undefined): string {
  if (!value) return '—'
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1•••@')
    .replace(/([?&](?:token|key|secret|password)=)[^&#\s]+/giu, '$1•••')
}

export function canShowGreenAvailability(installation: ManagedInstallationDto): boolean {
  if (installation.statusGroup !== 'available' || installation.accessIsHistorical) return false
  const memoryTools = installation.components.find(component => component.key === 'memory_tools')
  return memoryTools?.state === 'verified'
}

export function matchesSupportQuery(product: AgentIntegrationSupportProductDto, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return [product.displayName, ...product.variants.map(variant => variant.displayName)]
    .some(label => label.toLocaleLowerCase().includes(normalizedQuery))
}

export interface ExecutionSummary {
  total: number
  committed: number
  awaitingVerification: number
  failed: number
  needsRecovery: number
  interrupted: number
  otherAttention: number
  needsAttention: number
}

export function summarizeExecutionResults(results: AgentIntegrationApplyResultDto['results']): ExecutionSummary {
  const failed = results.filter(item => item.status === 'failed').length
  const needsRecovery = results.filter(item => item.status === 'needs_recovery').length
  const interrupted = results.filter(item => item.status === 'interrupted').length
  const otherAttention = results.filter(item => (
    item.status !== 'committed'
    && item.status !== 'awaiting_verification'
    && item.status !== 'failed'
    && item.status !== 'needs_recovery'
    && item.status !== 'interrupted'
  )).length
  return {
    total: results.length,
    committed: results.filter(item => item.status === 'committed').length,
    awaitingVerification: results.filter(item => item.status === 'awaiting_verification').length,
    failed,
    needsRecovery,
    interrupted,
    otherAttention,
    needsAttention: failed + needsRecovery + interrupted + otherAttention,
  }
}

export function executionInstallationIds(
  results: AgentIntegrationApplyResultDto['results'],
  status: AgentIntegrationApplyResultDto['results'][number]['status'],
): string[] {
  return results.filter(item => item.status === status).map(item => item.installationId)
}

export function canCloseBatchDialog(loading: boolean): boolean {
  return !loading
}

export function nextRovingTabIndex(current: number, total: number, key: string): number | null {
  if (total <= 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % total
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + total) % total
  if (key === 'Home') return 0
  if (key === 'End') return total - 1
  return null
}

export function detailFocusDestination(
  pendingInstallationId: string | null,
  currentInstallationId: string,
  outcome: 'success' | 'failure',
): 'tab' | 'retry' | null {
  if (!pendingInstallationId || pendingInstallationId !== currentInstallationId) return null
  return outcome === 'success' ? 'tab' : 'retry'
}
