import fs from 'node:fs'
import path from 'node:path'
import { sha256Bytes, sha256Json } from '../fingerprint'
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
  ComponentVerificationResult,
  JsonValue,
  MutationReadBack,
  PlannedMutation,
} from '../types'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from './portable-skill'

const CURSOR_EVENTS = ['sessionStart', 'preCompact', 'sessionEnd'] as const
type CursorLifecycleEvent = typeof CURSOR_EVENTS[number]

const ADAPTER_VERSION = '1'
const SELECTOR_SCHEMA_VERSION = 1

interface CursorHookEntry {
  [key: string]: JsonValue
  command: string
  timeout: number
}

interface CursorLifecycleFragment {
  sessionStart: JsonValue | null
  preCompact: JsonValue | null
  sessionEnd: JsonValue | null
}

interface CursorLifecycleInspection {
  file: FileFingerprint
  fragmentExists: boolean
  complete: boolean
  fragment: CursorLifecycleFragment
  fragmentHash: string | null
}

interface CursorLifecycleMetadata {
  canonicalPath: string
  containerPreconditionHash: string | null
  liveFragmentHash: string | null
  ownedFragmentHash: string | null
  desiredFragment?: CursorLifecycleFragment
  remove: boolean
}

/**
 * Cursor executes user hooks from ~/.cursor/hooks.json through a shell. Keep
 * the managed selector at one uniquely marked member in each lifecycle event
 * array so user hooks and unrelated Cursor settings remain untouched.
 */
