import fs from 'node:fs'
import path from 'node:path'
import { shellArgument } from '../shell-argument'
import { parse as parseToml } from 'smol-toml'
import { scanTomlTableHeaders } from '../../ipc/toml-utils'
import { sha256Bytes } from '../fingerprint'
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

export type KimiCodeLifecycleCatalogId = 'kimi-code-cli' | 'kimi-code-native'
export const KIMI_CODE_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start', 'pre_compact', 'post_compact', 'session_end',
] as const)

export interface KimiCodeLifecycleHostSpec {
  catalogId: KimiCodeLifecycleCatalogId
  adapterVersion: string
}

interface HookBlock {
  start: number
  end: number
  text: string
  hash: string
  hook: Readonly<Record<string, unknown>>
}

interface TomlInspection {
  file: FileFingerprint
  source: string
  blocks: readonly HookBlock[]
}

interface KimiLifecycleMutationMetadata {
  canonicalPath: string
  desiredDocument: string
  desiredBlockHash: string | null
  remove: boolean
}

interface ManagedHookSet {
  blocks: readonly HookBlock[]
  hash: string | null
  complete: boolean
  exact: boolean
  diagnostics: readonly string[]
}

const COMPONENT_KEY = 'lifecycle' as const
const OWNERSHIP_SCHEMA_VERSION = 1
const HOOK_TIMEOUT_SECONDS = 30

/**
 * Manages only Tide Mind's identity-bound Kimi [[hooks]] item. The target root
 * and any profile-specific files come exclusively from the frozen Installation
 * identity; process-level KIMI_CODE_HOME is deliberately outside this Adapter.
 */
