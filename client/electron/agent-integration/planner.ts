import path from 'node:path'
import {
  assertExecutionPlanShape,
  executionPlanHash,
  type ExecutionMutationPlan,
  type ExecutionPlan,
  type PlanOperation,
} from './consent'
import { sha256Json } from './fingerprint'
import type {
  AdapterInspection,
  AdapterPlan,
  CommandCategory,
  ComponentKey,
  PlannedMutation,
} from './types'
import { COMPONENT_KEYS, isMutationDomainKind } from './types'

/**
 * A prepared plan keeps the host-specific plan beside the consent-facing plan.
 * The coordinator executes this exact object after approval; it never asks an
 * adapter to silently regenerate a potentially broader plan at apply time.
 */
export interface PreparedCoordinatorPlan {
  operation: PlanOperation
  componentKeys: readonly ComponentKey[]
  inspection: AdapterInspection
  adapterPlan: AdapterPlan
  adapterPlanHash: string
  executionPlan: ExecutionPlan
  executionPlanHash: string
  /** Opaque token embedded into the exact Skill/MCP/Hook/Plugin projection. */
  activityGenerationToken?: string
}

export interface BuildExecutionPlanInput {
  installationId: string
  installationKey: string
  operation: PlanOperation
  componentKeys: readonly ComponentKey[]
  inspection: AdapterInspection
  adapterPlan: AdapterPlan
  catalogGeneration: number
  adapterGeneration: number
  projectionGeneration: number
  createdAt: string
  activityGenerationToken?: string
}

const OPERATION_ORDER: Readonly<Record<PlannedMutation['operation'], number>> = {
  remove: 0,
  create: 1,
  update: 2,
  host_command: 3,
}

const PLAN_OPERATIONS: readonly PlanOperation[] = ['connect', 'upgrade', 'repair', 'disconnect']
const MUTATION_OPERATIONS: readonly PlannedMutation['operation'][] = ['create', 'update', 'remove', 'host_command']
const MUTATION_RISKS: readonly PlannedMutation['risk'][] = ['read_only', 'low', 'elevated', 'high']
const RELOAD_REQUIREMENTS: readonly PlannedMutation['reload'][] = [
  'none', 'reload', 'new_session', 'restart_host', 'user_confirmation', 'version_dependent',
]

/** Pure adapter-plan -> consent-plan projection. */
export function buildExecutionPlan(input: BuildExecutionPlanInput): PreparedCoordinatorPlan {
  validateGeneration('catalogGeneration', input.catalogGeneration)
  validateGeneration('adapterGeneration', input.adapterGeneration)
  validateGeneration('projectionGeneration', input.projectionGeneration)
  if (input.adapterPlan.catalogId !== input.inspection.catalogId) {
    throw new Error('adapter plan and inspection catalog IDs differ')
  }
  if (input.adapterPlan.installationKey !== input.installationKey) {
    throw new Error('adapter plan belongs to a different Installation')
  }

  const operationIds = new Set<string>()
  const coveredByMutation = new Set<ComponentKey>()
  const componentKeys = [...new Set(input.componentKeys)].sort()
  const mutations = input.adapterPlan.mutations.map((mutation) => {
    if (operationIds.has(mutation.operationId)) {
      throw new Error(`duplicate adapter operation ID: ${mutation.operationId}`)
    }
    operationIds.add(mutation.operationId)
    if (!isMutationDomainKind(mutation.domainKind)) {
      throw new Error(`adapter mutation ${mutation.operationId} has invalid domain kind`)
    }
    for (const target of mutation.additionalFenceTargets ?? []) {
      if (!isMutationDomainKind(target.domainKind)) {
        throw new Error(`adapter mutation ${mutation.operationId} has invalid additional fence domain kind`)
      }
    }
    if (!componentKeys.includes(mutation.componentKey)) {
      throw new Error(`adapter planned an unrequested component: ${mutation.componentKey}`)
    }
    const coveredComponentKeys = mutation.coveredComponentKeys ?? [mutation.componentKey]
    if (coveredComponentKeys.length === 0 || !coveredComponentKeys.includes(mutation.componentKey)) {
      throw new Error(`adapter mutation ${mutation.operationId} has invalid covered components`)
    }
    if (new Set(coveredComponentKeys).size !== coveredComponentKeys.length) {
      throw new Error(`adapter mutation ${mutation.operationId} repeats a covered component`)
    }
    for (const componentKey of coveredComponentKeys) {
      if (!componentKeys.includes(componentKey)) {
        throw new Error(`adapter planned an unrequested covered component: ${componentKey}`)
      }
      if (coveredByMutation.has(componentKey)) {
        throw new Error(`adapter planned overlapping aggregate component: ${componentKey}`)
      }
      coveredByMutation.add(componentKey)
    }
    return toExecutionMutation(input.adapterPlan.catalogId, mutation)
  }).sort(compareMutations)

  const executionPlan: ExecutionPlan = {
    installationId: input.installationId,
    operation: input.operation,
    componentKeys,
    catalogVersion: input.catalogGeneration,
    adapterVersion: input.adapterGeneration,
    projectionVersion: input.projectionGeneration,
    hostVersion: input.inspection.detectedVersion ?? null,
    createdAt: input.createdAt,
    ...(input.activityGenerationToken ? {
      activityGenerationTokenHash: sha256Json(input.activityGenerationToken),
    } : {}),
    mutations,
  }
  const clonedAdapterPlan = cloneAdapterPlan(input.adapterPlan)
  return {
    operation: input.operation,
    componentKeys,
    inspection: cloneInspection(input.inspection),
    adapterPlan: clonedAdapterPlan,
    adapterPlanHash: sha256Json(clonedAdapterPlan),
    executionPlan,
    executionPlanHash: executionPlanHash(executionPlan),
    ...(input.activityGenerationToken ? { activityGenerationToken: input.activityGenerationToken } : {}),
  }
}

