import {
  CATALOG_IDS,
  COMPONENT_KEYS,
  type AgentCatalog,
  type AgentHostVariant,
  type AgentProduct,
  type ArtifactComponentType,
  type CapabilityLevel,
  type CatalogAlias,
  type CatalogId,
  type ComponentDeclaration,
  type ComponentKey,
  type DeliveryMode,
  type DeliveryPriority,
  type HostKind,
  type MutationDomainKind,
  type MutationRisk,
  type ProductFamilyId,
  type ReleaseChannel,
  type ReloadRequirement,
} from './types'

export const CATALOG_SCHEMA_VERSION = 2
export const CATALOG_VERSION = '1.1.0'

const PRIORITY_GROUPS = {
  'P0.1': [
    'claude-code-cli',
    'claude-code-native',
    'claude-desktop-legacy',
    'codex-cli',
    'codex-desktop',
    'cursor-desktop',
    'windsurf-desktop',
    'gemini-cli',
    'kimi-code-cli',
    'kimi-code-native',
    'openclaw-local',
  ],
  'P0.2': [
    'qwen-code-cli',
    'zcode-desktop',
    'zcode-cli',
    'opencode-v1-cli',
    'opencode-v2-beta-cli',
    'pi-official-cli',
    'omp-cli',
    'qwenwork-desktop',
    'claude-cowork-local',
  ],
  P1: [
    'openhands-cli',
    'openhands-gui',
    'openhands-acp',
    'raycast-ai-desktop',
    'jan-desktop',
    'jan-cli',
    'qoder-cli',
    'codebuddy-cli',
    'codearts-agent-cli',
    'astrbot-local',
    'langbot-local',
    'goose-cli',
    'goose-desktop',
    'github-copilot-cli',
    'github-copilot-vscode',
    'cline-cli',
    'kiro-cli',
    'kiro-ide',
    'junie-cli',
    'amp-cli',
  ],
  P2: [
    'anythingllm-desktop',
    'anythingllm-local-server',
    'letta-local-server',
    'agent-zero-local',
    'open-webui-local',
    'librechat-local',
    'cherry-studio-desktop',
    'chatbox-desktop',
    'lobehub-desktop',
    'lobehub-local',
    'pi-agent-desktop',
    'dify-local',
    'fastgpt-local',
    'ragflow-local',
    'maxkb-local',
    'github-copilot-jetbrains',
    'cline-ide',
    'junie-ide',
    'roo-code-vscode',
    'continue-ide',
    'zed-agent',
    'amazon-q-cli',
    'amazon-q-ide',
    'qoder-ide',
    'qoder-jetbrains',
    'codebuddy-ide',
    'codebuddy-vscode',
    'codebuddy-jetbrains',
    'codearts-agent-ide',
    'codearts-agent-vscode',
    'codearts-agent-jetbrains',
  ],
  P3: [
    'pi-agent-rust-cli',
    'trae-ide',
    'baidu-comate-ide',
    'warp-desktop',
    'oz-runtime',
    'aider-cli',
    'codegeex-ide',
  ],
  observe: ['nami-desktop', 'catpaw-desktop'],
} as const satisfies Record<DeliveryPriority, readonly CatalogId[]>

function makePriorityMap(): Readonly<Record<CatalogId, DeliveryPriority>> {
  const entries = Object.entries(PRIORITY_GROUPS).flatMap(([priority, ids]) =>
    ids.map(id => [id, priority] as const),
  )
  return Object.freeze(Object.fromEntries(entries) as Record<CatalogId, DeliveryPriority>)
}

/** The only maintained catalog_id -> delivery_priority mapping. */
export const DELIVERY_PRIORITY_BY_CATALOG_ID = makePriorityMap()

interface ProductSeed {
  id: ProductFamilyId
  displayName: string
  variantIds: readonly CatalogId[]
}