export function createCursorLifecycleHostAdapter(): AgentHostAdapter {
  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const target = cursorHooksFile(context)
    const diagnostics: string[] = []
    let visibility: 'absent' | 'dedicated' | 'unknown' = 'absent'
    let observedTarget: string | undefined
    let observedFragmentHash: string | undefined
    try {
      const projection = inspectCursorLifecycle(context)
      observedTarget = projection.file.canonicalPath
      if (projection.fragmentExists) {
        visibility = 'dedicated'
        observedFragmentHash = projection.fragmentHash ?? undefined
      }
    } catch (error) {
      visibility = 'unknown'
      diagnostics.push(errorMessage(error))
    }
    if (!runtimeAssetsPresent(context)) diagnostics.push('cursor_lifecycle_runtime_missing')
    const detected = defaultDetected(context, target)
    if (!detected) diagnostics.push('host_not_detected')
    return {
      catalogId: 'cursor-desktop',
      detected,
      detectedVersion: undefined,
      distribution: { ...context.installation.distribution },
      components: [{
        componentKey: 'lifecycle',
        visibility,
        verificationStatus: 'unverified',
        observedTarget,
        observedFragmentHash,
      }],
      provenance: [target, cursorLifecycleRuntimeScript(context)],
      diagnostics,
    }
  }

  return {
    catalogId: 'cursor-desktop',
    adapterVersion: ADAPTER_VERSION,
    componentKeys: ['lifecycle'],
    implementationTypes: { lifecycle: ['hook'] },
    componentContracts: {
      lifecycle: { deliveryMode: 'managed', artifactTypes: ['hook'], mutationDomain: 'file_fragment', reload: 'new_session' },
    },
    inspect,
    async inspectAdoptableArtifacts(context): Promise<readonly AdoptableArtifactObservation[]> {
      try {
        const projection = inspectCursorLifecycle(context)
        const desired = desiredFragment(context)
        const desiredHash = sha256Json(desired as unknown as JsonValue)
        if (!projection.complete || projection.fragmentHash !== desiredHash) return []
        return [{
          componentKey: 'lifecycle',
          artifactType: 'hook',
          domainKind: 'file_fragment',
          physicalTarget: projection.file.canonicalPath,
          ownershipKey: ownershipKey(context),
          selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
          projectionVersion: context.runtime.projectionVersion,
          containerHash: projection.file.containerHash ?? undefined,
          fragmentHash: desiredHash,
          identityAssertion: context.agentId,
          discoverReachability: 'dedicated',
        }]
      } catch {
        return []
      }
    },
    async plan(context, request) {
      return buildPlan(context, request, false)
    },
    async disconnect(context, request) {
      return buildPlan(context, {
        desiredCapability: 0,
        desiredComponents: request.componentKeys,
        observed: request.observed,
        ownedArtifacts: request.ownedArtifacts,
      }, true)
    },
    async apply(context, mutation) {
      assertLifecycleMutation(mutation)
      const metadata = parseMetadata(mutation)
      const before = inspectCursorLifecycle(context)
      if (before.file.canonicalPath !== metadata.canonicalPath) {
        throw new Error('cursor_hooks_canonical_path_changed')
      }
      if (before.file.containerHash !== metadata.containerPreconditionHash) {
        throw new Error('cursor_hooks_container_precondition_changed')
      }
      if (before.fragmentHash !== metadata.liveFragmentHash) {
        throw new Error('cursor_hooks_fragment_precondition_changed')
      }

      const document = before.file.exists
        ? parseJsonObject(before.file.canonicalPath)
        : { version: 1 }
      applyManagedMembers(document, context, metadata.remove ? undefined : metadata.desiredFragment)
      ensureSafeParentDirectoryWithinRoot(mutation.physicalTarget, context.installation.canonicalConfigRoot)
      writeRegularFileAtomicCas(mutation.physicalTarget, `${JSON.stringify(document, null, 2)}\n`, {
        expectedContainerHash: metadata.containerPreconditionHash,
        expectedCanonicalPath: metadata.canonicalPath,
      })
      const after = inspectCursorLifecycle(context)
      const expectedHash = mutation.desiredFragmentHash ?? null
      if (after.fragmentHash !== expectedHash) throw new Error('cursor_hooks_readback_mismatch')
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
      try {
        assertLifecycleMutation(mutation)
        const metadata = parseMetadata(mutation)
        const projection = inspectCursorLifecycle(context)
        if (projection.file.canonicalPath !== metadata.canonicalPath) {
          throw new Error('cursor_hooks_canonical_path_changed')
        }
        const expectedHash = mutation.desiredFragmentHash ?? null
        return {
          operationId: mutation.operationId,
          observed: projection.fragmentExists,
          matchesDesired: projection.fragmentHash === expectedHash,
          observedFragmentHash: projection.fragmentHash ?? undefined,
          visibility: projection.fragmentExists ? 'dedicated' : 'absent',
          diagnostics: [],
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
    async verify(
      context,
      request: AdapterVerificationRequest,
    ): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes('lifecycle')) return []
      let projection: CursorLifecycleInspection
      try {
        projection = inspectCursorLifecycle(context)
      } catch (error) {
        return [failedVerification(context, [errorMessage(error)])]
      }
      if (request.expectedCapability === 0 && !projection.fragmentExists) {
        return [{
          componentKey: 'lifecycle',
          status: 'verified',
          verifiedCapability: 0,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['disconnect_static_readback_verified'],
        }]
      }
      if (!projection.complete) {
        return [failedVerification(context, ['managed_cursor_lifecycle_hooks_incomplete'], projection.fragmentHash)]
      }
      const desiredHash = sha256Json(desiredFragment(context) as unknown as JsonValue)
      if (projection.fragmentHash !== desiredHash) {
        return [failedVerification(
          context,
          ['managed_cursor_lifecycle_hooks_drifted_from_current_desired'],
          projection.fragmentHash,
        )]
      }
      if (!runtimeAssetsPresent(context)) {
        return [failedVerification(context, ['cursor_lifecycle_runtime_missing'], projection.fragmentHash)]
      }
      const activity = await verifyHostActivity(context, request, {
        componentKey: 'lifecycle',
        signalNames: ['session_start', 'pre_compact', 'session_end'],
        require: 'all',
      })
      if (activity.status === 'unverified') {
        return [{
          ...activity,
          evidenceHash: projection.fragmentHash ?? undefined,
          identityAssertion: context.agentId,
          diagnostics: ['static_readback_passed', ...activity.diagnostics],
        }]
      }
      return [activity]
    },
  }
}

export function cursorLifecycleRuntimeScript(context: AdapterOperationContext): string {
  return path.join(path.dirname(context.runtime.hookScriptPath), 'hook-cursor-lifecycle.cjs')
}

