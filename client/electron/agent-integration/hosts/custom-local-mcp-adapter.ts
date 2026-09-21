import fs from 'node:fs'
import path from 'node:path'
import { createJsonMcpHostAdapter } from './json-mcp-adapter'
import { createCustomGuidedMcpHostAdapter, CUSTOM_GUIDED_PROFILE_PREFIX } from './custom-guided-mcp-adapter'
import type {
  AdapterOperationContext,
  AgentHostAdapter,
  JsonValue,
} from '../types'

const CUSTOM_PROFILE = /^custom-mcp:(standard_mcp_servers|nested_mcp_servers|opencode_mcp):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/u
const FORBIDDEN_SELECTOR_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type CustomMcpSchema = 'standard_mcp_servers' | 'nested_mcp_servers' | 'opencode_mcp'

interface CustomProjection {
  schema: CustomMcpSchema
  selectorKey: string
  configFile: string
}

/**
 * Guided adapter for a user-selected local MCP client. It recognizes only the
 * three frozen JSON selector contracts created by the Custom Installation
 * preflight; the user never supplies a command, argument list, environment or
 * remote transport to this adapter.
 */
export function createCustomLocalMcpHostAdapter(): AgentHostAdapter {
  const guided = createCustomGuidedMcpHostAdapter()
  const isGuided = (context: AdapterOperationContext) => context.installation.explicitProfile.startsWith(CUSTOM_GUIDED_PROFILE_PREFIX)
  const base = createJsonMcpHostAdapter({
    catalogId: 'custom-local-mcp',
    adapterVersion: '1',
    configFile: context => projection(context).configFile,
    selector: context => {
      const selected = projection(context)
      if (selected.schema === 'standard_mcp_servers') return ['mcpServers', selected.selectorKey]
      if (selected.schema === 'nested_mcp_servers') return ['mcp', 'servers', selected.selectorKey]
      return ['mcp', selected.selectorKey]
    },
    selectorSchemaVersion: 1,
    reload: 'new_session',
    detect: context => customSurfacePresent(context),
    buildEntry: context => customMcpEntry(context, projection(context).schema),
    allowLegacyAgentOnlyAdoption: false,
  })
  return {
    ...base,
    async inspect(context) {
      if (isGuided(context)) return guided.inspect(context)
      try {
        return await base.inspect(context)
      } catch (error) {
        return invalidInspection(context, error)
      }
    },
    async inspectAdoptableArtifacts(context) {
      if (isGuided(context)) return []
      try {
        return await base.inspectAdoptableArtifacts?.(context) ?? []
      } catch {
        return []
      }
    },
    plan: (context, request) => isGuided(context) ? guided.plan(context, request) : base.plan(context, request),
    disconnect: (context, request) => isGuided(context) ? guided.disconnect(context, request) : base.disconnect(context, request),
    async verify(context, request) {
      if (isGuided(context)) return guided.verify(context, request)
      let results
      try {
        results = await base.verify(context, request)
      } catch (error) {
        return [{
          componentKey: 'memory_tools',
          status: 'failed',
          verifiedCapability: null,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: [errorMessage(error)],
        }]
      }
      // A real brain_* invocation proves this exact MCP projection is callable,
      // but it does not prove that the unknown host loaded Tide Mind usage
      // instructions. Keep the generic memory-tools C2 result; C3 requires a
      // separately verified instruction component and host-load evidence.
      return results
    },
  }
}

function invalidInspection(context: AdapterOperationContext, error: unknown) {
  return {
    catalogId: 'custom-local-mcp' as const,
    detected: false,
    distribution: { ...context.installation.distribution },
    components: [{
      componentKey: 'memory_tools' as const,
      visibility: 'unknown' as const,
      verificationStatus: 'unverified' as const,
    }],
    provenance: [],
    diagnostics: [errorMessage(error)],
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function projection(context: AdapterOperationContext): CustomProjection {
  if (context.installation.hostVariant !== 'custom-local-mcp'
    || context.installation.productFamilyId !== 'custom-local-agent'
    || context.installation.runtimeRealm !== 'local_macos') {
    throw new Error('custom_mcp_identity_kind_mismatch')
  }
  const match = CUSTOM_PROFILE.exec(context.installation.explicitProfile)
  if (!match) throw new Error('custom_mcp_projection_profile_invalid')
  const schema = match[1] as CustomMcpSchema
  const selectorKey = match[2]
  if (FORBIDDEN_SELECTOR_KEYS.has(selectorKey)) throw new Error('custom_mcp_selector_key_forbidden')

  const configFile = context.installation.componentConfigFiles?.memory_tools
  if (!configFile || !path.isAbsolute(configFile) || configFile.includes('\0')) {
    throw new Error('custom_mcp_config_file_not_frozen_absolute')
  }
  if (!['.json', '.jsonc'].includes(path.extname(configFile).toLowerCase())) {
    throw new Error('custom_mcp_config_format_unsupported')
  }
  if (path.dirname(path.resolve(configFile)) !== path.resolve(context.installation.canonicalConfigRoot)) {
    throw new Error('custom_mcp_config_file_root_mismatch')
  }
  return { schema, selectorKey, configFile: path.resolve(configFile) }
}

function customSurfacePresent(context: AdapterOperationContext): boolean {
  try {
    projection(context)
    const root = context.installation.canonicalConfigRoot
    const executable = context.installation.distribution.executableRealpath
    const provenance = context.installation.distribution.packageProvenance
    const capability = context.installation.distribution.capabilityFingerprint
    if (!path.isAbsolute(root)
      || fs.realpathSync(root) !== path.resolve(root)
      || !fs.lstatSync(root).isDirectory()
      || !executable
      || !isExecutableRegularFile(executable)
      || provenance !== 'user_selected_local_executable'
      || !/^custom-local-surface:[a-f0-9]{64}$/u.test(capability ?? '')
      || !runtimeAssetsPresent(context)) return false
    return true
  } catch {
    return false
  }
}

function customMcpEntry(context: AdapterOperationContext, schema: CustomMcpSchema): JsonValue {
  if (!runtimeAssetsPresent(context)) throw new Error('custom_mcp_runtime_missing')
  const environment = {
    EB_AGENT_ID: context.agentId,
    EB_HOST_VARIANT: 'custom-local-mcp',
    ...(context.activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken } : {}),
  }
  if (schema === 'opencode_mcp') {
    return {
      type: 'local',
      command: [context.runtime.shimPath, context.runtime.mcpServerPath],
      enabled: true,
      environment,
    }
  }
  return {
    command: context.runtime.shimPath,
    args: [context.runtime.mcpServerPath],
    env: environment,
  }
}

function runtimeAssetsPresent(context: AdapterOperationContext): boolean {
  return isAbsoluteRegularFile(context.runtime.shimPath)
    && isAbsoluteRegularFile(context.runtime.mcpServerPath)
}

function isExecutableRegularFile(target: string): boolean {
  if (!isAbsoluteRegularFile(target)) return false
  try {
    return fs.realpathSync(target) === path.resolve(target)
      && (fs.accessSync(target, fs.constants.X_OK), true)
  } catch {
    return false
  }
}

function isAbsoluteRegularFile(target: string): boolean {
  try {
    return path.isAbsolute(target) && fs.lstatSync(target).isFile()
  } catch {
    return false
  }
}
