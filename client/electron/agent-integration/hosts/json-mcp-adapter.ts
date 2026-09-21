import fs from 'node:fs'
import path from 'node:path'
import {
  applyJsonProjection,
  applyJsonProjectionMove,
  inspectJsonProjection,
  planJsonProjection,
  type JsonProjectionPlan,
  type JsonSelector,
} from '../json-projection'
import { sha256Json } from '../fingerprint'
import { verifyMemoryReadWriteActivity } from '../host-activity-evidence'
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
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
  RequiredUserActionDetail,
  ReloadRequirement,
} from '../types'

interface JsonMcpMetadata {
  selector: string[]
  canonicalPath: string
  containerPreconditionHash: string | null
  liveFragmentHash: string | null
  ownedFragmentHash: string | null
  desiredFragment?: JsonValue
  remove: boolean
  migrationSourceSelector?: string[]
  migrationSourceFragmentHash?: string | null
}

export interface JsonMcpHostSpec {
  catalogId: CatalogId
  adapterVersion: string
  configFile(context: AdapterOperationContext): string
  /** Exact selector for host contracts whose terminal key is user-selected. */
  selector?(context: AdapterOperationContext): JsonSelector
  selectorRoot?: readonly string[]
  legacySelectorRoots?: readonly (readonly string[])[]
  selectorSchemaVersion?: number
  reload: ReloadRequirement
  distributionId?: string
  detect?(context: AdapterOperationContext): boolean
  buildEntry?(context: AdapterOperationContext): JsonValue
  allowLegacyAgentOnlyAdoption?: boolean
  activationGate?(
    context: AdapterOperationContext,
    serverName: string,
  ): {
    allowed: boolean
    diagnostic?: string
    requiredUserAction?: string
    requiredUserActionDetail?: RequiredUserActionDetail
  }
}

