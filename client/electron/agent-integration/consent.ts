import path from 'node:path'
import { sha256Json } from './fingerprint'
import {
  COMPONENT_KEYS,
  isMutationDomainKind,
  type CommandCategory,
  type ComponentKey,
  type MutationDomainKind,
  type MutationRisk,
} from './types'

export type PlanOperation = 'connect' | 'upgrade' | 'repair' | 'disconnect'
export const CURRENT_CONSENT_POLICY_VERSION = 1
export const DEFAULT_AUTO_CONNECTION_POLICY_VERSION = 1

export type ConsentOrigin = 'explicit_user' | 'default_auto_policy' | 'legacy'
export interface AutomaticConsentContext {
  policyVersion: number
  connectionKey: string
  domainKey: string
  intentRevision: number
  executionPlanHash: string
  installationSurfaceFingerprint: string
  sharedIdentityBinding?: string
}

export function isAutomaticConsentContext(value: unknown): value is AutomaticConsentContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const context = value as Partial<AutomaticConsentContext>
  return context.policyVersion === DEFAULT_AUTO_CONNECTION_POLICY_VERSION
    && typeof context.connectionKey === 'string' && /^(binding|installation):.+$/u.test(context.connectionKey)
    && typeof context.domainKey === 'string' && context.domainKey.length > 0
    && Number.isSafeInteger(context.intentRevision) && context.intentRevision! >= 0
    && typeof context.executionPlanHash === 'string' && /^[a-f0-9]{64}$/u.test(context.executionPlanHash)
    && typeof context.installationSurfaceFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(context.installationSurfaceFingerprint)
    && (context.sharedIdentityBinding === undefined || /^[a-f0-9]{64}$/u.test(context.sharedIdentityBinding))
}

export function automaticPlanAuthorizationKey(consentId: string, planHash: string): string {
  return `sha256:${sha256Json([consentId, planHash])}`
}

export interface ConsentEnvelope {
  origin?: ConsentOrigin
  nativePermissionPlanHash?: string
  automaticContext?: AutomaticConsentContext
  /** A separately recorded exact maintenance plan, still bounded by this envelope's original scopes. */
  automaticPlanAuthorization?: AutomaticConsentContext

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
  coveredComponentKeys?: readonly ComponentKey[]
  artifactKey: string
  action: 'create' | 'update' | 'remove' | 'invoke'
  domainKind: MutationDomainKind
  targetPath: string | null
  ownershipSelector: string
  selectorSchemaVersion: number
  additionalFenceTargets?: readonly {
    domainKind: MutationDomainKind
    targetPath: string
  }[]
  ownershipTransferFrom?: {
    targetPath: string
    ownershipSelector: string
    ownedFragmentHash: string
    selectorSchemaVersion: number
  }
  risk: MutationRisk
  commandCategory: CommandCategory
  command?: PlannedCommand
  /** Ordered command sequence for an aggregate host-owned effect. */
  commands?: PlannedCommand[]
  safeResumeStates?: Array<{ fingerprint: string; completedStepIds: string[] }>
  containerPreconditionHash: string | null
  desiredFragmentHash: string | null
  reversible: boolean
}

/** Permissions granted by the native host, separate from routine Tide Mind configuration. */
export function nativePermissionsForPlan(plan: Pick<ExecutionPlan, 'mutations'>): Array<'gemini_extension' | 'openclaw_capabilities'> {
  const permissions = new Set<'gemini_extension' | 'openclaw_capabilities'>()
  for (const mutation of plan.mutations) for (const command of mutation.commands ?? (mutation.command ? [mutation.command] : [])) {
    if (command.args[0] === 'extensions' && command.args.includes('--consent')) permissions.add('gemini_extension')
    if (command.args.includes('--accept-capabilities') || (command.args[0] === 'config' && command.args[1] === 'set'
      && /\.hooks\.allow(PromptInjection|ConversationAccess)$/u.test(command.args[2] ?? '') && command.args[3] === 'true')) permissions.add('openclaw_capabilities')
  }
  return [...permissions]
}