function buildPlan(
  context: AdapterOperationContext,
  request: AdapterPlanRequest,
  remove: boolean,
): AdapterPlan {
  const diagnostics: string[] = []
  if (!request.observed.detected) diagnostics.push('host_not_detected')
  if (!request.desiredComponents.includes('lifecycle')) diagnostics.push('lifecycle_not_requested')
  if (!remove && !runtimeAssetsPresent(context)) diagnostics.push('cursor_lifecycle_runtime_missing')
  if (diagnostics.length > 0) return emptyPlan(context, diagnostics)

  let projection: CursorLifecycleInspection
  try {
    projection = inspectCursorLifecycle(context)
  } catch (error) {
    return emptyPlan(context, [errorMessage(error)])
  }

  const target = cursorHooksFile(context)
  const key = ownershipKey(context)
  const baseline = request.ownedArtifacts.find(artifact =>
    artifact.componentKey === 'lifecycle'
    && path.resolve(artifact.physicalTarget) === path.resolve(target)
    && artifact.ownershipKey === key,
  )
  const desired = remove ? undefined : desiredFragment(context)
  const desiredHash = desired === undefined ? null : sha256Json(desired as unknown as JsonValue)
  const relocatedBaseline = !remove && baseline === undefined && projection.fragmentHash === desiredHash
    ? request.ownedArtifacts.find(artifact =>
        artifact.componentKey === 'lifecycle'
        && path.resolve(artifact.physicalTarget) !== path.resolve(target)
        && artifact.ownershipKey === key
        && artifact.ownedFragmentHash === desiredHash,
      )
    : undefined
  const effectiveBaseline = baseline ?? relocatedBaseline
  let operation: PlannedMutation['operation'] | null = null

  if (remove) {
    if (!projection.fragmentExists) operation = null
    else if (!effectiveBaseline || projection.fragmentHash !== effectiveBaseline.ownedFragmentHash) {
      diagnostics.push('remove_requires_exact_owned_cursor_hooks')
    } else operation = 'remove'
  } else if (!projection.fragmentExists) {
    operation = 'create'
  } else if (!effectiveBaseline) {
    diagnostics.push(projection.fragmentHash === desiredHash
      ? 'matching_cursor_hooks_have_no_ownership_evidence'
      : 'cursor_hook_selector_already_occupied')
  } else if (projection.fragmentHash !== effectiveBaseline.ownedFragmentHash) {
    diagnostics.push('owned_cursor_hooks_modified')
  } else if (projection.fragmentHash !== desiredHash) {
    operation = 'update'
  }

  const mutations: PlannedMutation[] = operation === null ? [] : [{
    operationId: `${context.operationId}:lifecycle`,
    componentKey: 'lifecycle',
    operation,
    domainKind: 'file_fragment',
    physicalTarget: target,
    ownershipKey: key,
    selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
    risk: 'low',
    reload: 'new_session',
    commandCategory: 'file_write',
    preconditionHash: projection.fragmentHash ?? undefined,
    containerPreconditionHash: projection.file.containerHash ?? undefined,
    desiredFragmentHash: desiredHash ?? undefined,
    idempotent: true,
    metadata: {
      canonicalPath: projection.file.canonicalPath,
      containerPreconditionHash: projection.file.containerHash,
      liveFragmentHash: projection.fragmentHash,
      ownedFragmentHash: effectiveBaseline?.ownedFragmentHash ?? null,
      ...(desired === undefined ? {} : { desiredFragment: desired }),
      remove,
    } as unknown as Readonly<Record<string, JsonValue>>,
  }]

  return {
    catalogId: 'cursor-desktop',
    installationKey: context.installation.installKey,
    adapterVersion: ADAPTER_VERSION,
    projectionVersion: context.runtime.projectionVersion,
    mutations,
    requiredUserActions: [],
    diagnostics,
  }
}

