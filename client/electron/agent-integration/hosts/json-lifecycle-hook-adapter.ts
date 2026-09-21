import fs from 'node:fs'
import path from 'node:path'
import { shellArgument } from '../shell-argument'
import { sha256Json } from '../fingerprint'
import { modifyJsoncObject, parseJsoncObject } from '../jsonc-document'
import { verifyHostActivity } from '../host-activity-evidence'
import {
  ensureSafeParentDirectoryWithinRoot,
  inspectRegularFileWithinRoot,
  writeRegularFileAtomicCas,
  type FileFingerprint,
} from '../safe-file'
import type {
  AdoptableArtifactObservation,
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AdapterVerificationRequest,
  AgentHostAdapter,
  CatalogId,
  ComponentVerificationResult,
  HostActivitySignal,
  JsonValue,
  MutationReadBack,
  PlannedMutation,
  ReloadRequirement,
} from '../types'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from './portable-skill'

export type LifecycleEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'PostCompact'
  | 'pre_user_prompt'
  | 'post_cascade_response'

export const QWEN_CODE_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start', 'pre_compact', 'session_end',
] as const)
export const ZCODE_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start',
] as const)
type ActivationMode = 'always_enabled' | 'qwen_default_enabled' | 'zcode_explicit_enabled'

export interface ManagedHookEvent {
  eventName: LifecycleEventName
  signalName: Extract<HostActivitySignal, 'session_start' | 'pre_compact' | 'post_compact' | 'session_end'>
  entry: JsonValue
}

interface JsonLifecycleHookMetadata {
  canonicalPath: string
  containerPreconditionHash: string | null
  liveFragmentHash: string | null
  ownedFragmentHash: string | null
  desiredFragment?: JsonValue
  remove: boolean
}

interface ManagedHookInspection {
  file: FileFingerprint
  fragment: JsonValue | undefined
  fragmentHash: string | null
  activation: 'enabled' | 'missing' | 'explicitly_disabled'
  complete: boolean
  hasUnmanagedEntries: boolean
  diagnostics: string[]
}

export interface JsonLifecycleHookHostSpec {
  catalogId: CatalogId
  adapterVersion: string
  configFile(context: AdapterOperationContext): string
  eventRoot: readonly string[]
  activationMode: ActivationMode
  reload: ReloadRequirement
  distributionId?: string
  detect?(context: AdapterOperationContext): boolean
  runtimeAssetsPresent?(context: AdapterOperationContext): boolean
  runtimeProvenance?(context: AdapterOperationContext): readonly string[]
  activityRequirement?: 'any' | 'all'
  /** Parse JSON-with-comments and preserve unrelated bytes during field edits. */
  preserveJsonc?: boolean
  events(context: AdapterOperationContext): readonly ManagedHookEvent[]
  identifiesEntry(event: ManagedHookEvent, candidate: JsonValue, context: AdapterOperationContext): boolean
}

/**
 * Manages one identity-bound entry inside each host-owned hook event array.
 *
 * The owned fragment is virtual: it contains only Tide Mind entries, while the
 * atomic file mutation preserves every sibling event and every user entry.
 * This gives the coordinator one selector/CAS/read-back unit without claiming
 * ownership of a host's entire `hooks` object or an entire event array.
 */