/** Runtime guard for Adapter plans restored from durable JSON. */
export function assertFrozenMutationDomains(adapterPlan: AdapterPlan, executionPlan: ExecutionPlan): void {
  if (!Array.isArray(adapterPlan.mutations) || !Array.isArray(executionPlan.mutations)) {
    throw new Error('persisted mutation plans are invalid')
  }
  for (const mutation of adapterPlan.mutations) {
    if (!isMutationDomainKind(mutation.domainKind)) {
      throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid domain kind`)
    }
    for (const target of mutation.additionalFenceTargets ?? []) {
      if (!isMutationDomainKind(target.domainKind)) {
        throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid additional fence domain kind`)
      }
    }
    const projected = executionPlan.mutations.find(candidate => candidate.id === mutation.operationId)
    if (!projected || projected.domainKind !== mutation.domainKind) {
      throw new Error(`persisted mutation domain projection changed: ${mutation.operationId}`)
    }
    const adapterFences = (mutation.additionalFenceTargets ?? [])
      .map((target: NonNullable<PlannedMutation['additionalFenceTargets']>[number]) => (
        `${target.domainKind}:${path.resolve(target.physicalTarget)}`
      )).sort()
    const executionFences = (projected.additionalFenceTargets ?? [])
      .map(target => `${target.domainKind}:${path.resolve(target.targetPath)}`).sort()
    if (JSON.stringify(adapterFences) !== JSON.stringify(executionFences)) {
      throw new Error(`persisted additional fence projection changed: ${mutation.operationId}`)
    }
  }
}

/** Runtime guard for the complete persisted plan that can reach Adapter.apply. */
export function assertPersistedPreparedPlanShape(plan: PreparedCoordinatorPlan): void {
  assertExecutionPlanShape(plan.executionPlan)
  if (!PLAN_OPERATIONS.includes(plan.operation)) throw new Error('persisted plan has invalid operation')
  if (plan.operation !== plan.executionPlan.operation) throw new Error('persisted plan operation projection changed')
  if (!Array.isArray(plan.componentKeys) || plan.componentKeys.length === 0
    || plan.componentKeys.some(componentKey => !COMPONENT_KEYS.includes(componentKey))) {
    throw new Error('persisted plan has invalid component keys')
  }
  const preparedComponents = [...new Set(plan.componentKeys)].sort()
  const executionComponents = [...new Set(plan.executionPlan.componentKeys)].sort()
  if (preparedComponents.length !== plan.componentKeys.length
    || JSON.stringify(preparedComponents) !== JSON.stringify(executionComponents)) {
    throw new Error('persisted plan component projection changed')
  }

  assertFrozenMutationDomains(plan.adapterPlan, plan.executionPlan)
  for (const mutation of plan.adapterPlan.mutations) {
    assertPersistedPlannedMutationShape(mutation)
    const projected = plan.executionPlan.mutations.find(candidate => candidate.id === mutation.operationId)
    if (!projected
      || sha256Json(toExecutionMutation(plan.adapterPlan.catalogId, mutation)) !== sha256Json(projected)) {
      throw new Error(`persisted mutation projection changed: ${mutation.operationId}`)
    }
  }
  if (plan.adapterPlan.mutations.length !== plan.executionPlan.mutations.length) {
    throw new Error('persisted mutation projection count changed')
  }
}

