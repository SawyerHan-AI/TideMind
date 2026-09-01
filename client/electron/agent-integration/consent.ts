import path from 'node:path'
import { sha256Json } from './fingerprint'
import type { CommandCategory, ComponentKey, MutationRisk } from './types'

export type PlanOperation = 'connect' | 'upgrade' | 'repair' | 'disconnect'
export const CURRENT_CONSENT_POLICY_VERSION = 1

export interface ConsentEnvelope {
  id: string
  installationId: string
  componentKeys: string[]
  targetScopes: string[]
  /** Exact logical Artifact -> selector binding approved in the frozen preview. */
  selectorResolution: Record<string, string>
  /** Exact executables approved for host-command mutations. */
  executableRealpaths: string[]
  commandCategories: CommandCategory[]
  maxRisk: MutationRisk
  selectorSchemaVersion: number
  policyVersion: number
  approvedAt: string
  revokedAt: string | null
}

export interface PlannedCommand {
  category: Exclude<CommandCategory, 'none' | 'file_write'>
  executablePath: string
  args: string[]
}

export interface ExecutionMutationPlan {
  id: string
  componentKey: ComponentKey
  artifactKey: string
  action: 'create' | 'update' | 'remove' | 'invoke'
  targetPath: string | null
  ownershipSelector: string
  selectorSchemaVersion: number
  risk: MutationRisk
  commandCategory: CommandCategory
  command?: PlannedCommand
  containerPreconditionHash: string | null
  desiredFragmentHash: string | null
  reversible: boolean
}

export interface ExecutionPlan {
  installationId: string
  operation: PlanOperation
  componentKeys: ComponentKey[]
  catalogVersion: number
  adapterVersion: number
  projectionVersion: number
  /** Exact persisted discovery surface approved by this plan. */
  installationSurfaceFingerprint?: string
  /** Side-effect-free live package/signature proof observed for this plan. */
  liveTrustProofFingerprint?: string
  createdAt: string
  mutations: ExecutionMutationPlan[]
}

export interface SupplementalConsentClaim {
  componentKey: ComponentKey
  artifactKey: string
  targetPath: string | null
  ownershipSelector: string
  selectorSchemaVersion: number
  commandCategory: CommandCategory
  risk: MutationRisk
  executablePath?: string
}

export interface ConsentCheckResult {
  allowed: boolean
  reasons: string[]
  executionPlanHash: string
}

const RISK_ORDER: Record<MutationRisk, number> = {
  read_only: 0,
  low: 1,
  elevated: 2,
  high: 3,
}

export function executionPlanHash(plan: ExecutionPlan): string {
  return sha256Json(normalizePlan(plan))
}

export function checkPlanAgainstConsent(
  plan: ExecutionPlan,
  consent: ConsentEnvelope,
  supplementalClaims: readonly SupplementalConsentClaim[] = [],
): ConsentCheckResult {
  const reasons: string[] = []
  validatePlanShape(plan, reasons)

  if (consent.revokedAt !== null) reasons.push('consent_revoked')
  if (consent.policyVersion !== CURRENT_CONSENT_POLICY_VERSION) {
    reasons.push(`consent_policy_changed:${consent.policyVersion}->${CURRENT_CONSENT_POLICY_VERSION}`)
  }
  if (consent.installationId !== plan.installationId) reasons.push('installation_out_of_scope')

  for (const componentKey of plan.componentKeys) {
    if (!consent.componentKeys.includes(componentKey)) {
      reasons.push(`component_out_of_scope:${componentKey}`)
    }
  }

  const claims: SupplementalConsentClaim[] = [
    ...plan.mutations.map(mutation => ({
      ...mutation,
      executablePath: mutation.command?.executablePath,
    })),
    ...supplementalClaims,
  ]
  for (const claim of claims) {
    if (!consent.componentKeys.includes(claim.componentKey)) {
      reasons.push(`component_out_of_scope:${claim.componentKey}`)
    }
    if (consent.selectorResolution[claim.artifactKey] !== claim.ownershipSelector) {
      reasons.push(`selector_out_of_scope:${claim.ownershipSelector}`)
    }
    if (claim.selectorSchemaVersion !== consent.selectorSchemaVersion) {
      reasons.push(`selector_schema_changed:${claim.artifactKey}`)
    }
    if (!consent.commandCategories.includes(claim.commandCategory)) {
      reasons.push(`command_category_out_of_scope:${claim.commandCategory}`)
    }
    if (claim.executablePath && !consent.executableRealpaths.includes(path.resolve(claim.executablePath))) {
      reasons.push(`executable_out_of_scope:${path.resolve(claim.executablePath)}`)
    }
    if (RISK_ORDER[claim.risk] > RISK_ORDER[consent.maxRisk]) {
      reasons.push(`risk_exceeds_consent:${claim.risk}`)
    }
    if (claim.targetPath !== null && !isWithinAnyScope(claim.targetPath, consent.targetScopes)) {
      reasons.push(`target_out_of_scope:${path.resolve(claim.targetPath)}`)
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    executionPlanHash: executionPlanHash(plan),
  }
}

function validatePlanShape(plan: ExecutionPlan, reasons: string[]): void {
  if (!Array.isArray(plan.componentKeys) || plan.componentKeys.length === 0) {
    reasons.push('component_keys_missing')
  }
  if (new Set(plan.componentKeys).size !== plan.componentKeys.length) {
    reasons.push('duplicate_component_key')
  }
  const mutationIds = new Set<string>()
  for (const mutation of plan.mutations) {
    if (mutationIds.has(mutation.id)) reasons.push(`duplicate_mutation_id:${mutation.id}`)
    mutationIds.add(mutation.id)

    if (mutation.targetPath !== null && !path.isAbsolute(mutation.targetPath)) {
      reasons.push(`target_not_absolute:${mutation.id}`)
    }
    if (mutation.action === 'invoke') {
      if (mutation.command === undefined) reasons.push(`command_missing:${mutation.id}`)
      if (mutation.commandCategory === 'none' || mutation.commandCategory === 'file_write') {
        reasons.push(`invalid_invoke_category:${mutation.id}`)
      }
    } else if (mutation.command !== undefined) {
      reasons.push(`unexpected_command:${mutation.id}`)
    }
    if (mutation.command !== undefined) {
      if (!path.isAbsolute(mutation.command.executablePath)) reasons.push(`executable_not_absolute:${mutation.id}`)
      if (mutation.command.category !== mutation.commandCategory) reasons.push(`command_category_mismatch:${mutation.id}`)
      if (mutation.command.args.some(arg => typeof arg !== 'string')) reasons.push(`invalid_command_args:${mutation.id}`)
    }
  }
}

function isWithinAnyScope(targetPath: string, scopes: string[]): boolean {
  const target = path.resolve(targetPath)
  return scopes.some((scope) => {
    const isDirectory = scope.startsWith('directory:')
    const rawScope = isDirectory
      ? scope.slice('directory:'.length)
      : scope.startsWith('file:')
        ? scope.slice('file:'.length)
        : scope
    if (!path.isAbsolute(rawScope)) return false
    const resolvedScope = path.resolve(rawScope)
    if (!isDirectory) return target === resolvedScope
    const relative = path.relative(resolvedScope, target)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })
}

function normalizePlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    componentKeys: [...new Set(plan.componentKeys)].sort(),
    mutations: [...plan.mutations]
      .map(mutation => ({
        ...mutation,
        targetPath: mutation.targetPath === null ? null : path.resolve(mutation.targetPath),
        command: mutation.command === undefined
          ? undefined
          : { ...mutation.command, args: [...mutation.command.args] },
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
}
