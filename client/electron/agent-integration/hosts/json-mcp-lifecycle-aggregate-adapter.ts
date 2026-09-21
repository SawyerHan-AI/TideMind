import fs from 'node:fs'
import path from 'node:path'
import { sha256Json } from '../fingerprint'
import { inspectJsonProjection } from '../json-projection'
import {
  ensureSafeParentDirectoryWithinRoot,
  inspectRegularFileWithinRoot,
  writeRegularFileAtomicCas,
  type FileFingerprint,
} from '../safe-file'
import {
  createJsonLifecycleHookHostAdapter,
  QWEN_CODE_LIFECYCLE_SPEC,
  ZCODE_DESKTOP_LIFECYCLE_SPEC,
  type JsonLifecycleHookHostSpec,
} from './json-lifecycle-hook-adapter'
import { createJsonMcpHostAdapter, type JsonMcpHostSpec } from './json-mcp-adapter'
import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AgentHostAdapter,
  CatalogId,
  ComponentKey,
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../types'

interface AggregateSpec {
  catalogId: Extract<CatalogId, 'qwen-code-cli' | 'zcode-desktop'>
  adapterVersion: string
  lifecycle: JsonLifecycleHookHostSpec
  mcp: JsonMcpHostSpec
}

interface AggregateFragment {
  memory_tools?: JsonValue
  lifecycle?: JsonValue
}

interface AggregateInspection {
  file: FileFingerprint
  fragment: AggregateFragment | undefined
  fragmentHash: string | null
  memoryFragment: JsonValue | undefined
  lifecycleFragment: JsonValue | undefined
  activation: 'enabled' | 'missing' | 'explicitly_disabled'
  lifecycleComplete: boolean
  hasUnmanagedHooks: boolean
  unmanagedHookCount: number
  diagnostics: string[]
}

interface AggregateMetadata {
  canonicalPath: string
  containerPreconditionHash: string | null
  liveFragmentHash: string | null
  ownedFragmentHash: string | null
  activationOwnership: ActivationOwnership
  retainSharedActivationOnRemove: boolean
  desiredFragment?: AggregateFragment
  remove: boolean
}

type ActivationOwnership = 'not_applicable' | 'owned' | 'borrowed'

interface AggregateBaseline {
  ownedFragmentHash: string
  ownershipKey: string
  activationOwnership: ActivationOwnership
}

const COMPONENTS = ['memory_tools', 'lifecycle'] as const satisfies readonly ComponentKey[]

/**
 * Qwen Code and ZCode store MCP and lifecycle hooks in the same host-owned
 * JSON document. This Adapter deliberately performs one read/modify/CAS/write
 * and represents the two logical components with one aggregate Artifact.
 */