/** Runtime guard for a mutation restored independently from projection_mutations. */
export function assertPersistedPlannedMutationShape(mutation: PlannedMutation): void {
  if (!MUTATION_OPERATIONS.includes(mutation.operation)) {
    throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid operation`)
  }
  if (!COMPONENT_KEYS.includes(mutation.componentKey)) {
    throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid component key`)
  }
  const coveredComponentKeys = mutation.coveredComponentKeys ?? [mutation.componentKey]
  if (coveredComponentKeys.length === 0
    || !coveredComponentKeys.includes(mutation.componentKey)
    || coveredComponentKeys.some(componentKey => !COMPONENT_KEYS.includes(componentKey))) {
    throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid covered components`)
  }
  if (!MUTATION_RISKS.includes(mutation.risk)) {
    throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid risk`)
  }
  if (!RELOAD_REQUIREMENTS.includes(mutation.reload)) {
    throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid reload requirement`)
  }
  if (mutation.commandCategory !== undefined
    && !COMMAND_CATEGORY_ORDER.includes(mutation.commandCategory)) {
    throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid command category`)
  }
  for (const command of mutation.frozenCommands ?? []) {
    const category = command.category as CommandCategory
    if (!COMMAND_CATEGORY_ORDER.includes(category)
      || category === 'none' || category === 'file_write') {
      throw new Error(`persisted adapter mutation ${mutation.operationId} has invalid frozen command category`)
    }
  }
}

function toExecutionMutation(catalogId: string, mutation: PlannedMutation): ExecutionMutationPlan {
  const frozenCommands = mutation.frozenCommands?.map(command => ({
    category: command.category,
    executablePath: command.executableRealpath,
    args: [...command.args],
  }))
  if (frozenCommands !== undefined && (mutation.executableRealpath !== undefined || mutation.args !== undefined)) {
    throw new Error(`host command ${mutation.operationId} has duplicate command sources`)
  }
  const commandCategory = frozenCommands
    ? maximumCommandCategory(frozenCommands.map(command => command.category))
    : commandCategoryFor(mutation)
  const canonicalTarget = typeof mutation.metadata?.canonicalPath === 'string'
    ? mutation.metadata.canonicalPath
    : mutation.physicalTarget
  const isFileTarget = mutation.domainKind === 'file_fragment'
    || mutation.domainKind === 'directory'
    || (mutation.domainKind === 'plugin_manager' && path.isAbsolute(canonicalTarget))
  const artifactKey = typeof mutation.metadata?.artifactKey === 'string'
    ? mutation.metadata.artifactKey
    : `${catalogId}:${mutation.componentKey}:${mutation.ownershipKey}`

  if (mutation.operation === 'host_command') {
    if (frozenCommands ? frozenCommands.length === 0 : (!mutation.executableRealpath || !mutation.args)) {
      throw new Error(`host command ${mutation.operationId} lacks executable realpath or args`)
    }
    if (commandCategory === 'none' || commandCategory === 'file_write') {
      throw new Error(`host command ${mutation.operationId} lacks an explicit host command category`)
    }
  }

  return {
    id: mutation.operationId,
    componentKey: mutation.componentKey,
    coveredComponentKeys: mutation.coveredComponentKeys === undefined
      ? undefined
      : [...mutation.coveredComponentKeys],
    artifactKey,
    action: mutation.operation === 'host_command' ? 'invoke' : mutation.operation,
    domainKind: mutation.domainKind,
    // Consent and preview bind to the actual canonical write location. The
    // adapter may retain a lexical host path for CAS, but it must prove that
    // path still resolves to this target before applying.
    targetPath: isFileTarget ? canonicalTarget : null,
    ownershipSelector: mutation.ownershipKey,
    selectorSchemaVersion: mutation.selectorSchemaVersion,
    additionalFenceTargets: mutation.additionalFenceTargets?.map(target => ({
      domainKind: target.domainKind,
      targetPath: target.physicalTarget,
    })),
    ownershipTransferFrom: mutation.ownershipTransferFrom === undefined ? undefined : {
      targetPath: mutation.ownershipTransferFrom.physicalTarget,
      ownershipSelector: mutation.ownershipTransferFrom.ownershipKey,
      ownedFragmentHash: mutation.ownershipTransferFrom.ownedFragmentHash,
      selectorSchemaVersion: mutation.ownershipTransferFrom.selectorSchemaVersion,
    },
    risk: mutation.risk,
    commandCategory,
    command: mutation.operation === 'host_command'
      && frozenCommands === undefined ? {
          category: commandCategory as Exclude<CommandCategory, 'none' | 'file_write'>,
          executablePath: mutation.executableRealpath!,
          args: [...mutation.args!],
        }
      : undefined,
    commands: mutation.operation === 'host_command' && frozenCommands !== undefined
      ? frozenCommands
      : undefined,
    safeResumeStates: mutation.safeResumeStates?.map(state => ({
      fingerprint: state.fingerprint,
      completedStepIds: [...state.completedStepIds],
    })),
    containerPreconditionHash: mutation.containerPreconditionHash ?? null,
    desiredFragmentHash: mutation.desiredFragmentHash ?? null,
    // Idempotence only makes replay safe; it does not provide a compensation
    // path.  A mutation may be shown as reversible only when its adapter has
    // explicitly declared and implemented that guarantee.
    reversible: mutation.idempotent && mutation.metadata?.reversible === true,
  }
}

