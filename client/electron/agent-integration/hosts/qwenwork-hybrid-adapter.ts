import path from 'node:path'
import { sha256Bytes, sha256Json } from '../fingerprint'
import { verifyMemoryReadWriteActivity } from '../host-activity-evidence'
import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AdapterVerificationRequest,
  AgentHostAdapter,
  ComponentKey,
  ComponentVerificationResult,
  JsonValue,
  MutationReadBack,
  QwenWorkMcpRequiredUserAction,
} from '../types'
import { createCompositeHostAdapter } from './composite-adapter'
import { createJsonLifecycleHookHostAdapter } from './json-lifecycle-hook-adapter'
import { createManagedTextHostAdapter } from './managed-text-adapter'

const CATALOG_ID = 'qwenwork-desktop' as const
const DISTRIBUTION_ID = 'cn.qwenwork.desktop.mac'
const SIGNING_TEAM_ID = 'XN6U3EV979'
const PACKAGE_PROVENANCE = `signed_app:${DISTRIBUTION_ID}:${SIGNING_TEAM_ID}`
export const QWENWORK_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start', 'pre_compact', 'session_end',
] as const)

export const qwenWorkUserFacingText = Object.freeze({
  connectInstruction: '请在 QwenWork 的「扩展」→「连接器」中手动添加并启用 Tide Mind STDIO 连接器，然后新建一个对话任务完成验证。',
  disconnectInstruction: '请在 QwenWork 的「扩展」→「连接器」→「已安装」中删除 Tide Mind 连接器，然后返回 Tide Mind 重新校验。',
})

export interface QwenWorkHybridHostSpec {
  adapterVersion: string
  skillContent: string
}

/**
 * QwenWorkCN exposes one user config root. Its embedded agent runtime loads
 * Skills from ~/.qwenworkcn/skills and user Hooks from
 * ~/.qwenworkcn/settings.json. MCP remains a guided GUI action because the
 * desktop connector registry is not a documented external write contract.
 */
export function createQwenWorkHybridHostAdapter(spec: QwenWorkHybridHostSpec): AgentHostAdapter {
  const effectiveAdapterVersion = [spec.adapterVersion, spec.adapterVersion, spec.adapterVersion].join('+')
  const instruction = createManagedTextHostAdapter({
    catalogId: CATALOG_ID,
    adapterVersion: spec.adapterVersion,
    componentKey: 'instruction',
    artifactType: 'skill',
    targetFile: context => instructionFile(context),
    allowedRoot: context => requiredComponentRoot(context, 'instruction'),
    content: () => spec.skillContent,
    reload: 'new_session',
    recognitionViaHostActivity: {
      componentKey: 'lifecycle',
      signalNames: ['session_start'],
      require: 'any',
      diagnostic: 'qwenwork_skill_loaded_by_session_start',
    },
  })
  const lifecycle = createJsonLifecycleHookHostAdapter({
    catalogId: CATALOG_ID,
    adapterVersion: spec.adapterVersion,
    configFile: context => lifecycleFile(context),
    eventRoot: ['hooks'],
    activationMode: 'always_enabled',
    activityRequirement: 'all',
    reload: 'restart_host',
    distributionId: DISTRIBUTION_ID,
    preserveJsonc: true,
    events: context => [
      {
        eventName: 'SessionStart',
        signalName: QWENWORK_REQUIRED_LIFECYCLE_SIGNALS[0],
        entry: qwenWorkLifecycleEntry(
          context,
          'SessionStart',
          'startup|resume|clear|new|compact',
          [
            '--skill-path', instructionFile(context),
            '--skill-sha256', sha256Bytes(normalizeManagedText(spec.skillContent)),
          ],
        ),
      },
      {
        eventName: 'PreCompact',
        signalName: QWENWORK_REQUIRED_LIFECYCLE_SIGNALS[1],
        entry: qwenWorkLifecycleEntry(context, 'PreCompact', 'manual|auto'),
      },
      {
        eventName: 'SessionEnd',
        signalName: QWENWORK_REQUIRED_LIFECYCLE_SIGNALS[2],
        entry: qwenWorkLifecycleEntry(
          context,
          'SessionEnd',
          'clear|resume|logout|prompt_input_exit|bypass_permissions_disabled|other',
        ),
      },
    ],
    identifiesEntry: (_event, candidate, context) => identifiesLifecycleEntry(candidate, context),
  })
  const memory = createGuidedQwenWorkMemoryAdapter(spec.adapterVersion, effectiveAdapterVersion)
  const composite = createCompositeHostAdapter(CATALOG_ID, [instruction, memory, lifecycle])

  return guardQwenWorkIdentity(composite)
}