export function createKimiCodeLifecycleHostAdapter(
  spec: KimiCodeLifecycleHostSpec,
): AgentHostAdapter {
  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const target = configFile(context)
    const diagnostics: string[] = []
    let visibility: 'absent' | 'dedicated' | 'unknown' = 'absent'
    let observedTarget: string | undefined
    let observedFragmentHash: string | undefined

    try {
      const projection = inspectToml(context)
      observedTarget = projection.file.canonicalPath
      const owned = inspectManagedHookSet(projection, context)
      if (!owned.complete && owned.blocks.length > 0) {
        visibility = 'unknown'
        diagnostics.push(...owned.diagnostics)
      } else if (owned.complete) {
        visibility = 'dedicated'
        observedFragmentHash = owned.hash ?? undefined
      }
    } catch (error) {
      visibility = 'unknown'
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }

    return {
      catalogId: spec.catalogId,
      detected: defaultDetected(context, target),
      distribution: { ...context.installation.distribution },
      components: [{
        componentKey: COMPONENT_KEY,
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
    const target = configFile(context)
    const diagnostics: string[] = []
    const mutations: PlannedMutation[] = []

    if (!request.observed.detected) {
      diagnostics.push('host_not_detected')
    } else if (!request.desiredComponents.includes(COMPONENT_KEY)) {
      diagnostics.push('lifecycle_not_requested')
    } else {
      const projection = inspectToml(context)
      const desired = desiredHooks(context)
      const desiredText = renderHooks(desired)
      const desiredHash = sha256Bytes(desiredText)
      const ownershipKey = lifecycleOwnershipKey(context)
      const baseline = request.ownedArtifacts.find(artifact =>
        artifact.componentKey === COMPONENT_KEY
        && path.resolve(artifact.physicalTarget) === path.resolve(target)
        && artifact.ownershipKey === ownershipKey,
      )
      const managed = inspectManagedHookSet(projection, context)
      const baselineMatches = baseline !== undefined
        && managed.hash === baseline.ownedFragmentHash

      if (managed.diagnostics.includes('duplicate_tidemind_kimi_lifecycle_hooks')) {
        diagnostics.push(...managed.diagnostics)
      } else {
        if (remove) {
          if (!baselineMatches && managed.blocks.length === 0) {
            // Already absent: disconnect is idempotent.
          } else if (!baselineMatches) {
            diagnostics.push('remove_requires_exact_owned_hook')
          } else {
            mutations.push(plannedMutation(
              context,
              projection,
              managed.hash,
              removeHooks(projection.source, managed.blocks),
              null,
              'remove',
            ))
          }
        } else if (baselineMatches) {
          if (managed.exact && managed.hash === desiredHash) {
            // Exact owned projection already present.
          } else {
            mutations.push(plannedMutation(
              context,
              projection,
              managed.hash,
              replaceHooks(projection.source, managed.blocks, desiredText),
              desiredHash,
              'update',
            ))
          }
        } else if (managed.blocks.length > 0) {
          diagnostics.push(managed.exact
            ? 'matching_hook_has_no_ownership_evidence'
            : 'identity_bound_hook_has_no_ownership_evidence')
        } else {
          mutations.push(plannedMutation(
            context,
            projection,
            null,
            appendHook(projection.source, desiredText),
            desiredHash,
            'create',
          ))
        }
      }
    }

    return {
      catalogId: spec.catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      mutations,
      requiredUserActions: [],
      diagnostics,
    }
  }

  return {
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    componentKeys: [COMPONENT_KEY],
    implementationTypes: { lifecycle: ['hook'] },
    componentContracts: {
      lifecycle: { deliveryMode: 'managed', artifactTypes: ['hook'], mutationDomain: 'file_fragment', reload: 'new_session' },
    },
    inspect,
    async inspectAdoptableArtifacts(context): Promise<readonly AdoptableArtifactObservation[]> {
      try {
        const projection = inspectToml(context)
        const managed = inspectManagedHookSet(projection, context)
        const legacy091 = inspectLegacy091HookSet(projection, context)
        const adoptable = managed.exact ? managed : legacy091
        if (!adoptable.exact || adoptable.hash === null) return []
        return [{
          componentKey: COMPONENT_KEY,
          artifactType: 'hook',
          domainKind: 'file_fragment',
          physicalTarget: projection.file.canonicalPath,
          ownershipKey: lifecycleOwnershipKey(context),
          selectorSchemaVersion: OWNERSHIP_SCHEMA_VERSION,
          projectionVersion: context.runtime.projectionVersion,
          containerHash: projection.file.containerHash ?? undefined,
          fragmentHash: adoptable.hash,
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
      const current = inspectToml(context)
      if (current.file.canonicalPath !== metadata.canonicalPath) {
        throw new Error('kimi_lifecycle_canonical_path_changed')
      }
      if (current.file.containerHash !== (mutation.containerPreconditionHash ?? null)) {
        throw new Error('kimi_lifecycle_container_precondition_changed')
      }
      const currentHash = inspectManagedHookSet(current, context).hash
      if (currentHash !== (mutation.preconditionHash ?? null)) {
        throw new Error('kimi_lifecycle_fragment_precondition_changed')
      }

      ensureSafeParentDirectoryWithinRoot(
        mutation.physicalTarget,
        context.installation.canonicalConfigRoot,
      )
      const afterFile = writeRegularFileAtomicCas(mutation.physicalTarget, metadata.desiredDocument, {
        expectedContainerHash: mutation.containerPreconditionHash ?? null,
        expectedCanonicalPath: metadata.canonicalPath,
      })
      const readBack = await readBackMutation(context, mutation)
      if (!readBack.matchesDesired) throw new Error('kimi_lifecycle_readback_mismatch')
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: readBack.observedFragmentHash,
        hostReceipt: {
          canonicalPath: afterFile.canonicalPath,
          containerHash: afterFile.containerHash,
        },
      }
    },
    readBack: readBackMutation,
    async verify(
      context,
      request: AdapterVerificationRequest,
    ): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes(COMPONENT_KEY)) return []
      const inspection = await inspect(context)
      const observation = inspection.components.find(component => component.componentKey === COMPONENT_KEY)
      if (request.expectedCapability === 0 && observation?.visibility === 'absent') {
        return [{
          componentKey: COMPONENT_KEY,
          status: 'verified',
          verifiedCapability: 0,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['disconnect_static_readback_verified'],
        }]
      }
      if (observation?.visibility !== 'dedicated') {
        return [{
          componentKey: COMPONENT_KEY,
          status: 'failed',
          verifiedCapability: null,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: inspection.diagnostics.length > 0
            ? inspection.diagnostics
            : ['managed_kimi_lifecycle_hook_not_visible'],
        }]
      }

      const desiredHash = sha256Bytes(renderHooks(desiredHooks(context)))
      if (observation.observedFragmentHash !== desiredHash) {
        return [{
          componentKey: COMPONENT_KEY,
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: observation.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['managed_kimi_lifecycle_hook_drifted_from_current_desired'],
        }]
      }

      const activity = await verifyHostActivity(context, request, {
        componentKey: COMPONENT_KEY,
        signalNames: KIMI_CODE_REQUIRED_LIFECYCLE_SIGNALS,
        require: 'all',
      })
      if (activity.status === 'unverified') {
        return [{
          ...activity,
          evidenceHash: observation.observedFragmentHash,
          identityAssertion: context.agentId,
          diagnostics: ['static_readback_passed', ...activity.diagnostics],
        }]
      }
      return [activity]
    },
  }
}

function configFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.lifecycle
    ?? path.join(context.installation.canonicalConfigRoot, 'config.toml')
}

function instructionFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.instruction
    ?? path.join(
      context.installation.canonicalConfigRoot,
      'skills',
      'tidemind',
      'SKILL.md',
    )
}

