import type { AgentIntegrationComponentDto, AgentIntegrationConnectionDto, AgentIntegrationInstallationDto } from '../../src/lib/api-contract'
import type { SharedConnectionEvidence } from './shared-connection-evidence'
import { sha256Json } from './fingerprint'
import type { ConnectionIntent } from './connection-intent'

type Member = AgentIntegrationInstallationDto
export interface ConnectionProjectionInput {
  identity: { key: string; shared: boolean; generation: number | null; valid: boolean }
  displayName: string
  members: readonly Member[]
  sharedEvidence?: SharedConnectionEvidence
  connectionIntent?: ConnectionIntent
  diagnosticMemorySuccess?: { verifiedAt: string }
  activeInstallationIds: ReadonlySet<string>
}

function hasAction(member: Member, sharedNativeTrust = false): boolean {
  return (member.statusGroup === 'needs_attention' && !(sharedNativeTrust && member.statusReason === 'host_confirmation'))
    || member.sourceVerification?.task?.state === 'unavailable'
    || (member.desiredState === 'managed' && member.components.some(component =>
      ['missing','conflict','new_session','confirmation_required'].includes(component.state)
      && !(sharedNativeTrust && component.key === 'lifecycle' && component.state === 'confirmation_required')))
}

/** One projection for metrics, rows and notifications. No authorization is changed here. */
export function projectConnection(input: ConnectionProjectionInput): AgentIntegrationConnectionDto {
  const { identity, members, sharedEvidence } = input
  if (members.length === 0) throw new Error('cannot project an empty connection')
  const live = members.filter(member => member.desiredState !== 'removed')
  const managed = live.filter(member => member.desiredState === 'managed' || member.desiredState === 'disabled')
  const current = managed.length ? managed : live.length ? live : members
  const latest = (times: Array<string | null | undefined>) => times.filter((value): value is string => typeof value === 'string').sort().at(-1) ?? null
  const components: AgentIntegrationComponentDto[] = (['instruction','memory_tools','lifecycle'] as const).map(key => {
    const choices = current.flatMap(member => member.components.filter(component => component.key === key))
    const rank = (component: AgentIntegrationComponentDto) => ['conflict','missing','confirmation_required','new_session','verified','configured','verification_stale','unconnected','unsupported'].indexOf(component.state)
    const selected = [...choices].sort((a,b) => rank(a)-rank(b))[0]
    return selected ? { ...selected } : { key, state: 'unsupported', implementationTypes: [], targetLabel: null, lastVerifiedAt: null }
  })
  const memory = components.find(component => component.key === 'memory_tools')!
  const lifecycle = components.find(component => component.key === 'lifecycle')!
  const instruction = components.find(component => component.key === 'instruction')!
  const serving = current.some(member => member.deactivation?.bridge !== 'stopped' && member.desiredState !== 'removed')
  let memoryCallsVerified = serving && memory.state === 'verified' && managed.some(member => !member.accessIsHistorical)
  let sharedNativeRecognition = false
  const sharedLifecycleFingerprint = sharedEvidence?.components.lifecycle.configurationFingerprint
  if (identity.shared) {
    memoryCallsVerified = Boolean(serving && identity.valid && sharedEvidence?.components.memory_tools.signalsComplete)
    if (memoryCallsVerified) {
      memory.state = 'verified'
      memory.lastVerifiedAt = latest(Object.values(sharedEvidence!.components.memory_tools.signals))
    } else if (memory.state === 'verified') memory.state = serving ? 'configured' : 'unconnected'
    if (lifecycle.state === 'verified') lifecycle.state = serving ? 'configured' : 'unconnected'
    const nativeFacts = current.flatMap(member => member.components.filter(component => component.key === 'lifecycle'
      && component.configurationFingerprint === sharedLifecycleFingerprint && (component.hostRecognitionVerified || component.hostRecognitionRejected)))
      .sort((a,b) => (Date.parse(b.hostRecognitionObservedAt ?? '') || 0) - (Date.parse(a.hostRecognitionObservedAt ?? '') || 0)
        || Number(Boolean(b.hostRecognitionRejected)) - Number(Boolean(a.hostRecognitionRejected)))
    const nativeRecognition = Boolean(serving && identity.valid && sharedLifecycleFingerprint && nativeFacts[0]?.hostRecognitionVerified && !nativeFacts[0]?.hostRecognitionRejected)
    sharedNativeRecognition = nativeRecognition
    lifecycle.hostRecognitionVerified = nativeRecognition
    lifecycle.hostRecognitionRejected = Boolean(nativeFacts[0]?.hostRecognitionRejected)
    lifecycle.hostRecognitionObservedAt = nativeFacts[0]?.hostRecognitionObservedAt ?? null
    if (nativeRecognition && lifecycle.state === 'confirmation_required' && lifecycle.configurationFingerprint === sharedLifecycleFingerprint) lifecycle.state = 'configured'
    if (sharedLifecycleFingerprint) lifecycle.configurationFingerprint = sharedLifecycleFingerprint
    if (lifecycle.hostRecognitionRejected && !['missing','conflict'].includes(lifecycle.state)) lifecycle.state = 'confirmation_required'
    if (serving && identity.valid && nativeRecognition && sharedEvidence?.components.lifecycle.signalsComplete) {
      lifecycle.state = 'verified'
      lifecycle.lastVerifiedAt = latest(Object.values(sharedEvidence.components.lifecycle.signals))
    }
    const start = sharedEvidence?.components.lifecycle.signals.session_start
    // This is the same lifecycle recognition contract used by Codex's managed
    // Skill adapter, applied to the shared physical document, not either host.
    if (serving && identity.valid && nativeRecognition && start && instruction.configurationVerified
      && Date.parse(start) >= Date.parse(instruction.configurationAppliedAt ?? '')) {
      instruction.state = 'verified'
      instruction.lastVerifiedAt = start
    }
  }
  const nativeTrustSharedWith = (member: Member) => sharedNativeRecognition && member.components.some(component =>
    component.key === 'lifecycle' && component.configurationFingerprint === sharedLifecycleFingerprint)
  const needsAction = (member: Member) => hasAction(member, nativeTrustSharedWith(member))
  const actionMembers = members.filter(member => member.desiredState === 'removed'
    ? input.connectionIntent?.state === 'active' && !input.connectionIntent.excludedMemberIds.includes(member.id)
      && member.statusReason === 'native_permission_required'
    : needsAction(member))
  const actionInstallationIds = actionMembers.map(member => member.id)
  const attentionMember = actionMembers[0]
  const attentionTrustShared = attentionMember ? nativeTrustSharedWith(attentionMember) : false
  const pendingComponents = attentionMember?.components.filter(component => !(attentionTrustShared
    && component.key === 'lifecycle' && component.state === 'confirmation_required')) ?? []
  const attentionReason = !attentionMember ? null : attentionMember.statusGroup === 'needs_attention' ? attentionMember.statusReason
    : pendingComponents.some(component => component.state === 'conflict') ? 'conflict'
    : pendingComponents.some(component => component.state === 'missing') ? 'verification_failed'
    : pendingComponents.some(component => component.state === 'confirmation_required') ? 'host_confirmation' : attentionMember.statusReason
  const servingMembers = current.filter(member => member.desiredState !== 'removed' && member.deactivation?.bridge !== 'stopped')
  const currentMemoryBlocked = servingMembers.length > 0 && servingMembers.every(member =>
    member.authentication?.status === 'explicitly_unauthenticated' || member.diagnostic?.reason === 'native_permission_required')
  const memoryBlocked = !identity.valid || !serving || currentMemoryBlocked || ['missing','conflict'].includes(memory.state)
  const diagnostics = current.map(member => member.diagnostic)
  const diagnostic = diagnostics.find(value => value?.status === 'checking')
    ?? diagnostics.find(value => value && value.reason !== 'native_diagnostic_unsupported')
    ?? diagnostics.find(value => value !== undefined)
  if (input.diagnosticMemorySuccess && !memoryBlocked) {
    memoryCallsVerified = true
    memory.state = 'verified'
    memory.lastVerifiedAt = input.diagnosticMemorySuccess.verifiedAt
  }
  if (memoryBlocked) memoryCallsVerified = false
  if (currentMemoryBlocked && memory.state === 'verified') memory.state = 'configured'
  const running = current.some(member => input.activeInstallationIds.has(member.id)
    || ['checking','queued'].includes(member.sourceVerification?.task?.state ?? '')) || diagnostic?.status === 'checking'
  const primary = current.find(needsAction) ?? current[0]
  const maintenance = input.connectionIntent?.state === 'paused' ? 'paused' : managed.length === 0 ? 'unmanaged' : managed.every(member => member.desiredState === 'disabled') ? 'paused' : 'active'
  let statusGroup: AgentIntegrationConnectionDto['statusGroup']
  let statusReason: string
  if (live.length === 0 && actionMembers.length > 0) { statusGroup='needs_attention'; statusReason='native_permission_required' }
  else if (live.length === 0 || !serving) { statusGroup='disconnected'; statusReason='disconnect_verified' }
  else if (!identity.valid || ['missing','conflict'].includes(memory.state)) { statusGroup='needs_attention'; statusReason='conflict' }
  else if (memoryCallsVerified) { statusGroup='available'; statusReason='verified' }
  else if (input.connectionIntent?.state === 'paused') { statusGroup='paused'; statusReason='user_disabled' }
  else if (actionInstallationIds.length > 0) { statusGroup='needs_attention'; statusReason=attentionReason ?? primary.statusReason }
  else if (running) { statusGroup='processing'; statusReason='verifying' }
  else if (managed.length > 0) { statusGroup='awaiting_verification'; statusReason='unverified' }
  else { statusGroup=primary.manageable ? 'awaiting_connection' : 'disconnected'; statusReason=primary.statusReason }
  return {
    ...(diagnostic ? { diagnostic } : {}),
    id:identity.key, familyId:members[0].familyId, displayName:input.displayName,
    installationIds:members.map(member=>member.id), shared:identity.shared, bindingGeneration:identity.generation,
    configurationRevision:sha256Json(sharedEvidence ? Object.values(sharedEvidence.components).map(component=>component.configurationRevision)
      : components.map(component=>[component.key,component.configurationAppliedAt,component.targetLabel])),
    statusGroup,statusReason,components,memoryCallsVerified,maintenance,
    intentRevision: input.connectionIntent?.revision ?? 0,
    intentState: input.connectionIntent?.state ?? 'active',
    actionInstallationIds: !identity.valid && !actionInstallationIds.length ? live.map(member=>member.id) : actionInstallationIds,
    issue: null, attentionReason: !identity.valid ? 'conflict' : attentionReason,
    lastRealUseAt:latest([...members.map(member=>member.lastRealUseAt),...Object.values(sharedEvidence?.components.memory_tools.signals ?? {}),...Object.values(sharedEvidence?.components.lifecycle.signals ?? {})]),
  }
}