export function createJsonMcpLifecycleAggregateAdapter(spec: AggregateSpec): AgentHostAdapter {
  const mcpAdapter = createJsonMcpHostAdapter(spec.mcp)
  const lifecycleAdapter = createJsonLifecycleHookHostAdapter(spec.lifecycle)

  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const target = configFile(spec, context)
    const detected = defaultDetected(context, target)
    if (!detected) {
      return {
        catalogId: spec.catalogId,
        detected: false,
        distribution: { ...context.installation.distribution },
        components: COMPONENTS.map(componentKey => ({
          componentKey,
          visibility: 'absent',
          verificationStatus: 'unverified',
          observedTarget: target,
        })),
        provenance: [target],
        diagnostics: ['host_not_detected_or_projection_format_unsupported'],
      }
    }
    try {
      const current = inspectAggregate(spec, context)
      const desired = desiredAggregate(spec, context)
      const mcpGate = spec.mcp.activationGate?.(context, mcpSelector(spec, context).at(-1)!)
      const memoryExact = current.memoryFragment !== undefined
        && sha256Json(current.memoryFragment) === sha256Json(desired.memory_tools)
        && (mcpGate?.allowed ?? true)
      const lifecycleExact = current.lifecycleFragment !== undefined
        && sha256Json(current.lifecycleFragment) === sha256Json(desired.lifecycle)
        && current.lifecycleComplete
        && current.activation === 'enabled'
      return {
        catalogId: spec.catalogId,
        detected: true,
        distribution: { ...context.installation.distribution },
        components: [
          {
            componentKey: 'memory_tools',
            visibility: current.memoryFragment === undefined ? 'absent' : memoryExact ? 'dedicated' : 'unknown',
            verificationStatus: 'unverified',
            observedTarget: current.file.canonicalPath,
            observedFragmentHash: current.memoryFragment === undefined
              ? undefined
              : sha256Json(current.memoryFragment),
          },
          {
            componentKey: 'lifecycle',
            visibility: current.lifecycleFragment === undefined
              ? 'absent'
              : lifecycleExact ? 'dedicated' : 'shared_visible',
            verificationStatus: 'unverified',
            observedTarget: current.file.canonicalPath,
            observedFragmentHash: current.lifecycleFragment === undefined
              ? undefined
              : sha256Json(current.lifecycleFragment),
            details: {
              activation: current.activation,
              hasUnmanagedEntries: current.hasUnmanagedHooks,
            },
          },
        ],
        provenance: [target],
        diagnostics: mcpGate && !mcpGate.allowed
          ? [...current.diagnostics, mcpGate.diagnostic ?? 'mcp_server_not_active_by_host_policy']
          : current.diagnostics,
      }
    } catch (error) {
      return {
        catalogId: spec.catalogId,
        detected: true,
        distribution: { ...context.installation.distribution },
        components: COMPONENTS.map(componentKey => ({
          componentKey,
          visibility: 'unknown',
          verificationStatus: 'unverified',
          observedTarget: target,
        })),
        provenance: [target],
        diagnostics: [errorMessage(error)],
      }
    }
  }

  const buildPlan = (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    remove: boolean,
  ): AdapterPlan => {
    const base: Omit<AdapterPlan, 'mutations' | 'diagnostics' | 'requiredUserActions'> = {
      catalogId: spec.catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
    }
    const requested = COMPONENTS.filter(component => request.desiredComponents.includes(component))
    if (requested.length !== COMPONENTS.length) {
      return {
        ...base,
        requiredUserActions: [],
        mutations: [],
        diagnostics: ['aggregate_projection_requires_memory_tools_and_lifecycle'],
      }
    }
    if (!request.observed.detected) {
      return { ...base, requiredUserActions: [], mutations: [], diagnostics: ['host_not_detected_or_projection_format_unsupported'] }
    }

    let live: AggregateInspection
    try {
      live = inspectAggregate(spec, context)
    } catch (error) {
      return { ...base, requiredUserActions: [], mutations: [], diagnostics: [errorMessage(error)] }
    }
    if (!remove && live.activation === 'explicitly_disabled') {
      return { ...base, requiredUserActions: [], mutations: [], diagnostics: ['host_hooks_explicitly_disabled'] }
    }
    if (!remove) {
      let gate: ReturnType<NonNullable<JsonMcpHostSpec['activationGate']>> | undefined
      try {
        gate = spec.mcp.activationGate?.(context, mcpSelector(spec, context).at(-1)!)
      } catch (error) {
        return { ...base, requiredUserActions: [], mutations: [], diagnostics: [errorMessage(error)] }
      }
      if (gate && !gate.allowed) {
        return {
          ...base,
          requiredUserActions: gate.requiredUserAction ? [gate.requiredUserAction] : [],
          requiredUserActionDetails: gate.requiredUserActionDetail ? [gate.requiredUserActionDetail] : [],
          mutations: [],
          diagnostics: [gate.diagnostic ?? 'mcp_server_not_active_by_host_policy'],
        }
      }
    }
    const target = configFile(spec, context)
    const aggregateBaseline = exactAggregateBaseline(spec, context, request.ownedArtifacts, target)
    const legacyBaseline = legacyMcpBaseline(spec, context, request.ownedArtifacts, target)
    const relevantBaselines = request.ownedArtifacts.filter(artifact =>
      COMPONENTS.includes(artifact.componentKey as typeof COMPONENTS[number])
        && path.resolve(artifact.physicalTarget) === path.resolve(target),
    )
    if (aggregateBaseline === null && relevantBaselines.length > 0 && legacyBaseline === undefined) {
      return { ...base, requiredUserActions: [], mutations: [], diagnostics: ['aggregate_ownership_baselines_incomplete'] }
    }
    if (aggregateBaseline !== null && legacyBaseline !== undefined) {
      return { ...base, requiredUserActions: [], mutations: [], diagnostics: ['aggregate_and_legacy_ownership_overlap'] }
    }
    if (!remove
      && aggregateBaseline?.activationOwnership === 'borrowed'
      && live.activation !== 'enabled') {
      return { ...base, requiredUserActions: [], mutations: [], diagnostics: ['zcode_borrowed_hook_activation_changed'] }
    }
    if (remove
      && aggregateBaseline?.activationOwnership === 'owned'
      && live.activation === 'explicitly_disabled') {
      return { ...base, requiredUserActions: [], mutations: [], diagnostics: ['zcode_owned_hook_activation_modified'] }
    }

    const activationOwnership = aggregateBaseline?.activationOwnership
      ?? activationOwnershipForLive(spec, live)
    const key = aggregateOwnershipKey(spec, context, activationOwnership)
    const needsSharedActivationConfirmation = !remove
      && spec.catalogId === 'zcode-desktop'
      && live.activation === 'missing'
      && live.hasUnmanagedHooks
    const retainSharedActivationOnRemove = remove
      && spec.catalogId === 'zcode-desktop'
      && aggregateBaseline?.activationOwnership === 'owned'
      && live.hasUnmanagedHooks
    const requiredUserActions = needsSharedActivationConfirmation
      ? [`confirm_enable_existing_zcode_hooks:${live.unmanagedHookCount}`]
      : []

    const desired = remove ? undefined : desiredAggregate(spec, context)
    const desiredHash = desired === undefined ? null : sha256Json(desired)
    const legacyTransfer = !remove && aggregateBaseline === null && legacyBaseline !== undefined
    if (legacyTransfer) {
      const liveMemoryHash = live.memoryFragment === undefined ? null : sha256Json(live.memoryFragment)
      if (liveMemoryHash !== legacyBaseline.ownedFragmentHash) {
        return { ...base, requiredUserActions, mutations: [], diagnostics: ['legacy_owned_mcp_fragment_modified'] }
      }
      if (live.lifecycleFragment !== undefined) {
        return { ...base, requiredUserActions, mutations: [], diagnostics: ['legacy_mcp_upgrade_lifecycle_already_occupied'] }
      }
    }
    const action = planAction({
      remove,
      liveHash: live.fragmentHash,
      desiredHash,
      ownedHash: aggregateBaseline?.ownedFragmentHash ?? (legacyTransfer ? live.fragmentHash : null),
      forceUpdate: !remove
        && spec.catalogId === 'zcode-desktop'
        && aggregateBaseline?.activationOwnership === 'owned'
        && live.activation === 'missing',
    })
    if (action.kind === 'conflict') {
      return { ...base, requiredUserActions, mutations: [], diagnostics: [action.reason] }
    }
    if (action.kind === 'noop') return { ...base, requiredUserActions, mutations: [], diagnostics: [] }

    const metadata: AggregateMetadata = {
      canonicalPath: live.file.canonicalPath,
      containerPreconditionHash: live.file.containerHash,
      liveFragmentHash: live.fragmentHash,
      ownedFragmentHash: aggregateBaseline?.ownedFragmentHash ?? null,
      activationOwnership,
      retainSharedActivationOnRemove,
      remove,
      ...(desired === undefined ? {} : { desiredFragment: desired }),
    }
    const mutation: PlannedMutation = {
      operationId: `${context.operationId}:memory_tools+lifecycle`,
      componentKey: 'memory_tools',
      coveredComponentKeys: COMPONENTS,
      operation: action.kind,
      domainKind: 'file_fragment',
      physicalTarget: target,
      ownershipKey: key,
      selectorSchemaVersion: 1,
      ownershipTransferFrom: legacyTransfer ? {
        physicalTarget: legacyBaseline.physicalTarget,
        ownershipKey: legacyBaseline.ownershipKey,
        ownedFragmentHash: legacyBaseline.ownedFragmentHash,
        selectorSchemaVersion: legacyBaseline.selectorSchemaVersion ?? 1,
      } : undefined,
      risk: needsSharedActivationConfirmation ? 'elevated' : 'low',
      reload: 'new_session',
      commandCategory: 'file_write',
      preconditionHash: live.fragmentHash ?? undefined,
      containerPreconditionHash: live.file.containerHash ?? undefined,
      desiredFragmentHash: desiredHash ?? undefined,
      idempotent: true,
      metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
    }
    return { ...base, requiredUserActions, mutations: [mutation], diagnostics: [] }
  }

  return {
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    componentKeys: COMPONENTS,
    implementationTypes: { memory_tools: ['mcp'], lifecycle: ['hook'] },
    componentContracts: {
      memory_tools: { deliveryMode: 'managed', artifactTypes: ['mcp'], mutationDomain: 'file_fragment', reload: 'new_session' },
      lifecycle: { deliveryMode: 'managed', artifactTypes: ['hook'], mutationDomain: 'file_fragment', reload: 'new_session' },
    },
    inspect,
    // Legacy 0.2.91 installations owned only the MCP selector. Expose that
    // exact, identity-bound observation so the migration layer can preserve
    // the old Agent ID and Ledger baseline before this Adapter atomically
    // upgrades MCP + lifecycle into one aggregate artifact.
    inspectAdoptableArtifacts: context => mcpAdapter.inspectAdoptableArtifacts!(context),
    plan: (context, request) => Promise.resolve(buildPlan(context, request, false)),
    disconnect: (context, request) => Promise.resolve(buildPlan(context, {
      desiredCapability: 0,
      desiredComponents: request.componentKeys,
      observed: request.observed,
      ownedArtifacts: request.ownedArtifacts,
    }, true)),
    async apply(context, mutation) {
      assertAggregateMutation(mutation)
      const metadata = parseMetadata(mutation)
      const before = inspectAggregate(spec, context)
      if (before.file.canonicalPath !== metadata.canonicalPath) throw new Error('aggregate_canonical_path_changed')
      if (before.file.containerHash !== metadata.containerPreconditionHash) throw new Error('aggregate_container_precondition_changed')
      if (before.fragmentHash !== metadata.liveFragmentHash) throw new Error('aggregate_fragment_precondition_changed')
      if (!metadata.remove && before.activation === 'explicitly_disabled') throw new Error('host_hooks_explicitly_disabled')

      const document = before.file.exists ? readJsonObject(before.file.canonicalPath) : {}
      mutateMcp(spec, context, document, metadata.remove)
      mutateLifecycle(
        spec,
        context,
        document,
        metadata.remove,
        metadata.activationOwnership,
        metadata.retainSharedActivationOnRemove,
      )
      ensureSafeParentDirectoryWithinRoot(mutation.physicalTarget, context.installation.canonicalConfigRoot)
      writeRegularFileAtomicCas(mutation.physicalTarget, `${JSON.stringify(document, null, 2)}\n`, {
        expectedCanonicalPath: metadata.canonicalPath,
        expectedContainerHash: metadata.containerPreconditionHash,
      })
      const after = inspectAggregate(spec, context)
      const expectedHash = metadata.remove ? null : mutation.desiredFragmentHash ?? null
      if (after.fragmentHash !== expectedHash || !activationMatches(after, metadata)) {
        throw new Error('aggregate_read_back_mismatch')
      }
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: after.fragmentHash ?? undefined,
        hostReceipt: {
          canonicalPath: after.file.canonicalPath,
          containerHash: after.file.containerHash,
          coveredComponentKeys: [...COMPONENTS],
        },
      }
    },
    async readBack(context, mutation): Promise<MutationReadBack> {
      try {
        assertAggregateMutation(mutation)
        const metadata = parseMetadata(mutation)
        const current = inspectAggregate(spec, context)
        const expectedHash = metadata.remove ? null : mutation.desiredFragmentHash ?? null
        return {
          operationId: mutation.operationId,
          observed: current.fragment !== undefined,
          matchesDesired: current.fragmentHash === expectedHash
            && activationMatches(current, metadata),
          observedFragmentHash: current.fragmentHash ?? undefined,
          visibility: current.fragment === undefined
            ? 'absent'
            : current.fragmentHash === expectedHash ? 'dedicated' : 'shared_visible',
          diagnostics: current.diagnostics,
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
    verify: async (context, request) => (await Promise.all([
      mcpAdapter.verify(context, request),
      lifecycleAdapter.verify(context, request),
    ])).flat(),
  }
}

const QWEN_AGGREGATE_SPEC: AggregateSpec = {
  catalogId: 'qwen-code-cli',
  adapterVersion: '2',
  lifecycle: QWEN_CODE_LIFECYCLE_SPEC,
  mcp: {
    catalogId: 'qwen-code-cli',
    adapterVersion: '2',
    configFile: context => context.installation.componentConfigFiles?.memory_tools
      ?? path.join(context.installation.canonicalConfigRoot, 'settings.json'),
    selectorRoot: ['mcpServers'],
    reload: 'new_session',
    activationGate: qwenMcpActivationGate,
  },
}

const ZCODE_AGGREGATE_SPEC: AggregateSpec = {
  catalogId: 'zcode-desktop',
  adapterVersion: '2',
  lifecycle: ZCODE_DESKTOP_LIFECYCLE_SPEC,
  mcp: {
    catalogId: 'zcode-desktop',
    adapterVersion: '2',
    configFile: context => context.installation.componentConfigFiles?.memory_tools
      ?? path.join(context.installation.canonicalConfigRoot, 'config.json'),
    selectorRoot: ['mcp', 'servers'],
    reload: 'new_session',
  },
}

export function createQwenCodeJsonAggregateAdapter(): AgentHostAdapter {
  return createJsonMcpLifecycleAggregateAdapter(QWEN_AGGREGATE_SPEC)
}

export function createZCodeDesktopJsonAggregateAdapter(): AgentHostAdapter {
  return createJsonMcpLifecycleAggregateAdapter(ZCODE_AGGREGATE_SPEC)
}

function configFile(spec: AggregateSpec, context: AdapterOperationContext): string {
  const mcpTarget = path.resolve(spec.mcp.configFile(context))
  const lifecycleTarget = path.resolve(spec.lifecycle.configFile(context))
  if (mcpTarget !== lifecycleTarget) throw new Error('aggregate_component_targets_differ')
  return mcpTarget
}

function inspectAggregate(spec: AggregateSpec, context: AdapterOperationContext): AggregateInspection {
  const target = configFile(spec, context)
  const file = inspectRegularFileWithinRoot(target, context.installation.canonicalConfigRoot)
  if (!file.exists) {
    return {
      file,
      fragment: undefined,
      fragmentHash: null,
      memoryFragment: undefined,
      lifecycleFragment: undefined,
      activation: spec.catalogId === 'zcode-desktop' ? 'missing' : 'enabled',
      lifecycleComplete: false,
      hasUnmanagedHooks: false,
      unmanagedHookCount: 0,
      diagnostics: [],
    }
  }
  const document = readJsonObject(file.canonicalPath)
  const memoryFragment = valueAt(document, mcpSelector(spec, context))
  const lifecycleContainer = objectAt(document, spec.lifecycle.eventRoot)
  const lifecycle: Record<string, JsonValue> = {}
  const diagnostics: string[] = []
  for (const event of spec.lifecycle.events(context)) {
    const candidates = lifecycleContainer?.[event.eventName]
    if (candidates === undefined) continue
    if (!Array.isArray(candidates)) throw new Error(`hook_event_not_array:${event.eventName}`)
    const managed = candidates.filter(candidate => spec.lifecycle.identifiesEntry(event, candidate, context))
    if (managed.length > 1) throw new Error(`duplicate_managed_hook_entries:${event.eventName}`)
    if (managed.length === 1) lifecycle[event.eventName] = managed[0]
  }
  const lifecycleFragment = Object.keys(lifecycle).length === 0 ? undefined : lifecycle
  const lifecycleComplete = Object.keys(lifecycle).length === spec.lifecycle.events(context).length
  if (lifecycleFragment !== undefined && !lifecycleComplete) diagnostics.push('managed_lifecycle_fragment_partial')
  const activation = inspectActivation(spec, document)
  if (activation === 'explicitly_disabled') diagnostics.push('host_hooks_explicitly_disabled')
  const unmanagedHookCount = lifecycleContainer === undefined
    ? 0
    : Object.entries(lifecycleContainer).reduce((count, [eventName, value]) => {
        if (!Array.isArray(value)) return count + 1
        const event = spec.lifecycle.events(context).find(candidate => candidate.eventName === eventName)
        return count + (event === undefined
          ? value.length
          : value.filter(candidate => !spec.lifecycle.identifiesEntry(event, candidate, context)).length)
      }, 0)
  const hasUnmanagedHooks = unmanagedHookCount > 0
  const fragment: AggregateFragment = {
    ...(memoryFragment === undefined ? {} : { memory_tools: memoryFragment }),
    ...(lifecycleFragment === undefined ? {} : { lifecycle: lifecycleFragment }),
  }
  const present = Object.keys(fragment).length > 0
  return {
    file,
    fragment: present ? fragment : undefined,
    fragmentHash: present ? sha256Json(fragment) : null,
    memoryFragment,
    lifecycleFragment,
    activation,
    lifecycleComplete,
    hasUnmanagedHooks,
    unmanagedHookCount,
    diagnostics,
  }
}

function desiredAggregate(spec: AggregateSpec, context: AdapterOperationContext): AggregateFragment {
  return {
    memory_tools: mcpEntry(context),
    lifecycle: Object.fromEntries(spec.lifecycle.events(context).map(event => [event.eventName, event.entry])),
  }
}

function mcpEntry(context: AdapterOperationContext): JsonValue {
  return {
    command: context.runtime.shimPath,
    args: [context.runtime.mcpServerPath],
    env: {
      EB_AGENT_ID: context.agentId,
      EB_HOST_VARIANT: context.installation.hostVariant,
      ...(context.activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken } : {}),
    },
  }
}