const PRODUCT_SEEDS = [
  { id: 'claude-code', displayName: 'Claude Code', variantIds: ['claude-code-cli', 'claude-code-native'] },
  { id: 'claude-cowork', displayName: 'Claude Cowork', variantIds: ['claude-cowork-local'] },
  { id: 'claude-desktop-legacy', displayName: 'Claude Desktop（遗留）', variantIds: ['claude-desktop-legacy'] },
  { id: 'codex', displayName: 'Codex', variantIds: ['codex-cli', 'codex-desktop'] },
  { id: 'cursor', displayName: 'Cursor', variantIds: ['cursor-desktop'] },
  { id: 'windsurf', displayName: 'Windsurf', variantIds: ['windsurf-desktop'] },
  { id: 'gemini', displayName: 'Gemini CLI', variantIds: ['gemini-cli'] },
  { id: 'openclaw', displayName: 'OpenClaw', variantIds: ['openclaw-local'] },
  { id: 'pi-official', displayName: 'Pi', variantIds: ['pi-official-cli'] },
  { id: 'omp', displayName: 'Oh My Pi', variantIds: ['omp-cli'] },
  { id: 'openhands', displayName: 'OpenHands', variantIds: ['openhands-cli', 'openhands-gui', 'openhands-acp'] },
  { id: 'raycast-ai', displayName: 'Raycast AI', variantIds: ['raycast-ai-desktop'] },
  { id: 'jan', displayName: 'Jan', variantIds: ['jan-desktop', 'jan-cli'] },
  { id: 'anythingllm', displayName: 'AnythingLLM', variantIds: ['anythingllm-desktop', 'anythingllm-local-server'] },
  { id: 'librechat', displayName: 'LibreChat', variantIds: ['librechat-local'] },
  { id: 'goose', displayName: 'Goose', variantIds: ['goose-cli', 'goose-desktop'] },
  { id: 'letta', displayName: 'Letta', variantIds: ['letta-local-server'] },
  { id: 'agent-zero', displayName: 'Agent Zero', variantIds: ['agent-zero-local'] },
  { id: 'open-webui', displayName: 'Open WebUI', variantIds: ['open-webui-local'] },
  { id: 'pi-agent-desktop', displayName: 'Pi Agent Desktop', variantIds: ['pi-agent-desktop'] },
  { id: 'pi-agent-rust', displayName: 'pi_agent_rust', variantIds: ['pi-agent-rust-cli'] },
  { id: 'github-copilot', displayName: 'GitHub Copilot', variantIds: ['github-copilot-cli', 'github-copilot-vscode', 'github-copilot-jetbrains'] },
  { id: 'cline', displayName: 'Cline', variantIds: ['cline-cli', 'cline-ide'] },
  { id: 'opencode', displayName: 'OpenCode', variantIds: ['opencode-v1-cli', 'opencode-v2-beta-cli'] },
  { id: 'kiro', displayName: 'Kiro', variantIds: ['kiro-cli', 'kiro-ide'] },
  { id: 'junie', displayName: 'Junie', variantIds: ['junie-cli', 'junie-ide'] },
  { id: 'amp', displayName: 'Amp', variantIds: ['amp-cli'] },
  { id: 'roo-code', displayName: 'Roo Code', variantIds: ['roo-code-vscode'] },
  { id: 'continue', displayName: 'Continue', variantIds: ['continue-ide'] },
  { id: 'zed-agent', displayName: 'Zed Agent', variantIds: ['zed-agent'] },
  { id: 'amazon-q', displayName: 'Amazon Q Developer', variantIds: ['amazon-q-cli', 'amazon-q-ide'] },
  { id: 'warp', displayName: 'Warp / Oz', variantIds: ['warp-desktop', 'oz-runtime'] },
  { id: 'aider', displayName: 'Aider', variantIds: ['aider-cli'] },
  { id: 'qwenwork', displayName: 'QwenWork', variantIds: ['qwenwork-desktop'] },
  { id: 'astrbot', displayName: 'AstrBot', variantIds: ['astrbot-local'] },
  { id: 'langbot', displayName: 'LangBot', variantIds: ['langbot-local'] },
  { id: 'lobehub', displayName: 'LobeHub', variantIds: ['lobehub-desktop', 'lobehub-local'] },
  { id: 'kimi-code', displayName: 'Kimi Code', variantIds: ['kimi-code-cli', 'kimi-code-native'] },
  { id: 'zcode', displayName: 'ZCode', variantIds: ['zcode-desktop', 'zcode-cli'] },
  { id: 'qwen-code', displayName: 'Qwen Code', variantIds: ['qwen-code-cli'] },
  { id: 'qoder', displayName: 'Qoder', variantIds: ['qoder-cli', 'qoder-ide', 'qoder-jetbrains'] },
  { id: 'trae', displayName: 'TRAE', variantIds: ['trae-ide'] },
  { id: 'codebuddy', displayName: 'CodeBuddy', variantIds: ['codebuddy-cli', 'codebuddy-ide', 'codebuddy-vscode', 'codebuddy-jetbrains'] },
  { id: 'baidu-comate', displayName: 'Baidu Comate', variantIds: ['baidu-comate-ide'] },
  { id: 'codearts-agent', displayName: 'CodeArts Agent', variantIds: ['codearts-agent-cli', 'codearts-agent-ide', 'codearts-agent-vscode', 'codearts-agent-jetbrains'] },
  { id: 'dify', displayName: 'Dify', variantIds: ['dify-local'] },
  { id: 'fastgpt', displayName: 'FastGPT', variantIds: ['fastgpt-local'] },
  { id: 'ragflow', displayName: 'RAGFlow', variantIds: ['ragflow-local'] },
  { id: 'cherry-studio', displayName: 'Cherry Studio', variantIds: ['cherry-studio-desktop'] },
  { id: 'chatbox', displayName: 'Chatbox', variantIds: ['chatbox-desktop'] },
  { id: 'maxkb', displayName: 'MaxKB', variantIds: ['maxkb-local'] },
  { id: 'nami', displayName: '360 纳米 AI', variantIds: ['nami-desktop'] },
  { id: 'catpaw', displayName: 'CatPaw', variantIds: ['catpaw-desktop'] },
  { id: 'codegeex', displayName: 'CodeGeeX', variantIds: ['codegeex-ide'] },
] as const satisfies readonly ProductSeed[]

