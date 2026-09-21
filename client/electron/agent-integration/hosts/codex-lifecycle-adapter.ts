import fs from 'node:fs'
import path from 'node:path'
import { shellArgument } from '../shell-argument'
import { parse as parseToml } from 'smol-toml'
import { sha256Bytes, sha256Json } from '../fingerprint'
import { verifyHostActivity } from '../host-activity-evidence'
import { inspectRegularFileWithinRoot } from '../safe-file'
import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterVerificationRequest,
  AgentHostAdapter,
  CodexHookTrustBinding,
  CodexHookTrustRequiredUserAction,
  ComponentVerificationResult,
  JsonValue,
} from '../types'
import { createJsonLifecycleHookHostAdapter } from './json-lifecycle-hook-adapter'
import { PORTABLE_TIDEMIND_SKILL_SHA256 } from './portable-skill'

export type CodexLifecycleCatalogId = 'codex-cli' | 'codex-desktop'
export const CODEX_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start', 'pre_compact', 'post_compact', 'session_end',
] as const)

export type CodexHookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified'

export interface CodexOfficialHookMetadata {
  key: string
  eventName: string
  handlerType: string
  matcher: string | null
  command: string | null
  timeoutSec: number
  statusMessage: string | null
  sourcePath: string
  source: string
  enabled: boolean
  isManaged: boolean
  currentHash: string
  trustStatus: CodexHookTrustStatus
}

export interface CodexOfficialHooksPort {
  /** Read-only current-state projection from Codex's documented hook/trust files. */
  list(context: AdapterOperationContext): Promise<CodexOfficialHooksSnapshot>
  /** Read-only projection of the post-mutation hooks.json document. */
  preview(
    context: AdapterOperationContext,
    sourcePath: string,
    proposedDocument: Readonly<Record<string, JsonValue>>,
  ): Promise<CodexOfficialHooksSnapshot>
}

export interface CodexOfficialHooksSnapshot {
  hooks: readonly CodexOfficialHookMetadata[]
  hooksFileFingerprint: string
  trustConfigFingerprint: string
}

export interface CodexLifecycleHostSpec {
  catalogId: CodexLifecycleCatalogId
  adapterVersion: string
  hooksPort?: CodexOfficialHooksPort
}

export interface CodexHookTrustVerification {
  trusted: true
  sourcePath: string
  hookKey: string
  hostCurrentHash: string
  hooksFileFingerprint: string
  trustConfigFingerprint: string
}

const TRUST_INSTRUCTION = '在 Codex 中运行 /hooks，依次选择 Tide Mind 的 SessionStart、PreCompact、PostCompact 和 SessionEnd Hook 并确认信任。完成后返回 Tide Mind 重新校验。'
const STATUS_MESSAGE = '正在加载 Tide Mind 记忆…'

interface CodexLifecycleEvent {
  eventName: 'SessionStart' | 'PreCompact' | 'PostCompact' | 'SessionEnd'
  canonicalEventName: 'sessionStart' | 'preCompact' | 'postCompact' | 'sessionEnd'
  signalName: 'session_start' | 'pre_compact' | 'post_compact' | 'session_end'
  matcher: string
  scriptPath: string
}

/**
 * Codex stores CLI and Desktop user hooks in the same CODEX_HOME/hooks.json
 * physical domain. This Adapter therefore deliberately uses the same selector
 * ownership key for both variants; the coordinator serializes the shared
 * target and the Ownership Ledger prevents two independent writers.
 */