function mcpSelector(spec: AggregateSpec, context: AdapterOperationContext): readonly string[] {
  return [...(spec.mcp.selectorRoot ?? ['mcpServers']), `tidemind-${context.agentId}`]
}

function mutateMcp(
  spec: AggregateSpec,
  context: AdapterOperationContext,
  document: Record<string, JsonValue>,
  remove: boolean,
): void {
  const selector = mcpSelector(spec, context)
  const parent = objectAtOrCreate(document, selector.slice(0, -1))
  const key = selector.at(-1)!
  if (remove) delete parent[key]
  else parent[key] = mcpEntry(context)
  pruneEmpty(document, selector.slice(0, -1))
}

function mutateLifecycle(
  spec: AggregateSpec,
  context: AdapterOperationContext,
  document: Record<string, JsonValue>,
  remove: boolean,
  activationOwnership: ActivationOwnership,
  retainSharedActivationOnRemove: boolean,
): void {
  const container = objectAtOrCreate(document, spec.lifecycle.eventRoot)
  for (const event of spec.lifecycle.events(context)) {
    const value = container[event.eventName]
    if (value !== undefined && !Array.isArray(value)) throw new Error(`hook_event_not_array:${event.eventName}`)
    const entries = value === undefined ? [] : [...value]
    const matches = entries
      .map((candidate, index) => spec.lifecycle.identifiesEntry(event, candidate, context) ? index : -1)
      .filter(index => index >= 0)
    if (matches.length > 1) throw new Error(`duplicate_managed_hook_entries:${event.eventName}`)
    if (matches.length === 1) entries.splice(matches[0], 1)
    if (!remove) entries.push(event.entry)
    if (entries.length === 0) delete container[event.eventName]
    else container[event.eventName] = entries
  }
  if (spec.catalogId === 'zcode-desktop') {
    const hooks = objectAtOrCreate(document, ['hooks'])
    if (!remove) {
      if (hooks.enabled === false) throw new Error('host_hooks_explicitly_disabled')
      if (hooks.enabled !== undefined && hooks.enabled !== true) throw new Error('host_hooks_enabled_not_boolean')
      if (activationOwnership === 'borrowed') {
        if (hooks.enabled !== true) throw new Error('zcode_borrowed_hook_activation_changed')
      } else if (activationOwnership === 'owned') {
        hooks.enabled = true
      } else {
        throw new Error('zcode_activation_ownership_missing')
      }
    } else if (activationOwnership === 'owned') {
      if (hooks.enabled === false) throw new Error('zcode_owned_hook_activation_modified')
      if (hooks.enabled !== undefined && hooks.enabled !== true) throw new Error('host_hooks_enabled_not_boolean')
      if (retainSharedActivationOnRemove) hooks.enabled = true
      else delete hooks.enabled
    }
  }
  pruneEmpty(document, spec.lifecycle.eventRoot)
  pruneEmpty(document, ['hooks'])
}