function supportedComponent(
  componentKey: ComponentKey,
  deliveryMode: DeliveryMode,
  artifactTypes: readonly ArtifactComponentType[],
  mutationDomain: MutationDomainKind,
  reload: ReloadRequirement,
  risk: MutationRisk = 'low',
): ComponentDeclaration {
  const actions = deliveryMode === 'managed'
    ? ['inspect', 'connect', 'repair', 'disconnect', 'verify'] as const
    : deliveryMode === 'guided'
      ? ['inspect', 'connect', 'disconnect', 'verify'] as const
      : ['inspect', 'verify'] as const
  return {
    componentKey,
    applicability: 'supported',
    deliveryMode,
    artifactTypes,
    mutationDomain,
    risk,
    reload,
    actions,
  }
}

function notApplicable(componentKey: ComponentKey, reason: string): ComponentDeclaration {
  return {
    componentKey,
    applicability: 'not_applicable',
    reason,
    deliveryMode: 'cataloged',
    artifactTypes: [],
    mutationDomain: 'none',
    risk: 'read_only',
    reload: 'none',
    actions: ['inspect'],
  }
}

type ComponentModes = readonly [DeliveryMode, DeliveryMode, DeliveryMode | 'not_applicable']

function p0Components(
  modes: ComponentModes,
  options: {
    instructionArtifacts?: readonly ArtifactComponentType[]
    memoryArtifacts?: readonly ArtifactComponentType[]
    lifecycleArtifacts?: readonly ArtifactComponentType[]
    instructionDomain?: MutationDomainKind
    memoryDomain?: MutationDomainKind
    lifecycleDomain?: MutationDomainKind
    memoryReload?: ReloadRequirement
    lifecycleReload?: ReloadRequirement
    lifecycleNotApplicableReason?: string
    risk?: MutationRisk
  } = {},
): readonly ComponentDeclaration[] {
  const [instruction, memoryTools, lifecycle] = modes
  return [
    supportedComponent(
      'instruction',
      instruction,
      options.instructionArtifacts ?? ['skill'],
      options.instructionDomain ?? 'directory',
      'new_session',
      options.risk,
    ),
    supportedComponent(
      'memory_tools',
      memoryTools,
      options.memoryArtifacts ?? ['mcp'],
      options.memoryDomain ?? 'file_fragment',
      options.memoryReload ?? 'reload',
      options.risk,
    ),
    lifecycle === 'not_applicable'
      ? notApplicable(
          'lifecycle',
          options.lifecycleNotApplicableReason
            ?? 'This legacy surface has no verified lifecycle integration contract.',
        )
      : supportedComponent(
        'lifecycle',
        lifecycle,
        options.lifecycleArtifacts ?? ['hook'],
        options.lifecycleDomain ?? 'file_fragment',
        options.lifecycleReload ?? 'new_session',
        options.risk,
      ),
  ]
}