export function createJsonLifecycleHookHostAdapter(spec: JsonLifecycleHookHostSpec): AgentHostAdapter {
  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const target = spec.configFile(context)
    const detected = spec.detect?.(context) ?? defaultDetected(context, target)
    if (!detected) {
      return inspectionResult(spec, context, target, false, undefined, [
        'host_not_detected_or_hook_format_unsupported',
      ])
    }
    try {
      const managed = inspectManagedHooks(spec, context, target)
      const visibility = managed.fragment === undefined
        ? 'absent'
        : managed.complete && managed.activation === 'enabled'
          ? 'dedicated'
          : 'shared_visible'
      const diagnostics = [...managed.diagnostics]
      if (spec.runtimeAssetsPresent && !spec.runtimeAssetsPresent(context)) {
        diagnostics.push('lifecycle_runtime_missing')
      }
      return {
        catalogId: spec.catalogId,
        detected: true,
        detectedVersion: undefined,
        distribution: {
          ...context.installation.distribution,
          distributionId: context.installation.distribution.distributionId ?? spec.distributionId,
        },
        components: [{
          componentKey: 'lifecycle',
          visibility,
          verificationStatus: 'unverified',
          observedTarget: managed.file.canonicalPath,
          observedFragmentHash: managed.fragmentHash ?? undefined,
          details: {
            activation: managed.activation,
            configuredEntries: managed.fragment === undefined
              ? 0
              : Object.keys(managed.fragment as Record<string, JsonValue>).length,
            expectedEntries: spec.events(context).length,
            hasUnmanagedEntries: managed.hasUnmanagedEntries,
          },
        }],
        provenance: [target, ...(spec.runtimeProvenance?.(context) ?? [])],
        diagnostics,
      }
    } catch (error) {
      return inspectionResult(spec, context, target, true, 'unknown', [errorMessage(error)])
    }
  }

  return {
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    componentKeys: ['lifecycle'],
    implementationTypes: { lifecycle: ['hook'] },
    componentContracts: {
      lifecycle: {
        deliveryMode: 'managed', artifactTypes: ['hook'], mutationDomain: 'file_fragment', reload: spec.reload,
      },
    },
    inspect,
    async inspectAdoptableArtifacts(context): Promise<readonly AdoptableArtifactObservation[]> {
      const target = spec.configFile(context)
      try {
        const managed = inspectManagedHooks(spec, context, target)
        const desired = desiredFragment(spec, context)
        if (!managed.complete
          || managed.activation !== 'enabled'
          || managed.fragmentHash === null
          || managed.fragmentHash !== sha256Json(desired)) return []
        return [{
          componentKey: 'lifecycle',
          artifactType: 'hook',
          domainKind: 'file_fragment',
          physicalTarget: managed.file.canonicalPath,
          ownershipKey: ownershipKey(spec, context),
          selectorSchemaVersion: 1,
          projectionVersion: context.runtime.projectionVersion,
          containerHash: managed.file.containerHash ?? undefined,
          fragmentHash: managed.fragmentHash,
          identityAssertion: context.agentId,
          discoverReachability: 'dedicated',
        }]
      } catch {
        return []
      }
    },
    async plan(context, request) {
      return buildPlan(spec, context, request, false)
    },
    async disconnect(context, request) {
      return buildPlan(spec, context, {
        desiredCapability: 0,
        desiredComponents: request.componentKeys,
        observed: request.observed,
        ownedArtifacts: request.ownedArtifacts,
      }, true)
    },
    async apply(context, mutation) {
      if (mutation.operation !== 'create' && mutation.operation !== 'update' && mutation.operation !== 'remove') {
        throw new Error(`Unsupported JSON lifecycle mutation operation: ${mutation.operation}`)
      }
      const metadata = parseMetadata(mutation)
      const before = inspectManagedHooks(spec, context, mutation.physicalTarget)
      if (before.file.canonicalPath !== metadata.canonicalPath) {
        throw new JsonLifecycleHookConflictError('container_canonical_path_changed')
      }
      if (before.file.containerHash !== metadata.containerPreconditionHash) {
        throw new JsonLifecycleHookConflictError('container_precondition_changed')
      }
      if (before.fragmentHash !== metadata.liveFragmentHash) {
        throw new JsonLifecycleHookConflictError('fragment_precondition_changed')
      }
      if (!metadata.remove && before.activation === 'explicitly_disabled') {
        throw new JsonLifecycleHookConflictError('host_hooks_explicitly_disabled')
      }

      const document = before.file.exists ? readJsonObject(before.file.canonicalPath, spec.preserveJsonc) : {}
      let content: string
      if (spec.preserveJsonc) {
        const source = before.file.exists ? fs.readFileSync(before.file.canonicalPath, 'utf8') : '{}\n'
        content = mutateManagedHooksJsonc(spec, context, source, document, metadata.remove)
      } else {
        mutateManagedHooks(spec, context, document, metadata.remove)
        content = `${JSON.stringify(document, null, 2)}\n`
      }
      ensureSafeParentDirectoryWithinRoot(mutation.physicalTarget, context.installation.canonicalConfigRoot)
      writeRegularFileAtomicCas(mutation.physicalTarget, content, {
        expectedCanonicalPath: metadata.canonicalPath,
        expectedContainerHash: metadata.containerPreconditionHash,
      })

      const after = inspectManagedHooks(spec, context, mutation.physicalTarget)
      const expectedHash = metadata.remove ? null : (mutation.desiredFragmentHash ?? null)
      if (after.fragmentHash !== expectedHash
        || (!metadata.remove && after.activation !== 'enabled')) {
        throw new JsonLifecycleHookConflictError('fragment_read_back_mismatch')
      }
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: after.fragmentHash ?? undefined,
        hostReceipt: {
          canonicalPath: after.file.canonicalPath,
          containerHash: after.file.containerHash,
        },
      }
    },
    async readBack(context, mutation): Promise<MutationReadBack> {
      const metadata = parseMetadata(mutation)
      try {
        const after = inspectManagedHooks(spec, context, mutation.physicalTarget)
        const expectedHash = metadata.remove ? null : (mutation.desiredFragmentHash ?? null)
        const matchesDesired = after.fragmentHash === expectedHash
          && (metadata.remove || after.activation === 'enabled')
        return {
          operationId: mutation.operationId,
          observed: after.fragment !== undefined,
          matchesDesired,
          observedFragmentHash: after.fragmentHash ?? undefined,
          visibility: after.fragment === undefined
            ? 'absent'
            : after.complete && after.activation === 'enabled'
              ? 'dedicated'
              : 'shared_visible',
          diagnostics: after.diagnostics,
        }
      } catch (error) {
        return {
          operationId: mutation.operationId,
          observed: false,
          matchesDesired: false,
          visibility: 'unknown',
          diagnostics: [errorMessage(error)],
        }
      }
    },
    async verify(context, request: AdapterVerificationRequest): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes('lifecycle')) return []
      const current = await inspect(context)
      const lifecycle = current.components.find(component => component.componentKey === 'lifecycle')
      if (request.expectedCapability === 0 && lifecycle?.visibility === 'absent') {
        return [{
          componentKey: 'lifecycle',
          status: 'verified',
          verifiedCapability: 0,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['disconnect_static_readback_verified'],
        }]
      }
      if (lifecycle?.visibility !== 'dedicated') {
        return [{
          componentKey: 'lifecycle',
          status: 'failed',
          verifiedCapability: null,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: current.diagnostics.length > 0
            ? current.diagnostics
            : ['managed_lifecycle_fragment_not_active'],
        }]
      }
      const expectedHash = sha256Json(desiredFragment(spec, context))
      if (lifecycle.observedFragmentHash !== expectedHash) {
        return [{
          componentKey: 'lifecycle',
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: lifecycle.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['managed_lifecycle_fragment_drifted_from_current_desired'],
        }]
      }
      if (spec.runtimeAssetsPresent && !spec.runtimeAssetsPresent(context)) {
        return [{
          componentKey: 'lifecycle',
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: lifecycle.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version'],
          diagnostics: ['lifecycle_runtime_missing'],
        }]
      }
      const activity = await verifyHostActivity(context, request, {
        componentKey: 'lifecycle',
        signalNames: spec.events(context).map(event => event.signalName),
        // Static read-back proves every configured event entry. Each host spec
        // selects whether one fresh event or its complete event set is needed
        // to prove the host loaded this exact managed generation.
        require: spec.activityRequirement ?? 'any',
      })
      if (activity.status === 'unverified') {
        return [{
          ...activity,
          evidenceHash: lifecycle.observedFragmentHash,
          identityAssertion: context.agentId,
          diagnostics: ['static_readback_passed', ...activity.diagnostics],
        }]
      }
      return [activity]
    },
  }
}