function planAction(input: {
  remove: boolean
  liveHash: string | null
  desiredHash: string | null
  ownedHash: string | null
  forceUpdate?: boolean
}): { kind: 'create' | 'update' | 'remove' | 'noop' } | { kind: 'conflict'; reason: string } {
  if (input.remove) {
    if (input.liveHash === null) return { kind: 'noop' }
    if (input.ownedHash === null || input.liveHash !== input.ownedHash) {
      return { kind: 'conflict', reason: 'remove_requires_exact_aggregate_ownership' }
    }
    return { kind: 'remove' }
  }
  if (input.liveHash === input.desiredHash) {
    return input.ownedHash === input.liveHash
      ? input.forceUpdate ? { kind: 'update' } : { kind: 'noop' }
      : { kind: 'conflict', reason: 'matching_aggregate_has_no_ownership_evidence' }
  }
  if (input.liveHash === null) {
    return { kind: 'create' }
  }
  if (input.ownedHash === null) return { kind: 'conflict', reason: 'aggregate_selector_partially_occupied' }
  if (input.liveHash !== input.ownedHash) return { kind: 'conflict', reason: 'owned_aggregate_fragment_modified' }
  return { kind: 'update' }
}

function exactAggregateBaseline(
  spec: AggregateSpec,
  context: AdapterOperationContext,
  baselines: readonly OwnedArtifactBaseline[],
  target: string,
): AggregateBaseline | null {
  for (const activationOwnership of activationOwnershipModes(spec)) {
    const ownershipKey = aggregateOwnershipKey(spec, context, activationOwnership)
    const matches = COMPONENTS.map(componentKey => ownedBaseline(
      baselines,
      componentKey,
      target,
      ownershipKey,
    ))
    if (matches.every(Boolean)) {
      const hashes = new Set(matches.map(value => value!.ownedFragmentHash))
      if (hashes.size === 1) {
        return { ownedFragmentHash: matches[0]!.ownedFragmentHash, ownershipKey, activationOwnership }
      }
    }
  }
  return null
}

