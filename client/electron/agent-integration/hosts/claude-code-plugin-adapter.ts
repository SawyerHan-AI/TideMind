import { execFile } from 'node:child_process'
import { shellArgument } from '../shell-argument'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { sha256Bytes, sha256Json } from '../fingerprint'
import { verifyHostActivity, verifyMemoryReadWriteActivity } from '../host-activity-evidence'
import {
  ensureSafeParentDirectoryWithinRoot,
  inspectRegularFileWithinRoot,
  writeRegularFileAtomicCas,
} from '../safe-file'
import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AdapterVerificationRequest,
  AdoptableArtifactObservation,
  AgentHostAdapter,
  ComponentKey,
  ComponentVerificationResult,
  FrozenHostCommand,
  FrozenIntermediateState,
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../types'

export type ClaudeCodePluginCatalogId = 'claude-code-cli' | 'claude-code-native'

export const CLAUDE_CODE_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start',
  'pre_compact',
  'post_compact',
] as const)

export interface ClaudeCodeCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ClaudeCodePluginAdapterDependencies {
  run(
    executableRealpath: string,
    args: readonly string[],
    options: { timeoutMs: number; env: Readonly<Record<string, string>> },
  ): Promise<ClaudeCodeCommandResult>
}

export interface ClaudeCodePluginHostSpec {
  catalogId: ClaudeCodePluginCatalogId
  adapterVersion: string
  dependencies?: ClaudeCodePluginAdapterDependencies
}

interface DesiredBundle {
  marketplaceId: string
  marketplaceRoot: string
  pluginName: string
  qualifiedPlugin: string
  pluginVersion: string
  files: Readonly<Record<string, string>>
  fingerprint: string
}

interface BundleInspection {
  state: 'absent' | 'safe' | 'unsafe'
  fingerprint: string | null
  fileHashes: Readonly<Record<string, string | null>>
  diagnostics: readonly string[]
}

interface AggregateMetadata {
  kind: 'claude_plugin_aggregate'
  direction: 'install' | 'remove'
  marketplaceId: string
  marketplaceRoot: string
  quarantineRoot: string
  pluginName: string
  qualifiedPlugin: string
  pluginVersion: string
  beforePluginVersion: string | null
  desiredFiles: Readonly<Record<string, string>>
  beforeFileHashes: Readonly<Record<string, string | null>>
  commandStepIds: readonly string[]
}

interface MarketplaceState {
  status: 'absent' | 'exact' | 'conflict' | 'unknown'
  fingerprint: string | null
  diagnostic?: string
}

interface PluginState {
  status: 'absent' | 'desired' | 'before' | 'conflict' | 'unknown'
  fingerprint: string | null
  version?: string
  diagnostic?: string
}

interface AggregateObservation {
  bundle: BundleInspection
  marketplace: MarketplaceState
  plugin: PluginState
  fingerprint: string
  desired: boolean
  absent: boolean
  diagnostics: readonly string[]
}

const execFileAsync = promisify(execFile)
const COMPONENTS = ['instruction', 'memory_tools', 'lifecycle'] as const satisfies readonly ComponentKey[]
const OFFICIAL_NPM_PROVENANCE = 'npm_metadata:@anthropic-ai/claude-code'
const OFFICIAL_NATIVE_PROVENANCE = 'signed_cli:com.anthropic.claude-code:Q6L2SF6YDW'
const MARKETPLACE_SCHEMA = 'https://anthropic.com/claude-code/marketplace.schema.json'
const PLUGIN_MANIFEST_SCHEMA = 'https://json.schemastore.org/claude-code-plugin-manifest.json'
const SELECTOR_SCHEMA_VERSION = 1
const COMMAND_TIMEOUT_MS = 30_000
const MAX_BUNDLE_ENTRIES = 64
const MAX_BUNDLE_FILE_BYTES = 1024 * 1024

export function createClaudeCodePluginHostAdapter(spec: ClaudeCodePluginHostSpec): AgentHostAdapter {
  const dependencies = spec.dependencies ?? productionDependencies()

  return {
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    componentKeys: COMPONENTS,
    implementationTypes: {
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin', 'mcp'],
      lifecycle: ['plugin', 'hook'],
    },
    componentContracts: {
      instruction: { deliveryMode: 'managed', artifactTypes: ['plugin', 'skill'], mutationDomain: 'plugin_manager', reload: 'new_session' },
      memory_tools: { deliveryMode: 'managed', artifactTypes: ['plugin', 'mcp'], mutationDomain: 'plugin_manager', reload: 'new_session' },
      lifecycle: { deliveryMode: 'managed', artifactTypes: ['plugin', 'hook'], mutationDomain: 'plugin_manager', reload: 'new_session' },
    },

    async inspect(context): Promise<AdapterInspection> {
      const bundle = desiredBundle(context)
      const diagnostics: string[] = []
      let source: BundleInspection
      try {
        source = inspectBundle(bundle.marketplaceRoot, bundle.files, context.runtime.applicationDataDir)
        diagnostics.push(...source.diagnostics)
      } catch (error) {
        source = { state: 'unsafe', fingerprint: null, fileHashes: {}, diagnostics: [] }
        diagnostics.push(errorMessage(error))
      }
      const manageable = manageableDistribution(spec.catalogId, context)
      if (!manageable.ok) diagnostics.push(manageable.reason)
      const visibility = source.state === 'safe' ? 'dedicated' : source.state === 'absent' ? 'absent' : 'unknown'
      return {
        catalogId: spec.catalogId,
        detected: executableExists(context),
        distribution: { ...context.installation.distribution },
        components: COMPONENTS.map(componentKey => ({
          componentKey,
          visibility,
          verificationStatus: 'unverified',
          observedTarget: bundle.marketplaceRoot,
          observedFragmentHash: source.fingerprint ?? undefined,
          details: {
            implementation: 'claude_code_official_plugin',
            marketplaceId: bundle.marketplaceId,
            qualifiedPlugin: bundle.qualifiedPlugin,
            pluginVersion: bundle.pluginVersion,
          },
        })),
        provenance: [bundle.marketplaceRoot],
        diagnostics,
      }
    },

    async inspectAdoptableArtifacts(context) {
      return inspectLegacyClaudePlugin(context, dependencies)
    },

    async plan(context, request) {
      return buildPlan(spec, context, request, false)
    },

    async disconnect(context, request) {
      return buildPlan(spec, context, {
        desiredCapability: 0,
        desiredComponents: request.componentKeys,
        observed: request.observed,
        ownedArtifacts: request.ownedArtifacts,
      }, true)
    },

    async apply(context, mutation) {
      const metadata = parseMetadata(mutation)
      assertFrozenMutation(context, mutation, metadata)
      if (metadata.direction === 'remove') {
        await applyDisconnect(context, mutation, metadata, dependencies)
      } else {
        await applyInstall(context, mutation, metadata, dependencies)
      }
      const after = await readAggregate(context, mutation, metadata, dependencies)
      if (!after.matchesDesired) throw new Error(after.diagnostics.join(';') || 'claude_plugin_aggregate_readback_mismatch')
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: after.observedFragmentHash,
        hostReceipt: {
          qualifiedPlugin: metadata.qualifiedPlugin,
          marketplaceId: metadata.marketplaceId,
          commandStepIds: metadata.commandStepIds,
        },
      }
    },

    readBack(context, mutation) {
      return readAggregate(context, mutation, parseMetadata(mutation), dependencies)
    },

    verify(context, request) {
      return verifyClaudePlugin(context, request, desiredBundle(context), dependencies)
    },
  }
}