function inspectCursorLifecycle(context: AdapterOperationContext): CursorLifecycleInspection {
  const target = cursorHooksFile(context)
  const file = inspectRegularFileWithinRoot(target, context.installation.canonicalConfigRoot)
  if (!file.exists) return absentInspection(file)
  const document = parseJsonObject(file.canonicalPath)
  if (document.version !== 1) throw new Error('cursor_hooks_version_unsupported')
  const hooksValue = document.hooks
  if (hooksValue === undefined) return absentInspection(file)
  if (!isJsonObject(hooksValue)) throw new Error('cursor_hooks_root_not_object')

  const fragment = emptyFragment()
  let count = 0
  for (const event of CURSOR_EVENTS) {
    const value = hooksValue[event]
    if (value === undefined) continue
    if (!Array.isArray(value)) throw new Error(`cursor_hook_event_not_array:${event}`)
    const matches = value.filter(entry => isManagedEntry(entry, marker(context, event)))
    if (matches.length > 1) throw new Error(`duplicate_managed_cursor_hook:${event}`)
    if (matches.length === 1) {
      fragment[event] = normalizeEntry(matches[0], event)
      count += 1
    }
  }
  return {
    file,
    fragmentExists: count > 0,
    complete: count === CURSOR_EVENTS.length,
    fragment,
    fragmentHash: count > 0 ? sha256Json(fragment as unknown as JsonValue) : null,
  }
}

function applyManagedMembers(
  document: Record<string, unknown>,
  context: AdapterOperationContext,
  desired: CursorLifecycleFragment | undefined,
): void {
  let hooks: Record<string, unknown>
  if (document.hooks === undefined) {
    hooks = {}
    document.hooks = hooks
  } else if (isJsonObject(document.hooks)) hooks = document.hooks
  else throw new Error('cursor_hooks_root_not_object')

  for (const event of CURSOR_EVENTS) {
    const current = hooks[event]
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`cursor_hook_event_not_array:${event}`)
    }
    const entries = current === undefined ? [] : [...current]
    const indexes = entries.flatMap((entry, index) => isManagedEntry(entry, marker(context, event)) ? [index] : [])
    if (indexes.length > 1) throw new Error(`duplicate_managed_cursor_hook:${event}`)
    if (desired === undefined) {
      if (indexes.length === 1) entries.splice(indexes[0], 1)
      if (entries.length === 0) delete hooks[event]
      else hooks[event] = entries
      continue
    }
    const next = desired[event]
    if (!isJsonObject(next)) throw new Error(`cursor_hook_desired_entry_missing:${event}`)
    if (indexes.length === 1) entries[indexes[0]] = next
    else entries.push(next)
    hooks[event] = entries
  }
  if (Object.keys(hooks).length === 0) delete document.hooks
}

function desiredFragment(context: AdapterOperationContext): CursorLifecycleFragment {
  return {
    sessionStart: desiredEntry(context, 'sessionStart'),
    preCompact: desiredEntry(context, 'preCompact'),
    sessionEnd: desiredEntry(context, 'sessionEnd'),
  }
}

function desiredEntry(context: AdapterOperationContext, event: CursorLifecycleEvent): CursorHookEntry {
  const args = [
    context.runtime.shimPath,
    cursorLifecycleRuntimeScript(context),
    '--event',
    event,
    '--agent-id',
    context.agentId,
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
  ]
  if (event === 'sessionStart') {
    args.push(
      '--skill-path', path.join(context.installation.canonicalConfigRoot, 'skills', 'tidemind', 'SKILL.md'),
      '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
    )
  }
  return {
    command: `${args.map(shellQuote).join(' ')} ${marker(context, event)}`,
    timeout: event === 'sessionStart' ? 30 : 10,
  }
}

function marker(context: AdapterOperationContext, event: CursorLifecycleEvent): string {
  const digest = sha256Bytes(`${context.agentId}\0${event}`).slice(0, 24)
  return `# tidemind-lifecycle-${digest}`
}