export function createJsonMcpHostAdapter(spec: JsonMcpHostSpec): AgentHostAdapter {
  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const target = spec.configFile(context)
    const selector = serverSelector(spec, context)
    const detected = spec.detect?.(context) ?? defaultDetected(context, target)
    const diagnostics: string[] = []
    let visibility: 'absent' | 'dedicated' | 'unknown' = 'absent'
    let observedTarget: string | undefined
    let observedFragmentHash: string | undefined
    if (!detected) {
      diagnostics.push('host_not_detected_or_projection_format_unsupported')
    } else {
      try {
        const projection = inspectJsonProjection(target, selector, context.installation.canonicalConfigRoot)
        observedTarget = projection.file.canonicalPath
        if (projection.fragmentExists) {
          visibility = 'dedicated'
          observedFragmentHash = projection.fragmentHash ?? undefined
        }
        const gate = spec.activationGate?.(context, selector.at(-1)!)
        if (gate && !gate.allowed) {
          if (visibility === 'dedicated') visibility = 'unknown'
          diagnostics.push(gate.diagnostic ?? 'mcp_server_not_active_by_host_policy')
        }
      } catch (error) {
        visibility = 'unknown'
        diagnostics.push(error instanceof Error ? error.message : String(error))
      }
    }
    return {
      catalogId: spec.catalogId,
      detected,
      detectedVersion: undefined,
      distribution: {
        ...context.installation.distribution,
        distributionId: context.installation.distribution.distributionId ?? spec.distributionId,
      },
      components: [{
        componentKey: 'memory_tools',
        visibility,
        verificationStatus: 'unverified',
        observedTarget,
        observedFragmentHash,
      }],
      provenance: [target],
      diagnostics,
    }
  }

  return {
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    componentKeys: ['memory_tools'],
    implementationTypes: { memory_tools: ['mcp'] },
    componentContracts: {
      memory_tools: {
        deliveryMode: 'managed', artifactTypes: ['mcp'], mutationDomain: 'file_fragment', reload: spec.reload,
      },
    },
    inspect,
    async inspectAdoptableArtifacts(context): Promise<readonly AdoptableArtifactObservation[]> {
      const target = spec.configFile(context)
      const selector = serverSelector(spec, context)
      try {
        const projection = inspectJsonProjection(
          target,
          selector,
          context.installation.canonicalConfigRoot,
        )
        const desired = spec.buildEntry?.(context) ?? mcpEntry(context)
        if (!projection.fragmentExists
          || projection.fragmentHash === null
          || !isExactAdoptableEntry(
            projection.fragment,
            desired,
            context,
            spec.allowLegacyAgentOnlyAdoption !== false,
          )) return []
        return [{
          componentKey: 'memory_tools',
          artifactType: 'mcp',
          domainKind: 'file_fragment',
          physicalTarget: projection.file.canonicalPath,
          ownershipKey: selector.join('.'),
          selectorSchemaVersion: spec.selectorSchemaVersion ?? 1,
          projectionVersion: context.runtime.projectionVersion,
          containerHash: projection.file.containerHash ?? undefined,
          fragmentHash: projection.fragmentHash,
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
      const inspection = request.observed
      return buildPlan(spec, context, {
        desiredCapability: 0,
        desiredComponents: request.componentKeys,
        observed: inspection,
        ownedArtifacts: request.ownedArtifacts,
      }, true)
    },
    async apply(_context, mutation) {
      const metadata = parseMetadata(mutation)
      if (mutation.operation !== 'create' && mutation.operation !== 'update' && mutation.operation !== 'remove') {
        throw new Error(`Unsupported JSON MCP mutation operation: ${mutation.operation}`)
      }
      const plan: JsonProjectionPlan = {
        targetPath: mutation.physicalTarget,
        canonicalPath: metadata.canonicalPath,
        selector: metadata.selector,
        action: mutation.operation,
        containerPreconditionHash: metadata.containerPreconditionHash,
        liveFragmentHash: metadata.liveFragmentHash,
        ownedFragmentHash: metadata.ownedFragmentHash,
        desiredFragment: metadata.remove ? undefined : metadata.desiredFragment,
        desiredFragmentHash: mutation.desiredFragmentHash ?? null,
        conflictReason: null,
      }
      const readBack = metadata.migrationSourceSelector === undefined
        ? applyJsonProjection(plan, _context.installation.canonicalConfigRoot)
        : applyJsonProjectionMove({
            ...plan,
            sourceSelector: metadata.migrationSourceSelector,
            sourceFragmentHash: metadata.migrationSourceFragmentHash ?? null,
          }, _context.installation.canonicalConfigRoot)
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: readBack.fragmentHash ?? undefined,
        hostReceipt: {
          canonicalPath: readBack.file.canonicalPath,
          containerHash: readBack.file.containerHash,
        },
      }
    },
    async readBack(_context, mutation): Promise<MutationReadBack> {
      const metadata = parseMetadata(mutation)
      try {
        const readBack = inspectJsonProjection(
          mutation.physicalTarget,
          metadata.selector,
          _context.installation.canonicalConfigRoot,
        )
        if (metadata.migrationSourceSelector !== undefined) {
          const source = inspectJsonProjection(
            mutation.physicalTarget,
            metadata.migrationSourceSelector,
            _context.installation.canonicalConfigRoot,
          )
          const desiredHash = mutation.desiredFragmentHash ?? null
          if (readBack.fragmentHash === desiredHash && !source.fragmentExists) {
            return {
              operationId: mutation.operationId,
              observed: true,
              matchesDesired: true,
              observedFragmentHash: readBack.fragmentHash ?? undefined,
              visibility: 'dedicated',
              diagnostics: [],
            }
          }
          if (!readBack.fragmentExists
            && source.fragmentHash === (metadata.migrationSourceFragmentHash ?? null)) {
            return {
              operationId: mutation.operationId,
              observed: source.fragmentExists,
              matchesDesired: false,
              observedFragmentHash: source.fragmentHash ?? undefined,
              visibility: source.fragmentExists ? 'dedicated' : 'absent',
              diagnostics: ['legacy_selector_pending_migration'],
            }
          }
          return {
            operationId: mutation.operationId,
            observed: readBack.fragmentExists || source.fragmentExists,
            matchesDesired: false,
            observedFragmentHash: readBack.fragmentHash ?? source.fragmentHash ?? undefined,
            visibility: readBack.fragmentExists || source.fragmentExists ? 'unknown' : 'absent',
            diagnostics: ['selector_migration_state_conflict'],
          }
        }
        return {
          operationId: mutation.operationId,
          observed: readBack.fragmentExists,
          matchesDesired: readBack.fragmentHash === (mutation.desiredFragmentHash ?? null),
          observedFragmentHash: readBack.fragmentHash ?? undefined,
          visibility: readBack.fragmentExists ? 'dedicated' : 'absent',
          diagnostics: [],
        }
      } catch (error) {
        return {
          operationId: mutation.operationId,
          observed: false,
          matchesDesired: false,
          visibility: 'unknown',
          diagnostics: [error instanceof Error ? error.message : String(error)],
        }
      }
    },
    async verify(context, request: AdapterVerificationRequest): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes('memory_tools')) return []
      const inspection = await inspect(context)
      const memory = inspection.components.find(component => component.componentKey === 'memory_tools')
      if (request.expectedCapability === 0 && memory?.visibility === 'absent') {
        return [{
          componentKey: 'memory_tools',
          status: 'verified',
          verifiedCapability: 0,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['disconnect_static_readback_verified'],
        }]
      }
      if (memory?.visibility !== 'dedicated') {
        return [{
          componentKey: 'memory_tools',
          status: 'failed',
          verifiedCapability: null,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: inspection.diagnostics.length > 0 ? inspection.diagnostics : ['managed_mcp_fragment_not_visible'],
        }]
      }
      const desiredFragment = spec.buildEntry?.(context) ?? mcpEntry(context)
      const desiredFragmentHash = sha256Json(desiredFragment)
      if (memory.observedFragmentHash !== desiredFragmentHash) {
        return [{
          componentKey: 'memory_tools',
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: memory.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['managed_mcp_fragment_drifted_from_current_desired'],
        }]
      }
      const activity = await verifyMemoryReadWriteActivity(context, request)
      if (activity.status === 'unverified') {
        return [{
          ...activity,
          evidenceHash: memory.observedFragmentHash,
          identityAssertion: context.agentId,
          diagnostics: ['static_readback_passed', ...activity.diagnostics],
        }]
      }
      return [activity]
    },
  }
}

