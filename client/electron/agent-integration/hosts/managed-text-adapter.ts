import fs from 'node:fs'
import path from 'node:path'
import { sha256Bytes } from '../fingerprint'
import {
  inspectRegularFile,
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
  ArtifactComponentType,
  ComponentKey,
  ComponentVerificationResult,
  JsonValue,
  MutationReadBack,
  PlannedMutation,
  ReloadRequirement,
} from '../types'

interface ManagedTextMetadata {
  canonicalPath: string
  desiredContent: string | null
}

export interface ManagedTextHostSpec {
  catalogId: CatalogId
  adapterVersion: string
  componentKey: ComponentKey
  artifactType: ArtifactComponentType
  targetFile(context: AdapterOperationContext): string
  allowedRoot(context: AdapterOperationContext): string
  content(context: AdapterOperationContext): string
  reload: ReloadRequirement
  detect?(context: AdapterOperationContext): boolean
}

export function createManagedTextHostAdapter(spec: ManagedTextHostSpec): AgentHostAdapter {
  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const target = spec.targetFile(context)
    const diagnostics: string[] = []
    let visibility: 'absent' | 'dedicated' | 'unknown' = 'absent'
    let observedTarget: string | undefined
    let observedFragmentHash: string | undefined
    try {
      const file = inspectTextTarget(target, spec.allowedRoot(context))
      observedTarget = file.canonicalPath
      if (file.exists) {
        visibility = 'dedicated'
        observedFragmentHash = file.containerHash ?? undefined
      }
    } catch (error) {
      visibility = 'unknown'
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
    return {
      catalogId: spec.catalogId,
      detected: spec.detect?.(context) ?? defaultDetected(context),
      distribution: { ...context.installation.distribution },
      components: [{
        componentKey: spec.componentKey,
        visibility,
        verificationStatus: 'unverified',
        observedTarget,
        observedFragmentHash,
      }],
      provenance: [target],
      diagnostics,
    }
  }

  const buildPlan = (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    remove: boolean,
  ): AdapterPlan => {
    const target = spec.targetFile(context)
    const inspection = inspectTextTarget(target, spec.allowedRoot(context))
    const baseline = request.ownedArtifacts.find(artifact =>
      artifact.componentKey === spec.componentKey
      && path.resolve(artifact.physicalTarget) === path.resolve(target)
      && artifact.ownershipKey === 'document',
    )
    const desiredContent = remove ? null : normalizeContent(spec.content(context))
    const desiredHash = desiredContent === null ? null : sha256Bytes(desiredContent)
    const liveHash = inspection.containerHash
    const diagnostics: string[] = []
    const requiredUserActions: string[] = []
    let operation: PlannedMutation['operation'] | null = null

    if (!request.observed.detected) diagnostics.push('host_not_detected')
    else if (!request.desiredComponents.includes(spec.componentKey)) diagnostics.push('component_not_requested')
    else if (desiredContent === null) {
      if (!inspection.exists) operation = null
      else if (!baseline || baseline.ownedFragmentHash !== liveHash) diagnostics.push('remove_requires_exact_owned_document')
      else {
        // Node has no portable unlinkat/dirfd API. Even an exact hash and
        // canonical read-back cannot close the final parent-symlink swap.
        diagnostics.push('managed_text_manual_cleanup_required')
        requiredUserActions.push('manually_remove_owned_document')
      }
    } else if (!inspection.exists) {
      operation = 'create'
    } else if (!baseline) {
      diagnostics.push(liveHash === desiredHash
        ? 'matching_document_has_no_ownership_evidence'
        : 'target_document_already_exists')
    } else if (baseline.ownedFragmentHash !== liveHash) {
      diagnostics.push('owned_document_modified')
    } else if (liveHash !== desiredHash) {
      operation = 'update'
    }

    const mutations: PlannedMutation[] = operation === null ? [] : [{
      operationId: `${context.operationId}:${spec.componentKey}`,
      componentKey: spec.componentKey,
      operation,
      domainKind: 'file_fragment',
      physicalTarget: target,
      ownershipKey: 'document',
      selectorSchemaVersion: 1,
      risk: 'low',
      reload: spec.reload,
      commandCategory: 'file_write',
      preconditionHash: liveHash ?? undefined,
      containerPreconditionHash: liveHash ?? undefined,
      desiredFragmentHash: desiredHash ?? undefined,
      idempotent: true,
      metadata: {
        canonicalPath: inspection.canonicalPath,
        desiredContent,
      } as unknown as Readonly<Record<string, JsonValue>>,
    }]

    return {
      catalogId: spec.catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      mutations,
      requiredUserActions,
      diagnostics,
    }
  }

  return {
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    componentKeys: [spec.componentKey],
    implementationTypes: { [spec.componentKey]: [spec.artifactType] },
    inspect,
    async inspectAdoptableArtifacts(context): Promise<readonly AdoptableArtifactObservation[]> {
      try {
        const target = spec.targetFile(context)
        const file = inspectTextTarget(target, spec.allowedRoot(context))
        const desiredHash = sha256Bytes(normalizeContent(spec.content(context)))
        if (!file.exists || file.containerHash !== desiredHash) return []
        return [{
          componentKey: spec.componentKey,
          artifactType: spec.artifactType,
          domainKind: 'file_fragment',
          physicalTarget: file.canonicalPath,
          ownershipKey: 'document',
          selectorSchemaVersion: 1,
          projectionVersion: context.runtime.projectionVersion,
          containerHash: file.containerHash,
          fragmentHash: file.containerHash,
          discoverReachability: 'shared_visible',
        }]
      } catch {
        return []
      }
    },
    async plan(context, request) { return buildPlan(context, request, false) },
    async disconnect(context, request) {
      return buildPlan(context, {
        desiredCapability: 0,
        desiredComponents: request.componentKeys,
        observed: request.observed,
        ownedArtifacts: request.ownedArtifacts,
      }, true)
    },
    async apply(context, mutation) {
      const metadata = parseMetadata(mutation)
      const allowedRoot = spec.allowedRoot(context)
      assertManagedPath(mutation.physicalTarget, allowedRoot)
      assertManagedAncestorChain(mutation.physicalTarget, allowedRoot)
      if (mutation.operation === 'remove') {
        throw new Error('managed_text_automatic_remove_unsupported')
      }
      if (metadata.desiredContent === null) throw new Error('managed_text_content_missing')
      ensureSafeParentDirectory(mutation.physicalTarget, spec.allowedRoot(context))
      writeRegularFileAtomicCas(mutation.physicalTarget, metadata.desiredContent, {
        expectedContainerHash: mutation.containerPreconditionHash ?? null,
        expectedCanonicalPath: metadata.canonicalPath,
      })
      const after = inspectRegularFile(mutation.physicalTarget)
      if (after.containerHash !== mutation.desiredFragmentHash) throw new Error('managed_text_readback_mismatch')
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: after.containerHash ?? undefined,
      }
    },
    async readBack(context, mutation): Promise<MutationReadBack> {
      const metadata = parseMetadata(mutation)
      try {
        const file = inspectRegularFileWithinRoot(
          mutation.physicalTarget,
          spec.allowedRoot(context),
        )
        if (file.canonicalPath !== metadata.canonicalPath) {
          throw new Error('managed_text_canonical_path_changed')
        }
        const desiredAbsent = mutation.operation === 'remove'
        return {
          operationId: mutation.operationId,
          observed: file.exists,
          matchesDesired: desiredAbsent ? !file.exists : file.containerHash === mutation.desiredFragmentHash,
          observedFragmentHash: file.containerHash ?? undefined,
          visibility: file.exists ? 'dedicated' : 'absent',
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
      if (!request.componentKeys.includes(spec.componentKey)) return []
      const observation = (await inspect(context)).components[0]
      if (request.expectedCapability === 0 && observation.visibility === 'absent') {
        return [{
          componentKey: spec.componentKey,
          status: 'verified',
          verifiedCapability: 0,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['disconnect_static_readback_verified'],
        }]
      }
      if (observation.visibility !== 'dedicated') {
        return [{
          componentKey: spec.componentKey,
          status: 'failed',
          verifiedCapability: null,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['managed_document_not_visible'],
        }]
      }
      return [{
        componentKey: spec.componentKey,
        status: 'unverified',
        verifiedCapability: null,
        evidenceHash: observation.observedFragmentHash,
        identityAssertion: context.agentId,
        invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'reload_generation'],
        diagnostics: ['static_readback_passed_host_recognition_probe_required'],
      }]
    },
  }
}

