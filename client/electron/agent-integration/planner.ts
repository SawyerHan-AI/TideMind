import { executionPlanHash, type ExecutionMutationPlan, type ExecutionPlan, type PlanOperation } from './consent'
import { sha256Json } from './fingerprint'
import type {
  AdapterInspection,
  AdapterPlan,
  CommandCategory,
  ComponentKey,
  PlannedMutation,
} from './types'

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
}

const OPERATION_ORDER: Readonly<Record<PlannedMutation['operation'], number>> = {
  remove: 0,
  create: 1,
  update: 2,
  host_command: 3,
}

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
  const componentKeys = [...new Set(input.componentKeys)].sort()
  const mutations = input.adapterPlan.mutations.map((mutation) => {
    if (operationIds.has(mutation.operationId)) {
      throw new Error(`duplicate adapter operation ID: ${mutation.operationId}`)
    }
    operationIds.add(mutation.operationId)
    if (!componentKeys.includes(mutation.componentKey)) {
      throw new Error(`adapter planned an unrequested component: ${mutation.componentKey}`)
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
    createdAt: input.createdAt,
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
  }
}

function toExecutionMutation(catalogId: string, mutation: PlannedMutation): ExecutionMutationPlan {
  const commandCategory = commandCategoryFor(mutation)
  const isFileTarget = mutation.domainKind === 'file_fragment' || mutation.domainKind === 'directory'
  const canonicalTarget = typeof mutation.metadata?.canonicalPath === 'string'
    ? mutation.metadata.canonicalPath
    : mutation.physicalTarget
  const artifactKey = typeof mutation.metadata?.artifactKey === 'string'
    ? mutation.metadata.artifactKey
    : `${catalogId}:${mutation.componentKey}:${mutation.ownershipKey}`

  if (mutation.operation === 'host_command') {
    if (!mutation.executableRealpath || !mutation.args) {
      throw new Error(`host command ${mutation.operationId} lacks executable realpath or args`)
    }
    if (commandCategory === 'none' || commandCategory === 'file_write') {
      throw new Error(`host command ${mutation.operationId} lacks an explicit host command category`)
    }
  }

  return {
    id: mutation.operationId,
    componentKey: mutation.componentKey,
    artifactKey,
    action: mutation.operation === 'host_command' ? 'invoke' : mutation.operation,
    // Consent and preview bind to the actual canonical write location. The
    // adapter may retain a lexical host path for CAS, but it must prove that
    // path still resolves to this target before applying.
    targetPath: isFileTarget ? canonicalTarget : null,
    ownershipSelector: mutation.ownershipKey,
    selectorSchemaVersion: mutation.selectorSchemaVersion,
    risk: mutation.risk,
    commandCategory,
    command: mutation.operation === 'host_command'
      ? {
          category: commandCategory as Exclude<CommandCategory, 'none' | 'file_write'>,
          executablePath: mutation.executableRealpath!,
          args: [...mutation.args!],
        }
      : undefined,
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
      args: mutation.args ? [...mutation.args] : undefined,
      metadata: mutation.metadata ? { ...mutation.metadata } : undefined,
    })),
    requiredUserActions: [...plan.requiredUserActions],
    diagnostics: [...plan.diagnostics],
  }
}

export function componentKeysForPlan(plan: PreparedCoordinatorPlan): ComponentKey[] {
  return [...plan.componentKeys]
}