function commandCategoryFor(mutation: PlannedMutation): CommandCategory {
  if (mutation.commandCategory) return mutation.commandCategory
  return mutation.operation === 'host_command' ? 'none' : 'file_write'
}

const COMMAND_CATEGORY_ORDER: readonly CommandCategory[] = [
  'none',
  'file_write',
  'host_cli',
  'plugin_install',
  'host_trust',
  'admin',
]

function maximumCommandCategory(categories: readonly CommandCategory[]): CommandCategory {
  return categories.reduce((maximum, category) => (
    COMMAND_CATEGORY_ORDER.indexOf(category) > COMMAND_CATEGORY_ORDER.indexOf(maximum) ? category : maximum
  ), 'none' as CommandCategory)
}

function compareMutations(left: ExecutionMutationPlan, right: ExecutionMutationPlan): number {
  return left.componentKey.localeCompare(right.componentKey)
    || left.artifactKey.localeCompare(right.artifactKey)
    || OPERATION_ORDER[fromExecutionOperation(left.action)] - OPERATION_ORDER[fromExecutionOperation(right.action)]
    || left.id.localeCompare(right.id)
}

function fromExecutionOperation(
  operation: ExecutionMutationPlan['action'],
): PlannedMutation['operation'] {
  return operation === 'invoke' ? 'host_command' : operation
}

function validateGeneration(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function cloneInspection(inspection: AdapterInspection): AdapterInspection {
  return {
    ...inspection,
    distribution: { ...inspection.distribution },
    components: inspection.components.map(component => ({
      ...component,
      details: component.details ? { ...component.details } : undefined,
    })),
    provenance: [...inspection.provenance],
    diagnostics: [...inspection.diagnostics],
  }
}

function cloneAdapterPlan(plan: AdapterPlan): AdapterPlan {
  return {
    ...plan,
    mutations: plan.mutations.map(mutation => ({
      ...mutation,
      coveredComponentKeys: mutation.coveredComponentKeys
        ? [...mutation.coveredComponentKeys]
        : undefined,
      ownershipTransferFrom: mutation.ownershipTransferFrom
        ? { ...mutation.ownershipTransferFrom }
        : undefined,
      args: mutation.args ? [...mutation.args] : undefined,
      frozenCommands: mutation.frozenCommands?.map(command => ({
        ...command,
        args: [...command.args],
      })),
      safeResumeStates: mutation.safeResumeStates?.map(state => ({
        fingerprint: state.fingerprint,
        completedStepIds: [...state.completedStepIds],
      })),
      metadata: mutation.metadata ? { ...mutation.metadata } : undefined,
    })),
    requiredUserActions: [...plan.requiredUserActions],
    requiredUserActionDetails: plan.requiredUserActionDetails?.map(action => ({ ...action })),
    diagnostics: [...plan.diagnostics],
  }
}

export function componentKeysForPlan(plan: PreparedCoordinatorPlan): ComponentKey[] {
  return [...plan.componentKeys]
}