export const QWEN_CODE_LIFECYCLE_SPEC: JsonLifecycleHookHostSpec = {
  catalogId: 'qwen-code-cli',
  adapterVersion: '1',
  configFile: context => context.installation.componentConfigFiles?.lifecycle
    ?? path.join(context.installation.canonicalConfigRoot, 'settings.json'),
  eventRoot: ['hooks'],
  activationMode: 'qwen_default_enabled',
  activityRequirement: 'all',
  reload: 'new_session',
  events: context => [
    qwenCommandEvent(context, 'SessionStart', QWEN_CODE_REQUIRED_LIFECYCLE_SIGNALS[0], 'startup|resume|clear|compact',
      context.runtime.hookScriptPath, [
        '--skill-path', path.join(context.installation.canonicalConfigRoot, 'skills', 'tidemind', 'SKILL.md'),
        '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
      ]),
    qwenCommandEvent(context, 'PreCompact', QWEN_CODE_REQUIRED_LIFECYCLE_SIGNALS[1], 'manual|auto',
      context.runtime.preCompactScriptPath),
    qwenCommandEvent(context, 'SessionEnd', QWEN_CODE_REQUIRED_LIFECYCLE_SIGNALS[2], 'clear|logout|prompt_input_exit|bypass_permissions_disabled|other',
      sessionEndScript(context)),
  ],
  identifiesEntry: (event, candidate, context) => {
    const record = asObject(candidate)
    const hooks = record?.hooks
    if (!Array.isArray(hooks)) return false
    return hooks.some(hook => asObject(hook)?.name === qwenHookName(context, event.eventName))
  },
}