export function createCodexLifecycleHostAdapter(spec: CodexLifecycleHostSpec): AgentHostAdapter {
  const hooksPort = spec.hooksPort ?? createOfficialCodexHooksPort()
  const base = createJsonLifecycleHookHostAdapter({
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    configFile: codexHooksFile,
    eventRoot: ['hooks'],
    activationMode: 'qwen_default_enabled',
    reload: 'new_session',
    activityRequirement: 'all',
    events: context => lifecycleEvents(context).map(event => ({
      eventName: event.eventName,
      signalName: event.signalName,
      entry: desiredEntry(context, event),
    })),
    identifiesEntry: (_event, candidate, context) => identifiesTideMindEntry(candidate, context),
  })

  return {
    ...base,
    async plan(context, request): Promise<AdapterPlan> {
      const plan = await base.plan(context, request)
      if (!request.desiredComponents.includes('lifecycle')
        || request.desiredCapability === 0
        || plan.diagnostics.length > 0) return plan
      return attachTrustAction(spec, hooksPort, context, plan)
    },
    async verify(context, request): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes('lifecycle')) return []
      const inspection = await base.inspect(context)
      const lifecycle = inspection.components.find(component => component.componentKey === 'lifecycle')
      if (request.expectedCapability === 0 && lifecycle?.visibility === 'absent') {
        return [staticResult(context, 0, ['disconnect_static_readback_verified'])]
      }
      const desiredHash = sha256Json(desiredFragment(context))
      if (lifecycle?.visibility !== 'dedicated' || lifecycle.observedFragmentHash !== desiredHash) {
        return [{
          componentKey: 'lifecycle',
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: lifecycle?.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: codexInvalidationKeys(),
          diagnostics: lifecycle?.visibility !== 'dedicated'
            ? (inspection.diagnostics.length > 0
                ? inspection.diagnostics
                : ['managed_lifecycle_fragment_not_active'])
            : ['managed_lifecycle_fragment_drifted_from_current_desired'],
        }]
      }

      const binding = request.activityBinding
      if (!binding?.hostVersion || !context.installationId) {
        return [staticResult(context, 3, ['static_readback_passed', 'codex_trust_binding_unavailable'], desiredHash)]
      }

      let hooks: readonly CodexOfficialHookMetadata[]
      try {
        hooks = exactManagedHooks((await hooksPort.list(context)).hooks, context)
      } catch (error) {
        return [staticResult(context, 3, [
          'static_readback_passed',
          `official_hooks_list_unavailable:${errorMessage(error)}`,
        ], desiredHash)]
      }
      if (hooks.length !== lifecycleEvents(context).length) {
        return [staticResult(context, 3, [
          'static_readback_passed',
          'official_hooks_list_did_not_recognize_managed_hook',
        ], desiredHash)]
      }
      const untrusted = hooks.find(hook => hook.trustStatus !== 'trusted')
      if (untrusted) {
        return [staticResult(context, 3, [
          'static_readback_passed',
          `codex_hook_not_trusted:${untrusted.eventName}:${untrusted.trustStatus}`,
        ], desiredHash)]
      }

      const trustBinding = buildTrustBinding(spec, context, binding.hostVersion, hooks, desiredHash)
      const trustReceipt = context.codexHookTrustEvidence
        ? await context.codexHookTrustEvidence.findCodexHookTrustEvidence(trustBinding)
        : null
      if (!trustReceipt) {
        return [staticResult(context, 3, [
          'static_readback_passed',
          'codex_hook_trust_receipt_missing',
        ], desiredHash)]
      }

      const activity = await verifyHostActivity(context, request, {
        componentKey: 'lifecycle',
        signalNames: CODEX_REQUIRED_LIFECYCLE_SIGNALS,
        require: 'all',
      })
      if (activity.status !== 'verified' || activity.verifiedCapability !== 4) {
        return [staticResult(context, 3, [
          'static_readback_passed',
          'codex_user_layer_trust_receipt_present',
          ...activity.diagnostics,
        ], desiredHash)]
      }
      return [{
        ...activity,
        evidenceRef: `codex-hook-trust:${trustReceipt.id};${activity.evidenceRef ?? 'host-activity'}`,
        evidenceHash: sha256Json({
          activityEvidenceHash: activity.evidenceHash ?? null,
          hookCurrentHashes: hooks.map(hook => hook.currentHash),
          hookKeyHash: trustBinding.hookKeyHash,
          trustReceiptId: trustReceipt.id,
          trustVerifiedAt: trustReceipt.verifiedAt,
        }),
        invalidationKeys: codexInvalidationKeys(),
        diagnostics: [
          'static_readback_passed',
          'codex_user_layer_trust_receipt_present',
          'codex_effective_lifecycle_activity_verified',
          ...activity.diagnostics,
        ],
      }]
    },
  }
}

