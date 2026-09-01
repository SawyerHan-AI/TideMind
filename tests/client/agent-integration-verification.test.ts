import { describe, expect, it } from 'vitest'
import {
  deriveUserStatus,
  userAccessLevel,
  verificationStatus,
  type VerificationContext,
  type VerificationEvidence,
} from '../../client/electron/agent-integration/verification'

const context: VerificationContext = {
  installationId: 'installation-1',
  componentKey: 'memory_tools',
  family: 'cursor',
  hostVariant: 'cursor-desktop',
  distributionId: 'com.todesktop.230313mzl4w4u92',
  runtimeRealm: 'local_macos',
  hostVersion: '1.0.0',
  osVersion: '15.6',
  tideMindVersion: '0.2.89',
  adapterVersion: 1,
  catalogVersion: 1,
  projectionVersion: 1,
  selectorSchemaVersion: 1,
  manifestVersion: 1,
  artifactHash: 'artifact-hash',
  reloadGeneration: 'reload-1',
  identityAssertion: 'eb_12345678',
  now: '2026-08-25T01:00:00.000Z',
}

const evidence: VerificationEvidence = {
  id: 'evidence-1',
  ...context,
  method: 'host_list_and_probe',
  result: 'verified',
  evidenceHash: 'evidence-hash',
  verifiedAt: '2026-08-25T00:00:00.000Z',
  expiresAt: '2026-08-26T00:00:00.000Z',
  invalidatedAt: null,
  invalidationReason: null,
}

describe('verification evidence freshness', () => {
  it('accepts evidence only when the full version and identity closure matches', () => {
    expect(verificationStatus(evidence, context)).toBe('verified')
  })

  it.each([
    ['hostVersion', '2.0.0'],
    ['tideMindVersion', '0.2.90'],
    ['adapterVersion', 2],
    ['catalogVersion', 2],
    ['projectionVersion', 2],
    ['selectorSchemaVersion', 2],
    ['manifestVersion', 2],
    ['artifactHash', 'changed'],
    ['reloadGeneration', 'reload-2'],
    ['identityAssertion', 'eb_other'],
  ] as const)('marks evidence stale when %s changes', (key, value) => {
    expect(verificationStatus(evidence, { ...context, [key]: value })).toBe('stale')
  })

  it('marks expired, invalidated and failed evidence honestly', () => {
    expect(verificationStatus({ ...evidence, expiresAt: context.now }, context)).toBe('stale')
    expect(verificationStatus({ ...evidence, invalidatedAt: context.now }, context)).toBe('stale')
    expect(verificationStatus({ ...evidence, result: 'failed' }, context)).toBe('failed')
    expect(verificationStatus(null, context)).toBe('unverified')
  })
})

describe('user-facing status projection', () => {
  it('maps internal capability to comprehensible access levels', () => {
    expect([0, 1, 2, 3, 4].map(level => userAccessLevel(level as 0 | 1 | 2 | 3 | 4)))
      .toEqual(['unconnected', 'partial', 'partial', 'basic', 'complete'])
  })

  it('keeps access level separate from current health', () => {
    expect(deriveUserStatus({
      desiredState: 'managed',
      observedState: 'conflicted',
      reconcileState: 'idle',
      verifiedCapability: 4,
      statusReason: 'owned_fragment_modified',
    })).toEqual({ group: 'needs_attention', reason: 'owned_fragment_modified' })
  })

  it('does not claim disconnected while disconnect recovery is incomplete', () => {
    expect(deriveUserStatus({
      desiredState: 'removed',
      observedState: 'partial',
      reconcileState: 'needs_recovery',
      verifiedCapability: 2,
      statusReason: null,
    })).toEqual({ group: 'needs_attention', reason: 'disconnect_incomplete' })
  })

  it('shows a healthy C2 connection as limited but not erroneous', () => {
    expect(deriveUserStatus({
      desiredState: 'managed',
      observedState: 'healthy',
      reconcileState: 'idle',
      verifiedCapability: 2,
      statusReason: null,
    })).toEqual({ group: 'limited', reason: null })
  })
})