export const ZCODE_DESKTOP_LIFECYCLE_SPEC: JsonLifecycleHookHostSpec = {
  catalogId: 'zcode-desktop',
  adapterVersion: '1',
  configFile: context => context.installation.componentConfigFiles?.lifecycle
    ?? path.join(context.installation.canonicalConfigRoot, 'config.json'),
  eventRoot: ['hooks', 'events'],
  activationMode: 'zcode_explicit_enabled',
  reload: 'new_session',
  distributionId: 'dev.zcode.app',
  events: context => [{
    eventName: 'SessionStart',
    signalName: ZCODE_REQUIRED_LIFECYCLE_SIGNALS[0],
    entry: {
      matcher: 'startup|resume|clear|compact',
      hooks: [{
        type: 'process',
        command: context.runtime.shimPath,
        args: [
          context.runtime.hookScriptPath,
          '--agent-id', context.agentId,
          '--skill-path', path.join(context.runtime.homeDir, '.zcode', 'skills', 'tidemind', 'SKILL.md'),
          '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
          '--tool', 'zcode',
          ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
        ],
        enabled: true,
        timeoutMs: 60_000,
      }],
    },
  }],
  identifiesEntry: (_event, candidate, context) => {
    const hooks = asObject(candidate)?.hooks
    if (!Array.isArray(hooks)) return false
    return hooks.some(hook => {
      const record = asObject(hook)
      const args = record?.args
      return record?.type === 'process'
        && Array.isArray(args)
        && hasExactArgument(args, '--agent-id', context.agentId)
        && hasExactArgument(args, '--tool', 'zcode')
        && (!context.activityGenerationToken
          || hasExactArgument(args, '--activity-generation-token', context.activityGenerationToken))
    })
  },
}

export function createQwenCodeLifecycleHookAdapter(): AgentHostAdapter {
  return createJsonLifecycleHookHostAdapter(QWEN_CODE_LIFECYCLE_SPEC)
}

export function createZCodeDesktopLifecycleHookAdapter(): AgentHostAdapter {
  return createJsonLifecycleHookHostAdapter(ZCODE_DESKTOP_LIFECYCLE_SPEC)
}

export class JsonLifecycleHookConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonLifecycleHookConflictError'
  }
}