const P0_COMPONENTS: Readonly<Partial<Record<CatalogId, readonly ComponentDeclaration[]>>> = {
  'claude-code-cli': p0Components(['managed', 'managed', 'managed'], {
    instructionArtifacts: ['plugin', 'skill'], memoryArtifacts: ['plugin', 'mcp'], lifecycleArtifacts: ['plugin', 'hook'],
    instructionDomain: 'plugin_manager', memoryDomain: 'plugin_manager', lifecycleDomain: 'plugin_manager',
  }),
  'claude-code-native': p0Components(['detectable', 'detectable', 'detectable']),
  'claude-desktop-legacy': p0Components(['cataloged', 'managed', 'not_applicable'], {
    memoryArtifacts: ['mcp'], memoryReload: 'restart_host',
  }),
  'codex-cli': p0Components(['managed', 'managed', 'managed']),
  'codex-desktop': p0Components(['managed', 'managed', 'managed']),
  'cursor-desktop': p0Components(['managed', 'managed', 'managed'], { lifecycleReload: 'new_session' }),
  'windsurf-desktop': p0Components(['managed', 'managed', 'not_applicable'], {
    memoryReload: 'version_dependent',
    lifecycleNotApplicableReason: 'Windsurf exposes prompt, response, and tool hooks but no verified session or compaction lifecycle contract.',
  }),
  'gemini-cli': p0Components(['managed', 'managed', 'managed'], {
    instructionArtifacts: ['plugin', 'skill'], memoryArtifacts: ['plugin', 'mcp'], lifecycleArtifacts: ['plugin', 'hook'],
    instructionDomain: 'plugin_manager', memoryDomain: 'plugin_manager', lifecycleDomain: 'plugin_manager',
  }),
  'kimi-code-cli': p0Components(['managed', 'managed', 'managed'], { memoryReload: 'new_session' }),
  'kimi-code-native': p0Components(['detectable', 'detectable', 'detectable'], { memoryReload: 'new_session' }),
  'openclaw-local': p0Components(['managed', 'managed', 'managed'], {
    instructionArtifacts: ['plugin', 'skill'], memoryArtifacts: ['plugin', 'mcp'], lifecycleArtifacts: ['plugin', 'hook'],
  }),
  'qwen-code-cli': p0Components(['managed', 'managed', 'managed'], {
    instructionArtifacts: ['plugin', 'skill'], memoryArtifacts: ['plugin', 'mcp'], lifecycleArtifacts: ['hook'],
    instructionDomain: 'plugin_manager', memoryDomain: 'plugin_manager',
  }),
  'zcode-desktop': p0Components(['managed', 'managed', 'managed'], { lifecycleReload: 'new_session' }),
  // The historical same-named CLI is not an official ZCode distribution.
  // It remains visible to discovery, but has no writable Adapter surface.
  'zcode-cli': p0Components(['detectable', 'detectable', 'detectable'], { lifecycleReload: 'new_session' }),
  'opencode-v1-cli': p0Components(['managed', 'managed', 'managed'], {
    instructionArtifacts: ['plugin', 'skill'], memoryArtifacts: ['plugin', 'mcp'], lifecycleArtifacts: ['plugin'],
  }),
  'opencode-v2-beta-cli': p0Components(['managed', 'managed', 'guided'], {
    instructionArtifacts: ['plugin', 'skill'], memoryArtifacts: ['mcp'], lifecycleArtifacts: ['plugin'],
    lifecycleDomain: 'plugin_manager', lifecycleReload: 'user_confirmation',
  }),
  'pi-official-cli': p0Components(['managed', 'managed', 'managed'], {
    instructionArtifacts: ['plugin', 'skill'], memoryArtifacts: ['plugin'], lifecycleArtifacts: ['plugin'],
    instructionDomain: 'plugin_manager', memoryDomain: 'plugin_manager', lifecycleDomain: 'plugin_manager',
  }),
  'omp-cli': p0Components(['managed', 'managed', 'managed']),
  'qwenwork-desktop': p0Components(['managed', 'guided', 'managed'], {
    memoryReload: 'user_confirmation', lifecycleReload: 'restart_host',
  }),
  'claude-cowork-local': p0Components(['guided', 'guided', 'guided'], {
    instructionArtifacts: ['plugin'], memoryArtifacts: ['plugin'], lifecycleArtifacts: ['plugin'],
    instructionDomain: 'plugin_manager', memoryDomain: 'plugin_manager', lifecycleDomain: 'plugin_manager',
    memoryReload: 'user_confirmation', lifecycleReload: 'user_confirmation', risk: 'elevated',
  }),
}