function normalizeContent(content: string): string {
  return `${content.replace(/\s+$/u, '')}\n`
}

function defaultDetected(context: AdapterOperationContext): boolean {
  return fs.existsSync(context.installation.canonicalConfigRoot)
    || Boolean(context.installation.distribution.executableRealpath)
}

function parseMetadata(mutation: PlannedMutation): ManagedTextMetadata {
  const value = mutation.metadata as unknown as Partial<ManagedTextMetadata> | undefined
  if (!value || typeof value.canonicalPath !== 'string'
    || (value.desiredContent !== null && typeof value.desiredContent !== 'string')) {
    throw new Error(`Invalid managed text metadata: ${mutation.operationId}`)
  }
  return { canonicalPath: value.canonicalPath, desiredContent: value.desiredContent ?? null }
}

function assertManagedPath(target: string, allowedRoot: string): void {
  const relative = path.relative(path.resolve(allowedRoot), path.resolve(target))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('managed_text_target_outside_allowed_root')
  }
}

function inspectTextTarget(target: string, allowedRoot: string): FileFingerprint {
  assertManagedPath(target, allowedRoot)
  const parent = path.dirname(path.resolve(target))
  const canonicalParent = assertManagedAncestorChain(target, allowedRoot)
  if (fs.existsSync(parent)) return inspectRegularFile(target)
  return {
    canonicalPath: path.join(canonicalParent, path.basename(target)),
    exists: false,
    mode: null,
    containerHash: null,
    uid: null,
    gid: null,
    size: null,
    modifiedMs: null,
    inode: null,
  }
}