function legacy091InstructionFile(context: AdapterOperationContext): string {
  return path.join(
    context.installation.canonicalConfigRoot,
    'skills',
    `tidemind-${context.agentId}`,
    'SKILL.md',
  )
}

function defaultDetected(context: AdapterOperationContext, target: string): boolean {
  const executable = context.installation.distribution.executableRealpath
  return fs.existsSync(context.installation.canonicalConfigRoot)
    || fs.existsSync(target)
    || (executable !== undefined && fs.existsSync(executable))
}

function lifecycleOwnershipKey(context: AdapterOperationContext): string {
  return `hooks.tidemind-${context.agentId}`
}

function desiredHooks(context: AdapterOperationContext): readonly Readonly<Record<string, unknown>>[] {
  return [
    desiredInjectionHook(context),
    desiredHook(
      context,
      'SessionStart',
      'startup|resume',
      path.join(path.dirname(context.runtime.hookScriptPath), 'hook-kimi-session-start-activity.cjs'),
    ),
    desiredHook(context, 'PreCompact', 'manual|auto', context.runtime.preCompactScriptPath),
    desiredHook(context, 'PostCompact', 'manual|auto', context.runtime.postCompactScriptPath),
    desiredHook(
      context,
      'SessionEnd',
      'exit|archive',
      path.join(path.dirname(context.runtime.hookScriptPath), 'hook-session-end.cjs'),
    ),
  ]
}

function desiredInjectionHook(context: AdapterOperationContext): Readonly<Record<string, unknown>> {
  const command = [
    context.runtime.shimPath,
    context.runtime.hookScriptPath,
    '--agent-id', context.agentId,
    '--skill-path', instructionFile(context),
    '--tool', 'kimi-code',
    ...(context.activityGenerationToken
      ? ['--activity-generation-token', context.activityGenerationToken]
      : []),
    '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
    '--once-per-session',
    '--suppress-session-start-activity',
  ].map(shellArgument).join(' ')
  return { event: 'UserPromptSubmit', command, timeout: HOOK_TIMEOUT_SECONDS }
}

/**
 * Tide Mind 0.2.91 installed one Kimi UserPromptSubmit injection hook.  It is
 * adoptable only when every semantic field and every command argument matches
 * that exact identity-bound projection.  Similar user hooks, stale paths and
 * commands without the per-session guard are deliberately excluded.
 */
function inspectLegacy091HookSet(
  projection: TomlInspection,
  context: AdapterOperationContext,
): ManagedHookSet {
  const blocks = identityBlocks(projection, context)
  const expected = legacy091InjectionHook(context)
  const exact = blocks.length === 1 && hookSemanticallyMatches(blocks[0].hook, expected)
  return {
    blocks,
    hash: exact ? blocks[0].hash : null,
    complete: exact,
    exact,
    diagnostics: exact ? [] : blocks.length > 0 ? ['legacy_0_2_91_kimi_hook_not_exact'] : [],
  }
}

function legacy091InjectionHook(context: AdapterOperationContext): Readonly<Record<string, unknown>> {
  const command = [
    JSON.stringify(context.runtime.shimPath),
    JSON.stringify(context.runtime.hookScriptPath),
    '--agent-id', JSON.stringify(context.agentId),
    '--skill-path', JSON.stringify(
      context.installation.componentConfigFiles?.instruction ?? legacy091InstructionFile(context),
    ),
    '--tool', JSON.stringify('kimi-code'),
    '--once-per-session',
  ].join(' ')
  return { event: 'UserPromptSubmit', command, timeout: HOOK_TIMEOUT_SECONDS }
}

function desiredHook(
  context: AdapterOperationContext,
  event: 'SessionStart' | 'PreCompact' | 'PostCompact' | 'SessionEnd',
  matcher: string,
  scriptPath: string,
  extraArgs: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const command = [
    context.runtime.shimPath,
    scriptPath,
    '--agent-id', context.agentId,
    ...extraArgs,
    '--tool', 'kimi-code',
    ...(context.activityGenerationToken
      ? ['--activity-generation-token', context.activityGenerationToken]
      : []),
  ].map(shellArgument).join(' ')
  return { event, matcher, command, timeout: HOOK_TIMEOUT_SECONDS }
}

