import { sha256Json } from '../fingerprint'
import { verifyMemoryReadWriteActivity } from '../host-activity-evidence'
import { PORTABLE_TIDEMIND_SKILL } from './portable-skill'
import { customGuidedProjection, customMcpConfiguration } from './custom-mcp-configuration'
import type { AdapterOperationContext, AgentHostAdapter, CustomMcpImportRequiredUserAction } from '../types'

export const CUSTOM_GUIDED_PROFILE_PREFIX = 'custom-guided:'

/** Host settings remain entirely user-owned. Only identity and activation are managed. */
export function createCustomGuidedMcpHostAdapter(): AgentHostAdapter {
  const action = (context: AdapterOperationContext, operation: 'connect' | 'disconnect'): CustomMcpImportRequiredUserAction => {
    if (!context.installationId || !context.hostVersion || !context.activityGenerationToken) {
      throw new Error('custom_guided_activation_binding_missing')
    }
    const projection = customGuidedProjection(context.installation.explicitProfile)
    const connectorName = projection.selectorKey
    const environment = {
      EB_AGENT_ID: context.agentId,
      EB_HOST_VARIANT: 'custom-local-mcp',
      EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken,
    }
    const command = context.runtime.shimPath
    const args = [context.runtime.mcpServerPath]
    const configurationJson = customMcpConfiguration(projection.schema, connectorName, context.agentId, context.runtime, context.activityGenerationToken)
    return {
      kind: 'custom_mcp_import', componentKey: 'memory_tools', operation,
      installationId: context.installationId, agentId: context.agentId, hostVariant: 'custom-local-mcp',
      hostVersion: context.hostVersion, tideMindVersion: context.runtime.tideMindVersion,
      adapterVersion: '1', projectionVersion: context.runtime.projectionVersion,
      installationBindingHash: sha256Json(context.installation),
      connectorName, serverType: 'STDIO', command, args, environment,
      configurationJson,
      connectorConfigurationHash: sha256Json(JSON.parse(configurationJson)),
      usageGuide: PORTABLE_TIDEMIND_SKILL.split('\n## OpenCode V2')[0].trim(),
      instruction: operation === 'connect'
        ? '在本机 Agent 中导入下方 MCP 配置，并将使用说明加入该 Agent 的指令或 Skill。配置由你维护；Tide Mind 不会改写或自动恢复宿主配置。'
        : `请在本机 Agent 中移除 ${connectorName} 和 Tide Mind 使用说明，再确认完成。此确认是你的移除声明，不是机器验证。`,
      steps: operation === 'connect'
        ? ['导入 MCP 配置，或分别填写 command、args 和 env。', '新建会话，分别成功调用 brain_recall 与 brain_digest 后，返回重新校验。']
        : ['移除上述 MCP 连接和使用说明。', '重启宿主或新建会话，然后确认已移除。'],
    }
  }
  const build = (context: AdapterOperationContext, operation: 'connect' | 'disconnect') => ({
    catalogId: 'custom-local-mcp' as const, installationKey: context.installation.installKey,
    adapterVersion: '1', projectionVersion: context.runtime.projectionVersion,
    mutations: [], requiredUserActions: ['custom_mcp_import'], requiredUserActionDetails: [action(context, operation)],
    diagnostics: [],
  })
  return {
    catalogId: 'custom-local-mcp', adapterVersion: '1', componentKeys: ['memory_tools'],
    implementationTypes: { memory_tools: ['mcp'] },
    componentContracts: { memory_tools: { deliveryMode: 'guided', artifactTypes: ['mcp'], mutationDomain: 'none', reload: 'user_confirmation' } },
    inspect: async context => ({
      catalogId: 'custom-local-mcp', detected: context.installation.explicitProfile.startsWith(CUSTOM_GUIDED_PROFILE_PREFIX),
      detectedVersion: context.hostVersion, distribution: { ...context.installation.distribution },
      components: [{ componentKey: 'memory_tools', visibility: 'unknown', verificationStatus: 'unverified' }],
      provenance: [], diagnostics: [],
    }),
    inspectAdoptableArtifacts: async () => [],
    plan: async context => build(context, 'connect'),
    disconnect: async context => build(context, 'disconnect'),
    apply: async () => { throw new Error('custom_guided_has_no_file_mutations') },
    readBack: async (_context, mutation) => ({ operationId: mutation.operationId, observed: false, matchesDesired: false, visibility: 'unknown', diagnostics: ['user_owned_configuration'] }),
    verify: async (context, request) => {
      if (request.expectedCapability !== 0) {
        const result = await verifyMemoryReadWriteActivity(context, request)
        // No file is owned: validity follows the activation and executable,
        // never an imaginary managed-artifact hash.
        return [{ ...result, invalidationKeys: result.invalidationKeys.filter(key => key !== 'artifact_hash') }]
      }
      const binding = request.activityBinding
      const receipt = binding?.activationRunId && binding.activityGenerationToken && context.installationId
        ? await context.guidedRemovalEvidence?.findGuidedRemovalEvidence({
            installationId: context.installationId, agentId: context.agentId, hostVariant: 'custom-local-mcp',
            componentKey: 'memory_tools', activationRunId: binding.activationRunId,
            activityGenerationToken: binding.activityGenerationToken, connectorName: customGuidedProjection(context.installation.explicitProfile).selectorKey,
          }) : null
      return [{ componentKey: 'memory_tools', status: receipt ? 'verified' : 'unverified',
        verifiedCapability: receipt ? 0 : null, identityAssertion: context.agentId,
        ...(receipt ? { evidenceRef: `user-confirmed-guided-removal:${receipt.id}`, evidenceHash: sha256Json(receipt) } : {}),
        invalidationKeys: ['consent', 'activity_generation'], diagnostics: [receipt ? 'user_confirmed_guided_removal' : 'custom_guided_removal_pending'] }]
    },
  }
}