const CAPABILITY_CEILINGS: Readonly<Record<CapabilityLevel, readonly CatalogId[]>> = {
  0: ['nami-desktop', 'catpaw-desktop', 'codegeex-ide'],
  1: ['aider-cli', 'trae-ide'],
  2: ['claude-desktop-legacy', 'continue-ide', 'amazon-q-cli', 'amazon-q-ide', 'maxkb-local'],
  3: [
    'raycast-ai-desktop', 'goose-cli', 'goose-desktop', 'letta-local-server', 'agent-zero-local',
    'open-webui-local', 'github-copilot-jetbrains', 'cline-ide', 'junie-ide', 'roo-code-vscode',
    'zed-agent', 'warp-desktop', 'oz-runtime', 'lobehub-desktop', 'lobehub-local', 'cherry-studio-desktop',
    'chatbox-desktop', 'fastgpt-local', 'ragflow-local', 'baidu-comate-ide', 'qoder-ide', 'qoder-jetbrains',
    'windsurf-desktop',
    'codebuddy-ide', 'codebuddy-vscode', 'codebuddy-jetbrains',
  ],
  4: [
    'claude-code-cli', 'claude-code-native', 'claude-cowork-local', 'codex-cli', 'codex-desktop', 'cursor-desktop',
    'gemini-cli', 'openclaw-local', 'pi-official-cli', 'omp-cli',
    'openhands-cli', 'openhands-gui', 'openhands-acp', 'jan-desktop', 'jan-cli',
    'anythingllm-desktop', 'anythingllm-local-server', 'librechat-local', 'pi-agent-desktop',
    'pi-agent-rust-cli', 'github-copilot-cli', 'github-copilot-vscode', 'cline-cli',
    'opencode-v1-cli', 'opencode-v2-beta-cli', 'kiro-cli', 'kiro-ide', 'junie-cli', 'amp-cli',
    'qwenwork-desktop', 'astrbot-local', 'langbot-local', 'kimi-code-cli', 'kimi-code-native', 'zcode-desktop', 'zcode-cli', 'qwen-code-cli',
    'qoder-cli', 'codebuddy-cli', 'codearts-agent-cli', 'codearts-agent-ide', 'codearts-agent-vscode',
    'codearts-agent-jetbrains', 'dify-local',
  ],
}