function ownershipKey(context: AdapterOperationContext): string {
  return `hooks.lifecycle.tidemind-${sha256Bytes(context.agentId).slice(0, 24)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}

function cursorHooksFile(context: AdapterOperationContext): string {
  return path.join(context.installation.canonicalConfigRoot, 'hooks.json')
}

function runtimeAssetsPresent(context: AdapterOperationContext): boolean {
  return isRegularFile(context.runtime.shimPath) && isRegularFile(cursorLifecycleRuntimeScript(context))
}

function isRegularFile(target: string): boolean {
  try {
    return path.isAbsolute(target) && fs.lstatSync(target).isFile()
  } catch {
    return false
  }
}

function defaultDetected(context: AdapterOperationContext, target: string): boolean {
  const executable = context.installation.distribution.executableRealpath
  return fs.existsSync(context.installation.canonicalConfigRoot)
    || fs.existsSync(target)
    || (executable !== undefined && fs.existsSync(executable))
}

function normalizeEntry(value: unknown, event: CursorLifecycleEvent): JsonValue {
  if (!isJsonObject(value) || typeof value.command !== 'string' || typeof value.timeout !== 'number') {
    throw new Error(`managed_cursor_hook_invalid:${event}`)
  }
  return value as JsonValue
}

function isManagedEntry(value: unknown, expectedMarker: string): boolean {
  return isJsonObject(value)
    && typeof value.command === 'string'
    && value.command.trimEnd().endsWith(expectedMarker)
}

function emptyFragment(): CursorLifecycleFragment {
  return { sessionStart: null, preCompact: null, sessionEnd: null }
}

function absentInspection(file: FileFingerprint): CursorLifecycleInspection {
  return {
    file,
    fragmentExists: false,
    complete: false,
    fragment: emptyFragment(),
    fragmentHash: null,
  }
}

function parseJsonObject(filePath: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`cursor_hooks_json_malformed:${errorMessage(error)}`)
  }
  if (!isJsonObject(value)) throw new Error('cursor_hooks_document_not_object')
  return value
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseMetadata(mutation: PlannedMutation): CursorLifecycleMetadata {
  const value = mutation.metadata as unknown as Partial<CursorLifecycleMetadata> | undefined
  if (!value
    || typeof value.canonicalPath !== 'string'
    || (value.containerPreconditionHash !== null && typeof value.containerPreconditionHash !== 'string')
    || (value.liveFragmentHash !== null && typeof value.liveFragmentHash !== 'string')
    || (value.ownedFragmentHash !== null && typeof value.ownedFragmentHash !== 'string')
    || typeof value.remove !== 'boolean') {
    throw new Error(`invalid_cursor_lifecycle_metadata:${mutation.operationId}`)
  }
  if (!value.remove && !isCursorFragment(value.desiredFragment)) {
    throw new Error(`invalid_cursor_lifecycle_desired_fragment:${mutation.operationId}`)
  }
  return {
    canonicalPath: value.canonicalPath,
    containerPreconditionHash: value.containerPreconditionHash ?? null,
    liveFragmentHash: value.liveFragmentHash ?? null,
    ownedFragmentHash: value.ownedFragmentHash ?? null,
    desiredFragment: value.desiredFragment,
    remove: value.remove,
  }
}

function isCursorFragment(value: unknown): value is CursorLifecycleFragment {
  if (!isJsonObject(value)) return false
  return CURSOR_EVENTS.every(event => {
    const entry = value[event]
    return isJsonObject(entry)
      && Object.keys(entry).sort().join(',') === 'command,timeout'
      && typeof entry.command === 'string'
      && typeof entry.timeout === 'number'
  })
}

function assertLifecycleMutation(mutation: PlannedMutation): void {
  if (mutation.componentKey !== 'lifecycle'
    || !['create', 'update', 'remove'].includes(mutation.operation)) {
    throw new Error(`unsupported_cursor_lifecycle_mutation:${mutation.operationId}`)
  }
}

function emptyPlan(context: AdapterOperationContext, diagnostics: readonly string[]): AdapterPlan {
  return {
    catalogId: 'cursor-desktop',
    installationKey: context.installation.installKey,
    adapterVersion: ADAPTER_VERSION,
    projectionVersion: context.runtime.projectionVersion,
    mutations: [],
    requiredUserActions: [],
    diagnostics,
  }
}

function failedVerification(
  context: AdapterOperationContext,
  diagnostics: readonly string[],
  evidenceHash?: string | null,
): ComponentVerificationResult {
  return {
    componentKey: 'lifecycle',
    status: 'failed',
    verifiedCapability: null,
    ...(evidenceHash ? { evidenceHash } : {}),
    identityAssertion: context.agentId,
    invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version'],
    diagnostics,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