function assertsAgentIdentity(value: JsonValue, agentId: string): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const record = value as Record<string, JsonValue>
  for (const key of ['env', 'environment'] as const) {
    const environment = record[key]
    if (environment !== null && !Array.isArray(environment) && typeof environment === 'object'
      && (environment as Record<string, JsonValue>).EB_AGENT_ID === agentId) return true
  }
  return false
}

/**
 * Legacy managed MCP entries predate the exact host-variant binding. Adoption
 * may recognize that one historical shape, but only by deriving it from the
 * current desired entry and removing EB_HOST_VARIANT. Every other command,
 * argument, environment value and extra field must remain JSON-semantically
 * identical; the live fragment itself must still assert the exact Agent ID.
 */
function isExactAdoptableEntry(
  live: JsonValue | undefined,
  desired: JsonValue,
  context: AdapterOperationContext,
  allowLegacyAgentOnlyAdoption: boolean,
): boolean {
  if (live === undefined || !assertsAgentIdentity(live, context.agentId)) return false
  if (sha256Json(live) === sha256Json(desired)) return true
  if (!allowLegacyAgentOnlyAdoption) return false
  const generationlessDesired = withoutActivityGenerationToken(desired)
  if (generationlessDesired !== undefined && sha256Json(live) === sha256Json(generationlessDesired)) return true
  const agentOnlyLegacyDesired = withoutManagedHostVariant(
    generationlessDesired ?? desired,
    context.installation.hostVariant,
  )
  return agentOnlyLegacyDesired !== undefined && sha256Json(live) === sha256Json(agentOnlyLegacyDesired)
}