function buildCapabilityMap(): Readonly<Record<CatalogId, CapabilityLevel>> {
  const entries = Object.entries(CAPABILITY_CEILINGS).flatMap(([level, ids]) =>
    ids.map(id => [id, Number(level) as CapabilityLevel] as const),
  )
  return Object.freeze(Object.fromEntries(entries) as Record<CatalogId, CapabilityLevel>)
}

const CAPABILITY_BY_CATALOG_ID = buildCapabilityMap()

const VARIANT_DISPLAY_NAMES: Readonly<Partial<Record<CatalogId, string>>> = {
  'claude-code-cli': 'npm CLI',
  'claude-code-native': '原生安装（仅检测）',
  'codex-cli': 'CLI',
  'codex-desktop': 'Desktop',
  'opencode-v1-cli': 'V1 CLI',
  'opencode-v2-beta-cli': 'V2 Beta CLI',
  'zcode-desktop': 'Desktop',
  'zcode-cli': 'Unofficial CLI（仅检测）',
  'kimi-code-cli': 'npm CLI',
  'kimi-code-native': '原生安装（仅检测）',
  'openhands-cli': 'CLI',
  'openhands-gui': 'GUI',
  'openhands-acp': 'ACP',
  'github-copilot-cli': 'CLI',
  'github-copilot-vscode': 'VS Code',
  'github-copilot-jetbrains': 'JetBrains',
}

function inferHostKind(catalogId: CatalogId): HostKind {
  if (catalogId === 'claude-code-native' || catalogId === 'kimi-code-native') return 'cli'
  if (catalogId.endsWith('-cli')) return 'cli'
  if (catalogId.endsWith('-vscode') || catalogId.endsWith('-jetbrains') || catalogId.endsWith('-ide')) {
    return 'ide_extension'
  }
  if (catalogId.endsWith('-runtime') || catalogId.endsWith('-acp')) return 'runtime'
  if (catalogId.endsWith('-local') || catalogId.endsWith('-server')) return 'local_server'
  return 'desktop'
}

function releaseChannel(catalogId: CatalogId): ReleaseChannel {
  if (catalogId === 'claude-desktop-legacy') return 'legacy'
  if (catalogId === 'opencode-v2-beta-cli') return 'beta'
  return 'stable'
}

function makeProducts(): readonly AgentProduct[] {
  return PRODUCT_SEEDS.map(seed => Object.freeze({
    ...seed,
    variantIds: Object.freeze([...seed.variantIds]),
  }))
}

function makeVariants(products: readonly AgentProduct[]): readonly AgentHostVariant[] {
  const productByVariant = new Map<CatalogId, AgentProduct>()
  for (const product of products) {
    for (const catalogId of product.variantIds) productByVariant.set(catalogId, product)
  }
  return CATALOG_IDS.map(catalogId => {
    const product = productByVariant.get(catalogId)
    if (!product) throw new Error(`Catalog variant ${catalogId} has no product family`)
    return Object.freeze({
      catalogId,
      productFamilyId: product.id,
      displayName: VARIANT_DISPLAY_NAMES[catalogId] ?? product.displayName,
      hostKind: inferHostKind(catalogId),
      releaseChannel: releaseChannel(catalogId),
      deliveryPriority: DELIVERY_PRIORITY_BY_CATALOG_ID[catalogId],
      maxCapability: CAPABILITY_BY_CATALOG_ID[catalogId],
      runtimeRealms: ['local_macos'] as const,
      components: Object.freeze([...(P0_COMPONENTS[catalogId] ?? [])]),
      requiresStrongDistributionIdentity: [
        'pi-official-cli', 'omp-cli', 'pi-agent-desktop', 'pi-agent-rust-cli', 'zcode-desktop',
      ].includes(catalogId),
    })
  })
}