function createGuidedQwenWorkMemoryAdapter(
  componentAdapterVersion: string,
  effectiveAdapterVersion: string,
): AgentHostAdapter {
  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => ({
    catalogId: CATALOG_ID,
    detected: detected(context),
    detectedVersion: context.hostVersion,
    distribution: { ...context.installation.distribution },
    components: [{
      componentKey: 'memory_tools',
      visibility: 'unknown',
      verificationStatus: 'unverified',
      details: {
        managementSurface: 'qwenwork_gui_connector',
        registryReadable: false,
        // Passive inspection has no activation generation. The stable display
        // identity must remain readable without constructing a writable MCP
        // projection, whose token is mandatory.
        connectorName: connectorName(context.agentId),
      },
    }],
    provenance: ['qwenwork://extensions/connectors'],
    diagnostics: ['qwenwork_connector_registry_not_readable_guided_only'],
  })

  const buildPlan = (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    operation: 'connect' | 'disconnect',
  ): AdapterPlan => {
    const base = emptyPlan(context, componentAdapterVersion)
    if (!request.desiredComponents.includes('memory_tools')) {
      return { ...base, diagnostics: ['component_not_requested'] }
    }
    if (!request.observed.detected) return { ...base, diagnostics: ['host_not_detected'] }
    if (!context.installationId || !context.hostVersion) {
      return { ...base, diagnostics: ['qwenwork_guided_action_binding_missing'] }
    }
    const detail = guidedAction(context, effectiveAdapterVersion, operation)
    return {
      ...base,
      requiredUserActions: [operation === 'connect'
        ? 'qwenwork_mcp_gui_connect_required'
        : 'qwenwork_mcp_gui_disconnect_required'],
      requiredUserActionDetails: [detail],
      diagnostics: ['qwenwork_connector_registry_not_readable_guided_only'],
    }
  }

  return {
    catalogId: CATALOG_ID,
    adapterVersion: componentAdapterVersion,
    componentKeys: ['memory_tools'],
    implementationTypes: { memory_tools: ['mcp'] },
    componentContracts: {
      memory_tools: {
        deliveryMode: 'guided', artifactTypes: ['mcp'], mutationDomain: 'none', reload: 'user_confirmation',
      },
    },
    inspect,
    inspectAdoptableArtifacts: async () => [],
    plan: async (context, request) => buildPlan(context, request, 'connect'),
    disconnect: async (context, request) => buildPlan(context, {
      desiredCapability: 0,
      desiredComponents: request.componentKeys,
      observed: request.observed,
      ownedArtifacts: request.ownedArtifacts,
    }, 'disconnect'),
    async apply(_context, mutation) {
      throw new Error(`qwenwork_guided_memory_has_no_automatic_mutation:${mutation.operationId}`)
    },
    async readBack(_context, mutation): Promise<MutationReadBack> {
      return {
        operationId: mutation.operationId,
        observed: false,
        matchesDesired: false,
        visibility: 'unknown',
        diagnostics: ['qwenwork_connector_registry_not_readable_guided_only'],
      }
    },
    async verify(context, request): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes('memory_tools')) return []
      if (request.expectedCapability === 0) {
        const binding = request.activityBinding
        const connector = connectorName(context.agentId)
        const receipt = binding?.activationRunId
          && binding.activityGenerationToken
          && context.installationId
          && context.guidedRemovalEvidence
          ? await context.guidedRemovalEvidence.findGuidedRemovalEvidence({
              installationId: context.installationId,
              agentId: context.agentId,
              hostVariant: CATALOG_ID,
              componentKey: 'memory_tools',
              activationRunId: binding.activationRunId,
              activityGenerationToken: binding.activityGenerationToken,
              connectorName: connector,
            })
          : null
        if (receipt) {
          return [{
            componentKey: 'memory_tools',
            status: 'verified',
            verifiedCapability: 0,
            evidenceRef: `user-confirmed-guided-removal:${receipt.id}`,
            evidenceHash: sha256Json(receipt),
            identityAssertion: context.agentId,
            invalidationKeys: ['consent', 'activity_generation', 'host_version'],
            diagnostics: ['user_confirmed_guided_removal'],
          }]
        }
        return [unverified('memory_tools', 'qwenwork_connector_disconnect_not_machine_readable')]
      }
      const result = await verifyMemoryReadWriteActivity(context, request)
      // The QwenWork connector is configured through the host's guided UI and
      // has no managed Artifact row. Its validity follows the frozen activity
      // generation and host/runtime bindings, not an imaginary artifact hash.
      return [{
        ...result,
        invalidationKeys: result.invalidationKeys.filter(key => key !== 'artifact_hash'),
      }]
    },
  }
}