function ensureSafeParentDirectory(target: string, allowedRoot: string): void {
  assertManagedPath(target, allowedRoot)
  const parent = path.dirname(path.resolve(target))
  assertManagedAncestorChain(target, allowedRoot)
  const existingAncestors: string[] = []
  let cursor = parent
  while (cursor !== path.dirname(cursor) && !fs.existsSync(cursor)) {
    existingAncestors.push(cursor)
    cursor = path.dirname(cursor)
  }
  for (const ancestor of existingAncestors.reverse()) {
    fs.mkdirSync(ancestor)
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('managed_text_parent_symlink_rejected')
  }
  assertManagedAncestorChain(target, allowedRoot)
}

/**
 * Reject every existing symbolic-link component from the nearest existing
 * ancestor of the managed root through the target parent. Merely checking the
 * leaf parent is insufficient because a symlink can sit higher in the chain.
 */
function assertManagedAncestorChain(target: string, allowedRoot: string): string {
  const rootBoundary = path.dirname(path.resolve(allowedRoot))
  const parent = path.dirname(path.resolve(target))
  let anchor = rootBoundary
  while (!fs.existsSync(anchor)) {
    const next = path.dirname(anchor)
    if (next === anchor) throw new Error('managed_text_parent_unresolvable')
    anchor = next
  }

  const relative = path.relative(anchor, parent)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('managed_text_parent_outside_anchor')
  }

  let cursor = anchor
  const segments = relative === '' ? [] : relative.split(path.sep)
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    if (!fs.existsSync(cursor)) continue
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('managed_text_parent_symlink_rejected')
  }
  if (fs.lstatSync(anchor).isSymbolicLink()) throw new Error('managed_text_parent_symlink_rejected')
  return path.join(fs.realpathSync(anchor), relative)
}