function withoutActivityGenerationToken(desired: JsonValue): JsonValue | undefined {
  if (desired === null || Array.isArray(desired) || typeof desired !== 'object') return undefined
  const record = desired as Record<string, JsonValue>
  for (const key of ['env', 'environment'] as const) {
    const environment = record[key]
    if (environment === null || Array.isArray(environment) || typeof environment !== 'object') continue
    const values = environment as Record<string, JsonValue>
    if (typeof values.EB_ACTIVITY_GENERATION_TOKEN !== 'string') continue
    const legacyEnvironment = { ...values }
    delete legacyEnvironment.EB_ACTIVITY_GENERATION_TOKEN
    return { ...record, [key]: legacyEnvironment }
  }
  return undefined
}

function withoutManagedHostVariant(
  desired: JsonValue,
  hostVariant: CatalogId,
): JsonValue | undefined {
  if (desired === null || Array.isArray(desired) || typeof desired !== 'object') return undefined
  const record = desired as Record<string, JsonValue>
  for (const key of ['env', 'environment'] as const) {
    const environment = record[key]
    if (environment === null || Array.isArray(environment) || typeof environment !== 'object') continue
    const values = environment as Record<string, JsonValue>
    if (values.EB_HOST_VARIANT !== hostVariant) continue
    const legacyEnvironment = { ...values }
    delete legacyEnvironment.EB_HOST_VARIANT
    return { ...record, [key]: legacyEnvironment }
  }
  return undefined
}