function ownedBaseline(
  baselines: readonly OwnedArtifactBaseline[],
  componentKey: ComponentKey,
  target: string,
  ownershipKey: string,
): OwnedArtifactBaseline | undefined {
  return baselines.find(baseline => baseline.componentKey === componentKey
    && path.resolve(baseline.physicalTarget) === path.resolve(target)
    && baseline.ownershipKey === ownershipKey)
}

function aggregateOwnershipKey(
  spec: AggregateSpec,
  context: AdapterOperationContext,
  activationOwnership: ActivationOwnership,
): string {
  const base = `tidemind.aggregate.${spec.catalogId}.${context.agentId}`
  return spec.catalogId === 'zcode-desktop' ? `${base}.activation-${activationOwnership}` : base
}

function activationOwnershipModes(spec: AggregateSpec): readonly ActivationOwnership[] {
  return spec.catalogId === 'zcode-desktop' ? ['owned', 'borrowed'] : ['not_applicable']
}

function activationOwnershipForLive(
  spec: AggregateSpec,
  live: AggregateInspection,
): ActivationOwnership {
  if (spec.catalogId !== 'zcode-desktop') return 'not_applicable'
  return live.activation === 'enabled' ? 'borrowed' : 'owned'
}

function legacyMcpBaseline(
  spec: AggregateSpec,
  context: AdapterOperationContext,
  baselines: readonly OwnedArtifactBaseline[],
  target: string,
): OwnedArtifactBaseline | undefined {
  const ownershipKey = mcpSelector(spec, context).join('.')
  return baselines.find(baseline => baseline.componentKey === 'memory_tools'
    && path.resolve(baseline.physicalTarget) === path.resolve(target)
    && baseline.ownershipKey === ownershipKey
    && (baseline.selectorSchemaVersion ?? 1) === 1)
}