function guardQwenWorkIdentity(adapter: AgentHostAdapter): AgentHostAdapter {
  const guardedPlan = async (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    operation: 'connect' | 'disconnect',
  ): Promise<AdapterPlan> => {
    const diagnostics = contextDiagnostics(context, true)
    if (diagnostics.length > 0) {
      return { ...emptyPlan(context, adapter.adapterVersion), diagnostics }
    }
    return operation === 'connect'
      ? adapter.plan(context, request)
      : adapter.disconnect(context, {
          componentKeys: request.desiredComponents,
          observed: request.observed,
          ownedArtifacts: request.ownedArtifacts,
        })
  }

  return {
    ...adapter,
    async inspect(context) {
      const diagnostics = contextDiagnostics(context, false)
      if (diagnostics.length === 0) return adapter.inspect(context)
      return blockedInspection(context, diagnostics)
    },
    plan: (context, request) => guardedPlan(context, request, 'connect'),
    disconnect: (context, request) => guardedPlan(context, {
      desiredCapability: 0,
      desiredComponents: request.componentKeys,
      observed: request.observed,
      ownedArtifacts: request.ownedArtifacts,
    }, 'disconnect'),
    async apply(context, mutation) {
      // Live signing authorization is rechecked by the coordinator immediately
      // before this effect. Journal replay intentionally does not depend on a
      // separately supplied mutable host-version field.
      assertContext(context, false)
      return adapter.apply(context, mutation)
    },
    async readBack(context, mutation) {
      const diagnostics = contextDiagnostics(context, false)
      if (diagnostics.length > 0) {
        return {
          operationId: mutation.operationId,
          observed: false,
          matchesDesired: false,
          visibility: 'unknown',
          diagnostics,
        }
      }
      return adapter.readBack(context, mutation)
    },
    async verify(context, request: AdapterVerificationRequest) {
      const diagnostics = contextDiagnostics(context, false)
      if (!request.activityBinding?.hostVersion) diagnostics.push('qwenwork_host_version_unproven')
      if (diagnostics.length === 0) return adapter.verify(context, request)
      return request.componentKeys.map(componentKey => unverified(componentKey, diagnostics[0]))
    },
  }
}