function buildPlan(
  spec: JsonLifecycleHookHostSpec,
  context: AdapterOperationContext,
  request: AdapterPlanRequest,
  remove: boolean,
): AdapterPlan {
  const target = spec.configFile(context)
  const unsupported = request.desiredComponents.filter(component => component !== 'lifecycle')
  const base: Omit<AdapterPlan, 'mutations' | 'diagnostics'> = {
    catalogId: spec.catalogId,
    installationKey: context.installation.installKey,
    adapterVersion: spec.adapterVersion,
    projectionVersion: context.runtime.projectionVersion,
    requiredUserActions: unsupported.map(component => `component_requires_other_projection:${component}`),
  }
  if (!request.desiredComponents.includes('lifecycle')) {
    return { ...base, mutations: [], diagnostics: ['lifecycle_not_requested'] }
  }
  if (!request.observed.detected) {
    return { ...base, mutations: [], diagnostics: ['host_not_detected_or_hook_format_unsupported'] }
  }
  if (!remove && spec.runtimeAssetsPresent && !spec.runtimeAssetsPresent(context)) {
    return { ...base, mutations: [], diagnostics: ['lifecycle_runtime_missing'] }
  }

  let live: ManagedHookInspection
  try {
    live = inspectManagedHooks(spec, context, target)
  } catch (error) {
    return { ...base, mutations: [], diagnostics: [errorMessage(error)] }
  }
  if (!remove && live.activation === 'explicitly_disabled') {
    return { ...base, mutations: [], diagnostics: ['host_hooks_explicitly_disabled'] }
  }
  if (!remove
    && spec.activationMode === 'zcode_explicit_enabled'
    && live.activation === 'missing'
    && live.hasUnmanagedEntries) {
    return {
      ...base,
      mutations: [],
      requiredUserActions: [...base.requiredUserActions, 'confirm_enable_existing_zcode_hooks'],
      diagnostics: ['shared_host_hook_enablement_requires_confirmation'],
    }
  }

  const key = ownershipKey(spec, context)
  const baseline = request.ownedArtifacts.find(artifact =>
    artifact.componentKey === 'lifecycle'
      && path.resolve(artifact.physicalTarget) === path.resolve(target)
      && artifact.ownershipKey === key,
  )
  const desired = remove ? undefined : desiredFragment(spec, context)
  const desiredHash = desired === undefined ? null : sha256Json(desired)
  const action = planAction({
    remove,
    liveHash: live.fragmentHash,
    desiredHash,
    ownedHash: baseline?.ownedFragmentHash ?? null,
  })
  if (action.kind === 'conflict') {
    return { ...base, mutations: [], diagnostics: [action.reason] }
  }
  if (action.kind === 'noop') return { ...base, mutations: [], diagnostics: [] }

  const metadata: JsonLifecycleHookMetadata = {
    canonicalPath: live.file.canonicalPath,
    containerPreconditionHash: live.file.containerHash,
    liveFragmentHash: live.fragmentHash,
    ownedFragmentHash: baseline?.ownedFragmentHash ?? null,
    remove,
    ...(desired === undefined ? {} : { desiredFragment: desired }),
  }
  const mutation: PlannedMutation = {
    operationId: `${context.operationId}:lifecycle`,
    componentKey: 'lifecycle',
    operation: action.kind,
    domainKind: 'file_fragment',
    physicalTarget: target,
    ownershipKey: key,
    selectorSchemaVersion: 1,
    risk: 'low',
    reload: spec.reload,
    commandCategory: 'file_write',
    preconditionHash: live.fragmentHash ?? undefined,
    containerPreconditionHash: live.file.containerHash ?? undefined,
    desiredFragmentHash: desiredHash ?? undefined,
    idempotent: true,
    metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
  }
  return { ...base, mutations: [mutation], diagnostics: [] }
}

function planAction(input: {
  remove: boolean
  liveHash: string | null
  desiredHash: string | null
  ownedHash: string | null
}): { kind: 'create' | 'update' | 'remove' | 'noop' } | { kind: 'conflict'; reason: string } {
  if (input.remove) {
    if (input.liveHash === null) return { kind: 'noop' }
    if (input.ownedHash === null || input.liveHash !== input.ownedHash) {
      return { kind: 'conflict', reason: 'remove_requires_exact_owned_fragment' }
    }
    return { kind: 'remove' }
  }
  if (input.liveHash === input.desiredHash) {
    return input.ownedHash === null
      ? { kind: 'conflict', reason: 'matching_selector_has_no_ownership_evidence' }
      : { kind: 'noop' }
  }
  if (input.liveHash === null) return { kind: 'create' }
  if (input.ownedHash === null) return { kind: 'conflict', reason: 'selector_already_occupied' }
  if (input.liveHash !== input.ownedHash) return { kind: 'conflict', reason: 'owned_fragment_modified' }
  return { kind: 'update' }
}