function activationMatches(current: AggregateInspection, metadata: AggregateMetadata): boolean {
  if (metadata.activationOwnership === 'not_applicable') return true
  if (!metadata.remove) return current.activation === 'enabled'
  return metadata.activationOwnership === 'owned'
    ? metadata.retainSharedActivationOnRemove
      ? current.activation === 'enabled'
      : current.activation === 'missing'
    : true
}

function inspectActivation(
  spec: AggregateSpec,
  document: Record<string, JsonValue>,
): AggregateInspection['activation'] {
  if (spec.catalogId === 'qwen-code-cli') {
    const disabled = document.disableAllHooks
    if (disabled === undefined || disabled === false) return 'enabled'
    if (disabled === true) return 'explicitly_disabled'
    throw new Error('disableAllHooks_not_boolean')
  }
  const enabled = objectAt(document, ['hooks'])?.enabled
  if (enabled === undefined) return 'missing'
  if (enabled === true) return 'enabled'
  if (enabled === false) return 'explicitly_disabled'
  throw new Error('host_hooks_enabled_not_boolean')
}

function parseMetadata(mutation: PlannedMutation): AggregateMetadata {
  const value = mutation.metadata as unknown as Partial<AggregateMetadata> | undefined
  if (!value
    || typeof value.canonicalPath !== 'string'
    || (value.containerPreconditionHash !== null && typeof value.containerPreconditionHash !== 'string')
    || (value.liveFragmentHash !== null && typeof value.liveFragmentHash !== 'string')
    || (value.ownedFragmentHash !== null && typeof value.ownedFragmentHash !== 'string')
    || !['not_applicable', 'owned', 'borrowed'].includes(value.activationOwnership ?? '')
    || typeof value.retainSharedActivationOnRemove !== 'boolean'
    || typeof value.remove !== 'boolean') {
    throw new Error(`invalid_aggregate_mutation_metadata:${mutation.operationId}`)
  }
  return value as AggregateMetadata
}