export interface CompletedGenerationTakeover {
  /** Only this exact recipe permits approved peer waits in the shared Codex domain. */
  kind?: 'codex_lifecycle_4_to_5'
  installationId?: string
  runId: string
  executionPlanHash: string
  effectSnapshotHash: string
  mutationDomains: string[]
}

export interface ExecutionPlan {
  /** Exact completed effects whose obsolete waiting generation this approval replaces. */
  completedGenerationTakeovers?: CompletedGenerationTakeover[]
  sharedBatchApprovalHash?: string
  codexFreshIdentityHash?: string
  codexLegacySelectionHash?: string

  installationId: string
  operation: PlanOperation
  componentKeys: ComponentKey[]
  catalogVersion: number
  adapterVersion: number
  projectionVersion: number
  /** Exact host version observed during preview and covered by executionPlanHash. */
  hostVersion?: string | null
  /** Exact persisted discovery surface approved by this plan. */
  installationSurfaceFingerprint?: string
  /** Side-effect-free live package/signature proof observed for this plan. */
  liveTrustProofFingerprint?: string
  /**
   * Shared physical-domain CAS (design §3.3.1): other consumers of every written
   * shared artifact/container and their generations, frozen at preview.
   */
  sharedDomainBinding?: string
  /** Canonical identity and binding generation frozen at preview. */
  sharedIdentityBinding?: string
  /**
   * Ownership-only disconnect binding (design §3.5): ownership selectors, targets
   * and current bytes. Present instead of liveTrustProofFingerprint, never with it.
   */
  ownershipOnlyDisconnectBinding?: string
  /** Hash only: the clear token lives in the frozen host projection plan. */
  activityGenerationTokenHash?: string
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

const PLAN_MUTATION_ACTIONS = ['create', 'update', 'remove', 'invoke'] as const
const PLAN_OPERATIONS = ['connect', 'upgrade', 'repair', 'disconnect'] as const

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

  if (consent.origin !== undefined && !['explicit_user','default_auto_policy','legacy'].includes(consent.origin)) reasons.push('consent_origin_invalid')
  if (consent.origin === 'default_auto_policy') {
    const context = consent.automaticPlanAuthorization ?? consent.automaticContext
    if (!isAutomaticConsentContext(context)) reasons.push('automatic_consent_context_invalid')
    else {
      if (context.executionPlanHash !== executionPlanHash(plan)) reasons.push('automatic_consent_plan_changed')
      if (context.installationSurfaceFingerprint !== plan.installationSurfaceFingerprint) reasons.push('automatic_consent_identity_changed')
      if (context.sharedIdentityBinding !== plan.sharedIdentityBinding) reasons.push('automatic_consent_binding_changed')
    }
  }
  if (consent.revokedAt !== null) reasons.push('consent_revoked')
  if (consent.policyVersion !== CURRENT_CONSENT_POLICY_VERSION) {
    reasons.push(`consent_policy_changed:${consent.policyVersion}->${CURRENT_CONSENT_POLICY_VERSION}`)
  }
  const consentRiskValid = isMutationRisk(consent.maxRisk)
  if (!consentRiskValid) reasons.push('consent_max_risk_invalid')
  for (const componentKey of consent.componentKeys) {
    if (!isComponentKey(componentKey)) reasons.push(`consent_component_invalid:${componentKey}`)
  }
  for (const category of consent.commandCategories) {
    if (!isCommandCategory(category)) reasons.push(`consent_command_category_invalid:${category}`)
  }
  if (consent.installationId !== plan.installationId) reasons.push('installation_out_of_scope')

  for (const componentKey of plan.componentKeys) {
    if (!consent.componentKeys.includes(componentKey)) {
      reasons.push(`component_out_of_scope:${componentKey}`)
    }
  }