function inspectManagedHooks(
  spec: JsonLifecycleHookHostSpec,
  context: AdapterOperationContext,
  target: string,
): ManagedHookInspection {
  const file = inspectRegularFileWithinRoot(target, context.installation.canonicalConfigRoot)
  if (!file.exists) {
    return {
      file,
      fragment: undefined,
      fragmentHash: null,
      activation: spec.activationMode === 'zcode_explicit_enabled' ? 'missing' : 'enabled',
      complete: false,
      hasUnmanagedEntries: false,
      diagnostics: [],
    }
  }
  const document = readJsonObject(file.canonicalPath, spec.preserveJsonc)
  const activation = inspectActivation(spec, document)
  const eventContainer = getObjectAt(document, spec.eventRoot)
  const fragment: Record<string, JsonValue> = {}
  const diagnostics: string[] = []
  for (const event of spec.events(context)) {
    const candidates = eventContainer?.[event.eventName]
    if (candidates === undefined) continue
    if (!Array.isArray(candidates)) {
      throw new JsonLifecycleHookConflictError(`hook_event_not_array:${event.eventName}`)
    }
    const managed = candidates.filter(candidate => spec.identifiesEntry(event, candidate, context))
    if (managed.length > 1) {
      throw new JsonLifecycleHookConflictError(`duplicate_managed_hook_entries:${event.eventName}`)
    }
    if (managed.length === 1) fragment[event.eventName] = managed[0]
  }
  const expectedCount = spec.events(context).length
  const actualCount = Object.keys(fragment).length
  const hasUnmanagedEntries = eventContainer !== undefined
    && Object.entries(eventContainer).some(([eventName, value]) => {
      if (!Array.isArray(value)) return true
      const managedEvent = spec.events(context).find(event => event.eventName === eventName)
      return managedEvent === undefined
        ? value.length > 0
        : value.some(candidate => !spec.identifiesEntry(managedEvent, candidate, context))
    })
  if (activation === 'explicitly_disabled') diagnostics.push('host_hooks_explicitly_disabled')
  if (actualCount > 0 && actualCount !== expectedCount) diagnostics.push('managed_lifecycle_fragment_partial')
  const value = actualCount === 0 ? undefined : fragment
  return {
    file,
    fragment: value,
    fragmentHash: value === undefined ? null : sha256Json(value),
    activation,
    complete: actualCount === expectedCount,
    hasUnmanagedEntries,
    diagnostics,
  }
}

function mutateManagedHooks(
  spec: JsonLifecycleHookHostSpec,
  context: AdapterOperationContext,
  document: Record<string, JsonValue>,
  remove: boolean,
): void {
  const events = spec.events(context)
  const container = getOrCreateObjectAt(document, spec.eventRoot)
  for (const event of events) {
    const current = container[event.eventName]
    if (current !== undefined && !Array.isArray(current)) {
      throw new JsonLifecycleHookConflictError(`hook_event_not_array:${event.eventName}`)
    }
    const entries = current === undefined ? [] : [...current]
    const matching = entries
      .map((candidate, index) => spec.identifiesEntry(event, candidate, context) ? index : -1)
      .filter(index => index >= 0)
    if (matching.length > 1) {
      throw new JsonLifecycleHookConflictError(`duplicate_managed_hook_entries:${event.eventName}`)
    }
    if (matching.length === 1) entries.splice(matching[0], 1)
    if (!remove) entries.push(event.entry)
    if (entries.length === 0) delete container[event.eventName]
    else container[event.eventName] = entries
  }

  if (!remove && spec.activationMode === 'zcode_explicit_enabled') {
    const hooks = getOrCreateObjectAt(document, ['hooks'])
    if (hooks.enabled === false) throw new JsonLifecycleHookConflictError('host_hooks_explicitly_disabled')
    if (hooks.enabled !== undefined && hooks.enabled !== true) {
      throw new JsonLifecycleHookConflictError('host_hooks_enabled_not_boolean')
    }
    hooks.enabled = true
  }
  // `hooks.enabled: true` is intentionally retained on ZCode disconnect. It is
  // a shared host prerequisite and disabling/removing it could break user hooks.
  pruneEmptyObjectPath(document, spec.eventRoot)
}