function buildPlan(
  spec: JsonMcpHostSpec,
  context: AdapterOperationContext,
  request: AdapterPlanRequest,
  remove: boolean,
): AdapterPlan {
  const target = spec.configFile(context)
  const primarySelector = serverSelector(spec, context)
  let selector = primarySelector
  let ownershipKey = selector.join('.')
  if (!request.observed.detected) {
    return {
      catalogId: spec.catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      mutations: [],
      requiredUserActions: request.desiredComponents
        .filter(component => component !== 'memory_tools')
        .map(component => `component_requires_other_projection:${component}`),
      diagnostics: ['host_not_detected_or_projection_format_unsupported'],
    }
  }
  if (!remove && request.desiredComponents.includes('memory_tools')) {
    let gate: ReturnType<NonNullable<JsonMcpHostSpec['activationGate']>> | undefined
    try {
      gate = spec.activationGate?.(context, primarySelector.at(-1)!)
    } catch (error) {
      return {
        catalogId: spec.catalogId,
        installationKey: context.installation.installKey,
        adapterVersion: spec.adapterVersion,
        projectionVersion: context.runtime.projectionVersion,
        mutations: [],
        requiredUserActions: [],
        diagnostics: [error instanceof Error ? error.message : String(error)],
      }
    }
    if (gate && !gate.allowed) {
      return {
        catalogId: spec.catalogId,
        installationKey: context.installation.installKey,
        adapterVersion: spec.adapterVersion,
        projectionVersion: context.runtime.projectionVersion,
        mutations: [],
        requiredUserActions: gate.requiredUserAction ? [gate.requiredUserAction] : [],
        requiredUserActionDetails: gate.requiredUserActionDetail ? [gate.requiredUserActionDetail] : [],
        diagnostics: [gate.diagnostic ?? 'mcp_server_not_active_by_host_policy'],
      }
    }
  }
  let baseline = request.ownedArtifacts.find(artifact =>
    artifact.componentKey === 'memory_tools'
    && path.resolve(artifact.physicalTarget) === path.resolve(target)
    && artifact.ownershipKey === ownershipKey,
  )
  const legacyCandidates = (spec.legacySelectorRoots ?? []).map(root => {
    const legacySelector = [...root, `tidemind-${context.agentId}`]
    return {
      selector: legacySelector,
      baseline: request.ownedArtifacts.find(artifact =>
        artifact.componentKey === 'memory_tools'
        && artifact.physicalTarget === target
        && artifact.ownershipKey === legacySelector.join('.'),
      ),
    }
  })
  if (remove && baseline === undefined) {
    const legacy = legacyCandidates.find(candidate => candidate.baseline !== undefined)
    if (legacy?.baseline !== undefined) {
      selector = legacy.selector
      ownershipKey = selector.join('.')
      baseline = legacy.baseline
    }
  }
  const desiredFragment = remove ? undefined : (spec.buildEntry?.(context) ?? mcpEntry(context))
  const desiredFragmentHash = desiredFragment === undefined ? null : sha256Json(desiredFragment)
  const relocatedBaseline = !remove && baseline === undefined && assertsAgentIdentity(desiredFragment!, context.agentId)
    ? request.ownedArtifacts.find(artifact =>
        artifact.componentKey === 'memory_tools'
        && path.resolve(artifact.physicalTarget) !== path.resolve(target)
        && artifact.ownershipKey === ownershipKey
        && artifact.ownedFragmentHash === desiredFragmentHash,
      )
    : undefined
  const projection = planJsonProjection({
    targetPath: target,
    selector,
    desiredFragment,
    ownedFragmentHash: baseline?.ownedFragmentHash ?? relocatedBaseline?.ownedFragmentHash ?? null,
    allowedRoot: context.installation.canonicalConfigRoot,
  })
  const diagnostics: string[] = []
  const mutations: PlannedMutation[] = []
  let migration: {
    sourceSelector: JsonSelector
    sourceFragmentHash: string | null
    baseline: OwnedArtifactBaseline
  } | undefined

  if (!remove && projection.action === 'create' && baseline === undefined) {
    for (const candidate of legacyCandidates) {
      const observed = inspectJsonProjection(target, candidate.selector, context.installation.canonicalConfigRoot)
      if (observed.fragmentExists) {
        if (candidate.baseline === undefined) {
          diagnostics.push('legacy_selector_occupied_without_ownership')
          break
        }
        if (observed.fragmentHash !== candidate.baseline.ownedFragmentHash) {
          diagnostics.push('legacy_owned_fragment_modified')
          break
        }
        if (observed.fragment === undefined || !assertsAgentIdentity(observed.fragment, context.agentId)) {
          diagnostics.push('legacy_selector_identity_mismatch')
          break
        }
        migration = {
          sourceSelector: candidate.selector,
          sourceFragmentHash: observed.fragmentHash,
          baseline: candidate.baseline,
        }
        break
      }
      if (candidate.baseline !== undefined) {
        // The old owned selector was deleted externally. Restore directly at
        // the canonical selector while retiring the legacy Ledger binding.
        migration = {
          sourceSelector: candidate.selector,
          sourceFragmentHash: null,
          baseline: candidate.baseline,
        }
        break
      }
    }
  }

  if (!request.desiredComponents.includes('memory_tools')) {
    diagnostics.push('memory_tools_not_requested')
  } else if (diagnostics.some(diagnostic => diagnostic.startsWith('legacy_'))) {
    // Same-name legacy state is part of the managed migration surface. Never
    // create a second selector without exact ownership and live-hash proof.
  } else if (projection.action === 'conflict') {
    diagnostics.push(projection.conflictReason ?? 'json_projection_conflict')
  } else if (projection.action !== 'noop') {
    const metadata: JsonMcpMetadata = {
      selector: [...selector],
      canonicalPath: projection.canonicalPath,
      containerPreconditionHash: projection.containerPreconditionHash,
      liveFragmentHash: projection.liveFragmentHash,
      ownedFragmentHash: projection.ownedFragmentHash,
      remove,
      ...(migration === undefined ? {} : {
        migrationSourceSelector: [...migration.sourceSelector],
        migrationSourceFragmentHash: migration.sourceFragmentHash,
      }),
      ...(desiredFragment === undefined ? {} : { desiredFragment }),
    }
    mutations.push({
      operationId: `${context.operationId}:memory_tools`,
      componentKey: 'memory_tools',
      operation: projection.action,
      domainKind: 'file_fragment',
      physicalTarget: target,
      ownershipKey,
      selectorSchemaVersion: migration === undefined
        ? (baseline?.selectorSchemaVersion ?? spec.selectorSchemaVersion ?? 1)
        : (spec.selectorSchemaVersion ?? 1),
      ownershipTransferFrom: migration === undefined ? undefined : {
        physicalTarget: migration.baseline.physicalTarget,
        ownershipKey: migration.baseline.ownershipKey,
        ownedFragmentHash: migration.baseline.ownedFragmentHash,
        selectorSchemaVersion: migration.baseline.selectorSchemaVersion ?? 1,
      },
      risk: 'low',
      reload: spec.reload,
      commandCategory: 'file_write',
      preconditionHash: migration?.sourceFragmentHash ?? projection.liveFragmentHash ?? undefined,
      containerPreconditionHash: projection.containerPreconditionHash ?? undefined,
      desiredFragmentHash: projection.desiredFragmentHash ?? undefined,
      idempotent: true,
      metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
    })
  }

  const unsupported = request.desiredComponents.filter(component => component !== 'memory_tools')
  return {
    catalogId: spec.catalogId,
    installationKey: context.installation.installKey,
    adapterVersion: spec.adapterVersion,
    projectionVersion: context.runtime.projectionVersion,
    mutations,
    requiredUserActions: unsupported.map(component => `component_requires_other_projection:${component}`),
    diagnostics,
  }
}