function renderHook(hook: Readonly<Record<string, unknown>>): string {
  const lines = [
    '[[hooks]]',
    `event = ${tomlString(String(hook.event))}`,
  ]
  if (typeof hook.matcher === 'string') lines.push(`matcher = ${tomlString(hook.matcher)}`)
  lines.push(
    `command = ${tomlString(String(hook.command))}`,
    `timeout = ${String(hook.timeout)}`,
  )
  return lines.join('\n')
}

function renderHooks(hooks: readonly Readonly<Record<string, unknown>>[]): string {
  return hooks.map(renderHook).join('\n\n')
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/gu, '\\u007F')
}

function inspectToml(context: AdapterOperationContext): TomlInspection {
  const target = configFile(context)
  const file = inspectRegularFileWithinRoot(target, context.installation.canonicalConfigRoot)
  if (!file.exists) return { file, source: '', blocks: [] }
  const source = fs.readFileSync(file.canonicalPath, 'utf8')
  try {
    parseToml(source)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Managed Kimi TOML container is malformed: ${file.canonicalPath} (${reason})`)
  }
  return { file, source, blocks: hookBlocks(source) }
}

function hookBlocks(source: string): readonly HookBlock[] {
  const lines = source.split('\n')
  const headers = scanTomlTableHeaders(source)
  const blocks: HookBlock[] = []
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]
    if (!header.array || header.key !== 'hooks') continue
    let end = headers[index + 1]?.line ?? lines.length
    while (end > header.line + 1 && lines[end - 1].trim() === '') end--
    const text = lines.slice(header.line, end).join('\n')
    try {
      const parsed = parseToml(text) as { hooks?: unknown[] }
      const hook = parsed.hooks?.[0]
      if (isRecord(hook)) {
        blocks.push({ start: header.line, end, text, hash: sha256Bytes(text), hook })
      }
    } catch {
      // Whole-document validation already succeeded. A block that cannot be
      // independently interpreted is not safe to claim as Tide Mind-owned.
    }
  }
  return blocks
}

function identityBlocks(projection: TomlInspection, context: AdapterOperationContext): readonly HookBlock[] {
  return projection.blocks.filter(block => commandAssertsIdentity(block.hook.command, context.agentId))
}

function commandAssertsIdentity(command: unknown, agentId: string): boolean {
  if (typeof command !== 'string') return false
  const args = tokenizeCommand(command)
  if (!args || args.length < 2) return false
  const agentFlag = args.indexOf('--agent-id')
  const toolFlag = args.indexOf('--tool')
  return agentFlag >= 0
    && args[agentFlag + 1] === agentId
    && toolFlag >= 0
    && args[toolFlag + 1] === 'kimi-code'
}

function inspectManagedHookSet(
  projection: TomlInspection,
  context: AdapterOperationContext,
): ManagedHookSet {
  const blocks = identityBlocks(projection, context)
  const desired = desiredHooks(context)
  const events = blocks.map(block => String(block.hook.event))
  const expectedEvents = desired.map(hook => String(hook.event))
  const duplicate = new Set(events).size !== events.length
  const complete = !duplicate
    && blocks.length === desired.length
    && expectedEvents.every(event => events.includes(event))
  const exact = complete && desired.every(expected => {
    const block = blocks.find(candidate => candidate.hook.event === expected.event)
    return block !== undefined && hookSemanticallyMatches(block.hook, expected)
  })
  return {
    blocks,
    hash: blocks.length === 0 ? null : sha256Bytes(blocks.map(block => block.text).join('\n\n')),
    complete,
    exact,
    diagnostics: duplicate || blocks.length > desired.length
      ? ['duplicate_tidemind_kimi_lifecycle_hooks']
      : complete ? [] : blocks.length > 0 ? ['partial_tidemind_kimi_lifecycle_hooks'] : [],
  }
}

function hookSemanticallyMatches(
  live: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>,
): boolean {
  return Object.keys(live).sort().join('\0') === Object.keys(desired).sort().join('\0')
    && live.event === desired.event
    && live.matcher === desired.matcher
    && live.command === desired.command
    && live.timeout === desired.timeout
}

function tokenizeCommand(command: string): string[] | null {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let started = false
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      started = true
    } else if (quote === '"' && char === '\\') {
      escaped = true
    } else if (quote) {
      if (char === quote) quote = null
      else current += char
      started = true
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/u.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }
  if (quote || escaped) return null
  if (started) args.push(current)
  return args
}

function appendHook(source: string, desiredText: string): string {
  if (source.length === 0) return `${desiredText}\n`
  const separator = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n'
  return `${source}${separator}${desiredText}\n`
}

function replaceHooks(source: string, blocks: readonly HookBlock[], desiredText: string): string {
  return appendHook(removeHooks(source, blocks), desiredText)
}

function removeHooks(source: string, blocks: readonly HookBlock[]): string {
  const lines = source.split('\n')
  for (const block of [...blocks].sort((left, right) => right.start - left.start)) {
    lines.splice(block.start, block.end - block.start)
  }
  return lines.join('\n')
}

function plannedMutation(
  context: AdapterOperationContext,
  projection: TomlInspection,
  liveHash: string | null,
  desiredDocument: string,
  desiredBlockHash: string | null,
  operation: PlannedMutation['operation'],
): PlannedMutation {
  const metadata: KimiLifecycleMutationMetadata = {
    canonicalPath: projection.file.canonicalPath,
    desiredDocument,
    desiredBlockHash,
    remove: operation === 'remove',
  }
  return {
    operationId: `${context.operationId}:${COMPONENT_KEY}`,
    componentKey: COMPONENT_KEY,
    operation,
    domainKind: 'file_fragment',
    physicalTarget: configFile(context),
    ownershipKey: lifecycleOwnershipKey(context),
    selectorSchemaVersion: OWNERSHIP_SCHEMA_VERSION,
    risk: 'low',
    reload: 'new_session',
    commandCategory: 'file_write',
    preconditionHash: liveHash ?? undefined,
    containerPreconditionHash: projection.file.containerHash ?? undefined,
    desiredFragmentHash: desiredBlockHash ?? undefined,
    idempotent: true,
    metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
  }
}

async function readBackMutation(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
): Promise<MutationReadBack> {
  try {
    assertLifecycleMutation(mutation)
    const metadata = parseMetadata(mutation)
    const projection = inspectToml(context)
    if (projection.file.canonicalPath !== metadata.canonicalPath) {
      throw new Error('kimi_lifecycle_canonical_path_changed')
    }
    const managed = inspectManagedHookSet(projection, context)
    const blocks = managed.blocks
    const legacy091 = inspectLegacy091HookSet(projection, context)
    if (!metadata.remove
      && legacy091.exact
      && legacy091.hash !== null
      && legacy091.hash === (mutation.preconditionHash ?? null)) {
      return {
        operationId: mutation.operationId,
        observed: true,
        matchesDesired: false,
        observedFragmentHash: legacy091.hash,
        visibility: 'shared_visible',
        diagnostics: ['exact_legacy_0_2_91_hook_pending_upgrade'],
      }
    }
    if (metadata.remove) {
      return {
        operationId: mutation.operationId,
        observed: blocks.length > 0,
        matchesDesired: blocks.length === 0,
        observedFragmentHash: managed.hash ?? undefined,
        visibility: blocks.length === 0 ? 'absent' : managed.complete ? 'dedicated' : 'unknown',
        diagnostics: [...managed.diagnostics],
      }
    }
    return {
      operationId: mutation.operationId,
      observed: blocks.length > 0,
      matchesDesired: managed.exact && managed.hash === metadata.desiredBlockHash,
      observedFragmentHash: managed.hash ?? undefined,
      visibility: blocks.length === 0 ? 'absent' : managed.complete ? 'dedicated' : 'unknown',
      diagnostics: [...managed.diagnostics],
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

function assertLifecycleMutation(mutation: PlannedMutation): void {
  if (mutation.componentKey !== COMPONENT_KEY
    || !['create', 'update', 'remove'].includes(mutation.operation)) {
    throw new Error(`Unsupported Kimi lifecycle mutation: ${mutation.operationId}`)
  }
}

function parseMetadata(mutation: PlannedMutation): KimiLifecycleMutationMetadata {
  const value = mutation.metadata as unknown as Partial<KimiLifecycleMutationMetadata> | undefined
  if (!value
    || typeof value.canonicalPath !== 'string'
    || typeof value.desiredDocument !== 'string'
    || (value.desiredBlockHash !== null && typeof value.desiredBlockHash !== 'string')
    || typeof value.remove !== 'boolean') {
    throw new Error(`Invalid Kimi lifecycle mutation metadata: ${mutation.operationId}`)
  }
  return {
    canonicalPath: value.canonicalPath,
    desiredDocument: value.desiredDocument,
    desiredBlockHash: value.desiredBlockHash ?? null,
    remove: value.remove,
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