function mutateManagedHooksJsonc(
  spec: JsonLifecycleHookHostSpec,
  context: AdapterOperationContext,
  initialSource: string,
  document: Record<string, JsonValue>,
  remove: boolean,
): string {
  if (spec.activationMode !== 'always_enabled') {
    throw new JsonLifecycleHookConflictError('jsonc_activation_mode_unsupported')
  }
  const container = getObjectAt(document, spec.eventRoot)
  let source = initialSource
  for (const event of spec.events(context)) {
    const current = container?.[event.eventName]
    if (current !== undefined && !Array.isArray(current)) {
      throw new JsonLifecycleHookConflictError(`hook_event_not_array:${event.eventName}`)
    }
    const entries = current === undefined ? [] : [...current]
    const matching = entries
      .map((candidate, index) => spec.identifiesEntry(event, candidate, context) ? index : -1)
      .filter(index => index >= 0)
    if (matching.length > 1) {
      throw new JsonLifecycleHookConflictError(`duplicate_managed_hook_entries:${event.eventName}`)
    }
    if (matching.length === 1) entries.splice(matching[0], 1)
    if (!remove) entries.push(event.entry)
    source = modifyJsoncObject(
      source,
      [...spec.eventRoot, event.eventName],
      entries.length === 0 ? undefined : entries,
    )
  }
  return source
}

function desiredFragment(spec: JsonLifecycleHookHostSpec, context: AdapterOperationContext): JsonValue {
  return Object.fromEntries(spec.events(context).map(event => [event.eventName, event.entry]))
}

function inspectActivation(
  spec: JsonLifecycleHookHostSpec,
  document: Record<string, JsonValue>,
): ManagedHookInspection['activation'] {
  if (spec.activationMode === 'always_enabled') return 'enabled'
  if (spec.activationMode === 'qwen_default_enabled') {
    const disabled = document.disableAllHooks
    if (disabled === undefined || disabled === false) return 'enabled'
    if (disabled === true) return 'explicitly_disabled'
    throw new JsonLifecycleHookConflictError('disableAllHooks_not_boolean')
  }
  const hooks = getObjectAt(document, ['hooks'])
  const enabled = hooks?.enabled
  if (enabled === undefined) return 'missing'
  if (enabled === true) return 'enabled'
  if (enabled === false) return 'explicitly_disabled'
  throw new JsonLifecycleHookConflictError('host_hooks_enabled_not_boolean')
}

function qwenCommandEvent(
  context: AdapterOperationContext,
  eventName: LifecycleEventName,
  signalName: ManagedHookEvent['signalName'],
  matcher: string,
  scriptPath: string,
  extraArgs: readonly string[] = [],
): ManagedHookEvent {
  const args = [
    scriptPath,
    '--agent-id', context.agentId,
    ...extraArgs,
    '--tool', 'qwen-code',
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
  ]
  return {
    eventName,
    signalName,
    entry: {
      matcher,
      hooks: [{
        type: 'command',
        command: [context.runtime.shimPath, ...args].map(shellArgument).join(' '),
        name: qwenHookName(context, eventName),
        timeout: 60_000,
      }],
    },
  }
}

function sessionEndScript(context: AdapterOperationContext): string {
  return path.join(path.dirname(context.runtime.hookScriptPath), 'hook-session-end.cjs')
}

function qwenHookName(context: AdapterOperationContext, eventName: LifecycleEventName): string {
  return `tidemind-${context.agentId}-${eventName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`
}

