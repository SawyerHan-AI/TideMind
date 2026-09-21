import fs from 'node:fs'
import path from 'node:path'
import { sha256Bytes, sha256Json } from '../fingerprint'
import {
  ensureSafeParentDirectoryWithinRoot,
  inspectRegularFileWithinRoot,
  writeRegularFileAtomicCas,
  type FileFingerprint,
} from '../safe-file'
import { createManagedTextHostAdapter, type ManagedTextHostSpec } from './managed-text-adapter'
import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AdoptableArtifactObservation,
  AgentHostAdapter,
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../types'

const LEGACY_BODY_HASH = 'dea4c1d1f764d671de393b2056a0e57f091a49ae34f35390491caf11551f8c1f'
const LEGACY_DESCRIPTION = 'Tide Mind 外部记忆系统。用户上下文在每次会话开始时通过 Hook 自动加载（在第一条消息前注入）。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。'
const SELECTOR_SCHEMA_VERSION = 1

interface KimiInstructionMetadata {
  kind: 'kimi_instruction_migration' | 'kimi_instruction_remove'
  targetCanonicalPath: string
  targetBeforeHash: string | null
  desiredContent: string | null
  desiredHash: string | null
  legacyCanonicalPath: string | null
  legacyHash: string | null
  intermediateFingerprint: string | null
}

interface LegacySkillInspection {
  file: FileFingerprint
  exact: boolean
}

/**
 * Kimi 0.2.91 used an identity-specific Skill directory. This wrapper keeps
 * ordinary managed-text behavior, but gives that one released shape a
 * journaled ownership transfer to the 0.2.92 stable path and exact removal.
 */