  const claims: SupplementalConsentClaim[] = [
    ...plan.mutations.flatMap((mutation): SupplementalConsentClaim[] => {
      const commands = mutation.commands ?? (mutation.command ? [mutation.command] : [])
      if (commands.length === 0) {
        return [{ ...mutation, executablePath: undefined }]
      }
      return commands.map(command => ({
        ...mutation,
        commandCategory: command.category,
        executablePath: command.executablePath,
      }))
    }),
    ...supplementalClaims,
  ]
  for (const claim of claims) {
    const claimRiskValid = isMutationRisk(claim.risk)
    if (!claimRiskValid) reasons.push(`risk_invalid:${claim.artifactKey}`)
    if (!isCommandCategory(claim.commandCategory)) {
      reasons.push(`command_category_invalid:${claim.artifactKey}`)
    }
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
    if (claimRiskValid && consentRiskValid
      && RISK_ORDER[claim.risk] > RISK_ORDER[consent.maxRisk]) {
      reasons.push(`risk_exceeds_consent:${claim.risk}`)
    }
    if (claim.targetPath !== null && !isWithinAnyScope(claim.targetPath, consent.targetScopes)) {
      reasons.push(`target_out_of_scope:${path.resolve(claim.targetPath)}`)
    }
  }
  for (const mutation of plan.mutations) {
    for (const target of mutation.additionalFenceTargets ?? []) {
      if (!isWithinAnyScope(target.targetPath, consent.targetScopes)) {
        reasons.push(`additional_fence_target_out_of_scope:${path.resolve(target.targetPath)}`)
      }
    }
    const safeFingerprints = new Set<string>()
    for (const state of mutation.safeResumeStates ?? []) {
      if (!/^[a-f0-9]{64}$/u.test(state.fingerprint)) reasons.push(`intermediate_fingerprint_invalid:${mutation.id}`)
      if (safeFingerprints.has(state.fingerprint)) reasons.push(`duplicate_intermediate_fingerprint:${mutation.id}`)
      safeFingerprints.add(state.fingerprint)
      if (state.completedStepIds.length === 0 || new Set(state.completedStepIds).size !== state.completedStepIds.length) {
        reasons.push(`intermediate_steps_invalid:${mutation.id}`)
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    executionPlanHash: executionPlanHash(plan),
  }
}

/** Runtime guard for persisted/untrusted plan JSON. */
export function assertExecutionPlanShape(plan: ExecutionPlan): void {
  const reasons: string[] = []
  validatePlanShape(plan, reasons)
  if (reasons.length > 0) throw new Error(`invalid_execution_plan_shape:${reasons.join(',')}`)
}

function validatePlanShape(plan: ExecutionPlan, reasons: string[]): void {
  const takeovers = plan.completedGenerationTakeovers
  if (takeovers !== undefined && (
    plan.operation !== 'connect' || !Array.isArray(takeovers) || takeovers.length === 0
    || takeovers.some(item => !item || typeof item.runId !== 'string' || !item.runId
      || (item.kind !== undefined && item.kind !== 'codex_lifecycle_4_to_5')
      || (item.kind === 'codex_lifecycle_4_to_5'
        ? typeof item.installationId !== 'string' || !item.installationId
        : item.installationId !== undefined)
      || !/^[a-f0-9]{64}$/.test(item.executionPlanHash) || !/^[a-f0-9]{64}$/.test(item.effectSnapshotHash)
      || !Array.isArray(item.mutationDomains) || !item.mutationDomains.length
      || item.mutationDomains.some(domain => typeof domain !== 'string' || !domain))
    || new Set(takeovers.map(item => item.runId)).size !== takeovers.length
  )) reasons.push('completed_generation_takeovers_invalid')
  if (!isPlanOperation(plan.operation)) reasons.push('operation_invalid')
  if (!Array.isArray(plan.componentKeys) || plan.componentKeys.length === 0) {
    reasons.push('component_keys_missing')
  } else {
    for (const componentKey of plan.componentKeys) {
      if (!isComponentKey(componentKey)) reasons.push(`component_key_invalid:${componentKey}`)
    }
  }
  if (new Set(plan.componentKeys).size !== plan.componentKeys.length) {
    reasons.push('duplicate_component_key')
  }
  const mutationIds = new Set<string>()
  const coveredByMutation = new Set<ComponentKey>()
  for (const mutation of plan.mutations) {
    if (mutationIds.has(mutation.id)) reasons.push(`duplicate_mutation_id:${mutation.id}`)
    mutationIds.add(mutation.id)

    if (!isComponentKey(mutation.componentKey)) {
      reasons.push(`invalid_component_key:${mutation.id}`)
    }
    if (!isMutationDomainKind(mutation.domainKind)) {
      reasons.push(`invalid_domain_kind:${mutation.id}`)
    }
    if (!isPlanMutationAction(mutation.action)) reasons.push(`invalid_action:${mutation.id}`)
    if (!isMutationRisk(mutation.risk)) reasons.push(`invalid_risk:${mutation.id}`)
    if (!isCommandCategory(mutation.commandCategory)) {
      reasons.push(`invalid_command_category:${mutation.id}`)
    }

    const coveredComponentKeys = mutation.coveredComponentKeys ?? [mutation.componentKey]
    if (coveredComponentKeys.length === 0) reasons.push(`covered_components_missing:${mutation.id}`)
    if (!coveredComponentKeys.includes(mutation.componentKey)) {
      reasons.push(`primary_component_not_covered:${mutation.id}`)
    }
    if (new Set(coveredComponentKeys).size !== coveredComponentKeys.length) {
      reasons.push(`duplicate_covered_component:${mutation.id}`)
    }
    for (const componentKey of coveredComponentKeys) {
      if (!plan.componentKeys.includes(componentKey)) {
        reasons.push(`covered_component_unrequested:${mutation.id}:${componentKey}`)
      }
      if (coveredByMutation.has(componentKey)) {
        reasons.push(`covered_component_overlap:${componentKey}`)
      }
      coveredByMutation.add(componentKey)
    }

    if (mutation.targetPath !== null && !path.isAbsolute(mutation.targetPath)) {
      reasons.push(`target_not_absolute:${mutation.id}`)
    }
    for (const target of mutation.additionalFenceTargets ?? []) {
      if (!isMutationDomainKind(target.domainKind)) {
        reasons.push(`invalid_additional_fence_domain_kind:${mutation.id}`)
      }
      if (!path.isAbsolute(target.targetPath)) {
        reasons.push(`additional_fence_target_not_absolute:${mutation.id}`)
      }
    }
    if (mutation.ownershipTransferFrom !== undefined) {
      const source = mutation.ownershipTransferFrom
      if (!path.isAbsolute(source.targetPath)) reasons.push(`transfer_target_not_absolute:${mutation.id}`)
      const aggregateTransfer = (mutation.coveredComponentKeys?.length ?? 1) > 1
        && mutation.coveredComponentKeys?.includes(mutation.componentKey)
      const movesPhysicalTarget = mutation.targetPath !== source.targetPath
      if (movesPhysicalTarget && !aggregateTransfer
        && !mutation.additionalFenceTargets?.some(target => (
          target.targetPath === source.targetPath && target.domainKind === mutation.domainKind
        ))) {
        reasons.push(`transfer_source_fence_missing:${mutation.id}`)
      }
      if (!movesPhysicalTarget && mutation.ownershipSelector === source.ownershipSelector) {
        reasons.push(`transfer_identity_unchanged:${mutation.id}`)
      }
      if (!/^[a-f0-9]{64}$/.test(source.ownedFragmentHash)) reasons.push(`transfer_hash_invalid:${mutation.id}`)
      if (!Number.isInteger(source.selectorSchemaVersion) || source.selectorSchemaVersion < 1) {
        reasons.push(`transfer_schema_invalid:${mutation.id}`)
      }
      if (mutation.action !== 'create'
        && !(aggregateTransfer && (mutation.action === 'invoke' || mutation.action === 'update'))) {
        reasons.push(`transfer_action_invalid:${mutation.id}`)
      }
    }
    const commands = mutation.commands ?? (mutation.command ? [mutation.command] : [])
    if (mutation.command !== undefined && mutation.commands !== undefined) {
      reasons.push(`duplicate_command_sources:${mutation.id}`)
    }
    if (mutation.action === 'invoke') {
      if (commands.length === 0) reasons.push(`command_missing:${mutation.id}`)
      if (mutation.commandCategory === 'none' || mutation.commandCategory === 'file_write') {
        reasons.push(`invalid_invoke_category:${mutation.id}`)
      }
    } else if (commands.length > 0) {
      reasons.push(`unexpected_command:${mutation.id}`)
    }
    if (commands.length > 0) {
      if (mutation.commands !== undefined && mutation.commands.length === 0) {
        reasons.push(`commands_empty:${mutation.id}`)
      }
      for (const [index, command] of commands.entries()) {
        const suffix = mutation.commands === undefined ? mutation.id : `${mutation.id}:${index}`
        if (!isCommandCategory(command.category)) reasons.push(`invalid_command_category:${suffix}`)
        if (!path.isAbsolute(command.executablePath)) reasons.push(`executable_not_absolute:${suffix}`)
        if (command.args.some(arg => typeof arg !== 'string')) reasons.push(`invalid_command_args:${suffix}`)
      }
      const aggregateCategory = maximumCommandCategory(commands.map(command => command.category))
      if (aggregateCategory !== mutation.commandCategory) reasons.push(`command_category_mismatch:${mutation.id}`)
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
        coveredComponentKeys: mutation.coveredComponentKeys === undefined
          ? undefined
          : [...mutation.coveredComponentKeys].sort(),
        targetPath: mutation.targetPath === null ? null : path.resolve(mutation.targetPath),
        additionalFenceTargets: mutation.additionalFenceTargets === undefined
          ? undefined
          : [...mutation.additionalFenceTargets]
              .map(target => ({ ...target, targetPath: path.resolve(target.targetPath) }))
              .sort((left, right) => `${left.domainKind}:${left.targetPath}`.localeCompare(`${right.domainKind}:${right.targetPath}`)),
        ownershipTransferFrom: mutation.ownershipTransferFrom === undefined
          ? undefined
          : {
              ...mutation.ownershipTransferFrom,
              targetPath: path.resolve(mutation.ownershipTransferFrom.targetPath),
            },
        command: mutation.command === undefined
          ? undefined
          : { ...mutation.command, args: [...mutation.command.args] },
        commands: mutation.commands === undefined
          ? undefined
          : mutation.commands.map(command => ({ ...command, args: [...command.args] })),
        safeResumeStates: mutation.safeResumeStates === undefined
          ? undefined
          : mutation.safeResumeStates.map(state => ({
              fingerprint: state.fingerprint,
              completedStepIds: [...state.completedStepIds],
            })),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
}

const COMMAND_CATEGORY_ORDER: readonly CommandCategory[] = [
  'none',
  'file_write',
  'host_cli',
  'plugin_install',
  'host_trust',
  'admin',
]

function isMutationRisk(value: unknown): value is MutationRisk {
  return typeof value === 'string' && Object.hasOwn(RISK_ORDER, value)
}

function isComponentKey(value: unknown): value is ComponentKey {
  return typeof value === 'string' && COMPONENT_KEYS.includes(value as ComponentKey)
}

function isPlanOperation(value: unknown): value is PlanOperation {
  return typeof value === 'string' && PLAN_OPERATIONS.includes(value as PlanOperation)
}

function isCommandCategory(value: unknown): value is CommandCategory {
  return typeof value === 'string' && COMMAND_CATEGORY_ORDER.includes(value as CommandCategory)
}

function isPlanMutationAction(value: unknown): value is ExecutionMutationPlan['action'] {
  return typeof value === 'string' && PLAN_MUTATION_ACTIONS.includes(value as ExecutionMutationPlan['action'])
}

function maximumCommandCategory(categories: readonly CommandCategory[]): CommandCategory {
  return categories.reduce((maximum, category) => (
    COMMAND_CATEGORY_ORDER.indexOf(category) > COMMAND_CATEGORY_ORDER.indexOf(maximum) ? category : maximum
  ), 'none' as CommandCategory)
}