function guidedAction(
  context: AdapterOperationContext,
  adapterVersion: string,
  operation: 'connect' | 'disconnect',
): QwenWorkMcpRequiredUserAction {
  const configuration = connectorConfiguration(context)
  const hostVersion = context.hostVersion!
  const installationId = context.installationId!
  const installationBindingHash = sha256Json({
    installationId,
    installKey: context.installation.installKey,
    hostVersion,
    distribution: context.installation.distribution,
    componentConfigRoots: context.installation.componentConfigRoots ?? {},
    componentConfigFiles: context.installation.componentConfigFiles ?? {},
  })
  const connectSteps = [
    '打开 QwenWork，进入「扩展」→「连接器」。',
    '选择 JSON 配置入口，复制下方完整的 mcpServers JSON 并粘贴。',
    '确认 JSON 中 command、args 和 env 为分离字段，然后应用配置。',
    '确认连接器已启用，新建一个对话任务，并在同一对话中分别成功调用 Tide Mind 的 brain_recall 与 brain_digest。',
  ]
  const disconnectSteps = [
    '打开 QwenWork，进入「扩展」→「连接器」→「已安装」。',
    `在「自定义」区域找到「${configuration.connectorName}」，点击删除图标并确认删除。`,
    '新建一个对话任务，然后返回 Tide Mind 重新校验。',
  ]
  return {
    kind: 'qwenwork_mcp_gui',
    componentKey: 'memory_tools',
    operation,
    installationId,
    agentId: context.agentId,
    hostVariant: CATALOG_ID,
    hostVersion,
    tideMindVersion: context.runtime.tideMindVersion,
    adapterVersion,
    projectionVersion: context.runtime.projectionVersion,
    installationBindingHash,
    ...configuration,
    steps: operation === 'connect' ? connectSteps : disconnectSteps,
    instruction: operation === 'connect'
      ? qwenWorkUserFacingText.connectInstruction
      : qwenWorkUserFacingText.disconnectInstruction,
  }
}

function connectorConfiguration(context: AdapterOperationContext): Pick<
  QwenWorkMcpRequiredUserAction,
  'connectorName' | 'serverType' | 'command' | 'args' | 'environment' | 'configurationJson' | 'connectorConfigurationHash'
> {
  const stableConnectorName = connectorName(context.agentId)
  const command = context.runtime.shimPath
  const args = [context.runtime.mcpServerPath]
  const activityGenerationToken = context.activityGenerationToken?.trim()
  if (!activityGenerationToken) throw new Error('qwenwork_activity_generation_not_frozen')
  const environment = {
    EB_AGENT_ID: context.agentId,
    EB_HOST_VARIANT: CATALOG_ID,
    EB_ACTIVITY_GENERATION_TOKEN: activityGenerationToken,
  } as const
  const configuration = {
    mcpServers: {
      [stableConnectorName]: { command, args, env: environment },
    },
  }
  return {
    connectorName: stableConnectorName,
    serverType: 'STDIO',
    command,
    args,
    environment,
    configurationJson: JSON.stringify(configuration, null, 2),
    connectorConfigurationHash: sha256Json(configuration),
  }
}

function connectorName(agentId: string): string {
  return `Tide Mind - ${agentId}`
}

function qwenWorkLifecycleEntry(
  context: AdapterOperationContext,
  event: 'SessionStart' | 'PreCompact' | 'SessionEnd',
  matcher: string,
  extraArgs: readonly string[] = [],
): JsonValue {
  const scriptPath = path.join(path.dirname(context.runtime.hookScriptPath), 'hook-qwenwork-lifecycle.cjs')
  const command = [
    context.runtime.shimPath,
    scriptPath,
    '--event', event,
    '--agent-id', context.agentId,
    ...extraArgs,
    '--tool', 'qwenwork',
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
  ].map(shellQuote).join(' ')
  return {
    matcher,
    hooks: [{
      type: 'command',
      command,
      timeout: 60,
    }],
  }
}

function normalizeManagedText(content: string): string {
  return `${content.replace(/\s+$/u, '')}\n`
}

function identifiesLifecycleEntry(candidate: JsonValue, context: AdapterOperationContext): boolean {
  const value = asObject(candidate)
  if (!Array.isArray(value?.hooks)) return false
  const agentBinding = `${shellQuote('--agent-id')} ${shellQuote(context.agentId)}`
  const hostBinding = `${shellQuote('--tool')} ${shellQuote('qwenwork')}`
  return value.hooks.some(hook => {
    const record = asObject(hook)
    return record?.type === 'command'
      && typeof record.command === 'string'
      && record.command.includes(agentBinding)
      && record.command.includes(hostBinding)
  })
}

function instructionFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.instruction
    ?? path.join(requiredComponentRoot(context, 'instruction'), 'skills', 'tidemind', 'SKILL.md')
}

function lifecycleFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.lifecycle
    ?? path.join(requiredComponentRoot(context, 'lifecycle'), 'settings.json')
}

function requiredComponentRoot(
  context: AdapterOperationContext,
  componentKey: 'instruction' | 'lifecycle',
): string {
  const value = context.installation.componentConfigRoots?.[componentKey]
  if (!value) throw new Error(`qwenwork_${componentKey}_component_root_not_frozen`)
  return value
}

function contextDiagnostics(context: AdapterOperationContext, requireHostVersion: boolean): string[] {
  const diagnostics: string[] = []
  if (context.installation.hostVariant !== CATALOG_ID) diagnostics.push('qwenwork_host_variant_mismatch')
  if (context.installation.distribution.distributionId !== DISTRIBUTION_ID) diagnostics.push('qwenwork_distribution_id_mismatch')
  if (context.installation.distribution.packageProvenance !== PACKAGE_PROVENANCE) diagnostics.push('qwenwork_package_provenance_unproven')
  if (!context.installation.distribution.executableRealpath || !path.isAbsolute(context.installation.distribution.executableRealpath)) {
    diagnostics.push('qwenwork_executable_realpath_unproven')
  }
  if (!context.installation.distribution.capabilityFingerprint) diagnostics.push('qwenwork_distribution_fingerprint_unproven')
  const instructionRoot = context.installation.componentConfigRoots?.instruction
  const lifecycleRoot = context.installation.componentConfigRoots?.lifecycle
  if (!instructionRoot || !path.isAbsolute(instructionRoot)) diagnostics.push('qwenwork_instruction_component_root_not_frozen')
  if (!lifecycleRoot || !path.isAbsolute(lifecycleRoot)) diagnostics.push('qwenwork_lifecycle_component_root_not_frozen')
  if (instructionRoot && path.resolve(instructionRoot) !== path.resolve(context.installation.canonicalConfigRoot)) {
    diagnostics.push('qwenwork_instruction_root_not_canonical')
  }
  if (lifecycleRoot && path.resolve(lifecycleRoot) !== path.resolve(context.installation.canonicalConfigRoot)) {
    diagnostics.push('qwenwork_lifecycle_root_not_canonical')
  }
  if (requireHostVersion && !context.hostVersion) diagnostics.push('qwenwork_host_version_unproven')
  return diagnostics
}

function assertContext(context: AdapterOperationContext, requireHostVersion: boolean): void {
  const diagnostics = contextDiagnostics(context, requireHostVersion)
  if (diagnostics.length > 0) throw new Error(diagnostics.join(','))
}

function blockedInspection(context: AdapterOperationContext, diagnostics: readonly string[]): AdapterInspection {
  return {
    catalogId: CATALOG_ID,
    detected: detected(context),
    detectedVersion: context.hostVersion,
    distribution: { ...context.installation.distribution },
    components: (['instruction', 'memory_tools', 'lifecycle'] as const).map(componentKey => ({
      componentKey,
      visibility: 'unknown',
      verificationStatus: 'unverified',
    })),
    provenance: [],
    diagnostics,
  }
}

function emptyPlan(context: AdapterOperationContext, adapterVersion: string): AdapterPlan {
  return {
    catalogId: CATALOG_ID,
    installationKey: context.installation.installKey,
    adapterVersion,
    projectionVersion: context.runtime.projectionVersion,
    mutations: [],
    requiredUserActions: [],
    requiredUserActionDetails: [],
    diagnostics: [],
  }
}

function unverified(componentKey: ComponentKey, diagnostic: string): ComponentVerificationResult {
  return {
    componentKey,
    status: 'unverified',
    verifiedCapability: null,
    invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version'],
    diagnostics: [diagnostic],
  }
}

function detected(context: AdapterOperationContext): boolean {
  return context.installation.distribution.distributionId === DISTRIBUTION_ID
    && Boolean(context.installation.distribution.executableRealpath)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function asObject(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}