function qwenMcpActivationGate(
  context: AdapterOperationContext,
  serverName: string,
): ReturnType<NonNullable<JsonMcpHostSpec['activationGate']>> {
  const configPath = context.installation.componentConfigFiles?.memory_tools
    ?? path.join(context.installation.canonicalConfigRoot, 'settings.json')
  const excluded = inspectJsonProjection(
    configPath,
    ['mcp', 'excluded'],
    context.installation.canonicalConfigRoot,
  )
  const allowed = inspectJsonProjection(
    configPath,
    ['mcp', 'allowed'],
    context.installation.canonicalConfigRoot,
  )
  const invalidPolicy = [excluded, allowed].some(projection => projection.fragmentExists
    && (!Array.isArray(projection.fragment)
      || !projection.fragment.every(value => typeof value === 'string')))
  if (invalidPolicy) {
    return {
      allowed: false,
      diagnostic: 'qwen_mcp_activation_policy_invalid',
      requiredUserAction: `review_qwen_mcp_activation_policy:${serverName}`,
      requiredUserActionDetail: {
        kind: 'mcp_activation',
        componentKey: 'memory_tools',
        operation: 'connect',
        hostVariant: 'qwen-code-cli',
        serverName,
        configPath,
        reason: 'invalid_policy',
        instruction: `Review mcp.allowed and mcp.excluded in ${configPath}, allow ${serverName}, then recheck the connection.`,
      },
    }
  }
  const excludedPatterns = excluded.fragmentExists ? excluded.fragment as string[] : []
  const allowedPatterns = allowed.fragmentExists ? allowed.fragment as string[] : undefined
  if (excludedPatterns.some(pattern => matchesHostGlob(pattern, serverName))) {
    return {
      allowed: false,
      diagnostic: 'qwen_mcp_server_explicitly_excluded',
      requiredUserAction: `remove_qwen_mcp_exclusion:${serverName}`,
      requiredUserActionDetail: {
        kind: 'mcp_activation',
        componentKey: 'memory_tools',
        operation: 'connect',
        hostVariant: 'qwen-code-cli',
        serverName,
        configPath,
        reason: 'excluded',
        instruction: `Remove the rule excluding ${serverName} from mcp.excluded in ${configPath}, then recheck the connection.`,
      },
    }
  }
  if (allowedPatterns !== undefined
    && !allowedPatterns.some(pattern => matchesHostGlob(pattern, serverName))) {
    return {
      allowed: false,
      diagnostic: 'qwen_mcp_server_not_allowed',
      requiredUserAction: `allow_qwen_mcp_server:${serverName}`,
      requiredUserActionDetail: {
        kind: 'mcp_activation',
        componentKey: 'memory_tools',
        operation: 'connect',
        hostVariant: 'qwen-code-cli',
        serverName,
        configPath,
        reason: 'not_allowed',
        instruction: `Add ${serverName} to mcp.allowed in ${configPath}, then recheck the connection.`,
      },
    }
  }
  return { allowed: true }
}