async function attachTrustAction(
  spec: CodexLifecycleHostSpec,
  hooksPort: CodexOfficialHooksPort,
  context: AdapterOperationContext,
  plan: AdapterPlan,
): Promise<AdapterPlan> {
  if (!context.installationId || !context.hostVersion) {
    return {
      ...plan,
      requiredUserActions: [...plan.requiredUserActions, 'codex_hook_trust_binding_unavailable'],
      diagnostics: [...plan.diagnostics, 'codex_hook_trust_binding_unavailable'],
    }
  }
  const sourcePath = inspectRegularFileWithinRoot(
    codexHooksFile(context),
    context.installation.canonicalConfigRoot,
  ).canonicalPath
  const desiredHash = sha256Json(desiredFragment(context))
  let hooks: readonly CodexOfficialHookMetadata[]
  try {
    if (plan.mutations.some(mutation => mutation.componentKey === 'lifecycle')) {
      hooks = (await hooksPort.preview(context, sourcePath, proposedDocument(context, sourcePath))).hooks
    } else {
      hooks = (await hooksPort.list(context)).hooks
    }
  } catch (error) {
    return {
      ...plan,
      requiredUserActions: [...plan.requiredUserActions, 'codex_hook_trust_verification_unavailable'],
      diagnostics: [...plan.diagnostics, `official_hooks_list_unavailable:${errorMessage(error)}`],
    }
  }
  const managedHooks = exactManagedHooks(hooks, context, sourcePath)
  if (managedHooks.length !== lifecycleEvents(context).length) {
    return {
      ...plan,
      requiredUserActions: [...plan.requiredUserActions, 'codex_hook_trust_verification_unavailable'],
      diagnostics: [...plan.diagnostics, 'official_hooks_list_did_not_recognize_managed_hook'],
    }
  }
  const binding = buildTrustBinding(spec, context, context.hostVersion, managedHooks, desiredHash)
  const trustReceipt = managedHooks.every(hook => hook.trustStatus === 'trusted') && context.codexHookTrustEvidence
    ? await context.codexHookTrustEvidence.findCodexHookTrustEvidence(binding)
    : null
  if (trustReceipt) return plan

  const detail: CodexHookTrustRequiredUserAction = {
    kind: 'codex_hook_trust',
    componentKey: 'lifecycle',
    sourcePath: managedHooks[0].sourcePath,
    hookKey: aggregateHookKey(managedHooks),
    instruction: TRUST_INSTRUCTION,
    ...binding,
  }
  return {
    ...plan,
    requiredUserActions: [...plan.requiredUserActions, 'codex_hook_trust_required'],
    requiredUserActionDetails: [...(plan.requiredUserActionDetails ?? []), detail],
  }
}

function buildTrustBinding(
  spec: CodexLifecycleHostSpec,
  context: AdapterOperationContext,
  hostVersion: string,
  hooks: readonly CodexOfficialHookMetadata[],
  ownedFragmentHash: string,
): CodexHookTrustBinding {
  if (!context.installationId) throw new Error('Codex trust requires Installation binding')
  if (hooks.length === 0) throw new Error('Codex trust requires managed hooks')
  hooks.forEach(assertOfficialHookMetadata)
  const sourcePath = hooks[0].sourcePath
  if (hooks.some(hook => path.resolve(hook.sourcePath) !== path.resolve(sourcePath))) {
    throw new Error('Codex trust requires one physical hook source')
  }
  const hookKey = aggregateHookKey(hooks)
  return {
    installationId: context.installationId,
    agentId: context.agentId,
    hostVariant: spec.catalogId,
    sourcePathHash: sha256Bytes(path.resolve(sourcePath)),
    hookKeyHash: sha256Bytes(hookKey),
    ownedFragmentHash,
    hostCurrentHash: aggregateHostCurrentHash(hooks),
    tideMindVersion: context.runtime.tideMindVersion,
    adapterVersion: spec.adapterVersion,
    projectionVersion: context.runtime.projectionVersion,
    hostVersion,
  }
}

