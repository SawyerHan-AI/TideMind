import { describe, expect, it } from 'vitest'
import { projectConnection } from '../../client/electron/agent-integration/connection-projection'
import type { AgentIntegrationInstallationDto } from '../../client/src/lib/api-contract'
import type { SharedConnectionEvidence } from '../../client/electron/agent-integration/shared-connection-evidence'

const time = '2026-11-06T00:00:00.000Z'
function member(id: string, overrides: Partial<AgentIntegrationInstallationDto> = {}): AgentIntegrationInstallationDto {
  return { id, familyId: 'codex', hostVariant: 'codex-cli', variantLabel: id, displayName: 'Codex',
    profileLabel: null, version: '1', desiredState: 'managed', manageable: true,
    statusGroup: 'awaiting_verification', statusReason: 'verification_stale',
    accessLevel: 'partial', accessIsHistorical: false, lastDetectedAt: time,
    lastVerifiedAt: null, lastRepairedAt: null, lastRealUseAt: null,
    components: ['instruction', 'memory_tools', 'lifecycle'].map(key => ({
      key: key as 'instruction' | 'memory_tools' | 'lifecycle', state: 'configured',
      implementationTypes: [], targetLabel: null, lastVerifiedAt: null,
      configurationVerified: true, configurationAppliedAt: time, hostRecognitionVerified: true,
      configurationFingerprint: key === 'lifecycle' ? 'hooks-v1' : key, hostRecognitionObservedAt: time,
    })), ...overrides }
}
function evidence(): SharedConnectionEvidence {
  return { bindingId: 'shared', bindingGeneration: 1, memberIds: ['cli', 'desktop'], components: {
    memory_tools: { signalsComplete: true, configurationRevision: 'memory-v1', configurationFingerprint: 'memory_tools', signals: { brain_recall: time, brain_digest: time } },
    lifecycle: { signalsComplete: false, configurationRevision: 'hooks-v1', configurationFingerprint: 'hooks-v1', signals: { session_start: time } },
  } }
}
function project(members = [member('cli'), member('desktop')], sharedEvidence = evidence()) {
  return projectConnection({ identity: { key: 'binding:shared', shared: true, generation: 1, valid: true },
    displayName: 'Codex', members, sharedEvidence, activeInstallationIds: new Set() })
}
describe('connection projection', () => {
  it('prefers a supported shared member diagnostic over Desktop unsupported regardless of ordering', () => {
    const desktop = member('desktop', { hostVariant: 'codex-desktop', diagnostic: {
      status: 'waiting', reason: 'native_diagnostic_unsupported', runId: null } })
    for (const reason of ['billing_unconfirmed', 'native_permission_required', 'native_diagnostic_failed']) {
      const cli = member('cli', { diagnostic: { status: 'waiting', reason, runId: null } })
      expect(project([desktop, cli]).diagnostic).toEqual(cli.diagnostic)
      expect(project([cli, desktop]).diagnostic).toEqual(cli.diagnostic)
    }
    const cli = member('cli', { diagnostic: { status: 'checking', reason: 'checking', runId: 'run' } })
    expect(project([desktop, cli]).diagnostic).toEqual(cli.diagnostic)
    expect(project([desktop]).diagnostic).toEqual(desktop.diagnostic)
  })

  it('shows shared successful memory once while lifecycle remains unconfirmed', () => {
    const result = project()
    expect(result.statusGroup).toBe('available')
    expect(result.memoryCallsVerified).toBe(true)
    expect(result.components.map(c => c.state)).toEqual(['verified', 'verified', 'configured'])
    expect(result.installationIds).toEqual(['cli', 'desktop'])
  })
  it('does not present static or incomplete checks as verified memory or active work', () => {
    const proof = evidence(); proof.components.memory_tools.signalsComplete = false
    const result = project(undefined, proof)
    expect(result.statusGroup).toBe('awaiting_verification')
    expect(result.memoryCallsVerified).toBe(false)
  })
  it('projects a diagnostic read/write proof only onto memory and keeps real-use timestamps unchanged', () => {
    const cli = member('cli')
    cli.components.forEach(component => { component.state = 'configured'; component.hostRecognitionVerified = false })
    const result = projectConnection({ identity: { key: 'binding:fixture', shared: true, generation: 1, valid: true },
      displayName: 'Codex', members: [cli], activeInstallationIds: new Set(),
      diagnosticMemorySuccess: { verifiedAt: '2026-11-06T00:00:00.000Z' } })
    expect(result.memoryCallsVerified).toBe(true)
    expect(result.statusGroup).toBe('available')
    expect(result.components.map(component => component.state)).toEqual(['configured', 'verified', 'configured'])
    expect(result.lastRealUseAt).toBe(cli.lastRealUseAt ?? null)
    cli.deactivation = { maintenance: 'paused', bridge: 'stopped', hostComponents: 'loaded_unknown' }
    expect(projectConnection({ identity: { key: 'binding:fixture', shared: true, generation: 1, valid: true },
      displayName: 'Codex', members: [cli], activeInstallationIds: new Set(),
      diagnosticMemorySuccess: { verifiedAt: '2026-11-06T00:00:00.000Z' } }).memoryCallsVerified).toBe(false)
  })
  it('requires native recognition in addition to complete shared lifecycle signals', () => {
    const proof = evidence(); proof.components.lifecycle.signalsComplete = true
    const current = member('cli'); current.components.forEach(c => { c.hostRecognitionVerified = false })
    expect(project([current], proof).components.find(c => c.key === 'lifecycle')?.state).toBe('configured')
    expect(project(undefined, proof).components.find(c => c.key === 'lifecycle')?.state).toBe('verified')
  })
  it('keeps paused maintenance separate from an admitted working connection', () => {
    const result = project([member('cli', { desiredState: 'disabled' })])
    expect(result.maintenance).toBe('paused')
    expect(result.statusGroup).toBe('available')
    expect(project([member('cli', { desiredState: 'removed' })]).memoryCallsVerified).toBe(false)
  })
  it('shows native permission pending after explicit reconnect without reviving the stopped bridge', () => {
    const input = { identity: { key: 'installation:one', shared: false, generation: null, valid: true },
      displayName: 'Gemini', members: [member('one', { desiredState: 'removed', statusGroup: 'needs_attention', statusReason: 'native_permission_required',
        deactivation: { maintenance: 'paused', bridge: 'stopped', hostComponents: 'deactivated_verified' } })],
      activeInstallationIds: new Set<string>(), connectionIntent: { domainKey: 'one', revision: 2, state: 'active' as const, pausedMemberIds: [], excludedMemberIds: [] } }
    const result = projectConnection(input)
    expect(result.statusGroup).toBe('needs_attention')
    expect(result.statusReason).toBe('native_permission_required')
    expect(result.actionInstallationIds).toEqual(['one'])
    expect(result.attentionReason).toBe('native_permission_required')
    expect(result.memoryCallsVerified).toBe(false)
    expect(projectConnection({ ...input, connectionIntent: { ...input.connectionIntent, state: 'disconnected' } })
      .actionInstallationIds).toEqual([])
  })
  it('does not put last use timestamps into the configuration version', () => {
    const before = project()
    const proof = evidence(); proof.components.memory_tools.signals.brain_recall = '2026-11-07T00:00:00.000Z'
    expect(project(undefined, proof).configurationRevision).toBe(before.configurationRevision)
  })
  it('keeps a prior read/write proof historical after confirmed logout without rejecting a still-serving sibling', () => {
    const loggedOut = member('cli', { statusGroup: 'needs_attention', statusReason: 'authentication_required',
      authentication: { status: 'explicitly_unauthenticated', billing: 'unknown', reason: 'host_reports_not_authenticated', checkedAt: time } })
    const input = { identity: { key: 'binding:fixture', shared: true, generation: 1, valid: true }, displayName: 'Codex',
      activeInstallationIds: new Set<string>(), diagnosticMemorySuccess: { verifiedAt: time } }
    const blocked = projectConnection({ ...input, members: [loggedOut] })
    expect(blocked.statusGroup).toBe('needs_attention')
    expect(blocked.memoryCallsVerified).toBe(false)
    expect(blocked.components.find(component => component.key === 'memory_tools')?.state).toBe('configured')
    const shared = projectConnection({ ...input, members: [loggedOut, member('desktop')] })
    expect(shared.memoryCallsVerified).toBe(true)
    expect(shared.actionInstallationIds).toContain('cli')
  })
  it('keeps independent configuration roots separate despite the same product name', () => {
    const outputs = ['cli', 'desktop'].map(id => projectConnection({ identity: {
      key: `installation:${id}`, shared: false, valid: true, generation: null,
    }, displayName: 'Codex', members: [member(id)], activeInstallationIds: new Set() }))
    expect(outputs.map(output => output.id)).toEqual(['installation:cli', 'installation:desktop'])
  })
  it('does not request the same shared native trust again or invent a receipt for the other host', () => {
    const cli = member('cli'), desktop = member('desktop')
    const hook = desktop.components.find(component => component.key === 'lifecycle')!
    hook.hostRecognitionVerified = false; hook.state = 'confirmation_required'
    const result = project([cli, desktop])
    expect(result.actionInstallationIds).toEqual([])
    expect(result.components.find(component => component.key === 'lifecycle')?.state).toBe('configured')
    expect(hook.hostRecognitionVerified).toBe(false)
  })
  it('keeps newer native trust rejection and different physical targets actionable', () => {
    const cli = member('cli'), desktop = member('desktop')
    const hook = desktop.components.find(component => component.key === 'lifecycle')!
    Object.assign(hook, { hostRecognitionVerified: false, hostRecognitionRejected: true,
      hostRecognitionObservedAt: '2026-11-06T00:01:00.000Z', state: 'confirmation_required' })
    expect(project([cli, desktop]).components.find(component => component.key === 'lifecycle')?.state).toBe('confirmation_required')
    hook.configurationFingerprint = 'different-hooks'
    expect(project([cli, desktop]).actionInstallationIds).toContain('desktop')
  })

})