export const CATALOG_ALIASES = [
  { alias: 'claude-code', targetIds: ['claude-code-cli', 'claude-code-native'], resolution: 'requires_discovery', reason: 'npm and native channels have different trust surfaces.' },
  { alias: 'cowork', targetIds: ['claude-desktop-legacy'], resolution: 'legacy_audit', reason: 'Legacy writer targets Claude Desktop, not real Cowork.' },
  { alias: 'cursor', targetIds: ['cursor-desktop'], resolution: 'direct', reason: 'Legacy tool_type migration.' },
  { alias: 'codex', targetIds: ['codex-cli', 'codex-desktop'], resolution: 'requires_discovery', reason: 'CLI and Desktop are separate verification surfaces.' },
  { alias: 'windsurf', targetIds: ['windsurf-desktop'], resolution: 'direct', reason: 'Legacy tool_type migration.' },
  { alias: 'openclaw', targetIds: ['openclaw-local'], resolution: 'direct', reason: 'Legacy tool_type migration.' },
  { alias: 'gemini', targetIds: ['gemini-cli'], resolution: 'direct', reason: 'Legacy tool_type migration.' },
  { alias: 'kimi-code', targetIds: ['kimi-code-cli', 'kimi-code-native'], resolution: 'requires_discovery', reason: 'npm and native channels have different trust surfaces.' },
] as const satisfies readonly CatalogAlias[]

const PRODUCTS = makeProducts()
const VARIANTS = makeVariants(PRODUCTS)

export const AGENT_CATALOG: AgentCatalog = Object.freeze({
  schemaVersion: CATALOG_SCHEMA_VERSION,
  catalogVersion: CATALOG_VERSION,
  products: Object.freeze(PRODUCTS),
  variants: Object.freeze(VARIANTS),
  aliases: Object.freeze([...CATALOG_ALIASES]),
})

export interface CatalogValidationIssue {
  code:
    | 'duplicate_catalog_id'
    | 'missing_catalog_id'
    | 'unknown_catalog_id'
    | 'duplicate_product_id'
    | 'missing_product'
    | 'product_variant_mismatch'
    | 'missing_priority'
    | 'priority_mismatch'
    | 'duplicate_alias'
    | 'unknown_alias_target'
    | 'alias_cycle'
    | 'invalid_alias_resolution'
    | 'incomplete_p0_components'
    | 'duplicate_component'
  message: string
}

function findAliasCycle(aliases: readonly CatalogAlias[]): string[] | null {
  const graph = new Map(aliases.map(alias => [alias.alias, alias.targetIds]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(node: string, path: string[]): string[] | null {
    if (visiting.has(node)) return [...path.slice(path.indexOf(node)), node]
    if (visited.has(node)) return null
    visiting.add(node)
    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) continue
      const cycle = visit(target, [...path, target])
      if (cycle) return cycle
    }
    visiting.delete(node)
    visited.add(node)
    return null
  }

  for (const alias of graph.keys()) {
    const cycle = visit(alias, [alias])
    if (cycle) return cycle
  }
  return null
}