export function createKimiCodeInstructionHostAdapter(spec: ManagedTextHostSpec): AgentHostAdapter {
  const base = createManagedTextHostAdapter(spec)

  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const current = await base.inspect(context)
    const component = current.components[0]
    if (component.visibility !== 'absent') return current
    try {
      const legacy = inspectLegacySkill(context)
      if (!legacy.file.exists) return current
      return {
        ...current,
        components: [{
          ...component,
          visibility: legacy.exact ? 'dedicated' : 'unknown',
          observedTarget: legacy.file.canonicalPath,
          observedFragmentHash: legacy.file.containerHash ?? undefined,
        }],
        provenance: [...new Set([...current.provenance, legacy.file.canonicalPath])],
        diagnostics: legacy.exact
          ? [...current.diagnostics, 'legacy_0_2_91_kimi_instruction_visible']
          : [...current.diagnostics, 'legacy_0_2_91_kimi_instruction_not_exact'],
      }
    } catch (error) {
      return {
        ...current,
        components: [{ ...component, visibility: 'unknown' }],
        diagnostics: [...current.diagnostics, error instanceof Error ? error.message : String(error)],
      }
    }
  }

  const plan = async (context: AdapterOperationContext, request: AdapterPlanRequest): Promise<AdapterPlan> => {
    if (!request.desiredComponents.includes(spec.componentKey)) return base.plan(context, request)
    const legacyPath = legacySkillPath(context)
    const legacyBaseline = baselineFor(request.ownedArtifacts, legacyPath)
    if (!legacyBaseline) {
      const legacy = inspectLegacySkill(context)
      if (legacy.file.exists && spec.targetFile(context) !== legacy.file.canonicalPath) {
        return blockedPlan(context, spec, legacy.exact
          ? 'legacy_kimi_instruction_has_no_ownership_evidence'
          : 'legacy_kimi_instruction_requires_user_review')
      }
      return base.plan(context, request)
    }

    const legacy = inspectLegacySkill(context)
    const target = inspectRegularFileWithinRoot(spec.targetFile(context), spec.allowedRoot(context))
    if (!legacy.exact || legacy.file.containerHash !== legacyBaseline.ownedFragmentHash) {
      return blockedPlan(context, spec, 'legacy_kimi_instruction_changed_before_migration')
    }
    if (target.exists) return blockedPlan(context, spec, 'kimi_instruction_target_conflict')

    const desiredContent = normalizeContent(spec.content(context))
    const desiredHash = sha256Bytes(desiredContent)
    const intermediateFingerprint = migrationIntermediateFingerprint(desiredHash, legacyBaseline.ownedFragmentHash)
    const metadata: KimiInstructionMetadata = {
      kind: 'kimi_instruction_migration',
      targetCanonicalPath: target.canonicalPath,
      targetBeforeHash: null,
      desiredContent,
      desiredHash,
      legacyCanonicalPath: legacy.file.canonicalPath,
      legacyHash: legacyBaseline.ownedFragmentHash,
      intermediateFingerprint,
    }
    return {
      catalogId: spec.catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      mutations: [{
        operationId: `${context.operationId}:instruction:legacy-0.2.91-migration`,
        componentKey: spec.componentKey,
        operation: 'create',
        domainKind: 'file_fragment',
        physicalTarget: spec.targetFile(context),
        ownershipKey: 'document',
        selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
        additionalFenceTargets: [{ domainKind: 'file_fragment', physicalTarget: legacy.file.canonicalPath }],
        ownershipTransferFrom: {
          physicalTarget: legacy.file.canonicalPath,
          ownershipKey: legacyBaseline.ownershipKey,
          ownedFragmentHash: legacyBaseline.ownedFragmentHash,
          selectorSchemaVersion: legacyBaseline.selectorSchemaVersion ?? SELECTOR_SCHEMA_VERSION,
        },
        risk: 'low',
        reload: spec.reload,
        commandCategory: 'file_write',
        desiredFragmentHash: desiredHash,
        safeResumeStates: [{ fingerprint: intermediateFingerprint, completedStepIds: ['create_new_skill'] }],
        idempotent: true,
        metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
      }],
      requiredUserActions: [],
      diagnostics: [],
    }
  }

  const disconnect = async (
    context: AdapterOperationContext,
    request: Parameters<AgentHostAdapter['disconnect']>[1],
  ): Promise<AdapterPlan> => {
    if (!request.componentKeys.includes(spec.componentKey)) return emptyPlan(context, spec)
    const target = inspectRegularFileWithinRoot(spec.targetFile(context), spec.allowedRoot(context))
    if (!target.exists) return emptyPlan(context, spec)
    const baseline = baselineFor(request.ownedArtifacts, target.canonicalPath)
    if (!baseline || baseline.ownedFragmentHash !== target.containerHash) {
      return blockedPlan(context, spec, 'remove_requires_exact_owned_kimi_instruction')
    }
    const desiredHash = sha256Bytes(normalizeContent(spec.content(context)))
    if (target.containerHash !== desiredHash) {
      return blockedPlan(context, spec, 'owned_kimi_instruction_modified')
    }
    const metadata: KimiInstructionMetadata = {
      kind: 'kimi_instruction_remove',
      targetCanonicalPath: target.canonicalPath,
      targetBeforeHash: target.containerHash,
      desiredContent: null,
      desiredHash: null,
      legacyCanonicalPath: null,
      legacyHash: null,
      intermediateFingerprint: null,
    }
    return {
      ...emptyPlan(context, spec),
      mutations: [{
        operationId: `${context.operationId}:instruction:remove`,
        componentKey: spec.componentKey,
        operation: 'remove',
        domainKind: 'file_fragment',
        physicalTarget: spec.targetFile(context),
        ownershipKey: 'document',
        selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
        risk: 'low',
        reload: spec.reload,
        commandCategory: 'file_write',
        preconditionHash: target.containerHash ?? undefined,
        containerPreconditionHash: target.containerHash ?? undefined,
        idempotent: true,
        metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
      }],
    }
  }

  const readBack = async (context: AdapterOperationContext, mutation: PlannedMutation): Promise<MutationReadBack> => {
    if (!isKimiInstructionMutation(mutation)) return base.readBack(context, mutation)
    const metadata = parseMetadata(mutation)
    try {
      const target = inspectRegularFileWithinRoot(mutation.physicalTarget, spec.allowedRoot(context))
      if (target.canonicalPath !== metadata.targetCanonicalPath) throw new Error('kimi_instruction_target_path_changed')
      if (metadata.kind === 'kimi_instruction_remove') {
        return {
          operationId: mutation.operationId,
          observed: target.exists,
          matchesDesired: !target.exists,
          observedFragmentHash: target.containerHash ?? undefined,
          visibility: target.exists ? 'dedicated' : 'absent',
          diagnostics: [],
        }
      }
      const legacy = inspectLegacySkill(context)
      const targetExact = target.containerHash === metadata.desiredHash
      const legacyExact = legacy.exact && legacy.file.containerHash === metadata.legacyHash
      if (targetExact && !legacy.file.exists) {
        return {
          operationId: mutation.operationId,
          observed: true,
          matchesDesired: true,
          observedFragmentHash: metadata.desiredHash ?? undefined,
          visibility: 'dedicated',
          diagnostics: [],
        }
      }
      if (!target.exists && legacyExact) {
        return {
          operationId: mutation.operationId,
          observed: false,
          matchesDesired: false,
          visibility: 'absent',
          diagnostics: ['legacy_0_2_91_kimi_instruction_before_migration'],
        }
      }
      if (targetExact && legacyExact && metadata.intermediateFingerprint) {
        return {
          operationId: mutation.operationId,
          observed: true,
          matchesDesired: false,
          observedFragmentHash: metadata.intermediateFingerprint,
          safeToResumeFrom: {
            fingerprint: metadata.intermediateFingerprint,
            completedStepIds: ['create_new_skill'],
          },
          visibility: 'unknown',
          diagnostics: ['legacy_0_2_91_kimi_instruction_partial_migration'],
        }
      }
      return {
        operationId: mutation.operationId,
        observed: target.exists || legacy.file.exists,
        matchesDesired: false,
        observedFragmentHash: sha256Json({
          target: target.containerHash,
          legacy: legacy.file.containerHash,
          legacyExact,
        }),
        visibility: 'unknown',
        diagnostics: ['kimi_instruction_migration_state_conflict'],
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
  }

  const apply = async (context: AdapterOperationContext, mutation: PlannedMutation) => {
    if (!isKimiInstructionMutation(mutation)) return base.apply(context, mutation)
    const metadata = parseMetadata(mutation)
    if (metadata.kind === 'kimi_instruction_remove') {
      assertRemoveMutation(context, spec, mutation, metadata)
      removeExactFile(context, spec, mutation.physicalTarget, metadata.targetCanonicalPath, metadata.targetBeforeHash)
    } else {
      assertMigrationMutation(context, spec, mutation, metadata)
      const legacy = inspectLegacySkill(context)
      if (!legacy.exact || legacy.file.containerHash !== metadata.legacyHash) {
        throw new Error('legacy_kimi_instruction_precondition_changed')
      }
      const target = inspectRegularFileWithinRoot(mutation.physicalTarget, spec.allowedRoot(context))
      if (target.containerHash === null) {
        ensureSafeParentDirectoryWithinRoot(mutation.physicalTarget, spec.allowedRoot(context))
        writeRegularFileAtomicCas(mutation.physicalTarget, metadata.desiredContent!, {
          expectedContainerHash: null,
          expectedCanonicalPath: metadata.targetCanonicalPath,
          createMode: 0o600,
        })
      } else if (target.containerHash !== metadata.desiredHash) {
        throw new Error('kimi_instruction_target_conflict')
      }
      removeExactFile(
        context,
        spec,
        legacySkillPath(context),
        metadata.legacyCanonicalPath!,
        metadata.legacyHash,
      )
    }
    const after = await readBack(context, mutation)
    if (!after.matchesDesired) throw new Error('kimi_instruction_readback_mismatch')
    return {
      operationId: mutation.operationId,
      effectObserved: true,
      postEffectFingerprint: after.observedFragmentHash,
    }
  }

  return {
    ...base,
    inspect,
    async inspectAdoptableArtifacts(context): Promise<readonly AdoptableArtifactObservation[]> {
      const legacy = inspectLegacySkill(context)
      if (!legacy.exact || !legacy.file.containerHash) return []
      return [{
        componentKey: spec.componentKey,
        artifactType: spec.artifactType,
        domainKind: 'file_fragment',
        physicalTarget: legacy.file.canonicalPath,
        ownershipKey: 'document',
        selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
        projectionVersion: context.runtime.projectionVersion,
        containerHash: legacy.file.containerHash,
        fragmentHash: legacy.file.containerHash,
        identityAssertion: context.agentId,
        discoverReachability: 'dedicated',
      }]
    },
    plan,
    disconnect,
    apply,
    readBack,
  }
}

function inspectLegacySkill(context: AdapterOperationContext): LegacySkillInspection {
  const file = inspectRegularFileWithinRoot(legacySkillPath(context), legacySkillsRoot(context))
  if (!file.exists) return { file, exact: false }
  const content = fs.readFileSync(file.canonicalPath, 'utf8')
  const prefix = legacyFrontmatter(context.agentId)
  return {
    file,
    exact: content.startsWith(prefix)
      && sha256Bytes(content.slice(prefix.length)) === LEGACY_BODY_HASH,
  }
}

function legacyFrontmatter(agentId: string): string {
  return ['---', `name: tidemind-${agentId}`, `description: ${JSON.stringify(LEGACY_DESCRIPTION)}`, '---', ''].join('\n')
}

function legacySkillsRoot(context: AdapterOperationContext): string {
  return path.join(context.installation.canonicalConfigRoot, 'skills')
}

function legacySkillPath(context: AdapterOperationContext): string {
  return path.join(legacySkillsRoot(context), `tidemind-${context.agentId}`, 'SKILL.md')
}

function baselineFor(artifacts: readonly OwnedArtifactBaseline[], target: string): OwnedArtifactBaseline | undefined {
  return artifacts.find(artifact => artifact.componentKey === 'instruction'
    && path.resolve(artifact.physicalTarget) === path.resolve(target)
    && artifact.ownershipKey === 'document')
}

function emptyPlan(context: AdapterOperationContext, spec: ManagedTextHostSpec): AdapterPlan {
  return {
    catalogId: spec.catalogId,
    installationKey: context.installation.installKey,
    adapterVersion: spec.adapterVersion,
    projectionVersion: context.runtime.projectionVersion,
    mutations: [],
    requiredUserActions: [],
    diagnostics: [],
  }
}

function blockedPlan(context: AdapterOperationContext, spec: ManagedTextHostSpec, reason: string): AdapterPlan {
  const actionReason = reason === 'legacy_kimi_instruction_has_no_ownership_evidence'
    ? 'legacy_unowned'
    : reason === 'legacy_kimi_instruction_requires_user_review'
      ? 'legacy_not_exact'
      : reason === 'legacy_kimi_instruction_changed_before_migration'
        ? 'legacy_changed'
        : 'target_occupied'
  const sourcePath = legacySkillPath(context)
  const targetPath = spec.targetFile(context)
  let targetVisibility: 'absent' | 'dedicated' | 'unknown'
  try {
    targetVisibility = inspectRegularFileWithinRoot(targetPath, spec.allowedRoot(context)).exists
      ? 'dedicated'
      : 'absent'
  } catch {
    // Unsafe or unreadable target state must remain a hard verification
    // failure; it is not equivalent to the user simply not creating a file.
    targetVisibility = 'unknown'
  }
  return {
    ...emptyPlan(context, spec),
    requiredUserActions: ['review_kimi_instruction_migration_conflict'],
    requiredUserActionDetails: [{
      kind: 'kimi_instruction_conflict',
      componentKey: 'instruction',
      operation: 'connect',
      reason: actionReason,
      sourcePath,
      targetPath,
      targetVisibility,
      instruction: 'Tide Mind did not change either Skill because the legacy and managed Skill paths cannot be migrated safely.',
      steps: [
        `Review the legacy Skill at ${sourcePath} and the managed target at ${targetPath}.`,
        'Keep any content you need by moving or renaming the file that Tide Mind must not manage. Tide Mind will not overwrite or delete an unproven file.',
        'Return to Tide Mind and run Check again.',
      ],
    }],
    diagnostics: [reason],
  }
}

function normalizeContent(content: string): string {
  return `${content.replace(/\s+$/u, '')}\n`
}

function migrationIntermediateFingerprint(desiredHash: string, legacyHash: string): string {
  return sha256Json({ state: 'new_written_legacy_present', desiredHash, legacyHash })
}

function parseMetadata(mutation: PlannedMutation): KimiInstructionMetadata {
  const value = mutation.metadata as unknown as Partial<KimiInstructionMetadata> | undefined
  if (!value
    || (value.kind !== 'kimi_instruction_migration' && value.kind !== 'kimi_instruction_remove')
    || typeof value.targetCanonicalPath !== 'string'
    || !(value.targetBeforeHash === null || typeof value.targetBeforeHash === 'string')
    || !(value.desiredContent === null || typeof value.desiredContent === 'string')
    || !(value.desiredHash === null || typeof value.desiredHash === 'string')
    || !(value.legacyCanonicalPath === null || typeof value.legacyCanonicalPath === 'string')
    || !(value.legacyHash === null || typeof value.legacyHash === 'string')
    || !(value.intermediateFingerprint === null || typeof value.intermediateFingerprint === 'string')) {
    throw new Error(`Invalid Kimi instruction mutation metadata: ${mutation.operationId}`)
  }
  return value as KimiInstructionMetadata
}

function isKimiInstructionMutation(mutation: PlannedMutation): boolean {
  return mutation.metadata?.kind === 'kimi_instruction_migration'
    || mutation.metadata?.kind === 'kimi_instruction_remove'
}

function assertMigrationMutation(
  context: AdapterOperationContext,
  spec: ManagedTextHostSpec,
  mutation: PlannedMutation,
  metadata: KimiInstructionMetadata,
): void {
  const transfer = mutation.ownershipTransferFrom
  const source = legacySkillPath(context)
  if (metadata.kind !== 'kimi_instruction_migration'
    || mutation.operation !== 'create'
    || mutation.componentKey !== 'instruction'
    || mutation.physicalTarget !== spec.targetFile(context)
    || mutation.ownershipKey !== 'document'
    || mutation.preconditionHash !== undefined
    || mutation.containerPreconditionHash !== undefined
    || metadata.targetBeforeHash !== null
    || metadata.targetCanonicalPath !== inspectRegularFileWithinRoot(mutation.physicalTarget, spec.allowedRoot(context)).canonicalPath
    || metadata.legacyCanonicalPath !== inspectRegularFileWithinRoot(source, legacySkillsRoot(context)).canonicalPath
    || !transfer
    || transfer.physicalTarget !== metadata.legacyCanonicalPath
    || transfer.ownershipKey !== 'document'
    || transfer.ownedFragmentHash !== metadata.legacyHash
    || mutation.additionalFenceTargets?.length !== 1
    || mutation.additionalFenceTargets[0].physicalTarget !== metadata.legacyCanonicalPath
    || mutation.additionalFenceTargets[0].domainKind !== mutation.domainKind
    || metadata.desiredContent === null
    || metadata.desiredHash !== sha256Bytes(metadata.desiredContent)
    || mutation.desiredFragmentHash !== metadata.desiredHash
    || metadata.intermediateFingerprint !== migrationIntermediateFingerprint(metadata.desiredHash, metadata.legacyHash!)
    || mutation.safeResumeStates?.length !== 1
    || mutation.safeResumeStates[0].fingerprint !== metadata.intermediateFingerprint
    || mutation.safeResumeStates[0].completedStepIds.join('\0') !== 'create_new_skill') {
    throw new Error('kimi_instruction_migration_not_frozen')
  }
}

function assertRemoveMutation(
  context: AdapterOperationContext,
  spec: ManagedTextHostSpec,
  mutation: PlannedMutation,
  metadata: KimiInstructionMetadata,
): void {
  if (metadata.kind !== 'kimi_instruction_remove'
    || mutation.operation !== 'remove'
    || mutation.componentKey !== 'instruction'
    || mutation.physicalTarget !== spec.targetFile(context)
    || mutation.ownershipKey !== 'document'
    || mutation.ownershipTransferFrom !== undefined
    || (mutation.additionalFenceTargets?.length ?? 0) !== 0
    || metadata.targetCanonicalPath !== inspectRegularFileWithinRoot(mutation.physicalTarget, spec.allowedRoot(context)).canonicalPath
    || metadata.targetBeforeHash === null
    || mutation.preconditionHash !== metadata.targetBeforeHash
    || mutation.containerPreconditionHash !== metadata.targetBeforeHash
    || metadata.desiredContent !== null
    || metadata.desiredHash !== null
    || metadata.legacyCanonicalPath !== null
    || metadata.legacyHash !== null
    || metadata.intermediateFingerprint !== null) {
    throw new Error('kimi_instruction_remove_not_frozen')
  }
}

function removeExactFile(
  context: AdapterOperationContext,
  spec: ManagedTextHostSpec,
  target: string,
  expectedCanonicalPath: string,
  expectedHash: string | null,
): void {
  if (!expectedHash) throw new Error('kimi_instruction_remove_hash_missing')
  const current = inspectRegularFileWithinRoot(target, spec.allowedRoot(context))
  if (current.canonicalPath !== expectedCanonicalPath || current.containerHash !== expectedHash) {
    throw new Error('kimi_instruction_remove_precondition_changed')
  }
  const final = inspectRegularFileWithinRoot(target, spec.allowedRoot(context))
  if (final.canonicalPath !== expectedCanonicalPath || final.containerHash !== expectedHash) {
    throw new Error('kimi_instruction_remove_cas_conflict')
  }
  fs.unlinkSync(final.canonicalPath)
  const directory = path.dirname(final.canonicalPath)
  if (fs.readdirSync(directory).length === 0) {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('kimi_instruction_remove_parent_symlink')
    fs.rmdirSync(directory)
  }
}