async function inspectLegacyClaudePlugin(
  context: AdapterOperationContext,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<readonly AdoptableArtifactObservation[]> {
  const pluginName = `tidemind-${context.agentId}`
  const legacyRoot = path.join(context.runtime.applicationDataDir, 'plugins', `claude-code-${context.agentId}`)
  try {
    assertContained(legacyRoot, context.runtime.applicationDataDir)
    if (!fs.existsSync(legacyRoot)) return []
    const entries = listBundleEntries(legacyRoot)
    const expectedFiles = [
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'hooks/hooks.json',
      'skills/tidemind/SKILL.md',
    ].sort()
    if (sha256Json(entries.files) !== sha256Json(expectedFiles)) return []
    const readJson = (relative: string): Record<string, unknown> => JSON.parse(
      fs.readFileSync(inspectRegularFileWithinRoot(path.join(legacyRoot, relative), context.runtime.applicationDataDir).canonicalPath, 'utf8'),
    ) as Record<string, unknown>
    const manifest = readJson('.claude-plugin/plugin.json')
    const mcp = readJson('.mcp.json')
    const hooks = readJson('hooks/hooks.json')
    const skill = fs.readFileSync(
      inspectRegularFileWithinRoot(path.join(legacyRoot, 'skills/tidemind/SKILL.md'), context.runtime.applicationDataDir).canonicalPath,
      'utf8',
    )
    const sourceSkill = inspectRegularFileWithinRoot(
      path.join(context.runtime.applicationDataDir, 'skill', 'claude-code-skill.md'),
      context.runtime.applicationDataDir,
    )
    const expectedEntry = {
      command: context.runtime.shimPath,
      args: [context.runtime.mcpServerPath],
      env: { EB_AGENT_ID: context.agentId },
    }
    if (manifest.name !== pluginName
      || typeof manifest.version !== 'string'
      || (manifest.author as { name?: unknown } | undefined)?.name !== 'TideMind'
      || sha256Json((mcp.mcpServers as Record<string, unknown> | undefined)?.tidemind) !== sha256Json(expectedEntry)
      || !legacyClaudeHooksMatch(hooks, context, legacyRoot)
      || !sourceSkill.exists
      || skill !== legacyClaudeSkill(pluginName) + fs.readFileSync(sourceSkill.canonicalPath, 'utf8')) return []
    const executable = context.installation.distribution.executableRealpath
    if (!executable) return []
    const marketplaceResult = await dependencies.run(executable, ['plugin', 'marketplace', 'list', '--json'], {
      timeoutMs: COMMAND_TIMEOUT_MS,
      env: claudeCliEnvironment(context, executable),
    })
    const pluginResult = await dependencies.run(executable, ['plugin', 'list', '--json'], {
      timeoutMs: COMMAND_TIMEOUT_MS,
      env: claudeCliEnvironment(context, executable),
    })
    if (marketplaceResult.exitCode !== 0 || pluginResult.exitCode !== 0) return []
    const marketplaceRoot = path.join(context.runtime.applicationDataDir, 'plugins')
    const marketplaces = jsonRecords(marketplaceResult.stdout).filter(record => stringField(record, ['name', 'id']) === 'tidemind-local')
    const qualifiedPlugin = `${pluginName}@tidemind-local`
    const plugins = jsonRecords(pluginResult.stdout).filter(record => pluginIdentity(record) === qualifiedPlugin)
    if (marketplaces.length !== 1 || path.resolve(marketplaceSourcePath(marketplaces[0]) ?? '') !== path.resolve(marketplaceRoot)
      || plugins.length !== 1 || stringField(plugins[0], ['version']) !== manifest.version
      || booleanField(plugins[0], ['enabled', 'isEnabled']) !== true
      || (Array.isArray(plugins[0].errors) && plugins[0].errors.length > 0)) return []
    const fingerprint = sha256Json(Object.fromEntries(expectedFiles.map(relative => [
      relative,
      inspectRegularFileWithinRoot(path.join(legacyRoot, relative), context.runtime.applicationDataDir).containerHash,
    ])))
    return COMPONENTS.map(componentKey => ({
      componentKey,
      artifactType: componentKey === 'instruction' ? 'skill' : componentKey === 'memory_tools' ? 'mcp' : 'hook',
      domainKind: 'directory',
      physicalTarget: legacyRoot,
      ownershipKey: `legacy-claude-plugin:${pluginName}:${componentKey}`,
      selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
      projectionVersion: context.runtime.projectionVersion,
      fragmentHash: fingerprint,
      identityAssertion: context.agentId,
      discoverReachability: 'dedicated',
    }))
  } catch {
    return []
  }
}

function legacyClaudeSkill(pluginName: string): string {
  return [
    '---',
    'description: "Tide Mind 外部记忆系统已连接。用户上下文在会话启动时自动加载。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。"',
    'when_to_use: |',
    '  用户提起"之前"、"上次"、"记得吗"、过去的决定或观点时；',
    '  需要判断用户偏好、历史态度、长期目标时；',
    '  用户明确说"记住"、"别忘了"、"以后不要..."时；',
    '  每次完成实质性请求后、用户做出决策或表达观点时需要沉淀结论。',
    'allowed-tools:',
    '  - mcp__tidemind__brain_prepare',
    '  - mcp__tidemind__brain_recall',
    '  - mcp__tidemind__brain_digest',
    `  - mcp__${pluginName}__brain_prepare`,
    `  - mcp__${pluginName}__brain_recall`,
    `  - mcp__${pluginName}__brain_digest`,
    `  - mcp__plugin_${pluginName}_tidemind__brain_prepare`,
    `  - mcp__plugin_${pluginName}_tidemind__brain_recall`,
    `  - mcp__plugin_${pluginName}_tidemind__brain_digest`,
    '---',
    '',
  ].join('\n')
}

function legacyClaudeHooksMatch(
  document: Record<string, unknown>,
  context: AdapterOperationContext,
  legacyRoot: string,
): boolean {
  const hooks = document.hooks as Record<string, unknown> | undefined
  if (!hooks || Object.keys(hooks).sort().join(',') !== 'PostCompact,PreCompact,SessionStart') return false
  const command = (event: string): string | null => {
    const groups = hooks[event]
    if (!Array.isArray(groups) || groups.length !== 1) return null
    const nested = (groups[0] as { hooks?: unknown }).hooks
    if (!Array.isArray(nested) || nested.length !== 1) return null
    const value = (nested[0] as { type?: unknown; command?: unknown })
    return value.type === 'command' && typeof value.command === 'string' ? value.command : null
  }
  const quoted = (value: string) => JSON.stringify(value)
  const session = [quoted(context.runtime.shimPath), quoted(context.runtime.hookScriptPath), '--agent-id', quoted(context.agentId), '--skill-path', quoted(path.join(legacyRoot, 'skills', 'tidemind', 'SKILL.md')), '--tool', quoted('claude-code')].join(' ')
  const pre = [quoted(context.runtime.shimPath), quoted(context.runtime.preCompactScriptPath), '--agent-id', quoted(context.agentId), '--tool', quoted('claude-code')].join(' ')
  const post = [quoted(context.runtime.shimPath), quoted(context.runtime.postCompactScriptPath), '--agent-id', quoted(context.agentId), '--tool', quoted('claude-code')].join(' ')
  return command('SessionStart') === session && command('PreCompact') === pre && command('PostCompact') === post
}

function buildPlan(
  spec: ClaudeCodePluginHostSpec,
  context: AdapterOperationContext,
  request: AdapterPlanRequest,
  remove: boolean,
): AdapterPlan {
  const bundle = desiredBundle(context)
  const diagnostics: string[] = []
  const manageable = manageableDistribution(spec.catalogId, context)
  if (!request.observed.detected) diagnostics.push('claude_code_host_not_detected')
  else if (!manageable.ok) diagnostics.push(manageable.reason)

  const requested = COMPONENTS.filter(component => request.desiredComponents.includes(component))
  if (requested.length !== COMPONENTS.length) diagnostics.push('claude_plugin_requires_aggregate_three_component_scope')
  const baseline = aggregateBaseline(request.ownedArtifacts, bundle)
  if (baseline.kind === 'conflict') diagnostics.push(baseline.reason)

  let mutation: PlannedMutation | undefined
  if (diagnostics.length === 0 && remove) {
    if (baseline.kind !== 'owned') diagnostics.push('claude_plugin_disconnect_requires_aggregate_ownership')
    else {
      const source = inspectBundle(bundle.marketplaceRoot, bundle.files, context.runtime.applicationDataDir)
      const beforeVersion = bundleVersion(source, bundle, context.agentId)
      if (source.state !== 'safe' || !source.fingerprint || !beforeVersion) {
        diagnostics.push('claude_plugin_owned_source_not_safe_for_disconnect')
      } else {
        mutation = aggregateMutation(context, bundle, source, baseline.value, beforeVersion, 'remove')
      }
    }
  } else if (diagnostics.length === 0 && !remove) {
    const source = inspectBundle(bundle.marketplaceRoot, bundle.files, context.runtime.applicationDataDir)
    if (baseline.kind === 'none' && source.state !== 'absent') {
      diagnostics.push('claude_plugin_source_exists_without_ownership')
    } else if (baseline.kind === 'owned') {
      const beforeVersion = bundleVersion(source, bundle, context.agentId)
      if (source.state !== 'safe' || !source.fingerprint || !beforeVersion) {
        diagnostics.push('claude_plugin_owned_source_not_safe_for_upgrade')
      } else {
        mutation = aggregateMutation(context, bundle, source, baseline.value, beforeVersion, 'install')
      }
    } else if (source.state === 'absent') {
      mutation = aggregateMutation(context, bundle, source, undefined, null, 'install')
    }
  }

  return {
    catalogId: spec.catalogId,
    installationKey: context.installation.installKey,
    adapterVersion: spec.adapterVersion,
    projectionVersion: context.runtime.projectionVersion,
    mutations: mutation ? [mutation] : [],
    requiredUserActions: [],
    diagnostics,
  }
}

function aggregateMutation(
  context: AdapterOperationContext,
  bundle: DesiredBundle,
  source: BundleInspection,
  baseline: OwnedArtifactBaseline | undefined,
  beforePluginVersion: string | null,
  direction: AggregateMetadata['direction'],
): PlannedMutation {
  const executable = context.installation.distribution.executableRealpath!
  const quarantineRoot = `${bundle.marketplaceRoot}.removed-${safeKebab(context.operationId)}`
  const commands = commandSequence(executable, bundle, direction, beforePluginVersion !== null)
  const commandStepIds = commands.map(command => command.stepId)
  const metadata: AggregateMetadata = {
    kind: 'claude_plugin_aggregate',
    direction,
    marketplaceId: bundle.marketplaceId,
    marketplaceRoot: bundle.marketplaceRoot,
    quarantineRoot,
    pluginName: bundle.pluginName,
    qualifiedPlugin: bundle.qualifiedPlugin,
    pluginVersion: bundle.pluginVersion,
    beforePluginVersion,
    desiredFiles: bundle.files,
    beforeFileHashes: source.fileHashes,
    commandStepIds,
  }
  const beforeSurface = baseline
    ? aggregateFingerprint(source.fingerprint, marketplaceHash(bundle), pluginHash(bundle, beforePluginVersion!))
    : null
  if (baseline && baseline.ownedFragmentHash !== beforeSurface) {
    throw new Error('claude_plugin_aggregate_baseline_mismatch')
  }
  const desiredHash = direction === 'remove'
    ? absentAggregateHash(bundle)
    : aggregateFingerprint(bundle.fingerprint, marketplaceHash(bundle), pluginHash(bundle, bundle.pluginVersion))
  const safeResumeStates = frozenIntermediateStates(bundle, metadata, source, direction)
  return {
    operationId: `${context.operationId}:claude-plugin-aggregate:${direction}`,
    componentKey: 'instruction',
    coveredComponentKeys: COMPONENTS,
    operation: 'host_command',
    domainKind: 'plugin_manager',
    physicalTarget: `claude:user:${bundle.qualifiedPlugin}`,
    ownershipKey: bundle.qualifiedPlugin,
    selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
    additionalFenceTargets: claudeFenceTargets(context, bundle, quarantineRoot),
    risk: 'elevated',
    reload: 'new_session',
    commandCategory: 'plugin_install',
    frozenCommands: commands.map(({ stepId: _stepId, ...command }) => command),
    safeResumeStates,
    preconditionHash: baseline?.ownedFragmentHash,
    desiredFragmentHash: desiredHash,
    idempotent: true,
    metadata: {
      ...(metadata as unknown as Readonly<Record<string, JsonValue>>),
      artifactKey: `claude-plugin:${bundle.qualifiedPlugin}`,
    },
  }
}

function commandSequence(
  executableRealpath: string,
  bundle: DesiredBundle,
  direction: AggregateMetadata['direction'],
  upgrading: boolean,
): Array<FrozenHostCommand & { stepId: string }> {
  if (direction === 'remove') {
    return [
      { stepId: 'plugin_uninstall', category: 'plugin_install', executableRealpath, args: ['plugin', 'uninstall', bundle.qualifiedPlugin, '--scope', 'user'] },
      { stepId: 'marketplace_remove', category: 'host_cli', executableRealpath, args: ['plugin', 'marketplace', 'remove', bundle.marketplaceId] },
    ]
  }
  return [
    { stepId: 'marketplace_add', category: 'host_cli', executableRealpath, args: ['plugin', 'marketplace', 'add', bundle.marketplaceRoot, '--scope', 'user'] },
    ...(upgrading ? [{ stepId: 'plugin_uninstall', category: 'plugin_install' as const, executableRealpath, args: ['plugin', 'uninstall', bundle.qualifiedPlugin, '--scope', 'user'] }] : []),
    { stepId: 'plugin_install', category: 'plugin_install', executableRealpath, args: ['plugin', 'install', bundle.qualifiedPlugin, '--scope', 'user', '--yes'] },
  ]
}

function claudeFenceTargets(
  context: AdapterOperationContext,
  bundle: DesiredBundle,
  quarantineRoot: string,
): NonNullable<PlannedMutation['additionalFenceTargets']> {
  const pluginRoot = path.join(context.runtime.homeDir, '.claude', 'plugins')
  return [
    { domainKind: 'directory', physicalTarget: bundle.marketplaceRoot },
    { domainKind: 'directory', physicalTarget: quarantineRoot },
    { domainKind: 'file_fragment', physicalTarget: path.join(context.runtime.homeDir, '.claude', 'settings.json') },
    { domainKind: 'file_fragment', physicalTarget: path.join(pluginRoot, 'known_marketplaces.json') },
    { domainKind: 'file_fragment', physicalTarget: path.join(pluginRoot, 'installed_plugins.json') },
    { domainKind: 'directory', physicalTarget: path.join(pluginRoot, 'cache', bundle.marketplaceId, bundle.pluginName) },
    { domainKind: 'directory', physicalTarget: path.join(pluginRoot, 'data', `${bundle.pluginName}-${bundle.marketplaceId}`) },
  ]
}

function frozenIntermediateStates(
  bundle: DesiredBundle,
  metadata: AggregateMetadata,
  source: BundleInspection,
  direction: AggregateMetadata['direction'],
): FrozenIntermediateState[] {
  const states: FrozenIntermediateState[] = []
  const add = (fingerprint: string, completedStepIds: string[]) => {
    if (!states.some(state => state.fingerprint === fingerprint)) states.push({ fingerprint, completedStepIds })
  }
  if (direction === 'remove') {
    add(
      aggregateFingerprint(source.fingerprint, marketplaceHash(bundle), null),
      ['plugin_uninstall'],
    )
    add(aggregateFingerprint(source.fingerprint, null, null), ['plugin_uninstall', 'marketplace_remove'])
    return states
  }

  const beforeMarketplace = metadata.beforePluginVersion ? marketplaceHash(bundle) : null
  const beforePlugin = metadata.beforePluginVersion ? pluginHash(bundle, metadata.beforePluginVersion) : null
  if (source.state === 'absent') add(absentAggregateHash(bundle), ['source_files:0'])
  const paths = Object.keys(metadata.desiredFiles).sort()
  for (let completed = 0; completed <= paths.length; completed++) {
    const hashes: Record<string, string | null> = { ...metadata.beforeFileHashes }
    for (const relative of paths.slice(0, completed)) hashes[relative] = sha256Bytes(metadata.desiredFiles[relative])
    add(
      aggregateFingerprint(bundleStateFingerprint(hashes), beforeMarketplace, beforePlugin),
      [`source_files:${completed}`],
    )
  }
  add(
    aggregateFingerprint(bundle.fingerprint, marketplaceHash(bundle), beforePlugin),
    ['source_files:complete', 'marketplace_add'],
  )
  if (metadata.beforePluginVersion) {
    add(
      aggregateFingerprint(bundle.fingerprint, marketplaceHash(bundle), null),
      ['source_files:complete', 'marketplace_add', 'plugin_uninstall'],
    )
  }
  const desired = aggregateFingerprint(bundle.fingerprint, marketplaceHash(bundle), pluginHash(bundle, bundle.pluginVersion))
  return states.filter(state => state.fingerprint !== desired)
}

async function applyInstall(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: AggregateMetadata,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<void> {
  applyBundle(context, metadata)
  let marketplace = await marketplaceState(context, mutation, metadata, dependencies)
  let plugin = await pluginState(context, mutation, metadata, dependencies)
  if (marketplace.status === 'conflict' || marketplace.status === 'unknown') throw new Error(marketplace.diagnostic)
  if (plugin.status === 'conflict' || plugin.status === 'unknown') throw new Error(plugin.diagnostic)

  if (marketplace.status === 'absent') {
    await runFrozenStep(context, mutation, metadata, dependencies, 'marketplace_add')
    marketplace = await marketplaceState(context, mutation, metadata, dependencies)
    if (marketplace.status !== 'exact') throw new Error(marketplace.diagnostic ?? 'claude_marketplace_add_readback_failed')
  }
  if (metadata.beforePluginVersion && plugin.status === 'before') {
    await runFrozenStep(context, mutation, metadata, dependencies, 'plugin_uninstall')
    plugin = await pluginState(context, mutation, metadata, dependencies)
    if (plugin.status !== 'absent') throw new Error(plugin.diagnostic ?? 'claude_plugin_uninstall_readback_failed')
  }
  if (plugin.status === 'absent') {
    await runFrozenStep(context, mutation, metadata, dependencies, 'plugin_install')
    plugin = await pluginState(context, mutation, metadata, dependencies)
  }
  if (plugin.status !== 'desired') throw new Error(plugin.diagnostic ?? 'claude_plugin_install_readback_failed')
}

async function applyDisconnect(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: AggregateMetadata,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<void> {
  let plugin = await pluginState(context, mutation, metadata, dependencies)
  let marketplace = await marketplaceState(context, mutation, metadata, dependencies)
  if (plugin.status === 'conflict' || plugin.status === 'unknown') throw new Error(plugin.diagnostic)
  if (marketplace.status === 'conflict' || marketplace.status === 'unknown') throw new Error(marketplace.diagnostic)
  if (plugin.status !== 'absent') {
    await runFrozenStep(context, mutation, metadata, dependencies, 'plugin_uninstall')
    plugin = await pluginState(context, mutation, metadata, dependencies)
    if (plugin.status !== 'absent') throw new Error(plugin.diagnostic ?? 'claude_plugin_uninstall_readback_failed')
  }
  if (marketplace.status !== 'absent') {
    await runFrozenStep(context, mutation, metadata, dependencies, 'marketplace_remove')
    marketplace = await marketplaceState(context, mutation, metadata, dependencies)
    if (marketplace.status !== 'absent') throw new Error(marketplace.diagnostic ?? 'claude_marketplace_remove_readback_failed')
  }
  quarantineBundle(context, metadata)
}

async function runFrozenStep(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: AggregateMetadata,
  dependencies: ClaudeCodePluginAdapterDependencies,
  stepId: string,
): Promise<void> {
  const index = metadata.commandStepIds.indexOf(stepId)
  const command = mutation.frozenCommands?.[index]
  if (index < 0 || !command) throw new Error(`claude_plugin_unplanned_step:${stepId}`)
  const result = await dependencies.run(command.executableRealpath, command.args, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: claudeCliEnvironment(context, command.executableRealpath),
  })
  if (result.exitCode !== 0) {
    throw new Error(`claude_plugin_command_failed:${stepId}:${result.exitCode}:${boundedDiagnostic(result.stderr || result.stdout)}`)
  }
}

async function readAggregate(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: AggregateMetadata,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<MutationReadBack> {
  try {
    assertFrozenMutation(context, mutation, metadata)
    const observation = await aggregateObservation(context, mutation, metadata, dependencies)
    const desiredHash = mutation.desiredFragmentHash!
    const matchesDesired = observation.desired && observation.fingerprint === desiredHash
    const safeToResumeFrom = mutation.safeResumeStates?.find(state => state.fingerprint === observation.fingerprint)
    return {
      operationId: mutation.operationId,
      observed: !observation.absent,
      matchesDesired,
      observedFragmentHash: observation.fingerprint,
      visibility: observation.absent ? 'absent' : observation.diagnostics.length === 0 ? 'dedicated' : 'unknown',
      safeToResumeFrom: matchesDesired ? undefined : safeToResumeFrom,
      diagnostics: observation.diagnostics,
    }
  } catch (error) {
    return {
      operationId: mutation.operationId,
      observed: true,
      matchesDesired: false,
      visibility: 'unknown',
      diagnostics: [errorMessage(error)],
    }
  }
}

async function aggregateObservation(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: AggregateMetadata,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<AggregateObservation> {
  const bundle = inspectBundle(metadata.marketplaceRoot, metadata.desiredFiles, context.runtime.applicationDataDir)
  const marketplace = await marketplaceState(context, mutation, metadata, dependencies)
  const plugin = await pluginState(context, mutation, metadata, dependencies)
  const diagnostics = [
    ...bundle.diagnostics,
    ...(marketplace.diagnostic ? [marketplace.diagnostic] : []),
    ...(plugin.diagnostic ? [plugin.diagnostic] : []),
  ]
  const fingerprint = aggregateFingerprint(bundle.fingerprint, marketplace.fingerprint, plugin.fingerprint)
  const absent = bundle.state === 'absent' && marketplace.status === 'absent' && plugin.status === 'absent'
  const desired = metadata.direction === 'remove'
    ? absent
    : bundle.fingerprint === bundleFingerprint(metadata.desiredFiles)
      && marketplace.status === 'exact'
      && plugin.status === 'desired'
  return { bundle, marketplace, plugin, fingerprint: absent ? absentAggregateHash(metadata) : fingerprint, desired, absent, diagnostics }
}

function applyBundle(context: AdapterOperationContext, metadata: AggregateMetadata): void {
  const current = inspectBundle(metadata.marketplaceRoot, metadata.desiredFiles, context.runtime.applicationDataDir)
  if (current.state === 'unsafe') throw new Error('claude_plugin_bundle_unsafe')
  for (const [relative, content] of Object.entries(metadata.desiredFiles).sort(([left], [right]) => left.localeCompare(right))) {
    const target = path.join(metadata.marketplaceRoot, relative)
    const observed = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
    const desiredHash = sha256Bytes(content)
    if (observed.containerHash === desiredHash) continue
    const beforeHash = metadata.beforeFileHashes[relative] ?? null
    if (observed.containerHash !== beforeHash) throw new Error('claude_plugin_bundle_file_cas_conflict')
    ensureSafeParentDirectoryWithinRoot(target, context.runtime.applicationDataDir)
    writeRegularFileAtomicCas(target, content, {
      expectedContainerHash: beforeHash,
      expectedCanonicalPath: inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir).canonicalPath,
      createMode: 0o600,
    })
  }
  const after = inspectBundle(metadata.marketplaceRoot, metadata.desiredFiles, context.runtime.applicationDataDir)
  if (after.fingerprint !== bundleFingerprint(metadata.desiredFiles)) throw new Error('claude_plugin_bundle_readback_mismatch')
}

function quarantineBundle(context: AdapterOperationContext, metadata: AggregateMetadata): void {
  assertContained(metadata.marketplaceRoot, context.runtime.applicationDataDir)
  assertContained(metadata.quarantineRoot, context.runtime.applicationDataDir)
  if (!fs.existsSync(metadata.marketplaceRoot)) return
  const current = inspectBundle(metadata.marketplaceRoot, metadata.desiredFiles, context.runtime.applicationDataDir)
  if (current.state !== 'safe' || current.fingerprint !== bundleStateFingerprint(metadata.beforeFileHashes)) {
    if (current.fingerprint !== bundleFingerprint(metadata.desiredFiles)) throw new Error('claude_plugin_bundle_remove_cas_conflict')
  }
  if (fs.existsSync(metadata.quarantineRoot)) throw new Error('claude_plugin_quarantine_target_occupied')
  fs.renameSync(metadata.marketplaceRoot, metadata.quarantineRoot)
}

async function marketplaceState(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: AggregateMetadata,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<MarketplaceState> {
  const command = firstExecutable(mutation)
  const result = await dependencies.run(command, ['plugin', 'marketplace', 'list', '--json'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: claudeCliEnvironment(context, command),
  })
  if (result.exitCode !== 0) return { status: 'unknown', fingerprint: null, diagnostic: 'claude_marketplace_list_failed' }
  const records = jsonRecords(result.stdout).filter(record => stringField(record, ['name', 'id']) === metadata.marketplaceId)
  if (records.length === 0) return { status: 'absent', fingerprint: null }
  if (records.length !== 1) return { status: 'conflict', fingerprint: null, diagnostic: 'claude_marketplace_identity_ambiguous' }
  const source = marketplaceSourcePath(records[0])
  if (!source || path.resolve(source) !== path.resolve(metadata.marketplaceRoot)) {
    return { status: 'conflict', fingerprint: sha256Json(records[0]), diagnostic: 'claude_marketplace_source_conflict' }
  }
  return { status: 'exact', fingerprint: marketplaceHash(metadata) }
}

async function pluginState(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: AggregateMetadata,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<PluginState> {
  const command = firstExecutable(mutation)
  const result = await dependencies.run(command, ['plugin', 'list', '--json'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: claudeCliEnvironment(context, command),
  })
  if (result.exitCode !== 0) return { status: 'unknown', fingerprint: null, diagnostic: 'claude_plugin_list_failed' }
  const matches = jsonRecords(result.stdout).filter(record => pluginIdentity(record) === metadata.qualifiedPlugin)
  if (matches.length === 0) return { status: 'absent', fingerprint: null }
  if (matches.length !== 1) return { status: 'conflict', fingerprint: null, diagnostic: 'claude_plugin_identity_ambiguous' }
  const record = matches[0]
  const version = stringField(record, ['version'])
  const enabled = booleanField(record, ['enabled', 'isEnabled'])
  const errors = Array.isArray(record.errors) ? record.errors : []
  const fingerprint = sha256Json({ qualifiedPlugin: metadata.qualifiedPlugin, version: version ?? null, enabled, errors })
  if (!version || enabled !== true || errors.length > 0) {
    return { status: 'conflict', fingerprint, version, diagnostic: 'claude_plugin_load_state_conflict' }
  }
  if (version === metadata.pluginVersion) return { status: 'desired', fingerprint: pluginHash(metadata, version), version }
  if (metadata.beforePluginVersion && version === metadata.beforePluginVersion) {
    return { status: 'before', fingerprint: pluginHash(metadata, version), version }
  }
  return { status: 'conflict', fingerprint, version, diagnostic: 'claude_plugin_version_conflict' }
}

async function verifyClaudePlugin(
  context: AdapterOperationContext,
  request: AdapterVerificationRequest,
  bundle: DesiredBundle,
  dependencies: ClaudeCodePluginAdapterDependencies,
): Promise<readonly ComponentVerificationResult[]> {
  const requested = COMPONENTS.filter(component => request.componentKeys.includes(component))
  const executable = context.installation.distribution.executableRealpath
  if (!executable || !path.isAbsolute(executable)) return requested.map(key => failedVerification(key, 'claude_executable_realpath_unproven'))
  const mutation = aggregateMutation(context, bundle, inspectBundle(bundle.marketplaceRoot, bundle.files, context.runtime.applicationDataDir), undefined, null, 'install')
  const metadata = parseMetadata(mutation)
  const source = inspectBundle(bundle.marketplaceRoot, bundle.files, context.runtime.applicationDataDir)
  const marketplace = await marketplaceState(context, mutation, metadata, dependencies)
  const plugin = await pluginState(context, mutation, metadata, dependencies)
  if (request.expectedCapability === 0 && marketplace.status === 'absent' && plugin.status === 'absent') {
    return requested.map(componentKey => ({ componentKey, status: 'verified', verifiedCapability: 0, identityAssertion: context.agentId, invalidationKeys: ['host_version', 'adapter_version'], diagnostics: ['disconnect_host_readback_verified'] }))
  }
  if (source.fingerprint !== bundle.fingerprint || marketplace.status !== 'exact' || plugin.status !== 'desired') {
    return requested.map(key => failedVerification(key, 'claude_plugin_static_projection_not_exact'))
  }

  const lifecycle = requested.includes('instruction') || requested.includes('lifecycle')
    ? await verifyHostActivity(context, request, {
        componentKey: 'lifecycle',
        signalNames: CLAUDE_CODE_REQUIRED_LIFECYCLE_SIGNALS,
        require: 'all',
      })
    : undefined
  const results: ComponentVerificationResult[] = []
  if (requested.includes('instruction')) results.push(lifecycle?.status === 'verified'
    ? { ...lifecycle, componentKey: 'instruction', verifiedCapability: 1, diagnostics: ['plugin_loaded_session_recognized', ...lifecycle.diagnostics] }
    : unverifiedStatic('instruction', bundle.fingerprint, lifecycle?.diagnostics ?? []))
  if (requested.includes('memory_tools')) {
    const memory = await verifyMemoryReadWriteActivity(context, request)
    results.push(memory.status === 'verified' ? memory : unverifiedStatic('memory_tools', bundle.fingerprint, memory.diagnostics))
  }
  if (requested.includes('lifecycle')) results.push(lifecycle?.status === 'verified'
    ? lifecycle
    : unverifiedStatic('lifecycle', bundle.fingerprint, lifecycle?.diagnostics ?? []))
  return results
}

function desiredBundle(context: AdapterOperationContext): DesiredBundle {
  const pluginName = `tidemind-${context.agentId}`
  const marketplaceId = `${safeKebab(pluginName)}-local`
  const marketplaceRoot = path.join(context.runtime.applicationDataDir, 'agent-integration', 'claude-code-marketplaces', marketplaceId)
  const pluginRoot = path.join('plugins', pluginName)
  const skill = renderSkill(pluginName)
  const mcp = jsonDocument({ mcpServers: { tidemind: { command: context.runtime.shimPath, args: [context.runtime.mcpServerPath], env: { EB_AGENT_ID: context.agentId, EB_HOST_VARIANT: context.installation.hostVariant, ...(context.activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken } : {}) } } } })
  const hooks = jsonDocument({ hooks: lifecycleHooks(
    context,
    path.join(marketplaceRoot, pluginRoot, 'skills', 'tidemind', 'SKILL.md'),
    sha256Bytes(skill),
  ) })
  const version = pluginVersion({
    '@tideMindVersion': context.runtime.tideMindVersion,
    '@projectionVersion': context.runtime.projectionVersion,
    [`${pluginRoot}/hooks/hooks.json`]: hooks,
    [`${pluginRoot}/.mcp.json`]: mcp,
    [`${pluginRoot}/skills/tidemind/SKILL.md`]: skill,
  })
  const manifest = jsonDocument({ $schema: PLUGIN_MANIFEST_SCHEMA, name: pluginName, version, description: 'Tide Mind external memory integration', author: { name: 'TideMind' }, metadata: { tideMindAgentId: context.agentId, tideMindHostVariant: context.installation.hostVariant, tideMindVersion: context.runtime.tideMindVersion, tideMindProjectionVersion: context.runtime.projectionVersion } })
  const marketplace = jsonDocument({ $schema: MARKETPLACE_SCHEMA, name: marketplaceId, description: `Tide Mind local marketplace for ${context.agentId}`, owner: { name: 'TideMind', email: 'local@tidemind' }, plugins: [{ name: pluginName, description: 'Tide Mind external memory integration', source: `./${pluginRoot}` }] })
  const files = Object.freeze({ '.claude-plugin/marketplace.json': marketplace, [`${pluginRoot}/.claude-plugin/plugin.json`]: manifest, [`${pluginRoot}/.mcp.json`]: mcp, [`${pluginRoot}/hooks/hooks.json`]: hooks, [`${pluginRoot}/skills/tidemind/SKILL.md`]: skill })
  return { marketplaceId, marketplaceRoot, pluginName, qualifiedPlugin: `${pluginName}@${marketplaceId}`, pluginVersion: version, files, fingerprint: bundleFingerprint(files) }
}

function inspectBundle(root: string, files: Readonly<Record<string, string>>, allowedRoot: string): BundleInspection {
  assertContained(root, allowedRoot)
  const nullHashes = Object.fromEntries(Object.keys(files).map(relative => [relative, null]))
  if (!fs.existsSync(root)) return { state: 'absent', fingerprint: null, fileHashes: nullHashes, diagnostics: [] }
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('claude_bundle_root_not_safe_directory')
  const entries = listBundleEntries(root)
  const expected = Object.keys(files).sort()
  const expectedDirectories = new Set(expected.flatMap(relative => parentDirectories(relative)))
  const diagnostics: string[] = []
  if (entries.files.some(file => !Object.hasOwn(files, file))) diagnostics.push('claude_plugin_bundle_contains_unexpected_file')
  if (entries.directories.some(directory => !expectedDirectories.has(directory))) diagnostics.push('claude_plugin_bundle_contains_unexpected_directory')
  const hashes: Record<string, string | null> = {}
  for (const relative of expected) {
    const inspected = inspectRegularFileWithinRoot(path.join(root, relative), allowedRoot)
    if (inspected.size !== null && inspected.size > MAX_BUNDLE_FILE_BYTES) diagnostics.push('claude_plugin_bundle_file_too_large')
    hashes[relative] = inspected.containerHash
  }
  return { state: diagnostics.length === 0 ? 'safe' : 'unsafe', fingerprint: bundleStateFingerprint(hashes), fileHashes: hashes, diagnostics }
}

function listBundleEntries(root: string): { files: string[]; directories: string[] } {
  const files: string[] = []
  const directories: string[] = []
  const queue = ['']
  let count = 0
  while (queue.length) {
    const relativeRoot = queue.shift()!
    for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
      if (++count > MAX_BUNDLE_ENTRIES) throw new Error('claude_plugin_bundle_too_many_entries')
      const relative = path.join(relativeRoot, entry.name)
      if (entry.isSymbolicLink()) throw new Error('claude_plugin_bundle_symlink_rejected')
      if (entry.isDirectory()) { directories.push(relative); queue.push(relative) }
      else if (entry.isFile()) files.push(relative)
      else throw new Error('claude_plugin_bundle_non_regular_entry')
    }
  }
  return { files: files.sort(), directories: directories.sort() }
}

function bundleVersion(source: BundleInspection, bundle: DesiredBundle, agentId: string): string | null {
  if (source.state !== 'safe') return null
  try {
    const manifestPath = path.join(bundle.marketplaceRoot, 'plugins', bundle.pluginName, '.claude-plugin', 'plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const metadata = manifest.metadata as Record<string, unknown> | undefined
    return manifest.name === bundle.pluginName && metadata?.tideMindAgentId === agentId && typeof manifest.version === 'string'
      ? manifest.version
      : null
  } catch { return null }
}

function aggregateBaseline(artifacts: readonly OwnedArtifactBaseline[], bundle: DesiredBundle):
  | { kind: 'none' }
  | { kind: 'owned'; value: OwnedArtifactBaseline }
  | { kind: 'conflict'; reason: string } {
  const matches = artifacts.filter(artifact => artifact.ownershipKey === bundle.qualifiedPlugin)
  if (matches.length === 0) return { kind: 'none' }
  const byComponent = new Map(matches.map(artifact => [artifact.componentKey, artifact]))
  if (!COMPONENTS.every(component => byComponent.has(component))) return { kind: 'conflict', reason: 'claude_plugin_partial_aggregate_ownership' }
  const first = byComponent.get('instruction')!
  if (!COMPONENTS.every(component => {
    const item = byComponent.get(component)!
    return item.physicalTarget === first.physicalTarget && item.ownedFragmentHash === first.ownedFragmentHash && (item.selectorSchemaVersion ?? 1) === (first.selectorSchemaVersion ?? 1)
  })) return { kind: 'conflict', reason: 'claude_plugin_inconsistent_aggregate_ownership' }
  return { kind: 'owned', value: first }
}

function parseMetadata(mutation: PlannedMutation): AggregateMetadata {
  const value = mutation.metadata as Partial<AggregateMetadata> | undefined
  if (!value || value.kind !== 'claude_plugin_aggregate' || (value.direction !== 'install' && value.direction !== 'remove')
    || typeof value.marketplaceId !== 'string' || typeof value.marketplaceRoot !== 'string' || typeof value.quarantineRoot !== 'string'
    || typeof value.pluginName !== 'string' || typeof value.qualifiedPlugin !== 'string' || typeof value.pluginVersion !== 'string'
    || !(value.beforePluginVersion === null || typeof value.beforePluginVersion === 'string')
    || !isStringRecord(value.desiredFiles) || !isNullableStringRecord(value.beforeFileHashes)
    || !Array.isArray(value.commandStepIds) || !value.commandStepIds.every(step => typeof step === 'string')) {
    throw new Error('claude_plugin_aggregate_metadata_invalid')
  }
  return value as AggregateMetadata
}

function assertFrozenMutation(context: AdapterOperationContext, mutation: PlannedMutation, metadata: AggregateMetadata): void {
  const executable = context.installation.distribution.executableRealpath
  if (!executable || !path.isAbsolute(executable) || mutation.operation !== 'host_command' || mutation.domainKind !== 'plugin_manager') throw new Error('claude_plugin_aggregate_contract_invalid')
  if (mutation.executableRealpath !== undefined || mutation.args !== undefined || mutation.componentKey !== 'instruction'
    || sha256Json(mutation.coveredComponentKeys) !== sha256Json(COMPONENTS)) throw new Error('claude_plugin_aggregate_contract_invalid')
  const expected = commandSequence(executable, {
    marketplaceId: metadata.marketplaceId,
    marketplaceRoot: metadata.marketplaceRoot,
    pluginName: metadata.pluginName,
    qualifiedPlugin: metadata.qualifiedPlugin,
    pluginVersion: metadata.pluginVersion,
    files: metadata.desiredFiles,
    fingerprint: bundleFingerprint(metadata.desiredFiles),
  }, metadata.direction, metadata.beforePluginVersion !== null)
  if (sha256Json(mutation.frozenCommands) !== sha256Json(expected.map(({ stepId: _stepId, ...command }) => command))
    || sha256Json(metadata.commandStepIds) !== sha256Json(expected.map(command => command.stepId))) throw new Error('claude_plugin_frozen_commands_changed')
}

function manageableDistribution(catalogId: ClaudeCodePluginCatalogId, context: AdapterOperationContext): { ok: true } | { ok: false; reason: string } {
  const executable = context.installation.distribution.executableRealpath
  if (!executable || !path.isAbsolute(executable)) return { ok: false, reason: 'claude_executable_realpath_unproven' }
  const expectedProvenance = catalogId === 'claude-code-native'
    ? OFFICIAL_NATIVE_PROVENANCE
    : OFFICIAL_NPM_PROVENANCE
  return context.installation.distribution.packageProvenance === expectedProvenance
    ? { ok: true }
    : { ok: false, reason: catalogId === 'claude-code-native'
        ? 'claude_native_distribution_identity_unproven'
        : 'claude_npm_distribution_identity_unproven' }
}

function productionDependencies(): ClaudeCodePluginAdapterDependencies {
  return { async run(executableRealpath, args, options) {
    try {
      const result = await execFileAsync(executableRealpath, [...args], { timeout: options.timeoutMs, env: { ...options.env }, maxBuffer: 1024 * 1024, windowsHide: true })
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }
      return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message }
    }
  } }
}

function renderSkill(pluginName: string): string {
  return `---\nname: tidemind\ndescription: Tide Mind 外部记忆系统。准备上下文、检索历史并沉淀长期有价值的信息。\nwhen_to_use: |\n  用户提起过去的决定、观点或偏好时；需要跨会话背景时；\n  用户明确要求记住信息时；完成产生重要事实、决策或后续行动的请求时。\nallowed-tools:\n  - mcp__tidemind__brain_prepare\n  - mcp__tidemind__brain_recall\n  - mcp__tidemind__brain_digest\n  - mcp__${pluginName}__brain_prepare\n  - mcp__${pluginName}__brain_recall\n  - mcp__${pluginName}__brain_digest\n  - mcp__plugin_${pluginName}_tidemind__brain_prepare\n  - mcp__plugin_${pluginName}_tidemind__brain_recall\n  - mcp__plugin_${pluginName}_tidemind__brain_digest\n---\n\n# Tide Mind\n\n- 新会话开始时优先调用 \`brain_prepare\` 获取用户上下文。\n- 回答依赖历史背景、既往决策或用户偏好时调用 \`brain_recall\`。\n- 对话产生重要决策、事实、偏好、纠正或后续行动时调用 \`brain_digest\`。\n- 工具不可用时明确说明，不能假装已经查询或保存。\n`
}

function lifecycleHooks(
  context: AdapterOperationContext,
  skillPath: string,
  expectedSkillSha256: string,
): Readonly<Record<string, JsonValue>> {
  const command = (script: string, extra: readonly string[] = []) => [
    context.runtime.shimPath, script, '--agent-id', context.agentId, '--tool', 'claude-code',
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
    ...extra,
  ].map(shellArgument).join(' ')
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: command(context.runtime.hookScriptPath, [
      '--skill-path', skillPath,
      '--expected-skill-sha256', expectedSkillSha256,
    ]), timeout: 15_000, statusMessage: '加载 Tide Mind 上下文...' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: command(context.runtime.preCompactScriptPath), timeout: 10_000, statusMessage: '检查未保存的记忆...' }] }],
    PostCompact: [{ hooks: [{ type: 'command', command: command(context.runtime.postCompactScriptPath), timeout: 10_000, statusMessage: '恢复 Tide Mind 上下文...' }] }],
  }
}