function exactManagedHooks(
  hooks: readonly CodexOfficialHookMetadata[],
  context: AdapterOperationContext,
  expectedSourcePath = inspectRegularFileWithinRoot(
    codexHooksFile(context),
    context.installation.canonicalConfigRoot,
  ).canonicalPath,
): readonly CodexOfficialHookMetadata[] {
  const matches = lifecycleEvents(context).map(event => {
    const candidates = hooks.filter(hook => path.resolve(hook.sourcePath) === path.resolve(expectedSourcePath)
      && hook.eventName === event.canonicalEventName
      && hook.command === desiredCommand(context, event)
      && hook.enabled)
    if (candidates.length > 1) throw new Error(`duplicate_official_codex_hook_metadata:${event.eventName}`)
    const hook = candidates[0]
    if (hook) assertOfficialHookMetadata(hook)
    return hook
  })
  return matches.filter((hook): hook is CodexOfficialHookMetadata => hook !== undefined)
}

function aggregateHookKey(hooks: readonly CodexOfficialHookMetadata[]): string {
  return [...hooks].sort((left, right) => left.key.localeCompare(right.key)).map(hook => hook.key).join('|')
}

function aggregateHostCurrentHash(hooks: readonly CodexOfficialHookMetadata[]): string {
  const values = [...hooks]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(hook => ({ key: hook.key, currentHash: hook.currentHash }))
  return `sha256:${sha256Json(values)}`
}

function assertOfficialHookMetadata(hook: CodexOfficialHookMetadata): void {
  if (!path.isAbsolute(hook.sourcePath)
    || !hook.key.startsWith(`${hook.sourcePath}:`)
    || !/^sha256:[a-f0-9]{64}$/u.test(hook.currentHash)) {
    throw new Error('invalid_official_codex_hook_metadata')
  }
}

function staticResult(
  context: AdapterOperationContext,
  capability: 0 | 3,
  diagnostics: readonly string[],
  evidenceHash?: string,
): ComponentVerificationResult {
  return {
    componentKey: 'lifecycle',
    status: 'verified',
    verifiedCapability: capability,
    evidenceHash,
    identityAssertion: context.agentId,
    invalidationKeys: codexInvalidationKeys(),
    diagnostics,
  }
}

function codexInvalidationKeys(): readonly string[] {
  return [
    'artifact_hash',
    'host_hook_current_hash',
    'host_hook_trust',
    'host_version',
    'adapter_version',
    'projection_version',
    'tide_mind_version',
    'activity_freshness',
  ]
}

function codexHooksFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.lifecycle
    ?? path.join(context.installation.canonicalConfigRoot, 'hooks.json')
}

function instructionFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.instruction
    ?? path.join(context.runtime.homeDir, '.agents', 'skills', 'tidemind', 'SKILL.md')
}

function lifecycleEvents(context: AdapterOperationContext): readonly CodexLifecycleEvent[] {
  return [
    {
      eventName: 'SessionStart',
      canonicalEventName: 'sessionStart',
      signalName: 'session_start',
      matcher: 'startup|resume',
      scriptPath: context.runtime.hookScriptPath,
    },
    {
      eventName: 'PreCompact',
      canonicalEventName: 'preCompact',
      signalName: 'pre_compact',
      matcher: 'manual|auto',
      scriptPath: context.runtime.preCompactScriptPath,
    },
    {
      eventName: 'PostCompact',
      canonicalEventName: 'postCompact',
      signalName: 'post_compact',
      matcher: 'manual|auto',
      scriptPath: context.runtime.postCompactScriptPath,
    },
    {
      eventName: 'SessionEnd',
      canonicalEventName: 'sessionEnd',
      signalName: 'session_end',
      matcher: 'exit|archive',
      scriptPath: path.join(path.dirname(context.runtime.hookScriptPath), 'hook-session-end.cjs'),
    },
  ]
}

