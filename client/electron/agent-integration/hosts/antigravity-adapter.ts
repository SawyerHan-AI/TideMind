import path from 'node:path'
import fs from 'node:fs'
import { ANTIGRAVITY_RULE_CONTENT } from '@server/antigravity-instruction.js'
import { createCompositeHostAdapter } from './composite-adapter'
import { createJsonMcpHostAdapter } from './json-mcp-adapter'
import { createManagedTextHostAdapter } from './managed-text-adapter'
import { inspectRegularFileWithinRoot } from '../safe-file'
import { sha256Json } from '../fingerprint'
import { shellArgument } from '../shell-argument'
import type { AdapterOperationContext, CatalogId, JsonValue } from '../types'

export type AntigravityCatalogId = Extract<CatalogId, 'antigravity-app' | 'antigravity-cli'>

/** Host management CLI is strict JSON. Empty newly-created config is allowed. */
function currentObject(context: AdapterOperationContext, filename: string): Record<string, JsonValue> {
  const root = context.installation.canonicalConfigRoot
  const file = inspectRegularFileWithinRoot(path.join(root, filename), root)
  if (!file.exists) return {}
  const raw = fs.readFileSync(file.canonicalPath, 'utf8')
  const document: unknown = raw.trim() ? JSON.parse(raw) : {}
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('antigravity_invalid_configuration')
  return document as Record<string, JsonValue>
}

function gate(context: AdapterOperationContext, filename: string, key: string, hook = false) {
  const document = currentObject(context, filename)
  const container = hook ? document : document.mcpServers
  if (container !== undefined && (!container || typeof container !== 'object' || Array.isArray(container))) {
    return { allowed: false, diagnostic: 'antigravity_invalid_configuration' }
  }
  const entry = (container as Record<string, JsonValue> | undefined)?.[key]
  if (entry === undefined) return { allowed: true }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { allowed: false, diagnostic: 'antigravity_invalid_configuration' }
  const settings = entry as Record<string, JsonValue>
  const blocked = hook ? settings.enabled === false : settings.disabled === true
  const tools = ['brain_prepare', 'brain_recall', 'brain_digest']
  const allow = settings.enabledTools
  const deny = settings.disabledTools
  const filtered = !hook && ((allow !== undefined && (!Array.isArray(allow)
    || !tools.every(tool => allow.includes(tool))))
    || (deny !== undefined && (!Array.isArray(deny) || tools.some(tool => deny.includes(tool)))))
  return blocked || filtered
    ? { allowed: false, diagnostic: blocked ? 'antigravity_component_disabled' : 'antigravity_tool_filter_requires_review',
        requiredUserAction: blocked
          ? hook ? 'review_antigravity_hook_disabled' : 'review_antigravity_mcp_disabled'
          : 'review_antigravity_tool_filter' }
    : { allowed: true }
}

function startEntry(context: AdapterOperationContext): JsonValue {
  return { SessionStart: [{ type: 'command', timeout: 15,
    command: [context.runtime.shimPath, context.runtime.hookScriptPath,
      '--agent-id', context.agentId, '--tool', 'antigravity',
      '--activity-generation-token', context.activityGenerationToken ?? ''].map(shellArgument).join(' ') }] }
}

export function createAntigravityHostAdapter(catalogId: AntigravityCatalogId) {
  const instruction = createManagedTextHostAdapter({
    catalogId, adapterVersion: '1', componentKey: 'instruction', artifactType: 'rule',
    targetFile: context => path.join(context.installation.canonicalConfigRoot, 'rules', 'tidemind.md'),
    allowedRoot: context => context.installation.canonicalConfigRoot,
    content: () => ANTIGRAVITY_RULE_CONTENT,
    reload: 'new_session',
    recognitionViaHostActivity: { componentKey: 'memory_tools', signalNames: ['brain_prepare'], require: 'all',
      diagnostic: 'antigravity_rule_recognized_in_configuration_domain' },
  })
  const memory = createJsonMcpHostAdapter({
    catalogId, adapterVersion: '1', configFile: context => path.join(context.installation.canonicalConfigRoot, 'mcp_config.json'),
    selectorRoot: ['mcpServers'], reload: 'new_session', allowLegacyAgentOnlyAdoption: false,
    activationGate: (context, key) => gate(context, 'mcp_config.json', key),
    buildEntry: context => ({
      command: context.runtime.shimPath, args: [context.runtime.mcpServerPath],
      env: { EB_AGENT_ID: context.agentId,
        ...(context.activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken } : {}) },
    }),
  })
  const lifecycle = createJsonMcpHostAdapter({
    catalogId, adapterVersion: '1', componentKey: 'lifecycle', artifactType: 'hook',
    configFile: context => path.join(context.installation.canonicalConfigRoot, 'hooks.json'),
    selector: context => [`tidemind-${context.agentId}`], reload: 'new_session', allowLegacyAgentOnlyAdoption: false,
    activationGate: (context, key) => gate(context, 'hooks.json', key, true),
    buildEntry: startEntry,
    assertsIdentity: (value, context) => sha256Json(value) === sha256Json(startEntry(context)),
  })
  const composite = createCompositeHostAdapter(catalogId, [instruction, memory, lifecycle])
  return { ...composite, verificationDependencies: { instruction: ['memory_tools'] as const } }
}