export function validateAgentCatalog(catalog: AgentCatalog = AGENT_CATALOG): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = []
  const frozenIds = new Set<string>(CATALOG_IDS)
  const variantCounts = new Map<string, number>()
  const productCounts = new Map<string, number>()

  for (const product of catalog.products) productCounts.set(product.id, (productCounts.get(product.id) ?? 0) + 1)
  for (const [id, count] of productCounts) {
    if (count > 1) issues.push({ code: 'duplicate_product_id', message: `Product ${id} appears ${count} times.` })
  }

  for (const variant of catalog.variants) {
    variantCounts.set(variant.catalogId, (variantCounts.get(variant.catalogId) ?? 0) + 1)
    const product = catalog.products.find(candidate => candidate.id === variant.productFamilyId)
    if (!product) {
      issues.push({ code: 'missing_product', message: `${variant.catalogId} references missing product ${variant.productFamilyId}.` })
    } else if (!product.variantIds.includes(variant.catalogId)) {
      issues.push({ code: 'product_variant_mismatch', message: `${product.id} does not list ${variant.catalogId}.` })
    }
    if (!DELIVERY_PRIORITY_BY_CATALOG_ID[variant.catalogId]) {
      issues.push({ code: 'missing_priority', message: `${variant.catalogId} has no delivery priority.` })
    } else if (variant.deliveryPriority !== DELIVERY_PRIORITY_BY_CATALOG_ID[variant.catalogId]) {
      issues.push({
        code: 'priority_mismatch',
        message: `${variant.catalogId} declares ${variant.deliveryPriority}, expected ${DELIVERY_PRIORITY_BY_CATALOG_ID[variant.catalogId]}.`,
      })
    }

    const componentKeys = variant.components.map(component => component.componentKey)
    const duplicateComponents = componentKeys.filter((key, index) => componentKeys.indexOf(key) !== index)
    for (const key of new Set(duplicateComponents)) {
      issues.push({ code: 'duplicate_component', message: `${variant.catalogId} declares ${key} more than once.` })
    }
    if (variant.deliveryPriority === 'P0.1' || variant.deliveryPriority === 'P0.2') {
      const missing = COMPONENT_KEYS.filter(key => !componentKeys.includes(key))
      if (missing.length > 0) {
        issues.push({ code: 'incomplete_p0_components', message: `${variant.catalogId} misses ${missing.join(', ')}.` })
      }
    }
  }

  for (const id of frozenIds) {
    const count = variantCounts.get(id) ?? 0
    if (count === 0) issues.push({ code: 'missing_catalog_id', message: `Frozen catalog ID ${id} is missing.` })
    if (count > 1) issues.push({ code: 'duplicate_catalog_id', message: `Catalog ID ${id} appears ${count} times.` })
  }
  for (const id of variantCounts.keys()) {
    if (!frozenIds.has(id)) issues.push({ code: 'unknown_catalog_id', message: `Unknown catalog ID ${id}.` })
  }

  for (const product of catalog.products) {
    for (const catalogId of product.variantIds) {
      const variant = catalog.variants.find(candidate => candidate.catalogId === catalogId)
      if (!variant || variant.productFamilyId !== product.id) {
        issues.push({ code: 'product_variant_mismatch', message: `${product.id} lists mismatched variant ${catalogId}.` })
      }
    }
  }

  const aliases = new Set<string>()
  const knownAliasTargets = new Set<string>([...frozenIds, ...catalog.aliases.map(alias => alias.alias)])
  for (const alias of catalog.aliases) {
    if (aliases.has(alias.alias)) issues.push({ code: 'duplicate_alias', message: `Alias ${alias.alias} is duplicated.` })
    aliases.add(alias.alias)
    for (const target of alias.targetIds) {
      if (!knownAliasTargets.has(target)) {
        issues.push({ code: 'unknown_alias_target', message: `Alias ${alias.alias} targets unknown ${target}.` })
      }
    }
    if (alias.resolution === 'direct' && alias.targetIds.length !== 1) {
      issues.push({ code: 'invalid_alias_resolution', message: `Direct alias ${alias.alias} must have one target.` })
    }
    if (alias.resolution === 'requires_discovery' && alias.targetIds.length < 2) {
      issues.push({ code: 'invalid_alias_resolution', message: `Discovery alias ${alias.alias} must have multiple targets.` })
    }
  }
  const cycle = findAliasCycle(catalog.aliases)
  if (cycle) issues.push({ code: 'alias_cycle', message: `Alias cycle: ${cycle.join(' -> ')}` })

  return issues
}

export function assertValidAgentCatalog(catalog: AgentCatalog = AGENT_CATALOG): void {
  const issues = validateAgentCatalog(catalog)
  if (issues.length > 0) {
    throw new Error(`Invalid Agent Catalog:\n${issues.map(issue => `- [${issue.code}] ${issue.message}`).join('\n')}`)
  }
}

export function getCatalogVariant(catalogId: CatalogId): AgentHostVariant {
  const variant = AGENT_CATALOG.variants.find(candidate => candidate.catalogId === catalogId)
  if (!variant) throw new Error(`Unknown Agent Catalog ID: ${catalogId}`)
  return variant
}

export function getCatalogProduct(productFamilyId: ProductFamilyId): AgentProduct {
  const product = AGENT_CATALOG.products.find(candidate => candidate.id === productFamilyId)
  if (!product) throw new Error(`Unknown Agent Product Family: ${productFamilyId}`)
  return product
}