function desiredCommand(context: AdapterOperationContext, event: CodexLifecycleEvent): string {
  const args = [
    context.runtime.shimPath,
    event.scriptPath,
    '--agent-id', context.agentId,
    ...(event.eventName === 'SessionStart' ? [
      '--skill-path', instructionFile(context),
      '--expected-skill-sha256', PORTABLE_TIDEMIND_SKILL_SHA256,
    ] : []),
    '--tool', 'codex',
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
  ]
  return args.map(shellArgument).join(' ')
}

function desiredEntry(context: AdapterOperationContext, event: CodexLifecycleEvent): JsonValue {
  return {
    matcher: event.matcher,
    hooks: [{
      type: 'command',
      command: desiredCommand(context, event),
      ...(event.eventName === 'SessionStart' ? { statusMessage: STATUS_MESSAGE } : {}),
      timeout: 15,
    }],
  }
}

function desiredFragment(context: AdapterOperationContext): JsonValue {
  return Object.fromEntries(lifecycleEvents(context).map(event => [event.eventName, desiredEntry(context, event)]))
}

function identifiesTideMindEntry(candidate: JsonValue, context: AdapterOperationContext): boolean {
  const hooks = asObject(candidate)?.hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some(hook => {
    const command = asObject(hook)?.command
    return typeof command === 'string'
      && command.includes(`${shellArgument('--agent-id')} ${shellArgument(context.agentId)}`)
      && command.includes(`${shellArgument('--tool')} ${shellArgument('codex')}`)
      && (!context.activityGenerationToken
        || command.includes(`${shellArgument('--activity-generation-token')} ${shellArgument(context.activityGenerationToken)}`))
  })
}

function proposedDocument(
  context: AdapterOperationContext,
  sourcePath: string,
): Readonly<Record<string, JsonValue>> {
  let document: Record<string, JsonValue> = {}
  if (fs.existsSync(sourcePath)) {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as unknown
    const root = asObject(parsed)
    if (!root) throw new Error('managed_hook_json_root_not_object')
    document = structuredClone(root)
  }
  const hooks = document.hooks === undefined ? {} : asObject(document.hooks)
  if (!hooks) throw new Error('hook_selector_parent_not_object:hooks')
  document.hooks = hooks
  for (const event of lifecycleEvents(context)) {
    const current = hooks[event.eventName]
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`hook_event_not_array:${event.eventName}`)
    }
    const entries = current === undefined ? [] : [...current]
    const matching = entries
      .map((candidate, index) => identifiesTideMindEntry(candidate, context) ? index : -1)
      .filter(index => index >= 0)
    if (matching.length > 1) throw new Error(`duplicate_managed_hook_entries:${event.eventName}`)
    if (matching.length === 1) entries.splice(matching[0], 1)
    entries.push(desiredEntry(context, event))
    hooks[event.eventName] = entries
  }
  return document
}

function asObject(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}

/**
 * Reads Codex's hook declaration and user trust state without starting an
 * Agent-controlled executable. The normalized hashes mirror Codex's public
 * hook contract (`version_for_toml` over the normalized handler identity).
 */