function failedVerification(componentKey: ComponentKey, diagnostic: string): ComponentVerificationResult {
  return { componentKey, status: 'failed', verifiedCapability: null, invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'], diagnostics: [diagnostic] }
}

function unverifiedStatic(componentKey: ComponentKey, evidenceHash: string, diagnostics: readonly string[]): ComponentVerificationResult {
  return { componentKey, status: 'unverified', verifiedCapability: null, evidenceHash, invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version', 'tide_mind_version', 'activity_freshness'], diagnostics: ['static_readback_passed', ...diagnostics] }
}

function bundleFingerprint(files: Readonly<Record<string, string>>): string {
  return bundleStateFingerprint(Object.fromEntries(Object.entries(files).map(([relative, content]) => [relative, sha256Bytes(content)])))
}
function bundleStateFingerprint(hashes: Readonly<Record<string, string | null>>): string { return sha256Json(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)).map(([relativePath, hash]) => ({ relativePath, hash }))) }
function marketplaceHash(bundle: Pick<DesiredBundle, 'marketplaceId' | 'marketplaceRoot'>): string { return sha256Json({ marketplaceId: bundle.marketplaceId, sourcePath: path.resolve(bundle.marketplaceRoot) }) }
function pluginHash(bundle: Pick<DesiredBundle, 'qualifiedPlugin'>, version: string): string { return sha256Json({ qualifiedPlugin: bundle.qualifiedPlugin, version, enabled: true, errors: [] }) }
function aggregateFingerprint(bundle: string | null, marketplace: string | null, plugin: string | null): string { return sha256Json({ bundle, marketplace, plugin }) }
function absentAggregateHash(bundle: Pick<DesiredBundle, 'qualifiedPlugin'>): string { return sha256Json({ qualifiedPlugin: bundle.qualifiedPlugin, absent: true }) }
function pluginVersion(files: Readonly<Record<string, string>>): string { return `1.0.${Number.parseInt(sha256Bytes(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => `${name}\n${content}`).join('\n--\n')).slice(0, 6), 16)}` }
function jsonDocument(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function firstExecutable(mutation: PlannedMutation): string { const value = mutation.frozenCommands?.[0]?.executableRealpath; if (!value) throw new Error('claude_plugin_frozen_executable_missing'); return value }
function executableExists(context: AdapterOperationContext): boolean { const value = context.installation.distribution.executableRealpath; return Boolean(value && path.isAbsolute(value) && fs.existsSync(value)) }
function parentDirectories(relative: string): string[] { const values: string[] = []; let current = path.dirname(relative); while (current !== '.') { values.push(current); current = path.dirname(current) } return values }
function pluginIdentity(record: Record<string, unknown>): string | undefined { const value = stringField(record, ['id', 'plugin']); return value?.includes('@') ? value : undefined }
function marketplaceSourcePath(record: Record<string, unknown>): string | undefined { const direct = stringField(record, ['path', 'installLocation']); if (direct) return direct; const source = record.source; return source && typeof source === 'object' && !Array.isArray(source) ? stringField(source as Record<string, unknown>, ['path']) : undefined }
function stringField(record: Record<string, unknown>, names: readonly string[]): string | undefined { for (const name of names) if (typeof record[name] === 'string') return record[name] as string; return undefined }
function booleanField(record: Record<string, unknown>, names: readonly string[]): boolean | undefined { for (const name of names) if (typeof record[name] === 'boolean') return record[name] as boolean; return undefined }
function jsonRecords(source: string): readonly Record<string, unknown>[] { const root = JSON.parse(source) as unknown; if (!Array.isArray(root)) throw new Error('claude_plugin_cli_json_invalid'); return root.filter(value => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown>[] }
function isStringRecord(value: unknown): value is Readonly<Record<string, string>> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')) }
function isNullableStringRecord(value: unknown): value is Readonly<Record<string, string | null>> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item === null || typeof item === 'string')) }
function assertContained(target: string, root: string): void { const relative = path.relative(path.resolve(root), path.resolve(target)); if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('claude_plugin_target_outside_application_data') }
function safeKebab(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') }
function boundedDiagnostic(value: string): string { return value.replace(/\s+/gu, ' ').trim().slice(0, 240) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function claudeCliEnvironment(context: AdapterOperationContext, executable: string): Readonly<Record<string, string>> {
  const directories = new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(context.runtime.homeDir, '.local', 'bin')])
  const nvm = executable.match(/^(.*\/\.nvm\/versions\/node\/[^/]+)\/lib\/node_modules\//u)?.[1]
  if (nvm) directories.add(path.join(nvm, 'bin'))
  const env: Record<string, string> = {
    HOME: context.runtime.homeDir,
    CLAUDE_CONFIG_DIR: context.installation.canonicalConfigRoot,
    PATH: [...directories].join(path.delimiter),
  }
  for (const key of ['LANG', 'LC_ALL', 'TERM', 'TMPDIR'] as const) if (process.env[key] !== undefined) env[key] = process.env[key]!
  return env
}