function ownershipKey(spec: JsonLifecycleHookHostSpec, context: AdapterOperationContext): string {
  return `${spec.eventRoot.join('.')}.tidemind-${context.agentId}`
}

function defaultDetected(context: AdapterOperationContext, target: string): boolean {
  const executable = context.installation.distribution.executableRealpath
  return fs.existsSync(context.installation.canonicalConfigRoot)
    || fs.existsSync(target)
    || (executable !== undefined && fs.existsSync(executable))
}

function inspectionResult(
  spec: JsonLifecycleHookHostSpec,
  context: AdapterOperationContext,
  target: string,
  detected: boolean,
  visibility: 'absent' | 'unknown' | undefined,
  diagnostics: string[],
): AdapterInspection {
  return {
    catalogId: spec.catalogId,
    detected,
    distribution: {
      ...context.installation.distribution,
      distributionId: context.installation.distribution.distributionId ?? spec.distributionId,
    },
    components: [{
      componentKey: 'lifecycle',
      visibility: visibility ?? 'absent',
      verificationStatus: 'unverified',
      observedTarget: target,
    }],
    provenance: [target],
    diagnostics,
  }
}

function readJsonObject(filePath: string, allowJsonc = false): Record<string, JsonValue> {
  let parsed: unknown
  try {
    const source = fs.readFileSync(filePath, 'utf8')
    parsed = allowJsonc ? parseJsoncObject(source).root : JSON.parse(source)
  } catch (error) {
    throw new JsonLifecycleHookConflictError(`managed_hook_json_malformed:${errorMessage(error)}`)
  }
  const object = asObject(parsed)
  if (!object) throw new JsonLifecycleHookConflictError('managed_hook_json_root_not_object')
  return object
}

function getObjectAt(
  root: Record<string, JsonValue>,
  selector: readonly string[],
): Record<string, JsonValue> | undefined {
  let current: Record<string, JsonValue> = root
  for (const key of selector) {
    const child = current[key]
    if (child === undefined) return undefined
    const object = asObject(child)
    if (!object) throw new JsonLifecycleHookConflictError(`hook_selector_parent_not_object:${key}`)
    current = object
  }
  return current
}

function getOrCreateObjectAt(
  root: Record<string, JsonValue>,
  selector: readonly string[],
): Record<string, JsonValue> {
  let current = root
  for (const key of selector) {
    const child = current[key]
    if (child === undefined) {
      const created: Record<string, JsonValue> = {}
      current[key] = created
      current = created
      continue
    }
    const object = asObject(child)
    if (!object) throw new JsonLifecycleHookConflictError(`hook_selector_parent_not_object:${key}`)
    current = object
  }
  return current
}

function pruneEmptyObjectPath(root: Record<string, JsonValue>, selector: readonly string[]): void {
  const parents: Array<{ parent: Record<string, JsonValue>; key: string }> = []
  let current = root
  for (const key of selector) {
    const child = asObject(current[key])
    if (!child) return
    parents.push({ parent: current, key })
    current = child
  }
  for (const { parent, key } of parents.reverse()) {
    const child = asObject(parent[key])
    if (child && Object.keys(child).length === 0) delete parent[key]
    else break
  }
}

function hasExactArgument(args: readonly JsonValue[], flag: string, expected: string): boolean {
  const index = args.findIndex(value => value === flag)
  return index >= 0 && args[index + 1] === expected
}

function asObject(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}

function parseMetadata(mutation: PlannedMutation): JsonLifecycleHookMetadata {
  const value = mutation.metadata as unknown as Partial<JsonLifecycleHookMetadata> | undefined
  if (!value
    || typeof value.canonicalPath !== 'string'
    || (value.containerPreconditionHash !== null && typeof value.containerPreconditionHash !== 'string')
    || (value.liveFragmentHash !== null && typeof value.liveFragmentHash !== 'string')
    || (value.ownedFragmentHash !== null && typeof value.ownedFragmentHash !== 'string')
    || typeof value.remove !== 'boolean') {
    throw new Error(`Invalid JSON lifecycle mutation metadata: ${mutation.operationId}`)
  }
  return value as JsonLifecycleHookMetadata
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