export function createOfficialCodexHooksPort(options: {
  /** Test-only path override; production checks Codex's documented Unix policy layers. */
  managedPolicyPaths?: readonly string[]
} = {}): CodexOfficialHooksPort {
  const managedPolicyPaths = options.managedPolicyPaths ?? [
    '/etc/codex/requirements.toml',
    '/etc/codex/managed_config.toml',
    '/etc/codex/config.toml',
  ]
  return {
    async list(context) {
      const target = assertCanonicalCodexHooksTarget(context)
      return readCodexHooksSnapshot(context, target, undefined, managedPolicyPaths)
    },
    async preview(context, sourcePath, proposed) {
      assertCanonicalCodexHooksTarget(context, sourcePath)
      return readCodexHooksSnapshot(context, sourcePath, proposed, managedPolicyPaths)
    },
  }
}

/**
 * Read-only completion boundary for the UI/service `/hooks` flow. It accepts
 * only the exact action that was frozen in the approved plan and re-derives
 * every binding from fresh, stable snapshots of Codex's official hook and
 * trust-state files. Persistence remains
 * the repository's responsibility after this returns a positive result.
 */
export async function verifyCodexHookTrustAction(
  context: AdapterOperationContext,
  action: CodexHookTrustRequiredUserAction,
  hooksPort: CodexOfficialHooksPort = createOfficialCodexHooksPort(),
): Promise<CodexHookTrustVerification | null> {
  if (action.kind !== 'codex_hook_trust'
    || action.componentKey !== 'lifecycle'
    || action.installationId !== context.installationId
    || action.agentId !== context.agentId
    || action.hostVariant !== context.installation.hostVariant
    || action.tideMindVersion !== context.runtime.tideMindVersion
    || action.projectionVersion !== context.runtime.projectionVersion) return null
  const snapshot = await hooksPort.list(context)
  const hooks = exactManagedHooks(snapshot.hooks, context)
  if (hooks.length !== lifecycleEvents(context).length
    || hooks.some(hook => hook.trustStatus !== 'trusted')
    || hooks.some(hook => hook.sourcePath !== action.sourcePath)
    || aggregateHookKey(hooks) !== action.hookKey) return null
  const rebound = buildTrustBinding({
    catalogId: action.hostVariant,
    adapterVersion: action.adapterVersion,
  }, context, action.hostVersion, hooks, action.ownedFragmentHash)
  const bindingKeys: ReadonlyArray<keyof CodexHookTrustBinding> = [
    'installationId',
    'agentId',
    'hostVariant',
    'sourcePathHash',
    'hookKeyHash',
    'ownedFragmentHash',
    'hostCurrentHash',
    'tideMindVersion',
    'adapterVersion',
    'projectionVersion',
    'hostVersion',
  ]
  if (!bindingKeys.every(key => rebound[key] === action[key])) return null
  return {
    trusted: true,
    sourcePath: hooks[0].sourcePath,
    hookKey: aggregateHookKey(hooks),
    hostCurrentHash: aggregateHostCurrentHash(hooks),
    hooksFileFingerprint: snapshot.hooksFileFingerprint,
    trustConfigFingerprint: snapshot.trustConfigFingerprint,
  }
}

function assertCanonicalCodexHooksTarget(
  context: AdapterOperationContext,
  explicitTarget = codexHooksFile(context),
): string {
  const canonicalRoot = fs.realpathSync(context.installation.canonicalConfigRoot)
  const expected = path.join(canonicalRoot, 'hooks.json')
  const observed = inspectRegularFileWithinRoot(explicitTarget, canonicalRoot).canonicalPath
  if (observed !== expected) throw new Error('codex_hooks_target_must_be_canonical_root_hooks_json')
  return observed
}