function serverSelector(spec: JsonMcpHostSpec, context: AdapterOperationContext): JsonSelector {
  if (spec.selector) return [...spec.selector(context)]
  return [...(spec.selectorRoot ?? ['mcpServers']), `tidemind-${context.agentId}`]
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

function defaultDetected(context: AdapterOperationContext, target: string): boolean {
  const executable = context.installation.distribution.executableRealpath
  return fs.existsSync(context.installation.canonicalConfigRoot)
    || fs.existsSync(target)
    || (executable !== undefined && fs.existsSync(executable))
}

function parseMetadata(mutation: PlannedMutation): JsonMcpMetadata {
  const value = mutation.metadata as unknown as Partial<JsonMcpMetadata> | undefined
  if (
    value === undefined
    || !Array.isArray(value.selector)
    || !value.selector.every(part => typeof part === 'string')
    || typeof value.canonicalPath !== 'string'
    || (value.containerPreconditionHash !== null && typeof value.containerPreconditionHash !== 'string')
    || typeof value.remove !== 'boolean'
    || (value.migrationSourceSelector !== undefined
      && (!Array.isArray(value.migrationSourceSelector)
        || !value.migrationSourceSelector.every(part => typeof part === 'string')))
    || (value.migrationSourceFragmentHash !== undefined
      && value.migrationSourceFragmentHash !== null
      && typeof value.migrationSourceFragmentHash !== 'string')
  ) {
    throw new Error(`Invalid JSON MCP mutation metadata: ${mutation.operationId}`)
  }
  return {
    selector: value.selector,
    canonicalPath: value.canonicalPath,
    containerPreconditionHash: value.containerPreconditionHash ?? null,
    liveFragmentHash: value.liveFragmentHash ?? null,
    ownedFragmentHash: value.ownedFragmentHash ?? null,
    desiredFragment: value.desiredFragment,
    remove: value.remove,
    migrationSourceSelector: value.migrationSourceSelector,
    migrationSourceFragmentHash: value.migrationSourceFragmentHash,
  }
}