function matchesHostGlob(pattern: string, value: string): boolean {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`, 'u').test(value)
}

function assertAggregateMutation(mutation: PlannedMutation): void {
  if (!['create', 'update', 'remove'].includes(mutation.operation)) {
    throw new Error(`unsupported_aggregate_mutation:${mutation.operation}`)
  }
  if (sha256Json([...(mutation.coveredComponentKeys ?? [])].sort()) !== sha256Json([...COMPONENTS].sort())) {
    throw new Error('aggregate_component_coverage_changed')
  }
}

function readJsonObject(filePath: string): Record<string, JsonValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`managed_json_malformed:${errorMessage(error)}`, { cause: error })
  }
  const object = asObject(parsed)
  if (!object) throw new Error('managed_json_root_not_object')
  return object
}

function valueAt(root: Record<string, JsonValue>, selector: readonly string[]): JsonValue | undefined {
  let current: JsonValue = root
  for (const key of selector) {
    const object = asObject(current)
    if (!object) throw new Error(`selector_parent_not_object:${key}`)
    current = object[key]
    if (current === undefined) return undefined
  }
  return current
}

function objectAt(
  root: Record<string, JsonValue>,
  selector: readonly string[],
): Record<string, JsonValue> | undefined {
  const value = valueAt(root, selector)
  if (value === undefined) return undefined
  const object = asObject(value)
  if (!object) throw new Error(`selector_not_object:${selector.join('.')}`)
  return object
}

function objectAtOrCreate(
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
    if (!object) throw new Error(`selector_parent_not_object:${key}`)
    current = object
  }
  return current
}

function pruneEmpty(root: Record<string, JsonValue>, selector: readonly string[]): void {
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

function asObject(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}

function defaultDetected(context: AdapterOperationContext, target: string): boolean {
  const executable = context.installation.distribution.executableRealpath
  return fs.existsSync(context.installation.canonicalConfigRoot)
    || fs.existsSync(target)
    || Boolean(executable && fs.existsSync(executable))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