function readCodexHooksSnapshot(
  context: AdapterOperationContext,
  sourcePath: string,
  proposed?: Readonly<Record<string, JsonValue>>,
  managedPolicyPaths: readonly string[] = [],
): CodexOfficialHooksSnapshot {
  const hooksSnapshot = proposed
    ? { content: Buffer.from(JSON.stringify(proposed)), fingerprint: sha256Json(proposed) }
    : readStableFileSync(sourcePath, 1024 * 1024)
  const configPath = path.join(context.installation.canonicalConfigRoot, 'config.toml')
  const configSnapshot = readOptionalStableFileSync(configPath, 2 * 1024 * 1024)
  const parsedHooks = proposed ?? JSON.parse(hooksSnapshot.content.toString('utf8')) as unknown
  const parsedConfig = configSnapshot.content.length > 0
    ? parseToml(configSnapshot.content.toString('utf8')) as unknown
    : {}
  const managedLayerFingerprints = assertNoManagedOnlyRequirement(managedPolicyPaths)
  return {
    hooks: codexHookMetadataFromDocuments(context, sourcePath, parsedHooks, parsedConfig),
    hooksFileFingerprint: hooksSnapshot.fingerprint,
    trustConfigFingerprint: sha256Json({
      userConfig: configSnapshot.fingerprint,
      managedLayers: managedLayerFingerprints,
    }),
  }
}

function assertNoManagedOnlyRequirement(
  managedPolicyPaths: readonly string[],
): readonly { path: string; fingerprint: string }[] {
  const fingerprints: Array<{ path: string; fingerprint: string }> = []
  for (const policyPath of managedPolicyPaths) {
    const snapshot = readOptionalStableFileSync(policyPath, 2 * 1024 * 1024)
    fingerprints.push({ path: path.resolve(policyPath), fingerprint: snapshot.fingerprint })
    if (snapshot.content.length === 0) continue
    // Ordinary system/user/profile feature values participate in Codex's
    // layered precedence and cannot prove that hooks are ineffective. This
    // receipt deliberately attests only the user trust layer. The one known
    // non-overridable constraint relevant here is requirements.toml's
    // managed-hooks-only mode.
    const policyBasename = path.basename(policyPath)
    if (policyBasename !== 'requirements.toml' && policyBasename !== 'managed_config.toml') continue
    const policy = asObject(parseToml(snapshot.content.toString('utf8')) as unknown)
    if (!policy) throw new Error(`codex_managed_policy_invalid:${policyPath}`)
    if (policy.allow_managed_hooks_only === true) {
      throw new Error(`codex_managed_policy_blocks_user_hooks:${policyPath}`)
    }
  }
  return fingerprints
}

function codexHookMetadataFromDocuments(
  context: AdapterOperationContext,
  sourcePath: string,
  hooksDocument: unknown,
  configDocument: unknown,
): CodexOfficialHookMetadata[] {
  const root = asObject(hooksDocument)
  const hooksRoot = root && asObject(root.hooks)
  if (!hooksRoot) throw new Error('official_hooks_file_invalid')
  const configRoot = asObject(configDocument)
  const state = asObject(asObject(configRoot?.hooks)?.state) ?? {}
  const metadata: CodexOfficialHookMetadata[] = []
  for (const event of lifecycleEvents(context)) {
    const groups = hooksRoot[event.eventName]
    if (groups === undefined) continue
    if (!Array.isArray(groups)) throw new Error(`official_hook_event_not_array:${event.eventName}`)
    groups.forEach((candidate, groupIndex) => {
      const group = asObject(candidate)
      if (!group || !Array.isArray(group.hooks)) {
        throw new Error(`official_hook_group_invalid:${event.eventName}:${groupIndex}`)
      }
      const matcher = group.matcher === undefined || group.matcher === null
        ? null
        : typeof group.matcher === 'string' ? group.matcher : undefined
      if (matcher === undefined) throw new Error(`official_hook_matcher_invalid:${event.eventName}:${groupIndex}`)
      group.hooks.forEach((handlerValue, handlerIndex) => {
        const handler = asObject(handlerValue)
        if (!handler || handler.type !== 'command' || typeof handler.command !== 'string') return
        const timeoutSec = normalizedCodexHookTimeout(event.eventName, handler.timeout)
        const statusMessage = handler.statusMessage === undefined || handler.statusMessage === null
          ? null
          : typeof handler.statusMessage === 'string' ? handler.statusMessage : undefined
        if (statusMessage === undefined) {
          throw new Error(`official_hook_status_message_invalid:${event.eventName}:${groupIndex}`)
        }
        const key = `${sourcePath}:${event.signalName}:${groupIndex}:${handlerIndex}`
        const currentHash = codexHookCurrentHash(event, matcher, handler, timeoutSec, statusMessage)
        const hookState = asObject(state[key])
        const trustedHash = hookState?.trusted_hash
        const trustStatus: CodexHookTrustStatus = typeof trustedHash !== 'string'
          ? 'untrusted'
          : trustedHash === currentHash ? 'trusted' : 'modified'
        metadata.push({
          key,
          eventName: event.canonicalEventName,
          handlerType: 'command',
          matcher,
          command: handler.command,
          timeoutSec,
          statusMessage,
          sourcePath,
          source: 'user',
          enabled: hookState?.enabled !== false,
          isManaged: false,
          currentHash,
          trustStatus,
        })
      })
    })
  }
  return metadata
}

