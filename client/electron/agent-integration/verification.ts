import type {
  AccessLevel,
  CapabilityLevel,
  DesiredState,
  ObservedState,
  ReconcileState,
  StatusGroup,
  VerificationStatus,
} from './types'

export interface VerificationEvidence {
  id: string
  installationId: string
  componentKey: string
  family: string
  hostVariant: string
  distributionId: string
  runtimeRealm: string
  hostVersion: string
  osVersion: string
  tideMindVersion: string
  adapterVersion: number
  catalogVersion: number
  projectionVersion: number
  selectorSchemaVersion: number
  manifestVersion: number
  artifactHash: string | null
  reloadGeneration: string | null
  method: string
  identityAssertion: string
  result: 'verified' | 'failed'
  evidenceHash: string
  verifiedAt: string
  expiresAt: string | null
  invalidatedAt: string | null
  invalidationReason: string | null
}

export interface VerificationContext {
  installationId: string
  componentKey: string
  family: string
  hostVariant: string
  distributionId: string
  runtimeRealm: string
  hostVersion: string
  osVersion: string
  tideMindVersion: string
  adapterVersion: number
  catalogVersion: number
  projectionVersion: number
  selectorSchemaVersion: number
  manifestVersion: number
  artifactHash: string | null
  reloadGeneration: string | null
  identityAssertion: string
  now: string
}

export interface InstallationStatusFacts {
  desiredState: DesiredState
  observedState: ObservedState
  reconcileState: ReconcileState
  verifiedCapability: CapabilityLevel
  statusReason: string | null
}

const EVIDENCE_KEYS: Array<Exclude<keyof VerificationContext, 'now'>> = [
  'installationId',
  'componentKey',
  'family',
  'hostVariant',
  'distributionId',
  'runtimeRealm',
  'hostVersion',
  'osVersion',
  'tideMindVersion',
  'adapterVersion',
  'catalogVersion',
  'projectionVersion',
  'selectorSchemaVersion',
  'manifestVersion',
  'artifactHash',
  'reloadGeneration',
  'identityAssertion',
]

export function verificationStatus(
  evidence: VerificationEvidence | null,
  context: VerificationContext,
): VerificationStatus {
  if (evidence === null) return 'unverified'
  if (evidence.result === 'failed') return 'failed'
  if (evidence.invalidatedAt !== null) return 'stale'
  if (evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= Date.parse(context.now)) return 'stale'

  for (const key of EVIDENCE_KEYS) {
    if (evidence[key] !== context[key]) return 'stale'
  }
  return 'verified'
}

export function userAccessLevel(capability: CapabilityLevel): AccessLevel {
  if (capability >= 4) return 'complete'
  if (capability >= 3) return 'basic'
  if (capability >= 1) return 'partial'
  return 'unconnected'
}

export function deriveUserStatus(facts: InstallationStatusFacts): {
  group: StatusGroup
  reason: string | null
} {
  if (facts.desiredState === 'removed') {
    return facts.reconcileState === 'needs_recovery'
      ? { group: 'needs_attention', reason: facts.statusReason ?? 'disconnect_incomplete' }
      : { group: 'disconnected', reason: facts.statusReason }
  }
  if (facts.desiredState === 'disabled' || facts.reconcileState === 'paused') {
    return { group: 'paused', reason: facts.statusReason }
  }
  if (['planning', 'applying', 'verifying', 'compensating'].includes(facts.reconcileState)) {
    return { group: 'processing', reason: facts.statusReason }
  }
  if (facts.reconcileState === 'awaiting_consent' || facts.desiredState === 'unmanaged') {
    return { group: 'awaiting_connection', reason: facts.statusReason }
  }
  if (
    facts.reconcileState === 'needs_recovery'
    || facts.observedState === 'drifted'
    || facts.observedState === 'conflicted'
    || facts.observedState === 'inaccessible'
  ) {
    return { group: 'needs_attention', reason: facts.statusReason }
  }
  if (
    facts.observedState === 'partial'
    || facts.observedState === 'incompatible'
    || facts.reconcileState === 'backoff'
    || facts.verifiedCapability < 3
  ) {
    return { group: 'limited', reason: facts.statusReason }
  }
  if (facts.observedState === 'healthy') {
    return { group: 'available', reason: facts.statusReason }
  }
  return { group: 'limited', reason: facts.statusReason ?? 'not_verified' }
}