function normalizedCodexHookTimeout(eventName: CodexLifecycleEvent['eventName'], value: JsonValue | undefined): number {
  if (!(value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))) {
    throw new Error(`official_hook_timeout_invalid:${eventName}`)
  }
  if (eventName === 'SessionEnd') return Math.min(3, Math.max(1, value ?? 1))
  return Math.max(1, value ?? 600)
}

function codexHookCurrentHash(
  event: CodexLifecycleEvent,
  matcher: string | null,
  handler: Record<string, JsonValue>,
  timeoutSec: number,
  statusMessage: string | null,
): string {
  const normalizedHandler: Record<string, JsonValue> = {
    type: 'command',
    command: String(handler.command),
    timeout: timeoutSec,
    async: handler.async === true,
  }
  if (statusMessage !== null) normalizedHandler.statusMessage = statusMessage
  if (event.eventName === 'SessionStart'
    && typeof handler.additionalContextLimit === 'number'
    && handler.additionalContextLimit !== 2_500) {
    normalizedHandler.additionalContextLimit = handler.additionalContextLimit
  }
  const identity: Record<string, JsonValue> = {
    event_name: event.signalName,
    hooks: [normalizedHandler],
  }
  if (matcher !== null) identity.matcher = matcher
  return `sha256:${sha256Json(identity)}`
}

function readOptionalStableFileSync(targetPath: string, maxBytes: number): { content: Buffer; fingerprint: string } {
  try {
    return readStableFileSync(targetPath, maxBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { content: Buffer.alloc(0), fingerprint: sha256Json({ absent: path.resolve(targetPath) }) }
  }
}

function readStableFileSync(targetPath: string, maxBytes: number): { content: Buffer; fingerprint: string } {
  const fd = fs.openSync(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error('official_hook_state_file_invalid')
    const content = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < content.length) {
      const bytesRead = fs.readSync(fd, content, offset, content.length - offset, offset)
      if (bytesRead === 0) throw new Error('official_hook_state_short_read')
      offset += bytesRead
    }
    const after = fs.fstatSync(fd, { bigint: true })
    const identity = (stat: typeof before) => [
      stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs,
    ].join(':')
    if (identity(before) !== identity(after)) throw new Error('official_hook_state_changed_during_read')
    return {
      content,
      fingerprint: sha256Json({
        device: String(before.dev),
        inode: String(before.ino),
        size: Number(before.size),
        mode: Number(before.mode & 0o7777n),
        linkCount: String(before.nlink),
        mtimeNs: String(before.mtimeNs),
        ctimeNs: String(before.ctimeNs),
        sha256: sha256Bytes(content),
      }),
    }
  } finally {
    fs.closeSync(fd)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function codexLifecycleUserFacingText(): Readonly<{
  trustInstruction: string
  statusMessage: string
}> {
  return { trustInstruction: TRUST_INSTRUCTION, statusMessage: STATUS_MESSAGE }
}
